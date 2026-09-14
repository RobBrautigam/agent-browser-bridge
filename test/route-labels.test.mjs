/**
 * Label assignment across the route table.
 *
 * The property being defended: a label means ONE person, and it means the same
 * person tomorrow. the operator is heading for ten email addresses across two browsers,
 * so twenty lines, and several of those addresses will exist in both Chrome and
 * Brave at once.
 *
 * The previous rule handed the bare name to whichever profile registered FIRST
 * and gave the runner-up `label#2`. That is an arrival-order coin flip: open
 * Chrome before Brave and `chrome-acme-corp` is one profile; open them the
 * other way round and it is the other. These tests exist to make that
 * impossible to reintroduce.
 *
 * Fixtures only. Nothing here reads the machine.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { RouteTable, absentLabelHolder, collisionNotes, lineFor } from '../bridged/routes.mjs'
import { deriveLabel } from '../shared/paths.mjs'

const CHROME_UD = 'C:/Users/alice/AppData/Local/Google/Chrome/User Data'
const BRAVE_UD = 'C:/Users/alice/AppData/Local/BraveSoftware/Brave-Browser/User Data'

/** An identity in the shape resolveIdentity emits. */
function identity({
  vendor = 'chrome',
  userDataDir = CHROME_UD,
  profileDir = 'Default',
  profileName = '',
  email = null,
  hostedDomain = null,
  claimed = true,
} = {}) {
  return {
    vendor,
    vendorLabel: vendor === 'brave' ? 'Brave' : 'Chrome',
    vendorVerified: true,
    userDataDir,
    profileDir,
    profileName,
    email,
    hostedDomain,
    claimed,
    candidates: [],
    reportedEmail: null,
    identityChanged: false,
    source: 'state',
    warnings: [],
  }
}

/** Attach a profile the way handleRegister does: derive the name, let the table resolve it. */
function attach(table, installId, id) {
  const desiredLabel = deriveLabel(id.vendor, {
    dir: id.profileDir,
    name: id.profileName,
    email: id.email,
    hostedDomain: id.hostedDomain,
  })
  return table.attach({
    installId,
    conn: null,
    identity: id,
    generation: 1,
    desiredLabel,
    labelIsCustom: false,
    extVersion: '1',
    tabCount: 0,
  }).route
}

function labelsOf(table) {
  return table
    .all()
    .map((r) => r.label)
    .sort()
}

/* -------------------------------------------------------------------------- */
/* The regression that matters most: two LIVE profiles                   */
/* -------------------------------------------------------------------------- */

/**
 * These two are connected right now, and their labels are what every tool call
 * says out loud. Byte for byte, or a change here breaks a working install.
 */
const LIVE_BRAVE_PERSONAL = identity({
  vendor: 'brave',
  userDataDir: BRAVE_UD,
  profileDir: 'Default',
  profileName: 'alice.example@gmail.com',
})
const LIVE_CHROME_WORK = identity({
  vendor: 'chrome',
  userDataDir: CHROME_UD,
  profileDir: 'Profile 1',
  profileName: 'acme-corp.com',
  email: 'alice@acme-corp.com',
  hostedDomain: 'acme-corp.com',
})

test("the two live labels are unchanged, byte for byte", () => {
  const table = new RouteTable()
  attach(table, 'inst-brave', LIVE_BRAVE_PERSONAL)
  attach(table, 'inst-chrome', LIVE_CHROME_WORK)

  assert.deepEqual(labelsOf(table), ['brave-alice-example', 'chrome-acme-corp'])
  assert.equal(table.resolve('brave-alice-example').installId, 'inst-brave')
  assert.equal(table.resolve('chrome-acme-corp').installId, 'inst-chrome')
})

test('the two live labels survive the opposite registration order', () => {
  const table = new RouteTable()
  attach(table, 'inst-chrome', LIVE_CHROME_WORK)
  attach(table, 'inst-brave', LIVE_BRAVE_PERSONAL)
  assert.deepEqual(labelsOf(table), ['brave-alice-example', 'chrome-acme-corp'])
})

test('no collision means no suffix anywhere', () => {
  // The rule only fires on an actual clash. A suffix on a unique name would
  // rename the operator's world for nothing.
  const table = new RouteTable()
  attach(table, 'a', LIVE_CHROME_WORK)
  for (const label of labelsOf(table)) assert.ok(!label.includes('-default'), label)
})

/* -------------------------------------------------------------------------- */
/* Collisions                                                                  */
/* -------------------------------------------------------------------------- */

/** Two Chrome profiles signed into ONE address: the only real collision shape. */
const CHROME_WORK_A = identity({
  profileDir: 'Default',
  profileName: 'acme-corp.com',
  email: 'alice@acme-corp.com',
  hostedDomain: 'acme-corp.com',
})
const CHROME_WORK_B = identity({
  profileDir: 'Profile 1',
  profileName: 'acme-corp.com',
  email: 'alice@acme-corp.com',
  hostedDomain: 'acme-corp.com',
})

test('two colliding profiles get deterministic, directory-derived labels', () => {
  const table = new RouteTable()
  attach(table, 'inst-a', CHROME_WORK_A)
  attach(table, 'inst-b', CHROME_WORK_B)

  assert.deepEqual(labelsOf(table), ['chrome-acme-corp-default', 'chrome-acme-corp-profile-1'])

  // The suffix names the DIRECTORY, which is the identity half of the route
  // key, so it is a fact about the profile rather than about the morning.
  assert.equal(table.byInstallId('inst-a').label, 'chrome-acme-corp-default')
  assert.equal(table.byInstallId('inst-b').label, 'chrome-acme-corp-profile-1')
})

test('registering them in the OPPOSITE order produces the SAME assignment', () => {
  // The whole point. An arrival-order suffix would swap these two, and a label
  // that means a different person on a different day is the wrong-identity
  // failure wearing a cosmetic disguise.
  const forward = new RouteTable()
  attach(forward, 'inst-a', CHROME_WORK_A)
  attach(forward, 'inst-b', CHROME_WORK_B)

  const backward = new RouteTable()
  attach(backward, 'inst-b', CHROME_WORK_B)
  attach(backward, 'inst-a', CHROME_WORK_A)

  assert.equal(forward.byInstallId('inst-a').label, backward.byInstallId('inst-a').label)
  assert.equal(forward.byInstallId('inst-b').label, backward.byInstallId('inst-b').label)
  assert.deepEqual(labelsOf(forward), labelsOf(backward))
})

test('the bare colliding label resolves to NOTHING', () => {
  // Nobody keeps the plain name, so a tool call that says it fails loudly. The
  // old rule gave the plain name to one of the two, which is exactly how an
  // operation lands on the wrong logged-in browser.
  const table = new RouteTable()
  attach(table, 'inst-a', CHROME_WORK_A)
  attach(table, 'inst-b', CHROME_WORK_B)

  assert.equal(table.resolve('chrome-acme-corp'), null)

  // And the refusal can name the two labels that did take it, so the model
  // self-corrects in one turn instead of guessing.
  assert.deepEqual(table.labelsForBase('chrome-acme-corp'), [
    'chrome-acme-corp-default',
    'chrome-acme-corp-profile-1',
  ])
})

test('both colliding lines carry a warning that names both profiles', () => {
  const table = new RouteTable()
  const a = attach(table, 'inst-a', CHROME_WORK_A)
  const b = attach(table, 'inst-b', CHROME_WORK_B)

  for (const route of [a, b]) {
    const warning = route.warnings.join(' ')
    assert.match(warning, /Label collision/)
    assert.match(warning, /Default/)
    assert.match(warning, /Profile 1/)
  }
})

test('a collision resolves back to the plain name when one profile disconnects', () => {
  const table = new RouteTable()
  const a = attach(table, 'inst-a', CHROME_WORK_A)
  const b = attach(table, 'inst-b', CHROME_WORK_B)
  assert.equal(a.label, 'chrome-acme-corp-default')

  table.detach(b)
  assert.equal(a.label, 'chrome-acme-corp', 'the survivor takes the plain name back')
  assert.deepEqual(a.warnings.filter((w) => w.startsWith('Label collision')), [])
})

test('a label change on a live route is announced, so handles and the extension keep up', () => {
  // A label is baked into every tab handle. Moving a connected route off its
  // name has to invalidate them, and the broker does that from this callback.
  const changes = []
  const table = new RouteTable({ onLabelChanged: (route, previous) => changes.push([previous, route.label]) })

  attach(table, 'inst-a', CHROME_WORK_A)
  assert.deepEqual(changes, [], 'a first assignment is not a change')

  attach(table, 'inst-b', CHROME_WORK_B)
  assert.deepEqual(changes, [['chrome-acme-corp', 'chrome-acme-corp-default']])
})

test('same directory in two user-data-dirs falls back to a stable hash, never a counter', () => {
  // Two Chrome instances started against different user-data-dirs, both with a
  // "Default" profile signed into one address. The directory suffix cannot
  // separate them, so the route key does.
  const table = new RouteTable()
  attach(table, 'inst-real', identity({ userDataDir: CHROME_UD, profileDir: 'Default', email: 'alice@acme-corp.com', hostedDomain: 'acme-corp.com' }))
  attach(table, 'inst-scratch', identity({ userDataDir: 'C:/scratch/ud', profileDir: 'Default', email: 'alice@acme-corp.com', hostedDomain: 'acme-corp.com' }))

  const labels = labelsOf(table)
  assert.equal(new Set(labels).size, 2, `collision survived: ${labels.join(', ')}`)
  for (const label of labels) {
    assert.ok(label.startsWith('chrome-acme-corp-'), label)
    assert.ok(!/#\d+$/.test(label), 'an arrival-order counter is exactly what this replaced')
  }

  // Stable across a restart in the other order.
  const again = new RouteTable()
  attach(again, 'inst-scratch', identity({ userDataDir: 'C:/scratch/ud', profileDir: 'Default', email: 'alice@acme-corp.com', hostedDomain: 'acme-corp.com' }))
  attach(again, 'inst-real', identity({ userDataDir: CHROME_UD, profileDir: 'Default', email: 'alice@acme-corp.com', hostedDomain: 'acme-corp.com' }))
  assert.equal(table.byInstallId('inst-real').label, again.byInstallId('inst-real').label)
})

test('two routes sharing a ROUTE KEY still get distinct labels', () => {
  // One browser profile carrying two extension instances - an unpacked copy
  // beside a store copy, or a reinstall that minted a second installId before
  // the first disconnected - resolves to the SAME vendor, user-data-dir and
  // profile directory. So the route key is identical, and so is every
  // tiebreaker derived from it or from the directory: the group suffix, the
  // duplicate fallback, and the final safety net all produced one string.
  //
  // Two live lines with one name is the failure the whole file exists to
  // prevent, and it was reachable in the one place that was supposed to be
  // unconditional. The installId is the only input two routes cannot share.
  const table = new RouteTable()
  const a = attach(table, 'inst-unpacked', LIVE_CHROME_WORK)
  const b = attach(table, 'inst-store', LIVE_CHROME_WORK)

  assert.equal(a.key, b.key, 'the fixture must really be the same profile')
  assert.notEqual(a.label, b.label, `two live lines share the name "${a.label}"`)
  assert.equal(new Set(labelsOf(table)).size, 2)
  for (const label of labelsOf(table)) assert.ok(label.startsWith('chrome-acme-corp-'), label)

  // Stable: the same instance gets the same name whatever order they connect
  // in, and across a broker restart.
  const again = new RouteTable()
  attach(again, 'inst-store', LIVE_CHROME_WORK)
  attach(again, 'inst-unpacked', LIVE_CHROME_WORK)
  assert.equal(again.byInstallId('inst-unpacked').label, a.label)
  assert.equal(again.byInstallId('inst-store').label, b.label)
})

/* -------------------------------------------------------------------------- */
/* Ambiguous addressing                                                        */
/* -------------------------------------------------------------------------- */

test('vendor:profileDir refuses when it matches two profiles rather than picking one', () => {
  // That address form says nothing about the user-data-dir, and every browser
  // calls a directory "Default". Returning the first match is a coin flip
  // between two logged-in identities.
  const table = new RouteTable()
  attach(table, 'inst-real', identity({ userDataDir: CHROME_UD, profileDir: 'Default', profileName: 'the operator', email: 'alice.example@gmail.com' }))
  attach(table, 'inst-scratch', identity({ userDataDir: 'C:/scratch/ud', profileDir: 'Default', profileName: 'Work', email: 'alice@acme-corp.com' }))

  const verdict = table.resolveAddress('chrome:Default')
  assert.equal(verdict.route, null)
  assert.equal(verdict.ambiguous.length, 2)
  assert.equal(table.resolve('chrome:Default'), null, 'ambiguity must read as no match')
})

test('vendor:profileDir still resolves when it is unambiguous', () => {
  const table = new RouteTable()
  attach(table, 'inst-chrome', LIVE_CHROME_WORK)
  assert.equal(table.resolve('chrome:Profile 1').installId, 'inst-chrome')
  assert.equal(table.resolve('chrome:Default'), null)
})

/* -------------------------------------------------------------------------- */
/* THE TWENTY PROFILE SCENARIO                                                 */
/* -------------------------------------------------------------------------- */

/** Ten addresses. Four custom domains, six consumer mailboxes. */
const TEN_ACCOUNTS = [
  { email: 'alice@acme-corp.com', hostedDomain: 'acme-corp.com' },
  { email: 'hello@ada.dev', hostedDomain: 'ada.dev' },
  { email: 'alice@writeco.com', hostedDomain: 'writeco.com' },
  { email: 'alice@rankco.com', hostedDomain: 'rankco.com' },
  { email: 'alice.example@gmail.com', hostedDomain: null },
  { email: 'sidegig3333@gmail.com', hostedDomain: null },
  { email: 'aliceexample@outlook.com', hostedDomain: null },
  { email: 'alice.builds@gmail.com', hostedDomain: null },
  { email: 'forge.alice@gmail.com', hostedDomain: null },
  { email: 'nws.alice@gmail.com', hostedDomain: null },
]

/** The same ten addresses signed into Chrome AND Brave: twenty lines. */
function twentyProfiles() {
  const out = []
  TEN_ACCOUNTS.forEach((account, i) => {
    const dir = i === 0 ? 'Default' : `Profile ${i}`
    out.push([
      `chrome-${i}`,
      identity({ vendor: 'chrome', userDataDir: CHROME_UD, profileDir: dir, profileName: account.email, ...account }),
    ])
    out.push([
      // Brave carries no Google identity, so its profiles are named after the
      // address they hold - which is how the operator actually names them, and what
      // deriveLabel's name-as-email branch exists for.
      `brave-${i}`,
      identity({ vendor: 'brave', userDataDir: BRAVE_UD, profileDir: dir, profileName: account.email, email: null, hostedDomain: null }),
    ])
  })
  return out
}

test('ten addresses across two browsers produce twenty distinct labels', () => {
  const table = new RouteTable()
  for (const [installId, id] of twentyProfiles()) attach(table, installId, id)

  const labels = labelsOf(table)
  assert.equal(labels.length, 20)
  assert.equal(new Set(labels).size, 20, `collision in: ${labels.join(', ')}`)

  // The vendor prefix is what keeps one address in two browsers apart, so it is
  // structural rather than decorative. Every address appears exactly twice.
  assert.equal(labels.filter((l) => l.startsWith('chrome-')).length, 10)
  assert.equal(labels.filter((l) => l.startsWith('brave-')).length, 10)
  assert.ok(labels.includes('chrome-acme-corp'))
  assert.ok(labels.includes('brave-acme-corp'))
  assert.ok(labels.includes('chrome-alice-example'))
  assert.ok(labels.includes('brave-alice-example'))

  // Twenty non-colliding names means twenty PLAIN names. A suffix here would
  // mean the collision rule was firing when it should not.
  for (const label of labels) assert.ok(!/-(default|profile-\d)$/.test(label), label)
})

test('the twenty labels are stable across a restart, whatever order they reconnect in', () => {
  const first = new RouteTable()
  for (const [installId, id] of twentyProfiles()) attach(first, installId, id)

  // A restart, with every browser reconnecting in reverse order.
  const second = new RouteTable()
  for (const [installId, id] of twentyProfiles().reverse()) attach(second, installId, id)

  for (const [installId] of twentyProfiles()) {
    assert.equal(
      second.byInstallId(installId).label,
      first.byInstallId(installId).label,
      `${installId} changed name across a restart`
    )
  }
})

/* -------------------------------------------------------------------------- */
/* Names held by a profile that is merely NOT CONNECTED                        */
/* -------------------------------------------------------------------------- */

test('a label held by an ABSENT profile is refused, not handed out', () => {
  // A browser that happens to be closed has not given its name up. Handing it
  // to a different identity produces two lines with one name the moment that
  // browser reopens, and the rename is the last point where the operator could
  // have chosen differently.
  const entries = [
    { installId: 'inst-closed', label: 'chrome-acme-corp', desiredLabel: 'chrome-acme-corp' },
    { installId: 'inst-live', label: 'brave-alice-example', desiredLabel: 'brave-alice-example' },
  ]
  const isLive = (id) => id === 'inst-live'

  const holder = absentLabelHolder('chrome-acme-corp', entries, { exceptInstallId: 'inst-other', isLive })
  assert.equal(holder.installId, 'inst-closed')

  // A live one is the live table's business, not this check's.
  assert.equal(absentLabelHolder('brave-alice-example', entries, { isLive }), null)
  // Renaming yourself to your own name is not a collision.
  assert.equal(
    absentLabelHolder('chrome-acme-corp', entries, { exceptInstallId: 'inst-closed', isLive }),
    null
  )
  assert.equal(absentLabelHolder('chrome-nobody', entries, { isLive }), null)
})

test('the live table refuses a name another line merely WANTS', () => {
  // Two profiles are suffixed because they both want "chrome-acme-corp". A
  // third line renaming itself to the bare form would make that name ambiguous
  // all over again.
  const table = new RouteTable()
  attach(table, 'inst-a', CHROME_WORK_A)
  attach(table, 'inst-b', CHROME_WORK_B)
  assert.ok(table.labelHolder('chrome-acme-corp', 'inst-c'))
})

/* -------------------------------------------------------------------------- */
/* Board collisions across live AND absent lines                               */
/* -------------------------------------------------------------------------- */

test('a name shared between a connected and a not-connected line is warned about', () => {
  // The blind spot: collision scanning looked at live routes only, so this pair
  // rendered on the board twice under one name with nothing said about it - and
  // "which of these two identical names am I addressing" is the exact question
  // the board exists to answer.
  const notes = collisionNotes([
    { installId: 'live', label: 'chrome-acme-corp', vendorLabel: 'Chrome', profileDir: 'Profile 1', present: true },
    { installId: 'gone', label: 'chrome-acme-corp', vendorLabel: 'Chrome', profileDir: 'Default', present: false },
  ])

  assert.equal(notes.size, 2)
  assert.match(notes.get('live'), /Label collision/)
  assert.match(notes.get('gone'), /not connected/)
})

test('a resolved collision explains why the plain name answers to nothing', () => {
  const notes = collisionNotes([
    { installId: 'a', label: 'chrome-acme-corp-default', desiredLabel: 'chrome-acme-corp', vendorLabel: 'Chrome', profileDir: 'Default', present: true },
    { installId: 'b', label: 'chrome-acme-corp-profile-1', desiredLabel: 'chrome-acme-corp', vendorLabel: 'Chrome', profileDir: 'Profile 1', present: true },
  ])
  assert.equal(notes.size, 2)
  assert.match(notes.get('a'), /nothing answers to it/)
  assert.match(notes.get('a'), /chrome-acme-corp-default/)
})

test('the board note REPLACES the table note, so a collision is never said twice', () => {
  // Two views of one collision: the route table sees live routes only, which is
  // right for the acknowledgement sent to one browser, and the board also sees
  // profiles that are configured but closed. Stacking them would put two
  // sentences about one problem on one line.
  const table = new RouteTable()
  const a = attach(table, 'inst-a', CHROME_WORK_A)
  attach(table, 'inst-b', CHROME_WORK_B)

  // No argument at all: the table's own view, which is what REGISTER_ACK wants.
  assert.match(lineFor(a).warning, /Label collision/)

  const board = lineFor(a, { collisionNote: 'Label collision: the board version.' })
  assert.equal(board.warning, 'Label collision: the board version.')

  // An explicit null means the board looked and found nothing, which has to
  // clear the table's note rather than leave a contradiction on the line.
  assert.equal(lineFor(a, { collisionNote: null }).warning, null)
})

test('a null collision note does not swallow unrelated warnings', () => {
  const table = new RouteTable()
  const route = attach(table, 'inst-a', CHROME_WORK_A)
  route.warnings.push('Vendor not verified from the process tree.')
  assert.equal(
    lineFor(route, { collisionNote: null }).warning,
    'Vendor not verified from the process tree.'
  )
})

test('twenty non-colliding lines produce no collision noise at all', () => {
  const table = new RouteTable()
  for (const [installId, id] of twentyProfiles()) attach(table, installId, id)
  const lines = table.all().map((r) => lineFor(r))
  assert.equal(collisionNotes(lines).size, 0)
})

/* -------------------------------------------------------------------------- */
/* The board line carries what the UI needs to render identity                 */
/* -------------------------------------------------------------------------- */

test('a board line carries the account and the identity-changed flag', () => {
  const table = new RouteTable()
  const route = attach(table, 'inst-chrome', LIVE_CHROME_WORK)
  const line = lineFor(route)

  assert.equal(line.email, 'alice@acme-corp.com', 'the board must be able to say WHO this is')
  assert.equal(line.desiredLabel, 'chrome-acme-corp')
  assert.equal(line.identityChanged, false)

  route.identityChanged = true
  assert.equal(lineFor(route).identityChanged, true)
})
