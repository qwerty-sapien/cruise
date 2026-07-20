# Task D — Claude supervisor: plugin hooks for continuation and stall detection

## Context

You are working in the `cruise` repository, a dual-host coding-workflow
plugin. On the Claude Code path, the launcher (`scripts/lib/claude-cli.mjs`)
spawns a native interactive `claude` session with `--plugin-dir` and the
`/cruise:goal` slash command, then walks away — all goal-continuation and
anti-stall policy is prompt obedience. On the Codex path a parallel task is
adding mechanical supervision inside the launcher's turn loop; Claude needs
an equivalent, and the native channel for it is **plugin hooks**.

A prior task (B) added `scripts/lib/flight-plan.mjs` writing
`.cruise/FLIGHT.md`. Relevant contract (the parser preserves unknown keys;
`status` is yours to rely on):

```markdown
---
version: 1
status: active            # active | complete | blocked
outcome: <one line>
verify: [npm test]
scope: { touchpoints: [...], non_goals: [...] }
invariants: [...]
stall: { quiet_turns: 3, same_failure: 3 }
---
```

The goal skill already instructs the agent to write this file at execution
start and to set `status: complete` / `blocked` truthfully at the end.

**Design philosophy (non-negotiable).** Cruise keeps no authority state.
The hook layer is liveness-and-recovery only: it may nudge continuation and
it must fail safe — the escalation ladder ends in *allowing the stop with a
stall report*, never an unbounded block-stop loop. It must never block a
tool call, never gate host approvals, and must be inert in any session that
is not an active cruise goal.

## Before designing anything

Read the current official Claude Code documentation for plugin hooks
(`hooks/hooks.json` inside a plugin, the `Stop` and `PreToolUse` events,
their stdin JSON and stdout decision contracts, `${CLAUDE_PLUGIN_ROOT}`).
Verify the exact field names against the docs — do not code from memory.

## What you are building

### 1. `hooks/hooks.json` + `hooks/stop-supervisor.mjs` (new)

Register a `Stop` hook running the Node script. Behavior on each stop:

- **Activation gate:** read `.cruise/FLIGHT.md` from the session cwd. Inert
  (allow stop, no output) unless it parses, `status` is `active`, and the
  file's mtime is under 48 hours old (staleness guard against leftovers
  from an abandoned run). Re-implement a minimal frontmatter reader inside
  the hook script rather than importing `flight-plan.mjs` — the parallel
  Codex task owns shared supervisor code and you must stay decoupled;
  ~40 duplicated lines are acceptable and marked with a consolidation TODO.
- **Evidence check:** compute a workspace fingerprint (hash of
  `git status --porcelain=v1` + `git diff` + `git diff --cached` via
  `execFile`; treat a non-git cwd as "fingerprint unavailable").
- **State across invocations:** hooks are fresh processes, so keep a small
  scratch file `.cruise/.supervisor.json`: fingerprint history, ladder
  level, a hash of FLIGHT.md frontmatter (reset state when it changes),
  timestamps. Create `.cruise/.gitignore` containing `.supervisor.json`.
  This file is liveness scratch, documented as such, safe to delete at any
  time — it is not run-control authority.
- **Ladder** (thresholds from the flight plan's `stall` block, defaults
  quiet_turns=3, same_failure=3):
  1. Goal active, evidence delta since last stop → block the stop with a
     continuation reason (mirror the tone of the Codex
     `GOAL_CONTINUATION_INSTRUCTIONS`: reconcile against the flight plan,
     implement the next ready micro-goal, verify; routine progression is
     already authorized).
  2. Quiet stops accumulate → at threshold, block once with a
     **realignment** reason: name the observed non-progress, require the
     smallest discriminating experiment or an explicit blocker.
  3. Next quiet stop → block once more with a **final-experiment** reason:
     new evidence this turn, or set `status: blocked` in FLIGHT.md with a
     concrete blocker report.
  4. Next quiet stop → **allow the stop** and emit a stall report (turns
     observed, interventions attempted, suggested human next actions).
  - `status: complete` or `blocked` in FLIGHT.md → always allow the stop
    (this is how the agent legitimately ends a supervised run).
  - Absolute cap: never block more times per ladder cycle than
    quiet_turns + 2, regardless of configuration parsing bugs — hard-code
    this backstop.

### 2. Optional stretch: `PreToolUse` scope-fence advisory

If, after reading the docs, `PreToolUse` supports returning additional
context without blocking: for `Edit`/`Write` targets outside the flight
plan's `scope.touchpoints`, inject a one-line advisory ("outside the
declared scope fence — confirm this is in scope or realign the flight
plan"). Advisory only; never deny the tool call. Skip this entirely if it
cannot be done without blocking semantics.

### 3. Integration

- `.claude-plugin/plugin.json`: register the hooks per the current schema
  if the manifest requires it (verify against docs; `claude plugin
  validate .` must pass).
- `scripts/lib/claude-cli.mjs`: extend `CLAUDE_HOST_INSTRUCTIONS` with one
  sentence: a Stop-hook supervisor may inject continuation or realignment
  instructions during goal runs; respond by changing approach or reporting
  the blocker honestly, never by repeating the failed attempt.
- `skills/goal/SKILL.md`: edit **only the Claude bullet** in "Use the
  selected host natively" — the flight plan's `status` field is the
  completion handshake with the supervisor; keep it truthful.
- `package.json`: add `hooks/` to `files`.

## Files you own

`hooks/` (new), `.claude-plugin/plugin.json`, `scripts/lib/claude-cli.mjs`,
the Claude bullet of `skills/goal/SKILL.md`, `tests/stop-supervisor.test.mjs`
(new), `package.json` (`files` + `test` additions), `.cruise/.gitignore`
creation logic.

## Files you must not touch

`scripts/lib/simple-session.mjs`, `scripts/lib/supervisor.mjs`, the Codex
bullet of `skills/goal/SKILL.md`, `LIMIT_POLICY.md` (a parallel task C owns
all of these), `skills/build/SKILL.md` (Task E). Union `package.json`
`files` on merge.

## Acceptance criteria

- `claude plugin validate .` passes; `npm test` green.
- Hook script is testable without a live Claude session: unit tests feed
  fixture stdin JSON + a temp dir with fixture FLIGHT.md/git states and
  assert the full ladder (continuation → realign → final-experiment →
  allow-with-report), inertness without an active flight plan, staleness
  guard, state reset on flight-plan change, and the hard-coded block cap.
- The hook never writes anything outside `.cruise/`, never blocks
  non-goal sessions, and exits 0 with an allow decision on any internal
  error (fail-open for the user, with the error noted in the report —
  a broken supervisor must never trap a session).
