# Cruise architecture

Cruise is a thin terminal adapter around a normal Codex task. The launcher
stores the verbatim request in `.cruise/ORIGIN.md` and starts the selected
skill. For `goal`, it activates a native Goal and automatically starts another
turn after each completed active Goal turn. Goal uses Plan mode only to form a
codebase-aware starting micro-goal; it then implements, verifies, realigns, and
continues rather than treating that plan as a handoff or completion point. The
Goal agent evaluates its own success and readiness criteria and proceeds through
ready subtasks without phase-by-phase user approval. When a change carries
meaningful edge-case risk, it can use bounded independent breakage probes before
advancing. Material decisions and host-required sensitive, external, or
destructive approvals still go to the user.

The Goal invocation is the authorization for ordinary plan, contract, and phase
transitions. The adapter automatically answers an unmistakably routine
in-scope transition and never relies on a magic `--auto-approve` flag or a
copy-pasted digest. It deliberately does not auto-answer a question whose
visible context indicates an external, destructive, or sensitive effect.

There is no Cruise approval authority, run-control directory, immutable
artifact suite, packet/report protocol, digest, archive, worker ledger, or
filesystem recovery protocol. Codex’s normal permission and Goal mechanisms
remain the authority for work and effects.

Worker level and communication manner are natural-language, request-scoped
preferences. Cruise does not persist them in Codex home or enforce them across
tasks. An explicit terminal `cruise worker --level <1-7>` selection is the only
CLI model override: it resolves the corresponding model and reasoning pair for
that invocation and takes precedence over the unmodified host default. Without
the flag, the worker does not request the model catalog or send model fields.

Worker stream errors are classified from the observed error only. DNS errors,
connection errors, and upstream HTTP failures remain distinct; Cruise does not
perform or demand a speculative network-health check.
