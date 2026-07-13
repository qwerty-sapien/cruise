# Build artifact and mode contracts

## Contents

1. Mode evidence
2. Immutable origin
3. Project artifacts
4. Milestone artifacts
5. Stable records and validation

## 1. Mode evidence

Select `bootstrap` when repository evidence shows no meaningful product source, established
manifest, tests, product architecture, or deployed behavior; an explicit initialization
request is also decisive. A README, ignore file, empty directories, placeholder files, or a
generated framework scaffold without product behavior remains bootstrap evidence.

Select `milestone` when evidence shows established production source and architecture,
tests/builds, public interfaces or persisted data, releases/deployment, canonical project
state, or an explicit next-milestone request. When an established repository has no Cruise
project state, create a proportional project baseline from observed evidence before drafting
the milestone. Ambiguous teaching/experiment repositories get one short mode question.

Persist:

```yaml
build:
  mode: bootstrap
  mode_candidate: bootstrap
  mode_evidence: ["generated scaffold only"]
  target_project: PRJ-01
  target_milestone: null
```

Discovery is a temporary internal run submode whose immutable Origin `mode` and
`mode_candidate` remain `bootstrap` or `milestone`. Persist its six subordinate records under
the canonical `discovery/` directory and its inert event/recovery envelope at
`.cruise/runs/<run-id>/BUILD-DISCOVERY.yaml`, never by rewriting Origin mode or overloading the
approved project/milestone `STATE.yaml`.

## 2. Immutable origin

Each Build or discovery root uses the shared immutable-origin principles:

```yaml
schema_version: 1

origin:
  raw_prompt: |
    <verbatim triggering prompt>
  prompt_sha256: ""
  captured_at: ""
  selected_skill: build

repository_baseline:
  root: ""
  head: null
  branch: null
  dirty_state_digest: ""
  instruction_files: []

routing:
  deterministic_probe_digest: ""
  initial_classifier: ""
  selected_route: build
  confidence: 0.0
  promotion_reasons: []

build:
  mode: bootstrap
  mode_candidate: bootstrap
  mode_evidence: ["generated scaffold only"]
  target_project: PRJ-01
  target_milestone: null

goal:
  outcome: ""
  non_negotiables: []
  success_criteria: []
  exclusions: []
  permitted_inferences: []
  unresolved_questions: []

change_ledger: []
```

Never rewrite `origin.raw_prompt`, its digest, capture time, or repository identity.
The schema-bound Build mode candidate, evidence, and target IDs are also immutable for that
Origin. Discovery progress changes only its replayable run envelope, readiness, concepts,
questions, evidence, decisions, and synthesis; it does not change Origin mode. Rehydration
requires a fresh host attestation bound to the exact serialized state, Origin, and product
baseline, so a repository-authored status cannot restore authority. Clarifications change
normalized artifacts and append ledger entries. A queued child gets a new narrowed origin that references this parent; it never
creates an unrelated origin.

## 3. Project artifacts

Use exactly this source-of-truth area:

```text
.cruise/project/
├── ORIGIN.yaml
├── ID-REGISTRY.yaml
├── PROJECT.md
├── REQUIREMENTS.md
├── ARCHITECTURE.md
├── ROADMAP.md
├── DECISIONS.md
├── STATE.yaml
└── QUEUE.yaml
```

Add `QUEUE-STATE.yaml` and its adjacent `QUEUE-STATE-HISTORY/` only after queue runtime exists.
During discovery add the subordinate `discovery/` directory described in the discovery
reference. Neither queue-runtime artifact is a general edit surface: only the private
evidence-aware queue coordinator may create or advance them from a verified Build receipt and
matching queue approval. State binds the immutable definition,
Build/queue approvals, expected product-baseline digest, bounded concurrency policy, state
revision, per-item mechanically validated evidence, hash-chained attempts, active input/baseline
manifest, and evidence-bound result/closeout. History durably preserves one exact-byte,
predecessor-hashed state snapshot per revision before the mutable head advances.

Registry persistence also owns `ID-REGISTRY-HISTORY/`, `ID-REGISTRY-HEAD.yaml`, and the
transient `ID-REGISTRY-PENDING.yaml` and `ID-REGISTRY.yaml.lock` companions beside the canonical
registry, plus the independent `.cruise/ID-REGISTRY-COMMITMENTS/` lineage fence. They are protocol
state, not author-editable project artifacts and not additional approval-manifest entries.

`PROJECT.md` contains name, one-sentence identity, beneficiary, core value, measurable
outcomes, non-goals, context, protected principles, constraints, success measures, maturity,
and canonical terminology.

`REQUIREMENTS.md` contains project-level `R-XX` requirements with source/decision links,
`AC-XX` criteria, priority, target milestone, status, and verification class. Do not replace
requirements with implementation tasks.

`ARCHITECTURE.md` records only evidence-justified context/boundary, major components, data
ownership, interfaces, deployment assumptions, security/privacy, observability, testing,
performance, rejected alternatives, unresolved questions, and reopening triggers. Mark
speculation and defer phase-local details.

`ROADMAP.md` defines strategically complete milestones. Each must yield a usable outcome,
safely deployable transition, validated foundation, or decision-complete research result.
“Write tests,” “create models,” “add docs,” and “refactor code” are tasks, not milestones.
Bootstrap must fully materialize the first such milestone under `.cruise/milestones/`; a
project-only foundation cannot receive **Approve Foundation**.

Project `STATE.yaml` is a strict `cruise_project_state` record. At approval it describes the
reviewed draft project and active milestone, lists completed milestones, has no project-blocking
open questions, and binds the current product-baseline and readiness digests. Its artifact
identities must equal the reviewed Origin bytes, project contract digest, and project queue
definition digest; its last reconciliation must name the same baseline, and its recommended
next Cruise command must be non-empty.

## 4. Milestone artifacts

Use:

```text
.cruise/milestones/<M-ID>-<slug>/
├── ORIGIN.yaml
├── MILESTONE.md
├── REQUIREMENTS.md
├── ROADMAP.md
├── DECISIONS.md
├── QUESTIONS.yaml
├── AUTONOMY.yaml
├── STATE.yaml
├── QUEUE.yaml
└── phases/
```

`MILESTONE.md` contains ID/name, outcome/beneficiary, project-goal relationship, current
evidence, scope/non-goals, protected behavior, completion fence, constraints, release and
rollback expectations, permissions, risks, and phase summary.

Every milestone requirement maps to at least one `AC-XX`, exactly one `P-XX`, prerequisite
phases, verification evidence, and protected project principles. The roadmap is a DAG whose
phase records contain:

```yaml
phase:
  id: P-01
  name: ""
  outcome: ""
  strategically_complete: true
  mandatory: true
  depends_on: []
  requirements: []
  acceptance_criteria: []
  protected_behavior: []
  expected_artifacts: []
  verification: []
  rollback_boundary: ""
  blocking_questions: []
  goal_handoff: ""
```

The requirement sections and roadmap phase sections are an exact semantic join to the
normalized approved DAG, not advisory prose. For each requirement, require the exact owning
phase, prerequisite list, phase acceptance-criterion list, verification list, and protected
behavior list. For each roadmap phase, require the exact outcome, dependencies, requirements,
acceptance criteria, protected behavior, expected artifacts, verification, rollback boundary,
blocking questions, and Goal handoff. Reject extra values as well as missing values, and require
the completion fence to equal the ordered mandatory-phase verification set.

Prefer vertical outcome slices. Validate no cycle/orphan, one owner per requirement and
criterion, independent phase evidence, executable P-01, no later assumption of unapproved
outcomes, coherent rollback boundaries, and a completion fence aggregating every mandatory
phase result. `strategically_complete: true` is a claim, not proof: reject generic task-only
names/outcomes such as “write tests,” “create models,” “add documentation,” or “refactor code”
including variants with trailing targets such as “write tests for billing” or “refactor the
invoice service.” A beneficiary, capability, or deployability keyword alone is not proof. The
outcome itself must state an independently useful transition, a usable/deployable capability,
or what an identified beneficiary can receive or do.

Milestone `STATE.yaml` is a strict `cruise_milestone_state` record. At approval it describes the
reviewed draft project/milestone, has no active or completed phase, and lists exactly the open
`Q-XX` records from `QUESTIONS.yaml`. It binds the same product baseline and readiness digest,
the reviewed milestone Origin/contract/queue identities, and a matching last reconciliation;
its recommended next Cruise command must identify an approved phase.

`ID-REGISTRY.yaml` is the append-only project-wide history for active and superseded
`PRJ/M/R/AC/D/Q/P/RSK/C/QI` IDs. Approval requires its exact predecessor, revision chain, and
the current locked artifact content manifest through opaque history authority; serialized
counters and caller-selected IDs are not authority.

Persist the registry only at the exact `.cruise/project/ID-REGISTRY.yaml` beneath its immutable
Origin repository root. Each commit first records a durable pending intent bound to the exact
prior committed-head digest, then hard-links one immutable generation containing the exact
registry YAML bytes and predecessor hash, appends the same head identity to the independently
keyed durable commitment lineage, atomically replaces the canonical mirror, and finally atomically
advances the hash-chained committed head. File and containing-directory metadata are synced at
every durable boundary. Writers use a PID/nonce lock; only a structurally valid lock whose PID is
no longer alive may be reclaimed, and recovery completes the exact pending candidate instead of
allocating another revision.

Updates require the exact prior registry snapshot (compare-and-swap) and advance exactly one
revision. Retrying the same candidate after an interrupted commit may present that candidate's
exact predecessor snapshot and returns the already committed revision. A first persisted registry
may be an imported revision greater than zero; it becomes an explicit history anchor rather than
being renumbered. Legacy standalone registry files remain readable and migrate on the next
authorized write. A fresh process reconstructs a deleted canonical mirror from surviving validated
history and committed head; a rolled-back mirror, truncated/forked history, stale head, or deletion
behind either the durable commitment lineage or an already observed live head fails closed. The
independent lineage also prevents a fresh process from treating deletion of the complete project
registry store as a new revision-zero registry.

Before approval review, mechanically attest readiness/viability against the exact canonical
repository root, product-baseline digest, `PRJ-XX`/`M-XX`, and project/milestone Origin hashes.
Use `attestBuildReadinessEvidence` to bind monotonic `E-XX` records, source locators, source
digests, claims, certainty, and supported repository/readiness/viability targets. Preserve the
special `origin://project`, `origin://milestone`, and `repository://baseline` bindings. For any
other `repository://<relative-path>` locator, canonicalize the repository root, reject unsafe or
symlinked paths, open without following links, identity-check the file before and after reading,
and compare the claimed digest with its current bytes. A caller-provided digest is never source
authority. Research, prior-artifact, or external locators outside the repository require opaque
trusted provenance and fail closed when no such broker is available. Approval-mode signals and
every closed readiness category cite those exact IDs; raw booleans, arbitrary prose, and a cloned
evidence object fail.
Also require the opaque initial project/milestone Origin pair and validated ID history. Then
prepare the review snapshot from current regular non-symlink files and show its complete
artifact/queue/State/phase card plus exact `review_digest`. The structured approval event must
echo that digest; capture rereads and rejects a stale review or any intervening product,
artifact, queue, or State drift.

At approval, lock the canonical project files and selected milestone files plus both required
project and milestone `QUEUE.yaml` definitions. In bootstrap the selected milestone must be the
first executable milestone; in milestone mode it is the new coherent milestone. Required
project/milestone `STATE.yaml` remains outside the immutable manifest but is semantically
validated and snapshot-bound in the review, capture, and initial verification digests so it
cannot change inside the approval transaction. Once the verified receipt exists, valid runtime
State updates are deliberately not byte-locked by `verifyBuildApprovalArtifacts` and do not
revoke queue authority. `QUEUE-STATE.yaml`, its append-only `QUEUE-STATE-HISTORY/`, discovery
records, the private `.cruise/QUEUE-STATE-COMMITMENTS/` rollback fence, and phase runtime files also
remain outside the immutable manifest. Queue state must live exactly beside its approved
`QUEUE.yaml`; its atomic persistence CAS binds the queue/path, one-revision successor,
canonical state digest, exact file-byte digest, and the adjacent read-only
`QUEUE-STATE-HISTORY/` head/aggregate digest. Each immutable history entry contains the exact
state bytes and chains to its predecessor, so a fresh coordinator can replay unchanged
attempt/evidence prefixes and reject rollback, forks, gaps, or history/state disagreement. A
root-bound immutable genesis marker and per-revision commitment chain keyed by Build approval
digest and queue ID prevent deleting those two adjacent runtime artifacts from being mistaken
for a new queue. The per-revision commitment embeds the exact local history-entry bytes so one
pre-link crash tail can be materialized under the writer lock; a consistent older local head is
then restored to the durable latest revision after re-verification or restart. A
one-use host resume attestation is required to restore opaque reducer authority from those
bytes. The sole recoverable disagreement is an interrupted commit whose history head is exactly
one validated successor ahead of its byte-exact current predecessor; the coordinator installs
that embedded head atomically under the writer lock and rescans without changing history. Larger
gaps, state-ahead order, invalid successors, forks, and active locks fail closed. Semantic
validation precedes byte capture; non-empty files and matching hashes alone are insufficient.

## 5. Stable records and validation

`QUESTIONS.yaml` entries use stable `Q-XX` IDs and statuses `open`, `answered`, `assumed`,
`deferred`, or `superseded`. Record materiality (`project_blocking`, `milestone_blocking`,
`phase_blocking`, `nonblocking`), category, evidence, recommendation, options, answer/source,
affected IDs, timestamps, and reopening trigger. Never repeat a question unless its trigger
occurred. All project/milestone blockers close before approval; phase-local questions remain
attached to their owning phase. Options contain zero (free text), two, or three real choices.
A deferred question may either remain unanswered with all resolution fields null or record an
explicit deferral answer/source/timestamp; partial resolution fields are invalid.

`AUTONOMY.yaml` defaults to `mode: interactive`. It preserves approved outcome,
compatibility, repository patterns, reversibility, dependency/permission restraint, and the
evidence-backed recommendation. Hard stops include outcome/mandatory-requirement changes,
permission expansion, destructive effects, authoritative conflicts, unavailable mandatory
evidence, unsafe rollback, security/privacy changes, required authentication without an
approved fallback, locked-artifact drift, and unexplained baseline drift.

Allocate `PRJ-XX`, `M-XX`, `R-XX`, `AC-XX`, `D-XX`, `Q-XX`, `P-XX`, and `RSK-XX`
monotonically. Never reuse IDs or erase superseded history.
