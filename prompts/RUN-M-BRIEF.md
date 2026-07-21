Execute the transport-liveness repair specified in prompts/M-transport-watchdog.md.

That file is authoritative — read it in full first. Where this summary and the spec disagree, the spec wins.

Context: Task I (7868f09) correctly bounded the Codex goal-bootstrap wait, but a red-team of the shipped CLI against a hostile fake app-server found six further hangs, two producing zero bytes on stdout AND stderr for a full five minutes. The spec has the reproduced probe matrix, the reusable harness location, and two claims that were investigated and RETRACTED (a supposed picker/stdin-EOF bug and a supposed "unknown request id" bug — both harness artifacts; do not re-hunt them).

Root cause is a class defect: client.request() has no RPC timeout, client.start() has no handshake bound, startTurn()'s completion promise is unbounded (four of five shipped skills, plus every goal continuation turn), and the app-server's own stderr is subscribed by nothing and discarded. Consequence: the Task C supervisor only evaluates between completed turns, so a turn that never completes parks the loop inside startTurn and the supervisor never runs — Cruise's anti-stall feature is blind to a hung turn.

Build, per the spec:
1. A transport inactivity watchdog on AppServerClient, reset by ANY inbound JSONL frame — this distinguishes slow from dead. Default 300000 ms, overridable via CRUISE_INACTIVITY_TIMEOUT_MS. MUST suspend while awaiting human input so an unanswered prompt cannot trip it. On trip: loud diagnostic (elapsed, last frame's method, thread/turn/goal state, stderr tail), terminate the client, reject pending requests so every parked await unwinds. Never a silent kill.
2. Bound client.start()'s initialize handshake with the existing waitWithin(). Do NOT put a wall-clock ceiling on turns — turns are legitimately long; rely on the watchdog.
3. Subscribe to the client's 'stderr' event in scripts/cruise.mjs and print it, prefixed and volume-bounded.
4. Fix the 25%-flaky Task I regression test at its source: the cleanup diagnostic embeds a decrementing remainder, so report the configured budget instead. Do not loosen the regex.
5. Exit code 5 for transport inactivity; update HELP, README exit codes, one LIMIT_POLICY.md liveness row.

Mandatory falsification gate: reproduce all six stalls on pre-change code FIRST (if any already terminates, the harness is wrong — fix it), then show every probe terminating loudly, with C still exit 4 at ~120s and F still exit 1. Also run false-positive probes: a turn streaming deltas past the window, and an unanswered human prompt past the window, must NOT trip the watchdog. Then a cold hostile review of the diff, then docs/checkpoints/v0.3.1/CHECKPOINT-M.md.

Before starting: the worktree carries ~775 uncommitted lines of Task G work across 9 files. Commit or stash it separately; do not fold it into M, do not revert it.

Philosophy: evidence-based, bounded, fail-safe. Fail-loud never means fail-blocking. Artifacts stay advisory; no authority state. Commit before editing; do not push.
