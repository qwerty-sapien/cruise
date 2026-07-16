# Cruise limit policy

Cruise does not use hidden numeric ceilings to decide whether legitimate work may continue. A
task continues or stops according to its explicit reviewed stop conditions, current evidence,
permissions, ownership, resource policy, and host capability. Retry and repair history remains
append-only and may not be erased to manufacture a fresh budget.

Every executable limit belongs to one of these classes:

1. **Host or protocol constraint.** The limit is advertised or enforced by Codex, the operating
   system, a file format, or an external API. Cruise must report it truthfully and must not present
   it as a Cruise preference. Service account quotas and Codex host-action usage limits are in
   this class and cannot be changed by this repository.
2. **Safety or authority boundary.** The limit prevents scope escape, permission expansion,
   unsafe path traversal, secret persistence, untrusted installation, or unauthorized effects.
   These limits remain fail-closed.
3. **Resource containment.** Byte, node, depth, file-count, and diagnostic-retention limits bound
   untrusted or repository-controlled input before memory, disk, parser, or log use. They must be
   recorded with truncation/overflow evidence and may be configurable only without weakening the
   fail-closed boundary.
4. **Liveness and recovery.** Deadlines, cancellation, process termination, and bounded lock-race
   recovery prevent a dead child or continuously replaced lock from hanging the coordinator.
   Defaults may be overridden by explicit trusted authority where supported; cancellation remains
   available. Rapid Deep Doctor has one fixed 60000 ms liveness deadline per read-only skill probe
   and targets less than 15000 ms by reusing one warm conversation. Manual `--troubleshoot` has no
   workflow liveness deadline; cancellation and bounded process cleanup remain available. Automatic Git
   update hooks wait for active Cruise workers without an attempt ceiling and coalesce through one
   stale-owner-aware lock. Plugin-install readiness likewise has no poll-count ceiling; its
   configurable wall-clock liveness deadline prevents a completed Git operation from hanging
   forever when Codex registry state never converges.
5. **Semantic or consistency cardinality.** Exact Plan/Start approvals, one integration owner,
   one active controller phase, and host-advertised worker levels encode protocol meaning rather
   than workload budgets. Routing's one optional Terra classification retry also ends in an
   explicit uncertainty result that preserves the user's selected skill; it does not stop work.
   Build accepts either its exact digest-echoing structured selection or an explicit immutable
   request-header `--auto-approve` authority bound to the same later displayed review digest.
   Missing Plan-only UI is not a work limit and must not be promoted into a blocked native Goal.

A hard-coded count is prohibited when it merely limits useful behavior. In particular:

- model and worker escalation histories have no universal attempt maximum;
- Quick repair history is telemetry, not an automatic two-attempt cutoff;
- disjoint read-only Research concurrency has no Cruise-defined numeric ceiling;
- provision retries have no hidden default attempt count, and persisted attempt history is
  governed by optional explicit scheduler policy plus the existing state byte boundary rather
  than a redundant 64-entry ceiling; and
- structured authentication accepts any explicit positive timeout and also an explicit `null`
  timeout, while retaining a finite default and cancellation support.

New hard limits require a nearby comment or shared documentation naming their class, protected
resource or invariant, overflow behavior, and test. Limits without that rationale should be
replaced by explicit per-task authority or removed.
