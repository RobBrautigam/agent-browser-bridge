#!/usr/bin/env node
/**
 * group-tabs - put a profile's tabs into named, colored groups from a plan.
 *
 *   node scripts/group-tabs.mjs <profile label> <plan.json> [--dry-run] [--json]
 *
 * The plan is a JSON file:
 *
 *   { "groups": [
 *       { "title": "Decide", "color": "red", "tabs": ["tab_work_1_812", ...] },
 *       { "title": "Read later", "color": "grey", "collapsed": true, "tabs": [...] }
 *   ] }
 *
 * Groups are listed left to right, and each group's tabs in the order they
 * should stand. Tabs are the handles browser_list_tabs (or this profile's
 * LIST_TABS) returned.
 *
 * In each window, as it stands: every group in plan order is made (or reused
 * by its exact title in that window), filled with the plan's tabs that are in
 * that window, in the plan's order, and moved to the end of the window, so the
 * groups end up left to right in plan order after any tab the plan does not
 * name. Then the groups marked collapsed are collapsed, except one that holds
 * its window's active tab, which the browser would otherwise switch away from.
 * Then everything is listed again and each tab is checked against its group.
 *
 * A group whose tabs are in two windows becomes a group of that title in each
 * window: no tab is ever moved to another window. A pinned tab is left where
 * it is (grouping would unpin it), and a tab no longer open is skipped; both
 * are reported.
 *
 * Gathering into one window, opt-in: a plan with `"window"` (a window id, or
 * "last-focused" for the window the person used last) brings every group of
 * each planned title, from every window, into that one window and folds them
 * into one group per title, then lines them up left to right in plan order.
 * Only the tabs of a group of a planned title change window: a planned tab
 * that is in another window and in no group of that title is left there and
 * reported. A group holding its window's active tab is gathered too; that
 * window shows whatever tab the browser picks next, and a window left with no
 * tabs is closed by the browser (no tab is). The read-back fails while any
 * planned title still stands in more than one group or outside that window.
 *
 *   { "window": "last-focused", "groups": [ { "title": "Decide", "color": "red", "tabs": [] }, ... ] }
 *
 * Group-only by construction. Everything this command sends goes through
 * `groupOnlyClient`, which passes exactly four operations (list groups, group
 * tabs, update a group, move a group), plus the gather into the one host
 * window when the plan names it, and refuses everything else before it
 * reaches the broker: no close, no reload, no navigation, no new tab, no
 * activation, no caller JavaScript, and not even ungrouping.
 *
 * Exit codes: 0 every planned tab is in its group; 1 something did not land (a
 * tab outside its group, a broker or profile error); 2 a usage error or a plan
 * that does not parse. The reason is on stderr in every non-zero case.
 *
 * Flags:
 *   --dry-run           list, plan and print the steps, change nothing
 *   --json              print one JSON object instead of the summary
 *   --socket <path>     dial a different broker endpoint
 */

import fs from 'node:fs'

import { GROUP_COLORS, GROUP_TITLE_MAX, OPS, PRODUCT_NAME } from '../shared/protocol.mjs'
import { describeError, isMain, withBroker } from './claim.mjs'

/** The whole vocabulary of this command. Anything else is refused locally. */
export const GROUP_ONLY_OPS = Object.freeze([OPS.LIST_GROUPS, OPS.GROUP_TABS, OPS.UPDATE_GROUP, OPS.MOVE_GROUP])

/** Argument keys only the broker may write: a raw tab id skips handle validation. */
const RAW_TAB_KEYS = ['tabId', 'tabIds']

const MAX_TABS = 2_000

/** The extension groups at most this many tabs in one call, and a group is one call per window. */
const MAX_TABS_PER_GROUP = 500

/** The value of a plan's "window" that means the window the person used last. */
export const LAST_FOCUSED = 'last-focused'

/**
 * Wrap a broker client so it can only list, group, update and move groups.
 *
 * The refusals happen here, before a frame is written, so a slip elsewhere in
 * this file cannot close, reload or navigate a tab, or reach a tab by a raw id.
 * A gather passes only when `gatherInto` names the host window, and only into
 * that window.
 *
 * @param {{request: Function}} client
 * @param {{gatherInto?: number}} [options]
 */
export function groupOnlyClient(client, { gatherInto } = {}) {
  return {
    async request(msg) {
      const op = msg && msg.op
      const args = (msg && msg.args) || {}
      if (op === OPS.GATHER_GROUP && Number.isInteger(gatherInto)) {
        if (args.window !== gatherInto) {
          throw new Error(`group-tabs gathers only into the host window ${gatherInto}, not window ${args.window}.`)
        }
      } else if (!GROUP_ONLY_OPS.includes(op)) {
        throw new Error(`group-tabs refuses the operation "${op}": it only lists, groups, updates and moves tab groups.`)
      }
      if (RAW_TAB_KEYS.some((k) => k in args)) {
        throw new Error('group-tabs addresses tabs by handle, never by a raw tab id.')
      }
      if ('tabs' in args && !(Array.isArray(args.tabs) && args.tabs.every((h) => typeof h === 'string'))) {
        throw new Error('group-tabs sends tabs as a list of handles.')
      }
      return client.request(msg)
    },
  }
}

/**
 * Check a plan and give it one shape.
 *
 * @param {unknown} raw  the parsed JSON
 * @returns {{ok: true, plan: {groups: {title: string, color: string, collapsed: boolean, tabs: string[]}[]}} | {ok: false, message: string}}
 */
export function parsePlan(raw) {
  const groups = raw && typeof raw === 'object' && Array.isArray(raw.groups) ? raw.groups : null
  if (!groups || groups.length === 0) return { ok: false, message: 'The plan needs "groups": a list of { title, color, tabs }.' }
  const window = raw.window
  if (window !== undefined && window !== LAST_FOCUSED && !(Number.isInteger(window) && window >= 0)) {
    return { ok: false, message: `"window" is the window to gather every group into: a window id, or "${LAST_FOCUSED}".` }
  }
  const titles = new Set()
  const seen = new Map()
  const out = []
  let total = 0
  for (const [i, g] of groups.entries()) {
    const where = `group ${i + 1}`
    if (!g || typeof g !== 'object') return { ok: false, message: `${where} is not an object.` }
    const title = typeof g.title === 'string' ? g.title.trim() : ''
    if (!title) return { ok: false, message: `${where} has no title.` }
    if (title.length > GROUP_TITLE_MAX) return { ok: false, message: `"${title}" is longer than ${GROUP_TITLE_MAX} characters.` }
    if (titles.has(title)) return { ok: false, message: `"${title}" is in the plan twice; give each group one entry.` }
    titles.add(title)
    const color = g.color === undefined ? 'grey' : g.color
    if (!GROUP_COLORS.includes(color)) return { ok: false, message: `"${title}": "${color}" is not a group color (${GROUP_COLORS.join(', ')}).` }
    if (g.collapsed !== undefined && typeof g.collapsed !== 'boolean') return { ok: false, message: `"${title}": "collapsed" is true or false.` }
    if (!Array.isArray(g.tabs)) return { ok: false, message: `"${title}" has no "tabs" list.` }
    if (g.tabs.length > MAX_TABS_PER_GROUP) {
      return { ok: false, message: `"${title}" has ${g.tabs.length} tabs; a group takes at most ${MAX_TABS_PER_GROUP}. Split it.` }
    }
    const tabs = []
    for (const h of g.tabs) {
      if (typeof h !== 'string' || !h) return { ok: false, message: `"${title}": every tab is a handle string.` }
      if (seen.has(h)) return { ok: false, message: `${h} is in "${seen.get(h)}" and "${title}"; a tab goes in one group.` }
      seen.set(h, title)
      tabs.push(h)
    }
    total += tabs.length
    out.push({ title, color, collapsed: g.collapsed === true, tabs })
  }
  if (total > MAX_TABS) return { ok: false, message: `${total} tabs in one plan; the most is ${MAX_TABS}.` }
  return { ok: true, plan: window === undefined ? { groups: out } : { window, groups: out } }
}

/**
 * Split a plan by window, as the tabs stand now.
 *
 * @param {{plan: {groups: object[]}, listed: {tabs: {handle: string, windowId: number, pinned?: boolean}[]}}} spec
 * @returns {{windows: {windowId: number, groups: object[]}[], skipped: {handle: string, group: string, reason: string}[]}}
 */
export function planApply({ plan, listed }) {
  const where = new Map()
  for (const t of (listed && Array.isArray(listed.tabs) ? listed.tabs : [])) {
    if (t && typeof t.handle === 'string') where.set(t.handle, t)
  }
  const byWindow = new Map()
  const skipped = []
  for (const g of plan.groups) {
    for (const handle of g.tabs) {
      const tab = where.get(handle)
      if (!tab) {
        skipped.push({ handle, group: g.title, reason: 'not open' })
        continue
      }
      if (tab.pinned) {
        skipped.push({ handle, group: g.title, reason: 'pinned' })
        continue
      }
      if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, new Map())
      const groups = byWindow.get(tab.windowId)
      if (!groups.has(g.title)) groups.set(g.title, { title: g.title, color: g.color, collapsed: g.collapsed, tabs: [] })
      groups.get(g.title).tabs.push(handle)
    }
  }
  const order = new Map(plan.groups.map((g, i) => [g.title, i]))
  const windows = [...byWindow.entries()]
    .sort(([a], [b]) => a - b)
    .map(([windowId, groups]) => ({
      windowId,
      groups: [...groups.values()].sort((a, b) => order.get(a.title) - order.get(b.title)),
    }))
  return { windows, skipped }
}

/** Per window, each group's title, count and collapsed state, left to right. */
function countsOf(listed) {
  return (listed && Array.isArray(listed.windows) ? listed.windows : []).map((w) => ({
    windowId: w.windowId,
    groups: (w.groups || []).map((g) => ({ title: g.title, count: g.count, collapsed: Boolean(g.collapsed) })),
  }))
}

/**
 * Group one window's named tabs under a plan group's title, in the plan's order.
 *
 * A tab closed or dragged to another window since the listing fails the whole
 * call, so on a failure the profile is listed again, the tabs no longer in this
 * window are dropped (and reported in `skipped`), and the call is tried once
 * more with the rest. `g.tabs` is narrowed to what was grouped, so the
 * read-back checks only those. Shared by the plain apply and the gather.
 *
 * @returns {Promise<number|undefined>} the group id, or undefined when nothing was grouped
 */
async function groupNamed({ send, windowId, g, skipped, notes, errors }) {
  const once = async () => {
    const r = await send(OPS.GROUP_TABS, { tabs: g.tabs, title: g.title, color: g.color, collapsed: false })
    const groupId = r && r.group ? r.group.groupId : undefined
    if (!Number.isInteger(groupId)) throw new Error(`"${g.title}" in window ${windowId} came back without a group id.`)
    if (r.note) notes.push(r.note)
    return groupId
  }
  try {
    return await once()
  } catch (err) {
    try {
      const now = await send(OPS.LIST_GROUPS, {})
      const here = new Set(((now && now.tabs) || []).filter((t) => t.windowId === windowId && !t.pinned).map((t) => t.handle))
      const keep = g.tabs.filter((h) => here.has(h))
      if (keep.length === g.tabs.length) {
        errors.push(`"${g.title}" in window ${windowId}: ${describeError(err)}`)
        return undefined
      }
      for (const h of g.tabs.filter((x) => !here.has(x))) skipped.push({ handle: h, group: g.title, reason: 'closed or moved during the run' })
      g.tabs = keep
      return keep.length > 0 ? await once() : undefined
    } catch (again) {
      errors.push(`"${g.title}" in window ${windowId}: ${describeError(again)}`)
      return undefined
    }
  }
}

/** Collapse the groups the plan marks collapsed; a skipped collapse comes back as a note. */
async function collapseMarked({ send, made, notes, errors }) {
  for (const m of made) {
    if (!m.collapsed) continue
    try {
      const r = await send(OPS.UPDATE_GROUP, { group: m.groupId, collapsed: true })
      if (r && r.note) notes.push(r.note)
    } catch (err) {
      errors.push(`collapsing "${m.title}" in window ${m.windowId}: ${describeError(err)}`)
    }
  }
}

/** Move one group to the end of its window, so the groups stand in plan order. */
async function toTheEnd({ send, windowId, title, groupId, errors }) {
  try {
    await send(OPS.MOVE_GROUP, { group: groupId, index: -1 })
  } catch (err) {
    errors.push(`moving "${title}" in window ${windowId}: ${describeError(err)}`)
  }
}

/**
 * Apply a plan to one profile, then read it back.
 *
 * @param {{client: {request: Function}, profile: string, plan: object, dryRun?: boolean}} spec
 */
export async function applyPlan({ client, profile, plan, dryRun = false }) {
  const c = groupOnlyClient(client)
  const send = (op, args) => c.request({ op, profile, args })

  const before = await send(OPS.LIST_GROUPS, {})
  if (plan.window !== undefined) return applyGather({ client, profile, plan, dryRun, before })
  const steps = planApply({ plan, listed: before })
  if (dryRun) return { ok: true, dryRun: true, steps, before: countsOf(before) }

  const made = [] // { windowId, title, groupId, collapsed }
  const notes = []
  const errors = []
  const skipped = [...steps.skipped]

  // One group at a time, and a failure is that group's alone: every later group
  // and window is still made, and the collapse pass still runs.
  for (const w of steps.windows) {
    for (const g of w.groups) {
      const groupId = await groupNamed({ send, windowId: w.windowId, g, skipped, notes, errors })
      if (groupId === undefined) continue
      made.push({ windowId: w.windowId, title: g.title, groupId, collapsed: g.collapsed })
      await toTheEnd({ send, windowId: w.windowId, title: g.title, groupId, errors })
    }
  }
  await collapseMarked({ send, made, notes, errors })

  // The read-back is the proof, and its failure must not lose what was done.
  let after
  try {
    after = await send(OPS.LIST_GROUPS, {})
  } catch (err) {
    errors.push(`the read-back: ${describeError(err)}`)
    return { ok: false, counts: null, made: made.map(({ windowId, title }) => ({ windowId, title })), misplaced: [], skipped, notes, message: errors.join(' | ') }
  }
  const error = errors.length > 0 ? errors.join(' | ') : null
  const titleOf = new Map()
  for (const w of (after && after.windows) || []) {
    for (const g of w.groups || []) titleOf.set(g.groupId, { title: g.title, windowId: w.windowId })
  }
  const groupOfTab = new Map(((after && after.tabs) || []).map((t) => [t.handle, t.groupId]))
  const misplaced = []
  for (const w of steps.windows) {
    for (const g of w.groups) {
      for (const handle of g.tabs) {
        const found = titleOf.get(groupOfTab.get(handle))
        if (!found || found.title !== g.title || found.windowId !== w.windowId) misplaced.push({ handle, group: g.title })
      }
    }
  }
  const result = { ok: !error && misplaced.length === 0, counts: countsOf(after), misplaced, skipped }
  if (notes.length > 0) result.notes = notes
  if (error) result.message = error
  return result
}

/** Each group of a listing as { title, windowId, groupId, count }, window by window, left to right. */
function groupsIn(listed) {
  const out = []
  for (const w of (listed && Array.isArray(listed.windows) ? listed.windows : [])) {
    for (const g of w.groups || []) out.push({ title: g.title, windowId: w.windowId, groupId: g.groupId, count: g.count })
  }
  return out
}

/**
 * Apply a plan that names a host window: gather, fold, line up, collapse, read back.
 *
 * @param {{client: {request: Function}, profile: string, plan: object, dryRun: boolean, before: object}} spec
 */
async function applyGather({ client, profile, plan, dryRun, before }) {
  const host = plan.window === LAST_FOCUSED ? before && before.lastFocusedWindowId : plan.window
  const windowIds = ((before && before.windows) || []).map((w) => w.windowId)
  if (!Number.isInteger(host) || !windowIds.includes(host)) {
    const what = plan.window === LAST_FOCUSED ? 'The window used last could not be read' : `There is no window ${plan.window} in this profile`
    return { ok: false, host: null, counts: countsOf(before), misplaced: [], strays: [], skipped: [], message: `${what}; nothing was moved.` }
  }
  const gather = plan.groups.map((g) => ({
    title: g.title,
    from: groupsIn(before)
      .filter((x) => x.title === g.title && x.windowId !== host)
      .map(({ windowId, count }) => ({ windowId, count })),
  }))
  if (dryRun) return { ok: true, dryRun: true, host, gather, before: countsOf(before) }

  const c = groupOnlyClient(client, { gatherInto: host })
  const send = (op, args) => c.request({ op, profile, args })
  const notes = []
  const errors = []

  // Every title, in plan order. A group that could not move stays a stray in
  // the read-back.
  for (const g of plan.groups) {
    try {
      const r = await send(OPS.GATHER_GROUP, { title: g.title, window: host })
      if (r && r.note) notes.push(r.note)
    } catch (err) {
      errors.push(`gathering "${g.title}": ${describeError(err)}`)
    }
  }

  // Named tabs in the host join their group; each group then goes to the end
  // of the host window in plan order, in its color.
  let now
  try {
    now = await send(OPS.LIST_GROUPS, {})
  } catch (err) {
    return { ok: false, host, counts: null, misplaced: [], strays: [], skipped: [], notes, message: [...errors, `listing after the gather: ${describeError(err)}`].join(' | ') }
  }
  const steps = planApply({ plan, listed: now })
  const skipped = [...steps.skipped]
  const inHost = new Map()
  for (const w of steps.windows) {
    for (const g of w.groups) {
      if (w.windowId === host) inHost.set(g.title, g)
      else for (const handle of g.tabs) skipped.push({ handle, group: g.title, reason: 'in another window and in no group of that title' })
    }
  }
  const made = []
  for (const g of plan.groups) {
    let groupId
    const named = inHost.get(g.title)
    if (named && named.tabs.length > 0) {
      groupId = await groupNamed({ send, windowId: host, g: named, skipped, notes, errors })
      if (groupId === undefined) continue
    } else {
      const found = groupsIn(now).find((x) => x.title === g.title && x.windowId === host)
      if (!found) continue
      groupId = found.groupId
      const props = { group: groupId, color: g.color }
      if (!g.collapsed) props.collapsed = false
      try {
        await send(OPS.UPDATE_GROUP, props)
      } catch (err) {
        errors.push(`"${g.title}" in window ${host}: ${describeError(err)}`)
        continue
      }
    }
    made.push({ windowId: host, title: g.title, groupId, collapsed: g.collapsed })
    await toTheEnd({ send, windowId: host, title: g.title, groupId, errors })
  }
  await collapseMarked({ send, made, notes, errors })

  let after
  try {
    after = await send(OPS.LIST_GROUPS, {})
  } catch (err) {
    errors.push(`the read-back: ${describeError(err)}`)
    return { ok: false, host, counts: null, made: made.map(({ title }) => ({ windowId: host, title })), misplaced: [], strays: [], skipped, notes, message: errors.join(' | ') }
  }
  // The proof: each planned title is at most one group, and that one is in the
  // host window; each named tab in the host is in its group.
  const all = groupsIn(after)
  const strays = []
  for (const g of plan.groups) {
    const mine = all.filter((x) => x.title === g.title)
    const kept = mine.find((x) => x.windowId === host)
    for (const x of mine) {
      if (x !== kept) strays.push({ title: g.title, windowId: x.windowId, count: x.count })
    }
  }
  const byId = new Map(all.map((x) => [x.groupId, x]))
  const groupOfTab = new Map(((after && after.tabs) || []).map((t) => [t.handle, t.groupId]))
  const misplaced = []
  for (const [title, g] of inHost) {
    for (const handle of g.tabs) {
      const found = byId.get(groupOfTab.get(handle))
      if (!found || found.title !== title || found.windowId !== host) misplaced.push({ handle, group: title })
    }
  }
  const result = { ok: errors.length === 0 && strays.length === 0 && misplaced.length === 0, host, counts: countsOf(after), misplaced, strays, skipped }
  if (notes.length > 0) result.notes = notes
  if (errors.length > 0) result.message = errors.join(' | ')
  else if (strays.length > 0) result.message = `${strays.length} group${strays.length === 1 ? '' : 's'} not gathered into one per title in window ${host}.`
  return result
}

/** @param {{ok: boolean}} result */
export function exitCodeFor(result) {
  return result && result.ok ? 0 : 1
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

const USAGE =
  `${PRODUCT_NAME} group-tabs\n` +
  '\n' +
  '  node scripts/group-tabs.mjs <profile label> <plan.json> [--dry-run] [--json]\n' +
  '\n' +
  '  --dry-run           list and plan, print the steps, change nothing\n' +
  '  --json              print one JSON object (ok, counts, misplaced, skipped)\n' +
  '  --socket <path>     dial a different broker endpoint\n' +
  '\n' +
  'Groups each window\'s planned tabs under the plan\'s titles and colors, left to right in plan\n' +
  'order, collapses the groups marked collapsed, and reads it all back. It never closes, reloads,\n' +
  'navigates, opens or activates a tab, and never moves a tab to another window.\n' +
  '\n' +
  'With "window" in the plan (a window id, or "last-focused"), every group of each planned title is\n' +
  'gathered from every window into that one and folded into one group per title: only the tabs of\n' +
  'those groups change window, and a window left with no tabs is closed by the browser.\n' +
  'Exit: 0 every tab in its group, 1 something did not land, 2 usage or a bad plan.'

export function parseArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : []
  let dryRun = false
  let json = false
  let socket
  const positional = []
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === '--dry-run') dryRun = true
    else if (a === '--json') json = true
    else if (a === '--socket') {
      socket = args[i + 1]
      i += 1
      if (!socket) return { mode: 'usage', message: '--socket needs a path.' }
    } else if (a === '-h' || a === '--help') return { mode: 'usage' }
    else if (a.startsWith('--')) return { mode: 'usage', message: `Unknown flag ${a}.` }
    else positional.push(a)
  }
  if (positional.length !== 2) return { mode: 'usage', message: 'A profile label and a plan file are required.' }
  return { mode: 'run', profile: positional[0], planFile: positional[1], dryRun, json, socket }
}

function summary(result) {
  const lines = []
  for (const w of result.counts || result.before || []) {
    lines.push(`window ${w.windowId}: ${w.groups.map((g) => `${g.title} ${g.count}${g.collapsed ? ' (collapsed)' : ''}`).join(', ') || 'no groups'}`)
  }
  if (result.dryRun && result.gather) {
    for (const g of result.gather) {
      const from = g.from.map((f) => `${f.count} from window ${f.windowId}`).join(', ')
      lines.push(`would gather "${g.title}" into window ${result.host}${from ? `: ${from}` : ': nothing to move'}`)
    }
  } else if (result.dryRun) {
    for (const w of result.steps.windows) {
      lines.push(`would group window ${w.windowId}: ${w.groups.map((g) => `${g.title} ${g.tabs.length}`).join(', ')}`)
    }
  }
  for (const s of result.skipped || (result.steps && result.steps.skipped) || []) lines.push(`skipped ${s.handle} (${s.group}): ${s.reason}`)
  for (const m of result.misplaced || []) lines.push(`NOT IN ITS GROUP: ${m.handle} should be in "${m.group}"`)
  for (const s of result.strays || []) {
    lines.push(
      s.windowId === result.host
        ? `NOT FOLDED: a second "${s.title}" group, ${s.count} tabs, in window ${s.windowId}`
        : `STILL OUTSIDE WINDOW ${result.host}: "${s.title}", ${s.count} tabs in window ${s.windowId}`
    )
  }
  for (const n of result.notes || []) lines.push(`note: ${n}`)
  return lines.join('\n')
}

async function main(argv) {
  const parsed = parseArgs(argv)
  if (parsed.mode === 'usage') {
    if (parsed.message) console.error(parsed.message, '\n')
    console.error(USAGE)
    return 2
  }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(parsed.planFile, 'utf8'))
  } catch (err) {
    console.error(`Could not read the plan: ${err.message}`)
    return 2
  }
  const checked = parsePlan(raw)
  if (!checked.ok) {
    console.error(checked.message)
    return 2
  }
  return withBroker(
    async (client) => {
      const result = await applyPlan({ client, profile: parsed.profile, plan: checked.plan, dryRun: parsed.dryRun })
      if (parsed.json) console.log(JSON.stringify(result))
      else console.log(summary(result))
      if (!result.ok) console.error(result.message || `${result.misplaced.length} tabs did not land in their groups.`)
      return exitCodeFor(result)
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
