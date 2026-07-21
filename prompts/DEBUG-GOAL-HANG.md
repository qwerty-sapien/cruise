# Debug: `cruise goal` hangs with no output

Self-contained brief. Paste into a fresh session working in the `cruise`
repo (`/Users/agent/Desktop/cruise`). Everything below marked **VERIFIED** was
checked directly in the code/environment; everything marked **HYPOTHESIS** is
not yet proven and is what you are here to establish.

## The symptom

```sh
cruise goal "$(cat prompts/RUN-NEXT-BRIEF.md)"
```

Hangs indefinitely. No stdout, no stderr, no error, no `.cruise/` progress
beyond the ORIGIN note, process never returns. Ctrl-C is the only exit.

## Environment (VERIFIED)

- Repo at `13c1cdc` (v0.3 complete: tasks A–F landed; the v0.3.1 hardening
  specs G–J exist in `prompts/` but have **not** been executed).
- `codex-cli 0.144.6`, macOS, Node ≥20.
- A stale global plugin exists:
  `~/.codex/plugins/cache/agent-local/cruise/0.2.1+codex.20260717`.

## The decisive clue

An earlier invocation of this same command failed **loudly** with:

```
cruise: goal objective must be at most 4000 characters
```

That error originates from the app-server rejecting the `thread/goal/set`
request. Therefore the whole RPC chain — spawn → `initialize` →
`thread/start` → `thread/settings/update` → `thread/goal/set` — **demonstrably
works**. The hang is *after* goal activation succeeds.

(`prompts/RUN-NEXT-BRIEF.md` was written to fit: brief is 2,082 chars, the
launcher's wrapper adds 630, total objective 2,712 of 4,000. So the current
hang is NOT the length error recurring — but re-verify this, don't assume it.)

## Prime hypothesis (HYPOTHESIS — prove or kill this first)

Cruise's goal path **never issues `turn/start`**. It activates the native Goal
and then parks, assuming Codex's app-server spontaneously starts a turn:

- [scripts/lib/simple-session.mjs:307-317](scripts/lib/simple-session.mjs:307) —
  goal branch: `updateGoalMode('plan')` → `waitForNativeGoalTurn()` →
  `activateGoal()` → `await nativeTurn`.
- [scripts/lib/simple-session.mjs:502](scripts/lib/simple-session.mjs:502) —
  `waitForNativeGoalTurn()` returns a **bare deferred promise**. It settles only
  via `settleTurn()`, which fires on `turn/completed` / `turn/failed`
  notifications, and only after `turn/started` has set `this.turnId`
  ([simple-session.mjs:628](scripts/lib/simple-session.mjs:628)).

**If codex 0.144.6 does not auto-spawn a turn on `thread/goal/set`, that promise
never settles and the process hangs forever, silently.** The non-goal path does
not have this problem — it calls `startTurn()` explicitly
([simple-session.mjs:319](scripts/lib/simple-session.mjs:319)).

## Why it is completely invisible (all VERIFIED)

Three independent blind spots stack:

1. **No timeouts anywhere.** `grep -c 'setTimeout' scripts/lib/simple-session.mjs`
   returns **0**. There is no bootstrap deadline, no first-turn deadline.
2. **App-server stderr is swallowed.**
   [scripts/lib/app-server-client.mjs:245](scripts/lib/app-server-client.mjs:245)
   emits a `'stderr'` event, and **nothing in `scripts/` subscribes to it**
   (verified by grep). Any error, warning, or panic codex prints to stderr is
   discarded.
3. **No RPC timeout either.**
   [scripts/lib/app-server-client.mjs:137](scripts/lib/app-server-client.mjs:137)
   `request()` stores a pending entry and resolves only on a matching response.
   An unanswered request also hangs forever — so `thread/settings/update` is a
   second, less likely hang candidate before goal activation.
4. **Output only flows through turn deltas.** `this.output.write(delta)` at
   [simple-session.mjs:624](scripts/lib/simple-session.mjs:624) fires on
   `item/agentMessage/delta`. No turn ⇒ zero bytes ⇒ blank terminal.

## Corroborating prior evidence (VERIFIED)

This is not new. The v0.3 paired pilot hit the same wall:
`evals/results/2026-07-21/raw/codex-v30*-*/metadata.json` shows **all four**
Codex treatment runs with `"timed_out": true`, `"signal": "SIGTERM"`,
`elapsed_seconds: 360`, **0-byte `transcript.log`**, and a worktree containing
only `?? .cruise/`. `evals/results/2026-07-21/FINDINGS.md` records this as
finding P1 ("Codex treatment launcher timed out without captured behavior") and
notes it should be diagnosed only after ruling out plugin contamination.

## Known confound to rule out early

`FINDINGS.md` P1 also records that the globally installed **Cruise 0.2.1** skill
shadowed the v0.3 checkout during the eval, invalidating all four Codex pairs.
That stale plugin is still present on this machine (path above). It may or may
not be implicated in the hang — but any diagnosis made without isolating it is
untrustworthy.

## Suggested diagnostic order (cheap → expensive)

1. **Confirm the hang point.** Add temporary stderr breadcrumbs (or run under a
   debugger / `NODE_OPTIONS`) around each bootstrap step: after spawn, after
   `initialize`, after `thread/start`, after `thread/settings/update`, after
   `thread/goal/set`, and entering `waitForNativeGoalTurn`. Determine exactly
   which await never returns. This single step likely settles the whole question.
2. **Un-swallow app-server stderr.** Subscribe to the client's `'stderr'` event
   in `scripts/cruise.mjs` and print it. Codex may be reporting the real problem
   already.
3. **Log every inbound JSONL frame** (temporarily) to see whether `turn/started`
   ever arrives, or whether some other notification/request is being dropped as
   unsupported — note `handleRequest` replies `-32601` for unknown methods
   ([simple-session.mjs](scripts/lib/simple-session.mjs)), which could stall the
   host if it is waiting on a method Cruise refuses.
4. **Isolate the stale plugin.** Re-run with a sandboxed `CODEX_HOME` containing
   only credentials — no globally installed plugins — and compare.
5. **Test the assumption directly.** Drive `codex app-server` by hand (or via a
   small script) issuing the same sequence, and observe whether
   `thread/goal/set` alone produces a `turn/started`. This is the ground truth
   for the prime hypothesis.
6. **Check whether the objective is actually being rejected again** — print the
   composed objective length before sending.

## If the hypothesis holds

The fix is already specified: **`prompts/I-bootstrap-liveness.md`** (bootstrap
breadcrumbs + a first-turn deadline with diagnostics + a distinct exit code).
It was written for exactly this defect but has not been executed. If the root
cause is instead "codex never auto-starts a goal turn," then I's deadline is
necessary but **not sufficient** — Cruise would also need to issue the first
`turn/start` itself after activating the Goal, which is a design change worth
raising before implementing.

## Constraints

- Non-negotiable philosophy: supervision is evidence-based, bounded, fail-safe;
  a broken supervisor must never trap a session; artifacts stay advisory; no
  approval objects, ledgers, or authority state. Fail-loud never means
  fail-blocking.
- No new runtime dependencies. Match existing style; `node --test`.
- Commit before editing. Do not push.
- Any temporary instrumentation must be removed or converted into the permanent
  breadcrumbs described in Task I before finishing.

## Deliverable

A proven root cause with the evidence that establishes it (which await hangs,
what the host did or did not send), plus either the fix or a clear statement of
the design decision needed. Do not declare it fixed without reproducing the
hang first and then demonstrating the same command completing or failing loudly.
