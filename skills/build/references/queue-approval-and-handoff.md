# Queue, approval, and Goal handoff

## Contents

1. Declarative queue
2. Construction and approval
3. Private coordinator
4. Research and failures
5. Goal phase and milestone controller

## 1. Declarative queue

Build owns an immutable project `QUEUE.yaml` or milestone `QUEUE.yaml`. Runtime state lives in
`QUEUE-STATE.yaml`; never mix mutable status into the locked definition. The queue is a
declarative orchestration contract, not a script containing recursive public-skill calls.

```yaml
schema_version: 1
queue:
  id: QUEUE-M-003
  project_id: PRJ-01
  milestone_id: M-003
  origin_sha256: ""
  build_contract_digest: ""
  approved: false
  approved_at: null
items:
  - id: QI-01
    skill: research
    purpose: ""
    scope: ""
    status: draft
    mode: ""
    phase: null
    requires: []
    dependents: []
    consumes: []
    produces: []
    mandatory: true
    auto_start: false
    auto_start_conditions: []
    permissions_required: []
    capability_requirements: []
    acceptance_criteria: []
    parent_origin_sha256: ""
    child_origin_policy: inherit_and_narrow
    blockers: []
    attempts: []
    result: null
```

Locked definitions use `draft` items; mutable `queued`, `ready`, `running`,
`waiting_approval`, `waiting_auth`, `blocked`, `completed`, `failed`, `skipped`, and
`cancelled` belong in runtime state.

## 2. Construction and approval

Queue Research for feasibility or implementation evidence; feasibility-blocking research
belongs to the pre-approval discovery DAG, not the post-approval queue. Queue one Goal per
strategically complete phase by default or one explicit milestone-controller Goal. Queue
Refine only for a finite bounded pre-phase change that does not justify Goal and is not an
internal fallback during active Goal execution. Queue Quick only for deterministic
housekeeping and reapply Quick admission when ready. Debug is eligible only after a
reproducible predecessor failure whose cause is unknown, but it is never inserted into the
approved definition in place. Preserve the prior definition, state, and attempts; create a new
immutable queue revision containing the narrowed Debug item and obtain fresh Build approval.

Before a Goal that depends on post-approval Research can start, bind the exact
completed Research output names and SHA-256 digests to a one-use
`attestBuildQueueResearchReconciliation` authority. The structured reconciliation must mark
milestone requirements, phase scope, architecture, permissions, and acceptance criteria
consistent. An invalidated approved assumption or any conflict stops for Build contract
revision. The private host-interaction broker first binds that observation to the exact current
state and completed output bytes; only its opaque, ordered, one-use receipt can mint the
reconciliation authority. Both automatic and manual starts consume this authority. Manual start
also consumes a semantic gate receipt and exact structured option receipt from that same broker.
Raw or cloned events/receipts, an inline boolean, or a `semantic_admission` mapping in the option
event are not authority.

Validate a cycle-free DAG, existing dependencies, derived dependents, child outputs matching
consumer inputs, phase mapping, mandatory/optional distinction, explicit permissions, and
narrowed scope. Queue items may name only the post-Build executable lanes `research`, `goal`,
`refine`, `quick`, and reactive `debug`; Build, discovery, and the private provisioner are not
queue skills.

No Build review exists until `attestBuildApprovalReadiness` mechanically closes mode,
readiness, and viability and binds the canonical root/product baseline, project/milestone IDs,
and both Origin hashes. Finalized Origins also retain opaque initial-capture and paired-byte
authority. `.cruise/project/ID-REGISTRY.yaml` has separate opaque history authority bound to its
predecessor, superseded records, and each locked artifact's raw-content digest.
`prepareBuildApprovalReview` consumes all three authorities, rereads
and semantically validates both contracts and queues, checks the bindings, and returns the exact
review snapshot. Its `review_digest` covers the approval mode/label, readiness and product-
baseline digests, locked artifact manifest, every queue snapshot and active queue, and the full
milestone phase contract. It also strictly validates required project/milestone `STATE.yaml`
against that baseline, readiness, reviewed artifact identities, questions, reconciliation, and
next action; the approval-time State snapshots are covered by the review digest even though
State is not part of the immutable artifact manifest.

The card must show the complete queue—including mandatory/optional status, dependencies,
permissions, auto-start behavior, and every digest-bound artifact—plus the returned
`review_digest`. Exact **Approve Foundation** or **Approve Milestone** must then be selected
through the host's structured option, and the observed event must echo that same digest before
`attestStructuredBuildApprovalSelection` will mint its opaque receipt. `captureBuildApproval`
requires the same readiness, Origin-pair, and ID-history authorities,
checks the product baseline and rereads/recomputes the review; stale review authority or any
changed artifact/queue byte or approval-time State drift is rejected. `verifyBuildApproval`
performs the final current-byte and baseline check and mints the branded receipt. The persisted
review/approval record is audit data, not authority by itself.

Create and verify the queue approval only with that branded Build receipt. It binds the exact
queue path, definition digest, Build approval/manifest digests, permissions, and approval time.
Any definition change invalidates both approvals; `QUEUE-STATE.yaml` updates do not change
locked bytes but still require the private coordinator. Bootstrap approval covers both the
project and required first-executable-milestone contracts and both queue definitions.

## 3. Private coordinator

The private evidence-aware queue coordinator is the sole mutation path for
`QUEUE-STATE.yaml`; the legacy generic state updater is disabled. For every operation it
requires the opaque verified Build receipt and matching queue approval, validates the exact
definition/state join, checks phase and `consumes`/`produces` dataflow coverage, and permits
only an explicit legal transition. It appends immutable attempt records rather than replacing
history. Attempts form a replayable hash chain. Persist only the exact `QUEUE-STATE.yaml`
adjacent to the approved `QUEUE.yaml`: revision zero is the first write, and every changed write
must advance exactly one revision, present the opaque CAS snapshot returned by the prior exact
write/read, and preserve every earlier attempt/evidence entry as an unchanged prefix. First add
and synchronize the corresponding read-only `QUEUE-STATE-HISTORY/REV-NNNNNNNNNNNN.yaml` entry;
that hash-chained entry embeds the exact candidate state bytes and cannot replace an existing
revision. Only then atomically rename the synchronized private state temporary file. A crash or
interference can therefore leave an explicit history-ahead condition, never unrecorded advanced
state. When and only when the head is exactly one fully valid successor ahead of the exact
current predecessor, a fresh coordinator may deterministically roll forward: bind a one-use
host observation to both sides, acquire the writer lock (reclaiming it only when its bound PID is
dead), revalidate the entire chain and append-only reducer semantics, atomically install the
entry's embedded successor bytes, synchronize, and rescan. Missing state, a gap greater than one,
state-ahead ordering, a fork, invalid successor, changed bytes/history, or an active writer fails
closed without rollback or history deletion. The sole missing-state exception is an interrupted
first commit: one valid immutable revision-zero genesis entry may be attested with
`state_present: false` and installed once under the same lock/rescan protocol. Missing state at
any later revision fails closed.
If a writer dies before linking revision zero, persistence may treat an exact empty no-follow
history directory as uncommitted staging only while holding the writer lock, reclaiming only a
dead PID-bound lock and removing only exact private staging names before retry. The canonical
root must equal the root in the verified Build approval. Once genesis is durably committed, a
synchronized immutable marker under
`.cruise/QUEUE-STATE-COMMITMENTS/` binds the Build approval digest, queue identity/definition,
paths, and exact revision-zero state/history digests. A separate immutable hash-chained
commitment is appended for every later state-history revision. Deleting both adjacent runtime
artifacts cannot reset the queue. Each revision commitment embeds the exact local history-entry
bytes, so a crash after commitment publication but before the adjacent history link is repaired
under the writer lock; a stale host observation is rejected and must be renewed. Restoring both
runtime files to a mutually consistent older revision is detected and deterministically restored
to the durable latest head after re-verification or restart while the commitment lineage remains.
Publish the writer lock only after its complete PID/nonce metadata has been written and synced:
hard-link the private preparation inode to the canonical lock with no replacement, then sync the
parent. A crash before that link leaves only inert preparation data; malformed canonical locks
fail closed rather than being guessed or reclaimed.

Resume authority is not serialized in either file. The host observes the current queue/state
path, revision, canonical state digest, exact state-file digest, history path, history-head
digest, and aggregate exact-history digest, then passes that event to
`attestBuildQueueStateResume`. `readPersistedBuildQueueState` consumes the resulting opaque
attestation once, scans the complete contiguous history even under a newly created coordinator,
replays every one-revision successor and unchanged attempt/evidence prefix from the embedded
exact bytes, and requires the mutable state file to equal the history head before restoring
reducer provenance (after the single safe roll-forward case above, when necessary). Direct
object rehydration, cloned authority, older or forked heads, skipped
revisions, same-state/different-byte rewrites, missing/gapped/rewritten history, symlink state or
history files/directories, and non-adjacent paths fail closed. A definition item cannot jump
from `queued` to `running` or `completed`, and no item can complete from a status that was never
running.

Use `createBuildQueueCoordinator`, `initializeBuildQueueState` or
`persistBuildQueueState`, `attestBuildQueueStateResume`, `readPersistedBuildQueueState`,
`transitionBuildQueueItem`, `reconcileBuildQueueState`, and `buildQueueCompletionStatus` as the
runtime surface. `rehydrateBuildQueueState` deliberately rejects every plain object. Generic
state edits and the legacy updater are forbidden.

At launch, `verifyBuildApprovalArtifacts` rereads only the locked Build/queue bytes without
requiring the product tree to remain at its pre-execution baseline. Its fresh opaque snapshot is
consumed by `attestCurrentBuildQueueBaseline` together with a deterministic current product-
baseline observation for one ready item. At the final admission boundary, the coordinator
synchronously rereads and identity-checks every locked artifact and independently recaptures
the product baseline; a valid snapshot or observation minted before later drift is not launch
authority. The coordinator then requires a one-use admission from
either the canonical auto-start evaluator plus opaque `attestBuildQueueSemanticAdmission`, or
the exact structured manual **Start QI-XX** option carrying the same semantic, permission,
authentication, and host-continuation gates. Those gates and the manual choice must arrive as
ordered opaque receipts from one private host-interaction broker; caller-authored objects never
cross the launch boundary.
Project/milestone `STATE.yaml` may legitimately advance after approval and is deliberately
excluded from this runtime byte-lock check; changing any immutable contract or queue byte still
invalidates authority.
It verifies prerequisite output hashes against the child input manifest, records the launch
attempt and baseline, and passes a narrowed child Origin. A copied admission, raw boolean, typed
label, stale state revision, or reused artifact/baseline attestation is rejected.

Completion requires a one-use before/after product-baseline transition plus a current child
closeout whose queue/item/attempt/Origin IDs, unqualified outcome, result, produced output
hashes, and exact acceptance criteria match the running item. Mechanically validated Cruise
evidence must be newly recorded, actually performed, `PASS`, and explicitly support every
locked criterion; advisory evidence cannot satisfy a mandatory criterion. Only then may the
coordinator mark it complete, advance the expected repository baseline, unlock dependents, and
return control to the queue. Public skills never invoke each other recursively, and
authorization to use a tool or effect is not completion evidence.

Each child origin contains:

```yaml
parent:
  origin_sha256: ""
  queue_id: ""
  queue_item_id: ""
  project_id: ""
  milestone_id: ""
  phase_id: null
scope:
  inherited_outcome: ""
  narrowed_outcome: ""
  permitted_changes: []
  prohibited_changes: []
```

The child cannot expand beyond this scope or its own public contract.

Auto-start only when queue approval explicitly included `auto_start: true`, prerequisites
passed, baselines and artifact digests remain current, permissions/authentication are
satisfied, no mandatory ambiguity remains, the host truthfully supports continuation, and
the selected skill passes semantic admission. Otherwise mark `ready` or `waiting_approval`
and provide the exact next action. Runtime policy serializes mutating/effectful work. At most
four independent read-only Research items may run concurrently, only when dependencies and
ownership are disjoint and the host genuinely supports it; auth-blocked branches do not stop
eligible independent Research.

## 4. Research and failures

Pre-approval Research returns to the same Build discovery run, reconciles findings against
immutable origin, and may reopen readiness. Post-approval Research is read-only and may
precede a Goal only when its permissions and auto-start were approved. Reconcile its
conclusions against milestone scope, architecture, permissions, and criteria; contradictory
findings require contract revision, never silent milestone edits.

Classify failed items as implementation defect, invalid assumption, unavailable capability,
permission problem, authentication refusal, research contradiction, or contract defect.
Preserve attempts/evidence and use only approved fallbacks. For unknown cause, propose a
narrowed reactive Debug item in a new queue revision; never edit the approved queue or state to
manufacture it. Fresh semantic Build validation and structured approval must lock that revision
before the coordinator can launch it: mint new readiness authority at the failed state's expected
product baseline, prepare/display a new complete review and digest, require the digest-echoing
structured choice, capture/verify the new Build approval, and create a fresh queue approval. The
opaque revision records the failure evidence and superseded definition; only migration between
the old approved coordinator and that newly approved coordinator may carry forward validated
evidence and hash-chained attempts. Revise the Build/milestone contract when the contract is
invalid. Never silently remove mandatory work or declare completion while it is failed/blocked.

The private provisioner remains optional, native-first, and no-op by default. A queue item
can wait for authentication; dependent items wait, independent items may proceed, and an
unavailable mandatory capability blocks honestly. Provisioning never expands queue or child
authority.

## 5. Goal phase and milestone controller

The default handoff is `Use cruise:goal for P-01.` Each phase gets its own immutable Goal
plan, exact **Approve Plan**, later exact **Start Cruise**, native activation, verification,
and closeout after activation.

The advanced path is eligible only when the current Goal session observes the exact structured
**Use Milestone Controller M-XX** option and joins its opaque receipt to a fresh branded Build
receipt for the same approved milestone. Goal then uses hierarchical milestone-controller mode
and just-in-time phase plans; it never flattens the milestone into one PLAN. The Goal
milestone-controller reference defines its persisted phase state, closeout/completion
attestations, dangerous question-suppression grant, and hard stops. Build approval itself never
selects or activates that controller.

`DANGEROUSLY-TRUST-CRUISE` applies only inside an already approved milestone-controller Goal.
It cannot approve or alter Build artifacts, the queue, research, dependencies, permissions,
provisioning, authentication, or scope.
