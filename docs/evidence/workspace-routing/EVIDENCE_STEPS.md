# Evidence steps — workspace routing repair

Date: 2026-11-14. Input source baseline: 5c07634; concurrent 7ec6122 was incorporated before the final repair. Evidence kinds: directly inspected traces/source, controlled authenticated no-model runtime probes, mock regression tests, and explicit deductions. No formal proof or research-model execution is claimed.

## README.md

Parent synthesis of the artifacts below. It reports controlled observations and deductions, not formal proof; research execution remains unrun.

## original-failure-excerpts.json

Input: exact rollout 01a1d754-8e8a-7b41-8eb3-7f6e905d2eee, lines 592, 593, 596 and 618. Deterministic JSON extraction retained only original command failures and the quoted fallback message. Both launches exited 1 with the same error. No unrelated conversation content was extracted.

## probe-network-and-isolation.mjs

Manual macOS diagnostic source, Node v24.14.0, Codex CLI 0.169.0, Cruise source 0.4.3. Existing authentication is used through native APIs; no auth files copied/read by the diagnostic. Each app-server is stopped; no turn/start is sent. Fixtures use realpath to avoid /var alias mismatches and are removed in finally. This is outside the mock-only unit suite.

## authenticated-network-controls.json

Command: node docs/evidence/workspace-routing/probe-network-and-isolation.mjs network docs/evidence/workspace-routing/authenticated-network-controls.json (native execution). Sequence: initialize, model/list, account/read(refreshToken:false), account/rateLimits/read, ephemeral thread/start; 25s deadline per child. Normal and broad-Unix control succeeded. Original restriction, explicit roots and loopback variants failed at account/read with exact -32603 error. Broad Unix is a diagnostic control only and was not applied to the original profiles. Each child exited 0; modelTurns=0.

## canonical-resolver-controls.json

Command: node docs/evidence/workspace-routing/probe-network-and-isolation.mjs canonical docs/evidence/workspace-routing/canonical-resolver-controls.json (native). Same sequence/deadlines. /var/run alias failed at account/read; canonical /private/var/run/mDNSResponder allowed account, rate-limit and thread startup. Deduced causal requirement is specific to this observed host/network boundary, not every generic account-routing error. Network controls do not test the full original research environment.

## filesystem-isolation-controls.json

Command: node docs/evidence/workspace-routing/probe-network-and-isolation.mjs filesystem docs/evidence/workspace-routing/filesystem-isolation-controls.json (native). Synthetic own/sibling files under canonical task-owned temporary root, original deny/allow pattern plus resolver clause. Acceptance: own cat/touch exit0; sibling cat/touch nonzero with permission denial. Observed 0,1,0,1 respectively. An initial harness using /var aliases was corrected to realpath before recording this final artifact. This does not establish isolation against all OS IPC mechanisms.

## wrapper-repair-plan.json

Prepared before/after SHA-256 and exact addition for only branch1/isolation.sb and branch2/isolation.sb. Native repair checked both preconditions before replacing either file atomically, preserving mode. No launcher, user document, worker state, quota policy or other conversation was changed. Old working directories were absent; no research restart attempted.

## branch1-isolation-before.sb

Direct bounded snapshot of retained original branch1 policy, used as exact repair input. Contains no authentication material. Digest in wrapper-repair-plan.json.

## branch1-isolation-after.sb

Prepared/applied branch1 policy: one outbound Unix socket literal for /private/var/run/mDNSResponder added. All prior filesystem and TCP/UDP restrictions retained. Applied digest checked against wrapper-repair-plan.json.

## branch2-isolation-before.sb

Direct bounded snapshot of retained original branch2 policy; exact repair input and digest recorded in wrapper-repair-plan.json.

## branch2-isolation-after.sb

Prepared/applied branch2 policy, same resolver-only addition; prior branch-specific filesystem restrictions retained. Applied digest checked against wrapper-repair-plan.json.

## focused-tests.log

Managed implementation worker command: node --test tests/simple-worker.test.mjs tests/quota-guard.test.mjs tests/cli-simple.test.mjs. Node v24.14.0, mock app-server/account transcripts only. 104 passed, 0 failed. Covers exact-vs-qualified error matching, no retry/turn, strict pause6 and parent lease/reservation preservation. Output copied from /private/tmp/cruise-routing-focused-tests.log.

## full-tests-initial.log

First stable-diff npm run validate (aliases npm test), via job_logging.sh foreground driver. 538 tests: 537 passed, 1 failed. Untouched simple-session bootstrap-cleanup test exceeded its 100ms elapsed assertion under parallel suite load (164.94ms). Retained as contrary evidence; no source change was made for it.

## bootstrap-timeout-check.log

Command: node --test --test-name-pattern 'Goal bootstrap timeout cannot hang in diagnostic cleanup' tests/simple-session.test.mjs. 1 passed, 0 failed; 42.86ms test duration. Supports a timing-sensitive failure hypothesis, not proof that the assertion can never fail again.

## full-tests.log

Second npm run validate on unchanged source, warranted by the initial timing failure. Foreground job_logging.sh canonical log; 538 passed, 0 failed, approximately13.87s. npm validate invokes npm test, so no redundant additional full suite. No live model requests in the suite.

## independent-review.json

Fresh managed L5 read-only source review found no concrete bug in inspected source/tests and confirmed concurrent schema retention. Its retrieval rejected ignored live artifacts and it did not inspect the full baseline diff. Parent directly reviewed full task diff, live controls and policy snapshots. Independent endorsement is limited to inspected source/test semantics.

## execution-summary.json

Partial launcher telemetry only, preserved from task-owned Goal thread IDs. Cumulative high-watermark totals are used without summing events. Root Goal: GPT-5.6 Sol high; managed workers routed L5. Standalone worker and parent-host totals and authoritative weekly delta were not fully retained, so aggregate task cost/quota is unknown. This is an accounting limitation, not evidence of an exceeded limit.

## Teardown and integration

Task-owned transport/probe/test processes are checked separately before completion. Main integration preserves the concurrent schema commit and unrelated skills/context-economy.zip. The temporary task worktree and branch are removed after safe integration; no remote publication is authorized here.

## teardown.json

Native read-only ps inventory matched only task-owned recorded PIDs/process groups/command identities; no live task resources remained. Two current corrected wrapper digests matched their prepared after-policy digests. Other conversation was not signaled or messaged. This observation preceded final Git integration; no further persistent jobs were launched.

## artifact-digests.json

SHA-256 of every other file in this evidence directory after final packaging. Generated deterministically with Python hashlib; the manifest does not hash itself. Raw test output and original-failure excerpts are retained without claiming that every failed exploratory candidate was a product defect.
