/**
 * The token relay, the extension's half.
 *
 * Some web apps sign their own API calls with a short-lived bearer token that
 * the page mints from the signed-in session, and a tool on the operator's
 * machine needs that same token. This watches the app's OWN requests for the
 * header and hands each newer token to the broker, which writes it to the one
 * file the operator named (bridged/token-relay.mjs). It also keeps one pinned
 * background tab of the app alive and reloads it before the newest token runs
 * out, because a page that is closed or discarded sends no requests to watch.
 *
 * Off by default, and off in every profile the operator did not name: the
 * broker sends a profile its relays in REGISTER_ACK, and a profile with none
 * registers no listener at all, so it never sees a request header. Panic
 * clears the list (link.js), which stops the watching and the keep-alive.
 *
 * What this never does:
 *
 *   - Store, log or print the token. It travels once, to the broker, inside the
 *     request that hands it over. What is stored is when it was issued and when
 *     it expires, so the same token is not sent twice.
 *   - Read a request from any page but the app's own: the request's initiator
 *     must be one the relay names, exactly.
 *   - Open a window, or more than one tab a day per relay. The keep-alive tab
 *     goes into a window that is already open, in the background; with no
 *     window open it waits, and when its tab is closed it waits a day.
 *   - Reload any tab but its own, or any page it did not choose. Its tab is
 *     the one it opened in this browser session (tab ids start again with each
 *     session, so the id is kept in session storage), or after a restart the
 *     pinned tab still showing its address. A tab of its own that drifted to
 *     another page of the app is sent back to the keep-alive address instead of
 *     reloaded; one that left the app (a sign-in page, say) is left alone; one
 *     a person is looking at is left alone until the next check.
 *
 * What it cannot do: wake a stopped worker. The listener's filter comes from
 * storage, so it is added after the worker starts rather than in its first
 * turn, and requests made while the worker is stopped are not seen. The native
 * port and the keep-alive alarm keep the worker running, and the next request
 * after a restart is seen.
 */

import { TOKEN_RELAY, tokenVerdict } from './protocol.js'

/** storage.local key: the relays the broker sent in REGISTER_ACK. link.js writes it. */
export const RELAY_SPECS_KEY = 'tokenRelay.specs'

/**
 * storage.local key: per relay, when the token last handed over was issued and
 * when it expires, when the broker last refused one, the keep-alive's last
 * reload and last new tab, and the address its tab landed on. Never a token.
 */
export const RELAY_STATE_KEY = 'tokenRelay.state'

/** storage.session key: per relay, the keep-alive tab's id in this browser session. */
export const RELAY_TABS_KEY = 'tokenRelay.tabs'

const HOUR_MS = 3_600_000

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
  const ceiling = TOKEN_RELAY.MAX_LIFETIME_MS / HOUR_MS
  return value
    .filter((s) => s && typeof s.name === 'string' && strings(s.urls) && strings(s.initiators))
    .map((s) => {
      const hours = Number(s.maxLifetimeHours)
      return {
        name: s.name,
        urls: [...s.urls],
        initiators: [...s.initiators],
        header: typeof s.header === 'string' ? s.header : 'authorization',
        scheme: typeof s.scheme === 'string' ? s.scheme : 'Bearer',
        maxLifetimeMs: (Number.isFinite(hours) && hours >= 1 && hours <= ceiling ? hours : ceiling) * HOUR_MS,
        keepAlive:
          s.keepAlive && typeof s.keepAlive.url === 'string' && Number(s.keepAlive.renewBeforeHours) >= 1
            ? { url: s.keepAlive.url, renewBeforeHours: Number(s.keepAlive.renewBeforeHours) }
            : null,
      }
    })
}

/** The fixed word for a broker refusal, never its whole message. */
function codeOf(err) {
  const m = /^(E_[A-Z_]+):/.exec(err && err.message ? err.message : '')
  return m ? m[1] : 'an error'
}

/**
 * @param {object} deps
 * @param {object} [deps.chrome] the extension API (the real one in the worker)
 * @param {(args: {name: string, token: string}) => Promise<{written?: boolean, exp?: number, iat?: number}>} deps.send
 *        hands one token to the broker (OPS.RELAY_TOKEN)
 * @param {() => number} [deps.now]
 */
export function createTokenRelay({ chrome: api = globalThis.chrome, send, now = () => Date.now() } = {}) {
  let specs = []
  let listener = null
  let appliedByBroker = false
  const inflight = new Map()
  const startedAt = now()
  let lastCheck = -Infinity
  const memoryTabs = {}

  async function readBag(area, key) {
    try {
      const bag = await area.get(key)
      const value = bag ? bag[key] : null
      return value && typeof value === 'object' ? value : {}
    } catch {
      return {}
    }
  }

  const readState = () => readBag(api.storage.local, RELAY_STATE_KEY)

  async function patchState(name, patch) {
    const all = await readState()
    all[name] = { ...(all[name] || {}), ...patch }
    try {
      await api.storage.local.set({ [RELAY_STATE_KEY]: all })
    } catch {
      // The record only saves a repeat send or a repeat reload; losing it costs one of each.
    }
  }

  async function readTabs() {
    if (!api.storage.session) return { ...memoryTabs }
    return readBag(api.storage.session, RELAY_TABS_KEY)
  }

  async function setTab(name, tabId) {
    if (!api.storage.session) {
      memoryTabs[name] = tabId
      return
    }
    const all = await readTabs()
    all[name] = tabId
    try {
      await api.storage.session.set({ [RELAY_TABS_KEY]: all })
    } catch {
      // Without it the tab is found again by its address.
    }
  }

  /**
   * Watch exactly the relays this profile was given, and nothing when it was
   * given none. `initial` is the worker's own start reading the last list it
   * was told: ignored once the broker's answer has applied one.
   */
  function apply(next, { initial = false } = {}) {
    if (initial && appliedByBroker) return { watching: specs.length, skipped: true }
    if (!initial) appliedByBroker = true
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
   * One request the app sent. The answer is a fixed phrase saying what
   * happened, never the token.
   */
  async function consider(details) {
    try {
      if (!details || typeof details.url !== 'string' || typeof details.initiator !== 'string') return 'not watched'
      const spec = specs.find((s) => s.initiators.includes(details.initiator) && s.urls.some((p) => urlMatches(details.url, p)))
      if (!spec) return 'not watched'
      const token = headerToken(details.requestHeaders, spec)
      if (!token) return 'no token'
      const verdict = tokenVerdict(token, { now: now(), maxLifetimeMs: spec.maxLifetimeMs })
      if (!verdict.ok) return 'not a usable token'

      // Ordered by issue time, as the broker orders them: only a token issued
      // later than the last one handed over is worth sending.
      const held = (await readState())[spec.name] || {}
      if (Number.isFinite(held.iat) && held.iat >= verdict.iat) return 'already relayed'
      if ((inflight.has(spec.name) ? inflight.get(spec.name) : -Infinity) >= verdict.iat) return 'in flight'
      // After a refusal the whole relay pauses, whichever token comes next, so
      // two tokens taking turns cannot turn every request into a refusal.
      if (Number.isFinite(held.failAt) && now() - held.failAt < TOKEN_RELAY.REFUSAL_PAUSE_MS) return 'recently refused'

      inflight.set(spec.name, verdict.iat)
      try {
        const result = await send({ name: spec.name, token })
        // The broker answers with the token the file now holds: this one, or a
        // newer one it kept. Nothing issued up to then is worth sending again.
        const iat = result && Number.isFinite(result.iat) ? Math.max(result.iat, verdict.iat) : verdict.iat
        const exp = result && Number.isFinite(result.exp) && iat !== verdict.iat ? result.exp : verdict.exp
        await patchState(spec.name, { exp, iat, at: now(), failAt: null })
        return result && result.written === false ? 'kept' : 'relayed'
      } catch (err) {
        await patchState(spec.name, { failAt: now() })
        console.warn(`[bridge] token relay "${spec.name}" was refused: ${codeOf(err)}`)
        return 'refused'
      } finally {
        if (inflight.get(spec.name) === verdict.iat) inflight.delete(spec.name)
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

  const onApp = (spec, url) => spec.initiators.some((o) => url.startsWith(`${o}/`))
  const addressOf = (tab) => (tab && (tab.url || tab.pendingUrl)) || ''

  async function keepAlive(spec, t) {
    const held = (await readState())[spec.name] || {}
    const left = Number.isFinite(held.exp) ? held.exp * 1000 - t : -Infinity
    // Renew inside the configured margin, but never earlier than halfway
    // through the token's own life, so a short-lived token does not have its
    // page reloaded every time the reload gap allows.
    const life = Number.isFinite(held.exp) && Number.isFinite(held.iat) ? (held.exp - held.iat) * 1000 : 0
    const margin = Math.min(spec.keepAlive.renewBeforeHours * HOUR_MS, life > 0 ? life / 2 : Infinity)
    if (left > margin) {
      await noteLanding(spec, held)
      return 'fresh'
    }
    if (Number.isFinite(held.reloadAt) && t - held.reloadAt < TOKEN_RELAY.RELOAD_GAP_MS) return 'waiting'

    let tab = await ownTab(spec, held)
    let outcome
    if (tab) {
      const at = addressOf(tab)
      // Off the app (signed out to a sign-in page, or taken somewhere else):
      // still its one tab, so no second one opens, and nothing is reloaded.
      if (!onApp(spec, at)) return 'away'
      // Someone is looking at it: never pull a page out from under them.
      if (tab.active) return 'in use'
      if (at.startsWith(spec.keepAlive.url) || (held.tabUrl && at === held.tabUrl)) {
        await api.tabs.reload(tab.id)
        outcome = 'reloaded'
      } else {
        // It drifted to another page of the app; reloading that page could act
        // on it (an inbox marks things read), so it goes back to the chosen one.
        await api.tabs.update(tab.id, { url: spec.keepAlive.url })
        outcome = 'returned'
      }
    } else {
      // Its tab was closed: a person did that, so wait a day before another.
      if (Number.isFinite(held.openedAt) && t - held.openedAt < TOKEN_RELAY.OPEN_GAP_MS) return 'closed'
      const windowId = await normalWindow()
      if (windowId === null) return 'no window'
      tab = await api.tabs.create({ url: spec.keepAlive.url, active: false, pinned: true, windowId })
      await setTab(spec.name, tab.id)
      await patchState(spec.name, { openedAt: t, tabUrl: null })
      outcome = 'opened'
    }
    try {
      // A discarded tab sends nothing, which is the failure this tab exists to prevent.
      await api.tabs.update(tab.id, { autoDiscardable: false })
    } catch {
      // Older browsers lack the flag; the reload before each renewal still wakes it.
    }
    await patchState(spec.name, { reloadAt: t })
    return outcome
  }

  /**
   * Its tab: the one it opened in this browser session, else (after a
   * restart) a pinned tab at the keep-alive address or where it last landed.
   */
  async function ownTab(spec, held) {
    const id = (await readTabs())[spec.name]
    if (Number.isInteger(id)) {
      try {
        const tab = await api.tabs.get(id)
        if (tab) return tab
      } catch {
        // Closed: forgotten below, and looked for by address.
      }
      await setTab(spec.name, null)
    }
    const pinned = await api.tabs.query({ pinned: true })
    const tab =
      pinned.find((p) => addressOf(p).startsWith(spec.keepAlive.url)) ||
      (held.tabUrl ? pinned.find((p) => addressOf(p) === held.tabUrl) : null) ||
      null
    if (tab) await setTab(spec.name, tab.id)
    return tab
  }

  /**
   * Remember where its tab landed (the app may redirect the keep-alive
   * address), so a browser restart can find it again by that address. Only the
   * first landing after it opens, or the keep-alive address itself, is
   * recorded: a page a person later browsed to is not.
   */
  async function noteLanding(spec, held) {
    const id = (await readTabs())[spec.name]
    if (!Number.isInteger(id)) return
    try {
      const tab = await api.tabs.get(id)
      const at = tab && tab.pinned ? tab.url || '' : ''
      if (!at || at === held.tabUrl || !onApp(spec, at)) return
      if (held.tabUrl && !at.startsWith(spec.keepAlive.url)) return
      await patchState(spec.name, { tabUrl: at })
    } catch {
      // Closed: nothing to remember.
    }
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
