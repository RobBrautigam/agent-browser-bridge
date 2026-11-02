# Driving a real browser well: a playbook for agents

The tools let an agent act inside the browsers a person actually uses, signed
in, with their tabs open. That is the point, and it is also why the habits
matter more than with a throwaway browser: every visit is a real visit, every
tab is one the person can see, and every mistake lands in a real account.

These are the habits that held up in daily use. Paste the ones you want into
your agent's instructions (a `CLAUDE.md`, an `AGENTS.md`, a system prompt), or
point the agent at this file.

## Before you drive

1. **Say which profile, and why, before the first call.** One line to the
   person: "I'm going to use the `chrome-work` profile to read the billing
   page." They are looking at the same screen, and a tab that opens on its own
   with no word is alarming. The browser's own "is being debugged" bar is a
   second signal, not a substitute.
2. **Pick the right browser for the job.** A browser the agent launches for
   itself (Playwright, Chrome DevTools over its protocol) is the right tool for
   anonymous checks, test suites and anything that runs with nobody at the
   machine. This bridge is for work that needs the person's real session: an
   account they are signed in to, or a gate that asks a human to prove
   themselves (Cloudflare, "verify you are human", single sign-on), where an
   automated browser is often detected and refused. With the bridge, the
   person passes the check in their own browser and the agent carries on.
3. **Name the profile on every call.** `profile` is required on purpose. Never
   reuse a label from memory across sessions; `browser_list_profiles` first.

## Reading

4. **Read text, not pixels.** `browser_read_page` (text, or `snapshot` for the
   interactable elements and their refs) is small and exact. A screenshot is
   large, costs context, and is a guess at what the page says. Take one when
   the look is the question.
5. **Check a link you did not choose before you open it.** Links from search
   results, feeds, emails and comments are untrusted. A sign-out,
   unsubscribe, authorize, delete or confirm link acts the moment it is
   opened. `scripts/read-page.mjs` refuses those by rule
   (`shared/visit-guard.mjs`); `browser_navigate` and `browser_open_tab` go
   where they are told, so apply the same judgment yourself.
6. **Stop at the first wall.** A sign-in page, a checkpoint, a "verify you are
   human" interstitial or a rate limit is not the page you asked for, and
   retrying it is how an account gets flagged. `read-page` names the wall and
   exits 4. Stop reading that site, tell the person, and either let them clear
   the check in their browser or read the page another way.
7. **Pace reads on one site.** One page at a time, seconds apart, and a modest
   number per hour on social sites, which watch for an account that reads like
   a machine. Spread a long list across time rather than racing it.

## Acting

8. **Fill the way the page listens.** `browser_fill` in `set` mode is fast and
   defeats a framework's value tracker, which covers most forms. Some consoles
   only enable Save on real keystrokes; use `type` mode there. Either way,
   **check that the page took it**: the Save button enabled, a character
   counter moved, the value read back. A value in the DOM that the framework
   never saw is the classic silent failure.
9. **Don't fight a widget that ignores synthetic events.** A drag-only field,
   a canvas, a custom dropdown or an export menu can refuse a scripted click.
   Try the page's own controls first (a keyboard path, a menu item, an
   input you can fill). If it still refuses, ask the person to do that one
   step, then carry on, rather than looping. Arming the profile to run
   JavaScript is the last resort, for a bounded window, with their yes.
10. **Verify the effect, not the click.** A "Saved" toast or a "Published"
    state means nothing until the result is read back where it lands: the
    record re-opened, the post visible on the page it went to.
11. **Show a page with `browser_open_or_focus`.** When the person should read
    something (a report you generated, a page you changed), it reuses the tab
    already showing it instead of stacking a new one each time.

## Sharing the browser

12. **One driver per browser.** Do not fan browser work out to parallel
    sub-agents: each opens its own tabs, and several of them in one browser is
    chaos for the person watching. Let one session drive, and hand the others
    the text it read.
13. **Clean up what you opened, and only that.** Close the tabs you opened
    when you are done (`read-page` closes its own). Never close a tab the
    person opened unless they asked; `scripts/close-duplicates.mjs` closes
    only exact copies and never the shown, pinned or playing one.
14. **Leave the panic switch alone.** If the person engages it, everything
    stops until they clear it, and there is no tool to clear it. Say what you
    were doing and wait.
15. **Keep `bridge_arm` off every auto-approve list.** Arming lets the agent
    run JavaScript in a signed-in page and upload from the approved folder. The
    approval prompt in front of it is the person's one chance to say no.
