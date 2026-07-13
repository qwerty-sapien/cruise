import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { isVerifiedBuildApproval } from './build-contract.mjs';
import { evidenceDigest, validateEvidenceRecord } from './evidence.mjs';
import { milestoneContractDigest } from './milestone-contract-digest.mjs';
import {
  canonicalJson,
  parseYaml,
  stringifyYaml,
  writeYamlFile,
} from './yaml-state.mjs';

export { milestoneContractDigest } from './milestone-contract-digest.mjs';

export const MILESTONE_CONTROLLER_ARTIFACT =
  '.cruise/goal/MILESTONE-CONTROLLER.yaml';
export const SINGLE_SLICE_MODE = 'single-slice';
export const MILESTONE_CONTROLLER_MODE = 'milestone-controller';
export const CONTROLLER_ARTIFACT = MILESTONE_CONTROLLER_ARTIFACT;
export const LEGACY_GOAL_MODE = SINGLE_SLICE_MODE;
export const MILESTONE_CONTROLLER_SELECTION_PREFIX =
  'Use Milestone Controller ';

const CONTROLLER_AUTHORITIES = new WeakMap();
const CONTROLLER_INSPECTIONS = new WeakMap();
const INTERACTION_BROKERS = new WeakMap();
const STRUCTURED_SELECTION_RECEIPTS = new WeakMap();
const DIRECT_USER_EVENT_RECEIPTS = new WeakMap();
const NATIVE_GOAL_ACTIVATION_RECEIPTS = new WeakMap();
const GOAL_ACTIVATION_AUTHORITIES = new WeakMap();
const DANGEROUS_CHALLENGES = new WeakMap();
const DANGEROUS_AUTHORIZATIONS = new WeakMap();
const DANGEROUS_GRANTS = new WeakMap();
const DANGEROUS_EFFECT_AUTHORITIES = new WeakMap();
const ACTIVE_DANGEROUS_GRANTS = new Set();
const PHASE_CLOSEOUT_ATTESTATIONS = new WeakMap();
const PHASE_PLAN_ATTESTATIONS = new WeakMap();
const COMPLETION_FENCE_ATTESTATIONS = new WeakMap();
const CONTROLLER_STATES = new WeakMap();
const STATE_PERSISTENCE_PROOFS = new WeakMap();

const SHA256 = /^[a-f0-9]{64}$/u;
const MILESTONE_ID = /^M-[0-9]{2,}$/u;
const PHASE_ID = /^P-[0-9]{2,}$/u;
const DECISION_ID = /^D-[0-9]{2,}$/u;
const MILESTONE_PATH = /^\.cruise\/milestones\/(M-[0-9]{2,})-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]+$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const EVIDENCE_ID = /^E-[0-9]{2,}$/u;
const QUESTION_ID = /^Q-[0-9]{2,}$/u;
const CONTROLLER_HISTORY_ENTRY = /^REV-([0-9]{12})\.yaml$/u;
const CONTROLLER_HISTORY_DIRECTORY = 'CONTROLLER-STATE-HISTORY';
const QUESTION_MATERIALITIES = new Set([
  'phase_blocking',
  'product_or_architecture_fork',
  'approved_assumption_conflict',
  'permission_required',
  'mandatory_evidence_unavailable',
  'next_phase_invalid',
]);

const REQUIRED_PROJECT_FILES = Object.freeze([
  'ORIGIN.yaml',
  'PROJECT.md',
  'REQUIREMENTS.md',
  'ARCHITECTURE.md',
  'ROADMAP.md',
  'DECISIONS.md',
  'ID-REGISTRY.yaml',
  'QUEUE.yaml',
]);

const REQUIRED_MILESTONE_FILES = Object.freeze([
  'ORIGIN.yaml',
  'MILESTONE.md',
  'REQUIREMENTS.md',
  'ROADMAP.md',
  'DECISIONS.md',
  'QUESTIONS.yaml',
  'AUTONOMY.yaml',
  'QUEUE.yaml',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be a mapping.`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean.`);
  return value;
}

function requireTimestamp(value, label) {
  const timestamp = requireString(value, label);
  if (!RFC3339.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`${label} must be an RFC 3339 timestamp.`);
  }
  return timestamp;
}

function assertSafeRelativePath(value, label) {
  const path = requireString(value, label);
  if (
    !SAFE_RELATIVE_PATH.test(path) ||
    path.startsWith('./') ||
    path.includes('//') ||
    resolve('/', path) !== join('/', path)
  ) {
    throw new Error(`${label} must be a normalized repository-relative path.`);
  }
  return path;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function nonEmptyRuntimeString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function runtimeDigest(value, label) {
  const digest = nonEmptyRuntimeString(value, label);
  if (!SHA256.test(digest)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return digest;
}

function nowTimestamp(now, label = 'timestamp') {
  const value = typeof now === 'function' ? now() : now;
  const timestamp = value instanceof Date ? value.toISOString() : String(value ?? '');
  requireTimestamp(timestamp, label);
  return timestamp;
}

function interactionBrokerMetadata(broker) {
  const metadata = broker && INTERACTION_BROKERS.get(broker);
  if (!metadata?.active) {
    throw new Error('The direct-user interaction broker is absent, forged, or inactive.');
  }
  return metadata;
}

function observedAt(now) {
  return nowTimestamp(now, 'observed_at');
}

/**
 * Create the session-local issuer used by the actual interaction handler.
 * Callers downstream receive only opaque receipts; copied receipt fields are
 * never accepted as proof that a user selected or typed anything.
 */
export function createMilestoneControllerInteractionBroker({
  sessionId,
  runId,
} = {}) {
  nonEmptyRuntimeString(sessionId, 'sessionId');
  nonEmptyRuntimeString(runId, 'runId');
  const metadata = {
    active: true,
    sessionId,
    runId,
    ordinal: 0,
  };
  const broker = Object.freeze({
    observeStructuredSelection({
      interactionId,
      answer,
      source,
      now = () => new Date(),
    } = {}) {
      if (!metadata.active) throw new Error('The direct-user interaction broker is inactive.');
      const milestoneId = milestoneControllerSelectionId(answer);
      if (source !== 'option' || !milestoneId) {
        throw new Error(
          'Controller selection must be the exact structured Use Milestone Controller M-XX option.',
        );
      }
      const receipt = Object.freeze({
        schema_version: 1,
        kind: 'cruise_observed_controller_selection',
        session_id: sessionId,
        run_id: runId,
        interaction_id: nonEmptyRuntimeString(interactionId, 'interactionId'),
        ordinal: ++metadata.ordinal,
        observed_at: observedAt(now),
      });
      STRUCTURED_SELECTION_RECEIPTS.set(receipt, {
        broker,
        milestoneId,
        selectedLabel: answer,
      });
      return receipt;
    },

    observeDirectUserResponse({
      interactionId,
      answer,
      source,
      now = () => new Date(),
    } = {}) {
      if (!metadata.active) throw new Error('The direct-user interaction broker is inactive.');
      if (!['text', 'other'].includes(source)) {
        throw new Error('Dangerous authorization must be typed by the direct user.');
      }
      const exactAnswer = nonEmptyRuntimeString(answer, 'answer');
      const receipt = Object.freeze({
        schema_version: 1,
        kind: 'cruise_observed_direct_user_event',
        session_id: sessionId,
        run_id: runId,
        interaction_id: nonEmptyRuntimeString(interactionId, 'interactionId'),
        ordinal: ++metadata.ordinal,
        observed_at: observedAt(now),
      });
      DIRECT_USER_EVENT_RECEIPTS.set(receipt, {
        broker,
        answer: exactAnswer,
      });
      return receipt;
    },

    observeNativeGoalActivation({
      interactionId,
      threadId,
      activationResult,
      approvedSnapshot,
      now = () => new Date(),
    } = {}) {
      if (!metadata.active) throw new Error('The direct-user interaction broker is inactive.');
      const goal = requireRecord(activationResult?.goal, 'activationResult.goal');
      const objective = nonEmptyRuntimeString(
        activationResult?.objective,
        'activationResult.objective',
      );
      if (goal.status !== 'active' || goal.objective !== objective) {
        throw new Error('Native Goal activation must be confirmed active for the approved objective.');
      }
      if (approvedSnapshot?.stage !== 'goal') {
        throw new Error('Native Goal activation requires the separately approved Goal snapshot.');
      }
      if (!Array.isArray(activationResult.artifacts) || activationResult.artifacts.length === 0) {
        throw new Error('Native Goal activation must identify the verified approved artifacts.');
      }
      const receipt = Object.freeze({
        schema_version: 1,
        kind: 'cruise_observed_native_goal_activation',
        session_id: sessionId,
        run_id: runId,
        interaction_id: nonEmptyRuntimeString(interactionId, 'interactionId'),
        thread_id: nonEmptyRuntimeString(threadId, 'threadId'),
        ordinal: ++metadata.ordinal,
        observed_at: observedAt(now),
      });
      NATIVE_GOAL_ACTIVATION_RECEIPTS.set(receipt, {
        broker,
        activationResult,
        approvedSnapshot,
      });
      return receipt;
    },
  });
  INTERACTION_BROKERS.set(broker, metadata);
  return broker;
}

export function invalidateMilestoneControllerInteractionBroker(
  broker,
  reason = 'session_ended',
) {
  const metadata = broker && INTERACTION_BROKERS.get(broker);
  if (!metadata) return false;
  metadata.active = false;
  metadata.invalidatedReason = nonEmptyRuntimeString(reason, 'reason');
  return true;
}

export function milestoneControllerSelectionId(value) {
  const label = String(value ?? '');
  if (!label.startsWith(MILESTONE_CONTROLLER_SELECTION_PREFIX)) return null;
  const milestoneId = label.slice(MILESTONE_CONTROLLER_SELECTION_PREFIX.length);
  return MILESTONE_ID.test(milestoneId) ? milestoneId : null;
}

function normalizeVerifiedControllerSnapshot(verification) {
  if (!isVerifiedBuildApproval(verification)) {
    throw new Error('Build approval is absent, forged, stale, or not verifier-attested.');
  }
  const snapshot = requireRecord(
    verification.manifest ?? verification.controller_snapshot,
    'verified Build manifest',
  );
  const label = verification.selected_label ?? verification.label ?? snapshot.label;
  if (label !== 'Approve Milestone') {
    throw new Error('Verified Build manifest requires exact label Approve Milestone.');
  }
  const approvedAt =
    verification.captured_at ?? verification.approved_at ?? snapshot.approved_at;
  const milestoneId = requireString(snapshot.milestone_id, 'controller_snapshot.milestone_id');
  if (!MILESTONE_ID.test(milestoneId)) {
    throw new Error('controller_snapshot.milestone_id must use M-XX.');
  }
  const milestonePath = assertSafeRelativePath(
    snapshot.milestone_path,
    'controller_snapshot.milestone_path',
  );
  const pathMatch = milestonePath.match(MILESTONE_PATH);
  if (!pathMatch || pathMatch[1] !== milestoneId) {
    throw new Error('Verified Build controller_snapshot milestone path and ID do not match.');
  }
  const contractDigest = runtimeDigest(
    snapshot.contract_digest,
    'controller_snapshot.contract_digest',
  );
  requireTimestamp(approvedAt, 'verified Build approved_at');
  if (!Array.isArray(snapshot.locked_artifacts) || snapshot.locked_artifacts.length === 0) {
    throw new Error('Verified Build controller_snapshot requires locked_artifacts.');
  }
  const lockedArtifacts = snapshot.locked_artifacts.map((candidate, index) => {
    const artifact = requireRecord(candidate, `controller_snapshot.locked_artifacts[${index}]`);
    return Object.freeze({
      path: assertSafeRelativePath(
        artifact.path,
        `controller_snapshot.locked_artifacts[${index}].path`,
      ),
      sha256: runtimeDigest(
        artifact.sha256,
        `controller_snapshot.locked_artifacts[${index}].sha256`,
      ),
    });
  });
  if (milestoneContractDigest(lockedArtifacts) !== contractDigest) {
    throw new Error('Verified Build controller_snapshot locked manifest digest is invalid.');
  }
  const approvalDigest = runtimeDigest(
    verification.approval_digest,
    'verified Build approval_digest',
  );
  const approvedPhaseContract = requireRecord(
    verification.milestone_phase_dag,
    'verified Build milestone_phase_dag',
  );
  const phaseDag = validatePhaseDag(approvedPhaseContract.controller_phase_dag);
  if (approvedPhaseContract.completion_fence === undefined) {
    throw new Error('Verified Build milestone_phase_dag requires completion_fence.');
  }
  const completionFence = typeof approvedPhaseContract.completion_fence === 'string'
    ? requireString(
        approvedPhaseContract.completion_fence,
        'verified Build milestone_phase_dag.completion_fence',
      )
    : canonicalJson(approvedPhaseContract.completion_fence);
  return Object.freeze({
    label,
    approved_at: approvedAt,
    milestone_id: milestoneId,
    milestone_path: milestonePath,
    contract_digest: contractDigest,
    locked_artifacts: Object.freeze(lockedArtifacts),
    approval_digest: approvalDigest,
    phase_dag: Object.freeze(phaseDag.map((phase) => Object.freeze({
      ...phase,
      depends_on: Object.freeze([...phase.depends_on]),
      acceptance_criteria: Object.freeze([...phase.acceptance_criteria]),
    }))),
    completion_fence: completionFence,
  });
}

/**
 * Create current-session controller authority only through a trusted Build
 * verifier call and an exact structured option selected by the direct user.
 */
export async function establishMilestoneControllerAuthority({
  interactionBroker,
  selectionReceipt,
  verifiedBuildApproval,
  now = () => new Date(),
} = {}) {
  const brokerMetadata = interactionBrokerMetadata(interactionBroker);
  const selection = selectionReceipt && STRUCTURED_SELECTION_RECEIPTS.get(selectionReceipt);
  if (
    !selection ||
    selection.broker !== interactionBroker ||
    selectionReceipt.session_id !== brokerMetadata.sessionId ||
    selectionReceipt.run_id !== brokerMetadata.runId
  ) {
    throw new Error(
      'Milestone-controller authority requires an opaque current-session structured-selection receipt.',
    );
  }
  const controllerSnapshot = normalizeVerifiedControllerSnapshot(verifiedBuildApproval);
  if (controllerSnapshot.milestone_id !== selection.milestoneId) {
    throw new Error(
      'The direct-user milestone selection does not match the verified Build approval.',
    );
  }

  const authority = Object.freeze({
    schema_version: 1,
    kind: 'cruise_milestone_controller_authority',
    session_id: brokerMetadata.sessionId,
    run_id: brokerMetadata.runId,
    interaction_id: selectionReceipt.interaction_id,
    selection_ordinal: selectionReceipt.ordinal,
    milestone_id: controllerSnapshot.milestone_id,
    milestone_path: controllerSnapshot.milestone_path,
    contract_digest: controllerSnapshot.contract_digest,
    build_approval_digest: controllerSnapshot.approval_digest,
    authorized_at: nowTimestamp(now, 'authorized_at'),
  });
  CONTROLLER_AUTHORITIES.set(authority, {
    active: true,
    invalidatedReason: null,
    controllerSnapshot,
    interactionBroker,
  });
  return authority;
}

export function isMilestoneControllerAuthority(
  authority,
  { sessionId = null, runId = null } = {},
) {
  const metadata = authority && CONTROLLER_AUTHORITIES.get(authority);
  return Boolean(
    metadata?.active === true &&
      (sessionId === null || authority.session_id === sessionId) &&
      (runId === null || authority.run_id === runId),
  );
}

export function invalidateMilestoneControllerAuthority(
  authority,
  reason = 'cancelled',
) {
  const metadata = authority && CONTROLLER_AUTHORITIES.get(authority);
  if (!metadata) return false;
  metadata.active = false;
  metadata.invalidatedReason = nonEmptyRuntimeString(reason, 'reason');
  revokeDangerousForAuthority(authority, metadata.invalidatedReason);
  return true;
}

function authoritySnapshot(authority, { sessionId = null, runId = null } = {}) {
  if (!isMilestoneControllerAuthority(authority, { sessionId, runId })) {
    throw new Error('Milestone-controller authority is absent, forged, stale, or belongs to another session/run.');
  }
  return CONTROLLER_AUTHORITIES.get(authority).controllerSnapshot;
}

export function readMilestoneControllerAuthority(
  authority,
  { sessionId = null, runId = null } = {},
) {
  const snapshot = authoritySnapshot(authority, { sessionId, runId });
  return Object.freeze({
    session_id: authority.session_id,
    run_id: authority.run_id,
    interaction_id: authority.interaction_id,
    selection_ordinal: authority.selection_ordinal,
    milestone_id: authority.milestone_id,
    milestone_path: authority.milestone_path,
    contract_digest: authority.contract_digest,
    build_approval_digest: authority.build_approval_digest,
    authorized_at: authority.authorized_at,
    build_approval: snapshot,
  });
}

function normalizedActivationArtifacts(artifacts, label) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error(`${label} must contain approved artifacts.`);
  }
  const seen = new Set();
  return artifacts.map((candidate, index) => {
    const artifact = requireRecord(candidate, `${label}[${index}]`);
    const path = assertSafeRelativePath(artifact.path, `${label}[${index}].path`);
    if (seen.has(path)) throw new Error(`${label} contains duplicate path ${path}.`);
    seen.add(path);
    return {
      path,
      sha256: runtimeDigest(artifact.sha256, `${label}[${index}].sha256`),
    };
  }).sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

function goalActivationDigest(fields) {
  return createHash('sha256')
    .update('cruise-milestone-goal-activation-v1\0')
    .update(canonicalJson(fields))
    .digest('hex');
}

/**
 * Join a host-observed confirmed native Goal activation to the exact approved
 * Goal snapshot and current controller inspection. The returned capability is
 * opaque and cannot be recreated from serialized Goal/controller fields.
 */
export async function establishMilestoneControllerGoalActivation({
  cwd,
  authority,
  controllerInspection,
  activationReceipt,
  now = () => new Date(),
} = {}) {
  const controllerMetadata = CONTROLLER_AUTHORITIES.get(authority);
  const receipt = activationReceipt && NATIVE_GOAL_ACTIVATION_RECEIPTS.get(activationReceipt);
  if (
    !controllerMetadata?.active ||
    !receipt ||
    receipt.broker !== controllerMetadata.interactionBroker ||
    activationReceipt.session_id !== authority.session_id ||
    activationReceipt.run_id !== authority.run_id ||
    activationReceipt.ordinal <= authority.selection_ordinal
  ) {
    throw new Error(
      'Goal activation authority requires a later opaque host-observed native activation receipt.',
    );
  }
  const approvedSnapshot = receipt.approvedSnapshot;
  if (
    approvedSnapshot?.stage !== 'goal' ||
    approvedSnapshot.controllerAuthority !== authority ||
    !approvedSnapshot.baseline ||
    !SHA256.test(String(approvedSnapshot.baseline.sha256 ?? ''))
  ) {
    throw new Error('Goal activation receipt is not bound to this controller and approved Goal snapshot.');
  }
  const freshInspection = await assertFreshControllerInspection(
    cwd,
    authority,
    controllerInspection,
  );
  const approvedArtifacts = normalizedActivationArtifacts(
    approvedSnapshot.artifacts,
    'approvedSnapshot.artifacts',
  );
  const activatedArtifacts = normalizedActivationArtifacts(
    receipt.activationResult.artifacts,
    'activationResult.artifacts',
  );
  if (canonicalJson(approvedArtifacts) !== canonicalJson(activatedArtifacts)) {
    throw new Error('Native Goal activation artifacts differ from the approved Goal snapshot.');
  }
  const controllerArtifact = activatedArtifacts.find(
    ({ path }) => path === MILESTONE_CONTROLLER_ARTIFACT,
  );
  if (controllerArtifact?.sha256 !== freshInspection.controllerArtifact.sha256) {
    throw new Error('Native Goal activation does not cover the current controller descriptor.');
  }
  const repositoryBaselineDigest = await freshRepositoryBaselineDigest(cwd);
  if (repositoryBaselineDigest !== approvedSnapshot.baseline.sha256) {
    throw new Error('Repository baseline drifted after Goal approval or native activation.');
  }
  const fields = {
    session_id: authority.session_id,
    run_id: authority.run_id,
    thread_id: activationReceipt.thread_id,
    activation_interaction_id: activationReceipt.interaction_id,
    milestone_id: authority.milestone_id,
    controller_digest: freshInspection.controllerArtifact.sha256,
    contract_digest: freshInspection.controller.milestone.contract_digest,
    repository_baseline_digest: repositoryBaselineDigest,
    objective_digest: sha256(Buffer.from(receipt.activationResult.objective, 'utf8')),
    artifact_manifest_digest: sha256(Buffer.from(canonicalJson(activatedArtifacts), 'utf8')),
  };
  const goalActivationAuthority = Object.freeze({
    schema_version: 1,
    kind: 'cruise_milestone_goal_activation_authority',
    ...fields,
    activation_digest: goalActivationDigest(fields),
    activated_at: nowTimestamp(now, 'activated_at'),
  });
  GOAL_ACTIVATION_AUTHORITIES.set(goalActivationAuthority, {
    active: true,
    authority,
    controllerInspection: freshInspection,
    approvedSnapshot,
    activationResult: receipt.activationResult,
  });
  return goalActivationAuthority;
}

export function isMilestoneControllerGoalActivation(
  goalActivationAuthority,
  { authority = null, runId = null } = {},
) {
  const metadata = goalActivationAuthority &&
    GOAL_ACTIVATION_AUTHORITIES.get(goalActivationAuthority);
  return Boolean(
    metadata?.active === true &&
      (authority === null || metadata.authority === authority) &&
      (runId === null || goalActivationAuthority.run_id === runId),
  );
}

function requireGoalActivation(
  goalActivationAuthority,
  authority,
  controllerInspection,
  runId,
) {
  const metadata = goalActivationAuthority &&
    GOAL_ACTIVATION_AUTHORITIES.get(goalActivationAuthority);
  if (
    !metadata?.active ||
    metadata.authority !== authority ||
    goalActivationAuthority.run_id !== runId ||
    goalActivationAuthority.session_id !== authority.session_id ||
    goalActivationAuthority.controller_digest !== controllerInspection.controllerArtifact.sha256 ||
    goalActivationAuthority.contract_digest !==
      controllerInspection.controller.milestone.contract_digest
  ) {
    throw new Error(
      'A current opaque native Goal activation authority is required for controller runtime.',
    );
  }
  return metadata;
}

/**
 * Compute the digest used to bind a milestone controller to Build contract files.
 * Runtime STATE, QUEUE-STATE, discovery, and phase files must not be passed here.
 */
function validatePhaseDag(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('phase_dag must contain at least one phase.');
  }
  const phases = new Map();
  for (const [index, candidate] of value.entries()) {
    const phase = requireRecord(candidate, `phase_dag[${index}]`);
    const id = requireString(phase.id, `phase_dag[${index}].id`);
    if (!PHASE_ID.test(id)) {
      throw new Error(`phase_dag[${index}].id must use a stable P-XX identifier.`);
    }
    if (phases.has(id)) throw new Error(`Duplicate phase identifier: ${id}.`);
    if (!Array.isArray(phase.depends_on)) {
      throw new Error(`phase_dag[${index}].depends_on must be a sequence.`);
    }
    const dependsOn = phase.depends_on.map((dependency, dependencyIndex) => {
      const dependencyId = requireString(
        dependency,
        `phase_dag[${index}].depends_on[${dependencyIndex}]`,
      );
      if (!PHASE_ID.test(dependencyId)) {
        throw new Error(`${dependencyId} is not a stable P-XX phase identifier.`);
      }
      return dependencyId;
    });
    if (new Set(dependsOn).size !== dependsOn.length) {
      throw new Error(`${id} contains duplicate phase dependencies.`);
    }
    if (!Array.isArray(phase.acceptance_criteria) || phase.acceptance_criteria.length === 0) {
      throw new Error(`${id} must bind a non-empty acceptance_criteria list.`);
    }
    const acceptanceCriteria = phase.acceptance_criteria.map((criterion, criterionIndex) => {
      const criterionId = requireString(
        criterion,
        `phase_dag[${index}].acceptance_criteria[${criterionIndex}]`,
      );
      if (!/^AC-[0-9]{2,}$/u.test(criterionId)) {
        throw new Error(`${criterionId} is not a stable AC-XX identifier.`);
      }
      return criterionId;
    });
    if (new Set(acceptanceCriteria).size !== acceptanceCriteria.length) {
      throw new Error(`${id} contains duplicate acceptance criteria.`);
    }
    phases.set(id, {
      id,
      depends_on: dependsOn,
      mandatory: requireBoolean(
        phase.mandatory,
        `phase_dag[${index}].mandatory`,
      ),
      acceptance_criteria: acceptanceCriteria,
    });
  }

  for (const phase of phases.values()) {
    for (const dependency of phase.depends_on) {
      if (dependency === phase.id) throw new Error(`${phase.id} cannot depend on itself.`);
      if (!phases.has(dependency)) {
        throw new Error(`${phase.id} depends on unknown phase ${dependency}.`);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error('phase_dag must be acyclic.');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of phases.get(id).depends_on) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of phases.keys()) visit(id);

  if (![...phases.values()].some(({ mandatory }) => mandatory)) {
    throw new Error('phase_dag must contain at least one mandatory phase.');
  }
  for (const phase of phases.values()) {
    if (
      phase.mandatory &&
      phase.depends_on.some((dependency) => phases.get(dependency).mandatory !== true)
    ) {
      throw new Error(
        `${phase.id} is mandatory and cannot depend on optional phase work.`,
      );
    }
  }
  return [...phases.values()];
}

function validateLockedPath(path, milestonePath) {
  const projectPrefix = '.cruise/project/';
  const milestonePrefix = `${milestonePath}/`;
  if (!path.startsWith(projectPrefix) && !path.startsWith(milestonePrefix)) {
    throw new Error(
      `${path} is outside the selected project and milestone contract roots.`,
    );
  }
  if (
    path.endsWith('/STATE.yaml') ||
    path.endsWith('/QUEUE-STATE.yaml') ||
    path.includes('/discovery/') ||
    path.startsWith(`${milestonePrefix}phases/`)
  ) {
    throw new Error(`${path} is mutable runtime or discovery state and must not be locked.`);
  }
}

function assertRequiredArtifacts(paths, milestonePath) {
  for (const name of REQUIRED_PROJECT_FILES) {
    const path = `.cruise/project/${name}`;
    if (!paths.has(path)) throw new Error(`Missing locked project artifact: ${path}.`);
  }
  for (const name of REQUIRED_MILESTONE_FILES) {
    const path = `${milestonePath}/${name}`;
    if (!paths.has(path)) throw new Error(`Missing locked milestone artifact: ${path}.`);
  }
}

function parseController(source) {
  let record;
  try {
    record = parseYaml(Buffer.isBuffer(source) ? source.toString('utf8') : String(source));
  } catch (cause) {
    throw new Error(`${MILESTONE_CONTROLLER_ARTIFACT} is invalid: ${cause.message}`, {
      cause,
    });
  }
  requireRecord(record, MILESTONE_CONTROLLER_ARTIFACT);
  if (record.schema_version !== 1) {
    throw new Error(`${MILESTONE_CONTROLLER_ARTIFACT} requires schema_version: 1.`);
  }
  if (record.mode !== MILESTONE_CONTROLLER_MODE) {
    throw new Error(
      `${MILESTONE_CONTROLLER_ARTIFACT} requires mode: ${MILESTONE_CONTROLLER_MODE}.`,
    );
  }

  const selection = requireRecord(record.selection, 'selection');
  if (selection.source !== 'direct_user') {
    throw new Error('selection.source must be direct_user; repository inference is forbidden.');
  }
  const decisionId = requireString(selection.decision_id, 'selection.decision_id');
  if (!DECISION_ID.test(decisionId)) {
    throw new Error('selection.decision_id must use a stable D-XX identifier.');
  }
  requireTimestamp(selection.selected_at, 'selection.selected_at');

  const milestone = requireRecord(record.milestone, 'milestone');
  const milestoneId = requireString(milestone.id, 'milestone.id');
  if (!MILESTONE_ID.test(milestoneId)) {
    throw new Error('milestone.id must use a stable M-XX identifier.');
  }
  const milestonePath = assertSafeRelativePath(milestone.path, 'milestone.path');
  const pathMatch = milestonePath.match(MILESTONE_PATH);
  if (!pathMatch || pathMatch[1] !== milestoneId) {
    throw new Error('milestone.path must name the selected .cruise/milestones/M-XX-slug directory.');
  }
  const contractDigest = requireString(
    milestone.contract_digest,
    'milestone.contract_digest',
  );
  if (!SHA256.test(contractDigest)) {
    throw new Error('milestone.contract_digest must be a lowercase SHA-256 digest.');
  }
  requireString(milestone.completion_fence, 'milestone.completion_fence');

  const approval = requireRecord(record.build_approval, 'build_approval');
  if (approval.label !== 'Approve Milestone') {
    throw new Error('build_approval.label must be exactly Approve Milestone.');
  }
  requireTimestamp(approval.approved_at, 'build_approval.approved_at');
  if (approval.contract_digest !== contractDigest) {
    throw new Error('build_approval.contract_digest must match milestone.contract_digest.');
  }

  const eligibility = requireRecord(record.eligibility, 'eligibility');
  for (const field of [
    'phase_dag_validated',
    'milestone_blockers_resolved',
    'permission_envelope_explicit',
  ]) {
    if (requireBoolean(eligibility[field], `eligibility.${field}`) !== true) {
      throw new Error(`eligibility.${field} must be true.`);
    }
  }

  const autonomy = requireRecord(record.autonomy, 'autonomy');
  if (autonomy.mode !== 'interactive') {
    throw new Error(
      'autonomy.mode must remain interactive; dangerous authorization is separate runtime state.',
    );
  }

  const phaseDag = validatePhaseDag(record.phase_dag);
  if (!Array.isArray(record.locked_artifacts) || record.locked_artifacts.length === 0) {
    throw new Error('locked_artifacts must contain the approved Build contract manifest.');
  }
  const lockedArtifacts = record.locked_artifacts.map((candidate, index) => {
    const artifact = requireRecord(candidate, `locked_artifacts[${index}]`);
    const path = assertSafeRelativePath(
      artifact.path,
      `locked_artifacts[${index}].path`,
    );
    validateLockedPath(path, milestonePath);
    const artifactDigest = requireString(
      artifact.sha256,
      `locked_artifacts[${index}].sha256`,
    );
    if (!SHA256.test(artifactDigest)) {
      throw new Error(
        `locked_artifacts[${index}].sha256 must be a lowercase SHA-256 digest.`,
      );
    }
    return { path, sha256: artifactDigest };
  });
  const paths = new Set(lockedArtifacts.map(({ path }) => path));
  if (paths.size !== lockedArtifacts.length) {
    throw new Error('locked_artifacts paths must be unique.');
  }
  assertRequiredArtifacts(paths, milestonePath);
  if (milestoneContractDigest(lockedArtifacts) !== contractDigest) {
    throw new Error('milestone.contract_digest does not match locked_artifacts.');
  }

  return Object.freeze({
    schema_version: 1,
    mode: MILESTONE_CONTROLLER_MODE,
    selection: Object.freeze({
      source: selection.source,
      decision_id: decisionId,
      selected_at: selection.selected_at,
    }),
    milestone: Object.freeze({
      id: milestoneId,
      path: milestonePath,
      contract_digest: contractDigest,
      completion_fence: milestone.completion_fence,
    }),
    build_approval: Object.freeze({
      label: approval.label,
      approved_at: approval.approved_at,
      contract_digest: approval.contract_digest,
    }),
    eligibility: Object.freeze({ ...eligibility }),
    autonomy: Object.freeze({ mode: autonomy.mode }),
    phase_dag: Object.freeze(phaseDag.map((phase) => Object.freeze(phase))),
    locked_artifacts: Object.freeze(
      lockedArtifacts.map((artifact) => Object.freeze(artifact)),
    ),
  });
}

export function parseMilestoneController(source) {
  return parseController(source);
}

async function readRegularArtifact(repositoryRoot, relativePath) {
  const absolutePath = join(repositoryRoot, relativePath);
  let metadata;
  try {
    metadata = await lstat(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Missing locked milestone-controller artifact: ${relativePath}.`);
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size === 0) {
    throw new Error(`${relativePath} must be a non-empty regular file.`);
  }
  const resolved = await realpath(absolutePath);
  if (
    resolved !== absolutePath ||
    (resolved !== repositoryRoot && !resolved.startsWith(`${repositoryRoot}${sep}`))
  ) {
    throw new Error(`${relativePath} resolves outside the repository or through a symlink.`);
  }
  const bytes = await readFile(absolutePath);
  return {
    path: relativePath,
    absolutePath,
    sha256: sha256(bytes),
    bytes,
  };
}

function questionEntries(artifact) {
  let record;
  try {
    record = parseYaml(artifact.bytes.toString('utf8'));
  } catch (cause) {
    throw new Error(`${artifact.path} is invalid: ${cause.message}`, { cause });
  }
  const questions = Array.isArray(record) ? record : record?.questions;
  if (!Array.isArray(questions)) {
    throw new Error(`${artifact.path} must contain a questions sequence.`);
  }
  return questions;
}

function assertNoMilestoneBlockers(artifacts, milestonePath) {
  const questionsArtifact = artifacts.find(
    ({ path }) => path === `${milestonePath}/QUESTIONS.yaml`,
  );
  const ids = [];
  const numbers = [];
  for (const [index, question] of questionEntries(questionsArtifact).entries()) {
    if (!isRecord(question)) {
      throw new Error(`${questionsArtifact.path} questions[${index}] must be a mapping.`);
    }
    if (QUESTION_ID.test(String(question.id ?? ''))) {
      const number = Number(String(question.id).slice(2));
      if (!Number.isSafeInteger(number)) {
        throw new Error(`${questionsArtifact.path} question ${question.id} exceeds the runtime ID range.`);
      }
      if (ids.includes(question.id)) {
        throw new Error(`${questionsArtifact.path} contains duplicate question ID ${question.id}.`);
      }
      ids.push(question.id);
      numbers.push(number);
    }
    if (
      question.status === 'open' &&
      ['project_blocking', 'milestone_blocking'].includes(question.materiality)
    ) {
      throw new Error(
        `${questionsArtifact.path} contains unresolved ${question.materiality} question ${question.id ?? index}.`,
      );
    }
  }
  const lockedQuestionMax = numbers.length === 0 ? 0 : Math.max(...numbers);
  return Object.freeze({
    lockedQuestionIds: Object.freeze([...ids]),
    lockedQuestionMax,
  });
}

function lockedQuestionIdentity(artifacts, milestonePath) {
  const milestoneQuestions = assertNoMilestoneBlockers(artifacts, milestonePath);
  const registryArtifact = artifacts.find(
    ({ path }) => path === '.cruise/project/ID-REGISTRY.yaml',
  );
  let registry;
  try {
    registry = parseYaml(registryArtifact.bytes.toString('utf8'));
  } catch (cause) {
    throw new Error(`${registryArtifact.path} is invalid: ${cause.message}`, { cause });
  }
  const registryQuestionMax = registry?.namespaces?.Q?.last_allocated;
  if (!Number.isSafeInteger(registryQuestionMax) || registryQuestionMax < 0) {
    throw new Error(`${registryArtifact.path} has an invalid Q namespace high-water mark.`);
  }
  const registryQuestionIds = [];
  for (const [index, record] of (registry?.records ?? []).entries()) {
    if (!isRecord(record)) {
      throw new Error(`${registryArtifact.path} records[${index}] must be a mapping.`);
    }
    if (record.namespace !== 'Q' && !QUESTION_ID.test(String(record.id ?? ''))) continue;
    if (!QUESTION_ID.test(String(record.id ?? '')) || record.namespace !== 'Q') {
      throw new Error(`${registryArtifact.path} has an inconsistent Q namespace record.`);
    }
    const number = Number(record.id.slice(2));
    if (!Number.isSafeInteger(number) || number !== record.number) {
      throw new Error(`${registryArtifact.path} Q record ${record.id} has an invalid numeric slot.`);
    }
    registryQuestionIds.push(record.id);
  }
  if (
    new Set(registryQuestionIds).size !== registryQuestionIds.length ||
    Math.max(0, ...registryQuestionIds.map((id) => Number(id.slice(2)))) !== registryQuestionMax
  ) {
    throw new Error(`${registryArtifact.path} Q records disagree with their high-water mark.`);
  }
  const registryIds = new Set(registryQuestionIds);
  for (const id of milestoneQuestions.lockedQuestionIds) {
    if (!registryIds.has(id)) {
      throw new Error(`${milestonePath}/QUESTIONS.yaml reuses unregistered question ID ${id}.`);
    }
  }
  const lockedQuestionMax = Math.max(
    milestoneQuestions.lockedQuestionMax,
    registryQuestionMax,
  );
  return Object.freeze({
    lockedQuestionIds: Object.freeze([...registryQuestionIds]),
    milestoneQuestionIds: milestoneQuestions.lockedQuestionIds,
    lockedQuestionMax,
    runtimeQuestionSeed: lockedQuestionMax + 1,
  });
}

function assertAutonomyPolicy(artifacts, controller) {
  const path = `${controller.milestone.path}/AUTONOMY.yaml`;
  const artifact = artifacts.find((candidate) => candidate.path === path);
  let record;
  try {
    record = parseYaml(artifact.bytes.toString('utf8'));
  } catch (cause) {
    throw new Error(`${path} is invalid: ${cause.message}`, { cause });
  }
  const policy = isRecord(record?.autonomy) ? record.autonomy : record;
  if (!isRecord(policy) || policy.mode !== controller.autonomy.mode) {
    throw new Error(`${path} mode must match the milestone controller autonomy mode.`);
  }
  if (!Array.isArray(policy.hard_stops) || policy.hard_stops.length === 0) {
    throw new Error(`${path} must declare at least one hard stop.`);
  }
}

function assertPhaseDagMatchesRoadmap(artifacts, controller) {
  const path = `${controller.milestone.path}/ROADMAP.md`;
  const artifact = artifacts.find((candidate) => candidate.path === path);
  const roadmap = artifact.bytes.toString('utf8');
  for (const phase of controller.phase_dag) {
    const escaped = phase.id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    if (!new RegExp(`(?:^|[^A-Za-z0-9-])${escaped}(?:$|[^A-Za-z0-9-])`, 'mu').test(roadmap)) {
      throw new Error(`${path} does not contain controller phase ${phase.id}.`);
    }
  }
}

function legacyMilestoneInspection() {
  return Object.freeze({
    mode: SINGLE_SLICE_MODE,
    controllerArtifact: null,
    controller: null,
    lockedArtifacts: Object.freeze([]),
    authority: null,
  });
}

function assertControllerMatchesAuthority(controller, snapshot) {
  if (
    controller.milestone.id !== snapshot.milestone_id ||
    controller.milestone.path !== snapshot.milestone_path ||
    controller.milestone.contract_digest !== snapshot.contract_digest
  ) {
    throw new Error('The controller descriptor does not match the verifier-attested Build milestone.');
  }
  if (
    controller.milestone.completion_fence !== snapshot.completion_fence ||
    canonicalJson(controller.phase_dag) !== canonicalJson(snapshot.phase_dag)
  ) {
    throw new Error(
      'The controller phase DAG or completion fence differs from the verifier-attested Build contract.',
    );
  }
  if (
    controller.build_approval.label !== snapshot.label ||
    controller.build_approval.approved_at !== snapshot.approved_at ||
    controller.build_approval.contract_digest !== snapshot.contract_digest
  ) {
    throw new Error('The controller descriptor Build approval is self-declared or stale.');
  }
  if (controller.locked_artifacts.length !== snapshot.locked_artifacts.length) {
    throw new Error('The controller locked manifest differs from the verified Build approval.');
  }
  const approved = new Map(
    snapshot.locked_artifacts.map((artifact) => [artifact.path, artifact.sha256]),
  );
  for (const artifact of controller.locked_artifacts) {
    if (approved.get(artifact.path) !== artifact.sha256) {
      throw new Error(`${artifact.path} is not part of the verifier-attested Build manifest.`);
    }
  }
}

export function milestonePermissionEnvelopeDigest(controller) {
  const parsed = controller?.mode === MILESTONE_CONTROLLER_MODE
    ? controller
    : parseController(controller);
  const policyPath = `${parsed.milestone.path}/AUTONOMY.yaml`;
  const policyArtifact = parsed.locked_artifacts.find(({ path }) => path === policyPath);
  if (!policyArtifact) throw new Error('The milestone permission envelope is not locked.');
  const hash = createHash('sha256');
  hash.update('cruise-milestone-permission-envelope-v1\0');
  hash.update(parsed.milestone.id);
  hash.update('\0');
  hash.update(parsed.milestone.contract_digest);
  hash.update('\0');
  hash.update(policyArtifact.path);
  hash.update('\0');
  hash.update(policyArtifact.sha256);
  hash.update('\0');
  hash.update(parsed.autonomy.mode);
  return hash.digest('hex');
}

/**
 * Descriptor presence is only data. Controller mode is selected solely by an
 * active current-session authority joined from an observed user option and a
 * verifier-attested persisted Build approval.
 */
export async function inspectMilestoneController(
  cwd,
  { authority = null, sessionId = null, runId = null } = {},
) {
  if (authority === null || authority === undefined) {
    return legacyMilestoneInspection();
  }
  const verifiedSnapshot = authoritySnapshot(authority, { sessionId, runId });
  const repositoryRoot = await realpath(resolve(cwd));
  const controllerPath = join(repositoryRoot, MILESTONE_CONTROLLER_ARTIFACT);
  try {
    await lstat(controllerPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        `${MILESTONE_CONTROLLER_ARTIFACT} is required by the current controller selection.`,
      );
    }
    throw error;
  }

  const controllerArtifact = await readRegularArtifact(
    repositoryRoot,
    MILESTONE_CONTROLLER_ARTIFACT,
  );
  const controller = parseController(controllerArtifact.bytes);
  assertControllerMatchesAuthority(controller, verifiedSnapshot);
  const lockedArtifacts = [];
  for (const expected of controller.locked_artifacts) {
    const artifact = await readRegularArtifact(repositoryRoot, expected.path);
    if (artifact.sha256 !== expected.sha256) {
      throw new Error(`${expected.path} changed after Build milestone approval.`);
    }
    lockedArtifacts.push(artifact);
  }
  if (milestoneContractDigest(lockedArtifacts) !== controller.milestone.contract_digest) {
    throw new Error('The current Build milestone contract digest does not match the controller.');
  }
  const questionIdentity = lockedQuestionIdentity(
    lockedArtifacts,
    controller.milestone.path,
  );
  assertAutonomyPolicy(lockedArtifacts, controller);
  assertPhaseDagMatchesRoadmap(lockedArtifacts, controller);

  const inspection = Object.freeze({
    mode: MILESTONE_CONTROLLER_MODE,
    controllerArtifact,
    controller,
    lockedArtifacts: Object.freeze(lockedArtifacts),
    authority,
    authoritySnapshot: readMilestoneControllerAuthority(authority, {
      sessionId,
      runId,
    }),
    permissionEnvelopeDigest: milestonePermissionEnvelopeDigest(controller),
    lockedQuestionIds: questionIdentity.lockedQuestionIds,
    lockedQuestionMax: questionIdentity.lockedQuestionMax,
    runtimeQuestionSeed: questionIdentity.runtimeQuestionSeed,
  });
  CONTROLLER_INSPECTIONS.set(inspection, { authority });
  return inspection;
}

function deepFreezeRuntime(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeRuntime(child);
  return Object.freeze(value);
}

function brandControllerState(state, metadata) {
  const frozen = deepFreezeRuntime(state);
  CONTROLLER_STATES.set(frozen, Object.freeze({ ...metadata }));
  return frozen;
}

function requireControllerStateProvenance(state, goalActivationAuthority = null) {
  const metadata = state && CONTROLLER_STATES.get(state);
  if (
    !metadata ||
    (goalActivationAuthority !== null &&
      metadata.goalActivationAuthority !== goalActivationAuthority)
  ) {
    throw new Error(
      'Controller state lacks trusted create/reducer/load provenance bound to Goal activation.',
    );
  }
  return metadata;
}

export function isMilestoneControllerStateProvenance(state) {
  return Boolean(state && CONTROLLER_STATES.has(state));
}

function stateBrandMetadata(state) {
  return state && CONTROLLER_STATES.get(state);
}

function rebrandControllerState(
  next,
  priorState,
  transition,
  { baselineAuthority = 'unchanged', goalActivationAuthority = null } = {},
) {
  const priorMetadata = priorState && CONTROLLER_STATES.get(priorState);
  const activation = goalActivationAuthority ?? priorMetadata?.goalActivationAuthority ?? null;
  if (!activation) {
    throw new Error('Controller transition requires opaque Goal activation provenance.');
  }
  return brandControllerState(next, {
    goalActivationAuthority: activation,
    parentState: priorState ?? null,
    transition,
    baselineAuthority,
  });
}

async function assertFreshControllerInspection(cwd, authority, expected) {
  const current = await inspectMilestoneController(cwd, {
    authority,
    sessionId: authority?.session_id ?? null,
    runId: authority?.run_id ?? null,
  });
  if (
    current.controllerArtifact.sha256 !== expected?.controllerArtifact?.sha256 ||
    current.controller.milestone.contract_digest !==
      expected?.controller?.milestone?.contract_digest ||
    current.permissionEnvelopeDigest !== expected?.permissionEnvelopeDigest
  ) {
    throw new Error('Controller or locked Build manifest drifted since the prior checkpoint.');
  }
  return current;
}

function comparePhaseIds(left, right) {
  const leftNumber = Number(String(left).slice(2));
  const rightNumber = Number(String(right).slice(2));
  return leftNumber - rightNumber || String(left).localeCompare(String(right), 'en');
}

function sortedPhaseIds(ids) {
  return [...ids].sort(comparePhaseIds);
}

function phaseById(state) {
  return new Map(state.phases.map((phase) => [phase.id, phase]));
}

function computeReadyPhaseIds(phases) {
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  return sortedPhaseIds(
    phases
      .filter(
        (phase) =>
          phase.status === 'ready' &&
          phase.depends_on.every((dependency) => byId.get(dependency)?.status === 'completed'),
      )
      .map(({ id }) => id),
  );
}

function refreshPendingReadiness(state) {
  const byId = phaseById(state);
  for (const phase of state.phases) {
    if (
      phase.status === 'pending' &&
      phase.depends_on.every((dependency) => byId.get(dependency)?.status === 'completed')
    ) {
      phase.status = 'ready';
    }
  }
  state.ready_phase_ids = computeReadyPhaseIds(state.phases);
}

function bumpControllerState(state, now) {
  state.revision += 1;
  state.updated_at = nowTimestamp(now, 'updated_at');
}

function requireControllerInspection(inspection, authority, runId) {
  const attestation = inspection && CONTROLLER_INSPECTIONS.get(inspection);
  if (
    attestation?.authority !== authority ||
    !inspection ||
    inspection.mode !== MILESTONE_CONTROLLER_MODE ||
    inspection.authority !== authority ||
    !inspection.controllerArtifact ||
    !inspection.controller
  ) {
    throw new Error('A current authority-bound milestone-controller inspection is required.');
  }
  authoritySnapshot(authority, { runId });
  return inspection;
}

function validateEvidenceIds(evidenceRecord, evidenceIds, runId, label) {
  validateEvidenceRecord(evidenceRecord);
  if (evidenceRecord.run_id !== runId) {
    throw new Error(`${label} evidence must belong to the current controller run.`);
  }
  if (
    !Array.isArray(evidenceIds) ||
    evidenceIds.length === 0 ||
    new Set(evidenceIds).size !== evidenceIds.length ||
    evidenceIds.some((id) => typeof id !== 'string' || !EVIDENCE_ID.test(id))
  ) {
    throw new Error(`${label} requires a non-empty unique E-XX evidence list.`);
  }
  const items = new Map(evidenceRecord.items.map((item) => [item.id, item]));
  for (const id of evidenceIds) {
    const item = items.get(id);
    if (
      !item ||
      item.performed !== true ||
      item.status !== 'PASS' ||
      item.gate !== 'mandatory'
    ) {
      throw new Error(
        `${label} evidence ${id} must be an actually performed mandatory PASS.`,
      );
    }
  }
  return Object.freeze([...evidenceIds]);
}

function normalizePhaseOwnership(ownership) {
  if (!Array.isArray(ownership) || ownership.length === 0) {
    throw new Error('Phase plan ownership must be a non-empty exact path list.');
  }
  const normalized = ownership.map((path, index) =>
    assertSafeRelativePath(path, `ownership[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Phase plan ownership paths must be unique.');
  }
  return Object.freeze(normalized.sort((left, right) => left.localeCompare(right, 'en')));
}

function permissionScopeDigest(scope) {
  const record = requireRecord(scope, 'phase permission scope');
  const serialized = canonicalJson(record);
  return createHash('sha256')
    .update('cruise-phase-permission-scope-v1\0')
    .update(serialized)
    .digest('hex');
}

async function freshRepositoryBaselineDigest(cwd) {
  const { captureRepositoryBaseline } = await import('./goal-contract.mjs');
  return runtimeDigest(
    captureRepositoryBaseline(cwd).sha256,
    'current repository baseline digest',
  );
}

async function readPhaseEvidence(repositoryRoot, state, phaseId) {
  const path = `${state.milestone_path}/phases/${phaseId}/EVIDENCE.yaml`;
  const artifact = await readRegularArtifact(repositoryRoot, path);
  let record;
  try {
    record = parseYaml(artifact.bytes.toString('utf8'));
    validateEvidenceRecord(record);
  } catch (cause) {
    throw new Error(`${path} is not a valid evidence record: ${cause.message}`, { cause });
  }
  return { path, artifact, record };
}

function assertStateMatchesInspection(state, inspection) {
  if (
    state.controller_digest !== inspection.controllerArtifact.sha256 ||
    state.contract_digest !== inspection.controller.milestone.contract_digest ||
    state.permission_envelope_digest !== inspection.permissionEnvelopeDigest ||
    state.milestone_id !== inspection.controller.milestone.id ||
    state.milestone_path !== inspection.controller.milestone.path ||
    state.completion_fence !== inspection.controller.milestone.completion_fence
  ) {
    throw new Error('Controller runtime state drifted from the current locked controller.');
  }
  const approvedPhases = [...inspection.controller.phase_dag].sort((left, right) =>
    comparePhaseIds(left.id, right.id));
  if (state.phases.length !== approvedPhases.length) {
    throw new Error('Controller runtime phase set differs from the approved phase DAG.');
  }
  for (let index = 0; index < approvedPhases.length; index += 1) {
    const phase = state.phases[index];
    const approved = approvedPhases[index];
    if (
      phase.id !== approved.id ||
      phase.mandatory !== approved.mandatory ||
      JSON.stringify(phase.depends_on) !== JSON.stringify(sortedPhaseIds(approved.depends_on)) ||
      JSON.stringify(phase.acceptance_criteria) !==
        JSON.stringify([...approved.acceptance_criteria])
    ) {
      throw new Error(`Controller runtime phase ${phase.id ?? index} differs from the approved DAG.`);
    }
  }
}

function validateControllerQuestionState(record, inspection) {
  const cursor = requireRecord(record.question_cursor, 'state.question_cursor');
  if (
    !Number.isSafeInteger(cursor.next_question_number) ||
    cursor.next_question_number < 1 ||
    !Number.isSafeInteger(cursor.pause_count) ||
    cursor.pause_count < 0
  ) {
    throw new Error('Controller question cursor counters must be non-negative safe integers.');
  }
  if (
    cursor.locked_question_max !== inspection.lockedQuestionMax ||
    cursor.runtime_question_seed !== inspection.runtimeQuestionSeed
  ) {
    throw new Error('Controller question cursor differs from the locked Build question range.');
  }
  const lockedQuestionIds = new Set(inspection.lockedQuestionIds);
  const seen = new Set();
  const runtimeQuestionNumbers = [];
  const open = [];
  let maximumQuestionNumber = 0;
  let pauseEvents = 0;
  for (const phase of record.phases) {
    if (!Array.isArray(phase.questions) || !Array.isArray(phase.question_events)) {
      throw new Error(`${phase.id} requires persisted questions and question events.`);
    }
    const phaseQuestions = new Map();
    for (const [index, question] of phase.questions.entries()) {
      requireRecord(question, `${phase.id}.questions[${index}]`);
      if (!QUESTION_ID.test(question.id) || seen.has(question.id)) {
        throw new Error('Controller runtime questions require unique stable Q-XX identifiers.');
      }
      seen.add(question.id);
      phaseQuestions.set(question.id, question);
      const questionNumber = Number(question.id.slice(2));
      if (
        lockedQuestionIds.has(question.id) ||
        questionNumber < inspection.runtimeQuestionSeed
      ) {
        throw new Error(`${question.id} collides with the locked Build question namespace.`);
      }
      runtimeQuestionNumbers.push(questionNumber);
      maximumQuestionNumber = Math.max(maximumQuestionNumber, questionNumber);
      if (!['open', 'answered', 'closed'].includes(question.status)) {
        throw new Error(`${question.id} has an invalid runtime question status.`);
      }
      nonEmptyRuntimeString(question.question, `${question.id}.question`);
      if (!QUESTION_MATERIALITIES.has(question.materiality)) {
        throw new Error(`${question.id} has an invalid materiality.`);
      }
      nonEmptyRuntimeString(question.rationale, `${question.id}.rationale`);
      nonEmptyRuntimeString(question.reopening_trigger, `${question.id}.reopening_trigger`);
      requireTimestamp(question.asked_at, `${question.id}.asked_at`);
      if (!Number.isSafeInteger(question.reopen_count) || question.reopen_count < 0) {
        throw new Error(`${question.id}.reopen_count must be non-negative.`);
      }
      if (question.status === 'open') {
        if (
          question.answer !== null ||
          question.answer_source !== null ||
          question.answered_at !== null ||
          question.closed_at !== null ||
          question.closure_reason !== null
        ) {
          throw new Error(`${question.id} open state cannot retain an answer.`);
        }
        open.push({ question, phase });
      } else if (question.status === 'answered') {
        nonEmptyRuntimeString(question.answer, `${question.id}.answer`);
        if (!['direct_user', 'repository_evidence'].includes(question.answer_source)) {
          throw new Error(`${question.id}.answer_source is invalid.`);
        }
        requireTimestamp(question.answered_at, `${question.id}.answered_at`);
        if (question.closed_at !== null || question.closure_reason !== null) {
          throw new Error(`${question.id} answered state cannot also be closed.`);
        }
      } else {
        if (question.answer !== null || question.answer_source !== null || question.answered_at !== null) {
          throw new Error(`${question.id} closed state cannot claim an answer.`);
        }
        requireTimestamp(question.closed_at, `${question.id}.closed_at`);
        nonEmptyRuntimeString(question.closure_reason, `${question.id}.closure_reason`);
      }
    }
    const replay = new Map();
    for (const [index, event] of phase.question_events.entries()) {
      requireRecord(event, `${phase.id}.question_events[${index}]`);
      if (
        event.sequence !== index + 1 ||
        !['opened', 'answered', 'reopened', 'closed'].includes(event.type) ||
        !phaseQuestions.has(event.question_id)
      ) {
        throw new Error(`${phase.id} question event history is invalid or non-append-only.`);
      }
      requireTimestamp(event.at, `${phase.id}.question_events[${index}].at`);
      const question = phaseQuestions.get(event.question_id);
      const prior = replay.get(event.question_id) ?? null;
      if (event.type === 'opened') {
        if (prior !== null || event.at !== question.asked_at) {
          throw new Error(`${phase.id} question history must open each question exactly once.`);
        }
        replay.set(event.question_id, {
          status: 'open',
          reopenCount: 0,
          latestAnswer: null,
          latestAnswerSource: null,
          latestAnsweredAt: null,
          closedAt: null,
          closureReason: null,
        });
        pauseEvents += 1;
      } else if (event.type === 'answered') {
        if (prior?.status !== 'open') {
          throw new Error(`${phase.id} question history may answer only an open question.`);
        }
        nonEmptyRuntimeString(event.answer, `${phase.id}.question_events[${index}].answer`);
        if (!['direct_user', 'repository_evidence'].includes(event.answer_source)) {
          throw new Error(`${phase.id} answered question event has an invalid source.`);
        }
        replay.set(event.question_id, {
          ...prior,
          status: 'answered',
          latestAnswer: event.answer,
          latestAnswerSource: event.answer_source,
          latestAnsweredAt: event.at,
        });
      } else if (event.type === 'reopened') {
        if (prior?.status !== 'answered' || event.trigger !== question.reopening_trigger) {
          throw new Error(`${phase.id} question history has an invalid reopening transition.`);
        }
        replay.set(event.question_id, {
          ...prior,
          status: 'open',
          reopenCount: prior.reopenCount + 1,
          closedAt: null,
          closureReason: null,
        });
        pauseEvents += 1;
      } else if (event.type === 'closed') {
        if (prior?.status !== 'open') {
          throw new Error(`${phase.id} question history may close only an open question.`);
        }
        nonEmptyRuntimeString(
          event.closure_reason,
          `${phase.id}.question_events[${index}].closure_reason`,
        );
        replay.set(event.question_id, {
          ...prior,
          status: 'closed',
          closedAt: event.at,
          closureReason: event.closure_reason,
        });
      }
    }
    for (const question of phase.questions) {
      const replayed = replay.get(question.id);
      if (
        !replayed ||
        replayed.status !== question.status ||
        replayed.reopenCount !== question.reopen_count
      ) {
        throw new Error(`${phase.id} question event replay differs from final ${question.id} state.`);
      }
      if (
        question.status === 'answered' &&
        (replayed.latestAnswer !== question.answer ||
          replayed.latestAnswerSource !== question.answer_source ||
          replayed.latestAnsweredAt !== question.answered_at)
      ) {
        throw new Error(`${phase.id} question answer history differs from final ${question.id} state.`);
      }
      if (
        question.status === 'closed' &&
        (replayed.closedAt !== question.closed_at ||
          replayed.closureReason !== question.closure_reason)
      ) {
        throw new Error(`${phase.id} question close history differs from final ${question.id} state.`);
      }
    }
  }
  runtimeQuestionNumbers.sort((left, right) => left - right);
  for (const [index, questionNumber] of runtimeQuestionNumbers.entries()) {
    if (questionNumber !== inspection.runtimeQuestionSeed + index) {
      throw new Error('Controller runtime question IDs must remain collision-free and monotonic.');
    }
  }
  if (
    cursor.next_question_number !==
      inspection.runtimeQuestionSeed + runtimeQuestionNumbers.length ||
    cursor.next_question_number <= maximumQuestionNumber
  ) {
    throw new Error('Controller question cursor would reuse or skip a stable Q-XX identifier.');
  }
  if (cursor.pause_count !== pauseEvents) {
    throw new Error('Controller pause count differs from replayed question history.');
  }
  if (open.length > 1) {
    throw new Error('Controller runtime may pause for only one material question at a time.');
  }
  if (open.length === 1) {
    if (
      cursor.pending_question_id !== open[0].question.id ||
      cursor.pending_phase_id !== open[0].phase.id ||
      record.status !== 'paused'
    ) {
      throw new Error('Controller pending-question cursor differs from its single open question.');
    }
  } else if (
    cursor.pending_question_id !== null ||
    cursor.pending_phase_id !== null ||
    record.status === 'paused'
  ) {
    throw new Error('Controller pending-question cursor must clear before execution resumes.');
  }
}

export function validateMilestoneControllerState(
  state,
  { authority, controllerInspection, goalActivationAuthority = null } = {},
) {
  const record = requireRecord(state, 'milestone controller state');
  if (record.schema_version !== 1 || record.kind !== 'cruise_milestone_controller_state') {
    throw new Error('Milestone controller state schema/kind is invalid.');
  }
  nonEmptyRuntimeString(record.run_id, 'state.run_id');
  const inspection = requireControllerInspection(
    controllerInspection,
    authority,
    record.run_id,
  );
  const provenance = stateBrandMetadata(state);
  const activation = goalActivationAuthority ?? provenance?.goalActivationAuthority ?? null;
  requireGoalActivation(activation, authority, inspection, record.run_id);
  if (
    record.authority_session_id !== authority.session_id ||
    record.authority_interaction_id !== authority.interaction_id ||
    record.build_approval_digest !== authority.build_approval_digest
  ) {
    throw new Error('Controller runtime state belongs to another selection/Build approval.');
  }
  runtimeDigest(record.controller_digest, 'state.controller_digest');
  runtimeDigest(record.contract_digest, 'state.contract_digest');
  runtimeDigest(record.repository_baseline_digest, 'state.repository_baseline_digest');
  runtimeDigest(record.permission_envelope_digest, 'state.permission_envelope_digest');
  runtimeDigest(record.goal_activation_digest, 'state.goal_activation_digest');
  nonEmptyRuntimeString(record.goal_thread_id, 'state.goal_thread_id');
  if (
    record.goal_activation_digest !== activation.activation_digest ||
    record.goal_thread_id !== activation.thread_id
  ) {
    throw new Error('Controller runtime state belongs to another native Goal activation.');
  }
  requireTimestamp(record.created_at, 'state.created_at');
  requireTimestamp(record.updated_at, 'state.updated_at');
  if (!Number.isSafeInteger(record.revision) || record.revision < 0) {
    throw new Error('state.revision must be a non-negative safe integer.');
  }
  if (!['ready', 'active', 'paused', 'blocked', 'complete', 'cancelled'].includes(record.status)) {
    throw new Error('Controller runtime state has an invalid status.');
  }
  if (!Array.isArray(record.phases) || record.phases.length === 0) {
    throw new Error('Controller runtime state requires phases.');
  }
  const ids = new Set();
  for (const phase of record.phases) {
    requireRecord(phase, 'state phase');
    if (!PHASE_ID.test(phase.id) || ids.has(phase.id)) {
      throw new Error('Controller runtime state contains an invalid or duplicate phase ID.');
    }
    ids.add(phase.id);
    if (!Array.isArray(phase.depends_on) || typeof phase.mandatory !== 'boolean') {
      throw new Error(`${phase.id} runtime dependencies/mandatory flag are invalid.`);
    }
    if (
      !Array.isArray(phase.acceptance_criteria) ||
      phase.acceptance_criteria.length === 0 ||
      phase.acceptance_criteria.some((id) => !/^AC-[0-9]{2,}$/u.test(id))
    ) {
      throw new Error(`${phase.id} runtime acceptance criteria are invalid.`);
    }
    if (!['pending', 'ready', 'active', 'completed', 'blocked', 'failed'].includes(phase.status)) {
      throw new Error(`${phase.id} runtime status is invalid.`);
    }
    if (phase.status === 'completed') {
      runtimeDigest(phase.closeout_digest, `${phase.id}.closeout_digest`);
      runtimeDigest(phase.evidence_digest, `${phase.id}.evidence_digest`);
      if (!Array.isArray(phase.evidence_ids) || phase.evidence_ids.length === 0) {
        throw new Error(`${phase.id} completion requires evidence IDs.`);
      }
    }
    if (['active', 'completed', 'blocked', 'failed'].includes(phase.status)) {
      runtimeDigest(phase.plan_digest, `${phase.id}.plan_digest`);
      runtimeDigest(
        phase.permission_scope_digest,
        `${phase.id}.permission_scope_digest`,
      );
      runtimeDigest(
        phase.pre_repository_baseline_digest,
        `${phase.id}.pre_repository_baseline_digest`,
      );
      if (!Array.isArray(phase.ownership) || phase.ownership.length === 0) {
        throw new Error(`${phase.id} activated state requires exact plan ownership.`);
      }
    }
    if (phase.status === 'completed') {
      runtimeDigest(
        phase.post_repository_baseline_digest,
        `${phase.id}.post_repository_baseline_digest`,
      );
    }
  }
  validateControllerQuestionState(record, inspection);
  for (const phase of record.phases) {
    if (
      phase.depends_on.some((dependency) => dependency === phase.id || !ids.has(dependency))
    ) {
      throw new Error(`${phase.id} has an invalid runtime dependency.`);
    }
  }
  const active = record.phases.filter((phase) => phase.status === 'active');
  if (
    active.length > 1 ||
    (active.length === 1 && record.active_phase_id !== active[0].id) ||
    (active.length === 0 && record.active_phase_id !== null)
  ) {
    throw new Error('Controller runtime state must contain at most one matching active phase.');
  }
  if (
    (record.status === 'active' && active.length !== 1) ||
    (record.status === 'ready' && active.length !== 0) ||
    (active.length === 1 && !['active', 'paused'].includes(record.status))
  ) {
    throw new Error('Controller active/paused status must exactly match its active phase.');
  }
  if (
    active.length === 1 &&
    active[0].pre_repository_baseline_digest !== record.repository_baseline_digest
  ) {
    throw new Error('Active phase pre-baseline must match the controller baseline.');
  }
  const expectedReady = computeReadyPhaseIds(record.phases);
  if (JSON.stringify(record.ready_phase_ids) !== JSON.stringify(expectedReady)) {
    throw new Error('Controller ready phase list is stale or non-deterministic.');
  }
  if (record.status === 'blocked' && !isRecord(record.hard_stop)) {
    throw new Error('Blocked controller state requires a hard stop.');
  }
  if (record.status === 'complete') {
    if (
      active.length !== 0 ||
      record.hard_stop !== null ||
      record.completion_fence_passed !== true ||
      !Array.isArray(record.aggregate_evidence_ids) ||
      record.aggregate_evidence_ids.length === 0 ||
      record.phases.some((phase) => phase.mandatory && phase.status !== 'completed')
    ) {
      throw new Error('Controller completion claim is premature or lacks aggregate evidence.');
    }
    runtimeDigest(record.aggregate_evidence_digest, 'state.aggregate_evidence_digest');
  }
  assertStateMatchesInspection(record, inspection);
  return record;
}

export function createMilestoneControllerState({
  authority,
  controllerInspection,
  goalActivationAuthority,
  repositoryBaselineDigest,
  now = () => new Date(),
} = {}) {
  const runId = nonEmptyRuntimeString(authority?.run_id, 'authority.run_id');
  const inspection = requireControllerInspection(controllerInspection, authority, runId);
  requireGoalActivation(goalActivationAuthority, authority, inspection, runId);
  const baseline = runtimeDigest(repositoryBaselineDigest, 'repositoryBaselineDigest');
  if (baseline !== goalActivationAuthority.repository_baseline_digest) {
    throw new Error('Initial controller state baseline must equal the native Goal activation baseline.');
  }
  const timestamp = nowTimestamp(now, 'created_at');
  const phases = [...inspection.controller.phase_dag]
    .sort((left, right) => comparePhaseIds(left.id, right.id))
    .map((phase) => ({
      id: phase.id,
      depends_on: sortedPhaseIds(phase.depends_on),
      mandatory: phase.mandatory,
      acceptance_criteria: [...phase.acceptance_criteria],
      status: phase.depends_on.length === 0 ? 'ready' : 'pending',
      plan_digest: null,
      ownership: [],
      permission_scope_digest: null,
      pre_repository_baseline_digest: null,
      post_repository_baseline_digest: null,
      closeout_digest: null,
      evidence_digest: null,
      evidence_ids: [],
      stopped_reason: null,
      questions: [],
      question_events: [],
    }));
  const state = {
    schema_version: 1,
    kind: 'cruise_milestone_controller_state',
    run_id: runId,
    authority_session_id: authority.session_id,
    authority_interaction_id: authority.interaction_id,
    build_approval_digest: authority.build_approval_digest,
    goal_activation_digest: goalActivationAuthority.activation_digest,
    goal_thread_id: goalActivationAuthority.thread_id,
    milestone_id: inspection.controller.milestone.id,
    milestone_path: inspection.controller.milestone.path,
    controller_digest: inspection.controllerArtifact.sha256,
    contract_digest: inspection.controller.milestone.contract_digest,
    repository_baseline_digest: baseline,
    permission_envelope_digest: inspection.permissionEnvelopeDigest,
    completion_fence: inspection.controller.milestone.completion_fence,
    status: 'ready',
    active_phase_id: null,
    question_cursor: {
      locked_question_max: inspection.lockedQuestionMax,
      runtime_question_seed: inspection.runtimeQuestionSeed,
      next_question_number: inspection.runtimeQuestionSeed,
      pending_question_id: null,
      pending_phase_id: null,
      pause_count: 0,
    },
    phases,
    ready_phase_ids: computeReadyPhaseIds(phases),
    hard_stop: null,
    aggregate_evidence_ids: [],
    aggregate_evidence_digest: null,
    completion_fence_passed: false,
    revision: 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
  validateMilestoneControllerState(state, {
    authority,
    controllerInspection: inspection,
    goalActivationAuthority,
  });
  return brandControllerState(state, {
    goalActivationAuthority,
    parentState: null,
    transition: 'goal_activated',
    baselineAuthority: 'activation',
  });
}

function stateQuestionById(state, questionId) {
  for (const phase of state.phases) {
    const question = phase.questions.find(({ id }) => id === questionId);
    if (question) return { phase, question };
  }
  return null;
}

function closePendingControllerQuestion(state, reason, at) {
  const questionId = state.question_cursor.pending_question_id;
  if (questionId === null) return;
  const located = stateQuestionById(state, questionId);
  if (!located || located.question.status !== 'open') {
    throw new Error('Controller pending question cannot be closed because its ledger is stale.');
  }
  located.question.status = 'closed';
  located.question.closure_reason = nonEmptyRuntimeString(reason, 'question closure reason');
  located.question.closed_at = at;
  located.phase.question_events.push({
    sequence: located.phase.question_events.length + 1,
    type: 'closed',
    question_id: questionId,
    closure_reason: located.question.closure_reason,
    at,
  });
  state.question_cursor.pending_question_id = null;
  state.question_cursor.pending_phase_id = null;
}

function runtimeQuestionId(number) {
  return `Q-${String(number).padStart(2, '0')}`;
}

export function pauseMilestoneControllerForQuestion({
  state,
  authority,
  controllerInspection,
  goalActivationAuthority,
  phaseId,
  question,
  materiality,
  rationale,
  reopeningTrigger,
  now = () => new Date(),
} = {}) {
  requireControllerStateProvenance(state, goalActivationAuthority);
  validateMilestoneControllerState(state, {
    authority,
    controllerInspection,
    goalActivationAuthority,
  });
  if (!['ready', 'active'].includes(state.status)) {
    throw new Error('A controller may pause for a question only from ready or active execution.');
  }
  if (state.question_cursor.pending_question_id !== null) {
    throw new Error('Resolve the current material question before opening another.');
  }
  if (!QUESTION_MATERIALITIES.has(materiality)) {
    throw new Error('Runtime question materiality is not an approved controller interruption.');
  }
  const phase = state.phases.find(({ id }) => id === phaseId);
  if (
    !phase ||
    (state.active_phase_id !== null
      ? state.active_phase_id !== phaseId
      : !state.ready_phase_ids.includes(phaseId))
  ) {
    throw new Error('Runtime questions must belong to the active or next ready phase.');
  }
  const timestamp = nowTimestamp(now, 'asked_at');
  const next = structuredClone(state);
  const nextPhase = next.phases.find(({ id }) => id === phaseId);
  const questionId = runtimeQuestionId(next.question_cursor.next_question_number);
  nextPhase.questions.push({
    id: questionId,
    status: 'open',
    question: nonEmptyRuntimeString(question, 'question'),
    materiality,
    rationale: nonEmptyRuntimeString(rationale, 'rationale'),
    reopening_trigger: nonEmptyRuntimeString(reopeningTrigger, 'reopeningTrigger'),
    asked_at: timestamp,
    answer: null,
    answer_source: null,
    answered_at: null,
    closure_reason: null,
    closed_at: null,
    reopen_count: 0,
  });
  nextPhase.question_events.push({
    sequence: nextPhase.question_events.length + 1,
    type: 'opened',
    question_id: questionId,
    at: timestamp,
  });
  next.question_cursor.next_question_number += 1;
  next.question_cursor.pending_question_id = questionId;
  next.question_cursor.pending_phase_id = phaseId;
  next.question_cursor.pause_count += 1;
  next.status = 'paused';
  bumpControllerState(next, now);
  validateMilestoneControllerState(next, {
    authority,
    controllerInspection,
    goalActivationAuthority,
  });
  return rebrandControllerState(next, state, 'question_opened', {
    goalActivationAuthority,
  });
}

export function answerMilestoneControllerQuestion({
  state,
  authority,
  controllerInspection,
  goalActivationAuthority,
  questionId,
  answer,
  answerSource = 'direct_user',
  now = () => new Date(),
} = {}) {
  requireControllerStateProvenance(state, goalActivationAuthority);
  validateMilestoneControllerState(state, {
    authority,
    controllerInspection,
    goalActivationAuthority,
  });
  if (
    state.status !== 'paused' ||
    state.question_cursor.pending_question_id !== questionId
  ) {
    throw new Error('Only the current open material question may be answered.');
  }
  if (!['direct_user', 'repository_evidence'].includes(answerSource)) {
    throw new Error('Runtime question answer source is invalid.');
  }
  const located = stateQuestionById(state, questionId);
  if (!located || located.question.status !== 'open') {
    throw new Error('The pending runtime question is absent or already answered.');
  }
  const timestamp = nowTimestamp(now, 'answered_at');
  const next = structuredClone(state);
  const nextPhase = next.phases.find(({ id }) => id === located.phase.id);
  const nextQuestion = nextPhase.questions.find(({ id }) => id === questionId);
  nextQuestion.status = 'answered';
  nextQuestion.answer = nonEmptyRuntimeString(answer, 'answer');
  nextQuestion.answer_source = answerSource;
  nextQuestion.answered_at = timestamp;
  nextPhase.question_events.push({
    sequence: nextPhase.question_events.length + 1,
    type: 'answered',
    question_id: questionId,
    answer: nextQuestion.answer,
    answer_source: nextQuestion.answer_source,
    at: timestamp,
  });
  next.question_cursor.pending_question_id = null;
  next.question_cursor.pending_phase_id = null;
  next.status = next.active_phase_id === null ? 'ready' : 'active';
  bumpControllerState(next, now);
  validateMilestoneControllerState(next, {
    authority,
    controllerInspection,
    goalActivationAuthority,
  });
  return rebrandControllerState(next, state, 'question_answered', {
    goalActivationAuthority,
  });
}

export function reopenMilestoneControllerQuestion({
  state,
  authority,
  controllerInspection,
  goalActivationAuthority,
  questionId,
  trigger,
  now = () => new Date(),
} = {}) {
  requireControllerStateProvenance(state, goalActivationAuthority);
  validateMilestoneControllerState(state, {
    authority,
    controllerInspection,
    goalActivationAuthority,
  });
  if (!['ready', 'active'].includes(state.status)) {
    throw new Error('A runtime question may reopen only during ready or active execution.');
  }
  const located = stateQuestionById(state, questionId);
  if (!located || located.question.status !== 'answered') {
    throw new Error('Only an answered runtime question may reopen.');
  }
  if (nonEmptyRuntimeString(trigger, 'trigger') !== located.question.reopening_trigger) {
    throw new Error('The recorded reopening trigger did not occur.');
  }
  if (
    state.active_phase_id !== null
      ? state.active_phase_id !== located.phase.id
      : !state.ready_phase_ids.includes(located.phase.id)
  ) {
    throw new Error('Only a question for the active or next ready phase may reopen.');
  }
  const timestamp = nowTimestamp(now, 'reopened_at');
  const next = structuredClone(state);
  const nextPhase = next.phases.find(({ id }) => id === located.phase.id);
  const nextQuestion = nextPhase.questions.find(({ id }) => id === questionId);
  nextQuestion.status = 'open';
  nextQuestion.answer = null;
  nextQuestion.answer_source = null;
  nextQuestion.answered_at = null;
  nextQuestion.reopen_count += 1;
  nextPhase.question_events.push({
    sequence: nextPhase.question_events.length + 1,
    type: 'reopened',
    question_id: questionId,
    trigger: nextQuestion.reopening_trigger,
    at: timestamp,
  });
  next.question_cursor.pending_question_id = questionId;
  next.question_cursor.pending_phase_id = located.phase.id;
  next.question_cursor.pause_count += 1;
  next.status = 'paused';
  bumpControllerState(next, now);
  validateMilestoneControllerState(next, {
    authority,
    controllerInspection,
    goalActivationAuthority,
  });
  return rebrandControllerState(next, state, 'question_reopened', {
    goalActivationAuthority,
  });
}

export async function attestMilestonePhasePlan({
  cwd,
  state,
  authority,
  controllerInspection,
  goalActivationAuthority,
  phaseId = null,
  ownership,
  permissionScope,
  now = () => new Date(),
} = {}) {
  requireControllerStateProvenance(state, goalActivationAuthority);
  const freshInspection = await assertFreshControllerInspection(
    cwd,
    authority,
    controllerInspection,
  );
  validateMilestoneControllerState(state, {
    authority,
    controllerInspection: freshInspection,
    goalActivationAuthority,
  });
  if (state.active_phase_id !== null || state.status !== 'ready') {
    throw new Error('A phase plan may be attested only when no phase is active.');
  }
  const selected = phaseId ?? state.ready_phase_ids[0] ?? null;
  if (!selected || !state.ready_phase_ids.includes(selected)) {
    throw new Error('Only a deterministically ready phase may receive a JIT plan.');
  }
  const currentBaseline = await freshRepositoryBaselineDigest(cwd);
  if (currentBaseline !== state.repository_baseline_digest) {
    throw new Error('Repository baseline drifted before JIT phase-plan activation.');
  }
  const root = await realpath(resolve(cwd));
  const planPath = `${state.milestone_path}/phases/${selected}/PLAN.md`;
  const plan = await readRegularArtifact(root, planPath);
  const normalizedOwnership = normalizePhaseOwnership(ownership);
  const scopeDigest = permissionScopeDigest(permissionScope);
  const attestation = Object.freeze({
    schema_version: 1,
    kind: 'cruise_verified_jit_phase_plan',
    run_id: state.run_id,
    phase_id: selected,
    state_revision: state.revision,
    plan_digest: plan.sha256,
    ownership: normalizedOwnership,
    permission_scope_digest: scopeDigest,
    repository_baseline_digest: currentBaseline,
    verified_at: nowTimestamp(now, 'verified_at'),
  });
  PHASE_PLAN_ATTESTATIONS.set(attestation, {
    authority,
    goalActivationAuthority,
    controllerDigest: freshInspection.controllerArtifact.sha256,
  });
  return attestation;
}

export async function activateMilestoneControllerPhase({
  cwd,
  state,
  authority,
  controllerInspection,
  goalActivationAuthority,
  phasePlanAttestation,
  now = () => new Date(),
} = {}) {
  requireControllerStateProvenance(state, goalActivationAuthority);
  const freshInspection = await assertFreshControllerInspection(
    cwd,
    authority,
    controllerInspection,
  );
  validateMilestoneControllerState(state, {
    authority,
    controllerInspection: freshInspection,
    goalActivationAuthority,
  });
  if (!['ready', 'active'].includes(state.status) || state.hard_stop !== null) {
    throw new Error('A blocked, cancelled, or complete controller cannot activate a phase.');
  }
  if (state.active_phase_id !== null) {
    throw new Error(`Phase ${state.active_phase_id} is already active.`);
  }
  const proof = phasePlanAttestation && PHASE_PLAN_ATTESTATIONS.get(phasePlanAttestation);
  if (
    !proof ||
    proof.authority !== authority ||
    proof.goalActivationAuthority !== goalActivationAuthority ||
    proof.controllerDigest !== state.controller_digest ||
    phasePlanAttestation.run_id !== state.run_id ||
    phasePlanAttestation.state_revision !== state.revision ||
    phasePlanAttestation.repository_baseline_digest !== state.repository_baseline_digest ||
    !state.ready_phase_ids.includes(phasePlanAttestation.phase_id)
  ) {
    throw new Error('Phase activation requires a current opaque JIT plan/baseline attestation.');
  }
  if (await freshRepositoryBaselineDigest(cwd) !== state.repository_baseline_digest) {
    throw new Error('Repository baseline drifted between phase-plan review and activation.');
  }
  const root = await realpath(resolve(cwd));
  const currentPlan = await readRegularArtifact(
    root,
    `${state.milestone_path}/phases/${phasePlanAttestation.phase_id}/PLAN.md`,
  );
  if (currentPlan.sha256 !== phasePlanAttestation.plan_digest) {
    throw new Error('JIT phase PLAN.md changed between attestation and activation.');
  }
  const selected = phasePlanAttestation.phase_id;
  const next = structuredClone(state);
  const phase = phaseById(next).get(selected);
  phase.status = 'active';
  phase.plan_digest = phasePlanAttestation.plan_digest;
  phase.ownership = [...phasePlanAttestation.ownership];
  phase.permission_scope_digest = phasePlanAttestation.permission_scope_digest;
  phase.pre_repository_baseline_digest =
    phasePlanAttestation.repository_baseline_digest;
  next.active_phase_id = selected;
  next.status = 'active';
  next.ready_phase_ids = next.ready_phase_ids.filter((id) => id !== selected);
  bumpControllerState(next, now);
  validateMilestoneControllerState(next, {
    authority,
    controllerInspection: freshInspection,
    goalActivationAuthority,
  });
  return rebrandControllerState(next, state, 'phase_activated', {
    goalActivationAuthority,
  });
}

export async function attestMilestonePhaseCloseout({
  cwd,
  state,
  authority,
  controllerInspection,
  goalActivationAuthority,
  phaseId,
  evidenceRecord,
  evidenceIds,
  now = () => new Date(),
} = {}) {
  requireControllerStateProvenance(state, goalActivationAuthority);
  const freshInspection = await assertFreshControllerInspection(
    cwd,
    authority,
    controllerInspection,
  );
  validateMilestoneControllerState(state, {
    authority,
    controllerInspection: freshInspection,
    goalActivationAuthority,
  });
  if (state.status !== 'active' || state.active_phase_id !== phaseId) {
    throw new Error('Phase closeout attestation requires the current active phase.');
  }
  const activePhase = phaseById(state).get(phaseId);
  const root = await realpath(resolve(cwd));
  const planPath = `${state.milestone_path}/phases/${phaseId}/PLAN.md`;
  const currentPlan = await readRegularArtifact(root, planPath);
  if (currentPlan.sha256 !== activePhase.plan_digest) {
    throw new Error(`${planPath} changed after JIT phase-plan activation.`);
  }
  const persistedEvidence = await readPhaseEvidence(root, state, phaseId);
  if (
    evidenceRecord !== undefined &&
    canonicalJson(evidenceRecord) !== canonicalJson(persistedEvidence.record)
  ) {
    throw new Error(`${persistedEvidence.path} differs from the supplied evidence record.`);
  }
  if (persistedEvidence.record.outcome !== 'completed') {
    throw new Error(`${persistedEvidence.path} must have unqualified completed outcome.`);
  }
  const ids = validateEvidenceIds(
    persistedEvidence.record,
    evidenceIds,
    state.run_id,
    `${phaseId} closeout`,
  );
  const items = new Map(persistedEvidence.record.items.map((item) => [item.id, item]));
  for (const criterion of activePhase.acceptance_criteria) {
    if (!ids.some((id) => items.get(id)?.supports.includes(criterion))) {
      throw new Error(`${phaseId} closeout evidence does not support ${criterion}.`);
    }
  }
  const closeoutPath = `${state.milestone_path}/phases/${phaseId}/CLOSEOUT.md`;
  const closeout = await readRegularArtifact(root, closeoutPath);
  const postBaseline = await freshRepositoryBaselineDigest(cwd);
  const attestation = Object.freeze({
    schema_version: 1,
    kind: 'cruise_verified_phase_closeout',
    run_id: state.run_id,
    phase_id: phaseId,
    state_revision: state.revision,
    closeout_digest: closeout.sha256,
    plan_digest: activePhase.plan_digest,
    pre_repository_baseline_digest: activePhase.pre_repository_baseline_digest,
    post_repository_baseline_digest: postBaseline,
    evidence_digest: evidenceDigest(persistedEvidence.record),
    evidence_ids: ids,
    verified_at: nowTimestamp(now, 'verified_at'),
  });
  PHASE_CLOSEOUT_ATTESTATIONS.set(attestation, {
    authority,
    goalActivationAuthority,
    controllerDigest: state.controller_digest,
  });
  return attestation;
}

export function closeMilestoneControllerPhase({
  state,
  authority,
  controllerInspection,
  goalActivationAuthority,
  closeoutAttestation,
  now = () => new Date(),
} = {}) {
  requireControllerStateProvenance(state, goalActivationAuthority);
  validateMilestoneControllerState(state, {
    authority,
    controllerInspection,
    goalActivationAuthority,
  });
  const proof = closeoutAttestation && PHASE_CLOSEOUT_ATTESTATIONS.get(closeoutAttestation);
  if (
    !proof ||
    proof.authority !== authority ||
    proof.goalActivationAuthority !== goalActivationAuthority ||
    proof.controllerDigest !== state.controller_digest ||
    closeoutAttestation.run_id !== state.run_id ||
    closeoutAttestation.state_revision !== state.revision ||
    closeoutAttestation.phase_id !== state.active_phase_id ||
    closeoutAttestation.plan_digest !==
      phaseById(state).get(state.active_phase_id)?.plan_digest ||
    closeoutAttestation.pre_repository_baseline_digest !==
      state.repository_baseline_digest
  ) {
    throw new Error('Phase completion requires a current opaque closeout/evidence attestation.');
  }
  const next = structuredClone(state);
  const phase = phaseById(next).get(next.active_phase_id);
  phase.status = 'completed';
  phase.closeout_digest = closeoutAttestation.closeout_digest;
  phase.evidence_digest = closeoutAttestation.evidence_digest;
  phase.evidence_ids = [...closeoutAttestation.evidence_ids];
  phase.post_repository_baseline_digest =
    closeoutAttestation.post_repository_baseline_digest;
  next.repository_baseline_digest =
    closeoutAttestation.post_repository_baseline_digest;
  next.active_phase_id = null;
  next.status = 'ready';
  refreshPendingReadiness(next);
  bumpControllerState(next, now);
  validateMilestoneControllerState(next, {
    authority,
    controllerInspection,
    goalActivationAuthority,
  });
  return rebrandControllerState(next, state, 'phase_closeout', {
    goalActivationAuthority,
    baselineAuthority: 'phase_closeout_attestation',
  });
}

export async function stopMilestoneControllerPhase({
  cwd,
  state,
  authority,
  controllerInspection,
  goalActivationAuthority,
  outcome,
  reason,
  now = () => new Date(),
} = {}) {
  requireControllerStateProvenance(state, goalActivationAuthority);
  const freshInspection = await assertFreshControllerInspection(
    cwd,
    authority,
    controllerInspection,
  );
  validateMilestoneControllerState(state, {
    authority,
    controllerInspection: freshInspection,
    goalActivationAuthority,
  });
  if (!['blocked', 'failed'].includes(outcome) || state.active_phase_id === null) {
    throw new Error('An active phase may only stop as blocked or failed.');
  }
  const next = structuredClone(state);
  const stoppedAt = nowTimestamp(now, 'hard_stop.stopped_at');
  closePendingControllerQuestion(next, `phase ${outcome}: ${reason}`, stoppedAt);
  const phase = phaseById(next).get(next.active_phase_id);
  const postBaseline = await freshRepositoryBaselineDigest(cwd);
  phase.status = outcome;
  phase.stopped_reason = nonEmptyRuntimeString(reason, 'reason');
  phase.post_repository_baseline_digest = postBaseline;
  next.repository_baseline_digest = postBaseline;
  next.active_phase_id = null;
  refreshPendingReadiness(next);
  if (phase.mandatory) {
    next.status = 'blocked';
    next.hard_stop = {
      code: `MANDATORY_PHASE_${outcome.toUpperCase()}`,
      phase_id: phase.id,
      reason: phase.stopped_reason,
      stopped_at: stoppedAt,
    };
  } else {
    next.status = 'ready';
  }
  bumpControllerState(next, now);
  validateMilestoneControllerState(next, {
    authority,
    controllerInspection: freshInspection,
    goalActivationAuthority,
  });
  return rebrandControllerState(next, state, `phase_${outcome}`, {
    goalActivationAuthority,
    baselineAuthority:
      postBaseline === state.repository_baseline_digest ? 'unchanged' : 'unattested_stop',
  });
}

export function recordMilestoneControllerHardStop({
  state,
  authority,
  controllerInspection,
  goalActivationAuthority,
  code,
  reason,
  phaseId = null,
  now = () => new Date(),
} = {}) {
  requireControllerStateProvenance(state, goalActivationAuthority);
  validateMilestoneControllerState(state, {
    authority,
    controllerInspection,
    goalActivationAuthority,
  });
  const next = structuredClone(state);
  const stoppedAt = nowTimestamp(now, 'hard_stop.stopped_at');
  closePendingControllerQuestion(next, `hard stop: ${reason}`, stoppedAt);
  if (next.active_phase_id !== null) {
    const active = phaseById(next).get(next.active_phase_id);
    active.status = 'blocked';
    active.stopped_reason = nonEmptyRuntimeString(reason, 'reason');
    next.active_phase_id = null;
  }
  next.status = 'blocked';
  next.hard_stop = {
    code: nonEmptyRuntimeString(code, 'code'),
    phase_id: phaseId,
    reason: nonEmptyRuntimeString(reason, 'reason'),
    stopped_at: stoppedAt,
  };
  bumpControllerState(next, now);
  validateMilestoneControllerState(next, {
    authority,
    controllerInspection,
    goalActivationAuthority,
  });
  return rebrandControllerState(next, state, 'hard_stop', { goalActivationAuthority });
}

export async function attestMilestoneCompletionFence({
  cwd,
  state,
  authority,
  controllerInspection,
  goalActivationAuthority,
  evidenceRecord,
  evidenceIds,
  completionFence,
  now = () => new Date(),
} = {}) {
  requireControllerStateProvenance(state, goalActivationAuthority);
  const freshInspection = await assertFreshControllerInspection(
    cwd,
    authority,
    controllerInspection,
  );
  validateMilestoneControllerState(state, {
    authority,
    controllerInspection: freshInspection,
    goalActivationAuthority,
  });
  if (completionFence !== state.completion_fence) {
    throw new Error('Completion-fence attestation does not match the approved fence.');
  }
  if (state.phases.some((phase) => phase.mandatory && phase.status !== 'completed')) {
    throw new Error('Completion fence cannot run before every mandatory phase closes.');
  }
  const root = await realpath(resolve(cwd));
  const evidencePath = `${state.milestone_path}/MILESTONE-EVIDENCE.yaml`;
  const evidenceArtifact = await readRegularArtifact(root, evidencePath);
  let persistedEvidence;
  try {
    persistedEvidence = parseYaml(evidenceArtifact.bytes.toString('utf8'));
    validateEvidenceRecord(persistedEvidence);
  } catch (cause) {
    throw new Error(`${evidencePath} is not a valid evidence record: ${cause.message}`, {
      cause,
    });
  }
  if (
    evidenceRecord !== undefined &&
    canonicalJson(evidenceRecord) !== canonicalJson(persistedEvidence)
  ) {
    throw new Error(`${evidencePath} differs from the supplied aggregate evidence.`);
  }
  if (persistedEvidence.outcome !== 'completed') {
    throw new Error('Aggregate evidence must have an unqualified completed outcome.');
  }
  const ids = validateEvidenceIds(
    persistedEvidence,
    evidenceIds,
    state.run_id,
    'milestone completion fence',
  );
  const requiredPhaseEvidence = new Set(
    state.phases
      .filter((phase) => phase.mandatory)
      .flatMap((phase) => phase.evidence_ids),
  );
  if ([...requiredPhaseEvidence].some((id) => !ids.includes(id))) {
    throw new Error('Aggregate evidence omits mandatory phase closeout evidence.');
  }
  const attestation = Object.freeze({
    schema_version: 1,
    kind: 'cruise_verified_milestone_completion_fence',
    run_id: state.run_id,
    state_revision: state.revision,
    evidence_digest: evidenceDigest(persistedEvidence),
    evidence_ids: ids,
    verified_at: nowTimestamp(now, 'verified_at'),
  });
  COMPLETION_FENCE_ATTESTATIONS.set(attestation, {
    authority,
    goalActivationAuthority,
    controllerDigest: state.controller_digest,
  });
  return attestation;
}

export function completeMilestoneControllerState({
  state,
  authority,
  controllerInspection,
  goalActivationAuthority,
  completionAttestation,
  now = () => new Date(),
} = {}) {
  requireControllerStateProvenance(state, goalActivationAuthority);
  validateMilestoneControllerState(state, {
    authority,
    controllerInspection,
    goalActivationAuthority,
  });
  const proof = completionAttestation && COMPLETION_FENCE_ATTESTATIONS.get(completionAttestation);
  if (
    !proof ||
    proof.authority !== authority ||
    proof.goalActivationAuthority !== goalActivationAuthority ||
    proof.controllerDigest !== state.controller_digest ||
    completionAttestation.run_id !== state.run_id ||
    completionAttestation.state_revision !== state.revision
  ) {
    throw new Error('Milestone completion requires a current opaque completion-fence attestation.');
  }
  if (state.active_phase_id !== null || state.hard_stop !== null) {
    throw new Error('Milestone completion is forbidden while a phase or hard stop is active.');
  }
  if (state.phases.some((phase) => phase.mandatory && phase.status !== 'completed')) {
    throw new Error('Every mandatory phase must be completed before the milestone closes.');
  }
  const next = structuredClone(state);
  next.status = 'complete';
  next.ready_phase_ids = [];
  for (const phase of next.phases) {
    if (phase.status === 'ready') phase.status = 'pending';
  }
  next.aggregate_evidence_ids = [...completionAttestation.evidence_ids];
  next.aggregate_evidence_digest = completionAttestation.evidence_digest;
  next.completion_fence_passed = true;
  bumpControllerState(next, now);
  validateMilestoneControllerState(next, {
    authority,
    controllerInspection,
    goalActivationAuthority,
  });
  revokeDangerousForAuthority(authority, 'completed');
  return rebrandControllerState(next, state, 'milestone_complete', {
    goalActivationAuthority,
  });
}

export function cancelMilestoneControllerState({
  state,
  authority,
  controllerInspection,
  goalActivationAuthority,
  reason = 'cancelled',
  now = () => new Date(),
} = {}) {
  requireControllerStateProvenance(state, goalActivationAuthority);
  validateMilestoneControllerState(state, {
    authority,
    controllerInspection,
    goalActivationAuthority,
  });
  const next = structuredClone(state);
  const stoppedAt = nowTimestamp(now, 'hard_stop.stopped_at');
  closePendingControllerQuestion(next, `cancelled: ${reason}`, stoppedAt);
  if (next.active_phase_id !== null) {
    const phase = phaseById(next).get(next.active_phase_id);
    phase.status = 'blocked';
    phase.stopped_reason = reason;
  }
  next.active_phase_id = null;
  next.ready_phase_ids = [];
  for (const phase of next.phases) {
    if (phase.status === 'ready') phase.status = 'pending';
  }
  next.status = 'cancelled';
  next.hard_stop = {
    code: 'CANCELLED',
    phase_id: null,
    reason: nonEmptyRuntimeString(reason, 'reason'),
    stopped_at: stoppedAt,
  };
  bumpControllerState(next, now);
  validateMilestoneControllerState(next, {
    authority,
    controllerInspection,
    goalActivationAuthority,
  });
  revokeDangerousForAuthority(authority, 'cancelled');
  return rebrandControllerState(next, state, 'cancelled', { goalActivationAuthority });
}

function phaseStateProjection(state, phase) {
  return {
    schema_version: 1,
    kind: 'cruise_milestone_phase_state',
    run_id: state.run_id,
    milestone_id: state.milestone_id,
    phase_id: phase.id,
    controller_revision: state.revision,
    controller_digest: state.controller_digest,
    contract_digest: state.contract_digest,
    goal_activation_digest: state.goal_activation_digest,
    depends_on: [...phase.depends_on],
    mandatory: phase.mandatory,
    acceptance_criteria: [...phase.acceptance_criteria],
    status: phase.status,
    plan_digest: phase.plan_digest,
    ownership: [...phase.ownership],
    permission_scope_digest: phase.permission_scope_digest,
    pre_repository_baseline_digest: phase.pre_repository_baseline_digest,
    post_repository_baseline_digest: phase.post_repository_baseline_digest,
    closeout_digest: phase.closeout_digest,
    evidence_digest: phase.evidence_digest,
    evidence_ids: [...phase.evidence_ids],
    stopped_reason: phase.stopped_reason,
    updated_at: state.updated_at,
  };
}

function phaseQuestionsProjection(state, phase) {
  const pending = state.question_cursor.pending_phase_id === phase.id
    ? state.question_cursor.pending_question_id
    : null;
  return {
    schema_version: 1,
    kind: 'cruise_milestone_phase_questions',
    run_id: state.run_id,
    milestone_id: state.milestone_id,
    phase_id: phase.id,
    controller_revision: state.revision,
    goal_activation_digest: state.goal_activation_digest,
    pending_question_id: pending,
    questions: structuredClone(phase.questions),
    events: structuredClone(phase.question_events),
    updated_at: state.updated_at,
  };
}

async function ensureRuntimeDirectory(repositoryRoot, relativeDirectory) {
  const segments = relativeDirectory.split('/');
  let current = repositoryRoot;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`${relativeDirectory} contains a non-directory or symlink component.`);
    }
    if (await realpath(current) !== current) {
      throw new Error(`${relativeDirectory} resolves through a symlink.`);
    }
  }
}

function controllerHistoryRelativePath(milestonePath) {
  return `${milestonePath}/${CONTROLLER_HISTORY_DIRECTORY}`;
}

function controllerStateFileRecords(state) {
  const records = [];
  for (const phase of state.phases) {
    records.push({
      path: `${state.milestone_path}/phases/${phase.id}/STATE.yaml`,
      record: phaseStateProjection(state, phase),
    });
    records.push({
      path: `${state.milestone_path}/phases/${phase.id}/QUESTIONS.yaml`,
      record: phaseQuestionsProjection(state, phase),
    });
  }
  records.push({
    path: `${state.milestone_path}/STATE.yaml`,
    record: state,
  });
  return records;
}

function serializeControllerStateFiles(state) {
  return controllerStateFileRecords(state).map(({ path, record }) => {
    const bytes = Buffer.from(stringifyYaml(record), 'utf8');
    return Object.freeze({
      path,
      file_sha256: sha256(bytes),
      yaml_base64: bytes.toString('base64'),
      bytes,
      record,
    });
  });
}

function persistedControllerFile(file) {
  return {
    path: file.path,
    file_sha256: file.file_sha256,
    yaml_base64: file.yaml_base64,
  };
}

function controllerHistoryEntryPayload(entry) {
  const { entry_sha256: ignored, ...payload } = entry;
  void ignored;
  return payload;
}

function controllerHistoryEntryDigest(payload) {
  return createHash('sha256')
    .update('cruise-milestone-controller-history-entry-v1\0')
    .update(canonicalJson(payload))
    .digest('hex');
}

function nearestPersistedControllerState(state) {
  const visited = new Set();
  let cursor = state;
  while (cursor !== null) {
    if (visited.has(cursor)) {
      throw new Error('Controller state provenance contains a cycle.');
    }
    visited.add(cursor);
    const proof = STATE_PERSISTENCE_PROOFS.get(cursor);
    if (proof) return { state: cursor, proof };
    const metadata = stateBrandMetadata(cursor);
    if (!metadata) {
      throw new Error('Controller persistence requires an unbroken branded state lineage.');
    }
    cursor = metadata.parentState;
  }
  return null;
}

function controllerPersistenceLineage(state, ancestor) {
  const reversed = [];
  const visited = new Set();
  let cursor = state;
  while (cursor !== ancestor) {
    if (cursor === null || visited.has(cursor)) {
      throw new Error('Controller state does not descend from its persisted compare-and-swap head.');
    }
    visited.add(cursor);
    const metadata = stateBrandMetadata(cursor);
    if (!metadata) {
      throw new Error('Controller persistence lineage lost opaque reducer provenance.');
    }
    const parent = metadata.parentState;
    reversed.push({
      revision: cursor.revision,
      transition: nonEmptyRuntimeString(metadata.transition, 'controller transition'),
      baseline_authority: nonEmptyRuntimeString(
        metadata.baselineAuthority,
        'controller baseline authority',
      ),
      baseline_changed:
        parent !== null &&
        cursor.repository_baseline_digest !== parent.repository_baseline_digest,
    });
    cursor = parent;
  }
  const transitions = reversed.reverse();
  if (transitions.length === 0) {
    throw new Error('Controller persistence requires a new reducer transition.');
  }
  const baselineProgression = ancestor === null
    ? 'activation'
    : transitions.every(
      ({ baseline_changed: changed, baseline_authority: baselineAuthority }) =>
        !changed || baselineAuthority === 'phase_closeout_attestation',
    )
      ? 'attested'
      : 'unattested';
  return Object.freeze({
    baselineProgression,
    transitions: Object.freeze(transitions.map((transition) => Object.freeze(transition))),
  });
}

async function optionalControllerArtifact(repositoryRoot, relativePath) {
  try {
    await lstat(join(repositoryRoot, relativePath));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  return readRegularArtifact(repositoryRoot, relativePath);
}

async function captureControllerMirrorPredecessors(repositoryRoot, files) {
  const predecessors = [];
  for (const file of files) {
    const current = await optionalControllerArtifact(repositoryRoot, file.path);
    predecessors.push(current === null
      ? {
          path: file.path,
          present: false,
          file_sha256: null,
          yaml_base64: null,
        }
      : {
          path: file.path,
          present: true,
          file_sha256: current.sha256,
          yaml_base64: current.bytes.toString('base64'),
        });
  }
  return predecessors;
}

function createControllerHistoryEntry({
  state,
  files,
  previousEntry,
  sequence,
  transitionLineage,
  predecessorFiles,
}) {
  const payload = {
    schema_version: 1,
    kind: 'cruise_milestone_controller_history_entry',
    sequence,
    run_id: state.run_id,
    milestone_id: state.milestone_id,
    goal_activation_digest: state.goal_activation_digest,
    state_revision: state.revision,
    previous_entry_sha256: previousEntry?.entry_sha256 ?? null,
    baseline_progression: transitionLineage.baselineProgression,
    transition_lineage: transitionLineage.transitions,
    files: files.map(persistedControllerFile),
    predecessor_files: predecessorFiles,
  };
  return Object.freeze({
    ...payload,
    entry_sha256: controllerHistoryEntryDigest(payload),
  });
}

function decodeControllerHistoryFile(descriptor, label) {
  requireRecord(descriptor, label);
  const path = assertSafeRelativePath(descriptor.path, `${label}.path`);
  const digest = runtimeDigest(descriptor.file_sha256, `${label}.file_sha256`);
  const encoded = nonEmptyRuntimeString(descriptor.yaml_base64, `${label}.yaml_base64`);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded || sha256(bytes) !== digest) {
    throw new Error(`${label} does not preserve its exact YAML bytes.`);
  }
  let record;
  try {
    record = parseYaml(bytes.toString('utf8'));
  } catch (cause) {
    throw new Error(`${label} contains invalid YAML: ${cause.message}`, { cause });
  }
  if (!Buffer.from(stringifyYaml(record), 'utf8').equals(bytes)) {
    throw new Error(`${label} YAML bytes are not canonical controller output.`);
  }
  return Object.freeze({ path, file_sha256: digest, yaml_base64: encoded, bytes, record });
}

function decodeControllerPredecessor(descriptor, expectedPath, label) {
  requireRecord(descriptor, label);
  if (descriptor.path !== expectedPath || typeof descriptor.present !== 'boolean') {
    throw new Error(`${label} is not bound to the expected controller mirror path.`);
  }
  if (!descriptor.present) {
    if (descriptor.file_sha256 !== null || descriptor.yaml_base64 !== null) {
      throw new Error(`${label} absent predecessor cannot contain bytes.`);
    }
    return Object.freeze({ path: expectedPath, present: false, bytes: null });
  }
  const decoded = decodeControllerHistoryFile(descriptor, label);
  return Object.freeze({ ...decoded, present: true });
}

function validateControllerHistoryEntry(
  entry,
  sequence,
  previous,
  inspection,
  { authority, goalActivationAuthority },
) {
  requireRecord(entry, `controller history revision ${sequence}`);
  if (
    entry.schema_version !== 1 ||
    entry.kind !== 'cruise_milestone_controller_history_entry' ||
    entry.sequence !== sequence ||
    entry.run_id !== authority.run_id ||
    entry.milestone_id !== inspection.controller.milestone.id ||
    entry.goal_activation_digest !== goalActivationAuthority.activation_digest ||
    entry.previous_entry_sha256 !== (previous?.entry.entry_sha256 ?? null) ||
    !Number.isSafeInteger(entry.state_revision) ||
    entry.state_revision < 0 ||
    !Array.isArray(entry.files) ||
    !Array.isArray(entry.transition_lineage)
  ) {
    throw new Error(`Controller history revision ${sequence} breaks its activation-bound chain.`);
  }
  runtimeDigest(entry.entry_sha256, `controller history revision ${sequence} digest`);
  if (entry.entry_sha256 !== controllerHistoryEntryDigest(controllerHistoryEntryPayload(entry))) {
    throw new Error(`Controller history revision ${sequence} digest was rewritten.`);
  }
  const files = entry.files.map((file, index) =>
    decodeControllerHistoryFile(file, `controller history revision ${sequence} files[${index}]`));
  const canonicalStatePath = `${inspection.controller.milestone.path}/STATE.yaml`;
  const canonicalState = files.find(({ path }) => path === canonicalStatePath)?.record;
  if (!canonicalState) {
    throw new Error(`Controller history revision ${sequence} omits canonical STATE.yaml.`);
  }
  validateMilestoneControllerState(canonicalState, {
    authority,
    controllerInspection: inspection,
    goalActivationAuthority,
  });
  if (canonicalState.revision !== entry.state_revision) {
    throw new Error(`Controller history revision ${sequence} state revision is inconsistent.`);
  }
  const expectedFiles = serializeControllerStateFiles(canonicalState);
  if (files.length !== expectedFiles.length) {
    throw new Error(`Controller history revision ${sequence} has an incomplete projection set.`);
  }
  for (let index = 0; index < expectedFiles.length; index += 1) {
    if (
      files[index].path !== expectedFiles[index].path ||
      files[index].file_sha256 !== expectedFiles[index].file_sha256 ||
      !files[index].bytes.equals(expectedFiles[index].bytes)
    ) {
      throw new Error(`Controller history revision ${sequence} projection bytes forked.`);
    }
  }
  if (
    entry.transition_lineage.length === 0 ||
    entry.transition_lineage.some((transition) =>
      !isRecord(transition) ||
      !Number.isSafeInteger(transition.revision) ||
      typeof transition.baseline_changed !== 'boolean' ||
      typeof transition.transition !== 'string' ||
      typeof transition.baseline_authority !== 'string')
  ) {
    throw new Error(`Controller history revision ${sequence} has invalid transition provenance.`);
  }
  const firstTransitionRevision = previous === null ? 0 : previous.state.revision + 1;
  for (const [index, transition] of entry.transition_lineage.entries()) {
    if (transition.revision !== firstTransitionRevision + index) {
      throw new Error(`Controller history revision ${sequence} transition revisions are not contiguous.`);
    }
  }
  if (
    entry.transition_lineage.at(-1).revision !== canonicalState.revision ||
    (previous === null &&
      (entry.transition_lineage[0].transition !== 'goal_activated' ||
        entry.transition_lineage[0].baseline_authority !== 'activation'))
  ) {
    throw new Error(`Controller history revision ${sequence} transition tip is inconsistent.`);
  }
  const changedTransitions = entry.transition_lineage.filter(
    ({ baseline_changed: baselineChanged }) => baselineChanged,
  );
  const changedTransitionsAttested = changedTransitions.every(
    ({ transition, baseline_authority: baselineAuthority }) =>
      transition === 'phase_closeout' &&
      baselineAuthority === 'phase_closeout_attestation',
  );
  const expectedBaselineProgression = previous === null
    ? 'activation'
    : changedTransitionsAttested
      ? 'attested'
      : 'unattested';
  if (entry.baseline_progression !== expectedBaselineProgression) {
    throw new Error(`Controller history revision ${sequence} misstates transition attestation.`);
  }
  let predecessorFiles;
  let attestedAncestorEntrySha256;
  if (previous === null) {
    if (
      canonicalState.revision !== 0 ||
      entry.baseline_progression !== 'activation' ||
      !Array.isArray(entry.predecessor_files) ||
      entry.predecessor_files.length !== files.length
    ) {
      throw new Error('Controller history genesis must be exact activated revision zero.');
    }
    predecessorFiles = entry.predecessor_files.map((descriptor, index) =>
      decodeControllerPredecessor(
        descriptor,
        files[index].path,
        `controller history genesis predecessor_files[${index}]`,
      ));
    attestedAncestorEntrySha256 = [entry.entry_sha256];
  } else {
    if (
      entry.predecessor_files !== null ||
      canonicalState.revision <= previous.state.revision ||
      !['attested', 'unattested'].includes(entry.baseline_progression)
    ) {
      throw new Error(`Controller history revision ${sequence} is a rollback or malformed successor.`);
    }
    const baselineChanged =
      canonicalState.repository_baseline_digest !== previous.state.repository_baseline_digest;
    if (
      (baselineChanged && changedTransitions.length === 0) ||
      (!baselineChanged && changedTransitions.length > 0 &&
        entry.transition_lineage.at(-1).baseline_changed)
    ) {
      throw new Error(`Controller history revision ${sequence} misstates baseline attestation.`);
    }
    predecessorFiles = previous.files.map((file) =>
      Object.freeze({ ...file, present: true }));
    attestedAncestorEntrySha256 = entry.baseline_progression === 'attested'
      ? [...previous.proof.attested_ancestor_entry_sha256, entry.entry_sha256]
      : [entry.entry_sha256];
  }
  const proof = Object.freeze({
    entry_sha256: entry.entry_sha256,
    sequence,
    state_revision: canonicalState.revision,
    attested_ancestor_entry_sha256: Object.freeze(attestedAncestorEntrySha256),
    genesis_entry_sha256:
      previous?.proof.genesis_entry_sha256 ?? entry.entry_sha256,
    fully_attested_from_activation:
      previous === null || (
        previous.proof.fully_attested_from_activation &&
        entry.baseline_progression === 'attested'
      ),
  });
  return Object.freeze({
    entry,
    state: canonicalState,
    files: Object.freeze(files),
    predecessorFiles: Object.freeze(predecessorFiles),
    proof,
  });
}

async function readControllerStateHistory(
  repositoryRoot,
  inspection,
  { authority, goalActivationAuthority, allowMissing = false },
) {
  const relativeDirectory = controllerHistoryRelativePath(
    inspection.controller.milestone.path,
  );
  const absoluteDirectory = join(repositoryRoot, relativeDirectory);
  let metadata;
  try {
    metadata = await lstat(absoluteDirectory);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw new Error(`Missing durable controller history at ${relativeDirectory}.`, { cause: error });
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (metadata.mode & 0o777) !== 0o700 ||
    await realpath(absoluteDirectory) !== absoluteDirectory
  ) {
    throw new Error(`${relativeDirectory} must be a private 0700 no-follow directory.`);
  }
  const directoryEntries = await readdir(absoluteDirectory, { withFileTypes: true });
  const names = directoryEntries.map(({ name }) => name).sort((left, right) =>
    left.localeCompare(right, 'en'));
  if (names.length === 0) {
    if (allowMissing) return null;
    throw new Error(`${relativeDirectory} cannot be empty.`);
  }
  const entries = [];
  let previous = null;
  for (const [sequence, name] of names.entries()) {
    const match = CONTROLLER_HISTORY_ENTRY.exec(name);
    const directoryEntry = directoryEntries.find((candidate) => candidate.name === name);
    if (
      !match ||
      Number(match[1]) !== sequence ||
      !directoryEntry?.isFile() ||
      directoryEntry.isSymbolicLink()
    ) {
      throw new Error(`${relativeDirectory} must contain one contiguous immutable entry per commit.`);
    }
    const entryMetadata = await lstat(join(absoluteDirectory, name));
    if ((entryMetadata.mode & 0o777) !== 0o400) {
      throw new Error(`${relativeDirectory}/${name} must remain immutable mode 0400.`);
    }
    const artifact = await readRegularArtifact(repositoryRoot, `${relativeDirectory}/${name}`);
    let parsed;
    try {
      parsed = parseYaml(artifact.bytes.toString('utf8'));
    } catch (cause) {
      throw new Error(`${relativeDirectory}/${name} is invalid: ${cause.message}`, { cause });
    }
    const validated = validateControllerHistoryEntry(
      parsed,
      sequence,
      previous,
      inspection,
      { authority, goalActivationAuthority },
    );
    entries.push(validated);
    previous = validated;
  }
  const after = await lstat(absoluteDirectory);
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    after.dev !== metadata.dev ||
    after.ino !== metadata.ino ||
    after.mtimeMs !== metadata.mtimeMs ||
    after.ctimeMs !== metadata.ctimeMs ||
    (after.mode & 0o777) !== 0o700 ||
    await realpath(absoluteDirectory) !== absoluteDirectory
  ) {
    throw new Error(`${relativeDirectory} changed while its immutable chain was read.`);
  }
  return Object.freeze({
    relativeDirectory,
    entries: Object.freeze(entries),
    head: entries.at(-1),
  });
}

async function appendControllerHistoryEntry(repositoryRoot, milestonePath, entry) {
  const relativeDirectory = controllerHistoryRelativePath(milestonePath);
  await ensureRuntimeDirectory(repositoryRoot, relativeDirectory);
  const absoluteDirectory = join(repositoryRoot, relativeDirectory);
  await chmod(absoluteDirectory, 0o700);
  const milestoneDirectoryHandle = await open(
    join(repositoryRoot, milestonePath),
    fsConstants.O_RDONLY,
  );
  try {
    await milestoneDirectoryHandle.sync();
  } finally {
    await milestoneDirectoryHandle.close();
  }
  const name = `REV-${String(entry.sequence).padStart(12, '0')}.yaml`;
  const finalPath = join(absoluteDirectory, name);
  const temporaryRelativePath = `${milestonePath}/.controller-history-${randomUUID()}.yaml`;
  const temporaryPath = join(repositoryRoot, temporaryRelativePath);
  try {
    await writeYamlFile(temporaryPath, entry, { mode: 0o400 });
    await link(temporaryPath, finalPath);
    const directoryHandle = await open(absoluteDirectory, fsConstants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error('Controller history compare-and-swap rejected a concurrent or forked append.');
    }
    throw error;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function writeControllerStateMirror(repositoryRoot, file) {
  const directory = file.path.split('/').slice(0, -1).join('/');
  await ensureRuntimeDirectory(repositoryRoot, directory);
  await writeYamlFile(join(repositoryRoot, file.path), file.record);
  const written = await readRegularArtifact(repositoryRoot, file.path);
  if (written.sha256 !== file.file_sha256 || !written.bytes.equals(file.bytes)) {
    throw new Error(`${file.path} did not preserve the exact durable controller history bytes.`);
  }
}

function liveMatchesControllerPredecessor(live, predecessor) {
  if (!predecessor.present) return live === null;
  return live !== null &&
    live.sha256 === predecessor.file_sha256 &&
    live.bytes.equals(predecessor.bytes);
}

async function reconcileControllerStateMirrors(repositoryRoot, history) {
  const { head } = history;
  let rollForward = false;
  for (let index = 0; index < head.files.length; index += 1) {
    const successor = head.files[index];
    const predecessor = head.predecessorFiles[index];
    const live = await optionalControllerArtifact(repositoryRoot, successor.path);
    const current = live !== null &&
      live.sha256 === successor.file_sha256 &&
      live.bytes.equals(successor.bytes);
    if (current) continue;
    if (!liveMatchesControllerPredecessor(live, predecessor)) {
      throw new Error(
        `${successor.path} is a partial, forked, or rollback write outside durable controller history.`,
      );
    }
    rollForward = true;
  }
  if (rollForward) {
    for (const successor of head.files) {
      await writeControllerStateMirror(repositoryRoot, successor);
    }
  }
  for (const successor of head.files) {
    const live = await optionalControllerArtifact(repositoryRoot, successor.path);
    if (
      live === null ||
      live.sha256 !== successor.file_sha256 ||
      !live.bytes.equals(successor.bytes)
    ) {
      throw new Error(`${successor.path} could not recover to the durable controller history head.`);
    }
  }
  return head;
}

async function persistenceCheckpoint(injector, step) {
  if (injector !== null) await injector(step);
}

function controllerPersistenceResult(head) {
  return Object.freeze({
    revision: head.state.revision,
    commit_sequence: head.entry.sequence,
    commit_sha256: head.entry.entry_sha256,
    history_path: `${head.state.milestone_path}/${CONTROLLER_HISTORY_DIRECTORY}`,
    paths: Object.freeze(head.files.map((file) => Object.freeze({
      path: file.path,
      bytes: file.bytes.length,
    }))),
  });
}

export async function persistMilestoneControllerState({
  cwd,
  state,
  authority,
  controllerInspection,
  goalActivationAuthority,
  persistenceFaultInjector = null,
} = {}) {
  requireControllerStateProvenance(state, goalActivationAuthority);
  const freshInspection = await assertFreshControllerInspection(
    cwd,
    authority,
    controllerInspection,
  );
  validateMilestoneControllerState(state, {
    authority,
    controllerInspection: freshInspection,
    goalActivationAuthority,
  });
  if (persistenceFaultInjector !== null && typeof persistenceFaultInjector !== 'function') {
    throw new Error('persistenceFaultInjector must be a function when supplied.');
  }
  const root = await realpath(resolve(cwd));
  let history = await readControllerStateHistory(root, freshInspection, {
    authority,
    goalActivationAuthority,
    allowMissing: true,
  });
  if (history !== null) {
    await reconcileControllerStateMirrors(root, history);
  }
  const persistedAncestor = nearestPersistedControllerState(state);
  if (
    history !== null &&
    canonicalJson(history.head.state) === canonicalJson(state)
  ) {
    STATE_PERSISTENCE_PROOFS.set(state, history.head.proof);
    return controllerPersistenceResult(history.head);
  }
  if (history === null) {
    if (persistedAncestor !== null || state.revision !== 0) {
      throw new Error('The first controller history commit must be unpersisted revision zero.');
    }
  } else if (
    persistedAncestor?.proof?.entry_sha256 !== history.head.entry.entry_sha256
  ) {
    throw new Error('Controller persistence compare-and-swap rejected a stale, forked, or rollback state.');
  }
  const transitionLineage = controllerPersistenceLineage(
    state,
    persistedAncestor?.state ?? null,
  );
  const files = serializeControllerStateFiles(state);
  const predecessorFiles = history === null
    ? await captureControllerMirrorPredecessors(root, files)
    : null;
  const entry = createControllerHistoryEntry({
    state,
    files,
    previousEntry: history?.head?.entry ?? null,
    sequence: history?.entries.length ?? 0,
    transitionLineage,
    predecessorFiles,
  });
  await appendControllerHistoryEntry(root, state.milestone_path, entry);
  await persistenceCheckpoint(persistenceFaultInjector, 'after_history_append');
  history = await readControllerStateHistory(root, freshInspection, {
    authority,
    goalActivationAuthority,
  });
  if (history.head.entry.entry_sha256 !== entry.entry_sha256) {
    throw new Error('Controller history changed across the immutable append.');
  }
  for (const file of history.head.files) {
    await writeControllerStateMirror(root, file);
    await persistenceCheckpoint(
      persistenceFaultInjector,
      `after_mirror:${file.path}`,
    );
  }
  const committed = await reconcileControllerStateMirrors(root, history);
  if (committed.entry.entry_sha256 !== entry.entry_sha256) {
    throw new Error('Controller persistence did not commit the exact history successor.');
  }
  STATE_PERSISTENCE_PROOFS.set(state, committed.proof);
  return controllerPersistenceResult(committed);
}

export async function loadMilestoneControllerState({
  cwd,
  authority,
  controllerInspection,
  goalActivationAuthority,
} = {}) {
  const inspection = await assertFreshControllerInspection(
    cwd,
    authority,
    controllerInspection,
  );
  const root = await realpath(resolve(cwd));
  let history = await readControllerStateHistory(root, inspection, {
    authority,
    goalActivationAuthority,
  });
  let committed = await reconcileControllerStateMirrors(root, history);
  const checkedHistory = await readControllerStateHistory(root, inspection, {
    authority,
    goalActivationAuthority,
  });
  if (checkedHistory.head.entry.entry_sha256 !== committed.entry.entry_sha256) {
    history = checkedHistory;
    committed = await reconcileControllerStateMirrors(root, history);
    const finalHistory = await readControllerStateHistory(root, inspection, {
      authority,
      goalActivationAuthority,
    });
    if (finalHistory.head.entry.entry_sha256 !== committed.entry.entry_sha256) {
      throw new Error('Controller history advanced repeatedly during resume reconciliation.');
    }
  }
  const state = committed.state;
  for (const phase of state.phases) {
    let persistedPlan = null;
    if (['active', 'completed', 'blocked', 'failed'].includes(phase.status)) {
      persistedPlan = await readRegularArtifact(
        root,
        `${state.milestone_path}/phases/${phase.id}/PLAN.md`,
      );
      if (persistedPlan.sha256 !== phase.plan_digest) {
        throw new Error(`${phase.id} persisted phase PLAN.md is stale or forged.`);
      }
    }
    if (phase.status === 'completed') {
      const closeout = await readRegularArtifact(
        root,
        `${state.milestone_path}/phases/${phase.id}/CLOSEOUT.md`,
      );
      const evidence = await readPhaseEvidence(root, state, phase.id);
      if (evidence.record.outcome !== 'completed') {
        throw new Error(`${phase.id} persisted evidence is not unqualified completed.`);
      }
      const ids = validateEvidenceIds(
        evidence.record,
        phase.evidence_ids,
        state.run_id,
        `${phase.id} persisted closeout`,
      );
      const items = new Map(evidence.record.items.map((item) => [item.id, item]));
      if (
        closeout.sha256 !== phase.closeout_digest ||
        evidenceDigest(evidence.record) !== phase.evidence_digest ||
        phase.acceptance_criteria.some(
          (criterion) => !ids.some((id) => items.get(id)?.supports.includes(criterion)),
        )
      ) {
        throw new Error(`${phase.id} persisted completion evidence is stale or forged.`);
      }
    }
  }
  if (state.status === 'complete') {
    const evidencePath = `${state.milestone_path}/MILESTONE-EVIDENCE.yaml`;
    const evidenceArtifact = await readRegularArtifact(root, evidencePath);
    let record;
    try {
      record = parseYaml(evidenceArtifact.bytes.toString('utf8'));
      validateEvidenceRecord(record);
    } catch (cause) {
      throw new Error(`${evidencePath} is not a valid evidence record: ${cause.message}`, {
        cause,
      });
    }
    const ids = validateEvidenceIds(
      record,
      state.aggregate_evidence_ids,
      state.run_id,
      'persisted milestone completion',
    );
    const requiredPhaseEvidence = new Set(
      state.phases
        .filter((phase) => phase.mandatory)
        .flatMap((phase) => phase.evidence_ids),
    );
    if ([...requiredPhaseEvidence].some((id) => !ids.includes(id))) {
      throw new Error(
        'Persisted milestone aggregate evidence omits mandatory phase closeout evidence.',
      );
    }
    if (
      record.outcome !== 'completed' ||
      evidenceDigest(record) !== state.aggregate_evidence_digest
    ) {
      throw new Error('Persisted milestone aggregate evidence is stale or forged.');
    }
  }
  if (await freshRepositoryBaselineDigest(cwd) !== state.repository_baseline_digest) {
    throw new Error('Repository baseline drifted after the persisted controller revision.');
  }
  const branded = brandControllerState(state, {
    goalActivationAuthority,
    parentState: null,
    transition: 'history_verified_load',
    baselineAuthority: 'history_verified',
  });
  STATE_PERSISTENCE_PROOFS.set(branded, committed.proof);
  return branded;
}

export function dangerousAuthorizationToken(milestoneId, contractDigest) {
  if (!MILESTONE_ID.test(String(milestoneId))) {
    throw new Error('Dangerous authorization requires a stable M-XX milestone ID.');
  }
  const digest = String(contractDigest);
  if (!SHA256.test(digest)) {
    throw new Error('Dangerous authorization requires the current lowercase contract digest.');
  }
  return `DANGEROUSLY-TRUST-CRUISE ${milestoneId} ${digest.slice(0, 12)}`;
}

function controllerBaselineFullyAttestedFromActivation(state, goalActivationAuthority) {
  const visited = new Set();
  let cursor = state;
  while (cursor !== null) {
    if (visited.has(cursor)) return false;
    visited.add(cursor);
    const metadata = stateBrandMetadata(cursor);
    if (metadata?.goalActivationAuthority !== goalActivationAuthority) return false;
    const parent = metadata.parentState;
    if (parent === null) {
      const proof = STATE_PERSISTENCE_PROOFS.get(cursor);
      if (proof) return proof.fully_attested_from_activation === true;
      return metadata.transition === 'goal_activated' &&
        metadata.baselineAuthority === 'activation';
    }
    if (
      cursor.repository_baseline_digest !== parent.repository_baseline_digest &&
      metadata.baselineAuthority !== 'phase_closeout_attestation'
    ) {
      return false;
    }
    cursor = parent;
  }
  return false;
}

async function dangerousBindings({
  cwd,
  state,
  authority,
  controllerInspection,
  goalActivationAuthority,
} = {}) {
  const runId = nonEmptyRuntimeString(authority?.run_id, 'authority.run_id');
  requireControllerStateProvenance(state, goalActivationAuthority);
  const inspection = await assertFreshControllerInspection(
    cwd,
    authority,
    controllerInspection,
  );
  validateMilestoneControllerState(state, {
    authority,
    controllerInspection: inspection,
    goalActivationAuthority,
  });
  if (!controllerBaselineFullyAttestedFromActivation(state, goalActivationAuthority)) {
    throw new Error(
      'Dangerous question suppression requires a baseline lineage fully attested from native Goal activation.',
    );
  }
  const baseline = await freshRepositoryBaselineDigest(cwd);
  if (baseline !== state.repository_baseline_digest) {
    throw new Error('Repository baseline differs from the activated controller state.');
  }
  return Object.freeze({
    run_id: runId,
    session_id: authority.session_id,
    authority_interaction_id: authority.interaction_id,
    milestone_id: inspection.controller.milestone.id,
    controller_digest: inspection.controllerArtifact.sha256,
    contract_digest: inspection.controller.milestone.contract_digest,
    repository_baseline_digest: baseline,
    permission_envelope_digest: inspection.permissionEnvelopeDigest,
    goal_activation_digest: goalActivationAuthority.activation_digest,
    state_revision: state.revision,
  });
}

function sameDangerousBindings(expected, actual, { includeState = true } = {}) {
  const fields = [
    'run_id',
    'session_id',
    'authority_interaction_id',
    'milestone_id',
    'controller_digest',
    'contract_digest',
    'permission_envelope_digest',
    'goal_activation_digest',
    'repository_baseline_digest',
  ];
  if (includeState) fields.push('state_revision');
  return fields.every((field) => expected[field] === actual[field]);
}

export async function issueDangerousAuthorizationChallenge({
  cwd,
  state,
  authority,
  controllerInspection,
  goalActivationAuthority,
  now = () => new Date(),
} = {}) {
  const bindings = await dangerousBindings({
    cwd,
    state,
    authority,
    controllerInspection,
    goalActivationAuthority,
  });
  const authorityMetadata = CONTROLLER_AUTHORITIES.get(authority);
  const brokerMetadata = interactionBrokerMetadata(authorityMetadata.interactionBroker);
  const token = dangerousAuthorizationToken(
    bindings.milestone_id,
    bindings.contract_digest,
  );
  const challenge = Object.freeze({
    schema_version: 1,
    kind: 'cruise_dangerous_authorization_challenge',
    run_id: bindings.run_id,
    milestone_id: bindings.milestone_id,
    warning:
      'Dangerous mode suppresses questions only. It cannot expand paths, permissions, ownership, effects, or the approved contract.',
    token,
    issued_at: nowTimestamp(now, 'issued_at'),
  });
  DANGEROUS_CHALLENGES.set(challenge, {
    active: true,
    used: false,
    authority,
    broker: authorityMetadata.interactionBroker,
    state,
    goalActivationAuthority,
    issuedAfterOrdinal: brokerMetadata.ordinal,
    bindings,
    tokenDigest: runtimeDigest(runtimeDigestOfToken(token), 'token digest'),
  });
  return challenge;
}

function runtimeDigestOfToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function invalidateDangerousMetadata(metadata, reason) {
  if (!metadata) return false;
  metadata.active = false;
  metadata.invalidatedReason = reason;
  metadata.invalidatedAt = new Date().toISOString();
  if (metadata.grant) ACTIVE_DANGEROUS_GRANTS.delete(metadata.grant);
  return true;
}

function revokeDangerousForAuthority(authority, reason) {
  let revoked = 0;
  for (const grant of [...ACTIVE_DANGEROUS_GRANTS]) {
    const metadata = DANGEROUS_GRANTS.get(grant);
    if (metadata?.authority === authority && metadata.active) {
      invalidateDangerousMetadata(metadata, reason);
      revoked += 1;
    }
  }
  return revoked;
}

/**
 * Exchange a later opaque direct-user event for a one-time authorization.
 * Raw source/response/warning booleans are deliberately not part of this API.
 */
export async function authorizeDangerousMode({
  challenge,
  directUserEventReceipt,
  cwd,
  state,
  authority,
  controllerInspection,
  goalActivationAuthority,
  now = () => new Date(),
} = {}) {
  const challengeMetadata = challenge && DANGEROUS_CHALLENGES.get(challenge);
  if (
    !challengeMetadata?.active ||
    challengeMetadata.used ||
    challengeMetadata.authority !== authority ||
    challengeMetadata.goalActivationAuthority !== goalActivationAuthority
  ) {
    throw new Error('Dangerous authorization challenge is absent, forged, stale, or already used.');
  }
  const event = directUserEventReceipt && DIRECT_USER_EVENT_RECEIPTS.get(directUserEventReceipt);
  if (
    !event ||
    event.broker !== challengeMetadata.broker ||
    directUserEventReceipt.run_id !== challenge.run_id ||
    directUserEventReceipt.ordinal <= challengeMetadata.issuedAfterOrdinal
  ) {
    throw new Error('Dangerous authorization requires a later opaque direct-user event receipt.');
  }
  let currentBindings;
  try {
    currentBindings = await dangerousBindings({
      cwd,
      state,
      authority,
      controllerInspection,
      goalActivationAuthority,
    });
  } catch (cause) {
    invalidateDangerousMetadata(challengeMetadata, 'binding_drift');
    throw new Error('Dangerous authorization bindings drifted after the warning.', { cause });
  }
  if (!sameDangerousBindings(challengeMetadata.bindings, currentBindings)) {
    invalidateDangerousMetadata(challengeMetadata, 'binding_drift');
    throw new Error('Dangerous authorization bindings drifted after the warning.');
  }
  if (runtimeDigestOfToken(event.answer) !== challengeMetadata.tokenDigest) {
    throw new Error('Dangerous authorization token is not an exact current digest-bound match.');
  }
  challengeMetadata.used = true;
  challengeMetadata.active = false;
  const authorization = Object.freeze({
    schema_version: 1,
    kind: 'cruise_dangerous_one_time_authorization',
    run_id: currentBindings.run_id,
    milestone_id: currentBindings.milestone_id,
    authorized_at: nowTimestamp(now, 'authorized_at'),
    effect: 'suppress_questions_only',
    scope_expansion: false,
  });
  DANGEROUS_AUTHORIZATIONS.set(authorization, {
    active: true,
    consumed: false,
    authority,
    state,
    goalActivationAuthority,
    bindings: currentBindings,
  });
  return authorization;
}

export async function consumeDangerousAuthorization({
  authorization,
  cwd,
  state,
  authority,
  controllerInspection,
  goalActivationAuthority,
  now = () => new Date(),
} = {}) {
  const metadata = authorization && DANGEROUS_AUTHORIZATIONS.get(authorization);
  if (
    !metadata?.active ||
    metadata.consumed ||
    metadata.authority !== authority ||
    metadata.goalActivationAuthority !== goalActivationAuthority
  ) {
    throw new Error('Dangerous authorization is absent, forged, stale, or already consumed.');
  }
  let currentBindings;
  try {
    currentBindings = await dangerousBindings({
      cwd,
      state,
      authority,
      controllerInspection,
      goalActivationAuthority,
    });
  } catch (cause) {
    invalidateDangerousMetadata(metadata, 'binding_drift');
    throw new Error('Dangerous authorization bindings changed before consumption.', { cause });
  }
  if (!sameDangerousBindings(metadata.bindings, currentBindings)) {
    invalidateDangerousMetadata(metadata, 'binding_drift');
    throw new Error('Dangerous authorization bindings changed before consumption.');
  }
  metadata.consumed = true;
  metadata.active = false;
  const grant = Object.freeze({
    schema_version: 1,
    kind: 'cruise_dangerous_question_suppression_grant',
    run_id: currentBindings.run_id,
    milestone_id: currentBindings.milestone_id,
    activated_at: nowTimestamp(now, 'activated_at'),
    effect: 'suppress_questions_only',
    scope_expansion: false,
  });
  DANGEROUS_GRANTS.set(grant, {
    active: true,
    authority,
    state,
    goalActivationAuthority,
    bindings: currentBindings,
    invalidatedReason: null,
    grant,
  });
  ACTIVE_DANGEROUS_GRANTS.add(grant);
  return grant;
}

export function revokeDangerousQuestionSuppression(
  grant,
  reason = 'revoked',
) {
  const effect = grant && DANGEROUS_EFFECT_AUTHORITIES.get(grant);
  const effectiveGrant = effect?.grant ?? grant;
  const metadata = effectiveGrant && DANGEROUS_GRANTS.get(effectiveGrant);
  return invalidateDangerousMetadata(
    metadata,
    nonEmptyRuntimeString(reason, 'reason'),
  );
}

function stateProgressionIsAttested(initialState, currentState, goalActivationAuthority) {
  const initialMetadata = stateBrandMetadata(initialState);
  const currentMetadata = stateBrandMetadata(currentState);
  if (
    !initialMetadata ||
    !currentMetadata ||
    initialMetadata.goalActivationAuthority !== goalActivationAuthority ||
    currentMetadata.goalActivationAuthority !== goalActivationAuthority ||
    currentState.run_id !== initialState.run_id ||
    currentState.revision < initialState.revision
  ) {
    return false;
  }
  if (
    !controllerBaselineFullyAttestedFromActivation(initialState, goalActivationAuthority) ||
    !controllerBaselineFullyAttestedFromActivation(currentState, goalActivationAuthority)
  ) {
    return false;
  }
  if (currentState === initialState) return true;
  let cursor = currentState;
  while (cursor && cursor !== initialState) {
    const metadata = stateBrandMetadata(cursor);
    if (!metadata) return false;
    const parent = metadata.parentState;
    if (parent === null) break;
    if (
      cursor.repository_baseline_digest !== parent.repository_baseline_digest &&
      metadata.baselineAuthority !== 'phase_closeout_attestation'
    ) {
      return false;
    }
    cursor = parent;
  }
  if (cursor === initialState) return true;
  const initialProof = STATE_PERSISTENCE_PROOFS.get(initialState);
  const currentProof = STATE_PERSISTENCE_PROOFS.get(currentState);
  if (!initialProof || !currentProof) return false;
  return currentProof.attested_ancestor_entry_sha256.includes(
    initialProof.entry_sha256,
  );
}

/**
 * Mint the short-lived authority a caller must present to suppress one or more
 * imminent discretionary-question policy checks. Fresh disk inspection and an
 * activation-bound, attested controller-state lineage happen here; a raw grant
 * is deliberately insufficient at the effect boundary.
 */
export async function authorizeDangerousQuestionSuppressionEffect({
  cwd,
  grant,
  state,
  authority,
  controllerInspection,
  goalActivationAuthority,
  now = () => new Date(),
} = {}) {
  const metadata = grant && DANGEROUS_GRANTS.get(grant);
  if (
    !metadata?.active ||
    metadata.authority !== authority ||
    metadata.goalActivationAuthority !== goalActivationAuthority
  ) {
    throw new Error('Dangerous question suppression grant is absent, forged, stale, or revoked.');
  }
  if (!['ready', 'active'].includes(state?.status)) {
    throw new Error('Dangerous question suppression requires activated ready/active controller state.');
  }
  let currentBindings;
  try {
    currentBindings = await dangerousBindings({
      cwd,
      state,
      authority,
      controllerInspection,
      goalActivationAuthority,
    });
  } catch (cause) {
    invalidateDangerousMetadata(metadata, 'binding_drift');
    throw new Error('Dangerous question suppression bindings drifted.', { cause });
  }
  if (
    !sameDangerousBindings(metadata.bindings, currentBindings, { includeState: false }) &&
    !stateProgressionIsAttested(metadata.state, state, goalActivationAuthority)
  ) {
    invalidateDangerousMetadata(metadata, 'unattested_baseline_drift');
    throw new Error(
      'Dangerous question suppression baseline changed without attested controller-state progression.',
    );
  }
  const fixedBindingsMatch = [
    'run_id',
    'session_id',
    'authority_interaction_id',
    'milestone_id',
    'controller_digest',
    'contract_digest',
    'permission_envelope_digest',
    'goal_activation_digest',
  ].every((field) => metadata.bindings[field] === currentBindings[field]);
  if (!fixedBindingsMatch) {
    invalidateDangerousMetadata(metadata, 'binding_drift');
    throw new Error('Dangerous question suppression controller bindings drifted.');
  }
  if (!stateProgressionIsAttested(metadata.state, state, goalActivationAuthority)) {
    invalidateDangerousMetadata(metadata, 'unattested_state_progression');
    throw new Error('Dangerous question suppression state progression is not attested.');
  }
  const effectAuthority = Object.freeze({
    schema_version: 1,
    kind: 'cruise_dangerous_question_suppression_effect',
    run_id: currentBindings.run_id,
    milestone_id: currentBindings.milestone_id,
    state_revision: state.revision,
    repository_baseline_digest: state.repository_baseline_digest,
    authorized_at: nowTimestamp(now, 'authorized_at'),
    effect: 'suppress_questions_only',
    scope_expansion: false,
  });
  DANGEROUS_EFFECT_AUTHORITIES.set(effectAuthority, {
    grant,
    state,
    authority,
    goalActivationAuthority,
    bindings: currentBindings,
  });
  return effectAuthority;
}

export function validateDangerousQuestionSuppression(
  effectAuthority,
  {
    authority,
    controllerInspection,
    repositoryBaselineDigest,
    lifecycleEvent = null,
  } = {},
) {
  const effect = effectAuthority && DANGEROUS_EFFECT_AUTHORITIES.get(effectAuthority);
  const metadata = effect?.grant && DANGEROUS_GRANTS.get(effect.grant);
  if (!effect || !metadata?.active) return false;
  if (metadata.authority !== authority || effect.authority !== authority) {
    invalidateDangerousMetadata(metadata, 'new_run');
    return false;
  }
  if (
    lifecycleEvent !== null &&
    ['cancelled', 'completed', 'new_run', 'permissions_changed', 'revoked'].includes(
      lifecycleEvent,
    )
  ) {
    invalidateDangerousMetadata(metadata, lifecycleEvent);
    return false;
  }
  try {
    const inspection = requireControllerInspection(
      controllerInspection,
      authority,
      authority?.run_id,
    );
    if (
      inspection.controllerArtifact.sha256 !== effect.bindings.controller_digest ||
      inspection.controller.milestone.contract_digest !== effect.bindings.contract_digest ||
      runtimeDigest(repositoryBaselineDigest, 'repositoryBaselineDigest') !==
        effectAuthority.repository_baseline_digest
    ) {
      throw new Error('effect binding drift');
    }
  } catch {
    invalidateDangerousMetadata(metadata, 'binding_invalid');
    return false;
  }
  return effectAuthority.effect === 'suppress_questions_only' &&
    effectAuthority.scope_expansion === false;
}
