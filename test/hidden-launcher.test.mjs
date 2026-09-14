/**
 * The scheduled task must never run a console subsystem binary, the watchdog
 * must actually tick, and the broker must never outlive the launcher that Task
 * Scheduler is watching.
 *
 * The defect these tests lock down: the task's action was node.exe directly.
 * Task Scheduler running that under an interactive token allocates a console,
 * so a terminal window appeared at every launch. Closing that window sent
 * CTRL_CLOSE_EVENT and killed the broker, and the task's one minute watchdog
 * repetition then started another one, with another window. The interruption
 * and the restart loop were the same bug.
 *
 * Three quieter defects came out of proving that fix, and each has tests here:
 *
 *   - schtasks /end terminates ONLY the task's own process. A first shape with
 *     cmd.exe between wscript and node left the broker orphaned while Task
 *     Scheduler believed nothing ran, and the repetition then spawned a no-op
 *     every minute forever. Invisible churn is still churn.
 *
 *   - The PT1M repetition sat on the LogonTrigger, which had already fired for
 *     the session, so it never ticked at all.
 *
 *   - StartBoundary was generated with toISOString(), which is UTC, while Task
 *     Scheduler reads a zone-less boundary as LOCAL time.
 *
 * ISOLATION: paths.mjs resolves BASE_DIR from %LOCALAPPDATA% at module load, and
 * install-broker.mjs re-exports paths derived from it. This file redirects that
 * variable to a temp directory BEFORE importing either, so nothing here can name
 * a path inside a running broker's real state directory. That is why the imports
 * are dynamic and why there is a hard assertion below that BASE_DIR really did
 * land in the temp tree.
 *
 * NOTHING here registers a task, writes outside the temp tree, or starts a
 * broker. The one subprocess is `node --check`, which parses without executing:
 * importing the generated bootstrap would start a real broker and then call
 * process.exit, which takes the test runner down with it. That is not
 * hypothetical, it happened while this file was being written.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-launcher-'))
// BRIDGE_HOME overrides the whole state directory on every platform, which is
// what keeps this file away from a live install's launcher and start-error log.
process.env.BRIDGE_HOME = path.join(TEMP_ROOT, 'state')

// Dynamic, and after the assignment above. Static imports are hoisted above it
// and both modules would compute the real BASE_DIR.
const paths = await import('../shared/paths.mjs')
const installer = await import('../scripts/install-broker.mjs')

const { BASE_DIR, LAUNCHER_VBS_FILE, LAUNCHER_BOOT_FILE, START_ERROR_FILE, processIsGone } = paths
const {
  buildLauncherBoot,
  buildLauncherVbs,
  buildTaskXml,
  execCommand,
  isHiddenLauncherCommand,
  launcherArguments,
  localIsoNoZone,
  settingValue,
  wscriptExe,
} = installer

test('the isolation actually took, so nothing here can touch a live broker', () => {
  assert.ok(
    BASE_DIR.startsWith(TEMP_ROOT),
    `BASE_DIR escaped the temp tree: ${BASE_DIR}. Every path assertion below would name the real state directory.`
  )
})

const BACKSLASH = String.fromCharCode(92)
const QUOTE = String.fromCharCode(34)
const win = (...parts) => parts.join(BACKSLASH)

/** The vbs explains its own rules in comments; assertions about CODE ignore them. */
const vbsCode = (vbs) =>
  vbs
    .split('\r\n')
    .filter((line) => !line.trimStart().startsWith("'"))
    .join('\n')

/**
 * Evaluate the VBS string concatenation in the Run call, so assertions can be
 * about the command line Windows actually receives rather than about the source
 * text that produces it. A test that only checks the source contains some quote
 * characters passes happily when neither path is quoted.
 */
function resolvedRunCommand(vbs) {
  const code = vbsCode(vbs)
  const nodeDefault = /If node = "" Then node = "((?:[^"]|"")*)"/.exec(code)
  assert.ok(nodeDefault, 'expected a fallback assignment for the node path')
  const node = nodeDefault[1].split(QUOTE + QUOTE).join(QUOTE)

  const call = /sh\.Run\((.*), 0, True\)/.exec(code)
  assert.ok(call, 'expected a Run call with an explicit window style and wait flag')

  return call[1]
    .split('&')
    .map((piece) => piece.trim())
    .map((piece) => {
      if (piece === 'node') return node
      const literal = /^"((?:[^"]|"")*)"$/.exec(piece)
      assert.ok(literal, `unexpected expression in the Run command: ${piece}`)
      return literal[1].split(QUOTE + QUOTE).join(QUOTE)
    })
    .join('')
}

/* -------------------------------------------------------------------------- */
/* isHiddenLauncherCommand                                                     */
/* -------------------------------------------------------------------------- */

test('a Windows path to wscript.exe is recognized as the hidden launcher', () => {
  assert.equal(isHiddenLauncherCommand(win('C:', 'Windows', 'System32', 'wscript.exe')), true)
})

test('node.exe is not the hidden launcher, which is the whole regression', () => {
  assert.equal(isHiddenLauncherCommand(win('C:', 'Program Files', 'nodejs', 'node.exe')), false)
})

test('the check is case insensitive, tolerates whitespace, and rejects a lookalike', () => {
  assert.equal(isHiddenLauncherCommand(`  ${win('C:', 'Windows', 'System32', 'WScript.EXE')}  `), true)
  // Forward slashes: schtasks echoes back whatever it was given.
  assert.equal(isHiddenLauncherCommand('C:/Windows/System32/wscript.exe'), true)
  assert.equal(isHiddenLauncherCommand(win('C:', 'evil', 'notwscript.exe')), false)
  for (const value of [null, undefined, 42, {}]) {
    assert.equal(isHiddenLauncherCommand(value), false)
  }
})

/* -------------------------------------------------------------------------- */
/* execCommand                                                                 */
/* -------------------------------------------------------------------------- */

test('execCommand reads the Command inside Actions, not one that appears elsewhere', () => {
  // This is not hypothetical: a stray backspace byte in the Actions pattern
  // once made the scope fall back to the whole document, which returned the
  // first Command anywhere and would have made the doctor check meaningless.
  const xml = [
    '<Task>',
    '  <Settings><Command>decoy.exe</Command></Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${win('C:', 'Windows', 'System32', 'wscript.exe')}</Command>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
  ].join('\n')
  assert.equal(execCommand(xml), win('C:', 'Windows', 'System32', 'wscript.exe'))
})

test('execCommand returns null rather than throwing on absent or empty input', () => {
  assert.equal(execCommand(null), null)
  assert.equal(execCommand('<Task><Actions></Actions></Task>'), null)
})

/* -------------------------------------------------------------------------- */
/* The task definition                                                         */
/* -------------------------------------------------------------------------- */

test('the task action runs wscript.exe, never a console subsystem binary', () => {
  const command = execCommand(buildTaskXml())
  assert.equal(isHiddenLauncherCommand(command), true)
  assert.equal(path.win32.basename(command).toLowerCase(), 'wscript.exe')
})

test('the task arguments point at the installed .vbs, in batch mode, quoted', () => {
  const xml = buildTaskXml()
  const args = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(xml)[1]
  // schtasks XML escapes the quotes; the unescaped form is what wscript sees.
  const unescaped = args.replace(/&quot;/g, QUOTE)
  assert.match(unescaped, /\/\/nologo/)
  // Batch mode, so a script error exits non-zero instead of opening a modal
  // dialog, which would be a worse interruption than the window we removed.
  assert.match(unescaped, /\/\/B\b/)
  // The exact installed path, not merely "something ending in .vbs": a default
  // that drifted from the constant the installer WRITES would register a task
  // launching a file that does not exist, every minute, forever.
  assert.ok(
    unescaped.includes(QUOTE + LAUNCHER_VBS_FILE + QUOTE),
    `arguments must quote ${LAUNCHER_VBS_FILE}, got ${unescaped}`
  )
})

test('the watchdog settings that predate this change are untouched', () => {
  const xml = buildTaskXml()
  // A task without PT0S is terminated by Windows after 72 hours.
  assert.equal(settingValue(xml, 'ExecutionTimeLimit'), 'PT0S')
  // IgnoreNew is what makes the minute-ly repetition a no-op while the broker
  // is alive. Losing it would start a second broker every minute.
  assert.equal(settingValue(xml, 'MultipleInstancesPolicy'), 'IgnoreNew')
})

test('the task XML is well formed and its elements are in schema order', () => {
  // Windows rejects the whole definition if the order is wrong, and this change
  // inserted a new trigger block. The failure mode is a task that never gets
  // registered at all.
  const xml = buildTaskXml()
  const stack = []
  for (const [, closing, name, selfClosing] of xml.matchAll(/<(\/?)([A-Za-z][\w.-]*)[^>]*?(\/?)>/g)) {
    if (name === 'xml' || selfClosing === '/') continue
    if (closing) {
      assert.equal(stack.pop(), name, `mismatched closing tag </${name}>`)
    } else {
      stack.push(name)
    }
  }
  assert.deepEqual(stack, [], 'every element must be closed')

  const order = ['RegistrationInfo', 'Triggers', 'Principals', 'Settings', 'Actions']
  const seen = order.map((tag) => xml.indexOf(`<${tag}`))
  assert.deepEqual(
    [...seen].sort((a, b) => a - b),
    seen,
    `top level elements must appear in ${order.join(', ')} order`
  )
})

/* -------------------------------------------------------------------------- */
/* The watchdog trigger                                                        */
/* -------------------------------------------------------------------------- */

test('the minute-ly repetition is on an ENABLED TimeTrigger', () => {
  // A repetition on the LogonTrigger alone does not tick: that trigger has
  // already fired for the current session, so re-registering mid-session left
  // the watchdog dormant until the next logon. Measured on the live task:
  // NextRunTime empty and a stopped broker that never came back.
  const xml = buildTaskXml()
  const timeTrigger = /<TimeTrigger>([\s\S]*?)<\/TimeTrigger>/.exec(xml)
  assert.ok(timeTrigger, 'there must be a TimeTrigger')
  assert.match(timeTrigger[1], /<Interval>PT1M<\/Interval>/)
  // Disabled is indistinguishable from absent at runtime, and produces exactly
  // the symptom that was measured: NextRunTime empty, broker never restarted.
  assert.match(timeTrigger[1], /<Enabled>true<\/Enabled>/)
  // An omitted Duration means repeat indefinitely. A Duration would give the
  // watchdog an expiry date, which is the failure this whole task guards.
  assert.equal(/<Duration>/.test(timeTrigger[1]), false)
})

test('a logon trigger is kept, so a fresh session does not wait a minute', () => {
  assert.match(buildTaskXml(), /<LogonTrigger>/)
})

test('localIsoNoZone renders LOCAL wall-clock time, whatever the machine offset', () => {
  // The bug: toISOString() is UTC, and Task Scheduler reads a zone-less
  // StartBoundary as LOCAL. On a UTC-4 machine that put the trigger four hours
  // into the FUTURE, so the watchdog was inert for four hours after install.
  //
  // Asserted against getFullYear/getMonth/... rather than a hardcoded string,
  // so this holds on every machine INCLUDING one running in UTC, where a
  // comparison against toISOString() would pass with the defect reintroduced.
  const d = new Date(2026, 0, 5, 9, 7, 3)
  const pad = (n) => String(n).padStart(2, '0')
  assert.equal(
    localIsoNoZone(d),
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
  assert.equal(localIsoNoZone(d), '2026-01-05T09:07:03')
  assert.equal(localIsoNoZone(d).endsWith('Z'), false)
  // The contract stated as a round trip, which is what Windows performs: it
  // parses the zone-less boundary as local time, so that must recover the
  // instant we meant. A UTC rendering fails this on every machine off UTC.
  assert.equal(new Date(localIsoNoZone(d)).getTime(), d.getTime())
})

test('localIsoNoZone differs from the UTC rendering unless the machine is on UTC', () => {
  // The one assertion that names the actual regression. Skipped rather than
  // faked when the machine really is on UTC, so it never reports a false pass.
  const d = new Date(2026, 5, 15, 12, 0, 0)
  if (d.getTimezoneOffset() === 0) return
  assert.notEqual(localIsoNoZone(d), d.toISOString().replace(/\.\d+Z$/, ''))
})

test('StartBoundary is in the past, so the first occurrence is already due', () => {
  const boundary = /<StartBoundary>([\s\S]*?)<\/StartBoundary>/.exec(buildTaskXml())[1]
  assert.match(boundary, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, 'no zone suffix, no milliseconds')
  // new Date() parses a zone-less string as local time, which is exactly what
  // Windows will do with it. On a UTC-4 machine the old UTC rendering landed
  // four hours ahead and this skew came out negative.
  const skewMs = Date.now() - new Date(boundary).getTime()
  assert.ok(skewMs > 0, `StartBoundary must be in the past, got a skew of ${skewMs}ms`)
  assert.ok(skewMs < 10 * 60_000, `StartBoundary should be about a minute back, got ${skewMs}ms`)
})

/* -------------------------------------------------------------------------- */
/* The .vbs launcher                                                           */
/* -------------------------------------------------------------------------- */

test('the vbs starts the child hidden, waits for it, and propagates its code', () => {
  const code = vbsCode(buildLauncherVbs())
  const call = /rc = sh\.Run\((.*)\)$/m.exec(code)
  assert.ok(call, 'the Run result must be captured, not discarded')
  const args = call[1].split(',').map((a) => a.trim())
  assert.equal(args.length, 3, 'Run needs all three arguments; the defaults are wrong for both')
  // 0 is SW_HIDE. This single argument is what removes the window.
  assert.equal(args[1], '0')
  // True keeps wscript alive for the broker's whole life, so Task Scheduler
  // still sees a running instance. False would end the task instance at once
  // and turn IgnoreNew's suppression into a launch-every-minute loop.
  assert.equal(args[2], 'True')
  // The task's own Last Result is the outermost signal that a launch failed.
  assert.match(code, /WScript\.Quit rc/)
})

test('a non-zero launch leaves a trace, without overwriting a richer one', () => {
  // Observed live: the watchdog relaunched the broker, the task recorded
  // LastTaskResult 1, and nothing on disk said why. The bootstrap only writes
  // its file when the ENTRY IMPORT throws, so a failure before node runs at all
  // left no evidence anywhere.
  const code = vbsCode(buildLauncherVbs())
  assert.match(code, /If rc <> 0 Then/)
  assert.ok(code.includes(START_ERROR_FILE), 'must write where doctor already looks')
  // The bootstrap's stack trace says far more than an exit code, so it wins.
  assert.match(code, /If Not fso\.FileExists\(/)
  const guard = code.indexOf('If Not fso.FileExists(')
  const create = code.indexOf('CreateTextFile(')
  assert.ok(guard > -1 && create > guard, 'the existence guard must precede the write')
})

test('the vbs starts node directly, with no intermediate process to orphan the broker', () => {
  // schtasks /end terminates ONLY the task's own process. Anything between
  // wscript and node survives it and takes the broker with it, leaving a broker
  // running that Task Scheduler no longer accounts for.
  const code = vbsCode(buildLauncherVbs())
  assert.equal(/cmd\.exe/i.test(code), false)
  assert.equal(/powershell/i.test(code), false)
})

test('the vbs runs the installed bootstrap, at its full path', () => {
  // A bare filename assertion passes for a launcher pointing at the wrong
  // directory, which would fail silently every minute forever.
  const command = resolvedRunCommand(buildLauncherVbs())
  assert.ok(
    command.includes(LAUNCHER_BOOT_FILE),
    `expected the command to name ${LAUNCHER_BOOT_FILE}, got ${command}`
  )
})

test('the resolved command quotes BOTH paths, which contain spaces on a real machine', () => {
  const node = win('C:', 'Program Files', 'nodejs', 'node.exe')
  const bootFile = win('C:', 'Users', 'Some User', 'AppData', 'broker-boot.mjs')
  // Asserted against the command line Windows receives, not against the source
  // text: an assertion that the source merely contains quote characters passes
  // when neither path is quoted, because the quotes come from the literals.
  assert.equal(
    resolvedRunCommand(buildLauncherVbs({ node, bootFile })),
    `${QUOTE}${node}${QUOTE} ${QUOTE}${bootFile}${QUOTE}`
  )
})

test('the BRIDGE_NODE override WINS over the installed default', () => {
  // Asserting the three strings merely exist passes for an inverted launcher
  // that assigns the hardcoded path first and can therefore never consult the
  // environment. The order is the whole contract.
  const node = win('C:', 'Program Files', 'nodejs', 'node.exe')
  const code = vbsCode(buildLauncherVbs({ node }))
  const readsEnv = code.indexOf('node = env("BRIDGE_NODE")')
  const fallback = code.indexOf('If node = "" Then node =')
  const runs = code.indexOf('sh.Run(')
  assert.ok(readsEnv > -1 && fallback > -1 && runs > -1, 'all three steps must be present')
  assert.ok(readsEnv < fallback, 'the environment must be read BEFORE the fallback assignment')
  assert.ok(fallback < runs, 'the fallback must be resolved before the command is built')
  // Same override contract as host/bridge-host.cmd, so there is one way to
  // repoint this machine at a different Node build rather than two.
  assert.ok(code.includes(node))
})

test('the vbs sets the two markers the broker reads', () => {
  const code = vbsCode(buildLauncherVbs())
  // No console means no reader for the stderr echo.
  assert.match(code, /env\("BRIDGE_QUIET"\) = "1"/)
  // Without this the broker would outlive a schtasks /end unsupervised.
  assert.match(code, /env\("BRIDGE_WATCH_PARENT"\) = "1"/)
})

test('the vbs never calls WScript.Echo, which under wscript is a modal dialog', () => {
  assert.equal(/WScript\.Echo/i.test(vbsCode(buildLauncherVbs())), false)
})

test('the vbs uses CRLF, since Windows Script Host reads it as a Windows text file', () => {
  const vbs = buildLauncherVbs()
  assert.ok(vbs.includes('\r\n'))
  assert.equal(/[^\r]\n/.test(vbs), false, 'every newline must be preceded by a carriage return')
})

/* -------------------------------------------------------------------------- */
/* The bootstrap module                                                        */
/* -------------------------------------------------------------------------- */

test('the bootstrap imports the broker entry as a file URL', () => {
  // A bare Windows path is not a valid import specifier; this is the difference
  // between the broker starting and the launcher failing on every boot.
  const boot = buildLauncherBoot({ entry: win('C:', 'dev', 'repo', 'bridged', 'index.mjs') })
  assert.match(boot, /const ENTRY = "file:\/\/\/C:\/dev\/repo\/bridged\/index\.mjs"/)
  assert.match(boot, /await import\(ENTRY\)/)
})

test('the bootstrap records an import failure to the installed path and exits non-zero', () => {
  const boot = buildLauncherBoot()
  assert.ok(boot.includes(JSON.stringify(START_ERROR_FILE)), 'must name the path doctor reads')
  assert.match(boot, /catch \(err\)/)
  assert.match(boot, /writeFileSync\(START_ERROR_FILE/)
  assert.match(boot, /process\.exit\(1\)/)
})

test('the bootstrap clears the error file first, so its absence means a clean start', () => {
  const boot = buildLauncherBoot()
  const clearIndex = boot.indexOf('rmSync(START_ERROR_FILE')
  const importIndex = boot.indexOf('await import(ENTRY)')
  assert.ok(clearIndex > -1 && importIndex > -1)
  assert.ok(clearIndex < importIndex, 'the clear must happen before the import it reports on')
})

test('the bootstrap is valid, parseable module source', () => {
  // It is generated code that only ever runs on a machine, at boot, with no
  // console attached. A syntax error here is invisible by construction.
  //
  // Checked in a CHILD process with --check, which parses without executing.
  // Importing it here would run it, and running it starts a real broker and
  // then calls process.exit, which takes the test runner down with it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-boot-check-'))
  const file = path.join(dir, 'boot.mjs')
  fs.writeFileSync(file, buildLauncherBoot(), 'utf8')
  try {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 30_000 })
    assert.equal(r.status, 0, `bootstrap does not parse:\n${r.stderr}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------------------------- */
/* The parent watch predicate                                                  */
/* -------------------------------------------------------------------------- */

test('processIsGone reports gone ONLY for ESRCH', () => {
  // The response to "gone" is to shut the broker down, taking every tab handle
  // with it and leaving the pipe empty until the next task repetition. So the
  // test is positive on the one error that means no such process, and every
  // other outcome is read as alive. A negative test against EPERM treated an
  // unrecognized error as death and killed healthy brokers.
  const throwing = (code) => () => {
    const err = new Error(String(code))
    if (code) err.code = code
    throw err
  }
  assert.equal(processIsGone(1234, throwing('ESRCH')), true)
  assert.equal(processIsGone(1234, throwing('EPERM')), false, 'EPERM means alive and not ours')
  assert.equal(processIsGone(1234, throwing('EACCES')), false, 'an unknown code must not mean dead')
  assert.equal(processIsGone(1234, throwing(undefined)), false, 'an error with no code is unknown')
})

test('processIsGone reports alive when the signal succeeds', () => {
  assert.equal(
    processIsGone(1234, () => {}),
    false
  )
})

test('processIsGone finds this very process alive, against the real OS', () => {
  assert.equal(processIsGone(process.pid), false)
})

/* -------------------------------------------------------------------------- */

test('launcherArguments quotes the script path it is given', () => {
  const vbs = win('C:', 'Some Dir', 'broker-launch.vbs')
  assert.ok(launcherArguments(vbs).includes(QUOTE + vbs + QUOTE))
})

test('wscriptExe resolves to a filename the launcher check accepts', () => {
  assert.equal(isHiddenLauncherCommand(wscriptExe()), true)
})
