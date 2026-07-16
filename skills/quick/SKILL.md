---
name: quick
description: "Make an already-defined, bounded, low-risk repository change whose callers and focused verification are known. Do not use when root cause, design, public interfaces, migration, security, lifecycle, external research, or durable continuation is unresolved; use refine for limited decisions, debug for unknown causes, or goal for consequential scope, and promote before editing when any hard gate appears."
---

# Cruise Quick

Quick is the direct-edit lane for a change whose outcome and implementation are already substantially known. It is deliberately smaller than Refine and never creates a formal approval ceremony or a native Goal.

## Delegate every substantive phase

The root agent is the Cruise coordinator, not the implementer. It preserves Origin, runs deterministic routing, selects `recommended_level`, launches workers, owns user questions/permissions, integrates attempt reports, and gives the final synthesis.

Delegate repository mapping, implementation, and independent normal verification as separate bounded attempts through `cruise worker`. Semantic mapping remains level `2`; ordinary implementation and verification use the persisted Cruise class default from the passing Doctor report. A trivial, tightly bounded Quick edit may use level `3` instead, but must record why it is below the class default. Use the launch contract in [the shared invocation contract](../../internal/shared/invocation-contract.md); the launcher owns runtime selection and its receipt.

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
`CRUISE_WORKER_HOST_PATH_LOST`, preserve that incident, stop without substituting root work, and
run `cruise doctor --deep --install-worker-rule`; do not produce a repository-export authorization question.

## Establish admission before editing

Read [the shared invocation contract](../../internal/shared/invocation-contract.md) first. Capture the triggering prompt verbatim and its immutable Origin Record, let `begin` automatically establish shared non-destructive foreign-diff monitoring before any worker or further write, run the bounded deterministic probe, obtain the structured route classification, and apply semantic admission. Do not ask a speculative start question. Handle a later unexpected change only through the shared root-owned incident pause protocol after the concrete incident is persisted. If intentional drift is accepted before routing, preserve its bytes, never rewrite the stale immutable Origin, and continue only from a fresh Origin in a new run. Do not make a product-code edit until those steps complete.

At terminal success, perform the shared final clean check and call `foreign-diff-finalize --run-dir <run-dir> --expected-inventory-sha256 <checkpoint-sha256>` before the final response. Never finalize a failed, dirty, active, blocked, or waiting run.

Use the exact `map-pkt.yaml` generated atomically by `begin`; do not hand-write, replace, or repair it. The deterministic `probe.yaml` is schema version 2 and also carries `durable_continuation_required` and `cross_system_program`; the packet's enrichment template is schema version 1 and deliberately excludes those two routing-only signals. That 20-field probe versus 18-gate enrichment is expected, not a conflict.

Give that worker write ownership only for the packet-declared immutable `map-facts.yaml`. It copies the complete `enrichment_template` and changes only `facts[*].value` and `facts[*].basis` when evidence requires it. The packet forbids `enrich-probe` and `route`; both mutate canonical run-control files and remain root-coordinator mechanics. After persisting and auditing the worker report, the root alone invokes `enrich-probe` through the exact installed runtime path. Never spend a second inference repairing packet shape; launcher preflight makes tagged packet/template drift a local error.

Admit Quick only when all of these are true:

- the requested behavior and intended implementation are substantially resolved;
- the affected scope is bounded and caller closure is supported by evidence;
- risk is low, verification is local and decidable, and no material permission is missing;
- no hard Quick-promotion condition in the shared contract applies.

A typo, known config value, closed-caller private rename/removal, or already-defined compatibility patch can fit. File count is only corroborating evidence, never the admission rule.

For one local fact that verifies an already-admitted implementation without changing its scope,
use the private [Research Cell procedure](../../internal/research/WORKFLOW.md#use-a-research-cell)
inside this run and record its evidence card. If its answer changes the implementation choice or
needs external evidence, promote before editing; the helper never turns unresolved discovery into
a hidden Quick change.

Promote before editing:

- to `cruise:debug` when an observed failure has an unknown root cause;
- to `cruise:refine` when a finite outcome needs a material design, behavior, evidence, or sequencing decision;
- to `cruise:goal` when the change is consequential, cross-cutting, permission-heavy, multi-slice, or needs durable recovery;
- to `cruise:refine` when evidence must be acquired before an implementation can be chosen.

State the deterministic promotion reason and preserve the same Origin Record. Never recursively reroute.

## Treat missing capabilities as promotion evidence

Submit a private capability request only when mapping proves one concrete missing method, tool, connector, or validation capability and a material benefit beyond its cost. If the private provisioner returns `no_provisioning`, continue with native capabilities and do not add workflow ceremony. Quick does not call the provisioner as a public skill and neither side may invoke another public Cruise skill recursively.

If satisfying the gap requires external discovery, acquisition, installation, authentication, or a material fallback decision, stop before that effect and promote using the rules above. Preserve the same Origin and record the capability gap as the handoff reason; Quick never hides external provisioning inside a direct edit.

## Execute the minimal path

1. Have a bounded worker return a one-to-three-line micro-plan mapped to stable `G/R/AC/T/E` IDs; the root validates and integrates it.
2. Assign the worker only the necessary files, callers, tests, instructions, and public boundaries.
3. Have the worker make the smallest coherent edit inside exact write ownership. Avoid speculative refactoring, unrelated cleanup, broad mapping, worktrees by default, or future work.
4. Have the worker run focused deterministic evidence immediately: relevant tests, lint/type checks, symbol/reference scans, or compatibility checks.
5. Preserve each failed repair as a performed `BLOCK` evidence item, and bind the ordered unique `E-XX` list one-for-one to the repair counter. Continue only inside the admitted scope and only while the task's explicit stop/resource conditions allow another evidence-producing attempt.
6. Promote when repair evidence makes the cause unknown, predicted scope is materially exceeded, caller closure breaks, evidence conflicts with the request, an explicit stop condition fires, or any semantic hard gate emerges. A universal hidden repair count is not a promotion reason.
7. Spawn a verifier worker that did not author the change. If a correctly selected verifier cannot be launched, record `NOT_RUN` or `BLOCK`; root self-review is not independent verification.
8. Compare the raw origin, normalized clauses, expected scope, actual diff, tests, documentation, effects, and waivers. A completed micro-plan cannot certify itself.

Each task record must include `task_id`, `satisfies`, `preserves`, and `verification`. Persist every returned worker report immutably. Record `recommended_level`, `agent_type`, launcher receipt, every attempt, and every evidenced soft-failure escalation in YAML.

## Close on focused evidence

Report:

- changed files and the bounded reason for each;
- exact checks and observed results, including skips or warnings;
- Origin/route/evidence record paths;
- repair attempts, external effects, cleanup, and residual uncertainty;
- `Completed`, `Blocked`, or the explicit promoted skill.

Do not create Goal artifacts, activate native Goal mode, claim a commit without permission and evidence, or silently expand the change.
