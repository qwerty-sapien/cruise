# Worker routing

## Root coordinator

- Model: GPT-5.6 Sol.
- Reasoning: high.
- Responsibilities: intent, risk classification, work decomposition, delegation, integration, conflict resolution, final review, quota decisions.
- Prohibited routine work: full repository scans, bulk file reading, mechanical edits, repetitive test triage, broad log review.

## Levels

| Level | Model and effort | Normal use | Exclusions |
| --- | --- | --- | --- |
| L1 | GPT-5.6 Luna medium | naming, formatting, concise docs, deterministic extraction, read-only map, one-symbol mechanical change | behavior changes, sensitive boundaries |
| L2 | GPT-5.6 Terra xhigh | one local component, clear owner, clear test, low-risk implementation | public contract or cross-package ambiguity |
| L3 | GPT-5.6 Terra ultra | bounded multi-file bug or feature, local API, moderate ambiguity | high-consequence boundaries |
| L4 | GPT-5.6 Sol xhigh | ordinary multistep implementation, cross-package integration, difficult but non-sensitive debugging | security, privacy, money, migrations, scientific claims, physical effects |
| L5 | GPT-6 Astra high | auth, authorization, PII, biometrics, payment, signing, replay, concurrency, migrations, retention, scientific estimands, holdouts, external contracts, hardware control | unresolved contradictory high-risk architecture |
| L6 | GPT-5.6 Sol ultra | L5 work with material contradictory evidence or one evidence-backed reasoning failure | routine second attempt |
| L7 | GPT-6 Astra xhigh for direct exceptional-consequence work; ultra only for an evidenced escalation from L6 | exceptional high-consequence architecture or a narrow L6 blocker with new evidence showing deeper reasoning is required | general execution, broad swarms |

## Deterministic selection

Start with a complexity level:

```text
one symbol or nonsemantic                -> L1
one local component with clear test      -> L2
bounded multi-file local behavior        -> L3
ordinary cross-module or multistep work  -> L4
```

Then apply the consequence floor:

```text
security, privacy, identity, payment, signing, replay,
tenant scope, migration, retention, scientific inference,
protected holdout, external production action, hardware effect -> at least L5
```

Use the higher level.

## Escalation

Escalate only when all conditions hold:

1. The worker produced concrete workspace evidence.
2. The blocker is attributable to reasoning uncertainty rather than tooling, environment, permissions, dependencies, or transport.
3. The next level has a specific expected advantage.
4. The next attempt has a new discriminating check.
5. The quota reservation can cover it.

A repeated prompt with the same evidence is prohibited.

For the exceptional L6-to-L7 reasoning transition, use a managed Codex worker
with `--complexity repeated --level 7 --reasoning-escalation-evidence <text>`
and the required exceptional consequence and rationale. Generic `--evidence`
is capsule context only and never selects Astra ultra; without the dedicated
field, an explicit L7 override remains a direct Astra-xhigh request.

## Astra role briefs

For L5 and L7 Astra work, state the bounded task authority and autonomous follow-through to completion, require concise output, and set testing proportional to changed risk. Prompts retain their architecture; add only these model-aware role briefs.

## De-escalation

After the owner, invariant, and patch shape are known:

- keep high-risk implementation and review at the consequence floor;
- route mechanical support work, fixtures, formatting, or deterministic extraction to a lower level;
- return unrelated work to its original level;
- close the escalated worker instead of carrying its expensive thread forward.

## Review pairing

- L1-L2: root review is sufficient unless public behavior changed.
- L3-L4: root review plus focused regression test.
- L5: independent L5 review of a stable diff.
- L6-L7: independent review at least one level below or equal to the executor, with a distinct adversarial question.

The reviewer receives the diff, invariants, and tests. It does not receive the implementer's full reasoning transcript.
