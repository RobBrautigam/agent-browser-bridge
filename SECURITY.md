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

## Reporting a vulnerability

Open a private security advisory on the GitHub repository (Security tab,
"Report a vulnerability"), or email the maintainer through the address on the
GitHub profile. Please include the platform, the browser and version, and the
steps to reproduce. You will get an acknowledgement within a few days.

Please do not open a public issue for something that lets an untrusted page or
another local user reach the bridge.

## Supported versions

Only the latest release on `main` receives fixes.
