---
name: goal
description: "Autonomously complete consequential or multi-step work: plan just enough to begin, implement, validate, adversarially challenge when warranted, and refine until the outcome is complete."
---

# Cruise Goal

For consequential work, inspect the repository and make a proportionate plan. Treat an explicit `cruise goal` invocation as authorization to carry the requested work through to completion within the normal workspace and permission boundaries. That authorization includes routine planning and phase transitions; never require a copied approval phrase, digest acknowledgement, or an `--auto-approve` incantation. Respect an explicit request to only plan, research, or prepare; otherwise, a plan is an instruction to implement, never the endpoint.

## Use the selected host natively

- **Codex:** use native Goal state when it is available. A Goal starts with the host's read-only Plan-mode turn and then moves to normal Goal execution. Keep the Goal active through implementation and verification, and use the Goal status as the completion authority. Supervised realignment turns are normal: answer them with a changed, evidence-producing approach or an honest blocker, never another run of the same failing attempt.
- **Claude Code:** no documented Codex-style Goal lifecycle endpoint is available to plugins. Do not invent one. Stay in the user's current Claude permission mode, maintain the work as a concise native task list, and continue the execution loop in the same resumable session. Do not enter Claude's approval-gated `/plan` mode merely as ceremony; use it only when the user requested read-only planning. Use native Claude subagents for bounded independent work when warranted. Interruption and continuation are the native session controls (`Ctrl-C`, `/resume`, `--continue`, and `--resume`), not synthetic Cruise Goal states. During a supervised Goal, the flight plan's `status` field is the completion handshake with the Stop hook; keep it truthful.

Treat worker-level and communication-manner preferences as natural-language instructions for this request only. Never persist or globally enforce them. Override the ordinary worker level only when the user explicitly asks for a higher, lower, or numbered level; an explicit terminal `cruise worker --level <1-7>` selection has highest priority for that invocation.

Establish a codebase-aware execution path only long enough to begin. Identify the requested outcome, protected behavior, likely owners and touch points, acceptance evidence, and the smallest ready micro-goal. State a compact, strongly aligned plan for that micro-goal, then implement it. Do not wait for a routine plan review, phase approval, or a new invocation. On Codex, respect the launcher's initial read-only Plan turn and move directly into active Goal execution afterward. On Claude Code, plan in the current session without manufacturing a mode transition.

## Keep an advisory flight plan

During the initial inspection, resolve the outcome, scope fence, invariants, acceptance commands, and useful stall tuning. Write them to `.cruise/FLIGHT.md` as the first act of execution mode; Codex's bootstrap Plan turn is read-only, so do not fight it. The flight plan is a user-editable advisory note, not permission, authority, or a gate. It does not change `.cruise/ORIGIN.md` semantics.

At each micro-goal reconciliation, reread the flight plan. Work outside its `touchpoints`, work that enters a `non_goals` fence, or changes that threaten an invariant require realignment or a material user decision; re-verify every invariant whose surface changed. Set `status: complete` only when acceptance evidence passes. Set `status: blocked` only for a concrete blocker and state that blocker in the body.

Run a closed execution loop for every micro-goal:

1. Reconcile the requested outcome, current repository evidence, prior changes, and remaining acceptance criteria.
2. Draft only the next ready micro-goal’s actionable plan: ownership, files or interfaces, implementation approach, risks, and focused verification.
3. Implement the micro-goal, run the focused checks, and remediate in-scope failures.
4. Recheck alignment and regression risk. Incorporate confirmed findings, update the next micro-goal, and continue immediately while work remains.

Do not present phase, checkpoint, or routine next-step approvals such as “Approve P-03” or “Stop after P-02”. A completed turn is a continuation point, not a human gate. Keep the host-native execution state active through planning, implementation, validation, and refinement; finish only once the requested outcome and its evidence are complete.

Use an adversarial review or agent swarm only when it has a meaningful chance to expose a bug: for example, changed concurrency or lifecycle behavior, migrations, public contracts, security-sensitive logic, broad integration paths, or an implementation with unresolved edge-case risk. Give independent reviewers bounded, non-overlapping probes or isolated scopes; ask them to try to break the implementation rather than repeat its happy path. Reproduce and resolve credible findings before advancing. Do not create a swarm for a simple, low-risk change, and do not claim independent coverage when it was unavailable.

Ask the user only when repository evidence cannot resolve a material product decision, the work needs a scope or safety expansion, authentication or secret entry is required, or the host requires approval for an external or destructive effect. Do not ask about routine sequencing, ordinary implementation choices, or whether to execute an already planned in-scope micro-goal. Do not report blocked merely because another internal phase remains. Report completion only after the requested evidence passes; report blocked only with a concrete unresolved blocker and the evidence or decision needed to resume.

Cruise does not create a Goal suite, approval digest, archive, attempt ledger, or run-control directory. The launcher may write `.cruise/ORIGIN.md` containing exactly the request; it is a note only and does not authorize work.

If a worker stream fails, state the observed failure category and retry normally when appropriate. Never require a magic retry phrase, a fresh Cruise run, an archive, or a DNS-health assertion that the error does not support.
