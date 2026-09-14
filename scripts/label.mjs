#!/usr/bin/env node
/**
 * label - the board's rename, from the command line.
 *
 *   node scripts/label.mjs <current label> <new label>
 *
 * Renames one connected line to a custom label. A custom label is the one
 * thing the collision rules never touch: when two profiles derive the same
 * name, NOBODY keeps the bare one and both get a directory suffix
 * (bridged/routes.mjs), so the way to keep a name stable for the skills and
 * scripts that address it is to pin it as custom. Pinning the name a line
 * already derived is therefore a real change, not a no-op.
 *
 * Refuses before sending anything when the current label does not exist,
 * when the new label breaks the broker's rule (1 to 32 lowercase letters,
 * digits and hyphens, starting with a letter or digit), or when another
 * connected line already holds the new label. The broker refuses the last two
 * as well; refusing here names the holder before a request is made.
 *
 * Same agent-role connection as scripts/claim.mjs; SET_LABEL is in BROKER_OPS.
 * Every open tab handle for the line is invalidated by a rename, on purpose:
 * a handle carries the label it was minted under.
 */

import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { BrokerClient } from '../mcp-server/client.mjs'
import { OPS, PRODUCT_NAME } from '../shared/protocol.mjs'
import { findLine } from './claim.mjs'

/** The broker's rule for a custom label (bridged/index.mjs setLabel), checked here first. */
export function validLabel(label) {
  return typeof label === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(label)
}

/**
 * @param {string[]} argv
 * @returns {{mode: 'rename', label: string, newLabel: string} | {mode: 'usage', message: string}}
 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : []
  const flag = args.find((a) => typeof a === 'string' && a.startsWith('--'))
  if (flag) return { mode: 'usage', message: `Unknown flag ${flag}.` }
  if (args.length !== 2) return { mode: 'usage', message: 'Expected a current label and a new label.' }
  return { mode: 'rename', label: args[0], newLabel: args[1] }
}

/**
 * Read the board, refuse anything that is off, send one SET_LABEL, and check
 * the answer carries the new label.
 *
 * @param {{client: {request: Function}, label: string, newLabel: string}} spec
 * @returns {Promise<{ok: true, line: object, unchanged?: boolean} | {ok: false, message: string}>}
 */
export async function rename({ client, label, newLabel }) {
  if (!validLabel(newLabel)) {
    return {
      ok: false,
      message:
        `"${newLabel}" is not a valid label. A label is 1 to 32 characters of lowercase letters, ` +
        'digits and hyphens, starting with a letter or digit.',
    }
  }

  let board
  try {
    board = await client.request({ op: OPS.GET_BOARD })
  } catch (err) {
    return { ok: false, message: describeError(err) }
  }

  const found = findLine(board?.lines, label)
  if (!found.ok) return found
  const line = found.line

  if (line.label === newLabel && line.labelIsCustom === true) {
    return { ok: true, line, unchanged: true }
  }

  const holder = (Array.isArray(board?.lines) ? board.lines : []).find(
    (l) => l && l.installId !== line.installId && (l.label === newLabel || l.desiredLabel === newLabel)
  )
  if (holder) {
    return {
      ok: false,
      message:
        `"${newLabel}" is already held by ${holder.vendorLabel || holder.vendor} ${holder.profileDir || '(unclaimed)'} ` +
        `(currently "${holder.label}"). Rename that line first, or pick another name.`,
    }
  }

  let result
  try {
    result = await client.request({ op: OPS.SET_LABEL, profile: label, args: { label: newLabel } })
  } catch (err) {
    return { ok: false, message: describeError(err) }
  }

  const after = result?.line
  if (!after || after.label !== newLabel) {
    return {
      ok: false,
      message:
        `The broker answered, but the line is now ${after ? `"${after.label}"` : 'missing from the reply'}, ` +
        `not "${newLabel}". Run node scripts/claim.mjs to list what it is.`,
    }
  }
  return { ok: true, line: after }
}

function describeError(err) {
  const code = err && typeof err.code === 'string' ? `${err.code}: ` : ''
  return `${code}${err?.message || String(err)}`
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

const USAGE =
  `${PRODUCT_NAME} label\n` +
  '\n' +
  '  node scripts/label.mjs <current label> <new label>   rename one connected line to a custom label\n' +
  '\n' +
  'Labels are 1 to 32 lowercase letters, digits and hyphens. A custom label survives collisions;\n' +
  'a derived one does not. Every open tab handle for the line is invalidated by a rename.'

async function main(argv) {
  const parsed = parseArgs(argv)
  if (parsed.mode === 'usage') {
    console.error(parsed.message)
    console.error('')
    console.error(USAGE)
    return 2
  }

  // See scripts/claim.mjs: the client unrefs its socket, so hold the loop open.
  const keepAlive = setInterval(() => {}, 1_000)
  const client = new BrokerClient({ onLog: () => {} })
  try {
    const r = await rename({ client, label: parsed.label, newLabel: parsed.newLabel })
    if (!r.ok) {
      console.error(r.message)
      return 1
    }
    if (r.unchanged) {
      console.log(`"${r.line.label}" is already a custom label on ${r.line.vendorLabel || r.line.vendor} "${r.line.profileDir}". Nothing to do.`)
      return 0
    }
    console.log(
      `Renamed. "${parsed.label}" is now "${r.line.label}" (custom, pinned) on ` +
        `${r.line.vendorLabel || r.line.vendor} directory "${r.line.profileDir}". Open tab handles for it are invalid; list tabs again.`
    )
    return 0
  } finally {
    clearInterval(keepAlive)
    client.close()
  }
}

function isMain(metaUrl) {
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
