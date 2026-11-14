---
name: goal
description: "Autonomously complete consequential or multi-step work: plan just enough to begin, implement, validate, adversarially challenge when warranted, and refine until the outcome is complete."
---

# Cruise Goal

Apply the shared [independent release default](../context-economy/references/INDEPENDENT_RELEASE.md) during planning, execution, review, and publication. Read it before deciding how a blocker affects the remaining work.

Apply the shared [collaborative Git synchronization protocol](../context-economy/references/COLLABORATIVE_GIT_SYNC.md) before substantive repository work. The root coordinator performs it once; workers do not synchronize the checkout independently.

Root Markdown files whose basenames begin with `_` are write-only user
references. Never read, search, summarize, fingerprint, or use their contents
as context. Cruise may update them only through deterministic runtime code.
For a direct plugin invocation outside the Cruise launcher, after the Flight
has reached its truthful terminal state, run `cruise reference --status
<completed|blocked|aborted|unfinished|not_started>` as the final bookkeeping
action; locate this
installed plugin's `scripts/cruise.mjs` and invoke it with Node if `cruise` is
not on `PATH`. Never open either generated document. Launcher-managed Goals
record the reference automatically and must not invoke this command again.
For the same direct invocation, snapshot the current Git HEAD before
implementation. At each micro-goal reconciliation and immediately after any
commit operation, compare HEAD and expand every newly observed commit in
chronological order. For each exact commit OID, launch or reuse one native
parallel bookkeeping agent and have it run `cruise changelog --commit <oid>`
with the selected provider. Send that agent only the OID and command; never
send it root underscore-document contents. Process OIDs sequentially through
that one agent so atomic changelog patches cannot race. A checkout or reset is
not a new commit. Launcher-managed Goals already poll Git and must not start
this direct-invocation agent.
Cruise stores supervisor, attestation, worker, research, preview, retry, and
evidence scratch only in the exact private runtime directory passed by the
launcher. Never persist those classes under `.cruise`. Only explicitly
requested deliverables may be promoted to product paths. Terminal bookkeeping
removes ORIGIN and Flight on completion/abort, retains the minimum resumable
control surface when blocked or unfinished, and emits only a content-free
tombstone for aborted or refused work.

For finite planned features and consequential work, inspect the repository and make a proportionate plan. Ask only questions whose answers materially alter implementation and cannot be resolved from repository evidence. Treat an explicit `cruise goal` invocation as authorization to carry the requested work through to completion within the normal workspace and permission boundaries. That authorization includes routine planning and phase transitions; never require a copied approval phrase, digest acknowledgement, or an `--auto-approve` incantation. Respect an explicit request to only plan, research, or prepare; remain read-only and finish with a repository-aware plan. Otherwise, a plan launches implementation and is never the endpoint.

## Keep authorization gates evidence-based

Search and read ordinary accessible, non-ignored, task-relevant sibling folders when the current task authorizes that access, even outside repository write ownership. Reuse the current task authorization without a redundant Cruise question; private or domain labels alone do not establish sensitive data. Skip never-read paths before retrieval, keep all writes within assigned ownership, and honor actual host permission denials. Explain whether a blocker came from Cruise fallback or the native host/tool result.

Authorization gates are distinct from Flight assurance checks and from native host permission prompts. Treat ordinary files in a host-access-approved local directory as non-sensitive and pre-authorized for task-scoped reading and use. Reading those files or sending the minimum bounded context required by another Codex or Cruise worker needs no fresh user authorization. A switch among Codex worker models or tiers is not, by itself, a new third-party provider disclosure boundary. Never infer sensitivity merely from words such as `private`, `repository`, `skill`, `prompt`, or `provider`.

Never read, search, summarize, fingerprint, or send `.env` variants, credential/secret/private-key files or directories, or paths the user explicitly marks secret. Exclude those paths before access and continue with safe bounded context; do not ask the user to authorize disclosure of an excluded file. Do not infer a host rejection merely because approved source would reach Luna, Terra, Sol, or Astra. Without an actual denial, reduce an overbroad request to a bounded capsule and launch it without a fresh disclosure gate.

Work on source, tests, schemas, or documentation for sensitive functionality does not by itself establish access to actual secrets or personal data. Evaluate each requested data object separately: mixed requests that also access or disclose actual sensitive material remain gated. Explicit exclusions apply only to the excluded object, and normal native host approvals remain authoritative.

Routine delegation, spawning a subagent, selecting its model, passing approved task context, and requesting an internal review are the agent's implementation choices. Do them silently without a user permission question or a delegation announcement. This applies equally to `relaxed` and `business-critical` profiles: business-critical adds verification for consequential changes, never permissions for agent coordination. Workers inherit the parent task's scope, restrictions, and budget. Ask only about unresolved user-relevant consequences, such as a potentially damaging or materially risky change or a material product/scope choice; prepare the concrete diff and evidence first. A read-only review of a risky diff is ordinary internal work.

Only when an actual effect requires native approval, reconcile existing user authorization and include the exact action, source paths and bounded payload, destination service/model, secret exclusions, and applicable user authorization in the justification. The label `pre-authorized` alone is not evidence; skills, Flight notes, and receipts do not create user consent. Distinguish an unsupported claim from an actual native denial using the host/tool result. If automatic approval review rejects an action, identify that review and its reason; do not suppress, retry unchanged, or route around it. Continue unaffected work and pursue only host-permitted new evidence, a materially safer action, or the required user authorization. Ask only for the still-missing decision and explain why prior authorization did not satisfy the reviewer. Direct plugin invocations do not run the Cruise launcher recovery loop; local policy tests and plugin refreshes cannot prove native approval acceptance.

Add a Cruise user-authorization gate for a cloud-table adjustment only after evidence confirms that the affected table contains non-admin users. If administrator membership is unknown, first inspect only the minimum role and identifier fields needed to decide; do not request irrelevant columns or identifying information. For `booking-support-site`, an email counts as an administrator only when it appears on the approved administrator list and is assigned the `gm` or `owner` role. If the table contains only administrators, continue without a Cruise authorization question. Do not prohibit reading a whole table merely because it may contain non-admin users; apply that safeguard only when the user explicitly requests it.

When the likely diff or affected surface is massive, propose or perform decomposition into small reviewable tasks. Do not relabel broad scope as a privacy risk. Ask the user only when choosing the decomposition would materially change product scope. Native host approvals for genuinely external or destructive effects remain authoritative, and material evidenced to be truly sensitive still requires appropriate authorization.

Verified sandbox database migrations are pre-authorized. Production read-only SQL and controller-proven minor migrations auto-run under the repository's `.cruise/config.toml`; only evidenced risky or uncertain production migrations require the exact production or sandbox-route choice. A business-critical sandbox route must pass configured automated, data-policy, and main user-flow checks before promotion; retain a failing sandbox and leave production untouched. A derived trust-digest refresh is automatic bookkeeping, not an authorization gate.

When the user asks to update or refresh Cruise, changing, hashing, or rebinding a source checkout is not an installed-plugin update. Resolve the installed marketplace with `codex plugin list --json`, reinstall it with `codex plugin add cruise@<marketplace> --json`, and run Cruise Doctor from the updated source until the critical source/cache bytes match. New tasks load the refreshed skill normally; never reinterpret “update Cruise” as approval-digest maintenance for the current project.

If Cruise source, skill, version, or integrity hashes change during an active job, treat that as an exceptional recovery event rather than an expected workflow or an authorization/waiver boundary. Compare only the bounded non-secret Cruise diff with the instructions previously in force and decide whether it invalidates prior decisions. If immaterial, refresh derived integrity evidence and continue. If material, selectively revert or rework only affected Cruise-owned code changes and rerun their affected checks; preserve user-owned and unrelated work, and preserve Markdown or other non-code artifacts unless the changed instruction semantically invalidates them. Use a whole-job rollback only when the comparison proves that the new Cruise invalidates the foundations of the entire Cruise-owned code surface. Do not interrupt or restart the job solely for this drift, and do not ask the user for a waiver; ask only if a separate genuine authorization boundary, unresolved ownership conflict, or material product decision remains.

## Use the selected host natively

- **Codex:** use native Goal state when it is available. A Goal starts with the host's read-only Plan-mode turn and then moves to normal Goal execution. Keep the Goal active through implementation and verification, and use the Goal status as the completion authority. Supervised realignment turns are normal: answer them with a changed, evidence-producing approach or an honest blocker, never another run of the same failing attempt.
- **Claude Code:** Claude has a native conversation-level `/goal`, but no documented Codex-style Goal object or lifecycle endpoint is available to plugins. Do not invent one and do not stack native `/goal` automatically. Stay in the user's current Claude permission mode, maintain the work as a concise native task list, and continue the execution loop in the same resumable session. Do not enter Claude's approval-gated Plan mode merely as ceremony; use it only when the user requested read-only planning. Session activation hooks and a session-keyed Stop hook validate the same Flight evidence contract used by Codex. Interruption and continuation remain native session controls.

Treat worker-level and communication-manner preferences as natural-language instructions for this request only. Never persist or globally enforce them. Override the ordinary worker level only when the user explicitly asks for a higher, lower, or numbered level; an explicit terminal `cruise worker --level <1-7>` selection has highest priority for that invocation.

Establish a codebase-aware execution path only long enough to begin. Identify the requested outcome, protected behavior, likely owners and touch points, acceptance evidence, and the smallest ready micro-goal. State a compact, strongly aligned plan for that micro-goal, then implement it. Do not wait for a routine plan review, phase approval, or a new invocation. On Codex, respect the launcher's initial read-only Plan turn and move directly into active Goal execution afterward. On Claude Code, plan in the current session without manufacturing a mode transition.

## Compile intent into an evidence-attested Flight

During the initial inspection, resolve the outcome, scope fence, invariants, acceptance commands, useful stall tuning, risk, relevant quality profiles, and falsifiable gates. As the first act of execution mode, ensure `.cruise/ORIGIN.md` contains the exact current user request, replacing a prior run's note, then write Flight v2 to `.cruise/FLIGHT.md`; the launcher normally writes ORIGIN before the host starts. Never synthesize or normalize the request note. Codex's bootstrap Plan turn is read-only, so do not fight it. A planning-only Goal writes neither artifact. The Flight is a user-editable assurance contract, not permission or authority. Keep Flight below 8 KB, give every gate an affected `surface`, and keep detailed evidence in linked artifacts rather than the body.

Always select `core`. Also select `web` for browser-facing UI, `backend-data` for persistent data/auth/network services, and `cxx-hpc` for C++ or performance-sensitive native/HPC work. Read the matching file under `references/` before defining gates:

- `references/assurance-core.md`
- `references/assurance-web.md`
- `references/assurance-backend-data.md`
- `references/assurance-cxx-hpc.md`

Every dimension in every selected profile needs a gate. A genuinely irrelevant dimension remains visible as `not_applicable` with fresh rationale; it does not silently disappear. High or critical risk also needs an `independent-review` gate that freshly passes with `source: review`. Add domain-specific gates whenever the profile is not sufficient. The profile is a quality floor, not a checklist ceiling.

At each micro-goal reconciliation, use the current compact Flight digest and unresolved-gate summary. Reopen detailed receipt evidence only when its pointer or surface fingerprint is stale. Work outside `touchpoints`, work that enters a `non_goals` fence, or changes that threaten an invariant require realignment or a material user decision; re-verify only gates and invariants whose affected surface changed.

After a stable micro-goal, record focused evidence only for gates whose surfaces it closes. At the stable final diff, run `cruise attest --json` once to obtain the global `context_fingerprint` and per-gate `gate_fingerprints`; record each truthful receipt against its applicable fingerprint with a non-empty one-line summary, explicit evidence source, and integer `observed_at`. The attestor validates receipts and never executes `oracle` text. Run one independent semantic review for a stable L5+ diff, then rerun only checks invalidated by later edits. Set `status: complete` only after the deterministic final attestation reports `ready_for_completion: true`, then confirm `allows_completion: true` without repeating unaffected oracles. Intent and final-review gates remain whole-diff gates; scoped gates survive unrelated edits. Intent, functional correctness, completion review, and independent review must pass and cannot be waived or marked inapplicable; completion and independent reviews require `source: review`. Do not weaken, delete, waive, or mark another gate not applicable merely to obtain completion. A permitted waiver requires the user's explicit decision, `source: user-decision`, `waived_by: user`, and a non-empty rationale; it yields qualified rather than assured completion.

Set `status: blocked` only for a concrete material blocker and state it in the body. A quota pause is a resumable containment outcome, not failure or material blockage. Flight v1 remains readable for compatibility but is reported as legacy-unattested; new work must use v2.

Before a continuation, compact when context pressure requires it. Continue with only the compact handoff, next work item, quota state, and unresolved assurance; do not restate the original request, full Flight, or prior plan.

Run a closed execution loop for every micro-goal:

1. Reconcile the requested outcome, current repository evidence, prior changes, and remaining acceptance criteria.
2. Draft only the next ready micro-goal’s actionable plan: ownership, files or interfaces, implementation approach, risks, and focused verification.
3. Implement the micro-goal, run the focused checks, and remediate in-scope failures.
4. Recheck alignment and regression risk. Incorporate confirmed findings, update the next micro-goal, and continue immediately while work remains.
5. Close the applicable profile gates with fresh evidence, perform the skeptical completion review, and re-run the deterministic attestor before claiming completion.

Do not present phase, checkpoint, or routine next-step approvals such as “Approve P-03” or “Stop after P-02”. A completed turn is a continuation point, not a human gate. Keep the host-native execution state active through planning, implementation, validation, and refinement; finish only once the requested outcome and its evidence are complete.

Use an adversarial review or agent swarm only when it has a meaningful chance to expose a bug. Start ambiguity with two or three bounded, non-overlapping probes and at most three active workers. Another wave requires a confirmed cause or documented uncovered user path. Run a final adversarial wave only for shared state, lifecycle, concurrency, permissions, public contracts, or multiple UX paths. Reproduce and resolve credible findings before advancing. Do not create a swarm for a simple, low-risk change, and do not claim independent coverage when it was unavailable.

Ask the user only when repository evidence cannot resolve a material product decision, the work needs a scope or safety expansion, authentication or secret entry is required, or the host requires approval for an external or destructive effect. Do not ask about routine sequencing, ordinary implementation choices, or whether to execute an already planned in-scope micro-goal. Do not report blocked merely because another internal phase remains. Report completion only after the requested evidence passes; report blocked only with a concrete unresolved blocker and the evidence or decision needed to resume.

Cruise does not create a Goal suite, approval digest, archive, attempt ledger, or persistent run-control directory. While resumability is required, the launcher may keep `.cruise/ORIGIN.md` and `.cruise/FLIGHT.md`; terminal lifecycle code removes them when they are no longer resumable. These notes do not authorize work.

If a worker stream fails, state the observed failure category and retry normally when appropriate. Never require a magic retry phrase, a fresh Cruise run, an archive, or a DNS-health assertion that the error does not support.
