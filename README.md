# Cruise

Cruise lets you declare the envelope, then mechanically keeps the run inside
it. Skills compile intent into small, user-editable Markdown artifacts; Codex
and Claude Code supervise liveness while the selected host remains the sole
authority for permissions, approvals, and effects.

Cruise is a dual-host plugin plus an optional Node.js terminal launcher. It
does not add a workflow database or replace either host's native session model.

## Choose a skill

| Skill | Use it when |
| --- | --- |
| `build` | A project or milestone needs clarification and a goal-sized implementation queue. |
| `quick` | The change is small, understood, and low risk. |
| `refine` | A finite outcome needs a short implementation approach before execution. |
| `goal` | Consequential or multi-step work should continue through implementation and verification. |
| `debug` | A failure needs an evidenced root cause, focused repair, and verification. |

Use `$cruise:<skill>` in Codex and `/cruise:<skill>` in Claude Code. `goal` is
the autonomous lane: it plans just enough to start, executes the next ready
slice, verifies it, realigns when evidence changes, and continues without
routine phase approvals. It still asks for a material product decision,
credential, scope expansion, or host-required approval when one is genuinely
needed.

## Advisory artifacts

Cruise uses two compiled-intent artifacts. Both are ordinary Markdown with
YAML frontmatter; you can inspect or edit either at any time.

| Artifact | Purpose |
| --- | --- |
| `.cruise/FLIGHT.md` | The active Goal's outcome, verification commands, touchpoints, non-goals, invariants, status, and stall tuning. |
| `.cruise/QUEUE.md` | Build's ordered milestones, dependencies, scope fences, invariants, verification, and statuses. |

These files are advisory. They do not approve work, grant capabilities, block a
host action, or prove completion. The agent must reconcile them with the user
request and current repository evidence. A terminal launcher invocation also
writes `.cruise/ORIGIN.md`, a verbatim request note with no authority semantics.

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

New workspace evidence resets the ladder. Codex applies it between native Goal
turns and pauses an active Goal at the stall step. A launcher-started Claude
Goal applies the same shape through the packaged `Stop` hook: while a fresh
flight is `active`, the hook can block a stop with continuation guidance; after
the bounded ladder it allows the stop with a report. A malformed or stale
Claude flight, damaged hook state, or hook error fails open rather than trapping
the session.

The launcher marks only `cruise --claude goal` sessions with
`CRUISE_CLAUDE_GOAL=1`. A direct `/cruise:goal` invocation in an already-running
Claude process still uses the skill and flight plan, but receives Stop-hook
supervision only if that process was started with the marker already set. This
gate prevents unrelated Claude sessions in the same repository from being
continued by Cruise.

Launcher exit codes are stable:

| Code | Meaning |
| ---: | --- |
| `0` | Completed successfully. |
| `2` | Blocked or otherwise unable to complete. |
| `3` | Bounded supervision declared the Goal or queue milestone stalled. |
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
A blocked, stalled, active, failed, or dependency-deadlocked milestone stops
the queue with a report; Cruise never skips it or invents authority to proceed.

## Provider integration

| Surface | Codex | Claude Code |
| --- | --- | --- |
| Skill syntax | `$cruise:goal` | `/cruise:goal` |
| Plugin manifest | `.codex-plugin/plugin.json` | `.claude-plugin/plugin.json` |
| Terminal transport | Codex app-server | Native interactive `claude` process |
| Planning | Native Plan collaboration mode | Native plan permission mode for planning-only work |
| Goal lifecycle | Native Goal object and statuses | In-session task tracking; no documented Codex-style Goal API |
| Liveness supervision | Between Goal turns; native pause on stall | Launcher-marked `Stop` hook; allow-with-report on stall |
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
cruise --claude refine -C ~/src/app "Add bounded retry handling"
cruise --claude queue run -C ~/src/app
```

| Command | Purpose |
| --- | --- |
| `cruise <build|quick|refine|goal|debug> <request>` | Start one intent-based session. |
| `cruise queue status` | Show milestone statuses and dependencies. |
| `cruise queue run` | Run ready milestones sequentially as supervised Goals. |
| `cruise worker [--level 1-7] <task>` | Run one bounded provider-native worker. |
| `cruise doctor [--json]` | Check the selected host and required integration. |

Worker level is request-scoped. Without `--level`, Cruise leaves the host's
model selection untouched; an explicit level maps to a provider-specific
model/effort pair for that worker only.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| A skill is missing in Codex | Confirm `codex plugin list`, start a new task, and use `$cruise:<skill>`. |
| A skill is missing in Claude | Run `claude plugin validate .`, launch with `--plugin-dir .`, and use `/cruise:<skill>`. |
| The launcher cannot start | Run `cruise --codex doctor` or `cruise --claude doctor`. |
| The wrong host opens | Remove conflicting selectors and inspect `CRUISE_PROVIDER`; Codex is the fallback. |
| Goal exited `3` (stalled) | Read the stall report and last failure, adjust the advisory flight if its scope or tuning is stale, supply the missing decision/evidence, then resume explicitly. |
| The Claude Stop hook keeps continuing my session | Set `status: complete` or `status: blocked` in `.cruise/FLIGHT.md`, or delete that file. The hook acts only on a fresh `active` flight when `CRUISE_CLAUDE_GOAL=1`. |
| A Claude Goal cannot be paused as an object | Claude has resumable sessions, not Codex's Goal lifecycle; use `Ctrl-C` and `/resume` or `--resume`. |

## Development

```sh
npm test
npm run validate
node --check scripts/cruise.mjs
claude plugin validate .
```

See `evals/README.md` for the paired live-host protocol and published pilot
artifacts.

## License

MIT. See [LICENSE](LICENSE).
