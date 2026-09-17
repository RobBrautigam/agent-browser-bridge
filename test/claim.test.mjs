/**
 * claim: the command-line claim, which is the options-page click without the
 * click.
 *
 * The one property that cannot bend is that a claim lands on exactly the
 * profile the operator named. Every refusal here exists because the
 * alternative is a Brave line quietly bound to the wrong mailbox, which is the
 * worst failure this system can produce. Everything runs on FIXTURES and a
 * fake broker client; nothing here opens the pipe.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { ERR, OPS } from '../shared/protocol.mjs'
import { claim, describeError, findLine, parseArgs, pickCandidate, renderBoard } from '../scripts/claim.mjs'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** Brave offers every profile directory of its user-data-dir as a candidate. */
const BRAVE_CANDIDATES = Object.freeze([
  { dir: 'Default', name: 'alice.example@mailbox.example', email: null },
  { dir: 'Profile 1', name: 'alice@acme-corp.com', email: null },
  { dir: 'Profile 2', name: 'hello@ada.dev', email: null },
  { dir: 'Profile 3', name: 'WriteCo alice.example@mailbox.example', email: null },
])

/** A line in the shape the broker's GET_BOARD emits (routes.mjs lineFor). */
function line(overrides = {}) {
  return {
    installId: 'inst-1',
    label: 'brave-unclaimed-ab12',
    desiredLabel: 'brave-unclaimed-ab12',
    labelIsCustom: false,
    identityChanged: false,
    vendor: 'brave',
    vendorLabel: 'Brave',
    profileDir: null,
    profileName: null,
    email: null,
    link: 'ready',
    present: true,
    claimed: false,
    candidates: BRAVE_CANDIDATES,
    generation: 1,
    tabCount: 3,
    latencyMs: 2,
    lastSeenAt: Date.now(),
    armedUntil: null,
    opCount: 0,
    lastOp: null,
    warning: null,
    ...overrides,
  }
}

/**
 * A broker client that answers GET_BOARD with a fixed board and records every
 * request, so a test can assert what was sent and, more importantly, what was
 * never sent.
 */
function fakeClient({ lines, claimResult } = {}) {
  const calls = []
  return {
    calls,
    async request(spec) {
      calls.push(spec)
      if (spec.op === OPS.GET_BOARD) return { lines, panic: false, now: Date.now() }
      if (spec.op === OPS.CLAIM_PROFILE) {
        if (claimResult instanceof Error) throw claimResult
        return claimResult ?? { line: line({ label: 'brave-claimed', claimed: true, profileDir: spec.args.dir }) }
      }
      throw new Error(`unexpected op ${spec.op}`)
    },
    close() {},
  }
}

const sentClaims = (client) => client.calls.filter((c) => c.op === OPS.CLAIM_PROFILE)

/* -------------------------------------------------------------------------- */
/* pickCandidate: exact and unique, or nothing                                 */
/* -------------------------------------------------------------------------- */

test('an exact profile name match picks that one candidate', () => {
  const r = pickCandidate(BRAVE_CANDIDATES, 'alice@acme-corp.com')
  assert.equal(r.ok, true)
  assert.equal(r.candidate.dir, 'Profile 1')
})

test('an exact email match picks that one candidate', () => {
  const candidates = [
    { dir: 'Default', name: 'Alice', email: 'alice.example@mailbox.example' },
    { dir: 'Profile 1', name: 'Work', email: 'alice@acme-corp.com' },
  ]
  const r = pickCandidate(candidates, 'alice@acme-corp.com')
  assert.equal(r.ok, true)
  assert.equal(r.candidate.dir, 'Profile 1')
})

test('a substring is not a match', () => {
  // "alice" is one keystroke from three different profiles. Refuse.
  const r = pickCandidate(BRAVE_CANDIDATES, 'alice')
  assert.equal(r.ok, false)
  assert.match(r.message, /0 candidate/)
  assert.doesNotMatch(r.message, /Nearest/)
})

test('a case-different name is refused, and the nearest candidate is named', () => {
  const r = pickCandidate(BRAVE_CANDIDATES, 'Alice@Acme-Corp.com')
  assert.equal(r.ok, false)
  assert.match(r.message, /Nearest: "alice@acme-corp\.com"/)
})

test('a name with surrounding whitespace is refused, and the nearest candidate is named', () => {
  const r = pickCandidate(BRAVE_CANDIDATES, ' alice@acme-corp.com')
  assert.equal(r.ok, false)
  assert.match(r.message, /Nearest: "alice@acme-corp\.com"/)
})

test('two candidates with the same name refuse, naming the count', () => {
  const twins = [
    { dir: 'Profile 1', name: 'work', email: null },
    { dir: 'Profile 2', name: 'work', email: null },
  ]
  const r = pickCandidate(twins, 'work')
  assert.equal(r.ok, false)
  assert.match(r.message, /2 candidate/)
})

test('an empty candidate list refuses', () => {
  const r = pickCandidate([], 'alice@acme-corp.com')
  assert.equal(r.ok, false)
  assert.match(r.message, /offers no profile directories/)
})

test('a malformed candidate list refuses instead of throwing', () => {
  assert.equal(pickCandidate(null, 'x').ok, false)
  assert.equal(pickCandidate(undefined, 'x').ok, false)
  assert.equal(pickCandidate('nope', 'x').ok, false)
})

/* -------------------------------------------------------------------------- */
/* findLine: exact label match                                                 */
/* -------------------------------------------------------------------------- */

test('a label is matched exactly and the line comes back', () => {
  const lines = [line({ label: 'brave-unclaimed-ab12' }), line({ label: 'chrome-acme-corp', vendor: 'chrome' })]
  const r = findLine(lines, 'brave-unclaimed-ab12')
  assert.equal(r.ok, true)
  assert.equal(r.line.vendor, 'brave')
})

test('an unknown label refuses and lists the labels that exist', () => {
  const lines = [line({ label: 'brave-unclaimed-ab12' }), line({ label: 'chrome-acme-corp' })]
  const r = findLine(lines, 'brave-unclaimed')
  assert.equal(r.ok, false)
  assert.match(r.message, /brave-unclaimed-ab12/)
  assert.match(r.message, /chrome-acme-corp/)
})

test('a null entry on the board does not crash the refusal message', () => {
  const r = findLine([null, line({ label: 'chrome-acme-corp' })], 'nope')
  assert.equal(r.ok, false)
  assert.match(r.message, /chrome-acme-corp/)
})

test('an empty board refuses with a hint about loading the extension', () => {
  const r = findLine([], 'anything')
  assert.equal(r.ok, false)
  assert.match(r.message, /no profile is connected/i)
})

/* -------------------------------------------------------------------------- */
/* claim: what goes over the pipe, and what never does                         */
/* -------------------------------------------------------------------------- */

test('a good claim sends CLAIM_PROFILE addressed by install id with the matched directory', async () => {
  const client = fakeClient({ lines: [line()] })
  const r = await claim({ client, label: 'brave-unclaimed-ab12', wanted: 'hello@ada.dev' })
  assert.equal(r.ok, true)
  assert.equal(r.line.claimed, true)
  assert.equal(r.line.profileDir, 'Profile 2')

  const [sent] = sentClaims(client)
  assert.ok(sent, 'a CLAIM_PROFILE request was sent')
  // The install id, not the label: a label can be re-resolved by a collision
  // between the two round trips; the install id cannot.
  assert.equal(sent.profile, 'inst-1')
  assert.deepEqual(sent.args, { dir: 'Profile 2' })
  assert.ok(Number.isFinite(sent.timeoutMs) && sent.timeoutMs <= 10_000, 'a command-line deadline is set')
})

test('nothing is sent when the label does not exist', async () => {
  const client = fakeClient({ lines: [line()] })
  const r = await claim({ client, label: 'brave-nope', wanted: 'hello@ada.dev' })
  assert.equal(r.ok, false)
  assert.equal(sentClaims(client).length, 0)
})

test('nothing is sent when the name matches no candidate exactly', async () => {
  const client = fakeClient({ lines: [line()] })
  const r = await claim({ client, label: 'brave-unclaimed-ab12', wanted: 'ada.dev' })
  assert.equal(r.ok, false)
  assert.equal(sentClaims(client).length, 0)
})

test('a line that is known but not connected refuses with "open that browser", not "reload the extension"', async () => {
  // Absent lines carry no candidates; the generic empty-candidates advice
  // would send the operator reloading an extension that is not running.
  const absent = line({ label: 'brave-ada-dev', present: false, link: 'absent', candidates: [] })
  const client = fakeClient({ lines: [absent] })
  const r = await claim({ client, label: 'brave-ada-dev', wanted: 'hello@ada.dev' })
  assert.equal(r.ok, false)
  assert.match(r.message, /not connected right now/)
  assert.doesNotMatch(r.message, /Reload the extension/)
  assert.equal(sentClaims(client).length, 0)
})

test('a line already claimed to the same directory is left alone', async () => {
  const claimed = line({ label: 'brave-ada-dev', claimed: true, profileDir: 'Profile 2', profileName: 'hello@ada.dev' })
  const client = fakeClient({ lines: [claimed] })
  const r = await claim({ client, label: 'brave-ada-dev', wanted: 'hello@ada.dev' })
  assert.equal(r.ok, true)
  assert.equal(r.unchanged, true)
  assert.equal(sentClaims(client).length, 0)
})

test('a line already claimed to a DIFFERENT directory refuses without --reclaim', async () => {
  // Moving a claimed line to another profile is how a label silently changes
  // meaning. It has to be asked for by name.
  const claimed = line({ label: 'brave-ada-dev', claimed: true, profileDir: 'Profile 2', profileName: 'hello@ada.dev' })
  const client = fakeClient({ lines: [claimed] })
  const r = await claim({ client, label: 'brave-ada-dev', wanted: 'alice@acme-corp.com' })
  assert.equal(r.ok, false)
  assert.match(r.message, /--reclaim/)
  assert.equal(sentClaims(client).length, 0)

  const forced = await claim({ client, label: 'brave-ada-dev', wanted: 'alice@acme-corp.com', reclaim: true })
  assert.equal(forced.ok, true)
  assert.deepEqual(sentClaims(client)[0].args, { dir: 'Profile 1' })
})

test('a broker refusal comes back as a typed failure with the broker\'s own words, not a throw', async () => {
  const err = Object.assign(new Error('"Profile 9" is not one of the profile directories this browser offers.'), {
    code: ERR.BAD_REQUEST,
  })
  const client = fakeClient({ lines: [line()], claimResult: err })
  const r = await claim({ client, label: 'brave-unclaimed-ab12', wanted: 'hello@ada.dev' })
  assert.equal(r.ok, false)
  assert.match(r.message, /Profile 9/)
})

test('a claim whose answer names a different directory is reported as a failure', async () => {
  // The broker's reply is the only proof the claim landed.
  const wrong = { line: line({ label: 'brave-acme-corp', claimed: true, profileDir: 'Profile 1' }) }
  const client = fakeClient({ lines: [line()], claimResult: wrong })
  const r = await claim({ client, label: 'brave-unclaimed-ab12', wanted: 'hello@ada.dev' })
  assert.equal(r.ok, false)
  assert.match(r.message, /Profile 1/)
})

test('a claim whose answer is a different line is reported as a failure', async () => {
  const other = { line: line({ installId: 'inst-2', label: 'brave-ada-dev', claimed: true, profileDir: 'Profile 2' }) }
  const client = fakeClient({ lines: [line()], claimResult: other })
  const r = await claim({ client, label: 'brave-unclaimed-ab12', wanted: 'hello@ada.dev' })
  assert.equal(r.ok, false)
})

/* -------------------------------------------------------------------------- */
/* describeError: the operator gets the actionable text the model gets         */
/* -------------------------------------------------------------------------- */

test('a stopped broker is explained with the start command, not a bare code', () => {
  const err = Object.assign(new Error('Cannot reach the broker (ENOENT).'), { code: ERR.NO_BROKER })
  const text = describeError(err)
  assert.match(text, /broker is not running/)
  assert.match(text, /Start it with/)
})

test('an untyped error is printed as it is', () => {
  assert.equal(describeError(new Error('boom')), 'boom')
})

/* -------------------------------------------------------------------------- */
/* parseArgs and renderBoard                                                   */
/* -------------------------------------------------------------------------- */

test('no arguments means list, and so does --list on its own', () => {
  assert.deepEqual(parseArgs([]), { mode: 'list' })
  assert.deepEqual(parseArgs(['--list']), { mode: 'list' })
})

test('--list with anything else is a usage error, never a claim', () => {
  assert.equal(parseArgs(['--list', 'brave-unclaimed-ab12', 'hello@ada.dev']).mode, 'usage')
  assert.equal(parseArgs(['a', 'b', '--list']).mode, 'usage')
  assert.equal(parseArgs(['--list', '--reclaim']).mode, 'usage')
})

test('a label and a name mean claim; --reclaim is the only flag', () => {
  assert.deepEqual(parseArgs(['brave-unclaimed-ab12', 'hello@ada.dev']), {
    mode: 'claim',
    label: 'brave-unclaimed-ab12',
    wanted: 'hello@ada.dev',
    reclaim: false,
  })
  assert.deepEqual(parseArgs(['--reclaim', 'brave-ada-dev', 'alice@acme-corp.com']), {
    mode: 'claim',
    label: 'brave-ada-dev',
    wanted: 'alice@acme-corp.com',
    reclaim: true,
  })
})

test('one argument, three arguments, --reclaim alone, or an unknown flag is a usage error', () => {
  assert.equal(parseArgs(['brave-unclaimed-ab12']).mode, 'usage')
  assert.equal(parseArgs(['a', 'b', 'c']).mode, 'usage')
  assert.equal(parseArgs(['--reclaim']).mode, 'usage')
  assert.equal(parseArgs(['--force', 'a', 'b']).mode, 'usage')
  assert.equal(parseArgs(['--help']).mode, 'usage')
})

test('renderBoard shows every line, warnings included, and the candidates of the unclaimed ones only', () => {
  const claimed = line({
    installId: 'inst-2',
    label: 'chrome-acme-corp',
    vendor: 'chrome',
    vendorLabel: 'Chrome',
    claimed: true,
    profileDir: 'Profile 1',
    email: 'alice@acme-corp.com',
    candidates: [{ dir: 'Profile 1', name: 'Work', email: 'alice@acme-corp.com' }],
    warning: 'Label collision: another profile derives this name',
  })
  const out = renderBoard({ lines: [line(), claimed] })
  assert.match(out, /brave-unclaimed-ab12/)
  assert.match(out, /unclaimed/)
  assert.match(out, /Profile 2 +hello@ada\.dev/)
  assert.match(out, /chrome-acme-corp/)
  assert.match(out, /Label collision/)
  // The claimed Chrome line's single candidate is not listed as a choice.
  assert.doesNotMatch(out, /Profile 1 +Work/)
})

test('renderBoard leaves absent lines out of the choices and says when nothing needs claiming', () => {
  const absent = line({ label: 'brave-ada-dev', present: false, link: 'absent', candidates: [] })
  const out = renderBoard({ lines: [absent, line({ installId: 'inst-3', label: 'brave-ok', claimed: true, profileDir: 'Default' })] })
  assert.match(out, /Every connected line is claimed/)
  assert.doesNotMatch(out, /Claim one with/)
  assert.match(renderBoard({ lines: [] }), /No browser profiles are connected/)
})
