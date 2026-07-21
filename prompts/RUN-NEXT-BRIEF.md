Execute the Cruise v0.3.1 hardening pipeline defined in prompts/RUN-NEXT.md.

That file is the authoritative orchestrator; the task specs are prompts/G-flight-self-heal.md, prompts/H-skill-template.md, prompts/I-bootstrap-liveness.md, and prompts/J-clean-rerun.md. Read RUN-NEXT.md in full before doing anything, and read each task spec in full immediately before starting that task. Where this summary and those files disagree, the files win.

Serial order on the current branch:
1. G — make present-but-unparseable FLIGHT.md loud and self-correcting in both supervisors; absent flight state stays inert.
2. H — embed the canonical FLIGHT.md template in the goal skill with a static drift-guard test.
3. I — add bootstrap breadcrumbs and a first-turn deadline so the Codex launcher can never hang silently.
— integration gate per RUN-NEXT.md —
4. J — pre-registered, isolated paired eval re-run producing a promote / iterate / kill / insufficient-evidence verdict.

Non-negotiable protocol (condensed from RUN-NEXT.md):
- Each of G/H/I ends with a falsification checkpoint: its red-team probe must demonstrably FAIL on pre-change code and PASS after; then a cold-context hostile review of the diff against the spec; then write docs/checkpoints/v0.3.1/CHECKPOINT-<task>.md and pass the standard gates (npm test, node scripts/cruise.mjs --help, claude plugin validate . when available). Commit before moving on.
- A checkpoint that cannot honestly complete fail-before/pass-after is a blocker: stop and report; do not proceed to J.
- J: commit PREREGISTRATION.md (criteria, run matrix, analysis plan) before any official run; verify sandboxed CODEX_HOME isolation with probe runs first; never patch G/H/I mid-study; never fabricate or extrapolate results — a partial-but-honest study labeled "insufficient evidence" is a success.
- Philosophy: supervision is evidence-based, bounded, fail-safe (every ladder ends in pause/allow-with-report); artifacts stay advisory; no authority state; fail-loud never means fail-blocking.

Finish with the final report format RUN-NEXT.md specifies.
