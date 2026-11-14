# Automatic authentication recovery evidence — 2026-11-14

Baseline afd0864. Node v24.14.0, installed Codex0.169.0. User requested automatic supported login flow on confirmed expired/revoked credentials. All implementation verification below mocks provider/login/browser calls and does not perform real model inference. Actual sign-in incident and queued notice are separately recorded under ../credential-revocation-incident/.

## activation-focused.tap

Managed L5 worker: node --test --test-reporter=tap tests/auth-recovery.test.mjs tests/auth-recovery-runtime.test.mjs tests/auth-recovery-cli.test.mjs tests/claude-cli.test.mjs. 50 passed,0 failed. Mocked verification only; covers non-TTY macOS activation, fresh Codex account/quota verification, native captured-Claude contracts, account-switch/override rejection, cleanup failure and no-replay behavior. Source worker explicitly leaves inherited Claude terminal interception unsupported.

## cli-compatibility.log

Parent: node --test tests/cli-simple.test.mjs.54 passed,0 failed after upgrading one request-sequence expectation and two mock clients for the newly activated account/rateLimits/read preflight. No production behavior was disabled to satisfy old fixtures.

## preserved-focused.log

Parent after transport loss: node --test tests/auth-recovery.test.mjs tests/auth-recovery-runtime.test.mjs tests/simple-worker.test.mjs tests/quota-guard.test.mjs tests/bootstrap-resilience.test.mjs tests/simple-session.test.mjs.164 passed,0 failed. Intermediate evidence before final CLI activation.

## full-tests-initial.log

First stable activation npm run validate invokes pretest (38 passed) and npm test (550 tests:547 passed,3 failed). The three staged-launcher transcript fixtures had no account/rateLimits/read response and could not reach readiness. Parent added the missing mocked authority response, preserving parent-ownership and acceptance assertions; no production policy was relaxed.

## bootstrap-compatibility.log

Parent command node --test tests/bootstrap-resilience.test.mjs after the staged mock upgrade:34 passed,0 failed. Only the fixture response was added; startup ownership and cancellation assertions retained.

## independent-review.json

Fresh managed L5 read-only source review deduced P1 missing-original-identity adoption and P2 cancelled-waiter cleanup crossing ownership. It ran no tests or live provider calls. Concrete regressions and fixes were commissioned before final verification. The review did not endorse ignored live-evidence files.

## review-regression-before.log

Managed L5 repair worker added deterministic synthetic native-client/coordinator repros first. Command: node --test --test-name-pattern='identity regression|lifecycle regression' tests/auth-recovery-runtime.test.mjs. Before fixes:5 expected failures,2passes. Missing original identity and trusted-prior account-switch cases could recover under another account; cancelled waiter stopped the active leader verifier. No real provider/login/browser/model.

## review-regression-after.log

Same7 targeted repros pass after fixes; subsequent node --test tests/auth-recovery.test.mjs tests/auth-recovery-runtime.test.mjs tests/auth-recovery-cli.test.mjs exits0. Supported login still launches when original identity is missing, but returns owner-identity-confirmation-required pause6 and never starts model work. Only lease owner cleans verification clients; cancelled waiter does not stop leader. Same-account path and prior metadata checks retained.

## protocol-contract.json

Installed codex-cli0.169.0 command codex app-server generate-json-schema --out /private/tmp/cruise-autoauth-protocol. Parent inspected bounded GetAccountParams/GetAccountResponse/GetAccountRateLimitsResponse fields and recorded their SHA-256 plus relevant account/rate-limit schema. This is directly inspected schema, not authentication evidence or formal proof; no credential values present.

## full-tests.log

Final stable-source npm run validate through job_logging.sh foreground driver (canonical log plus live tee and ordered replay). This invokes npm pretest47/47 and npm test550/550,597 total,0 failed. Node v24.14.0. No real model, login or browser calls in unit/integration tests. Rerun was justified by the actual initial fixture failures and subsequent causal review repairs.

## completion-review.md

Parent source/evidence synthesis and scope review. Distinguishes the live manual Codex login from mocked automatic recovery and the queued notification from acknowledged delivery. Two independent findings are resolved by reproduced regressions and reviewed causal changes; no formal proof or live third-party compatibility guarantee.

## execution-summary.json

Partial launcher telemetry for root thread01a1da18-3581-7cc1-aba8-c2aaac008931, high-watermark totals only. Root GPT-5.6Sol high; bounded workers routedL5. Aggregate task/worker costs and authoritative weekly delta are unknown; no credit or quota compliance total is invented. The supervised Goal ended Bad Request; its completed edits were preserved and finished through bounded workers and parent integration.

## teardown.json

Final native read-only ps snapshot matched only recorded task PIDs/groups and isolated-worktree command ownership. No live task-owned jobs were found. Completed login, probe, Goal, worker, review and test sessions are recorded. Other sessions/review server were excluded from termination.

## artifact-digests.json

SHA-256 manifest of every other file in this evidence directory after packaging. Generated with Python hashlib, excluding itself. No credential data is included.
