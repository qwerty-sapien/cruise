# Task C — Codex loop supervisor: mechanical stall detection in the goal loop

## Context

You are working in the `cruise` repository, a dual-host coding-workflow
plugin. On the Codex path, `scripts/cruise.mjs` → `SimpleCruiseSession`
(`scripts/lib/simple-session.mjs`) drives a native Codex Goal: it activates
the Goal, runs a read-only Plan bootstrap turn, then loops — re-injecting
`GOAL_CONTINUATION_INSTRUCTIONS` while the Goal status stays `active`, and
auto-answering routine gate questions via `automaticGoalProgress`.

**The gap you are closing:** that loop prevents *stall-by-asking* (the agent
stopping for routine approvals) but does nothing about *stall-by-ramming* —
an agent making no progress yet continuing forever. There is no progress
check between turns, no repeated-failure detection, no oscillation
detection. If the Goal never reaches a terminal status the loop re-prompts
indefinitely; the only backstop is Ctrl-C.

A prior task (B) added `scripts/lib/flight-plan.mjs` and the
`.cruise/FLIGHT.md` artifact. Its relevant contract:

```js
import { readFlightPlan, DEFAULT_STALL } from './flight-plan.mjs';
// readFlightPlan(cwd) -> null | { ..., stall: { quietTurns, sameFailure },
//                                 verify: string[], scope: {...}, status }
// DEFAULT_STALL = { quietTurns: 3, sameFailure: 3 }
```

**Design philosophy (non-negotiable).** `LIMIT_POLICY.md` forbids hidden
numeric workload ceilings but explicitly allows a "Liveness and recovery"
class. Your supervisor must be exactly that: evidence-based (it trips on
observed non-progress, never on turn count alone), user-tunable (thresholds
from the flight plan), and fail-safe (the escalation ladder ends in *pause
with a human-readable report*, never an infinite retry loop and never a
silent kill). It is advisory toward the agent and honest toward the user.

## What you are building

### `scripts/lib/supervisor.mjs` (new) — pinned contract

```js
export class GoalSupervisor {
  constructor({ stall = DEFAULT_STALL } = {})
  // Called after every continuation turn.
  recordTurn({ fingerprint, failureSignature })
  // -> { level: 'ok' | 'realign' | 'final-experiment' | 'stall', reason }
}

// Hash of observable workspace evidence: `git status --porcelain=v1` +
// `git diff` + `git diff --cached` (execFile, never shell interpolation).
// Returns null when cwd is not a git repo (signal disabled, never throws).
export async function captureWorkspaceFingerprint(cwd)

// Extract error-ish lines (/\b(error|fail(ed|ure)?|exception|panic|
// traceback)\b/i) from the turn's agent text, normalize (strip digits,
// hex, absolute paths, whitespace runs), hash. Null when no failure text.
export function extractFailureSignature(turnText)
```

Ladder semantics (state machine inside `GoalSupervisor`):

- **Evidence delta observed** (fingerprint changed vs. previous turn and is
  not a repeat of an *earlier* fingerprint) → counters reset, `ok`.
- **Quiet turn** (fingerprint unchanged) or **repeated failure** (same
  signature as previous turns): count separately; when either count reaches
  its threshold → `realign` (returned exactly once).
- Still no evidence delta after the realign turn → `final-experiment`
  (returned exactly once).
- Still nothing → `stall`.
- **Oscillation** (fingerprint equals an earlier-seen value with different
  values in between, e.g. edit-then-revert cycles) counts as a quiet turn,
  and the `reason` names it.
- `reason` strings are specific and human-readable: what was observed, how
  many times, which signature (truncated).

### Wiring in `simple-session.mjs`

1. Buffer each turn's agent-message text (the `item/agentMessage/delta`
   notifications), capped at ~64 KB per turn, reset per turn.
2. In the `while (this.skill === 'goal')` loop, after each completed
   continuation turn: capture the fingerprint, extract the failure
   signature, call `recordTurn`. Read stall thresholds lazily each
   iteration via `readFlightPlan(this.cwd)` (the user may edit mid-run;
   absent file → `DEFAULT_STALL`).
3. Act on the verdict by *changing the injected instructions*, not by
   silently killing anything:
   - `realign` → instead of the standard continuation text, inject a
     realignment instruction: name the observed repetition verbatim from
     `reason`, state that repeating the same approach is not authorized
     progress, and require either the smallest discriminating experiment
     that yields new evidence or an explicit statement of the blocker.
   - `final-experiment` → inject: produce new evidence this turn or set the
     Goal to blocked yourself with a concrete blocker report; this is the
     last supervised continuation.
   - `stall` → call the existing `pauseActiveGoal()`, print a stall report
     to the user (turns observed, fingerprints/signatures involved, the two
     interventions already attempted, suggested next human actions), and
     return a result with `status: 'stalled'`.
4. `runStart` in `scripts/cruise.mjs`: map `stalled` to exit code 3
   (0 complete, 2 other non-complete, 130 interrupted stay as-is). Update
   the `HELP` text with one line about supervised goal runs.

### Documentation

- `LIMIT_POLICY.md`: add the supervisor to the "Liveness and recovery"
  table — evidence-based trip conditions, user-tunable via flight plan,
  terminates in pause-with-report.
- `skills/goal/SKILL.md`: edit **only the Codex bullet** in "Use the
  selected host natively": one or two sentences that supervised realignment
  turns are normal and must be answered with a changed approach or an
  honest blocker, never a re-run of the same failing attempt.

## Files you own

`scripts/lib/supervisor.mjs` (new), `tests/supervisor.test.mjs` (new),
loop mechanics in `scripts/lib/simple-session.mjs`, `scripts/cruise.mjs`
(exit code + HELP), `LIMIT_POLICY.md`, the Codex bullet of
`skills/goal/SKILL.md`, `package.json` (`files` + `test` additions).

## Files you must not touch

`hooks/**` and the Claude bullet of `skills/goal/SKILL.md` (a parallel task
D owns those), `skills/build/SKILL.md` (Task E), `flight-plan.mjs` (extend
via its public API only), `claude-cli.mjs`. A parallel task also edits
`package.json` `files`; union on merge.

## Acceptance criteria

- `npm test` green. New unit tests cover: verdict sequences (progress →
  ok; N quiet → realign → final-experiment → stall; recovery resets;
  oscillation detection; repeated-failure path independent of fingerprint
  path), fingerprint null outside git repos, signature normalization
  (same error with different line numbers/paths → same hash).
- Integration test drives `SimpleCruiseSession` with a fake client through
  a no-progress sequence and asserts: realignment text injected, then
  final-experiment text, then Goal paused + `status: 'stalled'` + report
  written to the error output stream.
- A progressing goal run's behavior is byte-identical to today's
  (supervision must be invisible when there is progress).
- No shell string interpolation; `execFile` only; a non-git cwd degrades
  gracefully to signature-only supervision.
