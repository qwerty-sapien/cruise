# Cruise limit policy

Cruise does not use hidden numeric ceilings to decide whether legitimate work may continue.

A task continues or stops according to:

- its reviewed stop conditions;
- current evidence;
- permissions and ownership;
- resource policy; and
- actual host capability.

Retry and repair history is append-only. It cannot be erased to manufacture a fresh budget.

## Allowed limit classes

Every executable limit must belong to one of these classes.

| Class | Purpose | Required behavior |
| --- | --- | --- |
| Host or protocol | Respect a limit imposed by Codex, the OS, a file format, or an external API | Name the external source truthfully; do not present it as a Cruise preference |
| Safety or authority | Prevent scope escape, permission expansion, unsafe paths, secret persistence, untrusted installation, or unauthorized effects | Remain fail-closed |
| Resource containment | Bound untrusted bytes, nodes, depth, files, logs, or parser input | Record overflow/truncation evidence; configuration must not weaken the boundary |
| Liveness and recovery | Prevent a dead child, stuck registry, or continuously replaced lock from hanging the coordinator | Keep cancellation available; allow trusted deadline overrides only where supported |
| Semantic consistency | Encode protocol meaning such as one active phase or one exact approval | Explain the invariant rather than treating it as a workload budget |

Service quotas and Codex host-action limits are host/protocol constraints. This repository cannot change them.

## Current liveness rules

| Operation | Rule |
| --- | --- |
| Deep Doctor skill probe | Fixed `60000 ms` deadline; performance target below `15000 ms` |
| Troubleshoot workflow | No workflow deadline; cancellation and bounded process cleanup remain available |
| Automatic update hook | Waits for active Cruise processes without an attempt ceiling; concurrent hooks coalesce behind a stale-owner-aware lock |
| Plugin readiness | No poll-count ceiling; configurable wall-clock deadline prevents a completed Git operation from hanging forever |

## Current semantic cardinalities

- Goal has one exact combined Plan-and-Goal approval event after its needs/autonomy envelope is resolved.
- Build accepts either its exact digest-echoing structured selection or an immutable request-header `--auto-approve` directive bound to the later review digest.
- There is one integration owner and one active controller phase.
- Worker levels come from the host-advertised catalog.
- Routing may perform one optional Terra classification retry, then records uncertainty and preserves the user-selected skill.
- A missing Plan-only UI is not a workload limit and must not be promoted into a blocked native Goal.

## Prohibited arbitrary ceilings

The following histories have no universal Cruise-defined attempt maximum:

| Area | Governing rule |
| --- | --- |
| Model and worker escalation | Reviewed workflow stops, evidence, resource policy, and strongest advertised pair |
| Quick repair | Repair history is telemetry; evidence determines promotion, re-planning, or continuation |
| Disjoint read-only Research | Dependencies, ownership, and actual host scheduling |
| Capability provisioning | Optional explicit scheduler policy plus the persisted state-size boundary |
| Structured authentication | Any explicit positive timeout or explicit `null`; finite default and cancellation remain supported |

## Adding a limit

A new hard limit needs a nearby comment or shared document that names:

1. its allowed class;
2. the protected resource or invariant;
3. overflow or timeout behavior; and
4. the proving test.

Replace limits without that rationale with explicit per-task authority or remove them.
