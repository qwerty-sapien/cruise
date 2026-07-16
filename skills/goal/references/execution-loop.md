# Cruise Execution Loop

Execute each approved DAG node through a small, evidence-producing plan → execute → test loop while minimizing user interruption.

## Table of contents

- [1. Entry conditions](#1-entry-conditions)
- [2. Node state machine](#2-node-state-machine)
- [3. Orient and micro-plan](#3-orient-and-micro-plan)
- [4. Permission and ownership preflight](#4-permission-and-ownership-preflight)
- [5. Execute](#5-execute)
- [6. Focused test](#6-focused-test)
- [7. Bounded remediation](#7-bounded-remediation)
- [8. Record and advance](#8-record-and-advance)
- [9. Parallel nodes and subagents](#9-parallel-nodes-and-subagents)
- [10. Drift and interruption](#10-drift-and-interruption)
- [11. Progress communication](#11-progress-communication)
- [12. Final integration](#12-final-integration)

## 1. Entry conditions

Do not enter execution until:

- the suite passed all pre-Start checks, the user chose Start, and its exact bytes are now `Approved (inactive)`;
- Start is bound to exact repository and artifact identities;
- the immediate time-of-use identity recheck passes;
- the permission envelope names allowed and prohibited effects;
- shared non-destructive foreign-diff monitoring is active automatically, with no speculative
  start question or restoration authority;
- `ORIGIN.yaml`, `ALIGNMENT.md`, `PLAN.md`, and `GOAL.md` resolve to the exact approved identities, and the raw prompt hash validates;
- exactly one execution branch applies: callable native Goal confirmed active, or the separately selected, digest-bound **Execute in Current Thread** fallback with a `D-XX` loss-of-durability decision and no native handoff;
- `CLOSEOUT.md` is created with activation/fallback provenance.

For a user-invoked native handoff, remain `Approved (inactive)`, output the handoff, and stop without CLOSEOUT or implementation until active state is confirmed. If any prerequisite fails, remain inactive and reconcile. Never use implementation progress to retroactively justify a missing Start.

## 2. Node state machine

Use:

```text
Not started → Ready → In progress → Complete
                         ↘ Blocked
Complete → Stale → Ready
```

A node is Ready only when all dependencies are Complete with current identities, every input exists, its owner has exclusive scope, and required permissions are available.

Do not mark Complete merely because edits exist. Require its focused evidence and output identities.

## 3. Orient and micro-plan

Before editing a Ready node, reread:

- immutable `ORIGIN.yaml`, current `ALIGNMENT.md`, `GOAL.md`, and the canonical PLAN task;
- ancestor outputs and exact identities;
- protected `R-XX`, `AC-XX`, and `D-XX`;
- write scope and shared resources;
- focused checks, rollback, attempt limit, and interruption conditions;
- current unrelated worktree changes.

Write a short micro-plan in the progress update or CLOSEOUT attempt record:

```markdown
- Node: T-XX
- Intended outcome: [...]
- Inputs: [...]
- Owned writes/resources: [...]
- Smallest implementation: [...]
- Focused check and expected result: [...]
- Permission/effect preflight: covered by D-XX / none required
- Rollback or stop: [...]
```

Do not redesign the whole Goal at node start. If the smallest safe implementation contradicts the approved plan, stop for contract reconciliation.

## 4. Permission and ownership preflight

Before every command or write:

1. confirm the action belongs to the node;
2. confirm the target is within exclusive ownership;
3. classify filesystem, process, network, install, browser, computer-use, git, cloud, and external effects;
4. link any non-routine effect to the locked permission entry;
5. obtain the runtime/tool approval still required by the environment;
6. confirm cleanup and evidence capture.
7. recheck the shared foreign-diff inventory and stop on any foreign or ambiguous change.

If a command can write caches, generated outputs, snapshots, a lockfile, or an external system, include those outputs in ownership. A permission entry does not defeat sandbox, managed policy, or tool approval.

## 5. Execute

Make the smallest coherent in-scope change. Follow repository instructions and preserve unrelated work.

During implementation:

- use existing project patterns and dependencies unless the contract says otherwise;
- inspect before overwriting;
- avoid opportunistic cleanup, broad formatting, or future-slice work;
- keep shared manifests and generated outputs with the integration owner;
- make reversible local decisions without asking when they do not change protected behavior, permissions, evidence, or public contracts;
- record any consequential but in-scope implementation choice in CLOSEOUT.

If evidence disproves a premise, stop the affected node. Do not force the implementation to match a stale contract.

## 6. Focused test

Run the node's focused deterministic check immediately after its material change.

For each check record:

- exact command or manual procedure;
- inputs, fixture/build/environment identity;
- expected exit status and observable result;
- actual exit status and result;
- evidence path or returned tool artifact;
- warnings, skipped tests, and side effects;
- cleanup state.

Inspect whether the check protects the mapped criterion. A zero exit code with skipped, irrelevant, weakened, stale, or incomplete tests is not sufficient.

For UI evidence, follow the permissions/UI reference. Tie screenshots and traces to the build, route, viewport, scenario, and expected observation.

## 7. Bounded remediation

Define an attempt limit or resource boundary in PLAN. The limit bounds retries; it does not authorize weaker criteria.

On failure:

1. preserve the attempt and evidence;
2. classify the failure as implementation defect, environment issue, stale premise, permission gap, flaky check, or contract conflict;
3. remediate only implementation defects that remain within scope, ownership, permissions, and protected decisions;
4. rerun the focused check;
5. update output identities.

Stop rather than remediate when:

- the fix widens the slice or changes product intent;
- a locked decision must change;
- a new external effect or permission is required;
- mandatory evidence is unavailable and no equivalent approved check exists;
- rollback is unsafe or unknowable;
- the approved attempt/resource boundary is exhausted.

Do not weaken fixtures, expected output, thresholds, or gates merely to pass.

## 8. Record and advance

The node owner returns an immutable report to the Cruise coordinator or integration owner. That sole CLOSEOUT writer appends one node row and attempt history:

| Node | Attempt | Input identity | Change/output identity | Focused evidence | State | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| T-02 | 01 | [identity] | [identity] | [command/result] | Complete | [decision/risk] |

Also record:

- actual owned paths/resources changed;
- external or local-process effects and cleanup;
- deviations, even when non-blocking;
- newly discovered risk;
- dependencies made Ready.

Advance without user input when the node is Complete and the next action stays within the contract. Do not pause for routine confirmation.

## 9. Parallel nodes and subagents

Run independent Ready nodes concurrently only after the PLAN's parallel claim is revalidated against current state.

Give each write-capable subagent:

- one node and outcome;
- exact baseline and artifact paths to read;
- exclusive write paths/resources;
- prohibited paths and effects;
- focused checks and expected evidence;
- requirement to return an immutable attempt report and never edit `.cruise/goal/CLOSEOUT.md`;
- instruction to report accidental out-of-scope mutation without cleaning it.

The coordinator remains the sole CLOSEOUT writer and is responsible for reviewing diffs, validating identities, recording reports, and integrating results. Treat changes outside assigned ownership, and overlaps that cannot be attributed exactly, as foreign-diff incidents; stop and preserve them through the shared protocol rather than rejecting, quarantining, or cleaning them.

If nodes touch a shared manifest, generated client, migration chain, fixture, DB, process, or deployment target, serialize through the integration owner.

## 10. Drift and interruption

The immutable start inventory, including pre-existing dirty state, is accepted as-is. Expected
drift thereafter consists only of current node outputs, authorized integration outputs, and
recorded evidence that can be attributed exactly to the declared action. Detect foreign or
ambiguous drift with the shared checkpoint protocol.

On detection, atomically record the incident, stop every worker and write, and ask whether the
listed exact changes were intentional. An intentional answer preserves the bytes and adopts the
current inventory without claiming Cruise authorship, followed by scope/ownership/approval/evidence
revalidation. A stop answer leaves the repository unchanged. An unintended answer does not itself
authorize restoration. Leave the changes untouched and remain paused until the user resolves them
outside Cruise or stops the run. Never use reset, checkout, clean, stash,
quarantine, move-aside, generic overwrite, or another blanket cleanup mechanism.

Interrupt the user only for:

- material behavior, scope, safety, or evidence decisions;
- new or expanded permission;
- unexpected baseline or artifact changes;
- unavailable mandatory evidence;
- exhausted remediation;
- unsafe rollback;
- missing authority for an external effect;
- native Goal/fallback state that no longer supports safe continuation.

When interrupted, provide:

1. current node and last valid identity;
2. observed evidence;
3. affected `R/AC/D/G/N/VG` IDs;
4. why the existing contract cannot decide safely;
5. 2–3 options and an evidence-backed recommendation;
6. exact work preserved and what remains inactive.

## 11. Progress communication

Keep updates concise and useful:

- current and newly completed node IDs;
- focused evidence result;
- next Ready nodes and whether they can run in parallel;
- active permission use or cleanup;
- any non-blocking deviation or risk.

During ongoing tool work, update often enough that the user is not left without visibility. Do not send a ceremonial update for every trivial command.

## 12. Final integration

Before `T-01` verification:

1. complete all implementation nodes required by the current slice;
2. serialize shared manifests, generated outputs, migrations, and fixtures;
3. run integration-owner checks;
4. confirm clean process/port/browser cleanup except deliberately retained approved services;
5. record final source/build/environment identities;
6. mark stale evidence accurately;
7. hand current immutable evidence to `T-01`.

`T-01` evaluates but never fixes. Follow the verification reference for blocks, ownership handoff, replay, and closeout.
