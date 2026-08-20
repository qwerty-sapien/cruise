# Audit: Why Cruise Exhausts Codex Limits

## 1. Scope and evidence

Uploaded snapshots inspected:

| Item | Files | Approximate bytes |
| --- | ---: | ---: |
| Cruise | 57 | 520,042 |
| General skill bundle | 26 | 275,546 |
| Auto-experiment skill | 7 | 67,593 |
| cell_tracking | 1,254 | 57,449,232 |
| booking-support-site | 1,126 | 32,973,838 |
| check-in | 792 | 3,305,324 |

`window` and `hotel_locker` were absent from the uploaded archives and were inspected through the connected GitHub repositories.

External product facts were checked against the OpenAI Codex rate card and the current `openai/codex` app-server documentation on 2026-08-20. RTK behavior was checked against the current `rtk-ai/rtk` documentation.

## 2. Quantitative diagnosis

### 2.1 Sol credit arithmetic

Current GPT-5.6 Sol rates per million tokens:

- Uncached input: 125 credits.
- Cached input: 12.5 credits.
- Output: 750 credits.

Assuming `inputTokens` includes its cached subset, the input-credit formula is:

```text
uncached_input = max(inputTokens - cachedInputTokens, 0)

credits =
  uncached_input / 1,000,000 * 125
  + cachedInputTokens / 1,000,000 * 12.5
  + outputTokens / 1,000,000 * 750
```

Do not add reasoning output again when `reasoningOutputTokens <= outputTokens` and `totalTokens == inputTokens + outputTokens`. Treat an invariant violation as unknown accounting rather than silently double-counting.

For 1.5 billion input tokens:

```text
99 percent cache:
  15M uncached * 125 = 1,875
  1,485M cached * 12.5 = 18,562.5
  input total = 20,437.5 credits

98 percent cache:
  30M uncached * 125 = 3,750
  1,470M cached * 12.5 = 18,375
  input total = 22,125 credits
```

This excludes output. One million Sol output tokens costs another 750 credits.

### 2.2 Per-prompt scale

At 1.5 billion input tokens over 20 to 30 prompts:

- 20 prompts: 75 million input tokens per prompt.
- 30 prompts: 50 million input tokens per prompt.

That scale is consistent with repeated cumulative context across many model calls within each visible prompt. One user prompt can cause planning, tool-use, continuation, verification, review, and subagent calls.

### 2.3 Telemetry may overstate the raw token total

Codex app-server emits:

- `tokenUsage.last`: the most recent model call.
- `tokenUsage.total`: a cumulative thread snapshot.
- `cachedInputTokens`: normally a subset of input.
- `reasoningOutputTokens`: normally a subset of output.

A collector must:

1. Key usage by account, thread, and reset epoch.
2. Keep a cumulative high-watermark for every token dimension.
3. Add only positive movement beyond the prior high-watermark.
4. Ignore replayed, duplicate, or lower snapshots.
5. Never sum all cumulative notifications.
6. Never add cached input on top of total input.
7. Never add reasoning output on top of output when the schema invariants show it is a subset.

Your weekly-limit exhaustion is real, but the reported 1.5 billion figure should be revalidated after this correction.

## 3. Cruise findings

### P0: Durable root history grows without explicit compaction

In `scripts/lib/simple-session.mjs`, Cruise starts one thread with `ephemeral: false` and repeatedly starts continuation turns while the native Goal remains active. The snapshot contains no invocation of `thread/compact/start`.

Current Codex app-server supports manual compaction and streams a `contextCompaction` item while it runs. Cruise has a safe place to call it between completed Goal turns.

Effect:

- Every later call can include a larger thread history.
- A 99 percent cache hit still meters that history at the cached-input rate.
- Small continuation prompts can carry large inherited context.

Required fix:

- Subscribe to token-usage updates.
- Measure `last.inputTokens / modelContextWindow`.
- Write a compact handoff.
- Compact at a completed-turn boundary.
- If compaction does not reduce the next request below the configured pressure target, split bounded work into fresh workers instead of extending root history.

### P0: Root model and effort are inherited

The root `thread/start` call does not set an explicit model or reasoning effort. A Cruise Goal started from Sol xhigh can therefore retain Sol xhigh for planning, routine edits, focused tests, and continuation.

Required fix:

- Pin the root coordinator to Sol high.
- Keep final synthesis and high-risk review on Sol high or above.
- Route bounded work to fresh L1 through L7 workers.
- Record the resolved model and effort for each worker.

### P0: Existing worker router is not automatic Goal execution

Cruise already defines:

- L1 Luna medium.
- L2 Terra medium.
- L3 Terra high.
- L4 Terra xhigh.
- L5 Sol high.
- L6 Sol xhigh.
- L7 Sol ultra.

`simple-worker.mjs` creates an ephemeral, explicit-model worker, which is the right primitive. The Goal loop does not automatically dispatch work through it. Most substantive work therefore remains in the durable root.

Required fix:

- Convert each ready micro-goal into a bounded worker capsule.
- Let the root perform only coordination, integration, and final review.
- Escalate the narrow blocked work item, not the whole Goal.
- Permit de-escalation once uncertainty is resolved.
- Treat transport and tool failures as transport failures, not evidence that a stronger model is needed.

### P0: No account-level quota guard

The snapshot does not call:

- `account/rateLimits/read`
- `account/rateLimits/updated`
- `account/usage/read`
- `thread/tokenUsage/updated`

The current `LIMIT_POLICY.md` explicitly rejects universal workload, repair, verification, and attempt budgets. That policy conflicts with the requested account-level weekly ceiling.

Required fix:

- Add a distinct resource-containment policy.
- Read the longest available rate-limit window, preferring a window near 10,080 minutes.
- Record the baseline used percentage and reset time.
- Atomically reserve a default 2.25 percentage points per Goal across four concurrent or sequential long Goals.
- Cap the campaign at a 9-point observed delta.
- Pause with a resumable budget report before starting another expensive turn.
- Fail closed for strict budget mode when weekly rate-limit data is unavailable.

### P1: Escalation is monotonic and attempt count is unbounded

`model-policy.mjs` moves Luna to Terra to Sol and then raises Sol effort. It deliberately has no universal attempt count.

This can convert repeated low-information failure into increasingly expensive retries.

Required fix:

- One retry may repeat a hypothesis only when the failure could be nondeterministic.
- A second attempt requires new discriminating evidence.
- Tool, permission, environment, dependency, and transport failures keep the same model level.
- L6 and L7 require a high-consequence boundary plus evidence that the lower level failed for reasoning quality.
- Reset to the lowest safe level after the blocker is isolated.

### P1: Assurance work is repeatedly invalidated

The Goal skill requires Flight rereading at every micro-goal, fresh receipts, independent review at high risk, and repeated attestation. A source edit can stale all prior receipts.

Required fix:

- Cap Flight at 8 KB.
- Give each gate an explicit affected surface and surface hash.
- Invalidate only gates whose surface changed, except global intent and final-review gates.
- Update receipts after a stable micro-goal, not after every edit.
- Run one final independent semantic review for a stable high-risk diff.
- Keep detailed evidence in files and inject only compact receipt summaries.

### P1: Debug can fan out too broadly

The debug skill allows two exploratory waves using every safely available slot. On a broad request, that can create a large aggregate context bill.

Required fix:

- Start with two or three evidence-distinct probes.
- Expand only after a probe confirms a cause that justifies semantic-sibling search.
- Give every probe a file, interface, user path, output, and byte budget.
- Deduplicate overlapping findings before opening another wave.
- Default maximum active workers to three. Permit a larger swarm only through explicit quota reservation.

## 4. Skill-bundle findings

### General conclusion

The Markdown size of the skills is not the primary drain. Their activation breadth and mandatory workflow expansion are.

### `seeking-alpha`

Its description instructs use even when the user does not name the skill and when a complex problem or obvious approach appears. This can convert ordinary engineering into broad novelty search, literature retrieval, multiple candidates, two independent gates, and preregistration.

Fix:

- Trigger only for explicit novelty, research-edge, or non-obvious-search requests.
- Do not trigger for ordinary implementation, bug fixing, or deterministic optimization with a known objective.
- Cap initial candidates at three and expand only after cheap falsification.

### `dag-prompts`

It converts multi-step investigations and builds into a deterministic DAG, often with several nodes and receipts.

Fix:

- Trigger only when there are at least three independently dispatchable work units, explicit preregistration, or a user-requested DAG.
- Use a linear checklist for ordinary two-step work.
- Keep the root DAG summary below 4 KB and store node detail separately.

### `auto-experiment`

Its scientific controls are sound, but it requires live state, resource policy, locked plans, receipts, references, a machine-readable plan, and validation. That is appropriate for confirmatory experiments and excessive for simple exploratory code changes.

Fix:

- Trigger only when outcomes, statistical claims, model comparison, hyperparameter choice, or protected holdouts are materially involved.
- Add a lightweight exploratory mode with a 4 KB plan cap.
- Read only current state pointers and exact relevant receipts.

### `ship-kaggle-kernels`

It performs extensive certification and fault injection. This is appropriate at the actual launch boundary.

Fix:

- Trigger at packaging, certification, launch, or remote-monitoring boundaries.
- Do not trigger while editing unrelated training code.
- Cache certification results by immutable package and profile hashes.
- Rerun only invalidated checks.

### `noconflict-env`

The skill is comparatively well bounded. Its main risk is broad environment inventory when one dependency or interpreter check would answer the question.

Fix:

- Start with the exact command, interpreter, and package involved.
- Expand to full environment analysis only after a conflict is evidenced.

## 5. Repository findings

### `cell_tracking`

Severity: P0.

Evidence:

- Root `AGENTS.md` says G-02 `LIVE_STATE.md` is the single shared source and must be read before acting.
- That file is 319,562 bytes and 4,360 lines.
- Its title says `archived source of truth`.
- A separate G-03 current state exists at 74,213 bytes.
- Large binary assets, NPZ outputs, predictions, historical reports, and 130 DAG prompts sit inside the repository.

Risks:

- Routine sessions ingest a large archived state before locating code.
- The instruction conflicts with the repository's newer campaign state.
- Full report history and logs are mixed with current state.
- Scientific and compute governance text can dominate ordinary source changes.

Fix:

- Introduce `reports/CURRENT.md`, capped at 4 KB.
- It contains active campaign, current frontier, protected gates, key numbers, and exact pointers.
- Treat G-02 as archived unless `CURRENT.md` explicitly activates it.
- Read full state histories only for a named historical decision.
- Exclude assets, predictions, NPZ files, remote outputs, old DAG runs, and logs by default.
- Keep scorer, holdout, CV, statistical, external compute, and competition-submission work at L5 or above.

### `booking-support-site`

Severity: P1.

Evidence:

- 1,126 files and about 33 MB, with large public image trees.
- Next.js 16 rules require checking installed documentation.
- Root policy says every covered APPI task gets `appi:scan:full` after implementation.
- The APPI preflight itself supports `NONE`, `AFFECTED_SCOPE`, and `FULL`.
- The APPI lifecycle also calls Cruise debug or the strongest debug pass, creating a recursive expansion risk.

Fix:

- Read only the exact Next.js guide section needed for the API being changed.
- Obey `required_scan`.
- Run affected-scope scan for local changes.
- Reserve full scan, privacy E2E, semantic review, and full repository verify for cross-cutting or release-boundary changes.
- Do not recursively invoke Cruise debug unless a failing or ambiguous behavior requires it.
- Exclude `public/images`, build output, traces, node modules, and archived compliance evidence from routine retrieval.

### `check-in`

Severity: P0 for state accuracy, P1 for token use.

Evidence:

- `PLAN.md` says W2 is next.
- `docs/dag/state.yaml` records W0 through W10, with W10-C and W10-D blocked at human gates.
- The root DAG prompt is about 83 KB.
- The append-only ledger is about 21 KB.
- There is no root `AGENTS.md`.

Fix:

- Make `docs/dag/state.yaml` authoritative.
- Generate `docs/dag/CURRENT.md`, capped at 4 KB.
- Do not read the root prompt or full ledger for ordinary work.
- Open one node prompt and one node report only when working on that node.
- Keep external effects and production activation behind existing human gates.
- Use L5 or above for identity, auth, RLS, storage, payment, key issuance, migrations, retention, audit, external integration, or release-gate changes.

### `window`

Severity: P1.

Evidence from connected GitHub:

- Scientific Python workflow for SAW ingestion, spatial clustering, map-read orchestration, and posterior analysis.
- Python compatibility begins at 3.8.
- Repository documentation carefully separates exploratory results from confirmatory claims.
- Expected data and output formats include BAM, GEM, H5MS, compressed tables, posterior outputs, and generated plots.

Fix:

- Never open binary or generated scientific data in model context.
- Inspect schemas, row counts, headers, and small samples through helper scripts.
- Preserve Python 3.8 compatibility.
- Keep biological replicate, technical chunk, spatial bin, nucleotide, and window units distinct.
- Use L5 or above for estimand, statistical threshold, posterior, registration, multiplicity, or exploratory-to-confirmatory changes.
- Use focused tests before any full pipeline or HPC run.

### `hotel_locker`

Severity: P1.

Evidence from connected GitHub:

- Security-sensitive TypeScript monorepo with signed commands, tenant authorization, offline PIN handling, replay semantics, PostgreSQL, WSS/HTTPS, Android boundaries, and Tianrui integration.
- Existing instructions list many full validation commands but do not define a risk-scaled test ladder.
- Physical device facts remain unverified.

Fix:

- Preserve every existing security invariant.
- Add targeted verification by changed package and boundary.
- Run full `pnpm validate` once at a stable final diff or for a security-critical cross-cutting change.
- Use L5 or above for signing, replay, PIN, auth, tenant scope, migrations, command receipts, Tianrui IPC, production config, or physical effects.
- Never claim Android, vendor, network, or hardware validation unless it actually ran.

## 6. Expected reduction

A realistic median target:

| Work class | Main mechanism | Target credit reduction |
| --- | --- | ---: |
| L1 | bounded context plus Luna | 10x or more |
| L2-L3 | bounded context plus Terra | 5x to 10x |
| L4 | bounded context plus Terra xhigh | 5x |
| L5 | bounded context plus Sol high | 3x |
| L6-L7 | narrow escalation only | no universal target |

An illustrative blended workload with most execution on Terra or Luna can cut model-token rates by more than twofold before context reduction. Combining that with a twofold to fivefold context reduction makes a median fivefold credit target plausible.

The quota guard remains necessary because task mix, output volume, subagent count, and external Codex activity vary.

## 7. Key uncertainties

- The exact x20 weekly capacity is account and product-policy data, not exposed as a fixed public token number.
- `usedPercent` may expose both short and long windows. Cruise must identify the longest relevant window dynamically.
- Manual compaction quality can vary with thread content. The benchmark must test correctness after compaction.
- Sol high root quality plus lower-tier bounded workers should preserve final quality, but this must be tested on the user's actual high-risk work.
- Some state files are intentionally detailed audit records. The solution retains them on disk and changes only the routine retrieval path.
