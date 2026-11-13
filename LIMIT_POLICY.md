# Cruise limit policy

Cruise uses limits only for bounded parsing, resource containment, host
integration, and liveness. It does not impose a universal workload, repair, or
attempt budget. Repository evidence, the declared scope, host permissions, and
the requested outcome determine whether legitimate work continues.

## Goal liveness

`.cruise/FLIGHT.md` exposes two positive, user-editable thresholds:

| Field | Default | Trigger evidence |
| --- | ---: | --- |
| `stall.quiet_turns` | `3` | Consecutive unchanged product/evidence-progress fingerprints or oscillation to an earlier fingerprint. |
| `stall.same_failure` | `3` | Consecutive repetitions of the same normalized failure signature. |

Reaching either threshold starts one ladder: realign, one final experiment,
then stall. A new product fingerprint resets quiet and failure counts and the
active-work ladder. Flight prose, status churn, and evidence wording alone do
not. Completion correction has an additional absolute cap, so editing gate
contracts cannot extend it indefinitely. In signature-only supervision,
changed or cleared failure evidence also resets the active-work ladder.

Codex evaluates the ladder between native Goal continuation turns. On stall it
attempts to pause the Goal, emits the observations and interventions, and exits
`3`. There is no independent wall-clock or total-turn ceiling in this loop.

Claude evaluates the ladder on `Stop` events scoped to the active Goal skill
session. Scratch is stored in the exact private runtime directory registered
for that session ID, so another Claude or Codex session in the same worktree
cannot reset its cycle. It blocks ordinary stops with
continuation guidance, then realignment and final-experiment guidance. The
following stop is allowed with a report. A hard backstop at `quiet_turns + 2`
blocked stops also allows the stop if the normal ladder has not finished.

Missing or malformed Flight receives bounded correction. Damaged scratch or a
hook exception fails open, and every correction path has a hard cap, so the
hook cannot trap the session. Fail-open does not become false success: the
Claude launcher independently returns stalled or unassured unless the shared
attestor accepts the terminal Flight. The hook command itself has a 30-second
host timeout.

## Advisory input and scratch bounds

| Input or state | Bound | Overflow behavior |
| --- | ---: | --- |
| `.cruise/FLIGHT.md` | 1 MB, 1,000 frontmatter tokens, nesting depth 10 | Parser reports invalid input; supervised Goal receives bounded correction and cannot claim assured completion. |
| `.cruise/QUEUE.md` | 1 MB, 5,000 frontmatter tokens, nesting depth 12 | Parser returns no queue; queue commands stop with an invalid/missing-queue error. |
| Claude Stop-hook JSON input | 1 MB | Hook catches the error, allows the stop, and emits a fail-open system message. |
| Codex captured agent text per turn | 64 KiB | Additional text is not used for failure-signature supervision. |
| Supervisor scratch histories | Last 32 fingerprints, observations (including failure signatures), interventions, and invalid-flight hashes | Older derived evidence is dropped; invalid-flight correction still reaches the normal Codex ladder or Claude's five-block fallback, and authority and repository state are unaffected. |

Flight and queue writers reject symlink targets and require `.cruise` to be a
real directory. Runtime scratch uses owned real directories with mode `0700`,
regular no-follow manifests, exact workspace/session binding, and a 72-hour
crash-recovery TTL. Startup cleanup removes only expired valid sessions and
skips unsafe or unknown entries. These are path-safety boundaries, not
workload budgets.

## Host and command bounds

| Operation | Implemented bound or behavior |
| --- | --- |
| `cruise doctor` subprocess checks | 10-second timeout per local CLI check. |
| Codex app-server shutdown | Bounded graceful/terminate/kill cleanup stages; cancellation remains available. |
| Worker level | Integer 1–7, mapped request-locally to a provider model/effort pair. |
| Parallel changelog inference | 120-second worker timeout, 96 kB total diff-evidence input with 8 kB per-file excerpts, 1 MB output bound, and at most 100 commits expanded from one observed HEAD transition. Invalid or unavailable inference falls back deterministically and never fails the main run. |
| Generated changelog | 16 MiB existing-file bound before a targeted marker patch; larger, unsafe, or concurrently changed files are left untouched with a warning. |
| Queue execution | Sequential; stops at active, blocked, stalled, failed, or dependency-deadlocked work. No milestone-attempt budget is stored. |
| Codex native Goal bootstrap | 120-second first-turn deadline, starting after Goal activation. On expiry Cruise uses a fixed 2-second budget to read the current Goal and attempt to pause it, then reports thread/model/status/elapsed diagnostics and exits `4`; timers are cancelled on turn start, interruption, error, and app-server exit. |
| Codex app-server transport inactivity | Liveness-and-recovery bound sourced from observed inbound JSONL frames, not a workload budget. The request-scoped default is 300 seconds, tunable with `CRUISE_INACTIVITY_TIMEOUT_MS`; human-input waits suspend it. Expiry terminates the session with thread/turn/Goal/stderr-tail evidence and exits `5`. |
| Product fingerprint | 64 MiB cumulative untracked-file content | Freshness becomes unavailable; v2 completion remains unassured rather than hashing unbounded input. |
| Workspace ownership lease | 24 hours, refreshed whenever the same session activates | A different session is rejected during the lease. After a crashed or abandoned host leaves no cleanup path, a new activation may recover the workspace once the lease expires. |
| Runtime scratch recovery | Normal exit and SIGINT/SIGTERM cleanup; 72-hour fallback TTL for unclean crashes | A startup janitor removes only manifest-valid, owned, non-symlink session directories after expiry. |
| Launcher exits | `0` v2 contract ready or assured/qualified completion, `2` blocked/failed/unassured (including legacy v1), `3` stalled, `4` Goal bootstrap timeout, `5` transport inactivity, `6` resumable budget pause, `130` interrupted. |

Service quotas, model context windows, Claude hook timeouts, Codex host limits,
OS limits, and external API policies remain host or protocol constraints.
Cruise reports them as such and cannot weaken or extend them.

## Account quota containment

When the user requests account-resource containment, Cruise may reserve a
bounded share of the authoritative weekly `account/rateLimits/read` window.
The campaign baseline, observed `usedPercent` delta, and concurrent active
reservations form a quota budget. This is distinct from an evidence budget:
evidence thresholds decide when work needs a new observation or assurance,
while the quota budget decides only whether account-funded work may start or
continue. It never creates a generic attempt cap.

Crossing the configured quota boundary pauses before the next Goal or worker
effect, writes a resumable report, and exits `6`. Productive authorized work
still has no arbitrary wall-clock kill. A later reset or explicit user budget
change may resume the work; Cruise never consumes earned rate-limit reset
credits automatically.

## Allowed limit classes

Every new executable limit must fit one of these classes:

| Class | Required behavior |
| --- | --- |
| Host or protocol | Name the external source and do not present it as Cruise authority. |
| Safety or authority | Protect paths, secrets, permissions, or external effects and remain fail-closed where the host requires it. |
| Resource containment | Bound untrusted bytes, structure, processes, or retained logs and define overflow behavior. |
| Liveness and recovery | Keep cancellation available and end in pause-with-report or allow-with-report. |
| Semantic consistency | Protect an artifact invariant such as a positive threshold, unique milestone ID, or one active sequential queue item. |

## Prohibited ceilings and state

Cruise does not define a universal maximum for model escalation, in-scope
repair, focused verification, or legitimate queue length. It also does not use
an append-only retry ledger, approval digest, controller phase, or resettable
budget. If progress exists and the host still authorizes the work, the
supervisor resets rather than consuming a hidden allowance.

## Adding a limit

A new hard limit needs nearby documentation and a proving test that name:

1. its allowed class;
2. the protected resource or invariant;
3. overflow, timeout, or cancellation behavior; and
4. why the behavior fails safe for host authority.
