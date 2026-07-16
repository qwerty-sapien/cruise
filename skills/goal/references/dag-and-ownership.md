# DAG Planning and Ownership

Build one executable, acyclic, ownership-safe PLAN for the current Cruise slice.

## Table of contents

- [1. Roles and review depth](#1-roles-and-review-depth)
- [2. Work backward from evidence](#2-work-backward-from-evidence)
- [3. Node schema](#3-node-schema)
- [4. Dependency and input rules](#4-dependency-and-input-rules)
- [5. Write ownership](#5-write-ownership)
- [6. Shared and external resources](#6-shared-and-external-resources)
- [7. Parallel execution](#7-parallel-execution)
- [8. Mechanical validation](#8-mechanical-validation)
- [9. Coverage validation](#9-coverage-validation)
- [10. Verification and replay](#10-verification-and-replay)

## 1. Roles and review depth

Use:

- **implementation planner** — proposes executable nodes, inputs, outputs, order, ownership, and focused checks;
- **architecture/risk planner** — independently protects boundaries, invariants, rollback, and failure modes;
- **critic/reconciler** — compares both proposals with repository evidence and reports conflicts;
- **Cruise coordinator** — sole writer of planning artifacts;
- **integration owner** — serialized owner of overlap and remediation;
- **T-01** — read-only verification coordinator.

For high-risk, migration-heavy, security-sensitive, or broadly cross-cutting work, require fresh independent planners and a critic when available. For smaller qualifying work, use one planning pass plus an explicit adversarial self-review. Never label a same-context pass independent.

Freeze the repository and planning baseline while independent proposals are running. Invalidate reports produced against different bytes.

## 2. Work backward from evidence

Begin PLAN with:

| AC | Final check | Expected result | Evidence identity/location | Producing nodes | Gate |
| --- | --- | --- | --- | --- | --- |
| AC-01 | [command/procedure] | [decidable result] | [record] | T-XX | E-XX |

For every mandatory result:

1. identify the final observation;
2. identify outputs that make it possible;
3. identify producers of those outputs;
4. identify their inputs and owners;
5. add only necessary nodes and dependencies.

Do not start with a generic phase list. A node should produce an inspectable result, not merely “work on backend.”

For the blocked-preparation fast path, do not fabricate a full implementation DAG. Represent the unavailable mandatory prerequisite, any explicitly requested safe preparation output, and `T-01`'s blocking `E-XX` `NOT_RUN` judgment. Activation remains ineligible.

## 3. Node schema

Use monotonically assigned `T-XX` IDs and this complete record. Preserve legacy `N-XX` records in already-approved suites without renumbering them:

```markdown
### T-02 — [Outcome]

- **State:** Not started | Ready | In progress | Complete | Blocked | Stale
- **Owner:** [one role or agent]
- **Depends on:** [T-XX or None]
- **Inputs:** [I-XX baseline inputs and/or ancestor outputs]
- **Outputs:** [named artifacts, behavior, resources, or decisions]
- **Satisfies:** [R-XX, AC-XX]
- **Preserves:** [G-XX, R-XX]
- **Verification:** [E-XX]
- **Decisions and permissions:** [D-XX]
- **Write ownership:** [exact paths/globs/resources, or None]
- **Shared-resource interaction:** [manifest, migration, fixture, DB, cloud, process, or None]
- **Micro-plan constraint:** [bounded implementation approach]
- **Focused evidence:** [command/procedure, expected result, record]
- **Attempt/resource limit:** [maximum attempts, time/cost ceiling, or explicit stop]
- **Evidence return:** [immutable report to coordinator; node owner never edits CLOSEOUT]
- **Failure and rollback:** [safe remediation or stop]
- **Parallel-safe with:** [T-XX or None, with reason]
```

Define baseline inputs separately:

| Input | Identity | Source | Consumers |
| --- | --- | --- | --- |
| I-01 | [digest/version] | [repo path or approved artifact] | T-02 |

## 4. Dependency and input rules

Every dependency must express a real ordering or input relationship. For every node input, find:

- a frozen baseline `I-XX`; or
- an ancestor that produces the exact output.

Reject:

- undeclared shared state;
- inputs produced only by siblings or descendants;
- “run after everything” edges without evidence need;
- child nodes that silently modify parent outputs;
- verification that reads artifacts no node owns.

Produce a topological order containing each node exactly once. Keep the `T-01` verifier after every producer required by its gates.

## 5. Write ownership

Treat ownership as exclusive write authority, not primary responsibility. Expand intersections conservatively across:

- exact files and directory globs;
- lockfiles and manifests;
- generated source, schemas, API clients, and snapshots;
- migrations and migration ledgers;
- shared fixtures, golden files, and test databases;
- build outputs and caches when retained;
- cloud systems, queues, feature flags, secrets, and production data;
- local processes, ports, and browser profiles;
- cleanup and rollback paths.

Two nodes may not simultaneously own intersecting mutable scope. Do not rely on optimistic mergeability.

Use one integration owner for necessary overlap. At the recorded handoff, prior writers become read-only for transferred scope.

## 6. Shared and external resources

Record each resource:

| Resource | Mutable? | Owner | Ordering/lock | Permission D-ID | Rollback/cleanup |
| --- | --- | --- | --- | --- | --- |
| package lockfile | Yes | Integration owner | After feature nodes | D-XX | Restore only owned changes |
| localhost port | Yes | UI owner | One process at a time | D-XX | Stop tracked PID |

Treat a command named `test` as potentially mutating until inspected. `T-01` never performs an external effect; the authorized integration owner runs it and returns evidence.

Assign `.cruise/goal/CLOSEOUT.md` exclusively to the Cruise coordinator or serialized integration owner. Node owners and subagents return immutable attempt reports; they never append to the shared closeout concurrently.

## 7. Parallel execution

Nodes are parallel-safe only when:

- no dependency path exists between them;
- direct and indirect write scopes are disjoint;
- they do not mutate the same manifest, generated output, migration chain, DB, service, port, fixture, or external account;
- their tests do not race on shared state;
- each can produce complete focused evidence independently.

If any condition is uncertain, serialize. Parallelism is an optimization, not a requirement.

Write-capable subagents receive exact ownership, allowed commands/effects, required output, focused evidence, and a prohibition on cleanup outside their scope. The coordinator checks their diffs and evidence before integration.

## 8. Mechanical validation

Validate in order:

1. each `T-XX` is unique and `T-01` appears exactly once as the read-only verifier;
2. every dependency endpoint exists;
3. the graph is acyclic and has a full topological order;
4. every input is baseline-provided or ancestor-produced;
5. every mutable output has one authority;
6. file/glob/resource ownership does not overlap;
7. every parallel claim has no path or mutable intersection;
8. every external effect links to a suitable locked permission;
9. every mandatory final check reads reachable current outputs;
10. every node has an attempt/resource limit and explicit stop;
11. CLOSEOUT and any shared evidence ledger have one writer;
12. every rollback and cleanup action has an owner;
13. every task has non-empty `satisfies`, `preserves`, and `verification` mappings whose IDs exist.

Any failure keeps PLAN Draft.

## 9. Coverage validation

Build:

| ID | Implement/protect node | Evidence | Gate | Notes |
| --- | --- | --- | --- | --- |
| R-01 | T-02 | AC-01 check | E-01 | — |
| D-01 | T-02 constraint | AC-01 inspection | E-01 | locked |

Require:

- every accepted `R-XX` has a node and mandatory evidence unless purely contextual;
- every mandatory `AC-XX` appears in final evidence, a producer, and a gate or justified no-gate entry;
- every locked `D-XX` affects constraints, nodes, ownership, evidence, or gates;
- every deferred decision has a validation node or stop;
- no future `G-XX` work appears in current nodes;
- numeric metrics do not replace deterministic protected-behavior checks.

## 10. Verification and replay

`T-01` is a read-only node depending on all outputs required by selected `E-XX` gates. It returns an immutable attempt report to the integration owner.

When remediation changes an output:

1. preserve the failed attempt;
2. transfer every affected write scope exclusively to the integration owner;
3. mark the changed node, all transitively dependent descendants, and consuming gate attempts stale;
4. replay the affected DAG suffix in topological order;
5. regenerate shared/integration outputs and record new identities;
6. rerun every affected gate.

Represent retries as temporal attempt history, never cyclic edges:

```text
Attempt 01 → E-02 BLOCK → ownership handoff → remediate T-03
→ replay T-03, T-05 → Attempt 02 → E-02 PASS
```

Unchanged siblings retain evidence only when exact input and environment identities prove they consume no changed state.
