/**
 * Wire framing.
 *
 * ONE codec for all three hops:
 *   extension <-> host      (Chrome native messaging, over the host's stdio)
 *   host      <-> broker    (Windows named pipe)
 *   mcp       <-> broker    (Windows named pipe)
 *
 * Format: 4-byte unsigned length prefix in NATIVE byte order, then that many
 * bytes of UTF-8 JSON. Chrome's native messaging spec fixes this format on the
 * stdio hop; we reuse it on the pipe hops so there is exactly one framing
 * implementation in the codebase and a relay can forward bytes untouched.
 *
 * Native byte order on every machine this targets (Windows x64, arm64) is
 * little-endian. We assert it rather than assume it.
 */

import os from 'node:os'

if (os.endianness() !== 'LE') {
  throw new Error(
    `The framing codec assumes a little-endian host; this machine reports ${os.endianness()}. ` +
      'Chrome native messaging uses native byte order, so the prefix codec must be revisited.'
  )
}

/**
 * Hard ceiling on a single frame we are willing to decode.
 *
 * Chromium's own limits are asymmetric and both are documented in DESIGN.md:
 *   host -> browser   1 MiB   (kMaximumNativeMessageSize, enforced on read)
 *   browser -> host   64 MiB  (kMaxMessageBytes)
 * We accept up to the larger of the two so a screenshot travelling
 * browser -> host -> broker -> mcp crosses in one frame, and we refuse
 * anything beyond it so a corrupt length prefix cannot make us allocate
 * unbounded memory.
 */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024

/** Chromium's cap on the host -> browser direction. Command bodies must stay under this. */
export const MAX_TO_BROWSER_BYTES = 1024 * 1024

/** Body size above which a host -> browser payload must be chunked. Half the cap, for JSON overhead. */
export const CHUNK_THRESHOLD_BYTES = 512 * 1024

/**
 * Encode one message as a length-prefixed frame.
 * @param {unknown} msg JSON-serializable message
 * @returns {Buffer}
 */
export function encodeFrame(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  if (body.length > MAX_FRAME_BYTES) {
    throw new FrameTooLargeError(body.length, MAX_FRAME_BYTES)
  }
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body], 4 + body.length)
}

export class FrameTooLargeError extends Error {
  constructor(size, max) {
    super(`Frame of ${size} bytes exceeds the ${max}-byte ceiling`)
    this.name = 'FrameTooLargeError'
    this.size = size
    this.max = max
  }
}

export class FrameDecodeError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'FrameDecodeError'
    this.cause = cause
  }
}

/**
 * Streaming decoder. Feed it whatever chunks arrive off a socket or stdin;
 * it emits whole messages in order.
 *
 * Deliberately NOT an EventEmitter: push() returns the messages it completed,
 * so callers cannot miss one by attaching a listener late.
 */
export class FrameDecoder {
  #buf = Buffer.alloc(0)
  #max

  constructor({ max = MAX_FRAME_BYTES } = {}) {
    this.#max = max
  }

  /**
   * @param {Buffer} chunk
   * @returns {unknown[]} every message completed by this chunk, in order
   * @throws {FrameTooLargeError|FrameDecodeError}
   */
  push(chunk) {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk])
    const out = []

    for (;;) {
      if (this.#buf.length < 4) break
      const len = this.#buf.readUInt32LE(0)

      if (len > this.#max) {
        // Do not try to resynchronize. A bad length means the stream is no
        // longer trustworthy, and guessing where the next frame starts is how
        // a relay silently corrupts a session.
        throw new FrameTooLargeError(len, this.#max)
      }
      if (this.#buf.length < 4 + len) break

      const body = this.#buf.subarray(4, 4 + len)
      this.#buf = this.#buf.subarray(4 + len)

      let msg
      try {
        msg = JSON.parse(body.toString('utf8'))
      } catch (err) {
        throw new FrameDecodeError(`Frame body is not valid JSON (${len} bytes)`, err)
      }
      out.push(msg)
    }

    return out
  }

  /** Bytes buffered but not yet forming a whole frame. Used by liveness checks. */
  get pending() {
    return this.#buf.length
  }
}

/**
 * Write a framed message to a stream, honoring backpressure.
 * @param {import('node:stream').Writable} stream
 * @param {unknown} msg
 * @returns {boolean} false when the stream asked us to wait for 'drain'
 */
export function writeFrame(stream, msg) {
  return stream.write(encodeFrame(msg))
}
