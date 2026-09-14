# Contributing

Thanks for looking. This is a small, opinionated codebase and the opinions are
written down, so the fastest way to a merged change is to read them first.

## Before you change anything

- [docs/DESIGN.md](docs/DESIGN.md) explains why the system is shaped the way
  it is: why native messaging, why one always-on broker, why every tool takes a
  required `profile`, why the extension ID is derived the way it is. A change
  that fights one of those decisions needs a paragraph on why the decision was
  wrong, not just a diff.
- `bridge.config.json` is the only place the product's name lives. Never type
  the name into a source file; read it from `shared/config.mjs` (Node side) or
  the generated `extension/lib/config.js` (extension side).

## The rules the gate enforces

`npm run gate` runs before every commit once you have run
`npm run hooks:install`. It fails on:

- any `.node` native module, anywhere, including inside `node_modules`
- any dependency outside `zod` and `@modelcontextprotocol/server`
- `chrome.cookies`, or a read of `Cookies`, `Login Data` or `Web Data`
- a TCP listener on a numeric port (there is no network listener in this system)
- a `console.log`-family write in `host/` or `mcp-server/`, where stdout is protocol
- a literal color outside `extension/ui/tokens.css`
- inline scripts or `on*` handler attributes in extension HTML
- an em dash character in any text file
- `extension/lib/config.js` or the manifest drifting from `bridge.config.json`

Every one of those exists because the mistake it catches is invisible in
review and expensive at runtime. Do not add an exception; fix the cause.

## Running things

```bash
npm ci
npm test                 # unit tests, node --test, no framework
npm run gate             # the rules above
npm run doctor           # diagnose an install on this machine
npm run e2e              # the whole chain against a real browser and a throwaway profile
```

`e2e` needs the host registered (`node scripts/install-host.mjs`) and a Brave
binary. Google Chrome ignores `--load-extension`, so the automated harness
runs on Brave; Chrome is verified by hand through "Load unpacked".

## Style

- Plain ESM, Node 22, no build step, no TypeScript, no bundler. Every file runs
  as written.
- Comments explain WHY, and name the failure the code prevents. A comment that
  restates the code is noise; a comment that records the bug that made the
  code necessary is documentation.
- Error messages name the next action. A failure the model or the human cannot
  act on is a failure that costs three turns instead of one.
- No em dashes. A spaced hyphen or a double hyphen is fine.

## Pull requests

- One concern per PR.
- `npm test` and `npm run gate` green.
- If you touched the wire contract (`shared/protocol.mjs`), update its mirror
  `extension/lib/protocol.js` in the same PR. The extension cannot import the
  shared module, so the two are kept in sync by hand.
- If you touched an installer, run it with `--dry-run` on your platform and
  paste the output in the PR.

## Reporting a security issue

See [SECURITY.md](SECURITY.md).
