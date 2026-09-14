/**
 * Filesystem layout, platform facts and browser discovery.
 *
 * Three jobs:
 *   1. Where the bridge keeps its own state, on each platform.
 *   2. Where each browser looks for a native messaging host manifest, and
 *      where it keeps its profiles.
 *   3. Reading each installed browser's `Local State` to learn the human name
 *      of every profile. That file is plain, unencrypted JSON and is readable
 *      while the browser is running. It is the ONLY browser file the bridge
 *      ever opens, and only `profile.info_cache` is read from it.
 *
 * Hard rule, enforced by scripts/gate.mjs: this module must never reference
 * `Cookies`, `Login Data` or `Web Data`.
 *
 * Platform support, stated plainly: Windows is the reference platform and the
 * one the end-to-end harness has run on. The macOS and Linux paths below follow
 * Chromium's documented locations and have not been exercised on a real
 * machine yet; see README "Platforms".
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import {
  LAUNCHD_LABEL,
  NATIVE_HOST_ID,
  SERVICE_NAME,
  SOCKET_NAME,
  STATE_DIR_NAME,
  SYSTEMD_UNIT,
} from './config.mjs'

/* -------------------------------------------------------------------------- */
/* Platform                                                                    */
/* -------------------------------------------------------------------------- */

/** 'win32' | 'darwin' | 'linux'. Anything that is not Windows or macOS is treated as Linux. */
export const PLATFORM =
  process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
export const IS_WINDOWS = PLATFORM === 'win32'
export const IS_MAC = PLATFORM === 'darwin'
export const IS_LINUX = PLATFORM === 'linux'

const HOME = os.homedir()
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local')
const MAC_APP_SUPPORT = path.join(HOME, 'Library', 'Application Support')
const XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config')
const XDG_STATE_HOME = process.env.XDG_STATE_HOME || path.join(HOME, '.local', 'state')

/**
 * Where machine state lives. BRIDGE_HOME overrides the whole path, which is
 * also how the test suite keeps itself out of a live install's directory.
 */
function defaultBaseDir() {
  if (IS_WINDOWS) return path.join(LOCALAPPDATA, STATE_DIR_NAME)
  if (IS_MAC) return path.join(MAC_APP_SUPPORT, STATE_DIR_NAME)
  return path.join(XDG_STATE_HOME, STATE_DIR_NAME)
}

export const BASE_DIR = process.env.BRIDGE_HOME ? path.resolve(process.env.BRIDGE_HOME) : defaultBaseDir()
export const RUNTIME_FILE = path.join(BASE_DIR, 'runtime.json')
export const STATE_FILE = path.join(BASE_DIR, 'state.json')
export const AUDIT_FILE = path.join(BASE_DIR, 'audit.log')
export const PANIC_FILE = path.join(BASE_DIR, 'PANIC')
export const SHOTS_DIR = path.join(BASE_DIR, 'shots')
export const LOG_FILE = path.join(BASE_DIR, 'broker.log')

/**
 * The broker's local endpoint.
 *
 * Windows: a named pipe. The name is not a secret (`\\.\pipe\` is enumerable by
 * any local user), so the per-boot token in runtime.json does all the work.
 * macOS and Linux: a Unix domain socket file inside BASE_DIR. Unix socket paths
 * are capped at about 104 bytes on macOS, which BASE_DIR stays well under for
 * any reasonable user name; BRIDGE_HOME can shorten it if it does not.
 *
 * Exported under both names: PIPE_NAME is what every existing caller imports.
 */
export const SOCKET_PATH = IS_WINDOWS ? `\\\\.\\pipe\\${SOCKET_NAME}` : path.join(BASE_DIR, `${SOCKET_NAME}.sock`)
export const PIPE_NAME = SOCKET_PATH

/* ---- Native messaging manifest --------------------------------------------- */

/**
 * Windows: ONE manifest file in BASE_DIR, pointed at by a registry value under
 * Chrome's key (which Brave falls back to, see BROWSERS). macOS and Linux: one
 * manifest file INSIDE each browser's own NativeMessagingHosts directory, named
 * `<host id>.json`; there is no registry and no cross-browser fallback there.
 */
export const HOST_MANIFEST_FILE = path.join(BASE_DIR, `${NATIVE_HOST_ID}.json`)

/**
 * The host launcher the browser actually spawns.
 *
 * Windows: the .cmd shim in the repo, which resolves node.exe from PATH (or
 * BRIDGE_NODE). macOS and Linux: a GENERATED shell script in BASE_DIR with the
 * absolute path to node baked in, because a browser launched from the Dock or
 * a desktop menu gets a minimal PATH that usually does not contain node.
 */
export const POSIX_HOST_SHIM_FILE = path.join(BASE_DIR, 'host-launcher.sh')

/* ---- Broker supervision ----------------------------------------------------- */

/**
 * Windows: a Task Scheduler task, run through a hidden launcher.
 *
 * node.exe is a console subsystem binary, so a task running it under an
 * interactive token allocates a console and puts a terminal on screen at every
 * launch. Closing that window sent CTRL_CLOSE_EVENT to the broker and killed
 * it, and the task's one minute repetition then started another one, so the
 * window was both the annoyance and the engine of the restart loop.
 *
 * The chain is deliberately two processes, wscript then node, with no cmd.exe
 * between them. schtasks /end terminates only the task's own process, so any
 * intermediate process would leave the broker orphaned and running while Task
 * Scheduler believed nothing was, which restarts a no-op every minute forever.
 * Because node's parent IS wscript, the broker can watch it and stand down.
 *
 * Both files are GENERATED by scripts/install-broker.mjs. They live beside
 * task-definition.xml because they encode this machine's resolved node path,
 * which is not a fact the repo can hold.
 */
export const LAUNCHER_VBS_FILE = path.join(BASE_DIR, 'broker-launch.vbs')
export const LAUNCHER_BOOT_FILE = path.join(BASE_DIR, 'broker-boot.mjs')
export const START_ERROR_FILE = path.join(BASE_DIR, 'broker-start-error.log')

/** A launcher shape that is no longer generated, listed so uninstall can clean it up. */
export const LEGACY_LAUNCHER_FILES = Object.freeze([path.join(BASE_DIR, 'broker-launch.cmd')])

/** macOS: a per-user launchd agent. KeepAlive does what the Windows watchdog does. */
export const LAUNCHD_PLIST_FILE = path.join(HOME, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
/** Linux: a systemd user unit with Restart=always. */
export const SYSTEMD_UNIT_FILE = path.join(XDG_CONFIG_HOME, 'systemd', 'user', `${SYSTEMD_UNIT}.service`)
/** Where a supervisor sends the broker's stderr on POSIX (the broker itself logs to LOG_FILE). */
export const SUPERVISOR_STDERR_FILE = path.join(BASE_DIR, 'broker-stderr.log')

/**
 * The supervisor entry's name, and the one command that restarts the broker.
 * Named here because five call sites had independently typed the string and it
 * already disagreed with the docs.
 */
export const TASK_NAME = SERVICE_NAME
export const START_BROKER_COMMAND = IS_WINDOWS
  ? `schtasks /Run /TN "${TASK_NAME}"`
  : IS_MAC
    ? `launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}`
    : `systemctl --user restart ${SYSTEMD_UNIT}`

/* -------------------------------------------------------------------------- */
/* Process liveness                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Is the process with this pid definitely gone?
 *
 * Signal 0 delivers nothing and only asks whether the pid can be signalled.
 * The test is POSITIVE on ESRCH, which is the one error that actually means
 * "no such process". Everything else is treated as alive, and that direction
 * is deliberate: the caller's response to "gone" is to shut the broker down,
 * so an unknown error must never be read as death. Measured on the reference
 * machine, Node v22 on Windows: signal 0 against the System process throws
 * EPERM (alive, not ours to signal) and against an exited process throws ESRCH
 * even while another process still holds a handle to it, because libuv checks
 * exit status rather than merely opening the process.
 *
 * Known and accepted limitation: pids are recycled. If the launcher exits and
 * its pid is immediately reused, this reports alive forever and the broker
 * keeps running unsupervised. That is the safe direction to be wrong in, it
 * needs a coincidence inside one watch interval, and doctor reports the
 * resulting orphan state.
 *
 * Lives here, apart from the broker, so it can be tested without starting one.
 *
 * @param {number} pid
 * @param {(pid:number, signal:number)=>void} [kill] injection seam for tests
 */
export function processIsGone(pid, kill = process.kill.bind(process)) {
  try {
    kill(pid, 0)
    return false
  } catch (err) {
    return err?.code === 'ESRCH'
  }
}

export function ensureBaseDir() {
  fs.mkdirSync(BASE_DIR, { recursive: true })
  fs.mkdirSync(SHOTS_DIR, { recursive: true })
  if (!IS_WINDOWS) {
    try {
      fs.chmodSync(BASE_DIR, 0o700)
    } catch {
      /* best effort; the per-file permissions below are the real control */
    }
  }
  return BASE_DIR
}

/**
 * Restrict a file to the current user. Best effort: a failure is reported
 * through `onWarn`, never thrown, because a broker that refuses to start over
 * an ACL helps nobody. On Windows this shells out to icacls (Node cannot set a
 * DACL without a native addon, and native addons are banned); on POSIX it is a
 * chmod.
 */
export function restrictToCurrentUser(file, { onWarn = () => {}, onOk = () => {}, execFile } = {}) {
  if (!IS_WINDOWS) {
    try {
      fs.chmodSync(file, 0o600)
      onOk({ mode: '0600' })
    } catch (err) {
      onWarn({ err: String(err?.message || err) })
    }
    return
  }
  const user = process.env.USERNAME
  if (!user) {
    onWarn({ err: 'USERNAME is not set' })
    return
  }
  const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user
  if (!execFile) {
    onWarn({ err: 'no execFile provided' })
    return
  }
  execFile(
    'icacls',
    [file, '/inheritance:r', '/grant:r', `${account}:(F)`],
    { windowsHide: true, timeout: 10_000 },
    (err, _stdout, stderr) => {
      if (err) onWarn({ account, err: String(stderr || err).trim().slice(0, 400) })
      else onOk({ account })
    }
  )
}

/* -------------------------------------------------------------------------- */
/* runtime.json - the authentication contract for every socket client          */
/* -------------------------------------------------------------------------- */

/**
 * Shape written by the broker on every start:
 *   { pipeName, token, pid, startedAt, version }
 *
 * The token rotates per boot, so a leaked one dies at the next restart, and
 * every client re-reads this file on EVERY connect attempt rather than caching
 * it. The shape lives here because the host, the MCP client and doctor were
 * each guessing at it independently - doctor tried three different key names.
 */
export const RUNTIME_TOKEN_KEY = 'token'

export function writeRuntime({ token, version, pipeName }) {
  const runtime = {
    pipeName,
    [RUNTIME_TOKEN_KEY]: token,
    pid: process.pid,
    startedAt: Date.now(),
    version,
  }
  writeJsonAtomic(RUNTIME_FILE, runtime)
  return runtime
}

/**
 * Read the current token, or null when the broker has never run.
 * Never throws: a missing or malformed runtime file means "not authenticated
 * yet", which every client already handles as a retryable state.
 */
export function readRuntimeToken() {
  const runtime = readJson(RUNTIME_FILE, null)
  const token = runtime?.[RUNTIME_TOKEN_KEY]
  return typeof token === 'string' && token.length > 0 ? token : null
}

export function readRuntime() {
  return readJson(RUNTIME_FILE, null)
}

/* -------------------------------------------------------------------------- */
/* Browser discovery                                                           */
/* -------------------------------------------------------------------------- */

function userDataDirFor(vendor) {
  if (IS_WINDOWS) {
    return {
      chrome: path.join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data'),
      brave: path.join(LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'User Data'),
      edge: path.join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data'),
    }[vendor]
  }
  if (IS_MAC) {
    return {
      chrome: path.join(MAC_APP_SUPPORT, 'Google', 'Chrome'),
      brave: path.join(MAC_APP_SUPPORT, 'BraveSoftware', 'Brave-Browser'),
      edge: path.join(MAC_APP_SUPPORT, 'Microsoft Edge'),
    }[vendor]
  }
  return {
    chrome: path.join(XDG_CONFIG_HOME, 'google-chrome'),
    brave: path.join(XDG_CONFIG_HOME, 'BraveSoftware', 'Brave-Browser'),
    edge: path.join(XDG_CONFIG_HOME, 'microsoft-edge'),
  }[vendor]
}

/**
 * Every Chromium browser we know how to talk about.
 *
 * `registryKey` (Windows only) is where that browser looks for native
 * messaging host manifests. Brave deliberately has none as an install target:
 * it is a CHROMIUM_BRANDING build, so launch_context_win.cc checks
 * SOFTWARE\Chromium\NativeMessagingHosts first and then falls back
 * unconditionally to SOFTWARE\Google\Chrome. Brave ships no Windows override,
 * so Chrome's key serves Brave too. Verified on the reference machine.
 *
 * `nativeMessagingDir` (macOS and Linux only) is the per-browser directory a
 * manifest file has to be placed in. No fallback exists there, so the
 * installer writes one manifest per installed browser.
 *
 * `registersHost` says whether install-host writes a registration for this
 * vendor on the current platform.
 */
export const BROWSERS = Object.freeze(
  [
    {
      vendor: 'chrome',
      label: 'Chrome',
      registryKey: 'HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts',
      registersHost: true,
    },
    {
      vendor: 'brave',
      label: 'Brave',
      registryKey: null, // served by Chrome's key on Windows, by Chromium's own fallback
      registersHost: !IS_WINDOWS,
    },
    {
      vendor: 'edge',
      label: 'Edge',
      registryKey: 'HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts',
      registersHost: false, // out of scope for v1; Edge has its own key when added
    },
  ].map((b) => {
    const userDataDir = userDataDirFor(b.vendor)
    return Object.freeze({
      ...b,
      userDataDir,
      nativeMessagingDir: IS_WINDOWS ? null : path.join(userDataDir, 'NativeMessagingHosts'),
    })
  })
)

/**
 * Registry keys that would SHADOW our registration if they existed (Windows).
 * Chromium-branded builds consult SOFTWARE\Chromium first, so a stale entry
 * there silently wins over the Chrome key and produces a
 * "Specified native messaging host not found" with no diagnostic surface.
 * scripts/doctor.mjs asserts these are absent.
 */
export const SHADOWING_REGISTRY_KEYS = Object.freeze([
  'HKCU\\SOFTWARE\\Chromium\\NativeMessagingHosts',
  'HKLM\\SOFTWARE\\Chromium\\NativeMessagingHosts',
  'HKLM\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts',
])

export function browserByVendor(vendor) {
  return BROWSERS.find((b) => b.vendor === vendor) || null
}

/** Which browsers are actually installed on this machine right now. */
export function installedBrowsers() {
  return BROWSERS.filter((b) => {
    try {
      return fs.statSync(b.userDataDir).isDirectory()
    } catch {
      return false
    }
  })
}

/**
 * Where the native messaging manifest has to be, per browser, on this platform.
 *
 * Windows: one file for every browser (the registry does the pointing), so this
 * returns a single entry labeled for Chrome, which Brave falls back to.
 * macOS and Linux: one file per installed browser that registers a host.
 *
 * @returns {{vendor:string,label:string,file:string}[]}
 */
export function hostManifestTargets({ installedOnly = true } = {}) {
  if (IS_WINDOWS) return [{ vendor: 'chrome', label: 'Chrome and Brave', file: HOST_MANIFEST_FILE }]
  const candidates = installedOnly ? installedBrowsers() : BROWSERS
  return candidates
    .filter((b) => b.registersHost)
    .map((b) => ({ vendor: b.vendor, label: b.label, file: path.join(b.nativeMessagingDir, `${NATIVE_HOST_ID}.json`) }))
}

/**
 * Read one browser's profiles from its `Local State`.
 *
 * Returns [] rather than throwing when the browser is not installed or the
 * file is briefly unreadable: profile discovery is advisory, and a transient
 * read failure must never take the broker down.
 *
 * @returns {{dir:string,name:string,email:string|null,gaiaId:string|null,gaiaName:string|null,hostedDomain:string|null,active:number}[]}
 */
export function readProfiles(userDataDir) {
  const file = path.join(userDataDir, 'Local State')
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }

  let json
  try {
    json = JSON.parse(raw)
  } catch {
    return []
  }

  const cache = json?.profile?.info_cache
  if (!cache || typeof cache !== 'object') return []

  return Object.entries(cache).map(([dir, info]) => ({
    dir,
    name: typeof info?.name === 'string' ? info.name : dir,
    // Brave leaves these as empty strings on every profile, so normalize the
    // empty string to null and let callers branch on that rather than on ''.
    email: nonEmpty(info?.user_name),
    // The Google account's opaque id, and the best identity key this file can
    // offer: it survives an email rename, and unlike `name` no human can type
    // it, so it cannot be spoofed by renaming a profile. Chrome fills it for
    // every signed-in profile; Brave leaves it empty, which is why identity
    // drift on Brave falls back to the profile name.
    gaiaId: nonEmpty(info?.gaia_id),
    gaiaName: nonEmpty(info?.gaia_name),
    hostedDomain:
      nonEmpty(info?.hosted_domain) === 'NO_HOSTED_DOMAIN' ? null : nonEmpty(info?.hosted_domain),
    active: typeof info?.active_time === 'number' ? info.active_time : 0,
  }))
}

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

/** Every profile on the machine, tagged with its vendor. Used by the claim flow. */
export function allProfiles() {
  const out = []
  for (const b of installedBrowsers()) {
    for (const p of readProfiles(b.userDataDir)) {
      out.push({ vendor: b.vendor, vendorLabel: b.label, userDataDir: b.userDataDir, ...p })
    }
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Labels                                                                      */
/* -------------------------------------------------------------------------- */

/** Mailbox providers whose domain says nothing about who the user is. */
const CONSUMER_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
])

/**
 * Human label for a profile: `<vendor>-<slug>`.
 *
 * The slug identifies the IDENTITY, not the mailbox. A custom domain names a
 * person's org and is the best signal; a consumer mailbox domain says nothing,
 * so the local part is used instead.
 *
 * Brave is the awkward case and drives the `name`-as-email branch: its
 * `info_cache` carries no Google identity at all, and many operators name
 * their Brave profiles after email addresses. Parsing a name that looks like
 * an email gives Brave the same quality of label Chrome gets for free.
 *
 * These are only DEFAULTS. Every label is renamable in the options page and
 * the override always wins, so a label being merely decent is fine - it must
 * just never be misleading or collide.
 */
export function deriveLabel(vendor, profile) {
  const slug =
    slugFromDomain(profile.hostedDomain) ||
    slugFromEmail(profile.email) ||
    slugFromEmail(profile.name) || // Brave: the profile name is often an address
    slugify(profile.name) ||
    slugify(profile.dir) ||
    'profile'
  return `${vendor}-${slug}`
}

/**
 * A custom domain becomes its registrable name: acme-corp.com -> acme-corp.
 * When that name is short enough to be ambiguous (ada.dev -> "ada"), the next
 * label is kept too, so ada.dev becomes "ada-dev" rather than a bare "ada"
 * that reads like a person and could be any of several profiles.
 */
function slugFromDomain(domain) {
  if (!domain) return null
  const parts = String(domain).toLowerCase().split('.').filter(Boolean)
  if (parts.length === 0) return null
  if (CONSUMER_MAIL_DOMAINS.has(parts.join('.'))) return null
  const head = parts[0]
  if (head.length < 4 && parts.length > 1) return slugify(`${head}-${parts[1]}`)
  return slugify(head)
}

function slugFromEmail(value) {
  if (typeof value !== 'string' || !value.includes('@')) return null
  const [local, domain] = value.trim().split('@')
  if (!domain) return null
  return slugFromDomain(domain) || slugify(local)
}

export function slugify(s) {
  if (!s) return null
  const out = String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return out || null
}

/* -------------------------------------------------------------------------- */
/* Small JSON helpers used by broker and scripts                               */
/* -------------------------------------------------------------------------- */

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** Write JSON atomically, so a crash mid-write cannot leave a truncated state file. */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}
