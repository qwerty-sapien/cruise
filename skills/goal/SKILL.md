---
name: goal
description: "Autonomously complete consequential or multi-step work: plan just enough to begin, implement, validate, adversarially challenge when warranted, and refine until the outcome is complete."
---

# Cruise Goal

When delegating or continuing delegated work, read [native collaboration and context handoffs](references/agent-context.md). Use native peer messages to coordinate ownership and alignment. Never compact subagents; resume only the same agent/session’s latest checkpoint unless an explicit human instruction overrides this boundary. These standing context rules persist across requests.

For finite planned features and consequential work, inspect the repository and make a proportionate plan. Ask only questions whose answers materially alter implementation and cannot be resolved from repository evidence. Treat an explicit `cruise goal` invocation as authorization to carry the requested work through to completion within the normal workspace and permission boundaries. That authorization includes routine planning and phase transitions; never require a copied approval phrase, digest acknowledgement, or an `--auto-approve` incantation. Respect an explicit request to only plan, research, or prepare; remain read-only and finish with a repository-aware plan. Otherwise, a plan launches implementation and is never the endpoint.

## Use the selected host natively

- **Codex:** use native Goal state when it is available. A Goal starts with the host's read-only Plan-mode turn and then moves to normal Goal execution. Keep the Goal active through implementation and verification, and use the Goal status as the completion authority. Supervised realignment turns are normal: answer them with a changed, evidence-producing approach or an honest blocker, never another run of the same failing attempt.
- **Claude Code:** Claude has a native conversation-level `/goal`, but no documented Codex-style Goal object or lifecycle endpoint is available to plugins. Do not invent one and do not stack native `/goal` automatically. Stay in the user's current Claude permission mode, maintain the work as a concise native task list, and continue the execution loop in the same resumable session. Do not enter Claude's approval-gated Plan mode merely as ceremony; use it only when the user requested read-only planning. Session activation hooks and a session-keyed Stop hook validate the same Flight evidence contract used by Codex. Interruption and continuation remain native session controls.

Treat worker-level and request-specific communication-manner preferences as natural-language instructions for this request only. Never persist or globally enforce them. Override the ordinary worker level only when the user explicitly asks for a higher, lower, or numbered level; an explicit terminal `cruise worker --level <1-7>` selection has highest priority for that invocation.

Establish a codebase-aware execution path only long enough to begin. Identify the requested outcome, protected behavior, likely owners and touch points, acceptance evidence, and the smallest ready micro-goal. State a compact, strongly aligned plan for that micro-goal, then implement it. Do not wait for a routine plan review, phase approval, or a new invocation. On Codex, respect the launcher's initial read-only Plan turn and move directly into active Goal execution afterward. On Claude Code, plan in the current session without manufacturing a mode transition.

## Compile intent into an evidence-attested Flight

During the initial inspection, resolve the outcome, scope fence, invariants, acceptance commands, useful stall tuning, risk, relevant quality profiles, and falsifiable gates. As the first act of execution mode, ensure `.cruise/ORIGIN.md` contains the exact current user request, replacing a prior run's note, then write Flight v2 to `.cruise/FLIGHT.md`; the launcher normally writes ORIGIN before the host starts. Never synthesize or normalize the request note. Codex's bootstrap Plan turn is read-only, so do not fight it. A planning-only Goal writes neither artifact. The Flight is a user-editable assurance contract, not permission or authority.

Always select `core`. Also select `web` for browser-facing UI, `backend-data` for persistent data/auth/network services, and `cxx-hpc` for C++ or performance-sensitive native/HPC work. Read the matching file under `references/` before defining gates:

- `references/assurance-core.md`
- `references/assurance-web.md`
- `references/assurance-backend-data.md`
- `references/assurance-cxx-hpc.md`

Every dimension in every selected profile needs a gate. A genuinely irrelevant dimension remains visible as `not_applicable` with fresh rationale; it does not silently disappear. High or critical risk also needs an `independent-review` gate that freshly passes with `source: review`. Add domain-specific gates whenever the profile is not sufficient. The profile is a quality floor, not a checklist ceiling.

At each micro-goal reconciliation, reread the Flight. Work outside its `touchpoints`, work that enters a `non_goals` fence, or changes that threaten an invariant require realignment or a material user decision; re-verify every invariant whose surface changed.

After the final product mutation, run `cruise attest --json` to obtain the current `context_fingerprint`. If the `cruise` executable is not on `PATH`, locate this installed skill's plugin root and run `node <plugin-root>/scripts/cruise.mjs attest --json`; do not skip attestation merely because the launcher is not globally installed. For every gate, run or perform its stated oracle through ordinary host tools and permissions, then record a truthful receipt with a non-empty one-line summary, an explicit evidence source, that exact fingerprint, and an integer `observed_at`. The attestor only validates receipts and never executes `oracle` text. While Flight remains `active`, run the same attestor until it reports `ready_for_completion: true`; then set `status: complete` and run it once more to confirm `allows_completion: true`. A source edit, original-request edit, inherited-obligation/body edit, or structured contract edit makes old receipts stale. Intent, functional correctness, completion review, and independent review must pass and cannot be waived or marked inapplicable; completion and independent reviews require `source: review`. Do not weaken, delete, waive, or mark another gate not applicable merely to obtain completion. A permitted waiver requires the user's explicit decision, `source: user-decision`, `waived_by: user`, and a non-empty rationale; it yields qualified rather than assured completion.

Set `status: blocked` only for a concrete blocker and state that blocker in the body. Flight v1 remains readable for compatibility but is reported as legacy-unattested; new work must use v2.

Run a closed execution loop for every micro-goal:

1. Reconcile the requested outcome, current repository evidence, prior changes, and remaining acceptance criteria.
2. Draft only the next ready micro-goal’s actionable plan: ownership, files or interfaces, implementation approach, risks, and focused verification.
3. Implement the micro-goal, run the focused checks, and remediate in-scope failures.
4. Recheck alignment and regression risk. Incorporate confirmed findings, update the next micro-goal, and continue immediately while work remains.
5. Close the applicable profile gates with fresh evidence, perform the skeptical completion review, and re-run the deterministic attestor before claiming completion.

Do not present phase, checkpoint, or routine next-step approvals such as “Approve P-03” or “Stop after P-02”. A completed turn is a continuation point, not a human gate. Keep the host-native execution state active through planning, implementation, validation, and refinement; finish only once the requested outcome and its evidence are complete.

Use an adversarial review or agent swarm only when it has a meaningful chance to expose a bug: for example, changed concurrency or lifecycle behavior, migrations, public contracts, security-sensitive logic, broad integration paths, or an implementation with unresolved edge-case risk. Give independent reviewers bounded, non-overlapping probes or isolated scopes; ask them to try to break the implementation rather than repeat its happy path. Reproduce and resolve credible findings before advancing. Do not create a swarm for a simple, low-risk change, and do not claim independent coverage when it was unavailable.

Ask the user only when repository evidence cannot resolve a material product decision, the work needs a scope or safety expansion, authentication or secret entry is required, or the host requires approval for an external or destructive effect. Do not ask about routine sequencing, ordinary implementation choices, or whether to execute an already planned in-scope micro-goal. Do not report blocked merely because another internal phase remains. Report completion only after the requested evidence passes; report blocked only with a concrete unresolved blocker and the evidence or decision needed to resume.

Cruise does not create a Goal suite, approval digest, archive, attempt ledger, or run-control directory. The launcher may write `.cruise/ORIGIN.md` containing exactly the request; it is a note only and does not authorize work.

If a worker stream fails, state the observed failure category and retry normally when appropriate. Never require a magic retry phrase, a fresh Cruise run, an archive, or a DNS-health assertion that the error does not support.
