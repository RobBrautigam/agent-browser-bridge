/**
 * runtime.json tests.
 *
 * runtime.json is the authentication contract for every pipe client. The broker
 * writes it on each start with a freshly minted token; the host, the MCP client
 * and doctor read it on every connect attempt. Before the shape was pinned in
 * shared/paths.mjs, three consumers were each guessing at it - doctor alone
 * tried three different key names - and the failure mode of a wrong guess is an
 * E_UNAUTHORIZED that looks exactly like a genuinely stale token.
 *
 * The read path also has to be total. A missing file, a truncated file and a
 * file with the wrong type in it all mean the same thing operationally, "the
 * broker has not authenticated us yet", and every client already treats that as
 * retryable. A throw there takes down a client that should have waited.
 *
 * ISOLATION: paths.mjs resolves BASE_DIR from %LOCALAPPDATA% at module load, so
 * this file redirects that variable to a temp directory BEFORE importing it.
 * That is why the import is dynamic and why there is a hard assertion below
 * that BASE_DIR really did land in the temp tree - a test that writes into the
 * real state directory could clobber a running broker's token.
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-runtime-'))
// BRIDGE_HOME overrides the whole state directory on every platform, which is
// what keeps this file away from a live install's runtime token.
process.env.BRIDGE_HOME = path.join(TEMP_ROOT, 'state')

// Dynamic, and after the assignment above. A static import would be hoisted
// above it and paths.mjs would compute the real BASE_DIR.
const paths = await import('../shared/paths.mjs')
const {
  BASE_DIR,
  RUNTIME_FILE,
  RUNTIME_TOKEN_KEY,
  writeRuntime,
  readRuntime,
  readRuntimeToken,
  readJson,
  writeJsonAtomic,
} = paths

after(() => fs.rmSync(TEMP_ROOT, { recursive: true, force: true }))

/** Blow away the runtime file between cases without touching anything else. */
function clearRuntime() {
  fs.rmSync(RUNTIME_FILE, { force: true })
}

/* -------------------------------------------------------------------------- */
/* The isolation guard itself                                                  */
/* -------------------------------------------------------------------------- */

test('the suite is pointed at a temp directory, not the real state directory', () => {
  // A guard, not a formality. If node ever stops running each test file in its
  // own process, another file could import paths.mjs first and this whole file
  // would start writing tokens into the state directory, where a
  // live broker keeps the token every client is authenticating with.
  assert.ok(
    BASE_DIR.startsWith(TEMP_ROOT),
    `BASE_DIR escaped the temp tree: ${BASE_DIR} is not under ${TEMP_ROOT}`
  )
  assert.ok(RUNTIME_FILE.startsWith(TEMP_ROOT), `RUNTIME_FILE escaped the temp tree: ${RUNTIME_FILE}`)
  assert.equal(path.basename(RUNTIME_FILE), 'runtime.json')
})

/* -------------------------------------------------------------------------- */
/* Round-trip                                                                  */
/* -------------------------------------------------------------------------- */

test('writeRuntime then readRuntime returns the pinned six-key shape', () => {
  clearRuntime()
  const before = Date.now()

  const written = writeRuntime({
    token: 'a-per-boot-token',
    version: '0.1.0',
    pipeName: '\\\\.\\pipe\\agent-browser-bridge',
  })

  const read = readRuntime()
  assert.deepEqual(Object.keys(read).sort(), ['auth', 'pid', 'pipeName', 'startedAt', 'token', 'version'])
  assert.deepEqual(read, written, 'the value returned to the broker must be the value on disk')

  assert.equal(read.token, 'a-per-boot-token')
  assert.equal(read.auth, 'hmac-sha256-v1', 'the HELLO scheme clients must use with this broker')
  assert.equal(read.version, '0.1.0')
  assert.equal(read.pipeName, '\\\\.\\pipe\\agent-browser-bridge')
  assert.equal(read.pid, process.pid, 'the pid is how doctor tells a live broker from a stale file')
  assert.ok(read.startedAt >= before && read.startedAt <= Date.now())
})

test('readRuntimeToken returns the token the broker just wrote', () => {
  clearRuntime()
  writeRuntime({ token: 'tok-1', version: '0.1.0', pipeName: 'p' })
  assert.equal(readRuntimeToken(), 'tok-1')
})

test('the token key is the one name every client reads', () => {
  // Named as a constant precisely so a consumer cannot invent `authToken` or
  // `secret` and fail with an error that names neither.
  clearRuntime()
  writeRuntime({ token: 'tok-2', version: '0.1.0', pipeName: 'p' })
  assert.equal(RUNTIME_TOKEN_KEY, 'token')
  assert.equal(readJson(RUNTIME_FILE)[RUNTIME_TOKEN_KEY], 'tok-2')
})

test('a rewrite replaces the token rather than merging with the old one', () => {
  // The token rotates on every broker start, so a leaked one dies at the next
  // restart. That guarantee is only real if the new file fully replaces the old
  // - a merge would leave the previous token readable.
  clearRuntime()
  writeRuntime({ token: 'old-token', version: '0.1.0', pipeName: 'p' })
  writeRuntime({ token: 'new-token', version: '0.2.0', pipeName: 'p' })

  assert.equal(readRuntimeToken(), 'new-token')
  const raw = fs.readFileSync(RUNTIME_FILE, 'utf8')
  assert.ok(!raw.includes('old-token'), 'the previous token is still on disk')
})

test('writeRuntime creates the state directory when it does not exist yet', () => {
  // First run on a fresh machine: the state directory does not exist.
  fs.rmSync(BASE_DIR, { recursive: true, force: true })
  assert.equal(fs.existsSync(BASE_DIR), false)

  writeRuntime({ token: 'first-run', version: '0.1.0', pipeName: 'p' })
  assert.equal(readRuntimeToken(), 'first-run')
})

/* -------------------------------------------------------------------------- */
/* The three "not authenticated yet" cases                                     */
/* -------------------------------------------------------------------------- */

test('readRuntimeToken returns null when the broker has never run', () => {
  // No file at all. Every client polls for this on startup, so it must be a
  // null and not an ENOENT throw.
  clearRuntime()
  assert.equal(fs.existsSync(RUNTIME_FILE), false)
  assert.equal(readRuntimeToken(), null)
  assert.equal(readRuntime(), null)
})

test('readRuntimeToken returns null for a malformed file, and does not throw', () => {
  // Reachable in practice: a client can read the file in the window between
  // create and rename on a machine where the atomic write is not atomic, or
  // after a disk-full truncation.
  for (const junk of ['', '   ', '{ "token": "tru', 'not json at all', '[]', 'null']) {
    fs.writeFileSync(RUNTIME_FILE, junk, 'utf8')
    assert.equal(readRuntimeToken(), null, `malformed content ${JSON.stringify(junk)} threw or leaked`)
  }
})

test('readRuntimeToken returns null when the token is present but not a string', () => {
  // The third case, and the one a `if (runtime.token)` check would get wrong:
  // a number or an object is truthy, so a client would send it as a token and
  // get an E_UNAUTHORIZED that reads like a rotation race instead of a bad file.
  for (const bad of [42, true, null, {}, [], { nested: 'token' }]) {
    writeJsonAtomic(RUNTIME_FILE, { pipeName: 'p', token: bad, pid: 1, startedAt: 0, version: '0' })
    assert.equal(readRuntimeToken(), null, `a token of ${JSON.stringify(bad)} was accepted`)
  }

  // An empty string is the same story: present, a string, and useless.
  writeJsonAtomic(RUNTIME_FILE, { pipeName: 'p', token: '', pid: 1, startedAt: 0, version: '0' })
  assert.equal(readRuntimeToken(), null, 'an empty token must not authenticate anything')
})

test('readRuntimeToken returns null when the key is missing entirely', () => {
  writeJsonAtomic(RUNTIME_FILE, { pipeName: 'p', pid: 1, startedAt: 0, version: '0' })
  assert.equal(readRuntimeToken(), null)

  // readRuntime still hands back what IS there, so doctor can say which key is
  // missing rather than just "no token".
  assert.deepEqual(readRuntime(), { pipeName: 'p', pid: 1, startedAt: 0, version: '0' })
})

/* -------------------------------------------------------------------------- */
/* The atomic write underneath it                                              */
/* -------------------------------------------------------------------------- */

test('writeJsonAtomic leaves no temp file behind', () => {
  // The write goes to a pid-suffixed temp file and is renamed into place, so a
  // crash mid-write cannot leave a truncated runtime.json that reads as
  // malformed and locks every client out until someone deletes it by hand.
  clearRuntime()
  writeRuntime({ token: 'tok', version: '0.1.0', pipeName: 'p' })

  const strays = fs.readdirSync(BASE_DIR).filter((f) => f.includes('.tmp-'))
  assert.deepEqual(strays, [], `temp files left behind: ${strays.join(', ')}`)
})

test('readJson returns the caller fallback rather than throwing on anything unreadable', () => {
  // The primitive the three cases above are built on, checked directly so a
  // change to it fails here rather than as a confusing symptom elsewhere.
  const missing = path.join(BASE_DIR, 'does-not-exist.json')
  assert.equal(readJson(missing), null, 'the default fallback is null')
  assert.deepEqual(readJson(missing, { fallback: true }), { fallback: true })

  const bad = path.join(BASE_DIR, 'bad.json')
  fs.writeFileSync(bad, '{ nope', 'utf8')
  assert.deepEqual(readJson(bad, []), [])
})
