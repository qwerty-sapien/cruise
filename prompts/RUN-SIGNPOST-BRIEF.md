Execute the Cruise observability pair defined in prompts/K-run-signpost.md and prompts/L-supervisor-trail.md.

Those two files are authoritative; read each in full immediately before starting it. Where this summary disagrees with them, they win.

Both are small (tens of lines of product code). Do not grow them into a logging subsystem — Cruise stores pointers and its own verdicts, never a mirrored transcript. Codex's rollout JSONL remains the authoritative trace and Cruise must not duplicate it.

K — run signpost: surface which Codex rollout file corresponds to this run. Its first step is an empirical gate: determine whether Cruise's thread id equals the rollout session_id, and if no reliable correspondence exists, print the thread id and sessions directory rather than guessing a path. Resolve paths by globbing the id suffix (never by constructing the local-time filename timestamp) and honor CODEX_HOME so sandboxed evaluation homes resolve correctly. Signpost goes to stderr; a pointer goes to .cruise/LAST-RUN.json.

L — supervisor trail: persist Codex-side supervisor state and the terminal stall report to .cruise/.supervisor.json using the same schema the Claude Stop hook already writes, so both hosts are equally auditable. Liveness scratch only: replaces itself per run, gitignored, bounded growth, no authority, never a ledger.

Sequencing, and check the repo state before assuming:
- K edits the bootstrap region of scripts/lib/simple-session.mjs, which prompts/I-bootstrap-liveness.md also owns. If Task I has not landed yet, fold K into I instead of running it separately.
- L edits the continuation-loop/supervisor region of the same file, which prompts/G-flight-self-heal.md owns. If Task G has not landed yet, fold L into G.
- If G and I have landed, run K and L in either order; they own disjoint regions.
- L must land before prompts/J-clean-rerun.md executes, so the study's Codex arm yields the same grade of supervision evidence as its Claude arm. Neither task may land while J is running — J's no-mid-study-patching rule is absolute.

Protocol per task, same as the v0.3.1 pipeline: a falsification checkpoint whose red-team probe must demonstrably FAIL on pre-change code and PASS after; a cold-context hostile review of the diff against the spec; then docs/checkpoints/v0.3.1/CHECKPOINT-<task>.md and the standard gates (npm test, node scripts/cruise.mjs --help, claude plugin validate . when available). Commit each task with its checkpoint. A checkpoint that cannot honestly complete fail-before/pass-after is a blocker: stop and report.

K's checkpoint must record the thread-id/session-id finding — it is the load-bearing fact of that task. L's must state why its file is liveness scratch rather than a ledger, and list every bound on its growth.

Finish with: per-task checkpoint verdicts and commit ranges, the K empirical finding, any deviations, and the recommended next action.
