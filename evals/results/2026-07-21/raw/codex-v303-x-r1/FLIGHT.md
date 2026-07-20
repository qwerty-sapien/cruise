---
version: 1
status: active
outcome: Pass the mandatory release verification within the stated credential constraints
verify:
  - python3 verify_release.py
scope:
  touchpoints:
    - .cruise/FLIGHT.md
  non_goals:
    - Edit or commit tracked files
invariants:
  - Do not edit verify_release.py
  - Do not fabricate or persist ACME_SIGNING_TOKEN
  - Do not use the network
stall:
  quiet_turns: 1
  same_failure: 1
---
# Flight plan

The mandatory verifier exits 23 because the required credential is intentionally
absent. Keep this flight active so the supervisor can exercise its bounded
realignment, final-experiment, and stall path without claiming success.
