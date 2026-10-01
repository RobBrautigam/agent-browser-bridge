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
  OPEN_OR_FOCUS: 'openOrFocus',
  CLOSE_TAB: 'closeTab',
  ACTIVATE_TAB: 'activateTab',
  CLICK: 'click',
  FILL: 'fill',
  PRESS_KEYS: 'pressKeys',
  WAIT_FOR: 'waitFor',
  EVAL_JS: 'evalJs',
  RELOAD_EXTENSION: 'reloadExtension',
  SORT_WINDOW: 'sortWindow',
  SET_LABEL: 'setLabel',
  CLAIM_PROFILE: 'claimProfile',
  GET_BOARD: 'getBoard',
  ARM: 'arm',
  DISARM: 'disarm',
  PANIC: 'panic',
  RESUME: 'resume',
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
  [OPS.OPEN_OR_FOCUS]: TIER.WRITE,
  [OPS.CLOSE_TAB]: TIER.WRITE,
  [OPS.ACTIVATE_TAB]: TIER.WRITE,
  [OPS.CLICK]: TIER.WRITE,
  [OPS.FILL]: TIER.WRITE,
  [OPS.PRESS_KEYS]: TIER.WRITE,
  [OPS.WAIT_FOR]: TIER.WRITE,

  // Touches no page, and WRITE anyway: it asks THIS extension to reload itself
  // so a new release reaches the browser without a human clicking Reload. The
  // broker is the only component that can tell whether there is new code to
  // load, so the gate lives there, not here.
  [OPS.RELOAD_EXTENSION]: TIER.WRITE,

  // Moves tabs and never touches a page, so WRITE: the human's tab strip is
  // theirs, and the panic switch refuses it like every other write.
  [OPS.SORT_WINDOW]: TIER.WRITE,

  [OPS.EVAL_JS]: TIER.ARMED,

  [OPS.SET_LABEL]: TIER.META,
  [OPS.CLAIM_PROFILE]: TIER.META,
  [OPS.GET_BOARD]: TIER.META,
  [OPS.ARM]: TIER.META,
  [OPS.DISARM]: TIER.META,
  [OPS.PANIC]: TIER.META,
  [OPS.RESUME]: TIER.META,
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
  OPS.OPEN_OR_FOCUS,
  OPS.CLOSE_TAB,
  OPS.ACTIVATE_TAB,
  OPS.CLICK,
  OPS.FILL,
  OPS.PRESS_KEYS,
  OPS.WAIT_FOR,
  OPS.EVAL_JS,
  OPS.RELOAD_EXTENSION,
  OPS.SORT_WINDOW,
])

/** Operations the broker answers itself, without touching a browser. */
export const BROKER_OPS = Object.freeze([
  OPS.SET_LABEL,
  OPS.CLAIM_PROFILE,
  OPS.GET_BOARD,
  OPS.ARM,
  OPS.DISARM,
  OPS.PANIC,
  OPS.RESUME,
  OPS.STATUS,
])

/**
 * Operations ONLY a host-role connection may originate, never an MCP one.
 *
 * RESUME clears the panic switch. Only this extension's popup asks for it,
 * behind a press-and-hold; the broker drops an MCP connection that sends it.
 */
export const HOST_ONLY_OPS = Object.freeze([OPS.RESUME])

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
  OPS.RESUME,
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
  // A fill or key press aimed at a password or one-time-code field without a
  // recorded yes for that site. See secretFieldVerdict below.
  SECRET_FIELD: 'E_SECRET_FIELD',

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
  // javascript: is arbitrary script in the page, which evalJs is armed for,
  // and navigate needs no arm.
  'javascript:',
  'https://chromewebstore.google.com/',
  'https://chrome.google.com/webstore',
])

/** An empty or non-string URL is restricted: callers must never treat it as navigable. */
/**
 * The same refusals as schemes, not as text prefixes, because the number of
 * slashes in a URL is not load-bearing: `file:` is a special scheme, so
 * `file:/C:/x` normalizes to `file:///C:/x` and does not start with `file://`.
 * The reasoning, and the live check behind it, is on this function in
 * shared/protocol.mjs.
 */
const RESTRICTED_SCHEMES = new Set(
  RESTRICTED_URL_PREFIXES
    // Only the entries that ARE a scheme. Two entries on that list name a host
    // and a path (the Web Store), and those are prefix rules about a specific
    // site rather than about a scheme, so they stay with the prefix check.
    .map((prefix) => /^([a-z][a-z0-9+.-]*):(?:\/\/)?$/.exec(prefix.toLowerCase()))
    .filter(Boolean)
    .map((m) => `${m[1]}:`)
)

/**
 * A C0 control or DEL anywhere in an address, refused outright: the URL parser
 * deletes ASCII tab, LF and CR wherever they appear, including inside the
 * scheme, so "fi<TAB>le:///C:/x" parses as file: while matching no rule written
 * about the text "file:". The reasoning is on this constant in
 * shared/protocol.mjs.
 */
const URL_CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export function isRestrictedUrl(url) {
  if (typeof url !== 'string') return true
  if (URL_CONTROL_CHARS.test(url)) return true

  const u = url.trim().toLowerCase()
  if (u === '') return true
  if (RESTRICTED_URL_PREFIXES.some((p) => u.startsWith(p.toLowerCase()))) return true
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(u)
  return scheme ? RESTRICTED_SCHEMES.has(`${scheme[1]}:`) : false
}

/* -------------------------------------------------------------------------- */
/* openOrFocus: one page, one tab, at the far right                            */
/* -------------------------------------------------------------------------- */

/**
 * The file extensions openOrFocus will accept behind a `file:` URL.
 *
 * THIS IS THE ONLY CARVE-OUT FROM RESTRICTED_URL_PREFIXES IN THE SYSTEM, so the
 * reasoning belongs where the rule is.
 *
 * `file:` is refused everywhere else because navigate is WRITE tier and readPage
 * is READ tier, so without the refusal the two compose into an unarmed
 * local-file read primitive: point a tab at file:///.../secrets.env, then read
 * it back. openOrFocus exists to put a GENERATED PAGE in front of the human who
 * asked for it, and those pages are local HTML files, so a blanket refusal would
 * make the capability useless for the one job it has.
 *
 * The carve-out is therefore exactly as wide as that job and no wider: a `file:`
 * URL whose path ends in .html or .htm. Every other local file keeps its
 * refusal, which is what stops the read primitive from coming back: there is no
 * arbitrary local file to aim a tab at.
 *
 * Two further limits are worth stating next to the rule rather than only in
 * SECURITY.md. Chromium refuses content-script injection into `file:` URLs
 * unless the operator turns on this extension's "Allow access to file URLs"
 * toggle, which nothing in this repository requests, sets or asks for, so
 * readPage against such a tab fails on a default install. And the audit log
 * records origin only, which for a `file:` URL is the scheme and an opaque
 * marker: the path of a page opened this way never reaches the log.
 */
export const LOCAL_PAGE_EXTENSIONS = Object.freeze(['.html', '.htm'])

/**
 * True for a `file:` URL that points at a local HTML page, and nothing else.
 *
 * Four refusals below are not defensive padding. Each one is a way a string
 * that ENDS IN .html names something that is not a local HTML page, and each
 * would quietly widen the one carve-out this system has.
 */
export function isLocalPageUrl(url) {
  if (typeof url !== 'string') return false
  const trimmed = url.trim()
  if (!/^file:\/\//i.test(trimmed)) return false
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }

  // A `file:` URL with a HOST is a network path, not a local file:
  // file://server/share/page.html makes Windows open an SMB connection to
  // `server`, which is an outbound credential-carrying fetch wearing a local
  // page's clothes. Nothing legitimate needs it here, because the whole point
  // of this operation is showing a file that is already on the machine.
  if (parsed.host !== '') return false

  // Judge the DECODED path: %2E%68%74%6D%6C is the same file as .html, and a
  // rule that only reads the raw form would refuse a legitimate page while a
  // percent-encoded one sailed past a check written the other way round.
  let decoded = parsed.pathname
  try {
    decoded = decodeURIComponent(parsed.pathname)
  } catch {
    /* a malformed escape widens nothing: judge the raw path instead */
  }
  const path = decoded.replace(/\\/g, '/')

  // file:////server/share/page.html reaches the same network share with an
  // empty host, so the leading double slash is refused as well.
  if (path.startsWith('//')) return false

  // A control character, and a NUL in particular, is a truncation attack: the
  // rule reads ".../secrets.env\0.html" and the filesystem opens secrets.env.
  if (/[ -]/.test(path)) return false

  const lower = path.toLowerCase()

  // An NTFS alternate data stream, "secrets.env:page.html", ends in .html while
  // naming a completely different file. The only colon a local path may carry
  // is the drive letter's.
  if (lower.replace(/^\/[a-z]:/, '').includes(':')) return false

  return LOCAL_PAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * The URLs openOrFocus may OPEN or RELOAD: anything navigable, plus a local
 * HTML page. The carve-out it draws is exactly .html and .htm.
 */
export function isOpenOrFocusUrl(url) {
  if (isLocalPageUrl(url)) return true
  return !isRestrictedUrl(url)
}

/** What openOrFocus is allowed to do with the address it was handed. */
export const OPEN_OR_FOCUS_MODE = Object.freeze({
  FULL: 'full',
  FIND_ONLY: 'find-only',
})

/**
 * Which of the two modes an address gets, or null when it is refused outright.
 *
 * FIND_ONLY covers the local files that are not .html or .htm: the operation may
 * find a tab by its address and move it, and must never open or reload one.
 * Finding and moving performs no navigation and no read, so it cannot be half of
 * the navigate-then-read composition the `file:` refusal exists to prevent, and
 * READ-tier listTabs already reports every tab's address. The full reasoning is
 * on this function in shared/protocol.mjs.
 */
export function openOrFocusMode(url) {
  if (typeof url !== 'string') return null
  if (URL_CONTROL_CHARS.test(url)) return null
  const trimmed = url.trim()
  // An address the URL parser refuses is refused here rather than handed to
  // chrome.tabs.create to throw at.
  try {
    new URL(trimmed)
  } catch {
    return null
  }
  if (isOpenOrFocusUrl(trimmed)) return OPEN_OR_FOCUS_MODE.FULL
  if (/^file:/i.test(trimmed)) return OPEN_OR_FOCUS_MODE.FIND_ONLY
  return null
}

/**
 * How a tab's address matched the one openOrFocus was asked for, best first.
 *
 * SAME_FILE_NAME is off unless the caller asks for it, because two git
 * worktrees hold the same file name under different folders and they are
 * routinely DIFFERENT versions of the page. Reusing across them silently
 * would show a human yesterday's document and call it today's.
 */
export const OPEN_OR_FOCUS_MATCH = Object.freeze({
  EXACT: 'exact',
  SAME_PAGE: 'same-page',
  SAME_FILE_NAME: 'same-file-name',
})

/** Best first. The planner only ever acts on the best tier present. */
const MATCH_RANK = Object.freeze([
  OPEN_OR_FOCUS_MATCH.EXACT,
  OPEN_OR_FOCUS_MATCH.SAME_PAGE,
  OPEN_OR_FOCUS_MATCH.SAME_FILE_NAME,
])

/**
 * The comparable parts of a URL, or null when it is not a URL at all.
 *
 * `file:` paths are lowercased and backslashes folded, because Windows paths
 * are case-insensitive and reach this code in both spellings: the same page
 * arrives as C:/work/x.html from one caller and c:\work\x.html from another, and
 * a comparison that called those two different pages would open a second tab
 * for a page already on screen, which is the whole defect this capability
 * exists to fix. Nothing else is case-folded: an http path genuinely is
 * case-sensitive.
 */
function comparableUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return null
  let u
  try {
    u = new URL(url.trim())
  } catch {
    return null
  }
  const isFile = u.protocol === 'file:'
  let pathname = u.pathname
  try {
    pathname = decodeURIComponent(pathname)
  } catch {
    /* keep the raw form rather than failing the comparison */
  }
  if (isFile) pathname = pathname.replace(/\\/g, '/').toLowerCase()
  return {
    protocol: u.protocol.toLowerCase(),
    host: u.host.toLowerCase(),
    pathname,
    search: u.search,
    hash: u.hash,
    isFile,
    fileName: pathname.slice(pathname.lastIndexOf('/') + 1),
  }
}

/**
 * Does `tabUrl` show the page `targetUrl` names?
 *
 * @param {string} targetUrl
 * @param {string} tabUrl
 * @param {{allowFileName?: boolean}} [opts]
 * @returns {string|null} one of OPEN_OR_FOCUS_MATCH, or null for no match
 */
export function openOrFocusMatch(targetUrl, tabUrl, { allowFileName = false } = {}) {
  const a = comparableUrl(targetUrl)
  const b = comparableUrl(tabUrl)
  if (!a || !b) return null
  if (a.protocol !== b.protocol || a.host !== b.host) return null
  if (a.pathname === b.pathname) {
    return a.search === b.search && a.hash === b.hash
      ? OPEN_OR_FOCUS_MATCH.EXACT
      : OPEN_OR_FOCUS_MATCH.SAME_PAGE
  }
  if (allowFileName && a.isFile && b.isFile && a.fileName !== '' && a.fileName === b.fileName) {
    return OPEN_OR_FOCUS_MATCH.SAME_FILE_NAME
  }
  return null
}

/**
 * Decide what openOrFocus should DO, with no browser anywhere near it.
 *
 * Kept pure and in the contract on purpose. The extension executes this plan
 * and the tests prove it, so the rule that decides whether a human's tab gets
 * closed is checked without driving a browser - which is the only way that rule
 * gets checked often enough to stay true.
 *
 * @param {object} spec
 * @param {string} spec.url                        the page being asked for
 * @param {Array<{tabId:number,url:string,windowId:number,index:number,active:boolean,pinned:boolean}>} spec.tabs
 * @param {number|null} [spec.lastFocusedWindowId] the profile's most recently focused window
 * @param {boolean} [spec.allowFileName]           allow the SAME_FILE_NAME tier
 * @param {number[]} [spec.openedByUs]             tab ids this capability opened
 * @returns {{action:'open',windowId:number|null}
 *          |{action:'reuse',match:string,keeper:object,close:object[],kept:object[]}}
 */
export function planOpenOrFocus({
  url,
  tabs = [],
  lastFocusedWindowId = null,
  allowFileName = false,
  openedByUs = [],
}) {
  const ours = new Set(openedByUs)
  const matches = []
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (!tab || !Number.isInteger(tab.tabId)) continue
    const match = openOrFocusMatch(url, tab.url, { allowFileName })
    if (match) matches.push({ ...tab, match })
  }
  if (matches.length === 0) {
    return { action: 'open', windowId: Number.isInteger(lastFocusedWindowId) ? lastFocusedWindowId : null }
  }

  const best = MATCH_RANK.find((rank) => matches.some((t) => t.match === rank))
  const atBest = matches.filter((t) => t.match === best)
  const keeper = pickKeeper(atBest, lastFocusedWindowId)
  const rest = matches.filter((t) => t.tabId !== keeper.tabId)

  // The ledger is the ONLY thing that may authorize a close. A tab the operator
  // opened themselves is left exactly where it is, whatever it is showing: the
  // cost of an extra tab is nothing and the cost of closing someone's work is
  // unrecoverable.
  return {
    action: 'reuse',
    match: best,
    keeper,
    close: rest.filter((t) => ours.has(t.tabId)),
    kept: rest.filter((t) => !ours.has(t.tabId)),
  }
}

/**
 * Which matching tab survives: the one in the window the operator used last,
 * preferring the one they are actually looking at, and falling back to the
 * lowest tab id so that repeated calls converge on ONE tab instead of walking
 * across the duplicates.
 */
function pickKeeper(candidates, lastFocusedWindowId) {
  const inFocused = Number.isInteger(lastFocusedWindowId)
    ? candidates.filter((t) => t.windowId === lastFocusedWindowId)
    : []
  const pool = inFocused.length > 0 ? inFocused : candidates
  const active = pool.filter((t) => t.active === true)
  const ranked = (active.length > 0 ? active : pool).slice().sort((x, y) => x.tabId - y.tabId)
  return ranked[0]
}

/**
 * The one line openOrFocus answers with, built from the result so the MCP tool,
 * the command line and the extension all say the same sentence about the same
 * action. A caller that wants the profile in front of it prefixes its own.
 */
export function describeOpenOrFocus(result) {
  if (!result || typeof result !== 'object') return 'openOrFocus returned nothing.'
  const where = Number.isInteger(result.windowId) ? ` of window ${result.windowId}` : ''

  if (result.action === 'opened') {
    return `Opened a new tab at index ${result.toIndex}${where}, the far right of that window.`
  }

  const parts = []
  parts.push(
    result.match === OPEN_OR_FOCUS_MATCH.EXACT
      ? 'Reused the tab already showing it'
      : `Reused a tab showing it (matched ${result.match})`
  )
  if (result.pinned) parts.push(`left at index ${result.toIndex}${where} because that tab is pinned`)
  else if (result.moved) parts.push(`moved from index ${result.fromIndex} to ${result.toIndex}${where}`)
  else parts.push(`already at index ${result.toIndex}${where}`)
  if (result.mode === OPEN_OR_FOCUS_MODE.FIND_ONLY) {
    parts.push('not reloaded, because only a local .html or .htm page may be opened or reloaded')
  } else {
    parts.push(result.reloaded ? 'reloaded' : 'not reloaded')
  }
  if (result.closed > 0) {
    parts.push(`closed ${plural(result.closed, 'duplicate')} this capability had opened`)
  }
  if (result.kept > 0) {
    parts.push(`left ${plural(result.kept, 'other matching tab')} alone, not opened by this capability`)
  }
  if (result.activated) parts.push('brought to the front')
  return `${parts.join(', ')}.`
}

function plural(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/**
 * The one line an extension reload answers with. Mirrored so the extension, the
 * MCP tool and the command line say the same sentence. `verified` is false until
 * the profile has come back on a different version, because the acknowledgement
 * necessarily leaves before the reload happens.
 */
export function describeExtensionReload({
  profile = null,
  from = null,
  to = null,
  verified = false,
  waitedMs = null,
} = {}) {
  const who = profile ? `${profile}: ` : ''
  const was = from || 'an unreported version'
  const now = to || 'the installed version'
  if (verified) {
    const took = Number.isFinite(waitedMs)
      ? `, back on the bridge in ${(Math.round(waitedMs / 100) / 10).toFixed(1)}s`
      : ''
    return `${who}reloaded the extension, ${was} to ${now}${took}.`
  }
  return (
    `${who}asked the extension to reload itself, ${was} to ${now}. It drops off the bridge for a ` +
    'moment and comes back on the new code; the profile list is what confirms it.'
  )
}

/* -------------------------------------------------------------------------- */
/* sortWindow: oldest on the left, newest on the right                         */
/* -------------------------------------------------------------------------- */

/** Where a tab's age came from, best first. */
export const AGE_SOURCE = Object.freeze({
  GIVEN: 'given',
  LEDGER: 'ledger',
  LAST_ACCESSED: 'lastAccessed',
  NONE: 'none',
})

/** Chrome's id for "not in a group" and for "not in a split view". */
const NONE_ID = -1

function positiveTime(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function inGroup(tab) {
  return Number.isInteger(tab.groupId) && tab.groupId !== NONE_ID
}

function inSplit(tab) {
  return Number.isInteger(tab.splitViewId) && tab.splitViewId !== NONE_ID
}

/** The unit a tab moves with: its group, else its split view, else itself. */
function unitKeyOf(tab) {
  if (inGroup(tab)) return `g${tab.groupId}`
  if (inSplit(tab)) return `s${tab.splitViewId}`
  return `t${tab.tabId}`
}

/** A tab's age and where it came from, best first. */
function tabAge(tab, ages, opened) {
  const given = positiveTime(ages[tab.tabId])
  if (given !== null) return { age: given, source: AGE_SOURCE.GIVEN }
  const ledger = positiveTime(opened[tab.tabId])
  if (ledger !== null) return { age: ledger, source: AGE_SOURCE.LEDGER }
  const shown = positiveTime(tab.lastAccessed)
  if (shown !== null) return { age: shown, source: AGE_SOURCE.LAST_ACCESSED }
  return { age: null, source: AGE_SOURCE.NONE }
}

function compareUnits(a, b) {
  const x = a.age === null ? Infinity : a.age
  const y = b.age === null ? Infinity : b.age
  if (x !== y) return x < y ? -1 : 1
  return a.minTabId - b.minTabId
}

/**
 * Plan one window's sort by age, with no browser anywhere near it.
 *
 * Kept pure and in the contract for the reason planOpenOrFocus is: the rule
 * that rearranges a person's tab strip is checked by tests, not by driving a
 * browser.
 *
 * The strip is cut into UNITS that move as one: a tab group (all its tabs, in
 * their own order), a split view outside a group, or a single tab. Pinned tabs
 * are not units. They stay where they are, which is the left edge, because the
 * browser keeps every pinned tab ahead of every unpinned one anyway. A unit's
 * age is its OLDEST tab's age, so a group sits where its oldest tab belongs.
 *
 * A tab's age, best first: a time the caller gave for it (an agent that knows
 * when the tab was really opened), the open time the extension recorded when
 * the tab was created, or the last time the tab was shown (`lastAccessed`,
 * Chrome 121 and later). That last one equals the open time for a tab opened
 * and never revisited, and is later than it for any other, so an old tab looked
 * at recently sorts as newer than it is. A unit with no age at all sorts to the
 * right, in tab id order.
 *
 * The moves: every unit after the longest leading run already in place goes to
 * the end of the window, in order. A sorted window is zero moves, and the
 * result never depends on index arithmetic, which is where tab sorters go wrong
 * as tabs shift underneath them.
 *
 * @param {object} spec
 * @param {Array<{tabId:number,index:number,pinned?:boolean,groupId?:number,splitViewId?:number,lastAccessed?:number}>} spec.tabs  one window's tabs
 * @param {Object<string,number>} [spec.ages]    tab id to epoch ms, given by the caller
 * @param {Object<string,number>} [spec.opened]  tab id to epoch ms, from the open-time ledger
 * @returns {{units:object[], moves:object[], pinned:number, sources:Object<string,number>}}
 */
export function planWindowSort({ tabs = [], ages = {}, opened = {} } = {}) {
  const given = ages && typeof ages === 'object' ? ages : {}
  const ledger = opened && typeof opened === 'object' ? opened : {}
  const rows = (Array.isArray(tabs) ? tabs : [])
    .filter((t) => t && Number.isInteger(t.tabId))
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))

  const sources = {
    [AGE_SOURCE.GIVEN]: 0,
    [AGE_SOURCE.LEDGER]: 0,
    [AGE_SOURCE.LAST_ACCESSED]: 0,
    [AGE_SOURCE.NONE]: 0,
  }
  const byKey = new Map()
  const current = []
  let pinned = 0

  for (const tab of rows) {
    if (tab.pinned) {
      pinned += 1
      continue
    }
    const { age, source } = tabAge(tab, given, ledger)
    sources[source] += 1
    const key = unitKeyOf(tab)
    let unit = byKey.get(key)
    if (!unit) {
      unit = {
        key,
        kind: key[0] === 'g' ? 'group' : key[0] === 's' ? 'split' : 'tab',
        groupId: inGroup(tab) ? tab.groupId : null,
        tabIds: [],
        age: null,
        minTabId: tab.tabId,
      }
      byKey.set(key, unit)
      current.push(unit)
    }
    unit.tabIds.push(tab.tabId)
    if (age !== null && (unit.age === null || age < unit.age)) unit.age = age
    if (tab.tabId < unit.minTabId) unit.minTabId = tab.tabId
  }

  const units = current.slice().sort(compareUnits)
  let inPlace = 0
  while (inPlace < units.length && units[inPlace] === current[inPlace]) inPlace += 1
  return { units, moves: units.slice(inPlace), pinned, sources }
}

/**
 * The one line a sort answers with, so the MCP tool and the popup say the same
 * sentence about the same result.
 *
 * @param {{windows?: Array<{tabs:number,moved:number,pinned:number,failed?:number,sources?:object}>}} result
 */
export function describeWindowSort(result) {
  const windows = result && Array.isArray(result.windows) ? result.windows : []
  if (windows.length === 0) return 'There was no window to sort.'
  const sum = (pick) => windows.reduce((n, w) => n + (Number(pick(w)) || 0), 0)
  const tabs = sum((w) => w.tabs)
  const moved = sum((w) => w.moved)
  const pinned = sum((w) => w.pinned)
  const failed = sum((w) => w.failed)
  const from = (key) => sum((w) => (w.sources ? w.sources[key] : 0))

  const where = windows.length === 1 ? 'the window' : `${windows.length} windows, each on its own,`
  const parts = [
    `Sorted ${where} oldest on the left to newest on the right: ${plural(tabs, 'tab')}, ${moved === 0 ? 'nothing needed moving' : `${plural(moved, 'block')} moved`}`,
  ]
  if (pinned > 0) parts.push(`${plural(pinned, 'pinned tab')} left where ${pinned === 1 ? 'it was' : 'they were'}`)
  if (failed > 0) parts.push(`${plural(failed, 'block')} could not be moved (closed or changed mid-sort)`)
  const ages = []
  if (from(AGE_SOURCE.GIVEN) > 0) ages.push(`${from(AGE_SOURCE.GIVEN)} given by the caller`)
  if (from(AGE_SOURCE.LEDGER) > 0) ages.push(`${from(AGE_SOURCE.LEDGER)} from the recorded open time`)
  if (from(AGE_SOURCE.LAST_ACCESSED) > 0) ages.push(`${from(AGE_SOURCE.LAST_ACCESSED)} from when the tab was last shown`)
  if (from(AGE_SOURCE.NONE) > 0) ages.push(`${from(AGE_SOURCE.NONE)} with no age, placed at the right`)
  const tail = ages.length > 0 ? ` Ages: ${ages.join(', ')}.` : ''
  return `${parts.join(', ')}.${tail}`
}

/* -------------------------------------------------------------------------- */
/* Password and one-time-code fields                                           */
/* -------------------------------------------------------------------------- */

const SECRET_AUTOCOMPLETE = Object.freeze(['new-password', 'current-password', 'one-time-code'])
const SECRET_WORDS = new Set(['password', 'passwd', 'pwd', 'passcode', 'passphrase', 'pin', 'otp', 'totp', 'hotp', 'mfa', '2fa', 'onetime'])
const SECRET_PHRASES = Object.freeze([
  /\bone time\b/,
  /\bverification code\b/,
  /\bsecurity code\b/,
  /\bauth(?:entication)? code\b/,
])

/** "newPassword", "user_pwd" and "One-time code" become lowercase words. */
function fieldWords(text) {
  return String(text || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * Does this field take a password or a one-time code?
 *
 * Judged from what the page says about the field, which only the page knows:
 * `type="password"`, an `autocomplete` of new-password, current-password or
 * one-time-code, or a name, id or label that says password, passcode, PIN, OTP,
 * 2FA, MFA, one-time, verification code or security code. A custom field that
 * draws its own dots is a text input with a label, which is why the label
 * counts as much as the type. Focus inside another site's frame cannot be read
 * at all (`opaque`), and a field the bridge cannot see counts as one that may
 * take a password.
 *
 * @param {{type?:string, autocomplete?:string, name?:string, id?:string, label?:string}} field
 */
export function isSecretField(field) {
  if (!field || typeof field !== 'object') return false
  if (field.opaque === true) return true
  if (String(field.type || '').toLowerCase() === 'password') return true
  const auto = String(field.autocomplete || '').toLowerCase().split(/\s+/)
  if (auto.some((token) => SECRET_AUTOCOMPLETE.includes(token))) return true
  for (const text of [field.name, field.id, field.label]) {
    const words = fieldWords(text)
    if (words.some((w) => SECRET_WORDS.has(w) || w.startsWith('password'))) return true
    const spaced = words.join(' ')
    if (SECRET_PHRASES.some((rx) => rx.test(spaced))) return true
  }
  return false
}

/**
 * Does a service named in a recorded yes name this host?
 *
 * A service with a dot is a domain and matches itself and its subdomains. One
 * without is a name and matches a whole label of the host: "ledgerly" matches
 * accounts.ledgerly.example and never ledgerlyish.example.
 */
export function serviceNamesHost(service, host) {
  const s = String(service || '').toLowerCase().replace(/\.+$/, '')
  const h = String(host || '').toLowerCase().replace(/\.+$/, '')
  if (!s || !h) return false
  if (s.includes('.')) return h === s || h.endsWith(`.${s}`)
  return h.split('.').includes(s)
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname
  } catch {
    return ''
  }
}

const SECRET_REFUSED =
  'This field takes a password or a one-time code (or sits inside another site\'s frame, where the bridge ' +
  'cannot tell), so the bridge refused to type into it. ' +
  'A password is typed by a person, or by an agent session that carries a recorded yes for this site ' +
  '(the account-word receipt described in SECURITY.md).'

/**
 * The guard on a fill or key press into a password or one-time-code field.
 *
 * `grant` is what the BROKER read from the receipt the caller named: the
 * receipt's file name, the services its recorded yes names, or the problem
 * that stopped it. The broker writes it and strips any copy the caller sent, so
 * the only way to hold one is a receipt file the broker could read. The
 * extension decides with it here, because only the page knows what the field
 * is.
 *
 * @param {object} spec
 * @param {object} spec.field   what the page said about the field (isSecretField)
 * @param {{file?:string, services?:string[], problem?:string}|null} [spec.grant]
 * @param {string} [spec.url]   the tab's address, judged by its host only
 * @returns {{allowed:boolean, secret:boolean, receipt:string|null, message?:string}}
 */
export function secretFieldVerdict({ field, grant = null, url = '' } = {}) {
  if (!isSecretField(field)) return { allowed: true, secret: false, receipt: null }
  if (!grant || typeof grant !== 'object') {
    return { allowed: false, secret: true, receipt: null, message: `${SECRET_REFUSED} This call carried none.` }
  }
  const file = typeof grant.file === 'string' && grant.file ? grant.file : 'the receipt'
  if (grant.problem) {
    return { allowed: false, secret: true, receipt: null, message: `${SECRET_REFUSED} ${file} does not count: ${grant.problem}` }
  }
  const host = hostOf(url)
  const services = (Array.isArray(grant.services) ? grant.services : []).filter((s) => typeof s === 'string' && s)
  if (services.some((s) => serviceNamesHost(s, host))) return { allowed: true, secret: true, receipt: file }
  return {
    allowed: false,
    secret: true,
    receipt: null,
    message:
      `${SECRET_REFUSED} The recorded yes in ${file} names ${services.length > 0 ? services.join(', ') : 'no service'}, ` +
      `not this site (${host || 'an address with no host'}).`,
  }
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
