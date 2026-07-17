# Build and Goal

Build and Goal are conversation workflows, not filesystem contracts. Goal is
self-driving after the user explicitly invokes it: it checks each subtask’s
success and readiness criteria, then immediately continues with the next ready
subtask until the native Goal is complete or a concrete material blocker occurs.
Do not turn implementation phases into “approve the next phase” prompts. Keep
ordinary Codex approval only for a material decision or a host-required
sensitive, external, or destructive effect. Do not create project/milestone
YAML, approval digests, queues, archives, or historical copies.

The raw request note in `.cruise/ORIGIN.md` is the only Cruise-managed
repository artifact and does not confer authority.
