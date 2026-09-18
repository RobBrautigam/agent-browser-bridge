/**
 * The extension's copy of the protocol must match the shared contract.
 *
 * extension/lib/protocol.js is a hand-maintained mirror of
 * shared/protocol.mjs, because an extension cannot import a file outside its
 * own folder. A drift between them is not a load error: it is a silent wire
 * incompatibility, the exact class of bug that once had every Brave profile
 * register as Chrome. scripts/gate.mjs runs the same comparison on every
 * commit; this test runs it under `npm test`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import * as shared from '../shared/protocol.mjs'
import * as mirror from '../extension/lib/protocol.js'

/** Constants that must be byte-for-byte identical on both sides. */
const IDENTICAL = [
  'PROTOCOL_VERSION',
  'PRODUCT_NAME',
  'PRODUCT_TAGLINE',
  'NATIVE_HOST_ID',
  'MSG',
  'CHUNK_SLICE_BYTES',
  'OPS',
  'TIER',
  'OP_TIER',
  'BROWSER_OPS',
  'BROKER_OPS',
  'HOST_REQ_ALLOWED_OPS',
  'MAX_ARM_MINUTES',
  'ERR',
  'LINK',
  'RESTRICTED_URL_PREFIXES',
  'RAW_TAB_ID_FIELD',
  'LOCAL_PAGE_EXTENSIONS',
  'OPEN_OR_FOCUS_MATCH',
]

test('every mirrored constant is identical to the shared contract', () => {
  for (const name of IDENTICAL) {
    assert.ok(name in shared, `shared/protocol.mjs no longer exports ${name}`)
    assert.ok(name in mirror, `extension/lib/protocol.js no longer exports ${name}`)
    assert.deepEqual(mirror[name], shared[name], `${name} drifted between the contract and the extension mirror`)
  }
})

test('every timing the extension carries matches the shared value', () => {
  // The extension copies TIMING whole but may lag behind broker-only entries
  // (PARENT_WATCH_INTERVAL is a Windows launcher concern). Every key it DOES
  // carry must agree.
  for (const [key, value] of Object.entries(mirror.TIMING)) {
    assert.equal(value, shared.TIMING[key], `TIMING.${key} drifted`)
  }
})

test('the message builders produce the same envelopes', () => {
  assert.deepEqual(mirror.register({ installId: 'i' }), shared.register({ installId: 'i' }))
  assert.deepEqual(mirror.registerAck({ ok: true }), shared.registerAck({ ok: true }))
  assert.deepEqual(mirror.req({ id: 1, op: 'x', timeoutMs: 5 }), shared.req({ id: 1, op: 'x', timeoutMs: 5 }))
  assert.deepEqual(mirror.ok(1, { a: 1 }), shared.ok(1, { a: 1 }))
  assert.deepEqual(mirror.fail(1, 'E_X', 'm'), shared.fail(1, 'E_X', 'm'))
  assert.deepEqual(mirror.ping(3), shared.ping(3))
  assert.deepEqual(mirror.pong(3, { t: 1 }), shared.pong(3, { t: 1 }))
  assert.deepEqual(mirror.event('n', { p: 1 }), shared.event('n', { p: 1 }))
  assert.deepEqual(mirror.chunk({ id: 'c', seq: 0, total: 1, data: 'AA==' }), shared.chunk({ id: 'c', seq: 0, total: 1, data: 'AA==' }))
})

test('tab handles and URL rules agree', () => {
  const h = shared.mintTabHandle('chrome-work', 4, 17)
  assert.equal(mirror.mintTabHandle('chrome-work', 4, 17), h)
  assert.deepEqual(mirror.parseTabHandle(h), shared.parseTabHandle(h))
  for (const url of ['file:///x', 'chrome://a', 'https://example.com/', '', 'about:blank']) {
    assert.equal(mirror.isRestrictedUrl(url), shared.isRestrictedUrl(url), url)
  }
  assert.equal(mirror.originOf('https://a.example/p?q#f'), shared.originOf('https://a.example/p?q#f'))
})

test('the openOrFocus rules agree, address by address', () => {
  // The extension DECIDES with its copy of these and the broker ENFORCES with
  // the contract's, so a drift here is a page opened in one place and refused
  // in the other, or worse, a local file the broker lets through and the
  // extension has a different opinion about.
  const urls = [
    'file:///C:/dev/report.html',
    'file:///C:/dev/report.HTM',
    'file:///C:/dev/notes.html.txt',
    'file:///C:/Users/someone/.env',
    'https://example.com/report',
    'chrome://settings',
    '',
  ]
  for (const url of urls) {
    assert.equal(mirror.isLocalPageUrl(url), shared.isLocalPageUrl(url), url)
    assert.equal(mirror.isOpenOrFocusUrl(url), shared.isOpenOrFocusUrl(url), url)
  }

  const target = 'file:///C:/dev/repo/docs/report.html'
  const others = [target, 'file:///c:/dev/repo/docs/report.html#x', 'file:///C:/dev/other/docs/report.html']
  for (const other of others) {
    for (const allowFileName of [false, true]) {
      assert.equal(
        mirror.openOrFocusMatch(target, other, { allowFileName }),
        shared.openOrFocusMatch(target, other, { allowFileName }),
        `${other} (allowFileName ${allowFileName})`
      )
    }
  }

  const spec = {
    url: target,
    tabs: [
      { tabId: 1, windowId: 1, index: 0, url: target, active: false, pinned: false },
      { tabId: 2, windowId: 2, index: 0, url: target, active: true, pinned: false },
    ],
    lastFocusedWindowId: 2,
    openedByUs: [1],
  }
  assert.deepEqual(mirror.planOpenOrFocus(spec), shared.planOpenOrFocus(spec))
  const result = { action: 'reused', match: 'exact', fromIndex: 0, toIndex: 3, windowId: 2, moved: true, reloaded: true, closed: 1, kept: 0 }
  assert.equal(mirror.describeOpenOrFocus(result), shared.describeOpenOrFocus(result))
})
