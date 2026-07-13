# Private Cruise `_provision` workflow

`_provision` is a private implementation boundary, not a Codex skill or public
route. It has no `SKILL.md`, command, chooser entry, autocomplete entry, or
default prompt. Only the root coordinator of the already selected Cruise
workflow may call it, and `_provision` never invokes a public Cruise workflow.

[schema.yaml](schema.yaml) describes persisted and returned records.
[policy.yaml](policy.yaml) fixes ordering, thresholds, denial rules, and current
host availability. Opaque process-local authorities are intentionally not
serializable and cannot be recreated by writing a schema-valid YAML object.

## 1. Authority and entry

The authority order is fixed:

1. system, developer, sandbox, and host policy;
2. the immutable Cruise Origin Record;
3. the selected public-workflow contract;
4. approved scope, permissions, requirements, and acceptance criteria;
5. repository instructions;
6. explicit user decisions;
7. the capability's bounded specialist role.

Entry requires an opaque Origin-bound `cruise_capability_request` (`CAPREQ-*`).
The request names one concrete competency, tool, connector, method, or evidence
gap and binds it to the originating run, selected public workflow, repository,
consequence level, exact permissions, external-search allowance,
authentication allowance, latency priority, and maximum install scope. A plain
object with matching fields is data, not request authority.

Creation also requires one exact repository root supplied separately from the
serialized request. It must be absolute and equal its normalized resolution;
the process-local binding, not `constraints.repository`, is the filesystem
authority used by install, smoke, rollback, tmux, and local-spin operations.

`capabilityRequestAuthorityDigest()` hashes the exact serialized CAPREQ together
with its process-local Origin digest, normalized absolute repository root, and
granted permission decisions. A provision run persists that value as
`request_authority_sha256`; scheduler entry requires both the same live opaque
CAPREQ object and a matching digest. The digest detects persisted authority
drift, but it cannot recreate or replace the live process-local authority.

The WeakMap-backed handles prevent a schema-valid clone from becoming authority,
but the current constructor trust root is not a hostile same-process isolation
boundary: broker and approval factories are exported and recognize exact issuer
strings. Deployment therefore assumes only the trusted host coordinator can
import those factories and supply their callbacks. A malicious co-resident
module with direct imports is outside the protection currently implemented and
must not be described as contained.

The request is followed by the request-bound native inventory and opaque need
assessment. The assessment uses the request's own consequence level and minimum
delta; adapters cannot substitute easier values. `no_provisioning` is the
default when the gap is not concrete, native capability is sufficient, the
expected benefit is too small, or the recorded search/evaluation/context/
installation/authentication/maintenance/permission/operational-risk cost is
not justified. External
discovery is an internal phase decision, not a completion claim.

Quick never performs external discovery. A Quick gap that survives native
inventory returns the promotion requirement to its originating coordinator.

## 2. Native-first inventory

Inspect every configured native provider in deterministic order:

- bundled skills;
- installed plugins;
- repository-local skills;
- user-local skills;
- administrative skills;
- MCP servers;
- connectors;
- subagent definitions;
- installed CLIs and analyzers;
- repository scripts and tests;
- existing Cruise adaptations.

An absent provider is recorded as unavailable; it is not silently skipped.
Stage A contains bounded metadata only. Stage B applies exact gap,
language/framework, tool, repository, operating-system, public-workflow,
consequence, enabled-state, and exclusion filters and retains at most the policy
limit. Stage C accepts only structured, digest-bearing isolated-review evidence
for the retained identities. Raw candidate instructions never enter the root,
an implementation worker, or a verifier.

Stage C cannot use a caller-supplied evaluation callback. Its opaque native
review broker is created for one exact CAPREQ and must return the same provider,
source path, revision, content digest, and candidate name it was given. Fit is
then recomputed from the request's consequence and improvement gates. Duplicate
immutable native identities and native candidates without a revision, source
path, and content digest cannot become sufficient candidates.

A sufficient native candidate ends provisioning with `no_provisioning` plus the
existing capability identity. External search is permitted only after every
native source has an inspected or unavailable record and no retained native
candidate satisfies the request.

The resulting external-selection object is also opaque. Acquisition accepts
only a candidate bound into that exact request/inventory/need-assessment result;
a serialized copy of the selection cannot authorize acquisition.

## 3. Exclusion and revocation closure

`.cruise/skills/exclude` applies to Cruise-controlled discovery, metadata
collection, detailed review, acquisition, ranking, adaptation, activation, and
invocation. Immutable rejected identities are keyed by repository, commit, and
content digest. A new revision requires a new review.

Exclusion is rechecked:

1. before native or external metadata is returned;
2. before acquisition;
3. before instruction or behavior review;
4. before local-spin validation;
5. before an effect adapter runs;
6. immediately before privileged context construction and invocation.

An earlier approval is not a revocation bypass. The activation check uses the
current exclusion state and the same request, identity, revision, and digests
bound into the opaque evaluation. Excluded or rejected content never enters a
generated worker context. Cruise does not claim that its exclusion file hides a
skill from host discovery outside Cruise control.

Every exclusion snapshot is bound to the exact canonical repository root in
the opaque CAPREQ. A snapshot from another repository is rejected at
acquisition, local-spin activation, and privileged context construction.
Quarantined bytes may be persisted only beneath that same CAPREQ root, and the
bound exclusion digest is rechecked before any quarantine write.

## 4. Bounded discovery and inert acquisition

External discovery requires the opaque need assessment and an exact
`external_discovery` effect authorization. The authorization is bound to the
Origin, CAPREQ, public workflow, and granted permission decision. The private
selection contract separately applies the bounded source budget and supplied
Cruise exclusions. Search records contain bounded sources, queries,
repositories considered and rejected, a stopping condition, and saturation;
they never claim exhaustive internet coverage.

Acquisition is inert and separately authorized. It establishes canonical
owner/repository identity, pins an immutable commit, retrieves trusted hosting
metadata, and fetches the complete review and execution closure needed by the
candidate. The closure includes every instruction, manifest, lockfile, source,
script, executable, dependency descriptor, install input, and smoke-test input
that could affect installation or use. Missing or unhashed closure members make
direct use ineligible.

The acquisition call additionally requires the exact opaque native-first
selection, a current opaque exclusion snapshot, a repository-specific effect
authorization, and an opaque hosting API broker. Selected blobs must agree with
bounded tree byte metadata and are rejected for NULs, Unicode replacement
characters, known binary extensions, executable/indirection hazards, or path
escape. The returned handle binds all of those authorities and the quarantined
bytes process-locally; its visible `acquisition` and `quarantine` fields are not
authority by themselves.

The acquisition authorization process-locally binds the exact canonical
`owner/repository`. A different repository is rejected before any hosting API
or blob-fetch adapter is called; repository identity cannot be swapped after
discovery authorization. Hosting metadata must also return a credential-free
HTTPS canonical URL whose path names that exact `owner/repository`; redirects,
userinfo, query strings, fragments, or a different repository path are rejected
before revision or blob lookup.

Review closure is independent from executable closure. The current conservative
runtime treats every regular file in the reviewed repository tree as part of
that closure; README, reference, example, manifest, source, and otherwise
unclassified files cannot be omitted. If any such path is not selected,
fetched, and hashed, `review_closure_complete` is false, the paths are recorded in
`unexamined_review_closure`, and behavior evaluation and direct use are forbidden
even when executable closure is otherwise complete.

Every retained byte has a path digest, and the ordered artifact-digest manifest
has a content digest. The acquisition handle binds repository, canonical URL,
commit, content manifest, quarantined blob metadata/bytes, request, Origin, and
acquisition authorization. It does
not initialize submodules, materialize LFS, run hooks, install packages, or
execute candidate code. Search snippets and acquired files remain untrusted
data in quarantine.

## 5. Trust, analysis, and behavior evidence

Trust tiers are `official`, `allowlisted`, `established-community`, `uncertain`,
and `rejected`. Official and allowlisted identities still pass provenance,
closure, static, fit, permission, and isolation gates. Community stars are only
a review heuristic: the count, retrieval time, and API source must be trusted
hosting metadata and can never reverse a failed security gate. Incomplete
canonical identity, license, or immutable commit evidence is `uncertain`.
Malicious behavior, explicitly incompatible licensing, an explicit provenance
defect, or a hard technical finding is `rejected`. Every direct external tier—
official, allowlisted, and established-community—requires credible maintenance
(positive active maintainers and recent commits plus a release process),
verified ownership, and credible provenance (an available attestation or a
signed release with a verified signature).

Opaque allowlist entries bind the exact owner, repository, capability identity,
immutable commit, reviewed content digest, release process, and
repository-local installation path. Missing or changed fields cannot produce
the `allowlisted` tier.

Dependency evidence is derived from the reviewed repository tree and selected
dependency manifests, then conservatively combined with hosting metadata. The
runtime discovers JavaScript, Python, Rust, and Go dependency/lock manifests;
it currently parses dependency references and lifecycle scripts from
`package.json`. No manifest is complete zero-dependency evidence. An unsupported,
unselected, or malformed manifest makes `evidence_complete: false`. Incomplete
evidence, observed lifecycle scripts, or a known positive dependency count
without pinning and a lockfile blocks behavior evaluation and all direct use.

Static review covers the complete acquired closure. It records instruction,
script, dependency, tree, Unicode, encoded-payload, secret-access, network,
persistence, privilege, install, telemetry, and authority-override findings.
Unexamined executable or dependency bytes are a hard failure, not an omitted
signal.

Encoded-payload inspection streams matches rather than materializing them and
shares one budget across the complete candidate: at most 20 encoded candidates,
128 KiB of encoded text, and 64 KiB of decoded bytes. Crossing any bound is a
hard finding; a later file cannot reset the budget.

Instruction analysis and behavior/smoke evaluation use separate trusted host
brokers:

- The instruction broker receives delimited quarantined bytes and no repository
  data, home directory, credentials, shell, package installation, external
  effects, or post-acquisition network. It returns a closed structured analysis
  bound to the acquisition and closure digests.
- The behavior broker runs only a statically eligible candidate in a disposable
  technical sandbox with bounded resources, explicit writable paths, an empty
  or allowlisted environment, no secrets or privilege escalation, network off
  by default, and complete command/file-change logging. Its representative
  evaluation and smoke evidence are bound to the same candidate closure.

Behavior evaluation requires the exact opaque instruction-analysis result for
that acquisition. Before the behavior adapter is called, the provisioner checks
the fetched static review, the isolated instruction findings, dependency safety,
execution-closure completeness, and review/instruction-closure completeness.
The returned behavior evidence is bound to that same opaque analysis; evidence
for another analysis, revision, or closure cannot be substituted.
Its serialized record carries representative-evaluation and smoke results,
permission and license evidence, the request-derived fit result, content,
sandbox, command-log and file-change-log digests, and
`raw_candidate_content_exported: false`; the process-local analysis binding is
not serialized as a forgeable Boolean.

Declarative profiles and caller-supplied `passed: true` values are not proof.
Only opaque broker evidence created from observed execution can satisfy these
gates.

Direct external activation additionally requires a synchronous, random-
challenge response from each isolation broker. The response binds the nonce,
exact activation/request context, sandbox profile, isolation/enforcement
identity, observed time, and technical-probe digest. Cruise probes at
attestation and candidate evaluation and re-probes before every direct-use or
privileged-use check. A constructor Boolean, replayed response, or enforcement
drift fails closed.

**Current-host availability:** this repository does not itself provide trusted
instruction-analysis or behavior-execution brokers. Without host-injected
brokers, external direct use and candidate-derived learning extraction fail
closed. The sandbox requirements above describe the integration contract, not
a claim that the current host supplies it.

## 6. Fit, selection, and exact effect binding

Fit is evaluated separately from trust against
`base_codex_plus_repository_instructions`. The request supplies the consequence
level and minimum expected-success delta. The fit record contains the score
dimensions, aggregate, confidence, critical minima, baseline and candidate
success estimates, representative-evaluation result, missing-competency result,
and pass decision.

Direct use is optional. It requires an allowed trust tier, complete immutable
closure, no hard findings, request-derived fit passing every threshold,
brokered instruction and behavior evidence, a passing deterministic smoke test,
exact permission compatibility, exact repository-local install scope, and no
safer native equivalent.

The opaque selected evaluation binds all execution-relevant values: Origin,
CAPREQ, public workflow, repository/canonical URL, immutable revision, content
digest and closure-completeness state, capability identity, version, install
command and installer digest, install scope, permissions, representative
evidence, and smoke evidence. A scheduler candidate that changes any bound
field is rejected.

Direct external installation uses structured argv whose source is the reviewed
canonical repository URL at the exact immutable commit, with pinned version
metadata. A registry package name or semver by itself is not sufficient. The
argv digest is effect-bound, so an adapter cannot substitute a different source,
revision, version, or command after authorization.

The current verified external grammar is an absolute, synchronously rechecked
`npm` executable with lifecycle scripts, lockfile writes, workspace behavior,
and product dependency persistence disabled, installing under
`.cruise/internal/tools/<identity>`. `pnpm` and `yarn` currently fail closed
because no equivalent non-product grammar is implemented. Installation and
smoke verification each require a separate opaque broker bound to the exact
CAPREQ and canonical repository root. Plain scheduler install/smoke callbacks
are rejected. The install result must prove the command digest, file-change log,
isolation evidence, and absolute writes confined to the managed tool root; the
smoke result must carry probe/artifact digests and, for installs, observe only
that managed artifact root.

Each supported external effect--external discovery, acquisition, installation,
and authentication--requires an opaque exact-purpose effect authorization.
Authority binds the permission decision listed by the CAPREQ and normalized
target fields for that effect. Install binds action, identity, repository,
commit/content/version, scope, command/installer digests, and required
permissions; authentication binds run/node/candidate, job/server, job/command
digests, and required permissions; acquisition binds the repository. It does
not currently bind an acquisition closure digest, a rollback plan, or a generic
adapter identity. An authorization for one bound target or scope cannot
authorize another. Application dependencies are never installed merely because
a workflow capability is missing.

Rollback uses its own opaque broker (never candidate code) bound to the exact
CAPREQ and request repository root. After an install failure, rollback is
eligible only for the reviewed direct-use candidate, its opaque install result,
its install authorization, and a declared procedure. The broker receives a
contract digest over request authority, run/node, candidate identity/version/
revision, the procedure digest, installation evidence digests, and managed root;
it must return that exact digest plus rollback evidence, a file-change digest,
and absolute observations confined to the managed root. A missing broker is
reported as unavailable rather than simulated.

## 7. Learning-only material and local spins

Uncertain material remains quarantined. It is never installed, executed, loaded
as an active skill, given repository/credential/network access, or copied into
a privileged context. A learning extraction is available only from opaque,
acquisition-bound instruction-broker evidence. It exports closed structured
methodologies, verification patterns, failure modes, domain checks, and examples
and explicitly exports no raw candidate content.

A repository-local spin must use a unique `cruise-local-*` identity and be
independently authored from the CAPREQ, repository facts, trusted Cruise
references, and the opaque extraction. Its source digests and retained concepts
are immutable. All files, including provenance and evaluation evidence, are
checked for copied quarantined material and unexpected executable content.
Creation requires the exact opaque CAPREQ that authorized the learning
extraction, and `repository_scope` must resolve to that CAPREQ's exact bound
repository root.

Activation requires brokered local-spin evaluations for triggers/non-triggers,
injection resistance, repository fit, tool/write boundaries, secret and network
denial, representative fixtures, stability, baseline improvement, caller
compatibility, and authority non-override. It also requires a fresh on-disk
manifest proving the managed path, regular-file layout, exact `SKILL.md`
identity, provenance, exclusion status, and SHA-256-bound evaluation evidence.
The disk walk is bounded to 512 files, 128 directories, depth 12, 512 UTF-8
bytes per relative path, and 16 MiB total before activation evidence is
accepted. The local-spin record remains process-locally bound to its exact
CAPREQ, repository root, authority digest, and learning extraction. On-disk
validation and activation both require that same request/root/digest binding;
artifact drift fails revalidation.

**Current-host availability:** no trusted local-spin evaluation broker is
provided by this repository. A declared provenance file or self-authored
evidence manifest cannot activate a local spin; activation fails closed until
the host supplies the brokered evidence contract.

## 8. Authentication and continuation

Authentication occurs only after selection and requires a selected evaluation
plus an exact `authenticate` effect authorization. The authorization binds the
Origin, CAPREQ, capability identity, server/endpoint, required identity and
scope, and exact structured argv. Native MCP OAuth uses exactly
`codex mcp login <safe-server-name>` with `shell:false`; candidate text cannot
supply commands, endpoints, environment variables, or credentials.

Persisted authentication state is redacted. Post-auth validation must establish
the bound identity, exact required scope, and capability smoke result before
dependents are released. Timeout, cancellation, spawn failure, validation
failure, and unconfirmed identity are terminal honest states; none is success.

Every auth job declares one identity policy. `any-nonempty` requires a non-empty
observed identity and stores `required_identity: null`; `exact` requires the
observed identity to equal its non-empty `required_identity`. Both policies
require the canonical returned scope to equal the job's exact
`required_scope`. Plain scheduler auth callbacks are forbidden. An opaque
CAPREQ/root-bound verification broker must inspect the exact persisted auth
state and return digest-bearing evidence bound to the effect authorization,
job object/digest, run, node, candidate, server, scope, identity policy, state
path, parsed state, and persisted bytes. The resulting process-local success
attestation is live-revalidated before activation; drift blocks the candidate.
A resumed `waiting_auth` run must reconstruct the exact auth job and opaque
effect authorization because serialized lookalikes carry no authority.

Tmux is transport only and is unavailable unless a trusted host broker attests
the runner file digest, argv boundary, redaction, state persistence, and
post-auth validation behavior. Tmux is not job state and cannot resume Codex.
This repository does not currently provide that trusted runner attestation, so
tmux authentication fails closed.

When such a broker is injected, transport creation also checks the exact opaque
CAPREQ/effect/job/run/node/candidate authority, rereads a bounded regular
non-symlink job file, compares its semantic job digest, and binds its raw byte
digest against later transport creation. Runner attestation and its immediate
reinspection require the exact resolved path and file digest plus regular-file,
non-symlink, executable, argv-boundary, redaction, persistence, and post-auth
validation evidence. The runner argv receives both
`--expected-job-sha256 <digest>` and a separate `--state` path. `saveAuthJob()`
immutably writes `.cruise/internal/auth-jobs/<AUTH-ID>.yaml` (an exact repeat is
idempotent; byte drift fails), while `saveAuthJobState()` atomically writes
mutable state under `.cruise/internal/auth-state/<AUTH-ID>.yaml`.

Automatic same-thread continuation requires both the exact live-revalidated
successful auth attestation/effect authorization and an opaque client
attestation of an auth watcher, post-auth validation, DAG update, and app-server
continuation. It binds the exact live CAPREQ and authority digest, auth job and
digest, provision run, candidate and validated identities, exact scope,
persisted-auth evidence, DAG-state digest, and thread ID. The host must echo the
same bound context, and resume resolution re-creates and compares it. Caller-
supplied identity/scope, cloned records, or issuance before auth success cannot
authorize continuation. Without matching opaque evidence, independent ready
branches may finish, the run persists `waiting_auth`, and the user is asked to
continue.

**Current-host availability:** this repository does not supply the trusted
client-continuation attestation. Automatic same-thread continuation therefore
fails closed to the persisted `waiting_auth` checkpoint.

## 9. Scheduler, fallback, and reconciliation

Provision work is a non-empty acyclic DAG of `CAP-*` nodes. Runtime nodes record
`id`, `capability`, `kind`, `status`, dependencies/dependents, necessity,
approved fallback, attempts, trust, provenance, auth state, smoke evidence, and
outcome. Node statuses are `pending`, `ready`, `running`, `waiting_auth`,
`blocked`, `succeeded`, `failed`, `skipped`, `excluded`, or `quarantined`.

Run status is `pending`, `running`, `succeeded`, `waiting_auth`, `blocked`, or
`failed`; the initial outcome may be null until scheduling computes it.
Independent ready nodes continue while one branch waits for authentication, but
dependents never run before prerequisites are revalidated. Unscheduled work is
never described as background execution.

Each run persists `request_authority_sha256` and `contract_sha256`, plus a
separate immutable `<run>.contract.yaml`. The contract binds run/node
membership, requirements, dependency edges, necessity, fallbacks, request
constraints, metadata, resolution order, and immutable requested execution
inputs. Mutable runtime observations remain in the run state. A persisted
contract is not its own trust anchor: loading or scheduling requires the exact
live opaque CAPREQ and a process-local CAPREQ/run/expected-digest authority
reconstructed from the approved DAG. Editing both persisted files and
recomputing their digest still fails closed; a new process without reconstructed
approved authority cannot resume automatically. Install and smoke work go only
through the opaque brokers described above. Authentication verification is
retained in a process-local map and is re-bound to the selected candidate before
execution. Persisted run and contract reads/writes are limited to 4 MiB, 1,024
nodes, and 64 attempts per node. The derived capability registry is limited to
4 MiB and 4,096 entries. Reads use the same root-contained, regular, non-symlink,
identity-stable file primitive as exclusion and rejection state.

The scheduler accepts only an opaque `ProvisionStateStore` whose private
canonical-root binding exactly equals the CAPREQ repository root. Forged,
subclassed, or cross-repository stores are rejected, and the root is re-resolved
before every revocation read and persistence write. Scheduler calls bypass
caller-overridden instance methods and use the reviewed store implementation.

Necessity is `optional`, `preferred`, or `mandatory`. Optional failures may be
skipped. Preferred and mandatory fallbacks require immutable preapproval and
must preserve mandatory acceptance criteria, protected behavior, the permission
envelope, and mandatory evidence. Weaker evidence requires an explicit bound
waiver. A changed outcome, scope, or requirement invalidates affected approval
and requires contract revision/reapproval. Reconciliation outcomes are
`equivalent_fallback`, `approved_alternate_plan_branch`,
`contract_revision_required`, or `blocked`.

Fallback preapproval is an exact record with `approved_before_activation: true`,
an approval SHA-256, and the expected quality/cost difference. A separately
approved alternate plan is a `D-*` decision carrying `approved: true`,
`plan_sha256`, and `approval_sha256`; a bare `alternatePlanApproved` Boolean is
not authority. A weaker-evidence branch is considered only when waiver use is
permitted and the waiver binds both its decision digest and affected-evidence
digest. Missing or mismatched approval evidence blocks the branch.

Those serialized records are inputs, not approval authority. Goal install/auth
effects require an opaque token bound to the exact Goal CAPREQ, decision, plan,
permission, and approval digests; its synchronous reader must report the same
three current digests when the effect is authorized. Fallback consumption uses
a separate opaque token bound to request/run/node, the exact fallback-record
digest, plan/permission digests, and a synchronous current-digest reader.
Reconciliation alternate-plan and weaker-evidence tokens likewise bind the
exact request/run/node and record digest plus a synchronous current-digest
reader. Alternate-plan consumption rechecks current plan and approval digests;
weaker-evidence consumption rechecks the decision and affected-evidence
digests. Missing, malformed, asynchronous, or drifted readers fail closed for
all three approval-token families.

Persisted run, capability, rejection, and auth-state YAML is strict, redacted,
atomic, and private under `.cruise/internal/`. The originating public run may
mirror waiting capability IDs, but `_provision` never becomes `selected_skill`
or `current_route`.

Authority-bearing exclusion and rejected-capability reads require regular
non-symlink files, canonical repository containment, stable identity/size while
read, and fixed byte/entry bounds (256 KiB/4,096 exclusions and 1 MiB/4,096
rejections). Immutable auth jobs are capped at 1 MiB.

## 10. Completion and fail-closed behavior

Adapters receive structured, authority-bound inputs and return closed structured
records. Candidate content never supplies control flow, permissions, commands,
authentication endpoints, or approval. Adapter exceptions become redacted
failure records.

Fail closed when an opaque Origin, CAPREQ, need assessment, evaluation, broker
evidence, or effect authorization is absent or mismatched; when any closure byte
is missing or unhashed; when exclusion or immutable rejection applies; when raw
unapproved content would enter privileged context; when requested scope,
permission, command, identity, or digest changes; or when claimed host isolation
or continuation support exceeds observed broker evidence.

Truthful terminal results are no provisioning, verified native reuse, verified
activation/use, waiting for authentication, or blocked/failed with residual
risk. Completion never rests on stars, installer exit status, declarative
sandbox profiles, caller-supplied success Booleans, tmux existence, or an
unverified local evidence file.
