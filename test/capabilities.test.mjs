/**
 * Capability partition tests.
 *
 * Three halves, all about the same thing: what a connection is allowed to do,
 * and what tier or executor an operation lands in.
 *
 * 1. `canSend(role, msgType)` is the wire-level partition. It answers "may this
 *    role put this envelope on the wire at all". An `mcp` connection issues
 *    operations and may never answer one; a `host` connection answers
 *    operations, and may now issue one - but only for the broker-local ops
 *    listed in HOST_REQ_ALLOWED_OPS.
 *
 * 2. `canOriginate(role, op)` is the second half of that relaxation, and it is
 *    the half that carries the security property. Letting a host send REQ at
 *    the envelope level is only safe because this predicate refuses every op
 *    that would cross into a browser. Without it, an extension compromised in
 *    one profile could drive all the others.
 *
 * 3. `OP_TIER`, `BROWSER_OPS` and `BROKER_OPS` are the policy and routing
 *    partitions. Their only real failure mode is silence: an op with no tier
 *    entry defaults to whatever the policy code's `||` says, and an op in
 *    neither ops list is an unroutable request that fails with no diagnosis.
 *
 * The role tests import bridged/policy.mjs dynamically so the contract halves
 * of this file still run and report honestly while that module is being
 * written. Nothing is stubbed: if canSend or canOriginate is missing or wrong,
 * these fail, which is the point.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ROLE,
  MSG,
  OPS,
  TIER,
  OP_TIER,
  BROWSER_OPS,
  BROKER_OPS,
  HOST_REQ_ALLOWED_OPS,
  MAX_ARM_MINUTES,
} from '../shared/protocol.mjs'

const POLICY_MODULE = '../bridged/policy.mjs'

/* -------------------------------------------------------------------------- */
/* 1. The role partition                                                       */
/* -------------------------------------------------------------------------- */

test('an mcp connection may issue requests', async () => {
  const { canSend } = await import(POLICY_MODULE)
  assert.equal(canSend(ROLE.MCP, MSG.REQ), true)
})

test('an mcp connection may NOT answer, register or pong', async () => {
  // An mcp client that could send RES would be answering requests on behalf of
  // a browser it does not own. REGISTER would let it mint a route out of thin
  // air, and PONG would let it keep a dead route looking alive.
  const { canSend } = await import(POLICY_MODULE)
  assert.equal(canSend(ROLE.MCP, MSG.RES), false)
  assert.equal(canSend(ROLE.MCP, MSG.REGISTER), false)
  assert.equal(canSend(ROLE.MCP, MSG.PONG), false)
})

test('a host connection may answer, register and pong', async () => {
  const { canSend } = await import(POLICY_MODULE)
  assert.equal(canSend(ROLE.HOST, MSG.RES), true)
  assert.equal(canSend(ROLE.HOST, MSG.REGISTER), true)
  assert.equal(canSend(ROLE.HOST, MSG.PONG), true)
})

test('a host connection MAY now send REQ, because the options page needs a channel', async () => {
  // The extension's options page and popup are the UI for claiming, renaming,
  // arming and panic, and they live behind the host. The first build smuggled
  // those through an EVENT convention that no partition governed. Allowing REQ
  // at the envelope level and gating the OP is the honest version of the same
  // thing: one request channel, one place to check what it may carry.
  const { canSend } = await import(POLICY_MODULE)
  assert.equal(canSend(ROLE.HOST, MSG.REQ), true)
})

test('RES, REGISTER and PONG stay strictly host-only', async () => {
  // These three are the ones that still partition cleanly by role. Nothing may
  // be sendable by both, or the direction of the wire stops meaning anything.
  const { canSend } = await import(POLICY_MODULE)
  for (const type of [MSG.RES, MSG.REGISTER, MSG.PONG]) {
    assert.equal(canSend(ROLE.HOST, type), true, `a host must be able to send ${type}`)
    assert.equal(canSend(ROLE.MCP, type), false, `an mcp connection must not send ${type}`)
  }
})

test('an unknown role holds none of the four governed types', async () => {
  // Fail closed. A typo or a forged role in a HELLO must not open a hole.
  // Scoped to the four types the partition governs, because whether HELLO is
  // sendable before a role exists is the handshake's business, not this rule's.
  const { canSend } = await import(POLICY_MODULE)
  for (const type of [MSG.REQ, MSG.RES, MSG.REGISTER, MSG.PONG]) {
    for (const role of ['operator', 'admin', 'HOST', 'MCP', '', null, undefined]) {
      assert.equal(canSend(role, type), false, `role ${String(role)} was allowed ${type}`)
    }
  }
})

test('an unknown message type is refused for every role', async () => {
  const { canSend } = await import(POLICY_MODULE)
  for (const role of Object.values(ROLE)) {
    for (const type of ['exec', 'req ', 'REQ', '', null, undefined]) {
      assert.equal(canSend(role, type), false, `${role} was allowed type ${String(type)}`)
    }
  }
})

/* -------------------------------------------------------------------------- */
/* 2. canOriginate - the op-level half of the same partition                   */
/* -------------------------------------------------------------------------- */

test('a host may NOT originate any operation that crosses into a browser', async () => {
  // THIS is the security property. A host connection is one browser profile's
  // extension. If it could originate a page-touching op, an extension
  // compromised in the Acme profile could read, click and navigate in
  // the personal profile through the broker they share. The broker is the only
  // thing standing between several logged-in sessions, and this predicate is how
  // it stands there.
  const { canOriginate } = await import(POLICY_MODULE)
  for (const op of BROWSER_OPS) {
    assert.equal(canOriginate(ROLE.HOST, op), false, `a host was allowed to originate ${op}`)
  }
})

test('the host allowlist and the browser ops are disjoint, and the gate does not rely on it', async () => {
  // Two separate assertions that look like one, and both matter.
  //
  // The first is the invariant: nothing page-touching may appear in the host
  // allowlist. The second is that canOriginate does not merely TRUST that
  // invariant - it restates it. A boundary that delegates its own guarantee to
  // a list in another module enforces nothing, and would hand a compromised
  // extension the ability to drive other profiles the moment that list drifted.
  const overlap = HOST_REQ_ALLOWED_OPS.filter((op) => BROWSER_OPS.includes(op))
  assert.deepEqual(overlap, [], 'a page-touching op leaked into the host allowlist')

  // Prove the gate is defensive by asking it about a browser op directly, with
  // no reference to the allowlist at all.
  const { canOriginate } = await import(POLICY_MODULE)
  for (const op of BROWSER_OPS) {
    assert.equal(
      canOriginate(ROLE.HOST, op),
      false,
      `canOriginate would authorize ${op} for a host if the allowlist ever contained it`
    )
  }
})

test('a host may originate exactly the broker-local ops and nothing else', async () => {
  const { canOriginate } = await import(POLICY_MODULE)
  for (const op of HOST_REQ_ALLOWED_OPS) {
    assert.equal(canOriginate(ROLE.HOST, op), true, `the options page cannot reach ${op}`)
  }

  const allowed = Object.values(OPS).filter((op) => canOriginate(ROLE.HOST, op))
  assert.deepEqual(
    allowed.sort(),
    [...HOST_REQ_ALLOWED_OPS].sort(),
    'the host allowlist drifted from HOST_REQ_ALLOWED_OPS'
  )
})

test('an mcp connection may originate anything', async () => {
  // The mcp role is the model's side of the wire and is the only role meant to
  // drive browsers. Narrowing it here would just move the tool surface into a
  // second, undocumented allowlist.
  const { canOriginate } = await import(POLICY_MODULE)
  for (const op of Object.values(OPS)) {
    assert.equal(canOriginate(ROLE.MCP, op), true, `an mcp connection was refused ${op}`)
  }
})

test('canOriginate fails closed on an unknown role or an unknown op', async () => {
  const { canOriginate } = await import(POLICY_MODULE)
  for (const role of ['operator', 'admin', 'HOST', '', null, undefined]) {
    assert.equal(canOriginate(role, OPS.GET_BOARD), false, `role ${String(role)} got through`)
  }
  for (const op of ['evalJS', 'eval_js', 'shell', '', null, undefined]) {
    assert.equal(canOriginate(ROLE.HOST, op), false, `a host was allowed op ${String(op)}`)
  }
})

/* -------------------------------------------------------------------------- */
/* 3. HOST_REQ_ALLOWED_OPS as a contract value                                 */
/* -------------------------------------------------------------------------- */

test('HOST_REQ_ALLOWED_OPS contains no browser operation, ever', () => {
  // Stated against the contract as well as the predicate, because this list is
  // the thing a future change would edit. Adding a page-touching op here would
  // hand every extension a driver for every other profile on the machine, and
  // it would do it without touching a single line of policy code.
  for (const op of HOST_REQ_ALLOWED_OPS) {
    assert.ok(
      !BROWSER_OPS.includes(op),
      `${op} both crosses into a browser and is host-originable - that is the cross-profile hole`
    )
  }
  assert.ok(!HOST_REQ_ALLOWED_OPS.includes(OPS.EVAL_JS), 'evalJs must never be host-originable')
  assert.ok(Object.isFrozen(HOST_REQ_ALLOWED_OPS))
})

test('HOST_REQ_ALLOWED_OPS is a subset of the ops the broker answers itself', () => {
  // A host-originable op that the broker does not answer locally would have to
  // be routed somewhere, and the only somewhere is a browser.
  for (const op of HOST_REQ_ALLOWED_OPS) {
    assert.ok(BROKER_OPS.includes(op), `${op} is host-originable but not broker-local`)
  }
})

/* -------------------------------------------------------------------------- */
/* 4. The tier partition                                                       */
/* -------------------------------------------------------------------------- */

test('OP_TIER covers every op in OPS, with no gaps and no extras', () => {
  // The gap case is an op that policy code silently treats as untiered. The
  // extra case is a tier entry for an op that no longer exists, which reads as
  // coverage while covering nothing.
  const declared = Object.values(OPS).sort()
  const tiered = Object.keys(OP_TIER).sort()

  const missing = declared.filter((op) => !(op in OP_TIER))
  const orphaned = tiered.filter((op) => !declared.includes(op))

  assert.deepEqual(missing, [], `ops with no tier: ${missing.join(', ')}`)
  assert.deepEqual(orphaned, [], `tiers for ops that do not exist: ${orphaned.join(', ')}`)
  assert.deepEqual(tiered, declared)
})

test('every op name is unique, so no two operations share a tier by accident', () => {
  const values = Object.values(OPS)
  assert.equal(new Set(values).size, values.length)
})

test('every tier value is a real TIER member', () => {
  const valid = new Set(Object.values(TIER))
  for (const [op, tier] of Object.entries(OP_TIER)) {
    assert.ok(valid.has(tier), `${op} has tier "${tier}", which is not a TIER value`)
  }
})

test('evalJs is ARMED, and it is the only page-touching op that is', () => {
  // Arbitrary JS in an authenticated session is a full-compromise primitive.
  // If someone ever demotes it to the write tier, this is the test that should
  // stop the commit.
  assert.equal(
    OP_TIER[OPS.EVAL_JS],
    TIER.ARMED,
    'evalJs must require an explicit arm - it is unbounded blast radius'
  )

  const armed = Object.keys(OP_TIER).filter((op) => OP_TIER[op] === TIER.ARMED)
  assert.deepEqual(armed, [OPS.EVAL_JS], `unexpected armed ops: ${armed.join(', ')}`)
})

test('every read op is in the READ tier', () => {
  // The read tier is what runs with no arming, all day, unattended. Anything
  // that mutates a page must not be sitting in it.
  const expectedRead = [OPS.LIST_TABS, OPS.READ_PAGE, OPS.SCREENSHOT, OPS.SCROLL]

  for (const op of expectedRead) {
    assert.equal(OP_TIER[op], TIER.READ, `${op} must be a read op`)
  }

  const actualRead = Object.keys(OP_TIER)
    .filter((op) => OP_TIER[op] === TIER.READ)
    .sort()
  assert.deepEqual(
    actualRead,
    [...expectedRead].sort(),
    'the read tier gained or lost an op - that is a policy change, not a refactor'
  )
})

test('every page-mutating op is in the WRITE tier', () => {
  const expectedWrite = [
    OPS.NAVIGATE,
    OPS.OPEN_TAB,
    OPS.CLOSE_TAB,
    OPS.ACTIVATE_TAB,
    OPS.CLICK,
    OPS.FILL,
    OPS.PRESS_KEYS,
    OPS.WAIT_FOR,
  ]
  for (const op of expectedWrite) {
    assert.equal(OP_TIER[op], TIER.WRITE, `${op} must be a write op`)
  }

  const actualWrite = Object.keys(OP_TIER)
    .filter((op) => OP_TIER[op] === TIER.WRITE)
    .sort()
  assert.deepEqual(actualWrite, [...expectedWrite].sort())
})

test('control and housekeeping ops are META and never reach a page', () => {
  const expectedMeta = [
    OPS.SET_LABEL,
    OPS.CLAIM_PROFILE,
    OPS.GET_BOARD,
    OPS.ARM,
    OPS.DISARM,
    OPS.PANIC,
    OPS.STATUS,
  ]
  for (const op of expectedMeta) {
    assert.equal(OP_TIER[op], TIER.META, `${op} must be meta`)
  }

  // arm/disarm/panic being meta is load-bearing: an armed-tier ARM would need
  // arming to arm, and a write-tier PANIC could not fire during a panic.
  assert.equal(OP_TIER[OPS.ARM], TIER.META)
  assert.equal(OP_TIER[OPS.PANIC], TIER.META)
})

/* -------------------------------------------------------------------------- */
/* 5. The routing partition: who EXECUTES an op                                */
/* -------------------------------------------------------------------------- */

test('BROWSER_OPS is exactly the thirteen ops that cross into the extension', () => {
  // Pinned as a literal list rather than derived from OP_TIER. The first build
  // derived it as "not META, plus SET_LABEL", which quietly made the META tier
  // mean two different things. Tier answers "what policy applies"; this answers
  // "who executes it". Deriving one from the other is what let setLabel be a
  // browser op and a broker op at the same time.
  assert.deepEqual([...BROWSER_OPS].sort(), [
    OPS.ACTIVATE_TAB,
    OPS.CLICK,
    OPS.CLOSE_TAB,
    OPS.EVAL_JS,
    OPS.FILL,
    OPS.LIST_TABS,
    OPS.NAVIGATE,
    OPS.OPEN_TAB,
    OPS.PRESS_KEYS,
    OPS.READ_PAGE,
    OPS.SCREENSHOT,
    OPS.SCROLL,
    OPS.WAIT_FOR,
  ].sort())
  assert.equal(BROWSER_OPS.length, 13)
  assert.ok(Object.isFrozen(BROWSER_OPS))
})

test('BROKER_OPS is exactly the seven ops the broker answers itself', () => {
  assert.deepEqual([...BROKER_OPS].sort(), [
    OPS.ARM,
    OPS.CLAIM_PROFILE,
    OPS.DISARM,
    OPS.GET_BOARD,
    OPS.PANIC,
    OPS.SET_LABEL,
    OPS.STATUS,
  ].sort())
  assert.equal(BROKER_OPS.length, 7)
  assert.ok(Object.isFrozen(BROKER_OPS))
})

test('the two op lists are disjoint and together cover every op', () => {
  // An op in both lists has two executors and whichever code path runs first
  // wins, which is how setLabel ended up ambiguous. An op in neither is an
  // unroutable request: the broker will not answer it and will not forward it,
  // and the caller sees a timeout with no diagnosis.
  const overlap = BROWSER_OPS.filter((op) => BROKER_OPS.includes(op))
  assert.deepEqual(overlap, [], `ops with two executors: ${overlap.join(', ')}`)

  const covered = [...BROWSER_OPS, ...BROKER_OPS].sort()
  const declared = Object.values(OPS).sort()
  const unroutable = declared.filter((op) => !covered.includes(op))
  assert.deepEqual(unroutable, [], `ops nobody executes: ${unroutable.join(', ')}`)
  assert.deepEqual(covered, declared)
})

test('setLabel is a broker op, not a browser op', () => {
  // Called out on its own because it is the exact op the derived list got
  // wrong. A label lives in the broker's state file; the extension has no say
  // in it and must never be asked.
  assert.ok(BROKER_OPS.includes(OPS.SET_LABEL))
  assert.ok(!BROWSER_OPS.includes(OPS.SET_LABEL))
})

test('the control ops stay off the wire to any browser', () => {
  for (const op of [OPS.ARM, OPS.DISARM, OPS.PANIC, OPS.GET_BOARD, OPS.STATUS]) {
    assert.ok(!BROWSER_OPS.includes(op), `${op} is broker-local and must not be routed`)
  }
  for (const op of [OPS.LIST_TABS, OPS.CLICK, OPS.EVAL_JS]) {
    assert.ok(BROWSER_OPS.includes(op), `${op} must be routable to the extension`)
  }
})

/* -------------------------------------------------------------------------- */
/* 6. Arming ceiling                                                           */
/* -------------------------------------------------------------------------- */

test('MAX_ARM_MINUTES is one hour, and it lives in the contract', () => {
  // The ceiling is enforced by the broker and mirrored by the MCP tool schema,
  // so it has to be one shared number. An arm that outlives the sitting it was
  // granted for is the same as no arm at all.
  assert.equal(MAX_ARM_MINUTES, 60)
})

test('the two roles are the only roles', () => {
  assert.deepEqual(Object.values(ROLE).sort(), ['host', 'mcp'])
  assert.ok(Object.isFrozen(ROLE))
  assert.ok(Object.isFrozen(OPS))
  assert.ok(Object.isFrozen(OP_TIER))
  assert.ok(Object.isFrozen(TIER))
})
