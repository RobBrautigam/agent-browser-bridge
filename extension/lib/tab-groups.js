/**
 * Tab groups: list them, group tabs under a title and a color, recolor,
 * collapse or expand, move a group, ungroup.
 *
 * Every rule here exists because the browser's own API does something a person
 * would not expect, and the tab strip being rearranged is a person's:
 *
 *   - chrome.tabs.group with no group id makes a NEW group in the CURRENT
 *     window ("Defaults to the current window") and drags the tabs there. So a
 *     new group always names the window the tabs are already in, and tabs from
 *     two windows are refused rather than gathered into one.
 *   - Grouping a pinned tab unpins it. Pinned tabs are refused.
 *   - chrome.tabGroups.move takes a windowId and moves the group to that
 *     window. This never passes one.
 *   - Collapsing a group that holds the window's active tab makes the browser
 *     switch the person to another tab. That collapse is skipped and said so.
 *   - A tab moved into the middle of a group joins it. Tabs are only ever moved
 *     inside their own group's span here, to order it (planGroupOrder).
 *   - The browser refuses edits while somebody drags a tab ("Tabs cannot be
 *     edited right now"). That is tried once more after a moment.
 *
 * Nothing here closes, reloads, navigates, pins, discards or activates a tab.
 *
 * Group ids are the browser's own: unique within one browser session and
 * scoped to the profile the request was routed to, so an id from another
 * profile finds nothing here. List again after a browser restart.
 *
 * Patterns from two MIT-licensed tab grouping extensions, no code copied:
 * metaory/smart-tab-groups (always pass the window when creating a group,
 * never collapse the group with the focused tab, retry the drag-lock error)
 * and Darsh-A/Ai-TabGroups-ZenBrowser (reuse an existing group by its exact
 * name rather than minting a near-duplicate).
 */

import { ERR, GROUP_COLORS, GROUP_TITLE_MAX, RAW_TAB_ID_FIELD, planGroupOrder } from './protocol.js'

const NONE_ID = -1
const MAX_TABS_PER_CALL = 500
const EDIT_BLOCKED = /cannot be edited right now/i

/** A failure with a protocol error code; ops.js turns it into an OpError. */
export class GroupError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'GroupError'
    this.code = code
  }
}

const bad = (message) => new GroupError(ERR.BAD_REQUEST, message)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Run one tab-strip edit, once more after a moment if somebody is dragging a tab. */
async function edit(fn, retryDelayMs) {
  try {
    return await fn()
  } catch (err) {
    if (!EDIT_BLOCKED.test(String(err && err.message ? err.message : err))) throw err
    await sleep(retryDelayMs)
    return fn()
  }
}

function retryDelay(args) {
  const n = Number(args && args.retryDelayMs)
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 2_000) : 300
}

/* -------------------------------------------------------------------------- */
/* Argument checks                                                             */
/* -------------------------------------------------------------------------- */

function checkTitle(title, { required }) {
  if (title === undefined || title === null) {
    if (required) throw bad('"title" is required: the name the group shows in the tab strip.')
    return undefined
  }
  if (typeof title !== 'string' || !title.trim()) throw bad('"title" must be a non-empty string.')
  const clean = title.trim()
  if (clean.length > GROUP_TITLE_MAX) throw bad(`"title" is ${clean.length} characters; a group title is at most ${GROUP_TITLE_MAX}.`)
  return clean
}

function checkColor(color) {
  if (color === undefined || color === null) return undefined
  if (!GROUP_COLORS.includes(color)) throw bad(`"${color}" is not a group color. Use one of: ${GROUP_COLORS.join(', ')}.`)
  return color
}

function checkCollapsed(collapsed) {
  if (collapsed === undefined || collapsed === null) return undefined
  if (typeof collapsed !== 'boolean') throw bad('"collapsed" is true or false.')
  return collapsed
}

function checkTabIds(args) {
  const ids = args && Array.isArray(args.tabIds) ? args.tabIds : null
  if (!ids || ids.length === 0) throw bad('Name the tabs: "tabs", a list of tab handles from browser_list_tabs.')
  if (ids.length > MAX_TABS_PER_CALL) throw bad(`${ids.length} tabs in one call; the most is ${MAX_TABS_PER_CALL}.`)
  if (!ids.every((id) => Number.isInteger(id))) throw bad('Every tab must be a tab handle.')
  return [...new Set(ids)]
}

function checkGroupId(value) {
  const id = Number(value)
  if (value === undefined || value === null || value === '' || !Number.isInteger(id) || id < 0) {
    throw bad('Name the group: "group", a group id from browser_list_groups.')
  }
  return id
}

async function getGroup(groupId) {
  try {
    return await chrome.tabGroups.get(groupId)
  } catch (_err) {
    throw bad(`There is no group ${groupId} in this profile. Group ids last for one browser session; browser_list_groups lists the current ones.`)
  }
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId)
  } catch (_err) {
    throw new GroupError(ERR.TAB_GONE, `Tab ${tabId} no longer exists in this profile.`)
  }
}

/** A group's tabs, in strip order. */
async function membersOf(groupId, windowId) {
  const tabs = await chrome.tabs.query({ windowId })
  return tabs.filter((t) => t.groupId === groupId).sort((a, b) => a.index - b.index)
}

/** The shape every answer describes a group with. */
async function describe(group) {
  const members = await membersOf(group.id, group.windowId)
  return {
    groupId: group.id,
    windowId: group.windowId,
    title: group.title || '',
    color: group.color,
    collapsed: Boolean(group.collapsed),
    index: members.length > 0 ? members[0].index : null,
    count: members.length,
  }
}

/**
 * Collapse a group unless it holds its window's active tab, which would make
 * the browser switch the person to another tab. Returns the note to report, or
 * null when nothing was skipped.
 */
async function collapseSafely(group, collapsed, retryDelayMs) {
  if (collapsed === undefined) return null
  if (collapsed === true) {
    const [active] = await chrome.tabs.query({ windowId: group.windowId, active: true })
    if (active && active.groupId === group.id) {
      return `Left "${group.title || group.id}" open: it holds the window's active tab, and collapsing it would switch the window to another tab.`
    }
  }
  await edit(() => chrome.tabGroups.update(group.id, { collapsed }), retryDelayMs)
  return null
}

/* -------------------------------------------------------------------------- */
/* The operations                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every normal window's groups, and which tab is in which.
 *
 * @param {{window?: number}} args  one window, by id; every normal window when absent
 */
export async function listGroups(args = {}) {
  let windowIds
  if (args.window !== undefined && args.window !== null) {
    const id = Number(args.window)
    let win = null
    try {
      win = Number.isInteger(id) ? await chrome.windows.get(id) : null
    } catch (_err) {
      win = null
    }
    if (!win) throw bad(`There is no window ${args.window} in this profile. browser_list_tabs lists each tab's windowId.`)
    if (win.type !== 'normal') throw bad(`Window ${id} is a ${win.type} window; only normal windows hold tab groups.`)
    windowIds = [id]
  } else {
    windowIds = (await chrome.windows.getAll({ windowTypes: ['normal'] })).map((w) => w.id)
  }

  const windows = []
  const rows = []
  for (const windowId of windowIds) {
    const tabs = (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index)
    const groups = await chrome.tabGroups.query({ windowId })
    const described = []
    for (const g of groups) {
      const members = tabs.filter((t) => t.groupId === g.id)
      described.push({
        groupId: g.id,
        title: g.title || '',
        color: g.color,
        collapsed: Boolean(g.collapsed),
        index: members.length > 0 ? members[0].index : null,
        count: members.length,
      })
    }
    described.sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity))
    windows.push({
      windowId,
      tabs: tabs.length,
      pinned: tabs.filter((t) => t.pinned).length,
      loose: tabs.filter((t) => !t.pinned && (!Number.isInteger(t.groupId) || t.groupId === NONE_ID)).length,
      groups: described,
    })
    for (const t of tabs) {
      rows.push({
        [RAW_TAB_ID_FIELD]: t.id,
        windowId,
        index: t.index,
        groupId: Number.isInteger(t.groupId) ? t.groupId : NONE_ID,
        pinned: Boolean(t.pinned),
        active: Boolean(t.active),
      })
    }
  }
  const groupCount = windows.reduce((n, w) => n + w.groups.length, 0)
  return {
    windows,
    tabs: rows,
    message: `${windows.length} window${windows.length === 1 ? '' : 's'}, ${groupCount} group${groupCount === 1 ? '' : 's'}.`,
  }
}

/**
 * Put tabs in the group with this title in their window, in the order given.
 *
 * The group is the first one in that window whose title is exactly `title`,
 * else a new one made in that same window. Members the caller did not name
 * stay, ahead of the named ones. A new group forms where its first tab is; a
 * reused one stays where it is.
 *
 * @param {{tabIds:number[], title:string, color?:string, collapsed?:boolean}} args
 */
export async function groupTabs(args = {}) {
  const tabIds = checkTabIds(args)
  const title = checkTitle(args.title, { required: true })
  const color = checkColor(args.color)
  const collapsed = checkCollapsed(args.collapsed)
  const wait = retryDelay(args)

  const tabs = []
  for (const id of tabIds) tabs.push(await getTab(id))
  const windowIds = [...new Set(tabs.map((t) => t.windowId))]
  if (windowIds.length > 1) {
    throw bad(
      `These tabs are in ${windowIds.length} windows. A group lives in one window, and this never moves a tab to another window: group each window's tabs in its own call.`
    )
  }
  const pinned = tabs.filter((t) => t.pinned).map((t) => t.id)
  if (pinned.length > 0) {
    throw bad(`${pinned.length} of these tabs ${pinned.length === 1 ? 'is' : 'are'} pinned, and grouping a pinned tab unpins it. Leave pinned tabs out.`)
  }
  const windowId = windowIds[0]
  const win = await chrome.windows.get(windowId)
  if (!win || win.type !== 'normal') throw bad('Only tabs in a normal window can be grouped.')

  // chrome.tabGroups.query matches `title` as a pattern, so the exact match is
  // checked here, and the first such group in the strip wins.
  const sameName = (await chrome.tabGroups.query({ windowId })).filter((g) => g.title === title && g.windowId === windowId)
  let existing = null
  if (sameName.length > 0) {
    const tabsNow = await chrome.tabs.query({ windowId })
    const firstIndex = (g) => Math.min(...tabsNow.filter((t) => t.groupId === g.id).map((t) => t.index), Infinity)
    existing = sameName.sort((a, b) => firstIndex(a) - firstIndex(b))[0]
  }

  const groupId = existing
    ? await edit(() => chrome.tabs.group({ groupId: existing.id, tabIds }), wait)
    : await edit(() => chrome.tabs.group({ tabIds, createProperties: { windowId } }), wait)

  // Order the group: every move stays inside the group's own span.
  const members = await membersOf(groupId, windowId)
  const plan = planGroupOrder({ current: members.map((t) => t.id), wanted: tabIds })
  if (plan.moves.length > 0) {
    const lastIndex = members[members.length - 1].index
    for (const id of plan.moves) await edit(() => chrome.tabs.move(id, { index: lastIndex }), wait)
  }

  // A browser that let a tab slip out while ordering gets it put back once.
  const after = await membersOf(groupId, windowId)
  const slipped = tabIds.filter((id) => !after.some((t) => t.id === id))
  if (slipped.length > 0) await edit(() => chrome.tabs.group({ groupId, tabIds: slipped }), wait)

  const props = { title }
  if (color !== undefined) props.color = color
  if (collapsed === false) props.collapsed = false
  const updated = await edit(() => chrome.tabGroups.update(groupId, props), wait)
  const note = collapsed === true ? await collapseSafely(updated, true, wait) : null

  const group = await describe(await chrome.tabGroups.get(groupId))
  const result = {
    created: !existing,
    added: tabIds.length,
    reordered: plan.moves.length,
    group,
    message:
      `${existing ? 'Added' : 'Grouped'} ${tabIds.length} tab${tabIds.length === 1 ? '' : 's'} ${existing ? 'to' : 'as'} ` +
      `"${group.title}" (${group.color}${group.collapsed ? ', collapsed' : ''}), ${group.count} in the group, window ${windowId}.`,
  }
  if (note) result.note = note
  return result
}

/**
 * Rename, recolor, collapse or expand one group.
 *
 * @param {{group:number, title?:string, color?:string, collapsed?:boolean}} args
 */
export async function updateGroup(args = {}) {
  const groupId = checkGroupId(args.group)
  const title = checkTitle(args.title, { required: false })
  const color = checkColor(args.color)
  const collapsed = checkCollapsed(args.collapsed)
  if (title === undefined && color === undefined && collapsed === undefined) {
    throw bad('Say what to change: "title", "color" or "collapsed".')
  }
  const wait = retryDelay(args)
  const group = await getGroup(groupId)
  const props = {}
  if (title !== undefined) props.title = title
  if (color !== undefined) props.color = color
  if (collapsed === false) props.collapsed = false
  const updated = Object.keys(props).length > 0 ? await edit(() => chrome.tabGroups.update(groupId, props), wait) : group
  const note = collapsed === true ? await collapseSafely(updated, true, wait) : null
  const described = await describe(await chrome.tabGroups.get(groupId))
  const result = {
    group: described,
    message: `"${described.title}" is ${described.color}${described.collapsed ? ', collapsed' : ', open'}, ${described.count} tabs, window ${described.windowId}.`,
  }
  if (note) result.note = note
  return result
}

/**
 * Move one group, with all its tabs, to a position in its own window.
 *
 * @param {{group:number, index:number}} args  -1 puts the group at the end of the window
 */
export async function moveGroup(args = {}) {
  const groupId = checkGroupId(args.group)
  const index = Number(args.index)
  if (args.index === undefined || args.index === null || args.index === '' || !Number.isInteger(index) || index < -1) {
    throw bad('"index" is where the group\'s first tab goes: a tab index, or -1 for the end of the window.')
  }
  const wait = retryDelay(args)
  await getGroup(groupId)
  // No windowId, ever: with one, chrome.tabGroups.move takes the group to that window.
  await edit(() => chrome.tabGroups.move(groupId, { index }), wait)
  const group = await describe(await chrome.tabGroups.get(groupId))
  return { group, message: `Moved "${group.title}" to index ${group.index} of window ${group.windowId}.` }
}

/**
 * Take tabs out of their groups, where they stand. A group left empty is
 * deleted by the browser.
 *
 * @param {{tabIds?:number[], group?:number}} args  the tabs, or every tab of one group
 */
export async function ungroupTabs(args = {}) {
  const hasTabs = Array.isArray(args.tabIds) && args.tabIds.length > 0
  const hasGroup = args.group !== undefined && args.group !== null
  if (hasTabs === hasGroup) throw bad('Name the tabs ("tabs") or one group ("group"), not both and not neither.')
  const wait = retryDelay(args)
  let tabIds
  if (hasGroup) {
    const group = await getGroup(checkGroupId(args.group))
    tabIds = (await membersOf(group.id, group.windowId)).map((t) => t.id)
  } else {
    tabIds = checkTabIds(args)
    for (const id of tabIds) await getTab(id)
  }
  if (tabIds.length > 0) await edit(() => chrome.tabs.ungroup(tabIds), wait)
  return { ungrouped: tabIds.length, message: `Took ${tabIds.length} tab${tabIds.length === 1 ? '' : 's'} out of ${hasGroup ? 'the group' : 'their groups'}.` }
}
