# Task G — Self-healing flight state: unparseable is loud, absent stays inert

## Context

You are working in the `cruise` repository at v0.3. Supervision exists on
two paths: the Codex launcher's goal continuation loop
(`scripts/lib/simple-session.mjs`, reading flight state via
`scripts/lib/flight-plan.mjs`) and the packaged Claude Stop hook
(`hooks/stop-supervisor.mjs`, which has its own deliberately duplicated
mini-parser and scratch state in `.cruise/.supervisor.json`).

**The proven defect (v0.3 pilot, `evals/results/2026-07-21/`):** every
scored Claude treatment wrote `FLIGHT.md` with semantically correct
content but no YAML frontmatter fences. The parsers returned null, and
both supervisors treat null flight state as "not a supervised run" —
silently inert. The stall-trap case ran with a dead supervisor and nobody
knew. The fix is NOT a looser parser (lenient parsing of LLM prose is
unbounded scope — explicitly rejected). The fix is to make
present-but-invalid flight state a **loud, bounded, self-correcting**
condition while keeping absent flight state exactly as inert as today.

## Pinned canonical template

This exact shape must round-trip through `parseFlightPlan`. If the shipped
`writeFlightPlan` serializer differs in any detail, the serializer is
ground truth — align this template to it and note the deviation:

```markdown
---
version: 1
status: active
outcome: <one line, falsifiable>
verify:
  - <command>
scope:
  touchpoints:
    - <path-or-glob>
  non_goals:
    - "<explicit exclusion>"
invariants:
  - "<protected behavior>"
stall:
  quiet_turns: 3
  same_failure: 3
---
# Flight plan
<prose>
```

## Task

1. **Distinguish the three flight states everywhere flight state is read.**
   Introduce the distinction absent / invalid / valid:
   - `flight-plan.mjs`: add `export async function inspectFlightPlan(cwd)`
     returning `{ state: 'absent' } | { state: 'invalid', reason } |
     { state: 'valid', plan }`. Keep `readFlightPlan` behavior unchanged
     for existing callers. `reason` is a short human-readable parse
     failure (first offending line where determinable).
   - Add `export function flightPlanTemplate()` returning the canonical
     template above as a string.
   - The hook's mini-parser gets the same three-state distinction
     internally (keep the duplication; it is deliberate — the hook must
     run standalone from the packaged plugin. Mark both copies with the
     existing consolidation TODO convention).
2. **Claude Stop hook — corrective intervention.** Today
   `stop-supervisor.mjs` returns null (inert) for unparseable flight
   state. New behavior when state is `invalid` and the file's mtime is
   within the existing freshness window: block the stop once with a
   corrective reason — name the parse failure, state that supervision is
   currently blind because of it, and embed the full canonical template
   with the instruction to rewrite `.cruise/FLIGHT.md` so it parses,
   preserving the intent already written there. Bounds:
   - At most one corrective intervention per flight-file content hash
     (track in the existing scratch state; a rewrite that still fails to
     parse but changes the hash earns exactly one more).
   - Corrective blocks count against the existing hard block cap.
   - If the cap is reached or the same invalid hash is seen again: allow
     the stop and emit a loud report that supervision was inert due to
     invalid flight state, quoting the parse reason.
   - `status` values outside active/complete/blocked and other
     frontmatter-shape violations are `invalid`, not `absent`.
   - Absent file: unchanged, fully inert. Internal errors: unchanged,
     fail-open allow.
3. **Codex continuation loop — same semantics.** In the goal loop in
   `simple-session.mjs` (touch ONLY the continuation-loop region; a
   parallel task owns the bootstrap region around `activateGoal` /
   `waitForNativeGoalTurn`): when `inspectFlightPlan` reports `invalid`,
   inject a corrective continuation turn (same content rules as the hook)
   instead of the standard continuation text, at most once per content
   hash, counting toward the supervisor's existing escalation ladder
   rather than resetting it. Also surface a one-line stderr warning so
   the operator sees supervision is degraded. Absent: unchanged.
4. **Cross-copy consistency tests.** A test must feed
   `flightPlanTemplate()` (with placeholders filled) to BOTH parsers —
   `parseFlightPlan` and the hook's mini-parser — and assert both accept
   it and agree on the parsed fields. This test is what keeps the two
   copies honest.

## Red-team gate (falsification checkpoint — see RUN-NEXT protocol)

Your probe: a fixture reproducing the pilot's actual emission — take the
real fenceless artifact shape from
`evals/results/2026-07-21/raw/claude-v302-y-r1/FLIGHT.md` as the fixture
content. Drive the hook (fixture stdin JSON + temp dir) and a fake-client
session through it.

- **Fail-before:** on pre-change code, the probe must show the hook
  returning inert-null and the session looping with standard continuation
  text — the silent failure, demonstrated.
- **Pass-after:** the same probe must show exactly one corrective
  intervention embedding the template, bounded behavior on repeat, and the
  loud degraded-supervision report at the cap.

Also probe at least: template itself as the file (valid path), empty file,
frontmatter with bad status value, fenced-but-malformed YAML, and a
rewrite-loop simulation (same invalid content re-presented 5×) asserting
the cap holds.

## Files you own

`scripts/lib/flight-plan.mjs`, `hooks/stop-supervisor.mjs`, the
continuation-loop region of `scripts/lib/simple-session.mjs`, their test
files, `docs/checkpoints/v0.3.1/CHECKPOINT-G.md`.

## Files you must not touch

`skills/**` (Task H), the bootstrap region of `simple-session.mjs` and
anything about turn-start deadlines (Task I), `evals/**` (Task J),
`LIMIT_POLICY.md` unless adding one row for the corrective intervention
(allowed).

## Acceptance criteria

- `npm test` green; new tests cover every probe listed above plus the
  cross-parser consistency test.
- Absent-flight behavior is byte-identical to v0.3 (add a regression test
  asserting the hook output for a no-flight session is unchanged).
- No unbounded paths: enumerate in the checkpoint artifact every loop the
  corrective mechanism can enter and its bound.
- The corrective reason text contains the full template and the parse
  failure reason; verify by assertion, not eyeball.
