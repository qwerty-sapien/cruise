# Changelog

## 0.4.3 — 2026-09-13

- Updated worker routing documentation and prompts for the current L1–L7 model
  catalog, including conditional L7 and Astra-ultra escalation behavior.
- Reclassified mid-job Cruise source, skill, version, and integrity-hash drift
  as exceptional internal recovery rather than an authorization or waiver
  boundary.
- Added bounded significance assessment and selective invalidation: unaffected
  and user-owned work survives, only Cruise-owned code affected by changed
  instructions is reworked, and non-code artifacts remain unless semantically
  invalidated.
- Removed forced task restarts from stale-cache recovery while retaining strict
  never-read handling for dotenv and explicitly sensitive paths.

## 0.4.2 — 2026-09-12

- Made Codex Doctor compare critical installed plugin bytes with the configured
  marketplace source instead of trusting a matching version string alone.
- Defined source refresh, cache reinstall, digest verification, and new-task
  reload as one update operation so working-tree patches cannot leave Codex on
  stale skill instructions.
- Removed speculative worker-model disclosure approvals while retaining strict
  pre-access exclusion for dotenv, credential, private-key, and explicit secret
  paths.

## 0.4.0 — 2026-07-25

- Centered Cruise on Flight v2: an adaptive quality contract whose receipts are
  bound to the exact original request, product workspace, and gate definitions.
- Added deterministic `cruise attest`, required core quality dimensions, web,
  backend/data, and C++/HPC profile packs, plus independent review for high-risk
  work.
- Interlocked Codex and Claude completion with the same shared assurance
  evaluator; strengthened product fingerprints to include HEAD and untracked
  contents while excluding Cruise scratch.
- Folded Refine into Goal's executable and explicit plan-only paths, leaving
  four public skills: Build, Quick, Goal, and Debug.
- Added session-scoped Claude Stop supervision, workspace ownership, truthful
  launcher results, explicit session IDs, and authentication-aware Doctor
  checks.
- Closed assurance-downgrade paths: Flight v1 is migration-only, mandatory core
  gates must pass with non-empty explicit evidence, inherited obligations join
  the context binding, and attestation now distinguishes a closed active
  contract from accepted completion.
- Preserved Claude resume intent, bounded completion correction despite
  contract churn, rejected forged future queue completion, Flight substitution,
  and milestone deletion, and made Codex Doctor verify the installed/enabled
  Cruise version.

## 0.3.0 — 2026-07-21

- Removed the retired v0.1 workflow control plane, state, archives, approval
  objects, ledgers, and dead package closure.
- Added user-editable advisory `.cruise/FLIGHT.md` Goal envelopes and
  `.cruise/QUEUE.md` milestone queues.
- Added evidence-based bounded Goal supervision: native Codex Goal
  continuation and pause-on-stall, plus a fail-open Claude Code `Stop` hook.
- Added sequential `cruise queue status|run` execution and stable stalled exit
  code `3`.
- Added a live-host paired evaluation pilot with isolated fixtures, blinded
  grading artifacts, raw negative results, and explicit limitations.
- Reconciled the README, architecture, and limit policy with the shipped
  advisory design.
