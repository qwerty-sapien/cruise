import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import {
  allocateBuildId,
  assertVerifiedBuildApprovalArtifactsCurrent,
  createWorkflowQueue,
  isVerifiedBuildApproval,
  isVerifiedBuildApprovalArtifactSnapshot,
  QUEUE_ITEM_STATUSES,
  validateQueueCoordinationContract,
  validateWorkflowQueue,
  verifyQueueApproval,
  workflowQueueDigest,
} from './build-contract.mjs';
import {
  evidenceDigest,
  validateEvidenceRecord as validateCruiseEvidenceRecord,
} from './evidence.mjs';
import { captureRepositoryBaseline as captureOriginRepositoryBaseline } from './origin.mjs';
import { canonicalJson, parseYaml, stringifyYaml } from './yaml-state.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const EVIDENCE_ID = /^E-\d{2,}$/u;
const QUEUE_STATE_HISTORY_ENTRY = /^REV-(\d{12})\.yaml$/u;
const QUEUE_STATE_COMMITMENT_ENTRY = /^REV-(\d{12})\.yaml$/u;
const QUEUE_STATE_HISTORY_MAX_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COORDINATORS = new WeakSet();
const COORDINATOR_STATES = new WeakSet();
const DEBUG_REVISIONS = new WeakSet();
const START_ADMISSIONS = new WeakSet();
const CONSUMED_START_ADMISSIONS = new WeakSet();
const BASELINE_ATTESTATIONS = new WeakSet();
const CONSUMED_BASELINE_ATTESTATIONS = new WeakSet();
const BASELINE_TRANSITIONS = new WeakSet();
const CONSUMED_BASELINE_TRANSITIONS = new WeakSet();
const SEMANTIC_ADMISSIONS = new WeakSet();
const SEMANTIC_ADMISSION_METADATA = new WeakMap();
const CONSUMED_SEMANTIC_ADMISSIONS = new WeakSet();
const RESEARCH_RECONCILIATIONS = new WeakSet();
const CONSUMED_RESEARCH_RECONCILIATIONS = new WeakSet();
const QUEUE_INTERACTION_BROKERS = new WeakMap();
const QUEUE_SEMANTIC_GATE_RECEIPTS = new WeakMap();
const QUEUE_MANUAL_SELECTION_RECEIPTS = new WeakMap();
const QUEUE_RESEARCH_RECONCILIATION_RECEIPTS = new WeakMap();
const CONSUMED_QUEUE_SEMANTIC_GATE_RECEIPTS = new WeakSet();
const CONSUMED_QUEUE_MANUAL_SELECTION_RECEIPTS = new WeakSet();
const CONSUMED_QUEUE_RESEARCH_RECONCILIATION_RECEIPTS = new WeakSet();
const RESEARCH_RECONCILIATION_METADATA = new WeakMap();
const CONSUMED_ARTIFACT_SNAPSHOTS = new WeakSet();
const QUEUE_STATE_SNAPSHOTS = new WeakSet();
const PERSISTED_QUEUE_STATE_SNAPSHOTS = new WeakSet();
const QUEUE_STATE_RESUME_ATTESTATIONS = new WeakSet();
const CONSUMED_QUEUE_STATE_RESUME_ATTESTATIONS = new WeakSet();
const ISSUED_QUEUE_STATE_RESUME_INTERACTIONS = new Set();
const PERSISTED_QUEUE_STATE_HEADS = new WeakMap();
const COMMITTED_QUEUE_IDS_BY_BUILD_APPROVAL = new WeakMap();
const FAILED_DEPENDENCY_STATUSES = new Set(['blocked', 'failed', 'skipped', 'cancelled']);

export const LEGAL_QUEUE_STATUS_TRANSITIONS = Object.freeze({
  queued: Object.freeze([]),
  ready: Object.freeze([
    'running',
    'waiting_approval',
    'waiting_auth',
    'blocked',
    'skipped',
    'cancelled',
  ]),
  running: Object.freeze(['waiting_auth', 'blocked', 'completed', 'failed', 'cancelled']),
  waiting_approval: Object.freeze(['ready', 'blocked', 'cancelled']),
  waiting_auth: Object.freeze(['ready', 'running', 'blocked', 'failed', 'cancelled']),
  blocked: Object.freeze(['ready', 'failed', 'skipped', 'cancelled']),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  skipped: Object.freeze([]),
  cancelled: Object.freeze([]),
});

const FAILURE_CLASSIFICATIONS = new Set([
  'implementation_defect',
  'invalid_assumption',
  'unavailable_capability',
  'permission_problem',
  'authentication_refusal',
  'research_contradiction',
  'contract_defect',
  'unknown_cause',
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function fileDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function nowIso(now = () => new Date()) {
  const supplied = typeof now === 'function' ? now() : now;
  const date = supplied instanceof Date ? supplied : new Date(supplied);
  if (Number.isNaN(date.getTime())) throw new TypeError('clock must return a valid date-time');
  return date.toISOString();
}

function stringArray(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
  }
  const result = value.map((entry) => nonEmpty(entry, `${label} entry`));
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates`);
  return result;
}

function safeRelativePathArray(value, label, { allowEmpty = true } = {}) {
  const result = stringArray(value, label, { allowEmpty });
  for (const path of result) {
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
      throw new Error(`${label} must contain only safe repository-relative POSIX paths`);
    }
  }
  return result;
}

function exactKeys(value, keys, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object`);
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} fields must be exactly: ${expected.join(', ')}`);
  }
}

function queueApprovalDigest(approval) {
  return digest(approval);
}

function createPrivateQueueState(queue, at) {
  return {
    schema_version: 1,
    kind: 'cruise_queue_state',
    queue_id: queue.queue.id,
    definition_sha256: workflowQueueDigest(queue),
    updated_at: at,
    items: queue.items.map((item) => ({
      id: item.id,
      status: 'queued',
      blockers: [],
      attempts: [],
      result: null,
      updated_at: at,
    })),
  };
}

function validatePrivateQueueState(queue, state) {
  if (!isPlainObject(state) || state.kind !== 'cruise_queue_state') {
    throw new TypeError('queue state is invalid');
  }
  if (
    state.queue_id !== queue.queue.id ||
    state.definition_sha256 !== workflowQueueDigest(queue)
  ) {
    throw new Error('queue state is not bound to the current immutable definition');
  }
  if (!Array.isArray(state.items) || state.items.length !== queue.items.length) {
    throw new Error('queue state item set differs from the definition');
  }
  const expected = new Set(queue.items.map((item) => item.id));
  for (const item of state.items) {
    if (
      !isPlainObject(item) ||
      !expected.delete(item.id) ||
      !QUEUE_ITEM_STATUSES.includes(item.status) ||
      item.status === 'draft'
    ) {
      throw new Error('queue state contains an invalid item or status');
    }
  }
  if (expected.size > 0) throw new Error('queue state omits an item');
  return state;
}

function reconcilePrivateQueueState(queue, stateInput, at) {
  const state = clone(validatePrivateQueueState(queue, stateInput));
  const byState = new Map(state.items.map((item) => [item.id, item]));
  for (const definition of queue.items) {
    const item = byState.get(definition.id);
    if (!['queued', 'ready'].includes(item.status)) continue;
    const dependencies = definition.requires.map((id) => byState.get(id));
    const failed = dependencies.find((dependency) =>
      FAILED_DEPENDENCY_STATUSES.has(dependency.status));
    if (failed) {
      item.status = 'blocked';
      item.blockers = [`dependency_${failed.status}:${failed.id}`];
    } else if (dependencies.some((dependency) => dependency.status === 'waiting_auth')) {
      item.status = 'queued';
      item.blockers = ['waiting_auth_dependency'];
    } else if (dependencies.every((dependency) => dependency.status === 'completed')) {
      item.status = 'ready';
      item.blockers = [];
    } else {
      item.status = 'queued';
      item.blockers = ['waiting_dependencies'];
    }
    item.updated_at = at;
  }
  state.updated_at = at;
  return state;
}

function privateQueueCompletionStatus(queue, stateInput) {
  const state = validatePrivateQueueState(queue, stateInput);
  const byState = new Map(state.items.map((item) => [item.id, item]));
  const mandatory = queue.items
    .filter((item) => item.mandatory)
    .map((item) => byState.get(item.id));
  if (mandatory.every((item) => item.status === 'completed')) {
    return deepFreeze({ status: 'completed', blocking_items: [] });
  }
  const blocking = mandatory
    .filter((item) => FAILED_DEPENDENCY_STATUSES.has(item.status))
    .map((item) => item.id);
  return deepFreeze({
    status: blocking.length > 0 ? 'blocked' : 'in_progress',
    blocking_items: blocking,
  });
}

function evaluatePrivateAutoStart(
  coordinator,
  state,
  { itemId, mandatoryAmbiguity = false, observedConditions = [] } = {},
) {
  verifyQueueApproval(coordinator.queue, coordinator.queue_approval, {
    verifiedBuildApproval: coordinator.verified_build_approval,
  });
  const item = coordinator.queue.items.find((entry) => entry.id === itemId);
  if (!item) throw new Error(`unknown queue item ${itemId}`);
  const runtime = state.items.find((entry) => entry.id === itemId);
  const deny = (disposition, reason, nextAction) => deepFreeze({
    may_start_automatically: false,
    disposition,
    reason,
    next_action: nextAction,
    truthful_handoff_required: false,
  });
  if (!item.auto_start) return deny('ready', 'auto_start_not_approved', 'start_item_manually');
  if (!['queued', 'ready'].includes(runtime.status)) {
    return deny(runtime.status, `item_not_startable:${runtime.status}`, 'resolve_item_runtime_state');
  }
  const byState = new Map(state.items.map((entry) => [entry.id, entry]));
  if (!item.requires.every((id) => byState.get(id).status === 'completed')) {
    return deny('queued', 'prerequisites_incomplete', 'complete_queue_prerequisites');
  }
  if (mandatoryAmbiguity) {
    return deny('waiting_approval', 'mandatory_ambiguity', 'resolve_mandatory_ambiguity');
  }
  const observed = new Set(stringArray(observedConditions, 'observedConditions'));
  if (!item.auto_start_conditions.every((condition) => observed.has(condition))) {
    return deny('ready', 'auto_start_conditions_unmet', 'satisfy_auto_start_conditions');
  }
  return deepFreeze({
    may_start_automatically: true,
    disposition: 'start',
    reason: 'all_approved_auto_start_gates_pass',
    next_action: 'launch_selected_public_skill',
    truthful_handoff_required: false,
  });
}

function requireCoordinator(coordinator) {
  if (!isPlainObject(coordinator) || !COORDINATORS.has(coordinator)) {
    throw new Error('queue mutation requires an opaque private Build coordinator authority');
  }
  if (!isVerifiedBuildApproval(coordinator.verified_build_approval)) {
    throw new Error('coordinator lost its verifier-branded Build approval receipt');
  }
  verifyQueueApproval(coordinator.queue, coordinator.queue_approval, {
    verifiedBuildApproval: coordinator.verified_build_approval,
  });
  validateQueueCoordinationContract(coordinator.queue, {
    milestonePhaseDag: coordinator.verified_build_approval.milestone_phase_dag,
  });
  return coordinator;
}

/**
 * Mint the only authority accepted by the evidence-aware queue mutation path.
 * Plain serialized approvals and receipts intentionally cannot mint it.
 */
export function createBuildQueueCoordinator({
  queue: queueInput,
  verifiedBuildApproval,
  queueApproval,
  reactiveDebugRevision = null,
} = {}) {
  if (!isVerifiedBuildApproval(verifiedBuildApproval) || verifiedBuildApproval.valid !== true) {
    throw new Error('private coordinator requires an opaque verifier-branded Build approval receipt');
  }
  const queue = validateWorkflowQueue(queueInput);
  validateQueueCoordinationContract(queue, {
    milestonePhaseDag: verifiedBuildApproval.milestone_phase_dag,
  });
  verifyQueueApproval(queue, queueApproval, { verifiedBuildApproval });
  const debugItems = queue.items.filter(({ skill }) => skill === 'debug');
  if (debugItems.length > 0 && reactiveDebugRevision == null) {
    throw new Error(
      'an approved queue containing reactive Debug requires its opaque Q2 revision authority',
    );
  }
  if (debugItems.length === 0 && reactiveDebugRevision != null) {
    throw new Error('reactive Debug revision authority cannot be attached to a queue without Debug');
  }
  if (reactiveDebugRevision != null) {
    if (!DEBUG_REVISIONS.has(reactiveDebugRevision)) {
      throw new Error('reactive Debug authority requires an opaque unapproved revision record');
    }
    if (reactiveDebugRevision.definition_sha256 !== workflowQueueDigest(queue)) {
      throw new Error('reactive Debug revision does not match the newly approved queue');
    }
    const failedEnvelope = reactiveDebugRevision.superseded_queue?.items?.find(
      ({ id }) => id === reactiveDebugRevision.trigger?.failed_item_id,
    );
    if (
      debugItems.length !== 1 ||
      debugItems[0].id !== reactiveDebugRevision.debug_item_id ||
      debugItems[0].consumes.length !== 1 ||
      debugItems[0].consumes[0] !== reactiveDebugRevision.trigger.failure_artifact ||
      failedEnvelope == null ||
      canonicalJson(debugItems[0].permitted_changes) !==
        canonicalJson(failedEnvelope.permitted_changes) ||
      canonicalJson(debugItems[0].prohibited_changes) !==
        canonicalJson(failedEnvelope.prohibited_changes)
    ) {
      throw new Error(
        'reactive Debug item does not match its opaque Q2 failure trigger and path envelope',
      );
    }
  }
  const coordinator = deepFreeze({
    schema_version: 1,
    kind: 'cruise_private_build_queue_coordinator',
    queue,
    verified_build_approval: verifiedBuildApproval,
    queue_approval: queueApproval,
    queue_id: queue.queue.id,
    definition_sha256: workflowQueueDigest(queue),
    build_approval_digest: verifiedBuildApproval.approval_digest,
    queue_approval_sha256: queueApprovalDigest(queueApproval),
    reactive_debug_revision: reactiveDebugRevision,
  });
  COORDINATORS.add(coordinator);
  return coordinator;
}

function mintStartAdmission(coordinator, state, itemId, source, observedAt, provenance) {
  const item = coordinator.queue.items.find(({ id }) => id === itemId);
  const runtime = state.items.find(({ id }) => id === itemId);
  if (!item || runtime?.status !== 'ready') {
    throw new Error('start admission may be issued only for a ready approved queue item');
  }
  assertVerifiedBuildApprovalArtifactsCurrent({
    root: coordinator.verified_build_approval.approval_readiness.bindings.repository_root,
    verifiedBuildApproval: coordinator.verified_build_approval,
    artifactSnapshot: provenance.baseline_attestation?.verified_artifact_snapshot,
  });
  const repositoryRoot =
    coordinator.verified_build_approval.approval_readiness.bindings.repository_root;
  const currentRepositoryBaseline = captureOriginRepositoryBaseline(repositoryRoot);
  if (currentRepositoryBaseline.capture_status !== 'complete') {
    throw new Error(
      `current repository product baseline capture is blocked: ${
        currentRepositoryBaseline.block?.code ?? 'UNKNOWN'
      }`,
    );
  }
  if (
    currentRepositoryBaseline.root !== repositoryRoot ||
    currentRepositoryBaseline.dirty_state_digest !==
      state.expected_repository_baseline_digest ||
    provenance.baseline_attestation?.repository_baseline_digest !==
      state.expected_repository_baseline_digest
  ) {
    throw new Error('current repository product baseline differs at the final start boundary');
  }
  const token = deepFreeze({
    kind: 'cruise_opaque_queue_start_admission',
    source,
    queue_id: coordinator.queue_id,
    queue_item_id: itemId,
    definition_sha256: coordinator.definition_sha256,
    state_revision: state.revision,
    state_sha256: digest(state),
    permission_envelope_sha256: coordinator.queue_approval.permission_envelope_sha256,
    observed_at: observedAt,
    provenance,
  });
  START_ADMISSIONS.add(token);
  if (provenance.baseline_attestation != null) {
    CONSUMED_BASELINE_ATTESTATIONS.add(provenance.baseline_attestation);
  }
  if (SEMANTIC_ADMISSIONS.has(provenance.semantic_admission)) {
    CONSUMED_SEMANTIC_ADMISSIONS.add(provenance.semantic_admission);
  }
  if (RESEARCH_RECONCILIATIONS.has(provenance.research_reconciliation)) {
    CONSUMED_RESEARCH_RECONCILIATIONS.add(provenance.research_reconciliation);
  }
  if (QUEUE_MANUAL_SELECTION_RECEIPTS.has(provenance.manual_selection_receipt)) {
    CONSUMED_QUEUE_MANUAL_SELECTION_RECEIPTS.add(provenance.manual_selection_receipt);
  }
  return token;
}

/** Bind a fresh locked-artifact verification and current product baseline to one ready item. */
export function attestCurrentBuildQueueBaseline(
  coordinatorInput,
  stateInput,
  { itemId, verifiedArtifactSnapshot, observation } = {},
) {
  const { coordinator, state } = assertCoordinatorState(coordinatorInput, stateInput);
  if (!isVerifiedBuildApprovalArtifactSnapshot(verifiedArtifactSnapshot, {
    verifiedBuildApproval: coordinator.verified_build_approval,
  })) {
    throw new Error('launch requires a fresh opaque locked-Build-artifact snapshot');
  }
  if (CONSUMED_ARTIFACT_SNAPSHOTS.has(verifiedArtifactSnapshot)) {
    throw new Error('locked-Build-artifact snapshot has already been consumed');
  }
  assertVerifiedBuildApprovalArtifactsCurrent({
    root: coordinator.verified_build_approval.approval_readiness.bindings.repository_root,
    verifiedBuildApproval: coordinator.verified_build_approval,
    artifactSnapshot: verifiedArtifactSnapshot,
  });
  exactKeys(
    observation,
    ['kind', 'source', 'baseline_digest', 'cruise_paths_excluded', 'observed_at'],
    'repository baseline observation',
  );
  if (
    observation.kind !== 'host_repository_baseline_observation' ||
    observation.source !== 'deterministic_repository_probe' ||
    observation.cruise_paths_excluded !== true ||
    observation.baseline_digest !== state.expected_repository_baseline_digest
  ) {
    throw new Error('current repository baseline does not match coordinator expectation');
  }
  const runtime = state.items.find(({ id }) => id === itemId);
  if (runtime?.status !== 'ready') throw new Error('baseline may be attested only for a ready item');
  const attestation = deepFreeze({
    kind: 'cruise_opaque_queue_baseline_attestation',
    queue_id: coordinator.queue_id,
    queue_item_id: itemId,
    definition_sha256: coordinator.definition_sha256,
    state_revision: state.revision,
    state_sha256: digest(state),
    repository_baseline_digest: observation.baseline_digest,
    verified_artifact_snapshot: verifiedArtifactSnapshot,
    observed_at: nowIso(observation.observed_at),
  });
  BASELINE_ATTESTATIONS.add(attestation);
  CONSUMED_ARTIFACT_SNAPSHOTS.add(verifiedArtifactSnapshot);
  return attestation;
}

function validateBaselineAttestation(coordinator, state, itemId, attestation) {
  if (!isPlainObject(attestation) || !BASELINE_ATTESTATIONS.has(attestation)) {
    throw new Error('start admission requires an opaque current-baseline attestation');
  }
  if (CONSUMED_BASELINE_ATTESTATIONS.has(attestation)) {
    throw new Error('current-baseline attestation has already been consumed');
  }
  if (
    attestation.queue_id !== coordinator.queue_id ||
    attestation.queue_item_id !== itemId ||
    attestation.definition_sha256 !== coordinator.definition_sha256 ||
    attestation.state_revision !== state.revision ||
    attestation.state_sha256 !== digest(state) ||
    attestation.repository_baseline_digest !== state.expected_repository_baseline_digest
  ) {
    throw new Error('current-baseline attestation is stale or bound to another state/item');
  }
  return attestation;
}

/**
 * Private host boundary for queue UI/router observations. Repository or model
 * data cannot recreate its receipts by copying event fields.
 */
export function createBuildQueueHostInteractionBroker({
  coordinator: coordinatorInput,
  sessionId,
  runId,
} = {}) {
  const coordinator = requireCoordinator(coordinatorInput);
  const session = nonEmpty(sessionId, 'sessionId');
  const run = nonEmpty(runId, 'runId');
  const broker = {};
  const metadata = {
    coordinator,
    sessionId: session,
    runId: run,
    ordinal: 0,
    interactions: new Set(),
  };
  const next = (interactionId, kind) => {
    const interaction = nonEmpty(interactionId, `${kind} interaction_id`);
    const key = `${kind}\0${interaction}`;
    if (metadata.interactions.has(key)) {
      throw new Error(`${kind} interaction has already produced a host receipt`);
    }
    metadata.interactions.add(key);
    metadata.ordinal += 1;
    return { interaction, ordinal: metadata.ordinal };
  };
  Object.defineProperties(broker, {
    observeSemanticAdmission: {
      enumerable: true,
      value: (stateInput, event) => {
        const { state } = assertCoordinatorState(coordinator, stateInput);
        exactKeys(event, [
          'kind',
          'source',
          'interaction_id',
          'queue_item_id',
          'skill',
          'accepted',
          'permissions_satisfied',
          'authentication_satisfied',
          'host_continuation_supported',
          'permission_envelope_sha256',
          'observed_at',
        ], 'host semantic admission observation');
        const definition = coordinator.queue.items.find(({ id }) => id === event.queue_item_id);
        if (
          event.kind !== 'host_queue_semantic_admission_event' ||
          event.source !== 'cruise_router_and_permission_gate' ||
          definition == null ||
          event.skill !== definition.skill ||
          event.accepted !== true ||
          event.permissions_satisfied !== true ||
          event.authentication_satisfied !== true ||
          event.host_continuation_supported !== true ||
          event.permission_envelope_sha256 !==
            coordinator.queue_approval.permission_envelope_sha256
        ) {
          throw new Error('semantic/permission/auth/host start gates did not all pass');
        }
        const sequence = next(event.interaction_id, 'semantic admission');
        const receipt = deepFreeze({
          schema_version: 1,
          kind: 'cruise_host_queue_semantic_gate_receipt',
          session_id: session,
          run_id: run,
          interaction_id: sequence.interaction,
          ordinal: sequence.ordinal,
          queue_id: coordinator.queue_id,
          queue_item_id: definition.id,
          skill: definition.skill,
          definition_sha256: coordinator.definition_sha256,
          state_revision: state.revision,
          state_sha256: digest(state),
          permission_envelope_sha256: event.permission_envelope_sha256,
          observed_at: nowIso(event.observed_at),
        });
        QUEUE_SEMANTIC_GATE_RECEIPTS.set(receipt, { broker, coordinator });
        return receipt;
      },
    },
    observeManualStartSelection: {
      enumerable: true,
      value: (stateInput, event) => {
        const { state } = assertCoordinatorState(coordinator, stateInput);
        exactKeys(event, [
          'kind',
          'source',
          'input_kind',
          'queue_id',
          'queue_item_id',
          'interaction_id',
          'option_id',
          'selected_label',
          'selected_at',
          'offered_options',
        ], 'host manual queue selection');
        const itemId = nonEmpty(event.queue_item_id, 'queue_item_id');
        const optionId = `start_${itemId.toLowerCase()}`;
        const label = `Start ${itemId}`;
        const runtime = state.items.find(({ id }) => id === itemId);
        if (
          event.kind !== 'host_queue_start_event' ||
          event.source !== 'request_user_input' ||
          event.input_kind !== 'option_selection' ||
          event.queue_id !== coordinator.queue_id ||
          runtime?.status !== 'ready' ||
          event.option_id !== optionId ||
          event.selected_label !== label ||
          !Array.isArray(event.offered_options) ||
          !event.offered_options.some((option) =>
            isPlainObject(option) && option.id === optionId && option.label === label)
        ) {
          throw new Error(`manual start must select the exact structured option ${label}`);
        }
        const sequence = next(event.interaction_id, 'manual queue selection');
        const receipt = deepFreeze({
          schema_version: 1,
          kind: 'cruise_host_queue_manual_selection_receipt',
          session_id: session,
          run_id: run,
          interaction_id: sequence.interaction,
          ordinal: sequence.ordinal,
          queue_id: coordinator.queue_id,
          queue_item_id: itemId,
          definition_sha256: coordinator.definition_sha256,
          state_revision: state.revision,
          state_sha256: digest(state),
          option_id: optionId,
          selected_label: label,
          selected_at: nowIso(event.selected_at),
        });
        QUEUE_MANUAL_SELECTION_RECEIPTS.set(receipt, { broker, coordinator });
        return receipt;
      },
    },
    observeResearchReconciliation: {
      enumerable: true,
      value: (stateInput, event) => {
        const { state } = assertCoordinatorState(coordinator, stateInput);
        exactKeys(event, [
          'kind',
          'source',
          'interaction_id',
          'goal_item_id',
          'research_outputs',
          'conclusions',
          'invalidates_approved_assumption',
          'contract_revision_required',
          'reconciled_at',
        ], 'host Research-to-Goal reconciliation');
        const goalItemId = nonEmpty(event.goal_item_id, 'goal_item_id');
        const goal = coordinator.queue.items.find(({ id }) => id === goalItemId);
        const runtime = state.items.find(({ id }) => id === goalItemId);
        if (
          event.kind !== 'host_queue_research_reconciliation_event' ||
          event.source !== 'cruise_research_reconciliation_gate' ||
          goal?.skill !== 'goal' ||
          runtime?.status !== 'ready'
        ) {
          throw new Error('Research reconciliation requires one ready approved Goal queue item');
        }
        const expectedOutputs = researchPredecessorOutputs(coordinator, state, goalItemId);
        if (expectedOutputs.length === 0 || !Array.isArray(event.research_outputs)) {
          throw new Error(`${goalItemId} has no valid completed Research outputs to reconcile`);
        }
        const observedOutputs = event.research_outputs.map((output, index) => {
          exactKeys(output, ['queue_item_id', 'name', 'sha256'], `research_outputs[${index}]`);
          return {
            queue_item_id: nonEmpty(output.queue_item_id, `research_outputs[${index}].queue_item_id`),
            name: nonEmpty(output.name, `research_outputs[${index}].name`),
            sha256: assertDigest(output.sha256, `research_outputs[${index}].sha256`),
          };
        }).sort((left, right) =>
          `${left.queue_item_id}\0${left.name}`.localeCompare(
            `${right.queue_item_id}\0${right.name}`,
            'en',
          ));
        if (canonicalJson(observedOutputs) !== canonicalJson(expectedOutputs)) {
          throw new Error('Research reconciliation does not bind the exact completed output bytes');
        }
        exactKeys(event.conclusions, [
          'milestone_requirements',
          'phase_scope',
          'architecture',
          'permissions',
          'acceptance_criteria',
        ], 'Research reconciliation conclusions');
        const conclusionFields = [
          'milestone_requirements',
          'phase_scope',
          'architecture',
          'permissions',
          'acceptance_criteria',
        ];
        if (
          conclusionFields.some((field) => event.conclusions[field] !== 'consistent') ||
          event.invalidates_approved_assumption !== false ||
          event.contract_revision_required !== false
        ) {
          throw new Error(
            'Research conclusions conflict with the approved milestone; Build contract revision is required',
          );
        }
        const sequence = next(event.interaction_id, 'Research reconciliation');
        const receipt = deepFreeze({
          schema_version: 1,
          kind: 'cruise_host_queue_research_reconciliation_receipt',
          session_id: session,
          run_id: run,
          interaction_id: sequence.interaction,
          ordinal: sequence.ordinal,
          queue_id: coordinator.queue_id,
          goal_item_id: goalItemId,
          definition_sha256: coordinator.definition_sha256,
          state_revision: state.revision,
          state_sha256: digest(state),
          research_outputs: observedOutputs,
          research_outputs_sha256: digest(observedOutputs),
          conclusions: clone(event.conclusions),
          reconciled_at: nowIso(event.reconciled_at),
        });
        QUEUE_RESEARCH_RECONCILIATION_RECEIPTS.set(receipt, { broker, coordinator });
        return receipt;
      },
    },
  });
  QUEUE_INTERACTION_BROKERS.set(broker, metadata);
  return Object.freeze(broker);
}

/** Convert one opaque host-broker receipt into state-bound semantic authority. */
export function attestBuildQueueSemanticAdmission(
  coordinatorInput,
  stateInput,
  receipt,
) {
  const { coordinator, state } = assertCoordinatorState(coordinatorInput, stateInput);
  const metadata = receipt && QUEUE_SEMANTIC_GATE_RECEIPTS.get(receipt);
  if (
    !metadata ||
    metadata.coordinator !== coordinator ||
    CONSUMED_QUEUE_SEMANTIC_GATE_RECEIPTS.has(receipt) ||
    receipt.queue_id !== coordinator.queue_id ||
    receipt.definition_sha256 !== coordinator.definition_sha256 ||
    receipt.state_revision !== state.revision ||
    receipt.state_sha256 !== digest(state)
  ) {
    throw new Error('semantic admission requires a current opaque host-broker receipt');
  }
  const definition = coordinator.queue.items.find(({ id }) => id === receipt.queue_item_id);
  const admission = deepFreeze({
    kind: 'cruise_opaque_queue_semantic_admission',
    queue_id: coordinator.queue_id,
    queue_item_id: definition.id,
    skill: definition.skill,
    definition_sha256: coordinator.definition_sha256,
    state_revision: state.revision,
    state_sha256: digest(state),
    permission_envelope_sha256: receipt.permission_envelope_sha256,
    observed_at: receipt.observed_at,
  });
  SEMANTIC_ADMISSIONS.add(admission);
  SEMANTIC_ADMISSION_METADATA.set(admission, {
    broker: metadata.broker,
    ordinal: receipt.ordinal,
  });
  CONSUMED_QUEUE_SEMANTIC_GATE_RECEIPTS.add(receipt);
  return admission;
}

function validateSemanticAdmission(coordinator, state, itemId, admission) {
  if (!isPlainObject(admission) || !SEMANTIC_ADMISSIONS.has(admission)) {
    throw new Error('start requires opaque semantic/permission/auth/host admission');
  }
  if (CONSUMED_SEMANTIC_ADMISSIONS.has(admission)) {
    throw new Error('semantic start admission has already been consumed');
  }
  const definition = coordinator.queue.items.find(({ id }) => id === itemId);
  if (
    admission.queue_id !== coordinator.queue_id ||
    admission.queue_item_id !== itemId ||
    admission.skill !== definition?.skill ||
    admission.definition_sha256 !== coordinator.definition_sha256 ||
    admission.state_revision !== state.revision ||
    admission.state_sha256 !== digest(state) ||
    admission.permission_envelope_sha256 !==
      coordinator.queue_approval.permission_envelope_sha256
  ) {
    throw new Error('semantic start admission is stale or bound to another item/state');
  }
  return admission;
}

function researchPredecessorOutputs(coordinator, state, goalItemId) {
  const goal = coordinator.queue.items.find(({ id }) => id === goalItemId);
  if (goal?.skill !== 'goal') return [];
  const definitionById = new Map(coordinator.queue.items.map((item) => [item.id, item]));
  const runtimeById = new Map(state.items.map((item) => [item.id, item]));
  const researchIds = new Set();
  const visited = new Set();
  const visit = (itemId) => {
    if (visited.has(itemId)) return;
    visited.add(itemId);
    const definition = definitionById.get(itemId);
    if (!definition) return;
    if (definition.skill === 'research') researchIds.add(itemId);
    for (const dependencyId of definition.requires) visit(dependencyId);
  };
  for (const dependencyId of goal.requires) visit(dependencyId);
  return [...researchIds].sort((left, right) => left.localeCompare(right, 'en')).flatMap((researchItemId) => {
    const runtime = runtimeById.get(researchItemId);
    if (runtime?.status !== 'completed' || !Array.isArray(runtime.result?.outputs)) {
      throw new Error(`${goalItemId} Research predecessor ${researchItemId} is not completed`);
    }
    return runtime.result.outputs.map(({ name, sha256: outputSha256 }) => ({
      queue_item_id: researchItemId,
      name,
      sha256: outputSha256,
    }));
  }).sort((left, right) =>
    `${left.queue_item_id}\0${left.name}`.localeCompare(
      `${right.queue_item_id}\0${right.name}`,
      'en',
    ));
}

/**
 * Bind the mandatory Research -> Goal reconciliation to the exact completed
 * Research output bytes and current queue revision. Conflicts never mint
 * continuation authority; they return to Build contract revision instead.
 */
export function attestBuildQueueResearchReconciliation(
  coordinatorInput,
  stateInput,
  receipt,
) {
  const { coordinator, state } = assertCoordinatorState(coordinatorInput, stateInput);
  const metadata = receipt && QUEUE_RESEARCH_RECONCILIATION_RECEIPTS.get(receipt);
  if (
    !metadata ||
    metadata.coordinator !== coordinator ||
    CONSUMED_QUEUE_RESEARCH_RECONCILIATION_RECEIPTS.has(receipt) ||
    receipt.queue_id !== coordinator.queue_id ||
    receipt.definition_sha256 !== coordinator.definition_sha256 ||
    receipt.state_revision !== state.revision ||
    receipt.state_sha256 !== digest(state)
  ) {
    throw new Error('Research reconciliation requires a current opaque host-broker receipt');
  }
  const goalItemId = receipt.goal_item_id;
  const expectedOutputs = researchPredecessorOutputs(coordinator, state, goalItemId);
  if (
    expectedOutputs.length === 0 ||
    canonicalJson(receipt.research_outputs) !== canonicalJson(expectedOutputs) ||
    receipt.research_outputs_sha256 !== digest(expectedOutputs)
  ) {
    throw new Error('Research reconciliation does not bind the exact completed output bytes');
  }
  const reconciliation = deepFreeze({
    schema_version: 1,
    kind: 'cruise_opaque_research_goal_reconciliation',
    queue_id: coordinator.queue_id,
    goal_item_id: goalItemId,
    definition_sha256: coordinator.definition_sha256,
    state_revision: state.revision,
    state_sha256: digest(state),
    research_outputs: clone(receipt.research_outputs),
    research_outputs_sha256: receipt.research_outputs_sha256,
    conclusions: clone(receipt.conclusions),
    reconciled_at: receipt.reconciled_at,
  });
  RESEARCH_RECONCILIATIONS.add(reconciliation);
  RESEARCH_RECONCILIATION_METADATA.set(reconciliation, {
    broker: metadata.broker,
    ordinal: receipt.ordinal,
  });
  CONSUMED_QUEUE_RESEARCH_RECONCILIATION_RECEIPTS.add(receipt);
  return reconciliation;
}

function validateResearchReconciliation(
  coordinator,
  state,
  itemId,
  reconciliation,
) {
  const expectedOutputs = researchPredecessorOutputs(coordinator, state, itemId);
  if (expectedOutputs.length === 0) {
    if (reconciliation != null) {
      throw new Error('Research reconciliation was supplied for a Goal without Research predecessors');
    }
    return null;
  }
  if (
    !isPlainObject(reconciliation) ||
    !RESEARCH_RECONCILIATIONS.has(reconciliation) ||
    CONSUMED_RESEARCH_RECONCILIATIONS.has(reconciliation) ||
    reconciliation.queue_id !== coordinator.queue_id ||
    reconciliation.goal_item_id !== itemId ||
    reconciliation.definition_sha256 !== coordinator.definition_sha256 ||
    reconciliation.state_revision !== state.revision ||
    reconciliation.state_sha256 !== digest(state) ||
    reconciliation.research_outputs_sha256 !== digest(expectedOutputs) ||
    canonicalJson(reconciliation.research_outputs) !== canonicalJson(expectedOutputs)
  ) {
    throw new Error(
      'Research-dependent Goal start requires a current one-use opaque reconciliation authority',
    );
  }
  return reconciliation;
}

/** Mint a one-use admission only after the canonical auto-start evaluator passes. */
export function authorizeAutomaticBuildQueueStart(
  coordinatorInput,
  stateInput,
  {
    itemId,
    baselineAttestation,
    semanticAdmission,
    researchReconciliation = null,
    mandatoryAmbiguity = false,
    observedConditions = [],
  } = {},
  { now = () => new Date() } = {},
) {
  const { coordinator, state } = assertCoordinatorState(coordinatorInput, stateInput);
  validateBaselineAttestation(coordinator, state, itemId, baselineAttestation);
  validateSemanticAdmission(coordinator, state, itemId, semanticAdmission);
  validateResearchReconciliation(
    coordinator,
    state,
    itemId,
    researchReconciliation,
  );
  if (
    researchReconciliation !== null &&
    SEMANTIC_ADMISSION_METADATA.get(semanticAdmission)?.broker !==
      RESEARCH_RECONCILIATION_METADATA.get(researchReconciliation)?.broker
  ) {
    throw new Error('automatic semantic and Research reconciliation authorities belong to different hosts');
  }
  const evaluation = evaluatePrivateAutoStart(coordinator, state, {
    itemId,
    mandatoryAmbiguity,
    observedConditions,
  });
  if (evaluation.may_start_automatically !== true) {
    throw new Error(`automatic start admission denied: ${evaluation.reason}`);
  }
  return mintStartAdmission(
    coordinator,
    state,
    itemId,
    'verified_auto_start',
    nowIso(now),
    {
      evaluation: clone(evaluation),
      baseline_attestation: baselineAttestation,
      semantic_admission: semanticAdmission,
      research_reconciliation: researchReconciliation,
    },
  );
}

/** Mint a one-use admission from an exact host-observed manual handoff event. */
export function attestManualBuildQueueStart(
  coordinatorInput,
  stateInput,
  selectionReceipt,
  {
    baselineAttestation,
    semanticAdmission,
    researchReconciliation = null,
  } = {},
) {
  const { coordinator, state } = assertCoordinatorState(coordinatorInput, stateInput);
  const selectionMetadata = selectionReceipt &&
    QUEUE_MANUAL_SELECTION_RECEIPTS.get(selectionReceipt);
  if (
    !selectionMetadata ||
    selectionMetadata.coordinator !== coordinator ||
    CONSUMED_QUEUE_MANUAL_SELECTION_RECEIPTS.has(selectionReceipt) ||
    selectionReceipt.queue_id !== coordinator.queue_id ||
    selectionReceipt.definition_sha256 !== coordinator.definition_sha256 ||
    selectionReceipt.state_revision !== state.revision ||
    selectionReceipt.state_sha256 !== digest(state)
  ) {
    throw new Error('manual start requires a current opaque host-broker option receipt');
  }
  const itemId = selectionReceipt.queue_item_id;
  validateBaselineAttestation(coordinator, state, itemId, baselineAttestation);
  validateSemanticAdmission(coordinator, state, itemId, semanticAdmission);
  validateResearchReconciliation(
    coordinator,
    state,
    itemId,
    researchReconciliation,
  );
  const semanticMetadata = SEMANTIC_ADMISSION_METADATA.get(semanticAdmission);
  const reconciliationMetadata = researchReconciliation === null
    ? null
    : RESEARCH_RECONCILIATION_METADATA.get(researchReconciliation);
  if (
    semanticMetadata?.broker !== selectionMetadata.broker ||
    semanticMetadata.ordinal >= selectionReceipt.ordinal ||
    (reconciliationMetadata !== null &&
      (reconciliationMetadata?.broker !== selectionMetadata.broker ||
        reconciliationMetadata.ordinal >= selectionReceipt.ordinal))
  ) {
    throw new Error('manual start authorities must come from one ordered live host broker');
  }
  return mintStartAdmission(
    coordinator,
    state,
    itemId,
    'host_manual_handoff',
    selectionReceipt.selected_at,
    {
      interaction_id: selectionReceipt.interaction_id,
      option_id: selectionReceipt.option_id,
      selected_label: selectionReceipt.selected_label,
      baseline_attestation: baselineAttestation,
      semantic_admission: semanticAdmission,
      research_reconciliation: researchReconciliation,
      manual_selection_receipt: selectionReceipt,
    },
  );
}

function validateStartAdmission(coordinator, state, itemId, admission) {
  if (!isPlainObject(admission) || !START_ADMISSIONS.has(admission)) {
    throw new Error('ready -> running requires an opaque one-use start admission');
  }
  if (CONSUMED_START_ADMISSIONS.has(admission)) {
    throw new Error('queue start admission has already been consumed');
  }
  if (
    admission.queue_id !== coordinator.queue_id ||
    admission.queue_item_id !== itemId ||
    admission.definition_sha256 !== coordinator.definition_sha256 ||
    admission.state_revision !== state.revision ||
    admission.state_sha256 !== digest(state) ||
    admission.permission_envelope_sha256 !==
      coordinator.queue_approval.permission_envelope_sha256
  ) {
    throw new Error('queue start admission is stale or bound to another item/authority');
  }
  return admission;
}

/** Attest the serialized pre/post baseline change observed after one active child. */
export function attestBuildQueueBaselineTransition(
  coordinatorInput,
  stateInput,
  event,
) {
  const { coordinator, state } = assertCoordinatorState(coordinatorInput, stateInput);
  exactKeys(event, [
    'kind',
    'source',
    'queue_item_id',
    'attempt_id',
    'before_digest',
    'after_digest',
    'cruise_paths_excluded',
    'observed_at',
  ], 'repository baseline transition');
  const item = state.items.find(({ id }) => id === event.queue_item_id);
  if (
    event.kind !== 'host_repository_baseline_transition_event' ||
    event.source !== 'deterministic_repository_probe' ||
    event.cruise_paths_excluded !== true ||
    !item?.active_attempt ||
    item.active_attempt.attempt_id !== event.attempt_id ||
    event.before_digest !== state.expected_repository_baseline_digest ||
    event.before_digest !== item.active_attempt.repository_baseline_before
  ) {
    throw new Error('repository baseline transition does not match the active serialized child');
  }
  assertDigest(event.after_digest, 'repository baseline after_digest');
  const transition = deepFreeze({
    kind: 'cruise_opaque_queue_baseline_transition',
    queue_id: coordinator.queue_id,
    queue_item_id: event.queue_item_id,
    attempt_id: event.attempt_id,
    state_revision: state.revision,
    state_sha256: digest(state),
    before_digest: event.before_digest,
    after_digest: event.after_digest,
    observed_at: nowIso(event.observed_at),
  });
  BASELINE_TRANSITIONS.add(transition);
  return transition;
}

function validateBaselineTransition(coordinator, state, item, transition) {
  if (!isPlainObject(transition) || !BASELINE_TRANSITIONS.has(transition)) {
    throw new Error('terminal child transition requires an opaque repository baseline transition');
  }
  if (CONSUMED_BASELINE_TRANSITIONS.has(transition)) {
    throw new Error('repository baseline transition has already been consumed');
  }
  if (
    transition.queue_id !== coordinator.queue_id ||
    transition.queue_item_id !== item.id ||
    transition.attempt_id !== item.active_attempt?.attempt_id ||
    transition.state_revision !== state.revision ||
    transition.state_sha256 !== digest(state) ||
    transition.before_digest !== state.expected_repository_baseline_digest
  ) {
    throw new Error('repository baseline transition is stale or bound to another active child');
  }
  return transition;
}

function validateEvidenceWrapper(wrapper, label) {
  exactKeys(wrapper, ['record_sha256', 'record'], label);
  validateCruiseEvidenceRecord(wrapper.record);
  if (wrapper.record_sha256 !== evidenceDigest(wrapper.record)) {
    throw new Error(`${label} digest does not match its mechanically validated evidence record`);
  }
  return wrapper;
}

function evidenceItemMap(item) {
  return new Map(item.evidence.flatMap(({ record }) => record.items.map((evidence) => [
    evidence.id,
    evidence,
  ])));
}

function eventPayload(event) {
  const { event_sha256: ignored, ...payload } = event;
  void ignored;
  return payload;
}

function validateAttemptLog(item) {
  if (!Array.isArray(item.attempts)) throw new TypeError(`${item.id}.attempts must be an array`);
  const started = new Set();
  const lastStatus = new Map();
  let previous = null;
  for (const [index, event] of item.attempts.entries()) {
    if (!isPlainObject(event) || event.sequence !== index + 1) {
      throw new Error(`${item.id}.attempts must be an ordered append-only event log`);
    }
    if (event.previous_event_sha256 !== previous) {
      throw new Error(`${item.id}.attempts hash chain is discontinuous`);
    }
    if (event.event_sha256 !== digest(eventPayload(event))) {
      throw new Error(`${item.id}.attempts contains modified historical evidence`);
    }
    if (!/^QI-\d{2,}-A-\d{2,}$/u.test(event.attempt_id)) {
      throw new TypeError(`${item.id} attempt_id is invalid`);
    }
    assertDigest(event.definition_sha256, `${event.attempt_id}.definition_sha256`);
    if (event.event === 'started') {
      if (started.has(event.attempt_id)) throw new Error(`${event.attempt_id} started twice`);
      if (event.from_status !== 'ready' || event.to_status !== 'running') {
        throw new Error(`${event.attempt_id} must start with ready -> running`);
      }
      started.add(event.attempt_id);
    } else if (!started.has(event.attempt_id)) {
      throw new Error(`${event.attempt_id} event precedes its start`);
    } else if (event.from_status !== lastStatus.get(event.attempt_id)) {
      throw new Error(`${event.attempt_id} status history cannot be replayed`);
    }
    if (!LEGAL_QUEUE_STATUS_TRANSITIONS[event.from_status]?.includes(event.to_status)) {
      throw new Error(`${event.attempt_id} replays an illegal ${event.from_status} -> ${event.to_status}`);
    }
    const expectedEvent = event.to_status === 'running'
      ? event.from_status === 'ready' ? 'started' : 'resumed'
      : event.to_status;
    if (event.event !== expectedEvent) {
      throw new Error(`${event.attempt_id} event label does not match ${event.from_status} -> ${event.to_status}`);
    }
    stringArray(event.evidence_ids, `${event.attempt_id}.evidence_ids`);
    if (!Array.isArray(event.consumed_inputs)) {
      throw new TypeError(`${event.attempt_id}.consumed_inputs must be an array`);
    }
    lastStatus.set(event.attempt_id, event.to_status);
    previous = event.event_sha256;
  }
}

function validateCoordinatorStateStructure(coordinatorInput, state) {
  const coordinator = requireCoordinator(coordinatorInput);
  if (!isPlainObject(state) || state.kind !== 'cruise_queue_state') {
    throw new TypeError('coordinator state must be a Cruise queue state');
  }
  if (
    state.queue_id !== coordinator.queue_id ||
    state.definition_sha256 !== coordinator.definition_sha256 ||
    state.coordinator?.build_approval_digest !== coordinator.build_approval_digest ||
    state.coordinator?.queue_approval_sha256 !== coordinator.queue_approval_sha256
  ) {
    throw new Error('queue state is not bound to this approved private coordinator');
  }
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
    throw new TypeError('queue state revision must be a non-negative safe integer');
  }
  assertDigest(
    state.expected_repository_baseline_digest,
    'queue state expected_repository_baseline_digest',
  );
  if (
    state.execution_policy?.concurrency !== 'bounded_independent_read_only' ||
    state.execution_policy?.max_parallel_research !== 4
  ) {
    throw new Error('queue coordinator execution policy is invalid');
  }
  validatePrivateQueueState(coordinator.queue, state);
  const globalEvidenceIds = new Set();
  for (const definition of coordinator.queue.items) {
    const item = state.items.find(({ id }) => id === definition.id);
    if (!item || !QUEUE_ITEM_STATUSES.includes(item.status) || item.status === 'draft') {
      throw new Error(`queue state contains invalid runtime item ${definition.id}`);
    }
    stringArray(item.blockers, `${item.id}.blockers`);
    if (!Array.isArray(item.evidence)) throw new TypeError(`${item.id}.evidence must be an array`);
    const evidenceIds = new Set();
    const recordDigests = new Set();
    for (const [index, wrapper] of item.evidence.entries()) {
      validateEvidenceWrapper(wrapper, `${item.id}.evidence[${index}]`);
      if (recordDigests.has(wrapper.record_sha256)) {
        throw new Error(`${item.id} contains duplicate evidence record ${wrapper.record_sha256}`);
      }
      recordDigests.add(wrapper.record_sha256);
      for (const evidence of wrapper.record.items) {
        if (!EVIDENCE_ID.test(evidence.id)) throw new TypeError('evidence IDs must use E-XX');
        if (evidenceIds.has(evidence.id)) {
          throw new Error(`${item.id} contains duplicate evidence ${evidence.id}`);
        }
        if (globalEvidenceIds.has(evidence.id)) {
          throw new Error(`queue state reuses run-global evidence ID ${evidence.id}`);
        }
        evidenceIds.add(evidence.id);
        globalEvidenceIds.add(evidence.id);
      }
    }
    validateAttemptLog(item);
    for (const event of item.attempts) {
      for (const id of event.evidence_ids) {
        if (!evidenceIds.has(id)) throw new Error(`${event.attempt_id} references missing evidence ${id}`);
      }
      if (event.event === 'started') {
        let eventDefinition = definition;
        if (event.definition_sha256 !== coordinator.definition_sha256) {
          const revision = coordinator.reactive_debug_revision;
          if (
            event.definition_sha256 !== revision?.supersedes?.definition_sha256 ||
            !isPlainObject(revision.superseded_queue)
          ) {
            throw new Error(`${event.attempt_id} uses an unapproved historical queue definition`);
          }
          eventDefinition = revision.superseded_queue.items.find(({ id }) => id === item.id);
          if (!eventDefinition) throw new Error(`${event.attempt_id} historical queue item is missing`);
        }
        if (
          validateChildOrigin(coordinator, eventDefinition, event.child_origin) !==
          event.child_origin_sha256
        ) {
          throw new Error(`${event.attempt_id} child origin digest changed`);
        }
        validateConsumedInputs(coordinator, state, eventDefinition, event.consumed_inputs);
      }
    }
    if (item.active_attempt != null) {
      if (!isPlainObject(item.active_attempt)) throw new TypeError(`${item.id}.active_attempt is invalid`);
      if (!['running', 'waiting_auth'].includes(item.status)) {
        throw new Error(`${item.id} has an active attempt while ${item.status}`);
      }
      assertDigest(item.active_attempt.child_origin_sha256, `${item.id}.active_attempt.child_origin_sha256`);
      if (
        validateChildOrigin(coordinator, definition, item.active_attempt.child_origin) !==
        item.active_attempt.child_origin_sha256
      ) {
        throw new Error(`${item.id}.active_attempt child origin digest changed`);
      }
      if (!Array.isArray(item.active_attempt.consumed_inputs)) {
        throw new TypeError(`${item.id}.active_attempt.consumed_inputs must be an array`);
      }
      validateConsumedInputs(coordinator, state, definition, item.active_attempt.consumed_inputs);
      if (
        item.active_attempt.repository_baseline_before !==
        state.expected_repository_baseline_digest
      ) {
        throw new Error(`${item.id}.active_attempt repository baseline is stale`);
      }
    }
    const last = item.attempts.at(-1) ?? null;
    if (['queued', 'ready'].includes(item.status) && item.result != null) {
      throw new Error(`${item.id} ${item.status} state cannot carry a terminal result`);
    }
    if (item.status === 'completed') {
      if (
        item.active_attempt != null ||
        item.result?.kind !== 'cruise_queue_child_completion' ||
        last?.event !== 'completed' ||
        last.to_status !== 'completed'
      ) {
        throw new Error(`${item.id} completed state cannot be replayed from started -> completed`);
      }
      const synthetic = {
        ...item,
        active_attempt: {
          attempt_id: last.attempt_id,
          child_origin_sha256: last.child_origin_sha256,
          consumed_inputs: [],
        },
      };
      const records = new Set(item.evidence.map(({ record_sha256 }) => record_sha256));
      const completion = validateChildCloseout(
        coordinator,
        definition,
        synthetic,
        item.result.child_closeout,
        evidenceItemMap(item),
        new Set(evidenceIds),
        records,
        records,
      );
      if (
        completion.closeout_sha256 !== item.result.child_closeout_sha256 ||
        completion.closeout_sha256 !== last.child_closeout_sha256 ||
        item.result.attempt_id !== last.attempt_id ||
        item.result.result_sha256 !== completion.closeout.result_sha256 ||
        canonicalJson(item.result.outputs) !== canonicalJson(completion.outputs) ||
        canonicalJson(item.result.evidence_ids) !== canonicalJson(completion.evidence_ids) ||
        canonicalJson(item.result.evidence_record_digests) !==
          canonicalJson(completion.evidence_record_digests)
      ) {
        throw new Error(`${item.id} completion result differs from its verified child closeout`);
      }
      const completeRecord = item.evidence.some(({ record_sha256, record }) =>
        completion.evidence_record_digests.includes(record_sha256) && record.outcome === 'completed');
      if (!completeRecord) throw new Error(`${item.id} completion lacks finalized PASS evidence`);
    } else if (item.status === 'failed') {
      if (
        item.active_attempt != null ||
        item.result?.kind !== 'cruise_queue_item_failure' ||
        last?.event !== 'failed' ||
        last.to_status !== 'failed'
      ) {
        throw new Error(`${item.id} failed state cannot be replayed from a running attempt`);
      }
    } else if (item.status === 'running') {
      if (
        item.active_attempt == null ||
        !['started', 'resumed'].includes(last?.event) ||
        last.attempt_id !== item.active_attempt.attempt_id
      ) {
        throw new Error(`${item.id} running state lacks a replayable active attempt`);
      }
    } else if (item.status === 'waiting_auth' && item.active_attempt != null) {
      if (last?.event !== 'waiting_auth' || last.attempt_id !== item.active_attempt.attempt_id) {
        throw new Error(`${item.id} auth wait differs from its active attempt history`);
      }
    }
  }
  return { coordinator, state };
}

function assertCoordinatorState(coordinatorInput, state) {
  if (!isPlainObject(state) || !COORDINATOR_STATES.has(state)) {
    throw new Error(
      'queue mutation requires an opaque reducer state; resume exact persisted bytes with validated evidence',
    );
  }
  return validateCoordinatorStateStructure(coordinatorInput, state);
}

function createInitialCoordinatorState(coordinator, at) {
  const initial = createPrivateQueueState(coordinator.queue, at);
  initial.revision = 0;
  initial.coordinator = {
    kind: 'cruise_private_build_queue_runtime',
    build_approval_digest: coordinator.build_approval_digest,
    queue_approval_sha256: coordinator.queue_approval_sha256,
  };
  initial.expected_repository_baseline_digest =
    coordinator.verified_build_approval.repository_baseline_digest;
  initial.execution_policy = {
    concurrency: 'bounded_independent_read_only',
    max_parallel_research: 4,
  };
  for (const item of initial.items) {
    item.evidence = [];
    item.active_attempt = null;
  }
  const reconciled = reconcilePrivateQueueState(coordinator.queue, initial, at);
  reconciled.updated_at = at;
  return reconciled;
}

export function initializeBuildQueueState(coordinatorInput, { now = () => new Date() } = {}) {
  const coordinator = requireCoordinator(coordinatorInput);
  const at = nowIso(now);
  const reconciled = createInitialCoordinatorState(coordinator, at);
  validateCoordinatorStateStructure(coordinator, reconciled);
  COORDINATOR_STATES.add(reconciled);
  return deepFreeze(reconciled);
}

/**
 * Direct object rehydration is intentionally forbidden. Persisted authority is
 * recovered only from the exact adjacent QUEUE-STATE.yaml bytes and its full
 * immutable history chain through readPersistedBuildQueueState and a one-use
 * host observation.
 */
export function rehydrateBuildQueueState() {
  throw new Error(
    'plain queue state cannot be rehydrated; use the CAS-protected persisted QUEUE-STATE.yaml resume path',
  );
}

function portable(path) {
  return path.split(sep).join('/');
}

function queueStateRelativePath(coordinator) {
  const directory = portable(dirname(coordinator.queue_approval.queue_path));
  return directory === '.' ? 'QUEUE-STATE.yaml' : `${directory}/QUEUE-STATE.yaml`;
}

function queueStateHistoryRelativePath(coordinator) {
  const directory = portable(dirname(queueStateRelativePath(coordinator)));
  return directory === '.' ? 'QUEUE-STATE-HISTORY' : `${directory}/QUEUE-STATE-HISTORY`;
}

function stateSnapshotPayload(
  coordinator,
  state,
  {
    statePath = queueStateRelativePath(coordinator),
    fileSha256 = null,
    historyPath = queueStateHistoryRelativePath(coordinator),
    historyHeadRevision = null,
    historyHeadSha256 = null,
    historySha256 = null,
  } = {},
) {
  if (fileSha256 !== null) assertDigest(fileSha256, 'queue state file_sha256');
  if (historyHeadSha256 !== null) {
    assertDigest(historyHeadSha256, 'queue state history_head_sha256');
  }
  if (historySha256 !== null) assertDigest(historySha256, 'queue state history_sha256');
  if (
    historyHeadRevision !== null &&
    (!Number.isSafeInteger(historyHeadRevision) || historyHeadRevision < 0)
  ) {
    throw new TypeError('queue state history_head_revision must be a non-negative safe integer');
  }
  return {
    schema_version: 1,
    kind: 'cruise_build_queue_state_snapshot',
    queue_id: coordinator.queue_id,
    definition_sha256: coordinator.definition_sha256,
    state_path: statePath,
    revision: state.revision,
    state_sha256: digest(state),
    file_sha256: fileSha256,
    history_path: historyPath,
    history_head_revision: historyHeadRevision,
    history_head_sha256: historyHeadSha256,
    history_sha256: historySha256,
  };
}

function mintQueueStateSnapshot(
  coordinator,
  state,
  {
    statePath = queueStateRelativePath(coordinator),
    fileSha256 = null,
    historyPath = queueStateHistoryRelativePath(coordinator),
    historyHeadRevision = null,
    historyHeadSha256 = null,
    historySha256 = null,
    persisted = false,
  } = {},
) {
  validateCoordinatorStateStructure(coordinator, state);
  if (
    persisted &&
    (
      fileSha256 === null ||
      historyHeadRevision !== state.revision ||
      historyHeadSha256 === null ||
      historySha256 === null
    )
  ) {
    throw new Error('persisted queue state snapshots require the exact state and history head');
  }
  const snapshot = deepFreeze(stateSnapshotPayload(coordinator, state, {
    statePath,
    fileSha256,
    historyPath,
    historyHeadRevision,
    historyHeadSha256,
    historySha256,
  }));
  QUEUE_STATE_SNAPSHOTS.add(snapshot);
  if (persisted) PERSISTED_QUEUE_STATE_SNAPSHOTS.add(snapshot);
  return snapshot;
}

export function createBuildQueueStateSnapshot(coordinatorInput, stateInput) {
  const { coordinator, state } = assertCoordinatorState(coordinatorInput, stateInput);
  return mintQueueStateSnapshot(coordinator, state);
}

function requirePersistedQueueStateSnapshot(
  snapshot,
  coordinator,
  state,
  {
    statePath,
    fileSha256,
    historyPath,
    historyHeadRevision,
    historyHeadSha256,
    historySha256,
  },
  label = 'queue state snapshot',
) {
  if (
    !isPlainObject(snapshot) ||
    !QUEUE_STATE_SNAPSHOTS.has(snapshot) ||
    !PERSISTED_QUEUE_STATE_SNAPSHOTS.has(snapshot)
  ) {
    throw new Error(`${label} must be opaque authority returned by a prior exact file write/read`);
  }
  if (
    canonicalJson(snapshot) !==
    canonicalJson(stateSnapshotPayload(coordinator, state, {
      statePath,
      fileSha256,
      historyPath,
      historyHeadRevision,
      historyHeadSha256,
      historySha256,
    }))
  ) {
    throw new Error(`${label} is stale or belongs to another queue revision or file digest`);
  }
  return snapshot;
}

function assertAppendOnlyPrefix(previous, candidate, label) {
  if (!Array.isArray(previous) || !Array.isArray(candidate) || candidate.length < previous.length) {
    throw new Error(`${label} cannot shrink or fork`);
  }
  if (
    canonicalJson(previous) !==
    canonicalJson(candidate.slice(0, previous.length))
  ) {
    throw new Error(`${label} cannot rewrite or fork persisted history`);
  }
}

function assertQueueStateSuccessor(coordinator, previous, candidate) {
  validateCoordinatorStateStructure(coordinator, previous);
  validateCoordinatorStateStructure(coordinator, candidate);
  if (candidate.revision !== previous.revision + 1) {
    throw new Error('persisted queue state must advance by exactly one revision');
  }
  if (
    canonicalJson(previous.items.map(({ id }) => id)) !==
    canonicalJson(candidate.items.map(({ id }) => id))
  ) {
    throw new Error('persisted queue state item order cannot be rewritten');
  }
  const candidateById = new Map(candidate.items.map((item) => [item.id, item]));
  for (const priorItem of previous.items) {
    const nextItem = candidateById.get(priorItem.id);
    if (!nextItem) throw new Error(`persisted queue state deleted ${priorItem.id}`);
    assertAppendOnlyPrefix(priorItem.attempts, nextItem.attempts, `${priorItem.id}.attempts`);
    assertAppendOnlyPrefix(priorItem.evidence, nextItem.evidence, `${priorItem.id}.evidence`);
    if (
      ['completed', 'failed', 'skipped', 'cancelled'].includes(priorItem.status) &&
      (nextItem.status !== priorItem.status ||
        canonicalJson(nextItem.result) !== canonicalJson(priorItem.result))
    ) {
      throw new Error(`${priorItem.id} terminal persisted state cannot be reopened or rewritten`);
    }
  }
}

function assertCurrentQueueStateHead(coordinator, state, fileSha256, history) {
  const knownHead = PERSISTED_QUEUE_STATE_HEADS.get(coordinator);
  if (!knownHead) return;
  if (
    state.revision < knownHead.state.revision ||
    history.head.revision < knownHead.history.head.revision
  ) {
    throw new Error('persisted queue state rolled back behind the known coordinator head');
  }
  if (state.revision === knownHead.state.revision) {
    if (
      digest(state) !== digest(knownHead.state) ||
      fileSha256 !== knownHead.file_sha256 ||
      history.head.entry_sha256 !== knownHead.history.head.entry_sha256 ||
      history.history_sha256 !== knownHead.history.history_sha256
    ) {
      throw new Error('persisted queue state forked or its exact bytes were rewritten');
    }
    return;
  }
  assertQueueStateSuccessor(coordinator, knownHead.state, state);
  if (
    canonicalJson(history.files.slice(0, knownHead.history.files.length)) !==
    canonicalJson(knownHead.history.files)
  ) {
    throw new Error('persisted queue state history forked from the known coordinator head');
  }
}

function assertPendingQueueStateHead(coordinator, current, history, relation) {
  const knownHead = PERSISTED_QUEUE_STATE_HEADS.get(coordinator);
  if (!knownHead) return;
  if (knownHead.state.revision === current.state.revision) {
    if (
      digest(knownHead.state) !== digest(current.state) ||
      knownHead.file_sha256 !== current.file_sha256 ||
      canonicalJson(history.files.slice(0, knownHead.history.files.length)) !==
        canonicalJson(knownHead.history.files)
    ) {
      throw new Error('pending queue state forked from the known coordinator predecessor');
    }
    return;
  }
  if (knownHead.state.revision === history.head.revision) {
    if (
      digest(knownHead.state) !== digest(relation.successor_state) ||
      knownHead.file_sha256 !== history.head.state_file_sha256 ||
      knownHead.history.history_sha256 !== history.history_sha256 ||
      knownHead.history.head.entry_sha256 !== history.head.entry_sha256
    ) {
      throw new Error('pending queue history head forked from the known coordinator head');
    }
    return;
  }
  throw new Error('pending queue state is not adjacent to the known coordinator head');
}

function buildApprovalHasCommittedQueueGenesis(coordinator) {
  return COMMITTED_QUEUE_IDS_BY_BUILD_APPROVAL
    .get(coordinator.verified_build_approval)
    ?.has(coordinator.queue_id) === true;
}

function markBuildApprovalQueueGenesisCommitted(coordinator) {
  let queueIds = COMMITTED_QUEUE_IDS_BY_BUILD_APPROVAL.get(
    coordinator.verified_build_approval,
  );
  if (queueIds == null) {
    queueIds = new Set();
    COMMITTED_QUEUE_IDS_BY_BUILD_APPROVAL.set(
      coordinator.verified_build_approval,
      queueIds,
    );
  }
  queueIds.add(coordinator.queue_id);
}

async function queueStateLocation(root, coordinatorInput) {
  const coordinator = requireCoordinator(coordinatorInput);
  const canonicalRoot = await realpath(resolve(nonEmpty(root, 'root')));
  if (
    coordinator.verified_build_approval?.approval_readiness?.bindings?.repository_root !==
      canonicalRoot
  ) {
    throw new Error('queue persistence root differs from the verified Build approval repository');
  }
  const queuePath = coordinator.queue_approval.queue_path;
  const expectedRelative = queueStateRelativePath(coordinator);
  const absolute = resolve(canonicalRoot, expectedRelative);
  const historyRelativePath = queueStateHistoryRelativePath(coordinator);
  const historyAbsolute = resolve(canonicalRoot, historyRelativePath);
  const relativePath = portable(relative(canonicalRoot, absolute));
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    !absolute.startsWith(`${canonicalRoot}${sep}`)
  ) {
    throw new Error('approved queue state path escapes the repository');
  }
  const expectedDirectory = resolve(canonicalRoot, dirname(queuePath));
  const canonicalDirectory = await realpath(expectedDirectory);
  if (canonicalDirectory !== expectedDirectory) {
    throw new Error('approved queue state directory must not traverse a symbolic link');
  }
  if (
    historyAbsolute !== resolve(expectedDirectory, 'QUEUE-STATE-HISTORY') ||
    portable(relative(canonicalRoot, historyAbsolute)) !== historyRelativePath
  ) {
    throw new Error('approved queue state history path is not exactly adjacent to QUEUE.yaml');
  }
  return {
    root: canonicalRoot,
    coordinator,
    absolute,
    relative_path: relativePath,
    history_absolute: historyAbsolute,
    history_relative_path: historyRelativePath,
  };
}

function queueGenesisCommitmentPayload(location, history) {
  const genesis = history?.entries?.[0];
  if (genesis?.revision !== 0) {
    throw new Error('queue genesis commitment requires exact revision-zero history');
  }
  return {
    schema_version: 1,
    kind: 'cruise_build_queue_genesis_commitment',
    repository_root: location.root,
    queue_id: location.coordinator.queue_id,
    queue_path: location.coordinator.queue_approval.queue_path,
    state_path: location.relative_path,
    history_path: location.history_relative_path,
    definition_sha256: location.coordinator.definition_sha256,
    build_approval_digest: location.coordinator.build_approval_digest,
    queue_approval_sha256: location.coordinator.queue_approval_sha256,
    genesis_state_sha256: genesis.state_sha256,
    genesis_state_file_sha256: genesis.state_file_sha256,
    genesis_history_entry_sha256: genesis.entry_sha256,
  };
}

function queueGenesisCommitmentLocation(location) {
  const directory = resolve(location.root, '.cruise', 'QUEUE-STATE-COMMITMENTS');
  const key = fileDigest(Buffer.from(
    `${location.coordinator.build_approval_digest}\0${location.coordinator.queue_id}`,
    'utf8',
  ));
  return {
    directory,
    path: resolve(directory, `${key}.yaml`),
    relative_path: `.cruise/QUEUE-STATE-COMMITMENTS/${key}.yaml`,
    lineage_directory: resolve(directory, key),
    lineage_relative_path: `.cruise/QUEUE-STATE-COMMITMENTS/${key}`,
  };
}

function queueRevisionCommitmentPayload(location, history, revision, previous) {
  const stateHistoryEntry = history?.entries?.[revision];
  if (stateHistoryEntry?.revision !== revision) {
    throw new Error(`queue revision commitment requires exact history revision ${revision}`);
  }
  const stateHistoryEntryBytes = Buffer.from(stringifyYaml(stateHistoryEntry), 'utf8');
  return {
    schema_version: 1,
    kind: 'cruise_build_queue_revision_commitment',
    repository_root: location.root,
    queue_id: location.coordinator.queue_id,
    queue_path: location.coordinator.queue_approval.queue_path,
    state_path: location.relative_path,
    history_path: location.history_relative_path,
    definition_sha256: location.coordinator.definition_sha256,
    build_approval_digest: location.coordinator.build_approval_digest,
    queue_approval_sha256: location.coordinator.queue_approval_sha256,
    revision,
    state_sha256: stateHistoryEntry.state_sha256,
    state_file_sha256: stateHistoryEntry.state_file_sha256,
    state_history_entry_sha256: stateHistoryEntry.entry_sha256,
    state_history_entry_file_sha256: fileDigest(stateHistoryEntryBytes),
    state_history_entry_yaml_base64: stateHistoryEntryBytes.toString('base64'),
    previous_commitment_sha256: previous?.commitment_sha256 ?? null,
  };
}

function validateQueueRevisionCommitment(location, entry, revision, previous) {
  exactKeys(entry, [
    'schema_version',
    'kind',
    'repository_root',
    'queue_id',
    'queue_path',
    'state_path',
    'history_path',
    'definition_sha256',
    'build_approval_digest',
    'queue_approval_sha256',
    'revision',
    'state_sha256',
    'state_file_sha256',
    'state_history_entry_sha256',
    'state_history_entry_file_sha256',
    'state_history_entry_yaml_base64',
    'previous_commitment_sha256',
    'commitment_sha256',
  ], `queue revision commitment ${revision}`);
  const { commitment_sha256: commitmentSha256, ...payload } = entry;
  assertDigest(commitmentSha256, `queue revision ${revision} commitment_sha256`);
  if (
    entry.schema_version !== 1 ||
    entry.kind !== 'cruise_build_queue_revision_commitment' ||
    entry.repository_root !== location.root ||
    entry.queue_id !== location.coordinator.queue_id ||
    entry.queue_path !== location.coordinator.queue_approval.queue_path ||
    entry.state_path !== location.relative_path ||
    entry.history_path !== location.history_relative_path ||
    entry.definition_sha256 !== location.coordinator.definition_sha256 ||
    entry.build_approval_digest !== location.coordinator.build_approval_digest ||
    entry.queue_approval_sha256 !== location.coordinator.queue_approval_sha256 ||
    entry.revision !== revision ||
    entry.previous_commitment_sha256 !== (previous?.commitment_sha256 ?? null) ||
    commitmentSha256 !== digest(payload)
  ) {
    throw new Error(`queue revision commitment ${revision} breaks its approved lineage`);
  }
  assertDigest(entry.state_sha256, `queue revision ${revision} state_sha256`);
  assertDigest(entry.state_file_sha256, `queue revision ${revision} state_file_sha256`);
  assertDigest(
    entry.state_history_entry_sha256,
    `queue revision ${revision} history entry digest`,
  );
  assertDigest(
    entry.state_history_entry_file_sha256,
    `queue revision ${revision} history entry file digest`,
  );
  const historyEntryBytes = Buffer.from(
    nonEmpty(
      entry.state_history_entry_yaml_base64,
      `queue revision ${revision} history entry bytes`,
    ),
    'base64',
  );
  if (
    historyEntryBytes.toString('base64') !== entry.state_history_entry_yaml_base64 ||
    fileDigest(historyEntryBytes) !== entry.state_history_entry_file_sha256
  ) {
    throw new Error(`queue revision commitment ${revision} embeds invalid history bytes`);
  }
  const embeddedHistoryEntry = parseYaml(historyEntryBytes.toString('utf8'), {
    maxBytes: QUEUE_STATE_HISTORY_MAX_BYTES,
  });
  if (
    !isPlainObject(embeddedHistoryEntry) ||
    embeddedHistoryEntry.entry_sha256 !== entry.state_history_entry_sha256 ||
    embeddedHistoryEntry.revision !== revision ||
    embeddedHistoryEntry.state_sha256 !== entry.state_sha256 ||
    embeddedHistoryEntry.state_file_sha256 !== entry.state_file_sha256
  ) {
    throw new Error(`queue revision commitment ${revision} embeds another history entry`);
  }
  return entry;
}

async function readQueueRevisionCommitments(location, { allowMissing = false } = {}) {
  const commitmentLocation = queueGenesisCommitmentLocation(location);
  let metadata;
  try {
    metadata = await lstat(commitmentLocation.lineage_directory);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw error;
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    await realpath(commitmentLocation.lineage_directory) !==
      commitmentLocation.lineage_directory
  ) {
    throw new Error('queue revision commitment lineage must be a regular no-follow directory');
  }
  const directoryEntries = await readdir(
    commitmentLocation.lineage_directory,
    { withFileTypes: true },
  );
  const names = directoryEntries.map(({ name }) => name).sort((left, right) =>
    left.localeCompare(right, 'en'));
  const entries = [];
  let previous = null;
  for (const [revision, name] of names.entries()) {
    const match = QUEUE_STATE_COMMITMENT_ENTRY.exec(name);
    const directoryEntry = directoryEntries.find((candidate) => candidate.name === name);
    if (
      !match ||
      Number(match[1]) !== revision ||
      !directoryEntry?.isFile() ||
      directoryEntry.isSymbolicLink()
    ) {
      throw new Error(
        'queue revision commitments must be one contiguous immutable file per revision',
      );
    }
    const file = await readExactRegularFile(
      resolve(commitmentLocation.lineage_directory, name),
      `queue revision commitment ${revision}`,
    );
    const entry = parseYaml(file.bytes.toString('utf8'), {
      maxBytes: QUEUE_STATE_HISTORY_MAX_BYTES,
    });
    if (!isPlainObject(entry)) {
      throw new Error(`queue revision commitment ${revision} must contain one mapping`);
    }
    validateQueueRevisionCommitment(location, entry, revision, previous);
    entries.push(entry);
    previous = entry;
  }
  const after = await lstat(commitmentLocation.lineage_directory);
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    after.dev !== metadata.dev ||
    after.ino !== metadata.ino ||
    await realpath(commitmentLocation.lineage_directory) !==
      commitmentLocation.lineage_directory
  ) {
    throw new Error('queue revision commitment lineage changed while it was read');
  }
  return entries;
}

function assertQueueRevisionCommitmentsMatchHistory(location, commitments, history) {
  if (commitments.length > history.entries.length) {
    throw new Error('QUEUE-STATE-HISTORY rolled back behind its durable revision commitments');
  }
  for (const [revision, entry] of commitments.entries()) {
    const expected = queueRevisionCommitmentPayload(
      location,
      history,
      revision,
      revision === 0 ? null : commitments[revision - 1],
    );
    const { commitment_sha256: ignored, ...payload } = entry;
    void ignored;
    if (canonicalJson(payload) !== canonicalJson(expected)) {
      throw new Error(
        `QUEUE-STATE-HISTORY revision ${revision} differs from its durable commitment`,
      );
    }
  }
}

async function ensureQueueRevisionCommitments(location, history) {
  const commitmentLocation = queueGenesisCommitmentLocation(location);
  const cruiseDirectory = resolve(location.root, '.cruise');
  if (await realpath(cruiseDirectory) !== cruiseDirectory) {
    throw new Error('queue revision commitment root must not traverse a symbolic link');
  }
  try {
    await mkdir(commitmentLocation.directory, { mode: 0o700 });
    await syncParentDirectory(commitmentLocation.directory);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const commitmentRootMetadata = await lstat(commitmentLocation.directory);
  if (
    commitmentRootMetadata.isSymbolicLink() ||
    !commitmentRootMetadata.isDirectory() ||
    await realpath(commitmentLocation.directory) !== commitmentLocation.directory
  ) {
    throw new Error('queue revision commitment storage must be a regular no-follow directory');
  }
  try {
    await mkdir(commitmentLocation.lineage_directory, { mode: 0o700 });
    await syncParentDirectory(commitmentLocation.lineage_directory);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const directoryMetadata = await lstat(commitmentLocation.lineage_directory);
  if (
    directoryMetadata.isSymbolicLink() ||
    !directoryMetadata.isDirectory() ||
    await realpath(commitmentLocation.lineage_directory) !==
      commitmentLocation.lineage_directory
  ) {
    throw new Error('queue revision commitment lineage must be a regular no-follow directory');
  }
  let commitments = await readQueueRevisionCommitments(location);
  assertQueueRevisionCommitmentsMatchHistory(location, commitments, history);
  for (let revision = commitments.length; revision < history.entries.length; revision += 1) {
    const payload = queueRevisionCommitmentPayload(
      location,
      history,
      revision,
      revision === 0 ? null : commitments[revision - 1],
    );
    const entry = deepFreeze({ ...payload, commitment_sha256: digest(payload) });
    const name = `REV-${String(revision).padStart(12, '0')}.yaml`;
    const finalPath = resolve(commitmentLocation.lineage_directory, name);
    const temporaryPath = `${commitmentLocation.lineage_directory}.${process.pid}.${randomUUID()}.${name}.tmp`;
    try {
      const handle = await open(temporaryPath, 'wx', 0o400);
      try {
        await handle.writeFile(stringifyYaml(entry));
        await handle.sync();
      } finally {
        await handle.close();
      }
      const currentDirectoryMetadata = await lstat(commitmentLocation.lineage_directory);
      if (
        currentDirectoryMetadata.isSymbolicLink() ||
        !currentDirectoryMetadata.isDirectory() ||
        currentDirectoryMetadata.dev !== directoryMetadata.dev ||
        currentDirectoryMetadata.ino !== directoryMetadata.ino ||
        await realpath(commitmentLocation.lineage_directory) !==
          commitmentLocation.lineage_directory
      ) {
        throw new Error('queue revision commitment lineage changed before append');
      }
      await link(temporaryPath, finalPath);
      await syncParentDirectory(finalPath);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    } finally {
      await rm(temporaryPath, { force: true });
    }
    commitments = await readQueueRevisionCommitments(location);
    if (
      commitments.length !== revision + 1 ||
      commitments[revision].commitment_sha256 !== entry.commitment_sha256
    ) {
      throw new Error(`queue revision commitment ${revision} append was not exact`);
    }
    assertQueueRevisionCommitmentsMatchHistory(location, commitments, history);
  }
  if (commitments.length !== history.entries.length) {
    throw new Error('queue revision commitment lineage does not cover the exact state history');
  }
  return commitments;
}

async function materializeCommittedQueueHistoryTail(location, history, commitment) {
  const revision = history?.entries.length ?? 0;
  if (commitment?.revision !== revision) {
    throw new Error('durable queue revision is not the exact missing local history tail');
  }
  const bytes = Buffer.from(commitment.state_history_entry_yaml_base64, 'base64');
  if (
    bytes.toString('base64') !== commitment.state_history_entry_yaml_base64 ||
    fileDigest(bytes) !== commitment.state_history_entry_file_sha256
  ) {
    throw new Error('durable queue revision embeds invalid local history bytes');
  }
  const entry = parseYaml(bytes.toString('utf8'), {
    maxBytes: QUEUE_STATE_HISTORY_MAX_BYTES,
  });
  validateQueueStateHistoryEntry(
    location.coordinator,
    entry,
    revision,
    history?.head ?? null,
    history?.states?.at(-1) ?? null,
  );
  if (
    entry.entry_sha256 !== commitment.state_history_entry_sha256 ||
    entry.state_sha256 !== commitment.state_sha256 ||
    entry.state_file_sha256 !== commitment.state_file_sha256
  ) {
    throw new Error('durable queue revision does not bind its embedded local history entry');
  }
  const directoryMetadata = await ensureQueueStateHistoryDirectory(location);
  const name = `REV-${String(revision).padStart(12, '0')}.yaml`;
  const finalPath = resolve(location.history_absolute, name);
  const temporaryPath = `${location.history_absolute}.${process.pid}.${randomUUID()}.${name}.recovery.tmp`;
  try {
    const handle = await open(temporaryPath, 'wx', 0o400);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const currentDirectoryMetadata = await lstat(location.history_absolute);
    if (
      currentDirectoryMetadata.isSymbolicLink() ||
      !currentDirectoryMetadata.isDirectory() ||
      currentDirectoryMetadata.dev !== directoryMetadata.dev ||
      currentDirectoryMetadata.ino !== directoryMetadata.ino ||
      await realpath(location.history_absolute) !== location.history_absolute
    ) {
      throw new Error('QUEUE-STATE-HISTORY changed before durable-tail recovery');
    }
    await link(temporaryPath, finalPath);
    await syncParentDirectory(finalPath);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  } finally {
    await rm(temporaryPath, { force: true });
  }
  const recovered = await readQueueStateHistory(location);
  if (
    recovered.entries.length !== revision + 1 ||
    recovered.head.entry_sha256 !== commitment.state_history_entry_sha256 ||
    recovered.files.at(-1).file_sha256 !== commitment.state_history_entry_file_sha256
  ) {
    throw new Error('durable queue revision tail recovery was not exact');
  }
  return recovered;
}

function validateQueueGenesisCommitment(location, marker, history = null) {
  exactKeys(marker, [
    'schema_version',
    'kind',
    'repository_root',
    'queue_id',
    'queue_path',
    'state_path',
    'history_path',
    'definition_sha256',
    'build_approval_digest',
    'queue_approval_sha256',
    'genesis_state_sha256',
    'genesis_state_file_sha256',
    'genesis_history_entry_sha256',
    'commitment_sha256',
  ], 'queue genesis commitment');
  const { commitment_sha256: commitmentSha256, ...payload } = marker;
  assertDigest(commitmentSha256, 'queue genesis commitment_sha256');
  if (
    marker.schema_version !== 1 ||
    marker.kind !== 'cruise_build_queue_genesis_commitment' ||
    marker.repository_root !== location.root ||
    marker.queue_id !== location.coordinator.queue_id ||
    marker.queue_path !== location.coordinator.queue_approval.queue_path ||
    marker.state_path !== location.relative_path ||
    marker.history_path !== location.history_relative_path ||
    marker.definition_sha256 !== location.coordinator.definition_sha256 ||
    marker.build_approval_digest !== location.coordinator.build_approval_digest ||
    marker.queue_approval_sha256 !== location.coordinator.queue_approval_sha256 ||
    commitmentSha256 !== digest(payload)
  ) {
    throw new Error('queue genesis commitment differs from the verified Build/queue authority');
  }
  assertDigest(marker.genesis_state_sha256, 'queue genesis state digest');
  assertDigest(marker.genesis_state_file_sha256, 'queue genesis file digest');
  assertDigest(marker.genesis_history_entry_sha256, 'queue genesis history digest');
  if (history !== null) {
    const expected = queueGenesisCommitmentPayload(location, history);
    if (canonicalJson(payload) !== canonicalJson(expected)) {
      throw new Error('queue genesis commitment differs from immutable revision-zero history');
    }
  }
  return marker;
}

async function readQueueGenesisCommitment(location, { allowMissing = false } = {}) {
  const commitmentLocation = queueGenesisCommitmentLocation(location);
  let directoryMetadata;
  try {
    directoryMetadata = await lstat(commitmentLocation.directory);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw error;
  }
  if (
    directoryMetadata.isSymbolicLink() ||
    !directoryMetadata.isDirectory() ||
    await realpath(commitmentLocation.directory) !== commitmentLocation.directory
  ) {
    throw new Error('queue genesis commitment storage must be a regular no-follow directory');
  }
  let file;
  try {
    file = await readExactRegularFile(
      commitmentLocation.path,
      'queue genesis commitment',
    );
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw error;
  }
  const marker = parseYaml(file.bytes.toString('utf8'), {
    maxBytes: QUEUE_STATE_HISTORY_MAX_BYTES,
  });
  if (!isPlainObject(marker)) throw new Error('queue genesis commitment must contain one mapping');
  return validateQueueGenesisCommitment(location, marker);
}

async function ensureQueueGenesisCommitment(location, history) {
  const commitmentLocation = queueGenesisCommitmentLocation(location);
  const cruiseDirectory = resolve(location.root, '.cruise');
  if (await realpath(cruiseDirectory) !== cruiseDirectory) {
    throw new Error('queue genesis commitment root must not traverse a symbolic link');
  }
  try {
    await mkdir(commitmentLocation.directory, { mode: 0o700 });
    await syncParentDirectory(commitmentLocation.directory);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const directoryMetadata = await lstat(commitmentLocation.directory);
  if (
    directoryMetadata.isSymbolicLink() ||
    !directoryMetadata.isDirectory() ||
    await realpath(commitmentLocation.directory) !== commitmentLocation.directory
  ) {
    throw new Error('queue genesis commitment storage must be a regular no-follow directory');
  }
  const payload = queueGenesisCommitmentPayload(location, history);
  const marker = deepFreeze({ ...payload, commitment_sha256: digest(payload) });
  const existing = await readQueueGenesisCommitment(location, { allowMissing: true });
  let committedMarker;
  if (existing !== null) {
    validateQueueGenesisCommitment(location, existing, history);
    committedMarker = existing;
  } else {
    const temporaryPath = `${commitmentLocation.path}.${process.pid}.${randomUUID()}.tmp`;
    const bytes = Buffer.from(stringifyYaml(marker), 'utf8');
    try {
      const handle = await open(temporaryPath, 'wx', 0o400);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const currentDirectoryMetadata = await lstat(commitmentLocation.directory);
      if (
        currentDirectoryMetadata.isSymbolicLink() ||
        !currentDirectoryMetadata.isDirectory() ||
        currentDirectoryMetadata.dev !== directoryMetadata.dev ||
        currentDirectoryMetadata.ino !== directoryMetadata.ino ||
        await realpath(commitmentLocation.directory) !== commitmentLocation.directory
      ) {
        throw new Error('queue genesis commitment storage changed before immutable commit');
      }
      await link(temporaryPath, commitmentLocation.path);
      await syncParentDirectory(commitmentLocation.path);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    } finally {
      await rm(temporaryPath, { force: true });
    }
    committedMarker = await readQueueGenesisCommitment(location);
    validateQueueGenesisCommitment(location, committedMarker, history);
  }
  await ensureQueueRevisionCommitments(location, history);
  return committedMarker;
}

async function readExactRegularFile(path, label = 'QUEUE-STATE.yaml') {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${label} must be a regular no-follow file`);
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const beforeRead = await handle.stat();
    if (
      before.dev !== beforeRead.dev ||
      before.ino !== beforeRead.ino ||
      before.size !== beforeRead.size ||
      before.mtimeMs !== beforeRead.mtimeMs ||
      before.ctimeMs !== beforeRead.ctimeMs
    ) {
      throw new Error(`${label} changed before it could be read`);
    }
    const bytes = await handle.readFile();
    const afterRead = await handle.stat();
    const after = await lstat(path);
    if (
      beforeRead.dev !== afterRead.dev ||
      beforeRead.ino !== afterRead.ino ||
      beforeRead.size !== afterRead.size ||
      beforeRead.mtimeMs !== afterRead.mtimeMs ||
      beforeRead.ctimeMs !== afterRead.ctimeMs ||
      bytes.length !== afterRead.size ||
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.dev !== afterRead.dev ||
      after.ino !== afterRead.ino ||
      after.size !== afterRead.size ||
      after.mtimeMs !== afterRead.mtimeMs ||
      after.ctimeMs !== afterRead.ctimeMs
    ) {
      throw new Error(`${label} changed while it was read`);
    }
    return { bytes, file_sha256: fileDigest(bytes) };
  } finally {
    await handle.close();
  }
}

function parsePersistedQueueState(bytes) {
  const parsed = parseYaml(bytes.toString('utf8'));
  if (!isPlainObject(parsed)) throw new Error('QUEUE-STATE.yaml must contain one mapping');
  return parsed;
}

async function readCurrentQueueState(location) {
  const file = await readExactRegularFile(location.absolute);
  const state = parsePersistedQueueState(file.bytes);
  validateCoordinatorStateStructure(location.coordinator, state);
  return { ...file, state };
}

function historyEntryPayload(entry) {
  const { entry_sha256: ignored, ...payload } = entry;
  void ignored;
  return payload;
}

function createQueueStateHistoryEntry(coordinator, state, stateBytes, previousEntry) {
  const stateFileSha256 = fileDigest(stateBytes);
  const payload = {
    schema_version: 1,
    kind: 'cruise_build_queue_state_history_entry',
    queue_id: coordinator.queue_id,
    definition_sha256: coordinator.definition_sha256,
    state_path: queueStateRelativePath(coordinator),
    revision: state.revision,
    state_sha256: digest(state),
    state_file_sha256: assertDigest(stateFileSha256, 'history state_file_sha256'),
    state_yaml_base64: stateBytes.toString('base64'),
    previous_entry_sha256: previousEntry?.entry_sha256 ?? null,
  };
  return deepFreeze({ ...payload, entry_sha256: digest(payload) });
}

function validateQueueStateHistoryEntry(
  coordinator,
  entry,
  revision,
  previousEntry,
  previousState,
) {
  exactKeys(entry, [
    'schema_version',
    'kind',
    'queue_id',
    'definition_sha256',
    'state_path',
    'revision',
    'state_sha256',
    'state_file_sha256',
    'state_yaml_base64',
    'previous_entry_sha256',
    'entry_sha256',
  ], `QUEUE-STATE-HISTORY revision ${revision}`);
  if (
    entry.schema_version !== 1 ||
    entry.kind !== 'cruise_build_queue_state_history_entry' ||
    entry.queue_id !== coordinator.queue_id ||
    entry.definition_sha256 !== coordinator.definition_sha256 ||
    entry.state_path !== queueStateRelativePath(coordinator) ||
    entry.revision !== revision ||
    entry.previous_entry_sha256 !== (previousEntry?.entry_sha256 ?? null)
  ) {
    throw new Error(`QUEUE-STATE-HISTORY revision ${revision} breaks its approved chain`);
  }
  assertDigest(entry.state_sha256, `QUEUE-STATE-HISTORY revision ${revision} state_sha256`);
  assertDigest(
    entry.state_file_sha256,
    `QUEUE-STATE-HISTORY revision ${revision} state_file_sha256`,
  );
  assertDigest(entry.entry_sha256, `QUEUE-STATE-HISTORY revision ${revision} entry_sha256`);
  if (entry.entry_sha256 !== digest(historyEntryPayload(entry))) {
    throw new Error(`QUEUE-STATE-HISTORY revision ${revision} entry digest was rewritten`);
  }
  const stateBytes = Buffer.from(
    nonEmpty(entry.state_yaml_base64, `QUEUE-STATE-HISTORY revision ${revision} state_yaml_base64`),
    'base64',
  );
  if (stateBytes.toString('base64') !== entry.state_yaml_base64) {
    throw new Error(`QUEUE-STATE-HISTORY revision ${revision} state bytes are not canonical base64`);
  }
  if (fileDigest(stateBytes) !== entry.state_file_sha256) {
    throw new Error(`QUEUE-STATE-HISTORY revision ${revision} state file digest changed`);
  }
  const state = parsePersistedQueueState(stateBytes);
  validateCoordinatorStateStructure(coordinator, state);
  if (state.revision !== revision || digest(state) !== entry.state_sha256) {
    throw new Error(`QUEUE-STATE-HISTORY revision ${revision} does not match its exact state bytes`);
  }
  if (previousState == null) {
    const genesisTimestamp = nowIso(state.updated_at);
    if (
      genesisTimestamp !== state.updated_at ||
      canonicalJson(createInitialCoordinatorState(coordinator, genesisTimestamp)) !==
        canonicalJson(state)
    ) {
      throw new Error('QUEUE-STATE-HISTORY revision 0 is not the exact coordinator genesis');
    }
  } else {
    assertQueueStateSuccessor(coordinator, previousState, state);
  }
  return { entry, state, state_bytes: stateBytes };
}

function queueStateHistorySummary(location, entries, files, states, stateBytes) {
  const head = entries.at(-1);
  return {
    path: location.history_relative_path,
    entries,
    files,
    states,
    state_bytes: stateBytes,
    head,
    history_sha256: digest(files.map((file, index) => ({
      name: file.name,
      file_sha256: file.file_sha256,
      entry_sha256: entries[index].entry_sha256,
    }))),
  };
}

async function readQueueStateHistory(
  location,
  { allowMissing = false, allowEmpty = false } = {},
) {
  let metadata;
  try {
    metadata = await lstat(location.history_absolute);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('QUEUE-STATE-HISTORY must be a regular no-follow directory');
  }
  if (await realpath(location.history_absolute) !== location.history_absolute) {
    throw new Error('QUEUE-STATE-HISTORY must not traverse a symbolic link');
  }
  const directoryEntries = await readdir(location.history_absolute, { withFileTypes: true });
  const names = directoryEntries.map(({ name }) => name).sort((left, right) =>
    left.localeCompare(right, 'en'));
  if (names.length === 0) {
    if (allowEmpty) return null;
    throw new Error('QUEUE-STATE-HISTORY cannot be empty');
  }
  const entries = [];
  const files = [];
  const states = [];
  const stateBytes = [];
  let previous = null;
  let previousState = null;
  for (const [index, name] of names.entries()) {
    const match = QUEUE_STATE_HISTORY_ENTRY.exec(name);
    if (!match || Number(match[1]) !== index) {
      throw new Error('QUEUE-STATE-HISTORY must contain one contiguous immutable file per revision');
    }
    const directoryEntry = directoryEntries.find((candidate) => candidate.name === name);
    if (!directoryEntry?.isFile() || directoryEntry.isSymbolicLink()) {
      throw new Error(`${name} must be a regular no-follow history entry`);
    }
    const file = await readExactRegularFile(
      resolve(location.history_absolute, name),
      `QUEUE-STATE-HISTORY/${name}`,
    );
    const parsed = parseYaml(file.bytes.toString('utf8'), {
      maxBytes: QUEUE_STATE_HISTORY_MAX_BYTES,
    });
    if (!isPlainObject(parsed)) throw new Error(`${name} must contain one mapping`);
    const validated = validateQueueStateHistoryEntry(
      location.coordinator,
      parsed,
      index,
      previous,
      previousState,
    );
    entries.push(parsed);
    files.push({ name, file_sha256: file.file_sha256 });
    states.push(validated.state);
    stateBytes.push(validated.state_bytes);
    previous = parsed;
    previousState = validated.state;
  }
  const after = await lstat(location.history_absolute);
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    after.dev !== metadata.dev ||
    after.ino !== metadata.ino ||
    await realpath(location.history_absolute) !== location.history_absolute
  ) {
    throw new Error('QUEUE-STATE-HISTORY changed while its exact chain was read');
  }
  return queueStateHistorySummary(location, entries, files, states, stateBytes);
}

function inspectStateHistoryRelation(coordinator, stateFile, history) {
  const { state, file_sha256: stateFileSha256 } = stateFile;
  const head = history?.head;
  if (!head) throw new Error('QUEUE-STATE.yaml has no persistent history head');
  if (state.revision > head.revision) {
    throw new Error('QUEUE-STATE.yaml advanced without a persistent history entry');
  }
  if (state.revision === head.revision) {
    if (
      head.state_sha256 !== digest(state) ||
      head.state_file_sha256 !== stateFileSha256 ||
      !stateFile.bytes.equals(history.state_bytes.at(-1))
    ) {
      throw new Error('QUEUE-STATE.yaml forked from its persistent exact-hash history head');
    }
    return { status: 'current', head, successor_state: null, successor_bytes: null };
  }
  if (head.revision !== state.revision + 1) {
    throw new Error('QUEUE-STATE-HISTORY is more than one revision ahead of QUEUE-STATE.yaml');
  }
  const predecessor = history.entries[state.revision];
  const predecessorBytes = history.state_bytes[state.revision];
  if (
    predecessor?.revision !== state.revision ||
    predecessor.state_sha256 !== digest(state) ||
    predecessor.state_file_sha256 !== stateFileSha256 ||
    !stateFile.bytes.equals(predecessorBytes)
  ) {
    throw new Error('QUEUE-STATE.yaml is not the exact predecessor of its pending history head');
  }
  const successorState = history.states.at(-1);
  const successorBytes = history.state_bytes.at(-1);
  assertQueueStateSuccessor(coordinator, state, successorState);
  if (
    successorState.revision !== head.revision ||
    digest(successorState) !== head.state_sha256 ||
    fileDigest(successorBytes) !== head.state_file_sha256
  ) {
    throw new Error('pending queue history head does not bind its exact successor bytes');
  }
  return {
    status: 'pending_roll_forward',
    head,
    successor_state: successorState,
    successor_bytes: successorBytes,
  };
}

function assertStateMatchesHistory(coordinator, stateFile, history) {
  const relation = inspectStateHistoryRelation(coordinator, stateFile, history);
  if (relation.status !== 'current') {
    throw new Error('QUEUE-STATE.yaml rolled back behind its persistent history head');
  }
  return relation.head;
}

function queueStateSnapshotHistoryOptions(location, history) {
  return {
    historyPath: location.history_relative_path,
    historyHeadRevision: history.head.revision,
    historyHeadSha256: history.head.entry_sha256,
    historySha256: history.history_sha256,
  };
}

async function ensureQueueStateHistoryDirectory(location) {
  try {
    await mkdir(location.history_absolute, { mode: 0o700 });
    await syncParentDirectory(location.history_absolute);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const metadata = await lstat(location.history_absolute);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('QUEUE-STATE-HISTORY must be a regular no-follow directory');
  }
  if (await realpath(location.history_absolute) !== location.history_absolute) {
    throw new Error('QUEUE-STATE-HISTORY must not traverse a symbolic link');
  }
  return metadata;
}

async function cleanupAbandonedGenesisQueueStateStaging(location) {
  let historyMetadata;
  try {
    historyMetadata = await lstat(location.history_absolute);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    historyMetadata = null;
  }
  if (historyMetadata !== null) {
    if (historyMetadata.isSymbolicLink() || !historyMetadata.isDirectory()) {
      throw new Error('QUEUE-STATE-HISTORY must be a regular no-follow directory');
    }
    if (await realpath(location.history_absolute) !== location.history_absolute) {
      throw new Error('QUEUE-STATE-HISTORY must not traverse a symbolic link');
    }
    if ((await readdir(location.history_absolute)).length !== 0) {
      throw new Error('empty queue genesis staging changed before recovery');
    }
  }
  const stagingName = /^(?:QUEUE-STATE\.yaml\.\d+\.[0-9a-f-]{36}\.tmp|QUEUE-STATE-HISTORY\.\d+\.[0-9a-f-]{36}\.REV-000000000000\.yaml\.tmp)$/u;
  const parent = dirname(location.history_absolute);
  const entries = await readdir(parent, { withFileTypes: true });
  let removed = false;
  for (const entry of entries) {
    if (!stagingName.test(entry.name)) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('abandoned queue genesis staging must be a regular no-follow file');
    }
    await rm(resolve(parent, entry.name), { force: true });
    removed = true;
  }
  if (removed) await syncParentDirectory(resolve(parent, 'QUEUE-STATE.yaml'));
}

async function appendQueueStateHistoryEntry(
  location,
  state,
  stateBytes,
  previousHistory,
  persistenceFaultInjector = null,
) {
  const directoryMetadata = await ensureQueueStateHistoryDirectory(location);
  if (persistenceFaultInjector !== null) {
    await persistenceFaultInjector('after_history_directory_prepare');
  }
  const expectedRevision = previousHistory == null ? 0 : previousHistory.head.revision + 1;
  if (state.revision !== expectedRevision) {
    throw new Error('persistent history entry must advance by exactly one revision');
  }
  const entry = createQueueStateHistoryEntry(
    location.coordinator,
    state,
    stateBytes,
    previousHistory?.head ?? null,
  );
  const name = `REV-${String(state.revision).padStart(12, '0')}.yaml`;
  const finalPath = resolve(location.history_absolute, name);
  const temporaryPath = `${location.history_absolute}.${process.pid}.${randomUUID()}.${name}.tmp`;
  const bytes = Buffer.from(stringifyYaml(entry), 'utf8');
  try {
    const handle = await open(temporaryPath, 'wx', 0o400);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (persistenceFaultInjector !== null) {
      await persistenceFaultInjector('after_history_entry_prepare');
    }
    const currentDirectoryMetadata = await lstat(location.history_absolute);
    if (
      currentDirectoryMetadata.isSymbolicLink() ||
      !currentDirectoryMetadata.isDirectory() ||
      currentDirectoryMetadata.dev !== directoryMetadata.dev ||
      currentDirectoryMetadata.ino !== directoryMetadata.ino ||
      await realpath(location.history_absolute) !== location.history_absolute
    ) {
      throw new Error('QUEUE-STATE-HISTORY changed before its immutable append');
    }
    await link(temporaryPath, finalPath);
    await syncParentDirectory(finalPath);
    if (state.revision === 0) {
      markBuildApprovalQueueGenesisCommitted(location.coordinator);
    }
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`QUEUE-STATE-HISTORY revision ${state.revision} already exists`);
    }
    throw error;
  } finally {
    await rm(temporaryPath, { force: true });
  }
  const history = await readQueueStateHistory(location);
  if (
    history.head.revision !== state.revision ||
    history.head.entry_sha256 !== entry.entry_sha256 ||
    history.head.state_file_sha256 !== fileDigest(stateBytes) ||
    history.entries.length !== (previousHistory?.entries.length ?? 0) + 1
  ) {
    throw new Error('QUEUE-STATE-HISTORY append did not produce the exact chained head');
  }
  if (previousHistory != null) {
    const previousFiles = history.files.slice(0, previousHistory.files.length);
    if (canonicalJson(previousFiles) !== canonicalJson(previousHistory.files)) {
      throw new Error('QUEUE-STATE-HISTORY rewrote an immutable prior entry');
    }
  }
  return history;
}

async function assertQueueStateFileUnchanged(location, previous) {
  const current = await readCurrentQueueState(location);
  if (
    current.file_sha256 !== previous.file_sha256 ||
    !current.bytes.equals(previous.bytes)
  ) {
    throw new Error('QUEUE-STATE.yaml changed across the compare-and-swap boundary');
  }
}

async function assertQueueStateFileStillAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('QUEUE-STATE.yaml appeared across the compare-and-swap boundary');
}

async function syncParentDirectory(path) {
  const handle = await open(dirname(path), fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function queueStateLockMetadata(coordinator, purpose) {
  return {
    schema_version: 1,
    kind: 'cruise_build_queue_state_writer_lock',
    queue_id: coordinator.queue_id,
    definition_sha256: coordinator.definition_sha256,
    state_path: queueStateRelativePath(coordinator),
    pid: process.pid,
    nonce: randomUUID(),
    purpose,
    acquired_at: nowIso(),
  };
}

function validateQueueStateLockMetadata(coordinator, metadata) {
  exactKeys(metadata, [
    'schema_version',
    'kind',
    'queue_id',
    'definition_sha256',
    'state_path',
    'pid',
    'nonce',
    'purpose',
    'acquired_at',
  ], 'QUEUE-STATE writer lock');
  if (
    metadata.schema_version !== 1 ||
    metadata.kind !== 'cruise_build_queue_state_writer_lock' ||
    metadata.queue_id !== coordinator.queue_id ||
    metadata.definition_sha256 !== coordinator.definition_sha256 ||
    metadata.state_path !== queueStateRelativePath(coordinator) ||
    !Number.isSafeInteger(metadata.pid) ||
    metadata.pid <= 0 ||
    !['persist', 'roll_forward', 'genesis_roll_forward'].includes(metadata.purpose) ||
    nowIso(metadata.acquired_at) !== metadata.acquired_at
  ) {
    throw new Error('QUEUE-STATE writer lock is malformed or belongs elsewhere');
  }
  if (typeof metadata.nonce !== 'string' || !UUID.test(metadata.nonce)) {
    throw new Error('QUEUE-STATE writer lock nonce must be a random UUID');
  }
  return metadata;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

async function readQueueStateWriterLock(lockPath, coordinator) {
  const file = await readExactRegularFile(lockPath, 'QUEUE-STATE writer lock');
  const parsed = parseYaml(file.bytes.toString('utf8'));
  if (!isPlainObject(parsed)) throw new Error('QUEUE-STATE writer lock must contain one mapping');
  return validateQueueStateLockMetadata(coordinator, parsed);
}

async function acquireQueueStateWriterLock(
  lockPath,
  coordinator,
  purpose,
  { reclaimDeadWriter = false } = {},
) {
  const create = async () => {
    const metadata = queueStateLockMetadata(coordinator, purpose);
    const preparationPath = `${lockPath}.${metadata.pid}.${metadata.nonce}.prepare`;
    let handle;
    try {
      handle = await open(preparationPath, 'wx', 0o600);
      await handle.writeFile(stringifyYaml(metadata));
      await handle.sync();
      await handle.close();
      handle = null;
      await link(preparationPath, lockPath);
      await syncParentDirectory(lockPath);
      return { handle: null, metadata };
    } catch (error) {
      await handle?.close();
      throw error;
    } finally {
      await rm(preparationPath, { force: true });
    }
  };
  try {
    return await create();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  if (!reclaimDeadWriter) throw new Error('QUEUE-STATE.yaml is locked by another writer');
  const stale = await readQueueStateWriterLock(lockPath, coordinator);
  if (processIsAlive(stale.pid)) {
    throw new Error('QUEUE-STATE.yaml recovery is blocked by an active writer lock');
  }
  const quarantinePath = `${lockPath}.${stale.nonce}.stale`;
  await rename(lockPath, quarantinePath);
  await rm(quarantinePath, { force: true });
  try {
    return await create();
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error('QUEUE-STATE.yaml lock changed while reclaiming a dead writer');
    }
    throw error;
  }
}

async function releaseQueueStateWriterLock(lockPath, lock, coordinator) {
  await lock?.handle?.close();
  if (!lock) return;
  try {
    const current = await readQueueStateWriterLock(lockPath, coordinator);
    if (current.nonce === lock.metadata.nonce) await rm(lockPath, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

/**
 * Atomically persist one coordinator-produced revision. Existing state is a
 * compare-and-swap boundary: callers need the exact opaque snapshot returned
 * by the prior write/read. The exact-state history entry is made durable before
 * the mutable state head advances, and histories may extend by one revision.
 */
export async function persistBuildQueueState({
  root,
  coordinator: coordinatorInput,
  state: stateInput,
  expectedSnapshot = null,
  persistenceFaultInjector = null,
} = {}) {
  const { coordinator, state } = assertCoordinatorState(coordinatorInput, stateInput);
  const location = await queueStateLocation(root, coordinator);
  const serializedBytes = Buffer.from(stringifyYaml(state), 'utf8');
  const serializedFileSha256 = fileDigest(serializedBytes);
  const lockPath = `${location.absolute}.lock`;
  if (
    persistenceFaultInjector !== null &&
    typeof persistenceFaultInjector !== 'function'
  ) {
    throw new TypeError('persistenceFaultInjector must be a function when supplied');
  }
  let lock;
  let temporaryPath = null;
  lock = await acquireQueueStateWriterLock(
    lockPath,
    coordinator,
    'persist',
    { reclaimDeadWriter: true },
  );
  try {
    let current = null;
    let history = null;
    try {
      current = await readCurrentQueueState(location);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    history = await readQueueStateHistory(location, {
      allowMissing: true,
      allowEmpty: current === null,
    });
    const durableGenesisCommitment = await readQueueGenesisCommitment(location, {
      allowMissing: true,
    });
    const durableRevisionCommitments = await readQueueRevisionCommitments(location, {
      allowMissing: true,
    });
    if (
      current === null &&
      history === null &&
      durableGenesisCommitment === null &&
      durableRevisionCommitments?.length === 1
    ) {
      await cleanupAbandonedGenesisQueueStateStaging(location);
    }
    if (
      durableRevisionCommitments !== null &&
      durableRevisionCommitments.length === (history?.entries.length ?? 0) + 1 &&
      !(current === null && history === null && durableGenesisCommitment !== null)
    ) {
      history = await materializeCommittedQueueHistoryTail(
        location,
        history,
        durableRevisionCommitments.at(-1),
      );
      assertQueueRevisionCommitmentsMatchHistory(
        location,
        durableRevisionCommitments,
        history,
      );
      if (
        current === null &&
        history.entries.length === 1 &&
        durableGenesisCommitment === null
      ) {
        if (
          expectedSnapshot !== null ||
          canonicalJson(history.states[0]) !== canonicalJson(state) ||
          !history.state_bytes[0].equals(serializedBytes)
        ) {
          throw new Error(
            'recovered pre-link queue genesis differs from the supplied opaque candidate',
          );
        }
        temporaryPath = `${location.absolute}.${process.pid}.${randomUUID()}.genesis-commit.tmp`;
        const recoveryHandle = await open(temporaryPath, 'wx', 0o600);
        try {
          await recoveryHandle.writeFile(history.state_bytes[0]);
          await recoveryHandle.sync();
        } finally {
          await recoveryHandle.close();
        }
        await assertQueueStateFileStillAbsent(location.absolute);
        await rename(temporaryPath, location.absolute);
        temporaryPath = null;
        await syncParentDirectory(location.absolute);
        const recovered = await readCurrentQueueState(location);
        assertStateMatchesHistory(coordinator, recovered, history);
        await ensureQueueGenesisCommitment(location, history);
        const snapshot = mintQueueStateSnapshot(coordinator, state, {
          statePath: location.relative_path,
          fileSha256: recovered.file_sha256,
          ...queueStateSnapshotHistoryOptions(location, history),
          persisted: true,
        });
        PERSISTED_QUEUE_STATE_HEADS.set(coordinator, {
          snapshot,
          state: clone(state),
          file_sha256: recovered.file_sha256,
          history: clone(history),
        });
        return deepFreeze({
          path: location.relative_path,
          history_path: location.history_relative_path,
          snapshot,
        });
      }
    }
    if (history !== null) markBuildApprovalQueueGenesisCommitted(coordinator);
    if (current === null && history === null) {
      if (
        durableGenesisCommitment !== null ||
        PERSISTED_QUEUE_STATE_HEADS.has(coordinator) ||
        buildApprovalHasCommittedQueueGenesis(coordinator)
      ) {
        throw new Error(
          'queue state and durable queue genesis were deleted behind the known Build approval',
        );
      }
      if (expectedSnapshot !== null) {
        throw new Error('QUEUE-STATE.yaml does not exist for the supplied prior snapshot');
      }
      if (state.revision !== 0) {
        throw new Error('the first persisted queue state must be revision zero');
      }
      if ((durableRevisionCommitments?.length ?? 0) > 0) {
        if (durableRevisionCommitments.length !== 1) {
          throw new Error('missing queue state/history conflicts with durable revision lineage');
        }
        const pendingGenesisEntry = createQueueStateHistoryEntry(
          coordinator,
          state,
          serializedBytes,
          null,
        );
        assertQueueRevisionCommitmentsMatchHistory(
          location,
          durableRevisionCommitments,
          { entries: [pendingGenesisEntry] },
        );
      }
      await cleanupAbandonedGenesisQueueStateStaging(location);
    } else if (current === null || history === null) {
      throw new Error('QUEUE-STATE.yaml and QUEUE-STATE-HISTORY must exist or initialize together');
    } else {
      assertStateMatchesHistory(coordinator, current, history);
      assertCurrentQueueStateHead(coordinator, current.state, current.file_sha256, history);
      requirePersistedQueueStateSnapshot(
        expectedSnapshot,
        coordinator,
        current.state,
        {
          statePath: location.relative_path,
          fileSha256: current.file_sha256,
          ...queueStateSnapshotHistoryOptions(location, history),
        },
        'expected queue state snapshot',
      );
      if (canonicalJson(current.state) === canonicalJson(state)) {
        await ensureQueueGenesisCommitment(location, history);
        const snapshot = mintQueueStateSnapshot(coordinator, current.state, {
          statePath: location.relative_path,
          fileSha256: current.file_sha256,
          ...queueStateSnapshotHistoryOptions(location, history),
          persisted: true,
        });
        PERSISTED_QUEUE_STATE_HEADS.set(coordinator, {
          snapshot,
          state: clone(current.state),
          file_sha256: current.file_sha256,
          history: clone(history),
        });
        return deepFreeze({
          path: location.relative_path,
          history_path: location.history_relative_path,
          snapshot,
        });
      }
      assertQueueStateSuccessor(coordinator, current.state, state);
      if (
        durableRevisionCommitments !== null &&
        durableRevisionCommitments.length > history.entries.length
      ) {
        if (
          durableRevisionCommitments.length !== history.entries.length + 1 ||
          durableGenesisCommitment === null
        ) {
          throw new Error(
            'durable queue revision lineage is not an exact pending successor',
          );
        }
        validateQueueGenesisCommitment(location, durableGenesisCommitment, history);
        assertQueueRevisionCommitmentsMatchHistory(
          location,
          durableRevisionCommitments.slice(0, history.entries.length),
          history,
        );
      } else {
        await ensureQueueGenesisCommitment(location, history);
      }
    }

    temporaryPath = `${location.absolute}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(serializedBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const prospectiveHistoryEntry = createQueueStateHistoryEntry(
      coordinator,
      state,
      serializedBytes,
      history?.head ?? null,
    );
    await ensureQueueRevisionCommitments(location, {
      entries: [...(history?.entries ?? []), prospectiveHistoryEntry],
    });
    const nextHistory = await appendQueueStateHistoryEntry(
      location,
      state,
      serializedBytes,
      history,
      persistenceFaultInjector,
    );
    await ensureQueueGenesisCommitment(location, nextHistory);
    if (persistenceFaultInjector !== null) {
      await persistenceFaultInjector('after_history_append');
    }
    const currentLocation = await queueStateLocation(root, coordinator);
    if (
      currentLocation.absolute !== location.absolute ||
      currentLocation.root !== location.root ||
      currentLocation.relative_path !== location.relative_path ||
      currentLocation.history_absolute !== location.history_absolute ||
      currentLocation.history_relative_path !== location.history_relative_path
    ) {
      throw new Error('approved queue state location changed during persistence');
    }
    const checkedHistory = await readQueueStateHistory(location);
    if (
      checkedHistory.history_sha256 !== nextHistory.history_sha256 ||
      checkedHistory.head.entry_sha256 !== nextHistory.head.entry_sha256
    ) {
      throw new Error('QUEUE-STATE-HISTORY changed before the state commit');
    }
    if (current === null) {
      await assertQueueStateFileStillAbsent(location.absolute);
    } else {
      await assertQueueStateFileUnchanged(location, current);
    }
    await rename(temporaryPath, location.absolute);
    temporaryPath = null;
    await syncParentDirectory(location.absolute);
    const written = await readCurrentQueueState(location);
    if (
      written.file_sha256 !== serializedFileSha256 ||
      !written.bytes.equals(serializedBytes) ||
      canonicalJson(written.state) !== canonicalJson(state)
    ) {
      throw new Error('atomic QUEUE-STATE.yaml write did not preserve the exact candidate bytes');
    }
    const writtenHistory = await readQueueStateHistory(location);
    assertStateMatchesHistory(coordinator, written, writtenHistory);
    if (
      writtenHistory.history_sha256 !== nextHistory.history_sha256 ||
      writtenHistory.head.entry_sha256 !== nextHistory.head.entry_sha256
    ) {
      throw new Error('QUEUE-STATE-HISTORY changed across the atomic state commit');
    }
    const snapshot = mintQueueStateSnapshot(coordinator, state, {
      statePath: location.relative_path,
      fileSha256: written.file_sha256,
      ...queueStateSnapshotHistoryOptions(location, writtenHistory),
      persisted: true,
    });
    PERSISTED_QUEUE_STATE_HEADS.set(coordinator, {
      snapshot,
      state: clone(state),
      file_sha256: written.file_sha256,
      history: clone(writtenHistory),
    });
    return deepFreeze({
      path: location.relative_path,
      history_path: location.history_relative_path,
      snapshot,
    });
  } finally {
    if (temporaryPath !== null) await rm(temporaryPath, { force: true });
    await releaseQueueStateWriterLock(lockPath, lock, coordinator);
  }
}

/** Mint one-use host authority for the exact state file observed on resume. */
export function attestBuildQueueStateResume(coordinatorInput, event) {
  const coordinator = requireCoordinator(coordinatorInput);
  if (!isPlainObject(event) || event.kind !== 'host_queue_state_resume_event') {
    throw new TypeError('queue state resume requires an observed host event');
  }
  if (
    event.state_present !== undefined &&
    typeof event.state_present !== 'boolean'
  ) {
    throw new TypeError('queue state resume state_present must be boolean when supplied');
  }
  const expectedPath = queueStateRelativePath(coordinator);
  const expectedHistoryPath = queueStateHistoryRelativePath(coordinator);
  if (
    event.source !== 'cruise_host_adapter' ||
    event.queue_id !== coordinator.queue_id ||
    event.definition_sha256 !== coordinator.definition_sha256 ||
    event.state_path !== expectedPath ||
    event.history_path !== expectedHistoryPath ||
    !Number.isSafeInteger(event.revision) ||
    event.revision < 0 ||
    !Number.isSafeInteger(event.history_head_revision) ||
    event.history_head_revision < 0 ||
    ![
      event.revision,
      event.revision + 1,
    ].includes(event.history_head_revision)
  ) {
    throw new Error('queue state resume event is not bound to this approved queue history head');
  }
  assertDigest(event.state_sha256, 'queue state resume state_sha256');
  assertDigest(event.file_sha256, 'queue state resume file_sha256');
  assertDigest(event.history_head_sha256, 'queue state resume history_head_sha256');
  assertDigest(event.history_sha256, 'queue state resume history_sha256');
  const interactionId = nonEmpty(event.interaction_id, 'queue state resume interaction_id');
  const interactionKey = digest({
    queue_id: event.queue_id,
    definition_sha256: event.definition_sha256,
    interaction_id: interactionId,
  });
  if (ISSUED_QUEUE_STATE_RESUME_INTERACTIONS.has(interactionKey)) {
    throw new Error('queue state resume host interaction has already minted one-use authority');
  }
  const attestation = deepFreeze({
    schema_version: 1,
    kind: 'cruise_build_queue_state_resume_attestation',
    interaction_id: interactionId,
    queue_id: event.queue_id,
    definition_sha256: event.definition_sha256,
    state_path: event.state_path,
    state_present: event.state_present !== false,
    revision: event.revision,
    state_sha256: event.state_sha256,
    file_sha256: event.file_sha256,
    history_path: event.history_path,
    history_head_revision: event.history_head_revision,
    history_head_sha256: event.history_head_sha256,
    history_sha256: event.history_sha256,
    observed_at: nowIso(event.observed_at),
  });
  ISSUED_QUEUE_STATE_RESUME_INTERACTIONS.add(interactionKey);
  QUEUE_STATE_RESUME_ATTESTATIONS.add(attestation);
  return attestation;
}

function requireQueueStateResumeAttestation(
  resumeAttestation,
  coordinator,
  current,
  history,
  location,
) {
  const expected = stateSnapshotPayload(coordinator, current.state, {
    statePath: location.relative_path,
    fileSha256: current.file_sha256,
    ...queueStateSnapshotHistoryOptions(location, history),
  });
  if (
    !isPlainObject(resumeAttestation) ||
    !QUEUE_STATE_RESUME_ATTESTATIONS.has(resumeAttestation) ||
    CONSUMED_QUEUE_STATE_RESUME_ATTESTATIONS.has(resumeAttestation) ||
    resumeAttestation.queue_id !== expected.queue_id ||
    resumeAttestation.definition_sha256 !== expected.definition_sha256 ||
    resumeAttestation.revision !== expected.revision ||
    resumeAttestation.state_sha256 !== expected.state_sha256 ||
    resumeAttestation.file_sha256 !== expected.file_sha256 ||
    resumeAttestation.state_present !== true ||
    resumeAttestation.state_path !== location.relative_path ||
    resumeAttestation.history_path !== location.history_relative_path ||
    resumeAttestation.history_head_revision !== expected.history_head_revision ||
    resumeAttestation.history_head_sha256 !== expected.history_head_sha256 ||
    resumeAttestation.history_sha256 !== expected.history_sha256
  ) {
    throw new Error('queue state resume attestation is stale, consumed, cloned, or belongs elsewhere');
  }
  return expected;
}

function requireMissingGenesisResumeAttestation(
  resumeAttestation,
  coordinator,
  history,
  location,
) {
  if (
    history.entries.length !== 1 ||
    history.head.revision !== 0 ||
    history.states[0].revision !== 0
  ) {
    throw new Error('missing queue state can recover only one exact revision-zero history entry');
  }
  const expected = stateSnapshotPayload(coordinator, history.states[0], {
    statePath: location.relative_path,
    fileSha256: history.head.state_file_sha256,
    ...queueStateSnapshotHistoryOptions(location, history),
  });
  if (
    !isPlainObject(resumeAttestation) ||
    !QUEUE_STATE_RESUME_ATTESTATIONS.has(resumeAttestation) ||
    CONSUMED_QUEUE_STATE_RESUME_ATTESTATIONS.has(resumeAttestation) ||
    resumeAttestation.state_present !== false ||
    resumeAttestation.queue_id !== expected.queue_id ||
    resumeAttestation.definition_sha256 !== expected.definition_sha256 ||
    resumeAttestation.revision !== expected.revision ||
    resumeAttestation.state_sha256 !== expected.state_sha256 ||
    resumeAttestation.file_sha256 !== expected.file_sha256 ||
    resumeAttestation.state_path !== location.relative_path ||
    resumeAttestation.history_path !== location.history_relative_path ||
    resumeAttestation.history_head_revision !== expected.history_head_revision ||
    resumeAttestation.history_head_sha256 !== expected.history_head_sha256 ||
    resumeAttestation.history_sha256 !== expected.history_sha256
  ) {
    throw new Error(
      'queue genesis recovery attestation is stale, consumed, cloned, or belongs elsewhere',
    );
  }
  return expected;
}

async function readOptionalCurrentQueueState(location) {
  try {
    return await readCurrentQueueState(location);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function rollForwardMissingGenesisQueueState({
  root,
  coordinator,
  location,
  resumeAttestation,
}) {
  const lockPath = `${location.absolute}.lock`;
  let lock;
  let temporaryPath = null;
  lock = await acquireQueueStateWriterLock(
    lockPath,
    coordinator,
    'genesis_roll_forward',
    { reclaimDeadWriter: true },
  );
  try {
    if (await readOptionalCurrentQueueState(location) !== null) {
      throw new Error('queue genesis recovery requires the canonical state file to remain absent');
    }
    const history = await readQueueStateHistory(location);
    requireMissingGenesisResumeAttestation(
      resumeAttestation,
      coordinator,
      history,
      location,
    );
    const genesisBytes = history.state_bytes[0];
    temporaryPath = `${location.absolute}.${process.pid}.${randomUUID()}.genesis-recovery.tmp`;
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(genesisBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const currentLocation = await queueStateLocation(root, coordinator);
    if (
      currentLocation.absolute !== location.absolute ||
      currentLocation.root !== location.root ||
      currentLocation.relative_path !== location.relative_path ||
      currentLocation.history_absolute !== location.history_absolute ||
      currentLocation.history_relative_path !== location.history_relative_path
    ) {
      throw new Error('approved queue state location changed during genesis recovery');
    }
    const checkedHistory = await readQueueStateHistory(location);
    requireMissingGenesisResumeAttestation(
      resumeAttestation,
      coordinator,
      checkedHistory,
      location,
    );
    if (
      checkedHistory.history_sha256 !== history.history_sha256 ||
      checkedHistory.head.entry_sha256 !== history.head.entry_sha256 ||
      !checkedHistory.state_bytes[0].equals(genesisBytes)
    ) {
      throw new Error('queue genesis history changed during roll-forward recovery');
    }
    await assertQueueStateFileStillAbsent(location.absolute);
    await rename(temporaryPath, location.absolute);
    temporaryPath = null;
    await syncParentDirectory(location.absolute);
    const recovered = await readCurrentQueueState(location);
    const recoveredHistory = await readQueueStateHistory(location);
    assertStateMatchesHistory(coordinator, recovered, recoveredHistory);
    if (
      recoveredHistory.history_sha256 !== history.history_sha256 ||
      recoveredHistory.head.entry_sha256 !== history.head.entry_sha256 ||
      !recovered.bytes.equals(genesisBytes)
    ) {
      throw new Error('queue genesis roll-forward did not install the exact durable bytes');
    }
    return { current: recovered, history: recoveredHistory };
  } finally {
    if (temporaryPath !== null) await rm(temporaryPath, { force: true });
    await releaseQueueStateWriterLock(lockPath, lock, coordinator);
  }
}

async function rollForwardPendingQueueState({
  root,
  coordinator,
  location,
  resumeAttestation,
}) {
  const lockPath = `${location.absolute}.lock`;
  let lock;
  let temporaryPath = null;
  lock = await acquireQueueStateWriterLock(
    lockPath,
    coordinator,
    'roll_forward',
    { reclaimDeadWriter: true },
  );
  try {
    const current = await readCurrentQueueState(location);
    const history = await readQueueStateHistory(location);
    const relation = inspectStateHistoryRelation(coordinator, current, history);
    if (relation.status !== 'pending_roll_forward') {
      throw new Error('queue state recovery requires history exactly one valid successor ahead');
    }
    assertPendingQueueStateHead(coordinator, current, history, relation);
    requireQueueStateResumeAttestation(
      resumeAttestation,
      coordinator,
      current,
      history,
      location,
    );
    const successorBytes = relation.successor_bytes;
    temporaryPath = `${location.absolute}.${process.pid}.${randomUUID()}.recovery.tmp`;
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(successorBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const currentLocation = await queueStateLocation(root, coordinator);
    if (
      currentLocation.absolute !== location.absolute ||
      currentLocation.root !== location.root ||
      currentLocation.relative_path !== location.relative_path ||
      currentLocation.history_absolute !== location.history_absolute ||
      currentLocation.history_relative_path !== location.history_relative_path
    ) {
      throw new Error('approved queue state location changed during roll-forward recovery');
    }
    const checkedCurrent = await readCurrentQueueState(location);
    const checkedHistory = await readQueueStateHistory(location);
    requireQueueStateResumeAttestation(
      resumeAttestation,
      coordinator,
      checkedCurrent,
      checkedHistory,
      location,
    );
    const checkedRelation = inspectStateHistoryRelation(
      coordinator,
      checkedCurrent,
      checkedHistory,
    );
    if (
      checkedRelation.status !== 'pending_roll_forward' ||
      checkedHistory.history_sha256 !== history.history_sha256 ||
      checkedHistory.head.entry_sha256 !== history.head.entry_sha256 ||
      !checkedRelation.successor_bytes.equals(successorBytes)
    ) {
      throw new Error('pending queue history changed during roll-forward recovery');
    }
    await assertQueueStateFileUnchanged(location, current);
    await rename(temporaryPath, location.absolute);
    temporaryPath = null;
    await syncParentDirectory(location.absolute);
    const recovered = await readCurrentQueueState(location);
    const recoveredHistory = await readQueueStateHistory(location);
    assertStateMatchesHistory(coordinator, recovered, recoveredHistory);
    if (
      recoveredHistory.history_sha256 !== history.history_sha256 ||
      recoveredHistory.head.entry_sha256 !== history.head.entry_sha256 ||
      !recovered.bytes.equals(successorBytes)
    ) {
      throw new Error('queue state roll-forward did not install the exact pending head bytes');
    }
    return { current: recovered, history: recoveredHistory };
  } finally {
    if (temporaryPath !== null) await rm(temporaryPath, { force: true });
    await releaseQueueStateWriterLock(lockPath, lock, coordinator);
  }
}

/** Replay exact history/current bytes and recover reducer authority once. */
export async function readPersistedBuildQueueState({
  root,
  coordinator: coordinatorInput,
  resumeAttestation,
} = {}) {
  const location = await queueStateLocation(root, coordinatorInput);
  let current = await readOptionalCurrentQueueState(location);
  let history = await readQueueStateHistory(location, {
    allowMissing: true,
    allowEmpty: true,
  });
  let durableRevisionCommitments = await readQueueRevisionCommitments(location, {
    allowMissing: true,
  });
  if (
    durableRevisionCommitments !== null &&
    durableRevisionCommitments.length === (history?.entries.length ?? 0) + 1
  ) {
    const lockPath = `${location.absolute}.lock`;
    let lock;
    lock = await acquireQueueStateWriterLock(
      lockPath,
      location.coordinator,
      current === null ? 'genesis_roll_forward' : 'roll_forward',
      { reclaimDeadWriter: true },
    );
    try {
      current = await readOptionalCurrentQueueState(location);
      history = await readQueueStateHistory(location, {
        allowMissing: true,
        allowEmpty: true,
      });
      durableRevisionCommitments = await readQueueRevisionCommitments(location);
      if (
        durableRevisionCommitments.length !== (history?.entries.length ?? 0) + 1
      ) {
        throw new Error('durable queue revision tail changed before history recovery');
      }
      if (history !== null) {
        assertQueueRevisionCommitmentsMatchHistory(
          location,
          durableRevisionCommitments.slice(0, history.entries.length),
          history,
        );
      }
      history = await materializeCommittedQueueHistoryTail(
        location,
        history,
        durableRevisionCommitments.at(-1),
      );
    } finally {
      await releaseQueueStateWriterLock(lockPath, lock, location.coordinator);
    }
  }
  if (history === null) {
    throw new Error('QUEUE-STATE-HISTORY is missing and has no exact durable recovery tail');
  }
  if (
    durableRevisionCommitments === null ||
    durableRevisionCommitments.length !== history.entries.length
  ) {
    throw new Error(
      'queue state history is not fully covered by its durable revision commitments',
    );
  }
  assertQueueRevisionCommitmentsMatchHistory(
    location,
    durableRevisionCommitments,
    history,
  );
  await ensureQueueGenesisCommitment(location, history);
  markBuildApprovalQueueGenesisCommitted(location.coordinator);
  if (current === null) {
    ({ current, history } = await rollForwardMissingGenesisQueueState({
      root,
      coordinator: location.coordinator,
      location,
      resumeAttestation,
    }));
  } else {
    validateCoordinatorStateStructure(location.coordinator, current.state);
    const relation = inspectStateHistoryRelation(location.coordinator, current, history);
    if (relation.status === 'pending_roll_forward') {
      assertPendingQueueStateHead(location.coordinator, current, history, relation);
      ({ current, history } = await rollForwardPendingQueueState({
        root,
        coordinator: location.coordinator,
        location,
        resumeAttestation,
      }));
    } else {
      requireQueueStateResumeAttestation(
        resumeAttestation,
        location.coordinator,
        current,
        history,
        location,
      );
    }
  }
  const recoveredState = current.state;
  assertCurrentQueueStateHead(
    location.coordinator,
    recoveredState,
    current.file_sha256,
    history,
  );
  CONSUMED_QUEUE_STATE_RESUME_ATTESTATIONS.add(resumeAttestation);
  COORDINATOR_STATES.add(recoveredState);
  const branded = deepFreeze(recoveredState);
  const snapshot = mintQueueStateSnapshot(location.coordinator, branded, {
    statePath: location.relative_path,
    fileSha256: current.file_sha256,
    ...queueStateSnapshotHistoryOptions(location, history),
    persisted: true,
  });
  PERSISTED_QUEUE_STATE_HEADS.set(location.coordinator, {
    snapshot,
    state: clone(branded),
    file_sha256: current.file_sha256,
    history: clone(history),
  });
  return deepFreeze({
    state: branded,
    path: location.relative_path,
    history_path: location.history_relative_path,
    snapshot,
  });
}

function normalizeNewEvidence(item, records) {
  if (!Array.isArray(records)) throw new TypeError('evidence must be an array');
  const existingIds = new Set(evidenceItemMap(item).keys());
  const existingDigests = new Set(item.evidence.map(({ record_sha256: value }) => value));
  const normalized = records.map((record, index) => {
    validateCruiseEvidenceRecord(record);
    const recordSha256 = evidenceDigest(record);
    if (existingDigests.has(recordSha256)) {
      throw new Error(`evidence record ${recordSha256} is immutable and already recorded`);
    }
    existingDigests.add(recordSha256);
    for (const evidence of record.items) {
      if (!EVIDENCE_ID.test(evidence.id)) throw new TypeError('evidence IDs must use E-XX');
      if (existingIds.has(evidence.id)) {
        throw new Error(`evidence ${evidence.id} is immutable and already recorded`);
      }
      existingIds.add(evidence.id);
    }
    const wrapper = { record_sha256: recordSha256, record: clone(record) };
    validateEvidenceWrapper(wrapper, `evidence[${index}]`);
    return wrapper;
  });
  return normalized;
}

function validateChildOrigin(coordinator, definition, childOrigin) {
  if (!isPlainObject(childOrigin) || childOrigin.kind !== 'cruise_queue_child_origin') {
    throw new TypeError(`${definition.id} start requires a narrowed queue child origin`);
  }
  const parent = childOrigin.parent;
  if (
    !isPlainObject(parent) ||
    parent.origin_sha256 !== coordinator.queue.queue.origin_sha256 ||
    parent.queue_id !== coordinator.queue_id ||
    parent.queue_item_id !== definition.id ||
    parent.project_id !== coordinator.queue.queue.project_id ||
    parent.milestone_id !== coordinator.queue.queue.milestone_id ||
    parent.phase_id !== definition.phase
  ) {
    throw new Error(`${definition.id} child origin is not bound to the approved queue item`);
  }
  if (
    childOrigin.scope?.inherited_outcome !== definition.purpose ||
    childOrigin.scope?.narrowed_outcome !== definition.scope
  ) {
    throw new Error(`${definition.id} child outcomes differ from its locked purpose/scope`);
  }
  const permitted = safeRelativePathArray(childOrigin.scope?.permitted_changes, 'child origin permitted_changes', {
    allowEmpty: false,
  });
  const prohibited = safeRelativePathArray(
    childOrigin.scope?.prohibited_changes ?? [],
    'child origin prohibited_changes',
  );
  if (
    canonicalJson(permitted) !== canonicalJson(definition.permitted_changes) ||
    canonicalJson(prohibited) !== canonicalJson(definition.prohibited_changes)
  ) {
    throw new Error(`${definition.id} child path envelope differs from its locked queue item`);
  }
  return digest(childOrigin);
}

function nextAttemptId(item) {
  const count = item.attempts.filter(({ event }) => event === 'started').length + 1;
  return `${item.id}-A-${String(count).padStart(2, '0')}`;
}

function appendAttemptEvent(item, input) {
  const payload = {
    sequence: item.attempts.length + 1,
    attempt_id: input.attemptId,
    definition_sha256: input.definitionSha256,
    event: input.event,
    from_status: input.fromStatus,
    to_status: input.toStatus,
    at: input.at,
    evidence_ids: input.evidenceIds,
    child_origin: input.childOrigin == null ? null : clone(input.childOrigin),
    child_origin_sha256: input.childOriginSha256 ?? null,
    child_closeout_sha256: input.childCloseoutSha256 ?? null,
    reason: input.reason ?? null,
    consumed_inputs: clone(input.consumedInputs ?? []),
    repository_baseline_before: input.repositoryBaselineBefore ?? null,
    repository_baseline_after: input.repositoryBaselineAfter ?? null,
    previous_event_sha256: item.attempts.at(-1)?.event_sha256 ?? null,
  };
  item.attempts.push({ ...payload, event_sha256: digest(payload) });
}

function validateConsumedInputs(coordinator, state, definition, consumedInputs) {
  if (!Array.isArray(consumedInputs)) throw new TypeError('consumedInputs must be an array');
  const normalized = consumedInputs.map((input) => {
    exactKeys(input, ['name', 'sha256', 'producer_item_id'], 'consumed input');
    return {
      name: nonEmpty(input.name, 'consumed input name'),
      sha256: assertDigest(input.sha256, `${input.name}.sha256`),
      producer_item_id: input.producer_item_id == null
        ? null
        : nonEmpty(input.producer_item_id, `${input.name}.producer_item_id`),
    };
  }).sort((left, right) => left.name.localeCompare(right.name, 'en'));
  if (new Set(normalized.map(({ name }) => name)).size !== normalized.length) {
    throw new Error('consumed input names must be unique');
  }
  const expected = [...definition.consumes].sort((left, right) => left.localeCompare(right, 'en'));
  if (canonicalJson(normalized.map(({ name }) => name)) !== canonicalJson(expected)) {
    throw new Error(`${definition.id} consumed inputs differ from the locked queue definition`);
  }
  const stateById = new Map(state.items.map((item) => [item.id, item]));
  for (const input of normalized) {
    if (definition.requires.includes(input.producer_item_id)) {
      const producer = stateById.get(input.producer_item_id);
      const output = producer?.result?.outputs?.find(({ name }) => name === input.name);
      if (producer?.status !== 'completed' || output?.sha256 !== input.sha256) {
        throw new Error(`${input.name} bytes do not match the completed predecessor closeout`);
      }
      continue;
    }
    const revision = coordinator.reactive_debug_revision;
    const isReactiveFailureInput =
      definition.skill === 'debug' &&
      definition.mode === 'reactive' &&
      definition.requires.length === 0 &&
      input.producer_item_id === null &&
      revision?.trigger?.failure_artifact === input.name &&
      revision.trigger.failure_result_sha256 === input.sha256;
    if (!isReactiveFailureInput) {
      throw new Error(`${input.name} lacks an approved completed producer or Debug revision trigger`);
    }
  }
  return normalized;
}

function canStartAlongside(coordinator, definition, activeItems) {
  if (activeItems.length === 0) return true;
  if (
    definition.skill !== 'research' ||
    activeItems.length >= 4 ||
    activeItems.some((runtime) =>
      coordinator.queue.items.find(({ id }) => id === runtime.id)?.skill !== 'research')
  ) {
    return false;
  }
  const activeIds = new Set(activeItems.map(({ id }) => id));
  if (definition.requires.some((id) => activeIds.has(id))) return false;
  return activeItems.every((runtime) => {
    const activeDefinition = coordinator.queue.items.find(({ id }) => id === runtime.id);
    return !activeDefinition.requires.includes(definition.id);
  });
}

function validateChildCloseout(
  coordinator,
  definition,
  item,
  closeout,
  evidenceItems,
  newEvidenceIds,
  evidenceRecordDigests,
  newEvidenceRecordDigests,
) {
  exactKeys(closeout, [
    'kind',
    'queue_id',
    'queue_item_id',
    'skill',
    'attempt_id',
    'outcome',
    'child_origin_sha256',
    'result_sha256',
    'outputs',
    'acceptance_criteria',
    'evidence_ids',
    'evidence_record_digests',
    'completed_at',
  ], 'child closeout');
  if (
    closeout.kind !== 'cruise_queue_child_closeout' ||
    closeout.queue_id !== coordinator.queue_id ||
    closeout.queue_item_id !== definition.id ||
    closeout.skill !== definition.skill ||
    closeout.attempt_id !== item.active_attempt.attempt_id ||
    closeout.outcome !== 'completed' ||
    closeout.child_origin_sha256 !== item.active_attempt.child_origin_sha256
  ) {
    throw new Error(`${definition.id} child closeout does not match the active approved child`);
  }
  assertDigest(closeout.result_sha256, 'child closeout result_sha256');
  if (Number.isNaN(Date.parse(closeout.completed_at))) {
    throw new TypeError('child closeout completed_at must be an ISO date-time');
  }
  const referenced = stringArray(closeout.evidence_ids, 'child closeout evidence_ids', {
    allowEmpty: false,
  });
  for (const id of referenced) {
    const evidence = evidenceItems.get(id);
    if (!evidence) throw new Error(`child closeout references missing evidence ${id}`);
    if (evidence.gate !== 'mandatory' || evidence.status !== 'PASS' || evidence.performed !== true) {
      throw new Error(`child closeout evidence ${id} must be a performed mandatory PASS`);
    }
  }
  if (!referenced.some((id) => newEvidenceIds.has(id))) {
    throw new Error('completion requires newly recorded closeout evidence');
  }
  const recordDigests = stringArray(
    closeout.evidence_record_digests,
    'child closeout evidence_record_digests',
    { allowEmpty: false },
  );
  for (const value of recordDigests) {
    assertDigest(value, 'child closeout evidence record digest');
    if (!evidenceRecordDigests.has(value)) {
      throw new Error(`child closeout references missing evidence record ${value}`);
    }
  }
  if (!recordDigests.some((value) => newEvidenceRecordDigests.has(value))) {
    throw new Error('completion must bind a newly validated evidence record');
  }
  if (!Array.isArray(closeout.outputs)) throw new TypeError('child closeout outputs must be an array');
  const outputs = closeout.outputs.map((output) => {
    exactKeys(output, ['name', 'sha256'], 'child closeout output');
    nonEmpty(output.name, 'child closeout output name');
    assertDigest(output.sha256, `${output.name}.sha256`);
    return output;
  }).sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const expectedOutputs = [...definition.produces].sort((left, right) => left.localeCompare(right, 'en'));
  if (canonicalJson(outputs.map(({ name }) => name)) !== canonicalJson(expectedOutputs)) {
    throw new Error(`${definition.id} closeout outputs differ from the locked queue definition`);
  }
  if (!Array.isArray(closeout.acceptance_criteria)) {
    throw new TypeError('child closeout acceptance_criteria must be an array');
  }
  const acceptance = closeout.acceptance_criteria.map((criterion) => {
    exactKeys(criterion, ['id', 'evidence_ids'], 'child closeout acceptance criterion');
    const ids = stringArray(criterion.evidence_ids, `${criterion.id}.evidence_ids`, {
      allowEmpty: false,
    });
    for (const id of ids) {
      const evidence = evidenceItems.get(id);
      if (!evidence) throw new Error(`${criterion.id} references missing evidence ${id}`);
      if (!referenced.includes(id)) throw new Error(`${criterion.id} evidence is absent from closeout`);
      if (!evidence.supports.includes(criterion.id)) {
        throw new Error(`${id} does not mechanically support locked criterion ${criterion.id}`);
      }
    }
    return { id: nonEmpty(criterion.id, 'acceptance criterion id'), evidence_ids: ids };
  }).sort((left, right) => left.id.localeCompare(right.id, 'en'));
  const expectedCriteria = [...definition.acceptance_criteria]
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (canonicalJson(acceptance.map(({ id }) => id)) !== canonicalJson(expectedCriteria)) {
    throw new Error(`${definition.id} closeout does not cover its locked acceptance criteria exactly`);
  }
  for (const criterion of expectedCriteria) {
    if (!referenced.some((id) => evidenceItems.get(id).supports.includes(criterion))) {
      throw new Error(`${definition.id} lacks performed PASS evidence supporting ${criterion}`);
    }
  }
  return {
    closeout: clone(closeout),
    closeout_sha256: digest(closeout),
    outputs,
    acceptance,
    evidence_ids: referenced,
    evidence_record_digests: recordDigests,
  };
}

function normalizeFailure(failure) {
  exactKeys(failure, ['classification', 'summary'], 'failure');
  if (!FAILURE_CLASSIFICATIONS.has(failure.classification)) {
    throw new TypeError('failure classification is unsupported');
  }
  return {
    classification: failure.classification,
    summary: nonEmpty(failure.summary, 'failure summary'),
  };
}

function requiresFreshEvidence() {
  return true;
}

/** Apply one evidence-aware legal status transition without rewriting history. */
export function transitionBuildQueueItem(
  coordinatorInput,
  stateInput,
  {
    itemId,
    toStatus,
    evidence = [],
    childOrigin = null,
    childCloseout = null,
    failure = null,
    blockers = [],
    reason = null,
    startAdmission = null,
    consumedInputs = [],
    baselineTransition = null,
  } = {},
  { now = () => new Date() } = {},
) {
  const { coordinator, state } = assertCoordinatorState(coordinatorInput, stateInput);
  const definition = coordinator.queue.items.find(({ id }) => id === itemId);
  if (!definition) throw new Error(`unknown queue item ${itemId}`);
  const next = clone(state);
  const item = next.items.find(({ id }) => id === itemId);
  const fromStatus = item.status;
  if (!QUEUE_ITEM_STATUSES.includes(toStatus) || toStatus === 'draft') {
    throw new TypeError('invalid runtime queue status');
  }
  if (!LEGAL_QUEUE_STATUS_TRANSITIONS[fromStatus].includes(toStatus)) {
    throw new Error(`illegal queue status transition ${fromStatus} -> ${toStatus}`);
  }
  const at = nowIso(now);
  const newEvidence = normalizeNewEvidence(item, evidence);
  if (requiresFreshEvidence(fromStatus, toStatus) && newEvidence.length === 0) {
    throw new Error(`${fromStatus} -> ${toStatus} requires newly recorded evidence`);
  }
  item.evidence.push(...newEvidence);
  const newEvidenceIds = new Set(newEvidence.flatMap(({ record }) =>
    record.items.map(({ id }) => id)));
  const allEvidenceItems = evidenceItemMap(item);
  const evidenceRecordDigests = new Set(item.evidence.map(({ record_sha256: value }) => value));
  const newEvidenceRecordDigests = new Set(
    newEvidence.map(({ record_sha256: value }) => value),
  );
  const evidenceIds = [...newEvidenceIds];
  const normalizedReason = reason == null ? null : nonEmpty(reason, 'transition reason');
  const normalizedBlockers = stringArray(blockers, 'blockers');
  let admissionToConsume = null;
  let baselineTransitionToConsume = null;

  if (toStatus === 'running') {
    if (fromStatus === 'ready') {
      const otherActive = state.items.filter((candidate) =>
        candidate.id !== itemId && candidate.active_attempt != null);
      if (!canStartAlongside(coordinator, definition, otherActive)) {
        throw new Error('parallel start is allowed only for bounded independent Research items');
      }
      admissionToConsume = validateStartAdmission(coordinator, state, itemId, startAdmission);
      const inputManifest = validateConsumedInputs(
        coordinator,
        state,
        definition,
        consumedInputs,
      );
      const childOriginSha256 = validateChildOrigin(coordinator, definition, childOrigin);
      const attemptId = nextAttemptId(item);
      item.active_attempt = {
        attempt_id: attemptId,
        child_origin: clone(childOrigin),
        child_origin_sha256: childOriginSha256,
        consumed_inputs: inputManifest,
        repository_baseline_before: state.expected_repository_baseline_digest,
        started_at: at,
      };
      appendAttemptEvent(item, {
        attemptId,
        definitionSha256: coordinator.definition_sha256,
        event: 'started',
        fromStatus,
        toStatus,
        at,
        evidenceIds,
        childOrigin,
        childOriginSha256,
        reason: normalizedReason,
        consumedInputs: inputManifest,
        repositoryBaselineBefore: state.expected_repository_baseline_digest,
      });
    } else {
      if (item.active_attempt == null) {
        throw new Error(`${item.id} must return to ready before starting after pre-launch auth`);
      }
      appendAttemptEvent(item, {
        attemptId: item.active_attempt.attempt_id,
        definitionSha256: coordinator.definition_sha256,
        event: 'resumed',
        fromStatus,
        toStatus,
        at,
        evidenceIds,
        childOriginSha256: item.active_attempt.child_origin_sha256,
        reason: normalizedReason,
        consumedInputs: item.active_attempt.consumed_inputs,
        repositoryBaselineBefore: item.active_attempt.repository_baseline_before,
      });
    }
  } else if (toStatus === 'completed') {
    if (item.active_attempt == null) throw new Error(`${item.id} has no running child to close`);
    baselineTransitionToConsume = validateBaselineTransition(
      coordinator,
      state,
      item,
      baselineTransition,
    );
    if (
      definition.skill === 'research' &&
      baselineTransition.after_digest !== baselineTransition.before_digest
    ) {
      throw new Error('read-only Research completion cannot advance the product baseline');
    }
    if (!newEvidence.some(({ record }) => record.outcome === 'completed')) {
      throw new Error('completion requires a newly finalized Cruise evidence record');
    }
    const completion = validateChildCloseout(
      coordinator,
      definition,
      item,
      childCloseout,
      allEvidenceItems,
      newEvidenceIds,
      evidenceRecordDigests,
      newEvidenceRecordDigests,
    );
    appendAttemptEvent(item, {
      attemptId: item.active_attempt.attempt_id,
      definitionSha256: coordinator.definition_sha256,
      event: 'completed',
      fromStatus,
      toStatus,
      at,
      evidenceIds,
      childOriginSha256: item.active_attempt.child_origin_sha256,
      childCloseoutSha256: completion.closeout_sha256,
      reason: normalizedReason,
      repositoryBaselineBefore: baselineTransition.before_digest,
      repositoryBaselineAfter: baselineTransition.after_digest,
    });
    item.result = {
      kind: 'cruise_queue_child_completion',
      attempt_id: item.active_attempt.attempt_id,
      child_closeout_sha256: completion.closeout_sha256,
      child_closeout: completion.closeout,
      result_sha256: completion.closeout.result_sha256,
      evidence_ids: completion.evidence_ids,
      evidence_record_digests: completion.evidence_record_digests,
      outputs: completion.outputs,
      completed_at: at,
    };
    item.active_attempt = null;
    next.expected_repository_baseline_digest = baselineTransition.after_digest;
  } else if (toStatus === 'failed') {
    if (item.active_attempt == null) {
      throw new Error(`${item.id} cannot fail without a running evidence-bound attempt`);
    }
    baselineTransitionToConsume = validateBaselineTransition(
      coordinator,
      state,
      item,
      baselineTransition,
    );
    const normalizedFailure = normalizeFailure(failure);
    if (item.active_attempt != null) {
      appendAttemptEvent(item, {
        attemptId: item.active_attempt.attempt_id,
        definitionSha256: coordinator.definition_sha256,
        event: 'failed',
        fromStatus,
        toStatus,
        at,
        evidenceIds,
        childOriginSha256: item.active_attempt.child_origin_sha256,
        reason: normalizedFailure.summary,
        repositoryBaselineBefore: baselineTransition.before_digest,
        repositoryBaselineAfter: baselineTransition.after_digest,
      });
    }
    item.result = {
      kind: 'cruise_queue_item_failure',
      classification: normalizedFailure.classification,
      summary: normalizedFailure.summary,
      evidence_ids: evidenceIds,
      failed_at: at,
    };
    item.active_attempt = null;
    next.expected_repository_baseline_digest = baselineTransition.after_digest;
  } else {
    if (toStatus === 'waiting_auth' && normalizedBlockers.length === 0) {
      normalizedBlockers.push('authentication_required');
    }
    if (['waiting_approval', 'blocked'].includes(toStatus) && normalizedBlockers.length === 0) {
      throw new Error(`${toStatus} requires an explicit blocker`);
    }
    if (fromStatus === 'waiting_auth' && toStatus === 'ready' && item.active_attempt != null) {
      throw new Error(`${item.id} has an active attempt and must resume running or fail`);
    }
    if (item.active_attempt != null) {
      if (!['waiting_auth'].includes(toStatus)) {
        baselineTransitionToConsume = validateBaselineTransition(
          coordinator,
          state,
          item,
          baselineTransition,
        );
        next.expected_repository_baseline_digest = baselineTransition.after_digest;
      }
      appendAttemptEvent(item, {
        attemptId: item.active_attempt.attempt_id,
        definitionSha256: coordinator.definition_sha256,
        event: toStatus,
        fromStatus,
        toStatus,
        at,
        evidenceIds,
        childOriginSha256: item.active_attempt.child_origin_sha256,
        reason: normalizedReason,
        repositoryBaselineBefore: item.active_attempt.repository_baseline_before,
        repositoryBaselineAfter: baselineTransitionToConsume?.after_digest ?? null,
      });
      if (!['waiting_auth'].includes(toStatus)) item.active_attempt = null;
    }
    if (toStatus === 'ready') item.result = null;
  }

  item.status = toStatus;
  item.blockers = ['ready', 'running', 'completed', 'failed', 'skipped', 'cancelled'].includes(toStatus)
    ? []
    : normalizedBlockers;
  item.updated_at = at;
  next.revision += 1;
  next.updated_at = at;
  validateCoordinatorStateStructure(coordinator, next);
  if (admissionToConsume != null) CONSUMED_START_ADMISSIONS.add(admissionToConsume);
  if (baselineTransitionToConsume != null) {
    CONSUMED_BASELINE_TRANSITIONS.add(baselineTransitionToConsume);
  }
  COORDINATOR_STATES.add(next);
  return deepFreeze(next);
}

export function reconcileBuildQueueState(
  coordinatorInput,
  stateInput,
  { now = () => new Date() } = {},
) {
  const { coordinator, state } = assertCoordinatorState(coordinatorInput, stateInput);
  const at = nowIso(now);
  const next = reconcilePrivateQueueState(coordinator.queue, state, at);
  next.revision = state.revision + 1;
  next.updated_at = at;
  validateCoordinatorStateStructure(coordinator, next);
  COORDINATOR_STATES.add(next);
  return deepFreeze(next);
}

export function buildQueueCompletionStatus(coordinatorInput, stateInput) {
  const { coordinator, state } = assertCoordinatorState(coordinatorInput, stateInput);
  return privateQueueCompletionStatus(coordinator.queue, state);
}

/**
 * Draft, but never approve or install, the only legal reactive Debug insertion.
 * The returned definition has a new digest and therefore requires fresh Build
 * verification plus a fresh queue approval before a coordinator can use it.
 */
export function createReactiveDebugQueueRevision(
  coordinatorInput,
  stateInput,
  {
    failedItemId,
    purpose,
    scope,
    produces,
    permissionsRequired = [],
    capabilityRequirements = [],
  } = {},
) {
  const { coordinator, state } = assertCoordinatorState(coordinatorInput, stateInput);
  const originalDigest = workflowQueueDigest(coordinator.queue);
  const failedDefinition = coordinator.queue.items.find(({ id }) => id === failedItemId);
  const failedRuntime = state.items.find(({ id }) => id === failedItemId);
  if (!failedDefinition || failedRuntime?.status !== 'failed') {
    throw new Error('reactive Debug requires a failed predecessor');
  }
  if (failedRuntime.result?.classification !== 'unknown_cause') {
    throw new Error('reactive Debug is allowed only when the predecessor cause remains unknown');
  }
  const failureEvidence = stringArray(
    failedRuntime.result.evidence_ids,
    'failed predecessor evidence',
    { allowEmpty: false },
  );
  const produced = stringArray(produces, 'Debug produces', { allowEmpty: false });
  const id = allocateBuildId('QI', coordinator.queue.items.map((item) => item.id));
  const failureResultSha256 = digest(failedRuntime.result);
  const failureArtifact = `cruise-failure-evidence:${failedItemId}:${failureResultSha256}`;
  const items = coordinator.queue.items.map((item) => {
    const value = { ...clone(item), dependents: [] };
    if (value.id === failedItemId) {
      value.requires = [...value.requires, id];
      value.consumes = [...value.consumes, ...produced];
    }
    return value;
  });
  items.push({
    id,
    skill: 'debug',
    purpose: nonEmpty(purpose, 'Debug purpose'),
    scope: nonEmpty(scope, 'Debug scope'),
    status: 'draft',
    mode: 'reactive',
    phase: failedDefinition.phase,
    requires: [],
    dependents: [],
    consumes: [failureArtifact],
    produces: produced,
    mandatory: failedDefinition.mandatory,
    auto_start: false,
    auto_start_conditions: [],
    permissions_required: stringArray(permissionsRequired, 'permissionsRequired'),
    capability_requirements: stringArray(capabilityRequirements, 'capabilityRequirements'),
    acceptance_criteria: [],
    permitted_changes: clone(failedDefinition.permitted_changes),
    prohibited_changes: clone(failedDefinition.prohibited_changes),
    parent_origin_sha256: coordinator.queue.queue.origin_sha256,
    child_origin_policy: 'inherit_and_narrow',
    blockers: [],
    attempts: [],
    result: null,
  });
  const revisedQueue = createWorkflowQueue({
    id: coordinator.queue.queue.id,
    projectId: coordinator.queue.queue.project_id,
    milestoneId: coordinator.queue.queue.milestone_id,
    originSha256: coordinator.queue.queue.origin_sha256,
    buildContractDigest: coordinator.queue.queue.build_contract_digest,
    approved: false,
    approvedAt: null,
    items,
  });
  validateQueueCoordinationContract(revisedQueue, {
    milestonePhaseDag: coordinator.verified_build_approval.milestone_phase_dag,
  });
  const revisedDigest = workflowQueueDigest(revisedQueue);
  if (revisedDigest === originalDigest) throw new Error('reactive Debug revision did not change the queue');
  if (workflowQueueDigest(coordinator.queue) !== originalDigest) {
    throw new Error('locked queue was mutated while drafting its Debug revision');
  }
  const revision = deepFreeze({
    schema_version: 1,
    kind: 'cruise_unapproved_reactive_debug_queue_revision',
    approved: false,
    requires_fresh_build_verification: true,
    requires_fresh_queue_approval: true,
    supersedes: {
      queue_id: coordinator.queue_id,
      definition_sha256: originalDigest,
      build_approval_digest: coordinator.build_approval_digest,
    },
    trigger: {
      failed_item_id: failedItemId,
      failure_classification: failedRuntime.result.classification,
      failure_evidence_ids: failureEvidence,
      failure_result_sha256: failureResultSha256,
      failure_artifact: failureArtifact,
    },
    debug_item_id: id,
    definition_sha256: revisedDigest,
    queue: revisedQueue,
    superseded_queue: coordinator.queue,
  });
  DEBUG_REVISIONS.add(revision);
  return revision;
}

/** Carry approved history into Q2 only after the revised queue earns fresh authority. */
export function migrateReactiveDebugQueueRevision(
  previousCoordinatorInput,
  previousStateInput,
  revision,
  newCoordinatorInput,
  { now = () => new Date() } = {},
) {
  const { coordinator: previousCoordinator, state: previousState } =
    assertCoordinatorState(previousCoordinatorInput, previousStateInput);
  const newCoordinator = requireCoordinator(newCoordinatorInput);
  if (!DEBUG_REVISIONS.has(revision) || newCoordinator.reactive_debug_revision !== revision) {
    throw new Error('Debug queue migration requires the opaque revision and fresh coordinator authority');
  }
  if (
    revision.supersedes.queue_id !== previousCoordinator.queue_id ||
    revision.supersedes.definition_sha256 !== previousCoordinator.definition_sha256 ||
    revision.supersedes.build_approval_digest !== previousCoordinator.build_approval_digest ||
    revision.definition_sha256 !== newCoordinator.definition_sha256
  ) {
    throw new Error('reactive Debug revision lineage does not match both approved coordinators');
  }
  if (newCoordinator.build_approval_digest === previousCoordinator.build_approval_digest) {
    throw new Error('reactive Debug revision requires fresh Build reapproval');
  }
  if (
    newCoordinator.verified_build_approval.repository_baseline_digest !==
    previousState.expected_repository_baseline_digest
  ) {
    throw new Error('reactive Debug reapproval must start from the failed state expected baseline');
  }
  const at = nowIso(now);
  const next = clone(initializeBuildQueueState(newCoordinator, { now: at }));
  next.expected_repository_baseline_digest = previousState.expected_repository_baseline_digest;
  const oldById = new Map(previousState.items.map((item) => [item.id, item]));
  for (const item of next.items) {
    const prior = oldById.get(item.id);
    if (!prior) continue;
    if (item.id === revision.trigger.failed_item_id) {
      item.status = 'queued';
      item.blockers = ['waiting_dependencies'];
      item.attempts = clone(prior.attempts);
      item.evidence = clone(prior.evidence);
      item.prior_failure = clone(prior.result);
      item.result = null;
      item.active_attempt = null;
    } else {
      item.status = prior.status;
      item.blockers = clone(prior.blockers);
      item.attempts = clone(prior.attempts);
      item.evidence = clone(prior.evidence);
      item.result = clone(prior.result);
      item.active_attempt = clone(prior.active_attempt);
    }
    item.updated_at = at;
  }
  const reconciled = reconcilePrivateQueueState(newCoordinator.queue, next, at);
  reconciled.revision = previousState.revision + 1;
  reconciled.updated_at = at;
  reconciled.migration = {
    kind: 'cruise_reactive_debug_queue_migration',
    from_definition_sha256: previousCoordinator.definition_sha256,
    revision_definition_sha256: revision.definition_sha256,
    migrated_at: at,
  };
  validateCoordinatorStateStructure(newCoordinator, reconciled);
  COORDINATOR_STATES.add(reconciled);
  return deepFreeze(reconciled);
}
