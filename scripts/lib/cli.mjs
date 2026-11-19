/**
 * What the command-line scripts share: the entry-point guard and the terminal
 * colors. One copy here, so a fix lands in every script that imports it.
 *
 * Node built-ins only, so a script that imports it loads nothing else.
 */

import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Is the module at `metaUrl` the process entry point? Pass the caller's own
 * `import.meta.url`. Real paths are compared, lowercased, so a symlinked or
 * differently cased path to the same file still counts; when a path cannot be
 * resolved, the URLs are compared instead.
 */
export function isMain(metaUrl) {
  try {
    if (!process.argv[1]) return false
    return (
      fs.realpathSync(fileURLToPath(metaUrl)).toLowerCase() ===
      fs.realpathSync(process.argv[1]).toLowerCase()
    )
  } catch {
    return pathToFileURL(process.argv[1] || '').href === metaUrl
  }
}

/* ANSI colors: only on a terminal, and never when NO_COLOR is set. */
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const paint = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s)
export const bold = (s) => paint('1', s)
export const green = (s) => paint('32', s)
export const yellow = (s) => paint('33', s)
export const red = (s) => paint('31', s)
export const cyan = (s) => paint('36', s)
export const dim = (s) => paint('2', s)
