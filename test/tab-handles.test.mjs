/**
 * Opaque tab handle tests.
 *
 * Chrome tab ids are per-profile integers that collide freely across
 * profiles, so a raw id from one profile would find a real, valid, completely
 * wrong tab in another. The handle format exists to make that structurally
 * impossible: the profile label and the browser-session generation travel
 * inside the handle, and the broker rejects any mismatch.
 *
 * The parser is a single regex with a greedy first group, so the cases worth
 * testing are the ones where the label itself looks like part of the suffix.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { mintTabHandle, parseTabHandle } from '../shared/protocol.mjs'

/** Realistic labels, plus the collision form. */
const REAL_LABELS = [
  'brave-alice-example',
  'brave-acme-corp',
  'brave-ada-dev',
  'chrome-alice-example',
  'chrome-acme-corp',
  'chrome-sidegig3333',
]

test('mint and parse round-trip for every real label', () => {
  for (const label of REAL_LABELS) {
    const handle = mintTabHandle(label, 3, 1_874_302_991)
    assert.equal(handle, `tab_${label}_3_1874302991`)

    const parsed = parseTabHandle(handle)
    assert.deepEqual(parsed, { profileLabel: label, generation: 3, tabId: 1_874_302_991 })
    assert.equal(typeof parsed.generation, 'number')
    assert.equal(typeof parsed.tabId, 'number')
  }
})

test('a label ending in digits still parses back correctly', () => {
  // chrome-sidegig3333 is the trap: a greedy first group could swallow
  // the generation, or a lazy one could stop inside the label. Neither may
  // happen, because a mis-split handle addresses a different profile.
  const handle = mintTabHandle('chrome-sidegig3333', 12, 7)
  assert.deepEqual(parseTabHandle(handle), {
    profileLabel: 'chrome-sidegig3333',
    generation: 12,
    tabId: 7,
  })
})

test('labels containing hyphens survive intact', () => {
  const parsed = parseTabHandle(mintTabHandle('brave-ada-dev', 1, 42))
  assert.equal(parsed.profileLabel, 'brave-ada-dev')
})

test('a collision-suffixed label round-trips', () => {
  // The broker hands the second claimant of a label `label#2`, so that form has
  // to survive the handle codec or the losing profile becomes unaddressable.
  const parsed = parseTabHandle(mintTabHandle('chrome-acme-corp#2', 4, 9))
  assert.deepEqual(parsed, { profileLabel: 'chrome-acme-corp#2', generation: 4, tabId: 9 })
})

test('a handle from one profile is detectably not for another', () => {
  // This is the check the broker performs on every page-touching call. The
  // handle carries the answer, so no lookup and no ambient state is involved.
  const fromBa = mintTabHandle('chrome-acme-corp', 2, 55)
  const fromPersonal = mintTabHandle('chrome-alice-example', 2, 55)

  assert.notEqual(fromBa, fromPersonal, 'the same tab id in two profiles must differ')
  assert.equal(parseTabHandle(fromBa).profileLabel, 'chrome-acme-corp')
  assert.notEqual(parseTabHandle(fromBa).profileLabel, 'chrome-alice-example')

  // The same integer id is legitimately live in both profiles at once, which is
  // exactly why the raw id can never be the handle.
  assert.equal(parseTabHandle(fromBa).tabId, parseTabHandle(fromPersonal).tabId)
})

test('a stale generation is detectable', () => {
  // A browser restart increments the generation, which invalidates every
  // outstanding handle by construction rather than by bookkeeping.
  const beforeRestart = mintTabHandle('brave-acme-corp', 7, 31)
  const currentGeneration = 8

  const parsed = parseTabHandle(beforeRestart)
  assert.equal(parsed.generation, 7)
  assert.notEqual(parsed.generation, currentGeneration)
  assert.ok(parsed.generation < currentGeneration, 'a stale handle is strictly older')
})

test('generation and tabId come back as numbers, not strings', () => {
  // A string generation would compare equal to nothing and silently fail every
  // freshness check, or compare unequal forever and fail every call.
  const parsed = parseTabHandle('tab_chrome-acme-corp_0_0')
  assert.strictEqual(parsed.generation, 0)
  assert.strictEqual(parsed.tabId, 0)
})

test('parseTabHandle returns null on garbage, never a partial object', () => {
  // Callers branch on null. A half-parsed object would let a request through
  // with an undefined profile, which is the wrong-browser failure.
  const garbage = [
    '',
    'tab',
    'tab_',
    'tab_label',
    'tab_label_1',
    'tab_label_1_',
    'tab__1_2',
    'tab_label_x_2',
    'tab_label_1_x',
    'tab_label_-1_2',
    'tab_label_1.5_2',
    'TAB_label_1_2',
    'xtab_label_1_2',
    ' tab_label_1_2',
    'tab_label_1_2 ',
    'tab_label_1_2\n',
    'handle_label_1_2',
    null,
    undefined,
    42,
    {},
    [],
    ['tab_label_1_2'],
    Symbol('tab_label_1_2').toString(),
    Object.create(null),
  ]

  for (const input of garbage) {
    assert.equal(parseTabHandle(input), null, `expected null for ${JSON.stringify(input) ?? input}`)
  }
})

test('a handle that survives a JSON round-trip still parses', () => {
  // Handles cross three hops as JSON strings. Nothing in the format may depend
  // on a character JSON would escape or normalize.
  const handle = mintTabHandle('chrome-acme-corp', 2, 991)
  const shipped = JSON.parse(JSON.stringify({ tab: handle })).tab
  assert.equal(shipped, handle)
  assert.deepEqual(parseTabHandle(shipped), parseTabHandle(handle))
})
