/**
 * How old is each tab: the open-time ledger, and the sort that reads it.
 *
 * Chrome does not say when a tab was opened. It says when a tab was last SHOWN
 * (`lastAccessed`, Chrome 121 and later), which equals the open time for a tab
 * opened and never revisited and is later than it for any other. So this
 * extension writes the open time down itself, in chrome.storage.local, the
 * moment a tab is created, and keeps it across browser restarts.
 *
 * A restart is the hard part. Every tab and every window comes back with a new
 * id, so a ledger keyed by tab id would forget everything at the first restart.
 * Each entry therefore also keeps where the tab was (window, index) and a short
 * form of its address, and the first time the worker runs in a new browser
 * session the ledger is re-keyed onto the tabs that came back: a window is
 * matched to the old window it agrees with most, and a tab carries its old open
 * time when it sits at the same index with the same address, or when its
 * address is unique in both windows. Anything ambiguous is dropped rather than
 * guessed at; a dropped tab falls back to `lastAccessed`, which the popup says.
 *
 * The top half of this file is pure and runs in Node (test/window-sort.test.mjs).
 * The bottom half touches chrome.* and only ever runs in the service worker.
 */

import { describeWindowSort, planWindowSort } from './protocol.js'

/** chrome.storage.local: tab id -> { at, w, i, u }. */
export const LEDGER_KEY = 'ages.opened'

/** chrome.storage.session: set once the ledger has been re-keyed in this browser session. */
export const SESSION_KEY = 'ages.sessionKeyed'

/** A ledger past this size drops entries for tabs that are not open. */
const LEDGER_SOFT_CAP = 5_000

const URL_MAX = 200
const NONE_ID = -1

/* -------------------------------------------------------------------------- */
/* Pure                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The address the ledger keeps: origin and path, nothing after them, cut short.
 * A query string or fragment can carry a token, and the ledger only needs
 * enough to tell one tab from its neighbor after a restart.
 */
export function shortUrl(url) {
  try {
    const u = new URL(String(url || ''))
    return `${u.origin}${u.pathname}`.slice(0, URL_MAX)
  } catch (_err) {
    return ''
  }
}

function tabUrl(tab) {
  return shortUrl(tab.url || tab.pendingUrl || '')
}

/** Record a tab's open time, once. A later call for the same id changes nothing. */
export function recordOpened(ledger, tab, now) {
  if (!tab || !Number.isInteger(tab.id)) return ledger
  const key = String(tab.id)
  if (ledger[key]) return ledger
  return { ...ledger, [key]: { at: now, w: tab.windowId, i: tab.index, u: tabUrl(tab) } }
}

/**
 * Forget a closed tab, unless its window was closing with it. A window closing
 * is also what a browser quitting looks like, and those are exactly the
 * entries the next session's re-key needs.
 */
export function forgetTab(ledger, tabId, { isWindowClosing = false } = {}) {
  const key = String(tabId)
  if (!ledger[key] || isWindowClosing) return ledger
  const next = { ...ledger }
  delete next[key]
  return next
}

/** Bring the window, index and address of every listed tab up to date. Drops nothing. */
export function refreshPositions(ledger, tabs) {
  let next = ledger
  for (const tab of tabs) {
    const key = String(tab.id)
    const entry = ledger[key]
    if (!entry) continue
    const u = tabUrl(tab)
    if (entry.w === tab.windowId && entry.i === tab.index && entry.u === u) continue
    if (next === ledger) next = { ...ledger }
    next[key] = { ...entry, w: tab.windowId, i: tab.index, u }
  }
  return next
}

/** Drop entries for tabs that are not open. Only used past LEDGER_SOFT_CAP. */
export function pruneClosed(ledger, tabs) {
  const open = new Set(tabs.map((t) => String(t.id)))
  const next = {}
  for (const [key, entry] of Object.entries(ledger)) if (open.has(key)) next[key] = entry
  return next
}

/** tab id -> open time, for planWindowSort's `opened`. */
export function openedTimes(ledger) {
  const out = {}
  for (const [key, entry] of Object.entries(ledger)) {
    if (entry && Number.isFinite(entry.at)) out[key] = entry.at
  }
  return out
}

function groupBy(items, keyOf) {
  const map = new Map()
  for (const item of items) {
    const key = keyOf(item)
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(item)
  }
  return map
}

function countBy(values) {
  const map = new Map()
  for (const v of values) map.set(v, (map.get(v) || 0) + 1)
  return map
}

/**
 * Carry the ledger onto the tabs that are open now.
 *
 * 1. Same id and same address: an extension reload or a worker restart, where
 *    the ids did not change. The entry is kept.
 * 2. Otherwise a browser restart. Old windows are paired with new ones by how
 *    many entries sit at the same index with the same address (then by how many
 *    addresses they share at all), best pair first, each window once, and only
 *    when they share something. Inside a pair a tab takes an old entry at its
 *    own index with its own address, or the one entry whose address is unique
 *    in both windows.
 * 3. Every entry left over is dropped.
 *
 * @param {object} stored  the ledger as it was written
 * @param {Array<{id:number, windowId:number, index:number, url?:string, pendingUrl?:string}>} tabs
 * @returns {{ledger:object, carried:number, dropped:number}}
 */
export function rekeyLedger(stored, tabs) {
  const ledger = {}
  const usedOld = new Set()
  const matchedNew = new Set()
  const entries = Object.entries(stored || {}).filter(([, e]) => e && Number.isFinite(e.at))

  for (const tab of tabs) {
    const key = String(tab.id)
    const entry = stored[key]
    if (entry && Number.isFinite(entry.at) && entry.u === tabUrl(tab)) {
      ledger[key] = { at: entry.at, w: tab.windowId, i: tab.index, u: entry.u }
      usedOld.add(key)
      matchedNew.add(tab.id)
    }
  }

  const oldByWindow = groupBy(
    entries.filter(([key]) => !usedOld.has(key)).map(([key, e]) => ({ key, ...e })),
    (e) => e.w
  )
  const newByWindow = groupBy(
    tabs.filter((t) => !matchedNew.has(t.id)).map((t) => ({ id: t.id, w: t.windowId, i: t.index, u: tabUrl(t) })),
    (t) => t.w
  )

  const pairs = []
  for (const [ow, olds] of oldByWindow) {
    for (const [nw, news] of newByWindow) {
      const at = new Set(news.map((t) => `${t.i}\u0000${t.u}`))
      const addresses = new Set(news.map((t) => t.u))
      const exact = olds.filter((e) => at.has(`${e.i}\u0000${e.u}`)).length
      const shared = olds.filter((e) => e.u && addresses.has(e.u)).length
      if (exact + shared > 0) pairs.push({ ow, nw, exact, shared })
    }
  }
  pairs.sort((a, b) => b.exact - a.exact || b.shared - a.shared)

  const pairedOld = new Set()
  const pairedNew = new Set()
  for (const { ow, nw } of pairs) {
    if (pairedOld.has(ow) || pairedNew.has(nw)) continue
    pairedOld.add(ow)
    pairedNew.add(nw)
    const olds = oldByWindow.get(ow)
    const news = newByWindow.get(nw)
    const taken = new Set()
    const carry = (tab, entry) => {
      taken.add(entry.key)
      ledger[String(tab.id)] = { at: entry.at, w: tab.w, i: tab.i, u: tab.u }
    }
    const rest = []
    for (const tab of news) {
      const entry = olds.find((e) => !taken.has(e.key) && e.i === tab.i && e.u === tab.u && tab.u)
      if (entry) carry(tab, entry)
      else rest.push(tab)
    }
    const oldCounts = countBy(olds.filter((e) => !taken.has(e.key)).map((e) => e.u))
    const newCounts = countBy(rest.map((t) => t.u))
    for (const tab of rest) {
      if (!tab.u || oldCounts.get(tab.u) !== 1 || newCounts.get(tab.u) !== 1) continue
      const entry = olds.find((e) => !taken.has(e.key) && e.u === tab.u)
      if (entry) carry(tab, entry)
    }
  }

  const carried = Object.keys(ledger).length
  return { ledger, carried, dropped: entries.length - carried }
}

/* -------------------------------------------------------------------------- */
/* chrome.* : the ledger's storage and events                                  */
/* -------------------------------------------------------------------------- */

let chain = Promise.resolve()
let refreshTimer = null

async function readLedger() {
  try {
    const bag = await chrome.storage.local.get(LEDGER_KEY)
    return bag && bag[LEDGER_KEY] && typeof bag[LEDGER_KEY] === 'object' ? bag[LEDGER_KEY] : {}
  } catch (_err) {
    return {}
  }
}

async function writeLedger(ledger) {
  try {
    await chrome.storage.local.set({ [LEDGER_KEY]: ledger })
  } catch (err) {
    // A ledger that cannot be written costs ages, never a tab: the sort falls
    // back to lastAccessed for whatever is missing.
    console.warn('[bridge] the tab age ledger could not be written:', err)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait, briefly, for a starting browser to finish restoring its tabs, so the
 * re-key sees all of them instead of the first window that came back. At most
 * about three seconds, and only once per browser session.
 */
async function settledTabs() {
  let tabs = await chrome.tabs.query({})
  for (let i = 0; i < 10; i++) {
    await sleep(300)
    const again = await chrome.tabs.query({})
    if (again.length === tabs.length) return again
    tabs = again
  }
  return tabs
}

/**
 * Every read-modify-write of the ledger goes through here, one at a time, and
 * the first one in a browser session re-keys the ledger before anything else
 * touches it. That order is what keeps a restored tab's onCreated from stamping
 * it with a fresh time before its old one has been carried over.
 */
function withLedger(update) {
  const run = chain.then(async () => {
    let ledger = await readLedger()
    let dirty = false
    let keyed = false
    try {
      const bag = await chrome.storage.session.get(SESSION_KEY)
      keyed = Boolean(bag && bag[SESSION_KEY])
    } catch (_err) {
      keyed = true // no session storage: never re-key on every event
    }
    if (!keyed) {
      const { ledger: next, carried, dropped } = rekeyLedger(ledger, await settledTabs())
      ledger = next
      dirty = true
      try {
        await chrome.storage.session.set({ [SESSION_KEY]: true })
      } catch (_err) {
        /* see above */
      }
      console.info(`[bridge] tab ages re-keyed for this browser session: ${carried} carried, ${dropped} dropped`)
    }
    const next = update ? await update(ledger) : ledger
    if (next !== ledger) {
      ledger = next
      dirty = true
    }
    if (dirty) await writeLedger(ledger)
    return ledger
  })
  chain = run.catch(() => {})
  return run
}

/** Called at worker start: re-key now if this is a new browser session. */
export function ensureAgesSession() {
  return withLedger(null)
}

export function onTabCreated(tab) {
  return withLedger((ledger) => recordOpened(ledger, tab, Date.now()))
}

export function onTabRemoved(tabId, removeInfo) {
  return withLedger((ledger) => forgetTab(ledger, tabId, { isWindowClosing: Boolean(removeInfo && removeInfo.isWindowClosing) }))
}

/**
 * A tab moved, changed window or changed address: refresh every position in
 * one pass a moment later, so a burst of events (a whole window dragged, a
 * sort) is one read of the tab list rather than one per event.
 */
export function schedulePositionRefresh(delayMs = 1_500) {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void withLedger(async (ledger) => {
      const tabs = await chrome.tabs.query({})
      const next = refreshPositions(ledger, tabs)
      return Object.keys(next).length > LEDGER_SOFT_CAP ? pruneClosed(next, tabs) : next
    })
  }, delayMs)
}

/* -------------------------------------------------------------------------- */
/* chrome.* : the sort                                                         */
/* -------------------------------------------------------------------------- */

async function moveUnitToEnd(unit, windowId) {
  if (unit.kind === 'group' && chrome.tabGroups && typeof chrome.tabGroups.move === 'function') {
    await chrome.tabGroups.move(unit.groupId, { index: -1 })
    return
  }
  await chrome.tabs.move(unit.tabIds, { windowId, index: -1 })
  if (unit.kind === 'group') {
    // Without the tabGroups API the tabs moved one by one; put them back in
    // their group so the move cannot have split it.
    await chrome.tabs.group({ groupId: unit.groupId, tabIds: unit.tabIds })
    return
  }
  // A loose tab moved to the end of a strip that ends in a group can be pulled
  // into that group. It was loose before the sort and it stays loose.
  const moved = await Promise.all(unit.tabIds.map((id) => chrome.tabs.get(id)))
  const grouped = moved.filter((t) => Number.isInteger(t.groupId) && t.groupId !== NONE_ID).map((t) => t.id)
  if (grouped.length > 0) await chrome.tabs.ungroup(grouped)
}

async function sortOneWindow(windowId, ages, opened) {
  const tabs = await chrome.tabs.query({ windowId })
  const plan = planWindowSort({
    tabs: tabs.map((t) => ({
      tabId: t.id,
      index: t.index,
      pinned: Boolean(t.pinned),
      groupId: Number.isInteger(t.groupId) ? t.groupId : NONE_ID,
      splitViewId: Number.isInteger(t.splitViewId) ? t.splitViewId : NONE_ID,
      lastAccessed: t.lastAccessed,
    })),
    ages,
    opened,
  })
  let moved = 0
  let failed = 0
  for (const unit of plan.moves) {
    try {
      await moveUnitToEnd(unit, windowId)
      moved += 1
    } catch (err) {
      // A tab closed or dragged mid-sort. The rest of the window still sorts.
      failed += 1
      console.warn('[bridge] a sort move failed:', err && err.message ? err.message : err)
    }
  }
  return { windowId, tabs: tabs.length, moved, pinned: plan.pinned, failed, sources: plan.sources }
}

/**
 * Sort one window, or every normal window, oldest on the left.
 *
 * @param {object} spec
 * @param {number|null} [spec.windowId]  one window, by id
 * @param {boolean} [spec.all]           every normal window, each on its own
 * @param {Object<string,number>} [spec.ages]  tab id -> epoch ms, from the caller
 */
export async function sortWindowsByAge({ windowId = null, all = false, ages = {} } = {}) {
  const ledger = await withLedger(null)
  const opened = openedTimes(ledger)
  const windowIds = all
    ? (await chrome.windows.getAll({ windowTypes: ['normal'] })).map((w) => w.id)
    : [windowId]
  const windows = []
  for (const id of windowIds) windows.push(await sortOneWindow(id, ages, opened))
  schedulePositionRefresh(500)
  const result = { windows }
  return { ...result, message: describeWindowSort(result) }
}
