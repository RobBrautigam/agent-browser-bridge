/**
 * Which version each profile is RUNNING, and the self-reload that fixes it.
 *
 * The fact this whole file exists to protect: a browser reads an unpacked
 * extension's code once, when it loads it. So "the version of this project" is
 * not one number, it is three, and they drift apart on purpose:
 *
 *   the version the BROKER is running   - fixed at broker start
 *   the version the FOLDER holds        - changes the moment somebody pulls
 *   the version a PROFILE is running    - changes only when that extension is
 *                                         reloaded, per profile
 *
 * Before 0.4.0 none of the three was visible anywhere, so "is my browser
 * running the code I just shipped" was unanswerable, and the answer was
 * routinely no. The rules below are what makes it answerable and fixable.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { ERR, LINK, describeExtensionReload, reloadRefusal } from '../shared/protocol.mjs'
import { MANIFEST_FILE, PACKAGE_FILE, installedExtensionVersion } from '../shared/config.mjs'
import { lineFor } from '../bridged/routes.mjs'
import { absentLine } from '../bridged/profiles.mjs'
import { parseArgs, reloadOne, selectTargets } from '../scripts/reload-extension.mjs'
import { renderBoard, renderStatus } from '../mcp-server/shape.mjs'

/* -------------------------------------------------------------------------- */
/* The installed version                                                       */
/* -------------------------------------------------------------------------- */

test('the installed version is read from the manifest, not from the package', () => {
  // Read from the manifest because the manifest is what a browser loads. They
  // agree today and a separate test pins that they must, but if they ever
  // disagree the browser follows the manifest, so this must too.
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'))
  assert.equal(installedExtensionVersion(), manifest.version)
})

test('the installed version is re-read when the manifest changes under a running process', () => {
  // The whole point of reading it rather than importing it: a pull changes the
  // folder while the broker has been up since login, and the board has to say
  // so on the next poll rather than at the next restart. Proved by touching the
  // real manifest and putting it back byte for byte.
  const before = fs.readFileSync(MANIFEST_FILE, 'utf8')
  const original = installedExtensionVersion()
  try {
    const bumped = before.replace(`"version": "${original}"`, '"version": "99.99.99"')
    assert.notEqual(bumped, before, 'the manifest version line was not found')
    fs.writeFileSync(MANIFEST_FILE, bumped)
    assert.equal(installedExtensionVersion(), '99.99.99', 'a changed manifest is picked up')
  } finally {
    fs.writeFileSync(MANIFEST_FILE, before)
  }
  assert.equal(installedExtensionVersion(), original, 'and picked up again when it changes back')
  assert.equal(fs.readFileSync(MANIFEST_FILE, 'utf8'), before, 'the manifest is exactly as it was')
})

test('the manifest and the package version agree, so one number means one release', () => {
  // Kept as the invariant rather than as a literal. A test that pinned the
  // literal version failed on every bump and taught people to edit the
  // assertion instead of thinking, and it hid a real drift: npm run sync-config
  // does not carry the version into the manifest.
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'))
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf8'))
  assert.equal(
    manifest.version,
    pkg.version,
    'the manifest and package.json versions drifted - a profile would report a version no release has'
  )
})

/* -------------------------------------------------------------------------- */
/* What a board line says about it                                             */
/* -------------------------------------------------------------------------- */

function route(overrides = {}) {
  return {
    installId: 'i-1',
    label: 'chrome-work',
    desiredLabel: 'chrome-work',
    labelIsCustom: false,
    identityChanged: false,
    vendor: 'chrome',
    vendorLabel: 'Chrome',
    profileDir: 'Default',
    profileName: 'Work',
    email: 'work@example.com',
    link: LINK.READY,
    claimed: true,
    candidates: [],
    generation: 3,
    tabCount: 12,
    extVersion: '0.3.0',
    latencyMs: 4,
    lastSeenAt: Date.now(),
    opCount: 7,
    lastOp: 'listTabs',
    warnings: [],
    ...overrides,
  }
}

test('a line reports the version it is running and whether that is behind', () => {
  const behind = lineFor(route(), { installedVersion: '0.4.0' })
  assert.equal(behind.extVersion, '0.3.0')
  assert.equal(behind.needsReload, true)

  const current = lineFor(route(), { installedVersion: '0.3.0' })
  assert.equal(current.needsReload, false, 'running the installed version is not behind')
})

test('needsReload is false when there is nothing to compare against', () => {
  // Two different unknowns, and "reload it" would be advice with no evidence
  // behind it in either case. An unreadable manifest is a broken install, and a
  // profile that reported no version is running code older than the field.
  assert.equal(lineFor(route(), { installedVersion: null }).needsReload, false, 'no installed version')
  assert.equal(lineFor(route({ extVersion: null }), { installedVersion: '0.4.0' }).needsReload, false, 'no reported version')
  assert.equal(lineFor(route({ extVersion: null }), { installedVersion: '0.4.0' }).extVersion, null)
})

test('an absent line keeps the version it last reported and never asks for a reload', () => {
  // A closed browser picks the new code up the next time it starts, with nobody
  // clicking anything, so flagging it would send the operator to an extensions
  // page that is not open.
  const line = absentLine({ installId: 'i-9', label: 'chrome-old', vendor: 'chrome', extVersion: '0.1.0' })
  assert.equal(line.extVersion, '0.1.0')
  assert.equal(line.needsReload, false)
  assert.equal(line.present, false)
})

/* -------------------------------------------------------------------------- */
/* What the operator and the model actually read                               */
/* -------------------------------------------------------------------------- */

function board(overrides = {}) {
  return {
    product: 'Agent Browser Bridge',
    version: '0.4.0',
    installedVersion: '0.4.0',
    startedAt: Date.now() - 60_000,
    now: Date.now(),
    panic: false,
    lines: [],
    audit: [],
    ...overrides,
  }
}

test('the profile list names the version and the one action that fixes it', () => {
  const text = renderBoard(
    board({ lines: [lineFor(route(), { installedVersion: '0.4.0' }), lineFor(route({ installId: 'i-2', label: 'chrome-other', extVersion: '0.4.0' }), { installedVersion: '0.4.0' })] })
  )
  assert.match(text, /ext 0\.3\.0/, 'the running version is on the line')
  assert.match(text, /ext 0\.4\.0/)
  assert.match(text, /needs a reload/)
  assert.match(text, /browser_reload_extension/, 'the note names the tool that fixes it')
  // The up-to-date line must not carry the note, or the note means nothing.
  const otherLine = text.split('\n').find((l) => l.includes('chrome-other'))
  assert.ok(otherLine && !otherLine.includes('needs a reload'))
})

test('the status view counts how many profiles are behind', () => {
  const two = renderStatus(
    board({
      lines: [
        lineFor(route(), { installedVersion: '0.4.0' }),
        lineFor(route({ installId: 'i-2', label: 'chrome-other', extVersion: '0.2.0' }), { installedVersion: '0.4.0' }),
      ],
    })
  )
  assert.match(two, /0\.4\.0 installed, 2 of 2 profiles need a reload/)
  assert.match(two, /NEEDS RELOAD/)

  const none = renderStatus(board({ lines: [lineFor(route({ extVersion: '0.4.0' }), { installedVersion: '0.4.0' })] }))
  assert.match(none, /every connected profile is running it/)
  assert.equal(/NEEDS RELOAD/.test(none), false)
})

test('a broker older than the folder says so once, not once per line', () => {
  // Somebody pulled and did not restart the broker. Harmless for the browser
  // tools, and confusing if it is silent, because then the installed version on
  // screen is not the version in the header.
  const text = renderStatus(
    board({ version: '0.3.0', installedVersion: '0.4.0', lines: [lineFor(route(), { installedVersion: '0.4.0' })] })
  )
  const mentions = text.split('\n').filter((l) => /has not been restarted/.test(l))
  assert.equal(mentions.length, 1)
  assert.match(text, /running 0\.3\.0 and the install folder holds 0\.4\.0/)
})

test('an unreadable manifest is stated, not silently read as nothing to do', () => {
  const text = renderStatus(board({ installedVersion: null }))
  assert.match(text, /could not be read/)
  assert.match(text, /no reload can be requested/)
})

/* -------------------------------------------------------------------------- */
/* The gate                                                                    */
/* -------------------------------------------------------------------------- */

test('a reload is refused unless the folder holds a different version', () => {
  // The one condition. A reload costs every session driving that profile its
  // open tab handles and makes the bridge forget which tabs it opened, so
  // "there is genuinely new code to load" is the only circumstance it is
  // allowed in.
  assert.equal(reloadRefusal({ label: 'chrome-work', installed: '0.4.0', running: '0.3.0' }), null, 'behind: allowed')

  const same = reloadRefusal({ label: 'chrome-work', installed: '0.4.0', running: '0.4.0' })
  assert.equal(same.code, ERR.UNSUPPORTED)
  assert.match(same.message, /already running version 0\.4\.0/)
  assert.match(same.message, /open tab handles/, 'the refusal says what a reload would have cost')

  const noManifest = reloadRefusal({ label: 'chrome-work', installed: null, running: '0.3.0' })
  assert.equal(noManifest.code, ERR.UNSUPPORTED)
  assert.match(noManifest.message, /Cannot read the extension manifest/)

  const noReport = reloadRefusal({ label: 'chrome-work', installed: '0.4.0', running: null })
  assert.equal(noReport.code, ERR.UNSUPPORTED)
  assert.match(noReport.message, /did not report an extension version/)
})

test('a downgrade is a difference, so it is allowed', () => {
  // Deliberate. Checking out an older release and reloading into it is a real
  // thing to want, and "different" is the honest condition; "newer" would also
  // mean parsing versions, which is a second rule to get wrong.
  assert.equal(reloadRefusal({ installed: '0.3.0', running: '0.4.0' }), null)
})

/* -------------------------------------------------------------------------- */
/* The one line it answers with                                                */
/* -------------------------------------------------------------------------- */

test('the reload sentence distinguishes asked-for from confirmed', () => {
  // The distinction is the honest part. A reload tears down the native port the
  // answer travels on, so the acknowledgement necessarily leaves before the
  // reload happens: it proves the extension was ASKED and nothing more.
  const asked = describeExtensionReload({ profile: 'chrome-work', from: '0.3.0', to: '0.4.0' })
  assert.match(asked, /^chrome-work: asked the extension to reload itself, 0\.3\.0 to 0\.4\.0\./)
  assert.match(asked, /the profile list is what confirms it/)

  const done = describeExtensionReload({ profile: 'chrome-work', from: '0.3.0', to: '0.4.0', verified: true, waitedMs: 2140 })
  assert.equal(done, 'chrome-work: reloaded the extension, 0.3.0 to 0.4.0, back on the bridge in 2.1s.')

  // Nothing known: still a sentence, never "undefined to undefined".
  assert.match(describeExtensionReload(), /an unreported version to the installed version/)
})

/* -------------------------------------------------------------------------- */
/* The command line: which profiles it acts on                                 */
/* -------------------------------------------------------------------------- */

test('the command takes one label or --all, and says so when it takes neither', () => {
  assert.deepEqual(parseArgs(['chrome-work']), {
    mode: 'reload',
    all: false,
    label: 'chrome-work',
    dryRun: false,
    timeoutMs: 25_000,
    socket: undefined,
  })
  assert.equal(parseArgs(['--all']).all, true)
  assert.equal(parseArgs(['--all', '--dry-run']).dryRun, true)
  assert.equal(parseArgs(['chrome-work', '--timeout', '5']).timeoutMs, 5_000)
  assert.equal(parseArgs(['--all', '--socket', '\\\\.\\pipe\\nothing']).socket, '\\\\.\\pipe\\nothing')

  assert.equal(parseArgs([]).mode, 'usage')
  assert.equal(parseArgs(['a', 'b']).mode, 'usage', 'two labels is a mistake worth naming')
  assert.equal(parseArgs(['--all', 'chrome-work']).mode, 'usage', 'both is ambiguous')
  assert.equal(parseArgs(['--nope']).mode, 'usage')
  assert.equal(parseArgs(['chrome-work', '--timeout', 'soon']).mode, 'usage')
})

test('--all reloads the profiles that are behind and names why each other is skipped', () => {
  // "Nothing was reloaded" with no explanation is the answer that sends someone
  // to the extensions page to do it by hand, so every skip carries its reason.
  const lines = [
    lineFor(route({ installId: 'a', label: 'behind' }), { installedVersion: '0.4.0' }),
    lineFor(route({ installId: 'b', label: 'current', extVersion: '0.4.0' }), { installedVersion: '0.4.0' }),
    lineFor(route({ installId: 'c', label: 'silent', extVersion: null }), { installedVersion: '0.4.0' }),
    absentLine({ installId: 'd', label: 'closed', vendor: 'chrome', extVersion: '0.2.0' }),
  ]
  const { targets, skipped, error } = selectTargets(lines, '0.4.0', { all: true, label: null })
  assert.equal(error, null)
  assert.deepEqual(targets.map((t) => t.label), ['behind'])
  assert.deepEqual(
    skipped.map((sk) => sk.label).sort(),
    ['closed', 'current', 'silent']
  )
  assert.match(skipped.find((sk) => sk.label === 'current').reason, /already running 0\.4\.0/)
  assert.match(skipped.find((sk) => sk.label === 'closed').reason, /next time that browser starts/)
  assert.match(skipped.find((sk) => sk.label === 'silent').reason, /did not report an extension version/)
})

test('one named label is matched exactly, and an unknown one lists what exists', () => {
  const lines = [lineFor(route({ label: 'chrome-work' }), { installedVersion: '0.4.0' })]
  assert.deepEqual(selectTargets(lines, '0.4.0', { all: false, label: 'chrome-work' }).targets.map((t) => t.label), ['chrome-work'])

  const wrong = selectTargets(lines, '0.4.0', { all: false, label: 'chrome-wor' })
  assert.match(wrong.error, /No line is labeled "chrome-wor"/)
  assert.match(wrong.error, /chrome-work/, 'it names the label that does exist')
  assert.deepEqual(wrong.targets, [])
})

test('with no install version and with no profiles, it refuses with the reason', () => {
  assert.match(selectTargets([], '0.4.0', { all: true, label: null }).error, /no profile is connected/)
  assert.match(
    selectTargets([lineFor(route(), { installedVersion: '0.4.0' })], null, { all: true, label: null }).error,
    /could not be read/
  )
})

/* -------------------------------------------------------------------------- */
/* The command line: verification                                              */
/* -------------------------------------------------------------------------- */

/** A broker that answers the reload, then reports the profile back on `becomes`. */
function fakeBroker({ becomes = '0.4.0', afterPolls = 1, reloading = true, throwsOn = null } = {}) {
  let polls = 0
  const line = { installId: 'a', label: 'behind', present: true, extVersion: '0.3.0' }
  return {
    calls: [],
    async request({ op }) {
      this.calls.push(op)
      if (throwsOn === op) throw Object.assign(new Error('refused'), { code: ERR.UNSUPPORTED })
      if (op === 'reloadExtension') return { ok: true, reloading, version: '0.3.0' }
      if (op === 'getBoard') {
        polls += 1
        return { lines: [{ ...line, extVersion: polls > afterPolls ? becomes : '0.3.0' }] }
      }
      throw new Error(`unexpected op ${op}`)
    },
  }
}

test('a reload is only reported as done once the profile is back on the new version', async () => {
  const client = fakeBroker({ becomes: '0.4.0', afterPolls: 2 })
  let clock = 0
  const r = await reloadOne({
    client,
    line: { installId: 'a', label: 'behind', extVersion: '0.3.0' },
    installed: '0.4.0',
    timeoutMs: 10_000,
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
  })
  assert.equal(r.ok, true)
  assert.match(r.line, /^behind: reloaded the extension, 0\.3\.0 to 0\.4\.0/)
  assert.ok(client.calls.filter((c) => c === 'getBoard').length >= 3, 'it kept polling until the version changed')
})

test('a profile that never comes back is reported as such, not as reloaded', async () => {
  // The failure that matters: claiming a reload landed when the extension was
  // disabled, or the worker was evicted before the timer fired, would leave the
  // operator believing their browsers are running code they are not.
  const client = fakeBroker({ becomes: '0.3.0', afterPolls: 0 })
  let clock = 0
  const r = await reloadOne({
    client,
    line: { installId: 'a', label: 'behind', extVersion: '0.3.0' },
    installed: '0.4.0',
    timeoutMs: 2_000,
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
  })
  assert.equal(r.ok, false)
  assert.match(r.line, /has not come back on 0\.4\.0 within 2s/)
})

test('an extension too old to know the operation is named as exactly that', async () => {
  // The one case no software can fix: the release that ADDS self-reload cannot
  // use it, because the code that would serve the request is the code being
  // installed. The message has to say so, or it reads as a bug.
  const client = fakeBroker({ reloading: false })
  const r = await reloadOne({
    client,
    line: { installId: 'a', label: 'behind', extVersion: '0.3.0' },
    installed: '0.4.0',
    sleep: async () => {},
    now: () => 0,
  })
  assert.equal(r.ok, false)
  assert.match(r.line, /older than this command/)
  assert.match(r.line, /extensions page/)
})

test('a broker refusal comes back as the broker worded it', async () => {
  const client = fakeBroker({ throwsOn: 'reloadExtension' })
  const r = await reloadOne({
    client,
    line: { installId: 'a', label: 'behind', extVersion: '0.3.0' },
    installed: '0.4.0',
    sleep: async () => {},
    now: () => 0,
  })
  assert.equal(r.ok, false)
  assert.match(r.line, /^behind: /)
})

/* -------------------------------------------------------------------------- */
/* The extension side                                                         */
/* -------------------------------------------------------------------------- */

test('the extension answers first and reloads afterwards', async () => {
  // Order is the whole mechanic. chrome.runtime.reload() tears down the service
  // worker and with it the native-messaging port the answer travels on, so
  // calling it inline would drop the reply and the caller would see a dropped
  // connection instead of an acknowledgement.
  const calls = []
  const previous = globalThis.chrome
  globalThis.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: '0.3.0' }),
      reload: () => calls.push('reload'),
    },
  }
  try {
    const ops = await import(`../extension/lib/ops.js?case=${Math.random()}`)
    const result = await ops.runOp('reloadExtension', {})
    assert.equal(result.ok, true)
    assert.equal(result.reloading, true)
    assert.equal(result.version, '0.3.0', 'it reports the version it is running, which is the one being replaced')
    assert.deepEqual(calls, [], 'nothing has reloaded yet when the answer is ready')

    await new Promise((r) => setTimeout(r, result.delayMs + 250))
    assert.deepEqual(calls, ['reload'], 'and the reload follows on its own')
  } finally {
    globalThis.chrome = previous
  }
})

test('reloadExtension is in the extension every supported-ops list the broker is told about', async () => {
  const previous = globalThis.chrome
  globalThis.chrome = { runtime: { lastError: null, getManifest: () => ({ version: '0.0.0' }), reload: () => {} } }
  try {
    const ops = await import(`../extension/lib/ops.js?case=${Math.random()}`)
    assert.ok(ops.SUPPORTED_OPS.includes('reloadExtension'))
  } finally {
    globalThis.chrome = previous
  }
})

/* -------------------------------------------------------------------------- */
/* The install folder note                                                     */
/* -------------------------------------------------------------------------- */

test('the README tells a user how to update, because nothing else can', () => {
  // A reload-the-extension step that lives only in a maintainer's head is a
  // step every user of this project skips, and then wonders why a fixed bug is
  // still there.
  const readme = fs.readFileSync(path.join(path.dirname(MANIFEST_FILE), '..', 'README.md'), 'utf8')
  assert.match(readme, /## Updating/, 'the README has an Updating section')
  assert.match(readme, /reload-extension/, 'and it names the command that does it')
})
