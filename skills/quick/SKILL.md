---
name: quick
description: "Make a small, understood repository change with focused verification and ordinary host approvals."
---

# Cruise Quick

Inspect the relevant code, make the requested small change, and run proportionate verification. Ask only material questions and use the host's native approvals.

Treat worker-level and communication-manner preferences as natural-language instructions for this request only. Never persist or globally enforce them. Override the ordinary worker level only when the user explicitly asks for a higher, lower, or numbered level; an explicit terminal `cruise worker --level <1-7>` selection has highest priority for that invocation.

Do not create Cruise YAML, worker packets, reports, hashes, archives, or run-control state. `.cruise/ORIGIN.md` is only a verbatim note of the request, not a permission grant.
