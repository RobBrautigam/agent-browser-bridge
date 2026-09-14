/**
 * The native messaging host.
 *
 * Chromium spawns ONE of these per browser profile that calls
 * chrome.runtime.connectNative('com.agent_browser_bridge.host'). It owns nothing and
 * decides nothing: it moves framed bytes between the browser's stdio port and
 * the always-on broker's named pipe.
 *
 *   extension SW  <--stdio (this process)-->  host  <--named pipe-->  broker
 *
 * The three things it does interpret, and why:
 *   1. Its OWN hello / hello_ack, because the broker will not route for an
 *      unauthenticated pipe client.
 *   2. Inbound register / hello / req while the broker is unreachable, so the
 *      extension gets a typed E_NO_BROKER now instead of waiting out its own
 *      deadline - and a register_ack refusal when a live broker link drops, so
 *      an orphaned profile re-introduces itself instead of going quiet.
 *   3. Frame size on the way to the browser, because Chromium hard-caps that
 *      direction at 1 MiB and silently drops anything larger.
 *
 * Argv, as Chromium passes it: argv[1] is the calling extension origin and, on
 * Windows, argv[2] is --parent-window=<HWND>. In Node's process.argv those land
 * at index 2 and 3, after execPath and this script.
 *
 * STDOUT IS PROTOCOL. A stray console write here corrupts the native messaging
 * stream and presents as an unparseable stream rather than an error, so the
 * real writer is captured below and process.stdout.write is redirected to
 * stderr for the life of the process.
 */

import net from 'node:net'
import crypto from 'node:crypto'

import {
  FrameDecoder,
  encodeFrame,
  writeFrame,
  CHUNK_THRESHOLD_BYTES,
  MAX_TO_BROWSER_BYTES,
} from '../shared/framing.mjs'
import {
  MSG,
  ROLE,
  ERR,
  LINK,
  TIMING,
  PIPE_NAME,
  hello,
  helloAck,
  registerAck,
  fail,
  splitIntoChunks,
  backoffDelay,
} from '../shared/protocol.mjs'
import { START_BROKER_COMMAND, readRuntimeToken } from '../shared/paths.mjs'

/* -------------------------------------------------------------------------- */
/* stdout guard - installed first, before anything else can log                */
/* -------------------------------------------------------------------------- */

/** The real writer. Every protocol frame goes through this and nothing else. */
const writeStdout = process.stdout.write.bind(process.stdout)

process.stdout.write = function redirectStrayStdoutToStderr(chunk, encoding, cb) {
  return process.stderr.write(chunk, encoding, cb)
}

const DEBUG = Boolean(process.env.BRIDGE_DEBUG)

/** Chromium captures host stderr into the browser log, so a chatty host is a real cost. */
function log(...parts) {
  if (!DEBUG) return
  process.stderr.write(`[bridge-host ${process.pid}] ${parts.join(' ')}\n`)
}

/** Always reported, debug or not: these mean the relay is broken, not just noisy. */
function logFatal(message) {
  process.stderr.write(`[bridge-host ${process.pid}] ${message}\n`)
}

/* -------------------------------------------------------------------------- */
/* Constants that are local to the relay                                       */
/* -------------------------------------------------------------------------- */

/**
 * Outbound frames held while the broker is unreachable. Small on purpose: a
 * long outage must not grow memory, and a result delivered minutes late is
 * worse than one that never arrives, because the broker has already timed it
 * out and reused nothing.
 */
const OUTBOUND_BUFFER_MAX = 32

/** Browser-originated request ids awaiting a broker answer. Bounded for the same reason. */
const PENDING_REQ_MAX = 256

const NO_BROKER_MESSAGE = `The broker is not running. Start it with: ${START_BROKER_COMMAND}`

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

const EXTENSION_ORIGIN = extensionOriginFromArgv(process.argv)

let link = LINK.DOWN
let socket = null
let socketDecoder = null
let attempt = 0
let reconnectTimer = null
let ackTimer = null
let awaitingOwnAck = false
let stdoutBlocked = false
let socketBlocked = false
let shuttingDown = false

/**
 * True once this browser port has introduced itself with a REGISTER that we
 * actually handed to a broker. It gates the refusal sent on a link drop: an
 * extension that never registered has nothing to tear down, and an unsolicited
 * register_ack would only confuse its state machine.
 */
let browserRegistered = false

const outbound = []
const pendingReqIds = new Set()

const stdinDecoder = new FrameDecoder()

/**
 * Chromium hands the origin as the first argument, but a shim could reorder
 * things, so match on the scheme and fall back to position.
 */
function extensionOriginFromArgv(argv) {
  const args = argv.slice(2)
  return args.find((a) => a.startsWith('chrome-extension://')) || args[0] || null
}

/* -------------------------------------------------------------------------- */
/* Broker link                                                                 */
/* -------------------------------------------------------------------------- */

function connect() {
  if (shuttingDown || link !== LINK.DOWN) return
  clearTimeout(reconnectTimer)
  reconnectTimer = null
  link = LINK.CONNECTING

  // Re-read on EVERY connect attempt. The broker mints a fresh token on each
  // start, so a host that cached one would be locked out until the browser
  // restarted it.
  const token = readRuntimeToken()
  const s = net.connect({ path: PIPE_NAME })
  socket = s
  socketDecoder = new FrameDecoder()
  awaitingOwnAck = true

  s.on('connect', () => {
    writeFrame(
      s,
      hello({
        role: ROLE.HOST,
        token,
        pid: process.pid,
        ppid: process.ppid,
        extensionOrigin: EXTENSION_ORIGIN,
      })
    )
    // A pipe that accepts the connection but never answers is the incumbent's
    // killer failure. Branch on the ack, never on "does a socket object exist".
    ackTimer = setTimeout(() => {
      log('no hello_ack within', String(TIMING.HELLO_ACK_TIMEOUT), 'ms, dropping link')
      s.destroy()
    }, TIMING.HELLO_ACK_TIMEOUT)
  })

  s.on('data', (chunk) => {
    if (socket !== s) return
    let msgs
    try {
      msgs = socketDecoder.push(chunk)
    } catch (err) {
      // A bad length prefix means the pipe stream is no longer trustworthy.
      // Dropping and redialing is the only safe move; resynchronizing guesses.
      logFatal(`broker frame decode failed: ${err?.message || err}`)
      s.destroy()
      return
    }
    for (const msg of msgs) {
      if (socket !== s) return
      handleFromBroker(msg)
    }
  })

  s.on('error', (err) => {
    log('pipe error:', err?.code || err?.message || String(err))
  })

  s.on('close', () => {
    if (socket === s) onSocketClosed()
  })
}

function onSocketClosed() {
  clearTimeout(ackTimer)
  ackTimer = null
  socket = null
  socketDecoder = null
  awaitingOwnAck = false
  socketBlocked = false
  link = LINK.DOWN
  process.stdin.resume()

  // Anything the browser asked for is now unanswerable. Say so, typed.
  failPendingRequests()
  refuseRegistration()

  if (shuttingDown) return

  // Unlimited attempts, capped delay, and deliberately NO cooldown state: the
  // incumbent's 5-minute freeze after 8 failures is why a transient blip left
  // it dead for minutes.
  const delay = backoffDelay(attempt++, {
    base: TIMING.RECONNECT_BASE,
    factor: TIMING.RECONNECT_FACTOR,
    cap: TIMING.RECONNECT_CAP,
  })
  log('link down, retrying in', String(delay), 'ms (attempt', String(attempt) + ')')
  reconnectTimer = setTimeout(connect, delay)
}

function handleFromBroker(msg) {
  // The pipe is ordered and we forward nothing until the link is ready, so the
  // FIRST hello_ack on a fresh socket is unambiguously the answer to our own
  // hello. Every later one belongs to the extension and is relayed.
  if (awaitingOwnAck && msg?.type === MSG.HELLO_ACK) {
    awaitingOwnAck = false
    clearTimeout(ackTimer)
    ackTimer = null
    if (msg.ok) {
      link = LINK.READY
      attempt = 0
      log('link ready')
      flushOutbound()
    } else {
      logFatal(`broker refused hello: ${msg.error?.code || 'unknown'}`)
      socket?.destroy()
    }
    return
  }

  if (msg?.type === MSG.RES && msg.id != null) pendingReqIds.delete(msg.id)
  sendToBrowser(msg)
}

/* -------------------------------------------------------------------------- */
/* Browser -> broker                                                           */
/* -------------------------------------------------------------------------- */

function handleFromBrowser(msg) {
  if (link === LINK.READY) {
    forwardToBroker(msg)
    return
  }

  // A REGISTER buffered through a CONNECTING window is still an introduction:
  // if the dial fails, the extension has to hear a refusal for it.
  if (msg?.type === MSG.REGISTER && link === LINK.CONNECTING) browserRegistered = true

  // CONNECTING is a sub-5-second window that usually ends in success, so
  // holding the message beats telling the extension to tear down and retry.
  if (link === LINK.CONNECTING) {
    bufferOutbound(msg)
    return
  }

  // DOWN means no attempt is in flight. Answer now and typed so the extension's
  // state machine flips immediately instead of waiting out its own deadline.
  //
  // REGISTER is the case that actually matters: it is the extension's real
  // introduction, and the first build only answered HELLO and REQ here, so the
  // one message this fast path exists for still burned the full 5 s deadline.
  if (msg?.type === MSG.REGISTER) {
    sendToBrowser(
      registerAck({ ok: false, error: { code: ERR.NO_BROKER, message: NO_BROKER_MESSAGE } })
    )
    return
  }
  if (msg?.type === MSG.HELLO) {
    sendToBrowser(helloAck({ ok: false, error: { code: ERR.NO_BROKER, message: NO_BROKER_MESSAGE } }))
    return
  }
  if (msg?.type === MSG.REQ && msg.id != null) {
    sendToBrowser(fail(msg.id, ERR.NO_BROKER, NO_BROKER_MESSAGE))
    return
  }
  bufferOutbound(msg)
}

function forwardToBroker(msg) {
  if (msg?.type === MSG.REQ && msg.id != null) rememberPending(msg.id)
  if (msg?.type === MSG.REGISTER) browserRegistered = true
  const flushed = writeFrame(socket, msg)
  if (flushed || socketBlocked || !socket) return
  // The pipe asked us to wait. Stop reading the browser rather than buffering
  // a 64 MiB screenshot in userland.
  socketBlocked = true
  process.stdin.pause()
  socket.once('drain', () => {
    socketBlocked = false
    process.stdin.resume()
  })
}

function bufferOutbound(msg) {
  outbound.push(msg)
  while (outbound.length > OUTBOUND_BUFFER_MAX) {
    outbound.shift()
    log('outbound buffer full, dropped oldest frame')
  }
}

function flushOutbound() {
  while (outbound.length > 0 && link === LINK.READY) forwardToBroker(outbound.shift())
}

function rememberPending(id) {
  if (pendingReqIds.size >= PENDING_REQ_MAX) {
    pendingReqIds.delete(pendingReqIds.values().next().value)
  }
  pendingReqIds.add(id)
}

function failPendingRequests() {
  for (const id of pendingReqIds) sendToBrowser(fail(id, ERR.NO_BROKER, NO_BROKER_MESSAGE))
  pendingReqIds.clear()
}

/**
 * Tell the browser its registration is void, so it re-introduces itself.
 *
 * A broker restart mints a new generation and an empty route table, so every
 * profile that registered against the old process is orphaned: the host redials
 * and says HELLO on its own hop, but HELLO is the HOST's introduction, not the
 * extension's, and nothing replays the REGISTER.
 *
 * The fix is deliberately a refusal rather than a cached replay. Caching the
 * old REGISTER would make this relay the author of a registration the extension
 * did not choose to send, and its state machine would then be reasoning about a
 * link it never re-established. Refusing hands the decision back: onRegisterAck
 * sees ok:false, tears the port down, and reconnects with a fresh REGISTER
 * carrying its current tab count and label.
 */
function refuseRegistration() {
  if (!browserRegistered) return
  browserRegistered = false

  // Drop any REGISTER still sitting in the outbound buffer. Once the extension
  // has been told its registration is void, replaying that frame at the next
  // successful dial would register a profile the extension believes is not
  // registered, and its fresh REGISTER would then arrive as a second route for
  // the same install. Buffered REQ frames are left alone: a late answer to one
  // is merely useless, not a ghost identity.
  for (let i = outbound.length - 1; i >= 0; i--) {
    if (outbound[i]?.type === MSG.REGISTER) outbound.splice(i, 1)
  }

  sendToBrowser(
    registerAck({
      ok: false,
      error: {
        code: ERR.NO_BROKER,
        message: `The broker link dropped, so this registration is void. ${NO_BROKER_MESSAGE}`,
      },
    })
  )
}

/* -------------------------------------------------------------------------- */
/* Broker -> browser, with chunking                                            */
/* -------------------------------------------------------------------------- */

function sendToBrowser(msg) {
  let frame
  try {
    frame = encodeFrame(msg)
  } catch (err) {
    logFatal(`cannot encode frame for the browser: ${err?.message || err}`)
    return
  }
  if (frame.length > CHUNK_THRESHOLD_BYTES) {
    sendChunked(msg, frame)
    return
  }
  pushToStdout(frame)
}

/**
 * Chromium enforces MAX_TO_BROWSER_BYTES on the read path and drops oversized
 * messages with no error surface, so anything large is split here and
 * reassembled by the extension.
 *
 * The split itself is splitIntoChunks() from the contract, not a local
 * implementation. The first build had one on each side of this hop and the two
 * agreed on none of the three field names, so every chunked message was
 * silently dropped: this relay emitted { op, corrId, seq, total, b64 } while the
 * extension read { type, id, data }. There is now exactly one envelope, built in
 * one place.
 */
function sendChunked(msg, frame) {
  // The frame's 4-byte length prefix is per-frame framing, not payload. Each
  // chunk gets its own when it is encoded below, so only the body is split.
  const body = frame.subarray(4)
  const corrId =
    typeof msg?.id === 'string' || typeof msg?.id === 'number' ? String(msg.id) : crypto.randomUUID()

  const parts = splitIntoChunks(corrId, body)
  log('chunking', String(body.length), 'bytes into', String(parts.length), 'frames')

  for (const part of parts) {
    const chunkFrame = encodeFrame(part)
    if (chunkFrame.length > MAX_TO_BROWSER_BYTES) {
      logFatal(
        `chunk ${part.seq + 1}/${part.total} is ${chunkFrame.length} bytes, over the browser cap`
      )
      return
    }
    pushToStdout(chunkFrame)
  }
}

function pushToStdout(frame) {
  const flushed = writeStdout(frame)
  if (flushed || stdoutBlocked) return
  stdoutBlocked = true
  socket?.pause()
  process.stdout.once('drain', () => {
    stdoutBlocked = false
    socket?.resume()
  })
}

/* -------------------------------------------------------------------------- */
/* Browser stdio                                                               */
/* -------------------------------------------------------------------------- */

process.stdin.on('data', (chunk) => {
  let msgs
  try {
    msgs = stdinDecoder.push(chunk)
  } catch (err) {
    logFatal(`browser frame decode failed: ${err?.message || err}`)
    shutdown(1)
    return
  }
  for (const msg of msgs) handleFromBrowser(msg)
})

// EOF means the browser closed the port: the profile is gone, so this relay is
// finished. The broker notices the dropped pipe and marks the route stale.
process.stdin.on('end', () => shutdown(0))
process.stdin.on('error', (err) => {
  log('stdin error:', err?.code || err?.message || String(err))
  shutdown(0)
})

process.stdout.on('error', (err) => {
  if (err?.code === 'EPIPE') {
    shutdown(0)
    return
  }
  logFatal(`stdout error: ${err?.code || err?.message || String(err)}`)
  shutdown(1)
})

process.on('uncaughtException', (err) => {
  logFatal(`fatal: ${err?.stack || err}`)
  shutdown(1)
})

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  clearTimeout(reconnectTimer)
  clearTimeout(ackTimer)

  const s = socket
  socket = null
  if (!s) {
    process.exit(code)
    return
  }

  // Hand the broker whatever the browser already gave us before the pipe goes.
  try {
    while (outbound.length > 0) writeFrame(s, outbound.shift())
  } catch (err) {
    log('flush on shutdown failed:', err?.message || String(err))
  }
  s.on('close', () => process.exit(code))
  s.end()
  setTimeout(() => process.exit(code), 1_000).unref()
}

log('starting, origin =', EXTENSION_ORIGIN || '(none)')
connect()
