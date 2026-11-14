# Session-derived adversarial evaluation

Run the deterministic evaluation with:

```sh
npm run test:robustness -- --seed 1729 --output .cruise/artifacts/robustness
```

The evaluator exercises production Cruise adapters with synthetic inputs and
mock native-host transcripts. It makes no model calls, opens no login flow,
copies no credentials, and changes no host permission settings.

The design takes inspiration from [Intel LLMart](https://github.com/IntelLabs/LLMart):
separate the dataset, target adapter, adversarial transformations, and objective.
Here the attacks are structured input and event perturbations, rather than
gradient optimization against a model. The result measures the declared Cruise
interface invariants, not underlying model reasoning or universal robustness.

## Historical inputs and invariants

The corpus is derived from the named November 13–14 failure records and their
subsequent reproductions. It contains sanitized synthetic inputs, not private
conversation transcripts or research documents. Local run evidence records the
source-artifact hashes and provenance without publishing those documents.

| Family | Historical failure or challenge | Required outcome |
| --- | --- | --- |
| Owner decisions | EOF became a refusal; structured choices rendered incorrectly | Distinguish unavailable input, preserve explicit decisions and original payloads, render readable choices |
| Failure attribution | Routing, credential, DNS, billing and connection errors were conflated | Preserve the observed error; a contained failure is not recovered authentication |
| Startup lifecycle | Early rejection crashed after a caller caught it; retry could duplicate effects | Observe failures, stop clients, bound retries and preserve performed effects |
| Goal execution intent | Idle Goal never started; read-only bootstrap or historical wording ended execution early | Preserve Plan/Default intent and current owner restrictions |
| Goal authority | Routine auto-selection bypassed risk/scope text in another field | Material choices reach native/user handling rather than automatic selection |
| Transport events | Silent startup, closed streams and reordered events | Bounded truthful failure and cleanup; no fabricated completion |
| Content freshness | Non-Git snapshots unavailable; same-size edits and path races | Detect changed source, preserve exclusions, reject unreliable capture |
| Completion evidence | Exit zero or stale gates treated as completion | Require the applicable evidence; independently challenge evaluator acceptance |
| Context boundaries | Older/peer reads, invalid latest state, FIFO hangs | Latest assigned identity only; fail without fallback or hanging |
| Package boundary | Installation copied private working folders | Export runtime assets without private histories, contexts or archives |
| Host permission inheritance | Cruise replaced native policy, sandbox and runtime roots | Omit those overrides; preserve native approval handling and native denial |

Removed managed-worker, authentication-manager, quota and compaction-controller
features are not restored to test their historical behavior. Their failures
remain provenance and architectural constraints.

## Reproduction and sensitivity controls

The standalone command also accepts a different source tree and a revision label:

```sh
node tests/robustness/run.mjs --seed 1729 --output /tmp/cruise-eval \
  --target /path/to/source --declared-revision REVISION
node tests/robustness/run.mjs --replay /path/to/failures/CASE.json
```

`results.json` and `results.tsv` retain per-case outcomes, source and harness
fingerprints, seed, family and split. Failure files preserve replayable synthetic
inputs. Missing APIs and broken fixtures are harness errors, not evidence of a
production defect. Any invariant breach or harness error makes the run fail.

Discovery and held-out **values** use distinct deterministic seeds over the same
declared scenario families. They are not blind attacks or evidence of
generalization to unseen failures. The historical target and repaired tree must
receive the same inputs and frozen harness. A vulnerable historical target must
fail the relevant cases; a green current run alone cannot establish sensitivity.

Report base scenarios, generated cases, families, critical failures, harness
errors and contained native/host failures separately. Containment means an
expected error propagated safely; it does not mean the task or recovery finished.
The evaluator's artifact-acceptance oracle is tested separately from production
Flight assurance and must not be represented as production task verification.

## Native authority and limits

Cruise inherits Codex/Claude permissions. It does not select an approval policy,
reviewer, execution sandbox or runtime roots for ordinary startup. Plan/Default
are native workflow modes, not Cruise permission profiles. Native approvals,
denials, repository instructions and paid-service authorizations remain binding.

A parent approval rejection before process creation is outside Cruise. A
synthetic test cannot demonstrate that rejected launch succeeded. Owner-authorized
cross-conversation updates must be reconciled through the native mechanism;
ordinary peer suggestions are not owner overrides, and completed effects must
not be replayed.

Real credential expiry/sign-in/MFA, whole-OS isolation and resolver behavior,
native owner-relay reconciliation, concurrent real sessions, notice receipt,
automatic compaction and original full research tasks remain separately assessed
or not evaluated. A green deterministic run does not close those coverage gaps.
