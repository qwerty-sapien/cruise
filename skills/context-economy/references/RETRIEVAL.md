# Bounded retrieval

## Retrieval ladder

Use the first step that can answer the current uncertainty.

1. Applicable `AGENTS.md` chain and compact state pointer.
2. `git status --short`, changed paths, and capped tracked-file map.
3. Package manifests, entry points, route/config names, and test commands.
4. Exact symbol or string search.
5. One 80-line window around the strongest match.
6. Caller, callee, test, schema, or configuration window needed to falsify the leading hypothesis.
7. Adjacent 80-line expansion only when syntax or control flow is incomplete.
8. Deterministic focused test or reproducer.
9. Broader search only after a contradiction or failed discriminating test.

## Read-more rule

Keep reading when at least one item is unresolved:

- the definition is syntactically incomplete;
- the call site or return path is unknown;
- the state owner is ambiguous;
- a configuration or schema can override the observed code;
- a test contradicts the hypothesis;
- a security, scientific, or external-effect invariant has not been checked;
- the proposed test cannot distinguish the leading alternatives.

Stop reading when all are known:

- responsible owner;
- relevant invariant;
- minimal edit surface;
- at least one direct code fact;
- at least one independent behavior, test, config, or interface fact;
- focused verification command;
- explicit remaining uncertainty.

## Hard limits

- One file window: 160 lines and 16 KB maximum.
- Discovery round: six windows maximum.
- Visible repository map: 12 KB maximum.
- Visible command output: 12 KB maximum.
- Long lines: truncate to 500 characters unless the exact line is the subject.
- Search results: top 20 grouped matches, then narrow the query.
- Logs: errors, first and last relevant sections, and deduplicated repeated lines.
- JSON and YAML: selected fields, counts, schema, and samples.
- Tables: headers, row count, null counts, and a bounded sample.
- Full raw output: write to `.cruise/artifacts/` and return a path plus digest.

## Default exclusions

```text
.git/
node_modules/
.venv/
venv/
dist/
build/
.next/
coverage/
playwright-report/
test-results/
logs/
archive/
archives/
vendor/
generated/
assets/
public/images/
models/
weights/
checkpoints/
*.bam
*.bai
*.gem
*.h5
*.h5ad
*.h5ms
*.npz
*.npy
*.parquet
*.feather
*.pt
*.pth
*.ckpt
*.safetensors
*.png
*.jpg
*.jpeg
*.webp
*.mp4
*.zip
*.tar
*.gz
```

An excluded path can be inspected only when the task names it or evidence makes it necessary. Use metadata or a deterministic extractor first.

## Hypothesis discipline

Maintain up to three alternatives. Confidence labels:

- low: plausible from names or one indirect clue;
- medium: direct code evidence;
- high: direct code evidence plus independent behavior, test, config, or interface evidence;
- verified: discriminating test or exact reproducible result.

Never treat absence from the first search as proof of absence. Before a high-confidence claim, check aliases, generated code boundaries, configuration, and the nearest test.

## Repository map

The deterministic map should contain only:

- root packages and languages;
- top-level owned directories with file counts and bytes;
- package manifests and scripts;
- instruction files;
- current-state pointers;
- changed files;
- largest tracked text files;
- likely generated, binary, archive, and data paths;
- exact entry points.

Cache it by Git HEAD plus dirty-path metadata. Rebuild only invalidated sections.

## Named read roots and read-only workers

Read scope is separate from write ownership. A task naming an ordinary file or
search directory supplies its retrieval scope, including sibling relative paths
and absolute paths. No additional confirmation is needed for those reads.

Use `node scripts/context-view.mjs --root /named/directory slice notes.md 1 80`
or `node scripts/context-view.mjs search pattern ../shared` to choose a read
root or search root. `--root` defaults to the working directory. Git discovery
is optional for extraction; non-Git roots support named reads, maps and searches.
Unscoped Git maps/searches use tracked files. Named directories and non-Git
roots enumerate at most 4096 entries and 32 directory levels; exceeding a cap
requires a narrower root. Sensitive paths, explicit sensitive-path exclusions,
Git ignore rules, root underscore Markdown and symlink checks still apply before
content access. Named read roots never expand write ownership.

Read-only workers must pass `--no-persist` (API: `noPersist: true`). This mode
bypasses cache reads and all artifact/cache writes; do not add writable product
roots to satisfy retrieval. If ordinary persistence is unavailable, extraction
still returns the same capped content and digest. `artifact_path: null`,
`cache_hit: false`, and `persistence: disabled|unavailable` distinguish missing
artifacts from persisted evidence; `persistence_error` supplies the filesystem
error code for an unavailable store. Results include the absolute `root` and
root-relative `sources` for provenance. A digest of returned raw extraction is
not evidence that an artifact was persisted or that the entire source was read.

## Managed CLI transport and native sandbox failures

The managed CLI is control-plane transport. If the parent native sandbox cannot
start it, retain the exit code and bounded stderr evidence. Request native
escalation for the exact command with a bounded task justification grounded in
existing user authority, including source scope, destination and secret exclusions.
Keep the worker task thread read-only when requested; transport escalation does
not expand its file access or write ownership. Continue using `--no-persist`.

An OS error such as `EPERM`, `Operation not permitted` or `permission denied`
is not an automatic approval reviewer rejection. Exit code 1 alone establishes
neither a permission error nor a sandbox cause. An actual approval rejection
remains authoritative: report its reason, do not blindly retry, and do not bypass
host permission. No automatic launch retry follows a diagnostic hint.
