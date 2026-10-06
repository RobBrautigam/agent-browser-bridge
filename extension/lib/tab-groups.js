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
 *     window. Only gatherGroup passes one, and only the window it was named:
 *     moving a whole group is the one way anything here changes window.
 *   - A group moved to another window takes its active tab along and the
 *     browser shows it there; the window it left shows another tab (and a
 *     discarded tab shown that way reloads). So a group holding its window's
 *     active tab is never gathered, and no window is ever emptied.
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
 *
 * The check is made inside the edit, so it is made again on the retry: a person
 * who clicks into the group while a drag holds the strip is seen. What remains
 * is the gap between one read and one write in the same task, which no API
 * closes.
 */
async function collapseSafely(group, collapsed, retryDelayMs) {
  if (collapsed === undefined) return null
  let note = null
  await edit(async () => {
    note = null
    if (collapsed === true) {
      const now = await chrome.tabGroups.get(group.id)
      const [active] = await chrome.tabs.query({ windowId: now.windowId, active: true })
      if (active && active.groupId === group.id) {
        note = `Left "${now.title || group.id}" open: it holds the window's active tab, and collapsing it would switch the window to another tab.`
        return
      }
    }
    await chrome.tabGroups.update(group.id, { collapsed })
  }, retryDelayMs)
  return note
}

/**
 * Check, at the moment of an edit, that the tabs are still in `windowId` and
 * unpinned and, when a group is named, that it is still in that window. A tab
 * or a group dragged to another window since it was read would otherwise be
 * pulled back across windows by chrome.tabs.group.
 */
async function stillIn(windowId, tabIds, groupId) {
  if (groupId !== undefined) {
    const g = await getGroup(groupId)
    if (g.windowId !== windowId) {
      throw bad(`Group "${g.title || groupId}" moved to another window during the call. Nothing was added to it; this never moves a tab to another window.`)
    }
  }
  for (const id of tabIds) {
    const t = await getTab(id)
    if (t.windowId !== windowId) {
      throw bad(`Tab ${id} moved to another window during the call. It was left there; this never moves a tab to another window.`)
    }
    if (t.pinned) throw bad(`Tab ${id} was pinned during the call, and grouping it would unpin it.`)
  }
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

  // Every tab-strip edit below re-reads what it is about to touch, inside the
  // edit, so the drag-lock retry re-reads it too.
  const groupId = await edit(async () => {
    await stillIn(windowId, tabIds, existing ? existing.id : undefined)
    return existing ? chrome.tabs.group({ groupId: existing.id, tabIds }) : chrome.tabs.group({ tabIds, createProperties: { windowId } })
  }, wait)

  // Order the group: every move stays inside the group's own span, in its own
  // window. A tab a person dragged elsewhere meanwhile is left where it went.
  const notes = []
  const members = await membersOf(groupId, windowId)
  const plan = planGroupOrder({ current: members.map((t) => t.id), wanted: tabIds })
  for (const id of plan.moves) {
    await edit(async () => {
      const t = await chrome.tabs.get(id).catch(() => null)
      if (!t || t.windowId !== windowId || t.groupId !== groupId) return
      const span = await membersOf(groupId, windowId)
      await chrome.tabs.move(id, { index: span[span.length - 1].index })
    }, wait)
  }

  // A tab that slipped out of the group while it was ordered is put back once,
  // but only if it is still in this window: one dragged to another window, or
  // closed, is left alone and said so.
  const after = await membersOf(groupId, windowId)
  const back = []
  let away = 0
  for (const id of tabIds.filter((x) => !after.some((t) => t.id === x))) {
    const t = await chrome.tabs.get(id).catch(() => null)
    if (t && t.windowId === windowId && !t.pinned) back.push(id)
    else away += 1
  }
  if (back.length > 0) {
    await edit(async () => {
      await stillIn(windowId, back, groupId)
      return chrome.tabs.group({ groupId, tabIds: back })
    }, wait)
  }
  if (away > 0) {
    notes.push(`${away} of these tabs went to another window or closed during the call, and ${away === 1 ? 'was' : 'were'} left where ${away === 1 ? 'it is' : 'they are'}.`)
  }

  let still
  try {
    still = await chrome.tabGroups.get(groupId)
  } catch (_err) {
    throw bad('Every one of these tabs left this window or closed during the call, so the group is gone. Nothing was moved to another window.')
  }
  const props = { title }
  if (color !== undefined) props.color = color
  if (collapsed === false) props.collapsed = false
  const updated = await edit(() => chrome.tabGroups.update(still.id, props), wait)
  if (collapsed === true) {
    const skipped = await collapseSafely(updated, true, wait)
    if (skipped) notes.push(skipped)
  }
  const note = notes.join(' ')

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

async function checkHostWindow(value) {
  const id = Number(value)
  // A negative id is one of the browser's stand-ins (-2 is "the current
  // window"), not a window somebody named.
  if (value === undefined || value === null || value === '' || !Number.isInteger(id) || id < 0) {
    throw bad('Name the window to gather into: "window", a window id from browser_list_groups.')
  }
  let win = null
  try {
    win = await chrome.windows.get(id)
  } catch (_err) {
    win = null
  }
  if (!win) throw bad(`There is no window ${value} in this profile. browser_list_groups lists the windows.`)
  if (win.type !== 'normal') throw bad(`Window ${id} is a ${win.type} window; only normal windows hold tab groups.`)
  return win.id
}

/** Every group in the profile whose title is exactly `title`. */
async function titled(title) {
  // chrome.tabGroups.query matches `title` as a pattern, so match exactly here.
  return (await chrome.tabGroups.query({})).filter((g) => g.title === title)
}

/** The host's groups titled `title`, left to right. */
async function titledInHost(title, host) {
  const tabs = (await chrome.tabs.query({ windowId: host })).sort((a, b) => a.index - b.index)
  const order = []
  for (const t of tabs) {
    if (Number.isInteger(t.groupId) && t.groupId !== NONE_ID && !order.includes(t.groupId)) order.push(t.groupId)
  }
  const ids = new Set((await titled(title)).filter((x) => x.windowId === host).map((x) => x.id))
  return order.filter((id) => ids.has(id))
}

const errorText = (err) => String(err && err.message ? err.message : err)

/**
 * Bring every group titled `title` into one window and fold them into one.
 *
 * Each group of that title in another window moves, whole and in its order, to
 * the end of the host window (chrome.tabGroups.move with the host's windowId).
 * Then the host's groups of that title fold into its leftmost one
 * (chrome.tabs.group with that group's id); the browser deletes each group
 * left empty. The group kept is the host's own when it had one, so its color
 * and state stay.
 *
 * A group holding its window's active tab never moves, and is reported as
 * held: the browser carries the active tab with the group and shows it in the
 * host window, and the window it left shows another tab. So no window is
 * emptied by a gather either. A group that cannot move (another profile, say)
 * is reported as failed and the rest still move and fold. Nothing is closed,
 * reloaded, navigated, pinned or activated, and no single tab changes window.
 *
 * @param {{title:string, window:number}} args
 */
export async function gatherGroup(args = {}) {
  const title = checkTitle(args.title, { required: true })
  const host = await checkHostWindow(args.window)
  const wait = retryDelay(args)

  let moved = 0
  const held = []
  const failed = []
  for (const g of (await titled(title)).filter((x) => x.windowId !== host)) {
    try {
      await edit(async () => {
        let now
        try {
          now = await chrome.tabGroups.get(g.id)
        } catch (_err) {
          return
        }
        if (now.title !== title || now.windowId === host) return
        const members = await membersOf(now.id, now.windowId)
        if (members.some((t) => t.active)) {
          held.push({ groupId: now.id, windowId: now.windowId, count: members.length })
          return
        }
        await chrome.tabGroups.move(now.id, { windowId: host, index: -1 })
        moved += 1
      }, wait)
    } catch (err) {
      failed.push({ groupId: g.id, windowId: g.windowId, error: errorText(err) })
    }
  }

  // Fold the host's groups of this title into its leftmost one.
  let merged = 0
  const here = await titledInHost(title, host)
  const keep = here.length > 0 ? here[0] : null
  for (const other of here.slice(1)) {
    try {
      await edit(async () => {
        const now = await chrome.tabGroups.get(other).catch(() => null)
        if (!now || now.windowId !== host || now.title !== title) return
        const tabs = await membersOf(other, host)
        if (tabs.length === 0) return
        const tabIds = tabs.map((t) => t.id)
        await stillIn(host, tabIds, keep)
        // The host's active tab going into a collapsed group would be hidden
        // in it; the group is opened first, which shows no other tab.
        if (tabs.some((t) => t.active) && (await chrome.tabGroups.get(keep)).collapsed) {
          await chrome.tabGroups.update(keep, { collapsed: false })
        }
        await chrome.tabs.group({ groupId: keep, tabIds })
        merged += 1
      }, wait)
    } catch (err) {
      failed.push({ groupId: other, windowId: host, error: errorText(err) })
    }
  }

  const group = keep === null ? null : await describe(await chrome.tabGroups.get(keep))
  const parts = []
  if (moved > 0) parts.push(`moved ${moved} group${moved === 1 ? '' : 's'} in`)
  if (merged > 0) parts.push(`folded ${merged} into one`)
  const result = {
    group,
    moved,
    merged,
    held,
    failed,
    message: group
      ? `"${title}" in window ${host}: ${parts.join(', ') || 'already one group there'}; ${group.count} tabs.`
      : held.length + failed.length > 0
        ? `No "${title}" group is in window ${host} yet.`
        : `No group titled "${title}" in this profile.`,
  }
  const notes = []
  if (held.length > 0) {
    notes.push(
      `Left ${held.length} "${title}" group${held.length === 1 ? '' : 's'} where ${held.length === 1 ? 'it is' : 'they are'} ` +
        `(window ${held.map((h) => h.windowId).join(', ')}): ${held.length === 1 ? 'it holds' : 'each holds'} its window's active tab, ` +
        'which the browser would carry along and show in this window. Show another tab in that window, then gather again.'
    )
  }
  if (failed.length > 0) notes.push(`${failed.length} "${title}" group${failed.length === 1 ? '' : 's'} could not be moved or folded: ${failed.map((f) => f.error).join('; ')}`)
  if (notes.length > 0) result.note = notes.join(' ')
  return result
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
