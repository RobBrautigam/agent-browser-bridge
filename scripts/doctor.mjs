#!/usr/bin/env node
/**
 * doctor - make every way this system fails legible.
 *
 * the bridge's failure modes are mostly SILENT. An unpacked extension that
 * Chrome disabled does not raise an error anywhere; it just stops appearing. A
 * stale registry key under SOFTWARE\Chromium wins over ours and produces
 * "Specified native messaging host not found" with no clue about why. A
 * scheduled task without ExecutionTimeLimit PT0S works perfectly for 72 hours
 * and then does not.
 *
 * So this script's job is not to test the happy path. It is to name the
 * specific silent failure, in order, with the command that fixes it. Check 10
 * (configured versus live profiles) is the highest-value line in the file: it
 * is the only place a profile that quietly dropped off the bridge becomes
 * visible.
 *
 * Every fact this script asserts comes from the shared contract rather than
 * from a local guess. That is not tidiness: an earlier version tried three
 * different key names for the broker's auth token and typed the scheduled
 * task's name a fourth time, so a diagnostic could report a healthy system as
 * broken, which is worse than no diagnostic at all.
 *
 * Exit code is 0 only when nothing FAILED. Warnings do not fail the run.
 */

import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { idFromPath, extensionOrigin } from '../shared/extid.mjs'
import { LAUNCHD_LABEL, SYSTEMD_UNIT } from '../shared/config.mjs'
import {
  BASE_DIR,
  HOST_MANIFEST_FILE,
  IS_MAC,
  IS_WINDOWS,
  LAUNCHD_PLIST_FILE,
  POSIX_HOST_SHIM_FILE,
  STATE_FILE,
  RUNTIME_FILE,
  SHADOWING_REGISTRY_KEYS,
  START_ERROR_FILE,
  START_BROKER_COMMAND,
  SYSTEMD_UNIT_FILE,
  TASK_NAME,
  allProfiles,
  deriveLabel,
  hostManifestTargets,
  installedBrowsers,
  readJson,
  readRuntime,
  readRuntimeToken,
  writeJsonAtomic,
} from '../shared/paths.mjs'
import {
  LINK,
  MSG,
  NATIVE_HOST_ID,
  OPS,
  PIPE_NAME,
  PRODUCT_NAME,
  ROLE,
  hello,
  req,
} from '../shared/protocol.mjs'
import { FrameDecoder, writeFrame } from '../shared/framing.mjs'
import { HOST_REG_KEY, readRegistryDefault, registryKeyExists, resolveExtensionId } from './install-host.mjs'
import {
  execCommand,
  isHiddenLauncherCommand,
  queryTaskXml,
  settingValue,
  taskHasRunningInstance,
} from './install-broker.mjs'
import { CLAUDE_JSON, MCP_ENTRY_NAME, MCP_SERVER_ENTRY, desiredEntry } from './install-mcp.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXTENSION_DIR = path.join(REPO_ROOT, 'extension')
const MANIFEST_FILE = path.join(EXTENSION_DIR, 'manifest.json')
const NODE_MODULES = path.join(REPO_ROOT, 'node_modules')
const PLACEHOLDER = 'PLACEHOLDER_REPLACED_BY_KEYGEN'
const REQUIRED_NODE_MAJOR = 22

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const paint = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s)
const bold = (s) => paint('1', s)
const green = (s) => paint('32', s)
const yellow = (s) => paint('33', s)
const red = (s) => paint('31', s)
const cyan = (s) => paint('36', s)
const dim = (s) => paint('2', s)

/* -------------------------------------------------------------------------- */
/* Reporting                                                                   */
/* -------------------------------------------------------------------------- */

const tally = { pass: 0, warn: 0, fail: 0 }
let checkNumber = 0

function section(title) {
  checkNumber += 1
  console.log('')
  console.log(bold(` ${String(checkNumber).padStart(2, ' ')}. ${title}`))
}
function pass(text) {
  tally.pass += 1
  console.log(`     ${green('PASS')}  ${text}`)
}
function warn(text, hint) {
  tally.warn += 1
  console.log(`     ${yellow('WARN')}  ${text}`)
  printHint(hint)
}
function fail(text, hint) {
  tally.fail += 1
  console.log(`     ${red('FAIL')}  ${text}`)
  printHint(hint)
}
function info(text) {
  console.log(`     ${dim('info')}  ${dim(text)}`)
}
function printHint(hint) {
  if (!hint) return
  const lines = String(hint).split('\n')
  console.log(`           ${cyan('fix:')} ${lines[0]}`)
  for (const l of lines.slice(1)) console.log(`                ${l}`)
}

/* -------------------------------------------------------------------------- */
/* Broker conversation                                                         */
/* -------------------------------------------------------------------------- */

/** Is anything listening on the pipe? Deliberately does no handshake. */
function pipeAnswers(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = net.connect({ path: PIPE_NAME })
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(v)
    }
    const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), timeoutMs)
    sock.on('connect', () => done({ ok: true }))
    sock.on('error', (err) => done({ ok: false, error: err?.code || String(err?.message || err) }))
  })
}

/**
 * Full handshake plus one request.
 *
 * The token comes from readRuntimeToken(), which is the one function that knows
 * runtime.json's shape. Doctor used to try three key names of its own invention,
 * which meant a broker that had rotated its token correctly could still be
 * reported as refusing the handshake.
 */
function askBroker(op, args = {}, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const token = readRuntimeToken()

    const sock = net.connect({ path: PIPE_NAME })
    const decoder = new FrameDecoder()
    const id = `doctor-${Date.now()}`
    let settled = false

    const done = (v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(v)
    }
    const timer = setTimeout(() => done({ ok: false, error: 'timeout waiting for the broker' }), timeoutMs)

    sock.on('error', (err) => done({ ok: false, error: err?.code || String(err?.message || err) }))
    sock.on('close', () => done({ ok: false, error: 'the broker closed the connection' }))
    sock.on('connect', () => {
      writeFrame(sock, hello({ role: ROLE.MCP, token, client: 'doctor' }))
    })
    sock.on('data', (chunk) => {
      let messages
      try {
        messages = decoder.push(chunk)
      } catch (err) {
        return done({ ok: false, error: `framing: ${err.message}` })
      }
      for (const msg of messages) {
        if (msg?.type === MSG.HELLO_ACK) {
          if (msg.ok === false) {
            return done({ ok: false, error: msg.error?.code || msg.error?.message || 'handshake refused' })
          }
          writeFrame(sock, req({ id, op, args, timeoutMs: 4000 }))
        } else if (msg?.type === MSG.RES && msg.id === id) {
          return msg.ok
            ? done({ ok: true, result: msg.result })
            : done({ ok: false, error: msg.error?.code || msg.error?.message || 'request failed' })
        }
      }
    })
  })
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

const SKIP_DIRS = new Set(['.git', 'dist', 'tmp', '.claude'])

function* walk(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walk(full)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

function ago(ms) {
  if (ms === null || ms === undefined) return 'never'
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s}s ago`
  const m = Math.round(s / 60)
  return m < 90 ? `${m}m ago` : `${Math.round(m / 60)}h ago`
}

/* -------------------------------------------------------------------------- */
/* The checks                                                                  */
/* -------------------------------------------------------------------------- */

async function main() {
  console.log(bold(`${PRODUCT_NAME} doctor`))
  console.log(dim(`  repo   ${REPO_ROOT}`))
  console.log(dim(`  state  ${BASE_DIR}`))
  console.log(dim(`  pipe   ${PIPE_NAME}`))

  /* 1 ------------------------------------------------------------------- */
  section('Node runtime')
  const major = Number(process.versions.node.split('.')[0])
  if (major === REQUIRED_NODE_MAJOR) {
    pass(`Node v${process.versions.node} (major ${major})`)
  } else {
    fail(
      `Node v${process.versions.node}, expected major ${REQUIRED_NODE_MAJOR}`,
      `The bridge pins Node ${REQUIRED_NODE_MAJOR} LTS. Node 24+ is where the incumbent's\n` +
        'native-module breakage came from. Install Node 22 and re-run.'
    )
  }

  /* 2 ------------------------------------------------------------------- */
  section('No native modules')
  // walk() deliberately does NOT skip node_modules here: a native binary
  // arriving through a transitive dependency is the exact case this catches.
  const nativeFiles = []
  for (const file of walk(REPO_ROOT)) {
    if (file.toLowerCase().endsWith('.node')) nativeFiles.push(path.relative(REPO_ROOT, file))
  }
  if (nativeFiles.length === 0) {
    pass(`no .node binaries under the repo or ${path.basename(NODE_MODULES)}`)
  } else {
    fail(
      `${nativeFiles.length} native binary file(s) present: ${nativeFiles.slice(0, 5).join(', ')}`,
      'A native module is ABI-locked to one Node major version and breaks on upgrade.\n' +
        'Find which dependency pulled it in and remove that dependency.'
    )
  }

  /* 3 ------------------------------------------------------------------- */
  section('Extension ID')
  const manifest = readJson(MANIFEST_FILE, null)
  let extensionId = null
  if (!fs.existsSync(EXTENSION_DIR)) {
    fail(`${EXTENSION_DIR} does not exist`, 'The extension component has not been installed in this repo yet.')
  } else if (!manifest) {
    fail(`cannot read ${MANIFEST_FILE}`, 'The file is missing or is not valid JSON.')
  } else {
    // The ID comes from the manifest key when one is present (keygen is
    // optional and pins the ID across a folder move), otherwise from the
    // folder path, exactly as install-host derives it.
    const resolved = resolveExtensionId({ manifest })
    if (typeof manifest.key === 'string' && manifest.key.trim() === PLACEHOLDER) {
      // A placeholder means keygen was started and never finished. The ID
      // below is still derived from the path, so the install works, but the
      // pinning the operator asked for is not in effect.
      warn(
        'extension/manifest.json carries the keygen placeholder instead of a key',
        'node scripts/keygen.mjs   (or remove the "key" field to derive the ID from the folder path)'
      )
    }
    if (!resolved.id) {
      fail(`the extension ID could not be derived: ${resolved.error}`, 'node scripts/keygen.mjs   (pins a fresh key)')
    } else {
      extensionId = resolved.id
      pass(`extension ID ${bold(extensionId)} (from the ${resolved.source})`)
      info(`origin      ${extensionOrigin(extensionId)}`)
      if (resolved.source === 'folder path') {
        info(`derived from ${resolved.detail}`)
        info('if chrome://extensions shows a different ID, re-run: node scripts/install-host.mjs --extension-id <that id>')
      } else {
        // What a keyless load would produce. If chrome://extensions shows THIS,
        // the browser loaded a manifest without the key.
        info(`keyless id  ${idFromPath(EXTENSION_DIR)}  (path-derived, for diagnosis)`)
      }
    }
  }

  /* 4 ------------------------------------------------------------------- */
  section('Native messaging manifest')
  // Windows: one file in the state directory, found through the registry.
  // macOS and Linux: one file inside each installed browser's own directory.
  const targets = hostManifestTargets()
  if (targets.length === 0) {
    fail('no installed browser directory was found to hold a manifest', 'open Chrome or Brave once, then: node scripts/install-host.mjs')
  }
  for (const target of targets) {
    const hostManifest = readJson(target.file, null)
    if (!hostManifest) {
      fail(`${target.file} is missing or unreadable (${target.label})`, 'node scripts/install-host.mjs')
      continue
    }
    const problems = []
    if (hostManifest.name !== NATIVE_HOST_ID) {
      problems.push(`name is "${hostManifest.name}", expected "${NATIVE_HOST_ID}"`)
    }
    if (hostManifest.type !== 'stdio') problems.push(`type is "${hostManifest.type}", expected "stdio"`)
    if (typeof hostManifest.path !== 'string' || !fs.existsSync(hostManifest.path)) {
      problems.push(`path does not exist on disk: ${hostManifest.path}`)
    }
    const origins = Array.isArray(hostManifest.allowed_origins) ? hostManifest.allowed_origins : []
    if (origins.length !== 1) problems.push(`allowed_origins has ${origins.length} entries, expected exactly 1`)
    if (origins.some((o) => String(o).includes('*'))) {
      problems.push('allowed_origins contains a wildcard, which Chromium rejects at parse time')
    }
    if (extensionId && origins[0] !== extensionOrigin(extensionId)) {
      problems.push(
        `allowed_origins is ${JSON.stringify(origins)}, but check 3 derives ${extensionOrigin(extensionId)}. ` +
          'If the browser shows the registered one, the derivation is what is off; re-run install-host with --extension-id.'
      )
    }

    if (problems.length === 0) {
      pass(`${target.file} (${target.label})`)
      info(`path        ${hostManifest.path}`)
      info(`authorizes  ${origins[0]}`)
    } else {
      for (const p of problems) fail(p)
      printHint('node scripts/install-host.mjs   (it re-derives the ID and rewrites the manifest)')
    }
  }
  if (!IS_WINDOWS) {
    let executable = false
    try {
      fs.accessSync(POSIX_HOST_SHIM_FILE, fs.constants.X_OK)
      executable = true
    } catch {
      executable = false
    }
    if (executable) pass(`${POSIX_HOST_SHIM_FILE} exists and is executable`)
    else fail(`${POSIX_HOST_SHIM_FILE} is missing or not executable`, 'node scripts/install-host.mjs')
  }

  /* 5 ------------------------------------------------------------------- */
  section('Registry registration')
  if (process.platform !== 'win32') {
    pass('no registry on this platform; each browser reads the manifest from its own directory (check 4)')
  } else {
    const entry = readRegistryDefault(HOST_REG_KEY)
    if (!entry.exists) {
      fail(`${HOST_REG_KEY} does not exist`, 'node scripts/install-host.mjs')
    } else if (entry.value !== HOST_MANIFEST_FILE) {
      fail(
        `registry value is "${entry.value}", expected "${HOST_MANIFEST_FILE}"`,
        'node scripts/install-host.mjs'
      )
    } else if (!fs.existsSync(entry.value)) {
      fail(`the registry points at a file that does not exist: ${entry.value}`, 'node scripts/install-host.mjs')
    } else {
      pass(`${HOST_REG_KEY} resolves to the manifest`)
      info('this one Chrome key also serves Brave, by Chromium\'s own fallback')
    }
  }

  /* 6 ------------------------------------------------------------------- */
  section('No shadowing registry keys')
  if (process.platform !== 'win32') {
    pass('no registry on this platform; each browser reads the manifest from its own directory (check 4)')
  } else {
    let shadows = 0
    for (const key of SHADOWING_REGISTRY_KEYS) {
      const hostKey = `${key}\\${NATIVE_HOST_ID}`
      if (!registryKeyExists(hostKey)) continue
      shadows += 1
      const entry = readRegistryDefault(hostKey)
      // A Chromium-branded build (Brave) reads SOFTWARE\Chromium FIRST, so an
      // entry there wins over the Chrome key we wrote and there is no error
      // surface at all when it points somewhere stale.
      const isChromium = key.includes('\\Chromium\\')
      const message = `${hostKey} exists and points at ${entry.value ?? '(no value)'}`
      if (isChromium) {
        fail(
          `${message} - Brave reads this BEFORE Chrome's key`,
          `reg delete "${hostKey}" /f   (run it in PowerShell or cmd, not Git Bash)`
        )
      } else {
        warn(
          `${message} - HKCU wins over HKLM, but a divergent copy will confuse the next person`,
          `reg delete "${hostKey}" /f   (run it in PowerShell or cmd, not Git Bash)`
        )
      }
    }
    if (shadows === 0) pass(`none of the ${SHADOWING_REGISTRY_KEYS.length} shadowing locations carry ${NATIVE_HOST_ID}`)
  }

  /* 7 ------------------------------------------------------------------- */
  section('Broker service')
  if (IS_MAC) {
    if (!fs.existsSync(LAUNCHD_PLIST_FILE)) {
      fail(`${LAUNCHD_PLIST_FILE} is not installed`, 'node scripts/install-broker.mjs')
    } else {
      let loaded = false
      try {
        execFileSync('launchctl', ['print', `gui/${process.getuid()}/${LAUNCHD_LABEL}`], { stdio: 'ignore' })
        loaded = true
      } catch {
        loaded = false
      }
      if (loaded) pass(`launchd agent ${LAUNCHD_LABEL} is loaded`)
      else fail(`launchd agent ${LAUNCHD_LABEL} is not loaded`, `launchctl bootstrap gui/$(id -u) "${LAUNCHD_PLIST_FILE}"`)
    }
  } else if (!IS_WINDOWS) {
    if (!fs.existsSync(SYSTEMD_UNIT_FILE)) {
      fail(`${SYSTEMD_UNIT_FILE} is not installed`, 'node scripts/install-broker.mjs')
    } else {
      let active = false
      try {
        execFileSync('systemctl', ['--user', 'is-active', '--quiet', SYSTEMD_UNIT], { stdio: 'ignore' })
        active = true
      } catch {
        active = false
      }
      if (active) pass(`systemd user unit ${SYSTEMD_UNIT} is active`)
      else fail(`systemd user unit ${SYSTEMD_UNIT} is not active`, `systemctl --user enable --now ${SYSTEMD_UNIT}`)
    }
  } else {
    const live = queryTaskXml(TASK_NAME)
    if (!live.exists) {
      fail(`the task "${TASK_NAME}" is not registered${live.error ? ` (${firstLine(live.error)})` : ''}`, 'node scripts/install-broker.mjs')
    } else {
      // Read the LIVE definition, never the file we wrote. A task edited by
      // hand, or reset by a policy, is exactly the case this catches.
      const limit = settingValue(live.xml, 'ExecutionTimeLimit')
      const policy = settingValue(live.xml, 'MultipleInstancesPolicy')
      const enabled = settingValue(live.xml, 'Enabled')
      if (limit === 'PT0S') {
        pass(`task registered, live ExecutionTimeLimit is PT0S`)
      } else {
        fail(
          `live ExecutionTimeLimit is ${limit ?? '(absent)'}, expected PT0S`,
          'Windows terminates the broker after 72 hours without PT0S.\n' +
            'node scripts/install-broker.mjs   (re-registers with /f)'
        )
      }
      if (policy !== 'IgnoreNew') {
        warn(
          `MultipleInstancesPolicy is ${policy ?? '(absent)'}, expected IgnoreNew`,
          'Without IgnoreNew the 1-minute watchdog repetition can start a second broker.'
        )
      } else {
        info('MultipleInstancesPolicy IgnoreNew (the 1-minute repetition is the watchdog)')
      }
      if (enabled === 'false') {
        fail('the task is registered but disabled', `schtasks /change /tn "${TASK_NAME}" /enable`)
      }

      // The task must run the hidden launcher, never node.exe directly.
      // node.exe is a console subsystem binary, so an interactive-token task
      // running it shows a terminal window at every launch, and closing that
      // window sends CTRL_CLOSE_EVENT and kills the broker. That made the
      // watchdog restart it a minute later, with another window. This check
      // exists because a reinstall from an older checkout would put the whole
      // loop back and nothing else would notice.
      const command = execCommand(live.xml)
      if (isHiddenLauncherCommand(command)) {
        pass('the task runs the hidden launcher, so no console window appears')
      } else {
        fail(
          `the task command is ${command ?? '(absent)'}, expected wscript.exe`,
          'A console subsystem command shows a window at every launch, and closing\n' +
            'that window kills the broker.\n' +
            'node scripts/install-broker.mjs   (re-registers with /f)'
        )
      }
    }
  }

  /* 8 ------------------------------------------------------------------- */
  section('Broker is answering')
  if (!IS_WINDOWS && Buffer.byteLength(PIPE_NAME) > 100) {
    fail(
      `the socket path is ${Buffer.byteLength(PIPE_NAME)} bytes, over the ~104-byte limit for a Unix socket`,
      'set BRIDGE_HOME to a shorter directory, or shorten socketName / stateDirName in bridge.config.json'
    )
  }
  const pipe = await pipeAnswers()
  if (pipe.ok) {
    pass(`connected to ${PIPE_NAME}`)
  } else {
    fail(
      `nothing is answering on ${PIPE_NAME} (${pipe.error})`,
      `${START_BROKER_COMMAND}\n` + `then check ${path.join(BASE_DIR, 'broker.log')}`
    )
  }

  // The launcher hides the console, so a failure that happens before the
  // broker's own logger exists, a bad import or a syntax error, has exactly one
  // place left to surface. Reporting the task as healthy while this file holds
  // the reason the broker is not running would be the worst kind of clean bill.
  let startError = null
  try {
    startError = fs.readFileSync(START_ERROR_FILE, 'utf8').trim()
  } catch {
    // Absent is the healthy state: the launcher clears it on every start.
  }
  if (startError) {
    fail(
      'the last broker start failed before its logger existed',
      `${firstLine(startError)}\nfull text: ${START_ERROR_FILE}`
    )
  } else if (pipe.ok) {
    info('no start error recorded, so the last launch got past its imports')
  }

  // A broker with no task instance behind it is running unsupervised: nothing
  // restarts it when it stops. The parent watch normally prevents this, but it
  // cannot see a recycled pid, and EADDRINUSE exiting 0 deliberately removed
  // the restart churn that used to make this state noisy from the outside.
  if (pipe.ok && process.platform === 'win32' && !taskHasRunningInstance(TASK_NAME)) {
    warn(
      'a broker is answering but the scheduled task reports no running instance',
      'It is unsupervised, so nothing will restart it when it stops.\n' +
        `schtasks /End /TN "${TASK_NAME}"   then   ${START_BROKER_COMMAND}`
    )
  }

  // runtime.json is the authentication contract between the broker and every
  // pipe client. A stale one (the broker died without rewriting it) is why an
  // otherwise correct client gets E_UNAUTHORIZED, so name its contents here.
  const runtime = readRuntime()
  if (!runtime) {
    if (pipe.ok) {
      fail(
        `${RUNTIME_FILE} is missing or unreadable, so no client can authenticate`,
        'The broker writes it on every start. Restart it:\n' + START_BROKER_COMMAND
      )
    } else {
      info(`${RUNTIME_FILE} is absent, which is expected while the broker has never run`)
    }
  } else if (!pipe.ok) {
    // The file outlives the process that wrote it, so its token is worthless
    // until a broker starts and rotates it. Saying so stops the next person
    // reading "token present" as evidence of a healthy broker.
    info(
      `${path.basename(RUNTIME_FILE)} is left over from a previous broker ` +
        `(pid ${runtime.pid ?? '?'}, version ${runtime.version ?? '?'}); it is rewritten on the next start`
    )
  } else {
    if (readRuntimeToken() === null) {
      fail(
        `${RUNTIME_FILE} carries no token, so every client will be refused`,
        `Delete it and restart the broker:\n${START_BROKER_COMMAND}`
      )
    } else {
      info(`runtime  pid ${runtime.pid ?? '?'}  version ${runtime.version ?? '?'}  token present`)
    }
    if (runtime.pipeName && runtime.pipeName !== PIPE_NAME) {
      fail(
        `runtime.json advertises ${runtime.pipeName}, but the contract says ${PIPE_NAME}`,
        'The running broker predates a change to PIPE_NAME in shared/protocol.mjs. Restart it:\n' +
          START_BROKER_COMMAND
      )
    }
  }

  /* 9 ------------------------------------------------------------------- */
  section('MCP server registered with Claude Code')
  // Every other component can be perfectly installed and Claude Code still has
  // no way in, because this entry is the only thing that tells it the bridge
  // exists. Nothing used to check it, and the path published in the README was
  // wrong, so this is a first-class check rather than a footnote.
  checkMcpRegistration()

  /* 10 ------------------------------------------------------------------ */
  // (see pruneDeadProfiles below for --prune)
  section('Configured profiles versus live profiles')
  if (process.argv.includes('--prune')) pruneDeadProfiles()
  const state = readJson(STATE_FILE, null)
  const configured = configuredLabels(state)

  if (!pipe.ok) {
    if (configured.length === 0) {
      warn('the broker is not answering and no profiles have ever been configured')
    } else {
      fail(
        `the broker is not answering, so none of the ${configured.length} configured profile(s) can be confirmed live`,
        'fix check 8 first, then re-run'
      )
      for (const label of configured) info(`configured  ${label}`)
    }
  } else {
    const board = await askBroker(OPS.GET_BOARD)
    if (!board.ok) {
      fail(
        `the broker accepted a connection but did not return a board (${board.error})`,
        `check the token in ${RUNTIME_FILE} and ${path.join(BASE_DIR, 'broker.log')}`
      )
    } else {
      // GET_BOARD resolves to a Board exactly as emptyBoard() shapes it, so
      // read it straight. The old second-guessing (result.board.lines) covered
      // a shape the broker never sends and would have hidden a real regression.
      const lines = Array.isArray(board.result?.lines) ? board.result.lines : []
      const now = typeof board.result?.now === 'number' ? board.result.now : Date.now()
      if (lines.length === 0) {
        fail(
          'the broker is running but no profile is connected',
          'Load the unpacked extension in each profile:\n' +
            `  ${EXTENSION_DIR}\n` +
            'chrome://extensions or brave://extensions, Developer mode on, Load unpacked.'
        )
      } else {
        const live = lines.filter((l) => l.present && l.link === LINK.READY)
        const notLive = lines.filter((l) => !(l.present && l.link === LINK.READY))
        if (notLive.length === 0) {
          pass(`all ${lines.length} configured profile(s) are connected and ready`)
        } else {
          // THE check. An unpacked extension that Chrome disabled produces no
          // error anywhere; it simply stops appearing. Naming it here is the
          // only way that becomes visible.
          fail(
            `${notLive.length} of ${lines.length} configured profile(s) are not live`,
            'A profile that vanished usually means its unpacked extension was disabled.\n' +
              'Open that profile\'s extensions page and check the toggle, then reload it.'
          )
        }
        for (const l of lines) {
          // Pad BEFORE coloring: ANSI codes are characters too, and padding a
          // colored string misaligns every row by the length of the escape.
          const live = l.present && l.link === LINK.READY
          const markText = (live ? 'ready' : l.present ? l.link || 'unknown' : 'absent').padEnd(7)
          const mark = live ? green(markText) : red(markText)
          const seen = l.lastSeenAt ? ago(now - l.lastSeenAt) : 'never'
          const claim = l.claimed === false ? ' UNCLAIMED' : ''
          console.log(
            `           ${mark}  ${String(l.label).padEnd(18)} ${String(l.vendorLabel || l.vendor || '').padEnd(6)} ` +
              `${String(l.profileDir ?? '?').padEnd(10)} tabs ${String(l.tabCount ?? '?').padStart(3)}  seen ${seen}${claim}`
          )
          if (l.warning) console.log(`                  ${yellow(l.warning)}`)
        }
        if (board.result?.panic) {
          fail('the broker is in PANIC and is refusing every operation', 'delete the PANIC file in ' + BASE_DIR)
        }
      }
    }
  }

  /* 11 ------------------------------------------------------------------ */
  section('Discovered browser profiles')
  const installed = installedBrowsers()
  info(`browsers installed: ${installed.map((b) => b.label).join(', ') || 'none found'}`)
  const profiles = allProfiles()
  if (profiles.length === 0) {
    warn('no profiles were readable from any browser Local State')
  } else {
    const labels = new Map()
    for (const p of profiles) {
      const label = deriveLabel(p.vendor, p)
      labels.set(label, (labels.get(label) || 0) + 1)
      console.log(
        `           ${String(label).padEnd(26)} ${String(p.vendorLabel).padEnd(6)} ` +
          `${String(p.dir).padEnd(10)} ${p.email || p.name}`
      )
    }
    const collisions = [...labels.entries()].filter(([, count]) => count > 1)
    if (collisions.length > 0) {
      warn(
        `derived label collision: ${collisions.map(([l, c]) => `${l} x${c}`).join(', ')}`,
        'Rename one in the extension options page. The custom label always wins.'
      )
    } else {
      pass(`${profiles.length} profile(s) discovered, all with distinct derived labels`)
    }
  }

  /* Summary -------------------------------------------------------------- */
  console.log('')
  console.log('-'.repeat(72))
  const parts = [
    `${tally.pass} passed`,
    tally.warn > 0 ? yellow(`${tally.warn} warning${tally.warn === 1 ? '' : 's'}`) : `${tally.warn} warnings`,
    tally.fail > 0 ? red(`${tally.fail} failed`) : `${tally.fail} failed`,
  ]
  console.log(` ${bold(parts.join('  '))}`)
  if (tally.fail === 0) {
    console.log(green(' The bridge looks healthy.'))
  } else {
    console.log(red(' The bridge is not healthy. Work the FAIL lines top down; they are ordered by dependency.'))
  }
  console.log('')
  return tally.fail === 0 ? 0 : 1
}

/**
 * Labels of every profile ever configured.
 *
 * state.json is `{ version, profiles: { <installId>: record } }`, written by
 * ProfileStore in bridged/profiles.mjs, which is the owner of that shape. An
 * earlier version guessed at three different container keys, which meant a
 * renamed field would have produced a confident "no profiles configured"
 * instead of an error anyone could act on.
 */
/**
 * Forget profiles whose browser is gone for good, under --prune.
 *
 * Check 10 deliberately shouts about a configured profile that is not live,
 * because a silently disabled unpacked extension looks exactly like that and is
 * otherwise invisible. But a profile whose user-data-dir no longer EXISTS on
 * disk is not a disabled extension - it is a browser that was deleted, or a
 * throwaway profile from an e2e run. Those are unambiguous, so they can be
 * dropped safely.
 *
 * The test is deliberately narrow: only a missing directory qualifies. A
 * browser that is merely closed keeps its directory, so a profile in normal use
 * can never be pruned by accident.
 */
function pruneDeadProfiles() {
  const state = readJson(STATE_FILE, null)
  const profiles = state?.profiles
  if (!profiles || typeof profiles !== 'object') {
    info('nothing to prune: no state file yet')
    return
  }

  const dropped = []
  for (const [installId, p] of Object.entries(profiles)) {
    const dir = p?.userDataDir
    if (typeof dir !== 'string' || dir === '') continue
    if (fs.existsSync(dir)) continue
    dropped.push(p.label || installId)
    delete profiles[installId]
  }

  if (dropped.length === 0) {
    info('--prune: nothing to forget, every configured profile still has its user-data-dir')
    return
  }
  writeJsonAtomic(STATE_FILE, state)
  info(`--prune: forgot ${dropped.length} profile(s) whose user-data-dir is gone: ${dropped.join(', ')}`)
  info('the broker keeps its own copy in memory; restart it to clear those too')
}

function configuredLabels(state) {
  const profiles = state?.profiles
  if (!profiles || typeof profiles !== 'object') return []
  return Object.values(profiles)
    .filter((v) => v && typeof v === 'object')
    .map((v) => v.label || v.installId || null)
    .filter(Boolean)
}

/**
 * Is the MCP server registered, and does it point at a file that exists?
 *
 * Three distinct failures, each with its own fix, and all three were invisible
 * before: no entry at all (Claude Code never sees the bridge), an entry whose
 * args path does not exist (a failed-to-connect banner with no explanation),
 * and a project-scope copy that silently overrides the user-scope one.
 */
function checkMcpRegistration() {
  const config = readJson(CLAUDE_JSON, null)
  if (!config) {
    fail(
      `${CLAUDE_JSON} is missing or is not valid JSON`,
      fs.existsSync(CLAUDE_JSON)
        ? 'Claude Code cannot read it either. Repair the file, then: node scripts/install-mcp.mjs'
        : 'node scripts/install-mcp.mjs'
    )
    return
  }

  const entry = config.mcpServers?.[MCP_ENTRY_NAME] ?? null
  if (!entry) {
    fail(
      `no "${MCP_ENTRY_NAME}" entry in mcpServers, so Claude Code has no way to reach the bridge`,
      'node scripts/install-mcp.mjs'
    )
  } else {
    const want = desiredEntry()
    const problems = []
    if (entry.type !== want.type) problems.push(`type is "${entry.type}", expected "${want.type}"`)
    if (entry.command !== want.command) {
      problems.push(`command is "${entry.command}", expected "${want.command}"`)
    }
    const args = Array.isArray(entry.args) ? entry.args : []
    const target = args[0]
    if (!target) {
      problems.push('args is empty, so nothing would be spawned')
    } else if (!fs.existsSync(target)) {
      problems.push(`args[0] does not exist on disk: ${target}`)
    } else if (!samePath(target, MCP_SERVER_ENTRY)) {
      // Not a failure: another checkout of this repo is a legitimate thing to
      // point at, and silently "fixing" it would hijack that install.
      warn(
        `the entry points at a different checkout: ${target}`,
        `This repo is ${MCP_SERVER_ENTRY}. Run node scripts/install-mcp.mjs to repoint it.`
      )
    }

    if (problems.length === 0) {
      pass(`mcpServers."${MCP_ENTRY_NAME}" spawns ${args[0]}`)
    } else {
      for (const p of problems) fail(p)
      printHint('node scripts/install-mcp.mjs')
    }
  }

  const shadows = Object.entries(config.projects || {})
    .filter(([, project]) => project?.mcpServers && Object.hasOwn(project.mcpServers, MCP_ENTRY_NAME))
    .map(([projectPath]) => projectPath)
  for (const projectPath of shadows) {
    warn(
      `projects["${projectPath}"] has its own "${MCP_ENTRY_NAME}" entry, which fully overrides the user-scope one there`,
      'Remove or update that per-project entry by hand. install-mcp never touches project scope.'
    )
  }
}

/** Windows paths differ in slash and case without differing at all. */
function samePath(a, b) {
  const norm = (p) => path.resolve(String(p)).replace(/[\\/]+/g, path.sep)
  return process.platform === 'win32'
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b)
}

function firstLine(s) {
  return String(s).split('\n')[0].trim()
}

main().then((code) => {
  process.exitCode = code
})
