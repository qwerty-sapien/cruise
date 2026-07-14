# Codebase Structure

**Analysis Date:** 2026-07-14

## Directory Layout

```
cruise/
├── scripts/                    # CLI and core runtime implementation
│   ├── cruise.mjs             # Main entry point (terminal command + subcommands)
│   └── lib/                   # 30+ implementation modules (~12,000 LOC total)
├── skills/                    # Six public skills + references
│   ├── build/                 # Milestone discovery and queue management
│   ├── quick/                 # Small low-risk changes
│   ├── refine/                # Finite plans with material decisions
│   ├── goal/                  # Consequential durable execution
│   ├── debug/                 # Unknown-cause failure diagnosis
│   └── research/              # Evidence-only research
├── internal/                  # Infrastructure and schemas
│   ├── agent-configs/         # Managed agent configuration overlays
│   ├── schemas/               # JSON schema validators
│   ├── provision/             # Capability provisioning rules
│   └── shared/                # Shared invocation contract documentation
├── tests/                     # Node test harness
├── evals/                     # Evaluation suite with fixtures and results
├── .planning/codebase/        # Generated architecture documentation
├── .cruise/                   # Runtime state (runs, goal, project)
├── .codex-plugin/             # Plugin manifest
├── package.json               # Node dependencies and scripts
└── README.md                  # User guide

```

## Directory Purposes

**`scripts/`**
- Purpose: CLI and core implementation
- Contains: Entry point, library modules, runtime coordination
- Key files: `cruise.mjs` (724 lines), `lib/session.mjs` (900+ lines)

**`scripts/lib/`**
- Purpose: Modular implementation of all architectural layers
- Contains: Session control, workers, contracts, routing, state, interaction
- 30+ .mjs files organized by concern (see Key File Locations below)

**`skills/`**
- Purpose: Public skill definitions and reference documentation
- Contains: One SKILL.md per skill, reference guides for each workflow
- Structure: Each skill has `agents/`, `references/` subdirectories

**`skills/goal/`**
- Purpose: Goal skill implementation and reference materials
- Key files:
  - `SKILL.md` - Skill definition and constraints
  - `references/clarification-and-contract.md` - Q&A protocol
  - `references/execution-loop.md` - Runtime execution guidance
  - `references/milestone-controller.md` - Hierarchical phase coordination

**`skills/build/`**
- Purpose: Build skill for project foundation and milestones
- Key files:
  - `SKILL.md` - Bootstrap vs. milestone mode logic
  - `references/discovery-and-viability.md` - Discovery flow
  - `references/queue-approval-and-handoff.md` - Queue contract

**`internal/schemas/`**
- Purpose: JSON schema definitions for state validation
- Contains: State machine schemas, contract schemas, validation rules
- Examples:
  - `build-discovery-state.schema.yaml` - Discovery state machine
  - `goal-contract.schema.yaml` - Goal contract validation

**`internal/agent-configs/`**
- Purpose: Managed agent configuration for seven worker levels
- Contains: Agent definitions for `cruise_l1` through `cruise_l7`
- Used by: `cruise agents install` command

**`tests/`**
- Purpose: Node test suite using native --test runner
- Contains: Unit tests and integration tests
- Key test files:
  - `cli.test.mjs` - CLI parsing and command execution
  - `worker-policy.test.mjs` - Worker level assignment
  - `workflow-policy.test.mjs` - Skill routing logic

**`evals/`**
- Purpose: Evaluation suite for testing skill workflows
- Contains: Test fixtures (G01-G06), oracle ground truth, results
- Results: Pilot evaluation from 2026-07-11

## Key File Locations

**Entry Points:**
- `scripts/cruise.mjs` (724 lines) - Terminal CLI, all commands, argument parsing
- `scripts/lib/session.mjs` (900+ lines) - User session state machine, approval capture
- `skills/*/SKILL.md` - Skill definitions loaded by Codex app-server

**Configuration:**
- `package.json` - Dependencies (Node 20+), scripts, version
- `.codex-plugin/plugin.json` - Plugin manifest with skill registrations
- `.npmignore` - Files excluded from npm distribution
- `internal/agent-configs/` - Worker agent definitions

**Core Logic:**
- `scripts/lib/routing.mjs` - Skill selection logic, Quick hard gates
- `scripts/lib/goal-contract.mjs` - Goal approval and activation flow
- `scripts/lib/build-contract.mjs` - Build approval and queue management
- `scripts/lib/milestone-controller.mjs` - Hierarchical phase coordination
- `scripts/lib/origin.mjs` - Origin capture and validation
- `scripts/lib/worker-session.mjs` - Worker packet assembly and execution
- `scripts/lib/worker-policy.mjs` - Level-to-model mapping (L1-L7)

**State & Persistence:**
- `scripts/lib/yaml-state.mjs` - YAML serialization, canonical JSON, digest computation
- `scripts/lib/run-state.mjs` - Run lifecycle and state machine
- `scripts/lib/build-queue-coordinator.mjs` - Queue state transitions and history
- `scripts/lib/evidence.mjs` - Evidence validation and capture

**Interaction & UI:**
- `scripts/lib/session.mjs` - Approval capture, Goal activation, user-facing messages
- `scripts/lib/interaction.mjs` - User input handling, approval response formatting
- `scripts/lib/picker.mjs` - Keyboard-driven option selector (Up/Down, 1-9, Ctrl+O)
- `scripts/lib/line-input.mjs` - Readline wrapper for non-TTY environments

**Infrastructure:**
- `scripts/lib/app-server-client.mjs` - RPC transport to Codex app-server
- `scripts/lib/app-server-runtime.mjs` - App-server process lifecycle
- `scripts/lib/agent-config.mjs` - Agent registration and validation
- `scripts/lib/model-policy.mjs` - Model tier/reasoning-effort resolution
- `scripts/lib/provision-policy.mjs` - Capability provisioning rules
- `scripts/lib/provision.mjs` - Capability installation and verification

**Testing:**
- `tests/cli.test.mjs` - CLI argument parsing and command dispatch
- `tests/interaction.test.mjs` - User input and picker behavior
- `tests/worker-policy.test.mjs` - Level selection logic
- `tests/workflow-policy.test.mjs` - Routing and skill selection
- `tests/helpers/` - Test utilities and mocks

## Naming Conventions

**Files:**
- `.mjs` - ES modules (all source files)
- `SKILL.md` - Public skill definition
- `*.schema.yaml` - JSON schema (YAML format)
- `*-contract.mjs` - Contract capture/validation modules
- `*-policy.mjs` - Decision/routing/permission policy modules
- `*.test.mjs` - Test files using Node --test runner

**Directories:**
- `scripts/lib/` - Lowercase modules grouped by concern
- `skills/<skill-name>/` - Lowercase skill identifier
- `internal/<layer>/` - Infrastructure separated from runtime
- `tests/` - Flat structure with `*-test.mjs` naming
- `.cruise/` - Runtime state directory (dot-prefixed)
- `.codex-plugin/` - Plugin configuration (dot-prefixed)
- `.planning/` - Planning and documentation (dot-prefixed)

**Constants & Exports:**
- `PUBLIC_SKILLS`, `PUBLIC_ROUTES` - Frozen array of skill names
- `CRUISE_PREPARATION_INSTRUCTIONS` - Skill guidance text
- `ORIGIN_ARTIFACT`, `PLAN_ARTIFACTS`, `APPROVED_ARTIFACTS` - Path constants
- `CLI_VERSION`, `MINIMUM_CODEX_VERSION` - Version strings

## Where to Add New Code

**New Skill:**
- Implementation: `skills/<skill-name>/agents/<agent-id>.md`
- Documentation: `skills/<skill-name>/SKILL.md`, `skills/<skill-name>/references/*.md`
- Agent config: `internal/agent-configs/<agent-name>.toml`
- Test fixture: `evals/fixtures/G<n>/repo/`

**New Worker Level or Model:**
- Policy: `scripts/lib/worker-policy.mjs` - Update `WORKER_LEVEL_POLICY` object
- Model catalog: Agent definition in `internal/agent-configs/`
- Tests: `tests/worker-policy.test.mjs`

**New Artifact Type (Plan, Goal, Build):**
- Schema: `internal/schemas/<artifact>-contract.schema.yaml`
- Validation: `scripts/lib/<artifact>-contract.mjs`
- Constants: Path in `goal-contract.mjs` or `build-contract.mjs`

**New Routing Gate (Quick)::**
- Signal: Add to `PROBE_SIGNAL_DEFAULTS` in `scripts/lib/routing.mjs`
- Classifier: Add to `CLASSIFIER_BOOLEAN_FIELDS` if boolean
- Test gate: `tests/workflow-policy.test.mjs`
- Evaluation: `evals/cases/` with fixture proving gate

**CLI Subcommand:**
- Parser: `scripts/cruise.mjs` parseArgs function (expand case in line 83-84)
- Handler: New `async function run<Command>(options)` in `scripts/cruise.mjs`
- Help text: Update `HELP` constant
- Tests: `tests/cli.test.mjs`

**New Permission or Effect:**
- Policy envelope: `scripts/lib/worker-session.mjs` task packet assembly
- Approval request: `scripts/lib/interaction.mjs` approval mapping
- Worker scope: `scripts/lib/worker-policy.mjs` or skill reference

## Special Directories

**`.cruise/`**
- Purpose: Runtime state directory for active runs and persisted Goal/Build state
- Generated: Yes (created by session.ensurePlanningDirectory)
- Committed: No (in .gitignore)
- Structure:
  - `.cruise/runs/<run-id>/` - Transient state for one run (state.yaml, evidence.yaml)
  - `.cruise/goal/` - Immutable Goal contract (ORIGIN.yaml, PLAN.md, GOAL.md, CLOSEOUT.md)
  - `.cruise/project/` - Build project foundation (ORIGIN.yaml, PROJECT.md, QUEUE.yaml)
  - `.cruise/milestones/<m-id>/` - Per-milestone artifacts and phase state

**`.codex-plugin/`**
- Purpose: Plugin manifest and metadata
- Generated: No (static)
- Committed: Yes
- Files: `plugin.json` (name, version, skill registrations)

**`internal/schemas/`**
- Purpose: JSON schema definitions for validation
- Generated: No (static)
- Committed: Yes
- Used by: `assertYamlSchema` in yaml-state.mjs

**`evals/`**
- Purpose: Evaluation harness with test fixtures and results
- Generated: Yes (results written by test harness)
- Committed: Fixtures yes; results may be gitignored
- Structure:
  - `evals/fixtures/G<n>/repo/` - Test repository clone
  - `evals/fixtures/G<n>/oracle/` - Ground truth outcome
  - `evals/results/` - Pilot evaluation results

**`.planning/codebase/`**
- Purpose: Generated architecture and structure documentation
- Generated: Yes (written by /gsd-map-codebase agent)
- Committed: Yes
- Contains: ARCHITECTURE.md, STRUCTURE.md, CONVENTIONS.md, TESTING.md, etc.

---

*Structure analysis: 2026-07-14*
