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
handoff_cap_bytes: 4096
```

## Worker return handoff

Maximum 4 KB.

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

- original outcome in one sentence;
- completed work;
- changed paths;
- current decisions and invariants;
- exact tests and results;
- active blocker or next micro-goal;
- files that need not be reread;
- pointers to detailed evidence;
- token and quota status.

Remove dead ends, repeated explanations, and superseded hypotheses.
