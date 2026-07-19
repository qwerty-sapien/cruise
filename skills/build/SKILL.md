---
name: build
description: "Plan a project or milestone with the user and implement only work they explicitly approve. Cruise keeps no build contracts, queues, or state files."
---

# Cruise Build

Inspect the repository, discuss the smallest useful project or milestone plan, and present it plainly in the conversation. Use normal Codex approvals for any edits or external effects.

Treat worker-level and communication-manner preferences as natural-language instructions for this request only. Never persist or globally enforce them. Override the ordinary worker level only when the user explicitly asks for a higher, lower, or numbered level; an explicit terminal `cruise worker --level <1-7>` selection has highest priority for that invocation.

Do not create Cruise YAML, a queue, a milestone ledger, a digest, an archive, or a run directory. The only Cruise-managed file is `.cruise/ORIGIN.md`, written by the launcher with the user’s exact request.
