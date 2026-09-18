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
  is the scheme and an opaque marker. The path of a page opened this way is not
  written anywhere.

## Reporting a vulnerability

Open a private security advisory on the GitHub repository (Security tab,
"Report a vulnerability"), or email the maintainer through the address on the
GitHub profile. Please include the platform, the browser and version, and the
steps to reproduce. You will get an acknowledgement within a few days.

Please do not open a public issue for something that lets an untrusted page or
another local user reach the bridge.

## Supported versions

Only the latest release on `main` receives fixes.
