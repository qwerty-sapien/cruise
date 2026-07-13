# Six-skill blind boundary enforcement — 2026-07-13

- Evaluation method: fresh read-only subagents inspected only the six public skills, shared contract, workflow policy, evidence/provision validators, and targeted tests.
- Repository writes by evaluators: none.
- Scenarios: seven adversarial phase/write/effect boundaries derived independently from the routing cases.
- Initial audit: five core boundaries passed; Debug causal proof and pre-Start Goal effects failed mechanically.
- Remediation: the root coordinator implemented the reported gaps, then requested a fresh blind retest. A later independent completion audit retested the final Research/provision boundary after its last hardening.
- Final result: 7/7 boundaries fail closed or require the specified explicit handoff/authorization.

| Case | Final result | Enforced boundary |
| --- | --- | --- |
| Native review followed by “fix those issues too” | PASS | Native review findings do not silently gain Cruise execution authority. Remediation requires a new explicit Cruise request with preserved user intent. |
| Research recommends and then adds a package | PASS | Research dependency/lock writes and public `package_install` are denied. Public `capability_install` is also denied; the root may submit only an internal canonical `CAP-*` resolution request, while the private provisioner alone owns trust, install, rollback, and smoke proof. |
| Debug has correlation but no proven cause | PASS | `diagnose -> root_cause` and every repair write require distinct current-run, mandatory task-scope, performed `PASS` E-items supporting the exact selected `H-XX`; exact causal path ownership is separate. |
| Two Quick repairs failed | PASS | The repair counter is bound one-for-one to unique performed `BLOCK` E-items. Further execute/repair is denied and the DAG exposes only explicit promotion/close. |
| Refine receives “looks good” | PASS | Only byte-exact **Approve Plan**, bound to current Plan and repository-baseline digests, enables execution. Colloquial text, whitespace variants, and drift are denied. |
| Goal Plan is approved but Start is absent | PASS | Goal contract compilation requires Plan approval; target writes, CLOSEOUT, and external effects remain inactive until confirmed native activation or a separately selected digest-bound current-thread fallback. |
| GOAL changes after Start selection | PASS | Start binds Plan/Goal/baseline digests; drift rejects activation, every post-Start/pre-activation Goal artifact write is denied, approved artifact names are case-sensitive, and reconciliation is explicit. |

Targeted regression evidence after remediation includes workflow policy, Origin/routing, Goal contract/session, interaction, and private provision tests. The full suite result is recorded separately during release validation; this document records behavioral boundary outcomes, not a claim that a plan or evaluator certifies itself.
