#!/usr/bin/env node
/**
 * read-page - read one page in a signed-in profile, and press nothing on it.
 *
 *   node scripts/read-page.mjs <profile label> <url> [--comments] [--json]
 *
 * Opens the address in a BACKGROUND tab of that profile, waits for it to load
 * and for its text to stop changing, prints the page's readable text, closes
 * the tab it opened, and exits non-zero when the page did not land. With
 * `--comments` it also scrolls the page down, about one viewport per step, and
 * keeps what each step showed, so a thread that loads as it is scrolled (or a
 * feed that unmounts what scrolled away) is read whole.
 *
 * Read-only by construction, not by care. Everything this command sends goes
 * through `readOnlyClient`, which passes exactly five operations (open a tab,
 * list tabs, read a page's text, scroll, close a tab) and refuses everything
 * else before it reaches the broker: no click, no fill, no key press, no
 * navigation, no caller JavaScript. So there is no control on any page it can
 * press, a like or a follow or a reply included, because the operation that
 * would press one is not in its vocabulary. The same wrapper opens tabs in the
 * background only, and reads, scrolls and closes only the tab it opened.
 *
 * What it cannot stop: the visit itself is a real signed-in visit. A link that
 * does something when it is opened (sign out, unsubscribe, confirm, download)
 * does it, and the site records that the profile viewed or scrolled the page
 * (profile views, read receipts, story views). Do not point it at such links.
 *
 * Exit codes: 0 the page landed, its text was printed and its tab closed;
 * 1 it did not land (no tab, no text, a broker or profile error); 2 a usage
 * error; 3 the text was read but the tab could not be closed, so a caller can
 * use the text and stop reading. The reason is on stderr in every non-zero case.
 *
 * Flags:
 *   --comments          scroll down, keeping each step's text, before returning
 *   --json              print one JSON object instead of the bare text
 *   --max-chars <n>     stop reading after this many characters (default 400000)
 *   --socket <path>     dial a different broker endpoint (proves the fallback)
 */

import { ERR, OPS, PRODUCT_NAME, parseTabHandle } from '../shared/protocol.mjs'
import { describeError, isMain, withBroker } from './claim.mjs'

/** The whole vocabulary of this command. Anything else is refused locally. */
export const READ_ONLY_OPS = Object.freeze([OPS.OPEN_TAB, OPS.LIST_TABS, OPS.READ_PAGE, OPS.SCROLL, OPS.CLOSE_TAB])

export const DEFAULT_MAX_CHARS = 400_000

/** How long each phase may take. Injected in tests, so no test sleeps for real. */
export const DEFAULT_TIMING = Object.freeze({
  totalMs: 120_000, // the whole read, so a caller's own timeout (180 s in the research doors) never kills it first
  loadTimeoutMs: 30_000, // the tab reaching "complete"
  pollMs: 500, // how often the tab's status is re-read while loading
  settleMs: 1_500, // first pause after load, for a client-rendered page to draw
  stableStepMs: 1_000, // pause between text re-reads while it is still changing
  stableMaxMs: 12_000, // give up waiting for the text to stop changing after this
  maxScrolls: 10, // --comments: at most this many scroll requests in all
  scrollSettleMs: 1_500, // --comments: in-page wait after each step for content to load
  requestTimeoutMs: 30_000, // one broker request
})

/** Argument keys only the broker may write: a raw tab id skips handle validation. */
const RAW_TAB_KEYS = ['tabId', 'tabIds', 'tabs']

/**
 * Wrap a broker client so it can only read, and only its own tab.
 *
 * The refusals happen here, before a frame is written, so a slip elsewhere in
 * this file (a dropped `tab`, a stray raw id) is refused instead of reaching
 * the active tab of Rob's window. `owns(handle)` is the only view of the tabs
 * it opened; the set itself is private.
 *
 * @param {{request: Function}} client
 */
export function readOnlyClient(client) {
  const opened = new Set()
  return {
    owns: (handle) => opened.has(handle),
    async request(msg) {
      const op = msg && msg.op
      if (!READ_ONLY_OPS.includes(op)) {
        throw new Error(`read-page refuses the operation "${op}": it only opens, reads, scrolls and closes its own tab.`)
      }
      const args = (msg && msg.args) || {}
      if (RAW_TAB_KEYS.some((k) => k in args)) {
        throw new Error('read-page addresses tabs by the handle its own open returned, never by a raw tab id.')
      }
      if (op === OPS.OPEN_TAB && args.active !== false) {
        throw new Error('read-page refuses to open a tab in the foreground: it opens background tabs only.')
      }
      if (op === OPS.READ_PAGE || op === OPS.SCROLL || op === OPS.CLOSE_TAB) {
        if (typeof args.tab !== 'string' || !opened.has(args.tab)) {
          throw new Error(`read-page refuses to ${op} a tab it did not open.`)
        }
      }
      if (op === OPS.READ_PAGE && args.format !== 'text') {
        throw new Error('read-page reads a page as text only.')
      }
      if (op === OPS.SCROLL && (args.toRef || args.ref || args.selector)) {
        throw new Error('read-page scrolls by direction only, never to an element.')
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
      if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
        return { mode: 'usage', message: `${arg} needs a value after it.` }
      }
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

/**
 * Fold a later snapshot of a scrolled page into what was already read.
 *
 * When the later snapshot still holds the earlier one's start and end, it is
 * the whole page and replaces it. When a feed unmounted what scrolled away,
 * the earlier text is kept and only what follows its last long line is added.
 *
 * @param {string} acc   what has been read so far
 * @param {string} cur   the page's text now
 */
export function mergeSnapshots(acc, cur) {
  if (!acc) return cur || ''
  if (!cur) return acc
  const head = acc.slice(0, Math.min(200, acc.length))
  const tail = acc.slice(-Math.min(200, acc.length))
  if (cur.includes(head) && cur.includes(tail)) return cur.length >= acc.length ? cur : acc
  const accLines = acc.split('\n')
  const curLines = cur.split('\n')
  for (let i = accLines.length - 1; i >= 0; i -= 1) {
    const line = accLines[i]
    if (line.trim().length < 20) continue
    const j = curLines.lastIndexOf(line)
    if (j >= 0) return j + 1 < curLines.length ? `${acc}\n${curLines.slice(j + 1).join('\n')}` : acc
  }
  return `${acc}\n${cur}`
}

/** C0 and C1 control characters, except tab and newline: a page must not reach the terminal's escape parser. */
export function stripControls(text) {
  // eslint-disable-next-line no-control-regex
  return String(text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
}

/** A script user's error: the code and the broker's own words, the start command only when the broker is down. */
export function cliError(err) {
  if (err && err.code === ERR.NO_BROKER) return describeError(err)
  if (err && typeof err.code === 'string') return `${err.code}: ${err.message || 'no detail'}`
  return err?.message || String(err)
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Every page of text the tab holds, up to maxChars, through the read cursor. */
async function readAllText(c, profile, tab, maxChars, timeoutMs) {
  let last = { text: '', total: 0, url: '', title: '' }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let cursor = null
    let content = ''
    let first = null
    let changed = false
    for (;;) {
      const page = await c.request({
        op: OPS.READ_PAGE,
        profile,
        args: { tab, format: 'text', maxChars: Math.min(200_000, maxChars - content.length), cursor },
        timeoutMs,
      })
      if (!first) first = page
      const chunk = typeof page?.content === 'string' ? page.content : ''
      content += chunk
      if (Number(page?.total) !== Number(first?.total)) changed = true // re-rendered between pages
      const next = page?.next
      if (next === null || next === undefined || content.length >= maxChars || chunk.length === 0) break
      cursor = String(next)
    }
    last = { text: content, total: Number(first?.total) || content.length, url: first?.url || '', title: first?.title || '' }
    if (!changed) break // one render, read whole; otherwise read it once more from the start
  }
  return last
}

/** Poll the tab list until our tab says "complete", or the time runs out. */
async function waitForLoad(c, profile, handle, timeoutMs, timing, sleep, now) {
  const deadline = now() + timeoutMs
  const mine = parseTabHandle(handle)
  for (;;) {
    const listed = await c.request({ op: OPS.LIST_TABS, profile, timeoutMs: timing.requestTimeoutMs })
    const tabs = Array.isArray(listed?.tabs) ? listed.tabs : []
    const row = tabs.find((t) => t && t.handle === handle) || null
    if (!row) {
      // The handle is gone from the list. If the same raw tab is listed under a
      // new handle, the bridge reconnected and minted a new generation: the tab
      // is still open, and the new handle is not this command's to use.
      const sameTab = (mine && tabs.find((t) => t && parseTabHandle(t.handle)?.tabId === mine.tabId)) || null
      return { gone: !sameTab, reminted: Boolean(sameTab), complete: false, row: sameTab }
    }
    if (row.status === 'complete') return { gone: false, reminted: false, complete: true, row }
    if (now() >= deadline) return { gone: false, reminted: false, complete: false, row }
    await sleep(timing.pollMs)
  }
}

/**
 * Open, settle, read, close. Never throws: every failure becomes a result with
 * ok:false and a message, and the tab is closed on every path that still holds
 * its handle. A tab that could not be closed is said, with closed:false.
 *
 * @param {{client:{request:Function}, profile:string, url:string, comments?:boolean,
 *          maxChars?:number, timing?:object, sleep?:Function, now?:Function,
 *          signal?:{aborted:boolean}}} spec
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
  signal = { aborted: false },
}) {
  const c = readOnlyClient(client)
  const t = { ...DEFAULT_TIMING, ...timing }
  const deadline = now() + t.totalMs
  const remaining = () => Math.max(0, deadline - now())
  const checkpoint = () => {
    if (signal.aborted) throw new Error('Interrupted.')
  }
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
    let opened
    try {
      opened = await c.request({ op: OPS.OPEN_TAB, profile, args: { url, active: false }, timeoutMs: t.requestTimeoutMs })
    } catch (err) {
      const maybeOpened = [ERR.TIMEOUT, ERR.NO_WORKER, ERR.NO_EXTENSION].includes(err?.code)
      result.message =
        cliError(err) +
        (maybeOpened ? ` A background tab at ${url} may have been opened and left; it cannot be closed without its handle.` : '')
      return result
    }
    handle = opened && typeof opened.handle === 'string' ? opened.handle : null
    if (!handle) {
      result.message = 'The broker opened no tab, so there is nothing to read.'
      return result
    }

    const load = await waitForLoad(c, profile, handle, Math.min(t.loadTimeoutMs, remaining()), t, sleep, now)
    if (load.gone) {
      handle = null // closed by someone else: nothing of ours to close
      result.message = 'The tab closed before the page loaded.'
      return result
    }
    if (load.reminted) {
      handle = null // still open, but under a handle this command did not mint
      result.closeError = 'the bridge reconnected while the page loaded'
      result.message = `The bridge reconnected while the page loaded; a background tab at ${load.row?.url || url} was left open.`
      return result
    }
    result.loaded = load.complete
    checkpoint()
    await sleep(t.settleMs)

    // A client-rendered page keeps drawing after "complete": re-read until the
    // text stops changing, or the wait runs out.
    let page = await readAllText(c, profile, handle, maxChars, t.requestTimeoutMs)
    const stableDeadline = Math.min(now() + t.stableMaxMs, deadline)
    while (now() < stableDeadline) {
      checkpoint()
      await sleep(t.stableStepMs)
      const again = await readAllText(c, profile, handle, maxChars, t.requestTimeoutMs)
      const settled = again.text === page.text && again.total > 0
      page = again
      if (settled) break
    }

    let text = page.text
    if (comments) {
      let quietAtBottom = 0
      while (result.scrolls < t.maxScrolls && remaining() > 0) {
        checkpoint()
        const step = await c.request({
          op: OPS.SCROLL,
          profile,
          args: { tab: handle, direction: 'down', amount: null, settleMs: Math.min(2_000, t.scrollSettleMs) },
          timeoutMs: t.requestTimeoutMs,
        })
        result.scrolls += 1
        const snap = await readAllText(c, profile, handle, maxChars, t.requestTimeoutMs)
        text = mergeSnapshots(text, snap.text).slice(0, maxChars)
        // two quiet steps at the bottom: a thread often appends once more after the first
        quietAtBottom = step && step.atBottom && !step.loadedMore ? quietAtBottom + 1 : 0
        if (quietAtBottom >= 2) break
      }
    }

    result.url = page.url
    result.title = page.title
    result.text = text
    result.chars = text.length
    result.ok = result.chars > 0
    if (!result.ok) result.message = 'The page loaded no readable text.'
    return result
  } catch (err) {
    result.message = cliError(err)
    return result
  } finally {
    if (handle) {
      try {
        await c.request({ op: OPS.CLOSE_TAB, profile, args: { tab: handle }, timeoutMs: t.requestTimeoutMs })
        result.closed = true
      } catch (err) {
        result.closed = false
        result.closeError = cliError(err)
      }
    }
  }
}

/** The exit code for a finished read. */
export function exitCodeFor(r) {
  if (r.ok && r.closed) return 0
  if (r.ok) return 3
  return 1
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

const USAGE =
  `${PRODUCT_NAME} read-page\n` +
  '\n' +
  '  node scripts/read-page.mjs <profile label> <url> [--comments] [--json]\n' +
  '\n' +
  '  --comments          scroll down first, keeping each step, so lazy threads load\n' +
  '  --json              print one JSON object (url, title, chars, text, closed)\n' +
  `  --max-chars <n>     stop reading after this many characters (default ${DEFAULT_MAX_CHARS})\n` +
  '  --socket <path>     dial a different broker endpoint\n' +
  '\n' +
  'Opens the page in a background tab, reads its text, closes the tab. It sends no click,\n' +
  'fill, key press, navigation or caller JavaScript, so it cannot press anything on the page.\n' +
  'The visit itself is real: never point it at a sign-out, unsubscribe or download link.\n' +
  'Exit: 0 read and closed, 1 not landed, 2 usage, 3 read but the tab was left open.'

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

  // Ctrl+C ends the read at the next step and still closes the tab. A hard kill
  // cannot be caught, which is why the whole read has its own deadline.
  const signal = { aborted: false }
  const onSignal = () => {
    signal.aborted = true
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  return withBroker(
    async (client) => {
      const r = await readPage({
        client,
        profile: parsed.profile,
        url: target.url,
        comments: parsed.comments,
        maxChars: parsed.maxChars,
        signal,
      })
      if (parsed.json) {
        console.log(JSON.stringify(r))
      } else if (r.ok) {
        console.error(`${parsed.profile}: read ${r.chars} characters from ${r.url || target.url}${r.scrolls ? ` after ${r.scrolls} scrolls` : ''}`)
        console.log(stripControls(r.text))
      }
      if (r.ok && !r.closed) console.error(`The page was read, but its tab could not be closed: ${r.closeError || 'no detail'}`)
      if (!r.ok) console.error(r.message || 'The page did not land.')
      return exitCodeFor(r)
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
      console.error(cliError(err))
      process.exitCode = 1
    }
  )
}
