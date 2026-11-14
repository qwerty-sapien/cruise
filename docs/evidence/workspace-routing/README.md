# Workspace routing failure repair — 2026-11-14

The original branch-local Seatbelt network policy denied access to the canonical macOS resolver socket. Authenticated Codex `account/read` then returned `-32603: workspace routing discovery failed` before research. Adding only `/private/var/run/mDNSResponder` restored account, quota and ephemeral thread startup in controlled no-model probes.

Both retained branch isolation profiles were corrected with SHA-256 preconditions. Their old workspaces no longer existed at inspection, so no literature task was restarted. Cruise now identifies this generic error as account routing, gives conditional connectivity guidance and retains strict-budget pause/cleanup and non-retry behavior. Workspace roots were left unchanged after contrary evidence.

[Network controls](authenticated-network-controls.json), [canonical resolver controls](canonical-resolver-controls.json) and [filesystem controls](filesystem-isolation-controls.json) record the observations. Own reads/writes passed; sibling reads/writes remained denied. [Final full-suite output](full-tests.log): 538 passed, 0 failed. [Focused output](focused-tests.log): 104 passed. An initial full-suite timing assertion failed and passed in isolation and on the full rerun; the failure is retained.

The concurrent session's `7ec6122` schema commit is preserved. No installed plugin/configuration refresh or other-session interruption was performed. See [EVIDENCE_STEPS.md](EVIDENCE_STEPS.md) for commands, sources, thresholds and limitations. This is controlled runtime and mock-test evidence, not formal proof or a completed research run.
