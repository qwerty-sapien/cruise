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
process-global environment marker. Hook scratch is keyed by session and ignored
under `.cruise/`.

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
files cannot grant capabilities or override host policy.
