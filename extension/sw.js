/**
 * The service worker: link lifecycle and operation dispatch.
 *
 * Two responsibilities and nothing else. Keeping the link up lives in
 * lib/link.js; performing operations lives in lib/ops.js; this file wires the
 * browser's events to them.
 *
 * MV3 requires every event listener to be registered synchronously during the
 * first turn of worker evaluation - a listener added inside an async callback
 * is not registered in time to receive the event that woke the worker. That is
 * why the registrations below sit at the top level of the module and do nothing
 * but hand off. It is also the one place in the extension where a chrome.* call
 * happens outside a function, deliberately.
 *
 * Logging goes to the extension's own console. There is no stdout here: the
 * native-messaging stream is owned by the host process, three files away, and
 * nothing this worker prints can reach it.
 */

import { ERR, MAX_ARM_MINUTES, MSG, OPS, TIMING, fail, ok } from './lib/protocol.js'
import {
  ensureConnected,
  forceReconnect,
  getInstallId,
  getSelf,
  requestBroker,
  setRequestHandler,
} from './lib/link.js'
import { OpError, noteDebuggerDetached, runOp, sweepDebuggees } from './lib/ops.js'
import { clearSnapshot } from './lib/snapshot.js'
import { isOwnExtensionPage } from './lib/ui-sender.js'

const KEEPALIVE_ALARM = 'bridge.keepalive'

/* -------------------------------------------------------------------------- */
/* Wiring                                                                      */
/* -------------------------------------------------------------------------- */

setRequestHandler(handleRequest)

/**
 * Three independent wake sources, all funneling into one idempotent
 * ensureConnected(), plus the cold start below.
 *
 * The alarm is recreated inside both handlers rather than trusting it to
 * persist. An alarm surviving a browser restart is documented behavior, but
 * "documented" and "the bridge is down and nobody knows" are not worth trading;
 * chrome.alarms.create on an existing name is a cheap no-op replacement.
 */
chrome.runtime.onInstalled.addListener((details) => {
  void boot(`onInstalled:${details && details.reason ? details.reason : 'unknown'}`)
})

chrome.runtime.onStartup.addListener(() => {
  void boot('onStartup')
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === KEEPALIVE_ALARM) void ensureConnected('alarm')
})

/**
 * Residual eviction - an extension reload, a browser update, a worker crash -
 * revives the worker through some unrelated event and fires none of the three
 * handlers above. This runs on every evaluation of the module and covers it.
 */
void boot('worker-start')

/** Chrome detached us: the user dismissed the debug banner, or the tab closed. */
if (chrome.debugger && chrome.debugger.onDetach) {
  chrome.debugger.onDetach.addListener((source, reason) => {
    console.info('[bridge] debugger detached:', reason)
    void noteDebuggerDetached(source)
  })
}

/** A closed tab's refs can never resolve again. */
chrome.tabs.onRemoved.addListener((tabId) => {
  void clearSnapshot(tabId)
})

/** So can a tab that navigated: same tab id, entirely different document. */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo && changeInfo.url) void clearSnapshot(tabId)
})

/**
 * The options page and popup talk to the worker through here, and nothing else
 * may. A content script also reaches this listener, from inside a web page's
 * renderer, so the sender is checked before the message is read at all: see
 * lib/ui-sender.js for why.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isOwnExtensionPage(sender, chrome.runtime.id)) {
    console.warn('[bridge] refused a UI message from outside this extension:', sender && (sender.origin || sender.url))
    sendResponse(uiError(new Error(`${ERR.UNAUTHORIZED}: only this extension's own pages may use the board API.`)))
    return false
  }
  handleUiMessage(message).then(sendResponse, (err) => sendResponse(uiError(err)))
  return true // keeps the channel open for the async reply
})

async function boot(reason) {
  try {
    await ensureAlarm()
    await getInstallId() // mint it before the first REGISTER needs it
    await sweepDebuggees() // clean up anything a terminated worker left attached
  } catch (err) {
    console.error('[bridge] boot housekeeping failed:', err)
  }
  await ensureConnected(reason)
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(KEEPALIVE_ALARM)
  if (existing) return
  await chrome.alarms.create(KEEPALIVE_ALARM, {
    periodInMinutes: TIMING.ALARM_PERIOD_MINUTES,
  })
}

/* -------------------------------------------------------------------------- */
/* Operation dispatch                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Turn one REQ into one RES. Always returns an envelope, never throws: a
 * request that produced no response would leave the broker holding an id until
 * its own timeout, and the model would see a generic stall instead of a typed
 * reason.
 */
async function handleRequest(msg) {
  const id = msg ? msg.id : undefined
  if (id === undefined || id === null) {
    console.warn('[bridge] dropping a request with no id')
    return null
  }
  if (msg.type !== MSG.REQ) return fail(id, ERR.BAD_REQUEST, `Expected a ${MSG.REQ} envelope.`)
  if (!msg.op) return fail(id, ERR.BAD_REQUEST, 'Request carried no op.')

  const timeoutMs = clampTimeout(msg.timeoutMs)
  const started = Date.now()

  try {
    const result = await withDeadline(runOp(msg.op, msg.args || {}), timeoutMs, msg.op)
    return ok(id, result)
  } catch (err) {
    if (err instanceof OpError) return fail(id, err.code, err.message, err.data)
    const message = err && err.message ? err.message : String(err)
    console.error(`[bridge] ${msg.op} failed after ${Date.now() - started}ms:`, err)
    return fail(id, ERR.EXT_ERROR, message)
  }
}

function clampTimeout(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return TIMING.OP_TIMEOUT_DEFAULT
  return Math.max(1_000, Math.min(TIMING.OP_TIMEOUT_MAX, Math.round(n)))
}

/**
 * The broker times out too. This one exists so the EXTENSION never sits on a
 * hung operation: an injected script that never settles would otherwise hold a
 * worker request open until Chrome tore the whole worker down.
 */
function withDeadline(promise, timeoutMs, op) {
  let timer = null
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new OpError(ERR.TIMEOUT, `${op} exceeded ${timeoutMs}ms in the extension.`)), timeoutMs)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

/* -------------------------------------------------------------------------- */
/* UI message API                                                              */
/* -------------------------------------------------------------------------- */

/**
 * THE CONTRACT WITH options/ AND popup/ (a separate component owns those files).
 *
 * Every call is chrome.runtime.sendMessage({ kind, ...args }). Every reply
 * carries { ok: true } plus the fields listed below, or
 * { ok: false, error: { code, message } } with a real protocol code, because
 * the UI's send() helper turns an ok:false reply into a typed BridgeError.
 *
 *   { kind: 'getBoard' }            -> { ok, board }   Board, shared/protocol.mjs
 *   { kind: 'getSelf' }             -> { ok, self }
 *   { kind: 'claim', dir }          -> { ok }          the field is `dir`
 *   { kind: 'setLabel', label }     -> { ok, label }
 *   { kind: 'arm', label, minutes } -> { ok, armedUntil, minutes }
 *   { kind: 'disarm', label }       -> { ok }
 *   { kind: 'panic', on }           -> { ok, panic }
 *
 * getSelf is answered from local storage, so it works while the broker is down,
 * which is exactly when the UI most needs to say something useful. `claimed` is
 * null rather than false until the broker has actually said, so an outage never
 * reads as "this profile needs claiming".
 *
 * Everything else here is a BROKER operation that this worker relays as a REQ
 * on the host link. The broker permits a host-role connection to originate
 * exactly HOST_REQ_ALLOWED_OPS, which is what makes this the sanctioned channel
 * rather than an improvised one. Two rules the first build broke:
 *
 *   - `profile` is an ENVELOPE field, never an argument. It named the target
 *     line for arm and disarm.
 *   - claimProfile and setLabel pass profile: null on purpose. The broker
 *     resolves those from the CONNECTION, because an extension may only claim
 *     or rename ITSELF.
 */

/**
 * Codes that mean the TRANSPORT is down rather than the request being wrong.
 *
 * E_PROFILE_STALE is deliberately not here. It is a verdict about a route, and
 * on the board that route is usually somebody else's line, so treating it as an
 * outage would drop this profile's own healthy link over another one's silence.
 */
const OUTAGE_CODES = Object.freeze([ERR.NO_BROKER, ERR.TIMEOUT])

/**
 * Recover the typed code from a failure.
 *
 * An OpError carries it as a property. Everything the link layer rejects with
 * carries it as an "E_SOMETHING: text" prefix instead, because a Promise
 * rejection crossing that boundary is a plain Error. Reading both here is what
 * keeps a single error vocabulary from needing a second one.
 */
function codeOf(err) {
  if (err && typeof err.code === 'string' && err.code.startsWith('E_')) return err.code
  const message = err && err.message ? err.message : String(err)
  const m = /^(E_[A-Z_]+):/.exec(message)
  return m ? m[1] : null
}

function uiError(err, fallback = ERR.EXT_ERROR) {
  const message = err && err.message ? err.message : String(err)
  const code = codeOf(err) || fallback
  return { ok: false, error: { code, message } }
}

function isOutage(err) {
  return OUTAGE_CODES.includes(codeOf(err))
}

/** Ask the broker for something on the UI's behalf, kicking a reconnect on an outage. */
async function askBroker(op, { profile = null, args = {} } = {}) {
  try {
    return await requestBroker(op, { profile, args })
  } catch (err) {
    // A typed outage means the port we are holding is not a working link. Drop
    // it and reintroduce ourselves, so the human's next click has a chance of
    // landing instead of failing the same way against the same dead link.
    if (isOutage(err)) void forceReconnect(`ui ${op} hit ${codeOf(err)}`)
    throw err
  }
}

/** The label of THIS profile, for a UI action that did not name one. */
async function ownLabel() {
  const self = await getSelf()
  return self && self.label ? self.label : null
}

async function handleUiMessage(message) {
  const kind = message && message.kind ? String(message.kind) : ''

  switch (kind) {
    case 'getBoard':
      return { ok: true, board: await askBroker(OPS.GET_BOARD) }

    case 'getSelf':
      return { ok: true, self: await getSelf() }

    case 'claim': {
      const dir = typeof message.dir === 'string' ? message.dir.trim() : ''
      if (!dir) {
        return uiError(new Error(`${ERR.BAD_REQUEST}: a profile directory is required to claim.`))
      }
      await askBroker(OPS.CLAIM_PROFILE, { args: { dir } })
      return { ok: true }
    }

    case 'setLabel': {
      const wanted = typeof message.label === 'string' ? message.label.trim() : ''
      if (!wanted) {
        return uiError(new Error(`${ERR.BAD_REQUEST}: a label is required.`))
      }

      // The broker arbitrates label collisions across many profiles, so it goes
      // first: a rename it refuses must not appear to have worked locally. An
      // OUTAGE is the one exception - the local copy stands and the next
      // REGISTER carries it up, so a broker restart cannot eat a rename.
      let authoritative = wanted
      try {
        const result = await askBroker(OPS.SET_LABEL, { args: { label: wanted } })
        if (result && result.line && typeof result.line.label === 'string') {
          authoritative = result.line.label
        }
      } catch (err) {
        if (!isOutage(err)) throw err
      }

      const local = await runOp(OPS.SET_LABEL, { label: authoritative })
      return { ok: true, label: local.label }
    }

    case 'arm': {
      const profile = (typeof message.label === 'string' && message.label) || (await ownLabel())
      if (!profile) {
        return uiError(
          new Error(`${ERR.BAD_REQUEST}: arming needs a profile, and this one has no label yet.`)
        )
      }
      // Clamped here as well as in the broker so the reply tells the truth even
      // if the broker ever answers without echoing the value it used.
      const minutes = clampArmMinutes(message.minutes)
      const result = await askBroker(OPS.ARM, { profile, args: { minutes } })
      return {
        ok: true,
        armedUntil: result && result.armedUntil != null ? result.armedUntil : null,
        minutes: result && Number.isFinite(result.minutes) ? result.minutes : minutes,
      }
    }

    case 'disarm': {
      const profile = (typeof message.label === 'string' && message.label) || (await ownLabel())
      if (!profile) {
        return uiError(
          new Error(`${ERR.BAD_REQUEST}: disarming needs a profile, and this one has no label yet.`)
        )
      }
      await askBroker(OPS.DISARM, { profile })
      return { ok: true }
    }

    case 'panic': {
      const on = message.on !== false
      const result = await askBroker(OPS.PANIC, { args: { on } })
      return { ok: true, panic: result && typeof result.panic === 'boolean' ? result.panic : on }
    }

    default:
      return uiError(new Error(`${ERR.BAD_REQUEST}: unknown request "${kind}".`))
  }
}

function clampArmMinutes(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return TIMING.DEFAULT_ARM_MINUTES
  return Math.max(1, Math.min(MAX_ARM_MINUTES, Math.round(n)))
}
