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
  cliError,
  exitCodeFor,
  mergeSnapshots,
  parseArgs,
  readOnlyClient,
  readPage,
  stripControls,
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
          if (page.openFails) throw Object.assign(new Error('no such profile'), { code: page.openFails })
          return { ok: true, handle: 'tab_test_1_7', url: msg.args.url, active: false }
        case OPS.LIST_TABS: {
          const status = statuses[Math.min(lists, statuses.length - 1)]
          lists += 1
          if (page.tabGone) return { tabs: [{ handle: 'tab_test_1_99', status: 'complete' }] }
          if (page.reminted) return { tabs: [{ handle: 'tab_test_2_7', status: 'complete', url: 'https://example.com/post' }] }
          return { tabs: [{ handle: 'tab_other_1_3', status: 'complete' }, { handle: 'tab_test_1_7', status }] }
        }
        case OPS.READ_PAGE: {
          if (page.readFails) throw new Error('the page could not be read')
          if (page.noProgress) return { content: '', total: 50, next: 10, url: 'u', title: 't' }
          const text = texts[Math.min(reads, texts.length - 1)]
          reads += 1
          const start = Number(msg.args.cursor || 0)
          const slice = text.slice(start, start + msg.args.maxChars)
          const end = start + slice.length
          return { content: slice, total: text.length, next: end < text.length ? end : null, url: page.url || msg.args.tab, title: page.title || 'A page' }
        }
        case OPS.SCROLL: {
          scrolls += 1
          if (page.alwaysMore) return { ok: true, atBottom: true, loadedMore: scrolls % 2 === 0 }
          const bottom = scrolls >= (page.bottomAfter || 3)
          return { ok: true, atBottom: bottom, loadedMore: !bottom }
        }
        case OPS.CLOSE_TAB:
          if (page.closeFails) throw Object.assign(new Error('the switch is engaged'), { code: 'E_PANIC' })
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
  const inner = fakeBroker()
  const c = readOnlyClient(inner)
  const { handle } = await c.request({ op: OPS.OPEN_TAB, profile: 'p', args: { url: 'https://example.com/', active: false } })
  await assert.rejects(c.request({ op: OPS.SCROLL, profile: 'p', args: { tab: handle, toRef: 'e12' } }), /direction only/)
  await assert.rejects(c.request({ op: OPS.SCROLL, profile: 'p', args: { tab: handle, selector: 'button.like' } }), /direction only/)
  assert.deepEqual(opsSent(inner), [OPS.OPEN_TAB])
})

test('it reads and scrolls only the tab it opened: no foreign handle, no missing tab, no raw tab id', async () => {
  const inner = fakeBroker()
  const c = readOnlyClient(inner)
  const { handle } = await c.request({ op: OPS.OPEN_TAB, profile: 'p', args: { url: 'https://example.com/', active: false } })
  for (const op of [OPS.READ_PAGE, OPS.SCROLL, OPS.CLOSE_TAB]) {
    const base = op === OPS.READ_PAGE ? { format: 'text' } : op === OPS.SCROLL ? { direction: 'down' } : {}
    // a missing tab would reach the extension as "the active tab of the last focused window"
    await assert.rejects(c.request({ op, profile: 'p', args: { ...base } }), /did not open/, `${op} with no tab`)
    await assert.rejects(c.request({ op, profile: 'p', args: { ...base, tab: 'tab_other_1_3' } }), /did not open/, `${op} foreign`)
    await assert.rejects(c.request({ op, profile: 'p', args: { ...base, tabId: 3 } }), /raw tab id/, `${op} raw id`)
    await assert.rejects(c.request({ op, profile: 'p', args: { ...base, tab: handle, tabId: 3 } }), /raw tab id/, `${op} own + raw`)
  }
  await assert.rejects(c.request({ op: OPS.READ_PAGE, profile: 'p', args: { tab: handle, format: 'html' } }), /as text only/)
  await assert.rejects(c.request({ op: OPS.READ_PAGE, profile: 'p', args: { tab: handle, format: 'snapshot' } }), /as text only/)
  assert.deepEqual(opsSent(inner), [OPS.OPEN_TAB], 'nothing but the open reached the broker')
  assert.equal('opened' in c, false, 'the set of opened tabs is private')
  assert.equal(c.owns(handle), true)
  assert.equal(c.owns('tab_other_1_3'), false)
})

test('the script names no write operation anywhere in its code', () => {
  const source = fs.readFileSync(new URL('../scripts/read-page.mjs', import.meta.url), 'utf8')
  const writes = Object.entries(OPS).filter(([, op]) => !READ_ONLY_OPS.includes(op))
  assert.ok(writes.length >= 15)
  for (const [name, op] of writes) {
    assert.equal(new RegExp(`OPS\\.${name}\\b|OPS\\[`).test(source), false, `OPS.${name} appears in read-page.mjs`)
    assert.equal(new RegExp(`['"\`]${op}['"\`]`).test(source), false, `the operation "${op}" is quoted in read-page.mjs`)
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
  const broker = fakeBroker({ openFails: 'E_UNKNOWN_PROFILE' })
  const r = await readPage({ client: broker, profile: 'nobody', url: 'https://example.com/', ...fakeClock() })
  assert.equal(r.ok, false)
  assert.equal(r.message, 'E_UNKNOWN_PROFILE: no such profile')
  assert.deepEqual(opsSent(broker), [OPS.OPEN_TAB])
})

test('an open that timed out says a background tab may have been left', async () => {
  const r = await readPage({ client: fakeBroker({ openFails: 'E_TIMEOUT' }), profile: 'p', url: 'https://example.com/a', ...fakeClock() })
  assert.equal(r.ok, false)
  assert.match(r.message, /^E_TIMEOUT: .*may have been opened and left/)
  assert.equal(exitCodeFor(r), 1)
})

test('a bridge reconnect while loading: the tab is said to be left open, never claimed closed', async () => {
  const broker = fakeBroker({ reminted: true })
  const r = await readPage({ client: broker, profile: 'p', url: 'https://example.com/post', ...fakeClock() })
  assert.equal(r.ok, false)
  assert.equal(r.closed, false)
  assert.match(r.message, /reconnected .* left open/)
  assert.match(r.closeError, /reconnected/)
  assert.equal(opsSent(broker).includes(OPS.CLOSE_TAB), false, 'the re-minted handle is not this command\'s to close')
})

test('a read whose tab could not be closed keeps the text and exits 3', async () => {
  const r = await readPage({ client: fakeBroker({ closeFails: true }), profile: 'p', url: 'https://example.com/', ...fakeClock() })
  assert.equal(r.ok, true)
  assert.equal(r.closed, false)
  assert.match(r.closeError, /^E_PANIC: /)
  assert.equal(exitCodeFor(r), 3)
  assert.equal(exitCodeFor({ ok: true, closed: true }), 0)
  assert.equal(exitCodeFor({ ok: false, closed: true }), 1)
})

test('the settle check compares the text, not only its length', async () => {
  const broker = fakeBroker({ texts: ['Loading 1/3', 'Loading 2/3', 'The whole post', 'The whole post'] })
  const r = await readPage({ client: broker, profile: 'p', url: 'https://example.com/', ...fakeClock() })
  assert.equal(r.text, 'The whole post')
})

test('--comments keeps the post when a virtualized feed unmounts it while scrolling', async () => {
  const post = 'The original post, a sentence long enough to anchor on.'
  const r1 = 'First reply that is long enough to be a line.'
  const r2 = 'Second reply that is long enough to be a line.'
  const r3 = 'Third reply that is long enough to be a line.'
  const broker = fakeBroker({ texts: [`${post}\n${r1}`, `${post}\n${r1}`, `${r1}\n${r2}`, `${r2}\n${r3}`], bottomAfter: 3 })
  const r = await readPage({ client: broker, profile: 'p', url: 'https://example.com/', comments: true, ...fakeClock() })
  assert.equal(r.text, [post, r1, r2, r3].join('\n'))
})

test('--comments sends at most maxScrolls scroll requests, check steps included', async () => {
  const broker = fakeBroker({ alwaysMore: true })
  const r = await readPage({ client: broker, profile: 'p', url: 'https://example.com/', comments: true, ...fakeClock() })
  assert.equal(broker.calls.filter((c) => c.op === OPS.SCROLL).length, 10)
  assert.equal(r.scrolls, 10)
  assert.equal(r.closed, true)
})

test('a read that makes no progress through the cursor stops', async () => {
  const broker = fakeBroker({ noProgress: true })
  const r = await readPage({ client: broker, profile: 'p', url: 'https://example.com/', ...fakeClock() })
  assert.equal(r.ok, false)
  assert.ok(broker.calls.filter((c) => c.op === OPS.READ_PAGE).length < 40)
  assert.equal(r.closed, true)
})

test('an interrupt ends the read at the next step and still closes the tab', async () => {
  const signal = { aborted: false }
  const clock = fakeClock()
  const sleep = async (ms) => { signal.aborted = true; await clock.sleep(ms) }
  const broker = fakeBroker()
  const r = await readPage({ client: broker, profile: 'p', url: 'https://example.com/', comments: true, now: clock.now, sleep, signal })
  assert.equal(r.ok, false)
  assert.match(r.message, /Interrupted/)
  assert.equal(r.closed, true)
  assert.equal(opsSent(broker).includes(OPS.SCROLL), false)
})

test('the whole read is bounded: past its deadline no scroll is sent', async () => {
  const broker = fakeBroker({ statuses: ['loading'] })
  const r = await readPage({ client: broker, profile: 'p', url: 'https://example.com/', comments: true, timing: { totalMs: 5_000 }, ...fakeClock() })
  assert.equal(r.ok, true)
  assert.equal(opsSent(broker).includes(OPS.SCROLL), false)
  assert.equal(r.closed, true)
})

test('snapshots merge: a whole later page replaces, an unmounted start is kept', () => {
  assert.equal(mergeSnapshots('', 'b'), 'b')
  assert.equal(mergeSnapshots('a', ''), 'a')
  assert.equal(mergeSnapshots('Post', 'Post and comments'), 'Post and comments')
  const a = 'Line one is long enough to anchor.\nLine two is long enough to anchor.'
  assert.equal(mergeSnapshots(a, 'Line two is long enough to anchor.\nLine three is new and long.'),
    `${a}\nLine three is new and long.`)
  assert.equal(mergeSnapshots(a, 'short\nunrelated'), `${a}\nshort\nunrelated`)
})

test('text output strips control characters a page could use on the terminal', () => {
  assert.equal(stripControls('a\u001b]52;c;aGk=\u0007b\u001b[2Jc\td\ne\u009b'), 'a]52;c;aGk=b[2Jc\td\ne')
  assert.equal(cliError(Object.assign(new Error('gone'), { code: 'E_TAB_GONE' })), 'E_TAB_GONE: gone')
  assert.equal(cliError(new Error('plain')), 'plain')
})

test('a flag never becomes the value of another flag', () => {
  assert.equal(parseArgs(['--socket', '--json', 'p', 'https://example.com/']).mode, 'usage')
  assert.equal(parseArgs(['p', 'https://example.com/', '--max-chars', '--json']).mode, 'usage')
})

test('a page that never reports complete is still read when it shows text', async () => {
  const broker = fakeBroker({ statuses: ['loading'], texts: ['Visible while still loading'] })
  const r = await readPage({ client: broker, profile: 'p', url: 'https://example.com/', ...fakeClock() })
  assert.equal(r.ok, true)
  assert.equal(r.loaded, false)
  assert.equal(r.closed, true)
})
