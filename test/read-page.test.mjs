/**
 * read-page: the read-only wrapper, the argument rules, and the read itself.
 *
 * The read runs against a FAKE broker client that records every request, so
 * the assertions are about what the command SENT, which is the only thing that
 * can press a control on a page. The claim under test is "it cannot write":
 * no operation outside open, list, read, scroll and close ever leaves it, the
 * tab is opened in the background, and the only tab it closes is its own.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { OPS } from '../shared/protocol.mjs'
import {
  DEFAULT_MAX_CHARS,
  READ_ONLY_OPS,
  parseArgs,
  readOnlyClient,
  readPage,
  toReadableUrl,
} from '../scripts/read-page.mjs'

/* -------------------------------------------------------------------------- */
/* A fake broker and a fake clock                                              */
/* -------------------------------------------------------------------------- */

function fakeClock() {
  let t = 0
  return { now: () => t, sleep: async (ms) => { t += ms } }
}

/**
 * @param {object} page   what the tab "shows": texts (one per read, last repeats), status sequence, url, title
 */
function fakeBroker(page = {}) {
  const calls = []
  const texts = page.texts || ['Hello from the page.']
  const statuses = page.statuses || ['complete']
  let reads = 0
  let lists = 0
  let scrolls = 0
  const client = {
    calls,
    async request(msg) {
      calls.push(msg)
      switch (msg.op) {
        case OPS.OPEN_TAB:
          if (page.openFails) throw Object.assign(new Error('no such profile'), { code: 'E_UNKNOWN_PROFILE' })
          return { ok: true, handle: 'tab_test_1_7', url: msg.args.url, active: false }
        case OPS.LIST_TABS: {
          const status = statuses[Math.min(lists, statuses.length - 1)]
          lists += 1
          if (page.tabGone) return { tabs: [{ handle: 'tab_test_1_99', status: 'complete' }] }
          return { tabs: [{ handle: 'tab_other_1_3', status: 'complete' }, { handle: 'tab_test_1_7', status }] }
        }
        case OPS.READ_PAGE: {
          if (page.readFails) throw new Error('the page could not be read')
          const text = texts[Math.min(reads, texts.length - 1)]
          reads += 1
          const start = Number(msg.args.cursor || 0)
          const slice = text.slice(start, start + msg.args.maxChars)
          const end = start + slice.length
          return { content: slice, total: text.length, next: end < text.length ? end : null, url: page.url || msg.args.tab, title: page.title || 'A page' }
        }
        case OPS.SCROLL: {
          scrolls += 1
          const bottom = scrolls >= (page.bottomAfter || 3)
          return { ok: true, atBottom: bottom, loadedMore: !bottom }
        }
        case OPS.CLOSE_TAB:
          return { ok: true, closed: true }
        default:
          throw new Error(`the fake broker was sent ${msg.op}`)
      }
    },
  }
  return client
}

const opsSent = (client) => client.calls.map((c) => c.op)

/* -------------------------------------------------------------------------- */
/* The wrapper: the vocabulary, refused locally                                */
/* -------------------------------------------------------------------------- */

test('the read-only vocabulary is open, list, read, scroll and close, and nothing that writes', () => {
  assert.deepEqual([...READ_ONLY_OPS].sort(), [OPS.CLOSE_TAB, OPS.LIST_TABS, OPS.OPEN_TAB, OPS.READ_PAGE, OPS.SCROLL].sort())
  for (const name of ['CLICK', 'FILL', 'PRESS_KEYS', 'NAVIGATE', 'EVAL_JS', 'ACTIVATE_TAB', 'ARM', 'OPEN_OR_FOCUS']) {
    if (OPS[name]) assert.equal(READ_ONLY_OPS.includes(OPS[name]), false, `${name} must not be in the vocabulary`)
  }
})

test('every write operation is refused before it reaches the broker', async () => {
  const inner = fakeBroker()
  const c = readOnlyClient(inner)
  const writes = Object.entries(OPS).filter(([, op]) => !READ_ONLY_OPS.includes(op))
  assert.ok(writes.length >= 5, 'the protocol has write operations to refuse')
  for (const [, op] of writes) {
    await assert.rejects(c.request({ op, profile: 'p', args: {} }), /refuses the operation/)
  }
  assert.equal(inner.calls.length, 0, 'not one refused operation was sent')
})

test('a tab is opened in the background only', async () => {
  const inner = fakeBroker()
  const c = readOnlyClient(inner)
  await assert.rejects(c.request({ op: OPS.OPEN_TAB, profile: 'p', args: { url: 'https://example.com/' } }), /background/)
  await assert.rejects(c.request({ op: OPS.OPEN_TAB, profile: 'p', args: { url: 'https://example.com/', active: true } }), /background/)
  assert.equal(inner.calls.length, 0)
})

test('the only tab it closes is one it opened', async () => {
  const inner = fakeBroker()
  const c = readOnlyClient(inner)
  await assert.rejects(c.request({ op: OPS.CLOSE_TAB, profile: 'p', args: { tab: 'tab_other_1_3' } }), /did not open/)
  const opened = await c.request({ op: OPS.OPEN_TAB, profile: 'p', args: { url: 'https://example.com/', active: false } })
  await c.request({ op: OPS.CLOSE_TAB, profile: 'p', args: { tab: opened.handle } })
  assert.deepEqual(opsSent(inner), [OPS.OPEN_TAB, OPS.CLOSE_TAB])
})

test('a scroll goes by direction, never to an element a page could aim', async () => {
  const c = readOnlyClient(fakeBroker())
  await assert.rejects(c.request({ op: OPS.SCROLL, profile: 'p', args: { tab: 't', toRef: 'e12' } }), /direction only/)
  await assert.rejects(c.request({ op: OPS.SCROLL, profile: 'p', args: { tab: 't', selector: 'button.like' } }), /direction only/)
})

test('the script names no write operation anywhere in its code', () => {
  const source = fs.readFileSync(new URL('../scripts/read-page.mjs', import.meta.url), 'utf8')
  for (const name of ['CLICK', 'FILL', 'PRESS_KEYS', 'NAVIGATE', 'EVAL_JS', 'ACTIVATE_TAB', 'OPEN_OR_FOCUS', 'ARM']) {
    assert.equal(new RegExp(`OPS\\.${name}\\b`).test(source), false, `OPS.${name} appears in read-page.mjs`)
  }
})

/* -------------------------------------------------------------------------- */
/* Arguments                                                                   */
/* -------------------------------------------------------------------------- */

test('only absolute http and https addresses are read', () => {
  assert.deepEqual(toReadableUrl('https://example.com/a?b=1'), { ok: true, url: 'https://example.com/a?b=1' })
  assert.equal(toReadableUrl('http://example.com').ok, true)
  for (const bad of ['', 'example.com/page', 'file:///C:/x.html', 'javascript:alert(1)', 'data:text/html,hi', 'chrome://settings']) {
    assert.equal(toReadableUrl(bad).ok, false, bad)
  }
})

test('the arguments: a label and a URL, the flags, and the refusals', () => {
  assert.deepEqual(parseArgs(['brave-work', 'https://example.com/']), {
    mode: 'read', profile: 'brave-work', target: 'https://example.com/', comments: false, json: false,
    maxChars: DEFAULT_MAX_CHARS, socket: undefined,
  })
  const p = parseArgs(['--comments', '--json', 'brave-work', 'https://example.com/', '--max-chars', '5000'])
  assert.equal(p.comments, true)
  assert.equal(p.json, true)
  assert.equal(p.maxChars, 5000)
  assert.equal(parseArgs(['brave-work']).mode, 'usage')
  assert.equal(parseArgs(['a', 'b', 'c']).mode, 'usage')
  assert.equal(parseArgs(['a', 'https://example.com/', '--click']).mode, 'usage')
  assert.equal(parseArgs(['a', 'https://example.com/', '--max-chars', '10']).mode, 'usage')
  assert.equal(parseArgs(['a', 'https://example.com/', '--socket']).mode, 'usage')
})

/* -------------------------------------------------------------------------- */
/* The read                                                                    */
/* -------------------------------------------------------------------------- */

test('a page is opened in the background, read until its text stops growing, and closed', async () => {
  const broker = fakeBroker({ statuses: ['loading', 'loading', 'complete'], texts: ['Short', 'Short and growing', 'Short and growing text', 'Short and growing text'], url: 'https://example.com/post', title: 'Post' })
  const clock = fakeClock()
  const r = await readPage({ client: broker, profile: 'brave-work', url: 'https://example.com/post', ...clock })
  assert.equal(r.ok, true)
  assert.equal(r.loaded, true)
  assert.equal(r.text, 'Short and growing text')
  assert.equal(r.chars, 22)
  assert.equal(r.url, 'https://example.com/post')
  assert.equal(r.closed, true)
  const ops = opsSent(broker)
  assert.equal(ops[0], OPS.OPEN_TAB)
  assert.equal(broker.calls[0].args.active, false)
  assert.equal(ops.at(-1), OPS.CLOSE_TAB)
  assert.equal(broker.calls.at(-1).args.tab, 'tab_test_1_7')
  assert.ok(ops.every((op) => READ_ONLY_OPS.includes(op)))
})

test('a long page is read through the cursor to the end', async () => {
  const long = 'x'.repeat(450_000)
  const broker = fakeBroker({ texts: [long] })
  const r = await readPage({ client: broker, profile: 'p', url: 'https://example.com/', maxChars: 1_000_000, ...fakeClock() })
  assert.equal(r.chars, 450_000)
  const reads = broker.calls.filter((c) => c.op === OPS.READ_PAGE)
  assert.ok(reads.some((c) => c.args.cursor === '200000'), 'the second slice starts at the cursor')
})

test('--comments scrolls down until the bottom stops growing, then reads again', async () => {
  const broker = fakeBroker({ texts: ['Post text', 'Post text', 'Post text with 40 comments'], bottomAfter: 3 })
  const r = await readPage({ client: broker, profile: 'p', url: 'https://example.com/', comments: true, ...fakeClock() })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'Post text with 40 comments')
  assert.ok(r.scrolls >= 3 && r.scrolls <= 11)
  assert.ok(broker.calls.filter((c) => c.op === OPS.SCROLL).every((c) => c.args.direction === 'down' && !c.args.toRef))
})

test('an empty page did not land, and its tab is still closed', async () => {
  const broker = fakeBroker({ texts: [''] })
  const r = await readPage({ client: broker, profile: 'p', url: 'https://example.com/', ...fakeClock() })
  assert.equal(r.ok, false)
  assert.match(r.message, /no readable text/)
  assert.equal(r.closed, true)
  assert.equal(opsSent(broker).at(-1), OPS.CLOSE_TAB)
})

test('a read that fails still closes the tab it opened', async () => {
  const broker = fakeBroker({ readFails: true })
  const r = await readPage({ client: broker, profile: 'p', url: 'https://example.com/', ...fakeClock() })
  assert.equal(r.ok, false)
  assert.match(r.message, /could not be read/)
  assert.equal(r.closed, true)
  assert.equal(opsSent(broker).at(-1), OPS.CLOSE_TAB)
})

test('a tab closed by someone else is not closed again, and the read did not land', async () => {
  const broker = fakeBroker({ tabGone: true })
  const r = await readPage({ client: broker, profile: 'p', url: 'https://example.com/', ...fakeClock() })
  assert.equal(r.ok, false)
  assert.match(r.message, /closed before/)
  assert.equal(opsSent(broker).includes(OPS.CLOSE_TAB), false)
})

test('a profile the broker cannot reach is a failure with a reason, and nothing is opened', async () => {
  const broker = fakeBroker({ openFails: true })
  const r = await readPage({ client: broker, profile: 'nobody', url: 'https://example.com/', ...fakeClock() })
  assert.equal(r.ok, false)
  assert.ok(r.message.length > 0)
  assert.deepEqual(opsSent(broker), [OPS.OPEN_TAB])
})

test('a page that never reports complete is still read when it shows text', async () => {
  const broker = fakeBroker({ statuses: ['loading'], texts: ['Visible while still loading'] })
  const r = await readPage({ client: broker, profile: 'p', url: 'https://example.com/', ...fakeClock() })
  assert.equal(r.ok, true)
  assert.equal(r.loaded, false)
  assert.equal(r.closed, true)
})
