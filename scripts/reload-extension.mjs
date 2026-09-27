#!/usr/bin/env node
/**
 * reload-extension - install a new release into the browsers, with no clicks.
 *
 *   node scripts/reload-extension.mjs --all
 *   node scripts/reload-extension.mjs <profile label>
 *
 * A browser reads an unpacked extension's code once, when it loads it. So
 * pulling a new version into the install folder changes nothing in a running
 * browser: every profile keeps serving the old code until somebody clicks
 * Reload on its card on the extensions page, once per profile. That click is
 * the entire manual step in a release of this project, and it is the step this
 * command removes. Run it after a pull and the profiles pick the new code up
 * themselves.
 *
 * It exists as a command and not only as an MCP tool because the caller is a
 * shell: `git pull && node scripts/reload-extension.mjs --all` is the whole
 * upgrade, and asking someone to start an agent session to finish installing
 * software would be absurd.
 *
 * THE ONE THING THAT CANNOT BE FIXED BY SOFTWARE. The release that first adds
 * this operation cannot use it, because the code that would serve the request
 * is the code being installed. So it needs the click once, everywhere, and no
 * release after it does.
 *
 * Verification is the point, not a courtesy. The acknowledgement only proves
 * the extension was ASKED: reloading tears down the native-messaging port the
 * answer travels on, so the reply necessarily leaves before the reload happens.
 * What proves it landed is the profile coming back on the bridge reporting the
 * installed version, so this command waits for exactly that and says which
 * profiles did and did not come back.
 *
 * Flags:
 *   --all               reload every connected profile that is behind
 *   --dry-run           print what would be reloaded and send nothing
 *   --timeout <seconds> how long to wait for a profile to come back (default 25)
 *   --socket <path>     dial a different broker endpoint
 */

import { ERR, OPS, PRODUCT_NAME, describeExtensionReload } from '../shared/protocol.mjs'
import { installedExtensionVersion } from '../shared/config.mjs'
import { CLI_TIMEOUT_MS, describeError, getBoard, isMain, withBroker } from './claim.mjs'

/** How often the board is re-read while waiting for a profile to come back. */
const POLL_INTERVAL_MS = 500

/** Default ceiling on the wait. A reload and a re-register take about two seconds. */
const DEFAULT_TIMEOUT_MS = 25_000

/**
 * @param {string[]} argv
 * @returns {{mode:'reload',all:boolean,label:string|null,dryRun:boolean,timeoutMs:number,socket:string|undefined}
 *          |{mode:'usage',message:string}}
 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : []
  let all = false
  let dryRun = false
  let timeoutMs = DEFAULT_TIMEOUT_MS
  let socket
  const positional = []

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === '--all') all = true
    else if (a === '--dry-run') dryRun = true
    else if (a === '--timeout') {
      const seconds = Number(args[++i])
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return { mode: 'usage', message: '--timeout takes a number of seconds.' }
      }
      timeoutMs = Math.round(seconds * 1000)
    } else if (a === '--socket') {
      socket = args[++i]
      if (!socket) return { mode: 'usage', message: '--socket takes a path.' }
    } else if (typeof a === 'string' && a.startsWith('--')) {
      return { mode: 'usage', message: a === '--help' ? '' : `Unknown flag ${a}.` }
    } else positional.push(a)
  }

  if (all && positional.length > 0) {
    return { mode: 'usage', message: 'Pass either --all or one profile label, not both.' }
  }
  if (!all && positional.length !== 1) {
    return { mode: 'usage', message: 'Expected one profile label, or --all.' }
  }
  return { mode: 'reload', all, label: all ? null : positional[0], dryRun, timeoutMs, socket }
}

/**
 * Which lines this run should act on, and why each of the others is skipped.
 *
 * Kept pure so the selection rules are testable without a broker. Three things
 * are deliberately NOT reloadable and each gets its own reason, because "no
 * profiles were reloaded" with no explanation is the answer that sends someone
 * to the extensions page to do it by hand.
 *
 * @param {object[]} lines the board's lines
 * @param {string|null} installed the version the install folder holds
 * @param {{all:boolean,label:string|null}} want
 * @returns {{targets:object[], skipped:Array<{label:string,reason:string}>, error:string|null}}
 */
export function selectTargets(lines, installed, { all, label }) {
  const rows = Array.isArray(lines) ? lines : []
  if (!installed) {
    return {
      targets: [],
      skipped: [],
      error:
        'The extension manifest in the install folder could not be read, so there is no version to ' +
        'reload to. Check that the folder the extension was loaded from still exists.',
    }
  }
  if (rows.length === 0) {
    return {
      targets: [],
      skipped: [],
      error:
        'The broker is running but no profile is connected. Load the unpacked extension in a browser ' +
        'profile first (README, step 2); the line appears within a few seconds.',
    }
  }

  const pool = all ? rows : rows.filter((l) => l && l.label === label)
  if (!all && pool.length === 0) {
    return {
      targets: [],
      skipped: [],
      error: `No line is labeled "${label}". Labels are matched exactly. Lines: ${rows.map((l) => l?.label).join(', ')}.`,
    }
  }

  const targets = []
  const skipped = []
  for (const line of pool) {
    if (line.present === false) {
      // Not a failure and not something to fix. A closed browser loads the new
      // code the next time it starts, with nobody clicking anything.
      skipped.push({
        label: line.label,
        reason: 'not connected, so it will load the new version the next time that browser starts',
      })
      continue
    }
    if (!line.extVersion) {
      skipped.push({
        label: line.label,
        reason:
          'did not report an extension version when it connected, so there is no way to tell whether ' +
          "it is behind. Reload it once from the browser's extensions page and it will report one",
      })
      continue
    }
    if (line.extVersion === installed) {
      skipped.push({ label: line.label, reason: `already running ${installed}` })
      continue
    }
    targets.push(line)
  }
  return { targets, skipped, error: null }
}

/**
 * Why a reload request failed, in words that name the next action.
 *
 * One case needs its own sentence and it is the likeliest failure this command
 * has: an extension older than the release that added the operation does not
 * know the operation, and the generic explanation for that error talks about
 * chrome.debugger policy and its tier 1 alternatives, which have nothing to do
 * with it. Anybody upgrading from 0.3.0 or earlier meets this exactly once per
 * profile, and being sent to read about debugger policy is the worst possible
 * answer, because the real one is the single click this command exists to
 * replace.
 *
 * @param {{code?:string, message?:string}} err the client's typed failure
 * @param {{extVersion?:string|null}} line the board line the request addressed
 */
export function describeReloadError(err, line = {}) {
  const code = err && typeof err.code === 'string' ? err.code : null
  const message = String(err?.message || '')
  if (code === ERR.UNSUPPORTED && /^unknown operation/i.test(message.trim())) {
    return (
      `the extension running in this profile is version ${line.extVersion || 'unknown'}, which predates ` +
      'this command and cannot reload itself. That is the one reload nothing can automate: the code ' +
      'that would serve the request is the code being replaced. Open that browser profile, go to its ' +
      'extensions page, find this extension and press the Reload arrow on its card, once. Every ' +
      'release after that one click is this command.'
    )
  }
  return describeError(err)
}

/**
 * Ask one line to reload, then wait for it to come back on the new version.
 *
 * Addressed by installId rather than label for the same reason claim and label
 * are: the label is re-resolved across the whole table on every register, and a
 * reload IS a register, so the name can move underneath this call.
 *
 * @param {{client:{request:Function}, line:object, installed:string, timeoutMs:number, sleep?:Function, now?:Function}} spec
 * @returns {Promise<{ok:boolean,line:string}>}
 */
export async function reloadOne({
  client,
  line,
  installed,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
}) {
  const from = line.extVersion || null
  const startedAt = now()

  let asked
  try {
    asked = await client.request({
      op: OPS.RELOAD_EXTENSION,
      profile: line.installId,
      timeoutMs: CLI_TIMEOUT_MS,
    })
  } catch (err) {
    return { ok: false, line: `${line.label}: ${describeReloadError(err, line)}` }
  }
  if (!asked?.reloading) {
    return {
      ok: false,
      line:
        `${line.label}: the broker allowed the reload but the extension did not confirm it, which means ` +
        `the extension in that profile is older than this command. ${describeReloadError(
          { code: ERR.UNSUPPORTED, message: 'Unknown operation' },
          line
        )}`,
    }
  }

  // The profile has to disappear and come back. Watching only for "the version
  // changed" would also match a board read that happened to land before the
  // reload, so the deadline is the only thing that ends the wait.
  while (now() - startedAt < timeoutMs) {
    await sleep(POLL_INTERVAL_MS)
    let board
    try {
      board = await getBoard(client)
    } catch {
      // The broker is momentarily busy re-registering a route. Keep waiting;
      // the deadline below is what gives up.
      continue
    }
    const after = (board?.lines || []).find((l) => l && l.installId === line.installId)
    if (after && after.present !== false && after.extVersion === installed) {
      return {
        ok: true,
        line: describeExtensionReload({
          profile: after.label,
          from,
          to: installed,
          verified: true,
          waitedMs: now() - startedAt,
        }),
      }
    }
  }

  return {
    ok: false,
    line:
      `${line.label}: asked it to reload and it has not come back on ${installed} within ` +
      `${Math.round(timeoutMs / 1000)}s. It may still be reloading, or the extension may have been ` +
      'disabled. Check the profile list before asking again.',
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

const USAGE =
  `${PRODUCT_NAME} reload-extension\n` +
  '\n' +
  '  node scripts/reload-extension.mjs --all             reload every connected profile that is behind\n' +
  '  node scripts/reload-extension.mjs <profile label>   reload one profile\n' +
  '\n' +
  '  --dry-run           print what would be reloaded and send nothing\n' +
  '  --timeout <seconds> how long to wait for a profile to come back (default 25)\n' +
  '  --socket <path>     dial a different broker endpoint\n' +
  '\n' +
  'A browser reads an unpacked extension once, when it loads it, so a pulled release does not reach\n' +
  'a running browser until its extension is reloaded. This is that reload, without the click. A\n' +
  'profile already running the installed version is refused, because a reload costs every agent\n' +
  'session driving it its open tab handles.'

async function main(argv) {
  const parsed = parseArgs(argv)
  if (parsed.mode === 'usage') {
    if (parsed.message) console.error(parsed.message, '\n')
    console.error(USAGE)
    return 2
  }

  const installed = installedExtensionVersion()

  return withBroker(
    async (client) => {
      let board
      try {
        board = await getBoard(client)
      } catch (err) {
        console.error(describeError(err))
        return 1
      }

      const { targets, skipped, error } = selectTargets(board?.lines, installed, parsed)
      if (error) {
        console.error(error)
        return 1
      }

      for (const s of skipped) console.log(`${s.label}: skipped, ${s.reason}.`)

      if (targets.length === 0) {
        console.log(`Nothing to reload. Every connected profile is running extension ${installed}.`)
        return 0
      }

      if (parsed.dryRun) {
        for (const line of targets) {
          console.log(`${line.label}: would reload, ${line.extVersion} to ${installed}.`)
        }
        return 0
      }

      // One at a time, deliberately. Each reload re-registers a route and the
      // broker re-resolves every label in the table when it does; firing them
      // together would have several lines moving while the board is being read
      // to decide what happened to them.
      let failures = 0
      for (const line of targets) {
        const r = await reloadOne({ client, line, installed, timeoutMs: parsed.timeoutMs })
        if (r.ok) console.log(r.line)
        else {
          console.error(r.line)
          failures += 1
        }
      }
      return failures === 0 ? 0 : 1
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
