import { createHash } from 'node:crypto';
import { lstat, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  captureRepositoryBaseline as captureOriginRepositoryBaseline,
  validateOriginRecord,
} from './origin.mjs';
import {
  inspectMilestoneController,
  MILESTONE_CONTROLLER_ARTIFACT,
  parseMilestoneController,
} from './milestone-controller.mjs';
import { canonicalJson, parseYaml } from './yaml-state.mjs';

export const ORIGIN_ARTIFACT = '.cruise/goal/ORIGIN.yaml';

export const PLAN_ARTIFACTS = Object.freeze([
  ORIGIN_ARTIFACT,
  '.cruise/goal/SPEC.md',
  '.cruise/goal/DECISIONS.md',
  '.cruise/goal/ALIGNMENT.md',
  '.cruise/goal/PLAN.md',
]);

export const APPROVED_ARTIFACTS = Object.freeze([
  ...PLAN_ARTIFACTS,
  '.cruise/goal/GOAL.md',
]);

export const OPTIONAL_ARTIFACTS = Object.freeze(['.cruise/goal/ROADMAP.md']);
const CLOSEOUT_PATH = '.cruise/goal/CLOSEOUT.md';
const KNOWN_GOAL_STATUSES = new Set([
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete',
]);

export class GoalActivationUncertainError extends Error {
  constructor(
    message,
    {
      cause = null,
      objective = null,
      interrupted = false,
      pendingRequest = null,
      rpcTimeoutMs = null,
    } = {},
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = 'GoalActivationUncertainError';
    this.code = 'CRUISE_GOAL_ACTIVATION_UNCERTAIN';
    this.mayHaveCommitted = true;
    this.objective = objective;
    this.interrupted = interrupted;
    this.pendingRequest = pendingRequest;
    this.rpcTimeoutMs = rpcTimeoutMs;
  }
}

export class GoalActivationInterruptedError extends Error {
  constructor(message = 'Cruise Goal activation was interrupted before commit.') {
    super(message);
    this.name = 'GoalActivationInterruptedError';
    this.code = 'CRUISE_INTERRUPTED';
  }
}

function throwIfActivationAborted(signal) {
  if (signal?.aborted) throw new GoalActivationInterruptedError();
}

function requestWithBoundary({
  client,
  method,
  params,
  signal,
  timeoutMs,
  uncertain,
  objective,
}) {
  const request = client.request(method, params);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const boundaryError = (message, { interrupted = false, cause = null } = {}) =>
      uncertain
        ? new GoalActivationUncertainError(message, {
            cause,
            objective,
            interrupted,
            pendingRequest: request,
            rpcTimeoutMs: timeoutMs,
          })
        : interrupted
          ? new GoalActivationInterruptedError(message)
          : new Error(message, cause ? { cause } : undefined);
    const onAbort = () =>
      finish(
        reject,
        boundaryError(
          uncertain
            ? 'Goal activation was interrupted after its RPC may have committed.'
            : 'Cruise Goal activation was interrupted before commit.',
          { interrupted: true },
        ),
      );
    const timer = setTimeout(() => {
      finish(
        reject,
        boundaryError(
          uncertain
            ? `Timed out waiting for ${method}; Goal state is uncertain.`
            : `Timed out waiting for ${method}.`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    request.then(
      (result) => finish(resolve, result),
      (cause) =>
        finish(
          reject,
          boundaryError(
            uncertain
              ? `${method} failed after Goal state may have changed.`
              : `${method} failed.`,
            { cause },
          ),
        ),
    );
  });
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function normalizeChoice(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function isApprovePlanChoice(value) {
  return String(value ?? '') === 'Approve Plan';
}

export function isStartCruiseChoice(value) {
  return String(value ?? '') === 'Start Cruise';
}

export function isApprovePlanGoalChoice(value) {
  return String(value ?? '') === 'Approve both';
}

export function isPlanGoalReviewOptions(options) {
  const labels = (options ?? []).map(({ label } = {}) => String(label ?? ''));
  return (
    labels.length === 3 &&
    labels[0] === 'Approve both' &&
    labels[1] === 'Refine' &&
    labels[2] === 'Reject both'
  );
}

export function isGoalNeedsOptions(options) {
  const labels = (options ?? []).map(({ label } = {}) => String(label ?? ''));
  return (
    labels.length === 4 &&
    labels[0] === 'Approve all' &&
    labels[1] === 'Select some' &&
    labels[2] === 'Reject all' &&
    labels[3] === 'Discuss'
  );
}

export function extractAlignmentStem(markdown) {
  const match = String(markdown).match(
    /^##\s+Stem\s*$\r?\n([\s\S]*?)(?=^##\s+|\s*$)/im,
  );
  if (!match) {
    throw new Error('ALIGNMENT.md must contain a non-empty `## Stem` section.');
  }

  const stem = match[1]
    .replace(/<!--([\s\S]*?)-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stem) {
    throw new Error('ALIGNMENT.md must contain a non-empty `## Stem` section.');
  }
  return stem;
}

async function readArtifact(cwd, relativePath, { optional = false } = {}) {
  const absolutePath = join(cwd, relativePath);
  let metadata;
  try {
    metadata = await lstat(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT' && optional) return null;
    if (error?.code === 'ENOENT') {
      if (relativePath === ORIGIN_ARTIFACT) {
        throw new Error(
          `Legacy Cruise Goal suite detected without ${ORIGIN_ARTIFACT}; its raw prompt is unavailable. Reconcile it explicitly into a new origin-bearing candidate before activation.`,
        );
      }
      throw new Error(`Missing required Cruise artifact: ${relativePath}.`);
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size === 0) {
    throw new Error(`${relativePath} must be a non-empty regular file.`);
  }
  const bytes = await readFile(absolutePath);
  return {
    path: relativePath,
    absolutePath,
    sha256: digest(bytes),
    bytes,
  };
}

function parseAndValidateGoalOrigin(artifact) {
  let record;
  try {
    record = parseYaml(artifact.bytes.toString('utf8'));
    validateOriginRecord(record);
  } catch (cause) {
    throw new Error(`${ORIGIN_ARTIFACT} is invalid: ${cause.message}`, { cause });
  }
  if (record.origin.selected_skill !== 'goal') {
    throw new Error(`${ORIGIN_ARTIFACT} must preserve selected_skill: goal.`);
  }
  return record;
}

function assertOriginMatchesPrompt(artifacts, expectedRawPrompt) {
  if (expectedRawPrompt == null) return;
  const artifact = artifacts.find(({ path }) => path === ORIGIN_ARTIFACT);
  const record = parseAndValidateGoalOrigin(artifact);
  if (record.origin.raw_prompt !== expectedRawPrompt) {
    throw new Error(
      `${ORIGIN_ARTIFACT} does not preserve the exact triggering prompt bytes.`,
    );
  }
}

function assertOriginMatchesRepository(artifacts, cwd) {
  const artifact = artifacts.find(({ path }) => path === ORIGIN_ARTIFACT);
  const record = parseAndValidateGoalOrigin(artifact);
  const actual = captureOriginRepositoryBaseline(cwd);
  if (canonicalJson(record.repository_baseline) !== canonicalJson(actual)) {
    throw new Error(
      `${ORIGIN_ARTIFACT} repository_baseline does not match a fresh independent capture of the target repository.`,
    );
  }
}

/** Inspect legacy state without inventing prompt bytes or mutating locked artifacts. */
export async function inspectGoalOrigin(cwd) {
  const artifact = await readArtifact(cwd, ORIGIN_ARTIFACT, { optional: true });
  if (!artifact) {
    return Object.freeze({
      status: 'legacy_origin_unavailable',
      artifact: null,
      record: null,
      activation_eligible: false,
    });
  }
  const record = parseAndValidateGoalOrigin(artifact);
  return Object.freeze({
    status: 'origin_available',
    artifact,
    record,
    activation_eligible: true,
  });
}

async function assertCloseoutInactive(cwd) {
  try {
    await stat(join(cwd, CLOSEOUT_PATH));
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${CLOSEOUT_PATH} must not exist before native Goal activation.`);
}

export async function inspectApprovedArtifacts(
  cwd,
  { stage = 'goal', controllerAuthority = null } = {},
) {
  const required = stage === 'plan' ? PLAN_ARTIFACTS : APPROVED_ARTIFACTS;
  const artifacts = [];
  for (const relativePath of required) {
    const artifact = await readArtifact(cwd, relativePath);
    if (relativePath === ORIGIN_ARTIFACT) parseAndValidateGoalOrigin(artifact);
    artifacts.push(artifact);
  }
  for (const relativePath of OPTIONAL_ARTIFACTS) {
    const artifact = await readArtifact(cwd, relativePath, { optional: true });
    if (artifact) artifacts.push(artifact);
  }
  const controller = await inspectMilestoneController(cwd, {
    authority: controllerAuthority,
  });
  if (controller.controllerArtifact) {
    artifacts.push(controller.controllerArtifact, ...controller.lockedArtifacts);
  }
  return artifacts;
}

export function captureRepositoryBaseline(cwd) {
  const baseline = captureOriginRepositoryBaseline(cwd);
  if (baseline.capture_status === 'blocked') {
    return {
      kind: 'blocked',
      root: baseline.root,
      sha256: null,
      block: { ...baseline.block },
    };
  }
  return {
    kind: baseline.head === null ? 'non-git-or-unborn' : 'git',
    root: baseline.root,
    ...(baseline.head === null ? {} : { head: baseline.head }),
    sha256: baseline.dirty_state_digest,
  };
}

function snapshot(stage, artifacts, baseline, controllerAuthority = null) {
  const approval = {
    stage,
    artifacts,
    baseline,
    capturedAt: Date.now(),
  };
  if (controllerAuthority !== null) approval.controllerAuthority = controllerAuthority;
  return approval;
}

function artifactMap(artifacts) {
  return new Map(artifacts.map((artifact) => [artifact.path, artifact.sha256]));
}

function assertArtifactDigests(expectedArtifacts, actualArtifacts, label) {
  const expected = artifactMap(expectedArtifacts);
  const actual = artifactMap(actualArtifacts);
  if (expected.size !== actual.size) {
    throw new Error(`${label} artifact set changed after approval.`);
  }
  for (const [path, sha256] of expected) {
    if (actual.get(path) !== sha256) {
      throw new Error(`${path} changed after ${label} approval.`);
    }
  }
}

function assertBaseline(expected, actual, message = 'The target repository changed after Plan approval.') {
  if (actual.kind === 'blocked') {
    throw new Error(`Repository baseline capture is blocked: ${actual.block.code}`);
  }
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(message);
  }
}

export async function capturePlanApproval(
  cwd,
  {
    expectedBaseline = null,
    expectedRawPrompt = null,
    controllerAuthority = null,
  } = {},
) {
  await assertCloseoutInactive(cwd);
  const artifacts = await inspectApprovedArtifacts(cwd, {
    stage: 'plan',
    controllerAuthority,
  });
  assertOriginMatchesPrompt(artifacts, expectedRawPrompt);
  const baseline = captureRepositoryBaseline(cwd);
  if (baseline.kind === 'blocked') {
    throw new Error(`Repository baseline capture is blocked: ${baseline.block.code}`);
  }
  if (expectedBaseline) {
    assertBaseline(
      expectedBaseline,
      baseline,
      'The target repository changed during Cruise preparation.',
    );
  }
  assertOriginMatchesRepository(artifacts, cwd);
  return snapshot('plan', artifacts, baseline, controllerAuthority);
}

export async function verifyPlanApproval(cwd, planApproval) {
  if (planApproval?.stage !== 'plan') {
    throw new Error('No Plan review snapshot is available.');
  }
  await assertCloseoutInactive(cwd);
  const artifacts = await inspectApprovedArtifacts(cwd, {
    stage: 'plan',
    controllerAuthority: planApproval.controllerAuthority ?? null,
  });
  assertArtifactDigests(planApproval.artifacts, artifacts, 'Plan');
  assertBaseline(planApproval.baseline, captureRepositoryBaseline(cwd));
  return artifacts;
}

export async function captureGoalApproval(cwd, planApproval) {
  if (planApproval?.stage !== 'plan') {
    throw new Error('Start Cruise requires a separately approved Plan first.');
  }
  await assertCloseoutInactive(cwd);
  const artifacts = await inspectApprovedArtifacts(cwd, {
    stage: 'goal',
    controllerAuthority: planApproval.controllerAuthority ?? null,
  });
  const currentPlanArtifacts = artifacts.filter(
    ({ path }) => path !== '.cruise/goal/GOAL.md',
  );
  assertArtifactDigests(planApproval.artifacts, currentPlanArtifacts, 'Plan');
  assertBaseline(planApproval.baseline, captureRepositoryBaseline(cwd));
  return snapshot(
    'goal',
    artifacts,
    planApproval.baseline,
    planApproval.controllerAuthority ?? null,
  );
}

/**
 * Capture one approval over the complete Plan + Goal suite.
 *
 * GOAL.md is finalized before this snapshot, so there is no legitimate
 * contract write between review and native Goal activation. This is the
 * ordinary Goal path; capturePlanApproval/captureGoalApproval remain exported
 * only for reading and safely resuming legacy two-review sessions.
 */
export async function capturePlanGoalApproval(
  cwd,
  {
    expectedBaseline = null,
    expectedRawPrompt = null,
    controllerAuthority = null,
  } = {},
) {
  await assertCloseoutInactive(cwd);
  const artifacts = await inspectApprovedArtifacts(cwd, {
    stage: 'goal',
    controllerAuthority,
  });
  assertOriginMatchesPrompt(artifacts, expectedRawPrompt);
  const baseline = captureRepositoryBaseline(cwd);
  if (baseline.kind === 'blocked') {
    throw new Error(`Repository baseline capture is blocked: ${baseline.block.code}`);
  }
  if (expectedBaseline) {
    assertBaseline(
      expectedBaseline,
      baseline,
      'The target repository changed during Cruise preparation.',
    );
  }
  assertOriginMatchesRepository(artifacts, cwd);
  return snapshot('plan-goal', artifacts, baseline, controllerAuthority);
}

export async function verifyPlanGoalApproval(cwd, approval) {
  if (approval?.stage !== 'plan-goal') {
    throw new Error('No combined Plan and Goal review snapshot is available.');
  }
  await assertCloseoutInactive(cwd);
  const artifacts = await inspectApprovedArtifacts(cwd, {
    stage: 'goal',
    controllerAuthority: approval.controllerAuthority ?? null,
  });
  assertArtifactDigests(approval.artifacts, artifacts, 'Plan and Goal');
  assertBaseline(approval.baseline, captureRepositoryBaseline(cwd));
  return artifacts;
}

export async function verifyGoalApproval(cwd, goalApproval) {
  if (goalApproval?.stage === 'plan-goal') {
    return verifyPlanGoalApproval(cwd, goalApproval);
  }
  if (goalApproval?.stage !== 'goal') {
    throw new Error('No approved Goal artifact snapshot is available.');
  }
  await assertCloseoutInactive(cwd);
  const artifacts = await inspectApprovedArtifacts(cwd, {
    stage: 'goal',
    controllerAuthority: goalApproval.controllerAuthority ?? null,
  });
  assertArtifactDigests(goalApproval.artifacts, artifacts, 'Goal');
  assertBaseline(goalApproval.baseline, captureRepositoryBaseline(cwd));
  return artifacts;
}

export function buildGoalObjective(alignmentStem, milestoneController = null) {
  const stem = String(alignmentStem).replace(/\s+/g, ' ').trim();
  if (!stem) {
    throw new Error('Cannot build a Goal without an alignment stem.');
  }

  const objectiveParts = [
    `Complete the approved Cruise outcome: ${stem}`,
    'Before editing, validate and read `.cruise/goal/ORIGIN.yaml`, then follow `.cruise/goal/ALIGNMENT.md`, `.cruise/goal/PLAN.md`, and `.cruise/goal/GOAL.md` as the approved source of truth.',
    'Remain the root coordinator: assign a `recommended_level` before every substantive phase, invoke the typed `cruise worker --level <2-7>` launcher for substantive worker execution, and block if the launcher cannot attest the configured runtime selection.',
  ];
  if (milestoneController) {
    const controller =
      milestoneController.mode === 'milestone-controller'
        ? milestoneController
        : parseMilestoneController(milestoneController);
    objectiveParts.push(
      `Operate as the hierarchical milestone controller for ${controller.milestone.id} at \`${controller.milestone.path}\`, bound to contract digest \`${controller.milestone.contract_digest}\`; read \`${MILESTONE_CONTROLLER_ARTIFACT}\` and its locked project and milestone artifacts before work.`,
      'Do not flatten the milestone into one implementation plan: reconcile the repository and prior closeout before each phase, create an immutable just-in-time plan for only the next ready phase, require focused evidence and phase closeout before advancing, and write progress only to mutable milestone state and phase runtime artifacts.',
      'Stop for contract revision on locked-artifact drift or any required change to outcome, non-goals, mandatory requirements, acceptance criteria, dependencies, permissions, protected behavior, or the completion fence. Claim milestone completion only after every mandatory phase and aggregate verification gate has current evidence.',
    );
  } else {
    objectiveParts.push(
      'Execute only the current slice, preserve its protected behavior and permission envelope, keep checkpoint evidence current, and stop only when every mandatory acceptance criterion and verification gate passes or an explicit blocking condition is met.',
    );
  }
  const objective = objectiveParts.join(' ');

  if (objective.length > 4000) {
    throw new Error('The generated Goal objective exceeds Codex\'s 4,000-character limit.');
  }
  return objective;
}

export async function activateApprovedGoal({
  client,
  threadId,
  cwd,
  approvedSnapshot,
  signal = null,
  rpcTimeoutMs = 30_000,
}) {
  throwIfActivationAborted(signal);
  let artifacts = await verifyGoalApproval(cwd, approvedSnapshot);
  throwIfActivationAborted(signal);
  const alignment = artifacts.find(
    (artifact) => artifact.path === '.cruise/goal/ALIGNMENT.md',
  );
  const stem = extractAlignmentStem(alignment.bytes.toString('utf8'));
  const controllerArtifact = artifacts.find(
    (artifact) => artifact.path === MILESTONE_CONTROLLER_ARTIFACT,
  );
  const objective = buildGoalObjective(
    stem,
    controllerArtifact?.bytes ?? null,
  );

  const before = await requestWithBoundary({
    client,
    method: 'thread/goal/get',
    params: { threadId },
    signal,
    timeoutMs: rpcTimeoutMs,
    uncertain: false,
    objective,
  });
  if (before?.goal) {
    throw new Error(
      `Cannot start Cruise: thread ${threadId} already has a persisted Goal (${before.goal.status}).`,
    );
  }

  // Close the RPC-time drift window immediately before the atomic Goal set.
  artifacts = await verifyGoalApproval(cwd, approvedSnapshot);
  throwIfActivationAborted(signal);
  let setResponse;
  try {
    setResponse = await requestWithBoundary({
      client,
      method: 'thread/goal/set',
      params: {
        threadId,
        objective,
        status: 'active',
      },
      signal,
      timeoutMs: rpcTimeoutMs,
      uncertain: true,
      objective,
    });
  } catch (cause) {
    if (cause instanceof GoalActivationUncertainError) throw cause;
    throw new GoalActivationUncertainError(
      'Native Goal activation may have committed, but its response was unavailable.',
      { cause, objective },
    );
  }
  if (
    setResponse?.goal?.status !== 'active' ||
    setResponse.goal.objective !== objective
  ) {
    throw new GoalActivationUncertainError(
      'Codex did not atomically confirm the approved Goal as active.',
      { objective },
    );
  }

  let confirmed;
  try {
    confirmed = await requestWithBoundary({
      client,
      method: 'thread/goal/get',
      params: { threadId },
      signal,
      timeoutMs: rpcTimeoutMs,
      uncertain: true,
      objective,
    });
  } catch (cause) {
    if (cause instanceof GoalActivationUncertainError) throw cause;
    throw new GoalActivationUncertainError(
      'The Goal was set, but persisted-state confirmation failed.',
      { cause, objective },
    );
  }
  if (
    !confirmed?.goal ||
    confirmed.goal.objective !== objective ||
    !KNOWN_GOAL_STATUSES.has(confirmed.goal.status)
  ) {
    throw new GoalActivationUncertainError(
      'The persisted Goal did not match the approved Cruise contract.',
      { objective },
    );
  }

  return {
    goal: confirmed.goal,
    objective,
    artifacts: artifacts.map(({ path, sha256 }) => ({ path, sha256 })),
  };
}
