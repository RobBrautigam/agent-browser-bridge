/**
 * The 1.1.0 adversarial review's state and ordering findings.
 *
 * Each is a rule about WHEN something happens in code that only runs inside a
 * browser or a live broker, so the checks read the source for the order, the
 * way secret-field.test.mjs checks that the guard sits before any typing. The
 * ledger rule is pure and is driven directly.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { RESTORED_SLACK_MS, recordOpened } from '../extension/lib/tab-ages.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...parts) => fs.readFileSync(path.join(REPO, ...parts), 'utf8')

/** The body of one top-level function, up to the next top-level declaration. */
function body(source, signature) {
  const start = source.indexOf(signature)
  assert.notEqual(start, -1, `found ${signature}`)
  const rest = source.slice(start + signature.length)
  const end = rest.search(/\n(?:export )?(?:async )?function /)
  return signature + (end === -1 ? rest : rest.slice(0, end))
}

test('a held-through-panic flag never outlives the connection it was set on', () => {
  const link = read('extension', 'lib', 'link.js')
  // A new port is not held until its own answer says so: a worker that died
  // while held must not carry the flag onto the next connection.
  const connect = body(link, 'async function connect(reason)')
  const cleared = connect.indexOf('clearPanicHeld()')
  assert.notEqual(cleared, -1, 'connect() clears the held flag')
  assert.ok(cleared < connect.indexOf('connectNative'), 'connect() clears the flag before it dials')
  // And a registration that succeeded is not held, whatever storage says.
  const ack = body(link, 'async function onRegisterAck(msg)')
  const okPath = ack.slice(ack.indexOf('await setAttempt(0)', ack.indexOf('await teardown(')))
  assert.match(okPath, /clearPanicHeld\(\)/, 'a successful REGISTER_ACK clears the held flag')
})

test('a registration that was waiting when panic tripped is held, never routed', () => {
  const broker = read('bridged', 'index.mjs')
  const register = body(broker, 'async function handleRegister(conn, msg)')
  const awaited = register.indexOf('await resolveIdentity(')
  assert.notEqual(awaited, -1)
  const attach = register.indexOf('routes.attach(')
  assert.notEqual(attach, -1, 'handleRegister still attaches a route')
  const recheck = register.slice(awaited, attach)
  assert.match(recheck, /holdThroughPanic\(conn, installId\)/, 'panic is checked again after the awaits, before the route')
  const first = register.slice(0, register.indexOf('await Promise.race('))
  assert.match(first, /holdThroughPanic\(conn, installId\)/, 'and before them, so a held answer is not delayed')
})

test('the bridge registers first and the tab age ledger re-keys after, without holding it up', () => {
  const sw = read('extension', 'sw.js')
  const boot = body(sw, 'async function boot(reason)')
  assert.doesNotMatch(boot, /await ensureAgesSession\(/, 'boot waits on the ledger before the profile registers')
  const connect = boot.indexOf('ensureConnected(reason)')
  const ages = boot.indexOf('ensureAgesSession(')
  assert.ok(connect !== -1 && ages !== -1 && connect < ages, 'ensureConnected runs before the ledger re-key starts')
})

test('a restored tab, last shown long before its created event, is not stamped as new', () => {
  const now = 1_800_000_000_000
  const tab = (id, lastAccessed) => ({ id, windowId: 1, index: 0, url: 'https://a.example/', lastAccessed })
  // Restored by the browser after a restart, or a closed window reopened: the
  // tab was last shown hours ago, so "created now" is not its age.
  assert.deepEqual(recordOpened({}, tab(5, now - 3 * 3600_000), now), {}, 'an old tab was stamped with a fresh open time')
  assert.deepEqual(recordOpened({}, tab(6, now - RESTORED_SLACK_MS - 1), now), {})
  // A tab opened just now is stamped, with or without a last-shown time.
  assert.equal(recordOpened({}, tab(7, now - 50), now)['7'].at, now)
  assert.equal(recordOpened({}, tab(8, undefined), now)['8'].at, now)
})
