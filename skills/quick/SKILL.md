---
name: quick
description: "Make a small, understood repository change with focused verification and ordinary host approvals."
---

# Cruise Quick

When delegating or continuing delegated work, read [native collaboration and context handoffs](../goal/references/agent-context.md). Use native peer messages to coordinate ownership and alignment. Never compact subagents; resume only the same agent/session’s latest checkpoint unless an explicit human instruction overrides this boundary. These standing context rules persist across requests.

Inspect the relevant code, make the requested small change, and run proportionate verification. Ask only material questions and use the host's native approvals.

Treat worker-level and request-specific communication-manner preferences as natural-language instructions for this request only. Never persist or globally enforce them. Override the ordinary worker level only when the user explicitly asks for a higher, lower, or numbered level; an explicit terminal `cruise worker --level <1-7>` selection has highest priority for that invocation.

Do not create Cruise YAML, worker packets, reports, hashes, archives, or run-control state. `.cruise/ORIGIN.md` is only a verbatim note of the request, not a permission grant.
