# Changelog

## 0.3.0 — 2026-07-21

- Removed the retired v0.1 workflow control plane, state, archives, approval
  objects, ledgers, and dead package closure.
- Added user-editable advisory `.cruise/FLIGHT.md` Goal envelopes and
  `.cruise/QUEUE.md` milestone queues.
- Added evidence-based bounded Goal supervision: native Codex Goal
  continuation and pause-on-stall, plus a fail-open Claude Code `Stop` hook.
- Added sequential `cruise queue status|run` execution and stable stalled exit
  code `3`.
- Added a live-host paired evaluation pilot with isolated fixtures, blinded
  grading artifacts, raw negative results, and explicit limitations.
- Reconciled the README, architecture, and limit policy with the shipped
  advisory design.
