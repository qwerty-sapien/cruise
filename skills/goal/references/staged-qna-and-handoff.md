# Staged Q&A and Native Goal Activation

Use this protocol to turn an under-specified request into one Goal-needs decision, one combined Plan-and-Goal review, and a truthful native Goal transition.

## 1. Capability boundary

The Cruise skill does not bind terminal keys by itself. The plugin also ships a separate dependency-free `cruise` app-server client, which is a real terminal host and can provide a custom picker plus direct access to Codex's persisted Goal control plane.

Use the best native surface exposed in the current runtime:

| Available surface | Required behavior |
| --- | --- |
| Cruise terminal client | Omit `autoResolutionMs`. Ask the Goal-needs envelope once, with answer-driven detail only for Select some/Discuss. Finalize PLAN and GOAL, render the deterministic combined preview from their captured revisions, then offer exactly **Approve both**, **Refine**, and **Reject both**. The user must select Approve both rather than type it through Other. Make no candidate-artifact write after offering the combined review. |
| `request_user_input` or another structured question tool | Ask one short question with 2–3 mutually exclusive options. Put the evidence-backed recommendation first and use the tool's free-text route for exceptions. |
| Ordinary conversation | Render 2–4 numbered choices and ask the user to reply with a number, option label, or their own text. |
| Native `get_goal` / `create_goal` tools | Inspect state before activation, then directly create the approved Goal after the combined review. |
| User-only `/goal` command | Emit one exact command and wait for later confirmation. |

Do not promise keyboard behavior unless the observed host exposes it. The `cruise` command is the plugin's pbrain-like host; ordinary Codex chat remains native-selector or number/label/free-text behavior.

## 2. Two-question state machine

Maintain an internal, concise uncertainty ledger with these states:

```text
inspect → Goal-specific needs → (bounded detail branch | finalize envelope)
        → compile Plan + Goal → observed native item or deterministic preview → Approve both | Refine | Reject both
```

Start with repository-first reconnaissance. Infer the product candidate from inspectable evidence instead of front-loading product questions. The two high-level questions are the Goal-specific needs envelope and the combined Plan-and-Goal decision.

For every branch answer:

1. Echo the choice and its consequence in one sentence.
2. Mark the relevant requirement or decision as proposed/locked/deferred/reopened.
3. Re-evaluate only affected unknowns.
4. Ask another question only when Select some, Discuss, or Refine cannot be applied without it.

**Approve all** or **Reject all** closes the needs branch. **Approve both** or **Reject both** closes the combined review. **Select some**, **Discuss**, or **Refine** opens only the smallest affected follow-up. Never restart the whole interview or ask a generic “anything else?” questionnaire.

## 3. Shape of the Goal-specific needs question

Use one decision per turn by default. Give only enough evidence to make the choice legible:

```md
**Goal-specific needs**

[Only the concrete installs, named-site authentication checkpoints, mini-plan autonomy, and ordinary tool permissions this Goal may need.]

1. **Approve all** — include every displayed bounded need.
2. **Select some** — choose a subset in one compact follow-up.
3. **Reject all** — remain interactive and pause when a need arises.
4. **Discuss** — clarify the envelope before it is finalized.

Reply with `1`, `2`, an option label, or your own words.
```

Rules:

- Put the recommendation first, with a reason grounded in observed evidence.
- Keep labels mutually exclusive and descriptions short.
- Use these four choices for the needs selector; use the same numbered labels in plain text.
- Do not include a dense list of assumptions, an entire plan, or multiple unrelated questions.
- Never treat a missing reply, an ambiguous “sure,” or the needs answer as combined approval.

## 4. Branch depth and fast paths

Use no extra branch when the answer is **Approve all** or **Reject all**. Compile the candidate immediately.

Use one compact branch when the user chooses **Select some**, **Discuss**, or **Refine**:

- Re-slice only if the new work cannot fit the current strategically complete outcome.
- Re-open only the decisions and requirements affected by the answer.
- Ask the next safety, acceptance, or permission fork only when the selected branch cannot be recorded safely without it.

Once the branch is resolved, draft the review artifacts; do not manufacture another high-level choice.

## 5. One combined review

Write and validate immutable `ORIGIN.yaml`, `SPEC.md`, `DECISIONS.md`, `ALIGNMENT.md`, optional `ROADMAP.md`, `PLAN.md`, and `GOAL.md` before approval. In Codex GUI, request a combined native Plan item as a best effort and use it only if observed. Otherwise immediately present the deterministic Cruise preview. It contains bounded meaningful excerpts, full-file links, both revision hashes, and a Plan section covering:

- outcome and current slice;
- locked/reopened decisions;
- DAG/node ownership summary;
- acceptance proof and verification gates;
- permission envelope and deferred work;
- paths and digests for the full files.

The Goal section follows in the same frame. `GOAL.md` is compiled from the still-mutable candidate plan and alignment. Its source-of-truth header must name the exact paths/digests of `ORIGIN.yaml`, `ALIGNMENT.md`, `PLAN.md`, and the supporting SPEC/DECISIONS files. It must make these points explicit:

| Contract element | Minimum content |
| --- | --- |
| Alignment stem | One user-approved outcome, beneficiary, scope fence, and protected behavior. |
| Read first | Validated `ORIGIN.yaml`, `ALIGNMENT.md`, `PLAN.md`, `GOAL.md`, plus concrete repository files/discovery commands. |
| Scorecard and stop | Measurable acceptance/gate threshold and an unambiguous stopping condition. |
| Feedback loop | Fast representative check, cadence, and slower final/adversarial check. |
| Checkpoints | Working-memory/progress-log paths and when to update them; say explicitly when none are necessary. |
| Boundaries | Permissions, non-goals, interruption conditions, and no automatic scope expansion. |

After the presentation, offer exactly **Approve both**, **Refine**, and **Reject both**. The explicit structured **Approve both** choice locks and approves PLAN.md, GOAL.md, every supporting contract artifact, and the repository baseline together. **Refine** reopens the pair and branches into the smallest targeted change; show one replacement presentation before asking again. **Reject both** saves nothing as executable authority. This ordering eliminates the old write-between-reviews window: missing headings, alignment corrections, permission changes, and GOAL compilation are all resolved before the only approval snapshot.

## 6. Alignment enforcer

`ALIGNMENT.md` is a compact, versioned anti-drift file, not a second long specification. Use this form:

```md
# Alignment: G-XX — [title]

- **State:** Plan review candidate | Locked by client digest
- **Source-of-truth:** ORIGIN.yaml, SPEC.md, DECISIONS.md, PLAN.md (path + digest)

## Stem

[One concrete approved outcome and beneficiary.]

## Must remain true

- [Protected behavior / scope fence]

## Done only when

- [Acceptance criterion + proof]

## Reopen only when

- [Material decision, drift, or evidence trigger]
```

The native Goal objective and GOAL.md must reference this file and PLAN.md. That durable file reference—not an unsupported symlink or simulated keystroke—is the alignment bridge across turns.

## 7. Native activation procedure

After the combined Approve both choice:

1. Recompute the repository baseline and all approved artifact digests.
2. If `get_goal` is exposed, call it. An unrelated active Goal is a blocker; offer to preserve/finish/pause it rather than overwrite it.
3. Build one concise native objective that includes the alignment stem, stopping condition, and exact relative file references:

   ```text
   Complete G-XX: [alignment stem]. Read `.cruise/goal/ORIGIN.yaml`, `.cruise/goal/ALIGNMENT.md`,
   `.cruise/goal/PLAN.md`, and `.cruise/goal/GOAL.md` before edits. They are
   the approved scope, ownership, evidence, and alignment contract. Work only
   the current slice; preserve protected behavior and permissions; maintain
   checkpoint evidence; finish only when all mandatory AC and gates pass, or
   stop at an explicit blocked condition.
   ```

4. If the Cruise terminal client owns the thread, finalize all bytes before the combined preview and picker. After **Approve both**, do not rewrite an approval-state field or any contract artifact; finish the preparation turn without calling `create_goal`. The client verifies the one exact complete-suite snapshot plus repository baseline, checks `thread/goal/get`, calls `thread/goal/set` once, verifies the response and persisted state, and monitors the native Goal continuation that starts automatically.
5. Otherwise, if `create_goal` is exposed, call it once and confirm its returned active state/identity.
6. Only after active-state confirmation create CLOSEOUT.md and begin execution.
7. If only a user slash command exists, emit the exact `/goal` command containing that objective and stop. Do not call a shell, fake a CLI event, or call this activation successful.
8. If native Goal is unavailable, offer the exact **Execute in Current Thread** fallback only through a separate `D-XX` decision bound to current Plan/Goal/baseline digests and only if the user explicitly accepts the loss of durable continuation. Never call it Start or native activation.

## 8. Evidence and forward tests

For a forward test, capture:

- each answer-driven branch and why it was material;
- option/recommendation plus response method (native selector, number/label, free text);
- response-driven follow-up or explicit fast-path decision;
- one combined Plan-and-Goal approval with every artifact digest, including ORIGIN;
- activation method, returned state, and resolved ALIGNMENT/PLAN/GOAL references.

Treat these as failures:

- a monolithic question dump;
- a redundant follow-up after a recommendation closes all material uncertainty;
- activation without one current complete-suite approval;
- a claimed automatic `/goal` transition without a real `create_goal` or `thread/goal/set` result;
- unresolved, stale, or mismatched alignment/plan references.
