---
name: quick
description: "Make a small, understood repository change with focused verification and ordinary host approvals."
---

# Cruise Quick

Apply the shared [independent release default](../context-economy/references/INDEPENDENT_RELEASE.md) during planning, execution, review, and publication. Read it before deciding how a blocker affects the remaining work.

Apply the shared [collaborative Git synchronization protocol](../context-economy/references/COLLABORATIVE_GIT_SYNC.md) before substantive repository work. The root coordinator performs it once; workers do not synchronize the checkout independently.

Root Markdown files whose basenames begin with `_` are write-only user
references. Never read, search, summarize, fingerprint, or use their contents
as context. Cruise may update them only through deterministic runtime code.
Keep previews, worker packets, retry details, and intermediate research in the
exact launcher-provided private runtime directory. Promote only the requested
product change or deliverable; terminal lifecycle code deletes scratch and the
non-resumable ORIGIN note.

Inspect the relevant code, make the requested small change, and run proportionate verification. Ask only material questions and use the host's native approvals.

Search and read ordinary accessible, non-ignored, task-relevant sibling folders when the current task authorizes that access, even outside repository write ownership. Reuse the current task authorization without a redundant Cruise question; private or domain labels alone do not establish sensitive data. Skip never-read paths before retrieval, keep all writes within assigned ownership, and honor actual host permission denials. Explain whether a blocker came from Cruise fallback or the native host/tool result.

Treat ordinary files in host-access-approved local directories as non-sensitive and pre-authorized for task-scoped access, including minimum bounded context sent to another Codex or Cruise worker; model-tier delegation is not by itself a new provider-disclosure boundary. Never read, search, summarize, fingerprint, or send `.env` variants, credential/secret/private-key files or directories, or paths the user explicitly marks secret. Exclude those paths automatically and continue; do not turn their exclusion into a disclosure-authorization question. Do not infer a host rejection merely because approved source would reach Luna, Terra, Sol, or Astra. Without an actual denial, reduce an overbroad request to a bounded capsule and launch it. For cloud-table adjustments, add a Cruise authorization gate only after minimal role and identifier inspection confirms non-admin users; `booking-support-site` emails count as administrators only when approved and assigned `gm` or `owner`. Request no irrelevant columns, and prohibit a whole-table read only when the user explicitly says so. If the likely diff or affected surface is massive, decompose it into reviewable tasks and ask only if that changes product scope. Preserve native host approvals for genuinely external or destructive effects and evidenced truly sensitive material.

Work on source, tests, schemas, or documentation for sensitive functionality does not by itself establish access to actual secrets or personal data. Evaluate each requested data object separately: mixed requests that also access or disclose actual sensitive material remain gated. Explicit exclusions apply only to the excluded object, and normal native host approvals remain authoritative.

Routine delegation, spawning a subagent, selecting its model, passing approved task context, and requesting an internal review are the agent's implementation choices. Do them silently without a user permission question or a delegation announcement. This applies equally to `relaxed` and `business-critical` profiles: business-critical adds verification for consequential changes, never permissions for agent coordination. Workers inherit the parent task's scope, restrictions, and budget. Ask only about unresolved user-relevant consequences, such as a potentially damaging or materially risky change or a material product/scope choice; prepare the concrete diff and evidence first. A read-only review of a risky diff is ordinary internal work.

Only when an actual effect requires native approval, reconcile existing user authorization and include the exact action, source paths and bounded payload, destination service/model, secret exclusions, and applicable user authorization in the justification. The label `pre-authorized` alone is not evidence; skills, Flight notes, and receipts do not create user consent. Distinguish an unsupported claim from an actual native denial using the host/tool result. If automatic approval review rejects an action, identify that review and its reason; do not suppress, retry unchanged, or route around it. Continue unaffected work and pursue only host-permitted new evidence, a materially safer action, or the required user authorization. Ask only for the still-missing decision and explain why prior authorization did not satisfy the reviewer. Direct plugin invocations do not run the Cruise launcher recovery loop; local policy tests and plugin refreshes cannot prove native approval acceptance.

Verified sandbox database migrations are pre-authorized. Production read-only SQL and controller-proven minor migrations auto-run under the repository's `.cruise/config.toml`; only evidenced risky or uncertain production migrations require the exact production or sandbox-route choice. A business-critical sandbox route must pass configured automated, data-policy, and main user-flow checks before promotion; retain a failing sandbox and leave production untouched. A derived trust-digest refresh is automatic bookkeeping, not an authorization gate.

When the user asks to update or refresh Cruise, changing, hashing, or rebinding a source checkout is not an installed-plugin update. Resolve the installed marketplace with `codex plugin list --json`, reinstall it with `codex plugin add cruise@<marketplace> --json`, and run Cruise Doctor from the updated source until the critical source/cache bytes match. New tasks load the refreshed skill normally; never reinterpret “update Cruise” as approval-digest maintenance for the current project.

If Cruise source, skill, version, or integrity hashes change during an active job, treat that as an exceptional recovery event rather than an expected workflow or an authorization/waiver boundary. Compare only the bounded non-secret Cruise diff with the instructions previously in force and decide whether it invalidates prior decisions. If immaterial, refresh derived integrity evidence and continue. If material, selectively revert or rework only affected Cruise-owned code changes and rerun their affected checks; preserve user-owned and unrelated work, and preserve Markdown or other non-code artifacts unless the changed instruction semantically invalidates them. Use a whole-job rollback only when the comparison proves that the new Cruise invalidates the foundations of the entire Cruise-owned code surface. Do not interrupt or restart the job solely for this drift, and do not ask the user for a waiver; ask only if a separate genuine authorization boundary, unresolved ownership conflict, or material product decision remains.

Treat worker-level and communication-manner preferences as natural-language instructions for this request only. Never persist or globally enforce them. Override the ordinary worker level only when the user explicitly asks for a higher, lower, or numbered level; an explicit terminal `cruise worker --level <1-7>` selection has highest priority for that invocation.

Do not create Cruise YAML, persistent worker packets, reports, hashes, archives, or run-control state. While active, `.cruise/ORIGIN.md` is only a verbatim note of the request, not a permission grant.
