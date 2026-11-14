# Startup, access and worker UX

`npm run test:ux` exercises startup, ordinary local access, bounded retrieval,
structured handoffs and commit bookkeeping. These regressions also run in the
full `npm test` suite. Tests use disposable fixtures and mocked app-server
transcripts; an actual model smoke test must be reported separately.

## A Goal is active but no work has started

An active Goal object does not establish a running turn. The old launcher set
Goal metadata and waited only for notifications, with no default deadline. It
could wait for minutes without reaching Plan, execution or managed dispatch.

Cruise now reads thread status and bounded recent turn history. It adopts
existing work, recovers missed notifications, or requests one Plan bootstrap
when no turn exists. An uncertain start response is not retried. The default
idle bound is 30 seconds; established work resumes normal transport monitoring.
Concrete authentication and protocol failures retain their error message.

A managed worker invoked by a supervised Goal or Debug run joins the validated
parent reservation. It owns a separate child runtime and dispatch/quota lease;
it does not replace or release the root workspace lock. An unrelated second root
still conflicts. Invalid inherited parent bindings are reported before writes.

The startup bound can be changed with `--bootstrap-timeout-ms` or
`CRUISE_GOAL_BOOTSTRAP_TIMEOUT_MS`; `0`/`off` deliberately permits unlimited idle
waiting. Cancellation remains available. Do not describe startup failure as a
user-authorization decision without an actual approval result.

## Managed CLI exits before initialize

The managed CLI is control-plane transport. Process failures include a compact
stderr tail (at most 1024 characters) while preserving the exit code and original
cause. A permission hint appears only when the displayed stderr reports `EPERM`,
`Operation not permitted` or `permission denied`; exit code 1 alone is insufficient.
The hint does not establish which sandbox or resource caused the failure.

When the parent native sandbox cannot start the transport, request native
escalation with the exact launch command and a bounded task justification under
existing user authority. Include the source paths, bounded payload, destination
service/model and secret exclusions. Preserve a requested read-only worker task
thread and use `context-view --no-persist`; transport approval does not authorize
broader product writes. Do not retry automatically or bypass host permission.

An OS sandbox failure is not an automatic approval reviewer rejection. If the
reviewer actually rejects the action, preserve and report its stated reason;
do not blindly retry or route around it. Reconcile existing authority and any
still-missing decision through normal native approval controls.

## Workspace routing discovery failed

The exact generic `workspace routing discovery failed` error is reported as an
`account-routing` failure. It is not automatically retried. Check authenticated
account/backend connectivity first; the wording alone does not identify a local
workspace-root discovery problem or prove a transient upstream or DNS failure.
Explicit authentication, configuration and HTTP errors keep their own evidence;
the generic resolver guidance does not replace those diagnoses.

On macOS inside an outer sandbox, TCP 443 and UDP/TCP 53 access alone may leave
the system resolver blocked. See [the narrow canonical mDNSResponder socket
allowance and no-model preflight](EXTERNAL_SANDBOX.md#macos-resolver-access-and-control-plane-preflight).
Do not broaden workspace roots, permit all Unix sockets, or use loopback TCP as
a substitute. Preflight the control plane before research, and stop the probe
transport afterward. Policy changes remain subject to native authorization;
an actual denial must not be retried unchanged.

`weekly quota authority unavailable` with this exact error means strict budgeting
could not establish authority. Exit code 6 remains a budget pause, with no model
launch or new account reservation. Resolve the account/backend or evidenced outer
sandbox connectivity cause, then reconcile authoritative quota before resuming.
Do not disable strict budgeting to bypass the pause.

## An agent asks to read an ordinary folder

Task-relevant ordinary files in an authorized accessible folder do not need a
second Cruise consent question. That includes named sibling folders. Read scope
does not expand write ownership. Sensitive paths, explicit exclusions and real
host denials remain enforced.

`context-view` accepts `--root` for a named read root and named external file
arguments. Extraction and search can operate in non-Git folders. Use
`--no-persist` for side-effect-free retrieval; read-only workers request it by
default. A cache or artifact write is not required for a useful capped result.
Results identify their source paths and whether persistence was used.

Non-Git assurance uses declared Flight touchpoints and gate surfaces rather than
requiring Git initialization. File, glob and directory expansion is bounded;
missing files have explicit markers. Sensitive, ignored, symlink and control
paths are excluded. Unsupported scopes or resource limits remain unavailable,
so use a narrow explicit product surface when a broad snapshot cannot be made.
Flight `scope.touchpoints` and gate surfaces are owned product-relative paths.
Keep authorized sibling/absolute read dependencies in the Flight body and
verification commands, outside the product fingerprint selectors. Correcting
that declaration is routine reconciliation; preserve the actual read scope,
acceptance checks and evidence.

When a host actually reports `EACCES`, `EPERM` or an approval denial, state the
host result and affected action. Continue independently authorized work and
choose a permitted read-only alternative where it satisfies the task. A word
such as private, password-reset or medical-record schema is not itself evidence
that the source contains sensitive data.

## A completed worker cannot return its handoff

Progress commentary is streamed for visibility. The handoff comes from the
canonical final message, matched by item ID, rather than concatenating every
delta. Canonical-only final messages work too. Legacy streams have a conservative
fallback; conflicting or multiple final payloads remain errors. The final JSON
must still satisfy the schema and byte cap. Do not discard completed code merely
because the transport handoff failed; retain it for root inspection and focused
verification, then repair the transport cause.

A completed worker may leave its blocker/next-step field empty. The continuation
retains the outcome and reports that no blocker was supplied. Structured results
may use up to 8 KB; the continuation injected into the root remains within 4 KB.

## Keep blockers specific

Report whether work is waiting for the backend, a real host approval, a missing
user decision, a malformed worker response or a local tool error. Name the
operation, phase, observed state and next useful action. Preserve completed
artifacts and their evidence when an orchestration node fails. A diagram of
research/reviewer roles is not proof those roles ran.
