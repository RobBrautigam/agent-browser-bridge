/**
 * The token relay, the broker's half.
 *
 * Some web apps sign their own API calls with a short-lived bearer token that
 * the page mints from the browser's signed-in session, and a tool on this
 * machine that talks to the same API stops working every time that token
 * expires. The relay keeps the tool's copy fresh with nobody copying anything:
 * the extension in ONE named profile watches the app's own requests for the
 * header (extension/lib/token-relay.js) and hands each newer token here, and
 * this module writes it to the ONE file the operator named, and nowhere else.
 *
 * Off by default. A relay exists only when the operator writes it into
 * token-relay.json in the bridge's state folder, which is read on every use, so
 * a change needs no broker restart:
 *
 *   {
 *     "relays": [{
 *       "name": "tracker",                              a-z, 0-9 and hyphens
 *       "profile": "chrome-work",                       the profile's label
 *       "urls": ["https://*.tracker.example/*"],        requests worth watching
 *       "initiators": ["https://app.tracker.example"],  the page that sends them
 *       "header": "authorization",                      optional, the default
 *       "scheme": "Bearer",                             optional, the default
 *       "claims": { "user": 123 },                      optional, must all match
 *       "maxLifetimeHours": 49,                         optional, the app's token life
 *       "sink": "C:/Users/me/.cache/tool/token.txt",    absolute; folder must exist
 *       "keepAlive": {                                  optional
 *         "url": "https://app.tracker.example/list",    on an initiator's origin
 *         "renewBeforeHours": 24
 *       }
 *     }]
 *   }
 *
 * What stops this being a way to move a secret somewhere it should not go:
 *
 *   - Only the extension may originate the request (HOST_ONLY_OPS), and only for
 *     ITSELF: the broker resolves the profile from the connection and refuses a
 *     relay whose profile is another line, or a line nobody has claimed.
 *   - The extension is told which requests to watch and nothing else: never
 *     the file, never the expected claims.
 *   - The token is judged by what it says about itself (tokenVerdict in the
 *     contract): a JSON Web Token, alive, issued no later than now, living no
 *     longer than the relay allows, carrying every claim the operator named.
 *   - Tokens are ordered by when they were issued, never by when they expire:
 *     only a token issued later than the one in the file replaces it. An old
 *     tab cannot undo a fresh token, and a forged one (a script on the app's
 *     own page can send any header it likes, and nobody here holds the key to
 *     check a signature) is replaced by the next token the app really mints.
 *   - It is written to the named file and nowhere else, one write at a time per
 *     file, through a temporary file in the same folder that is renamed over
 *     it, so a reader never sees a half-written token. The temporary file is
 *     removed whatever happens. The token is never logged, audited, echoed or
 *     returned.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { BASE_DIR } from '../shared/paths.mjs'
import { ERR, LABEL_PATTERN, TOKEN_RELAY, tokenVerdict } from '../shared/protocol.mjs'

export const TOKEN_RELAY_FILE = path.join(BASE_DIR, 'token-relay.json')

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
const HEADER_PATTERN = /^[A-Za-z0-9-]{1,64}$/
const SCHEME_PATTERN = /^[A-Za-z]{0,32}$/
/**
 * A watch pattern: https only, a real host (a leading "*." is allowed, but the
 * rest must still have a dot, so "*.com" is refused), then a path.
 */
const URL_PATTERN = /^https:\/\/(\*\.)?([a-z0-9-]+\.)+[a-z0-9-]+\/.*$/
/** An initiator is an exact https origin: no wildcard, no path. */
const ORIGIN_PATTERN = /^https:\/\/([a-z0-9-]+\.)+[a-z0-9-]+(:\d{1,5})?$/

/**
 * The relays the operator configured, each checked; a relay that fails a check
 * is dropped whole and named in `problems`, never half-applied.
 *
 * @returns {{relays: object[], problems: string[]}}
 */
export function loadTokenRelays(file = TOKEN_RELAY_FILE) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return { relays: [], problems: [] }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { relays: [], problems: [`${path.basename(file)} is not valid JSON`] }
  }
  const list = parsed && Array.isArray(parsed.relays) ? parsed.relays : []
  const relays = []
  const problems = []
  const seen = new Set()
  for (const [index, entry] of list.entries()) {
    const problem = checkRelay(entry)
    if (problem) {
      problems.push(`relay ${index + 1}: ${problem}`)
      continue
    }
    if (seen.has(entry.name)) {
      problems.push(`relay ${index + 1}: the name "${entry.name}" is used twice`)
      continue
    }
    seen.add(entry.name)
    relays.push(normalize(entry))
  }
  return { relays, problems }
}

function checkRelay(entry) {
  if (!entry || typeof entry !== 'object') return 'not an object'
  if (typeof entry.name !== 'string' || !NAME_PATTERN.test(entry.name)) return 'its name is not lowercase letters, digits and hyphens'
  if (typeof entry.profile !== 'string' || !LABEL_PATTERN.test(entry.profile)) return 'its profile is not a profile label'
  if (!nonEmptyStrings(entry.urls) || !entry.urls.every((u) => URL_PATTERN.test(u))) {
    return 'its urls must be https patterns on a named host'
  }
  if (!nonEmptyStrings(entry.initiators) || !entry.initiators.every((o) => ORIGIN_PATTERN.test(o))) {
    return 'its initiators must be exact https origins'
  }
  if (entry.header !== undefined && (typeof entry.header !== 'string' || !HEADER_PATTERN.test(entry.header))) {
    return 'its header is not a header name'
  }
  if (entry.scheme !== undefined && (typeof entry.scheme !== 'string' || !SCHEME_PATTERN.test(entry.scheme))) {
    return 'its scheme is not a word'
  }
  if (entry.claims !== undefined) {
    if (!entry.claims || typeof entry.claims !== 'object' || Array.isArray(entry.claims)) return 'its claims are not an object'
    for (const value of Object.values(entry.claims)) {
      if (typeof value !== 'string' && typeof value !== 'number') return 'a claim it expects is not a string or a number'
    }
  }
  if (entry.maxLifetimeHours !== undefined) {
    const hours = Number(entry.maxLifetimeHours)
    if (!(Number.isFinite(hours) && hours >= 1 && hours * 3_600_000 <= TOKEN_RELAY.MAX_LIFETIME_MS)) {
      return 'its maxLifetimeHours is out of range'
    }
  }
  if (typeof entry.sink !== 'string' || !path.isAbsolute(entry.sink)) return 'its sink is not an absolute path'
  if (entry.keepAlive !== undefined) {
    const k = entry.keepAlive
    if (!k || typeof k !== 'object') return 'its keepAlive is not an object'
    let origin = null
    try {
      origin = new URL(k.url).origin
    } catch {
      origin = null
    }
    if (!origin || !entry.initiators.includes(origin)) return "its keepAlive url is not on one of its initiators' origins"
    const hours = k.renewBeforeHours === undefined ? null : Number(k.renewBeforeHours)
    if (hours !== null && !(Number.isFinite(hours) && hours >= 1 && hours * 3_600_000 <= TOKEN_RELAY.MAX_LIFETIME_MS)) {
      return 'its keepAlive renewBeforeHours is out of range'
    }
  }
  return null
}

function nonEmptyStrings(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every((v) => typeof v === 'string' && v.length <= 512)
}

function normalize(entry) {
  return {
    name: entry.name,
    profile: entry.profile,
    urls: [...entry.urls],
    initiators: [...entry.initiators],
    header: (entry.header || 'authorization').toLowerCase(),
    scheme: entry.scheme === undefined ? 'Bearer' : entry.scheme,
    claims: entry.claims ? { ...entry.claims } : null,
    maxLifetimeMs:
      entry.maxLifetimeHours === undefined ? TOKEN_RELAY.MAX_LIFETIME_MS : Number(entry.maxLifetimeHours) * 3_600_000,
    sink: path.resolve(entry.sink),
    keepAlive: entry.keepAlive
      ? {
          url: entry.keepAlive.url,
          renewBeforeHours:
            entry.keepAlive.renewBeforeHours === undefined
              ? TOKEN_RELAY.RENEW_BEFORE_MS / 3_600_000
              : Number(entry.keepAlive.renewBeforeHours),
        }
      : null,
  }
}

/**
 * What one extension is told: the relays for ITS line, and only the parts it
 * needs to watch requests and keep a tab alive. Never the file, never the
 * expected claims. An unclaimed line is told nothing, because nobody has said
 * which signed-in session it is.
 */
export function relaySpecsFor(relays, { label, claimed }) {
  if (!claimed || typeof label !== 'string') return []
  return relays
    .filter((r) => r.profile === label)
    .map((r) => ({
      name: r.name,
      urls: [...r.urls],
      initiators: [...r.initiators],
      header: r.header,
      scheme: r.scheme,
      // The lifetime cap is no secret, and with it the extension can skip what
      // the broker would refuse and pace its keep-alive to the app's tokens.
      maxLifetimeHours: r.maxLifetimeMs / 3_600_000,
      keepAlive: r.keepAlive ? { ...r.keepAlive } : null,
    }))
}

/** One write at a time per file: the check against the held token and the write are one step. */
const sinkQueues = new Map()

function oneAtATime(file, fn) {
  const before = sinkQueues.get(file) || Promise.resolve()
  const run = before.then(fn, fn)
  const settled = run.then(
    () => undefined,
    () => undefined
  )
  sinkQueues.set(file, settled)
  settled.then(() => {
    if (sinkQueues.get(file) === settled) sinkQueues.delete(file)
  })
  return run
}

/**
 * Judge one relayed token and, when it is better than the file's, write it.
 *
 * @returns {Promise<{ok: true, written: boolean, exp: number, iat: number, note?: string} |
 *                   {ok: false, code: string, message: string}>}
 */
export async function acceptRelayedToken({ relays, label, claimed, name, token, now = Date.now() }) {
  const relay = relays.find((r) => r.name === name)
  if (!relay) return refuse(ERR.BAD_REQUEST, `There is no token relay named "${String(name).slice(0, 40)}".`)
  return oneAtATime(relay.sink, () => judgeAndWrite({ relay, label, claimed, token, now }))
}

async function judgeAndWrite({ relay, label, claimed, token, now }) {
  if (relay.profile !== label) {
    return refuse(ERR.UNAUTHORIZED, `The relay "${relay.name}" belongs to another profile, so this one may not supply it.`)
  }
  if (!claimed) {
    return refuse(ERR.PROFILE_UNCLAIMED, `Profile "${label}" has not been claimed, so its session cannot supply a token.`)
  }

  const judged = { now, claims: relay.claims, maxLifetimeMs: relay.maxLifetimeMs }
  const verdict = tokenVerdict(token, judged)
  if (!verdict.ok) return refuse(ERR.BAD_REQUEST, `Not relayed: ${verdict.reason}.`)

  // The token in the file stays when it is still good for this relay and was
  // issued no earlier: an older tab's token never replaces a newer one, and
  // the next token the app mints always replaces whatever came before it.
  const held = readHeld(relay.sink)
  if (held !== null) {
    const kept = tokenVerdict(held, judged)
    if (kept.ok && kept.iat >= verdict.iat) {
      return { ok: true, written: false, exp: kept.exp, iat: kept.iat, note: 'the file already holds a token issued as late or later' }
    }
  }

  const folder = path.dirname(relay.sink)
  try {
    if (!fs.statSync(folder).isDirectory()) throw new Error('not a folder')
  } catch {
    return refuse(ERR.UNSUPPORTED, `The folder for relay "${relay.name}"'s file does not exist, and the relay never creates one.`)
  }

  try {
    await writeReplacing(relay.sink, token)
  } catch (err) {
    // The error names a path and a code, never the content.
    return refuse(ERR.UNSUPPORTED, `Writing relay "${relay.name}"'s file failed (${err && err.code ? err.code : 'unknown error'}).`)
  }
  return { ok: true, written: true, exp: verdict.exp, iat: verdict.iat }
}

function refuse(code, message) {
  return { ok: false, code, message }
}

function readHeld(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    return null
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Write the token beside the file and rename it over the file.
 *
 * A reader then sees the old token or the new one, never an empty or half
 * written file. Windows refuses the rename while another process has the file
 * open, which a reader does for a moment, so it is retried briefly; and the
 * temporary copy is removed whatever happens, so the token is never left in a
 * second file.
 */
async function writeReplacing(file, token) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(8).toString('hex')}.tmp`)
  try {
    // Inside the try, so a write that fails part-way still has its copy removed.
    fs.writeFileSync(temp, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temp, file)
        return
      } catch (err) {
        const busy = err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')
        if (!busy || attempt >= 5) throw err
        await sleep(40 * (attempt + 1))
      }
    }
  } finally {
    try {
      fs.unlinkSync(temp)
    } catch {
      // Renamed away, which is the normal case: there is nothing left to remove.
    }
  }
}
