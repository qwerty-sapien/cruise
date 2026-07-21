# Task M — Transport inactivity watchdog: bound the hang *class*, not one instance

## Context

Task I (commit `7868f09`) fixed a proven hang: Codex CLI 0.144.6 acknowledges
`thread/goal/set` and emits `thread/goal/updated` but never issues
`turn/started`, so `waitForNativeGoalTurn()` parked forever. I added
breadcrumbs, a 120 s first-turn deadline, goal diagnostics, best-effort pause,
and exit code `4`. **That fix works and must be preserved.**

But it bounded one `await`. A red-team of the shipped CLI against a hostile
fake app-server (8 probes, each hard-killed at 5 minutes) found **six further
hangs**, two of them producing zero bytes on stdout *and* stderr for the full
five minutes — the same user experience as the bug just fixed, via different
entry points.

### Red-team evidence (reproduced 2026-07-22, working tree at `7868f09` + uncommitted Task G)

| Probe | Lane | Injected fault | Result |
| --- | --- | --- | --- |
| `C_goal_no_turn` | goal | goal set, no `turn/started` | **exit 4 @ 120.6 s** ✅ (Task I) |
| `F_exit_midturn` | quick | app-server exits mid-turn | **exit 1 @ 0.9 s** ✅ |
| `A_no_initialize` | goal | `initialize` never answered | **STALLED 300 s, 0 b stdout, 0 b stderr** |
| `B_no_thread_start` | goal | `thread/start` never answered | **STALLED 300 s**, 1 breadcrumb then silence |
| `D_turn_never_completes` | quick | `turn/started` sent, never completed | **STALLED 300 s** |
| `E_goal_continuation_hang` | goal | first turn completes, continuation never does | **STALLED 300 s** |
| `G_question_no_stdin` | quick | host asks a question, stdin at EOF | **STALLED 300 s** |
| `H_turn_start_no_reply` | quick | `turn/start` RPC never answered | **STALLED 300 s, 0 b stdout, 0 b stderr** |

Harness (reusable, extend it rather than rewriting):
`scratchpad/rt/bin/codex` (fake server, `RT_MODE` selects the fault),
`scratchpad/rt/run.mjs` (spawns the real CLI, `RT_CAP_MS` cap),
`scratchpad/rt/all.sh` (parallel matrix).

### Two claims from that run were investigated and RETRACTED — do not re-hunt them

- **"Picker hangs on stdin EOF" — FALSE.** Probe `G2_question_then_complete`
  (same question, but the turn later completes) exits `0` in 2.2 s. The picker
  handles EOF correctly. G's stall was entirely the unbounded-turn defect.
- **"`Response for unknown request id: 9001`" — harness artifact, not a Cruise
  bug.** The fake echoed Cruise's own response back as a bogus response; Cruise
  warned correctly. The fake has been corrected.

## Root cause: three unbounded awaits, one missing backstop

1. **`client.start()` / `initialize`** — no deadline. → probe A, silent.
2. **`client.request()`** at
   [scripts/lib/app-server-client.mjs:137](scripts/lib/app-server-client.mjs:137)
   — stores a pending entry, resolves only on a matching response, **no
   timeout**. Any unanswered RPC hangs forever. → probes B, H.
3. **`startTurn()`** at
   [scripts/lib/simple-session.mjs:594](scripts/lib/simple-session.mjs:594) —
   `return await completion.promise` with no deadline. This is the *only* turn
   path for `quick`/`refine`/`build`/`debug` (four of five shipped skills) and
   for every goal **continuation** turn. → probes D, E, G.
4. **App-server stderr is discarded.**
   [scripts/lib/app-server-client.mjs:245](scripts/lib/app-server-client.mjs:245)
   emits a `'stderr'` event; **nothing in `scripts/` subscribes to it**
   (verified by grep). Whatever the host prints about its own failure is thrown
   away — which is why probes A and H are byte-silent.

### Architectural consequence (the most important finding)

The stall supervisor from Task C evaluates evidence **between completed turns**.
Probe E proves that a turn which never completes parks the loop *inside*
`startTurn`, so the supervisor never runs at all. **Cruise's headline anti-stall
feature is structurally blind to a hung turn** — the exact failure mode that
started this investigation. Fixing this is the point of Task M.

## What you are building

### 1. Transport inactivity watchdog (`AppServerClient`) — the primary mechanism

One watchdog at the transport layer replaces five scattered deadlines.

- **Reset on any inbound JSONL frame** — response, notification, or server
  request. This is what distinguishes *slow* from *dead*: a healthy long turn
  streams `item/agentMessage/delta` and tool-progress frames and keeps resetting
  the timer; a hung or wedged host sends nothing and trips it.
- **Default 300 000 ms**, overridable per-construction and via the
  `CRUISE_INACTIVITY_TIMEOUT_MS` environment variable (request-scoped, like
  every other Cruise preference; reject non-positive/non-integer values by
  falling back to the default rather than throwing).
- **Suspend while awaiting a human.** Before `pickOne`/`readLine` is awaited,
  pause the watchdog; resume when the answer returns. A user thinking about an
  approval prompt must never trip a liveness timer. This is mandatory — probe
  G's prompt sat unanswered for the full cap, and a naive watchdog would have
  blamed the host.
- **Fail loud, never silent-kill.** On trip, emit a diagnostic naming: elapsed
  since last frame, the method/kind of that last frame, thread id, current turn
  id (if any), and current goal status if cheaply available. Then terminate the
  client and reject all pending requests with that error so every parked
  `await` unwinds.
- Clear the timer on `stop()`, on child exit, and on interrupt; assert no timer
  leaks (test with an open-handle check).

### 2. Bound the specific awaits that the watchdog cannot see

The watchdog covers "host went quiet". It does **not** cover a host that
chatters while making no semantic progress. Add:

- **`client.start()`**: bound the `initialize` handshake with the existing
  `waitWithin()` helper (default 30 s) so a server that spawns but never
  handshakes fails loudly with its own message.
- **`startTurn()`**: no wall-clock ceiling (that would violate `LIMIT_POLICY.md`
  — turns are legitimately long). Instead ensure the watchdog's rejection
  propagates into the parked completion promise, and add a test proving probes
  D/E/G now terminate.

### 3. Surface the app-server's own stderr

Subscribe to the client's `'stderr'` event in `scripts/cruise.mjs` and write it
to `process.stderr`, prefixed (e.g. `codex: `) so it is attributable. Bound the
retained volume (last ~8 KB) to avoid unbounded memory on a chatty host, and
include the tail in the watchdog diagnostic.

### 4. Fix the flaky regression test guarding Task I

`tests/simple-session.test.mjs` fails **3 runs in 12** (25 %, measured):

```
actual:   '...goal-read-error=... did not settle within 19ms.'
expected: /goal-read-error=.*did not settle within 20ms/
```

Cause: [scripts/lib/simple-session.mjs:613-614](scripts/lib/simple-session.mjs:613)
computes `remainingCleanupMs` as a **decrementing remainder**
(`cleanupDeadline - Date.now()`), so the diagnostic embeds a value that varies
with scheduling. Fix at the source: report the **configured** cleanup budget in
the message (deterministic) and keep the remainder purely internal as the actual
timeout value; or assert on a tolerance range. Do **not** merely loosen the
regex to silence the noise — that weakens the guard on the Task I fix.

### 5. Exit codes and docs

Add a distinct exit code `5` for transport inactivity (0 complete, 2 failed,
3 supervisor stall, 4 goal-bootstrap timeout, 5 transport inactivity,
130 interrupted). Update `HELP` in `scripts/cruise.mjs`, the README exit-code
table, and add one `LIMIT_POLICY.md` row under **Liveness and recovery**:
named source, evidence-based (inbound-frame activity, not a workload budget),
user-tunable, suspended during human input, terminates in a loud report.

## Red-team gate (falsification checkpoint)

1. **Fail-before:** run the harness matrix on pre-change code. Probes A, B, D,
   E, G, H must be observed **STALLED at the 300 s cap** — reproducing the table
   above. If any of them already terminates, the harness is wrong; fix the
   harness before touching the source.
2. **Pass-after:** the same matrix must show every probe terminating with a
   loud, attributable message and a documented exit code. C must still exit `4`
   at ~120 s and F must still exit `1` — Task I and the exit-handler path are
   regressions if they change.
3. **False-positive probes (equally important):**
   - a healthy long turn that streams a delta every ~2 s for well past the
     watchdog window must **not** trip it;
   - an unanswered human prompt held open past the watchdog window must **not**
     trip it (this is probe G2's shape, with the human never answering);
   - a normal fast run's stdout must be byte-identical to today's apart from
     the new stderr breadcrumbs.
4. **Cold hostile review** of the diff against this spec: look for a
   reintroduced silent path, an unbounded loop, a timer leak, or any growth of
   Cruise-owned authority.
5. Write `docs/checkpoints/v0.3.1/CHECKPOINT-M.md` in the established format:
   Claim / Falsification evidence (both matrices) / Hostile findings /
   Unproven.

## Files you own

`scripts/lib/app-server-client.mjs`, `scripts/cruise.mjs` (stderr subscription,
exit code, HELP), the `client.start()` bound and cleanup-message fix in
`scripts/lib/simple-session.mjs`, `LIMIT_POLICY.md` (one row), README exit-code
table, `tests/app-server-client.test.mjs`, `tests/simple-session.test.mjs`, a
new `tests/transport-watchdog.test.mjs`, and the promoted harness.

## Files you must not touch

`skills/**`, `hooks/**`, `scripts/lib/supervisor.mjs`, `scripts/lib/flight-plan.mjs`,
`scripts/lib/queue.mjs`. **Note:** the worktree currently carries ~775
uncommitted lines of Task G work across 9 files (`inspectFlightPlan`,
`flightPlanTemplate`, `correctiveReason`, supervisor state persistence).
Commit or stash that separately **before** starting; do not fold it into M, and
do not revert it.

## Acceptance criteria

- Full matrix green in both directions (hangs bounded, healthy paths untouched).
- The probe matrix exists as **permanent** `node --test` regression tests using
  an in-process fake client (no reliance on the scratchpad harness for CI);
  keep the shell harness for end-to-end spot checks.
- `tests/simple-session.test.mjs` passes **20 consecutive runs** (the flake is
  fixed, not masked).
- No timer leaks: tests exit promptly with no open handles.
- `npm test` green; `node scripts/cruise.mjs --help` works;
  `claude plugin validate .` passes.
- No new runtime dependencies. Match existing style.
- Every diagnostic names the observed condition only — no speculative causes
  (the skill files' prohibition on invented failure narratives applies to the
  launcher).

## Constraints

Supervision is evidence-based, bounded, fail-safe. Fail-loud never means
fail-blocking: a tripped watchdog terminates the *session* with a report, it
never blocks the host's authority or traps the user. Artifacts stay advisory;
no approval objects, ledgers, or authority state. Commit before editing. Do not
push.
