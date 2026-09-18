# Agent Browser Bridge

**Drive your real, logged-in browsers from any AI agent.** Agent Browser Bridge
lets Claude Code, Codex, Cursor or any other MCP client take control of any
Chrome or Brave profile on your machine, through the browser you are already
using: your cookies, your extensions, your logged-in tabs. Every profile is a
separate line, several agent conversations can use the bridge at the same time
with no port fights, and nothing in the system listens on the network.

```
agent session  ->  MCP server  ->  broker  ->  host  ->  extension  ->  your actual browser
```

## Use cases

- **Many AI conversations sharing the browsers on one machine.** Every agent
  session gets its own thin MCP server and they all meet at one always-on
  broker, so ten windows can work at once and none of them owns a port.
- **One browser profile per company or client.** Sign a profile into a
  company's accounts, give it a label, and an agent works "in this company" by
  naming that label. Acting on the wrong profile is structurally refused.
- **Tabs tracked across Chrome and Brave from any window.** `browser_list_tabs`
  on any profile, from any conversation, with opaque handles that can never be
  used against the wrong browser.
- **Arming a profile to run JavaScript for the clicks DevTools cannot land.**
  CAPTCHA sliders, developer-console buttons that check `isTrusted`, consoles
  that only enable Save on real keystrokes: escalate for a bounded window on
  one profile, then it closes on its own.
- **A panic switch that disarms everything.** One press-and-hold in the
  extension, or one file on disk, drops every route and refuses every call
  until a human clears it. It does not need the agent's cooperation.
- **A read-only chat bridge for whitelisted conversations.** Read a few named
  chats in WhatsApp Web, Slack or Telegram Web without the agent ever sending
  or wandering. Recipe and an empty whitelist template are in
  [docs/recipes/read-only-chat-bridge.md](docs/recipes/read-only-chat-bridge.md).
- **Verification walks of a logged-in web app.** Have the agent click through
  the real product as a real user, screenshot every state, and report what
  actually rendered, in the same session it just deployed from.

## How it works

Four pieces, one job each.

- **The extension** runs in each browser profile, loaded unpacked from a single
  shared folder. Its service worker opens exactly one native-messaging port,
  which is also what keeps the worker alive: Chromium grants native messaging
  an unconditional keepalive.
- **The host** is a byte relay. The browser spawns one per profile and owns
  its lifetime. It knows nothing except how to forward frames.
- **The broker** is the only stateful component and the only always-on one.
  It holds the route table, works out which profile each connection belongs
  to, enforces policy, and writes the audit log. A supervisor keeps it alive:
  Task Scheduler on Windows, launchd on macOS, systemd on Linux.
- **The MCP server** is spawned fresh by every agent session. It translates
  tool calls into broker requests and shapes the results. It never touches a
  browser, which is why closing a session cannot disturb your browsers.

There is **no TCP listener anywhere**. The broker's endpoint is a Windows
named pipe or a Unix domain socket, guarded by a token that rotates every time
the broker starts. A web page cannot reach the bridge because there is nothing
listening for it to reach.

The full reasoning, including the architecture that lost and why, is in
[docs/DESIGN.md](docs/DESIGN.md).

## Install

You need Node 22 and Chrome or Brave. About five minutes, once per machine,
then thirty seconds per browser profile.

### 1. Clone and install

```bash
git clone https://github.com/RobBrautigam/agent-browser-bridge.git
cd agent-browser-bridge
npm ci
```

### 2. Load the extension in each browser profile

1. In that profile, open `chrome://extensions` (or `brave://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `extension/` folder of this repo.
4. Note the **ID** the page shows under the extension's name. You will compare
   it in the next step.

Do this in every profile you want the agent to reach. Every profile loads the
same folder.

**Treat the clone as a standalone install folder: never move, rename or
remove it once a profile has loaded it.** The browser derives an unpacked
extension's ID from the folder path (step 3 below), so a moved folder is a
different extension as far as every profile is concerned: the native host
stops matching, every profile drops off the bridge, and you would have to
load it again everywhere. Do your development in a second clone or a git
worktree, and keep this one where it is. `node scripts/keygen.mjs` pins the
ID with a key only when it runs before any profile has loaded the extension;
on an install that is already in use it changes the ID on the spot, which is
the same reload-everywhere cost as moving. Decide on a fresh clone; on a live
install, do not move it.

### 3. Register the native messaging host

```bash
node scripts/install-host.mjs
```

This derives the extension ID from the folder path (exactly as the browser
does for an unpacked extension), writes the native messaging manifest with
that ID in `allowed_origins`, and points each browser at it. It prints the ID
it used. **Compare it with the ID `chrome://extensions` shows.** If they
differ, run it again with the browser's ID:

```bash
node scripts/install-host.mjs --extension-id <the id chrome://extensions shows>
```

Where it writes, per platform:

| Platform | Manifest | Pointer |
|---|---|---|
| Windows | `%LOCALAPPDATA%\agent-browser-bridge\com.agent_browser_bridge.host.json` | one registry value, `HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.agent_browser_bridge.host`. Brave reads Chrome's key, so one value serves both. |
| macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.agent_browser_bridge.host.json` and `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.agent_browser_bridge.host.json` | the file's location is the registration; one file per installed browser. The manifest points at a generated launcher, `~/Library/Application Support/agent-browser-bridge/host-launcher.sh`, with the absolute path to node baked in. |
| Linux | `~/.config/google-chrome/NativeMessagingHosts/com.agent_browser_bridge.host.json` and `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.agent_browser_bridge.host.json` | same as macOS; launcher at `~/.local/state/agent-browser-bridge/host-launcher.sh`. |

Optional: `node scripts/keygen.mjs` pins the extension ID with a key in the
manifest, so the ID survives moving the folder. Run it before step 2 if you
want that; the installer then derives the ID from the key instead.

### 4. Start the always-on broker

```bash
node scripts/install-broker.mjs
```

| Platform | What it registers |
|---|---|
| Windows | a Task Scheduler task named "Agent Browser Bridge broker", started hidden through `wscript.exe` at logon, with a one-minute watchdog. No admin rights. |
| macOS | a per-user launchd agent, `~/Library/LaunchAgents/com.agent_browser_bridge.host.broker.plist`, with `KeepAlive`. |
| Linux | a systemd user unit, `~/.config/systemd/user/agent-browser-bridge-broker.service`, with `Restart=always`. |

`--dry-run` prints exactly what would be written. `--uninstall` removes it.

### 5. Register the MCP server with your agent

```bash
node scripts/install-mcp.mjs                   # Claude Code, edits ~/.claude.json
node scripts/install-mcp.mjs --client cursor   # Cursor, edits ~/.cursor/mcp.json
node scripts/install-mcp.mjs --client codex    # Codex, prints the TOML to paste
```

Every installer backs up the file it edits and changes exactly one key. If you
would rather add it by hand, this is the entry. Replace the path with your
clone's absolute path, forward slashes on every platform.

**Claude Code** (`~/.claude.json`, inside `mcpServers`):

```json
"agent-browser-bridge": {
  "type": "stdio",
  "command": "node",
  "args": ["C:/dev/agent-browser-bridge/mcp-server/index.mjs"],
  "env": {}
}
```

**Cursor** (`~/.cursor/mcp.json`, inside `mcpServers`):

```json
"agent-browser-bridge": {
  "type": "stdio",
  "command": "node",
  "args": ["C:/dev/agent-browser-bridge/mcp-server/index.mjs"],
  "env": {}
}
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.agent-browser-bridge]
command = "node"
args = ["C:/dev/agent-browser-bridge/mcp-server/index.mjs"]
```

Start a new agent session afterwards; MCP config is read at startup.

### 6. Claim Brave profiles, once

Chrome profiles resolve themselves from the signed-in account. Brave writes no
account identity into its profile metadata, so a Brave profile needs one
click: open the extension's options page in that profile (the toolbar icon,
then "Open the board") and pick which profile you are in. Once, ever.

The same claim without the click, for many profiles or a terminal-driven
install:

```bash
node scripts/claim.mjs                                    # every line, with the choices of the unclaimed ones
node scripts/claim.mjs brave-unclaimed-ab12 "work@example.com"   # claim that line as the one exact match
```

The name must match a profile's name or email exactly and uniquely, or the
script refuses and sends nothing. A line that is already claimed is only
moved with `--reclaim`.

### 7. Check it

```bash
node scripts/doctor.mjs
```

Doctor checks the host registration, the extension ID, the broker service,
whether the broker answers, the MCP registration, and, most usefully, whether
every profile you have configured is actually connected right now. Unpacked
extensions can be disabled silently, and that check is the only way you find
out.

## The two-minute smoke test

1. Load the extension into a fresh browser profile (step 2 above).
2. `node scripts/install-host.mjs`, then `node scripts/install-broker.mjs`.
3. In a new agent session, call `browser_list_profiles`. The profile appears
   within a few seconds. Then `browser_list_tabs` with that profile's label
   and `browser_read_page` on any handle it returned.

If the profile does not appear, `node scripts/doctor.mjs` names the step that
failed and the command that fixes it.

## The tools

Every tool that touches a page takes `profile`, and it is **required** even
when only one profile is connected. Acting on the wrong browser is the worst
thing this system could do, and a default is exactly how that would happen.

Tab handles look like `tab_chrome-work_3_41`. They carry the profile and the
browser-session generation, so a handle from one profile is rejected by
another, and a handle from before a browser restart fails loudly instead of
landing on whatever tab now holds that number.

| Tier | Tools | Policy |
|---|---|---|
| Read | `browser_list_profiles`, `browser_list_tabs`, `browser_read_page`, `browser_screenshot`, `browser_scroll`, `bridge_status` | always allowed |
| Write | `browser_navigate`, `browser_open_tab`, `browser_open_or_focus`, `browser_close_tab`, `browser_activate_tab`, `browser_click`, `browser_fill`, `browser_press_keys`, `browser_wait_for` | allowed, always audited |
| Armed | `browser_eval_js` | refused unless a human armed that profile |
| Control | `bridge_arm`, `bridge_panic` | |

`browser_read_page` with format `snapshot` returns a tree of interactable
elements with stable refs, which `browser_click` and `browser_fill` prefer
over CSS selectors. `browser_fill` has a `set` mode that defeats React's value
tracker and a `type` mode that sends real keystrokes for consoles that only
enable Save on them.

### Showing a page to the human at the machine

`browser_open_or_focus` is the tool for a page a PERSON is meant to read, and
the one to reach for when an agent regenerates a report and shows it again.
Given a profile and an address it finds the tab already showing that page,
reloads it and slides it to the far right of the window it is already in; with
no such tab it opens one at the far right of that profile's most recently
focused window. The result is one line saying what it did: reused, moved from
which index to which, reloaded, or opened new.

Three properties make it safe to call while somebody is typing:

- **It does not take the keyboard.** Moving and reloading a background tab
  changes nothing about where input goes. Raising a window does, so `activate`
  is off by default and the caller has to ask.
- **It never closes a tab it did not open.** Duplicates are closed only when
  its own ledger says this tool opened them; a copy the human opened is left
  alone and counted in the answer.
- **It cannot land in the wrong profile.** The operation runs inside the
  extension instance of the profile it names, and that instance can only see
  its own windows, so "the most recently focused window" is that profile's
  even when a different profile's window is the one on screen.

The same capability without an MCP client, for a launcher, a hook or a shell
script:

```bash
node scripts/open-or-focus.mjs <profile label> <url or file path>
```

It prints the same one line and exits non-zero if the page did not land, so a
caller can fall back to its own opener and say so.

There is deliberately no file-upload tool. It would be an
arbitrary-file-exfiltration primitive a poisoned page could aim at your
secrets.

## Security

Stated plainly, because a security model nobody believes is worse than none.

- **Local only.** Nothing listens on the network. The broker's endpoint is a
  named pipe (Windows) or a Unix socket file (macOS, Linux), and every client
  authenticates with a 256-bit token the broker mints on each start and writes
  to a file only your user can read. A leaked token dies at the next restart.
- **What the extension can read.** It has `host_permissions` for all URLs,
  because the agent may need to read any page you are logged into. It never
  requests `chrome.cookies`, and the build gate fails any commit that adds it.
  The only browser file the broker ever opens is `Local State`, and only the
  profile-name section of it: never `Cookies`, `Login Data` or `Web Data`.
- **What arm does.** `browser_eval_js` runs arbitrary JavaScript inside a
  logged-in session, so it is refused unless a human arms that profile, for
  that profile only, for a bounded window (60 minutes at most, 15 by
  default). Reading, clicking, navigating and typing never need arming.
- **What panic does.** `bridge_panic`, the press-and-hold control in the
  extension, or simply creating the file `PANIC` in the state directory drops
  every route, disarms everything and refuses every call until a human deletes
  that file. The bridge cannot clear its own panic, on purpose.
- **Identity is checked, not assumed.** A profile is claimed to a person, and
  the broker re-reads who is signed in about once a minute. If the account
  changes, the claim is dropped and the old label stops resolving, so a tool
  call fails loudly instead of acting as the wrong person. Chrome carries the
  full check; Brave records no account, so there it falls back to the profile
  name.
- **The audit log records origin only.** Scheme, host and port of every write
  operation, never the path, query or fragment, because password-reset and
  magic-link tokens live in paths. `browser_open_or_focus` reads tab addresses
  to find its match, and it is audited under the same rule: what lands in the
  log is the origin, which for a local page is the scheme alone.
- **One local-file exception, as narrow as its job.** `file:` URLs are refused
  everywhere, because navigating to one and reading it back would be a
  local-file read primitive. `browser_open_or_focus` accepts a `file:` URL
  whose path ends in `.html` or `.htm`, and nothing else, because showing a
  generated page to a human is the job it exists for. Every other local file
  keeps its refusal, so there is no arbitrary file to aim a tab at. Chromium
  also refuses to inject into `file:` pages unless you turn on this
  extension's "Allow access to file URLs" toggle, which nothing here requests
  or sets, so reading such a tab back fails on a default install.
- **No telemetry.** Nothing phones home. There is no analytics, no update
  check, no crash reporter. The only outbound connections are the ones the
  agent asks the browser to make.
- **What it does not defend.** Code already running as your user can read
  your cookie database off disk without this bridge. Prompt injection is
  bounded by the tiering, the arm, the panic switch and the audit log, not
  eliminated. See [SECURITY.md](SECURITY.md).

## Platforms

- **Windows** is the reference platform. The whole chain, including the
  end-to-end harness against a real browser, has been run there.
- **macOS and Linux** follow Chromium's documented native messaging locations
  and the platform's standard supervisor. The code paths are written and
  unit-tested, but have not yet been exercised on a real Mac or Linux
  machine. Reports and fixes are welcome; `--dry-run` on every installer shows
  exactly what would be written before anything is.

## Renaming it

The product's name lives in one file, `bridge.config.json`. To ship this
under your own name:

```bash
npm run rename -- my-bridge "My Bridge"
```

That rewrites the config, the extension's copy of it, the manifest and
`package.json`. The gate fails if any of them drift from the config
afterwards.

## Development

```bash
npm test                 # unit tests, node --test, no framework
npm run gate             # the security rules, mechanically enforced
npm run doctor           # diagnose an install
npm run e2e              # the whole chain, against a real Brave and a throwaway profile
npm run hooks:install    # run the gate before every commit
```

Pure ESM, Node 22, no build step, no bundler. Every file runs as written.
Two runtime dependencies (`zod` and `@modelcontextprotocol/server`), zero
native modules, and the gate keeps it that way.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
