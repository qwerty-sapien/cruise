# Task B — Flight plan: compile intent into `.cruise/FLIGHT.md`

## Context

You are working in the `cruise` repository, a dual-host coding-workflow
plugin for Codex and Claude Code. Five prompt-only skills live in
`skills/*/SKILL.md`; an optional launcher (`scripts/cruise.mjs`) drives a
Codex app-server session (`scripts/lib/simple-session.mjs`) or spawns a
native `claude` session (`scripts/lib/claude-cli.mjs`). Today Cruise
persists exactly one file, `.cruise/ORIGIN.md` — the verbatim user request
(`scripts/lib/origin-note.mjs`).

**Design philosophy (non-negotiable).** Cruise v0.1 was a state-owning
control plane (YAML contracts, queues, approval digests, ledgers) and was
deliberately retired; the prohibitions in the skill files are its
postmortem. The flight plan must NOT recreate it. `FLIGHT.md` is compiled
per-run intent: small, advisory, user-editable, regenerated each run. It is
never an approval object, never an authority, never a ledger. The host's
native permissions remain the only authority for work and effects.

## What you are building

`goal` runs (and later `build` queues — out of scope here) begin with a
clarification pass. Its output should be written down once as a **flight
plan** the rest of the run can reconcile against: outcome, scope fence,
invariants, acceptance evidence, and stall tuning. Downstream tasks (a Codex
loop supervisor and a Claude Stop-hook supervisor) will read this file to
detect scope drift and unproductive loops, so the schema below is a pinned
contract — implement it exactly.

### Pinned contract: `.cruise/FLIGHT.md`

YAML frontmatter + markdown body:

```markdown
---
version: 1
status: active            # active | complete | blocked
outcome: <one line, falsifiable>
verify:
  - npm test              # commands whose exit codes define acceptance
scope:
  touchpoints:            # paths/globs expected to change
    - src/parser/
  non_goals:
    - "No public API redesign"
invariants:               # protected behavior / compat obligations
  - "Existing CLI flags keep their behavior"
stall:
  quiet_turns: 3          # consecutive no-evidence turns before realignment
  same_failure: 3         # identical failure signatures before realignment
---
# Flight plan

<prose: the outcome, why the scope fence sits where it does, the
compatibility/reconciliation obligations, how acceptance is evidenced,
open questions>
```

Parser rules: a missing file yields `null`; malformed frontmatter yields
`null` (never throw — a broken advisory file must never break a run);
unknown frontmatter keys are preserved on read and round-tripped on write
(downstream tasks extend the schema); every field is optional with defaults.

### Pinned contract: `scripts/lib/flight-plan.mjs`

```js
export const FLIGHT_FILE = '.cruise/FLIGHT.md';
export const DEFAULT_STALL = Object.freeze({ quietTurns: 3, sameFailure: 3 });

// Pure. Returns the parsed shape below, or null for missing/unparseable text.
export function parseFlightPlan(text)
// -> { version, status, outcome, verify: string[],
//      scope: { touchpoints: string[], nonGoals: string[] },
//      invariants: string[], stall: { quietTurns, sameFailure },
//      body: string, raw: object }

export async function readFlightPlan(cwd)          // null if absent/invalid
export async function writeFlightPlan(cwd, plan)   // creates .cruise/, serializes
```

Implement YAML handling with no new runtime dependencies (the repo is
dependency-free; a small hand-rolled parser for this restricted subset is
fine and preferred — mirror the style of `origin-note.mjs`).

## Task

1. Implement `scripts/lib/flight-plan.mjs` per the contract, with tests in
   `tests/flight-plan.test.mjs` (round-trip, defaults, malformed input →
   null, unknown-key preservation). Add the test to `package.json`'s `test`
   script and the module to the `files` array.
2. **`skills/goal/SKILL.md`:** add a compact section instructing the agent
   to compile the flight plan. Key behaviors, written in the skill's
   existing frank tone:
   - During the initial codebase inspection, resolve outcome, scope fence,
     invariants, and acceptance evidence; then write `.cruise/FLIGHT.md`
     **as the first act of execution mode** (on Codex the bootstrap Plan
     turn is read-only and cannot write it; do not fight that).
   - Each micro-goal iteration's reconcile step checks the flight plan:
     work outside `touchpoints`/`non_goals` means stop and realign or ask;
     invariants are re-verified when touched.
   - On completion, set `status: complete`; on a concrete blocker,
     `status: blocked` with the blocker stated in the body.
   - The flight plan is an advisory note the user may edit at any time; it
     grants nothing and gates nothing. Keep `ORIGIN.md` semantics unchanged.
3. **`scripts/lib/simple-session.mjs`:** extend the instruction strings
   (`AUTONOMOUS_GOAL_INSTRUCTIONS`, `GOAL_BOOTSTRAP_INSTRUCTIONS`,
   `GOAL_CONTINUATION_INSTRUCTIONS`) to reference the flight plan: write it
   as the first execution act; reconcile each micro-goal against it;
   maintain its `status` field truthfully. Touch only the instruction
   strings — do not modify the loop mechanics (Task C owns those).
4. **`scripts/lib/claude-cli.mjs`:** extend `CLAUDE_HOST_INSTRUCTIONS`
   equivalently for the Claude path.
5. Update the flight-plan paragraph of `README.md` (one short section; Task
   F owns the full rewrite).

## Files you own

`scripts/lib/flight-plan.mjs` (new), `tests/flight-plan.test.mjs` (new),
`skills/goal/SKILL.md`, instruction strings in
`scripts/lib/simple-session.mjs` and `scripts/lib/claude-cli.mjs`,
`package.json` (`files` + `test` additions), one README section.

## Files you must not touch

The `SimpleCruiseSession` loop/supervision mechanics (Task C), anything
under `hooks/` (Task D), `skills/build/SKILL.md` (Task E),
`LIMIT_POLICY.md` (Task C). A parallel hygiene task also edits
`package.json`; a merge conflict in `files` is expected — union the lists.

## Acceptance criteria

- `npm test` green, including the new suite.
- `claude plugin validate .` passes.
- `parseFlightPlan` never throws on arbitrary text (add a fuzz-ish test
  with a few pathological inputs).
- Skill text stays compact — the goal skill should grow by well under a
  page; no ceremony, no approval language, no new required user steps.
