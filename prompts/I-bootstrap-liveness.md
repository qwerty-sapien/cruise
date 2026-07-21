# Task I — Bootstrap liveness: the Codex launcher must never hang silently

## Context

You are working in the `cruise` repository at v0.3. On the Codex path,
`scripts/cruise.mjs` → `SimpleCruiseSession.run()` in
`scripts/lib/simple-session.mjs` activates a native Goal and then awaits
`waitForNativeGoalTurn()` — a bare deferred promise resolved only by
`turn/started` / `turn/completed` notifications. There is no deadline
anywhere in the file.

**The proven defect (v0.3 pilot, `evals/results/2026-07-21/`):** all four
Codex treatment runs hung ~360 seconds with completely empty transcripts
until the harness sent SIGTERM (`raw/codex-v30*-x|y-r1/metadata.json`,
`timed_out: true`, empty `transcript.log`, only `?? .cruise/` in the
worktree). Whatever the trigger (stale-plugin contamination is suspected
but unproven), the launcher's response — wait forever, print nothing — is
Cruise's own liveness defect and violates the repo's `LIMIT_POLICY.md`
liveness class ("prevent a dead child … from hanging the coordinator").
The supervisor added in v0.3 watches continuation turns; nothing watches
the bootstrap that precedes the first turn.

## Task

1. **Bootstrap breadcrumbs.** During goal startup, emit one-line stderr
   notes at each milestone: app-server started, thread started (with
   model), Goal activated, waiting for the native Goal turn. Terse,
   prefixed consistently (match the existing `Cruise warning:` style,
   e.g. `Cruise: goal activated; waiting for the native turn.`). An empty
   transcript must become an impossible observation for a launcher that
   got this far.
2. **First-turn deadline.** Give `waitForNativeGoalTurn` a configurable
   deadline (default 120 seconds; constant near the top of the file). If
   no `turn/started` for this thread arrives in time:
   - Gather diagnostics cheaply: current Goal status via
     `thread/goal/get`, thread id, model, elapsed time.
   - Attempt the existing `pauseActiveGoal()` so no orphaned active Goal
     is left behind (best-effort, swallow errors as the interrupt path
     does).
   - Fail loudly: a dedicated error naming the condition ("Codex never
     started the native Goal turn within 120s") plus the diagnostics,
     exiting through the existing error path with a distinct exit code
     (pick the next free code after the existing 0/2/3/130 map in
     `cruise.mjs`; update `HELP` and the README exit-code table row).
   - The deadline must be cancelled the moment the turn starts — a
     healthy run's behavior and output stay byte-identical apart from the
     breadcrumbs.
3. **Scope discipline.** Touch ONLY the bootstrap region: `run()` up to
   the first `result = await nativeTurn`, `activateGoal`,
   `waitForNativeGoalTurn`, plus the small exit-code/HELP edits in
   `cruise.mjs`. A sibling task (G) owns the continuation-loop region of
   the same file; do not modify it. Do not add deadlines to continuation
   turns — the evidence-based supervisor governs those, and a wall-clock
   ceiling there would violate the limit policy. Bootstrap is different:
   before the first turn there is no evidence stream to supervise, so a
   liveness deadline is the only available signal, which is why it is
   allowed.
4. **`LIMIT_POLICY.md`:** add one row to the liveness table for the
   bootstrap deadline (named source, fixed default, loud failure,
   cancellation preserved).

## Red-team gate (falsification checkpoint — see RUN-NEXT protocol)

Your probe: a fake app-server client (the existing test fakes are the
model) that acknowledges `thread/start` and `thread/goal/set` but never
emits `turn/started`. Use a short test-injected deadline (e.g. 200 ms).

- **Fail-before:** on pre-change code, the probe must demonstrate the
  silent hang — the session promise still pending after the deadline
  window with zero output written (bound the test with its own timer;
  assert the launcher produced nothing and never returned).
- **Pass-after:** the same probe must show breadcrumbs on stderr, the
  deadline firing, `pauseActiveGoal` attempted, the diagnostic error
  raised, and the new exit code propagated through `runStart`.

Also probe: turn starts just before the deadline (no error, timer
cancelled, no stray unhandled rejection — assert with an unhandled
rejection listener); turn starts and the run proceeds normally
(byte-identical output apart from breadcrumbs — regression-compare
against a captured pre-change happy-path transcript).

## Files you own

Bootstrap region of `scripts/lib/simple-session.mjs`,
`scripts/cruise.mjs` (exit code + HELP), `LIMIT_POLICY.md` (one row),
their tests, `docs/checkpoints/v0.3.1/CHECKPOINT-I.md`, the README
exit-code table row.

## Files you must not touch

The continuation-loop/supervisor region of `simple-session.mjs` and
`scripts/lib/supervisor.mjs` (Task G), `skills/**` (Task H), `hooks/**`,
`evals/**` (Task J), `scripts/lib/flight-plan.mjs`.

## Acceptance criteria

- `npm test` green; probes above are permanent tests.
- Happy-path goal runs are unchanged except stderr breadcrumbs (asserted,
  not eyeballed).
- No timer leaks: the deadline is cleared on turn start, interrupt, and
  error paths (assert the process/test exits promptly with no open
  handles).
- The failure message names the observed condition and the diagnostics —
  never a speculative cause (no "DNS", no "retry with a fresh run"; the
  skill files' prohibition on invented failure narratives applies to the
  launcher too).
