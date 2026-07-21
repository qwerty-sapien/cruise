# Task J — Clean paired re-run: the first valid verdict on the architecture

## Context

You are working in the `cruise` repository after three hardening tasks
landed: self-healing invalid-flight supervision (G), the canonical
template embedded in the goal skill (H), and a bootstrap liveness deadline
in the Codex launcher (I). Read `docs/checkpoints/v0.3.1/` and the current
code before trusting this summary.

The prior pilot (`evals/results/2026-07-21/`) was invalidated as evidence
about the architecture: all four Codex pairs were contaminated by a
globally installed stale Cruise skill (and every Codex treatment hung at
bootstrap with an empty transcript); both V301 pairs were structurally
unfair because the shared prompt forbade files outside two source files
while the treatment must write `.cruise/FLIGHT.md`; and every scored
Claude treatment's flight plan was unparseable, so supervision was inert
in all scored runs. Zero valid runs exercised live supervision. Your job
is to produce the first evaluation whose verdict — promote, iterate, or
kill — can actually be trusted. The infrastructure exists:
`evals/run-v03-trials.mjs`, `evals/compile-v03-results.mjs`,
`evals/validate-v03-results.mjs`, cases in `evals/cases/v03-goal.json`,
fixtures in `evals/fixtures/v03/`.

## Phase 0 — Pre-registration (before ANY run executes)

Write and **commit** `evals/results/<date>/PREREGISTRATION.md` before the
first trial. It must contain, fixed in advance:

1. The exact run matrix and case versions (including your V301 fix, see
   Phase 1).
2. The promotion criteria. Use these unless you find a concrete defect in
   them, in which case amend BEFORE running and explain:
   - median paired treatment delta ≥ 0 across valid pairs;
   - no false completion claim in any treatment run;
   - the scored V303 treatment traverses the full supervisor ladder
     (realign → final-experiment → stall/blocked endpoint) in the
     official run — not a diagnostic;
   - treatment blocker rate ≤ control blocker rate;
   - ≥ 6 valid pairs (both providers represented), else the verdict is
     "insufficient evidence", not promote and not kill.
   - Iterate-vs-kill guidance: if supervision demonstrably ran (hook or
     loop interventions observed where expected) and the deltas are
     negative, that is evidence against the architecture (lean kill or
     major redesign); if supervision again failed to engage, that is a
     defect (iterate) — the distinction matters and must be reported.
3. The analysis plan: scoring dimensions and weights (reuse the prior
   pilot's rubric unless defective — same rule as above), how pairs are
   invalidated (protocol audits happen after unblinding, criteria stated
   now), and the blinding procedure (two blinded graders + blinded
   adjudicator, arm key sealed until grades lock — as before).

Anything not pre-registered is exploratory and must be labeled as such in
the summary. Changing criteria after seeing results is prohibited.

## Phase 1 — Fix the two protocol defects

1. **V301 prompt:** amend the case so the file fence excludes `.cruise/`
   ("do not modify files outside X and Y; run-metadata under `.cruise/`
   is exempt and graded separately") keeping everything else identical
   across arms. Record the new prompt digest.
2. **Codex isolation:** run every Codex arm under a sandboxed
   `CODEX_HOME` (fresh temporary home per run) that contains ONLY the
   credentials needed to authenticate — no globally installed plugins,
   skills, or config. Verify isolation mechanically before the official
   runs: a probe run must show the treatment loads the v0.3.1 checkout
   skill (digest match against the working tree) and the control surfaces
   no Cruise skill at all. Record both probe outputs. If isolation cannot
   be achieved while preserving authentication, stop and report — do not
   run contaminated official trials.

## Phase 2 — Execute

- Full matrix: 4 cases × 2 arms × both providers, one replicate
  (16 official runs), same artifact custody as the prior pilot (raw
  transcripts, verifier logs, diffs, metadata, hashes; results validate
  against the repository schemas).
- Claude budget and timeouts: reuse the prior pilot's settings unless a
  checkpoint documented a reason to change; record whatever you use.
- If a Codex treatment hits the new bootstrap deadline (distinct exit
  code from Task I), that is a *captured diagnostic result*, not an empty
  hang — record it as such; two or more bootstrap-deadline failures mean
  stop, diagnose with the emitted diagnostics, fix or report, and note
  the protocol interruption honestly.
- Nothing about G/H/I may be patched mid-study. If a code defect blocks
  the study, stop, report, and let the orchestrator decide; a study over
  mixed code versions is invalid.

## Phase 3 — Grade, unblind, verdict

- Blinded grading per the pre-registered plan; seal and then merge the
  arm key exactly as the prior pilot did (mode-0600 keys, merge after
  grade lock).
- Apply the pre-registered validity audits, then the pre-registered
  criteria, and state the verdict in
  `evals/results/<date>/SUMMARY.md`: **promote / iterate / kill /
  insufficient evidence**, with the numbers, the supervision-engagement
  evidence (interventions observed per run — this time it must come from
  official scored runs), limitations, and the single next action.
- Cross-reference the prior pilot: state explicitly which of its
  invalidations this study cured and which limitations remain (single
  replicate, synthetic fixtures, no interactive operator).

## Honesty rules (absolute)

Never fabricate, extrapolate, or average away a run that did not happen.
If a host is unavailable, run the other provider's half and label the
verdict "insufficient evidence — <provider> gated". A
partial-but-honest study is a success; an embellished one is a failed
task. Negative results are publishable results.

## Files you own

`evals/**` (cases amendment, runner isolation support, results),
`docs/checkpoints/v0.3.1/CHECKPOINT-J.md`, `CHANGELOG.md` and version
fields (bump to 0.3.1 across `package.json` and both plugin manifests
after the study concludes), the README exit-code/limitations rows if the
study's outcome changes documented claims.

## Files you must not touch

`skills/**`, `scripts/lib/**` (except runner-support code under
`evals/`), `hooks/**`. If the study reveals a code defect, record it in
`evals/results/<date>/FINDINGS.md` — the no-mid-study-patching rule
exists so the study measures one code version.

## Acceptance criteria

- PREREGISTRATION.md committed before the first official run (verifiable
  by commit order).
- Isolation probe evidence for both Codex arms captured before official
  runs.
- All result artifacts validate against the schemas
  (`node evals/validate-v03-results.mjs`).
- SUMMARY.md's verdict follows mechanically from the pre-registered
  criteria — a reader must be able to recompute it from the tables.
- The checkpoint artifact records what this study still cannot prove.
