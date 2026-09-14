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

import { deriveLabel, slugify, readProfiles } from '../shared/paths.mjs'

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
  // alice@acme-corp.com into "alice", one keystroke from their personal profiles.
  const label = deriveLabel(
    'chrome',
    profile({
      dir: 'Profile 1',
      name: 'acme-corp.com',
      email: 'alice@acme-corp.com',
      hostedDomain: 'acme-corp.com',
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
    deriveLabel('chrome', profile({ email: 'alice@acme-corp.com' })),
    'chrome-acme-corp'
  )
})

test('a consumer mailbox domain falls through to the local part', () => {
  // gmail.com says nothing about who the user is, so the mailbox name is the
  // only identifying part left.
  assert.equal(
    deriveLabel('chrome', profile({ name: 'Alice', email: 'alice.example@gmail.com' })),
    'chrome-alice-example'
  )
  assert.equal(
    deriveLabel('chrome', profile({ name: 'Internet', email: 'sidegig3333@gmail.com' })),
    'chrome-sidegig3333'
  )
})

test('a short domain head keeps the next label rather than standing alone', () => {
  // "ada" reads like a person and could be any of three profiles. "ada-dev"
  // names exactly one.
  assert.equal(deriveLabel('brave', profile({ name: 'hello@ada.dev' })), 'brave-ada-dev')
})

test('a long domain head does not drag the TLD along', () => {
  assert.equal(
    deriveLabel('chrome', profile({ hostedDomain: 'acme-corp.com' })),
    'chrome-acme-corp'
  )
})

test('Brave: no email anywhere, but the profile NAME is an address', () => {
  // Brave's info_cache carries no Google identity at all, so name-as-email is
  // the branch that gives Brave the same label quality Chrome gets for free.
  const braveProfile = profile({ dir: 'Profile 1', name: 'alice@acme-corp.com' })
  assert.equal(braveProfile.email, null)
  assert.equal(braveProfile.hostedDomain, null)
  assert.equal(deriveLabel('brave', braveProfile), 'brave-acme-corp')
})

test('a profile with no usable signal still gets a stable label, never an empty one', () => {
  assert.equal(deriveLabel('chrome', profile({ dir: '', name: '' })), 'chrome-profile')
  assert.equal(deriveLabel('brave', profile({ dir: 'Profile 7', name: '' })), 'brave-profile-7')
})

test('the vendor is always the prefix, so labels sort and read by browser', () => {
  const p = profile({ name: 'hello@ada.dev' })
  assert.ok(deriveLabel('brave', p).startsWith('brave-'))
  assert.ok(deriveLabel('chrome', p).startsWith('chrome-'))
  assert.notEqual(deriveLabel('brave', p), deriveLabel('chrome', p))
})

/* -------------------------------------------------------------------------- */
/* The regression that matters most                                            */
/* -------------------------------------------------------------------------- */

/** Six realistic profile shapes, three per browser. */
const REAL_PROFILES = [
  ['brave', profile({ dir: 'Default', name: 'alice.example@gmail.com' })],
  ['brave', profile({ dir: 'Profile 1', name: 'alice@acme-corp.com' })],
  ['brave', profile({ dir: 'Profile 2', name: 'hello@ada.dev' })],
  ['chrome', profile({ dir: 'Default', name: 'Alice', email: 'alice.example@gmail.com' })],
  [
    'chrome',
    profile({
      dir: 'Profile 1',
      name: 'acme-corp.com',
      email: 'alice@acme-corp.com',
      hostedDomain: 'acme-corp.com',
    }),
  ],
  [
    'chrome',
    profile({ dir: 'Profile 2', name: 'Internet', email: 'sidegig3333@gmail.com' }),
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
    'brave-ada-dev',
    'chrome-alice-example',
    'chrome-acme-corp',
    'chrome-sidegig3333',
  ])
})

/* -------------------------------------------------------------------------- */
/* Edge: the profile whose NAME is another profile's DIRECTORY                 */
/* -------------------------------------------------------------------------- */

/**
 * Read from a real Edge `Local State`: one profile, whose
 * directory is `Default` and whose `info_cache` name is the string
 * `Profile 1`, signed in as alice.example@gmail.com.
 *
 * This is not a curiosity. It is the counterexample that proves the route key
 * must be the (vendor, directory) pair and never the profile NAME.
 */
const EDGE_DEFAULT = profile({
  dir: 'Default',
  name: 'Profile 1',
  email: 'alice.example@gmail.com',
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
  // gmail.com says nothing about who the user is, so the mailbox local part is
  // what identifies this profile - the same rule Chrome's Default profile
  // follows. The vendor prefix is what keeps the two apart.
  assert.equal(deriveLabel('edge', EDGE_DEFAULT), 'edge-alice-example')
  assert.ok(!deriveLabel('edge', EDGE_DEFAULT).includes('profile-1'), 'the name must not leak in')
  assert.ok(!deriveLabel('edge', EDGE_DEFAULT).includes('default'), 'the directory must not leak in')
})

test('adding Edge keeps all seven labels distinct', () => {
  // Three profiles in this fixture are signed in as alice.example@gmail.com -
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
  const [bravePersonal, braveBa] = [
    deriveLabel('brave', profile({ name: 'alice.example@gmail.com' })),
    deriveLabel('brave', profile({ name: 'alice@acme-corp.com' })),
  ]
  assert.notEqual(bravePersonal, braveBa)
  assert.ok(braveBa.includes('acme-corp'), 'the BA profile must be recognizable as BA')
})

/* -------------------------------------------------------------------------- */
/* slugify                                                                     */
/* -------------------------------------------------------------------------- */

test('slugify produces lowercase kebab and nothing else', () => {
  assert.equal(slugify('Alice Example'), 'alice-example')
  assert.equal(slugify('  Brand   Alchemy!!  '), 'brand-alchemy')
  assert.equal(slugify('ada.dev'), 'ada-dev')
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
          Default: { name: 'alice.example@gmail.com', user_name: '', gaia_name: '', gaia_id: '' },
          'Profile 1': {
            name: 'acme-corp.com',
            user_name: 'alice@acme-corp.com',
            hosted_domain: 'acme-corp.com',
            active_time: 1234,
          },
          'Profile 2': {
            name: 'Alice',
            user_name: 'alice.example@gmail.com',
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
  assert.equal(byDir['Profile 1'].email, 'alice@acme-corp.com')
  assert.equal(byDir['Profile 1'].hostedDomain, 'acme-corp.com')
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
