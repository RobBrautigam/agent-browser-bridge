# Progress log

Reverse-chronological notes on what changed and why, one entry per session.
The user-facing record is [CHANGELOG.md](../CHANGELOG.md); this file holds the
working notes behind it. This repository is public: entries carry no account
names, machine names or private paths.

## 2026-09-16

- Added `scripts/claim.mjs` (claim a Brave line from the command line on an
  exact, unique name match) and `scripts/label.mjs` (pin a custom label so a
  derived-label collision cannot suffix it), each with a fixture test.
- README: the clone is a standalone install folder; moving it changes the
  extension ID and drops every profile off the bridge.
- Registered the repository with the maintainer's project tracker
  (`.claude/robos.yml`).
