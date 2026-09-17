/**
 * Protocol contract.
 *
 * Every process in the system imports THIS file for message shapes, operation
 * names and error codes. Nothing invents its own string literal. If a value is
 * not here, it is not part of the protocol.
 *
 * Topology (see docs/DESIGN.md section 2):
 *
 *   extension SW  --native messaging-->  host  --named pipe-->  broker
 *   mcp server    --named pipe-------------------------------->  broker
 *
 * The host is a byte relay and does not interpret messages except HELLO.
 */

export const PROTOCOL_VERSION = 1

/**
 * Product identity comes from bridge.config.json (see shared/config.mjs).
 * PIPE_NAME is the broker's local endpoint - a named pipe on Windows, a Unix
 * socket file elsewhere - and is computed in paths.mjs; it is re-exported here
 * because every client imports it from the contract.
 */
import { PRODUCT_NAME, PRODUCT_TAGLINE, NATIVE_HOST_ID } from './config.mjs'
export { PRODUCT_NAME, PRODUCT_TAGLINE, NATIVE_HOST_ID }
export { PIPE_NAME } from './paths.mjs'

/**
 * Connection roles on the broker's pipe.
 * Enforced as a capability partition (see test/capabilities.test.mjs):
 * an `mcp` connection may issue ops and may never grant arming;
 * a `host` connection may return results and may never issue ops.
 */
export const ROLE = Object.freeze({
  MCP: 'mcp',
  HOST: 'host',
})

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
 * Chunking, for the host -> browser direction only.
 *
 * Chromium caps that direction at 1 MiB (MAX_TO_BROWSER_BYTES in framing.mjs)
 * while the reverse direction allows 64 MiB, so only outbound command bodies
 * ever need splitting. The envelope lives HERE rather than in the host and the
 * extension separately: the first build had the two sides disagree on all three
 * field names, and chunked messages were silently dropped.
 *
 * Parts are raw UTF-8 slices of the serialized frame body, NOT base64. Slicing
 * a UTF-8 string by code units can split a multi-byte character, so parts are
 * cut on BYTE boundaries by the helper below and only re-joined as bytes.
 */
export const CHUNK_SLICE_BYTES = 384 * 1024

export function chunk({ id, seq, total, data }) {
  return { v: PROTOCOL_VERSION, type: MSG.CHUNK, id, seq, total, data }
}

/**
 * Split an already-serialized frame body into chunk messages.
 * @param {string} id correlation id shared by every part
 * @param {Buffer} body the UTF-8 bytes of the original message
 */
export function splitIntoChunks(id, body) {
  const total = Math.ceil(body.length / CHUNK_SLICE_BYTES) || 1
  const out = []
  for (let seq = 0; seq < total; seq++) {
    const slice = body.subarray(seq * CHUNK_SLICE_BYTES, (seq + 1) * CHUNK_SLICE_BYTES)
    // base64 so a slice can land mid-character without corrupting anything
    out.push(chunk({ id, seq, total, data: slice.toString('base64') }))
  }
  return out
}

/**
 * Reassemble parts collected by a receiver. Returns the parsed message.
 * Node-side only. The extension mirror implements the same thing with
 * atob + TextDecoder, because Buffer does not exist in a service worker.
 */
export function joinChunks(parts) {
  const buf = Buffer.concat(parts.map((p) => Buffer.from(p, 'base64')))
  return JSON.parse(buf.toString('utf8'))
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
 * This is an EXPLICIT list rather than a filter over OP_TIER. The first build
 * derived it as "not META, plus SET_LABEL", which made the META tier unusable
 * as a proxy for "never leaves the broker" and four implementers flagged it as
 * ambiguous. Tier answers "what policy applies"; this answers "who executes
 * it". They are different questions and now have different answers.
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
 * The capability partition says a host may never issue page operations - that
 * is what stops a compromised extension in one profile from driving another.
 * But the extension's own options page and popup are the UI for claiming,
 * renaming, arming and the panic switch, and they have to reach the broker
 * somehow. Rather than inventing a second request channel, the partition is
 * relaxed exactly this far: a host may issue REQ, but ONLY for these
 * broker-local operations, and never for anything in BROWSER_OPS.
 *
 * Arming from the board can target any line, not just the connection's own.
 * That is deliberate: the board is the operator's own UI and arming another line from it
 * is the point. The threat model already concedes same-user code (see
 * docs/DESIGN.md section 5), so the alternative would buy nothing real and cost
 * the feature.
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

/** Hard ceiling on an arm window, enforced by the broker and mirrored by the MCP schema. */
export const MAX_ARM_MINUTES = 60

/** Typed error codes. Every failure the model can see is one of these. */
/**
 * The rule for a custom profile label: 1 to 32 characters of lowercase
 * letters, digits and hyphens, starting with a letter or digit. Owned here so
 * the broker's setLabel and the command-line rename check the same rule; a
 * client-side copy that drifted would refuse names the broker accepts, or send
 * names it refuses.
 */
export const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

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
  // reads them, so they belong in the shared vocabulary rather than being
  // minted as bare literals in two UI files.
  NO_EXTENSION: 'E_NO_EXTENSION',
  NO_WORKER: 'E_NO_WORKER',
  UNKNOWN: 'E_UNKNOWN',
})

/** Route link states, computed from the heartbeat clock and never from socket existence. */
export const LINK = Object.freeze({
  DOWN: 'down',
  CONNECTING: 'connecting',
  READY: 'ready',
  STALE: 'stale',
})

/** Timings, in milliseconds. One place, so the extension and broker cannot disagree. */
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
  // How often a task-launched broker checks that its launcher is still there.
  // Only an operator running schtasks /end produces the condition, so this can
  // be lazy; the cost of noticing late is one idle minute, and the cost of
  // never noticing is an unsupervised broker plus a no-op relaunch every
  // minute forever.
  PARENT_WATCH_INTERVAL: 15_000,
})

/**
 * URL schemes the extension must refuse before it ever reaches a browser API.
 * Chromium blocks scripting on these anyway; refusing early turns a confusing
 * permission error into a typed one.
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
  // file:// is refused because browser_navigate is WRITE tier and
  // browser_read_page is READ tier, so without this a prompt injection could
  // compose them into an unarmed local-file read primitive - navigating to
  // file:///C:/Users/alice/.secrets.env and reading it back. Chrome
  // also requires a per-extension "allow access to file URLs" opt-in, but the
  // refusal belongs here rather than resting on a browser setting.
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
 * Applying it before let jitter push the delay 25 percent past the cap, which
 * made "capped at 15 s" untrue by up to 3.75 s.
 */
export function backoffDelay(attempt, { base, factor, cap }) {
  const raw = Math.min(cap, base * Math.pow(factor, Math.max(0, attempt)))
  const jittered = raw + raw * 0.25 * (Math.random() * 2 - 1)
  return Math.max(base, Math.min(cap, Math.round(jittered)))
}

/* -------------------------------------------------------------------------- */
/* Message builders. Used everywhere so an envelope can never be half-formed.  */
/* -------------------------------------------------------------------------- */

export function hello({ role, token, ...rest }) {
  return { v: PROTOCOL_VERSION, type: MSG.HELLO, role, token, ...rest }
}

export function helloAck({ ok, error = null, ...rest }) {
  return { v: PROTOCOL_VERSION, type: MSG.HELLO_ACK, ok, error, ...rest }
}

/**
 * The extension introducing itself, relayed up by the host.
 *
 * The field list is pinned HERE because the first build had the extension send
 * `vendor`/`extensionVersion` while the broker read `vendorHint`/`extVersion`,
 * so every Brave profile silently registered as Chrome. Both sides now build
 * and read this envelope through these two functions.
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
 * The broker's answer. Every field the extension stores or the UI renders must
 * be listed here, or it silently reads as null on the other side.
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
 * Mint an opaque tab handle. The profile label and the browser-session
 * generation are embedded on purpose: a handle from one profile can never be
 * silently used against another, and a handle from a previous browser session
 * fails loudly instead of landing on whatever tab now holds that integer id.
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

/* -------------------------------------------------------------------------- */
/* Board shape                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The payload of OPS.GET_BOARD. This is the contract between the broker (which
 * produces it) and the options page and popup (which render it). Both sides
 * import this file, so the shape cannot drift.
 *
 * @typedef {object} Line            one browser profile, one "line" on the board
 * @property {string}  installId     stable UUID minted by that extension instance
 * @property {string}  label         human label, renamable. What an address must say.
 * @property {string}  desiredLabel  the name before collisions were resolved. Two
 *                                   lines sharing this share an identity-derived
 *                                   name, and NEITHER holds it bare.
 * @property {boolean} labelIsCustom true when the operator renamed it, so the UI can say so
 * @property {boolean} identityChanged true when the account signed into this
 *                                   profile stopped matching the one it was
 *                                   claimed as. The claim is dropped and the
 *                                   label no longer resolves; this is the
 *                                   highest-severity state a line can carry.
 * @property {string}  vendor        'chrome' | 'brave' | 'edge'
 * @property {string}  vendorLabel   'Chrome' | 'Brave' | 'Edge'
 * @property {string|null} profileDir  'Default' | 'Profile 1' | null when unclaimed
 * @property {string|null} profileName human name from Local State
 * @property {string|null} email      signed-in account, null on Brave
 * @property {string}  link          one of LINK
 * @property {boolean} present       false = configured previously but not connected now
 * @property {boolean} claimed       false = needs the operator to pick which profile this is
 * @property {Array<{dir:string,name:string,email:string|null}>} candidates  claim options
 * @property {number}  generation    browser-session generation
 * @property {number}  tabCount
 * @property {number|null} latencyMs last round-trip
 * @property {number|null} lastSeenAt epoch ms of last pong
 * @property {number|null} armedUntil epoch ms, null when not armed
 * @property {number}  opCount       operations served this broker lifetime
 * @property {string|null} lastOp
 * @property {string|null} warning   collision or misconfiguration notice
 *
 * @typedef {object} Board
 * @property {string}  product      PRODUCT_NAME
 * @property {string}  version
 * @property {number}  startedAt    broker start, epoch ms
 * @property {number}  now          broker clock, epoch ms, so the UI never trusts its own
 * @property {boolean} panic
 * @property {Line[]}  lines
 * @property {Array<{at:number,profile:string,op:string,origin:string,ok:boolean}>} audit
 */

/** Build an empty board. Keeps the broker and the UI honest about required keys. */
export function emptyBoard(version = '0.0.0', now = Date.now()) {
  return {
    product: PRODUCT_NAME,
    version,
    startedAt: now,
    now,
    panic: false,
    lines: [],
    audit: [],
  }
}

/* -------------------------------------------------------------------------- */
/* Operation result shapes                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What each browser operation resolves to. Pinned here because two of the three
 * confirmed rendering defects in the first build (tab handles never minted, and
 * page pagination silently lost) were caused by the extension and the MCP layer
 * each inventing a field name for the same value.
 *
 * @typedef {object} TabRow
 * @property {number} tabId       raw Chrome tab id. The BROKER replaces this
 *                                with `handle` before the MCP layer sees it.
 * @property {string} [handle]    opaque, profile-stamped, minted by the broker
 * @property {string} title
 * @property {string} url
 * @property {boolean} active
 * @property {number} windowId
 *
 * @typedef {object} PageResult   readPage, every format
 * @property {string} format      'text' | 'html' | 'snapshot'
 * @property {string} url
 * @property {string} title
 * @property {string} [content]   text and html formats
 * @property {Array}  [elements]  snapshot format
 * @property {number} start       byte offset this slice began at
 * @property {number} total       full length, so remaining = total - next
 * @property {number|null} next   continuation offset, null when complete
 *
 * @typedef {object} ShotResult   screenshot
 * @property {string} b64         raw base64, data: prefix already stripped
 * @property {string} mime
 * @property {number} width
 * @property {number} height
 * @property {number} bytes
 * @property {number} attempts    how many quality steps the budget loop took
 *
 * @typedef {object} ActionResult click, fill, scroll, navigate, pressKeys
 * @property {boolean} ok
 * @property {number} [tabId]     broker rewrites to `handle`
 * @property {string} [note]      a caveat the model must read, e.g. that a
 *                                synthetic key event ran listeners but
 *                                performed no default action
 */

/** Field the extension uses for a raw Chrome tab id, in every result shape. */
export const RAW_TAB_ID_FIELD = 'tabId'

/** Redact a URL to origin only. The audit log never sees a path. */
export function originOf(url) {
  try {
    const u = new URL(url)
    // Opaque origins (chrome://, about:, data:, file:) stringify to the literal
    // "null", which lands the word null next to real nulls in JSON and reads as
    // a bug. Two consumers had already worked around it independently.
    if (u.origin === 'null') return `${u.protocol}//${u.host || '(opaque)'}`
    return u.origin
  } catch {
    return '(unparseable)'
  }
}
