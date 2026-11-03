/**
 * The debugger never touches a sign-in page.
 *
 * Google's sign-in refuses a browser with a DevTools protocol client attached,
 * and the refusal sticks to that page load, so a person who reaches it with
 * the bridge's debugger on the tab cannot sign in at all. These tests drive the
 * extension's operations against a fake browser and assert on what reached
 * chrome.debugger: no attach on a sign-in page, whatever the operation, and a
 * detach the moment a tab heads for one.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { ERR, SIGN_IN_HOSTS, isSignInUrl, signInUrlPatterns } from '../shared/protocol.mjs'

const SIGN_IN = 'https://accounts.google.com/v3/signin/identifier?continue=x'
const ORDINARY = 'https://app.example.com/home'

function fakeBrowser({ url = ORDINARY, pendingUrl = undefined } = {}) {
  const state = { attached: [], detached: [], commands: [] }
  const chrome = {
    runtime: { lastError: null },
    tabs: {
      async get(id) {
        return { id, windowId: 1, url, pendingUrl, status: 'complete', active: true }
      },
      async query() {
        return [{ id: 1, windowId: 1, url, active: true }]
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
      async executeScript({ func }) {
        if (func.name === 'pageRect') return [{ result: { ok: true, cx: 10, cy: 10, tag: 'button' } }]
        if (func.name === 'pageFieldKind') {
          return [{ result: { ok: true, url, focused: true, field: { tag: 'input', type: 'text', name: 'q', id: 'q', label: '', autocomplete: '', opaque: false } } }]
        }
        if (func.name === 'pageFocusSelect') return [{ result: { ok: true, focused: true, tag: 'input' } }]
        // The MAIN-world eval fails the way a strict CSP makes it fail, so
        // evalJs reaches for the debugger path.
        if (func.name === 'pageEval') return [{ result: { ok: false, reason: 'csp', error: 'EvalError' } }]
        return [{ result: { ok: true } }]
      },
    },
    debugger: {
      attach(target, _version, cb) {
        state.attached.push(target.tabId)
        cb()
      },
      detach(target, cb) {
        state.detached.push(target.tabId)
        cb()
      },
      sendCommand(_target, method, _params, cb) {
        state.commands.push(method)
        cb({ result: { type: 'number', value: 1 } })
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
    const ops = await import(`../extension/lib/ops.js?signin=${Math.random()}`)
    return await fn(ops, state)
  } finally {
    globalThis.chrome = previous
  }
}

async function refused(promise) {
  try {
    await promise
  } catch (err) {
    return err
  }
  return null
}

test('the sign-in hosts are exact host names, matched without case, port or a trailing dot', () => {
  assert.ok(SIGN_IN_HOSTS.includes('accounts.google.com'))
  assert.equal(isSignInUrl(SIGN_IN), true)
  assert.equal(isSignInUrl('https://ACCOUNTS.GOOGLE.COM./ServiceLogin'), true)
  assert.equal(isSignInUrl('https://accounts.google.com:443/x'), true)
  assert.equal(isSignInUrl('https://login.microsoftonline.com/common/oauth2'), true)
  assert.equal(isSignInUrl('https://appleid.apple.com/auth'), true)
  // Not sign-in pages: another Google product, a lookalike, a subdomain, junk.
  assert.equal(isSignInUrl('https://mail.google.com/mail/u/0/'), false)
  assert.equal(isSignInUrl('https://accounts.google.com.evil.example/'), false)
  assert.equal(isSignInUrl('https://x.accounts.google.com/'), false)
  assert.equal(isSignInUrl('not a url'), false)
  assert.equal(isSignInUrl(''), false)
  assert.equal(isSignInUrl(null), false)
  assert.deepEqual(signInUrlPatterns()[0], '*://accounts.google.com/*')
  assert.equal(signInUrlPatterns().length, SIGN_IN_HOSTS.length)
})

test('a trusted click on a sign-in page is refused before the debugger attaches', async () => {
  await withBrowser({ url: SIGN_IN }, async (ops, state) => {
    const err = await refused(ops.runOp('click', { tab: 1, selector: '#next', trusted: true }))
    assert.ok(err, 'the click went through')
    assert.equal(err.code, ERR.UNSUPPORTED)
    assert.match(err.message, /sign-in page/)
    assert.deepEqual(state.attached, [], 'the debugger attached to a sign-in page')
    assert.deepEqual(state.commands, [])
  })
})

test('a tab still loading a sign-in page is refused too (its pending address decides)', async () => {
  await withBrowser({ url: ORDINARY, pendingUrl: SIGN_IN }, async (ops, state) => {
    const err = await refused(ops.runOp('pressKeys', { tab: 1, keys: 'Enter', trusted: true }))
    assert.ok(err, 'the keys went through')
    assert.equal(err.code, ERR.UNSUPPORTED)
    assert.deepEqual(state.attached, [])
  })
})

test('typing into a sign-in page and the debugger eval fallback are refused the same way', async () => {
  await withBrowser({ url: SIGN_IN }, async (ops, state) => {
    const typed = await refused(ops.runOp('fill', { tab: 1, selector: '#q', value: 'abc', mode: 'type' }))
    assert.equal(typed && typed.code, ERR.UNSUPPORTED)
    const evaluated = await refused(ops.runOp('evalJs', { tab: 1, expression: '1' }))
    assert.equal(evaluated && evaluated.code, ERR.UNSUPPORTED)
    assert.deepEqual(state.attached, [], 'the debugger attached to a sign-in page')
  })
})

test('the same trusted click on an ordinary page still attaches, runs and detaches', async () => {
  await withBrowser({ url: ORDINARY }, async (ops, state) => {
    const result = await ops.runOp('click', { tab: 1, selector: '#next', trusted: true })
    assert.equal(result.tier, 2)
    assert.deepEqual(state.attached, [1])
    assert.deepEqual(state.detached, [1])
  })
})

test('a tab heading for a sign-in page has the debugger detached at once', async () => {
  await withBrowser({ url: ORDINARY }, async (ops, state) => {
    assert.equal(await ops.detachForSignIn(7, SIGN_IN), true)
    assert.deepEqual(state.detached, [7])
    // An ordinary navigation leaves the debugger alone.
    assert.equal(await ops.detachForSignIn(8, ORDINARY), false)
    assert.deepEqual(state.detached, [7])
  })
})
