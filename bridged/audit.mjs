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
 * values, no selectors, no arguments. The one addition is an upload's line,
 * which names its tab handle and each file by its bare name and size: what left
 * this machine, and through which tab, is the point of auditing it. Never a
 * path, and never the file's contents.
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
/** A receipt is recorded by its file name only, and only a name of this shape. */
const RECEIPT_RE = /^[\w .()-]{1,120}\.md$/i
/** An upload's tab is recorded as its opaque handle, and only a handle of this shape. */
const TAB_HANDLE_RE = /^tab_[a-z0-9-]{1,40}_\d{1,9}_\d{1,12}$/
/**
 * An uploaded file is recorded by its bare name: no separator (so never a path),
 * no control character, nothing that walks up. Its size is a whole number of bytes.
 */
const UPLOAD_NAME_RE = /^(?!\.{1,2}$)[^\\/\u0000-\u001f\u007f]{1,120}$/
const UPLOAD_FILES_MAX = 10

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
   * @param {string|null} [entry.receipt] the account-word receipt's FILE NAME a
   *   password-field call carried; written only when present, and never a path
   *   or anything the file says
   * @param {string|null} [entry.tab]   an upload's tab HANDLE; written only when it is one
   * @param {Array<{name:string, bytes?:number}>|null} [entry.files] an upload's files by bare
   *   name and size; a name that is a path, or carries a control character, is dropped
   * @param {number} [entry.at]
   */
  record({ profile = null, op, url = null, ok = true, ms = null, err = null, receipt = null, tab = null, files = null, at = Date.now() }) {
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
    if (typeof receipt === 'string' && RECEIPT_RE.test(receipt)) entry.receipt = receipt
    // The upload's line: which tab, which files and how big. Names only, never a
    // path, so the log says what left without saying where it lives.
    if (typeof tab === 'string' && TAB_HANDLE_RE.test(tab)) entry.tab = tab
    if (Array.isArray(files)) {
      entry.files = files
        .slice(0, UPLOAD_FILES_MAX)
        .filter((f) => f && typeof f.name === 'string' && UPLOAD_NAME_RE.test(f.name))
        .map((f) => (Number.isSafeInteger(f.bytes) && f.bytes >= 0 ? { name: f.name, bytes: f.bytes } : { name: f.name }))
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

  /**
   * Whether a line could be appended right now, without writing one.
   *
   * The upload's audit rail: a failed write never fails the operation it
   * describes (#append), so an upload asks first, and is refused when the log
   * cannot take its line. Opening for append and closing again proves the
   * folder and the file accept a write at this moment.
   */
  canWrite() {
    let fd = null
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true })
      fd = fs.openSync(this.#file, 'a')
      return true
    } catch {
      return false
    } finally {
      if (fd != null) {
        try {
          fs.closeSync(fd)
        } catch {
          /* a descriptor that will not close is the next write's problem */
        }
      }
    }
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
      this.#size = sizeOf(this.#file)
    } catch {
      // If the rotate fails the log simply keeps growing, which is strictly
      // better than dropping entries. Reset the counter rather than re-reading
      // the real size: renameSync fails on Windows whenever another process
      // holds the file open (a tail, an editor), and re-reading the size would
      // put the next write straight back over the threshold, retrying the
      // rename on every single record. Backing off by one rotation window
      // self-heals once the holder lets go.
      this.#size = 0
    }
  }
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}
