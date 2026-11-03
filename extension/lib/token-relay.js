/**
 * The token relay, the extension's half.
 *
 * Some web apps sign their own API calls with a short-lived bearer token that
 * the page mints from the signed-in session, and a tool on the operator's
 * machine needs that same token. This watches the app's OWN requests for the
 * header and hands each newer token to the broker, which writes it to the one
 * file the operator named (bridged/token-relay.mjs). It also keeps one pinned
 * background tab of the app alive and reloads it before the freshest token runs
 * out, because a page that is closed or discarded sends no requests to watch.
 *
 * Off by default, and off in every profile the operator did not name: the
 * broker sends a profile its relays in REGISTER_ACK, and a profile with none
 * registers no listener at all, so it never sees a request header.
 *
 * What this never does:
 *
 *   - Store, log or print the token. It travels once, to the broker, inside the
 *     request that hands it over. What is stored is its expiry, so the next
 *     request carrying the same token is not sent again.
 *   - Read a request from any page but the app's own: the request's initiator
 *     must be one the relay names, exactly.
 *   - Open a window. The keep-alive tab goes into a window that is already
 *     open, in the background, and with no window open it waits.
 *   - Reload any tab but its own. It reloads the tab it opened, or after a
 *     browser restart the pinned tab still showing its address.
 */

import { TOKEN_RELAY, tokenVerdict } from './protocol.js'

/** storage.local key: the relays the broker sent in REGISTER_ACK. link.js writes it. */
export const RELAY_SPECS_KEY = 'tokenRelay.specs'

/**
 * storage.local key: per relay, numbers only - the expiry of the token last
 * handed over, when, and the keep-alive tab and its last reload. Never a token.
 */
export const RELAY_STATE_KEY = 'tokenRelay.state'

/** How long a token the broker refused waits before it is offered again. */
const REFUSAL_PAUSE_MS = 60 * 1000

/**
 * The token in a request's headers, or null.
 *
 * @param {Array<{name: string, value?: string}>} requestHeaders
 * @param {{header?: string, scheme?: string}} spec
 */
export function headerToken(requestHeaders, { header = 'authorization', scheme = 'Bearer' } = {}) {
  if (!Array.isArray(requestHeaders)) return null
  const want = String(header).toLowerCase()
  const found = requestHeaders.find((h) => h && typeof h.name === 'string' && h.name.toLowerCase() === want)
  if (!found || typeof found.value !== 'string') return null
  const value = found.value.trim()
  if (!scheme) return value || null
  const prefix = `${String(scheme).toLowerCase()} `
  if (value.slice(0, prefix.length).toLowerCase() !== prefix) return null
  return value.slice(prefix.length).trim() || null
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Does `url` fall under a match pattern of the shape the broker accepts
 * (https://host/path or https://*.host/path, "*" a wildcard in the path)?
 * Checked here as well as in Chrome's own filter, because one listener serves
 * every relay and each request has to be tied to the relay it belongs to.
 */
export function urlMatches(url, pattern) {
  const m = /^(https?):\/\/([^/]+)(\/.*)$/.exec(String(pattern))
  if (!m) return false
  let u
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== `${m[1]}:`) return false
  const host = u.hostname.toLowerCase()
  const want = m[2].toLowerCase()
  if (want.startsWith('*.')) {
    const base = want.slice(2)
    if (host !== base && !host.endsWith(`.${base}`)) return false
  } else if (host !== want) {
    return false
  }
  const path = new RegExp(`^${m[3].split('*').map(escapeRegExp).join('.*')}$`)
  return path.test(u.pathname + u.search)
}

function cleanSpecs(value) {
  if (!Array.isArray(value)) return []
  const strings = (list) => Array.isArray(list) && list.length > 0 && list.every((s) => typeof s === 'string')
  return value
    .filter((s) => s && typeof s.name === 'string' && strings(s.urls) && strings(s.initiators))
    .map((s) => ({
      name: s.name,
      urls: [...s.urls],
      initiators: [...s.initiators],
      header: typeof s.header === 'string' ? s.header : 'authorization',
      scheme: typeof s.scheme === 'string' ? s.scheme : 'Bearer',
      keepAlive:
        s.keepAlive && typeof s.keepAlive.url === 'string' && Number(s.keepAlive.renewBeforeHours) >= 1
          ? { url: s.keepAlive.url, renewBeforeHours: Number(s.keepAlive.renewBeforeHours) }
          : null,
    }))
}

/** The fixed word for a broker refusal, never its whole message. */
function codeOf(err) {
  const m = /^(E_[A-Z_]+):/.exec(err && err.message ? err.message : '')
  return m ? m[1] : 'an error'
}

/**
 * @param {object} deps
 * @param {object} [deps.chrome] the extension API (the real one in the worker)
 * @param {(args: {name: string, token: string}) => Promise<{written?: boolean, exp?: number}>} deps.send
 *        hands one token to the broker (OPS.RELAY_TOKEN)
 * @param {() => number} [deps.now]
 */
export function createTokenRelay({ chrome: api = globalThis.chrome, send, now = () => Date.now() } = {}) {
  let specs = []
  let listener = null
  const inflight = new Map()
  const startedAt = now()
  let lastCheck = -Infinity

  async function readState() {
    try {
      const bag = await api.storage.local.get(RELAY_STATE_KEY)
      const value = bag ? bag[RELAY_STATE_KEY] : null
      return value && typeof value === 'object' ? value : {}
    } catch {
      return {}
    }
  }

  async function patchState(name, patch) {
    const all = await readState()
    all[name] = { ...(all[name] || {}), ...patch }
    try {
      await api.storage.local.set({ [RELAY_STATE_KEY]: all })
    } catch {
      // The record only saves a repeat send or a repeat reload; losing it costs one of each.
    }
  }

  /** Watch exactly the relays this profile was given, and nothing when it was given none. */
  function apply(next) {
    const events = api && api.webRequest ? api.webRequest.onSendHeaders : null
    if (listener && events) events.removeListener(listener)
    listener = null
    specs = cleanSpecs(next)
    if (!events || specs.length === 0) return { watching: 0 }
    listener = (details) => {
      void consider(details)
    }
    // No 'extraHeaders': a header the page itself set is in requestHeaders
    // without it, and leaving it out keeps cookies out of what this sees.
    events.addListener(listener, { urls: [...new Set(specs.flatMap((s) => s.urls))], types: ['xmlhttprequest'] }, ['requestHeaders'])
    return { watching: specs.length }
  }

  /**
   * One request the app sent. Exported for tests through the returned object;
   * the answer is a fixed phrase saying what happened, never the token.
   */
  async function consider(details) {
    try {
      if (!details || typeof details.url !== 'string' || typeof details.initiator !== 'string') return 'not watched'
      const spec = specs.find((s) => s.initiators.includes(details.initiator) && s.urls.some((p) => urlMatches(details.url, p)))
      if (!spec) return 'not watched'
      const token = headerToken(details.requestHeaders, spec)
      if (!token) return 'no token'
      const verdict = tokenVerdict(token, { now: now() })
      if (!verdict.ok) return 'not a usable token'

      const held = (await readState())[spec.name] || {}
      if (Number.isFinite(held.exp) && held.exp >= verdict.exp) return 'already relayed'
      if ((inflight.get(spec.name) || 0) >= verdict.exp) return 'in flight'
      if (held.failExp === verdict.exp && Number.isFinite(held.failAt) && now() - held.failAt < REFUSAL_PAUSE_MS) {
        return 'recently refused'
      }

      inflight.set(spec.name, verdict.exp)
      try {
        const result = await send({ name: spec.name, token })
        // The broker answers with the expiry the file now holds, which is this
        // token's, or a longer-lived one it kept. Either way nothing up to that
        // expiry is worth sending again.
        const exp = result && Number.isFinite(result.exp) ? Math.max(result.exp, verdict.exp) : verdict.exp
        await patchState(spec.name, { exp, iat: verdict.iat, at: now(), failAt: null, failExp: null })
        return result && result.written === false ? 'kept' : 'relayed'
      } catch (err) {
        await patchState(spec.name, { failAt: now(), failExp: verdict.exp })
        console.warn(`[bridge] token relay "${spec.name}" was refused: ${codeOf(err)}`)
        return 'refused'
      } finally {
        if (inflight.get(spec.name) === verdict.exp) inflight.delete(spec.name)
      }
    } catch (_err) {
      return 'failed'
    }
  }

  /** The keep-alive check, called from the worker's alarm; it paces itself. */
  async function tick() {
    const t = now()
    if (t - startedAt < TOKEN_RELAY.SETTLE_MS) return 'settling'
    if (t - lastCheck < TOKEN_RELAY.CHECK_EVERY_MS) return 'not due'
    lastCheck = t
    const out = []
    for (const spec of specs) {
      if (!spec.keepAlive) continue
      try {
        out.push(await keepAlive(spec, t))
      } catch (_err) {
        out.push('failed')
      }
    }
    return out
  }

  async function keepAlive(spec, t) {
    const held = (await readState())[spec.name] || {}
    const left = Number.isFinite(held.exp) ? held.exp * 1000 - t : -Infinity
    if (left > spec.keepAlive.renewBeforeHours * 3_600_000) return 'fresh'
    if (Number.isFinite(held.reloadAt) && t - held.reloadAt < TOKEN_RELAY.RELOAD_GAP_MS) return 'waiting'

    let tab = await ownTab(spec, held)
    let outcome = 'reloaded'
    if (tab) {
      await api.tabs.reload(tab.id)
    } else {
      const windowId = await normalWindow()
      if (windowId === null) return 'no window'
      tab = await api.tabs.create({ url: spec.keepAlive.url, active: false, pinned: true, windowId })
      outcome = 'opened'
    }
    try {
      // A discarded tab sends nothing, which is the failure this tab exists to prevent.
      await api.tabs.update(tab.id, { autoDiscardable: false })
    } catch {
      // Older browsers lack the flag; the reload before each renewal still wakes it.
    }
    await patchState(spec.name, { reloadAt: t, tabId: tab.id })
    return outcome
  }

  /** The keep-alive tab: the one it opened, else a pinned tab still showing its address. */
  async function ownTab(spec, held) {
    if (Number.isInteger(held.tabId)) {
      try {
        const tab = await api.tabs.get(held.tabId)
        const at = tab ? tab.url || tab.pendingUrl || '' : ''
        if (tab && spec.initiators.some((o) => at.startsWith(`${o}/`))) return tab
      } catch {
        // Closed, or a tab id from an earlier browser session: look for it by address.
      }
    }
    const pinned = await api.tabs.query({ pinned: true })
    return pinned.find((tab) => (tab.url || tab.pendingUrl || '').startsWith(spec.keepAlive.url)) || null
  }

  async function normalWindow() {
    try {
      const win = await api.windows.getLastFocused({ populate: false })
      if (win && win.type === 'normal' && Number.isInteger(win.id)) return win.id
    } catch {
      // Fall through to the list.
    }
    try {
      const all = (await api.windows.getAll({ populate: false })).filter((w) => w && w.type === 'normal' && Number.isInteger(w.id))
      const shown = all.filter((w) => w.state !== 'minimized')
      const pool = shown.length > 0 ? shown : all
      return pool.length > 0 ? pool[0].id : null
    } catch {
      return null
    }
  }

  return { apply, consider, tick, specs: () => specs.map((s) => s.name) }
}
