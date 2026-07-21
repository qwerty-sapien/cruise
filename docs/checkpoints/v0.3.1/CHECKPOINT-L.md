# Checkpoint L — Auditable supervisor liveness trail

## Claim

Codex Goal supervision no longer evaporates at process exit. After every
supervised verdict, `.cruise/.supervisor.json` atomically replaces the prior
snapshot using the same versioned schema as the Claude Stop hook. A stalled run
can be reconstructed from that file alone, including the actual interventions,
terminal report, and pause result.

This file is liveness scratch, not a ledger: it is gitignored, deletable,
per-run, and replaced rather than appended. Nothing reads it to authorize work,
grant permission, decide completion, or resume an attempt. Codex begins from
fresh in-memory state and overwrites any prior run before Goal execution; no
run directories or historical records are created.

## Falsification evidence

The L assertions were first applied to pre-L commit `de0717f`:

```text
Goal supervision realigns, runs one final experiment, then pauses with a report
Error: ENOENT: no such file or directory, open '<temp>/.cruise/.supervisor.json'
```

That same fake-client run had a stall report on stderr, proving the verdict
existed only ephemerally. With L applied, it passes and the file independently
asserts `host: codex`, `ladder: stalled`, `realign` and `final-experiment`
interventions, per-turn ids and verdict levels, the exact final report, and
`paused` or `pause-failed` outcome. A progressing run writes zero interventions
rather than leaving no file.

The shared-reader test validates both a real Claude-hook snapshot and a Codex
snapshot, including nested record shapes. The atomic-write probe proves
write-before-rename; its failure probe proves the unique temp is removed when
rename fails.

## Hostile findings

Cold review found and closed:

- a later native-turn-complete run could leave a prior stalled snapshot;
- corrective and escalation records could claim two interventions when only one
  instruction was sent;
- common-schema validation checked only top-level arrays;
- adding `host` could strand a valid legacy Claude cycle;
- failed atomic replacements could leak one uniquely named temp per retry;
- invalid-to-valid repair could erase the correction trail and its consumed
  block budget.

The final reviewer verdict was PASS.

## Every growth bound

- Exactly one `.cruise/.supervisor.json` is replaced per run; there is no append
  log, per-run directory, or cross-run history.
- `observations`, `interventions`, `seen_fingerprints`, and
  `invalid_flight_hashes` each retain at most 32 entries.
- Fingerprints and failure signatures are hashes; displayed identifiers are
  shortened to 12 characters in reports.
- Codex agent text considered for a turn is capped at 64 KiB before failure
  signature extraction.
- `final_report` and `pause_outcome` are single terminal fields replaced once,
  not growing collections. The report is built from the bounded summary above.
- `.cruise/.gitignore` gains each scratch basename idempotently.
- Atomic writes use one unique temp and unlink it on write or rename failure, so
  failed retries do not grow scratch files.
- The intervention loops are separately bounded as enumerated in
  `CHECKPOINT-G.md`.

## Unproven

No test kills a real process at the exact rename syscall. Injected ordering and
failure tests cover the contract deterministically. Host-specific optional
fields are intentionally accepted by the common reader; their values are
validated when present.

## Deviation

L's file-ownership note limited edits to the continuation/supervisor region.
One initialization call was added immediately after Goal `thread/start` so a
run that completes on its native turn cannot leave stale prior-run evidence.
It changes no deadline or activation mechanics and was required to satisfy the
per-run replacement requirement. Task I had already landed before this edit.

## Standard gates

- `npm test`: PASS, 124/124.
- `node scripts/cruise.mjs --help`: PASS.
- `claude plugin validate .`: PASS.
- `git diff --check`: PASS.
