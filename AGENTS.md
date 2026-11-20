# AGENTS.md

A brief for a coding agent working in this repository. People: start with
[README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md); most of what is
here is said at more length there.

## What this is

A bridge from AI agents to real, signed-in Chrome and Brave profiles: an MV3
extension per profile, a native messaging host process per profile, one always-on
broker, and a stdio MCP server per agent session. Pure ESM, Node 22, no build
step. The reasoning behind the shape is [docs/DESIGN.md](docs/DESIGN.md); the
threat model is [SECURITY.md](SECURITY.md).

## Commands

```bash
npm ci
npm test            # node --test, no framework, no browser needed
npm run gate        # the mechanical rules below
npm run hooks:install
```

`npm run e2e` drives a real browser with a throwaway profile, against a broker
it starts on the installed broker's endpoint and state folder; run it only when
you mean to. On Windows it first disables and ends the installed broker's
scheduled task when that task is running, stopping that broker for the run; a
broker it did not stop (one started by hand, or a stand-down that failed) keeps
the endpoint, and the run then tests that broker instead and leaves its
throwaway route in that broker's state. On macOS and Linux it refuses while any
broker answers on that endpoint. It moves the state folder's `state.json`
aside, and a run that finishes, pass or fail, puts it and the task back as it
found them. `--keep`, an interrupt (Ctrl+C) or a kill restores neither; the
copy stays at `state.json.e2e-backup` until a later run overwrites it.

## Rules the gate enforces (do not add exceptions)

- No `chrome.cookies`, and no read of `Cookies`, `Login Data` or `Web Data`.
- No TCP listener: the broker speaks over a named pipe or a Unix socket.
- No dependency beyond `zod` and `@modelcontextprotocol/server`, and no native module.
- No `console.log` in `host/` or `mcp-server/`: stdout is protocol there.
- No em dash in any text file.
- The product's name lives in `bridge.config.json`; `extension/lib/config.js`,
  the manifest and `package.json` never drift from it (`npm run sync-config`).
- `extension/lib/protocol.js` mirrors `shared/protocol.mjs`.

## Conventions

- Every tool that touches a page takes a required `profile`; never add a default.
- Tabs are addressed by opaque handles the broker mints; a caller's raw tab id
  is dropped (`bridged/routes.mjs`, `callerArgs`).
- A new script that talks to the broker fixes its vocabulary in code and
  refuses any other operation before it is sent (see `scripts/read-page.mjs`,
  `scripts/close-duplicates.mjs`, `scripts/snapshot-tabs.mjs`,
  `scripts/group-tabs.mjs`). The older ones (`claim`, `label`, `doctor`,
  `reload-extension`, `open-or-focus`) call the client directly.
- Tests run against fake broker clients that record what was SENT; a new
  behavior gets a test that fails without it.
- One version across `package.json`, `package-lock.json` and
  `extension/manifest.json`, with a CHANGELOG entry.
- Never type the product's name into a source file (a test fixture aside); read
  it from `shared/config.mjs` (Node side) or the generated
  `extension/lib/config.js` (extension side). `npm run rename` rewrites only
  `bridge.config.json` and what `npm run sync-config` writes from it.
- Commit messages carry no `Co-Authored-By:` trailer and no tool attribution
  line; the `commit-msg` hook refuses both.

## Using the bridge as an agent

[docs/agent-playbook.md](docs/agent-playbook.md).
