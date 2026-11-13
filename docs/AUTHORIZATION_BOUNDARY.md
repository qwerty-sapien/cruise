# Authorization and routine operations

Cruise carries the user's intent through execution. In both `relaxed` and
`business-critical` profiles, ordinary subagent delegation, model selection,
approved context sharing, testing, and internal review happen without asking
the user or announcing the agent allocation. Business-critical increases
verification of consequential changes, not permissions for coordination.

User questions must concern an unresolved material consequence or choice.
Prepare the proposed diff and evidence first. Delegation does not expand
scope, grant a worker additional authority, or waive an existing restriction.

The exact question "Shall I allow you to refer this task to another newly
spawned sub-agent?" previously fell through to the user input path. Generic
subagent wording was missing from the classifier, automatic handling was
limited to Goal, and standalone workers forwarded every question to the user.
The shared operational resolver now covers Goal, Quick, Debug, Build, and
standalone worker questions. Mixed batches forward only material questions.

## Native review evidence from 2026-09-12

The reported Backblaze v4 smoke pause came from native automatic approval
review, not a Cruise disclosure gate. The actual tool result at
`2026-09-12T08:53:00.606Z` rejected the escalated worker command before process
creation. Its stated reason was that the prompt contained private source and
that campaign authorization did not cover export to the destination.

The request justification called the smoke "pre-authorized" but did not
present the source, destination, exclusions, and supporting user authorization
together. Whether that omission caused the review decision is unproven.
The same smoke subsequently passed after the user answered the explicit
authorization question. That proves this run resumed; it does not prove a
general fix to native review.

## Why the earlier tests missed it

- Cruise's policy classifier tests covered approved local source and bounded
  workers, and the campaign tests separated source digest drift from consent.
- This task invoked the installed Goal skill directly. It did not run inside
  `SimpleCruiseSession`, so the launcher's recovery logic was not in its path.
- The launcher also treated a matching assistant message as a speculative
  pause without consulting native review events, and could repeat its
  correction indefinitely on terminal blocked Goals.

## Local correction

All four public skills and the launcher's injected policy make routine
delegation silent in both profiles. When an actual effect needs native
approval, existing user authorization is reconciled before requesting it. The
request must describe the action, bounded source payload, destination,
exclusions, and actual user authorization. A skill or generated receipt is
never a substitute for user consent.

The launcher consumes the installed protocol's
`item/autoApprovalReview/completed` notification. A `denied` decision for the
current thread and turn prevents speculative recovery and automatic
authorization answers. Native declined/cancelled approval responses have the
same effect. Duplicate decisions are harmless; other-thread and older-turn
events do not change current authorization state. State resets for each new
turn. An unsupported disclosure pause gets at most one corrective turn per
session, and that correction explicitly requires honoring actual denials.

These changes do not disable, configure, or override native approval review.
Do not retry a rejected operation unchanged or change execution routes to
avoid its decision. Continue unaffected work and use only a host-permitted
evidence review, a materially safer alternative, or the required approval.

## Verification boundary

`tests/authorization-policy.test.mjs` checks the local policy and public skill
contracts. `tests/simple-session.test.mjs` replays mock host review and Goal
events, including denial, approval, duplicates, stale events, and repeated
pauses. Mock sessions also verify all four commands under both profiles with
user-input callbacks that fail if routine delegation reaches them. Worker and
mixed-batch tests verify that only material questions reach the user.
These tests call no real model or external provider. A passing local
suite or matching installed cache must not be reported as proof that native
review will accept future launches. New tasks load refreshed instructions
normally. If an active job detects Cruise source, skill, version, or integrity
drift, it treats that as an exceptional internal recovery event rather than an
authorization or waiver boundary: it compares the bounded non-secret Cruise
diff, preserves unaffected work, selectively reworks only invalidated
Cruise-owned code, and refreshes derived evidence. It neither forces a task
restart nor asks for a waiver solely because the hashes differ.
