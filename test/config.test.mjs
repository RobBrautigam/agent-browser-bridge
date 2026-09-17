/**
 * The product-identity config and its projections.
 *
 * bridge.config.json is the one place the name lives. Two things can drift
 * from it and both are silent in review: the extension's generated copy (a
 * mismatch is "Specified native messaging host not found" at runtime) and the
 * manifest's name. These tests pin both, and pin the white-label promise that
 * a fresh clone ships WITHOUT a manifest key, so every installer gets an ID of
 * their own instead of inheriting somebody else's.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  CONFIG,
  CONFIG_SHAPE,
  REPO_ROOT,
  loadConfig,
  renderExtensionConfig,
  renderProjections,
  validateConfig,
} from '../shared/config.mjs'
import { deriveConfig } from '../scripts/rename.mjs'

const EXT_CONFIG = path.join(REPO_ROOT, 'extension', 'lib', 'config.js')
const MANIFEST = path.join(REPO_ROOT, 'extension', 'manifest.json')
const PACKAGE = path.join(REPO_ROOT, 'package.json')

test('every configured value satisfies its rule', () => {
  for (const [key, spec] of Object.entries(CONFIG_SHAPE)) {
    assert.equal(typeof CONFIG[key], 'string', `${key} is missing`)
    assert.match(CONFIG[key], spec.rule, `${key} = ${CONFIG[key]}`)
  }
})

test('every projected file holds exactly what the config renders', () => {
  // The same comparison scripts/gate.mjs runs. Here so `npm test` alone
  // catches a config edit that skipped `npm run sync-config`, and a hand edit
  // to a generated field in the manifest or package.json.
  for (const { file, text } of renderProjections(CONFIG)) {
    assert.equal(fs.readFileSync(file, 'utf8'), text, `${path.relative(REPO_ROOT, file)} is out of sync`)
  }
})

test('validateConfig refuses what Windows, Chrome or Task Scheduler would refuse', () => {
  const ok = (patch) => validateConfig({ ...CONFIG, ...patch })
  const bad = (patch, re) => assert.throws(() => validateConfig({ ...CONFIG, ...patch }), re)

  // Windows reserved device names cannot be a directory or a socket name.
  for (const reserved of ['con', 'nul', 'aux', 'prn', 'com1', 'lpt9', 'CON']) {
    bad({ stateDirName: reserved.toLowerCase() }, /reserves/)
    bad({ socketName: reserved.toLowerCase() }, /reserves/)
  }
  ok({ stateDirName: 'con-bridge' })

  // Chrome's manifest limits: 45 for the name, 132 for the description.
  ok({ productName: 'x'.repeat(45) })
  bad({ productName: 'x'.repeat(46) }, /productName/)
  ok({ tagline: 'y'.repeat(132) })
  bad({ tagline: 'y'.repeat(133) }, /tagline/)

  // Task Scheduler rejects these characters in a task name.
  for (const ch of ['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
    bad({ serviceName: `My ${ch} broker` }, /serviceName/)
  }
  ok({ serviceName: "Acme's bridge (dev) broker" })

  // The socket path budget: 20 characters each, so the default macOS location
  // stays under the Unix socket limit.
  ok({ socketName: 'a'.repeat(20), stateDirName: 'b'.repeat(20) })
  bad({ socketName: 'a'.repeat(21) }, /socketName/)
  bad({ stateDirName: 'b'.repeat(21) }, /stateDirName/)
})

test('the native host id is a name Chromium accepts', () => {
  // Lowercase alphanumerics, dots and underscores; no leading, trailing or
  // consecutive dots. Chromium rejects anything else at manifest parse time
  // with no error a user can see.
  assert.match(CONFIG.nativeHostId, /^[a-z0-9_]+(\.[a-z0-9_]+)*$/)
  assert.ok(!CONFIG.nativeHostId.includes('..'))
})

test('the committed extension config is exactly what the current config renders', () => {
  // scripts/gate.mjs enforces this too. It is here as well so `npm test` alone
  // catches a config edit that skipped `npm run sync-config`.
  assert.equal(fs.readFileSync(EXT_CONFIG, 'utf8'), renderExtensionConfig(CONFIG))
})

test('the extension manifest carries the product name and NO pinned key', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  assert.equal(manifest.name, CONFIG.productName)
  assert.equal(manifest.action?.default_title, CONFIG.productName)
  // The white-label promise: a fresh clone derives its extension ID from the
  // folder path, so two people installing this do not share an ID. keygen is
  // the documented opt-in for pinning one.
  assert.equal('key' in manifest, false, 'a pinned key would give every install the same extension ID')
})

test('package.json follows the config', () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE, 'utf8'))
  assert.equal(pkg.name, CONFIG.stateDirName)
  assert.equal(pkg.version, '0.2.0')
})

test('loadConfig refuses a host id Chromium would reject', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-config-'))
  const file = path.join(dir, 'bridge.config.json')
  fs.writeFileSync(file, JSON.stringify({ ...CONFIG, nativeHostId: 'Bad.Host..Id' }), 'utf8')
  assert.throws(() => loadConfig(file), /nativeHostId/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('loadConfig refuses a missing key rather than defaulting it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-config-'))
  const file = path.join(dir, 'bridge.config.json')
  const { socketName, ...rest } = CONFIG
  fs.writeFileSync(file, JSON.stringify(rest), 'utf8')
  assert.throws(() => loadConfig(file), /socketName/)
  fs.rmSync(dir, { recursive: true, force: true })
})

/* -------------------------------------------------------------------------- */
/* rename                                                                      */
/* -------------------------------------------------------------------------- */

test('rename derives every identifier from the slug and keeps them valid', () => {
  const next = deriveConfig(CONFIG, { slug: 'tab-conductor', displayName: 'Tab Conductor' })
  assert.equal(next.productName, 'Tab Conductor')
  assert.equal(next.nativeHostId, 'com.tab_conductor.host')
  assert.equal(next.socketName, 'tab-conductor')
  assert.equal(next.stateDirName, 'tab-conductor')
  assert.equal(next.serviceName, 'Tab Conductor broker')
  assert.equal(next.mcpServerName, 'tab-conductor')
  assert.equal(next.tagline, CONFIG.tagline, 'the tagline is kept unless given')
  for (const [key, spec] of Object.entries(CONFIG_SHAPE)) assert.match(next[key], spec.rule, key)
})

test('rename refuses a slug or name that would produce an invalid config', () => {
  assert.throws(() => deriveConfig(CONFIG, { slug: 'Tab Conductor', displayName: 'x' }), /not a valid slug/)
  assert.throws(() => deriveConfig(CONFIG, { slug: '-leading', displayName: 'x' }), /not a valid slug/)
  assert.throws(() => deriveConfig(CONFIG, { slug: 'a'.repeat(21), displayName: 'x' }), /not a valid slug/)
  assert.throws(() => deriveConfig(CONFIG, { slug: 'ok-slug', displayName: '   ' }), /display name/)
  assert.throws(() => deriveConfig(CONFIG, { slug: 'con', displayName: 'Con' }), /reserves/)
  assert.throws(() => deriveConfig(CONFIG, { slug: 'my-bridge', displayName: 'My "Bridge"' }), /serviceName/)
  assert.throws(() => deriveConfig(CONFIG, { slug: 'my-bridge', displayName: 'x'.repeat(46) }), /productName/)
})
