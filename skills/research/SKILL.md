---
name: research
description: "Acquire and reconcile repository, documentation, source-code, standards, paper, benchmark, or dependency evidence to produce a source-backed decision brief or implementation-ready recommendation without product-code edits. Do not use for a project or milestone contract, known change, unknown-cause repair, or acceptance assessment of an existing target; Build owns durable contracts, native Codex or GitHub handles read-only review, and implementation hands explicitly to Refine or Goal after the recommendation."
---

# Cruise Research

Research resolves a technical decision or evidence gap. Its deliverable is a reproducible, source-aware brief—not product-code implementation.

## Delegate every substantive phase

The root agent owns deterministic routing, user questions/permissions, worker launching, lane coordination, report integration, and the final user-facing brief. It does not perform retrieval/synthesis itself. Use level `2` through `cruise worker` for bounded retrieval/extraction and level `3` for synthesis. High-conflict or frontier synthesis may use one level `5` attempt. Independent verification is a distinct read-only worker.

Give every lane exact sources/paths, capability/effect permissions, dependencies, limits, Origin/baseline identities, and required evidence. Persist each returned report and launcher receipt immutably.

## Ground the question before searching

Read [the shared invocation contract](../../internal/shared/invocation-contract.md) first. Capture the immutable origin, repository baseline, bounded probe, structured route, and model resolution. Inspect relevant repository instructions, constraints, current dependencies, interfaces, and prior evidence before broad external retrieval.

Use Research for repository reconnaissance, literature/documentation review, implementation-option comparison, dependency evaluation, or feasibility analysis. If the user asks to implement the recommendation, finish or preserve the research brief and hand off explicitly to Refine or Goal; use Quick only when deterministic evidence proves the resulting change fully resolved, bounded, low-risk, and locally verifiable. Use Build when the output must become a durable project or milestone contract. Use native Codex or GitHub review when judging an existing implementation against a known standard. Use Debug for an observed unknown-cause failure.

Research must not modify product code, application dependencies, fixtures, lockfiles, or generated outputs. Durable reports and research-only capabilities may live under the approved `.cruise/` internal/run area. Do not install an application dependency merely to explore it.

## Build independent evidence lanes

1. State the decision question, repository constraints, required freshness, and what evidence would change the recommendation.
2. Have a planning worker propose independent lanes and dependencies; the root validates and schedules them with stable `T-XX` and `E-XX` records.
3. Inventory available capabilities. When a concrete connector, parser, CLI, skill, plugin, or validation capability is missing and its expected evidence gain exceeds provisioning cost, submit the shared private capability request described in [capability use](../../internal/provision/WORKFLOW.md). A `no_provisioning` result returns to native research methods. Never expose or recommend the provisioner as a public skill, command, or route, and never let it recursively invoke a public Cruise skill.
4. Bind external discovery, acquisition, repository-local installation, authentication, and credential use to separate exact `D-XX` permissions. Those workflow-capability effects remain confined to approved `.cruise/` or temporary state and never authorize product code or application-dependency changes.
5. Continue safe independent lanes while an unrelated capability waits for authentication; suspend its dependents. Use only a pre-approved equivalent fallback that preserves mandatory evidence gates, and block mandatory dependents otherwise. Never claim background work the host has not actually scheduled.
6. Prefer primary sources: official documentation, source code, standards, papers, and first-party benchmarks. Record direct links or precise repository references, versions, access dates, and retrieval limitations.
7. Separate observed evidence, established theory, inference, and speculation. Reconcile material conflicts instead of choosing by popularity.
8. Produce alternatives, tradeoffs, uncertainties, disconfirming evidence, and one recommendation mapped back to the immutable origin and repository constraints.

Retrieval/extraction uses level `2`; consequential synthesis uses level `3`; only high-conflict or frontier synthesis may use one level-5 attempt. Record `agent_type`, `recommended_level`, launcher receipt, attempt, and reason. Hard tool or source failures surface directly.

## Deliver an implementation-ready brief

The brief names:

- question and immutable origin reference;
- repository facts and constraints;
- evidence table with source quality, version/date, observation, and limitation;
- conflicting evidence and unresolved gaps;
- viable alternatives and tradeoffs;
- recommendation, confidence, disconfirming trigger, and implementation implications;
- authentication/capability gates and work that genuinely completed independently.

The final verifier compares the raw origin, question decomposition, cited evidence, repository constraints, recommendation, missing sources, and any research-area writes/effects. Do not claim consensus, feasibility, or freshness beyond the recorded sources, and do not silently begin implementation.
