# Changelog

## 0.9.0 — 2026-11-14

- Keep Cruise thin: native hosts own sign-in, permissions, tools, and agent
  communication; removed managed/auth/quota control layers stay removed.
- Start the first native Goal turn when the host is idle, preserve execution
  intent across a read-only Plan bootstrap, and handle reply/notification order.
- Distinguish an unavailable input channel from an explicit owner refusal;
  render structured native choices while returning their original payloads.
- Observe startup promise failures promptly, prevent turns after failed
  activation, and send input RPC errors before closing worker transport.
- Bind assurance to bounded content snapshots in ordinary non-Git workspaces
  and reject stale evidence after product changes.
- Reuse the canonical Flight template; keep agent handoffs scoped to the
  assigned identity’s latest checkpoint and use native peer messages.
- Reject non-regular checkpoint inputs before reading so a FIFO cannot hang
  bounded retrieval; block incomplete latest task/progress without older fallback.
- Install only the runtime package, excluding private contexts, conversation
  histories, local artifacts, user references, and retired skill archives.
- Add regression coverage for the audited adapter failures and their lifecycle
  and filesystem siblings. Live canary scope and limitations are recorded
  separately from the mock-only test suite.

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
