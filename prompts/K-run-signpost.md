# Task K — Run signpost: name the trace, always

## Context

You are working in the `cruise` repository. On the Codex path, Cruise
spawns `codex app-server` (`scripts/lib/app-server-client.mjs`) and drives
a thread from `SimpleCruiseSession` (`scripts/lib/simple-session.mjs`).
Cruise renders only `item/agentMessage/delta` to stdout and persists no
transcript. The authoritative full trace — every turn item, tool call, and
command — is written by Codex itself to
`<CODEX_HOME>/sessions/<YYYY>/<MM>/<DD>/rollout-<local-timestamp>-<session_id>.jsonl`.

**The gap:** a user who runs `cruise goal "..."` has no way to know which
rollout file is their run. The information exists (Cruise holds the thread
id from `thread/start` at `this.threadId`) but is never surfaced. This
task is a signpost, not a logging subsystem: Cruise must never mirror or
duplicate the rollout — the host owns that trace.

**Verified facts to build on (re-verify, do not trust this summary):**
- The rollout filename's trailing UUID equals `session_meta.session_id`
  in the file's first JSONL record.
- The filename timestamp is LOCAL time while payload timestamps are UTC,
  and the date directory is local-time based. Therefore the path must be
  found by **globbing for `*-<id>.jsonl`**, never by constructing a
  timestamp string.
- `~/.codex/session_index.jsonl` maps `{id, thread_name, updated_at}` and
  is a secondary lookup.

## Empirical gate (do this FIRST, before designing output)

Determine whether Cruise's `threadId` from `thread/start` is the same
identifier as the rollout `session_id`. Run a real short `cruise goal`
(or a minimal app-server thread) and compare the thread id Cruise holds
against the newest rollout's `session_meta.session_id`.

- **If they match:** resolve the path by glob and print it.
- **If they do not match:** find the real correspondence (inspect
  `session_meta`, `session_index.jsonl`, or the app-server `thread/start`
  response for any rollout/session field) and use that. If no reliable
  correspondence exists, **do not guess a path** — print the thread id,
  the sessions directory, and the `codex resume` hint, and state plainly
  that the exact file could not be resolved. A wrong path is worse than
  no path; the launcher's prohibition on invented failure narratives
  applies to signposts too.

Record the finding in your checkpoint artifact either way — it is the
load-bearing fact of this task.

## Task

1. **Resolve the trace location** in a small helper (new
   `scripts/lib/trace-locator.mjs`):
   - `export function codexHome(env = process.env)` — honor `CODEX_HOME`
     and fall back to `~/.codex`. **This matters:** the evaluation harness
     runs Codex arms under a sandboxed `CODEX_HOME`, so a hardcoded path
     would point at the wrong home during studies.
   - `export async function locateRollout(threadId, { home, now })` —
     glob `sessions/**/*-<threadId>.jsonl` (search today's and yesterday's
     local-date directories first, then widen once) and return the path
     or `null`. Never throw; a missing trace is a normal early condition.
   - Bound the search (no unbounded recursive walk of an old sessions
     tree): cap directories examined and return `null` past the cap.
2. **Print the signpost** as part of the bootstrap breadcrumbs:
   - Immediately after `thread/start` succeeds, print the thread id — it
     is always available and never racy.
   - Best-effort resolve the rollout path and print it when found. The
     file may not exist the instant the thread starts; do not block or
     poll aggressively. One immediate attempt plus one retry after the
     first turn starts is enough.
   - Print a copy-pasteable tail hint alongside it.
   - Repeat the reference in the closing summary (completion, stall, and
     error paths alike) — the moment a user most wants the trace is when
     the run ended badly.
   - All of this goes to **stderr**, so `cruise goal ... | tee run.log`
     keeps stdout clean.
3. **Persist a pointer** at `.cruise/LAST-RUN.json`: thread id, resolved
   rollout path (or null), cwd, skill, start and end timestamps, final
   status. This is liveness/pointer scratch in the same class as
   `.cruise/.supervisor.json` — gitignored (extend the existing
   `.cruise/.gitignore` writer rather than adding a second mechanism),
   deletable at any time, carrying no authority. It replaces itself each
   run; it is not a history or ledger. Do not touch `.cruise/ORIGIN.md`
   semantics.
4. **README:** one short subsection under troubleshooting or usage —
   "Where is my full trace?" — showing the printed signpost, the
   `tail -f`/`jq` recipe, and `codex resume`. Note explicitly that the
   rollout is Codex's file, not Cruise's, and that Cruise stores only a
   pointer.

## Sequencing note

This task edits the bootstrap region of `simple-session.mjs`, which Task I
(`prompts/I-bootstrap-liveness.md`) also owns. **If Task I has not yet
run, fold this task into I** — the breadcrumbs are the same mechanism and
merging them avoids a pointless collision. If I has already landed, run
this normally and keep the breadcrumb style consistent with what I
established.

## Red-team gate (falsification checkpoint)

- **Fail-before:** on pre-change code, run a real short goal and show that
  nothing in Cruise's output identifies the rollout — the user must grep
  by mtime and guess. Capture that output.
- **Pass-after:** the same run prints the thread id and (if the gate
  resolved) the exact rollout path; `.cruise/LAST-RUN.json` contains it;
  and the printed path, when opened, has a `session_meta.session_id`
  matching the printed thread id — **assert this equality in the test**,
  it is the whole point.
- Also probe: `CODEX_HOME` override respected (temp home fixture);
  rollout absent at start (prints id, no false path, no crash); sessions
  directory missing entirely (graceful null); stdout remains free of
  signpost text under a piped-stdout fixture.

## Files you own

`scripts/lib/trace-locator.mjs` (new), the bootstrap/closing-summary
regions of `scripts/lib/simple-session.mjs`, `.cruise/.gitignore` writer
extension, tests, README subsection,
`docs/checkpoints/v0.3.1/CHECKPOINT-K.md`.

## Files you must not touch

`scripts/lib/supervisor.mjs` and the supervisor state writer (Task L),
`hooks/**`, `skills/**`, `evals/**`, `scripts/lib/flight-plan.mjs`.

## Acceptance criteria

- `npm test` green; the id-equality assertion above is a real test, not a
  comment.
- No transcript mirroring anywhere: Cruise writes a pointer, never trace
  content. If you find yourself copying rollout records, stop — that is
  out of scope by design.
- Signpost adds at most a few stderr lines; a healthy run's stdout is
  byte-identical to before.
- The checkpoint artifact states the threadId↔session_id finding, the
  resolution strategy chosen, and what happens when resolution fails.
