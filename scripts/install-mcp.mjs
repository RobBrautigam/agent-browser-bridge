#!/usr/bin/env node
/**
 * install-mcp - register the MCP server with an agent client.
 *
 * Nothing else in this repo does this, so until it is run, every other piece
 * can be installed and healthy and the agent still has no way to reach the
 * bridge. That is the whole gap this script closes.
 *
 * Clients:
 *
 *   --client claude    (default) ~/.claude.json, user scope, key mcpServers.<name>
 *   --client cursor    ~/.cursor/mcp.json, key mcpServers.<name>
 *   --client codex     ~/.codex/config.toml is TOML, which this repo has no
 *                      parser for (the dependency allowlist is deliberate), so
 *                      the exact block to paste is PRINTED rather than written.
 *
 * The entry is always the same shape:
 *
 *   "<name>": {
 *     "type": "stdio",
 *     "command": "node",
 *     "args": ["<repo>/mcp-server/index.mjs"],
 *     "env": {}
 *   }
 *
 * The JSON config files are shared by EVERY session of that client on this
 * machine, and they hold far more than MCP config, so this script is
 * deliberately timid: it refuses to touch a file it cannot parse, takes a
 * timestamped backup before any write, writes through a temp file and a rename
 * so a crash cannot truncate it, changes exactly one key, and reads the result
 * back to prove the edit landed. Re-running it when the entry is already
 * correct writes nothing at all, not even a backup.
 *
 * The path is written with forward slashes on purpose. It is legal JSON either
 * way, but a Windows path with escaped backslashes is the kind of thing a human
 * silently breaks the next time they hand-edit this file.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { MCP_SERVER_NAME } from '../shared/config.mjs'
import { writeJsonAtomic } from '../shared/paths.mjs'
import { PRODUCT_NAME } from '../shared/protocol.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The server name the client will show, and the key we own inside its file. */
export const MCP_ENTRY_NAME = MCP_SERVER_NAME

/** The stdio entry point the client spawns. */
export const MCP_SERVER_ENTRY = path.join(REPO_ROOT, 'mcp-server', 'index.mjs')

/** Per-client config locations. Codex is TOML and is printed, never edited. */
export const CLIENTS = Object.freeze({
  claude: { label: 'Claude Code', file: path.join(os.homedir(), '.claude.json'), format: 'json' },
  cursor: { label: 'Cursor', file: path.join(os.homedir(), '.cursor', 'mcp.json'), format: 'json' },
  codex: { label: 'Codex', file: path.join(os.homedir(), '.codex', 'config.toml'), format: 'toml' },
})

/** Kept for doctor.mjs, which checks the Claude Code registration. */
export const CLAUDE_JSON = CLIENTS.claude.file

/** Forward slashes, for a file humans hand-edit. */
export function portablePath(p) {
  return p.split(path.sep).join('/')
}

/** Exactly what the entry must look like. doctor.mjs asserts against this too. */
export function desiredEntry() {
  return {
    type: 'stdio',
    command: 'node',
    args: [portablePath(MCP_SERVER_ENTRY)],
    env: {},
  }
}

/** The Codex block, as TOML text. */
export function codexToml() {
  return [
    `[mcp_servers.${MCP_ENTRY_NAME}]`,
    'command = "node"',
    `args = [${JSON.stringify(portablePath(MCP_SERVER_ENTRY))}]`,
    '',
  ].join('\n')
}

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const paint = (code, s) => (useColor ? `[${code}m${s}[0m` : s)
const bold = (s) => paint('1', s)
const green = (s) => paint('32', s)
const yellow = (s) => paint('33', s)
const red = (s) => paint('31', s)
const dim = (s) => paint('2', s)

/* -------------------------------------------------------------------------- */

function usage() {
  console.log(`
${bold(`${PRODUCT_NAME} install-mcp`)}

  node scripts/install-mcp.mjs                       add or repair the "${MCP_ENTRY_NAME}" entry for Claude Code
  node scripts/install-mcp.mjs --client cursor       same, for Cursor (~/.cursor/mcp.json)
  node scripts/install-mcp.mjs --client codex        print the TOML block for Codex (~/.codex/config.toml)
  node scripts/install-mcp.mjs --dry-run             show exactly what would change, write nothing
  node scripts/install-mcp.mjs --remove              remove the entry again
  node scripts/install-mcp.mjs --help

Edits one key in the client's config file, after backing it up. Idempotent:
running it twice when the entry is already correct changes nothing.
`)
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage()
    return 0
  }
  const dryRun = argv.includes('--dry-run')
  const remove = argv.includes('--remove')
  const clientArg = argv.indexOf('--client') >= 0 ? argv[argv.indexOf('--client') + 1] : 'claude'
  const client = CLIENTS[String(clientArg || '').toLowerCase()]
  if (!client) {
    console.error(red(`FATAL: unknown client "${clientArg}". Use one of: ${Object.keys(CLIENTS).join(', ')}.`))
    return 1
  }
  const configFile = client.file

  console.log(bold(`${PRODUCT_NAME} install-mcp`))
  console.log(dim(`  client   ${client.label}`))
  console.log(dim(`  config   ${configFile}`))
  console.log(dim(`  entry    ${client.format === 'toml' ? `mcp_servers.${MCP_ENTRY_NAME}` : `mcpServers."${MCP_ENTRY_NAME}"`}`))
  console.log(dim(`  server   ${MCP_SERVER_ENTRY}`))
  console.log(dim(`  mode     ${remove ? 'REMOVE' : 'INSTALL'}${dryRun ? ' (--dry-run, nothing is written)' : ''}`))
  console.log('')

  /* 1. Refuse to register a path that is not there. ------------------------ */
  // The client would spawn it, get ERR_MODULE_NOT_FOUND, and show only a
  // failed-to-connect banner with no hint about which path was wrong.
  if (!remove && !fs.existsSync(MCP_SERVER_ENTRY)) {
    console.error(red(`FATAL: the MCP server entry point is missing: ${MCP_SERVER_ENTRY}`))
    console.error('       Registering it would give every session a server that fails to start,')
    console.error('       so refuse now instead.')
    return 1
  }

  if (client.format === 'toml') {
    console.log(bold(`Add this to ${configFile} (create the file if it does not exist):`))
    console.log('')
    console.log(codexToml())
    console.log(dim('  Codex reads TOML, which this repo deliberately has no parser for, so the block is'))
    console.log(dim('  printed rather than written. Restart Codex afterwards.'))
    return 0
  }

  /* 2. Read the config. --------------------------------------------------- */
  const exists = fs.existsSync(configFile)
  let raw = ''
  let json

  if (exists) {
    try {
      raw = fs.readFileSync(configFile, 'utf8')
      json = JSON.parse(raw)
    } catch (err) {
      console.error(red(`FATAL: could not parse ${configFile}: ${String(err?.message || err)}`))
      console.error(dim('       Refusing to touch it. Fix or restore the file first, then re-run.'))
      return 1
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      console.error(red(`FATAL: ${configFile} is not a JSON object.`))
      return 1
    }
  } else {
    if (remove) {
      console.log(green(`CLEAN  ${configFile} does not exist, so there is nothing to remove.`))
      return 0
    }
    // The client creates this file itself on first run. Creating it here is
    // safe (it merges its own keys in later) but worth saying out loud, because
    // a config file appearing from nowhere is otherwise a small mystery.
    console.log(yellow(`NOTE   ${configFile} does not exist yet, so it will be created.`))
    json = {}
  }

  /* 3. Report anything that would SHADOW the entry we are about to write. -- */
  // Claude Code's project scope fully overrides a same-named user-scope server,
  // so a stale per-project copy silently wins and the user-scope fix appears
  // to do nothing.
  const shadows = []
  if (json.projects && typeof json.projects === 'object') {
    for (const [projectPath, project] of Object.entries(json.projects)) {
      if (project?.mcpServers && Object.hasOwn(project.mcpServers, MCP_ENTRY_NAME)) {
        shadows.push(projectPath)
      }
    }
  }

  const before = json.mcpServers && Object.hasOwn(json.mcpServers, MCP_ENTRY_NAME)
    ? json.mcpServers[MCP_ENTRY_NAME]
    : null

  /* 4. Decide what changes. ----------------------------------------------- */
  const after = remove ? null : desiredEntry()
  const unchanged = JSON.stringify(before) === JSON.stringify(after)

  if (before === null) {
    console.log(`${yellow('ABSENT')} no "${MCP_ENTRY_NAME}" entry in mcpServers`)
  } else {
    console.log(`${yellow('FOUND')}  mcpServers."${MCP_ENTRY_NAME}" is currently:`)
    printJson(before)
  }

  if (unchanged) {
    console.log('')
    console.log(
      green(
        remove
          ? 'Already absent. Nothing to change.'
          : 'Already registered, exactly as intended. Nothing to change.'
      )
    )
    reportShadows(shadows)
    return 0
  }

  console.log('')
  if (remove) {
    console.log(bold(`Would remove mcpServers."${MCP_ENTRY_NAME}".`))
  } else {
    console.log(bold(`Would ${before === null ? 'add' : 'replace'} mcpServers."${MCP_ENTRY_NAME}" with:`))
    printJson(after)
  }

  if (dryRun) {
    console.log('')
    console.log(yellow('--dry-run: nothing was written.'))
    console.log(dim(`  A backup would be taken at ${configFile}.bak-<timestamp> first.`))
    reportShadows(shadows)
    return 0
  }

  /* 5. Back up before touching a file other sessions depend on. ------------ */
  if (exists) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${configFile}.bak-${stamp}`
    try {
      fs.copyFileSync(configFile, backup)
      console.log('')
      console.log(`${green('BACKUP')} ${backup} (${raw.length} bytes)`)
    } catch (err) {
      console.error(red(`FATAL: could not back up ${configFile}: ${String(err?.message || err)}`))
      console.error(dim('       Refusing to edit a file that cannot be backed up.'))
      return 1
    }
  }

  /* 6. Change exactly one key. --------------------------------------------- */
  if (remove) {
    delete json.mcpServers[MCP_ENTRY_NAME]
  } else {
    if (!json.mcpServers || typeof json.mcpServers !== 'object') json.mcpServers = {}
    json.mcpServers[MCP_ENTRY_NAME] = after
  }

  try {
    // Temp file plus rename, 2-space indent, so a concurrent reader sees either
    // the old file or the new one and never a half-written one.
    writeJsonAtomic(configFile, json)
  } catch (err) {
    console.error(red(`FATAL: could not write ${configFile}: ${String(err?.message || err)}`))
    console.error(dim('       The backup above is intact.'))
    return 1
  }

  /* 7. Verify by reading back, never by trusting the write. ---------------- */
  let verified
  try {
    verified = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  } catch (err) {
    console.error(red(`FATAL: ${configFile} did not read back as JSON: ${String(err?.message || err)}`))
    return 1
  }
  const now = verified?.mcpServers && Object.hasOwn(verified.mcpServers, MCP_ENTRY_NAME)
    ? verified.mcpServers[MCP_ENTRY_NAME]
    : null
  if (JSON.stringify(now) !== JSON.stringify(after)) {
    console.error(red(`FAIL: the entry did not survive the write. It reads back as:`))
    printJson(now)
    return 1
  }

  console.log(green(remove ? `REMOVED mcpServers."${MCP_ENTRY_NAME}"` : `WROTE   mcpServers."${MCP_ENTRY_NAME}"`))
  reportShadows(shadows)

  console.log('')
  console.log(
    dim(
      `  ${client.label} reads this file at startup, so an already-running session will not\n` +
        '  see the change. Start a new session, then check its MCP server list.'
    )
  )
  if (!remove) {
    console.log('')
    console.log('  Next: node scripts/doctor.mjs')
  }
  return 0
}

function printJson(value) {
  for (const line of JSON.stringify(value, null, 2).split('\n')) {
    console.log(dim(`         ${line}`))
  }
}

function reportShadows(shadows) {
  if (shadows.length === 0) return
  console.log('')
  console.log(yellow(`WARNING: ${shadows.length} project-scope entr${shadows.length === 1 ? 'y' : 'ies'} named "${MCP_ENTRY_NAME}" exist:`))
  for (const p of shadows) console.log(yellow(`         projects["${p}"].mcpServers."${MCP_ENTRY_NAME}"`))
  console.log(
    dim(
      '         Project scope fully overrides the user-scope entry for those repos, so a\n' +
        '         stale copy there silently wins. This script never touches them; remove or\n' +
        '         update them by hand if they are wrong.'
    )
  )
}

/** Guard the entry point: doctor.mjs imports the constants above. */
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
