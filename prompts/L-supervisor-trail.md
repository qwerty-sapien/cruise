# Task L — Supervisor trail: make Codex-side supervision auditable

## Context

You are working in the `cruise` repository. Cruise supervises long-running
Goals on two paths:

- **Claude:** `hooks/stop-supervisor.mjs` persists its full ladder state to
  `.cruise/.supervisor.json` — flight hash, fingerprint history, failure
  signatures, quiet-stop counts, ladder level, block count, turns
  observed, and an `interventions[]` array with level, timestamp, and
  reason. The v0.3 pilot's liveness diagnostic
  (`evals/results/2026-07-21/diagnostics/claude-liveness/.../supervisor.json`)
  is exactly this file, and it is the only reason the ladder could be
  proven to work.
- **Codex:** `GoalSupervisor` in `scripts/lib/supervisor.mjs` tracks the
  same state in memory, and `SimpleCruiseSession` writes `stallReport(...)`
  to **stderr only**. When the process exits, the entire verdict trail —
  every realignment, every observation, the final report — evaporates.

**The gap and why it matters now:** the upcoming paired study
(`prompts/J-clean-rerun.md`) requires supervision-engagement evidence from
official scored runs, including that the stall case traverses the full
ladder. On the Claude arm that evidence is a file the harness collects. On
the Codex arm it exists only if it happens to land in captured stderr.
This task makes both hosts equally auditable, using one schema.

## Task

1. **Read the hook's writer first and treat its schema as the contract.**
   The Codex path must produce a `.cruise/.supervisor.json` that a single
   reader can parse for either host — same field names, same intervention
   record shape, same version field. Add a `host` field (`"codex"` /
   `"claude"`) so a reader can tell them apart; add it to the hook's
   writer too if absent (this is the one hook edit you are permitted, and
   it must not change hook behavior).
2. **Persist from the Codex loop.** After each supervised continuation
   turn's verdict, write the current supervisor state atomically (write a
   temp file and rename, so a killed process never leaves a torn file).
   Include what the hook includes plus what only the Codex path knows:
   turn ids, and the verdict level returned for that turn.
3. **Persist the terminal report.** When the ladder reaches `stalled`,
   the same `stallReport(...)` text that goes to stderr must also be
   stored in the file (a `final_report` string field) along with the
   pause outcome (paused / pause-failed with reason). The stderr output
   stays exactly as it is — this is an addition, not a redirection.
4. **Keep it liveness scratch, not a ledger.** The file is per-run
   state that replaces itself, gitignored via the existing
   `.cruise/.gitignore` writer, deletable at any time, and carries no
   authority: nothing may read it to decide whether work is permitted.
   Do not accumulate history across runs, do not append run records, do
   not create per-run directories. If the design starts to look like an
   attempt ledger, it has drifted — Cruise deliberately retired that.
5. **One row in `LIMIT_POLICY.md`** if the liveness table does not
   already cover supervisor state persistence; otherwise leave it alone.

## Sequencing note

This task edits the continuation-loop/supervisor region of
`simple-session.mjs`, which Task G (`prompts/G-flight-self-heal.md`) also
owns. **If Task G has not yet run, fold this task into G.** If G has
landed, run normally and make sure corrective-intervention records from G
appear in the trail like any other intervention.

**This task must land before Task J runs**, so the study's Codex arm
produces the same grade of evidence as its Claude arm. It must not land
*during* J — J's no-mid-study-patching rule is absolute.

## Red-team gate (falsification checkpoint)

- **Fail-before:** drive a fake-client session through a full no-progress
  ladder on pre-change code; show that after the process exits, no file
  on disk records that supervision ever ran — the trail exists only in
  captured stderr. Capture that as the demonstrated gap.
- **Pass-after:** the same run leaves `.cruise/.supervisor.json` with two
  interventions (realign, final-experiment), terminal ladder state, the
  final report text, and the pause outcome.
- **Cross-host schema test:** parse the Claude hook's output fixture and
  the Codex writer's output with one reader function and assert both
  satisfy the same shape, differing only in `host` and host-specific
  optional fields. This is what keeps the two writers from drifting.
- Also probe: atomic-write behavior (no torn file if interrupted
  mid-write — simulate by asserting temp-then-rename, not by killing a
  process); a progressing run leaves a trail showing zero interventions
  rather than no file at all; the file never grows unboundedly across a
  long run (cap observation history the way the hook does).

## Files you own

`scripts/lib/supervisor.mjs`, the supervisor-persistence region of
`scripts/lib/simple-session.mjs`, the `host` field addition in
`hooks/stop-supervisor.mjs`, tests,
`docs/checkpoints/v0.3.1/CHECKPOINT-L.md`, one `LIMIT_POLICY.md` row if
needed.

## Files you must not touch

The bootstrap region of `simple-session.mjs` and
`scripts/lib/trace-locator.mjs` (Task K), `skills/**`, `evals/**`,
`scripts/lib/flight-plan.mjs`, hook behavior beyond the `host` field.

## Acceptance criteria

- `npm test` green including the cross-host schema test.
- A stalled Codex run is fully reconstructable from
  `.cruise/.supervisor.json` alone, without stderr.
- No behavior change on the Claude path (assert the hook's existing tests
  still pass unmodified apart from the `host` field).
- The checkpoint artifact states explicitly why this file is liveness
  scratch and not a ledger, and lists every bound on its growth.
