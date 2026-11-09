---
name: context-economy
description: Internal Cruise policy for bounded repository retrieval, compact handoffs, model-level routing, safe compaction, output control, and weekly quota enforcement. The Cruise launcher must apply it to every build, quick, goal, debug, and worker run. It preserves a Sol-high coordinator and routes bounded execution to the lowest safe worker level.
---

# Context economy

## Purpose

Preserve reasoning and verification quality while reducing model-visible context and aggregate credit use. Root quality remains Sol high. Bulk retrieval, routine edits, and focused verification move to fresh bounded workers selected by risk and complexity.

This policy is part of execution, not optional advice.

Read only the reference needed for the current action:

- `references/ROUTING.md` for model and effort selection.
- `references/RETRIEVAL.md` for repository navigation and read-more decisions.
- `references/USAGE_ACCOUNTING.md` for token, credit, compaction, and quota rules.
- `references/HANDOFF.md` when creating or consuming a worker capsule.
- `references/SKILL_TRIGGERS.md` when deciding whether a broad scientific, DAG, environment, release, novelty, or privacy skill applies.
- `references/COLLABORATIVE_GIT_SYNC.md` before substantive repository work; the root coordinator runs its collaborator-triggered fetch, preview, and integration protocol.

## Non-negotiable invariants

1. The root coordinator starts explicitly on GPT-5.6 Sol with high reasoning.
2. The root coordinates, synthesizes, integrates, and performs final review. It does not perform bulk repository scanning.
3. Every substantive worker starts in a fresh ephemeral thread with an explicit level, model, effort, task capsule, context cap, ownership boundary, and completion criterion.
4. No command or file output enters model context without a hard byte cap.
5. No individual injected item may exceed 10,000 estimated tokens. Any item that can exceed 1,000 estimated tokens requires explicit review and a reason.
6. Files larger than 64 KB are read only by named range, symbol, schema, header, sample, or deterministic summary.
7. Binary, generated, vendor, dependency, archive, log, model-weight, and dataset paths are excluded unless the task names them and a compact extractor is used.
8. Hypotheses remain provisional. Record evidence for and against them. One contradictory fact lowers confidence and triggers a discriminating check.
9. Discovery stops once ownership, invariant, change surface, and a discriminating verification command are known.
10. A full test suite runs at most once per stable final diff unless new evidence invalidates it.
11. Tool, environment, permission, transport, and dependency failures do not justify a model escalation.
12. Escalation applies to the narrow blocked work item. Other work remains at its current or lower level.
13. The weekly quota guard is authoritative. Budget pause is a successful containment outcome, not a failure.
14. Detailed evidence remains in workspace files. Model handoffs contain concise facts and pointers.

## Operating loop

### 1. Meter before work

Read the current account rate-limit snapshot and initialize per-thread token accounting. In strict budget mode, do not start an unmetered long Goal.

Record:

- account identity hash;
- rate-limit windows and reset times;
- weekly-window baseline used percentage;
- campaign and Goal reservations;
- model and effort;
- token high-watermarks.

### 2. Build a bounded map

Use deterministic tooling before model inspection:

- applicable `AGENTS.md` chain;
- concise current-state pointer;
- `git status --short`;
- changed-path list;
- capped tracked-file map;
- package manifests and exact entry points;
- exact symbol or string searches.

Do not print the full repository tree.

Use `node scripts/context-view.mjs <command>` for deterministic retrieval. The commands are `map`, `search`, `slice`, `symbols`, `json-summary`, `table-summary`, `log-summary`, and `changed`. They use tracked-file enumeration, repository exclusions, bounded visible output, raw artifacts, source digests, and content-keyed caching. RTK is optional and never required for correctness.

Start with an 80-line window. Expand only to complete a definition or caller, inspect governing configuration, resolve a test contradiction, or verify an invariant. Stop after six windows, summarize, and replan before another discovery round.

### 3. Form competing hypotheses

For a bug or ambiguous change, retain up to three candidates:

```yaml
hypotheses:
  - id: H1
    claim:
    evidence_for:
    evidence_against:
    confidence: low
    next_discriminating_check:
```

High confidence requires direct code evidence plus behavior, test, configuration, or interface evidence. A plausible snippet alone is insufficient.

### 4. Choose the worker level

Use `references/ROUTING.md`. High consequence sets a minimum level. Complexity sets the normal level. Use the higher of the two.

### 5. Dispatch a capsule

For every ready Goal micro-goal, use `cruise worker --managed --complexity <class> --owns <path> --evidence <fact> --range <path:start-end> --verify <command> <task>`. Cruise applies consequence floors automatically. Pass `--level <1-7>` only as a stronger explicit override; it cannot lower the routed floor, and L7 also requires `--exceptional-consequence` plus `--exceptional-rationale`. The root writes the capsule before quota reservation, remains the integrator and final reviewer, and consumes the worker's schema-constrained `.cruise/HANDOFF.md`. A Goal may have at most three active workers. Debug begins with at most three evidence-distinct probes and needs confirmed evidence before another wave.

The capsule must be at most 8 KB and contain:

- exact task and non-goals;
- current evidence;
- relevant files, symbols, and bounded ranges;
- protected invariants;
- expected edit ownership;
- focused verification;
- remaining uncertainty;
- stop and escalation conditions;
- model-visible output cap.

Workers may search outside the initial paths only after stating what uncertainty requires it. They return a handoff of at most 4 KB.

### 6. Integrate and verify

The root inspects:

- the compact worker handoff;
- changed-file list;
- bounded diff summary;
- focused test result;
- unresolved risks.

Open full diff hunks only where the handoff or test indicates risk. Run affected-surface checks next. Run the full suite only at a stable final diff or for a genuine high-risk release boundary.

### 6a. Attest stable surfaces

Keep `.cruise/FLIGHT.md` below 8 KB. Give every gate an affected surface and keep detailed evidence behind a compact digest and pointer. Record focused evidence after a stable micro-goal. At the stable final diff, run one deterministic attestation and one independent semantic review for L5+ work. Later edits invalidate only gates whose surfaces changed; intent and final-review gates may remain whole-diff. Never weaken waivers, scientific controls, privacy controls, or fail-closed completion to save context.

### 7. Compact at safe boundaries

After a turn completes:

1. Write or refresh `.cruise/HANDOFF.md`.
2. Persist token and rate-limit state.
3. If context pressure crosses the configured threshold, call `thread/compact/start`.
4. Wait for the compaction item to complete.
5. Do not count compaction as implementation progress or a failed attempt.
6. On the next request, verify that context pressure fell.
7. If pressure stays high, dispatch fresh workers and keep the root turn minimal.

### 8. Stop on budget

Before every new turn and worker spawn:

- merge the latest rate-limit snapshot;
- acquire the shared ledger lock;
- compare observed weekly delta plus active reservations with the campaign cap;
- refuse or pause work that would exceed the reservation;
- write a resumable budget report with completed work, pending work, reset time, and exact resume command.

## Default caps

```yaml
root_model: gpt-5.6-sol
root_reasoning: high
campaign_weekly_delta_cap_percent: 9.0
default_goal_reservation_percent: 2.25
max_active_workers: 3
repo_map_visible_bytes: 12288
command_visible_bytes: 12288
file_window_lines: 160
file_window_bytes: 16384
max_windows_per_discovery_round: 6
worker_capsule_bytes: 8192
worker_handoff_bytes: 4096
flight_bytes: 8192
large_file_bytes: 65536
context_warn_ratio: 0.30
context_compact_ratio: 0.45
context_split_ratio: 0.60
```

All caps are configurable downward. Raising them requires a recorded task-specific reason.

## Completion report

Return only:

- outcome;
- changed files;
- focused and final verification;
- unresolved risk or blocker;
- root and worker model levels;
- input, cached input, output, and estimated credits by model;
- weekly used-percent delta;
- compaction count;
- link or path to detailed evidence.

Do not restate the full plan or paste full files.
