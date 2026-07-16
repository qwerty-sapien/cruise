---
name: debug
description: "Diagnose an observed failure, regression, incorrect output, performance anomaly, failing test or CI job, crash, hang, or inconsistency whose root cause is unknown, then verify the smallest root-cause repair. Do not use for a known feature change, open design, read-only review, or technology research; Refine is the neighbor when desired behavior is unresolved, and Goal is the handoff when diagnosis or repair becomes a durable cross-system program."
---

# Cruise Debug

Debug is an evidence-driven diagnosis lane. Its central deliverable is a proven root cause and verified minimal repair—not a sequence of speculative patches.

## Delegate every substantive phase

The root agent owns deterministic routing, user questions and permissions, worker launching, integration, and final synthesis. It never performs the diagnosis or repair itself. Launch the persisted Cruise class default from the passing Doctor report through `cruise worker` for hypothesis generation, discriminating experiments, and normal causal repair; a narrowly bounded cheap experiment may use a lower justified level. Each evidenced soft failure may create a stronger new attempt, monotonically up to the level allowed by the workflow and host; explicit stop/resource conditions govern continuation. Independent verification is another non-authoring worker attempt.

Each launch must carry bounded paths/effects, Origin and baseline digests, hypotheses/tasks/evidence IDs, limits, and stop rules. Persist returned reports and launcher receipts immutably.

## Establish worker readiness before creating run state

Run `cruise doctor --json` before capturing Origin or writing any run artifact. Continue only
when the command exits zero and its top-level `ok` is `true`; explicitly confirm `model-policy`, `worker-host-rule`,
`installed-plugin-digest`, and `client-on-path` all pass, while treating every other failed Doctor
check as blocking too. Otherwise create no run, packet, or evidence record and give the single
setup action reported by Doctor; the attested launcher is the complete input boundary and needs no
extra user-facing transfer ceremony.

After readiness passes, take the absolute `workerExecutable` from that same Doctor result and launch
every `<workerExecutable> worker` command directly through the host execution tool; never use the PATH
token `cruise`. Keep the command cwd and `-C` equal to the canonical repository and keep packet/report
paths as direct named artifacts in the same `.cruise/runs/<run-id>` directory. Use
`sandbox_permissions: "require_escalated"` and the concise justification
`Run the Doctor-attested Cruise worker.` (or the host's equivalent field). The exact scoped rule
installed and exercised by Doctor makes this non-interactive. Never try the worker in the ordinary
sandbox first and never turn a connection failure into a second launch. If the launcher returns
`CRUISE_WORKER_HOST_PATH_LOST`, preserve that incident, stop Cruise worker activity, and run
`cruise doctor --deep --install-worker-rule`; do not produce a repository-export authorization question.

## Admit an actual unknown-cause symptom

Read [the shared invocation contract](../../internal/shared/invocation-contract.md) first. Capture the raw symptom request in the immutable Origin Record, let `begin` automatically establish shared non-destructive foreign-diff monitoring before any worker or further write, run the shared bounded probe and root-owned deterministic route, and record worker resolution before editing. Do not ask a speculative start question. Handle a later unexpected change only through the shared root-owned incident pause protocol after the concrete incident is persisted. If intentional drift is accepted before routing, preserve its bytes, never rewrite the stale immutable Origin, and continue only from a fresh Origin in a new run.

At terminal success, perform the shared final clean check and call `foreign-diff-finalize --run-dir <run-dir> --expected-inventory-sha256 <checkpoint-sha256>` before the final response. Never finalize a failed, dirty, active, blocked, or waiting run.

Require concrete observed behavior: a regression, wrong output, anomaly, failed test/CI run, crash, hang, or inconsistent result. If no failure exists and the change is already known, hand off to Quick or Refine. If the user wants examination without repair, use native Codex or GitHub review. For one narrow version, contract, or documented-behavior question that discriminates a hypothesis, read the [Research Cell procedure](../../internal/research/WORKFLOW.md#use-a-research-cell), use it inside this run, and record its evidence card before the next experiment. If the evidence cannot be bounded, record that limit and use native Codex or the existing parent permission/capability path. If the diagnosis or repair becomes long-running, cross-system, permission-heavy, or strategically sliced, promote to Goal with the same origin and evidence.

When both “broken” and “make the UX better” appear, first separate the reproducible defect from the unresolved desired behavior. Diagnose only the former; use Refine for the product decision. Do not route from keywords alone or enter a routing loop.

## Provision only a missing diagnostic capability

The root may submit a private capability request only when a concrete missing diagnostic, reproduction, inspection, or validation capability would materially improve causal evidence beyond its cost. `no_provisioning` means continue with native tools; it does not weaken the required root-cause proof. The provisioner is not a public command and must not recursively invoke Debug or another public Cruise skill.

External search, repository-local installation, or authentication still requires an exact granted `D-XX` permission and cannot expand repair authority. Suspend only experiments dependent on a waiting or mandatory capability, continue genuinely independent experiments when the host schedules them, and use a pre-approved equivalent fallback only when it preserves the same causal and verification gates.

## Build and test a hypothesis ledger

1. Record the exact symptom, reproduction steps, expected versus actual result, environment, frequency, and current evidence. Capture a known-good baseline when available.
2. Separate facts, direct observations, assumptions, and inferences.
3. Create stable ranked `H-XX` hypotheses. For each, state the predicted observation and the evidence that would falsify it.
4. Choose the cheapest discriminating experiment, not the easiest patch.
5. Run one experiment at a time against recorded inputs. Preserve command, result, side effects, and evidence as `E-XX`.
6. Update likelihood/rank only from observed output. Preserve rejected hypotheses so the run does not repeat them.
7. Identify a root cause only when evidence distinguishes it from correlation and symptom masking. Before any repair write, bind non-empty root-cause and causal-scope `E-XX` lists to performed `PASS` items in the evidence record; caller assertions alone grant no write authority.

Use the worker levels above, recording `recommended_level`, `agent_type`, launcher receipt, attempt, and escalation reason. Escalation creates a new bounded worker attempt; it never changes the root role or widens permissions.

## Repair the cause, not the symptom

Where practicable, add or improve a regression test that fails before the repair and protects the causal boundary. Then make the smallest coherent root-cause fix. Do not combine unrelated cleanup, broad refactoring, or a feature redesign.

Run the focused reproduction/regression evidence, then the relevant broader checks. Inspect alternate paths for masking, collateral regressions, lifecycle/concurrency effects, and compatibility. If a repair disproves the causal theory, preserve the failed attempt and return to the ledger rather than stacking another guess.

Every repair task has a stable `T-XX` record with `satisfies`, `preserves`, and `verification`. A fresh verifier worker must compare the raw origin, symptom, hypothesis/experiment history, actual diff, regression evidence, broader tests, effects, and residual uncertainty. A plan, authoring worker, or passing test cannot prove its own causal claim.

## Close truthfully

Report the root cause, discriminating evidence, fix, regression proof, broader verification, rejected hypotheses, changed files, and residual uncertainty. Close `Completed` only when both the symptom and cause are protected; otherwise close `Blocked` or promote explicitly.
