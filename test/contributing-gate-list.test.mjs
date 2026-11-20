/**
 * CONTRIBUTING.md's gate list names every rule scripts/gate.mjs runs.
 *
 * The bullets under "It fails on:" are what a contributor reads to learn what
 * the gate refuses. They once fell two rules behind the gate (the protocol
 * mirror and the debugger permission were missing) with nothing to say so.
 * This test reads both files as text and fails when a gate rule has no bullet,
 * when a bullet names no rule the gate runs, or when the table below still
 * names a rule the gate no longer has.
 *
 * gate.mjs is read, never imported: importing it runs the whole gate.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const GATE_FILE = new URL('../scripts/gate.mjs', import.meta.url)
const CONTRIBUTING_FILE = new URL('../CONTRIBUTING.md', import.meta.url)

/**
 * Each gate rule id, and words its bullet in CONTRIBUTING.md carries. One
 * bullet may serve two rules (the cookie API and the credential files, inline
 * scripts and inline handlers). A new rule needs a bullet there and a line here.
 */
const BULLET_FOR_RULE = {
  'native-modules': /`\.node` native module/,
  'dependency-allowlist': /dependency outside `zod` and `@modelcontextprotocol\/server`/,
  'chrome-cookies': /`chrome\.cookies`/,
  // Dots for the backticks: the store names quoted in source would trip the
  // gate's credential-stores rule, which cannot tell a regex from a read.
  'credential-stores': /.Login Data. or .Web Data./,
  'tcp-listener': /TCP listener/,
  'protocol-stdout': /`console\.log`-family write in `host\/` or `mcp-server\/`/,
  'raw-color': /literal color outside `extension\/ui\/tokens\.css`/,
  'inline-script': /inline scripts/,
  'inline-handler': /`on\*` handler attributes/,
  'em-dash': /em dash/,
  'config-sync': /`package\.json` drifting from `bridge\.config\.json`/,
  'protocol-mirror': /`extension\/lib\/protocol\.js` drifting from `shared\/protocol\.mjs`/,
  'debugger-permission': /`debugger` missing from the manifest's `permissions`/,
}

/**
 * An `id` key (bare or quoted) that opens a line or follows `{` or `,`, so a
 * rule declared over several lines and one written on a single line both
 * count. Every `id` key in gate.mjs is a rule's.
 */
const ID_KEY = /(?:^[ \t]*|[{,][ \t]*)['"]?id['"]?[ \t]*:\s*(['"`])([^'"`\n]+)\1/gm
/** The same key with a value that is not a string literal, which text cannot read. */
const ID_KEY_NOT_LITERAL = /(?:^[ \t]*|[{,][ \t]*)['"]?id['"]?[ \t]*:\s*(?![\s'"`]).*/gm

/**
 * The bullets of the list that follows "It fails on:", each with its
 * continuation lines joined on, or null when there is no such line. Blank
 * lines between bullets are skipped; the list ends at the first other line.
 */
function failsOnBullets(markdown) {
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex((line) => /It fails on:\s*$/.test(line))
  if (start < 0) return null
  const bullets = []
  for (const line of lines.slice(start + 1)) {
    const bullet = line.match(/^[-*+][ \t]+(\S.*)$/)
    if (bullet) bullets.push(bullet[1].trim())
    else if (line.trim() === '') continue
    else if (bullets.length > 0 && /^\s+\S/.test(line)) bullets[bullets.length - 1] += ` ${line.trim()}`
    else break
  }
  return bullets
}

const gateSource = fs.readFileSync(GATE_FILE, 'utf8')
const ids = [...gateSource.matchAll(ID_KEY)].map((m) => m[2])
const bullets = failsOnBullets(fs.readFileSync(CONTRIBUTING_FILE, 'utf8'))

test('the gate declares its rules where this test can read them', () => {
  assert.ok(ids.length > 0, 'no `id` key found in scripts/gate.mjs; this test reads the rule ids from there')
  assert.equal(new Set(ids).size, ids.length, `a rule id appears twice in scripts/gate.mjs: ${ids.join(', ')}`)
  const unreadable = [...gateSource.matchAll(ID_KEY_NOT_LITERAL)].map((m) => m[0].trim())
  assert.deepEqual(
    unreadable,
    [],
    'scripts/gate.mjs has an `id` whose value is not a string literal; this test reads rule ids as text, ' +
      'so write the id as a literal'
  )
})

test('CONTRIBUTING.md has the "It fails on:" list', () => {
  assert.ok(
    bullets && bullets.length > 0,
    'CONTRIBUTING.md has no bullet list (lines opening "- ", "* " or "+ ") after a line ending "It fails on:"'
  )
})

test('every rule the gate runs has a bullet under "It fails on:"', () => {
  const notInTable = ids.filter((id) => !Object.hasOwn(BULLET_FOR_RULE, id))
  assert.deepEqual(
    notInTable,
    [],
    `gate rule(s) ${notInTable.join(', ')} have no line in BULLET_FOR_RULE: add a bullet for each to ` +
      'CONTRIBUTING.md\'s "It fails on:" list, then the words of that bullet to the table in this test'
  )
  const unlisted = ids.filter((id) => Object.hasOwn(BULLET_FOR_RULE, id))
    .filter((id) => !(bullets || []).some((bullet) => BULLET_FOR_RULE[id].test(bullet)))
  assert.deepEqual(
    unlisted,
    [],
    `CONTRIBUTING.md's "It fails on:" list has no bullet for gate rule(s) ${unlisted.join(', ')}`
  )
})

test('every bullet under "It fails on:" names a rule the gate runs', () => {
  const live = ids.filter((id) => Object.hasOwn(BULLET_FOR_RULE, id))
  const orphans = (bullets || []).filter((bullet) => !live.some((id) => BULLET_FOR_RULE[id].test(bullet)))
  assert.deepEqual(orphans, [], 'these bullets match no rule scripts/gate.mjs declares; remove them or name the rule')
})

test('the table names no rule the gate no longer has', () => {
  const stale = Object.keys(BULLET_FOR_RULE).filter((id) => !ids.includes(id))
  assert.deepEqual(stale, [], `BULLET_FOR_RULE names rule(s) ${stale.join(', ')} that scripts/gate.mjs no longer declares`)
})
