# Design

Why the bridge is shaped the way it is, including the architecture that lost.
This is the document to read before changing anything structural.

## 1. The problem

An AI agent needs to drive a real, already-logged-in browser profile, any
number of them, concurrently, from any number of agent sessions on the same
machine. The point is that a real human browser does the work: when a
human-verification gate appears (Cloudflare, Turnstile, an SSO prompt), a
human is sitting right there and can clear it, and everything after the gate
is drivable.

That is explicitly not what headless automation tools do. `chrome-devtools-mcp`
launches a fresh Chrome-for-Testing with a throwaway profile, which is
fingerprinted as automation and has none of your sessions. That tool is the
right answer for testing a localhost frontend. This is the other half.

### What the incumbent got wrong

The tool this replaced was a native-messaging bridge with three structural
defects, each of which shaped a decision below:

1. **One profile only.** Chromium spawns one native-messaging host process per
   profile that connects. Every one of those processes tried to bind the same
   hardcoded TCP port, so the second profile lost and sat in a "connected,
   service not started" state forever.
2. **No reconnect state machine.** Its scheduler branched on "does a port
   object exist" rather than "is the link actually working", so a half-open
   port hung permanently with no timeout.
3. **A native-code dependency it did not need.** A compiled SQLite binding,
   there to store chat history for a side panel, ABI-locked to one Node major
   version. Every Node upgrade broke it.

## 2. The architecture

**Native messaging to a per-profile relay, rendezvousing at one always-on
broker, with a thin stdio MCP server per agent session.**

```
agent session 1 -+
agent session 2 -+- stdio -> mcp-server (one per session, thin, stateless)
agent session N -+                    |
                                      |  local socket (named pipe or Unix socket)
                                      v
                              +---------------+
                              |    bridged    |  the broker
                              | (one, always  |  route table, profile join,
                              |      on)      |  policy, audit log
                              +---------------+
                                      ^
                                      |  local socket
                  +-------------------+-------------------+
                  |                   |                   |
             host process        host process        host process
             (Brave/Default)  (Brave/Profile 1)   (Chrome/Profile 1) ...
                  ^                   ^                   ^
                  |  chrome native messaging (stdio, length-prefixed JSON)
                  |                   |                   |
             extension SW        extension SW        extension SW
             (one per profile, same unpacked folder)
```

| Component | Runtime | Owns |
|---|---|---|
| `extension/` | MV3 service worker, one instance per profile, all loaded from one unpacked folder | Every browser operation. Holds the `connectNative` port. |
| `host/` | Node, one process per connected profile, spawned and owned by the browser | Nothing. A byte relay between the browser's stdio pipe and the broker's socket. |
| `bridged/` | Node, exactly one, started at login by the platform supervisor | The route table, the profile identity join, policy, arming, the audit log. The only stateful component. |
| `mcp-server/` | Node, one per agent session, stdio | Translating MCP tool calls to broker requests, shaping results (pagination, screenshot budget). Never touches a browser. |

### Why this shape

**The keepalive is free.** The hardest problem in any MV3 extension is that
Chrome kills the service worker after 30 seconds idle. An open `connectNative`
port is special-cased in Chromium: it selects a "does not time out" mode for
the worker, with no traffic requirement. A WebSocket only resets the idle
timer while traffic flows, so it needs a heartbeat hack and an offscreen
document to survive. We get for free what the other design has to engineer.
(We still ship a heartbeat, so that being wrong about this costs latency, not
availability.)

**There is no network listener anywhere.** Not a hardened one, not a
token-gated one, none. The entire "a web page, a loopback page or a remote
host can connect to the bridge" threat class is structurally absent rather
than defended against. That is the single strongest security property
available here, and it is free.

**One extension folder serves every profile.** An unpacked extension's ID is a
pure function of its absolute folder path (or of a `key` in the manifest, if
one is present), with no profile input. So every profile that loads the same
folder gets the same ID, and one `allowed_origins` entry authorizes all of
them. The installer derives the ID the same way Chromium does
(`shared/extid.mjs`, checked against Chromium's own unit-test vectors), so
nobody copies an ID out of `chrome://extensions`. The optional `keygen` step
pins the ID with a key so it survives moving the folder.

**No native modules, enforced.** The gate fails on any `.node` file anywhere in
the tree, and on any dependency outside a two-package allowlist. That is the
direct lesson from the incumbent.

### The alternative that lost

**A dial-out WebSocket from the extension to a single local daemon**, with an
offscreen document owning the socket to dodge worker eviction. One daemon
instead of N+1 processes, two hops instead of three, zero registry writes.
It lost on three things:

1. Chromium's Local Network Access checks can block an extension worker's own
   outbound socket, and the observed failure mode is a silent hang with no
   error. Betting an always-on system on an unexamined interaction with a
   subsystem that ships enforcement changes every few months is not a bet
   worth taking.
2. Bootstrapping a shared secret into an extension requires a window where the
   daemon trusts `Origin` alone, and `Origin` is trivially forged by any local
   process. Native messaging has no such problem: `allowed_origins` is
   enforced by Chromium, not by our code.
3. A browser-enforced boundary beats a self-enforced one. Origin checks in our
   own code can regress in a refactor; `allowed_origins` refuses wildcards at
   parse time and cannot.

Grafted from it anyway: opaque profile-stamped tab handles, the explicit
screenshot budget loop, `browser_scroll` as a first-class read tool, the
runtime stdout guard, per-boot token rotation, and the tested capability
partition between roles.

## 3. The tool surface

Every tool that touches a page takes `profile` as a **required** parameter
with no default, even when only one profile is connected. Acting on the wrong
browser is the worst failure this system can produce, and a default is how
that happens.

Tab handles are opaque broker-minted strings, `tab_<profile>_<gen>_<n>`,
never raw Chrome tab ids. Raw ids are per-profile integers that collide
freely across profiles, so a raw id from one profile would find a real, valid,
completely wrong tab in another. The broker rejects any handle whose embedded
profile does not match the `profile` argument, and `<gen>` increments on every
browser restart so a stale handle fails loudly instead of landing on whatever
tab now holds that number.

| Tier | Tools | Notes |
|---|---|---|
| Read | `browser_list_profiles`, `browser_list_tabs`, `browser_read_page`, `browser_screenshot`, `browser_scroll`, `bridge_status` | Always allowed. `browser_list_profiles` also lists configured-but-absent profiles, which is how a silently disabled extension becomes visible. |
| Write | `browser_navigate`, `browser_open_tab`, `browser_close_tab`, `browser_activate_tab`, `browser_click`, `browser_fill`, `browser_press_keys`, `browser_wait_for` | Allowed, always audited. `browser_click` and `browser_press_keys` accept `trusted: true` to escalate to real input events through the debugger. |
| Armed | `browser_eval_js` | Arbitrary JavaScript in an authenticated session: a full-compromise primitive, gated behind an explicit human arm. |
| Control | `bridge_arm`, `bridge_panic` | Arm one profile for a bounded window; drop every route and refuse everything. |

`browser_scroll` is a first-class read tool on purpose. Without it every
infinite-scroll surface would have to be driven through arbitrary JavaScript,
which promotes the most dangerous tool in the product to the most frequently
used one.

**`browser_upload_file` is deliberately absent.** It is a working
arbitrary-file-exfiltration primitive reachable by prompt injection with zero
human interaction. If it is ever added it needs a path allowlist and its own
arming gate.

## 4. Profile identity

No Chromium API tells an extension which profile directory it runs in. That is
deliberate, for anti-tracking reasons. So identity is joined from two sides:

- **Extension side**: a stable `installId` minted once into
  `chrome.storage.local` (never `storage.session`, which would mint a phantom
  profile on every worker restart); vendor detection via `navigator.brave` and
  `userAgentData.brands` (Brave's User-Agent string is byte-identical to
  Chrome's); and on Chrome the signed-in email from `chrome.identity`.
- **Broker side**: the browser's `Local State` file, plain JSON whose
  `profile.info_cache` maps directory names to human names and accounts. The
  broker also confirms the vendor independently by walking the host process's
  ancestry to the browser executable, because the extension's own claim is
  corroboration, never the deciding vote.

**Chrome profiles resolve automatically** by matching the reported email
against `info_cache`. **Brave profiles need one click, once**: Brave writes no
account identity at all, so the extension's options page offers the candidate
directories and the human picks. Persisted by `installId`, so it happens once
per profile, ever.

**A claim is to a person, not to a directory.** A directory does not change
when the account signed into it does. So every claim records an identity
fingerprint (the Google account id where Chrome provides one, else the email,
else the profile name), and the broker compares it against the live value at
every register and about once a minute on the heartbeat. When it changes the
claim is **dropped**: the route is unclaimed, relabeled, disarmed, and its
generation bumped so every outstanding handle dies. The old label then
resolves to nothing and the next tool call fails with `E_UNKNOWN_PROFILE`
listing the labels that do exist. A loud failure beats a silent wrong action.

Two limits, stated plainly: on Brave an account switch with no rename is
undetectable (there is nothing on disk that changed), and renaming a Brave
profile reads as an identity change. Chrome carries the full protection.

**Labels** are `<vendor>-<slug>`, where the slug prefers a custom domain, then
the email local part, then the profile name. Two profiles deriving the same
name both get suffixed with their directory and neither keeps the bare form,
so the assignment is a pure function of the connected set and never depends
on which browser happened to open first. Labels are renamable in the options
page, and a custom label always wins.

## 5. Security model

**This system does not create a trust boundary against code already running as
you.** A process running as your user can read your cookie database straight
off disk; it does not need this bridge and this bridge cannot stop it.

| Threat | Status |
|---|---|
| A web page reaching the bridge | Structurally impossible. Nothing is listening. |
| A remote host reaching the bridge | Structurally impossible. Nothing is listening. |
| Another user account on the machine | Defended by a per-boot token in an owner-only file |
| An unauthorized extension connecting | Enforced by Chromium itself: `allowed_origins` pins one ID, wildcards rejected at parse time |
| A page injecting instructions into the model | Partly mitigated: tiering, arming, panic, audit |
| Malware already running as you | Not defended. It does not need us. |

Rules the build gate enforces on every commit:

1. No TCP listener, ever.
2. `chrome.cookies` is not requested and cannot appear in the code.
3. The only browser file ever read is `Local State`, and only its profile
   section. Never `Cookies`, `Login Data` or `Web Data`.
4. The audit log records origin only: never a path, query or fragment,
   because reset and magic-link tokens live in paths.
5. stdout is protocol in `host/` and `mcp-server/`; a stray console write
   corrupts a framed stream and presents as an unparseable stream rather than
   an error, so the gate greps for it and a runtime guard redirects it.

**On arming.** Arming everything would get switched off within a week by
anyone running several sessions across several profiles, which is worse than
not having it. So the bridge arms the one thing that is genuinely unbounded in
blast radius, `browser_eval_js`, and lets the bounded operations run audited.
A click on a specific link is recoverable and visible; arbitrary JavaScript in
an authenticated session is neither.

**`chrome.debugger` is treated as revocable infrastructure.** It is the only
API in Chromium marked developer-mode-only, behind a flag Google can flip
remotely. So every v1 requirement is satisfiable without it: tier 1 (no
debugger) covers navigate, click, fill, keys, read, scroll and active-tab
screenshots; tier 2 (debugger) is escalation only. If the flag flips we lose
escalation, not the product.

**The panic switch is a file.** The broker watches for `PANIC` in its state
directory and re-checks on every request. Creating that file drops every
route; `bridge_panic` just creates it. Nothing in the bridge can clear it,
because a bridge that can clear its own emergency stop is not an emergency
stop.

## 6. Staying connected

Five independent failure surfaces, five recovery paths:

| Failure | Recovery |
|---|---|
| Service worker evicted | Mostly prevented by the `connectNative` keepalive. Residual eviction is covered by three wake sources (a `chrome.alarms` tick, `onStartup`, `onInstalled`) that all call one idempotent `ensureConnected()`. |
| Half-open port | A three-state link machine persisted in `storage.session`. After `connectNative` the worker posts REGISTER and requires REGISTER_ACK within 5 s, else tears down and reschedules. The scheduler branches on link state, never on "does a port object exist". |
| Broker restart | The host does not exit (its stdin is still a live browser port). It fails in-flight requests with a typed error, refuses the extension's registration so it re-introduces itself, and reconnects with jittered backoff, capped, unlimited attempts, no cooldown. The supervisor restarts the broker within a minute. |
| Browser restart | The host sees EOF and exits. On start the extension reconnects with the same `installId`; the broker replaces the route and increments the generation, invalidating stale handles by construction. |
| Reboot | The supervisor starts the broker at login. `state.json` persists the claims, so no re-pairing. |

Liveness is computed from a heartbeat clock, never from socket existence.
During an outage the tools never disappear: the MCP server always starts, so a
broker outage surfaces as an actionable `E_NO_BROKER` on each call rather than
the tools vanishing from the list.

## 7. Two sizing facts

**Native messaging is asymmetric.** 1 MiB host to browser, 64 MiB browser to
host. Screenshots travel browser to host and cross in one frame. Large command
bodies travel the other way and are chunked above 512 KiB, with one envelope
defined in the shared contract so both sides agree on it.

**Agent clients cap tool output.** Claude Code discards a result over about
25,000 tokens rather than truncating it. So page text is paginated with a
cursor, and `browser_screenshot` runs a budget loop (quality 0.72, 0.60, 0.50,
then half the width) targeting roughly 55,000 base64 characters, writing the
image to disk and returning the path when it cannot fit.

## 8. The interface

Two human surfaces, both inside the extension.

**The Board** (options page): every profile is a line with a state lamp
(live, idle, stale, absent, unclaimed, identity changed). Claiming, inline
renaming, arming with a live countdown, and the audit tail with a visible note
that paths are never recorded. **Panic** is a press-and-hold control, so it
cannot be hit by accident.

**The popup** is the one-second view: broker status, this line, tab count,
arm, and a way onto the board.

**A third surface, for the operator's terminal**, added in 0.2.0:
`scripts/claim.mjs` (the claim card without the click) and `scripts/label.mjs`
(the inline rename). Both speak to the broker as an agent-role connection,
which is allowed to originate the two META operations (`BROKER_OPS` in
`shared/protocol.mjs`). Two things about them are deliberate. They are not
MCP tools, so the model never gets to claim or rename a line; the agent
surface is read, write, armed and control, exactly as section 5 lists it. And
unlike the extension, which may only ever claim or rename its own line, the
terminal scripts can address any connected line: they run as the operator,
with the owner-only runtime token, which is the same trust boundary as the
broker process itself. A local process that can read that file can already
do everything the broker does. The scripts make the operator's own actions
explicit and refuse anything that is not an exact, unique match, and a rename
invalidates the line's open tab handles for every session, as the board's
rename does.

MV3's content-security policy forbids inline script, so everything is wired
with `addEventListener`, every icon is inline SVG, and the whole palette lives
in one token file so the light and dark themes cannot drift apart. The icon
PNGs are generated by a dependency-free encoder built on Node's own `zlib`.

## 9. Honest weaknesses

1. **Process count.** One host per connected profile plus the broker plus one
   MCP server per agent session. Node's floor is about 40 MB per process. This
   is the real price of the architecture.
2. **The Windows host launches through a `.cmd` shim**, which routes through
   `cmd.exe`. Node's single-executable feature would remove that, and is not
   yet stable enough to sit on the critical path.
3. **Unpacked installs in Developer mode**, which Chrome can disable with a
   prompt. The configured-versus-live check in `doctor` makes it visible; it
   cannot prevent it.
4. **The Windows named pipe has the default security descriptor**, readable by
   every local user. The token is the only control; Node cannot set a DACL
   without a native addon, and native addons are banned.
5. **`chrome.debugger` is on a demolition timeline.** Accepted deliberately;
   see section 5.
6. **macOS and Linux paths have not been exercised on real machines yet.** The
   code follows the platform documentation and is unit-tested for shape;
   Windows is the reference platform.
7. **Edge is out of scope.** It is discovered but not registered. Trivial to
   add; not a v1 requirement.

## 10. Repo layout

```
shared/       config.mjs     reads bridge.config.json: the product identity
              protocol.mjs   the contract: messages, ops, tiers, errors, timings, board
              framing.mjs    length-prefixed JSON codec, used on all three hops
              paths.mjs      platform layout, browser discovery, Local State, labels
              extid.mjs      Chromium extension-ID derivation
extension/    manifest.json  MV3, debugger in permissions (never optional), no key by default
              sw.js          service worker: link lifecycle and dispatch
              lib/           config.js (generated), protocol.js (mirror), link.js, ops.js, snapshot.js, inject.js
              options/       the Board
              popup/         the one-second view
              ui/            tokens.css, icons.js
              icons/         generated PNGs
host/         index.mjs      byte relay, one process per profile
              bridge-host.cmd
bridged/      index.mjs      socket server and connection lifecycle
              routes.mjs     route table, tab handles, generations
              profiles.mjs   the identity join, the process-ancestry walk
              policy.mjs     tiers, arming, panic, capability partition
              audit.mjs      origin-only JSONL
mcp-server/   index.mjs      the tools
              client.mjs     socket client
              shape.mjs      pagination, screenshot budget, error shaping
scripts/      sync-config, rename, keygen, install-host, install-broker,
              install-mcp, doctor, gate, e2e, gen-icons, install-hooks
test/         node --test, fixtures only, never the live machine
```

No `dist/`. Every file above runs as written.
