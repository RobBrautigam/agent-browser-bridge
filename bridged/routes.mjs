/**
 * The route table: one line per connected browser profile.
 *
 * A route is the join of a live host socket, a resolved identity and a label
 * the model can address. Three properties matter more than anything else here:
 *
 *   1. ADDRESSING IS EXACT. Label, then installId, then `vendor:profileDir`,
 *      with no fuzzy or prefix matching anywhere. A near-miss that resolves is
 *      how an operation lands in the wrong browser.
 *   2. TWO ROUTES ARE NEVER MERGED. A label collision renames the second
 *      claimant and warns on both lines; it never folds them together, because
 *      a merged route means one of the operator's identities is silently driving as
 *      another.
 *   3. A RESTART REPLACES, IT DOES NOT DUPLICATE. A register carrying a known
 *      installId atomically takes over the route, carries the label and the
 *      profile join forward, and increments the generation - which invalidates
 *      every outstanding tab handle by construction rather than by a sweep.
 */

import crypto from 'node:crypto'

import { ERR, LINK, mintTabHandle, parseTabHandle } from '../shared/protocol.mjs'
import { slugify } from '../shared/paths.mjs'

/**
 * A short, stable tiebreaker.
 *
 * Deliberately NOT a counter. A counter resolves a collision by ARRIVAL ORDER,
 * which means the same label addresses a different person depending on which
 * browser the operator happened to open first that morning - the exact wrong-identity
 * outcome the whole file exists to prevent. A hash of a stable input gives the
 * same profile the same suffix on every broker restart, forever.
 *
 * WHICH input matters, and the LAST-RESORT one must be the installId rather
 * than the route key. Every other tiebreaker in this file derives from the
 * route key or the profile directory, and two live routes CAN share both: one
 * browser profile carrying two extension instances (an unpacked copy beside a
 * store copy) resolves to one key from two installIds. Every derivation then
 * produced the same string and the final safety net had nothing left to
 * separate them, so the uniqueness rule failed silently in the one place it
 * exists to hold. The installId is unique per route by construction - the route
 * table is keyed by it - and it is minted once per profile and persisted, so it
 * is just as stable as the key it replaces.
 */
function shortHash(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 6)
}

/**
 * The route key.
 *
 * Deliberately NOT the profile name: Chromium's own guidance is that profile
 * names are not unique, and on the reference machine Edge's `Default` directory carries
 * `info_cache.name = "Profile 1"`. The user-data-dir is lowercased because
 * Windows paths are case-insensitive and two spellings of one directory must
 * not produce two routes.
 */
export function routeKey(vendor, userDataDir, profileDir) {
  return `${vendor}|${String(userDataDir || '').toLowerCase()}|${profileDir}`
}

/** Key for a route whose profile directory is not known yet. */
export function unclaimedKey(installId) {
  return `install|${installId}`
}

export class RouteTable {
  #byInstall = new Map()
  #onLabelChanged

  /**
   * @param {object} [options]
   * @param {(route:object, previousLabel:string)=>void} [options.onLabelChanged]
   *   Called when a collision moves an ALREADY-ATTACHED route off the label it
   *   was holding. A label change invalidates every outstanding tab handle for
   *   that route (the label is baked into the handle), so the broker uses this
   *   to bump the generation and tell the extension its new name.
   */
  constructor({ onLabelChanged = null } = {}) {
    this.#onLabelChanged = onLabelChanged
  }

  /** @returns {object[]} every live route */
  all() {
    return [...this.#byInstall.values()]
  }

  get size() {
    return this.#byInstall.size
  }

  byInstallId(installId) {
    return this.#byInstall.get(installId) || null
  }

  byConnection(conn) {
    for (const route of this.#byInstall.values()) if (route.conn === conn) return route
    return null
  }

  labels() {
    return this.all().map((r) => r.label)
  }

  /**
   * Exact-match address resolution, in strict precedence.
   *
   * Returns a verdict rather than a route because `vendor:profileDir` is not
   * guaranteed unique: that form ignores the user-data-dir, and two browsers of
   * the same vendor started against different user-data-dirs both call a
   * profile directory "Default". The previous build returned whichever of them
   * happened to be first in the map, silently. An ambiguous address now refuses
   * and names the labels it could have meant.
   *
   * @param {string} address label, installId, or `vendor:profileDir`
   * @returns {{route:object|null, ambiguous:object[]|null}}
   */
  resolveAddress(address) {
    if (typeof address !== 'string' || address === '') return { route: null, ambiguous: null }

    for (const route of this.#byInstall.values()) {
      if (route.label === address) return { route, ambiguous: null }
    }

    const direct = this.#byInstall.get(address)
    if (direct) return { route: direct, ambiguous: null }

    const sep = address.indexOf(':')
    if (sep > 0) {
      const vendor = address.slice(0, sep)
      const dir = address.slice(sep + 1)
      const matches = this.all().filter((r) => r.vendor === vendor && r.profileDir === dir)
      if (matches.length === 1) return { route: matches[0], ambiguous: null }
      if (matches.length > 1) return { route: null, ambiguous: matches }
    }
    return { route: null, ambiguous: null }
  }

  /** The unambiguous route for an address, or null. Ambiguity reads as no match. */
  resolve(address) {
    return this.resolveAddress(address).route
  }

  /**
   * The live labels whose pre-collision name is exactly `base`.
   *
   * When a collision splits a name, NOBODY holds the bare one - so an address
   * naming it resolves to nothing, which is the point. This is what lets the
   * refusal say "you meant one of these two" instead of listing the whole board.
   */
  labelsForBase(base) {
    return this.all()
      .filter((r) => r.desiredLabel === base)
      .map((r) => r.label)
      .sort()
  }

  /**
   * Register or re-register a profile.
   *
   * @returns {{route:object, replaced:object|null}} `replaced` is the previous
   *   route for this installId, whose socket the caller must close.
   */
  attach({ installId, conn, identity, generation, desiredLabel, labelIsCustom, extVersion, tabCount }) {
    const replaced = this.#byInstall.get(installId) || null
    if (replaced) this.#byInstall.delete(installId)

    const route = {
      installId,
      conn,
      key: identity.profileDir
        ? routeKey(identity.vendor, identity.userDataDir, identity.profileDir)
        : unclaimedKey(installId),

      vendor: identity.vendor,
      vendorLabel: identity.vendorLabel,
      vendorVerified: identity.vendorVerified,
      userDataDir: identity.userDataDir,
      profileDir: identity.profileDir,
      profileName: identity.profileName,
      email: identity.email,
      reportedEmail: identity.reportedEmail ?? null,
      hostedDomain: identity.hostedDomain ?? null,
      claimed: identity.claimed,
      identityChanged: Boolean(identity.identityChanged),
      candidates: identity.candidates || [],
      source: identity.source,

      // The name this route WANTS. `label` is what it actually answers to after
      // collisions are resolved across the whole table, and it is assigned by
      // #applyLabels below rather than passed in.
      desiredLabel,
      label: null,
      labelIsCustom: Boolean(labelIsCustom),
      generation,
      extVersion: extVersion || null,

      link: LINK.READY,
      tabCount: Number.isFinite(tabCount) ? tabCount : 0,
      lastSeenAt: Date.now(),
      latencyMs: null,
      pingSeq: 0,
      pingSentAt: null,
      missed: 0,

      // Carried across a restart so the board does not reset its counters every
      // time a browser is relaunched.
      opCount: replaced?.opCount || 0,
      lastOp: replaced?.lastOp || null,
      connectedAt: Date.now(),

      warnings: [...(identity.warnings || [])],
    }

    this.#byInstall.set(installId, route)
    this.#resolveTable()
    return { route, replaced }
  }

  detach(route) {
    if (!route) return false
    const current = this.#byInstall.get(route.installId)
    if (current !== route) return false
    this.#byInstall.delete(route.installId)
    this.#resolveTable()
    return true
  }

  /**
   * Change what a route WANTS to be called, then re-resolve the whole table.
   *
   * Used after a claim (the identity changed, so the derived name did too) and
   * after a rename. Going through the table rather than assigning `label`
   * directly is what keeps the collision rules total: a name freed by a rename
   * can let two suffixed lines collapse back to their bare names in the same
   * pass that assigns the new one.
   */
  setDesiredLabel(route, desiredLabel, { custom = null } = {}) {
    if (!route) return
    route.desiredLabel = desiredLabel
    if (custom !== null) route.labelIsCustom = Boolean(custom)
    this.#resolveTable()
  }

  /** True when another live route already holds this exact label, or wants it. */
  labelHolder(label, exceptInstallId = null) {
    for (const route of this.#byInstall.values()) {
      if (route.installId === exceptInstallId) continue
      if (route.label === label || route.desiredLabel === label) return route
    }
    return null
  }

  /**
   * Resolve every route's addressable label from every route's desired label.
   *
   * The rule that changed, and why. The previous build handed the bare name to
   * whoever registered FIRST and gave the runner-up `label#2`. That is an
   * arrival-order coin flip: open Chrome before Brave and "chrome-acme-corp"
   * means one profile; open them the other way round and it means the other.
   * With two of the operator's profiles signed into one address that is a live
   * wrong-identity hazard, not a cosmetic one.
   *
   * So on a collision NOBODY keeps the bare name, and the suffix is derived
   * from the profile DIRECTORY, which is the identity half of the route key:
   *
   *     chrome-acme-corp-default
   *     chrome-acme-corp-profile-1
   *
   * Both properties follow. The assignment is a pure function of the set of
   * routes, so registration order cannot change it; and the bare name resolves
   * to NOTHING, so a tool call that names it fails loudly with both real labels
   * instead of landing on one of them.
   *
   * When there is no collision the label is exactly the desired one, byte for
   * byte, which is what keeps the two live labels unchanged.
   */
  #applyLabels() {
    /** @type {Map<string, object[]>} */
    const groups = new Map()
    for (const route of this.#byInstall.values()) {
      const base = route.desiredLabel || route.installId
      if (!groups.has(base)) groups.set(base, [])
      groups.get(base).push(route)
    }

    /** @type {Array<[object, string]>} */
    const proposals = []
    for (const [base, group] of groups) {
      if (group.length === 1) {
        proposals.push([group[0], base])
        continue
      }

      // Two profiles can still share a directory name across different
      // user-data-dirs, so count the proposals and demote the duplicates to a
      // key hash. Counting is order-independent; "whoever got here first keeps
      // it" would not be.
      const suffixed = group.map((route) => [route, `${base}-${slugify(route.profileDir) || shortHash(route.key)}`])
      const counts = new Map()
      for (const [, label] of suffixed) counts.set(label, (counts.get(label) || 0) + 1)
      for (const [route, label] of suffixed) {
        proposals.push([route, counts.get(label) > 1 ? `${base}-${shortHash(route.installId)}` : label])
      }
    }

    // Final safety net, across groups: a suffixed name could in principle equal
    // some other profile's derived name. Uniqueness is the one property that
    // cannot bend, so any survivor duplicate falls back to the installId hash -
    // the only input in this file that two live routes can never share.
    const finalCounts = new Map()
    for (const [, label] of proposals) finalCounts.set(label, (finalCounts.get(label) || 0) + 1)

    // Assign every label BEFORE announcing any of them. The listener rebuilds
    // the board, and a board built halfway through this loop would show two
    // lines holding one name - a transient that looks exactly like the bug this
    // whole mechanism exists to prevent.
    const announce = []
    for (const [route, label] of proposals) {
      const resolved = finalCounts.get(label) > 1 ? `${label}-${shortHash(route.installId)}` : label
      const previous = route.label
      if (previous === resolved) continue
      route.label = resolved
      // A first assignment is not a change: there are no handles to invalidate
      // and nobody to tell.
      if (previous) announce.push([route, previous])
    }
    return announce
  }

  /**
   * Re-resolve labels and collision warnings, then announce what moved.
   *
   * The order is the contract: nothing is announced until the table is fully
   * consistent, because the listener rebuilds and pushes the board.
   */
  #resolveTable() {
    const announce = this.#applyLabels()
    this.#applyCollisionWarnings()
    for (const [route, previous] of announce) this.#onLabelChanged?.(route, previous)
  }

  /* ------------------------------------------------------------------------ */
  /* Tab handles                                                               */
  /* ------------------------------------------------------------------------ */

  /** The extension speaks raw numeric tab ids; only the broker mints handles. */
  mint(route, tabId) {
    return mintTabHandle(route.label, route.generation, tabId)
  }

  /**
   * Translate a handle back to a raw tab id, refusing anything that does not
   * belong to THIS route in THIS browser session.
   *
   * Chrome tab ids are per-profile integers that collide freely across
   * profiles, so a raw id from one profile would find a real, valid, completely
   * wrong tab in another. This check is the structural guard against that, and
   * it is the single most important function in the file.
   *
   * @returns {{ok:true,tabId:number}|{ok:false,code:string,message:string}}
   */
  validateHandle(route, handle) {
    const parsed = parseTabHandle(handle)
    if (!parsed) {
      return {
        ok: false,
        code: ERR.BAD_TAB_HANDLE,
        message:
          `"${String(handle)}" is not a tab handle. Handles look like ` +
          `"tab_${route.label}_${route.generation}_<n>" and come from browser_list_tabs.`,
      }
    }
    if (parsed.profileLabel !== route.label) {
      return {
        ok: false,
        code: ERR.BAD_TAB_HANDLE,
        message:
          `Tab handle "${handle}" belongs to profile "${parsed.profileLabel}", but this request ` +
          `named profile "${route.label}". Refusing to act on one browser with another browser's ` +
          'tab. Call browser_list_tabs for the profile you meant.',
      }
    }
    if (parsed.generation !== route.generation) {
      return {
        ok: false,
        code: ERR.BAD_TAB_HANDLE,
        message:
          `Tab handle "${handle}" is from an earlier session of "${route.label}" (generation ` +
          `${parsed.generation}, now ${route.generation}). That tab number may now belong to a ` +
          'different page. Call browser_list_tabs again.',
      }
    }
    return { ok: true, tabId: parsed.tabId }
  }

  /* ------------------------------------------------------------------------ */
  /* Heartbeat bookkeeping                                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * Record a pong. Link state is computed from this clock and never from
   * socket existence, which is the precise fix for the incumbent reporting
   * `{status:"ok"}` while its extension was long gone.
   */
  notePong(route, seq, extra = {}) {
    const now = Date.now()
    if (Number.isFinite(seq) && seq !== route.pingSeq) return false // a late reply to an older ping
    if (route.pingSentAt != null) route.latencyMs = now - route.pingSentAt
    route.pingSentAt = null
    route.missed = 0
    route.lastSeenAt = now
    route.link = LINK.READY
    if (Number.isFinite(extra?.tabCount)) route.tabCount = extra.tabCount
    return true
  }

  noteOp(route, op) {
    route.opCount += 1
    route.lastOp = op
  }

  addWarning(route, text) {
    if (!route.warnings.includes(text)) route.warnings.push(text)
  }

  /**
   * Recompute collision warnings across the whole table.
   *
   * Run after every attach and detach so a warning disappears when the browser
   * causing it goes away, rather than sticking to a line forever.
   */
  #applyCollisionWarnings() {
    const notes = collisionNotes(this.all())
    for (const route of this.#byInstall.values()) {
      route.warnings = route.warnings.filter((w) => !w.startsWith(COLLISION_PREFIX))
      const note = notes.get(route.installId)
      if (note) route.warnings.push(note)
    }
  }
}

export const COLLISION_PREFIX = 'Label collision: '

/**
 * The KNOWN BUT NOT CONNECTED profile holding a label, if any.
 *
 * A name belonging to a browser that merely happens to be closed right now is
 * still taken. Checking only the live table let a closed profile's name be
 * handed to a different identity and then handed back the moment that browser
 * reopened: two lines, one name, and no warning at the moment of the rename -
 * which is the moment the operator could still have chosen differently.
 *
 * Takes plain store entries rather than reading anything, so the rule is
 * testable without a broker.
 *
 * @param {string} label
 * @param {Array<{installId:string,label?:string,desiredLabel?:string}>} entries
 * @param {{exceptInstallId?:string|null, isLive?:(installId:string)=>boolean}} [options]
 */
export function absentLabelHolder(label, entries, { exceptInstallId = null, isLive = () => false } = {}) {
  for (const entry of entries || []) {
    if (!entry || entry.installId === exceptInstallId) continue
    if (isLive(entry.installId)) continue // the live table already answered for this one
    if (entry.label === label || entry.desiredLabel === label) return entry
  }
  return null
}

/**
 * Which of these lines share a name, and what to say about it.
 *
 * Exported and taking plain descriptors rather than routes because the board
 * has to run it over LIVE and ABSENT lines together. The previous build scanned
 * only live routes, so a configured-but-not-connected profile holding the same
 * label as a connected one rendered twice on the board with no warning at all -
 * and "which of these two identical names is the one I am addressing" is
 * precisely the question the board exists to answer.
 *
 * Two different collisions, and they need different sentences:
 *
 *   same LABEL      two lines answer to one name. Only a live one is
 *                   addressable, so this is a reading hazard rather than a
 *                   routing one, but it looks identical to the operator.
 *   same BASE       the collision was already resolved by suffixing, so the
 *                   bare name deliberately addresses nothing. The line has to
 *                   say that, or the bare name looks like a broker bug.
 *
 * @param {Array<{installId:string,label:string,desiredLabel?:string,vendorLabel?:string,vendor?:string,profileDir?:string|null,present?:boolean}>} lines
 * @returns {Map<string,string>} installId -> warning text
 */
export function collisionNotes(lines) {
  const out = new Map()
  const byLabel = new Map()
  const byBase = new Map()

  for (const line of lines) {
    if (!line || typeof line.label !== 'string') continue
    if (!byLabel.has(line.label)) byLabel.set(line.label, [])
    byLabel.get(line.label).push(line)

    const base = line.desiredLabel || line.label
    if (!byBase.has(base)) byBase.set(base, [])
    byBase.get(base).push(line)
  }

  const where = (group) =>
    group
      .map((l) => {
        const vendor = l.vendorLabel || l.vendor || 'browser'
        const dir = l.profileDir || '(unclaimed)'
        return l.present === false ? `${vendor} ${dir}, not connected` : `${vendor} ${dir}`
      })
      .join(' and ')

  for (const [label, group] of byLabel) {
    if (group.length < 2) continue
    for (const line of group) {
      out.set(
        line.installId,
        `${COLLISION_PREFIX}${group.length} lines are named "${label}" (${where(group)}). Only a ` +
          'connected one can be addressed, and which one that is depends on which browser is open. ' +
          'Rename one in the options page.'
      )
    }
  }

  for (const [base, group] of byBase) {
    if (group.length < 2) continue
    for (const line of group) {
      if (out.has(line.installId)) continue // the exact-label note is the sharper one
      out.set(
        line.installId,
        `${COLLISION_PREFIX}${group.length} profiles want the name "${base}" (${where(group)}), so ` +
          `nothing answers to it any more. This one is addressed as "${line.label}". Rename one in ` +
          'the options page to take the plain name back.'
      )
    }
  }

  return out
}

/**
 * The route's warnings as the single string every surface renders.
 *
 * Exported because REGISTER_ACK carries the same value the board line does. A
 * label collision that shows on the board but not in the acknowledgement means
 * the one surface that can fix it - the options page of the profile that just
 * registered - never hears about it.
 *
 * `collisionNote` exists because there are two views of a collision and the
 * board's is the wider one. The route table can only see LIVE routes, which is
 * the right answer for an acknowledgement sent to one browser; the board also
 * knows about profiles that are configured but not connected. Passing a note -
 * including a null one, meaning "the board looked and there is no collision" -
 * REPLACES the table's version rather than stacking a second sentence on top of
 * it. Omitting the argument entirely keeps the table's own view.
 */
export function warningFor(route, { collisionNote = undefined } = {}) {
  const own =
    collisionNote === undefined
      ? route.warnings
      : route.warnings.filter((w) => !w.startsWith(COLLISION_PREFIX))
  const all = collisionNote ? [...own, collisionNote] : own
  return all.length ? all.join(' ') : null
}

/**
 * Project a live route onto the board Line shape declared in
 * shared/protocol.mjs. The board is the contract between the broker and every
 * UI that renders it, so the projection lives next to the route rather than in
 * whichever caller needed it first.
 */
export function lineFor(route, { armedUntil = null, collisionNote = undefined, installedVersion = null } = {}) {
  return {
    installId: route.installId,
    label: route.label,
    desiredLabel: route.desiredLabel,
    labelIsCustom: route.labelIsCustom,
    identityChanged: Boolean(route.identityChanged),
    vendor: route.vendor,
    vendorLabel: route.vendorLabel,
    profileDir: route.profileDir,
    profileName: route.profileName,
    email: route.email,
    link: route.link,
    present: true,
    claimed: route.claimed,
    candidates: route.candidates,
    generation: route.generation,
    tabCount: route.tabCount,
    // What this profile is RUNNING, and whether that is behind the folder.
    // `needsReload` is computed rather than stored because the folder changes
    // under a running broker: the answer has to be as fresh as the manifest.
    // With no installed version to compare against (an unreadable manifest) the
    // honest answer is false, because "reload it" would be advice with no
    // evidence behind it.
    extVersion: route.extVersion || null,
    needsReload: Boolean(installedVersion && route.extVersion && route.extVersion !== installedVersion),
    latencyMs: route.latencyMs,
    lastSeenAt: route.lastSeenAt,
    armedUntil,
    opCount: route.opCount,
    lastOp: route.lastOp,
    warning: warningFor(route, { collisionNote }),
  }
}
