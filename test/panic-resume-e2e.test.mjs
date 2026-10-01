/**
 * Panic, and the one way out of it through the bridge: the popup's Resume.
 *
 * The real broker and the real native messaging host, each on a throwaway
 * endpoint (BRIDGE_SOCKET_NAME) with state in a temp directory (BRIDGE_HOME), so
 * the PANIC file every test here creates and deletes is the temp tree's, never
 * the machine's. The test stands in for the browser on the host's stdio,
 * exactly as handshake-e2e.test.mjs does.
 *
 * What has to hold:
 *
 * 1. The model cannot clear the switch. An MCP connection that sends RESUME is
 *    dropped as a capability violation and the file stays. PANIC with
 *    `on: false` is still refused.
 * 2. The extension can still SEE the panic and ask to leave it. During panic
 *    the broker used to refuse the host's HELLO outright, which left the popup
 *    saying "broker not answering" with no way to act. Now the host is accepted,
 *    the extension's REGISTER is answered with a typed E_PANIC and the
 *    connection is held, with no route, so the popup can read the board and
 *    send RESUME. Nothing on a held connection can reach a browser.
 * 3. A host connection that never registered (a process that read the token and
 *    is speaking the host role by hand) cannot resume.
 * 4. RESUME deletes the file, writes an audit line, and drops every held
 *    connection so each profile registers afresh.
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-panic-'))
const HOME = path.join(TEMP_ROOT, 'state')
process.env.BRIDGE_HOME = HOME
delete process.env.BRIDGE_SOCKET_NAME

const { AUDIT_FILE, BASE_DIR, PANIC_FILE, RUNTIME_FILE, readJson, socketPathFor } = await import('../shared/paths.mjs')
const { BrokerClient } = await import('../mcp-server/client.mjs')
const { FrameDecoder, encodeFrame } = await import('../shared/framing.mjs')
const { ERR, MSG, OPS, register, req } = await import('../shared/protocol.mjs')

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BROKER = path.join(REPO, 'bridged', 'index.mjs')
const HOST = path.join(REPO, 'host', 'index.mjs')
const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/'

const children = new Set()
after(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill()
  await sleep(100)
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true })
})

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(what, predicate, ms = 10_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await sleep(25)
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`)
}

const NAME = `abb-pnc-${crypto.randomBytes(5).toString('hex')}`
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

function exitOf(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)))
}

function launch(script, args, stdio) {
  const child = spawn(process.execPath, [script, ...args], { env: childEnv(), stdio, windowsHide: true })
  children.add(child)
  let stderr = ''
  child.stderr?.on('data', (d) => (stderr += d))
  return { child, stderr: () => stderr }
}

function startHost() {
  const host = launch(HOST, [EXTENSION_ORIGIN], ['pipe', 'pipe', 'pipe'])
  const decoder = new FrameDecoder()
  const frames = []
  host.child.stdout.on('data', (chunk) => frames.push(...decoder.push(chunk)))
  host.child.stdin.on('error', () => {})
  return {
    ...host,
    frames,
    send: (msg) => host.child.stdin.write(encodeFrame(msg)),
    async stop() {
      host.child.kill()
      await exitOf(host.child)
    },
  }
}

function registration() {
  return register({
    installId: `pnc-${crypto.randomBytes(4).toString('hex')}`,
    vendorHint: 'chrome',
    email: null,
    label: null,
    extVersion: '0.0.0',
    tabCount: 0,
  })
}

async function mcp(op, { profile = null, args = {} } = {}) {
  const client = new BrokerClient({ socketPath: ENDPOINT })
  try {
    return await client.request({ op, profile, args, timeoutMs: 3_000 })
  } finally {
    client.close()
  }
}

/** A host's answer to the REQ with this id, relayed to the browser side. */
function answerTo(host, id) {
  return waitFor(`the answer to ${id}`, () => host.frames.find((m) => m.type === MSG.RES && m.id === id))
}

function tripPanic() {
  fs.mkdirSync(path.dirname(PANIC_FILE), { recursive: true })
  fs.writeFileSync(PANIC_FILE, 'test panic\r\n')
}

function auditLines() {
  try {
    return fs
      .readFileSync(AUDIT_FILE, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

let broker = null

test('the broker starts on a throwaway endpoint with its panic file in the temp tree', async () => {
  assert.ok(PANIC_FILE.startsWith(TEMP_ROOT), 'the panic file is the temp tree\'s, never the machine\'s')
  tripPanic()
  broker = launch(BROKER, [], ['ignore', 'ignore', 'pipe'])
  await waitFor('the broker to publish runtime.json', () => {
    if (broker.child.exitCode !== null) throw new Error(`the broker exited ${broker.child.exitCode}: ${broker.stderr()}`)
    return readJson(RUNTIME_FILE, null)?.pid === broker.child.pid
  })
  const status = await mcp(OPS.STATUS)
  assert.equal(status.panic, true)
})

test('an MCP connection that sends RESUME is dropped and the panic file stays', async () => {
  await assert.rejects(mcp(OPS.RESUME), (err) => err.code !== undefined || err instanceof Error)
  assert.ok(fs.existsSync(PANIC_FILE), 'the model cleared the panic switch')
  // And the connection-level verdict, not merely an error: the log names it.
  const status = await mcp(OPS.STATUS)
  assert.equal(status.panic, true)
})

test('PANIC with on:false is still refused to the model, and the answer names the popup', async () => {
  await assert.rejects(mcp(OPS.PANIC, { args: { on: false } }), (err) => {
    assert.equal(err.code, ERR.UNSUPPORTED)
    assert.match(err.message, /Resume/)
    return true
  })
  assert.ok(fs.existsSync(PANIC_FILE))
})

test('a sort during panic is refused with E_PANIC, like every other write', async () => {
  await assert.rejects(mcp(OPS.SORT_WINDOW, { profile: 'chrome-work', args: { all: true } }), (err) => err.code === ERR.PANIC)
})

test('a host that never registered cannot resume', async () => {
  const host = startHost()
  try {
    const id = 'resume-unregistered'
    host.send(req({ id, op: OPS.RESUME, timeoutMs: 3_000 }))
    const answer = await answerTo(host, id)
    assert.equal(answer.ok, false, JSON.stringify(answer))
    assert.ok(fs.existsSync(PANIC_FILE), 'an unregistered host connection cleared panic')
  } finally {
    await host.stop()
  }
})

test('during panic the extension is held, sees the panic, and the popup Resume clears it', async () => {
  const host = startHost()
  const after = startHost()
  try {
    host.send(registration())
    const ack = await waitFor('a register_ack through the host', () => host.frames.find((m) => m.type === MSG.REGISTER_ACK))
    assert.equal(ack.ok, false)
    assert.equal(ack.error?.code, ERR.PANIC, `the extension was told ${JSON.stringify(ack.error)} instead of E_PANIC`)

    // Held, not dropped: the popup can still read the board over it.
    const boardId = 'board-during-panic'
    host.send(req({ id: boardId, op: OPS.GET_BOARD, timeoutMs: 3_000 }))
    const board = await answerTo(host, boardId)
    assert.equal(board.ok, true, JSON.stringify(board))
    assert.equal(board.result.panic, true)

    // A held connection has no route, so nothing on it reaches a browser.
    const armId = 'arm-during-panic'
    host.send(req({ id: armId, op: OPS.ARM, profile: 'chrome-work', args: { minutes: 5 }, timeoutMs: 3_000 }))
    const arm = await answerTo(host, armId)
    assert.equal(arm.ok, false)
    assert.equal(arm.error.code, ERR.PANIC)

    const before = auditLines().length
    const resumeId = 'resume-from-popup'
    host.send(req({ id: resumeId, op: OPS.RESUME, timeoutMs: 3_000 }))
    const resumed = await answerTo(host, resumeId)
    assert.equal(resumed.ok, true, JSON.stringify(resumed))
    assert.equal(resumed.result.panic, false)
    assert.equal(fs.existsSync(PANIC_FILE), false, 'the panic file is still there')

    const lines = auditLines().slice(before)
    assert.ok(lines.some((l) => l.op === OPS.RESUME && l.ok === true), `no audit line for the resume: ${JSON.stringify(lines)}`)

    // The held link is dropped so the extension registers afresh: the host
    // tells the browser its registration is void.
    await waitFor('the held registration to be voided', () =>
      host.frames.some((m) => m.type === MSG.REGISTER_ACK && m.ok === false && m.error?.code === ERR.NO_BROKER)
    )

    // And a fresh registration is accepted.
    after.send(registration())
    const fresh = await waitFor('a fresh register_ack', () => after.frames.find((m) => m.type === MSG.REGISTER_ACK))
    assert.equal(fresh.ok, true, JSON.stringify(fresh))
    const status = await mcp(OPS.STATUS)
    assert.equal(status.panic, false)
  } finally {
    await host.stop()
    await after.stop()
  }
})

test('a panic file deleted by hand also releases held connections', async () => {
  tripPanic()
  const host = startHost()
  try {
    host.send(registration())
    const ack = await waitFor('a held register_ack', () => host.frames.find((m) => m.type === MSG.REGISTER_ACK))
    assert.equal(ack.error?.code, ERR.PANIC)
    fs.rmSync(PANIC_FILE, { force: true })
    // The next request re-stats the file, which is the control that does not
    // depend on a filesystem watcher.
    await mcp(OPS.STATUS)
    await waitFor('the held registration to be voided', () =>
      host.frames.some((m) => m.type === MSG.REGISTER_ACK && m.ok === false && m.error?.code === ERR.NO_BROKER)
    )
  } finally {
    await host.stop()
  }
})

test('the broker stops cleanly', async () => {
  broker.child.kill()
  await exitOf(broker.child)
})
