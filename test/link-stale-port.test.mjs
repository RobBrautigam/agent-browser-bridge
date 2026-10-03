/**
 * The extension's link, driven for real against a fake chrome: one service
 * worker must hold at most one native port, and a port it has let go of must
 * never act on the one it holds now.
 *
 * The failure this pins down, as it was seen on a live install: one worker
 * ended up holding TWO ports. Its listeners were attached per port but acted on
 * whichever port was current, and a replaced port was never closed, so its host
 * outlived its own route. When the broker replaced that route, the old host
 * redialed, never registered (nothing told the extension a REGISTER was owed on
 * that port), and was refused at the broker's 10-second deadline. The refusal
 * came back up the OLD port and tore down the CURRENT link. A new pair
 * connected, and the loop ran every few seconds for hours.
 *
 * The fake storage answers one call per turn of the event loop, in order, the
 * way the browser's own storage does, so the windows between a call and its
 * answer are real and a test can land a wake source inside any of them.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const { ERR, MSG, LINK, TIMING, registerAck, helloAck } = await import('../shared/protocol.mjs')

let instance = 0

/** A fresh copy of the link module: its port and timers are module state. */
async function freshLink() {
  instance += 1
  return import(`../extension/lib/link.js?instance=${instance}`)
}

function turn() {
  return new Promise((resolve) => setImmediate(resolve))
}

class FakePort {
  constructor(chrome) {
    this.chrome = chrome
    this.posted = []
    this.disconnected = false
    this.messageListeners = []
    this.disconnectListeners = []
    this.onMessage = { addListener: (fn) => this.messageListeners.push(fn) }
    this.onDisconnect = { addListener: (fn) => this.disconnectListeners.push(fn) }
  }

  postMessage(msg) {
    if (this.disconnected) throw new Error('Attempting to use a disconnected port object')
    this.posted.push(msg)
  }

  /** The browser dispatches nothing to a port after disconnect(). */
  disconnect() {
    this.disconnected = true
  }

  /**
   * A frame from the host. `queued` is a frame that was already on its way when
   * the port was let go of: the case a per-port guard exists for.
   */
  deliver(msg, { queued = false } = {}) {
    if (this.disconnected && !queued) return
    for (const fn of this.messageListeners) fn(msg, this)
  }

  /** The host went away. Fired at most once, and never after our own disconnect(). */
  drop(message = 'Native host has exited.', { queued = false } = {}) {
    if (this.disconnected && !queued) return
    this.disconnected = true
    this.chrome.runtime.lastError = { message }
    try {
      for (const fn of this.disconnectListeners) fn(this)
    } finally {
      this.chrome.runtime.lastError = undefined
    }
  }
}

/**
 * A fake chrome whose storage answers one call per event-loop turn, in the
 * order the calls were made.
 */
function fakeChrome({ tabsTurns = 0 } = {}) {
  const session = new Map()
  const local = new Map()
  const queue = []
  const ports = []

  function op(fn) {
    return new Promise((resolve, reject) => {
      queue.push(() => {
        try {
          resolve(fn())
        } catch (err) {
          reject(err)
        }
      })
    })
  }

  function area(map) {
    return {
      get(keys) {
        return op(() => {
          const list = keys == null ? [...map.keys()] : Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys)
          const out = {}
          for (const k of list) if (map.has(k)) out[k] = structuredClone(map.get(k))
          return out
        })
      },
      set(patch) {
        return op(() => {
          for (const [k, v] of Object.entries(patch)) map.set(k, structuredClone(v))
        })
      },
    }
  }

  const chrome = {
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      lastError: undefined,
      getManifest: () => ({ version: '9.9.9' }),
      connectNative: () => {
        const port = new FakePort(chrome)
        ports.push(port)
        return port
      },
    },
    storage: { session: area(session), local: area(local) },
    tabs: {
      // A browser call that takes longer than a storage call, when a test asks.
      async query() {
        for (let i = 0; i < tabsTurns; i++) await op(() => undefined)
        return []
      },
    },
  }

  return {
    chrome,
    ports,
    session,
    /** Answer exactly one storage call, then let its continuation run. */
    async step() {
      const next = queue.shift()
      if (next) next()
      await turn()
      return Boolean(next)
    },
    /** Answer every storage call until nothing is waiting. */
    async settle() {
      for (let i = 0; i < 500; i++) {
        if (queue.length === 0) {
          await turn()
          if (queue.length === 0) return
        }
        await this.step()
      }
      throw new Error('the fake storage never went quiet')
    },
  }
}

function ackOk(generation = 1) {
  return registerAck({ ok: true, label: 'test-profile', generation, claimed: true, version: '9.9.9' })
}

/** One fresh link module and fake chrome, the timers mocked so no backoff fires on its own. */
async function setup(t, options) {
  const fake = fakeChrome(options)
  globalThis.chrome = fake.chrome
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(console, 'info', () => {})
  t.mock.method(console, 'warn', () => {})
  const link = await freshLink()
  return { fake, link }
}

/** Connect, answer the REGISTER, and wait until the link says READY. */
async function connectReady(fake, link) {
  const done = link.ensureConnected('test')
  await fake.settle()
  await done
  const port = fake.ports.at(-1)
  assert.ok(port, 'a port was opened')
  assert.equal(port.posted[0]?.type, MSG.REGISTER, 'the port carried a REGISTER')
  port.deliver(ackOk())
  await fake.settle()
  const snap = await snapshot(fake, link)
  assert.equal(snap.linkState, LINK.READY)
  return port
}

async function snapshot(fake, link) {
  const pending = link.getLinkSnapshot()
  await fake.settle()
  return pending
}

/**
 * Leave the worker with a superseded port and a newer, ready one, the shape the
 * live loop ran in. The persisted state drifting to DOWN under a live port is
 * the half-open case ensureConnected reconnects from.
 */
async function supersede(fake, link) {
  const old = await connectReady(fake, link)
  fake.session.set('link.state', LINK.DOWN)
  const again = link.ensureConnected('alarm')
  await fake.settle()
  await again
  assert.equal(fake.ports.length, 2, 'the half-open port was replaced')
  const current = fake.ports[1]
  current.deliver(ackOk(2))
  await fake.settle()
  assert.equal((await snapshot(fake, link)).linkState, LINK.READY)
  return { old, current }
}

/* -------------------------------------------------------------------------- */
/* One port per worker                                                         */
/* -------------------------------------------------------------------------- */

test('a wake source at any moment of the answer to REGISTER never opens a second port', async (t) => {
  // The answer is recorded across several storage calls. Before the fix the
  // ack timer was cleared at the first of them and READY written at the last,
  // so a wake in between saw a port, no timer and no READY, and dialed again
  // without closing the port it already had. That is how one worker opened
  // two ports 1.2 seconds apart at browser start.
  for (let k = 0; k <= 12; k++) {
    await t.test(`a wake after ${k} storage answers`, async (t) => {
      const { fake, link } = await setup(t)
      const done = link.ensureConnected('worker-start')
      await fake.settle()
      await done
      assert.equal(fake.ports.length, 1)

      fake.ports[0].deliver(ackOk())
      for (let i = 0; i < k; i++) await fake.step()
      const wake = link.ensureConnected('onStartup')
      await fake.settle()
      await wake

      assert.equal(fake.ports.length, 1, `a second port was opened after ${k} answers`)
      assert.equal(fake.ports[0].disconnected, false, 'the healthy port was dropped')
      assert.equal((await snapshot(fake, link)).linkState, LINK.READY)
    })
  }
})

test('a half-open port is closed before the next one is opened', async (t) => {
  const { fake, link } = await setup(t)
  const { old, current } = await supersede(fake, link)
  assert.equal(old.disconnected, true, 'the replaced port was left open, and its host with it')
  assert.equal(current.disconnected, false)
})

/* -------------------------------------------------------------------------- */
/* A superseded port never acts on the current one                             */
/* -------------------------------------------------------------------------- */

// connect() now closes the port it replaces, and the browser dispatches nothing
// to a closed port, so the frames below are ones already on their way when it
// closed (`queued`). On 1.1.0 the replaced port was never closed and they were
// simply live. Either way the guard is the second layer behind that close.

test("a superseded port's REGISTER_ACK refusal does not tear down the current link", async (t) => {
  const { fake, link } = await setup(t)
  const { old, current } = await supersede(fake, link)

  old.deliver(
    registerAck({ ok: false, error: { code: ERR.BAD_REQUEST, message: 'No REGISTER arrived within 10000 ms of HELLO.' } }),
    { queued: true }
  )
  await fake.settle()

  assert.equal(current.disconnected, false, 'the refusal on the old port tore down the current one')
  const snap = await snapshot(fake, link)
  assert.equal(snap.hasPort, true)
  assert.equal(snap.linkState, LINK.READY)
  assert.equal(fake.ports.length, 2, 'nothing redialed')
  assert.equal(old.disconnected, true, 'the old port is closed')
})

test("a superseded port's HELLO_ACK refusal does not tear down the current link", async (t) => {
  const { fake, link } = await setup(t)
  const { old, current } = await supersede(fake, link)

  old.deliver(helloAck({ ok: false, error: { code: ERR.NO_BROKER, message: 'The broker is not running.' } }), {
    queued: true,
  })
  await fake.settle()

  assert.equal(current.disconnected, false, 'the refusal on the old port tore down the current one')
  const snap = await snapshot(fake, link)
  assert.equal(snap.hasPort, true)
  assert.equal(snap.linkState, LINK.READY)
  assert.equal(fake.ports.length, 2, 'nothing redialed')
})

test("a superseded port's disconnect does not drop the current port", async (t) => {
  const { fake, link } = await setup(t)
  const { old, current } = await supersede(fake, link)

  old.drop('Native host has exited.', { queued: true })
  await fake.settle()
  t.mock.timers.tick(TIMING.EXT_RECONNECT_CAP)
  await fake.settle()

  const snap = await snapshot(fake, link)
  assert.equal(snap.hasPort, true, 'the old port going away forgot the current one')
  assert.equal(snap.linkState, LINK.READY)
  assert.equal(current.disconnected, false)
  assert.equal(fake.ports.length, 2, 'nothing redialed')
})

test('a message on a superseded port is not answered on the current one', async (t) => {
  const { fake, link } = await setup(t)
  const { old, current } = await supersede(fake, link)

  old.deliver({ type: MSG.PING, seq: 7 }, { queued: true })
  await fake.settle()
  assert.equal(
    current.posted.some((m) => m.type === MSG.PONG && m.seq === 7),
    false,
    "the old port's ping was answered on the current port"
  )
})

/* -------------------------------------------------------------------------- */
/* The current port still behaves as before                                    */
/* -------------------------------------------------------------------------- */

test("the current port's refusal still tears it down and schedules a reconnect", async (t) => {
  const { fake, link } = await setup(t)
  const port = await connectReady(fake, link)

  port.deliver(registerAck({ ok: false, error: { code: ERR.NO_BROKER, message: 'The broker link dropped.' } }))
  await fake.settle()
  assert.equal(port.disconnected, true)
  assert.equal((await snapshot(fake, link)).hasPort, false)

  t.mock.timers.tick(TIMING.EXT_RECONNECT_CAP)
  await fake.settle()
  assert.equal(fake.ports.length, 2, 'the backoff redialed')
})

test("the current port's disconnect still drops it and schedules a reconnect", async (t) => {
  const { fake, link } = await setup(t)
  const port = await connectReady(fake, link)

  port.drop('Native host has exited.')
  await fake.settle()
  const snap = await snapshot(fake, link)
  assert.equal(snap.hasPort, false)
  assert.equal(snap.linkState, LINK.DOWN)

  t.mock.timers.tick(TIMING.EXT_RECONNECT_CAP)
  await fake.settle()
  assert.equal(fake.ports.length, 2, 'the backoff redialed')
})

test('a REGISTER_ACK that never comes still tears the port down at the deadline', async (t) => {
  const { fake, link } = await setup(t)
  const done = link.ensureConnected('test')
  await fake.settle()
  await done
  const port = fake.ports[0]

  t.mock.timers.tick(TIMING.HELLO_ACK_TIMEOUT)
  await fake.settle()
  assert.equal(port.disconnected, true)
  assert.equal((await snapshot(fake, link)).hasPort, false)
})

/* -------------------------------------------------------------------------- */
/* A forced reconnect, and every write that follows an await                   */
/* -------------------------------------------------------------------------- */

function openPorts(fake) {
  return fake.ports.filter((p) => !p.disconnected)
}

test('a forced reconnect never strands a connect or throws away a port being introduced', async (t) => {
  // The popup and options page force a reconnect on a failed poll, and one can
  // land at any moment of a connect. Tearing the port down while connect() was
  // collecting the identity left connect() to give up on it with nothing
  // scheduled to try again; tearing it down while its answer was pending only
  // dialed the same introduction again. The slow tab count stretches the
  // identity collection past the forced reconnect's own reads, as a busy
  // browser does.
  for (const tabsTurns of [0, 8]) {
    for (let k = 0; k <= 12; k++) {
      await t.test(`forced after ${k} storage answers, tab count in ${tabsTurns} turns`, async (t) => {
        const { fake, link } = await setup(t, { tabsTurns })
        const done = link.ensureConnected('worker-start')
        for (let i = 0; i < k; i++) await fake.step()
        const forced = link.forceReconnect('ui getBoard hit E_TIMEOUT')
        await fake.settle()
        await done
        await forced

        // No timer is advanced: a link that needs one to come back was stranded.
        assert.equal(openPorts(fake).length, 1, `no port is open and nothing is on its way (forced after ${k})`)
        assert.equal(fake.ports.length, 1, `a port still being introduced was thrown away (forced after ${k})`)
        fake.ports[0].deliver(ackOk())
        await fake.settle()
        assert.equal((await snapshot(fake, link)).linkState, LINK.READY)
      })
    }
  }
})

test('a page polling through an outage does not redial ahead of the backoff', async (t) => {
  const { fake, link } = await setup(t)
  const port = await connectReady(fake, link)
  port.drop('Native host has exited.')
  await fake.settle()
  assert.equal(fake.ports.length, 1)

  // askBroker's forced reconnect, once per failed two-second poll.
  for (let i = 0; i < 3; i++) {
    const forced = link.forceReconnect('ui getBoard hit E_NO_BROKER', { unlessPending: true })
    await fake.settle()
    await forced
  }
  assert.equal(fake.ports.length, 1, 'a failed poll redialed ahead of the backoff')

  t.mock.timers.tick(TIMING.EXT_RECONNECT_CAP)
  await fake.settle()
  assert.equal(fake.ports.length, 2, 'the backoff still redials')
})

test("the worker's failed-poll reconnect leaves a counted retry to run", async () => {
  const src = await readFile(new URL('../extension/sw.js', import.meta.url), 'utf8')
  const start = src.indexOf('async function askBroker')
  assert.ok(start > 0, 'askBroker is in sw.js')
  const body = src.slice(start, src.indexOf('\n}\n', start))
  assert.match(body, /forceReconnect\(.*\{\s*unlessPending:\s*true\s*\}\)/)
})

test('READY is never written for a port that went away while its answer was recorded', async (t) => {
  for (let k = 0; k <= 10; k++) {
    await t.test(`dropped after ${k} storage answers`, async (t) => {
      const { fake, link } = await setup(t)
      const done = link.ensureConnected('test')
      await fake.settle()
      await done
      const port = fake.ports[0]

      port.deliver(ackOk())
      for (let i = 0; i < k; i++) await fake.step()
      port.drop('Native host has exited.')
      await fake.settle()

      assert.notEqual(fake.session.get('link.state'), LINK.READY, `READY outlived its port (dropped after ${k})`)
    })
  }
})

test('the panic hold never outlives the port it was for', async (t) => {
  for (let k = 0; k <= 6; k++) {
    await t.test(`dropped after ${k} storage answers`, async (t) => {
      const { fake, link } = await setup(t)
      const done = link.ensureConnected('test')
      await fake.settle()
      await done
      const port = fake.ports[0]

      port.deliver(registerAck({ ok: false, error: { code: ERR.PANIC, message: 'Panic is on.' } }))
      for (let i = 0; i < k; i++) await fake.step()
      port.drop('Native host has exited.')
      await fake.settle()

      assert.notEqual(fake.session.get('link.panicHeld'), true, `the hold outlived its port (dropped after ${k})`)
    })
  }
})
