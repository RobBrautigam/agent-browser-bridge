#!/usr/bin/env node
/**
 * close-duplicates - close the exact copies of a page in one profile, and nothing else.
 *
 *   node scripts/close-duplicates.mjs <profile label> [--dry-run] [--json]
 *
 * Lists every tab of the profile, finds the http and https addresses that are
 * open more than once (byte for byte the same address, query and fragment
 * included), keeps one copy of each, and closes the rest. `--dry-run` prints
 * the plan and closes nothing.
 *
 * Which copy is kept: the one shown in its window (active), then a pinned one,
 * then the one shown most recently, then the leftmost. A copy that is active,
 * pinned or playing sound is never closed, whatever the plan says.
 *
 * The plan is checked again before EACH close against a fresh listing: the
 * copy is still open at the same address and still not active, pinned or
 * playing sound, and its kept copy is still open at that address and was not
 * closed earlier in the run. A check that fails skips that close and says why,
 * so a tab the person navigated or switched to while the command ran is left
 * alone.
 *
 * Its vocabulary is two operations, list tabs and close a tab, and a close is
 * refused unless the plan named that tab. It never navigates, reloads,
 * activates or reads a page.
 *
 * Exit codes: 0 every planned close was done (or a dry run, or nothing to
 * close); 1 a planned close was skipped or failed, or the broker answered with
 * an error; 2 a usage error.
 *
 * Flags:
 *   --dry-run           print the plan, close nothing
 *   --json              print one JSON object instead of lines
 *   --socket <path>     dial a different broker endpoint
 */

import { OPS, PRODUCT_NAME } from '../shared/protocol.mjs'
import { describeError, isMain, withBroker } from './claim.mjs'

/** The whole vocabulary of this command. Anything else is refused locally. */
export const CLOSE_DUPLICATES_OPS = Object.freeze([OPS.LIST_TABS, OPS.CLOSE_TAB])

/** Argument keys only the broker may write: a raw tab id skips handle validation. */
const RAW_TAB_KEYS = ['tabId', 'tabIds', 'tabs']

const handleOf = (t) => (t && typeof t.handle === 'string' ? t.handle : null)

/**
 * Wrap a broker client so it can only list tabs and close the tabs it was told
 * it may close. The refusals happen before a frame is written.
 *
 * @param {{request: Function}} client
 */
export function guardedClient(client) {
  const closable = new Set()
  return {
    allow: (handle) => closable.add(handle),
    async request(msg) {
      const op = msg && msg.op
      if (!CLOSE_DUPLICATES_OPS.includes(op)) {
        throw new Error(`close-duplicates refuses the operation "${op}": it only lists tabs and closes planned copies.`)
      }
      const args = (msg && msg.args) || {}
      if (RAW_TAB_KEYS.some((k) => k in args)) {
        throw new Error('close-duplicates addresses tabs by handle, never by a raw tab id.')
      }
      if (op === OPS.CLOSE_TAB && (typeof args.tab !== 'string' || !closable.has(args.tab))) {
        throw new Error('close-duplicates refuses to close a tab its plan did not name.')
      }
      return client.request(msg)
    },
  }
}

/** True for an address worth de-duplicating: http or https, nothing internal to the browser. */
function isWebAddress(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url)
}

/** A copy that must stay open whatever the plan says. Returns the reason, or null. */
function mustStay(t) {
  if (t.active) return 'active'
  if (t.pinned) return 'pinned'
  if (t.audible) return 'playing sound'
  return null
}

/** Keeper order: shown, pinned, shown most recently, leftmost. */
function keeperOrder(a, b) {
  return (
    Number(Boolean(b.active)) - Number(Boolean(a.active)) ||
    Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
    (Number(b.lastAccessed) || 0) - (Number(a.lastAccessed) || 0) ||
    (Number(a.windowId) || 0) - (Number(b.windowId) || 0) ||
    (Number(a.index) || 0) - (Number(b.index) || 0)
  )
}

/**
 * The plan: one entry per copy to close, each naming the copy it keeps.
 *
 * @param {Array<object>} tabs  the profile's tab rows (handle, url, active, pinned, audible, lastAccessed, windowId, index, title)
 * @returns {{closes: Array<{close:string, keep:string, url:string, title:string}>, staying: Array<{tab:string, url:string, reason:string}>, addresses:number}}
 */
export function planDuplicates(tabs) {
  const byUrl = new Map()
  for (const t of Array.isArray(tabs) ? tabs : []) {
    if (!handleOf(t) || !isWebAddress(t.url)) continue
    if (!byUrl.has(t.url)) byUrl.set(t.url, [])
    byUrl.get(t.url).push(t)
  }
  const closes = []
  const staying = []
  let addresses = 0
  for (const [url, copies] of byUrl) {
    if (copies.length < 2) continue
    addresses += 1
    const [keep, ...rest] = [...copies].sort(keeperOrder)
    for (const t of rest) {
      const reason = mustStay(t)
      if (reason) staying.push({ tab: handleOf(t), url, reason })
      else closes.push({ close: handleOf(t), keep: handleOf(keep), url, title: t.title || '' })
    }
  }
  return { closes, staying, addresses }
}

/**
 * One planned close against a listing taken right before it. Returns why it
 * must be skipped, or null when it may go ahead.
 *
 * @param {{close:string, keep:string, url:string}} entry
 * @param {Array<object>} tabs     a fresh listing
 * @param {Set<string>} closed     handles this run has already closed
 */
export function checkClose(entry, tabs, closed = new Set()) {
  const byHandle = new Map((Array.isArray(tabs) ? tabs : []).map((t) => [handleOf(t), t]))
  const t = byHandle.get(entry.close)
  const k = byHandle.get(entry.keep)
  if (entry.keep === entry.close) return 'it is its own kept copy'
  if (closed.has(entry.keep)) return 'its kept copy was closed by this run'
  if (!t) return 'it is no longer open'
  if (t.url !== entry.url) return 'its address changed'
  const stay = mustStay(t)
  if (stay) return `it is ${stay} now`
  if (!k) return 'its kept copy is no longer open'
  if (k.url !== entry.url) return 'its kept copy moved to another address'
  return null
}

/**
 * List, plan, and (unless a dry run) close each planned copy after a fresh check.
 *
 * @param {{client:{request:Function}, profile:string, dryRun?:boolean, timeoutMs?:number}} spec
 */
export async function closeDuplicates({ client, profile, dryRun = false, timeoutMs = 30_000 }) {
  const c = guardedClient(client)
  const list = async () => {
    const listed = await c.request({ op: OPS.LIST_TABS, profile, timeoutMs })
    return Array.isArray(listed?.tabs) ? listed.tabs : []
  }
  const first = await list()
  const plan = planDuplicates(first)
  const report = {
    profile,
    dryRun,
    before: first.length,
    after: first.length,
    addresses: plan.addresses,
    staying: plan.staying,
    results: [],
  }
  if (dryRun || plan.closes.length === 0) {
    report.results = plan.closes.map((e) => ({ ...e, closed: false, reason: dryRun ? 'dry run' : null }))
    return report
  }
  const closed = new Set()
  for (const entry of plan.closes) {
    const reason = checkClose(entry, await list(), closed)
    if (reason) {
      report.results.push({ ...entry, closed: false, reason })
      continue
    }
    c.allow(entry.close)
    try {
      await c.request({ op: OPS.CLOSE_TAB, profile, args: { tab: entry.close }, timeoutMs })
      closed.add(entry.close)
      report.results.push({ ...entry, closed: true, reason: null })
    } catch (err) {
      report.results.push({ ...entry, closed: false, reason: describeError(err) })
    }
  }
  report.after = (await list()).length
  return report
}

/** The exit code for a finished run. */
export function exitCodeFor(report) {
  if (report.dryRun) return 0
  return report.results.every((r) => r.closed) ? 0 : 1
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : []
  let dryRun = false
  let json = false
  let socket
  const positional = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--json') json = true
    else if (arg === '--socket') {
      const value = args[i + 1]
      i += 1
      if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
        return { mode: 'usage', message: '--socket needs a value after it.' }
      }
      socket = value
    } else if (arg === '--help') return { mode: 'usage', message: '' }
    else if (typeof arg === 'string' && arg.startsWith('--')) return { mode: 'usage', message: `Unknown flag ${arg}.` }
    else positional.push(arg)
  }
  if (positional.length !== 1) return { mode: 'usage', message: 'Expected one profile label.' }
  return { mode: 'run', profile: positional[0], dryRun, json, socket }
}

/** One line per planned close, then the count. */
export function renderReport(report) {
  const lines = []
  for (const r of report.results) {
    const verb = report.dryRun ? 'would close' : r.closed ? 'closed' : 'skipped'
    lines.push(`${verb} ${r.close} (keeps ${r.keep})${r.reason && !report.dryRun ? ` - ${r.reason}` : ''} ${r.url}`)
  }
  for (const s of report.staying) lines.push(`kept ${s.tab}, a copy that is ${s.reason} ${s.url}`)
  const done = report.results.filter((r) => r.closed).length
  lines.push(
    report.dryRun
      ? `${report.results.length} copies of ${report.addresses} addresses would be closed; ${report.before} tabs open.`
      : `${done} of ${report.results.length} copies closed; tabs before ${report.before}, after ${report.after}.`
  )
  return lines.join('\n')
}

const USAGE =
  `${PRODUCT_NAME} close-duplicates\n` +
  '\n' +
  '  node scripts/close-duplicates.mjs <profile label> [--dry-run] [--json]\n' +
  '\n' +
  '  --dry-run           print the plan, close nothing\n' +
  '  --json              print one JSON object\n' +
  '  --socket <path>     dial a different broker endpoint\n' +
  '\n' +
  'Closes the exact copies of a page (the same http or https address, byte for byte),\n' +
  'keeping one of each. Never closes a tab that is active, pinned or playing sound, and\n' +
  'checks each close against a fresh listing first. Exit: 0 done, 1 a close skipped, 2 usage.'

async function main(argv) {
  const parsed = parseArgs(argv)
  if (parsed.mode === 'usage') {
    if (parsed.message) console.error(parsed.message, '\n')
    console.error(USAGE)
    return 2
  }
  return withBroker(
    async (client) => {
      const report = await closeDuplicates({ client, profile: parsed.profile, dryRun: parsed.dryRun })
      console.log(parsed.json ? JSON.stringify(report) : renderReport(report))
      return exitCodeFor(report)
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
