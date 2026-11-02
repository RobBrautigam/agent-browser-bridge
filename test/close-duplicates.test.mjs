/**
 * close-duplicates: the plan, the fresh check before each close, and the
 * two-operation vocabulary. Runs against a FAKE broker whose tab list changes
 * as tabs are closed, so the assertions are about what the command SENT and
 * what was left open.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { OPS } from '../shared/protocol.mjs'
import {
  CLOSE_DUPLICATES_OPS,
  checkClose,
  closeDuplicates,
  exitCodeFor,
  guardedClient,
  parseArgs,
  planDuplicates,
  renderReport,
} from '../scripts/close-duplicates.mjs'

const tab = (n, url, extra = {}) => ({
  handle: `tab_chrome-work_1_${n}`,
  url,
  title: `Tab ${n}`,
  windowId: 1,
  index: n,
  active: false,
  pinned: false,
  audible: false,
  lastAccessed: 1000 + n,
  ...extra,
})

/**
 * @param {Array<object>} tabs   the profile's tabs; CLOSE_TAB removes one
 * @param {object} [opts]        beforeClose(tabs, n): mutate the list before the n-th close's listing; closeFails
 */
function fakeBroker(tabs, opts = {}) {
  const calls = []
  let open = tabs.map((t) => ({ ...t }))
  let lists = 0
  return {
    calls,
    get open() {
      return open
    },
    async request(msg) {
      calls.push(msg)
      if (msg.op === OPS.LIST_TABS) {
        lists += 1
        if (opts.onList) open = opts.onList(open, lists) || open
        return { count: open.length, tabs: open.map((t) => ({ ...t })) }
      }
      if (msg.op === OPS.CLOSE_TAB) {
        if (opts.closeFails) throw Object.assign(new Error('the switch is engaged'), { code: 'E_PANIC' })
        open = open.filter((t) => t.handle !== msg.args.tab)
        return { ok: true, closed: true }
      }
      throw new Error(`the fake broker was sent ${msg.op}`)
    },
  }
}

const opsSent = (b) => b.calls.map((c) => c.op)

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                              */
/* -------------------------------------------------------------------------- */

test('the vocabulary is list tabs and close a tab, and nothing else is sent', async () => {
  assert.deepEqual([...CLOSE_DUPLICATES_OPS].sort(), [OPS.CLOSE_TAB, OPS.LIST_TABS].sort())
  const inner = fakeBroker([])
  const c = guardedClient(inner)
  for (const op of Object.values(OPS).filter((o) => !CLOSE_DUPLICATES_OPS.includes(o))) {
    await assert.rejects(c.request({ op, profile: 'p', args: {} }), /refuses the operation/)
  }
  await assert.rejects(c.request({ op: OPS.CLOSE_TAB, profile: 'p', args: { tab: 'tab_chrome-work_1_1' } }), /did not name/)
  await assert.rejects(c.request({ op: OPS.CLOSE_TAB, profile: 'p', args: { tabId: 5 } }), /raw tab id/)
  assert.equal(inner.calls.length, 0, 'not one refused request reached the broker')
})

/* -------------------------------------------------------------------------- */
/* The plan                                                                    */
/* -------------------------------------------------------------------------- */

test('the plan keeps one copy of each address and closes the rest', () => {
  const plan = planDuplicates([
    tab(1, 'https://example.com/a'),
    tab(2, 'https://example.com/a'),
    tab(3, 'https://example.com/a'),
    tab(4, 'https://example.com/b'),
  ])
  assert.equal(plan.addresses, 1)
  assert.deepEqual(plan.closes.map((e) => e.close).sort(), ['tab_chrome-work_1_1', 'tab_chrome-work_1_2'])
  assert.ok(plan.closes.every((e) => e.keep === 'tab_chrome-work_1_3'), 'the most recently shown copy is kept')
})

test('the shown copy is kept over a more recent one, then a pinned one', () => {
  const shown = planDuplicates([tab(1, 'https://example.com/a', { active: true, lastAccessed: 1 }), tab(2, 'https://example.com/a')])
  assert.equal(shown.closes[0].keep, 'tab_chrome-work_1_1')
  const pinned = planDuplicates([tab(1, 'https://example.com/a', { pinned: true, lastAccessed: 1 }), tab(2, 'https://example.com/a')])
  assert.equal(pinned.closes[0].keep, 'tab_chrome-work_1_1')
})

test('an active, pinned or sounding copy is never planned for closing', () => {
  const plan = planDuplicates([
    tab(1, 'https://example.com/a', { active: true }),
    tab(2, 'https://example.com/a', { active: true, windowId: 2 }),
    tab(3, 'https://example.com/a', { pinned: true }),
    tab(4, 'https://example.com/a', { audible: true }),
    tab(5, 'https://example.com/a'),
  ])
  assert.deepEqual(plan.closes.map((e) => e.close), ['tab_chrome-work_1_5'])
  assert.deepEqual(plan.staying.map((s) => s.reason).sort(), ['active', 'pinned', 'playing sound'])
})

test('only exact http and https addresses count: a different fragment, query or browser page is not a copy', () => {
  const plan = planDuplicates([
    tab(1, 'https://example.com/a'),
    tab(2, 'https://example.com/a#section'),
    tab(3, 'https://example.com/a?x=1'),
    tab(4, 'chrome://newtab/'),
    tab(5, 'chrome://newtab/'),
    tab(6, ''),
    tab(7, ''),
  ])
  assert.equal(plan.closes.length, 0)
})

test('a kept copy is never also planned for closing', () => {
  const tabs = []
  for (let i = 1; i <= 12; i += 1) tabs.push(tab(i, `https://example.com/${i % 3}`, { windowId: i % 2, lastAccessed: (i * 7) % 5 }))
  const plan = planDuplicates(tabs)
  const closing = new Set(plan.closes.map((e) => e.close))
  assert.ok(plan.closes.every((e) => !closing.has(e.keep)))
})

/* -------------------------------------------------------------------------- */
/* The check before each close                                                 */
/* -------------------------------------------------------------------------- */

test('the check skips a close whose tab moved, was shown, or whose kept copy is gone', () => {
  const entry = { close: 'tab_chrome-work_1_1', keep: 'tab_chrome-work_1_2', url: 'https://example.com/a' }
  const both = [tab(1, 'https://example.com/a'), tab(2, 'https://example.com/a')]
  assert.equal(checkClose(entry, both), null)
  assert.equal(checkClose(entry, [tab(2, 'https://example.com/a')]), 'it is no longer open')
  assert.equal(checkClose(entry, [tab(1, 'https://example.com/b'), tab(2, 'https://example.com/a')]), 'its address changed')
  assert.equal(checkClose(entry, [tab(1, 'https://example.com/a', { active: true }), tab(2, 'https://example.com/a')]), 'it is active now')
  assert.equal(checkClose(entry, [tab(1, 'https://example.com/a')]), 'its kept copy is no longer open')
  assert.equal(checkClose(entry, [tab(1, 'https://example.com/a'), tab(2, 'https://example.com/c')]), 'its kept copy moved to another address')
  assert.equal(checkClose(entry, both, new Set(['tab_chrome-work_1_2'])), 'its kept copy was closed by this run')
  assert.equal(checkClose({ ...entry, keep: entry.close }, both), 'it is its own kept copy')
})

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

test('a run closes every planned copy and leaves one of each address', async () => {
  const broker = fakeBroker([
    tab(1, 'https://example.com/a'),
    tab(2, 'https://example.com/a'),
    tab(3, 'https://example.com/b'),
    tab(4, 'https://example.com/b'),
    tab(5, 'https://example.com/c'),
  ])
  const report = await closeDuplicates({ client: broker, profile: 'chrome-work' })
  assert.equal(report.before, 5)
  assert.equal(report.after, 3)
  assert.deepEqual(broker.open.map((t) => t.url).sort(), ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'])
  assert.equal(exitCodeFor(report), 0)
  assert.ok(opsSent(broker).every((op) => CLOSE_DUPLICATES_OPS.includes(op)))
  assert.match(renderReport(report), /2 of 2 copies closed; tabs before 5, after 3\./)
})

test('a dry run lists and plans, and sends no close', async () => {
  const broker = fakeBroker([tab(1, 'https://example.com/a'), tab(2, 'https://example.com/a')])
  const report = await closeDuplicates({ client: broker, profile: 'chrome-work', dryRun: true })
  assert.deepEqual(opsSent(broker), [OPS.LIST_TABS])
  assert.equal(report.results.length, 1)
  assert.equal(exitCodeFor(report), 0)
  assert.match(renderReport(report), /^would close tab_chrome-work_1_1 \(keeps tab_chrome-work_1_2\) https:\/\/example\.com\/a/)
})

test('a tab the person navigated while the run went on is left alone, and the run exits 1', async () => {
  // the second listing (the check before the first close) shows tab 1 at a new address
  const broker = fakeBroker([tab(1, 'https://example.com/a'), tab(2, 'https://example.com/a')], {
    onList: (open, n) => (n === 2 ? open.map((t) => (t.handle === 'tab_chrome-work_1_1' ? { ...t, url: 'https://example.com/new' } : t)) : open),
  })
  const report = await closeDuplicates({ client: broker, profile: 'chrome-work' })
  assert.equal(opsSent(broker).includes(OPS.CLOSE_TAB), false)
  assert.equal(report.results[0].reason, 'its address changed')
  assert.equal(exitCodeFor(report), 1)
})

test('a close the broker refuses is reported, not retried', async () => {
  const broker = fakeBroker([tab(1, 'https://example.com/a'), tab(2, 'https://example.com/a')], { closeFails: true })
  const report = await closeDuplicates({ client: broker, profile: 'chrome-work' })
  assert.equal(report.results[0].closed, false)
  assert.match(report.results[0].reason, /E_PANIC|switch/)
  assert.equal(broker.calls.filter((c) => c.op === OPS.CLOSE_TAB).length, 1)
  assert.equal(exitCodeFor(report), 1)
})

test('a listing that fails mid-run stops the run and still reports what was closed', async () => {
  // listing 1 plans, listing 2 checks the first close, listing 3 (the check before the second close) fails
  const broker = fakeBroker(
    [tab(1, 'https://example.com/a'), tab(2, 'https://example.com/a'), tab(3, 'https://example.com/a'), tab(4, 'https://example.com/a')],
    {
      onList: (open, n) => {
        if (n >= 3) throw Object.assign(new Error('The broker closed the connection.'), { code: 'E_NO_BROKER' })
        return open
      },
    }
  )
  const report = await closeDuplicates({ client: broker, profile: 'chrome-work' })
  assert.equal(report.results.length, 3, 'every planned close is in the report')
  assert.equal(report.results.filter((r) => r.closed).length, 1, 'the close already done is reported')
  const skipped = report.results.filter((r) => !r.closed)
  assert.equal(skipped.length, 2)
  for (const s of skipped) assert.match(s.reason, /not tried.*broker closed the connection/)
  assert.match(report.stopped, /broker closed the connection/)
  assert.equal(report.after, null, 'the count after is unknown, not guessed')
  assert.equal(broker.calls.filter((c) => c.op === OPS.CLOSE_TAB).length, 1, 'no close without its fresh check')
  assert.equal(broker.calls.filter((c) => c.op === OPS.LIST_TABS).length, 3, 'nothing more is asked of a broker that stopped answering')
  assert.equal(exitCodeFor(report), 1)
  assert.match(renderReport(report), /1 of 3 copies closed; tabs before 4, after unknown\. Stopped: E_NO_BROKER: /)
})

test('nothing to close is a clean run with one listing', async () => {
  const broker = fakeBroker([tab(1, 'https://example.com/a'), tab(2, 'https://example.com/b')])
  const report = await closeDuplicates({ client: broker, profile: 'chrome-work' })
  assert.deepEqual(opsSent(broker), [OPS.LIST_TABS])
  assert.equal(exitCodeFor(report), 0)
})

test('arguments: one profile label, known flags only', () => {
  assert.deepEqual(parseArgs(['chrome-work', '--dry-run']), { mode: 'run', profile: 'chrome-work', dryRun: true, json: false, socket: undefined })
  assert.equal(parseArgs([]).mode, 'usage')
  assert.equal(parseArgs(['a', 'b']).mode, 'usage')
  assert.equal(parseArgs(['a', '--force']).mode, 'usage')
  assert.equal(parseArgs(['a', '--socket', '--json']).mode, 'usage')
})
