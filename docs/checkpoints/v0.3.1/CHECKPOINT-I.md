# Checkpoint I — Codex Goal bootstrap liveness

## Claim

Once Codex confirms the native Goal as active, Cruise can no longer wait
silently or indefinitely for its first native turn. The launcher emits four
stderr breadcrumbs, arms a configurable 120-second first-turn deadline, reads
diagnostics and attempts a pause within one additional fixed two-second cleanup
budget, then raises `CRUISE_GOAL_BOOTSTRAP_TIMEOUT`. `runStart` maps that
condition to exit code 4.

The first-turn timer is cancelled when this thread starts a turn. Its cleanup
waits are also cancelled on interruption and app-server exit. These bootstrap
flags are gated by `nativeGoalTurnWaiting`, so continuation turns retain their
pre-change handling and receive no wall-clock deadline.

## Falsification evidence

The same standalone no-turn fake was run against the pre-task parent
`18553bf` and the final Task I state. It acknowledges `thread/start`,
`thread/settings/update`, and active `thread/goal/set`, but never emits
`turn/started`. A separate 100 ms watchdog bounds the probe.

Fail-before (`18553bf`, expected-behavior probe exit 1):

```text
{"outcome":{"kind":"still-pending"},"stdout":"","stderr":"","goalStatuses":["active"]}
```

This is the target defect: after the injected 20 ms deadline window the old
session was still pending, had emitted no output, and had left the Goal active.

Pass-after (same probe, exit 0):

```text
{"outcome":{"kind":"rejected","code":"CRUISE_GOAL_BOOTSTRAP_TIMEOUT","message":"Codex never started the native Goal turn within 20ms (thread=probe-thread, model=probe-model, goal=active, elapsed=20ms)."},"stdout":"","stderr":"Cruise: app-server started.\nCruise: thread started (model probe-model).\nCruise: goal activated.\nCruise: waiting for the native Goal turn.\n","goalStatuses":["active","paused"]}
```

Permanent tests additionally prove:

- the no-turn probe has its own watchdog and reports breadcrumbs, diagnostics,
  the pause transition, and the dedicated error;
- `runStart` exercises the real session with a no-turn client and returns 4;
- a turn immediately before the deadline preserves the captured healthy stdout
  (`healthy transcript\n`), cancels the timer, and produces no unhandled
  rejection;
- hung diagnostic RPCs consume no more than the injected cleanup budget;
- interruption and app-server exit cancel a hung cleanup timer promptly.

Final gates on the combined worktree:

```text
npm test
# 120 passed, 0 failed

node scripts/cruise.mjs --help
# exit 0; documents exit code 4

claude plugin validate .
# Validation passed
```

## Hostile findings

The cold-context reviewer initially found that diagnostic `thread/goal/get`
and pause RPCs could hang after the first-turn timer fired. Fixed: both now
share a fixed two-second cleanup budget, with explicit interrupt/exit
cancellation and permanent hung-RPC tests.

The reviewer also found that bootstrap flags were being updated for every
continuation `turn/started`. Fixed: timer state changes only while
`nativeGoalTurnWaiting` is true; the existing generic turn-id handling remains
unchanged for continuation turns.

The reviewer requested a permanent fail-before probe and interrupt/error-path
coverage. Fixed: the no-turn test now includes a 100 ms independent watchdog,
and dedicated tests cover hung cleanup cancellation on interrupt and app-server
exit.

One proposed fix was deliberately rejected after a second hostile pass. Starting
the deadline before `thread/goal/set` is confirmed can let a late activation
succeed after timeout cleanup, orphaning a Goal, or let a native turn mask a
failed activation acknowledgement. The final design therefore starts the
first-turn clock only after activation is confirmed, matching the task's
acknowledged-activation probe and preserving best-effort orphan prevention.
Startup before that point is still loud through the app-server and thread
breadcrumbs.

The reviewer flagged edits in `interrupt`, `handleExit`, and the shared
`turn/started` handler as outside the bootstrap region. No continuation-loop
code or continuation deadline was added. These three narrowly guarded edits
are retained because they are the only event sites that can satisfy the spec's
required timer cancellation on turn start, interruption, and app-server error.
They add no approval object, ledger, authority state, or blocking behavior.

## Unproven

- The final two-second cleanup hardening was not repeated against a real Codex
  app-server with the production 120-second clock. Deterministic fake-client
  tests cover the exact RPC and notification seams without adding a two-minute
  test to the suite.
- A host that never acknowledges Goal activation is not converted into a
  first-turn timeout. It is already non-silent after the app-server/thread
  breadcrumbs, and detaching or racing activation would weaken the requirement
  to avoid an orphaned active Goal.
- Pause remains best-effort. If the host cannot confirm it within the cleanup
  budget, the dedicated error reports `pause-error`; Cruise still exits loudly
  rather than claiming the Goal was paused.
