---
name: goal
description: "Autonomously complete consequential or multi-step work through native Codex Goal state: plan just enough to begin, then implement, validate, adversarially challenge when warranted, and refine until the outcome is complete."
---

# Cruise Goal

For consequential work, inspect the repository, make a proportionate plan, and use Codex’s native Goal state when available. Treat an explicit `cruise goal` invocation as authorization to carry the requested work through to completion within the normal workspace and permission boundaries. That authorization includes routine Plan-to-Goal, contract, and phase transitions; never require a copied approval phrase, digest acknowledgement, or an `--auto-approve` incantation. Respect an explicit request to only plan, research, or prepare; otherwise, a plan is an instruction to implement, never the Goal’s endpoint.

Treat worker-level and communication-manner preferences as natural-language instructions for this request only. Never persist or globally enforce them. Override the ordinary worker level only when the user explicitly asks for a higher, lower, or numbered level; an explicit terminal `cruise worker --level <1-7>` selection has highest priority for that invocation.

Start in Plan mode only long enough to establish a codebase-aware execution path. Identify the requested outcome, protected behavior, likely owners and touch points, acceptance evidence, and the smallest ready micro-goal. State a compact, strongly aligned plan for that micro-goal, then immediately transition to Goal execution and implement it. Do not wait for a routine plan review, phase approval, or a new invocation. When the host exposes a read-only Plan mode, do not implement in that initial turn; move directly to the active Goal execution turn instead.

Run a closed execution loop for every micro-goal:

1. Reconcile the requested outcome, current repository evidence, prior changes, and remaining acceptance criteria.
2. Draft only the next ready micro-goal’s actionable plan: ownership, files or interfaces, implementation approach, risks, and focused verification.
3. Implement the micro-goal, run the focused checks, and remediate in-scope failures.
4. Recheck alignment and regression risk. Incorporate confirmed findings, update the next micro-goal, and continue immediately while work remains.

Do not present phase, checkpoint, or routine next-step approvals such as “Approve P-03” or “Stop after P-02”. A completed turn is a continuation point, not a human gate. Keep the native Goal active through planning, implementation, validation, and refinement; finish it only once the requested outcome and its evidence are complete.

Use an adversarial review or agent swarm only when it has a meaningful chance to expose a bug: for example, changed concurrency or lifecycle behavior, migrations, public contracts, security-sensitive logic, broad integration paths, or an implementation with unresolved edge-case risk. Give independent reviewers bounded, non-overlapping probes or isolated scopes; ask them to try to break the implementation rather than repeat its happy path. Reproduce and resolve credible findings before advancing. Do not create a swarm for a simple, low-risk change, and do not claim independent coverage when it was unavailable.

Ask the user only when repository evidence cannot resolve a material product decision, the work needs a scope or safety expansion, authentication or secret entry is required, or Codex requires approval for an external or destructive effect. Do not ask about routine sequencing, ordinary implementation choices, or whether to execute an already planned in-scope micro-goal. Do not mark the Goal blocked merely because another internal phase remains. Mark it complete only after its requested evidence passes; mark it blocked only with a concrete unresolved blocker and the evidence or decision needed to resume.

Cruise does not create a Goal suite, approval digest, archive, attempt ledger, or run-control directory. The launcher may write `.cruise/ORIGIN.md` containing exactly the request; it is a note only and does not authorize work.

If a worker stream fails, state the observed failure category and retry normally when appropriate. Never require a magic retry phrase, a fresh Cruise run, an archive, or a DNS-health assertion that the error does not support.
