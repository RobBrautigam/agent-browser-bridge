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
  OPEN_OR_FOCUS: 'openOrFocus',
  CLOSE_TAB: 'closeTab',
  ACTIVATE_TAB: 'activateTab',
  CLICK: 'click',
  FILL: 'fill',
  PRESS_KEYS: 'pressKeys',
  WAIT_FOR: 'waitFor',
  EVAL_JS: 'evalJs',
  RELOAD_EXTENSION: 'reloadExtension',
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
  [OPS.OPEN_OR_FOCUS]: TIER.WRITE,
  [OPS.CLOSE_TAB]: TIER.WRITE,
  [OPS.ACTIVATE_TAB]: TIER.WRITE,
  [OPS.CLICK]: TIER.WRITE,
  [OPS.FILL]: TIER.WRITE,
  [OPS.PRESS_KEYS]: TIER.WRITE,
  [OPS.WAIT_FOR]: TIER.WRITE,

  // The one WRITE op that touches no page. It changes the BRIDGE: it asks one
  // profile's extension to reload itself, which is how a new release reaches a
  // browser without a human clicking Reload on the extensions page.
  //
  // WRITE rather than ARMED because a release that needed arming would need
  // the human it exists to save, and rather than META because META means
  // "never leaves the broker" and this one does. What bounds it is not a tier:
  // the broker refuses it unless the folder on disk holds a different version
  // from the one that profile is running, so it cannot be used as a way to kick
  // an extension, drop another session's tab handles, or make the bridge forget
  // which tabs it opened.
  [OPS.RELOAD_EXTENSION]: TIER.WRITE,

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
  OPS.OPEN_OR_FOCUS,
  OPS.CLOSE_TAB,
  OPS.ACTIVATE_TAB,
  OPS.CLICK,
  OPS.FILL,
  OPS.PRESS_KEYS,
  OPS.WAIT_FOR,
  OPS.EVAL_JS,
  OPS.RELOAD_EXTENSION,
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
/**
 * The same refusals, judged as SCHEMES rather than as text prefixes.
 *
 * Derived from the list above rather than written out again, so the two can
 * never disagree about which schemes are refused.
 *
 * This exists because a prefix rule is a rule about SLASHES, and the number of
 * slashes in a URL is not load-bearing. `file:` is a special scheme in the URL
 * Standard, so `file:/C:/Users/someone/.env` and `file:\\\\server\\share\\x` both
 * normalize to ordinary `file://` URLs that Chromium navigates to happily, and
 * neither one starts with the seven characters `file://`. Checked against a
 * real browser before this was written: `browser_navigate` accepted the
 * one-slash form, Chromium canonicalized it, and the tab rendered the local
 * file. That is the unarmed local-file primitive this refusal exists to
 * prevent, reachable by deleting two characters.
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
 * A C0 control or DEL anywhere in an address, which is refused outright.
 *
 * This is the rule that makes every other URL rule in this file mean what it
 * says. The URL parser DELETES ASCII tab, LF and CR from its input wherever they
 * appear, INCLUDING INSIDE THE SCHEME: "fi<TAB>le:///C:/Users/me/.env" parses as
 * an ordinary file: URL and matches no rule written about the text "file:", and
 * so does "ch<TAB>rome://settings". Found by the adversarial review of 0.4.0 and
 * reproduced in Node's own WHATWG parser, which implements the same
 * specification Chromium does.
 *
 * Nothing legitimate needs a raw control character in an address. A URL that
 * wants one percent-encodes it, and a percent-encoded one is not removed by the
 * parser and so cannot change the scheme.
 *
 * Applied to the RAW string, before any trim, and by openOrFocusMode as well, so
 * that no code path in this system is more permissive about the shape of an
 * address than any other.
 */
const URL_CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export function isRestrictedUrl(url) {
  if (typeof url !== 'string') return true
  if (URL_CONTROL_CHARS.test(url)) return true

  const u = url.trim().toLowerCase()
  if (u === '') return true
  if (RESTRICTED_URL_PREFIXES.some((p) => u.startsWith(p.toLowerCase()))) return true
  // A scheme this refuses, however many slashes follow it. An address with no
  // scheme at all is not refused here: it is not a destination this system ever
  // hands to a browser, and the operations that take a URL require an absolute
  // one.
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
 * HTML page. Unchanged, and deliberately so - this is the predicate SECURITY.md
 * documents, the broker enforces and the extension mirrors, and the carve-out it
 * draws is exactly .html and .htm.
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
 * FULL is the behavior 0.3.0 shipped: find the tab or open one, move it to the
 * far right of its window, reload it.
 *
 * FIND_ONLY exists for the local files that are NOT .html or .htm - a PDF a
 * report was exported to, an image, a CSV a session just wrote. In this mode the
 * operation may FIND a tab by its address and MOVE it, and may do nothing else:
 * it never opens a tab and never reloads one.
 *
 * WHY THAT IS NOT A WIDENING OF THE FILE RULE, which is the only question that
 * matters here. The `file:` refusal exists because navigate (WRITE) and readPage
 * (READ) compose into an unarmed local-file read primitive. Finding a tab and
 * moving it performs no navigation and no read, so it cannot be half of that
 * composition: there is no step at which a local file is fetched, rendered or
 * returned. The address is not new information either, because READ-tier
 * browser_list_tabs already reports the URL of every open tab. What stays
 * refused is the part that would matter - opening and reloading - so this system
 * still points a tab at no arbitrary local file, ever.
 *
 * The practical effect, and the reason it is worth the paragraph: a launcher can
 * call this for a PDF, be told "moved the tab you already have" when one exists,
 * and be told plainly to open the file itself when none does. One page, one tab,
 * without the carve-out growing by a single extension.
 *
 * @param {string} url
 * @returns {string|null} an OPEN_OR_FOCUS_MODE value, or null when refused
 */
export function openOrFocusMode(url) {
  if (typeof url !== 'string') return null
  // The character rule first, on the raw string, for the reason written on
  // URL_CONTROL_CHARS: a tab inside the scheme makes the text of an address lie
  // about what it parses to, and find-only must not be the one path that accepts
  // such a thing merely because the text begins with "file:".
  if (URL_CONTROL_CHARS.test(url)) return null
  const trimmed = url.trim()

  // An address the URL parser refuses is refused here, with a typed error rather
  // than whatever chrome.tabs.create throws at it. Several near-miss spellings of
  // a refused scheme land here and nowhere else: a full-width colon, an fi
  // ligature, a zero-width space, a space before the colon. None of them is a
  // scheme, so none of them is a destination.
  try {
    new URL(trimmed)
  } catch {
    return null
  }

  if (isOpenOrFocusUrl(trimmed)) return OPEN_OR_FOCUS_MODE.FULL
  // Every other `file:` form, including the four that end in .html while naming
  // something that is not a local page. They stay unopenable and unreloadable; a
  // tab already showing one may still be found and moved, because moving it does
  // nothing a tab list has not already done.
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
 * arrives as C:/dev/x.html from one caller and c:\dev\x.html from another, and
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
    // Say the RULE, not just the outcome. A caller that reads "not reloaded"
    // alone cannot tell whether the reload failed or was never allowed, and the
    // difference decides whether it should open the file itself.
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
 * May this profile's extension be told to reload itself?
 *
 * ONLY when the install folder holds a different version from the one the
 * profile is running. That single condition is what keeps a WRITE-tier
 * self-reload bounded, and it lives here, pure, for the same reason
 * planOpenOrFocus does: it is a rule worth checking on every commit rather than
 * a code path exercised by hand once.
 *
 * Only the BROKER can evaluate it, which is why the operation is gated there
 * rather than in the extension. An extension cannot see the folder it was
 * loaded from - getManifest() returns the manifest it is RUNNING, not the file
 * on disk - so it has no way to know whether there is new code to load.
 *
 * What the gate protects, because "why not just let it reload" is the obvious
 * question. A reload is not free. It clears chrome.storage.session, which holds
 * openOrFocus's opened-by-us ledger, so afterwards the bridge no longer knows
 * which tabs it opened and will never close them; and it re-registers the
 * profile, which bumps the generation and kills every outstanding tab handle in
 * every other agent session driving that browser. Once per release that is a
 * fair price for not making a human click. On demand it is a way to disrupt
 * other sessions and make the bridge forget its own tabs.
 *
 * @param {{label?:string, installed?:string|null, running?:string|null}} spec
 * @returns {{code:string, message:string}|null} null means allowed
 */
export function reloadRefusal({ label = 'that profile', installed = null, running = null } = {}) {
  if (!installed) {
    return {
      code: ERR.UNSUPPORTED,
      message:
        'Cannot read the extension manifest in the install folder, so there is no way to tell whether ' +
        `"${label}" is behind. Nothing was reloaded. Check that the folder the extension was loaded ` +
        'from still exists and that its manifest.json is readable.',
    }
  }
  if (!running) {
    return {
      code: ERR.UNSUPPORTED,
      message:
        `"${label}" did not report an extension version when it connected, so there is no way to tell ` +
        `whether it is behind version ${installed}. Nothing was reloaded. Reload that profile's ` +
        "extension from the browser's extensions page once and it will report one.",
    }
  }
  if (running === installed) {
    return {
      code: ERR.UNSUPPORTED,
      message:
        `"${label}" is already running version ${installed}, the same version the install folder holds, ` +
        'so a reload would load nothing new and was refused. A reload is only allowed when there is a ' +
        'new version on disk, because it costs every session driving this profile its open tab handles.',
    }
  }
  return null
}

/**
 * The one line an extension reload answers with, built here so the MCP tool and
 * the command line say the same sentence about the same action.
 *
 * `verified` is the difference that matters to whoever reads it. The request
 * itself only proves the extension was ASKED: a reload tears down the native
 * port it would have answered on, so the acknowledgement necessarily arrives
 * before the reload happens. Only the profile coming back on a different version
 * proves it landed, and a caller that can wait for that says so.
 *
 * @param {{profile?:string|null, from?:string|null, to?:string|null, verified?:boolean, waitedMs?:number|null}} spec
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
 * @property {string|null} extVersion the extension version this profile is
 *                                   RUNNING, as it reported on connect. An
 *                                   unpacked extension only picks up new code
 *                                   when it is reloaded, so this is routinely
 *                                   behind the folder on disk.
 * @property {boolean} needsReload   true when extVersion differs from the
 *                                   board's installedVersion, which is the one
 *                                   thing an operator can act on: reload that
 *                                   profile's extension.
 * @property {number|null} latencyMs last round-trip
 * @property {number|null} lastSeenAt epoch ms of last pong
 * @property {number|null} armedUntil epoch ms, null when not armed
 * @property {number}  opCount       operations served this broker lifetime
 * @property {string|null} lastOp
 * @property {string|null} warning   collision or misconfiguration notice
 *
 * @typedef {object} Board
 * @property {string}  product      PRODUCT_NAME
 * @property {string}  version      the version the BROKER is running
 * @property {string|null} installedVersion the extension version the install
 *                                  folder holds right now, re-read from the
 *                                  manifest rather than remembered, because the
 *                                  folder changes under a running broker every
 *                                  time someone pulls
 * @property {number}  startedAt    broker start, epoch ms
 * @property {number}  now          broker clock, epoch ms, so the UI never trusts its own
 * @property {boolean} panic
 * @property {Line[]}  lines
 * @property {Array<{at:number,profile:string,op:string,origin:string,ok:boolean}>} audit
 */

/** Build an empty board. Keeps the broker and the UI honest about required keys. */
export function emptyBoard(version = '0.0.0', now = Date.now(), installedVersion = version) {
  return {
    product: PRODUCT_NAME,
    version,
    installedVersion,
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
