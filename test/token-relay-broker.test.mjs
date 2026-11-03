/**
 * The broker's half of the token relay: which relays the operator configured,
 * what an extension is told about them, and when a token reaches the one file
 * a relay names.
 *
 * The assertions read the FILE, because the file is the only place the token
 * may land, and they read every answer for the token itself, because the
 * answer travels back over the pipe and into logs.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ERR } from '../shared/protocol.mjs'
import { acceptRelayedToken, loadTokenRelays, relaySpecsFor } from '../bridged/token-relay.mjs'

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)
const HOUR = 3600

function b64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

/** A token shaped like a real one: header, payload, signature. */
function jwt(payload) {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.c2lnbmF0dXJlLXBhcnQ`
}

const iat = Math.floor(NOW / 1000)
const FRESH = jwt({ user: 42, workspace_id: 'w1', iat, exp: iat + 48 * HOUR })
const FRESHER = jwt({ user: 42, workspace_id: 'w1', iat: iat + HOUR, exp: iat + 49 * HOUR })
const OTHER_USER = jwt({ user: 7, iat, exp: iat + 48 * HOUR })
const EXPIRED = jwt({ user: 42, iat: iat - 50 * HOUR, exp: iat - 2 * HOUR })
const FAR_FUTURE = jwt({ user: 42, iat, exp: iat + 400 * 24 * HOUR })

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'))
}

function config(dir, overrides = {}) {
  return {
    relays: [
      {
        name: 'tracker',
        profile: 'chrome-work',
        urls: ['https://*.tracker.example/*'],
        initiators: ['https://app.tracker.example'],
        claims: { user: 42 },
        sink: path.join(dir, 'token.txt'),
        keepAlive: { url: 'https://app.tracker.example/list', renewBeforeHours: 20 },
        ...overrides,
      },
    ],
  }
}

function writeConfig(dir, value) {
  const file = path.join(dir, 'token-relay.json')
  fs.writeFileSync(file, JSON.stringify(value))
  return file
}

function load(dir, value) {
  return loadTokenRelays(writeConfig(dir, value))
}

const accept = (relays, overrides = {}) =>
  acceptRelayedToken({ relays, label: 'chrome-work', claimed: true, name: 'tracker', token: FRESH, now: NOW, ...overrides })

test('no settings file means no relays, and nothing is told to watch anything', () => {
  const dir = tempDir()
  const { relays, problems } = loadTokenRelays(path.join(dir, 'absent.json'))
  assert.deepEqual(relays, [])
  assert.deepEqual(problems, [])
  assert.deepEqual(relaySpecsFor(relays, { label: 'chrome-work', claimed: true }), [])
})

test('a relay that would watch everything, write a relative path or name no initiator is dropped', () => {
  const dir = tempDir()
  for (const bad of [
    { urls: ['<all_urls>'] },
    { urls: ['*://*/*'] },
    { urls: ['https://*.com/*'] },
    { urls: ['http://app.tracker.example/*'] },
    { initiators: [] },
    { initiators: ['https://*.tracker.example'] },
    { sink: 'token.txt' },
    { profile: 'Not A Label' },
    { claims: { user: { nested: true } } },
    { keepAlive: { url: 'https://elsewhere.example/', renewBeforeHours: 20 } },
  ]) {
    const { relays, problems } = load(dir, config(dir, bad))
    assert.equal(relays.length, 0, `accepted ${JSON.stringify(bad)}`)
    assert.equal(problems.length, 1, `no problem named for ${JSON.stringify(bad)}`)
  }
})

test('an extension is told only its own relays, without the file or the claims', () => {
  const dir = tempDir()
  const { relays } = load(dir, config(dir))
  assert.equal(relays.length, 1)
  const specs = relaySpecsFor(relays, { label: 'chrome-work', claimed: true })
  assert.equal(specs.length, 1)
  assert.equal(specs[0].name, 'tracker')
  assert.deepEqual(specs[0].urls, ['https://*.tracker.example/*'])
  assert.equal(specs[0].keepAlive.renewBeforeHours, 20)
  assert.ok(!('sink' in specs[0]), 'the file path was sent to the extension')
  assert.ok(!('claims' in specs[0]), 'the expected claims were sent to the extension')
  // Another profile, or this one unclaimed, is told nothing.
  assert.deepEqual(relaySpecsFor(relays, { label: 'chrome-home', claimed: true }), [])
  assert.deepEqual(relaySpecsFor(relays, { label: 'chrome-work', claimed: false }), [])
})

test('a fresh token from the named profile is written to the file, and the answer never repeats it', async () => {
  const dir = tempDir()
  const { relays } = load(dir, config(dir))
  const result = await accept(relays)
  assert.equal(result.ok, true)
  assert.equal(result.written, true)
  assert.equal(result.exp, iat + 48 * HOUR)
  assert.equal(fs.readFileSync(path.join(dir, 'token.txt'), 'utf8'), FRESH)
  assert.ok(!JSON.stringify(result).includes(FRESH.split('.')[1]), 'the answer carried the token')
  // Nothing but the token file is left in the folder: no temporary copy.
  assert.deepEqual(fs.readdirSync(dir).sort(), ['token-relay.json', 'token.txt'])
})

test('only a token that lives longer replaces the one in the file', async () => {
  const dir = tempDir()
  const { relays } = load(dir, config(dir))
  await accept(relays, { token: FRESHER })
  const older = await accept(relays, { token: FRESH })
  assert.equal(older.ok, true)
  assert.equal(older.written, false)
  assert.equal(older.exp, iat + 49 * HOUR, 'the answer should name the expiry the file already holds')
  assert.equal(fs.readFileSync(path.join(dir, 'token.txt'), 'utf8'), FRESHER)
})

test('a file holding a dead, foreign or implausible token is replaced by a good one', async () => {
  for (const held of [EXPIRED, OTHER_USER, FAR_FUTURE, 'not a token']) {
    const dir = tempDir()
    const { relays } = load(dir, config(dir))
    fs.writeFileSync(path.join(dir, 'token.txt'), held)
    const result = await accept(relays)
    assert.equal(result.written, true, `kept ${held.slice(0, 12)}`)
    assert.equal(fs.readFileSync(path.join(dir, 'token.txt'), 'utf8'), FRESH)
  }
})

test('the wrong profile, an unclaimed one, an unknown relay and a bad token are all refused, and nothing is written', async () => {
  const dir = tempDir()
  const { relays } = load(dir, config(dir))
  const cases = [
    [{ label: 'chrome-home' }, ERR.UNAUTHORIZED],
    [{ claimed: false }, ERR.PROFILE_UNCLAIMED],
    [{ name: 'nothing-here' }, ERR.BAD_REQUEST],
    [{ token: OTHER_USER }, ERR.BAD_REQUEST],
    [{ token: EXPIRED }, ERR.BAD_REQUEST],
    [{ token: FAR_FUTURE }, ERR.BAD_REQUEST],
    [{ token: 'Bearer ' + FRESH }, ERR.BAD_REQUEST],
    [{ token: 'abc.def' }, ERR.BAD_REQUEST],
    [{ token: 42 }, ERR.BAD_REQUEST],
  ]
  for (const [overrides, code] of cases) {
    const result = await accept(relays, overrides)
    assert.equal(result.ok, false, `accepted ${JSON.stringify(overrides).slice(0, 60)}`)
    assert.equal(result.code, code)
    assert.ok(!String(result.message).includes('eyJ'), 'a refusal quoted the token')
  }
  assert.equal(fs.existsSync(path.join(dir, 'token.txt')), false)
})

test('a file in a folder that does not exist is refused rather than created', async () => {
  const dir = tempDir()
  const { relays } = load(dir, config(dir, { sink: path.join(dir, 'missing', 'token.txt') }))
  const result = await accept(relays)
  assert.equal(result.ok, false)
  assert.equal(result.code, ERR.UNSUPPORTED)
  assert.equal(fs.existsSync(path.join(dir, 'missing')), false)
})
