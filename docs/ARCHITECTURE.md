# Cruise architecture

Cruise compiles a user's outcome into an adaptive quality contract, keeps an
autonomous Goal aligned with it, and accepts completion only with fresh,
profile-complete evidence. The selected host remains the sole authority for
permissions, approvals, models, tools, and external effects.

```text
         Build / Quick / Goal / Debug
                      |
        intent + repository + risk inference
                      |
        QUEUE.md -> Flight v2 quality contract
                      |
       product work + ordinary host verification
                      |
    context-bound evidence receipts and attestor
                 /                 \
        Codex native Goal       Claude session
        completion interlock    scoped Stop hook
```

## Four-skill intent layer

- `build` clarifies a project or major milestone and compiles goal-sized queue
  entries.
- `quick` makes a small, resolved, low-risk change with focused verification.
- `goal` covers finite planned features and consequential work. It uses a
  read-only Plan turn when requested, but otherwise its compact plan launches
  implementation without routine approval.
- `debug` establishes a reproducible failure or bounded hypotheses before
  repair.

Refine was folded into Goal so planning and execution share one alignment and
completion contract. The launcher records its exact request in
`.cruise/ORIGIN.md`; executable direct plugin use must do the same before it
can attest completion. A v2 Goal without that exact request binding is
unassured.

## Flight v2

`.cruise/FLIGHT.md` carries the falsifiable outcome, verification commands,
scope fences, invariants, stall tuning, risk, selected profiles, and quality
gates. `core` is mandatory. `web`, `backend-data`, and `cxx-hpc` add
domain-specific dimensions. High and critical risk require a freshly passed
`independent-review` gate.

Every selected profile dimension must have a gate. Intent, functional
correctness, completion review, and high-risk independent review must freshly
pass; the review dimensions require review evidence. A gate's declared state is one
of `pending`, `passed`, `failed`, `unavailable`, `not_applicable`, or `waived`.
The latter three do not silently count as success: not-applicable needs a fresh
rationale; waived needs an explicit user-decision receipt and yields qualified
completion; failed or unavailable prevents completion.

Evidence is bound to:

```text
SHA256(exact ORIGIN binding + product workspace fingerprint + normalized Flight contract)
```

The product fingerprint includes Git HEAD, tracked/staged changes, and
untracked file contents while excluding `.cruise/**`. The contract binding
includes outcome, verification, scope, invariants, risk, profiles, gate
definitions, and the Flight body that carries inherited obligations, but
excludes status and evidence, avoiding a circular hash.
Changing the request, source, or quality contract makes prior receipts stale.

`cruise attest` computes the context and evaluates receipts. It never executes
gate oracle text. Assertions remain evidence-attested, not cryptographically
proven: domain-specific oracles and skeptical review determine whether the
declared contract is sufficient.

Flight v1 remains parseable for migration and is visibly classified
`legacy-unattested`, but cannot complete a supervised Goal. New Goals and queue
milestones emit v2.

## Bounded supervision

Liveness progress is discriminating product evidence, not Flight contract
churn. Repeated unchanged evidence follows:

```text
observe -> realign -> final experiment -> bounded stall
             ^                |
             +-- new discriminating evidence
```

Malformed Flight data gets a bounded corrective intervention. Hooks fail open
after their hard cap so they cannot trap a host session, but the launcher still
returns stalled or unassured rather than calling that completion.

## Codex

The launcher uses Codex app-server, its native read-only Plan collaboration
mode, and the native Goal object. Active Goals advance across ordinary turns.
When Codex reports complete, Cruise recomputes Flight assurance. Assured or
explicitly qualified completion returns; legacy v1 and incomplete v2 are
reactivated with the exact expected context fingerprint and unresolved gates.
An absolute completion-correction cap prevents contract edits from extending
that loop indefinitely.

Plan-only Goal is a distinct truthful endpoint: no implementation or product
assurance is claimed.

## Claude Code

Cruise launches the native interactive `claude` process with an explicit
session ID and plugin directory. Prompt-expansion, prompt-submit, and Skill
activation hooks arm only the matching Goal session; a session-keyed Stop hook
covers launcher and direct `/cruise:goal` use without a
process-global environment marker. The launcher passes the exact registered
runtime directory and session ID to the process and hooks; hooks never search
the host temp directory for a "latest" run.

Claude has a native conversation-level `/goal`, but no documented Codex-style
Goal object. Cruise does not emulate one or stack native `/goal`
automatically. The Stop hook applies the same Flight evaluator as Codex,
injects bounded repair guidance, and never executes an oracle. The launcher
then independently adjudicates the final Flight: assured completion maps to
zero; blocked, stalled, missing, invalid, or stale assurance does not.

Claude Plan mode remains native and approval-gated. Cruise uses it only for an
explicit planning-only request and never treats a read-only plan as implemented
work.

## Queues and authority boundaries

Build's `.cruise/QUEUE.md` contains dependency-ordered milestones. Queue run
compiles each ready milestone into a core Flight v2 and advances only after an
independent assurance recomputation against the milestone-controlled Flight
contract. Active-contract or inherited-obligation changes, Flight
substitution, milestone-set changes, and terminal transitions for unexecuted
work are rejected. An active, blocked, stalled, failed, or dependency-deadlocked
milestone stops the queue.

Cruise has no approval object, permission ledger, archive, workflow database,
attempt authority, or emulated Claude Goal lifecycle. It enforces one active
Cruise run per workspace so concurrent sessions cannot replace one another's
ORIGIN or Flight contract. ORIGIN, QUEUE, FLIGHT, attestation, and supervisor
state cannot grant capabilities or override host policy.

## Migration policy boundary

`.cruise/config.toml` selects either a relaxed default or a business-critical
repository profile. The parser rejects embedded credentials, absolute or
escaping paths, secret paths, symlinks, duplicate targets, and unverified
production identities. A target observation must match both its declared
environment and exact non-secret project identifier before execution.

`migration-policy.mjs` masks comments and literals before classifying SQL. A
verified sandbox bypasses production-risk classification. Production queries
must be one explicit-column `SELECT`; the adapter wraps it in `BEGIN READ ONLY`,
a statement timeout, a row cap, and `ROLLBACK`. Production DDL auto-applies only
for one allowlisted noncritical domain or for a nullable, default-free,
constraint-free column addition after bounded source and migration-history
inspection proves that whole-row API and trigger behavior is unaffected.
Unparseable and unclassified SQL is risky, not minor.

`migration-controller.mjs` binds decisions and authorizations to the target and
SQL SHA-256, serializes repeated applications, consumes exact production grants
once, and keeps manual sandbox receipts in memory. Risky production work can be
replayed into a verified sandbox; validation includes configured tests, policy
checks, and main user flows. A failed check retains the sandbox and stops. An
automatic route re-verifies target and digest before production promotion.

Only the exact `cruise migrate` command family can suppress a redundant native
command approval. Raw `supabase`, `psql`, shell composition, credential flags,
seed flags, and digest-authorized production commands remain native host
decisions. Session routing is stored only under the private runtime directory
and is removed with that runtime.

## Runtime state and promotion

Cruise classifies persistence by artifact type and terminal status, never by a
model judgment that content "looks important." Each launcher or worker run
gets a private `mkdtemp` directory under
`$TMPDIR/cruise-runs/<workspace-hash>/` with mode `0700`:

```text
<session-id-hash>-<random>/
  manifest.json
  supervisor.json
  attestation.json
  research/
  workers/
  drafts/
  evidence/
```

The manifest binds the exact workspace and session ID and carries its recovery
expiry. Supervisor state, attestation scratch, worker packets, retry details,
previews, and intermediate research stay there. The exact path is passed to
children; no hook scans temp storage. Normal exit, SIGINT, and SIGTERM run
cleanup. A startup janitor removes expired, valid, owned sessions and refuses
symlinks or unsafe ownership. An unclean crash leaves only the recovery-TTL
capsule.

User-requested deliverables are promoted to their intended repository paths by
atomic rename on one filesystem or copy-to-temporary then rename across
filesystems. Completion promotes requested deliverables and compact evidence,
then removes scratch. Blocked or stalled work retains only the repository
request/Flight/queue resume surface and the host trace pointer. Aborted,
rejected, or not-started work retains no prompt or recommendation artifact;
the user reference may contain only a content-free status tombstone.

The persistent `.cruise` control surface is limited to the currently resumable
`ORIGIN.md`, `FLIGHT.md`, unfinished `QUEUE.md`, and compact
`LAST-RUN.json` trace pointer (plus its local ignore rule). Terminal completion
removes ORIGIN and Flight; a completed queue also removes Queue. A fresh
unrelated request clears stale ORIGIN/Flight and deterministically deletes
known legacy `runs/`, `goal/`, retry, supervisor, and attestation scratch while
leaving unknown user files untouched.

## Write-only user documents

Cruise reserves root Markdown basenames beginning with `_` as user-only
references. Agents, workers, source discovery, and product fingerprints must
not read, search, summarize, or use these documents as context. Production
reference writers use append-only no-follow descriptors. The changelog writer
may read its own bounded generated marker structure only to preserve immutable
commit segments during a targeted update; those bytes are never exposed to a
model or used as task context.

Executable launcher Goals append one chronological entry to
`_FOR_USER_REFERENCE.md`. Entries use the user statuses `completed`, `blocked`,
`aborted`, `unfinished`, and `not_started`, and serialize only current runtime
inputs plus the current parsed Flight. Direct plugin Goals perform the same
deterministic write with `cruise reference --status <status>` after recording
their truthful Flight state. Append uses a no-follow file descriptor and never
parses or merges prior prose.

Aborted and not-started entries are content-free tombstones: status, end time,
and trace pointer only. They never serialize the rejected request, plan,
recommendation, reason, or Flight.

`_CHANGELOG.md` is commit-triggered rather than terminal-turn-triggered. The
launcher snapshots HEAD when a Cruise run starts and polls it while the hosted
session continues. Uncommitted edits and a run that creates no commit cause no
changelog write. A fast-forward HEAD change is expanded chronologically, so
each newly observed commit receives exactly one immutable section. A checkout,
reset, or branch switch is not misreported as a new commit. A commit-producing
non-fast-forward reflog action such as amend or rebase records the rewritten
commit IDs; the first commit in an initially unborn repository is also
observed.

For each observed commit, Cruise launches a bounded provider-native worker in
parallel with the main session. Deterministic code gives that worker only
bounded script-diff evidence for immutable commit IDs; the worker runs
read-only from the private runtime directory and is not given the repository
as its working directory or any user-document body. The main hosted turn
therefore does no changelog inference. Invalid, missing, or timed-out worker
output falls back to the bounded changed-symbol summarizer without failing the
product run.

Direct native Goal invocations have no launcher parent to poll Git. Their Goal
skill snapshots HEAD and, at reconciliation or immediately after a commit,
delegates each newly observed OID to one sequential native parallel
bookkeeping agent. That agent invokes `cruise changelog --commit <oid>`; the
same deterministic preparation, bounded inference, and targeted writer are
used. Launcher-managed Goals never start this additional agent.

The changelog contains a replaceable `Since last push` region at the top and an
additive commit history below it. A targeted update replaces only the generated
top slice and inserts the latest unseen commit section, preserving all prior
commit-section bytes. Each script point uses
`<file>: patch|delete|new - <summary>` with a 500-character cap. Markdown, JSON,
Cruise state, generated user documents, diffstats, line counts, and raw patches
are never rendered. The writer validates unique balanced markers, regular
no-follow ownership, a size bound, and unchanged file identity before an
fsynced temporary-file rename. A push by itself does not rewrite the file; the
next observed commit resolves the then-current pushed baseline.
