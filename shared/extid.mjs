/**
 * Chromium extension ID derivation.
 *
 * An extension ID is the first 16 bytes of a SHA-256, hex-encoded, with each
 * hex digit remapped 0-f -> a-p. Chromium computes it two ways:
 *
 *   - from the public key   (packed, or unpacked with a `key` in the manifest)
 *   - from the folder path  (unpacked with no `key`)
 *
 * A keyed manifest pins the ID, and then `idFromPublicKeyDer` is
 * the one that matters: the installer can derive the ID BEFORE the extension
 * is ever loaded, write the wildcard-free `allowed_origins` entry, and never
 * ask a human to copy an ID out of chrome://extensions.
 *
 * `idFromPath` is kept because it is what a keyless unpacked load would
 * produce, which makes it the right diagnostic when an install goes wrong -
 * and because Chromium publishes test vectors for it that let us prove this
 * implementation matches upstream.
 *
 * Source: components/crx_file/id_util.cc
 */

import crypto from 'node:crypto'

export const ID_LENGTH = 32 // 16 bytes, one character per hex digit

/** Map 0-9a-f to a-p, which is Chromium's ConvertHexadecimalToIDAlphabet. */
function hexToIdAlphabet(hex) {
  let out = ''
  for (const ch of hex) {
    out += String.fromCharCode('a'.charCodeAt(0) + parseInt(ch, 16))
  }
  return out
}

/**
 * Chromium's GenerateId: SHA-256 the raw bytes, take 16 bytes, remap.
 * @param {Buffer|Uint8Array|string} input
 */
export function generateId(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const digest = crypto.createHash('sha256').update(buf).digest()
  return hexToIdAlphabet(digest.subarray(0, 16).toString('hex'))
}

/**
 * ID for a keyed extension, from the DER-encoded SubjectPublicKeyInfo.
 * This is what `key` in manifest.json base64-encodes.
 * @param {Buffer} der
 */
export function idFromPublicKeyDer(der) {
  return generateId(der)
}

/**
 * ID for a keyed extension, from the base64 `key` value in a manifest.
 * @param {string} keyBase64
 */
export function idFromManifestKey(keyBase64) {
  return generateId(Buffer.from(keyBase64, 'base64'))
}

/**
 * ID an unpacked, keyless extension would get for a folder path.
 *
 * On Windows a FilePath is a wide string, so Chromium hashes the UTF-16LE
 * bytes. On POSIX it hashes the UTF-8 bytes. Both are covered by the upstream
 * test vectors in test/id-derivation.test.mjs.
 *
 * @param {string} absPath
 * @param {{ windows?: boolean }} [opts] force a platform, for the test vectors
 */
export function idFromPath(absPath, { windows = process.platform === 'win32' } = {}) {
  const normalized = maybeNormalizePath(absPath, windows)
  return generateId(Buffer.from(normalized, windows ? 'utf16le' : 'utf8'))
}

/**
 * Chromium's MaybeNormalizePath. On Windows it strips the `\\?\` long-path
 * prefix when present; everywhere else the path is used as-is.
 */
function maybeNormalizePath(p, windows) {
  if (!windows) return p
  const PREFIX = '\\\\?\\'
  return p.startsWith(PREFIX) ? p.slice(PREFIX.length) : p
}

/** Extension origin, the exact string that goes in `allowed_origins`. */
export function extensionOrigin(id) {
  return `chrome-extension://${id}/`
}

/**
 * Generate an RSA keypair for pinning the extension ID.
 * Returns the base64 `key` value for manifest.json, the derived ID, and the
 * private key PEM (which is kept out of the repo and only used if the
 * extension is ever packed into a .crx).
 */
export function generateExtensionKeypair(modulusLength = 2048) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength })
  const der = publicKey.export({ type: 'spki', format: 'der' })
  return {
    manifestKey: der.toString('base64'),
    extensionId: idFromPublicKeyDer(der),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }
}
