/**
 * The folder rail: the only place an upload's bytes come from.
 *
 * An upload sets a page's file input from a file on this machine, which is the
 * one way local bytes leave through a page. A page can carry instructions for
 * the agent reading it, so the rule is not "files the agent names" but "files
 * the operator put in ONE folder for this purpose". The folder is named in
 * `upload.json` beside the broker's state, never in a tool argument:
 *
 *     { "folder": "<absolute path>" }
 *
 * No folder configured means no upload is accepted, which is the default.
 *
 * The broker is the only reader. It resolves each requested name inside the
 * folder, refuses anything whose path leaves it (a `..`, an absolute path
 * elsewhere), resolves the real path and refuses again when a junction or a
 * symlink inside the folder leads out of it, opens the file, and checks that
 * what it opened is the same regular file it checked. The extension and the
 * page receive bytes and a bare file name, never a path, so nothing outside
 * the folder is ever opened, and no path on this machine reaches the model.
 *
 * Why the broker reads instead of handing the browser a path (Chrome DevTools
 * Protocol `DOM.setFileInputFiles`): for an extension's debugger client
 * Chromium allows that call only with the extension's "Allow access to file
 * URLs" toggle on (`ExtensionDevToolsClientHost::MayReadLocalFiles`), which
 * this repository never asks for, and the browser would then read whatever path
 * it was handed. Reading here keeps the rule and the read in one process.
 */

import fs from 'node:fs'
import path from 'node:path'

import { BASE_DIR } from './paths.mjs'
import { UPLOAD_LIMITS } from './protocol.mjs'

export const UPLOAD_SETTINGS_FILE = path.join(BASE_DIR, 'upload.json')

/** The longest requested path accepted, in characters. */
const REQUEST_PATH_MAX = 1_024

const RAIL = 'The folder rail refused this upload:'

/**
 * The type a browser would give a picked file, for the common upload kinds.
 * Unknown extensions get '', which is what a browser reports for them too.
 */
const MIME = Object.freeze({
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.rtf': 'application/rtf',
})

/** The settings, read on every call so a change needs no broker restart. */
export function loadUploadSettings(file = UPLOAD_SETTINGS_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { folder: typeof raw?.folder === 'string' && raw.folder.trim() ? raw.folder.trim() : null }
  } catch {
    return { folder: null }
  }
}

function sameCase(p) {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

function isInside(folder, file) {
  const rel = path.relative(sameCase(folder), sameCase(file))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** A name fit to show the model and the log: the last segment, no control characters. */
export function displayName(requested) {
  if (typeof requested !== 'string') return 'the file'
  const base = requested.split(/[\\/]/).filter(Boolean).pop() || ''
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120)
  return clean || 'the file'
}

/**
 * Read the requested files from the upload folder, or say which rule refused.
 *
 * @param {unknown} requested  file names or paths, relative to the folder or absolute inside it
 * @param {{folder?: string|null}} [settings]
 * @param {{MAX_FILES:number, MAX_TOTAL_BYTES:number}} [limits]
 * @returns {{files: Array<{name:string, bytes:number, type:string, lastModified:number, data:Buffer}>}
 *         | {problem: string, names: string[]}}
 */
export function readUploadFiles(requested, settings = loadUploadSettings(), limits = UPLOAD_LIMITS) {
  const list = Array.isArray(requested) ? requested : []
  const names = list.map(displayName)
  const refuse = (text) => ({ problem: `${RAIL} ${text}`, names })

  if (list.length === 0) return refuse('name at least one file to upload.')
  if (list.length > limits.MAX_FILES) return refuse(`an upload takes at most ${limits.MAX_FILES} files; this asked for ${list.length}.`)

  const folder = settings && typeof settings.folder === 'string' && settings.folder ? settings.folder : null
  if (!folder) {
    return refuse(
      'no upload folder is configured, so nothing can be uploaded. The operator names one folder in upload.json beside the bridge\'s state ({"folder": "<absolute path>"}).'
    )
  }
  if (!path.isAbsolute(folder)) return refuse('the configured upload folder is not an absolute path, so it is not used.')

  let folderReal
  try {
    folderReal = fs.realpathSync.native(path.resolve(folder))
    if (!fs.statSync(folderReal).isDirectory()) return refuse('the configured upload folder is not a folder.')
  } catch {
    return refuse('the configured upload folder does not exist.')
  }

  const files = []
  let total = 0
  for (const raw of list) {
    const name = displayName(raw)
    if (typeof raw !== 'string' || !raw.trim() || raw.length > REQUEST_PATH_MAX || /[\u0000-\u001f\u007f]/.test(raw)) {
      return refuse(`"${name}" is not a usable file name.`)
    }
    const wanted = path.resolve(path.isAbsolute(raw) ? raw : path.join(folder, raw))
    // The written path first, so a `..` or a path elsewhere never reaches the disk at all.
    if (!isInside(path.resolve(folder), wanted) && !isInside(folderReal, wanted)) {
      return refuse(`${name} is outside the upload folder, and only that folder is read.`)
    }

    let real
    try {
      real = fs.realpathSync.native(wanted)
    } catch {
      return refuse(`${name} does not exist in the upload folder.`)
    }
    // Then the real path, so a junction or a symlink inside the folder cannot lead out of it.
    if (!isInside(folderReal, real)) return refuse(`${name} is outside the upload folder, and only that folder is read.`)

    let fd = null
    try {
      fd = fs.openSync(real, 'r')
      const opened = fs.fstatSync(fd)
      if (!opened.isFile()) return refuse(`${name} is not a file.`)
      // The file opened must be the file checked: a path swapped for a link
      // between the check and the open is a different file, and is refused.
      const checked = fs.statSync(fs.realpathSync.native(wanted))
      if (opened.ino !== checked.ino || opened.dev !== checked.dev || !isInside(folderReal, fs.realpathSync.native(wanted))) {
        return refuse(`${name} changed while it was being read, so it was not sent.`)
      }
      if (total + opened.size > limits.MAX_TOTAL_BYTES) {
        return refuse(`the files are too large: an upload carries at most ${limits.MAX_TOTAL_BYTES} bytes in all.`)
      }
      const data = readWhole(fd, opened.size, limits.MAX_TOTAL_BYTES - total)
      if (data == null) return refuse(`${name} grew while it was being read, past the upload limit.`)
      total += data.length
      files.push({
        name: path.basename(real),
        bytes: data.length,
        type: MIME[path.extname(real).toLowerCase()] || '',
        lastModified: Math.round(opened.mtimeMs),
        data,
      })
    } catch (err) {
      if (err && (err.code === 'EISDIR' || err.code === 'EPERM' || err.code === 'EACCES')) {
        return refuse(err.code === 'EISDIR' ? `${name} is not a file.` : `${name} could not be read.`)
      }
      return refuse(`${name} could not be read.`)
    } finally {
      if (fd != null) {
        try {
          fs.closeSync(fd)
        } catch {
          /* closing a descriptor that is already gone is not worth a refusal */
        }
      }
    }
  }
  return { files }
}

/** Read an open file to its end, or null when it holds more than `cap` bytes. */
function readWhole(fd, sizeHint, cap) {
  const chunks = []
  let total = 0
  const buf = Buffer.alloc(Math.min(Math.max(sizeHint, 1), 1024 * 1024) + 1)
  for (;;) {
    const n = fs.readSync(fd, buf, 0, buf.length, null)
    if (n === 0) break
    total += n
    if (total > cap) return null
    chunks.push(Buffer.from(buf.subarray(0, n)))
  }
  return Buffer.concat(chunks, total)
}
