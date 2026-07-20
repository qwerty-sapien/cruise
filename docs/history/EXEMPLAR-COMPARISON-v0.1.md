# Cruise exemplar comparison

> **Historical v0.1 architecture note.** This comparison describes the retired
> Cruise control plane and its evidence. Module names below are preserved as a
> record of that design; they are not part of the current product.

## Question

To what extent has Cruise combined the strongest ideas from eight well-designed meta-prompting and development harness repositories without inheriting their avoidable complexity?

## Scope: why the count is eight

The source analysis groups the repositories into six product families, but it inspected eight distinct implementations:

| # | Repository | Role in the comparison |
| ---: | --- | --- |
| 1 | [`open-gsd/gsd-pi@0205aba`](https://github.com/open-gsd/gsd-pi/tree/0205aba79186d94f0d87d4fc945fcb798f92fc5d) | Runtime orchestration, gates, recovery, ownership, and worktree safety |
| 2 | [`open-gsd/gsd-core@6504afa`](https://github.com/open-gsd/gsd-core/tree/6504afa843364753e3d4644f77bc7c6dfaed7d0a) | Methodology, requirements, ambiguity, phases, and proof |
| 3 | [`github/spec-kit@1be4299`](https://github.com/github/spec-kit/tree/1be42992e64b08ff0dce3d7a914eaabf04284ffb) | Specification-driven clarification, traceability, gates, and persisted workflows |
| 4 | [`Fission-AI/OpenSpec@0a99f41`](https://github.com/Fission-AI/OpenSpec/tree/0a99f410457271aa773d8b106f03f637f7c6b3c0) | Lightweight artifact graphs, exploration, application, verification, and continuation |
| 5 | [`obra/superpowers@d884ae0`](https://github.com/obra/superpowers/tree/d884ae04edebef577e82ff7c4e143debd0bbec99) | Procedural skill discipline: brainstorm, plan, debug, and verify |
| 6 | [`prime-radiant-inc/superpowers-evals@0a9f545`](https://github.com/prime-radiant-inc/superpowers-evals/tree/0a9f5453307e9fbdf3ded5bcd9a929edad13271c) | Matched behavioral trials, hidden deterministic checks, and independent grading |
| 7 | [`Aider-AI/aider@5dc9490`](https://github.com/Aider-AI/aider/tree/5dc9490bb35f9729ef2c95d00a19ccd30c26339c) | Architect/editor separation, scoped edits, model roles, and test-fed repair |
| 8 | [`bmad-code-org/BMAD-METHOD@b3d7943`](https://github.com/bmad-code-org/BMAD-METHOD/tree/b3d79436f8d18b9e8216b6342d218128bde89d11) | Scale-adaptive workflow choice, lifecycle state, context discipline, and packaging |

The revisions are pinned so the comparison describes inspected behavior rather than a moving project name.

## Verdict

Cruise is credibly a **strong synthesis**, not yet a proven universal “best of all worlds.”

It has implemented the most important structural ideas from all eight repositories and, in several places, added a stronger authority model than any one exemplar. Its strongest combinations are immutable Origin plus exact traceability, evidence-based routing plus proportional ceremony, root/worker separation plus byte-bound authority, artifact DAGs plus replayable state, and human-readable locators plus record-contained integrity.

The remaining gap is empirical rather than architectural: independent, repeated, live comparative trials are still needed before claiming that the combined system improves real development productivity across repositories, models, and task classes.

### Assessment scale

| Mark | Meaning |
| --- | --- |
| **Strong** | Mechanically implemented and covered by focused tests or runtime validation |
| **Partial** | Present, but host-dependent, incompletely exercised, or awaiting broader evaluation |
| **Diverged** | Deliberately changed because Cruise has a different public surface or stronger boundary |
| **Rejected** | Intentionally not adopted |

## Repository-by-repository comparison

| Repository | Best contribution | Cruise realization | Extent | Evidence in Cruise |
| --- | --- | --- | --- | --- |
| Open GSD `gsd-pi` | Mechanical gates, persisted recovery, ownership, bounded repair | Opaque host authorities, foreign-diff guard, replayed queue/controller state, owned paths, evidence-governed attempts | **Strong** | `scripts/lib/host-authority-lock.mjs`, `foreign-diff-guard.mjs`, `build-queue-coordinator.mjs`, `milestone-controller.mjs` |
| Open GSD `gsd-core` | Explicit ambiguity, requirements, phases, and completion proof | Six route contracts, Build viability, stable IDs, Goal phases, closeout evidence | **Strong** | `skills/build/`, `skills/goal/`, `internal/schemas/` |
| GitHub Spec Kit | Highest-impact clarification, stable requirements, human gates, persisted workflow state | One-at-a-time material questions, immutable Origin above normalized requirements, exact Build/Plan/Start approvals, YAML run state | **Strong / Diverged** | `scripts/lib/origin.mjs`, `interaction.mjs`, `build-contract.mjs`, `session.mjs` |
| Fission AI OpenSpec | Lightweight artifact graph, separate exploration/application, fresh continuation | Build and capability DAGs, read-only Research, ready prerequisites, resume from verified files and baseline | **Strong / Diverged** | `build-queue-coordinator.mjs`, `provision-policy.mjs`, `workflow-policy.mjs` |
| Obra Superpowers | Inspect before asking, executable plans, scientific debugging, fresh verification | Repository-first questions, exact task/evidence edges, `H-XX` debugging, current closeout evidence | **Strong** | `skills/refine/`, `skills/debug/`, `skills/goal/references/verification-and-closeout.md` |
| Superpowers Evals | Paired boundary tests and hidden deterministic proof | Paired Goal study, six-skill routing suite, boundary/pressure cases, Deep/Troubleshoot canaries | **Partial** | `evals/`, `scripts/validate-suite.mjs`, `scripts/lib/doctor-e2e.mjs` |
| Aider | Architect/editor separation, edit admission, role-based models, test-fed repair | Root/worker split, immutable launcher packets, write projection and diff attribution, seven worker levels, evidence-governed repair | **Strong / Diverged** | `scripts/lib/worker-session.mjs`, `worker-policy.mjs`, `model-policy.mjs`, `foreign-diff-control.mjs` |
| BMAD Method | Obvious next action, scale-adaptive ceremony, typed lifecycle, proportional context, install provenance | Six mutually exclusive skills, deterministic handoffs, Quick promotion, persisted states, progressive skill references, cache/source verification and hooks | **Strong** | `README.md`, `skills/`, `scripts/lib/routing.mjs`, `doctor-plugin-cache.mjs`, `git-update.mjs` |

## Where Cruise combines multiple worlds

### 1. Intent that cannot be silently rewritten

| Input idea | Cruise synthesis |
| --- | --- |
| Spec Kit requirements and clarification | Stable, testable normalized intent |
| BMAD frozen reviewed intent | Approved layers do not drift casually |
| OpenSpec mutable planning artifacts | Pre-approval learning remains possible |
| Cruise addition | The exact original request sits above every derived artifact and never changes |

**Extent: Strong.** This is one of Cruise’s clearest improvements. The exemplars preserve specifications or reviewed sections; Cruise also preserves the raw triggering bytes and repository identity.

### 2. Proportional workflow selection

| Input idea | Cruise synthesis |
| --- | --- |
| BMAD scale-adaptive routing | Ceremony varies with task size and uncertainty |
| Superpowers design discipline | Material uncertainty is resolved before editing |
| Aider direct editing | Exact low-risk work stays direct |
| GSD ambiguity checks | Admission is evidence-based and fail-closed |
| Cruise addition | Six mutually exclusive public intents plus 17 Quick promotion gates and one explicit handoff |

**Extent: Strong, with evaluation risk.** The architecture is coherent; routing precision still needs broad live measurements across natural prompts.

### 3. Planning that becomes executable authority

| Input idea | Cruise synthesis |
| --- | --- |
| Superpowers executable plans | Exact locations, commands, and expected evidence |
| Spec Kit human gates | Explicit pause and approval |
| OpenSpec artifact prerequisites | Only ready work advances |
| GSD write gates and ownership | Runtime checks, not prompt claims, decide admission |
| Cruise addition | Review digests, one-use selections, byte-bound receipts, and separate Plan/Start authority |

**Extent: Strong.** Cruise goes beyond Markdown enforcement by making approval artifacts inert unless the host transaction and current bytes agree.

### 4. Durable execution without conversational amnesia

| Input idea | Cruise synthesis |
| --- | --- |
| GSD recovery cursor and ownership | Persist before dispatch and resume one valid unit |
| Spec Kit state snapshots | Top-level workflow state survives interruption |
| OpenSpec fresh continuation | Reload current artifacts instead of trusting chat memory |
| BMAD typed lifecycle | State determines the next valid action |
| Cruise addition | Hash-chained histories, durable commitments, replay validation, and baseline reconciliation |

**Extent: Strong but complex.** The mechanisms are unusually thorough. Their operational value and maintainability should be watched because this is where synthesis can become over-engineering.

### 5. Workers that cannot inherit root authority

| Input idea | Cruise synthesis |
| --- | --- |
| Aider architect/editor contexts | Planning and editing roles are separated |
| GSD ownership | Work units have explicit scope and responsibility |
| Superpowers independent verification | Completion is challenged by fresh evidence |
| Cruise addition | Launcher packets bind exact paths, effects, permissions, IDs, dependencies, limits, and stop conditions; workers cannot question, approve, reroute, activate, integrate, or finalize |

**Extent: Strong.** Cruise turns a useful conversational separation into a host-enforced authority separation.

### 6. Evidence rather than self-certification

| Input idea | Cruise synthesis |
| --- | --- |
| Superpowers fresh verification | Run the proving check before the claim |
| Spec Kit traceability | Requirements have stable identity |
| OpenSpec multidimensional verification | Check completeness, correctness, and coherence |
| Superpowers Evals hidden checks | Do not trust only the agent’s report |
| Cruise addition | `G/R/AC → T → E` edges, actual diff/effect checks, explicit `NOT_RUN`, and separate closeout authority |

**Extent: Strong internally; Partial comparatively.** Cruise can police its own claims, but proving productivity gains needs external experimental evidence.

### 7. Safe coexistence with human work

| Input idea | Cruise synthesis |
| --- | --- |
| Aider dirty-file admission | Notice repository state before editing |
| GSD worktree safety | Verify repository identity and ownership |
| BMAD update provenance | Preserve user modifications |
| Cruise addition | Record all pre-existing bytes as baseline, attribute only receipt-backed changes, persist unexplained drift, and never auto-restore |

**Extent: Strong and distinctive.** This is not borrowed wholesale from any exemplar; it emerges from combining ownership, provenance, and scoped editing.

### 8. Capability discovery and installation

| Input idea | Cruise synthesis |
| --- | --- |
| BMAD installer manifests and hashes | Record provenance and preserve local state |
| OpenSpec dependency graph | Block descendants while independent nodes remain ready |
| GSD capability-aware profiles | Resolve desired roles against available capabilities |
| Cruise addition | Prefer existing Codex capabilities, require trusted immutable sources, persist redacted state, enter `waiting_auth`, and smoke-test actual identity/version/scope |

**Extent: Strong.** The design is notably more conservative than an ordinary auto-installer.

### 9. Authority paths humans can operate

| Input idea | Cruise synthesis |
| --- | --- |
| GSD explicit ownership | Durable state has a mechanically known owner and location |
| BMAD obvious next action | Names should tell an operator what they are looking at |
| OpenSpec compact artifacts | A small vocabulary is easier to navigate than opaque machinery |
| Spec Kit traceability | Integrity must still bind exact source and derived bytes |
| Cruise addition | Level 1 assigns semantic repository/run namespaces; every Cruise-assigned generated component is at most 15 characters; stable protocol files use purpose names; hashes stay inside records |

**Extent: Strong and distinctive.** Cruise separates the human locator from the cryptographic identity. `checkout-fix/drift.yaml` is operable at a glance; its record-contained SHA-256 still proves exact bytes. UUIDs, hash fragments, timestamps, PIDs, and random suffixes are rejected from Cruise-generated artifact paths.

## Deliberate non-adoptions

| Exemplar behavior | Cruise decision | Why |
| --- | --- | --- |
| GSD’s full command and database surface | **Rejected** | Six public intents should hide orchestration vocabulary |
| Spec Kit’s full artifact hierarchy for every task | **Rejected** | Quick and small Refine work need proportional artifacts |
| OpenSpec’s fluid post-approval mutation | **Diverged** | Locked Plan or Goal bytes must invalidate approval when changed |
| Superpowers brainstorming for every creative change | **Diverged** | Proven, closed, low-risk edits belong in Quick |
| Aider’s provider/model/edit-format registry and automatic Git behavior | **Rejected** | Codex owns transport; Cruise must preserve unrelated user work and ask before commits |
| BMAD personas, party mode, and large workflow catalog | **Rejected** | Intent-based routing is clearer than role selection |
| Universal numeric repair limits | **Rejected** | Evidence and reviewed stop conditions are more meaningful than an arbitrary attempt count |
| Output existence or task checkboxes as completion | **Rejected** | Completion requires semantic, approval, baseline, and evidence validation |

## Remaining gaps

| Gap | Why it matters | Best next evidence |
| --- | --- | --- |
| Cross-repository live trials | Synthetic and fixture coverage may not represent real development work | Repeated blinded comparisons across languages, repo sizes, and all six routes |
| Routing calibration | Conservative gates can reduce productivity if false positives over-promote | Confusion matrix with human-adjudicated route labels and cost-of-error analysis |
| Host portability | Some guarantees depend on current Codex app-server and native Goal behavior | Compatibility matrix across supported Codex versions and surfaces |
| Complexity cost | Durable receipts, commitments, and replay logic may be expensive to maintain | Fault-injection results, recovery time, defect density, and operator-comprehension studies |
| Independent verification quality | A separate worker is not automatically independent if it shares assumptions or weak tests | Hidden deterministic oracles plus adversarial graders |
| Productivity claim | Safety and structure do not by themselves prove faster delivery | Paired outcome quality, elapsed time, intervention count, regressions, and user confidence |
| Documentation comprehension | A safer system can still fail if users cannot choose or operate it | Task-based usability test using only README and linked guides |

## Bottom line

Cruise has combined the **mechanical durability of GSD**, **specification and clarification discipline of Spec Kit**, **artifact agility of OpenSpec**, **procedural rigor of Superpowers**, **experimental instincts of Superpowers Evals**, **role and edit separation of Aider**, and **scale-aware usability of BMAD**.

Its most original contribution is the authority layer joining those ideas: immutable raw Origin, host-owned one-use receipts, receipt-backed write attribution, replayed queue state, legible semantic namespaces, and separate approval/permission/activation boundaries.

That supports a strong engineering claim: **Cruise is a deliberate synthesis of the eight harnesses’ best mechanisms.** It does not yet support the stronger empirical claim that Cruise is universally more productive. That claim should wait for the comparative evaluation program described above.
