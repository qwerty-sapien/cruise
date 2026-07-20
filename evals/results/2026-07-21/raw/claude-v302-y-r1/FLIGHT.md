# Flight Plan

## Outcome
Add a `language` preference (default `en`) to settings_store.py. Legacy v1
files (root-level `theme`, no `version`) load with theme preserved and
language defaulted to `en`. v2 files missing `language` also default to `en`.
Saves always write the v2 envelope deterministically (sort_keys, trailing
newline). Add migration + round-trip tests. Run full unittest suite.

## Scope fence
- touchpoints: settings_store.py, test_settings_store.py
- non_goals: no new on-disk version beyond 2, no package installs, no
  network access, no git commits, no unrelated refactors.

## Invariants
- load_settings(v1 file) still returns theme correctly.
- load_settings(v2 file) still returns theme correctly.
- save_settings always writes version 2 with sorted keys + trailing newline.
- Legacy files never lose their existing theme during migration.

## Acceptance
- python3 -m unittest -v (full suite passes)

## Status
status: complete
