/**
 * Every browser operation the extension can perform.
 *
 * Two tiers, and the split is a deliberate architectural bet (see DESIGN.md
 * section 5). chrome.debugger is the only API in Chromium's _api_features.json
 * marked developer_mode_only, wired behind a flag Google can flip remotely, so
 * it is treated as REVOCABLE INFRASTRUCTURE:
 *
 *   Tier 1 - chrome.scripting.executeScript in the ISOLATED world. Covers
 *            navigate, click, fill, keys, read, scroll and active-tab
 *            screenshots. Must always work with the debugger unavailable.
 *   Tier 2 - chrome.debugger. Escalation only: trusted:true clicks, real
 *            per-character typing, full-page and background-tab screenshots,
 *            and the CSP-proof path for evalJs. A tier 2 failure degrades to a
 *            typed E_UNSUPPORTED that names the tier 1 alternative, never a
 *            raw throw.
 *
 * Policy is NOT enforced here. Tiering, arming and the panic switch are the
 * broker's job and live in exactly one place; an operation that arrives at this
 * module has already been authorized, and second-guessing it here would create
 * a second enforcement point that can drift from the first.
 */

import {
  ERR,
  OPS,
  RAW_TAB_ID_FIELD,
  TIMING,
  describeOpenOrFocus,
  isOpenOrFocusUrl,
  isRestrictedUrl,
  originOf,
  parseTabHandle,
  planOpenOrFocus,
} from './protocol.js'
import { buildSnapshot, clearSnapshot, resolveRef, snapshotMeta } from './snapshot.js'
import * as inject from './inject.js'

/** CDP version pinned for chrome.debugger.attach. */
const DEBUGGER_PROTOCOL_VERSION = '1.3'

/** Session key holding the tab ids we currently believe we have attached. */
const ATTACHED_KEY = 'dbg.attached'

/** Session key holding the last captureVisibleTab timestamp, for rate limiting. */
const CAPTURE_AT_KEY = 'shot.lastAt'

/**
 * chrome.tabs.captureVisibleTab is rate limited to roughly two calls per
 * second (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND). Exceeding it returns an
 * error rather than a slower image, so the gap is enforced on our side.
 */
const CAPTURE_MIN_GAP_MS = 550

/**
 * Screenshot budget. Claude Code caps tool output at 25,000 tokens and the
 * override that raises it applies to text only, so an image has a hard ceiling.
 * 55,000 base64 characters is the DESIGN.md starting estimate and is explicitly
 * flagged there as unmeasured - session 2 measures the real base64-per-token
 * ratio and this number moves.
 */
const SHOT_BUDGET_B64_CHARS = 55_000

/** Quality then width. Four attempts, matching DESIGN.md section 9. */
const SHOT_PLAN = [
  { quality: 0.72, scale: 1 },
  { quality: 0.6, scale: 1 },
  { quality: 0.5, scale: 1 },
  { quality: 0.5, scale: 0.5 },
]

const READ_DEFAULT_MAX_CHARS = 100_000
const READ_HARD_CAP_CHARS = 2_000_000
const TYPE_MAX_CHARS = 2_000

/** A failure with a protocol error code attached, so sw.js can answer in-contract. */
export class OpError extends Error {
  constructor(code, message, data) {
    super(message)
    this.name = 'OpError'
    this.code = code
    this.data = data
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

/**
 * Promise wrapper for callback-style chrome APIs.
 *
 * chrome.debugger reports failures through chrome.runtime.lastError inside the
 * callback rather than by throwing, and reading lastError is what marks the
 * error as handled. Using the callback form is also version-proof: it works on
 * every Chrome that has the API at all, promise support or not.
 */
function callbackApi(fn, thisArg, ...args) {
  return new Promise((resolve, reject) => {
    try {
      fn.call(thisArg, ...args, (result) => {
        const err = chrome.runtime.lastError
        if (err) reject(new Error(err.message || String(err)))
        else resolve(result)
      })
    } catch (err) {
      reject(err)
    }
  })
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId)
  } catch (_err) {
    throw new OpError(ERR.TAB_GONE, `Tab ${tabId} no longer exists in this profile.`)
  }
}

/**
 * Which tab an operation targets.
 *
 * Accepts a raw numeric id or an opaque broker handle. The broker owns the
 * handle namespace and normally unwraps it before the request reaches here, but
 * accepting both means a handle that slips through addresses the right tab
 * instead of failing on a type check.
 */
function tabIdFrom(args) {
  if (args && Number.isInteger(args[RAW_TAB_ID_FIELD])) return args[RAW_TAB_ID_FIELD]
  const t = args ? args.tab : undefined
  if (Number.isInteger(t)) return t
  if (typeof t === 'string') {
    // parseTabHandle rather than a local regex: the handle format is the
    // broker's, and a second copy of it here would drift the day it changes.
    const parsed = parseTabHandle(t)
    if (parsed) return parsed.tabId
    if (/^\d+$/.test(t)) return Number(t)
    throw new OpError(ERR.BAD_TAB_HANDLE, `"${t}" is not a valid tab handle.`)
  }
  return null
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab && Number.isInteger(tab.id)) return tab.id
  const [any] = await chrome.tabs.query({ active: true })
  if (any && Number.isInteger(any.id)) return any.id
  throw new OpError(ERR.TAB_GONE, 'This profile has no active tab to operate on.')
}

async function requireTabId(args) {
  const explicit = tabIdFrom(args)
  if (explicit !== null) return explicit
  return activeTabId()
}

/**
 * Refuse a restricted URL before touching a browser API.
 * Chromium blocks scripting on these anyway; refusing here turns an opaque
 * permission error into a typed one that names the page.
 *
 * The decision is entirely the shared helper's, including the empty URL: it
 * now returns true for one, so there is no local workaround here to drift from
 * the list. Only the WORDING branches, because a tab whose navigation has not
 * committed yet is a retry and a chrome:// page never will be.
 */
function assertNotRestricted(tab) {
  const url = (tab && (tab.url || tab.pendingUrl)) || ''
  if (!isRestrictedUrl(url)) return

  throw new OpError(
    ERR.RESTRICTED_URL,
    url
      ? `Refusing to operate on ${originOf(url)} - browser-internal, local-file and web store pages are not scriptable.`
      : 'This tab has no readable URL yet, which means a navigation has not committed. Retry once it has loaded.'
  )
}

/** Resolve `ref` or `selector` from an argument bag into a concrete selector. */
async function requireSelector(tabId, args) {
  if (args && typeof args.selector === 'string' && args.selector.trim()) return args.selector.trim()
  if (args && typeof args.ref === 'string' && args.ref.trim()) {
    const selector = await resolveRef(tabId, args.ref.trim())
    if (selector) return selector
    const meta = await snapshotMeta(tabId)
    const detail = meta
      ? `The snapshot for this tab has ${meta.count} refs and was taken at ${new Date(meta.at).toISOString()}.`
      : 'There is no snapshot for this tab.'
    throw new OpError(
      ERR.BAD_REQUEST,
      `Ref "${args.ref}" is not in this tab's snapshot. ${detail} Run readPage with format "snapshot" first, then use a ref from that result.`
    )
  }
  throw new OpError(ERR.BAD_REQUEST, 'Either "ref" or "selector" is required.')
}

/**
 * Run an injected function in a tab and unwrap the first frame's result.
 * Main frame only: `target.frameIds` is deliberately not set, because a ref
 * that means one thing in the top document and another in an iframe is a
 * wrong-element click waiting to happen.
 */
async function runInPage(tabId, func, arg, { world = 'ISOLATED' } = {}) {
  let frames
  try {
    frames = await chrome.scripting.executeScript({
      target: { tabId },
      world,
      func,
      args: [arg === undefined ? {} : arg],
    })
  } catch (err) {
    const message = err && err.message ? err.message : String(err)
    if (/cannot access|Cannot access contents|chrome:\/\/|extensions gallery|blocked/i.test(message)) {
      throw new OpError(ERR.RESTRICTED_URL, `This page cannot be scripted: ${message}`)
    }
    if (/No tab with id|No frame with id/i.test(message)) {
      throw new OpError(ERR.TAB_GONE, message)
    }
    throw new OpError(ERR.EXT_ERROR, `Script injection failed: ${message}`)
  }

  const first = Array.isArray(frames) ? frames[0] : null
  if (!first) throw new OpError(ERR.EXT_ERROR, 'Script injection returned no frame result.')
  if (first.error) throw new OpError(ERR.EXT_ERROR, `Injected script threw: ${String(first.error)}`)
  return first.result
}

/** Map the typed `{ok:false, reason}` shapes from inject.js onto protocol errors. */
function assertPageOk(result, context) {
  if (result && result.ok === false) {
    const reason = result.reason || 'failed'
    const code = reason === 'not_found' || reason === 'bad_selector' ? ERR.BAD_REQUEST : ERR.EXT_ERROR
    throw new OpError(code, `${context}: ${reason}${result.selector ? ` (${result.selector})` : ''}`)
  }
  if (result === undefined || result === null) {
    throw new OpError(ERR.EXT_ERROR, `${context}: the page returned nothing.`)
  }
  return result
}

/* -------------------------------------------------------------------------- */
/* Tier 2: chrome.debugger                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The API object is absent entirely when the developer_mode_only gate closes,
 * so its presence is the availability test. Everything downstream of this
 * function must have a tier 1 answer.
 */
function debuggerAvailable() {
  return typeof chrome !== 'undefined' && !!chrome.debugger && typeof chrome.debugger.attach === 'function'
}

function unsupported(detail) {
  return new OpError(
    ERR.UNSUPPORTED,
    `${detail} This needs chrome.debugger, which is unavailable here. Retry without trusted:true (or without fullPage) to use the tier 1 path.`
  )
}

async function attachedList() {
  try {
    const bag = await chrome.storage.session.get(ATTACHED_KEY)
    const list = bag ? bag[ATTACHED_KEY] : null
    return Array.isArray(list) ? list : []
  } catch (_err) {
    return []
  }
}

async function noteAttached(tabId, attached) {
  const list = await attachedList()
  const next = attached ? Array.from(new Set([...list, tabId])) : list.filter((id) => id !== tabId)
  try {
    await chrome.storage.session.set({ [ATTACHED_KEY]: next })
  } catch (_err) {
    /* tracking is a cleanup aid, not a correctness requirement */
  }
}

/**
 * Detach anything we were attached to before this worker started.
 *
 * The service worker can be terminated between attach and the finally that
 * detaches, which leaves the debug banner up and the tab claimed. The session
 * store survives that termination, so a cold start can clean it up. Called from
 * sw.js on every boot path.
 */
export async function sweepDebuggees() {
  if (!debuggerAvailable()) return { swept: 0 }
  const list = await attachedList()
  let swept = 0
  for (const tabId of list) {
    try {
      await callbackApi(chrome.debugger.detach, chrome.debugger, { tabId })
      swept += 1
    } catch (_err) {
      /* already gone, which is the outcome we wanted anyway */
    }
  }
  try {
    await chrome.storage.session.set({ [ATTACHED_KEY]: [] })
  } catch (_err) {
    /* ignore */
  }
  return { swept }
}

/** Keep the tracking list honest when Chrome detaches us (user closed the banner, tab closed). */
export async function noteDebuggerDetached(source) {
  if (source && Number.isInteger(source.tabId)) await noteAttached(source.tabId, false)
}

async function attachDebugger(tabId) {
  if (!debuggerAvailable()) throw unsupported('Escalation requested.')
  try {
    await callbackApi(chrome.debugger.attach, chrome.debugger, { tabId }, DEBUGGER_PROTOCOL_VERSION)
  } catch (err) {
    const message = err && err.message ? err.message : String(err)
    if (/already attached/i.test(message)) {
      // Either a previous op of ours leaked the attachment, or DevTools owns the
      // tab. Both are recoverable-looking, so proceed: the first sendCommand
      // decides. If DevTools owns it, that command fails with a clear message.
      await noteAttached(tabId, true)
      return
    }
    throw unsupported(`Could not attach the debugger to tab ${tabId}: ${message}.`)
  }
  await noteAttached(tabId, true)
}

async function detachDebugger(tabId) {
  try {
    await callbackApi(chrome.debugger.detach, chrome.debugger, { tabId })
  } catch (_err) {
    /* the tab may have closed; the tracking list is corrected either way */
  }
  await noteAttached(tabId, false)
}

async function cdp(tabId, method, params) {
  try {
    return await callbackApi(chrome.debugger.sendCommand, chrome.debugger, { tabId }, method, params || {})
  } catch (err) {
    const message = err && err.message ? err.message : String(err)
    if (/not attached/i.test(message)) {
      // Our tracking said attached but Chrome disagrees. Re-attach once rather
      // than failing an operation on stale bookkeeping.
      await noteAttached(tabId, false)
      await attachDebugger(tabId)
      return await callbackApi(chrome.debugger.sendCommand, chrome.debugger, { tabId }, method, params || {})
    }
    throw new OpError(ERR.EXT_ERROR, `CDP ${method} failed: ${message}`)
  }
}

/** Attach, run, and ALWAYS detach. The finally is the point of this wrapper. */
async function withDebugger(tabId, fn) {
  await attachDebugger(tabId)
  try {
    return await fn()
  } finally {
    await detachDebugger(tabId)
  }
}

/* -------------------------------------------------------------------------- */
/* Operations                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every tab in this profile, as TabRow objects.
 *
 * The raw Chrome id goes in RAW_TAB_ID_FIELD and nothing else. The broker
 * rewrites that exact field into an opaque, profile-stamped handle before the
 * MCP layer ever sees it, and it matches on the name: spell it anything else
 * and every row arrives without a handle, which is the whole addressing story
 * for a machine with many profiles whose tab ids collide freely.
 */
async function listTabs() {
  const tabs = await chrome.tabs.query({})
  return {
    count: tabs.length,
    tabs: tabs.map((t) => ({
      [RAW_TAB_ID_FIELD]: t.id,
      windowId: t.windowId,
      index: t.index,
      title: t.title || '',
      url: t.url || t.pendingUrl || '',
      active: !!t.active,
      pinned: !!t.pinned,
      audible: !!t.audible,
      discarded: !!t.discarded,
      status: t.status || 'unknown',
    })),
  }
}

async function readPage(args) {
  const tabId = await requireTabId(args)
  const tab = await getTab(tabId)
  assertNotRestricted(tab)

  const format = String((args && args.format) || 'text').toLowerCase()
  const maxChars = clampInt(args && args.maxChars, 1, READ_HARD_CAP_CHARS, READ_DEFAULT_MAX_CHARS)
  const cursor = clampInt(args && args.cursor, 0, Number.MAX_SAFE_INTEGER, 0)

  if (format === 'snapshot') {
    const limit = clampInt(args && args.limit, 1, 1000, 300)
    const snap = await buildSnapshot(tabId, { limit })
    if (!snap.ok) throw new OpError(ERR.EXT_ERROR, 'The page returned no snapshot.')
    // Snapshot pagination is by element index, not characters: half an element
    // is useless, and a ref that arrives without its selector is worse.
    const start = cursor
    const slice = []
    let chars = 0
    for (let i = start; i < snap.elements.length; i += 1) {
      const item = snap.elements[i]
      chars += JSON.stringify(item).length
      if (slice.length > 0 && chars > maxChars) break
      slice.push(item)
    }
    const next = start + slice.length

    // Spelled out rather than spread. These seven keys are the PageResult
    // contract the MCP layer reads, and the first build lost pagination
    // entirely by returning the same numbers under different names. The extras
    // that follow are advisory and may be ignored; `total` and `next` may not.
    return {
      format: 'snapshot',
      url: snap.url,
      title: snap.title,
      elements: slice,
      start,
      total: snap.elements.length,
      next: next < snap.elements.length ? next : null,
      // Advisory, for a model deciding whether to scroll or re-snapshot.
      shown: slice.length,
      skipped: snap.skipped,
      truncated: snap.truncated,
      scrollY: snap.scrollY,
      scrollHeight: snap.scrollHeight,
    }
  }

  if (format === 'html') {
    return assertPageOk(await runInPage(tabId, inject.pageReadHtml, { maxChars, cursor }), 'readPage html')
  }
  if (format === 'text') {
    return assertPageOk(await runInPage(tabId, inject.pageReadText, { maxChars, cursor }), 'readPage text')
  }
  throw new OpError(ERR.BAD_REQUEST, `Unknown format "${format}". Use "text", "html" or "snapshot".`)
}

async function scroll(args) {
  const tabId = await requireTabId(args)
  const tab = await getTab(tabId)
  assertNotRestricted(tab)

  let selector = null
  if (args && (args.toRef || args.ref || args.selector)) {
    selector = await requireSelector(tabId, {
      ref: args.toRef || args.ref,
      selector: args.selector,
    })
  }

  const result = await runInPage(tabId, inject.pageScroll, {
    selector,
    direction: (args && args.direction) || 'down',
    amount: args && typeof args.amount === 'number' ? args.amount : null,
    settleMs: clampInt(args && args.settleMs, 0, 2000, 350),
  })
  return assertPageOk(result, 'scroll')
}

async function navigate(args) {
  const url = args ? args.url : null
  if (typeof url !== 'string' || !url.trim()) throw new OpError(ERR.BAD_REQUEST, '"url" is required.')
  if (isRestrictedUrl(url)) {
    throw new OpError(ERR.RESTRICTED_URL, `Refusing to navigate to ${originOf(url)} - that scheme is not drivable.`)
  }

  const tabId = await requireTabId(args)
  await getTab(tabId)
  const waitUntil = String((args && args.waitUntil) || 'load').toLowerCase()
  const timeoutMs = clampInt(args && args.timeoutMs, 1_000, TIMING.OP_TIMEOUT_MAX, 20_000)

  await chrome.tabs.update(tabId, { url })
  // A navigation invalidates every ref in the old document.
  await clearSnapshot(tabId)

  if (waitUntil === 'none') {
    return { ok: true, [RAW_TAB_ID_FIELD]: tabId, url, waited: 'none' }
  }

  const settled = await waitForLoad(tabId, waitUntil, timeoutMs)
  const tab = await getTab(tabId)
  return {
    ok: true,
    [RAW_TAB_ID_FIELD]: tabId,
    url: tab.url || url,
    title: tab.title || '',
    status: tab.status || 'unknown',
    waited: waitUntil,
    timedOut: !settled,
  }
}

/**
 * Poll rather than listen. chrome.tabs.onUpdated needs a listener that outlives
 * the await, and a service worker can be terminated mid-navigation; a poll
 * re-reads ground truth every tick and cannot leak a listener.
 */
async function waitForLoad(tabId, waitUntil, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(150)
    let tab
    try {
      tab = await chrome.tabs.get(tabId)
    } catch (_err) {
      throw new OpError(ERR.TAB_GONE, `Tab ${tabId} closed during navigation.`)
    }
    if (tab.status === 'complete') return true
    if (waitUntil === 'domcontentloaded') {
      try {
        const info = await runInPage(tabId, inject.pageInfo, {})
        if (info && (info.readyState === 'interactive' || info.readyState === 'complete')) return true
      } catch (_err) {
        /* the document is still swapping; keep polling */
      }
    }
  }
  return false
}

async function openTab(args) {
  const url = args ? args.url : null
  if (typeof url !== 'string' || !url.trim()) throw new OpError(ERR.BAD_REQUEST, '"url" is required.')
  if (isRestrictedUrl(url)) {
    throw new OpError(ERR.RESTRICTED_URL, `Refusing to open ${originOf(url)} - that scheme is not drivable.`)
  }
  const active = args && typeof args.active === 'boolean' ? args.active : false
  const tab = await chrome.tabs.create({ url, active })
  return {
    ok: true,
    [RAW_TAB_ID_FIELD]: tab.id,
    windowId: tab.windowId,
    url: tab.pendingUrl || tab.url || url,
    active,
  }
}

async function closeTab(args) {
  const tabId = tabIdFrom(args)
  if (tabId === null) throw new OpError(ERR.BAD_REQUEST, '"tab" is required for closeTab.')
  await getTab(tabId)
  await chrome.tabs.remove(tabId)
  await clearSnapshot(tabId)
  return { ok: true, [RAW_TAB_ID_FIELD]: tabId, closed: true }
}

async function activateTab(args) {
  const tabId = tabIdFrom(args)
  if (tabId === null) throw new OpError(ERR.BAD_REQUEST, '"tab" is required for activateTab.')
  const tab = await getTab(tabId)
  await chrome.tabs.update(tabId, { active: true })
  try {
    // Raising the window matters for captureVisibleTab, which only ever
    // captures the active tab of the window it is given.
    await chrome.windows.update(tab.windowId, { focused: true })
  } catch (_err) {
    /* a minimized or otherwise unfocusable window still yields a valid capture */
  }
  return { ok: true, [RAW_TAB_ID_FIELD]: tabId, windowId: tab.windowId, active: true }
}

/* -------------------------------------------------------------------------- */
/* openOrFocus                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One page, one tab, at the far right of the window the operator used last.
 *
 * The problem it solves: a session generates a page, opens it, edits the file,
 * opens it again, and the operator ends the day with six tabs of the same
 * document and no idea which one is current. This finds the tab that is already
 * showing the page, reloads it in place and slides it to the end of its own
 * window, so the newest thing is always the rightmost thing.
 *
 * Three rules make it safe to run against a browser a human is working in:
 *
 *   It never activates anything unless asked. Moving and reloading a background
 *   tab does not take the keyboard away from whoever is typing; raising a
 *   window does, so `activate` is off by default and the caller has to say so.
 *
 *   It never closes a tab it did not open. Duplicates are closed only when the
 *   ledger below says this capability opened them. Everything else is left
 *   exactly where it is.
 *
 *   It never moves a pinned tab. Pinning is a deliberate statement about where
 *   a tab lives, and Chromium would clamp the move anyway; the result says the
 *   tab stayed put rather than silently reporting a move that did not happen.
 */
async function openOrFocus(args) {
  const url = args ? args.url : null
  if (typeof url !== 'string' || !url.trim()) throw new OpError(ERR.BAD_REQUEST, '"url" is required.')
  if (!isOpenOrFocusUrl(url)) {
    throw new OpError(
      ERR.RESTRICTED_URL,
      `Refusing to open ${originOf(url)} - that scheme is not drivable. The only local files this ` +
        'operation accepts are .html and .htm pages, because its job is showing a rendered page to a human.'
    )
  }
  const allowFileName = args.matchFileName === true
  const activate = args.activate === true

  const tabs = (await chrome.tabs.query({})).map((t) => ({
    tabId: t.id,
    windowId: t.windowId,
    index: t.index,
    url: t.url || t.pendingUrl || '',
    active: !!t.active,
    pinned: !!t.pinned,
  }))

  // Every window this extension instance can see belongs to ITS profile, so
  // "the most recently focused window" is structurally the right one: a call
  // aimed at this profile cannot land in another profile's window even when
  // that other window is the one on top of the operator's screen.
  const lastFocusedWindowId = await lastFocusedNormalWindow()
  const opened = await readOpenedLedger(tabs.map((t) => t.tabId))

  const plan = planOpenOrFocus({
    url,
    tabs,
    lastFocusedWindowId,
    allowFileName,
    openedByUs: Object.keys(opened).map(Number),
  })

  if (plan.action === 'open') {
    // No `index`: Chromium appends a created tab to the end of its window, which
    // is the far right. Passing an index would have to guess at pinned tabs and
    // tab groups and would get it wrong the first time either appeared.
    const create = { url, active: activate }
    if (Number.isInteger(plan.windowId)) create.windowId = plan.windowId
    const tab = await chrome.tabs.create(create)
    await rememberOpened(tab.id, url)
    return withSummary({
      ok: true,
      action: 'opened',
      [RAW_TAB_ID_FIELD]: tab.id,
      windowId: tab.windowId,
      url: tab.pendingUrl || tab.url || url,
      match: null,
      fromIndex: null,
      toIndex: tab.index,
      moved: false,
      pinned: false,
      reloaded: false,
      closed: 0,
      kept: 0,
      activated: activate,
    })
  }

  const closed = []
  for (const dup of plan.close) {
    try {
      await chrome.tabs.remove(dup.tabId)
      closed.push(dup.tabId)
      await clearSnapshot(dup.tabId)
    } catch (_err) {
      /* a tab that closed itself first is the outcome we wanted anyway */
    }
  }
  if (closed.length > 0) await forgetOpened(closed)

  // Re-read the keeper AFTER the closes: removing a tab to its left shifts its
  // index, and reporting the stale number would describe a move that never
  // happened.
  const keeper = await getTab(plan.keeper.tabId)
  if (!keeper) {
    throw new OpError(
      ERR.TAB_GONE,
      `The tab showing that page closed while this operation was running. Call it again and it will open a new one.`
    )
  }

  const fromIndex = keeper.index
  let toIndex = fromIndex
  let moved = false
  if (!keeper.pinned) {
    const result = await chrome.tabs.move(keeper.id, { index: -1 })
    const row = Array.isArray(result) ? result[0] : result
    if (row && Number.isInteger(row.index)) toIndex = row.index
    moved = toIndex !== fromIndex
  }

  await chrome.tabs.reload(keeper.id, { bypassCache: false })
  // A reload builds a new document, so every snapshot ref for this tab is dead.
  await clearSnapshot(keeper.id)

  if (activate) {
    await chrome.tabs.update(keeper.id, { active: true })
    try {
      await chrome.windows.update(keeper.windowId, { focused: true })
    } catch (_err) {
      /* a minimized window still leaves the tab active inside it */
    }
  }

  return withSummary({
    ok: true,
    action: 'reused',
    [RAW_TAB_ID_FIELD]: keeper.id,
    windowId: keeper.windowId,
    url: keeper.url || url,
    match: plan.match,
    fromIndex,
    toIndex,
    moved,
    pinned: !!keeper.pinned,
    reloaded: true,
    closed: closed.length,
    kept: plan.kept.length,
    activated: activate,
  })
}

/** Attach the one-line answer, built by the contract so every caller says the same sentence. */
function withSummary(result) {
  return { ...result, summary: describeOpenOrFocus(result) }
}

/**
 * The profile's most recently focused ordinary window, or null.
 *
 * getLastFocused can hand back a popup, a devtools window or an app window,
 * none of which is somewhere a page belongs, so the type is checked and the
 * fallback walks the window list itself. Null is a legitimate answer: with no
 * window to aim at, chrome.tabs.create opens one.
 */
async function lastFocusedNormalWindow() {
  try {
    const win = await chrome.windows.getLastFocused({ populate: false })
    if (win && win.type === 'normal' && Number.isInteger(win.id)) return win.id
  } catch (_err) {
    /* fall through to the scan */
  }
  try {
    const all = await chrome.windows.getAll({ populate: false })
    const normal = all.filter((w) => w && w.type === 'normal' && Number.isInteger(w.id))
    const focused = normal.find((w) => w.focused === true)
    if (focused) return focused.id
    const visible = normal.filter((w) => w.state !== 'minimized')
    const pool = visible.length > 0 ? visible : normal
    return pool.length > 0 ? pool[pool.length - 1].id : null
  } catch (_err) {
    return null
  }
}

/**
 * The opened-by-us ledger: { [tabId]: url } for tabs openOrFocus created.
 *
 * chrome.storage.session is the right home and not a convenience. The keys are
 * raw Chrome tab ids, which only mean anything inside ONE browser session, and
 * session storage dies at exactly the moment they stop meaning anything.
 * Surviving a browser restart would be a liability rather than a feature: tab
 * 41 in the next session is somebody else's page, and a ledger that outlived
 * its ids would hand this operation permission to close a tab the operator
 * opened by hand.
 *
 * Every read prunes ids that no longer exist, so a long session cannot grow the
 * ledger without bound and a recycled id cannot inherit an old entry.
 */
const OPENED_KEY = 'openOrFocus.opened'

async function readOpenedLedger(liveTabIds) {
  let ledger
  try {
    const stored = await chrome.storage.session.get(OPENED_KEY)
    ledger = stored && stored[OPENED_KEY] ? stored[OPENED_KEY] : {}
  } catch (_err) {
    return {}
  }
  const live = new Set(liveTabIds)
  const pruned = {}
  let dropped = false
  for (const [id, url] of Object.entries(ledger)) {
    if (live.has(Number(id))) pruned[id] = url
    else dropped = true
  }
  if (dropped) await writeOpenedLedger(pruned)
  return pruned
}

async function writeOpenedLedger(ledger) {
  try {
    await chrome.storage.session.set({ [OPENED_KEY]: ledger })
  } catch (_err) {
    // A ledger that cannot be written means the next call treats this tab as
    // the operator's own and refuses to close it. That is the safe direction to
    // fail in, so it is not an error worth failing the operation for.
  }
}

async function rememberOpened(tabId, url) {
  if (!Number.isInteger(tabId)) return
  let ledger = {}
  try {
    const stored = await chrome.storage.session.get(OPENED_KEY)
    ledger = stored && stored[OPENED_KEY] ? stored[OPENED_KEY] : {}
  } catch (_err) {
    ledger = {}
  }
  ledger[String(tabId)] = url
  await writeOpenedLedger(ledger)
}

async function forgetOpened(tabIds) {
  let ledger = {}
  try {
    const stored = await chrome.storage.session.get(OPENED_KEY)
    ledger = stored && stored[OPENED_KEY] ? stored[OPENED_KEY] : {}
  } catch (_err) {
    return
  }
  for (const id of tabIds) delete ledger[String(id)]
  await writeOpenedLedger(ledger)
}

async function click(args) {
  const tabId = await requireTabId(args)
  const tab = await getTab(tabId)
  assertNotRestricted(tab)
  const selector = await requireSelector(tabId, args)
  const trusted = args && args.trusted === true

  if (!trusted) {
    const result = await runInPage(tabId, inject.pageClick, {
      selector,
      scrollIntoView: !(args && args.scrollIntoView === false),
    })
    return { ...assertPageOk(result, 'click'), tier: 1, trusted: false }
  }

  // Tier 2. The geometry still comes from tier 1 because CDP takes viewport
  // coordinates and the page is the only thing that knows where the element is.
  if (!debuggerAvailable()) throw unsupported('A trusted click was requested.')
  const rect = assertPageOk(await runInPage(tabId, inject.pageRect, { selector }), 'click rect')

  await withDebugger(tabId, async () => {
    const base = { x: rect.cx, y: rect.cy, button: 'left', clickCount: 1 }
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.cx, y: rect.cy, button: 'none', buttons: 0 })
    await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 })
    await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 })
  })

  return { ok: true, selector, tier: 2, trusted: true, x: Math.round(rect.cx), y: Math.round(rect.cy), tag: rect.tag }
}

async function fill(args) {
  const tabId = await requireTabId(args)
  const tab = await getTab(tabId)
  assertNotRestricted(tab)
  const selector = await requireSelector(tabId, args)
  const value = args && args.value !== undefined ? args.value : ''
  const mode = String((args && args.mode) || 'set').toLowerCase()

  if (mode === 'set') {
    const result = await runInPage(tabId, inject.pageFill, {
      selector,
      value,
      blurAfter: !!(args && args.blurAfter),
    })
    return { ...assertPageOk(result, 'fill'), tier: 1, mode: 'set' }
  }

  if (mode !== 'type') throw new OpError(ERR.BAD_REQUEST, `Unknown mode "${mode}". Use "set" or "type".`)

  // Mode "type" exists for consoles that only enable Save on real keystrokes.
  // Nothing below tier 2 can produce a trusted key event.
  const text = String(value)
  if (text.length > TYPE_MAX_CHARS) {
    throw new OpError(
      ERR.BAD_REQUEST,
      `Mode "type" sends one key event per character and is capped at ${TYPE_MAX_CHARS}; this value is ${text.length}. Use mode "set".`
    )
  }
  if (!debuggerAvailable()) throw unsupported('Mode "type" was requested.')

  const focus = assertPageOk(await runInPage(tabId, inject.pageFocusSelect, { selector, select: true }), 'fill focus')

  await withDebugger(tabId, async () => {
    for (const ch of Array.from(text)) {
      if (ch === '\n') {
        await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
        continue
      }
      // keyDown carrying `text` emits the character event itself; sending a
      // separate 'char' as well would insert every character twice.
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch })
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
    }
  })

  return { ok: true, selector, tier: 2, mode: 'type', typed: text.length, focused: focus.focused, tag: focus.tag }
}

async function pressKeys(args) {
  const tabId = await requireTabId(args)
  const tab = await getTab(tabId)
  assertNotRestricted(tab)

  const keys = args ? args.keys : null
  if (!keys || (Array.isArray(keys) && keys.length === 0)) {
    throw new OpError(ERR.BAD_REQUEST, '"keys" is required, as a string ("Control+a") or an array of them.')
  }
  const list = Array.isArray(keys) ? keys.map(String) : String(keys).trim().split(/\s+/).filter(Boolean)

  let selector = null
  if (args && (args.ref || args.selector)) selector = await requireSelector(tabId, args)

  if (!(args && args.trusted === true)) {
    const result = await runInPage(tabId, inject.pagePressKeys, { selector, keys: list })
    return { ...assertPageOk(result, 'pressKeys'), tier: 1, trusted: false }
  }

  if (!debuggerAvailable()) throw unsupported('Trusted key events were requested.')
  if (selector) await runInPage(tabId, inject.pageFocusSelect, { selector, select: false })

  const VK = {
    enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
    tab: { key: 'Tab', code: 'Tab', vk: 9 },
    escape: { key: 'Escape', code: 'Escape', vk: 27 },
    esc: { key: 'Escape', code: 'Escape', vk: 27 },
    backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
    delete: { key: 'Delete', code: 'Delete', vk: 46 },
    space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
    home: { key: 'Home', code: 'Home', vk: 36 },
    end: { key: 'End', code: 'End', vk: 35 },
    pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
    pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  }
  // CDP modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8.
  const MOD = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, win: 4, shift: 8 }

  const dispatched = []
  await withDebugger(tabId, async () => {
    for (const spec of list) {
      let modifiers = 0
      let base = ''
      for (const part of String(spec).split('+').map((s) => s.trim()).filter(Boolean)) {
        const bit = MOD[part.toLowerCase()]
        if (bit) modifiers |= bit
        else base = part
      }
      const named = VK[base.toLowerCase()]
      const key = named ? named.key : base
      const code = named ? named.code : base.length === 1 && /[a-z]/i.test(base) ? 'Key' + base.toUpperCase() : base
      const vk = named ? named.vk : base.length === 1 ? base.toUpperCase().charCodeAt(0) : 0
      const text = named ? named.text : base.length === 1 && modifiers === 0 ? base : undefined

      const down = { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers }
      if (text) down.text = text
      await cdp(tabId, 'Input.dispatchKeyEvent', down)
      await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers })
      dispatched.push(spec)
    }
  })

  return { ok: true, tier: 2, trusted: true, dispatched }
}

async function waitFor(args) {
  const tabId = await requireTabId(args)
  const tab = await getTab(tabId)
  assertNotRestricted(tab)

  const selector = args && typeof args.selector === 'string' ? args.selector : null
  const text = args && typeof args.text === 'string' ? args.text : null
  if (!selector && !text) throw new OpError(ERR.BAD_REQUEST, 'waitFor needs either "selector" or "text".')

  const timeoutMs = clampInt(args && args.timeoutMs, 100, TIMING.OP_TIMEOUT_MAX, 10_000)
  const pollMs = clampInt(args && args.pollMs, 50, 2_000, 250)
  const started = Date.now()
  const deadline = started + timeoutMs
  let polls = 0
  let last = null

  for (;;) {
    polls += 1
    try {
      last = await runInPage(tabId, inject.pageWaitCheck, {
        selector,
        text,
        visible: !(args && args.visible === false),
      })
      if (last && last.found) {
        return { ok: true, found: true, waitedMs: Date.now() - started, polls, ...last }
      }
    } catch (err) {
      // A navigation mid-wait tears down the injected context. That is a normal
      // thing to be waiting THROUGH, so it is not a failure until the deadline.
      if (err instanceof OpError && err.code === ERR.TAB_GONE) throw err
      last = { found: false, transient: err instanceof Error ? err.message : String(err) }
    }
    if (Date.now() + pollMs >= deadline) break
    await sleep(pollMs)
  }

  return {
    ok: false,
    found: false,
    waitedMs: Date.now() - started,
    polls,
    timedOut: true,
    matcher: selector ? { selector } : { text },
    last,
  }
}

/* -------------------------------------------------------------------------- */
/* Screenshots                                                                 */
/* -------------------------------------------------------------------------- */

async function screenshot(args) {
  const tabId = await requireTabId(args)
  const tab = await getTab(tabId)
  assertNotRestricted(tab)

  const fullPage = !!(args && args.fullPage)
  const maxWidth = clampInt(args && args.maxWidth, 200, 4096, null)

  let source = null
  let degraded = null

  if (fullPage || !tab.active) {
    if (debuggerAvailable()) {
      try {
        source = await captureViaDebugger(tabId, { fullPage })
      } catch (err) {
        // Falling back beats failing: a viewport shot of the right page is
        // worth more than a typed error about the page being in the background.
        degraded = err instanceof OpError ? err.message : String(err)
      }
    } else {
      degraded = 'chrome.debugger is unavailable.'
    }
  }

  if (!source) {
    source = await captureVisible(tabId, tab)
  }

  const encoded = await encodeWithinBudget(source.bytes, source.mime, maxWidth)
  return {
    ok: true,
    [RAW_TAB_ID_FIELD]: tabId,
    url: tab.url ? originOf(tab.url) : null,
    title: tab.title || '',
    via: source.via,
    fullPage: source.fullPage,
    degraded,
    ...encoded,
  }
}

/**
 * Tier 1 capture. captureVisibleTab takes a WINDOW id, not a tab id, and only
 * ever captures that window's ACTIVE tab - so the tab has to be activated
 * first or the image is silently of the wrong page.
 */
async function captureVisible(tabId, tab) {
  let activated = false
  if (!tab.active) {
    await activateTab({ tabId })
    activated = true
    await sleep(120) // one paint after the switch
  }
  await respectCaptureRate()
  let dataUrl
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  } catch (err) {
    throw new OpError(ERR.EXT_ERROR, `captureVisibleTab failed: ${err && err.message ? err.message : String(err)}`)
  }
  if (typeof dataUrl !== 'string' || dataUrl.indexOf(',') < 0) {
    throw new OpError(ERR.EXT_ERROR, 'captureVisibleTab returned no image.')
  }
  return {
    bytes: base64ToBytes(dataUrl.slice(dataUrl.indexOf(',') + 1)),
    mime: 'image/png',
    via: activated ? 'captureVisibleTab (tab activated)' : 'captureVisibleTab',
    fullPage: false,
  }
}

async function respectCaptureRate() {
  let last = 0
  try {
    const bag = await chrome.storage.session.get(CAPTURE_AT_KEY)
    last = (bag && bag[CAPTURE_AT_KEY]) || 0
  } catch (_err) {
    /* ignore */
  }
  const wait = CAPTURE_MIN_GAP_MS - (Date.now() - last)
  if (wait > 0) await sleep(wait)
  try {
    await chrome.storage.session.set({ [CAPTURE_AT_KEY]: Date.now() })
  } catch (_err) {
    /* ignore */
  }
}

/** Tier 2 capture: full page, or a tab we would rather not disturb. */
async function captureViaDebugger(tabId, { fullPage }) {
  return withDebugger(tabId, async () => {
    await cdp(tabId, 'Page.enable')
    // A background tab may not be compositing frames, so the capture can come
    // back blank without this.
    await cdp(tabId, 'Page.bringToFront')

    const params = { format: 'png', captureBeyondViewport: true }
    if (fullPage) {
      const metrics = await cdp(tabId, 'Page.getLayoutMetrics')
      const size = (metrics && (metrics.cssContentSize || metrics.contentSize)) || null
      if (size) {
        params.clip = {
          x: 0,
          y: 0,
          width: Math.ceil(size.width),
          // Chromium refuses a texture taller than 16384px; asking for more
          // returns an error rather than a truncated image.
          height: Math.min(Math.ceil(size.height), 16_384),
          scale: 1,
        }
      }
    }

    const shot = await cdp(tabId, 'Page.captureScreenshot', params)
    if (!shot || typeof shot.data !== 'string') {
      throw new OpError(ERR.EXT_ERROR, 'Page.captureScreenshot returned no data.')
    }
    return {
      bytes: base64ToBytes(shot.data),
      mime: 'image/png',
      via: fullPage ? 'CDP Page.captureScreenshot (full page)' : 'CDP Page.captureScreenshot',
      fullPage: !!fullPage,
    }
  })
}

/**
 * The budget loop from DESIGN.md section 9: quality 0.72, then 0.60, then 0.50,
 * then halve the width. At most four attempts, and whatever it lands on is
 * returned with its real numbers so the MCP server can report them and the
 * model can adapt its next request.
 *
 * Re-encoding happens here in the service worker using OffscreenCanvas, which
 * is available in a worker context. DESIGN.md section 11 notes an offscreen
 * DOCUMENT under reasons:['BLOBS'] as the eventual home for this pixel work, to
 * keep it off the worker's request budget; that is an optimization, not a
 * correctness requirement, and it would need an extra permission and an extra
 * file this component does not own.
 */
async function encodeWithinBudget(bytes, mime, maxWidth) {
  const blob = new Blob([bytes], { type: mime })
  let bitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch (err) {
    throw new OpError(ERR.EXT_ERROR, `Could not decode the capture: ${err && err.message ? err.message : String(err)}`)
  }

  // Read the source dimensions BEFORE closing: an ImageBitmap reports 0 for
  // both once close() has released it.
  const sourceWidth = bitmap.width
  const sourceHeight = bitmap.height
  const baseWidth = maxWidth ? Math.min(maxWidth, sourceWidth) : sourceWidth
  let best = null
  let attempts = 0

  try {
    for (const step of SHOT_PLAN) {
      attempts += 1
      const width = Math.max(200, Math.round(baseWidth * step.scale))
      best = await encodeJpeg(bitmap, width, step.quality)
      if (best.b64.length <= SHOT_BUDGET_B64_CHARS) break
    }
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close()
  }

  return {
    b64: best.b64,
    mime: 'image/jpeg',
    width: best.width,
    height: best.height,
    bytes: best.bytes,
    b64Chars: best.b64.length,
    attempts,
    budget: SHOT_BUDGET_B64_CHARS,
    overBudget: best.b64.length > SHOT_BUDGET_B64_CHARS,
    sourceWidth,
    sourceHeight,
  }
}

async function encodeJpeg(bitmap, targetWidth, quality) {
  const scale = targetWidth / bitmap.width
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, w, h)
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality })
  const buf = new Uint8Array(await out.arrayBuffer())
  return { b64: bytesToBase64(buf), width: w, height: h, bytes: buf.length }
}

function base64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToBase64(bytes) {
  // Chunked because String.fromCharCode.apply blows the argument limit on
  // anything the size of a screenshot.
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

/* -------------------------------------------------------------------------- */
/* Armed tier and housekeeping                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Arbitrary JS in an authenticated session. Two paths, tried in order:
 *
 *   1. MAIN-world executeScript. The injected wrapper itself is compiled by the
 *      extension and bypasses the page CSP, but the STRING it evaluates does
 *      not: `new Function(src)` runs in the page realm, so a page whose
 *      script-src omits unsafe-eval throws an EvalError. Most pages allow it,
 *      and it needs no debugger.
 *   2. CDP Runtime.evaluate, which the page CSP does not govern. This is the
 *      path that works on a locked-down console, and it is why evalJs is
 *      reachable at all when tier 1 is refused.
 *
 * Arming is the broker's gate, not this module's.
 */
async function evalJs(args) {
  const expression = args ? args.expression : null
  if (typeof expression !== 'string' || !expression.trim()) {
    throw new OpError(ERR.BAD_REQUEST, '"expression" is required.')
  }
  const tabId = await requireTabId(args)
  const tab = await getTab(tabId)
  assertNotRestricted(tab)
  const world = String((args && args.world) || 'MAIN').toUpperCase() === 'ISOLATED' ? 'ISOLATED' : 'MAIN'

  let pageThrew = null
  let mainWorldFailure = null
  try {
    const r = await runInPage(tabId, inject.pageEval, { source: expression }, { world })
    if (r && r.ok) return { ok: true, value: r.value, type: r.type, via: 'scripting', world, tier: 1 }
    if (r && r.reason === 'threw') pageThrew = r.error
    else mainWorldFailure = (r && r.error) || 'the page CSP blocked eval in the MAIN world'
  } catch (err) {
    // A page that cannot be scripted at all, or a tab that vanished, is the
    // answer - escalating to CDP would not change either outcome.
    if (err instanceof OpError && (err.code === ERR.RESTRICTED_URL || err.code === ERR.TAB_GONE)) throw err
    mainWorldFailure = err && err.message ? err.message : String(err)
  }

  // The expression ran and threw. That is the caller's result, not a reason to
  // escalate: running it again through CDP would throw exactly the same way.
  if (pageThrew) throw new OpError(ERR.EXT_ERROR, `Expression threw: ${pageThrew}`)

  if (!debuggerAvailable()) {
    throw unsupported(`Evaluation in the MAIN world failed (${mainWorldFailure}).`)
  }

  const result = await withDebugger(tabId, async () => {
    let r = await cdp(tabId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (r && r.exceptionDetails) {
      const text = r.exceptionDetails.text || ''
      const desc = (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || ''
      throw new OpError(ERR.EXT_ERROR, `Expression threw: ${text} ${desc}`.trim())
    }
    if (r && r.result && r.result.value === undefined && r.result.type === 'object') {
      // Not serializable by value; take the description rather than nothing.
      r = await cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: false, awaitPromise: true })
      return { value: (r.result && r.result.description) || null, type: r.result && r.result.type, serialized: false }
    }
    return { value: r && r.result ? (r.result.value ?? null) : null, type: r && r.result ? r.result.type : 'undefined', serialized: true }
  })

  return { ok: true, ...result, via: 'cdp', world: 'MAIN', tier: 2, cspFallback: true }
}

/**
 * Store the human label for this profile.
 *
 * The broker owns the authoritative label (it has to, since it arbitrates
 * collisions across many profiles). This copy exists so the popup can name the
 * profile without a round trip, and so a label survives a broker restart in the
 * UI even before the next REGISTER_ACK.
 */
async function setLabel(args) {
  const label = args ? args.label : null
  if (typeof label !== 'string' || !label.trim()) throw new OpError(ERR.BAD_REQUEST, '"label" is required.')
  const clean = label.trim().slice(0, 64)
  await chrome.storage.local.set({ label: clean })
  return { ok: true, label: clean }
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                    */
/* -------------------------------------------------------------------------- */

const HANDLERS = Object.freeze({
  [OPS.LIST_TABS]: listTabs,
  [OPS.READ_PAGE]: readPage,
  [OPS.SCREENSHOT]: screenshot,
  [OPS.SCROLL]: scroll,
  [OPS.NAVIGATE]: navigate,
  [OPS.OPEN_TAB]: openTab,
  [OPS.OPEN_OR_FOCUS]: openOrFocus,
  [OPS.CLOSE_TAB]: closeTab,
  [OPS.ACTIVATE_TAB]: activateTab,
  [OPS.CLICK]: click,
  [OPS.FILL]: fill,
  [OPS.PRESS_KEYS]: pressKeys,
  [OPS.WAIT_FOR]: waitFor,
  [OPS.EVAL_JS]: evalJs,
  [OPS.SET_LABEL]: setLabel,
})

/** Every op this extension can serve. Used by REGISTER so the broker knows. */
export const SUPPORTED_OPS = Object.freeze(Object.keys(HANDLERS))

export async function runOp(op, args) {
  const handler = HANDLERS[op]
  if (!handler) {
    throw new OpError(
      ERR.UNSUPPORTED,
      `Unknown operation "${op}". This extension serves: ${SUPPORTED_OPS.join(', ')}.`
    )
  }
  return handler(args || {})
}
