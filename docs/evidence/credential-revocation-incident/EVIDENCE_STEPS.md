# Codex credential recovery evidence — 2026-11-14

## auth-before.json

Source: fresh installed Codex 0.169.0 app-server, requested account/read with refreshToken:true then account/rateLimits/read. The response had no account and quota read returned HTTP401 token_revoked; stderr confirmed refresh-token revocation. No model turn. PID67860 exited0. Cached codex login status had misleadingly reported signed-in.

## auth-after.json

Action: supported codex login browser OAuth flow, no logout or API key creation and no direct credential-file access. Native CLI returned Successfully logged in. The same fresh-process refresh and quota check then returned an authenticated ChatGPT account and quota data, with no revocation evidence. PID73736 exited0. No identity, token or quota details recorded. This verifies control-plane authentication, not a model inference request.

## check-native-auth.mjs

Exact standalone diagnostic, imported from the Cruise AppServerClient; manual command node check-native-auth.mjs <output.json>. Before/after commands used the same script with an absolute source import, reproduced here with its repository-relative import. Uses a fresh process, account/read(refreshToken:true), account/rateLimits/read, 25s deadline, no turn/start. Original command ran with native host approval because nested sandbox app-server startup previously failed. It records only credential availability, error codes and revocation flags, never credentials/identity. Native sign-in was codex login; the CLI returned Successfully logged in and its listener exited.

## delivery-attempts.json

The user explicitly authorized notifying session 01a1c523-38be-7470-88e0-a2456cee81f0 after repair. The native thread connector could not resume it because an active writer held it. Its existing cmux terminal showed the same current local-workshop task, but automatic approval review rejected sending while active because that might interrupt or duplicate work. No message was sent in these attempts, and the denial was not bypassed. Delivery is pending an observed idle boundary.

## auth-after-latest.json

The same fresh native refresh+quota check was repeated immediately before the queued notice after the long implementation run. Both account and quota were available; no revocation/reuse evidence; PID47951 exited0. No model turn or identity recorded.

## retry-notice.txt

Exact owner-authorized informational message, submitted once to the target session via the existing enabled native cmux hook inbox, not terminal input. It requests one bounded retry at a safe step and preserves completed work and local-only scope. Native help documents that this queue cannot land in a half-written prompt. Inbox status was receiving=true/messages_enabled=true before submission; no permission/setting changes. Submission returned queued message abbbe4b7-64fd-4d4d-8d95-4af30c8a18e1, recipient_has_agent=true. Queued is not yet confirmed delivered/read.

## auth-policy-update.json

SHA-256 precondition and exact appended standing instruction for /Users/agent/.codex/AGENTS.md, authorized by the owner’s 2026-11-14 request to automatically launch supported login endpoints on confirmed expiry/revocation. Existing rules were preserved; no credential/config file changed. The environment subsequently supplied the updated AGENTS instruction explicitly.

## preserved-caller-focused.log

After the supervised Goal exited Bad Request, parent ran node --test tests/auth-recovery.test.mjs tests/auth-recovery-runtime.test.mjs tests/simple-worker.test.mjs tests/quota-guard.test.mjs tests/bootstrap-resilience.test.mjs tests/simple-session.test.mjs on the preserved source. Node v24.14.0: 164 passed, 0 failed. All login, app-server and provider model behavior in these tests is mocked. This is intermediate evidence, before CLI/Claude activation; it does not prove final integration or live third-party sign-in.

## notice-status.json

Native cmux inbox metadata filtered to the exact queued notice ID. No messages were marked read, no other message bodies retained. Latest observation queued, delivered_at/read_at null: submission is confirmed, consumption is not.

## artifact-digests.json

SHA-256 of the sanitized incident and notice artifacts, excluding this manifest itself. No secrets or account identity values are stored.
