# Cruise architecture

Cruise declares an execution envelope, then uses observable repository evidence
to keep a Goal inside it. Setup belongs to skills and advisory Markdown;
lifecycle supervision belongs to a thin provider-specific integration. The
selected host remains the only authority for permissions, approvals, models,
tools, and external effects.

```text
                    skills/{lane}/SKILL.md
                              |
                  compile and reconcile intent
                     /                 \
       .cruise/QUEUE.md             .cruise/FLIGHT.md
       ordered milestones           one active envelope
                     \                 /
                      per-host supervision
                     /                     \
          Codex SimpleCruiseSession       Claude Stop hook
          native Goal + app-server        native session + hook event
          pause with stall report         allow with stall report
```

The dependency direction is one-way: skills may create or update the advisory
artifacts; supervision reads their current contents and current workspace
evidence. The artifacts never command the host.

## Intent layer

The five public skills are `build`, `quick`, `refine`, `goal`, and `debug`.
They share outcome-oriented guidance but select different amounts of planning
and autonomy. The optional launcher records its exact request in
`.cruise/ORIGIN.md`; direct plugin invocations do not need that note.

`build` may compile `.cruise/QUEUE.md`. Each milestone has an ID, status,
outcome, verification commands, dependencies, touchpoints, non-goals, and
invariants. The Markdown body carries cross-milestone context. Queue parsing is
fail-safe, and unknown extension fields round-trip without becoming authority.

`goal` maintains `.cruise/FLIGHT.md` with this pinned envelope:

- `version` and `status` (`active`, `complete`, or `blocked`);
- one-line `outcome` and lists of `verify` commands and `invariants`;
- `scope.touchpoints` and `scope.non_goals`;
- positive `stall.quiet_turns` and `stall.same_failure` thresholds;
- a Markdown body for rationale or a concrete blocker report.

The default stall thresholds are three quiet observations and three
same-failure observations. A user may edit the artifact or its tuning during a
run. A missing or malformed flight simply removes this optional supervision
input; it does not invalidate host work or create a hidden state machine.

## Evidence and the supervision ladder

Both supervisors observe a digest of Git status, unstaged diff, and staged diff
when available. They also normalize error-bearing agent text into a failure
signature. New workspace evidence or changed failure evidence resets the
active ladder. An unchanged fingerprint, oscillation to a prior fingerprint,
or repeated failure can trigger:

```text
observe -> realign -> final experiment -> stall report
             ^              |
             +-- new evidence resets to observe
```

The report includes the observation and attempted interventions. It recommends
that the user inspect the last diff/failure, correct stale flight-plan scope or
tuning, provide missing evidence or a material decision, and resume explicitly.

## Codex integration

The terminal launcher defaults to Codex and uses the app-server protocol.
`SimpleCruiseSession` starts in native read-only Plan mode long enough to form a
repository-aware first slice, activates the host's native Goal object, switches
to normal workspace-write execution, and advances Goal turns while that object
remains active.

Between completed continuation turns, the Codex supervisor reads the latest
flight plan and captures a fresh fingerprint. At threshold it injects
realignment guidance; the next non-progress observation gets one final
experiment; the next stalls. Cruise then asks Codex to pause the active Goal,
writes a report to stderr, and returns launcher exit code `3`. Native Goal
`complete` and `blocked` statuses are respected before another continuation is
started. `Ctrl-C` attempts to pause the active Goal and maps to exit `130`.

Codex owns the thread, Goal record, modes, approvals, sandbox, model, tool
requests, and effects. Cruise adds the skill instructions, the advisory flight
plan, automatic answers only for routine Goal progression, and the liveness
check.

## Claude Code integration

Claude is selected per invocation with `--claude`, `--provider claude`, or
`CRUISE_PROVIDER=claude`. Cruise launches the native interactive `claude`
process with the package as a plugin, so Claude retains its TUI, permission
prompts, task tracking, subagents, and resume controls. Claude Code has no
documented Codex-style Goal lifecycle object for a plugin, and Cruise does not
invent one.

For a launcher-started Claude Goal, `runClaudeSession` sets
`CRUISE_CLAUDE_GOAL=1` and activates the packaged `Stop` hook. A direct
`/cruise:goal` invocation inside an existing Claude process cannot set that
process marker; it receives hook supervision only if the process already has
the marker. This prevents a flight left in a repository from continuing an
unrelated Claude session.

The hook considers only a valid, `active` flight newer than 48 hours. Before
threshold it blocks a stop with continuation guidance. It then uses realign and
final-experiment blocks, after which it allows the stop and returns a stall
report as a system message. A hard backstop of `quiet_turns + 2` blocked stops
prevents hook-driven trapping even when other signals do not reach their
threshold.

Hook scratch lives in `.cruise/.supervisor.json` and is ignored through
`.cruise/.gitignore`. It is bounded, derived evidence, not run state or
authority. Missing context, terminal flight status, stale input, parse errors,
filesystem failures, and damaged scratch all allow the stop. The standalone
hook intentionally carries its own small parser/fingerprint implementation so
the packaged plugin does not depend on the launcher process.

Claude owns permissions, stopping, resumption, model selection, tools, and
effects. Cruise adds the skill instructions, flight plan, and fail-open Stop
supervision.

## Queue execution

`cruise queue status` reads and reports the advisory queue. `cruise queue run`
selects the first pending milestone whose dependencies are complete, marks it
active, compiles it to a flight plan, and invokes the same provider Goal path.
After the session, it rereads both artifacts before recording `complete`,
`blocked`, or `stalled`.

Milestones run sequentially. An existing `active`, `blocked`, or `stalled`
milestone stops future selection; a dependency cycle or unresolved dependency
also stops. Between milestones, the user may edit or reorder the queue, and the
runner preserves those edits by rereading the file before writing status.

## Request-scoped provider and worker policy

Provider selection is not persisted. `--codex` and `--claude` are mutually
exclusive; Codex is the fallback. Likewise, worker level is request-scoped.
Codex resolves levels from its live model catalog, while Claude maps levels 1–7
to native model aliases and effort settings. Omitting a level leaves the host's
selection untouched.

## What Cruise deliberately does not do

The retired v0.1 control plane demonstrated that duplicating host authority
creates stale and misleading state. The current system therefore has:

- no approval object or copied approval receipt;
- no permission ledger or capability grant;
- no run archive, workflow database, or controller phase;
- no plan/approval digest handshake;
- no attempt ledger or retry-budget authority;
- no scheduler for concurrent writers;
- no emulated Goal lifecycle for Claude;
- no claim that an artifact, hook, or launcher can override host policy.

`ORIGIN.md`, `QUEUE.md`, `FLIGHT.md`, and Claude's supervisor scratch are local
notes or derived evidence only. Deleting them may remove Cruise context, but it
does not revoke host authority or undo effects already performed.
