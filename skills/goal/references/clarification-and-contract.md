# Clarification and Contract Protocol

Use this protocol to convert a difficult request into one approval-bound Cruise contract before target-repository implementation begins.

## Table of contents

- [1. Boundary and modes](#1-boundary-and-modes)
- [2. Repository-first reconnaissance](#2-repository-first-reconnaissance)
- [3. Material questions](#3-material-questions)
- [4. Stable identifiers and decisions](#4-stable-identifiers-and-decisions)
- [5. Artifact suite](#5-artifact-suite)
- [6. Goal slicing](#6-goal-slicing)
- [7. Permission envelope](#7-permission-envelope)
- [8. Pre-Start validation](#8-pre-start-validation)
- [9. Start and identity binding](#9-start-and-identity-binding)
- [10. Refine and Continue](#10-refine-and-continue)
- [11. Reduced assurance](#11-reduced-assurance)
- [12. Blocked-preparation fast path](#12-blocked-preparation-fast-path)

## 1. Boundary and modes

Keep implementation inactive while preparing the contract. The coordinator may write only planning artifacts under `.cruise/goal/` and may perform an explicitly approved discovery preview under the permissions protocol.

Select exactly one mode from evidence:

| Mode | Evidence | Required result |
| --- | --- | --- |
| New | No usable current Cruise suite | Create SPEC, DECISIONS, ALIGNMENT, PLAN, GOAL, and conditional ROADMAP |
| Refine | Current artifacts exist but are incomplete, stale, or challenged | Update only the smallest transitive artifact set |
| Continue | A prior started slice has actual code/evidence and the user wants the next slice | Verify and archive the prior run, then prepare one next inactive slice |

Do not ask which mode applies when the repository answers it. If a missing or contradictory closeout makes Continue unknowable, stop or return to Refine; never invent completion evidence.

## 2. Repository-first reconnaissance

Inspect, as relevant:

1. repository instructions and nested guidance;
2. branch, commit/tree identity, worktree status, and unrelated changes;
3. manifests, build entry points, dependency managers, and generated outputs;
4. affected code, public interfaces, schemas, migrations, fixtures, and tests;
5. CI, deployment, rollback, observability, security, privacy, and operational constraints;
6. existing `.cruise/goal/` artifacts and history;
7. recent relevant history and prior closeout evidence.

Classify each material finding:

| Class | Meaning |
| --- | --- |
| Observed | Directly supported by a path, symbol, command, artifact, tool result, or user statement |
| Inferred | Likely from observations but not proven |
| Conflict | Authoritative sources disagree |
| Unknown | Cannot be answered safely from available evidence |

Use three read-only lanes for high-risk or cross-cutting work when fresh subagents exist:

- product/repository behavior;
- architecture, safety, and ownership;
- verification, permissions, and operations.

Give lanes the same frozen repository identity but not one another's conclusions. Wait for all reports before changing planning artifacts. Risk-scale to one coordinator pass for smaller qualifying work, and label the loss of independent assurance.

Do not run a supposedly read-only command until its caches, bytecode, logs, snapshots, lockfiles, downloads, or external effects are understood. Redirect safe outputs outside the repository or record the check as unavailable.

## 3. Material questions

Ask only when different answers change:

- user-visible behavior or the promised outcome;
- security, privacy, compatibility, data integrity, or rollback;
- public interfaces, architecture, or migration ordering;
- the current strategically complete slice;
- mandatory evidence or the ability to prove completion;
- write ownership, external effects, permissions, cost, or duration.

Use the staged Q&A protocol. Default to **one short material decision per turn**. When a structured interface is available, use one question with 2–3 mutually exclusive choices, an evidence-backed recommendation first, and its automatic free-form option. In ordinary chat, use 2–4 numbered choices and accept a number, label, or free text.

Ask two tightly coupled decisions in one turn only when separating them would make either unintelligible. Never present a dense questionnaire, a full plan disguised as a question, or multiple unrelated forks. After every answer, record its consequence and ask another question only when an affected material uncertainty remains. A user accepting the recommendation normally closes that branch; do not add optional preference questions after it.

For each question include:

> **Decision:** [material fork]
>
> **Evidence:** [smallest relevant repository facts]
>
> **Impact:** [scope, risk, evidence, permission, or cost consequence]
>
> **Recommendation:** [evidence-backed choice]

Do not ask for repository facts already visible in code. Do not ask low-impact style preferences. Offer defer only when the temporary assumption is reversible, contains blast radius, does not weaken mandatory evidence, and authorizes no external effect.

During up-front clarification, include a permission question only when the expected work needs a capability outside ordinary in-repository edits and local read-only inspection. Group related permissions into one explicit envelope rather than interrupting repeatedly.

## 4. Stable identifiers and decisions

Assign monotonically:

| Type | Form | Meaning |
| --- | --- | --- |
| Requirement | `R-XX` | Required behavior, constraint, invariant, or deliverable |
| Acceptance criterion | `AC-XX` | Observable evidence for requirements |
| Decision | `D-XX` | Material product, safety, permission, or scope choice |
| Goal slice | `G-XX` | One strategically complete execution slice |
| Task / DAG node | `T-XX` | One owned execution outcome |
| Evidence / verification gate | `E-XX` | One adversarial failure hypothesis and its immutable result |

Never delete, renumber, or reuse an identifier. Preserve rejected and superseded history.

Use these decision statuses:

- `Proposed` — recommended but not confirmed;
- `Locked` — explicitly confirmed and normative;
- `Deferred` — safe reversible assumption with owner and reopening trigger;
- `Rejected` — explicitly declined;
- `Superseded` — replaced by a new linked decision after approval.

Each decision records question, evidence, options, chosen path or assumption, rationale, consequences, affected IDs/artifacts, approval owner and record, reopening trigger, and supersession links.

Never alter a locked decision's meaning in place. Present new evidence and affected artifacts, obtain explicit approval, mark the old entry Superseded, and add a new ID.

## 5. Artifact suite

Every artifact begins with planning state, mode/current slice, last-reconciled date, and repository identity. New suites also include immutable `.cruise/goal/ORIGIN.yaml`; validate its raw prompt SHA-256 before reading derived intent. A legacy suite without ORIGIN remains readable but cannot be newly activated when origin-dependent verification is mandatory until the user explicitly reconciles it into a new candidate. Never invent or backfill an unknown legacy prompt.

### SPEC.md

Include:

- measurable outcome and beneficiary;
- observed/inferred/conflicting repository evidence;
- in-scope work and non-goals;
- atomic requirements with source and decision links;
- acceptance criteria with exact pass conditions and evidence;
- protected behavior and invariants;
- constraints and permission boundaries;
- risks, rollback expectations, assumptions, and traceability gaps.

Every mandatory requirement has at least one decidable acceptance criterion. “Works,” “looks good,” “tests pass,” or an unexplained score is not enough.

### DECISIONS.md

Keep an index plus complete append-preserving entries. Record Start separately from permission decisions. A permission decision names exact capability, target, limits, owner, expiry, expected evidence, and cleanup.

### ALIGNMENT.md

Keep one concise anti-drift record for the current slice. It names the user-approved outcome stem and beneficiary, scope/non-goal fence, protected behavior, exact `done only when` criteria, source-of-truth artifact paths/digests, and reopening triggers. It is not a second SPEC. PLAN, GOAL, and the native Goal objective must reference it.

### ROADMAP.md

Create only when the program needs more than one strategically complete slice. A slice must produce a usable outcome, safely deployable transition, decision-complete research result, or verifiable compatibility boundary. Do not use roadmap slices as generic phases such as “write tests.”

### PLAN.md

Begin with required completion evidence, then define the execution DAG, ownership ledger, gates, iteration policy, permission mapping, and traceability. Name the exact ALIGNMENT.md identity that fences the plan. Follow the DAG reference.

### GOAL.md

Compile one current slice by reference. Include:

- end state and current slice;
- exact approved artifact references and identities, including immutable ORIGIN;
- context to read first, beginning with validated `ORIGIN.yaml`;
- scope, non-goals, and protected behavior;
- the alignment stem and explicit reference to ALIGNMENT.md and PLAN.md;
- DAG summary and ownership;
- mandatory evidence and gates;
- scorecard/stopping condition and a fast feedback loop plus slower final check;
- checkpoints and working-memory/progress-log cadence, or an explicit reason none are needed;
- permission envelope and UI verification plan;
- iteration policy and interruption conditions;
- closeout requirements.

Writing or reviewing GOAL never starts execution.

Use these suite states:

- `Draft` — unresolved material issue or validation failure;
- `Prepared (inactive)` — internally consistent and ready for plan review;
- `Plan approved (inactive)` — exact planning bytes are approved but GOAL is not yet approved or active;
- `Approved (inactive)` — exact plan and Goal bytes are approved but native activation is not yet confirmed;
- `Cancelled (inactive)` — preserved but unusable without Refine.

## 6. Goal slicing

Compile exactly one `G-XX`. Put later slices in ROADMAP or non-goals, never in current node allocation.

Prefer a smaller slice only when it remains strategically complete. Do not redefine the requested end state merely to reduce difficulty. For research-first work, the slice must retire a material uncertainty with reproducible evidence and a go/no-go result.

Audit:

- each in-scope `R-XX` belongs to the current or explicit future slice;
- exactly one slice is current;
- no node implements future-slice work;
- the current slice has independent transition value and completion proof.

## 7. Permission envelope

Build the envelope with the permissions protocol. At minimum classify:

- repository writes and generated artifacts;
- tests/builds and their side effects;
- dependency installs and network access;
- local processes, ports, and localhost preview;
- browser or authenticated Chrome use;
- Computer Use or native-app control;
- commits, pushes, PRs, releases, or deployments;
- production/data mutations, destructive operations, messages, credentials, intrusive tests, or paid compute.

Use `None approved` for absent effects. Never infer a high-risk effect from Start. Runtime approval prompts still apply even when a permission is locked in the contract.

## 8. Pre-Start validation

Record all five results before plan review:

1. **Decision coverage** — every material choice and permission is locked, safely deferred, or blocking.
2. **Requirement coverage** — every accepted requirement maps to criteria, nodes, and evidence.
3. **DAG validity** — IDs, edges, inputs, acyclicity, ownership, and evidence reachability pass.
4. **Goal quality** — one slice, resolvable references, exact identities, protected behavior, bounded iteration, and honest stops.
5. **Roadmap scope** — exactly one current slice and no future drift; mark not needed for a single-slice outcome.

Any blocking failure keeps every known-affected artifact Draft.

After explicit **Approve Plan**, bind the exact planning artifacts and compile GOAL without rewriting those locked bytes merely to record approval. Before the separate Goal review, validate that the Goal has one resolvable slice, current references, a measurable scorecard/stopping condition, a feedback loop, checkpoint/progress memory, and no plan or permission drift. Goal review cannot repair a stale plan silently.

## 9. Start and identity binding

Use two distinct approval points:

1. **Plan review** — approve the implementation plan, request targeted revisions/reopen a decision, or save/stop. Plan approval authorizes GOAL compilation only; it is not execution approval.
2. **Goal review** — after the plan is approved, present the compact Goal contract and ask whether to Start Cruise, revise/reopen, or save inactive. Treat only an unambiguous Start choice as approval of GOAL and activation authority.

Use a native structured selector when available; otherwise use a concise numbered choice. Do not turn either review into a dense questionnaire. A later material direction invalidates every affected approval and artifact digest.

Bind approval to:

- commit and tree identities;
- digest of dirty tracked changes;
- path/digest manifest of untracked inputs;
- exact digests of SPEC, DECISIONS, ALIGNMENT, optional ROADMAP, PLAN, and GOAL;
- exact digest and validated raw-prompt hash of ORIGIN;
- the approved permission envelope and fallback if native Goal is unavailable.

Immediately before execution, recompute all identities. If any changed unexpectedly, keep the suite inactive, identify affected checks, and reconcile.

Before showing **Start Cruise**, make the prepared suite the final `Approved (inactive)` candidate and bind the review to its exact bytes and permission envelope. After explicit Start, do not change an approval-state field or any approved artifact byte; run only the immediate identity recheck. In a Cruise terminal-client preparation turn, end after this recheck so the client can switch to Default mode and use `thread/goal/get` plus `thread/goal/set`; do not create a competing Goal. In another host, if `get_goal`/`create_goal` are available, inspect for a conflicting active Goal and call `create_goal` directly. Confirm the returned active state in either case. Keep the suite inactive while a user-invoked handoff awaits confirmation. If no native Goal exists, the only fallback is a separate exact **Execute in Current Thread** selection with a `D-XX` loss-of-durability decision bound to current Plan, Goal, and baseline digests; it is never Start or native activation. After confirmed native activation or that explicit fallback begins, preserve approved artifact bytes. Record active-state provenance and execution changes in CLOSEOUT, not by rewriting GOAL to manufacture an active label.

## 10. Refine and Continue

For Refine, update only the minimal transitive set. A changed requirement usually affects SPEC, ALIGNMENT, the relevant slice, PLAN coverage/evidence, and GOAL. A changed node detail may affect only PLAN and GOAL. Revoke/re-request the smallest affected approval rather than preserving a stale digest.

For Continue:

1. verify prior code, tests, effects, and CLOSEOUT against the exact approved contract;
2. stop on material discrepancy;
3. with exact path approval, copy the prior suite and CLOSEOUT into a uniquely named audit archive under `.cruise/runs/<run-id>/goal-history/`; never add an unrecognized path below `.cruise/goal/`;
4. create a digest manifest with repository, approval, activation, outcome, and link mappings;
5. verify the snapshot, then publish it without overwrite;
6. only after archival, prepare one next inactive slice.

Never fabricate a missing closeout or advance from a prior mandatory failure.

## 11. Reduced assurance

When fresh independent lanes, planners, critics, or `T-01` reviewers are unavailable:

- name the unavailable roles;
- perform mechanical checks sequentially;
- state the correlated-assumption risk;
- never call the work independently reviewed;
- keep mandatory independent-review requirements blocking.

If independence is desirable but not locked, include the reduced assurance in the Start summary so the user can Start, save inactive artifacts, or stop.

## 12. Blocked-preparation fast path

Use this only when all are true:

- the user requested preparation or inactive save, not execution;
- repository evidence identifies one explicit mandatory gate that cannot run;
- no waiver is granted and no equivalent approved evidence exists;
- the missing gate makes Start ineligible;
- remaining unknowns cannot remove that block within current permissions.

Then:

1. keep the requested outcome and current slice; do not reframe success as a different candidate, handoff, or research slice without user approval;
2. record the unavailable dependency and `NOT_RUN` consequence once, then reference it instead of repeating the full reconnaissance;
3. skip independent implementation/architecture planners and the critic unless a locked requirement demands them;
4. create a minimal PLAN whose graph represents the unavailable prerequisite, any safe preparation node already requested, and read-only `T-01`—do not invent implementation nodes that cannot start;
5. create the required inactive suite, including ALIGNMENT and GOAL, with `Draft` or `Prepared (inactive)` only when its definition truly fits;
6. state that Start is unavailable, save the suite, and stop;
7. create no CLOSEOUT and run no implementation or release command.

Keep the suite compact enough to finish as one coherent write set. Include paths/commands and exact evidence, but never paste a lane transcript into planning artifacts.
