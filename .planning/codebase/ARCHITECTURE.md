# Architecture

**Analysis Date:** 2026-07-14

## Pattern Overview

**Overall:** Root-Coordinator + Bounded-Worker plugin architecture

**Key Characteristics:**
- Root agent maintains full control; model never changes after initial setup
- Every substantive work phase runs in a bounded worker thread with strict isolation
- Deterministic routing based on origin-aware semantic probe
- Two-phase approval model: Plan approval (locks contract bytes) → Start authorization (activates Goal)
- Immutable origin preservation: every request and state captured with SHA-256 digests
- Private capability provisioning with opaque attestation authorities
- Six public skills with seven worker levels providing tiered reasoning capacity

## Layers

**CLI Layer:**
- Purpose: Terminal entry point and interactive user interface
- Location: `scripts/cruise.mjs`
- Contains: Command parsing, help text, diagnostic checks, skill launching, picker demo
- Depends on: App-server runtime, session, agent-config, model-policy
- Used by: Direct terminal invocation

**Session & Coordination Layer:**
- Purpose: Manages complete user journey from request through approval to Goal activation
- Location: `scripts/lib/session.mjs`
- Contains: Session state machine, client lifecycle, thread management, approval capture
- Depends on: Goal-contract, build-contract, milestone-controller, interaction broker
- Used by: CLI layer via CruiseSession class

**Skill & Routing Layer:**
- Purpose: Deterministic mapping of requests to appropriate workflow
- Location: `scripts/lib/routing.mjs`, `skills/*/SKILL.md`
- Contains: 18 Quick hard-gate signals, semantic evidence collection, confidence scoring
- Depends on: yaml-state, model-policy, origin validation
- Used by: Session during initialization phase

**Contract & Approval Layer:**
- Purpose: Capture, validate, and lock user approvals with opaque attestations
- Location: `scripts/lib/goal-contract.mjs`, `scripts/lib/build-contract.mjs`
- Contains: ORIGIN.yaml/PLAN.md/GOAL.md validation, approval snapshots, digest computation
- Depends on: yaml-state, origin, evidence
- Used by: Session for approval capture and verification

**Worker Management Layer:**
- Purpose: Spawn and manage bounded worker threads with strict permission envelopes
- Location: `scripts/lib/worker-session.mjs`, `scripts/lib/worker-policy.mjs`
- Contains: Worker packet assembly, level selection, execution boundaries, report capture
- Depends on: app-server-client, model-policy, run-state
- Used by: Session for every substantive task (mapping, planning, implementation, verification)

**Milestone Controller Layer:**
- Purpose: Hierarchical coordination for multi-phase milestone execution
- Location: `scripts/lib/milestone-controller.mjs`, `scripts/lib/milestone-controller-host.mjs`
- Contains: Phase DAG validation, just-in-time phase planning, phase state machine
- Depends on: goal-contract, build-contract, yaml-state, evidence
- Used by: Session when milestone-controller mode is selected

**State & Persistence Layer:**
- Purpose: Immutable state capture and recovery across restarts
- Location: `scripts/lib/yaml-state.mjs`, `scripts/lib/run-state.mjs`, `scripts/lib/origin.mjs`
- Contains: YAML serialization, SHA-256 digests, baseline capture, resilience structures
- Depends on: Node fs/crypto APIs
- Used by: All layers for state management

**Build Queue Layer:**
- Purpose: Persisted DAG of approved work items with atomic state transitions
- Location: `scripts/lib/build-queue-coordinator.mjs`
- Contains: Queue state machine, work-item admission, evidence validation, lineage tracking
- Depends on: build-contract, yaml-state, evidence
- Used by: Session during Build phase execution

**Interaction Broker Layer:**
- Purpose: Mediates user input and approval choices with opaque structured authority
- Location: `scripts/lib/interaction.mjs`, `scripts/lib/picker.mjs`
- Contains: User input handling, plan review options, Goal activation confirmation
- Depends on: line-input, readline promise interface
- Used by: Session for every user-facing question and approval

**Infrastructure Layers:**
- **App Server Client:** `scripts/lib/app-server-client.mjs` - RPC transport to Codex app-server
- **Model Policy:** `scripts/lib/model-policy.mjs` - Resolves worker level to tier/reasoning-effort
- **Evidence:** `scripts/lib/evidence.mjs` - Evidence collection and validation
- **Traceability:** `scripts/lib/traceability.mjs` - Request ID and turn tracking

## Data Flow

**Request to Skill Selection:**

1. CLI parses arguments and creates `CruiseSession`
2. Session establishes app-server connection via `AppServerClient`
3. Session captures immutable `ORIGIN.yaml` with exact prompt bytes and SHA-256
4. Session invokes bounded Level-2 worker to analyze repository and answer Quick gates
5. Routing layer computes confidence score for each public skill
6. Skill selection occurs: highest confidence if > 0.85 threshold, else user chooses
7. Recommended level determined: 1 (support), 2-3 (Quick), 3 (normal), 5-7 (consequential)

**Planning Phase:**

1. Session launches corresponding skill in preparation mode
2. Skill asks one highest-impact material question at a time via `request_user_input`
3. Session captures each answer in immutable decision ledger
4. For Goal: worker writes SPEC.md, DECISIONS.md, ALIGNMENT.md, PLAN.md to `.cruise/goal/`
5. For Build: worker writes discovery artifacts to `.cruise/project/discovery/`
6. Skill computes artifact SHA-256 digests for approval snapshot

**Approval Phase:**

1. Session presents plan review with exact artifact snapshot
2. User selects exact case-sensitive "Approve Plan" to lock bytes
3. Session revalidates all artifact bytes match digests before compilation
4. For Goal: session compiles GOAL.md with file references and completion fence
5. For Build: session calls `prepareBuildApprovalReview` for opaque verification
6. Session captures approved manifest and receipt in immutable digest-bound record

**Activation Phase (Goal only):**

1. Session validates immutable raw-prompt hash against baseline
2. Session recomputes repository and artifact identities (baseline drift check)
3. Session switches thread from Plan mode to Default mode via `thread/settings/update`
4. Session calls `thread/goal/set` exactly once with GOAL.md reference
5. Native Goal harness takes over; session ends without calling `create_goal`

**Execution Phase (worker loop):**

1. Session launches bounded worker for each ready node with locked task packet
2. Worker receives: origin, baseline snapshot, permissions, task ID, evidence gates, limits
3. Worker implements only in-scope changes within permission envelope
4. Worker captures attempt details in immutable report (never updated after return)
5. Session appends report to CLOSEOUT.md, integrates sibling work, validates evidence gates
6. Session advances safe disjoint nodes in parallel; serializes through ownership conflicts

**Milestone Controller Phase Loop:**

1. Controller reconciles repository identity and prior closeout
2. Controller activates only ready phase (all prerequisites satisfied)
3. Controller resolves material phase questions (if any)
4. Controller attests phase PLAN bytes, ownership, permissions, baseline
5. Phase executes as normal Goal phase with permission scope from milestone
6. Controller captures phase closeout, validates mandatory PASS coverage
7. Controller advances baseline to post-phase state before next phase
8. Milestone complete only after all phases closeout with aggregate fence attestation

**State Management:**

- **Immutable:** ORIGIN.yaml (exact prompt bytes), approved contract artifacts, attempt reports
- **Mutable before approval:** discovery artifacts, draft PLAN.md, draft GOAL.md
- **Immutable after approval:** all approved contract bytes (hash digests locked)
- **Append-only:** DECISIONS.md ledger, CLOSEOUT.md node reports, queue history
- **Version-controlled via opaque attestation:** queue state revisions, phase state

## Key Abstractions

**Origin Record:**
- Purpose: Immutable capture of triggering request with repository baseline
- Examples: `ORIGIN.yaml`, `.cruise/goal/ORIGIN.yaml`, `.cruise/project/ORIGIN.yaml`
- Pattern: Contains exact UTF-8 prompt bytes, SHA-256 digest, repository root, baseline tree hash
- Validated on: Every approval, resumption, and Goal activation

**Artifact Approval Snapshot:**
- Purpose: Bind approval decision to exact locked bytes
- Examples: Plan approval digest, Build approval receipt, Goal file snapshot
- Pattern: Captures SHA-256 of each artifact; approval revalidates every byte matches
- Protection: Drift after approval invalidates approval; requires revision and reapproval

**Worker Level & Model Policy:**
- Purpose: Map work scope to exact model tier and reasoning effort
- Examples: Level 3 → terra-H (high reasoning), Level 7 → sol-U (ultra reasoning)
- Pattern: Level determined deterministically; workers never request or change level
- Constraint: Level 1 reserved for coordination support only

**Permission Envelope:**
- Purpose: Define precise boundaries for worker writes, effects, and approvals
- Examples: `.cruise/goal/` writes only during preparation, no artifact edits after approval
- Pattern: Captured in task packet; worker cannot exceed envelope
- Validation: Explicit permission request required for external effects

**Opaque Attestation Authority:**
- Purpose: Machine-verifiable proof of user choice without exposing logic
- Examples: Build approval receipt, Goal activation authority, phase-closeout attestation
- Pattern: Returned by private host-interaction broker; consumed exactly once
- Constraint: Typed labels, copied records, or digest alone cannot substitute

**Evidence Gate:**
- Purpose: Checkpoint requiring specific PASS evidence before advancement
- Examples: Acceptance criteria in PLAN.md, verification gates in GOAL.md
- Pattern: Worker captures evidence; coordinator checks evidence type and performs revalidation
- Stopping: Node blocks if evidence missing; no waiver without contract revision

## Entry Points

**Terminal CLI:**
- Location: `scripts/cruise.mjs`
- Triggers: `cruise [start] [options] <request...>` or `cruise <command>`
- Responsibilities: Parse args, validate Codex version, launch appropriate command handler

**Skill Invocation (Codex):**
- Location: Skills registered in `.codex-plugin/plugin.json`
- Triggers: `$cruise:build`, `$cruise:quick`, `$cruise:refine`, `$cruise:goal`, `$cruise:debug`, `$cruise:research`
- Responsibilities: Receive skill launch from Codex app-server, execute skill phase, return result

**Worker Invocation:**
- Location: `scripts/cruise.mjs` worker subcommand
- Triggers: `cruise worker --level <1-7> -C <root> --packet <yaml> --report <yaml>`
- Responsibilities: Deserialize bounded task packet, execute work, capture report

**Health Check:**
- Location: `scripts/cruise.mjs doctor` command
- Triggers: `cruise doctor [--json]`
- Responsibilities: Validate Codex version, app-server capability, model catalog, agent configs

## Error Handling

**Strategy:** Three-tier error model: transient vs. hard vs. uncertain

**Patterns:**

- **CruiseInterruptedError:** User cancelled via Ctrl+C or external signal; graceful pause
- **GoalActivationUncertainError:** RPC timeout or disconnect during Goal set; uncertain if committed; recorded but blocks further work
- **Schema Validation:** YAML schema mismatch blocks operation; never auto-repair
- **Baseline Drift:** Repository changes after origin capture; blocks approval revalidation and activation
- **Digest Mismatch:** Approved artifact bytes changed; invalidates approval; requires re-approval
- **Worker Hard Failure:** Tool failure surfaces immediately; level change creates new attempt
- **Model Catalog Missing:** Worker selection blocked if required tier/effort unavailable; escalates to user

## Cross-Cutting Concerns

**Logging:** 
- No internal logging framework; stderr used only for user-facing progress messages
- Diagnostic output via `cruise doctor --json` for troubleshooting
- Examples: `scripts/lib/session.mjs` writes plan/goal status, app-server diagnostic on failure

**Validation:**
- Strict schema validation via `assertYamlSchema` for all persisted state
- Immutable artifact digests revalidated on every approval and activation step
- Repository baseline captured and verified to detect drift
- Hard gates in routing enforced: baseline must exist, digests must match

**Authentication:**
- No credential collection in CLI (Codex manages auth to app-server)
- Build approval uses opaque host-provided attestation; no signature/token in artifacts
- Capability provisioning enters `waiting_auth` state if auth required; pauses dependent work

**Permissions:**
- Explicit permission envelope in task packet; worker cannot exceed
- Pre-approval and pre-execution permission requests via `item/permissions/requestApproval`
- Dangerous authorization (interactive mode) requires separate digest-bound warning + token
- Effect scope strictly limited: no dynamic callers, no external side effects without approval

---

*Architecture analysis: 2026-07-14*
