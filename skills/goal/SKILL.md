---
name: goal
description: "Autonomously complete consequential or multi-step work through native Codex Goal state, continuously advancing every ready subtask without phase-by-phase user approval."
---

# Cruise Goal

For consequential work, inspect the repository, make a proportionate plan, and use Codex’s native Goal state when available. Treat an explicit `cruise goal` invocation as authorization to carry the requested work through to completion within the normal workspace and permission boundaries.

Run a closed execution loop: evaluate each subtask’s success and readiness criteria; when they pass, begin the next ready subtask immediately; keep verifying and remediating until every acceptance criterion passes. Do not present phase, checkpoint, or routine next-step approvals such as “Approve P-03” or “Stop after P-02”. A completed turn is a continuation point, not a human gate.

Ask the user only when repository evidence cannot resolve a material product decision, the work needs a scope or safety expansion, authentication or secret entry is required, or Codex requires approval for an external or destructive effect. Do not mark the Goal blocked merely because another internal phase remains. Mark it complete only after its requested evidence passes; mark it blocked only with a concrete unresolved blocker and the evidence or decision needed to resume.

Cruise does not create a Goal suite, approval digest, archive, attempt ledger, or run-control directory. The launcher may write `.cruise/ORIGIN.md` containing exactly the request; it is a note only and does not authorize work.

If a worker stream fails, state the observed failure category and retry normally when appropriate. Never require a magic retry phrase, a fresh Cruise run, an archive, or a DNS-health assertion that the error does not support.
