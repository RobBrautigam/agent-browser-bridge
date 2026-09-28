/**
 * The HELLO handshake: both ends prove they hold this boot's token, and
 * neither end sends it.
 *
 * WHY THE BROKER HAS TO PROVE ITSELF. On Windows the broker's endpoint is a
 * named pipe, and pipe names live in one namespace shared by every account on
 * the machine. Whoever creates the name first owns it. If another account
 * creates it while the broker is down (after a crash, before the scheduled
 * task starts at logon), the real broker's listen fails with EADDRINUSE and it
 * exits believing a broker is already running. Until this module, every client
 * then dialed the impostor, handed it the token in HELLO, and trusted whatever
 * HELLO_ACK came back. The host in particular relays everything after an ok
 * ack straight to the extension, and the extension executes any REQ it is
 * given; the arm is enforced only in the real broker. So a name squatter was
 * the broker, with the browser behind it.
 *
 * THE SCHEME (hmac-sha256-v1). The client picks a fresh 32-byte nonce and sends
 *   proof = HMAC-SHA256(token, "hmac-sha256-v1|client|<role>|<nonce>")
 * instead of the token. The broker recomputes it, refuses a nonce it has
 * already accepted this boot, and answers with
 *   proof = HMAC-SHA256(token, "hmac-sha256-v1|broker|<role>|<nonce>")
 * which the client checks before it trusts a single frame. The two labels
 * differ, so a squatter cannot reflect the client's own proof back as the
 * broker's, and the token never crosses the pipe, so a squatter learns nothing
 * it can use later. The broker only answers with a proof after the client's
 * proof checked out, so it is never an oracle for anyone without the token.
 *
 * NO DOWNGRADE, ON THE PIPE OR IN THE FILE. A client speaks this scheme or
 * does not dial. It used to fall back to the token HELLO when runtime.json had
 * no `auth` field, the mark of a broker from before the scheme; but a broker
 * that loses the pipe name to a squatter exits without rewriting the file, so
 * a runtime.json left behind by an old broker, or restored from a backup, is
 * exactly what a squatter needs in order to be handed the token and trusted
 * without a proof. So a missing or unknown `auth` field now means "restart the
 * broker", never "send the token". The broker still ACCEPTS the token HELLO,
 * which costs nothing (whoever can send the token could compute a proof) and
 * lets a host or MCP server process started before an upgrade keep working
 * until it restarts.
 *
 * A REFUSAL IS NOT A PROOF. The broker answers a bad HELLO before any proof
 * exists, so everything in a refusal is the word of whoever holds the pipe
 * name. Clients report it in their own words, with one of the codes the
 * broker can send (refusalCode), and never pass on its text.
 *
 * Pure functions over node:crypto, so the broker, the host, the MCP client and
 * doctor share one implementation and the tests exercise the real thing.
 */

import crypto from 'node:crypto'

export const AUTH_SCHEME = 'hmac-sha256-v1'

const NONCE_BYTES = 32
const HEX_64 = /^[0-9a-f]{64}$/

export function newNonce() {
  return crypto.randomBytes(NONCE_BYTES).toString('hex')
}

export function isNonce(value) {
  return typeof value === 'string' && HEX_64.test(value)
}

function mac(token, label, role, nonce) {
  return crypto
    .createHmac('sha256', token)
    .update(`${AUTH_SCHEME}|${label}|${String(role)}|${nonce}`)
    .digest('hex')
}

export function clientProof(token, role, nonce) {
  return mac(token, 'client', role, nonce)
}

export function brokerProof(token, role, nonce) {
  return mac(token, 'broker', role, nonce)
}

/** Constant-time comparison of two 64-character hex digests. */
function sameDigest(given, expected) {
  if (typeof given !== 'string' || !HEX_64.test(given)) return false
  return crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'))
}

function usableToken(token) {
  return typeof token === 'string' && token.length > 0
}

/** The legacy check: the client sent the token itself. Constant time. */
export function sameToken(given, token) {
  if (typeof given !== 'string' || !usableToken(token)) return false
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(token, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * The nonces the broker has accepted this boot. The token rotates on every
 * broker start, so a proof from an earlier boot fails on its own; this closes
 * the window inside one boot. Bounded, oldest first out, because a client that
 * reconnects in a loop must not grow the broker's memory without limit.
 */
export class NonceLedger {
  #seen = new Set()
  #max

  constructor(max = 4096) {
    this.#max = max
  }

  /** True the first time a nonce is offered, false on every repeat. */
  claim(nonce) {
    if (this.#seen.has(nonce)) return false
    this.#seen.add(nonce)
    while (this.#seen.size > this.#max) this.#seen.delete(this.#seen.values().next().value)
    return true
  }

  get size() {
    return this.#seen.size
  }
}

/**
 * The broker's decision on a HELLO.
 *
 * @returns {{ok: boolean, scheme: string|null, proof?: string, reason?: string}}
 *   `proof` is present only when the client proved itself with the scheme, and
 *   is what the broker puts in HELLO_ACK.
 */
export function authenticateHello(msg, token, ledger) {
  if (msg?.auth === AUTH_SCHEME) {
    if (!usableToken(token) || !isNonce(msg.nonce)) return { ok: false, scheme: AUTH_SCHEME, reason: 'malformed' }
    if (!sameDigest(msg.proof, clientProof(token, msg.role, msg.nonce))) {
      return { ok: false, scheme: AUTH_SCHEME, reason: 'bad proof' }
    }
    if (!ledger.claim(msg.nonce)) return { ok: false, scheme: AUTH_SCHEME, reason: 'replayed nonce' }
    return { ok: true, scheme: AUTH_SCHEME, proof: brokerProof(token, msg.role, msg.nonce) }
  }
  return sameToken(msg?.token, token)
    ? { ok: true, scheme: null }
    : { ok: false, scheme: null, reason: 'bad token' }
}

/**
 * What a client puts in HELLO, and what it must see in HELLO_ACK: a nonce and
 * a proof, never the token.
 *
 * Null when the runtime file names no scheme this client speaks, or holds no
 * token. The caller then does not dial (see NO DOWNGRADE above); there is no
 * HELLO a client can send that an impostor could not use.
 *
 * @returns {{fields: object, expect: {token: string, role: string, nonce: string}}|null}
 */
export function helloCredentials({ token, scheme, role }) {
  if (scheme !== AUTH_SCHEME || !usableToken(token)) return null
  const nonce = newNonce()
  return {
    fields: { auth: AUTH_SCHEME, nonce, proof: clientProof(token, role, nonce) },
    expect: { token, role, nonce },
  }
}

/**
 * Whether an ok HELLO_ACK came from the broker that owns this boot's token.
 * `expect` is what helloCredentials returned. Anything else, null included,
 * proves nothing.
 */
export function ackProvesBroker(ack, expect) {
  if (!expect || !usableToken(expect.token)) return false
  return sameDigest(ack?.proof, brokerProof(expect.token, expect.role, expect.nonce))
}

/**
 * The codes the broker refuses a HELLO with: ERR.UNAUTHORIZED, ERR.BAD_REQUEST
 * and ERR.PANIC, spelled here for the same reason as HELLO_ACK_TYPE below (a
 * test pins them to the protocol).
 */
export const REFUSAL_CODES = Object.freeze(['E_UNAUTHORIZED', 'E_BAD_REQUEST', 'E_PANIC'])

/**
 * The code of a refused HELLO_ACK, as far as a client can know it: the one the
 * endpoint gave when the broker could have given it, E_UNAUTHORIZED otherwise.
 * The refusal comes before any proof (A REFUSAL IS NOT A PROOF, above), so the
 * code is all a client keeps of it.
 */
export function refusalCode(ack) {
  const code = ack?.error?.code
  return REFUSAL_CODES.includes(code) ? code : REFUSAL_CODES[0]
}

/** The sentence every client uses when runtime.json names no scheme it speaks. */
export function noSchemeMessage(runtimeFile, startCommand) {
  return (
    `${runtimeFile} does not say the broker proves itself (its auth field is missing or unknown), ` +
    'so nothing was sent: the file may be from a broker older than this client, or left behind by ' +
    `one that stopped. Restart the broker, which rewrites it: ${startCommand}`
  )
}

/** MSG.HELLO_ACK, spelled here so this module does not import the protocol. */
export const HELLO_ACK_TYPE = 'hello_ack'

/**
 * A client's decision on the FIRST frame after its HELLO.
 *
 * The broker says nothing before HELLO_ACK, so a first frame of any other type
 * is a protocol violation, and it is the one an impostor would use to walk
 * around the proof: the host used to relay anything that was not the ack
 * straight to the browser, whether or not the link had been proven.
 *
 * @returns {'ready'|'refused'|'impostor'|'out-of-order'}
 */
export function judgeFirstFrame(msg, expect) {
  if (msg?.type !== HELLO_ACK_TYPE) return 'out-of-order'
  if (msg.ok !== true) return 'refused'
  return ackProvesBroker(msg, expect) ? 'ready' : 'impostor'
}

/** The scheme a runtime file advertises, or null for a broker from before it. */
export function runtimeScheme(runtime) {
  return runtime?.auth === AUTH_SCHEME ? AUTH_SCHEME : null
}

/** The sentence every client uses when an ack fails the check. */
export function impostorMessage(endpoint) {
  return (
    `The endpoint at ${endpoint} answered HELLO without proving it holds this boot's broker token, ` +
    'so nothing was sent to it. Another process may own the pipe name. Check that the broker is ' +
    'running (npm run doctor) and restart it; if it cannot start, the name is taken.'
  )
}
