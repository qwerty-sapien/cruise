---
name: goal
description: "Prepare and durably execute one consequential, long-running, cross-cutting, strategically sliced, permission-heavy, or recovery-sensitive outcome through separate Plan and Goal approvals and native Codex Goal mode. Do not use for a resolved small change, a finite current-thread plan, an unknown-cause defect, read-only review, or evidence-only research; Refine is the nearest smaller lane, and Goal is entered only when durability or consequence is material."
---

# Cruise Goal

Cruise turns one consequential outcome into an approved, durable execution contract. The installed skill surface is `$cruise:goal`; the local skill name is `goal` because the plugin supplies the `cruise` namespace. The optional `cruise` terminal client supplies the full keyboard picker and drives the same persisted Goal state as Codex `/goal` through app-server.

Cruise has three deliberate phases:

1. **Q&A** — inspect first, then resolve only material uncertainty one compact decision at a time.
2. **Review** — create and separately approve the implementation plan and Goal contract.
3. **Cruise** — directly activate native Codex Goal mode when the capability is available, then execute against the approved files and evidence.

## Keep the root coordinator in control

The root agent owns deterministic routing, user-facing questions, both approvals, permission requests, native Goal activation/status checks, worker spawning, integration, CLOSEOUT ownership, and final synthesis. It never performs substantive reconnaissance, planning, implementation, or verification itself. Codex CLI/GUI retain their host model; the native Cruise client alone applies the selected class to its host thread.

Delegate ordinary Goal contract planning, execution, and independent normal verification through the persisted Cruise class default from the passing Doctor report using `cruise worker`. Consequence floors and levels `5`, `6`, and `7` still govern architectural/consequential implementation or increasingly exceptional adjudication; bounded supporting mapping may use level `2`. Every launch carries exact Origin/baseline and approval snapshots, task/evidence IDs, ownership, permissions/effects, dependencies, limits, and stop rules; every returned attempt report and launcher receipt is persisted immutably before integration.

Workers never ask questions, accept **Approve Plan**/**Start Cruise**, activate Goal mode, integrate siblings, write CLOSEOUT, or address the user. The root supplies only the selected level and bounded packet; `cruise worker` owns the runtime configuration and receipt.

## Establish worker readiness before creating run state

Run `cruise doctor --json` before capturing Origin or writing any run artifact. Continue only
when the command exits zero and its top-level `ok` is `true`; explicitly confirm `model-policy`,
`worker-host-rule`, `installed-plugin-digest`, and `client-on-path` all pass, while treating every
other failed Doctor check as blocking too. Otherwise create no run, packet, or evidence record and
give the single setup action reported by Doctor; the attested launcher is the complete input
boundary and needs no extra user-facing transfer ceremony.

After readiness passes, take the absolute `workerExecutable` from that same Doctor result and
launch every `<workerExecutable> worker` command directly through the host execution tool; never
use the PATH token `cruise`. Keep the command cwd and `-C` equal to the canonical repository and
keep packet/report paths as different direct named artifacts in the same
`.cruise/runs/<run-id>` directory. Use `sandbox_permissions: "require_escalated"` and the concise
justification `Run the Doctor-attested Cruise worker.` (or the host's equivalent field). The exact
scoped rule installed and exercised by Doctor makes this non-interactive. Never try the worker in
the ordinary sandbox first and never turn a connection failure into a second launch. If the
launcher returns `CRUISE_WORKER_HOST_PATH_LOST`, preserve that incident, stop without substituting
root work, and run `cruise doctor --deep --install-worker-rule`; do not produce a
repository-export authorization question.

## Preserve origin and route once

Read [the shared invocation contract](../../internal/shared/invocation-contract.md) before any Goal-specific reconnaissance or question. Capture the triggering prompt verbatim in `.cruise/goal/ORIGIN.yaml`, validate its SHA-256, let `begin` automatically establish shared non-destructive foreign-diff monitoring before any worker or further write, then run the bounded deterministic probe and root-owned routing decision and record worker resolution and any admission reason. Do not ask a speculative start question. Handle a later unexpected change only through the shared root-owned incident pause protocol after the concrete incident is persisted. If intentional drift is accepted before routing, preserve its bytes, never rewrite the stale immutable Origin, and continue only from a fresh Origin in a new run. Goal remains the selected route when consequence, durability, slicing, material permissions, or robust recovery is established. Hand a smaller finite current-thread outcome to Refine, an unknown-cause failure to Debug, a native Codex or GitHub review request to the corresponding native review surface, or evidence-only inquiry to Research; preserve the current origin record and never reroute recursively.

At terminal success, perform the shared final clean check and call `foreign-diff-finalize --run-dir <run-dir> --expected-inventory-sha256 <checkpoint-sha256>` before the final response. Never finalize a failed, dirty, active, blocked, or waiting run.

For new suites, use stable `G/R/AC/D/T/E/F/H` identifiers and require every `T-XX` task to name `satisfies`, `preserves`, and `verification`. Existing locked suites that use legacy `N-XX`/`VG-XX` identifiers remain readable and must not be rewritten; reconcile them explicitly into a new origin-bearing candidate before new activation. The final verifier compares raw origin, normalized clauses and ledger, decisions, plan, actual diff, evidence, documentation, effects, and waivers—not merely task completion.

## Truthful surface boundaries

Choose behavior from the observed host. The skill alone is instructions and resources; the plugin's separate terminal client is a real app-server host:

- When the thread says it is controlled by the Cruise terminal client, the root coordinator uses exactly one blocking `request_user_input` question per call for every material decision and both reviews; do not set `autoResolutionMs`. The client truthfully supplies Up/Down, Enter/Space, immediate 1–9 selection, and q/Escape/Ctrl-C cancellation. Its case-sensitive review options must be labeled exactly **Approve Plan** and, in a later request, **Start Cruise**. Free text that merely repeats either phrase is not an approval token.
- In the terminal-client preparation turn, finish and validate each candidate artifact before showing its review. Never edit Plan-locked bytes while compiling GOAL.md, and never edit any approved contract byte after Start. End the turn without calling `create_goal` or implementing; the client rechecks the displayed digest snapshots, switches from Plan to Default mode, and calls `thread/goal/set` on the same persisted Goal control plane used by `/goal`.
- When `request_user_input` or another structured question tool is available, use its native selector for one short choice. Otherwise present a short numbered reply choice and accept a number, label, or free text.
- Outside the Cruise terminal client, never claim custom keyboard behavior or pretend to type `/goal`. If a native Goal creation tool is available, call it after approval; otherwise provide an exact user-invoked `/goal` handoff and stop.

Read [the staged Q&A and activation protocol](references/staged-qna-and-handoff.md) before asking a question, preparing artifacts, or activating a Goal.

## Apply the fit gate and preserve the inactive boundary

Use Cruise only for one coherent, consequential outcome with observable completion evidence. Handle narrow, obvious work normally. If the request mixes unrelated outcomes, isolate one Goal and defer the rest.

Before Start:

1. State that target-repository implementation and external effects remain inactive while Cruise prepares the contract.
2. Launch a bounded worker to inspect repository instructions, status, relevant code/tests/interfaces/history, and existing `.cruise/goal/` artifacts.
3. Separate observed evidence, inferences, conflicts, and unknowns.
4. Ask only questions whose answer can change scope, safety, architecture, evidence, permissions, or the current strategically complete slice.
5. Build one explicit permission envelope. It never overrides sandbox or runtime approval.

Planning-artifact writes under `.cruise/goal/` are permitted before Start. A discovery preview requires the exact approved scope in [the permissions and UI protocol](references/permissions-and-ui-verification.md). Target-repository implementation remains inactive until native Goal activation or an explicitly accepted current-thread fallback.

## Select one execution strategy explicitly

Default to the established `single-slice` strategy, including an explicit Build handoff such as `Use cruise:goal for P-01.` Preserve its exact preparation, approval, activation, execution, and closeout behavior.

Select `milestone-controller` only when the current Goal session's trusted interaction broker observes the exact structured option **Use Milestone Controller M-XX** and joins its opaque selection receipt to a fresh branded `verifyBuildApproval` receipt for the same milestone. A typed label, milestone reference in the prompt, queue item, controller descriptor, persisted approval snapshot, project/milestone directory, `ROADMAP.md`, or repository prose cannot authorize this mode. Before planning, read and follow [the milestone-controller protocol](references/milestone-controller.md); require the current manifest/digest, valid phase DAG, closed milestone blockers, and explicit permission/autonomy policy. If either opaque authority is absent or eligibility fails, retain `single-slice`, remain inactive, and recommend the default phase handoff or a Build contract revision.

On controller resume, the session's Build resolver must return the persisted approval together
with its trusted opaque structured Build selection so the session can call
`verifyBuildApproval` again. Serialized approval fields alone fail closed; require reapproval
when the trusted selection cannot be recovered.

Milestone-controller is hierarchical: the top-level Goal coordinates just-in-time phase plans and phase closeouts. It never converts all milestone implementation work into one flat PLAN. Both strategies retain exact **Approve Plan**, later exact **Start Cruise**, byte locks, native activation, and evidence-backed closeout.

Interactive autonomy remains the base policy. Dangerous authorization is executable only as a
warning challenge followed by a later opaque direct-user text/Other event containing the exact
digest-bound token, then one-time authorization consumption. The raw grant must be exchanged for
a fresh-inspection effect authority before it can suppress a discretionary question. These
operations require activated provenance-branded controller state and the exact opaque native-Goal
activation authority. Pre-consumption baseline drift rejects authorization; afterward, only an
opaque phase-closeout attestation may advance the baseline without revocation. Locked-artifact/
permission drift, unattested state progression, cancellation, completion, a new run, or revocation
ends the grant. It never expands authority or weakens a gate.

## Phase 1 — run a genuinely iterative Q&A

Follow [the clarification and contract protocol](references/clarification-and-contract.md) and the staged protocol. Do not turn a rough request into a dense questionnaire or make the user parse a long analysis before they can respond.

For each turn, a bounded worker analyzes the assigned evidence, but only the root coordinator may ask the user:

1. Have the worker inspect what the repository already answers.
2. Select the single highest-risk unresolved decision; skip a question when no material uncertainty remains.
3. Give a one- or two-sentence evidence/impact note and one recommended path.
4. Ask one concise choice, normally through one `request_user_input` question with 2–3 options and a free-text route when that tool exists.
5. Wait for the answer. Record its decision and impact before deciding whether another question is needed.

If the user accepts the recommendation and no material uncertainty remains, move directly to the plan review—do not interrogate them for optional preferences. If their answer adds a requirement, direction, risk, constraint, or acceptance condition, acknowledge the change, update the uncertainty ledger, and ask only the next affected material question. The Cruise terminal client always requires one question per request so the next question can react to the prior answer; another native host may ask two tightly coupled decisions only when separating them would make either unintelligible.

Front-load product intent, protected behavior, completion proof, permission boundaries, and stop conditions. Do not ask for repository facts already inspectable or low-impact style choices. Preserve stable `R-XX`, `AC-XX`, and `D-XX` identifiers once a draft contract exists.

## Phase 2 — build, review, and approve two distinct artifacts

In single-slice mode, compile exactly one current slice. In milestone-controller mode, compile one top-level coordinator contract whose phase work is planned just in time; do not compile a flat milestone implementation plan. The implementation plan and native Goal are related but distinct:

- **PLAN.md** is the evidence-backward DAG for the current slice, or the controller/reconciliation DAG in milestone-controller mode: ownership, dependencies, focused checks, gates, and rollback.
- **GOAL.md** is the compact durable execution contract that tells native Goal mode what to read, optimize, protect, verify, and when to stop.
- **ALIGNMENT.md** is the short crystallized intent/enforcer: the outcome stem, non-goals, protected behavior, and immutable completion fence. Both PLAN and GOAL reference it.

Write only these Cruise artifacts:

| Artifact | Purpose | Before Start |
| --- | --- | --- |
| `.cruise/goal/ORIGIN.yaml` | Immutable raw prompt, repository baseline, route, normalized goal, and change ledger | Required for new activation; legacy absence requires reconciliation |
| `.cruise/goal/SPEC.md` | Outcome, scope, requirements, acceptance evidence | Required |
| `.cruise/goal/DECISIONS.md` | Append-preserving decision and permission ledger | Required |
| `.cruise/goal/ALIGNMENT.md` | Compact approved alignment stem and anti-drift fence | Required |
| `.cruise/goal/ROADMAP.md` | Strategically complete slices | Conditional |
| `.cruise/goal/MILESTONE-CONTROLLER.yaml` | Audit descriptor for the current-session selection, approved Build manifest/digest, full Build-equal phase DAG/acceptance mapping, base interactive autonomy policy, and Build-derived completion fence | Required only after opaque controller authority exists; never authority by itself; dangerous authorization remains separate mutable runtime state |
| `.cruise/goal/PLAN.md` | DAG, ownership, node evidence, and gates | Required |
| `.cruise/goal/GOAL.md` | Durable execution contract for one slice or one hierarchical milestone controller | Required and inactive |
| `.cruise/goal/CLOSEOUT.md` | Actual node attempts, evidence, effects, and outcome | Forbidden until activation |

Keep the artifacts proportional. Do not paste lane reports or source excerpts. Never silently delete, renumber, or rewrite a locked decision. Keep the suite inactive while a material question, coverage gap, stale artifact, or ownership conflict remains.

### Plan capability branches before approval

Invoke the shared private provision workflow only for a concrete missing capability with material expected benefit. A `no_provisioning` result leaves the Goal DAG unchanged. For any selected capability, PLAN must record its `CAP-*` dependencies, necessity, exact permissions, authentication checkpoint, evidence gates, and an equivalent fallback for every preferred node before plan approval. The provisioner is private implementation, never a public Goal command or recursive public-skill call.

### First review: implementation plan

Validate origin/hash integrity, decision coverage, requirement/acceptance coverage, DAG validity, ownership, gates, permission envelope, and one-slice scope. For milestone-controller, instead validate the current opaque selection/Build authority, descriptor equality to that authority, locked Build manifest/digest, phase DAG, blocker state, controller-only PLAN, autonomy policy, and completion fence. Then show a compact plan card—outcome, current slice or selected milestone/controller strategy, key tasks, proof, permissions, and deferred work—with links/paths to the full artifacts.

Ask one clear plan-review choice: **Approve Plan**, request targeted changes, or save/stop. In the terminal client, use that exact label; the client shows and snapshots the complete current Plan artifact set before selection, including the controller descriptor and locked Build manifest entries when present. Treat approval as a byte lock, not as permission to execute. Do not update a state field or decision log after the selection; any changed locked byte invalidates approval and returns to the appropriate Q&A or plan-review step.

### Second review: Goal contract

Only after the plan is approved, compile and validate GOAL.md. It must contain:

- one objective and a verifiable stopping condition;
- the exact approved files to read first, including `ORIGIN.yaml`, `ALIGNMENT.md`, and `PLAN.md`;
- in milestone-controller mode, the controller descriptor, selected Build project/milestone files and digest, phase graph, autonomy policy, just-in-time loop, and aggregate completion fence;
- scope, non-goals, protected behavior, and permission boundary;
- a scorecard, fast feedback loop, checkpoints/progress memory, and final evidence/gates;
- interruption conditions and a concise completion/closeout contract.

Show a separate compact Goal card: alignment stem, files to read, what proves progress, what ends the run, and the exact approved artifact digests. Ask one final choice: **Start Cruise**, revise the Goal/plan, or save inactive. Only an unambiguous Start choice approves the Goal and authorizes activation. “Looks good,” plan approval alone, or a side-effect approval is not Start.

## Phase 3 — activate Cruise directly and truthfully

Immediately before activation, validate the immutable raw-prompt hash and recompute the repository and artifact identities. If they drift, keep the suite inactive and reconcile first.

Choose exactly one branch:

1. **Cruise terminal client owns activation.** The thread's developer instructions explicitly identify this surface. Finalize every candidate byte before the Goal review, use `request_user_input`, and require the exact **Start Cruise** choice in a request after **Approve Plan**. After selection, make no artifact write and end the preparation turn without implementation or a `create_goal` call. The client rechecks the approval snapshots and repository baseline, switches the persisted thread to Default mode, checks `thread/goal/get`, calls `thread/goal/set` exactly once, confirms the returned Goal, and lets the native Goal harness start its continuation turn automatically.
2. **Native Goal creation is exposed in another host.** When `get_goal` is available, check the current Goal state first. Never overwrite another active Goal. Call `create_goal` exactly once with a concise objective that includes the alignment stem and these file references:

   ```text
   Complete [approved alignment stem]. Before editing, read and follow
   `.cruise/goal/ORIGIN.yaml`, `.cruise/goal/ALIGNMENT.md`, `.cruise/goal/PLAN.md`, and
   `.cruise/goal/GOAL.md` as the approved source of truth. Execute only the
   current slice, preserve its protected behavior and permission envelope, keep
   checkpoint evidence current, and stop only when every mandatory acceptance
   criterion and verification gate passes or an explicit blocking condition is met.
   ```

   Confirm the returned Goal is active before creating CLOSEOUT.md or executing repository changes.

   For milestone-controller, replace the single-slice sentence with an explicit instruction to read `.cruise/goal/MILESTONE-CONTROLLER.yaml`, revalidate the current opaque controller authority, load the persisted milestone/phase state revision, act as a hierarchical controller for its selected `M-XX` and digest, reconcile and plan only the next ready phase just in time, require a current closeout/evidence attestation before advancing, and claim completion only after a separate aggregate completion-fence attestation passes. Do not flatten the milestone.
3. **Native Goal is only a user slash command.** Output the exact `/goal` command containing the same concise objective and stop. This is a handoff, not proof of activation; resume only after an active state is confirmed.
4. **No native Goal is available.** Offer a separately selected **Execute in Current Thread** fallback only after recording a `D-XX` decision that native Goal is unavailable and the user accepts the loss of durable continuation. Bind that selection to the current Plan, Goal, and repository-baseline digests; it is not **Start Cruise** and must never be described as native activation. Otherwise keep the suite approved but inactive.

Do not invoke `codex /goal` from a shell, simulate keyboard input, or claim a background/durable run that has not been confirmed.

Resolve each worker from `recommended_level` through the launcher. A level change creates a new bounded attempt. Record every `agent_type`, level, launcher receipt, and immutable outcome in YAML. When execution or research lacks a necessary capability, use the internal provision workflow, suspend only auth-blocked dependents, and continue independent work only when the host genuinely schedules it.

After activation, capability loss or authentication failure is handled only by the private capability-degradation reconciler—never by invoking Refine inside the active Goal. It may select an equivalent pre-approved fallback or approved alternate Plan branch. If the replacement weakens mandatory evidence, changes outcome/scope/requirements, or exceeds permissions, require the applicable waiver or contract revision and invalidate affected approval; otherwise block the dependent nodes while unrelated ready nodes may continue.

## Execute in Cruise mode

After confirmed activation, read [the execution loop](references/execution-loop.md). When milestone-controller is active, also keep [its runtime phase loop](references/milestone-controller.md#4-runtime-phase-loop) loaded and apply the ordinary node loop inside only the current ready phase. The root coordinator launches a bounded worker for every ready node through:

1. orient against the approved IDs, inputs, ownership, permissions, and baseline;
2. state the smallest micro-plan and focused evidence;
3. preflight writes/effects and exclusive ownership;
4. have the selected worker implement only in-scope changes;
5. have that worker run and inspect focused deterministic evidence;
6. remediate within the node's bounded policy and preserve failed attempts;
7. return an immutable node-attempt report; only the root coordinator/integration owner appends CLOSEOUT;
8. advance safe disjoint nodes in parallel, otherwise serialize through the integration owner.

In milestone-controller mode, every transition goes through the validated persisted controller
state machine. Persist canonical milestone `STATE.yaml` and matching per-phase projections at
the same revision, including exact per-phase `QUESTIONS.yaml` ledgers, through the immutable
exact-byte controller history/CAS before advancing mutable mirrors; activate only a
dependency-ready phase, attest its immutable closeout and evidence before marking it complete,
and run the aggregate completion fence only after every mandatory phase closes. Pause/answer/
reopen reducers preserve stable question IDs and resume the same run across multiple pauses. A
runtime Q-ID starts above both locked milestone questions and the project registry high-water,
and load replays the complete event history. A missing/stale/forked history, state or question
projection, forged closeout, mandatory
blocked/failed phase, active hard stop, or stale completion attestation blocks advancement.

Controller state itself is provenance-branded and bound to opaque confirmed native-Goal
activation authority: reducers, attesters, persist, and load reject structural clones,
self-declared YAML, and serialized activation fields. A JIT phase-plan attestation binds real PLAN bytes, exact ownership,
permission scope, and the pre-phase repository baseline; closeout attestation rereads PLAN,
CLOSEOUT, and EVIDENCE, proves performed mandatory PASS coverage for every Build acceptance
criterion, and captures the post-phase baseline. Resume rebrands persisted state only after
revalidating all projections, locked bytes, completed-phase evidence, aggregate milestone
evidence, and the current repository baseline.
Dangerous question suppression additionally requires the persisted lineage to remain fully
phase-closeout-attested from the native activation genesis; a loaded unattested stop never becomes
a new trusted root.

Interrupt only for a material direction/safety decision, permission expansion, unexpected baseline/artifact drift, unavailable mandatory evidence, exhausted remediation, unsafe rollback, or scope expansion. Do not ask for routine implementation preferences after Start.

Use [the permissions and UI protocol](references/permissions-and-ui-verification.md) for local servers, Browser/Chrome/Playwright/Computer Use, network access, installs, and external systems. Use [the verification and closeout protocol](references/verification-and-closeout.md) for gates, evidence, remediation, and final status.

## Close only on evidence

`T-01` is a root-coordinated, task-selected adversarial worker gate and remains read-only. Each mandatory gate ends in `PASS`, `BLOCK`, or waiver-backed `NOT_RUN`; unavailable mandatory evidence blocks unless a locked waiver preserves the residual risk. An authoring worker or root self-review is not independent verification.

Claim `Completed` only when the verifier has reread `ORIGIN.yaml`, its raw prompt hash is valid, every origin clause remains represented, every mandatory `AC-XX` and gate has current valid evidence, approved effects are recorded, and no blocking deviation remains. Use `Completed (waiver-qualified)` only for a locked waiver; otherwise close honestly as `Blocked` with the precise evidence or decision needed to resume.

## Load references progressively

| Reference | Read when |
| --- | --- |
| [Staged Q&A and activation](references/staged-qna-and-handoff.md) | Always before questions, reviews, or activation. |
| [Clarification and contract](references/clarification-and-contract.md) | Before planning-artifact writes. |
| [DAG and ownership](references/dag-and-ownership.md) | Before PLAN, subagent allocation, or ownership changes. |
| [Milestone controller](references/milestone-controller.md) | Only after exact current-session structured selection and branded Build verification establish opaque authority; keep loaded through phase execution and aggregate closeout. |
| [Execution loop](references/execution-loop.md) | After activation and whenever a node blocks or retries. |
| [Permissions and UI verification](references/permissions-and-ui-verification.md) | While building permissions or using local servers, browser control, Computer Use, network, installs, or external systems. |
| [Verification and closeout](references/verification-and-closeout.md) | While defining gates, recording evidence, remediating, or closing. |
| [Examples and eval behavior](references/examples-and-evals.md) | When fit, slicing, interaction, or activation behavior is unclear; use during forward tests. |

## Final checklist

- [ ] The work fits one coherent Cruise Goal and either one current slice or one milestone controller authorized by an exact current-session structured selection plus a branded Build receipt.
- [ ] The strategy is explicit: single-slice by default, or an eligible digest-locked milestone controller whose descriptor matches opaque authority and is not a flat plan.
- [ ] Repository facts were inspected before questioning.
- [ ] ORIGIN.yaml preserves the exact raw prompt/hash and every normalized change is ledgered.
- [ ] Q&A was response-driven, compact, and stopped when uncertainty closed.
- [ ] PLAN and GOAL were reviewed and approved separately.
- [ ] ORIGIN.yaml, ALIGNMENT.md, PLAN.md, and GOAL.md have resolvable, current identities.
- [ ] Native activation was directly confirmed or the fallback limitation was disclosed.
- [ ] DAG ownership, permissions, focused tests, gates, attempts, and closeout evidence are current; controller phase/completion transitions use persisted state and opaque attestations.
- [ ] No activation, UI behavior, autonomy, tool use, or completion claim exceeds observed evidence.
