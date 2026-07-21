# Task H — Embed the canonical FLIGHT.md template in the goal skill

## Context

You are working in the `cruise` repository at v0.3. The goal skill
(`skills/goal/SKILL.md`, section "Keep an advisory flight plan") tells the
agent WHAT to record in `.cruise/FLIGHT.md` but never shows the pinned
YAML-frontmatter shape. The v0.3 pilot proved the consequence: every
scored Claude treatment emitted semantically correct flight content as
fenceless markdown headings, the strict parser rejected all of them, and
supervision stayed silently inert (see
`evals/results/2026-07-21/FINDINGS.md`, finding P1, and the raw artifact
`evals/results/2026-07-21/raw/claude-v302-y-r1/FLIGHT.md`). The schema
exists only in code and tests — nowhere the emitting model can see it.

A sibling task (G) is making invalid flight state loud and self-correcting
at the supervisor layer. Your task is the belt to that suspender: put the
exact template where the model reads it, so the corrective path is rarely
needed.

## Pinned canonical template

This must be byte-consistent with what G pins and what
`scripts/lib/flight-plan.mjs`'s serializer emits. If the shipped
`writeFlightPlan` output differs, the serializer is ground truth — align
and note the deviation:

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

1. **`skills/goal/SKILL.md`:** in the "Keep an advisory flight plan"
   section, embed the template verbatim in a fenced block with two or
   three tight sentences around it, in the skill's existing frank tone:
   - The file MUST begin with the `---` fence and use exactly this
     frontmatter shape — the supervisor parses it mechanically, and a
     file that does not parse leaves the run unsupervised.
   - After writing it, reread the file and confirm it starts and ends the
     frontmatter with `---` lines; fix it before proceeding if not.
   - One sentence acknowledging supervision: if a supervisor intervention
     reports the flight plan as unparseable, rewrite it to this exact
     shape, preserving the recorded intent.
   Keep the section's existing content (advisory semantics, status
   handshake, reconciliation duties) intact; you are adding the shape,
   not rewriting the policy. The skill must not grow ceremony: no
   approval language, no validation commands the user must run.
2. **Guard against future drift with a static test**
   (`tests/skill-flight-template.test.mjs`): extract the fenced template
   block from `skills/goal/SKILL.md`, substitute the `<placeholder>`
   fields with plausible values, and assert `parseFlightPlan` accepts the
   result and returns the expected field structure. This test makes the
   skill text and the parser contractually inseparable — if either
   drifts, CI fails. Add it to the `test` script.
3. Do NOT edit any other skill. If you notice `skills/build/SKILL.md`
   would benefit from the same treatment for `QUEUE.md`, record that in
   your checkpoint's "Unproven / deferred" section rather than doing it.

## Red-team gate (falsification checkpoint — see RUN-NEXT protocol)

- **Fail-before:** on the pre-change skill, your extraction test must fail
  for the honest reason — there is no template block to extract. Also
  record (from the pilot artifacts, no new runs needed) the concrete
  evidence that models guessed the shape wrong when unshown: cite the
  fenceless raw artifacts.
- **Pass-after:** the extraction test passes; additionally, corrupt the
  in-repo template in a scratch copy (drop the closing `---`) and confirm
  the test catches it — proving the guard actually guards.

## Files you own

`skills/goal/SKILL.md`, `tests/skill-flight-template.test.mjs` (new),
`package.json` (`test` script line only),
`docs/checkpoints/v0.3.1/CHECKPOINT-H.md`.

## Files you must not touch

`scripts/**`, `hooks/**` (Task G and Task I own those), `evals/**`
(Task J), every other skill file.

## Acceptance criteria

- `npm test` green including the new static test.
- `claude plugin validate .` passes.
- The goal skill grows by roughly the template plus a short paragraph —
  if your diff to SKILL.md exceeds ~40 lines, you have over-written;
  trim.
- The template block in the skill, when placeholder-substituted, parses
  to the same structure as `flightPlanTemplate()` from `flight-plan.mjs`
  if that helper exists on your branch (it is added by sibling task G;
  when running serially after G, assert equality; when G has not landed,
  assert against `parseFlightPlan` only and note it for the integration
  gate).
