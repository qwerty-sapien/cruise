# Orchestrator — v0.3.1 hardening + valid paired verdict

You are executing a four-task plan for the `cruise` repository (current
working directory). The task specs are `prompts/G-flight-self-heal.md`,
`prompts/H-skill-template.md`, `prompts/I-bootstrap-liveness.md`, and
`prompts/J-clean-rerun.md`. **They are authoritative; this document only
sequences them and defines the checkpoint protocol.** Read each spec in
full immediately before starting it.

## Why this pipeline exists (context you must hold)

The v0.3 paired pilot (`evals/results/2026-07-21/`) returned "do not
promote", but its traces show the treatment's supervision layer was
mechanically dead in every scored run: all scored Claude flight plans were
fenceless and the Stop hook stayed silently inert
(`hooks/stop-supervisor.mjs` returns null on unparseable flight state), and
all four Codex treatments hung ~360s with empty transcripts because
`waitForNativeGoalTurn()` in `scripts/lib/simple-session.mjs` has no
deadline. The pilot therefore measured two fail-silent defects, not the
architecture. G/H/I eliminate the fail-silent class; J re-runs the eval in
a clean environment to produce the first valid promote/iterate/kill
verdict. J is the destination; do not gold-plate G/H/I beyond their specs.

## Execution order

Serial, on the current branch:

```text
1. G  (self-healing invalid-flight feedback in both supervisors)
2. H  (canonical template embedded in the goal skill)
3. I  (bootstrap liveness deadline in the Codex launcher)
   — integration gate —
4. J  (pre-registered, isolated paired re-run + verdict)
```

G/H/I were designed for parallel worktrees; run serially they cannot
conflict. Their "files you must not touch" lists mean "not during this
task". The canonical template text is pinned identically in G and H; if
the shipped serializer (`writeFlightPlan`) output differs from the pinned
text, **code is ground truth** — align the template to the serializer and
note the deviation.

## Checkpoint protocol (applies after G, H, and I)

Each task ends with a falsification checkpoint, not a self-congratulation:

1. **Fail-before.** Check out or stash to the pre-task state and run the
   task's red-team probe (each spec defines it). The probe MUST demonstrate
   the old failure (silent inertness, silent hang, missing template). If
   the probe passes on pre-change code, the probe is worthless — fix the
   probe before proceeding.
2. **Pass-after.** Re-apply the change; the same probe must now show the
   loud/self-healing behavior. Keep both outputs.
3. **Hostile review with cold context.** If the host supports subagents,
   spawn one with ONLY the task spec and `git diff` (not your working
   transcript) and this brief: "find where this diff fails its spec,
   reintroduces a fail-silent path, adds an unbounded loop, or grows
   Cruise-owned authority." Otherwise, take a deliberate cold pass
   yourself against that same brief. Fix confirmed findings; record
   deferred ones.
4. **Checkpoint artifact.** Write `docs/checkpoints/v0.3.1/CHECKPOINT-<task>.md`:
   - **Claim** — the failure class this task makes impossible/loud.
   - **Falsification evidence** — fail-before and pass-after outputs.
   - **Hostile findings** — what was found, fixed, or deferred and why.
   - **Unproven** — what remains untested and why that is acceptable.
5. **Standard gates.** `npm test` green (including the task's new tests),
   `node scripts/cruise.mjs --help`, `claude plugin validate .` when the
   CLI is available. Commit the task and its checkpoint before moving on.

A checkpoint that cannot honestly complete step 1 or 2 is a blocker: stop,
report which claim failed falsification, and do not proceed to J.

## Integration gate (after I, before J)

- Full suite + both CLI smoke checks.
- Cross-copy consistency test: the template in the skill, the corrective
  template in the hook, and `flight-plan.mjs`'s canonical shape must all
  parse to equivalent structures (G and H add the tests; here you verify
  they exist and pass together).
- One combined hostile pass over `git diff` of all three tasks with the
  same brief as above, plus: "do the three changes interact? Can the
  corrective intervention and the bootstrap deadline fire in the same run
  and double-count against the block cap?"
- Write `docs/checkpoints/v0.3.1/CHECKPOINT-integration.md` in the same
  format.

## Ground rules

- The design philosophy is non-negotiable: supervision is evidence-based,
  bounded, and fail-safe; artifacts are advisory; every ladder terminates
  in pause/allow-with-report; no approval objects, ledgers, digests, or
  authority state. If a fix seems to need one, the fix is wrong.
- Fail-loud never means fail-blocking: a broken supervisor must degrade to
  a loud note and an allowed stop, never trap a session (the hook's
  existing fail-open-on-internal-error contract stands).
- No new runtime dependencies. Match existing style; `node --test`.
- J's honesty rules are absolute: pre-register before running, never
  fabricate, a partial-but-honest result is a success.

## Final report

End with: per-task checkpoint verdicts with commit ranges; integration
gate result; J's pre-registered criteria and the verdict they produced
(promote / iterate / kill, with the numbers); every deviation from a spec;
and the single next action you recommend.
