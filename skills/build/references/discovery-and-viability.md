# Discovery and viability

## Contents

1. Readiness activation
2. Question protocol
3. Concept and evidence records
4. Viability gate
5. Outcomes and automatic drafting

## 1. Readiness activation

Build a readiness matrix after repository and prior-artifact inspection:

```yaml
readiness:
  mode_candidate: bootstrap
  outcome: {status: clear, evidence: []}
  users_or_beneficiary: {status: clear, evidence: []}
  non_goals: {status: clear, evidence: []}
  requirements: {status: clear, evidence: []}
  completion_evidence: {status: clear, evidence: []}
  architecture_constraints: {status: clear, evidence: []}
  data_and_security: {status: clear, evidence: []}
  compatibility_and_migration: {status: clear, evidence: []}
  operations_and_rollback: {status: clear, evidence: []}
  phase_boundaries: {status: clear, evidence: []}
  permissions: {status: clear, evidence: []}
  problem_or_opportunity: {status: clear, evidence: []}
  beneficiary: {status: clear, evidence: []}
  meaningful_value: {status: clear, evidence: []}
  scope_coherence: {status: clear, evidence: []}
  plausible_implementation_path: {status: clear, evidence: []}
  feasibility: {status: clear, evidence: []}
  measurable_completion: {status: clear, evidence: []}
  constraints_and_resources: {status: clear, evidence: []}
  differentiation_or_necessity: {status: clear, evidence: []}
  security_and_external_effects: {status: clear, evidence: []}
  fatal_contradictions: []
  research_blockers: []
  user_decisions_required: []
```

The matrix is exhaustive: the first eleven fields are the original Build contract categories,
and the next ten are the additive discovery/viability categories. Do not omit either group.
Each status is `clear`, `partial`, `missing`, or `conflicting`. Enter discovery when a critical
category is partial, missing, or conflicting; any category conflicts; a project- or milestone-
blocking user decision or research blocker remains; feasibility evidence is absent; or
uncertainty prevents responsible approval. A partial or missing noncritical supporting detail
alone is not enough. When every mechanically blocking condition is clear, skip discovery.

## 2. Question protocol

For every discovery interaction:

1. inspect repository evidence and prior answers;
2. choose the highest-impact unresolved category;
3. explain the evidence and material consequence;
4. recommend a practical path when evidence supports it;
5. ask one concise question, optionally with two or three tradeoff-bearing options and free
   text;
6. record the answer under a monotonic `Q-XX`;
7. update readiness and determine whether another question is necessary.

Do not ask facts available from inspection, answered questions, later-phase implementation
details, outcome-irrelevant preferences, or speculation that cannot alter feasibility or the
contract. Challenge unsupported assumptions. Decompose incoherent bundles into coherent
candidate milestones. Stop once the concept is implementable; avoid generic idea lists,
novelty for its own sake, premature technology selection, and endless ideation.

Test concepts against beneficiary/problem evidence, meaningful measurable value, coherent
scope, feasible dependencies/resources/legal/operational constraints, independently
verifiable phases, usable first-milestone transition value, failure/rollback, and evidence
that distinguishes observations, inference, research needs, and speculation.

## 3. Concept and evidence records

Bootstrap discovery lives under `.cruise/project/discovery/`; milestone discovery lives
under the target milestone's `discovery/`. Each contains:

```text
ORIGIN.yaml
CONCEPTS.yaml
QUESTIONS.yaml
EVIDENCE.yaml
DECISIONS.md
DISCOVERY.md
```

Discovery remains subordinate and is never an approved project/milestone contract.
`ORIGIN.yaml` is an exact byte copy of the shared immutable Build Origin for this candidate
mode and target; discovery progress never rewrites it. `CONCEPTS.yaml` preserves stable `C-XX`
concepts with title, outcome, beneficiary,
problem/opportunity, proposed capabilities, non-goals, value, implementation/verification
outlines, dependencies, risks, assumptions, research questions, viability, and status
(`active`, `rejected`, `merged`, `deferred`, `selected`). It also records derivation/merge lineage,
one selected concept when ready, and a non-empty reason for every rejected, merged, or deferred
alternative.

`QUESTIONS.yaml` uses stable monotonic `Q-XX` records with status, materiality, category,
question, `E-XX` citations, recommendation, zero/two/three concrete options, answer/source,
affected contract fields, timestamps, and reopening trigger. Only one material question may be
open, its ID is the resume cursor, and an answered question retains its ID instead of being asked
again. `EVIDENCE.yaml` uses stable monotonic `E-XX` observations, user statements, prior-artifact
facts, external context, and approved Research findings, each with source digest, certainty,
supports, timestamp, and any `DR-XX` parent. `DECISIONS.md` uses monotonic `D-XX` sections with
status, concept, evidence, rationale, tradeoffs, reopening trigger, and supersession; an accepted
decision names the selected concept and rejected decisions preserve each rejected concept's exact
reason.

`DISCOVERY.md` concisely records what was explored, the selected concept and why it matters,
feasibility, alternatives/rejections, unresolved phase-local issues, research dependencies,
and the recommended Build transition.

Persist the reducer history and interruption cursor separately at
`.cruise/runs/<run-id>/BUILD-DISCOVERY.yaml`, validated by
`internal/schemas/build-discovery-state.schema.yaml`. The envelope is not a seventh discovery
artifact and cannot authorize a transition. Replay must reproduce every snapshot digest. A fresh
opaque host resume attestation must bind its exact state digest, run ID, immutable Origin digest,
and unchanged product baseline. Rehydrating Research states also requires the matching opaque
Research-scope approvals and result closeouts. Resume preserves the same run ID, `Q-XX` cursor,
`DR-XX` return cursor, and prior answers.

`BUILD-DISCOVERY.yaml` is one atomically replaced commit pointer. Each committed pointer has an
identical immutable bundle under `BUILD-DISCOVERY-HISTORY/REV-<revision>-<state-sha256>/`
containing the six canonical discovery artifacts and envelope bytes. Every revision binds the
previous generation and exact previous-head digest. Before changing a canonical file, write a
pending intent bound to that predecessor, its durable lineage-anchor digest, and the complete new
generation. Commit `BUILD-DISCOVERY-LINEAGE.yaml` before clearing the intent; a reader or retry may
roll a complete head-before-anchor crash forward, while a crash before the durable intent leaves the
old head and anchor authoritative. Every read and write must independently match the canonical
repository root in `ORIGIN.yaml.repository_baseline.root`. Stale ancestors, forked event histories,
missing or rewritten generation bytes, a surviving lineage anchor with a missing head/history,
active writers, repository-root changes, path changes, symlinks, and unapproved directory entries
fail closed.

## 4. Viability gate

Evaluate each candidate deterministically:

```yaml
viability:
  concept_id: C-01
  critical_gates:
    beneficiary_identified: pass
    meaningful_outcome: pass
    coherent_scope: pass
    plausible_implementation: pass
    verifiable_completion: pass
    constraints_compatible: pass
    no_fatal_contradiction: pass
  supporting_dimensions:
    expected_value: 0
    feasibility_confidence: 0.0
    implementation_clarity: 0
    verification_clarity: 0
    reversibility: 0
    operational_sustainability: 0
  unresolved:
    user_decisions: []
    research_questions: []
    phase_local_questions: []
  outcome: user_decision_required
```

Critical values are `pass`, `fail`, or `research_needed`. Supporting numeric scores inform
judgment but never override a non-pass critical gate. `ready_for_build` requires every gate
to pass, no fatal contradiction or blocking decision, feasibility confidence proportionate
to consequence, measurable completion, and a plausible first milestone.

## 5. Outcomes and automatic drafting

- `ready_for_build`: choose bootstrap/milestone, preserve concept IDs, mint a one-use
  drafting-only authority for the current discovery snapshot/Origin/product baseline, and author
  every required contract and queue without asking the concept question again. Map decisions to
  requirements/criteria, phase-local issues to their phase, and implementation research to the
  post-approval queue. A caller-authored manifest is not proof: before recording
  `draft_ready_for_review`, inspect the complete canonical file set as described below. After the
  actual repository baseline and both Origin hashes are final, call
  `attestBuildApprovalReadiness`; a stored outcome or draft-ready string is not approval
  authority. Pass that opaque result to
  `prepareBuildApprovalReview`, then show the complete returned review card and digest before
  offering the exact structured approval option. Never ask the user to repeat the idea.
- `user_decision_required`: ask the next highest-impact question in the same run.
- `research_required`: classify it as `pre_approval_blocker` when feasibility/coherence could
  be invalidated, request approval for a scoped research item, then return to and reconcile
  the same Build run. Use `post_approval_prerequisite` only when the contract is already
  coherent and the research is phase implementation detail.
- `not_currently_viable`: create no final Build contract. Report failed gates/evidence,
  smallest viability-improving changes, useful research, and whether to narrow, defer, or
  abandon.
- `deferred`: persist the concept, questions, and reopening conditions.

Automatic drafting authorizes only `.cruise/` planning writes. It never approves or locks
bytes, modifies product state, starts research, invokes Goal, activates native Goal mode,
installs dependencies, or performs external effects.

The draft verifier requires exactly 18 real files and no extras:

```text
.cruise/project/
  ORIGIN.yaml ID-REGISTRY.yaml PROJECT.md REQUIREMENTS.md ARCHITECTURE.md
  ROADMAP.md DECISIONS.md STATE.yaml QUEUE.yaml
.cruise/milestones/<one-first-or-target-M-ID>-<slug>/
  ORIGIN.yaml MILESTONE.md REQUIREMENTS.md ROADMAP.md DECISIONS.md
  QUESTIONS.yaml AUTONOMY.yaml STATE.yaml QUEUE.yaml
```

For bootstrap the milestone set is the required first executable milestone. For milestone mode
the project set is the proportional/current project baseline and the milestone set is the exact
target. Every path must be canonical and beneath `.cruise/`; product, `discovery/`, `.cruise/goal/`,
`CLOSEOUT.md`, missing, duplicate, or extra paths fail. Open each declared regular file once with
no symlink following, compare its bytes to the declared SHA-256, validate both Origins, require the
mode's target Origin to equal the discovery Origin bytes, and prove the product baseline is
unchanged before and after all reads. The full Build draft semantic validator must additionally
accept every Markdown contract, the phase DAG, both queues, both mutable draft State files, the ID
registry, and their readiness/baseline/digest bindings. The manifest preserves selected/rejected `C-XX` lineage,
mapped `R-XX`/`AC-XX`/`D-XX` IDs, phase-local questions, and research prerequisites, and must say
`approved: false`. This is an exact semantic join, not parallel lists: reread both final
`DECISIONS.md` files and reject a reused or rewritten discovery `D-XX`; require every final
requirement to cite an accepted discovery decision and acceptance criterion; match the final
deferred phase-question text to its generated phase; map each remaining implementation-research
question to exactly one Research queue item; and compare every scanned active identifier/source
path with `ID-REGISTRY.yaml`. Consuming the authority once records only an unapproved draft transition; it
does not mint review or approval authority.

Readiness attestation also is not approval. It fails unless repository evidence closes the
chosen mode, every mechanically blocking readiness condition is clear, evidence citations are
stable `E-XX` references to an opaque `attestBuildReadinessEvidence` authority, and viability is
exactly `ready_for_build`; it is bound to repository root/baseline,
target IDs, and Origin hashes. Only the later review-digest-echoing structured choice can be
captured as Build approval, and capture fails if the product baseline or reviewed bytes changed.
