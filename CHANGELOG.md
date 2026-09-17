# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/RobBrautigam/agent-browser-bridge/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/RobBrautigam/agent-browser-bridge/releases/tag/v0.1.0
