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
 * The new label is checked against the contract's LABEL_PATTERN before
 * anything is sent; everything else (a name held by another line, connected
 * or not) is the broker's decision, and its typed refusal names the holder,
 * so it is rendered rather than second-guessed here.
 *
 * Same agent-role connection as scripts/claim.mjs, and the same install-id
 * addressing for the second round trip, so the rename lands on the line the
 * operator looked at even if the board re-resolved a collision in between.
 * Every open tab handle for the line is invalidated by a rename, on purpose:
 * a handle carries the label it was minted under.
 */

import { LABEL_PATTERN, OPS, PRODUCT_NAME } from '../shared/protocol.mjs'
import { CLI_TIMEOUT_MS, describeError, findLine, getBoard, isMain, notConnected, withBroker } from './claim.mjs'

/** The broker's rule for a custom label, from the shared contract. */
export function validLabel(label) {
  return typeof label === 'string' && LABEL_PATTERN.test(label)
}

/**
 * @param {string[]} argv
 * @returns {{mode: 'rename', label: string, newLabel: string} | {mode: 'usage', message: string}}
 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : []
  const flag = args.find((a) => typeof a === 'string' && a.startsWith('--'))
  if (flag) return { mode: 'usage', message: flag === '--help' ? '' : `Unknown flag ${flag}.` }
  if (args.length !== 2) return { mode: 'usage', message: 'Expected a current label and a new label.' }
  return { mode: 'rename', label: args[0], newLabel: args[1] }
}

/**
 * Read the board, refuse a malformed label, send one SET_LABEL addressed by
 * install id, and check the answer is the same line under the new name.
 *
 * @param {{client: {request: Function}, label: string, newLabel: string}} spec
 * @returns {Promise<{ok: true, line: object, unchanged?: boolean} | {ok: false, message: string}>}
 */
export async function rename({ client, label, newLabel: requested }) {
  // The broker trims before it checks; do the same so a pasted trailing
  // space is not reported as a malformed name.
  const newLabel = typeof requested === 'string' ? requested.trim() : ''
  if (!validLabel(newLabel)) {
    return {
      ok: false,
      message:
        `"${requested}" is not a valid label. A label is 1 to 32 characters of lowercase letters, ` +
        'digits and hyphens, starting with a letter or digit.',
    }
  }

  let board
  try {
    board = await getBoard(client)
  } catch (err) {
    return { ok: false, message: describeError(err) }
  }

  const found = findLine(board?.lines, label)
  if (!found.ok) return found
  const line = found.line

  // The broker only routes to live lines; an absent one would come back as
  // "unknown profile", which is the wrong diagnosis for a closed browser.
  if (line.present === false) return { ok: false, message: notConnected(line) }

  // Already pinned under that exact name: sending it again would only bump
  // the generation and invalidate every open tab handle for nothing.
  if (line.label === newLabel && line.labelIsCustom === true) {
    return { ok: true, line, unchanged: true }
  }

  let result
  try {
    result = await client.request({
      op: OPS.SET_LABEL,
      profile: line.installId,
      args: { label: newLabel },
      timeoutMs: CLI_TIMEOUT_MS,
    })
  } catch (err) {
    return { ok: false, message: describeError(err) }
  }

  const after = result?.line
  if (!after || after.installId !== line.installId || after.label !== newLabel) {
    return {
      ok: false,
      message:
        `The broker answered, but the line is now ${after ? `"${after.label}"` : 'missing from the reply'}, ` +
        `not the line that was addressed under "${newLabel}". Run node scripts/claim.mjs to list what it is.`,
    }
  }
  return { ok: true, line: after }
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
    if (parsed.message) console.error(parsed.message, '\n')
    console.error(USAGE)
    return 2
  }

  return withBroker(async (client) => {
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
  })
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
