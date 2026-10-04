#!/usr/bin/env node
/**
 * read-page - read one page in a signed-in profile, and touch nothing on it.
 *
 *   node scripts/read-page.mjs <profile label> <url> [--comments] [--json]
 *
 * Opens the address in a BACKGROUND tab of that profile, waits for it to load
 * and for its text to stop growing, prints the page's readable text, closes the
 * tab it opened, and exits non-zero when the page did not land. With
 * `--comments` it also scrolls the page down, a few viewports at a time, so a
 * feed or a comment thread that loads as it is scrolled has loaded before the
 * text is read.
 *
 * Read-only by construction, not by care. Everything this command sends goes
 * through `readOnlyClient`, which passes exactly five operations (open a tab,
 * list tabs, read a page, scroll, close a tab) and refuses everything else
 * before it reaches the broker: no click, no fill, no key press, no navigate,
 * no JavaScript. So there is no control on any page it can press, a like or a
 * follow or a reply included, because the operation that would press one is
 * not in its vocabulary. Two narrower rules ride on the same wrapper: a tab is
 * only ever opened in the background, and the only tab it may close is one it
 * opened itself.
 *
 * Exit codes: 0 the page landed and its text was printed; 1 it did not land
 * (no tab, a load that never produced text, a broker or profile error); 2 a
 * usage error. The reason is on stderr either way, so a caller can fall back
 * to another reader and say why.
 *
 * Flags:
 *   --comments          scroll down to load lazy comment threads before reading
 *   --json              print one JSON object instead of the bare text
 *   --max-chars <n>     stop reading after this many characters (default 400000)
 *   --socket <path>     dial a different broker endpoint (proves the fallback)
 */

import { OPS, PRODUCT_NAME } from '../shared/protocol.mjs'
import { describeError, isMain, withBroker } from './claim.mjs'

/** The whole vocabulary of this command. Anything else is refused locally. */
export const READ_ONLY_OPS = Object.freeze([OPS.OPEN_TAB, OPS.LIST_TABS, OPS.READ_PAGE, OPS.SCROLL, OPS.CLOSE_TAB])

export const DEFAULT_MAX_CHARS = 400_000

/** How long each phase may take. Injected in tests, so no test sleeps for real. */
export const DEFAULT_TIMING = Object.freeze({
  loadTimeoutMs: 30_000, // the tab reaching "complete"
  pollMs: 500, // how often the tab's status is re-read while loading
  settleMs: 1_500, // first pause after load, for a client-rendered page to draw
  stableStepMs: 1_000, // pause between text re-reads while it is still growing
  stableMaxMs: 12_000, // give up waiting for the text to stop growing after this
  maxScrolls: 10, // --comments: at most this many scroll steps
  scrollSettleMs: 1_500, // --comments: pause after each step for content to load
  requestTimeoutMs: 30_000, // one broker request
})

/**
 * Wrap a broker client so it can only read.
 *
 * The refusal happens here, before a frame is written, so a bug elsewhere in
 * this file cannot widen what the command does. It also remembers which tab
 * handles it opened, and refuses to close any other.
 *
 * @param {{request: Function}} client
 */
export function readOnlyClient(client) {
  const opened = new Set()
  return {
    opened,
    async request(msg) {
      const op = msg && msg.op
      if (!READ_ONLY_OPS.includes(op)) {
        throw new Error(`read-page refuses the operation "${op}": it only opens, reads, scrolls and closes its own tab.`)
      }
      const args = (msg && msg.args) || {}
      if (op === OPS.OPEN_TAB && args.active !== false) {
        throw new Error('read-page refuses to open a tab in the foreground: it opens background tabs only.')
      }
      if (op === OPS.SCROLL && (args.toRef || args.ref || args.selector)) {
        throw new Error('read-page scrolls by direction only, never to an element.')
      }
      if (op === OPS.CLOSE_TAB && !opened.has(args.tab)) {
        throw new Error('read-page refuses to close a tab it did not open.')
      }
      const result = await client.request(msg)
      if (op === OPS.OPEN_TAB && result && typeof result.handle === 'string') opened.add(result.handle)
      return result
    },
  }
}

/**
 * An address this command will read: absolute http or https, nothing else.
 *
 * @param {string} target
 * @returns {{ok: true, url: string} | {ok: false, message: string}}
 */
export function toReadableUrl(target) {
  const raw = typeof target === 'string' ? target.trim() : ''
  if (raw === '') return { ok: false, message: 'A URL is required.' }
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, message: `"${raw}" is not an absolute URL.` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: `read-page reads http and https pages only, not ${parsed.protocol}` }
  }
  return { ok: true, url: parsed.href }
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : []
  let comments = false
  let json = false
  let maxChars = DEFAULT_MAX_CHARS
  let socket
  const positional = []

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--comments') comments = true
    else if (arg === '--json') json = true
    else if (arg === '--max-chars' || arg === '--socket') {
      const value = args[i + 1]
      i += 1
      if (typeof value !== 'string' || value === '') return { mode: 'usage', message: `${arg} needs a value after it.` }
      if (arg === '--socket') socket = value
      else {
        maxChars = Number(value)
        if (!Number.isInteger(maxChars) || maxChars < 200) {
          return { mode: 'usage', message: '--max-chars must be a whole number of at least 200.' }
        }
      }
    } else if (arg === '--help') return { mode: 'usage', message: '' }
    else if (typeof arg === 'string' && arg.startsWith('--')) return { mode: 'usage', message: `Unknown flag ${arg}.` }
    else positional.push(arg)
  }

  if (positional.length !== 2) return { mode: 'usage', message: 'Expected a profile label and a URL.' }
  return { mode: 'read', profile: positional[0], target: positional[1], comments, json, maxChars, socket }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Every page of text the tab holds, up to maxChars, through the read cursor. */
async function readAllText(c, profile, tab, maxChars, timeoutMs) {
  let cursor = null
  let content = ''
  let first = null
  for (;;) {
    const page = await c.request({
      op: OPS.READ_PAGE,
      profile,
      args: { tab, format: 'text', maxChars: Math.min(200_000, maxChars - content.length), cursor },
      timeoutMs,
    })
    if (!first) first = page
    content += typeof page?.content === 'string' ? page.content : ''
    const next = page?.next
    if (next === null || next === undefined || content.length >= maxChars) {
      return { text: content, total: Number(page?.total) || content.length, url: first?.url || '', title: first?.title || '' }
    }
    cursor = String(next)
  }
}

/** Poll the tab list until our tab says "complete", or the time runs out. */
async function waitForLoad(c, profile, handle, timing, sleep, now) {
  const deadline = now() + timing.loadTimeoutMs
  let row = null
  while (now() < deadline) {
    const listed = await c.request({ op: OPS.LIST_TABS, profile, timeoutMs: timing.requestTimeoutMs })
    row = Array.isArray(listed?.tabs) ? listed.tabs.find((t) => t && t.handle === handle) : null
    if (!row) return { gone: true, complete: false, row: null }
    if (row.status === 'complete') return { gone: false, complete: true, row }
    await sleep(timing.pollMs)
  }
  return { gone: false, complete: false, row }
}

/**
 * Open, settle, read, close. Never throws: every failure becomes a result with
 * ok:false and a message, and the tab is closed on every path that opened one.
 *
 * @param {{client:{request:Function}, profile:string, url:string, comments?:boolean,
 *          maxChars?:number, timing?:object, sleep?:Function, now?:Function}} spec
 */
export async function readPage({
  client,
  profile,
  url,
  comments = false,
  maxChars = DEFAULT_MAX_CHARS,
  timing = DEFAULT_TIMING,
  sleep = realSleep,
  now = Date.now,
}) {
  const c = readOnlyClient(client)
  const t = { ...DEFAULT_TIMING, ...timing }
  const result = {
    ok: false,
    profile,
    requested: url,
    url: '',
    title: '',
    loaded: false,
    chars: 0,
    text: '',
    scrolls: 0,
    closed: false,
    message: '',
  }
  let handle = null
  try {
    const opened = await c.request({ op: OPS.OPEN_TAB, profile, args: { url, active: false }, timeoutMs: t.requestTimeoutMs })
    handle = opened && typeof opened.handle === 'string' ? opened.handle : null
    if (!handle) {
      result.message = 'The broker opened no tab, so there is nothing to read.'
      return result
    }

    const load = await waitForLoad(c, profile, handle, t, sleep, now)
    if (load.gone) {
      handle = null // closed by someone else: nothing of ours to close
      result.message = 'The tab closed before the page loaded.'
      return result
    }
    result.loaded = load.complete
    await sleep(t.settleMs)

    // A client-rendered page keeps drawing after "complete": re-read until the
    // text stops growing, or the wait runs out.
    let page = await readAllText(c, profile, handle, maxChars, t.requestTimeoutMs)
    const stableDeadline = now() + t.stableMaxMs
    while (now() < stableDeadline) {
      await sleep(t.stableStepMs)
      const again = await readAllText(c, profile, handle, maxChars, t.requestTimeoutMs)
      const settled = again.total === page.total && again.total > 0
      page = again
      if (settled) break
    }

    if (comments) {
      for (let i = 0; i < t.maxScrolls; i += 1) {
        const step = await c.request({
          op: OPS.SCROLL,
          profile,
          args: { tab: handle, direction: 'down', amount: null, settleMs: Math.min(2_000, t.scrollSettleMs) },
          timeoutMs: t.requestTimeoutMs,
        })
        result.scrolls += 1
        if (step && step.atBottom && !step.loadedMore) {
          // one more pause: a thread often appends after the bottom is reached
          await sleep(t.scrollSettleMs)
          const check = await c.request({
            op: OPS.SCROLL,
            profile,
            args: { tab: handle, direction: 'down', amount: null, settleMs: Math.min(2_000, t.scrollSettleMs) },
            timeoutMs: t.requestTimeoutMs,
          })
          result.scrolls += 1
          if (!check || !check.loadedMore) break
        }
      }
      page = await readAllText(c, profile, handle, maxChars, t.requestTimeoutMs)
    }

    result.url = page.url
    result.title = page.title
    result.text = page.text
    result.chars = page.text.length
    result.ok = result.chars > 0
    if (!result.ok) result.message = 'The page loaded no readable text.'
    return result
  } catch (err) {
    result.message = describeError(err)
    return result
  } finally {
    if (handle) {
      try {
        await c.request({ op: OPS.CLOSE_TAB, profile, args: { tab: handle }, timeoutMs: t.requestTimeoutMs })
        result.closed = true
      } catch (err) {
        result.closed = false
        result.closeError = describeError(err)
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

const USAGE =
  `${PRODUCT_NAME} read-page\n` +
  '\n' +
  '  node scripts/read-page.mjs <profile label> <url> [--comments] [--json]\n' +
  '\n' +
  '  --comments          scroll down first, so lazy comment threads have loaded\n' +
  '  --json              print one JSON object (url, title, chars, text, closed)\n' +
  `  --max-chars <n>     stop reading after this many characters (default ${DEFAULT_MAX_CHARS})\n` +
  '  --socket <path>     dial a different broker endpoint\n' +
  '\n' +
  'Opens the page in a background tab, reads its text, closes the tab. It sends no click,\n' +
  'fill, key press, navigation or JavaScript, so it cannot press anything on the page.'

async function main(argv) {
  const parsed = parseArgs(argv)
  if (parsed.mode === 'usage') {
    if (parsed.message) console.error(parsed.message, '\n')
    console.error(USAGE)
    return 2
  }
  const target = toReadableUrl(parsed.target)
  if (!target.ok) {
    console.error(target.message)
    return 2
  }

  return withBroker(
    async (client) => {
      const r = await readPage({
        client,
        profile: parsed.profile,
        url: target.url,
        comments: parsed.comments,
        maxChars: parsed.maxChars,
      })
      if (r.closed === false && r.closeError) console.error(`The tab could not be closed: ${r.closeError}`)
      if (parsed.json) {
        console.log(JSON.stringify(r))
      } else if (r.ok) {
        console.error(`${parsed.profile}: read ${r.chars} characters from ${r.url || target.url}${r.scrolls ? ` after ${r.scrolls} scrolls` : ''}`)
        console.log(r.text)
      }
      if (!r.ok) {
        console.error(r.message || 'The page did not land.')
        return 1
      }
      return 0
    },
    { socketPath: parsed.socket }
  )
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (err) => {
      console.error(describeError(err))
      process.exitCode = 1
    }
  )
}
