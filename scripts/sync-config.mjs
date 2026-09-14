#!/usr/bin/env node
/**
 * sync-config - project bridge.config.json into the files that cannot read it.
 *
 *   extension/lib/config.js     the extension's copy of the product identity
 *   extension/manifest.json     name, description, action title
 *   package.json                name (as a slug) and description
 *
 * Idempotent: writes only what changed and says so. `--check` writes nothing
 * and exits 1 when anything is out of date, which is what scripts/gate.mjs
 * runs.
 */

import fs from 'node:fs'
import path from 'node:path'

import { CONFIG, REPO_ROOT, renderExtensionConfig } from '../shared/config.mjs'

const EXT_CONFIG = path.join(REPO_ROOT, 'extension', 'lib', 'config.js')
const MANIFEST = path.join(REPO_ROOT, 'extension', 'manifest.json')
const PACKAGE = path.join(REPO_ROOT, 'package.json')

const check = process.argv.includes('--check')

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Expected file contents, as text, so a diff is a plain string compare. */
function expected() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
  manifest.name = CONFIG.productName
  manifest.description = `${CONFIG.tagline}. Lets an AI agent drive this real, logged-in browser profile over a local native-messaging link.`
  manifest.action = { ...(manifest.action || {}), default_title: CONFIG.productName }

  const pkg = JSON.parse(fs.readFileSync(PACKAGE, 'utf8'))
  pkg.name = CONFIG.stateDirName
  pkg.description = `${CONFIG.productName} - ${CONFIG.tagline}.`

  return [
    { file: EXT_CONFIG, text: renderExtensionConfig(CONFIG) },
    { file: MANIFEST, text: JSON.stringify(manifest, null, 2) + '\n' },
    { file: PACKAGE, text: JSON.stringify(pkg, null, 2) + '\n' },
  ]
}

let stale = 0
for (const { file, text } of expected()) {
  const rel = path.relative(REPO_ROOT, file)
  let current = null
  try {
    current = fs.readFileSync(file, 'utf8')
  } catch {
    current = null
  }
  if (current === text) {
    console.log(`  ok       ${rel}`)
    continue
  }
  stale += 1
  if (check) {
    console.log(`  STALE    ${rel}`)
    continue
  }
  fs.writeFileSync(file, text, 'utf8')
  console.log(`  wrote    ${rel}`)
}

if (check && stale > 0) {
  console.error(`\n${stale} file(s) are out of sync with bridge.config.json. Run: npm run sync-config`)
  process.exitCode = 1
} else if (!check) {
  console.log(`\nsynced ${CONFIG.productName} (${slug(CONFIG.productName)}) into the extension, manifest and package.json`)
}
