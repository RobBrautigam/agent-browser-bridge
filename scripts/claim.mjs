#!/usr/bin/env node
/**
 * claim - the options-page click, from the command line.
 *
 * Chrome profiles resolve themselves from the signed-in account. Brave writes
 * no account identity into its profile metadata, so a Brave line arrives
 * UNCLAIMED and needs a human to say which profile it is (README, step 6).
 * That is one click in the extension's options page. This script is the same
 * claim without the click, for the operator who is setting up many profiles at
 * once or driving the install from a terminal.
 *
 *   node scripts/claim.mjs                                 list every line the broker holds, with the
 *                                                          candidate directories of the unclaimed ones
 *   node scripts/claim.mjs <label> "<exact name or email>" claim that line as the one candidate whose
 *                                                          profile name or email matches EXACTLY
 *   node scripts/claim.mjs --reclaim <label> "<name>"      move a line that is already claimed to a
 *                                                          different profile directory
 *
 * The match is exact and unique, on purpose. "alice" is a substring of three
 * different mailboxes; a case-insensitive or fuzzy match would bind a line to
 * one of them silently, and a Brave line bound to the wrong mailbox is a
 * logged-in browser driven as the wrong person. So anything other than exactly
 * one exact match refuses, says how many matched, and sends nothing.
 *
 * It speaks to the broker as an agent-role connection through the same client
 * the MCP server uses, so the token, the framing and the timeouts are the
 * contract's, not a second copy. CLAIM_PROFILE is in BROKER_OPS, which is what
 * lets an agent connection originate it (shared/protocol.mjs).
 */

import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { BrokerClient } from '../mcp-server/client.mjs'
import { OPS, PRODUCT_NAME } from '../shared/protocol.mjs'

/* -------------------------------------------------------------------------- */
/* The pure halves                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Find the line the operator named. Labels are matched exactly, the same rule
 * every tool applies, so a near miss lists what does exist instead of guessing.
 *
 * @param {Array<object>} lines the board's lines, as GET_BOARD returns them
 * @param {string} label
 * @returns {{ok: true, line: object} | {ok: false, message: string}}
 */
export function findLine(lines, label) {
  const all = Array.isArray(lines) ? lines : []
  if (all.length === 0) {
    return {
      ok: false,
      message:
        'The broker is running but no profile is connected. Load the unpacked extension in a browser ' +
        'profile first (README, step 2); the line appears within a few seconds.',
    }
  }
  const line = all.find((l) => l && l.label === label)
  if (!line) {
    return {
      ok: false,
      message: `No line is labeled "${label}". Labels are matched exactly. Lines: ${all.map((l) => l.label).join(', ')}.`,
    }
  }
  return { ok: true, line }
}

/**
 * Pick the one candidate whose profile name or email is exactly `wanted`.
 *
 * @param {Array<{dir: string, name?: string, email?: string|null}>} candidates
 * @param {string} wanted
 * @returns {{ok: true, candidate: object} | {ok: false, message: string}}
 */
export function pickCandidate(candidates, wanted) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {
      ok: false,
      message:
        'This line offers no profile directories to choose between. The broker could not read the ' +
        "browser's profile list, or it could not tell which browser the line is. Reload the extension " +
        'in that profile so it re-registers, then list again.',
    }
  }
  const hits = candidates.filter((c) => c && (c.name === wanted || c.email === wanted))
  if (hits.length !== 1) {
    return {
      ok: false,
      message:
        `${hits.length} candidate(s) match "${wanted}" exactly; a claim needs exactly one. ` +
        `The match is on the full profile name or email, case-sensitive. Choices: ${describeCandidates(candidates)}.`,
    }
  }
  return { ok: true, candidate: hits[0] }
}

/**
 * Parse the command line.
 *
 * @param {string[]} argv
 * @returns {{mode: 'list'} | {mode: 'claim', label: string, wanted: string, reclaim: boolean} | {mode: 'usage', message: string}}
 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : []
  let reclaim = false
  const positional = []
  for (const a of args) {
    if (a === '--reclaim') reclaim = true
    else if (a === '--list') positional.length = 0
    else if (a.startsWith('--')) return { mode: 'usage', message: `Unknown flag ${a}.` }
    else positional.push(a)
  }
  if (positional.length === 0 && !reclaim) return { mode: 'list' }
  if (positional.length !== 2) {
    return {
      mode: 'usage',
      message: 'Expected a label and an exact profile name or email, or no arguments to list.',
    }
  }
  return { mode: 'claim', label: positional[0], wanted: positional[1], reclaim }
}

/**
 * Render the board for a human: every line, and the candidate directories of
 * the lines that still need claiming. A claimed line's candidates are not
 * choices any more, so they are left out rather than inviting a re-claim.
 *
 * @param {Array<object>} lines
 * @returns {string}
 */
export function renderBoard(lines) {
  const all = Array.isArray(lines) ? lines : []
  if (all.length === 0) {
    return 'The broker is running but no profile is connected. Load the unpacked extension in a browser profile first.'
  }
  const out = []
  for (const l of all) {
    const state = l.present === false ? 'absent' : l.link || 'unknown'
    const who = l.email || l.profileName || ''
    const mark = l.claimed ? '' : '  UNCLAIMED'
    out.push(
      `  ${String(l.label).padEnd(28)} ${String(l.vendorLabel || l.vendor || '').padEnd(7)} ${String(state).padEnd(8)} ` +
        `${String(l.profileDir ?? '?').padEnd(10)} ${who}${mark}`
    )
    if (!l.claimed) {
      const candidates = Array.isArray(l.candidates) ? l.candidates : []
      if (candidates.length === 0) {
        out.push('      (no candidate directories; reload the extension in that profile)')
      }
      for (const c of candidates) {
        out.push(`      ${String(c.dir).padEnd(11)} ${c.name || ''}${c.email ? `  (${c.email})` : ''}`)
      }
    }
  }
  out.push('')
  out.push('Claim an UNCLAIMED line with:  node scripts/claim.mjs <label> "<exact profile name or email>"')
  return out.join('\n')
}

/**
 * The claim itself: read the board, refuse anything that is not exactly one
 * exact match, send CLAIM_PROFILE, and check the answer names the directory
 * that was asked for. The broker's reply is the only proof the claim landed.
 *
 * @param {{client: {request: Function}, label: string, wanted: string, reclaim?: boolean}} spec
 * @returns {Promise<{ok: true, line: object, unchanged?: boolean} | {ok: false, message: string}>}
 */
export async function claim({ client, label, wanted, reclaim = false }) {
  let board
  try {
    board = await client.request({ op: OPS.GET_BOARD })
  } catch (err) {
    return { ok: false, message: describeError(err) }
  }

  const found = findLine(board?.lines, label)
  if (!found.ok) return found
  const line = found.line

  const picked = pickCandidate(line.candidates, wanted)
  if (!picked.ok) return { ok: false, message: `Line "${label}": ${picked.message}` }
  const dir = picked.candidate.dir

  if (line.claimed) {
    if (line.profileDir === dir) {
      return { ok: true, line, unchanged: true }
    }
    if (!reclaim) {
      return {
        ok: false,
        message:
          `Line "${label}" is already claimed as directory "${line.profileDir}"` +
          `${line.profileName ? ` (${line.profileName})` : ''}. Moving it to "${dir}" changes what the label ` +
          'means. If that is intended, run again with --reclaim.',
      }
    }
  }

  let result
  try {
    result = await client.request({ op: OPS.CLAIM_PROFILE, profile: label, args: { dir } })
  } catch (err) {
    return { ok: false, message: describeError(err) }
  }

  const after = result?.line
  if (!after || after.claimed !== true || after.profileDir !== dir) {
    return {
      ok: false,
      message:
        `The broker answered, but the line is now ${after ? `"${after.label}" on directory "${after.profileDir}"` : 'missing from the reply'}, ` +
        `not directory "${dir}". Run the list to see what it is, and check the broker log before trying again.`,
    }
  }
  return { ok: true, line: after }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function describeCandidates(candidates) {
  return candidates
    .map((c) => `${c.dir} = ${c.name || '(unnamed)'}${c.email ? ` <${c.email}>` : ''}`)
    .join('; ')
}

function describeError(err) {
  const code = err && typeof err.code === 'string' ? `${err.code}: ` : ''
  return `${code}${err?.message || String(err)}`
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

const USAGE =
  `${PRODUCT_NAME} claim\n` +
  '\n' +
  '  node scripts/claim.mjs                                   list every line and the choices of the unclaimed ones\n' +
  '  node scripts/claim.mjs <label> "<exact name or email>"   claim that line as the one exact match\n' +
  '  node scripts/claim.mjs --reclaim <label> "<name>"        move an already-claimed line to another directory\n' +
  '\n' +
  'The match is on the full profile name or email, exact and case-sensitive, and must be unique.'

async function main(argv) {
  const parsed = parseArgs(argv)
  if (parsed.mode === 'usage') {
    console.error(parsed.message)
    console.error('')
    console.error(USAGE)
    return 2
  }

  // The client unrefs its socket so an MCP session can exit when stdin closes.
  // Here nothing else keeps the loop alive, so without this the process would
  // exit before the broker's answer arrived, printing nothing and exiting 0.
  const keepAlive = setInterval(() => {}, 1_000)
  const client = new BrokerClient({ onLog: () => {} })
  try {
    if (parsed.mode === 'list') {
      let board
      try {
        board = await client.request({ op: OPS.GET_BOARD })
      } catch (err) {
        console.error(describeError(err))
        return 1
      }
      console.log(`${PRODUCT_NAME} lines`)
      console.log(renderBoard(board?.lines))
      return 0
    }

    const r = await claim({ client, label: parsed.label, wanted: parsed.wanted, reclaim: parsed.reclaim })
    if (!r.ok) {
      console.error(r.message)
      return 1
    }
    const l = r.line
    if (r.unchanged) {
      console.log(`"${l.label}" is already claimed as ${l.vendorLabel || l.vendor} directory "${l.profileDir}". Nothing to do.`)
      return 0
    }
    console.log(
      `Claimed. The line is now "${l.label}": ${l.vendorLabel || l.vendor} directory "${l.profileDir}"` +
        `${l.profileName ? `, profile "${l.profileName}"` : ''}${l.email ? `, ${l.email}` : ''}.`
    )
    console.log('Verify with browser_list_profiles, then browser_list_tabs on that label.')
    return 0
  } finally {
    clearInterval(keepAlive)
    client.close()
  }
}

/** Guard the entry point: the test imports the pure halves above. */
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
