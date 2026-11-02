# AGENTS.md

A brief for a coding agent working in this repository. People: start with
[README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md); everything here
is said at more length there.

## What this is

A bridge from AI agents to real, signed-in Chrome and Brave profiles: an MV3
extension per profile, a native messaging host per browser, one always-on
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

`npm run e2e` drives a real browser with a throwaway profile; run it only when
you mean to.

## Rules the gate enforces (do not add exceptions)

- No `chrome.cookies`, and no read of `Cookies`, `Login Data` or `Web Data`.
- No TCP listener: the broker speaks over a named pipe or a Unix socket.
- No dependency beyond `zod` and `@modelcontextprotocol/server`, and no native module.
- No `console.log` in `host/` or `mcp-server/`: stdout is protocol there.
- No em dash in any text file.
- The product's name lives only in `bridge.config.json`.
- `extension/lib/protocol.js` mirrors `shared/protocol.mjs`.

## Conventions

- Every tool that touches a page takes a required `profile`; never add a default.
- Tabs are addressed by opaque handles the broker mints; a caller's raw tab id
  is dropped (`bridged/routes.mjs`, `callerArgs`).
- A script that talks to the broker fixes its vocabulary in code and refuses
  any other operation before it is sent (see `scripts/read-page.mjs`,
  `scripts/close-duplicates.mjs`, `scripts/snapshot-tabs.mjs`).
- Tests run against fake broker clients that record what was SENT; a new
  behavior gets a test that fails without it.
- One version across `package.json`, `package-lock.json` and
  `extension/manifest.json`, with a CHANGELOG entry.
- Commit messages carry no `Co-Authored-By:` trailer and no tool attribution
  line; the `commit-msg` hook refuses both.

## Using the bridge as an agent

[docs/agent-playbook.md](docs/agent-playbook.md).
