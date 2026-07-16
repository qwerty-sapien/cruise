---
name: refine
description: "Turn one known finite outcome with limited unresolved scope, behavior, architecture, evidence, or sequencing into an approved plan and current-thread implementation. Do not use for a known tiny edit, an unknown failure, read-only assessment, evidence-only research, or durable consequential execution; Quick is the smaller neighbor and Goal is the promotion when recovery, permissions, risk, or slicing exceed one thread."
---

# Cruise Refine

Refine is the middle lane: the finite outcome is known, but a small amount of decision-making is needed before coding. It produces one proportional approved plan, executes in the current thread, and independently verifies the result. It never activates native Goal mode or creates a multi-slice roadmap.

## Delegate every substantive phase

The root agent remains a coordinator throughout this current-thread workflow. It owns deterministic routing, user questions, approval selection, permissions, worker spawning, integration, and final synthesis; it does not perform substantive planning/implementation itself. Codex CLI/GUI retain control of the host model; only the native Cruise client applies the selected class to its host thread.

Use the persisted Cruise class default from the passing Doctor report through `cruise worker` for clarification analysis, planning, ordinary execution, and independent normal verification. Budget mode therefore uses level `3`, normal level `4`, premium level `5`, and luxury level `6`; use a lower level only for a specifically bounded cheap task. Consequential scope is still a Goal handoff rather than a hidden Refine expansion. Each worker gets a bounded packet and returns an immutable attempt report plus a launcher-owned receipt.

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

## Establish the finite contract

Read [the shared invocation contract](../../internal/shared/invocation-contract.md) first. Capture the immutable origin and baseline, let `begin` automatically establish shared non-destructive foreign-diff monitoring before any worker or further write, run the bounded probe and root-owned deterministic route, record worker resolution, and apply semantic admission before product edits. Do not ask a speculative start question. Handle a later unexpected change only through the shared root-owned incident pause protocol after the concrete incident is persisted. If intentional drift is accepted before routing, preserve its bytes, never rewrite the stale immutable Origin, and continue only from a fresh Origin in a new run.

At terminal success, perform the shared final clean check and call `foreign-diff-finalize --run-dir <run-dir> --expected-inventory-sha256 <checkpoint-sha256>` before the final response. Never finalize a failed, dirty, active, blocked, or waiting run.

Use Refine when repository inspection leaves at most a few material decisions about the known outcome. Hand off:

- to `cruise:quick` only when the work is already resolved, bounded, low-risk, and locally verifiable;
- to `cruise:debug` when the central problem is an observed failure with unknown cause;
- to `cruise:goal` before execution when the work becomes long-running, cross-system, strategically sliced, risky, permission-heavy, or dependent on durable recovery;
- to native Codex/GitHub review for findings, or `cruise:research` for a decision brief without product edits.

Preserve the same Origin Record across a handoff and do not route recursively.

## Resolve capability gaps inside the finite contract

Use the shared private provision workflow only for a proven concrete capability gap whose expected improvement exceeds its cost. A `no_provisioning` result returns directly to Refine with native capabilities. The provisioner is not a public command or route and must not call Refine or another public Cruise skill recursively.

Before **Approve Plan**, record every required external search, repository-local capability install, authentication checkpoint, exact `D-XX` permission, necessity level, and equivalent fallback in the plan. A preferred fallback must preserve the same mandatory acceptance criteria and evidence gates; loss of a mandatory capability blocks its dependents. If a new capability or weaker fallback materially changes an approved Plan, invalidate that approval and obtain the smallest necessary rereview. Promote to Goal when the resulting recovery, permissions, or durability no longer fit one current thread.

## Ask only material questions

Have a bounded worker inspect repository facts first and return direct requirements separately from repository-derived constraints and inferences. The root asks zero to three adaptive questions, normally one per interaction, only when an answer can change behavior, scope, architecture, safety, permissions, acceptance evidence, or sequencing.

- Give the smallest evidence/impact note and one recommended path.
- Offer two or three concrete alternatives only when a real fork exists.
- Record every normalized-goal change in the append-preserving change ledger.
- Stop when material ambiguity is closed; do not spend questions on inspectable facts or optional preferences.
- If the user explicitly expands the outcome, reclassify once rather than silently exceeding the three-question bound.

## Approve one proportional plan

Have the planning worker prepare the plan under its exact path ownership, then have the root validate and integrate it with YAML state under the current `.cruise/runs/<run-id>/` directory. Do not create ROADMAP.md or files under `.cruise/goal/`.

The plan must retain the user's language, distinguish evidence-derived constraints, and contain:

- normalized `G-XX`, `R-XX`, `AC-XX`, and `D-XX` records;
- ordered `T-XX` tasks, each with `satisfies`, `preserves`, and `verification` mappings;
- owned files/resources, dependencies, permissions, focused checks, rollback/stop rules, and one final independent verifier;
- the raw Origin reference and a decidable completion fence.

Show one compact review and require the exact selected label **Approve Plan**. Free text such as “looks good” is not an approval token. Bind the approval to the current Plan digest and repository-baseline digest; a mismatch fails closed. Approval authorizes this current-thread plan only. Changes to a material requirement, protected behavior, permission, verification fence, Plan byte, or baseline invalidate the affected approval and require the smallest necessary rereview.

## Execute and verify in this thread

After approval, the root launches bounded level-3 workers for the smallest ready tasks, preserves unrelated changes while integrating reports, and requires focused evidence after each material edit. A need for architectural implementation, difficult recovery, or materially conflicting evidence triggers a Goal decision; Refine does not silently change its worker level or root role.

The final verifier is a fresh launcher-created worker that compares the immutable origin, normalized clauses, decisions, approved plan, actual diff, tests/static evidence, documentation, effects, and waivers. Product work remains coordinated by the current root thread—never call `create_goal`, `thread/goal/set`, or print a fake activation handoff.

Close as `Completed`, `Blocked`, or `Completed (waiver-qualified)`, with exact evidence and remaining risk. If continuation durability becomes necessary, stop and promote to Goal before pretending this run can resume autonomously.
