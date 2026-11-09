# Collaborative Git synchronization

The root Cruise coordinator owns this pre-work check. Bounded workers must not
fetch, pull, or otherwise synchronize the root checkout independently.

Before substantive work in a Git repository, determine whether the relevant
repository path has human collaborators. Use the path-scoped history command
`git shortlog -n -s HEAD -- <path>` (the explicit `HEAD` avoids an empty
stdin-driven shortlog). Ignore `qwerty-sapien` and clearly identified automation
authors such as Claude, Codex, GitHub Actions, and other bot or agent accounts.
Activate this protocol when any remaining human author is present. If the
repository, history, remote, or relevant path is absent, record that fact and
continue without inventing a collaborator.

When the protocol activates:

1. Capture `git status --short --branch`, the current `HEAD`, current branch,
   configured upstream, and remote default branch. Preserve all staged,
   unstaged, and untracked work; never reset, clean, or silently stash it.
2. Run `git fetch` for the upstream remote. Resolve the incoming ref to
   `origin/master` when it exists; otherwise use the configured upstream or the
   remote default branch, including `origin/main` where applicable. Use that
   resolved ref consistently in the commands below.
3. Show incoming commits with `git log HEAD..<incoming-ref>`. Review their
   patches with `git log -p HEAD..<incoming-ref>` or review one aggregate diff
   with `git diff HEAD...<incoming-ref>`. The aggregate form must use three
   dots so it is based on the merge base. Also inspect enough name-status and
   diff-stat information to detect broad deletion, replacement, generated
   output, dependency, migration, authorization, deployment, or configuration
   effects.
4. Classify every incoming commit against the requested task and the previously
   known status quo. If all incoming changes are understood, acceptable, and
   safe to integrate with the current worktree, prefer a fast-forward-only
   pull. Never pull merely because updates exist.
5. If only a reasonable independent subset is acceptable, cherry-pick the
   exact commit OIDs in dependency order and verify the affected surface.
   Never cherry-pick an opaque merge, a commit whose required predecessors are
   rejected, or a change that overlaps unresolved local work.
6. If the preview is a wholesale destruction, modification, or revamp of the
   known codebase, or if local divergence, overlapping dirty work, ambiguous
   intent, or hidden dependencies make integration unsafe, do not pull. Ask a
   concise, incisive question that identifies the exact commits and consequence
   requiring the user's decision. Continue unaffected read-only or isolated
   work when possible.

After any pull or cherry-pick, recheck status, inspect the resulting commit
range and diff, and run focused verification before continuing the original
request. Report what was integrated, skipped, or left for decision. Do not ask
routine questions when repository evidence already establishes a safe answer.
