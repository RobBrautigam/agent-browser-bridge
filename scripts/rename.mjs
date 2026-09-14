#!/usr/bin/env node
/**
 * rename - give this bridge a different name, everywhere, in one command.
 *
 *   node scripts/rename.mjs <slug> "<Display Name>" [--tagline "..."]
 *
 * Example:
 *   node scripts/rename.mjs tab-conductor "Tab Conductor"
 *
 * Rewrites bridge.config.json, then runs sync-config so the extension copy,
 * the manifest and package.json follow. Nothing else in the repo carries the
 * product name, by design: every module reads it from the config.
 *
 * What a rename CHANGES on a machine that already has this installed: the
 * native host id, the socket name, the state directory and the service name.
 * So after renaming an installed bridge, uninstall the old broker service
 * first (`node scripts/install-broker.mjs --uninstall` from the OLD checkout)
 * and then run the installers again from this one.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { CONFIG_FILE, CONFIG_SHAPE, REPO_ROOT, loadConfig } from '../shared/config.mjs'

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/

/**
 * The config a rename produces, as a pure function so it can be tested.
 * @param {object} current the config as it is now
 * @param {{slug:string, displayName:string, tagline?:string|null}} input
 */
export function deriveConfig(current, { slug, displayName, tagline = null }) {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`"${slug}" is not a valid slug (lowercase letters, digits, hyphens; 2 to 64 characters).`)
  }
  const name = String(displayName || '').trim()
  if (!name) throw new Error('a display name is required.')
  const hostSlug = slug.replace(/-/g, '_')
  const next = {
    ...current,
    productName: name,
    tagline: tagline ?? current.tagline,
    nativeHostId: `com.${hostSlug}.host`,
    socketName: slug,
    stateDirName: slug,
    serviceName: `${name} broker`,
    mcpServerName: slug,
  }
  for (const [key, rule] of Object.entries(CONFIG_SHAPE)) {
    if (!rule.test(next[key])) throw new Error(`"${key}" would become ${JSON.stringify(next[key])}, which is not valid.`)
  }
  return next
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h') || argv.length < 2) {
    console.log(`
  node scripts/rename.mjs <slug> "<Display Name>" [--tagline "<one line>"]

  <slug>            lowercase letters, digits and hyphens, e.g. tab-conductor
  <Display Name>    what people see, e.g. "Tab Conductor"
  --tagline         optional one-line description; the existing one is kept otherwise
`)
    return argv.length < 2 ? 1 : 0
  }

  const [slug, displayName] = argv
  const taglineAt = argv.indexOf('--tagline')
  const tagline = taglineAt >= 0 ? argv[taglineAt + 1] : null

  const current = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  let next
  try {
    next = deriveConfig(current, { slug, displayName, tagline })
  } catch (err) {
    console.error(`FATAL: ${err.message}`)
    return 1
  }

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8')
  loadConfig() // throws if anything above produced an invalid value
  console.log(`wrote ${path.relative(REPO_ROOT, CONFIG_FILE)}`)

  const sync = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'sync-config.mjs')], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  })
  if (sync.status !== 0) return sync.status ?? 1

  console.log(`
Renamed to "${next.productName}".
  native host id   ${next.nativeHostId}
  socket           ${next.socketName}
  state directory  ${next.stateDirName}
  service          ${next.serviceName}
  MCP server key   ${next.mcpServerName}

If the old name was installed on this machine, uninstall its broker from the old
checkout first, then run the installers again. Also rename the repo folder and
the README title yourself; this script does not touch git or prose.
`)
  return 0
}

function isMain(metaUrl) {
  try {
    if (!process.argv[1]) return false
    return (
      fs.realpathSync(fileURLToPath(metaUrl)).toLowerCase() ===
      fs.realpathSync(process.argv[1]).toLowerCase()
    )
  } catch {
    return pathToFileURL(process.argv[1] || '').href === metaUrl
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
