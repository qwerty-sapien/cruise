# Six-skill blind routing forward test — 2026-07-13

- Evaluator context: fresh subagent with no parent-turn context
- Allowed inputs: the six public `SKILL.md` files and `internal/shared/invocation-contract.md`
- Forbidden inputs: eval fixtures, tests, README, objective attachment, and git history
- Repository writes: none
- Cases: 11 required mutual-exclusivity/boundary prompts
- Result: 11/11 expected route or staged handoff outcomes

| Case | Blind result | Boundary observed |
| --- | --- | --- |
| Fix README typo | Quick | Focused documentation diff only |
| Remove private helper/two callers | Quick, conditional | Caller closure must be proven; dynamic/indirect evidence promotes before edit |
| Remove exported downstream-plugin method | Goal | Public/cross-system compatibility rejects Quick |
| OAuth login, migration, rollout | Goal | Auth, migration, rollout, and recovery are consequential |
| Finite admin export with format/auth questions | Refine | Known finite outcome, bounded material decisions, one Plan approval |
| Intermittent test hang | Debug | Unknown cause requires hypotheses and discriminating experiments |
| Correctness/security PR assessment | Native Codex/GitHub review | Findings are read-only; no implicit fixes |
| Compare cell-tracking approaches | Research | Evidence/recommendation first; no product edits |
| Implement research recommendation | Refine, Goal if consequence grows | Explicit implementation handoff; never remain Research |
| Review and fix all issues | Native review first | Findings delivered before a new explicit Cruise remediation request |
| Broken feature; improve UX | Debug then Refine | Reproducible defect and desired product behavior are separate epistemic problems |

The blind evaluator identified soft language thresholds between Quick/Refine and Refine/Goal. The shared deterministic gates resolve those thresholds: unresolved material choices reject Quick, while bounded finite authorization decisions may remain Refine and cross-system/durable consequence promotes to Goal. No pair was operationally indistinguishable after applying those gates.
