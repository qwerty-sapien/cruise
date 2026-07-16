# Cruise

Cruise is a Codex-only development harness with five intent-based skills. It preserves the original request, scales the workflow to the work, isolates bounded workers, and requires current evidence before completion. Seven launcher-managed worker levels and an optional terminal client support everything from one small edit to durable Goal execution.

## Choose a skill

```text
Starting a project or milestone?       cruise:build
Know the exact small change?           cruise:quick
Need a finite plan before coding?      cruise:refine
Need durable consequential execution?  cruise:goal
Have a failure with unknown cause?     cruise:debug
```

The lanes are mutually exclusive by primary intent and what is already known:

| Skill | Use it for | Boundary and next handoff |
| --- | --- | --- |
| Starting a project or milestone | `$cruise:build` | An approved foundation, phase DAG, and persistent queue—no product implementation |
| Making an exact, low-risk change | `$cruise:quick` | The smallest scoped edit with focused proof |
| Resolving a finite outcome that needs a plan | `$cruise:refine` | A few material questions, one approved plan, and current-thread execution |
| Running consequential or recovery-sensitive work | `$cruise:goal` | Durable execution behind one combined Plan-and-Goal approval |
| Investigating a failure with an unknown cause | `$cruise:debug` | A proven cause and the smallest verified repair |

### Nearest handoff

| Current signal | Handoff |
| --- | --- |
| Unknown-cause symptom | Debug |
| Material design or product decision | Refine |
| Consequential, cross-system, or durable work | Goal |
| One missing fact inside Build, Quick, Refine, Debug, or Goal | Private Research Cell; keep the current lane |
| Evidence-only inquiry | Native Codex or GitHub review |
| New project, foundation, or milestone | Build |

Cruise keeps these lanes mutually exclusive by primary intent and by what is already known. The retired public Review route remains readable in legacy schema-v1 records but cannot start or resume; use native Codex or GitHub review instead.

## Install

### Requirements

- Codex CLI `0.144.1` or newer with native Goals enabled
- Node.js `20` or newer
- An authenticated Codex configuration

### Set up the plugin and terminal client

```sh
codex plugin remove cruise@agent-local
codex plugin add cruise@agent-local
mkdir -p ~/.local/bin
ln -sfn "$PWD/scripts/cruise.mjs" ~/.local/bin/cruise
cruise agents install
cruise hooks install
```

Restart already-open Codex tasks after reinstalling; active tasks retain the skill content they loaded.

### Verify the installation

```sh
codex plugin list
cruise agents install --json
cruise doctor
```

See [Operations](docs/OPERATIONS.md) for Deep Doctor, Troubleshoot, worker-host rules, and automatic update verification.

## Use Cruise

### In Codex

```text
Use $cruise:build to establish this project foundation and its first milestone.
Use $cruise:quick to make this exact low-risk change.
Use $cruise:refine to plan and implement this bounded outcome.
Use $cruise:goal to execute this compatibility migration.
Use $cruise:debug to find and repair this intermittent failure.
```

The private **Research helper** is available to Build, Refine, Debug, and Goal. It resolves one
bounded worker question and returns an evidence card that the current workflow immediately maps
into its plan, hypothesis, or ready node. It has no command, skill manifest, route, second run,
or product-edit authority.

### From the terminal

The terminal client owns the one-thread Default/Plan choreography. Goal also restores Default mode and verifies native Goal activation before execution.

```sh
cruise build -C ~/src/app "Establish the next release milestone"
cruise build --auto-approve -C ~/src/app "Establish a reviewed planning foundation"
cruise refine -C ~/src/app "Add bounded retry handling"
cruise goal -C ~/src/app "Migrate the API without breaking existing clients"
cruise -C ~/src/app "Redesign checkout and prove the UX" # Goal-compatible alias
cruise picker-demo
```

## How a run works

```text
request
  ↓
immutable Origin + repository baseline
  ↓
bounded probe + one route decision
  ↓
approval, permission, and capability gates
  ↓
bounded worker execution
  ↓
current evidence + closeout
```

| Principle | Cruise behavior |
| --- | --- |
| Preserve intent | Captures the triggering message verbatim and hashes its exact UTF-8 bytes before clarification |
| Inspect before asking | Uses repository evidence first, then asks only material questions |
| Scale the ceremony | Quick stays small; Refine adds a finite plan; Goal and Build add durable contracts |
| Separate authority | Workers cannot approve plans, grant permissions, activate Goals, reroute, or deliver the final response |
| Protect user work | Accepts pre-existing changes as baseline and pauses on unexplained drift; it never cleans or restores them |
| Resume from evidence | Revalidates Origin, baseline, approvals, permissions, capabilities, and evidence instead of trusting chat memory |
| Close truthfully | A waiver stays `NOT_RUN`; a model claim or self-authored check is not independent proof |

The full mechanism is documented in [Architecture and safety](docs/ARCHITECTURE.md).

## Build and Goal at a glance

### Build plans; it does not implement

Build selects one of two evidence-based modes:

| Mode | Use when | Approval |
| --- | --- | --- |
| Bootstrap | The repository is empty, placeholder-only, generated-only, or architecturally unestablished | **Approve Foundation** |
| Milestone | The product is established or the request names a next milestone | **Approve Milestone** |

Discovery runs only for missing or conflicting readiness evidence. Approval locks the displayed contract and queue bytes but authorizes neither product implementation nor Goal activation.

### Goal needs two decisions

| Decision | What Cruise shows | Choices |
| --- | --- | --- |
| 1. Execution envelope | Capabilities, authentication, permissions, and autonomy | **Approve all**, **Select some**, **Reject all**, or **Discuss** |
| 2. Combined contract | One inactive PLAN.md + GOAL.md candidate, with excerpts, links, and bound revisions | **Approve both**, **Refine**, or **Reject both** |

After both decisions, Cruise rechecks the complete-suite snapshot, sets and verifies native Goal state, then executes. When GUI Plan mode is unavailable, the terminal client presents the same combined contract deterministically.

For the complete Build queue, receipt, controller, and recovery contracts, see [Build and Goal](docs/BUILD-AND-GOAL.md).

## Worker policy

The root agent coordinates every run. Substantive mapping, planning, implementation, diagnosis, research, synthesis, and independent verification happen in launcher-managed worker tasks.

Cruise gives naming one narrow worker boundary. Before a run exists, `cruise_l1` assigns the semantic repository namespace and run name. Fixed protocol artifacts keep stable, purpose-based names.

| Naming rule | Result |
| --- | --- |
| Informative | A path reveals its purpose without opening the file |
| Short | Each Cruise-assigned generated component is at most 15 characters |
| Deterministic | Fixed protocol files use names such as `run-name.yaml`, `map-pkt.yaml`, `map-facts.yaml`, `drift.yaml`, `admit.yaml`, and `done.yaml` |
| Human-facing | UUIDs, hashes, timestamps, PIDs, and random suffixes never become generated path components |
| Integrity-safe | SHA-256 remains inside records and receipts; it does not double as a filename |

The `begin` runtime does not accept a caller-selected run directory. External host protocols may still require their own filenames; Cruise does not rename those files or use them as Cruise artifact namespaces.

### Levels

| Level | Agent | Alias | Model | Reasoning |
| ---: | --- | --- | --- | --- |
| `1` | `cruise_l1` | `luna-M` | `gpt-5.6-luna` | `medium` |
| `2` | `cruise_l2` | `terra-M` | `gpt-5.6-terra` | `medium` |
| `3` | `cruise_l3` | `terra-H` | `gpt-5.6-terra` | `high` |
| `4` | `cruise_l4` | `terra-X` | `gpt-5.6-terra` | `xhigh` |
| `5` | `cruise_l5` | `sol-H` | `gpt-5.6-sol` | `high` |
| `6` | `cruise_l6` | `sol-X` | `gpt-5.6-sol` | `xhigh` |
| `7` | `cruise_l7` | `sol-U` | `gpt-5.6-sol` | `ultra` |

Level `1` is naming-only and read-only. It cannot inspect the repository or perform substantive work. Worker choice never widens scope, permissions, write authority, effects, or cost boundaries.

### Classes

| Class | Ordinary default | Typical use |
| --- | --- | --- |
| `budget-cruise` | `terra-H` | Lower-cost ordinary work |
| `normal-cruise` | `terra-X` | Default planning, execution, debugging, synthesis, and verification |
| `premium-cruise` | `sol-H` | Stronger ordinary work |
| `luxury-cruise` | `sol-X` | Highest ordinary-work class |

```sh
cruise config class
cruise config class --show --json
```

Cruise may choose a lower level for a specifically bounded cheap task or a higher level when risk and evidence justify it. There is no hidden universal retry ceiling; the [limit policy](LIMIT_POLICY.md) governs executable caps.

## Presentation style

```sh
cruise config style default       # clear and plain
cruise config style professional  # professional and technical
cruise config style friendly      # friendly and creative
```

Style changes presentation only. Safety checks and approval prompts remain unchanged.

## Documentation map

| Read this | When you need… |
| --- | --- |
| [Architecture and safety](docs/ARCHITECTURE.md) | Origin, routing, state, workers, drift protection, capabilities, and evidence rules |
| [Build and Goal](docs/BUILD-AND-GOAL.md) | Build discovery, approval receipts, queues, Goal activation, and milestone control |
| [Operations](docs/OPERATIONS.md) | Installation, Doctor profiles, update hooks, terminal behavior, and development checks |
| [Limit policy](LIMIT_POLICY.md) | The allowed classes of executable limits and prohibited arbitrary ceilings |
| [Evaluation guide](evals/README.md) | Paired evaluations, isolation, grading, metrics, and current coverage |

The public skill contracts live under [`skills/`](skills/). Machine-state schemas and shared runtime contracts live under [`internal/`](internal/).

## Development

```sh
npm test
npm run validate
npm run test:evals
# Optional: npm run test:evals:static
# Optional: npm run test:evals:behavior
node --check scripts/cruise.mjs
```

The picker and shared runtime are dependency-free Node implementations maintained as part of Cruise.

## License

MIT. See [LICENSE](LICENSE).
