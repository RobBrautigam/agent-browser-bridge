/**
 * doctor: is the RUNNING broker on the version its install folder holds?
 *
 * A `git pull` changes the folder, not the process. The broker reads its code
 * once, at start, so after an update it keeps running the old code until it is
 * restarted, and every client keeps talking to it. The MCP status tools already
 * told an agent, but doctor's only evidence was its `runtime` info line, which a
 * person had to read and compare with package.json by eye. The 0.5.0 upgrade
 * made that gap expensive: a broker that was never restarted kept the old
 * handshake, so clients kept sending it the token, and doctor did not say so.
 *
 * Two signals, both from runtime.json, which the broker writes on every start:
 * `version` (compared with the package.json of the folder a restart loads the
 * broker from) and `auth` (the handshake every client picks from it).
 *
 * The import is static on purpose. doctor only runs its checks when it is the
 * entry point, and a static import that names a missing export fails at link
 * time, before the module body runs, so this file can never start a doctor run
 * against a live broker.
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  RESTART_RUNNING_BROKER,
  UNREADABLE_BROKER_VERSION,
  brokerAgeReport,
  brokerAgeWarnings,
  brokerInstallRoot,
  compareVersions,
  unsupervisedBrokerHint,
} from '../scripts/doctor.mjs'
import {
  buildLaunchdPlist,
  buildLauncherBoot,
  buildSystemdUnit,
  parseServiceBrokerEntry,
} from '../scripts/install-broker.mjs'
import { AUTH_SCHEME } from '../shared/auth.mjs'
import { START_BROKER_COMMAND, TASK_NAME } from '../shared/paths.mjs'

const runtime = (fields) => ({ pipeName: 'p', token: 't', pid: 1, startedAt: 0, ...fields })
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-broker-age-'))
after(() => fs.rmSync(TEMP_ROOT, { recursive: true, force: true }))

/** A throwaway install folder holding only a package.json at `version`. */
function fakeInstall(name, version) {
  const root = path.join(TEMP_ROOT, name)
  fs.mkdirSync(path.join(root, 'bridged'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version }), 'utf8')
  return { root, entry: path.join(root, 'bridged', 'index.mjs') }
}

/* -------------------------------------------------------------------------- */
/* compareVersions                                                             */
/* -------------------------------------------------------------------------- */

test('compareVersions orders by number, not by text', () => {
  assert.equal(compareVersions('0.5.0', '0.5.1'), -1)
  assert.equal(compareVersions('0.5.1', '0.5.0'), 1)
  assert.equal(compareVersions('0.5.1', '0.5.1'), 0)
  // The case a string comparison gets wrong.
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1)
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1)
  // A missing part counts as zero.
  assert.equal(compareVersions('1.0', '1.0.0'), 0)
})

test('compareVersions follows semver precedence for pre-releases and ignores build metadata', () => {
  assert.equal(compareVersions('0.6.0-rc.1', '0.5.1'), 1)
  assert.equal(compareVersions('0.5.1', '0.6.0-rc.1'), -1)
  // A pre-release sorts before its own release.
  assert.equal(compareVersions('0.6.0-rc.1', '0.6.0'), -1)
  assert.equal(compareVersions('0.6.0', '0.6.0-rc.1'), 1)
  // Numeric identifiers compare as numbers, and sort before text ones.
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1)
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1)
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1)
  // A longer set of fields sorts after its prefix.
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.1'), 0)
  assert.equal(compareVersions('1.0.0+build.7', '1.0.0'), 0)
})

test('compareVersions returns null for anything that is not a version', () => {
  for (const bad of [undefined, null, '', 'abc', '0.5.x', '1..2', '1.0.0-', 42, {}]) {
    assert.equal(compareVersions(bad, '0.5.1'), null, `${JSON.stringify(bad)} was compared`)
    assert.equal(compareVersions('0.5.1', bad), null, `${JSON.stringify(bad)} was compared`)
  }
})

/* -------------------------------------------------------------------------- */
/* brokerAgeWarnings                                                           */
/* -------------------------------------------------------------------------- */

test('a current broker draws no warning', () => {
  assert.deepEqual(brokerAgeWarnings(runtime({ version: '0.5.1', auth: AUTH_SCHEME }), '0.5.1'), [])
})

test('a broker older than its folder draws one warning with the restart step', () => {
  const warnings = brokerAgeWarnings(runtime({ version: '0.5.0', auth: AUTH_SCHEME }), '0.5.1')
  assert.equal(warnings.length, 1)
  const [w] = warnings
  assert.match(w.text, /\bolder\b/)
  assert.ok(w.text.includes('0.5.0') && w.text.includes('0.5.1'), `both versions named: ${w.text}`)
  assert.ok(w.hint.includes(RESTART_RUNNING_BROKER), 'the hint carries the restart step')
  assert.ok(w.hint.includes('version 0.5.1'), 'the hint says what doctor should read afterwards')
})

test('the version check is numeric: 0.9.0 is older than 0.10.0', () => {
  const warnings = brokerAgeWarnings(runtime({ version: '0.9.0', auth: AUTH_SCHEME }), '0.10.0')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].text, /\bolder\b/)
})

test('a folder on a pre-release still draws the warning', () => {
  const warnings = brokerAgeWarnings(runtime({ version: '0.5.1', auth: AUTH_SCHEME }), '0.6.0-rc.1')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].text, /\bolder\b/)
})

test('a broker newer than its folder also draws one warning, worded as newer', () => {
  // The folder was moved back to an older release while the broker ran on. The
  // running code is still not the folder's code, and the same restart fixes it.
  const warnings = brokerAgeWarnings(runtime({ version: '0.6.0', auth: AUTH_SCHEME }), '0.5.1')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].text, /\bnewer\b/)
  assert.doesNotMatch(warnings[0].text, /\bolder\b/)
  assert.ok(warnings[0].hint.includes(RESTART_RUNNING_BROKER))
})

test('a broker that could not read its own version is not called older', () => {
  // bridged/index.mjs records 0.0.0 when package.json is unreadable at start.
  // "It started before the last update" would send the operator in a loop.
  const broker = fs.readFileSync(new URL('../bridged/index.mjs', import.meta.url), 'utf8')
  assert.ok(
    broker.includes(`?.version || '${UNREADABLE_BROKER_VERSION}')`),
    'the broker and doctor must agree on the unreadable-version marker'
  )
  const warnings = brokerAgeWarnings(runtime({ version: UNREADABLE_BROKER_VERSION, auth: AUTH_SCHEME }), '0.5.1')
  assert.equal(warnings.length, 1)
  assert.doesNotMatch(warnings[0].text, /\bolder\b/)
  assert.match(warnings[0].text, /could not read its package\.json/)
  assert.ok(warnings[0].hint.includes(RESTART_RUNNING_BROKER))
})

test('a runtime.json with no auth field draws the pre-0.5.0 warning', () => {
  for (const auth of [undefined, null]) {
    const fields = auth === undefined ? { version: '0.5.1' } : { version: '0.5.1', auth }
    const warnings = brokerAgeWarnings(runtime(fields), '0.5.1')
    assert.equal(warnings.length, 1, `auth ${auth} drew ${warnings.length} warnings`)
    assert.match(warnings[0].text, /no auth field/)
    assert.match(warnings[0].text, /before 0\.5\.0/)
    assert.ok(warnings[0].hint.includes(RESTART_RUNNING_BROKER))
  }
})

test('an auth value clients do not speak draws a warning too, because they refuse to dial on it', () => {
  // shared/auth.mjs runtimeScheme: anything but the one known scheme is no
  // scheme, and helloCredentials gives a client nothing to send.
  for (const auth of ['', 'hmac-sha256-v2', 42]) {
    const warnings = brokerAgeWarnings(runtime({ version: '0.5.1', auth }), '0.5.1')
    assert.equal(warnings.length, 1, `auth ${JSON.stringify(auth)} drew ${warnings.length} warnings`)
    assert.match(warnings[0].text, /does not speak/)
    assert.match(warnings[0].text, /refuse to dial/)
    assert.doesNotMatch(warnings[0].text, /sending the token/)
  }
})

test('a 0.4.1 broker draws both warnings, the version first, and the restart step once', () => {
  const warnings = brokerAgeWarnings(runtime({ version: '0.4.1' }), '0.5.1')
  assert.equal(warnings.length, 2)
  assert.match(warnings[0].text, /\bolder\b/)
  assert.match(warnings[1].text, /no auth field/)
  assert.ok(warnings[0].hint.includes(RESTART_RUNNING_BROKER))
  assert.ok(!warnings[1].hint.includes(RESTART_RUNNING_BROKER), 'the second warning repeats the restart step')
  assert.match(warnings[1].hint, /restart above/)
})

test('an unreadable version draws no version verdict rather than a guess', () => {
  for (const version of [undefined, '', 'dev', 7]) {
    assert.deepEqual(brokerAgeWarnings(runtime({ version, auth: AUTH_SCHEME }), '0.5.1'), [])
  }
  // And a folder whose own version cannot be read compares nothing.
  assert.deepEqual(brokerAgeWarnings(runtime({ version: '0.5.0', auth: AUTH_SCHEME }), null), [])
})

test('no runtime at all draws nothing: that case has its own FAIL line', () => {
  assert.deepEqual(brokerAgeWarnings(null, '0.5.1'), [])
})

/* -------------------------------------------------------------------------- */
/* Which folder the broker is compared with                                    */
/* -------------------------------------------------------------------------- */

test('every supervisor file this project writes reads back to the broker entry it names', () => {
  // Paths with a space, a quote and an ampersand, so the escaping of each
  // format is exercised on the way out and undone on the way back.
  const entry = path.join(TEMP_ROOT, 'install "A" & B', 'bridged', 'index.mjs')
  assert.equal(parseServiceBrokerEntry(buildLauncherBoot({ entry })), entry, 'Windows boot file')
  assert.equal(parseServiceBrokerEntry(buildLaunchdPlist({ node: '/usr/bin/node', entry })), entry, 'launchd plist')
  assert.equal(parseServiceBrokerEntry(buildSystemdUnit({ node: '/usr/bin/node', entry })), entry, 'systemd unit')
  for (const junk of ['', 'not a supervisor file', null, undefined]) {
    assert.equal(parseServiceBrokerEntry(junk), null)
  }
})

test('the broker is compared with the folder its service starts it from', () => {
  const here = fakeInstall('this-checkout', '0.5.1')
  const other = fakeInstall('other-checkout', '0.5.0')
  const broker = runtime({ version: '0.5.0', auth: AUTH_SCHEME })

  // The service runs the broker from another checkout that is itself at 0.5.0:
  // a restart would load 0.5.0 again, so warning here would never clear.
  const elsewhere = brokerAgeReport(broker, other.entry, here.root)
  assert.equal(elsewhere.root, other.root)
  assert.equal(elsewhere.otherCheckout, true)
  assert.deepEqual(elsewhere.warnings, [])

  // The service runs it from this checkout, which a pull moved to 0.5.1.
  const local = brokerAgeReport(broker, here.entry, here.root)
  assert.equal(local.otherCheckout, false)
  assert.equal(local.warnings.length, 1)
  assert.match(local.warnings[0].text, /\bolder\b/)

  // No readable supervisor file: this checkout.
  assert.equal(brokerInstallRoot(null, here.root), here.root)
  assert.equal(brokerAgeReport(broker, null, here.root).warnings.length, 1)
})

/* -------------------------------------------------------------------------- */
/* The restart steps                                                           */
/* -------------------------------------------------------------------------- */

test('the restart step ends a running broker the safe way for this platform', () => {
  if (process.platform === 'win32') {
    // /Run does nothing while the task runs (IgnoreNew), and /Run straight
    // after /End starts a broker while the old one still holds the pipe. /End
    // first, and the task's watchdog starts the new one.
    assert.ok(
      RESTART_RUNNING_BROKER.startsWith(`schtasks /End /TN "${TASK_NAME}"`),
      RESTART_RUNNING_BROKER
    )
    assert.match(RESTART_RUNNING_BROKER, /watchdog/)
  } else {
    // launchctl kickstart -k and systemctl restart both restart a running one.
    assert.equal(RESTART_RUNNING_BROKER, START_BROKER_COMMAND)
  }
})

test('an unsupervised broker is stopped by its pid, never by ending the task', () => {
  const hint = unsupervisedBrokerHint(4242)
  assert.match(hint, /taskkill \/PID 4242 \/F/)
  assert.match(hint, /watchdog/)
  assert.doesNotMatch(hint, /schtasks/, '/End cannot reach a broker the task did not start')
  for (const pid of [undefined, null, 0, -1, 'x']) {
    const fallback = unsupervisedBrokerHint(pid)
    assert.doesNotMatch(fallback, /taskkill/)
    assert.match(fallback, /process id/)
  }
})

/* -------------------------------------------------------------------------- */
/* Wiring                                                                      */
/* -------------------------------------------------------------------------- */

test('check 8 prints the age report and every restart hint for a running broker', () => {
  // doctor's checks cannot run here: on Windows the pipe name is fixed, so a run
  // would talk to whatever broker this machine has. What can be checked is that
  // check 8 calls the tested pieces, and that no hint given while the broker
  // answers uses the plain start command, which does nothing to a running one.
  const src = fs.readFileSync(new URL('../scripts/doctor.mjs', import.meta.url), 'utf8')
  assert.match(src, /brokerAgeReport\(\s*runtime\s*,\s*readServiceBrokerEntry\(\)\s*\)/)
  assert.match(src, /for\s*\(\s*const (\w+) of age\.warnings\s*\)\s*warn\(\s*\1\.text\s*,\s*\1\.hint\s*\)/)
  assert.match(src, /unsupervisedBrokerHint\(\s*readRuntime\(\)\?\.pid\s*\)/)
  const main = src.slice(src.indexOf('async function main()'))
  const uses = main.match(/START_BROKER_COMMAND/g) || []
  assert.equal(uses.length, 1, 'only "nothing is answering" may use the plain start command')
  assert.match(src, /if\s*\(\s*isMain\(import\.meta\.url\)\s*\)\s*\{\s*(?:await\s+)?main\(/, 'importing doctor must not run it')
})
