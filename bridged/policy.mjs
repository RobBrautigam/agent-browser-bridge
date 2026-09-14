/**
 * Bridge policy: who may say what, which operations need an arm, and the
 * panic switch.
 *
 * Everything here is deliberately small and mostly pure, because policy is the
 * part of this system that has to be provable rather than merely tested by
 * driving a browser. `canSend` in particular is exported as a plain function
 * so test/capabilities.test.mjs can exercise the capability partition without
 * a socket anywhere near it.
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  MSG,
  ROLE,
  OPS,
  OP_TIER,
  TIER,
  ERR,
  TIMING,
  BROWSER_OPS,
  BROKER_OPS,
  HOST_REQ_ALLOWED_OPS,
  MAX_ARM_MINUTES,
} from '../shared/protocol.mjs'
import { PANIC_FILE } from '../shared/paths.mjs'

/* -------------------------------------------------------------------------- */
/* The capability partition                                                    */
/* -------------------------------------------------------------------------- */

/**
 * An `mcp` connection issues operations and reads results. It can never
 * impersonate a browser: a RES, a REGISTER or a PONG from an mcp connection
 * would let a client mint a route or answer someone else's request.
 *
 * PONG is deliberately absent even though mcp-server/client.mjs knows how to
 * answer a PING with one. The broker only ever pings HOST routes - heartbeat()
 * in bridged/index.mjs iterates the route table, and an mcp connection is not
 * in it - so that answer has no reachable caller. Do NOT "fix" this by adding
 * MSG.PONG here: an mcp client that can send a PONG is an mcp client that can
 * fake liveness for a route, which is the exact thing this set exists to stop.
 * If mcp connections ever need a keepalive, give them their own message type.
 */
const MCP_MAY_SEND = new Set([MSG.HELLO, MSG.REQ])

/**
 * A `host` connection answers, registers and heartbeats.
 *
 * REQ is allowed, but ONLY as a carrier: the operation inside it still has to
 * pass canOriginate() below, which admits nothing that touches a page. The
 * extension's options page and popup are the UI for claiming, renaming, arming
 * and panic, they live inside the extension, and their messages therefore
 * arrive on a host connection. The first build tried to route them as EVENTs
 * instead, which meant every UI action arrived as a message the partition
 * refused: the broker logged a capability violation and destroyed the route,
 * every two seconds, for as long as the board was open. A typed REQ with a
 * narrow allowlist is the sanctioned channel.
 */
const HOST_MAY_SEND = new Set([MSG.HELLO, MSG.RES, MSG.REGISTER, MSG.PONG, MSG.REQ, MSG.EVENT])

/**
 * The structural gate on the WIRE TYPE. HELLO_ACK, REGISTER_ACK and PING are
 * broker-produced and appear in neither set, so a client cannot forge an
 * acknowledgement either.
 *
 * This answers "may this role send this kind of message". It deliberately does
 * NOT answer "may this role ask for this operation" - that is canOriginate.
 *
 * @param {string} role     one of ROLE
 * @param {string} msgType  one of MSG
 * @returns {boolean}
 */
export function canSend(role, msgType) {
  if (role === ROLE.MCP) return MCP_MAY_SEND.has(msgType)
  if (role === ROLE.HOST) return HOST_MAY_SEND.has(msgType)
  return false
}

/**
 * The structural gate on the OPERATION inside a REQ.
 *
 * An mcp connection may ask for anything the protocol defines. A host may ask
 * only for the broker-local operations in HOST_REQ_ALLOWED_OPS, and never for
 * anything in BROWSER_OPS - that is what keeps a compromised extension in one
 * profile from driving a DIFFERENT profile through the broker, which is the
 * property canSend used to provide on its own before the UI needed a channel.
 *
 * @param {string} role one of ROLE
 * @param {string} op   one of OPS
 * @returns {boolean}
 */
export function canOriginate(role, op) {
  if (role === ROLE.MCP) return BROWSER_OPS.includes(op) || BROKER_OPS.includes(op)
  // The `!BROWSER_OPS.includes(op)` half is deliberately redundant TODAY, and
  // deliberately kept. Without it this boundary would enforce nothing itself -
  // it would merely trust that a list in another module stays disjoint from
  // BROWSER_OPS forever. A future edit that added a page-touching op to
  // HOST_REQ_ALLOWED_OPS, or any version skew between the two arrays, would
  // silently hand a compromised extension the ability to drive other profiles.
  // A security boundary should fail closed on its own terms rather than on a
  // distant invariant, so the invariant is restated here where it is enforced.
  // The disjointness itself is asserted at module load below and in
  // test/capabilities.test.mjs.
  if (role === ROLE.HOST) return HOST_REQ_ALLOWED_OPS.includes(op) && !BROWSER_OPS.includes(op)
  return false
}

// Fail loudly at startup rather than quietly at request time. If these two
// lists ever overlap, the broker must not run: every host connection would be
// one policy bug away from driving a browser it does not own.
{
  const overlap = HOST_REQ_ALLOWED_OPS.filter((op) => BROWSER_OPS.includes(op))
  if (overlap.length > 0) {
    throw new Error(
      `Capability partition is broken: HOST_REQ_ALLOWED_OPS and BROWSER_OPS both contain ${overlap.join(', ')}. ` +
        'A host connection must never be able to originate a page-touching operation.'
    )
  }
}

/**
 * Operations a host may only ever aim at ITSELF.
 *
 * Claiming and renaming decide what a profile IS and how the model addresses
 * it, so an extension gets to answer those questions for its own line and no
 * other. The broker resolves the route from the CONNECTION for these, which is
 * why the UI contract sends them with a null profile. Arming is deliberately
 * not on this list: the board is the operator's own UI and arming another line from it
 * is the point (see HOST_REQ_ALLOWED_OPS in shared/protocol.mjs).
 */
const HOST_SELF_ONLY_OPS = new Set([OPS.CLAIM_PROFILE, OPS.SET_LABEL])

export function isHostSelfOnlyOp(op) {
  return HOST_SELF_ONLY_OPS.has(op)
}

/** Valid connection roles. An unknown role never gets past HELLO. */
export function isRole(role) {
  return role === ROLE.MCP || role === ROLE.HOST
}

/* -------------------------------------------------------------------------- */
/* Tiering                                                                     */
/* -------------------------------------------------------------------------- */

/** @returns {string|null} one of TIER, or null when the operation does not exist. */
export function tierFor(op) {
  return Object.prototype.hasOwnProperty.call(OP_TIER, op) ? OP_TIER[op] : null
}

/**
 * Operations that do not address a single profile. Everything else must name
 * one, with no default ever - acting on the wrong browser is the worst failure
 * this system can produce, and a default is precisely how that happens.
 */
const NO_PROFILE_OPS = new Set([OPS.GET_BOARD, OPS.STATUS, OPS.PANIC])

export function requiresProfile(op) {
  return !NO_PROFILE_OPS.has(op)
}

/**
 * The three operations that still answer while panic is active.
 *
 * Panic refuses everything that touches a browser or changes state. These three
 * are the exception on purpose: PANIC must stay idempotent, and GET_BOARD and
 * STATUS are how panic becomes VISIBLE. A panic mode that also blinds the
 * status panel would leave the model reporting "the bridge is broken" instead
 * of "the operator pulled the plug, here is the file to delete".
 */
const PANIC_EXEMPT = new Set([OPS.GET_BOARD, OPS.STATUS, OPS.PANIC])

export function isPanicExempt(op) {
  return PANIC_EXEMPT.has(op)
}

/** Meta operations worth a permanent record even though they never touch a page. */
const AUDITED_META = new Set([OPS.ARM, OPS.DISARM, OPS.PANIC, OPS.CLAIM_PROFILE])

/**
 * Every operation that crosses into a browser, plus the state changes that
 * decide what a later operation is allowed to do. Board polling is excluded:
 * it is noise, and noise in an audit log is how a real line gets missed.
 */
export function isAuditableOp(op) {
  return BROWSER_OPS.includes(op) || AUDITED_META.has(op)
}

/**
 * The armed-tier gate.
 *
 * Unclaimed profiles are refused arbitrary JS deliberately. An unclaimed route
 * is a real browser session whose IDENTITY the broker cannot name yet, and
 * `evalJs` in a session nobody can name is the one combination worth refusing
 * outright. Read and write operations stay available so the profile can be
 * inspected and claimed.
 *
 * @returns {{code:string,message:string}|null} null means allowed
 */
export function checkTierAccess({ tier, claimed, armed, label }) {
  if (tier !== TIER.ARMED) return null

  if (!claimed) {
    return {
      code: ERR.PROFILE_UNCLAIMED,
      message:
        `Profile "${label}" has not been claimed yet, so its identity is unknown and the armed ` +
        'tier is refused. Open the extension options page in that browser profile and pick ' +
        'which profile it is.',
    }
  }
  if (!armed) {
    return {
      code: ERR.NOT_ARMED,
      message:
        `Profile "${label}" is not armed. Arbitrary JavaScript runs inside a logged-in session, ` +
        `so it needs an explicit arm first: bridge_arm with profile "${label}".`,
    }
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* Arming                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Hard ceiling on an arm window, whatever the caller asks for. An arm that
 * outlives the sitting it was granted for is the same as no arm at all.
 *
 * The number itself lives in shared/protocol.mjs so the MCP tool schema and
 * this enforcement point cannot drift apart; it is re-exported here because
 * the broker and its tests have always read it from policy.
 */
export { MAX_ARM_MINUTES }

export function clampArmMinutes(minutes) {
  const n = Number(minutes)
  if (!Number.isFinite(n) || n <= 0) return TIMING.DEFAULT_ARM_MINUTES
  return Math.min(MAX_ARM_MINUTES, Math.max(1, Math.round(n)))
}

/**
 * Arming state, keyed by `installId` rather than by label.
 *
 * Labels are renamable and can collide; the installId is the one identifier
 * that is stable for the life of an extension instance. Keying on the label
 * would mean a rename silently transferred an arm to a different browser.
 */
export class ArmingState {
  #until = new Map()

  /** @returns {number} the epoch ms the arm expires at */
  arm(installId, minutes) {
    const until = Date.now() + clampArmMinutes(minutes) * 60_000
    this.#until.set(installId, until)
    return until
  }

  disarm(installId) {
    return this.#until.delete(installId)
  }

  disarmAll() {
    const n = this.#until.size
    this.#until.clear()
    return n
  }

  /** @returns {number|null} epoch ms, or null when not armed or expired */
  armedUntil(installId) {
    const until = this.#until.get(installId)
    if (until == null) return null
    if (until <= Date.now()) {
      this.#until.delete(installId)
      return null
    }
    return until
  }

  isArmed(installId) {
    return this.armedUntil(installId) != null
  }
}

/* -------------------------------------------------------------------------- */
/* Panic                                                                       */
/* -------------------------------------------------------------------------- */

const PANIC_NOTE =
  'Bridge panic file.\r\n' +
  'While this file exists the broker refuses every browser operation and drops every route.\r\n' +
  'Delete this file to resume.\r\n'

/**
 * The panic switch is a FILE, not a flag in memory, because it must work
 * without the model's cooperation and without the broker being reachable:
 * The operator creating this file in a file manager is a complete, sufficient kill.
 *
 * It is watched AND re-stat'ed on every request. fs.watch is not reliable on
 * every Windows filesystem (network shares and some virtualized volumes drop
 * events silently), and a safety control that depends on a best-effort
 * notification is not a safety control.
 */
export class PanicSwitch {
  #file
  #active = false
  #watcher = null
  #onChange

  constructor({ file = PANIC_FILE, onChange } = {}) {
    this.#file = file
    this.#onChange = onChange
    this.#active = exists(file)
  }

  get active() {
    return this.#active
  }

  get file() {
    return this.#file
  }

  /** Re-stat. Cheap, and called on every single request on purpose. */
  check() {
    const was = this.#active
    this.#active = exists(this.#file)
    if (was !== this.#active) this.#onChange?.(this.#active)
    return this.#active
  }

  /**
   * Watch the containing directory rather than the file: the file usually does
   * not exist yet, and fs.watch on a missing path throws.
   */
  start() {
    if (this.#watcher) return
    const dir = path.dirname(this.#file)
    const base = path.basename(this.#file).toLowerCase()
    try {
      this.#watcher = fs.watch(dir, (_event, name) => {
        if (!name || path.basename(String(name)).toLowerCase() === base) this.check()
      })
      // A watcher error must never take the broker down; the per-request
      // re-stat above is the real control.
      this.#watcher.on('error', () => {})
    } catch {
      this.#watcher = null
    }
  }

  stop() {
    try {
      this.#watcher?.close()
    } catch {
      /* closing a dead watcher is not an error worth surfacing */
    }
    this.#watcher = null
  }

  /** Create the file. Never removes it: clearing panic is a human action. */
  trip() {
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true })
      fs.writeFileSync(this.#file, `${PANIC_NOTE}Tripped at ${new Date().toISOString()}\r\n`, 'utf8')
    } catch {
      // Even if the file cannot be written, the in-memory flag below still
      // refuses everything for this broker lifetime.
    }
    this.#active = true
    return this.#active
  }
}

function exists(file) {
  try {
    fs.statSync(file)
    return true
  } catch {
    return false
  }
}
