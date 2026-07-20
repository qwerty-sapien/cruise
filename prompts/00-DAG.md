# Cruise v0.3 implementation DAG

```text
Wave 1 (parallel):   A-hygiene        B-flight-plan
                          \             /        \
Wave 2 (parallel):    C-codex-supervisor      D-claude-hooks
                              \                  /
Wave 3:                     E-build-queue
                                  |
Wave 4:                 F-evals-and-docs
```

Edges and why:

- **A → (everything, weakly).** A only deletes dead code and prunes
  `package.json`. Nothing depends on it technically; merge it during Wave 1 so
  later diffs stay legible.
- **B → C, D, E.** B pins the `.cruise/FLIGHT.md` schema and the
  `scripts/lib/flight-plan.mjs` API. C, D, and E all consume that contract.
- **C → E.** E's queue runner reuses the supervised goal loop C builds into
  `SimpleCruiseSession` / `runStart`.
- **C ∥ D.** Deliberately decoupled: D re-implements a ~40-line fingerprint
  helper inside its hook script instead of importing C's `supervisor.mjs`, so
  the two can be written in parallel. Consolidation is a follow-up, not a
  blocker.
- **F last.** Evals and the docs rewrite must describe shipped behavior.

## Run mechanics

- One branch or worktree per prompt (`git worktree add ../cruise-A A-hygiene`
  etc.). Merge at wave boundaries.
- Each prompt file is self-contained: paste it into a fresh Codex or Claude
  Code session, or dogfood with
  `cruise goal -C <worktree> "$(cat prompts/B-flight-plan.md)"`.
- Every prompt lists **Files you own** and **Files you must not touch**.
  Respect them; they are what makes the waves mergeable.

## Expected (benign) merge conflicts

| Files | Between | Resolution |
| --- | --- | --- |
| `package.json` `files` array | A and B | Keep A's pruned list, add B's `scripts/lib/flight-plan.mjs` entry. |
| `package.json` `files` array | Wave-2 branches | Union: C adds `supervisor.mjs`, D adds `hooks/`. |
| `skills/goal/SKILL.md` host bullets | C and D | C edits only the Codex bullet, D only the Claude bullet — union both. |

## Non-negotiable philosophy (applies to every prompt)

Cruise v0.1 was a state-owning control plane (contracts, queues, digests,
ledgers, locks) and it was deliberately retired; the prohibitions in the
skill files are its postmortem. v0.3 adds exactly two things and nothing else:

1. **Compiled per-run intent** (`FLIGHT.md`, `QUEUE.md`) — small, advisory,
   user-editable, regenerated per run. Never an approval, ledger, or
   authority object.
2. **Mechanical liveness supervision** — evidence-based, user-tunable,
   fail-safe (escalation ends in *pause with a report*, never an infinite
   retry and never a hard block on the host's authority).

The host remains the sole authority for permissions, approvals, and effects.
