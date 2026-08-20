# Cruise token-efficiency benchmark

## Purpose

Measure credit reduction and correctness separately. A cheaper wrong patch fails.

## Two stages

### Stage A: deterministic mock benchmark

No model calls.

Replay app-server transcripts and synthetic repository outputs to test:

- usage high-watermarks;
- cached and reasoning subset arithmetic;
- duplicate and replayed events;
- context pressure;
- manual compaction lifecycle;
- rate-limit windows and resets;
- shared reservations;
- worker routing;
- output caps;
- large-file slicing;
- repository exclusions;
- handoff size;
- skill-trigger decisions.

### Stage B: small real A/B benchmark

Run only after Stage A passes and the weekly quota guard is active.

Use throwaway branches or worktrees. Give baseline and optimized runs the same task, starting commit, acceptance tests, permissions, and external constraints. Do not run baseline Cruise on a full six-hour Goal.

## Representative tasks

### T1: Cruise protocol event

Add or repair one mock app-server notification handler and its focused test.

Expected level: L3.

### T2: cell_tracking local utility

Change one argument-validation or deterministic parsing behavior in `src/` or `scripts/`, with one focused pytest target. Exclude reports, assets, predictions, and campaign history.

Expected level: L2 or L3.

### T3: booking support local behavior

Change one bounded support route, locale resource, or validation path with a focused test. Do not touch PII, auth, or identity.

Expected level: L3.

### T4: check-in local domain behavior

Change one mock-only domain invariant with a focused Vitest target. Do not touch external activation.

Expected level: L4.

### T5: high-risk review fixture

Review a synthetic signing, replay, RLS, holdout, or statistical-semantic diff without applying production effects.

Expected level: L5.

## Metrics

Per model and task:

```yaml
input_tokens:
cached_input_tokens:
uncached_input_tokens:
output_tokens:
reasoning_output_tokens:
estimated_credits:
rate_limit_used_percent_before:
rate_limit_used_percent_after:
root_turns:
worker_turns:
worker_levels:
compactions:
command_raw_bytes:
command_visible_bytes:
unique_files_read:
repeat_file_reads:
full_reads_above_64kb:
largest_injected_item_tokens:
focused_tests:
full_suite_runs:
correctness:
invariant_failures:
duration_seconds:
```

## Accounting

Use cumulative high-watermark deltas. Do not sum cumulative snapshots.

```text
uncached = input - cached
credits = uncached * input_rate + cached * cached_rate + output * output_rate
```

Apply per-million scaling. Do not add reasoning output when it is a subset.

## Correctness gates

A run passes only when:

- requested behavior is satisfied;
- focused test passes;
- relevant protected invariants pass;
- no forbidden path changed;
- no unsupported external claim is made;
- final diff matches the task;
- final reviewer finds no P0 or P1 issue.

## Efficiency gates

- L1-L4 median credits <= 20 percent of baseline.
- L5 median credits <= 33 percent of baseline.
- command visible bytes <= 20 percent of raw bytes for noisy commands where filtering applies;
- no full read above 64 KB;
- no injected item above 10,000 estimated tokens;
- every potential item above 1,000 tokens has a cap and review;
- worker handoff <= 4 KB;
- root handoff <= 4 KB;
- full suite <= 1 per stable diff;
- no quota reservation overrun.

## Quality comparison

Blind the final Sol-high reviewer to which run was baseline. Give it only:

- task;
- starting commit;
- final diff;
- tests;
- invariants;
- compact evidence.

Score correctness, regression risk, scope control, and maintainability. Efficiency passes only when quality is non-inferior.

## Stop conditions

Stop the real benchmark when:

- campaign weekly delta reaches its reservation;
- app-server accounting invariants fail;
- compaction loses required state;
- one version changes external state;
- starting commits or acceptance tests diverge;
- a high-risk invariant fails.
