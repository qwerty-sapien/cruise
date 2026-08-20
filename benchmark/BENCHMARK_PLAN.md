# Cruise token-efficiency benchmark

## Purpose

Measure credit reduction and correctness separately. A cheaper wrong patch fails.

## Two stages

### Stage A: deterministic mock benchmark

No model calls. Replay app-server transcripts and synthetic repository outputs to test usage high-watermarks, cached/reasoning arithmetic, replay handling, context pressure, compaction, quota reservations, routing, output caps, large-file slicing, exclusions, handoff size, and skill-trigger decisions.

### Stage B: small real A/B benchmark

Run only after Stage A passes and the weekly quota guard is active. Use throwaway branches or worktrees. Give baseline and optimized runs the same task, starting commit, acceptance tests, permissions, and external constraints. Do not run baseline Cruise on a full six-hour Goal.

## Representative tasks

- T1: repair one mock app-server notification handler and focused test; expected L3.
- T2: change one deterministic `cell_tracking` utility with one focused pytest target; expected L2 or L3.
- T3: change one bounded booking-support locale or validation path without PII/auth/identity; expected L3.
- T4: change one mock-only check-in domain invariant with focused Vitest; expected L4.
- T5: review a synthetic signing, replay, RLS, holdout, or statistical-semantic diff without production effects; expected L5.

## Metrics

Per model and task capture:

```yaml
root_model:
worker_model:
input_tokens:
cached_input_tokens:
uncached_input_tokens:
output_tokens:
reasoning_output_tokens:
estimated_credits:
rate_limit_used_percent_before:
rate_limit_used_percent_after:
command_raw_bytes:
command_visible_bytes:
unique_files_read:
repeated_file_reads:
full_file_reads_above_64kb:
compactions:
worker_count:
focused_test_outcome:
final_test_outcome:
diff_correctness:
```

## Accounting

Use cumulative high-watermark deltas. Do not sum cumulative snapshots.

```text
uncached = input - cached
credits = uncached * input_rate + cached * cached_rate + output * output_rate
```

Apply per-million scaling. Do not add reasoning output when it is a subset.

## Correctness gates

A run passes only when requested behavior and focused tests pass, relevant invariants hold, no forbidden path changes, no unsupported external claim is made, the final diff matches the task, and final review finds no P0/P1 issue.

## Efficiency gates

- L1-L4 median credits <= 20 percent of baseline.
- L5 median credits <= 33 percent of baseline.
- Filtered command bytes <= 20 percent of raw bytes where filtering applies.
- No full read above 64 KB.
- No injected item above 10,000 estimated tokens.
- Every potential item above 1,000 tokens has a cap and review.
- Worker and root handoffs <= 4 KB.
- Full suite <= 1 per stable diff.
- Four 2.25-point reservations fit the 9-point campaign cap.

## Quality comparison

Blind the final Sol-high reviewer to baseline versus optimized. Give it only the task, starting commit, final diff, tests, invariants, and compact evidence. Score correctness, regression risk, scope control, and maintainability. Efficiency passes only when quality is non-inferior.

## Stop conditions

Stop a real benchmark when the campaign reservation is reached, accounting invariants fail, compaction loses required state, one version changes external state, starting commits/tests diverge, or a high-risk invariant fails.
