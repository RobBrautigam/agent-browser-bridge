/**
 * The recorded yes behind a password: reading an account-word receipt.
 *
 * A fill or key press into a password or one-time-code field is refused unless
 * the call carries a RECEIPT: the path of a drop file in which the person who
 * owns these browsers gave their word for an account on that site. The rule is
 * that no agent opens an account, or types a password, on its own initiative;
 * with the word recorded, it may.
 *
 * The receipt is configuration of the agent's SESSION, never an argument the
 * model chooses: the MCP server reads it from its own environment
 * (BRIDGE_ACCOUNT_WORD, or the variable BRIDGE_ACCOUNT_WORD_ENV names) and
 * forwards it on browser_fill and browser_press_keys only. The broker reads the
 * file here, turns it into a grant ({file, services}, or {file, problem}), and
 * strips any grant a caller tried to send itself. The extension decides with
 * the grant, because only the page knows whether a field is a password field.
 *
 * The drop file carries a line of this shape, anywhere in it:
 *
 *     ACCOUNT WORD: <service> <anything else>
 *
 * The service is the line's first word once markup, an article and a possessive
 * are set aside ("ACCOUNT WORD: the Paywell account" names paywell), and a word
 * too general to name a service ("account", "new") names none. A service with a
 * dot is a domain and covers its subdomains; one without is a brand and covers
 * only its .com (the contract's serviceNamesHost is the rule).
 *
 * Only files inside ONE folder are read, named in `account-word.json` beside the
 * broker's state:
 *
 *     { "folder": "<absolute path>", "ignoreWords": ["<words that are never a service>"] }
 *
 * No folder configured means no receipt is ever accepted, which is the default.
 * Every problem names the receipt by its file name only: these messages reach
 * the model, and a path on this machine is none of its business.
 */

import fs from 'node:fs'
import path from 'node:path'

import { BASE_DIR } from './paths.mjs'

export const ACCOUNT_WORD_SETTINGS_FILE = path.join(BASE_DIR, 'account-word.json')

/** The longest receipt path accepted, in characters. */
const RECEIPT_PATH_MAX = 1_024
/** The largest drop file read, in bytes. */
const RECEIPT_BYTES_MAX = 256 * 1024

const WORD_LINE = /^[\s>*_`-]*ACCOUNT\s+WORD\s*\**\s*:\s*\**\s*(.+)$/gm
const LEADING = /^(?:(?:the|a|an|one|new|his|her|their|my|our|your|[\p{L}\p{N}_-]+['’]s)\s+)+/iu
const NOT_A_SERVICE = Object.freeze([
  'the', 'a', 'an', 'one', 'new', 'his', 'her', 'their', 'my', 'our', 'your',
  'account', 'accounts', 'login', 'logins', 'developer', 'for', 'on', 'at', 'to', 'and', 'of', 'in',
  'app', 'api', 'service', 'yes', 'ok',
])

/**
 * The service an ACCOUNT WORD line names, or '' when its first word is too
 * general to name one.
 *
 * @param {string} what  the text after "ACCOUNT WORD:"
 * @param {{ignoreWords?: string[]}} [opts]
 */
export function serviceOf(what, { ignoreWords = [] } = {}) {
  let w = String(what || '').replace(/[*_`]/g, '').trim()
  w = `${w} `.replace(LEADING, '').trim()
  const m = /^[\p{L}\p{N}&.-]+/u.exec(w)
  const s = m ? m[0].replace(/\.+$/, '').toLowerCase() : ''
  const ignore = new Set([...NOT_A_SERVICE, ...(Array.isArray(ignoreWords) ? ignoreWords : []).map((x) => String(x).toLowerCase())])
  return s.length < 2 || ignore.has(s) ? '' : s
}

/** The settings, read on every call so a change needs no broker restart. */
export function loadAccountWordSettings(file = ACCOUNT_WORD_SETTINGS_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return {
      folder: typeof raw?.folder === 'string' && raw.folder.trim() ? raw.folder.trim() : null,
      ignoreWords: Array.isArray(raw?.ignoreWords) ? raw.ignoreWords.filter((w) => typeof w === 'string') : [],
    }
  } catch {
    return { folder: null, ignoreWords: [] }
  }
}

function sameCase(p) {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

function isInside(folder, file) {
  const rel = path.relative(sameCase(folder), sameCase(file))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Read one receipt into a grant.
 *
 * @param {string} receipt  a path, absolute or relative to the folder
 * @param {{folder?: string|null, ignoreWords?: string[]}} [settings]
 * @returns {{file: string, services: string[]} | {file: string, problem: string}}
 */
export function readAccountWord(receipt, settings = loadAccountWordSettings()) {
  const raw = typeof receipt === 'string' ? receipt : ''
  if (!raw || raw.length > RECEIPT_PATH_MAX || raw.includes('\u0000')) {
    return { file: 'the receipt', problem: 'the receipt is not a usable path.' }
  }
  const file = path.basename(raw)
  const problem = (text) => ({ file, problem: text })

  const folder = settings && typeof settings.folder === 'string' && settings.folder ? settings.folder : null
  if (!folder) {
    return problem('no account-word folder is configured (account-word.json beside the broker\'s state), so no receipt is accepted.')
  }
  if (path.extname(file).toLowerCase() !== '.md') return problem('a receipt is a drop file, a .md file.')

  let folderReal
  try {
    folderReal = fs.realpathSync.native(path.resolve(folder))
  } catch {
    return problem('the configured account-word folder does not exist.')
  }

  const wanted = path.resolve(path.isAbsolute(raw) ? raw : path.join(folder, raw))
  if (!isInside(path.resolve(folder), wanted) && !isInside(folderReal, wanted)) {
    return problem('it is outside the account-word folder, and only that folder is read.')
  }
  let real
  try {
    real = fs.realpathSync.native(wanted)
  } catch {
    return problem('it does not exist.')
  }
  // Checked again on the real path, so a link inside the folder cannot point out of it.
  if (!isInside(folderReal, real)) return problem('it is outside the account-word folder, and only that folder is read.')

  let stat
  try {
    stat = fs.statSync(real)
  } catch {
    return problem('it does not exist.')
  }
  if (!stat.isFile()) return problem('it is not a file.')
  if (stat.size > RECEIPT_BYTES_MAX) return problem('it is too large to be a drop file.')

  let body
  try {
    body = fs.readFileSync(real, 'utf8')
  } catch {
    return problem('it could not be read.')
  }
  const ignoreWords = settings.ignoreWords || []
  const services = [...new Set([...body.matchAll(WORD_LINE)].map((m) => serviceOf(m[1], { ignoreWords })).filter(Boolean))]
  if (services.length === 0) return problem('it carries no ACCOUNT WORD line naming a service.')
  return { file, services }
}
