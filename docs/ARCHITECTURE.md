# Architecture and safety

This page explains Cruise’s shared runtime: what becomes authoritative, where state lives, and which conditions stop a run.

## At a glance

| Layer | Owns | Never substitutes for |
| --- | --- | --- |
| Origin | Exact request bytes, repository identity, initial baseline | A later paraphrase or generated specification |
| Probe and route | Bounded repository facts, Quick gates, selected skill, worker recommendation | User approval or permission |
| Root coordinator | Questions, approvals, permissions, worker launch, integration, final synthesis | Substantive worker execution |
| Workers | Bounded mapping, planning, implementation, diagnosis, research, and verification | Routing, approval, Goal activation, or final response |
| Evidence | Performed checks, outputs, diffs, effects, and requirement links | A model assertion, waiver, or unchecked task box |

## Run lifecycle

```text
Doctor readiness
  → immutable Origin
  → foreign-diff baseline
  → bounded semantic mapping
  → deterministic route
  → approvals / permissions / capability checks
  → bounded worker attempts
  → integration
  → evidence audit
  → terminal closeout
```

Before any public skill creates run state, `cruise doctor --json` must verify:

- source runtime and installed plugin cache digests;
- the live model catalog;
- the running `cruise` entrypoint; and
- the exact host rule for that absolute entrypoint followed by `worker`.

Origin and state are then created in the same run directory. The semantic-mapping packet is bound to immutable Origin identities and a level-2 worker.

## Origin and machine state

Cruise captures the full triggering message before it paraphrases or asks a question. It stores the exact UTF-8 bytes and SHA-256 hash; clarification may update normalized intent only through an append-only change ledger.

### Ordinary run files

```text
.cruise/runs/<run-id>/
├── origin.yaml
├── foreign-diff-guard.yaml
├── probe.yaml
├── route.yaml
├── state.yaml
└── evidence.yaml
```

| Format | Use |
| --- | --- |
| YAML | Cruise machine state |
| Markdown | Human-reviewed contracts and reports |
| JSON | External host, API, or evaluation-harness boundaries only |

Build also has project and milestone Origins; Goal has `.cruise/goal/ORIGIN.yaml`.

Stable identifiers—such as `G-XX`, `R-XX`, `AC-XX`, `P-XX`, `T-XX`, `E-XX`, `F-XX`, `H-XX`, and `RSK-XX`—are monotonic. Cruise does not silently reuse or renumber them.

## Repository drift protection

Cruise treats existing user work as part of the baseline, not as debris to clean up.

| Situation | Behavior |
| --- | --- |
| Dirty or untracked files already exist | Record them in the baseline and continue |
| A later change has an exact current-run action receipt | Attribute it to the run |
| A later change has no valid receipt | Persist an incident, pause workers and writes, then ask about that concrete change |
| Drift happened before routing | Preserve the stale run as evidence and start only from a fresh Origin |
| Drift is unintended, stale, indexed, branch-changing, path-unsafe, or ambiguous | Leave all bytes untouched and pause |

Before a product write, the runtime read-only-projects the intended action from run-directory intent and content files. It binds the future operation, content, size, mode, current dirty state, Git index, and tracked-file metadata. It never tests a speculative edit in the product tree.

Cruise does not clean, restore, or claim authorship for adopted user changes.

## Routing

Routing uses a bounded repository probe and a YAML-only semantic assessment tied to the exact prompt hash and repository baseline.

### Decision rules

- Each fact cites a verified prompt span, file digest, or baseline digest.
- Missing, partial, stale, or over-budget assessment fails closed.
- The root records one selected route and one `recommended_level`.
- Residual uncertainty preserves the user-selected skill.
- A deterministic semantic conflict produces one explicit handoff—never silent rerouting or a recursive loop.

### Quick promotion signals

Quick must hand off before editing when the change involves any material uncertainty around:

| Area | Examples |
| --- | --- |
| Public surface | API, ABI, exported behavior, dynamic callers |
| Sensitive behavior | Security, privacy, authentication, authorization |
| Durable data | Schema, migration, serialized formats |
| System behavior | Dependencies, concurrency, lifecycle, build, release |
| Effects | Network, deployment, purchase, destructive or authenticated actions |
| Knowledge | Missing research, insufficient testability, unknown cause |
| Design | Material choices, expanded scope, unclear repair evidence |

The semantic assessment contains 17 promotion gates plus repair-history telemetry. Conservative request patterns may still activate obvious authentication or public-API gates if a worker omits them.

## Root and workers

The root is always the coordinator. It owns:

- routing and handoffs;
- user questions;
- Plan, Build, and Start approvals;
- permission requests;
- native Goal activation;
- worker launch and integration;
- conflict resolution; and
- final synthesis.

Every substantive phase runs in a bounded worker task. `cruise worker` binds:

- the launcher packet path, bytes, and SHA-256;
- Origin and repository-baseline identities;
- stable task and evidence IDs;
- exact path ownership;
- allowed effects and permissions;
- dependencies, limits, and stop conditions.

Workers return immutable attempt reports in a launcher-owned envelope. They cannot ask the user, approve a plan, grant permission, reroute, activate a Goal, integrate siblings, or produce the final response.

Retryable app-server errors remain pending while Codex reports a retry. Terminal failures preserve the ordered retry and terminal notifications, available error identities and HTTP status, and a sanitized diagnostic history. Cruise reports network or transport failure honestly; it does not claim to eliminate those causes.

## Model policy

Cruise selects an exact worker level for each substantive phase. The configured class provides an ordinary default; task cost, consequence, and evidence may justify a different level.

- Level `1` is coordination-only.
- Worker pairs are checked against the live catalog.
- Provider fallback is disabled.
- The exact model and reasoning setting are supplied through typed app-server fields.
- A model-authored prompt cannot request or attest its own pair.
- Escalation creates a new worker attempt; it never mutates the root model.

There is no universal retry count. Reviewed stop conditions, current evidence, resource policy, and host capability determine whether another attempt is valid. See the [limit policy](../LIMIT_POLICY.md).

## Capability resolution

Cruise searches in this order:

1. Host-native tools
2. Installed plugins or skills
3. Local tools
4. Official plugins
5. Trusted catalogs
6. Pinned official upstreams
7. Built-in fallback

Automatic installation requires an inspectable, trusted, immutable version in local scope, satisfied permission and sandbox checks, no reusable secret, and a safe rollback story. Installer exit success is insufficient: a smoke check must verify identity, version, and usable scope.

```text
.cruise/internal/capabilities.yaml
.cruise/internal/provision-runs/<run-id>.yaml
```

If authentication is required, the affected node enters `waiting_auth`. Cruise gives one host-native action and never asks for a reusable secret in chat, arguments, or artifacts. Only descendants of that node wait; independent work may continue if the host actually schedules it. Resume revalidates identity and granted scope.

`source-only authorization` is descriptive shorthand, not a permission. It grants no network access, packet export, worker launch, repository write, Goal activation, or external effect.

## Write boundaries

| Workflow | Before its approval | After its approval |
| --- | --- | --- |
| Quick | No edit until all hard fit gates pass | Only the admitted small scope |
| Refine | Planning only | Approved finite plan in the current task |
| Debug | Diagnosis and experiments | Smallest causal repair |
| Research | Read-only | Remains read-only |
| Build | Project and milestone planning artifacts only | Only an exact permitted Markdown documentation path; no product implementation or Goal activation |
| Goal | `.cruise/goal/` candidate artifacts only | Implementation and approved effects only after native Goal activation is confirmed |

Tests, builds, browser actions, authenticated state, network access, purchases, deployments, destructive actions, and other effects remain subject to repository policy, sandboxing, runtime authority, and explicit user permission.

## Evidence and resumption

Resume revalidates:

- prompt hash and repository identity;
- baseline and current drift;
- current instructions and route;
- approval snapshots and permission envelope;
- capability identity and scope; and
- evidence freshness.

Completion requires current evidence against the immutable Origin, actual diff, relevant effects, and acceptance criteria. A passed command can be useful evidence, but a self-authored check or model claim is not independent verification. A waived mandatory check remains `NOT_RUN` with residual risk visible.

## Related reference

- [Build and Goal](BUILD-AND-GOAL.md)
- [Operations](OPERATIONS.md)
- [Limit policy](../LIMIT_POLICY.md)
- [Evaluation guide](../evals/README.md)
