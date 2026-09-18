# Progress log

Reverse-chronological notes on what changed and why, one entry per session.
The user-facing record is [CHANGELOG.md](../CHANGELOG.md); this file holds the
working notes behind it. This repository is public: entries carry no account
names, machine names or private paths.

## 2026-09-18

- Added the `openOrFocus` operation: the MCP tool `browser_open_or_focus` and
  `scripts/open-or-focus.mjs` for callers with no MCP client. It reuses the tab
  already showing a page, reloads it, moves it to the far right of its own
  window, and opens a new tab at the far right only when there is none.
- The decision itself (which tabs match, which one survives, which duplicates
  may be closed) is a pure function in the contract, mirrored into the
  extension, so the rules that matter are tested without driving a browser. The
  handler is tested too, against a fake chrome that records every call, because
  "never closes a tab the operator opened" is a claim about what the code DID.
- One carve-out from the `file:` refusal, for a path ending in .html or .htm,
  enforced in the extension and again in the broker. SECURITY.md carries the
  reasoning and the two limits that back it up. The adversarial review of this
  change found four ways a string ends in .html while naming something else - a
  UNC host, a leading double slash, a NUL that truncates the name, and an NTFS
  alternate data stream - and each is now refused with a test named after it.
- The same review found two ordering defects, both fixed: the survivor is
  confirmed alive BEFORE any duplicate is closed, so a race cannot leave fewer
  tabs and no page, and each duplicate is re-read immediately before it is
  removed, so a tab the operation opened but the operator has since navigated
  elsewhere is left alone. A reload that fails is now reported in the one-line
  answer rather than thrown, because by then the tab is already in place.
- `BrokerClient` gained a `socketPath` option so the broker-unreachable path can
  be proved against a dead endpoint rather than by stopping a broker other
  sessions are using.
- Version 0.3.0. Picking the new code up on a machine that already runs the
  bridge needs the broker restarted and the extension reloaded once per profile
  from the browser's extensions page; until then the operation answers
  E_UNSUPPORTED and a caller falls back to its own opener.

## 2026-09-16

- Added `scripts/claim.mjs` (claim a Brave line from the command line on an
  exact, unique name match) and `scripts/label.mjs` (pin a custom label so a
  derived-label collision cannot suffix it), each with a fixture test.
- README: the clone is a standalone install folder; moving it changes the
  extension ID and drops every profile off the bridge.
- Registered the repository with the maintainer's project tracker
  (`.claude/robos.yml`).
