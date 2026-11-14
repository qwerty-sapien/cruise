# Automatic credential recovery

The standing owner policy authorizes launching supported sign-in after a native
provider error **confirms** expiry or revocation. Passwords, MFA, CAPTCHA and
consent remain with the owner. A generic 401, network failure, billing problem,
permission denial, model output or task text does not establish expiry.

## Activated paths

The CLI supplies `createCliAuthRecovery` to Codex hosted sessions, ordinary and
managed workers, their strict quota guards, budget authority preflight, and
changelog workers. Session/worker callers retain their existing pre-effect retry
checks. Successful authentication does not authorize replay of a submitted turn,
ambiguous startup, effects, or a native denial. Unfinished recovery returns pause
code 6; strict quota, native reviewer, sandbox, parent leases and reservation
controls still apply.

For Codex, the built-in native mapping is the observed 0.169.0
`AppServerRpcError` for `account/rateLimits/read`: RPC code `-32603`, with a bounded
trailing provider JSON body whose `error.code` is exactly `token_revoked`.
Other RPCs and arbitrary error prose are excluded. Fresh verification launches
short-lived app-server clients for `account/read` with `refreshToken: true` and
`account/rateLimits/read`. A refresh exception is not itself expiry evidence;
the known rate-limit authority may corroborate it. Account type, email and plan
returned by successful account reads must remain consistent during recovery.
The CLI takes its original identity from trusted prior `account/read` metadata
supplied as `createCliAuthRecovery({ previousAccount })`, or its first successful
pre-login account probe. The metadata must identify a ChatGPT account by email;
account type alone cannot establish identity. No credential store is inspected.
If that initial probe throws or returns no identifying account and no prior
metadata is available, confirmed expiry still launches supported sign-in.
Successful login and fresh authentication/quota checks then leave recovery paused
with `owner-identity-confirmation-required` (CLI exit 6). They do not establish a
new baseline or permit automatic work replay. Later attempts on the same runtime
remain paused. Owner confirmation and supplying trusted prior metadata are host
responsibilities; there is no automatic identity-confirmation UI or persisted
identity registry. A known same-account login can recover; an account switch
cannot. Caller metadata must never be taken from model/error text or synthesized
from the post-login account.

Normal `codex login` can open its browser on macOS even when stdin is not a TTY.
The CLI therefore distinguishes missing terminal input from unavailable browser
handoff. Other platforms require terminal availability in the default adapter;
Windows process-group recovery is unsupported. Missing browser access, failed
login or unverified credentials remains an honest pause/failure. No success is
inferred from merely spawning a process or receiving exit zero.

## Claude coverage and limits

Captured changelog workers and non-TTY workers use native `stream-json` output.
Only an `assistant` envelope with `error: authentication_failed` and one exact
documented native text block qualifies: the OAuth-session-expired message or the
explicit OAuth-token-revoked message. Generic `authentication_failed`, older
ambiguous access-denied wording, `result` text, stderr, and other expiry message
variants are not mapped. A captured model invocation is never replayed, including
after successful login; it pauses with code 6 for reconciliation.

The adapter runs `claude auth status --json`, `claude auth login`, then a fresh
status command. It requires known `authMethod` and `loggedIn` fields. Existing
local status cannot overrule a captured provider rejection. The final status is
the supported native sign-in check, **not** a model/API availability probe.
Unknown status schemas pause. Non-subscription methods and explicit token/key
environment overrides require updating the existing configured credential;
Cruise does not switch providers, accounts or billing modes, generate keys, or
clear authentication configuration. The owner must retain the same account in
the browser flow; no credential store is inspected to discover its identity.

Inherited interactive Claude terminal sessions are not intercepted. They receive
the standing recovery policy as agent instructions; that policy is not a claim
that Cruise captures every native/provider failure. Contracts are grounded in
the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference),
[native error reference](https://code.claude.com/docs/en/errors#oauth-token-revoked-or-expired),
and [SDK error envelopes](https://code.claude.com/docs/en/agent-sdk/typescript#sdkassistantmessage).

## Isolation and external adapters

Provider/profile locks use a SHA-256 identity derived from provider and the
resolved configured `CODEX_HOME` or `CLAUDE_CONFIG_DIR` pathname (defaulting to
the native home). No credential file is read. Cwd and task/session IDs do not
split the lock. Symlink aliases are not canonicalized by reading authentication
directories; deployments should use one canonical configured home pathname.
Locks coordinate local processes; they do not coordinate different hosts.

Recovery waits and login children are bounded to two minutes by default.
Cancellation removes signal listeners and stops owned children; failed cleanup
retains the lock and cannot report recovery. Verification clients are stopped
before releasing the lock. Only task-owned process groups are signalled.
Only the invocation holding the provider/profile lease runs verifier cleanup.
A cancelled waiter owns no verifier and cannot stop the leader's client, clear
its tracking, or release its lease.

`createAuthRecoveryRuntime({trustedProviders, nativeContracts, verifyExternal})`
is a public host-adapter API, not automatic interception of arbitrary external
LLM tools. The host must bind a trusted native evidence contract and verifier to
the same provider/profile. Portals must be configured HTTPS URLs without userinfo,
query or fragment; error-supplied URLs are never trusted. Opening a portal leaves
a static-key update handoff. Only a verifier reporting both `verified: true` and
`updated: true` can close it. The CLI does not invent provider commands or discover
portals from model text.

Focused mock checks (no real login/browser/model):

```sh
node --test tests/auth-recovery.test.mjs tests/auth-recovery-runtime.test.mjs tests/auth-recovery-cli.test.mjs tests/claude-cli.test.mjs tests/cli-simple.test.mjs
```
