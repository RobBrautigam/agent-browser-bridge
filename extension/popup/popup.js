/**
 * The toolbar popup.
 *
 * Answers three questions in under a second: is the broker up, which line am I,
 * and is this line armed. Everything heavier lives on the board.
 *
 * It deliberately does NOT reimplement the claim flow. Picking a profile from a
 * list of many is a decision that deserves a full page, and a popup that closes
 * the instant focus moves is the wrong place to make a permanent choice.
 *
 * Shares an origin with the board, so the theme preference the board writes to
 * localStorage applies here automatically.
 */

import { icon, hydrateIcons, vendorIconName } from '../ui/icons.js'

/** Vendored protocol module, same one the service worker imports. */
const PROTOCOL_MODULE = '../lib/protocol.js'
let P = null

/**
 * Error codes, bound from the protocol module at boot.
 *
 * Bound to its own name rather than read through P at each call site: `send` is
 * the busiest function here and a catch block reads better with the code than
 * with the module path to it. Safe because boot() assigns this before anything
 * can send, and both paths that skip the assignment return without rendering
 * a control.
 */
let ERR = null

const POLL_MS = 2_000
const TICK_MS = 1_000
const PANIC_HOLD_MS = 1_500
const THEME_KEY = 'bridge.theme'

const $ = (id) => document.getElementById(id)

const el = {
  body: document.body,
  brandName: $('brand-name'),
  statusPill: $('status-pill'),
  statusText: $('status-text'),
  fatal: $('fatal'),
  fatalBody: $('fatal-body'),
  popBody: $('pop-body'),
  lineCard: $('line-card'),
  lineLamp: $('line-lamp'),
  lineLabel: $('line-label'),
  lineSub: $('line-sub'),
  lineStateChip: $('line-state-chip'),
  lineDetail: $('line-detail'),
  statTabs: $('stat-tabs'),
  statLatency: $('stat-latency'),
  statLines: $('stat-lines'),
  claimCallout: $('claim-callout'),
  claimTitle: $('claim-title'),
  claimBody: $('claim-body'),
  brokerDown: $('broker-down'),
  brokerCmd: $('broker-cmd'),
  copyCmd: $('copy-cmd'),
  armBlock: $('arm-block'),
  armCount: $('arm-count'),
  armCopy: $('arm-copy'),
  armBar: $('arm-bar'),
  armBtn: $('arm-btn'),
  armBtnLabel: $('arm-btn-label'),
  disarmBtn: $('disarm-btn'),
  openBoard: $('open-board'),
  panicHold: $('panic-hold'),
  panicLabel: $('panic-label'),
  toast: $('toast'),
}

const state = {
  board: null,
  self: null,
  skewMs: 0,
  error: null,
  armMinutes: 15,
  armSpan: 0,
  pollTimer: null,
  tickTimer: null,
}

/* -------------------------------------------------------------------------- */
/* Plumbing                                                                    */
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

async function send(message) {
  if (!inExtension()) {
    throw new BridgeError(ERR.NO_EXTENSION, 'Not running inside the extension.')
  }
  let res
  try {
    res = await chrome.runtime.sendMessage(message)
  } catch (err) {
    throw new BridgeError(ERR.NO_WORKER, err && err.message ? err.message : String(err))
  }
  if (!res) throw new BridgeError(ERR.NO_WORKER, 'The service worker did not answer.')
  // ok is explicit in every reply of the UI contract. A reply missing it is a
  // malformed handler, not a success, and must not be read as one.
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

function isBrokerDown(err) {
  if (!(err instanceof BridgeError)) return false
  return err.code === ERR.NO_BROKER || err.code === ERR.NO_WORKER || err.code === ERR.TIMEOUT
}

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

function brokerNow() {
  return Date.now() + state.skewMs
}

function countdownText(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function secondsSince(epochMs) {
  if (epochMs == null) return null
  return Math.max(0, Math.round((brokerNow() - epochMs) / 1000))
}

function titleCase(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : null
}

let toastTimer = null

/**
 * Never uses the hidden attribute: display:none takes an aria-live region out
 * of the accessibility tree, and a region that is inserted and removed around
 * each message is unreliably announced. It stays mounted and empty.
 */
function toast(message, tone = 'ok') {
  el.toast.textContent = message
  el.toast.setAttribute('data-tone', tone)
  el.toast.setAttribute('data-open', 'true')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    el.toast.setAttribute('data-open', 'false')
    el.toast.textContent = ''
  }, 2600)
}

function applyStoredTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === 'light' || v === 'dark') document.documentElement.setAttribute('data-theme', v)
  } catch {
    /* System preference is a perfectly good fallback. */
  }
}

/* -------------------------------------------------------------------------- */
/* Line state, mirroring the board's derivation                                */
/* -------------------------------------------------------------------------- */

const STATE_WORD = {
  live: 'Live',
  idle: 'Idle',
  connecting: 'Connecting',
  stale: 'Stale',
  absent: 'Absent',
  unclaimed: 'Unclaimed',
  identity: 'Identity changed',
}

const STATE_LAMP = {
  live: 'ready',
  idle: 'idle',
  connecting: 'connecting',
  stale: 'stale',
  absent: 'down',
  unclaimed: 'unclaimed',
  identity: 'alarm',
}

function deriveState(line) {
  if (!line) return 'connecting'
  // Above every other state. This is the toolbar surface, so it is the one the operator
  // sees most often, and calling a dropped claim "not yet claimed" would hide
  // the only failure in this system that cannot be undone.
  if (line.identityChanged) return 'identity'
  if (!line.present) return 'absent'
  if (!line.claimed) return 'unclaimed'
  if (line.link === P.LINK.STALE) return 'stale'
  if (line.link === P.LINK.DOWN) return 'absent'
  if (line.link === P.LINK.CONNECTING) return 'connecting'
  const armed = line.armedUntil != null && line.armedUntil > brokerNow()
  return armed ? 'live' : 'idle'
}

function stateDetail(line, derived) {
  switch (derived) {
    case 'live':
      return 'Armed and answering.'
    case 'idle':
      return 'Connected and answering the heartbeat.'
    case 'connecting':
      return 'Handshaking with the broker.'
    case 'stale': {
      const s = secondsSince(line.lastSeenAt)
      return s == null ? 'No heartbeat.' : `No heartbeat for ${s}s.`
    }
    case 'absent':
      return 'Not connected. The extension may be disabled in this profile.'
    case 'unclaimed':
      return 'Not yet claimed to a browser profile.'
    case 'identity':
      return 'A different account is signed in than the one this line was claimed as. Open the board and claim it again.'
    default:
      return ''
  }
}

function selfLine() {
  if (!state.board || !state.self) return null
  return state.board.lines.find((l) => l.installId === state.self.installId) || null
}

/* -------------------------------------------------------------------------- */
/* Render                                                                      */
/* -------------------------------------------------------------------------- */

function renderStatus() {
  const lamp = el.statusPill.querySelector('.sb-lamp')
  if (state.error) {
    patchAttr(el.statusPill, 'data-state', 'down')
    patchAttr(lamp, 'data-state', 'down')
    patchText(el.statusText, 'Broker down')
  } else if (!state.board) {
    patchAttr(el.statusPill, 'data-state', 'loading')
    patchAttr(lamp, 'data-state', 'connecting')
    patchText(el.statusText, 'Connecting')
  } else if (state.board.panic) {
    patchAttr(el.statusPill, 'data-state', 'panic')
    patchAttr(lamp, 'data-state', 'stale')
    patchText(el.statusText, 'Panic')
  } else {
    patchAttr(el.statusPill, 'data-state', 'connected')
    patchAttr(lamp, 'data-state', 'ready')
    patchText(el.statusText, 'Connected')
  }

  const panic = !!(state.board && state.board.panic)
  patchAttr(el.body, 'data-panic', panic ? 'on' : 'off')
  patchText(el.panicLabel, panic ? 'Hold to clear' : 'Hold for panic')
}

function renderLine() {
  const line = selfLine()
  const self = state.self
  const derived = deriveState(line)

  patchAttr(el.lineLamp, 'data-state', STATE_LAMP[derived])
  patchText(el.lineLabel, (line && line.label) || (self && self.label) || 'Unidentified line')

  const vendor = (line && line.vendor) || (self && self.vendor) || null
  const vendorLabel = (line && line.vendorLabel) || titleCase(vendor) || 'Browser'
  const dir = (line && line.profileDir) || 'profile not claimed'
  if (el.lineSub.getAttribute('data-key') !== `${vendor}|${dir}`) {
    el.lineSub.setAttribute('data-key', `${vendor}|${dir}`)
    const v = document.createElement('span')
    v.className = 'vendor'
    v.append(icon(vendorIconName(vendor), { size: 12 }), document.createTextNode(vendorLabel))
    const sep = document.createElement('span')
    sep.className = 'sb-dot-sep'
    sep.setAttribute('aria-hidden', 'true')
    const d = document.createElement('span')
    d.textContent = dir
    el.lineSub.replaceChildren(v, sep, d)
  }

  el.lineStateChip.hidden = false
  patchText(el.lineStateChip, STATE_WORD[derived])
  el.lineStateChip.className =
    derived === 'stale' || derived === 'absent'
      ? 'sb-chip sb-chip--warn'
      : derived === 'unclaimed'
        ? 'sb-chip sb-chip--accent'
        : 'sb-chip'

  patchText(el.lineDetail, line ? stateDetail(line, derived) : 'Waiting for the broker.')

  patchText(el.statTabs, line && line.present ? String(line.tabCount ?? 0) : '-')

  if (line && line.present && line.latencyMs != null) {
    if (el.statLatency.getAttribute('data-ms') !== String(line.latencyMs)) {
      el.statLatency.setAttribute('data-ms', String(line.latencyMs))
      const unit = document.createElement('span')
      unit.className = 'unit'
      unit.textContent = 'ms'
      el.statLatency.replaceChildren(document.createTextNode(String(line.latencyMs)), unit)
    }
  } else {
    el.statLatency.removeAttribute('data-ms')
    patchText(el.statLatency, '-')
  }

  const lines = state.board ? state.board.lines : []
  const up = lines.filter((l) => l.present).length
  patchText(el.statLines, lines.length ? `${up}/${lines.length}` : '-')

  el.claimCallout.hidden = !(self && self.claimed === false)
  // Same callout, two very different reasons to be looking at it. "You never do
  // this again" is a fine thing to say at install and a false thing to say
  // after an account switch, which is exactly when the wording matters most.
  if (line && line.identityChanged) {
    patchText(el.claimTitle, 'A different account is signed in')
    patchText(
      el.claimBody,
      'This line was claimed as somebody else, so the claim was dropped and its old name no longer works. Open the board and say which profile this is.'
    )
  } else {
    patchText(el.claimTitle, 'This line needs claiming')
    patchText(
      el.claimBody,
      'Open the board and pick which browser profile this is. It takes one click and you never do it again.'
    )
  }
}

function renderArm() {
  const line = selfLine()
  const armable = !!(line && line.present && line.claimed)
  const remaining = line && line.armedUntil != null ? line.armedUntil - brokerNow() : 0
  const armed = remaining > 0

  el.armBtn.hidden = armed
  el.disarmBtn.hidden = !armed
  el.armBar.hidden = !armed
  el.armCount.hidden = !armed

  el.armBtn.disabled = !armable
  patchText(el.armBtnLabel, `Arm for ${state.armMinutes} min`)
  const who = (line && line.label) || 'this line'
  patchAttr(
    el.armBtn,
    'aria-label',
    armable
      ? `Arm ${who} for ${state.armMinutes} minutes`
      : `Cannot arm ${who}: it has to be connected and claimed first`
  )
  patchAttr(el.disarmBtn, 'aria-label', `Disarm ${who}`)

  if (armed) {
    state.armSpan = Math.max(state.armSpan, remaining)
    const pct = state.armSpan > 0 ? Math.max(0, Math.min(1, remaining / state.armSpan)) : 0
    el.armBar.style.setProperty('--sb-progress', pct.toFixed(4))
    patchAttr(el.armBar, 'aria-valuenow', String(Math.round(pct * 100)))
    patchAttr(el.armBar, 'aria-label', 'Arming window remaining')
    patchText(el.armCount, countdownText(remaining))
    patchText(el.armCopy, 'Armed. Claude can run arbitrary JavaScript in this session until the window closes.')
  } else {
    state.armSpan = 0
    patchText(
      el.armCopy,
      armable
        ? 'Arming lets Claude run arbitrary JavaScript in this logged in session. Reading and clicking never need it.'
        : 'This line has to be connected and claimed before it can be armed.'
    )
  }
}

function renderBrokerDown() {
  const down = !!state.error
  el.brokerDown.hidden = !down
  el.lineCard.hidden = down
  el.armBlock.hidden = down
  // renderLine is skipped while the broker is down, so this callout would keep
  // whatever visibility it had from the last good poll and sit there telling
  // the operator to claim a line the board cannot even see.
  if (down) el.claimCallout.hidden = true
  if (down) patchText(el.brokerCmd, P.START_BROKER_COMMAND)
}

function renderAll() {
  renderStatus()
  renderBrokerDown()
  if (!state.error) {
    renderLine()
    renderArm()
  }
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                     */
/* -------------------------------------------------------------------------- */

async function withBusy(button, fn) {
  button.disabled = true
  try {
    await fn()
  } catch (err) {
    toast(err.message, 'error')
  } finally {
    button.disabled = false
  }
}

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
      /* Capture is an optimization, not a requirement. */
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
  button.addEventListener('click', (e) => e.preventDefault())
}

function wireActions() {
  el.armBtn.addEventListener('click', () =>
    withBusy(el.armBtn, async () => {
      const line = selfLine()
      if (!line) throw new BridgeError(ERR.UNKNOWN, 'This line is not on the board yet.')
      const res = await send({ kind: 'arm', label: line.label, minutes: state.armMinutes })
      // The broker clamps and echoes what it granted. Reporting the requested
      // window instead would overstate how long arbitrary JavaScript can run.
      const granted = Number.isFinite(res.minutes) ? res.minutes : state.armMinutes
      toast(`Armed for ${granted} ${granted === 1 ? 'minute' : 'minutes'}`)
      await refresh({ immediate: true })
    })
  )

  el.disarmBtn.addEventListener('click', () =>
    withBusy(el.disarmBtn, async () => {
      const line = selfLine()
      if (!line) throw new BridgeError(ERR.UNKNOWN, 'This line is not on the board yet.')
      await send({ kind: 'disarm', label: line.label })
      toast('Disarmed')
      await refresh({ immediate: true })
    })
  )

  el.copyCmd.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(P.START_BROKER_COMMAND)
      toast('Command copied')
    } catch {
      toast('Could not copy. Select the command manually.', 'error')
    }
  })

  el.openBoard.addEventListener('click', () => {
    // openOptionsPage focuses an already-open board rather than opening a
    // second copy, which matters when many profiles are each holding one.
    try {
      chrome.runtime.openOptionsPage()
    } catch {
      chrome.tabs.create({ url: chrome.runtime.getURL('options/index.html') })
    }
    window.close()
  })

  attachHold(el.panicHold, PANIC_HOLD_MS, async () => {
    const on = !(state.board && state.board.panic)
    try {
      await send({ kind: 'panic', on })
      toast(on ? 'Panic tripped' : 'Panic cleared')
      await refresh({ immediate: true })
    } catch (err) {
      toast(err.message, 'error')
    }
  })
}

/* -------------------------------------------------------------------------- */
/* Polling                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One poll.
 *
 * Settled independently rather than joined: getBoard has to reach the broker,
 * getSelf is answered by the service worker out of its own memory. Joining them
 * meant a broker outage also erased the popup's answer to "which line am I",
 * which is the first thing anyone opens this popup to find out.
 */
async function refresh({ immediate = false } = {}) {
  const [board, self] = await Promise.allSettled([
    send({ kind: 'getBoard' }),
    send({ kind: 'getSelf' }),
  ])

  if (self.status === 'fulfilled') {
    // getSelf answers under a `self` key. Reading installId off the envelope
    // instead left the popup permanently showing an unidentified line.
    const payload = self.value.self
    state.self = payload && payload.installId ? payload : null
  }

  if (board.status === 'fulfilled') {
    state.board = board.value.board || null
    state.error = null
    if (state.board && typeof state.board.now === 'number') {
      state.skewMs = state.board.now - Date.now()
    }
  } else {
    const err = board.reason
    if (err instanceof BridgeError && !isBrokerDown(err)) {
      toast(`${err.code}: ${err.message}`, 'error')
    } else {
      state.error = { code: (err && err.code) || ERR.UNKNOWN, message: err ? err.message : '' }
      state.board = null
    }
  }

  el.body.setAttribute('data-boot', 'ready')
  renderAll()
  if (!immediate) scheduleNextPoll()
}

function scheduleNextPoll() {
  clearTimeout(state.pollTimer)
  if (document.visibilityState !== 'visible') return
  state.pollTimer = setTimeout(() => refresh(), POLL_MS)
}

function bindVisibility() {
  // A popup usually dies when it closes, but Chrome can keep it alive briefly
  // and a detached popup window is a real case. Same rule as the board: no
  // polling while nobody is looking.
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
  // Same rule as the poll. A detached popup left on a second monitor must not
  // repaint once a second forever.
  if (document.visibilityState !== 'visible') return
  state.tickTimer = setInterval(() => {
    if (state.error) return
    renderArm()
    const line = selfLine()
    if (line) patchText(el.lineDetail, stateDetail(line, deriveState(line)))
  }, TICK_MS)
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

function fatal(message) {
  el.fatal.hidden = false
  patchText(el.fatalBody, message)
  el.popBody.hidden = true
  patchAttr(el.statusPill, 'data-state', 'down')
  patchText(el.statusText, 'Stopped')
}

async function boot() {
  applyStoredTheme()
  hydrateIcons(document)

  if (!inExtension()) {
    fatal('This page has to be opened from the bridge extension.')
    return
  }

  try {
    P = await import(PROTOCOL_MODULE)
  } catch (err) {
    fatal(
      `Could not load extension/lib/protocol.js (${err && err.message ? err.message : err}). Reload the extension in this profile.`
    )
    return
  }

  // Bound before anything can send. See the note on the declaration.
  ERR = P.ERR

  patchText(el.brandName, P.PRODUCT_NAME)
  document.title = P.PRODUCT_NAME
  // The default window still has to survive a ceiling lower than it.
  state.armMinutes = Math.min(P.TIMING.DEFAULT_ARM_MINUTES, P.MAX_ARM_MINUTES)

  wireActions()
  bindVisibility()
  startClock()
  await refresh()
}

boot()
