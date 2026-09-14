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

import { OPS } from '../shared/protocol.mjs'
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

/* -------------------------------------------------------------------------- */
/* validLabel: the broker's rule, checked before anything is sent              */
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

test('a good rename sends SET_LABEL for that line with the new label', async () => {
  const client = fakeClient({ lines: [line()] })
  const r = await rename({ client, label: 'chrome-acme-corp-profile-1', newLabel: 'chrome-acme-corp' })
  assert.equal(r.ok, true)
  assert.equal(r.line.label, 'chrome-acme-corp')
  assert.equal(r.line.labelIsCustom, true)

  const sent = client.calls.find((c) => c.op === OPS.SET_LABEL)
  assert.ok(sent, 'a SET_LABEL request was sent')
  assert.equal(sent.profile, 'chrome-acme-corp-profile-1')
  assert.deepEqual(sent.args, { label: 'chrome-acme-corp' })
})

test('pinning the name a line already has still sends the rename, because custom is what pins it', async () => {
  // A derived label is lost to a suffix the moment a second profile derives
  // the same name. Marking it custom is the whole point of this call, so an
  // equal name is not a no-op.
  const client = fakeClient({ lines: [line({ label: 'chrome-acme-corp', labelIsCustom: false })] })
  const r = await rename({ client, label: 'chrome-acme-corp', newLabel: 'chrome-acme-corp' })
  assert.equal(r.ok, true)
  assert.equal(client.calls.filter((c) => c.op === OPS.SET_LABEL).length, 1)
})

test('a line that already holds that name as a custom label is left alone', async () => {
  const client = fakeClient({ lines: [line({ label: 'chrome-acme-corp', labelIsCustom: true })] })
  const r = await rename({ client, label: 'chrome-acme-corp', newLabel: 'chrome-acme-corp' })
  assert.equal(r.ok, true)
  assert.equal(r.unchanged, true)
  assert.equal(client.calls.filter((c) => c.op === OPS.SET_LABEL).length, 0)
})

test('nothing is sent when the current label does not exist', async () => {
  const client = fakeClient({ lines: [line()] })
  const r = await rename({ client, label: 'chrome-nope', newLabel: 'chrome-acme-corp' })
  assert.equal(r.ok, false)
  assert.equal(client.calls.filter((c) => c.op === OPS.SET_LABEL).length, 0)
})

test('nothing is sent when the new label breaks the rule', async () => {
  const client = fakeClient({ lines: [line()] })
  const r = await rename({ client, label: 'chrome-acme-corp-profile-1', newLabel: 'Chrome Acme' })
  assert.equal(r.ok, false)
  assert.match(r.message, /lowercase/)
  assert.equal(client.calls.filter((c) => c.op === OPS.SET_LABEL).length, 0)
})

test('nothing is sent when another connected line already holds the new label', async () => {
  // The broker refuses this too, but refusing here names the holder before a
  // request is even made.
  const lines = [line(), line({ installId: 'inst-2', label: 'chrome-acme-corp', profileDir: 'Profile 3' })]
  const client = fakeClient({ lines })
  const r = await rename({ client, label: 'chrome-acme-corp-profile-1', newLabel: 'chrome-acme-corp' })
  assert.equal(r.ok, false)
  assert.match(r.message, /Profile 3/)
  assert.equal(client.calls.filter((c) => c.op === OPS.SET_LABEL).length, 0)
})

test('a broker refusal comes back as a typed failure, not a throw', async () => {
  const err = Object.assign(new Error('"chrome-acme-corp" belongs to a profile that is not connected right now.'), {
    code: 'E_BAD_REQUEST',
  })
  const client = fakeClient({ lines: [line()], renameResult: err })
  const r = await rename({ client, label: 'chrome-acme-corp-profile-1', newLabel: 'chrome-acme-corp' })
  assert.equal(r.ok, false)
  assert.match(r.message, /E_BAD_REQUEST/)
})

test('an answer that does not carry the new label is reported as a failure', async () => {
  const wrong = { line: line({ label: 'chrome-acme-corp-profile-1' }), handlesInvalidated: true }
  const client = fakeClient({ lines: [line()], renameResult: wrong })
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
})
