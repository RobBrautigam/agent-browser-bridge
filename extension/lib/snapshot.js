/**
 * The interactable-element snapshot and its ref registry.
 *
 * A snapshot gives the model short, stable handles - `e1`, `e2` - instead of
 * asking it to invent CSS selectors from prose. The mapping from ref to
 * selector has to outlive the injection that produced it, so it lives in
 * chrome.storage.session rather than in a service-worker global: the worker can
 * be terminated between the read and the click that follows it, and a global
 * would take the registry with it.
 *
 * storage.session is the right store rather than storage.local because the
 * mapping is meaningless once the browser restarts (the page is gone, the tab
 * ids are recycled) and session storage is cleared exactly then.
 */

import { pageSnapshot } from './inject.js'

const KEY_PREFIX = 'snap:'

/** How many tabs keep a registry. Selectors are small; this is a leak guard, not a budget. */
const MAX_TABS = 24

const key = (tabId) => `${KEY_PREFIX}${tabId}`

/**
 * Run the snapshot in a tab, mint refs, and persist the ref-to-selector map.
 *
 * Refs are minted here rather than in the page because the page has no way to
 * know what the previous snapshot called anything, and a ref that silently
 * changes meaning between two snapshots is worse than one that fails loudly.
 *
 * @param {number} tabId
 * @param {{limit?: number}} [opts]
 */
export async function buildSnapshot(tabId, { limit = 300 } = {}) {
  const frames = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: pageSnapshot,
    args: [{ limit }],
  })

  const first = Array.isArray(frames) ? frames[0] : null
  const raw = first ? first.result : null
  if (!raw || !Array.isArray(raw.elements)) {
    return { ok: false, reason: 'no_result', elements: [], count: 0 }
  }

  const refs = {}
  const elements = raw.elements.map((el, i) => {
    const ref = `e${i + 1}`
    refs[ref] = el.selector
    // The selector is kept on the returned element as well: it is the escape
    // hatch when a later snapshot renumbers everything, and it costs little.
    return Object.assign({ ref }, el)
  })

  await writeRegistry(tabId, {
    at: Date.now(),
    url: raw.url,
    refs,
  })

  return {
    ok: true,
    format: 'snapshot',
    url: raw.url,
    title: raw.title,
    count: elements.length,
    skipped: raw.skipped,
    truncated: raw.truncated,
    scrollY: raw.scrollY,
    scrollHeight: raw.scrollHeight,
    elements,
  }
}

/**
 * Resolve a ref to the selector it was minted for.
 * Returns null when there is no registry for the tab or the ref is unknown, so
 * the caller can say "re-snapshot first" rather than clicking something random.
 */
export async function resolveRef(tabId, ref) {
  const entry = await readRegistry(tabId)
  if (!entry || !entry.refs) return null
  const selector = entry.refs[String(ref)]
  return typeof selector === 'string' ? selector : null
}

/** What the registry knows about a tab, for error messages that can be acted on. */
export async function snapshotMeta(tabId) {
  const entry = await readRegistry(tabId)
  if (!entry) return null
  return { at: entry.at, url: entry.url, count: Object.keys(entry.refs || {}).length }
}

/** Drop a tab's registry. Called when the tab closes and after a navigation. */
export async function clearSnapshot(tabId) {
  try {
    await chrome.storage.session.remove(key(tabId))
  } catch (_err) {
    /* a failed cleanup is not worth failing an operation over */
  }
}

/* -------------------------------------------------------------------------- */

async function readRegistry(tabId) {
  try {
    const k = key(tabId)
    const bag = await chrome.storage.session.get(k)
    return bag ? bag[k] || null : null
  } catch (_err) {
    return null
  }
}

async function writeRegistry(tabId, entry) {
  try {
    await chrome.storage.session.set({ [key(tabId)]: entry })
    await prune()
  } catch (_err) {
    /* the snapshot itself is still valid; only ref resolution is degraded */
  }
}

/** Keep the newest MAX_TABS registries and drop the rest. */
async function prune() {
  const all = await chrome.storage.session.get(null)
  const entries = Object.keys(all)
    .filter((k) => k.startsWith(KEY_PREFIX))
    .map((k) => ({ k, at: (all[k] && all[k].at) || 0 }))
  if (entries.length <= MAX_TABS) return
  entries.sort((a, b) => b.at - a.at)
  const stale = entries.slice(MAX_TABS).map((e) => e.k)
  if (stale.length) await chrome.storage.session.remove(stale)
}
