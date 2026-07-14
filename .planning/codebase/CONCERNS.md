# Codebase Concerns

**Analysis Date:** 2026-07-14

## Tech Debt

**Large monolithic module files:**
- Issue: Five core library modules exceed 4000 lines each, making them difficult to understand, test, and modify without unintended side effects
- Files: `scripts/lib/provision-policy.mjs` (5131 lines), `scripts/lib/build-queue-coordinator.mjs` (4350 lines), `scripts/lib/build-discovery.mjs` (4113 lines), `scripts/lib/build-contract.mjs` (4002 lines), `scripts/lib/milestone-controller.mjs` (3987 lines)
- Impact: Increased cognitive load for maintainers; harder to isolate bugs and test edge cases; PR reviews become more challenging
- Fix approach: Incrementally refactor by extracting cohesive internal utilities into separate modules (`_helpers.mjs` files). Prioritize build-queue-coordinator.mjs first due to its critical queue management role. Extract state transitions, validation logic, and history management into focused modules.

**Complex state machine with WeakMap bindings:**
- Issue: `scripts/lib/provision-policy.mjs` uses 32+ WeakMaps/WeakSets (lines 110-152) to track internal state relationships, making it impossible to inspect state in debuggers or logs
- Files: `scripts/lib/provision-policy.mjs` (lines 110-152), `scripts/lib/build-queue-coordinator.mjs` (lines 33, 58)
- Impact: Debugging capability loss; no way to log or inspect object-to-object bindings; potential for hard-to-find reference cycles
- Fix approach: Document the WeakMap/WeakSet bindings with inline maps for debugging. Consider storing keys alongside values with a weakly-indexed companion object for inspection during development. Add DevTools serialization hooks.

**Intricate session state coordination:**
- Issue: `scripts/lib/session.mjs` manages complex interleaved state across preparation, activation, and execution phases with multiple promise races and timeout guards
- Files: `scripts/lib/session.mjs` (1360 lines), particularly lines 298-507 (run method), lines 1197-1254 (reconciliation logic)
- Impact: Race conditions possible during concurrent turn handling; unclear recovery from app-server disconnection during uncertain activation states; difficult to add new phases or refactor without introducing subtle bugs
- Fix approach: Extract phase state machine into separate class with explicit state transition rules. Add invariant assertions at phase boundaries. Create visual state diagram documentation. Add comprehensive logging for phase transitions with stack traces.

## Known Bugs

**Goal activation uncertainty reconciliation edge case:**
- Symptoms: If Goal activation RPC partially completes (set succeeded but read timed out), reconciliation may loop indefinitely waiting for settlement confirmation
- Files: `scripts/lib/session.mjs` (lines 1197-1254, specifically `_reconcileUncertainActivation` method)
- Trigger: Goal activation during high app-server latency + precise timing of RPC settlement near polling deadline
- Workaround: Client stops app-server at reconciliation deadline (line 1252), but this leaves uncertain state on the server
- Improvements: Add explicit counter to polling loop to prevent infinite retry. Add telemetry for reconciliation attempts. Consider storing reconciliation state to disk for recovery across client restarts.

**Plan preview rendering can fail silently:**
- Symptoms: PLAN.md renders with plain text fallback without warning user that Glow/Rich formatters are missing
- Files: `scripts/lib/plan-preview.mjs` (lines 95-108)
- Trigger: `glow` and `python3` (with Rich) are not installed; fallback strips all formatting
- Workaround: User sees unformatted text but review continues
- Current state: Deliberate design decision, but users may not realize formatting is degraded
- Recommendation: Return formatter availability metadata so client can warn user if preferred renderers are unavailable

**App-server connection retry doesn't validate packet integrity:**
- Symptoms: Worker retry with same packet after reconnection may operate on stale state if local state was modified between attempts
- Files: `scripts/cruise.mjs` (lines 618-625, `runWorker` function)
- Trigger: First worker attempt fails with app-server connection block; local state changes; retry with same packet
- Mitigation: Cruise doctor runs before worker, but no explicit packet/baseline hash verification before retry
- Recommendation: Add SHA256 hash of initial state to packet; verify on retry before proceeding

## Security Considerations

**Markdown artifact injection through plan rendering:**
- Risk: Untrusted Markdown from external renderer could inject ANSI sequences that manipulate terminal state (cursor movement, title injection, etc.)
- Files: `scripts/lib/plan-preview.mjs` (lines 56-62, `sanitizeRenderedMarkdown`)
- Current mitigation: Only SGR (Select Graphic Rendition) color codes are retained; CSI and OSC sequences are stripped
- Recommendation: Maintain allowlist of safe ANSI sequences. Add test coverage for OSC link injection and cursor movement attempts. Consider rendering to terminal using safer library than raw string concatenation.

**Sensitive data in WeakMap debugging:**
- Risk: Provision-policy WeakMaps store auth tokens, credentials, and capability identifiers without any serialization guards; if internal state is accidentally logged, sensitive data leaks
- Files: `scripts/lib/provision-policy.mjs` (lines 135-152 auth-related WeakMaps, particularly AUTH_JOB_PERSISTED_BYTES)
- Current mitigation: WeakMaps are not serializable, so accidental console.log won't expose them; but structured cloning or explicit inspection could leak
- Recommendation: Wrap WeakMap value getters with redaction filter. Add explicit `[util.inspect.custom]` methods to redact sensitive data. Add test to verify no auth tokens appear in error messages.

**Build approval artifact verification window:**
- Risk: Time-of-check-time-of-use (TOCTOU) between approval verification and actual use in milestone controller
- Files: `scripts/lib/session.mjs` (lines 855-862), `scripts/lib/milestone-controller-host.mjs` (lines 115-130)
- Current mitigation: Approvals are immediately verified and stored in memory; milestone controller reads from session object, not disk re-read
- Recommendation: Add explicit version/digest marker to approval object; verify digest matches at controller bootstrap (already done, see line 232 in milestone-controller-host.mjs). Consider adding heartbeat to detect if approvals change between capture and use.

**Sandbox escape risk through symlinks in CODEX_HOME:**
- Risk: Runtime CODEX_HOME isolation assumes no pre-existing symlinks; if source ~/.codex contains symlink to /etc or other sensitive location, isolation is bypassed
- Files: `scripts/lib/app-server-runtime.mjs` (lines 40-70, `createIsolatedAppServerRuntime`)
- Current mitigation: Creates fresh temp directory and copies files; but initial source validation is missing
- Recommendation: Add lstat check on source CODEX_HOME to reject symlinked directories. Recursively verify all copied paths resolve within isolation boundary after copy.

## Performance Bottlenecks

**YAML state serialization on every coordinator update:**
- Problem: Build queue coordinator writes full queue state YAML file on every state change
- Files: `scripts/lib/build-queue-coordinator.mjs` (lines 1872, 1929, 2075, 2204, 2482 - all writeYamlFile calls)
- Cause: No batching or diff-only writes; state grows as queue executes
- Improvement path: Implement write batching with 100ms debounce. Add delta format for incremental updates. Create compaction strategy to remove completed phases from active queue state (archive to historical record).

**Repository baseline capture loops file-by-file:**
- Problem: Large repositories with many files cause long initialization delays; git commands are re-run unnecessarily
- Files: `scripts/lib/origin.mjs` (lines 324-391, baseline capture loop)
- Current: No caching of git output between runs; each call to git ls-files, git diff-index, etc. re-scans entire tree
- Improvement path: Cache git baseline output for 5 minutes per repository (if HEAD hasn't changed). Add memoization for repeated calls. Profile large monorepo (10K+ files) to identify slowest git operations.

**Provision state WeakMap lookups scale poorly with many capabilities:**
- Problem: 32+ WeakMaps must be checked sequentially to find capability metadata; no indexing
- Files: `scripts/lib/provision-policy.mjs` (lines 110-152)
- Current: Each capability lookup iterates through multiple WeakMaps
- Improvement path: Add single indexed Map<capability, metadata> that mirrors WeakMap bindings. Keep WeakMap for automatic GC; use Map for fast lookups.

**Session interaction serialization through _interactionTail promise chain:**
- Problem: All user input interactions serialize through single promise chain; can cause visible UI delay if multiple requests arrive
- Files: `scripts/lib/session.mjs` (lines 556-571, `_enqueueRequest` and `_interactionTail`)
- Cause: Design choice to ensure ordered responses; but high-latency approval requests block subsequent user input
- Improvement path: Parallelize independent requests while maintaining order only for request/response pairs from same message ID. Add request prioritization for cancellations and critical paths.

## Fragile Areas

**Milestone controller bootstrap in uncertain state:**
- Files: `scripts/lib/session.mjs` (lines 437-455), `scripts/lib/milestone-controller-host.mjs` (lines 115-270)
- Why fragile: Bootstrap must validate Goal state hasn't changed mid-bootstrap; multiple error recovery paths (lines 1143-1195); if controller fails to start, Goal must be left in paused state without corruption
- Safe modification: Add explicit state checkpoints and rollback markers. Test controller bootstrap failure scenarios with Goal in every possible state (paused, active, complete, blocked). Add integration test that simulates network partitions during bootstrap.
- Test coverage: `tests/milestone-controller.test.mjs` covers normal flow, but error path testing is limited

**Plan approval capture and verification window:**
- Files: `scripts/lib/goal-contract.mjs` (lines 145-225, approval capture), `scripts/lib/session.mjs` (lines 739-788, approval handling)
- Why fragile: Captures artifacts, verifies sha256, then user selects "Approve Plan"; if PLAN.md or ALIGNMENT.md modified between capture and approval, verification fails with unclear error
- Safe modification: Add explicit "re-capture" option if verification fails. Show user the captured bytes hash before approval to prevent surprise mismatch.
- Test coverage: `tests/goal-contract.test.mjs` has happy path; missing tests for mid-approval artifact changes

**App-server connection block recovery retry logic:**
- Files: `scripts/cruise.mjs` (lines 618-625), `scripts/lib/app-server-runtime.mjs` (lines 17-21, retry instructions)
- Why fragile: Retry assumes same packet + same cwd will succeed after host escalation; but if host permission grants were temporary, retry fails silently with same error
- Safe modification: Track retry count in packet metadata. Add telemetry for successful vs failed retries to surface patterns. Fail with actionable message after 1 retry (don't loop).
- Test coverage: No integration test for app-server connection block + retry scenario

**Provision capability DAG cycle detection:**
- Files: `scripts/lib/provision.mjs` (lines 135-144, ProvisionCycleError), provision-policy.mjs (lines 600+)
- Why fragile: Cycle detection runs once during initialization; if DAG changes mid-execution, cycles aren't caught until next operation
- Safe modification: Add incremental cycle check after each capability addition. Cache topological sort to detect changes.

## Scaling Limits

**Build queue state history YAML size:**
- Current capacity: 8MB hard limit per `.cruise/runs/<run-id>/state.yaml` (lines 29 in build-queue-coordinator.mjs)
- Limit: Large builds with 100+ phases × 10 attempts per phase = 1000+ state transitions; YAML overhead makes hits likely for long-running projects
- Scaling path: Compress historical records. Archive completed phases. Implement rolling log format (newest entries, oldest archived to `.state-archive/`).

**Provision run state maximum nodes:**
- Current: 1024 max nodes (provision.mjs line 123, PROVISION_RUN_MAX_NODES)
- Limit: Complex projects with many parallel capability requirements hit ceiling
- Scaling path: Increase limit to 2048 or implement subgraph isolation (each subgraph capped at 256 nodes).

**Repository baseline capture limits:**
- Current: 8MB total file content, 1GB git command output, 32K files per repository
- Limit: Large monorepos (100K+ files) cannot be analyzed
- Scaling path: Add streaming git output processor. Implement sampling strategy for baseline capture (random file selection up to limit). Support .gitignore-based filtering.

**Session file size limits:**
- Current: 4MB isolated app-server state (milestone-controller-host.mjs line 41)
- Limit: Goals with very large artifacts (PLAN.md > 1MB) cannot bootstrap milestone controller
- Scaling path: Stream artifact reading instead of full load. Implement artifact compression/decompression.

**Concurrent worker limit:**
- Current: No documented limit on simultaneous `cruise worker` processes; only per-process resource limits apply
- Risk: Unbounded worker spawning could exhaust system resources
- Scaling path: Document recommended max concurrent workers (suggest 4-8). Add worker pool with bounded queue. Implement backpressure when workers exceed limit.

## Dependencies at Risk

**Runtime dependence on Glow markdown renderer (optional):**
- Risk: Plan preview degrades to plain text without warning if glow is not in PATH
- Files: `scripts/lib/plan-preview.mjs` (line 98)
- Impact: Review experience reduced but functional
- Migration plan: Consider bundling lightweight Markdown renderer (Marked.js or similar) to reduce external dependency. Warn user if preferred renderer unavailable.

**Runtime dependence on Python3 for Rich fallback:**
- Risk: Plan preview falls back to plain text if python3 or Rich library is unavailable
- Files: `scripts/lib/plan-preview.mjs` (line 101)
- Impact: Limited, plain text fallback works
- Migration plan: Document in installation guide that python3+rich improves UX. Consider providing pre-compiled alternative renderer.

**App-server stdio stability:**
- Risk: If Codex app-server changes stdio protocol or adds new request types, existing clients break
- Files: `scripts/lib/app-server-client.mjs` (request/response handling)
- Mitigation: `scripts/cruise.mjs` validates app-server has `--stdio` support (line 455)
- Recommendation: Add version negotiation to app-server client. Accept new request types gracefully with rejection.

**Tight coupling to Codex Goal API:**
- Risk: If native Goal API changes (thread/goal/get, thread/goal/set methods), Cruise breaks
- Files: `scripts/lib/session.mjs` (lines 1056, 1107, 1134, 1172 - goal RPC calls), `scripts/lib/goal-contract.mjs` (lines 415-422, activation)
- Mitigation: Validation suite checks Goal activation contract (validate-suite.mjs line 473-483)
- Recommendation: Add graceful fallback for older Codex versions. Document minimum Codex version and upgrade path.

## Missing Critical Features

**No resume of interrupted sessions across restarts:**
- Problem: If Cruise client crashes or is terminated mid-execution, session state is lost; user must restart from beginning
- Blocks: Long-running Goals cannot survive client restart; production workflows require persistence
- Recommendation: Serialize session state to `.cruise/goal/.session.yaml` on every phase transition. Add `cruise resume` command to reconnect to existing thread.

**No explicit Goal failure diagnosis:**
- Problem: If Goal reaches 'blocked' or 'failed' status, Cruise only shows final status without diagnostic details
- Blocks: Understanding why Goal failed requires re-running debug skill separately
- Recommendation: Capture Goal failure context (final error message, last turn output) and display with actionable remediation suggestions.

**No worker performance profiling:**
- Problem: No visibility into which phases consume most time/tokens; difficult to optimize expensive phases
- Blocks: Billing optimization and latency reduction for large projects
- Recommendation: Add per-phase timing and token usage metrics to worker report. Aggregate across phases in coordinator.

**No explicit write scope auditing:**
- Problem: No easy way to preview what files a worker will modify before approval
- Blocks: High-confidence approval of changes
- Recommendation: Add `cruise preview <skill>` command that shows diff without executing.

## Test Coverage Gaps

**App-server connection failure recovery paths:**
- What's not tested: Host connection block detection + retry scenario; state validation on retry; repeated connection failures
- Files: `scripts/cruise.mjs` (lines 618-625), no integration test
- Risk: Retry logic silently fails if packet state changed between attempts
- Priority: High - affects production reliability

**Milestone controller bootstrap failure modes:**
- What's not tested: Controller fails to start after Goal activation succeeds; Goal must be paused safely without corruption
- Files: `scripts/lib/session.mjs` (lines 1143-1195)
- Risk: Orphaned Goal in undefined state
- Priority: High - data loss risk

**Session state machine edge cases:**
- What's not tested: Concurrent cancellation (Ctrl+C) during phase transitions; multiple simultaneous app-server notifications; rapid turn completions
- Files: `scripts/lib/session.mjs` (lines 556-727)
- Risk: Race conditions causing dropped requests or duplicate processing
- Priority: Medium - edge case but impacts UX

**Provision DAG validation with circular dependencies:**
- What's not tested: Capabilities with self-referencing fallback chains; complex indirect cycles; cycle detection correctness for large DAGs (100+ nodes)
- Files: `scripts/lib/provision.mjs` (lines 135-144), `scripts/lib/provision-policy.mjs` (cycle detection logic)
- Risk: Infinite loops in provisioning
- Priority: Medium - low frequency but high impact

**Plan approval artifact mutation between capture and review:**
- What's not tested: PLAN.md or ALIGNMENT.md modified by background process after capture but before approval
- Files: `scripts/lib/session.mjs` (lines 739-788)
- Risk: Approved Plan doesn't match what user reviewed
- Priority: Medium - requires external write to .cruise/goal during review

**YAML parsing robustness:**
- What's not tested: Corrupted state.yaml files; missing required YAML fields; version mismatches; malformed dates in timestamps
- Files: All `parseYaml`, `readYamlFile` calls (15+ locations)
- Risk: Hard crash instead of graceful recovery with actionable error message
- Priority: Low - but would improve diagnostic experience

---

*Concerns audit: 2026-07-14*
