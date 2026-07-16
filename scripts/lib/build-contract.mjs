import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { milestoneContractDigest } from './milestone-contract-digest.mjs';
import {
  scanBuildIdentifiers,
  validateBuildIdRegistry,
  verifyBuildAutoApprovalOriginAuthority,
  verifyBuildOriginPairAuthority,
  verifyValidatedBuildIdHistoryAuthority,
} from './build-history.mjs';
import { validateOriginRecord } from './origin.mjs';
import { canonicalJson, parseYaml } from './yaml-state.mjs';

export const BUILD_MODES = Object.freeze(['bootstrap', 'milestone', 'discovery']);
export const BUILD_APPROVAL_LABELS = Object.freeze({
  bootstrap: 'Approve Foundation',
  milestone: 'Approve Milestone',
});

export const BUILD_ID_PREFIXES = Object.freeze([
  'PRJ',
  'M',
  'R',
  'AC',
  'D',
  'Q',
  'P',
  'RSK',
  'C',
  'QI',
]);

export const READINESS_CATEGORIES = Object.freeze([
  'outcome',
  'users_or_beneficiary',
  'non_goals',
  'requirements',
  'completion_evidence',
  'architecture_constraints',
  'data_and_security',
  'compatibility_and_migration',
  'operations_and_rollback',
  'phase_boundaries',
  'permissions',
  'problem_or_opportunity',
  'beneficiary',
  'meaningful_value',
  'scope_coherence',
  'plausible_implementation_path',
  'feasibility',
  'measurable_completion',
  'constraints_and_resources',
  'differentiation_or_necessity',
  'security_and_external_effects',
]);

export const CRITICAL_READINESS_CATEGORIES = Object.freeze([
  'outcome',
  'users_or_beneficiary',
  'non_goals',
  'requirements',
  'completion_evidence',
  'architecture_constraints',
  'data_and_security',
  'compatibility_and_migration',
  'operations_and_rollback',
  'phase_boundaries',
  'permissions',
  'problem_or_opportunity',
  'beneficiary',
  'meaningful_value',
  'scope_coherence',
  'plausible_implementation_path',
  'feasibility',
  'measurable_completion',
]);

export const VIABILITY_CRITICAL_GATES = Object.freeze([
  'beneficiary_identified',
  'meaningful_outcome',
  'coherent_scope',
  'plausible_implementation',
  'verifiable_completion',
  'constraints_compatible',
  'no_fatal_contradiction',
]);

export const VIABILITY_SUPPORTING_DIMENSIONS = Object.freeze([
  'expected_value',
  'feasibility_confidence',
  'implementation_clarity',
  'verification_clarity',
  'reversibility',
  'operational_sustainability',
]);

const REPOSITORY_EVIDENCE_SIGNALS = Object.freeze([
  'explicit_initialize_request',
  'explicit_milestone_request',
  'meaningful_product_source',
  'established_manifest',
  'meaningful_tests',
  'product_architecture',
  'stable_build_process',
  'public_interfaces_or_persisted_data',
  'prior_releases_or_deployed_behavior',
  'existing_project_artifacts',
  'minimal_scaffolding_only',
  'generated_scaffold_only',
  'ambiguous_teaching_or_experiment',
]);

export const QUEUE_ITEM_SKILLS = Object.freeze([
  'quick',
  'refine',
  'goal',
  'debug',
  'research',
]);

export const QUEUE_ITEM_STATUSES = Object.freeze([
  'draft',
  'queued',
  'ready',
  'running',
  'waiting_approval',
  'waiting_auth',
  'blocked',
  'completed',
  'failed',
  'skipped',
  'cancelled',
]);

export const BOOTSTRAP_LOCKED_FILES = Object.freeze([
  'ORIGIN.yaml',
  'PROJECT.md',
  'REQUIREMENTS.md',
  'ARCHITECTURE.md',
  'ROADMAP.md',
  'DECISIONS.md',
  'QUEUE.yaml',
]);

export const MILESTONE_LOCKED_FILES = Object.freeze([
  'ORIGIN.yaml',
  'MILESTONE.md',
  'REQUIREMENTS.md',
  'ROADMAP.md',
  'DECISIONS.md',
  'QUESTIONS.yaml',
  'AUTONOMY.yaml',
  'QUEUE.yaml',
]);

export const AUTONOMY_DECISION_POLICY = Object.freeze({
  preserve_approved_outcome: true,
  preserve_compatibility: true,
  prefer_repository_patterns: true,
  prefer_smallest_reversible_change: true,
  avoid_new_dependencies: true,
  avoid_permission_expansion: true,
  choose_recommended_option_when_evidence_is_decisive: true,
});

export const AUTONOMY_HARD_STOPS = Object.freeze([
  'milestone_outcome_change',
  'mandatory_requirement_change',
  'permission_expansion',
  'destructive_external_effect',
  'unresolved_authoritative_conflict',
  'unavailable_mandatory_evidence',
  'unsafe_rollback',
  'security_or_privacy_boundary_change',
  'authentication_required_without_approved_fallback',
  'unexpected_locked_artifact_drift',
  'unexplained_repository_baseline_drift',
]);

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_READINESS_EVIDENCE_SOURCE_BYTES = 4 * 1024 * 1024;
const PROJECT_ID = /^PRJ-\d{2,}$/u;
const MILESTONE_ID = /^M-\d{2,}$/u;
const PHASE_ID = /^P-\d{2,}$/u;
const QUESTION_ID = /^Q-\d{2,}$/u;
const QUEUE_ITEM_ID = /^QI-\d{2,}$/u;
const REACTIVE_FAILURE_ARTIFACT = /^cruise-failure-evidence:QI-\d{2,}:[a-f0-9]{64}$/u;
const QUEUE_ID = /^QUEUE-(?:PRJ|M)-[A-Z0-9-]+$/u;
const READINESS_STATUS = new Set(['clear', 'partial', 'missing', 'conflicting']);
const VIABILITY_GATE_STATUS = new Set(['pass', 'fail', 'research_needed']);
const READINESS_EVIDENCE_ID = /^E-\d{2,}$/u;
const READINESS_EVIDENCE_TYPES = new Set([
  'repository_observation',
  'origin_statement',
  'prior_cruise_artifact',
  'research_finding',
  'external_context',
]);
const READINESS_EVIDENCE_CERTAINTIES = new Set([
  'observed',
  'inferred',
  'speculative',
  'contradicted',
]);
const QUESTION_STATUS = new Set(['open', 'answered', 'assumed', 'deferred', 'superseded']);
const QUESTION_MATERIALITY = new Set([
  'project_blocking',
  'milestone_blocking',
  'phase_blocking',
  'nonblocking',
]);
const QUEUE_STATUS_SET = new Set(QUEUE_ITEM_STATUSES);
const QUEUE_SKILL_SET = new Set(QUEUE_ITEM_SKILLS);
const STRUCTURED_BUILD_SELECTIONS = new WeakSet();
const BUILD_READINESS_EVIDENCE_ATTESTATIONS = new WeakSet();
const BUILD_APPROVAL_READINESS_ATTESTATIONS = new WeakSet();
const VERIFIED_BUILD_APPROVALS = new WeakSet();
const VERIFIED_BUILD_ARTIFACT_SNAPSHOTS = new WeakMap();

const BUILD_SELECTION_OPTIONS = Object.freeze({
  bootstrap: Object.freeze({ id: 'approve_foundation', label: 'Approve Foundation' }),
  milestone: Object.freeze({ id: 'approve_milestone', label: 'Approve Milestone' }),
});

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

function recordDigest(value) {
  return sha256(canonicalJson(value));
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function stringArray(value, label, { allowEmpty = true, sort = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
  }
  const seen = new Set();
  const result = [];
  for (const entry of value) {
    const text = nonEmpty(entry, `${label} entry`);
    if (seen.has(text)) throw new Error(`${label} must not contain duplicates`);
    seen.add(text);
    result.push(text);
  }
  return sort ? result.sort((left, right) => left.localeCompare(right, 'en')) : result;
}

function nowIso(now = () => new Date()) {
  const supplied = typeof now === 'function' ? now() : now;
  const date = supplied instanceof Date ? supplied : new Date(supplied);
  if (Number.isNaN(date.getTime())) throw new TypeError('clock must return a valid date-time');
  return date.toISOString();
}

/**
 * Host-adapter-only issuer for an observed structured approval event.
 * Model text, typed/free-form input, and repository records are never valid event sources.
 */
export function attestStructuredBuildApprovalSelection(event) {
  if (!isPlainObject(event) || event.kind !== 'host_structured_choice_event') {
    throw new TypeError('Build approval requires an observed host structured-choice event');
  }
  if (event.source !== 'request_user_input' || event.input_kind !== 'option_selection') {
    throw new Error('typed or free-text input cannot authorize Build approval');
  }
  const expected = BUILD_SELECTION_OPTIONS[event.mode];
  if (!expected) throw new TypeError('Build approval event mode must be bootstrap or milestone');
  nonEmpty(event.interaction_id, 'interaction_id');
  assertDigest(event.review_digest, 'structured Build approval review_digest');
  if (event.option_id !== expected.id || event.selected_label !== expected.label) {
    throw new Error(`structured Build approval must select exact option ${expected.id}`);
  }
  if (!Array.isArray(event.offered_options)) {
    throw new TypeError('structured Build approval must include offered_options');
  }
  const offered = event.offered_options.find((option) =>
    isPlainObject(option) && option.id === expected.id && option.label === expected.label);
  if (!offered) throw new Error('exact Build approval option was not present in the host event');
  const selection = deepFreeze({
    kind: 'cruise_structured_build_approval_selection',
    mode: event.mode,
    source: event.source,
    interaction_id: event.interaction_id,
    option_id: event.option_id,
    selected_label: event.selected_label,
    review_digest: event.review_digest,
    selected_at: nowIso(event.selected_at),
  });
  STRUCTURED_BUILD_SELECTIONS.add(selection);
  return selection;
}

/**
 * Mint the same one-use, review-digest-bound selection authority when the
 * immutable triggering request explicitly opted into `--auto-approve`.
 * This approves only the Build planning contract represented by reviewDigest.
 */
export function attestOriginBoundBuildAutoApprovalSelection({
  buildOriginPairAuthority,
  mode,
  reviewDigest,
  selectedAt = () => new Date(),
} = {}) {
  assertDigest(reviewDigest, 'Build auto-approval reviewDigest');
  const originAuthority = verifyBuildAutoApprovalOriginAuthority(
    buildOriginPairAuthority,
    { mode },
  );
  const expected = BUILD_SELECTION_OPTIONS[mode];
  if (!expected) throw new TypeError('Build auto-approval mode must be bootstrap or milestone');
  const selection = deepFreeze({
    kind: 'cruise_structured_build_approval_selection',
    mode,
    source: 'origin_auto_approval',
    interaction_id: `origin-auto-approval:${originAuthority.prompt_sha256}`,
    option_id: expected.id,
    selected_label: expected.label,
    review_digest: reviewDigest,
    selected_at: nowIso(selectedAt),
  });
  STRUCTURED_BUILD_SELECTIONS.add(selection);
  return selection;
}

function requireBuildApprovalSelection(selection, mode) {
  if (!isPlainObject(selection) || !STRUCTURED_BUILD_SELECTIONS.has(selection)) {
    throw new Error('Build approval requires trusted opaque selection authority');
  }
  if (selection.mode !== mode || selection.selected_label !== approvalLabel(mode)) {
    throw new Error('Build approval selection does not match the requested mode');
  }
  return selection;
}

export function isVerifiedBuildApproval(value) {
  return isPlainObject(value) && VERIFIED_BUILD_APPROVALS.has(value);
}

function portable(path) {
  return path.split(sep).join('/');
}

function idNumber(id) {
  return Number(String(id).split('-').at(-1));
}

function assertId(value, expression, label) {
  if (typeof value !== 'string' || !expression.test(value)) {
    throw new TypeError(`${label} is invalid: ${value ?? '<missing>'}`);
  }
  return value;
}

/**
 * Allocate after the greatest identifier ever recorded for this namespace.
 * Callers must pass active and superseded history; gaps are intentionally never filled.
 */
export function allocateBuildId(prefix, identifiers = []) {
  if (!BUILD_ID_PREFIXES.includes(prefix)) {
    throw new TypeError(`unsupported Build identifier prefix ${prefix ?? '<missing>'}`);
  }
  const expression = new RegExp(`^${prefix}-\\d{2,}$`, 'u');
  const existing = stringArray(identifiers, `${prefix} identifier history`);
  let maximum = 0;
  for (const identifier of existing) {
    assertId(identifier, expression, `${prefix} identifier`);
    const numeric = Number(identifier.slice(prefix.length + 1));
    if (!Number.isSafeInteger(numeric)) {
      throw new TypeError(`${identifier} exceeds the safe identifier range`);
    }
    maximum = Math.max(maximum, numeric);
  }
  if (maximum === Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${prefix} identifier space is exhausted`);
  }
  return `${prefix}-${String(maximum + 1).padStart(2, '0')}`;
}

function normalizeIdList(values, expression, label) {
  const ids = stringArray(values ?? [], label, { sort: true });
  for (const id of ids) assertId(id, expression, label);
  return ids;
}

function readinessSupportKeyAllowed(value) {
  if (REPOSITORY_EVIDENCE_SIGNALS.some((signal) => value === `repository:${signal}`)) {
    return true;
  }
  if (READINESS_CATEGORIES.some((category) => value === `readiness:${category}`)) {
    return true;
  }
  if (VIABILITY_CRITICAL_GATES.some((gate) => value === `viability:${gate}`)) {
    return true;
  }
  if (VIABILITY_SUPPORTING_DIMENSIONS.some((field) => value === `viability:${field}`)) {
    return true;
  }
  return /^concept:C-\d{2,}$/u.test(value);
}

function readRepositoryEvidenceSource(repositoryRoot, sourceLocator, id) {
  const relativePath = safeQueueRelativePath(
    sourceLocator.slice('repository://'.length),
    `${id}.source_locator`,
  );
  const requestedRoot = resolve(nonEmpty(repositoryRoot, 'repositoryRoot'));
  const canonicalRoot = realpathSync(requestedRoot);
  if (canonicalRoot !== requestedRoot) {
    throw new Error(`${id} repository evidence requires the canonical repository root`);
  }
  const requested = resolve(canonicalRoot, relativePath);
  const beforePath = lstatSync(requested);
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) {
    throw new Error(`${id} repository evidence source must be a regular non-symlink file`);
  }
  const beforeCanonicalPath = realpathSync(requested);
  const rel = portable(relative(canonicalRoot, beforeCanonicalPath));
  if (
    beforeCanonicalPath !== requested ||
    !rel ||
    rel === '..' ||
    rel.startsWith('../')
  ) {
    throw new Error(`${id} repository evidence must not traverse symbolic links or escape the repository`);
  }

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = openSync(requested, fsConstants.O_RDONLY | noFollow);
    const beforeRead = fstatSync(descriptor);
    if (!beforeRead.isFile() || !sameFileIdentity(beforePath, beforeRead)) {
      throw new Error(`${id} repository evidence source changed while it was opened`);
    }
    if (beforeRead.size > MAX_READINESS_EVIDENCE_SOURCE_BYTES) {
      throw new Error(
        `${id} repository evidence source exceeds ${MAX_READINESS_EVIDENCE_SOURCE_BYTES} bytes`,
      );
    }
    const bytes = readFileSync(descriptor);
    const afterRead = fstatSync(descriptor);
    const afterPath = lstatSync(requested);
    const afterCanonicalPath = realpathSync(requested);
    if (
      !sameFileIdentity(beforeRead, afterRead) ||
      !sameFileIdentity(afterRead, afterPath) ||
      afterPath.isSymbolicLink() ||
      afterCanonicalPath !== requested ||
      bytes.length !== afterRead.size
    ) {
      throw new Error(`${id} repository evidence source changed while its bytes were read`);
    }
    return { path: rel, sha256: sha256(bytes) };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Bind Build readiness citations to stable E-XX records and immutable repository/Origin
 * identities. Approval consumes this opaque value; copied evidence mappings are inert.
 */
export function attestBuildReadinessEvidence({
  repositoryRoot,
  repositoryBaselineDigest,
  projectOriginSha256,
  milestoneOriginSha256,
  evidence,
} = {}) {
  const bindings = {
    repository_root: nonEmpty(repositoryRoot, 'repositoryRoot'),
    repository_baseline_digest: assertDigest(
      repositoryBaselineDigest,
      'repositoryBaselineDigest',
    ),
    project_origin_sha256: assertDigest(projectOriginSha256, 'projectOriginSha256'),
    milestone_origin_sha256: assertDigest(milestoneOriginSha256, 'milestoneOriginSha256'),
  };
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new TypeError('Build readiness evidence requires at least one E-XX record');
  }
  const ids = new Set();
  let priorNumber = 0;
  const normalized = evidence.map((item, index) => {
    assertExactObjectKeys(item, [
      'id',
      'type',
      'source_locator',
      'source_sha256',
      'claim',
      'certainty',
      'supports',
    ], `readiness evidence[${index}]`);
    const id = assertId(item.id, READINESS_EVIDENCE_ID, `readiness evidence[${index}].id`);
    const number = idNumber(id);
    if (ids.has(id) || number <= priorNumber) {
      throw new Error('Build readiness evidence IDs must be unique and monotonically increasing');
    }
    ids.add(id);
    priorNumber = number;
    if (!READINESS_EVIDENCE_TYPES.has(item.type)) {
      throw new TypeError(`${id}.type is not a supported Build readiness evidence type`);
    }
    if (!READINESS_EVIDENCE_CERTAINTIES.has(item.certainty)) {
      throw new TypeError(`${id}.certainty is invalid`);
    }
    const sourceLocator = nonEmpty(item.source_locator, `${id}.source_locator`);
    const sourceSha256 = assertDigest(item.source_sha256, `${id}.source_sha256`);
    if (item.type === 'origin_statement') {
      if (!['origin://project', 'origin://milestone'].includes(sourceLocator)) {
        throw new Error(`${id} origin statement must identify the project or milestone Origin`);
      }
      const expected = sourceLocator === 'origin://project'
        ? bindings.project_origin_sha256
        : bindings.milestone_origin_sha256;
      if (sourceSha256 !== expected) {
        throw new Error(`${id} origin statement source digest is stale or belongs elsewhere`);
      }
    } else if (sourceLocator === 'repository://baseline') {
      if (item.type !== 'repository_observation') {
        throw new Error(`${id} repository baseline is valid only for a repository observation`);
      }
      if (sourceSha256 !== bindings.repository_baseline_digest) {
        throw new Error(`${id} repository baseline evidence digest is stale`);
      }
    } else if (sourceLocator.startsWith('repository://')) {
      const observed = readRepositoryEvidenceSource(bindings.repository_root, sourceLocator, id);
      if (sourceSha256 !== observed.sha256) {
        throw new Error(
          `${id} repository evidence digest does not match current bytes at ${observed.path}`,
        );
      }
    } else if (item.type === 'repository_observation') {
      throw new Error(`${id} repository observation requires a repository source locator`);
    } else {
      throw new Error(
        `${id} ${item.type} requires opaque non-repository provenance; no trusted broker is available`,
      );
    }
    const supports = stringArray(item.supports, `${id}.supports`, { allowEmpty: false });
    for (const support of supports) {
      if (!readinessSupportKeyAllowed(support)) {
        throw new Error(`${id} cites unsupported readiness target ${support}`);
      }
    }
    return {
      id,
      type: item.type,
      source_locator: sourceLocator,
      source_sha256: sourceSha256,
      claim: nonEmpty(item.claim, `${id}.claim`),
      certainty: item.certainty,
      supports,
    };
  });
  const payload = {
    schema_version: 1,
    kind: 'cruise_build_readiness_evidence',
    bindings,
    evidence: normalized,
  };
  const attestation = deepFreeze({
    ...payload,
    evidence_digest: recordDigest(payload),
  });
  BUILD_READINESS_EVIDENCE_ATTESTATIONS.add(attestation);
  return attestation;
}

function repositorySignalSelected(value) {
  return value === true || (Array.isArray(value) && value.length > 0);
}

/**
 * Select bootstrap or milestone only from substantive repository signals.
 * Counts and lines of code are intentionally not accepted as evidence fields.
 */
export function selectBuildModeFromEvidence(input = {}) {
  if (!isPlainObject(input)) throw new TypeError('repository evidence must be an object');
  for (const key of REPOSITORY_EVIDENCE_SIGNALS) {
    if (
      input[key] !== undefined &&
      typeof input[key] !== 'boolean' &&
      !Array.isArray(input[key])
    ) {
      throw new TypeError(`repository evidence ${key} must be boolean or E-XX citations`);
    }
    if (Array.isArray(input[key])) {
      normalizeIdList(input[key], READINESS_EVIDENCE_ID, `repository evidence ${key}`);
    }
  }
  const evidence = REPOSITORY_EVIDENCE_SIGNALS.filter((key) =>
    repositorySignalSelected(input[key]));
  const contradictoryExplicitRequest =
    repositorySignalSelected(input.explicit_initialize_request) &&
    repositorySignalSelected(input.explicit_milestone_request);
  if (
    contradictoryExplicitRequest ||
    repositorySignalSelected(input.ambiguous_teaching_or_experiment)
  ) {
    return deepFreeze({
      mode_candidate: null,
      requires_mode_question: true,
      evidence,
      reason: contradictoryExplicitRequest
        ? 'explicit bootstrap and milestone requests conflict'
        : 'repository purpose is genuinely ambiguous',
    });
  }
  if (repositorySignalSelected(input.explicit_milestone_request)) {
    return deepFreeze({
      mode_candidate: 'milestone',
      requires_mode_question: false,
      evidence,
      reason: 'the user explicitly requested the next milestone',
    });
  }
  if (repositorySignalSelected(input.explicit_initialize_request)) {
    return deepFreeze({
      mode_candidate: 'bootstrap',
      requires_mode_question: false,
      evidence,
      reason: 'the user explicitly requested project initialization',
    });
  }

  const establishedSignals = [
    'meaningful_product_source',
    'established_manifest',
    'meaningful_tests',
    'product_architecture',
    'stable_build_process',
    'public_interfaces_or_persisted_data',
    'prior_releases_or_deployed_behavior',
    'existing_project_artifacts',
  ].filter((key) => repositorySignalSelected(input[key]));
  const corroboratedManifest =
    repositorySignalSelected(input.established_manifest) &&
    [
      'meaningful_tests',
      'product_architecture',
      'stable_build_process',
      'public_interfaces_or_persisted_data',
      'prior_releases_or_deployed_behavior',
    ].some((key) => repositorySignalSelected(input[key]));
  const corroboratedProductBoundary =
    repositorySignalSelected(input.public_interfaces_or_persisted_data) &&
    [
      'product_architecture',
      'stable_build_process',
      'prior_releases_or_deployed_behavior',
    ].some((key) => repositorySignalSelected(input[key]));
  const established =
    repositorySignalSelected(input.existing_project_artifacts) ||
    repositorySignalSelected(input.prior_releases_or_deployed_behavior) ||
    (repositorySignalSelected(input.meaningful_product_source) && establishedSignals.length >= 2) ||
    corroboratedManifest ||
    corroboratedProductBoundary;
  if (established) {
    return deepFreeze({
      mode_candidate: 'milestone',
      requires_mode_question: false,
      evidence,
      reason: `established product evidence: ${establishedSignals.join(', ')}`,
    });
  }
  if (
    repositorySignalSelected(input.minimal_scaffolding_only) ||
    repositorySignalSelected(input.generated_scaffold_only) ||
    (!repositorySignalSelected(input.meaningful_product_source) && establishedSignals.length === 0)
  ) {
    return deepFreeze({
      mode_candidate: 'bootstrap',
      requires_mode_question: false,
      evidence,
      reason: 'no established product foundation is evidenced',
    });
  }
  return deepFreeze({
    mode_candidate: null,
    requires_mode_question: true,
    evidence,
    reason: 'repository evidence does not responsibly distinguish bootstrap from milestone',
  });
}

export function normalizeBuildReadiness(input) {
  if (!isPlainObject(input)) throw new TypeError('Build readiness must be an object');
  if (!['bootstrap', 'milestone'].includes(input.mode_candidate)) {
    throw new TypeError('readiness.mode_candidate must be bootstrap or milestone');
  }
  const result = { mode_candidate: input.mode_candidate };
  for (const category of READINESS_CATEGORIES) {
    const entry = input[category];
    if (!isPlainObject(entry) || !READINESS_STATUS.has(entry.status)) {
      throw new TypeError(`${category}.status must be clear, partial, missing, or conflicting`);
    }
    result[category] = {
      status: entry.status,
      evidence: stringArray(entry.evidence ?? [], `${category}.evidence`),
    };
  }
  result.fatal_contradictions = stringArray(
    input.fatal_contradictions ?? [],
    'fatal_contradictions',
  );
  result.research_blockers = stringArray(input.research_blockers ?? [], 'research_blockers');
  result.user_decisions_required = stringArray(
    input.user_decisions_required ?? [],
    'user_decisions_required',
  );
  return deepFreeze(result);
}

/** Missing/conflicting critical facts trigger discovery; unrelated supporting gaps do not. */
export function evaluateBuildReadiness(input, {
  criticalCategories = CRITICAL_READINESS_CATEGORIES,
} = {}) {
  const readiness = normalizeBuildReadiness(input);
  const critical = stringArray(criticalCategories, 'criticalCategories');
  for (const category of critical) {
    if (!READINESS_CATEGORIES.includes(category)) {
      throw new TypeError(`unknown critical readiness category ${category}`);
    }
  }
  const blockingCategories = critical.filter((category) =>
    ['partial', 'missing', 'conflicting'].includes(readiness[category].status));
  for (const category of READINESS_CATEGORIES) {
    if (readiness[category].status === 'conflicting' && !blockingCategories.includes(category)) {
      blockingCategories.push(category);
    }
  }
  const reasons = [
    ...blockingCategories.map((category) => `critical:${category}:${readiness[category].status}`),
    ...readiness.fatal_contradictions.map((item) => `fatal_contradiction:${item}`),
    ...readiness.research_blockers.map((item) => `research_blocker:${item}`),
    ...readiness.user_decisions_required.map((item) => `user_decision:${item}`),
  ];
  return deepFreeze({
    mode_candidate: readiness.mode_candidate,
    discovery_required: reasons.length > 0,
    blocking_categories: blockingCategories,
    reasons,
    readiness,
  });
}

export function decideBuildMode({ repositoryEvidence, readiness } = {}) {
  const repository = selectBuildModeFromEvidence(repositoryEvidence);
  if (repository.requires_mode_question) {
    return deepFreeze({
      mode: null,
      disposition: 'mode_question_required',
      repository,
      readiness: null,
    });
  }
  const assessed = evaluateBuildReadiness({ ...readiness, mode_candidate: repository.mode_candidate });
  return deepFreeze({
    mode: assessed.discovery_required ? 'discovery' : repository.mode_candidate,
    disposition: assessed.discovery_required ? 'enter_discovery' : 'draft_build_contract',
    repository,
    readiness: assessed,
  });
}

export function evaluateConceptViability(input, {
  consequence = 'normal',
  deferred = false,
} = {}) {
  if (!isPlainObject(input)) throw new TypeError('viability must be an object');
  assertId(input.concept_id, /^C-\d{2,}$/u, 'concept_id');
  if (!isPlainObject(input.critical_gates)) throw new TypeError('critical_gates must be an object');
  const gates = {};
  for (const gate of VIABILITY_CRITICAL_GATES) {
    const status = input.critical_gates[gate];
    if (!VIABILITY_GATE_STATUS.has(status)) {
      throw new TypeError(`${gate} must be pass, fail, or research_needed`);
    }
    gates[gate] = status;
  }
  if (!isPlainObject(input.supporting_dimensions)) {
    throw new TypeError('supporting_dimensions must be an object');
  }
  const dimensions = {};
  for (const field of VIABILITY_SUPPORTING_DIMENSIONS.filter(
    (candidate) => candidate !== 'feasibility_confidence',
  )) {
    const value = input.supporting_dimensions[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new TypeError(`${field} must be a finite number from 0 through 100`);
    }
    dimensions[field] = value;
  }
  const confidence = input.supporting_dimensions.feasibility_confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new TypeError('feasibility_confidence must be a number from 0 through 1');
  }
  dimensions.feasibility_confidence = confidence;
  const unresolved = input.unresolved ?? {};
  const normalizedUnresolved = {
    user_decisions: stringArray(unresolved.user_decisions ?? [], 'unresolved.user_decisions'),
    research_questions: stringArray(unresolved.research_questions ?? [], 'unresolved.research_questions'),
    phase_local_questions: stringArray(unresolved.phase_local_questions ?? [], 'unresolved.phase_local_questions'),
  };

  let outcome;
  const failed = Object.entries(gates).filter(([, status]) => status === 'fail').map(([gate]) => gate);
  const researchNeeded = Object.entries(gates)
    .filter(([, status]) => status === 'research_needed')
    .map(([gate]) => gate);
  const threshold = consequence === 'high' ? 0.9 : consequence === 'normal' ? 0.75 : null;
  if (threshold === null) throw new TypeError('consequence must be normal or high');
  if (deferred) outcome = 'deferred';
  else if (failed.length > 0) outcome = 'not_currently_viable';
  else if (normalizedUnresolved.user_decisions.length > 0) outcome = 'user_decision_required';
  else if (
    researchNeeded.length > 0 ||
    normalizedUnresolved.research_questions.length > 0 ||
    confidence < threshold
  ) outcome = 'research_required';
  else outcome = 'ready_for_build';
  return deepFreeze({
    concept_id: input.concept_id,
    critical_gates: gates,
    supporting_dimensions: dimensions,
    unresolved: normalizedUnresolved,
    failed_gates: failed,
    research_needed_gates: researchNeeded,
    required_feasibility_confidence: threshold,
    outcome,
  });
}

/**
 * Close the mechanical readiness/viability gate that must precede a Build
 * review. This is deliberately opaque so a serialized "ready" claim cannot
 * be supplied directly to approval capture.
 */
export function attestBuildApprovalReadiness({
  mode,
  repositoryRoot,
  repositoryBaselineDigest,
  projectId,
  milestoneId,
  projectOriginSha256,
  milestoneOriginSha256,
  repositoryEvidence,
  readiness,
  viability,
  evidenceAuthority,
  consequence = 'normal',
} = {}) {
  if (!['bootstrap', 'milestone'].includes(mode)) {
    throw new TypeError('Build approval readiness mode must be bootstrap or milestone');
  }
  const bindings = {
    repository_root: nonEmpty(repositoryRoot, 'repositoryRoot'),
    repository_baseline_digest: assertDigest(
      repositoryBaselineDigest,
      'repositoryBaselineDigest',
    ),
    project_id: assertId(projectId, PROJECT_ID, 'projectId'),
    milestone_id: assertId(milestoneId, MILESTONE_ID, 'milestoneId'),
    project_origin_sha256: assertDigest(projectOriginSha256, 'projectOriginSha256'),
    milestone_origin_sha256: assertDigest(
      milestoneOriginSha256,
      'milestoneOriginSha256',
    ),
  };
  if (
    !isPlainObject(evidenceAuthority) ||
    !BUILD_READINESS_EVIDENCE_ATTESTATIONS.has(evidenceAuthority) ||
    evidenceAuthority.bindings.repository_root !== bindings.repository_root ||
    evidenceAuthority.bindings.repository_baseline_digest !==
      bindings.repository_baseline_digest ||
    evidenceAuthority.bindings.project_origin_sha256 !== bindings.project_origin_sha256 ||
    evidenceAuthority.bindings.milestone_origin_sha256 !== bindings.milestone_origin_sha256
  ) {
    throw new Error(
      'Build approval readiness requires opaque repository/Origin-bound E-XX evidence',
    );
  }
  const evidenceById = new Map(
    evidenceAuthority.evidence.map((item) => [item.id, item]),
  );
  const assertCitations = (citations, support, label) => {
    const ids = normalizeIdList(citations, READINESS_EVIDENCE_ID, label);
    if (ids.length === 0) throw new Error(`${label} requires at least one E-XX citation`);
    for (const id of ids) {
      const item = evidenceById.get(id);
      if (
        !item ||
        !item.supports.includes(support) ||
        !['observed', 'inferred'].includes(item.certainty)
      ) {
        throw new Error(`${label} citation ${id} does not support ${support}`);
      }
    }
    return ids;
  };
  if (!isPlainObject(repositoryEvidence)) {
    throw new TypeError('repositoryEvidence must map signals to E-XX citations');
  }
  for (const signal of REPOSITORY_EVIDENCE_SIGNALS) {
    if (repositoryEvidence[signal] === undefined) continue;
    if (!Array.isArray(repositoryEvidence[signal])) {
      throw new Error(
        `approval repository evidence ${signal} must use E-XX citations, not booleans`,
      );
    }
    if (repositoryEvidence[signal].length > 0) {
      assertCitations(
        repositoryEvidence[signal],
        `repository:${signal}`,
        `repository evidence ${signal}`,
      );
    }
  }
  const repository = selectBuildModeFromEvidence(repositoryEvidence);
  if (repository.requires_mode_question || repository.mode_candidate !== mode) {
    throw new Error('Build approval mode is not closed by repository evidence');
  }
  if (repository.evidence.length === 0) {
    throw new Error('Build approval mode requires recorded repository evidence');
  }
  const assessed = evaluateBuildReadiness({ ...readiness, mode_candidate: mode });
  if (assessed.discovery_required) {
    throw new Error(
      `Build approval readiness remains open: ${assessed.reasons.join(', ')}`,
    );
  }
  for (const category of READINESS_CATEGORIES) {
    const entry = assessed.readiness[category];
    if (entry.status !== 'missing' && entry.evidence.length === 0) {
      throw new Error(`${category} readiness must cite observed evidence`);
    }
    if (entry.status !== 'missing') {
      assertCitations(
        entry.evidence,
        `readiness:${category}`,
        `${category} readiness`,
      );
    }
  }
  const viable = evaluateConceptViability(viability, { consequence });
  if (viable.outcome !== 'ready_for_build') {
    throw new Error(`Build viability is ${viable.outcome}, not ready_for_build`);
  }
  for (const gate of VIABILITY_CRITICAL_GATES) {
    const supported = evidenceAuthority.evidence.some((item) =>
      ['observed', 'inferred'].includes(item.certainty) &&
      item.supports.includes(`viability:${gate}`) &&
      item.supports.includes(`concept:${viable.concept_id}`));
    if (!supported) {
      throw new Error(
        `${gate} viability pass lacks repository/Origin-bound evidence for ${viable.concept_id}`,
      );
    }
  }
  for (const dimension of VIABILITY_SUPPORTING_DIMENSIONS) {
    const supported = evidenceAuthority.evidence.some((item) =>
      ['observed', 'inferred'].includes(item.certainty) &&
      item.supports.includes(`viability:${dimension}`) &&
      item.supports.includes(`concept:${viable.concept_id}`));
    if (!supported) {
      throw new Error(
        `${dimension} viability score lacks repository/Origin-bound evidence for ${viable.concept_id}`,
      );
    }
  }
  const payload = {
    schema_version: 1,
    kind: 'cruise_build_approval_readiness',
    mode,
    bindings,
    repository,
    readiness: assessed,
    viability: viable,
    evidence: {
      evidence_digest: evidenceAuthority.evidence_digest,
      evidence_ids: [...evidenceById.keys()],
    },
  };
  const attestation = deepFreeze({
    ...payload,
    readiness_digest: recordDigest(payload),
  });
  BUILD_APPROVAL_READINESS_ATTESTATIONS.add(attestation);
  return attestation;
}

function requireBuildApprovalReadiness(attestation, mode) {
  if (
    !isPlainObject(attestation) ||
    !BUILD_APPROVAL_READINESS_ATTESTATIONS.has(attestation) ||
    attestation.mode !== mode
  ) {
    throw new Error('Build approval requires opaque mode/readiness/viability authority');
  }
  const { readiness_digest: ignored, ...payload } = attestation;
  void ignored;
  if (recordDigest(payload) !== attestation.readiness_digest) {
    throw new Error('Build approval readiness authority is internally inconsistent');
  }
  return attestation;
}

async function assertFreshProductRepositoryBaseline(root, expectedDigest) {
  assertDigest(expectedDigest, 'repositoryBaselineDigest');
  const { captureRepositoryBaseline } = await import('./goal-contract.mjs');
  const observed = captureRepositoryBaseline(root);
  if (observed.sha256 !== expectedDigest) {
    throw new Error('target repository product baseline differs from the deterministic probe');
  }
  return observed;
}

function assertBuildApprovalReadinessBindings(
  attestation,
  material,
  repositoryBaselineDigest,
) {
  const bindings = attestation.bindings;
  const projectOrigin = material.draft.contract_artifacts.find(
    ({ path }) => path === `${material.draft.project_path}/ORIGIN.yaml`,
  );
  const milestoneOrigin = material.draft.contract_artifacts.find(
    ({ path }) => path === `${material.draft.milestone_path}/ORIGIN.yaml`,
  );
  if (
    bindings?.repository_root !== material.draft.canonical_root ||
    bindings.repository_baseline_digest !== repositoryBaselineDigest ||
    bindings.project_id !== material.draft.project_id ||
    bindings.milestone_id !== material.draft.milestone_id ||
    bindings.project_origin_sha256 !== projectOrigin?.sha256 ||
    bindings.milestone_origin_sha256 !== milestoneOrigin?.sha256
  ) {
    throw new Error(
      'Build readiness/viability authority belongs to another repository, Origin, or target',
    );
  }
}

function normalizeQuestion(question) {
  if (!isPlainObject(question)) throw new TypeError('question must be an object');
  assertId(question.id, QUESTION_ID, 'question id');
  if (!QUESTION_STATUS.has(question.status)) throw new TypeError(`${question.id} has invalid status`);
  if (!QUESTION_MATERIALITY.has(question.materiality)) {
    throw new TypeError(`${question.id} has invalid materiality`);
  }
  const options = stringArray(question.options ?? [], `${question.id}.options`);
  if (![0, 2, 3].includes(options.length)) {
    throw new Error(`${question.id}.options must contain zero, two, or three concrete options`);
  }
  return {
    id: question.id,
    status: question.status,
    materiality: question.materiality,
    category: nonEmpty(question.category, `${question.id}.category`),
    question: nonEmpty(question.question, `${question.id}.question`),
    evidence: stringArray(question.evidence ?? [], `${question.id}.evidence`),
    recommendation: nonEmpty(question.recommendation, `${question.id}.recommendation`),
    options,
    answer: question.answer == null ? null : nonEmpty(question.answer, `${question.id}.answer`),
    answer_source: question.answer_source == null
      ? null
      : nonEmpty(question.answer_source, `${question.id}.answer_source`),
    affects: stringArray(question.affects ?? [], `${question.id}.affects`),
    asked_at: question.asked_at ?? null,
    answered_at: question.answered_at ?? null,
    reopening_trigger: question.reopening_trigger == null
      ? null
      : nonEmpty(question.reopening_trigger, `${question.id}.reopening_trigger`),
  };
}

export function createQuestionLedger({ questions = [], events = [] } = {}) {
  if (!Array.isArray(questions) || !Array.isArray(events)) {
    throw new TypeError('question ledger questions and events must be arrays');
  }
  const normalized = questions.map(normalizeQuestion);
  const ids = new Set();
  for (const question of normalized) {
    if (ids.has(question.id)) throw new Error(`duplicate question id ${question.id}`);
    ids.add(question.id);
  }
  const activeQuestions = normalized.filter((question) => question.status === 'open');
  if (activeQuestions.length > 1) {
    throw new Error(
      `only one material question may be open at a time: ${activeQuestions.map(({ id }) => id).join(', ')}`,
    );
  }
  for (const [index, event] of events.entries()) {
    if (!isPlainObject(event) || event.sequence !== index + 1 || !ids.has(event.question_id)) {
      throw new TypeError('question ledger event sequence or question reference is invalid');
    }
  }
  return deepFreeze({ schema_version: 1, questions: normalized, events: clone(events) });
}

function questionTextKey(value) {
  return String(value).normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function appendQuestionEvent(ledger, questionId, type, at, detail) {
  ledger.events.push({
    sequence: ledger.events.length + 1,
    question_id: questionId,
    type,
    at,
    detail,
  });
}

export function addBuildQuestion(ledgerInput, input, { now = () => new Date() } = {}) {
  const ledger = clone(createQuestionLedger(ledgerInput));
  if (!isPlainObject(input)) throw new TypeError('question input must be an object');
  if (
    input.answerable_from_repository !== undefined &&
    typeof input.answerable_from_repository !== 'boolean'
  ) {
    throw new TypeError('answerable_from_repository must be boolean');
  }
  if (input.answerable_from_repository === true) {
    throw new Error('question is answerable from repository inspection and must not be asked');
  }
  const text = nonEmpty(input?.question, 'question');
  const key = questionTextKey(text);
  if (ledger.questions.some((question) => questionTextKey(question.question) === key)) {
    throw new Error('the same material question already exists; use its reopening trigger');
  }
  const active = ledger.questions.find((question) => question.status === 'open');
  if (active) {
    throw new Error(`only one material question may be open at a time; resolve ${active.id} first`);
  }
  const at = nowIso(now);
  const question = normalizeQuestion({
    id: allocateBuildId('Q', ledger.questions.map(({ id }) => id)),
    status: 'open',
    materiality: input.materiality,
    category: input.category,
    question: text,
    evidence: input.evidence ?? [],
    recommendation: input.recommendation,
    options: input.options ?? [],
    answer: null,
    answer_source: null,
    affects: input.affects ?? [],
    asked_at: at,
    answered_at: null,
    reopening_trigger: input.reopening_trigger ?? null,
  });
  ledger.questions.push(question);
  appendQuestionEvent(ledger, question.id, 'asked', at, question.category);
  return createQuestionLedger(ledger);
}

export function answerBuildQuestion(
  ledgerInput,
  { id, answer, answerSource, status = 'answered' } = {},
  { now = () => new Date() } = {},
) {
  const ledger = clone(createQuestionLedger(ledgerInput));
  const question = ledger.questions.find((entry) => entry.id === id);
  if (!question) throw new Error(`unknown question ${id}`);
  if (question.status !== 'open') throw new Error(`${id} is not open`);
  if (!['answered', 'assumed', 'deferred'].includes(status)) {
    throw new TypeError('answered question status must be answered, assumed, or deferred');
  }
  const at = nowIso(now);
  question.status = status;
  question.answer = nonEmpty(answer, 'answer');
  question.answer_source = nonEmpty(answerSource, 'answerSource');
  question.answered_at = at;
  appendQuestionEvent(ledger, id, status, at, question.answer_source);
  return createQuestionLedger(ledger);
}

export function reopenBuildQuestion(
  ledgerInput,
  { id, trigger, evidence = [] } = {},
  { now = () => new Date() } = {},
) {
  const ledger = clone(createQuestionLedger(ledgerInput));
  const question = ledger.questions.find((entry) => entry.id === id);
  if (!question) throw new Error(`unknown question ${id}`);
  if (question.status === 'open') throw new Error(`${id} is already open`);
  if (question.reopening_trigger == null || trigger !== question.reopening_trigger) {
    throw new Error(`${id} reopening trigger did not occur`);
  }
  const active = ledger.questions.find((entry) => entry.status === 'open' && entry.id !== id);
  if (active) {
    throw new Error(`only one material question may be open at a time; resolve ${active.id} first`);
  }
  const at = nowIso(now);
  const priorAnswer = question.answer;
  question.status = 'open';
  question.answer = null;
  question.answer_source = null;
  question.answered_at = null;
  question.evidence = [...new Set([...question.evidence, ...stringArray(evidence, 'evidence')])];
  appendQuestionEvent(ledger, id, 'reopened', at, priorAnswer ?? trigger);
  return createQuestionLedger(ledger);
}

/** Return at most one highest-impact open question. */
export function nextBuildQuestion(ledgerInput) {
  const ledger = createQuestionLedger(ledgerInput);
  const priority = {
    project_blocking: 0,
    milestone_blocking: 1,
    phase_blocking: 2,
    nonblocking: 3,
  };
  const open = ledger.questions
    .filter((question) => question.status === 'open')
    .sort((left, right) =>
      priority[left.materiality] - priority[right.materiality] || idNumber(left.id) - idNumber(right.id));
  return open.length === 0 ? null : deepFreeze(clone(open[0]));
}

const GENERIC_TASK_CREATION_LEAD = /^(?:write|add|create|implement|build|update|run|expand|author|generate)\b/iu;
const GENERIC_TASK_MAINTENANCE_LEAD = /^(?:refactor(?:ing)?|clean\s*up|cleanup|format|lint)\b/iu;
const GENERIC_TASK_ARTIFACT = /\b(?:tests?|test\s+suites?|models?|schemas?|fixtures?|docs?|documentation|types?|interfaces?|migrations?|pipelines?)\b/iu;
const GENERIC_TASK_ARTIFACT_LEAD = /^(?:tests?|test\s+suites?|models?|schemas?|fixtures?|docs?|documentation|types?|interfaces?|migrations?|pipelines?|refactoring|cleanup)\b/iu;

const STRATEGIC_OUTCOME_PATTERNS = [
  /(?:^|[.!?;:]\s*)(?:deliver|ship|release|provide|establish|introduce|make\s+available)\b(?:(?!\b(?:tests?|test\s+suites?|models?|schemas?|fixtures?|docs?|documentation|types?|interfaces?|migrations?|pipelines?)\b)[^.!?;:\n]){0,160}\b(?:independently useful|usable|deployable|releasable|production-ready|validated|decision-complete|safely deployable)\b/iu,
  /\b(?:outcome|transition|capabilit(?:y|ies)|workflow|service|system|feature|experience|release|foundation)\s+(?:is|are|becomes?|remain(?:s)?)\s+(?:independently useful|usable|deployable|releasable|production-ready|validated|decision-complete|safely deployable)\b/iu,
  /\b(?:users?|customers?|operators?|beneficiar(?:y|ies)|administrators?|admins?|maintainers?|developers?|teams?|owners?)\s+(?:(?:can|may)\s+[a-z][a-z-]*|are\s+able\s+to\s+[a-z][a-z-]*|(?:receive|receives|gain|gains|avoid|avoids)\s+[^\s.!?;:]+)\b/iu,
  /\b(?:enables?|allows?|lets?)\s+(?:the\s+)?(?:users?|customers?|operators?|beneficiar(?:y|ies)|administrators?|admins?|maintainers?|developers?|teams?|owners?)\s+to\s+[a-z][a-z-]*\b/iu,
  /(?:^|[.!?;:]\s*)(?:deliver|ship|release|provide|establish|introduce)\b(?:(?!\b(?:tests?|test\s+suites?|models?|schemas?|fixtures?|docs?|documentation|types?|interfaces?|migrations?|pipelines?)\b)[^.!?;:\n]){0,160}\b(?:capabilit(?:y|ies)|workflow|service|system|feature|experience)\b/iu,
];

function isGenericTaskLedPhase(value) {
  return GENERIC_TASK_MAINTENANCE_LEAD.test(value) ||
    GENERIC_TASK_ARTIFACT_LEAD.test(value) ||
    (GENERIC_TASK_CREATION_LEAD.test(value) && GENERIC_TASK_ARTIFACT.test(value));
}

function statesStrategicTransitionValue(outcome) {
  return STRATEGIC_OUTCOME_PATTERNS.some((pattern) => pattern.test(outcome));
}

function assertStrategicPhaseValue(id, name, outcome) {
  const normalizedName = name.trim().replace(/\s+/gu, ' ');
  const normalizedOutcome = outcome.trim().replace(/\s+/gu, ' ');
  const taskOnly =
    isGenericTaskLedPhase(normalizedName) ||
    isGenericTaskLedPhase(normalizedOutcome);
  if (!statesStrategicTransitionValue(normalizedOutcome)) {
    throw new Error(
      `${id} is a generic task-only phase${taskOnly ? '' : ' outcome'}; ` +
      'its outcome must state independent transition value',
    );
  }
}

function normalizePhase(input) {
  const phase = isPlainObject(input?.phase) ? input.phase : input;
  if (!isPlainObject(phase)) throw new TypeError('phase must be an object');
  const id = assertId(phase.id, PHASE_ID, 'phase id');
  if (phase.strategically_complete !== true) {
    throw new Error(`${id} must be strategically complete`);
  }
  if (phase.mandatory !== undefined && typeof phase.mandatory !== 'boolean') {
    throw new TypeError(`${id}.mandatory must be boolean`);
  }
  const name = nonEmpty(phase.name, `${id}.name`);
  const outcome = nonEmpty(phase.outcome, `${id}.outcome`);
  assertStrategicPhaseValue(id, name, outcome);
  return {
    id,
    name,
    outcome,
    strategically_complete: true,
    mandatory: phase.mandatory !== false,
    depends_on: normalizeIdList(phase.depends_on ?? [], PHASE_ID, `${id}.depends_on`),
    requirements: normalizeIdList(phase.requirements ?? [], /^R-\d{2,}$/u, `${id}.requirements`),
    acceptance_criteria: normalizeIdList(
      phase.acceptance_criteria ?? [],
      /^AC-\d{2,}$/u,
      `${id}.acceptance_criteria`,
    ),
    protected_behavior: stringArray(phase.protected_behavior ?? [], `${id}.protected_behavior`),
    expected_artifacts: stringArray(
      phase.expected_artifacts ?? [],
      `${id}.expected_artifacts`,
      { allowEmpty: false },
    ),
    verification: stringArray(phase.verification ?? [], `${id}.verification`, { allowEmpty: false }),
    rollback_boundary: nonEmpty(phase.rollback_boundary, `${id}.rollback_boundary`),
    blocking_questions: normalizeIdList(
      phase.blocking_questions ?? [],
      QUESTION_ID,
      `${id}.blocking_questions`,
    ),
    goal_handoff: nonEmpty(phase.goal_handoff, `${id}.goal_handoff`),
  };
}

function findCycle(nodes, dependencyField = 'depends_on') {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const visit = (id) => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    if (visited.has(id)) return null;
    visiting.add(id);
    stack.push(id);
    for (const dependency of byId.get(id)[dependencyField]) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const id of [...byId.keys()].sort((a, b) => a.localeCompare(b, 'en'))) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

function topologicalOrder(nodes, dependencyField = 'depends_on') {
  const remaining = new Map(nodes.map((node) => [node.id, new Set(node[dependencyField])]));
  const order = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([id]) => id)
      .sort((a, b) => a.localeCompare(b, 'en'));
    if (ready.length === 0) throw new Error('dependency graph contains a cycle');
    for (const id of ready) remaining.delete(id);
    for (const dependencies of remaining.values()) {
      for (const id of ready) dependencies.delete(id);
    }
    order.push(...ready);
  }
  return order;
}

function safeQueueRelativePath(value, label) {
  const path = nonEmpty(value, label);
  const segments = path.split('/');
  if (
    path !== path.trim() ||
    path.startsWith('/') ||
    /^[A-Za-z]:\//u.test(path) ||
    path.endsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`${label} must be a safe repository-relative POSIX path`);
  }
  return path;
}

function queuePathArray(value, label, { allowEmpty = true } = {}) {
  const paths = stringArray(value, label, { allowEmpty })
    .map((path) => safeQueueRelativePath(path, `${label} entry`));
  return paths;
}

function pathEnvelopeContains(parent, child) {
  return child === parent || child.startsWith(`${parent}/`);
}

function normalizeQueuePathEnvelope(input, id) {
  const permitted = queuePathArray(
    input.permitted_changes,
    `${id}.permitted_changes`,
    { allowEmpty: false },
  );
  const prohibited = queuePathArray(
    input.prohibited_changes ?? [],
    `${id}.prohibited_changes`,
  );
  const contradictions = permitted.filter((permittedPath) =>
    prohibited.some((prohibitedPath) => pathEnvelopeContains(prohibitedPath, permittedPath)));
  if (contradictions.length > 0) {
    throw new Error(
      `${id} path envelope both permits and prohibits: ${contradictions.join(', ')}`,
    );
  }
  return { permitted, prohibited };
}

function exactOwnership(nodes, field, expectedIds, label) {
  const owners = new Map();
  for (const node of nodes) {
    for (const id of node[field]) {
      if (!expectedIds.includes(id)) throw new Error(`${node.id} owns unknown ${label} ${id}`);
      if (owners.has(id)) throw new Error(`${label} ${id} has more than one owning phase`);
      owners.set(id, node.id);
    }
  }
  const missing = expectedIds.filter((id) => !owners.has(id));
  if (missing.length > 0) throw new Error(`orphan ${label}: ${missing.join(', ')}`);
  return Object.fromEntries([...owners.entries()].sort());
}

export function validateMilestonePhaseDag({ phases, requirements, acceptanceCriteria } = {}) {
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new TypeError('milestone requires at least one phase');
  }
  const nodes = phases.map(normalizePhase).sort((left, right) => left.id.localeCompare(right.id, 'en'));
  const ids = new Set();
  for (const phase of nodes) {
    if (ids.has(phase.id)) throw new Error(`duplicate phase ${phase.id}`);
    ids.add(phase.id);
  }
  for (const phase of nodes) {
    for (const dependency of phase.depends_on) {
      if (!ids.has(dependency)) throw new Error(`${phase.id} depends on unknown phase ${dependency}`);
      if (dependency === phase.id) throw new Error(`phase dependency cycle: ${phase.id} -> ${phase.id}`);
    }
  }
  if (!nodes.some(({ mandatory }) => mandatory)) {
    throw new Error('milestone phase DAG requires at least one mandatory phase');
  }
  const phaseById = new Map(nodes.map((phase) => [phase.id, phase]));
  for (const phase of nodes) {
    if (
      phase.mandatory &&
      phase.depends_on.some((dependency) => phaseById.get(dependency).mandatory !== true)
    ) {
      throw new Error(`${phase.id} is mandatory and cannot depend on optional phase work`);
    }
  }
  const cycle = findCycle(nodes);
  if (cycle) throw new Error(`phase dependency cycle: ${cycle.join(' -> ')}`);
  const requirementIds = normalizeIdList(requirements ?? [], /^R-\d{2,}$/u, 'requirements');
  const acceptanceIds = normalizeIdList(
    acceptanceCriteria ?? [],
    /^AC-\d{2,}$/u,
    'acceptanceCriteria',
  );
  const requirementOwners = exactOwnership(nodes, 'requirements', requirementIds, 'requirement');
  const acceptanceOwners = exactOwnership(
    nodes,
    'acceptance_criteria',
    acceptanceIds,
    'acceptance criterion',
  );
  const roots = nodes.filter((phase) => phase.depends_on.length === 0).map((phase) => phase.id);
  const executableRoots = nodes
    .filter((phase) => phase.depends_on.length === 0 && phase.blocking_questions.length === 0)
    .map((phase) => phase.id);
  if (executableRoots.length === 0) throw new Error('the first milestone phase is not executable');
  const completionFence = nodes.filter((phase) => phase.mandatory).flatMap((phase) =>
    phase.verification.map((evidence) => ({ phase_id: phase.id, evidence })));
  return deepFreeze({
    phases: nodes,
    roots,
    executable_roots: executableRoots,
    topological_order: topologicalOrder(nodes),
    requirement_owners: requirementOwners,
    acceptance_criterion_owners: acceptanceOwners,
    completion_fence: completionFence,
  });
}

function normalizeQueueItem(input, parentOriginSha256) {
  if (!isPlainObject(input)) throw new TypeError('queue item must be an object');
  const id = assertId(input.id, QUEUE_ITEM_ID, 'queue item id');
  if (!QUEUE_SKILL_SET.has(input.skill)) {
    throw new TypeError(`${id}.skill must be one of ${QUEUE_ITEM_SKILLS.join(', ')}`);
  }
  const status = input.status ?? 'draft';
  if (!QUEUE_STATUS_SET.has(status)) throw new TypeError(`${id}.status is invalid`);
  if (status !== 'draft') {
    throw new Error(`${id} runtime status belongs in QUEUE-STATE.yaml; QUEUE.yaml must remain draft`);
  }
  if (input.skill === 'debug' && input.mode !== 'reactive') {
    throw new Error(`${id} Debug work may be inserted only in reactive mode`);
  }
  if (input.skill === 'debug' && input.auto_start === true) {
    throw new Error(`${id} reactive Debug work cannot silently auto-start`);
  }
  const requires = normalizeIdList(input.requires ?? [], QUEUE_ITEM_ID, `${id}.requires`);
  const consumes = stringArray(input.consumes ?? [], `${id}.consumes`);
  if (input.skill === 'debug') {
    const priorRevisionBound =
      requires.length === 0 &&
      consumes.length === 1 &&
      REACTIVE_FAILURE_ARTIFACT.test(consumes[0]);
    if (!priorRevisionBound) {
      throw new Error(
        `${id} reactive Debug work requires exactly one digest-bound prior-failure evidence artifact and no scheduled predecessor`,
      );
    }
  }
  const parentDigest = input.parent_origin_sha256 ?? parentOriginSha256;
  assertDigest(parentDigest, `${id}.parent_origin_sha256`);
  if (parentDigest !== parentOriginSha256) {
    throw new Error(`${id} parent origin differs from the queue origin`);
  }
  const blockers = input.blockers ?? [];
  const attempts = input.attempts ?? [];
  if (!Array.isArray(blockers) || blockers.length > 0) {
    throw new Error(`${id}.blockers belong in QUEUE-STATE.yaml and must be empty in QUEUE.yaml`);
  }
  if (!Array.isArray(attempts) || attempts.length > 0) {
    throw new Error(`${id}.attempts belong in QUEUE-STATE.yaml and must be empty in QUEUE.yaml`);
  }
  if (input.result != null) {
    throw new Error(`${id}.result belongs in QUEUE-STATE.yaml and must be null in QUEUE.yaml`);
  }
  const pathEnvelope = normalizeQueuePathEnvelope(input, id);
  return {
    id,
    skill: input.skill,
    purpose: nonEmpty(input.purpose, `${id}.purpose`),
    scope: nonEmpty(input.scope, `${id}.scope`),
    status,
    mode: input.mode == null ? '' : String(input.mode),
    phase: input.phase == null ? null : assertId(input.phase, PHASE_ID, `${id}.phase`),
    requires,
    dependents: normalizeIdList(input.dependents ?? [], QUEUE_ITEM_ID, `${id}.dependents`),
    consumes,
    produces: stringArray(input.produces ?? [], `${id}.produces`),
    mandatory: input.mandatory !== false,
    auto_start: input.auto_start === true,
    auto_start_conditions: stringArray(
      input.auto_start_conditions ?? [],
      `${id}.auto_start_conditions`,
    ),
    permissions_required: stringArray(
      input.permissions_required ?? [],
      `${id}.permissions_required`,
    ),
    capability_requirements: stringArray(
      input.capability_requirements ?? [],
      `${id}.capability_requirements`,
    ),
    acceptance_criteria: normalizeIdList(
      input.acceptance_criteria ?? [],
      /^AC-\d{2,}$/u,
      `${id}.acceptance_criteria`,
    ),
    permitted_changes: pathEnvelope.permitted,
    prohibited_changes: pathEnvelope.prohibited,
    parent_origin_sha256: parentDigest,
    child_origin_policy: input.child_origin_policy ?? 'inherit_and_narrow',
    blockers: [],
    attempts: [],
    result: null,
  };
}

function deriveQueueDependents(items) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const dependents = new Map(items.map((item) => [item.id, []]));
  for (const item of items) {
    for (const requirement of item.requires) {
      if (!byId.has(requirement)) throw new Error(`${item.id} requires unknown queue item ${requirement}`);
      if (requirement === item.id) throw new Error(`queue dependency cycle: ${item.id} -> ${item.id}`);
      dependents.get(requirement).push(item.id);
    }
  }
  for (const item of items) {
    dependents.get(item.id).sort((a, b) => a.localeCompare(b, 'en'));
  }
  return dependents;
}

export function createWorkflowQueue({
  id,
  projectId,
  milestoneId = null,
  originSha256,
  buildContractDigest,
  approved = false,
  approvedAt = null,
  items,
} = {}) {
  assertId(id, QUEUE_ID, 'queue id');
  assertId(projectId, PROJECT_ID, 'project id');
  if (milestoneId != null) assertId(milestoneId, MILESTONE_ID, 'milestone id');
  assertDigest(originSha256, 'originSha256');
  assertDigest(buildContractDigest, 'buildContractDigest');
  if (typeof approved !== 'boolean') throw new TypeError('approved must be boolean');
  if ((approved && approvedAt == null) || (!approved && approvedAt != null)) {
    throw new Error('approved_at must be present exactly when queue.approved is true');
  }
  if (!Array.isArray(items) || items.length === 0) throw new TypeError('queue requires items');
  const normalized = items.map((item) => normalizeQueueItem(item, originSha256));
  normalized.sort((left, right) => left.id.localeCompare(right.id, 'en'));
  const ids = new Set();
  for (const item of normalized) {
    if (ids.has(item.id)) throw new Error(`duplicate queue item ${item.id}`);
    ids.add(item.id);
  }
  const derived = deriveQueueDependents(normalized);
  for (const item of normalized) {
    if (item.dependents.length > 0 && canonicalJson(item.dependents) !== canonicalJson(derived.get(item.id))) {
      throw new Error(`${item.id}.dependents do not match requires edges`);
    }
    item.dependents = derived.get(item.id);
    if (item.child_origin_policy !== 'inherit_and_narrow') {
      throw new Error(`${item.id} child origin policy must be inherit_and_narrow`);
    }
  }
  const cycle = findCycle(normalized, 'requires');
  if (cycle) throw new Error(`queue dependency cycle: ${cycle.join(' -> ')}`);
  const queue = {
    schema_version: 1,
    queue: {
      id,
      project_id: projectId,
      milestone_id: milestoneId,
      origin_sha256: originSha256,
      build_contract_digest: buildContractDigest,
      approved,
      approved_at: approvedAt,
    },
    items: normalized,
  };
  canonicalJson(queue);
  return deepFreeze(queue);
}

export function validateWorkflowQueue(input) {
  if (!isPlainObject(input) || !isPlainObject(input.queue)) {
    throw new TypeError('workflow queue must be an object');
  }
  return createWorkflowQueue({
    id: input.queue.id,
    projectId: input.queue.project_id,
    milestoneId: input.queue.milestone_id,
    originSha256: input.queue.origin_sha256,
    buildContractDigest: input.queue.build_contract_digest,
    approved: input.queue.approved,
    approvedAt: input.queue.approved_at,
    items: input.items,
  });
}

/**
 * Validate the immutable coordination semantics that must hold before Build
 * may approve a queue. Runtime status is deliberately outside this contract.
 */
export function validateQueueCoordinationContract(
  queueInput,
  { milestonePhaseDag = null } = {},
) {
  const queue = validateWorkflowQueue(queueInput);
  const byId = new Map(queue.items.map((item) => [item.id, item]));
  const outputOwner = new Map();
  for (const item of queue.items) {
    for (const output of item.produces) {
      if (outputOwner.has(output)) {
        throw new Error(
          `queue output ${output} has multiple producers: ${outputOwner.get(output)}, ${item.id}`,
        );
      }
      outputOwner.set(output, item.id);
    }
  }
  for (const item of queue.items) {
    const dependencyOutputs = new Set(
      item.requires.flatMap((dependency) => byId.get(dependency).produces),
    );
    for (const dependency of item.requires) {
      const predecessor = byId.get(dependency);
      if (!predecessor.produces.some((output) => item.consumes.includes(output))) {
        throw new Error(
          `${item.id} dependency ${dependency} has no declared produce-to-consume dataflow`,
        );
      }
    }
    if (item.requires.length > 0) {
      const orphanInputs = item.consumes.filter((input) => !dependencyOutputs.has(input));
      if (orphanInputs.length > 0) {
        throw new Error(
          `${item.id} consumes values not produced by its direct dependencies: ${orphanInputs.join(', ')}`,
        );
      }
    }
  }

  if (queue.queue.milestone_id == null) return queue;
  const rawPhases = Array.isArray(milestonePhaseDag)
    ? milestonePhaseDag
    : milestonePhaseDag?.phases;
  if (!Array.isArray(rawPhases) || rawPhases.length === 0) {
    throw new Error('milestone queue approval requires its validated milestone phase DAG');
  }
  const phases = rawPhases.map((phase) => ({
    id: assertId(phase.id, PHASE_ID, 'milestone queue phase id'),
    mandatory: phase.mandatory !== false,
    depends_on: normalizeIdList(
      phase.depends_on ?? [],
      PHASE_ID,
      `${phase.id}.depends_on`,
    ),
    acceptance_criteria: normalizeIdList(
      phase.acceptance_criteria ?? [],
      /^AC-\d{2,}$/u,
      `${phase.id}.acceptance_criteria`,
    ),
  }));
  if (new Set(phases.map(({ id }) => id)).size !== phases.length) {
    throw new Error('milestone queue phase DAG contains duplicate phase IDs');
  }
  const phaseIds = new Set(phases.map(({ id }) => id));
  for (const item of queue.items) {
    if (item.phase != null && !phaseIds.has(item.phase)) {
      throw new Error(`${item.id} maps to unknown milestone phase ${item.phase}`);
    }
  }

  const goalItems = queue.items.filter((item) => item.skill === 'goal');
  const controllerItems = goalItems.filter((item) => item.mode === 'milestone-controller');
  if (controllerItems.length > 0) {
    if (controllerItems.length !== 1 || goalItems.length !== 1) {
      throw new Error('milestone-controller queue mode requires exactly one Goal item');
    }
    const controller = controllerItems[0];
    if (controller.phase !== null || controller.mandatory !== true) {
      throw new Error('milestone-controller Goal must be mandatory and must not name one phase');
    }
    const requiredCriteria = phases
      .filter((phase) => phase.mandatory)
      .flatMap((phase) => phase.acceptance_criteria)
      .sort((left, right) => left.localeCompare(right, 'en'));
    if (canonicalJson(controller.acceptance_criteria) !== canonicalJson(requiredCriteria)) {
      throw new Error('milestone-controller Goal must cover every mandatory phase criterion exactly');
    }
    return queue;
  }

  if (goalItems.length !== phases.length) {
    throw new Error('milestone queue requires exactly one Goal item for every approved phase');
  }
  const goalByPhase = new Map(goalItems.map((item) => [item.phase, item]));
  for (const phase of phases) {
    const owners = goalItems.filter((item) => item.phase === phase.id);
    if (owners.length !== 1) {
      throw new Error(`milestone phase ${phase.id} must have exactly one Goal queue item`);
    }
    const owner = owners[0];
    if (owner.mode !== '' && owner.mode !== 'single-slice') {
      throw new Error(`${owner.id} has an unsupported Goal queue mode`);
    }
    if (owner.mandatory !== phase.mandatory) {
      throw new Error(`${owner.id} mandatory status differs from approved phase ${phase.id}`);
    }
    if (
      canonicalJson(owner.acceptance_criteria) !==
      canonicalJson(phase.acceptance_criteria)
    ) {
      throw new Error(`${owner.id} acceptance criteria differ from approved phase ${phase.id}`);
    }
    const expectedGoalDependencies = phase.depends_on
      .map((dependency) => goalByPhase.get(dependency)?.id)
      .sort((left, right) => left.localeCompare(right, 'en'));
    const actualGoalDependencies = owner.requires
      .filter((dependency) => byId.get(dependency)?.skill === 'goal')
      .sort((left, right) => left.localeCompare(right, 'en'));
    if (
      expectedGoalDependencies.some((id) => id == null) ||
      canonicalJson(actualGoalDependencies) !== canonicalJson(expectedGoalDependencies)
    ) {
      throw new Error(
        `${owner.id} Goal dependencies differ from approved phase ${phase.id} dependencies`,
      );
    }
  }
  return queue;
}

export function workflowQueueDigest(queueInput) {
  return recordDigest(validateWorkflowQueue(queueInput));
}

export function isApproveFoundationChoice(value) {
  return String(value ?? '') === BUILD_APPROVAL_LABELS.bootstrap;
}

export function isApproveMilestoneChoice(value) {
  return String(value ?? '') === BUILD_APPROVAL_LABELS.milestone;
}

function approvalLabel(mode) {
  const label = BUILD_APPROVAL_LABELS[mode];
  if (!label) throw new TypeError('Build approval mode must be bootstrap or milestone');
  return label;
}

function requireVerifiedBuildApproval(receipt) {
  if (!isVerifiedBuildApproval(receipt) || receipt.valid !== true) {
    throw new Error('queue authority requires an opaque verified Build approval receipt');
  }
  return receipt;
}

function approvedQueueSnapshot(queue, receipt) {
  const definitionDigest = workflowQueueDigest(queue);
  const snapshot = receipt.queue_snapshots.find((candidate) =>
    candidate.id === queue.queue.id && candidate.definition_sha256 === definitionDigest);
  if (!snapshot) throw new Error('queue is not present in the verified Build approval manifest');
  if (snapshot.build_contract_digest !== queue.queue.build_contract_digest) {
    throw new Error('queue contract digest differs from its verified Build approval');
  }
  return snapshot;
}

export function createQueueApproval({
  queue,
  mode,
  selectedLabel,
  approvedAt = null,
  verifiedBuildApproval,
} = {}) {
  const definition = validateWorkflowQueue(queue);
  const receipt = requireVerifiedBuildApproval(verifiedBuildApproval);
  const queueSnapshot = approvedQueueSnapshot(definition, receipt);
  if (mode != null && mode !== receipt.mode) throw new Error('queue approval mode differs from Build approval');
  if (selectedLabel != null && selectedLabel !== receipt.label) {
    throw new Error('queue approval label differs from verified Build approval');
  }
  if (approvedAt != null && nowIso(approvedAt) !== receipt.approved_at) {
    throw new Error('queue approval time differs from verified Build approval');
  }
  const permissions = definition.items.map((item) => ({
    id: item.id,
    permissions_required: item.permissions_required,
  }));
  return deepFreeze({
    schema_version: 1,
    kind: 'cruise_queue_approval',
    queue_id: definition.queue.id,
    queue_path: queueSnapshot.path,
    mode: receipt.mode,
    selected_label: receipt.label,
    definition_sha256: workflowQueueDigest(definition),
    build_contract_digest: definition.queue.build_contract_digest,
    build_approval_digest: receipt.approval_digest,
    build_manifest_digest: receipt.manifest.contract_digest,
    permission_envelope_sha256: recordDigest(permissions),
    approved_at: receipt.approved_at,
  });
}

export function verifyQueueApproval(queueInput, approval, { verifiedBuildApproval } = {}) {
  const queue = validateWorkflowQueue(queueInput);
  const receipt = requireVerifiedBuildApproval(verifiedBuildApproval);
  const queueSnapshot = approvedQueueSnapshot(queue, receipt);
  if (!isPlainObject(approval) || approval.kind !== 'cruise_queue_approval') {
    throw new Error('approved queue snapshot is missing');
  }
  if (approval.mode !== receipt.mode || approval.selected_label !== receipt.label) {
    throw new Error('queue approval does not match verified Build authority');
  }
  if (
    approval.build_approval_digest !== receipt.approval_digest ||
    approval.build_manifest_digest !== receipt.manifest.contract_digest
  ) {
    throw new Error('queue approval is not bound to the verified Build approval');
  }
  if (approval.queue_id !== queue.queue.id) throw new Error('queue approval targets another queue');
  if (approval.queue_path !== queueSnapshot.path) throw new Error('queue approval targets another path');
  if (approval.definition_sha256 !== workflowQueueDigest(queue)) {
    throw new Error('queue definition changed after approval');
  }
  const permissions = queue.items.map((item) => ({
    id: item.id,
    permissions_required: item.permissions_required,
  }));
  if (approval.permission_envelope_sha256 !== recordDigest(permissions)) {
    throw new Error('queue permission envelope changed after approval');
  }
  if (approval.approved_at !== receipt.approved_at) {
    throw new Error('queue approval timestamp differs from verified Build approval');
  }
  return true;
}

export function createQueueState(queueInput, { now = () => new Date() } = {}) {
  void queueInput;
  void now;
  throw new Error(
    'direct queue reducers are disabled; use the opaque private Build queue coordinator',
  );
}

export function updateQueueItemState(
  queueInput,
  stateInput,
  { id, status, blockers = [], attempts = null, result = null } = {},
  { now = () => new Date() } = {},
) {
  void queueInput;
  void stateInput;
  void id;
  void status;
  void blockers;
  void attempts;
  void result;
  void now;
  throw new Error(
    'legacy updateQueueItemState is disabled; use the evidence-aware Build queue coordinator',
  );
}

export function reconcileQueueState(
  queueInput,
  stateInput,
  { now = () => new Date() } = {},
) {
  void queueInput;
  void stateInput;
  void now;
  throw new Error(
    'direct queue reducers are disabled; use the opaque private Build queue coordinator',
  );
}

export function queueCompletionStatus(queueInput, stateInput) {
  void queueInput;
  void stateInput;
  throw new Error(
    'direct queue completion claims are disabled; use the opaque private Build queue coordinator',
  );
}

export function createQueueChildOrigin({
  queue: queueInput,
  queueItemId,
  inheritedOutcome,
  narrowedOutcome,
  permittedChanges,
  prohibitedChanges,
} = {}) {
  const queue = validateWorkflowQueue(queueInput);
  const item = queue.items.find((entry) => entry.id === queueItemId);
  if (!item) throw new Error(`unknown queue item ${queueItemId}`);
  const inherited = nonEmpty(inheritedOutcome, 'inheritedOutcome');
  const narrowed = nonEmpty(narrowedOutcome, 'narrowedOutcome');
  const permitted = queuePathArray(permittedChanges, 'permittedChanges', { allowEmpty: false });
  const prohibited = queuePathArray(prohibitedChanges ?? [], 'prohibitedChanges');
  if (inherited !== item.purpose || narrowed !== item.scope) {
    throw new Error('child origin outcomes must exactly match the approved queue item');
  }
  if (
    canonicalJson(permitted) !== canonicalJson(item.permitted_changes) ||
    canonicalJson(prohibited) !== canonicalJson(item.prohibited_changes)
  ) {
    throw new Error('child origin path envelope must exactly match the approved queue item');
  }
  return deepFreeze({
    schema_version: 1,
    kind: 'cruise_queue_child_origin',
    parent: {
      origin_sha256: queue.queue.origin_sha256,
      queue_id: queue.queue.id,
      queue_item_id: item.id,
      project_id: queue.queue.project_id,
      milestone_id: queue.queue.milestone_id,
      phase_id: item.phase,
    },
    scope: {
      inherited_outcome: inherited,
      narrowed_outcome: narrowed,
      permitted_changes: permitted,
      prohibited_changes: prohibited,
    },
  });
}

export function assertQueueChildScope(childOrigin, requestedChanges) {
  if (!isPlainObject(childOrigin) || childOrigin.kind !== 'cruise_queue_child_origin') {
    throw new TypeError('child origin is invalid');
  }
  const requested = queuePathArray(requestedChanges, 'requestedChanges');
  for (const change of requested) {
    if (!childOrigin.scope.permitted_changes.includes(change)) {
      throw new Error(`child scope expansion is forbidden: ${change}`);
    }
    if (childOrigin.scope.prohibited_changes.includes(change)) {
      throw new Error(`child change is explicitly prohibited: ${change}`);
    }
  }
  return true;
}

export function evaluateQueueAutoStart({
  queue: queueInput,
  approval,
  verifiedBuildApproval,
  state: stateInput,
  itemId,
  repositoryBaselineValid,
  artifactBaselineValid,
  newPermissionRequired = false,
  authenticationDecisionRequired = false,
  mandatoryAmbiguity = false,
  hostContinuationSupported = false,
  semanticAdmission = null,
  observedConditions = [],
} = {}) {
  void queueInput;
  void approval;
  void verifiedBuildApproval;
  void stateInput;
  void itemId;
  void repositoryBaselineValid;
  void artifactBaselineValid;
  void newPermissionRequired;
  void authenticationDecisionRequired;
  void mandatoryAmbiguity;
  void hostContinuationSupported;
  void semanticAdmission;
  void observedConditions;
  throw new Error(
    'direct queue auto-start evaluation is disabled; use the opaque private Build queue coordinator',
  );
}

function requiredLockedFiles(mode) {
  if (mode === 'bootstrap') return BOOTSTRAP_LOCKED_FILES;
  if (mode === 'milestone') return MILESTONE_LOCKED_FILES;
  throw new TypeError('Build approval mode must be bootstrap or milestone');
}

const PROJECT_CONTRACT_PATH = '.cruise/project';
export const BUILD_ID_REGISTRY_PATH = `${PROJECT_CONTRACT_PATH}/ID-REGISTRY.yaml`;
const MILESTONE_CONTRACT_PATH = /^\.cruise\/milestones\/(M-\d{2,})-[a-z0-9][a-z0-9-]*$/u;

function selectionSnapshot(selection) {
  return {
    source: selection.source,
    interaction_id: selection.interaction_id,
    option_id: selection.option_id,
    selected_label: selection.selected_label,
    review_digest: selection.review_digest,
    selected_at: selection.selected_at,
  };
}

async function canonicalContractDirectory(root, mode, contractDirectory) {
  const canonicalRoot = await realpath(resolve(root));
  const requested = resolve(canonicalRoot, contractDirectory);
  const requestedMetadata = await lstat(requested);
  if (!requestedMetadata.isDirectory() || requestedMetadata.isSymbolicLink()) {
    throw new Error('Build contract directory must be a real directory');
  }
  const canonicalDirectory = await realpath(requested);
  if (canonicalDirectory !== requested) {
    throw new Error('Build contract directory must not traverse symbolic links');
  }
  const rel = portable(relative(canonicalRoot, canonicalDirectory));
  if (!rel || rel === '..' || rel.startsWith('../')) {
    throw new Error('Build contract directory escapes the repository root');
  }
  if (mode === 'bootstrap' && rel !== '.cruise/project') {
    throw new Error('bootstrap approval must use .cruise/project');
  }
  if (mode === 'milestone' && !/^\.cruise\/milestones\/M-\d{2,}-[a-z0-9][a-z0-9-]*$/u.test(rel)) {
    throw new Error('milestone approval requires .cruise/milestones/<M-ID>-<slug>');
  }
  return { canonicalRoot, canonicalDirectory, relativeDirectory: rel };
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function readLockedArtifactBundle(root, absolutePath) {
  const requested = resolve(absolutePath);
  const beforePath = await lstat(requested);
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size === 0) {
    throw new Error(`${portable(relative(root, requested))} must be a non-empty regular file`);
  }
  const beforeCanonicalPath = await realpath(requested);
  const rel = portable(relative(root, beforeCanonicalPath));
  if (beforeCanonicalPath !== requested || !rel || rel === '..' || rel.startsWith('../')) {
    throw new Error(`${portable(relative(root, requested))} must not traverse symbolic links or escape the repository`);
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(requested, fsConstants.O_RDONLY | noFollow);
    const beforeRead = await handle.stat();
    if (
      !beforeRead.isFile() ||
      beforeRead.size === 0 ||
      !sameFileIdentity(beforePath, beforeRead)
    ) {
      throw new Error(`${rel} changed while its approval snapshot was opened`);
    }
    const bytes = await handle.readFile();
    const afterRead = await handle.stat();
    const afterPath = await lstat(requested);
    const afterCanonicalPath = await realpath(requested);
    if (
      !sameFileIdentity(beforeRead, afterRead) ||
      !sameFileIdentity(afterRead, afterPath) ||
      afterPath.isSymbolicLink() ||
      afterCanonicalPath !== requested ||
      bytes.length !== afterRead.size
    ) {
      throw new Error(`${rel} changed while its approval bytes were read`);
    }
    return {
      snapshot: {
        path: rel,
        sha256: sha256(bytes),
        bytes: bytes.length,
      },
      bytes,
    };
  } finally {
    await handle?.close();
  }
}

function parseLockedYaml(bytes, path) {
  try {
    const value = parseYaml(bytes.toString('utf8'));
    if (!isPlainObject(value)) throw new TypeError('document root must be a mapping');
    return value;
  } catch (cause) {
    throw new Error(`${path} is not valid Cruise YAML: ${cause.message}`, { cause });
  }
}

function assertExactObjectKeys(value, expectedKeys, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a mapping`);
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  const expected = [...expectedKeys].sort((left, right) => left.localeCompare(right, 'en'));
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} fields must be exactly: ${expected.join(', ')}`);
  }
}

function normalizeHeading(value) {
  return String(value)
    .replace(/[`*_~]/gu, '')
    .replace(/[^A-Za-z0-9-]+/gu, ' ')
    .trim()
    .toLowerCase();
}

function markdownSections(text, path) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error(`${path} must contain a human-reviewable Markdown contract`);
  }
  const matches = [...text.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*$/gmu)];
  if (matches.length === 0) throw new Error(`${path} must contain Markdown headings`);
  return matches.map((match, index) => ({
    level: match[1].length,
    heading: match[2].trim(),
    normalized_heading: normalizeHeading(match[2]),
    body: text.slice(
      match.index + match[0].length,
      matches[index + 1]?.index ?? text.length,
    ).trim(),
  }));
}

function requireMarkdownSection(sections, names, path) {
  const normalizedNames = names.map(normalizeHeading);
  const section = sections.find(({ normalized_heading: heading }) =>
    normalizedNames.includes(heading));
  if (!section || section.body === '') {
    throw new Error(`${path} requires a non-empty ${names[0]} section`);
  }
  return section;
}

function requireLabeledValue(body, label, path) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const matches = [...body.matchAll(new RegExp(`^${escaped}:[ \\t]*(.*)$`, 'gimu'))];
  if (matches.length === 0 || matches[0][1].trim() === '') {
    throw new Error(`${path} requires a non-empty ${label}: field`);
  }
  if (matches.length !== 1) {
    throw new Error(`${path} requires exactly one ${label}: field`);
  }
  return matches[0][1].trim();
}

function markdownListValue(values) {
  return values.length === 0 ? 'None' : values.join(', ');
}

function assertExactMarkdownField(
  actual,
  expected,
  label,
  { allowTerminalPeriod = false } = {},
) {
  const candidates = [actual];
  if (allowTerminalPeriod && actual.endsWith('.')) {
    candidates.push(actual.slice(0, -1).trimEnd());
  }
  if (!candidates.includes(expected)) {
    throw new Error(`${label} must exactly match the approved phase DAG`);
  }
}

function identifierSections(sections, expression, label, path) {
  const entries = [];
  const seen = new Set();
  for (const section of sections) {
    const match = section.heading.match(expression);
    if (!match) continue;
    const id = match[1];
    if (seen.has(id)) throw new Error(`${path} contains duplicate ${label} ${id}`);
    if (section.body === '') throw new Error(`${path} ${id} must be non-empty`);
    seen.add(id);
    entries.push({ ...section, id });
  }
  if (entries.length === 0) throw new Error(`${path} requires at least one ${label}`);
  return entries;
}

function validateProjectMarkdown(text, path, { projectId }) {
  const sections = markdownSections(text, path);
  const title = sections.find(({ level }) => level === 1);
  if (!title) throw new Error(`${path} requires a project-name title`);
  assertTextContainsIdentifier(title.heading, projectId, path);
  for (const names of [
    ['Identity', 'One-sentence identity'],
    ['Beneficiary or target users', 'Beneficiary', 'Target users'],
    ['Core value'],
    ['Measurable project outcomes', 'Project outcomes'],
    ['Non-goals'],
    ['Business or scientific context', 'Context'],
    ['Protected principles'],
    ['Known constraints', 'Constraints'],
    ['Success measures'],
    ['Current maturity', 'Maturity'],
    ['Canonical terminology', 'Terminology'],
  ]) requireMarkdownSection(sections, names, path);
}

function validateProjectRequirementsMarkdown(text, path, { milestoneId }) {
  const entries = identifierSections(
    markdownSections(text, path),
    /(?:^|\s)(R-\d{2,})(?:\s|$)/u,
    'project requirement',
    path,
  );
  for (const entry of entries) {
    requireLabeledValue(entry.body, 'Source', `${path} ${entry.id}`);
    requireLabeledValue(entry.body, 'Decision links', `${path} ${entry.id}`);
    const acceptance = requireLabeledValue(entry.body, 'Acceptance criteria', `${path} ${entry.id}`);
    if (!/\bAC-\d{2,}\b/u.test(acceptance)) {
      throw new Error(`${path} ${entry.id} must map to a stable acceptance criterion`);
    }
    requireLabeledValue(entry.body, 'Priority', `${path} ${entry.id}`);
    const target = requireLabeledValue(entry.body, 'Target milestone', `${path} ${entry.id}`);
    assertTextContainsIdentifier(target, milestoneId, `${path} ${entry.id} Target milestone`);
    requireLabeledValue(entry.body, 'Status', `${path} ${entry.id}`);
    requireLabeledValue(entry.body, 'Verification class', `${path} ${entry.id}`);
  }
}

function validateArchitectureMarkdown(text, path) {
  const sections = markdownSections(text, path);
  for (const names of [
    ['Context and system boundary', 'System boundary'],
    ['Major components'],
    ['Data ownership'],
    ['External interfaces'],
    ['Deployment assumptions'],
    ['Security and privacy posture', 'Security and privacy'],
    ['Observability'],
    ['Testing strategy'],
    ['Performance constraints'],
    ['Rejected alternatives'],
    ['Unresolved architecture questions'],
    ['Decision reopening triggers', 'Reopening triggers'],
  ]) requireMarkdownSection(sections, names, path);
}

function validateProjectRoadmapMarkdown(text, path, { milestoneId }) {
  const entries = identifierSections(
    markdownSections(text, path),
    /(?:^|\s)(M-\d{2,})(?:\s|$)/u,
    'strategic milestone',
    path,
  );
  if (!entries.some(({ id }) => id === milestoneId)) {
    throw new Error(`${path} omits approved milestone ${milestoneId}`);
  }
  const allowed = [
    'usable outcome',
    'safely deployable transition',
    'validated technical foundation',
    'decision-complete research result',
  ];
  for (const entry of entries) {
    const value = requireLabeledValue(entry.body, 'Transition value', `${path} ${entry.id}`)
      .toLowerCase();
    if (!allowed.some((candidate) => value.includes(candidate))) {
      throw new Error(`${path} ${entry.id} is not a strategically complete transition`);
    }
  }
}

function validateDecisionsMarkdown(text, path) {
  const entries = identifierSections(
    markdownSections(text, path),
    /(?:^|\s)(D-\d{2,})(?:\s|$)/u,
    'decision',
    path,
  );
  for (const entry of entries) {
    for (const label of ['Status', 'Decision', 'Evidence', 'Reopening trigger']) {
      requireLabeledValue(entry.body, label, `${path} ${entry.id}`);
    }
  }
}

function validateMilestoneMarkdown(text, path, { milestoneId }) {
  const sections = markdownSections(text, path);
  const title = sections.find(({ level }) => level === 1);
  if (!title) throw new Error(`${path} requires a milestone ID/name title`);
  assertTextContainsIdentifier(title.heading, milestoneId, path);
  for (const names of [
    ['Outcome and beneficiary', 'Outcome'],
    ['Relationship to project goals', 'Project relationship'],
    ['Current repository evidence', 'Repository evidence'],
    ['Scope'],
    ['Non-goals'],
    ['Protected existing behavior', 'Protected behavior'],
    ['Completion fence'],
    ['Constraints'],
    ['Release and rollback expectations', 'Release and rollback'],
    ['Permissions'],
    ['Unresolved risks', 'Risks'],
    ['Phase summary'],
  ]) requireMarkdownSection(sections, names, path);
}

function validateMilestoneRequirementsMarkdown(text, path, phaseDag) {
  const entries = identifierSections(
    markdownSections(text, path),
    /(?:^|\s)(R-\d{2,})(?:\s|$)/u,
    'milestone requirement',
    path,
  );
  const expected = [...phaseDag.requirement_ids].sort((left, right) => left.localeCompare(right, 'en'));
  const actual = entries.map(({ id }) => id).sort((left, right) => left.localeCompare(right, 'en'));
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${path} requirement IDs must exactly match the approved phase DAG`);
  }
  const phaseByRequirement = new Map();
  for (const phase of phaseDag.phases) {
    for (const id of phase.requirements) phaseByRequirement.set(id, phase);
  }
  const mappedAcceptance = new Set();
  for (const entry of entries) {
    const phase = phaseByRequirement.get(entry.id);
    const acceptance = requireLabeledValue(
      entry.body,
      'Acceptance criteria',
      `${path} ${entry.id}`,
    );
    assertExactMarkdownField(
      acceptance,
      markdownListValue(phase.acceptance_criteria),
      `${path} ${entry.id} Acceptance criteria`,
      { allowTerminalPeriod: true },
    );
    for (const id of phase.acceptance_criteria) mappedAcceptance.add(id);
    const owner = requireLabeledValue(entry.body, 'Owning phase', `${path} ${entry.id}`);
    assertExactMarkdownField(
      owner,
      phase.id,
      `${path} ${entry.id} Owning phase`,
      { allowTerminalPeriod: true },
    );
    const prerequisites = requireLabeledValue(
      entry.body,
      'Prerequisite phases',
      `${path} ${entry.id}`,
    );
    assertExactMarkdownField(
      prerequisites,
      markdownListValue(phase.depends_on),
      `${path} ${entry.id} Prerequisite phases`,
      { allowTerminalPeriod: true },
    );
    assertExactMarkdownField(
      requireLabeledValue(entry.body, 'Verification evidence', `${path} ${entry.id}`),
      markdownListValue(phase.verification),
      `${path} ${entry.id} Verification evidence`,
      { allowTerminalPeriod: true },
    );
    assertExactMarkdownField(
      requireLabeledValue(
        entry.body,
        'Protected project principles',
        `${path} ${entry.id}`,
      ),
      markdownListValue(phase.protected_behavior),
      `${path} ${entry.id} Protected project principles`,
      { allowTerminalPeriod: true },
    );
  }
  const expectedAcceptance = [...phaseDag.acceptance_criterion_ids]
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (canonicalJson([...mappedAcceptance].sort()) !== canonicalJson(expectedAcceptance)) {
    throw new Error(`${path} does not map every acceptance criterion to a requirement`);
  }
}

function validateMilestoneRoadmapMarkdown(text, path, phaseDag) {
  const sections = markdownSections(text, path);
  const entries = identifierSections(
    sections,
    /(?:^|\s)(P-\d{2,})(?:\s|$)/u,
    'phase',
    path,
  );
  const expected = [...phaseDag.phase_ids].sort((left, right) => left.localeCompare(right, 'en'));
  const actual = entries.map(({ id }) => id).sort((left, right) => left.localeCompare(right, 'en'));
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${path} phase IDs must exactly match the approved phase DAG`);
  }
  const byId = new Map(phaseDag.phases.map((phase) => [phase.id, phase]));
  for (const entry of entries) {
    const phase = byId.get(entry.id);
    assertExactMarkdownField(
      requireLabeledValue(entry.body, 'Outcome', `${path} ${entry.id}`),
      phase.outcome,
      `${path} ${entry.id} Outcome`,
    );
    const strategic = requireLabeledValue(
      entry.body,
      'Strategically complete',
      `${path} ${entry.id}`,
    );
    if (strategic.toLowerCase() !== 'true') {
      throw new Error(`${path} ${entry.id} must be strategically complete`);
    }
    const dependencies = requireLabeledValue(entry.body, 'Depends on', `${path} ${entry.id}`);
    assertExactMarkdownField(
      dependencies,
      markdownListValue(phase.depends_on),
      `${path} ${entry.id} Depends on`,
    );
    const requirements = requireLabeledValue(entry.body, 'Requirements', `${path} ${entry.id}`);
    assertExactMarkdownField(
      requirements,
      markdownListValue(phase.requirements),
      `${path} ${entry.id} Requirements`,
    );
    const acceptance = requireLabeledValue(
      entry.body,
      'Acceptance criteria',
      `${path} ${entry.id}`,
    );
    assertExactMarkdownField(
      acceptance,
      markdownListValue(phase.acceptance_criteria),
      `${path} ${entry.id} Acceptance criteria`,
    );
    for (const [label, expectedValue] of [
      ['Protected behavior', markdownListValue(phase.protected_behavior)],
      ['Expected artifacts', markdownListValue(phase.expected_artifacts)],
      ['Verification', markdownListValue(phase.verification)],
      ['Rollback boundary', phase.rollback_boundary],
      ['Blocking questions', markdownListValue(phase.blocking_questions)],
      ['Goal handoff', phase.goal_handoff],
    ]) {
      assertExactMarkdownField(
        requireLabeledValue(entry.body, label, `${path} ${entry.id}`),
        expectedValue,
        `${path} ${entry.id} ${label}`,
      );
    }
  }
  const fence = requireMarkdownSection(
    sections,
    ['Milestone completion fence', 'Completion fence'],
    path,
  );
  const actualFence = fence.body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*+]\s+/u, ''));
  const expectedFence = phaseDag.completion_fence
    .map(({ phase_id: phaseId, evidence }) => `${phaseId}: ${evidence}`);
  if (canonicalJson(actualFence) !== canonicalJson(expectedFence)) {
    throw new Error(`${path} completion fence must exactly match the approved phase DAG`);
  }
}

function assertTextContainsIdentifier(text, identifier, path) {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  if (!(new RegExp(`(?:^|[^A-Za-z0-9-])${escaped}(?:$|[^A-Za-z0-9-])`, 'mu')).test(text)) {
    throw new Error(`${path} does not contain approved identifier ${identifier}`);
  }
}

function normalizeApprovalPhaseDag(input) {
  if (input == null) throw new Error('milestone approval requires a validated milestonePhaseDag');
  const phases = Array.isArray(input) ? input : input.phases;
  if (!Array.isArray(phases)) throw new TypeError('milestonePhaseDag must contain phases');
  const requirements = [...new Set(phases.flatMap((phase) => phase.requirements ?? []))];
  const acceptanceCriteria = [
    ...new Set(phases.flatMap((phase) => phase.acceptance_criteria ?? [])),
  ];
  const validated = validateMilestonePhaseDag({ phases, requirements, acceptanceCriteria });
  return {
    phases: clone(validated.phases),
    controller_phase_dag: validated.phases.map((phase) => ({
      id: phase.id,
      depends_on: phase.depends_on,
      mandatory: phase.mandatory,
      acceptance_criteria: phase.acceptance_criteria,
    })),
    completion_fence: clone(validated.completion_fence),
    phase_ids: validated.phases.map(({ id }) => id),
    requirement_ids: requirements.sort((left, right) => left.localeCompare(right, 'en')),
    acceptance_criterion_ids: acceptanceCriteria.sort((left, right) =>
      left.localeCompare(right, 'en')),
  };
}

function assertNullableTimestamp(value, label) {
  if (value == null) return null;
  return nowIso(value);
}

function validateQuestionsArtifact(record, path, { phaseIds = [] } = {}) {
  assertExactObjectKeys(record, ['questions'], path);
  if (!Array.isArray(record.questions)) throw new Error(`${path}.questions must be an array`);
  const ids = new Set();
  const normalizedQuestions = [];
  for (const [index, question] of record.questions.entries()) {
    if (!isPlainObject(question)) throw new Error(`${path}.questions[${index}] must be a mapping`);
    assertExactObjectKeys(question, [
      'id',
      'status',
      'materiality',
      'category',
      'question',
      'evidence',
      'recommendation',
      'options',
      'answer',
      'answer_source',
      'affects',
      'asked_at',
      'answered_at',
      'reopening_trigger',
    ], `${path}.questions[${index}]`);
    const normalized = normalizeQuestion(question);
    normalizedQuestions.push(normalized);
    if (ids.has(normalized.id)) {
      throw new Error(`${path} contains duplicate question ${normalized.id}`);
    }
    ids.add(normalized.id);
    if (normalized.evidence.length === 0) {
      throw new Error(`${normalized.id} must preserve its evidence basis`);
    }
    assertNullableTimestamp(normalized.asked_at, `${normalized.id}.asked_at`);
    assertNullableTimestamp(normalized.answered_at, `${normalized.id}.answered_at`);
    const resolved = ['answered', 'assumed'].includes(normalized.status);
    if (resolved && (
      normalized.answer == null ||
      normalized.answer_source == null ||
      normalized.answered_at == null ||
      normalized.asked_at == null
    )) {
      throw new Error(`${normalized.id} resolved status requires answer, source, and timestamps`);
    }
    const hasAnyResolutionField =
      normalized.answer != null ||
      normalized.answer_source != null ||
      normalized.answered_at != null;
    const hasAllResolutionFields =
      normalized.answer != null &&
      normalized.answer_source != null &&
      normalized.answered_at != null;
    if (normalized.status === 'deferred' && hasAnyResolutionField && !hasAllResolutionFields) {
      throw new Error(
        `${normalized.id} deferred resolution fields must be either all present or all null`,
      );
    }
    if (
      normalized.status === 'deferred' &&
      hasAllResolutionFields &&
      normalized.asked_at == null
    ) {
      throw new Error(`${normalized.id} explicit deferral requires its asked_at timestamp`);
    }
    if (
      normalized.asked_at != null &&
      normalized.answered_at != null &&
      Date.parse(normalized.answered_at) < Date.parse(normalized.asked_at)
    ) {
      throw new Error(`${normalized.id}.answered_at cannot precede asked_at`);
    }
    if (
      !resolved &&
      normalized.status !== 'deferred' &&
      normalized.status !== 'superseded' &&
      hasAnyResolutionField
    ) {
      throw new Error(`${normalized.id} unresolved status cannot contain resolved answer fields`);
    }
    if (normalized.status === 'superseded' && hasAnyResolutionField) {
      throw new Error(`${normalized.id} superseded status cannot contain resolved answer fields`);
    }
    if (
      normalized.materiality === 'phase_blocking' &&
      !normalized.affects.some((id) => phaseIds.includes(id))
    ) {
      throw new Error(`${normalized.id} phase-blocking question must identify an approved phase`);
    }
    if (
      ['project_blocking', 'milestone_blocking'].includes(normalized.materiality) &&
      !['answered', 'assumed', 'superseded'].includes(normalized.status)
    ) {
      throw new Error(`${normalized.id} is an unresolved ${normalized.materiality} question`);
    }
  }
  return {
    questions: normalizedQuestions,
    open_question_ids: normalizedQuestions
      .filter(({ status }) => ['open', 'deferred'].includes(status))
      .map(({ id }) => id)
      .sort((left, right) => left.localeCompare(right, 'en')),
  };
}

function validateAutonomyArtifact(record, path) {
  assertExactObjectKeys(record, [
    'schema_version',
    'mode',
    'decision_policy',
    'hard_stops',
    'dangerous_authorization',
  ], path);
  if (record.schema_version !== 1) throw new Error(`${path}.schema_version must be 1`);
  if (record.mode !== 'interactive') {
    throw new Error(`${path}.mode must remain interactive at Build approval`);
  }
  assertExactObjectKeys(
    record.decision_policy,
    Object.keys(AUTONOMY_DECISION_POLICY),
    `${path}.decision_policy`,
  );
  for (const [policy, expected] of Object.entries(AUTONOMY_DECISION_POLICY)) {
    if (record.decision_policy[policy] !== expected) {
      throw new Error(`${path}.decision_policy.${policy} must remain ${expected}`);
    }
  }
  const hardStops = stringArray(record.hard_stops, `${path}.hard_stops`, { allowEmpty: false })
    .sort((left, right) => left.localeCompare(right, 'en'));
  const expectedHardStops = [...AUTONOMY_HARD_STOPS]
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (canonicalJson(hardStops) !== canonicalJson(expectedHardStops)) {
    throw new Error(`${path}.hard_stops must contain the complete mandatory hard-stop set`);
  }
  if (record.dangerous_authorization !== null) {
    throw new Error(`${path}.dangerous_authorization must be null at Build approval`);
  }
}

function validateStateArtifactIdentities(record, path, expected) {
  assertExactObjectKeys(
    record,
    ['origin_sha256', 'contract_digest', 'queue_definition_sha256'],
    `${path}.artifact_identities`,
  );
  for (const [field, digest] of Object.entries(expected)) {
    assertDigest(record[field], `${path}.artifact_identities.${field}`);
    if (record[field] !== digest) {
      throw new Error(`${path}.artifact_identities.${field} does not match reviewed bytes`);
    }
  }
}

function validateStateReconciliation(record, path, repositoryBaselineDigest) {
  assertExactObjectKeys(
    record,
    ['repository_baseline_digest', 'reconciled_at'],
    `${path}.last_reconciliation`,
  );
  if (record.repository_baseline_digest !== repositoryBaselineDigest) {
    throw new Error(`${path}.last_reconciliation belongs to another repository baseline`);
  }
  assertNullableTimestamp(record.reconciled_at, `${path}.last_reconciliation.reconciled_at`);
}

function validateProjectStateArtifact(record, path, {
  projectId,
  milestoneId,
  repositoryBaselineDigest,
  readinessDigest,
  originSha256,
  contractDigest,
  queueDefinitionSha256,
} = {}) {
  assertExactObjectKeys(record, [
    'schema_version',
    'kind',
    'project_id',
    'status',
    'active_milestone',
    'completed_milestones',
    'open_project_questions',
    'current_repository_baseline',
    'readiness_digest',
    'artifact_identities',
    'last_reconciliation',
    'recommended_next_cruise_command',
  ], path);
  if (
    record.schema_version !== 1 ||
    record.kind !== 'cruise_project_state' ||
    record.project_id !== projectId ||
    record.status !== 'draft' ||
    record.active_milestone !== milestoneId
  ) {
    throw new Error(`${path} does not describe the reviewed draft project/milestone`);
  }
  normalizeIdList(record.completed_milestones, MILESTONE_ID, `${path}.completed_milestones`);
  normalizeIdList(record.open_project_questions, QUESTION_ID, `${path}.open_project_questions`);
  if (record.open_project_questions.length > 0) {
    throw new Error(`${path} cannot retain project-blocking questions at approval`);
  }
  if (record.current_repository_baseline !== repositoryBaselineDigest) {
    throw new Error(`${path}.current_repository_baseline is stale`);
  }
  if (record.readiness_digest !== readinessDigest) {
    throw new Error(`${path}.readiness_digest does not match approval readiness`);
  }
  validateStateArtifactIdentities(record.artifact_identities, path, {
    origin_sha256: originSha256,
    contract_digest: contractDigest,
    queue_definition_sha256: queueDefinitionSha256,
  });
  validateStateReconciliation(record.last_reconciliation, path, repositoryBaselineDigest);
  nonEmpty(record.recommended_next_cruise_command, `${path}.recommended_next_cruise_command`);
}

function validateMilestoneStateArtifact(record, path, {
  projectId,
  milestoneId,
  repositoryBaselineDigest,
  readinessDigest,
  originSha256,
  contractDigest,
  queueDefinitionSha256,
  openQuestionIds,
  phaseIds,
} = {}) {
  assertExactObjectKeys(record, [
    'schema_version',
    'kind',
    'project_id',
    'milestone_id',
    'status',
    'active_phase',
    'completed_phases',
    'open_questions',
    'current_repository_baseline',
    'readiness_digest',
    'artifact_identities',
    'last_reconciliation',
    'recommended_next_cruise_command',
  ], path);
  if (
    record.schema_version !== 1 ||
    record.kind !== 'cruise_milestone_state' ||
    record.project_id !== projectId ||
    record.milestone_id !== milestoneId ||
    record.status !== 'draft' ||
    record.active_phase !== null
  ) {
    throw new Error(`${path} does not describe the reviewed draft milestone`);
  }
  const completed = normalizeIdList(record.completed_phases, PHASE_ID, `${path}.completed_phases`);
  if (completed.length > 0) throw new Error(`${path} cannot complete phases before approval`);
  const open = normalizeIdList(record.open_questions, QUESTION_ID, `${path}.open_questions`);
  const expectedOpen = [...openQuestionIds].sort((left, right) => left.localeCompare(right, 'en'));
  if (canonicalJson(open) !== canonicalJson(expectedOpen)) {
    throw new Error(`${path}.open_questions differs from QUESTIONS.yaml`);
  }
  if (record.current_repository_baseline !== repositoryBaselineDigest) {
    throw new Error(`${path}.current_repository_baseline is stale`);
  }
  if (record.readiness_digest !== readinessDigest) {
    throw new Error(`${path}.readiness_digest does not match approval readiness`);
  }
  validateStateArtifactIdentities(record.artifact_identities, path, {
    origin_sha256: originSha256,
    contract_digest: contractDigest,
    queue_definition_sha256: queueDefinitionSha256,
  });
  validateStateReconciliation(record.last_reconciliation, path, repositoryBaselineDigest);
  const next = nonEmpty(
    record.recommended_next_cruise_command,
    `${path}.recommended_next_cruise_command`,
  );
  if (!phaseIds.some((id) => next.includes(id))) {
    throw new Error(`${path}.recommended_next_cruise_command must identify an approved phase`);
  }
}

function validateOriginArtifact(bytes, path, {
  canonicalRoot,
  mode,
  projectId = null,
  milestoneId = null,
} = {}) {
  const origin = parseLockedYaml(bytes, path);
  validateOriginRecord(origin);
  if (origin.origin.selected_skill !== 'build' || origin.routing.selected_route !== 'build') {
    throw new Error(`${path} must be a Build-selected Origin`);
  }
  if (origin.repository_baseline.root !== canonicalRoot) {
    throw new Error(`${path} repository root does not match the approved repository`);
  }
  if (origin.build.mode !== mode || origin.build.mode_candidate !== mode) {
    throw new Error(`${path} Build mode must be ${mode}`);
  }
  if (projectId != null && origin.build.target_project !== projectId) {
    throw new Error(`${path} targets another project`);
  }
  if (milestoneId !== null && origin.build.target_milestone !== milestoneId) {
    throw new Error(`${path} targets another milestone`);
  }
  return origin;
}

function contentContractDigest({
  mode,
  projectPath,
  milestonePath,
  artifacts,
  milestonePhaseDag = null,
}) {
  return recordDigest({
    schema_version: 1,
    kind: 'cruise_build_contract_content',
    mode,
    project_path: projectPath,
    milestone_path: milestonePath,
    artifacts: artifacts.map(({ path, sha256: digest }) => ({ path, sha256: digest })),
    milestone_phase_dag: milestonePhaseDag,
  });
}

async function inspectBuildContractDraft({
  root,
  mode,
  contractDirectory,
  projectDirectory = PROJECT_CONTRACT_PATH,
  firstMilestoneDirectory = null,
  additionalArtifactPaths = [],
  milestonePhaseDag = null,
} = {}) {
  const project = await canonicalContractDirectory(root, 'bootstrap', projectDirectory);
  let milestone = null;
  if (mode === 'milestone') {
    milestone = await canonicalContractDirectory(root, 'milestone', contractDirectory);
    if (firstMilestoneDirectory != null) {
      throw new Error('firstMilestoneDirectory is valid only for bootstrap approval');
    }
  } else if (mode === 'bootstrap') {
    if (contractDirectory !== project.relativeDirectory) {
      throw new Error('bootstrap approval must use .cruise/project');
    }
    if (firstMilestoneDirectory == null) {
      throw new Error('bootstrap approval requires a first executable milestone contract');
    }
    milestone = await canonicalContractDirectory(root, 'milestone', firstMilestoneDirectory);
  } else {
    throw new TypeError('Build approval mode must be bootstrap or milestone');
  }

  const active = mode === 'milestone' ? milestone : project;
  const extraNames = stringArray(additionalArtifactPaths, 'additionalArtifactPaths');
  const additional = extraNames.map((path) => {
    if (['STATE.yaml', 'QUEUE-STATE.yaml'].includes(basename(path))) {
      throw new Error(`${basename(path)} is mutable runtime state and cannot be byte-locked`);
    }
    if (basename(path) === 'ID-REGISTRY.yaml') {
      throw new Error('ID-REGISTRY.yaml is already a canonical approval artifact');
    }
    const absolute = resolve(active.canonicalDirectory, path);
    const rel = portable(relative(active.canonicalDirectory, absolute));
    if (!rel || rel === '..' || rel.startsWith('../')) {
      throw new Error(`additional Build artifact escapes the contract directory: ${path}`);
    }
    if (basename(absolute) === 'QUEUE.yaml') {
      throw new Error('QUEUE.yaml is already a required locked artifact');
    }
    return absolute;
  });

  const projectPaths = BOOTSTRAP_LOCKED_FILES
    .filter((name) => name !== 'QUEUE.yaml')
    .map((name) => join(project.canonicalDirectory, name));
  const milestonePaths = milestone == null
    ? []
    : MILESTONE_LOCKED_FILES
      .filter((name) => name !== 'QUEUE.yaml')
      .map((name) => join(milestone.canonicalDirectory, name));
  const uniquePaths = [...new Set([...projectPaths, ...milestonePaths, ...additional])];
  const bundles = [];
  for (const path of uniquePaths) bundles.push(await readLockedArtifactBundle(project.canonicalRoot, path));
  bundles.sort((left, right) => left.snapshot.path.localeCompare(right.snapshot.path, 'en'));
  const byPath = new Map(bundles.map((bundle) => [bundle.snapshot.path, bundle]));

  const projectOriginPath = `${project.relativeDirectory}/ORIGIN.yaml`;
  const projectOrigin = validateOriginArtifact(byPath.get(projectOriginPath).bytes, projectOriginPath, {
    canonicalRoot: project.canonicalRoot,
    mode: 'bootstrap',
  });
  const projectId = projectOrigin.build.target_project;
  let milestoneId = null;
  let phaseDag = null;
  let openQuestionIds = [];
  let questions = [];
  if (milestone != null) {
    milestoneId = milestone.relativeDirectory.match(MILESTONE_CONTRACT_PATH)?.[1] ?? null;
    if (milestoneId == null) throw new Error('milestone directory does not contain a stable M-XX ID');
    const originPath = `${milestone.relativeDirectory}/ORIGIN.yaml`;
    validateOriginArtifact(byPath.get(originPath).bytes, originPath, {
      canonicalRoot: project.canonicalRoot,
      mode: 'milestone',
      projectId,
      milestoneId,
    });
    phaseDag = normalizeApprovalPhaseDag(milestonePhaseDag);
    const projectPath = (name) => `${project.relativeDirectory}/${name}`;
    validateProjectMarkdown(
      byPath.get(projectPath('PROJECT.md')).bytes.toString('utf8'),
      projectPath('PROJECT.md'),
      { projectId },
    );
    validateProjectRequirementsMarkdown(
      byPath.get(projectPath('REQUIREMENTS.md')).bytes.toString('utf8'),
      projectPath('REQUIREMENTS.md'),
      { milestoneId },
    );
    validateArchitectureMarkdown(
      byPath.get(projectPath('ARCHITECTURE.md')).bytes.toString('utf8'),
      projectPath('ARCHITECTURE.md'),
    );
    validateProjectRoadmapMarkdown(
      byPath.get(projectPath('ROADMAP.md')).bytes.toString('utf8'),
      projectPath('ROADMAP.md'),
      { milestoneId },
    );
    validateDecisionsMarkdown(
      byPath.get(projectPath('DECISIONS.md')).bytes.toString('utf8'),
      projectPath('DECISIONS.md'),
    );
    const milestonePath = (name) => `${milestone.relativeDirectory}/${name}`;
    validateMilestoneMarkdown(
      byPath.get(milestonePath('MILESTONE.md')).bytes.toString('utf8'),
      milestonePath('MILESTONE.md'),
      { milestoneId },
    );
    validateMilestoneRequirementsMarkdown(
      byPath.get(milestonePath('REQUIREMENTS.md')).bytes.toString('utf8'),
      milestonePath('REQUIREMENTS.md'),
      phaseDag,
    );
    validateMilestoneRoadmapMarkdown(
      byPath.get(milestonePath('ROADMAP.md')).bytes.toString('utf8'),
      milestonePath('ROADMAP.md'),
      phaseDag,
    );
    validateDecisionsMarkdown(
      byPath.get(milestonePath('DECISIONS.md')).bytes.toString('utf8'),
      milestonePath('DECISIONS.md'),
    );
    const questionsPath = `${milestone.relativeDirectory}/QUESTIONS.yaml`;
    const questionsArtifact = validateQuestionsArtifact(
      parseLockedYaml(byPath.get(questionsPath).bytes, questionsPath),
      questionsPath,
      { phaseIds: phaseDag.phase_ids },
    );
    openQuestionIds = questionsArtifact.open_question_ids;
    questions = questionsArtifact.questions;
    const autonomyPath = `${milestone.relativeDirectory}/AUTONOMY.yaml`;
    validateAutonomyArtifact(parseLockedYaml(byPath.get(autonomyPath).bytes, autonomyPath), autonomyPath);
  }

  const artifacts = bundles.map(({ snapshot }) => snapshot);
  const projectArtifacts = artifacts.filter(({ path }) => path.startsWith(`${project.relativeDirectory}/`));
  const projectContractDigest = contentContractDigest({
    mode: 'bootstrap',
    projectPath: project.relativeDirectory,
    milestonePath: null,
    artifacts: projectArtifacts,
    milestonePhaseDag: null,
  });
  const buildContractDigest = milestone == null
    ? projectContractDigest
    : contentContractDigest({
      mode,
      projectPath: project.relativeDirectory,
      milestonePath: milestone.relativeDirectory,
      artifacts,
      milestonePhaseDag: phaseDag,
    });
  return {
    canonical_root: project.canonicalRoot,
    project_path: project.relativeDirectory,
    milestone_path: milestone?.relativeDirectory ?? null,
    milestone_id: milestoneId,
    project_id: projectId,
    project_contract_digest: projectContractDigest,
    build_contract_digest: buildContractDigest,
    contract_artifacts: artifacts,
    milestone_phase_dag: phaseDag,
    open_question_ids: openQuestionIds,
    questions,
    additional_artifact_paths: extraNames,
    locked_contract_bundles: bundles,
  };
}

/** Compute the non-QUEUE digest that must be written into QUEUE.yaml before approval. */
export async function prepareBuildContractDigests(input = {}) {
  const draft = await inspectBuildContractDraft(input);
  const { locked_contract_bundles: ignored, ...publicDraft } = draft;
  void ignored;
  return deepFreeze(clone(publicDraft));
}

async function inspectBuildApprovalMaterial(input) {
  const draft = await inspectBuildContractDraft(input);
  const rootPaths = [draft.project_path, ...(draft.milestone_path == null ? [] : [draft.milestone_path])];
  const queueBundles = [];
  const queueSnapshots = [];
  const queueDefinitions = [];
  for (const rootPath of rootPaths) {
    const queuePath = `${rootPath}/QUEUE.yaml`;
    const bundle = await readLockedArtifactBundle(draft.canonical_root, resolve(draft.canonical_root, queuePath));
    const definition = validateWorkflowQueue(parseLockedYaml(bundle.bytes, queuePath));
    if (definition.queue.approved !== false || definition.queue.approved_at !== null) {
      throw new Error(`${queuePath} must remain an unmutated draft definition at approval capture`);
    }
    if (definition.queue.project_id !== draft.project_id) {
      throw new Error(`${queuePath} targets another project`);
    }
    const isMilestoneQueue = rootPath === draft.milestone_path;
    validateQueueCoordinationContract(definition, {
      milestonePhaseDag: isMilestoneQueue ? draft.milestone_phase_dag : null,
    });
    if (definition.queue.milestone_id !== (isMilestoneQueue ? draft.milestone_id : null)) {
      throw new Error(`${queuePath} milestone mapping is invalid`);
    }
    const originPath = `${rootPath}/ORIGIN.yaml`;
    const originArtifact = draft.contract_artifacts.find(({ path }) => path === originPath);
    if (definition.queue.origin_sha256 !== originArtifact.sha256) {
      throw new Error(`${queuePath} origin_sha256 does not match locked ${originPath}`);
    }
    const expectedContractDigest = isMilestoneQueue
      ? draft.build_contract_digest
      : draft.project_contract_digest;
    if (definition.queue.build_contract_digest !== expectedContractDigest) {
      throw new Error(`${queuePath} build_contract_digest does not match computed contract bytes`);
    }
    queueBundles.push(bundle);
    queueDefinitions.push({ path: queuePath, definition });
    queueSnapshots.push({
      path: queuePath,
      id: definition.queue.id,
      definition_sha256: workflowQueueDigest(definition),
      artifact_sha256: bundle.snapshot.sha256,
      build_contract_digest: definition.queue.build_contract_digest,
    });
  }
  const registryBundle = await readLockedArtifactBundle(
    draft.canonical_root,
    resolve(draft.canonical_root, BUILD_ID_REGISTRY_PATH),
  );
  const idRegistry = parseLockedYaml(registryBundle.bytes, BUILD_ID_REGISTRY_PATH);
  validateBuildIdRegistry(idRegistry);
  if (idRegistry.project_id !== draft.project_id) {
    throw new Error(`${BUILD_ID_REGISTRY_PATH} belongs to another project`);
  }
  const mutableStateSnapshots = [];
  if (input.validateMutableState !== false) {
    assertDigest(input.repositoryBaselineDigest, 'repositoryBaselineDigest');
    assertDigest(input.approvalReadinessDigest, 'approvalReadinessDigest');
    const stateDefinitions = [
      {
        rootPath: draft.project_path,
        kind: 'project',
        contractDigest: draft.project_contract_digest,
      },
      ...(draft.milestone_path == null ? [] : [{
        rootPath: draft.milestone_path,
        kind: 'milestone',
        contractDigest: draft.build_contract_digest,
      }]),
    ];
    for (const definition of stateDefinitions) {
      const statePath = `${definition.rootPath}/STATE.yaml`;
      const bundle = await readLockedArtifactBundle(
        draft.canonical_root,
        resolve(draft.canonical_root, statePath),
      );
      const state = parseLockedYaml(bundle.bytes, statePath);
      const originArtifact = draft.contract_artifacts.find(
        ({ path }) => path === `${definition.rootPath}/ORIGIN.yaml`,
      );
      const queueSnapshot = queueSnapshots.find(
        ({ path }) => path === `${definition.rootPath}/QUEUE.yaml`,
      );
      const bindings = {
        projectId: draft.project_id,
        milestoneId: draft.milestone_id,
        repositoryBaselineDigest: input.repositoryBaselineDigest,
        readinessDigest: input.approvalReadinessDigest,
        originSha256: originArtifact.sha256,
        contractDigest: definition.contractDigest,
        queueDefinitionSha256: queueSnapshot.definition_sha256,
      };
      if (definition.kind === 'project') {
        validateProjectStateArtifact(state, statePath, bindings);
      } else {
        validateMilestoneStateArtifact(state, statePath, {
          ...bindings,
          openQuestionIds: draft.open_question_ids,
          phaseIds: draft.milestone_phase_dag.phase_ids,
        });
      }
      mutableStateSnapshots.push({
        ...bundle.snapshot,
        state_digest: recordDigest(state),
      });
    }
  }
  const artifacts = [
    ...draft.contract_artifacts,
    ...queueBundles.map(({ snapshot }) => snapshot),
    registryBundle.snapshot,
  ].sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const lockedArtifacts = artifacts.map(({ path, sha256: digest }) => ({ path, sha256: digest }));
  const manifest = {
    schema_version: 1,
    project_path: draft.project_path,
    milestone_id: draft.milestone_id,
    milestone_path: draft.milestone_path,
    locked_artifacts: lockedArtifacts,
    contract_digest: milestoneContractDigest(lockedArtifacts),
  };
  const activeQueuePath = `${input.contractDirectory}/QUEUE.yaml`;
  const activeQueue = queueSnapshots.find(({ path }) => path === activeQueuePath);
  if (!activeQueue) throw new Error('active Build queue is absent from the locked manifest');
  return {
    draft,
    artifacts,
    manifest,
    queue_snapshots: queueSnapshots,
    queue_definitions: queueDefinitions,
    active_queue: activeQueue,
    mutable_state_snapshots: mutableStateSnapshots,
    id_registry: {
      path: BUILD_ID_REGISTRY_PATH,
      snapshot: registryBundle.snapshot,
      record: idRegistry,
    },
    locked_artifact_bundles: [
      ...draft.locked_contract_bundles,
      ...queueBundles,
      registryBundle,
    ],
  };
}

/**
 * Read-only full semantic validation for automatically generated Build drafts.
 * This validates contracts, both queues, mutable draft STATE, registry, and a
 * fresh product baseline without minting review or approval authority.
 */
export async function validateBuildDraftSemantics({
  root,
  mode,
  contractDirectory,
  repositoryBaselineDigest,
  approvalReadinessDigest = null,
  approvalReadiness = null,
  projectDirectory = PROJECT_CONTRACT_PATH,
  firstMilestoneDirectory = null,
  additionalArtifactPaths = [],
  milestonePhaseDag = null,
  buildOriginPairAuthority = null,
  buildIdHistoryAuthority = null,
} = {}) {
  assertDigest(repositoryBaselineDigest, 'repositoryBaselineDigest');
  await assertFreshProductRepositoryBaseline(root, repositoryBaselineDigest);
  const readinessAuthority = approvalReadiness == null
    ? null
    : requireBuildApprovalReadiness(approvalReadiness, mode);
  const readinessDigest = readinessAuthority?.readiness_digest ?? assertDigest(
    approvalReadinessDigest,
    'approvalReadinessDigest',
  );
  const material = await inspectBuildApprovalMaterial({
    root,
    mode,
    contractDirectory,
    projectDirectory,
    firstMilestoneDirectory,
    additionalArtifactPaths,
    milestonePhaseDag,
    repositoryBaselineDigest,
    approvalReadinessDigest: readinessDigest,
  });
  if (readinessAuthority !== null) {
    assertBuildApprovalReadinessBindings(
      readinessAuthority,
      material,
      repositoryBaselineDigest,
    );
  }
  if ((buildOriginPairAuthority == null) !== (buildIdHistoryAuthority == null)) {
    throw new Error('draft authority validation requires both Origin-pair and ID-history authority');
  }
  const authorityReceipts = buildOriginPairAuthority == null
    ? null
    : verifyBuildApprovalTrustAuthorities({
      material,
      buildOriginPairAuthority,
      buildIdHistoryAuthority,
    });
  const { locked_contract_bundles: ignored, ...publicDraft } = material.draft;
  void ignored;
  return deepFreeze({
    schema_version: 1,
    kind: 'cruise_validated_build_draft_semantics',
    valid: true,
    repository_baseline_digest: repositoryBaselineDigest,
    approval_readiness_digest: readinessDigest,
    draft: clone(publicDraft),
    artifacts: clone(material.artifacts),
    manifest: clone(material.manifest),
    queue_snapshots: clone(material.queue_snapshots),
    queue_definitions: clone(material.queue_definitions),
    mutable_state_snapshots: clone(material.mutable_state_snapshots),
    id_registry_snapshot: clone(material.id_registry.snapshot),
    build_authorities: authorityReceipts == null
      ? null
      : buildAuthoritySnapshot(authorityReceipts),
  });
}

function verifyBuildApprovalTrustAuthorities({
  material,
  buildOriginPairAuthority,
  buildIdHistoryAuthority,
} = {}) {
  const projectOrigin = material.artifacts.find(
    ({ path }) => path === `${material.draft.project_path}/ORIGIN.yaml`,
  );
  const milestoneOrigin = material.artifacts.find(
    ({ path }) => path === `${material.draft.milestone_path}/ORIGIN.yaml`,
  );
  if (!projectOrigin || !milestoneOrigin) {
    throw new Error('Build approval material lacks the locked project/milestone Origins');
  }
  const originPairReceipt = verifyBuildOriginPairAuthority(buildOriginPairAuthority, {
    repositoryRoot: material.draft.canonical_root,
    projectId: material.draft.project_id,
    milestoneId: material.draft.milestone_id,
    projectOriginSha256: projectOrigin.sha256,
    milestoneOriginSha256: milestoneOrigin.sha256,
  });
  const scanArtifacts = material.locked_artifact_bundles
    .filter(({ snapshot }) => snapshot.path !== BUILD_ID_REGISTRY_PATH)
    .map(({ snapshot, bytes }) => ({ path: snapshot.path, content: bytes }));
  const scanned = scanBuildIdentifiers(scanArtifacts);
  const recordsById = new Map(
    material.id_registry.record.records.map((record) => [record.id, record]),
  );
  const identities = scanned.map(({ id }) => {
    const record = recordsById.get(id);
    if (!record) throw new Error(`locked Build approval artifacts contain unregistered ID ${id}`);
    return { id, stable_key: record.stable_key, status: record.status };
  });
  const idHistoryReceipt = verifyValidatedBuildIdHistoryAuthority(
    buildIdHistoryAuthority,
    {
      buildOriginPairAuthority,
      registry: material.id_registry.record,
      artifacts: scanArtifacts,
      identities,
    },
  );
  return deepFreeze({
    origin_pair: originPairReceipt,
    id_history: idHistoryReceipt,
  });
}

function buildAuthoritySnapshot(receipts) {
  return {
    origin_pair: clone(receipts.origin_pair),
    id_history: clone(receipts.id_history),
  };
}

function lockedArtifactText(material, path) {
  const bundle = material.locked_artifact_bundles.find(
    ({ snapshot }) => snapshot.path === path,
  );
  if (!bundle) throw new Error(`review card cannot find locked artifact ${path}`);
  return bundle.bytes.toString('utf8');
}

function exactOutcomeSection(material, path, names) {
  const section = requireMarkdownSection(
    markdownSections(lockedArtifactText(material, path), path),
    names,
    path,
  );
  return {
    path,
    heading: section.heading,
    text: section.body,
    artifact_sha256: material.artifacts.find((artifact) => artifact.path === path)?.sha256,
  };
}

function queueReviewProjection({ path, definition }) {
  return {
    path,
    definition: clone(definition.queue),
    items: definition.items.map((item) => ({
      id: item.id,
      mandatory: item.mandatory,
      optional: !item.mandatory,
      skill: item.skill,
      status: item.status,
      mode: item.mode,
      phase: item.phase,
      purpose: item.purpose,
      scope: item.scope,
      requires: clone(item.requires),
      dependents: clone(item.dependents),
      consumes: clone(item.consumes),
      produces: clone(item.produces),
      acceptance_criteria: clone(item.acceptance_criteria),
      permissions_required: clone(item.permissions_required),
      capability_requirements: clone(item.capability_requirements),
      permitted_changes: clone(item.permitted_changes),
      prohibited_changes: clone(item.prohibited_changes),
      auto_start: item.auto_start,
      auto_start_conditions: clone(item.auto_start_conditions),
      parent_origin_sha256: item.parent_origin_sha256,
      child_origin_policy: item.child_origin_policy,
      blockers: clone(item.blockers),
      attempts: clone(item.attempts),
      result: item.result,
    })),
  };
}

function buildApprovalReviewCard({ mode, material, readinessSnapshot }) {
  const projectOutcomePath = `${material.draft.project_path}/PROJECT.md`;
  const milestoneOutcomePath = `${material.draft.milestone_path}/MILESTONE.md`;
  const phaseRoadmapPath = `${material.draft.milestone_path}/ROADMAP.md`;
  const queues = material.queue_definitions.map(queueReviewProjection);
  const queuedResearch = queues.flatMap((queue) => queue.items
    .filter(({ skill }) => skill === 'research')
    .map((item) => ({
      queue_path: queue.path,
      id: item.id,
      mandatory: item.mandatory,
      purpose: item.purpose,
      scope: item.scope,
      requires: clone(item.requires),
      consumes: clone(item.consumes),
      produces: clone(item.produces),
    })));
  const optionalQueueWork = queues.flatMap((queue) => queue.items
    .filter(({ optional }) => optional)
    .map(({ id, purpose, scope, auto_start: autoStart }) => ({
      queue_path: queue.path,
      id,
      purpose,
      scope,
      auto_start: autoStart,
    })));
  const evaluatedReadiness = readinessSnapshot.readiness;
  const normalizedReadiness = evaluatedReadiness.readiness;
  return deepFreeze({
    schema_version: 1,
    kind: 'cruise_build_approval_review_card',
    mode,
    repository_baseline_digest: readinessSnapshot.bindings.repository_baseline_digest,
    approval_readiness_digest: readinessSnapshot.readiness_digest,
    identities: {
      project_id: material.draft.project_id,
      milestone_id: material.draft.milestone_id,
      project_path: material.draft.project_path,
      milestone_path: material.draft.milestone_path,
      project_origin_sha256: material.artifacts.find(
        ({ path }) => path === `${material.draft.project_path}/ORIGIN.yaml`,
      ).sha256,
      milestone_origin_sha256: material.artifacts.find(
        ({ path }) => path === `${material.draft.milestone_path}/ORIGIN.yaml`,
      ).sha256,
      project_contract_digest: material.draft.project_contract_digest,
      build_contract_digest: material.draft.build_contract_digest,
      id_registry_sha256: material.id_registry.snapshot.sha256,
      id_registry_revision: material.id_registry.record.revision,
    },
    outcomes: {
      foundation: exactOutcomeSection(
        material,
        projectOutcomePath,
        ['Measurable project outcomes', 'Project outcomes'],
      ),
      milestone: exactOutcomeSection(
        material,
        milestoneOutcomePath,
        ['Outcome and beneficiary', 'Outcome'],
      ),
    },
    artifacts: material.artifacts.map(({ path, sha256: artifactSha256, bytes }) => ({
      path,
      sha256: artifactSha256,
      bytes,
    })),
    mutable_state_snapshots: clone(material.mutable_state_snapshots),
    phase_roadmap: {
      path: phaseRoadmapPath,
      artifact_sha256: material.artifacts.find(({ path }) => path === phaseRoadmapPath).sha256,
      phases: clone(material.draft.milestone_phase_dag.phases),
      completion_fence: clone(material.draft.milestone_phase_dag.completion_fence),
    },
    queues,
    research: {
      pre_approval_blockers: clone(normalizedReadiness.research_blockers),
      unresolved_research_questions: clone(
        readinessSnapshot.viability.unresolved.research_questions,
      ),
      queued_post_approval_research: queuedResearch,
    },
    deferred_or_open_work: {
      questions: clone(material.draft.questions.filter(({ status }) =>
        ['open', 'deferred'].includes(status))),
      phase_local_questions: clone(
        readinessSnapshot.viability.unresolved.phase_local_questions,
      ),
      user_decisions_required: clone(normalizedReadiness.user_decisions_required),
      optional_queue_items: optionalQueueWork,
    },
  });
}

function buildApprovalReviewDigest({
  mode,
  repositoryBaselineDigest,
  approvalReadinessDigest,
  material,
  authoritySnapshot,
  reviewCard,
}) {
  return recordDigest({
    schema_version: 1,
    kind: 'cruise_build_approval_review',
    mode,
    approval_label: approvalLabel(mode),
    repository_baseline_digest: repositoryBaselineDigest,
    approval_readiness_digest: approvalReadinessDigest,
    build_authorities: authoritySnapshot,
    review_card: reviewCard,
    artifacts: material.artifacts,
    manifest: material.manifest,
    queue_snapshots: material.queue_snapshots,
    active_queue: material.active_queue,
    mutable_state_snapshots: material.mutable_state_snapshots,
    milestone_phase_dag: material.draft.milestone_phase_dag,
  });
}

/**
 * Snapshot the exact review card before the approval option is shown. The
 * host must echo review_digest in its later structured selection event;
 * captureBuildApproval then rereads the files and rejects TOCTOU drift.
 */
export async function prepareBuildApprovalReview({
  root,
  mode,
  contractDirectory,
  repositoryBaselineDigest,
  projectDirectory = PROJECT_CONTRACT_PATH,
  firstMilestoneDirectory = null,
  additionalArtifactPaths = [],
  milestonePhaseDag = null,
  approvalReadiness,
  buildOriginPairAuthority,
  buildIdHistoryAuthority,
} = {}) {
  assertDigest(repositoryBaselineDigest, 'repositoryBaselineDigest');
  await assertFreshProductRepositoryBaseline(root, repositoryBaselineDigest);
  const readinessAuthority = requireBuildApprovalReadiness(approvalReadiness, mode);
  const material = await inspectBuildApprovalMaterial({
    root,
    mode,
    contractDirectory,
    projectDirectory,
    firstMilestoneDirectory,
    additionalArtifactPaths,
    milestonePhaseDag,
    repositoryBaselineDigest,
    approvalReadinessDigest: readinessAuthority.readiness_digest,
  });
  assertBuildApprovalReadinessBindings(
    readinessAuthority,
    material,
    repositoryBaselineDigest,
  );
  const authorityReceipts = verifyBuildApprovalTrustAuthorities({
    material,
    buildOriginPairAuthority,
    buildIdHistoryAuthority,
  });
  const authoritySnapshot = buildAuthoritySnapshot(authorityReceipts);
  const reviewCard = buildApprovalReviewCard({
    mode,
    material,
    readinessSnapshot: readinessAuthority,
  });
  return deepFreeze({
    schema_version: 1,
    kind: 'cruise_build_approval_review',
    mode,
    approval_label: approvalLabel(mode),
    repository_baseline_digest: repositoryBaselineDigest,
    approval_readiness_digest: readinessAuthority.readiness_digest,
    build_authorities: authoritySnapshot,
    review_card: reviewCard,
    review_digest: buildApprovalReviewDigest({
      mode,
      repositoryBaselineDigest,
      approvalReadinessDigest: readinessAuthority.readiness_digest,
      material,
      authoritySnapshot,
      reviewCard,
    }),
    artifacts: material.artifacts,
    manifest: material.manifest,
    queue_snapshots: material.queue_snapshots,
    mutable_state_snapshots: material.mutable_state_snapshots,
    milestone_phase_dag: material.draft.milestone_phase_dag,
  });
}

export async function captureBuildApproval({
  root,
  mode,
  contractDirectory,
  selectedLabel,
  approvalSelection,
  repositoryBaselineDigest,
  projectDirectory = PROJECT_CONTRACT_PATH,
  firstMilestoneDirectory = null,
  additionalArtifactPaths = [],
  milestonePhaseDag = null,
  approvalReadiness,
  buildOriginPairAuthority,
  buildIdHistoryAuthority,
  now = () => new Date(),
} = {}) {
  if (selectedLabel !== undefined) {
    throw new Error('typed/free-text selectedLabel cannot mint Build approval');
  }
  const selection = requireBuildApprovalSelection(approvalSelection, mode);
  const readinessAuthority = requireBuildApprovalReadiness(approvalReadiness, mode);
  assertDigest(repositoryBaselineDigest, 'repositoryBaselineDigest');
  await assertFreshProductRepositoryBaseline(root, repositoryBaselineDigest);
  const material = await inspectBuildApprovalMaterial({
    root,
    mode,
    contractDirectory,
    projectDirectory,
    firstMilestoneDirectory,
    additionalArtifactPaths,
    milestonePhaseDag,
    repositoryBaselineDigest,
    approvalReadinessDigest: readinessAuthority.readiness_digest,
  });
  assertBuildApprovalReadinessBindings(
    readinessAuthority,
    material,
    repositoryBaselineDigest,
  );
  const authorityReceipts = verifyBuildApprovalTrustAuthorities({
    material,
    buildOriginPairAuthority,
    buildIdHistoryAuthority,
  });
  const authoritySnapshot = buildAuthoritySnapshot(authorityReceipts);
  const reviewCard = buildApprovalReviewCard({
    mode,
    material,
    readinessSnapshot: readinessAuthority,
  });
  const reviewDigest = buildApprovalReviewDigest({
    mode,
    repositoryBaselineDigest,
    approvalReadinessDigest: readinessAuthority.readiness_digest,
    material,
    authoritySnapshot,
    reviewCard,
  });
  if (selection.review_digest !== reviewDigest) {
    throw new Error(
      'Build artifacts or queue bytes changed after the displayed approval review',
    );
  }
  const approvalDigest = recordDigest({
    mode,
    selection: selectionSnapshot(selection),
    repository_baseline_digest: repositoryBaselineDigest,
    approval_readiness_digest: readinessAuthority.readiness_digest,
    build_authorities: authoritySnapshot,
    review_card: reviewCard,
    build_contract_digest: material.draft.build_contract_digest,
    manifest_contract_digest: material.manifest.contract_digest,
    queue_snapshots: material.queue_snapshots,
    mutable_state_snapshots: material.mutable_state_snapshots,
    milestone_phase_dag: material.draft.milestone_phase_dag,
  });
  return deepFreeze({
    schema_version: 1,
    kind: 'cruise_build_approval',
    mode,
    selected_label: selection.selected_label,
    approval_selection: selectionSnapshot(selection),
    review_digest: reviewDigest,
    approval_readiness: clone(readinessAuthority),
    approval_readiness_digest: readinessAuthority.readiness_digest,
    build_authorities: authoritySnapshot,
    review_card: reviewCard,
    contract_directory: contractDirectory,
    repository_baseline_digest: repositoryBaselineDigest,
    additional_artifact_paths: material.draft.additional_artifact_paths,
    artifacts: material.artifacts,
    build_contract_digest: material.draft.build_contract_digest,
    project_contract_digest: material.draft.project_contract_digest,
    queue_sha256: material.active_queue.artifact_sha256,
    queue_snapshots: material.queue_snapshots,
    mutable_state_snapshots: material.mutable_state_snapshots,
    manifest: material.manifest,
    milestone_phase_dag: material.draft.milestone_phase_dag,
    approval_digest: approvalDigest,
    captured_at: nowIso(now),
  });
}

export async function verifyBuildApproval({
  root,
  approval,
  approvalSelection,
  currentRepositoryBaselineDigest,
  buildOriginPairAuthority,
  buildIdHistoryAuthority,
} = {}) {
  if (!isPlainObject(approval) || approval.kind !== 'cruise_build_approval') {
    throw new Error('Build approval snapshot is missing');
  }
  if (approval.selected_label !== approvalLabel(approval.mode)) {
    throw new Error('Build approval label is not exact');
  }
  const selection = requireBuildApprovalSelection(approvalSelection, approval.mode);
  if (canonicalJson(selectionSnapshot(selection)) !== canonicalJson(approval.approval_selection)) {
    throw new Error('trusted structured approval selection does not match the persisted snapshot');
  }
  assertDigest(currentRepositoryBaselineDigest, 'currentRepositoryBaselineDigest');
  await assertFreshProductRepositoryBaseline(root, currentRepositoryBaselineDigest);
  if (approval.repository_baseline_digest !== currentRepositoryBaselineDigest) {
    throw new Error('target repository baseline changed after Build approval');
  }
  const material = await inspectBuildApprovalMaterial({
    root,
    mode: approval.mode,
    contractDirectory: approval.contract_directory,
    projectDirectory: approval.manifest?.project_path,
    firstMilestoneDirectory: approval.mode === 'bootstrap' ? approval.manifest?.milestone_path : null,
    additionalArtifactPaths: approval.additional_artifact_paths ?? [],
    milestonePhaseDag: approval.milestone_phase_dag?.phases ?? null,
    repositoryBaselineDigest: currentRepositoryBaselineDigest,
    approvalReadinessDigest: approval.approval_readiness_digest,
  });
  const readinessSnapshot = approval.approval_readiness;
  if (
    !isPlainObject(readinessSnapshot) ||
    readinessSnapshot.kind !== 'cruise_build_approval_readiness' ||
    readinessSnapshot.mode !== approval.mode ||
    readinessSnapshot.repository?.mode_candidate !== approval.mode ||
    readinessSnapshot.readiness?.discovery_required !== false ||
    readinessSnapshot.viability?.outcome !== 'ready_for_build'
  ) {
    throw new Error('persisted Build readiness/viability snapshot is invalid');
  }
  const {
    readiness_digest: persistedReadinessDigest,
    ...readinessPayload
  } = readinessSnapshot;
  if (
    persistedReadinessDigest !== recordDigest(readinessPayload) ||
    persistedReadinessDigest !== approval.approval_readiness_digest
  ) {
    throw new Error('persisted Build readiness/viability digest is invalid');
  }
  const authorityReceipts = verifyBuildApprovalTrustAuthorities({
    material,
    buildOriginPairAuthority,
    buildIdHistoryAuthority,
  });
  const authoritySnapshot = buildAuthoritySnapshot(authorityReceipts);
  const reviewCard = buildApprovalReviewCard({
    mode: approval.mode,
    material,
    readinessSnapshot,
  });
  const approvalDigest = recordDigest({
    mode: approval.mode,
    selection: selectionSnapshot(selection),
    repository_baseline_digest: currentRepositoryBaselineDigest,
    approval_readiness_digest: persistedReadinessDigest,
    build_contract_digest: material.draft.build_contract_digest,
    manifest_contract_digest: material.manifest.contract_digest,
    queue_snapshots: material.queue_snapshots,
    mutable_state_snapshots: material.mutable_state_snapshots,
    milestone_phase_dag: material.draft.milestone_phase_dag,
    build_authorities: authoritySnapshot,
    review_card: reviewCard,
  });
  const reviewDigest = buildApprovalReviewDigest({
    mode: approval.mode,
    repositoryBaselineDigest: currentRepositoryBaselineDigest,
    approvalReadinessDigest: persistedReadinessDigest,
    material,
    authoritySnapshot,
    reviewCard,
  });
  if (
    canonicalJson(material.artifacts) !== canonicalJson(approval.artifacts) ||
    canonicalJson(material.manifest) !== canonicalJson(approval.manifest) ||
    canonicalJson(material.queue_snapshots) !== canonicalJson(approval.queue_snapshots) ||
    canonicalJson(material.mutable_state_snapshots) !==
      canonicalJson(approval.mutable_state_snapshots) ||
    canonicalJson(authoritySnapshot) !== canonicalJson(approval.build_authorities) ||
    canonicalJson(reviewCard) !== canonicalJson(approval.review_card) ||
    material.draft.build_contract_digest !== approval.build_contract_digest ||
    material.active_queue.artifact_sha256 !== approval.queue_sha256 ||
    approval.review_digest !== reviewDigest ||
    approval.approval_selection.review_digest !== reviewDigest ||
    approvalDigest !== approval.approval_digest
  ) {
    throw new Error('Build approval digest is stale or invalid');
  }
  const receipt = deepFreeze({
    kind: 'cruise_verified_build_approval',
    valid: true,
    mode: approval.mode,
    label: approval.selected_label,
    approved_at: approval.approval_selection.selected_at,
    review_digest: reviewDigest,
    approval_readiness: deepFreeze(clone(readinessSnapshot)),
    approval_readiness_digest: persistedReadinessDigest,
    build_authorities: deepFreeze(clone(authoritySnapshot)),
    review_card: deepFreeze(clone(reviewCard)),
    approval_digest: approvalDigest,
    build_contract_digest: approval.build_contract_digest,
    repository_baseline_digest: currentRepositoryBaselineDigest,
    artifacts: material.artifacts,
    manifest: material.manifest,
    active_queue: material.active_queue,
    queue_snapshots: material.queue_snapshots,
    mutable_state_snapshots: material.mutable_state_snapshots,
    milestone_phase_dag: material.draft.milestone_phase_dag,
    build_origin_pair_authority: buildOriginPairAuthority,
    build_id_history_authority: buildIdHistoryAuthority,
  });
  VERIFIED_BUILD_APPROVALS.add(receipt);
  return receipt;
}

function buildArtifactReverificationInput(root, receipt) {
  const projectPath = receipt.manifest?.project_path;
  const milestonePath = receipt.manifest?.milestone_path ?? null;
  const contractDirectory = dirname(receipt.active_queue?.path ?? '');
  if (
    typeof projectPath !== 'string' ||
    contractDirectory === '.' ||
    (receipt.mode === 'milestone' && typeof milestonePath !== 'string')
  ) {
    throw new Error('verified Build receipt lacks its canonical contract paths');
  }
  const requiredPaths = new Set(
    [
      ...BOOTSTRAP_LOCKED_FILES.map((name) => `${projectPath}/${name}`),
      BUILD_ID_REGISTRY_PATH,
      ...(milestonePath == null
        ? []
        : MILESTONE_LOCKED_FILES.map((name) => `${milestonePath}/${name}`)),
    ],
  );
  const contractRoot = resolve(root, contractDirectory);
  const additionalArtifactPaths = receipt.artifacts
    .map(({ path }) => path)
    .filter((path) => !requiredPaths.has(path))
    .map((path) => portable(relative(contractRoot, resolve(root, path))));
  if (
    additionalArtifactPaths.some(
      (path) => !path || path === '..' || path.startsWith('../'),
    )
  ) {
    throw new Error('verified Build receipt contains an artifact outside its contract directory');
  }
  return {
    root,
    mode: receipt.mode,
    contractDirectory,
    projectDirectory: projectPath,
    firstMilestoneDirectory: receipt.mode === 'bootstrap' ? milestonePath : null,
    additionalArtifactPaths,
    milestonePhaseDag: receipt.milestone_phase_dag?.phases ?? null,
    validateMutableState: false,
  };
}

/**
 * Re-read the locked Build artifacts without requiring the product tree to
 * equal its pre-execution baseline. Queue execution advances the product
 * baseline separately; this attestation proves only that Build authority did
 * not drift while approved work was running.
 */
export async function verifyBuildApprovalArtifacts({
  root,
  verifiedBuildApproval,
  now = () => new Date(),
} = {}) {
  const receipt = requireVerifiedBuildApproval(verifiedBuildApproval);
  const material = await inspectBuildApprovalMaterial(
    buildArtifactReverificationInput(root, receipt),
  );
  if (
    canonicalJson(material.artifacts) !== canonicalJson(receipt.artifacts) ||
    canonicalJson(material.manifest) !== canonicalJson(receipt.manifest) ||
    canonicalJson(material.queue_snapshots) !== canonicalJson(receipt.queue_snapshots) ||
    canonicalJson(material.active_queue) !== canonicalJson(receipt.active_queue) ||
    canonicalJson(material.draft.milestone_phase_dag) !==
      canonicalJson(receipt.milestone_phase_dag) ||
    material.draft.build_contract_digest !== receipt.build_contract_digest
  ) {
    throw new Error('locked Build artifacts or queue bytes changed after approval');
  }
  const attestation = deepFreeze({
    kind: 'cruise_verified_build_artifact_snapshot',
    approval_digest: receipt.approval_digest,
    build_contract_digest: receipt.build_contract_digest,
    manifest_contract_digest: receipt.manifest.contract_digest,
    queue_definition_sha256: receipt.active_queue.definition_sha256,
    verified_at: nowIso(now),
  });
  VERIFIED_BUILD_ARTIFACT_SNAPSHOTS.set(attestation, receipt);
  return attestation;
}

export function isVerifiedBuildApprovalArtifactSnapshot(
  value,
  { verifiedBuildApproval } = {},
) {
  return (
    isPlainObject(value) &&
    VERIFIED_BUILD_ARTIFACT_SNAPSHOTS.get(value) === verifiedBuildApproval &&
    value.approval_digest === verifiedBuildApproval?.approval_digest &&
    value.manifest_contract_digest === verifiedBuildApproval?.manifest?.contract_digest &&
    value.queue_definition_sha256 === verifiedBuildApproval?.active_queue?.definition_sha256
  );
}

/**
 * Re-read every locked artifact synchronously at a final launch/write boundary.
 * The opaque snapshot proves who requested this check; it is not a lease over
 * bytes that may have changed since the asynchronous review completed.
 */
export function assertVerifiedBuildApprovalArtifactsCurrent({
  root,
  verifiedBuildApproval,
  artifactSnapshot,
} = {}) {
  const receipt = requireVerifiedBuildApproval(verifiedBuildApproval);
  if (!isVerifiedBuildApprovalArtifactSnapshot(artifactSnapshot, {
    verifiedBuildApproval: receipt,
  })) {
    throw new Error('current locked Build bytes require an opaque artifact snapshot');
  }
  const requestedRoot = resolve(nonEmpty(root, 'root'));
  const canonicalRoot = realpathSync(requestedRoot);
  if (
    canonicalRoot !== requestedRoot ||
    receipt.approval_readiness?.bindings?.repository_root !== canonicalRoot
  ) {
    throw new Error('locked Build artifact check belongs to another repository root');
  }
  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length === 0) {
    throw new Error('verified Build approval has no locked artifact manifest');
  }
  for (const artifact of receipt.artifacts) {
    const relativePath = safeQueueRelativePath(
      artifact?.path,
      'locked Build artifact path',
    );
    assertDigest(artifact?.sha256, `${relativePath} sha256`);
    if (!Number.isSafeInteger(artifact?.bytes) || artifact.bytes < 0) {
      throw new Error(`${relativePath} byte length is invalid`);
    }
    const requested = resolve(canonicalRoot, relativePath);
    const relativeRequested = portable(relative(canonicalRoot, requested));
    if (
      relativeRequested !== relativePath ||
      requested === canonicalRoot ||
      !requested.startsWith(`${canonicalRoot}${sep}`)
    ) {
      throw new Error(`${relativePath} escapes the approved repository root`);
    }
    let descriptor;
    try {
      const beforePath = lstatSync(requested);
      if (
        !beforePath.isFile() ||
        beforePath.isSymbolicLink() ||
        beforePath.size !== artifact.bytes ||
        realpathSync(requested) !== requested
      ) {
        throw new Error('not the approved regular no-follow file');
      }
      descriptor = openSync(
        requested,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || !sameFileIdentity(beforePath, opened)) {
        throw new Error('identity changed before read');
      }
      const bytes = readFileSync(descriptor);
      const afterRead = fstatSync(descriptor);
      const afterPath = lstatSync(requested);
      if (
        !sameFileIdentity(opened, afterRead) ||
        !sameFileIdentity(afterRead, afterPath) ||
        afterPath.isSymbolicLink() ||
        realpathSync(requested) !== requested ||
        bytes.length !== artifact.bytes ||
        sha256(bytes) !== artifact.sha256
      ) {
        throw new Error('identity or exact bytes changed during read');
      }
    } catch (error) {
      throw new Error(`locked Build artifact ${relativePath} is stale or unsafe`, {
        cause: error,
      });
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  return true;
}
