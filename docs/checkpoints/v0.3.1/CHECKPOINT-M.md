# Checkpoint M — Transport inactivity watchdog

## Claim

Cruise no longer relies on individual RPC or turn-completion deadlines to
detect a quiet Codex app-server. `AppServerClient` now owns one transport
inactivity watchdog, reset by every inbound JSONL response, notification, or
server request. Its request-scoped default is 300 seconds; a positive integer
constructor option or `CRUISE_INACTIVITY_TIMEOUT_MS` overrides it, while
invalid values fall back to the default.

The watchdog is suspended only around actual picker and free-text human waits,
including approvals, then restarted when the wait settles. It does not impose
a turn-duration ceiling. On expiry it reports elapsed time since the last
frame, that frame's kind and method, the last known thread, current turn and
Goal status, and a bounded 8 KiB app-server stderr tail. It rejects every
pending RPC with `CRUISE_TRANSPORT_INACTIVITY`, propagates the same error into a
parked turn completion through the client exit event, terminates the child with
bounded SIGTERM-to-SIGKILL escalation, and maps the launcher result to exit 5.

`initialize` also has an independent 30-second handshake bound, because the
transport watchdog is activity-based and can be kept alive by semantically
irrelevant frames. Codex stderr is surfaced live on Cruise stderr with a
`codex: ` prefix. The Task I Goal-bootstrap deadline remains separate and has
no continuation-turn ceiling.

## Falsification evidence

The promoted end-to-end harness is
`scripts/transport-watchdog-matrix.mjs`, backed by the hostile app-server at
`tests/fixtures/transport-watchdog/bin/codex`. The fail-before run used the
clean pre-implementation state at `da63598`; the six target probes ran in
parallel with the specified 300-second hard cap.

Fail-before:

| Probe | Observed result |
| --- | --- |
| `A_no_initialize` | hard-killed at 300,015 ms; 0 stdout bytes, 0 stderr bytes |
| `B_no_thread_start` | hard-killed at 300,010 ms after the app-server breadcrumb |
| `C_goal_no_turn` | exit 4 at 120,229 ms |
| `D_turn_never_completes` | hard-killed at 300,010 ms |
| `E_goal_continuation_hang` | hard-killed at 300,010 ms |
| `F_exit_midturn` | exit 1 at 247 ms |
| `G_question_no_stdin` | hard-killed at 300,009 ms after picker EOF |
| `H_turn_start_no_reply` | hard-killed at 300,008 ms |

Pass-after used the same fault matrix with an explicit 250 ms inactivity
override. C emitted a harmless status notification every 50 ms so the
transport stayed live and Task I's semantic deadline remained the deciding
mechanism.

| Probe | Observed result |
| --- | --- |
| `A_no_initialize` | exit 5 at 324 ms; surfaced `codex: initialize probe waiting` and retained it in the diagnostic |
| `B_no_thread_start` | exit 5 at 377 ms; last frame `response:initialize` |
| `C_goal_no_turn` | exit 4 at 120,163 ms |
| `D_turn_never_completes` | exit 5 at 392 ms; last frame `notification:turn/started` |
| `E_goal_continuation_hang` | exit 5 at 425 ms; thread, continuation turn, and active Goal named |
| `F_exit_midturn` | exit 1 at 164 ms |
| `G_question_no_stdin` | exit 5 at 389 ms; last frame `request:item/tool/requestUserInput` |
| `H_turn_start_no_reply` | exit 5 at 373 ms; last frame `response:thread/start` |

The false-positive matrix also passed:

- a 320 ms turn streaming eight deltas through a 250 ms watchdog completed
  normally with exit 0;
- an unanswered picker held open for 800 ms had no armed watchdog and remained
  alive until the harness cap;
- a normal fast run exited 0, and its stdout was byte-identical before and
  after: `fast output\n`, base64 `ZmFzdCBvdXRwdXQK`.

Permanent `node --test` coverage uses an in-process hostile app-server. It
replays A through H, proves response/notification/server-request resets,
streaming and human-wait non-trips, stderr-tail containment, the independent
initialize deadline, exit-code mapping, Task I and process-exit preservation,
and timer cleanup. The open-resource check observes no additional `Timeout`
resource after a normal run.

The Task I flake guard passed 20 consecutive runs. Its diagnostic now reports
the configured 20 ms cleanup budget while the scheduling-dependent remainder
is used only as the internal timeout.

Final standard gates:

```text
npm test
# 138 passed, 0 failed

node scripts/cruise.mjs --help
# exit 0; documents exit code 5

claude plugin validate .
# Validation passed

git diff --check
# PASS
```

## Hostile findings

The first reconstructed G probe used a free-text question and therefore tested
`readLineOnce`, not the option picker named by the retracted EOF claim. It was
rejected as a harness defect. The permanent and end-to-end probes now use an
option-bearing request; picker EOF settles, Cruise replies with the observed
cancellation, and only the deliberately unfinished turn reaches inactivity.

The first watchdog abort rejected all parked awaits but sent only SIGTERM. A
hostile child that ignored SIGTERM could therefore keep the Node process alive
after the loud report. Fixed: watchdog and initialize aborts arm a bounded
SIGKILL escalation, clear that cleanup timer on child exit, and have a
permanent ignored-SIGTERM test.

The first human-wait implementation reused the watchdog baseline as the
reported last-frame timestamp. Resuming after a long prompt therefore excluded
human think time from the `elapsed` diagnostic. Fixed: the actual last-frame
clock and suspension-adjusted watchdog baseline are separate, so the trigger
excludes human time while the report truthfully measures from the frame.

A final pass checked for a reintroduced silent rejection path, per-request
timer growth, a turn-duration ceiling, watchdog activity during human input,
timer retention after stop/exit/interrupt, unbounded stderr retention, and new
Cruise-owned authority. No unresolved instance was found. The implementation
adds no approval state, ledger, attempt budget, or artifact authority.

## Unproven

- The post-change end-to-end matrix uses the documented request-scoped 250 ms
  override rather than waiting five minutes for the 300-second production
  default. The fail-before matrix did run the full 300-second cap, and parsing
  tests pin the production default and invalid-value fallback.
- The 30-second initialize default is exercised with an injected 15 ms bound in
  permanent tests. The exact default duration is not slept in CI.
- The hostile app-server and in-process transport exercise the production
  JSONL and process seams, but the final watchdog was not deliberately tripped
  against a real signed-in Codex service.
- SIGKILL escalation is tested against a fake child that ignores SIGTERM. The
  operating system's process-reaping behavior remains host-owned.
