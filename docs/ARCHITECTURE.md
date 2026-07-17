# Cruise architecture

Cruise is a thin terminal adapter around a normal Codex task. The launcher
stores the verbatim request in `.cruise/ORIGIN.md` and starts the selected
skill. For `goal`, it activates a native Goal and automatically starts another
turn after each completed active Goal turn. The Goal agent evaluates its own
success and readiness criteria and proceeds through ready subtasks without
phase-by-phase user approval. Material decisions and host-required sensitive,
external, or destructive approvals still go to the user.

There is no Cruise approval authority, run-control directory, immutable
artifact suite, packet/report protocol, digest, archive, worker ledger, or
filesystem recovery protocol. Codex’s normal permission and Goal mechanisms
remain the authority for work and effects.

Worker stream errors are classified from the observed error only. DNS errors,
connection errors, and upstream HTTP failures remain distinct; Cruise does not
perform or demand a speculative network-health check.
