/**
 * "The broker is not answering" only for an outage, never for one profile's
 * link reconnecting.
 *
 * The options page and the popup reach the broker through this profile's own
 * link, so a link that drops and comes back fails a poll or two while the
 * broker answers every other profile throughout. On a live install the card
 * said the broker was down while it had been up for hours and only one
 * profile's link was cycling. The rule is pure and driven directly; the pages
 * run only inside a browser, so their wiring is checked in the source, the way
 * review-fixes.test.mjs checks an order.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { OUTAGE_GRACE_MS, outageState } from '../extension/lib/outage.js'

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

test('no failure is not an outage', () => {
  assert.equal(outageState(null, 1_000_000), 'ok')
})

test('a failure younger than the grace is a reconnect, not an outage', () => {
  const since = 1_000_000
  assert.equal(outageState(since, since), 'reconnecting')
  assert.equal(outageState(since, since + OUTAGE_GRACE_MS - 1), 'reconnecting')
})

test('a failure that outlasts the grace is an outage', () => {
  const since = 1_000_000
  assert.equal(outageState(since, since + OUTAGE_GRACE_MS), 'down')
  assert.equal(outageState(since, since + 60_000), 'down')
})

test('the grace covers one reconnect and is still a few seconds', () => {
  // One reconnect is a backoff of about a second, one host start and one
  // REGISTER. Anything past ten seconds hides a real outage for too long.
  assert.ok(OUTAGE_GRACE_MS >= 4_000 && OUTAGE_GRACE_MS <= 10_000, `grace is ${OUTAGE_GRACE_MS} ms`)
})

for (const page of [
  ['options', 'options.js'],
  ['popup', 'popup.js'],
]) {
  const name = page[0]

  test(`the ${name} page raises the broker-down card only for a failure past the grace`, () => {
    const source = read('extension', ...page)
    const refresh = body(source, 'async function refresh(')
    const verdict = refresh.indexOf("outageState(state.outageSince) === 'down'")
    assert.notEqual(verdict, -1, `${name}: refresh() asks outageState before calling it an outage`)
    const raised = refresh.indexOf('state.error = {')
    assert.notEqual(raised, -1)
    assert.ok(raised > verdict, `${name}: state.error is set only past the grace`)
    assert.match(refresh, /state\.outageSince = null/, `${name}: a good poll ends the outage clock`)
  })

  test(`the ${name} page says Reconnecting while the link comes back`, () => {
    const source = read('extension', ...page)
    const status = body(source, 'function renderStatus(')
    assert.match(status, /state\.outageSince != null/, `${name}: renderStatus reads the outage clock`)
    assert.match(status, /'Reconnecting/, `${name}: and words it as reconnecting`)
  })
}
