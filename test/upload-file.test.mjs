/**
 * The guarded upload: one tool that sets a page's file input, behind three
 * rails that each refuse in their own words.
 *
 * 1. The folder rail. Files come only from ONE folder the operator names in
 *    upload.json beside the broker's state. The broker is the only thing that
 *    reads them, on their real path, so `..`, an absolute path elsewhere, a
 *    junction and a file symlink that lead out of the folder are all refused,
 *    and nothing outside it is ever opened.
 * 2. The arm rail. The upload is ARMED tier: refused unless that profile's arm
 *    window is open, and an arm that has run out counts as no arm.
 * 3. The audit rail. Every upload's line carries the file name, its size, the
 *    site's origin and the tab, and an upload is refused when the audit log
 *    cannot be written, so nothing leaves unrecorded.
 *
 * Every refusal names its rail in plain words, and none of them echoes a path
 * on this machine back to the model.
 */

import test, { after, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-upload-'))
process.env.BRIDGE_HOME = path.join(TEMP_ROOT, 'state')
delete process.env.BRIDGE_SOCKET_NAME

const shared = await import('../shared/protocol.mjs')
const mirror = await import('../extension/lib/protocol.js')
const { ERR, OPS, OP_TIER, TIER, BROWSER_OPS, TIMING, UPLOAD_LIMITS, UPLOAD_RAIL } = shared
const { readUploadFiles, loadUploadSettings, namesAStream, UPLOAD_SETTINGS_FILE } = await import('../shared/upload-folder.mjs')
const { prepareUpload } = await import('../bridged/upload.mjs')
const { ArmingState, checkTierAccess } = await import('../bridged/policy.mjs')
const { AuditLog } = await import('../bridged/audit.mjs')
const { BASE_DIR } = await import('../shared/paths.mjs')
const { explainError } = await import('../mcp-server/shape.mjs')

after(() => fs.rmSync(TEMP_ROOT, { recursive: true, force: true }))

const FOLDER = path.join(TEMP_ROOT, 'approved')
const OUTSIDE = path.join(TEMP_ROOT, 'outside')
fs.mkdirSync(FOLDER, { recursive: true })
fs.mkdirSync(OUTSIDE, { recursive: true })
fs.writeFileSync(path.join(FOLDER, 'contract.pdf'), Buffer.from('%PDF-1.7 a small contract\n'))
fs.writeFileSync(path.join(FOLDER, 'import.csv'), 'name,email\nada,ada@example.test\n')
fs.mkdirSync(path.join(FOLDER, 'sub'), { recursive: true })
fs.writeFileSync(path.join(FOLDER, 'sub', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
fs.writeFileSync(path.join(OUTSIDE, 'secrets.env'), 'API_KEY=do-not-leak\n')
const SETTINGS = { folder: FOLDER }

/** No refusal may carry an absolute path on this machine, or the secret's text. */
function assertNoLeak(message) {
  assert.equal(typeof message, 'string')
  assert.equal(message.includes(TEMP_ROOT), false, `a refusal named a local path: ${message}`)
  assert.equal(message.toLowerCase().includes(TEMP_ROOT.toLowerCase()), false, `a refusal named a local path: ${message}`)
  assert.equal(message.includes('do-not-leak'), false, 'a refusal carried file content')
}

/* -------------------------------------------------------------------------- */
/* The contract                                                                */
/* -------------------------------------------------------------------------- */

test('uploadFile is in the contract as an ARMED browser operation, mirrored in the extension', () => {
  assert.equal(OPS.UPLOAD_FILE, 'uploadFile')
  assert.equal(OP_TIER[OPS.UPLOAD_FILE], TIER.ARMED)
  assert.ok(BROWSER_OPS.includes(OPS.UPLOAD_FILE))
  assert.equal(ERR.UPLOAD_REFUSED, 'E_UPLOAD_REFUSED')
  assert.deepEqual(UPLOAD_RAIL, { FOLDER: 'folder', ARM: 'arm', AUDIT: 'audit' })
  assert.ok(UPLOAD_LIMITS.MAX_FILES >= 1 && UPLOAD_LIMITS.MAX_TOTAL_BYTES >= 1024 * 1024)
  assert.deepEqual(mirror.UPLOAD_LIMITS, UPLOAD_LIMITS)
  assert.equal(mirror.OPS.UPLOAD_FILE, OPS.UPLOAD_FILE)
})

/* -------------------------------------------------------------------------- */
/* 1. The folder rail                                                          */
/* -------------------------------------------------------------------------- */

test('the folder lives in upload.json beside the broker state, and none configured means none', () => {
  assert.equal(UPLOAD_SETTINGS_FILE, path.join(BASE_DIR, 'upload.json'))
  assert.deepEqual(loadUploadSettings(path.join(TEMP_ROOT, 'missing.json')), { folder: null })
  const r = readUploadFiles(['contract.pdf'], { folder: null })
  assert.equal(r.files, undefined)
  assert.match(r.problem, /folder rail/i)
  assert.match(r.problem, /no upload folder is configured/i)
})

test('a file inside the folder is read whole, by the broker, with its name and size', () => {
  const r = readUploadFiles(['contract.pdf', path.join('sub', 'logo.png')], SETTINGS)
  assert.equal(r.problem, undefined, r.problem)
  assert.equal(r.files.length, 2)
  const [pdf, png] = r.files
  assert.equal(pdf.name, 'contract.pdf')
  assert.equal(pdf.bytes, fs.statSync(path.join(FOLDER, 'contract.pdf')).size)
  assert.equal(pdf.type, 'application/pdf')
  assert.deepEqual(pdf.data, fs.readFileSync(path.join(FOLDER, 'contract.pdf')))
  assert.equal(png.name, 'logo.png')
  assert.equal(png.type, 'image/png')
  assert.ok(Number.isFinite(pdf.lastModified) && pdf.lastModified > 0)
})

test('an absolute path inside the folder is accepted too', () => {
  const r = readUploadFiles([path.join(FOLDER, 'import.csv')], SETTINGS)
  assert.equal(r.problem, undefined, r.problem)
  assert.equal(r.files[0].name, 'import.csv')
  assert.equal(r.files[0].type, 'text/csv')
})

test('outside the folder: an absolute path elsewhere is refused by the folder rail, unread', () => {
  const r = readUploadFiles([path.join(OUTSIDE, 'secrets.env')], SETTINGS)
  assert.equal(r.files, undefined, 'a file outside the approved folder was read')
  assert.match(r.problem, /folder rail/i)
  assert.match(r.problem, /outside the upload folder/i)
  assert.match(r.problem, /secrets\.env/, 'the refusal names the file by its name')
  assertNoLeak(r.problem)
})

test('outside the folder: a .. escape is refused by the folder rail', () => {
  for (const escape of [path.join('..', 'outside', 'secrets.env'), '../outside/secrets.env', 'sub/../../outside/secrets.env']) {
    const r = readUploadFiles([escape], SETTINGS)
    assert.equal(r.files, undefined, `${escape} escaped the folder`)
    assert.match(r.problem, /folder rail/i)
    assertNoLeak(r.problem)
  }
})

test('a symlink out of it: a junction inside the folder that leads out is refused on its real path', () => {
  const link = path.join(FOLDER, 'linked-dir')
  // A junction needs no elevation on Windows; elsewhere a directory symlink.
  fs.symlinkSync(OUTSIDE, link, process.platform === 'win32' ? 'junction' : 'dir')
  const r = readUploadFiles([path.join('linked-dir', 'secrets.env')], SETTINGS)
  assert.equal(r.files, undefined, 'a link carried the reader out of the folder')
  assert.match(r.problem, /folder rail/i)
  assert.match(r.problem, /outside the upload folder/i)
  assertNoLeak(r.problem)
})

test('a symlink out of it: a file symlink inside the folder that leads out is refused on its real path', (t) => {
  const link = path.join(FOLDER, 'innocent.txt')
  try {
    fs.symlinkSync(path.join(OUTSIDE, 'secrets.env'), link, 'file')
  } catch (err) {
    // Windows refuses a file symlink without Developer Mode or elevation, and
    // this suite never elevates. The junction case above covers the same rule.
    if (err.code === 'EPERM') return t.skip('file symlinks need Developer Mode on this machine')
    throw err
  }
  const r = readUploadFiles(['innocent.txt'], SETTINGS)
  assert.equal(r.files, undefined, 'a file symlink carried the reader out of the folder')
  assert.match(r.problem, /folder rail/i)
  assertNoLeak(r.problem)
})

test('the folder rail refuses what is not a regular file, a missing file and a missing folder', () => {
  const dir = readUploadFiles(['sub'], SETTINGS)
  assert.match(dir.problem, /folder rail/i)
  assert.match(dir.problem, /not a file/i)
  const missing = readUploadFiles(['nope.pdf'], SETTINGS)
  assert.match(missing.problem, /does not exist/i)
  const gone = readUploadFiles(['contract.pdf'], { folder: path.join(TEMP_ROOT, 'never-made') })
  assert.match(gone.problem, /folder rail/i)
  assert.match(gone.problem, /does not exist/i)
  for (const r of [dir, missing, gone]) assertNoLeak(r.problem)
})

test('the folder rail refuses an empty list, too many files, too many bytes and a malformed path', () => {
  assert.match(readUploadFiles([], SETTINGS).problem, /at least one file/i)
  const many = Array.from({ length: UPLOAD_LIMITS.MAX_FILES + 1 }, () => 'contract.pdf')
  assert.match(readUploadFiles(many, SETTINGS).problem, new RegExp(`at most ${UPLOAD_LIMITS.MAX_FILES}`))
  const big = readUploadFiles(['contract.pdf', 'import.csv'], SETTINGS, { ...UPLOAD_LIMITS, MAX_TOTAL_BYTES: 30 })
  assert.match(big.problem, /folder rail/i)
  assert.match(big.problem, /too large/i)
  for (const bad of ['', 'a\u0000b', 42, null, 'x'.repeat(2_000)]) {
    const r = readUploadFiles([bad], SETTINGS)
    assert.equal(r.files, undefined)
    assert.match(r.problem, /folder rail/i)
  }
})

/* -------------------------------------------------------------------------- */
/* 2. The arm rail                                                             */
/* -------------------------------------------------------------------------- */

test('unarmed: an upload on an unarmed profile is refused by the arm rail', () => {
  const refusal = checkTierAccess({ tier: OP_TIER[OPS.UPLOAD_FILE], claimed: true, armed: false, label: 'chrome-work', op: OPS.UPLOAD_FILE })
  assert.ok(refusal, 'an unarmed upload was allowed')
  assert.equal(refusal.code, ERR.NOT_ARMED)
  assert.equal(refusal.rail, UPLOAD_RAIL.ARM)
  assert.match(refusal.message, /arm rail/i)
  assert.match(refusal.message, /upload/i)
  assert.match(refusal.message, /bridge_arm/)
  // evalJs keeps its own wording.
  const js = checkTierAccess({ tier: TIER.ARMED, claimed: true, armed: false, label: 'chrome-work', op: OPS.EVAL_JS })
  assert.match(js.message, /JavaScript/)
})

test('an expired arm: once the 15-minute default window has run out, the upload is refused again', () => {
  mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 })
  try {
    const arming = new ArmingState()
    arming.arm('install-1')
    const gate = () =>
      checkTierAccess({ tier: TIER.ARMED, claimed: true, armed: arming.isArmed('install-1'), label: 'chrome-work', op: OPS.UPLOAD_FILE })
    assert.equal(gate(), null, 'an armed upload was refused')
    mock.timers.tick(TIMING.DEFAULT_ARM_MINUTES * 60_000 - 1)
    assert.equal(gate(), null, 'the arm closed before its window ran out')
    mock.timers.tick(1)
    const refusal = gate()
    assert.ok(refusal, 'an upload went through on an arm that had run out')
    assert.equal(refusal.code, ERR.NOT_ARMED)
    assert.match(refusal.message, /arm rail/i)
  } finally {
    mock.timers.reset()
  }
})

/* -------------------------------------------------------------------------- */
/* 3. The audit rail                                                           */
/* -------------------------------------------------------------------------- */

test('the log line written: an upload line carries the file name, its size, the origin and the tab', () => {
  const file = path.join(TEMP_ROOT, 'audit', 'audit.jsonl')
  const log = new AuditLog({ file })
  log.record({
    profile: 'chrome-work',
    op: OPS.UPLOAD_FILE,
    url: 'https://forms.example.test/upload/3f9c-token?x=1#frag',
    ok: true,
    ms: 41,
    tab: 'tab_chrome-work_3_41',
    files: [
      { name: 'contract.pdf', bytes: 26 },
      { name: 'import.csv', bytes: 33 },
    ],
  })
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 1)
  const [line] = lines
  assert.equal(line.op, 'uploadFile')
  assert.equal(line.origin, 'https://forms.example.test', 'the origin only, never the path')
  assert.equal(line.tab, 'tab_chrome-work_3_41')
  assert.deepEqual(line.files, [
    { name: 'contract.pdf', bytes: 26 },
    { name: 'import.csv', bytes: 33 },
  ])
  assert.equal(JSON.stringify(line).includes('3f9c-token'), false)
})

test('the audit line keeps a bare file name and a real tab handle, and drops anything else', () => {
  const file = path.join(TEMP_ROOT, 'audit', 'audit-bad.jsonl')
  const log = new AuditLog({ file })
  const entry = log.record({
    profile: 'p',
    op: OPS.UPLOAD_FILE,
    ok: false,
    tab: 'C:\\Users\\someone\\secret',
    files: [
      { name: path.join(OUTSIDE, 'secrets.env'), bytes: 10 },
      { name: '../up.txt', bytes: 1 },
      { name: 'ok.pdf', bytes: -3 },
      { name: 'ctl\u0007.pdf' },
      { name: 'fine.pdf' },
    ],
  })
  assert.equal(entry.tab, undefined)
  assert.deepEqual(entry.files, [{ name: 'ok.pdf' }, { name: 'fine.pdf' }])
  assert.equal(fs.readFileSync(file, 'utf8').includes(TEMP_ROOT), false)
  // A line that is not an upload grows neither field.
  const plain = log.record({ profile: 'p', op: OPS.CLICK, ok: true })
  assert.equal(Object.hasOwn(plain, 'files'), false)
  assert.equal(Object.hasOwn(plain, 'tab'), false)
})

test('the send line: an upload is on disk, by tab and file, before it leaves, or it does not leave', () => {
  const file = path.join(TEMP_ROOT, 'audit', 'send.jsonl')
  const log = new AuditLog({ file })
  const written = log.recordBeforeSend({
    profile: 'chrome-work',
    op: OPS.UPLOAD_FILE,
    tab: 'tab_chrome-work_3_41',
    files: [{ name: 'contract.pdf', bytes: 26 }],
  })
  assert.equal(written, true)
  const [line] = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(line.stage, 'send')
  assert.equal(line.op, 'uploadFile')
  assert.equal(line.tab, 'tab_chrome-work_3_41')
  assert.deepEqual(line.files, [{ name: 'contract.pdf', bytes: 26 }])
  // The board shows what happened, not what is about to: the send line stays off it.
  assert.equal(log.recent().length, 0)

  const blocker = path.join(TEMP_ROOT, 'not-a-dir-send')
  fs.writeFileSync(blocker, 'a file where the audit folder should be')
  const errors = []
  const bad = new AuditLog({ file: path.join(blocker, 'audit.jsonl'), onError: (e) => errors.push(e) })
  assert.equal(bad.recordBeforeSend({ profile: 'p', op: OPS.UPLOAD_FILE, tab: 'tab_p_1_2', files: [{ name: 'a.pdf', bytes: 1 }] }), false)
  assert.equal(errors.length, 1, 'a failed write is still reported to the broker')
})

test('the folder rail refuses an alternate data stream, which is a hidden part of a file', (t) => {
  assert.equal(namesAStream('C:\\up\\contract.pdf:hidden', true), true)
  assert.equal(namesAStream('C:\\up\\contract.pdf::$DATA', true), true)
  assert.equal(namesAStream('\\\\?\\C:\\up\\contract.pdf:x', true), true)
  assert.equal(namesAStream('C:\\up\\contract.pdf', true), false)
  assert.equal(namesAStream('\\\\server\\share\\contract.pdf', true), false)
  // A colon is an ordinary character in a POSIX file name.
  assert.equal(namesAStream('/up/contract.pdf:v2', false), false)

  if (process.platform !== 'win32') {
    t.skip('alternate data streams are an NTFS feature')
    return
  }
  const host = path.join(FOLDER, 'stream-host.txt')
  fs.writeFileSync(host, 'the visible part\n')
  try {
    fs.writeFileSync(`${host}:hidden`, 'do-not-leak from a hidden stream\n')
  } catch (err) {
    t.skip(`this volume does not take alternate data streams (${err.code})`)
    return
  }
  for (const asked of ['stream-host.txt:hidden', `${host}:hidden`, 'stream-host.txt::$DATA']) {
    const r = readUploadFiles([asked], SETTINGS)
    assert.ok(r.problem, `${asked} was read`)
    assert.match(r.problem, /folder rail refused/i)
    assertNoLeak(r.problem)
  }
  assert.equal(readUploadFiles(['stream-host.txt'], SETTINGS).files?.length, 1, 'the file itself still reads')
})

test('the audit log can say whether it can be written before anything leaves', () => {
  const good = new AuditLog({ file: path.join(TEMP_ROOT, 'audit', 'probe.jsonl') })
  assert.equal(good.canWrite(), true)
  const blocker = path.join(TEMP_ROOT, 'not-a-dir')
  fs.writeFileSync(blocker, 'a file where the audit folder should be')
  const bad = new AuditLog({ file: path.join(blocker, 'audit.jsonl') })
  assert.equal(bad.canWrite(), false)
})

/* -------------------------------------------------------------------------- */
/* The broker's preparation: rails in order, and what reaches the extension    */
/* -------------------------------------------------------------------------- */

test('prepareUpload: the audit rail refuses when the log cannot be written, before any file is read', () => {
  const r = prepareUpload({ args: { paths: ['contract.pdf'] }, settings: SETTINGS, auditWritable: false })
  assert.equal(r.ok, false)
  assert.equal(r.code, ERR.UPLOAD_REFUSED)
  assert.equal(r.rail, UPLOAD_RAIL.AUDIT)
  assert.match(r.message, /audit rail/i)
  assertNoLeak(r.message)
})

test('prepareUpload: the folder rail refusal names the file and keeps its name for the audit line', () => {
  const r = prepareUpload({ args: { paths: [path.join(OUTSIDE, 'secrets.env')] }, settings: SETTINGS, auditWritable: true })
  assert.equal(r.ok, false)
  assert.equal(r.code, ERR.UPLOAD_REFUSED)
  assert.equal(r.rail, UPLOAD_RAIL.FOLDER)
  assert.match(r.message, /folder rail/i)
  assertNoLeak(r.message)
  assert.deepEqual(r.audit.files, [{ name: 'secrets.env' }])
})

test('prepareUpload: only bytes the broker read travel on, and the paths never do', () => {
  const r = prepareUpload({
    args: {
      tabId: 7,
      selector: 'input[type=file]',
      paths: ['contract.pdf'],
      // A caller that sends its own payload is ignored: only what the broker read goes on.
      files: [{ name: 'forged.pdf', type: 'application/pdf', data: Buffer.from('forged').toString('base64') }],
    },
    settings: SETTINGS,
    auditWritable: true,
  })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.args.paths, undefined, 'a local path travelled to the extension')
  assert.equal(r.args.tabId, 7)
  assert.equal(r.args.selector, 'input[type=file]')
  assert.equal(r.args.files.length, 1)
  assert.equal(r.args.files[0].name, 'contract.pdf')
  assert.equal(Buffer.from(r.args.files[0].data, 'base64').toString('utf8'), fs.readFileSync(path.join(FOLDER, 'contract.pdf'), 'utf8'))
  assert.equal(JSON.stringify(r.args).includes(TEMP_ROOT.replace(/\\/g, '\\\\')), false)
  assert.equal(JSON.stringify(r.args).includes('forged'), false)
  assert.deepEqual(r.audit.files, [{ name: 'contract.pdf', bytes: fs.statSync(path.join(FOLDER, 'contract.pdf')).size }])
})

test('the MCP layer passes a rail refusal through in the broker\'s own words', () => {
  const folder = explainError({ code: ERR.UPLOAD_REFUSED, message: 'The folder rail refused this upload: secrets.env is outside the upload folder.' })
  assert.match(folder, /folder rail refused/)
  const arm = explainError({ code: ERR.NOT_ARMED, message: 'The arm rail refused this upload: profile "chrome-work" is not armed.' }, { profile: 'chrome-work' })
  assert.match(arm, /arm rail refused/)
})

test('the broker wires the three rails: the op reaches the arm gate, the audit and folder rails run before the send', () => {
  const broker = fs.readFileSync(new URL('../bridged/index.mjs', import.meta.url), 'utf8')
  // The arm rail's own words need the op, so the gate is told which one this is.
  assert.match(broker, /checkTierAccess\(\{[^}]*\bop,\s*\}\)/)
  // The audit and folder rails, with the audit log asked first.
  assert.match(broker, /prepareUpload\(\{ args, auditWritable: audit\.canWrite\(\) \}\)/)
  // The caller's paths never travel, and no other operation carries files.
  assert.match(broker, /delete args\.paths\s+args\.files = prepared\.args\.files/)
  assert.match(broker, /\} else \{\s+delete args\.files\s+delete args\.paths\s+\}/)
  // The send line is written, and must land, before the request goes to the browser.
  const forward = broker.slice(broker.indexOf('function forwardToBrowser('), broker.indexOf('function urlAllowedFor('))
  const sendLine = forward.indexOf('audit.recordBeforeSend(')
  assert.ok(sendLine > 0, 'no send line in forwardToBrowser')
  assert.ok(sendLine < forward.indexOf('route.conn.send(outbound)'), 'the send line is written after the send')
  // The upload's line names its tab and files, whether it went out or was refused.
  assert.match(broker, /tab: pending\.tab,\s+files: pending\.files,/)
  assert.match(broker, /tab,\s+files,\s+\}\)\s+\}\s+conn\.send\(response\)/)
})
