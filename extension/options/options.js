/**
 * The Board. the bridge's full options surface.
 *
 * Talks to the service worker only, over chrome.runtime.sendMessage. It never
 * touches the pipe, the broker or a tab: this page is a renderer for the Board
 * shape defined in shared/protocol.mjs plus five control messages.
 *
 * Two rendering rules that the rest of this file depends on:
 *
 *   1. Cards are KEYED and patched in place, never re-innerHTML'd. The surface
 *      repaints every two seconds; blowing away the DOM on each pass would
 *      destroy focus, cancel an in-progress rename and make the audit tail
 *      unscrollable.
 *   2. Text is written only when it actually changed. Assigning textContent
 *      unconditionally inside an aria-live region makes a screen reader
 *      re-announce an unchanged value twice a second.
 */

import { icon, setIcon, hydrateIcons, vendorIconName } from '../ui/icons.js'

/* -------------------------------------------------------------------------- */
/* Protocol module                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Protocol constants live in shared/protocol.mjs, outside the extension root,
 * so Chromium cannot load them from here. The extension vendors them at
 * extension/lib/protocol.js (the same module the service worker imports), and
 * this page imports THAT rather than restating any literal.
 *
 * The import is dynamic so a missing or broken vendored module produces a
 * readable fatal state naming the exact file, instead of a blank white page
 * with one line in a console nobody has open.
 */
let P = null

const PROTOCOL_MODULE = '../lib/protocol.js'

/**
 * Error codes, bound from the protocol module at boot.
 *
 * Bound to its own name rather than read through P at every call site because
 * `send` is the busiest function on the page and `P.ERR.NO_WORKER` in a catch
 * block reads as protocol plumbing rather than as an error code. The binding is
 * safe because boot() assigns it before the first send: the two paths that can
 * skip the assignment (not running inside the extension, and the module failing
 * to load) both return from boot without rendering anything that can send.
 */
let ERR = null

/** How long a line stays lit after the bridge last observed work on it. */
const ACTIVITY_LIT_MS = 20_000

/** Board poll cadence while the surface is visible. */
const POLL_MS = 2_000

/** Clock tick for countdowns and relative times. */
const TICK_MS = 1_000

/** Press duration for the panic control. Deliberately awkward. */
const PANIC_HOLD_MS = 1_500

/**
 * Offered arm windows. Filtered against MAX_ARM_MINUTES at render time rather
 * than trimmed here, so raising or lowering the contract's ceiling changes what
 * the control offers without anyone remembering to edit this list. A choice the
 * broker would clamp is a choice the UI must never present.
 */
const ARM_CHOICES = [5, 15, 30, 60]

/* -------------------------------------------------------------------------- */
/* DOM handles                                                                 */
/* -------------------------------------------------------------------------- */

const $ = (id) => document.getElementById(id)

const el = {
  body: document.body,
  brandName: $('brand-name'),
  brandTagline: $('brand-tagline'),
  themeToggle: $('theme-toggle'),
  themeLabel: $('theme-label'),
  statusPill: $('status-pill'),
  statusText: $('status-text'),
  panicBanner: $('panic-banner'),
  panicClearTop: $('panic-clear-top'),
  fatal: $('fatal'),
  fatalTitle: $('fatal-title'),
  fatalBody: $('fatal-body'),
  selfSlot: $('self-slot'),
  boardSection: $('board'),
  boardGrid: $('board-grid'),
  boardEmpty: $('board-empty'),
  boardCount: $('board-count'),
  armDuration: $('arm-duration'),
  armList: $('arm-list'),
  armEmpty: $('arm-empty'),
  auditList: $('audit-list'),
  auditEmpty: $('audit-empty'),
  activityCount: $('activity-count'),
  panicHold: $('panic-hold'),
  panicHoldLabel: $('panic-hold-label'),
  panicClear: $('panic-clear'),
  footerVersion: $('footer-version'),
  footerUptime: $('footer-uptime'),
  footerRefresh: $('footer-refresh'),
  toast: $('toast'),
}

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

const state = {
  board: null,
  self: null,
  /** Broker clock minus ours, so no countdown ever trusts the local clock. */
  skewMs: 0,
  /** Last successful fetch, local epoch ms. */
  fetchedAt: null,
  /** Populated when the last board poll failed. */
  error: null,
  /** Last getSelf failure code, so a persistent fault is reported once. */
  selfErrorCode: null,
  armMinutes: 15,
  /** installId -> { opCount, litUntil } so the lamp can mean "in use". */
  activity: new Map(),
  /** label -> the largest remaining window seen, so the bar has a denominator. */
  armSpan: new Map(),
  /** Set while the operator is renaming, to suppress patching that field. */
  editingLabel: false,
  /** Set when the operator asked to re-pick which profile this line is. */
  reclaiming: false,
  claimBusy: null,
  pollTimer: null,
  tickTimer: null,
}

const cards = new Map() // installId -> LineCard
const armRows = new Map() // installId -> ArmRow

/* -------------------------------------------------------------------------- */
/* Messaging                                                                   */
/* -------------------------------------------------------------------------- */

class BridgeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

function inExtension() {
  return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id
}

/**
 * One request to the service worker.
 *
 * Failure arrives three different ways and all three have to become the same
 * typed error: the runtime rejects (worker gone), the worker answers nothing,
 * or the worker answers { ok: false }.
 */
async function send(message) {
  if (!inExtension()) {
    throw new BridgeError(ERR.NO_EXTENSION, 'This page is not running inside the extension.')
  }

  let res
  try {
    res = await chrome.runtime.sendMessage(message)
  } catch (err) {
    throw new BridgeError(ERR.NO_WORKER, err && err.message ? err.message : String(err))
  }

  if (!res) {
    throw new BridgeError(ERR.NO_WORKER, 'The extension service worker did not answer.')
  }
  // Every reply in the UI contract carries an explicit ok. A reply with ok
  // missing is a malformed handler, not a success, so it must not be read as
  // one: treating absent-as-true is how a half-written handler ships looking
  // like it works.
  if (res.ok !== true) {
    const code = (res.error && res.error.code) || res.code || ERR.UNKNOWN
    const msg =
      (res.error && res.error.message) ||
      (typeof res.error === 'string' ? res.error : null) ||
      res.message ||
      'The request failed.'
    throw new BridgeError(code, msg)
  }
  return res
}

/** True when the failure means "the broker is not there", not "you asked wrong". */
function isBrokerDown(err) {
  if (!(err instanceof BridgeError)) return false
  return err.code === ERR.NO_BROKER || err.code === ERR.NO_WORKER || err.code === ERR.TIMEOUT
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

function brokerNow() {
  return Date.now() + state.skewMs
}

function agoText(epochMs) {
  if (epochMs == null) return 'never'
  const s = Math.max(0, Math.round((brokerNow() - epochMs) / 1000))
  if (s < 2) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function secondsSince(epochMs) {
  if (epochMs == null) return null
  return Math.max(0, Math.round((brokerNow() - epochMs) / 1000))
}

function durationText(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

function countdownText(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function clockText(epochMs) {
  const d = new Date(epochMs)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Write only on change. Cheap, and it keeps aria-live regions quiet. */
function patchText(node, value) {
  if (!node) return
  const next = value == null ? '' : String(value)
  if (node.textContent !== next) node.textContent = next
}

function patchAttr(node, name, value) {
  if (!node) return
  if (value == null || value === false) {
    if (node.hasAttribute(name)) node.removeAttribute(name)
    return
  }
  const next = String(value)
  if (node.getAttribute(name) !== next) node.setAttribute(name, next)
}

function makeEl(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function dotSep() {
  const s = makeEl('span', 'sb-dot-sep')
  s.setAttribute('aria-hidden', 'true')
  return s
}

/* -------------------------------------------------------------------------- */
/* Line state derivation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The five board states, in strict precedence.
 *
 * LIVE and IDLE are both "connected and healthy". The split is the whole point
 * of the switchboard metaphor: a lamp lights when the line is actually carrying
 * a call. Activity is observed here rather than read off the board, because the
 * Board shape carries an operation COUNT but no timestamp for the last one, so
 * "recently used" can only be derived by watching that count move.
 */
function deriveState(line) {
  // Above everything, including absent. A line whose signed-in account stopped
  // matching the one it was claimed as is the only state on this board that can
  // end in an action taken as the wrong person, and rendering it as merely
  // "Unclaimed" is how it would go unnoticed.
  if (line.identityChanged) return 'identity'
  if (!line.present) return 'absent'
  if (!line.claimed) return 'unclaimed'
  if (line.link === P.LINK.STALE) return 'stale'
  if (line.link === P.LINK.DOWN) return 'absent'
  if (line.link === P.LINK.CONNECTING) return 'connecting'

  const seen = state.activity.get(line.installId)
  const armed = line.armedUntil != null && line.armedUntil > brokerNow()
  if (armed) return 'live'
  if (seen && seen.litUntil > Date.now()) return 'live'
  return 'idle'
}

const STATE_WORD = {
  live: 'Live',
  idle: 'Idle',
  connecting: 'Connecting',
  stale: 'Stale',
  absent: 'Absent',
  unclaimed: 'Unclaimed',
  identity: 'Identity changed',
}

/** The lamp only knows the four protocol link states plus the three UI ones. */
const STATE_LAMP = {
  live: 'ready',
  idle: 'idle',
  connecting: 'connecting',
  stale: 'stale',
  absent: 'down',
  unclaimed: 'unclaimed',
  identity: 'alarm',
}

function stateDetail(line, derived) {
  switch (derived) {
    case 'live':
      return 'Carrying traffic'
    case 'idle':
      return 'Connected and quiet'
    case 'connecting':
      return 'Handshaking with the broker'
    case 'stale': {
      const s = secondsSince(line.lastSeenAt)
      return s == null ? 'No heartbeat' : `No heartbeat for ${s}s`
    }
    case 'absent':
      return 'Configured but not connected. The extension was most likely disabled in that profile.'
    case 'unclaimed':
      return 'Needs claiming. Open the board from that profile and pick which one it is.'
    case 'identity':
      return 'A different account is signed into this profile than the one it was claimed as. The claim was dropped and the old name no longer addresses anything.'
    default:
      return ''
  }
}

/**
 * WHO this line is, in one short phrase.
 *
 * Every row shows it, because the board's collision warning tells the operator
 * that two lines share a name and then points at a page that could not say
 * which account either of them was. The signed-in address is the answer where
 * there is one; Brave carries no account in its profile metadata, so there the
 * profile name is the whole of what is knowable.
 */
function accountText(line) {
  if (line.email) return line.email
  if (line.profileName) return `named "${line.profileName}"`
  return 'no account on record'
}

/** Track the operation counter so the lamp can mean "in use right now". */
function noteActivity(lines) {
  for (const line of lines) {
    const prev = state.activity.get(line.installId)
    const count = Number(line.opCount) || 0
    if (!prev) {
      state.activity.set(line.installId, { opCount: count, litUntil: 0 })
      continue
    }
    if (count > prev.opCount) {
      state.activity.set(line.installId, { opCount: count, litUntil: Date.now() + ACTIVITY_LIT_MS })
    } else {
      prev.opCount = count
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Theme                                                                       */
/* -------------------------------------------------------------------------- */

const THEME_ORDER = ['system', 'light', 'dark']
const THEME_META = {
  system: { icon: 'monitor', label: 'System' },
  light: { icon: 'sun', label: 'Light' },
  dark: { icon: 'moon', label: 'Dark' },
}
const THEME_KEY = 'bridge.theme'

function readTheme() {
  // localStorage rather than chrome.storage on purpose: this is a per-viewer
  // presentation preference with no business in the extension's state schema,
  // and it must survive a storage read throwing in a restricted context.
  try {
    const v = localStorage.getItem(THEME_KEY)
    return THEME_ORDER.includes(v) ? v : 'system'
  } catch {
    return 'system'
  }
}

function applyTheme(mode) {
  if (mode === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', mode)

  const meta = THEME_META[mode] || THEME_META.system
  setIcon(el.themeToggle.querySelector('.theme-toggle__glyph'), meta.icon, { size: 16 })
  patchText(el.themeLabel, meta.label)
  patchAttr(el.themeToggle, 'aria-label', `Color theme: ${meta.label}. Activate to change.`)
}

function initTheme() {
  let mode = readTheme()
  applyTheme(mode)
  el.themeToggle.addEventListener('click', () => {
    mode = THEME_ORDER[(THEME_ORDER.indexOf(mode) + 1) % THEME_ORDER.length]
    try {
      localStorage.setItem(THEME_KEY, mode)
    } catch {
      /* A blocked storage write must never stop the theme from applying. */
    }
    applyTheme(mode)
  })
}

/* -------------------------------------------------------------------------- */
/* Toast                                                                       */
/* -------------------------------------------------------------------------- */

let toastTimer = null

/**
 * The toast is an aria-live region, so it is never removed from the document.
 *
 * `hidden` sets display:none, which takes the node out of the accessibility
 * tree entirely; a live region that is inserted and removed around each message
 * is unreliably announced, because the assistive technology has nothing to
 * observe a change ON. It stays mounted and empty, and only its presentation is
 * toggled with data-open.
 */
function toast(message, tone = 'ok') {
  el.toast.textContent = message
  el.toast.setAttribute('data-tone', tone)
  el.toast.setAttribute('data-open', 'true')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    el.toast.setAttribute('data-open', 'false')
    el.toast.textContent = ''
  }, 3200)
}

/* -------------------------------------------------------------------------- */
/* THIS LINE                                                                   */
/* -------------------------------------------------------------------------- */

let selfMode = null // 'claim' | 'identity' | 'unknown'
let selfRefs = null

function renderSelf() {
  const self = state.self
  // state.reclaiming is the escape hatch for a claim that was simply WRONG.
  // The broker has always accepted a re-claim - claimProfile has no guard and
  // CLAIM_PROFILE is a META operation - but there was no way to ask for one
  // short of hand-editing state.json, so a misclick was permanent.
  const mode = !self ? 'unknown' : self.claimed && !state.reclaiming ? 'identity' : 'claim'

  if (mode !== selfMode) {
    selfMode = mode
    selfRefs = null
    el.selfSlot.replaceChildren(
      mode === 'claim' ? buildClaimCard() : mode === 'identity' ? buildIdentityCard() : buildUnknownCard()
    )
  }

  if (mode === 'claim') updateClaimCard()
  else if (mode === 'identity') updateIdentityCard()
}

function buildUnknownCard() {
  const card = makeEl('div', 'self-card')
  const head = makeEl('div', 'self-head')
  const lamp = makeEl('span', 'sb-lamp self-head__lamp')
  lamp.setAttribute('data-state', 'down')
  lamp.setAttribute('aria-hidden', 'true')
  const main = makeEl('div', 'self-head__main')
  main.append(
    makeEl('p', 'claim__title', 'This line has not identified itself'),
    makeEl(
      'p',
      'claim__body',
      'The service worker has not reported an install id yet. If this does not resolve in a few seconds, reload the extension in this profile.'
    )
  )
  head.append(lamp, main)
  card.append(head)
  return card
}

/* ---- The claim prompt ------------------------------------------------------ */

function buildClaimCard() {
  const card = makeEl('div', 'self-card self-card--claim')
  const wrap = makeEl('div', 'claim')

  const head = makeEl('div', 'claim__head')
  const mark = makeEl('span', 'claim__mark')
  mark.append(icon('cord', { size: 18 }))
  const headText = makeEl('div')
  const eyebrow = makeEl('p', 'sb-eyebrow claim__eyebrow')
  const title = makeEl('h3', 'claim__title')
  const body = makeEl('p', 'claim__body')
  headText.append(eyebrow, title, body)
  head.append(mark, headText)

  const options = makeEl('div', 'claim__options')
  options.setAttribute('role', 'group')
  options.setAttribute('aria-label', 'Candidate profiles')

  const foot = makeEl('p', 'claim__footnote')

  // Only offered on a deliberate re-claim, so a line that genuinely has never
  // been claimed cannot be dismissed into a state with no way forward.
  const cancel = makeEl('button', 'reclaim__no claim__cancel')
  cancel.type = 'button'
  cancel.textContent = 'Keep the current profile'
  cancel.hidden = true
  cancel.addEventListener('click', () => {
    state.reclaiming = false
    renderSelf()
  })

  wrap.append(head, options, foot, cancel)
  card.append(wrap)

  selfRefs = { options, foot, eyebrow, title, body, cancel }
  return card
}

/**
 * The three reasons this card is on screen, and they need different words.
 *
 * A first claim is a setup step. A re-claim is a correction. An identity change
 * is a safety event that already dropped a claim, and saying "one time setup"
 * over it would be the single most misleading sentence on the page.
 */
function claimCopy() {
  const line = selfLine()
  if (line && line.identityChanged) {
    return {
      eyebrow: 'Identity changed',
      title: 'Who is this now?',
      body: 'A different account is signed into this profile than the one this line was claimed as, so the bridge dropped the claim rather than keep acting under the old name. Nothing can be routed here until you say which profile this is.',
      foot: 'The old name no longer addresses anything, on purpose. A tool call that used it now fails and says so, instead of quietly driving the wrong logged-in browser.',
    }
  }
  if (state.reclaiming) {
    return {
      eyebrow: 'Re-claiming this line',
      title: 'Which line is this?',
      body: 'Pick the profile you are actually in. The previous choice is replaced, the line is renamed to match, and every tab handle from before stops working.',
      foot: 'Nothing else changes. Arming, the panic switch and the audit log are untouched.',
    }
  }
  return {
    eyebrow: 'One time setup',
    title: 'Which line is this?',
    body: 'This browser cannot tell an extension which profile it is running in, so the bridge needs one click. Pick the profile you are in right now and this line is patched in permanently.',
    foot: 'You only do this once per profile, ever. The choice is saved by the broker and survives browser restarts. You can rename the line afterwards.',
  }
}

/**
 * The candidate list to offer, preferring the live board over the copy stored
 * at registration.
 *
 * getSelf is answered from local storage on purpose, so the UI still says
 * something useful while the broker is down. But that copy is captured the
 * moment the extension registers, and a browser writes a stub `Local State`
 * immediately while only flushing its real profile cache seconds later. On a
 * cold start the stored copy is therefore empty precisely when someone is
 * trying to claim, so prefer the board's line for this install id, which the
 * broker re-reads, and fall back to the stored copy when the board is not
 * available.
 */
function claimCandidates() {
  const mine = (state.board?.lines || []).find((l) => l.installId === state.self?.installId)
  const live = Array.isArray(mine?.candidates) ? mine.candidates : []
  if (live.length > 0) return live
  return Array.isArray(state.self?.candidates) ? state.self.candidates : []
}

function updateClaimCard() {
  const candidates = claimCandidates()
  const { options } = selfRefs

  const copy = claimCopy()
  patchText(selfRefs.eyebrow, copy.eyebrow)
  patchText(selfRefs.title, copy.title)
  patchText(selfRefs.body, copy.body)
  patchText(selfRefs.foot, copy.foot)
  selfRefs.cancel.hidden = !(state.reclaiming && state.self && state.self.claimed)

  if (candidates.length === 0) {
    options.replaceChildren(
      makeEl(
        'p',
        'empty',
        'No candidate profiles yet. A browser can take a few seconds after starting to write its profile list, so this usually fills in on its own shortly. If it stays empty, check that the broker is running.'
      )
    )
    return
  }

  // Rebuilt wholesale: the candidate list is static for the life of the prompt
  // and disappears the moment a claim lands, so there is no focus to protect.
  const frag = document.createDocumentFragment()
  for (const c of candidates) {
    frag.append(buildClaimOption(c))
  }
  options.replaceChildren(frag)
}

function buildClaimOption(candidate) {
  const btn = makeEl('button', 'claim-option')
  btn.type = 'button'

  const port = makeEl('span', 'claim-option__port')
  port.append(icon('check', { size: 14, strokeWidth: 2.6 }))

  const text = makeEl('div', 'claim-option__text')
  text.append(makeEl('span', 'claim-option__dir', candidate.dir))
  const nameBits = [candidate.name, candidate.email].filter(Boolean)
  text.append(makeEl('span', 'claim-option__name', nameBits.join(' - ') || 'No profile name recorded'))

  const arrow = makeEl('span', 'claim-option__arrow')
  arrow.append(icon('chevronRight', { size: 16 }))

  btn.append(port, text, arrow)
  btn.setAttribute(
    'aria-label',
    `Claim this line as ${candidate.dir}${candidate.name ? `, ${candidate.name}` : ''}`
  )

  btn.addEventListener('click', async () => {
    if (state.claimBusy) return
    state.claimBusy = candidate.dir
    btn.disabled = true
    btn.setAttribute('data-busy', 'true')
    // The whole group is marked, not just the pressed row: the other options
    // recede so the one being plugged in is the only thing on the card with
    // full contrast. This is the single manual step in the install and it
    // should read like a connection being made.
    if (btn.parentElement) btn.parentElement.setAttribute('data-claiming', 'true')
    try {
      // The claim carries `dir` and nothing else. The broker resolves WHICH
      // line is claiming from the connection itself, which is what stops one
      // profile's extension from claiming another profile's identity.
      await send({ kind: 'claim', dir: candidate.dir })
      state.reclaiming = false
      toast(`Line claimed as ${candidate.dir}`)
      await refresh({ immediate: true })
    } catch (err) {
      btn.disabled = false
      btn.removeAttribute('data-busy')
      if (btn.parentElement) btn.parentElement.removeAttribute('data-claiming')
      toast(`Could not claim: ${err.message}`, 'error')
    } finally {
      state.claimBusy = null
    }
  })

  return btn
}

/* ---- The identity card ----------------------------------------------------- */

function buildIdentityCard() {
  const card = makeEl('div', 'self-card')

  const head = makeEl('div', 'self-head')
  const lamp = makeEl('span', 'sb-lamp self-head__lamp')
  lamp.setAttribute('aria-hidden', 'true')

  const main = makeEl('div', 'self-head__main')

  const titleRow = makeEl('div', 'self-title-row')
  const labelBtn = makeEl('button', 'label-edit')
  labelBtn.type = 'button'
  const labelText = makeEl('span', 'label-edit__text')
  const pencil = makeEl('span', 'label-edit__pencil')
  pencil.append(icon('pencil', { size: 14 }))
  labelBtn.append(labelText, pencil)

  const customChip = makeEl('span', 'sb-chip', 'Renamed')
  customChip.hidden = true

  const stateChip = makeEl('span', 'sb-chip sb-chip--accent')

  titleRow.append(labelBtn, customChip, stateChip)

  const meta = makeEl('p', 'meta-row')
  const vendorSpan = makeEl('span', 'meta-row__vendor')
  const dirSpan = makeEl('span')
  const nameSpan = makeEl('span')
  meta.append(vendorSpan, dotSep(), dirSpan, dotSep(), nameSpan)

  const detail = makeEl('p', 'line__state-detail')

  const idLine = makeEl('p', 'install-id')
  const idLabel = makeEl('span', null, 'install id')
  const idValue = makeEl('span')
  idLine.append(idLabel, idValue)

  // Two clicks, never one. A stray click here would drop a working claim and
  // relabel the line, so asking costs a second and saves an accident.
  const reclaimRow = makeEl('p', 'reclaim')
  const reclaimBtn = makeEl('button', 'reclaim__ask')
  reclaimBtn.type = 'button'
  reclaimBtn.textContent = 'This is not the right profile'
  const reclaimConfirm = makeEl('span', 'reclaim__confirm')
  reclaimConfirm.hidden = true
  const reclaimYes = makeEl('button', 'reclaim__yes')
  reclaimYes.type = 'button'
  reclaimYes.textContent = 'Pick a different profile'
  const reclaimNo = makeEl('button', 'reclaim__no')
  reclaimNo.type = 'button'
  reclaimNo.textContent = 'Cancel'
  reclaimConfirm.append(reclaimYes, reclaimNo)
  reclaimRow.append(reclaimBtn, reclaimConfirm)

  reclaimBtn.addEventListener('click', () => {
    reclaimBtn.hidden = true
    reclaimConfirm.hidden = false
    reclaimYes.focus()
  })
  reclaimNo.addEventListener('click', () => {
    reclaimConfirm.hidden = true
    reclaimBtn.hidden = false
    reclaimBtn.focus()
  })
  reclaimYes.addEventListener('click', () => {
    state.reclaiming = true
    renderSelf()
  })

  main.append(titleRow, meta, detail, idLine, reclaimRow)
  head.append(lamp, main)
  card.append(head)

  wireRename(labelBtn, labelText, titleRow)

  selfRefs = {
    lamp,
    labelBtn,
    labelText,
    customChip,
    stateChip,
    vendorSpan,
    dirSpan,
    nameSpan,
    detail,
    idValue,
  }
  return card
}

function updateIdentityCard() {
  const r = selfRefs
  if (!r) return
  const self = state.self
  const line = selfLine()

  const derived = line ? deriveState(line) : 'connecting'
  patchAttr(r.lamp, 'data-state', STATE_LAMP[derived])

  if (!state.editingLabel) {
    patchText(r.labelText, (line && line.label) || self.label || 'unnamed line')
  }
  patchAttr(r.labelBtn, 'aria-label', `Rename this line. Current name: ${r.labelText.textContent}`)

  r.customChip.hidden = !(line && line.labelIsCustom)

  patchText(r.stateChip, STATE_WORD[derived] || '')
  r.stateChip.className =
    derived === 'stale'
      ? 'sb-chip sb-chip--warn'
      : derived === 'absent'
        ? 'sb-chip'
        : 'sb-chip sb-chip--accent'

  const vendor = (line && line.vendor) || self.vendor || null
  const vendorLabel = (line && line.vendorLabel) || titleCase(vendor) || 'Unknown browser'
  r.vendorSpan.replaceChildren(icon(vendorIconName(vendor), { size: 14 }), document.createTextNode(vendorLabel))

  // The board is the better source, but it is the one that disappears when the
  // broker goes down. getSelf is answered by the service worker out of its own
  // memory, so falling back to it keeps this card answering "which line am I"
  // during exactly the outage where the operator most wants to know.
  patchText(r.dirSpan, (line && line.profileDir) || self.profileDir || 'profile directory unknown')
  // The signed-in ACCOUNT leads, not the profile name. "Which person is this
  // line" is the question the whole claim mechanism exists to answer, and a
  // display name that the operator typed themselves is the weakest possible answer to it.
  patchText(r.nameSpan, line ? accountText(line) : accountText(self))
  patchText(r.detail, line ? stateDetail(line, derived) : 'Waiting for the broker to report this line.')
  patchText(r.idValue, self.installId || 'unknown')
}

function selfLine() {
  if (!state.board || !state.self) return null
  return state.board.lines.find((l) => l.installId === state.self.installId) || null
}

function titleCase(s) {
  if (!s) return null
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Inline rename. The label itself is the affordance: click it, it becomes an
 * input seeded with the current value, Enter commits, Escape reverts, blur
 * commits. Board patching is suppressed for the whole interaction so a poll
 * landing mid-edit cannot overwrite what is being typed.
 */
function wireRename(labelBtn, labelText, container) {
  labelBtn.addEventListener('click', () => {
    if (state.editingLabel) return
    state.editingLabel = true

    const current = labelText.textContent || ''
    const input = makeEl('input', 'label-input')
    input.type = 'text'
    input.value = current
    input.maxLength = 40
    input.setAttribute('aria-label', 'Line name')
    input.spellcheck = false
    input.autocomplete = 'off'

    let settled = false

    const finish = async (commit) => {
      if (settled) return
      settled = true
      const next = input.value.trim()
      input.replaceWith(labelBtn)
      state.editingLabel = false
      labelBtn.focus()

      if (!commit || next === '' || next === current) {
        if (commit && next === '') toast('A line name cannot be empty.', 'error')
        return
      }

      patchText(labelText, next)
      try {
        // setLabel echoes back the label it actually stored. The broker owns
        // uniqueness and slugging, so what it returns can differ from what was
        // typed; showing the typed value would be a lie the next poll corrects.
        const res = await send({ kind: 'setLabel', label: next })
        const stored = typeof res.label === 'string' && res.label ? res.label : next
        patchText(labelText, stored)
        toast(`Renamed to ${stored}`)
        await refresh({ immediate: true })
      } catch (err) {
        patchText(labelText, current)
        toast(`Could not rename: ${err.message}`, 'error')
      }
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        finish(true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        finish(false)
      }
    })
    input.addEventListener('blur', () => finish(true))

    container.replaceChild(input, labelBtn)
    input.focus()
    input.select()
  })
}

/* -------------------------------------------------------------------------- */
/* THE BOARD                                                                   */
/* -------------------------------------------------------------------------- */

function LineCard(line) {
  const root = makeEl('article', 'line')
  root.setAttribute('role', 'listitem')

  const head = makeEl('div', 'line__head')
  const lamp = makeEl('span', 'sb-lamp line__lamp')
  lamp.setAttribute('aria-hidden', 'true')

  const id = makeEl('div', 'line__id')
  const label = makeEl('h3', 'line__label')
  const sub = makeEl('p', 'line__sub')
  const vendorSpan = makeEl('span', 'meta-row__vendor')
  const dirSpan = makeEl('span')
  const accountSpan = makeEl('span', 'line__account')
  sub.append(vendorSpan, dotSep(), dirSpan, dotSep(), accountSpan)
  id.append(label, sub)

  const selfChip = makeEl('span', 'sb-chip sb-chip--accent', 'This line')
  selfChip.hidden = true

  head.append(lamp, id, selfChip)

  const stateRow = makeEl('div', 'line__state')
  const stateWord = makeEl('span', 'line__state-word')
  const stateDetailEl = makeEl('span', 'line__state-detail')
  stateRow.append(stateWord, stateDetailEl)

  const stats = makeEl('dl', 'line__stats')
  const mkStat = (term) => {
    const wrap = makeEl('div', 'line__stat')
    const dt = makeEl('dt', null, term)
    const dd = makeEl('dd')
    wrap.append(dt, dd)
    stats.append(wrap)
    return dd
  }
  const tabsDd = mkStat('Tabs')
  const extDd = mkStat('Extension')
  const latencyDd = mkStat('Latency')
  const seenDd = mkStat('Last seen')

  // A notice of its own rather than a second sentence inside `notice`. The two
  // are different in kind: `notice` carries something wrong with the line that
  // the operator may not be able to fix, and this one carries a single action
  // that always works. Folding them together buried the action.
  const reloadNotice = makeEl('p', 'line__notice line__notice--muted')
  reloadNotice.hidden = true

  const notice = makeEl('p', 'line__notice')
  notice.hidden = true

  const foot = makeEl('div', 'line__foot')
  const armedChip = makeEl('a', 'sb-chip chip-link')
  armedChip.hidden = true
  const opsSpan = makeEl('span', 'line__ops')
  foot.append(armedChip, opsSpan)

  root.append(head, stateRow, stats, reloadNotice, notice, foot)

  function update(next, ctx) {
    const derived = deriveState(next)

    patchAttr(root, 'data-link', next.link)
    patchAttr(root, 'data-present', String(!!next.present))
    patchAttr(root, 'data-claimed', String(!!next.claimed))
    patchAttr(root, 'data-state', derived)
    patchAttr(root, 'data-self', String(ctx.isSelf))
    patchAttr(lamp, 'data-state', STATE_LAMP[derived])

    patchText(label, next.label || next.installId)
    patchAttr(root, 'aria-label', `${next.label || 'line'}, ${STATE_WORD[derived]}`)

    const vendorLabel = next.vendorLabel || titleCase(next.vendor) || 'Browser'
    if (vendorSpan.getAttribute('data-vendor') !== String(next.vendor)) {
      vendorSpan.setAttribute('data-vendor', String(next.vendor))
      vendorSpan.replaceChildren(
        icon(vendorIconName(next.vendor), { size: 13 }),
        document.createTextNode(vendorLabel)
      )
    }
    patchText(dirSpan, next.profileDir || 'unclaimed')
    patchText(accountSpan, accountText(next))

    selfChip.hidden = !ctx.isSelf

    patchText(stateWord, STATE_WORD[derived] || '')
    patchText(stateDetailEl, stateDetail(next, derived))

    patchText(tabsDd, next.present ? formatCount(next.tabCount) : 'n/a')
    patchText(extDd, next.extVersion || 'unreported')
    // Chromium reads an unpacked extension's code once, when it loads it, so a
    // profile keeps running the old version until it is reloaded. This is the
    // only place the operator can see which of their profiles that applies to.
    reloadNotice.hidden = !next.needsReload
    if (next.needsReload) {
      const text =
        `Running ${next.extVersion}, and ${ctx.installedVersion || 'a different version'} is installed. ` +
        'Reload this extension to pick it up: a browser only reads an unpacked extension once, when it loads it.'
      if (reloadNotice.getAttribute('data-reload') !== text) {
        reloadNotice.setAttribute('data-reload', text)
        reloadNotice.replaceChildren(icon('alert', { size: 13 }), document.createTextNode(text))
      }
    } else {
      reloadNotice.removeAttribute('data-reload')
    }
    setLatency(latencyDd, next)
    patchText(seenDd, next.present ? agoText(next.lastSeenAt) : 'not connected')

    if (next.warning) {
      notice.hidden = false
      // An identity change is not a warning among warnings. It gets the alarm
      // treatment so it cannot be read past on a board of many lines.
      notice.className = derived === 'identity' ? 'line__notice line__notice--alarm' : 'line__notice'
      if (notice.getAttribute('data-warn') !== next.warning) {
        notice.setAttribute('data-warn', next.warning)
        notice.replaceChildren(icon('alert', { size: 13 }), document.createTextNode(next.warning))
      }
    } else {
      notice.hidden = true
      notice.removeAttribute('data-warn')
    }

    const armed = next.armedUntil != null && next.armedUntil > brokerNow()
    armedChip.hidden = !armed
    if (armed) {
      armedChip.href = `#arm-${cssId(next.installId)}`
      patchText(armedChip, `Armed ${countdownText(next.armedUntil - brokerNow())}`)
      patchAttr(armedChip, 'title', 'Jump to the arming control for this line')
    }

    patchText(opsSpan, `${formatCount(next.opCount)} ops`)
  }

  update(line, { isSelf: false, installedVersion: null })
  return { root, update, refs: { seenDd, armedChip, stateDetailEl } }
}

function setLatency(dd, line) {
  if (!line.present || line.latencyMs == null) {
    patchText(dd, 'n/a')
    return
  }
  if (dd.getAttribute('data-ms') === String(line.latencyMs)) return
  dd.setAttribute('data-ms', String(line.latencyMs))
  dd.replaceChildren(document.createTextNode(String(line.latencyMs)), makeEl('span', 'unit', 'ms'))
}

function formatCount(n) {
  const v = Number(n)
  return Number.isFinite(v) ? v.toLocaleString('en-US') : '0'
}

/** installId is a UUID, so it is already fragment-safe, but never assume it. */
function cssId(installId) {
  return String(installId).replace(/[^A-Za-z0-9_-]/g, '')
}

function renderBoard() {
  const lines = state.board ? state.board.lines : []
  const selfId = state.self ? state.self.installId : null

  const seen = new Set()
  let position = 0

  for (const line of lines) {
    seen.add(line.installId)
    let card = cards.get(line.installId)
    if (!card) {
      card = LineCard(line)
      cards.set(line.installId, card)
    }
    card.update(line, {
      isSelf: line.installId === selfId,
      installedVersion: state.board ? state.board.installedVersion : null,
    })

    // Keep DOM order in step with board order without reinserting nodes that
    // are already where they belong; a needless insertBefore restarts CSS
    // transitions and can drop a focused element out from under the operator.
    const atPosition = el.boardGrid.children[position]
    if (atPosition !== card.root) el.boardGrid.insertBefore(card.root, atPosition || null)
    position += 1
  }

  for (const [id, card] of cards) {
    if (!seen.has(id)) {
      card.root.remove()
      cards.delete(id)
    }
  }

  // "No lines are connected yet" is a CONCLUSION, and it can only be drawn once
  // a board has actually come back. Showing it while the first fetch is still
  // in flight tells the operator their install failed a beat before it renders
  // fine, which is the single most alarming thing this page could get wrong.
  const answered = state.board !== null
  el.boardEmpty.hidden = !answered || lines.length > 0 || !!state.error
  el.boardGrid.hidden = lines.length === 0

  const connected = lines.filter((l) => l.present).length
  patchText(
    el.boardCount,
    lines.length === 0 ? '' : `${connected} of ${lines.length} ${lines.length === 1 ? 'line' : 'lines'} connected`
  )
}

/* -------------------------------------------------------------------------- */
/* ARMING                                                                      */
/* -------------------------------------------------------------------------- */

function renderArmDuration() {
  if (el.armDuration.childElementCount > 0) return

  // Never offer a window the broker would clamp: MAX_ARM_MINUTES is the hard
  // ceiling and a control that offers 90 and delivers 60 is a control that
  // lies. The default comes from the protocol timing table, so if that ever
  // moves off one of the offered choices the control still shows the value in
  // force rather than silently rendering with nothing selected.
  const offered = ARM_CHOICES.filter((m) => m <= P.MAX_ARM_MINUTES)
  const choices = offered.includes(state.armMinutes)
    ? offered
    : [...offered, state.armMinutes].sort((a, b) => a - b)

  const frag = document.createDocumentFragment()
  for (const minutes of choices) {
    const label = makeEl('label', 'arm-duration__option')
    const input = document.createElement('input')
    input.type = 'radio'
    input.name = 'arm-minutes'
    input.value = String(minutes)
    input.checked = minutes === state.armMinutes
    input.addEventListener('change', () => {
      state.armMinutes = minutes
    })
    label.append(input, makeEl('span', null, `${minutes} min`))
    frag.append(label)
  }
  el.armDuration.replaceChildren(frag)
}

function ArmRow(line) {
  const root = makeEl('li', 'arm-row')
  root.id = `arm-${cssId(line.installId)}`

  const idWrap = makeEl('div', 'arm-row__id')
  const lamp = makeEl('span', 'sb-lamp')
  lamp.setAttribute('aria-hidden', 'true')
  const label = makeEl('span', 'arm-row__label')
  idWrap.append(lamp, label)

  const status = makeEl('div', 'arm-row__status')
  const statusText = makeEl('span', 'arm-row__status-text')
  const bar = makeEl('div', 'sb-bar arm-row__bar')
  bar.setAttribute('role', 'progressbar')
  bar.setAttribute('aria-valuemin', '0')
  bar.setAttribute('aria-valuemax', '100')
  status.append(statusText, bar)

  const actions = makeEl('div', 'arm-row__actions')
  const armBtn = makeEl('button', 'sb-btn sb-btn--sm')
  armBtn.type = 'button'
  armBtn.append(icon('zap', { size: 13 }), document.createTextNode('Arm'))
  const disarmBtn = makeEl('button', 'sb-btn sb-btn--sm')
  disarmBtn.type = 'button'
  disarmBtn.append(icon('slash', { size: 13 }), document.createTextNode('Disarm'))
  disarmBtn.hidden = true
  actions.append(armBtn, disarmBtn)

  root.append(idWrap, status, actions)

  let current = line

  armBtn.addEventListener('click', async () => {
    armBtn.disabled = true
    try {
      const res = await send({ kind: 'arm', label: current.label, minutes: state.armMinutes })
      // The broker clamps the window and echoes back what it actually granted.
      // Reporting the requested value instead would quietly overstate how long
      // arbitrary JavaScript is allowed to run, which is the one number on this
      // page that must never be optimistic.
      const granted = Number.isFinite(res.minutes) ? res.minutes : state.armMinutes
      toast(`${current.label} armed for ${granted} ${granted === 1 ? 'minute' : 'minutes'}`)
      await refresh({ immediate: true })
    } catch (err) {
      toast(`Could not arm: ${err.message}`, 'error')
    } finally {
      armBtn.disabled = false
    }
  })

  disarmBtn.addEventListener('click', async () => {
    disarmBtn.disabled = true
    try {
      await send({ kind: 'disarm', label: current.label })
      toast(`${current.label} disarmed`)
      await refresh({ immediate: true })
    } catch (err) {
      toast(`Could not disarm: ${err.message}`, 'error')
    } finally {
      disarmBtn.disabled = false
    }
  })

  function update(next) {
    current = next
    const derived = deriveState(next)
    patchAttr(lamp, 'data-state', STATE_LAMP[derived])
    patchText(label, next.label || next.installId)

    const armable = next.present && next.claimed
    armBtn.disabled = !armable
    // Every row's button reads "Arm", so without a per-row accessible name a
    // screen reader user tabbing the list hears the same word many times with
    // nothing to tell the lines apart. title alone does not fix that: it loses
    // to the button's own text when the accessible name is computed.
    const armName = armable
      ? `Arm ${next.label} for ${state.armMinutes} minutes`
      : `Cannot arm ${next.label}: this line is not connected`
    patchAttr(armBtn, 'aria-label', armName)
    patchAttr(armBtn, 'title', armName)
    patchAttr(disarmBtn, 'aria-label', `Disarm ${next.label}`)

    paintArm(next)
  }

  function paintArm(next) {
    const line = next || current
    const remaining = line.armedUntil == null ? 0 : line.armedUntil - brokerNow()
    const armed = remaining > 0

    patchAttr(root, 'data-armed', String(armed))
    disarmBtn.hidden = !armed
    armBtn.hidden = armed

    if (!armed) {
      state.armSpan.delete(line.label)
      patchText(statusText, 'Not armed')
      bar.style.setProperty('--sb-progress', '0')
      patchAttr(bar, 'aria-valuenow', '0')
      return
    }

    // The board reports an expiry but never a start, so the denominator is the
    // largest remaining window this page has seen for that line. It is exact
    // from the moment the page witnessed the arm, and self-corrects upward if
    // the page opened mid-window.
    const spanSeen = state.armSpan.get(line.label) || 0
    const span = Math.max(spanSeen, remaining)
    state.armSpan.set(line.label, span)

    const pct = span > 0 ? Math.max(0, Math.min(1, remaining / span)) : 0
    patchText(statusText, `Armed for arbitrary JavaScript, ${countdownText(remaining)} remaining`)
    bar.style.setProperty('--sb-progress', pct.toFixed(4))
    patchAttr(bar, 'aria-valuenow', String(Math.round(pct * 100)))
    patchAttr(bar, 'aria-label', `Arming window remaining for ${line.label}`)
  }

  update(line)
  return { root, update, paintArm, get line() { return current } }
}

function renderArming() {
  const lines = state.board ? state.board.lines : []
  const seen = new Set()
  let position = 0

  for (const line of lines) {
    seen.add(line.installId)
    let row = armRows.get(line.installId)
    if (!row) {
      row = ArmRow(line)
      armRows.set(line.installId, row)
    }
    row.update(line)
    const atPosition = el.armList.children[position]
    if (atPosition !== row.root) el.armList.insertBefore(row.root, atPosition || null)
    position += 1
  }

  for (const [id, row] of armRows) {
    if (!seen.has(id)) {
      row.root.remove()
      armRows.delete(id)
    }
  }

  el.armEmpty.hidden = lines.length > 0
  el.armList.hidden = lines.length === 0
}

/* -------------------------------------------------------------------------- */
/* ACTIVITY                                                                    */
/* -------------------------------------------------------------------------- */

let lastAuditSignature = ''

function renderAudit() {
  const audit = state.board && Array.isArray(state.board.audit) ? state.board.audit : []

  // Newest first. The broker's own ordering is not part of the Board contract,
  // so sort rather than assume, but only rebuild when the tail actually moved.
  const rows = audit.slice().sort((a, b) => (b.at || 0) - (a.at || 0))
  const signature = rows.map((r) => `${r.at}|${r.profile}|${r.op}|${r.origin}|${r.ok}`).join('\n')

  patchText(el.activityCount, rows.length === 0 ? '' : `${formatCount(rows.length)} recent`)

  if (signature === lastAuditSignature) return
  lastAuditSignature = signature

  el.auditEmpty.hidden = rows.length > 0
  if (rows.length === 0) {
    el.auditList.replaceChildren()
    return
  }

  const frag = document.createDocumentFragment()
  for (const entry of rows) {
    const li = makeEl('li', 'audit-row')
    li.setAttribute('data-ok', String(entry.ok !== false))
    li.append(
      makeEl('span', 'audit-row__time', entry.at ? clockText(entry.at) : ''),
      makeEl('span', 'audit-row__profile', entry.profile || ''),
      makeEl('span', 'audit-row__op', entry.op || ''),
      makeEl('span', 'audit-row__origin', entry.origin || '')
    )
    const mark = makeEl('span', 'audit-row__mark')
    mark.append(
      entry.ok === false
        ? icon('x', { size: 12, title: 'Failed', strokeWidth: 2.5 })
        : icon('check', { size: 12, title: 'Succeeded', strokeWidth: 2.5 })
    )
    li.append(mark)
    frag.append(li)
  }
  el.auditList.replaceChildren(frag)
}

/* -------------------------------------------------------------------------- */
/* Status pill, panic and the broker-down state                                */
/* -------------------------------------------------------------------------- */

function renderStatus() {
  const lamp = el.statusPill.querySelector('.sb-lamp')

  if (state.error) {
    patchAttr(el.statusPill, 'data-state', 'down')
    patchAttr(lamp, 'data-state', 'down')
    patchText(el.statusText, 'Broker down')
    return
  }
  if (!state.board) {
    patchAttr(el.statusPill, 'data-state', 'loading')
    patchAttr(lamp, 'data-state', 'connecting')
    patchText(el.statusText, 'Connecting to the broker')
    return
  }
  if (state.board.panic) {
    patchAttr(el.statusPill, 'data-state', 'panic')
    patchAttr(lamp, 'data-state', 'stale')
    patchText(el.statusText, 'PANIC')
    return
  }
  patchAttr(el.statusPill, 'data-state', 'connected')
  patchAttr(lamp, 'data-state', 'ready')
  patchText(el.statusText, 'Broker connected')
}

function renderPanic() {
  const on = !!(state.board && state.board.panic)
  patchAttr(el.body, 'data-panic', on ? 'on' : 'off')
  el.panicBanner.hidden = !on
  el.panicClear.hidden = !on
  el.panicHold.hidden = on
  patchText(el.panicHoldLabel, 'Hold to trip panic')
}

let brokerDownCard = null

function renderBrokerDown() {
  if (!state.error) {
    if (brokerDownCard) {
      brokerDownCard.remove()
      brokerDownCard = null
      el.boardGrid.hidden = false
    }
    return
  }

  el.boardGrid.hidden = true
  el.boardEmpty.hidden = true

  if (!brokerDownCard) {
    brokerDownCard = makeEl('div', 'broker-down')

    const head = makeEl('div', 'broker-down__head')
    head.append(icon('alert', { size: 18 }), document.createTextNode('The broker is not answering'))

    const body = makeEl('p', 'broker-down__body')
    // The task name comes from the contract rather than being typed here. Five
    // call sites had each typed their own copy of it and two of them already
    // disagreed with the docs, which turns a recovery instruction into a
    // command that silently does nothing.
    body.textContent = `The bridge keeps one always-on broker process that owns the route table. Nothing can be driven until it is back. It normally starts at login as the background service "${P.TASK_NAME}"; start it now with:`

    const cmd = makeEl('div', 'cmd')
    cmd.append(makeEl('code', 'cmd__text', P.START_BROKER_COMMAND))
    const copyBtn = makeEl('button', 'sb-btn sb-btn--sm')
    copyBtn.type = 'button'
    copyBtn.setAttribute('aria-label', 'Copy the broker start command')
    copyBtn.append(icon('copy', { size: 13 }), document.createTextNode('Copy'))
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(P.START_BROKER_COMMAND)
        toast('Command copied')
      } catch {
        toast('Could not copy. Select the command and copy it manually.', 'error')
      }
    })
    cmd.append(copyBtn)

    const detail = makeEl('p', 'broker-down__detail')
    detail.id = 'broker-down-detail'

    brokerDownCard.append(head, body, cmd, detail)
    el.boardSection.insertBefore(brokerDownCard, el.boardGrid)
  }

  const detail = brokerDownCard.querySelector('#broker-down-detail')
  patchText(detail, `${state.error.code}: ${state.error.message}`)
}

function renderFooter() {
  if (!state.board) {
    patchText(el.footerVersion, '')
    patchText(el.footerUptime, '')
    patchText(el.footerRefresh, '')
    return
  }
  const installed = state.board.installedVersion
  patchText(
    el.footerVersion,
    installed && installed !== state.board.version
      ? `${state.board.product} ${state.board.version}, ${installed} installed`
      : `${state.board.product} ${state.board.version}`
  )
  patchText(el.footerUptime, `Broker up ${durationText(brokerNow() - state.board.startedAt)}`)
  patchText(
    el.footerRefresh,
    state.fetchedAt ? `Refreshed ${agoText(state.fetchedAt + state.skewMs)}` : ''
  )
}

/* -------------------------------------------------------------------------- */
/* Press and hold                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Press-and-hold activation.
 *
 * The default click is suppressed so a stray tap can never fire the action,
 * and the keyboard path is a real hold too: Enter or Space must be held down
 * for the full duration, matching the pointer behavior exactly rather than
 * offering a one-key shortcut past the guard.
 */
function attachHold(button, durationMs, onComplete) {
  let raf = null
  let startedAt = 0
  let holding = false

  const paint = () => {
    const progress = Math.min(1, (performance.now() - startedAt) / durationMs)
    button.style.setProperty('--sb-hold', progress.toFixed(4))
    if (progress >= 1) {
      stop()
      onComplete()
      return
    }
    raf = requestAnimationFrame(paint)
  }

  const start = () => {
    if (holding || button.disabled) return
    holding = true
    button.setAttribute('data-holding', 'true')
    startedAt = performance.now()
    raf = requestAnimationFrame(paint)
  }

  const stop = () => {
    holding = false
    button.removeAttribute('data-holding')
    if (raf) cancelAnimationFrame(raf)
    raf = null
    button.style.setProperty('--sb-hold', '0')
  }

  button.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    try {
      button.setPointerCapture(e.pointerId)
    } catch {
      /* Capture is an optimization; the pointerup listener still fires. */
    }
    start()
  })
  button.addEventListener('pointerup', stop)
  button.addEventListener('pointercancel', stop)
  button.addEventListener('pointerleave', stop)
  button.addEventListener('blur', stop)
  button.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      e.preventDefault()
      start()
    }
  })
  button.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      stop()
    }
  })
  // A plain click must never activate: the hold is the only path in.
  button.addEventListener('click', (e) => e.preventDefault())
}

async function setPanic(on) {
  try {
    const res = await send({ kind: 'panic', on })
    // The broker reports the state it settled on. A PANIC file on disk can hold
    // panic engaged even after a clear, so echoing the request rather than the
    // result would tell the operator the switch is off while it is still on.
    const now = typeof res.panic === 'boolean' ? res.panic : on
    toast(now ? 'Panic tripped. Every line is dropped.' : 'Panic cleared.')
    await refresh({ immediate: true })
  } catch (err) {
    toast(`Panic request failed: ${err.message}`, 'error')
  }
}

/* -------------------------------------------------------------------------- */
/* Polling                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One poll.
 *
 * The two requests are settled independently rather than joined with
 * Promise.all, because they have different failure domains: getBoard has to
 * reach the broker, while getSelf is answered by the service worker out of its
 * own memory. Joining them meant a broker outage also erased the page's answer
 * to "which line am I", which is the question the operator asks first when
 * something is down.
 */
async function refresh({ immediate = false } = {}) {
  const [board, self] = await Promise.allSettled([
    send({ kind: 'getBoard' }),
    send({ kind: 'getSelf' }),
  ])

  if (self.status === 'fulfilled') {
    // getSelf answers under a `self` key. Reading installId off the reply
    // envelope instead of off that payload is what made this page render as an
    // unidentified line against a service worker that knew exactly who it was.
    const payload = self.value.self
    state.self = payload && payload.installId ? payload : null
    state.selfErrorCode = null
  } else {
    // Surfaced once per distinct code, not once per poll: a persistent fault
    // would otherwise raise a toast every two seconds forever.
    const code = (self.reason && self.reason.code) || ERR.UNKNOWN
    if (code !== state.selfErrorCode && !isBrokerDown(self.reason)) {
      state.selfErrorCode = code
      toast(`Could not read this line: ${code}`, 'error')
    }
  }

  if (board.status === 'fulfilled') {
    state.board = board.value.board || null
    state.error = null
    state.fetchedAt = Date.now()
    if (state.board && typeof state.board.now === 'number') {
      state.skewMs = state.board.now - state.fetchedAt
    }
    if (state.board) noteActivity(state.board.lines)
  } else {
    const err = board.reason
    if (err instanceof BridgeError && !isBrokerDown(err)) {
      // A typed non-broker failure is a bug in a request, not an outage. Say so
      // once rather than replacing the whole board with an outage panel.
      toast(`${err.code}: ${err.message}`, 'error')
    } else {
      state.error = { code: (err && err.code) || ERR.UNKNOWN, message: err ? err.message : '' }
      state.board = null
    }
  }

  // Boot is over either way: the surface has something true to show, even if
  // what it has to show is an outage.
  el.body.setAttribute('data-boot', 'ready')

  renderAll()
  if (!immediate) scheduleNextPoll()
}

function renderAll() {
  renderStatus()
  renderPanic()
  renderBrokerDown()
  renderSelf()
  renderBoard()
  renderArming()
  renderAudit()
  renderFooter()
}

/** Cheap per-second repaint of everything that is purely a function of time. */
function tick() {
  if (!state.board) {
    renderFooter()
    return
  }
  for (const [installId, card] of cards) {
    const line = state.board.lines.find((l) => l.installId === installId)
    if (!line) continue
    patchText(card.refs.seenDd, line.present ? agoText(line.lastSeenAt) : 'not connected')
    const armed = line.armedUntil != null && line.armedUntil > brokerNow()
    card.refs.armedChip.hidden = !armed
    if (armed) patchText(card.refs.armedChip, `Armed ${countdownText(line.armedUntil - brokerNow())}`)
    const derived = deriveState(line)
    patchText(card.refs.stateDetailEl, stateDetail(line, derived))
  }
  for (const [installId, row] of armRows) {
    const line = state.board.lines.find((l) => l.installId === installId)
    if (line) row.paintArm(line)
  }
  renderFooter()
}

function scheduleNextPoll() {
  clearTimeout(state.pollTimer)
  if (document.visibilityState !== 'visible') return
  state.pollTimer = setTimeout(() => refresh(), POLL_MS)
}

/**
 * Polling is bound to visibility. A board left open in a background tab that
 * keeps hammering the service worker every two seconds would hold the worker
 * alive forever and burn the operator's battery for a page nobody is reading.
 */
function bindVisibility() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      startClock()
      refresh()
    } else {
      clearTimeout(state.pollTimer)
      clearInterval(state.tickTimer)
      state.tickTimer = null
    }
  })
}

function startClock() {
  if (state.tickTimer) return
  // Same rule as the poll: a per-second repaint of a page nobody is looking at
  // is pure battery. visibilitychange starts it when the operator comes back.
  if (document.visibilityState !== 'visible') return
  state.tickTimer = setInterval(tick, TICK_MS)
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

function fatal(title, body) {
  el.body.setAttribute('data-boot', 'fatal')
  patchText(el.fatalTitle, title)
  patchText(el.fatalBody, body)
  el.fatal.hidden = false
  patchAttr(el.statusPill, 'data-state', 'down')
  patchText(el.statusText, 'Not running')
  const lamp = el.statusPill.querySelector('.sb-lamp')
  patchAttr(lamp, 'data-state', 'down')
}

async function boot() {
  hydrateIcons(document)
  initTheme()

  if (!inExtension()) {
    fatal(
      'The bridge could not start',
      'This page has to be opened from the bridge extension itself. Open it from the toolbar popup, or from the extensions page in this browser profile.'
    )
    return
  }

  try {
    P = await import(PROTOCOL_MODULE)
  } catch (err) {
    fatal(
      'The bridge could not load its protocol module',
      `The board reads every state name, error code and timing from extension/lib/protocol.js and that module failed to load (${err && err.message ? err.message : err}). Reload the extension in this profile; if it still fails, the extension folder is incomplete.`
    )
    return
  }

  // Bound before anything can send. See the note on the declaration.
  ERR = P.ERR

  patchText(el.brandName, P.PRODUCT_NAME)
  patchText(el.brandTagline, P.PRODUCT_TAGLINE)
  document.title = `${P.PRODUCT_NAME} - The Board`
  // The default window still has to survive a ceiling lower than it.
  state.armMinutes = Math.min(P.TIMING.DEFAULT_ARM_MINUTES, P.MAX_ARM_MINUTES)

  renderArmDuration()

  attachHold(el.panicHold, PANIC_HOLD_MS, () => setPanic(true))
  el.panicClear.addEventListener('click', () => setPanic(false))
  el.panicClearTop.addEventListener('click', () => setPanic(false))

  bindVisibility()
  startClock()
  await refresh()
}

boot()
