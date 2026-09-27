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

## Reporting a vulnerability

Open a private security advisory on the GitHub repository (Security tab,
"Report a vulnerability"), or email the maintainer through the address on the
GitHub profile. Please include the platform, the browser and version, and the
steps to reproduce. You will get an acknowledgement within a few days.

Please do not open a public issue for something that lets an untrusted page or
another local user reach the bridge.

## Supported versions

Only the latest release on `main` receives fixes.
