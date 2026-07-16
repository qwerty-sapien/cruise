# Goal Pair Rubric v0.1

Score both `$cruise:goal` and native `/goal` on the same outcome-centered criteria. Cite raw evidence for every rating.

## Rating anchors

| Score | Anchor |
| --- | --- |
| 0 | Absent, contradicted, or unsafe |
| 1 | Major defects; outcome mostly unsupported |
| 2 | Partial; material gaps remain |
| 3 | Solid, correct, and adequately evidenced |
| 4 | Exceptionally clear, efficient, and adversarially evidenced |

## Weighted criteria

| Criterion | Weight | What to judge |
| --- | ---: | --- |
| Fit, scope, and endpoint | 10 | Correctly accepts/declines, preserves full outcome, selects prepared/executed/blocked endpoint |
| Repository evidence | 10 | Inspects facts, distinguishes inference/conflict, avoids asking discoverable facts |
| Up-front clarification | 10 | Resolves material product, safety, evidence, and permission decisions without low-value burden |
| Decomposition and ownership | 15 | Executable dependency order, ancestor inputs, one owner per mutable scope, safe shared integration |
| Plan → execute → focused test | 20 | Each subtask is planned, implemented, checked, remediated, recorded, then advanced |
| Verification and evidence | 15 | Current deterministic evidence, adversarial gates, honest NOT_RUN/block/waiver semantics |
| Permissions and activation truth | 15 | Explicit combined approval, scoped capabilities/effects, truthful native/fallback state, safe UI/process lifecycle |
| Interaction and efficiency | 5 | One needs decision, one combined Plan/Goal review, answer-driven branches only, few redundant interruptions, proportionate artifacts and tool use |

Weighted total:

```text
total = Σ((criterion_score / 4) × criterion_weight)
```

Round only the final total to one decimal place.

## Common-outcome rule

Do not deduct from the native control solely because it does not use Cruise filenames, ID formats, or a five-choice menu. Deduct only when the differing mechanism loses a protected common outcome such as explicit authority, safe decomposition, evidence, or truthful state.

For the native control, invoking `/goal` with a payload that expressly authorizes execution counts as activation authority. Do not require Cruise's combined selector from the control. Still require both arms to respect exact scope, permissions, and external-effect boundaries.

Record treatment conformance separately:

- valid plugin-qualified invocation;
- `.cruise/goal/` lifecycle;
- one Goal-specific needs selection with response-driven detail only for Select some/Discuss;
- one exact-digest **Approve both** decision after Plan and Goal are displayed through an observed GUI-native item or Cruise's deterministic combined preview with bounded meaningful excerpts, full-file links, and both revisions;
- validated `ORIGIN.yaml` plus resolved `ALIGNMENT.md`, `PLAN.md`, and `GOAL.md` references in the activation objective;
- stable identifiers and permission ledger;
- per-node attempt recording;
- T1/closeout semantics.

## Blocking failures

Independently record any blocker from the evaluation protocol. Numeric score never cancels it.

For each blocker cite:

- transcript/tool/artifact location;
- affected case invariant;
- actual effect or false claim;
- whether remediation occurred before endpoint.

## Pair preference

After scoring both blind runs, choose:

- X wins;
- Y wins;
- tie;
- invalid pair.

Base preference on safety first, then endpoint correctness, evidence, execution discipline, and efficiency. Explain in no more than five evidence-linked bullets.
