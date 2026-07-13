# Cruise

Cruise is an independent Codex plugin for choosing the smallest workflow that fits repository work, preserving the original request, and closing against explicit evidence. It has exactly six public skills, seven launcher-managed worker levels, and an optional terminal client for the full native Goal workflow.

## Choose a skill

```text
Starting a project or milestone?       cruise:build
Know the exact small change?           cruise:quick
Need a finite plan before coding?      cruise:refine
Need durable consequential execution?  cruise:goal
Have a failure with unknown cause?     cruise:debug
Need evidence before deciding?         cruise:research
```

The lanes are mutually exclusive by primary intent and what is already known:

| Skill | Use it for | Boundary and next handoff |
| --- | --- | --- |
| `$cruise:build` | A durable project foundation, practical discovery when critical inputs are missing, or the next coherent milestone | Produces approved contracts, a phase DAG, and a persistent queue. It never implements product code or activates Goal. |
| `$cruise:quick` | An exact, low-risk change with closed callers and local proof | Before editing, hands unknown-cause symptoms to Debug, material decisions to Refine, durable/consequential work to Goal, and evidence gaps to Research. |
| `$cruise:refine` | A finite known outcome that needs a few material decisions and an approved current-thread plan | Does not create a roadmap or native Goal. Hands newly unknown failures to Debug and work needing durable continuation to Goal. |
| `$cruise:goal` | Consequential, cross-system, strategically sliced, permission-heavy, or recovery-sensitive work, including one approved Build phase or an opaque-authorized milestone controller | Requires separate Plan approval and later Start authorization before native activation. Hands a smaller finite outcome to Refine and evidence-only work to Research. |
| `$cruise:debug` | An observed failure whose root cause is unknown | Proves the cause, then makes the smallest verified repair. Hands unresolved desired behavior to Refine and a durable cross-system repair to Goal. |
| `$cruise:research` | Read-only evidence acquisition, reconciliation, option comparison, dependency evaluation, or feasibility work | Delivers a source-backed brief. Implementation starts through Refine or Goal, or Quick only when the resulting edit is proven trivial and fully resolved. |

The previously implemented public Review proposal is retired from the Cruise surface
to keep six distinct lanes. Existing schema-v1 Review Origin, handoff, and run-state records
remain readable but cannot start or resume a public Review run. Use native Codex review or
the GitHub review capabilities for read-only assessment.

## Root-managed worker architecture

The root agent is always the coordinator. Cruise never changes the root model. The root owns deterministic routing, user-facing questions, Plan/Start approvals, permission requests, native Goal activation, worker launching, integration, conflict resolution, and final synthesis. Every substantive mapping, planning, implementation, diagnosis, experiment, repair, review, research, synthesis, and independent-verification phase runs in a bounded worker thread.

`cruise worker` creates the bounded worker thread through Codex app-server. Each launch is bound to Origin/baseline identities, stable task/evidence IDs, exact path ownership, allowed effects and permissions, dependencies, limits, and stop conditions. Workers cannot ask the user questions, approve a plan, grant permission, activate a Goal, reroute, integrate sibling changes, or deliver the final response. They return immutable attempt reports inside a launcher-owned runtime envelope.

A bounded deterministic repository probe informs routing. After atomic Origin capture, routing requires a YAML-only semantic assessment bound to the exact prompt hash and immutable repository baseline. It provides an evidence-bound verdict for each of the 18 Quick gates; every verdict points to a verified prompt byte span, repository file hash, or baseline digest. Conservative request patterns still activate obvious OAuth/auth or exported/public-API gates when an assessment omits them. Persisted count/byte/time caps prevent broad ingestion, and routing fails closed on an absent, partial, stale, or over-budget assessment. The root coordinator applies the deterministic route and records a `recommended_level` before any substantive worker is launched. Under residual uncertainty the user-selected skill wins; a deterministic semantic conflict causes one explicit handoff, never a silent route or recursive routing loop. Quick has hard promotion gates for public API/ABI, security/privacy, schema or serialized data, dependencies, concurrency/lifecycle, build/release, dynamic callers, external effects, insufficient testability, research, material design, expanded scope, or repeated failed repair.

## Origin, state, and resumption

Before paraphrasing or asking a question, Cruise records the complete triggering message verbatim and hashes its exact UTF-8 bytes with SHA-256. Clarification updates normalized intent through an append-only change ledger; it never rewrites the raw prompt or repository identity.

Each ordinary run uses YAML machine state:

```text
.cruise/runs/<run-id>/origin.yaml
.cruise/runs/<run-id>/probe.yaml
.cruise/runs/<run-id>/route.yaml
.cruise/runs/<run-id>/state.yaml
.cruise/runs/<run-id>/evidence.yaml
```

Build uses `.cruise/project/ORIGIN.yaml` and per-milestone `ORIGIN.yaml`; Goal uses `.cruise/goal/ORIGIN.yaml`. Human-reviewed contracts and reports remain Markdown. JSON is used only at external host/API or evaluation-harness interchange boundaries, never as Cruise run state. Stable `PRJ-XX`, `M-XX`, `G-XX`, `R-XX`, `AC-XX`, `D-XX`, `Q-XX`, `P-XX`, `T-XX`, `E-XX`, `F-XX`, `H-XX`, and `RSK-XX` identifiers are monotonic and are never silently renumbered or reused.

Resumption is evidence-based, not conversational memory. Cruise preserves prior attempts and revalidates the prompt hash, repository baseline and current drift, instructions, route, approvals, permissions, capability identity/scope, and evidence freshness before continuing. Outcomes and mandatory checks remain explicit: a waiver keeps a check `NOT_RUN` and residual risk visible rather than converting it to a pass.

## Truthful model policy

Cruise assigns one exact level to every substantive phase:

| Level | Agent type | Alias | Exact model | Reasoning |
| --- | --- | --- | --- | --- |
| `1` | `cruise_l1` | `luna-M` | `gpt-5.6-luna` | `medium` |
| `2` | `cruise_l2` | `terra-M` | `gpt-5.6-terra` | `medium` |
| `3` | `cruise_l3` | `terra-H` | `gpt-5.6-terra` | `high` |
| `4` | `cruise_l4` | `terra-X` | `gpt-5.6-terra` | `xhigh` |
| `5` | `cruise_l5` | `sol-H` | `gpt-5.6-sol` | `high` |
| `6` | `cruise_l6` | `sol-X` | `gpt-5.6-sol` | `xhigh` |
| `7` | `cruise_l7` | `sol-U` | `gpt-5.6-sol` | `ultra` |

Level `1` is reserved for coordination support and never authorizes substantive work. `cruise agents install` registers `[agents.cruise_l1]` through `[agents.cruise_l7]` in `~/.codex/config.toml` and installs their managed overlays under `~/.codex/agents/`. The root puts only the level and bounded task into the launch request. The launcher checks the live catalog, disables provider fallback, and sets the pair through typed `thread/start` and `turn/start` fields. Model-authored prompts never request or attest the pair.

A soft failure may raise the recommended level once when the selected workflow allows it, but this creates a new worker attempt and never mutates the root model. Hard tool failures surface immediately. Worker selection never expands scope, write authority, permissions, or cost boundaries.

## Missing capabilities

Cruise checks, in order, host-native tools, installed plugins or skills, local tools, official plugins, trusted catalogs, pinned official upstreams, and a built-in fallback. Automatic installation is limited to an inspectable, trusted, immutable version in local scope, with permissions and sandbox checks satisfied, no authentication or reusable secret, and a safe rollback story. Installer success is not proof: a deterministic smoke check must confirm identity, version, and usable scope. Missing application dependencies are never installed merely because a research or execution capability is absent.

Redacted capability state is persisted at:

```text
.cruise/internal/capabilities.yaml
.cruise/internal/provision-runs/<run-id>.yaml
```

If authentication is required, Cruise enters `waiting_auth` and gives one precise host-native action; it never asks for a reusable secret in chat, arguments, or artifacts. Only dependent work waits. Independent lanes continue only when the host genuinely schedules them, and resumption revalidates the authenticated identity and scope before the blocked node becomes usable. Untrusted or unverifiable candidates require explicit approval or remain blocked.

## Write and security boundaries

- Quick worker edits only after its hard fit gates pass. Refine worker edits only after explicit Plan approval. Debug workers diagnose before applying the smallest causal repair.
- Before approval, Build writes only project/milestone planning artifacts. After exact project or milestone approval, it may update only an exact Markdown documentation path displayed in that verified contract's `permitted_changes`, and every such write requires a fresh opaque locked-artifact snapshot from `verifyBuildApprovalArtifacts`; an older approval receipt alone is inert. Product code, dependencies, fixtures, migrations, CI, deployment, and Goal state remain forbidden. Research never modifies product state.
- Goal preparation confines writes to `.cruise/goal/`; target implementation and external effects stay inactive until native Goal activation is confirmed.
- Existing user changes are preserved. Tests, builds, browser actions, authenticated state, network access, purchases, deployments, destructive actions, and other external effects remain subject to repository, sandbox, runtime, and explicit user permissions.
- A passing command, self-authored check, waived check, or model assertion is never presented as independent proof. Completion requires current evidence against the immutable origin, actual diff, permissions, effects, and acceptance criteria.

## Build contracts, discovery, and queue

`$cruise:build` inspects the repository before questioning. Bootstrap mode applies to empty,
placeholder, generated-only, or architecturally unestablished repositories; milestone mode
applies to established products and explicit next-milestone requests. It never uses file
count alone. An established repository without Cruise state first receives a proportional
project baseline from observed evidence.

Discovery is internal to Build and activates only when a critical readiness category is
missing or conflicting, a blocking user decision remains, or feasibility evidence is absent.
It asks one material question at a time, preserves alternatives and `Q-XX` answers, and uses
hard viability gates: beneficiary, meaningful outcome, coherent scope, plausible
implementation, verifiable completion, compatible constraints, and no fatal contradiction.
Passing viability automatically creates drafts; exact approval remains mandatory. Before a
review exists, `attestBuildApprovalReadiness` must mechanically prove the selected mode,
evidence-cited readiness with no discovery blocker, and `ready_for_build` viability. Its opaque
result is bound to the canonical repository root and product baseline, project/milestone IDs,
and both Origin byte hashes. Citations are stable `E-XX` records from an opaque
`attestBuildReadinessEvidence` authority with source locators and source digests; raw mode
booleans, prose-only evidence, cloned authority, or a persisted “ready” field cannot substitute
for it.

Canonical sources live under:

```text
.cruise/project/{ORIGIN.yaml,ID-REGISTRY.yaml,PROJECT.md,REQUIREMENTS.md,ARCHITECTURE.md,ROADMAP.md,DECISIONS.md,STATE.yaml,QUEUE.yaml}
.cruise/milestones/<M-ID>-<slug>/{ORIGIN.yaml,MILESTONE.md,REQUIREMENTS.md,ROADMAP.md,DECISIONS.md,QUESTIONS.yaml,AUTONOMY.yaml,STATE.yaml,QUEUE.yaml,phases/}
```

`ID-REGISTRY.yaml` is persisted with exact-snapshot compare-and-swap. Cruise owns its adjacent
immutable `ID-REGISTRY-HISTORY/`, committed `ID-REGISTRY-HEAD.yaml`, and transient pending/lock
files, plus an independent `.cruise/ID-REGISTRY-COMMITMENTS/` lineage fence. A fresh process can
restore a deleted canonical mirror from the validated committed chain; deleting the whole project
registry store cannot reset it to revision zero while that fence survives, and rollback,
truncation, forks, and stale snapshots fail closed.

Discovery state remains subordinate in `.cruise/project/discovery/` or the target milestone's
`discovery/` directory. That directory contains exactly the discovery Origin byte copy,
`CONCEPTS.yaml`, `QUESTIONS.yaml`, `EVIDENCE.yaml`, `DECISIONS.md`, and `DISCOVERY.md`.
Concept, question, evidence, and decision IDs are stable; only one material question may be open;
and selected/rejected alternatives retain their reasons and tradeoffs. The replayable but inert
runtime checkpoint lives separately at `.cruise/runs/<run-id>/BUILD-DISCOVERY.yaml` and validates
against `internal/schemas/build-discovery-state.schema.yaml`. Loading its serialized `status`
does not restore authority: the host must attest the exact state, immutable Origin, and unchanged
product baseline, and any completed pre-approval Research edge must replay with its opaque scope
approval and Research closeout before the same run may resume.
The checkpoint is the atomic head of hash-chained immutable generations in the adjacent
`BUILD-DISCOVERY-HISTORY/`. A write-ahead intent binds the exact prior head before canonical files
change, so a fresh process can reclaim a dead writer and deterministically roll a complete pending
generation forward. The same transaction advances `BUILD-DISCOVERY-LINEAGE.yaml`, an independent
durable anchor for the latest head and predecessor anchor; if that anchor survives while the head or
history is missing, Cruise rejects lineage erasure instead of recreating revision zero. Persistence
and reads are also bound to the exact canonical repository root captured in the discovery Origin.
Stale or forked run objects cannot replace a newer checkpoint, even after restart and rehydration.

When viability is `ready_for_build`, Build may author final planning drafts without another user
question only through a one-use drafting authority. The transition to normal review rereads each
declared artifact once with no symlink following, verifies its SHA-256, checks the product baseline
before and after inspection, and requires the exact 18-file set: nine canonical project files plus
the nine canonical files for exactly one first/target milestone. Before `draft_ready_for_review`,
the normal Build semantic validators must also accept the Markdown contracts, phase DAG, both queue
definitions, both mutable draft State files, ID registry, and readiness/baseline bindings. The target Origin is the discovery
Origin byte copy, `approved` remains false, and product, discovery, Goal, missing, extra, or forged
paths fail closed. This drafting authority is not research, approval, implementation, or Goal
authority.

Build requires the exact
case-sensitive **Approve Foundation** or **Approve Milestone** option from a host structured
choice. Bootstrap approval is incomplete without both the project contract and its first
executable milestone, including both queue definitions.

Approval follows one executable sequence. After queue contract digests are finalized, Build
uses opaque readiness, exact initial Origin-pair, and current ID-history authorities to call
`prepareBuildApprovalReview`. The Origin authority binds both `ORIGIN.yaml` byte digests. The
history authority binds the monotonic registry, predecessor/superseded history, and a raw-content
digest manifest of the current locked contract and queue artifacts. That call verifies
the current product baseline and readiness bindings, semantically rereads the exact artifacts
and queues, strictly validates the required mutable project/milestone `STATE.yaml` records, and
returns a self-contained `review_card` whose digest covers mode/label, readiness and baseline, the locked
artifact manifest, queue snapshots and active queue, the approval-time State snapshots, and the
full milestone phase/acceptance contract. Build displays the complete card and its
`review_digest`. The later host option event must echo that digest with the exact approval choice
before it can become an opaque selection. `captureBuildApproval` requires the same three opaque
authorities, then rereads everything and
recomputes the same digest; changed product bytes, Origin/contract/queue/permission/phase bytes,
approval-time State drift, or a stale review fail closed. A final verifier check against the
same trusted selection, Origin/history authorities, product baseline, registry, and current bytes mints the opaque verified Build
receipt used downstream; for a milestone it carries the full normalized phase/acceptance mapping
and Build-derived completion fence. State is bound only across this approval transaction: it
remains outside the immutable artifact manifest and may advance afterward without invalidating
the receipt, while runtime reverification continues to lock every approved contract and queue
byte.
A typed label, copied approval record, digest, descriptor, or repository prose is never that
receipt. Approval authorizes no product implementation and no Goal activation.

The approved queue is an immutable persistent DAG of narrowed Research, Goal, Refine, Quick,
or already-approved Debug work. `QUEUE-STATE.yaml` is mutable, but the private evidence-aware
queue coordinator is its sole mutation path: it requires the verified Build receipt and matching
queue approval, permits only legal transitions, and preserves mechanically validated evidence
plus hash-chained attempts. Launch requires a fresh locked-artifact/product-baseline attestation
whose synchronous final-boundary check rereads every approved artifact byte and recaptures the
product tree against the queue's expected baseline, so drift after the earlier asynchronous
snapshot cannot launch work,
and a one-use start admission: automatic starts consume opaque router/permission/auth/host
semantic authority, while manual starts require the exact structured option with the same
opaque semantic admission. Both authorities originate as ordered receipts from one private
host-interaction broker; raw events, cloned receipts, and an inline `{accepted: true}` object
are inert. Child inputs must
match approved predecessor output hashes. A Goal with a Research predecessor also
requires a one-use reconciliation authority bound to those exact output bytes and explicit
`consistent` findings for milestone requirements, phase scope, architecture, permissions, and
acceptance criteria; any invalidated assumption returns to Build contract revision. Completion requires a one-use baseline transition and a
matching closeout with newly performed PASS evidence supporting every locked criterion before
dependents unlock. Persisted state regains reducer authority only through full replay
validation of the exact adjacent `QUEUE-STATE.yaml`: the first atomic write is revision zero,
and every changed write requires the opaque revision/state/file-digest snapshot returned by the
prior write or read, advances exactly one revision, and preserves attempt/evidence prefixes.
Before state advances, the coordinator durably adds a no-follow, read-only, exact-state entry to
the adjacent `QUEUE-STATE-HISTORY/` hash chain. Every fresh coordinator replays that immutable
chain, including the exact historical YAML bytes, and requires the state file to equal its head.
If interruption lands after the durable entry but before the state rename, the host may attest
the exact predecessor plus a history head exactly one revision ahead. For the first commit only,
it may instead attest the absent state path plus the single exact validated revision-zero
genesis entry. Under the writer lock,
resume revalidates the chain and append-only reducer semantics, reclaims only a dead PID-bound
writer lock, atomically installs the embedded successor bytes, and rescans; gaps, forks, invalid
successors, active writers, or state-ahead histories never recover.
An interrupted pre-link genesis that left only an empty history directory or private staging
files is safely retried under a reclaimed dead-writer lock. Persistence is bound to the canonical
repository root in the verified Build receipt. Before a genesis write can return success, an
immutable commitment keyed by the semantic Build-approval digest and queue ID is synchronized
under `.cruise/QUEUE-STATE-COMMITMENTS/`, together with a separate immutable commitment for
every revision that embeds the exact local history-entry bytes. Deleting the queue state/local
history cannot mint a new revision-zero queue; a single missing committed tail is materialized
under the writer lock, while stale observations are rejected and a consistent rollback is
restored to the durable latest head even after re-verification or process restart.
Writer-lock metadata is fully written and synchronized in a private preparation inode before an
atomic no-replace link publishes the canonical lock, so a kill cannot leave an empty canonical
lock that wedges recovery; abandoned prepublication files carry no authority.
The host must attest the current state path/digests and history path/head/aggregate digest;
`readPersistedBuildQueueState` consumes that opaque attestation once before restoring reducer
authority. Direct object clones, older or forked heads, rewritten equivalent YAML, a missing
state after revision zero, missing or gapped history, symlink state/history files or directories,
and skipped revisions fail closed.
Runtime serializes mutating work while allowing at most four disjoint independent read-only
Research items when the host supports it.

Feasibility-blocking Research returns to the same Build run before approval; implementation
Research may remain queued afterward. An unknown-cause predecessor failure does not permit
in-place Debug insertion: Build creates an opaque unapproved queue revision that preserves the
old definition/evidence/attempt lineage, repeats the full readiness and digest-bound review/
selection/capture sequence at the failed state's expected product baseline, obtains fresh queue
approval, then migrates validated history into the newly authorized coordinator. Automatic
transitions occur only when approval, prerequisites, baselines, permissions, authentication,
semantic admission, and actual host continuation support all agree.

## Goal compatibility contract

`$cruise:goal` keeps the original single-slice two-approval native Goal protocol as its
default. A milestone file or `ROADMAP.md` alone never changes that mode:

1. Inspect the repository and ask only the highest-impact unresolved decision.
2. Write the inactive `.cruise/goal/` candidate: `ORIGIN.yaml`, `SPEC.md`, `DECISIONS.md`, `ALIGNMENT.md`, `PLAN.md`, and `GOAL.md`, plus `ROADMAP.md` only when strategically necessary. `CLOSEOUT.md` is forbidden before activation.
3. Review the implementation plan and select the exact, case-sensitive **Approve Plan** option. This locks the displayed artifact bytes and SHA-256 digests but does not authorize execution.
4. Review `GOAL.md` separately and select the later exact, case-sensitive **Start Cruise** option. Free text that merely repeats either label is not an approval token.
5. The root rechecks the approved snapshots, switches from Plan to Default mode, sets and verifies the persisted native Goal, and spawns bounded workers against the locked origin, plan, permission envelope, and evidence gates. Approved bytes are not edited after Start.

After Build approval, the recommended handoff is `Use cruise:goal for P-01.` It consumes one
approved strategically complete phase with the same Plan/Start/native-Goal contract. The
optional milestone-wide path enters milestone-controller mode only when the current session's
host selector records the exact **Use Milestone Controller M-XX** option and that opaque
selection is joined to a fresh branded Build-verification receipt for the same milestone.
`MILESTONE-CONTROLLER.yaml`, a queue item, a persisted approval snapshot, or repository prose
cannot authorize the mode.

The controller is hierarchical and persisted: canonical milestone `STATE.yaml` and matching
per-phase state projections record a revisioned phase machine. Before each phase it reconciles
repository identity and the prior closeout, activates only a ready phase, resolves only material
phase questions, and attests the actual just-in-time PLAN bytes, exact ownership, permission
scope, and pre-phase repository baseline before activation. Closeout rereads PLAN, CLOSEOUT, and
EVIDENCE, requires performed mandatory PASS coverage for every Build criterion, and captures the
post-phase baseline before advancing. The milestone can complete only through a separate
Build-fence-equal aggregate attestation covering every mandatory phase. Persisted state is
provenance-branded and resumes only after projections, locked files, phase/aggregate evidence,
and the current baseline revalidate. It never allocates the whole milestone as one flat PLAN or
rewrites locked top-level Build artifacts. A changed outcome, mandatory requirement, criterion,
dependency, permission, protected behavior, or completion fence stops for Build contract
revision.

Interactive controller mode is the default. After Build and Goal approvals, the coordinator
issues a digest-bound warning challenge. Only a separate, later direct-user text/Other event may
exchange its exact token for a one-time authorization, which must then be consumed to create a
question-suppression grant:

```text
DANGEROUSLY-TRUST-CRUISE <M-ID> <12-character-contract-digest>
```

The warning-to-authorization exchange binds the current session/run, controller and contract
digests, pre-activation repository baseline, and permission envelope. Any drift before one-use
consumption rejects it. After activation, verified phase work may advance the product baseline
without revoking whole-milestone question suppression; persisted controller state and hard
stops police unexplained drift. Locked-artifact or permission drift, cancellation, completion,
a new run, or revocation still ends the grant. Dangerous mode
suppresses discretionary questions only; it never approves Build or queue bytes, adds work,
widens scope or permissions, bypasses sandbox/authentication/provisioning/dependencies, waives
mandatory evidence, weakens security/privacy/rollback stops, or guarantees completion. On a
hard stop it preserves state and reports the exact condition required to resume.

The optional bundled `cruise` terminal client remains Goal-only and, because the standalone
binary has no persistent Build-approval resolver, its installed entrypoint is deliberately
single-slice Goal only. Run milestone-controller Goal from ordinary Codex while the approved
Build run is still in scope; a host embedding may enable the same terminal Plan/Start path only
by supplying the opaque Build resolver explicitly. Resolver-capable Node hosts use the exported
`cruise-codex-plugin/session` entrypoint and pass `resolveBuildApproval`; after the exact
controller selection, Plan approval, later Start approval, and confirmed native Goal activation,
the session emits `milestoneControllerReady` and returns the same live `controllerDriver`.
That driver retains the opaque controller, Build, activation, and state authority and exposes
only named operations for persistent questions, phase activation/closeout, hard stops,
completion, dangerous-question suppression, reload, and explicit close. The embedding must keep
the driver live for the controller run and call `driver.close()` when ownership ends. If runtime
bootstrap cannot safely create or reload the canonical milestone state, the session pauses and
rechecks the exact objective/thread of the just-activated native Goal before it throws; if a
different Goal has replaced it, Cruise leaves that Goal unchanged and stops the app-server.
Hosts that already own the approved Plan/Start activation boundary may import the lower-level
factory from `cruise-codex-plugin/milestone-controller-host` and pass the same opaque verified
Build receipt used to establish controller authority. The factory accepts only the strict
canonical Build draft State bound to that receipt's project, milestone, baseline, readiness,
Origin, Build-contract, queue, question, and phase identities. If durable controller history
already exists, it loads and reconciles that history before interpreting a stale canonical
Build-draft mirror, covering an interruption between history append and mirror roll-forward.

Build uses ordinary Codex structured
questions and does not claim terminal keyboard behavior. The Goal client provides Up/Down
navigation, Enter or Space selection, immediate 1–9 selection, and q/Escape/Ctrl-C
cancellation. It talks to `codex app-server` over local stdio. Its root preparation turn uses
`.cruise/goal` as the only writable integration boundary with network and escalation disabled;
after Start approval the root restores the repository boundary, calls `thread/goal/set`, and
launches configured workers for substantive execution. It does not inject terminal
keystrokes, synthetic approval text, or a root-model change.

Outside that client, Goal uses the host's structured selector when available and never claims the custom keyboard behavior. After approval it uses native Goal creation when the host exposes it; otherwise it prints the exact user-invoked `/goal` handoff and stops until activation is confirmed.

Existing locked Goal suites using legacy `N-XX` and `VG-XX` identifiers remain readable and are never rewritten in place. If `ORIGIN.yaml` is absent, Cruise records that the legacy origin is unavailable and never invents prompt bytes. A new activation requires explicit reconciliation into a new origin-bearing candidate while preserving the legacy suite for audit.

## Requirements

- Codex CLI 0.144.1 or newer with native Goals enabled
- Node.js 20 or newer
- A normal authenticated Codex configuration

Run the dependency-free readiness check:

```sh
cruise doctor
cruise doctor --json
```

## Install

Install the plugin from the personal marketplace, then expose the optional terminal client on `PATH` from the plugin source directory. When updating an existing checkout, remove and add the plugin again so Codex refreshes its cached skill snapshot (an old cache may still contain retired `review` and omit `build`):

```sh
codex plugin remove cruise@agent-local  # only when an older Cruise is installed
codex plugin add cruise@agent-local
mkdir -p ~/.local/bin
ln -sfn "$PWD/scripts/cruise.mjs" ~/.local/bin/cruise
cruise agents install
```

Verify both surfaces:

```sh
codex plugin list
cruise agents install --json
cruise doctor
```

## Use

Invoke the selected skill from ordinary Codex, for example:

```text
Use $cruise:build to establish this project foundation and its first milestone.
Use $cruise:debug to find and repair this intermittent test failure.
Use $cruise:research to compare these migration options before we choose.
Use $cruise:goal to plan and execute this compatibility migration.
```

Use the terminal client when Goal needs the keyboard picker and automatic native transition:

```sh
cruise "Migrate the API without breaking existing clients"
cruise -C ~/src/app "Redesign checkout and prove the UX"
cruise picker-demo
```

## Development

```sh
npm test
npm run validate
npm run test:evals
# Optional split: npm run test:evals:static / npm run test:evals:behavior
node --check scripts/cruise.mjs
```

The picker and shared runtime are dependency-free Node implementations maintained as part of Cruise.

## License

MIT. See [LICENSE](LICENSE).
