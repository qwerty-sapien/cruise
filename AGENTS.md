# Cruise development

Cruise is a thin goal-alignment, task-decomposition, collaboration, and progress
layer over the selected native host. Keep native authentication, permissions,
session lifecycle, tools, and agent communication authoritative. Do not add
credential stores, managed-worker brokers, quota controllers, or compaction
controllers. Do not recursively launch Cruise to repair Cruise.

Use Node 20 or newer. Run the changed surface's focused tests and then
`npm run validate`. Tests use mock native-host transcripts, never real models.
Keep unrelated work and other active sessions intact.

For delegated work, read
`skills/goal/references/agent-context.md`. Assign disjoint ownership, communicate
through native peer messages, and preserve alignment with the shared outcome.
Each agent may read only its own session's latest checkpoint. Human instructions
are required to read a different agent, session, or older checkpoint. Never
request subagent compaction; checkpoint and resume with a fresh native context.
For the main conversation, retrieve narrowly and minimize compaction while
preserving the user's requirements and unfinished work.
