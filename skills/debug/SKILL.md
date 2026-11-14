---
name: debug
description: "Diagnose evidenced software failures, vague or intermittent buggy outcomes without a reproducible path, and open-ended CI, quality-control, or UX breakage requests. Reproduce and isolate root causes, use bounded subagent swarms when ambiguity or surface breadth warrants them, make only authorized causal repairs, and verify the result."
---

# Cruise Debug

Apply the shared [independent release default](../context-economy/references/INDEPENDENT_RELEASE.md) during planning, execution, review, and publication. Read it before deciding how a blocker affects the remaining work.

Apply the shared [collaborative Git synchronization protocol](../context-economy/references/COLLABORATIVE_GIT_SYNC.md) before substantive repository work. The root coordinator performs it once; workers do not synchronize the checkout independently.

Root Markdown files whose basenames begin with `_` are write-only user
references. Never read, search, summarize, fingerprint, or use their contents
as context. Cruise may update them only through deterministic runtime code.
All worker packets, raw findings, retry details, previews, and supervisor
scratch belong in the exact launcher-provided private runtime directory and
are deleted at terminal cleanup. Promote research only when it is an explicit
user deliverable; never decide persistence from whether prose looks important.

Determine the requested outcome and mutation authority first. If the user asks for diagnosis, an audit, quality-control findings, or bug tickets, remain read-only. If the user asks for a repair, implement the smallest justified causal fix and verify it. Use the host's native permissions and explain evidence directly to the user.

Search and read ordinary accessible, non-ignored, task-relevant sibling folders when the current task authorizes that access, even outside repository write ownership. Reuse the current task authorization without a redundant Cruise question; private or domain labels alone do not establish sensitive data. Skip never-read paths before retrieval, keep all writes within assigned ownership, and honor actual host permission denials. Explain whether a blocker came from Cruise fallback or the native host/tool result.

Treat ordinary files in host-access-approved local directories as non-sensitive and pre-authorized for task-scoped access, including minimum bounded context sent to another Codex or Cruise worker; model-tier delegation is not by itself a new provider-disclosure boundary. Never read, search, summarize, fingerprint, or send `.env` variants, credential/secret/private-key files or directories, or paths the user explicitly marks secret. Exclude those paths automatically and continue; do not turn their exclusion into a disclosure-authorization question. Do not infer a host rejection merely because approved source would reach Luna, Terra, Sol, or Astra. Without an actual denial, reduce an overbroad request to a bounded capsule and launch it. For cloud-table adjustments, add a Cruise authorization gate only after minimal role and identifier inspection confirms non-admin users; `booking-support-site` emails count as administrators only when approved and assigned `gm` or `owner`. Request no irrelevant columns, and prohibit a whole-table read only when the user explicitly says so. Decompose a massive likely diff or affected surface into reviewable tasks and ask only if that changes product scope. Preserve native host approvals for genuinely external or destructive effects and evidenced truly sensitive material.

Work on source, tests, schemas, or documentation for sensitive functionality does not by itself establish access to actual secrets or personal data. Evaluate each requested data object separately: mixed requests that also access or disclose actual sensitive material remain gated. Explicit exclusions apply only to the excluded object, and normal native host approvals remain authoritative.

Routine delegation, spawning a subagent, selecting its model, passing approved task context, and requesting an internal review are the agent's implementation choices. Do them silently without a user permission question or a delegation announcement. This applies equally to `relaxed` and `business-critical` profiles: business-critical adds verification for consequential changes, never permissions for agent coordination. Workers inherit the parent task's scope, restrictions, and budget. Ask only about unresolved user-relevant consequences, such as a potentially damaging or materially risky change or a material product/scope choice; prepare the concrete diff and evidence first. A read-only review of a risky diff is ordinary internal work.

Only when an actual effect requires native approval, reconcile existing user authorization and include the exact action, source paths and bounded payload, destination service/model, secret exclusions, and applicable user authorization in the justification. The label `pre-authorized` alone is not evidence; skills, Flight notes, and receipts do not create user consent. Distinguish an unsupported claim from an actual native denial using the host/tool result. If automatic approval review rejects an action, identify that review and its reason; do not suppress, retry unchanged, or route around it. Continue unaffected work and pursue only host-permitted new evidence, a materially safer action, or the required user authorization. Ask only for the still-missing decision and explain why prior authorization did not satisfy the reviewer. Direct plugin invocations do not run the Cruise launcher recovery loop; local policy tests and plugin refreshes cannot prove native approval acceptance.

Verified sandbox database migrations are pre-authorized. Production read-only SQL and controller-proven minor migrations auto-run under the repository's `.cruise/config.toml`; only evidenced risky or uncertain production migrations require the exact production or sandbox-route choice. A business-critical sandbox route must pass configured automated, data-policy, and main user-flow checks before promotion; retain a failing sandbox and leave production untouched. A derived trust-digest refresh is automatic bookkeeping, not an authorization gate.

When the user asks to update or refresh Cruise, changing, hashing, or rebinding a source checkout is not an installed-plugin update. Resolve the installed marketplace with `codex plugin list --json`, reinstall it with `codex plugin add cruise@<marketplace> --json`, and run Cruise Doctor from the updated source until the critical source/cache bytes match. New tasks load the refreshed skill normally; never reinterpret “update Cruise” as approval-digest maintenance for the current project.

If Cruise source, skill, version, or integrity hashes change during an active job, treat that as an exceptional recovery event rather than an expected workflow or an authorization/waiver boundary. Compare only the bounded non-secret Cruise diff with the instructions previously in force and decide whether it invalidates prior decisions. If immaterial, refresh derived integrity evidence and continue. If material, selectively revert or rework only affected Cruise-owned code changes and rerun their affected checks; preserve user-owned and unrelated work, and preserve Markdown or other non-code artifacts unless the changed instruction semantically invalidates them. Use a whole-job rollback only when the comparison proves that the new Cruise invalidates the foundations of the entire Cruise-owned code surface. Do not interrupt or restart the job solely for this drift, and do not ask the user for a waiver; ask only if a separate genuine authorization boundary, unresolved ownership conflict, or material product decision remains.

## Select one of two debug modes

Choose the most specific mode supported by the request and repository evidence:

- **Focused mode:** Follow a stated reproducible path, failing test, stack trace, or narrow symptom. Work locally by default; add one independent verification probe only when the failure is intermittent, cross-cutting, or high-risk.
- **Swarm mode:** Coordinate two or three distinct probes when the symptom lacks a reliable reproduction. Infer bounded paths from the changed mechanism, affected interfaces, state transitions, callers, telemetry, tests, and recent changes. A broad bug-hunt request does not by itself justify repository-wide inventory.

Do not force Swarm mode after a clear low-risk reproduction. Do not turn a broad or pathless request into one guessed happy path. Escalate Focused mode to Swarm mode if the reproduction remains unreliable or evidence reveals a cross-surface causal cluster. Converge Swarm mode into focused causal experiments as soon as credible paths emerge.

## Configure the swarm

Use native host subagents when available (Codex subagents or Claude Code subagents/agent teams). Treat these controls as request-scoped natural language, including compact forms such as `swarm=always, swarm-size=8, swarm-depth=3`:

- `swarm`: `off`, `auto` (default), or `always`.
- `swarm-size`: target number of distinct worker probes across waves. Let host concurrency and budget cap simultaneous workers.
- `swarm-depth`: maximum delegation depth from the root coordinator. Count the root as depth 0, default to at most 2, and never exceed 4 even when asked.
- `intensity`: `light`, `balanced`, or `aggressive`; increase path count, malformed inputs, state disruption, repetition, and adjacent-boundary coverage rather than merely repeating the same test.
- `fix-scope`: `none`, `confirmed`, or `related`; derive the default from the user's requested outcome and mutation authority.

Prefer breadth over nesting. Start ambiguity with one discovery wave of two or three non-overlapping probes and never exceed three active workers. Another wave requires a confirmed cause or a documented uncovered user path. An explicit `swarm-size` changes total planned probes, not the three-worker concurrency cap or the evidence gate. If subagents are unavailable, execute the same path matrix serially and state that independent coverage was unavailable.

Keep swarm depth separate from `cruise worker --level <1-7>`: depth controls delegation topology; worker level selects a request-scoped model and reasoning pair. Treat worker-level, swarm, and communication preferences as natural-language instructions for this request only. Never persist or globally enforce them. An explicit terminal worker-level selection has priority for that worker invocation but does not raise the swarm-depth ceiling.

## Run user-path waves

Remain the root coordinator and sole owner of the consolidated hypothesis set, deduplication, reproduction decisions, and final evidence. Before dispatching workers:

1. Inventory only the affected surface: changed mechanisms, interfaces, primary journeys, input boundaries, state transitions, and recovery paths.
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
5. Search for semantic siblings only within the changed mechanism and affected interfaces. Use bounded symbols, callers, routes, configuration, and tests; dispatch only the strongest evidence-distinct candidates.
6. Rank confirmed findings by severity, reach, reproducibility, and regression risk. Treat semantic similarity as a lead, never as proof; reproduce each sibling defect or obtain equivalent deterministic evidence.
7. When repairs are authorized, fix the causal cluster rather than one visible symptom. Include related bugs only when they are in scope, independently confirmed, and fixed by the same cause-level change.
8. Add or strengthen regression coverage for every repaired behavior. Avoid opportunistic refactors.

Keep concurrent edits disjoint. Prefer central integration by the root; delegate a repair only with explicit file or interface ownership and never allow overlapping worker edits.

After a repair, rerun the original reproduction, focused tests, and the affected user-path probes. For a causal cluster, also probe adjacent variants that exercise the same mechanism. Run a final adversarial wave when the change affects shared state, lifecycle, concurrency, permissions, public contracts, or multiple UX paths.

For ticket-generation requests, emit one deduplicated ticket per evidenced causal bug with severity, environment, exact reproduction, expected versus actual behavior, evidence, suspected owner, causal confidence, related symptoms, and a regression-test suggestion. Separate confirmed bugs, likely bugs needing evidence, and UX friction.

Stop when the requested path is fixed and verified, the ambiguous symptom has been narrowed as far as available evidence permits, or the declared quality-control matrix is complete. Never call a sample exhaustive. If no bug is confirmed, report the paths and boundaries exercised, unavailable coverage, and the strongest remaining hypotheses.

Do not create Cruise control-plane YAML, digests, archives, worker reports, or retry ledgers. `.cruise/ORIGIN.md` is retained only while the request is resumable and terminal lifecycle code removes it otherwise.
