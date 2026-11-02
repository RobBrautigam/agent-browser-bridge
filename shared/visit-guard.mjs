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
 * against a WHOLE segment (before any extension), decoded and lower-cased, so
 * `/logout`, `/users/sign_out` and `/logout.php` are refused while a post at
 * `/blog/how-oauth-works` is not.
 */
const ACTING_SEGMENT =
  /^(log[-_]?out|log[-_]?off|sign[-_]?out|unsubscribe|oauth2?|authorize|delete|deactivate|stories|confirm|activate|verify[-_]?email)$/

/** A path ending in one of these is a download, which lands on the disk rather than in a tab. */
const DOWNLOAD_EXT =
  /\.(exe|msi|msix|appx|zip|7z|rar|gz|tgz|bz2|xz|dmg|pkg|deb|rpm|apk|iso|img|bat|cmd|ps1|vbs|jar|scr|torrent)$/

/** Host suffixes that only ever name a machine on a local network. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa']

/** Address ranges that are not on the public internet: loopback, private, link-local, carrier-grade NAT, unique-local. */
const NOT_PUBLIC = (() => {
  const list = new net.BlockList()
  list.addSubnet('0.0.0.0', 8, 'ipv4')
  list.addSubnet('10.0.0.0', 8, 'ipv4')
  list.addSubnet('100.64.0.0', 10, 'ipv4')
  list.addSubnet('127.0.0.0', 8, 'ipv4')
  list.addSubnet('169.254.0.0', 16, 'ipv4')
  list.addSubnet('172.16.0.0', 12, 'ipv4')
  list.addSubnet('192.168.0.0', 16, 'ipv4')
  list.addSubnet('::', 127, 'ipv6') // :: and ::1
  list.addSubnet('fc00::', 7, 'ipv6')
  list.addSubnet('fe80::', 10, 'ipv6')
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

  const path = decode(parsed.pathname).toLowerCase()
  const segments = path.split('/').filter(Boolean)
  const acting = segments.find((s) => ACTING_SEGMENT.test(s.split('.')[0]))
  if (acting) return `a /${acting} link acts on the signed-in account by being opened`
  if (DOWNLOAD_EXT.test(path)) return 'it is a download'

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

  const query = decode(parsed.search).toLowerCase()
  if (/log[-_]?out|sign[-_]?out|unsubscribe/.test(query)) return 'its query signs out or unsubscribes'
  return null
}

/* -------------------------------------------------------------------------- */
/* Walls                                                                       */
/* -------------------------------------------------------------------------- */

/** A page longer than this is never called a wall on its words alone: a real article can mention "sign in". */
export const WALL_SHORT_CHARS = 3000

/** Only the opening of a short page is read for wall wording. */
export const WALL_HEAD_CHARS = 1500

/** Sign-in and checkpoint paths that mean the same thing on any site. Matched from the start of the path, whole segments. */
const WALL_PATH_ANY = [
  ['login', /^\/(login|log-in|signin|sign-in|sign_in|logon|authwall|i\/flow\/login|accounts\/login|account\/login|uas\/login|users\/sign_in|auth\/login)(\/|$)/],
  ['checkpoint', /^\/checkpoint(\/|$)/],
]

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
