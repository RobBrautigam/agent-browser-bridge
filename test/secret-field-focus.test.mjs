/**
 * The password guard against a page whose focus moves.
 *
 * The first guard checked one element before anything was typed. A trusted key
 * event types into whatever has focus WHEN IT LANDS, and focus moves: a Tab in
 * the key list, an element that cannot take focus (so the password field keeps
 * it), a field that hands focus on. These tests drive fill and press keys
 * against a fake browser whose page moves focus the way a real one does, and
 * assert on what was TYPED where, not on what the call returned.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { ERR, secretFieldVerdict } from '../shared/protocol.mjs'

const PAGE = 'https://site.example/login'

/**
 * A login page: a username field, then a password field, in Tab order. `body`
 * and `div` cannot take focus. Every trusted character lands in the focused
 * field's `typed` buffer, which is what the assertions read.
 */
function fakeBrowser({ focused = 'user', tabUrl = PAGE, pageUrl = PAGE } = {}) {
  const fields = {
    user: { tag: 'INPUT', type: 'text', name: 'username', focusable: true, typed: '' },
    pw: { tag: 'INPUT', type: 'password', name: 'password', focusable: true, typed: '' },
    body: { tag: 'BODY', type: '', name: '', focusable: false, typed: '' },
    div: { tag: 'DIV', type: '', name: '', focusable: false, typed: '' },
  }
  const tabOrder = ['user', 'pw']
  const state = { fields, focused, probes: 0 }
  const select = (selector) => String(selector || '').replace(/^[#.]/, '')
  const describe = (key) => {
    const f = fields[key]
    return { tag: f.tag.toLowerCase(), type: f.type, autocomplete: '', name: f.name, id: key, label: '', opaque: false }
  }

  const chrome = {
    runtime: { lastError: null },
    tabs: {
      async get(id) {
        return { id, windowId: 1, url: tabUrl }
      },
      async query() {
        return [{ id: 1, windowId: 1, url: tabUrl, active: true }]
      },
    },
    storage: {
      session: {
        async get() {
          return {}
        },
        async set() {},
      },
    },
    scripting: {
      async executeScript({ func, args }) {
        const arg = args && args[0] ? args[0] : {}
        if (func.name === 'pageFieldKind') {
          state.probes += 1
          const key = arg.selector ? select(arg.selector) : state.focused
          return [{ result: { ok: true, url: pageUrl, field: fields[key] ? describe(key) : null } }]
        }
        if (func.name === 'pageFocusSelect') {
          const key = select(arg.selector)
          if (fields[key] && fields[key].focusable) state.focused = key
          return [{ result: { ok: true, focused: state.focused === key, tag: fields[key] ? fields[key].tag.toLowerCase() : null } }]
        }
        if (func.name === 'pagePressKeys' || func.name === 'pageFill') {
          return [{ result: { ok: true } }]
        }
        throw new Error(`the fake page has no ${func.name}`)
      },
    },
    debugger: {
      attach(_target, _version, cb) {
        cb()
      },
      detach(_target, cb) {
        cb()
      },
      sendCommand(_target, method, params, cb) {
        if (method === 'Input.dispatchKeyEvent' && (params.type === 'keyDown' || params.type === 'rawKeyDown')) {
          // A two-step sign-in: Enter on the username shows the password field
          // and focuses it, the way many sign-in pages do.
          if (params.key === 'Tab' || (params.key === 'Enter' && state.focused === 'user')) {
            const at = tabOrder.indexOf(state.focused)
            state.focused = tabOrder[(at + 1) % tabOrder.length]
          } else if (typeof params.text === 'string') {
            fields[state.focused].typed += params.text
          }
        }
        cb({})
      },
    },
  }
  return { chrome, state }
}

async function withBrowser(fixture, fn) {
  const { chrome, state } = fakeBrowser(fixture)
  const previous = globalThis.chrome
  globalThis.chrome = chrome
  try {
    const ops = await import(`../extension/lib/ops.js?focus=${Math.random()}`)
    return await fn(ops, state)
  } finally {
    globalThis.chrome = previous
  }
}

const GRANT = { file: '2026-01-01-note-1.md', services: ['site.example'] }

async function refused(promise) {
  try {
    await promise
  } catch (err) {
    return err
  }
  return null
}

test('a Tab inside a trusted key list cannot carry the rest of the keys into a password field', async () => {
  await withBrowser({ focused: 'user' }, async (ops, state) => {
    const err = await refused(ops.runOp('pressKeys', { tab: 1, keys: 'Tab h u n t e r 2', trusted: true }))
    assert.ok(err, 'the call went through')
    assert.equal(err.code, ERR.SECRET_FIELD)
    assert.equal(state.fields.pw.typed, '', `typed into the password field: ${state.fields.pw.typed}`)
  })
  // Shift and the other named keys move focus too; only a plain character is
  // trusted to leave it where it was.
  await withBrowser({ focused: 'user' }, async (ops, state) => {
    const err = await refused(ops.runOp('pressKeys', { tab: 1, keys: ['a', 'Tab', 'b'], trusted: true }))
    assert.equal(err && err.code, ERR.SECRET_FIELD)
    assert.equal(state.fields.user.typed, 'a', 'the keys before the Tab still landed where they were checked')
    assert.equal(state.fields.pw.typed, '')
  })
})

test('an Enter typed by fill does not carry the rest of the value into the field it focuses', async () => {
  await withBrowser({ focused: 'user' }, async (ops, state) => {
    const err = await refused(ops.runOp('fill', { tab: 1, selector: '#user', value: 'me\nhunter2', mode: 'type' }))
    assert.equal(err && err.code, ERR.SECRET_FIELD, 'the value after the Enter went into the password field')
    assert.equal(state.fields.user.typed, 'me')
    assert.equal(state.fields.pw.typed, '')
  })
})

test('a selector that cannot take focus does not let the keys land in the field that has it', async () => {
  await withBrowser({ focused: 'pw' }, async (ops, state) => {
    const err = await refused(ops.runOp('fill', { tab: 1, selector: 'body', value: 'secret', mode: 'type' }))
    assert.equal(err && err.code, ERR.SECRET_FIELD, 'fill type typed into the focused password field')
    assert.equal(state.fields.pw.typed, '')
  })
  await withBrowser({ focused: 'pw' }, async (ops, state) => {
    const err = await refused(ops.runOp('pressKeys', { tab: 1, selector: '#div', keys: 's e c', trusted: true }))
    assert.equal(err && err.code, ERR.SECRET_FIELD, 'trusted keys typed into the focused password field')
    assert.equal(state.fields.pw.typed, '')
  })
})

test('with the recorded yes the same keys go through, and the receipt is named', async () => {
  await withBrowser({ focused: 'user' }, async (ops, state) => {
    const result = await ops.runOp('pressKeys', { tab: 1, keys: 'u Tab p w', trusted: true, accountWordGrant: GRANT })
    assert.equal(result.receipt, GRANT.file)
    assert.equal(state.fields.user.typed, 'u')
    assert.equal(state.fields.pw.typed, 'pw')
  })
  // Plain characters into an ordinary field are checked once, not once a key.
  await withBrowser({ focused: 'user' }, async (ops, state) => {
    const result = await ops.runOp('pressKeys', { tab: 1, keys: 'a b c d', trusted: true })
    assert.equal(result.receipt, undefined)
    assert.equal(state.fields.user.typed, 'abcd')
    assert.equal(state.probes, 1)
  })
})

test('the grant is judged against the page that was probed, not the address read before it', async () => {
  // The tab's address said the granted site; the document the probe ran in is
  // another one (a redirect between the two reads).
  await withBrowser({ focused: 'pw', tabUrl: PAGE, pageUrl: 'https://other.example/login' }, async (ops, state) => {
    const err = await refused(ops.runOp('pressKeys', { tab: 1, keys: 'x', trusted: true, accountWordGrant: GRANT }))
    assert.equal(err && err.code, ERR.SECRET_FIELD)
    assert.match(err.message, /other\.example/)
    assert.equal(state.fields.pw.typed, '')
  })
})

test('focus inside another site\'s frame is refused even with a recorded yes', () => {
  const opaque = { tag: 'iframe', opaque: true }
  const verdict = secretFieldVerdict({ field: opaque, grant: GRANT, url: PAGE })
  assert.equal(verdict.allowed, false, 'a grant for the top page covered a frame it cannot see')
  assert.match(verdict.message, /frame/)
})

test('a name in the recorded yes is the site\'s own name, never a subdomain of somebody else\'s', async () => {
  const { serviceNamesHost } = await import('../shared/protocol.mjs')
  // The site itself, its subdomains, and a country's second level.
  for (const host of ['ledgerly.example', 'accounts.ledgerly.example', 'ledgerly.co.uk', 'login.ledgerly.com.au']) {
    assert.equal(serviceNamesHost('ledgerly', host), true, host)
  }
  // The name as a subdomain of a site anyone can register: the phishing shape.
  for (const host of ['ledgerly.login-check.example', 'ledgerly.pages.example', 'www.ledgerly.attacker.co', 'ledgerly.co.com']) {
    assert.equal(serviceNamesHost('ledgerly', host), false, host)
  }
  // A registry suffix names every site under it, so it names none.
  for (const [service, host] of [['co.uk', 'ledgerly.co.uk'], ['com', 'ledgerly.com'], ['com.au', 'x.com.au']]) {
    assert.equal(serviceNamesHost(service, host), false, `${service} on ${host}`)
  }
  assert.equal(serviceNamesHost('ledgerly.co.uk', 'www.ledgerly.co.uk'), true)
})

async function probeWith(documentShape, chromeDom = null) {
  const { pageFieldKind } = await import('../extension/lib/inject.js')
  const saved = { document: globalThis.document, location: globalThis.location, chrome: globalThis.chrome }
  globalThis.document = documentShape
  globalThis.location = { href: 'https://site.example/login' }
  globalThis.chrome = chromeDom ? { dom: chromeDom } : undefined
  try {
    return pageFieldKind({ selector: null })
  } finally {
    globalThis.document = saved.document
    globalThis.location = saved.location
    globalThis.chrome = saved.chrome
  }
}

const node = (tag, attrs = {}, extra = {}) => ({
  tagName: tag,
  type: attrs.type,
  getAttribute: (name) => (Object.hasOwn(attrs, name) ? attrs[name] : null),
  labels: [],
  shadowRoot: null,
  ...extra,
})

test('the probe sees into a closed shadow root and refuses what it cannot see', async () => {
  const password = node('INPUT', { type: 'password', name: 'pw' })
  const closedHost = node('LOGIN-BOX')
  const closedRoots = new Map([[closedHost, { activeElement: password }]])
  const dom = { openOrClosedShadowRoot: (el) => closedRoots.get(el) || null }
  const inside = await probeWith({ activeElement: closedHost, getElementById: () => null }, dom)
  assert.equal(inside.field.type, 'password', 'the probe stopped at the closed shadow host')
  assert.equal(inside.url, 'https://site.example/login')

  const embed = await probeWith({ activeElement: node('EMBED'), getElementById: () => null })
  assert.equal(embed.field.opaque, true, 'focus inside an embed read as an ordinary element')
  const object = await probeWith({ activeElement: node('OBJECT', {}, { contentDocument: null }), getElementById: () => null })
  assert.equal(object.field.opaque, true, 'focus inside another site\'s object read as an ordinary element')
})
