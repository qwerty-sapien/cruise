# Cruise repository instructions

## Objective

Preserve Sol-high coordination and final review while minimizing model-visible context, output, and aggregate worker cost.

The `context-economy` skill applies to every Cruise command.

## Initial retrieval

Start with only:

1. `package.json`
2. this file
3. the exact source file or symbol named by the task
4. the nearest focused test

For app-server work, inspect the installed or current generated protocol schema for the exact method or notification. Do not scan the whole repository or read complete large source files without a named need.

## Context limits

- No unbounded model-visible item.
- No item above 10,000 estimated tokens.
- Any new item that can exceed 1,000 estimated tokens requires explicit review and a hard cap.
- File windows are at most 160 lines or 16 KB.
- Command output is at most 12 KB.
- A discovery round may open at most six windows before summarizing.
- Raw output goes under `.cruise/artifacts/` with a path and digest.
- Worker input is at most 8 KB.
- Structured worker results are at most 8 KB; the root continuation stays at most 4 KB.
- `.cruise/HANDOFF.md` is at most 4 KB.
- `.cruise/FLIGHT.md` is at most 8 KB.

## App-server invariants

- Root Goal threads explicitly request GPT-5.6 Sol with high reasoning.
- Bounded workers are ephemeral and explicitly select level, model, and effort.
- `thread/tokenUsage/updated` is cumulative. Maintain high-watermarks and do not sum snapshots.
- Cached input is subtracted from total input only after schema invariants are verified.
- Reasoning output is not added to output when it is reported as a subset.
- `thread/compact/start` runs only after the active turn completes.
- Compaction progress is not implementation progress and does not count as a failed attempt.
- `account/rateLimits/read` is the authority for weekly quota containment.
- Concurrent processes share an atomic per-account reservation ledger.
- A budget pause is resumable and has its own exit code.

## Model routing

- L1 GPT-5.6 Luna medium.
- L2 GPT-5.6 Terra xhigh.
- L3 GPT-5.6 Terra ultra.
- L4 GPT-5.6 Sol xhigh.
- L5 GPT-6 Astra high.
- L6 GPT-5.6 Sol ultra.
- L7 GPT-6 Astra xhigh for direct exceptional-consequence work; use ultra only for an evidenced escalation from L6.

Tool, permission, dependency, environment, and transport failures do not cause model escalation. Escalate only the narrow work item after new evidence.

## Change strategy

Keep protocol, usage accounting, quota, compaction, retrieval, routing, and assurance changes in reviewable stages. Avoid a single broad rewrite.

Agent-logic changes require integration-style tests with a mock app-server transcript. Include duplicate and replayed usage events, lower cumulative snapshots, reset changes, concurrent reservations, compaction lifecycle, and budget pause/resume.

## Verification

Use Node 20 or newer.

```sh
node --test tests/<focused-test>.test.mjs
npm test
npm run validate
```

Run a focused test after each coherent change. Run the full suite once after the final stable diff.

Do not call a real model in unit or integration tests. Real A/B measurements belong in the separately budgeted benchmark.
