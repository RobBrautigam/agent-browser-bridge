/**
 * Protocol constants MIRRORED from ../../shared/protocol.mjs, plus the two
 * values the extension needs out of ../../shared/paths.mjs.
 *
 * An extension can only load files from inside its own folder, so it cannot
 * import the shared module. These values are COPIED. shared/protocol.mjs is the
 * source of truth and this file must be kept in sync with it by hand: a drift
 * here is a silent wire incompatibility, not a load error.
 *
 * The file is named protocol.js, matching the module it mirrors, because the
 * options page and the popup dynamically import '../lib/protocol.js'. It was
 * called constants.js in the first build, which meant both pages threw on load
 * and rendered their fatal-error state instead of the board - including the
 * Brave claim flow that three profiles cannot come up without.
 */

export const PROTOCOL_VERSION = 1

/**
 * Product identity, from the GENERATED ./config.js (scripts/sync-config.mjs
 * writes it from bridge.config.json, and scripts/gate.mjs fails when the two
 * disagree). The extension cannot read the repo's config file itself.
 */
import { PRODUCT_NAME, PRODUCT_TAGLINE, NATIVE_HOST_ID, SERVICE_NAME, LAUNCHD_LABEL, SYSTEMD_UNIT } from './config.js'
export { PRODUCT_NAME, PRODUCT_TAGLINE, NATIVE_HOST_ID }

/**
 * The supervisor entry's name and the one command that restarts the broker,
 * mirrored from shared/paths.mjs. The UI tells a human how to restart a dead
 * broker, and five call sites had independently typed this string before it
 * was pinned. The command depends on the platform the browser is running on.
 */
export const TASK_NAME = SERVICE_NAME
export const START_BROKER_COMMAND = startBrokerCommand()

function startBrokerCommand() {
  const platform = detectPlatform()
  if (platform === 'mac') return `launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}`
  if (platform === 'linux') return `systemctl --user restart ${SYSTEMD_UNIT}`
  return `schtasks /Run /TN "${TASK_NAME}"`
}

/** 'windows' | 'mac' | 'linux', from the browser's own report. Defaults to windows. */
function detectPlatform() {
  try {
    const uad = typeof navigator !== 'undefined' ? navigator.userAgentData : null
    const hint = String((uad && uad.platform) || (typeof navigator !== 'undefined' ? navigator.platform : '') || '').toLowerCase()
    if (hint.includes('mac')) return 'mac'
    if (hint.includes('linux') || hint.includes('x11') || hint.includes('cros')) return 'linux'
  } catch (_err) {
    /* fall through */
  }
  return 'windows'
}

/** Message envelope types. */
export const MSG = Object.freeze({
  HELLO: 'hello',
  HELLO_ACK: 'hello_ack',
  REGISTER: 'register',
  REGISTER_ACK: 'register_ack',
  REQ: 'req',
  RES: 'res',
  EVENT: 'event',
  PING: 'ping',
  PONG: 'pong',
  CHUNK: 'chunk',
})

/**
 * Chunking, for the host to browser direction only.
 *
 * Chromium caps that direction at 1 MiB while the reverse allows 64 MiB, so
 * only inbound command bodies ever arrive split and a screenshot goes back
 * whole. There is no splitIntoChunks here for exactly that reason: the
 * extension only ever REASSEMBLES.
 *
 * Parts are base64 slices cut on BYTE boundaries by the host, so a multi-byte
 * character can straddle a part without corrupting anything.
 */
export const CHUNK_SLICE_BYTES = 384 * 1024

export function chunk({ id, seq, total, data }) {
  return { v: PROTOCOL_VERSION, type: MSG.CHUNK, id, seq, total, data }
}

/**
 * Reassemble the base64 parts of a chunked message, in order.
 *
 * Buffer does not exist in a service worker, so this is the atob + TextDecoder
 * twin of the Node implementation. Each part is decoded to BYTES first and the
 * UTF-8 decode happens once over the joined bytes: decoding part by part would
 * corrupt any character that straddles a slice boundary, which is the whole
 * reason the host slices on bytes rather than on string length.
 *
 * @param {string[]} parts base64 slices, already ordered by seq
 * @returns {any} the parsed message
 */
export function joinChunks(parts) {
  const decoded = []
  let size = 0
  for (const part of parts) {
    const binary = atob(part)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    decoded.push(bytes)
    size += bytes.length
  }

  const joined = new Uint8Array(size)
  let at = 0
  for (const bytes of decoded) {
    joined.set(bytes, at)
    at += bytes.length
  }

  return JSON.parse(new TextDecoder('utf-8').decode(joined))
}

/**
 * Operations the extension can perform. The `tier` decides policy:
 *   read  - always allowed
 *   write - allowed, always audited
 *   armed - refused unless the target profile is currently armed
 *   meta  - broker-local or extension-local housekeeping, never page-touching
 */
export const OPS = Object.freeze({
  LIST_TABS: 'listTabs',
  READ_PAGE: 'readPage',
  SCREENSHOT: 'screenshot',
  SCROLL: 'scroll',
  NAVIGATE: 'navigate',
  OPEN_TAB: 'openTab',
  CLOSE_TAB: 'closeTab',
  ACTIVATE_TAB: 'activateTab',
  CLICK: 'click',
  FILL: 'fill',
  PRESS_KEYS: 'pressKeys',
  WAIT_FOR: 'waitFor',
  EVAL_JS: 'evalJs',
  SET_LABEL: 'setLabel',
  CLAIM_PROFILE: 'claimProfile',
  GET_BOARD: 'getBoard',
  ARM: 'arm',
  DISARM: 'disarm',
  PANIC: 'panic',
  STATUS: 'status',
})

export const TIER = Object.freeze({
  READ: 'read',
  WRITE: 'write',
  ARMED: 'armed',
  META: 'meta',
})

/** Single source of truth for which tier each operation belongs to. */
export const OP_TIER = Object.freeze({
  [OPS.LIST_TABS]: TIER.READ,
  [OPS.READ_PAGE]: TIER.READ,
  [OPS.SCREENSHOT]: TIER.READ,
  [OPS.SCROLL]: TIER.READ,

  [OPS.NAVIGATE]: TIER.WRITE,
  [OPS.OPEN_TAB]: TIER.WRITE,
  [OPS.CLOSE_TAB]: TIER.WRITE,
  [OPS.ACTIVATE_TAB]: TIER.WRITE,
  [OPS.CLICK]: TIER.WRITE,
  [OPS.FILL]: TIER.WRITE,
  [OPS.PRESS_KEYS]: TIER.WRITE,
  [OPS.WAIT_FOR]: TIER.WRITE,

  [OPS.EVAL_JS]: TIER.ARMED,

  [OPS.SET_LABEL]: TIER.META,
  [OPS.CLAIM_PROFILE]: TIER.META,
  [OPS.GET_BOARD]: TIER.META,
  [OPS.ARM]: TIER.META,
  [OPS.DISARM]: TIER.META,
  [OPS.PANIC]: TIER.META,
  [OPS.STATUS]: TIER.META,
})

/**
 * Operations that actually cross into the extension.
 *
 * An EXPLICIT list rather than a filter over OP_TIER: tier answers "what policy
 * applies", this answers "who executes it", and they are different questions.
 */
export const BROWSER_OPS = Object.freeze([
  OPS.LIST_TABS,
  OPS.READ_PAGE,
  OPS.SCREENSHOT,
  OPS.SCROLL,
  OPS.NAVIGATE,
  OPS.OPEN_TAB,
  OPS.CLOSE_TAB,
  OPS.ACTIVATE_TAB,
  OPS.CLICK,
  OPS.FILL,
  OPS.PRESS_KEYS,
  OPS.WAIT_FOR,
  OPS.EVAL_JS,
])

/** Operations the broker answers itself, without touching a browser. */
export const BROKER_OPS = Object.freeze([
  OPS.SET_LABEL,
  OPS.CLAIM_PROFILE,
  OPS.GET_BOARD,
  OPS.ARM,
  OPS.DISARM,
  OPS.PANIC,
  OPS.STATUS,
])

/**
 * Operations a HOST-role connection is allowed to originate.
 *
 * This extension IS a host-role connection, so this list is the exact set of
 * things its options page and popup may ask the broker for. Anything in
 * BROWSER_OPS sent from here is refused by the broker, and rightly: a host
 * issuing page operations is what would let a compromised extension in one
 * profile drive another.
 */
export const HOST_REQ_ALLOWED_OPS = Object.freeze([
  OPS.SET_LABEL,
  OPS.CLAIM_PROFILE,
  OPS.GET_BOARD,
  OPS.ARM,
  OPS.DISARM,
  OPS.PANIC,
  OPS.STATUS,
])

/** Hard ceiling on an arm window, enforced by the broker and mirrored by the UI. */
export const MAX_ARM_MINUTES = 60

/** Typed error codes. Every failure the model can see is one of these. */
export const ERR = Object.freeze({
  NO_BROKER: 'E_NO_BROKER',
  UNAUTHORIZED: 'E_UNAUTHORIZED',
  BAD_REQUEST: 'E_BAD_REQUEST',
  UNKNOWN_PROFILE: 'E_UNKNOWN_PROFILE',
  PROFILE_STALE: 'E_PROFILE_STALE',
  PROFILE_UNCLAIMED: 'E_PROFILE_UNCLAIMED',
  BAD_TAB_HANDLE: 'E_BAD_TAB_HANDLE',
  TAB_GONE: 'E_TAB_GONE',
  NOT_ARMED: 'E_NOT_ARMED',
  PANIC: 'E_PANIC',
  TIMEOUT: 'E_TIMEOUT',
  EXT_ERROR: 'E_EXT_ERROR',
  UNSUPPORTED: 'E_UNSUPPORTED',
  RESTRICTED_URL: 'E_RESTRICTED_URL',

  // Extension-page-local. These describe an options page or popup failing to
  // reach its OWN service worker, so they never cross the wire - but a human
  // reads them, so they belong in the shared vocabulary.
  NO_EXTENSION: 'E_NO_EXTENSION',
  NO_WORKER: 'E_NO_WORKER',
  UNKNOWN: 'E_UNKNOWN',
})

/**
 * Link states. The extension only ever occupies DOWN, CONNECTING and READY.
 * STALE is a broker-side judgement about a route, computed from the heartbeat
 * clock, and is mirrored here so the two vocabularies stay identical.
 */
export const LINK = Object.freeze({
  DOWN: 'down',
  CONNECTING: 'connecting',
  READY: 'ready',
  STALE: 'stale',
})

/** Copied whole rather than cherry-picked, so a future timing change is a one-line diff. */
export const TIMING = Object.freeze({
  HELLO_ACK_TIMEOUT: 5_000,
  HOST_HELLO_DEADLINE: 10_000,
  HEARTBEAT_INTERVAL: 15_000,
  STALE_AFTER_MISSED: 3,
  EVICT_AFTER_MISSED: 6,
  OP_TIMEOUT_DEFAULT: 30_000,
  OP_TIMEOUT_MAX: 120_000,
  RECONNECT_BASE: 250,
  RECONNECT_FACTOR: 1.7,
  RECONNECT_CAP: 15_000,
  EXT_RECONNECT_BASE: 500,
  EXT_RECONNECT_FACTOR: 2,
  EXT_RECONNECT_CAP: 30_000,
  ALARM_PERIOD_MINUTES: 0.25,
  DEFAULT_ARM_MINUTES: 15,
})

/**
 * URL schemes to refuse before touching a browser API. Chromium blocks
 * scripting on these anyway; refusing early turns a confusing permission error
 * into a typed one the model can act on.
 */
export const RESTRICTED_URL_PREFIXES = Object.freeze([
  'chrome://',
  'chrome-untrusted://',
  'brave://',
  'edge://',
  'about:',
  'devtools://',
  'view-source:',
  'chrome-extension://',
  // file:// is refused because navigate is WRITE tier and readPage is READ
  // tier, so without this a prompt injection could compose them into an
  // unarmed local-file read primitive.
  'file://',
  'https://chromewebstore.google.com/',
  'https://chrome.google.com/webstore',
])

/** An empty or non-string URL is restricted: callers must never treat it as navigable. */
export function isRestrictedUrl(url) {
  if (typeof url !== 'string') return true
  const u = url.trim().toLowerCase()
  if (u === '') return true
  return RESTRICTED_URL_PREFIXES.some((p) => u.startsWith(p.toLowerCase()))
}

/**
 * Jittered exponential backoff.
 *
 * The cap is applied AFTER jitter, so the documented ceiling is a real ceiling.
 * Applying it before let jitter push the delay 25 percent past the cap.
 */
export function backoffDelay(attempt, { base, factor, cap }) {
  const raw = Math.min(cap, base * Math.pow(factor, Math.max(0, attempt)))
  const jittered = raw + raw * 0.25 * (Math.random() * 2 - 1)
  return Math.max(base, Math.min(cap, Math.round(jittered)))
}

/* -------------------------------------------------------------------------- */
/* Message builders. Used everywhere so an envelope can never be half-formed.  */
/* -------------------------------------------------------------------------- */

/**
 * The extension introducing itself, relayed up by the host.
 *
 * The field list is pinned because the first build had the extension send
 * `vendor`/`extensionVersion` while the broker read `vendorHint`/`extVersion`,
 * so every Brave profile silently registered as Chrome. Anything not named here
 * does not survive the trip, so nothing may be smuggled in beside it.
 */
export function register({
  installId,
  vendorHint = null,
  email = null,
  label = null,
  extVersion = null,
  tabCount = 0,
}) {
  return {
    v: PROTOCOL_VERSION,
    type: MSG.REGISTER,
    installId,
    vendorHint,
    email,
    label,
    extVersion,
    tabCount,
  }
}

/**
 * The broker's answer.
 *
 * The extension READS this rather than building it, but the builder is mirrored
 * anyway because it is the authoritative field list: anything the extension
 * reads off a register_ack that is not named here is reading undefined.
 */
export function registerAck({
  ok,
  error = null,
  profileKey = null,
  label = null,
  generation = 0,
  claimed = false,
  candidates = [],
  profileDir = null,
  profileName = null,
  vendor = null,
  warning = null,
  version = null,
  heartbeatMs = TIMING.HEARTBEAT_INTERVAL,
}) {
  return {
    v: PROTOCOL_VERSION,
    type: MSG.REGISTER_ACK,
    ok,
    error,
    profileKey,
    label,
    generation,
    claimed,
    candidates,
    profileDir,
    profileName,
    vendor,
    warning,
    version,
    heartbeatMs,
  }
}

export function req({ id, op, profile = null, args = {}, timeoutMs }) {
  return { v: PROTOCOL_VERSION, type: MSG.REQ, id, op, profile, args, timeoutMs }
}

export function ok(id, result) {
  return { v: PROTOCOL_VERSION, type: MSG.RES, id, ok: true, result }
}

export function fail(id, code, message, data) {
  return {
    v: PROTOCOL_VERSION,
    type: MSG.RES,
    id,
    ok: false,
    error: data === undefined ? { code, message } : { code, message, data },
  }
}

export function ping(seq) {
  return { v: PROTOCOL_VERSION, type: MSG.PING, seq }
}

export function pong(seq, extra = {}) {
  return { v: PROTOCOL_VERSION, type: MSG.PONG, seq, ...extra }
}

export function event(name, payload = {}) {
  return { v: PROTOCOL_VERSION, type: MSG.EVENT, name, payload }
}

/* -------------------------------------------------------------------------- */
/* Tab handles                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Mint an opaque tab handle. The BROKER owns this namespace; the extension
 * mirrors the two functions only so it can recognize a handle that reaches it
 * by mistake instead of failing on a type check.
 */
export function mintTabHandle(profileLabel, generation, tabId) {
  return `tab_${profileLabel}_${generation}_${tabId}`
}

/**
 * Parse a handle. Returns null when the shape is wrong, so callers must
 * explicitly decide what to do rather than getting a partially-parsed object.
 */
export function parseTabHandle(handle) {
  if (typeof handle !== 'string') return null
  const m = /^tab_(.+)_(\d+)_(\d+)$/.exec(handle)
  if (!m) return null
  return { profileLabel: m[1], generation: Number(m[2]), tabId: Number(m[3]) }
}

/**
 * Field the extension uses for a raw Chrome tab id, in every result shape.
 * The broker rewrites these to opaque handles before anything else sees them,
 * and it matches on this exact name.
 */
export const RAW_TAB_ID_FIELD = 'tabId'

/** Redact a URL to origin only. An error message never carries a path. */
export function originOf(url) {
  try {
    const u = new URL(url)
    // Opaque origins (chrome://, about:, data:, file:) stringify to the literal
    // "null", which lands the word null next to real nulls and reads as a bug.
    if (u.origin === 'null') return `${u.protocol}//${u.host || '(opaque)'}`
    return u.origin
  } catch {
    return '(unparseable)'
  }
}
