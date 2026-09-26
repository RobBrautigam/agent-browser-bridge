/**
 * The commit-msg guard, run for real against a temporary hook file.
 *
 * The block is shell, so the only honest test is to execute it: a JavaScript
 * copy of the pattern would pass while the grep in the hook did something else.
 * Each case writes a commit message to a temp file and runs the hook exactly as
 * git does, `sh <hook> <message file>`, from inside this repository so that
 * `git stripspace` works. Nothing here touches the real hooks folder, which a
 * worktree shares with its main checkout.
 *
 * Two rules are pinned:
 *
 *   - every Co-Authored-By trailer is refused, whoever it names, and every
 *     "Generated with ..." tool attribution line is refused;
 *   - an honest sentence that merely CONTAINS the words, such as "regenerated
 *     with [the new script]", is not. The first shape of the pattern had no
 *     word start, so that sentence was refused and blocked a real commit.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { BLOCK, BEGIN, HOOKS, MSG_BEGIN, MSG_BLOCK, withBlock } from '../scripts/install-hooks.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMMIT_MSG = HOOKS.find((h) => h.name === 'commit-msg')

const HAS_SH = spawnSync('sh', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0

/** Run the commit-msg block against one message; returns the exit status. */
function runHook(message) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abb-hook-'))
  try {
    const hook = path.join(dir, 'commit-msg')
    const msg = path.join(dir, 'COMMIT_EDITMSG')
    fs.writeFileSync(hook, withBlock(null, COMMIT_MSG))
    fs.writeFileSync(msg, message)
    const run = spawnSync('sh', [hook, msg], { cwd: REPO_ROOT, encoding: 'utf8' })
    return run.status
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const REFUSED = [
  ['the Claude Code footer', 'feat: a thing\n\nGenerated with [Claude Code](https://claude.com/claude-code)\n'],
  ['the footer behind its robot emoji', 'feat: a thing\n\n\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)\n'],
  ['the footer in lower case', 'feat: a thing\n\ngenerated with [claude code](https://claude.com/claude-code)\n'],
  ['a bare tool name with no link', 'feat: a thing\n\nGenerated with Claude Code\n'],
  ['another vendor', 'feat: a thing\n\nGenerated with GitHub Copilot\n'],
  ['a bracketed tool inside parentheses', 'feat: a thing\n\n(Generated with [Cursor])\n'],
  ['a hyphenated lead-in', 'feat: a thing\n\nauto-generated with [some tool]\n'],
  ['an AI co-author trailer', 'feat: a thing\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n'],
  ['a human co-author trailer, because the refusal is blanket', 'feat: a thing\n\nCo-authored-by: Jane Doe <jane@example.com>\n'],
  ['an indented trailer', 'feat: a thing\n\n  co-authored-by: Someone <s@example.com>\n'],
]

const ALLOWED = [
  ['"regenerated with [" in an honest sentence', 'docs: the report regenerated with [the new script]\n'],
  ['"regenerated with" naming a tool', 'docs: the page regenerated with codex after the fix\n'],
  ['"degenerated with [" in an honest sentence', 'fix: the list degenerated with [empty rows] before this\n'],
  ['a plain message', 'fix: the reload command names the click, not the debugger\n'],
  [
    'a trailer quoted only below the verbose scissors line',
    'chore: a message\n\n# ------------------------ >8 ------------------------\n' +
      '# Do not modify or remove the line above.\n' +
      '+Co-Authored-By: Claude <noreply@anthropic.com>\n' +
      '+Generated with [Claude Code](https://claude.com/claude-code)\n',
  ],
]

for (const [name, message] of REFUSED) {
  test(`commit-msg refuses ${name}`, { skip: !HAS_SH && 'no sh on PATH' }, () => {
    assert.equal(runHook(message), 1)
  })
}

for (const [name, message] of ALLOWED) {
  test(`commit-msg allows ${name}`, { skip: !HAS_SH && 'no sh on PATH' }, () => {
    assert.equal(runHook(message), 0)
  })
}

test('the commit-msg block is inserted into an existing hook that has no exit 0', () => {
  // A commit-msg hook written by another tool may simply end. Appending to it
  // must add THIS hook's block: the first shape appended the pre-commit gate's
  // block instead, so the attribution guard was silently never installed.
  const existing = '#!/bin/sh\necho "another tool\'s check"\n'
  const next = withBlock(existing, COMMIT_MSG)
  assert.ok(next.startsWith(existing), 'what was there is kept, untouched, at the top')
  assert.ok(next.includes(MSG_BEGIN), 'the commit-msg block is present')
  assert.ok(next.includes(MSG_BLOCK), 'and it is the whole block')
  assert.ok(!next.includes(BEGIN), 'the pre-commit gate block is not')
})

test('the pre-commit block still lands in an existing hook that has no exit 0', () => {
  const pre = HOOKS.find((h) => h.name === 'pre-commit')
  const existing = '#!/bin/sh\necho "identity check"\n'
  const next = withBlock(existing, pre)
  assert.ok(next.includes(BLOCK))
  assert.ok(!next.includes(MSG_BEGIN))
})
