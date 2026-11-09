---
name: build
description: "Clarify a project with the user and compile it into an advisory queue of goal-sized milestones. Build plans; queue runs execute."
---

# Cruise Build

Apply the shared [independent release default](../context-economy/references/INDEPENDENT_RELEASE.md) during planning, execution, review, and publication. Read it before deciding how a blocker affects the remaining work.

Apply the shared [collaborative Git synchronization protocol](../context-economy/references/COLLABORATIVE_GIT_SYNC.md) before substantive repository work. The root coordinator performs it once; workers do not synchronize the checkout independently.

Build is the bowling setup for a whole project: clarify the vision once, inspect the repository, and decompose the work into a sequence of independently verifiable Goal runs. Do not implement the milestones in this conversation. Execution belongs to `cruise queue run` or an explicit Goal invocation.

Inspect the repository before asking questions. Ask only material questions whose answers change the decomposition: product intent, hard constraints, compatibility obligations, required migrations, and what must never break. Resolve ordinary implementation details from repository evidence. Do not demand approval phrases, plan digests, or ceremonial checkpoints.

Compile the result into goal-sized milestones. Every milestone must have a one-line falsifiable outcome, its own verification commands, explicit likely touchpoints, explicit non-goals, protected invariants, a risk level, relevant quality profiles, and only real dependencies. Always select `core`; add `web`, `backend-data`, or `cxx-hpc` when the milestone surface warrants it. Use `high` or `critical` for security, persistence, concurrency, public contracts, migrations, costly computation, or unusually costly failure. A milestone should be independently completable; split work that cannot be verified without an unrelated later phase. Use non-goals to stop later concerns from bleeding into the current milestone.

State cross-milestone reconciliation obligations once in the queue body. Include backward and forward compatibility, migration reversibility, coexistence windows, and cleanup conditions when they matter. Every generated flight plan inherits this body, so write obligations as constraints that remain meaningful throughout the queue.

Write the compiled plan to `.cruise/QUEUE.md` using version 2: `milestones` with `id`, `status`, `outcome`, `verify`, `depends`, `touchpoints`, `non_goals`, `invariants`, `risk`, and `profiles`, followed by a concise Markdown body explaining the vision, milestone rationale, compatibility obligations, and sequencing. New milestones start `pending`. Queue v1 remains readable, but new Build work uses v2 so queue execution can seed the appropriate Flight quality dimensions and high-risk independent review.

Present the queue plainly in the conversation so the user can reorder, split, combine, or edit it before execution. The queue is advisory and user-editable between runs. It grants nothing, gates nothing, and never replaces the selected host's permissions. It is not a contract, ledger, digest, archive, approval record, or per-milestone run directory.

Treat worker-level and communication-manner preferences as natural-language instructions for this request only. Never persist or globally enforce them. Override the ordinary worker level only when the user explicitly asks for a higher, lower, or numbered level; an explicit terminal `cruise worker --level <1-7>` selection has highest priority for that invocation.
