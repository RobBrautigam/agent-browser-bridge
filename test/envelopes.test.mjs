/**
 * Registration envelope tests.
 *
 * These two builders exist because of a specific, expensive bug. The extension
 * sent `vendor` and `extensionVersion`; the broker read `vendorHint` and
 * `extVersion`. Neither side threw. `undefined` is not a JSON value, so the
 * fields the broker wanted were simply absent from the message, every read
 * returned undefined, and the vendor fell through to its default. Every Brave
 * profile on the machine registered as Chrome - every Brave line
 * mislabeled, with no error anywhere in the system.
 *
 * The fix is that both sides now build and read these envelopes through
 * register() and registerAck(). That only holds if the builders emit EVERY
 * documented key even when the caller passes nothing, because a key that is
 * absent reads as undefined on the other side, and a key that is present with
 * an explicit null reads as null. The whole point of a builder here is to turn
 * the first case into the second, so that is what these tests check.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { MSG, PROTOCOL_VERSION, TIMING, register, registerAck } from '../shared/protocol.mjs'

/** Exactly the fields register() documents, in sorted order. */
const REGISTER_KEYS = [
  'email',
  'extVersion',
  'installId',
  'label',
  'tabCount',
  'type',
  'v',
  'vendorHint',
]

/** Exactly the fields registerAck() documents, in sorted order. */
const REGISTER_ACK_KEYS = [
  'candidates',
  'claimed',
  'error',
  'generation',
  'heartbeatMs',
  'label',
  'ok',
  'profileDir',
  'profileKey',
  'profileName',
  'type',
  'v',
  'vendor',
  'version',
  'warning',
]

/* -------------------------------------------------------------------------- */
/* register                                                                    */
/* -------------------------------------------------------------------------- */

test('register emits every documented key from only the required field', () => {
  // The bare call is the one that matters. If a key can go missing when the
  // caller omits it, the receiving side reads undefined and takes its default
  // branch, which is exactly how a Brave profile became a Chrome profile.
  const msg = register({ installId: 'install-uuid-1' })

  assert.deepEqual(Object.keys(msg).sort(), REGISTER_KEYS)
  assert.equal(msg.v, PROTOCOL_VERSION)
  assert.equal(msg.type, MSG.REGISTER)
  assert.equal(msg.installId, 'install-uuid-1')

  // Absent means null here, never undefined.
  assert.strictEqual(msg.vendorHint, null)
  assert.strictEqual(msg.email, null)
  assert.strictEqual(msg.label, null)
  assert.strictEqual(msg.extVersion, null)
  assert.strictEqual(msg.tabCount, 0)
})

test('register survives JSON with every key intact', () => {
  // The test that would have caught the original bug. JSON.stringify drops
  // undefined values silently, so a builder that leaves a key undefined
  // produces a message where the key does not exist at all - and a receiver
  // doing `msg.vendorHint ?? 'chrome'` never knows it was told anything.
  const shipped = JSON.parse(JSON.stringify(register({ installId: 'x' })))
  assert.deepEqual(Object.keys(shipped).sort(), REGISTER_KEYS)
  for (const key of REGISTER_KEYS) {
    assert.ok(key in shipped, `${key} did not survive serialization`)
  }
})

test('register carries the vendor hint under the name the broker reads', () => {
  // The direct regression. The field is `vendorHint`, one name, spelled here
  // and read here, and Brave has to arrive as Brave.
  const brave = register({ installId: 'i', vendorHint: 'brave', extVersion: '0.1.0' })
  assert.equal(brave.vendorHint, 'brave')
  assert.equal(brave.extVersion, '0.1.0')

  // And the names the first build used must not exist, or a half-migrated
  // sender would appear to work while sending a field nobody reads.
  assert.ok(!('vendor' in brave), 'the old `vendor` field name is back')
  assert.ok(!('extensionVersion' in brave), 'the old `extensionVersion` field name is back')
})

test('register passes every field through unchanged when they are all supplied', () => {
  const msg = register({
    installId: 'install-uuid-2',
    vendorHint: 'brave',
    email: 'alice@acme-corp.com',
    label: 'brave-acme-corp',
    extVersion: '0.1.0',
    tabCount: 12,
  })
  assert.deepEqual(msg, {
    v: PROTOCOL_VERSION,
    type: MSG.REGISTER,
    installId: 'install-uuid-2',
    vendorHint: 'brave',
    email: 'alice@acme-corp.com',
    label: 'brave-acme-corp',
    extVersion: '0.1.0',
    tabCount: 12,
  })
})

/* -------------------------------------------------------------------------- */
/* registerAck                                                                 */
/* -------------------------------------------------------------------------- */

test('registerAck emits every documented key from only the ok flag', () => {
  // The ack is worse than the register if a key goes missing: the extension
  // STORES what comes back, and the options page renders it. A missing
  // `claimed` reads as falsy and shows a claim prompt for a claimed profile; a
  // missing `candidates` breaks the claim UI outright.
  const ack = registerAck({ ok: true })

  assert.deepEqual(Object.keys(ack).sort(), REGISTER_ACK_KEYS)
  assert.equal(ack.v, PROTOCOL_VERSION)
  assert.equal(ack.type, MSG.REGISTER_ACK)
  assert.equal(ack.ok, true)

  assert.strictEqual(ack.error, null)
  assert.strictEqual(ack.profileKey, null)
  assert.strictEqual(ack.label, null)
  assert.strictEqual(ack.generation, 0)
  assert.strictEqual(ack.claimed, false)
  assert.deepEqual(ack.candidates, [])
  assert.strictEqual(ack.profileDir, null)
  assert.strictEqual(ack.profileName, null)
  assert.strictEqual(ack.vendor, null)
  assert.strictEqual(ack.warning, null)
  assert.strictEqual(ack.version, null)
})

test('registerAck defaults the heartbeat to the shared interval', () => {
  // The extension schedules its own heartbeat from this number. Left absent it
  // would be undefined, and setInterval(fn, undefined) fires on the next tick -
  // a profile heartbeating thousands of times a second at the broker.
  assert.equal(registerAck({ ok: true }).heartbeatMs, TIMING.HEARTBEAT_INTERVAL)
  assert.equal(registerAck({ ok: true, heartbeatMs: 5_000 }).heartbeatMs, 5_000)
})

test('registerAck survives JSON with every key intact', () => {
  const shipped = JSON.parse(JSON.stringify(registerAck({ ok: false, error: 'E_UNAUTHORIZED' })))
  assert.deepEqual(Object.keys(shipped).sort(), REGISTER_ACK_KEYS)
  for (const key of REGISTER_ACK_KEYS) {
    assert.ok(key in shipped, `${key} did not survive serialization`)
  }
  assert.equal(shipped.ok, false)
  assert.equal(shipped.error, 'E_UNAUTHORIZED')
})

test('registerAck carries a full claim result the options page can render', () => {
  const ack = registerAck({
    ok: true,
    profileKey: 'brave:Profile 1',
    label: 'brave-acme-corp',
    generation: 3,
    claimed: true,
    candidates: [{ dir: 'Profile 1', name: 'alice@acme-corp.com', email: null }],
    profileDir: 'Profile 1',
    profileName: 'alice@acme-corp.com',
    vendor: 'brave',
    warning: null,
    version: '0.1.0',
  })

  assert.deepEqual(Object.keys(ack).sort(), REGISTER_ACK_KEYS)
  assert.equal(ack.vendor, 'brave', 'the resolved vendor must come back as Brave, not Chrome')
  assert.equal(ack.profileDir, 'Profile 1')
  assert.equal(ack.claimed, true)
  assert.equal(ack.candidates.length, 1)
  assert.equal(ack.heartbeatMs, TIMING.HEARTBEAT_INTERVAL)
})

test('the two envelopes are distinguishable by type alone', () => {
  // Both cross the same relay in the same direction pairs, and the host does
  // not interpret them. Type is the only thing that separates them.
  assert.notEqual(MSG.REGISTER, MSG.REGISTER_ACK)
  assert.equal(register({ installId: 'i' }).type, MSG.REGISTER)
  assert.equal(registerAck({ ok: true }).type, MSG.REGISTER_ACK)
})
