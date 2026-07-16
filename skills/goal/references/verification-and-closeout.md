# Verification and Closeout

Use adversarial, current evidence to decide whether the approved Cruise slice completed or stopped blocked.

## Table of contents

- [1. Gate principles](#1-gate-principles)
- [2. T-01 contract](#2-t-01-contract)
- [3. Select gates](#3-select-gates)
- [4. Gate record](#4-gate-record)
- [5. Status semantics](#5-status-semantics)
- [6. Deterministic evidence](#6-deterministic-evidence)
- [7. Unavailable evidence and waivers](#7-unavailable-evidence-and-waivers)
- [8. Remediation and retest](#8-remediation-and-retest)
- [9. CLOSEOUT.md](#9-closeoutmd)
- [10. Completion audit](#10-completion-audit)

## 1. Gate principles

A gate attempts to falsify a named requirement, criterion, or locked decision. It is not a generic checklist or confidence score.

- derive gates from actual failure hypotheses;
- keep count proportional to consequence and uncertainty;
- prefer reproducible deterministic checks;
- protect both new behavior and explicit non-regression behavior;
- keep gate judgment separate from implementation when fresh review is available;
- preserve every attempt;
- never turn “looks good” into PASS.

There is no universal gate pack. A data migration, UX workflow, performance experiment, auth change, and documentation contract require different adversaries.

## 2. T-01 contract

Reserve exactly one `T-01` node for the read-only verifier in every new suite. `T-01`:

- reads and validates immutable `ORIGIN.yaml` before relying on derived contracts;
- remains read-only across repository files, planning artifacts, processes, infrastructure, databases, and external systems;
- reads protected `R-XX`, `AC-XX`, and `D-XX` before judging;
- verifies each selected gate has complete current evidence;
- may run only read-only, authorized checks;
- asks the integration owner to perform mutating, privileged, paid, or external checks;
- challenges stale, irrelevant, weakened, skipped, ambiguous, or non-reproducible evidence;
- returns only `PASS`, `BLOCK`, or `NOT_RUN`; advisory is a gate class, never a status;
- names remediation and retest requirements for every non-pass.

`T-01` never edits a fixture, expected result, snapshot, implementation, or planning artifact. If no fresh reviewer exists, disclose sequential `T-01` verification and do not claim independent review.

## 3. Select gates

For each mandatory criterion and high-consequence decision, ask:

1. What plausible implementation could appear complete while violating it?
2. What alternate path, edge input, concurrency case, or rollback would happy-path tests miss?
3. Could the evidence be stale, self-authored, weakened, environment-dependent, or tied to the wrong build?
4. Could a shared resource or permission fail outside the edited module?
5. What smallest check exposes the failure?
6. Does the check itself mutate, send, deploy, expose data, or consume money?

Candidate families:

| Family | Typical threat |
| --- | --- |
| Behavioral | Edge or alternate flow violates promised result |
| Regression/compatibility | Existing consumers or formats break |
| Data/migration | Retry, mixed version, rollback, or integrity fails |
| Security/privacy | Trust boundary or sensitive data leaks |
| Integration/contract | Schemas, lifecycle, manifests, or errors disagree |
| Performance/reliability | Threshold fails under reproducible load or recovery |
| Accessibility/usability | Critical workflow fails for required modes or input |
| Reproducibility | Result cannot be recreated from recorded inputs |
| Operational/rollback | Failure is undetectable or protected state cannot restore |
| Documentation | Published promise disagrees with actual interface |

Mark each gate Mandatory or Advisory. Do not downgrade a mandatory gate because it is expensive or unavailable.

## 4. Gate record

Use monotonically assigned `E-XX` evidence/gate IDs. Existing locked legacy suites may retain their `VG-XX` IDs, but never create a new `VG-XX` record:

```markdown
### E-01 — [Title]

- **Class:** Mandatory | Advisory
- **Threat:** [specific plausible failure]
- **Protects:** [R-XX, AC-XX, D-XX]
- **Preconditions:** [stable outputs, environment, fixture, permission]
- **Checks:** [exact commands/procedures and expected results]
- **Reviewer duty:** [edge case or evidence challenge]
- **Evidence:** [pending, then immutable records and identities]
- **Status:** PASS | BLOCK | NOT_RUN
- **Rationale:** [evidence-linked result]
- **Remediation owner:** [integration owner after handoff, or None on PASS]
- **Retest:** [exact affected checks]
- **Waiver:** [locked D-XX or None]
```

Do not renumber a reviewed gate. Preserve replaced definitions and execution attempts.

## 5. Status semantics

- `PASS` — the full gate ran against current inputs, expected evidence holds, and reviewer duty found no contradiction.
- `BLOCK` — current evidence shows failure, invalid prerequisites, weakened checks, or an approval boundary violation.
- An Advisory-class gate still records `PASS`, `BLOCK`, or `NOT_RUN`; its class determines whether a non-pass blocks completion, and any non-blocking risk is recorded as an `F-XX` finding rather than inventing a fourth evidence status.
- `NOT_RUN` — required checks did not run or did not produce valid current evidence.

Do not use SKIP, PARTIAL, WARN, or assumed pass. Partial execution is NOT_RUN unless completed checks independently satisfy the entire gate.

A mandatory gate succeeds only with PASS. A locked waiver may allow a final mandatory NOT_RUN while preserving the status and reporting `Completed (waiver-qualified)`; it never converts the gate to PASS.

## 6. Deterministic evidence

Record:

- exact command or reproducible procedure;
- fixed/recorded inputs, fixtures, environment, versions, and approvals;
- source, build, generated-output, and artifact identities;
- expected exit status, output, invariant, threshold, or observation;
- actual result including warnings and skipped tests;
- durable log, trace, screenshot, diff, measurement, or returned report;
- freshness condition and cleanup.

Insufficient evidence includes:

- implementer assertion;
- “all tests pass” without command and coverage relevance;
- screenshot without build/scenario identity;
- stale output predating changes;
- metric without baseline/method/sample;
- model judgment without an approved rubric and source artifacts;
- successful command whose relevant tests were skipped;
- planned check that was never run.

Manual evidence can be mandatory when steps, inputs, environment, expected observations, and capture are reproducible.

For a change-set or write-ownership gate, `git diff` alone is insufficient because it omits untracked files. Bind the baseline's tracked-diff digest and untracked path/digest manifest, then collect a current untracked-aware inventory such as `git status --porcelain=v1 -z --untracked-files=all` and digest every owned new regular file with no-follow reads. Apply `scripts/lib/repository-scope.mjs` before recording or presenting that inventory: auto-clear disposable artifacts first, and never let paths outside canonical product scope become evidence, status output, a question, or conversational content, even when tracked. Compare the scoped current inventory with the approved product paths and the separately allowed Cruise control/planning paths. A sole-product-write claim must fail on any extra tracked or untracked product path, symlink, type change, missing owned output, or unexplained digest drift.

## 7. Unavailable evidence and waivers

When a check cannot run:

1. record the exact missing permission, tool, fixture, hardware, account, environment, service, or cost;
2. try only safe equivalent checks that protect the same criterion;
3. use NOT_RUN when equivalent evidence remains unavailable;
4. treat mandatory NOT_RUN as blocking.

A waiver must be a separate locked decision naming the gate and criteria, reason, accepted residual risk, compensating evidence, owner, and reopening/follow-up trigger. Respect non-waivable requirements.

Never describe waiver-qualified completion as unconditional success.

## 8. Remediation and retest

`T-01` returns a report; the integration owner records and remediates after exclusive ownership handoff.

When remediation changes upstream output:

- preserve the prior gate attempt;
- mark the changed node and transitive descendants stale;
- invalidate consuming checks and gates;
- replay the affected DAG suffix in topological order;
- regenerate shared outputs and record new identities;
- rerun every affected gate.

Attempt history:

| Attempt | Gate | Input identity | Status | Evidence/finding | Remediation/replay | Retest |
| --- | --- | --- | --- | --- | --- | --- |
| 01 | E-01 | [identity] | BLOCK | [record] | Integration owner updates T-03; replay T-05 | Full E-01 |
| 02 | E-01 | [identity] | PASS | [record] | None | Complete |

Do not draw cyclic `T-01 → T-03 → T-01` edges. The static DAG defines dependency/replay order; the attempt log records temporal retries.

## 9. CLOSEOUT.md

Create only after confirmed activation:

```markdown
# Closeout: G-XX — [Title]

- Execution state: Active | Completed | Completed (waiver-qualified) | Blocked
- Combined approval and activation record: [Plan/Goal digests, permission envelope, user context]
- Activation/fallback: [method, timestamp, returned native identity/state or truthful fallback]
- Executed baseline: [repo and dirty/untracked identities]
- Final source/output identity: [identity]
- Last updated: [timestamp]

## Outcome
[Delivered result or exact blocked condition.]

## Node attempts
| Node | Attempt | Owner | Inputs | Actual result/output | Focused evidence | State |

## Changes and effects
| Scope/resource | Change/effect | Permission D-ID | Evidence and cleanup/rollback |

## Completion evidence
| AC | Expected check/result | Current actual evidence | Result |

## Verification attempts
| Attempt | Gate | Input identity | Status | Evidence/finding | Remediation/retest |

## Deviations and reopened decisions
[None or exact affected IDs and disposition.]

## Remaining risk and deferred work
[Advisories, waivers, later slices, or blockers.]

## Final determination
- Mandatory evidence: PASS | BLOCK | WAIVER-QUALIFIED
- Mandatory gates: PASS | BLOCK | WAIVER-QUALIFIED
- Goal state: Completed | Completed (waiver-qualified) | Blocked
- Resume prerequisite: [None or exact permission/decision/evidence]
```

Record actual commands, changes, effects, and tool use. Never fabricate a completed node or evidence.

## 10. Completion audit

Before claiming completion, prove:

- the raw origin hash is valid and no origin clause was silently dropped or redefined;
- every explicit in-scope requirement belongs to this slice and has current evidence;
- every mandatory criterion has the expected actual result;
- every mandatory gate is PASS or explicitly waiver-qualified NOT_RUN;
- no BLOCK remains;
- every locked decision and permission was obeyed;
- no future-slice work or unapproved effect occurred;
- all failed attempts and material deviations remain visible;
- source/build/environment identities match the evidence;
- local processes, browser contexts, temporary data, and external effects have recorded cleanup or retained-state rationale;
- CLOSEOUT reflects the real repository and system state.

If any proof is missing, weak, indirect, or stale, continue in scope or stop Blocked. Absence of an observed failure is not completion proof.
