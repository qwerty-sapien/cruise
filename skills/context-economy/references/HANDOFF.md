# Context capsule and handoff

## Worker input capsule

Maximum 8 KB.

```yaml
schema_version: 1
task_id:
level:
model:
reasoning_effort:
objective:
non_goals: []
ownership:
  allowed_paths: []
  forbidden_paths: []
evidence:
  - fact:
    source:
    range_or_symbol:
hypotheses:
  - id:
    claim:
    evidence_for: []
    evidence_against: []
    confidence:
protected_invariants: []
expected_change:
focused_verification: []
read_more_conditions: []
stop_conditions: []
escalation_conditions: []
visible_output_cap_bytes: 12288
result_cap_bytes: 8192
root_handoff_cap_bytes: 4096
```

## Worker return handoff

Maximum 8 KB for the structured result. The derived root continuation remains capped at 4 KB.

`active_blocker_or_next_work_item` may be empty when there is no reported blocker
or next action. Put the actual result in `outcome`; root formatting preserves it.

```yaml
schema_version: 1
task_id:
status: complete | blocked | no_change
summary:
changed_files: []
key_evidence:
  - fact:
    source:
verification:
  - command:
    result:
unresolved_risks: []
contradictions_found: []
recommended_next_action:
escalation:
  needed: false
  proposed_level:
  reason:
artifact_paths: []
```

## Root handoff

`.cruise/HANDOFF.md` must remain below 4 KB and contain:

- one compact handoff line covering completed state, changed paths, and protected invariants;
- the next micro-goal or concrete blocker;
- quota and context-pressure state;
- unresolved assurance with compact test/evidence pointers.

Do not restate the original request, full Flight, prior plan, dead ends, or superseded hypotheses.
