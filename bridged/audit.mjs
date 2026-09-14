/**
 * The audit log.
 *
 * One JSON object per line, appended, never rewritten. This file is the record
 * the operator reads when they want to know what a Claude Code session actually did
 * inside their real, logged-in browsers, so it is written synchronously and in
 * order: an audit line that lands after the crash it was supposed to explain
 * is worth nothing. Volume is human-scale - a handful of operations a second
 * at the absolute most - so the blocking write costs nothing measurable and
 * buys strict ordering.
 *
 * REDACTION IS THE WHOLE POINT OF THIS MODULE.
 *
 *   - Only the ORIGIN of a URL is ever recorded: scheme, host, port. Password
 *     reset and magic-link tokens live in the PATH at least as often as the
 *     query (`/reset/<token>`, `/invite/<token>`), so writing a path here
 *     would copy single-use credentials into a plaintext file that outlives
 *     the link.
 *   - The error field is restricted to a typed `E_*` code by regex. Free-form
 *     error text is exactly where a full URL, a selector containing page data,
 *     or a filesystem path leaks back in, and an allowlist is the only way to
 *     be sure it cannot.
 *
 * Nothing else about an operation is recorded. No page content, no form
 * values, no selectors, no arguments.
 */

import fs from 'node:fs'
import path from 'node:path'

import { AUDIT_FILE } from '../shared/paths.mjs'
import { originOf } from '../shared/protocol.mjs'

/** Rotate at 5 MB into a single `.1` sibling. One generation is enough to cover a session. */
export const AUDIT_ROTATE_BYTES = 5 * 1024 * 1024

/**
 * The only shape an error may take in the log. Anything that is not a typed
 * code is dropped rather than truncated, because a truncated URL is still a URL.
 */
const ERR_CODE_RE = /^E_[A-Z0-9_]{1,40}$/

export class AuditLog {
  #file
  #rotateBytes
  #size
  #ring = []
  #ringMax
  #onError

  /**
   * @param {object}   [opts]
   * @param {string}   [opts.file]        target file, defaults to the standard AUDIT_FILE
   * @param {number}   [opts.rotateBytes] size at which to roll over
   * @param {number}   [opts.ringMax]     how many recent entries to keep in memory for the board
   * @param {Function} [opts.onError]     called when a write fails, so the broker can log it
   */
  constructor({ file = AUDIT_FILE, rotateBytes = AUDIT_ROTATE_BYTES, ringMax = 50, onError } = {}) {
    this.#file = file
    this.#rotateBytes = rotateBytes
    this.#ringMax = ringMax
    this.#onError = onError
    this.#size = sizeOf(file)
  }

  /**
   * Record one operation.
   *
   * Takes a raw `url` and redacts it through the contract's originOf() rather
   * than accepting a pre-computed origin, so there is exactly one place in the
   * codebase that decides what a URL is allowed to become. This module used to
   * carry a local wrapper that rewrote the WHATWG parser's opaque-origin
   * output - the literal string "null" for chrome://, about:, data: and file: -
   * into something that does not read as a bug next to real JSON nulls. Two
   * consumers had independently grown the same workaround, so originOf() does
   * it now and the local copy is gone.
   *
   * @param {object} entry
   * @param {string|null} entry.profile  route label, or null for broker-wide events
   * @param {string} entry.op
   * @param {string|null} [entry.url]    redacted to its origin before it is stored
   * @param {boolean} [entry.ok]
   * @param {number|null} [entry.ms]     round trip in milliseconds
   * @param {string|null} [entry.err]    a typed E_* code, anything else is dropped
   * @param {number} [entry.at]
   */
  record({ profile = null, op, url = null, ok = true, ms = null, err = null, at = Date.now() }) {
    const code = err == null ? null : String(err)
    const entry = {
      at,
      profile: profile == null ? null : String(profile),
      op: String(op),
      origin: url ? originOf(url) : null,
      ok: Boolean(ok),
      ms: Number.isFinite(ms) ? Math.round(ms) : null,
      err: code && ERR_CODE_RE.test(code) ? code : null,
    }

    this.#ring.push(entry)
    if (this.#ring.length > this.#ringMax) this.#ring.shift()
    this.#append(entry)
    return entry
  }

  /**
   * The last `n` entries in the shape the board contract declares. Deliberately
   * a different, narrower projection than what goes to disk: `ms` and `err`
   * are operational detail, not something a status panel needs.
   */
  recent(n = 10) {
    return this.#ring
      .slice(-n)
      .map(({ at, profile, op, origin, ok }) => ({ at, profile, op, origin, ok }))
  }

  /** Bytes currently in the live log file. Exposed for the doctor script. */
  get size() {
    return this.#size
  }

  get file() {
    return this.#file
  }

  #append(entry) {
    const line = JSON.stringify(entry) + '\n'
    const bytes = Buffer.byteLength(line, 'utf8')
    try {
      if (this.#size + bytes > this.#rotateBytes) this.#rotate()
      fs.mkdirSync(path.dirname(this.#file), { recursive: true })
      fs.appendFileSync(this.#file, line, 'utf8')
      this.#size += bytes
    } catch (err) {
      // A failed audit write must never fail the operation it was describing,
      // but it must never be silent either: the broker logs it.
      this.#onError?.(err)
    }
  }

  #rotate() {
    const prev = `${this.#file}.1`
    try {
      // Windows rename refuses an existing destination, so the previous
      // generation is removed first. Losing generation 2 is intentional.
      fs.rmSync(prev, { force: true })
      fs.renameSync(this.#file, prev)
    } catch {
      // If the rotate fails the log simply keeps growing, which is strictly
      // better than dropping entries.
    }
    this.#size = sizeOf(this.#file)
  }
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}
