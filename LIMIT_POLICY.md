# Cruise limit policy

Cruise uses limits only for bounded parsing, resource containment, host
integration, and liveness. It does not impose a universal workload, repair, or
attempt budget. Repository evidence, the declared scope, host permissions, and
the requested outcome determine whether legitimate work continues.

## Goal liveness

`.cruise/FLIGHT.md` exposes two positive, user-editable thresholds:

| Field | Default | Trigger evidence |
| --- | ---: | --- |
| `stall.quiet_turns` | `3` | Consecutive unchanged workspace fingerprints or oscillation to an earlier fingerprint. |
| `stall.same_failure` | `3` | Consecutive repetitions of the same normalized failure signature. |

Reaching either threshold starts one ladder: realign, one final experiment,
then stall. A new workspace fingerprint resets quiet and failure counts and the
ladder. In signature-only supervision, changed or cleared failure evidence also
resets it.

Codex evaluates the ladder between native Goal continuation turns. On stall it
attempts to pause the Goal, emits the observations and interventions, and exits
`3`. There is no independent wall-clock or total-turn ceiling in this loop.

Claude evaluates the ladder on `Stop` events only when
`CRUISE_CLAUDE_GOAL=1` and a valid `active` flight is newer than 48 hours. It
blocks ordinary stops with continuation guidance, then realignment and final
experiment guidance. The following stop is allowed with a report. A hard
backstop at `quiet_turns + 2` blocked stops also allows the stop if the normal
ladder has not finished. New evidence resets the cycle.

Claude supervision is fail-open: a missing, terminal, stale, oversized, or
malformed flight; unavailable evidence; damaged scratch; or hook exception may
reduce supervision, but cannot trap the session. The hook command itself has a
30-second host timeout.

## Advisory input and scratch bounds

| Input or state | Bound | Overflow behavior |
| --- | ---: | --- |
| `.cruise/FLIGHT.md` | 1 MB, 1,000 frontmatter tokens, nesting depth 10 | Parser returns no plan; the run continues without artifact-driven supervision. |
| `.cruise/QUEUE.md` | 1 MB, 5,000 frontmatter tokens, nesting depth 12 | Parser returns no queue; queue commands stop with an invalid/missing-queue error. |
| Claude Stop-hook JSON input | 1 MB | Hook catches the error, allows the stop, and emits a fail-open system message. |
| Codex captured agent text per turn | 64 KiB | Additional text is not used for failure-signature supervision. |
| Claude supervisor history | Last 32 fingerprints and observations | Old derived observations are dropped; authority and repository state are unaffected. |

Flight and queue writers reject symlink targets and require `.cruise` to be a
real directory. These are path-safety boundaries, not workload budgets.

## Host and command bounds

| Operation | Implemented bound or behavior |
| --- | --- |
| `cruise doctor` subprocess checks | 10-second timeout per local CLI check. |
| Codex app-server shutdown | Bounded graceful/terminate/kill cleanup stages; cancellation remains available. |
| Worker level | Integer 1–7, mapped request-locally to a provider model/effort pair. |
| Queue execution | Sequential; stops at active, blocked, stalled, failed, or dependency-deadlocked work. No milestone-attempt budget is stored. |
| Launcher exits | `0` complete, `2` blocked/failed, `3` stalled, `130` interrupted. |

Service quotas, model context windows, Claude hook timeouts, Codex host limits,
OS limits, and external API policies remain host or protocol constraints.
Cruise reports them as such and cannot weaken or extend them.

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
