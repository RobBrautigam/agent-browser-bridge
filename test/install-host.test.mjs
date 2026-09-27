/**
 * install-host: which extension ID gets registered, and what the POSIX
 * launcher looks like. Nothing here writes a registry value or a manifest; the
 * functions under test are the pure halves the installer is built from.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-install-host-'))
process.env.BRIDGE_HOME = path.join(TEMP_ROOT, 'state')

const installer = await import('../scripts/install-host.mjs')
const extid = await import('../shared/extid.mjs')

const { EXTENSION_DIR, PLACEHOLDER, buildPosixShim, canonicalExtensionDir, resolveExtensionId } = installer
const { generateExtensionKeypair, idFromPath } = extid

test('a fresh clone (no manifest key) derives the ID from the canonical folder path', () => {
  const r = resolveExtensionId({ manifest: { name: 'x' } })
  assert.equal(r.source, 'folder path')
  assert.equal(r.id, idFromPath(canonicalExtensionDir(EXTENSION_DIR)))
  assert.match(r.id, /^[a-p]{32}$/)
})

test('the placeholder key counts as no key', () => {
  const r = resolveExtensionId({ manifest: { key: PLACEHOLDER } })
  assert.equal(r.source, 'folder path')
})

test('a real manifest key wins over the folder path', () => {
  const kp = generateExtensionKeypair()
  const r = resolveExtensionId({ manifest: { key: kp.manifestKey } })
  assert.equal(r.source, 'manifest key')
  assert.equal(r.id, kp.extensionId)
})

test('--extension-id wins over everything, and is validated', () => {
  const kp = generateExtensionKeypair()
  const given = 'abcdefghijklmnopabcdefghijklmnop'
  const r = resolveExtensionId({ manifest: { key: kp.manifestKey }, override: given.toUpperCase() })
  assert.equal(r.source, 'argument')
  assert.equal(r.id, given, 'lowercased, as Chromium prints it')

  const bad = resolveExtensionId({ manifest: {}, override: 'not-an-id' })
  assert.equal(bad.id, null)
  assert.match(bad.error, /not an extension ID/)
})

test('the canonical folder path is absolute and exists', () => {
  const dir = canonicalExtensionDir()
  assert.ok(path.isAbsolute(dir))
  assert.ok(fs.existsSync(path.join(dir, 'manifest.json')))
})

test('the POSIX launcher bakes in an absolute node, honors BRIDGE_NODE, and never prints', () => {
  const shim = buildPosixShim({ node: '/opt/node/bin/node', hostEntry: "/Users/al ice/dev/it's/host/index.mjs" })
  const lines = shim.split('\n')
  assert.equal(lines[0], '#!/bin/sh')
  assert.ok(shim.includes('exec "${BRIDGE_NODE:-/opt/node/bin/node}"'), 'BRIDGE_NODE overrides the baked node path')
  // A path with a space and an apostrophe survives single-quote escaping.
  assert.ok(shim.includes(`'/Users/al ice/dev/it'\\''s/host/index.mjs'`), shim)
  assert.ok(shim.trimEnd().endsWith('"$@"'), 'the extension origin argument is passed through')
  assert.ok(!/\becho\b|printf/.test(shim), 'stdout is protocol; the shim must not print')
})
