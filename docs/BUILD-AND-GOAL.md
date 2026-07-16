# Build and Goal

Build creates durable, approved planning contracts. Goal executes consequential work against locked contracts and evidence gates. Their approvals are separate and non-transferable.

## Workflow boundary

| Workflow | Produces | Does not authorize |
| --- | --- | --- |
| Build | Foundation or milestone contracts, phase DAG, approved queue | Product code, Goal activation, external effects |
| Goal preparation | Inactive Goal artifact suite and reviewed plan | Implementation |
| Goal activation | Verified native Goal and bounded execution authority | Work outside the locked scope or permission envelope |

## Build

### 1. Select a mode from evidence

| Mode | Admission |
| --- | --- |
| Bootstrap | Empty, placeholder, generated-only, or architecturally unestablished repository |
| Milestone | Established product or explicit next-milestone request |

File count alone never selects the mode. An established repository without Cruise state first receives a proportional baseline from observed evidence.

### 2. Run discovery only when needed

Discovery activates for:

- a missing or conflicting readiness category;
- a blocking user decision; or
- absent feasibility evidence.

It asks one material question at a time and preserves `Q-XX` alternatives, answers, reasons, and tradeoffs.

| Viability gate | Required signal |
| --- | --- |
| Beneficiary | A concrete user or stakeholder |
| Outcome | A meaningful change in capability or experience |
| Scope | A coherent boundary |
| Implementation | A plausible path exists |
| Verification | Completion can be demonstrated |
| Constraints | Known constraints are compatible |
| Consistency | No fatal contradiction remains |

Passing viability creates drafts automatically; it does not approve them.

### 3. Draft the canonical contract

```text
.cruise/project/
├── ORIGIN.yaml
├── ids.yaml
├── PROJECT.md
├── REQUIREMENTS.md
├── ARCHITECTURE.md
├── ROADMAP.md
├── DECISIONS.md
├── STATE.yaml
└── QUEUE.yaml

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

The review transition requires exactly the nine project files and nine target-milestone files. Product, discovery, Goal, missing, extra, symlinked, or forged paths fail closed. Both mutable draft State files, the phase DAG, both queues, the ID registry, and baseline/readiness bindings must pass semantic validation.

### 4. Approve exact bytes

| Mode | Exact structured option |
| --- | --- |
| Bootstrap | **Approve Foundation** |
| Milestone | **Approve Milestone** |

Build displays a self-contained review card and digest. The card covers:

- mode and required label;
- readiness and product baseline;
- locked artifacts and their raw-content digests;
- project and milestone queues;
- approval-time State snapshots; and
- phase and acceptance contracts.

The later host event must echo the digest with the exact choice. Build then rereads the canonical files and recomputes the digest. Drift in product bytes, Origin, contracts, queues, permissions, phases, or approval-time State invalidates the selection.

A typed label, copied record, digest, descriptor, repository instruction, or `{accepted: true}` object is not an approval receipt.

#### Unattended planning-only approval

The immutable request header may carry the exact directive:

```text
$cruise:build --auto-approve

Establish this project foundation and first milestone.
```

Terminal equivalent:

```sh
cruise build --auto-approve -C ~/src/app "Establish a reviewed planning foundation"
```

The directive is bound to the later displayed review digest. It approves planning contracts only. Queues remain non-starting; code, Goal activation, permissions, and effects keep their own gates. A flag mentioned later in prose or copied from repository content carries no authority.

### 5. Persist the approved queue

The queue is an immutable DAG of narrowed Research, Goal, Refine, Quick, or already-approved Debug work. `queue-run.yaml` is mutable only through the private coordinator.

| Queue rule | Enforcement |
| --- | --- |
| Start | Fresh locked-artifact and product-baseline attestation plus one-use semantic admission |
| Inputs | Child hashes must match approved predecessor outputs |
| Research → Goal | One-use reconciliation must find requirements, scope, architecture, permissions, and acceptance consistent |
| Completion | Fresh PASS evidence for every locked criterion and a matching baseline transition |
| Parallelism | Mutating work is serialized; disjoint read-only Research may overlap when the host schedules it |
| Failure | Unknown-cause work requires a newly reviewed queue revision; Debug is not inserted in place |

Queue history is hash-chained and replay-validated. Each transition advances one revision from the exact prior snapshot, persists an immutable history entry before the canonical state changes, and preserves attempt/evidence prefixes. Gaps, forks, stale snapshots, skipped revisions, rewritten equivalent YAML, unsafe links, or state/history disagreement fail closed.

Durable commitments prevent deleting local state and history from minting a new revision-zero queue. Recovery can roll forward a uniquely committed tail or restore the latest durable head; ambiguous rollback never becomes authority.

<details>
<summary>Build persistence and approval internals</summary>

The ID registry uses exact-snapshot compare-and-swap with an adjacent immutable history, a committed head, private pending/lock files, and an independent commitment fence. A fresh process can restore a deleted canonical mirror from the validated chain, but it cannot turn deletion into a new revision-zero registry. Rollback, truncation, forks, and stale snapshots fail closed.

Discovery keeps its canonical artifacts subordinate to the project or target milestone. Its inert run checkpoint is the atomic head of hash-chained generations. A write-ahead intent binds the prior head before canonical files change, and an independent lineage anchor prevents a surviving commitment from being silently reset when history disappears. Serialized `status` never restores authority by itself: Origin, product baseline, and completed Research edges must revalidate.

Build approval is one executable transaction:

1. Readiness, initial Origin-pair, and current registry-history authorities prepare the review.
2. Canonical contracts, queues, State snapshots, baseline, and readiness bindings are reread and semantically validated.
3. The complete review card and digest are displayed.
4. The ordered host event echoes the digest with the exact label.
5. Capture rereads the same authorities and current bytes.
6. A final verifier mints the opaque receipt used downstream.

State is locked across that approval transaction but remains outside the immutable contract manifest so it can advance afterward. Every approved contract and queue byte is still reverified at runtime.

Queue persistence writes an immutable exact-state history entry before advancing the canonical state. A fresh coordinator replays the full chain and requires the state file to equal its head. It may recover only a uniquely committed next entry, including the narrow first-commit case where revision-zero history exists but the canonical state rename did not complete. Active writers, gaps, forks, invalid successors, state-ahead histories, stale observations, unsafe links, and rewritten equivalent YAML fail closed.

Writer-lock metadata is fully synchronized in a private preparation inode before an atomic no-replace link publishes the canonical lock. An interrupted prepublication file has no authority, while a dead PID-bound published owner can be reclaimed under the recovery protocol.

</details>

## Goal

### Single-slice Goal is the default

A milestone file or `ROADMAP.md` alone does not activate milestone control.

1. **Inspect.** Resolve the one Goal-specific needs/autonomy envelope, with answer-driven detail only when requested.
2. **Prepare.** Write PLAN.md and GOAL.md together as one inactive candidate under `.cruise/goal/`.
3. **Present.** Bind the final Plan and Goal revisions before rendering either the observed GUI-native item or deterministic Cruise preview.
4. **Review and decide.** In Codex GUI, use an actually observed native combined Plan item when available; otherwise immediately show Cruise's deterministic combined preview with meaningful excerpts, full-file links, and both bound revisions. Apply one structured **Approve both**, **Refine**, or **Reject both** decision to the pair.
5. **Activate.** Recheck the complete-suite snapshot, return to Default mode, set and verify native Goal state, then launch bounded workers.

### Inactive Goal artifacts

```text
.cruise/goal/
├── ORIGIN.yaml
├── SPEC.md
├── DECISIONS.md
├── ALIGNMENT.md
├── PLAN.md
├── GOAL.md
└── ROADMAP.md   # only when strategically necessary
```

`CLOSEOUT.md` is forbidden before activation. Candidate bytes are not edited after the combined **Approve both** selection.

### Approval meanings

| Action | Locks | Authorizes |
| --- | --- | --- |
| **Approve both** | Displayed Plan, Goal, supporting contract bytes, and repository baseline | Native Goal activation after the complete snapshot revalidates |
| **Refine** | Nothing | Reopens Plan and Goal together for a targeted revision |
| **Reject both** | Nothing | Keeps implementation and external effects inactive |

Free text that repeats **Approve both** is not an approval event.

## Goal after Build

The standard handoff is:

```text
Use cruise:goal for P-01.
```

It consumes one approved, strategically complete phase through the same combined Plan-and-Goal/native-Goal protocol.

### Milestone controller

Milestone-wide control activates only when:

1. the current host selector records **Use Milestone Controller M-XX**; and
2. that opaque selection joins a fresh verified Build receipt for the same milestone.

A queue file, controller YAML, approval snapshot, or repository prose cannot authorize this mode.

| Controller stage | Required proof |
| --- | --- |
| Before a phase | Repository identity, previous closeout, ready dependency state, just-in-time Plan bytes, ownership, permission scope, and pre-phase baseline |
| Phase closeout | Current Plan, Closeout, Evidence, PASS coverage for every Build criterion, and post-phase baseline |
| Milestone closeout | Separate aggregate attestation equal to the Build completion fence |
| Resume | Provenance-branded state, matching phase projections, locked artifacts, evidence, and current baseline |

The controller never flattens a whole milestone into one Plan or rewrites approved top-level Build artifacts. A changed outcome, mandatory requirement, criterion, dependency, permission, protected behavior, or completion fence returns to Build revision.

### Dangerous question suppression

Interactive control is the default. A separate direct-user event may exchange a digest-bound warning token:

```text
DANGEROUSLY-TRUST-CRUISE <M-ID> <12-character-contract-digest>
```

The one-use grant suppresses discretionary questions only. It does **not**:

- approve Build, queue, Plan, or Goal bytes;
- add work or widen scope;
- widen permissions or bypass authentication;
- bypass sandbox, provisioning, dependencies, or evidence;
- weaken security, privacy, rollback, or hard-stop rules; or
- guarantee completion.

Drift before grant consumption invalidates it. Locked-artifact or permission drift, cancellation, completion, a new run, or revocation ends it.

## Host and terminal behavior

The bundled `cruise <skill>` client owns the thread’s Default/Plan transitions. For Goal it also restores Default before `thread/goal/set`, verifies the returned Goal, and only then executes.

An already-started ordinary `$cruise:*` turn cannot retroactively take mode ownership. If that host cannot finish in its current mode, Cruise hands off once to the matching terminal command; it does not ask the user to toggle modes and retry in a loop.

The terminal picker supports:

- Up/Down navigation;
- Enter or Space selection;
- immediate `1`–`9` selection; and
- `q`, Escape, or Ctrl-C cancellation.

Plan phases are read-only. Default phases receive only the selected skill’s write boundary, with network and escalation disabled. Cruise does not inject keystrokes, synthetic approval text, or a root-model change.

The standalone client cannot resolve an existing milestone-controller Build approval by itself. Run that path from ordinary Codex while the Build receipt remains in scope, or use an embedding that supplies the opaque resolver and retains the live controller driver until ownership ends.

<details>
<summary>Embedding contract for milestone control</summary>

A resolver-capable Node host imports `cruise-codex-plugin/session` and passes `resolveBuildApproval`. After controller selection, combined Plan-and-Goal approval, and confirmed native Goal activation, the session returns the same live `controllerDriver` and emits `milestoneControllerReady`.

The driver retains the opaque controller, Build, activation, and state authorities. It exposes named operations for persistent questions, phase activation and closeout, hard stops, milestone completion, dangerous-question suppression, reload, and explicit close. The embedding keeps it live for the controller run and calls `driver.close()` when ownership ends.

If bootstrap cannot safely create or reload canonical milestone state, the session pauses and rechecks the objective and task identity of the just-activated native Goal. If another Goal replaced it, Cruise leaves that Goal unchanged and stops its app-server.

Hosts that already own the approved combined Plan-and-Goal boundary may import `cruise-codex-plugin/milestone-controller-host`. The factory accepts only the strict canonical Build draft State bound to the verified receipt’s project, milestone, baseline, readiness, Origin, contract, queue, question, and phase identities. Durable controller history is loaded and reconciled before a stale Build-draft mirror is interpreted.

</details>

## Legacy compatibility

Locked Goal suites using `N-XX` and `VG-XX` remain readable and are never rewritten in place. If their `ORIGIN.yaml` is missing, Cruise records that the legacy Origin is unavailable; it does not invent prompt bytes. New activation requires explicit reconciliation into a new Origin-bearing candidate while preserving the old suite for audit.

## Related reference

- [Architecture and safety](ARCHITECTURE.md)
- [Operations](OPERATIONS.md)
- [Goal skill contract](../skills/goal/SKILL.md)
- [Build skill contract](../skills/build/SKILL.md)
