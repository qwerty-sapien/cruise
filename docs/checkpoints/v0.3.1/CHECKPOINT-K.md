# Checkpoint K — Codex run signpost

## Claim

Every Codex launcher run that reaches `thread/start` now names its thread on
stderr, makes at most two bounded attempts to resolve the host-owned rollout,
and repeats either the exact file or a truthful unresolved fallback when the
run closes. Cruise writes only `.cruise/LAST-RUN.json`, a replaceable pointer;
it never copies rollout records or creates a transcript.

## Load-bearing empirical finding

A real minimal app-server turn produced:

```text
threadId:   019f855b-527e-77d1-bf9b-bca4c89da49e
rollout:    /Users/agent/.codex/sessions/2026/07/21/rollout-2026-07-21T23-46-22-019f855b-527e-77d1-bf9b-bca4c89da49e.jsonl
session_id: 019f855b-527e-77d1-bf9b-bca4c89da49e
```

The first JSONL record was `type: "session_meta"`; its
`payload.session_id` exactly equaled the `thread/start` id. Creating a thread
without a turn did not create a rollout immediately, while starting the first
turn did. This validates direct id-suffix lookup and the one retry after
`turn/started`.

Resolution therefore searches for `*-<threadId>.jsonl`: today's and
yesterday's local-date directories first, then one bounded widening pass. It
never constructs the filename timestamp. `CODEX_HOME` selects the root, with
`~/.codex` only as the fallback.

## Falsification evidence

Before K, a real Cruise Goal emitted no thread id or rollout path during a
40-second bounded observation and had to be terminated; the user could only
inspect session files by modification time. After Task I landed, its breadcrumb
still said only `Cruise: thread started (model ...)`, likewise leaving no id or
path correspondence.

After K, the same launcher seam is covered by a fake app-server run in which the
first lookup returns `null` and the first `turn/started` retry resolves a real
fixture file. The probe asserts:

- exactly two lookup calls;
- stderr contains the thread id, pending fallback, resolved rollout, and closing
  reference;
- stdout remains exactly the agent delta (`done`);
- `LAST-RUN.json` contains the exact path and terminal status;
- opening that printed/persisted path yields a first-record
  `session_meta.session_id` equal to the printed thread id.

Separate probes prove `CODEX_HOME`, missing session trees, the local-day fast
path, one bounded widening pass, and graceful `null` at the directory cap.
Completion, stall, and bootstrap-timeout paths assert terminal pointer/status
behavior.

## Hostile findings

A cold-context reviewer checked the isolated K diff for wrong id
correspondence, timestamp synthesis, UTC/local-date confusion, unbounded walks,
extra polling, stdout contamination, missing closing paths, pointer growth, and
trace mirroring. Verdict: PASS, with no deferred findings.

## Bounds and fallback

- Lookup attempts per run: one immediately after `thread/start`, plus at most
  one after the first matching `turn/started`.
- Directory examinations per lookup: at most 512, including the two preferred
  local-date directories.
- Scratch growth: one atomically replaced `LAST-RUN.json`; `.gitignore` is
  extended idempotently. No history, per-run directories, or rollout content.
- If lookup does not resolve, stderr and the pointer contain `rollout_path:
  null`; stderr prints the exact thread id, sessions directory, and
  `codex resume <thread-id>`. No filename is guessed.

## Unproven

The real empirical probe established id equality and rollout-creation timing;
the permanent tests use controlled files for deterministic local-date and race
coverage. They do not simulate a sessions tree exceeding 512 directories by
creating hundreds of folders; an injected low cap exercises the identical
termination branch.

## Sequencing deviation

Task I landed in commits `7868f09` and `de0717f` before K product edits began,
so K ran normally on top of I rather than being combined into the same commit.
The existing breadcrumb style was retained and augmented with the thread id.

## Standard gates

- `npm test`: PASS, 127/127.
- `node scripts/cruise.mjs --help`: PASS.
- `claude plugin validate .`: PASS.
- `git diff --check`: PASS.
