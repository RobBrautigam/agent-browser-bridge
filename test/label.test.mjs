/**
 * label: the board's rename, from the command line.
 *
 * A rename changes what every tab handle and every skill that names the
 * profile means, so the script sends exactly one SET_LABEL for exactly the line
 * that was named, and nothing when anything is off. Fixtures and a fake broker
 * client only; nothing here opens the pipe.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { ERR, OPS } from '../shared/protocol.mjs'
import { parseArgs, rename, validLabel } from '../scripts/label.mjs'

function line(overrides = {}) {
  return {
    installId: 'inst-1',
    label: 'chrome-acme-corp-profile-1',
    desiredLabel: 'chrome-acme-corp',
    labelIsCustom: false,
    vendor: 'chrome',
    vendorLabel: 'Chrome',
    profileDir: 'Profile 1',
    profileName: 'Work',
    email: 'alice@acme-corp.com',
    link: 'ready',
    present: true,
    claimed: true,
    candidates: [],
    generation: 4,
    ...overrides,
  }
}

function fakeClient({ lines, renameResult } = {}) {
  const calls = []
  return {
    calls,
    async request(spec) {
      calls.push(spec)
      if (spec.op === OPS.GET_BOARD) return { lines, panic: false, now: Date.now() }
      if (spec.op === OPS.SET_LABEL) {
        if (renameResult instanceof Error) throw renameResult
        return (
          renameResult ?? {
            line: line({ label: spec.args.label, desiredLabel: spec.args.label, labelIsCustom: true, generation: 5 }),
            handlesInvalidated: true,
          }
        )
      }
      throw new Error(`unexpected op ${spec.op}`)
    },
    close() {},
  }
}

const sentRenames = (client) => client.calls.filter((c) => c.op === OPS.SET_LABEL)

/* -------------------------------------------------------------------------- */
/* validLabel: the contract's rule, checked before anything is sent            */
/* -------------------------------------------------------------------------- */

test('a label is 1 to 32 lowercase letters, digits and hyphens, starting with a letter or digit', () => {
  assert.equal(validLabel('chrome-acme-corp'), true)
  assert.equal(validLabel('a'), true)
  assert.equal(validLabel('x'.repeat(32)), true)
  assert.equal(validLabel('x'.repeat(33)), false)
  assert.equal(validLabel('-leading'), false)
  assert.equal(validLabel('Chrome-Acme'), false)
  assert.equal(validLabel('acme corp'), false)
  assert.equal(validLabel('acme_corp'), false)
  assert.equal(validLabel(''), false)
  assert.equal(validLabel(null), false)
})

/* -------------------------------------------------------------------------- */
/* rename: what goes over the pipe, and what never does                        */
/* -------------------------------------------------------------------------- */

test('a good rename sends SET_LABEL addressed by install id with the new label', async () => {
  const client = fakeClient({ lines: [line()] })
  const r = await rename({ client, label: 'chrome-acme-corp-profile-1', newLabel: 'chrome-acme-corp' })
  assert.equal(r.ok, true)
  assert.equal(r.line.label, 'chrome-acme-corp')
  assert.equal(r.line.labelIsCustom, true)

  const [sent] = sentRenames(client)
  assert.ok(sent, 'a SET_LABEL request was sent')
  assert.equal(sent.profile, 'inst-1')
  assert.deepEqual(sent.args, { label: 'chrome-acme-corp' })
  assert.ok(Number.isFinite(sent.timeoutMs) && sent.timeoutMs <= 10_000, 'a command-line deadline is set')
})

test('a pasted trailing space is trimmed the way the broker trims it', async () => {
  const client = fakeClient({ lines: [line()] })
  const r = await rename({ client, label: 'chrome-acme-corp-profile-1', newLabel: 'chrome-acme-corp ' })
  assert.equal(r.ok, true)
  assert.deepEqual(sentRenames(client)[0].args, { label: 'chrome-acme-corp' })
})

test('pinning the name a line already has still sends the rename, because custom is what pins it', async () => {
  // A derived label is lost to a suffix the moment a second profile derives
  // the same name. Marking it custom is the whole point of this call, so an
  // equal name is not a no-op.
  const client = fakeClient({ lines: [line({ label: 'chrome-acme-corp', labelIsCustom: false })] })
  const r = await rename({ client, label: 'chrome-acme-corp', newLabel: 'chrome-acme-corp' })
  assert.equal(r.ok, true)
  assert.equal(sentRenames(client).length, 1)
})

test('a line that already holds that name as a custom label is left alone', async () => {
  // Sending it again would bump the generation and kill every open tab
  // handle for nothing.
  const client = fakeClient({ lines: [line({ label: 'chrome-acme-corp', labelIsCustom: true })] })
  const r = await rename({ client, label: 'chrome-acme-corp', newLabel: 'chrome-acme-corp' })
  assert.equal(r.ok, true)
  assert.equal(r.unchanged, true)
  assert.equal(sentRenames(client).length, 0)
})

test('nothing is sent when the current label does not exist', async () => {
  const client = fakeClient({ lines: [line()] })
  const r = await rename({ client, label: 'chrome-nope', newLabel: 'chrome-acme-corp' })
  assert.equal(r.ok, false)
  assert.equal(sentRenames(client).length, 0)
})

test('nothing is sent when the new label breaks the rule', async () => {
  const client = fakeClient({ lines: [line()] })
  const r = await rename({ client, label: 'chrome-acme-corp-profile-1', newLabel: 'Chrome Acme' })
  assert.equal(r.ok, false)
  assert.match(r.message, /lowercase/)
  assert.equal(sentRenames(client).length, 0)
})

test('a line that is known but not connected refuses with "open that browser"', async () => {
  // The broker routes only to live lines; sending anyway would come back as
  // "unknown profile", the wrong diagnosis for a closed browser.
  const absent = line({ present: false, link: 'absent' })
  const client = fakeClient({ lines: [absent] })
  const r = await rename({ client, label: 'chrome-acme-corp-profile-1', newLabel: 'chrome-acme-corp' })
  assert.equal(r.ok, false)
  assert.match(r.message, /not connected right now/)
  assert.equal(sentRenames(client).length, 0)
})

test('a name held by another line is the broker\'s refusal, rendered with its own words', async () => {
  // The broker owns that rule (live and absent holders both); the script does
  // not keep a second copy of it.
  const err = Object.assign(new Error('"chrome-acme-corp" is already used by Chrome Profile 3. Pick another name or rename that one first.'), {
    code: ERR.BAD_REQUEST,
  })
  const client = fakeClient({ lines: [line()], renameResult: err })
  const r = await rename({ client, label: 'chrome-acme-corp-profile-1', newLabel: 'chrome-acme-corp' })
  assert.equal(r.ok, false)
  assert.match(r.message, /Profile 3/)
  assert.equal(sentRenames(client).length, 1)
})

test('an answer that does not carry the new label is reported as a failure', async () => {
  const wrong = { line: line({ label: 'chrome-acme-corp-profile-1' }), handlesInvalidated: true }
  const client = fakeClient({ lines: [line()], renameResult: wrong })
  const r = await rename({ client, label: 'chrome-acme-corp-profile-1', newLabel: 'chrome-acme-corp' })
  assert.equal(r.ok, false)
})

test('an answer from a different line is reported as a failure', async () => {
  const other = { line: line({ installId: 'inst-2', label: 'chrome-acme-corp', labelIsCustom: true }), handlesInvalidated: true }
  const client = fakeClient({ lines: [line()], renameResult: other })
  const r = await rename({ client, label: 'chrome-acme-corp-profile-1', newLabel: 'chrome-acme-corp' })
  assert.equal(r.ok, false)
})

/* -------------------------------------------------------------------------- */
/* parseArgs                                                                   */
/* -------------------------------------------------------------------------- */

test('exactly two positional arguments, no flags', () => {
  assert.deepEqual(parseArgs(['chrome-acme-corp-profile-1', 'chrome-acme-corp']), {
    mode: 'rename',
    label: 'chrome-acme-corp-profile-1',
    newLabel: 'chrome-acme-corp',
  })
  assert.equal(parseArgs([]).mode, 'usage')
  assert.equal(parseArgs(['one']).mode, 'usage')
  assert.equal(parseArgs(['a', 'b', 'c']).mode, 'usage')
  assert.equal(parseArgs(['--force', 'a', 'b']).mode, 'usage')
  assert.equal(parseArgs(['--help']).mode, 'usage')
})
