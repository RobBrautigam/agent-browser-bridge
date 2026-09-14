#!/usr/bin/env node
/**
 * keygen - pin the extension ID before the extension is ever loaded.
 *
 * An unpacked extension's ID is normally a pure function of its folder path,
 * so moving this repo would mint a new ID and orphan every profile install
 * plus the single `allowed_origins` entry that authorizes them. A `key` in the
 * manifest overrides that derivation: the ID becomes a function of a public key
 * we control instead. That is what lets install-host predict the ID and write
 * `allowed_origins` itself, so nobody ever copies an ID out of
 * chrome://extensions.
 *
 * The private key never enters the repo. It lives in BASE_DIR with the rest of
 * the bridge's machine state, and is only needed if the extension is ever
 * packed into a .crx.
 *
 * The KEY MATERIAL, not the manifest, is the source of truth for the ID. The
 * manifest is a projection of it. That is why a saved key is reused rather than
 * regenerated when the manifest is missing or has been reset to the
 * placeholder: the ID must survive that, or every install die with it.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  generateExtensionKeypair,
  idFromManifestKey,
  idFromPath,
  extensionOrigin,
  ID_LENGTH,
} from '../shared/extid.mjs'
import { BASE_DIR, ensureBaseDir, readJson, writeJsonAtomic } from '../shared/paths.mjs'
import { PRODUCT_NAME } from '../shared/protocol.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXTENSION_DIR = path.join(REPO_ROOT, 'extension')
const MANIFEST_FILE = path.join(EXTENSION_DIR, 'manifest.json')

/** The literal the extension ships with, so an unkeyed manifest is obvious rather than empty. */
const PLACEHOLDER = 'PLACEHOLDER_REPLACED_BY_KEYGEN'

const KEY_PEM_FILE = path.join(BASE_DIR, 'extension-key.pem')
const KEY_META_FILE = path.join(BASE_DIR, 'extension-key.json')

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const paint = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s)
const bold = (s) => paint('1', s)
const green = (s) => paint('32', s)
const yellow = (s) => paint('33', s)
const red = (s) => paint('31', s)
const dim = (s) => paint('2', s)

function usage() {
  console.log(`
${bold(`${PRODUCT_NAME} keygen`)}

  node scripts/keygen.mjs            derive or reuse the pinned extension key
  node scripts/keygen.mjs --force    MINT A NEW KEY (changes the extension ID)
  node scripts/keygen.mjs --help

Idempotent. Running it twice never changes the extension ID unless --force.
`)
}

function main(argv) {
  const force = argv.includes('--force')
  if (argv.includes('--help') || argv.includes('-h')) {
    usage()
    return 0
  }

  ensureBaseDir()

  // A private key inside the repo is one `git add -A` away from being public.
  // BASE_DIR is outside the repo by construction, but assert it rather than
  // trust it, because this is the one mistake that cannot be undone.
  const rel = path.relative(REPO_ROOT, KEY_PEM_FILE)
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    console.error(red(`FATAL: the private key path resolves inside the repo (${KEY_PEM_FILE}).`))
    return 1
  }

  const manifestText = readTextOrNull(MANIFEST_FILE)
  const manifestJson = manifestText === null ? null : safeParse(manifestText)
  const manifestKey = typeof manifestJson?.key === 'string' ? manifestJson.key.trim() : ''
  const manifestKeyIsReal = manifestKey !== '' && manifestKey !== PLACEHOLDER

  const saved = readJson(KEY_META_FILE, null)
  const savedKey = typeof saved?.manifestKey === 'string' ? saved.manifestKey : null

  /* ---------------------------------------------------------------------- */
  /* Case 1: the manifest already carries a real key. Do nothing.            */
  /* ---------------------------------------------------------------------- */
  if (manifestKeyIsReal && !force) {
    const id = idFromManifestKey(manifestKey)
    console.log(green('Already keyed. Nothing to do.'))

    if (savedKey && savedKey !== manifestKey) {
      console.log(
        yellow(
          `WARNING: the saved key in ${KEY_META_FILE} does not match the one in the manifest.\n` +
            '         The manifest wins for the ID. The saved private key cannot pack this extension.'
        )
      )
    } else if (!savedKey) {
      // BASE_DIR is shared machine state. Something that clears it takes the
      // private key with it, and the manifest key alone cannot regenerate it.
      // Record the ID so it stays recoverable, and say plainly what was lost.
      writeJsonAtomic(KEY_META_FILE, {
        manifestKey,
        extensionId: id,
        origin: extensionOrigin(id),
        recoveredAt: new Date().toISOString(),
        privateKeyAvailable: false,
        note: 'Recovered from extension/manifest.json. The private key is gone.',
      })
      console.log(
        yellow(
          `NOTE: no saved key material was found in ${BASE_DIR}, so it was recovered from\n` +
            '      the manifest. The extension ID is unaffected. The PRIVATE key is gone,\n' +
            '      which only matters if this extension is ever packed into a .crx;\n' +
            '      minting a new one with --force would change the ID.'
        )
      )
    } else if (!fs.existsSync(KEY_PEM_FILE)) {
      console.log(
        yellow(
          `NOTE: ${KEY_PEM_FILE} is missing. The ID is safe (the manifest holds the public\n` +
            '      key), but this extension can no longer be packed into a .crx.'
        )
      )
    }

    report(id, { manifestState: 'unchanged', keySource: 'manifest' })
    return 0
  }

  /* ---------------------------------------------------------------------- */
  /* Case 2: mint or reuse.                                                  */
  /* ---------------------------------------------------------------------- */
  let keyBase64
  let keySource

  if (force) {
    console.log(
      red(bold('  ******************************************************************')) +
        '\n' +
        red(bold('  *  --force MINTS A NEW KEY AND THEREFORE A NEW EXTENSION ID.     *')) +
        '\n' +
        red(bold('  *  Every profile that already loaded this extension is orphaned. *')) +
        '\n' +
        red(bold('  *  You must re-run install-host, then remove and re-load the     *')) +
        '\n' +
        red(bold('  *  extension in every profile. Sessions inside the browser    *')) +
        '\n' +
        red(bold('  *  are untouched; the bridge to them is not.                     *')) +
        '\n' +
        red(bold('  ******************************************************************'))
    )
    backupIfPresent(KEY_PEM_FILE)
    backupIfPresent(KEY_META_FILE)
    const pair = generateExtensionKeypair()
    persistKey(pair)
    keyBase64 = pair.manifestKey
    keySource = 'new keypair (--force)'
  } else if (savedKey) {
    // The manifest is missing or was reset to the placeholder, but we already
    // minted a key on a previous run. Reuse it so the ID does not churn.
    keyBase64 = savedKey
    keySource = `saved key (${KEY_META_FILE})`
  } else {
    const pair = generateExtensionKeypair()
    persistKey(pair)
    keyBase64 = pair.manifestKey
    keySource = 'new keypair'
  }

  const id = idFromManifestKey(keyBase64)

  /* ---------------------------------------------------------------------- */
  /* Case 3: inject into the manifest, when there is one.                    */
  /* ---------------------------------------------------------------------- */
  if (manifestText === null) {
    console.log(green(`Key ready (${keySource}).`))
    console.log(
      yellow(
        `WARNING: ${MANIFEST_FILE} does not exist yet, so the key was not injected.\n` +
          '         The key is saved, so re-running this script once the extension\n' +
          '         folder exists injects the SAME key and the ID below does not change.'
      )
    )
    report(id, { manifestState: 'not written (no manifest)', keySource })
    return 0
  }

  const injected = injectKey(manifestText, keyBase64)
  if (!injected) {
    // No placeholder and no `key` field. Fall back to a structural edit, which
    // reformats the file. Say so rather than silently rewriting the operator's
    // formatting.
    if (!manifestJson) {
      console.error(red(`FATAL: ${MANIFEST_FILE} is not valid JSON, so the key cannot be injected.`))
      return 1
    }
    const rebuilt = { ...manifestJson, key: keyBase64 }
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(rebuilt, null, 2) + '\n', 'utf8')
    console.log(
      yellow('NOTE: the manifest had no `key` field and no placeholder, so it was rewritten.')
    )
  } else {
    fs.writeFileSync(MANIFEST_FILE, injected.text, 'utf8')
  }

  // Verify by reading back rather than trusting the write.
  const after = safeParse(readTextOrNull(MANIFEST_FILE) ?? '')
  if (after?.key !== keyBase64) {
    console.error(red('FATAL: the manifest did not come back with the key that was just written.'))
    return 1
  }
  const verifiedId = idFromManifestKey(after.key)
  if (verifiedId !== id) {
    console.error(red(`FATAL: ID mismatch after write (${verifiedId} vs ${id}).`))
    return 1
  }

  console.log(green(`Key injected into ${MANIFEST_FILE} (${keySource}).`))
  report(id, { manifestState: injected ? `updated via ${injected.how}` : 'rewritten', keySource })
  return 0
}

/* -------------------------------------------------------------------------- */

function report(id, { manifestState, keySource }) {
  const origin = extensionOrigin(id)
  const line = '='.repeat(Math.max(62, origin.length + 20))
  console.log('')
  console.log(line)
  console.log(`  ${bold('EXTENSION ID')}   ${bold(green(id))}`)
  console.log(`  ${bold('ORIGIN')}         ${origin}`)
  console.log(line)
  console.log('')
  console.log(dim(`  key source     ${keySource}`))
  console.log(dim(`  manifest       ${manifestState}`))
  console.log(dim(`  private key    ${KEY_PEM_FILE}`))
  console.log(dim(`  id length      ${id.length} (expected ${ID_LENGTH})`))
  if (fs.existsSync(EXTENSION_DIR)) {
    // What a KEYLESS unpacked load would produce. Printed because it is the
    // fastest way to diagnose "chrome://extensions shows a different ID":
    // if the browser shows THIS one, the key never reached the manifest.
    console.log(dim(`  keyless id     ${idFromPath(EXTENSION_DIR)}  (path-derived, for diagnosis)`))
  }
  console.log('')
  console.log('  Next: node scripts/install-host.mjs')
  console.log('')
}

function persistKey({ manifestKey, extensionId, privateKeyPem }) {
  fs.writeFileSync(KEY_PEM_FILE, privateKeyPem, { encoding: 'utf8', mode: 0o600 })
  restrictToCurrentUser(KEY_PEM_FILE)
  writeJsonAtomic(KEY_META_FILE, {
    manifestKey,
    extensionId,
    origin: extensionOrigin(extensionId),
    createdAt: new Date().toISOString(),
    note: 'Source of truth for the pinned extension ID. Do not copy into the repo.',
  })
}

/**
 * Windows ignores POSIX file modes, so tighten the ACL for real. Best effort:
 * a private key with default inherited permissions is still far better than no
 * key, and failing the whole install over an ACL would be worse.
 */
function restrictToCurrentUser(file) {
  const user = process.env.USERNAME
  if (process.platform !== 'win32' || !user) return
  try {
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:(R,W)`], {
      stdio: 'ignore',
    })
  } catch {
    console.log(yellow(`NOTE: could not tighten the ACL on ${file}. It keeps inherited permissions.`))
  }
}

function backupIfPresent(file) {
  if (!fs.existsSync(file)) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = `${file}.bak-${stamp}`
  fs.copyFileSync(file, dest)
  console.log(dim(`  backed up ${path.basename(file)} to ${path.basename(dest)}`))
}

/**
 * Text-level injection, so the extension author's formatting and comments-in-
 * spirit survive. Returns null when there is nothing to replace.
 */
function injectKey(text, keyBase64) {
  if (text.includes(PLACEHOLDER)) {
    return { text: text.split(PLACEHOLDER).join(keyBase64), how: 'placeholder' }
  }
  const re = /("key"\s*:\s*")([^"]*)(")/
  if (re.test(text)) {
    return { text: text.replace(re, `$1${keyBase64}$3`), how: 'key field' }
  }
  return null
}

function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

process.exitCode = main(process.argv.slice(2))
