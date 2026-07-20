# Cruise v0.3 paired Goal pilot — 2026-07-21

Verdict: **do not promote on this evidence**.

Both provider doctor gates passed and all 16 planned official runs executed:
four matched cases × two arms × Codex and Claude Code. Two independent blinded
graders scored every run, and a third blinded grader resolved material score,
blocker, validity, and pair-preference disagreements before the keys were
opened.

## Scored result

Five of eight pairs were invalidated after unblinding:

- all four Codex pairs, because both arms could see a globally installed stale
  Cruise skill; the controls were not Cruise-absent and the treatment skill
  digest did not match the v0.3 checkout;
- both-provider `V301` comparisons (including the already-invalid Codex pair),
  because the shared prompt prohibited every file outside two source files
  while v0.3 treatment requires a `.cruise/FLIGHT.md` execution artifact.

The three remaining valid pairs were Claude `V302`–`V304`:

| Metric | Result |
| --- | ---: |
| Valid pairs | 3 |
| Blinded treatment / tie / control wins | 0 / 0 / 3 |
| Median treatment-minus-control score | −2.5 |
| Blocker-free paired rate | 1 / 3 (33.3%) |
| Completed-or-correctly-blocked endpoint rate | 6 / 6 runs (100%) |

The endpoint rate does not erase the blockers. In `V303`, both arms truthfully
reported the unavailable credential, but neither created parseable active
flight state or traversed the required supervisor ladder. In `V304`, both arms
passed functional and scope verification, but the control omitted the required
flight plan and treatment wrote an invalid one.

Valid-pair details:

| Pair | Treatment | Control | Blind preference | Treatment delta |
| --- | --- | --- | --- | ---: |
| Claude `V302` | Completed; invalid advisory flight | Completed; clean worktree | Control | −1.2 |
| Claude `V303` | Correctly blocked; invalid flight; no ladder | Correctly blocked; invalid flight; no ladder | Control | −7.5 |
| Claude `V304` | Functional completion; invalid required flight | Functional completion; required flight absent | Control | −2.5 |

## Important negative findings

- Every `FLIGHT.md` produced by a scored Claude treatment lacked opening and
  closing YAML frontmatter fences. The parser rejected all of them, so the live
  Stop hook never intervened in an official paired run.
- All four Codex treatment processes reached their timeout with an empty
  transcript and no tracked implementation. The third grader ruled these
  scored timeouts rather than infrastructure-invalid runs, but the pairs were
  later invalidated for plugin/skill contamination.
- One Claude control (`V301`) used `lower()` instead of `casefold()` and falsely
  claimed functional completion despite the hidden oracle failure. Its
  treatment mate passed the oracle but violated the prompt's explicit two-file
  fence by creating `FLIGHT.md`; the pair was invalidated as structurally
  unfair after unblinding.
- The small sample, synthetic fixtures, single replicate, absent interactive
  operator, and partial host telemetry prohibit a broader superiority claim.

## Liveness acceptance evidence

The scored stall arms did not demonstrate the complete ladder. An explicitly
unscored, treatment-only diagnostic therefore pre-seeded the same Claude `V303`
fixture with a parser-valid active flight while leaving the prompt, plugin,
credential, verifier, and 1/1 thresholds unchanged.

That live transcript captured three Stop events: `realign`,
`final-experiment`, then allow-with-report `stalled`. `supervisor.json` records
the same two interventions and terminal ladder state; the verifier remained at
exit 23 and the only worktree entry was untracked `.cruise/`. This proves the
packaged hook path and bounded backstop, but it is excluded from paired scores
and does not repair the official `V303` outcomes.

## Artifacts and custody

- `doctor.json` records both provider gates.
- `raw/` contains the normalized transcript, verifier, diff, status, metadata,
  and optional flight/supervisor files for all 16 official runs.
- `runs/`, `pairs/`, and `study.json` validate against the repository schemas;
  weighted totals, references, and artifact hashes are recomputed by
  `evals/validate-v03-results.mjs`.
- `arm-key.json` was merged from two mode-0600 temporary keys only after all
  blind grades and adjudications were locked.
- `diagnostics/claude-liveness/` contains the excluded ladder proof.

The single recommended next action is to make the Goal skill emit and validate
the pinned YAML-frontmatter `FLIGHT.md` shape before the first execution step.
