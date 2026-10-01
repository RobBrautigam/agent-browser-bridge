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
function fakeBrowser({
  focused = 'user',
  tabUrl = PAGE,
  pageUrl = PAGE,
  // Enter on the username focuses the password field: at once, or (async) a
  // moment later, between keys, the way a two-step sign-in animates in.
  enter = 'now',
  // A page script that moves focus to the password field after this many
  // characters typed into the username (auto-advance).
  advanceAfter = 0,
  // After an Enter, this many probes fail as the page navigates (Infinity: it never answers).
  failAfterEnter = 0,
  // Focus inside another site's frame: its address, the field it holds, and
  // whether the extension can read it.
  frame = null,
} = {}) {
  const fields = {
    user: { tag: 'INPUT', type: 'text', name: 'username', focusable: true, typed: '' },
    pw: { tag: 'INPUT', type: 'password', name: 'password', focusable: true, typed: '' },
    body: { tag: 'BODY', type: '', name: '', focusable: false, typed: '' },
    div: { tag: 'DIV', type: '', name: '', focusable: false, typed: '' },
    frame: { tag: 'IFRAME', type: '', name: 'checkout', focusable: true, typed: '' },
    card: { tag: 'INPUT', type: 'text', name: 'cardnumber', focusable: true, typed: '' },
    fpw: { tag: 'INPUT', type: 'password', name: 'password', focusable: true, typed: '' },
  }
  const tabOrder = ['user', 'pw']
  const state = { fields, focused, probes: 0, pending: null, failing: 0 }
  const select = (selector) => String(selector || '').replace(/^[#.]/, '')
  const describe = (key) => {
    const f = fields[key]
    return { tag: f.tag.toLowerCase(), type: f.type, autocomplete: '', name: f.name, id: key, label: '', opaque: false }
  }
  /** Where a trusted character lands: the focused field, or the field inside the focused frame. */
  const landing = () => (state.focused === 'frame' && frame ? frame.field : state.focused)
  const topProbe = (arg) => {
    if (arg.selector) {
      const key = select(arg.selector)
      return { ok: true, url: pageUrl, focused: true, field: fields[key] ? describe(key) : null }
    }
    if (state.focused === 'frame' && !arg.shallow) {
      return { ok: true, url: pageUrl, focused: true, field: { ...describe('frame'), opaque: true, frame: true } }
    }
    return { ok: true, url: pageUrl, focused: true, field: describe(state.focused) }
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
      async executeScript({ target, func, args }) {
        const arg = args && args[0] ? args[0] : {}
        if (func.name === 'pageFieldKind') {
          state.probes += 1
          if (state.pending) {
            state.focused = state.pending
            state.pending = null
          }
          if (state.failing > 0) {
            state.failing -= 1
            throw new Error('Frame with ID 0 was removed.')
          }
          if (target.allFrames) {
            const results = [{ frameId: 0, result: topProbe(arg) }]
            if (frame && frame.readable && state.focused === 'frame') {
              results.push({ frameId: 7, result: { ok: true, url: frame.url, focused: true, field: describe(frame.field) } })
            }
            return results
          }
          return [{ frameId: 0, result: topProbe(arg) }]
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
          if (params.key === 'Enter') state.failing = failAfterEnter
          // A two-step sign-in: Enter on the username shows the password field
          // and focuses it, the way many sign-in pages do.
          if (params.key === 'Enter' && state.focused === 'user' && enter === 'async') {
            state.pending = 'pw'
          } else if (params.key === 'Tab' || (params.key === 'Enter' && state.focused === 'user' && enter === 'now')) {
            const at = tabOrder.indexOf(state.focused)
            state.focused = tabOrder[(at + 1) % tabOrder.length]
          } else if (typeof params.text === 'string' && params.key !== 'Enter') {
            fields[landing()].typed += params.text
            if (advanceAfter && state.focused === 'user' && fields.user.typed.length >= advanceAfter) state.focused = 'pw'
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
  // Ordinary typing into an ordinary field still goes through: one check before
  // the call, then one before each later key (a page may move focus on any key).
  await withBrowser({ focused: 'user' }, async (ops, state) => {
    const result = await ops.runOp('pressKeys', { tab: 1, keys: 'a b c d', trusted: true })
    assert.equal(result.receipt, undefined)
    assert.equal(state.fields.user.typed, 'abcd')
    assert.equal(state.probes, 4)
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
  // A two-letter country code is not a registry by itself: co.de is somebody's site.
  assert.equal(serviceNamesHost('ledgerly', 'ledgerly.co.de'), false)
  assert.equal(serviceNamesHost('co', 'evil.co.uk'), false)
  // Shared hosting: every customer gets a subdomain of the provider's own name.
  for (const [service, host] of [['github', 'evil.github.io'], ['vercel', 'phish.vercel.app'], ['github.io', 'evil.github.io'], ['me.uk', 'x.me.uk']]) {
    assert.equal(serviceNamesHost(service, host), false, `${service} on ${host}`)
  }
  assert.equal(serviceNamesHost('github', 'github.com'), true)
  assert.equal(serviceNamesHost('github', 'docs.github.com'), true)
})

test('every trusted key is checked, so focus a page moves on its own is caught before the next key', async () => {
  // Auto-advance: the page moves focus to the password field after two characters.
  await withBrowser({ focused: 'user', advanceAfter: 2 }, async (ops, state) => {
    const err = await refused(ops.runOp('fill', { tab: 1, selector: '#user', value: 'mehunter2', mode: 'type' }))
    assert.equal(err && err.code, ERR.SECRET_FIELD, 'characters after the auto-advance went into the password field')
    assert.equal(state.fields.pw.typed, '')
  })
  await withBrowser({ focused: 'user', advanceAfter: 2 }, async (ops, state) => {
    const err = await refused(ops.runOp('pressKeys', { tab: 1, keys: 'm e h u n', trusted: true }))
    assert.equal(err && err.code, ERR.SECRET_FIELD, 'keys after the auto-advance went into the password field')
    assert.deepEqual(err.data, { sent: 2 })
    assert.equal(state.fields.pw.typed, '')
  })
  // A two-step sign-in that focuses the password field a moment after the Enter.
  await withBrowser({ focused: 'user', enter: 'async' }, async (ops, state) => {
    const err = await refused(ops.runOp('fill', { tab: 1, selector: '#user', value: 'me\nhunter2', mode: 'type' }))
    assert.equal(err && err.code, ERR.SECRET_FIELD)
    assert.equal(state.fields.pw.typed, '')
  })
  await withBrowser({ focused: 'user', enter: 'async' }, async (ops, state) => {
    const err = await refused(ops.runOp('pressKeys', { tab: 1, keys: ['Enter', 'h', 'u', 'n'], trusted: true }))
    assert.equal(err && err.code, ERR.SECRET_FIELD)
    assert.deepEqual(err.data, { sent: 1 }, 'the error names how many keys were sent, never which')
    assert.equal(state.fields.pw.typed, '')
  })
})

test('a page the last key sent navigating is waited for, not typed into blind and not failed at once', async () => {
  await withBrowser({ focused: 'user', enter: 'none', failAfterEnter: 2 }, async (ops, state) => {
    const result = await ops.runOp('pressKeys', { tab: 1, keys: ['Enter', 'x'], trusted: true })
    assert.deepEqual(result.dispatched, ['Enter', 'x'])
    assert.equal(state.fields.user.typed, 'x')
  })
  await withBrowser({ focused: 'user', enter: 'none', failAfterEnter: Infinity }, async (ops, state) => {
    const err = await refused(ops.runOp('pressKeys', { tab: 1, keys: ['Enter', 'x'], trusted: true }))
    assert.ok(err, 'a page that never answered was typed into')
    assert.notEqual(err.code, ERR.SECRET_FIELD)
    assert.match(err.message, /Stopped after 1 key/)
    assert.deepEqual(err.data, { sent: 1 })
    assert.equal(state.fields.user.typed, '')
  })
})

test('focus inside another site\'s frame is read in that frame, and judged by that frame\'s site', async () => {
  // A card field in a payment frame: not a password, so typing goes through.
  const pay = { url: 'https://pay.example/frame', field: 'card', readable: true }
  await withBrowser({ focused: 'user', frame: pay }, async (ops, state) => {
    const result = await ops.runOp('fill', { tab: 1, selector: '#frame', value: '4242', mode: 'type' })
    assert.equal(result.typed, 4)
    assert.equal(state.fields.card.typed, '4242')
  })
  // A password field in that frame: the top page's yes does not cover it, the frame's own site's does.
  const login = { url: 'https://pay.example/login', field: 'fpw', readable: true }
  await withBrowser({ focused: 'frame', frame: login }, async (ops, state) => {
    const err = await refused(ops.runOp('pressKeys', { tab: 1, keys: 'p w', trusted: true, accountWordGrant: GRANT }))
    assert.equal(err && err.code, ERR.SECRET_FIELD)
    assert.match(err.message, /pay\.example/)
    assert.equal(state.fields.fpw.typed, '')
  })
  await withBrowser({ focused: 'frame', frame: login }, async (ops, state) => {
    const grant = { file: '2026-01-01-note-2.md', services: ['pay.example'] }
    const result = await ops.runOp('pressKeys', { tab: 1, keys: 'p w', trusted: true, accountWordGrant: grant })
    assert.equal(result.receipt, grant.file)
    assert.equal(state.fields.fpw.typed, 'pw')
  })
  // A frame the extension cannot read stays a field it cannot see.
  await withBrowser({ focused: 'frame', frame: { ...pay, readable: false } }, async (ops, state) => {
    const err = await refused(ops.runOp('pressKeys', { tab: 1, keys: 'x', trusted: true }))
    assert.equal(err && err.code, ERR.SECRET_FIELD)
    assert.equal(state.fields.card.typed, '')
  })
})

test('untrusted key events, which can never type, are checked where they are sent, not inside a frame', async () => {
  const pay = { url: 'https://pay.example/frame', field: 'card', readable: false }
  await withBrowser({ focused: 'frame', frame: pay }, async (ops) => {
    const result = await ops.runOp('pressKeys', { tab: 1, keys: 'Escape' })
    assert.equal(result.trusted, false)
  })
  // A password field the events are sent to is still refused.
  await withBrowser({ focused: 'pw' }, async (ops) => {
    const err = await refused(ops.runOp('pressKeys', { tab: 1, keys: 'a' }))
    assert.equal(err && err.code, ERR.SECRET_FIELD)
  })
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
  assert.equal(object.field.frame, true, 'a frame the probe could not enter is named as one, so the extension asks that frame')
})

test('the probe follows deep nesting, and what it cannot reach in time it does not call safe', async () => {
  const password = node('INPUT', { type: 'password', name: 'pw' })
  const chain = (depth) => {
    let inner = password
    for (let i = 0; i < depth; i++) {
      const host = node(`X-LEVEL-${i}`)
      host.shadowRoot = { activeElement: inner }
      inner = host
    }
    return inner
  }
  const ten = await probeWith({ activeElement: chain(10), getElementById: () => null })
  assert.equal(ten.field.type, 'password', 'ten shadow roots deep hid the password field')
  const deep = await probeWith({ activeElement: chain(80), getElementById: () => null })
  assert.equal(deep.field.opaque, true, 'the walk ran out and called the host it stopped at a plain element')
  // A PDF viewer is an embed with no field in it.
  const pdf = await probeWith({ activeElement: node('EMBED', { type: 'application/pdf' }), getElementById: () => null })
  assert.equal(pdf.field.opaque, false)
  // Shallow: where untrusted events are sent, the top document's focused element.
  const { pageFieldKind } = await import('../extension/lib/inject.js')
  const saved = { document: globalThis.document, location: globalThis.location }
  globalThis.document = { activeElement: node('IFRAME', {}, { contentDocument: null }), getElementById: () => null }
  globalThis.location = { href: 'https://site.example/' }
  try {
    const shallow = pageFieldKind({ selector: null, shallow: true })
    assert.equal(shallow.field.tag, 'iframe')
    assert.equal(shallow.field.opaque, false)
  } finally {
    globalThis.document = saved.document
    globalThis.location = saved.location
  }
})
