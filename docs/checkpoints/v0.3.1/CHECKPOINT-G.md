# Checkpoint G — Self-healing invalid flight state

## Claim

A fresh, present `.cruise/FLIGHT.md` can no longer disable either Goal
supervisor silently. Both hosts distinguish absent, invalid, and valid state.
Absent state remains inert; invalid state produces one corrective intervention
per content hash, then terminates through a loud, bounded allow/stall path.

## Falsification evidence

The tests were first applied to pre-G commit `de0717f`.

- `node --test --test-name-pattern='invalid flight state gets one corrective' tests/simple-session.test.mjs`
  failed because the fake Codex run sent the ordinary `Continue the active
  Cruise Goal` text instead of a degraded-supervision correction.
- The pre-change hook probe using the real fenceless pilot artifact returned
  inert `null`; the new assertion failed while reading `decision` from that
  result. This reproduced the pilot's silent failure rather than merely testing
  a synthetic parse error.

With the change applied, the same pilot-shaped hook and fake-client Codex probes
pass. They assert the parse reason and complete canonical template, exactly one
correction for a repeated hash, loud allow behavior, and the terminal cap. The
focused G/L suite passed 53 tests during hostile review; the final standard gate
is recorded below.

Additional passing probes cover an empty file, bad status, malformed fenced
frontmatter, valid template, five unique invalid rewrites, repair after an
unseen invalid hash at the cap, byte-empty stdout for absent flight state, and
cross-parser numeric edge cases.

## Hostile findings

Two cold-context review rounds found and closed these defects:

- hook/runtime stall parsing diverged; both now reject unsafe integers and
  share integer-scalar behavior;
- invalid metadata originally replaced the real Codex fingerprint, which could
  misclassify product progress; product fingerprints are retained while the
  advisory flight file itself is excluded;
- an escalation coinciding with correction could record an instruction that
  was not sent; each observation now records only the returned verdict;
- invalid-to-valid repair could erase the correction or reset the cap,
  including the unseen-hash-at-cap boundary; the bounded cycle now survives;
- legacy Claude scratch without `host` failed open; it is migrated in memory;
- YAML error line numbers were frontmatter-relative and absent-flight coverage
  did not prove empty bytes; both were corrected.

The final reviewer verdict was PASS.

## Bounds

- Hook invalid-state corrections: one per content hash and at most five blocked
  stops in the cycle (`DEFAULT_STALL.quietTurns + 2`); repeats and cap exhaustion
  allow with a report.
- Codex corrections: one per retained hash and part of the existing
  `quietTurns`/`sameFailure` ladder; after realignment and one final experiment,
  the run stalls and pauses.
- Retained observations, interventions, fingerprints, and invalid hashes: 32
  entries each. Older entries are discarded.
- Flight input: 1 MiB; parsed frontmatter: 1,000 tokens and nesting depth 10.
- Scratch writes replace one file atomically. Failed writes unlink their unique
  temp file, so retries do not accumulate temp files.

## Unproven

The tests simulate host notifications and filesystem states rather than killing
a live Claude or Codex process mid-rename. The injected write→rename failure
probe covers the relevant cleanup ordering without adding a flaky process-kill
test. No lenient YAML recovery is attempted; invalid prose remains deliberately
invalid and receives the bounded correction.

## Standard gates

- `npm test`: PASS, 124/124.
- `node scripts/cruise.mjs --help`: PASS.
- `claude plugin validate .`: PASS.
- `git diff --check`: PASS.
