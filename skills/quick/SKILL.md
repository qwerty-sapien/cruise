---
name: quick
description: "Make an already-defined, bounded, low-risk repository change whose callers and focused verification are known. Do not use when root cause, design, public interfaces, migration, security, lifecycle, external research, or durable continuation is unresolved; use refine for limited decisions, debug for unknown causes, or goal for consequential scope, and promote before editing when any hard gate appears."
---

# Cruise Quick

Quick is the direct-edit lane for a change whose outcome and implementation are already substantially known. It is deliberately smaller than Refine and never creates a formal approval ceremony or a native Goal.

## Delegate every substantive phase

The root agent is the Cruise coordinator, not the implementer. It preserves Origin, runs deterministic routing, selects `recommended_level`, launches workers, owns user questions/permissions, integrates attempt reports, and gives the final synthesis.

Delegate repository mapping, implementation, and independent normal verification as separate bounded level-`2` attempts through `cruise worker`. Use the launch contract in [the shared invocation contract](../../internal/shared/invocation-contract.md); the launcher owns runtime selection and its receipt.

## Establish admission before editing

Read [the shared invocation contract](../../internal/shared/invocation-contract.md) first. Capture the triggering prompt verbatim, write its immutable Origin Record, run the bounded deterministic probe, obtain the structured route classification, and apply semantic admission. Do not make a product-code edit until those steps complete.

Admit Quick only when all of these are true:

- the requested behavior and intended implementation are substantially resolved;
- the affected scope is bounded and caller closure is supported by evidence;
- risk is low, verification is local and decidable, and no material permission is missing;
- no hard Quick-promotion condition in the shared contract applies.

A typo, known config value, closed-caller private rename/removal, or already-defined compatibility patch can fit. File count is only corroborating evidence, never the admission rule.

Promote before editing:

- to `cruise:debug` when an observed failure has an unknown root cause;
- to `cruise:refine` when a finite outcome needs a material design, behavior, evidence, or sequencing decision;
- to `cruise:goal` when the change is consequential, cross-cutting, permission-heavy, multi-slice, or needs durable recovery;
- to `cruise:research` when evidence must be acquired before an implementation can be chosen.

State the deterministic promotion reason and preserve the same Origin Record. Never recursively reroute.

## Treat missing capabilities as promotion evidence

Submit a private capability request only when mapping proves one concrete missing method, tool, connector, or validation capability and a material benefit beyond its cost. If the private provisioner returns `no_provisioning`, continue with native capabilities and do not add workflow ceremony. Quick does not call the provisioner as a public skill and neither side may invoke another public Cruise skill recursively.

If satisfying the gap requires external discovery, acquisition, installation, authentication, or a material fallback decision, stop before that effect and promote using the rules above. Preserve the same Origin and record the capability gap as the handoff reason; Quick never hides external provisioning inside a direct edit.

## Execute the minimal path

1. Have a bounded worker return a one-to-three-line micro-plan mapped to stable `G/R/AC/T/E` IDs; the root validates and integrates it.
2. Assign the worker only the necessary files, callers, tests, instructions, and public boundaries.
3. Have the worker make the smallest coherent edit inside exact write ownership. Avoid speculative refactoring, unrelated cleanup, broad mapping, worktrees by default, or future work.
4. Have the worker run focused deterministic evidence immediately: relevant tests, lint/type checks, symbol/reference scans, or compatibility checks.
5. Preserve each failed repair as a performed `BLOCK` evidence item, and bind the ordered unique `E-XX` list one-for-one to the repair counter. Repair at most twice, and only inside the admitted scope.
6. Promote when two repair iterations fail, predicted scope is materially exceeded, caller closure breaks, evidence conflicts with the request, or any hard gate emerges.
7. Spawn a verifier worker that did not author the change. If a correctly selected verifier cannot be launched, record `NOT_RUN` or `BLOCK`; root self-review is not independent verification.
8. Compare the raw origin, normalized clauses, expected scope, actual diff, tests, documentation, effects, and waivers. A completed micro-plan cannot certify itself.

Each task record must include `task_id`, `satisfies`, `preserves`, and `verification`. Persist every returned worker report immutably. Record `recommended_level`, `agent_type`, launcher receipt, attempt, and any one permitted soft-failure escalation in YAML.

## Close on focused evidence

Report:

- changed files and the bounded reason for each;
- exact checks and observed results, including skips or warnings;
- Origin/route/evidence record paths;
- repair attempts, external effects, cleanup, and residual uncertainty;
- `Completed`, `Blocked`, or the explicit promoted skill.

Do not create Goal artifacts, activate native Goal mode, claim a commit without permission and evidence, or silently expand the change.
