# Cruise exemplar repository analysis

> **Historical v0.1 architecture note.** This analysis informed the retired
> Cruise control plane. References to queues, ledgers, YAML state, and former
> runtime modules are historical evidence, not current implementation claims.

This note records the implementation patterns Cruise should learn from eight
upstream repositories grouped into six project families: Open GSD (`gsd-pi`
and `gsd-core`), GitHub Spec Kit, Fission AI OpenSpec, Obra Superpowers and its
separately maintained evaluation harness, Aider, and BMAD Method. It is an
engineering input to Cruise—not a proposal to copy any one project wholesale.

The comparison uses four questions for every repository:

1. What problem does the repository actually solve?
2. Which proven mechanisms should Cruise adopt?
3. What must be adapted to Cruise's six-skill surface and Codex host?
4. Which complexity, ambiguity, or failure mode should Cruise avoid?

All upstream links are pinned to the inspected revision where one was
available. Concepts may be reimplemented cleanly; upstream code must not be
vendored into Cruise without a separate license and maintenance decision.

## Contents

1. [Open GSD](#1-open-gsd)
2. [GitHub Spec Kit](#2-github-spec-kit)
3. [Fission AI OpenSpec](#3-fission-ai-openspec)
4. [Obra Superpowers](#4-obra-superpowers)
5. [Aider](#5-aider)
6. [BMAD Method](#6-bmad-method)
7. [Implementation reassessment](#implementation-reassessment--2026-07-16)
8. [Concrete Cruise changes](#concrete-cruise-changes-derived-from-the-exemplars)
9. [Deliberate non-adoptions](#deliberate-non-adoptions)

## Executive synthesis

Cruise should combine the strongest boundary from each project:

| Repository | Strongest lesson for Cruise | Where it belongs |
| --- | --- | --- |
| Open GSD `gsd-pi` | Make gates, recovery, ownership, and repair authority mechanical | Shared routing/state plus `goal` |
| Open GSD `gsd-core` | Make ambiguity, requirements, phases, and proof explicit without exposing orchestration internals to the user | `build`, `refine`, and `goal` contracts |
| GitHub Spec Kit | Clarify the highest-impact ambiguity and preserve explicit requirement traceability | `refine`, `goal`, shared origin/traceability |
| Fission AI OpenSpec | Model artifacts and continuation as an explicit dependency graph | Shared run state and private capability DAG |
| Obra Superpowers | Inspect before asking, ask one question at a time, debug scientifically, and verify before claiming | All skills, especially `refine` and `debug` |
| Superpowers Evals | Test adjacent workflow boundaries with matched prompts, hidden deterministic checks, and independent grading | Routing and six-skill evaluation suite |
| Aider | Separate reasoning from editing, restrict edit scope, and feed lint/test evidence into bounded repair | `quick`, planned execution, verification |
| BMAD Method | Scale ceremony to task size and make the next valid workflow obvious | Six-skill chooser and promotion/handoff policy |

No exemplar supplies Cruise's complete architecture. Cruise's differentiator
is the combination of an immutable user origin, six mutually exclusive
intent-based skills, root-owned host authority, truthful Codex-native Goal
activation, YAML run evidence, foreign-diff attribution, durable Build queues,
and a private capability provisioner.

## Implementation reassessment — 2026-07-16

The first analysis mostly asked what Cruise *should* adopt. The current local
implementation makes it possible to separate ideas that are now realized from
ideas that still need restraint or verification.

| Derived idea | Current Cruise realization | Assessment |
| --- | --- | --- |
| Immutable origin above generated artifacts | Exact UTF-8 prompt bytes and repository identity are captured before routing; later decisions use an append-only ledger | Strongly realized; stricter than the exemplars |
| Mechanical routing boundaries | A bounded semantic mapping packet feeds 17 Quick gates, evidence locators, and one explicit handoff on conflict | Strongly realized; continue testing semantic false positives and omissions |
| Preserve foreign work | A baseline-aware foreign-diff guard attributes only receipt-backed changes and pauses on unexplained drift | New synthesis beyond any single exemplar |
| Root/worker separation | Root owns questions, approvals, permissions, integration, and final synthesis; bounded workers own substantive phases | Strongly realized; combines Aider role separation with GSD ownership |
| Artifact graph and durable continuation | Build queues, capability dependencies, phase prerequisites, and current evidence control readiness | Strongly realized, with stricter semantic and approval checks than output-existence graphs |
| Approval as exact authority | Build review digests, Plan approval, Start approval, one-use host events, and opaque receipts are non-interchangeable | Strongly realized; a major Cruise-specific advance |
| Evidence before completion | Stable requirement/task/evidence IDs, current PASS evidence, and explicit `NOT_RUN` waivers govern closeout | Strongly realized; paired live evaluation remains the harder proof |
| Scale-adaptive ceremony | Six intent lanes, Quick promotion gates, Build/Goal durability, and class-based worker defaults | Strongly realized; documentation must keep the common path visibly smaller than the machinery |
| Bounded repair | Current policy correctly rejects an arbitrary universal retry count; evidence and reviewed stop conditions govern another attempt | Refined since the original analysis; “two Quick repairs” was too mechanical |
| Installation provenance and health | Cache/source digests, managed agent overlays, Doctor profiles, trusted hooks, and smoke checks | Strongly realized; inspired by BMAD packaging but made Codex-native |
| Behavioral evaluations | Static suites, boundary cases, paired scoring, and Deep/Troubleshoot canaries exist | Partially realized; independent repeated live trials remain necessary for comparative claims |
| Legible authority paths | Level 1 assigns short semantic repository/run namespaces; stable protocol artifacts have purpose names while hashes stay inside records | New synthesis: operator readability and cryptographic integrity no longer compete in filenames |

### New synthesis

Four conclusions are clearer after implementation:

1. **Authority is the missing dimension in most prompt harnesses.** Artifacts,
   task boxes, or model statements are useful state, but Cruise improves on
   them by requiring host-created, one-use, byte-bound authority for approvals,
   writes, queue transitions, and activation.
2. **Protecting the user’s concurrent work is part of orchestration quality.**
   The foreign-diff guard is not merely Git hygiene; it is the bridge between
   durable agent state and a repository that humans and other tools may still
   change.
3. **Documentation must be proportional too.** Spec Kit’s runnable sequence,
   BMAD’s obvious “what next,” and OpenSpec’s compact philosophy all work
   because the common path appears before internal machinery. Cruise should
   keep its README as a map and move receipt, queue, and recovery detail into
   focused references.
4. **Legibility is an operational invariant.** A hash is useful evidence but a
   poor locator. Cruise now separates semantic location from integrity: the
   level-1 worker assigns informative repository and run namespaces, stable
   protocol files use short purpose names, and SHA-256 stays inside validated
   records. This makes recovery and audit paths readable without weakening
   byte-level binding.

## 1. Open GSD

### What it is

Open GSD is a durable software-delivery orchestrator and methodology. The
inspected snapshots were
[`open-gsd/gsd-pi@0205aba`](https://github.com/open-gsd/gsd-pi/tree/0205aba79186d94f0d87d4fc945fcb798f92fc5d)
and
[`open-gsd/gsd-core@6504afa`](https://github.com/open-gsd/gsd-core/tree/6504afa843364753e3d4644f77bc7c6dfaed7d0a),
both MIT-licensed. Its important contribution is not a particular prompt. It
turns planning and execution into persisted state with enforced gates,
ownership, resumability, repair limits, and worktree safety.

### Adopt

- **Mechanical admission and write gates.** GSD persists gate identity,
  ownership, scope, and readiness, then enforces them at the write boundary in
  [`write-gate.ts`](https://github.com/open-gsd/gsd-pi/blob/0205aba79186d94f0d87d4fc945fcb798f92fc5d/src/resources/extensions/gsd/bootstrap/write-gate.ts#L731-L1114)
  and
  [`gate-registry.ts`](https://github.com/open-gsd/gsd-pi/blob/0205aba79186d94f0d87d4fc945fcb798f92fc5d/src/resources/extensions/gsd/gate-registry.ts#L25-L250).
  Cruise should use the same principle for semantic Quick promotion, Refine
  plan approval, Goal's exact combined Plan-and-Goal `Approve`, and
  read-only Research and native-review boundaries. A narrative claim that a gate passed
  is never authoritative.
- **Persisted recovery cursor.** GSD reconciles stale owners, leases, cancelled
  dispatch, sessions, and worktrees in
  [`crash-recovery.ts`](https://github.com/open-gsd/gsd-pi/blob/0205aba79186d94f0d87d4fc945fcb798f92fc5d/src/resources/extensions/gsd/crash-recovery.ts#L98-L321).
  Cruise should persist the current phase, current task or experiment, attempt
  number, evidence paths, and blocking state before dispatch. Resume should
  repeat only an idempotent current unit rather than reconstructing progress
  from chat prose.
- **Bounded checker/repair/executor separation.** GSD passes structured checker
  findings back to the matching unit and caps retries in
  [`auto-post-unit.ts`](https://github.com/open-gsd/gsd-pi/blob/0205aba79186d94f0d87d4fc945fcb798f92fc5d/src/resources/extensions/gsd/auto-post-unit.ts#L2481-L2738).
  Cruise should keep independent verification read-only, repair only the
  finding's scope, reset the attempt count after success, and promote or pause
  on repeated unchanged failure.
- **Verified worktree ownership.** GSD checks canonical root, branch,
  registration, and ownership before writes in
  [`worktree-safety.ts`](https://github.com/open-gsd/gsd-pi/blob/0205aba79186d94f0d87d4fc945fcb798f92fc5d/src/resources/extensions/gsd/worktree-safety.ts#L129-L347)
  and only performs tightly constrained repair in
  [`auto-worktree-repair.ts`](https://github.com/open-gsd/gsd-pi/blob/0205aba79186d94f0d87d4fc945fcb798f92fc5d/src/resources/extensions/gsd/auto-worktree-repair.ts#L68-L204).
  Cruise Goal should retain strict isolation for consequential work; Quick
  should skip worktree overhead unless collision risk or repository policy
  warrants it.
- **Role-sensitive model profiles.** GSD resolves phase and capability intent
  against available models instead of hard-coding one provider in
  [`preferences-models.ts`](https://github.com/open-gsd/gsd-pi/blob/0205aba79186d94f0d87d4fc945fcb798f92fc5d/src/resources/extensions/gsd/preferences-models.ts#L541-L719).
  Cruise should record requested role/tier, the actually supported Codex model
  and reasoning setting, fallback, attempt, and escalation reason.
- **Quantified but bounded ambiguity handling.** GSD scores outcome,
  boundaries, constraints, and acceptance, asks against the weakest material
  dimension, and caps the loop in
  [`spec-phase.md`](https://github.com/open-gsd/gsd-core/blob/6504afa843364753e3d4644f77bc7c6dfaed7d0a/gsd-core/workflows/spec-phase.md#L8-L186).
  Cruise should combine this with repository evidence and stop questioning as
  soon as the route's admission conditions are satisfied.
- **Stable requirements and proof.** GSD preserves requirement identity and
  ownership in
  [`requirements.md`](https://github.com/open-gsd/gsd-pi/blob/0205aba79186d94f0d87d4fc945fcb798f92fc5d/src/resources/extensions/gsd/templates/requirements.md#L1-L81)
  and distinguishes requirement progress from validated completion in
  [`complete-slice.ts`](https://github.com/open-gsd/gsd-pi/blob/0205aba79186d94f0d87d4fc945fcb798f92fc5d/src/resources/extensions/gsd/tools/complete-slice.ts#L104-L169).
  Cruise should enforce `G-XX/R-XX/AC-XX -> T-XX -> E-XX` links and reject a
  completion claim when an active requirement has no current evidence.

### Adapt for Cruise

- Store proportional YAML records under `.cruise/runs/` instead of importing
  GSD's database/event/outbox architecture. Goal may have richer persisted
  state; Quick should have only origin, route, and evidence records.
- Compress GSD's broad command and artifact surface into the six public Cruise
  intents. Routing decides the amount of ceremony; users should not have to
  learn an orchestration vocabulary.
- Treat model profiles as preferences resolved against current Codex
  capabilities. Names such as Luna, Terra, and Sol are policy labels until the
  host proves matching selectable models.
- Apply transactional thinking—idempotency keys, expected revision, atomic
  replacement, and revalidation—without adopting database machinery that the
  plugin does not need.

### Avoid

- Do not reproduce GSD's full milestone/slice/phase command surface or default
  artifact volume.
- Do not make a database, lease manager, worktree, or commit mandatory for a
  genuinely small Quick edit.
- Do not claim background continuation, transactional rollback, or durable
  ownership unless the active Codex host actually provides and confirms it.
- Do not let readiness scores replace semantic safety gates or explicit user
  approval.

## 2. GitHub Spec Kit

### What it is

GitHub Spec Kit is an MIT-licensed specification-driven development toolkit.
The inspected snapshot was
[`github/spec-kit@1be4299`](https://github.com/github/spec-kit/tree/1be42992e64b08ff0dce3d7a914eaabf04284ffb).
It combines Markdown command templates for specify/clarify/plan/analyze with a
Python workflow engine that provides typed steps, human gates, bounded loops,
state persistence, and resume.

Its boundary matters: the engine enforces workflow state and loop mechanics;
many requirement-quality and traceability rules remain prompt policy rather
than runtime invariants.

### Adopt

- **Impact-times-uncertainty clarification.** Spec Kit inventories ambiguity,
  ranks questions by downstream impact and uncertainty, asks them one at a
  time, and integrates each accepted answer immediately in
  [`clarify.md`](https://github.com/github/spec-kit/blob/1be42992e64b08ff0dce3d7a914eaabf04284ffb/templates/commands/clarify.md#L73-L221).
  This fits Refine's zero-to-three material questions and Goal's adaptive Q&A.
- **Testable specification identities.** Its specification template gives
  functional requirements and success criteria stable IDs in
  [`spec-template.md`](https://github.com/github/spec-kit/blob/1be42992e64b08ff0dce3d7a914eaabf04284ffb/templates/spec-template.md#L26-L118).
  Cruise should extend this into explicit origin-to-goal-to-task-to-evidence
  traceability rather than relying on prose similarity.
- **Persist-before-dispatch and resumable top-level steps.** The workflow
  engine atomically replaces `state.json` and `inputs.json`, snapshots its
  workflow, and saves before and after steps in
  [`engine.py`](https://github.com/github/spec-kit/blob/1be42992e64b08ff0dce3d7a914eaabf04284ffb/src/specify_cli/workflows/engine.py#L396-L590).
  Cruise should persist YAML state before any tool or subagent boundary and
  resume only paused or failed runs.
- **Explicit human gates.** Non-interactive runs pause rather than silently
  approving in
  [`gate/__init__.py`](https://github.com/github/spec-kit/blob/1be42992e64b08ff0dce3d7a914eaabf04284ffb/src/specify_cli/workflows/steps/gate/__init__.py#L20-L97).
  Cruise should keep this fail-closed behavior while preserving Goal's exact
  case-sensitive approval labels and digest binding.
- **Read-only analysis separated from remediation.** Spec Kit's
  [`analyze.md`](https://github.com/github/spec-kit/blob/1be42992e64b08ff0dce3d7a914eaabf04284ffb/templates/commands/analyze.md#L52-L60)
  forbids writes; its
  [`converge.md`](https://github.com/github/spec-kit/blob/1be42992e64b08ff0dce3d7a914eaabf04284ffb/templates/commands/converge.md#L196-L225)
  appends traceable remediation tasks instead of editing implementation. That
  was the basis for the earlier public Review skill proposal and remains useful for
  native Codex/GitHub review and independent verification. That proposed public
  skill was retired in the Build compatibility migration to preserve six routes.
- **Every loop has a cap.** Generic loops are bounded, including
  [`do_while`](https://github.com/github/spec-kit/blob/1be42992e64b08ff0dce3d7a914eaabf04284ffb/src/specify_cli/workflows/steps/do_while/__init__.py#L10-L64),
  and specification self-repair is capped. Cruise should make every routing,
  repair, hypothesis, and provisioning retry limit explicit.

### Adapt for Cruise

- Preserve the exact triggering prompt as immutable `origin.raw_prompt`.
  Specification refinement may update normalized clauses through a change
  ledger but must never replace the origin.
- Make traceability deterministic. Spec Kit commonly links tasks to user
  stories and sometimes infers requirement coverage; Cruise should require
  explicit `satisfies`, `preserves`, and `verification` IDs.
- Use YAML for Cruise machine state. Markdown remains appropriate for plans and
  human-reviewed Goal contracts; JSON remains only at external protocol
  boundaries.
- Distinguish three different things: schema-valid workflow state, human
  approval, and actual host/tool capability. Spec Kit's `requires` metadata is
  advisory, not a permission or capability enforcement mechanism, as shown in
  [`engine.py`](https://github.com/github/spec-kit/blob/1be42992e64b08ff0dce3d7a914eaabf04284ffb/src/specify_cli/workflows/engine.py#L225-L253).
- Choose and record a requirement-mutation policy. Spec Kit documents
  flow-back, flow-forward, and living-spec approaches in
  [`spec-persistence.md`](https://github.com/github/spec-kit/blob/1be42992e64b08ff0dce3d7a914eaabf04284ffb/docs/concepts/spec-persistence.md#L26-L96),
  but Cruise should not leave propagation implicit.

### Avoid

- Do not let a generated specification erase, paraphrase away, or silently
  narrow the user's originating request.
- Do not claim exact acceptance coverage from keyword inference.
- Do not describe advisory `requires` fields as sandbox, permission, or plugin
  capability enforcement.
- Do not attribute worktree isolation or whole-run transactions to Spec Kit
  core; it provides per-file atomic state replacement and ordinary branch
  tooling, not those stronger guarantees.
- Do not require the full specify/clarify/plan/tasks hierarchy for Quick or
  small Refine work.

## 3. Fission AI OpenSpec

### What it is

OpenSpec is an MIT-licensed, artifact-driven change workflow. The inspected
snapshot was
[`Fission-AI/OpenSpec@0a99f41`](https://github.com/Fission-AI/OpenSpec/tree/0a99f410457271aa773d8b106f03f637f7c6b3c0).
The inspected package version was `1.6.0`.
It separates exploration, proposal/design/specification, task application,
verification, and archival while an artifact graph determines which outputs
are ready and which prerequisites still block work.

### Adopt

- **Dependency-aware artifacts.** The proposal workflow asks the CLI for each
  artifact's status and dependencies, creates only ready artifacts, and
  recomputes status after every write in
  [`propose.ts`](https://github.com/Fission-AI/OpenSpec/blob/0a99f410457271aa773d8b106f03f637f7c6b3c0/src/core/templates/workflows/propose.ts).
  The executable graph and its behavior are separated into
  [`graph.ts`](https://github.com/Fission-AI/OpenSpec/blob/0a99f410457271aa773d8b106f03f637f7c6b3c0/src/core/artifact-graph/graph.ts),
  [`state.ts`](https://github.com/Fission-AI/OpenSpec/blob/0a99f410457271aa773d8b106f03f637f7c6b3c0/src/core/artifact-graph/state.ts),
  and focused
  [artifact-graph tests](https://github.com/Fission-AI/OpenSpec/tree/0a99f410457271aa773d8b106f03f637f7c6b3c0/test/core/artifact-graph).
  Cruise should use the same mechanism for run dependencies and the private
  capability provisioner: nodes become ready from canonical prerequisites,
  not from an agent saying they are ready.
- **Thinking and implementation are different states.** OpenSpec's
  [`explore.ts`](https://github.com/Fission-AI/OpenSpec/blob/0a99f410457271aa773d8b106f03f637f7c6b3c0/src/core/templates/workflows/explore.ts)
  is deliberately read-only for product code, while
  [`apply-change.ts`](https://github.com/Fission-AI/OpenSpec/blob/0a99f410457271aa773d8b106f03f637f7c6b3c0/src/core/templates/workflows/apply-change.ts)
  checks required artifacts before implementation. This is the correct
  separation for Cruise Research and native review versus Quick/Refine/Goal execution.
- **Fresh context on continuation.** Apply resolves the change again, reloads
  current context files, reports completed and remaining tasks, and continues
  until done or genuinely blocked. Cruise should similarly resume from
  persisted YAML plus freshly verified repository state, never from stale
  conversational memory alone.
- **Advance one safe unit when resuming.** OpenSpec's
  [`continue-change.ts`](https://github.com/Fission-AI/OpenSpec/blob/0a99f410457271aa773d8b106f03f637f7c6b3c0/src/core/templates/workflows/continue-change.ts)
  creates exactly one ready artifact, reports what it unlocked, and stops.
  Cruise can use the same bounded continuation rule for a paused planning node
  or Goal slice.
- **Explicit change layers.** OpenSpec distinguishes proposal scope, design
  decisions, requirement specs, tasks, implementation, and verification. When
  implementation discovers a design defect, it routes the correction to the
  responsible artifact rather than papering over it in code.
- **Three-dimensional verification.** The verifier checks completeness,
  correctness, and coherence in
  [`verify-change.ts`](https://github.com/Fission-AI/OpenSpec/blob/0a99f410457271aa773d8b106f03f637f7c6b3c0/src/core/templates/workflows/verify-change.ts).
  Cruise's verifier should use the same dimensions while adding immutable
  origin coverage and direct test/diff evidence.

### Adapt for Cruise

- Make artifact updates ledgered and approval-aware. OpenSpec intentionally
  permits fluid proposal/spec/design/task changes during application; Cruise
  may do that before approval, but any change to locked Plan or Goal bytes must
  invalidate approval and return to review.
- Keep the immutable Origin Record above the artifact graph. A corrected
  design can change the normalized plan; it cannot silently redefine the raw
  request.
- Use proportional artifacts. Quick normally needs no proposal/design/spec
  set, while Goal retains its richer contract. The graph should express real
  dependencies without forcing empty files.
- Reuse the graph idea for capability provisioning: a `waiting_auth` node
  blocks only descendants, while independent ready research lanes continue.

### Avoid

- Do not expose OpenSpec's proposal/continue/apply/verify/archive command set as
  additional Cruise skills.
- Do not let unchecked task boxes or artifact existence certify completion.
- OpenSpec's current
  [`state.ts`](https://github.com/Fission-AI/OpenSpec/blob/0a99f410457271aa773d8b106f03f637f7c6b3c0/src/core/artifact-graph/state.ts)
  treats output existence as completion even when dependency order was
  violated. Cruise must add schema, semantic, traceability, and approval
  checks.
- Do not accept “implementation likely exists” as final proof; Cruise requires
  actual diff, test, static, documentation, and effect evidence as applicable.
- Do not allow fluid artifact correction to bypass Origin, decision-ledger, or
  approval locks.

## 4. Obra Superpowers

### What it is

Superpowers is an MIT-licensed library of composable agent skills and a
software-development methodology. The inspected snapshot was
[`obra/superpowers@d884ae0`](https://github.com/obra/superpowers/tree/d884ae04edebef577e82ff7c4e143debd0bbec99).
The inspected core version was `6.1.1`.
Its strength is concentrated procedural discipline: brainstorm and approve a
design before implementation, write executable plans, debug from evidence,
and verify immediately before a completion claim. It also treats skill
behavior as something to test with realistic prompt drills.

### Adopt

- **Inspect before questions; ask one at a time.** The
  [`brainstorming` skill](https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/brainstorming/SKILL.md)
  starts from project context, asks sequential questions, presents concrete
  alternatives with a recommendation, and obtains explicit approval. This is
  the interaction quality Cruise Refine and Goal should preserve.
- **Plans must be executable rather than aspirational.** The
  [`writing-plans` skill](https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/writing-plans/SKILL.md)
  expects exact file locations, bounded tasks, commands, and expected evidence.
  Cruise should add stable requirement and evidence IDs to that precision.
- **Debug scientifically.** The
  [`systematic-debugging` skill](https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/systematic-debugging/SKILL.md)
  separates reproduction, evidence gathering, pattern comparison, one
  falsifiable hypothesis/experiment at a time, root-cause repair, and
  verification. After repeated failed fixes it questions architecture rather
  than stacking another speculative patch. This maps directly to
  `cruise:debug` and its `H-XX` ledger.
- **Fresh evidence before completion.** The
  [`verification-before-completion` skill](https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/verification-before-completion/SKILL.md)
  requires running the proving command and inspecting its output immediately
  before claiming success. Cruise should make this common to all six skills.
- **Behaviorally test instructions.** Superpowers' skill-writing guidance uses
  independent agents and pressure prompts in
  [`testing-skills-with-subagents.md`](https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/writing-skills/testing-skills-with-subagents.md),
  with explicit-name/multi-turn smoke drills under
  [`tests/explicit-skill-requests`](https://github.com/obra/superpowers/tree/d884ae04edebef577e82ff7c4e143debd0bbec99/tests/explicit-skill-requests).
  Cruise should test positive, negative, boundary, and adversarial prompts—not
  only parse its Markdown frontmatter.
- **Use matched calibration pairs.** The separately maintained
  [`superpowers-evals@0a9f545`](https://github.com/prime-radiant-inc/superpowers-evals/tree/0a9f5453307e9fbdf3ded5bcd9a929edad13271c)
  pairs neutral stories, controlled fixtures, independent semantic grading,
  and hidden deterministic checks. Its strongest pattern tests the same
  fixture twice: an open-ended request must brainstorm, while a trivial
  checkbox edit must not. Cruise should create equivalent pairs for every
  adjacent skill boundary and Quick promotion gate.

### Adapt for Cruise

- Apply ceremony according to route. Superpowers applies brainstorming broadly;
  Cruise Quick must remain a safe direct-edit lane when deterministic evidence
  proves the change and implementation are already known.
- Encode boundaries in shared runtime validators as well as prose. A skill that
  says “never write” needs a baseline/diff guard capable of detecting a write.
- Preserve the raw Origin Record through brainstorm, plan, implementation, and
  verification. Approval of a derived design does not erase the triggering
  prompt.
- Use independent verification proportionally. A tiny Quick change may need a
  deterministic diff/test check; Goal may justify separate subagents and
  adversarial gates.
- Treat the core/evaluator disagreement as useful evidence: the pinned core
  says every creative change must brainstorm, while the linked evaluator
  penalizes brainstorming for a trivial checkbox edit. Cruise resolves that
  ambiguity explicitly through `quick` versus `refine` admission.

### Avoid

- Do not turn Superpowers' many sequential methodology skills into additional
  public Cruise commands or overlapping activation descriptions.
- Do not require a design document, worktree, TDD cycle, or commit for every
  typo/config correction regardless of evidence.
- Do not treat a forceful Markdown rule as mechanical enforcement.
- Do not vendor the external eval harness without a separate license decision;
  the inspected `superpowers-evals` snapshot does not declare a license.
- Do not run trusted live-agent evals as ordinary CI. Keep deterministic
  checks CI-safe and reserve live drills for controlled maintainer runs.
- Do not count `skill-called` or an LLM verdict as outcome proof. Some upstream
  checks admit shell writes can evade native edit-order assertions, and some
  scenarios have no deterministic post-check. Cruise's critical routing,
  write-boundary, and completion invariants need mechanism-independent
  evidence.
- Do not continue retrying because the process says to; bound attempts and
  promote, re-plan, or ask for a workflow decision when the evidence changes.

## 5. Aider

### What it is

Aider is an Apache-2.0 licensed terminal coding assistant with repository
mapping, model-aware edit formats, scoped file editing, Git integration, and
automated lint/test feedback. The inspected snapshot was
[`Aider-AI/aider@5dc9490`](https://github.com/Aider-AI/aider/tree/5dc9490bb35f9729ef2c95d00a19ccd30c26339c).

### Adopt

- **Architect-to-editor separation.** Aider's
  [`architect_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/architect_coder.py)
  asks the main/architect model for unambiguous implementation direction,
  requires edit confirmation when configured, then creates an editor with
  empty current and completed message histories. The
  [`architect_prompts.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/architect_prompts.py)
  contract makes the handoff explicit. Cruise should give planned executors a
  fresh, restricted context containing Origin, approved task, constraints, and
  relevant files—not the entire planning conversation.
- **Restrict what may be edited.** Aider's
  [`base_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py)
  checks whether files are in scope, ignored, dirty, or newly created before
  applying edits. Cruise should combine explicit task ownership with baseline
  checks and refuse opportunistic files.
- **Feed real lint/test failures into evidence-governed repair.** The same base
  coder captures edited files, runs configured linters/tests, and feeds their
  exact failures into reflection. Cruise should record every attempt and use
  reviewed stop conditions, changed evidence, scope expansion, and the limit
  policy—not a universal retry number—to decide whether to continue, promote,
  re-plan, or stop.
- **Resolve models by role.** Aider supports main, weak, and editor roles plus
  edit-format compatibility in
  [`models.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/models.py).
  Cruise should similarly resolve classifier, mapper, planner, executor,
  verifier, and research-synthesis roles to supported host settings.
- **Test permission and handoff behavior.** Aider covers edit admission,
  architect confirmation branches, and invocation of a mocked editor in
  [`test_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/tests/basic/test_coder.py).
  It does not assert cleared histories or restricted editor configuration;
  Cruise needs stronger tests for write boundaries and approval-to-executor
  context/state transitions.

### Adapt for Cruise

- Use Codex-native collaboration/subagent surfaces where available rather than
  recreating Aider's edit protocol. Record when a fresh execution context could
  not be provided.
- Pass traceable task inputs (`satisfies`, `preserves`, `verification`) to the
  executor, then let an independent verifier compare the result to raw Origin
  and the actual diff.
- Treat model names as resolved host capabilities. Cruise's Luna/Terra/Sol
  table expresses desired cost/reasoning roles; it must not invent unavailable
  Codex model identifiers.
- Ask before commits unless repository policy and user authorization already
  permit Cruise to commit.

### Avoid

- Do not auto-accept an architect's plan merely because a model produced it.
- Do not call the fresh editor conversation a sandbox or process-isolation
  boundary; Aider still inherits repository, file-list, I/O, and command state.
- Do not adopt Aider's large provider/model/edit-format registry; Codex owns
  that transport and capability surface.
- Do not let lint/test reflection become blind patching. A Debug route still
  needs a root-cause hypothesis, and every route needs a retry cap.
- Do not automatically stage or commit unrelated dirty files.
- Do not mistake Aider's defaults for independent verification: automatic lint
  is enabled, but automatic tests are disabled by default, and both remain in
  the editing loop.

## 6. BMAD Method

### What it is

BMAD Method is an MIT-licensed, modular product-to-delivery methodology with
many installable skills, lifecycle phases, agents, artifacts, status tracking,
and a cross-platform installer. The inspected snapshot was
[`bmad-code-org/BMAD-METHOD@b3d7943`](https://github.com/bmad-code-org/BMAD-METHOD/tree/b3d79436f8d18b9e8216b6342d218128bde89d11).
The inspected package version was `6.10.0`; the MIT license includes a
separate trademark notice.

### Adopt

- **Make the next valid action obvious.** BMAD's
  [`bmad-help` skill](https://github.com/bmad-code-org/BMAD-METHOD/blob/b3d79436f8d18b9e8216b6342d218128bde89d11/src/core-skills/bmad-help/SKILL.md)
  combines an installed-skill catalog, detected artifacts, required/optional
  phase semantics, and the user's query to recommend what comes next. Cruise's
  six-skill chooser should do the same in a far smaller decision table.
- **Scale ceremony to risk.** The
  [`quick-dev` routing step](https://github.com/bmad-code-org/BMAD-METHOD/blob/b3d79436f8d18b9e8216b6342d218128bde89d11/src/bmm-skills/4-implementation/bmad-quick-dev/step-01-clarify-and-route.md)
  treats the triggering prompt as intent, checks existing state, resumes typed
  statuses, avoids questions when intent is already clear, and reserves a
  one-shot path for changes with effectively zero blast radius. Everything
  else takes a plan/code/review path. This is the closest exemplar for Cruise's
  Quick-versus-Refine admission boundary.
- **Prompt a frozen-intent convention and route correction to the right layer.** BMAD's
  [`step-02-plan.md`](https://github.com/bmad-code-org/BMAD-METHOD/blob/b3d79436f8d18b9e8216b6342d218128bde89d11/src/bmm-skills/4-implementation/bmad-quick-dev/step-02-plan.md)
  instructs the agent to treat a reviewed section as locked, while
  [`step-04-review.md`](https://github.com/bmad-code-org/BMAD-METHOD/blob/b3d79436f8d18b9e8216b6342d218128bde89d11/src/bmm-skills/4-implementation/bmad-quick-dev/step-04-review.md)
  classifies findings as intent gaps, bad specification, patches, or deferrals
  and loops back to the responsible layer with a cap. Cruise should preserve
  the stronger immutable raw Origin and apply the same causal remediation.
- **Represent explicit lifecycle states in its workflow artifacts.** BMAD resumes `draft`,
  `ready-for-dev`, `in-progress`, and `in-review` differently, and its
  [`sync-sprint-status.md`](https://github.com/bmad-code-org/BMAD-METHOD/blob/b3d79436f8d18b9e8216b6342d218128bde89d11/src/bmm-skills/4-implementation/bmad-quick-dev/sync-sprint-status.md)
  instructs idempotent status updates without regression. These are
  prompt-enforced conventions, not runtime byte locks or an executable state
  machine. Cruise should enforce equivalent YAML states mechanically.
- **Load only proportional context.** BMAD compiles focused epic context and
  progressively loads workflow files rather than flooding every agent with all
  product artifacts. Cruise should keep each public SKILL.md compact and load
  shared references only when its phase needs them.
- **Test packaging and generated skills.** BMAD has focused tests for skill
  validation, installation components/channels, quick-flow rendering, file
  references, and adversarial review fixtures under
  [`test/`](https://github.com/bmad-code-org/BMAD-METHOD/tree/b3d79436f8d18b9e8216b6342d218128bde89d11/test).
  Cruise should test both behavior and the exact installed public surface.
  In the inspected clone, the Quick Dev renderer passed `19/19` cases and the
  validator fixtures passed `3/3`; these are structural tests, not proof of
  mutual-exclusivity behavior.
- **Preserve installation provenance and user modifications.** BMAD declares
  official modules and channels in
  [`bmad-modules.yaml`](https://github.com/bmad-code-org/BMAD-METHOD/blob/b3d79436f8d18b9e8216b6342d218128bde89d11/bmad-modules.yaml),
  validates discovered `SKILL.md` identity in
  [`manifest-generator.js`](https://github.com/bmad-code-org/BMAD-METHOD/blob/b3d79436f8d18b9e8216b6342d218128bde89d11/tools/installer/core/manifest-generator.js),
  records installed-file SHA-256 hashes, and preserves user-added or modified
  files during update in
  [`installer.js`](https://github.com/bmad-code-org/BMAD-METHOD/blob/b3d79436f8d18b9e8216b6342d218128bde89d11/tools/installer/core/installer.js).
  Cruise should reuse those provenance principles for packaging and the
  private provisioner, while keeping Codex's own plugin mechanism authoritative.

### Adapt for Cruise

- Compress the lifecycle into six intent-based skills. Cruise routing should
  identify the user's objective and epistemic state, not make them select from
  product-manager, architect, developer, QA, and retrospective personas.
- Replace BMAD's broad help catalog with one deterministic routing table plus a
  bounded semantic classifier. The explicitly selected Cruise skill wins when
  uncertainty remains, except for hard safety/promotion gates.
- Use one-at-a-time material questions. BMAD Quick Dev sometimes asks a
  numbered batch; Cruise Refine and Goal should retain the lower-cognitive-load
  sequential interaction.
- Reuse Codex's real plugin installation and skill discovery rather than
  importing BMAD's multi-platform generator/installer architecture.
- Apply BMAD's registry/channel/hash ideas to `_provision`, adding Cruise's
  pinned trusted sources, local scope, smoke validation, auth-wait DAG, and
  secret-redaction rules.

### Avoid

- Do not reproduce BMAD's persona count, party mode, phase vocabulary, or
  dozens of public workflows.
- Do not copy Quick Dev's automatic commit/editor-opening behavior; Cruise
  must remain host-neutral and require the relevant permission.
- Do not use BMAD Code Review as the model for native Codex/GitHub review: BMAD's workflow
  may modify product code and status after user choice, while native review findings do not
  silently gain Cruise implementation authority.
- Do not infer completion solely because an expected artifact exists; inspect
  content, state, diff, and evidence.
- Do not treat optional sequencing guidance as a hard permission gate.
- Do not describe BMAD's scale-adaptive routing as a deterministic classifier;
  at this snapshot it is primarily prompt policy.
- Do not let status files regress, overwrite user-managed state, or become a
  second source of truth that conflicts with the immutable Origin.

## Concrete Cruise changes derived from the exemplars

The lessons above imply these repository-level changes:

| Cruise area | Change to make | Primary exemplars |
| --- | --- | --- |
| Public surface | Register exactly `build`, `quick`, `refine`, `goal`, `debug`, and `research`, each with positive/negative admission and one nearest handoff | BMAD, Superpowers |
| Shared origin | Capture raw prompt bytes/hash once; ledger every normalized goal change | Spec Kit, BMAD, OpenSpec |
| Shared router | Bounded deterministic probe, one semantic classification, one low-confidence reclassification, hard Quick promotion, no loops | GSD, BMAD |
| Model policy | Resolve role/tier preferences against actual Codex capabilities and record fallback/escalation | GSD, Aider |
| Artifact naming | Assign short semantic repository/run namespaces through level 1; keep stable purpose filenames separate from record-contained hashes | Cruise synthesis from GSD ownership, BMAD next-action clarity, and OpenSpec compactness |
| Run state | Persist YAML cursor, attempts, dependencies, evidence, and terminal status before dispatch | GSD, Spec Kit, OpenSpec |
| Traceability | Require `G/R/AC -> T -> E` links and verify them against Origin plus actual diff | GSD, Spec Kit |
| Build | Establish bootstrap or milestone contracts, discovery viability gates, phase DAGs, and an approved persistent queue without implementing product code | GSD, Spec Kit, OpenSpec, BMAD |
| Quick | Smallest scoped edit, focused proof, append-only repair evidence, and promotion on semantic expansion | Aider, BMAD |
| Refine | Inspect, ask zero-to-three sequential material questions, approve one plan, execute current-thread, independently verify | Spec Kit, Superpowers |
| Goal | Preserve one exact combined approval, digest locks, inactive-before-activation boundary, and native Goal activation; add Origin and final origin-to-diff verification | GSD, Cruise compatibility anchor |
| Debug | Ranked `H-XX` hypotheses, cheapest discriminating experiment, root-cause test/fix, architecture escalation | Superpowers |
| Native review | Keep adversarial findings mechanically separate from a new explicit Cruise remediation request | Spec Kit, OpenSpec |
| Research | Read-only evidence lanes, source hierarchy, conflict synthesis, repository-grounded recommendation | OpenSpec, Superpowers |
| Private provisioner | Dependency DAG, trusted local installation, provenance, smoke validation, `waiting_auth` descendants paused while siblings continue | OpenSpec, GSD, BMAD |
| Evals | Prompt routing matrix, pressure cases, exact-surface static tests, and independent forward drills | Superpowers, BMAD |

## Deliberate non-adoptions

Cruise should explicitly decline the following even though an exemplar uses
them successfully:

- GSD's full command/artifact/database orchestration for every task.
- Spec Kit's assumption that a derived specification can be the earliest
  authoritative record.
- OpenSpec's unrestricted fluid mutation once Cruise Plan or Goal bytes are
  approved.
- Superpowers' universal design ceremony for proven low-risk edits.
- Aider's provider/model/edit-format registry and automatic Git behavior.
- BMAD's personas, party mode, full lifecycle vocabulary, and large public
  chooser.

The governing rule is: adopt mechanisms that make state, evidence, routing,
and safety more truthful; adapt them to Codex's verified surfaces; reject any
ceremony or capability claim that does not improve one of those properties.
