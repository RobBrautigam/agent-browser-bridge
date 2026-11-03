/**
 * The extension's half of the token relay: watching the app's own requests
 * for its bearer token, and keeping one background tab alive so there is
 * always a request to watch.
 *
 * Driven against a fake browser and a fake broker that records what was SENT,
 * so the assertions are about what left the extension and which tabs it
 * touched, not about what a call returned.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { TOKEN_RELAY } from '../shared/protocol.mjs'
import { RELAY_STATE_KEY, createTokenRelay, headerToken, urlMatches } from '../extension/lib/token-relay.js'

const T0 = Date.UTC(2026, 10, 2, 12, 0, 0)
const HOUR = 3_600_000

function b64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}
function jwt(expMs, extra = {}) {
  const iat = Math.floor(T0 / 1000)
  return `${b64url({ alg: 'HS256' })}.${b64url({ user: 42, iat, exp: Math.floor(expMs / 1000), ...extra })}.c2ln`
}

const SPEC = {
  name: 'tracker',
  urls: ['https://*.tracker.example/*'],
  initiators: ['https://app.tracker.example'],
  header: 'authorization',
  scheme: 'Bearer',
  keepAlive: { url: 'https://app.tracker.example/list/1', renewBeforeHours: 24 },
}

function request(token, overrides = {}) {
  return {
    url: 'https://api-prod.tracker.example/v1/things',
    initiator: 'https://app.tracker.example',
    tabId: 5,
    type: 'xmlhttprequest',
    requestHeaders: [
      { name: 'Accept', value: 'application/json' },
      { name: 'Authorization', value: `Bearer ${token}` },
    ],
    ...overrides,
  }
}

function fakeBrowser({ tabs = [], windows = [{ id: 1, type: 'normal', focused: true, state: 'normal' }] } = {}) {
  const state = { listeners: [], removed: 0, created: [], reloaded: [], updated: [], local: {}, windowsCreated: 0 }
  const chrome = {
    webRequest: {
      onSendHeaders: {
        addListener(fn, filter, extra) {
          state.listeners.push({ fn, filter, extra })
        },
        removeListener(fn) {
          state.listeners = state.listeners.filter((l) => l.fn !== fn)
          state.removed += 1
        },
      },
    },
    storage: {
      local: {
        async get(key) {
          return key in state.local ? { [key]: structuredClone(state.local[key]) } : {}
        },
        async set(patch) {
          Object.assign(state.local, structuredClone(patch))
        },
      },
    },
    tabs: {
      async get(id) {
        const tab = tabs.find((t) => t.id === id)
        if (!tab) throw new Error(`No tab with id: ${id}`)
        return tab
      },
      async query(filter = {}) {
        return tabs.filter((t) => filter.pinned === undefined || t.pinned === filter.pinned)
      },
      async reload(id) {
        state.reloaded.push(id)
      },
      async create(props) {
        const tab = { id: 100 + state.created.length, ...props }
        state.created.push(props)
        tabs.push(tab)
        return tab
      },
      async update(id, props) {
        state.updated.push({ id, ...props })
      },
    },
    windows: {
      async getLastFocused() {
        return windows.find((w) => w.focused) || windows[0] || null
      },
      async getAll() {
        return windows
      },
      async create() {
        state.windowsCreated += 1
      },
    },
  }
  return { chrome, state }
}

function relayWith(fixture = {}, { answer = (args) => ({ written: true, exp: Math.floor(args.expMs / 1000) }) } = {}) {
  const { chrome, state } = fakeBrowser(fixture)
  const sent = []
  let clock = T0
  const relay = createTokenRelay({
    chrome,
    now: () => clock,
    send: async (args) => {
      sent.push(args)
      const exp = JSON.parse(Buffer.from(args.token.split('.')[1], 'base64url').toString()).exp
      return answer({ ...args, expMs: exp * 1000 })
    },
  })
  return { relay, chrome, state, sent, advance: (ms) => (clock += ms), at: () => clock }
}

test('the header is read by name in any case, and only after its scheme', () => {
  const headers = [{ name: 'AUTHORIZATION', value: 'bearer abc.def.ghi' }]
  assert.equal(headerToken(headers, { header: 'authorization', scheme: 'Bearer' }), 'abc.def.ghi')
  assert.equal(headerToken([{ name: 'Authorization', value: 'Basic xyz' }], { header: 'authorization', scheme: 'Bearer' }), null)
  assert.equal(headerToken([{ name: 'Cookie', value: 'Bearer abc' }], { header: 'authorization', scheme: 'Bearer' }), null)
  assert.equal(headerToken(null, {}), null)
})

test('a watch pattern matches its host and subdomains, never a lookalike', () => {
  assert.equal(urlMatches('https://api.tracker.example/v1', 'https://*.tracker.example/*'), true)
  assert.equal(urlMatches('https://tracker.example/v1', 'https://*.tracker.example/*'), true)
  assert.equal(urlMatches('https://tracker.example.evil.example/v1', 'https://*.tracker.example/*'), false)
  assert.equal(urlMatches('http://api.tracker.example/v1', 'https://*.tracker.example/*'), false)
  assert.equal(urlMatches('https://api.tracker.example/v1', 'https://api.tracker.example/v2*'), false)
})

test('applying the relays watches exactly their urls, and an empty list stops watching', () => {
  const { relay, state } = relayWith()
  relay.apply([SPEC])
  assert.equal(state.listeners.length, 1)
  assert.deepEqual(state.listeners[0].filter, { urls: ['https://*.tracker.example/*'], types: ['xmlhttprequest'] })
  assert.deepEqual(state.listeners[0].extra, ['requestHeaders'])
  relay.apply([])
  assert.equal(state.listeners.length, 0)
  relay.apply('not a list')
  assert.equal(state.listeners.length, 0)
})

test('a fresh token from the app is sent once, and the same or an older one is not sent again', async () => {
  const { relay, sent, state } = relayWith()
  relay.apply([SPEC])
  const fresh = jwt(T0 + 48 * HOUR)
  assert.equal(await relay.consider(request(fresh)), 'relayed')
  assert.equal(await relay.consider(request(fresh)), 'already relayed')
  assert.equal(await relay.consider(request(jwt(T0 + 40 * HOUR))), 'already relayed')
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0], { name: 'tracker', token: fresh })
  // What the extension keeps is the expiry, never the token.
  assert.ok(!JSON.stringify(state.local).includes(fresh.split('.')[1]), 'the token was stored')
  assert.equal(state.local[RELAY_STATE_KEY].tracker.exp, Math.floor((T0 + 48 * HOUR) / 1000))
  assert.equal(await relay.consider(request(jwt(T0 + 49 * HOUR))), 'relayed')
  assert.equal(sent.length, 2)
})

test('a request from another page, to another host, or carrying no usable token sends nothing', async () => {
  const { relay, sent } = relayWith()
  relay.apply([SPEC])
  const fresh = jwt(T0 + 48 * HOUR)
  assert.equal(await relay.consider(request(fresh, { initiator: 'https://evil.example' })), 'not watched')
  assert.equal(await relay.consider(request(fresh, { initiator: undefined })), 'not watched')
  assert.equal(await relay.consider(request(fresh, { url: 'https://api.elsewhere.example/v1' })), 'not watched')
  assert.equal(await relay.consider(request('abcdefghijklmnopqrstuvwxyz0123456789abcdefghij')), 'not a usable token')
  assert.equal(await relay.consider(request(jwt(T0 - HOUR))), 'not a usable token')
  assert.equal(await relay.consider(request(fresh, { requestHeaders: [] })), 'no token')
  assert.equal(sent.length, 0)
})

test('a broker refusal is not retried on every request, only after a pause', async () => {
  const { relay, sent, advance } = relayWith({}, {
    answer: () => {
      throw new Error('E_BAD_REQUEST: Not relayed: its "user" claim is not the one this relay expects.')
    },
  })
  relay.apply([SPEC])
  const fresh = jwt(T0 + 48 * HOUR)
  assert.equal(await relay.consider(request(fresh)), 'refused')
  assert.equal(await relay.consider(request(fresh)), 'recently refused')
  advance(2 * 60_000)
  assert.equal(await relay.consider(request(fresh)), 'refused')
  assert.equal(sent.length, 2)
})

test('keep-alive: with no fresh token it opens one pinned background tab, never a window', async () => {
  const { relay, state, advance } = relayWith()
  relay.apply([SPEC])
  assert.equal(await relay.tick(), 'settling', 'it acted before the open tabs had a chance')
  advance(TOKEN_RELAY.SETTLE_MS)
  assert.deepEqual(await relay.tick(), ['opened'])
  assert.deepEqual(state.created, [{ url: SPEC.keepAlive.url, active: false, pinned: true, windowId: 1 }])
  assert.deepEqual(state.updated, [{ id: 100, autoDiscardable: false }])
  assert.equal(state.windowsCreated, 0)
  // Inside the reload gap nothing more happens, however often it is asked.
  advance(TOKEN_RELAY.CHECK_EVERY_MS)
  assert.deepEqual(await relay.tick(), ['waiting'])
  // After the gap, the same tab is reloaded rather than a second one opened.
  advance(TOKEN_RELAY.RELOAD_GAP_MS)
  assert.deepEqual(await relay.tick(), ['reloaded'])
  assert.deepEqual(state.reloaded, [100])
  assert.equal(state.created.length, 1)
})

test('keep-alive: a token with more than the renewal margin left means nothing is touched', async () => {
  const { relay, state, advance, at } = relayWith()
  relay.apply([SPEC])
  await relay.consider(request(jwt(at() + 48 * HOUR)))
  advance(TOKEN_RELAY.SETTLE_MS)
  assert.deepEqual(await relay.tick(), ['fresh'])
  assert.equal(state.created.length + state.reloaded.length, 0)
  // Once it is inside the margin, the tab is opened.
  advance(25 * HOUR)
  assert.deepEqual(await relay.tick(), ['opened'])
})

test('keep-alive: after a browser restart it adopts its pinned tab instead of opening another', async () => {
  const tabs = [{ id: 9, pinned: true, url: `${SPEC.keepAlive.url}?view=x` }]
  const { relay, state, advance } = relayWith({ tabs })
  relay.apply([SPEC])
  advance(TOKEN_RELAY.SETTLE_MS)
  assert.deepEqual(await relay.tick(), ['reloaded'])
  assert.deepEqual(state.reloaded, [9])
  assert.equal(state.created.length, 0)
})

test('keep-alive: with no browser window open it does nothing at all', async () => {
  const { relay, state, advance } = relayWith({ windows: [] })
  relay.apply([SPEC])
  advance(TOKEN_RELAY.SETTLE_MS)
  assert.deepEqual(await relay.tick(), ['no window'])
  assert.equal(state.created.length, 0)
  assert.equal(state.windowsCreated, 0)
})
