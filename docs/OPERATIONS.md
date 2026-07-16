# Operations

Use this page to install, verify, update, and troubleshoot Cruise.

## Requirements

| Dependency | Minimum |
| --- | --- |
| Codex CLI | `0.144.1` with native Goals enabled |
| Node.js | `20` |
| Codex authentication | Normal authenticated configuration |

## Install or refresh

```sh
codex plugin remove cruise@agent-local
codex plugin add cruise@agent-local
mkdir -p ~/.local/bin
ln -sfn "$PWD/scripts/cruise.mjs" ~/.local/bin/cruise
cruise agents install
cruise hooks install
```

Removing first is intentional during an update: it refreshes the cached skill snapshot. Already-open Codex tasks retain their loaded skill content and must be restarted.

Verify both surfaces:

```sh
codex plugin list
cruise agents install --json
cruise doctor
```

## Doctor profiles

| Command | Use | Scope |
| --- | --- | --- |
| `cruise doctor` | Fast readiness check | Entrypoint, cache, catalog, agents, and host rule |
| `cruise doctor --json` | Machine-readable readiness | Same checks as the default profile |
| `cruise doctor --deep --install-worker-rule` | Rapid install/update verification | Five sequential read-only skill-contract probes in one warm task |
| `cruise doctor --troubleshoot --install-worker-rule` | Exhaustive manual diagnosis | Real multi-turn canaries, workers, approvals, Goal activation, and disposable repositories |
| `cruise doctor --troubleshoot --fixture <path>` | Diagnose a supplied fixture | Troubleshoot flow against that fixture |

`--install-worker-rule` writes only the exact host rule for the absolute running Cruise entrypoint followed by `worker`.

### Deep Doctor

- Starts one isolated app-server and one Luna Medium task.
- Discovers installed skills once and reuses the warm conversation.
- Runs five read-only contract probes plus high-signal tests from the pinned cache.
- Performs no repository workflow, product write, worker launch, structured question, or permission expansion.
- Targets less than `15000 ms` per skill.
- Fails liveness only at the fixed `60000 ms` per-skill deadline.

### Troubleshoot

- Exercises all five real skill workflows.
- Retains evidence packets, workers, approvals, Goal activation, and disposable repositories.
- Has no workflow liveness deadline; it ends on a semantic terminal result, host failure, or cancellation.
- Prints a failed workspace path and returns it to JSON callers.

The bundled fixture includes repository-local spatiomics guidance and synthetic structure for StereoPy, STAR, BANKSY, SAW 8.1.3, Snakemake, Leiden, BAM, GEM, GEF/GEFF, H5AD/H5MS, annotations, references, GTF, and SIF. It tests documented boundaries; it does not claim to run every scientific tool or perform biological validation.

## Automatic update verification

`cruise hooks install` installs managed hooks in:

- the current Cruise checkout; and
- Git’s global initialization template.

An existing hook is preserved as `<hook>.cruise-original` and runs first. Template hooks no-op outside Cruise repositories and require the exact canonical Cruise `origin` URL before invoking the installed `cruise` client.

| Hook | Covered Git action |
| --- | --- |
| `post-merge` | `git merge` and merge-based `git pull` |
| `post-rewrite` | `git rebase` and rebase-based `git pull` |
| `post-checkout` | Initial clone checkout with an all-zero old object ID |

After a successful update, Cruise:

1. waits for active workers, Deep Doctor, or Troubleshoot to finish;
2. coalesces concurrent hooks behind one global lock;
3. points the personal marketplace at the updated checkout;
4. removes and re-adds `cruise@agent-local`;
5. refreshes managed agents; and
6. runs `cruise doctor --deep --install-worker-rule`.

Automatic verification always uses Deep Doctor, never the unbounded Troubleshoot profile. Recursive fixture hooks are suppressed.

Plugin readiness requires both registry visibility and an exact source/cache digest match. `CRUISE_PLUGIN_READY_TIMEOUT_MS` changes the wall-clock deadline (default `120000 ms`); polling has no attempt-count ceiling.

Git does not run hooks merely because they exist in a cloned repository. A machine that has never installed Cruise needs the one-time `cruise hooks install` bootstrap; later Cruise clones inherit the trusted template hook.

## Terminal client

The client keeps one app-server task and owns Default/Plan switching. Goal additionally restores Default, calls `thread/goal/set`, and verifies native Goal state.

```sh
cruise build -C ~/src/app "Establish the next release milestone"
cruise refine -C ~/src/app "Add bounded retry handling"
cruise goal -C ~/src/app "Migrate the API without breaking existing clients"
cruise picker-demo
```

Picker controls:

| Input | Action |
| --- | --- |
| Up / Down | Move selection |
| Enter / Space | Confirm selection |
| `1`–`9` | Select immediately |
| `q` / Escape / Ctrl-C | Cancel |

## Configuration

### Worker class

```sh
cruise config class
cruise config class --show --json
```

### Presentation style

```sh
cruise config style default
cruise config style professional
cruise config style friendly
```

These preferences do not widen scope, permissions, effects, or safety authority.

## Failure notes

| Symptom | What Cruise preserves or reports |
| --- | --- |
| Retryable app-server interruption | Ordered retry notifications until Codex reports a terminal outcome |
| Terminal worker failure | Sanitized error identity, HTTP status when available, and retained history |
| Restricted sandbox DNS failure | The actual deterministic network failure; no claim that Cruise bypassed it |
| Failed Deep or Troubleshoot run | Disposable evidence workspace path |
| Cache mismatch after reinstall | Fails readiness until registry and exact cache digests converge |

## Development checks

```sh
npm test
npm run validate
npm run test:evals
npm run test:evals:static
npm run test:evals:behavior
node --check scripts/cruise.mjs
```

The picker and shared runtime are dependency-free Node implementations.

## Related reference

- [README](../README.md)
- [Architecture and safety](ARCHITECTURE.md)
- [Build and Goal](BUILD-AND-GOAL.md)
- [Limit policy](../LIMIT_POLICY.md)
