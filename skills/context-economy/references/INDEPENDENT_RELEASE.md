# Continue and publish unaffected work

Apply this default across planning, execution, review, and publication in Build, Goal, Quick, Debug, queues, and workers. When an item is blocked, isolate the blocker and its dependency closure. Continue independently complete work and, once its applicable checks pass, push and deploy it to authorized existing destinations. Do not wait for unrelated blocked items or add a fresh permission ceremony for already authorized publication.

Plan reviewable release units with explicit dependencies and release checks. During execution, preserve blocked requirements and owner deferrals; never remove a dependency to manufacture readiness.

Demonstrate that each release outcome is functionally distinct before publication
using bounded source and contract inspection and verification evidence. Separate
labels, files, repositories, or declared `depends` arrays alone are insufficient
evidence. Trace actual user journeys from public routes, navigation, buttons, APIs,
and indirect entry points through their transitive dependencies, including required
services, contracts, shared data and state, schemas, transactions, and migrations.
Verify the complete release path and required endpoint contracts with appropriate
integration and readiness checks. Establish the readiness of mocked prerequisites
separately before treating an outcome as ready.
Propagate each blocker to every functionally connected or dependent unit. Hold each unit from
publication until its separation is established. Publish only complete, working
outcomes that are demonstrably separate, cannot expose the blocked capability, and
pass their own required assurance checks.

If A, B, and C are requested and payment channel B requires booking endpoint C,
a broken C blocks B and C and every publicly exposed flow or entry point leading
to the broken capability. Publish A only after establishing its separation and
verifying that it works.

Workers deliver their scoped changes and evidence to the owner/root and coordinate publication through that root when the workflow requires it; worker authority never expands.

An explicitly owner-authorized bounded fallback may be assessed as its own outcome.
Apply the same dependency, exposure, and readiness checks and prevent users from
invoking unsupported actions. A notice or placeholder alone supplies no evidence
of independence or readiness. Use accurate unavailable wording for that approved
outcome. Do not simulate success, invent a working integration, or promise a delivery
date. Record any owner deferral explicitly and retain the
full deferred feature for resumption.

Report what was completed, verified, pushed, and deployed separately, with evidence and the exact remaining blocker or owner deferral. Track completion against the current owner-approved scope and explicit scope changes. Retain unresolved work for resumption.

Preserve explicit research-only, preparation-only, and deployment limits; native host approvals; financial and authorization invariants; cost and quota containment; dependency integrity; and required review and release gates. This default grants no new destination or external-action authority and never bypasses a denial. A global quota, authorization, integrity, or technical blocker can affect every unit: pause the affected scope truthfully and resume only when its controlling condition permits.

Queue resume retains stop provenance in milestone `stop_scope`: `local` permits independent continuation; `global` stops the queue across invocations. Runtime, quota, interruption, assurance, and contract-integrity stops remain global until their controlling condition is reconciled through the normal workflow and the advisory queue stop scope and status are explicitly updated. Historical blocked or stalled milestones without local provenance stop the queue; rerunning alone never establishes resolution. Preserve dependency edges and owner deferrals during reconciliation.
