/**
 * The visit guard: the addresses a signed-in reader refuses to open, and the
 * walls it names after a read. Both are pure functions over a string, so every
 * case here is the exact address or text, and the expected answer.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { WALL_SHORT_CHARS, detectWall, visitRefusal } from '../shared/visit-guard.mjs'

/* -------------------------------------------------------------------------- */
/* visitRefusal                                                                */
/* -------------------------------------------------------------------------- */

test('ordinary pages, posts and threads may be opened', () => {
  for (const url of [
    'https://example.com/',
    'https://example.com/post/123',
    'https://news.example.org/item?id=41',
    'https://forum.example.net/r/topic/comments/abc/a_title/',
    'https://example.com/blog/how-oauth-works',
    'https://example.com/docs/delete-an-account-safely',
    'https://example.com/search?q=sign+in+help',
    'http://example.com:8080/a.html',
    'https://203.0.113.9/status',
  ]) {
    assert.equal(visitRefusal(url), null, url)
  }
})

test('a link that acts on the account by being opened is refused, whatever its spelling', () => {
  for (const url of [
    'https://example.com/logout',
    'https://example.com/account/sign-out',
    'https://example.com/users/sign_out',
    'https://example.com/logout.php',
    'https://example.com/LogOff',
    'https://example.com/mail/unsubscribe?id=9',
    'https://example.com/oauth/authorize?client_id=x',
    'https://example.com/oauth2/v1/token',
    'https://example.com/account/delete',
    'https://example.com/settings/deactivate',
    'https://instagram.com/stories/someone/123',
    'https://example.com/newsletter/confirm?t=abc',
    'https://example.com/account/activate/xyz',
    'https://example.com/verify-email?token=abc',
    'https://example.com/%6c%6f%67%6f%75%74',
    'https://example.com\\logout',
  ]) {
    assert.match(visitRefusal(url) || '', /acts on the signed-in account/, url)
  }
})

test('each path segment is decoded on its own, so one bad escape cannot hide another segment', () => {
  for (const url of [
    'https://example.com/a%E0%A4%A/%6Cogout',
    'https://example.com/%ZZ/logout',
    'https://example.com/a%2Flogout',
    'https://example.com/a%5Clogout',
  ]) {
    assert.match(visitRefusal(url) || '', /acts on the signed-in account/, url)
  }
})

test('a segment is matched without its ; parameters, and the opt-out and sign-off spellings count', () => {
  for (const url of [
    'https://example.com/logout;jsessionid=1',
    'https://example.com/logout.do;jsessionid=1',
    'https://example.com/signoff',
    'https://example.com/sign_off',
    'https://example.com/optout',
    'https://example.com/email/opt-out?u=1',
  ]) {
    assert.match(visitRefusal(url) || '', /acts on the signed-in account/, url)
  }
})

test('a query that signs out or unsubscribes is refused', () => {
  assert.match(visitRefusal('https://example.com/?action=logout'), /signs out or unsubscribes/)
  assert.match(visitRefusal('https://example.com/list?do=Unsubscribe&id=1'), /signs out or unsubscribes/)
  assert.match(visitRefusal('https://example.com/?logout=1'), /signs out or unsubscribes/)
  assert.match(visitRefusal('https://example.com/?a=sign_out'), /signs out or unsubscribes/)
})

test('reading pages that only mention those words are not refused', () => {
  for (const url of [
    'https://www.google.com/search?q=how+to+logout+of+gmail',
    'https://shop.example.com/list?catalog_output=1',
    'https://developers.google.com/identity/protocols/oauth2',
    'https://example.com/docs/oauth2/getting-started',
    'https://news.example.com/stories/2026/11/02/headline',
  ]) {
    assert.equal(visitRefusal(url), null, url)
  }
})

test('an OAuth grant, and a story on a site that records its viewers, are still refused', () => {
  for (const url of [
    'https://accounts.example.com/o/oauth2/v2/auth?client_id=x',
    'https://example.com/oauth/authorize?client_id=x',
    'https://example.com/consent?client_id=x',
    'https://www.instagram.com/stories/someone/123/',
    'https://www.facebook.com/stories/123',
  ]) {
    assert.match(visitRefusal(url) || '', /acts on the signed-in account/, url)
  }
})

test('multicast, reserved, benchmarking and IPv4-embedding IPv6 addresses are refused too', () => {
  for (const url of [
    'http://224.0.0.1/',
    'http://239.255.255.250/',
    'http://240.0.0.1/',
    'http://255.255.255.255/',
    'http://198.18.0.1/',
    'http://192.0.0.8/',
    'http://[::7f00:1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[ff02::1]/',
    'http://[2002:7f00:1::]/',
    'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/',
    'http://[64:ff9b:1::a00:1]/',
  ]) {
    assert.match(visitRefusal(url) || '', /private or local network address/, url)
  }
})

test('a download is refused', () => {
  for (const url of ['https://example.com/setup.exe', 'https://example.com/files/archive.ZIP', 'https://example.com/a.torrent']) {
    assert.equal(visitRefusal(url), 'it is a download', url)
  }
})

test('local and private network addresses are refused, however the number is written', () => {
  for (const url of [
    'http://localhost:3000/',
    'http://LOCALHOST/',
    'http://printer.local/',
    'http://intranet/',
    'http://router.lan/admin',
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://10.1.2.3/',
    'http://172.20.0.5/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://[::ffff:127.0.0.1]/',
  ]) {
    assert.match(visitRefusal(url) || '', /local/, url)
  }
})

test('an address with a user name or password in it is refused', () => {
  assert.match(visitRefusal('https://user:secret@example.com/'), /user name or password/)
  assert.match(visitRefusal('https://user@example.com/'), /user name or password/)
})

test('only http and https are read', () => {
  for (const url of ['file:///C:/x.html', 'ftp://example.com/', 'javascript:alert(1)', 'chrome://settings', 'data:text/html,hi']) {
    assert.equal(visitRefusal(url), 'only http and https pages are read', url)
  }
  assert.equal(visitRefusal('not a url'), 'it is not an absolute web address')
  assert.equal(visitRefusal(''), 'it is not an absolute web address')
})

test('a redirector carrying a refused address is refused with it', () => {
  assert.match(
    visitRefusal('https://search.example.com/url?q=https%3A%2F%2Fexample.com%2Flogout'),
    /forwards to an address that is refused \(a \/logout link/
  )
  assert.match(visitRefusal('https://example.com/redirect?to=//127.0.0.1/'), /forwards to .*local/)
  assert.equal(visitRefusal('https://search.example.com/url?q=https%3A%2F%2Fexample.com%2Fpost'), null)
})

/* -------------------------------------------------------------------------- */
/* detectWall                                                                  */
/* -------------------------------------------------------------------------- */

const article = 'An article paragraph that is long enough to read as content. '.repeat(80)

test('a sign-in or checkpoint address is a wall on any site', () => {
  assert.equal(detectWall('https://example.com/login?next=%2Fpost', 'Email Password'), 'login (/login)')
  assert.equal(detectWall('https://example.com/i/flow/login', ''), 'login (/i/flow/login)')
  assert.equal(detectWall('https://www.example.com/checkpoint/challenge/x', article), 'checkpoint (/checkpoint/challenge/x)')
  assert.equal(detectWall('https://example.com/users/sign_in', article), 'login (/users/sign_in)')
})

test('a sign-in path with an extension, ; parameters or a short prefix is a wall, and a sign-in host is one', () => {
  assert.equal(detectWall('https://www.facebook.com/login.php?next=x', article), 'login (/login.php)')
  assert.equal(detectWall('https://example.com/Login.aspx', article), 'login (/login.aspx)')
  assert.equal(detectWall('https://example.com/login;jsessionid=1', article), 'login (/login;jsessionid=1)')
  assert.equal(detectWall('https://medium.com/m/signin?redirect=x', article), 'login (/m/signin)')
  assert.equal(detectWall('https://example.com/en-us/login', article), 'login (/en-us/login)')
  assert.equal(detectWall('https://login.microsoftonline.com/common/oauth2/v2.0/authorize', article), 'login (login.microsoftonline.com)')
  assert.equal(detectWall('https://example.com/docs/api/login', article), null, 'a page ABOUT signing in, deeper in a site, is a page')
  assert.equal(detectWall('https://example.com/login-help', article), null)
})

test('a wall path known only on one site counts only there', () => {
  assert.equal(detectWall('https://x.com/account/access', ''), 'locked (/account/access)')
  assert.equal(detectWall('https://www.instagram.com/challenge/', ''), 'checkpoint (/challenge/)')
  assert.equal(detectWall('https://www.google.com/sorry/index', ''), 'bot check (/sorry/index)')
  assert.equal(detectWall('https://code.example.com/challenge/42', article), null, 'a coding challenge is a page')
  assert.equal(detectWall('https://example.com/account/access', article), null)
})

test('a short page with wall wording is a wall', () => {
  const at = 'https://example.com/some/page'
  assert.equal(detectWall(at, 'Just a moment... Checking your browser'), 'challenge')
  assert.equal(detectWall(at, 'Please verify you are human to continue.'), 'challenge')
  assert.equal(detectWall(at, 'Our systems have detected unusual traffic from your computer network.'), 'bot check')
  assert.equal(detectWall(at, "Sign in to confirm you\u2019re not a bot"), 'bot check')
  assert.equal(detectWall(at, '429 Too Many Requests'), 'rate limited')
  assert.equal(detectWall(at, "Help us confirm it's you"), 'checkpoint')
  assert.equal(detectWall(at, 'You must log in to continue.'), 'login')
  assert.equal(detectWall(at, 'Join now to see what you are missing'), 'login')
})

test('a long page is never a wall on its words, and a post about captchas is a post', () => {
  const quoting = `Verify you are human. ${article}`
  assert.ok(quoting.length >= WALL_SHORT_CHARS)
  assert.equal(detectWall('https://example.com/article', quoting), null)
  assert.equal(detectWall('https://example.com/status/123', 'A post: are you a robot? Here is why captchas fail.'), null)
  assert.equal(detectWall('https://example.com/page', 'A short page with a Log in link in its header and a real paragraph.'), null)
  assert.equal(detectWall('https://example.com/page', ''), null)
  assert.equal(detectWall('not a url', 'Hello'), null)
})
