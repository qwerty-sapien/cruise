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
import { isAbsolute, parse, resolve, sep } from 'node:path';

import { validateEvidenceRecord } from './evidence.mjs';
import {
  isVerifiedBuildApproval,
  isVerifiedBuildApprovalArtifactSnapshot,
} from './build-contract.mjs';
import { canonicalJson } from './yaml-state.mjs';
import {
  isMilestoneControllerAuthority,
  isMilestoneControllerStateProvenance,
  milestoneContractDigest,
  readMilestoneControllerAuthority,
  validateDangerousQuestionSuppression,
  validateMilestoneControllerState,
} from './milestone-controller.mjs';

/**
 * The only actors accepted by this public-workflow policy. The private
 * provisioner has its own internal adapter and is deliberately absent here.
 */
export const PUBLIC_SKILLS = Object.freeze([
  'build',
  'quick',
  'refine',
  'goal',
  'debug',
  'research',
]);

export const WRITE_CLASSES = Object.freeze([
  'product',
  'dependency',
  'lockfile',
  'fixture',
  'snapshot',
  'generated_source',
  'formatting',
  'report',
  'machine',
]);

export const REASON_CODES = Object.freeze({
  ALLOW_EFFECT: 'WP_ALLOW_EFFECT',
  ALLOW_PATH: 'WP_ALLOW_PATH',
  ALLOW_PHASE: 'WP_ALLOW_PHASE',
  ALLOW_REPOSITORY_PATH: 'WP_ALLOW_REPOSITORY_PATH',
  DENY_DEBUG_CAUSAL_SCOPE: 'WP_DENY_DEBUG_CAUSAL_SCOPE',
  DENY_DEBUG_EVIDENCE: 'WP_DENY_DEBUG_EVIDENCE',
  DENY_DEBUG_ROOT_CAUSE: 'WP_DENY_DEBUG_ROOT_CAUSE',
  DENY_BUILD_DOCUMENTATION_APPROVAL: 'WP_DENY_BUILD_DOCUMENTATION_APPROVAL',
  DENY_BUILD_DOCUMENTATION_SCOPE: 'WP_DENY_BUILD_DOCUMENTATION_SCOPE',
  DENY_EFFECT_BOUNDARY: 'WP_DENY_EFFECT_BOUNDARY',
  DENY_EFFECT_KIND: 'WP_DENY_EFFECT_KIND',
  DENY_EFFECT_PERMISSION: 'WP_DENY_EFFECT_PERMISSION',
  DENY_EFFECT_PERMISSION_ID: 'WP_DENY_EFFECT_PERMISSION_ID',
  DENY_EFFECT_SCOPE: 'WP_DENY_EFFECT_SCOPE',
  DENY_EXTERNAL_REPORT_APPROVAL: 'WP_DENY_EXTERNAL_REPORT_APPROVAL',
  DENY_GOAL_CLOSEOUT_INACTIVE: 'WP_DENY_GOAL_CLOSEOUT_INACTIVE',
  DENY_GOAL_CONTROLLER_CONTEXT: 'WP_DENY_GOAL_CONTROLLER_CONTEXT',
  DENY_GOAL_CONTROLLER_LOCKED_ARTIFACT: 'WP_DENY_GOAL_CONTROLLER_LOCKED_ARTIFACT',
  DENY_GOAL_CONTROLLER_SCOPE: 'WP_DENY_GOAL_CONTROLLER_SCOPE',
  DENY_GOAL_FALLBACK_UNAPPROVED: 'WP_DENY_GOAL_FALLBACK_UNAPPROVED',
  DENY_GOAL_INACTIVE: 'WP_DENY_GOAL_INACTIVE',
  DENY_GOAL_OWNERSHIP: 'WP_DENY_GOAL_OWNERSHIP',
  DENY_GOAL_ARTIFACT: 'WP_DENY_GOAL_ARTIFACT',
  DENY_GOAL_PLAN_UNAPPROVED: 'WP_DENY_GOAL_PLAN_UNAPPROVED',
  DENY_GOAL_POST_START_WRITE: 'WP_DENY_GOAL_POST_START_WRITE',
  DENY_GOAL_START_UNAPPROVED: 'WP_DENY_GOAL_START_UNAPPROVED',
  DENY_INTERNAL_PATH: 'WP_DENY_INTERNAL_PATH',
  DENY_INVALID_REQUEST: 'WP_DENY_INVALID_REQUEST',
  DENY_PATH_ABSOLUTE: 'WP_DENY_PATH_ABSOLUTE',
  DENY_PATH_EMPTY: 'WP_DENY_PATH_EMPTY',
  DENY_PATH_INVALID: 'WP_DENY_PATH_INVALID',
  DENY_PATH_OUTSIDE_REPOSITORY: 'WP_DENY_PATH_OUTSIDE_REPOSITORY',
  DENY_PATH_SYMLINK: 'WP_DENY_PATH_SYMLINK',
  DENY_PATH_TRAVERSAL: 'WP_DENY_PATH_TRAVERSAL',
  DENY_PRIVATE_PROVISION_REQUIRED: 'WP_DENY_PRIVATE_PROVISION_REQUIRED',
  DENY_PHASE_TRANSITION: 'WP_DENY_PHASE_TRANSITION',
  DENY_QUICK_HARD_PROMOTION: 'WP_DENY_QUICK_HARD_PROMOTION',
  DENY_QUICK_NOT_ADMITTED: 'WP_DENY_QUICK_NOT_ADMITTED',
  DENY_QUICK_REPAIR_LEDGER: 'WP_DENY_QUICK_REPAIR_LEDGER',
  DENY_QUICK_SCOPE: 'WP_DENY_QUICK_SCOPE',
  DENY_REFINE_OWNERSHIP: 'WP_DENY_REFINE_OWNERSHIP',
  DENY_REFINE_PLAN_UNAPPROVED: 'WP_DENY_REFINE_PLAN_UNAPPROVED',
  DENY_REVIEW_RESEARCH_EFFECT: 'WP_DENY_REVIEW_RESEARCH_EFFECT',
  DENY_REVIEW_RESEARCH_WRITE: 'WP_DENY_REVIEW_RESEARCH_WRITE',
  DENY_SCOPE_INVALID: 'WP_DENY_SCOPE_INVALID',
  DENY_SCOPE_UNDECLARED: 'WP_DENY_SCOPE_UNDECLARED',
  DENY_UNKNOWN_PHASE: 'WP_DENY_UNKNOWN_PHASE',
  DENY_UNKNOWN_SKILL: 'WP_DENY_UNKNOWN_SKILL',
  DENY_WRITE_CLASS: 'WP_DENY_WRITE_CLASS',
  DENY_WRITE_CLASS_PATH_MISMATCH: 'WP_DENY_WRITE_CLASS_PATH_MISMATCH',
});

const SKILL_SET = new Set(PUBLIC_SKILLS);
const WRITE_CLASS_SET = new Set(WRITE_CLASSES);
const PRODUCT_WRITE_CLASSES = new Set([
  'product',
  'dependency',
  'lockfile',
  'fixture',
  'snapshot',
  'generated_source',
  'formatting',
]);
const PLANNING_ONLY = new Set(['build', 'research']);
const INTERNAL_EFFECT_KINDS = new Set([
  'capability_resolution_request',
  'repository_read',
  'repository_analysis',
  'repository_test',
  'internal_state_write',
  'temporary_workspace_write',
]);
const EXTERNAL_EFFECT_KINDS = new Set([
  'browser_interaction',
  'capability_install',
  'credential_use',
  'deploy',
  'external_filesystem_write',
  'filesystem_write',
  'git_commit',
  'git_push',
  'message',
  'network_request',
  'package_install',
  'paid_compute',
  'publish',
  'remote_api_read',
  'remote_api_write',
]);
const PERMISSION_ID = /^D-\d{2,}$/u;
const EVIDENCE_ID = /^E-\d{2,}$/u;
const HYPOTHESIS_ID = /^H-\d{2,}$/u;
const CAPABILITY_ID = /^CAP-[A-Z0-9][A-Z0-9-]*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/u;
const GOAL_PREFIX = '.cruise/goal/';
const CLOSEOUT_PATH = '.cruise/goal/CLOSEOUT.md';
const MILESTONE_ID = /^M-\d{2,}$/u;
const PHASE_ID = /^P-\d{2,}$/u;
const MILESTONE_ROOT = /^\.cruise\/milestones\/(M-\d{2,})-[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const CONTROLLER_PHASE_MACHINE_FILES = new Set([
  'ORIGIN.yaml',
  'QUESTIONS.yaml',
  'ATTEMPTS.yaml',
  'EVIDENCE.yaml',
]);
const CONTROLLER_PHASE_REPORT_FILES = new Set(['PLAN.md', 'CLOSEOUT.md']);
const CONTROLLER_MUTABLE_MILESTONE_FILES = new Set([
  'STATE.yaml',
  'QUEUE-STATE.yaml',
  'MILESTONE-EVIDENCE.yaml',
]);
const REQUIRED_PROJECT_CONTRACT_FILES = Object.freeze([
  'ORIGIN.yaml',
  'PROJECT.md',
  'REQUIREMENTS.md',
  'ARCHITECTURE.md',
  'ROADMAP.md',
  'DECISIONS.md',
  'ID-REGISTRY.yaml',
  'QUEUE.yaml',
]);
const REQUIRED_MILESTONE_CONTRACT_FILES = Object.freeze([
  'ORIGIN.yaml',
  'MILESTONE.md',
  'REQUIREMENTS.md',
  'ROADMAP.md',
  'DECISIONS.md',
  'QUESTIONS.yaml',
  'AUTONOMY.yaml',
  'QUEUE.yaml',
]);
const GOAL_ARTIFACTS = new Set([
  '.cruise/goal/ORIGIN.yaml',
  '.cruise/goal/SPEC.md',
  '.cruise/goal/DECISIONS.md',
  '.cruise/goal/ALIGNMENT.md',
  '.cruise/goal/ROADMAP.md',
  '.cruise/goal/PLAN.md',
  '.cruise/goal/MILESTONE-CONTROLLER.yaml',
  '.cruise/goal/GOAL.md',
  CLOSEOUT_PATH,
]);
const PLAN_LOCKED_ARTIFACTS = new Set([
  '.cruise/goal/ORIGIN.yaml',
  '.cruise/goal/SPEC.md',
  '.cruise/goal/DECISIONS.md',
  '.cruise/goal/ALIGNMENT.md',
  '.cruise/goal/ROADMAP.md',
  '.cruise/goal/PLAN.md',
  '.cruise/goal/MILESTONE-CONTROLLER.yaml',
]);
const READ_ONLY_FORBIDDEN_EFFECTS = new Set([
  'deploy',
  'filesystem_write',
  'git_commit',
  'git_push',
  'message',
  'package_install',
  'publish',
  'remote_api_write',
]);
const QUICK_FORBIDDEN_EFFECTS = new Set([
  ...READ_ONLY_FORBIDDEN_EFFECTS,
  'capability_install',
  'credential_use',
  'external_filesystem_write',
  'paid_compute',
]);

const PHASE_TRANSITIONS = Object.freeze({
  quick: Object.freeze({
    '<start>': ['capture_origin'],
    capture_origin: ['probe'],
    probe: ['classify'],
    classify: ['admit'],
    admit: ['micro_plan'],
    micro_plan: ['execute'],
    execute: ['repair', 'verify', 'promote'],
    repair: ['execute', 'promote'],
    promote: ['close'],
    verify: ['close'],
    close: [],
  }),
  refine: Object.freeze({
    '<start>': ['capture_origin'],
    capture_origin: ['probe'],
    probe: ['classify'],
    classify: ['clarify', 'plan'],
    clarify: ['clarify', 'plan'],
    plan: ['plan_approval'],
    plan_approval: ['execute', 'plan'],
    execute: ['verify', 'plan'],
    verify: ['close', 'plan'],
    close: [],
  }),
  goal: Object.freeze({
    '<start>': ['capture_origin'],
    capture_origin: ['probe'],
    probe: ['classify'],
    classify: ['clarify', 'plan'],
    clarify: ['clarify', 'plan'],
    plan: ['plan_approval'],
    plan_approval: ['goal_contract', 'reconcile'],
    goal_contract: ['start_approval', 'fallback_approval', 'reconcile'],
    start_approval: ['activation', 'reconcile'],
    fallback_approval: ['fallback_activation', 'reconcile'],
    reconcile: ['plan', 'goal_contract'],
    activation: ['execute'],
    fallback_activation: ['execute'],
    execute: ['verify'],
    verify: ['closeout'],
    closeout: ['close'],
    close: [],
  }),
  debug: Object.freeze({
    '<start>': ['capture_origin'],
    capture_origin: ['probe'],
    probe: ['classify'],
    classify: ['reproduce'],
    reproduce: ['diagnose'],
    diagnose: ['diagnose', 'root_cause'],
    root_cause: ['repair'],
    repair: ['verify', 'diagnose'],
    verify: ['close', 'diagnose'],
    close: [],
  }),
  build: Object.freeze({
    '<start>': ['capture_origin'],
    capture_origin: ['probe'],
    probe: ['classify'],
    classify: ['inspect'],
    inspect: ['select_mode'],
    select_mode: ['readiness', 'mode_question'],
    mode_question: ['readiness'],
    readiness: ['discovery', 'draft', 'research_wait', 'defer', 'not_viable'],
    discovery: ['discovery', 'draft', 'research_wait', 'defer', 'not_viable'],
    research_wait: ['readiness'],
    draft: ['validate'],
    validate: ['draft', 'approval'],
    approval: ['draft', 'close'],
    defer: ['close'],
    not_viable: ['close'],
    close: [],
  }),
  research: Object.freeze({
    '<start>': ['capture_origin'],
    capture_origin: ['probe'],
    probe: ['classify'],
    classify: ['inspect'],
    inspect: ['acquire'],
    acquire: ['acquire', 'synthesize'],
    synthesize: ['report'],
    report: ['close'],
    close: [],
  }),
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

function decision(allowed, code, reason, details = {}) {
  return deepFreeze({ allowed, code, reason, ...details });
}

function allow(code, reason, details = {}) {
  return decision(true, code, reason, details);
}

function deny(code, reason, details = {}) {
  return decision(false, code, reason, details);
}

function validSkill(skill) {
  return typeof skill === 'string' && SKILL_SET.has(skill);
}

function portable(path) {
  return path.split(sep).join('/');
}

function hasTraversal(path) {
  return String(path).replaceAll('\\', '/').split('/').includes('..');
}

function looksAbsolute(path) {
  return isAbsolute(path) || WINDOWS_ABSOLUTE.test(path);
}

function inspectRepositoryPath(canonicalRoot, segments, { fileTarget = false } = {}) {
  let current = canonicalRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]);
    let metadata;
    try {
      metadata = lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      return deny(
        REASON_CODES.DENY_PATH_INVALID,
        'The candidate path could not be inspected safely.',
      );
    }
    if (metadata.isSymbolicLink()) {
      return deny(
        REASON_CODES.DENY_PATH_SYMLINK,
        'A candidate path component is a symbolic link; the policy will not assume its write target.',
      );
    }
    if (index < segments.length - 1 && !metadata.isDirectory()) {
      return deny(
        REASON_CODES.DENY_PATH_INVALID,
        'An intermediate candidate path component is not a directory.',
      );
    }
    if (fileTarget && index === segments.length - 1 && metadata.isDirectory()) {
      return deny(
        REASON_CODES.DENY_PATH_INVALID,
        'A bounded write target must identify one file, not a directory tree.',
      );
    }
  }
  return null;
}

/**
 * Normalize a repository-relative path without mutating the filesystem.
 * Existing components must not be symlinks. Callers must still use no-follow
 * writes and recheck the boundary immediately before the actual mutation.
 */
export function normalizeRepositoryRelativePath({ repositoryRoot, path } = {}) {
  if (typeof repositoryRoot !== 'string' || repositoryRoot.trim() === '') {
    return deny(REASON_CODES.DENY_INVALID_REQUEST, 'repositoryRoot must be a non-empty string.');
  }
  if (typeof path !== 'string' || path.trim() === '') {
    return deny(REASON_CODES.DENY_PATH_EMPTY, 'A non-empty repository-relative path is required.');
  }
  if (path.includes('\0')) {
    return deny(REASON_CODES.DENY_PATH_INVALID, 'Paths containing NUL bytes are forbidden.');
  }
  if (looksAbsolute(path)) {
    return deny(REASON_CODES.DENY_PATH_ABSOLUTE, 'Repository write paths must be relative.');
  }
  if (hasTraversal(path)) {
    return deny(REASON_CODES.DENY_PATH_TRAVERSAL, 'Parent-directory traversal is forbidden.');
  }

  const normalizedInput = path.normalize('NFC').replaceAll('\\', '/');
  const segments = normalizedInput.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) {
    return deny(REASON_CODES.DENY_PATH_EMPTY, 'The path must identify a file below the repository root.');
  }

  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(resolve(repositoryRoot));
    if (!lstatSync(canonicalRoot).isDirectory()) {
      return deny(REASON_CODES.DENY_INVALID_REQUEST, 'repositoryRoot must resolve to a directory.');
    }
  } catch {
    return deny(REASON_CODES.DENY_INVALID_REQUEST, 'repositoryRoot must resolve to an existing directory.');
  }

  const absolutePath = resolve(canonicalRoot, ...segments);
  const relativePath = portable(absolutePath.slice(canonicalRoot.length).replace(/^[/\\]+/u, ''));
  if (
    absolutePath === canonicalRoot ||
    (!absolutePath.startsWith(`${canonicalRoot}${sep}`) && absolutePath !== canonicalRoot)
  ) {
    return deny(
      REASON_CODES.DENY_PATH_OUTSIDE_REPOSITORY,
      'The candidate path resolves outside the canonical repository root.',
    );
  }

  const inspection = inspectRepositoryPath(canonicalRoot, segments, { fileTarget: true });
  if (inspection) return inspection;

  return allow(
    REASON_CODES.ALLOW_REPOSITORY_PATH,
    'The path is canonical, repository-relative, and has no existing symlink component.',
    {
      repositoryRoot: canonicalRoot,
      path: relativePath,
      absolutePath,
      requiresNoFollowRecheck: true,
    },
  );
}

function normalizeExternalAbsolutePath(path) {
  if (typeof path !== 'string' || path.trim() === '') {
    return deny(REASON_CODES.DENY_PATH_EMPTY, 'An external path must be non-empty.');
  }
  if (path.includes('\0')) {
    return deny(REASON_CODES.DENY_PATH_INVALID, 'Paths containing NUL bytes are forbidden.');
  }
  if (!looksAbsolute(path)) {
    return deny(REASON_CODES.DENY_PATH_ABSOLUTE, 'An approved external report path must be absolute.');
  }
  if (hasTraversal(path)) {
    return deny(REASON_CODES.DENY_PATH_TRAVERSAL, 'Parent-directory traversal is forbidden.');
  }

  const absolutePath = resolve(path.normalize('NFC'));
  const root = parse(absolutePath).root;
  const segments = absolutePath.slice(root.length).split(sep).filter(Boolean);
  const inspection = inspectRepositoryPath(root, segments, { fileTarget: true });
  if (inspection) return inspection;
  return allow(REASON_CODES.ALLOW_PATH, 'The external path is absolute and has no existing symlink component.', {
    path: absolutePath,
    absolutePath,
    requiresNoFollowRecheck: true,
  });
}

function normalizeScope(repositoryRoot, paths, { maximum = Number.POSITIVE_INFINITY } = {}) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > maximum) {
    return deny(REASON_CODES.DENY_SCOPE_INVALID, 'The declared path scope must be a non-empty bounded array.');
  }
  const normalized = [];
  for (const path of paths) {
    const result = normalizeRepositoryRelativePath({ repositoryRoot, path });
    if (!result.allowed) {
      return deny(REASON_CODES.DENY_SCOPE_INVALID, 'A declared path is not a safe repository-relative path.', {
        cause: result.code,
      });
    }
    normalized.push(result.path);
  }
  return allow(REASON_CODES.ALLOW_PATH, 'The declared path scope is valid.', {
    paths: [...new Set(normalized)].sort((a, b) => a.localeCompare(b, 'en')),
  });
}

function scopeIncludes(repositoryRoot, paths, targetPath, options) {
  const scope = normalizeScope(repositoryRoot, paths, options);
  if (!scope.allowed) return scope;
  if (!scope.paths.includes(targetPath)) {
    return deny(REASON_CODES.DENY_SCOPE_UNDECLARED, 'The candidate path is outside the declared write scope.');
  }
  return scope;
}

function validateApprovalSnapshot(record, {
  label,
  digestPairs,
  code,
  subject,
} = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return deny(code, `${subject} requires a bound approval snapshot.`);
  }
  if (record.selectedLabel !== label) {
    return deny(code, `${subject} requires the exact selected label ${label}.`);
  }
  for (const [approvedKey, currentKey] of digestPairs) {
    const approved = record[approvedKey];
    const current = record[currentKey];
    if (
      typeof approved !== 'string' ||
      typeof current !== 'string' ||
      !SHA256.test(approved) ||
      !SHA256.test(current) ||
      approved !== current
    ) {
      return deny(code, `${subject} is missing a current matching ${approvedKey} snapshot.`);
    }
  }
  return allow(REASON_CODES.ALLOW_PHASE, `${subject} is bound to the current approved snapshot.`);
}

function checkPlanApproval(record, { goal = false } = {}) {
  return validateApprovalSnapshot(record, {
    label: 'Approve Plan',
    digestPairs: [
      ['planDigest', 'currentPlanDigest'],
      ['repositoryBaselineDigest', 'currentRepositoryBaselineDigest'],
    ],
    code: goal
      ? REASON_CODES.DENY_GOAL_PLAN_UNAPPROVED
      : REASON_CODES.DENY_REFINE_PLAN_UNAPPROVED,
    subject: goal ? 'Goal Plan approval' : 'Refine Plan approval',
  });
}

function checkStartApproval(record) {
  return validateApprovalSnapshot(record, {
    label: 'Start Cruise',
    digestPairs: [
      ['planDigest', 'currentPlanDigest'],
      ['goalDigest', 'currentGoalDigest'],
      ['repositoryBaselineDigest', 'currentRepositoryBaselineDigest'],
    ],
    code: REASON_CODES.DENY_GOAL_START_UNAPPROVED,
    subject: 'Goal Start approval',
  });
}

function checkFallbackApproval(record) {
  const snapshot = validateApprovalSnapshot(record, {
    label: 'Execute in Current Thread',
    digestPairs: [
      ['planDigest', 'currentPlanDigest'],
      ['goalDigest', 'currentGoalDigest'],
      ['repositoryBaselineDigest', 'currentRepositoryBaselineDigest'],
    ],
    code: REASON_CODES.DENY_GOAL_FALLBACK_UNAPPROVED,
    subject: 'Goal current-thread fallback approval',
  });
  if (!snapshot.allowed) return snapshot;
  if (
    typeof record.decisionId !== 'string' ||
    !PERMISSION_ID.test(record.decisionId) ||
    record.nativeGoalAvailable !== false ||
    record.durabilityAcknowledged !== true
  ) {
    return deny(
      REASON_CODES.DENY_GOAL_FALLBACK_UNAPPROVED,
      'Fallback requires a D-XX decision, confirmed native unavailability, and explicit loss-of-durability acceptance.',
    );
  }
  return allow(REASON_CODES.ALLOW_PHASE, 'The current-thread fallback is explicitly accepted and snapshot-bound.');
}

function evidenceById(record) {
  try {
    validateEvidenceRecord(record);
  } catch {
    return null;
  }
  return new Map(record.items.map((item) => [item.id, item]));
}

function validateEvidenceIds(ids, {
  record,
  runId,
  minimum = 0,
  exactCount = null,
  status,
  supportsId = null,
  requiredGate = null,
  requiredScope = null,
  code,
  subject,
} = {}) {
  if (
    !Array.isArray(ids) ||
    ids.length < minimum ||
    (exactCount !== null && ids.length !== exactCount) ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => typeof id !== 'string' || !EVIDENCE_ID.test(id))
  ) {
    return deny(code, `${subject} requires a unique, count-bound E-XX list.`);
  }
  const byId = evidenceById(record);
  if (!byId) return deny(code, `${subject} requires a valid evidence record.`);
  if (typeof runId !== 'string' || runId.trim() === '' || record.run_id !== runId) {
    return deny(code, `${subject} evidence must belong to the current run.`);
  }
  for (const id of ids) {
    const item = byId.get(id);
    if (
      !item ||
      item.performed !== true ||
      item.status !== status ||
      (supportsId !== null && !item.supports.includes(supportsId)) ||
      (requiredGate !== null && item.gate !== requiredGate) ||
      (requiredScope !== null && item.scope !== requiredScope)
    ) {
      return deny(code, `${subject} evidence ${id} must be an actually performed ${status}.`);
    }
  }
  return allow(REASON_CODES.ALLOW_PATH, `${subject} is bound to performed evidence.`);
}

function checkQuickContext(input, { targetPath = null } = {}) {
  if (input.admitted !== true) {
    return deny(REASON_CODES.DENY_QUICK_NOT_ADMITTED, 'Quick execution requires an explicit successful admission decision.');
  }
  if (input.hardPromotion === true) {
    return deny(REASON_CODES.DENY_QUICK_HARD_PROMOTION, 'A hard promotion gate forbids Quick execution.');
  }
  if (!Array.isArray(input.hardPromotionReasons)) {
    return deny(REASON_CODES.DENY_QUICK_HARD_PROMOTION, 'Quick requires an explicit hard-promotion reason list.');
  }
  if (input.hardPromotionReasons.length > 0) {
    return deny(REASON_CODES.DENY_QUICK_HARD_PROMOTION, 'A hard promotion reason forbids Quick execution.', {
      promotionReasons: [...input.hardPromotionReasons],
    });
  }
  if (!Number.isInteger(input.repairAttempts) || input.repairAttempts < 0) {
    return deny(REASON_CODES.DENY_QUICK_REPAIR_LEDGER, 'Quick requires a non-negative repair count.');
  }
  const repairs = validateEvidenceIds(input.repairEvidenceIds, {
    record: input.evidenceRecord,
    runId: input.runId,
    exactCount: input.repairAttempts,
    status: 'BLOCK',
    code: REASON_CODES.DENY_QUICK_REPAIR_LEDGER,
    subject: 'Quick repair history',
  });
  if (!repairs.allowed) return repairs;
  const scope = targetPath === null
    ? normalizeScope(input.repositoryRoot, input.declaredPaths)
    : scopeIncludes(input.repositoryRoot, input.declaredPaths, targetPath);
  if (!scope.allowed) {
    return deny(REASON_CODES.DENY_QUICK_SCOPE, 'Quick requires an exact bounded declared path set.', {
      cause: scope.code,
    });
  }
  return allow(REASON_CODES.ALLOW_PATH, 'Quick admission and bounded-scope gates are satisfied.');
}

function checkRefineContext(input, { targetPath = null } = {}) {
  const approval = checkPlanApproval(input.planApproval);
  if (!approval.allowed) return approval;
  const scope = targetPath === null
    ? normalizeScope(input.repositoryRoot, input.planOwnership)
    : scopeIncludes(input.repositoryRoot, input.planOwnership, targetPath);
  if (!scope.allowed) {
    return deny(REASON_CODES.DENY_REFINE_OWNERSHIP, 'Refine product writes require exact declared plan ownership.', {
      cause: scope.code,
    });
  }
  return allow(REASON_CODES.ALLOW_PATH, 'Refine plan approval and ownership gates are satisfied.');
}

function checkGoalContext(input, { targetPath = null } = {}) {
  const execution = checkGoalExecutionAuthorization(input);
  if (!execution.allowed) return execution;
  const controller = checkMilestoneControllerContext(input, {
    requirePhasePlan: true,
  });
  if (!controller.allowed) return controller;
  const ownership = controller.controllerMode
    ? controller.currentPhaseOwnership
    : input.approvedOwnership;
  const scope = targetPath === null
    ? normalizeScope(input.repositoryRoot, ownership)
    : scopeIncludes(input.repositoryRoot, ownership, targetPath);
  if (!scope.allowed) {
    return deny(REASON_CODES.DENY_GOAL_OWNERSHIP, controller.controllerMode
      ? 'Milestone-controller product writes require exact current-phase ownership.'
      : 'Goal product writes require exact approved ownership.', {
      cause: scope.code,
    });
  }
  return allow(REASON_CODES.ALLOW_PATH, controller.controllerMode
    ? 'Goal execution authorization and current-phase ownership gates are satisfied.'
    : 'Goal execution authorization and approved ownership gates are satisfied.', {
    executionMode: execution.executionMode,
    ...(controller.controllerMode
      ? {
          milestoneId: controller.milestoneId,
          currentPhaseId: controller.currentPhaseId,
          questionSuppression: controller.questionSuppression,
        }
      : {}),
  });
}

function controllerModeRequested(input) {
  return input.goalMode === 'milestone-controller' || input.milestoneController != null;
}

function controllerContextDenied(reason) {
  return deny(REASON_CODES.DENY_GOAL_CONTROLLER_CONTEXT, reason);
}

function checkMilestoneControllerContext(input, { requirePhasePlan = false } = {}) {
  if (
    input.goalMode !== undefined &&
    input.goalMode !== 'single-slice' &&
    input.goalMode !== 'milestone-controller'
  ) {
    return controllerContextDenied('Goal mode must be single-slice or milestone-controller.');
  }
  if (!controllerModeRequested(input)) {
    return allow(REASON_CODES.ALLOW_PATH, 'Legacy single-slice Goal context remains selected.', {
      controllerMode: false,
    });
  }
  if (input.goalMode === 'single-slice') {
    return controllerContextDenied('Single-slice mode cannot carry milestone-controller authority.');
  }

  const context = input.milestoneController;
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return controllerContextDenied('Milestone-controller mode requires an exact controller context.');
  }
  if (context.mode !== 'milestone-controller') {
    return controllerContextDenied('The controller context mode must be milestone-controller.');
  }
  if (!isMilestoneControllerAuthority(context.authority, {
    runId: input.runId ?? null,
  })) {
    return controllerContextDenied(
      'Controller mode requires opaque current-session direct-user/Build authority.',
    );
  }
  let authoritySnapshot;
  try {
    authoritySnapshot = readMilestoneControllerAuthority(context.authority, {
      runId: input.runId ?? null,
    });
  } catch {
    return controllerContextDenied('The controller authority is forged, stale, or belongs to another run.');
  }
  if (
    !context.selection ||
    context.selection.source !== 'direct_user' ||
    typeof context.selection.decision_id !== 'string' ||
    !PERMISSION_ID.test(context.selection.decision_id)
  ) {
    return controllerContextDenied('The controller descriptor selection declaration is invalid.');
  }

  const milestone = context.milestone;
  const milestonePath = milestone?.path;
  const milestoneId = milestone?.id;
  const milestoneMatch = typeof milestonePath === 'string'
    ? milestonePath.match(MILESTONE_ROOT)
    : null;
  if (
    typeof milestoneId !== 'string' ||
    !MILESTONE_ID.test(milestoneId) ||
    !milestoneMatch ||
    milestoneMatch[1] !== milestoneId ||
    typeof milestone.contract_digest !== 'string' ||
    !SHA256.test(milestone.contract_digest)
  ) {
    return controllerContextDenied('The controller must identify one canonical digest-bound milestone root.');
  }
  if (
    authoritySnapshot.milestone_id !== milestoneId ||
    authoritySnapshot.milestone_path !== milestonePath ||
    authoritySnapshot.contract_digest !== milestone.contract_digest
  ) {
    return controllerContextDenied('The controller descriptor does not match current opaque authority.');
  }
  if (
    !context.build_approval ||
    context.build_approval.label !== 'Approve Milestone' ||
    context.build_approval.contract_digest !== milestone.contract_digest ||
    context.build_approval.approved_at !== authoritySnapshot.build_approval.approved_at ||
    context.buildApprovalDigest !== authoritySnapshot.build_approval_digest
  ) {
    return controllerContextDenied('The controller requires the exact verifier-attested Approve Milestone snapshot.');
  }
  if (
    typeof context.currentContractDigest !== 'string' ||
    !SHA256.test(context.currentContractDigest) ||
    context.currentContractDigest !== milestone.contract_digest ||
    typeof context.controllerDigest !== 'string' ||
    !SHA256.test(context.controllerDigest) ||
    typeof context.currentControllerDigest !== 'string' ||
    context.currentControllerDigest !== context.controllerDigest
  ) {
    return controllerContextDenied('The Build contract and controller descriptor digests must still match their approvals.');
  }
  if (
    context.eligibility?.phase_dag_validated !== true ||
    context.eligibility?.milestone_blockers_resolved !== true ||
    context.eligibility?.permission_envelope_explicit !== true ||
    context.autonomy?.mode !== 'interactive'
  ) {
    return controllerContextDenied(
      'The controller eligibility must remain explicit and its locked autonomy policy must remain interactive.',
    );
  }

  if (!Array.isArray(context.locked_artifacts) || context.locked_artifacts.length === 0) {
    return controllerContextDenied('The controller requires its complete locked Build manifest.');
  }
  const lockedPaths = new Set();
  for (const artifact of context.locked_artifacts) {
    if (
      !artifact ||
      typeof artifact !== 'object' ||
      Array.isArray(artifact) ||
      typeof artifact.path !== 'string' ||
      typeof artifact.sha256 !== 'string' ||
      !SHA256.test(artifact.sha256) ||
      lockedPaths.has(artifact.path) ||
      (!artifact.path.startsWith('.cruise/project/') &&
        !artifact.path.startsWith(`${milestonePath}/`)) ||
      artifact.path.endsWith('/STATE.yaml') ||
      artifact.path.endsWith('/QUEUE-STATE.yaml') ||
      artifact.path.includes('/discovery/') ||
      artifact.path.startsWith(`${milestonePath}/phases/`)
    ) {
      return controllerContextDenied('The locked Build manifest is incomplete, unsafe, duplicated, or contains mutable state.');
    }
    lockedPaths.add(artifact.path);
  }
  for (const name of REQUIRED_PROJECT_CONTRACT_FILES) {
    if (!lockedPaths.has(`.cruise/project/${name}`)) {
      return controllerContextDenied('The locked Build manifest is missing a required project artifact.');
    }
  }
  for (const name of REQUIRED_MILESTONE_CONTRACT_FILES) {
    if (!lockedPaths.has(`${milestonePath}/${name}`)) {
      return controllerContextDenied('The locked Build manifest is missing a required milestone artifact.');
    }
  }
  try {
    if (milestoneContractDigest(context.locked_artifacts) !== milestone.contract_digest) {
      return controllerContextDenied('The locked Build manifest no longer matches the milestone digest.');
    }
  } catch {
    return controllerContextDenied('The locked Build manifest cannot be digested safely.');
  }
  const approvedManifest = new Map(
    authoritySnapshot.build_approval.locked_artifacts.map((artifact) => [
      artifact.path,
      artifact.sha256,
    ]),
  );
  if (
    approvedManifest.size !== context.locked_artifacts.length ||
    context.locked_artifacts.some(
      (artifact) => approvedManifest.get(artifact.path) !== artifact.sha256,
    )
  ) {
    return controllerContextDenied('The controller manifest differs from the verified Build approval.');
  }

  if (!Array.isArray(context.phase_dag) || context.phase_dag.length === 0) {
    return controllerContextDenied('The controller requires a non-empty phase DAG.');
  }
  const phaseIds = new Set();
  const phases = new Map();
  for (const phase of context.phase_dag) {
    if (
      !phase ||
      typeof phase !== 'object' ||
      Array.isArray(phase) ||
      typeof phase.id !== 'string' ||
      !PHASE_ID.test(phase.id) ||
      phaseIds.has(phase.id) ||
      !Array.isArray(phase.depends_on) ||
      phase.depends_on.some((dependency) =>
        typeof dependency !== 'string' || !PHASE_ID.test(dependency)) ||
      new Set(phase.depends_on).size !== phase.depends_on.length ||
      typeof phase.mandatory !== 'boolean'
    ) {
      return controllerContextDenied(
        'The controller phase DAG contains an invalid ID, dependency list, mandatory flag, or duplicate.',
      );
    }
    phaseIds.add(phase.id);
    phases.set(phase.id, phase);
  }
  if (![...phases.values()].some((phase) => phase.mandatory)) {
    return controllerContextDenied('The controller phase DAG requires at least one mandatory phase.');
  }
  for (const phase of phases.values()) {
    for (const dependency of phase.depends_on) {
      if (dependency === phase.id || !phases.has(dependency)) {
        return controllerContextDenied(
          'The controller phase DAG contains a self-reference or unknown dependency.',
        );
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (phaseId) => {
    if (visiting.has(phaseId)) return false;
    if (visited.has(phaseId)) return true;
    visiting.add(phaseId);
    for (const dependency of phases.get(phaseId).depends_on) {
      if (!visit(dependency)) return false;
    }
    visiting.delete(phaseId);
    visited.add(phaseId);
    return true;
  };
  for (const phaseId of phaseIds) {
    if (!visit(phaseId)) {
      return controllerContextDenied('The controller phase DAG must be acyclic.');
    }
  }

  const currentPhase = context.currentPhase;
  if (
    !currentPhase ||
    typeof currentPhase !== 'object' ||
    Array.isArray(currentPhase) ||
    typeof currentPhase.id !== 'string' ||
    !phaseIds.has(currentPhase.id) ||
    !['planning', 'active'].includes(currentPhase.status)
  ) {
    return controllerContextDenied('The controller must name one ready-planning or active phase from its approved DAG.');
  }
  let runtimeState;
  try {
    if (!isMilestoneControllerStateProvenance(context.state)) {
      throw new Error('Controller state provenance is absent.');
    }
    runtimeState = validateMilestoneControllerState(context.state, {
      authority: context.authority,
      controllerInspection: context.controllerInspection,
    });
  } catch {
    return controllerContextDenied('The deterministic persisted controller runtime state is absent or invalid.');
  }
  const planningPhase = currentPhase.status === 'planning';
  if (
    runtimeState.run_id !== context.authority.run_id ||
    (planningPhase
      ? runtimeState.status !== 'ready' ||
        runtimeState.active_phase_id !== null ||
        runtimeState.ready_phase_ids[0] !== currentPhase.id ||
        requirePhasePlan
      : runtimeState.status !== 'active' ||
        runtimeState.active_phase_id !== currentPhase.id)
  ) {
    return controllerContextDenied('The current phase does not match deterministic controller runtime state.');
  }
  const runtimePhase = runtimeState.phases.find((phase) => phase.id === currentPhase.id);
  if (
    canonicalJson(context.phase_dag) !==
    canonicalJson(context.controllerInspection.controller.phase_dag) ||
    milestone.completion_fence !==
      context.controllerInspection.controller.milestone.completion_fence ||
    (!planningPhase && (
      currentPhase.planDigest !== runtimePhase.plan_digest ||
      currentPhase.currentPlanDigest !== runtimePhase.plan_digest ||
      canonicalJson(currentPhase.ownership) !==
        canonicalJson(runtimePhase.ownership) ||
      currentPhase.permissionScopeDigest !== runtimePhase.permission_scope_digest
    ))
  ) {
    return controllerContextDenied(
      'The controller DAG/fence or active JIT plan scope differs from attested runtime state.',
    );
  }
  if (requirePhasePlan) {
    if (
      typeof currentPhase.planDigest !== 'string' ||
      !SHA256.test(currentPhase.planDigest) ||
      typeof currentPhase.currentPlanDigest !== 'string' ||
      currentPhase.currentPlanDigest !== currentPhase.planDigest
    ) {
      return controllerContextDenied('Product writes require a current immutable just-in-time phase plan.');
    }
    const ownership = normalizeScope(input.repositoryRoot, currentPhase.ownership);
    if (!ownership.allowed) {
      return controllerContextDenied('The current phase requires exact repository write ownership.');
    }
  }

  const suppressionRequested = context.questionSuppressionRequested === true;
  const questionSuppression = context.dangerousGrant
    ? validateDangerousQuestionSuppression(context.dangerousGrant, {
        authority: context.authority,
        controllerInspection: context.controllerInspection,
        repositoryBaselineDigest: context.currentRepositoryBaselineDigest,
      })
    : false;
  if (suppressionRequested && !questionSuppression) {
    return controllerContextDenied(
      'Question suppression requires a current bound dangerous-mode grant.',
    );
  }

  return allow(REASON_CODES.ALLOW_PATH, 'The current milestone-controller context is exact and digest-bound.', {
    controllerMode: true,
    milestoneId,
    milestonePath,
    lockedPaths: [...lockedPaths],
    currentPhaseId: currentPhase.id,
    currentPhasePath: `${milestonePath}/phases/${currentPhase.id}`,
    currentPhasePlanLocked:
      typeof currentPhase.planDigest === 'string' &&
      SHA256.test(currentPhase.planDigest) &&
      currentPhase.currentPlanDigest === currentPhase.planDigest,
    currentPhaseOwnership: currentPhase.ownership,
    questionSuppression,
  });
}

function decideMilestoneControllerInternalPath({ targetPath, writeClass, context }) {
  if (context.lockedPaths.includes(targetPath) || targetPath.startsWith('.cruise/project/')) {
    return deny(
      REASON_CODES.DENY_GOAL_CONTROLLER_LOCKED_ARTIFACT,
      'Goal cannot modify a locked Build project or milestone artifact.',
    );
  }
  if (!targetPath.startsWith(`${context.milestonePath}/`)) {
    return deny(
      REASON_CODES.DENY_GOAL_CONTROLLER_SCOPE,
      'Milestone-controller state writes must remain inside the explicitly selected milestone.',
    );
  }

  const milestoneRelative = targetPath.slice(context.milestonePath.length + 1);
  if (CONTROLLER_MUTABLE_MILESTONE_FILES.has(milestoneRelative)) {
    if (writeClass !== 'machine') {
      return deny(
        REASON_CODES.DENY_WRITE_CLASS_PATH_MISMATCH,
        'Mutable milestone state must be YAML machine state.',
      );
    }
    return allow(REASON_CODES.ALLOW_PATH, 'The selected milestone mutable state path is in scope.');
  }

  const phasePrefix = `${context.currentPhasePath}/`;
  if (!targetPath.startsWith(phasePrefix)) {
    return deny(
      REASON_CODES.DENY_GOAL_CONTROLLER_SCOPE,
      'Milestone-controller runtime writes must target only the current phase.',
    );
  }
  const phaseRelative = targetPath.slice(phasePrefix.length);
  if (phaseRelative.includes('/')) {
    return deny(
      REASON_CODES.DENY_GOAL_CONTROLLER_SCOPE,
      'Current-phase runtime writes are limited to exact named files.',
    );
  }
  const expectedClass = CONTROLLER_PHASE_MACHINE_FILES.has(phaseRelative)
    ? 'machine'
    : CONTROLLER_PHASE_REPORT_FILES.has(phaseRelative)
      ? 'report'
      : null;
  if (expectedClass === null) {
    return deny(
      REASON_CODES.DENY_GOAL_CONTROLLER_SCOPE,
      'The current-phase runtime filename is not in the closed controller allowlist.',
    );
  }
  if (writeClass !== expectedClass) {
    return deny(
      REASON_CODES.DENY_WRITE_CLASS_PATH_MISMATCH,
      'The current-phase runtime file does not match its report or machine write class.',
    );
  }
  if (
    !context.currentPhasePlanLocked &&
    ['ATTEMPTS.yaml', 'EVIDENCE.yaml', 'CLOSEOUT.md'].includes(phaseRelative)
  ) {
    return controllerContextDenied(
      'Phase attempts, evidence, and closeout require a current immutable just-in-time phase plan.',
    );
  }
  if (
    context.currentPhasePlanLocked &&
    ['ORIGIN.yaml', 'PLAN.md'].includes(phaseRelative)
  ) {
    return deny(
      REASON_CODES.DENY_GOAL_CONTROLLER_LOCKED_ARTIFACT,
      'The current phase Origin and Plan are immutable after the phase-plan digest is bound.',
    );
  }
  return allow(REASON_CODES.ALLOW_PATH, 'The exact current-phase runtime path is in scope.');
}

function checkGoalExecutionAuthorization(input) {
  if (input.nativeGoalActive === true) {
    return allow(REASON_CODES.ALLOW_PHASE, 'Native Goal activation is confirmed.', {
      executionMode: 'native_goal',
    });
  }
  const fallback = checkFallbackApproval(input.fallbackApproval);
  if (fallback.allowed) {
    return allow(REASON_CODES.ALLOW_PHASE, 'The explicit current-thread fallback is active without native durability.', {
      executionMode: 'current_thread_fallback',
    });
  }
  return deny(REASON_CODES.DENY_GOAL_INACTIVE, 'Goal execution requires confirmed native activation or an explicit snapshot-bound current-thread fallback.');
}

function checkDebugContext(input, { targetPath = null } = {}) {
  const causalEvidence = checkDebugEvidence(input);
  if (!causalEvidence.allowed) return causalEvidence;
  const scope = targetPath === null
    ? normalizeScope(input.repositoryRoot, input.causalScope)
    : scopeIncludes(input.repositoryRoot, input.causalScope, targetPath);
  if (!scope.allowed) {
    return deny(REASON_CODES.DENY_DEBUG_CAUSAL_SCOPE, 'Debug product writes require an exact causal scope.', {
      cause: scope.code,
    });
  }
  return allow(REASON_CODES.ALLOW_PATH, 'Debug root-cause and causal-scope gates are satisfied.');
}

function checkDebugEvidence(input) {
  if (input.rootCauseEstablished !== true) {
    return deny(REASON_CODES.DENY_DEBUG_ROOT_CAUSE, 'Debug product writes require an evidence-backed root cause.');
  }
  if (typeof input.rootCauseHypothesisId !== 'string' || !HYPOTHESIS_ID.test(input.rootCauseHypothesisId)) {
    return deny(REASON_CODES.DENY_DEBUG_EVIDENCE, 'Debug root cause must select one stable H-XX hypothesis.');
  }
  if (
    Array.isArray(input.rootCauseEvidenceIds) &&
    Array.isArray(input.causalScopeEvidenceIds) &&
    input.rootCauseEvidenceIds.some((id) => input.causalScopeEvidenceIds.includes(id))
  ) {
    return deny(REASON_CODES.DENY_DEBUG_EVIDENCE, 'Root-cause and causal-scope proof require distinct evidence items.');
  }
  const rootEvidence = validateEvidenceIds(input.rootCauseEvidenceIds, {
    record: input.evidenceRecord,
    runId: input.runId,
    minimum: 1,
    status: 'PASS',
    supportsId: input.rootCauseHypothesisId,
    requiredGate: 'mandatory',
    requiredScope: 'task',
    code: REASON_CODES.DENY_DEBUG_EVIDENCE,
    subject: 'Debug root-cause claim',
  });
  if (!rootEvidence.allowed) return rootEvidence;
  const scopeEvidence = validateEvidenceIds(input.causalScopeEvidenceIds, {
    record: input.evidenceRecord,
    runId: input.runId,
    minimum: 1,
    status: 'PASS',
    supportsId: input.rootCauseHypothesisId,
    requiredGate: 'mandatory',
    requiredScope: 'task',
    code: REASON_CODES.DENY_DEBUG_EVIDENCE,
    subject: 'Debug causal-scope claim',
  });
  if (!scopeEvidence.allowed) return scopeEvidence;
  return allow(REASON_CODES.ALLOW_PHASE, 'Debug root cause and causal scope are bound to current-run discriminating evidence.');
}

function internalRunPath(path, writeClass) {
  const segments = path.split('/');
  if (segments.length < 4 || segments[0] !== '.cruise' || segments[1] !== 'runs') return false;
  if (!RUN_ID.test(segments[2]) || segments[2] === '.' || segments[2] === '..') return false;
  const extension = segments.at(-1).toLowerCase();
  if (writeClass === 'report') return extension.endsWith('.md');
  if (writeClass === 'machine') return extension.endsWith('.yaml');
  return false;
}

function internalBuildPath(path, writeClass) {
  const lower = path.toLowerCase();
  const inProject = path.startsWith('.cruise/project/');
  const inMilestone = /^\.cruise\/milestones\/M-\d{2,}-[A-Za-z0-9][A-Za-z0-9._-]*\//u.test(path);
  if ((!inProject && !inMilestone) || lower.endsWith('/closeout.md')) return false;
  if (writeClass === 'report') return lower.endsWith('.md');
  if (writeClass === 'machine') return lower.endsWith('.yaml');
  return false;
}

function isInternalCruisePath(path) {
  return path === '.cruise' || path.startsWith('.cruise/');
}

function approvedBuildDocumentationPath({
  receipt,
  artifactSnapshot,
  repositoryRoot,
  targetPath,
}) {
  if (!isVerifiedBuildApproval(receipt)) {
    return deny(
      REASON_CODES.DENY_BUILD_DOCUMENTATION_APPROVAL,
      'Repository documentation requires an opaque verified Build approval.',
    );
  }
  if (receipt.approval_readiness?.bindings?.repository_root !== repositoryRoot) {
    return deny(
      REASON_CODES.DENY_BUILD_DOCUMENTATION_APPROVAL,
      'The verified Build approval belongs to another repository.',
    );
  }
  if (!isVerifiedBuildApprovalArtifactSnapshot(artifactSnapshot, {
    verifiedBuildApproval: receipt,
  })) {
    return deny(
      REASON_CODES.DENY_BUILD_DOCUMENTATION_APPROVAL,
      'Repository documentation requires a fresh opaque snapshot of the still-current locked Build artifacts.',
    );
  }
  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length === 0) {
    return deny(
      REASON_CODES.DENY_BUILD_DOCUMENTATION_APPROVAL,
      'The verified Build approval has no locked artifact manifest.',
    );
  }
  for (const artifact of receipt.artifacts) {
    const normalized = normalizeRepositoryRelativePath({
      repositoryRoot,
      path: artifact?.path,
    });
    if (
      !normalized.allowed ||
      typeof artifact?.sha256 !== 'string' ||
      !Number.isSafeInteger(artifact?.bytes) ||
      artifact.bytes < 0
    ) {
      return deny(
        REASON_CODES.DENY_BUILD_DOCUMENTATION_APPROVAL,
        'A locked Build artifact path or digest is invalid at the documentation write boundary.',
      );
    }
    let descriptor;
    try {
      const before = lstatSync(normalized.absolutePath);
      if (!before.isFile() || before.isSymbolicLink()) throw new Error('not a regular file');
      if (before.size !== artifact.bytes) throw new Error('locked byte length changed');
      descriptor = openSync(
        normalized.absolutePath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      const opened = fstatSync(descriptor);
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size ||
        opened.mtimeMs !== before.mtimeMs ||
        opened.ctimeMs !== before.ctimeMs
      ) {
        throw new Error('identity changed before read');
      }
      const bytes = readFileSync(descriptor);
      const after = fstatSync(descriptor);
      const afterPath = lstatSync(normalized.absolutePath);
      if (
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs ||
        afterPath.dev !== after.dev ||
        afterPath.ino !== after.ino ||
        afterPath.isSymbolicLink() ||
        bytes.length !== after.size ||
        createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
      ) {
        throw new Error('locked bytes changed');
      }
    } catch {
      return deny(
        REASON_CODES.DENY_BUILD_DOCUMENTATION_APPROVAL,
        `Locked Build artifact ${artifact?.path ?? '<unknown>'} is stale or unsafe.`,
      );
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  const queueItems = receipt.review_card?.queues?.flatMap(({ items } = {}) =>
    Array.isArray(items) ? items : []) ?? [];
  const included = queueItems.some(({ permitted_changes: permittedChanges } = {}) =>
    Array.isArray(permittedChanges) && permittedChanges.includes(targetPath));
  if (!included) {
    return deny(
      REASON_CODES.DENY_BUILD_DOCUMENTATION_SCOPE,
      'The exact repository documentation path was not displayed in the approved Build contract.',
    );
  }
  return allow(
    REASON_CODES.ALLOW_PATH,
    'The exact Markdown documentation path was displayed in the opaque verified Build approval.',
  );
}

function writeClassFrom(input) {
  if (input.writeClass !== undefined && input.writeKind !== undefined && input.writeClass !== input.writeKind) {
    return null;
  }
  return input.writeClass ?? input.writeKind;
}

/**
 * Decide whether a public skill may cross a phase boundary. The returned
 * decision is immutable and carries a stable reason code.
 */
export function decidePhase(request = {}) {
  const { skill, from = null, to, phase, ...context } = request;
  if (!validSkill(skill)) {
    return deny(REASON_CODES.DENY_UNKNOWN_SKILL, 'Only the six public Cruise skills are accepted.');
  }
  const target = to ?? phase;
  const phases = PHASE_TRANSITIONS[skill];
  if (typeof target !== 'string' || !Object.hasOwn(phases, target)) {
    return deny(REASON_CODES.DENY_UNKNOWN_PHASE, 'The requested phase is not part of this skill workflow.');
  }

  const isTransition = Object.hasOwn(request, 'from') || Object.hasOwn(request, 'to');
  if (isTransition) {
    const source = from === null ? '<start>' : from;
    if (!Object.hasOwn(phases, source) || !phases[source].includes(target)) {
      return deny(REASON_CODES.DENY_PHASE_TRANSITION, 'The requested phase transition is not in the skill DAG.');
    }
    if (
      skill === 'build' &&
      source === 'approval' &&
      target === 'close' &&
      !isVerifiedBuildApproval(
        context.buildApprovalAttestation ?? context.verifiedBuildApproval,
      )
    ) {
      return deny(
        REASON_CODES.DENY_PHASE_TRANSITION,
        'Build approval may close only with a mechanically verified opaque Build approval attestation.',
      );
    }
  }

  const input = { skill, repositoryRoot: context.repositoryRoot, ...context };
  let gate = null;
  if (skill === 'quick' && ['execute', 'repair'].includes(target)) gate = checkQuickContext(input);
  if (skill === 'refine' && target === 'execute') gate = checkRefineContext(input);
  if (skill === 'goal' && target === 'goal_contract') gate = checkPlanApproval(context.planApproval, { goal: true });
  if (skill === 'goal' && target === 'activation') gate = checkStartApproval(context.startApproval);
  if (skill === 'goal' && target === 'fallback_activation') gate = checkFallbackApproval(context.fallbackApproval);
  if (skill === 'goal' && target === 'execute') gate = checkGoalContext(input);
  if (skill === 'goal' && ['verify', 'closeout'].includes(target)) gate = checkGoalExecutionAuthorization(input);
  if (skill === 'debug' && target === 'root_cause') gate = checkDebugEvidence(input);
  if (skill === 'debug' && target === 'repair') gate = checkDebugContext(input);
  if (gate && !gate.allowed) return gate;

  return allow(REASON_CODES.ALLOW_PHASE, 'The phase transition and semantic gates are satisfied.', {
    skill,
    from: from ?? null,
    to: target,
    ...(gate?.questionSuppression === true ? { questionSuppression: true } : {}),
  });
}

/**
 * Decide whether a path write is in bounds. This function performs no write,
 * install, formatting, dependency, fixture, snapshot, or generation action.
 */
export function decidePath({ skill, path, ...input } = {}) {
  if (!validSkill(skill)) {
    return deny(REASON_CODES.DENY_UNKNOWN_SKILL, 'Only the six public Cruise skills are accepted.');
  }
  const writeClass = writeClassFrom(input);
  if (!WRITE_CLASS_SET.has(writeClass)) {
    return deny(REASON_CODES.DENY_WRITE_CLASS, 'A recognized writeClass is required.');
  }

  if (typeof path === 'string' && looksAbsolute(path)) {
    if (skill !== 'research' || writeClass !== 'report') {
      return deny(REASON_CODES.DENY_PATH_ABSOLUTE, 'Only Research may target an approved external report path.');
    }
    const external = normalizeExternalAbsolutePath(path);
    if (!external.allowed || !external.path.toLowerCase().endsWith('.md')) {
      return external.allowed
        ? deny(REASON_CODES.DENY_WRITE_CLASS_PATH_MISMATCH, 'External reports must be Markdown files.')
        : external;
    }
    if (!Array.isArray(input.approvedExternalReportPaths)) {
      return deny(REASON_CODES.DENY_EXTERNAL_REPORT_APPROVAL, 'An exact external report approval list is required.');
    }
    const approved = [];
    for (const candidate of input.approvedExternalReportPaths) {
      const normalized = normalizeExternalAbsolutePath(candidate);
      if (!normalized.allowed) {
        return deny(REASON_CODES.DENY_EXTERNAL_REPORT_APPROVAL, 'An approved external report path is unsafe.', {
          cause: normalized.code,
        });
      }
      approved.push(normalized.path);
    }
    if (!approved.includes(external.path)) {
      return deny(REASON_CODES.DENY_EXTERNAL_REPORT_APPROVAL, 'The external report path lacks exact user approval.');
    }
    const effect = decideEffect({
      skill,
      effect: {
        boundary: 'external',
        kind: 'external_filesystem_write',
        target: external.path,
        purpose: 'approved_report',
      },
      permission: input.permission,
    });
    if (!effect.allowed) return effect;
    return allow(REASON_CODES.ALLOW_PATH, 'The exact external report path and effect permission are approved.', {
      skill,
      path: external.path,
      writeClass,
      external: true,
      requiresNoFollowRecheck: true,
    });
  }

  const normalized = normalizeRepositoryRelativePath({
    repositoryRoot: input.repositoryRoot,
    path,
  });
  if (!normalized.allowed) return normalized;
  const targetPath = normalized.path;
  const lowerPath = targetPath.toLowerCase();
  if (skill === 'build' && writeClass === 'report' && !isInternalCruisePath(targetPath)) {
    if (!lowerPath.endsWith('.md') && !lowerPath.endsWith('.mdx')) {
      return deny(
        REASON_CODES.DENY_WRITE_CLASS_PATH_MISMATCH,
        'Post-approval Build documentation writes are limited to Markdown files.',
      );
    }
    const documentation = approvedBuildDocumentationPath({
      receipt: input.buildApprovalAttestation ?? input.verifiedBuildApproval,
      artifactSnapshot: input.buildArtifactSnapshot,
      repositoryRoot: normalized.repositoryRoot,
      targetPath,
    });
    if (!documentation.allowed) return documentation;
    return allow(
      REASON_CODES.ALLOW_PATH,
      'The exact repository documentation path is included in the verified Build contract.',
      {
        skill,
        path: targetPath,
        absolutePath: normalized.absolutePath,
        writeClass,
        external: false,
        requiresNoFollowRecheck: true,
      },
    );
  }
  const goalExecution = skill === 'goal' ? checkGoalExecutionAuthorization(input) : null;
  const controllerContext = skill === 'goal'
    ? checkMilestoneControllerContext(input)
    : null;
  if (
    skill === 'goal' &&
    controllerModeRequested(input) &&
    (targetPath.startsWith('.cruise/project/') ||
      targetPath.startsWith('.cruise/milestones/'))
  ) {
    if (!controllerContext.allowed) return controllerContext;
    if (!goalExecution.allowed) return goalExecution;
    const controllerPath = decideMilestoneControllerInternalPath({
      targetPath,
      writeClass,
      context: controllerContext,
    });
    if (!controllerPath.allowed) return controllerPath;
    const scope = scopeIncludes(
      input.repositoryRoot,
      input.approvedInternalPaths,
      targetPath,
    );
    if (!scope.allowed) {
      return deny(
        REASON_CODES.DENY_SCOPE_UNDECLARED,
        'The milestone-controller runtime path is not explicitly approved.',
        { cause: scope.code },
      );
    }
    return allow(
      REASON_CODES.ALLOW_PATH,
      'The exact selected-milestone/current-phase runtime path is approved.',
      {
        skill,
        path: targetPath,
        absolutePath: normalized.absolutePath,
        writeClass,
        external: false,
        milestoneId: controllerContext.milestoneId,
        currentPhaseId: controllerContext.currentPhaseId,
        questionSuppression: controllerContext.questionSuppression,
        requiresNoFollowRecheck: true,
      },
    );
  }

  if (skill === 'goal' && lowerPath.startsWith(GOAL_PREFIX)) {
    if (!GOAL_ARTIFACTS.has(targetPath)) {
      return deny(REASON_CODES.DENY_GOAL_ARTIFACT, 'Goal writes are limited to the exact named contract artifacts.');
    }
    const startWasSelected =
      input.startSelected === true ||
      input.startApproved === true ||
      input.startApproval?.selectedLabel === 'Start Cruise';
    if (startWasSelected && !goalExecution.allowed) {
      return deny(REASON_CODES.DENY_GOAL_POST_START_WRITE, 'No Goal artifact may change after Start Cruise is selected and before activation.');
    }
    if (goalExecution.allowed && targetPath !== CLOSEOUT_PATH) {
      return deny(REASON_CODES.DENY_GOAL_POST_START_WRITE, 'Approved Goal contract artifacts are immutable after activation; only CLOSEOUT may be written.');
    }
    const planWasApproved =
      input.planLocked === true ||
      input.planApproved === true ||
      input.planApproval?.selectedLabel === 'Approve Plan';
    if (planWasApproved && PLAN_LOCKED_ARTIFACTS.has(targetPath)) {
      return deny(REASON_CODES.DENY_GOAL_ARTIFACT, 'Plan-approved Goal artifact bytes are locked until explicit reconciliation invalidates approval.');
    }
  }

  if (targetPath === CLOSEOUT_PATH && skill === 'goal' && !goalExecution.allowed) {
    return deny(REASON_CODES.DENY_GOAL_CLOSEOUT_INACTIVE, 'CLOSEOUT.md is forbidden before native Goal activation or explicit current-thread fallback authorization.');
  }

  if (writeClass === 'report' || writeClass === 'machine') {
    const isRunPath = internalRunPath(targetPath, writeClass);
    const isBuildPath = skill === 'build' && internalBuildPath(targetPath, writeClass);
    const isGoalPath = skill === 'goal' && targetPath.startsWith('.cruise/goal/') &&
      ((writeClass === 'report' && lowerPath.endsWith('.md')) ||
        (writeClass === 'machine' && lowerPath.endsWith('.yaml')));
    if (!isRunPath && !isGoalPath && !isBuildPath) {
      return deny(REASON_CODES.DENY_INTERNAL_PATH, 'Report and machine writes must use an approved Cruise internal path.');
    }
    const approvedPaths = (isGoalPath || isBuildPath) ? input.approvedInternalPaths : input.approvedRunPaths;
    const scope = scopeIncludes(input.repositoryRoot, approvedPaths, targetPath);
    if (!scope.allowed) {
      return deny(REASON_CODES.DENY_SCOPE_UNDECLARED, 'The Cruise report or machine path is not explicitly approved.', {
        cause: scope.code,
      });
    }
    return allow(REASON_CODES.ALLOW_PATH, 'The exact Cruise report or machine path is approved.', {
      skill,
      path: targetPath,
      absolutePath: normalized.absolutePath,
      writeClass,
      external: false,
      requiresNoFollowRecheck: true,
    });
  }

  if (!PRODUCT_WRITE_CLASSES.has(writeClass)) {
    return deny(REASON_CODES.DENY_WRITE_CLASS, 'The write class is not supported by this boundary.');
  }
  if (isInternalCruisePath(targetPath)) {
    return deny(REASON_CODES.DENY_WRITE_CLASS_PATH_MISMATCH, 'Product-affecting writes cannot masquerade as Cruise state.');
  }
  if (PLANNING_ONLY.has(skill)) {
    return deny(
      REASON_CODES.DENY_REVIEW_RESEARCH_WRITE,
      'Build and Research cannot write product code, dependencies, locks, fixtures, snapshots, generated sources, or formatting.',
    );
  }
  if (skill === 'quick' && ['dependency', 'lockfile'].includes(writeClass)) {
    return deny(
      REASON_CODES.DENY_QUICK_HARD_PROMOTION,
      'Dependency and lockfile writes mechanically require promotion out of Quick.',
    );
  }

  const complete = { ...input, skill, path, writeClass, repositoryRoot: input.repositoryRoot };
  let gate;
  if (skill === 'quick') gate = checkQuickContext(complete, { targetPath });
  else if (skill === 'refine') gate = checkRefineContext(complete, { targetPath });
  else if (skill === 'goal') gate = checkGoalContext(complete, { targetPath });
  else if (skill === 'debug') gate = checkDebugContext(complete, { targetPath });
  else gate = deny(REASON_CODES.DENY_REVIEW_RESEARCH_WRITE, 'This skill has no product-write authority.');
  if (!gate.allowed) return gate;

  return allow(REASON_CODES.ALLOW_PATH, 'The write satisfies the selected skill gate and exact path ownership.', {
    skill,
    path: targetPath,
    absolutePath: normalized.absolutePath,
    writeClass,
    external: false,
    ...(gate.questionSuppression === true ? { questionSuppression: true } : {}),
    requiresNoFollowRecheck: true,
  });
}

/**
 * Decide whether an effect is within its declared boundary. External effects
 * require a granted D-XX permission whose exact kind and target are in scope.
 */
export function decideEffect({ skill, effect, permission, ...context } = {}) {
  if (!validSkill(skill)) {
    return deny(REASON_CODES.DENY_UNKNOWN_SKILL, 'Only the six public Cruise skills are accepted.');
  }
  if (!effect || typeof effect !== 'object' || Array.isArray(effect)) {
    return deny(REASON_CODES.DENY_INVALID_REQUEST, 'An effect record is required.');
  }
  const { boundary, kind, target, purpose } = effect;
  if (!['internal', 'external'].includes(boundary)) {
    return deny(REASON_CODES.DENY_EFFECT_BOUNDARY, 'Every effect must declare an internal or external boundary.');
  }
  if (typeof kind !== 'string' || kind.trim() === '' || typeof target !== 'string' || target.trim() === '') {
    return deny(REASON_CODES.DENY_EFFECT_KIND, 'Every effect needs a non-empty kind and exact target.');
  }

  if (boundary === 'internal') {
    if (!INTERNAL_EFFECT_KINDS.has(kind) || EXTERNAL_EFFECT_KINDS.has(kind)) {
      return deny(REASON_CODES.DENY_EFFECT_BOUNDARY, 'The declared internal effect kind is not in the closed internal allowlist.');
    }
    if (kind === 'capability_resolution_request' && !CAPABILITY_ID.test(target)) {
      return deny(REASON_CODES.DENY_EFFECT_SCOPE, 'A private capability request must target one canonical CAP-* node.');
    }
    return allow(REASON_CODES.ALLOW_EFFECT, 'The effect is a recognized internal operation.', {
      skill,
      effect: { boundary, kind, target },
    });
  }

  if (!EXTERNAL_EFFECT_KINDS.has(kind)) {
    return deny(REASON_CODES.DENY_EFFECT_KIND, 'Unknown external effect kinds fail closed.');
  }
  if (kind === 'capability_install') {
    return deny(
      REASON_CODES.DENY_PRIVATE_PROVISION_REQUIRED,
      'Public workflows cannot authorize capability installation; request a CAP-* resolution and let the private provisioner own trust, install, rollback, and smoke proof.',
    );
  }
  if (skill === 'goal') {
    const gate = checkGoalExecutionAuthorization(context);
    if (!gate.allowed) {
      return deny(REASON_CODES.DENY_GOAL_INACTIVE, 'Goal external effects remain inactive until native activation or an explicit current-thread fallback.');
    }
  }
  if (skill === 'build') {
    return deny(
      REASON_CODES.DENY_REVIEW_RESEARCH_EFFECT,
      'Build cannot cause external effects; approved research and implementation use narrowed queue handoffs.',
    );
  }
  if (skill === 'research') {
    if (READ_ONLY_FORBIDDEN_EFFECTS.has(kind)) {
      return deny(REASON_CODES.DENY_REVIEW_RESEARCH_EFFECT, 'Research cannot cause product-affecting external effects.');
    }
    if (kind === 'external_filesystem_write' && purpose !== 'approved_report') {
      return deny(REASON_CODES.DENY_REVIEW_RESEARCH_EFFECT, 'Research may write externally only for an exact approved report.');
    }
  }
  if (skill === 'quick' && QUICK_FORBIDDEN_EFFECTS.has(kind)) {
    return deny(REASON_CODES.DENY_QUICK_HARD_PROMOTION, 'Product-affecting external effects require promotion out of Quick.');
  }
  if (skill === 'refine' && READ_ONLY_FORBIDDEN_EFFECTS.has(kind)) {
    const gate = checkPlanApproval(context.planApproval);
    if (!gate.allowed) return gate;
  }
  if (skill === 'debug' && READ_ONLY_FORBIDDEN_EFFECTS.has(kind)) {
    const gate = checkDebugEvidence(context);
    if (!gate.allowed) return gate;
  }
  if (!permission || typeof permission !== 'object' || permission.granted !== true) {
    return deny(REASON_CODES.DENY_EFFECT_PERMISSION, 'The external effect lacks an explicitly granted permission.');
  }
  if (typeof permission.id !== 'string' || !PERMISSION_ID.test(permission.id)) {
    return deny(REASON_CODES.DENY_EFFECT_PERMISSION_ID, 'External effects require a stable D-XX permission ID.');
  }
  const scope = permission.scope;
  if (
    !scope ||
    typeof scope !== 'object' ||
    !Array.isArray(scope.kinds) ||
    !Array.isArray(scope.targets) ||
    scope.kinds.includes('*') ||
    scope.targets.includes('*') ||
    !scope.kinds.includes(kind) ||
    !scope.targets.includes(target)
  ) {
    return deny(REASON_CODES.DENY_EFFECT_SCOPE, 'The permission does not exactly scope this external effect kind and target.');
  }
  return allow(REASON_CODES.ALLOW_EFFECT, 'The external effect has an exact granted permission ID and scope.', {
    skill,
    effect: {
      boundary,
      kind,
      target,
      ...(purpose === undefined ? {} : { purpose }),
    },
    permissionId: permission.id,
  });
}

// Descriptive aliases for callers that prefer action-oriented names.
export function decidePhaseTransition(request = {}) {
  if (!Object.hasOwn(request, 'from') || !Object.hasOwn(request, 'to')) {
    return deny(
      REASON_CODES.DENY_INVALID_REQUEST,
      'A phase transition decision requires explicit from and to phases.',
    );
  }
  return decidePhase(request);
}
export const decideWritePath = decidePath;
export const decideExternalEffect = decideEffect;
