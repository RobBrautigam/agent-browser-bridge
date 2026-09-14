/**
 * Local-socket client from one agent session to the broker.
 *
 * There is no TCP anywhere in this system, so this is the only way out of the
 * MCP server. It speaks the same length-prefixed JSON framing as the other two
 * hops (see shared/framing.mjs) and the same envelopes as everything else
 * (see shared/protocol.mjs).
 *
 * Three properties are deliberate:
 *
 *   Lazy. Nothing connects until the first tool call. An MCP server that dials
 *   on startup would fail to start whenever the broker is down, and Claude
 *   Code would then drop the tools from the tool list entirely. Degraded but
 *   visible beats absent, so the tools always exist and a broker outage
 *   surfaces as an actionable E_NO_BROKER on the call.
 *
 *   Token re-read on every connect. The broker mints a fresh per-boot token
 *   into runtime.json on every start, so a long-lived session picks up the new
 *   one on its next reconnect with no coordination.
 *
 *   No automatic retry of an in-flight request. If the link drops after the
 *   bytes went out, we cannot know whether the click happened. Failing is
 *   correct; replaying a write against a live logged-in browser is not.
 */

import net from 'node:net'

import { FrameDecoder, writeFrame } from '../shared/framing.mjs'
import { RUNTIME_FILE, START_BROKER_COMMAND, readRuntimeToken } from '../shared/paths.mjs'
import { ERR, MSG, PIPE_NAME, ROLE, TIMING, hello, req } from '../shared/protocol.mjs'

/**
 * How long to wait for the pipe to accept a connection.
 *
 * Short on purpose. A missing pipe fails instantly with ENOENT; this timeout
 * only covers a broker that is mid-start or wedged, and in both cases the
 * useful answer is the same "start the broker" message, fast.
 */
const CONNECT_TIMEOUT_MS = 3_000

/**
 * Extra time the local response timer gets over the deadline we hand the
 * broker. The broker's own timeout should always fire first, because its
 * typed error names the operation and ours cannot.
 */
const LOCAL_TIMEOUT_GRACE_MS = 2_000

/** A failure with a code from shared/protocol.mjs ERR. Everything above this layer reads `.code`. */
export class BridgeError extends Error {
  constructor(code, message, data = undefined) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.data = data
  }
}

export class BrokerClient {
  #socket = null
  #decoder = null
  #connecting = null
  #handshakeDone = false
  #pendingHello = null
  #pending = new Map()
  #seq = 0
  #closed = false
  #onLog

  /** @param {{onLog?: (msg: string) => void}} [opts] stderr logger; stdout is protocol and must never be written to. */
  constructor({ onLog = () => {} } = {}) {
    this.#onLog = onLog
  }

  /**
   * Issue one operation and wait for its result.
   *
   * @param {{op:string, profile?:string|null, args?:object, timeoutMs?:number}} spec
   * @returns {Promise<unknown>} the broker's `result`
   * @throws {BridgeError} always typed, never a raw socket error
   */
  async request({ op, profile = null, args = {}, timeoutMs = TIMING.OP_TIMEOUT_DEFAULT }) {
    const budget = clamp(timeoutMs, 1_000, TIMING.OP_TIMEOUT_MAX)
    const socket = await this.#ready()
    const id = `mcp-${process.pid}-${++this.#seq}`

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(
          new BridgeError(
            ERR.TIMEOUT,
            `The broker did not answer ${op} within ${budget + LOCAL_TIMEOUT_GRACE_MS} ms.`
          )
        )
      }, budget + LOCAL_TIMEOUT_GRACE_MS)
      timer.unref?.()

      this.#pending.set(id, { resolve, reject, timer })

      try {
        writeFrame(socket, req({ id, op, profile, args, timeoutMs: budget }))
      } catch (err) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new BridgeError(ERR.NO_BROKER, `Could not write to the broker pipe: ${err.message}`))
      }
    })
  }

  /** Close the link. Called when the session's stdin ends. */
  close() {
    this.#closed = true
    this.#teardown(new BridgeError(ERR.NO_BROKER, 'The MCP session closed.'))
  }

  /* ---------------------------------------------------------------------- */

  /** Resolve to a connected, handshaken socket, connecting or reconnecting as needed. */
  async #ready() {
    if (this.#closed) {
      throw new BridgeError(ERR.NO_BROKER, 'This MCP session is shutting down.')
    }
    if (this.#socket && !this.#socket.destroyed && this.#handshakeDone) {
      return this.#socket
    }
    if (!this.#connecting) {
      // One dial at a time; concurrent tool calls share it. Cleared on both
      // paths so the next call after a failure dials again rather than
      // inheriting a rejected promise forever.
      this.#connecting = this.#connect().finally(() => {
        this.#connecting = null
      })
    }
    return this.#connecting
  }

  async #connect() {
    const token = this.#readToken()
    const socket = await this.#dial()

    this.#socket = socket
    this.#decoder = new FrameDecoder()
    this.#handshakeDone = false

    // The pipe must not keep the process alive on its own: when Claude Code
    // ends the session it closes stdin, and a ref'd socket would leave this
    // process running with nothing to serve.
    socket.unref?.()

    socket.on('data', (chunk) => this.#onData(chunk))
    socket.on('error', (err) => this.#teardown(new BridgeError(ERR.NO_BROKER, `Broker link error: ${err.message}`)))
    socket.on('close', () => this.#teardown(new BridgeError(ERR.NO_BROKER, 'The broker closed the connection.')))

    const ack = await this.#handshake(socket, token)
    if (ack?.ok !== true) {
      const code = ack?.error?.code || ERR.UNAUTHORIZED
      const message = ack?.error?.message || 'The broker refused the connection without saying why.'
      this.#teardown(new BridgeError(code, message))
      throw new BridgeError(code, message)
    }

    this.#handshakeDone = true
    this.#onLog(`connected to ${PIPE_NAME}`)
    return socket
  }

  /**
   * The runtime file's shape is owned by shared/paths.mjs, which is also what
   * writes it. Reading it through readRuntimeToken() rather than guessing at a
   * key name is why this client and the host cannot disagree about where the
   * token lives.
   */
  #readToken() {
    const token = readRuntimeToken()
    if (!token) {
      throw new BridgeError(
        ERR.NO_BROKER,
        `No broker token at ${RUNTIME_FILE}. The broker writes that file when it starts, so its absence means the broker has not run since this machine booted. Start it with: ${START_BROKER_COMMAND}`
      )
    }
    return token
  }

  #dial() {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ path: PIPE_NAME })
      const onConnect = () => {
        cleanup()
        resolve(socket)
      }
      const onError = (err) => {
        cleanup()
        socket.destroy()
        reject(
          new BridgeError(
            ERR.NO_BROKER,
            `Cannot reach the broker at ${PIPE_NAME} (${err.code || err.message}).`
          )
        )
      }
      const timer = setTimeout(() => {
        cleanup()
        socket.destroy()
        reject(
          new BridgeError(
            ERR.NO_BROKER,
            `Timed out after ${CONNECT_TIMEOUT_MS} ms connecting to ${PIPE_NAME}.`
          )
        )
      }, CONNECT_TIMEOUT_MS)
      timer.unref?.()

      function cleanup() {
        clearTimeout(timer)
        socket.off('connect', onConnect)
        socket.off('error', onError)
      }

      socket.once('connect', onConnect)
      socket.once('error', onError)
    })
  }

  /**
   * Say HELLO and require HELLO_ACK inside the shared deadline.
   *
   * This is the half-open guard from DESIGN.md section 8: a pipe that accepts
   * a connection proves nothing about whether the broker behind it is alive,
   * so the link is not considered up until it has answered.
   */
  #handshake(socket, token) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingHello = null
        const err = new BridgeError(
          ERR.NO_BROKER,
          `The broker accepted the connection but did not answer HELLO within ${TIMING.HELLO_ACK_TIMEOUT} ms.`
        )
        this.#teardown(err)
        reject(err)
      }, TIMING.HELLO_ACK_TIMEOUT)
      timer.unref?.()

      this.#pendingHello = {
        settle: (ack) => {
          clearTimeout(timer)
          this.#pendingHello = null
          resolve(ack)
        },
        fail: (err) => {
          clearTimeout(timer)
          this.#pendingHello = null
          reject(err)
        },
      }

      try {
        writeFrame(socket, hello({ role: ROLE.MCP, token, pid: process.pid }))
      } catch (err) {
        this.#pendingHello?.fail(new BridgeError(ERR.NO_BROKER, `Could not send HELLO: ${err.message}`))
      }
    })
  }

  #onData(chunk) {
    let messages
    try {
      messages = this.#decoder.push(chunk)
    } catch (err) {
      // A bad length prefix or unparseable body means the stream is no longer
      // trustworthy. Resynchronizing is how a relay silently corrupts a
      // session, so drop the link and let the next call redial.
      this.#teardown(new BridgeError(ERR.NO_BROKER, `Malformed frame from the broker: ${err.message}`))
      return
    }
    for (const msg of messages) this.#onMessage(msg)
  }

  #onMessage(msg) {
    if (!msg || typeof msg !== 'object') return

    switch (msg.type) {
      case MSG.HELLO_ACK:
        this.#pendingHello?.settle(msg)
        return

      case MSG.RES: {
        const waiter = this.#pending.get(msg.id)
        if (!waiter) return // already timed out locally; nothing to do
        this.#pending.delete(msg.id)
        clearTimeout(waiter.timer)
        if (msg.ok) {
          waiter.resolve(msg.result)
        } else {
          waiter.reject(
            new BridgeError(
              msg.error?.code || ERR.BAD_REQUEST,
              msg.error?.message || 'The broker reported a failure with no message.',
              msg.error?.data
            )
          )
        }
        return
      }

      // There is deliberately no MSG.PING case. The broker's heartbeat exists
      // to decide whether a BROWSER route is alive, so it pings host
      // connections only; an mcp connection is transient by design and its
      // liveness is answered by whether a request comes back. Adding a PONG
      // reply here would be dead code that reads like a live contract, so if a
      // ping ever does arrive it falls through to the default and is logged.
      case MSG.EVENT:
        this.#onLog(`event ${msg.name}`)
        return

      default:
        this.#onLog(`ignored frame type ${String(msg.type)}`)
    }
  }

  /** Drop the link and fail everything waiting on it with one typed error. */
  #teardown(err) {
    const socket = this.#socket
    this.#socket = null
    this.#decoder = null
    this.#handshakeDone = false

    if (socket) {
      socket.removeAllListeners()
      socket.destroy()
    }

    this.#pendingHello?.fail(err)

    for (const [, waiter] of this.#pending) {
      clearTimeout(waiter.timer)
      waiter.reject(err)
    }
    this.#pending.clear()
  }
}

function clamp(value, lo, hi) {
  const n = Number(value)
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, Math.round(n)))
}
