# Specification: Object-store migration

- Planning state: Approved (inactive)
- Current slice: G-01

## Requirements

- R-01: Every object written to the legacy store exists byte-identically in the new store before consumer cutover.

## Acceptance criteria

- AC-01: Reconciliation reports zero missing or mismatched objects for the approved snapshot.
