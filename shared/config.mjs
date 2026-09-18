/**
 * Product identity, read from bridge.config.json at the repo root.
 *
 * Every Node-side module imports its names from here. The extension cannot
 * read files outside its own folder, so it gets the same values through the
 * GENERATED extension/lib/config.js, written by scripts/sync-config.mjs and
 * checked by scripts/gate.mjs. If the two ever disagree the gate fails, which
 * is the only way a drift between "what the extension calls connectNative
 * with" and "what the installer registered" becomes visible before it presents
 * as "Specified native messaging host not found".
 *
 * Environment variables are deliberately NOT derived from the product name:
 * BRIDGE_DEBUG, BRIDGE_QUIET, BRIDGE_WATCH_PARENT, BRIDGE_NODE and BRIDGE_HOME
 * are fixed, so a rename never silently changes which variable a launcher or a
 * shim reads. The same goes for log prefixes such as `[bridge-host]`.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CONFIG_FILE = path.join(REPO_ROOT, 'bridge.config.json')

/**
 * Names Windows refuses as a path segment whatever the extension. A state
 * directory called "con" fails every file operation with no useful error.
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * Unix domain socket paths are capped at about 104 bytes on macOS. The socket
 * lives at <state dir>/<socketName>.sock under ~/Library/Application Support,
 * so both names have to stay short for the path to fit any real user name.
 * 20 characters each keeps the default location under the cap for user names
 * up to about 20 characters; BRIDGE_HOME shortens it further when it does not.
 */
const SHORT_SLUG = /^[a-z0-9][a-z0-9-]{0,19}$/
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * The keys a valid config must carry. `rule` is the shape; `why` is the
 * sentence a failure prints, because a regex on its own tells nobody what a
 * legal value looks like.
 */
export const CONFIG_SHAPE = Object.freeze({
  // Chrome caps a manifest `name` at 45 characters.
  productName: { rule: /^\S.{0,44}$/, why: 'a display name of 1 to 45 characters (the manifest name limit)' },
  // Chrome caps a manifest `description` at 132 characters.
  tagline: { rule: /^.{0,132}$/, why: 'at most 132 characters (the manifest description limit)' },
  // Chromium's native messaging host name rule: lowercase alphanumerics, dots
  // and underscores, no leading or trailing dot, no consecutive dots.
  nativeHostId: {
    rule: /^[a-z0-9_]+(\.[a-z0-9_]+)*$/,
    why: 'lowercase letters, digits, underscores and single dots, such as com.example.host',
  },
  socketName: { rule: SHORT_SLUG, why: 'a slug of 1 to 20 lowercase letters, digits and hyphens', reserved: true },
  stateDirName: { rule: SHORT_SLUG, why: 'a slug of 1 to 20 lowercase letters, digits and hyphens', reserved: true },
  // Task Scheduler refuses these characters in a task name.
  serviceName: {
    rule: /^[^\\/:*?"<>|\s][^\\/:*?"<>|]{0,63}$/,
    why: 'a name of 1 to 64 characters without \\ / : * ? " < > |',
  },
  mcpServerName: { rule: SLUG, why: 'a slug of 1 to 64 lowercase letters, digits and hyphens', reserved: true },
})

/**
 * Validate a config object. Throws with a message naming the key and the
 * legal shape, so a broken config fails at import time in every process
 * rather than as a bad pipe name three hops away.
 */
export function validateConfig(raw, { file = CONFIG_FILE } = {}) {
  const out = {}
  for (const [key, spec] of Object.entries(CONFIG_SHAPE)) {
    const value = raw?.[key]
    if (typeof value !== 'string' || !spec.rule.test(value)) {
      throw new Error(`${file}: "${key}" is ${JSON.stringify(value)}; it must be ${spec.why}.`)
    }
    if (spec.reserved && WINDOWS_RESERVED.test(value)) {
      throw new Error(`${file}: "${key}" is "${value}", which Windows reserves as a device name.`)
    }
    out[key] = value
  }
  return Object.freeze(out)
}

export function loadConfig(file = CONFIG_FILE) {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${err?.message || err}`)
  }
  return validateConfig(raw, { file })
}

export const CONFIG = loadConfig()

export const PRODUCT_NAME = CONFIG.productName
export const PRODUCT_TAGLINE = CONFIG.tagline
export const NATIVE_HOST_ID = CONFIG.nativeHostId
export const SOCKET_NAME = CONFIG.socketName
export const STATE_DIR_NAME = CONFIG.stateDirName
export const SERVICE_NAME = CONFIG.serviceName
export const MCP_SERVER_NAME = CONFIG.mcpServerName

/** launchd label on macOS. Reverse-DNS, like the host id it extends. */
export function launchdLabelFor(config = CONFIG) {
  return `${config.nativeHostId}.broker`
}
/** systemd user unit name on Linux. Derived from the state directory slug. */
export function systemdUnitFor(config = CONFIG) {
  return `${config.stateDirName}-broker`
}
export const LAUNCHD_LABEL = launchdLabelFor()
export const SYSTEMD_UNIT = systemdUnitFor()

/**
 * The exact text of extension/lib/config.js for a config. Kept here so the
 * generator and the gate cannot disagree about what "in sync" means.
 */
export function renderExtensionConfig(config = CONFIG) {
  const j = (v) => JSON.stringify(v)
  return [
    '/**',
    ' * GENERATED by scripts/sync-config.mjs from bridge.config.json. Do not edit.',
    ' *',
    ' * The extension cannot read files outside its own folder, so the product',
    ' * identity is copied here. scripts/gate.mjs fails when this file and',
    ' * bridge.config.json disagree.',
    ' */',
    '',
    `export const PRODUCT_NAME = ${j(config.productName)}`,
    `export const PRODUCT_TAGLINE = ${j(config.tagline)}`,
    `export const NATIVE_HOST_ID = ${j(config.nativeHostId)}`,
    `export const SERVICE_NAME = ${j(config.serviceName)}`,
    `export const LAUNCHD_LABEL = ${j(launchdLabelFor(config))}`,
    `export const SYSTEMD_UNIT = ${j(systemdUnitFor(config))}`,
    '',
  ].join('\n')
}

export const EXTENSION_CONFIG_FILE = path.join(REPO_ROOT, 'extension', 'lib', 'config.js')
export const MANIFEST_FILE = path.join(REPO_ROOT, 'extension', 'manifest.json')
export const PACKAGE_FILE = path.join(REPO_ROOT, 'package.json')

/** Cache keyed on the manifest's modification time and size. */
let installedVersionCache = { key: null, version: null }

/**
 * The extension version the INSTALL FOLDER holds right now.
 *
 * Read from the manifest on disk rather than imported as a constant, and that
 * is the whole point of the function. A browser reads an unpacked extension's
 * code once, when it loads it, so the version a profile is RUNNING and the
 * version the folder HOLDS are two different facts that drift apart the moment
 * somebody pulls. The broker compares them to answer the only two questions an
 * operator has - which profiles are behind, and is there anything new for a
 * reload to load - and it has to re-read the file to do it, because the folder
 * changes underneath a broker that has been running since login.
 *
 * Cached on the manifest's mtime and size so the board can ask on every poll
 * without a syscall storm, and so a pull is picked up on the next poll rather
 * than at the next broker restart.
 *
 * @returns {string|null} null when the manifest is missing or unreadable, which
 *   is a real state on a half-finished install and must not read as "0.0.0"
 */
export function installedExtensionVersion() {
  let key
  try {
    const stat = fs.statSync(MANIFEST_FILE)
    key = `${stat.mtimeMs}:${stat.size}`
  } catch {
    installedVersionCache = { key: null, version: null }
    return null
  }
  if (key === installedVersionCache.key) return installedVersionCache.version

  let version = null
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'))
    if (typeof manifest?.version === 'string' && manifest.version !== '') version = manifest.version
  } catch {
    version = null
  }
  installedVersionCache = { key, version }
  return version
}

/**
 * Every file the config is projected into, with the exact text each must
 * hold. sync-config WRITES these; the gate and the tests COMPARE against them,
 * so a hand edit that drifts any of the generated fields fails the commit
 * instead of shipping a manifest whose name disagrees with the config.
 *
 * The manifest and package.json keep every other key they carry; only the
 * identity fields are rewritten, and the files are re-serialized with the
 * same two-space indent npm and Chrome tooling use.
 */
export function renderProjections(config = CONFIG) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'))
  manifest.name = config.productName
  manifest.description = config.tagline
  manifest.action = { ...(manifest.action || {}), default_title: config.productName }

  const pkg = JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf8'))
  pkg.name = config.stateDirName
  pkg.description = `${config.productName} - ${config.tagline}`

  return [
    { file: EXTENSION_CONFIG_FILE, text: renderExtensionConfig(config) },
    { file: MANIFEST_FILE, text: JSON.stringify(manifest, null, 2) + '\n' },
    { file: PACKAGE_FILE, text: JSON.stringify(pkg, null, 2) + '\n' },
  ]
}
