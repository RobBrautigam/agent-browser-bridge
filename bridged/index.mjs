/**
 * The broker - `bridged`.
 *
 * Exactly one of these runs, started at logon. It owns everything stateful in
 * the system: the route table, the profile identity join, policy, arming and
 * the audit log. Every other component is deliberately dumb.
 *
 *   extension SW --native messaging--> host --named pipe--> [ THIS ] <--named pipe-- mcp server
 *
 * There is NO network listener here. Not a hardened one, not a token-gated one,
 * none. A local socket is the only way in - a Windows named pipe, or a Unix
 * domain socket file on macOS and Linux - which makes the entire "a web page or
 * a remote host reaches the bridge" threat class structurally absent rather
 * than defended against.
 *
 * The socket NAME is not a secret - `\\.\pipe\` is fully enumerable by any
 * local user - so the per-boot token in the owner-only runtime file does all of
 * the work. It is minted fresh on every start, so a leaked token dies at the
 * next reboot, and clients re-read it on every connect, so rotation is
 * transparent to them.
 *
 * This process has no stdout protocol, but it still never writes to stdout:
 * everything goes to the broker log and stderr, so that a broker started
 * without a console attached loses nothing.
 */

import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { FrameDecoder, MAX_TO_BROWSER_BYTES, encodeFrame, writeFrame } from '../shared/framing.mjs'
import {
  PRODUCT_NAME,
  PROTOCOL_VERSION,
  PIPE_NAME,
  ROLE,
  MSG,
  OPS,
  TIER,
  ERR,
  LABEL_PATTERN,
  LINK,
  TIMING,
  helloAck,
  registerAck,
  req,
  ok,
  fail,
  ping,
  event,
  emptyBoard,
  isOpenOrFocusUrl,
  isRestrictedUrl,
  RAW_TAB_ID_FIELD,
} from '../shared/protocol.mjs'
import {
  BASE_DIR,
  IS_WINDOWS,
  LOG_FILE,
  processIsGone,
  RUNTIME_FILE,
  ensureBaseDir,
  readJson,
  restrictToCurrentUser,
  writeRuntime,
} from '../shared/paths.mjs'

import { AuditLog } from './audit.mjs'
import {
  ArmingState,
  MAX_ARM_MINUTES,
  PanicSwitch,
  canOriginate,
  canSend,
  checkTierAccess,
  clampArmMinutes,
  isAuditableOp,
  isHostSelfOnlyOp,
  isPanicExempt,
  isRole,
  requiresProfile,
  tierFor,
} from './policy.mjs'
import {
  RouteTable,
  absentLabelHolder,
  collisionNotes,
  lineFor,
  unclaimedKey,
  warningFor,
} from './routes.mjs'
import {
  ProfileStore,
  SOURCE_IDENTITY_CHANGED,
  UNKNOWN_VENDOR,
  absentLine,
  applyClaim,
  candidatesFor,
  defaultLabelFor,
  driftDisplayAccount,
  findBrowserProcess,
  forgetClaim,
  identityChangedWarning,
  identityDrift,
  resolveIdentity,
} from './profiles.mjs'

/* -------------------------------------------------------------------------- */
/* Identity of this process                                                    */
/* -------------------------------------------------------------------------- */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VERSION = String(readJson(path.join(HERE, '..', 'package.json'), {})?.version || '0.0.0')
const STARTED_AT = Date.now()

/** 256 bits, fresh every boot. See the file header for why rotation is safe. */
const TOKEN = crypto.randomBytes(32).toString('hex')

/** The broker log rotates on the same terms as the audit log: one generation, 5 MB. */
const LOG_ROTATE_BYTES = 5 * 1024 * 1024
const DEBUG = process.env.BRIDGE_DEBUG === '1'

/**
 * Set by the hidden launcher (broker-launch.vbs).
 *
 * Under the launcher there is no console and nothing capturing stderr, so the
 * echo below has no reader at all. Suppressing it is not a saving so much as an
 * admission: broker.log is the only record, which is why the write path below
 * must never be able to stop writing.
 *
 * A failed file write still attempts the echo. Under the launcher that goes
 * nowhere, so it only helps a foreground run, and the real protection for the
 * hidden case is that a rotation failure can no longer suppress the append.
 */
const QUIET = process.env.BRIDGE_QUIET === '1'

/* -------------------------------------------------------------------------- */
/* Logging - stderr and a file, never stdout                                   */
/* -------------------------------------------------------------------------- */

let logSize = 0
try {
  logSize = fs.statSync(LOG_FILE).size
} catch {
  logSize = 0
}

function log(level, message, extra = undefined) {
  if (level === 'debug' && !DEBUG) return
  const record = { at: new Date().toISOString(), level, message }
  if (extra !== undefined) record.data = extra
  const line = JSON.stringify(record) + '\n'
  // Rotation is attempted in its own try, and deliberately NOT allowed to skip
  // the append below. renameSync fails on Windows whenever another process
  // holds broker.log open, which a tail, an editor, or a second broker mid
  // EADDRINUSE all do. Sharing one try with the append meant a single such
  // failure left logSize above the threshold, so every later call retried the
  // rename and appended nothing: the log went dark for the life of the process
  // at a plausible-looking 5 MB.
  if (logSize + line.length > LOG_ROTATE_BYTES) {
    try {
      fs.rmSync(`${LOG_FILE}.1`, { force: true })
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`)
      logSize = 0
    } catch {
      // Keep appending to the current file and let it run over the limit. The
      // reset backs the next attempt off by another LOG_ROTATE_BYTES rather
      // than retrying on every line, and it self-heals once the holder lets go.
      // An oversized log beats no log.
      logSize = 0
    }
  }

  let wroteToFile = false
  try {
    fs.appendFileSync(LOG_FILE, line, 'utf8')
    logSize += Buffer.byteLength(line)
    wroteToFile = true
  } catch {
    // A log write failing must never stop the broker serving browsers.
  }
  if (!QUIET || !wroteToFile) process.stderr.write(line)
}

/* -------------------------------------------------------------------------- */
/* Broker state                                                                */
/* -------------------------------------------------------------------------- */

const store = new ProfileStore().load()

/**
 * A collision can move an already-connected route off the name it was holding.
 * That is a label change like any other: every outstanding tab handle carries
 * the old label and must stop working, and the extension is holding a name that
 * is no longer true. Both are handled here, in one place, so a rename, a claim
 * and a collision all behave identically.
 */
const routes = new RouteTable({
  onLabelChanged: (route, previous) => {
    route.generation = store.nextGeneration(route.installId)
    store.remember(route.installId, {
      label: route.label,
      desiredLabel: route.desiredLabel,
      generation: route.generation,
    })
    log('warn', 'Route label changed', {
      installId: route.installId,
      from: previous,
      to: route.label,
      claimed: route.claimed,
    })
    notifyLabel(route)
  },
})
const arming = new ArmingState()
const audit = new AuditLog({ onError: (err) => log('error', 'Audit write failed', { err: String(err) }) })
const panic = new PanicSwitch({
  onChange: (active) => {
    log(active ? 'error' : 'info', active ? 'PANIC tripped' : 'PANIC cleared', { file: panic.file })
    if (active) enterPanic('panic file appeared')
  },
})

/** connection id -> Connection */
const connections = new Map()
/** broker request id -> pending record */
const pendings = new Map()

let connSeq = 0
let reqSeq = 0

/* -------------------------------------------------------------------------- */
/* Connections                                                                 */
/* -------------------------------------------------------------------------- */

class Connection {
  constructor(socket) {
    this.id = ++connSeq
    this.socket = socket
    this.role = null
    this.decoder = new FrameDecoder()
    this.meta = {}
    this.closed = false
    this.browserProbe = null // started at HELLO so the ancestry walk overlaps REGISTER

    // Every connection must authenticate inside this window or it is gone. An
    // unauthenticated socket sitting open is a socket someone is fishing with.
    this.helloTimer = setTimeout(() => {
      this.destroy(`no HELLO within ${TIMING.HOST_HELLO_DEADLINE} ms`)
    }, TIMING.HOST_HELLO_DEADLINE)

    this.registerTimer = null
  }

  send(msg) {
    if (this.closed) return false
    try {
      return writeFrame(this.socket, msg)
    } catch (err) {
      log('warn', 'Frame write failed', { conn: this.id, err: String(err) })
      this.destroy('write failed')
      return false
    }
  }

  /**
   * Send a final message, then close once the bytes are actually handed off.
   *
   * `destroy()` straight after a `write()` can discard the buffered frame, and
   * a client that is refused without ever RECEIVING the reason reconnects
   * forever with no diagnostic anywhere - the precise silent-failure class this
   * project exists to remove. The timer is a backstop for a callback that never
   * fires because the peer already went away.
   */
  sendAndClose(msg, reason) {
    if (this.closed) return
    try {
      this.socket.write(encodeFrame(msg), () => this.destroy(reason))
      setTimeout(() => this.destroy(reason), 1_000).unref()
    } catch {
      this.destroy(reason)
    }
  }

  destroy(reason) {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.helloTimer)
    clearTimeout(this.registerTimer)
    log('debug', 'Connection closed', { conn: this.id, role: this.role, reason })
    try {
      this.socket.destroy()
    } catch {
      /* already gone */
    }
  }
}

function onConnection(socket) {
  const conn = new Connection(socket)
  connections.set(conn.id, conn)
  log('debug', 'Connection opened', { conn: conn.id })

  socket.on('data', (chunk) => {
    let messages
    try {
      messages = conn.decoder.push(chunk)
    } catch (err) {
      // A bad length prefix or unparseable body means the stream is no longer
      // trustworthy. Guessing where the next frame starts is exactly how a
      // relay silently corrupts a session, so the connection ends here.
      log('warn', 'Framing error, dropping connection', { conn: conn.id, err: String(err) })
      conn.destroy('framing error')
      return
    }
    for (const msg of messages) {
      try {
        handleMessage(conn, msg)
      } catch (err) {
        log('error', 'Unhandled error while handling a message', {
          conn: conn.id,
          type: msg?.type,
          err: String(err?.stack || err),
        })
      }
    }
  })

  socket.on('error', (err) => {
    log('debug', 'Socket error', { conn: conn.id, err: String(err) })
  })

  socket.on('close', () => {
    connections.delete(conn.id)
    conn.closed = true
    clearTimeout(conn.helloTimer)
    clearTimeout(conn.registerTimer)
    releaseConnection(conn)
  })
}

/** Tear down whatever a closed connection owned. */
function releaseConnection(conn) {
  const route = routes.byConnection(conn)
  if (route) {
    log('info', 'Route disconnected', { label: route.label, installId: route.installId })
    store.touch(route.installId)
    routes.detach(route)
    failPendingsFor(
      (p) => p.route === route,
      ERR.PROFILE_STALE,
      `Profile "${route.label}" disconnected before this operation finished.`
    )
  }
  // Requests issued by a departed MCP client stay in flight so their audit
  // line is still written when the browser answers; only the reply is dropped.
  for (const pending of pendings.values()) {
    if (pending.mcpConn === conn) pending.mcpConn = null
  }
}

/* -------------------------------------------------------------------------- */
/* Message dispatch                                                            */
/* -------------------------------------------------------------------------- */

function handleMessage(conn, msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    conn.destroy('malformed message')
    return
  }

  if (conn.role === null) {
    handleHello(conn, msg)
    return
  }

  // THE CAPABILITY PARTITION. Structural, checked before anything else, and
  // fatal to the connection: a compliant client never trips it, so a client
  // that does is either broken or trying something.
  if (!canSend(conn.role, msg.type)) {
    log('warn', 'Capability violation', { conn: conn.id, role: conn.role, type: msg.type })
    conn.destroy(`role ${conn.role} may not send ${msg.type}`)
    return
  }

  switch (msg.type) {
    case MSG.REQ:
      handleReq(conn, msg)
      return
    case MSG.REGISTER:
      // The only async handler, because the identity join may still be waiting
      // on the process-ancestry walk. Its rejection has to be caught here; the
      // caller's try/catch cannot see past the promise boundary.
      handleRegister(conn, msg).catch((err) => {
        log('error', 'REGISTER failed', { conn: conn.id, err: String(err?.stack || err) })
        conn.destroy('register failed')
      })
      return
    case MSG.RES:
      handleRes(conn, msg)
      return
    case MSG.PONG:
      handlePong(conn, msg)
      return
    case MSG.EVENT:
      handleEvent(conn, msg)
      return
    default:
      log('debug', 'Ignoring message type', { conn: conn.id, type: msg.type })
  }
}

function handleHello(conn, msg) {
  if (msg.type !== MSG.HELLO) {
    conn.sendAndClose(
      helloAck({ ok: false, error: { code: ERR.UNAUTHORIZED, message: 'HELLO must come first.' } }),
      'first message was not HELLO'
    )
    return
  }
  if (!isRole(msg.role)) {
    conn.sendAndClose(
      helloAck({ ok: false, error: { code: ERR.BAD_REQUEST, message: `Unknown role "${msg.role}".` } }),
      'unknown role'
    )
    return
  }
  if (!tokenMatches(msg.token)) {
    // Say nothing about why. The client either read runtime.json or it did not.
    log('warn', 'Rejected a connection with a bad token', { conn: conn.id, role: msg.role })
    conn.sendAndClose(
      helloAck({
        ok: false,
        error: { code: ERR.UNAUTHORIZED, message: 'Bad or missing token. Re-read runtime.json.' },
      }),
      'bad token'
    )
    return
  }

  // Panic drops routes and keeps them dropped. MCP clients are still accepted
  // so the model gets a typed E_PANIC and can tell the operator which file to delete,
  // instead of seeing the bridge as merely broken.
  if (panic.check() && msg.role === ROLE.HOST) {
    conn.sendAndClose(
      helloAck({
        ok: false,
        error: { code: ERR.PANIC, message: `Panic is active. Delete ${panic.file} to resume.` },
      }),
      'panic active'
    )
    return
  }

  clearTimeout(conn.helloTimer)
  conn.role = msg.role
  conn.meta = {
    pid: Number.isInteger(msg.pid) ? msg.pid : null,
    ppid: Number.isInteger(msg.ppid) ? msg.ppid : null,
    client: typeof msg.client === 'string' ? msg.client : null,
    hostVersion: typeof msg.hostVersion === 'string' ? msg.hostVersion : null,
  }

  if (conn.role === ROLE.HOST) {
    // Start the process-ancestry walk NOW, not at REGISTER. It costs a
    // PowerShell start, and doing it here overlaps that cost with the
    // extension's own identity round trip so REGISTER_ACK is not held up.
    const probePid = conn.meta.pid || conn.meta.ppid
    conn.browserProbe = findBrowserProcess(probePid).catch(() => null)

    conn.registerTimer = setTimeout(() => {
      if (routes.byConnection(conn)) return

      // A host that authenticated and then never introduced a profile is the
      // signature of a BROKER RESTART: the host redialed and sent HELLO, but
      // the extension's own browser port never dropped, so nothing upstream
      // knew a REGISTER was owed. Dropping the socket silently here made that
      // loop permanent - reconnect, wait, get destroyed, repeat, with the
      // profile orphaned the whole time and no diagnostic anywhere.
      //
      // So the refusal is typed and relayed instead. A REGISTER_ACK carrying
      // ok:false is exactly what the extension's link state machine already
      // acts on: it tears the port down and reconnects, which produces the
      // REGISTER this connection was waiting for. The code is BAD_REQUEST
      // rather than NO_BROKER because a broker plainly IS here; what is
      // missing is the client's half of the handshake.
      conn.sendAndClose(
        registerAck({
          ok: false,
          error: {
            code: ERR.BAD_REQUEST,
            message:
              `No REGISTER arrived within ${TIMING.HOST_HELLO_DEADLINE} ms of HELLO. The broker has ` +
              'no profile for this connection, so it cannot route anything to it. Reconnect and send ' +
              'REGISTER - if the browser port is still open, tear it down first so the extension ' +
              're-registers.',
          },
          version: VERSION,
        }),
        `no REGISTER within ${TIMING.HOST_HELLO_DEADLINE} ms`
      )
      log('warn', 'Refused a host connection that never sent REGISTER', {
        conn: conn.id,
        client: conn.meta.client,
        deadlineMs: TIMING.HOST_HELLO_DEADLINE,
      })
    }, TIMING.HOST_HELLO_DEADLINE)
  }

  conn.send(
    helloAck({
      ok: true,
      product: PRODUCT_NAME,
      protocol: PROTOCOL_VERSION,
      serverVersion: VERSION,
      role: conn.role,
      pid: process.pid,
      panic: panic.active,
    })
  )
  log('info', 'Connection authenticated', { conn: conn.id, role: conn.role, client: conn.meta.client })
}

function tokenMatches(given) {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(TOKEN, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/* -------------------------------------------------------------------------- */
/* REGISTER: a browser profile joins                                           */
/* -------------------------------------------------------------------------- */

/**
 * Read a REGISTER envelope, field for field, as shared/protocol.mjs pins it.
 *
 * Nothing here is guessed or aliased. The first build had the extension send
 * `vendor` and `extensionVersion` while this side read `vendorHint` and
 * `extVersion`, so the vendor claim silently arrived as undefined and every
 * Brave profile registered as a Chrome one - an IDENTITY error, which is the
 * worst class of failure this system can produce. Both sides now go through
 * register() and this reader, and an unrecognized spelling reads as absent
 * rather than as a wrong-but-plausible value.
 */
function readRegister(msg) {
  return {
    installId: typeof msg.installId === 'string' && msg.installId ? msg.installId : null,
    vendorHint: typeof msg.vendorHint === 'string' ? msg.vendorHint : null,
    email: typeof msg.email === 'string' ? msg.email : null,
    label: typeof msg.label === 'string' ? msg.label : null,
    extVersion: typeof msg.extVersion === 'string' ? msg.extVersion : null,
    tabCount: Number.isFinite(msg.tabCount) ? msg.tabCount : 0,
  }
}

async function handleRegister(conn, msg) {
  const incoming = readRegister(msg)
  const installId = incoming.installId
  if (!installId) {
    conn.sendAndClose(
      registerAck({
        ok: false,
        error: { code: ERR.BAD_REQUEST, message: 'REGISTER requires a stable installId.' },
        version: VERSION,
      }),
      'register without installId'
    )
    return
  }

  clearTimeout(conn.registerTimer)

  // The probe was started at HELLO; give it a moment to land but never let it
  // hold the acknowledgement open. An unverified vendor is a warning on the
  // line, not a failure.
  const probed = await Promise.race([
    conn.browserProbe || Promise.resolve(null),
    new Promise((resolve) => setTimeout(() => resolve(null), TIMING.HELLO_ACK_TIMEOUT)),
  ]).catch(() => null)

  const identity = await resolveIdentity({
    installId,
    pid: conn.meta.pid || conn.meta.ppid,
    vendorHint: incoming.vendorHint,
    email: incoming.email,
    store,
    browserProcess: probed, // null here means "looked and found nothing", not "go look"
  })

  if (conn.closed) return

  const saved = store.get(installId)
  // Sticky until it is actually resolved. A drop detected in a previous session
  // is still the reason this line is unclaimed today, and clearing the flag on
  // the next browser start would replace "a different account is signed in" with
  // a bland "needs claiming" - the same prompt, minus the reason for it. Only a
  // successful re-claim clears it.
  const identityChanged =
    identity.source === SOURCE_IDENTITY_CHANGED || Boolean(saved?.identityChanged && !identity.claimed)
  // The route is built from this object, so the sticky case has to reach it
  // here rather than only in the store, or the board would render the flag on a
  // reconnect and not on the one after that.
  identity.identityChanged = identityChanged
  if (identityChanged && identity.source !== SOURCE_IDENTITY_CHANGED) {
    identity.warnings.push(
      'Identity changed: the account signed into this profile stopped matching the one this line ' +
        'was claimed as, so the claim was dropped. Claim it again in the options page.'
    )
  }

  // A custom label is the operator's name for an IDENTITY, not for a browser window.
  // When the identity under it changed, keeping the name is exactly how "work"
  // ends up addressing their personal mailbox with nothing on screen saying so - so
  // the rename is dropped along with the claim and the line falls back to a
  // name that says out loud that it needs a human.
  //
  // The extension's own remembered label is deliberately NOT consulted here any
  // more. It used to be, whenever the broker had no saved label of its own,
  // which meant a lost state.json resurrected whatever name the EXTENSION
  // remembered rather than deriving one from the identity actually signed in
  // now. The extension's memory is not evidence of who is signed in.
  const labelIsCustom = identityChanged ? false : Boolean(saved?.labelIsCustom)

  // A claim HONORED WITHOUT BEING VERIFIED keeps the name it already had.
  //
  // Honoring the claim was only half the job: the identity fields still came
  // back off whatever degraded row was on disk, and deriving a label from those
  // renamed the line anyway. A `Local State` written seconds ago with a name
  // and no address turns "chrome-acme-corp" into "chrome-acme-corp-io"
  // for as long as the flush takes, which is a rename of the thing every tool
  // call says out loud - triggered by a browser start, on the daily path.
  const persistedLabel = saved?.desiredLabel || saved?.label || null
  const desired = labelIsCustom
    ? saved.label
    : identity.identityUnverified && persistedLabel
      ? persistedLabel
      : defaultLabelFor(identity)

  if (identity.identityAdopted) {
    log('warn', 'Adopted an identity fingerprint for a claim made before fingerprints existed', {
      installId,
      label: saved?.label || null,
      fingerprint: identity.identityAdopted,
    })
  }

  // Every register is a new browser session as far as tab handles are
  // concerned, so the generation moves and every outstanding handle dies.
  const generation = store.nextGeneration(installId)

  const { route, replaced } = routes.attach({
    installId,
    conn,
    identity,
    generation,
    desiredLabel: desired,
    labelIsCustom,
    extVersion: incoming.extVersion,
    tabCount: incoming.tabCount,
  })

  if (replaced && replaced.conn !== conn) {
    // Replace, never duplicate. The old socket goes so a browser restart can
    // never leave two live routes claiming one profile.
    log('info', 'Replacing an existing route', { label: route.label, installId })
    failPendingsFor(
      (p) => p.route === replaced,
      ERR.PROFILE_STALE,
      `Profile "${route.label}" reconnected while this operation was in flight.`
    )
    replaced.conn?.destroy('replaced by a newer registration')
  }

  if (identityChanged) {
    // ONE helper owns every consequence of a dropped claim, and both drift
    // paths call it. The steps used to be spelled out here and again in the
    // heartbeat check, which is how they drifted apart: this path disarmed and
    // forgot the fingerprint, that one also failed in-flight requests and told
    // the extension. Nothing performs those steps piecemeal any more.
    //
    // `notify` is off because the acknowledgement a few lines below IS the
    // notification on this path, and it carries the same fields.
    dropClaim(route, identity.drift, {
      account: identity.email,
      profileName: identity.profileName,
      notify: false,
      reason: 'register',
    })
  }

  // Note what is NOT written here: identityFingerprint. This call overwrites
  // its fields on every single register, so recording the fingerprint through
  // it would refresh the claim-time evidence on every reconnect and there would
  // be nothing left to compare an account switch against. The fingerprint is
  // written only where a claim is MADE - applyClaim, the address match, and the
  // trust-on-first-use backfill - and cleared wherever one is dropped.
  store.remember(installId, {
    vendor: identity.vendor,
    vendorLabel: identity.vendorLabel,
    userDataDir: identity.userDataDir,
    profileDir: identity.profileDir,
    profileName: identity.profileName,
    email: identity.email,
    claimed: identity.claimed,
    identityChanged,
    label: route.label,
    desiredLabel: route.desiredLabel,
    labelIsCustom,
    lastSeenAt: Date.now(),
  })

  // The same envelope the broker re-asserts whenever this route's identity
  // changes later. One builder for both, so the answer to REGISTER and the
  // correction that follows a dropped claim can never carry different fields.
  notifyIdentity(route)

  log('info', 'Route registered', {
    label: route.label,
    installId,
    vendor: route.vendor,
    vendorVerified: route.vendorVerified,
    profileDir: route.profileDir,
    claimed: route.claimed,
    generation: route.generation,
    source: identity.source,
    // A claim honored while `Local State` was unreadable or half-written. Not a
    // fault and not a warning on screen, but the one thing that explains why a
    // line kept its old name instead of deriving a new one.
    identityUnverified: identity.identityUnverified,
  })

  // Push the fresh board to the options page, which has no other way to ask.
  conn.send(event(OPS.GET_BOARD, buildBoard()))
}

/* -------------------------------------------------------------------------- */
/* PONG and EVENT                                                              */
/* -------------------------------------------------------------------------- */

function handlePong(conn, msg) {
  const route = routes.byConnection(conn)
  if (!route) return
  routes.notePong(route, msg.seq, msg)
}

/**
 * Unsolicited notices from a browser. Never a mutation.
 *
 * The options page used to reach the broker through here, with the OPS names
 * reused as EVENT names, because a host could not send a REQ. That improvised
 * convention is gone: the UI now sends a real REQ carrying one of
 * HOST_REQ_ALLOWED_OPS, which gets a correlated typed reply and, for claims and
 * arming, an audit line. Both properties a fire-and-forget EVENT could never
 * provide - a failed claim was logged here and nowhere the human could see it.
 *
 * What remains is genuinely one-way: a board refresh a browser asks for, and
 * the tab count it volunteers between heartbeats.
 */
function handleEvent(conn, msg) {
  const route = routes.byConnection(conn)
  const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {}

  if (msg.name === OPS.GET_BOARD) {
    conn.send(event(OPS.GET_BOARD, buildBoard()))
    return
  }

  if (route && Number.isFinite(payload.tabCount)) route.tabCount = payload.tabCount
  log('debug', 'Event', { conn: conn.id, name: msg.name })
}

/* -------------------------------------------------------------------------- */
/* REQ: an MCP session, or the extension's own UI, asks for something          */
/* -------------------------------------------------------------------------- */

function handleReq(conn, msg) {
  const id = msg.id
  if (typeof id !== 'string' && typeof id !== 'number') {
    conn.destroy('REQ without an id')
    return
  }
  const op = typeof msg.op === 'string' ? msg.op : ''
  const tier = tierFor(op)
  if (!tier) {
    conn.send(fail(id, ERR.BAD_REQUEST, `Unknown operation "${op}".`))
    return
  }

  // The other half of the capability partition. canSend admitted the REQ as a
  // message TYPE, because the extension's options page has no other way to
  // reach the broker; this decides whether the role may ask for THIS operation.
  // A host asking for anything in BROWSER_OPS is the case that matters: it
  // would mean one profile driving another, so it is fatal to the connection
  // exactly as any other capability violation is.
  if (!canOriginate(conn.role, op)) {
    log('warn', 'Capability violation', { conn: conn.id, role: conn.role, type: msg.type, op })
    conn.destroy(`role ${conn.role} may not originate "${op}"`)
    return
  }

  // Re-stat on EVERY request. fs.watch is not reliable on every Windows
  // filesystem, and a safety control that depends on a best-effort
  // notification is not a safety control.
  if (panic.check() && !isPanicExempt(op)) {
    reply(
      conn,
      msg,
      fail(id, ERR.PANIC, `Panic is active, so every browser operation is refused. Delete ${panic.file} to resume.`)
    )
    return
  }

  if (!requiresProfile(op)) {
    handleGlobalOp(conn, msg)
    return
  }

  const route = resolveRequestRoute(conn, msg, op)
  if (!route) return // resolveRequestRoute has already answered

  const gate = checkTierAccess({
    tier,
    claimed: route.claimed,
    armed: arming.isArmed(route.installId),
    label: route.label,
  })
  if (gate) {
    reply(conn, msg, fail(id, gate.code, gate.message), { route })
    return
  }

  // SET_LABEL is a broker-local operation with one extra step: the broker
  // owns the label, and after deciding it the extension is told (as a
  // fire-and-forget request) so its own surfaces show the same name the
  // model addresses. It is NOT in BROWSER_OPS; the capability partition keeps
  // host-originated ops and page-touching ops disjoint.
  if (op === OPS.SET_LABEL) {
    handleSetLabelOp(conn, msg, route)
    return
  }

  if (tier === TIER.META) {
    handleProfileMetaOp(conn, msg, route)
    return
  }

  forwardToBrowser(conn, msg, route, op)
}

/**
 * Which route a profile-addressed REQ acts on.
 *
 * An mcp connection names the profile, and the address resolves exactly or not
 * at all - there is no default profile anywhere in this system, because acting
 * on the wrong browser is the worst thing it can do.
 *
 * A host is different in exactly one way: for the operations that decide what a
 * profile IS - claiming and renaming - it may only ever address ITSELF, so the
 * route comes from the CONNECTION and whatever the envelope carries in
 * `profile` is ignored. That is why the UI contract sends those two with a null
 * profile. Arming deliberately still takes an explicit label: the board is
 * the operator's own UI and arming another line from it is the point.
 *
 * @returns {object|null} null means an answer has already been sent
 */
function resolveRequestRoute(conn, msg, op) {
  const id = msg.id

  if (conn.role === ROLE.HOST && isHostSelfOnlyOp(op)) {
    const own = routes.byConnection(conn)
    if (!own) {
      conn.send(
        fail(
          id,
          ERR.UNKNOWN_PROFILE,
          `This browser has no registered route yet, so "${op}" has nothing to act on. Wait for ` +
            'REGISTER_ACK and try again.'
        )
      )
      return null
    }
    return own
  }

  const address = msg.profile
  if (typeof address !== 'string' || address === '') {
    conn.send(fail(id, ERR.BAD_REQUEST, `Operation "${op}" requires a profile. ${describeProfiles()}`))
    return null
  }

  const { route, ambiguous } = routes.resolveAddress(address)

  // `vendor:profileDir` ignores the user-data-dir, and two browsers of one
  // vendor started against different user-data-dirs both call a profile
  // directory "Default". Returning the first match would be a coin flip between
  // two logged-in identities, so this refuses and names them.
  if (ambiguous) {
    reply(
      conn,
      msg,
      fail(
        id,
        ERR.BAD_REQUEST,
        `"${address}" matches ${ambiguous.length} connected profiles ` +
          `(${ambiguous.map((r) => r.label).join(', ')}), because that address form does not say ` +
          'which user-data-dir it means. Name one of those labels instead.'
      )
    )
    return null
  }

  if (!route) {
    // A name that two profiles both derive resolves to nothing ON PURPOSE:
    // neither of them keeps the bare form. Saying only "unknown profile" would
    // read as a broker fault, so name the two labels that did take it.
    const split = routes.labelsForBase(address)
    const message =
      split.length > 1
        ? `"${address}" is the name two profiles both want, so nothing answers to it. Name one of ` +
          `these instead: ${split.join(', ')}.`
        : `Unknown profile "${address}". ${describeProfiles()}`
    reply(conn, msg, fail(id, ERR.UNKNOWN_PROFILE, message))
    return null
  }
  return route
}

/** Operations that address the broker itself rather than a profile. */
function handleGlobalOp(conn, msg) {
  const id = msg.id
  switch (msg.op) {
    case OPS.GET_BOARD:
      conn.send(ok(id, buildBoard()))
      return

    case OPS.STATUS:
      conn.send(
        ok(id, {
          ...buildBoard(),
          uptimeMs: Date.now() - STARTED_AT,
          pid: process.pid,
          pipe: PIPE_NAME,
          connections: connections.size,
          routes: routes.size,
          inFlight: pendings.size,
          stateFile: store.file,
          auditFile: audit.file,
          panicFile: panic.file,
        })
      )
      return

    case OPS.PANIC: {
      const args = msg.args && typeof msg.args === 'object' ? msg.args : {}

      // The popup's panic switch can turn panic ON and cannot turn it OFF, and
      // that asymmetry is the design rather than an oversight: the panic file
      // is the one control that works without the broker's or the model's
      // cooperation, so clearing it stays a human action at the filesystem.
      // The useful thing to answer with is the exact path to delete. The MCP
      // tool sends no args at all, so the default below is still "trip".
      if (args.on === false) {
        if (!panic.check()) {
          reply(conn, msg, ok(id, { panic: false, clearBy: panic.file }))
          return
        }
        reply(
          conn,
          msg,
          fail(
            id,
            ERR.UNSUPPORTED,
            `Panic cannot be cleared through the bridge by design, because a bridge that can clear ` +
              `its own emergency stop is not an emergency stop. Delete ${panic.file} to resume.`
          )
        )
        return
      }

      // Order matters here. enterPanic destroys every route connection, and
      // when panic is tripped from the extension popup the requesting
      // connection IS one of those routes - so replying afterwards writes to a
      // dead socket and the human is left staring at a spinner during the one
      // interaction where certainty matters most. Count first, answer the
      // caller with write-then-close, and let enterPanic skip the connection
      // that is already closing itself.
      //
      // The write-then-close path bypasses reply(), which is where auditable
      // operations are normally recorded, so the audit line is written here
      // by hand. Panic is the one event the log must never be missing.
      panic.trip()
      const dropped = routes.size
      audit.record({ profile: null, op: OPS.PANIC, url: null, ok: true, ms: null, err: null })
      conn.sendAndClose(ok(id, { panic: true, dropped, clearBy: panic.file }), 'panic')
      enterPanic('bridge_panic', conn)
      return
    }

    default:
      conn.send(fail(id, ERR.BAD_REQUEST, `Operation "${msg.op}" is not a broker-wide operation.`))
  }
}

/** Meta operations that name a profile and never cross into the browser. */
function handleProfileMetaOp(conn, msg, route) {
  const id = msg.id
  const args = msg.args && typeof msg.args === 'object' ? msg.args : {}

  switch (msg.op) {
    case OPS.ARM: {
      // Refusing to arm an unclaimed profile is deliberate, and it is the twin
      // of the armed-tier gate in policy.mjs checkTierAccess. That gate refuses
      // arbitrary JS in a session whose identity nobody can name; this one
      // refuses to pretend such a session can be armed. Allowing the arm to
      // succeed here would hand back a cheerful confirmation for a state in
      // which browser_eval_js still fails, which is worse than refusing.
      //
      // Read and write operations stay available on an unclaimed route so it
      // can be inspected and claimed. Only the armed tier requires a name.
      if (!route.claimed) {
        reply(
          conn,
          msg,
          fail(
            id,
            ERR.PROFILE_UNCLAIMED,
            `Profile "${route.label}" has not been claimed, so its identity is unknown and the ` +
              'armed tier cannot be enabled for it. Open the extension options page in that ' +
              'browser profile and pick which profile it is. This is a one-time step.'
          ),
          { route }
        )
        return
      }
      const minutes = clampArmMinutes(args.minutes)
      const armedUntil = arming.arm(route.installId, minutes)
      log('warn', 'Armed', { label: route.label, minutes, armedUntil })
      reply(
        conn,
        msg,
        ok(id, {
          profile: route.label,
          minutes,
          armedUntil,
          maxMinutes: MAX_ARM_MINUTES,
        }),
        { route }
      )
      return
    }

    case OPS.DISARM: {
      arming.disarm(route.installId)
      log('info', 'Disarmed', { label: route.label })
      reply(conn, msg, ok(id, { profile: route.label, armedUntil: null }), { route })
      return
    }

    case OPS.CLAIM_PROFILE: {
      const result = claimProfile(route, args.dir)
      if (!result.ok) {
        reply(conn, msg, fail(id, result.code, result.message), { route })
        return
      }
      reply(conn, msg, ok(id, { line: lineFor(route, { armedUntil: arming.armedUntil(route.installId) }) }), {
        route,
      })
      return
    }

    default:
      conn.send(fail(id, ERR.BAD_REQUEST, `Operation "${msg.op}" is not a profile meta operation.`))
  }
}

/**
 * Rename a profile, then tell the extension what it is now called.
 *
 * The forward is deliberately fire-and-forget: it carries no pending record,
 * so if the extension does not implement it the reply simply falls through the
 * unknown-request path and is logged at debug. The rename itself already
 * succeeded in the only place that decides addressing, which is here.
 */
function handleSetLabelOp(conn, msg, route) {
  const args = msg.args && typeof msg.args === 'object' ? msg.args : {}
  const result = setLabel(route, args.label)
  if (!result.ok) {
    reply(conn, msg, fail(msg.id, result.code, result.message), { route })
    return
  }

  notifyLabel(route)

  reply(
    conn,
    msg,
    ok(msg.id, {
      line: lineFor(route, { armedUntil: arming.armedUntil(route.installId) }),
      handlesInvalidated: true,
    }),
    { route }
  )
}

/**
 * Re-assert to the extension WHO this line is, not just what it is called.
 *
 * The extension caches the REGISTER_ACK and answers `getSelf()` out of that
 * cache, and the options page decides whether to show the claim card from
 * `self.claimed`. So a claim dropped between registers - the one case where the
 * claim card is the whole point - left a cached `claimed: true` sitting there,
 * getSelf lied, and the options page offered an identity panel for a line the
 * broker had already unclaimed. The label notification below could not fix that
 * because a label is not an identity.
 *
 * Built through registerAck() so every field the extension stores and the
 * options page renders is present. The first build hand-rolled that envelope
 * and omitted profileDir, profileName, vendor, warning and version, so
 * getSelf() reported nulls for a profile the broker had fully resolved and the
 * label-collision warning never reached the one surface that could act on it.
 *
 * Sending it out of band is safe by construction: the extension's handler is
 * idempotent, it is the same shape it already accepts at registration, and it
 * says nothing that is not true at the moment of the send.
 */
function notifyIdentity(route) {
  route.conn?.send(
    registerAck({
      ok: true,
      profileKey: route.key,
      label: route.label,
      generation: route.generation,
      claimed: route.claimed,
      candidates: route.candidates,
      profileDir: route.profileDir,
      profileName: route.profileName,
      vendor: route.vendor,
      warning: warningFor(route),
      version: VERSION,
      heartbeatMs: TIMING.HEARTBEAT_INTERVAL,
    })
  )
}

/**
 * Tell an extension what its line is now called, and refresh its board.
 *
 * Every path that can change a label goes through here: a rename, a claim, a
 * collision that moved an incumbent, and the identity check dropping a claim.
 * The forward is fire-and-forget on purpose - it carries no pending record, so
 * an extension that does not implement it simply falls through the unknown
 * request path. The rename already succeeded in the only place that decides
 * addressing, which is the broker.
 *
 * The identity re-assert leads, because every one of those paths also moves the
 * generation, and a label the extension holds against a stale generation is a
 * name it cannot mint a working handle under.
 */
function notifyLabel(route) {
  notifyIdentity(route)
  route.conn?.send(
    req({
      id: `b${++reqSeq}`,
      op: OPS.SET_LABEL,
      profile: route.label,
      args: { label: route.label, generation: route.generation },
      timeoutMs: TIMING.OP_TIMEOUT_DEFAULT,
    })
  )
  route.conn?.send(event(OPS.GET_BOARD, buildBoard()))
}

/**
 * Drop a claim - everywhere a claim is recorded, in one call.
 *
 * THE ONLY PLACE ANY OF THIS HAPPENS. There are two ways drift is found, at
 * register and on the heartbeat, and the steps used to be written out in both
 * of them. They had already diverged: one disarmed and forgot the fingerprint,
 * the other also nulled the identity fields, failed in-flight requests and told
 * the extension. A third caller would have forgotten a different one, and every
 * step here exists because skipping it leaves something addressable, armed or
 * in flight under an identity that is gone.
 *
 * The steps, in an order that matters:
 *   1. the route stops being an identity     nothing can be routed to it
 *   2. arming is revoked                     a grant is to a person, not a window
 *   3. generation moves, then the label      every outstanding tab handle dies
 *   4. the durable record is forgotten       claim AND the evidence behind it
 *   5. in-flight requests fail               they were addressed to somebody else
 *   6. the extension is told                 its cached identity is now false
 *
 * `notify` is off on the register path only, where the REGISTER_ACK that
 * follows is itself the notification and carries the same fields.
 */
function dropClaim(route, drift, { account = null, profileName = null, notify = true, reason = 'heartbeat' } = {}) {
  const previousLabel = route.label

  // 1. Unclaim. profileDir is what routing joins on, so nulling it is what
  //    makes the line unaddressable as that person.
  route.claimed = false
  route.profileDir = null
  route.hostedDomain = null
  route.identityChanged = true
  route.source = SOURCE_IDENTITY_CHANGED
  route.key = unclaimedKey(route.installId)
  // Display only. Both drift paths leave the SAME two fields, because the
  // drifted line is the one row where "which account is this now" is the whole
  // question, and nulling everything made it the only line that answered
  // "none".
  route.email = account
  route.profileName = profileName
  route.candidates = candidatesFor(route.vendor, route.userDataDir).map((c) => ({
    dir: c.dir,
    name: c.name,
    email: c.email ?? null,
  }))
  if (drift) routes.addWarning(route, identityChangedWarning(drift))

  // 2. Arming is granted to a person, not to a browser window, so it cannot
  //    outlive the person. It is keyed by installId, which does not change when
  //    the account does; without this an arm survives the switch.
  arming.disarm(route.installId)

  // 3. Generation BEFORE the rename, because the rename announces itself and
  //    that announcement carries the number. The label goes with the claim,
  //    custom or not: read and write operations are served on an unclaimed
  //    route, so a surviving "work" would still drive a browser, now as somebody
  //    else. Dropping to the unclaimed name is what makes the next tool call
  //    fail loudly instead of act.
  route.generation = store.nextGeneration(route.installId)
  routes.setDesiredLabel(route, defaultLabelFor(route), { custom: false })

  // 4. The durable half, including the fingerprint. A fingerprint that outlives
  //    its claim is a record of somebody nothing is comparing against any more.
  forgetClaim(store, route.installId, {
    identityChanged: true,
    profileName: route.profileName,
    email: route.email,
    label: route.label,
    desiredLabel: route.desiredLabel,
    labelIsCustom: false,
  })

  // 5. Anything in flight was asked of the person who is no longer here.
  failPendingsFor(
    (p) => p.route === route,
    ERR.PROFILE_STALE,
    `Profile "${previousLabel}" changed identity while this operation was in flight, so it was ` +
      'abandoned rather than completed as somebody else.'
  )

  log('error', 'Identity changed under a claimed profile; the claim was dropped', {
    installId: route.installId,
    previousLabel,
    label: route.label,
    vendor: route.vendor,
    why: drift?.why || null,
    from: drift?.from || null,
    to: drift?.to || null,
    found: reason,
  })

  // 6. The extension is holding a cached identity that is now false.
  if (notify) notifyLabel(route)
  return previousLabel
}

/* -------------------------------------------------------------------------- */
/* Claim and rename                                                            */
/* -------------------------------------------------------------------------- */

function claimProfile(route, dir) {
  if (typeof dir !== 'string' || !dir) {
    return { ok: false, code: ERR.BAD_REQUEST, message: 'A profile directory is required.' }
  }

  // An undetermined vendor has no candidate list on purpose (see
  // resolveIdentity): "Default" exists in every browser, so a claim with only a
  // directory name could land on the wrong one. Say that plainly rather than
  // letting it fall through to an empty "Choices: (none)".
  if (route.vendor === UNKNOWN_VENDOR) {
    return {
      ok: false,
      code: ERR.BAD_REQUEST,
      message:
        `The bridge could not tell which browser "${route.label}" is, so it cannot offer profile ` +
        'directories to choose between - every browser has a "Default". Reload the extension so it ' +
        're-registers, and if this persists check that the native host is launched by the browser ' +
        'itself rather than by a detached shell.',
    }
  }

  const full = candidatesFor(route.vendor, route.userDataDir)
  const patch = applyClaim({ candidatesFull: full, vendor: route.vendor, userDataDir: route.userDataDir, dir })
  if (!patch) {
    return {
      ok: false,
      code: ERR.BAD_REQUEST,
      message:
        `"${dir}" is not one of the profile directories this browser offers. Choices: ` +
        `${full.map((c) => c.dir).join(', ') || '(none)'}.`,
    }
  }

  Object.assign(route, {
    profileDir: patch.profileDir,
    profileName: patch.profileName,
    email: patch.email,
    hostedDomain: patch.hostedDomain,
    claimed: true,
    // A re-claim is how an identity-changed line is put back into service, so
    // the flag has to clear here or the board would keep shouting about a
    // problem the operator just fixed.
    identityChanged: false,
    // AND SO DOES THE CACHED LIVE ADDRESS, or the fix does not survive a
    // minute. `reportedEmail` is written once, at REGISTER, and never refreshed
    // while a browser stays open - so after an in-session drop it still holds
    // whatever the extension said at start-up. The heartbeat check would
    // compare that frozen address against the row the operator just claimed, call it
    // drift, and undo the re-claim on the next pass. applyClaim declares the
    // clearing as part of the patch, so the rule lives with the claim rather
    // than in whichever caller remembered it.
    reportedEmail: patch.reportedEmail,
    source: patch.source,
    candidates: full.map((c) => ({ dir: c.dir, name: c.name, email: c.email })),
  })
  route.identityCheckedAt = Date.now()

  // The label is derived from the identity, so a claim changes it - and a
  // changed label changes what a tab handle means. Bump the generation so old
  // handles fail loudly instead of quietly pointing somewhere else.
  //
  // Bumped BEFORE the rename, because renaming announces itself to the
  // extension and that announcement carries the generation. Doing it the other
  // way round tells the extension a number that is stale one line later.
  route.generation = store.nextGeneration(route.installId)
  if (!route.labelIsCustom) {
    routes.setDesiredLabel(route, defaultLabelFor(route))
  }

  store.remember(route.installId, {
    vendor: route.vendor,
    userDataDir: route.userDataDir,
    profileDir: route.profileDir,
    profileName: route.profileName,
    email: route.email,
    claimed: true,
    identityChanged: false,
    // The claim-time record of WHO was signed in. Written here and nowhere on
    // the register path, so a later register cannot refresh it out from under
    // the comparison it exists to serve.
    identityFingerprint: patch.identityFingerprint,
    claimedAt: patch.claimedAt,
    label: route.label,
    desiredLabel: route.desiredLabel,
    labelIsCustom: route.labelIsCustom,
  })

  // The extension's cached identity says whatever it said at registration,
  // which for a re-claim is "unclaimed" - and that cache is what getSelf and
  // the options page read. Re-assert unconditionally: when the label also
  // changed the table's own callback has already announced it, and a second
  // identical assertion is cheaper than reasoning about whether it did.
  notifyIdentity(route)

  log('info', 'Profile claimed', {
    label: route.label,
    installId: route.installId,
    profileDir: route.profileDir,
    fingerprint: patch.identityFingerprint,
  })
  return { ok: true }
}

function setLabel(route, requested) {
  const label = typeof requested === 'string' ? requested.trim() : ''
  if (!LABEL_PATTERN.test(label)) {
    return {
      ok: false,
      code: ERR.BAD_REQUEST,
      message:
        'A label must be 1 to 32 characters of lowercase letters, digits and hyphens, starting ' +
        'with a letter or digit.',
    }
  }
  const holder = routes.labelHolder(label, route.installId)
  if (holder) {
    // Refuse rather than silently appending a suffix: the operator typed this name on
    // purpose, and handing them a suffixed variant without saying so is how two
    // profiles end up one keystroke apart.
    return {
      ok: false,
      code: ERR.BAD_REQUEST,
      message:
        `"${label}" is already used by ${holder.vendorLabel} ${holder.profileDir || '(unclaimed)'}. ` +
        'Pick another name or rename that one first.',
    }
  }

  // A name held by a profile that is merely NOT CONNECTED RIGHT NOW is still
  // taken. Checking only live routes meant a browser that happened to be closed
  // could have its name handed to a different identity, and get it back the
  // moment it reopened - two lines, one name, no warning at the moment of the
  // rename.
  const absent = absentLabelHolder(label, store.entries(), {
    exceptInstallId: route.installId,
    isLive: (installId) => Boolean(routes.byInstallId(installId)),
  })
  if (absent) {
    return {
      ok: false,
      code: ERR.BAD_REQUEST,
      message:
        `"${label}" belongs to ${absent.vendorLabel || absent.vendor || 'a browser profile'} ` +
        `${absent.profileDir || '(unclaimed)'}, which the bridge knows about but is not connected ` +
        'right now. Open that browser profile and rename it there, or pick another name.',
    }
  }

  // Generation first: the rename announces itself and the announcement carries
  // this number.
  route.generation = store.nextGeneration(route.installId)
  routes.setDesiredLabel(route, label, { custom: true })
  store.remember(route.installId, {
    label: route.label,
    desiredLabel: route.desiredLabel,
    labelIsCustom: true,
  })
  log('info', 'Profile renamed', { label: route.label, installId: route.installId })
  return { ok: true }
}

/* -------------------------------------------------------------------------- */
/* Forwarding to a browser                                                     */
/* -------------------------------------------------------------------------- */

function forwardToBrowser(conn, msg, route, op) {
  const id = msg.id

  if (route.link !== LINK.READY) {
    const age = route.lastSeenAt ? Date.now() - route.lastSeenAt : null
    reply(
      conn,
      msg,
      fail(
        id,
        ERR.PROFILE_STALE,
        `Profile "${route.label}" is ${route.link}${age == null ? '' : ` (last heartbeat ${Math.round(age / 1000)}s ago)`}. ` +
          'The extension may have been disabled or the browser may be closing.'
      ),
      { route }
    )
    return
  }

  const args = { ...(msg.args && typeof msg.args === 'object' ? msg.args : {}) }

  // Opaque handles become raw tab ids here and nowhere else. The extension only
  // ever sees numbers, and a number can only reach it after this check.
  //
  // null and undefined mean the SAME thing - "no tab named, use the active
  // one" - and both have to be deleted rather than forwarded. An MCP tool with
  // an optional tab sends `tab: null` for the absent case, and the first build
  // only tested for undefined, so every browser_navigate without a tab was
  // validated as a handle and failed with E_BAD_TAB_HANDLE on the literal
  // string "null". A null left in the args would be just as bad: the extension
  // would see the key as present and never take its active-tab path.
  if (args.tab === null || args.tab === undefined) {
    delete args.tab
  } else {
    const check = routes.validateHandle(route, args.tab)
    if (!check.ok) {
      reply(conn, msg, fail(id, check.code, check.message), { route })
      return
    }
    args[RAW_TAB_ID_FIELD] = check.tabId
    delete args.tab
  }

  if (args.tabs === null || args.tabs === undefined) {
    delete args.tabs
  } else if (Array.isArray(args.tabs)) {
    const ids = []
    for (const handle of args.tabs) {
      const check = routes.validateHandle(route, handle)
      if (!check.ok) {
        reply(conn, msg, fail(id, check.code, check.message), { route })
        return
      }
      ids.push(check.tabId)
    }
    args.tabIds = ids
    delete args.tabs
  } else {
    reply(
      conn,
      msg,
      fail(id, ERR.BAD_REQUEST, `"tabs" must be an array of tab handles, not ${typeof args.tabs}.`),
      { route }
    )
    return
  }

  if (typeof args.url === 'string' && !urlAllowedFor(op, args.url)) {
    // An empty url reaches here too: isRestrictedUrl treats it as restricted
    // rather than as "no url", because a caller that passes an empty string is
    // a caller that thinks it has a destination.
    reply(
      conn,
      msg,
      fail(
        id,
        ERR.RESTRICTED_URL,
        args.url === ''
          ? 'An empty url is not a destination, so this is refused before it reaches the browser.'
          : op === OPS.OPEN_OR_FOCUS
            ? `"${op}" opens a page for a human to read, so it takes a web address or a local .html file and nothing else. "${args.url}" is neither.`
            : `Chromium refuses automation on "${args.url}", so this is refused early.`
      ),
      { route, url: args.url }
    )
    return
  }

  const timeoutMs = clampTimeout(msg.timeoutMs)
  const brokerId = `b${++reqSeq}`
  const outbound = req({ id: brokerId, op, profile: route.label, args, timeoutMs })

  // Native messaging is asymmetric: 64 MiB browser to host, but only 1 MiB
  // host to browser, enforced by Chromium on the READ path. An oversized frame
  // is dropped without an error anywhere, so an unchunked large command would
  // present as a request that simply never answers. Refuse it here with a typed
  // error instead. Chunking above CHUNK_THRESHOLD_BYTES is not implemented yet;
  // this is the guard that makes its absence diagnosable rather than silent.
  const outboundBytes = Buffer.byteLength(JSON.stringify(outbound), 'utf8')
  if (outboundBytes > MAX_TO_BROWSER_BYTES) {
    reply(
      conn,
      msg,
      fail(
        id,
        ERR.UNSUPPORTED,
        `This "${op}" request is ${outboundBytes} bytes, over Chromium's ${MAX_TO_BROWSER_BYTES}-byte ` +
          'limit for a message sent to a browser. Split the work into smaller requests.'
      ),
      { route }
    )
    return
  }

  const pending = {
    brokerId,
    mcpConn: conn,
    mcpId: id,
    route,
    op,
    url: typeof args.url === 'string' ? args.url : null,
    startedAt: Date.now(),
    timer: setTimeout(() => {
      pendings.delete(brokerId)
      finish(pending, fail(id, ERR.TIMEOUT, `"${op}" on "${route.label}" did not answer within ${timeoutMs} ms.`))
    }, timeoutMs),
  }
  pendings.set(brokerId, pending)

  routes.noteOp(route, op)
  route.conn.send(outbound)
}

/**
 * The URL rule, per operation, enforced HERE as well as in the extension.
 *
 * Every page-touching operation refuses RESTRICTED_URL_PREFIXES. openOrFocus is
 * the single exception, and only for a local .html page; the reasoning, and why
 * it does not restore the navigate-then-read primitive that the file: refusal
 * exists to prevent, is written on isOpenOrFocusUrl in shared/protocol.mjs.
 *
 * The duplicate check is deliberate. The broker is the enforcement point an
 * extension cannot talk its way past, so a security rule that lived only in the
 * extension would be a rule the broker merely trusts someone else to apply.
 */
function urlAllowedFor(op, url) {
  return op === OPS.OPEN_OR_FOCUS ? isOpenOrFocusUrl(url) : !isRestrictedUrl(url)
}

function clampTimeout(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return TIMING.OP_TIMEOUT_DEFAULT
  return Math.min(TIMING.OP_TIMEOUT_MAX, Math.max(1_000, Math.round(n)))
}

function handleRes(conn, msg) {
  const pending = pendings.get(msg.id)
  if (!pending) {
    log('debug', 'Result for an unknown or already-finished request', { conn: conn.id, id: msg.id })
    return
  }
  // A host may only answer requests that were sent to IT. Without this check a
  // second profile could answer the first profile's question.
  if (pending.route?.conn !== conn) {
    log('warn', 'A host answered a request that was not its own', { conn: conn.id, id: msg.id })
    conn.destroy('answered another route request')
    return
  }
  pendings.delete(msg.id)

  const response =
    msg.ok === true
      ? ok(pending.mcpId, stampHandles(pending.route, msg.result))
      : fail(
          pending.mcpId,
          msg.error?.code || ERR.EXT_ERROR,
          msg.error?.message || 'The extension returned an error with no message.',
          msg.error?.data
        )
  finish(pending, response, msg.result)
}

function finish(pending, response, result) {
  clearTimeout(pending.timer)
  pendings.delete(pending.brokerId)

  const url = (result && typeof result === 'object' && typeof result.url === 'string' ? result.url : null) || pending.url

  if (isAuditableOp(pending.op)) {
    audit.record({
      profile: pending.route?.label || null,
      op: pending.op,
      url,
      ok: response.ok === true,
      ms: Date.now() - pending.startedAt,
      err: response.ok ? null : response.error?.code,
    })
  }
  pending.mcpConn?.send(response)
}

/**
 * Stamp opaque handles onto anything the extension returned by raw tab id, and
 * REMOVE the raw id on the way past.
 *
 * The field is RAW_TAB_ID_FIELD, pinned in the contract, because this is the
 * defect that took the whole system down: the extension returns tab rows keyed
 * `tabId`, this function looked for `id`, so nothing was ever stamped and every
 * row rendered as "(no handle)". browser_list_tabs is the only documented
 * source of a handle, so with no handles minted, no tool that touches a tab
 * could work at all.
 *
 * Deleting the raw id afterwards is not tidiness. A raw Chrome tab id is a
 * per-profile integer that collides freely across profiles, so a
 * number that reaches the model is a number the model can hand back for the
 * wrong browser. The handle carries the profile label and the generation, and
 * it is the only tab identity anything above the broker is allowed to see.
 *
 * Shallow and explicit on purpose: a generic deep walk would eventually stamp
 * something that is not a tab id, and a wrong handle is worse than no handle.
 */
function stampHandles(route, result) {
  if (!result || typeof result !== 'object') return result

  if (Array.isArray(result.tabs)) {
    for (const tab of result.tabs) stampRow(route, tab)
  }
  stampRow(route, result.tab)
  stampRow(route, result) // ActionResult: openTab and navigate answer at the top level

  return result
}

/** Rewrite one object's raw tab id into a handle, in place. */
function stampRow(route, row) {
  if (!row || typeof row !== 'object') return
  const rawId = row[RAW_TAB_ID_FIELD]
  if (!Number.isInteger(rawId)) return
  row.handle = routes.mint(route, rawId)
  delete row[RAW_TAB_ID_FIELD]
}

/** Send a locally-decided response, auditing it if the operation is auditable. */
function reply(conn, msg, response, { route = null, url = null, startedAt = null } = {}) {
  if (isAuditableOp(msg.op)) {
    audit.record({
      profile: route?.label ?? (typeof msg.profile === 'string' ? msg.profile : null),
      op: msg.op,
      url,
      ok: response.ok === true,
      ms: startedAt == null ? null : Date.now() - startedAt,
      err: response.ok ? null : response.error?.code,
    })
  }
  conn.send(response)
}

function failPendingsFor(predicate, code, message) {
  for (const pending of [...pendings.values()]) {
    if (!predicate(pending)) continue
    pendings.delete(pending.brokerId)
    finish(pending, fail(pending.mcpId, code, message))
  }
}

/* -------------------------------------------------------------------------- */
/* Panic                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Drop every route and disarm everything.
 *
 * `exceptConn` is the connection that ASKED for the panic, when there is one.
 * It is already closing itself through sendAndClose so its caller gets the
 * confirmation; destroying it again here would race that write.
 */
function enterPanic(reason, exceptConn = null) {
  const dropped = routes.size
  arming.disarmAll()
  failPendingsFor(() => true, ERR.PANIC, 'Panic was tripped while this operation was in flight.')
  for (const route of routes.all()) {
    routes.detach(route)
    if (route.conn && route.conn !== exceptConn) route.conn.destroy('panic')
  }
  log('error', 'Panic: every route dropped and everything disarmed', { reason, dropped })
  return dropped
}

/* -------------------------------------------------------------------------- */
/* The board                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Re-read an unclaimed route's candidate list instead of trusting the one
 * captured at registration.
 *
 * A Chromium browser writes a stub `Local State` the instant it starts and only
 * flushes the real `profile.info_cache` seconds later - measured at roughly 15
 * seconds on a cold Brave start. Registration happens well inside that window,
 * so a list frozen at registration time is empty exactly when a freshly started
 * profile is trying to be claimed, and the claim card would offer nothing with
 * no way forward but a reload.
 *
 * Throttled because the board polls every couple of seconds, and only ever for
 * routes that are still unclaimed and whose vendor is actually known - an
 * unknown vendor deliberately gets no candidates at all, because every browser
 * calls a profile directory "Default" and a cross-vendor list could land a
 * claim on the wrong browser.
 */
const CANDIDATE_REFRESH_MS = 2_000

function refreshCandidates(route) {
  if (!route || route.claimed) return
  if (!route.vendor || route.vendor === UNKNOWN_VENDOR) return
  const now = Date.now()
  if (route.candidatesCheckedAt && now - route.candidatesCheckedAt < CANDIDATE_REFRESH_MS) return
  route.candidatesCheckedAt = now
  const fresh = candidatesFor(route.vendor, route.userDataDir)
  if (fresh.length) {
    route.candidates = fresh.map((c) => ({ dir: c.dir, name: c.name, email: c.email ?? null }))
  }
}

/**
 * How often one route's identity is re-read from disk while it is connected.
 *
 * The heartbeat fires every 15 seconds and this throttles the check to once a
 * minute per route, exactly as CANDIDATE_REFRESH_MS throttles the candidate
 * re-read: a `Local State` read is cheap but it is not free, and several connected
 * profiles would otherwise re-read it every 15 seconds forever.
 */
const IDENTITY_RECHECK_MS = 60_000

/**
 * Has the person behind this claimed line changed since it was claimed?
 *
 * This is the only thing in the system that catches an account switch made
 * WHILE a session is running - the register-time check cannot, because a browser
 * that stays open never registers again. the operator signing their Acme profile
 * into their personal mailbox at 11am would otherwise be invisible until the next
 * browser restart, and every tool call in between would act as the wrong person.
 *
 * HONEST LIMIT: on Chrome this sees the switch only once Chrome flushes
 * `profile.info_cache`, which this repo measures at roughly 15 seconds. A
 * 15-second window is not zero. It is a large improvement on never.
 *
 * On Brave there is no Google identity in `info_cache` at all, so the check
 * falls back to the profile NAME and an account switch with no rename is
 * genuinely undetectable. See docs/DESIGN.md section 4.
 */
function recheckIdentity(route) {
  if (!route || !route.claimed || !route.profileDir) return
  if (!route.vendor || route.vendor === UNKNOWN_VENDOR) return

  const now = Date.now()
  if (route.identityCheckedAt && now - route.identityCheckedAt < IDENTITY_RECHECK_MS) return
  route.identityCheckedAt = now

  const saved = store.get(route.installId)
  const rows = candidatesFor(route.vendor, route.userDataDir)
  const row = rows.find((c) => c.dir === route.profileDir) || null

  // Two shapes of "no row", and neither drops a claim from here.
  //
  // An EMPTY list is a `Local State` that could not be read, or one a browser
  // has written a stub of and not yet filled in. A list that WAS read and does
  // not carry this directory is a profile that went away - which the REGISTER
  // path does act on, because a browser start is the moment to look again.
  // Acting on it here would put a second, quieter unclaim path on the code that
  // runs every fifteen seconds all day, to catch a case that a reconnect
  // catches anyway. identityDrift reads both as CANNOT CHECK.
  const drift = identityDrift({
    savedFingerprint: saved?.identityFingerprint || null,
    row,
    reportedEmail: route.reportedEmail,
    // The row was read a moment ago; the reported address has been sitting on
    // this route since the last REGISTER. On this path DISK is the fresher of
    // the two, and saying so is what makes the sentence name the new account as
    // the new one rather than the other way round.
    liveIsFresh: false,
  })
  if (!drift.changed) return

  dropClaim(route, drift, {
    account: driftDisplayAccount(drift, { row, reportedEmail: route.reportedEmail }),
    profileName: row?.name || null,
    reason: 'heartbeat',
  })
}

function buildBoard() {
  const now = Date.now()
  const board = emptyBoard(VERSION, now)
  board.startedAt = STARTED_AT
  board.panic = panic.active

  const live = routes.all()
  for (const route of live) refreshCandidates(route)

  // Profiles configured previously and not connected now. This is the only way
  // a silently disabled unpacked extension becomes visible instead of simply
  // vanishing from the list.
  const liveIds = new Set(live.map((r) => r.installId))
  const absentLines = store
    .entries()
    .filter((entry) => !liveIds.has(entry.installId))
    .map(absentLine)

  // Collisions are computed across LIVE AND ABSENT lines together, and this is
  // the authoritative pass: a note computed here REPLACES the route table's
  // own, which can only see live routes. The blind spot that closes is a name
  // shared between a connected profile and a configured-but-closed one, which
  // used to render twice on the board with nothing said about it - and the
  // board is the one surface whose job is answering "which of these two
  // identical names am I addressing".
  const notes = collisionNotes([...live.map((route) => lineFor(route)), ...absentLines])

  board.lines = live.map((route) =>
    lineFor(route, {
      armedUntil: arming.armedUntil(route.installId),
      collisionNote: notes.get(route.installId) ?? null,
    })
  )
  for (const line of absentLines) {
    const note = notes.get(line.installId)
    if (note) line.warning = line.warning ? `${line.warning} ${note}` : note
    board.lines.push(line)
  }

  board.lines.sort((a, b) => a.label.localeCompare(b.label))
  board.audit = audit.recent(10)
  return board
}

function describeProfiles() {
  const labels = routes.labels()
  if (labels.length === 0) {
    return (
      'No profiles are connected. Check that the bridge extension is loaded and enabled in ' +
      'the browser profile you meant, then try again.'
    )
  }
  return `Connected profiles: ${labels.sort().join(', ')}.`
}

/* -------------------------------------------------------------------------- */
/* Heartbeat                                                                   */
/* -------------------------------------------------------------------------- */

function heartbeat() {
  for (const route of routes.all()) {
    if (route.pingSentAt != null) {
      route.missed += 1
      if (route.missed >= TIMING.EVICT_AFTER_MISSED) {
        log('warn', 'Evicting a route that stopped answering', {
          label: route.label,
          missed: route.missed,
        })
        // Fail what is in flight BEFORE detaching. releaseConnection() does
        // this for a socket that closes on its own, but it looks the route up
        // by connection, and a route detached here is no longer findable by
        // the time the socket's close event arrives - so a pending request
        // against an evicted route would otherwise sit out its full timeout.
        failPendingsFor(
          (p) => p.route === route,
          ERR.PROFILE_STALE,
          `Profile "${route.label}" stopped answering heartbeats and was evicted before this operation finished.`
        )
        route.conn?.destroy('missed too many heartbeats')
        routes.detach(route)
        continue
      }
      if (route.missed >= TIMING.STALE_AFTER_MISSED && route.link !== LINK.STALE) {
        route.link = LINK.STALE
        log('warn', 'Route went stale', { label: route.label, missed: route.missed })
      }
    }

    // Re-read who is signed into this profile. Throttled to once a minute per
    // route inside; a browser that stays open never registers again, so this
    // timer is the only thing that can notice an account switch mid-session.
    recheckIdentity(route)

    route.pingSeq += 1
    route.pingSentAt = Date.now()
    route.conn?.send(ping(route.pingSeq))
  }
}

/* -------------------------------------------------------------------------- */
/* Runtime file                                                                */
/* -------------------------------------------------------------------------- */

/**
 * writeRuntime() owns the shape of this file, in shared/paths.mjs, because
 * every client reads it and they were each guessing at the key names - doctor
 * alone tried three. The broker is not exempt from the contract just because it
 * is the writer.
 */
function publishRuntimeFile() {
  writeRuntime({ token: TOKEN, version: VERSION, pipeName: PIPE_NAME })
  tightenRuntimeAcl()
}

/**
 * Restrict the runtime file to the current user.
 *
 * The named pipe carries the default Windows security descriptor, which Node
 * cannot change without a native addon, and native addons are banned. So this
 * file is the only thing standing between another user account on the machine
 * and the token. Failure is a warning, never fatal: a broker that refuses to
 * start because icacls was unavailable helps nobody, and the honest statement
 * is in docs/DESIGN.md section 5.
 */
function tightenRuntimeAcl() {
  restrictToCurrentUser(RUNTIME_FILE, {
    execFile,
    onOk: (detail) => log('info', 'Runtime file restricted to the current user.', detail),
    onWarn: (detail) =>
      log('warn', 'Could not restrict the runtime file; the per-boot token is still the control.', detail),
  })
}

/**
 * On macOS and Linux the endpoint is a socket FILE, and a broker that was
 * killed without unlinking it leaves the file behind. Binding to that path
 * then fails with EADDRINUSE even though nothing is listening, which would
 * read as "another broker owns the socket" forever. So probe first: if the file
 * exists and nothing answers, it is stale and is removed. If something does
 * answer, it is left alone and the EADDRINUSE below is the truthful outcome.
 */
async function clearStaleSocket() {
  if (IS_WINDOWS) return
  if (!fs.existsSync(PIPE_NAME)) return
  const alive = await new Promise((resolve) => {
    const probe = net.connect({ path: PIPE_NAME })
    const done = (v) => {
      probe.destroy()
      resolve(v)
    }
    probe.once('connect', () => done(true))
    probe.once('error', () => done(false))
    setTimeout(() => done(false), 1_000).unref()
  })
  if (alive) return
  try {
    fs.rmSync(PIPE_NAME, { force: true })
    log('warn', 'Removed a stale socket file left by a previous broker', { socket: PIPE_NAME })
  } catch (err) {
    log('warn', 'Could not remove a stale socket file', { socket: PIPE_NAME, err: String(err) })
  }
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

let shuttingDown = false

function shutdown(reason, code = 0) {
  // Single-shot. The parent watch is a repeating timer, so a shutdown that
  // failed to reach process.exit would otherwise be retried every interval,
  // logging forever while the pipe stayed bound.
  if (shuttingDown) return
  shuttingDown = true
  log('info', 'Broker shutting down', { reason })
  try {
    // Only remove the runtime file if it is still ours, so a broker that lost
    // a startup race cannot delete the live broker's credentials.
    const current = readJson(RUNTIME_FILE, null)
    if (current && current.pid === process.pid) fs.rmSync(RUNTIME_FILE, { force: true })
  } catch {
    /* nothing to do on the way out */
  }
  panic.stop()
  try {
    for (const conn of connections.values()) conn.destroy('broker shutting down')
  } catch (err) {
    // Nothing here may keep us from reaching process.exit below. Surviving this
    // loop with the pipe still bound is the worst possible end state: every
    // replacement broker would exit on EADDRINUSE against a broker that has
    // already deleted its own runtime file.
    log('warn', 'Error while closing connections during shutdown', { err: String(err) })
  }
  try {
    server.close()
  } catch {
    /* already closed */
  }
  process.exit(code)
}

ensureBaseDir()
// A Unix socket path over the sockaddr_un limit fails at bind with an opaque
// ENAMETOOLONG, and under a supervisor that is a silent restart loop. Say
// what is wrong and how to fix it instead.
if (!IS_WINDOWS && Buffer.byteLength(PIPE_NAME) > 100) {
  log('error', 'The socket path is too long for this platform', {
    socket: PIPE_NAME,
    bytes: Buffer.byteLength(PIPE_NAME),
    fix: 'set BRIDGE_HOME to a shorter directory, or shorten socketName / stateDirName in bridge.config.json',
  })
  process.exit(1)
}
await clearStaleSocket()

const server = net.createServer(onConnection)

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Exit rather than race. Two brokers would mean two route tables, two
    // tokens and a coin flip over which one a host reaches.
    //
    // Exit code 0, not 1, and the distinction is load bearing. The system's
    // desired state is "exactly one broker owns the pipe", and that state is
    // satisfied here, just not by this process. Reporting failure made the
    // task's RestartOnFailure fire three more launches a minute apart on a
    // machine that was already perfectly healthy, which is churn the watchdog
    // repetition already covers.
    log('warn', `Another ${PRODUCT_NAME} broker already owns ${PIPE_NAME}. Not starting a second one.`)
    process.exit(0)
  }
  log('error', 'Pipe server error', { err: String(err) })
  process.exit(1)
})

server.listen(PIPE_NAME, () => {
  // A Unix socket file is created world-connectable by default; the token is
  // still the control, but there is no reason to leave the door wider than the
  // runtime file that holds the token.
  if (!IS_WINDOWS) {
    try {
      fs.chmodSync(PIPE_NAME, 0o600)
    } catch {
      /* best effort */
    }
  }
  // Publish the token only after the socket is actually bound, so a client that
  // reads runtime.json always finds something listening.
  publishRuntimeFile()
  panic.start()
  panic.check()
  setInterval(heartbeat, TIMING.HEARTBEAT_INTERVAL).unref()

  log('info', `${PRODUCT_NAME} broker listening`, {
    pipe: PIPE_NAME,
    version: VERSION,
    pid: process.pid,
    base: BASE_DIR,
    knownProfiles: store.entries().length,
    panic: panic.active,
  })
})

/**
 * Stand down when the launcher that started us is gone.
 *
 * schtasks /end terminates only the task's own process, which is wscript, and
 * leaves this one running. Without this the broker would outlive its task
 * instance: still serving, but unsupervised, while Task Scheduler saw no
 * instance and started a replacement every minute that could only exit on
 * EADDRINUSE. Shutting down cleanly instead lets the next repetition adopt the
 * pipe properly, which is the behavior the task action had when it ran node
 * directly.
 *
 * Gated on the launcher's own marker so a broker run by hand from a terminal is
 * never killed by its shell exiting.
 *
 * processIsGone lives in shared/ so it can be tested without starting a broker,
 * and it carries both the ESRCH reasoning and the pid-reuse caveat.
 *
 * Two consecutive observations are required before acting. The consequence of
 * being wrong here is a full outage: every tab handle dies and the pipe stays
 * empty until the next task repetition. One anomalous reading should not be
 * able to cause that.
 */
if (process.env.BRIDGE_WATCH_PARENT === '1') {
  const launcherPid = process.ppid
  let missedLauncher = 0
  // unref so this timer alone never holds the process open; the pipe server is
  // what keeps the broker alive.
  setInterval(() => {
    missedLauncher = processIsGone(launcherPid) ? missedLauncher + 1 : 0
    if (missedLauncher >= 2) shutdown('launcher exited')
  }, TIMING.PARENT_WATCH_INTERVAL).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

/**
 * CTRL_CLOSE_EVENT, which Windows sends when a console window is closed,
 * arrives here as SIGHUP; CTRL_BREAK arrives as SIGBREAK. Neither had a
 * listener, so Node took the default action and terminated the process with no
 * shutdown line written, which is exactly why every restart in broker.log had
 * no recorded cause.
 *
 * The hidden launcher means there is no window left to close, so this should
 * now never fire. It stays because a death that writes a reason is worth far
 * more than one that does not, and because registering the listener also
 * replaces Node's silent default with the clean shutdown path.
 */
process.on('SIGHUP', () => shutdown('SIGHUP'))
process.on('SIGBREAK', () => shutdown('SIGBREAK'))
process.on('uncaughtException', (err) => {
  log('error', 'Uncaught exception', { err: String(err?.stack || err) })
})
process.on('unhandledRejection', (err) => {
  log('error', 'Unhandled rejection', { err: String(err?.stack || err) })
})
