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
 * one exact match refuses, says how many matched, names the nearest candidate
 * when there is exactly one, and sends nothing.
 *
 * Two round trips, and the second one is addressed by install id. The label
 * read from the board is what the operator typed, but a label is not a stable
 * handle: any profile connecting or disconnecting can re-resolve every
 * collision suffix on the board (bridged/routes.mjs). The install id is the
 * route's own identity and the broker accepts it as an address, so the claim
 * lands on the line the operator looked at, or fails, and never on a line that
 * inherited its name in between.
 *
 * It speaks to the broker as an agent-role connection through the same client
 * the MCP server uses, so the token, the framing and the timeouts are the
 * contract's, not a second copy. CLAIM_PROFILE is in BROKER_OPS, which is what
 * lets an agent connection originate it (shared/protocol.mjs).
 */

import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { BrokerClient } from '../mcp-server/client.mjs'
import { explainError, renderBoard as renderLines } from '../mcp-server/shape.mjs'
import { OPS, PRODUCT_NAME } from '../shared/protocol.mjs'

/**
 * How long one broker request may take from a one-shot command. A local pipe
 * answers in milliseconds; the contract's 30 s default exists for page
 * operations that wait on a browser, which none of these are.
 */
export const CLI_TIMEOUT_MS = 8_000

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
      message: `No line is labeled "${label}". Labels are matched exactly. Lines: ${all.map((l) => l?.label).join(', ')}.`,
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
  if (hits.length === 1) return { ok: true, candidate: hits[0] }

  // The rule stays exact. The hint exists because the usual miss is a
  // capital letter or a stray space, and saying which candidate that would
  // have been is cheaper than making the operator diff two strings by eye.
  const loose = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '')
  const near = candidates.filter((c) => c && (loose(c.name) === loose(wanted) || loose(c.email) === loose(wanted)))
  const hint = hits.length === 0 && near.length === 1 ? ` Nearest: "${near[0].name || near[0].email}" (copy it exactly).` : ''

  return {
    ok: false,
    message:
      `${hits.length} candidate(s) match "${wanted}" exactly; a claim needs exactly one. ` +
      `The match is on the full profile name or email, case-sensitive.${hint} Choices: ${describeCandidates(candidates)}.`,
  }
}

/**
 * Parse the command line.
 *
 * @param {string[]} argv
 * @returns {{mode: 'list'} | {mode: 'claim', label: string, wanted: string, reclaim: boolean} | {mode: 'usage', message: string}}
 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : []
  if (args.includes('--help') || args.includes('-h')) return { mode: 'usage', message: '' }
  if (args.includes('--list')) {
    return args.length === 1 ? { mode: 'list' } : { mode: 'usage', message: '--list takes no other arguments.' }
  }

  let reclaim = false
  const positional = []
  for (const a of args) {
    if (a === '--reclaim') reclaim = true
    else if (typeof a === 'string' && a.startsWith('--')) return { mode: 'usage', message: `Unknown flag ${a}.` }
    else positional.push(a)
  }
  if (positional.length === 0 && !reclaim) return { mode: 'list' }
  if (positional.length !== 2) {
    return { mode: 'usage', message: 'Expected a label and an exact profile name or email, or no arguments to list.' }
  }
  return { mode: 'claim', label: positional[0], wanted: positional[1], reclaim }
}

/**
 * Render the board for a human: the same view browser_list_profiles gives,
 * plus the candidate directories of every line that still needs claiming. A
 * claimed line's candidates are not choices any more, so they are left out
 * rather than inviting a re-claim.
 *
 * @param {object} board the GET_BOARD result
 * @returns {string}
 */
export function renderBoard(board) {
  const text = renderLines(board)
  const lines = Array.isArray(board?.lines) ? board.lines : []
  const unclaimed = lines.filter((l) => l && l.claimed === false && l.present !== false)
  if (lines.length === 0) return text
  if (unclaimed.length === 0) return `${text}\n\nEvery connected line is claimed.`

  const out = [text, '', 'Unclaimed lines and the directories each one can be claimed as:']
  for (const l of unclaimed) {
    out.push(`  ${l.label}`)
    const candidates = Array.isArray(l.candidates) ? l.candidates : []
    if (candidates.length === 0) out.push('      (no candidate directories; reload the extension in that profile)')
    for (const c of candidates) {
      out.push(`      ${String(c.dir).padEnd(11)} ${c.name || ''}${c.email ? `  (${c.email})` : ''}`)
    }
  }
  out.push('')
  out.push('Claim one with:  node scripts/claim.mjs <label> "<exact profile name or email>"')
  return out.join('\n')
}

/* -------------------------------------------------------------------------- */
/* Talking to the broker                                                       */
/* -------------------------------------------------------------------------- */

/** One board read, with the command-line deadline. Throws the client's typed error. */
export function getBoard(client) {
  return client.request({ op: OPS.GET_BOARD, timeoutMs: CLI_TIMEOUT_MS })
}

/**
 * A typed failure as the operator should read it: the same actionable text
 * the MCP tools give the model, so a stopped broker names the start command
 * here too. An untyped error is printed as it is.
 */
export function describeError(err) {
  if (err && typeof err.code === 'string') return explainError(err)
  return err?.message || String(err)
}

/** Run `fn` with a broker client that holds the process open until it is done. */
export async function withBroker(fn) {
  const client = new BrokerClient({ onLog: () => {}, keepAlive: true })
  try {
    return await fn(client)
  } finally {
    client.close()
  }
}

/**
 * The claim itself: read the board, refuse anything that is not exactly one
 * exact match, send CLAIM_PROFILE addressed by install id, and check the
 * answer is the same line now claimed as the directory that was asked for.
 * The broker's reply is the only proof the claim landed.
 *
 * @param {{client: {request: Function}, label: string, wanted: string, reclaim?: boolean}} spec
 * @returns {Promise<{ok: true, line: object, unchanged?: boolean} | {ok: false, message: string}>}
 */
export async function claim({ client, label, wanted, reclaim = false }) {
  let board
  try {
    board = await getBoard(client)
  } catch (err) {
    return { ok: false, message: describeError(err) }
  }

  const found = findLine(board?.lines, label)
  if (!found.ok) return found
  const line = found.line

  // A line the broker remembers but that is not connected has no candidates
  // and no route to claim; the fix is to open that browser, not to reload an
  // extension that is not running.
  if (line.present === false) return { ok: false, message: notConnected(line) }

  const picked = pickCandidate(line.candidates, wanted)
  if (!picked.ok) return { ok: false, message: `Line "${label}": ${picked.message}` }
  const dir = picked.candidate.dir

  if (line.claimed) {
    if (line.profileDir === dir) return { ok: true, line, unchanged: true }
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
    result = await client.request({
      op: OPS.CLAIM_PROFILE,
      profile: line.installId,
      args: { dir },
      timeoutMs: CLI_TIMEOUT_MS,
    })
  } catch (err) {
    return { ok: false, message: describeError(err) }
  }

  const after = result?.line
  const landed = after && after.installId === line.installId && after.claimed === true && after.profileDir === dir
  if (!landed) {
    return {
      ok: false,
      message:
        `The broker answered, but the line is now ${after ? `"${after.label}" on directory "${after.profileDir}"` : 'missing from the reply'}, ` +
        `not the line that was addressed claimed as "${dir}". List again to see what it is, and check the broker log before trying again.`,
    }
  }
  return { ok: true, line: after }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** The refusal for a line the board lists but no browser is holding open. */
export function notConnected(line) {
  return (
    `Line "${line.label}" is known to the bridge but not connected right now: the browser is closed, ` +
    'or its extension was disabled. Open that browser profile, wait for the line to show as ready, and run this again.'
  )
}

function describeCandidates(candidates) {
  return candidates
    .map((c) => `${c.dir} = ${c.name || '(unnamed)'}${c.email ? ` <${c.email}>` : ''}`)
    .join('; ')
}

/** Is this module the process entry point? Shared with scripts/label.mjs. */
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
    if (parsed.message) console.error(parsed.message, '\n')
    console.error(USAGE)
    return 2
  }

  return withBroker(async (client) => {
    if (parsed.mode === 'list') {
      let board
      try {
        board = await getBoard(client)
      } catch (err) {
        console.error(describeError(err))
        return 1
      }
      console.log(renderBoard(board))
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
