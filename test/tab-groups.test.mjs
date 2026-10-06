/**
 * Tab groups: the contract, the extension half, and the plan script.
 *
 * The extension half runs against a fake chrome that models the parts of the
 * tab strip a grouping tool gets wrong: chrome.tabs.group with no window puts
 * a NEW group in the CURRENT window and drags the tabs there; grouping a pinned
 * tab unpins it; a tab moved into the middle of a group joins it; collapsing a
 * group that holds the active tab makes the browser switch tabs. The fake
 * records each of those as an event, so a test can say "this never happened"
 * instead of hoping.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import * as shared from '../shared/protocol.mjs'
import * as mirror from '../extension/lib/protocol.js'

const { OPS, OP_TIER, TIER, BROWSER_OPS, GROUP_COLORS, planGroupOrder } = shared

/* -------------------------------------------------------------------------- */
/* The contract                                                                */
/* -------------------------------------------------------------------------- */

test('the five group operations are in the contract, listing READ and the rest WRITE', () => {
  assert.equal(OPS.LIST_GROUPS, 'listGroups')
  assert.equal(OPS.GROUP_TABS, 'groupTabs')
  assert.equal(OPS.UPDATE_GROUP, 'updateGroup')
  assert.equal(OPS.MOVE_GROUP, 'moveGroup')
  assert.equal(OPS.UNGROUP_TABS, 'ungroupTabs')
  assert.equal(OP_TIER[OPS.LIST_GROUPS], TIER.READ)
  for (const op of [OPS.GROUP_TABS, OPS.UPDATE_GROUP, OPS.MOVE_GROUP, OPS.UNGROUP_TABS]) {
    assert.equal(OP_TIER[op], TIER.WRITE, op)
  }
  for (const op of [OPS.LIST_GROUPS, OPS.GROUP_TABS, OPS.UPDATE_GROUP, OPS.MOVE_GROUP, OPS.UNGROUP_TABS]) {
    assert.ok(BROWSER_OPS.includes(op), `${op} crosses into the extension`)
  }
})

test('the group colors are exactly the nine the browser accepts', () => {
  assert.deepEqual([...GROUP_COLORS].sort(), ['blue', 'cyan', 'green', 'grey', 'orange', 'pink', 'purple', 'red', 'yellow'])
  assert.ok(Object.isFrozen(GROUP_COLORS))
  assert.deepEqual(mirror.GROUP_COLORS, GROUP_COLORS)
})

/** Apply an order plan the way the extension does: each moved tab to the group's end. */
function simulateOrder(current, plan) {
  let strip = current.slice()
  for (const id of plan.moves) {
    strip = strip.filter((x) => x !== id)
    strip.push(id)
  }
  return strip
}

test('an order plan puts the given tabs in the given order, after members it was not given', () => {
  const plan = planGroupOrder({ current: [5, 1, 9, 3], wanted: [3, 1] })
  assert.deepEqual(plan.order, [5, 9, 3, 1])
  assert.deepEqual(simulateOrder([5, 1, 9, 3], plan), plan.order)
})

test('a group already in order is zero moves', () => {
  assert.deepEqual(planGroupOrder({ current: [1, 2, 3], wanted: [1, 2, 3] }).moves, [])
  assert.deepEqual(planGroupOrder({ current: [7, 1, 2], wanted: [1, 2] }).moves, [])
})

test('an order plan ignores a wanted tab that is not in the group, and a repeat', () => {
  const plan = planGroupOrder({ current: [4, 2], wanted: [2, 8, 2, 4] })
  assert.deepEqual(plan.order, [2, 4])
  assert.deepEqual(simulateOrder([4, 2], plan), [2, 4])
})

test('the extension mirror plans the same order as the contract', () => {
  const spec = { current: [10, 11, 12, 13, 14], wanted: [14, 10, 12] }
  assert.deepEqual(mirror.planGroupOrder(spec), planGroupOrder(spec))
})

/* -------------------------------------------------------------------------- */
/* A fake chrome                                                               */
/* -------------------------------------------------------------------------- */

const EDIT_BLOCKED = 'Tabs cannot be edited right now (user may be dragging a tab).'

function fakeChrome({ windows, current, blockEdits = 0 }) {
  // windows: { [windowId]: [{ id, pinned?, active?, group? }] }, group is a key into `groups`
  const events = []
  const strips = new Map()
  const groups = new Map()
  let nextGroup = 900
  const groupIdFor = new Map()
  for (const [wid, tabs] of Object.entries(windows)) {
    const windowId = Number(wid)
    strips.set(
      windowId,
      tabs.map((t) => {
        let groupId = -1
        if (t.group) {
          if (!groupIdFor.has(t.group.key)) {
            const id = nextGroup++
            groupIdFor.set(t.group.key, id)
            groups.set(id, { id, windowId, title: t.group.title, color: t.group.color || 'grey', collapsed: Boolean(t.group.collapsed) })
          }
          groupId = groupIdFor.get(t.group.key)
        }
        return { id: t.id, windowId, pinned: Boolean(t.pinned), active: Boolean(t.active), groupId }
      })
    )
  }
  let blocked = blockEdits
  // A person acting at the moment of an edit: atEdit(n, fn) runs fn as the nth
  // edit from now starts, before the browser applies (or refuses) it.
  let edits = 0
  const hooks = new Map()
  const afterHooks = new Map()
  // afterEdit(n, fn) runs fn once the nth edit from now has been applied.
  const done = () => {
    const hook = afterHooks.get(edits)
    if (hook) {
      afterHooks.delete(edits)
      hook()
    }
  }

  const view = (tab) => {
    const strip = strips.get(tab.windowId)
    return { ...tab, index: strip.indexOf(tab) }
  }
  const find = (id) => {
    for (const strip of strips.values()) {
      const t = strip.find((x) => x.id === id)
      if (t) return t
    }
    return null
  }
  const gate = () => {
    edits += 1
    const hook = hooks.get(edits)
    if (hook) {
      hooks.delete(edits)
      hook()
    }
    if (blocked > 0) {
      blocked -= 1
      throw new Error(EDIT_BLOCKED)
    }
  }
  const prune = () => {
    for (const id of [...groups.keys()]) {
      const any = [...strips.values()].some((s) => s.some((t) => t.groupId === id))
      if (!any) groups.delete(id)
    }
  }
  const moveTo = (tab, windowId, index) => {
    if (tab.windowId !== windowId) events.push({ kind: 'crossWindow', tabId: tab.id, from: tab.windowId, to: windowId })
    const from = strips.get(tab.windowId)
    from.splice(from.indexOf(tab), 1)
    tab.windowId = windowId
    const to = strips.get(windowId)
    const at = index < 0 || index > to.length ? to.length : index
    to.splice(at, 0, tab)
  }
  // Chromium's EnsureGroupContiguity, for a tab that just moved.
  const contiguity = (tab) => {
    const strip = strips.get(tab.windowId)
    const i = strip.indexOf(tab)
    const left = i > 0 ? strip[i - 1].groupId : -1
    const right = i + 1 < strip.length ? strip[i + 1].groupId : -1
    if (tab.groupId !== left && tab.groupId !== right) {
      if (left === right && left !== -1) tab.groupId = left
      else if (tab.groupId !== -1) tab.groupId = -1
    }
  }
  const span = (groupId) => {
    const g = groups.get(groupId)
    const strip = strips.get(g.windowId)
    const idx = strip.map((t, i) => (t.groupId === groupId ? i : -1)).filter((i) => i >= 0)
    return { strip, first: idx[0], last: idx[idx.length - 1] }
  }

  const chrome = {
    windows: {
      async get(id) {
        if (!strips.has(id)) throw new Error(`No window with id: ${id}.`)
        return { id, type: 'normal' }
      },
      async getAll() {
        return [...strips.keys()].map((id) => ({ id, type: 'normal' }))
      },
    },
    tabs: {
      async get(id) {
        const t = find(id)
        if (!t) throw new Error(`No tab with id: ${id}.`)
        return view(t)
      },
      async query(q = {}) {
        const out = []
        for (const [wid, strip] of strips) {
          if (q.windowId !== undefined && q.windowId !== wid) continue
          for (const t of strip) {
            if (q.groupId !== undefined && t.groupId !== q.groupId) continue
            if (q.active !== undefined && t.active !== q.active) continue
            out.push(view(t))
          }
        }
        return out
      },
      async group({ tabIds, groupId, createProperties }) {
        gate()
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
        const tabs = ids.map((id) => {
          const t = find(id)
          if (!t) throw new Error(`No tab with id: ${id}.`)
          return t
        })
        for (const t of tabs) {
          if (t.pinned) {
            events.push({ kind: 'unpinned', tabId: t.id })
            t.pinned = false
          }
        }
        let gid = groupId
        let windowId
        if (gid === undefined) {
          windowId = createProperties && createProperties.windowId !== undefined ? createProperties.windowId : current
          gid = nextGroup++
          groups.set(gid, { id: gid, windowId, title: '', color: 'grey', collapsed: false })
          const ordered = tabs.slice().sort((a, b) => (a.windowId === b.windowId ? view(a).index - view(b).index : 0))
          const anchorTab = ordered.find((t) => t.windowId === windowId)
          let at = anchorTab ? view(anchorTab).index : strips.get(windowId).length
          for (const t of ordered) {
            const before = view(t).index
            const sameWindow = t.windowId === windowId
            moveTo(t, windowId, sameWindow && before < at ? at - 1 : at)
            t.groupId = gid
            at = view(t).index + 1
          }
        } else {
          const g = groups.get(gid)
          if (!g) throw new Error(`No group with id: ${gid}.`)
          windowId = g.windowId
          for (const t of tabs) {
            if (t.groupId === gid) continue
            const { last } = span(gid)
            const before = t.windowId === windowId ? view(t).index : Infinity
            moveTo(t, windowId, before <= last ? last : last + 1)
            t.groupId = gid
          }
        }
        prune()
        done()
        return gid
      },
      async ungroup(tabIds) {
        gate()
        for (const id of Array.isArray(tabIds) ? tabIds : [tabIds]) {
          const t = find(id)
          if (t) t.groupId = -1
        }
        prune()
      },
      async move(tabIds, { index, windowId }) {
        gate()
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
        for (const id of ids) {
          const t = find(id)
          if (!t) throw new Error(`No tab with id: ${id}.`)
          moveTo(t, windowId === undefined ? t.windowId : windowId, index)
          contiguity(t)
        }
        prune()
      },
    },
    tabGroups: {
      async get(id) {
        const g = groups.get(id)
        if (!g) throw new Error(`No group with id: ${id}.`)
        return { ...g }
      },
      async query(q = {}) {
        // The browser matches `title` as a PATTERN, so "*" matches every group.
        const pattern = typeof q.title === 'string' ? new RegExp(`^${q.title.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`) : null
        return [...groups.values()]
          .filter((g) => (q.windowId === undefined || g.windowId === q.windowId) && (!pattern || pattern.test(g.title)))
          .map((g) => ({ ...g }))
      },
      async update(id, props) {
        gate()
        const g = groups.get(id)
        if (!g) throw new Error(`No group with id: ${id}.`)
        if (props.collapsed === true) {
          const holder = strips.get(g.windowId).find((t) => t.active && t.groupId === id)
          if (holder) events.push({ kind: 'activated', from: holder.id })
        }
        Object.assign(g, props)
        return { ...g }
      },
      async move(id, { index, windowId }) {
        gate()
        const g = groups.get(id)
        if (!g) throw new Error(`No group with id: ${id}.`)
        if (windowId !== undefined && windowId !== g.windowId) events.push({ kind: 'crossWindow', group: id, to: windowId })
        const strip = strips.get(g.windowId)
        const members = strip.filter((t) => t.groupId === id)
        const rest = strip.filter((t) => t.groupId !== id)
        const at = index < 0 || index > rest.length ? rest.length : index
        rest.splice(at, 0, ...members)
        strips.set(g.windowId, rest)
        return { ...g }
      },
    },
  }

  const strip = (windowId) => strips.get(windowId).map((t) => t.id)
  const groupOf = (tabId) => {
    const t = find(tabId)
    return t && t.groupId !== -1 ? groups.get(t.groupId) : null
  }
  // What a person does with the mouse, recorded as no event: dragging a tab to
  // another window takes it out of its group; clicking a tab activates it.
  const personMoves = (tabId, windowId) => {
    const t = find(tabId)
    const from = strips.get(t.windowId)
    from.splice(from.indexOf(t), 1)
    t.windowId = windowId
    t.groupId = -1
    t.active = false
    strips.get(windowId).push(t)
    prune()
  }
  const personActivates = (tabId) => {
    const t = find(tabId)
    for (const x of strips.get(t.windowId)) x.active = false
    t.active = true
  }
  const atEdit = (n, fn) => hooks.set(edits + n, fn)
  const afterEdit = (n, fn) => afterHooks.set(edits + n, fn)
  return { chrome, events, strip, groupOf, groups, atEdit, afterEdit, personMoves, personActivates }
}

async function loadGroups(fake) {
  globalThis.chrome = fake.chrome
  return import('../extension/lib/tab-groups.js')
}

const W1 = 100
const W2 = 200

/* -------------------------------------------------------------------------- */
/* The extension half                                                          */
/* -------------------------------------------------------------------------- */

test('a new group is made in the tabs\' own window, never the current one, in the order given', async () => {
  const fake = fakeChrome({
    windows: { [W1]: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], [W2]: [{ id: 9 }] },
    current: W2,
  })
  const g = await loadGroups(fake)
  const result = await g.groupTabs({ tabIds: [3, 1], title: 'Decide', color: 'red' })
  assert.equal(result.created, true)
  assert.equal(result.group.windowId, W1)
  assert.equal(result.group.title, 'Decide')
  assert.equal(result.group.color, 'red')
  assert.deepEqual(fake.events.filter((e) => e.kind === 'crossWindow'), [])
  const members = fake.strip(W1).filter((id) => fake.groupOf(id)?.title === 'Decide')
  assert.deepEqual(members, [3, 1])
  assert.deepEqual(fake.strip(W2), [9])
})

test('tabs from two windows are refused before anything moves', async () => {
  const fake = fakeChrome({ windows: { [W1]: [{ id: 1 }], [W2]: [{ id: 9 }] }, current: W1 })
  const g = await loadGroups(fake)
  await assert.rejects(g.groupTabs({ tabIds: [1, 9], title: 'Decide' }), (err) => err.code === 'E_BAD_REQUEST' && /window/.test(err.message))
  assert.equal(fake.groups.size, 0)
  assert.deepEqual(fake.events, [])
})

test('a pinned tab is refused, because grouping it would unpin it', async () => {
  const fake = fakeChrome({ windows: { [W1]: [{ id: 1, pinned: true }, { id: 2 }] }, current: W1 })
  const g = await loadGroups(fake)
  await assert.rejects(g.groupTabs({ tabIds: [2, 1], title: 'Decide' }), (err) => err.code === 'E_BAD_REQUEST' && /pinned/.test(err.message))
  assert.deepEqual(fake.events, [])
})

test('an existing group is reused by its exact title in the same window only', async () => {
  const fake = fakeChrome({
    windows: {
      [W1]: [{ id: 1, group: { key: 'a', title: 'Read later' } }, { id: 2 }, { id: 3, group: { key: 'b', title: 'Read' } }],
      [W2]: [{ id: 9, group: { key: 'c', title: 'Decide' } }],
    },
    current: W2,
  })
  const g = await loadGroups(fake)
  const reused = await g.groupTabs({ tabIds: [2], title: 'Read later' })
  assert.equal(reused.created, false)
  assert.equal(fake.groupOf(2).title, 'Read later')
  assert.equal(fake.groupOf(2).id, fake.groupOf(1).id)

  // "Decide" exists only in the other window: a new group here, nothing crosses.
  const fresh = await g.groupTabs({ tabIds: [3], title: 'Decide' })
  assert.equal(fresh.created, true)
  assert.equal(fresh.group.windowId, W1)
  assert.deepEqual(fake.events.filter((e) => e.kind === 'crossWindow'), [])

  // A title with a pattern character matches itself, not every group.
  const star = await g.groupTabs({ tabIds: [1], title: '*' })
  assert.equal(star.created, true)
})

test('tabs added to a reused group land after its members, in the order given', async () => {
  const fake = fakeChrome({
    windows: { [W1]: [{ id: 5 }, { id: 1, group: { key: 'a', title: 'Work' } }, { id: 6 }, { id: 7 }, { id: 2, group: { key: 'a', title: 'Work' } }] },
    current: W1,
  })
  const g = await loadGroups(fake)
  const result = await g.groupTabs({ tabIds: [7, 5, 6], title: 'Work' })
  const members = fake.strip(W1).filter((id) => fake.groupOf(id)?.title === 'Work')
  assert.deepEqual(members, [1, 2, 7, 5, 6])
  assert.equal(result.group.count, 5)
})

test('a collapse is skipped for the group that holds the active tab, and said so', async () => {
  const fake = fakeChrome({ windows: { [W1]: [{ id: 1, active: true }, { id: 2 }, { id: 3 }] }, current: W1 })
  const g = await loadGroups(fake)
  const held = await g.groupTabs({ tabIds: [1, 2], title: 'Read later', collapsed: true })
  assert.equal(held.group.collapsed, false)
  assert.match(held.note, /active tab/)
  const other = await g.groupTabs({ tabIds: [3], title: 'Already done?', collapsed: true })
  assert.equal(other.group.collapsed, true)
  assert.deepEqual(fake.events.filter((e) => e.kind === 'activated'), [])

  const again = await g.updateGroup({ group: held.group.groupId, collapsed: true })
  assert.equal(again.group.collapsed, false)
  assert.deepEqual(fake.events.filter((e) => e.kind === 'activated'), [])
})

test('a group moves within its own window only', async () => {
  const fake = fakeChrome({
    windows: { [W1]: [{ id: 1, group: { key: 'a', title: 'A' } }, { id: 2 }, { id: 3 }], [W2]: [{ id: 9 }] },
    current: W2,
  })
  const g = await loadGroups(fake)
  const groupId = fake.groupOf(1).id
  const result = await g.moveGroup({ group: groupId, index: -1 })
  assert.deepEqual(fake.strip(W1), [2, 3, 1])
  assert.equal(result.group.index, 2)
  assert.deepEqual(fake.events.filter((e) => e.kind === 'crossWindow'), [])
  await assert.rejects(g.moveGroup({ group: groupId, index: 'end' }), (err) => err.code === 'E_BAD_REQUEST')
  await assert.rejects(g.moveGroup({ group: 4242, index: 0 }), (err) => err.code === 'E_BAD_REQUEST' && /4242/.test(err.message))
})

test('an update checks its color and title before it touches the group', async () => {
  const fake = fakeChrome({ windows: { [W1]: [{ id: 1, group: { key: 'a', title: 'A' } }] }, current: W1 })
  const g = await loadGroups(fake)
  const groupId = fake.groupOf(1).id
  await assert.rejects(g.updateGroup({ group: groupId, color: 'magenta' }), (err) => err.code === 'E_BAD_REQUEST' && /grey/.test(err.message))
  await assert.rejects(g.updateGroup({ group: groupId }), (err) => err.code === 'E_BAD_REQUEST')
  await assert.rejects(g.groupTabs({ tabIds: [1], title: '' }), (err) => err.code === 'E_BAD_REQUEST')
  await assert.rejects(g.groupTabs({ tabIds: [1], title: 'x'.repeat(200) }), (err) => err.code === 'E_BAD_REQUEST')
  const ok = await g.updateGroup({ group: groupId, title: 'B', color: 'blue' })
  assert.equal(ok.group.title, 'B')
  assert.equal(ok.group.color, 'blue')
})

test('ungrouping a group leaves its tabs where they are, loose', async () => {
  const fake = fakeChrome({ windows: { [W1]: [{ id: 1, group: { key: 'a', title: 'A' } }, { id: 2, group: { key: 'a', title: 'A' } }, { id: 3 }] }, current: W1 })
  const g = await loadGroups(fake)
  const result = await g.ungroupTabs({ group: fake.groupOf(1).id })
  assert.equal(result.ungrouped, 2)
  assert.deepEqual(fake.strip(W1), [1, 2, 3])
  assert.equal(fake.groupOf(1), null)
  assert.equal(fake.groups.size, 0)
})

test('"Tabs cannot be edited right now" is tried once more, not reported as a failure', async () => {
  const fake = fakeChrome({ windows: { [W1]: [{ id: 1 }, { id: 2 }] }, current: W1, blockEdits: 1 })
  const g = await loadGroups(fake)
  const result = await g.groupTabs({ tabIds: [2, 1], title: 'A', retryDelayMs: 0 })
  assert.equal(result.group.count, 2)
})

test('the list shows every normal window\'s groups and which tab is in which', async () => {
  const fake = fakeChrome({
    windows: {
      [W1]: [{ id: 1, pinned: true }, { id: 2, group: { key: 'a', title: 'A', color: 'red' } }, { id: 3, group: { key: 'a', title: 'A' } }, { id: 4 }],
      [W2]: [{ id: 9 }],
    },
    current: W1,
  })
  const g = await loadGroups(fake)
  const result = await g.listGroups({})
  assert.equal(result.windows.length, 2)
  const w1 = result.windows.find((w) => w.windowId === W1)
  assert.equal(w1.tabs, 4)
  assert.equal(w1.pinned, 1)
  assert.equal(w1.loose, 1)
  assert.deepEqual(w1.groups.map((x) => ({ title: x.title, color: x.color, count: x.count, index: x.index })), [{ title: 'A', color: 'red', count: 2, index: 1 }])
  assert.equal(result.tabs.length, 5)
  assert.ok(result.tabs.every((t) => Number.isInteger(t[shared.RAW_TAB_ID_FIELD])))
  const one = await g.listGroups({ window: W2 })
  assert.equal(one.windows.length, 1)
  await assert.rejects(g.listGroups({ window: 5 }), (err) => err.code === 'E_BAD_REQUEST')
})

test('a tab dragged to another window during a drag-lock retry is refused, not pulled back', async () => {
  const fake = fakeChrome({ windows: { [W1]: [{ id: 1 }, { id: 2 }, { id: 3 }], [W2]: [{ id: 9 }] }, current: W1, blockEdits: 1 })
  const g = await loadGroups(fake)
  fake.atEdit(1, () => fake.personMoves(2, W2))
  await assert.rejects(
    g.groupTabs({ tabIds: [1, 2], title: 'A', retryDelayMs: 0 }),
    (err) => err.code === 'E_BAD_REQUEST' && /window/.test(err.message)
  )
  assert.deepEqual(fake.events.filter((e) => e.kind === 'crossWindow'), [])
  assert.deepEqual(fake.strip(W2), [9, 2])
})

test('a tab dragged to another window while the group is ordered is left there, and said so', async () => {
  const fake = fakeChrome({ windows: { [W1]: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], [W2]: [{ id: 9 }] }, current: W1 })
  const g = await loadGroups(fake)
  // Edit 1 makes the group; the person drags tab 1 away right after it.
  fake.afterEdit(1, () => fake.personMoves(1, W2))
  const result = await g.groupTabs({ tabIds: [3, 1], title: 'A', retryDelayMs: 0 })
  assert.deepEqual(fake.events.filter((e) => e.kind === 'crossWindow'), [])
  assert.deepEqual(fake.strip(W2), [9, 1])
  assert.equal(fake.groupOf(1), null)
  assert.equal(result.group.count, 1)
  assert.match(result.note, /another window/)
})

test('a group dragged to another window before tabs are added to it is refused', async () => {
  const fake = fakeChrome({
    windows: { [W1]: [{ id: 1, group: { key: 'a', title: 'A' } }, { id: 2 }], [W2]: [{ id: 9 }] },
    current: W1,
    blockEdits: 1,
  })
  const g = await loadGroups(fake)
  const groupId = fake.groupOf(1).id
  fake.atEdit(1, () => {
    fake.groups.get(groupId).windowId = W2
  })
  await assert.rejects(g.groupTabs({ tabIds: [2], title: 'A', retryDelayMs: 0 }), (err) => err.code === 'E_BAD_REQUEST')
  assert.deepEqual(fake.events.filter((e) => e.kind === 'crossWindow'), [])
})

test('the active-tab check runs at the moment of the collapse, so a click during a retry is honored', async () => {
  const fake = fakeChrome({
    windows: { [W1]: [{ id: 1, active: true }, { id: 2, group: { key: 'a', title: 'A' } }, { id: 3, group: { key: 'a', title: 'A' } }] },
    current: W1,
    blockEdits: 1,
  })
  const g = await loadGroups(fake)
  fake.atEdit(1, () => fake.personActivates(2))
  const result = await g.updateGroup({ group: fake.groupOf(2).id, collapsed: true, retryDelayMs: 0 })
  assert.equal(result.group.collapsed, false)
  assert.match(result.note, /active tab/)
  assert.deepEqual(fake.events.filter((e) => e.kind === 'activated'), [])
})

test('the MCP rendering lists each group with its tabs as handles, in strip order', async () => {
  const { renderGroups } = await import('../mcp-server/shape.mjs')
  const out = renderGroups(
    {
      message: '1 window, 1 group.',
      windows: [{ windowId: W1, tabs: 3, pinned: 0, loose: 1, groups: [{ groupId: 7, title: 'Decide', color: 'red', collapsed: true, count: 2, index: 1 }] }],
      tabs: [
        { handle: 'h_b', windowId: W1, index: 2, groupId: 7, active: true },
        { handle: 'h_x', windowId: W1, index: 0, groupId: -1 },
        { handle: 'h_a', windowId: W1, index: 1, groupId: 7 },
      ],
    },
    { profile: 'p' }
  ).content[0].text
  assert.match(out, /group 7 "Decide" red, collapsed, 2 tabs, from index 1/)
  assert.ok(out.indexOf('h_a') < out.indexOf('h_b'), 'members in strip order')
  assert.match(out, /h_b {2}\[active\]/)
  assert.ok(!out.includes('h_x'), 'a loose tab is not listed under a group')
  assert.match(out, /1 in no group/)
})

/* -------------------------------------------------------------------------- */
/* The plan script                                                             */
/* -------------------------------------------------------------------------- */

const script = await import('../scripts/group-tabs.mjs')

test('a plan is refused for a bad color, a repeated title or a tab in two groups', () => {
  assert.equal(script.parsePlan({ groups: [{ title: 'A', color: 'teal', tabs: ['tab_p_1_1'] }] }).ok, false)
  assert.equal(script.parsePlan({ groups: [{ title: 'A', tabs: ['tab_p_1_1'] }, { title: 'A', tabs: ['tab_p_1_2'] }] }).ok, false)
  assert.equal(script.parsePlan({ groups: [{ title: 'A', tabs: ['tab_p_1_1'] }, { title: 'B', tabs: ['tab_p_1_1'] }] }).ok, false)
  assert.equal(script.parsePlan({ groups: [{ title: 'A', tabs: [42] }] }).ok, false)
  assert.equal(script.parsePlan({ groups: [] }).ok, false)
  const good = script.parsePlan({ groups: [{ title: 'A', color: 'red', collapsed: true, tabs: ['tab_p_1_1'] }] })
  assert.equal(good.ok, true)
  assert.deepEqual(good.plan.groups[0], { title: 'A', color: 'red', collapsed: true, tabs: ['tab_p_1_1'] })
})

test('the apply steps keep every group in the window its tabs are in', () => {
  const listed = {
    tabs: [
      { handle: 'h1', windowId: W1, pinned: false },
      { handle: 'h2', windowId: W2, pinned: false },
      { handle: 'h3', windowId: W1, pinned: false },
      { handle: 'h4', windowId: W1, pinned: true },
    ],
  }
  const plan = { groups: [{ title: 'A', color: 'red', collapsed: false, tabs: ['h3', 'h2', 'h1'] }, { title: 'B', color: 'blue', collapsed: true, tabs: ['h4', 'h5'] }] }
  const steps = script.planApply({ plan, listed })
  assert.deepEqual(steps.windows, [
    { windowId: W1, groups: [{ title: 'A', color: 'red', collapsed: false, tabs: ['h3', 'h1'] }] },
    { windowId: W2, groups: [{ title: 'A', color: 'red', collapsed: false, tabs: ['h2'] }] },
  ])
  assert.deepEqual(steps.skipped, [
    { handle: 'h4', group: 'B', reason: 'pinned' },
    { handle: 'h5', group: 'B', reason: 'not open' },
  ])
})

test('the script can only list, group, update and move groups', async () => {
  const sent = []
  const c = script.groupOnlyClient({ request: async (msg) => (sent.push(msg.op), {}) })
  for (const op of [OPS.CLOSE_TAB, OPS.NAVIGATE, OPS.OPEN_TAB, OPS.RELOAD_EXTENSION, OPS.UNGROUP_TABS, OPS.EVAL_JS, OPS.ACTIVATE_TAB]) {
    await assert.rejects(c.request({ op, profile: 'p', args: {} }), /refuses/)
  }
  await assert.rejects(c.request({ op: OPS.GROUP_TABS, profile: 'p', args: { tabIds: [1], title: 'A' } }), /handle/)
  assert.deepEqual(sent, [])
  await c.request({ op: OPS.LIST_GROUPS, profile: 'p', args: {} })
  assert.deepEqual(sent, [OPS.LIST_GROUPS])
})

test('applying a plan groups, moves each group to the end in order, collapses last and reads back', async () => {
  const sent = []
  let listCalls = 0
  const client = {
    async request(msg) {
      sent.push({ op: msg.op, args: msg.args })
      if (msg.op === OPS.LIST_GROUPS) {
        listCalls += 1
        if (listCalls === 1) {
          return { windows: [{ windowId: W1, groups: [] }], tabs: [{ handle: 'h1', windowId: W1, pinned: false, groupId: -1 }, { handle: 'h2', windowId: W1, pinned: false, groupId: -1 }] }
        }
        return {
          windows: [{ windowId: W1, groups: [{ groupId: 7, title: 'A', color: 'red', collapsed: false, count: 1 }, { groupId: 8, title: 'B', color: 'grey', collapsed: true, count: 1 }] }],
          tabs: [{ handle: 'h1', windowId: W1, groupId: 7 }, { handle: 'h2', windowId: W1, groupId: 8 }],
        }
      }
      if (msg.op === OPS.GROUP_TABS) return { group: { groupId: msg.args.title === 'A' ? 7 : 8, windowId: W1, title: msg.args.title, count: 1 } }
      return { group: { groupId: msg.args.group } }
    },
  }
  const plan = { groups: [{ title: 'A', color: 'red', collapsed: false, tabs: ['h1'] }, { title: 'B', color: 'grey', collapsed: true, tabs: ['h2'] }] }
  const result = await script.applyPlan({ client, profile: 'p', plan })
  assert.deepEqual(
    sent.map((s) => s.op),
    [OPS.LIST_GROUPS, OPS.GROUP_TABS, OPS.MOVE_GROUP, OPS.GROUP_TABS, OPS.MOVE_GROUP, OPS.UPDATE_GROUP, OPS.LIST_GROUPS]
  )
  assert.deepEqual(sent[1].args, { tabs: ['h1'], title: 'A', color: 'red', collapsed: false })
  assert.deepEqual(sent[2].args, { group: 7, index: -1 })
  assert.deepEqual(sent[5].args, { group: 8, collapsed: true })
  assert.equal(result.ok, true)
  assert.deepEqual(result.counts, [{ windowId: W1, groups: [{ title: 'A', count: 1, collapsed: false }, { title: 'B', count: 1, collapsed: true }] }])
  assert.equal(script.exitCodeFor(result), 0)

  const dry = []
  const dryClient = { request: async (msg) => (dry.push(msg.op), client.request(msg)) }
  listCalls = 0
  const preview = await script.applyPlan({ client: dryClient, profile: 'p', plan, dryRun: true })
  assert.deepEqual(dry, [OPS.LIST_GROUPS])
  assert.equal(preview.dryRun, true)
})

test('a tab that did not land in its group makes the apply fail', async () => {
  const client = {
    async request(msg) {
      if (msg.op === OPS.LIST_GROUPS) {
        return { windows: [{ windowId: W1, groups: [] }], tabs: [{ handle: 'h1', windowId: W1, pinned: false, groupId: -1 }] }
      }
      return { group: { groupId: 7 } }
    },
  }
  const result = await script.applyPlan({ client, profile: 'p', plan: { groups: [{ title: 'A', color: 'red', collapsed: false, tabs: ['h1'] }] } })
  assert.equal(result.ok, false)
  assert.deepEqual(result.misplaced, [{ handle: 'h1', group: 'A' }])
  assert.equal(script.exitCodeFor(result), 1)
})

test('a plan refuses a group of more than 500 tabs, the most one call groups', () => {
  const tabs = Array.from({ length: 501 }, (_, i) => `tab_p_1_${i}`)
  const r = script.parsePlan({ groups: [{ title: 'A', tabs }] })
  assert.equal(r.ok, false)
  assert.match(r.message, /500/)
})

test('a tab closed during the run is skipped, and every later group is still made', async () => {
  const sent = []
  let lists = 0
  const gone = Object.assign(new Error('Tab 5 no longer exists in this profile.'), { code: 'E_TAB_GONE' })
  const client = {
    async request(msg) {
      sent.push(msg.op)
      if (msg.op === OPS.LIST_GROUPS) {
        lists += 1
        if (lists === 1) {
          return { windows: [{ windowId: W1, groups: [] }], tabs: [{ handle: 'h1', windowId: W1 }, { handle: 'h2', windowId: W1 }, { handle: 'h3', windowId: W1 }] }
        }
        if (lists === 2) return { windows: [{ windowId: W1, groups: [] }], tabs: [{ handle: 'h1', windowId: W1 }, { handle: 'h3', windowId: W1 }] }
        return {
          windows: [{ windowId: W1, groups: [{ groupId: 7, title: 'A', count: 1 }, { groupId: 8, title: 'B', count: 1 }] }],
          tabs: [{ handle: 'h1', windowId: W1, groupId: 7 }, { handle: 'h3', windowId: W1, groupId: 8 }],
        }
      }
      if (msg.op === OPS.GROUP_TABS && msg.args.tabs.includes('h2')) throw gone
      if (msg.op === OPS.GROUP_TABS) return { group: { groupId: msg.args.title === 'A' ? 7 : 8 } }
      return { group: { groupId: msg.args.group } }
    },
  }
  const plan = { groups: [{ title: 'A', color: 'red', collapsed: false, tabs: ['h1', 'h2'] }, { title: 'B', color: 'blue', collapsed: false, tabs: ['h3'] }] }
  const result = await script.applyPlan({ client, profile: 'p', plan })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.skipped, [{ handle: 'h2', group: 'A', reason: 'closed or moved during the run' }])
  assert.deepEqual(sent.filter((op) => op === OPS.GROUP_TABS).length, 3)
})

test('a failed read-back still returns what was done, with the reason', async () => {
  let lists = 0
  const client = {
    async request(msg) {
      if (msg.op === OPS.LIST_GROUPS) {
        lists += 1
        if (lists === 1) return { windows: [{ windowId: W1, groups: [] }], tabs: [{ handle: 'h1', windowId: W1 }] }
        throw Object.assign(new Error('Profile "p" is stale.'), { code: 'E_PROFILE_STALE' })
      }
      return { group: { groupId: 7 } }
    },
  }
  const result = await script.applyPlan({ client, profile: 'p', plan: { groups: [{ title: 'A', color: 'red', collapsed: false, tabs: ['h1'] }] } })
  assert.equal(result.ok, false)
  assert.match(result.message, /the read-back/)
  assert.deepEqual(result.made, [{ windowId: W1, title: 'A' }])
  assert.equal(script.exitCodeFor(result), 1)
})
