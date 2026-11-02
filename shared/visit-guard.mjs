/**
 * The visit guard: which addresses a reader must never open in a signed-in
 * profile, and how to tell that a page it did open is a wall rather than the
 * content it asked for.
 *
 * A read in a signed-in browser presses nothing, but the visit itself is real.
 * A sign-out link signs the profile out, an unsubscribe link unsubscribes, an
 * OAuth authorize link can grant access, a story marks the profile as a viewer,
 * and a download lands on the disk. Links a reader is handed come from search
 * results, feeds and comments, which are untrusted input, so the refusal is a
 * rule in code rather than a sentence in the README.
 *
 * `visitRefusal(url)` names why an address must not be opened, or returns null.
 * `detectWall(url, text)` names the wall a read landed on (a sign-in page, a
 * checkpoint, a "verify you are human" interstitial, a rate limit), or null, so
 * a script that reads many pages can stop at the first one instead of feeding
 * a login form to its caller as if it were the page.
 *
 * Both judge the address the way the browser will read it: the WHATWG URL
 * parser (the one Chromium uses) folds a backslash into a slash, maps a
 * full-width or upper-case host to its canonical form, and turns 0x7f000001 or
 * 2130706433 into 127.0.0.1, so a spelling trick reaches the same answer as
 * the plain address.
 */

import net from 'node:net'

/**
 * Path segments that act on the signed-in account by being opened. Matched
 * against a WHOLE segment, each segment decoded on its own, lower-cased and cut
 * at its first `;` and `.`, so `/logout`, `/users/sign_out`, `/logout.php` and
 * `/logout;jsessionid=1` are refused while a post at `/blog/how-oauth-works` is
 * not. `delete`, `confirm` and the rest are refused even where a page only
 * documents them: a refused read costs the caller another reader, an opened
 * action link is not undone.
 */
const ACTING_SEGMENT =
  /^(log[-_]?out|log[-_]?off|sign[-_]?out|sign[-_]?off|opt[-_]?out|unsubscribe|authorize|consent|delete|deactivate|confirm|activate|verify[-_]?email)$/

/** An OAuth path segment, which acts only when a grant segment follows it (`/oauth2/authorize`, `/o/oauth2/v2/auth`). */
const OAUTH_SEGMENT = /^oauth2?$/
const OAUTH_GRANT_SEGMENT = /^(auth|authorize|token|consent|approve)$/

/** Sites where opening a story records the profile as one of its viewers. */
const STORY_SITES = ['instagram.com', 'facebook.com']

/** Query parameter names and values that sign out or unsubscribe, matched whole. */
const ACTING_QUERY_WORD = /^(log[-_]?out|log[-_]?off|sign[-_]?out|sign[-_]?off|unsubscribe|opt[-_]?out)$/

/** A path ending in one of these is a download, which lands on the disk rather than in a tab. */
const DOWNLOAD_EXT =
  /\.(exe|msi|msix|appx|zip|7z|rar|gz|tgz|bz2|xz|dmg|pkg|deb|rpm|apk|iso|img|bat|cmd|ps1|vbs|jar|scr|torrent)$/

/** Host suffixes that only ever name a machine on a local network. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa']

/**
 * Address ranges that are not a public web server: this network, private,
 * carrier-grade NAT, loopback, link-local, protocol assignments, benchmarking,
 * multicast, reserved and broadcast; in IPv6 the unspecified and loopback
 * addresses, unique-local, link-local, multicast, and the forms that carry an
 * IPv4 address inside them (IPv4-compatible, NAT64, 6to4, Teredo), which can
 * carry a private one. An IPv4-mapped address (::ffff:7f00:1) is checked
 * against the IPv4 rules by BlockList itself.
 */
const NOT_PUBLIC = (() => {
  const list = new net.BlockList()
  for (const [net4, bits] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ]) {
    list.addSubnet(net4, bits, 'ipv4')
  }
  for (const [net6, bits] of [
    ['::', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['2001::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ]) {
    list.addSubnet(net6, bits, 'ipv6')
  }
  return list
})()

/** How deep a forwarded address inside a query is followed. Each level is a strictly shorter string, so this only bounds the work. */
const MAX_FORWARD_DEPTH = 4

function decode(text) {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/**
 * A path's segments, lower-cased, each percent-decoded ON ITS OWN, so one bad
 * escape leaves only its own segment undecoded. A decoded `/` or `\` splits a
 * segment again, because some servers route `%2F` as a separator.
 *
 * @param {string} pathname  the URL's pathname as the parser left it
 */
function pathSegments(pathname) {
  return String(pathname || '')
    .split('/')
    .flatMap((raw) => decode(raw).split(/[/\\]/))
    .map((s) => s.toLowerCase())
    .filter(Boolean)
}

/** The word a segment names: cut at its first `;` (matrix parameters) and its first `.` (an extension). */
function segmentWord(segment) {
  return segment.split(';')[0].split('.')[0]
}

/** True when an IP literal (a WHATWG-canonical host) is not a public address. */
function isNotPublicIp(host) {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  const family = net.isIP(bare)
  // BlockList checks an IPv4-mapped IPv6 address (::ffff:7f00:1) against the IPv4 rules itself.
  if (family === 4) return NOT_PUBLIC.check(bare, 'ipv4')
  if (family === 6) return NOT_PUBLIC.check(bare, 'ipv6')
  return false
}

/**
 * Why this address must not be opened in a signed-in profile, or null when it
 * may be.
 *
 * @param {string} url
 * @param {number} [depth]  internal: how many forwarding hops have been followed
 * @returns {string|null}
 */
export function visitRefusal(url, depth = 0) {
  let parsed
  try {
    parsed = new URL(String(url ?? '').trim())
  } catch {
    return 'it is not an absolute web address'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'only http and https pages are read'
  if (parsed.username || parsed.password) return 'the address carries a user name or password'

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return 'the address has no host'
  if (host === 'localhost' || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return 'it is a local address'
  if (net.isIP(host.replace(/^\[|\]$/g, ''))) {
    if (isNotPublicIp(host)) return 'it is a private or local network address'
  } else if (!host.includes('.')) {
    return 'it is a local address (a host name with no domain)'
  }

  const segments = pathSegments(parsed.pathname)
  const words = segments.map(segmentWord)
  let acting = segments.find((s, i) => ACTING_SEGMENT.test(words[i]))
  if (!acting) {
    const oauth = words.findIndex((w) => OAUTH_SEGMENT.test(w))
    if (oauth >= 0 && words.slice(oauth + 1).some((w) => OAUTH_GRANT_SEGMENT.test(w))) acting = segments[oauth]
  }
  if (!acting && hostMatches(host.replace(/^www\./, ''), STORY_SITES)) acting = segments.find((s, i) => words[i] === 'stories')
  if (acting) return `a /${acting} link acts on the signed-in account by being opened`
  if (DOWNLOAD_EXT.test((segments.at(-1) || '').split(';')[0])) return 'it is a download'

  // A redirector (a search engine's /url, a feed's /redirect) opens the address
  // it carries. Judged before the query's own words, so the refusal names the
  // address it forwards to.
  if (depth < MAX_FORWARD_DEPTH) {
    for (const value of parsed.searchParams.values()) {
      let inner = value.trim().replace(/\\/g, '/')
      if (inner.startsWith('//')) inner = `https:${inner}`
      if (!/^https?:/i.test(inner)) continue
      const why = visitRefusal(inner, depth + 1)
      if (why) return `it forwards to an address that is refused (${why})`
    }
  }

  for (const [name, value] of parsed.searchParams) {
    if (ACTING_QUERY_WORD.test(name.trim().toLowerCase()) || ACTING_QUERY_WORD.test(value.trim().toLowerCase())) {
      return 'its query signs out or unsubscribes'
    }
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* Walls                                                                       */
/* -------------------------------------------------------------------------- */

/** A page longer than this is never called a wall on its words alone: a real article can mention "sign in". */
export const WALL_SHORT_CHARS = 3000

/** Only the opening of a short page is read for wall wording. */
export const WALL_HEAD_CHARS = 1500

/**
 * Sign-in and checkpoint paths that mean the same thing on any site. Matched
 * from the start of the path, or after one short prefix segment (`/m/`, `/en/`,
 * `/en-us/`), as whole segments that may carry an extension or `;` parameters
 * (`/login.php`, `/login;jsessionid=1`). A sign-in path deeper in a site
 * (`/docs/api/login`) is a page about signing in, not a wall.
 */
const WALL_PREFIX = String.raw`(?:[a-z]{1,2}(?:[-_][a-z]{2})?\/)?`
const WALL_END = String.raw`(?:\/|\.|;|$)`
const WALL_PATH_ANY = [
  [
    'login',
    new RegExp(
      String.raw`^\/${WALL_PREFIX}(?:login|log-in|signin|sign-in|sign_in|logon|authwall|i\/flow\/login|accounts\/login|account\/login|uas\/login|users\/sign_in|auth\/login)${WALL_END}`
    ),
  ],
  ['checkpoint', new RegExp(String.raw`^\/${WALL_PREFIX}checkpoint${WALL_END}`)],
]

/** A host that exists to sign people in (login.microsoftonline.com, signin.example.com, sso.example.com). */
const SIGN_IN_HOST = /^(login|signin|sso)\./

/** Paths that are a wall only on the site that uses them. */
const WALL_PATH_BY_HOST = [
  [['x.com', 'twitter.com'], [['locked', /^\/account\/access(\/|$)/]]],
  [['instagram.com'], [['checkpoint', /^\/challenge(\/|$)/]]],
  [['accounts.google.com'], [['login', /^\/(servicelogin|signin|v3\/signin|interactivelogin)(\/|$)/]]],
  [['google.com'], [['bot check', /^\/sorry(\/|$)/]]],
]

/** Wall wording, read only on a short page and only in its opening. */
const WALL_TEXT = [
  ['challenge', /^just a moment\b/],
  ['bot check', /unusual traffic from your computer|sign in to confirm you're not a bot/],
  ['rate limited', /\btoo many requests\b|you are rate limited|we limit how often|you've reached the (weekly|monthly|commercial use) limit/],
  ['checkpoint', /help us confirm it's you|let's do a quick security check/],
  ['blocked', /you're temporarily blocked|blocked by network security/],
  [
    'login',
    /\byou (must|need to) (log|sign) in\b|\b(log|sign) in to (continue|view|see)\b|\bplease (log|sign) in\b|\bsign in to x\b|\bjoin now to see\b|\bsign up to see\b|\blog in to (instagram|facebook)\b/,
  ],
]

/** An interstitial challenge anywhere; on a post's own address only its opening line counts (see detectWall). */
const CHALLENGE_TEXT = /performing security verification|checking your browser before accessing|verify you are human|are you a robot/

/** Paths that are a post, a thread or a video: a short post ABOUT captchas is not a challenge page. */
const POST_PATH = /\/status\/\d|\/comments\/|\/posts?\/|\/feed\/update\/|\/reel\/|\/p\/|\/watch|\/shorts\/|\/videos?\/|\/item\b/

function hostMatches(host, domains) {
  return domains.some((d) => host === d || host.endsWith(`.${d}`))
}

/**
 * Name the wall a read landed on, or return null.
 *
 * The landed address is judged first, by whole path segments. Then, only on a
 * short page and only in its opening, the wording walls use. A long page is
 * never a wall on its words: a long article that quotes "verify you are human"
 * is still the article.
 *
 * @param {string} url   where the tab landed (after any redirect)
 * @param {string} text  the page's readable text
 * @returns {string|null}  e.g. "login (/i/flow/login)", "challenge", "rate limited"
 */
export function detectWall(url, text) {
  let path = '/'
  let host = ''
  try {
    const parsed = new URL(String(url ?? ''))
    path = decode(parsed.pathname).toLowerCase() || '/'
    host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    // no address to judge; the words still can be
  }
  const shown = path.slice(0, 60)
  for (const [domains, rules] of WALL_PATH_BY_HOST) {
    if (!hostMatches(host, domains)) continue
    for (const [name, pattern] of rules) if (pattern.test(path)) return `${name} (${shown})`
  }
  if (SIGN_IN_HOST.test(host)) return `login (${host})`
  for (const [name, pattern] of WALL_PATH_ANY) if (pattern.test(path)) return `${name} (${shown})`

  const flat = String(text ?? '')
    .replace(/’/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  if (flat.length >= WALL_SHORT_CHARS) return null
  const head = flat.slice(0, WALL_HEAD_CHARS)
  for (const [name, pattern] of WALL_TEXT) if (pattern.test(head)) return name
  if (!POST_PATH.test(path) && CHALLENGE_TEXT.test(head)) return 'challenge'
  return null
}
