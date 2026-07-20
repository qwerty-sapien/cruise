# Claude Stop-hook liveness diagnostic

This treatment-only diagnostic is excluded from paired scores and promotion
metrics. The paired `V303` models both wrote non-parseable flight-plan shapes,
so neither official arm exercised the packaged Stop supervisor. This follow-up
pre-seeded the same fixture with a valid advisory `FLIGHT.md`; no task, verifier,
threshold, plugin code, or credential condition was changed.

Observed evidence in `raw/claude-v303-x-r1-seeded-liveness/`:

- `verification.log`: the mandatory verifier remained truthfully blocked at
  exit `23`;
- `status.txt`: the only worktree entry was untracked `.cruise/`;
- `supervisor.json`: three observed stops, ladder `stalled`, and exactly two
  interventions (`realign`, `final-experiment`);
- `transcript.log`: the first two Stop-hook responses blocked continuation,
  while the third allowed the stop with the human-readable stall report.

The diagnostic therefore proves the live Claude hook integration and bounded
backstop, but it does not repair or replace either paired `V303` result.
