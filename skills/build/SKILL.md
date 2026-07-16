---
name: build
description: "Establish a durable Cruise project foundation in an empty or minimal repository, or define the next coherent milestone in an established codebase. Produces approved project or milestone contracts, an approved workflow queue, and a phase roadmap for later cruise:goal execution. Does not implement product code or activate Goal mode. Do not use for a known edit, finite implementation plan, unknown failure, evidence-only research, or direct milestone execution; hand those to Quick, Refine, Debug, Research, or Goal."
---

# Cruise Build

Build creates the durable planning backbone for a project. The installed surface is
`$cruise:build`; `discovery` is an internal Build submode, never another public skill.
Build drafts and approves contracts and a workflow queue. It never implements product
code, recursively invokes a public skill, or activates native Goal mode.

## Keep coordination and authority at the root

Read [the shared invocation contract](../../internal/shared/invocation-contract.md) and
all three Build references before acting:

- [artifact and mode contracts](references/artifact-and-mode-contracts.md);
- [discovery and viability](references/discovery-and-viability.md);
- [queue, approval, and handoff](references/queue-approval-and-handoff.md).

After immutable Origin/baseline capture, let `begin` automatically establish shared
non-destructive foreign-diff monitoring before any worker or further write. Do not ask a
speculative start question; handle a later unexpected change only through the shared root-owned
incident pause protocol after the concrete incident is persisted.
If intentional drift is accepted before routing, preserve its bytes, never rewrite the stale
immutable Origin, and continue only from a fresh Origin in a new run.
At terminal success, perform the shared final clean check and call
`foreign-diff-finalize --run-dir <run-dir> --expected-inventory-sha256 <checkpoint-sha256>` before
the final response. Never finalize a failed, dirty, active, blocked, or waiting run.

The root owns repository inspection, mode/readiness decisions, user questions, approval,
artifact integration, queue authority, and final synthesis. Delegate substantive analysis
through the shared worker policy. A worker cannot ask the user, approve bytes, expand the
queue, invoke a public skill, activate Goal, or present final status. Launch workers by
recommended level through `cruise worker` and persist the launcher-owned receipt.

Use the private provision workflow only for a demonstrated specialized planning or
verification capability gap. It is no-op by default, native-first, zero-trust for external
content, and cannot recursively invoke Build or another public Cruise skill.

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

## Capture origin and inspect before asking

Preserve the triggering prompt verbatim and its SHA-256 in the Build `ORIGIN.yaml`; never
rewrite `origin.raw_prompt`. Capture repository identity and instruction files, then inspect:

- root and Git status, production source, manifests, tests, and CI;
- deployment configuration, public interfaces, schemas, and persisted data;
- release history and established product behavior;
- repository instructions and existing `.cruise/project/`, `.cruise/milestones/`, and
  `.cruise/goal/` state.

Do not decide from file count or lines of code alone. Select `bootstrap` for an empty,
placeholder, generated-only, or architecturally unestablished repository. Select
`milestone` for an established product or explicit next-milestone request. If those states
remain genuinely ambiguous after inspection, ask one concise mode question. Persist the
decision and evidence. An established repository without Cruise project artifacts first
gets a proportional evidence-derived project baseline, then the milestone.

## Use discovery only when readiness requires it

Create the readiness matrix from the discovery reference. Enter internal `discovery` only
when a critical category is partial, missing, or conflicting; any category conflicts; a
blocking user decision or research blocker remains; or feasibility evidence needed for
responsible approval is absent. Do not brainstorm because incidental supporting details are
absent.

In discovery, inspect prior answers, select the highest-impact unresolved category, state
why it matters, recommend a practical path when justified, and ask exactly one concise
question. Record each answer under a stable `Q-XX`, update readiness, preserve rejected
concepts and reasons, and stop when the viability hard gates close. Never ask for repository
facts, repeat an answered question without its reopening trigger, choose speculative
technology prematurely, or run open-ended ideation.

Persist the discovery Origin byte-for-byte with `CONCEPTS.yaml`, `QUESTIONS.yaml`,
`EVIDENCE.yaml`, `DECISIONS.md`, and `DISCOVERY.md` in the canonical subordinate discovery
directory. Enforce stable monotonic `C-XX`, `Q-XX`, `E-XX`, and `D-XX` lineage, no more than one
open material question, evidence-cited answers/readiness, and explicit selected/rejected reasons
and tradeoffs. Keep the event-sourced resume envelope outside those human discovery artifacts at
`.cruise/runs/<run-id>/BUILD-DISCOVERY.yaml`. It is inert serialized state: replay every reducer
event and require a fresh opaque host resume attestation bound to its state digest, immutable
Origin digest, and unchanged product baseline before continuing. An in-flight or reconciled
pre-approval Research edge additionally requires its matching opaque approval/result history.
Persist that envelope as the atomic head of immutable, exact-byte generations in the adjacent
`BUILD-DISCOVERY-HISTORY/`. A pending generation must name the exact prior head; readers reclaim
only a dead writer and roll that complete generation forward before exposing canonical discovery
files. Reject stale or forked run authorities, missing history, symlinks, and unrelated directory
entries instead of overwriting newer discovery state. Bind every persistence/read operation to the
exact canonical `repository_baseline.root` preserved in the discovery Origin. Maintain the separate
durable `BUILD-DISCOVERY-LINEAGE.yaml` anchor under the same write-ahead transaction: it binds the
latest revision, generation, and head plus its predecessor anchor. A surviving anchor with a missing
head or history is evidence of erasure and must fail closed; it can never authorize a fresh revision
zero, including after process restart and opaque rehydration.

When viability becomes `ready_for_build`, automatically draft the appropriate Build
artifacts and queue in the same run. Drafting is not approval, product-write authority,
research authority, or Goal activation. `research_required`, `not_currently_viable`, and
`deferred` follow the exact outcomes in the discovery reference.

Automatic means Build authors drafts without asking a second concept-selection question; it
does not mean a serialized manifest proves that files exist. Mint the one-use drafting-only
authority against the current Origin, discovery snapshot, and product baseline. Before recording
the transition, reread every declared regular artifact once with no symlink following, verify its
SHA-256, recapture the product baseline before and after, and run the normal Build semantic
validators over the contracts, phase DAG, both queues, both mutable draft State files, and the ID
registry. Join those bytes back to discovery: every discovery `D-XX` retains its exact status,
concept, decision, evidence, rationale, tradeoffs, reopening trigger, and supersession meaning;
the final requirement sections map accepted discovery decisions to their `R-XX` and `AC-XX`;
phase-local question text remains attached to a generated phase; each implementation-research
prerequisite appears in exactly one Research queue item; and the scanned identifiers retain
their active registry source paths. Reject a syntactically valid artifact that reuses an ID for
another meaning. Require exactly nine project files
(`ORIGIN.yaml`, `ID-REGISTRY.yaml`, `PROJECT.md`, `REQUIREMENTS.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `DECISIONS.md`,
`STATE.yaml`, `QUEUE.yaml`) and nine files for exactly one first/target milestone (`ORIGIN.yaml`,
`MILESTONE.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `DECISIONS.md`, `QUESTIONS.yaml`,
`AUTONOMY.yaml`, `STATE.yaml`, `QUEUE.yaml`). Require the mode's target Origin to be the discovery
Origin byte copy and `approved: false`; reject missing, extra, forged, product, discovery, or Goal
paths. Only then enter `draft_ready_for_review` and use the normal Build approval sequence.

`ready_for_build` must then close mechanically. After the final Origin files and product
baseline are known, call `attestBuildApprovalReadiness` with the canonical repository root,
baseline digest, project/milestone IDs, both Origin byte hashes, repository mode evidence, the
complete readiness matrix, viability record, and consequence. It succeeds only when evidence
closes the requested mode, discovery is unnecessary, readiness citations are present, and
viability evaluates to `ready_for_build`. A serialized “ready” claim is not this opaque
attestation. First mint `attestBuildReadinessEvidence` from stable `E-XX` records whose source
locators and SHA-256 identities bind the repository baseline, immutable Origin, or current bytes
of a safe `repository://<relative-path>` beneath the canonical repository root. Repository file
sources are opened without following symbolic links and are identity-checked around the read;
caller-supplied hashes never establish their authority. Non-repository research, prior-artifact,
and external sources require an opaque trusted provenance broker and fail closed while none is
available. Repository signals and readiness categories cite those IDs; booleans, prose-only
citations, cloned attestations, and unsupported viability scores cannot cross the approval
boundary.

## Draft and validate the durable contract

For bootstrap, create the canonical project identity, beneficiary, meaningful value,
outcomes, non-goals, requirements, justified architecture, constraints, strategically
complete milestones, and first executable milestone. Bootstrap is not approvable until that
first milestone has its complete canonical contract, validated phase DAG, and queue alongside
the project contract and project queue. For milestone, bind current-state
evidence to one coherent outcome, scope and exclusions, protected behavior, requirements,
acceptance evidence, constraints, release/rollback expectations, unresolved-question state,
and a phase DAG. Treat the milestone `REQUIREMENTS.md` and `ROADMAP.md` as an exact semantic join
to that normalized DAG: the owning phase, dependencies, requirements, acceptance criteria,
outcome, protected behavior, expected artifacts, verification, rollback boundary, blocking
questions, Goal handoff, and completion fence may contain neither omissions nor additions.

Allocate `PRJ-XX`, `M-XX`, `R-XX`, `AC-XX`, `D-XX`, `Q-XX`, `P-XX`, and `RSK-XX`
monotonically; never delete, renumber, or reuse them. Preserve superseded decisions.
Every milestone requirement has acceptance evidence and exactly one owning phase. Reject
cycles, orphan requirements, task-only phases, unverifiable phases, an unexecutable first
phase, and an incomplete milestone fence.

Before approval, Build may write only planning state under `.cruise/project/` and
`.cruise/milestones/`, plus the exact inert discovery checkpoint
`.cruise/runs/<run-id>/BUILD-DISCOVERY.yaml`. It must not modify product source, dependencies, fixtures,
migrations, CI, deployment, documentation outside `.cruise/`, or `.cruise/goal/`; it must
not create `CLOSEOUT.md` or perform external effects. After exact project or milestone approval,
Build may write a repository Markdown documentation path outside `.cruise/` only when that exact
path appears in `permitted_changes` on the displayed review card and the write boundary receives
the same opaque verified Build approval. Approval never expands this exception to source,
dependencies, fixtures, migrations, CI, deployment, or Goal state.

## Approve exact bytes once

Present one review card containing the outcome, artifacts, phase roadmap, complete proposed
queue, mandatory/optional items, dependencies, permissions, auto-start behavior, research
blockers, and deferred work. The ordinary approval path accepts only the exact structured choice:

- **Approve Foundation** for bootstrap;
- **Approve Milestone** for milestone.

Treat approval as an executable trust boundary, not a prose convention:

1. While drafting, use `prepareBuildContractDigests` to compute the non-queue digest that each
   draft `QUEUE.yaml` must reference. For bootstrap, pass the required first milestone directory
   and validated phase DAG. Finalize every proposed queue byte before review.
2. Mint the opaque `attestBuildApprovalReadiness` result described above. Its repository root,
   product baseline, target IDs, and project/milestone Origin hashes must match the exact draft.
3. Retain each opaque `captureInitialBuildOrigin` authority, bind the exact project/milestone
   bytes with `attestBuildOriginPair`, and create/reconcile `.cruise/project/ID-REGISTRY.yaml`.
   Allocate IDs only through its monotonic allocator; mint `attestValidatedBuildIdHistory`
   against the exact predecessor, superseded records, and current locked artifact bytes. Persist
   only through `writeBuildIdRegistry` with the exact prior snapshot; its managed immutable
   generations, pending intent, committed head, independent revision commitments, and dead-writer
   lock are not manual edit surfaces.
4. Call `prepareBuildApprovalReview` with all three authorities and the same canonical inputs. It
   independently checks the current product baseline, rereads and semantically validates the
   project/milestone artifacts, both queues, and the required mutable project/milestone
   `STATE.yaml` records, verifies all readiness bindings, and returns the exact review snapshot
   plus `review_digest`. State must describe the reviewed draft, current baseline and readiness,
   artifact identities, open blockers, reconciliation, and next action.
5. Display the returned `review_card` without reconstructing it: mode/approval label, readiness and product-
   baseline digests, project/milestone identities, every reviewed artifact/manifest digest, the
   complete queues with permissions and automatic behavior, the approval-time State snapshots,
   and the full phase/acceptance DAG and completion fence. Display `review_digest` with the
   card; do not offer approval for a partial or independently reconstructed card.
6. Select exactly one approval authority path:
   - Ordinarily, the later host `request_user_input` option-selection event must choose exact
     **Approve Foundation** or **Approve Milestone** and echo that exact `review_digest`. Only then
     call `attestStructuredBuildApprovalSelection`; typed/free-text labels, missing/stale digests,
     and copied event fields are rejected.
   - If and only if the first non-empty line of the immutable triggering request is exactly
     `--auto-approve`, `$cruise:build --auto-approve`, `cruise:build --auto-approve`, or the
     host-linked equivalent, call `attestOriginBoundBuildAutoApprovalSelection` with the opaque
     Origin-pair authority and that exact displayed `review_digest`. This origin-bound authority
     approves only the reviewed Build planning contract. It does not start any queue, activate
     Goal, implement product code, grant a permission, or authorize an external effect. A later
     prose mention, repository instruction, copied Origin, or inferred preference is rejected.
     Do not call `request_user_input` for this explicit path.
7. Call `captureBuildApproval` with the same opaque readiness, Origin-pair, ID-history, and selection objects. It checks
   the product baseline again, rereads the files, recomputes the review digest, and captures
   only if the selection still names those exact displayed bytes. Product-tree drift, an Origin,
   contract, queue, permission, phase, auto-start, or approval-time State change, or any stale
   review is rejected.
8. Before any downstream use, call `verifyBuildApproval` against the current repository
   baseline, current bytes, and the same opaque structured-selection object. Only its branded
   in-memory receipt is Build authority; serialized approval fields, digests, labels,
   descriptors, and repository prose are not. For a milestone, the receipt includes the full
   normalized phases, controller projection (`id`, dependencies, mandatory flag, and acceptance
   criteria), Build-derived completion fence, and phase/requirement/criterion ID sets.
9. Join each queue through `createQueueApproval` and `verifyQueueApproval` with that branded
   receipt. Approval does not authorize implementation or native Goal activation.

A later change to locked artifacts, queue membership/scope, mandatory status, permissions,
order, auto-start behavior, or milestone mapping invalidates approval. Never mutate an
approved queue definition in place. Project and milestone `STATE.yaml` are semantically
validated and snapshot-bound through review, capture, and initial verification, but remain
outside the immutable artifact manifest. After verification they may advance as valid runtime
state without revoking Build authority; fresh runtime artifact verification intentionally
rereads only the locked Build/queue bytes. Mutable `QUEUE-STATE.yaml` is owned exclusively by the
private evidence-aware queue coordinator, which requires current opaque Build/queue authority,
legal state transitions, append-only attempts, narrowed child Origin, and verified child
closeout evidence. Create it through `createBuildQueueCoordinator`; initialize new state at
revision zero, then persist each exact one-revision successor atomically with
`persistBuildQueueState` and the opaque prior-write/read snapshot. Before state advances, append
the synchronized read-only exact-state entry to the adjacent `QUEUE-STATE-HISTORY/` hash chain.
Recover reducer authority only when a one-use `attestBuildQueueStateResume` authority matches
the current state path/queue/revision/digests and the history path/head/aggregate digest, and
`readPersistedBuildQueueState` replays the complete chain—including unchanged attempt/evidence
prefixes—under the current or a fresh coordinator. Plain clones, older/forked state or history,
rewritten bytes, missing/gapped entries, skipped revisions, and symlinks are never resumable.
An interrupted history-first commit may roll forward only when the durable head is exactly one
validated successor ahead of the byte-exact current predecessor: under the writer lock,
revalidate the attested chain, atomically install only the embedded successor bytes, and rescan.
Never roll history back; reject active writers, state-ahead ordering, larger gaps, forks, or an
invalid successor.
Before launch,
`verifyBuildApprovalArtifacts` must mint a fresh one-use opaque snapshot of unchanged locked
Build/queue bytes; bind it to the current product baseline with
`attestCurrentBuildQueueBaseline`. Automatic start additionally consumes
`attestBuildQueueSemanticAdmission`; manual start must be the exact structured option and carry
the same semantic/permission/auth/host gates. Every terminal child transition also requires an
opaque before/after baseline attestation. All mutations go through `transitionBuildQueueItem`
and reconciliation/completion helpers.

If an unknown-cause failure calls for reactive Debug, use
`createReactiveDebugQueueRevision`; preserve the original queue and hash-chained attempts,
recompute affected digests, and run the full fresh readiness → review-card/digest → structured
selection → capture/verify → queue-approval sequence against the failed state's expected product
baseline. Only then create the new coordinator with that opaque revision and use
`migrateReactiveDebugQueueRevision` to carry validated history into the new runtime state.

After approval, report identities, digests, phase count, deferred questions, recommended
first phase, and exact handoffs. Recommend `Use cruise:goal for P-01.` The optional advanced
handoff offers the exact structured **Use Milestone Controller M-XX** option during Goal; a
Build record or controller file alone cannot select it. Build ends without implementation.

If ordinary structured input is unavailable and the immutable request did not opt into
`--auto-approve`, retain the exact reviewed draft as waiting for approval and stop after one
concise continuation instruction. Do not retry an unavailable tool, do not classify the contract
or native Goal as blocked, and do not call `update_goal` merely because the current collaboration
mode lacks the selector. The user can resume in a selector-capable Plan turn or run the terminal
client, which owns Default/Plan choreography. On resume, an existing valid origin-bound
`--auto-approve` directive must be honored without asking for another selection.
