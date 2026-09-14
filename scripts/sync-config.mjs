#!/usr/bin/env node
/**
 * sync-config - project bridge.config.json into the files that cannot read it.
 *
 *   extension/lib/config.js     the extension's copy of the product identity
 *   extension/manifest.json     name, description, action title
 *   package.json                name (the state-directory slug) and description
 *
 * The list of files and their exact expected text lives in
 * shared/config.mjs (renderProjections), which scripts/gate.mjs and the tests
 * also read, so "what sync-config writes" and "what the gate checks" cannot
 * drift apart.
 *
 * Idempotent: writes only what changed and says so. `--check` writes nothing
 * and exits 1 when anything is out of date.
 */

import fs from 'node:fs'
import path from 'node:path'

import { CONFIG, REPO_ROOT, renderProjections } from '../shared/config.mjs'

const check = process.argv.includes('--check')

let stale = 0
for (const { file, text } of renderProjections(CONFIG)) {
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
  console.log(`\nsynced "${CONFIG.productName}" into the extension, the manifest and package.json`)
}
