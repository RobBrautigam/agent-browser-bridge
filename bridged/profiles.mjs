/**
 * The profile identity join.
 *
 * No Chromium API tells an extension which profile directory it is running in.
 * That is deliberate, for anti-tracking reasons, and Chrome's own answer to the
 * question is "generate a unique ID at install time and use that". So identity
 * is joined from two sides:
 *
 *   extension side  a stable `installId`, the vendor it believes it is, and on
 *                   Chrome the signed-in email
 *   broker side     `Local State` -> `profile.info_cache`, plus the vendor read
 *                   independently off the host's own process ancestry
 *
 * Three rules govern this file:
 *
 *   1. The extension's vendor claim is CORROBORATION, never the deciding vote.
 *      Brave documents `navigator.brave` as suppressible, so the broker walks
 *      the host process up to the browser that spawned it and reads that
 *      executable instead.
 *   2. A match is an EXACT match or it is not a match. Two plausible candidates
 *      produce an unclaimed route, never a coin flip. Unclaimed is a legitimate,
 *      visible state; a wrong guess is a wrong-identity action, which is the
 *      worst thing this system can do.
 *   3. A claim the operator made once is permanent. It is keyed by `installId` in
 *      state.json and always outranks any live inference.
 *
 * The only browser file read anywhere in the bridge is `Local State`, via
 * shared/paths.mjs, and only `profile.info_cache` from it.
 */

import { execFile } from 'node:child_process'

import {
  BROWSERS,
  IS_WINDOWS,
  STATE_FILE,
  allProfiles,
  browserByVendor,
  deriveLabel,
  readJson,
  readProfiles,
  writeJsonAtomic,
} from '../shared/paths.mjs'
import { LINK } from '../shared/protocol.mjs'

/**
 * Executable names that identify a browser we can serve, by platform.
 *
 * Windows reports `Name` from WMI (chrome.exe); macOS and Linux report the
 * `comm` column from ps, which is the binary's basename: "Google Chrome",
 * "Brave Browser", "Microsoft Edge" inside the app bundle on macOS, and
 * chrome / google-chrome / brave-browser / microsoft-edge on Linux, with the
 * channel suffixes those distributions use.
 *
 * Matching is EXACT on the lowercased name, never by substring. The ancestry
 * walk passes helper and wrapper processes on the way up, and a substring
 * test would stop at the first one whose name merely contains "chrome" or
 * "msedge" (a WebView2 host, a corporate launcher, "Google Chrome Helper")
 * and attribute the profile to the wrong process.
 */
const BROWSER_PROCESS_NAMES = new Map([
  // Windows
  ['chrome.exe', 'chrome'],
  ['brave.exe', 'brave'],
  ['msedge.exe', 'edge'],
  // macOS app bundles
  ['google chrome', 'chrome'],
  ['google chrome beta', 'chrome'],
  ['google chrome dev', 'chrome'],
  ['google chrome canary', 'chrome'],
  ['chromium', 'chrome'],
  ['brave browser', 'brave'],
  ['brave browser beta', 'brave'],
  ['brave browser nightly', 'brave'],
  ['microsoft edge', 'edge'],
  // Linux
  ['chrome', 'chrome'],
  ['google-chrome', 'chrome'],
  ['google-chrome-stable', 'chrome'],
  ['google-chrome-beta', 'chrome'],
  ['google-chrome-unstable', 'chrome'],
  ['chromium-browser', 'chrome'],
  ['brave', 'brave'],
  ['brave-browser', 'brave'],
  ['brave-browser-stable', 'brave'],
  ['brave-browser-beta', 'brave'],
  ['brave-browser-nightly', 'brave'],
  ['msedge', 'edge'],
  ['microsoft-edge', 'edge'],
  ['microsoft-edge-stable', 'edge'],
  ['microsoft-edge-beta', 'edge'],
  ['microsoft-edge-dev', 'edge'],
])

function vendorFromProcessName(name) {
  return BROWSER_PROCESS_NAMES.get(String(name || '').toLowerCase().trim()) || null
}

/**
 * How far up the process tree to look for the browser.
 *
 * On Windows the host is launched through a `.cmd` shim, so the real chain is
 * node.exe -> cmd.exe -> chrome.exe; on POSIX it is node -> sh -> the browser.
 * Six levels is generous headroom for a shim that grows another layer, and
 * bounded so a malformed ancestry cannot spin.
 */
const MAX_ANCESTRY = 6

/** One process-table query. A PowerShell start is roughly half a second; ps is faster. Cap it hard. */
const SNAPSHOT_TIMEOUT_MS = 4_000

/**
 * The vendor of a browser that could not be identified.
 *
 * A real value rather than null so nothing downstream has to branch on a
 * missing field, and deliberately not one of the BROWSERS vendors so it can
 * never match a profile, a route key or a saved claim by accident.
 */
export const UNKNOWN_VENDOR = 'unknown'
const UNKNOWN_VENDOR_LABEL = 'Unknown browser'

const STATE_VERSION = 1

/* -------------------------------------------------------------------------- */
/* Durable state                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The installId -> label -> profile join, persisted across broker restarts and
 * reboots so the per-profile claims happen once, ever.
 *
 * `generation` lives here rather than in memory on purpose: it is what makes a
 * tab handle from a previous BROKER lifetime fail loudly instead of matching a
 * fresh route that happened to restart its counter at the same number.
 */
export class ProfileStore {
  #file
  #data

  constructor({ file = STATE_FILE } = {}) {
    this.#file = file
    this.#data = { version: STATE_VERSION, profiles: {} }
  }

  load() {
    const raw = readJson(this.#file, null)
    if (raw && typeof raw === 'object' && raw.profiles && typeof raw.profiles === 'object') {
      this.#data = { version: STATE_VERSION, profiles: raw.profiles }
    }
    return this
  }

  get file() {
    return this.#file
  }

  get(installId) {
    return this.#data.profiles[installId] || null
  }

  entries() {
    return Object.values(this.#data.profiles)
  }

  /** Merge a patch into one profile record and persist immediately. */
  remember(installId, patch) {
    const now = Date.now()
    const prev = this.#data.profiles[installId] || {
      installId,
      firstSeenAt: now,
      generation: 0,
      labelIsCustom: false,
      claimed: false,
    }
    const next = { ...prev, ...patch, installId }
    this.#data.profiles[installId] = next
    this.#save()
    return next
  }

  /**
   * Bump and persist the browser-session generation.
   *
   * Called on every register, on a claim, and on a rename, because all three
   * change what a tab handle means. Every outstanding handle is invalidated by
   * construction rather than by a sweep.
   */
  nextGeneration(installId) {
    const prev = this.get(installId)
    const generation = (Number(prev?.generation) || 0) + 1
    this.remember(installId, { generation })
    return generation
  }

  touch(installId) {
    if (!this.#data.profiles[installId]) return null
    return this.remember(installId, { lastSeenAt: Date.now() })
  }

  #save() {
    try {
      writeJsonAtomic(this.#file, this.#data)
    } catch {
      // Losing a state write costs the operator one re-claim; taking the
      // broker down over it would cost them every route.
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Vendor: read from the process tree, not from the extension's claim          */
/* -------------------------------------------------------------------------- */

function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        resolve(err ? null : String(stdout || '').trim())
      })
    } catch {
      resolve(null)
    }
  })
}

/**
 * One snapshot of every process, walked in Node afterwards.
 *
 * The obvious implementation queries one pid per level, but on Windows each
 * query is a fresh PowerShell start at roughly 700 ms, so a six-level walk
 * costs nearly five seconds - and it costs the MOST in the case where nothing
 * is found, which is exactly the case that must not stall a register. One
 * snapshot pays that start-up cost once. Measured on the reference machine:
 * about 0.9 s for the whole table against 4.8 s for a failed per-level walk.
 *
 * @returns {Promise<Map<number,{pid:number,ppid:number,name:string,exe:string,cmdline:string}>|null>}
 */
async function processSnapshot() {
  return IS_WINDOWS ? windowsSnapshot() : posixSnapshot()
}

async function windowsSnapshot() {
  const script =
    'Get-CimInstance Win32_Process | ' +
    'Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ' +
    'ConvertTo-Json -Compress -Depth 2'
  const out = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    SNAPSHOT_TIMEOUT_MS
  )
  if (!out) return null

  let rows
  try {
    rows = JSON.parse(out)
  } catch {
    return null
  }
  if (!Array.isArray(rows)) rows = [rows]

  const byPid = new Map()
  for (const row of rows) {
    const pid = Number(row?.ProcessId)
    if (!Number.isInteger(pid)) continue
    byPid.set(pid, {
      pid,
      ppid: Number(row?.ParentProcessId),
      name: typeof row?.Name === 'string' ? row.Name.toLowerCase() : '',
      exe: typeof row?.ExecutablePath === 'string' ? row.ExecutablePath : '',
      cmdline: typeof row?.CommandLine === 'string' ? row.CommandLine : '',
    })
  }
  return byPid
}

/**
 * The POSIX equivalent, from one `ps` call. `comm=` is the executable name and
 * `args=` the full command line, which is where `--user-data-dir` lives. Both
 * macOS and Linux ps accept this exact spelling.
 */
async function posixSnapshot() {
  const out = await run('ps', ['-axo', 'pid=,ppid=,comm=,args='], SNAPSHOT_TIMEOUT_MS)
  if (!out) return null
  return parsePsSnapshot(out)
}

/**
 * Parse `ps -axo pid=,ppid=,comm=,args=` output. Exported for the tests, which
 * feed it fixture text rather than running ps.
 *
 * The comm column can contain spaces on macOS ("Google Chrome"), so the line is
 * split on the two leading integers and the remainder is searched for the
 * point where args begins: args always starts with the executable path or
 * name, and comm is that path's basename, so comm ends where args begins.
 */
export function parsePsSnapshot(text) {
  const byPid = new Map()
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    const rest = m[3]
    // comm can contain spaces on macOS ("Brave Browser", "Google Chrome
    // Helper"), and args always begins with the executable's absolute path.
    // So comm is every token before the first one that starts with a slash,
    // and args is that token onward. A bare-name argv0 (no slash anywhere)
    // falls back to a one-word comm, which is what ps prints for it anyway.
    const tokens = rest.split(/\s+/)
    let name = tokens[0]
    let cmdline = rest
    for (let i = 1; i < Math.min(tokens.length, 8); i += 1) {
      if (tokens[i].startsWith('/')) {
        name = tokens.slice(0, i).join(' ')
        cmdline = tokens.slice(i).join(' ')
        break
      }
    }
    byPid.set(pid, {
      pid,
      ppid,
      name: name.toLowerCase(),
      exe: cmdline.split(/\s+--/)[0] || '',
      cmdline,
    })
  }
  return byPid
}

/**
 * A browser launched with an explicit `--user-data-dir` is not using the
 * default directory, and the route key contains that directory. Reading it off
 * the command line is the only way to get this right without guessing.
 */
function userDataDirFromCommandLine(cmdline) {
  if (typeof cmdline !== 'string') return null
  const m = /--user-data-dir=(?:"([^"]+)"|(\S+))/i.exec(cmdline)
  const value = m ? m[1] || m[2] : null
  return value ? value.replace(/[\\/]+$/, '') : null
}

/**
 * Walk from the host process up to the browser that spawned it.
 *
 * @param {number} pid the host's own pid, taken from its HELLO
 * @param {Map|null} [table] an already-taken snapshot, for the tests
 * @returns {Promise<{vendor:string,exe:string,userDataDir:string|null}|null>}
 */
export async function findBrowserProcess(pid, table = undefined) {
  if (!Number.isInteger(pid) || pid <= 0) return null

  const snapshot = table === undefined ? await processSnapshot() : table
  if (!snapshot) return null

  const seen = new Set()
  let current = pid
  for (let level = 0; level < MAX_ANCESTRY; level += 1) {
    if (seen.has(current)) return null // a recycled pid can close the loop
    seen.add(current)

    const info = snapshot.get(current)
    if (!info) return null

    const vendor = vendorFromProcessName(info.name)
    if (vendor) {
      return { vendor, exe: info.exe, userDataDir: userDataDirFromCommandLine(info.cmdline) }
    }
    if (!Number.isInteger(info.ppid) || info.ppid <= 0) return null
    current = info.ppid
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* The join                                                                    */
/* -------------------------------------------------------------------------- */

function sameDir(a, b) {
  if (!a || !b) return false
  return String(a).replace(/[\\/]+$/, '').toLowerCase() === String(b).replace(/[\\/]+$/, '').toLowerCase()
}

function normalizeVendor(hint) {
  const v = typeof hint === 'string' ? hint.trim().toLowerCase() : ''
  return BROWSERS.some((b) => b.vendor === v) ? v : null
}

/**
 * Exact-match a reported email against a candidate list.
 *
 * Two fields are checked, and both are exact string equality:
 *
 *   `email` is `info_cache.user_name`, which Chrome fills with the signed-in
 *   account. This is the deterministic Chrome path.
 *
 *   `name` is checked because Brave writes no Google identity at all and the operator
 *   named their three Brave profiles after the addresses they hold. When the
 *   extension can report an address on Brave, matching the profile NAME that
 *   is byte-for-byte that same address is not a guess and saves a claim click.
 *   When it cannot, this simply finds nothing and the route stays unclaimed,
 *   which is the documented Brave behavior.
 *
 * Anything other than exactly one hit means unclaimed.
 */
export function matchProfileByEmail(candidates, email) {
  if (typeof email !== 'string' || !email.includes('@')) return null
  const needle = email.trim().toLowerCase()
  const hits = candidates.filter(
    (c) =>
      (c.email && c.email.trim().toLowerCase() === needle) ||
      (c.name && c.name.trim().toLowerCase() === needle)
  )
  return hits.length === 1 ? hits[0] : null
}

/* -------------------------------------------------------------------------- */
/* Identity fingerprints: is this still the same person?                       */
/* -------------------------------------------------------------------------- */

/**
 * The source value the identity-changed check exports as its `source`.
 * A constant rather than a literal because three files branch on it.
 */
export const SOURCE_IDENTITY_CHANGED = 'identity-changed'

/** Prefix on every identity-drift warning, so the surfaces can find them. */
export const IDENTITY_CHANGED_PREFIX = 'Identity changed: '

function clean(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function normalizeEmail(value) {
  const v = clean(value)
  return v ? v.toLowerCase() : null
}

/**
 * A single string naming WHO is signed into a browser profile.
 *
 * Recorded once, at claim time, and compared against the live value afterwards.
 * That comparison is the only thing standing between "the operator signed their Brand
 * Alchemy profile into their personal mailbox" and the bridge posting as the wrong
 * person, because a claim is keyed by profile DIRECTORY and a directory does
 * not change when the account inside it does.
 *
 * Strict precedence, strongest evidence first:
 *
 *   gaia:   the Google account id from `info_cache.gaia_id`. The right primary
 *           key: it survives an email rename and no human can type it, so
 *           unlike a profile name it cannot be spoofed by renaming a profile.
 *   email:  the signed-in address, from disk or as the extension reports it.
 *   name:   the profile's display name. Brave's ONLY signal, and a weak one -
 *           it is cosmetic and user-set. See docs/DESIGN.md section 4.
 *
 * A NULL RETURN IS LOAD-BEARING AND MEANS "CANNOT CHECK". It must never be
 * treated as a mismatch. Brave returns null for a nameless profile, and Chrome
 * returns null for the seconds between a browser start and the flush of its
 * real `profile.info_cache`. A design that cries wolf on either gets switched
 * off, and an operator may run many sessions at once.
 */
export function identityFingerprint({ gaiaId, email, reportedEmail, profileName } = {}) {
  const gaia = clean(gaiaId)
  if (gaia) return `gaia:${gaia.toLowerCase()}`

  const address = clean(email) || clean(reportedEmail)
  if (address) return `email:${address.toLowerCase()}`

  const name = clean(profileName)
  if (name) return `name:${name.toLowerCase()}`

  return null
}

/** The evidence class a fingerprint was built from: 'gaia', 'email', 'name' or null. */
export function fingerprintKind(fingerprint) {
  if (typeof fingerprint !== 'string') return null
  const sep = fingerprint.indexOf(':')
  return sep > 0 ? fingerprint.slice(0, sep) : null
}

/** A fingerprint as a sentence fragment a human reads, never the raw string. */
export function describeFingerprint(fingerprint) {
  const kind = fingerprintKind(fingerprint)
  if (!kind) return 'an identity the bridge could not read'
  const value = fingerprint.slice(kind.length + 1)
  if (kind === 'gaia') return `Google account id ${value}`
  if (kind === 'email') return value
  return `the profile named "${value}"`
}

/**
 * Has the identity behind a claimed profile directory changed?
 *
 * Evidence is consulted STRONGEST FIRST, which is the ordering rule this
 * function lives or dies by:
 *
 *   0. The account id. When the claim recorded a `gaia:` fingerprint and the
 *      row carries a gaia id, that pair decides the question outright. Equal
 *      means the account is provably the same person, whatever any address
 *      says, so the detectors below never run: an email that disagrees is then
 *      a Google-side rename or a lag, and unclaiming a profile whose account id
 *      PROVES it is unchanged is the weakest signal overruling the strongest.
 *      Not equal means a real switch, named by the two account ids.
 *   1. The live email the extension reports disagreeing with the one on disk.
 *      This is what covers the roughly fifteen seconds Chrome takes to flush
 *      `info_cache`, in the cases rule 0 cannot answer (no saved account id, or
 *      a row that carries none).
 *   2. The claim-time fingerprint disagreeing with the current one.
 *
 * Everything else is CANNOT CHECK, reported as `checked: false`, and
 * cannot-check ALWAYS honors the claim:
 *
 *   - no row on disk for that directory at all (a browser that has written its
 *     stub `Local State` but not yet its profile cache)
 *   - no saved fingerprint (a claim made before fingerprints existed)
 *   - no current fingerprint (Brave with a nameless profile)
 *   - the two fingerprints built from DIFFERENT evidence classes. A saved
 *     `gaia:` against a current `name:` is one side holding evidence the other
 *     lacks, not two different people, and treating it as drift would unclaim
 *     the operator's working profiles on any morning where the flush lagged.
 *
 * `checked` exists because the CALLER needs the difference. A claim honored
 * because nothing could be read is not the same as a claim honored because the
 * identity was corroborated: the first must not re-derive a label from the
 * half-written row it just failed to read. See resolveIdentity.
 *
 * FRESHNESS IS EXPLICIT, NEVER POSITIONAL. `liveIsFresh` says whether
 * `reportedEmail` is newer than `row`, and only the caller knows:
 *
 *   register path    TRUE. The extension has just read the live browser and the
 *                    file on disk may be seconds behind it.
 *   heartbeat path   FALSE. The reported address has been sitting on the route
 *                    since that register, and the row was read a moment ago.
 *
 * Getting this wrong does not change WHETHER drift is reported, it changes
 * which account the sentence calls the new one - so on the heartbeat path the
 * old build named the new account as the old one and the old as the new.
 *
 * @param {object} input
 * @param {string|null} input.savedFingerprint recorded at claim time
 * @param {object|null} input.row              the current Local State row for that directory
 * @param {string|null} input.reportedEmail    what the extension says it is signed in as
 * @param {boolean} [input.liveIsFresh]        is reportedEmail newer than row?
 * @returns {{changed:boolean, checked:boolean, current:string|null, from:string|null, to:string|null, why:string|null}}
 */
export function identityDrift({
  savedFingerprint = null,
  row = null,
  reportedEmail = null,
  liveIsFresh = false,
} = {}) {
  const current = row
    ? identityFingerprint({
        gaiaId: row.gaiaId,
        email: row.email,
        reportedEmail,
        profileName: row.name,
      })
    : null

  const cannotCheck = { changed: false, checked: false, current, from: null, to: null, why: null }
  const unchanged = { changed: false, checked: true, current, from: null, to: null, why: null }
  if (!row) return cannotCheck

  // 0. The account id, which outranks everything below it.
  const savedGaia = fingerprintKind(savedFingerprint) === 'gaia' ? savedFingerprint : null
  const rowGaia = clean(row.gaiaId)
  if (savedGaia && rowGaia) {
    const nowGaia = `gaia:${rowGaia.toLowerCase()}`
    if (nowGaia === savedGaia) return unchanged
    // A raw Google account id is the RIGHT thing to compare on and the WRONG
    // thing to show a human: "now reports Google account id 100000000000000000002"
    // tells the operator nothing they can act on. Where the row also carries an address or
    // a profile name, say that too. The id stays in the sentence because it is
    // the evidence the decision was actually made on.
    const readable = normalizeEmail(row.email) || clean(row.name) || normalizeEmail(reportedEmail)
    return {
      changed: true,
      checked: true,
      current,
      from: describeFingerprint(savedGaia),
      to: readable
        ? `${describeFingerprint(nowGaia)}, which is signed in as ${readable}`
        : describeFingerprint(nowGaia),
      why: 'fingerprint',
    }
  }

  // 1. The extension reads the signed-in account from the live browser; Local
  // State is a file written some time ago. Which of the two is the NEW identity
  // is decided by liveIsFresh, not by which argument it arrived in.
  const live = normalizeEmail(reportedEmail)
  const disk = normalizeEmail(row.email)
  if (live && disk && live !== disk) {
    const [from, to] = liveIsFresh ? [disk, live] : [live, disk]
    return { changed: true, checked: true, current, from, to, why: 'email' }
  }
  // Two independent readings of the address that AGREE are a real corroboration
  // even when the fingerprints below cannot be compared.
  const corroborated = Boolean(live && disk)

  // 2. The claim-time fingerprint.
  if (!savedFingerprint || !current) return corroborated ? unchanged : cannotCheck
  if (fingerprintKind(savedFingerprint) !== fingerprintKind(current)) {
    return corroborated ? unchanged : cannotCheck
  }
  if (savedFingerprint === current) return unchanged

  return {
    changed: true,
    checked: true,
    current,
    from: describeFingerprint(savedFingerprint),
    to: describeFingerprint(current),
    why: 'fingerprint',
  }
}

/**
 * The account to SHOW on a line whose claim was just dropped.
 *
 * Display only, and it never feeds addressing: the profile directory is gone,
 * so nothing can be routed here whatever this returns. It exists because the
 * drifted line is the one row on the board where "which account is this now"
 * matters most, and nulling every field left it as the only line that answered
 * "none". Both drift paths call this, so both leave the same thing behind.
 *
 * `drift.to` is the identity the profile holds NOW - that is what the freshness
 * ordering above guarantees - and it is a plain address whenever the email
 * detector fired. Otherwise the row's own address is the best available, and
 * the reported one is the last resort.
 */
export function driftDisplayAccount(drift, { row = null, reportedEmail = null } = {}) {
  if (drift?.why === 'email' && drift.to) return drift.to
  return clean(row?.email) || clean(reportedEmail) || null
}

/**
 * Drop the durable half of a claim: the join AND the evidence behind it.
 *
 * Every path that stops honoring a claim goes through here, because the
 * fingerprint is the part that is easy to forget and expensive to leave. A
 * fingerprint that outlives its claim is a record of somebody who is no longer
 * being compared against anything, and the next register's trust-on-first-use
 * or auto-match then reasons from it.
 *
 * `extra` carries whatever the specific path also knows (an identityChanged
 * flag, a display account, a new label). Label fields are deliberately NOT
 * cleared here: which name an unclaimed line falls back to is the caller's
 * decision, and it differs between a dropped identity and a missing directory.
 */
export function forgetClaim(store, installId, extra = {}) {
  return store.remember(installId, {
    claimed: false,
    profileDir: null,
    profileName: null,
    email: null,
    hostedDomain: null,
    identityFingerprint: null,
    claimedAt: null,
    ...extra,
  })
}

/**
 * The sentence every surface shows when a claim is dropped for drift.
 *
 * It has to answer three questions in one breath: what the bridge thought this
 * line was, what it is now, and what the operator does about it.
 */
export function identityChangedWarning(drift) {
  // The email sentence is worded to be true on BOTH paths. At register time
  // `from` is the address on disk and `to` is the one the live browser reports;
  // on the heartbeat it is the other way round, because there the disk row is
  // the fresher of the two. "Last saw" is accurate either way, where "was
  // claimed as" would have been a guess about which reading was older.
  const wasSignedIn =
    drift?.why === 'email'
      ? `The bridge last saw this profile signed in as ${drift.from}, and it now reports ${drift.to}`
      : `this line was claimed as ${drift?.from}, and the browser profile now reports ${drift?.to}`
  return (
    `${IDENTITY_CHANGED_PREFIX}${wasSignedIn}. The bridge has unclaimed this line rather than act ` +
    'as the wrong person, so its old name no longer addresses anything. Claim it again in the ' +
    'options page.'
  )
}

/** Candidate list in the shape the board and the options page consume. */
function toCandidates(profiles) {
  return profiles.map((p) => ({ dir: p.dir, name: p.name, email: p.email }))
}

/**
 * Resolve everything the broker knows about one registering extension.
 *
 * @param {object} input
 * @param {string} input.installId
 * @param {number} [input.pid]        the host's pid, for the ancestry walk
 * @param {string} [input.vendorHint] what the extension believes it is
 * @param {string} [input.email]      signed-in account, Chrome only
 * @param {ProfileStore} input.store
 * @param {object|null} [input.browserProcess] a findBrowserProcess result the
 *   caller already has. The broker starts that walk at HELLO so its PowerShell
 *   cost overlaps the extension's own identity round trip. `undefined` means
 *   nobody has looked yet and this function should; `null` means somebody
 *   looked and found nothing, and looking again would only pay the cost twice.
 */
export async function resolveIdentity({ installId, pid, vendorHint, email, store, browserProcess }) {
  const warnings = []

  const proc = browserProcess === undefined ? await findBrowserProcess(pid) : browserProcess
  const hinted = normalizeVendor(vendorHint)
  const saved = store.get(installId)
  const savedVendor = saved?.claimed ? normalizeVendor(saved.vendor) : null

  /**
   * Vendor precedence, strongest evidence first:
   *   1. the process that spawned the host, read off the ancestry walk
   *   2. the extension's own claim, which is corroboration and nothing more
   *   3. the vendor attached to a claim the operator already made for this installId
   *   4. nothing - and nothing stays NOTHING
   *
   * Step 4 used to be `|| 'chrome'`. That default is how a Brave profile got
   * labeled and addressed as a Chrome one, and it fires easily: the ancestry
   * walk is a PowerShell start capped at four seconds and returns null on any
   * timeout or parse failure, so the fallback is a normal path, not an exotic
   * one. Guessing an identity is the single worst thing this file can do, so an
   * undetermined vendor is now carried as undetermined and the line stays
   * unclaimed until a human says otherwise.
   */
  const vendor = proc?.vendor || hinted || savedVendor || UNKNOWN_VENDOR
  const vendorVerified = Boolean(proc?.vendor)
  const vendorKnown = vendor !== UNKNOWN_VENDOR

  if (!vendorKnown) {
    warnings.push(
      'Vendor could not be determined from the process tree and the extension sent no hint, so ' +
        'this line is NOT assumed to be Chrome. Claim it in the options page, or reload the ' +
        'extension so it re-registers with a vendor.'
    )
  } else if (!vendorVerified) {
    warnings.push(
      hinted
        ? `Vendor not verified from the process tree; using the extension's own claim of ${hinted}.`
        : `Vendor not verified from the process tree; using the ${savedVendor} claim saved for this ` +
          'browser earlier.'
    )
  } else if (hinted && hinted !== proc.vendor) {
    // Worth saying out loud: the browser on disk disagrees with the extension.
    warnings.push(
      `The extension reported ${hinted} but the process that spawned the host is ${proc.vendor}. ` +
        'The process tree wins.'
    )
  }

  const browser = vendorKnown ? browserByVendor(vendor) : null
  const userDataDir = proc?.userDataDir || browser?.userDataDir || null
  const vendorLabel = browser?.label || (vendorKnown ? vendor : UNKNOWN_VENDOR_LABEL)

  // With no vendor there is no honest candidate list either: two browsers both
  // call a profile directory "Default", so offering every profile on the
  // machine would let a claim land on the wrong browser's "Default" - the exact
  // wrong-identity outcome this whole path exists to avoid.
  // One implementation, shared with the re-read path below, so registration and
  // a later claim can never be offered different candidate lists.
  const candidates = vendorKnown ? candidatesFor(vendor, userDataDir) : []

  const base = {
    installId,
    vendor,
    vendorLabel,
    vendorVerified,
    vendorKnown,
    userDataDir,
    candidates: toCandidates(candidates),
    // What the extension says it is signed in as, kept separately from the
    // `email` field below (which is what DISK says). The heartbeat re-check
    // needs the live value later, and the two disagreeing is one of the two
    // ways an account switch is caught.
    reportedEmail: typeof email === 'string' && email.includes('@') ? email : null,
    identityChanged: false,
    identityAdopted: null,
    // TRUE when a claim was honored WITHOUT the identity behind it being
    // corroborated - the flush window, a half-written row, an unreadable
    // `Local State`. The claim stands, but nothing downstream may re-derive a
    // label or an identity from what was read, because what was read is a
    // degraded snapshot of a browser that is still starting up.
    identityUnverified: false,
    // The verdict that dropped a claim, so the broker can say the same sentence
    // on the same terms rather than re-deriving one.
    drift: null,
    warnings,
  }

  // An undetermined vendor never auto-claims. Both routes below join on a
  // candidate list that is empty in that case, and inferring an identity from
  // an email while not knowing which BROWSER answered would be a guess wearing
  // a match's clothes.
  if (!vendorKnown) {
    return {
      ...base,
      profileDir: null,
      profileName: null,
      email: typeof email === 'string' && email.includes('@') ? email : null,
      hostedDomain: null,
      claimed: false,
      source: 'vendor-unknown',
    }
  }

  // The claim-time evidence, tracked as a local rather than read off `saved`
  // every time: the paths below FORGET it, and `saved` is a snapshot taken
  // before that, so a later reader of `saved.identityFingerprint` would be
  // reasoning from a record this call has already deleted.
  let claimFingerprint = saved?.identityFingerprint || null

  // 1. A claim the operator made once outranks everything - for as long as the profile
  //    is still the same person.
  //
  //    This used to match on the profile DIRECTORY NAME alone and never compare
  //    identities, which meant switching which Google account a profile was
  //    signed into was NEVER detected: the claim kept resolving, the label kept
  //    reading "chrome-acme-corp", and the next tool call acted as whoever
  //    was signed in now.
  if (saved?.claimed && saved.profileDir && saved.vendor === vendor) {
    const hit = candidates.find((c) => c.dir === saved.profileDir)

    // AN EMPTY CANDIDATE LIST IS "I COULD NOT READ", NOT "IT IS GONE".
    //
    // readProfiles() returns [] for an unreadable file, for unparseable JSON,
    // and for a `Local State` that has no `profile.info_cache` yet - which is
    // exactly what a Chromium browser has on disk for the first seconds of
    // every start. Treating that as a missing profile ran the drop path below,
    // and on Brave, where no email exists to re-claim by, one register inside
    // that window destroyed a claim until the operator clicked again. On the daily path.
    //
    // So the two cases are separated: an empty list honors the claim, changes
    // nothing and says nothing, while a list that was read and does not carry
    // the directory is a profile that genuinely went away.
    if (!hit && candidates.length === 0) {
      return {
        ...base,
        profileDir: saved.profileDir,
        // The persisted values are the only ones that exist right now. The row
        // they came from will be back a few seconds from now.
        profileName: saved.profileName ?? null,
        email: saved.email ?? null,
        hostedDomain: saved.hostedDomain ?? null,
        claimed: true,
        identityUnverified: true,
        source: 'state',
      }
    }

    if (hit) {
      const drift = identityDrift({
        savedFingerprint: claimFingerprint,
        row: hit,
        reportedEmail: base.reportedEmail,
        // The extension has just read the live browser, so on THIS path its
        // address is the newer of the two.
        liveIsFresh: true,
      })

      // (b) Both sides are readable and they name different people. DO NOT
      //     honor the claim.
      //
      //     Unclaiming is the mechanism, and it is deliberately blunt: an
      //     unclaimed route is relabeled <vendor>-unclaimed-<hex>, so the OLD
      //     label stops resolving entirely. The next tool call naming it fails
      //     with E_UNKNOWN_PROFILE listing the labels that do exist, and the
      //     model self-corrects in one turn while the operator gets a claim card asking
      //     which profile this now is. A LOUD FAILURE BEATS A SILENT WRONG
      //     ACTION, and one blunt mechanism closes five separate defects at
      //     once: the undetected account switch, the frozen custom label, the
      //     stale disk email reported as fact, a lost state.json, and a wrong
      //     claim that nothing ever re-checked.
      if (drift.changed) {
        // The stale fingerprint goes with the stale claim. Leaving it behind
        // would have the next register compare against an identity nobody
        // holds any more. The flag is written here as well as by the broker, so
        // the durable record is coherent on its own: a reader of state.json
        // never finds a dropped claim that does not say why it was dropped.
        forgetClaim(store, installId, { identityChanged: true })
        claimFingerprint = null
        warnings.push(identityChangedWarning(drift))
        return {
          ...base,
          profileDir: null,
          // Display only, and deliberately not null: this is the one line on
          // the board where "which account is this now" is the whole question.
          // The heartbeat drop leaves exactly the same two fields.
          profileName: hit.name || null,
          email: driftDisplayAccount(drift, { row: hit, reportedEmail: base.reportedEmail }),
          hostedDomain: null,
          claimed: false,
          identityChanged: true,
          drift,
          source: SOURCE_IDENTITY_CHANGED,
        }
      }

      // Trust on first use. A claim the operator made before fingerprints existed
      // carries none, so adopt whatever is signed in now, once. Existing
      // claims are correct today, which is what makes this safe - but it is a
      // decision made on the operator's behalf, so it is logged at WARN rather than
      // absorbed silently.
      let identityAdopted = null
      if (!claimFingerprint && drift.current) {
        identityAdopted = drift.current
        claimFingerprint = identityAdopted
        store.remember(installId, {
          identityFingerprint: identityAdopted,
          claimedAt: saved.claimedAt || Date.now(),
        })
      }

      // (a) Equal, or nothing to compare against. The normal path on every
      //     register, and it stays silent: a warning here would fire on every
      //     heartbeat of a healthy line.
      return {
        ...base,
        profileDir: hit.dir,
        profileName: hit.name,
        email: hit.email,
        hostedDomain: hit.hostedDomain,
        claimed: true,
        identityAdopted,
        // Honored, but say plainly whether anything actually corroborated it.
        identityUnverified: !drift.checked,
        source: 'state',
      }
    }

    // The list WAS read and this directory is not in it, which is a profile
    // that went away rather than a file that was not ready. The claim is
    // dropped, and its evidence goes with it: a fingerprint left behind here
    // would still be describing a directory nothing can reach.
    //
    // Read the directory name BEFORE dropping the claim. The name is the one
    // piece of information this warning exists to carry, and forgetClaim is
    // about to erase it. ProfileStore.remember happens to copy rather than
    // mutate, so this reads correctly today by luck rather than by design -
    // and a store that mutated would silently turn the sentence into
    // 'profile directory "null"', which is what a simplified test store
    // actually produced.
    const goneDir = saved.profileDir
    forgetClaim(store, installId)
    claimFingerprint = null
    warnings.push(
      `The saved claim points at profile directory "${goneDir}", which this browser no ` +
        'longer lists. Claim it again in the options page.'
    )
  }

  // 2. Exact identity match, no guessing.
  const matched = matchProfileByEmail(candidates, email)
  if (matched) {
    const fingerprint = identityFingerprint({
      gaiaId: matched.gaiaId,
      email: matched.email,
      profileName: matched.name,
    })

    // A fingerprint that OUTLIVED its claim still records who this line was
    // claimed as. When it names a different person than the row this address
    // just matched, an address match is not enough to re-claim on: the two
    // pieces of evidence disagree, and the line stays unclaimed until a human
    // settles it. Different evidence CLASSES are not a disagreement, for the
    // same reason they are not drift.
    const contradicted =
      Boolean(claimFingerprint) &&
      Boolean(fingerprint) &&
      fingerprintKind(claimFingerprint) === fingerprintKind(fingerprint) &&
      claimFingerprint !== fingerprint

    if (!contradicted) {
      // Recorded HERE as well as in applyClaim, because this branch claims a
      // profile just as surely as a click does. Without it an auto-claimed
      // route carried no claim-time evidence at all, so the next register's
      // trust-on-first-use adopted whichever account happened to be signed in
      // by then - the identity check quietly defending nothing.
      if (fingerprint) {
        store.remember(installId, { identityFingerprint: fingerprint, claimedAt: Date.now() })
      }
      return {
        ...base,
        profileDir: matched.dir,
        profileName: matched.name,
        email: matched.email || (typeof email === 'string' ? email : null),
        hostedDomain: matched.hostedDomain,
        claimed: true,
        source: 'email',
      }
    }

    warnings.push(
      `The address this browser reports matches profile directory "${matched.dir}", but this line ` +
        `was claimed as ${describeFingerprint(claimFingerprint)} and that profile now holds ` +
        `${describeFingerprint(fingerprint)}. The bridge will not re-claim it on an address alone. ` +
        'Pick the profile in the options page.'
    )
  }

  // 3. Unclaimed. Visible, honest, and one click from resolved.
  return {
    ...base,
    profileDir: null,
    profileName: null,
    email: typeof email === 'string' && email.includes('@') ? email : null,
    hostedDomain: null,
    claimed: false,
    source: 'unclaimed',
  }
}

/**
 * Apply a human claim: this installId IS this profile directory, for as long as
 * the same person is signed into it.
 *
 * The fingerprint is written HERE and only here. It is deliberately absent from
 * the store.remember() call on the register path, because that call overwrites
 * the persisted email on every single register - which is exactly what would
 * destroy the evidence an account switch has to be measured against. `email` is
 * a live display snapshot; `identityFingerprint` is the immutable claim-time
 * record.
 *
 * The fingerprint is computed from the DISK ROW only, never from the address
 * the extension reports. The operator picked a directory; what that directory held at
 * that moment is the fact being recorded.
 *
 * @returns {object|null} the identity patch, or null when the directory is not
 *   one of the candidates the broker actually offered.
 */
export function applyClaim({ candidatesFull, vendor, userDataDir, dir }) {
  const hit = candidatesFull.find((c) => c.dir === dir)
  if (!hit) return null
  return {
    vendor,
    userDataDir,
    profileDir: hit.dir,
    profileName: hit.name,
    email: hit.email,
    hostedDomain: hit.hostedDomain ?? null,
    claimed: true,
    // A claim ERASES the cached live address, and that is part of the patch
    // rather than an afterthought at the call site. The address a route carries
    // is written once, at REGISTER, and never refreshed while the browser stays
    // open - so after an in-session drop it still names the account that caused
    // the drop. Carrying it past a human's decision had the next heartbeat
    // compare it against the row that human just picked and undo the re-claim.
    // A person pointing at a profile is fresher than anything cached at
    // start-up; the next register refills it.
    reportedEmail: null,
    identityFingerprint: identityFingerprint({
      gaiaId: hit.gaiaId,
      email: hit.email,
      profileName: hit.name,
    }),
    claimedAt: Date.now(),
    source: 'claim',
  }
}

/**
 * Re-read the full candidate rows for a vendor and user-data-dir.
 *
 * allProfiles() only walks the three DEFAULT user-data-dirs, which is right for
 * the normal case. But a browser launched with an explicit --user-data-dir is
 * completely absent from it, and the process-ancestry walk hands us exactly
 * that directory - so filtering allProfiles() by it yields nothing and the
 * profile can never be claimed. That is not hypothetical: the e2e harness runs
 * this way on purpose, and so does any Chrome started against a scratch
 * profile.
 *
 * So: when the resolved directory is not one of the known ones, read its own
 * `Local State` directly. Still the same one file, still only
 * profile.info_cache, and still scoped to that single directory - a claim can
 * never be offered a profile from a different browser or a different
 * user-data-dir.
 */
export function candidatesFor(vendor, userDataDir) {
  const known = allProfiles().filter(
    (p) => p.vendor === vendor && (!userDataDir || sameDir(p.userDataDir, userDataDir))
  )
  if (known.length > 0 || !userDataDir) return known

  const browser = browserByVendor(vendor)
  return readProfiles(userDataDir).map((p) => ({
    vendor,
    vendorLabel: browser?.label || vendor,
    userDataDir,
    ...p,
  }))
}

/* -------------------------------------------------------------------------- */
/* Labels                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The default label for a route.
 *
 * A claimed route gets the identity-derived label from shared/paths.mjs. An
 * unclaimed one gets a label that SAYS it is unclaimed, with a short stable
 * suffix off the installId, so the model addressing it can never mistake it
 * for a named identity and the operator can see at a glance which line needs a click.
 */
export function defaultLabelFor(identity) {
  if (identity.claimed && identity.profileDir) {
    return deriveLabel(identity.vendor, {
      dir: identity.profileDir,
      name: identity.profileName,
      email: identity.email,
      hostedDomain: identity.hostedDomain,
    })
  }
  const short = String(identity.installId || '').replace(/-/g, '').slice(0, 6) || 'unknown'
  return `${identity.vendor}-unclaimed-${short}`
}

/* -------------------------------------------------------------------------- */
/* Board lines for profiles that are configured but not connected              */
/* -------------------------------------------------------------------------- */

/**
 * A profile the bridge has seen before and is NOT seeing now.
 *
 * This line is the entire reason the board exists in this shape. Unpacked
 * extensions die silently - a developer-mode prompt, an enterprise policy or an
 * update-driven auto-disable removes a profile from the bridge with no error
 * anywhere. Without a configured-versus-live comparison the profile simply
 * stops appearing, and nobody notices until an operation lands somewhere else.
 */
export function absentLine(entry) {
  const label = entry.label || `${entry.vendor || 'unknown'}-absent`
  return {
    installId: entry.installId,
    label,
    // The pre-collision name. The board compares these across live AND absent
    // lines, which is how a duplicate that only exists between a connected
    // profile and a configured-but-absent one becomes visible.
    desiredLabel: entry.desiredLabel || label,
    labelIsCustom: Boolean(entry.labelIsCustom),
    identityChanged: Boolean(entry.identityChanged),
    vendor: entry.vendor || 'unknown',
    vendorLabel: entry.vendorLabel || browserByVendor(entry.vendor)?.label || entry.vendor || 'Unknown',
    profileDir: entry.profileDir || null,
    profileName: entry.profileName || null,
    email: entry.email || null,
    link: LINK.DOWN,
    present: false,
    claimed: Boolean(entry.claimed),
    candidates: [],
    generation: Number(entry.generation) || 0,
    tabCount: 0,
    // The version it was running the last time it connected. Kept on the absent
    // line because "this profile is two releases behind" is exactly what an
    // operator wants to know about a browser that is currently closed, and
    // never flagged as needing a reload: a closed profile picks the new code up
    // when it next starts, with nobody clicking anything.
    extVersion: entry.extVersion || null,
    needsReload: false,
    latencyMs: null,
    lastSeenAt: Number(entry.lastSeenAt) || null,
    armedUntil: null,
    opCount: 0,
    lastOp: null,
    warning: entry.identityChanged
      ? `${IDENTITY_CHANGED_PREFIX}the account signed into this profile changed while it was ` +
        'connected, so the bridge dropped the claim. It is not connected now. Open that browser ' +
        'profile and claim the line again.'
      : 'Configured but not connected. Check that the bridge extension is still loaded and ' +
        'enabled in this browser profile.',
  }
}
