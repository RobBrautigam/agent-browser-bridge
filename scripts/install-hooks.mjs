#!/usr/bin/env node
/**
 * install-hooks - put the gate back into .git/hooks/pre-commit.
 *
 * The README says the hard rules are enforced on every commit. They were not:
 * the hook this repo shipped with came from an earlier template and only
 * checks the commit identity, so every gate rule was enforced by memory alone.
 *
 * .git/hooks is not version controlled, which is why this script exists rather
 * than a committed hook file: a fresh clone starts with no hooks at all, and
 * `npm run hooks:install` is how it gets them back.
 *
 * Two things this script is careful about:
 *
 *   It APPENDS, it never replaces. The existing identity check blocks a real
 *   mistake (committing as an address that resolves to a GitHub account the operator
 *   does not control), so it is left exactly as found.
 *
 *   It inserts ABOVE the hook's trailing `exit 0`. Appending after it looks
 *   right, runs never, and the gate would silently stop guarding anything -
 *   which is the same class of invisible failure the gate itself exists to
 *   catch.
 *
 * The block is delimited by markers so re-running updates it in place instead
 * of stacking copies.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { PRODUCT_NAME } from '../shared/protocol.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const BEGIN = `# === ${PRODUCT_NAME} gate (managed by scripts/install-hooks.mjs) ===`
const END = `# === end ${PRODUCT_NAME} gate ===`

/**
 * The block itself.
 *
 * It runs the gate against the WORKING TREE, not the index. A staged-only check
 * would need a temp checkout, and the failure it would catch (a violation
 * staged but since edited away) is rarer than the confusion that machinery
 * causes. The gate is also run in CI and by hand, so this is a fast guard, not
 * the only one.
 */
const BLOCK = `${BEGIN}
# Runs scripts/gate.mjs before every commit: no native modules, no dependency
# outside the allowlist, no credential-store read, no TCP listener, no stray
# stdout write in the protocol paths, no em dash, no raw color or inline script
# in the extension. Every one of those is invisible in review and expensive at
# runtime. Checks the working tree, not the index.
if command -v node >/dev/null 2>&1; then
  if ! node "$(git rev-parse --show-toplevel)/scripts/gate.mjs"; then
    echo ""
    echo "COMMIT BLOCKED by the ${PRODUCT_NAME} gate. The FAIL lines above say what and where."
    echo "  Re-run it yourself with:   npm run gate"
    echo "  This hook is reinstalled by:   npm run hooks:install"
    echo ""
    exit 1
  fi
else
  echo "WARNING: node is not on PATH, so the ${PRODUCT_NAME} gate did not run for this commit."
fi
${END}`

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const paint = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s)
const bold = (s) => paint('1', s)
const green = (s) => paint('32', s)
const yellow = (s) => paint('33', s)
const red = (s) => paint('31', s)
const dim = (s) => paint('2', s)

/**
 * Where git will actually look for hooks.
 *
 * Asking git rather than assuming `.git/hooks` covers a worktree (where .git is
 * a file) and a repo that has set core.hooksPath. Installing into the wrong
 * directory would produce a hook that exists and never runs.
 */
function hooksDir() {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    return path.resolve(REPO_ROOT, out)
  } catch {
    return path.join(REPO_ROOT, '.git', 'hooks')
  }
}

function usage() {
  console.log(`
${bold(`${PRODUCT_NAME} install-hooks`)}

  node scripts/install-hooks.mjs             install or refresh the pre-commit gate block
  node scripts/install-hooks.mjs --dry-run   show what would change, write nothing
  node scripts/install-hooks.mjs --remove    take the gate block out again
  node scripts/install-hooks.mjs --help

Appends to .git/hooks/pre-commit without touching anything already in it.
`)
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage()
    return 0
  }
  const dryRun = argv.includes('--dry-run')
  const remove = argv.includes('--remove')

  const dir = hooksDir()
  const hookFile = path.join(dir, 'pre-commit')

  console.log(bold(`${PRODUCT_NAME} install-hooks`))
  console.log(dim(`  hook   ${hookFile}`))
  console.log(dim(`  mode   ${remove ? 'REMOVE' : 'INSTALL'}${dryRun ? ' (--dry-run, nothing is written)' : ''}`))
  console.log('')

  const existing = readOrNull(hookFile)
  const next = remove ? withoutBlock(existing) : withBlock(existing)

  if (next === null) {
    console.log(green(remove ? 'The gate block is not in the hook. Nothing to remove.' : 'Nothing to do.'))
    return 0
  }
  if (existing !== null && next === existing) {
    console.log(green('The hook already carries the current gate block. Nothing to change.'))
    return 0
  }

  console.log(
    existing === null
      ? yellow('The hook does not exist yet, so it will be created.')
      : hasBlock(existing)
        ? 'The hook carries an older gate block, which will be replaced in place.'
        : `The hook exists and will be left intact; the gate block is inserted ${insertionDescription(existing)}.`
  )

  if (dryRun) {
    console.log('')
    console.log(dim('--- pre-commit would become ---'))
    console.log(next)
    console.log(dim('--- end ---'))
    console.log('')
    console.log(yellow('--dry-run: nothing was written.'))
    return 0
  }

  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(hookFile, next, { encoding: 'utf8' })
    // Git needs the executable bit on platforms that have one. Windows ignores
    // it, and Git Bash runs the hook either way, so a failure here is not fatal.
    try {
      fs.chmodSync(hookFile, 0o755)
    } catch {
      console.log(yellow(`NOTE: could not set the executable bit on ${hookFile}.`))
    }
  } catch (err) {
    console.error(red(`FATAL: could not write ${hookFile}: ${String(err?.message || err)}`))
    return 1
  }

  /* Verify by reading back rather than trusting the write. */
  const after = readOrNull(hookFile)
  if (after !== next) {
    console.error(red(`FAIL: ${hookFile} did not read back as written.`))
    return 1
  }
  if (remove) {
    console.log(green(`removed the gate block from ${hookFile}`))
    return 0
  }
  if (!hasBlock(after)) {
    console.error(red('FAIL: the gate block is not present after writing it.'))
    return 1
  }

  console.log(green(`installed the gate block into ${hookFile}`))
  console.log('')
  console.log(dim('  Verify it end to end: break a rule on purpose, try to commit, and watch it refuse.'))
  return 0
}

/* -------------------------------------------------------------------------- */

function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function hasBlock(text) {
  return typeof text === 'string' && text.includes(BEGIN)
}

/** The hook text with our block present exactly once, and nothing else disturbed. */
function withBlock(existing) {
  if (existing === null) {
    return `#!/bin/sh\n# ${PRODUCT_NAME} hooks. Installed by scripts/install-hooks.mjs.\n\n${BLOCK}\n\nexit 0\n`
  }
  if (hasBlock(existing)) return replaceBlock(existing, BLOCK)

  const lines = existing.split('\n')
  // Find the LAST bare `exit 0`. Anything appended after it would never run,
  // which is exactly how a gate ends up installed and useless.
  let insertAt = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*exit\s+0\s*$/.test(lines[i])) {
      insertAt = i
      break
    }
  }
  if (insertAt === -1) {
    const tail = existing.endsWith('\n') ? '' : '\n'
    return `${existing}${tail}\n${BLOCK}\n`
  }
  lines.splice(insertAt, 0, '', ...BLOCK.split('\n'), '')
  return lines.join('\n')
}

function withoutBlock(existing) {
  if (!hasBlock(existing)) return null
  return replaceBlock(existing, null)
}

/**
 * Swap whatever sits between the markers, inclusive. Replacing rather than
 * appending is what makes re-running safe: an updated block lands once instead
 * of stacking a second copy that runs the gate twice.
 */
function replaceBlock(text, replacement) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.includes(BEGIN))
  let end = lines.findIndex((l, i) => i >= start && l.includes(END))
  if (end === -1) end = lines.length - 1
  const head = lines.slice(0, start)
  const tail = lines.slice(end + 1)
  if (replacement === null) {
    // Collapse the blank line the insertion added, so removing is a clean undo.
    if (head.at(-1) === '' && tail[0] === '') head.pop()
    return [...head, ...tail].join('\n')
  }
  return [...head, ...replacement.split('\n'), ...tail].join('\n')
}

function insertionDescription(existing) {
  return /^\s*exit\s+0\s*$/m.test(existing)
    ? 'above its trailing `exit 0`, so it actually runs'
    : 'at the end'
}

process.exitCode = main(process.argv.slice(2))
