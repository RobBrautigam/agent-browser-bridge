/**
 * Sort by age, per window: the planner and the open-time ledger.
 *
 * Both are pure and both run in Node, because the rule that rearranges a
 * person's tab strip should be proven by tests rather than by driving a
 * browser. The planner lives in the contract (shared/protocol.mjs, mirrored in
 * extension/lib/protocol.js); the ledger's rules live in extension/lib/tab-ages.js,
 * whose chrome-bound half is only ever called inside the extension.
 *
 * The cases are the ones a tab sorter gets wrong: pinned tabs dragged out of
 * place, a tab group split apart or placed by its newest tab, index arithmetic
 * that drifts as tabs shift underneath it, and a browser restart that hands
 * every tab a new id so a ledger keyed by id forgets everything.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import * as shared from '../shared/protocol.mjs'
import * as mirror from '../extension/lib/protocol.js'
import { forgetTab, openedTimes, recordOpened, refreshPositions, rekeyLedger, shortUrl } from '../extension/lib/tab-ages.js'

const { AGE_SOURCE, describeWindowSort, planWindowSort } = shared

/** Apply a plan the way the extension does: each moved unit to the end, in order. */
function simulate(tabs, plan) {
  let strip = tabs.slice().sort((a, b) => a.index - b.index).map((t) => t.tabId)
  for (const unit of plan.moves) {
    strip = strip.filter((id) => !unit.tabIds.includes(id))
    strip.push(...unit.tabIds)
  }
  return strip
}

const tab = (tabId, index, extra = {}) => ({ tabId, index, groupId: -1, pinned: false, ...extra })

test('tabs end up oldest on the left, newest on the right', () => {
  const tabs = [tab(1, 0), tab(2, 1), tab(3, 2), tab(4, 3)]
  const ages = { 1: 400, 2: 100, 3: 300, 4: 200 }
  const plan = planWindowSort({ tabs, ages })
  assert.deepEqual(simulate(tabs, plan), [2, 4, 3, 1])
  assert.equal(plan.sources[AGE_SOURCE.GIVEN], 4)
})

test('a window already in age order needs no moves at all', () => {
  const tabs = [tab(1, 0), tab(2, 1), tab(3, 2)]
  const plan = planWindowSort({ tabs, ages: { 1: 1, 2: 2, 3: 3 } })
  assert.equal(plan.moves.length, 0)
  // And a window whose oldest tabs are already on the left moves only the rest.
  const partly = planWindowSort({ tabs, ages: { 1: 1, 2: 3, 3: 2 } })
  assert.deepEqual(partly.moves.map((u) => u.tabIds), [[3], [2]])
})

test('pinned tabs are left where they are, however old the others are', () => {
  const tabs = [tab(10, 0, { pinned: true }), tab(11, 1, { pinned: true }), tab(1, 2), tab(2, 3)]
  const plan = planWindowSort({ tabs, ages: { 10: 999, 11: 998, 1: 50, 2: 5 } })
  assert.equal(plan.pinned, 2)
  for (const unit of plan.units) assert.ok(!unit.tabIds.includes(10) && !unit.tabIds.includes(11))
  assert.deepEqual(simulate(tabs, plan), [10, 11, 2, 1])
})

test('a tab group moves as one block, placed by its OLDEST tab, its own order kept', () => {
  const tabs = [
    tab(1, 0, { groupId: 7 }),
    tab(2, 1, { groupId: 7 }),
    tab(3, 2),
    tab(4, 3),
  ]
  // The group's tabs are 900 and 100 old: it belongs where 100 belongs, after
  // tab 4 (50) and before tab 3 (500), and its tabs stay in the order 1, 2.
  const plan = planWindowSort({ tabs, ages: { 1: 900, 2: 100, 3: 500, 4: 50 } })
  const group = plan.units.find((u) => u.kind === 'group')
  assert.deepEqual(group.tabIds, [1, 2])
  assert.equal(group.groupId, 7)
  assert.equal(group.age, 100)
  assert.deepEqual(simulate(tabs, plan), [4, 1, 2, 3])
})

test('two groups and loose tabs interleave by age, every group intact', () => {
  const tabs = [
    tab(1, 0, { groupId: 5 }),
    tab(2, 1, { groupId: 5 }),
    tab(3, 2, { groupId: 6 }),
    tab(4, 3, { groupId: 6 }),
    tab(5, 4),
  ]
  const plan = planWindowSort({ tabs, ages: { 1: 30, 2: 40, 3: 10, 4: 50, 5: 20 } })
  assert.deepEqual(simulate(tabs, plan), [3, 4, 5, 1, 2])
})

test('a split view outside a group moves as one unit', () => {
  const tabs = [tab(1, 0, { splitViewId: 3 }), tab(2, 1, { splitViewId: 3 }), tab(3, 2)]
  const plan = planWindowSort({ tabs, ages: { 1: 50, 2: 60, 3: 10 } })
  assert.deepEqual(simulate(tabs, plan), [3, 1, 2])
  assert.equal(plan.units.find((u) => u.kind === 'split').tabIds.length, 2)
})

test('a tab\'s age comes from the caller, then the ledger, then lastAccessed', () => {
  const tabs = [
    tab(1, 0, { lastAccessed: 5_000 }),
    tab(2, 1, { lastAccessed: 1_000 }),
    tab(3, 2, { lastAccessed: 9_000 }),
    tab(4, 3),
  ]
  const plan = planWindowSort({
    tabs,
    ages: { 3: 500 }, // the caller knows tab 3 is the oldest of all
    opened: { 1: 2_000, 3: 8_000 }, // the ledger's time for 3 loses to the caller's
  })
  assert.deepEqual(plan.sources, {
    [AGE_SOURCE.GIVEN]: 1,
    [AGE_SOURCE.LEDGER]: 1,
    [AGE_SOURCE.LAST_ACCESSED]: 1,
    [AGE_SOURCE.NONE]: 1,
  })
  // 3 (500, given), 2 (1000, lastAccessed), 1 (2000, ledger), then 4 with no age.
  assert.deepEqual(simulate(tabs, plan), [3, 2, 1, 4])
})

test('tabs with no age at all go to the right, in tab id order, and garbage ages count as none', () => {
  const tabs = [tab(9, 0), tab(4, 1), tab(1, 2, { lastAccessed: 100 })]
  const plan = planWindowSort({ tabs, ages: { 9: 'yesterday', 4: -5 } })
  assert.deepEqual(simulate(tabs, plan), [1, 4, 9])
  assert.equal(plan.sources[AGE_SOURCE.NONE], 2)
})

test('the extension mirror plans exactly what the contract plans', () => {
  const tabs = [
    tab(1, 0, { pinned: true }),
    tab(2, 1, { groupId: 4 }),
    tab(3, 2, { groupId: 4, lastAccessed: 70 }),
    tab(5, 3, { lastAccessed: 20 }),
    tab(6, 4, { splitViewId: 2, lastAccessed: 90 }),
    tab(7, 5, { splitViewId: 2 }),
    tab(8, 6),
  ]
  const spec = { tabs, ages: { 2: 300 }, opened: { 8: 10 } }
  assert.deepEqual(mirror.planWindowSort(spec), shared.planWindowSort(spec))
  const result = { windows: [{ tabs: 7, moved: 2, pinned: 1, sources: shared.planWindowSort(spec).sources }] }
  assert.equal(mirror.describeWindowSort(result), shared.describeWindowSort(result))
})

test('the sentence says what moved, what stayed, and where the ages came from', () => {
  const line = describeWindowSort({
    windows: [
      { tabs: 10, moved: 3, pinned: 2, sources: { given: 0, ledger: 4, lastAccessed: 4, none: 0 } },
      { tabs: 5, moved: 0, pinned: 0, failed: 1, sources: { given: 0, ledger: 5, lastAccessed: 0, none: 0 } },
    ],
  })
  assert.match(line, /2 windows, each on its own/)
  assert.match(line, /15 tabs/)
  assert.match(line, /3 blocks moved/)
  assert.match(line, /2 pinned tabs left where they were/)
  assert.match(line, /1 block could not be moved/)
  assert.match(line, /9 from the recorded open time/)
  assert.match(line, /4 from when the tab was last shown/)
  assert.equal(describeWindowSort({ windows: [] }), 'There was no window to sort.')
})

/* -------------------------------------------------------------------------- */
/* The open-time ledger                                                        */
/* -------------------------------------------------------------------------- */

const live = (id, windowId, index, url) => ({ id, windowId, index, url })

test('the ledger keeps a short address only: no query, no fragment', () => {
  assert.equal(shortUrl('https://mail.example.com/inbox?token=abc#msg-9'), 'https://mail.example.com/inbox')
  assert.equal(shortUrl('not a url'), '')
  assert.ok(shortUrl(`https://example.com/${'a'.repeat(1000)}`).length <= 200)
})

test('an open time is recorded once and never overwritten', () => {
  let ledger = recordOpened({}, live(5, 1, 0, 'https://a.example/x'), 1_000)
  ledger = recordOpened(ledger, live(5, 1, 3, 'https://a.example/y'), 9_000)
  assert.equal(ledger['5'].at, 1_000)
  assert.deepEqual(openedTimes(ledger), { 5: 1_000 })
})

test('closing a tab forgets it, but a window closing (or the browser quitting) does not', () => {
  const ledger = recordOpened({}, live(5, 1, 0, 'https://a.example/'), 1_000)
  assert.deepEqual(forgetTab(ledger, 5, { isWindowClosing: false }), {})
  assert.equal(forgetTab(ledger, 5, { isWindowClosing: true })['5'].at, 1_000)
})

test('positions are refreshed for tabs that moved, without dropping anything', () => {
  let ledger = recordOpened({}, live(5, 1, 0, 'https://a.example/'), 1_000)
  ledger = recordOpened(ledger, live(6, 1, 1, 'https://b.example/'), 2_000)
  const next = refreshPositions(ledger, [live(5, 2, 4, 'https://a.example/moved')])
  assert.deepEqual(next['5'], { at: 1_000, w: 2, i: 4, u: 'https://a.example/moved' })
  assert.equal(next['6'].at, 2_000, 'an entry for a tab not in the list is kept')
})

test('an extension reload keeps every age: same ids, same addresses', () => {
  let ledger = recordOpened({}, live(5, 1, 0, 'https://a.example/'), 1_000)
  ledger = recordOpened(ledger, live(6, 1, 1, 'https://b.example/'), 2_000)
  const { ledger: next, carried } = rekeyLedger(ledger, [live(5, 1, 0, 'https://a.example/'), live(6, 1, 1, 'https://b.example/')])
  assert.equal(carried, 2)
  assert.deepEqual(openedTimes(next), { 5: 1_000, 6: 2_000 })
})

test('a browser restart re-keys ages by window and position, with every id new', () => {
  // Before the restart: two windows. After it: the same two, with new window
  // ids, new tab ids, and the windows listed in the opposite order.
  let before = {}
  before = recordOpened(before, live(11, 100, 0, 'https://a.example/'), 1_000)
  before = recordOpened(before, live(12, 100, 1, 'https://b.example/'), 2_000)
  before = recordOpened(before, live(13, 100, 2, 'https://c.example/'), 3_000)
  before = recordOpened(before, live(21, 200, 0, 'https://d.example/'), 4_000)
  before = recordOpened(before, live(22, 200, 1, 'https://e.example/'), 5_000)
  const after = [
    live(901, 7, 0, 'https://d.example/'),
    live(902, 7, 1, 'https://e.example/'),
    live(801, 8, 0, 'https://a.example/'),
    live(802, 8, 1, 'https://b.example/'),
    live(803, 8, 2, 'https://c.example/'),
  ]
  const { ledger, carried, dropped } = rekeyLedger(before, after)
  assert.equal(carried, 5)
  assert.equal(dropped, 0)
  assert.deepEqual(openedTimes(ledger), { 801: 1_000, 802: 2_000, 803: 3_000, 901: 4_000, 902: 5_000 })
  assert.equal(ledger['901'].w, 7)
})

test('after a restart a tab at a new index keeps its age when its address is unique in the window', () => {
  let before = {}
  before = recordOpened(before, live(1, 50, 0, 'https://a.example/'), 1_000)
  before = recordOpened(before, live(2, 50, 1, 'https://b.example/'), 2_000)
  before = recordOpened(before, live(3, 50, 2, 'https://c.example/'), 3_000)
  const after = [live(70, 9, 0, 'https://a.example/'), live(71, 9, 1, 'https://c.example/'), live(72, 9, 2, 'https://b.example/')]
  const { ledger } = rekeyLedger(before, after)
  assert.deepEqual(openedTimes(ledger), { 70: 1_000, 71: 3_000, 72: 2_000 })
})

test('after a restart an ambiguous address at a new index is dropped rather than guessed', () => {
  let before = {}
  before = recordOpened(before, live(1, 50, 0, 'https://same.example/'), 1_000)
  before = recordOpened(before, live(2, 50, 1, 'https://same.example/'), 2_000)
  before = recordOpened(before, live(3, 50, 2, 'https://x.example/'), 3_000)
  // The two same-address tabs swapped places with a new one: positions 1 and 2
  // no longer hold them, and which is which cannot be told.
  const after = [live(70, 9, 0, 'https://x.example/'), live(71, 9, 1, 'https://new.example/'), live(72, 9, 2, 'https://same.example/'), live(73, 9, 3, 'https://same.example/')]
  const { ledger } = rekeyLedger(before, after)
  assert.equal(ledger['72'], undefined)
  assert.equal(ledger['73'], undefined)
  assert.equal(ledger['71'], undefined)
})

test('a re-key never carries an age into a window it does not match', () => {
  let before = {}
  before = recordOpened(before, live(1, 50, 0, 'https://a.example/'), 1_000)
  const after = [live(70, 9, 0, 'https://other.example/')]
  const { ledger, dropped } = rekeyLedger(before, after)
  assert.deepEqual(ledger, {})
  assert.equal(dropped, 1)
})

test('a recycled tab id with a different address is not the same tab', () => {
  const before = recordOpened({}, live(5, 1, 0, 'https://a.example/'), 1_000)
  const { ledger } = rekeyLedger(before, [live(5, 3, 4, 'https://zzz.example/')])
  assert.equal(ledger['5'], undefined)
})
