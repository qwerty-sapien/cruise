# Cruise run diff review — 2026-07-15

## Review status and conclusion

This document reviews the complete working-tree change set produced during the July 2026 Cruise
hardening run. It is intentionally a scope and evidence audit, not a release note assembled from
memory. The review covers tracked diffs, new runtime modules, new tests, the Doctor fixture, user
owned repository state, rejected or reverted experiments, final verification, and installation
state.

The source change set is reviewed and validated. It is large but constrained and meaningful: each
remaining file group maps to a requested Doctor-integrity, real-inference, reconnect, foreign-diff,
worker-admission, or spatiomics-fixture requirement. Unrelated automatic-approval work and
formatting-only residue were removed. The source is ready for installation, but this run is not an
installed release: the final plugin remove/add was rejected by the managed approval service after
the account reached its Codex usage limit. The installed-digest and live deep-Doctor rows therefore
remain explicitly blocked rather than being reported as passing.

## Requested outcomes and disposition

| Requested outcome | Implemented disposition |
| --- | --- |
| Remove the recurring packet-export consent prompt | Public skills require Doctor readiness and explicitly forbid asking for a per-packet prompt/repository-export authorization. Deep Doctor is the one-time operational proof of the host path. |
| Fail Doctor on source/cache mismatch | The runtime digest includes the manifest, package metadata, all skills, internal contracts/schemas, scripts, and the bundled fixture. Static Doctor fails on any missing, extra, or changed runtime file. Deep Doctor also pins and rechecks one installed snapshot for the whole run. |
| Exercise real skills in a real repository | Deep Doctor creates isolated copies of `fixtures/doctor/repository`, loads the six public skills from the installed cache, loads the repository-local skill, runs real app-server inference, and requires real runtime/worker evidence for every case. |
| Add a `spatiomics-skill` | The fixture contains a repository-local skill, references, deterministic inspector, validator, Snakemake canary, and synthetic data markers for StereoPy, STAR, BANKSY, SAW 8.1.3, Snakemake, Leiden, BAM, GEM, GEF/GEFF, H5AD/H5MS, annotations, references, GTF, and SIF. It proves structural routing and documentation coverage, not biological validity. |
| Retain complete reconnect history | Worker sessions retain every ordered retry and terminal notification, Codex error identity, HTTP status when present, and sanitized details. Terminal attempt reports retain the full history even when report persistence or packet availability later fails. |
| Determine frequent disconnect cause | The primary Cruise defect was treating every app-server `error` notification as terminal, including `willRetry: true`. Additional deterministic contributors were inherited extension/MCP state, an app-server home that could be unwritable in a restricted worker, unbounded startup/cleanup phases, and shutdown that stopped at SIGTERM. Genuine upstream response-transport or network failures can still exhaust Codex's retry budget. |
| Remove optional network fields | `networkAccess` is omitted from every emitted app-server sandbox policy. Doctor introspects the live schema and fails if the field becomes required or if omission no longer means the verified Boolean false default. Authenticated inference transport is separate from tool/network egress. |
| Explain “source-only authorization” | It is documented as conversational shorthand only. It grants no worker launch, export, network, write, Goal, or other effect authority. |
| Preserve unexpected changes and ask | A host-owned guard snapshots the accepted starting inventory. Unexplained or ambiguous later changes pause workers and writes, persist an incident, and require a root/user disposition. Intentional changes are preserved and adopted without claiming Cruise authorship. |
| Add start-time restore authority | The start choice is **Preserve only** by default or **Allow exact restore**. The latter is only a ceiling: restoration still requires a later structured confirmation bound to the exact incident and path set. No branch permits automatic reset, checkout, clean, stash, quarantine, or blanket overwrite. |
| Let implementation workers use the guard | Non-mapper workers may create only bounded direct `foreign-diff-*` controls and must prove an exact projected action, completion, and clean checkpoint advancement. Existing run artifacts remain byte/mode immutable. Semantic mappers remain exact-facts-only. |
| Preserve `*internal/*` exclusion | `.git/info/exclude` line 13 remains exactly `*internal/*`. The Doctor fixture was deliberately placed at visible `fixtures/doctor/repository`, not under an ignored internal directory. |
| Remove the zip | `py_to_c_example.zip` is absent and is not tracked. No replacement zip was added. |
| Reinstall the latest Cruise | Final source version is `0.1.0+codex.20260715172532`. Explicit plugin removal was attempted but the managed approval service rejected it because the account reached its Codex usage limit until 2026-07-22 10:03. Installed Cruise therefore remains `0.1.0+codex.20260715165311`; no workaround was attempted. Existing already-running Codex threads cannot hot-reload skill text. |
| Review all changes in Markdown | This document is the durable review record. |

## Change-set inventory and scope rationale

### Public contract and documentation

- `README.md` documents Doctor integrity, the real canary, reconnect semantics, source-only
  non-authority, omitted `networkAccess`, the foreign-diff permission model, and limitations.
- `internal/shared/invocation-contract.md` is the shared executable protocol for start permission,
  action projection, incident pause/disposition, worker packet SHA-256, and final checks.
- `skills/{build,quick,refine,goal,debug,research}/SKILL.md` requires the same Doctor and guard
  boundary for all six public routes and removes the per-packet export question.
- `skills/goal/references/{execution-loop,verification-and-closeout}.md` carries the same behavior
  into durable Goal execution and closeout.

These documentation changes are behavioral contracts consumed by Codex; they are not incidental
prose.

### Doctor, installed-runtime integrity, and real inference

- `scripts/cruise.mjs` implements static/deep Doctor orchestration, live-schema checks, exact
  installed-cache identity, worker host-rule verification, packet SHA-256 admission, worker
  attempt finalization, and retained failure evidence.
- `scripts/lib/doctor-plugin-cache.mjs` computes exact runtime manifests and source/cache
  comparisons, including fixture bytes.
- `scripts/lib/doctor-e2e.mjs` stages the installed snapshot and fixture, discovers the installed
  skills, runs app-server inference and actual host worker commands, and validates concrete case
  evidence. Its in-memory host broker admits only the exact installed runtime command for the
  active Doctor thread/turn/item, canonical fixture root and run, immutable prompt file, and
  preserve-only authority. Runtime completion is argv-digest bound; replay, parallel approval,
  prefix/network/filesystem widening, legacy approval IDs, alternate paths, and restore authority
  fail closed.
- `scripts/lib/doctor-host-rule.mjs`, `scripts/lib/app-server-runtime.mjs`, and
  `scripts/lib/deadline.mjs` provide exact host-path attestation, isolated writable app-server
  state, extension isolation, and bounded lifecycle behavior.
- `scripts/validate-suite.mjs` statically checks that every public skill retains the shared Doctor
  and worker requirements.

### Worker transport, reconnects, and immutable attempts

- `scripts/lib/app-server-client.mjs` escalates an unresponsive app-server from SIGTERM to
  SIGKILL within a bound.
- `scripts/lib/worker-session.mjs` differentiates retryable from terminal notifications, captures
  complete sanitized reconnect history, isolates runtime state/extensions, binds the exact model
  and packet digest, and emits a durable failure envelope.
- `scripts/lib/worker-attempt.mjs` creates host-owned, append-only attempt authority; prevents
  replay after terminal or uncertain outcomes; pins packet/report/run/level identity; protects
  pre-existing controls; and admits implementation-created controls only with guard proof.
- `scripts/lib/worker-report-commit-child.mjs` commits reports through a pinned parent with
  no-follow/no-clobber behavior.
- `scripts/lib/host-authority-lock.mjs` serializes guard and attempt authority using a bounded,
  nonce-bound lock with live-owner rejection and dead-owner recovery.

### Semantic mapping and routing integrity

- `scripts/lib/semantic-mapping-packet.mjs` creates and validates the immutable mapper packet.
- `scripts/lib/routing.mjs` and `internal/schemas/probe-enrichment.schema.yaml` require exactly one
  ordered fact for each of the 18 Quick hard gates and forbid citing mutable `.cruise`/`.git`
  control state as repository evidence.
- `scripts/lib/session.mjs` omits the optional `networkAccess` override from normal Cruise
  app-server requests.

### Foreign-diff detection, permission, projection, and restoration

- `scripts/lib/foreign-diff-guard.mjs` owns inventory/checkpoint capture, host authority mirrors,
  ignore/submodule/index/physical-metadata checks, start permission, projected actions, incident
  persistence, separate disposition, exact preimages, restoration, recovery, and preimage GC.
- `scripts/lib/foreign-diff-control.mjs` constrains worker-created control names.
- `scripts/lib/pinned-rename-child.mjs` performs pinned-parent restoration operations and is paired
  with a durable recovery journal in the guard.
- `scripts/cruise-runtime.mjs` exposes the exact internal begin/check/permission/project/open/close/
  resolve/finalize protocol used through the verified installed entrypoint.

The guard intentionally treats tracked paths matched by ignore rules as tracked, so the user's
`*internal/*` local exclusion cannot hide changes to already-tracked internal files.

### Real Doctor fixture

`fixtures/doctor/repository` is a small, deterministic repository idea with its own `.cruise`
directory and `.agents/skills/spatiomics-skill`. It contains documentation references, an input
inspector, a manifest-bound validator, synthetic positive and negative format markers, a Snakemake
workflow, and tests. Large scientific runtimes and real biological datasets are deliberately not
vendored or executed.

### Regression and adversarial tests

New or expanded tests cover app-server isolation/lifecycle, source/cache digest differences,
host-rule identity, six-skill deep Doctor behavior, semantic packet integrity, reconnect history,
worker attempt replay/TOCTOU, report commits, foreign-diff ignore/index/submodule/path races,
projection, exact permission, crash recovery, host locks, CLI integration, and static skill policy.

The high test-to-runtime line ratio is intentional for security-sensitive filesystem and process
boundaries.

## Root-cause analysis: worker stream disconnects

The observed frequency was partly an interpretation bug, not proof that the backend disconnected
on every event. Before this run, `runWorkerSession` rejected its completion promise for every
app-server `error` notification. Codex uses the same notification with `willRetry: true` while it is
reconnecting. Cruise therefore killed otherwise recoverable turns on the first retry notice.

That defect is resolved: retry notices are retained as warnings and the same turn continues;
Cruise stops only on a non-retryable event, app-server exit, protocol failure, or deadline. Other
fixed deterministic contributors are per-process writable `CODEX_HOME`, disabled worker plugins/
apps/MCP servers, exact turn-ID filtering, bounded setup/requests/cleanup, immediate observation of
fatal promises, and SIGKILL escalation for a stuck app-server.

This cannot eliminate genuine upstream failures. A response stream may still disconnect because
of service/network instability and exhaust Codex's own retry budget. Cruise now preserves the
complete history and makes a terminal attempt non-replayable, so a coordinator cannot silently
launch a duplicate that might repeat side effects.

## Adversarial defects found and corrected during the run

- Source digest initially omitted the Doctor fixture; fixture bytes are now included.
- Explicit custom Codex homes did not reach every readiness/session path; they now do.
- Successful deep Doctor workspaces were retained; success now cleans them while failure keeps
  evidence and reports its path.
- A worker report could be replayed or redirected around ordinary path checks; attempt authority
  and pinned no-clobber report commit now bind it.
- Failure reports initially lacked the full packet/run/attempt identity; all terminal envelopes are
  bound.
- The repository authority mirror could be placed under the worker-writable tree; an in-repository
  temp root now fails closed.
- Ignore rules and dirty submodules could hide changes; complete ignore sources and submodule dirt
  are enforced.
- Virtual metadata keys could collide with legal repository filenames; metadata uses an impossible
  repository-relative namespace.
- Git-clean physical mode/type drift was under-specified; the stage-0 tracked physical ledger now
  covers exact kind/mode.
- Restore previously moved a live target away before replacement, so SIGKILL could leave the path
  absent. Backups are verified copies while the live target remains present, and each restore step
  is journaled durably before mutation.
- Implementation workers initially could not use the guard because the host lock spanned
  inference. Admission and postflight now hold the guard lock separately while an active-attempt
  scan retains run serialization.
- Preimage GC originally retained stale checkpoint material and mishandled empty directories; it
  retains only the current permitted checkpoint and removes stopped/finalized material.
- The first installed live deep-Doctor attempt exposed a deterministic host-path failure rather
  than a stream disconnect: the fixture sandbox could not create its host authority under the OS
  temp directory (`EPERM`), and `reconnect_history` was empty. The worker first attempted invalid
  `begin --help`, repeated the same failed command approval twice, and Doctor advanced to a later
  phase without a canonical run, masking the causal failure. The final broker now supplies one
  exact prompt-file-based `begin`, executes it through the host path without widening the worker
  sandbox, terminates on its first failure, and refuses every later phase without a successful
  canonical monitored run. The final Doctor E2E suite includes regressions for each behavior.
- The plugin manifest exposed four default prompts although Codex accepts at most three. The
  manifest now supplies three and suite validation enforces the host limit.

## Scope corrections and preserved user state

An intermediate automatic-approval feature (`/auto`, `#auto`, and `--auto-approve`) was unrelated
to this request and was removed from code, tests, and documentation. The established
`DANGEROUSLY-TRUST-CRUISE` token spelling was restored. Formatting-only edits in
`scripts/lib/interaction.mjs` and an unrelated formatting hunk in `scripts/lib/session.mjs` were
also removed.

The run did not restore, reset, stash, quarantine, or delete user diffs. The user-supplied
`.git/info/exclude` entry `*internal/*` remains in place. `py_to_c_example.zip` is absent and was not
recreated. Existing repository changes were treated as shared working-tree state, not disposable
agent output.

## Final verification evidence

The entries below are filled only from final commands run against the completed tree.

| Verification | Final result |
| --- | --- |
| Foreign guard + host lock + runtime + worker focused suites | PASS — 164/164 |
| Doctor/CLI/cache focused suites | PASS — 79/79; Doctor E2E alone 50/50 |
| Independent final security review | PASS — no blocker or high-risk issue; independent 79/79 rerun |
| Complete `npm test` | PASS — 584/584 |
| `npm run validate` | PASS — 15/15, including six public-skill Doctor/guard contracts |
| Spatiomics fixture test/validator | PASS — 4/4 and standalone manifest-bound validator |
| Syntax and `git diff --check` | PASS |
| Source/cache mismatch regression | PASS — unit/adversarial coverage; final static Doctor also failed closed on source `20260715172532` versus installed `20260715165311` and the absent matching cache |
| Plugin remove/add and managed-agent reinstall | BLOCKED — managed approval rejected the requested removal because Codex usage is exhausted until 2026-07-22 10:03; installed version remains `20260715165311` |
| Installed static Doctor | BLOCKED as a success gate — all independent checks pass, while `global-plugin` and `installed-plugin-digest` correctly fail for the stale installation |
| Installed six-skill real-inference deep Doctor | BLOCKED — not run against stale bytes and not represented as passing |
| `*internal/*` and zip checks | PASS — exclude line 13 is exact; no ZIP exists |
| Post-install digest recheck | BLOCKED with the reinstall |

## Explicit limitations and trust boundaries

- Existing active Codex threads do not hot-reload reinstalled plugin instructions. Plugin reinstall,
  managed-agent reinstall, and deep Doctor create/verify fresh processes and threads; future
  threads use the new installed version.
- The native structured picker/root coordinator is the permission trust boundary. The internal CLI
  validates exact labels, decision/incident identity, state, and digests, but cannot independently
  prove that arbitrary matching text originated from a particular UI widget.
- Loss of the host temp authority fails closed and can prevent resumption. It does not grant
  permission or infer ownership.
- An uncooperative process can race a pathname between the final identity check and the filesystem
  mutation because portable Node/filesystem APIs do not provide content-aware pathname
  compare-and-swap. Cruise serializes its own workers, pins parents, immediately rechecks, journals
  recovery, and stays paused on mismatch; the final security review must ensure the docs do not
  claim a stronger cross-process atomicity guarantee.
- Deep Doctor validates the real Cruise/Codex orchestration path and structural spatiomics skill
  behavior. It is not a substitute for installing every scientific package, processing a real
  study, or validating a biological conclusion.

## Final constrainedness verdict

> The source changes are constrained and meaningful. They materially improve Cruise in the areas
> the user requested: installation integrity, real public-skill canaries, reconnect survival and
> evidence, bounded worker attempts, user-controlled foreign-diff handling, and a realistic
> spatiomics skill fixture. The size of the diff reflects cross-cutting trust-boundary and
> adversarial test work; no remaining feature surface is unrelated to those outcomes.

That verdict applies to the reviewed source tree, not to completion of the installed rollout. The
run deliberately stops short of claiming the overall goal achieved because the final remove/add,
installed digest pass, and live inference canary require an external approval that was rejected by
the account usage limit. Once installation access returns, the remaining closeout is: remove/add
`cruise@agent-local`, reinstall the seven managed agents, require static Doctor to pass with the
source/cache digest equal, then require `cruise doctor --deep --install-worker-rule --json` to pass
all six isolated public-skill cases.
