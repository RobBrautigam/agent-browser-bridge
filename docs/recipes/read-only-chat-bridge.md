# Recipe: a read-only chat bridge for whitelisted conversations

The bridge gives an agent generic browser tools. This recipe shows how to turn
them into a safe, read-only view of a few chosen conversations in a chat web
app (WhatsApp Web, Slack, Telegram Web, Google Chat), without ever giving the
agent the ability to send, and without it wandering into conversations it was
never meant to see.

The whole recipe is one idea: **the allowlist is the only thing that grants
access, and it is read before any tab is opened.**

## The pieces

1. A browser profile that stays signed into the chat app. Give it its own
   label in the bridge (say `chrome-work`), so the agent addresses it
   explicitly and never by accident.
2. A whitelist file the agent-side skill reads first. Start from
   [examples/chat-whitelist.example.yaml](../../examples/chat-whitelist.example.yaml).
   It ships empty on purpose.
3. A skill or system prompt for the agent that follows the procedure below.
   The bridge does not know what a "chat" is; the skill does.

## The procedure the skill follows

1. Read the whitelist. If the requested conversation is not in it, refuse by
   name and stop. No partial read, no "closest match".
2. `browser_list_profiles`, then `browser_list_tabs` on the whitelisted
   profile only. Find the tab whose URL is the chat app. If it is not open,
   stop and say so; do not `browser_open_tab` to a chat URL, because a URL can
   carry a conversation you did not whitelist.
3. `browser_read_page` with format `snapshot` to find the conversation list.
   Match the title EXACTLY (case-sensitive after trimming) against
   `display_name` or one of its `aliases`. Anything else is a refusal.
4. `browser_click` the matching conversation. This is the one write-tier call
   in the recipe, and it is the equivalent of the human clicking the same row.
5. `browser_read_page` (text) and `browser_scroll` to walk the history. Never
   `browser_fill`, never `browser_press_keys` on the composer, never
   `browser_eval_js`, never `bridge_arm`.
6. Write the record where the whitelist's `destination` says, under the
   agent's own workspace. Apply `business_only` filtering if set.
7. Set `verified_title: true` on the entry after the first successful exact
   match, so a later rename of the chat is noticed rather than silently
   matched to a different one.

## Why the rules are shaped this way

- **Exact title matching.** Fuzzy matching is how an agent opens the wrong
  person's private conversation. The cost of exactness is one edit to the
  whitelist when a contact is renamed; the cost of fuzziness is unbounded.
- **No navigation by URL.** Chat apps encode the conversation in the URL. A
  prompt injection that gets the agent to "just open this link" would bypass
  the list. Clicking the row the list resolved to keeps the list in charge.
- **Read tier only.** The bridge already audits every write, but the right
  number of sends from a read-only skill is zero. The recipe never touches the
  composer, so there is nothing to audit.
- **The bridge is not the enforcement point.** It cannot be: it does not know
  which tab is a chat. The skill is, and the whitelist is its contract. If you
  want a hard technical stop as well, run the chat profile with `bridge_arm`
  never granted (it is off by default) and watch `bridge_status` for any
  write-tier call against that profile that is not a click.

## What this does not protect against

An agent that is compromised badly enough to ignore its own skill can still
click Send with the write tier. If that is in your threat model, do not give
that agent the write tier at all: the bridge has no per-tool permissions today,
so the answer is a separate profile that is never used by that agent.
