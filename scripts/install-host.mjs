#!/usr/bin/env node
/**
 * install-host - register the native messaging host with the browsers.
 *
 * Two artifacts, both tiny, both idempotent:
 *
 *   1. The native messaging manifest, whose `allowed_origins` pins exactly one
 *      extension ID. Chromium parses this file itself and rejects wildcards,
 *      which is why extension-to-host authentication is enforced by the
 *      browser rather than by our code.
 *
 *   2. The pointer the browser follows to find it:
 *        Windows        ONE registry value, under Chrome's key. Brave is a
 *                       Chromium-branded build with no Windows override, so
 *                       launch_context_win.cc falls back to Chrome's key for
 *                       it too. Confirmed on the reference machine.
 *        macOS, Linux   the manifest file itself, placed inside each installed
 *                       browser's own NativeMessagingHosts directory. There is
 *                       no cross-browser fallback there, so one file per
 *                       browser.
 *
 * WHICH EXTENSION ID. Chromium derives an unpacked extension's ID from its
 * folder path unless the manifest carries a `key`, in which case the ID comes
 * from the key. This installer handles both, in this order:
 *
 *   --extension-id <id>   what chrome://extensions shows, when it disagrees
 *   manifest `key`        present after `node scripts/keygen.mjs` (optional;
 *                         it makes the ID survive moving the folder)
 *   the folder path       the default for a fresh clone. The path is
 *                         canonicalized the way the browser's file picker
 *                         reports it, so it should match; if the ID shown in
 *                         chrome://extensions differs, re-run with
 *                         --extension-id and that ID.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { idFromManifestKey, idFromPath, extensionOrigin } from '../shared/extid.mjs'
import {
  BASE_DIR,
  HOST_MANIFEST_FILE,
  IS_WINDOWS,
  POSIX_HOST_SHIM_FILE,
  ensureBaseDir,
  browserByVendor,
  hostManifestTargets,
  readJson,
  writeJsonAtomic,
} from '../shared/paths.mjs'
import { NATIVE_HOST_ID, PRODUCT_NAME, PRODUCT_TAGLINE } from '../shared/protocol.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const EXTENSION_DIR = path.join(REPO_ROOT, 'extension')
const MANIFEST_FILE = path.join(EXTENSION_DIR, 'manifest.json')
const HOST_ENTRY = path.join(REPO_ROOT, 'host', 'index.mjs')

/** The browser-owned entry point on Windows. A .cmd shim because Node has no stable SEA yet. */
export const HOST_CMD_FILE = path.join(REPO_ROOT, 'host', 'bridge-host.cmd')

export const PLACEHOLDER = 'PLACEHOLDER_REPLACED_BY_KEYGEN'

/** Full registry path of our one value (Windows). Chrome's key, which Brave falls back to. */
export const HOST_REG_KEY = `${browserByVendor('chrome').registryKey}\\${NATIVE_HOST_ID}`

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const paint = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s)
const bold = (s) => paint('1', s)
const green = (s) => paint('32', s)
const yellow = (s) => paint('33', s)
const red = (s) => paint('31', s)
const dim = (s) => paint('2', s)

/* -------------------------------------------------------------------------- */
/* Extension ID resolution, exported because doctor.mjs reports the same facts */
/* -------------------------------------------------------------------------- */

/**
 * Chromium hashes the extension folder's ABSOLUTE path as the browser's file
 * picker reports it: real on-disk case on Windows, symlinks resolved. Ask the
 * filesystem for that spelling rather than trusting whatever cwd or argv gave
 * us, or the derived ID silently differs from the loaded one.
 */
export function canonicalExtensionDir(dir = EXTENSION_DIR) {
  try {
    return fs.realpathSync.native(dir)
  } catch {
    return path.resolve(dir)
  }
}

/**
 * @param {{manifest?:object|null, extensionDir?:string, override?:string|null}} [opts]
 * @returns {{id:string|null, source:'argument'|'manifest key'|'folder path'|null, detail:string, error?:string}}
 */
export function resolveExtensionId({ manifest = null, extensionDir = EXTENSION_DIR, override = null } = {}) {
  if (override) {
    const id = String(override).trim().toLowerCase()
    if (!/^[a-p]{32}$/.test(id)) {
      return { id: null, source: null, detail: '', error: `"${override}" is not an extension ID (32 letters a to p).` }
    }
    return { id, source: 'argument', detail: 'given with --extension-id' }
  }
  const key = typeof manifest?.key === 'string' ? manifest.key.trim() : ''
  if (key !== '' && key !== PLACEHOLDER) {
    try {
      return { id: idFromManifestKey(key), source: 'manifest key', detail: 'pinned by the key in extension/manifest.json' }
    } catch (err) {
      return { id: null, source: null, detail: '', error: `the manifest key is not valid base64 DER: ${err?.message || err}` }
    }
  }
  const canonical = canonicalExtensionDir(extensionDir)
  return { id: idFromPath(canonical), source: 'folder path', detail: canonical }
}

/* -------------------------------------------------------------------------- */
/* Registry helpers (Windows), exported because doctor.mjs asserts the same facts */
/* -------------------------------------------------------------------------- */

/**
 * Resolve reg.exe absolutely when we can. PATH lookups are fine in practice,
 * but an absolute path removes any chance of shadowing by something else named
 * `reg` earlier on PATH.
 */
export function regExe() {
  const sysRoot = process.env.SystemRoot || process.env.windir
  if (sysRoot) {
    const abs = path.join(sysRoot, 'System32', 'reg.exe')
    if (fs.existsSync(abs)) return abs
  }
  return 'reg.exe'
}

/**
 * Read a key's default value.
 * @returns {{exists:boolean, value:string|null, raw:string}}
 */
export function readRegistryDefault(keyPath) {
  let out
  try {
    out = execFileSync(regExe(), ['query', keyPath, '/ve'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    // reg exits non-zero when the key is absent, which is a normal answer here.
    return { exists: false, value: null, raw: String(err?.stdout || err?.message || '') }
  }
  // Split on the type token rather than the value name: `(Default)` is
  // localized, `REG_SZ` is not.
  const m = /\bREG_SZ\s+(.*)$/m.exec(out)
  return { exists: true, value: m ? m[1].trim() : null, raw: out }
}

/** True when a registry key exists at all, regardless of its values. */
export function registryKeyExists(keyPath) {
  try {
    execFileSync(regExe(), ['query', keyPath], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/* -------------------------------------------------------------------------- */
/* The POSIX launcher                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The shell script the browser spawns on macOS and Linux.
 *
 * GENERATED with the absolute path to node baked in, because a browser started
 * from the Dock, Spotlight or a desktop menu inherits a minimal PATH that
 * usually does not contain node. BRIDGE_NODE still overrides it, matching the
 * Windows shim. `exec` so the browser's stdio pipes go straight to node with no
 * shell in between to buffer or to outlive it.
 *
 * STDOUT IS PROTOCOL: nothing in this script may print.
 */
export function buildPosixShim({ node = process.execPath, hostEntry = HOST_ENTRY } = {}) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
  return [
    '#!/bin/sh',
    `# ${PRODUCT_NAME} native messaging host launcher. GENERATED by scripts/install-host.mjs.`,
    '# Edit that, not this. Nothing here may write to stdout: it is the protocol stream.',
    `exec "\${BRIDGE_NODE:-${node}}" ${q(hostEntry)} "$@"`,
    '',
  ].join('\n')
}

/** The path the manifest points at on this platform. */
export function hostLauncherPath() {
  return IS_WINDOWS ? HOST_CMD_FILE : POSIX_HOST_SHIM_FILE
}

/* -------------------------------------------------------------------------- */

function usage() {
  console.log(`
${bold(`${PRODUCT_NAME} install-host`)}

  node scripts/install-host.mjs                        register the host with every installed browser
  node scripts/install-host.mjs --dry-run              show exactly what would be written
  node scripts/install-host.mjs --extension-id <id>    use the ID chrome://extensions shows, when it differs
  node scripts/install-host.mjs --all                  macOS/Linux: write for every known browser, installed or not
`)
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] || null : null
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage()
    return 0
  }
  const dryRun = argv.includes('--dry-run')
  const all = argv.includes('--all')

  /* 1. Work out the extension ID. */
  const manifest = readJson(MANIFEST_FILE, null)
  if (!manifest) {
    console.error(red(`FATAL: cannot read ${MANIFEST_FILE}.`))
    console.error('       The extension folder must exist before the host can be registered.')
    return 1
  }
  const resolved = resolveExtensionId({ manifest, override: argValue(argv, '--extension-id') })
  if (!resolved.id) {
    console.error(red(`FATAL: ${resolved.error}`))
    return 1
  }
  const extensionId = resolved.id
  const origin = extensionOrigin(extensionId)

  /* 2. The launcher the browser spawns must exist, or the bridge is dead on arrival. */
  const launcher = hostLauncherPath()
  if (IS_WINDOWS && !fs.existsSync(launcher)) {
    console.error(red(`FATAL: the host entry point is missing: ${launcher}`))
    console.error('       Chromium would spawn a path that does not exist and report only')
    console.error('       "Specified native messaging host not found", so refuse now instead.')
    return 1
  }
  if (!fs.existsSync(HOST_ENTRY)) {
    console.error(red(`FATAL: the host is missing: ${HOST_ENTRY}`))
    return 1
  }

  const hostManifest = {
    name: NATIVE_HOST_ID,
    description: `${PRODUCT_NAME} - ${PRODUCT_TAGLINE}`,
    path: launcher,
    type: 'stdio',
    allowed_origins: [origin],
  }

  const targets = hostManifestTargets({ installedOnly: !all })

  console.log(bold(`${PRODUCT_NAME} install-host`))
  console.log(dim(`  extension id   ${extensionId}  (${resolved.source}: ${resolved.detail})`))
  console.log(dim(`  origin         ${origin}`))
  console.log(dim(`  host launcher  ${launcher}`))
  for (const t of targets) console.log(dim(`  manifest       ${t.file}  (${t.label})`))
  if (IS_WINDOWS) console.log(dim(`  registry key   ${HOST_REG_KEY}`))
  console.log('')

  if (!IS_WINDOWS && targets.length === 0) {
    console.error(red('FATAL: no Chrome or Brave profile directory was found on this machine.'))
    console.error('       Open the browser once so it creates its directory, or pass --all to write')
    console.error('       a manifest into every known location regardless.')
    return 1
  }

  if (dryRun) {
    console.log(yellow('--dry-run: nothing was written. The manifest would be:'))
    console.log(JSON.stringify(hostManifest, null, 2))
    console.log('')
    if (IS_WINDOWS) {
      console.log(yellow('And one registry command would run:'))
      console.log(`  reg add "${HOST_REG_KEY}" /ve /t REG_SZ /d "${HOST_MANIFEST_FILE}" /f`)
      console.log(
        dim('  (that line is for PowerShell or cmd. Git Bash rewrites /ve into a path and reg rejects it.\n' +
          '   This script calls reg.exe directly, so it is unaffected either way.)')
      )
    } else {
      console.log(yellow(`And the launcher ${POSIX_HOST_SHIM_FILE} would be:`))
      console.log(buildPosixShim())
    }
    return 0
  }

  /* 3. Write the launcher (POSIX) and the manifest(s). */
  ensureBaseDir()
  if (!IS_WINDOWS) {
    fs.writeFileSync(POSIX_HOST_SHIM_FILE, buildPosixShim(), { encoding: 'utf8', mode: 0o755 })
    fs.chmodSync(POSIX_HOST_SHIM_FILE, 0o755)
    console.log(green(`wrote ${POSIX_HOST_SHIM_FILE}`))
  }
  for (const t of targets) {
    writeJsonAtomic(t.file, hostManifest)
    console.log(green(`wrote ${t.file}`))
  }

  /* 4. Windows: the single registry value. */
  if (IS_WINDOWS) {
    try {
      execFileSync(
        regExe(),
        ['add', HOST_REG_KEY, '/ve', '/t', 'REG_SZ', '/d', HOST_MANIFEST_FILE, '/f'],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      )
    } catch (err) {
      console.error(red('FATAL: reg add failed.'))
      console.error(String(err?.stderr || err?.message || err))
      return 1
    }
    console.log(green(`wrote ${HOST_REG_KEY} (default value)`))
  }

  /* 5. Verify by reading back, never by trusting the write. */
  const problems = []
  if (IS_WINDOWS) {
    const readBack = readRegistryDefault(HOST_REG_KEY)
    if (!readBack.exists) problems.push('the registry key does not exist after writing it')
    else if (readBack.value !== HOST_MANIFEST_FILE) {
      problems.push(`the registry value is "${readBack.value}", expected "${HOST_MANIFEST_FILE}"`)
    }
  }
  for (const t of targets) {
    if (!fs.existsSync(t.file)) {
      problems.push(`${t.file} is not on disk`)
      continue
    }
    const written = readJson(t.file, null)
    if (!written) problems.push(`${t.file} did not read back as JSON`)
    else if (written.allowed_origins?.[0] !== origin) {
      problems.push(`${t.file}: allowed_origins is ${JSON.stringify(written.allowed_origins)}, expected [${origin}]`)
    }
  }
  if (!IS_WINDOWS) {
    try {
      fs.accessSync(POSIX_HOST_SHIM_FILE, fs.constants.X_OK)
    } catch {
      problems.push(`${POSIX_HOST_SHIM_FILE} is not executable`)
    }
  }

  if (problems.length > 0) {
    console.error('')
    for (const p of problems) console.error(red(`FAIL  ${p}`))
    return 1
  }

  console.log('')
  console.log(green('Verified: the browser will find a manifest that authorizes exactly one extension.'))
  console.log('')
  console.log('  Next:')
  console.log('    1. node scripts/install-broker.mjs')
  console.log('    2. Load the unpacked extension in each profile, then node scripts/doctor.mjs')
  console.log('')
  if (resolved.source === 'folder path') {
    console.log(
      yellow(
        `  The ID above was derived from the folder path. After "Load unpacked", compare it with the\n` +
          `  ID chrome://extensions shows for ${PRODUCT_NAME}. If they differ, run:\n` +
          `    node scripts/install-host.mjs --extension-id <the id the browser shows>`
      )
    )
    console.log('')
  }
  if (IS_WINDOWS) {
    console.log(dim(`  Brave needs no key of its own; it falls back to ${HOST_REG_KEY.split('\\').slice(0, -1).join('\\')}`))
  }
  console.log(dim(`  State lives in ${BASE_DIR}`))
  return 0
}

/** Guard the entry point: doctor.mjs imports the helpers above. */
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
