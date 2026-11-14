# Staging a Goal while its parent continues

Use a separate process to establish the Codex app-server connection and create a
thread before the parent gives up ownership of its workspace:

```sh
cruise --codex goal --strict-budget -C /absolute/project \
  --staged-handoff /private/tmp/cruise-transfer/capsule.json \
  --ready-file /private/tmp/cruise-transfer/ready.json \
  'Finish the originally scoped task'
```

Create the external transfer directory first. Both paths must be distinct,
absolute `.json` paths, outside the canonical target workspace, with existing
parents. Neither file may already exist. Use a fresh directory for each launch.
The child creates the ready marker exclusively, without overwriting existing
files. Parent-directory symlinks are resolved before workspace containment checks.

The child publishes readiness only after the app-server transport and thread
exist. This is **transport/thread readiness, not proven model inference**. While
waiting, the launcher starts no Goal turn and writes no repository documents. It reports
waiting heartbeats at least every 120 seconds and has no default wall timeout.
Cancellation or a transport exit stops the wait and cleans up the owned marker.
Readiness never starts an automatic duplicate executor. Quota admission is checked
after accepted handoff and before Goal activation; readiness alone does not certify
quota or model execution.

The parent may continue its authorized work until it reads the ready marker.
Then it finishes its current safe boundary, stops all writes and task execution
against the workspace, and atomically publishes its final capsule. It must not
resume competing execution after setting `parent_relinquished: true`.

Read `session_id`, `thread_id`, and canonical `workspace` from `ready.json` and
copy them exactly into the capsule. Write a new temporary file beside
`capsule.json`, close it, then rename it to `capsule.json`. Do not write the
capsule in place. Its UTF-8 JSON must be at most 8192 bytes and have exactly these
fields (replace the example identities with the ready marker values):

```json
{
  "version": 1,
  "session_id": "from-ready-marker",
  "thread_id": "from-ready-marker",
  "workspace": "/absolute/project",
  "parent_relinquished": true,
  "completed": ["Source changes already implemented"],
  "remaining": ["Run the focused verification and review its result"],
  "decisions": ["Preserve the original task scope"],
  "evidence": ["Path to existing evidence; references are not opened by the barrier"],
  "ownership": ["Child now owns the remaining task work"]
}
```

All five lists contain strings; empty lists are allowed. Keep entries concise and
exclude unsafe control characters. The barrier rejects mismatched identities,
missing or extra fields, malformed or oversized JSON, invalid UTF-8, symlinks,
hard-linked or nonregular capsules, preexisting capsules, and capsules whose
modification time predates readiness. A malformed publication fails closed;
it does not silently wait for a replacement or start execution.

After acceptance, the first task context includes the compact capsule and an
instruction to reconcile it with current work, preserve completed work, and keep
the original scope. Capsule references remain inert strings: the barrier does
not traverse paths, open evidence files, or inspect repository state. This is an
ownership and context barrier, not a proof of capsule statements or a prompt
content sanitizer.

The parent owns and retains the capsule file. The child removes its ready marker
on success, cancellation, or error only when its inode and content still match;
a foreign replacement or edited marker is preserved. Timers, abort listeners,
and open file handles are released when waiting ends. The parent may remove the
external transfer directory after the child has finished.

## Startup wait controls

Idle first-turn startup has a 30-second deadline by default. Goal activation is
metadata, so Cruise reconciles thread status and recent turn history, adopts an
existing turn, and requests one explicit Plan bootstrap when the thread is idle.
It recovers missed completion events and never blindly retries an ambiguously
accepted start. Reactivation uses the same reconciliation in execution mode.
Transport inactivity accounting resumes as soon as a turn is established; the
idle startup deadline is then cleared. Process exit, cancellation and concrete
nonretrying protocol errors settle the wait with the actual cause.

Use `--bootstrap-timeout-ms 600000` to select a ten-minute idle first-turn deadline,
or `--bootstrap-timeout-ms off` (equivalently 0) to disable it. The corresponding
environment override is `CRUISE_GOAL_BOOTSTRAP_TIMEOUT_MS`.

The separate app-server initialize handshake retains its 30-second default.
It can be changed with `CRUISE_INITIALIZE_TIMEOUT_MS=180000` or its own deadline
disabled with 0. This does not disable the normal transport/process watchdog.
Shutdown escalation waits remain short so cancellation does not leak a child.
Tool polling waits such as five seconds are observation intervals, not these
startup deadlines.

Doctor command probes use a separate 60-second default rather than ten seconds,
because installed-plugin discovery may also contact the remote catalogue. Set
`CRUISE_DOCTOR_PROBE_TIMEOUT_MS` to a larger millisecond value or 0 to disable
that diagnostic deadline. A selected finite limit still reports a timeout for
an unresponsive probe; this setting does not govern task/model execution.
