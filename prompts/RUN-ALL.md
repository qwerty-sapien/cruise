# Orchestrator — execute the full Cruise v0.3 DAG in one run

You are executing a six-task implementation plan for the `cruise` repository
(the current working directory). The six task specifications already exist
as files in `prompts/`; **they are the authoritative specs — this document
only sequences them and sets ground rules.** Read each one in full
immediately before starting that task, and follow it exactly, including its
acceptance criteria and its design-philosophy section.

## Execution order

Run the tasks **serially, on the current branch**, in this order:

```text
1. prompts/A-hygiene.md            (delete retired v0.1 control plane)
2. prompts/B-flight-plan.md        (.cruise/FLIGHT.md + flight-plan.mjs)
3. prompts/C-codex-supervisor.md   (stall supervisor in the Codex goal loop)
4. prompts/D-claude-hooks.md       (Stop-hook supervisor for Claude Code)
5. prompts/E-build-queue.md        (.cruise/QUEUE.md + `cruise queue run`)
6. prompts/F-evals-and-docs.md     (paired evals + docs reconciliation)
```

Because you are one session on one branch, the specs' inter-task rules
translate as follows:

- **"Files you must not touch" lists mean "not during this task."** They
  were written to keep parallel sessions mergeable; for you they are phase
  scope fences. Do Task C's work in Task C, not opportunistically during
  Task B.
- **"Expected merge conflict" notes do not apply.** Additions to
  `package.json` (`files`, `test`) simply accumulate across tasks.
- **The C∥D decoupling rule still stands as written:** D's hook script
  re-implements its own small fingerprint helper rather than importing
  `supervisor.mjs`, and marks it with a consolidation TODO. Do not
  "improve" this by sharing code — the decoupling is deliberate (the hook
  must run as a standalone process from the packaged plugin).
- Where a spec says another task "owns" a file you later reach (e.g. C owns
  `LIMIT_POLICY.md`, F owns the README rewrite), that ownership arrives
  when you reach that task.

If `prompts/` is untracked, commit it first ("add v0.3 implementation
specs") so history records what was executed.

## Gates between tasks

After each task, before starting the next:

1. Run `npm test` — must be green, including that task's new suites.
2. Run `node scripts/cruise.mjs --help` — must succeed.
3. Run `claude plugin validate .` if the `claude` CLI is available;
   otherwise note its absence once and continue.
4. Confirm the task's own acceptance-criteria checklist item by item.
   An unmet criterion is a blocker for that task, not a note for later.
5. Commit in the reviewable slices the spec asks for. Never carry
   uncommitted work across a task boundary.

If a gate cannot be satisfied after genuine remediation attempts, stop the
run there and report: which task, which criterion, what you tried, and what
evidence or decision is needed. Do not proceed to a later task on top of a
failed gate, and do not weaken a criterion to pass it.

## Ground rules for the whole run

- **The design philosophy in the specs is non-negotiable.** Artifacts
  (`FLIGHT.md`, `QUEUE.md`) are advisory compiled intent, never authority;
  supervision is evidence-based, user-tunable, and fail-safe (ladders end
  in pause-with-report / allow-with-report). If an implementation choice
  seems to require an approval object, ledger, digest, archive, or
  run-control authority, the choice is wrong — find the advisory-shaped
  alternative or stop and report the tension.
- Do not redesign the specs. If two specs genuinely conflict at a seam
  (e.g. an API detail B pinned that C needs shaped differently), resolve
  it with the smallest change, note the deviation explicitly in that
  task's commit message and your final report, and keep the pinned public
  contracts (`FLIGHT.md` schema, `flight-plan.mjs` API, supervisor verdict
  levels, `QUEUE.md` schema) stable — later tasks and documentation
  depend on them verbatim.
- No new runtime dependencies anywhere in the run.
- Keep code style matched to the existing live modules
  (`simple-session.mjs`, `origin-note.mjs`): plain ESM, no frameworks,
  `node --test` for tests.

## Task F specifics

Task F's paired evaluations require live hosts. Run `cruise doctor` for
both providers first; execute every trial the environment supports, build
the remainder as runnable fixtures, and record honestly what stayed gated.
**Never fabricate, extrapolate, or summarize a trial that did not run.**
A partial-but-honest F is a successful F; an embellished one is a failed
run.

## Final report

End with: tasks completed with commit ranges; total lines deleted (A) and
added; every deviation from a spec with its rationale; gate results per
task; eval verdict or gated-status summary from F; and the single next
action you would recommend.
