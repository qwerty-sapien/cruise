# Explicit external sandbox for Codex

Use `cruise --codex goal --external-sandbox -C <directory> <request>` or
`cruise --codex worker --external-sandbox -C <directory> <task>` only when the
caller already enforces an outer sandbox. The flag is the operator's explicit,
request-scoped declaration of that boundary. A fresh directory or separate
checkout alone is not isolation. Cruise cannot prove outer-policy correctness.

Defaults do not change. There is no environment variable or global configuration
switch. Claude, queue, start, quick, build, debug, and other commands reject the
flag rather than ignoring it. Use the explicit `goal` command. Managed workers
accept the flag with `--managed` and their usual required scope and evidence.
The root must pass it explicitly to each managed worker, only while that worker
remains inside the same enforced outer boundary. It is not inherited globally.

The generated Codex v2 SandboxPolicy supplied for every opted-in turn and Goal
settings update is `{ "type": "externalSandbox", "networkAccess": "restricted" }`.
Thread creation keeps the ordinary supported `read-only`/`workspace-write`
ThreadStart enum; no external ThreadStart enum is invented. Goal settings are
updated before activating native Goal execution. Explicit initial Plan,
execution, correction/reactivation, and ordinary continuation turns all carry
the selected policy. Workers carry it on their first tool-capable turn.
Approval policy remains `on-request`; native and automatic reviewer denials
remain binding. No permission-error detection enables this option, no retry
weakens a denial, and this mode never uses `danger-full-access`.

Plan remains read-only work, including `goal --plan --external-sandbox`.
Workers requested with `--read-only` must not mutate product files. These
instructions express intent: **the outer sandbox must enforce the relevant
filesystem, network, and read-only bounds**. External policy itself cannot
guarantee read-only behavior. An outer policy allowing product writes does not
become read-only because Plan or a worker's read-only instruction is selected.
The operator must provide the appropriate enforcement for each phase or use
separately bounded invocations. Native approvals do not replace that boundary.

For independent transcripts and the Codex state database, give each independent
session a separately provisioned `CODEX_HOME` within its allowed control-state
area. Configure authentication through the normal supported login flow; do not
copy or display authentication material. A distinct `CODEX_HOME` separates
state, not security boundaries. Shared parent isolation must permit the parent's
own control-state writes as well as the child's allowed control-state writes
(including locks, runtime metadata and transcripts). Keep product write scopes
separate from these control-state requirements. This flag changes neither OS
policies nor existing directories.

## macOS resolver access and control-plane preflight

An outer Seatbelt policy permitting outbound TCP 443 and UDP/TCP 53 may still
block the macOS system resolver. Alongside those existing network rules, the
narrow resolver allowance is:

```scheme
(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))
```

Use the canonical `/private/var/run/mDNSResponder` path. In the supplied
authenticated, no-model probe, the `/var/run/mDNSResponder` alias did not match.
This grants outbound access to that resolver socket only; it does not grant
general Unix-socket access, filesystem writes, or arbitrary network destinations.
Keep the existing TCP 443 and UDP/TCP 53 restrictions and filesystem boundaries.
Do not substitute a Unix-socket-wide allowance or loopback TCP fallback: loopback
TCP did not restore the tested resolver path, and either broader allowance would
expand access beyond the demonstrated requirement.

Before research or model work, preflight the authenticated control plane under
the intended outer policy: `account/read` with `refreshToken: false`,
`account/rateLimits/read`, then an ephemeral `thread/start` without `turn/start`.
Stop the probe transport and its children afterward. Thread creation checks
control-plane readiness, not model execution or the research environment.

The supplied probe succeeded outside the restricted policy but failed inside it
at `account/read` with `-32603: workspace routing discovery failed`. Explicit
cwd roots and loopback TCP did not fix it; the canonical resolver-socket rule
restored all three preflight operations. This is evidence for that tested macOS
boundary, not proof that every generic routing error is DNS. Check account/backend
connectivity and retain any explicit authentication or configuration error.
Adding workspace roots is not a supported repair for this observed failure.
Cruise does not install this rule, weaken policies, or retry denials automatically.
Apply policy changes only through the governing authorization controls.

With strict budgeting, unavailable quota authority still pauses with exit code 6
before model launch or an account reservation. Resolve the control-plane cause
and obtain authoritative quota data before resuming; disabling strict budgeting
is not a repair.

The motivating operator-supplied Codex 0.169.0 probe observed native readOnly
command execution fail with exit 71 (`sandbox_apply: Operation not permitted`)
inside an existing macOS sandbox. ExternalSandbox allowed its own file (exit 0)
while the outer policy still denied another branch's file (exit 1). That is
evidence for that tested outer boundary only, not a general isolation guarantee.
Repository regression tests use mock app-server transcripts, never live models;
they verify routing and policy propagation, not the caller's OS policy.
