# Core assurance profile

Every Flight v2 selects `core` and defines at least one gate for each dimension:

- `intent`: the delivered result matches the exact original outcome, scope, non-goals, and invariants.
- `functional-correctness`: representative acceptance behavior works, not merely compilation or a happy-path render.
- `regression`: affected existing contracts and tests remain intact.
- `failure-paths`: relevant invalid inputs, boundaries, timeouts, partial failures, and cleanup behavior are deliberate.
- `completion-review`: a skeptical final diff-and-evidence review finds no unresolved in-scope gap.

Choose specific oracles that can discriminate success from superficial plausibility. A test command is evidence only for what it actually exercises. Review generated output or runtime behavior when static tests cannot establish the criterion.

Risk levels:

- `low`: local, reversible, well-covered change with no meaningful public or data boundary.
- `medium`: ordinary feature or refactor spanning behavior or multiple owners.
- `high`: security, persistence, concurrency, public contracts, migrations, costly computation, or broad integration.
- `critical`: safety- or production-critical work with unusually costly failure.

High and critical work also needs an `independent-review` gate. Its evidence must be a fresh skeptical review by an independent agent, reviewer, or genuinely separate review pass; reproduce credible findings before closing it.
