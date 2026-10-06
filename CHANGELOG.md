# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This repository starts at 1.0.0. The entries below it describe releases made
from an earlier history; those versions have no tags here. Every clone made
before 1.0.0 takes the one-time step in the 1.0.0 Upgrading section, which
replaces the one-time steps in the earlier entries.

## [Unreleased]

## [1.2.1] - 2026-10-06

Gathering tab groups into one window, opt-in. A group lived in the window its
tabs were in; now every group of one title can be brought into one named
window and folded into one group there.

### Added

- **`browser_gather_group`** (WRITE: audited, refused under panic, no arm):
  given a title and a window, every group of exactly that title in the
  profile's other windows moves whole to the end of that window
  (`chrome.tabGroups.move` with its `windowId`), then that window's groups of
  that title fold into its leftmost one (`chrome.tabs.group` with that group's
  id) and the browser deletes the emptied ones. It is the only operation that
  moves anything to another window, and it moves only whole groups. A group
  holding its window's active tab is left, and said so, while that window has
  other tabs; a window left empty closes and is listed in `closedWindows`.
  Nothing is closed, reloaded, navigated, pinned or activated.
- **`browser_list_groups` names the window used last** (`lastFocusedWindowId`,
  the same read the bridge uses to choose where a page opens), marked
  "(used last)" in the listing.
- **`scripts/group-tabs.mjs` plans take `"window"`**: a window id, or
  `"last-focused"`. Every planned title is gathered into that window and folded
  into one group, held groups are tried again after the rest have moved, the
  groups are lined up left to right in plan order with their colors and
  collapsed state, and the read-back exits 1 while a title still stands in more
  than one group or outside that window. Without `"window"` nothing changes,
  and the script's client still refuses the gather.

### Upgrading

1. `git pull`, then `npm ci`.
2. Reload the extension in every profile (`npm run reload`).
3. Restart the broker as in the 1.0.0 Upgrading section. Until both are
   upgraded, the gather is answered with "Unknown operation"; every other
   operation keeps working in every mix of versions.

## [1.2.0] - 2026-10-06

Tab groups: list them, group tabs under a title and a color, collapse or
expand, move a group, ungroup; as five MCP tools and as a script that applies a
whole plan. New operations need the new broker as well as the new extension,
so the Upgrading order matters.

### Added

- **Five tab group operations**, as MCP tools beside `browser_sort_window`:
  `browser_list_groups` (READ) and `browser_group_tabs`, `browser_update_group`,
  `browser_move_group`, `browser_ungroup_tabs` (WRITE: audited, refused under
  panic, no arm). A group is reused by its exact title in its window, else made
  in the tabs' own window; the given tabs stand in the given order after any
  members that were not named.
- **What they refuse to do, by construction**: tabs from two windows (a group
  lives in one window, and nothing here moves a tab to another window), pinned
  tabs (grouping unpins them), collapsing a group that holds its window's active
  tab (the browser would switch tabs; skipped and said so in the result's
  `note`). Nothing closes, reloads, navigates, opens or activates a tab. The
  browser's "Tabs cannot be edited right now" during a drag is tried once more.
- `scripts/group-tabs.mjs <profile label> <plan.json> [--dry-run] [--json]`:
  applies a plan of groups (title, color, collapsed, tab handles in order), in
  each window as it stands, left to right in plan order, collapses last, then
  reads it all back and exits 1 if any tab is not in its group. It can send only
  list groups, group tabs, update a group and move a group; anything else,
  ungrouping included, is refused before it reaches the broker.
- `scripts/read-page.mjs <profile label> <url> [--comments] [--json]`: reads one
  page in a background tab of a profile, prints its text and closes the tab. It
  can send only open, list, read, scroll and close, and only to the tab its own
  open returned; anything else is refused before it reaches the broker. Exit 1
  when the page did not land, 3 when it was read but its tab could not be
  closed.

### Fixed

- **The broker drops raw tab ids a caller sends.** `tabId` and `tabIds` are
  written by the broker from handles it has checked against the profile and
  the browser generation; a caller who sent them directly skipped that check.
  They are now removed before anything else in the request is read, so only
  validated ids reach a browser. No caller in this repository sent them.

### Upgrading

1. `git pull`, then `npm ci`.
2. Reload the extension in every profile (`npm run reload`).
3. Restart the broker as in the 1.0.0 Upgrading section. A 1.1.x broker
   answers the new operations with "Unknown operation" until it is restarted,
   and a 1.1.x extension answers them the same way until it is reloaded; every
   older operation keeps working in every mix of versions.

## [1.1.1] - 2026-10-02

A fix for a link that dropped every few seconds for hours while the broker
was healthy. One service worker could end up holding two native ports; the
old port's host outlived its route, and once the broker replaced that route,
the refusals it relayed tore down the profile's live link in a loop. A 1.1.1
broker and host work with 1.1.0 and 1.0.x extensions and the reverse, but the
loop ends only with the 1.1.1 extension, so the Upgrading order matters.

### Fixed

- **One native port per service worker.** A wake source (the keepalive
  alarm, `onStartup`, the worker's cold start, a backoff retry) that landed
  while a REGISTER_ACK was being recorded saw a port with no ack timer and no
  READY, and opened a second port without closing the first. The ack timer
  now runs until the answer is fully recorded, `ensureConnected` decides on
  what it reads after its awaits (and reads again if the link moved), and
  `connect()` closes any port it replaces.
- **A port the worker let go of never acts on the current link.** Every
  listener is bound to its own port. A frame or a disconnect from any other
  port is ignored and that port is closed, so a refusal, a ping or a
  disconnect from an old port can no longer tear down, answer on, or forget
  the current one.
- **A replaced host goes quiet instead of redialing.** The broker now tells
  a host its route was taken by a newer registration (a `replaced` event,
  `HOST_NOTICE.REPLACED`) before it closes the socket. The host sends nothing
  to its browser, never redials, and ends when the browser closes its port.
  It does not exit on its own: an extension before 1.1.1 still holding that
  port would read the exit as its live link dropping and dial again,
  replacing the next route in turn. Before, the host could not tell a
  replacement from a broker restart: it voided a registration the extension
  had already replaced, redialed, never registered, and was refused at the
  broker's 10-second deadline. A broker restart is handled as before: the
  host voids the registration, redials and carries the next REGISTER.
- **A forced reconnect waits for a link already on its way.** The popup and
  the options page force a reconnect when a request fails as an outage. One
  that landed while a connect was collecting its identity closed the port
  being introduced and left nothing scheduled to try again; one that landed
  while an answer was pending dialed the same introduction twice. A page
  polling through an outage also no longer redials on every poll: a retry the
  backoff has already counted is left to run.
- **Every write after an await checks its port first.** A port that went
  away while its REGISTER_ACK was being recorded could write READY over the
  DOWN its own drop wrote, and a panic refusal could leave its hold on the
  next port. A retry is also claimed before its first await, so two failures
  at once arm one timer.
- **"The broker is not answering" only for an outage.** The options page and
  the popup reach the broker through the profile's own link, so a link coming
  back fails a poll or two while the broker is up. Both now say Reconnecting
  for the first 6 seconds of failed polls and keep the last board on screen;
  the broker-down card appears only for a failure that lasts longer.

### Added

- `test/link-stale-port.test.mjs`: the extension's real link module against a
  fake chrome whose storage answers one call per turn, so a wake source can
  land inside any window. Six of its tests failed on 1.1.0, including five of
  thirteen wake timings that opened a second port, and five more cover the
  forced reconnect and the writes after an await.
- `test/replaced-host-e2e.test.mjs`: the real broker and hosts; a replaced
  host relays nothing, never redials and ends with its port, and a host whose
  broker restarts still recovers.
- `extension/lib/outage.js` and `test/outage-grace.test.mjs`.

### Changed

- The version is 1.1.1 in `package.json`, `package-lock.json` and
  `extension/manifest.json`.

### Upgrading

1. `git pull`, then `npm ci`.
2. Reload the extension in every profile first (`npm run reload`, or the
   Reload arrow on the browser's extensions page). A reload closes every port
   the old worker held, so every host started before the pull exits with it,
   and the profile's new host starts from the pulled folder. This is what
   ends the loop.
3. Then restart the broker as in the 1.0.0 Upgrading section, so doctor's
   `runtime` line reads `version 1.1.1`. The other order is safe too, but a
   profile stays in the loop until it is reloaded either way.

## [1.1.0] - 2026-10-01

Three features: sort a window's tabs by age, resume from panic in the
extension popup, and a guard on password and one-time-code fields. A 1.1.0
broker talks to 1.0.x clients and the reverse, with one exception: an
extension older than 1.1.0 cannot resume from panic, and a broker older than
1.1.0 still refuses the extension's link during panic.

### Added

- **Sort by age, per window.** The popup's "Sort this window by age" and
  "Sort every window by age" put the oldest tab on the left and the newest on
  the right. Pinned tabs stay where they are; a tab group moves as one block,
  placed by its oldest tab, with its own order kept; each window is sorted on
  its own and no tab changes window. Agents get the same through
  `browser_sort_window` (one window, or `all`), a write-tier tool that is
  audited and refused while panic is on, with an optional map of tab handle to
  the time that tab was really opened.
- **An open-time ledger.** The extension records when each tab is created and
  keeps it across browser restarts: on the first run of a new browser session
  it re-keys the ledger onto the tabs that came back, matching windows and
  then tabs by position and address, and dropping anything ambiguous rather
  than guessing. A tab with no recorded time (every tab opened before 1.1.0)
  is aged by when it was last shown, which the popup says, so an old tab
  revisited recently sorts as newer than it is.
- **Resume from the popup.** While panic is on, the popup shows it and offers
  "Hold to resume", a press-and-hold that asks the broker to remove the panic
  file. The footer's panic hold resumes too while panic is on.
- **The password-field guard.** A fill or key press into a password or
  one-time-code field is refused with the new `E_SECRET_FIELD` unless the
  agent session carries a receipt pointing at a recorded yes for that site.
  See SECURITY.md, "Password and one-time-code fields".
- `browser_list_tabs` rows carry `lastAccessed` and `groupId`.
- `shared/account-word.mjs`: the receipt reader, configured by
  `account-word.json` in the state directory.

### Security

- **Only the popup can resume, and only for a profile the broker is holding.**
  `resume` is a host-only operation: an MCP connection that sends it is
  dropped as a capability violation, there is no MCP tool for it, and
  `bridge_panic` still cannot turn panic off. The extension's worker accepts
  the request only from its own popup page, never from the Board or a content
  script, and the broker accepts it only on a connection that registered as an
  extension during the panic.
- **During panic the broker now accepts the extension's link and holds it.**
  It used to refuse the host's HELLO, which left the popup saying the broker
  was not answering. The extension's registration is answered with `E_PANIC`
  and held with no route, so nothing on it can reach a browser; it can read
  the board and ask to resume. Removing the panic file, from the popup or by
  hand, releases every held link and each profile registers again.
- **A password needs the recorded yes.** The broker reads the receipt (a drop
  file in one configured folder, carrying an `ACCOUNT WORD: <service>` line),
  strips any grant a caller tried to send itself, and the extension refuses a
  secret field the grant does not cover. The audit line records the receipt's
  file name, never its path or contents.
- **Hardened in review before release.** The check follows focus where trusted
  keys land: after a selector is focused and before every later key, waiting
  through a navigation rather than typing into an unseen page. It reads closed
  shadow roots and nesting to any practical depth, and reads another site's
  frame by asking that frame, judged by that frame's own site; a frame it
  cannot read is refused even with a recorded yes. The site is the probed
  page's, not the tab address read before it. After an Enter the check waits
  for the navigation; once keys have gone into a password field the rest stay
  on that site; a sequence stops at its deadline; and a refusal never quotes
  the browser's error. A bare name in the recorded yes matches only the
  brand's `.com` and its subdomains (any other site is written as its domain),
  a registry suffix matches nothing, and an address matches only itself.
  Untrusted key events are checked where they are sent. A registration that was waiting when panic tripped is held instead of
  routed, and the extension's held flag never outlives its connection. A tab
  restored by the browser is no longer stamped as newly opened, and the
  ledger's re-key no longer delays the profile's registration.

### Changed

- The version is 1.1.0 in `package.json`, `package-lock.json` and
  `extension/manifest.json`.
- The extension requests the `tabGroups` permission, to move a tab group as
  one block. It shows no install warning.
- `bridge_panic`'s description, the refusal of `panic` with `on: false`, and
  doctor's panic line name the popup's Resume as the way out.

### Upgrading

1. `git pull`, then `npm ci`.
2. Restart the broker as in the 1.0.0 Upgrading section, so doctor's
   `runtime` line reads `version 1.1.0`.
3. Reload the extension in every profile (`npm run reload`, or the Reload
   arrow on the browser's extensions page). The new permission is granted on
   reload with no prompt for an unpacked extension.
4. Optional, for agents that may type passwords with a recorded yes: write
   `account-word.json` in the state directory with the drop folder, and launch
   those sessions with `BRIDGE_ACCOUNT_WORD` (or the variable
   `BRIDGE_ACCOUNT_WORD_ENV` names) set to the receipt's path.

## [1.0.1] - 2026-09-27

Three fixes to what the clients do around the broker's proof, found by two
adversarial reviews of the handshake and by the end-to-end test this release
adds. The wire format is unchanged and the broker's behavior is unchanged: a
1.0.1 client talks to a 1.0.0 broker, and the reverse.

### Security

- **A `runtime.json` without the `auth` field no longer talks a client down
  to sending the token.** Since 0.5.0 the host, the MCP server and doctor fell
  back to the old token HELLO when the file named no scheme, the mark of a
  broker from before 0.5.0. But a broker that finds its pipe name taken exits
  without rewriting the file, so a file left behind by an old broker (or
  restored from a backup) let whoever held the name be handed the token and
  trusted without a proof, which is the attack 0.5.0 closed. A client now
  sends nothing when the file names no scheme it speaks, and says to restart
  the broker. The broker still accepts the token HELLO, so a host or MCP
  server process started before an upgrade keeps working until it restarts.
- **The host no longer hands buffered frames to an unproven endpoint when the
  browser closes.** Frames the extension sends while the host is still waiting
  for the broker's answer are held until the proof arrives. If the browser
  closed the connection in that window, the host's shutdown wrote the held
  frames to the pipe anyway, proof or not. It now drops them unless the link
  was proven.
- **A refused HELLO is reported in the client's own words, and nothing an
  unproven endpoint sends is logged.** A refusal arrives before any proof,
  but the MCP server passed its code and message to the agent as tool output,
  and doctor printed them on the terminal, so whoever held the pipe name could
  put text of its choosing in front of the model or the user. Clients now keep
  only a code the broker refuses HELLO with (`E_UNAUTHORIZED`,
  `E_BAD_REQUEST`, `E_PANIC`; anything else reads as `E_UNAUTHORIZED`) and
  describe it themselves. In the same way the host no longer writes the type
  of a frame sent ahead of the answer to its stderr, which the browser logs,
  and the MCP client now reads nothing before the answer but the answer: a
  frame ahead of it fails the connection, frames behind an unproven one are
  dropped, and neither reaches its log.

### Added

- `BRIDGE_SOCKET_NAME`: a socket name that replaces `socketName` from
  `bridge.config.json` for one process, held to the same rule. It exists for
  tests: Windows pipe names are global, so `BRIDGE_HOME` alone cannot keep a
  test's broker off the pipe of a broker already running.
- `test/handshake-e2e.test.mjs`: the real broker, host and MCP client on a
  throwaway endpoint, against impostors that answer without a proof, reflect
  the client's proof, send frames ahead of and behind their answer in the same
  chunk, withhold the answer, refuse with planted text, or plant text in a
  frame type or an event name; and the real broker refusing a replayed HELLO
  and a bad proof.
- A GitHub Actions workflow that runs `npm ci`, `npm test` and `npm run gate`
  on every pull request, on Ubuntu and Windows, with read-only permissions and
  no secrets.

### Changed

- The version is 1.0.1 in `package.json`, `package-lock.json` and
  `extension/manifest.json`.
- Doctor's warning for a `runtime.json` with no or an unknown `auth` field
  now says clients refuse to dial until the broker restarts.

### Fixed

- The launcher bootstrap's test built a Windows path and expected a Windows
  file URL, which only Windows produces, so it failed on Linux; it now checks
  a POSIX path there. The launcher itself is unchanged.

### Upgrading

1. `git pull` (a fast-forward from 1.0.0), then `npm ci`.
2. Restart the broker as in the 1.0.0 Upgrading section, so doctor's
   `runtime` line reads `version 1.0.1`. A broker from before 0.5.0 has to be
   restarted before any 1.0.1 client will talk to it.
3. `npm run reload`, so every profile's extension reports 1.0.1 and starts a
   host with the fix. MCP servers pick up theirs when their sessions restart.

## [1.0.0] - 2026-09-27

The first release of this repository: the code of 0.5.1, with its test data
moved to reserved domains (the consumer-mail tests name only the providers
the label rule lists). Nothing the bridge does has changed.

### Added

- `consumerMailDomains()` in `shared/paths.mjs`: a read-only copy of the
  mail providers the label rule treats as consumer mail, which the tests check
  their fixtures against.

### Changed

- The version is 1.0.0 in `package.json`, `package-lock.json` and
  `extension/manifest.json`, so doctor, `bridge_status` and every profile
  report 1.0.0 once the broker is restarted and the extension reloaded.
- Test fixtures that name a mailbox or a company domain now use the names
  RFC 2606 reserves for documentation (`acme-corp.example`, `ada.example`,
  `mailbox.example`), which cannot belong to anybody. Fixtures for a consumer
  mailbox name only the provider and build the address at run time, so no
  deliverable address sits in the repository. One
  expected label changed with its fixture: `brave-ada-dev` is now
  `brave-ada-example`.

### Upgrading

1. **A clone made before 1.0.0, once.** It shares no commits with this
   repository's `main`, so `git pull` refuses with "refusing to merge unrelated
   histories". In the same folder:

   ```bash
   git fetch origin
   git reset --hard origin/main
   ```

   Do not clone into a new folder instead: the browser derives an unpacked
   extension's ID from its folder path, so a new folder is a new extension to
   every profile. The reset discards uncommitted changes and local commits in
   the folder, so copy out anything of your own first. If you pinned the ID
   with `node scripts/keygen.mjs`, run it again after the reset; if you changed
   `bridge.config.json`, put it back and run `npm run sync-config`.
2. `npm ci`
3. Restart the broker as in the 0.5.0 Upgrading section (on Windows,
   `schtasks /End /TN "Agent Browser Bridge broker"` and then a minute or two
   for the watchdog). `node scripts/doctor.mjs` shows `version 1.0.0` on its
   `runtime` line once it has.
4. `npm run reload`, so every profile's extension reports 1.0.0. A profile on
   0.3.0 or earlier needs the Reload arrow on the browser's extensions page
   once instead.
5. If you commit to the repository, `npm run hooks:install`.

## [0.5.1] - 2026-09-26

### Added

- `node scripts/doctor.mjs` now warns when the running broker is on a
  different version from its install folder. The broker reads its code once,
  when it starts, so after a `git pull` it keeps running the old code until it
  is restarted. `bridge_status` and `browser_list_profiles` already told an
  agent; doctor showed it only as the version on its `runtime` line. Doctor now
  compares that version with the `package.json` of the folder the broker
  service starts it from (normally the folder you run doctor in; when the
  service points at another checkout, doctor says so and compares with that
  one), and when the broker is older, or newer after the folder was moved back
  to an earlier release, it prints a warning with the restart step for your
  platform. Versions compare by semver precedence, pre-releases included.
- Doctor also warns when `runtime.json` has no `auth` field, or one this
  install does not speak: clients then fall back to the old handshake and send
  the broker the token instead of proving they hold it. A broker from before
  0.5.0 is the usual case.

### Fixed

- Doctor's restart advice for a broker that is already running no longer says
  `schtasks /Run`, which does nothing while the task runs and, straight after
  `/End`, starts a broker that exits because the old one still holds the pipe.
  It now gives the `/End`-then-wait step. For a broker running outside the
  task, which `/End` cannot reach, it gives `taskkill /PID <pid> /F` with the
  pid from `runtime.json`, after which the task's watchdog starts a supervised
  one.

### Upgrading

A clone made before 2026-09-26 takes the one-time step at the top of the 0.5.0
Upgrading section first. Then, in your install folder:

1. `git pull`
2. `npm ci`
3. Restart the broker, exactly as in 0.5.0 step 3. On Windows that is
   `schtasks /End /TN "Agent Browser Bridge broker"` and then a minute or two
   for the task's watchdog to start the new one, never `schtasks /Run` straight
   away. `node scripts/doctor.mjs` shows `version 0.5.1` on its `runtime` line
   once it has.
4. `npm run reload`, so every profile's extension reports 0.5.1.

## [0.5.0] - 2026-09-26

This release closes three security gaps found in an audit of the broker, the
host and the extension. Every install should upgrade, and it is also the first
release from the consolidated history, so a clone from before 2026-09-26 needs
the one-time step at the top of Upgrading.

### Security

- **Clients now make the broker prove it holds the token, and no longer send
  it.** On Windows the broker's endpoint is a named pipe, and pipe names are
  shared by every account on the machine. If another account created the pipe
  name while the broker was down, the real broker exited at its next start
  believing one was already running, and every host, MCP server and doctor run
  then handed that process the token and trusted its answers, so the host
  relayed its requests to the extension. A single-user machine had nobody to do
  this; a shared one was exposed. Each client now sends a fresh nonce and an
  HMAC-SHA256 proof of the token instead of the token, the broker answers with a
  proof of its own, and a client relays and sends nothing until that proof
  checks out. The broker refuses a nonce it has already accepted this boot (it
  remembers the most recent 4,096). `runtime.json` gains
  `"auth": "hmac-sha256-v1"`, which is how a client knows the broker expects the
  new handshake. What remains on a shared machine is a denial of service: a
  squatted name still stops the broker from starting, and
  `node scripts/doctor.mjs` reports it.
- **The extension's service worker answers its Board messages only from the
  extension's own pages.** The worker's message API (claim, rename, arm,
  disarm, panic, and the profile's own record) answered any sender carrying the
  extension's id. That includes the extension's content scripts, and a content
  script shares a renderer process with the page it is injected into. Code
  that had compromised the renderer of a page the bridge had touched (a browser
  exploit, not an ordinary page script) could therefore arm `browser_eval_js`
  on that profile for an hour, or read the profile's record, including the
  email address it was claimed for. The worker now checks that the sender's
  URL and origin belong to this extension's own pages and answers anything else
  with `E_UNAUTHORIZED`.
- **`javascript:` URLs are refused by the broker and the extension.**
  Navigating is a write-tier operation that needs no arm, and a `javascript:`
  URL is arbitrary script in the page. Chromium already refuses these in
  extension API navigations, so nothing was reachable on a current browser; the
  refusal no longer depends on that. It is checked on the scheme, so every
  spelling is refused.

### Fixed

- The commit-message guard that `npm run hooks:install` installs no longer
  refuses an ordinary sentence such as "regenerated with [a script]": the check
  now starts at a word boundary. A "Generated with [...]" line, or one that
  names a known AI coding tool, is still refused, and so is every
  `Co-Authored-By:` trailer. On an existing hook
  that did not end in `exit 0`, the installer used to append the pre-commit
  gate block where the commit-message guard belonged; it now appends the right
  block.

### Changed

- The extension no longer requests the `activeTab` permission. Nothing called
  an API that needed it: the `<all_urls>` host permission already covers every
  page the bridge reads or drives. Removing a permission prompts nothing.
- Dependencies: `@modelcontextprotocol/server` 2.0.0 to 2.1.0 and `zod` 4.5.2
  to 4.6.5. The MCP server's tool list and every tool's input schema are
  unchanged.
- `package.json` pins `packageManager` to `npm@10.9.8`, the npm that ships with
  Node 22, and `package-lock.json` now carries the release's own version (it
  still said 0.3.0).

### Documentation

- The README and `docs/DESIGN.md` now say plainly that the agent can arm a
  profile itself through `bridge_arm`, that the broker cannot tell that from a
  Board click, and that the human step in front of an agent's arm is therefore
  the agent client's tool-approval prompt. Keep `bridge_arm` off every
  auto-approve list.
- The README's Updating section now installs dependencies after a pull and
  covers a clone from before the consolidated history.

### Upgrading

Every step runs in your existing install folder, the one your browsers load
the extension from.

1. **Only for a clone made before 2026-09-26, once.** An older clone shares no
   commits with the new `main`, so `git pull` refuses with "refusing to merge
   unrelated histories". Move the folder onto the new history in place:

   ```bash
   git fetch origin
   git reset --hard origin/main
   ```

   Do not clone into a new folder instead. Unless you pinned it with
   `node scripts/keygen.mjs`, the browser derives an unpacked extension's ID
   from its folder path, so a new folder is a different extension to every
   profile and would have to be loaded, registered and claimed again.
   `git reset --hard` discards uncommitted changes and local commits in the
   folder, so copy out anything of your own first. Two cases need a step right
   after the reset:

   - If you pinned the ID with `node scripts/keygen.mjs`, the reset removes the
     `key` it wrote into `extension/manifest.json`. Run
     `node scripts/keygen.mjs` again: it writes the same key back from the copy
     it saved in the state directory, so the ID does not change.
   - If you changed `bridge.config.json` (for example with `npm run rename`),
     save it before the reset, put it back afterwards and run
     `npm run sync-config`.

   A clone made on or after 2026-09-26 updates with `git pull` as usual.
2. Install the updated dependencies: `npm ci`.
3. Restart the broker, so it runs the new handshake.
   - Windows: `schtasks /End /TN "Agent Browser Bridge broker"`, then let the
     task's one-minute watchdog start the new broker, which takes a minute or
     two. Do not run `schtasks /Run` straight away: the old broker holds the
     pipe for up to about 30 seconds after `/End`, and a broker started in that
     window finds the name taken and exits.
   - macOS:
     `launchctl kickstart -k gui/$(id -u)/com.agent_browser_bridge.host.broker`.
   - Linux: `systemctl --user restart agent-browser-bridge-broker`.
   - If you renamed the product, the Windows task name is `serviceName` in
     your `bridge.config.json`, the launchd label is `<nativeHostId>.broker`
     and the systemd unit is `<stateDirName>-broker`.

   The broker is on the new version when `node scripts/doctor.mjs` shows its
   `runtime` line with `version 0.5.0`. An older version there means the
   broker was not restarted, and clients are still using the old handshake.
4. Reload the extension in every profile: `npm run reload` (the same as
   `node scripts/reload-extension.mjs --all`). It reloads each connected
   profile that is still on an older version and waits for each one to come
   back on 0.5.0. A profile on 0.3.0 or earlier needs the Reload arrow on the
   browser's extensions page once instead.
5. If you commit to the repository, reinstall the hooks: `npm run hooks:install`.
6. Check the result with `node scripts/doctor.mjs`: every profile connected,
   and the `runtime` line at `version 0.5.0`.

Old and new pieces keep working together while you upgrade. A 0.5.0 broker
still accepts the old handshake from a host or MCP server that has not
restarted yet, and a 0.5.0 client uses the old handshake while the broker has
not been restarted. The token stops crossing the pipe once both ends run 0.5.0.
An agent session that was open before the upgrade keeps its old MCP server
until the session is restarted.

## [0.4.1] - 2026-09-18

### Fixed

- `scripts/reload-extension.mjs` now names the right next action for the one
  failure it is most likely to meet. An extension older than 0.4.0 does not know
  the reload operation, and the generic explanation for that error talks about
  chrome.debugger policy and its tier 1 alternatives, which have nothing to do
  with it. Anybody upgrading from 0.3.0 or earlier saw that paragraph once per
  profile, when the answer was the single click this command exists to replace.
  It now says which version the profile is running, why this one reload cannot
  be automated, and where the button is.

## [0.4.0] - 2026-09-18

### Added

- Every profile now reports which extension version it is RUNNING, and
  `browser_list_profiles`, `bridge_status`, the extension's board and its popup
  all show it and flag any profile that is behind the version in the install
  folder. This closes a gap that had already cost a release: a browser reads an
  unpacked extension's code once, when it loads it, so a merged and deployed
  change can be absent from every browser on the machine with nothing on any
  screen saying so. The broker re-reads the folder's manifest rather than
  reporting its own version, because the folder changes under a broker that has
  been running since login.
- `browser_reload_extension`, and `scripts/reload-extension.mjs --all` for
  callers with no MCP client: ask one profile's extension to reload itself, which
  is what the Reload arrow on the extensions page does. It is refused unless the
  install folder holds a different version from the one that profile is running,
  because a reload invalidates every open tab handle in every session driving
  that browser and clears the ledger `browser_open_or_focus` uses to know which
  tabs it opened. The command waits for each profile to come back on the new
  version before reporting success, because the acknowledgement necessarily
  leaves before the reload happens and therefore proves only that the extension
  was asked. The release that adds this cannot use it, so upgrading from 0.3.0
  costs one click per profile and no release after it does.
- A README "Updating" section, which the project did not have: pull, then reload
  the extension in each profile, and why the second half is not optional.

### Fixed

- **A refused URL scheme is now refused however it is spelled.** The restricted
  list was checked as text prefixes, which made it a rule about slashes. `file:`
  is a special scheme in the URL Standard, so `file:/C:/Users/me/.env` and
  `file:\\server\share\x` both canonicalize to ordinary `file://` URLs while
  starting with neither `file://` nor anything else on the list. Verified against
  a real browser before the fix: `browser_navigate`, a WRITE-tier operation that
  needs no arm, accepted the one-slash form, Chromium canonicalized it, and the
  tab rendered the local file. That is the unarmed local-file primitive the
  refusal exists to prevent, reachable by deleting two characters. The check is
  now on the scheme as well as the prefix, with a test named after it.

### Changed

- `browser_open_or_focus` may FIND a tab already showing any `file:` address and
  MOVE it to the far right, while still OPENING and RELOADING only `.html` and
  `.htm`. A PDF therefore gets the same one-page-one-tab behavior as an HTML
  report: the launcher opens it the first time, because the bridge refuses to,
  and every call after that moves the tab that already exists. This is not a
  widening of the file rule. Finding and moving performs no navigation and no
  read, so it cannot be half of the navigate-then-read composition the refusal
  exists to prevent, and READ-tier `browser_list_tabs` already reports every
  tab's address. In this mode the reload is not attempted at all rather than
  attempted and reported as failed, no tab is ever closed, and the one-line
  answer names the rule so a launcher knows to open the file itself.

## [0.3.0] - 2026-09-18

### Added

- `browser_open_or_focus`, and `scripts/open-or-focus.mjs` for callers with no
  MCP client: show a page to the human at the machine without giving them a
  sixth copy of it. A tab already showing the address is reloaded and moved to
  the far right of the window it is already in; with no such tab, one opens at
  the far right of that profile's most recently focused window. Matching is
  exact, then ignoring the query and the fragment, and optionally by file name
  across folders (off by default, because two worktrees hold the same file name
  and routinely different versions of the page). The answer is one line: reused,
  moved from which index to which, reloaded, or opened new.
- A ledger of the tabs this operation opened, in `chrome.storage.session`, so
  duplicates it created can be closed and tabs the operator opened never are.
  Session storage on purpose: the keys are raw tab ids, and a ledger that
  outlived them would authorize closing somebody else's tab.
- `BrokerClient` takes a `socketPath`, and the command line takes `--socket`, so
  a caller can prove its broker-unreachable fallback against a dead endpoint
  instead of stopping the broker other sessions are using.

### Changed

- `file:` URLs stay refused everywhere except `browser_open_or_focus`, and
  there only for a path ending in `.html` or `.htm`. The reasoning, and why it
  does not restore the navigate-then-read primitive the refusal exists to
  prevent, is in SECURITY.md and on `isOpenOrFocusUrl` in the contract. The rule
  is enforced in the extension and again in the broker. It refuses the four ways a
  string ends in .html without being a local page: a host or a leading double
  slash (a UNC network path), a control character (a NUL truncates the name at
  the filesystem), and a colon past the drive letter (an NTFS alternate data
  stream).

## [0.2.0] - 2026-09-16

### Added

- `scripts/claim.mjs`: claim a Brave profile from the command line, without
  the options-page click. Lists every line and the candidate directories of
  the unclaimed ones; claims only on an exact, unique match of the profile
  name or email; moves an already-claimed line only with `--reclaim`.
- `scripts/label.mjs`: rename a connected line to a custom label from the
  command line. A custom label survives a derived-label collision; a derived
  one gets a directory suffix, so pinning the name a line already derived is
  a real change.

### Changed

- README: the clone is a standalone install folder. Moving, renaming or
  removing it after a profile has loaded the extension changes the extension
  ID and drops every profile off the bridge.
- The custom-label rule is one shared constant, `LABEL_PATTERN` in
  `shared/protocol.mjs`, used by the broker and the scripts. `BrokerClient`
  takes a `keepAlive` option for command-line callers, so a one-shot script
  waits for the broker's answer instead of exiting first.

## [0.1.0] - 2026-09-14

First public release. A white-labeled release of a bridge that has been in
daily use on a Windows machine with several Chrome and Brave profiles since
2026-08-29.

### Added

- An MV3 extension, loaded unpacked into any number of Chrome or Brave
  profiles, that holds one native-messaging port per profile.
- A per-profile native messaging host that relays framed bytes to the broker.
- One always-on broker that owns the route table, the profile identity join,
  policy, arming and the audit log. Supervised by Task Scheduler on Windows,
  launchd on macOS and systemd on Linux.
- A stdio MCP server, one per agent session, with 17 tools across a read tier,
  a write tier, an armed tier and control: `browser_list_profiles`,
  `browser_list_tabs`, `browser_read_page`, `browser_screenshot`,
  `browser_scroll`, `browser_navigate`, `browser_open_tab`,
  `browser_close_tab`, `browser_activate_tab`, `browser_click`,
  `browser_fill`, `browser_press_keys`, `browser_wait_for`,
  `browser_eval_js`, `bridge_arm`, `bridge_panic`, `bridge_status`.
- Opaque, profile-stamped tab handles, so a handle from one profile is refused
  by another and a handle from before a browser restart fails loudly.
- Identity drift detection: a claimed profile whose signed-in account changes
  is unclaimed rather than driven as the wrong person.
- The Board (options page) and the popup: claiming, renaming, arming with a
  countdown, an origin-only activity log and a press-and-hold panic switch.
- Installers for the host, the broker and the MCP entry (Claude Code, Cursor,
  Codex), a doctor that names every silent failure, and a gate that enforces
  the security rules on every commit.
- `bridge.config.json` as the single source of the product's identity, with
  `npm run rename` to rebrand the whole thing in one command.

### Platform notes

- Windows is the reference platform and the one the end-to-end harness has run
  on.
- macOS and Linux support follows Chromium's documented native messaging
  locations and has not yet been exercised on a real machine. Reports welcome.

[1.0.0]: https://github.com/RobBrautigam/agent-browser-bridge/releases/tag/v1.0.0
