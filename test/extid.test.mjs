/**
 * Chromium extension-ID derivation tests.
 *
 * The whole install story rests on this file being byte-identical to
 * components/crx_file/id_util.cc. If it drifts, the installer writes an
 * `allowed_origins` entry for an ID no extension will ever have, and Chromium
 * refuses the native-messaging connection with a message that names neither the
 * expected ID nor the actual one.
 *
 * The four vectors below are lifted from Chromium's own unit tests. They are
 * the reason this implementation can be trusted without a browser in the loop.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ID_LENGTH,
  generateId,
  idFromPublicKeyDer,
  idFromManifestKey,
  idFromPath,
  extensionOrigin,
  generateExtensionKeypair,
} from '../shared/extid.mjs'

test('upstream vector: GenerateId("test")', () => {
  assert.equal(generateId('test'), 'jpignaibiiemhngfjkcpokkamffknabf')
})

test('upstream vector: GenerateId("_")', () => {
  assert.equal(generateId('_'), 'ncocknphbhhlhkikpnnlmbcnbgdempcd')
})

test('upstream vector: GenerateIdForPath on Windows hashes UTF-16LE', () => {
  assert.equal(
    idFromPath('/path/to/file.ext', { windows: true }),
    'jjlkojfgbeklddcpckipekckcmgcbfjn'
  )
})

test('upstream vector: GenerateIdForPath on POSIX hashes UTF-8', () => {
  assert.equal(
    idFromPath('/path/to/file.ext', { windows: false }),
    'lnkgfdknojmdambfcanadbhmfjfljobb'
  )
})

test('the same path derives different IDs per platform, because the encoding differs', () => {
  // Stated explicitly because it is the single most confusing thing about this
  // function: a path is a wide string on Windows and a byte string elsewhere.
  assert.notEqual(
    idFromPath('/path/to/file.ext', { windows: true }),
    idFromPath('/path/to/file.ext', { windows: false })
  )
})

test('MaybeNormalizePath strips the Windows long-path prefix', () => {
  // A repo checked out under a deep path can reach the installer as an
  // extended-length path. Chromium normalizes it away before hashing, so we
  // must too, or the derived ID silently stops matching the loaded extension.
  assert.equal(
    idFromPath('\\\\?\\C:\\dev\\my-bridge\\extension', { windows: true }),
    idFromPath('C:\\dev\\my-bridge\\extension', { windows: true })
  )
})

test('every generated ID is 32 characters drawn only from a-p', () => {
  const inputs = [
    '',
    'test',
    '_',
    'C:\\dev\\my-bridge\\extension',
    'com.agent_browser_bridge.host',
    '中文測試 \u{1F680}',
    Buffer.from([0x00, 0xff, 0x10, 0x80]),
  ]
  for (const input of inputs) {
    const id = generateId(input)
    assert.equal(id.length, ID_LENGTH, `wrong length for ${String(input)}`)
    assert.equal(ID_LENGTH, 32)
    assert.match(id, /^[a-p]{32}$/, `outside the a-p alphabet for ${String(input)}`)
  }
})

test('derivation is deterministic across calls', () => {
  assert.equal(generateId('com.agent_browser_bridge.host'), generateId('com.agent_browser_bridge.host'))
})

test('a generated keypair round-trips: manifest key derives its own extension ID', () => {
  // This is the property the installer depends on. It writes `key` into the
  // manifest and `allowed_origins` into the host manifest in the same breath,
  // and never asks a human to copy an ID out of chrome://extensions.
  const kp = generateExtensionKeypair()

  assert.equal(typeof kp.manifestKey, 'string')
  assert.ok(kp.manifestKey.length > 0)
  assert.match(kp.extensionId, /^[a-p]{32}$/)
  assert.match(kp.privateKeyPem, /^-----BEGIN PRIVATE KEY-----/)

  assert.equal(idFromManifestKey(kp.manifestKey), kp.extensionId)
  assert.equal(idFromPublicKeyDer(Buffer.from(kp.manifestKey, 'base64')), kp.extensionId)
})

test('two keypairs do not collide', () => {
  assert.notEqual(generateExtensionKeypair().extensionId, generateExtensionKeypair().extensionId)
})

test('extensionOrigin is exactly the allowed_origins entry Chromium wants', () => {
  // Chromium parses allowed_origins strictly: the trailing slash is required
  // and a wildcard is rejected at parse time. Getting this string wrong is a
  // silent refusal, not an error message.
  const id = 'jpignaibiiemhngfjkcpokkamffknabf'
  assert.equal(extensionOrigin(id), 'chrome-extension://jpignaibiiemhngfjkcpokkamffknabf/')
  assert.match(extensionOrigin(id), /^chrome-extension:\/\/[a-p]{32}\/$/)
  assert.ok(!extensionOrigin(id).includes('*'), 'a wildcard would be rejected by Chromium')
})
