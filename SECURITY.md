# Security

## What this is, in one paragraph

This bridge lets an AI agent drive your real, logged-in browser. That is the
point of it, and it is also the whole risk: an agent that can click, type and
read inside your authenticated sessions can do what you can do there. The
design limits that in the ways listed in the README's Security section (no
network listener, a per-boot token, a required `profile` on every call, an
explicit arm for arbitrary JavaScript, a panic switch that works without the
agent's cooperation, an origin-only audit log). It does not and cannot protect
you from code already running as your user, and it does not make an agent
wise about what it reads on a page. Prompt injection is real; the tiering,
arming and panic controls exist to bound it, not to remove it.

## The one exception to the `file:` refusal

`file:` URLs are in `RESTRICTED_URL_PREFIXES` for a specific reason: navigating
is a WRITE-tier operation and reading a page is a READ-tier one, so without the
refusal an injected instruction could compose the two into an unarmed local-file
read, point a tab at a dotenv file or a key and read it straight back.

`browser_open_or_focus` is the single operation allowed past that refusal, and
only for a `file:` URL whose path ends in `.html` or `.htm`. Its whole job is
putting a rendered page in front of the person at the machine, and those pages
are local HTML files. The carve-out does not restore the read primitive, because
no arbitrary local file is reachable through it: a `.env`, a key, a cookie
database, a mailbox export and a plain text file all keep their refusal.

Three things back that up rather than resting on it:

- The rule is enforced twice, in the extension and again in the broker, because
  the broker is the point a compromised extension cannot talk its way past.
- Chromium refuses content-script injection into `file:` pages unless the
  operator turns on this extension's "Allow access to file URLs" toggle.
  Nothing in this repository requests it, sets it, or asks you to, so on a
  default install `browser_read_page` against such a tab fails.
- The audit log is unchanged: it records origin only, which for a `file:` URL
  is the scheme and an opaque marker. The path of a page opened this way is
  never written to the log, and never appears in an error message. It does come
  back in the operation's own result, alongside the tab handle, because the
  caller is the one that named it and a READ-tier `browser_list_tabs` already
  reports the address of every open tab; what the log and the errors promise is
  that the path is not written to disk or shown to anybody who did not already
  have it.

## Finding and moving a tab is not opening one

`browser_open_or_focus` may find a tab that is already showing ANY `file:`
address and move it to the far right of its window. It may OPEN or RELOAD only
the `.html` and `.htm` addresses above. Those are two different permissions and
the difference is the whole of the argument:

- The `file:` refusal exists because navigate (WRITE) and readPage (READ)
  compose into an unarmed local-file read primitive. **Finding a tab and moving
  it performs no navigation and no read**, so it cannot be either half of that
  composition. There is no step at which a local file is fetched, rendered or
  returned.
- **The address is not new information.** READ-tier `browser_list_tabs` already
  reports the URL of every open tab in a profile, so an agent that can call this
  could already see that the tab exists and what it is showing.
- **A reload is a navigation, so it is not attempted at all in this mode**, not
  attempted and reported as failed. That distinction is in the code and has a
  test named after it.
- **It closes nothing in this mode, ever.** The opened-by-us ledger is the only
  thing that may authorize a close, and this mode never creates a tab, so a
  ledger entry matching one of these tab ids can only mean a tab id was
  recycled. The mode therefore ignores the ledger entirely.

What this buys is worth stating because it is the reason to accept any of it: a
PDF a session just generated gets the same one-page-one-tab behavior as an HTML
report. The launcher opens the PDF itself the first time, because the bridge
refuses to, and every call after that moves the tab that already exists.

## A refused scheme, however it is spelled

The restricted list is checked as a set of SCHEMES as well as a set of text
prefixes. The prefix check alone was a rule about slashes, and the number of
slashes in a URL is not load-bearing:

- `file:` is a special scheme in the URL Standard, so `file:/C:/Users/me/.env`
  canonicalizes to `file:///C:/Users/me/.env`, and it does not start with the
  seven characters `file://`.
- `file:\\server\share\x` canonicalizes to `file://server/share/x`, a network
  path, and does not start with `file://` either.

Both slipped past the check before 0.4.0. Checked against a real browser rather
than reasoned about: `browser_navigate`, a WRITE-tier operation needing no arm,
accepted the one-slash form, Chromium canonicalized it, and the tab rendered the
local file, with its title returned in the result. That is the primitive the
refusal exists to prevent, reachable by deleting two characters. It is refused
now, on the scheme, with a test named after it.

## Telling one profile's extension to reload itself

`browser_reload_extension` asks the extension in one profile to call
`chrome.runtime.reload()`, which is exactly what the Reload arrow on the
browser's extensions page does. It exists because a browser reads an unpacked
extension's code once, when it loads it, so without it every release of this
project needs a human to click that arrow once per profile.

It is a WRITE-tier operation, audited like every other, and **refused unless the
install folder holds a different version from the one that profile is running.**
That gate is the security property, and it is enforced in the broker because the
broker is the only component that can evaluate it: an extension cannot see the
folder it was loaded from, since `getManifest()` returns the manifest it is
running rather than the file on disk.

Why it needs a gate at all, given that a reload restores the extension rather
than removing it:

- A reload clears `chrome.storage.session`, which holds the ledger
  `browser_open_or_focus` uses to know which tabs it opened. Afterwards the
  bridge no longer knows, so it will never close them. Repeated on demand, that
  is a way to make the bridge forget its own tabs.
- A reload re-registers the profile, which bumps the browser-session generation
  and invalidates every outstanding tab handle in **every other agent session**
  driving that browser. Repeated on demand, that is a way to disrupt other
  sessions' work.

Once per release, both costs are a fair price for not making a human click.
Unbounded, they are a nuisance primitive, so "there is genuinely new code to
load" is the only circumstance the operation is allowed in.

Two things it deliberately does not do. It does not report success from the
acknowledgement: reloading tears down the native-messaging port the answer
travels on, so the reply necessarily leaves before the reload happens, and only
the profile coming back on a different version proves it landed. And it is not
originable by a host connection, so an extension cannot ask the broker to reload
that same extension and bypass the gate a normal request is held to.

## Resuming from panic

Panic stops everything: every route dropped, everything disarmed, every call
refused. Until 1.1.0 the only way out was deleting the panic file by hand, and
the extension's popup could not even show the panic, because the broker
refused the extension's link while it was on. Now a person can resume from the
popup, with a press-and-hold, and nothing else can:

- **No agent can.** `resume` is a host-only operation in the contract. An MCP
  connection that sends it is dropped as a capability violation, there is no
  MCP tool for it, and `bridge_panic` refuses `on: false`. An emergency stop
  the agent could clear is not an emergency stop.
- **Only the popup page can ask.** The extension's worker takes the request
  only from its own `popup/index.html`. A content script carries the
  extension's id but the browser stamps the page's address on its messages, so
  it is refused, and so is the Board, which can trip panic but not clear it.
- **Only a held extension link can carry it.** During panic the broker answers
  an extension's registration with `E_PANIC` and holds the connection with no
  route: it can read the board and ask to resume, and nothing on it can reach
  a browser. A connection that never registered is refused.

What this does not change: the panic file is still the control that works
without anybody's cooperation, and code running as your user can delete it
(or speak the host's role, having read the token) exactly as before. The
property kept is that the bridge's own request paths have one way to clear
panic, and it is a person holding a button in the popup.

## Password and one-time-code fields

An agent that can type into a logged-in browser can type a password into a
signup form. A fill or key press into a password or one-time-code field is
therefore refused with `E_SECRET_FIELD` unless the agent session carries a
**receipt** pointing at a recorded yes for that site.

- **Which fields.** Judged from what the page says about the field:
  `type="password"`, an `autocomplete` of `new-password`, `current-password`
  or `one-time-code`, or a name, id or label that says password, passcode,
  PIN, OTP, 2FA, MFA, one-time, verification code or security code.
- **Where the keys land.** A trusted key types into whatever has focus when it
  lands, so the check follows focus: the focused element, into shadow roots
  (closed ones too) and frames; again after a selector is focused (an element
  that cannot take focus leaves it where it was); and again before every key
  after the first, because Tab and Enter move focus and so do page scripts, on
  a plain character (auto-advance) or a moment after an Enter. Focus inside
  another site's frame is read by asking that frame, and judged by that
  frame's own site. A frame that cannot be read (a sandbox, a browser page),
  an `<embed>` other than a PDF viewer, or a nesting deeper than the walk goes
  counts as a secret field and is refused even with a recorded yes. Two frames
  that report the same field are one field. After an Enter the check waits for
  the navigation to finish, and a page that cannot be read is waited for
  (about two seconds), never typed into unseen. Once a sequence has typed into
  a password field, the rest of its keys stay on that site: focus that moves
  to another site's frame stops it. A sequence also stops at its deadline, so
  it never types on after the caller was told it timed out. A refusal
  mid-sequence says how many keys were already sent, never which, and never
  quotes the browser's error. Untrusted key events cannot type at all, so they
  are checked where they are sent: the selected element or the top document's
  focused one. The browser reports no focus inside a window that is not in
  front, so a field in another site's frame there is refused, not typed into.
- **The receipt.** The session's own configuration, never a tool argument:
  the MCP server reads it from `BRIDGE_ACCOUNT_WORD` (or the variable
  `BRIDGE_ACCOUNT_WORD_ENV` names) and forwards it on `browser_fill` and
  `browser_press_keys` only. It is the path of a Markdown drop file inside the
  one folder named in `account-word.json` in the state directory
  (`{"folder": "...", "ignoreWords": [...]}`), and the file must carry a line
  `ACCOUNT WORD: <service> ...`. No folder configured means no receipt is
  accepted, which is the default.
- **The grant.** The broker reads the file (inside the folder on its real
  path, a regular file, at most 256 KB), strips any grant the caller sent, and
  forwards only the file name and the services it names. The extension lets a
  secret field through only when a service names the site of the page it
  probed: a service with a dot is a domain and matches itself and its
  subdomains (a registry or shared-hosting suffix such as `co.uk`, `gov.au` or
  `github.io` matches nothing); one without is a brand and matches only its
  `.com` and that domain's subdomains. So `ledgerly` covers
  `accounts.ledgerly.com`, never `ledgerly.xyz`, `ledgerly.co.uk`,
  `ledgerly.login-check.example`, a developer port on somebody's `.dev` or a
  customer site on a shared host, because who holds those cannot be told from
  the name. A site anywhere else is written as its domain
  (`ACCOUNT WORD: ledgerly.co.uk`). An address (`10.0.0.1`) matches only
  itself. The audit line records the receipt's file name, never its path or
  contents.

What it does not defend, stated plainly:

- **An armed profile.** `browser_eval_js` runs arbitrary JavaScript, which can
  set any field. Arming is its own human-gated step; keep `bridge_arm` off
  every auto-approve list.
- **An agent that can write files.** The broker believes any `.md` file in the
  folder that carries the line, and a receipt never expires. An agent with
  shell or file access can write one, or point its own session at an old one,
  as can any code running as your user (which can also drive the browser
  without this bridge). The guard binds an agent that has only the bridge's
  tools; keep the drop folder out of reach of the sessions it governs, and
  remove a drop file once its account exists.
- **A brand that hosts its customers on its own `.com`.** A bare name covers
  every subdomain of the brand's `.com`. Where the brand gives customers pages
  there and is not on the list of shared hosts, write the exact sign-in domain
  instead of the name.
- **A field that hides what it is.** A page that collects a password in a
  field with no password type, no matching autocomplete and no label words is
  not recognized. Most sign-in and sign-up forms say what their fields are,
  because password managers depend on it.

## Grouping tabs

The tab group operations are WRITE tier, like sorting a window: audited,
refused while the panic switch is on, no arm. What they can do is rearrange a
tab strip, which a person can undo by dragging; what they cannot do is the
point of the tier:

- **No content.** Listing groups returns titles, colors and tab handles; no
  page is read and no address is returned that `browser_list_tabs` does not
  already return.
- **No navigation, no close, no reload, no activation.** None of the six calls
  a tab API that does any of these. Collapsing a group that holds the active
  tab would make the browser activate another tab, so that collapse is skipped.
  The one exception is the gather's window move, and it is said: a tab moved
  to another window arrives unselected, but when it was the active tab of the
  window it left, the browser shows another tab there (a discarded one reloads
  when shown). The result names those windows in `reshown`.
- **No movement between profiles, and between windows only by name.** A group
  is made in its tabs' own window and tabs from two windows are refused. The
  window argument of the tab move API is passed by one operation only,
  `browser_gather_group`, with the window the caller named, and only for tabs
  in a group of one exact title. The group move API is never given a window:
  on 2026-10-06 its first cross-window call closed a real browser. The browser
  itself refuses a move to a window of another profile. A window the gather
  leaves with no tabs is closed by the browser and named in `emptied`; nothing
  else closes, and no tab does.
- **Group ids are NOT scoped like tab ids.** They are the browser's own
  numbers, passed through as they are, the same as the window ids
  `browser_sort_window` takes. The call acts only in the profile it names, but
  an id copied from another profile's listing is not refused there: in another
  browser it may name an unrelated group, which would then be renamed, moved
  within its window, collapsed or ungrouped. The damage is bounded by the four
  rules above (nothing closes, navigates or changes window) and undone by
  dragging. List groups in the profile you act on.

`scripts/group-tabs.mjs` narrows this further: its client refuses every
operation except list, group, update and move, refuses raw tab ids, and so
cannot ungroup, close or navigate even if the script itself were wrong. A plan
that names a host window adds the gather to that list, and the client refuses
a gather into any other window.

## Reporting a vulnerability

Open a private security advisory on the GitHub repository (Security tab,
"Report a vulnerability"), or email the maintainer through the address on the
GitHub profile. Please include the platform, the browser and version, and the
steps to reproduce. You will get an acknowledgement within a few days.

Please do not open a public issue for something that lets an untrusted page or
another local user reach the bridge.

## Supported versions

Only the latest release on `main` receives fixes.
