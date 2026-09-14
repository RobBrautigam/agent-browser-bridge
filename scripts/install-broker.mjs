#!/usr/bin/env node
/**
 * install-broker - keep exactly one broker alive, forever, without a service.
 *
 * The broker is the only stateful component and everything else dials it, so
 * "is it running?" must never be a question a human has to answer. Task
 * Scheduler gives us that with no admin rights and no third-party supervisor.
 *
 * Three settings carry the whole design, and each one is here because the
 * obvious configuration fails:
 *
 *   ExecutionTimeLimit PT0S   MANDATORY. The default is P3D, and Windows will
 *                             terminate a task that has been running for 72
 *                             hours. A bridge that dies every third day, at a
 *                             time nobody can predict, is worse than one that
 *                             never started. PT0S means no limit.
 *
 *   Repetition PT1M on a      The watchdog. Every minute Windows tries to start
 *   TIME trigger, with        the task; IgnoreNew makes that a no-op while the
 *   MultipleInstancesPolicy   broker is alive, and a restart within 60 seconds
 *   IgnoreNew                 when it is not.
 *
 *                             The trigger must be a TimeTrigger. A repetition
 *                             on the LogonTrigger alone does NOT tick: the
 *                             logon trigger has already fired for the current
 *                             session, so re-registering mid-session left the
 *                             watchdog dormant until the next logon. Measured
 *                             on the live task: NextRunTime empty, "Repeat:
 *                             Every: N/A", and a stopped broker that never came
 *                             back. A past StartBoundary does not fix that, and
 *                             a comment here used to claim it did.
 *
 *   RestartOnFailure          Kept, but it is NOT the watchdog: it only fires on
 *                             a non-zero exit, so a broker that exits cleanly
 *                             (or is killed) would never come back on its own.
 *                             That is exactly why the repetition exists.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  BASE_DIR,
  IS_MAC,
  IS_WINDOWS,
  LAUNCHD_PLIST_FILE,
  LAUNCHER_BOOT_FILE,
  LAUNCHER_VBS_FILE,
  LEGACY_LAUNCHER_FILES,
  LOG_FILE,
  START_ERROR_FILE,
  SUPERVISOR_STDERR_FILE,
  SYSTEMD_UNIT_FILE,
  TASK_NAME,
  ensureBaseDir,
  readRuntime,
} from '../shared/paths.mjs'
import { LAUNCHD_LABEL, SYSTEMD_UNIT } from '../shared/config.mjs'
import { PIPE_NAME, PRODUCT_NAME, PRODUCT_TAGLINE } from '../shared/protocol.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BROKER_ENTRY = path.join(REPO_ROOT, 'bridged', 'index.mjs')

/**
 * The scheduled task's name comes from the shared contract, never from a local
 * literal. Five call sites had independently typed this string and it already
 * disagreed with the docs, which is a class of bug where the installer creates
 * one task and the diagnostic looks for another.
 *
 * Re-exported so the existing import in doctor.mjs and anything else reaching
 * for it here keeps resolving to the same single value.
 */
export { TASK_NAME }

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const paint = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s)
const bold = (s) => paint('1', s)
const green = (s) => paint('32', s)
const yellow = (s) => paint('33', s)
const red = (s) => paint('31', s)
const dim = (s) => paint('2', s)

/* -------------------------------------------------------------------------- */
/* schtasks helpers, exported for doctor.mjs                                   */
/* -------------------------------------------------------------------------- */

export function schtasksExe() {
  const sysRoot = process.env.SystemRoot || process.env.windir
  if (sysRoot) {
    const abs = path.join(sysRoot, 'System32', 'schtasks.exe')
    if (fs.existsSync(abs)) return abs
  }
  return 'schtasks.exe'
}

/**
 * wscript.exe, resolved absolutely.
 *
 * It is the whole reason the window is gone: wscript is a GUI subsystem binary,
 * so it allocates no console of its own, and the child it starts with window
 * style 0 never shows one either. Resolving it through %SystemRoot% rather than
 * trusting PATH matters because the task stores this string permanently.
 */
export function wscriptExe() {
  const sysRoot = process.env.SystemRoot || process.env.windir
  if (sysRoot) {
    const abs = path.join(sysRoot, 'System32', 'wscript.exe')
    if (fs.existsSync(abs)) return abs
  }
  return 'wscript.exe'
}

/**
 * schtasks writes its XML in UTF-16 on some Windows builds and in the console
 * codepage on others, so sniff rather than assume. Getting this wrong turns a
 * healthy task into a "cannot parse" diagnostic, which is the opposite of the
 * point.
 */
export function decodeMaybeUtf16(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  // Heuristic: ASCII text encoded UTF-16LE has a NUL in every odd position.
  if (buf.length >= 8 && buf[1] === 0x00 && buf[3] === 0x00 && buf[5] === 0x00) {
    return buf.toString('utf16le')
  }
  return buf.toString('utf8')
}

/**
 * The task's LIVE definition, as Windows holds it.
 * @returns {{exists:boolean, xml:string|null, error:string|null}}
 */
export function queryTaskXml(taskName = TASK_NAME) {
  try {
    const out = execFileSync(schtasksExe(), ['/query', '/tn', taskName, '/xml', 'ONE'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 4 * 1024 * 1024,
    })
    return { exists: true, xml: decodeMaybeUtf16(out), error: null }
  } catch (err) {
    const stderr = err?.stderr ? decodeMaybeUtf16(Buffer.from(err.stderr)) : ''
    return { exists: false, xml: null, error: (stderr || String(err?.message || err)).trim() }
  }
}

/**
 * Does the task have a RUNNING INSTANCE right now?
 *
 * Deliberately the text query rather than the XML: the XML is the task's
 * DEFINITION and says nothing about whether an instance is live, which is the
 * only thing this asks. A task that cannot be queried answers true, so a
 * missing task raises one alarm in the caller rather than two.
 */
export function taskHasRunningInstance(taskName = TASK_NAME) {
  try {
    const out = execFileSync(schtasksExe(), ['/query', '/tn', taskName, '/fo', 'LIST'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    })
    return /Status:\s*Running/i.test(decodeMaybeUtf16(out))
  } catch {
    return true
  }
}

/**
 * The command the task actually runs, from the Actions block.
 *
 * doctor asserts this is the hidden launcher. A reinstall from an older
 * checkout, or a hand edit in the Task Scheduler UI, would silently put
 * node.exe back and bring the popping windows with it; this is what makes that
 * regression visible instead of merely annoying.
 */
export function execCommand(xml) {
  if (!xml) return null
  const actions = /<Actions\b[^>]*>([\s\S]*?)<\/Actions>/.exec(xml)
  const scope = actions ? actions[1] : xml
  const m = /<Command>([\s\S]*?)<\/Command>/.exec(scope)
  return m ? m[1].trim() : null
}

/** Is the task's command the hidden launcher rather than a bare node.exe? */
export function isHiddenLauncherCommand(command) {
  if (typeof command !== 'string') return false
  // path.win32 explicitly: the task command is always a Windows path, and
  // the platform-default basename would treat a backslash as an ordinary
  // character if these helpers were ever exercised off Windows.
  return path.win32.basename(command.trim()).toLowerCase() === 'wscript.exe'
}

/** Pull one element's text out of the Settings block specifically. */
export function settingValue(xml, name) {
  if (!xml) return null
  const settings = /<Settings\b[^>]*>([\s\S]*?)<\/Settings>/.exec(xml)
  const scope = settings ? settings[1] : xml
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(scope)
  return m ? m[1].trim() : null
}

/* -------------------------------------------------------------------------- */

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * DOMAIN\\user, which is what Task Scheduler wants in UserId.
 *
 * whoami.exe is resolved absolutely on purpose: run from Git Bash, a bare
 * `whoami` finds the MSYS one first, which prints the bare username with no
 * domain. Task Scheduler is more likely to resolve the qualified form, and a
 * task registered against the wrong principal fails at logon rather than now.
 */
function currentUserId() {
  const fallback = `${process.env.USERDOMAIN || os.hostname()}\\${process.env.USERNAME || 'user'}`
  const sysRoot = process.env.SystemRoot || process.env.windir
  const exe = sysRoot ? path.join(sysRoot, 'System32', 'whoami.exe') : null
  if (!exe || !fs.existsSync(exe)) return fallback
  try {
    const out = execFileSync(exe, { encoding: 'utf8' }).trim()
    return out.includes('\\') ? out : fallback
  } catch {
    return fallback
  }
}

/**
 * The bootstrap module the launcher actually runs.
 *
 * It exists to catch the one class of failure the broker's own logger cannot:
 * an error thrown while the entry module is being parsed or imported, which
 * happens before any of the broker's code runs. That used to be visible in the
 * console window, and removing the window would otherwise have removed the only
 * place it was ever reported.
 *
 * The file is deleted at the start of every launch and written only on failure,
 * so its ABSENCE is the healthy state and its presence is always the reason the
 * last start did not take.
 */
export function buildLauncherBoot({ entry = BROKER_ENTRY, startErrorFile = START_ERROR_FILE } = {}) {
  const entryUrl = pathToFileURL(entry).href
  return [
    '// Broker bootstrap. GENERATED by scripts/install-broker.mjs.',
    '// Edit that, not this.',
    '//',
    '// Catches an import-time failure of the broker entry and records it, because',
    '// the broker has no logger yet at that point and the launcher has no console.',
    "import fs from 'node:fs'",
    '',
    `const START_ERROR_FILE = ${JSON.stringify(startErrorFile)}`,
    `const ENTRY = ${JSON.stringify(entryUrl)}`,
    '',
    '// Absence of the file means the last start was clean.',
    'try {',
    '  fs.rmSync(START_ERROR_FILE, { force: true })',
    '} catch {',
    '  /* a stale file is not a reason to refuse to start */',
    '}',
    '',
    'try {',
    '  await import(ENTRY)',
    '} catch (err) {',
    '  try {',
    "    fs.writeFileSync(START_ERROR_FILE, `${new Date().toISOString()}\\n${err?.stack || err}\\n`, 'utf8')",
    '  } catch {',
    '    /* nothing left to report with */',
    '  }',
    '  process.exit(1)',
    '}',
    '',
  ].join('\r\n')
}

/**
 * The .vbs launcher: the layer that removes the window.
 *
 * node.exe is a console subsystem binary, so Task Scheduler starting it under an
 * interactive token allocated a console and showed its window at every launch.
 * That window was not only the interruption: closing it sent CTRL_CLOSE_EVENT to
 * the broker, which killed it, and the task's one minute repetition then started
 * another one. The annoyance and the restart loop were the same defect.
 *
 * wscript.exe is a GUI subsystem binary, so it has no console of its own, and
 * Run with intWindowStyle 0 starts the child hidden with no flash.
 *
 * Two arguments here are load bearing and both defaults are wrong:
 *
 *   0     SW_HIDE. This is what removes the window.
 *   True  bWaitOnReturn. wscript then lives exactly as long as the broker, so
 *         Task Scheduler still sees a running instance and IgnoreNew keeps
 *         suppressing the minute-ly start. False would end the task instance at
 *         once and turn the watchdog into a launch-every-minute loop.
 *
 * node is started DIRECTLY, with no cmd.exe in between, and that is deliberate.
 * schtasks /end terminates only the task's own process; an intermediate process
 * would leave the broker orphaned while Task Scheduler believed nothing was
 * running. Because node's parent is wscript, BRIDGE_WATCH_PARENT lets the
 * broker notice and stand down.
 */
export function buildLauncherVbs({
  node = process.execPath,
  bootFile = LAUNCHER_BOOT_FILE,
  startErrorFile = START_ERROR_FILE,
} = {}) {
  const q = String.fromCharCode(34)
  const vbsString = (value) => q + value.split(q).join(q + q) + q
  return [
    "' Broker launcher. GENERATED by scripts/install-broker.mjs.",
    "' Edit that, not this.",
    "'",
    "' wscript.exe is a GUI subsystem binary, so nothing here allocates a console.",
    "' Run(cmd, 0, True) starts the broker hidden and blocks for its whole life,",
    "' which is what keeps the scheduled task instance alive and the minute-ly",
    "' repetition suppressed.",
    "'",
    "' Nothing in this file may call WScript.Echo: under wscript that is a modal",
    "' dialog, which would be a worse interruption than the window it removed.",
    'Option Explicit',
    'Dim sh, env, node',
    'Set sh = CreateObject("WScript.Shell")',
    'Set env = sh.Environment("PROCESS")',
    "' Same override contract as host/bridge-host.cmd, so there is one way",
    "' to point this machine at a different Node build rather than two.",
    'node = env("BRIDGE_NODE")',
    `If node = "" Then node = ${vbsString(node)}`,
    "' The broker skips its stderr echo: with no console there is no reader, and",
    "' the file log is unaffected.",
    'env("BRIDGE_QUIET") = "1"',
    "' Tells the broker to stand down if this process is ended without it.",
    'env("BRIDGE_WATCH_PARENT") = "1"',
    'Dim rc',
    `rc = sh.Run(${vbsString(q)} & node & ${vbsString(q + ' ' + q)} & ${vbsString(bootFile)} & ${vbsString(q)}, 0, True)`,
    "' A non-zero exit with nothing on disk to explain it is how a hidden",
    "' launcher becomes undiagnosable. The bootstrap only writes its file when",
    "' the entry import throws, so anything failing earlier, or node failing to",
    "' start at all, would otherwise leave no trace. Observed live: a relaunch",
    "' returned 1 and the only evidence anywhere was the task's own result code.",
    "' Never overwrite: the bootstrap's message says far more than an exit code.",
    'If rc <> 0 Then',
    '  Dim fso',
    '  Set fso = CreateObject("Scripting.FileSystemObject")',
    `  If Not fso.FileExists(${vbsString(startErrorFile)}) Then`,
    '    Dim f',
    `    Set f = fso.CreateTextFile(${vbsString(startErrorFile)}, True)`,
    '    f.WriteLine Now & " the launcher exited with code " & rc & ", and the broker recorded no reason"',
    '    f.Close',
    '  End If',
    'End If',
    'WScript.Quit rc',
    '',
  ].join('\r\n')
}

/** The arguments that make wscript run the launcher quietly and without dialogs. */
export function launcherArguments(vbsFile = LAUNCHER_VBS_FILE) {
  const q = String.fromCharCode(34)
  // //nologo drops the banner; //B is batch mode, which turns a script error
  // into a non-zero exit instead of a modal dialog on the operator's screen.
  return `//nologo //B ${q}${vbsFile}${q}`
}

/**
 * A naive ISO timestamp in the machine's LOCAL time.
 *
 * Task Scheduler reads a StartBoundary with no zone suffix as local time.
 * toISOString() returns UTC, so using it wrote a boundary that was wrong by the
 * machine's UTC offset: four hours into the future here, which left the
 * watchdog inert for four hours after every install, and would have been four
 * hours in the past somewhere else. Neither is what the caller asked for.
 */
export function localIsoNoZone(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/**
 * Element order follows the Task Scheduler schema (triggerBaseType puts
 * Repetition before Enabled) and matches what the Task Scheduler UI itself
 * exports. Windows rejects the whole file if the order is wrong, so this is not
 * cosmetic.
 */
export function buildTaskXml() {
  const user = currentUserId()
  const now = new Date()
  // Sixty seconds in the past, in LOCAL time, so the first occurrence is
  // already due and Windows fires it at once instead of at the next boundary.
  const start = localIsoNoZone(new Date(now.getTime() - 60_000))

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Date>${xmlEscape(localIsoNoZone(now))}</Date>
    <Author>${xmlEscape(user)}</Author>
    <Description>${xmlEscape(`${PRODUCT_NAME} - ${PRODUCT_TAGLINE}. Always-on broker for the browser bridge.`)}</Description>
    <URI>\\${xmlEscape(TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <!-- The watchdog. An omitted Duration means repeat indefinitely, and
         StartWhenAvailable plus a StartBoundary already in the past makes the
         first occurrence fire now rather than at the next boundary. -->
    <TimeTrigger>
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>${xmlEscape(start)}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
    <!-- Kept so a fresh logon starts the broker at once instead of waiting up
         to a minute for the repetition above. -->
    <LogonTrigger>
      <StartBoundary>${xmlEscape(start)}</StartBoundary>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <!-- DisallowStartOnRemoteAppSession and UseUnifiedSchedulingEngine are
         deliberately absent: both require Task schema 1.3, and this task
         declares 1.2 for maximum compatibility. Including them makes schtasks
         reject the whole definition with "The task XML contains an unexpected
         node", which names the element but not the reason. Neither setting is
         needed here. -->
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(wscriptExe())}</Command>
      <Arguments>${xmlEscape(launcherArguments())}</Arguments>
      <WorkingDirectory>${xmlEscape(REPO_ROOT)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`
}

/** Is anything listening on the broker's pipe right now? */
function pipeAnswers(timeoutMs = 1500) {
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
    const timer = setTimeout(() => done(false), timeoutMs)
    sock.on('connect', () => done(true))
    sock.on('error', () => done(false))
  })
}

async function waitForPipe(seconds) {
  for (let i = 0; i < seconds; i++) {
    if (await pipeAnswers()) return true
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}

/* -------------------------------------------------------------------------- */

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`
${bold(`${PRODUCT_NAME} install-broker`)}

  node scripts/install-broker.mjs             register the task, run it, verify the pipe
  node scripts/install-broker.mjs --dry-run   print the task XML, change nothing
  node scripts/install-broker.mjs --uninstall remove the task
`)
    return 0
  }

  if (!IS_WINDOWS) {
    return argv.includes('--uninstall')
      ? await uninstallPosix()
      : await installPosix({ dryRun: argv.includes('--dry-run') })
  }

  if (argv.includes('--uninstall')) return await uninstall()

  const dryRun = argv.includes('--dry-run')
  const xml = buildTaskXml()

  console.log(bold(`${PRODUCT_NAME} install-broker`))
  console.log(dim(`  task           ${TASK_NAME}`))
  console.log(dim(`  command        ${wscriptExe()}`))
  console.log(dim(`  arguments      ${launcherArguments()}`))
  console.log(dim(`  launcher       ${LAUNCHER_VBS_FILE}`))
  console.log(dim(`                 ${LAUNCHER_BOOT_FILE}`))
  console.log(dim(`  node           ${process.execPath}`))
  console.log(dim(`  broker         ${BROKER_ENTRY}`))
  console.log(dim(`  start errors   ${START_ERROR_FILE}`))
  console.log(dim(`  pipe           ${PIPE_NAME}`))
  console.log('')

  if (dryRun) {
    console.log(yellow('--dry-run: nothing was written or registered.'))
    console.log('')
    console.log(bold(`  ${LAUNCHER_VBS_FILE}`))
    console.log('')
    console.log(buildLauncherVbs())
    console.log(bold(`  ${LAUNCHER_BOOT_FILE}`))
    console.log('')
    console.log(buildLauncherBoot())
    console.log(bold('  task XML'))
    console.log('')
    console.log(xml)
    return 0
  }

  if (!fs.existsSync(BROKER_ENTRY)) {
    console.error(red(`FATAL: the broker entry point is missing: ${BROKER_ENTRY}`))
    console.error('       Registering a task that runs a file that does not exist would produce')
    console.error('       a task that silently fails every minute forever.')
    return 1
  }

  ensureBaseDir()

  // The shim goes down FIRST. Registering a task whose command does not exist
  // yet would leave a minute-ly launch of nothing, which is the same silent
  // failure mode the missing-broker-entry check above guards against.
  fs.writeFileSync(LAUNCHER_BOOT_FILE, buildLauncherBoot(), 'utf8')
  fs.writeFileSync(LAUNCHER_VBS_FILE, buildLauncherVbs(), 'utf8')
  // An earlier shape put a cmd.exe between wscript and node. Leaving it behind
  // would look live to anyone reading the directory.
  for (const stale of LEGACY_LAUNCHER_FILES) fs.rmSync(stale, { force: true })
  console.log(green('wrote the hidden launcher'))
  console.log(dim(`  ${LAUNCHER_VBS_FILE}`))
  console.log(dim(`  ${LAUNCHER_BOOT_FILE}`))

  // schtasks reads the XML file; UTF-16LE with a BOM is the encoding it accepts
  // on every Windows build, and the declaration above says UTF-16 to match.
  const xmlFile = path.join(BASE_DIR, 'task-definition.xml')
  fs.writeFileSync(xmlFile, Buffer.from('\uFEFF' + xml, 'utf16le'))

  try {
    execFileSync(schtasksExe(), ['/create', '/tn', TASK_NAME, '/xml', xmlFile, '/f'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    console.error(red('FATAL: schtasks /create failed.'))
    const stderr = err?.stderr ? decodeMaybeUtf16(Buffer.from(err.stderr)) : ''
    const stdout = err?.stdout ? decodeMaybeUtf16(Buffer.from(err.stdout)) : ''
    console.error((stderr || stdout || String(err?.message || err)).trim())
    console.error(dim(`       The XML that was rejected is still at ${xmlFile}`))
    return 1
  }
  console.log(green(`registered task "${TASK_NAME}"`))

  /* Verify the LIVE definition rather than the file we just wrote. */
  const live = queryTaskXml()
  if (!live.exists) {
    console.error(red('FAIL: the task does not come back from schtasks /query after creating it.'))
    return 1
  }
  const limit = settingValue(live.xml, 'ExecutionTimeLimit')
  if (limit !== 'PT0S') {
    console.error(red(`FAIL: live ExecutionTimeLimit is ${limit ?? '(absent)'}, expected PT0S.`))
    console.error('      Windows would terminate the broker after 72 hours.')
    return 1
  }
  const policy = settingValue(live.xml, 'MultipleInstancesPolicy')
  console.log(green(`verified live ExecutionTimeLimit=PT0S, MultipleInstancesPolicy=${policy}`))

  // The regression this guards against is specific and has already happened
  // once: a task whose Command is node.exe puts a console window on screen at
  // every launch, and closing that window kills the broker.
  if (!/<TimeTrigger>[\s\S]*?<Interval>PT1M<\/Interval>[\s\S]*?<\/TimeTrigger>/.test(live.xml)) {
    console.error(red('FAIL: the live task has no repeating TimeTrigger.'))
    console.error('      Without it nothing restarts the broker until the next logon.')
    return 1
  }
  console.log(green('verified the watchdog repetition is on a time trigger'))

  const command = execCommand(live.xml)
  if (!isHiddenLauncherCommand(command)) {
    console.error(red(`FAIL: live task command is ${command ?? '(absent)'}, expected wscript.exe.`))
    console.error('      A console subsystem command here shows a window at every launch.')
    return 1
  }
  console.log(green('verified the task runs the hidden launcher, so no window appears'))

  /* Start it now, so the install ends with a running broker, not a promise. */
  try {
    execFileSync(schtasksExe(), ['/run', '/tn', TASK_NAME], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    const stderr = err?.stderr ? decodeMaybeUtf16(Buffer.from(err.stderr)) : ''
    console.log(yellow(`NOTE: schtasks /run reported: ${(stderr || err?.message || '').trim()}`))
  }

  console.log(dim('  waiting for the broker to answer on the pipe...'))
  const answered = await waitForPipe(15)
  if (!answered) {
    console.error('')
    console.error(red(`FAIL: nothing is answering on ${PIPE_NAME} after 15 seconds.`))
    console.error('      The task is registered. Check the broker log for why it exited:')
    console.error(`        ${path.join(BASE_DIR, 'broker.log')}`)
    console.error(`      Run it in the foreground to see the error: node ${BROKER_ENTRY}`)
    return 1
  }

  console.log('')
  console.log(green(`Broker is answering on ${PIPE_NAME}.`))
  console.log('')
  console.log('  Next: node scripts/doctor.mjs')
  return 0
}

async function uninstall() {
  console.log(bold(`${PRODUCT_NAME} install-broker --uninstall`))

  // Ending the task stops wscript, and measurement showed that is ALL it
  // stops: the broker is a separate process and survives. So stop the broker
  // itself too, or uninstalling leaves one running with nothing supervising it.
  //
  // The pid comes from runtime.json, which is only trustworthy while a broker
  // is actually answering: a hard-killed broker leaves the file behind, Windows
  // reuses pids, and killing a stale one would terminate whatever now holds it.
  // The pipe check is what makes the pid safe to act on, so it gates the kill.
  const runtime = readRuntime()
  if (runtime?.pid && (await pipeAnswers())) {
    try {
      process.kill(runtime.pid, 'SIGTERM')
      console.log(dim(`  stopped broker pid ${runtime.pid}`))
    } catch {
      // Already gone, which is the state we wanted.
    }
  } else if (runtime?.pid) {
    console.log(dim(`  nothing is answering the pipe; leaving pid ${runtime.pid} alone`))
  }
  try {
    execFileSync(schtasksExe(), ['/end', '/tn', TASK_NAME], { stdio: 'ignore' })
  } catch {
    // Not running is a fine state to be in before deleting.
  }
  try {
    execFileSync(schtasksExe(), ['/delete', '/tn', TASK_NAME, '/f'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    const stderr = err?.stderr ? decodeMaybeUtf16(Buffer.from(err.stderr)) : ''
    if (/cannot find|does not exist/i.test(stderr)) {
      console.log(yellow(`task "${TASK_NAME}" was not registered. Nothing to remove.`))
      return 0
    }
    console.error(red('FATAL: schtasks /delete failed.'))
    console.error((stderr || String(err?.message || err)).trim())
    return 1
  }
  console.log(green(`removed task "${TASK_NAME}"`))

  for (const file of [LAUNCHER_VBS_FILE, LAUNCHER_BOOT_FILE, ...LEGACY_LAUNCHER_FILES]) {
    try {
      fs.rmSync(file, { force: true })
      console.log(dim(`  removed ${file}`))
    } catch (err) {
      console.log(yellow(`  could not remove ${file}: ${String(err?.message || err)}`))
    }
  }

  console.log(dim('  A broker started by hand, outside the task, is left alone.'))
  return 0
}

/* -------------------------------------------------------------------------- */
/* macOS (launchd agent) and Linux (systemd user unit)                         */
/* -------------------------------------------------------------------------- */

/**
 * Neither platform needs the Windows machinery: launchd's KeepAlive and
 * systemd's Restart=always restart a dead broker on their own, there is no
 * console window to hide, and there is no 72-hour execution limit. The broker
 * still logs to LOG_FILE itself; the supervisor only catches what escapes to
 * stderr before the logger exists, which is the same job the start-error file
 * does on Windows.
 *
 * Stated plainly: these two paths follow the platform documentation and have
 * not been exercised on a real Mac or Linux machine yet. Windows is the
 * reference platform.
 */
export function buildLaunchdPlist({ node = process.execPath, entry = BROKER_ENTRY } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(node)}</string>
    <string>${xmlEscape(entry)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(REPO_ROOT)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(SUPERVISOR_STDERR_FILE)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(SUPERVISOR_STDERR_FILE)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BRIDGE_QUIET</key>
    <string>1</string>
  </dict>
</dict>
</plist>
`
}

export function buildSystemdUnit({ node = process.execPath, entry = BROKER_ENTRY } = {}) {
  const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`
  return [
    '[Unit]',
    `Description=${PRODUCT_NAME} - ${PRODUCT_TAGLINE}. Always-on broker for the browser bridge.`,
    'After=default.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${q(node)} ${q(entry)}`,
    `WorkingDirectory=${REPO_ROOT}`,
    'Restart=always',
    'RestartSec=2',
    'Environment=BRIDGE_QUIET=1',
    `StandardOutput=append:${SUPERVISOR_STDERR_FILE}`,
    `StandardError=append:${SUPERVISOR_STDERR_FILE}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

function runTool(cmd, args, { allowFail = false } = {}) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (err) {
    if (!allowFail) throw err
    return { ok: false, out: String(err?.stderr || err?.stdout || err?.message || '').trim() }
  }
}

function launchdDomain() {
  return `gui/${process.getuid()}`
}

async function installPosix({ dryRun }) {
  const unitFile = IS_MAC ? LAUNCHD_PLIST_FILE : SYSTEMD_UNIT_FILE
  const body = IS_MAC ? buildLaunchdPlist() : buildSystemdUnit()

  console.log(bold(`${PRODUCT_NAME} install-broker`))
  console.log(dim(`  supervisor     ${IS_MAC ? 'launchd, per-user agent' : 'systemd, user unit'}`))
  console.log(dim(`  unit           ${unitFile}`))
  console.log(dim(`  node           ${process.execPath}`))
  console.log(dim(`  broker         ${BROKER_ENTRY}`))
  console.log(dim(`  socket         ${PIPE_NAME}`))
  console.log(dim(`  stderr         ${SUPERVISOR_STDERR_FILE}`))
  console.log('')

  if (dryRun) {
    console.log(yellow('--dry-run: nothing was written or registered.'))
    console.log('')
    console.log(bold(`  ${unitFile}`))
    console.log('')
    console.log(body)
    return 0
  }

  if (!fs.existsSync(BROKER_ENTRY)) {
    console.error(red(`FATAL: the broker entry point is missing: ${BROKER_ENTRY}`))
    return 1
  }

  ensureBaseDir()
  fs.mkdirSync(path.dirname(unitFile), { recursive: true })
  fs.writeFileSync(unitFile, body, 'utf8')
  console.log(green(`wrote ${unitFile}`))

  if (IS_MAC) {
    // bootout first so a re-run replaces the loaded definition instead of
    // being refused as "already loaded"; a failure there just means it was
    // not loaded yet.
    runTool('launchctl', ['bootout', `${launchdDomain()}/${LAUNCHD_LABEL}`], { allowFail: true })
    const boot = runTool('launchctl', ['bootstrap', launchdDomain(), unitFile], { allowFail: true })
    if (!boot.ok) {
      console.error(red('FATAL: launchctl bootstrap failed.'))
      console.error(boot.out)
      return 1
    }
    runTool('launchctl', ['kickstart', '-k', `${launchdDomain()}/${LAUNCHD_LABEL}`], { allowFail: true })
    console.log(green(`loaded ${LAUNCHD_LABEL} into ${launchdDomain()}`))
  } else {
    const reload = runTool('systemctl', ['--user', 'daemon-reload'], { allowFail: true })
    if (!reload.ok) {
      console.error(red('FATAL: systemctl --user daemon-reload failed. Is this a systemd user session?'))
      console.error(reload.out)
      return 1
    }
    const enable = runTool('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT], { allowFail: true })
    if (!enable.ok) {
      console.error(red('FATAL: systemctl --user enable --now failed.'))
      console.error(enable.out)
      return 1
    }
    console.log(green(`enabled ${SYSTEMD_UNIT}`))
  }

  console.log(dim('  waiting for the broker to answer on the socket...'))
  const answered = await waitForPipe(15)
  if (!answered) {
    console.error('')
    console.error(red(`FAIL: nothing is answering on ${PIPE_NAME} after 15 seconds.`))
    console.error('      The service is registered. Check why the broker exited:')
    console.error(`        ${LOG_FILE}`)
    console.error(`        ${SUPERVISOR_STDERR_FILE}`)
    console.error(`      Run it in the foreground to see the error: node ${BROKER_ENTRY}`)
    return 1
  }

  console.log('')
  console.log(green(`Broker is answering on ${PIPE_NAME}.`))
  console.log('')
  console.log('  Next: node scripts/doctor.mjs')
  return 0
}

async function uninstallPosix() {
  console.log(bold(`${PRODUCT_NAME} install-broker --uninstall`))
  const unitFile = IS_MAC ? LAUNCHD_PLIST_FILE : SYSTEMD_UNIT_FILE

  if (IS_MAC) {
    const out = runTool('launchctl', ['bootout', `${launchdDomain()}/${LAUNCHD_LABEL}`], { allowFail: true })
    console.log(out.ok ? green(`unloaded ${LAUNCHD_LABEL}`) : yellow(`${LAUNCHD_LABEL} was not loaded`))
  } else {
    const out = runTool('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT], { allowFail: true })
    console.log(out.ok ? green(`disabled ${SYSTEMD_UNIT}`) : yellow(`${SYSTEMD_UNIT} was not enabled`))
  }

  // The supervisor stops the broker with the unit. A broker started by hand
  // is left alone, exactly as on Windows.
  try {
    fs.rmSync(unitFile, { force: true })
    console.log(dim(`  removed ${unitFile}`))
  } catch (err) {
    console.log(yellow(`  could not remove ${unitFile}: ${String(err?.message || err)}`))
  }
  if (!IS_MAC) runTool('systemctl', ['--user', 'daemon-reload'], { allowFail: true })

  const runtime = readRuntime()
  if (runtime?.pid && (await pipeAnswers())) {
    console.log(yellow(`  a broker (pid ${runtime.pid}) is still answering; it was not started by the service, so it is left alone.`))
  }
  return 0
}

function isMain(metaUrl) {
  try {
    if (!process.argv[1]) return false
    return (
      fs.realpathSync(fileURLToPath(metaUrl)).toLowerCase() ===
      fs.realpathSync(process.argv[1]).toLowerCase()
    )
  } catch {
    return pathToFileURL(process.argv[1] || '').href === metaUrl
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
