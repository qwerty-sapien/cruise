# Cruise

Cruise lets you declare the outcome, then keeps the run aligned until it has
fresh evidence that the work is actually done. Skills compile intent into a
small, user-editable quality contract; Codex and Claude Code share the same
completion attestor while the selected host remains the sole authority for
permissions, approvals, and effects.

Cruise is a dual-host plugin plus an optional Node.js terminal launcher. It
does not add a workflow database or replace either host's native session model.

## Choose a skill

| Skill | Use it when |
| --- | --- |
| `build` | A project or milestone needs clarification and a goal-sized implementation queue. |
| `quick` | The change is small, understood, and low risk. |
| `goal` | A finite feature or consequential multi-step outcome should be planned, implemented, challenged, and evidence-attested. |
| `debug` | A failure needs an evidenced root cause, focused repair, and verification. |

Use `$cruise:<skill>` in Codex and `/cruise:<skill>` in Claude Code. `goal` is
the autonomous lane: it plans just enough to start, executes the next ready
slice, verifies it, realigns when evidence changes, and continues without
routine phase approvals. It still asks for a material product decision,
credential, scope expansion, or host-required approval when one is genuinely
needed. If the request explicitly says planning, research, or design only,
Goal remains read-only and returns a repository-aware plan.
The launcher also accepts `cruise goal --plan "<request>"`; Codex uses its
read-only Plan collaboration mode and Claude uses its native plan permission
mode.

## Advisory artifacts

Cruise uses two compiled-intent artifacts. Both are ordinary Markdown with
YAML frontmatter; you can inspect or edit either at any time.

| Artifact | Purpose |
| --- | --- |
| `.cruise/FLIGHT.md` | The active Goal's outcome, scope, invariants, risk, adaptive quality profiles, falsifiable gates, fresh evidence receipts, status, and stall tuning. |
| `.cruise/QUEUE.md` | Build's ordered milestones, dependencies, scope fences, invariants, verification, and statuses. |

These files do not approve work or grant capabilities. Flight v2 is an
assurance contract: its attestor checks gate coverage and binds receipts to the
exact original request in `.cruise/ORIGIN.md`, product state, and gate
definitions and inherited Flight obligations. New launcher and direct
executable Goals replace a prior run's request note before evidence is
gathered; Claude resume preserves it and does not accept a replacement prompt.
One active Cruise run per workspace prevents concurrent request or Flight
replacement. That proves
freshness and declared coverage, not the truth of an agent's judgment; adaptive
profiles and skeptical review supply the quality floor. A terminal launcher
also writes `.cruise/ORIGIN.md`, the exact request used in that binding.

New Goals always select the `core` profile and add `web`, `backend-data`, or
`cxx-hpc` when the repository and task warrant them. Intent, functional
correctness, and completion review must pass; completion review requires review
evidence. Other dimensions must pass or use an explicitly permitted,
freshly justified terminal state. High-risk work also requires a freshly
passed independent review. After the final product edit, use
`cruise attest --json` to bind receipts. Keep Flight active until the report
says `ready_for_completion: true`, then mark it complete and confirm
`allows_completion: true`.

## Repository profiles and migrations

Cruise reads an optional `.cruise/config.toml`. An absent file selects the
`relaxed` profile; repositories with customer-critical workflows can select
`business-critical` and declare database domains, policy checks, automated
checks, and computer-use flow paths. This file contains identifiers and command
names only. Database URLs, passwords, tokens, dotenv contents, and private keys
are rejected. Supabase's own `supabase/config.toml` remains separate.

Both profiles keep routine execution internal: Cruise chooses workers, spawns
subagents, shares approved task context, runs focused checks, and requests
internal reviews without asking for permission or announcing agent allocation.
`business-critical` adds verification for consequential changes. It does not
make delegation a user decision. Questions concern a concrete potentially
damaging change, material product choice, scope expansion, or sensitive data
outside existing authorization. Workers inherit the task's scope and limits;
a read-only review of a risky diff needs no additional permission.

```sh
cruise config validate -C /path/to/repo
cruise migrate inspect --target sandbox --path supabase/migrations/040_change.sql
cruise migrate apply --target sandbox --path supabase/migrations/040_change.sql
cruise migrate query --target production --file queries/status.sql
cruise migrate status
```

Verified sandbox targets auto-apply without a new authorization prompt.
Production reads run only as one explicit-column `SELECT` wrapped in a
server-enforced read-only transaction. Production migrations auto-apply only
when every operation belongs to one allowlisted non-service-critical domain or
is a nullable, default-free column addition with no material whole-row API,
trigger, dependency, or configured data-policy effect. Everything destructive,
dynamic, constrained, cross-domain, or uncertain yields four informed choices:
authorize the exact digest for production, test in sandbox and auto-promote
after checks, test in sandbox and wait for manual localhost confirmation, or
cancel.

Sandbox failures retain the sandbox and report failed checks and rollback
guidance; production is untouched. Derived trust digests refresh automatically
and never become authorization gates by themselves. See
[`examples/cruise-config.business-critical.toml`](examples/cruise-config.business-critical.toml)
and [`examples/cruise-config.relaxed.toml`](examples/cruise-config.relaxed.toml).

## Goal supervision

The default flight-plan thresholds are three unchanged workspace observations
or three repetitions of the same normalized failure. Set `stall.quiet_turns`
and `stall.same_failure` to positive integers in `.cruise/FLIGHT.md` to tune a
run.

When non-progress reaches either threshold, supervision follows one bounded
ladder:

1. realign and require a different, discriminating approach;
2. allow one final evidence-producing experiment;
3. stop with a human-readable stall report.

New product evidence or monotonic gate closure resets the ladder; editing
Flight prose does not. Codex intercepts native Goal completion and reactivates
an unassured Goal with exact repair guidance. Direct Codex supervision activates
on the explicit `$cruise:goal` prompt; the launcher does not depend on hooks.
Claude uses prompt/Skill activation plus a session-keyed `Stop` hook for
launcher and direct `/cruise:goal` use. The hook
only parses and hashes data—it never executes a gate's `oracle`. After the
bounded ladder, Claude is allowed to stop, but the launcher reports stalled or
unassured instead of converting process exit zero into false completion.

Launcher exit codes are stable:

| Code | Meaning |
| ---: | --- |
| `0` | The Flight v2 contract is ready for completion, or completion is freshly assured. |
| `2` | Blocked, failed, or unassured. |
| `3` | Bounded supervision declared the Goal or queue milestone stalled. |
| `4` | Codex did not start the native Goal turn before the bootstrap deadline. |
| `5` | Codex app-server transport produced no inbound frame before the inactivity deadline. |
| `130` | The user interrupted the session. |

## Build queues

`build` can compile a set of sequential, goal-sized milestones. Review or edit
the queue, inspect dependency state, then run it on either provider:

```sh
cruise build -C ~/src/app "Add a compatible parser migration"
cruise queue status -C ~/src/app
cruise --codex queue run -C ~/src/app
```

`cruise queue run` selects the first pending milestone whose dependencies are
complete, compiles it into `.cruise/FLIGHT.md`, and runs one supervised Goal.
It records the result back into the queue and proceeds only after completion.
The runner rejects active-milestone contract changes, terminal Flight
substitution, milestone-set changes, and status transitions for work it did not
run.
A blocked, stalled, active, failed, or dependency-deadlocked milestone stops
the queue with a report; Cruise never skips it or invents authority to proceed.

## Provider integration

| Surface | Codex | Claude Code |
| --- | --- | --- |
| Skill syntax | `$cruise:goal` | `/cruise:goal` |
| Plugin manifest | `.codex-plugin/plugin.json` | `.claude-plugin/plugin.json` |
| Terminal transport | Codex app-server | Native interactive `claude` process |
| Planning | Native Plan collaboration mode | Native plan permission mode for planning-only work |
| Goal lifecycle | Native Goal object and statuses | In-session task tracking and session-keyed hooks; no Codex-style Goal object |
| Completion contract | Shared Flight v2 evaluator | Shared Flight v2 evaluator |
| Liveness supervision | Between Goal turns; bounded completion reactivation | Session-keyed `Stop` hook; allow-with-report on bounded stall |
| Resume controls | Native Goal continuation | `Ctrl-C`, `/resume`, `--continue`, and `--resume` |

Codex is the default launcher provider. Select one invocation with `--codex`,
`--claude`, `--provider codex|claude`, or the request-scoped
`CRUISE_PROVIDER` environment variable. Conflicting selectors are rejected.
Cruise does not persist a provider choice.

## Install

Both plugins require a signed-in host installation. The optional terminal
launcher requires Node.js 20 or later.

### Codex

Install Cruise from a configured marketplace, then start a new task:

```sh
codex plugin marketplace list
codex plugin add cruise@<marketplace-name>
codex plugin list
```

Editing or pulling the marketplace source does not change the copy already
loaded by Codex. After every local Cruise update, run `codex plugin add` again,
then run `node scripts/cruise.mjs doctor` from the updated source. Doctor
compares critical cached bytes with the configured marketplace source, so a
same-version stale cache fails visibly. Start a new task after the reinstall;
an existing task can retain instructions loaded before the refresh.

### Claude Code

Validate and load a checkout directly:

```sh
claude plugin validate .
claude --plugin-dir .
```

For a distributed plugin, add its marketplace and install the namespaced entry:

```sh
claude plugin marketplace add <marketplace-source>
claude plugin install cruise@<marketplace-name>
claude plugin list
```

### Terminal launcher

```sh
npm install --global cruise-code
cruise --help
```

From a checkout, use `node scripts/cruise.mjs --help` or run `npm link` once.

## Use Cruise

```text
# Codex
Use $cruise:quick to make this exact small change.
Use $cruise:goal to complete this migration with verification.

# Claude Code
/cruise:quick Make this exact small change.
/cruise:goal Complete this migration with verification.
```

The optional launcher exposes the same lanes and queue:

```sh
cruise quick -C ~/src/app "Fix the failing parser test"
cruise --codex goal -C ~/src/app "Migrate the API"
cruise --claude goal -C ~/src/app "Add bounded retry handling"
cruise --claude queue run -C ~/src/app
```

| Command | Purpose |
| --- | --- |
| `cruise <build/quick/goal/debug> <request>` | Start one intent-based session. |
| `cruise goal --plan <request>` | Produce a read-only repository-aware plan without implementation assurance. |
| `cruise --claude goal --resume <session-id>` | Resume the exact Claude session without replacing its original request; the local plugin and supervision are reloaded. |
| `cruise attest [--json]` | Show the current Flight context fingerprint, gate counts, and unresolved assurance. |
| `cruise queue status` | Show milestone statuses and dependencies. |
| `cruise queue run` | Run ready milestones sequentially as supervised Goals. |
| `cruise worker [--level 1-7] <task>` | Run one bounded provider-native worker. |
| `cruise doctor [--json]` | Check the selected host and required integration. |

Worker level is request-scoped. Without `--level`, Cruise leaves the host's
model selection untouched; an explicit level maps to a provider-specific
model/effort pair for that worker only.

For Codex workers, the current level catalog is: L1 GPT-5.6 Luna medium; L2
GPT-5.6 Terra xhigh; L3 GPT-5.6 Terra ultra; L4 GPT-5.6 Sol xhigh; L5 GPT-6
Astra high; L6 GPT-5.6 Sol ultra; L7 GPT-6 Astra xhigh for direct
exceptional-consequence work, with Astra ultra reserved only for an evidenced
L6 escalation. Express that transition only with a managed Codex worker using
`--complexity repeated --level 7 --reasoning-escalation-evidence <text>` plus
the exceptional consequence and rationale; ordinary `--evidence` remains
capsule context and never selects ultra. Exact catalog resolution fails closed
without provider fallback.
Claude Code workers retain Claude's native model and session controls.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| A skill is missing in Codex | Confirm `codex plugin list`, start a new task, and use `$cruise:<skill>`. |
| Cruise source changed but behavior did not | Re-run `codex plugin add cruise@<marketplace-name>` and run Doctor from the updated source. New tasks load it normally; an active job treats detected instruction drift as exceptional internal recovery, selectively reworks only invalidated Cruise-owned code, and continues without a waiver or forced restart. A source checkout and an installed cache are distinct. |
| A skill is missing in Claude | Run `claude plugin validate .`, launch with `--plugin-dir .`, and use `/cruise:<skill>`. |
| The launcher cannot start | Run `cruise --codex doctor` or `cruise --claude doctor`. |
| The wrong host opens | Remove conflicting selectors and inspect `CRUISE_PROVIDER`; Codex is the fallback. |
| Goal exited `3` (stalled) | Read the stall report and last failure, adjust the advisory flight if its scope or tuning is stale, supply the missing decision/evidence, then resume explicitly. |
| Goal exited `4` (bootstrap timeout) | No turn was established within the idle startup deadline (30 seconds by default). Cruise reconciles thread/history state and requests one Plan turn when idle; it does not retry an ambiguously accepted start. Use `--bootstrap-timeout-ms 0` only when an intentionally unlimited idle wait is useful. See [startup and retrieval troubleshooting](docs/UX_TROUBLESHOOTING.md) and [staged handoff](docs/STAGED_HANDOFF.md). |
| The Claude Stop hook keeps continuing my session | Run `cruise attest --json`, resolve the listed gates, or record a concrete `status: blocked`. The hook is scoped to the active Goal skill session and has a hard continuation cap. |
| A Claude Goal cannot be paused as an object | Claude has resumable sessions, not Codex's Goal lifecycle; use `Ctrl-C` and `/resume` or `--resume`. |

### Where is my full trace?

For Codex runs, Cruise prints the thread id and resolved rollout path to stderr,
plus a copy-pasteable tail command. The rollout is Codex's authoritative JSONL
trace, not a Cruise transcript. Cruise stores only a replaceable pointer in
`.cruise/LAST-RUN.json`.

```sh
tail -f '/path/printed/by/cruise/rollout-...-<thread-id>.jsonl'
jq -c . '/path/printed/by/cruise/rollout-...-<thread-id>.jsonl'
codex resume <thread-id>
```

If the file does not exist yet, Cruise prints the thread id, Codex sessions
directory, and resume command without guessing a filename.

## Development

```sh
npm test
npm run validate
node --check scripts/cruise.mjs
claude plugin validate .
```

See `evals/README.md` for the paired live-host protocol and published pilot
artifacts.

### Publish a release with clean history

Finish development with a first-parent commit whose subject begins with
`vX.Y.Z` or `Cruise vX.Y.Z`, then run:

```sh
npm run release:push -- --dry-run origin main
npm run release:push -- origin main
```

The wrapper collapses every commit between the previous and newest release
commits into the newest release snapshot. Commits after the newest release,
such as a README correction, are recreated and retained. Before changing the
branch it requires a clean linear worktree, fetches the remote tip, verifies
that no remote work would be discarded, and creates a timestamped local backup
under `codex/history-backup-*`. It verifies that the final tree is unchanged
and pushes with an exact `--force-with-lease`.

This must be a wrapper command: Git determines which object it will push before
running a `pre-push` hook, so a hook cannot safely rewrite that same push.
Rewritten commits receive new IDs, and any signatures on them cannot be
retained. Tags are not moved or pushed automatically.

## License

MIT. See [LICENSE](LICENSE).

## Dependencies

Cruise has no third-party JavaScript runtime-library dependencies. It requires
[Node.js 20 or later](https://nodejs.org/en/download) and at least one supported
host: [Codex CLI](https://developers.openai.com/codex/cli/) or
[Claude Code](https://code.claude.com/docs/en/getting-started). The host packages
are declared as optional peers in `package.json` so they appear in npm metadata
without making npm install both; install and sign in to the host you intend to
use.

[Git](https://git-scm.com/book/en/v2/Getting-Started-Installing-Git.html) is
recommended for repository workflows and workspace-change detection. Cruise
continues without Git, but cannot use Git status and diffs as progress evidence.
