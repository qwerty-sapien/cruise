# Task A — Repo hygiene: remove the retired v0.1 control plane

## Context

You are working in the `cruise` repository (root: this working directory), a
dual-host coding-workflow plugin for Codex and Claude Code. The live product
is small: five prompt-only skills in `skills/*/SKILL.md`, plus an optional
terminal launcher. The live entry points are `index.js` → `scripts/cruise.mjs`,
which imports only: `app-server-client.mjs`, `claude-cli.mjs`,
`origin-note.mjs`, `picker.mjs`, `provider.mjs`, `simple-session.mjs`,
`simple-worker.mjs` (plus their transitive imports such as
`worker-policy.mjs`, `model-policy.mjs`, `line-input.mjs`).

Everything else in `scripts/lib/` (~45k lines: `build-contract.mjs`,
`build-discovery.mjs`, `build-history.mjs`, `build-queue-coordinator.mjs`,
`milestone-controller*.mjs`, `provision*.mjs`, `workflow-policy.mjs`,
`routing.mjs`, `origin.mjs`, `session.mjs`, `yaml-state.mjs`,
`doctor-e2e.mjs`, `foreign-diff-guard*.mjs`, `goal-contract.mjs`,
`host-authority-lock.mjs`, `evidence.mjs`, `traceability.mjs`,
`handoff.mjs`, `artifact-naming.mjs`, `run-state.mjs`, `interaction.mjs`,
`skill-session.mjs`, `worker-attempt.mjs`, `worker-session.mjs`,
`cruise-class.mjs`, `agent-config.mjs`, `communication-style.mjs`,
`deadline.mjs`, `semantic-mapping-packet.mjs`, `milestone-contract-digest.mjs`,
`doctor-host-rule.mjs`, `doctor-plugin-cache.mjs`, `git-update.mjs`,
`pinned-rename-child.mjs`, `plan-renderer.mjs`, `repository-scope.mjs`,
`user-facing-output.mjs`, `worker-report-commit-child.mjs`, and possibly
others) is the **retired v0.1 control plane**. `scripts/cruise-runtime.mjs`
is a tombstone that prints "cruise-runtime is retired." `npm test` runs only
9 of ~44 test files; the rest test dead modules.

## Task

1. **Compute reachability, don't trust the list above.** Starting from
   `index.js`, `scripts/cruise.mjs`, `scripts/validate-suite.mjs` (check
   whether anything still invokes it — if not, it is dead too), and the test
   files named in `package.json`'s `test` script, trace `import` statements
   to the full live set. Verify with grep before deleting anything.
2. **Delete every unreachable module in `scripts/lib/`**, the
   `scripts/cruise-runtime.mjs` tombstone, and every test file that imports a
   deleted module. Do not "just in case" keep anything: git history is the
   archive.
3. **Check the `worker-policy.mjs` → `yaml-state.mjs` edge.** If
   `worker-policy` imports only a trivial helper from `yaml-state` (677
   lines), inline or reimplement that helper (< ~30 lines) so `yaml-state.mjs`
   can be deleted and dropped from `package.json` `files`. If the dependency
   is substantive, keep both and say so in your summary.
4. **Prune `package.json` `files`** to exactly what the shipped CLI and
   plugins need. Verify with `npm pack --dry-run` that the tarball contains
   every file the entry points import and nothing dead.
5. **Fix the stale self-assessment docs.** `EXEMPLAR-COMPARISON.md` and
   `exemplar.md` (local research notes, possibly gitignored) cite deleted
   modules (`host-authority-lock.mjs`, `build-queue-coordinator.mjs`,
   `milestone-controller.mjs`, …) as evidence of current strength. Either
   (a) move them to `docs/history/` with a prominent banner stating they
   describe the retired v0.1 architecture, or (b) rewrite their evidence
   column to reference only live files. Choose the smaller honest change.
6. **Sweep for dangling references** to deleted files in `README.md`,
   `docs/ARCHITECTURE.md`, `evals/`, and remaining tests, and fix them.

## Files you own

- Deletions across `scripts/lib/`, `scripts/cruise-runtime.mjs`, `tests/`
- `package.json` (the `files` array and, if needed, the `test` script)
- `EXEMPLAR-COMPARISON.md`, `exemplar.md` (or their new location)
- Reference fixes in `README.md` / `docs/ARCHITECTURE.md` (reference fixes
  only — no rewrites; Task F owns the doc rewrite)

## Files you must not touch

- `skills/**` (Tasks B/C/D/E own these)
- Live logic in `simple-session.mjs`, `claude-cli.mjs`, `cruise.mjs`
  (you may not refactor them; only delete things they never import)
- `LIMIT_POLICY.md` (Task C owns it)

A parallel task (B) also edits `package.json` to add
`scripts/lib/flight-plan.mjs` to `files`; a one-line merge conflict there is
expected and fine.

## Acceptance criteria

- `npm test` passes; every remaining test file is exercised by the `test`
  script (no orphan tests left in `tests/`).
- `node index.js --help` and `node scripts/cruise.mjs --help` work.
- `claude plugin validate .` passes.
- `npm pack --dry-run` lists no deleted files and misses no imported ones.
- `grep -rn` for each deleted module name across the repo returns only git
  history, not live references.
- Your final summary states: lines deleted, files deleted, files kept that
  you were unsure about and why.

Commit in reviewable slices (e.g., "delete dead workflow control plane",
"delete orphaned tests", "prune package files", "quarantine stale exemplar
comparison").
