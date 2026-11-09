---
name: goal
description: "Autonomously complete consequential or multi-step work: plan just enough to begin, implement, validate, adversarially challenge when warranted, and refine until the outcome is complete."
---

# Cruise Goal

Apply the shared [collaborative Git synchronization protocol](../context-economy/references/COLLABORATIVE_GIT_SYNC.md) before substantive repository work. The root coordinator performs it once; workers do not synchronize the checkout independently.

For finite planned features and consequential work, inspect the repository and make a proportionate plan. Ask only questions whose answers materially alter implementation and cannot be resolved from repository evidence. Treat an explicit `cruise goal` invocation as authorization to carry the requested work through to completion within the normal workspace and permission boundaries. That authorization includes routine planning and phase transitions; never require a copied approval phrase, digest acknowledgement, or an `--auto-approve` incantation. Respect an explicit request to only plan, research, or prepare; remain read-only and finish with a repository-aware plan. Otherwise, a plan launches implementation and is never the endpoint.

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

Cruise does not create a Goal suite, approval digest, archive, attempt ledger, or run-control directory. The launcher may write `.cruise/ORIGIN.md` containing exactly the request; it is a note only and does not authorize work.

If a worker stream fails, state the observed failure category and retry normally when appropriate. Never require a magic retry phrase, a fresh Cruise run, an archive, or a DNS-health assertion that the error does not support.
