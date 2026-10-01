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

import { isOwnExtensionPage, mayResume } from '../extension/lib/ui-sender.js'

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

/* -------------------------------------------------------------------------- */
/* Resume: the popup, and only the popup                                       */
/* -------------------------------------------------------------------------- */

test('only the popup page may ask to resume from panic', () => {
  const popup = { id: ID, url: `${ORIGIN}/popup/index.html`, origin: ORIGIN }
  assert.equal(mayResume(popup, ID), true)
  // An older browser that sends no origin still has the url to judge by.
  assert.equal(mayResume({ id: ID, url: `${ORIGIN}/popup/index.html` }, ID), true)
})

test('a content script cannot resume, however it dresses the message', () => {
  // The renderer of a page the bridge touched is the threat this guards: it
  // carries this extension's id, and the browser stamps the PAGE's url on it.
  const contentScript = { id: ID, url: 'https://attacker.example/landing', origin: 'https://attacker.example', tab: { id: 12 }, frameId: 0 }
  assert.equal(mayResume(contentScript, ID), false)
  // Even a page whose url merely mentions the popup's path.
  assert.equal(mayResume({ id: ID, url: 'https://attacker.example/popup/index.html', tab: { id: 3 } }, ID), false)
})

test('the Board, another extension page and lookalike paths cannot resume', () => {
  // The Board can trip panic and read it; resuming stays on the one surface
  // with the press-and-hold.
  assert.equal(mayResume({ id: ID, url: `${ORIGIN}/options/index.html`, origin: ORIGIN, tab: { id: 7 } }, ID), false)
  assert.equal(mayResume({ id: ID, url: `${ORIGIN}/popup/index.html.evil` }, ID), false)
  assert.equal(mayResume({ id: ID, url: `${ORIGIN}/popup/other.html` }, ID), false)
  assert.equal(mayResume({ id: ID, url: `${ORIGIN}zz/popup/index.html` }, ID), false)
  assert.equal(mayResume(undefined, ID), false)
  assert.equal(mayResume({ id: ID, url: `${ORIGIN}/popup/index.html` }, ''), false)
  // A query or fragment on the popup's own url is still the popup.
  assert.equal(mayResume({ id: ID, url: `${ORIGIN}/popup/index.html?x=1#y` }, ID), true)
})

test('the worker checks mayResume before it asks the broker to resume', () => {
  const source = fs.readFileSync(new URL('../extension/sw.js', import.meta.url), 'utf8')
  const start = source.indexOf("case 'resume':")
  assert.notEqual(start, -1, "sw.js handles a 'resume' UI message")
  const body = source.slice(start, source.indexOf('case ', start + 10))
  const guard = body.indexOf('mayResume(sender, chrome.runtime.id)')
  const ask = body.indexOf('OPS.RESUME')
  assert.notEqual(guard, -1, 'the resume case calls mayResume with the sender and this extension\'s id')
  assert.notEqual(ask, -1, 'the resume case still asks the broker for OPS.RESUME')
  assert.ok(guard < ask, 'the sender is checked before the broker is asked')
  // And the listener hands the sender down, or the check has nothing to judge.
  assert.match(source, /handleUiMessage\(message, sender\)/)
})

test('no MCP tool can resume: the server registers none and never names the op', () => {
  const source = fs.readFileSync(new URL('../mcp-server/index.mjs', import.meta.url), 'utf8')
  assert.equal(/OPS\.RESUME/.test(source), false, 'the MCP server sends OPS.RESUME somewhere')
  assert.equal(/['"]resume['"]/.test(source), false, 'the MCP server names the resume op')
  assert.equal(/registerTool\(\s*['"]bridge_resume/.test(source), false)
})
