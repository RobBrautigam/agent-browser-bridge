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
import { RELAY_STATE_KEY, RELAY_TABS_KEY, createTokenRelay, headerToken, urlMatches } from '../extension/lib/token-relay.js'

const T0 = Date.UTC(2026, 10, 2, 12, 0, 0)
const HOUR = 3_600_000

function b64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}
/** A token issued at `iatMs` (T0 unless given) that expires at `expMs`. */
function jwt(expMs, { iatMs = T0, ...extra } = {}) {
  return `${b64url({ alg: 'HS256' })}.${b64url({ user: 42, iat: Math.floor(iatMs / 1000), exp: Math.floor(expMs / 1000), ...extra })}.c2ln`
}

const SPEC = {
  name: 'tracker',
  urls: ['https://*.tracker.example/*'],
  initiators: ['https://app.tracker.example'],
  header: 'authorization',
  scheme: 'Bearer',
  maxLifetimeHours: 49,
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

function area(store) {
  return {
    async get(key) {
      return key in store ? { [key]: structuredClone(store[key]) } : {}
    },
    async set(patch) {
      Object.assign(store, structuredClone(patch))
    },
  }
}

function fakeBrowser({ tabs = [], windows = [{ id: 1, type: 'normal', focused: true, state: 'normal' }] } = {}) {
  const state = { listeners: [], removed: 0, created: [], reloaded: [], updated: [], local: {}, session: {}, windowsCreated: 0 }
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
    storage: { local: area(state.local), session: area(state.session) },
    tabs: {
      async get(id) {
        const tab = tabs.find((t) => t.id === id)
        if (!tab) throw new Error(`No tab with id: ${id}`)
        return tab
      },
      async query(filter = {}) {
        return tabs.filter((t) => filter.pinned === undefined || Boolean(t.pinned) === filter.pinned)
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
  return { chrome, state, tabs }
}

const claimsOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())

function relayWith(fixture = {}, { answer = (args) => ({ written: true, exp: claimsOf(args.token).exp, iat: claimsOf(args.token).iat }) } = {}) {
  const { chrome, state, tabs } = fakeBrowser(fixture)
  const sent = []
  let clock = T0
  const relay = createTokenRelay({
    chrome,
    now: () => clock,
    send: async (args) => {
      sent.push(args)
      return answer(args)
    },
  })
  return { relay, chrome, state, tabs, sent, advance: (ms) => (clock += ms), at: () => clock }
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

test("the worker's own late read of an old list never undoes the broker's newer one", () => {
  const { relay, state } = relayWith()
  relay.apply([], { initial: false })
  const late = relay.apply([SPEC], { initial: true })
  assert.equal(late.skipped, true)
  assert.equal(state.listeners.length, 0)
  // Before the broker has answered, the worker's read is what applies.
  const fresh = relayWith()
  fresh.relay.apply([SPEC], { initial: true })
  assert.equal(fresh.state.listeners.length, 1)
})

test('a newer token from the app is sent once; the same or an earlier-issued one is not sent again', async () => {
  const { relay, sent, state } = relayWith()
  relay.apply([SPEC])
  const first = jwt(T0 + 48 * HOUR)
  assert.equal(await relay.consider(request(first)), 'relayed')
  assert.equal(await relay.consider(request(first)), 'already relayed')
  // A token issued earlier, whatever its expiry, is older.
  assert.equal(await relay.consider(request(jwt(T0 + 40 * HOUR, { iatMs: T0 - HOUR }))), 'already relayed')
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0], { name: 'tracker', token: first })
  // What the extension keeps is when it was issued and when it expires, never the token.
  assert.ok(!JSON.stringify(state.local).includes(first.split('.')[1]), 'the token was stored')
  assert.equal(state.local[RELAY_STATE_KEY].tracker.iat, Math.floor(T0 / 1000))
  assert.equal(await relay.consider(request(jwt(T0 + 49 * HOUR, { iatMs: T0 + HOUR }))), 'not a usable token', 'issued in the future')
  assert.equal(await relay.consider(request(jwt(T0 + 49 * HOUR, { iatMs: T0 + 60_000 }))), 'relayed')
  assert.equal(sent.length, 2)
})

test('a forged token with a far expiry cannot shut out the next real one', async () => {
  const { relay, sent, advance, at } = relayWith()
  relay.apply([SPEC])
  // Within the relay's 49-hour lifetime cap, but expiring later than any real token.
  const forged = jwt(T0 + 49 * HOUR)
  assert.equal(await relay.consider(request(forged)), 'relayed')
  // Longer than the cap: refused before it is sent.
  assert.equal(await relay.consider(request(jwt(T0 + 13 * 24 * HOUR, { iatMs: T0 + 1000 }))), 'not a usable token')
  advance(10 * 60_000)
  const real = jwt(at() + 48 * HOUR, { iatMs: at() })
  assert.equal(await relay.consider(request(real)), 'relayed', 'a later-issued real token was shut out')
  assert.equal(sent.at(-1).token, real)
})

test('a request from another page, to another host, or carrying no usable token sends nothing', async () => {
  const { relay, sent } = relayWith()
  relay.apply([SPEC])
  const fresh = jwt(T0 + 48 * HOUR)
  assert.equal(await relay.consider(request(fresh, { initiator: 'https://evil.example' })), 'not watched')
  assert.equal(await relay.consider(request(fresh, { initiator: undefined })), 'not watched')
  assert.equal(await relay.consider(request(fresh, { url: 'https://api.elsewhere.example/v1' })), 'not watched')
  assert.equal(await relay.consider(request('abcdefghijklmnopqrstuvwxyz0123456789abcdefghij')), 'not a usable token')
  assert.equal(await relay.consider(request(jwt(T0 - HOUR, { iatMs: T0 - 2 * HOUR }))), 'not a usable token')
  assert.equal(await relay.consider(request(fresh, { requestHeaders: [] })), 'no token')
  assert.equal(sent.length, 0)
})

test('after a refusal the whole relay pauses, so tokens taking turns cannot flood the broker', async () => {
  const { relay, sent, advance } = relayWith({}, {
    answer: () => {
      throw new Error('E_BAD_REQUEST: Not relayed: its "user" claim is not the one this relay expects.')
    },
  })
  relay.apply([SPEC])
  const x = jwt(T0 + 48 * HOUR, { user: 7 })
  const y = jwt(T0 + 48 * HOUR, { user: 8, iatMs: T0 + 1000 })
  assert.equal(await relay.consider(request(x)), 'refused')
  assert.equal(await relay.consider(request(y)), 'recently refused')
  assert.equal(await relay.consider(request(x)), 'recently refused')
  advance(TOKEN_RELAY.REFUSAL_PAUSE_MS)
  assert.equal(await relay.consider(request(y)), 'refused')
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
  // Its id is kept for this browser session only.
  assert.equal(state.session[RELAY_TABS_KEY].tracker, 100)
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

test('keep-alive: a short-lived token is renewed halfway through its life, not on every gap', async () => {
  const { relay, state, advance, at } = relayWith()
  relay.apply([SPEC])
  await relay.consider(request(jwt(at() + 4 * HOUR)))
  advance(TOKEN_RELAY.SETTLE_MS)
  assert.deepEqual(await relay.tick(), ['fresh'], 'a four-hour token was treated as inside a 24-hour margin')
  advance(2 * HOUR)
  assert.deepEqual(await relay.tick(), ['opened'])
  assert.equal(state.created.length, 1)
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

test("keep-alive: a tab id from an earlier browser session is never trusted", async () => {
  // A person's own unpinned tab on the app happens to have the id the last session's tab had.
  const tabs = [{ id: 412, pinned: false, active: false, url: 'https://app.tracker.example/doc/draft' }]
  const { relay, state, advance, chrome } = relayWith({ tabs })
  relay.apply([SPEC])
  await chrome.storage.local.set({ [RELAY_STATE_KEY]: { tracker: { tabId: 412 } } })
  advance(TOKEN_RELAY.SETTLE_MS)
  assert.deepEqual(await relay.tick(), ['opened'])
  assert.deepEqual(state.reloaded, [])
  assert.ok(!state.updated.some((u) => u.id === 412), 'the person tab was touched')
})

test('keep-alive: its tab drifted to another page of the app is sent back, never reloaded there', async () => {
  const tabs = [{ id: 9, pinned: true, active: false, url: 'https://app.tracker.example/inbox' }]
  const { relay, state, advance, chrome } = relayWith({ tabs })
  relay.apply([SPEC])
  await chrome.storage.session.set({ [RELAY_TABS_KEY]: { tracker: 9 } })
  advance(TOKEN_RELAY.SETTLE_MS)
  assert.deepEqual(await relay.tick(), ['returned'])
  assert.deepEqual(state.reloaded, [])
  assert.deepEqual(state.updated[0], { id: 9, url: SPEC.keepAlive.url })
  assert.equal(state.created.length, 0)
})

test('keep-alive: its tab redirected off the app (signed out) is left alone, and no second tab opens', async () => {
  const tabs = [{ id: 9, pinned: true, active: false, url: 'https://accounts.google.com/signin' }]
  const { relay, state, advance, chrome } = relayWith({ tabs })
  relay.apply([SPEC])
  await chrome.storage.session.set({ [RELAY_TABS_KEY]: { tracker: 9 } })
  advance(TOKEN_RELAY.SETTLE_MS)
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(await relay.tick(), ['away'])
    advance(TOKEN_RELAY.RELOAD_GAP_MS)
  }
  assert.equal(state.created.length, 0)
  assert.equal(state.reloaded.length + state.updated.length, 0)
})

test('keep-alive: a closed tab is reopened at most once a day', async () => {
  const { relay, state, tabs, advance } = relayWith()
  relay.apply([SPEC])
  advance(TOKEN_RELAY.SETTLE_MS)
  assert.deepEqual(await relay.tick(), ['opened'])
  tabs.length = 0 // the person closed it
  for (let i = 0; i < 6; i++) {
    advance(TOKEN_RELAY.RELOAD_GAP_MS)
    assert.deepEqual(await relay.tick(), ['closed'])
  }
  advance(TOKEN_RELAY.OPEN_GAP_MS)
  assert.deepEqual(await relay.tick(), ['opened'])
  assert.equal(state.created.length, 2)
})

test('keep-alive: a tab a person is looking at is left alone until the next check', async () => {
  const tabs = [{ id: 9, pinned: true, active: true, url: SPEC.keepAlive.url }]
  const { relay, state, advance } = relayWith({ tabs })
  relay.apply([SPEC])
  advance(TOKEN_RELAY.SETTLE_MS)
  assert.deepEqual(await relay.tick(), ['in use'])
  assert.equal(state.reloaded.length + state.created.length + state.updated.length, 0)
})

test('keep-alive: after a restart it finds its tab where the app redirected it', async () => {
  const landed = 'https://app.tracker.example/l/abc/view'
  const tabs = [{ id: 9, pinned: true, url: landed }]
  const { relay, state, advance, chrome } = relayWith({ tabs })
  relay.apply([SPEC])
  // What a previous browser session recorded: the tab id is gone, the landing is known.
  await chrome.storage.local.set({ [RELAY_STATE_KEY]: { tracker: { tabUrl: landed } } })
  advance(TOKEN_RELAY.SETTLE_MS)
  assert.deepEqual(await relay.tick(), ['reloaded'])
  assert.deepEqual(state.reloaded, [9])
  assert.equal(state.created.length, 0)
})

test('keep-alive: the address its new tab landed on is remembered once a token arrives', async () => {
  const { relay, state, tabs, advance, at } = relayWith()
  relay.apply([SPEC])
  advance(TOKEN_RELAY.SETTLE_MS)
  assert.deepEqual(await relay.tick(), ['opened'])
  tabs[0].url = 'https://app.tracker.example/l/abc/view'
  await relay.consider(request(jwt(at() + 48 * HOUR, { iatMs: at() })))
  advance(TOKEN_RELAY.CHECK_EVERY_MS)
  assert.deepEqual(await relay.tick(), ['fresh'])
  assert.equal(state.local[RELAY_STATE_KEY].tracker.tabUrl, 'https://app.tracker.example/l/abc/view')
})

test('keep-alive: with no browser window open it does nothing at all', async () => {
  const { relay, state, advance } = relayWith({ windows: [] })
  relay.apply([SPEC])
  advance(TOKEN_RELAY.SETTLE_MS)
  assert.deepEqual(await relay.tick(), ['no window'])
  assert.equal(state.created.length, 0)
  assert.equal(state.windowsCreated, 0)
})
