# Task E — Build as queue compiler: `.cruise/QUEUE.md` and sequential supervised runs

## Context

You are working in the `cruise` repository, a dual-host coding-workflow
plugin. By now the repo has: five skills (`skills/*/SKILL.md`); a launcher
(`scripts/cruise.mjs`) whose Codex goal loop is supervised
(`scripts/lib/supervisor.mjs` — evidence-based stall detection with a
realign → final-experiment → pause ladder, exit code 3 for `stalled`); a
flight-plan module (`scripts/lib/flight-plan.mjs`) reading/writing
`.cruise/FLIGHT.md` (pinned schema: frontmatter with `status`, `outcome`,
`verify`, `scope.touchpoints`, `scope.non_goals`, `invariants`, `stall`);
and a Claude Stop-hook supervisor (`hooks/`) driven by the same flight
plan. The current `skills/build/SKILL.md` is a 13-line stub.

**Design philosophy (non-negotiable).** Cruise v0.1 had a build-queue
control plane (contracts, milestone ledgers, digests) and it was retired.
The queue you build is the opposite kind of object: one small, advisory,
user-editable markdown file — the compiled output of a clarification
conversation, the input to sequential supervised goal runs. It grants
nothing, gates nothing, and the user can reorder or edit it freely between
(not during) runs.

## What you are building

The user's mental model: build is the bowling setup for a whole project —
clarify the vision once, decompose it into goal-sized milestones, then let
the queue run each milestone as a supervised goal with its own flight plan.

### Pinned contract: `.cruise/QUEUE.md`

```markdown
---
version: 1
milestones:
  - id: M1
    status: pending        # pending | active | complete | blocked | stalled
    outcome: <one line, falsifiable>
    verify: [npm test]
    depends: []            # ids that must be complete first
    touchpoints: [src/parser/]
    non_goals: ["No API redesign"]
    invariants: ["CLI flags unchanged"]
  - id: M2
    ...
---
# Queue

<prose: project vision, per-milestone rationale, cross-milestone
compatibility obligations, sequencing reasoning>
```

### 1. `scripts/lib/queue.mjs` (new)

Same conventions as `flight-plan.mjs` (no dependencies, never throws on
malformed input, unknown keys preserved):

```js
export const QUEUE_FILE = '.cruise/QUEUE.md';
export function parseQueue(text)            // -> { version, milestones[], body, raw } | null
export async function readQueue(cwd)
export async function writeQueue(cwd, queue)
export function nextReadyMilestone(queue)   // first pending whose depends are all complete; null otherwise
export function milestoneToFlightPlan(milestone, queueBody)
// -> flight-plan shape (status: 'active'), carrying the milestone's
//    outcome/verify/touchpoints/non_goals/invariants and a body that cites
//    the queue's cross-milestone compatibility obligations
```

### 2. `skills/build/SKILL.md` rewrite

Keep it compact (about a page) and in the existing frank tone:

- Inspect the repository first; ask only material questions — the ones
  whose answers change the decomposition (product intent, hard
  constraints, compatibility obligations, what must never break).
- Decompose into **goal-sized** milestones: each independently completable
  and verifiable by its own `verify` commands, ordered by real dependency,
  with explicit non-goals so later milestones don't bleed into earlier
  ones (this is the anti-scope-drift mechanism).
- Cross-milestone reconciliation obligations (backward/forward
  compatibility, migration reversibility) are stated once in the queue
  body and inherited by every generated flight plan.
- Write `.cruise/QUEUE.md`; present the queue in conversation for the user
  to adjust; the file is advisory and user-editable. Do not implement
  milestones inside a build conversation — that is what the queue run or
  an explicit goal invocation is for. No approval phrases, no digests.

### 3. Launcher: `cruise queue` command

Extend `scripts/cruise.mjs` (`parseArgs`, `HELP`, `main`):

- `cruise queue status [-C dir]` — print milestones with status/depends.
- `cruise queue run [-C dir]` — loop:
  1. `nextReadyMilestone`; none pending → print summary, exit 0 (or exit 2
     if pending-but-blocked-by-deps remain).
  2. Mark it `active`, write the queue, compile its flight plan via
     `milestoneToFlightPlan` + `writeFlightPlan`.
  3. Run a supervised goal session for the milestone's outcome — reuse the
     existing `runStart` goal path for the selected provider (Codex
     `SimpleCruiseSession`, Claude native session with the Stop-hook
     supervisor); the request text is the milestone outcome plus a pointer
     to the flight plan.
  4. Map the session result back: complete → `complete`, continue to the
     next ready milestone; stalled/blocked/failed → record that status on
     the milestone, stop the queue, print which milestone stopped and why,
     exit 3 (stalled) or 2 (otherwise). Never auto-skip a failed milestone.
- Between milestones is the user-edit window; re-read the queue file fresh
  each iteration so mid-queue edits take effect.
- Structure the runner so tests can inject a fake session runner.

### 4. Docs

Update the README usage section with a build → queue run example and the
command table. (Task F owns the full docs rewrite.)

## Files you own

`scripts/lib/queue.mjs` (new), `tests/queue.test.mjs` (new),
`skills/build/SKILL.md`, `scripts/cruise.mjs` (queue command),
`package.json` (`files` + `test`), README usage section.

## Files you must not touch

`supervisor.mjs`, `simple-session.mjs` internals (consume `runStart`/session
classes as-is; if you need a small seam — e.g. exporting a run-one-goal
helper — add it minimally and say so), `hooks/**`, `flight-plan.mjs`
(public API only), `skills/goal/SKILL.md`, `skills/debug/SKILL.md`.

## Acceptance criteria

- `npm test` green. New tests cover: queue parse/write round-trip,
  `nextReadyMilestone` dependency logic (including cycles → null +
  warning), `milestoneToFlightPlan` field mapping, and a full
  `queue run` orchestration with an injected fake runner exercising the
  complete / stalled / blocked paths and mid-queue file edits.
- `claude plugin validate .` passes; `cruise --help` documents `queue`.
- A queue run touches only `.cruise/QUEUE.md` and `.cruise/FLIGHT.md` —
  no ledgers, archives, digests, or per-milestone directories.
