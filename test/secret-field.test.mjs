/**
 * The password-field guard: a fill or key press into a password or one-time
 * code field is refused unless the call carries a receipt pointing at a
 * recorded yes for that site.
 *
 * Three parts, three places, each tested where it lives:
 *
 * 1. Which fields count (isSecretField) and whether a grant covers the site
 *    (secretFieldVerdict): the contract, mirrored into the extension, which is
 *    where the decision is made because only the page knows what a field is.
 * 2. Reading the receipt (shared/account-word.mjs): the broker's half. The
 *    receipt is a path to a drop file in ONE configured folder; the file has to
 *    carry an `ACCOUNT WORD: <service> ...` line. Nothing outside that folder is
 *    read, and an error never repeats the folder's path.
 * 3. The broker turning a receipt into a grant on the way to the browser, and
 *    stripping any grant the caller tried to send itself, with the audit line
 *    naming the receipt's file and never its contents: the real broker and the
 *    real host, on a throwaway endpoint, with the test standing in for the
 *    browser.
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-secret-'))
const HOME = path.join(TEMP_ROOT, 'state')
const DROPS = path.join(TEMP_ROOT, 'drops')
process.env.BRIDGE_HOME = HOME
delete process.env.BRIDGE_SOCKET_NAME

const shared = await import('../shared/protocol.mjs')
const mirror = await import('../extension/lib/protocol.js')
const { readAccountWord, serviceOf, ACCOUNT_WORD_SETTINGS_FILE } = await import('../shared/account-word.mjs')
const { AUDIT_FILE, BASE_DIR, RUNTIME_FILE, readJson, socketPathFor } = await import('../shared/paths.mjs')
const { BrokerClient } = await import('../mcp-server/client.mjs')
const { FrameDecoder, encodeFrame } = await import('../shared/framing.mjs')
const { ERR, MSG, OPS, mintTabHandle, ok, register } = shared
const { isSecretField, secretFieldVerdict } = shared

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const children = new Set()
after(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill()
  await new Promise((r) => setTimeout(r, 100))
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true })
})

/* -------------------------------------------------------------------------- */
/* 1. Which fields are secret, and whether a grant covers the site             */
/* -------------------------------------------------------------------------- */

const SECRET = [
  { type: 'password' },
  { type: 'PASSWORD' },
  { type: 'text', autocomplete: 'one-time-code' },
  { type: 'text', autocomplete: 'section-login current-password' },
  { type: 'text', autocomplete: 'new-password' },
  { type: 'text', name: 'user_pwd' },
  { type: 'text', id: 'newPassword' },
  { type: 'text', name: 'passwordConfirm' },
  { type: 'tel', name: 'otp' },
  { type: 'tel', name: 'totp-code' },
  { type: 'text', label: 'One-time code' },
  { type: 'text', label: 'Enter the verification code we sent' },
  { type: 'number', name: 'pin' },
  { type: 'text', label: 'Passcode' },
  { type: 'text', id: 'mfa_token' },
  { type: 'text', name: '2fa' },
  { tag: 'iframe', opaque: true },
]

const PLAIN = [
  { type: 'text', name: 'email' },
  { type: 'email', autocomplete: 'username' },
  { type: 'search', name: 'q' },
  { type: 'text', label: 'Spinach quantity' },
  { type: 'text', name: 'opinion' },
  { type: 'text', id: 'pinterest-url' },
  { type: 'text', label: 'Shipping address' },
  {},
]

test('password and one-time-code fields are recognized by type, autocomplete, name, id and label', () => {
  for (const field of SECRET) assert.equal(isSecretField(field), true, JSON.stringify(field))
  for (const field of PLAIN) assert.equal(isSecretField(field), false, JSON.stringify(field))
  assert.equal(isSecretField(null), false)
})

test('an ordinary field needs no grant at all', () => {
  const verdict = secretFieldVerdict({ field: { type: 'email' }, grant: null, url: 'https://accounts.example.com/' })
  assert.deepEqual(verdict, { allowed: true, secret: false, receipt: null })
})

test('a secret field without a receipt is refused, and the message says a password needs the recorded yes', () => {
  const verdict = secretFieldVerdict({ field: { type: 'password' }, url: 'https://accounts.example.com/' })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.secret, true)
  assert.match(verdict.message, /password/)
  assert.match(verdict.message, /recorded yes/)
})

test('a receipt the broker could not accept is refused, with its reason', () => {
  const verdict = secretFieldVerdict({
    field: { type: 'password' },
    grant: { file: 'drop-9.md', problem: 'it carries no ACCOUNT WORD line' },
    url: 'https://accounts.example.com/',
  })
  assert.equal(verdict.allowed, false)
  assert.match(verdict.message, /drop-9\.md does not count: it carries no ACCOUNT WORD line/)
})

test('a recorded yes covers the site it names and no other', () => {
  const grant = { file: 'drop-7.md', services: ['ledgerly'] }
  const yes = secretFieldVerdict({ field: { type: 'password' }, grant, url: 'https://accounts.ledgerly.com/signin' })
  assert.deepEqual(yes, { allowed: true, secret: true, receipt: 'drop-7.md' })
  for (const url of ['https://ledgerlyish.example/', 'https://ledgerly.evil.example.co/x'.replace('ledgerly.', 'ledgerly-'), 'not a url', '']) {
    const no = secretFieldVerdict({ field: { type: 'password' }, grant, url })
    assert.equal(no.allowed, false, url)
    assert.match(no.message, /names ledgerly, not this site/)
  }
  // A domain matches itself and its subdomains, never a lookalike.
  const domain = { file: 'drop-8.md', services: ['example.com'] }
  assert.equal(secretFieldVerdict({ field: { type: 'password' }, grant: domain, url: 'https://login.example.com/' }).allowed, true)
  assert.equal(secretFieldVerdict({ field: { type: 'password' }, grant: domain, url: 'https://example.com/' }).allowed, true)
  assert.equal(secretFieldVerdict({ field: { type: 'password' }, grant: domain, url: 'https://evil-example.com/' }).allowed, false)
  assert.equal(secretFieldVerdict({ field: { type: 'password' }, grant: domain, url: 'https://example.com.evil.test/' }).allowed, false)
})

test('the extension mirror decides exactly what the contract decides', () => {
  for (const field of [...SECRET, ...PLAIN]) assert.equal(mirror.isSecretField(field), shared.isSecretField(field))
  const cases = [
    { field: { type: 'password' }, grant: null, url: 'https://a.example/' },
    { field: { type: 'password' }, grant: { file: 'f.md', services: ['a'] }, url: 'https://x.a.example/' },
    { field: { type: 'password' }, grant: { file: 'f.md', problem: 'p' }, url: 'https://a.example/' },
    { field: { type: 'text' }, grant: null, url: 'https://a.example/' },
  ]
  for (const spec of cases) assert.deepEqual(mirror.secretFieldVerdict(spec), shared.secretFieldVerdict(spec))
})

/* -------------------------------------------------------------------------- */
/* 2. The receipt reader                                                       */
/* -------------------------------------------------------------------------- */

test('a word line names its service by the first word, with articles and possessives set aside', () => {
  assert.equal(serviceOf('Ledgerly developer account, for the demo app'), 'ledgerly')
  assert.equal(serviceOf('**the** Paywell account'), 'paywell')
  assert.equal(serviceOf("Alex's Instantly login"), 'instantly')
  assert.equal(serviceOf('a new example.com login'), 'example.com')
  assert.equal(serviceOf('new account'), '')
  assert.equal(serviceOf('account for something'), '')
  assert.equal(serviceOf('x'), '')
  // A deployment can name more words that are never a service (an owner's name).
  assert.equal(serviceOf('acme paywell', { ignoreWords: ['acme'] }), '')
})

function writeDrop(name, body) {
  fs.mkdirSync(DROPS, { recursive: true })
  const file = path.join(DROPS, name)
  fs.writeFileSync(file, body)
  return file
}

test('a receipt in the folder with an ACCOUNT WORD line becomes the services it names', () => {
  const file = writeDrop('2026-09-30-drop-1.md', '# A drop\n\nACCOUNT WORD: Ledgerly developer account\n\n**ACCOUNT WORD:** the Paywell account\n')
  const settings = { folder: DROPS }
  assert.deepEqual(readAccountWord(file, settings), { file: '2026-09-30-drop-1.md', services: ['ledgerly', 'paywell'] })
  // A bare file name is read from the folder.
  assert.deepEqual(readAccountWord('2026-09-30-drop-1.md', settings), { file: '2026-09-30-drop-1.md', services: ['ledgerly', 'paywell'] })
})

test('a receipt that is missing, unlined, outside the folder or not a drop file is a problem, never a grant', () => {
  const settings = { folder: DROPS }
  writeDrop('2026-09-30-drop-2.md', 'No word here.\nWe talked about an account.\n')
  const outside = path.join(TEMP_ROOT, 'elsewhere.md')
  fs.writeFileSync(outside, 'ACCOUNT WORD: Ledgerly\n')
  writeDrop('notes.txt', 'ACCOUNT WORD: Ledgerly\n')

  const cases = [
    ['2026-09-30-drop-2.md', /no ACCOUNT WORD line/],
    ['2026-09-30-drop-404.md', /does not exist/],
    [outside, /outside the account-word folder/],
    [path.join(DROPS, '..', 'elsewhere.md'), /outside the account-word folder/],
    ['notes.txt', /\.md/],
    ['a\u0000b.md', /not a usable path/],
    ['x'.repeat(2000) + '.md', /not a usable path/],
    ['', /not a usable path/],
  ]
  for (const [receipt, why] of cases) {
    const grant = readAccountWord(receipt, settings)
    assert.equal(grant.services, undefined, `${receipt.slice(0, 40)} became a grant`)
    assert.match(grant.problem, why, `${receipt.slice(0, 40)}: ${grant.problem}`)
    assert.equal(grant.problem.includes(TEMP_ROOT), false, 'a problem repeated a private path')
  }
  const unconfigured = readAccountWord(path.join(DROPS, '2026-09-30-drop-1.md'), { folder: null })
  assert.match(unconfigured.problem, /no account-word folder is configured/)
})

test('a receipt that is a directory or too large is refused', () => {
  fs.mkdirSync(path.join(DROPS, 'dir.md'), { recursive: true })
  assert.match(readAccountWord('dir.md', { folder: DROPS }).problem, /not a file/)
  writeDrop('big.md', 'ACCOUNT WORD: Ledgerly\n' + 'x'.repeat(300 * 1024))
  assert.match(readAccountWord('big.md', { folder: DROPS }).problem, /too large/)
})

/* -------------------------------------------------------------------------- */
/* 3. The broker: receipt in, grant out, caller's grant stripped, audit line   */
/* -------------------------------------------------------------------------- */

const NAME = `abb-sec-${crypto.randomBytes(5).toString('hex')}`
const ENDPOINT = socketPathFor(NAME, BASE_DIR)

function childEnv() {
  const env = {
    ...process.env,
    BRIDGE_HOME: HOME,
    BRIDGE_SOCKET_NAME: NAME,
    BRIDGE_QUIET: '1',
    BRIDGE_WATCH_PARENT: '',
    LOCALAPPDATA: path.join(TEMP_ROOT, 'local'),
    XDG_CONFIG_HOME: path.join(TEMP_ROOT, 'config'),
  }
  if (process.platform !== 'win32') env.HOME = path.join(TEMP_ROOT, 'home')
  return env
}

function launch(script, args, stdio) {
  const child = spawn(process.execPath, [script, ...args], { env: childEnv(), stdio, windowsHide: true })
  children.add(child)
  let stderr = ''
  child.stderr?.on('data', (d) => (stderr += d))
  return { child, stderr: () => stderr }
}

async function waitFor(what, predicate, ms = 10_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`)
}

test('the broker turns a receipt into a grant, strips a forged one, and audits the file name only', async () => {
  fs.mkdirSync(BASE_DIR, { recursive: true })
  assert.ok(ACCOUNT_WORD_SETTINGS_FILE.startsWith(TEMP_ROOT))
  fs.writeFileSync(ACCOUNT_WORD_SETTINGS_FILE, JSON.stringify({ folder: DROPS }))
  const receipt = writeDrop('2026-09-30-drop-3.md', 'ACCOUNT WORD: Ledgerly developer account\n')

  const broker = launch(path.join(REPO, 'bridged', 'index.mjs'), [], ['ignore', 'ignore', 'pipe'])
  await waitFor('the broker', () => {
    if (broker.child.exitCode !== null) throw new Error(`the broker exited: ${broker.stderr()}`)
    return readJson(RUNTIME_FILE, null)?.pid === broker.child.pid
  })

  const host = launch(path.join(REPO, 'host', 'index.mjs'), ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/'], ['pipe', 'pipe', 'pipe'])
  const decoder = new FrameDecoder()
  const frames = []
  host.child.stdout.on('data', (chunk) => frames.push(...decoder.push(chunk)))
  host.child.stdin.on('error', () => {})
  const send = (msg) => host.child.stdin.write(encodeFrame(msg))
  // Stand in for the extension: answer every request with ok, so the broker
  // writes its audit line.
  const seen = []
  const answered = new Set()
  const answerLoop = setInterval(() => {
    for (const m of frames) {
      if (m.type === MSG.REQ && !answered.has(m.id)) {
        answered.add(m.id)
        seen.push(m)
        send(ok(m.id, { ok: true, receipt: m.args?.accountWordGrant?.file ?? null }))
      }
    }
  }, 20)

  const client = new BrokerClient({ socketPath: ENDPOINT })
  try {
    send(register({ installId: `sec-${crypto.randomBytes(4).toString('hex')}`, vendorHint: 'chrome', email: null, label: null, extVersion: '0.0.0', tabCount: 1 }))
    const ack = await waitFor('register_ack', () => frames.find((m) => m.type === MSG.REGISTER_ACK))
    assert.equal(ack.ok, true, JSON.stringify(ack))
    const tab = mintTabHandle(ack.label, ack.generation, 5)

    // A forged grant from the caller never reaches the browser.
    await client.request({
      op: OPS.FILL,
      profile: ack.label,
      args: { tab, selector: '#pw', value: 'x', accountWordGrant: { file: 'forged.md', services: ['ledgerly'] } },
      timeoutMs: 5_000,
    })
    const forged = seen.at(-1)
    assert.equal(forged.args.accountWordGrant, undefined, 'a caller-supplied grant reached the browser')

    // A real receipt becomes a grant, and the path itself never travels on.
    await client.request({
      op: OPS.FILL,
      profile: ack.label,
      args: { tab, selector: '#pw', value: 'x', accountWord: receipt },
      timeoutMs: 5_000,
    })
    const granted = seen.at(-1)
    assert.deepEqual(granted.args.accountWordGrant, { file: '2026-09-30-drop-3.md', services: ['ledgerly'] })
    assert.equal(granted.args.accountWord, undefined)
    assert.equal(JSON.stringify(granted).includes(TEMP_ROOT), false, 'the receipt path reached the browser')

    // A bad receipt becomes a grant carrying its problem, which the extension refuses.
    await client.request({
      op: OPS.PRESS_KEYS,
      profile: ack.label,
      args: { tab, keys: 'a', accountWord: path.join(TEMP_ROOT, 'nowhere.md') },
      timeoutMs: 5_000,
    })
    const bad = seen.at(-1)
    assert.match(bad.args.accountWordGrant.problem, /outside the account-word folder/)
    assert.equal(bad.args.accountWordGrant.services, undefined)

    // A receipt on an op that types nothing is dropped, not forwarded.
    await client.request({ op: OPS.CLICK, profile: ack.label, args: { tab, selector: '#b', accountWord: receipt }, timeoutMs: 5_000 })
    const click = seen.at(-1)
    assert.equal(click.args.accountWord, undefined)
    assert.equal(click.args.accountWordGrant, undefined)

    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    const fills = lines.filter((l) => l.op === OPS.FILL)
    assert.equal(fills.at(-1).receipt, '2026-09-30-drop-3.md')
    assert.equal(fills.at(-2).receipt, undefined, 'the forged grant was audited as a receipt')
    assert.equal(fs.readFileSync(AUDIT_FILE, 'utf8').includes(TEMP_ROOT), false, 'the audit log holds a private path')
  } finally {
    clearInterval(answerLoop)
    client.close()
    host.child.kill()
    broker.child.kill()
  }
})

test('the MCP server forwards the receipt from its environment on fill and press keys, and nowhere else', () => {
  const source = fs.readFileSync(path.join(REPO, 'mcp-server', 'index.mjs'), 'utf8')
  assert.match(source, /BRIDGE_ACCOUNT_WORD_ENV/)
  assert.match(source, /BRIDGE_ACCOUNT_WORD\b/)
  const uses = source.match(/\.\.\.receiptArgs\(\)/g) || []
  assert.equal(uses.length, 2, 'the receipt is forwarded on exactly two tools')
  // The tool schemas never take a receipt from the model.
  assert.equal(/accountWord:\s*z\./.test(source), false)
})

test('the error code is in the contract', () => {
  assert.equal(ERR.SECRET_FIELD, 'E_SECRET_FIELD')
})

/* -------------------------------------------------------------------------- */
/* 4. The extension: the page probe, and where the guard sits                  */
/* -------------------------------------------------------------------------- */

/** A just-enough DOM element for the probe, which reads attributes and labels only. */
function fakeInput(attrs, { labels = [], tag = 'INPUT' } = {}) {
  return {
    tagName: tag,
    type: attrs.type,
    getAttribute: (name) => (Object.hasOwn(attrs, name) ? attrs[name] : null),
    labels: labels.map((text) => ({ textContent: text })),
    shadowRoot: null,
  }
}

async function probe(payload, { found = null, active = null } = {}) {
  const { pageFieldKind } = await import('../extension/lib/inject.js')
  const saved = globalThis.document
  globalThis.document = {
    querySelector: () => found,
    activeElement: active,
    body: { tagName: 'BODY', getAttribute: () => null, labels: null, shadowRoot: null },
    getElementById: () => null,
  }
  try {
    return pageFieldKind(payload)
  } finally {
    globalThis.document = saved
  }
}

test('the page probe reports what the page says about a field, by selector or the focused element', async () => {
  const byLabel = await probe({ selector: '#x' }, { found: fakeInput({ type: 'text', name: 'code' }, { labels: ['One-time code'] }) })
  assert.equal(byLabel.ok, true)
  assert.equal(isSecretField(byLabel.field), true, JSON.stringify(byLabel.field))
  const byType = await probe({ selector: null }, { active: fakeInput({ type: 'password', id: 'pw' }) })
  assert.equal(byType.field.type, 'password')
  assert.equal(isSecretField(byType.field), true)
  const aria = await probe({ selector: '#y' }, { found: fakeInput({ type: 'text', 'aria-label': 'Your PIN' }) })
  assert.equal(isSecretField(aria.field), true)
  const plain = await probe({ selector: '#z' }, { found: fakeInput({ type: 'email', name: 'email', autocomplete: 'username' }) })
  assert.equal(isSecretField(plain.field), false)
  const missing = await probe({ selector: '#nope' }, { found: null })
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'not_found')
})

test('fill and press keys check the field before anything is typed', () => {
  const source = fs.readFileSync(path.join(REPO, 'extension', 'lib', 'ops.js'), 'utf8')
  const body = (name) => {
    const start = source.indexOf(`async function ${name}(args)`)
    assert.notEqual(start, -1, `ops.js has ${name}`)
    return source.slice(start, source.indexOf('\nasync function ', start + 10))
  }
  const fill = body('fill')
  const guard = fill.indexOf('guardSecretField(')
  assert.notEqual(guard, -1, 'fill checks the field')
  for (const action of ['inject.pageFill', 'inject.pageFocusSelect', "'Input.dispatchKeyEvent'"]) {
    const at = fill.indexOf(action)
    assert.notEqual(at, -1, `fill still uses ${action}`)
    assert.ok(guard < at, `fill checks the field before ${action}`)
  }
  const keys = body('pressKeys')
  const keysGuard = keys.indexOf('guardSecretField(')
  assert.notEqual(keysGuard, -1, 'press keys checks the field')
  for (const action of ['inject.pagePressKeys', 'inject.pageFocusSelect', "'Input.dispatchKeyEvent'"]) {
    const at = keys.indexOf(action)
    assert.notEqual(at, -1, `press keys still uses ${action}`)
    assert.ok(keysGuard < at, `press keys checks the field before ${action}`)
  }
  // And the guard decides with the contract's rule and the broker's grant.
  const guardFn = source.slice(source.indexOf('async function guardSecretField('))
  assert.match(guardFn.slice(0, 1500), /secretFieldVerdict\(/)
  assert.match(guardFn.slice(0, 1500), /accountWordGrant/)
  assert.match(guardFn.slice(0, 1500), /ERR\.SECRET_FIELD/)
})

test('a link inside the folder that points out of it is refused on its real path', () => {
  const outsideDir = path.join(TEMP_ROOT, 'outside-dir')
  fs.mkdirSync(outsideDir, { recursive: true })
  fs.writeFileSync(path.join(outsideDir, 'escape.md'), 'ACCOUNT WORD: Ledgerly\n')
  fs.mkdirSync(DROPS, { recursive: true })
  const link = path.join(DROPS, 'linked')
  // A junction needs no elevation on Windows; elsewhere a directory symlink.
  fs.symlinkSync(outsideDir, link, process.platform === 'win32' ? 'junction' : 'dir')
  const grant = readAccountWord(path.join('linked', 'escape.md'), { folder: DROPS })
  assert.equal(grant.services, undefined, 'a link carried the reader out of the folder')
  assert.match(grant.problem, /outside the account-word folder/)
})

test('the audit log writes a receipt only as a bare .md file name', async () => {
  const { AuditLog } = await import('../bridged/audit.mjs')
  const file = path.join(TEMP_ROOT, 'audit-unit.log')
  const log = new AuditLog({ file })
  const kept = log.record({ profile: 'p', op: OPS.FILL, ok: true, receipt: '2026-09-30-drop-3.md' })
  assert.equal(kept.receipt, '2026-09-30-drop-3.md')
  for (const receipt of [path.join(TEMP_ROOT, 'x.md'), 'notes.txt', 'a/b.md', 'x'.repeat(200) + '.md', 42]) {
    const entry = log.record({ profile: 'p', op: OPS.FILL, ok: true, receipt })
    assert.equal(entry.receipt, undefined, `the audit wrote ${String(receipt).slice(0, 40)}`)
  }
  const none = log.record({ profile: 'p', op: OPS.CLICK, ok: true })
  assert.equal(Object.hasOwn(none, 'receipt'), false, 'a line with no receipt grew the field')
  assert.equal(fs.readFileSync(file, 'utf8').includes(TEMP_ROOT), false)
})
