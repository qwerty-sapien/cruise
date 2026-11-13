# Usage, credits, compaction, and quota

## Token notification semantics

Consume `thread/tokenUsage/updated`.

The payload contains:

- `last`: recent model-call usage;
- `total`: cumulative thread usage;
- `modelContextWindow`: nullable context-window size.

For each thread and token dimension, keep a monotonic high-watermark:

```text
delta = max(new_total - prior_high_watermark, 0)
high_watermark = max(new_total, prior_high_watermark)
```

Do not sum cumulative snapshots. Replayed or lower snapshots contribute zero.

Before applying credit arithmetic, verify:

```text
0 <= cachedInputTokens <= inputTokens
0 <= reasoningOutputTokens <= outputTokens
totalTokens == inputTokens + outputTokens
```

When these invariants fail, persist the raw payload, mark accounting unknown, and use account `usedPercent` as the quota authority.

## Credit table

Default rates current on 2026-08-20, configurable by versioned policy:

| Model | Input | Cached input | Output |
| --- | ---: | ---: | ---: |
| GPT-5.6 Sol | 125 | 12.5 | 750 |
| GPT-5.6 Terra | 50 | 5 | 300 |
| GPT-5.6 Luna | 5 | 0.5 | 30 |

Rates are credits per million tokens.

GPT-6 Astra credit estimates are unavailable until a versioned authoritative Codex-credit rate exists. Until then, account `usedPercent` remains the quota authority for Astra work.

```text
uncached = input - cached

estimated_credits =
  uncached / 1,000,000 * input_rate
  + cached / 1,000,000 * cached_rate
  + output / 1,000,000 * output_rate
```

Reasoning output is reported separately for diagnostics and is not added when it is a subset of output.

## Context pressure

Use the most recent `last.inputTokens` and `modelContextWindow`:

```text
pressure = last.inputTokens / modelContextWindow
```

Defaults:

- warn at 0.30;
- compact at 0.45;
- split or pause at 0.60.

Also compact when all are true:

- at least four root continuation turns occurred since the last compaction;
- the latest input exceeds 96,000 tokens;
- the turn is complete;
- `.cruise/HANDOFF.md` is current.

Do not compact during an active turn.

## Weekly window

Call `account/rateLimits/read` at Goal start, before an expensive turn, after a worker completes, and on rate-limit notifications.

Select the weekly candidate as follows:

1. Gather non-null `primary` and `secondary` windows.
2. Prefer a window with duration closest to 10,080 minutes.
3. Otherwise select the longest window.
4. Record `usedPercent`, `windowDurationMins`, and `resetsAt`.
5. When `resetsAt` changes, close the old epoch and establish a new baseline.

## Shared reservation ledger

Use an account identity hash and reset epoch as the key. Do not store plaintext account email.

Default:

```yaml
campaign_delta_cap_percent: 9.0
goal_reservation_percent: 2.25
safety_margin_percent: 1.0
```

Before starting a Goal or worker:

1. Acquire an atomic file lock.
2. Remove stale process reservations after verifying their owner process is gone.
3. Merge the latest account snapshot.
4. Calculate observed delta from the campaign baseline.
5. Calculate active reservations.
6. Refuse work when observed delta plus reservations would exceed 9.0.
7. Persist the reservation atomically.
8. Release unused reservation on completion, while retaining observed consumption.

Concurrent Cruise processes must share the ledger.

## Strict mode

In strict budget mode:

- no weekly window means no long Goal start;
- a stale rate-limit snapshot must be refreshed;
- an accounting invariant failure blocks local credit claims but does not override `usedPercent`;
- the process pauses before exceeding the cap;
- resume is allowed after reset or an explicit budget change.

Use a dedicated exit code for budget pause. The report must distinguish it from implementation failure.
