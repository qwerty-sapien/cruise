# Staged Q&A and Native Goal Activation

Use this protocol to turn an under-specified request into a short, decision-oriented conversation, two reviewable artifacts, and a truthful native Goal transition.

## 1. Capability boundary

The Cruise skill does not bind terminal keys by itself. The plugin also ships a separate dependency-free `cruise` app-server client, which is a real terminal host and can provide a custom picker plus direct access to Codex's persisted Goal control plane.

Use the best native surface exposed in the current runtime:

| Available surface | Required behavior |
| --- | --- |
| Cruise terminal client | Use exactly one blocking `request_user_input` question per call; omit `autoResolutionMs`. The client renders Up/Down, Enter/Space, immediate 1–9, and cancellation controls. Label the distinct, case-sensitive review options exactly **Approve Plan** and later **Start Cruise**; the user must select the option rather than type it through Other. Finalize candidate bytes before each review, then make no post-approval artifact write. |
| `request_user_input` or another structured question tool | Ask one short question with 2–3 mutually exclusive options. Put the evidence-backed recommendation first and use the tool's free-text route for exceptions. |
| Ordinary conversation | Render 2–4 numbered choices and ask the user to reply with a number, option label, or their own text. |
| Native `get_goal` / `create_goal` tools | Inspect state before activation, then directly create the approved Goal after both reviews. |
| User-only `/goal` command | Emit one exact command and wait for later confirmation. |

Do not promise keyboard behavior unless the observed host exposes it. The `cruise` command is the plugin's pbrain-like host; ordinary Codex chat remains native-selector or number/label/free-text behavior.

## 2. Q&A state machine

Maintain an internal, concise uncertainty ledger with these states:

```text
inspect → choose one material uncertainty → ask → receive answer
        → record impact → (ask next material uncertainty | draft plan)
```

Start with repository-first reconnaissance. Classify a candidate uncertainty as material only when its answer can change product behavior, scope, protected compatibility, architecture, data/safety risk, acceptance proof, permission envelope, or current slice.

For every answer:

1. Echo the choice and its consequence in one sentence.
2. Mark the relevant requirement or decision as proposed/locked/deferred/reopened.
3. Re-evaluate only affected unknowns.
4. Ask another question only if one remains material.

An answer that accepts the recommendation normally closes that branch. An answer that introduces a new requirement, direction, risk, or acceptance condition opens only the smallest affected follow-up. Never restart the whole interview or ask a generic “anything else?” questionnaire.

## 3. The shape of one question

Use one decision per turn by default. Give only enough evidence to make the choice legible:

```md
**Decision — [short decision name]**

[One sentence: observed fact + why it changes the plan.]

1. **[Recommended path]** — [short consequence]
2. **[Alternative]** — [short consequence]
3. **Other** — reply with a different direction or constraint.

Reply with `1`, `2`, an option label, or your own words.
```

Rules:

- Put the recommendation first, with a reason grounded in observed evidence.
- Keep labels mutually exclusive and descriptions short.
- Use 2–3 choices for a native selector; use at most 4 in plain text.
- Do not include a dense list of assumptions, an entire plan, or multiple unrelated questions.
- Ask two coupled questions only if the native structured UI supports it and one answer is meaningless without the other.
- Never treat a missing reply, an ambiguous “sure,” or a reaction to a plan as Start approval.

## 4. Q&A depth and fast paths

Use less Q&A when evidence already fixes the direction:

- A clear request plus an inspectable repository may need one decision about the acceptance/protected boundary, then a plan draft.
- If the user chooses the recommendation and all mandatory evidence/permissions are already clear, do not add preference questions.

Use more Q&A when the user materially changes direction:

- Re-slice only if the new work cannot fit the current strategically complete outcome.
- Re-open only the decisions and requirements affected by the answer.
- Ask the next safety, acceptance, or permission fork before implementation-detail preferences.

If no material question remains, state that Cruise is drafting the review artifacts; do not manufacture a choice merely to make the conversation feel interactive.

## 5. Two distinct reviews

### Plan review

Write and validate immutable `ORIGIN.yaml`, `SPEC.md`, `DECISIONS.md`, `ALIGNMENT.md`, optional `ROADMAP.md`, and `PLAN.md`. Present a short review card with:

- outcome and current slice;
- locked/reopened decisions;
- DAG/node ownership summary;
- acceptance proof and verification gates;
- permission envelope and deferred work;
- paths and digests for the full files.

Ask whether to **Approve Plan**, revise/reopen it, or save/stop. Use that exact label in the Cruise terminal client. It displays and snapshots the current Plan artifact digests before the picker opens. Approval locks those exact bytes and lets Cruise compile GOAL.md; it never starts target edits or effects, and locked Plan bytes must not be rewritten merely to record approval state.

### Goal review

Compile `GOAL.md` from the approved plan and alignment. Its source-of-truth header must name the exact paths/digests of `ORIGIN.yaml`, `ALIGNMENT.md`, `PLAN.md`, and the supporting SPEC/DECISIONS files. It must make these points explicit:

| Contract element | Minimum content |
| --- | --- |
| Alignment stem | One user-approved outcome, beneficiary, scope fence, and protected behavior. |
| Read first | Validated `ORIGIN.yaml`, `ALIGNMENT.md`, `PLAN.md`, `GOAL.md`, plus concrete repository files/discovery commands. |
| Scorecard and stop | Measurable acceptance/gate threshold and an unambiguous stopping condition. |
| Feedback loop | Fast representative check, cadence, and slower final/adversarial check. |
| Checkpoints | Working-memory/progress-log paths and when to update them; say explicitly when none are necessary. |
| Boundaries | Permissions, non-goals, interruption conditions, and no automatic scope expansion. |

Show a compact card built from those fields. The explicit **Start Cruise** choice approves GOAL.md and the already-approved plan together. Revising GOAL.md materially after plan approval invalidates it and any affected plan/digest; return to the smallest necessary review step.

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

After the final Start choice:

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

4. If the Cruise terminal client owns the thread, finalize all bytes before showing **Start Cruise**. After selection, do not rewrite an approval-state field or any contract artifact; finish the preparation turn without calling `create_goal`. The client verifies the exact Plan and Goal snapshots plus repository baseline, changes collaboration mode from Plan to Default, checks `thread/goal/get`, calls `thread/goal/set` once, verifies the response and persisted state, and monitors the native Goal continuation that starts automatically.
5. Otherwise, if `create_goal` is exposed, call it once and confirm its returned active state/identity.
6. Only after active-state confirmation create CLOSEOUT.md and begin execution.
7. If only a user slash command exists, emit the exact `/goal` command containing that objective and stop. Do not call a shell, fake a CLI event, or call this activation successful.
8. If native Goal is unavailable, offer the exact **Execute in Current Thread** fallback only through a separate `D-XX` decision bound to current Plan/Goal/baseline digests and only if the user explicitly accepts the loss of durable continuation. Never call it Start or native activation.

## 8. Evidence and forward tests

For a forward test, capture:

- each Q&A turn and why it was material;
- option/recommendation plus response method (native selector, number/label, free text);
- response-driven follow-up or explicit fast-path decision;
- separate plan and Goal approvals with their artifact digests, including ORIGIN;
- activation method, returned state, and resolved ALIGNMENT/PLAN/GOAL references.

Treat these as failures:

- a monolithic question dump;
- a redundant follow-up after a recommendation closes all material uncertainty;
- activation after plan approval but before Goal approval;
- a claimed automatic `/goal` transition without a real `create_goal` or `thread/goal/set` result;
- unresolved, stale, or mismatched alignment/plan references.
