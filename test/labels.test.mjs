/**
 * Profile label derivation tests.
 *
 * A label is how a human and a model both address a browser profile, so the one
 * property that cannot bend is uniqueness. Two identities sharing a label means
 * a Acme session and a personal session are one keystroke apart, which
 * is the worst failure this system can produce.
 *
 * Everything here runs on FIXTURES. Reading the live machine would make the
 * suite pass or fail based on which browsers happen to be installed on it, and
 * would quietly stop testing anything the day the operator renames a profile.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { consumerMailDomains, deriveLabel, slugify, readProfiles } from '../shared/paths.mjs'

// Consumer-mail fixtures name the provider only and build the address at run
// time, so the test data holds no deliverable address at a real mail provider.
const MAIL = 'gmail.com'
const MAIL_B = 'outlook.com'

/** A profile in the shape readProfiles() emits, with everything absent by default. */
function profile(overrides = {}) {
  return {
    dir: 'Default',
    name: '',
    email: null,
    gaiaName: null,
    hostedDomain: null,
    active: 0,
    ...overrides,
  }
}

/* -------------------------------------------------------------------------- */
/* The precedence rules                                                        */
/* -------------------------------------------------------------------------- */

test('a custom domain wins over the email local part', () => {
  // The rule that exists specifically for the operator: a naive local-part slug turns
  // alice@acme-corp.example into "alice", one keystroke from their personal profiles.
  const label = deriveLabel(
    'chrome',
    profile({
      dir: 'Profile 1',
      name: 'acme-corp.example',
      email: 'alice@acme-corp.example',
      hostedDomain: 'acme-corp.example',
    })
  )
  assert.equal(label, 'chrome-acme-corp')
  assert.notEqual(label, 'chrome-alice')
})

test('the custom domain still wins when it is only visible in the email', () => {
  // Chrome does not always populate hosted_domain. The email path must reach
  // the same answer, or the same identity would get two different labels
  // depending on which fields Local State happened to carry.
  assert.equal(
    deriveLabel('chrome', profile({ email: 'alice@acme-corp.example' })),
    'chrome-acme-corp'
  )
})

test('the consumer providers the fixtures use are ones the label rule lists', () => {
  // Pinned here so a trimmed or reordered provider list fails a test instead of
  // silently relabeling every profile signed in at that provider.
  assert.ok(consumerMailDomains().includes(MAIL), `${MAIL} is a consumer domain`)
  assert.ok(consumerMailDomains().includes(MAIL_B), `${MAIL_B} is a consumer domain`)
  assert.equal(
    deriveLabel('chrome', profile({ name: 'Out', email: `alice.example@${MAIL_B}` })),
    'chrome-alice-example'
  )
})

test('consumerMailDomains hands out a copy, so a caller cannot change the rule', () => {
  const before = consumerMailDomains()
  const handed = consumerMailDomains()
  handed.push('x.example')
  handed[0] = 'y.example'
  handed.length = 1
  assert.deepEqual(consumerMailDomains(), before)
  assert.ok(Array.isArray(before) && before.length > 1, 'an array of every provider')
  assert.equal(
    deriveLabel('chrome', profile({ name: 'Alice', email: `alice.example@${MAIL}` })),
    'chrome-alice-example'
  )
})

test('a consumer mailbox domain falls through to the local part', () => {
  // A consumer mail domain says nothing about who the user is, so the mailbox name is the
  // only identifying part left.
  assert.equal(
    deriveLabel('chrome', profile({ name: 'Alice', email: `alice.example@${MAIL}` })),
    'chrome-alice-example'
  )
  assert.equal(
    deriveLabel('chrome', profile({ name: 'Side', email: `sideproject7777@${MAIL}` })),
    'chrome-sideproject7777'
  )
})

test('a short domain head keeps the next label rather than standing alone', () => {
  // "ada" reads like a person and could be any of three profiles. "ada-example"
  // names exactly one.
  assert.equal(deriveLabel('brave', profile({ name: 'hello@ada.example' })), 'brave-ada-example')
})

test('a long domain head does not drag the TLD along', () => {
  assert.equal(
    deriveLabel('chrome', profile({ hostedDomain: 'acme-corp.example' })),
    'chrome-acme-corp'
  )
})

test('Brave: no email anywhere, but the profile NAME is an address', () => {
  // Brave's info_cache carries no Google identity at all, so name-as-email is
  // the branch that gives Brave the same label quality Chrome gets for free.
  const braveProfile = profile({ dir: 'Profile 1', name: 'alice@acme-corp.example' })
  assert.equal(braveProfile.email, null)
  assert.equal(braveProfile.hostedDomain, null)
  assert.equal(deriveLabel('brave', braveProfile), 'brave-acme-corp')
})

test('a profile with no usable signal still gets a stable label, never an empty one', () => {
  assert.equal(deriveLabel('chrome', profile({ dir: '', name: '' })), 'chrome-profile')
  assert.equal(deriveLabel('brave', profile({ dir: 'Profile 7', name: '' })), 'brave-profile-7')
})

test('the vendor is always the prefix, so labels sort and read by browser', () => {
  const p = profile({ name: 'hello@ada.example' })
  assert.ok(deriveLabel('brave', p).startsWith('brave-'))
  assert.ok(deriveLabel('chrome', p).startsWith('chrome-'))
  assert.notEqual(deriveLabel('brave', p), deriveLabel('chrome', p))
})

/* -------------------------------------------------------------------------- */
/* The regression that matters most                                            */
/* -------------------------------------------------------------------------- */

/** Six realistic profile shapes, three per browser. */
const REAL_PROFILES = [
  ['brave', profile({ dir: 'Default', name: `alice.example@${MAIL}` })],
  ['brave', profile({ dir: 'Profile 1', name: 'alice@acme-corp.example' })],
  ['brave', profile({ dir: 'Profile 2', name: 'hello@ada.example' })],
  ['chrome', profile({ dir: 'Default', name: 'Alice', email: `alice.example@${MAIL}` })],
  [
    'chrome',
    profile({
      dir: 'Profile 1',
      name: 'acme-corp.example',
      email: 'alice@acme-corp.example',
      hostedDomain: 'acme-corp.example',
    }),
  ],
  [
    'chrome',
    profile({ dir: 'Profile 2', name: 'Side', email: `sideproject7777@${MAIL}` }),
  ],
]

test('the six real profiles produce six distinct labels', () => {
  const labels = REAL_PROFILES.map(([vendor, p]) => deriveLabel(vendor, p))

  assert.equal(labels.length, 6)
  assert.equal(new Set(labels).size, 6, `collision in: ${labels.join(', ')}`)

  // Pinned, not just counted. A change that keeps six labels distinct while
  // silently renaming the operator's Acme profile is still a change they needs
  // to see, because the label is what every tool call says out loud.
  assert.deepEqual(labels, [
    'brave-alice-example',
    'brave-acme-corp',
    'brave-ada-example',
    'chrome-alice-example',
    'chrome-acme-corp',
    'chrome-sideproject7777',
  ])
})

/* -------------------------------------------------------------------------- */
/* Edge: the profile whose NAME is another profile's DIRECTORY                 */
/* -------------------------------------------------------------------------- */

/**
 * Read from a real Edge `Local State`: one profile, whose
 * directory is `Default` and whose `info_cache` name is the string
 * `Profile 1`, signed in as the consumer mailbox alice.example.
 *
 * This is not a curiosity. It is the counterexample that proves the route key
 * must be the (vendor, directory) pair and never the profile NAME.
 */
const EDGE_DEFAULT = profile({
  dir: 'Default',
  name: 'Profile 1',
  email: `alice.example@${MAIL}`,
})

test('Edge: a profile NAMED "Profile 1" that lives in the "Default" directory', () => {
  // A registry keyed on the display name would file this under "Profile 1",
  // which is a real DIRECTORY name for both Chrome and Brave on the reference machine.
  // The collision would be silent and it would resolve to whichever profile
  // registered last - meaning a tool call aimed at the operator's Acme Chrome
  // profile could land in Edge, or the reverse. The name is a human string the
  // user can edit at will; the directory is the identity.
  assert.equal(EDGE_DEFAULT.dir, 'Default')
  assert.equal(EDGE_DEFAULT.name, 'Profile 1')

  const nameKey = EDGE_DEFAULT.name
  const chromeBaDir = 'Profile 1' // Chrome's Acme profile directory
  assert.equal(nameKey, chromeBaDir, 'this is the collision, spelled out')

  // The pair is unique where the name is not.
  assert.notDeepEqual(['edge', EDGE_DEFAULT.dir], ['chrome', chromeBaDir])
})

test('the Edge profile gets a label from its identity, not from its directory or name', () => {
  // A consumer mail domain says nothing about who the user is, so the mailbox local part is
  // what identifies this profile - the same rule Chrome's Default profile
  // follows. The vendor prefix is what keeps the two apart.
  assert.equal(deriveLabel('edge', EDGE_DEFAULT), 'edge-alice-example')
  assert.ok(!deriveLabel('edge', EDGE_DEFAULT).includes('profile-1'), 'the name must not leak in')
  assert.ok(!deriveLabel('edge', EDGE_DEFAULT).includes('default'), 'the directory must not leak in')
})

test('adding Edge keeps all seven labels distinct', () => {
  // Three profiles in this fixture are signed in as the consumer mailbox alice.example -
  // one per browser - and they all slug to the same identity. Only the vendor
  // prefix separates them, which is why it is not decoration.
  const seven = [...REAL_PROFILES, ['edge', EDGE_DEFAULT]].map(([vendor, p]) =>
    deriveLabel(vendor, p)
  )

  assert.equal(seven.length, 7)
  assert.equal(new Set(seven).size, 7, `collision in: ${seven.join(', ')}`)

  const personal = seven.filter((l) => l.endsWith('-alice-example'))
  assert.deepEqual(personal.sort(), ['brave-alice-example', 'chrome-alice-example', 'edge-alice-example'])
})

test('the two Acme profiles stay distinguishable from the two personal ones', () => {
  // The specific near-miss the domain rule exists to prevent, stated as its own
  // assertion so a regression names the actual risk instead of "set size 5".
  const [bravePersonal, braveAcme] = [
    deriveLabel('brave', profile({ name: `alice.example@${MAIL}` })),
    deriveLabel('brave', profile({ name: 'alice@acme-corp.example' })),
  ]
  assert.notEqual(bravePersonal, braveAcme)
  assert.ok(braveAcme.includes('acme-corp'), 'the Acme profile must be recognizable as Acme')
})

/* -------------------------------------------------------------------------- */
/* slugify                                                                     */
/* -------------------------------------------------------------------------- */

test('slugify produces lowercase kebab and nothing else', () => {
  assert.equal(slugify('Alice Example'), 'alice-example')
  assert.equal(slugify('  Acme   Widgets!!  '), 'acme-widgets')
  assert.equal(slugify('ada.example'), 'ada-example')
  assert.match(slugify('Profile 1'), /^[a-z0-9-]+$/)
})

test('slugify returns null rather than an empty string for nothing usable', () => {
  // deriveLabel branches on falsiness, so an empty string here would be picked
  // up as a valid slug and produce a trailing-hyphen label.
  assert.equal(slugify(''), null)
  assert.equal(slugify(null), null)
  assert.equal(slugify(undefined), null)
  assert.equal(slugify('!!!'), null)
  assert.equal(slugify('   '), null)
})

test('slugify bounds the label length', () => {
  const long = 'a-very-long-profile-name-that-nobody-should-ever-type-but-somebody-will'
  assert.ok(slugify(long).length <= 24)
})

/* -------------------------------------------------------------------------- */
/* readProfiles, against a fixture Local State                                 */
/* -------------------------------------------------------------------------- */

test('readProfiles normalizes the empty strings Brave writes into nulls', async (t) => {
  // This normalization is what makes deriveLabel's name-as-email branch fire at
  // all. Without it every Brave profile has a truthy '' email and lands in the
  // wrong branch, so it is tested against a real file rather than assumed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-labels-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  fs.writeFileSync(
    path.join(dir, 'Local State'),
    JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: `alice.example@${MAIL}`, user_name: '', gaia_name: '', gaia_id: '' },
          'Profile 1': {
            name: 'acme-corp.example',
            user_name: 'alice@acme-corp.example',
            hosted_domain: 'acme-corp.example',
            active_time: 1234,
          },
          'Profile 2': {
            name: 'Alice',
            user_name: `alice.example@${MAIL}`,
            hosted_domain: 'NO_HOSTED_DOMAIN',
          },
        },
      },
    }),
    'utf8'
  )

  const profiles = readProfiles(dir)
  assert.equal(profiles.length, 3)

  const byDir = Object.fromEntries(profiles.map((p) => [p.dir, p]))
  assert.equal(byDir.Default.email, null, "Brave's empty user_name must become null")
  assert.equal(byDir.Default.gaiaName, null)
  assert.equal(byDir['Profile 1'].email, 'alice@acme-corp.example')
  assert.equal(byDir['Profile 1'].hostedDomain, 'acme-corp.example')
  assert.equal(byDir['Profile 1'].active, 1234)
  assert.equal(
    byDir['Profile 2'].hostedDomain,
    null,
    'the NO_HOSTED_DOMAIN sentinel must not become a slug'
  )

  // And the labels those fixtures produce are the ones deriveLabel promises.
  assert.equal(deriveLabel('brave', byDir.Default), 'brave-alice-example')
  assert.equal(deriveLabel('chrome', byDir['Profile 1']), 'chrome-acme-corp')
  assert.equal(deriveLabel('chrome', byDir['Profile 2']), 'chrome-alice-example')
})

test('readProfiles returns an empty array rather than throwing on a missing or bad file', async (t) => {
  // Profile discovery is advisory. A browser that is not installed, or a
  // Local State caught mid-write, must never take the broker down.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-labels-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  assert.deepEqual(readProfiles(dir), [], 'no Local State at all')

  fs.writeFileSync(path.join(dir, 'Local State'), '{ truncated mid-write', 'utf8')
  assert.deepEqual(readProfiles(dir), [], 'unparseable JSON')

  fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({ profile: {} }), 'utf8')
  assert.deepEqual(readProfiles(dir), [], 'no info_cache')
})
