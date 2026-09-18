#!/usr/bin/env node
/**
 * open-or-focus - put a page in front of a human, from the command line.
 *
 *   node scripts/open-or-focus.mjs <profile label> <url or file path>
 *
 * The same capability the MCP tool browser_open_or_focus exposes, reachable
 * without an MCP client at all. That is the point of this file: the thing that
 * opens a page for a person is usually a shell script, a launcher or a hook,
 * none of which speaks JSON-RPC, and telling those callers to start an agent
 * session first would be absurd. Same broker, same operation, same one-line
 * answer on stdout.
 *
 * It prints exactly one line, which is what a launcher can show a human, and
 * exits 0 only when the page is on screen. Anything else exits non-zero with
 * the reason on stderr, so a caller can fall back to its own opener and say so.
 *
 * Flags:
 *   --match-file-name   also match the same file name under a different folder
 *   --activate          bring the tab and its window to the front
 *   --socket <path>     dial a different broker endpoint (see below)
 *
 * `--socket` exists so a caller can PROVE its broker-unreachable fallback by
 * pointing at an endpoint nothing listens on. Testing that path by stopping the
 * real broker would take every other live agent session's browsers down with
 * it, which is not a trade a test gets to make.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { OPS, PRODUCT_NAME } from '../shared/protocol.mjs'
import { CLI_TIMEOUT_MS, describeError, isMain, withBroker } from './claim.mjs'

/**
 * A page this operation can open, as an absolute URL.
 *
 * A caller hands over whatever it has: a real URL, a Windows path, a relative
 * path. Anything with a scheme passes through untouched; anything else is
 * resolved against the working directory and turned into a file: URL, which is
 * also what percent-encodes the spaces that every "My Documents" path carries
 * and that would otherwise arrive as a malformed address.
 *
 * @param {string} target
 * @returns {{ok: true, url: string} | {ok: false, message: string}}
 */
export function toUrl(target) {
  const raw = typeof target === 'string' ? target.trim() : ''
  if (raw === '') return { ok: false, message: 'A URL or a file path is required.' }

  // A Windows drive letter (C:\... or C:/...) parses as a URL with scheme "c:",
  // so it has to be recognized as a PATH before the scheme test, or every local
  // file on Windows would be sent as an unopenable address.
  const isWindowsPath = /^[a-zA-Z]:[\\/]/.test(raw)
  if (!isWindowsPath && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return { ok: true, url: raw }

  const absolute = path.resolve(raw)
  if (!fs.existsSync(absolute)) {
    return {
      ok: false,
      message: `No file at ${absolute}, and "${raw}" is not a URL either, so there is nothing to open.`,
    }
  }
  return { ok: true, url: pathToFileURL(absolute).href }
}

/**
 * @param {string[]} argv
 * @returns {{mode:'open',profile:string,target:string,matchFileName:boolean,activate:boolean,socket:string|undefined}
 *          |{mode:'usage',message:string}}
 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : []
  let matchFileName = false
  let activate = false
  let socket
  const positional = []

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--match-file-name') matchFileName = true
    else if (arg === '--activate') activate = true
    else if (arg === '--socket') {
      socket = args[i + 1]
      i += 1
      if (typeof socket !== 'string' || socket === '') {
        return { mode: 'usage', message: '--socket needs an endpoint after it.' }
      }
    } else if (arg === '--help') return { mode: 'usage', message: '' }
    else if (typeof arg === 'string' && arg.startsWith('--')) {
      return { mode: 'usage', message: `Unknown flag ${arg}.` }
    } else positional.push(arg)
  }

  if (positional.length !== 2) {
    return { mode: 'usage', message: 'Expected a profile label and a URL or file path.' }
  }
  return {
    mode: 'open',
    profile: positional[0],
    target: positional[1],
    matchFileName,
    activate,
    socket,
  }
}

/**
 * Send the operation and render its own one-line answer.
 *
 * The summary comes from the extension, built by describeOpenOrFocus in the
 * contract, so the launcher, the MCP tool and the audit of what happened all
 * say the same sentence about the same action rather than three paraphrases.
 *
 * @param {{client:{request:Function}, profile:string, url:string, matchFileName?:boolean, activate?:boolean}} spec
 * @returns {Promise<{ok:true,line:string,result:object}|{ok:false,message:string}>}
 */
export async function openOrFocus({ client, profile, url, matchFileName = false, activate = false }) {
  let result
  try {
    result = await client.request({
      op: OPS.OPEN_OR_FOCUS,
      profile,
      args: { url, matchFileName, activate },
      timeoutMs: CLI_TIMEOUT_MS,
    })
  } catch (err) {
    return { ok: false, message: describeError(err) }
  }
  const summary = typeof result?.summary === 'string' && result.summary ? result.summary : null
  if (!summary) {
    return {
      ok: false,
      message:
        'The broker answered without saying what it did, which means the extension in that profile is ' +
        'older than this command. Reload it from the browser\'s extensions page and try again.',
    }
  }
  return { ok: true, line: `${profile}: ${summary}`, result }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

const USAGE =
  `${PRODUCT_NAME} open-or-focus\n` +
  '\n' +
  '  node scripts/open-or-focus.mjs <profile label> <url or file path>\n' +
  '\n' +
  '  --match-file-name   also reuse a tab showing the same file name in a different folder\n' +
  '  --activate          bring the tab and its window to the front (off by default)\n' +
  '  --socket <path>     dial a different broker endpoint\n' +
  '\n' +
  'Reuses the tab already showing the page, reloads it and moves it to the far right of its\n' +
  'window; opens a new tab at the far right when there is none. Local files must be .html or .htm.'

async function main(argv) {
  const parsed = parseArgs(argv)
  if (parsed.mode === 'usage') {
    if (parsed.message) console.error(parsed.message, '\n')
    console.error(USAGE)
    return 2
  }

  const target = toUrl(parsed.target)
  if (!target.ok) {
    console.error(target.message)
    return 1
  }

  return withBroker(
    async (client) => {
      const r = await openOrFocus({
        client,
        profile: parsed.profile,
        url: target.url,
        matchFileName: parsed.matchFileName,
        activate: parsed.activate,
      })
      if (!r.ok) {
        console.error(r.message)
        return 1
      }
      console.log(r.line)
      return 0
    },
    { socketPath: parsed.socket }
  )
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (err) => {
      console.error(describeError(err))
      process.exitCode = 1
    }
  )
}
