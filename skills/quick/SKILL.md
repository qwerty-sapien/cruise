---
name: quick
description: "Make a small, understood repository change with focused verification and ordinary host approvals."
---

# Cruise Quick

Apply the shared [independent release default](../context-economy/references/INDEPENDENT_RELEASE.md) during planning, execution, review, and publication. Read it before deciding how a blocker affects the remaining work.

Apply the shared [collaborative Git synchronization protocol](../context-economy/references/COLLABORATIVE_GIT_SYNC.md) before substantive repository work. The root coordinator performs it once; workers do not synchronize the checkout independently.

Inspect the relevant code, make the requested small change, and run proportionate verification. Ask only material questions and use the host's native approvals.

Treat worker-level and communication-manner preferences as natural-language instructions for this request only. Never persist or globally enforce them. Override the ordinary worker level only when the user explicitly asks for a higher, lower, or numbered level; an explicit terminal `cruise worker --level <1-7>` selection has highest priority for that invocation.

Do not create Cruise YAML, worker packets, reports, hashes, archives, or run-control state. `.cruise/ORIGIN.md` is only a verbatim note of the request, not a permission grant.
