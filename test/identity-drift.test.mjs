/**
 * Identity drift: is this still the same person?
 *
 * A claim is keyed by profile DIRECTORY, and a directory does not change when
 * the Google account inside it does. So without these checks, the operator signing their
 * Acme Chrome profile into their personal mailbox leaves a line still
 * labeled `chrome-acme-corp`, still claimed, still armed, and the next tool
 * call posts as the wrong person. That is the worst failure this system can
 * produce and it is the only one that is not recoverable.
 *
 * The other half of the job is just as important and much easier to get wrong:
 * NOT crying wolf. operators start browsers every morning, and Chromium writes a stub
 * `Local State` seconds before it flushes the real profile cache. A check that
 * unclaims their working profiles on a cold start is a check they turn off.
 *
 * Everything here runs on FIXTURES written to a temp directory. Reading the live
 * machine would make the suite pass or fail based on which browsers happen to be
 * open, which is the opposite of a regression test.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ProfileStore,
  SOURCE_IDENTITY_CHANGED,
  applyClaim,
  candidatesFor,
  defaultLabelFor,
  describeFingerprint,
  driftDisplayAccount,
  fingerprintKind,
  identityChangedWarning,
  identityDrift,
  identityFingerprint,
  resolveIdentity,
} from '../bridged/profiles.mjs'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** Two realistic profiles, shaped as `info_cache` holds them. */
const CHROME_WORK = {
  name: 'acme-corp.com',
  user_name: 'alice@acme-corp.com',
  gaia_id: '100000000000000000001',
  hosted_domain: 'acme-corp.com',
}
const CHROME_PERSONAL = {
  name: 'Alice',
  user_name: 'alice.example@gmail.com',
  gaia_id: '100000000000000000002',
  hosted_domain: 'NO_HOSTED_DOMAIN',
}
/** Brave writes no Google identity at all. Verified on every Brave profile of the operator's. */
const BRAVE_PERSONAL = { name: 'alice.example@gmail.com', user_name: '', gaia_id: '' }
/**
 * A Chrome row carrying an address but NO account id.
 *
 * This is the shape the live-versus-disk email detector exists for. With an
 * account id present on both sides that id decides the question outright and
 * the address is not consulted, so a fixture that carries one cannot exercise
 * the detector at all - see the gaia-precedence test below.
 */
const CHROME_WORK_NO_GAIA = {
  name: 'acme-corp.com',
  user_name: 'alice@acme-corp.com',
  gaia_id: '',
  hosted_domain: 'acme-corp.com',
}

/** A scratch user-data-dir holding one fixture `Local State`. */
function userDataDir(t, infoCache) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-identity-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  writeLocalState(dir, infoCache)
  return dir
}

function writeLocalState(dir, infoCache) {
  fs.writeFileSync(
    path.join(dir, 'Local State'),
    JSON.stringify({ profile: { info_cache: infoCache } }),
    'utf8'
  )
}

function storeIn(dir) {
  return new ProfileStore({ file: path.join(dir, 'state.json') })
}

/**
 * Drive resolveIdentity the way handleRegister does.
 *
 * `browserProcess` is passed explicitly, which does two things: it skips the
 * PowerShell ancestry walk, and it pins the user-data-dir to the fixture. That
 * pin is what keeps candidatesFor() off this machine's real browsers.
 */
function register({ store, dir, installId = 'inst-1', vendor = 'chrome', email = null }) {
  return resolveIdentity({
    installId,
    pid: 0,
    vendorHint: vendor,
    email,
    store,
    browserProcess: { vendor, exe: '', userDataDir: dir },
  })
}

/** Claim a directory exactly as the broker's claimProfile does. */
function claim({
  store,
  dir,
  installId = 'inst-1',
  vendor = 'chrome',
  profileDir,
  label = 'chrome-acme-corp',
}) {
  const full = candidatesFor(vendor, dir)
  const patch = applyClaim({ candidatesFull: full, vendor, userDataDir: dir, dir: profileDir })
  assert.ok(patch, `applyClaim should accept ${profileDir}`)
  store.remember(installId, {
    vendor,
    userDataDir: dir,
    profileDir: patch.profileDir,
    profileName: patch.profileName,
    email: patch.email,
    claimed: true,
    identityFingerprint: patch.identityFingerprint,
    claimedAt: patch.claimedAt,
    label,
    desiredLabel: label,
    labelIsCustom: false,
  })
  return patch
}

/**
 * The inputs the broker's heartbeat re-check builds, mirrored exactly.
 *
 * The broker's own recheckIdentity cannot be imported: it lives in the module
 * that binds the named pipe on import. What CAN be pinned is the thing that
 * makes it right or wrong - the arguments it hands identityDrift, and
 * `liveIsFresh: false` most of all, because on this path the disk row is the
 * fresher of the two readings and the reported address is whatever the
 * extension said at the last REGISTER.
 */
function heartbeat({ store, dir, installId = 'inst-1', vendor = 'chrome', profileDir, reportedEmail = null }) {
  const saved = store.get(installId)
  const rows = candidatesFor(vendor, dir)
  return identityDrift({
    savedFingerprint: saved?.identityFingerprint || null,
    row: rows.find((c) => c.dir === profileDir) || null,
    reportedEmail,
    liveIsFresh: false,
  })
}

/**
 * The label handleRegister lands on, mirrored.
 *
 * A claim honored while nothing could be corroborated keeps the name it already
 * had; anything else derives one from the identity. Same reason as above: the
 * broker function cannot be imported, but the RULE can be pinned, and it is the
 * rule that decides whether a browser start renames a line.
 */
function labelFor(identity, saved) {
  const persisted = saved?.desiredLabel || saved?.label || null
  return identity.identityUnverified && persisted ? persisted : defaultLabelFor(identity)
}

/* -------------------------------------------------------------------------- */
/* The fingerprint itself                                                      */
/* -------------------------------------------------------------------------- */

test('the gaia id wins over every other signal, because a human cannot type it', () => {
  // A profile NAME is cosmetic and user-set, and an email can be renamed by
  // Google. The account id survives both, which is why it is the primary key.
  assert.equal(
    identityFingerprint({
      gaiaId: '100000000000000000001',
      email: 'alice@acme-corp.com',
      profileName: 'acme-corp.com',
    }),
    'gaia:100000000000000000001'
  )
})

test('the email is used when there is no gaia id, from disk or from the extension', () => {
  assert.equal(identityFingerprint({ email: 'Alice@Acme-Corp.com' }), 'email:alice@acme-corp.com')
  assert.equal(
    identityFingerprint({ reportedEmail: 'alice.example@gmail.com' }),
    'email:alice.example@gmail.com'
  )
  // Disk outranks the live report when both are present and this function is
  // asked for one answer. The two DISAGREEING is a separate detector.
  assert.equal(
    identityFingerprint({ email: 'a@example.com', reportedEmail: 'b@example.com' }),
    'email:a@example.com'
  )
})

test("the profile name is Brave's only signal, and it is the last resort", () => {
  assert.equal(
    identityFingerprint({ gaiaId: '', email: '', profileName: 'alice.example@gmail.com' }),
    'name:alice.example@gmail.com'
  )
})

test('NULL means CANNOT CHECK, and empty strings reach it', () => {
  // Brave writes empty strings rather than absent keys, and readProfiles
  // normalizes them, but this function is called from more than one place and
  // must not depend on that having happened.
  assert.equal(identityFingerprint({}), null)
  assert.equal(identityFingerprint({ gaiaId: '', email: '', profileName: '' }), null)
  assert.equal(identityFingerprint({ gaiaId: '   ', profileName: '  ' }), null)
  assert.equal(identityFingerprint(), null)
})

test('a fingerprint reads as a sentence, never as its raw string', () => {
  assert.equal(describeFingerprint('gaia:123'), 'Google account id 123')
  assert.equal(describeFingerprint('email:alice@acme-corp.com'), 'alice@acme-corp.com')
  assert.equal(describeFingerprint('name:work'), 'the profile named "work"')
  assert.equal(fingerprintKind('gaia:123'), 'gaia')
  assert.equal(fingerprintKind(null), null)
})

/* -------------------------------------------------------------------------- */
/* THE DEFECT: an account switch under a claimed profile                       */
/* -------------------------------------------------------------------------- */

test('a claimed profile whose gaia_id changed is unclaimed and relabeled', async (t) => {
  const dir = userDataDir(t, { 'Profile 1': CHROME_WORK })
  const store = storeIn(dir)

  claim({ store, dir, profileDir: 'Profile 1' })
  assert.equal(store.get('inst-1').identityFingerprint, 'gaia:100000000000000000001')

  // the operator signs that same profile into their personal mailbox. The DIRECTORY is
  // unchanged, which is why matching on the directory alone never saw this.
  writeLocalState(dir, { 'Profile 1': { ...CHROME_PERSONAL, name: 'acme-corp.com' } })

  const identity = await register({ store, dir, email: 'alice.example@gmail.com' })

  assert.equal(identity.claimed, false, 'the claim must NOT be honored')
  assert.equal(identity.source, SOURCE_IDENTITY_CHANGED)
  assert.equal(identity.identityChanged, true)
  assert.equal(identity.profileDir, null, 'nothing may be routed to it')

  // Relabeled, which is the mechanism: the old name stops resolving, so the
  // next tool call that says "chrome-acme-corp" fails loudly instead of
  // acting as the wrong person.
  const label = defaultLabelFor(identity)
  assert.notEqual(label, 'chrome-acme-corp')
  assert.match(label, /^chrome-unclaimed-/)

  // And the warning names both identities, not just "something changed".
  const warning = identity.warnings.join(' ')
  assert.match(warning, /100000000000000000001/)
  assert.match(warning, /100000000000000000002/)

  // The stale fingerprint is cleared with the stale claim, so the next register
  // is not comparing against an identity nobody holds.
  assert.equal(store.get('inst-1').identityFingerprint, null)
})

test('a custom name does not survive an identity change, or it would freeze the mislabel', async (t) => {
  const dir = userDataDir(t, { 'Profile 1': CHROME_WORK })
  const store = storeIn(dir)
  claim({ store, dir, profileDir: 'Profile 1' })
  store.remember('inst-1', { label: 'ba', labelIsCustom: true })

  writeLocalState(dir, { 'Profile 1': { ...CHROME_PERSONAL, name: 'acme-corp.com' } })
  const identity = await register({ store, dir, email: 'alice.example@gmail.com' })

  // The broker keys the label drop off exactly this value. A route that keeps
  // "work" keeps RESOLVING, and read and write operations are served on an
  // unclaimed route, so "work" would still drive a browser as somebody else.
  assert.equal(identity.source, SOURCE_IDENTITY_CHANGED)
  assert.notEqual(defaultLabelFor(identity), 'ba')
})

test('the live email disagreeing with the disk row counts as drift', async (t) => {
  // This is the detector that fires DURING the roughly fifteen seconds Chrome
  // takes to flush info_cache: disk still says the old account, and the
  // extension is reading the live browser. The previous build discarded the
  // live value and reported the stale one as fact.
  //
  // The row carries no account id on purpose. With one present on both sides
  // the account id answers the question outright and this detector never runs -
  // which is the point of the test immediately below.
  const dir = userDataDir(t, { 'Profile 1': CHROME_WORK_NO_GAIA })
  const store = storeIn(dir)
  claim({ store, dir, profileDir: 'Profile 1' })
  assert.equal(store.get('inst-1').identityFingerprint, 'email:alice@acme-corp.com')

  const identity = await register({ store, dir, email: 'alice.example@gmail.com' })

  assert.equal(identity.claimed, false)
  assert.equal(identity.source, SOURCE_IDENTITY_CHANGED)
  const warning = identity.warnings.join(' ')
  assert.match(warning, /alice@acme-corp\.com/)
  assert.match(warning, /alice\.example@gmail\.com/)
})

test('a MATCHING gaia id with a different email is NOT drift', async (t) => {
  // The strongest signal has to be consulted first. The account id survives an
  // address rename and no human can type it, so a row carrying the exact id the
  // claim recorded PROVES the account is unchanged - and an address that
  // disagrees with it is then a rename, a secondary account, or a lag.
  //
  // The previous build returned the address comparison BEFORE looking at the
  // id, so the weakest evidence in the system could unclaim a profile the
  // strongest evidence had just vouched for. On the operator's live Chrome line that is
  // an unclaim on every single register, forever.
  const dir = userDataDir(t, { 'Profile 1': CHROME_WORK })
  const store = storeIn(dir)
  claim({ store, dir, profileDir: 'Profile 1' })

  const identity = await register({ store, dir, email: 'alice.example@gmail.com' })

  assert.equal(identity.claimed, true, 'the account id vouched for this line')
  assert.equal(identity.source, 'state')
  assert.equal(identity.identityUnverified, false, 'and it was genuinely checked, not merely honored')
  assert.equal(defaultLabelFor(identity), 'chrome-acme-corp')
  assert.deepEqual(identity.warnings, [])

  // Nothing is lost by waiting: the moment Chrome flushes the switch, the id on
  // disk changes and the fingerprint detector drops the claim. The detection is
  // delayed by the flush, never skipped.
  writeLocalState(dir, { 'Profile 1': { ...CHROME_PERSONAL, name: 'acme-corp.com' } })
  const after = await register({ store, dir, email: 'alice.example@gmail.com' })
  assert.equal(after.source, SOURCE_IDENTITY_CHANGED)
})

test('the drift sentence names the OLD account first and the NEW one second, on BOTH paths', async (t) => {
  // Same two addresses, two paths, opposite freshness. At REGISTER the
  // extension has just read the live browser, so its address is the new one. On
  // the HEARTBEAT that same address has been frozen on the route since that
  // register and the row was read a moment ago, so DISK is the new one.
  //
  // The old code read the direction off which argument a value arrived in, so
  // the heartbeat sentence told the operator their new account was the account they had left
  // - on the one screen whose entire job is saying who this line is now.
  const dir = userDataDir(t, { 'Profile 1': CHROME_WORK_NO_GAIA })
  const store = storeIn(dir)
  claim({ store, dir, profileDir: 'Profile 1' })

  // Register: disk still says BA, the live browser says personal.
  const atRegister = await register({ store, dir, email: 'alice.example@gmail.com' })
  assert.equal(atRegister.drift.why, 'email')
  assert.equal(atRegister.drift.from, 'alice@acme-corp.com', 'from = the account being left')
  assert.equal(atRegister.drift.to, 'alice.example@gmail.com', 'to = the account signed in now')

  // Heartbeat: the switch has flushed to disk, and the route still holds the
  // address the extension reported at start-up.
  writeLocalState(dir, { 'Profile 1': { ...CHROME_PERSONAL, name: 'acme-corp.com', gaia_id: '' } })
  const atHeartbeat = heartbeat({
    store,
    dir,
    profileDir: 'Profile 1',
    reportedEmail: 'alice@acme-corp.com',
  })
  assert.equal(atHeartbeat.changed, true)
  assert.equal(atHeartbeat.why, 'email')
  assert.equal(atHeartbeat.from, 'alice@acme-corp.com', 'from = the account being left')
  assert.equal(atHeartbeat.to, 'alice.example@gmail.com', 'to = the account signed in now')

  // And the sentence the operator actually reads puts them in that order on both.
  for (const drift of [atRegister.drift, atHeartbeat]) {
    const sentence = identityChangedWarning(drift)
    assert.ok(
      sentence.indexOf('alice@acme-corp.com') < sentence.indexOf('alice.example@gmail.com'),
      `old account must be named first: ${sentence}`
    )
  }

  // The line keeps a display-only account, and both paths leave the same one:
  // the account that is signed in NOW, which is the whole question a drifted
  // line has to answer.
  assert.equal(atRegister.email, 'alice.example@gmail.com')
  assert.equal(
    driftDisplayAccount(atHeartbeat, {
      row: { email: 'alice.example@gmail.com' },
      reportedEmail: 'alice@acme-corp.com',
    }),
    'alice.example@gmail.com'
  )
})

test('a re-claim survives the next heartbeat', async (t) => {
  // The recovery path, which did not work. `reportedEmail` is written once, at
  // REGISTER, and never refreshed while a browser stays open. So after an
  // in-session drop, the heartbeat kept comparing that frozen address against
  // the row the operator had just picked, called it drift, and undid the re-claim sixty
  // seconds later - forever.
  const dir = userDataDir(t, { 'Profile 1': CHROME_WORK_NO_GAIA })
  const store = storeIn(dir)
  const full = candidatesFor('chrome', dir)

  // The human picks this directory. applyClaim declares what a claim erases,
  // and the cached live address is part of it: a person pointing at a profile
  // is fresher evidence than an address cached at start-up.
  const patch = applyClaim({ candidatesFull: full, vendor: 'chrome', userDataDir: dir, dir: 'Profile 1' })
  assert.equal(patch.reportedEmail, null, 'a claim erases the cached live address')
  store.remember('inst-1', {
    vendor: 'chrome',
    userDataDir: dir,
    profileDir: patch.profileDir,
    claimed: true,
    identityFingerprint: patch.identityFingerprint,
    claimedAt: patch.claimedAt,
  })

  // The heartbeat that follows the claim, with the cache cleared as the broker
  // clears it.
  const next = heartbeat({ store, dir, profileDir: 'Profile 1', reportedEmail: patch.reportedEmail })
  assert.equal(next.changed, false, 'the re-claim must survive')

  // And the same heartbeat with the stale address left in place, which is the
  // revert loop this clearing exists to stop.
  const ifStaleKept = heartbeat({
    store,
    dir,
    profileDir: 'Profile 1',
    reportedEmail: 'alice.example@gmail.com',
  })
  assert.equal(ifStaleKept.changed, true)
})

test('the same live email as the disk row is not drift', async (t) => {
  const dir = userDataDir(t, { 'Profile 1': CHROME_WORK })
  const store = storeIn(dir)
  claim({ store, dir, profileDir: 'Profile 1' })

  // Case and surrounding whitespace are not identity changes.
  const identity = await register({ store, dir, email: '  Alice@Acme-Corp.com ' })
  assert.equal(identity.claimed, true)
  assert.equal(identity.source, 'state')
})

/* -------------------------------------------------------------------------- */
/* FALSE POSITIVES. The thing to fear most.                                    */
/* -------------------------------------------------------------------------- */

test('a cold browser start, before Local State is flushed, is NOT drift', async (t) => {
  // The single most important test in this file. the operator starts browsers every
  // morning. Chromium writes a stub Local State immediately and flushes the
  // real profile cache seconds later; this repo measures that at roughly 15
  // seconds on a cold Brave start, and registration happens well inside it.
  //
  // Three shapes of "not flushed yet", all of which must honor the claim and
  // none of which may rename anything.
  const dir = userDataDir(t, { 'Profile 1': CHROME_WORK })
  const store = storeIn(dir)
  claim({ store, dir, profileDir: 'Profile 1' })
  const fingerprintBefore = store.get('inst-1').identityFingerprint

  // 1. No info_cache at all, so nothing can be read about any profile. The
  //    claim is HONORED - an empty candidate list is "I could not read", never
  //    "it is gone" - and nothing is renamed or reported.
  writeLocalState(dir, {})
  let identity = await register({ store, dir, email: 'alice@acme-corp.com' })
  assert.notEqual(identity.source, SOURCE_IDENTITY_CHANGED)
  assert.equal(identity.identityChanged, false)
  assert.equal(identity.claimed, true)
  assert.equal(identity.identityUnverified, true)

  // 2. The row exists but carries no identity yet: name only, no gaia id, no
  //    user_name. A naive comparison reads saved `gaia:...` against current
  //    `name:...`, calls them different, and unclaims a working profile.
  writeLocalState(dir, {
    'Profile 1': { name: 'acme-corp.com', user_name: '', gaia_id: '' },
  })
  identity = await register({ store, dir, email: null })
  assert.equal(identity.claimed, true, 'a half-written row must not drop the claim')
  assert.equal(identity.source, 'state')
  // Honoring the claim was only half of it. Deriving a label from that
  // half-written row turns "chrome-acme-corp" into "chrome-acme-corp-io"
  // until the flush lands, which renames the thing every tool call says out
  // loud. The unverified flag is what keeps the persisted name in place.
  assert.equal(identity.identityUnverified, true)
  assert.equal(labelFor(identity, store.get('inst-1')), 'chrome-acme-corp')

  // 3. The row is there and the extension has not reported an email yet.
  writeLocalState(dir, { 'Profile 1': CHROME_WORK })
  identity = await register({ store, dir, email: null })
  assert.equal(identity.claimed, true)
  assert.equal(identity.source, 'state')
  assert.equal(identity.identityUnverified, false, 'this one really was checked')

  // Nothing was renamed and nothing was rewritten along the way.
  assert.equal(defaultLabelFor(identity), 'chrome-acme-corp')
  assert.equal(store.get('inst-1').identityFingerprint, fingerprintBefore)
})

test('AN UNREADABLE Local State HONORS THE CLAIM AND CHANGES NOTHING - Chrome', async (t) => {
  // The worst outcome in this file, and it was reachable by one register during
  // an ordinary browser start.
  //
  // readProfiles() returns [] for a file that cannot be read, for JSON that
  // cannot be parsed, and for a `Local State` with no profile.info_cache yet -
  // and a Chromium browser writes exactly that stub the instant it starts. The
  // saved claim then found no candidate, fell past the honor branch, and the
  // line was unclaimed and renamed. An empty list means I COULD NOT READ, which
  // is not the same fact as a list that was read and does not contain this
  // directory.
  const dir = userDataDir(t, { 'Profile 1': CHROME_WORK })
  const store = storeIn(dir)
  claim({ store, dir, profileDir: 'Profile 1' })
  const before = store.get('inst-1')

  const localState = path.join(dir, 'Local State')
  const unreadable = [
    ['the file is not there yet', () => fs.rmSync(localState, { force: true })],
    ['the file is half written', () => fs.writeFileSync(localState, '{"profile": {"info_c', 'utf8')],
    ['the stub has no info_cache', () => fs.writeFileSync(localState, '{"profile":{}}', 'utf8')],
  ]

  for (const [what, write] of unreadable) {
    write()
    const identity = await register({ store, dir, email: 'alice@acme-corp.com' })

    assert.equal(identity.claimed, true, `${what}: the claim must be honored`)
    assert.equal(identity.identityChanged, false, what)
    assert.equal(identity.profileDir, 'Profile 1', `${what}: still addressable`)
    assert.equal(identity.identityUnverified, true, `${what}: honored, and said to be unverified`)
    assert.deepEqual(identity.warnings, [], `${what}: nothing to say, it resolves itself`)

    // The label the operator's tools address, byte for byte.
    assert.equal(labelFor(identity, store.get('inst-1')), 'chrome-acme-corp', what)

    // And nothing durable moved: the claim and its evidence are untouched.
    const after = store.get('inst-1')
    assert.equal(after.claimed, true, what)
    assert.equal(after.profileDir, 'Profile 1', what)
    assert.equal(after.identityFingerprint, before.identityFingerprint, what)
    assert.equal(after.claimedAt, before.claimedAt, what)
  }
})

test('AN UNREADABLE Local State HONORS THE CLAIM AND CHANGES NOTHING - Brave', async (t) => {
  // Worse on Brave, which is why it gets its own test. Chrome can re-claim
  // itself by address; Brave writes no Google identity at all, so there is
  // nothing to auto-match on and a claim destroyed inside a flush window stays
  // destroyed until the operator clicks. This is the line that is connected right now.
  const dir = userDataDir(t, { Default: BRAVE_PERSONAL })
  const store = storeIn(dir)
  claim({
    store,
    dir,
    installId: 'inst-b',
    vendor: 'brave',
    profileDir: 'Default',
    label: 'brave-alice-example',
  })
  const before = store.get('inst-b')
  assert.equal(before.identityFingerprint, 'name:alice.example@gmail.com')

  fs.rmSync(path.join(dir, 'Local State'), { force: true })
  const identity = await register({ store, dir, installId: 'inst-b', vendor: 'brave' })

  assert.equal(identity.claimed, true, 'the claim must be honored')
  assert.equal(identity.identityUnverified, true)
  assert.equal(identity.profileDir, 'Default')
  assert.deepEqual(identity.warnings, [])
  assert.equal(labelFor(identity, store.get('inst-b')), 'brave-alice-example')
  assert.equal(store.get('inst-b').claimed, true)
  assert.equal(store.get('inst-b').identityFingerprint, before.identityFingerprint)
})

test('a candidate list that WAS read and lacks the directory still drops the claim', async (t) => {
  // The other half of the same rule, and the reason honoring an empty list is
  // safe: a list that was genuinely read and does not carry this directory is a
  // profile that went away. Honoring THAT would leave a claim pointing at
  // nothing, so the detector still has its teeth.
  const dir = userDataDir(t, { 'Profile 1': CHROME_WORK })
  const store = storeIn(dir)
  claim({ store, dir, profileDir: 'Profile 1' })

  writeLocalState(dir, { Default: CHROME_PERSONAL })
  const identity = await register({ store, dir, email: null })

  assert.equal(identity.claimed, false)
  assert.equal(identity.profileDir, null)
  assert.match(identity.warnings.join(' '), /no longer lists/)
  assert.equal(store.get('inst-1').claimed, false)
  assert.equal(store.get('inst-1').identityFingerprint, null, 'the evidence goes with the claim')
})

test("the two live labels are unchanged on every path that honors a claim", async (t) => {
  // The regression that would be felt in the morning. Three honored paths -
  // fully readable, half written, unreadable - and one label out of each.
  const chromeDir = userDataDir(t, { 'Profile 1': CHROME_WORK })
  const chrome = storeIn(chromeDir)
  claim({ store: chrome, dir: chromeDir, profileDir: 'Profile 1' })

  const rows = [
    ['fully readable', { 'Profile 1': CHROME_WORK }],
    ['half written', { 'Profile 1': { name: 'acme-corp.com', user_name: '', gaia_id: '' } }],
    ['no info_cache at all', {}],
  ]
  for (const [what, cache] of rows) {
    writeLocalState(chromeDir, cache)
    const identity = await register({ store: chrome, dir: chromeDir, email: 'alice@acme-corp.com' })
    assert.equal(identity.claimed, true, what)
    assert.equal(labelFor(identity, chrome.get('inst-1')), 'chrome-acme-corp', what)
  }

  const braveDir = userDataDir(t, { Default: BRAVE_PERSONAL })
  const brave = storeIn(braveDir)
  claim({
    store: brave,
    dir: braveDir,
    installId: 'inst-b',
    vendor: 'brave',
    profileDir: 'Default',
    label: 'brave-alice-example',
  })
  for (const [what, cache] of [
    ['fully readable', { Default: BRAVE_PERSONAL }],
    ['no info_cache at all', {}],
  ]) {
    writeLocalState(braveDir, cache)
    const identity = await register({ store: brave, dir: braveDir, installId: 'inst-b', vendor: 'brave' })
    assert.equal(identity.claimed, true, what)
    assert.equal(labelFor(identity, brave.get('inst-b')), 'brave-alice-example', what)
  }
})

test('a null CURRENT fingerprint never counts as drift', () => {
  // Brave with a nameless profile, and any row that carries nothing readable.
  // CANNOT CHECK always honors the claim.
  const nameless = { dir: 'Default', name: '', email: null, gaiaId: null }
  assert.equal(identityFingerprint({ profileName: nameless.name }), null)
  assert.equal(
    identityDrift({ savedFingerprint: 'gaia:abc', row: nameless, reportedEmail: null }).changed,
    false
  )
})

test('no row on disk at all is CANNOT CHECK, never drift', () => {
  assert.equal(identityDrift({ savedFingerprint: 'gaia:abc', row: null }).changed, false)
  assert.equal(identityDrift({}).changed, false)
})

test('two fingerprints built from different evidence are never compared', () => {
  // One side holding evidence the other lacks is a flush lag, not a new person.
  // Comparing them is precisely how a cold start would unclaim the operator's profiles.
  const row = { dir: 'Default', name: 'work', email: null, gaiaId: null }
  assert.equal(identityDrift({ savedFingerprint: 'gaia:abc', row }).changed, false)
  assert.equal(
    identityDrift({ savedFingerprint: 'name:work', row: { ...row, gaiaId: 'abc' } }).changed,
    false
  )
})

test('a signed-OUT profile is not read as a different person', () => {
  // Signing out clears user_name and gaia_id. That is not somebody else, and a
  // sign-in as somebody else afterwards produces a gaia id that IS compared.
  const signedOut = { dir: 'Profile 1', name: 'acme-corp.com', email: null, gaiaId: null }
  assert.equal(
    identityDrift({ savedFingerprint: 'gaia:100000000000000000001', row: signedOut }).changed,
    false
  )
})

/* -------------------------------------------------------------------------- */
/* Trust on first use                                                          */
/* -------------------------------------------------------------------------- */

test('a claim with no stored fingerprint is adopted silently, never flagged', async (t) => {
  // the operator's two live claims predate fingerprints and are correct today, which is
  // what makes adoption safe. Flagging them would greet them with two alarms for
  // a system that is working.
  const dir = userDataDir(t, { 'Profile 1': CHROME_WORK })
  const store = storeIn(dir)

  // A claim exactly as an older broker wrote it: no fingerprint, no claimedAt.
  store.remember('inst-1', {
    vendor: 'chrome',
    userDataDir: dir,
    profileDir: 'Profile 1',
    profileName: 'acme-corp.com',
    email: 'alice@acme-corp.com',
    claimed: true,
    label: 'chrome-acme-corp',
    labelIsCustom: false,
  })
  assert.equal(store.get('inst-1').identityFingerprint, undefined)

  const identity = await register({ store, dir, email: 'alice@acme-corp.com' })

  assert.equal(identity.claimed, true, 'the existing claim must survive untouched')
  assert.equal(identity.source, 'state')
  assert.equal(defaultLabelFor(identity), 'chrome-acme-corp')
  assert.deepEqual(identity.warnings, [], 'adoption is silent on screen')

  // Silent to the operator, but recorded and reported to the log, because it is a
  // decision taken on the operator's behalf.
  assert.equal(identity.identityAdopted, 'gaia:100000000000000000001')
  assert.equal(store.get('inst-1').identityFingerprint, 'gaia:100000000000000000001')

  // Adopted ONCE. The second register has nothing left to adopt, and from here
  // on the profile is protected.
  const second = await register({ store, dir, email: 'alice@acme-corp.com' })
  assert.equal(second.identityAdopted, null)

  writeLocalState(dir, { 'Profile 1': { ...CHROME_PERSONAL, name: 'acme-corp.com' } })
  const third = await register({ store, dir, email: 'alice.example@gmail.com' })
  assert.equal(third.source, SOURCE_IDENTITY_CHANGED, 'the adopted fingerprint now defends it')
})

/* -------------------------------------------------------------------------- */
/* The fingerprint's lifecycle: written wherever a claim is made, cleared      */
/* wherever one is dropped                                                     */
/* -------------------------------------------------------------------------- */

test('a claim made by ADDRESS records a fingerprint, exactly as a click does', async (t) => {
  // The auto-match branch claims a line just as surely as the claim card does,
  // and it used to record no claim-time evidence at all. So the identity check
  // was defending nothing on every auto-claimed route: with no fingerprint to
  // compare against, the NEXT register's trust-on-first-use simply adopted
  // whichever account happened to be signed in by then.
  const dir = userDataDir(t, { 'Profile 1': CHROME_WORK })
  const store = storeIn(dir)

  const identity = await register({ store, dir, email: 'alice@acme-corp.com' })
  assert.equal(identity.claimed, true)
  assert.equal(identity.source, 'email')
  assert.equal(store.get('inst-1').identityFingerprint, 'gaia:100000000000000000001')

  // Persisted as handleRegister persists it, so the next register takes the
  // saved-claim path rather than matching by address a second time.
  store.remember('inst-1', {
    vendor: 'chrome',
    userDataDir: dir,
    claimed: true,
    profileDir: 'Profile 1',
    label: 'chrome-acme-corp',
  })

  // The account switches. The recorded fingerprint is what catches it.
  writeLocalState(dir, { 'Profile 1': { ...CHROME_PERSONAL, name: 'acme-corp.com' } })
  const second = await register({ store, dir, email: 'alice.example@gmail.com' })
  assert.equal(second.source, SOURCE_IDENTITY_CHANGED)
})

test('an address match does NOT silently re-claim against a surviving fingerprint', async (t) => {
  // Belt and braces for the rule above. If a fingerprint outlives its claim for
  // any reason - a state file written by an older broker, a claim dropped by a
  // path that predates this - an address match is not enough to put the line
  // back into service under a different account id. The two pieces of evidence
  // disagree, so a human settles it.
  const dir = userDataDir(t, { 'Profile 1': CHROME_WORK })
  const store = storeIn(dir)
  store.remember('inst-1', {
    vendor: 'chrome',
    userDataDir: dir,
    claimed: false,
    identityFingerprint: 'gaia:999999999999999999999',
  })

  const identity = await register({ store, dir, email: 'alice@acme-corp.com' })

  assert.equal(identity.claimed, false, 'an address alone must not re-claim over contrary evidence')
  assert.match(identity.warnings.join(' '), /will not re-claim it on an address alone/)
})

test('a fingerprint never outlives the claim it belongs to, on any path', async (t) => {
  // A fingerprint left behind is a record of somebody nothing is comparing
  // against any more, and the next register reasons from it. Both drop paths
  // clear it, and this is the one that used not to.
  const dir = userDataDir(t, { 'Profile 1': CHROME_WORK })

  // Path 1: the identity under the claim changed.
  const drifted = storeIn(dir)
  claim({ store: drifted, dir, profileDir: 'Profile 1' })
  writeLocalState(dir, { 'Profile 1': { ...CHROME_PERSONAL, name: 'acme-corp.com' } })
  await register({ store: drifted, dir, email: 'alice.example@gmail.com' })
  assert.equal(drifted.get('inst-1').identityFingerprint, null)
  assert.equal(drifted.get('inst-1').claimedAt, null)

  // Path 2: the directory is gone from a list that read fine.
  writeLocalState(dir, { 'Profile 1': CHROME_WORK })
  const missing = storeIn(dir)
  claim({ store: missing, dir, profileDir: 'Profile 1' })
  writeLocalState(dir, { Default: BRAVE_PERSONAL })
  await register({ store: missing, dir, email: null })
  assert.equal(missing.get('inst-1').identityFingerprint, null)
  assert.equal(missing.get('inst-1').claimedAt, null)
})

/* -------------------------------------------------------------------------- */
/* Brave: be honest about what cannot be detected                              */
/* -------------------------------------------------------------------------- */

test('Brave falls back to the profile name, and a rename reads as a change', async (t) => {
  // Brave carries no Google identity, so the name is the whole of the signal.
  // The honest consequence, documented in docs/DESIGN.md section 4 and in the
  // options page: renaming a Brave profile unclaims the line. The cost is one
  // click; the alternative is having no detector on Brave at all.
  const dir = userDataDir(t, { Default: BRAVE_PERSONAL })
  const store = storeIn(dir)

  const full = candidatesFor('brave', dir)
  const patch = applyClaim({ candidatesFull: full, vendor: 'brave', userDataDir: dir, dir: 'Default' })
  assert.equal(patch.identityFingerprint, 'name:alice.example@gmail.com')

  store.remember('inst-b', {
    vendor: 'brave',
    userDataDir: dir,
    profileDir: 'Default',
    claimed: true,
    identityFingerprint: patch.identityFingerprint,
    label: 'brave-alice-example',
  })

  // Same name, different session: nothing happens, which is the common case.
  let identity = await register({ store, dir, installId: 'inst-b', vendor: 'brave' })
  assert.equal(identity.claimed, true)
  assert.equal(defaultLabelFor(identity), 'brave-alice-example')

  // Renamed in Brave: detected, because on Brave that is all there is to detect.
  writeLocalState(dir, { Default: { ...BRAVE_PERSONAL, name: 'personal' } })
  identity = await register({ store, dir, installId: 'inst-b', vendor: 'brave' })
  assert.equal(identity.source, SOURCE_IDENTITY_CHANGED)
})

test('an account switch inside Brave with no rename is undetectable, and we say so', () => {
  // Not a wish: an assertion that the limit is real, so nobody later claims
  // coverage this system does not have. Brave writes no gaia_id and no
  // user_name, so two different people behind one profile name are one
  // fingerprint.
  const before = { dir: 'Default', name: 'personal', email: null, gaiaId: null }
  const after = { dir: 'Default', name: 'personal', email: null, gaiaId: null }
  const fp = identityFingerprint({ gaiaId: before.gaiaId, email: before.email, profileName: before.name })
  assert.equal(fp, 'name:personal')
  assert.equal(identityDrift({ savedFingerprint: fp, row: after }).changed, false)
})
