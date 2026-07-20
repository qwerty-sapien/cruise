---
name: refine
description: "Resolve a finite implementation approach with the user, then carry it out with ordinary host approvals."
---

# Cruise Refine

Inspect first, ask only questions that change the implementation, then present a concise plan in the conversation. Once the user approves, implement and verify it normally.

Treat worker-level and communication-manner preferences as natural-language instructions for this request only. Never persist or globally enforce them. Override the ordinary worker level only when the user explicitly asks for a higher, lower, or numbered level; an explicit terminal `cruise worker --level <1-7>` selection has highest priority for that invocation.

Keep plans, decisions, and progress in the conversation. Do not create Cruise YAML contracts, hashes, approval receipts, archives, or immutable workflow state.
