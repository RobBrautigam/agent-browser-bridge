# Progress log

Reverse-chronological notes on what changed and why, one entry per session.
The user-facing record is [CHANGELOG.md](../CHANGELOG.md); this file holds the
working notes behind it. This repository is public: entries carry no account
names, machine names or private paths.

## 2026-10-01

- Version 1.1.0: sort by age per window, resume from the popup, and the
  password-field guard. Every new test was seen to fail before its code, or
  under a mutation of the code it guards when the code came first: the
  planner (group placed by its newest tab, pinned tabs sorted, the age
  sources reordered), the ledger (no restart re-key, an open time
  overwritten, a window closing forgetting its tabs, an ambiguous address
  guessed), the resume path (an MCP connection allowed, a host that never
  registered allowed, the popup check removed in the worker or in the
  sender rule), and the guard (each field rule, a grant with a problem or
  none, substring and suffix host matching, a forged grant kept, the folder
  containment on the lexical and the real path, the audit's file-name
  filter).
- During panic the broker now holds the extension's link instead of refusing
  it; that is what lets the popup see the panic and resume.
- An adversarial review before release found ten issues; nine were fixed with
  a test seen red first (keys following focus into a password field, a
  selector that cannot take focus, closed shadow roots and embeds, a frame
  under the top page's yes, the probed page's address, lookalike subdomains, a
  registration racing panic, a held flag outliving its connection, restored
  tabs stamped as new, the re-key delaying registration), and the tenth (a
  receipt an agent with file access could write) is documented in SECURITY.md.

## 2026-09-27

- Version 1.0.1: an adversarial review of the handshake, run against a local
  commit that removed it, found two client-side gaps, and the new end-to-end
  test found a third. A `runtime.json` with no `auth` field made clients fall
  back to sending the token, which a squatter behind a stale file could use;
  the host's shutdown flushed frames it was holding to an endpoint that had not
  proven itself; and a refused HELLO's text reached the agent and the terminal
  although nothing had proven who sent it. A second review, of the fix, found
  two more of the third kind: the host logged the type of a frame sent ahead of
  the answer, and the MCP client read and logged frames before the proof. All
  five were seen to fail in `test/handshake-e2e.test.mjs` before their fix.
  After them, eleven mutations (each fix undone, the READY gate removed, the
  first-frame check bypassed, the broker proof forced true, the nonce ledger
  ignored, `BRIDGE_SOCKET_NAME` ignored) each turned a test red.
  `BRIDGE_SOCKET_NAME` gives that test its own pipe, and pull requests now run
  the tests and the gate in CI, whose first run found a launcher test that
  could only pass on Windows.
- Version 1.0.0, the first release of this repository: the code of 0.5.1
  with its test data moved to the domains RFC 2606 reserves for examples.
  Consumer-mailbox fixtures name only the provider and build the address at
  run time, and a test checks those providers against the label rule's list
  (`consumerMailDomains()`), so a trimmed list still fails a test. A clone from
  before it moves across with `git fetch origin` and
  `git reset --hard origin/main` in the same folder.

## 2026-09-26

- Version 0.5.1: doctor warns when the running broker is older or newer than
  the folder its service starts it from (runtime.json's version against that
  folder's package.json), and when runtime.json's `auth` is one clients do not
  speak. The folder comes from the supervisor file the installer wrote, read
  back by `parseServiceBrokerEntry` in `scripts/install-broker.mjs`, so a
  second checkout is not mistaken for the install. The checks are pure
  functions doctor exports, and doctor now runs its checks only as a script,
  so the tests import them without ever touching a live broker. Every one of
  the 19 tests was seen to fail by breaking the code it guards, 29 mutations
  in all. Doctor's restart hints for a running broker no longer say
  `schtasks /Run`. A few test fixture names were made neutral in the same
  release.
- Version 0.5.0: the three security fixes from an audit of the broker, the
  host and the extension (the broker now proves the token back and clients
  stop sending it, the worker answers only its own pages, `javascript:` URLs
  are refused), the commit-message guard fix and the arm documentation. The
  CHANGELOG has the detail and the upgrade steps.
- Each fix was checked again before the release by breaking it and watching
  its test fail: the word-start anchor in the commit-message guard, the
  `javascript:` entry in the refusal list, the broker proof in the first-frame
  check, and the url check in the worker's sender guard.
- `@modelcontextprotocol/server` 2.1.0 and `zod` 4.6.5. The MCP server was
  started over stdio before and after the bump, and its 19 tools and their
  input schemas came back identical.
- `packageManager` pinned to the npm that ships with Node 22, the lockfile's
  root version brought up to the release, `activeTab` dropped from the
  manifest, and test fixtures moved to a neutral example path.
- The repository's history was consolidated into a new starting commit. A
  clone from before it moves across with `git fetch origin` and
  `git reset --hard origin/main` in the same folder, never a fresh clone into
  a new folder, because the folder path is the extension's ID.

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
