/**
 * A host whose route a newer registration took, against a host whose broker
 * restarted: the first must end, the second must ride it out.
 *
 * The real broker and the real native messaging host, each on a throwaway
 * endpoint (BRIDGE_SOCKET_NAME) with state in a temp directory (BRIDGE_HOME), the
 * test standing in for the browser on each host's stdio, exactly as
 * handshake-e2e.test.mjs does.
 *
 * The loop this pins down: the broker replaced a route and destroyed the old
 * host's socket with nothing said. The old host could not tell that from a
 * broker restart, so it voided its browser port's registration (a register_ack
 * ok:false up a port the extension had already moved on from) and redialed.
 * The redial sent HELLO and never REGISTER, the broker refused it at its
 * 10-second deadline, the refusal went up the same old port, and the extension
 * tore down its live link in answer. Every ten seconds, for hours.
 *
 * What has to hold:
 *
 * 1. The broker says REPLACED before it closes, and the host told so relays
 *    nothing to its browser and exits, without redialing.
 * 2. A broker RESTART is still an outage to ride out: the host voids the
 *    registration so the extension re-introduces itself, redials the new broker
 *    and carries the fresh REGISTER through.
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-replaced-'))
const HOME = path.join(TEMP_ROOT, 'state')
process.env.BRIDGE_HOME = HOME
delete process.env.BRIDGE_SOCKET_NAME

// Dynamic, and after the assignment above, so paths.mjs resolves the temp tree.
const { LOG_FILE, RUNTIME_FILE, readJson } = await import('../shared/paths.mjs')
const { FrameDecoder, encodeFrame } = await import('../shared/framing.mjs')
const { ERR, HOST_NOTICE, MSG, register } = await import('../shared/protocol.mjs')

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

const NAME = `abb-rpl-${crypto.randomBytes(5).toString('hex')}`

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

async function startBroker() {
  const broker = launch(BROKER, [], ['ignore', 'ignore', 'pipe'])
  await waitFor('the broker to publish runtime.json', () => {
    if (broker.child.exitCode !== null) throw new Error(`the broker exited ${broker.child.exitCode}: ${broker.stderr()}`)
    return readJson(RUNTIME_FILE, null)?.pid === broker.child.pid
  })
  return broker
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
      if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill()
      await exitOf(host.child)
    },
  }
}

function registration(installId) {
  return register({ installId, vendorHint: 'chrome', email: null, label: null, extVersion: '0.0.0', tabCount: 0 })
}

function acks(host) {
  return host.frames.filter((m) => m.type === MSG.REGISTER_ACK)
}

function logMessages() {
  try {
    return fs
      .readFileSync(LOG_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line).message
        } catch {
          return null
        }
      })
  } catch {
    return []
  }
}

let broker = null

test('the broker starts on a throwaway endpoint', async () => {
  broker = await startBroker()
})

test('a host whose route a newer registration took is told so, relays nothing, and exits', async () => {
  const installId = `rpl-${crypto.randomBytes(4).toString('hex')}`
  const first = startHost()
  const second = startHost()
  try {
    first.send(registration(installId))
    await waitFor('the first registration', () => acks(first).find((m) => m.ok === true))
    const before = first.frames.length

    // The same profile registering again on a new port: what the extension
    // does after it has let go of the first one.
    second.send(registration(installId))
    await waitFor('the second registration', () => acks(second).find((m) => m.ok === true))
    await waitFor('the broker to replace the first route', () => logMessages().includes('Replacing an existing route'))

    const code = await Promise.race([exitOf(first.child), sleep(5_000).then(() => 'still running')])
    assert.equal(code, 0, 'the replaced host kept running instead of exiting')

    const after = first.frames.slice(before)
    assert.deepEqual(
      after.filter((m) => m.type === MSG.REGISTER_ACK),
      [],
      'the replaced host voided a registration up a port the extension had moved on from'
    )
    assert.deepEqual(
      after.filter((m) => m.type === MSG.EVENT && m.name === HOST_NOTICE.REPLACED),
      [],
      'the notice is the host\'s, never relayed to the browser'
    )

    // The newer route is untouched by all of it.
    assert.equal(second.child.exitCode, null, 'the current host went down with the old one')
    assert.deepEqual(acks(second).filter((m) => m.ok === false), [], 'the current port was refused')
  } finally {
    await first.stop()
    await second.stop()
  }
})

test('a host whose broker restarts voids the registration, redials, and carries the next REGISTER', async () => {
  const installId = `rst-${crypto.randomBytes(4).toString('hex')}`
  const host = startHost()
  try {
    host.send(registration(installId))
    await waitFor('the registration', () => acks(host).find((m) => m.ok === true))

    broker.child.kill()
    await exitOf(broker.child)

    // The outage path is unchanged: the extension hears a typed refusal and
    // re-introduces itself, and the host does not exit.
    const voided = await waitFor('the registration to be voided', () =>
      acks(host).find((m) => m.ok === false && m.error?.code === ERR.NO_BROKER)
    )
    assert.match(voided.error.message, /registration is void/)
    assert.equal(host.child.exitCode, null, 'the host exited on a broker restart')

    broker = await startBroker()
    // The extension's answer to the refusal: a fresh REGISTER on the same port,
    // sent again on its backoff for as long as the host is still between dials
    // and refuses it on the spot.
    const okBefore = acks(host).filter((m) => m.ok === true).length
    let refusals = acks(host).filter((m) => m.ok === false).length
    host.send(registration(installId))
    await waitFor(
      'the new broker to answer a fresh REGISTER',
      () => {
        const now = acks(host)
        if (now.filter((m) => m.ok === true).length > okBefore) return true
        const refused = now.filter((m) => m.ok === false).length
        if (refused > refusals) {
          refusals = refused
          setTimeout(() => host.send(registration(installId)), 250)
        }
        return false
      },
      20_000
    )
    assert.equal(host.child.exitCode, null)
  } finally {
    await host.stop()
  }
})

test('the broker stops cleanly', async () => {
  broker.child.kill()
  await exitOf(broker.child)
})
