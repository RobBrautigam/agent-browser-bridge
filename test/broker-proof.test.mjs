/**
 * Broker proof tests: a client trusts nothing from a pipe that cannot prove it
 * holds this boot's token, and never hands the token to it.
 *
 * The attack these pin: on Windows a pipe name is global, so another account
 * that creates the broker's pipe name while the broker is down becomes "the
 * broker" (the real one exits on EADDRINUSE). Before shared/auth.mjs the MCP
 * client sent that impostor the token and accepted any ok HELLO_ACK; the host
 * did the same and then relayed the impostor's requests to the browser.
 *
 * The end-to-end cases run the real BrokerClient against a fake server on a
 * throwaway pipe name (a temp socket file on macOS and Linux). They never touch
 * the configured pipe name, so a broker running on this machine is untouched,
 * and BRIDGE_HOME points the runtime file at a temp directory, as
 * runtime-file.test.mjs does, so a live broker's token is never read or
 * overwritten.
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-proof-'))
process.env.BRIDGE_HOME = path.join(TEMP_ROOT, 'state')

// Dynamic, and after the assignment above, so paths.mjs resolves the temp tree.
const { BASE_DIR, RUNTIME_FILE, writeRuntime, writeJsonAtomic, readRuntimeCredentials } = await import(
  '../shared/paths.mjs'
)
const auth = await import('../shared/auth.mjs')
const { BrokerClient } = await import('../mcp-server/client.mjs')
const { FrameDecoder, writeFrame } = await import('../shared/framing.mjs')
const { ERR, MSG, ROLE, helloAck, ok } = await import('../shared/protocol.mjs')

after(() => fs.rmSync(TEMP_ROOT, { recursive: true, force: true }))

const TOKEN = crypto.randomBytes(32).toString('hex')

test('the suite is pointed at a temp directory, not the real state directory', () => {
  assert.ok(BASE_DIR.startsWith(TEMP_ROOT), `BASE_DIR escaped the temp tree: ${BASE_DIR}`)
  assert.ok(RUNTIME_FILE.startsWith(TEMP_ROOT))
})

/* -------------------------------------------------------------------------- */
/* The pure handshake                                                          */
/* -------------------------------------------------------------------------- */

test('a client proof is accepted once, and the broker answers with a proof the client accepts', () => {
  const ledger = new auth.NonceLedger()
  const { fields, expect } = auth.helloCredentials({ token: TOKEN, scheme: auth.AUTH_SCHEME, role: ROLE.HOST })

  assert.equal('token' in fields, false, 'the scheme must never put the token on the wire')
  assert.ok(auth.isNonce(fields.nonce))

  const verdict = auth.authenticateHello({ role: ROLE.HOST, ...fields }, TOKEN, ledger)
  assert.equal(verdict.ok, true)
  assert.equal(auth.ackProvesBroker({ ok: true, proof: verdict.proof }, expect), true)

  const replay = auth.authenticateHello({ role: ROLE.HOST, ...fields }, TOKEN, ledger)
  assert.equal(replay.ok, false, 'the same nonce must not authenticate twice in one boot')
  assert.equal(replay.proof, undefined)
})

test('the broker refuses a proof made with another token, for another role, or malformed', () => {
  const ledger = new auth.NonceLedger()
  const other = crypto.randomBytes(32).toString('hex')
  const nonce = auth.newNonce()

  const cases = [
    ['another token', { auth: auth.AUTH_SCHEME, role: ROLE.MCP, nonce, proof: auth.clientProof(other, ROLE.MCP, nonce) }],
    ['another role', { auth: auth.AUTH_SCHEME, role: ROLE.HOST, nonce, proof: auth.clientProof(TOKEN, ROLE.MCP, nonce) }],
    ['the broker label', { auth: auth.AUTH_SCHEME, role: ROLE.MCP, nonce, proof: auth.brokerProof(TOKEN, ROLE.MCP, nonce) }],
    ['no proof', { auth: auth.AUTH_SCHEME, role: ROLE.MCP, nonce }],
    ['a short nonce', { auth: auth.AUTH_SCHEME, role: ROLE.MCP, nonce: 'ab', proof: auth.clientProof(TOKEN, ROLE.MCP, 'ab') }],
    ['upper-case hex', { auth: auth.AUTH_SCHEME, role: ROLE.MCP, nonce, proof: auth.clientProof(TOKEN, ROLE.MCP, nonce).toUpperCase() }],
  ]
  for (const [name, msg] of cases) {
    const verdict = auth.authenticateHello(msg, TOKEN, ledger)
    assert.equal(verdict.ok, false, `${name} authenticated`)
    assert.equal(verdict.proof, undefined, `${name} got a broker proof back`)
  }
})

test('the legacy token HELLO still authenticates, so a client from before the upgrade keeps working', () => {
  const ledger = new auth.NonceLedger()
  assert.equal(auth.authenticateHello({ role: ROLE.MCP, token: TOKEN }, TOKEN, ledger).ok, true)
  assert.equal(auth.authenticateHello({ role: ROLE.MCP, token: 'x' + TOKEN.slice(1) }, TOKEN, ledger).ok, false)
  assert.equal(auth.authenticateHello({ role: ROLE.MCP, token: null }, TOKEN, ledger).ok, false)
  assert.equal(auth.authenticateHello({ role: ROLE.MCP }, TOKEN, ledger).ok, false)
})

test('a client refuses an ack with no proof, a reflected proof, or a proof from another token', () => {
  const { fields, expect } = auth.helloCredentials({ token: TOKEN, scheme: auth.AUTH_SCHEME, role: ROLE.MCP })
  const other = crypto.randomBytes(32).toString('hex')

  assert.equal(auth.ackProvesBroker({ ok: true }, expect), false)
  assert.equal(auth.ackProvesBroker({ ok: true, proof: fields.proof }, expect), false, 'its own proof reflected back')
  assert.equal(auth.ackProvesBroker({ ok: true, proof: auth.brokerProof(other, ROLE.MCP, fields.nonce) }, expect), false)
  assert.equal(auth.ackProvesBroker({ ok: true, proof: auth.brokerProof(TOKEN, ROLE.HOST, fields.nonce) }, expect), false)
  assert.equal(auth.ackProvesBroker({ ok: true, proof: auth.brokerProof(TOKEN, ROLE.MCP, fields.nonce) }, expect), true)
})

test('the nonce ledger is bounded', () => {
  const ledger = new auth.NonceLedger(3)
  for (const n of ['a', 'b', 'c', 'd']) assert.equal(ledger.claim(n), true)
  assert.equal(ledger.size, 3)
  assert.equal(ledger.claim('d'), false)
})

/* -------------------------------------------------------------------------- */
/* The runtime file advertises the scheme                                      */
/* -------------------------------------------------------------------------- */

test('writeRuntime advertises the scheme, and readRuntimeCredentials reads token and scheme together', () => {
  writeRuntime({ token: TOKEN, version: '0.0.0', pipeName: 'p' })
  assert.deepEqual(readRuntimeCredentials(), { token: TOKEN, scheme: auth.AUTH_SCHEME })

  // A file from a broker older than the scheme: the client must use the token HELLO.
  writeJsonAtomic(RUNTIME_FILE, { pipeName: 'p', token: TOKEN, pid: 1, startedAt: 0, version: '0.4.1' })
  assert.deepEqual(readRuntimeCredentials(), { token: TOKEN, scheme: null })

  fs.rmSync(RUNTIME_FILE, { force: true })
  assert.deepEqual(readRuntimeCredentials(), { token: null, scheme: null })
})

/* -------------------------------------------------------------------------- */
/* The real client against a fake server on a throwaway endpoint               */
/* -------------------------------------------------------------------------- */

function throwawayEndpoint() {
  const tag = `abb-test-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  return process.platform === 'win32' ? `\\\\.\\pipe\\${tag}` : path.join(TEMP_ROOT, `${tag}.sock`)
}

/**
 * A server that records every frame it gets and answers HELLO with whatever
 * `answer(hello)` returns, then answers any REQ with ok. That second half is the
 * point: an impostor that got past the handshake could say anything.
 */
async function fakeBroker(answer) {
  const endpoint = throwawayEndpoint()
  const seen = []
  const sockets = new Set()
  const server = net.createServer((sock) => {
    sockets.add(sock)
    const decoder = new FrameDecoder()
    sock.on('error', () => {})
    sock.on('close', () => sockets.delete(sock))
    sock.on('data', (chunk) => {
      for (const msg of decoder.push(chunk)) {
        seen.push(msg)
        if (msg.type === MSG.HELLO) writeFrame(sock, answer(msg))
        else if (msg.type === MSG.REQ) writeFrame(sock, ok(msg.id, { from: 'the fake broker' }))
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, resolve)
  })
  return {
    endpoint,
    seen,
    async close() {
      for (const sock of sockets) sock.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function requestThrough(endpoint) {
  const client = new BrokerClient({ socketPath: endpoint })
  try {
    return await client.request({ op: 'status', timeoutMs: 2_000 })
  } finally {
    client.close()
  }
}

test('the MCP client refuses a pipe that answers HELLO ok without a proof, and sends it no token and no request', async () => {
  writeRuntime({ token: TOKEN, version: '0.0.0', pipeName: 'p' })
  const squatter = await fakeBroker(() => helloAck({ ok: true, role: ROLE.MCP }))
  try {
    await assert.rejects(requestThrough(squatter.endpoint), (err) => {
      assert.equal(err.code, ERR.UNAUTHORIZED)
      return true
    })
    const hello = squatter.seen.find((m) => m.type === MSG.HELLO)
    assert.ok(hello, 'the client never said HELLO')
    assert.equal(JSON.stringify(squatter.seen).includes(TOKEN), false, 'the token crossed the pipe')
    assert.deepEqual(
      squatter.seen.filter((m) => m.type === MSG.REQ),
      [],
      'a request went to a pipe that never proved itself'
    )
  } finally {
    await squatter.close()
  }
})

test('the MCP client refuses a proof made with a different token', async () => {
  writeRuntime({ token: TOKEN, version: '0.0.0', pipeName: 'p' })
  const guess = crypto.randomBytes(32).toString('hex')
  const squatter = await fakeBroker((h) =>
    helloAck({ ok: true, role: h.role, proof: auth.brokerProof(guess, h.role, h.nonce) })
  )
  try {
    await assert.rejects(requestThrough(squatter.endpoint), (err) => err.code === ERR.UNAUTHORIZED)
    assert.deepEqual(squatter.seen.filter((m) => m.type === MSG.REQ), [])
  } finally {
    await squatter.close()
  }
})

test('the MCP client works with a broker that proves itself', async () => {
  writeRuntime({ token: TOKEN, version: '0.0.0', pipeName: 'p' })
  const ledger = new auth.NonceLedger()
  const broker = await fakeBroker((h) => {
    const verdict = auth.authenticateHello(h, TOKEN, ledger)
    return verdict.ok
      ? helloAck({ ok: true, role: h.role, proof: verdict.proof })
      : helloAck({ ok: false, error: { code: ERR.UNAUTHORIZED, message: 'no' } })
  })
  try {
    assert.deepEqual(await requestThrough(broker.endpoint), { from: 'the fake broker' })
    const hello = broker.seen.find((m) => m.type === MSG.HELLO)
    assert.equal(hello.auth, auth.AUTH_SCHEME)
    assert.equal(hello.token, undefined)
  } finally {
    await broker.close()
  }
})

test('with a runtime file from an older broker, the MCP client still sends the token HELLO', async () => {
  writeJsonAtomic(RUNTIME_FILE, { pipeName: 'p', token: TOKEN, pid: 1, startedAt: 0, version: '0.4.1' })
  const old = await fakeBroker((h) =>
    auth.sameToken(h.token, TOKEN)
      ? helloAck({ ok: true, role: h.role })
      : helloAck({ ok: false, error: { code: ERR.UNAUTHORIZED, message: 'no' } })
  )
  try {
    assert.deepEqual(await requestThrough(old.endpoint), { from: 'the fake broker' })
  } finally {
    await old.close()
  }
})

/* -------------------------------------------------------------------------- */
/* The other three HELLO senders go through the same check                     */
/* -------------------------------------------------------------------------- */

test('the broker, the host and doctor use the shared handshake, not a token of their own', () => {
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
  const broker = read('../bridged/index.mjs')
  const host = read('../host/index.mjs')
  const doctor = read('../scripts/doctor.mjs')

  assert.match(broker, /authenticateHello\(msg, TOKEN, /, 'the broker does not run authenticateHello on HELLO')
  assert.match(broker, /proof: verdict\.proof/, 'the broker does not answer with its proof')
  for (const [name, src] of [['host', host], ['doctor', doctor]]) {
    assert.match(src, /helloCredentials\(/, `${name} does not build HELLO through helloCredentials`)
    assert.match(src, /ackProvesBroker\(/, `${name} does not check the ack's proof`)
    assert.doesNotMatch(src, /hello\(\{[^}]*\btoken\b[^}]*\}\)/, `${name} still puts the token in HELLO itself`)
  }
})
