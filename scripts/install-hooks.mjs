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
import { isMain } from './claim.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const BEGIN = `# === ${PRODUCT_NAME} gate (managed by scripts/install-hooks.mjs) ===`
export const END = `# === end ${PRODUCT_NAME} gate ===`

export const MSG_BEGIN = '# === no AI attribution in commit messages (managed by scripts/install-hooks.mjs) ==='
export const MSG_END = '# === end no AI attribution in commit messages ==='

/**
 * The block itself.
 *
 * It runs the gate against the WORKING TREE, not the index. A staged-only check
 * would need a temp checkout, and the failure it would catch (a violation
 * staged but since edited away) is rarer than the confusion that machinery
 * causes. The gate is also run in CI and by hand, so this is a fast guard, not
 * the only one.
 */
export const BLOCK = `${BEGIN}
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

/**
 * The commit-msg block: no AI attribution in a commit message, ever.
 *
 * Rob Brautigam, 2026-09-19. Claude, or any other agentic coding AI agent, is
 * a tool the author used; it is not a contributor. A trailer saying otherwise
 * follows the code into every clone, every mirror and every blame view, and
 * taking it back out later means rewriting published history, which is what
 * this repo had to do on 2026-09-19.
 *
 * The Co-Authored-By refusal is blanket rather than AI-only on purpose: a rule
 * that names the tools it knows about is a rule the next tool walks straight
 * through.
 *
 * It reads only what the author wrote. `git commit --verbose` puts the whole
 * staged diff below a scissors line, and that diff can legitimately quote the
 * very trailer this refuses - this file does. Cutting at the scissors before
 * looking is what stops the hook blocking a commit over a word in the change.
 *
 * The attribution pattern starts at a WORD START: the start of a line or any
 * character that is not a letter, digit or underscore. Without it the pattern
 * matched inside "regenerated with [the new script]" and refused an honest
 * message, which blocked a real commit on 2026-09-26. The class is spelled in
 * POSIX bracket form rather than `\b` because the hook runs under whatever grep
 * the platform ships, and BSD grep on macOS does not promise `\b`.
 */
export const MSG_BLOCK = `${MSG_BEGIN}
written=$(
  sed -e '/^#.*-\\{6,\\} *>8 *-\\{6,\\}/,$d' "$1" | git stripspace --strip-comments
)
msg_found=0
attribution='(^|[^[:alnum:]_])generated with[[:space:]]+(\\[|.*(claude|anthropic|copilot|codex|cursor|gemini|chatgpt|gpt-[0-9]))'
if printf '%s\\n' "$written" | grep -qiE '^[[:space:]]*co-authored-by:[[:space:]]*[^[:space:]]'; then
  echo ""
  echo "COMMIT BLOCKED: the message carries a Co-Authored-By trailer."
  printf '%s\\n' "$written" | grep -iE '^[[:space:]]*co-authored-by:' | sed 's/^/    /'
  echo ""
  echo "  This repo carries no co-author trailer. An AI agent is a tool the author"
  echo "  used, not a contributor, and the trailer would follow the code into every"
  echo "  clone and every contributor graph from here on."
  echo "  Take the line out of the commit message and commit again."
  echo ""
  msg_found=1
fi
if printf '%s\\n' "$written" | grep -qiE "$attribution"; then
  echo ""
  echo "COMMIT BLOCKED: the message carries a tool attribution line."
  printf '%s\\n' "$written" | grep -iE "$attribution" | sed 's/^/    /'
  echo ""
  echo "  Say what the change does, not what wrote it."
  echo "  Take the line out of the commit message and commit again."
  echo ""
  msg_found=1
fi
if [ "$msg_found" != "0" ]; then
  exit 1
fi
${MSG_END}`

/**
 * Every hook this script manages. Each one is a name, the markers that make
 * re-running replace its block rather than stack another copy, and the block
 * itself.
 */
export const HOOKS = [
  { name: 'pre-commit', begin: BEGIN, end: END, block: BLOCK, what: `the ${PRODUCT_NAME} gate` },
  { name: 'commit-msg', begin: MSG_BEGIN, end: MSG_END, block: MSG_BLOCK, what: 'the no-AI-attribution guard' },
]

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

  node scripts/install-hooks.mjs             install or refresh every managed hook block
  node scripts/install-hooks.mjs --dry-run   show what would change, write nothing
  node scripts/install-hooks.mjs --remove    take the managed blocks out again
  node scripts/install-hooks.mjs --help

Manages two hooks, appending to each without touching anything already in it:

  pre-commit   the ${PRODUCT_NAME} gate
  commit-msg   the no-AI-attribution guard
`)
}

/**
 * Install, refresh or remove one hook's block.
 *
 * Returns 0 on success and 1 on a failure worth stopping for. Each hook is
 * reported on its own, because "install-hooks said it worked" should mean
 * every hook and not just the first one.
 */
function installOne(hook, dir, { dryRun, remove }) {
  const hookFile = path.join(dir, hook.name)
  console.log(bold(`  ${hook.name}`) + dim(`  ${hook.what}`))
  console.log(dim(`    file   ${hookFile}`))

  const existing = readOrNull(hookFile)
  const next = remove ? withoutBlock(existing, hook) : withBlock(existing, hook)

  if (next === null) {
    console.log(green(remove ? '    the block is not in the hook, nothing to remove' : '    nothing to do'))
    return 0
  }
  if (existing !== null && next === existing) {
    console.log(green('    already carries the current block, nothing to change'))
    return 0
  }

  console.log(
    existing === null
      ? yellow('    the hook does not exist yet, so it will be created')
      : hasBlock(existing, hook)
        ? '    the hook carries an older block, which will be replaced in place'
        : `    the hook exists and will be left intact; the block is inserted ${insertionDescription(existing)}`
  )

  if (dryRun) {
    console.log(dim(`    --- ${hook.name} would become ---`))
    console.log(next)
    console.log(dim('    --- end ---'))
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
      console.log(yellow(`    NOTE: could not set the executable bit on ${hookFile}.`))
    }
  } catch (err) {
    console.error(red(`    FATAL: could not write ${hookFile}: ${String(err?.message || err)}`))
    return 1
  }

  /* Verify by reading back rather than trusting the write. */
  const after = readOrNull(hookFile)
  if (after !== next) {
    console.error(red(`    FAIL: ${hookFile} did not read back as written.`))
    return 1
  }
  if (remove) {
    console.log(green('    removed the block'))
    return 0
  }
  if (!hasBlock(after, hook)) {
    console.error(red('    FAIL: the block is not present after writing it.'))
    return 1
  }
  console.log(green('    installed'))
  return 0
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage()
    return 0
  }
  const dryRun = argv.includes('--dry-run')
  const remove = argv.includes('--remove')

  const dir = hooksDir()

  console.log(bold(`${PRODUCT_NAME} install-hooks`))
  console.log(dim(`  hooks  ${dir}`))
  console.log(dim(`  mode   ${remove ? 'REMOVE' : 'INSTALL'}${dryRun ? ' (--dry-run, nothing is written)' : ''}`))
  console.log('')

  let failed = 0
  for (const hook of HOOKS) {
    failed += installOne(hook, dir, { dryRun, remove })
    console.log('')
  }

  if (failed) {
    console.error(red(`${failed} hook(s) failed.`))
    return 1
  }
  if (dryRun) {
    console.log(yellow('--dry-run: nothing was written.'))
    return 0
  }
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

function hasBlock(text, hook) {
  return typeof text === 'string' && text.includes(hook.begin)
}

/** The hook text with our block present exactly once, and nothing else disturbed. */
export function withBlock(existing, hook) {
  if (existing === null) {
    return `#!/bin/sh\n# ${PRODUCT_NAME} hooks. Installed by scripts/install-hooks.mjs.\n\n${hook.block}\n\nexit 0\n`
  }
  if (hasBlock(existing, hook)) return replaceBlock(existing, hook, hook.block)

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
    // THIS hook's block. This line used to name the pre-commit BLOCK, so a
    // commit-msg hook with no `exit 0` got the gate appended instead of the
    // attribution guard, and the guard was never installed.
    return `${existing}${tail}\n${hook.block}\n`
  }
  lines.splice(insertAt, 0, '', ...hook.block.split('\n'), '')
  return lines.join('\n')
}

function withoutBlock(existing, hook) {
  if (!hasBlock(existing, hook)) return null
  return replaceBlock(existing, hook, null)
}

/**
 * Swap whatever sits between the markers, inclusive. Replacing rather than
 * appending is what makes re-running safe: an updated block lands once instead
 * of stacking a second copy that runs the gate twice.
 */
function replaceBlock(text, hook, replacement) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.includes(hook.begin))
  let end = lines.findIndex((l, i) => i >= start && l.includes(hook.end))
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

// Guarded so test/install-hooks.test.mjs can import the blocks and run them
// against a temporary hook file. An unguarded import would install into the
// real hooks folder, which a worktree shares with its main checkout.
if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
