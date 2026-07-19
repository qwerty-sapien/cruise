---
name: debug
description: "Diagnose evidenced software failures, vague or intermittent buggy outcomes without a reproducible path, and open-ended CI, quality-control, or UX breakage requests. Reproduce and isolate root causes, use bounded subagent swarms when ambiguity or surface breadth warrants them, make only authorized causal repairs, and verify the result."
---

# Cruise Debug

Determine the requested outcome and mutation authority first. If the user asks for diagnosis, an audit, quality-control findings, or bug tickets, remain read-only. If the user asks for a repair, implement the smallest justified causal fix and verify it. Use normal Codex permissions and explain evidence directly to the user.

## Select one of two debug modes

Choose the most specific mode supported by the request and repository evidence:

- **Focused mode:** Follow a stated reproducible path, failing test, stack trace, or narrow symptom. Work locally by default; add one independent verification probe only when the failure is intermittent, cross-cutting, or high-risk.
- **Swarm mode:** Coordinate multiple distinct user-path probes when the symptom lacks a reliable reproduction or the user requests a general debug, bug hunt, CI pass, quality-control pass, or aggressive attempt to break the product. For a reported symptom, infer plausible paths from routes, commands, state transitions, callers, telemetry, tests, and recent changes. For an open-ended request, inventory the reachable UX surface and run adversarial waves across it.

Do not force Swarm mode after a clear low-risk reproduction. Do not turn a broad or pathless request into one guessed happy path. Escalate Focused mode to Swarm mode if the reproduction remains unreliable or evidence reveals a cross-surface causal cluster. Converge Swarm mode into focused causal experiments as soon as credible paths emerge.

## Configure the swarm

Use native Codex subagents when available. Treat these controls as request-scoped natural language, including compact forms such as `swarm=always, swarm-size=8, swarm-depth=3`:

- `swarm`: `off`, `auto` (default), or `always`.
- `swarm-size`: target number of distinct worker probes across waves. Let host concurrency and budget cap simultaneous workers.
- `swarm-depth`: maximum delegation depth from the root coordinator. Count the root as depth 0, default to at most 2, and never exceed 4 even when asked.
- `intensity`: `light`, `balanced`, or `aggressive`; increase path count, malformed inputs, state disruption, repetition, and adjacent-boundary coverage rather than merely repeating the same test.
- `fix-scope`: `none`, `confirmed`, or `related`; derive the default from the user's requested outcome and mutation authority.

Prefer breadth over nesting. For an ambiguous symptom, default to one discovery wave of two or three non-overlapping probes. For exploratory quality control, default to two waves that each use every safely available subagent slot, and default to aggressive coverage; add another wave only when a confirmed cause opens a bounded semantic-sibling search or material planned coverage remains. Let an explicit `swarm-size` or intensity request replace these defaults. If subagents are unavailable, execute the same path matrix serially and state that independent coverage was unavailable.

Keep swarm depth separate from `cruise worker --level <1-7>`: depth controls delegation topology; worker level selects a request-scoped model and reasoning pair. Treat worker-level, swarm, and communication preferences as natural-language instructions for this request only. Never persist or globally enforce them. An explicit terminal worker-level selection has priority for that worker invocation but does not raise the swarm-depth ceiling.

## Run user-path waves

Remain the root coordinator and sole owner of the consolidated hypothesis set, deduplication, reproduction decisions, and final evidence. Before dispatching workers:

1. Inventory the relevant surface: entry points, primary journeys, roles, input boundaries, state transitions, recovery paths, integrations, and platform variants.
2. Build a non-overlapping probe matrix. Cover representative normal use plus malformed or extreme input, interruption and recovery, repeated actions, stale state, permissions, concurrency or ordering, upgrade or compatibility boundaries, and accessibility when relevant.
3. Give each worker a bounded persona or user path, explicit preconditions, an observable success oracle, safe isolation requirements, and a prohibition on claiming bugs without evidence.

Keep discovery workers read-only with respect to product and repository state by default. Permit tests to create disposable fixtures and outputs only in isolated temporary directories when the user's constraints allow filesystem effects; clean them up through ordinary safe mechanisms. If the user forbids all file writes, avoid even temporary fixtures. Use isolated accounts or local/test environments, and never perform destructive adversarial testing against production or shared user data without explicit authority and the required approval.

Require each worker to return a compact finding containing the exact path and inputs, expected and actual behavior, reproducibility, raw evidence, affected surface, likely owner, causal hypothesis with confidence, and nearby paths that may share the cause. Continue useful sibling probes when one worker fails; retry only when the failure mode supports it.

Set a time or action budget and completion criterion for every probe and wave. Ask a slow worker to wrap up once; if it still makes no progress, interrupt it, consolidate the completed evidence, and record the missing coverage. Do not let one worker hold the whole swarm open indefinitely.

## Converge on causes and repairs

For every candidate bug:

1. Reproduce it independently or obtain equivalent deterministic evidence.
2. Maintain competing hypotheses and run the smallest discriminating experiment.
3. Cluster symptoms only when evidence supports the same causal mechanism; do not merge findings merely because their output looks similar.
4. Derive a causal signature from the confirmed defect: the violated invariant, faulty state transition, error pattern, API misuse, data-flow shape, call-chain role, or missing boundary check.
5. Search the codebase for semantic siblings that play the same role or implement the same pattern, even when names and exact text differ. Use symbols, callers, routes, interfaces, configuration, tests, and repository search or code-index tools as available. Dispatch the strongest sibling candidates as distinct probes.
6. Rank confirmed findings by severity, reach, reproducibility, and regression risk. Treat semantic similarity as a lead, never as proof; reproduce each sibling defect or obtain equivalent deterministic evidence.
7. When repairs are authorized, fix the causal cluster rather than one visible symptom. Include related bugs only when they are in scope, independently confirmed, and fixed by the same cause-level change.
8. Add or strengthen regression coverage for every repaired behavior. Avoid opportunistic refactors.

Keep concurrent edits disjoint. Prefer central integration by the root; delegate a repair only with explicit file or interface ownership and never allow overlapping worker edits.

After a repair, rerun the original reproduction, focused tests, and the affected user-path probes. For a causal cluster, also probe adjacent variants that exercise the same mechanism. Run a final adversarial wave when the change affects shared state, lifecycle, concurrency, permissions, public contracts, or multiple UX paths.

For ticket-generation requests, emit one deduplicated ticket per evidenced causal bug with severity, environment, exact reproduction, expected versus actual behavior, evidence, suspected owner, causal confidence, related symptoms, and a regression-test suggestion. Separate confirmed bugs, likely bugs needing evidence, and UX friction.

Stop when the requested path is fixed and verified, the ambiguous symptom has been narrowed as far as available evidence permits, or the declared quality-control matrix is complete. Never call a sample exhaustive. If no bug is confirmed, report the paths and boundaries exercised, unavailable coverage, and the strongest remaining hypotheses.

Do not create Cruise control-plane YAML, digests, archives, worker reports, or retry ledgers. Keep only the launcher-managed `.cruise/ORIGIN.md` request note.
