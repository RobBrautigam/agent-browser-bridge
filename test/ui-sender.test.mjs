/**
 * The service worker's UI API answers this extension's own pages and nothing
 * else.
 *
 * The case this exists for is the content script: it carries this extension's
 * id, because it IS this extension's code, but it runs inside a web page's
 * renderer and the browser stamps the page's url and origin on its messages.
 * A check on the id alone would admit it, and with it anything that has taken
 * over that renderer.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { isOwnExtensionPage } from '../extension/lib/ui-sender.js'

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const ORIGIN = `chrome-extension://${ID}`

test('the popup and the Board are this extension\'s own pages', () => {
  assert.equal(isOwnExtensionPage({ id: ID, url: `${ORIGIN}/popup/index.html`, origin: ORIGIN }, ID), true)
  // The Board opens in a tab, so a tab on the sender is not a reason to refuse.
  assert.equal(
    isOwnExtensionPage({ id: ID, url: `${ORIGIN}/options/index.html`, origin: ORIGIN, tab: { id: 7 } }, ID),
    true
  )
  // An older browser that sends no origin still has the url to judge by.
  assert.equal(isOwnExtensionPage({ id: ID, url: `${ORIGIN}/popup/index.html` }, ID), true)
})

test('a content script in a web page is refused, although it carries this extension\'s id', () => {
  const contentScript = {
    id: ID,
    url: 'https://attacker.example/landing',
    origin: 'https://attacker.example',
    tab: { id: 12 },
    frameId: 0,
  }
  assert.equal(isOwnExtensionPage(contentScript, ID), false)
})

test('another extension, a lookalike id and a disagreeing origin are refused', () => {
  const other = 'ponmlkjihgfedcbaponmlkjihgfedcba'
  assert.equal(isOwnExtensionPage({ id: other, url: `chrome-extension://${other}/x.html` }, ID), false)
  // An id that merely STARTS with ours must not pass on a prefix match.
  assert.equal(isOwnExtensionPage({ id: ID, url: `${ORIGIN}zz/popup/index.html` }, ID), false)
  assert.equal(
    isOwnExtensionPage({ id: ID, url: `${ORIGIN}/popup/index.html`, origin: 'https://attacker.example' }, ID),
    false
  )
})

test('a missing sender, url or id is refused rather than guessed at', () => {
  assert.equal(isOwnExtensionPage(undefined, ID), false)
  assert.equal(isOwnExtensionPage(null, ID), false)
  assert.equal(isOwnExtensionPage({ id: ID }, ID), false)
  assert.equal(isOwnExtensionPage({ id: ID, url: `${ORIGIN}/popup/index.html` }, ''), false)
  assert.equal(isOwnExtensionPage({ id: ID, url: `${ORIGIN}/popup/index.html` }, undefined), false)
})

test('the worker checks the sender before it reads a UI message', () => {
  // The predicate is only worth anything if the listener consults it first.
  // sw.js cannot be imported outside a browser (it registers listeners and
  // dials the host at load), so its source is read instead, the same way the
  // protocol mirror is checked.
  const source = fs.readFileSync(new URL('../extension/sw.js', import.meta.url), 'utf8')
  const start = source.indexOf('chrome.runtime.onMessage.addListener(')
  assert.notEqual(start, -1, 'sw.js registers a runtime.onMessage listener')
  const body = source.slice(start, source.indexOf('\n})', start))
  const guard = body.indexOf('isOwnExtensionPage(sender, chrome.runtime.id)')
  const handle = body.indexOf('handleUiMessage(')
  assert.notEqual(guard, -1, 'the listener calls isOwnExtensionPage with the sender and this extension\'s id')
  assert.notEqual(handle, -1, 'the listener still hands allowed messages to handleUiMessage')
  assert.ok(guard < handle, 'the sender is checked before the message is handled')
})
