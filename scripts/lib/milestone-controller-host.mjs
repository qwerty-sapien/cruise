import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import {
  isVerifiedBuildApproval,
  validateWorkflowQueue,
  workflowQueueDigest,
} from './build-contract.mjs';
import {
  activateMilestoneControllerPhase,
  answerMilestoneControllerQuestion,
  attestMilestoneCompletionFence,
  attestMilestonePhaseCloseout,
  attestMilestonePhasePlan,
  authorizeDangerousMode,
  authorizeDangerousQuestionSuppressionEffect,
  cancelMilestoneControllerState,
  closeMilestoneControllerPhase,
  completeMilestoneControllerState,
  consumeDangerousAuthorization,
  createMilestoneControllerState,
  establishMilestoneControllerGoalActivation,
  inspectMilestoneController,
  invalidateMilestoneControllerAuthority,
  invalidateMilestoneControllerInteractionBroker,
  isMilestoneControllerStateProvenance,
  issueDangerousAuthorizationChallenge,
  loadMilestoneControllerState,
  pauseMilestoneControllerForQuestion,
  persistMilestoneControllerState,
  recordMilestoneControllerHardStop,
  reopenMilestoneControllerQuestion,
  revokeDangerousQuestionSuppression,
  stopMilestoneControllerPhase,
  validateDangerousQuestionSuppression,
  validateMilestoneControllerState,
} from './milestone-controller.mjs';
import { parseYaml } from './yaml-state.mjs';

const MAX_BOOTSTRAP_STATE_BYTES = 4 * 1024 * 1024;
const BUILD_DRAFT_STATE_KIND = 'cruise_milestone_state';
const CONTROLLER_STATE_KIND = 'cruise_milestone_controller_state';
const CONTROLLER_HISTORY_DIRECTORY = 'CONTROLLER-STATE-HISTORY';
const SHA256 = /^[a-f0-9]{64}$/u;
const PROJECT_ID = /^PRJ-[0-9]{2,}$/u;
const QUESTION_ID = /^Q-[0-9]{2,}$/u;
const BUILD_DRAFT_STATE_KEYS = Object.freeze([
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
]);

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) throw new Error(`${label} must be a mapping`);
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  const canonical = [...expected].sort((left, right) => left.localeCompare(right, 'en'));
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new Error(`${label} must contain exactly the canonical Build fields`);
  }
}

function digest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function normalizedIds(value, expression, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be a sequence`);
  const seen = new Set();
  const ids = value.map((candidate) => {
    if (typeof candidate !== 'string' || !expression.test(candidate)) {
      throw new Error(`${label} contains an invalid identifier`);
    }
    if (seen.has(candidate)) throw new Error(`${label} contains duplicate identifiers`);
    seen.add(candidate);
    return candidate;
  });
  return ids.sort((left, right) => left.localeCompare(right, 'en'));
}

function lockedArtifact(inspection, path) {
  const artifact = inspection.lockedArtifacts.find((candidate) => candidate.path === path);
  if (!artifact) throw new Error(`verified Build approval omits locked artifact ${path}`);
  return artifact;
}

function parseLockedArtifact(artifact) {
  let record;
  try {
    record = parseYaml(artifact.bytes.toString('utf8'), {
      maxBytes: MAX_BOOTSTRAP_STATE_BYTES,
    });
  } catch (cause) {
    throw new Error(`${artifact.path} is not valid YAML: ${cause.message}`, { cause });
  }
  if (!isRecord(record)) throw new Error(`${artifact.path} must contain one mapping`);
  return record;
}

function openQuestionIds(inspection) {
  const path = `${inspection.controller.milestone.path}/QUESTIONS.yaml`;
  const record = parseLockedArtifact(lockedArtifact(inspection, path));
  if (!Array.isArray(record.questions)) {
    throw new Error(`${path}.questions must be a sequence`);
  }
  return normalizedIds(
    record.questions
      .filter((question) => ['open', 'deferred'].includes(question?.status))
      .map((question) => question?.id),
    QUESTION_ID,
    `${path} open question IDs`,
  );
}

function verifiedDraftBindings({
  cwd,
  controllerInspection,
  goalActivationAuthority,
  verifiedBuildApproval,
}) {
  if (!isVerifiedBuildApproval(verifiedBuildApproval)) {
    throw new Error('controller bootstrap requires the opaque verified Build approval receipt');
  }
  const controller = controllerInspection.controller;
  const manifest = verifiedBuildApproval.manifest;
  const readiness = verifiedBuildApproval.approval_readiness;
  const readinessBindings = readiness?.bindings;
  const activeQueue = verifiedBuildApproval.active_queue;
  if (
    verifiedBuildApproval.mode !== 'milestone' ||
    verifiedBuildApproval.approval_digest !==
      controllerInspection.authoritySnapshot.build_approval_digest ||
    manifest?.milestone_id !== controller.milestone.id ||
    manifest?.milestone_path !== controller.milestone.path ||
    manifest?.contract_digest !== controller.milestone.contract_digest ||
    readinessBindings?.repository_root !== cwd ||
    readinessBindings?.milestone_id !== controller.milestone.id ||
    verifiedBuildApproval.repository_baseline_digest !==
      goalActivationAuthority.repository_baseline_digest ||
    readinessBindings?.repository_baseline_digest !==
      goalActivationAuthority.repository_baseline_digest
  ) {
    throw new Error('verified Build approval bindings differ from this controller activation');
  }
  if (
    typeof readinessBindings.project_id !== 'string' ||
    !PROJECT_ID.test(readinessBindings.project_id)
  ) {
    throw new Error('verified Build approval has an invalid project identity');
  }
  const milestonePath = controller.milestone.path;
  const originPath = `${milestonePath}/ORIGIN.yaml`;
  const queuePath = `${milestonePath}/QUEUE.yaml`;
  const origin = lockedArtifact(controllerInspection, originPath);
  const queueArtifact = lockedArtifact(controllerInspection, queuePath);
  const queue = validateWorkflowQueue(parseLockedArtifact(queueArtifact));
  const queueDefinitionSha256 = workflowQueueDigest(queue);
  if (
    activeQueue?.path !== queuePath ||
    activeQueue?.artifact_sha256 !== queueArtifact.sha256 ||
    activeQueue?.definition_sha256 !== queueDefinitionSha256 ||
    activeQueue?.build_contract_digest !== queue.queue.build_contract_digest ||
    queue.queue.project_id !== readinessBindings.project_id ||
    queue.queue.milestone_id !== controller.milestone.id ||
    queue.queue.origin_sha256 !== origin.sha256 ||
    readinessBindings.milestone_origin_sha256 !== origin.sha256 ||
    verifiedBuildApproval.build_contract_digest !== queue.queue.build_contract_digest
  ) {
    throw new Error('verified Build queue/origin bindings differ from the locked milestone');
  }
  return Object.freeze({
    projectId: readinessBindings.project_id,
    milestoneId: controller.milestone.id,
    repositoryBaselineDigest: goalActivationAuthority.repository_baseline_digest,
    readinessDigest: digest(
      verifiedBuildApproval.approval_readiness_digest,
      'verified Build approval readiness digest',
    ),
    originSha256: origin.sha256,
    contractDigest: queue.queue.build_contract_digest,
    queueDefinitionSha256,
    openQuestionIds: openQuestionIds(controllerInspection),
    phaseIds: Object.freeze(controller.phase_dag.map(({ id }) => id)),
  });
}

async function canonicalRepositoryRoot(cwd) {
  const requested = resolve(nonEmpty(cwd, 'cwd'));
  return realpath(requested);
}

async function readBootstrapState(root, relativePath) {
  const absolutePath = resolve(root, relativePath);
  if (
    absolutePath === root ||
    !absolutePath.startsWith(`${root}${sep}`) ||
    absolutePath !== join(root, relativePath)
  ) {
    throw new Error('milestone-controller STATE.yaml path escapes the repository');
  }
  const before = await lstat(absolutePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${relativePath} must be a regular no-follow file`);
  }
  if (before.size === 0 || before.size > MAX_BOOTSTRAP_STATE_BYTES) {
    throw new Error(`${relativePath} is empty or exceeds the bounded state size`);
  }
  if (await realpath(absolutePath) !== absolutePath) {
    throw new Error(`${relativePath} must not traverse a symbolic link`);
  }
  const handle = await open(
    absolutePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs
    ) {
      throw new Error(`${relativePath} changed before the controller host could read it`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      bytes.length !== opened.size
    ) {
      throw new Error(`${relativePath} changed while the controller host read it`);
    }
    const record = parseYaml(bytes.toString('utf8'), {
      maxBytes: MAX_BOOTSTRAP_STATE_BYTES,
    });
    if (!isRecord(record)) throw new Error(`${relativePath} must contain one mapping`);
    return record;
  } finally {
    await handle.close();
  }
}

function validateBuildDraftState(record, bindings) {
  exactKeys(record, BUILD_DRAFT_STATE_KEYS, 'milestone Build draft STATE.yaml');
  exactKeys(
    record.artifact_identities,
    ['origin_sha256', 'contract_digest', 'queue_definition_sha256'],
    'milestone Build draft STATE.yaml.artifact_identities',
  );
  exactKeys(
    record.last_reconciliation,
    ['repository_baseline_digest', 'reconciled_at'],
    'milestone Build draft STATE.yaml.last_reconciliation',
  );
  if (
    record.kind !== BUILD_DRAFT_STATE_KIND ||
    record.schema_version !== 1 ||
    record.project_id !== bindings.projectId ||
    record.milestone_id !== bindings.milestoneId ||
    record.status !== 'draft' ||
    record.active_phase !== null
  ) {
    throw new Error(
      'existing milestone STATE.yaml is neither the exact Build draft state nor controller runtime state',
    );
  }
  if (normalizedIds(record.completed_phases, /^P-[0-9]{2,}$/u, 'completed_phases').length) {
    throw new Error('milestone Build draft STATE.yaml cannot contain completed phases');
  }
  const open = normalizedIds(record.open_questions, QUESTION_ID, 'open_questions');
  if (
    open.length !== bindings.openQuestionIds.length ||
    open.some((id, index) => id !== bindings.openQuestionIds[index])
  ) {
    throw new Error('milestone Build draft STATE.yaml open questions differ from locked QUESTIONS.yaml');
  }
  digest(record.current_repository_baseline, 'current_repository_baseline');
  digest(record.readiness_digest, 'readiness_digest');
  digest(record.artifact_identities.origin_sha256, 'artifact_identities.origin_sha256');
  digest(record.artifact_identities.contract_digest, 'artifact_identities.contract_digest');
  digest(
    record.artifact_identities.queue_definition_sha256,
    'artifact_identities.queue_definition_sha256',
  );
  digest(
    record.last_reconciliation.repository_baseline_digest,
    'last_reconciliation.repository_baseline_digest',
  );
  if (
    record.current_repository_baseline !== bindings.repositoryBaselineDigest ||
    record.readiness_digest !== bindings.readinessDigest ||
    record.artifact_identities.origin_sha256 !== bindings.originSha256 ||
    record.artifact_identities.contract_digest !== bindings.contractDigest ||
    record.artifact_identities.queue_definition_sha256 !== bindings.queueDefinitionSha256 ||
    record.last_reconciliation.repository_baseline_digest !==
      bindings.repositoryBaselineDigest
  ) {
    throw new Error('milestone Build draft STATE.yaml bindings do not match verified Build approval');
  }
  if (
    record.last_reconciliation.reconciled_at !== null &&
    (typeof record.last_reconciliation.reconciled_at !== 'string' ||
      Number.isNaN(Date.parse(record.last_reconciliation.reconciled_at)))
  ) {
    throw new Error('milestone Build draft STATE.yaml reconciliation time is invalid');
  }
  if (
    typeof record.recommended_next_cruise_command !== 'string' ||
    record.recommended_next_cruise_command.trim() === '' ||
    !bindings.phaseIds.some((id) => record.recommended_next_cruise_command.includes(id))
  ) {
    throw new Error('milestone Build draft STATE.yaml next command must identify an approved phase');
  }
}

async function durableControllerHistoryExists(cwd, milestonePath) {
  const historyPath = join(cwd, milestonePath, CONTROLLER_HISTORY_DIRECTORY);
  try {
    await lstat(historyPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function openInitialControllerState({
  cwd,
  authority,
  controllerInspection,
  goalActivationAuthority,
  verifiedBuildApproval,
}) {
  const statePath = `${controllerInspection.controller.milestone.path}/STATE.yaml`;
  const existing = await readBootstrapState(cwd, statePath);
  const bindings = verifiedDraftBindings({
    cwd,
    controllerInspection,
    goalActivationAuthority,
    verifiedBuildApproval,
  });
  if (
    existing.kind === CONTROLLER_STATE_KIND ||
    await durableControllerHistoryExists(
      cwd,
      controllerInspection.controller.milestone.path,
    )
  ) {
    return {
      state: await loadMilestoneControllerState({
        cwd,
        authority,
        controllerInspection,
        goalActivationAuthority,
      }),
      disposition: 'loaded',
      persistence: null,
    };
  }
  validateBuildDraftState(existing, bindings);
  const state = createMilestoneControllerState({
    authority,
    controllerInspection,
    goalActivationAuthority,
    repositoryBaselineDigest: goalActivationAuthority.repository_baseline_digest,
  });
  const persistence = await persistMilestoneControllerState({
    cwd,
    state,
    authority,
    controllerInspection,
    goalActivationAuthority,
  });
  return { state, disposition: 'created', persistence };
}

/**
 * A resolver-capable in-process host owns the opaque controller objects. It
 * exposes named controller operations instead of returning generic authority
 * arguments to arbitrary callbacks.
 */
export class MilestoneControllerHostDriver {
  #cwd;
  #interactionBroker;
  #authority;
  #inspection;
  #goalActivationAuthority;
  #state;
  #closed = false;
  #tail = Promise.resolve();

  constructor({
    cwd,
    interactionBroker,
    authority,
    controllerInspection,
    goalActivationAuthority,
    state,
  }) {
    this.#cwd = cwd;
    this.#interactionBroker = interactionBroker;
    this.#authority = authority;
    this.#inspection = controllerInspection;
    this.#goalActivationAuthority = goalActivationAuthority;
    this.#state = state;
  }

  get state() {
    this.#assertOpen();
    return this.#state;
  }

  get closed() {
    return this.#closed;
  }

  describe() {
    this.#assertOpen();
    return Object.freeze({
      kind: 'cruise_live_milestone_controller_host',
      run_id: this.#state.run_id,
      milestone_id: this.#state.milestone_id,
      milestone_path: this.#state.milestone_path,
      controller_digest: this.#state.controller_digest,
      contract_digest: this.#state.contract_digest,
      goal_activation_digest: this.#state.goal_activation_digest,
      repository_baseline_digest: this.#state.repository_baseline_digest,
      status: this.#state.status,
      revision: this.#state.revision,
    });
  }

  persist() {
    return this.#serialize(async () => {
      const persistence = await persistMilestoneControllerState(this.#bindings());
      return Object.freeze({ state: this.#state, persistence });
    });
  }

  reload() {
    return this.#serialize(async () => {
      this.#inspection = await inspectMilestoneController(this.#cwd, {
        authority: this.#authority,
        sessionId: this.#authority.session_id,
        runId: this.#authority.run_id,
      });
      this.#state = await loadMilestoneControllerState(this.#bindings());
      return this.#state;
    });
  }

  pauseQuestion(input = {}) {
    return this.#transition(pauseMilestoneControllerForQuestion, input);
  }

  answerQuestion(input = {}) {
    return this.#transition(answerMilestoneControllerQuestion, input);
  }

  reopenQuestion(input = {}) {
    return this.#transition(reopenMilestoneControllerQuestion, input);
  }

  activatePhase(input = {}) {
    return this.#serialize(async () => {
      const phasePlanAttestation = await attestMilestonePhasePlan({
        ...input,
        ...this.#bindings(),
      });
      return this.#commit(await activateMilestoneControllerPhase({
        ...this.#bindings(),
        phasePlanAttestation,
        now: input.now,
      }));
    });
  }

  closePhase(input = {}) {
    return this.#serialize(async () => {
      const closeoutAttestation = await attestMilestonePhaseCloseout({
        ...input,
        ...this.#bindings(),
      });
      return this.#commit(closeMilestoneControllerPhase({
        ...this.#bindings(),
        closeoutAttestation,
        now: input.now,
      }));
    });
  }

  stopPhase(input = {}) {
    return this.#transition(stopMilestoneControllerPhase, input);
  }

  hardStop(input = {}) {
    return this.#transition(recordMilestoneControllerHardStop, input);
  }

  complete(input = {}) {
    return this.#serialize(async () => {
      const completionAttestation = await attestMilestoneCompletionFence({
        ...input,
        ...this.#bindings(),
      });
      return this.#commit(completeMilestoneControllerState({
        ...this.#bindings(),
        completionAttestation,
        now: input.now,
      }));
    });
  }

  cancel(input = {}) {
    return this.#transition(cancelMilestoneControllerState, input);
  }

  issueDangerousChallenge(input = {}) {
    return this.#serialize(() => issueDangerousAuthorizationChallenge({
      ...input,
      ...this.#bindings(),
    }));
  }

  observeDirectUserResponse(input = {}) {
    this.#assertOpen();
    return this.#interactionBroker.observeDirectUserResponse(input);
  }

  authorizeDangerous(input = {}) {
    return this.#serialize(() => authorizeDangerousMode({
      ...input,
      ...this.#bindings(),
    }));
  }

  consumeDangerous(input = {}) {
    return this.#serialize(() => consumeDangerousAuthorization({
      ...input,
      ...this.#bindings(),
    }));
  }

  authorizeDangerousEffect(input = {}) {
    return this.#serialize(() => authorizeDangerousQuestionSuppressionEffect({
      ...input,
      ...this.#bindings(),
    }));
  }

  validateDangerousEffect(effectAuthority, { lifecycleEvent = null } = {}) {
    this.#assertOpen();
    return validateDangerousQuestionSuppression(effectAuthority, {
      authority: this.#authority,
      controllerInspection: this.#inspection,
      repositoryBaselineDigest: this.#state.repository_baseline_digest,
      lifecycleEvent,
    });
  }

  revokeDangerous(grantOrEffect, reason = 'revoked') {
    this.#assertOpen();
    return revokeDangerousQuestionSuppression(grantOrEffect, reason);
  }

  async close(reason = 'host_closed') {
    if (this.#closed) return false;
    await this.#tail.catch(() => {});
    this.#closed = true;
    invalidateMilestoneControllerAuthority(this.#authority, reason);
    invalidateMilestoneControllerInteractionBroker(this.#interactionBroker, reason);
    return true;
  }

  #assertOpen() {
    if (this.#closed) throw new Error('milestone-controller host driver is closed');
  }

  #bindings() {
    return {
      cwd: this.#cwd,
      state: this.#state,
      authority: this.#authority,
      controllerInspection: this.#inspection,
      goalActivationAuthority: this.#goalActivationAuthority,
    };
  }

  #serialize(operation) {
    this.#assertOpen();
    const task = this.#tail.then(async () => {
      this.#assertOpen();
      return operation();
    });
    this.#tail = task.catch(() => {});
    return task;
  }

  #transition(operation, input) {
    return this.#serialize(async () => this.#commit(await operation({
      ...input,
      ...this.#bindings(),
    })));
  }

  async #commit(nextState) {
    if (!isMilestoneControllerStateProvenance(nextState)) {
      throw new Error('controller operation did not return provenance-branded state');
    }
    validateMilestoneControllerState(nextState, {
      authority: this.#authority,
      controllerInspection: this.#inspection,
      goalActivationAuthority: this.#goalActivationAuthority,
    });
    const persistence = await persistMilestoneControllerState({
      ...this.#bindings(),
      state: nextState,
    });
    this.#state = nextState;
    return Object.freeze({ state: nextState, persistence });
  }
}

/**
 * Exchange the confirmed native Goal activation for executable controller
 * authority, then create or recover canonical persistent controller state.
 */
export async function activateMilestoneControllerHost({
  cwd,
  interactionBroker,
  controllerAuthority,
  verifiedBuildApproval,
  approvedSnapshot,
  activationResult,
  threadId,
  interactionId,
  now = () => new Date(),
} = {}) {
  const root = await canonicalRepositoryRoot(cwd);
  if (typeof interactionBroker?.observeNativeGoalActivation !== 'function') {
    throw new TypeError('interactionBroker must be the live controller interaction broker');
  }
  const activationReceipt = interactionBroker.observeNativeGoalActivation({
    interactionId: nonEmpty(interactionId, 'interactionId'),
    threadId: nonEmpty(threadId, 'threadId'),
    activationResult,
    approvedSnapshot,
    now,
  });
  const controllerInspection = await inspectMilestoneController(root, {
    authority: controllerAuthority,
    sessionId: controllerAuthority?.session_id ?? null,
    runId: controllerAuthority?.run_id ?? null,
  });
  const goalActivationAuthority = await establishMilestoneControllerGoalActivation({
    cwd: root,
    authority: controllerAuthority,
    controllerInspection,
    activationReceipt,
    now,
  });
  const opened = await openInitialControllerState({
    cwd: root,
    authority: controllerAuthority,
    controllerInspection,
    goalActivationAuthority,
    verifiedBuildApproval,
  });
  const driver = new MilestoneControllerHostDriver({
    cwd: root,
    interactionBroker,
    authority: controllerAuthority,
    controllerInspection,
    goalActivationAuthority,
    state: opened.state,
  });
  return Object.freeze({
    driver,
    disposition: opened.disposition,
    persistence: opened.persistence,
  });
}
