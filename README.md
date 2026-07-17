# Cruise

Cruise is a small Codex plugin and optional terminal launcher. Its five
intent-based skills help Codex use the right amount of planning and autonomy
for a coding task without introducing a separate workflow system.

Cruise keeps only one local record: `.cruise/ORIGIN.md`, containing the exact
request that started the most recent Cruise run. It is a convenience note, not
an approval or source of authority. Codex's usual permissions, approvals, and
native Goal state continue to govern all work and effects.

## Choose a skill

| Skill | Use it when |
| --- | --- |
| `build` | You need to shape a project or milestone before implementation. |
| `quick` | The requested change is small, understood, and low risk. |
| `refine` | The outcome is finite but needs a short plan first. |
| `goal` | The work is consequential or multi-step and should run to completion. |
| `debug` | You have an observed failure whose cause is not yet clear. |

`goal` is the autonomous lane: Codex advances ready, in-scope work until the
native Goal is complete. It still asks for material product decisions, secrets,
scope changes, and any approval Codex requires for an external or destructive
action.

## Install

### Requirements

- A signed-in Codex app or CLI with plugin support
- Node.js 20 or later for the optional terminal launcher

### Install the Codex plugin

Cruise is installed from a configured Codex plugin marketplace. First inspect
the marketplaces and plugins available to your Codex installation:

```sh
codex plugin marketplace list
codex plugin list
```

If your marketplace already exposes Cruise, install it with its listed
marketplace name. For example, the local development marketplace uses
`agent-local`:

```sh
codex plugin add cruise@agent-local
```

If no suitable marketplace is configured, add the marketplace source supplied
by your team or distribution channel, then install Cruise from it:

```sh
codex plugin marketplace add <marketplace-source>
codex plugin add cruise@<marketplace-name>
```

Verify that Cruise is installed and enabled, then start a new Codex task before
using its skills:

```sh
codex plugin list | rg '^cruise@'
```

### Use the terminal launcher (optional)

From a clone of this repository, run the launcher directly:

```sh
node scripts/cruise.mjs --help
```

To make `cruise` available on your shell path for local development, link the
package once from this repository:

```sh
npm link
cruise --help
```

## Use Cruise

In Codex, invoke the matching skill explicitly:

```text
Use $cruise:build to define the next project milestone.
Use $cruise:quick to make this exact small change.
Use $cruise:refine to plan and implement this bounded feature.
Use $cruise:goal to complete this migration with verification.
Use $cruise:debug to find and repair this failing test.
```

The terminal launcher starts a normal Codex task in the target directory:

```sh
cruise quick -C ~/src/app "Fix the failing parser test"
cruise refine -C ~/src/app "Add bounded retry handling"
cruise goal -C ~/src/app "Migrate the API without breaking existing clients"
cruise worker -C ~/src/app "Run the focused verification"
```

Every invocation replaces `.cruise/ORIGIN.md` with that invocation's exact
request. Cruise does not create run directories, YAML workflows, approval
receipts, archives, or retry ledgers.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Cruise is absent from the plugin list | Run `codex plugin marketplace list` and `codex plugin list`; confirm the intended marketplace exposes `cruise`. |
| The skill is unavailable in a task | Start a new task after the plugin is installed, then invoke `$cruise:<skill>` explicitly. |
| `cruise: command not found` | Run `node scripts/cruise.mjs --help` from the clone. If that works, add the optional `npm link` setup above. |
| The terminal launcher will not start a task | Check `node --version`, `codex --version`, and `codex app-server --help`. The launcher needs Node 20+ and a working, authenticated Codex CLI. |
| A worker or stream fails | Treat the reported transport category as evidence. Cruise may retry one pre-effect transport failure; otherwise, rerun the normal command when appropriate—there is no special retry phrase or reset procedure. |

Use `cruise --help` to see the supported terminal commands. Normal Codex
approvals remain in effect for commands, file changes, network access, and
other external effects.

## Development

```sh
npm test
npm run validate
node --check scripts/cruise.mjs
```

## License

MIT. See [LICENSE](LICENSE).
