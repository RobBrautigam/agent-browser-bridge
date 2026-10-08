/**
 * The broker's half of the guarded upload: the folder rail and the audit rail,
 * in that order after the arm rail (bridged/policy.mjs checkTierAccess) has
 * already passed.
 *
 * Kept apart from bridged/index.mjs so the rails can be tested without a
 * socket: the function takes the caller's arguments and answers either a
 * refusal that names its rail or the arguments that go on to the extension.
 *
 * What goes on is bytes the broker read itself, under bare file names. The
 * caller's `paths` never travel, and a `files` payload the caller sent is
 * thrown away first: the only bytes an upload can carry are bytes read from the
 * upload folder, under the names the audit line records.
 */

import { ERR, UPLOAD_LIMITS, UPLOAD_RAIL } from '../shared/protocol.mjs'
import { displayName, loadUploadSettings, readUploadFiles } from '../shared/upload-folder.mjs'

/**
 * @param {object} opts
 * @param {object} opts.args            the request's arguments, tab handle already resolved
 * @param {{folder?: string|null}} [opts.settings]
 * @param {boolean} opts.auditWritable  whether the audit log can take a line right now
 * @param {object} [opts.limits]
 * @returns {{ok: true, args: object, audit: {files: Array<{name:string, bytes:number}>}}
 *         | {ok: false, code: string, rail: string, message: string, audit: {files: Array<{name:string}>}}}
 */
export function prepareUpload({ args, settings = loadUploadSettings(), auditWritable, limits = UPLOAD_LIMITS }) {
  const { paths, files: _forged, ...rest } = args && typeof args === 'object' ? args : {}
  const requested = Array.isArray(paths) ? paths : []
  const named = { files: requested.slice(0, limits.MAX_FILES).map((p) => ({ name: displayName(p) })) }

  // The audit rail first: an upload that could not be recorded does not go
  // out, so this is checked before any file is opened.
  if (!auditWritable) {
    return {
      ok: false,
      code: ERR.UPLOAD_REFUSED,
      rail: UPLOAD_RAIL.AUDIT,
      message:
        'The audit rail refused this upload: the bridge\'s audit log cannot be written right now, and no upload goes out without its line. Check the disk and the state folder, then retry.',
      audit: named,
    }
  }

  const read = readUploadFiles(requested, settings, limits)
  if (read.problem) {
    return { ok: false, code: ERR.UPLOAD_REFUSED, rail: UPLOAD_RAIL.FOLDER, message: read.problem, audit: named }
  }

  return {
    ok: true,
    args: {
      ...rest,
      files: read.files.map((f) => ({
        name: f.name,
        type: f.type,
        lastModified: f.lastModified,
        data: f.data.toString('base64'),
      })),
    },
    audit: { files: read.files.map((f) => ({ name: f.name, bytes: f.bytes })) },
  }
}
