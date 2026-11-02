#!/usr/bin/env node
/**
 * snapshot-tabs - one profile's tabs and tab groups as one JSON document, read only.
 *
 *   node scripts/snapshot-tabs.mjs <profile label> > tabs.json
 *
 * Every tab (handle, window, position, title, address, its group's title and
 * color, pinned, active, playing sound, discarded, when it was last shown) and
 * every window's groups, sorted by window and position. The base for a tab
 * report, an audit, a "what was I working on" note, or a plan for
 * `group-tabs.mjs` and `close-duplicates.mjs`.
 *
 * Read only by construction: its vocabulary is two operations, list tabs and
 * list groups, and anything else is refused before it reaches the broker. It
 * opens, reads, moves and closes nothing.
 *
 * Exit codes: 0 the snapshot was printed; 1 the broker answered with an error;
 * 2 a usage error.
 *
 * Flags:
 *   --socket <path>     dial a different broker endpoint
 */

import { OPS, PRODUCT_NAME } from '../shared/protocol.mjs'
import { describeError, isMain, withBroker } from './claim.mjs'

/** The whole vocabulary of this command. Anything else is refused locally. */
export const SNAPSHOT_OPS = Object.freeze([OPS.LIST_TABS, OPS.LIST_GROUPS])

/**
 * Build the snapshot from a tab listing and a group listing.
 *
 * @param {string} profile
 * @param {{tabs?: Array<object>}} listedTabs     what LIST_TABS answered
 * @param {{windows?: Array<object>}} listedGroups what LIST_GROUPS answered
 * @param {Date} [at]
 */
export function buildSnapshot(profile, listedTabs, listedGroups, at = new Date()) {
  const groupById = new Map()
  const windows = []
  for (const w of Array.isArray(listedGroups?.windows) ? listedGroups.windows : []) {
    const groups = Array.isArray(w.groups) ? w.groups : []
    for (const g of groups) groupById.set(g.groupId, g)
    windows.push({ windowId: w.windowId, tabs: w.tabs, pinned: w.pinned, loose: w.loose, groups })
  }
  const tabs = (Array.isArray(listedTabs?.tabs) ? listedTabs.tabs : []).map((t) => {
    const g = Number.isInteger(t.groupId) && t.groupId >= 0 ? groupById.get(t.groupId) : undefined
    return {
      handle: t.handle,
      windowId: t.windowId,
      index: t.index,
      title: t.title || '',
      url: t.url || '',
      group: g ? g.title : null,
      groupColor: g ? g.color : null,
      pinned: Boolean(t.pinned),
      active: Boolean(t.active),
      audible: Boolean(t.audible),
      discarded: Boolean(t.discarded),
      lastAccessed: Number.isFinite(t.lastAccessed) ? t.lastAccessed : null,
    }
  })
  tabs.sort((a, b) => (a.windowId ?? 0) - (b.windowId ?? 0) || (a.index ?? 0) - (b.index ?? 0))
  return { profile, readAt: at.toISOString(), count: tabs.length, windows, tabs }
}

/**
 * Read one profile. Only the two list operations can leave this function.
 *
 * @param {{client:{request:Function}, profile:string, timeoutMs?:number}} spec
 */
export async function snapshotTabs({ client, profile, timeoutMs = 30_000 }) {
  const send = (op) => {
    if (!SNAPSHOT_OPS.includes(op)) throw new Error(`snapshot-tabs refuses the operation "${op}": it only lists.`)
    return client.request({ op, profile, timeoutMs })
  }
  const tabs = await send(OPS.LIST_TABS)
  const groups = await send(OPS.LIST_GROUPS)
  return buildSnapshot(profile, tabs, groups)
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : []
  let socket
  const positional = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--socket') {
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
  return { mode: 'run', profile: positional[0], socket }
}

const USAGE =
  `${PRODUCT_NAME} snapshot-tabs\n` +
  '\n' +
  '  node scripts/snapshot-tabs.mjs <profile label> > tabs.json\n' +
  '\n' +
  '  --socket <path>     dial a different broker endpoint\n' +
  '\n' +
  "Prints one JSON document: every tab of the profile with its group's title and color,\n" +
  'and every window with its groups. Read only: it lists, and sends nothing else.'

async function main(argv) {
  const parsed = parseArgs(argv)
  if (parsed.mode === 'usage') {
    if (parsed.message) console.error(parsed.message, '\n')
    console.error(USAGE)
    return 2
  }
  return withBroker(
    async (client) => {
      const snap = await snapshotTabs({ client, profile: parsed.profile })
      console.log(JSON.stringify(snap, null, 2))
      console.error(`${parsed.profile}: ${snap.count} tabs in ${snap.windows.length} windows.`)
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
