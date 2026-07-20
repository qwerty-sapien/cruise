# v0.3 evaluation findings

These findings are not repaired in Task F because its scope fence prohibits
changes under `skills/**`, `scripts/**`, and `hooks/**`.

## P1 — Goal instructions do not reliably produce a parseable flight plan

All scored Claude treatment runs created `FLIGHT.md`, but none began and ended
YAML frontmatter with `---`. The live parser consequently returned no plan and
the Stop hook remained inert, including in the scored stall trap. The skill
should provide or mechanically invoke the pinned serializer shape, then verify
that `readFlightPlan` can consume the file before relying on supervision.

## P1 — Codex paired isolation was contaminated

Codex controls loaded the globally installed Cruise `0.2.1` skill, and Codex
treatments also surfaced that stale skill instead of the v0.3 checkout skill.
This violated the Cruise-absent control and identical treatment-version
requirements, invalidating all four Codex pairs. A rerun needs isolated Codex
state that preserves authentication while exposing only the intended arm.

## P1 — Codex treatment launcher timed out without captured behavior

Every Codex treatment reached its case timeout with an empty transcript and no
tracked implementation, while each paired control completed or truthfully
blocked. The process reported no spawn error. Reproduce this only after fixing
Codex arm isolation so stale plugin state cannot confound the diagnosis.

## P2 — `V301` scope wording conflicts with treatment mechanics

The prompt allowed modifications only to two source files, while v0.3 Goal
treatment requires `.cruise/FLIGHT.md` as its first execution artifact. That
made the same text structurally harsher for treatment and invalidated both
provider pairs after unblinding. A future case should exclude `.cruise/` from
the source-code fence while still grading its contents separately.
