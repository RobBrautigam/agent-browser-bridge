/**
 * snapshot-tabs: the merge of the tab and group listings, and the two-operation
 * read-only vocabulary, against a fake broker that records what it was sent.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { OPS } from '../shared/protocol.mjs'
import { SNAPSHOT_OPS, buildSnapshot, parseArgs, snapshotTabs } from '../scripts/snapshot-tabs.mjs'

const listedTabs = {
  tabs: [
    { handle: 'tab_chrome-work_1_9', windowId: 2, index: 0, title: 'Mail', url: 'https://mail.example.com/', groupId: -1, pinned: true, active: false, lastAccessed: 5 },
    { handle: 'tab_chrome-work_1_4', windowId: 1, index: 1, title: 'Doc', url: 'https://example.com/doc', groupId: 7, active: true, audible: false, discarded: false, lastAccessed: 9 },
    { handle: 'tab_chrome-work_1_3', windowId: 1, index: 0, title: 'Spec', url: 'https://example.com/spec', groupId: 7, discarded: true },
  ],
}
const listedGroups = {
  windows: [
    { windowId: 1, tabs: 2, pinned: 0, loose: 0, groups: [{ groupId: 7, title: 'Launch', color: 'blue', collapsed: false, index: 0, count: 2 }] },
    { windowId: 2, tabs: 1, pinned: 1, loose: 0, groups: [] },
  ],
}

function fakeBroker() {
  const calls = []
  return {
    calls,
    async request(msg) {
      calls.push(msg)
      if (msg.op === OPS.LIST_TABS) return listedTabs
      if (msg.op === OPS.LIST_GROUPS) return listedGroups
      throw new Error(`the fake broker was sent ${msg.op}`)
    },
  }
}

test('the snapshot names each tab\'s group and sorts by window and position', () => {
  const snap = buildSnapshot('chrome-work', listedTabs, listedGroups, new Date(0))
  assert.equal(snap.count, 3)
  assert.equal(snap.readAt, '1970-01-01T00:00:00.000Z')
  assert.deepEqual(snap.tabs.map((t) => t.handle), ['tab_chrome-work_1_3', 'tab_chrome-work_1_4', 'tab_chrome-work_1_9'])
  assert.equal(snap.tabs[0].group, 'Launch')
  assert.equal(snap.tabs[0].groupColor, 'blue')
  assert.equal(snap.tabs[0].discarded, true)
  assert.equal(snap.tabs[2].group, null, 'a tab in no group carries no group title')
  assert.equal(snap.tabs[2].pinned, true)
  assert.equal(snap.tabs[0].lastAccessed, null)
  assert.equal(snap.windows.length, 2)
})

test('a snapshot sends the two list operations and nothing else', async () => {
  const broker = fakeBroker()
  const snap = await snapshotTabs({ client: broker, profile: 'chrome-work' })
  assert.deepEqual(broker.calls.map((c) => c.op), [OPS.LIST_TABS, OPS.LIST_GROUPS])
  assert.ok(broker.calls.every((c) => c.profile === 'chrome-work'))
  assert.equal(snap.count, 3)
  assert.deepEqual([...SNAPSHOT_OPS].sort(), [OPS.LIST_GROUPS, OPS.LIST_TABS].sort())
})

test('the source names no operation outside the two it lists', () => {
  const source = fs.readFileSync(new URL('../scripts/snapshot-tabs.mjs', import.meta.url), 'utf8')
  for (const [name] of Object.entries(OPS).filter(([, op]) => !SNAPSHOT_OPS.includes(op))) {
    assert.equal(new RegExp(`OPS\\.${name}\\b`).test(source), false, `OPS.${name} appears in snapshot-tabs.mjs`)
  }
})

test('empty or missing listings give an empty snapshot, not a crash', () => {
  const snap = buildSnapshot('p', undefined, {})
  assert.equal(snap.count, 0)
  assert.deepEqual(snap.windows, [])
})

test('arguments: one profile label, known flags only', () => {
  assert.deepEqual(parseArgs(['chrome-work']), { mode: 'run', profile: 'chrome-work', socket: undefined })
  assert.equal(parseArgs([]).mode, 'usage')
  assert.equal(parseArgs(['a', 'b']).mode, 'usage')
  assert.equal(parseArgs(['a', '--all']).mode, 'usage')
})
