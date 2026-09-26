# Security audit: four fixes and a docs correction on main, nothing released

Session: bridge security audit, single session, 2026-09-26 (06:42 to about 07:30 by `date`),
worktree `c:/dev/agent-browser-bridge-audit`, branch `chore/security-audit-0926`. Unattended:
nobody at the keyboard, no questions asked, everything that needs Rob is in section 7. The running
host, extension and broker on this machine were never touched, restarted or rebuilt, and nothing was
released, tagged or published.

---

## 1. Intent versus what happened

**The intent**, from the dispatch prompt, in order:

1. A short threat model: who can reach the broker and the host, what each can make it do, what the
   design already refuses, every claim cited to a file and line.
2. The audit: the security checklist's 20 rows, the dependency scan, the extension's permissions
   against what it uses, the broker's input handling and origin checks, the installer's writes.
3. The fixes the rails allow, each with a test seen red first, each merged by its own PR.
4. The commit-msg hook false positive: anchor the attribution check at a word start, keep the
   blanket `Co-Authored-By:` refusal exactly as it is.
5. Anything that needs Rob, in section 7, recommendation first.

**What happened.** All five are done. Five PRs merged to main (#7 to #11), and this briefing is the
sixth. Four things are worth reading before the detail:

1. **The main finding was a pipe-name squat on Windows, and it was real.** The broker's named pipe
   lives in one namespace shared by every account on the machine. If another account created the
   name while the broker was down, the real broker exited believing a broker was already running,
   and every client handed the impostor the token and trusted its answers. The host then relayed the
   impostor's requests to the extension, which executes whatever it receives. Fixed in #9: both ends
   now prove the token without sending it. On a machine with one account (this one) there was
   nobody to squat; on a shared machine it was the whole browser.
2. **Codex could not review the auth change.** Its plan was exhausted ("You've hit your usage
   limit ... try again at Sep 27th, 2026 2:37 PM"). The adversarial pass was done in-session instead,
   and it found a hole in this session's own first commit of the fix (section 4, item 1), closed
   before merge. A Codex pass on #9 is owed (section 8).
3. **The headless check showed a second leak nobody had named.** Before #10, a script running in a
   web page's renderer could not only arm eval through the extension's worker; asking `getSelf`
   returned the profile's whole self record (claimed email, label, install id, link state). The
   control run on main returned it in full; the fixed build refuses it.
4. **The docs overstated one control.** They said a human arms `browser_eval_js`. The agent can arm
   through `bridge_arm`, and the broker cannot tell the two apart. Corrected in #11; making the arm
   human-only is a breaking change and waits for Rob (section 7, item 3).

---

## 2. State

| Item | Value |
|---|---|
| Repo | `RobBrautigam/agent-browser-bridge` (public) |
| main at session start | `bc4c236` |
| main now | `54c05af` plus this briefing's PR |
| Merged this session | #7 `d18f064`, #8 `4f486a7`, #9 `4628408`, #10 `9d9d532`, #11 `54c05af` |
| Version | `package.json` still 0.4.1; no bump, no tag, no release (rail) |
| Tests | 428 of 428 on the last code PR; gate 13 rules, 0 violations on every commit |
| Live install on this machine | untouched: the main checkout, its hooks, the running broker, hosts and extension all still run the old code (rail) |
| Deploy | n/a: a local tool with no deploy; a machine takes the fixes by pulling, restarting the broker and reloading the extension (appendix A) |
| Branches left on origin | `fix/refuse-javascript-urls`, `fix/broker-proof`, `fix/sw-ui-sender`, `docs/arm-is-agent-callable`, `fix/commit-msg-word-start`, and `chore/security-audit-0926` (no branch deleted: rail) |

---

## 3. Shipped, and the decisive facts

### 3.1 Threat model

**The shape.** An MV3 extension in each browser profile talks over Chrome native messaging to a Node
host the browser spawns; each host dials one broker (`bridged/`) over a Windows named pipe or a Unix
socket; each agent session runs a stdio MCP server that dials the same broker. Nothing listens on a
TCP port: the broker listens only on `PIPE_NAME` (`bridged/index.mjs:2167`), and the gate's
`tcp-listener` rule fails any commit that adds a numeric-port listener (`scripts/gate.mjs`).

**Who can reach what, and what each could make it do.**

| Actor | Can reach | Could make it do, before this session | What refuses it now |
|---|---|---|---|
| A web page | its own renderer only | Nothing on the pipe. A page cannot message the extension: the manifest declares no `externally_connectable` (`extension/manifest.json`), so `chrome.runtime` is not exposed to it. | Unchanged, structural. |
| A compromised renderer (a browser exploit on a page the agent touched) | the extension's content-script world in that page, which can `runtime.sendMessage` to the worker with the extension's id | Arm eval on the profile for an hour, disarm, panic, claim or rename, and read the profile's self record, through the worker's board API (`extension/sw.js`, the `runtime.onMessage` listener). | #10: the worker answers only this extension's own pages (`extension/lib/ui-sender.js`; the guard at `extension/sw.js:94`). |
| Another local account (Windows) | the pipe name, which is global | While the broker was down: take the name; the real broker then exits 0 on `EADDRINUSE` (`bridged/index.mjs:2149`); every client sent it the token and trusted its ok answer; the host relayed its requests to the extension, which runs any op it is handed (`extension/lib/ops.js:1529`, no arm check there; the arm lives in the broker, `bridged/policy.mjs:203`). | #9: mutual HMAC proof (`shared/auth.mjs`); the host judges its first frame and relays nothing until the link is proven (`host/index.mjs:256`, `:277`); no dial without a token (`host/index.mjs:159`). What remains is a denial of service (the broker still cannot start), which doctor reports. |
| Another local account (the running broker) | the real pipe, read-only under the default descriptor | Nothing useful: Everyone gets read access only (Microsoft's CreateNamedPipe reference, section 3.6), so it cannot send HELLO. | Unchanged. |
| Another local account (the token file) | `runtime.json` | Nothing: the file is restricted to the current user by `icacls` on Windows (`shared/paths.mjs:209`, called from `bridged/index.mjs:2055`), and the state directory is `0700` on macOS and Linux (`shared/paths.mjs:194`) with the socket at `0600` (`bridged/index.mjs:2173`). | Unchanged. |
| Another extension | native messaging to the host id | Nothing: Chromium launches the host only for the one origin in `allowed_origins` (`scripts/install-host.mjs:257`); wildcards are rejected at parse time (the native messaging guide). | Unchanged, enforced by Chromium. |
| The extension itself (host role) | the broker, through its host | Only the broker-local ops in `HOST_REQ_ALLOWED_OPS` (`shared/protocol.mjs:233`), never a page op (`bridged/policy.mjs:95`, enforced at `bridged/index.mjs:818`), so a compromised extension in one profile cannot drive another. | Unchanged. |
| The agent (MCP role) | every browser op and every broker op, including `ARM` (`bridged/policy.mjs:96`, `BROKER_OPS` at `shared/protocol.mjs:206`) | Read, write and, after its own `bridge_arm` call, eval. Its reach is the product; the controls bound it: a required `profile` per call, the tier gate (`bridged/index.mjs:844`), the URL refusal list (`shared/protocol.mjs:319`, checked at `bridged/index.mjs:1599`), panic (`bridged/index.mjs:827`), the origin-only audit (`bridged/audit.mjs:32`). | Docs corrected (#11); the human step for an agent's arm is the agent client's tool approval. |
| Prompt injection (a page steering the agent) | whatever the agent can reach | Navigate to `javascript:` at WRITE tier, which is arbitrary script without an arm; Chromium refused it already. | #8: the broker refuses `javascript:` itself (`shared/protocol.mjs:338`). |
| Malware running as the user | everything the user can | Everything; it does not need the bridge. | Not defended, by design (`docs/DESIGN.md`, the threat table). |

**What the design already refused, and still does:** a network listener of any kind (the dominant
vulnerability class for comparable local MCP servers is DNS rebinding against a localhost HTTP port,
section 3.6); `chrome.cookies` and any read of a browser credential store (gate rules
`chrome-cookies` and `credential-stores`); `file:` URLs except the `.html` carve-out of
`browser_open_or_focus`; a response from a connection other than the one a request went to
(`bridged/index.mjs:1687`); a frame over 64 MiB (`shared/framing.mjs:38`); a connection that has not
said HELLO within 10 seconds (`bridged/index.mjs:257`) or says anything else first
(`bridged/index.mjs:426`).

### 3.2 The fixes, each with its test

1. **#7 `d18f064`, the commit-msg guard starts at a word.** The attribution check is anchored at a
   line start or a non-word character, so "regenerated with [a script]" passes while every
   "Generated with [...]" variant is still refused; the blanket `Co-Authored-By:` refusal is
   unchanged character for character. Found beside it: `withBlock` appended the pre-commit gate
   block, not the commit-msg block, to an existing hook without a trailing `exit 0`. The script now
   runs `main` only as the entry point, so tests import it without installing into the shared hooks
   folder. Test: `test/install-hooks.test.mjs` runs the real block under `sh`: 10 refused, 5 allowed,
   2 append-path cases. Seen red first: 4 of 17 failed against the old block. After: 17 of 17.
2. **#8 `4f486a7`, the broker refuses `javascript:` URLs.** Added to `RESTRICTED_URL_PREFIXES` and its
   extension mirror. Chromium already refuses them in extension API navigations
   (`PrepareURLForNavigation`, section 3.6), so nothing was open on a current browser; the refusal
   now lives where the design says a security rule belongs. Test: five spellings refused,
   `openOrFocusMode` null for each, a path containing the word still allowed. Seen red first: 1
   failure. After: 40 of 40, suite 410 of 410.
3. **#9 `4628408`, clients make the broker prove it holds the token.** The contract is in section 10.
   Test: `test/broker-proof.test.mjs`, 13 cases, runs the real MCP client against a fake server on a
   throwaway pipe name (never the configured one) with `BRIDGE_HOME` in a temp directory. Seen red
   first: 5 failures, including the client taking an answer from a pipe that never proved itself
   ("Missing expected rejection"). Mutations, each red and restored: the ack check forced true (3);
   the client's check removed (2); the broker accepting a bad proof (1); the host's check removed
   (1); the replay ledger removed (1); the host as first committed, `84fa17b` (1); the READY gate
   removed (1); an out-of-order frame treated as ready (1). Suite 423 of 423 at merge.
4. **#10 `9d9d532`, the worker answers board messages from its own pages only.** Test:
   `test/ui-sender.test.mjs`, 5 cases. Seen red first: the id-only predicate (the obvious half-fix)
   fails 3, the content script among them; removing the guard fails 1. Suite 428 of 428. Browser
   check, headless Chromium 149 from the Playwright build already on disk, CDP over a pipe, the
   extension copied to a temp folder so its id could not match the installed host (its
   `connectNative` failed, so no host or broker was reached):

   | | fixed build | main, the control |
   |---|---|---|
   | Board page, `getSelf` | answered | answered |
   | Popup, `getSelf` | answered | answered |
   | Content script in https://example.com, `getSelf` | refused, `E_UNAUTHORIZED` | answered with the full self record |

5. **#11 `54c05af`, docs.** README "Who can arm" and the tier table; design doc tier row and honest
   weakness 8. No code, so no test; gate passed.

### 3.3 The extension's permissions against what it uses

| Permission | Used at | Verdict |
|---|---|---|
| `nativeMessaging` | `extension/lib/link.js:263` (`connectNative`) | needed |
| `tabs` | `extension/lib/link.js:247` and three other files | needed |
| `scripting` | `extension/lib/inject.js` | needed |
| `storage` | `extension/lib/link.js:22` and two other files | needed |
| `alarms` | `extension/sw.js:48` (keepalive) | needed |
| `debugger` | `extension/lib/ops.js:12`; required by the gate's `debugger-permission` rule | needed, by design (tier 2) |
| `identity.email` | `extension/lib/link.js:412` (the identity join) | needed |
| `activeTab` | no API call; `<all_urls>` already covers every scriptable page | redundant; kept, since removing it changes nothing except after a popup click on a page `<all_urls>` does not cover (section 8) |
| host `<all_urls>` | every read, click and fill | needed; the product |
| absent: `cookies`, `externally_connectable`, `web_accessible_resources`, a custom CSP | | correct; the default MV3 CSP holds and the gate forbids inline script and handlers |

### 3.4 Dependency scan

`npm ci` into this worktree only, then `npm audit --omit=dev --json`: 0 vulnerabilities of any
severity across 4 production packages (2 direct, both pinned exact: `@modelcontextprotocol/server`
2.0.0 and `zod` 4.5.2). Dependabot is weekly and grouped (`.github/dependabot.yml`); its one open PR
(#1, zod 4.6.5) is not a security fix (section 7, item 5).

### 3.5 The installers' writes

All user scope, nothing elevated: the host manifest in the state directory plus one `HKCU` key under
Chrome's native messaging key (`scripts/install-host.mjs:303`, `:309`, an argument array); on macOS and Linux a manifest
in each browser's own folder and a `0755` shim (`:298`). The broker installer writes a task
definition, a VBS launcher and a boot script into the state directory (`scripts/install-broker.mjs:564`
to `:576`) and registers a task that runs as the current user with an interactive token
(`:424` to `:430`), or a user-level launchd agent or systemd unit (`:822`). The MCP installer writes
one entry into the agent's own config file (`scripts/install-mcp.mjs:272`). No installer writes
outside the user's profile.

### 3.6 Research sources (free reads only; no metered call made)

| Source | What it gave | Used for |
|---|---|---|
| developer.chrome.com, native messaging guide (read) | the worker "must validate sender.origin (or sender.url)"; `allowed_origins` pins ids, no wildcards | #10; the threat model's extension row |
| developer.chrome.com, "Stay secure" (read) | content scripts are less trustworthy; validate their messages; minimize permissions | #10; section 3.3 |
| developer.chrome.com, `tabs` API reference (read) | `javascript:` URLs in API navigations | #8 |
| chromium/chromium `chrome/browser/extensions/extension_tab_util.cc` (read, raw source) | `PrepareURLForNavigation`: "Don't let the extension use JavaScript URLs in API triggered navigations" | #8: the browser already refused; the broker now does too |
| learn.microsoft.com, `CreateNamedPipeA` (read) | the default descriptor grants full control to LocalSystem, administrators and the creator owner, read to Everyone; `FILE_FLAG_FIRST_PIPE_INSTANCE` fails a second instance with `ERROR_ACCESS_DENIED` | #9: the squat and why the real pipe itself is safe |
| libuv `src/win/pipe.c` (read, raw source) | the first pipe is created with `FILE_FLAG_FIRST_PIPE_INSTANCE`, and `ERROR_ACCESS_DENIED` there becomes `UV_EADDRINUSE` | #9: why the broker exits when the name is taken |
| web search, local MCP and browser-bridge vulnerabilities (titles and snippets only, not read in full): Varonis on MCP DNS rebinding, CVE-2025-66414 and CVE-2025-66416 in MCP SDKs, Oligo on CVE-2025-49596 in MCP Inspector | the dominant class for comparable tools is a localhost HTTP port reachable by a web page | the threat model's "already refused" line; labeled, fewer than three full reads |
| GitHub search (API): `hangwin/mcp-chrome` (12,452 stars, MIT), `ChromeDevTools/chrome-devtools-mcp`, `remorses/playwriter`, `eyalzh/browser-control-mcp` | the comparable projects; names and metadata only, not read | context only; no claim rests on them |

The claim that another account "cannot add an instance to the real pipe" rests on the default
descriptor granting Everyone read access only; the access right that creating an instance needs was
not read from Microsoft's access-rights page. Labeled as an inference.

---

## 4. Misses and lessons

1. **This session's own first commit of #9 had a hole, found by its own adversarial pass.** The host
   judged only a first frame that was a hello_ack; any other first frame fell through to the relay,
   and frames decoded in the same chunk as a refused answer were relayed while the socket closed. An
   impostor could have sent a request ahead of its answer and walked around the proof. Closed in the
   second commit of #9 (`judgeFirstFrame`, the READY gate), red first. Lesson: a handshake check is
   only as good as the path that decides which frame is "the answer"; test the frame that is NOT the
   answer. Class: MISSING RULE for the security checklist (a row 6 note: mutual auth includes what the
   client does with frames before and around the proof).
2. **Codex was out of plan for the one change the ration names.** The fallback reviewer would be a
   subagent, which the rails forbid, so the review was in-session and is disclosed in #9's body. A
   Codex pass is owed (section 8).
3. **The host and the broker cannot be tested end to end without touching the live broker.** Both are
   scripts that bind or dial the configured pipe name, so their glue is covered by the pure functions
   they call plus structural tests. An env override for the socket name would fix that (section 5).
4. **One refused command.** A `cd` into the job's temp folder as the first clause of a compound
   command was refused by the rails hook before it ran. No effect; the command was rerun without it.
5. **The first headless run picked Chromium's own component extension** (its hangout services worker)
   as "the extension", so the pages answered `chrome.runtime` undefined. Matching the worker by file
   name fixed it. A browser check has to prove it found the extension under test.
6. **The GitHub skim of comparable projects came after the fixes**, not before. Nothing in the fixes
   depended on it, but the research-first order was not kept for that one rung.

---

## 5. Opportunities

1. **A socket-name override for tests** (for example `BRIDGE_SOCKET_NAME`, read by `shared/config.mjs`
   only when set) would let a test start the real broker and host on a throwaway pipe. Today that is
   impossible without colliding with a live broker.
2. **CI does not exist.** `.github/dependabot.yml` says an update that adds a dependency "fails the
   gate rather than merging", but the gate runs only in the local pre-commit hook; nothing runs on a
   Dependabot PR. A workflow running `npm ci`, `npm test` and `npm run gate` on pull requests would
   make that sentence true.
3. **Arm as a setting.** A config switch (`armFromAgent`, default true today) would let an operator
   make arm Board-only without a breaking release (section 7, item 3).
4. **Pin the package manager** (`packageManager` in `package.json`) and refresh the lockfile's root
   version, which still says 0.3.0 against `package.json`'s 0.4.1.

---

## 6. Roadmap position

This was a one-off audit, not an arc. It leaves main ahead of the last release (0.4.1) by four
security-relevant changes. The natural next steps are a 0.5.0 release (appendix A holds the notes)
and the upgrade of the live install on this machine; both are Rob's call (section 7).

---

## 7. Needs Rob (recommendation first)

1. **Release 0.5.0.** Recommend yes: anyone else running the bridge only gets these fixes by pulling
   main, and a named version with upgrade steps is how they learn they should. The draft notes are
   appendix A. Alternative: leave main unreleased until the next feature. What answering unlocks: the
   version bump, the CHANGELOG entry and the tag, in a session of their own.
2. **Upgrade the live install on this machine.** Recommend the chair does it at a quiet moment:
   `git pull` in the main checkout, restart the broker, reload the extension in every profile, and
   `npm run hooks:install`. Risk: every connected profile drops its link for a few seconds and any
   agent mid-call gets one `E_NO_BROKER`; reversible by checking out the previous commit and
   restarting. Until then this machine runs the old code (safe here: one account, no squatter).
3. **Make the arm human-only?** Recommend no, not now: keep the arm agent-callable, now documented,
   and keep `bridge_arm` off every auto-approve list (README, "Who can arm"). Alternative: Board-only
   arm, which breaks every workflow that arms from the agent; or the config switch of section 5, item 3.
4. **This repo is public, and its orchestration briefings are internal records.** An earlier
   briefing (`2026-09-19-contributor-scrub.md`, section 5) names another repo of Rob's and describes
   its hook configuration. Recommend: keep future session briefings for this repo in a private repo
   and leave the published history alone. Alternative: keep them here and write them for a public
   reader. This briefing was written for a public reader.
5. **Dependabot #1 (zod 4.5.2 to 4.6.5).** Not a security fix (the audit found no vulnerability in
   4.5.2). Recommend merging it in the release session after `npm test`.

---

## 8. Owed and deferred, with triggers

| Item | Trigger | Who |
|---|---|---|
| The main checkout takes the new commit-msg guard | its next `npm run hooks:install` (section 7, item 2) | the chair, with the upgrade |
| A Codex adversarial review of #9 | the Codex plan resets Sep 27, 14:37; from a checkout at `4628408`: `node <codex plugin>/scripts/codex-companion.mjs adversarial-review --wait --base 4f486a7 --scope branch` | the chair |
| The security-checklist skill's LESSONS and RUNS entries | not written: the rails kept this session out of `~/.claude`; the lesson to append is section 4, item 1 (class MISSING RULE) | the chair or the next session allowed there |
| CI for pull requests | section 5, item 2 | a build session, Rob's priority |
| `activeTab` kept though redundant | drop it in any release that already asks every profile to reload | the release session |
| `packageManager` pin, lockfile root version | section 5, item 4 | the release session |

---

## 9. Recommendation

Cut 0.5.0 with appendix A's notes and upgrade this machine in the same sitting, so the release is
exercised on the live install before anyone else pulls it.

---

## 10. Contracts

**HELLO, scheme `hmac-sha256-v1`** (`shared/auth.mjs`):

- Client HELLO carries `auth: "hmac-sha256-v1"`, `nonce` (64 lowercase hex, fresh per dial) and
  `proof = HMAC-SHA256(token, "hmac-sha256-v1|client|<role>|<nonce>")`, and no `token`.
- The broker verifies the proof in constant time, refuses a nonce it has accepted this boot (a
  bounded ledger of 4,096), and only then answers `hello_ack` with
  `proof = HMAC-SHA256(token, "hmac-sha256-v1|broker|<role>|<nonce>")`.
- The client treats its first frame as one of ready, refused, impostor or out of order, and relays or
  sends nothing unless it is ready.
- `runtime.json` gains `auth: "hmac-sha256-v1"`. Clients pick the scheme from that file only, never
  from the pipe. A file without the field means an older broker: the client sends the legacy
  `token` HELLO and has nothing to verify.
- A new broker still accepts the legacy `token` HELLO, so old hosts and MCP servers keep working
  until they restart.

**The worker's board API** (`extension/lib/ui-sender.js`): a message is answered only when
`sender.id` is this extension's id, `sender.url` starts with `chrome-extension://<id>/`, and
`sender.origin`, when present, is exactly that origin. Anything else gets
`{ ok: false, error: { code: "E_UNAUTHORIZED" } }`.

**URL refusal:** `javascript:` is in `RESTRICTED_URL_PREFIXES`, refused on its scheme however it is
spelled, in the broker, the extension and `browser_open_or_focus`.

---

## 11. Merge target and gate

Every change went to main through its own squash-merged PR after the repo's hooks (the gate in
pre-commit, the attribution guard in commit-msg) and `npm test` passed: #7, #8, #9, #10, #11. This
briefing merges by its own PR.

### Security checklist: agent-browser-bridge (broker, host, extension, MCP server): 2026-09-26

Surface: a local browser bridge, no network listener, no database, no login | Repo:
`RobBrautigam/agent-browser-bridge` | Ref: main `54c05af` | Ran by: the security audit session

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Hide API keys | PASS | No API key exists. The one secret, the per-boot token, is minted at start (`bridged/index.mjs:123`) and never in source; the secret-pattern `git grep` returned nothing. |
| 2 | Purge secrets from Git | PASS | `git ls-files` holds no `.env*`; `git log --all -S '"token":'` hits one commit, `01d2000`, and the hit is a test fixture (`'{ "token": "tru'`), not a value. |
| 3 | Expose only the public DB key | N/A | No database. |
| 4 | Enable row-level security | N/A | No database, no tables, no functions. |
| 5 | Encrypt sensitive data | PASS | No stored credential. `runtime.json` holds the per-boot token, restricted to the user (`shared/paths.mjs:209`; `0700` directory on macOS and Linux, `:194`), and dies at the next restart. |
| 6 | Enforce server-side auth | PASS (fixed this session, #9) | Every connection proves the token within 10 s or is dropped (`bridged/index.mjs:257`, `:440`). Before #9 only the client proved itself; the broker now proves itself back, and clients judge their first frame (`host/index.mjs:256`). |
| 7 | Lock record access | PASS | Every browser op names a `profile`; the host role can originate only broker-local ops (`bridged/policy.mjs:95`, enforced `bridged/index.mjs:818`); an extension may claim or rename only its own line; a response is accepted only from the connection the request went to (`bridged/index.mjs:1687`). |
| 8 | Block field tampering | PASS | Every MCP tool input is a zod object (19 in `mcp-server/index.mjs`), which strips unknown keys; op names are allowlists (`BROWSER_OPS`, `BROKER_OPS`, `HOST_REQ_ALLOWED_OPS`); the worker's board API switches on a fixed set of kinds with typed fields. |
| 9 | Secure session cookies | N/A | No HTTP surface and no session cookies; the extension never requests `chrome.cookies` (gate rule `chrome-cookies`). |
| 10 | Hash passwords | N/A | No passwords, no login. |
| 11 | Rate limit login | N/A | No login. The handshake is a 256-bit token behind HMAC with a 10 s HELLO deadline, which a guessing loop cannot move. |
| 12 | Add bot protection | N/A | No public form. |
| 13 | Parameterize queries | PASS | No SQL. Child processes (`icacls`, `schtasks`, `reg`) are started with argument arrays; a search for `shell: true` and template-string `exec` returned nothing. |
| 14 | Validate all input | PASS (fixed this session, #8, #10) | Frames capped at 64 MiB (`shared/framing.mjs:38`); URLs checked against the refusal list (`shared/protocol.mjs:319`, now with `javascript:`); the worker validates its sender (`extension/sw.js:94`). |
| 15 | Escape user content | PASS | No `innerHTML`, `outerHTML` or `insertAdjacentHTML` anywhere in the extension; MV3's default CSP and the gate's inline-script and inline-handler rules. |
| 16 | Restrict file uploads | N/A | No upload path; `browser_upload_file` is deliberately absent (`docs/DESIGN.md`, section 5). |
| 17 | Trim API responses | PASS (fixed this session, #10) | The audit log records origin only (`bridged/audit.mjs:32`). The self record (claimed email, label) went to any content-script sender before #10 (the headless control, section 3.2); it now goes only to this extension's pages. |
| 18 | Add security headers | N/A | No HTTP surface: the only endpoints are a named pipe or Unix socket and native messaging. |
| 19 | Force HTTPS | N/A | No network listener at all (gate rule `tcp-listener`). |
| 20 | Scan dependencies | PASS | `npm audit --omit=dev`: 0 of any severity, 4 production packages, both direct ones pinned exact; Dependabot weekly and grouped. Adjacent: no CI runs the gate on Dependabot PRs, and no `packageManager` pin (sections 5 and 8). |

RobOS extras:

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 21 | Auth config survives `supabase config push` | N/A | No Supabase. |
| 22 | One runner per shared quota | PASS | One broker per machine by construction: the first pipe instance wins and a second broker exits (`bridged/index.mjs:2149`). |
| 23 | Local processes cannot double-fire production | N/A | No production service; the tool is local. |
| 24 | The Brand Alchemy wall holds | PASS, with an adjacent finding | No Brand Alchemy data in the code. Adjacent: an earlier public briefing names a Brand Alchemy repo (section 7, item 4). |
| 25 | Partner-visible channels carry only safe categories | N/A | No outbound channel. |

Adjacent findings: the public orchestration briefings (section 7, item 4); no CI (section 5, item 2).
FAILS: 0 open. Three rows were failing at session start (6, 14, 17) and are fixed on main.
N/A: 10, each naming the absent surface.
VERDICT: SHIP (for main; the release itself is Rob's call, section 7, item 1).

---

## Appendix A. Draft release notes for 0.5.0 (for Rob's word; not applied)

```
## [0.5.0] - <release date>

### Security

- Clients now make the broker prove it holds this boot's token, and no client
  sends the token any more. On Windows the broker's pipe name is shared by every
  account on the machine; another account that created it while the broker was
  down used to receive the token and could drive the browser through the host.
  `runtime.json` gains `auth: "hmac-sha256-v1"`. (#9)
- The extension's service worker answers its board API (claim, rename, arm,
  disarm, panic, and the profile's own record) only from the extension's own
  pages. A script in a web page's renderer could previously arm
  `browser_eval_js` for an hour and read the profile's claimed email. (#10)
- `javascript:` URLs are refused by the broker itself. Chromium already refused
  them in extension navigations; the refusal no longer rests on the browser. (#8)

### Fixed

- The commit-msg guard no longer refuses an honest sentence such as
  "regenerated with [a script]", and an existing hook without a trailing
  `exit 0` now receives the attribution guard instead of the pre-commit gate
  block. (#7)

### Documentation

- The README and the design doc say that the agent can arm through
  `bridge_arm`, that the broker cannot tell that from a Board click, and that
  the human step for an agent's arm is the agent client's tool approval. (#11)

### Upgrading

1. Pull the new version into the install folder.
2. Restart the broker. Windows: `schtasks /End /TN "Agent Browser Bridge broker"`
   then `schtasks /Run /TN "Agent Browser Bridge broker"`. macOS and Linux: the
   restart command `npm run doctor` prints.
3. Reload the extension in every profile: `npm run reload`, or the reload
   button on the browser's extensions page.
4. If you commit to the repo: `npm run hooks:install`.

Old hosts and MCP servers keep working with the new broker until they restart,
and a new host keeps working with an old broker until it restarts.
```

---

## Appendix B. Loose ends (every item of the dispatch prompt)

| Item | Status |
|---|---|
| Threat model with file and line | ✅ section 3.1 |
| The 20-row verdict table | ✅ section 11, plus the five RobOS extras |
| `npm audit --omit=dev` after `npm ci` in this worktree only | ✅ section 3.4 |
| Extension permissions against use | ✅ section 3.3 |
| Broker input handling and origin checks | ✅ sections 3.1 and 3.2; three fixes |
| Installer writes | ✅ section 3.5 |
| Fixes, each red first, each its own PR | ✅ #8, #9, #10 (and #7, #11) |
| Hook false positive, word start, trailer rule unchanged, red first | ✅ #7 |
| The hook in the main checkout left alone | ✅ untouched; named in section 8 |
| No release, tag or package; release notes as a draft | ✅ appendix A |
| Needs Rob, recommendation first | ✅ section 7 |
| Research pass, free reads, cited | ✅ section 3.6; the GitHub skim came late (section 4, item 6) |
| Codex on the auth change | ⚠️ attempted, plan exhausted; owed (section 8) |
| Security-checklist self-improvement close | ⚠️ not written: `~/.claude` untouched by rail; the lesson is in section 4, item 1 |
| Briefing merged by its own PR and verified on main | ✅ at close |
| One line to the chair | ✅ at close |

---

## Appendix C. What this session started, and that it is stopped

| Started | Stopped |
|---|---|
| `npm ci` in this worktree | finished on its own; `node_modules` stays in the worktree |
| `npm test`, `npm run gate`, the mutation runs | each exited on its own |
| The Codex adversarial review (`codex-companion.mjs adversarial-review`) | the command exited 0 (plan exhausted), but left its helper, `app-server-broker.mjs` (pid 58208, started 07:05:37, parent gone, cwd this worktree) and its child `bash -c "codex app-server"` (pid 66308). Both stopped by id at 07:19, checked gone. A `codex.exe` from the VS Code extension (started at midnight, parent VS Code) is not this session's and was left alone. |
| Five headless Chromium runs (the Playwright build `chromium-1228` already on disk, no install, CDP over a pipe, no listening port) | each exited on its own through `Browser.close`; a process search for their temp paths found nothing |
| Fake broker servers inside the tests (throwaway pipe names) | closed by each test |

Nothing this session started is still running.
