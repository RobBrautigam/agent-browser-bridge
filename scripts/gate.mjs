#!/usr/bin/env node
/**
 * gate - the CI and pre-commit gate.
 *
 * Every rule here exists because the corresponding mistake is invisible at
 * review time and expensive at runtime:
 *
 *   native modules   ABI-locked to one Node major. This is the exact defect
 *                    that made the incumbent break on a Node upgrade.
 *   dependencies     the same failure class one level up. Five dependencies is
 *                    a claim the README makes; an allowlist is what keeps it
 *                    true when someone reaches for a convenience package.
 *   chrome.cookies   the one API that would turn a browser bridge into a
 *                    credential exfiltration tool.
 *   credential files a read of Cookies / Login Data / Web Data does the same
 *                    thing at the filesystem level. Local State is the ONLY
 *                    browser file the bridge is allowed to open.
 *   TCP listeners    the entire "a web page or a remote host reaches the
 *                    bridge" threat class is absent only while no listener
 *                    exists. One .listen(port) reintroduces all of it.
 *   em dashes        a house style rule, applied to shipped text as well as code.
 *   console writes   in host/ and mcp-server/ stdout carries framed protocol
 *                    bytes. A stray write corrupts the stream and presents as
 *                    an unparseable stream rather than an error, which is the
 *                    single most expensive way to lose an afternoon. console.log
 *                    is not the only offender: info, debug, dir, table, group,
 *                    count, time*, and trace all write to stdout too.
 *   raw colors       a literal color outside tokens.css is how a theme goes
 *                    half-dark. The token layer is only load-bearing while it
 *                    is the only place a color exists.
 *   debugger perm    Chromium refuses "debugger" as an OPTIONAL permission. A
 *                    well-meaning edit moving it there parses fine and silently
 *                    disables every trusted-input path in the extension.
 *   inline script    MV3's content security policy forbids inline <script> and
 *                    on* handler attributes. The page loads, the handler never
 *                    fires, and the only evidence is a console message in a
 *                    window nobody has open.
 *
 * SELF-EXCLUSION: this file necessarily contains every forbidden string it
 * looks for, so it excludes itself from the text scans. Nothing else is
 * excluded from a rule that applies to it.
 *
 * Comment lines are skipped by the code-shaped rules on purpose. shared/paths.mjs
 * states the credential-file rule in its own header, and a gate that fails on a
 * file for documenting the rule it obeys teaches people to delete the comment.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as sharedProtocol from '../shared/protocol.mjs'
import * as extensionProtocol from '../extension/lib/protocol.js'
import { PRODUCT_NAME } from '../shared/protocol.mjs'
import { CONFIG, renderProjections } from '../shared/config.mjs'
import { readJson } from '../shared/paths.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The constants the extension mirrors from the shared contract. A drift is a
 * silent wire incompatibility, not a load error, so it is checked here on
 * every commit as well as in test/protocol-mirror.test.mjs.
 */
const MIRRORED_CONSTANTS = [
  'PROTOCOL_VERSION',
  'PRODUCT_NAME',
  'PRODUCT_TAGLINE',
  'NATIVE_HOST_ID',
  'MSG',
  'CHUNK_SLICE_BYTES',
  'OPS',
  'TIER',
  'OP_TIER',
  'BROWSER_OPS',
  'BROKER_OPS',
  'HOST_REQ_ALLOWED_OPS',
  'MAX_ARM_MINUTES',
  'ERR',
  'LINK',
  'RESTRICTED_URL_PREFIXES',
  'RAW_TAB_ID_FIELD',
]
const SELF = path.resolve(fileURLToPath(import.meta.url))

const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json')
const EXTENSION_DIR = path.join(REPO_ROOT, 'extension')
const EXTENSION_MANIFEST = path.join(EXTENSION_DIR, 'manifest.json')
const TOKENS_CSS = path.join(EXTENSION_DIR, 'ui', 'tokens.css')

/** Directories that are never ours to police. */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'tmp',
  'coverage',
  'test-results',
  'playwright-report',
  '.playwright-cli',
  '.cache',
])

/** Text we author. Anything else is binary or generated as far as this gate cares. */
const TEXT_EXTENSIONS = new Set([
  '.mjs',
  '.js',
  '.cjs',
  '.json',
  '.md',
  '.html',
  '.css',
  '.cmd',
  '.bat',
  '.ps1',
  '.txt',
  '.yml',
  '.yaml',
  '.xml',
])

/** Where our own runtime code lives. Rules about CODE only look here. */
const CODE_DIRS = ['extension', 'bridged', 'mcp-server', 'host', 'shared', 'scripts', 'test']

/** Where stdout is protocol rather than a console. */
const PROTOCOL_STDOUT_DIRS = ['host', 'mcp-server']

/**
 * Every package this system is allowed to depend on.
 *
 * The list is short by design and the gate is what keeps it short: the
 * incumbent's fatal flaw arrived as a transitive native module, and the only
 * durable defense is refusing to grow the surface in the first place.
 */
const ALLOWED_DEPENDENCIES = new Set(['zod', '@modelcontextprotocol/server'])

/** Dependency fields npm installs from. devDependencies count: they ship in a clone. */
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]

/**
 * Built from a char code so this file can be scanned for em dashes by its own
 * rule without matching itself.
 */
const EM_DASH = String.fromCharCode(0x2014)

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const paint = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s)
const bold = (s) => paint('1', s)
const green = (s) => paint('32', s)
const red = (s) => paint('31', s)
const dim = (s) => paint('2', s)

/* -------------------------------------------------------------------------- */
/* Text rules                                                                  */
/* -------------------------------------------------------------------------- */

const isCommentLine = (line) => /^\s*(\/\/|\/\*|\*|#)/.test(line)

/**
 * Every console method that writes to stdout.
 *
 * warn and error go to stderr and are therefore fine; everything below lands on
 * the same file descriptor as the framed protocol. console.dir is the sneakiest
 * of them because it reads like a debugger helper rather than a print.
 */
const STDOUT_CONSOLE_METHODS =
  /\bconsole\s*\.\s*(log|info|debug|dir|table|group|groupEnd|count|time|timeEnd|timeLog|trace)\s*\(/

/**
 * A literal color: #rgb through #rrggbbaa, or any rgb/rgba/hsl/hsla function.
 * Deliberately not trying to catch named colors - "red" appears in prose, and a
 * gate with false positives gets disabled, which costs more than it saves.
 */
const RAW_COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/

/**
 * An on* handler attribute. The leading whitespace requirement is what keeps
 * this off `content=` and `data-on-click=`, which would otherwise match.
 */
const INLINE_HANDLER_ATTR = /\son[a-z]+\s*=\s*["']/i

/** A <script> tag with no src, across line breaks, which is inline code by definition. */
const INLINE_SCRIPT_TAG = /<script\b(?![^>]*\bsrc\s*=)[^>]*>/gi

/** Anything that hands a string to the filesystem. Used to un-exempt the URL case below. */
const FILESYSTEM_CALL = /\bfs\s*\.|readFile|writeFile|createReadStream|openSync|\bopen\s*\(|realpath/

/**
 * Is the credential-store name on this line part of a URL rather than a path?
 *
 * A credential store is opened by PATH. The one legitimate reason to write the
 * string "Cookies" in this codebase is to PROVE the opposite: test/protocol.test.mjs
 * asserts that file:///.../Default/Cookies is refused by isRestrictedUrl, which
 * is the defense against composing an unarmed navigate with an unarmed read.
 * Failing the gate on the test that proves the rule is the same anti-pattern as
 * failing on the comment that documents it.
 *
 * The exemption is narrow on purpose and drops the moment the line also touches
 * the filesystem, because `readFileSync(new URL('file:///.../Cookies'))` really
 * would be a read.
 */
function namesAStoreInsideAUrl(line) {
  return /:\/\//.test(line) && !FILESYSTEM_CALL.test(line)
}

const RULES = [
  {
    id: 'chrome-cookies',
    what: 'the chrome.cookies API or permission',
    dirs: CODE_DIRS,
    skipComments: true,
    // The API call in code, and the permission in the manifest that would make
    // the call possible. Both have to be absent, not just the call.
    match: (line, ctx) =>
      /\bchrome\s*\.\s*cookies\b/.test(line) ||
      (ctx.base === 'manifest.json' && /["']cookies["']/.test(line)),
    fix: 'The bridge never reads credential stores. Remove the call and the manifest permission.',
  },
  {
    id: 'credential-stores',
    what: 'a read of a browser credential store',
    dirs: CODE_DIRS,
    skipComments: true,
    match: (line) =>
      !namesAStoreInsideAUrl(line) &&
      (/["'`]Login Data["'`]/.test(line) ||
        /["'`]Web Data["'`]/.test(line) ||
        /["'`]Cookies["'`]/.test(line) ||
        /[\\/]Cookies\b/.test(line)),
    fix: "Local State is the only browser file the bridge may open, and only profile.info_cache from it.",
  },
  {
    id: 'tcp-listener',
    what: 'a listener bound to a numeric port',
    dirs: CODE_DIRS,
    skipComments: true,
    // Catches .listen(8080), .listen( 8080 ), .listen({ port: 8080 }).
    // A port held in a variable is not catchable by grep; the architecture
    // review is the backstop for that.
    match: (line) => /\.listen\s*\(\s*\d/.test(line) || /\.listen\s*\(\s*\{[^}]*\bport\s*:\s*\d/.test(line),
    fix: 'There is no network listener anywhere in this system. Use the named pipe in shared/protocol.mjs.',
  },
  {
    id: 'em-dash',
    what: 'an em dash character',
    dirs: null, // every text file we author, docs included
    skipComments: false,
    skipFiles: new Set([path.join(REPO_ROOT, 'package-lock.json')]), // generated, third-party text
    match: (line) => line.includes(EM_DASH),
    fix: 'Use a spaced hyphen, a double hyphen, or better punctuation.',
  },
  {
    id: 'protocol-stdout',
    what: 'a console write where stdout carries protocol bytes',
    dirs: PROTOCOL_STDOUT_DIRS,
    skipComments: true,
    match: (line) => STDOUT_CONSOLE_METHODS.test(line),
    fix:
      'Log to stderr (console.error / console.warn) or to a file. stdout is framed protocol in\n' +
      '               host/ and mcp-server/, and log, info, debug, dir, table, group, count, time* and\n' +
      '               trace all write to it.',
  },
  {
    id: 'raw-color',
    what: 'a literal color outside the token layer',
    dirs: ['extension'],
    skipComments: true,
    skipFiles: new Set([TOKENS_CSS]),
    match: (line) => RAW_COLOR.test(line),
    fix: `Every color composes from a --sb- custom property. Add it to ${path.relative(REPO_ROOT, TOKENS_CSS)} and reference it.`,
  },
  {
    id: 'inline-handler',
    what: 'an on* handler attribute in extension HTML',
    dirs: ['extension'],
    skipComments: false,
    extensions: new Set(['.html']),
    match: (line) => INLINE_HANDLER_ATTR.test(line),
    fix: "MV3's content security policy silently ignores these. Attach the listener from the page's module script.",
  },
]

/**
 * Whole-file rules, for shapes a single line cannot express.
 * Same reporting path as the line rules; only the scan differs.
 */
const FILE_RULES = [
  {
    id: 'inline-script',
    what: 'a <script> with no src in extension HTML',
    dirs: ['extension'],
    extensions: new Set(['.html']),
    scan: (content) => {
      const hits = []
      for (const m of content.matchAll(INLINE_SCRIPT_TAG)) {
        hits.push({ index: m.index, text: m[0] })
      }
      return hits
    },
    fix: "MV3 refuses to execute inline script. Move the code to a .js file and load it with <script type=\"module\" src=\"...\">.",
  },
]

/* -------------------------------------------------------------------------- */
/* Structural checks - facts about a file's meaning, not its text              */
/* -------------------------------------------------------------------------- */

const CHECKS = [
  {
    id: 'config-sync',
    what: 'the generated extension config, the manifest and package.json match bridge.config.json',
    scope: 'bridge.config.json, extension/lib/config.js, extension/manifest.json, package.json',
    fix: 'npm run sync-config   (the extension cannot read the config file, so its copy is generated)',
    run: () => {
      const hits = []
      for (const { file, text } of renderProjections(CONFIG)) {
        let current = null
        try {
          current = fs.readFileSync(file, 'utf8')
        } catch {
          current = null
        }
        if (current !== text) {
          hits.push({ where: path.relative(REPO_ROOT, file), detail: 'does not match what bridge.config.json projects' })
        }
      }
      return hits
    },
  },
  {
    id: 'protocol-mirror',
    what: 'extension/lib/protocol.js mirrors shared/protocol.mjs',
    scope: 'shared/protocol.mjs, extension/lib/protocol.js',
    fix: 'Copy the changed constant into the other file. The two are kept in sync by hand because the extension cannot import outside its folder.',
    run: () => {
      const hits = []
      for (const name of MIRRORED_CONSTANTS) {
        const a = JSON.stringify(sharedProtocol[name])
        const b = JSON.stringify(extensionProtocol[name])
        if (a !== b) hits.push({ where: name, detail: `shared: ${a}  extension: ${b}` })
      }
      for (const [key, value] of Object.entries(extensionProtocol.TIMING || {})) {
        if (sharedProtocol.TIMING[key] !== value) {
          hits.push({ where: `TIMING.${key}`, detail: `shared: ${sharedProtocol.TIMING[key]}  extension: ${value}` })
        }
      }
      return hits
    },
  },
  {
    id: 'native-modules',
    what: 'no .node binary anywhere',
    scope: 'repo, node_modules included',
    fix: 'a native module is ABI-locked to one Node major. Remove the dependency.',
    run: () => {
      const hits = []
      // Walks node_modules too, which the text rules do not: a native binary
      // arriving through a transitive dependency is exactly what this catches.
      for (const file of walk(REPO_ROOT, { includeSkipped: true })) {
        if (file.toLowerCase().endsWith('.node')) hits.push({ where: path.relative(REPO_ROOT, file) })
      }
      return hits
    },
  },
  {
    id: 'dependency-allowlist',
    what: `only ${[...ALLOWED_DEPENDENCIES].join(' and ')}`,
    scope: 'package.json',
    fix:
      'Every dependency is a native-module and supply-chain risk this system refuses to take.\n' +
      '               Solve it with the standard library, or change ALLOWED_DEPENDENCIES here and say why.',
    run: () => {
      const pkg = readJsonOrNull(PACKAGE_JSON)
      if (!pkg) return [{ where: path.relative(REPO_ROOT, PACKAGE_JSON), detail: 'missing or not valid JSON' }]
      const hits = []
      for (const field of DEPENDENCY_FIELDS) {
        const block = pkg[field]
        if (!block || typeof block !== 'object') continue
        for (const name of Object.keys(block)) {
          if (ALLOWED_DEPENDENCIES.has(name)) continue
          hits.push({ where: `${field}.${name}`, detail: `${name}@${block[name]} is not on the allowlist` })
        }
      }
      return hits
    },
  },
  {
    id: 'debugger-permission',
    what: 'debugger is a required permission and is never optional',
    scope: 'extension/manifest.json',
    fix:
      'Chromium refuses "debugger" in optional_permissions, so the request fails at runtime and\n' +
      '               every trusted-input path (click, fill, pressKeys) silently degrades. Keep it in\n' +
      '               "permissions" and keep optional_permissions absent entirely.',
    run: () => {
      const manifest = readJsonOrNull(EXTENSION_MANIFEST)
      if (!manifest) {
        return [{ where: path.relative(REPO_ROOT, EXTENSION_MANIFEST), detail: 'missing or not valid JSON' }]
      }
      const hits = []
      const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : []
      if (!permissions.includes('debugger')) {
        hits.push({
          where: 'permissions',
          detail: 'does not list "debugger"; trusted-input operations cannot work without it',
        })
      }
      if (Object.hasOwn(manifest, 'optional_permissions')) {
        hits.push({
          where: 'optional_permissions',
          detail: `the key exists (${JSON.stringify(manifest.optional_permissions)}); it must not exist at all`,
        })
      }
      return hits
    },
  },
]

/* -------------------------------------------------------------------------- */

const readJsonOrNull = (file) => readJson(file, null)

function* walk(dir, { includeSkipped = false } = {}) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!includeSkipped && SKIP_DIRS.has(entry.name)) continue
      if (includeSkipped && entry.name === '.git') continue
      yield* walk(full, { includeSkipped })
    } else if (entry.isFile()) {
      yield full
    }
  }
}

/** Is `file` inside any of `dirs` (repo-relative directory names)? */
function inDirs(file, dirs) {
  if (!dirs) return true
  const rel = path.relative(REPO_ROOT, file)
  const top = rel.split(path.sep)[0]
  return dirs.includes(top)
}

/** Does a rule apply to this file at all? Shared by the line rules and the file rules. */
function applies(rule, file) {
  if (!inDirs(file, rule.dirs)) return false
  if (rule.skipFiles && rule.skipFiles.has(path.resolve(file))) return false
  if (rule.extensions && !rule.extensions.has(path.extname(file).toLowerCase())) return false
  return true
}

/** 1-based line number of a character offset, so a whole-file scan reports like a line rule. */
function lineOf(content, index) {
  let line = 1
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line += 1
  }
  return line
}

function main() {
  console.log(bold(`${PRODUCT_NAME} gate`))
  console.log(dim(`  repo ${REPO_ROOT}`))
  console.log('')

  /** @type {Map<string, {file:string,line:number,text:string}[]>} */
  const violations = new Map()
  for (const rule of [...RULES, ...FILE_RULES]) violations.set(rule.id, [])

  for (const file of walk(REPO_ROOT)) {
    if (path.resolve(file) === SELF) continue // see SELF-EXCLUSION above
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue

    const lineRules = RULES.filter((r) => applies(r, file))
    const fileRules = FILE_RULES.filter((r) => applies(r, file))
    if (lineRules.length === 0 && fileRules.length === 0) continue

    let content
    try {
      content = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const rel = path.relative(REPO_ROOT, file)
    const ctx = { file, rel, base: path.basename(file) }

    const lines = content.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line === '') continue
      const comment = isCommentLine(line)
      for (const rule of lineRules) {
        if (rule.skipComments && comment) continue
        if (!rule.match(line, ctx)) continue
        violations.get(rule.id).push({ file: rel, line: i + 1, text: line.trim().slice(0, 140) })
      }
    }

    for (const rule of fileRules) {
      for (const hit of rule.scan(content, ctx)) {
        violations
          .get(rule.id)
          .push({ file: rel, line: lineOf(content, hit.index), text: String(hit.text).trim().slice(0, 140) })
      }
    }
  }

  /* Report ---------------------------------------------------------------- */
  let failed = 0
  let total = 0

  /** One result row. Every rule reports through here so the columns cannot drift. */
  const emit = (id, what, scope, ok) => {
    console.log(`  ${ok ? green('PASS') : red('FAIL')}  ${id.padEnd(20)}  ${what} ${dim(`[${scope}]`)}`)
  }

  for (const check of CHECKS) {
    const hits = check.run()
    const ok = hits.length === 0
    if (!ok) failed += 1
    total += hits.length
    emit(check.id, check.what, check.scope, ok)
    for (const hit of hits) {
      console.log(red(`          ${hit.where}`))
      if (hit.detail) console.log(dim(`            ${hit.detail}`))
    }
    if (!ok) console.log(dim(`          fix: ${check.fix}`))
  }

  for (const rule of [...RULES, ...FILE_RULES]) {
    const hits = violations.get(rule.id)
    const ok = hits.length === 0
    if (!ok) failed += 1
    total += hits.length
    const scope = rule.dirs ? rule.dirs.join(', ') : 'all text files'
    emit(rule.id, rule.what, scope, ok)
    for (const hit of hits) {
      console.log(red(`          ${hit.file}:${hit.line}`))
      console.log(dim(`            ${hit.text}`))
    }
    if (!ok) console.log(dim(`          fix: ${rule.fix}`))
  }

  console.log('')
  const ruleCount = CHECKS.length + RULES.length + FILE_RULES.length
  if (failed === 0) {
    console.log(green(` Gate passed. ${ruleCount} rules, 0 violations.`))
    return 0
  }
  console.log(red(` Gate failed. ${failed} rule(s), ${total} violation(s).`))
  return 1
}

process.exitCode = main()
