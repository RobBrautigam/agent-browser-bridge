/**
 * Result shaping for the MCP server.
 *
 * Everything a model ever reads out of this system is rendered here. Three
 * jobs, and they are the whole reason this file exists separately from the
 * tool registrations:
 *
 *   1. Error translation. A typed code off the wire is useless to a model on
 *      its own. Every code in shared/protocol.mjs ERR maps to a sentence that
 *      names the next action, so a failure costs one turn instead of three.
 *   2. Output budgeting. Claude Code discards a tool result that blows its
 *      cap, so page text is paginated and screenshots are measured before
 *      they are put inline.
 *   3. Shape tolerance. This process never touches a browser, so it never
 *      knows better than the broker what a payload contains. Where a field is
 *      missing or the shape is not what we expected, the fallback is readable
 *      JSON rather than the word "undefined".
 */

import fs from 'node:fs'
import path from 'node:path'

import { ERR, LINK, PRODUCT_NAME, RESTRICTED_URL_PREFIXES } from '../shared/protocol.mjs'
import {
  SHOTS_DIR,
  PANIC_FILE,
  RUNTIME_FILE,
  START_BROKER_COMMAND,
  ensureBaseDir,
} from '../shared/paths.mjs'

/**
 * Base64 characters we are willing to place inline in one tool result.
 *
 * Claude Code caps a tool result at 25,000 tokens, and `maxResultSizeChars`
 * raises that ceiling for TEXT only - image blocks stay capped. Base64 also
 * tokenizes badly (no word structure to merge), so a screenshot that looks
 * modest in kilobytes can still blow the cap, and a blown cap discards the
 * whole result rather than truncating it. Hence a measured budget with a file
 * fallback instead of hoping.
 *
 * DESIGN.md section 9 calls this figure a starting estimate that session 2
 * must measure. Treat it as provisional until it has been.
 */
export const INLINE_SHOT_BUDGET_B64_CHARS = 55_000

/** Default page-text page size. Roughly 5,000 tokens of prose. */
export const DEFAULT_PAGE_MAX_CHARS = 20_000

/** Tabs listed per call by default, before the tail is summarized instead of enumerated. */
const MAX_TABS_RENDERED = 80

/**
 * Hard ceiling on `limit`, so one call cannot try to render an unbounded list.
 *
 * Three lines per tab at roughly 25 tokens a line puts 1,000 tabs near the
 * 25,000-token tool-result cap, and a blown cap discards the whole result
 * rather than truncating it (see INLINE_SHOT_BUDGET_B64_CHARS). A browser with
 * more tabs than this pages through them with `offset` instead.
 */
export const MAX_TABS_LISTABLE = 1_000

/** Characters of raw JSON we will echo back when a payload is not a shape we recognize. */
const MAX_JSON_ECHO_CHARS = 4_000

/** Snapshot elements rendered per result before the tail is summarized. */
const MAX_SNAPSHOT_ELEMENTS_RENDERED = 400

/* -------------------------------------------------------------------------- */
/* Result envelopes                                                            */
/* -------------------------------------------------------------------------- */

/** A plain text result. */
export function text(body) {
  return { content: [{ type: 'text', text: body }] }
}

/**
 * A failed result. Errors are returned as content with `isError`, never
 * thrown: a thrown handler becomes a protocol-level error the model cannot
 * read, and the whole point of this file is that it can.
 */
export function errorResult(err, opts = {}) {
  return { content: [{ type: 'text', text: explainError(err, opts) }], isError: true }
}

/* -------------------------------------------------------------------------- */
/* Error translation                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Turn a typed failure into an actionable paragraph.
 *
 * @param {{code?:string,message?:string,data?:unknown}} err
 * @param {{labels?:Array<{label:string,link:string,present:boolean}>|null, profile?:string|null}} opts
 *        `labels` is the live board when we could fetch one, so a wrong-label
 *        error can name the right ones instead of telling the model to go look.
 */
export function explainError(err, { labels = null, profile = null } = {}) {
  const code = typeof err?.code === 'string' ? err.code : null
  const detail = typeof err?.message === 'string' ? err.message.trim() : ''
  const asked = profile ? `"${profile}"` : 'that profile'

  const lines = []
  switch (code) {
    case ERR.NO_BROKER:
      lines.push(
        'The bridge broker is not running, so no browser can be reached.',
        '',
        `Start it with:  ${START_BROKER_COMMAND}`,
        '',
        'The broker is one always-on process that every browser profile and every agent session connects through. Nothing works until it is up. If starting it does not help, the broker service may not be installed: run scripts/doctor.mjs in the folder this bridge was cloned to.'
      )
      break

    case ERR.UNAUTHORIZED:
      lines.push(
        'The broker refused this session. The shared token rotates on every broker start and is re-read on every connect, so a stale token normally fixes itself.',
        '',
        `Token file: ${RUNTIME_FILE}`,
        `Restart the broker with:  ${START_BROKER_COMMAND}`,
        '',
        'If it keeps failing, the file most likely belongs to a different Windows account than this session is running as.'
      )
      break

    case ERR.BAD_REQUEST:
      lines.push(
        'The broker rejected these arguments.',
        detail ? `It said: ${detail}` : null,
        '',
        'Check that `profile` is an exact label from browser_list_profiles and that any `tab` is a handle from browser_list_tabs.'
      )
      break

    case ERR.UNKNOWN_PROFILE:
      lines.push(
        `No connected profile is labeled ${asked}.`,
        '',
        labelSentence(labels),
        '',
        'Labels are matched exactly. There is no prefix, fuzzy, or case-insensitive matching, on purpose: the failure this prevents is silently driving the wrong logged-in browser. Copy a label verbatim from browser_list_profiles, which also shows profiles that are configured but not currently connected.'
      )
      break

    case ERR.PROFILE_STALE:
      lines.push(
        `Profile ${asked} is known but its browser is not answering. The usual cause is that the browser is closed; the other is that its bridge extension was disabled.`,
        '',
        labelSentence(labels, 'Answering right now'),
        '',
        'Opening that browser is enough - the extension reconnects on its own within a few seconds and the profile reappears. browser_list_profiles shows the link state of every profile.'
      )
      break

    case ERR.PROFILE_UNCLAIMED:
      lines.push(
        `The browser for ${asked} is connected, but nobody has told the bridge which profile directory it is, so operations cannot be routed to it.`,
        '',
        'This is a one-time, once-per-profile step and it needs a human: open the bridge extension options page inside that browser profile and click which profile it is. Brave carries no signed-in identity in its profile metadata, so the match cannot be made automatically.'
      )
      break

    case ERR.BAD_TAB_HANDLE:
      lines.push(
        'That tab handle was rejected.',
        '',
        'Handles look like tab_<profile>_<generation>_<id>. They are scoped to one profile and to one browser session: a handle minted for another profile is refused, and every handle from before a browser restart is refused because the generation changed.',
        '',
        `Call browser_list_tabs${profile ? ` with profile "${profile}"` : ''} and use a handle from that result. A raw Chrome tab number is never a valid handle.`
      )
      break

    case ERR.TAB_GONE:
      lines.push(
        'That tab no longer exists. It was closed, or the window holding it was.',
        '',
        `Call browser_list_tabs${profile ? ` with profile "${profile}"` : ''} for the current set, or browser_open_tab to make a new one.`
      )
      break

    case ERR.NOT_ARMED:
      lines.push(
        'browser_eval_js is gated behind an explicit human arm and this profile is not armed.',
        '',
        `Run bridge_arm with profile ${asked} to open a bounded window, then retry.`,
        '',
        'Arming covers exactly that one profile for that window and nothing else. It is required only for browser_eval_js, because arbitrary JavaScript in an already-logged-in session is unbounded in blast radius. Every other tool in this server works without arming, so prefer browser_click, browser_fill, browser_read_page and browser_scroll where they can do the job.'
      )
      break

    case ERR.PANIC:
      lines.push(
        'The bridge panic switch is engaged. Every route is dropped and all operations are refused.',
        '',
        `Clear it by deleting this file:  ${PANIC_FILE}`,
        '',
        'Nothing else clears it, deliberately: the switch works whether or not the model cooperates. It was created either by bridge_panic or by hand.'
      )
      break

    case ERR.TIMEOUT:
      lines.push(
        'The operation did not finish in time.',
        detail ? detail : null,
        '',
        'The page is most likely still loading or blocked on a human-verification gate. Try browser_screenshot to see the current state, browser_wait_for to wait on a specific selector or text, or raise timeoutMs where the tool has one.'
      )
      break

    case ERR.EXT_ERROR:
      lines.push(
        'The browser extension reported an error.',
        detail ? `It said: ${detail}` : null,
        '',
        'If it repeats, check browser_list_profiles for the link state of that profile. Reloading the bridge extension in that browser clears a wedged service worker.'
      )
      break

    case ERR.UNSUPPORTED:
      lines.push(
        'That operation is not available on this profile.',
        detail ? detail : null,
        '',
        'The escalated capabilities (trusted clicks, per-character typing, full-page and background-tab screenshots) run through chrome.debugger, which policy can disable. The tier 1 equivalents still work: browser_click without trusted, browser_fill with mode "set", and browser_screenshot after browser_activate_tab.'
      )
      break

    case ERR.RESTRICTED_URL:
      // Built from the constant, never restated. Two copies of this list had
      // already drifted: both omitted file://, so a model refused for reading a
      // local file was handed an explanation that did not mention local files.
      lines.push(
        `${PRODUCT_NAME} refuses these URL schemes: ${RESTRICTED_URL_PREFIXES.join(', ')}.`,
        '',
        'Chromium blocks scripting on browser-internal pages anyway, so refusing early just makes the reason legible. file:// is refused for a different reason: navigating is a write-tier operation and reading a page is read-tier, so without the refusal the two compose into an unarmed local-file read. Navigate to a normal http or https page instead.'
      )
      break

    default:
      lines.push(
        detail || 'The bridge failed with no further detail.',
        '',
        'Run bridge_status for the broker and route state.'
      )
      break
  }

  // null means "this line did not apply"; '' is a deliberate blank line.
  const body = lines.filter((l) => l != null).join('\n').replace(/\n{3,}/g, '\n\n')
  return code ? `${body}\n\n(error code ${code})` : body
}

/** "Connected now: a, b, c" - or an honest admission that we could not look. */
function labelSentence(labels, lead = 'Connected now') {
  if (!Array.isArray(labels)) {
    return 'Run browser_list_profiles for the current list of labels. They could not be listed here because the broker did not answer a second request.'
  }
  const live = labels.filter((l) => l && l.present !== false).map((l) => l.label).filter(Boolean)
  if (live.length === 0) {
    return 'No profile is connected at all right now. Open one of the browsers, or run bridge_status to see why every route is down.'
  }
  return `${lead}: ${live.join(', ')}`
}

/* -------------------------------------------------------------------------- */
/* The board: browser_list_profiles and bridge_status                          */
/* -------------------------------------------------------------------------- */

/**
 * Render the board as the profile list. This is the tool a model reaches for
 * before every other one, so the labels have to be unmissable and copyable.
 */
export function renderBoard(board) {
  const lines = Array.isArray(board?.lines) ? board.lines : []
  const now = numberOr(board?.now, Date.now())
  const out = []

  out.push(`${board?.product || PRODUCT_NAME} ${board?.version || ''}`.trim())
  if (board?.panic) {
    out.push('')
    out.push(`PANIC SWITCH ENGAGED - every route is dropped. Clear it by deleting ${PANIC_FILE}`)
  }
  for (const note of versionNotes(board)) out.push(note)
  out.push('')

  if (lines.length === 0) {
    out.push('No browser profiles are connected and none have ever been configured.')
    out.push('')
    out.push('Load the bridge extension in a Chrome or Brave profile (chrome://extensions, Developer mode, Load unpacked) and it will appear here within a few seconds.')
    return out.join('\n')
  }

  const w = Math.max(...lines.map((l) => String(l?.label || '?').length), 5)
  for (const l of lines) {
    const label = String(l?.label || '?').padEnd(w)
    const vendor = String(l?.vendorLabel || l?.vendor || '?').padEnd(6)
    const state = statusWord(l).padEnd(10)
    // The status column already says "unclaimed"; do not say it twice.
    const where = l?.profileDir ? String(l.profileDir) : '-'
    const bits = [`tabs ${numberOr(l?.tabCount, 0)}`]
    // The version every line is RUNNING, on the line itself rather than in a
    // note, because "which of my profiles are behind" is a question about the
    // whole list and a column answers it at a glance.
    bits.push(`ext ${l?.extVersion || 'unreported'}`)
    if (l?.lastSeenAt) bits.push(`seen ${fmtAge(now - l.lastSeenAt)} ago`)
    if (l?.latencyMs != null) bits.push(`${Math.round(l.latencyMs)}ms`)
    if (l?.armedUntil && l.armedUntil > now) bits.push(`ARMED ${fmtAge(l.armedUntil - now)} left`)
    out.push(`  ${label}  ${vendor}  ${state}  ${where.padEnd(10)}  ${bits.join('  ')}`)

    const notes = []
    if (l?.identityChanged)
      notes.push(
        'the account signed into this profile is no longer the one it was claimed as, so the bridge dropped the claim and its old label stops resolving. It has to be claimed again in the extension options page before it can be used'
      )
    else if (l?.claimed === false) notes.push('needs claiming: open the extension options page in that browser profile and pick which profile it is')
    if (l?.needsReload)
      notes.push(
        `needs a reload: it is running extension ${l.extVersion} and the install folder holds ` +
          `${board?.installedVersion}. Call browser_reload_extension with this profile, or click Reload on ` +
          "this extension's card on the browser's extensions page"
      )
    if (l?.present === false) notes.push('configured before but not connected now: the browser is closed, or its extension was disabled')
    if (l?.email) notes.push(`signed in as ${l.email}`)
    else if (l?.profileName) notes.push(`profile name "${l.profileName}"`)
    if (l?.warning) notes.push(String(l.warning))
    for (const n of notes) out.push(`      ${n}`)
  }

  out.push('')
  out.push('Pass one of those labels verbatim as the `profile` argument. Matching is exact, and every page-touching tool requires it.')
  return out.join('\n')
}

/** Render the board as the operator status view: link health, arming, audit tail. */
export function renderStatus(board) {
  const lines = Array.isArray(board?.lines) ? board.lines : []
  const audit = Array.isArray(board?.audit) ? board.audit : []
  const now = numberOr(board?.now, Date.now())
  const out = []

  out.push(`${board?.product || PRODUCT_NAME} ${board?.version || ''}`.trim())
  if (board?.startedAt) out.push(`Broker up ${fmtAge(now - board.startedAt)}`)
  out.push(`Panic: ${board?.panic ? 'ENGAGED' : 'off'}`)
  out.push(`Routes: ${lines.length} configured, ${lines.filter((l) => l?.link === LINK.READY).length} ready`)
  const behind = lines.filter((l) => l?.needsReload).length
  out.push(
    `Extension: ${board?.installedVersion || 'unreadable'} installed, ` +
      (behind === 0
        ? 'every connected profile is running it'
        : `${behind} of ${lines.length} ${behind === 1 ? 'profile needs' : 'profiles need'} a reload`)
  )
  for (const note of versionNotes(board)) out.push(note)
  out.push('')

  if (lines.length === 0) {
    out.push('No routes. No browser profile has ever connected to this broker.')
  } else {
    for (const l of lines) {
      const armed = l?.armedUntil && l.armedUntil > now ? `armed ${fmtAge(l.armedUntil - now)} left` : 'not armed'
      const seen = l?.lastSeenAt ? `${fmtAge(now - l.lastSeenAt)} ago` : 'never'
      out.push(`  ${l?.label || '?'}  ${statusWord(l)}  ext ${l?.extVersion || 'unreported'}${l?.needsReload ? ' NEEDS RELOAD' : ''}  gen ${numberOr(l?.generation, 0)}  last pong ${seen}  ops ${numberOr(l?.opCount, 0)}${l?.lastOp ? ` (last: ${l.lastOp})` : ''}  ${armed}`)
      // WHICH ACCOUNT this line is. renderBoard has always said it and this
      // view never did, which left the operator status view unable to answer
      // the one question a label collision or an identity change raises.
      if (l?.email) out.push(`      signed in as ${l.email}`)
      else if (l?.profileName) out.push(`      profile name "${l.profileName}"`)
      if (l?.warning) out.push(`      warning: ${l.warning}`)
    }
  }

  out.push('')
  if (audit.length === 0) {
    out.push('Audit: nothing recorded this broker lifetime.')
  } else {
    out.push(`Audit, most recent ${Math.min(10, audit.length)} entries (origin only - paths are never logged, because reset and magic-link tokens live in paths):`)
    for (const a of audit.slice(-10)) {
      out.push(`  ${fmtClock(a?.at)}  ${a?.ok === false ? 'FAIL' : 'ok  '}  ${a?.profile || '?'}  ${a?.op || '?'}  ${a?.origin || ''}`.trimEnd())
    }
  }
  return out.join('\n')
}

/**
 * The notes that belong to the INSTALL rather than to any one line.
 *
 * Two of them, and they mean different things. A broker running an older
 * version than the folder holds is a broker that has not been restarted since
 * the last pull, which is harmless for the browser tools and worth saying once.
 * An unreadable manifest is the state where the bridge cannot answer "is
 * anything behind" at all, and silence there would read as "nothing is".
 */
function versionNotes(board) {
  const out = []
  if (!board?.installedVersion) {
    out.push('')
    out.push(
      'The extension manifest in the install folder could not be read, so no profile can be checked ' +
        'for being behind and no reload can be requested. The install folder may have been moved.'
    )
    return out
  }
  if (board?.version && board.version !== board.installedVersion) {
    out.push('')
    out.push(
      `The broker is running ${board.version} and the install folder holds ${board.installedVersion}: ` +
        'somebody pulled a new version and the broker has not been restarted since. The browser tools ' +
        'are unaffected.'
    )
  }
  return out
}

function statusWord(line) {
  // Above every other state, including absent: a line whose signed-in account
  // changed is the one thing here that can cause a wrong-identity action, and
  // "unclaimed" undersells it to the point of hiding it.
  if (line?.identityChanged) return 'CHANGED'
  if (line?.present === false) return 'absent'
  if (line?.claimed === false) return 'unclaimed'
  const link = line?.link
  if (link === LINK.READY) return 'ready'
  if (link === LINK.STALE) return 'stale'
  if (link === LINK.CONNECTING) return 'connecting'
  if (link === LINK.DOWN) return 'down'
  return String(link || '?')
}

/* -------------------------------------------------------------------------- */
/* Tabs                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Render a listTabs result as a page of tabs.
 *
 * The window is `limit` tabs starting at `offset`, both from the tool call and
 * both optional. The default limit stays MAX_TABS_RENDERED, so an ordinary call
 * renders exactly what it always did; the arguments exist so that a profile
 * with more tabs than that is no longer a dead end.
 *
 * That dead end was real. A 197-tab profile rendered 80 and ended with
 * "... and 117 more, not listed", with nothing in the result saying how to
 * reach them, so the remaining 117 were unreachable through the tool at all.
 * A truncation notice that does not name its own remedy loses data silently,
 * the same failure class as the page-read truncation documented above. Hence
 * the tail line now carries the exact next call.
 */
export function renderTabs(result, { profile, limit, offset } = {}) {
  const tabs = Array.isArray(result?.tabs) ? result.tabs : Array.isArray(result) ? result : null
  if (!tabs) return text(`${profile}: unexpected listTabs payload.\n\n${jsonEcho(result)}`)
  if (tabs.length === 0) return text(`${profile}: no open tabs.`)

  const total = tabs.length
  const start = pageStart(offset, total)
  const end = Math.min(start + pageSize(limit), total)
  const window = tabs.slice(start, end)

  const head =
    start === 0 && end === total
      ? `${profile}: ${total} open tab${total === 1 ? '' : 's'}`
      : `${profile}: ${total} open tabs, showing ${start + 1} to ${end}`
  const out = [head, '']
  for (const t of window) {
    const marks = []
    if (t?.active) marks.push('active')
    if (t?.windowId != null) marks.push(`window ${t.windowId}`)
    out.push(`  ${t?.handle || t?.tab || '(no handle)'}`)
    out.push(`      ${oneLine(t?.title) || '(no title)'}`)
    out.push(`      ${t?.url || '(no url)'}${marks.length ? `  [${marks.join(', ')}]` : ''}`)
  }
  if (end < total) {
    // The remedy must be one the code will actually honor. Advertising
    // `limit: ${total}` above the ceiling promised a render that pageSize would
    // silently clamp back, so the tail told the caller to repeat a call that
    // cannot work. A truncation notice that names a false remedy is worse than
    // one that names none, because it costs a round trip to discover.
    const renderable = Math.min(total, MAX_TABS_LISTABLE)
    const remedy =
      renderable > end
        ? `, or limit: ${renderable} to render ${renderable === total ? `all ${total}` : `${renderable}`} at once`
        : ''
    out.push(
      '',
      `  ... and ${total - end} more, not listed. Call browser_list_tabs again with ` +
        `offset: ${end} for the next page${remedy}.`
    )
  }
  out.push('', 'Pass a handle exactly as shown as the `tab` argument. Handles are only valid for this profile and this browser session.')
  return text(out.join('\n'))
}

/**
 * Parse a value to a finite integer, or null when it cannot sensibly be one.
 *
 * Numbers only, deliberately. A bare Number() call would have been worse still,
 * since `Number(null)`, `Number('')` and `Number([])` are all 0 and
 * `Number(true)` is 1, turning "absent" into a real, tiny number. But accepting
 * numeric STRINGS was its own trap: it made `limit: "0x50"` mean 80 and
 * `limit: "5"` mean five, while the tool schema admits neither. The only caller
 * that matters passes schema-validated numbers, so a string here is a caller
 * bug and gets the predictable default rather than a clever guess.
 */
function asInt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.trunc(value)
}

/**
 * How many tabs to render.
 *
 * Anything that is not a positive number is treated as ABSENT and gets the
 * default page, because a `limit` of null, "" or -5 is a malformed request
 * rather than a request for one tab. The zod schema rejects those before they
 * reach here on the tool path; renderTabs is also called directly, so the
 * behavior is defined here too. Above the ceiling, clamp: that IS a real
 * request, just a larger one than a single result can hold.
 */
function pageSize(limit) {
  const n = asInt(limit)
  if (n === null || n < 1) return MAX_TABS_RENDERED
  return Math.min(n, MAX_TABS_LISTABLE)
}

/**
 * Index of the first tab to render. Absent or negative means the start; past
 * the end means the last tab, so a stale offset still returns something real
 * rather than an empty page the caller cannot distinguish from "no tabs".
 */
function pageStart(offset, total) {
  const n = asInt(offset)
  if (n === null || n < 0) return 0
  return Math.min(n, Math.max(total - 1, 0))
}

/* -------------------------------------------------------------------------- */
/* Page text                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Render a readPage result, in any of its three formats.
 *
 * The pagination fields are PageResult's, from shared/protocol.mjs: `start` is
 * the absolute offset this slice began at, `total` is the whole length, and
 * `next` is the continuation offset or null when the read is complete. The
 * first build looked for `nextCursor`/`cursor`, neither of which the extension
 * has ever sent, so a 65,000-character page read at 20,000 characters rendered
 * "end of content, 20,000 characters" and the other 45,000 were lost silently.
 * That is the worst possible failure for a read tool: the model is told a
 * truncated page was the whole page and reasons on it.
 *
 * `maxChars` is enforced here a second time even though the extension already
 * honored it. Claude Code discards a tool result that blows its output cap
 * rather than truncating it, so a payload that ignored the budget would cost
 * the whole read.
 */
export function renderPage(result, opts) {
  const { profile, tab, format } = opts

  // A snapshot is a list of element refs, not a slice of characters, and it is
  // the format browser_click and browser_fill depend on. It gets its own
  // renderer: the first build fell through to the raw-JSON echo here and
  // truncated at 4,000 characters, losing most of the refs it was asked for.
  if (result?.format === 'snapshot' || Array.isArray(result?.elements)) {
    return renderSnapshot(result, opts)
  }

  const body = pickPageBody(result)
  if (body == null) {
    return text(`${profile} ${tab}: unexpected readPage payload.\n\n${jsonEcho(result)}`)
  }

  const maxChars = numberOr(opts.maxChars, DEFAULT_PAGE_MAX_CHARS)
  const start = numberOr(result?.start, 0)
  const total = numberOr(result?.total, null)

  const overBudget = body.length > maxChars
  const shown = overBudget ? body.slice(0, maxChars) : body
  // Offsets are absolute positions in the document, so a locally-truncated
  // cursor has to be measured from where this slice began. Reporting the slice
  // length alone would send the next call back to the top of page two forever.
  const end = start + shown.length
  const next = overBudget ? end : numberOr(result?.next, null)
  const remaining = total != null && next != null ? Math.max(0, total - next) : null

  const head = [`${profile} ${tab} - ${format}`]
  if (result?.url) head.push(String(result.url))
  if (result?.title) head.push(oneLine(result.title))
  head.push(sliceLine('characters', start, end, total))

  const foot = ['']
  if (next != null) {
    foot.push(
      remaining != null
        ? `--- MORE REMAINS: ${count(remaining)} of ${count(total)} characters are not shown above. ---`
        : '--- MORE REMAINS: this is not the whole page. ---',
      `--- Call browser_read_page again with the same profile and tab and cursor: "${next}" to continue from character ${count(next)}. ---`
    )
  } else {
    foot.push(`--- End of content. ${count(shown.length)} characters shown${start > 0 ? ', continuing from ' + count(start) : ''}, nothing remains. ---`)
  }

  return text([head.join('\n'), '', shown, ...foot].join('\n'))
}

/**
 * Render the interactable-element snapshot: one ref per line.
 *
 * One line per element rather than a JSON dump, because the whole value of a
 * snapshot is that a model can scan it for the thing it wants and copy a two
 * character ref. A ref that arrives without its role or its accessible name is
 * not usable, so those two are never abbreviated away, and an element with no
 * name shows its selector instead - otherwise it is on the page but not
 * addressable by anything a model can read.
 */
function renderSnapshot(result, { profile, tab }) {
  const elements = Array.isArray(result?.elements) ? result.elements : null
  if (!elements) {
    return text(`${profile} ${tab}: unexpected snapshot payload.\n\n${jsonEcho(result)}`)
  }

  const start = numberOr(result?.start, 0)
  const total = numberOr(result?.total, elements.length)
  const shown = elements.slice(0, MAX_SNAPSHOT_ELEMENTS_RENDERED)
  const end = start + shown.length
  // Cut locally means the cursor is OURS to set: the broker said its page was
  // complete, but this layer withheld the tail, so the continuation is the
  // first element it did not render. Trusting the broker's `next` here ended
  // a truncated result with "nothing remains" and no way to reach the rest.
  const cutLocally = elements.length > shown.length
  const next = cutLocally ? end : numberOr(result?.next, null)

  const out = [`${profile} ${tab} - snapshot`]
  if (result?.url) out.push(String(result.url))
  if (result?.title) out.push(oneLine(result.title))
  out.push(sliceLine('elements', start, end, total))
  out.push('')

  if (shown.length === 0) {
    out.push('No interactable elements were found on this page.')
    out.push('')
    out.push('The page may still be loading, or its content may be inside an iframe: this snapshot covers the main frame only. Try browser_wait_for on a selector, or browser_read_page with format "text" to see what is there.')
    return text(out.join('\n'))
  }

  const refWidth = Math.max(...shown.map((el) => String(el?.ref || '?').length), 3)
  const roleWidth = Math.min(14, Math.max(...shown.map((el) => String(el?.role || el?.tag || '?').length), 6))

  for (const el of shown) {
    const ref = String(el?.ref || '?').padEnd(refWidth)
    const role = String(el?.role || el?.tag || '?').padEnd(roleWidth)
    const name = oneLine(el?.name)
    // No accessible name means the selector is the only handle a human or a
    // model can reason about, so it takes the name's place rather than being
    // dropped for width.
    const subject = name ? `"${name}"` : el?.selector ? `(unnamed) ${oneLine(el.selector)}` : '(unnamed)'
    out.push(`  ${ref}  ${role}  ${subject}${snapshotStateBits(el)}`)
  }

  if (cutLocally) {
    out.push('', `  ... and ${count(elements.length - shown.length)} more elements in this result, not listed. The cursor below continues from the first of them.`)
  }

  out.push('')
  if (next != null) {
    const remaining = Math.max(0, total - next)
    out.push(
      `--- MORE REMAINS: ${count(remaining)} of ${count(total)} interactable elements are not shown above. ---`,
      `--- Call browser_read_page again with format "snapshot" and cursor: "${next}" to continue from element ${count(next + 1)}. ---`
    )
  } else {
    out.push(`--- End of snapshot. ${count(shown.length)} elements shown, nothing remains. ---`)
  }
  if (result?.truncated || numberOr(result?.skipped, 0) > 0) {
    out.push(
      `--- The page has more interactable elements than the snapshot limit captured (${count(numberOr(result?.skipped, 0))} skipped). Raise the snapshot limit or narrow the page before relying on this being every element. ---`
    )
  }
  out.push('', 'Pass a ref exactly as shown to browser_click or browser_fill. Refs are renumbered by every new snapshot and are void after the page navigates.')

  return text(out.join('\n'))
}

/** The state a model needs before it clicks: disabled, checked, current value, link target. */
function snapshotStateBits(el) {
  const bits = []
  if (el?.disabled === true) bits.push('disabled')
  if (el?.checked === true) bits.push('checked')
  else if (el?.checked === false) bits.push('unchecked')
  if (el?.expanded === true) bits.push('expanded')
  else if (el?.expanded === false) bits.push('collapsed')
  if (el?.editable === true) bits.push('editable')
  if (el?.masked === true) bits.push('password, value never returned')
  else if (typeof el?.value === 'string' && el.value) bits.push(`value "${oneLine(el.value)}"`)
  if (el?.type) bits.push(`type ${el.type}`)
  // The tag only earns a column when it is not what the role already implies.
  if (el?.tag && el.tag !== el.role) bits.push(`<${el.tag}>`)
  if (el?.unique === false) bits.push('selector matches more than one element')
  if (el?.href) bits.push(`-> ${oneLine(el.href)}`)
  return bits.length ? `  [${bits.join(', ')}]` : ''
}

/** "characters 0 to 20,000 of 65,000" - the one line that says how much of the whole this is. */
function sliceLine(unit, start, end, total) {
  if (total == null) return `${unit} ${count(start)} to ${count(end)}`
  return `${unit} ${count(start)} to ${count(end)} of ${count(total)}`
}

function pickPageBody(result) {
  if (typeof result === 'string') return result
  if (!result || typeof result !== 'object') return null
  // `content` is what PageResult carries for text and html. The others are
  // tolerated because this layer never knows better than the browser side what
  // it sent, and a readable body beats an "unexpected payload" echo.
  for (const key of ['content', 'text', 'html']) {
    const v = result[key]
    if (typeof v === 'string') return v
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* Screenshots                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Decide inline image versus file on disk, and always report the numbers.
 *
 * The attempt count and final dimensions matter to the model: they are how it
 * learns that a full-page capture of this particular page will not fit and
 * that it should ask for a narrower one next time.
 *
 * @param {{b64:string,mime:string,width:number,height:number,bytes:number,attempts:number}} result
 * @param {{profile:string, tab:string, mode:'auto'|'inline'|'file'}} opts
 */
export function renderScreenshot(result, { profile, tab, mode }) {
  const b64 = typeof result?.b64 === 'string' ? result.b64 : null
  if (!b64) {
    return text(`${profile} ${tab}: unexpected screenshot payload.\n\n${jsonEcho(result)}`)
  }

  const mime = typeof result?.mime === 'string' ? result.mime : 'image/jpeg'
  const width = numberOr(result?.width, 0)
  const height = numberOr(result?.height, 0)
  const bytes = numberOr(result?.bytes, Math.floor((b64.length * 3) / 4))
  const attempts = numberOr(result?.attempts, 1)
  const kb = Math.max(1, Math.round(bytes / 1024))
  const dims = width && height ? `${width}x${height}` : 'unknown size'
  const stat = `${dims}, ${kb} KB, profile ${profile}, tab ${tab}, ${attempts} attempt${attempts === 1 ? '' : 's'}`

  const overBudget = b64.length > INLINE_SHOT_BUDGET_B64_CHARS
  const wantFile = mode === 'file' || (overBudget && mode !== 'inline')

  if (!wantFile) {
    const warn = overBudget
      ? `\nWARNING: ${b64.length.toLocaleString('en-US')} base64 characters is over the ${INLINE_SHOT_BUDGET_B64_CHARS.toLocaleString('en-US')} inline budget and was sent inline only because return was set to "inline". If this result came back empty, ask again with return "auto".`
      : ''
    return {
      content: [
        { type: 'image', data: b64, mimeType: mime },
        { type: 'text', text: stat + warn },
      ],
    }
  }

  const file = writeShot(b64, mime, profile, tab)
  const why =
    mode === 'file'
      ? 'Written to disk because return was set to "file".'
      : `Written to disk because ${b64.length.toLocaleString('en-US')} base64 characters is over the ${INLINE_SHOT_BUDGET_B64_CHARS.toLocaleString('en-US')} inline budget; an oversized image block is discarded whole rather than truncated.`

  return text(
    [
      stat,
      '',
      file,
      '',
      why,
      'Read that path directly to view the image, or ask again with a smaller maxWidth to get one inline.',
    ].join('\n')
  )
}

/** Screenshots kept on disk. Older ones are removed as new ones are written. */
export const SHOTS_KEEP = 200

function writeShot(b64, mime, profile, tab) {
  ensureBaseDir()
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')
  const name = `${safeName(profile)}_${safeName(tab)}_${stamp}.${ext}`
  const file = path.join(SHOTS_DIR, name)
  fs.writeFileSync(file, Buffer.from(b64, 'base64'))
  pruneShots()
  return file
}

/**
 * A long session that screenshots every few calls would otherwise grow the
 * shots directory without bound. Keep the newest SHOTS_KEEP; the file names
 * carry a sortable timestamp, so name order is age order. Best effort: a
 * failed prune must never fail the screenshot that triggered it.
 */
function pruneShots() {
  try {
    const files = fs
      .readdirSync(SHOTS_DIR)
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      .sort()
    for (const stale of files.slice(0, Math.max(0, files.length - SHOTS_KEEP))) {
      fs.rmSync(path.join(SHOTS_DIR, stale), { force: true })
    }
  } catch {
    /* the screenshot on disk is what matters; pruning is housekeeping */
  }
}

function safeName(s) {
  return String(s || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60)
}

/* -------------------------------------------------------------------------- */
/* Generic action results                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A write-tier confirmation: the sentence a human would say, the caveat if
 * there is one, then whatever the broker chose to return. Echoing the payload
 * matters because this layer does not know which fields an op returns and
 * silently dropping them would hide, for example, the URL a navigation actually
 * landed on.
 *
 * `note` is lifted ABOVE the echo because it is the field that says the
 * operation did something other than what the tool name implies - a synthetic
 * key event that ran listeners but performed no default action is reported
 * exactly there, and the first build buried it inside a JSON blob the model
 * skims. A caveat the model does not read is not a caveat.
 */
export function renderAction(summary, result) {
  const note = typeof result?.note === 'string' && result.note.trim() ? result.note.trim() : null
  const echo = jsonEcho(result)
  return text([summary, note ? `\nNOTE: ${note}` : null, echo ? `\n${echo}` : null].filter(Boolean).join('\n'))
}

/** Compact JSON for a payload, or null when there is nothing worth showing. */
export function jsonEcho(value) {
  if (value == null) return null
  if (typeof value === 'string') return value.length ? value : null
  if (typeof value !== 'object') return String(value)
  if (!Array.isArray(value) && Object.keys(value).length === 0) return null
  let json
  try {
    json = JSON.stringify(value, null, 2)
  } catch {
    return '(payload could not be serialized)'
  }
  if (json.length <= MAX_JSON_ECHO_CHARS) return json
  return `${json.slice(0, MAX_JSON_ECHO_CHARS)}\n... truncated at ${MAX_JSON_ECHO_CHARS.toLocaleString('en-US')} characters`
}

/* -------------------------------------------------------------------------- */
/* Small formatters                                                            */
/* -------------------------------------------------------------------------- */

export function fmtAge(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return 'unknown'
  const s = Math.round(n / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function fmtClock(at) {
  const n = Number(at)
  if (!Number.isFinite(n) || n <= 0) return '--:--:--'
  return new Date(n).toISOString().slice(11, 19)
}

function oneLine(s) {
  if (typeof s !== 'string') return ''
  return s.replace(/\s+/g, ' ').trim().slice(0, 140)
}

function numberOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * Grouped digits for prose. Never used for a cursor value: a cursor is passed
 * back verbatim, and "20,000" is not a number the extension can parse.
 */
function count(n) {
  const v = Number(n)
  return Number.isFinite(v) ? v.toLocaleString('en-US') : String(n)
}
