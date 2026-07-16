import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  attestBuildApprovalReadiness,
  attestStructuredBuildApprovalSelection,
  captureBuildApproval,
  createQueueApproval,
  createQueueChildOrigin,
  createWorkflowQueue,
  prepareBuildApprovalReview,
  prepareBuildContractDigests,
  READINESS_CATEGORIES,
  verifyBuildApproval,
  verifyBuildApprovalArtifacts,
  workflowQueueDigest,
} from '../scripts/lib/build-contract.mjs';
import {
  attestBuildQueueBaselineTransition,
  attestCurrentBuildQueueBaseline,
  attestManualBuildQueueStart,
  attestBuildQueueResearchReconciliation,
  attestBuildQueueSemanticAdmission,
  authorizeAutomaticBuildQueueStart,
  buildQueueCompletionStatus,
  createBuildQueueCoordinator,
  createBuildQueueHostInteractionBroker,
  createReactiveDebugQueueRevision,
  initializeBuildQueueState,
  migrateReactiveDebugQueueRevision,
  reconcileBuildQueueState,
  transitionBuildQueueItem,
} from '../scripts/lib/build-queue-coordinator.mjs';
import {
  createEvidenceItem,
  createEvidenceRecord,
  evidenceDigest,
} from '../scripts/lib/evidence.mjs';
import { captureInitialBuildOrigin } from '../scripts/lib/build-history.mjs';
import { captureRepositoryBaseline } from '../scripts/lib/goal-contract.mjs';
import { stringifyYaml } from '../scripts/lib/yaml-state.mjs';
import {
  architectureMarkdown,
  autonomyState,
  buildApprovalEvidenceFixture,
  decisionsMarkdown,
  milestoneMarkdown,
  milestoneRequirementsMarkdown,
  milestoneRoadmapMarkdown,
  milestoneState,
  installBuildHistoryAuthorities,
  reconcileBuildHistoryAuthorities,
  projectMarkdown,
  projectRequirementsMarkdown,
  projectRoadmapMarkdown,
  projectState,
} from './helpers/build-contract-artifacts.mjs';

const NOW = '2026-07-13T00:00:00.000Z';
const LATER = '2026-07-13T01:00:00.000Z';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);
const DIGEST_D = 'd'.repeat(64);
const IDENTITY = Object.freeze({
  source: 'git:test-fixture',
  build: 'source-tree:test-fixture',
  environment: 'node test; isolated temporary repository',
});

function approvalReadiness({
  root,
  projectOrigin,
  milestoneOrigin,
  repositoryBaselineDigest,
  interaction = 'initial',
}) {
  const evidence = buildApprovalEvidenceFixture({
    repositoryRoot: root,
    repositoryBaselineDigest,
    projectOriginSha256: bytesDigest(projectOrigin),
    milestoneOriginSha256: bytesDigest(milestoneOrigin),
    mode: 'bootstrap',
  });
  return attestBuildApprovalReadiness({
    mode: 'bootstrap',
    repositoryRoot: root,
    repositoryBaselineDigest,
    projectId: 'PRJ-01',
    milestoneId: 'M-003',
    projectOriginSha256: bytesDigest(projectOrigin),
    milestoneOriginSha256: bytesDigest(milestoneOrigin),
    repositoryEvidence: evidence.repositoryEvidence,
    readiness: {
      mode_candidate: 'bootstrap',
      ...Object.fromEntries(READINESS_CATEGORIES.map((category) => [category, {
        status: 'clear',
        evidence: ['E-01'],
      }])),
      fatal_contradictions: [],
      research_blockers: [],
      user_decisions_required: [],
    },
    viability: {
      concept_id: 'C-01',
      critical_gates: {
        beneficiary_identified: 'pass',
        meaningful_outcome: 'pass',
        coherent_scope: 'pass',
        plausible_implementation: 'pass',
        verifiable_completion: 'pass',
        constraints_compatible: 'pass',
        no_fatal_contradiction: 'pass',
      },
      supporting_dimensions: {
        expected_value: 90,
        feasibility_confidence: 0.95,
        implementation_clarity: 90,
        verification_clarity: 90,
        reversibility: 90,
        operational_sustainability: 90,
      },
      unresolved: {
        user_decisions: [],
        research_questions: [],
        phase_local_questions: [],
      },
    },
    evidenceAuthority: evidence.evidenceAuthority,
  });
}

function bytesDigest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function phase() {
  return {
    id: 'P-01',
    name: 'Phase 01',
    outcome: 'Deliver one independently useful outcome.',
    strategically_complete: true,
    depends_on: [],
    requirements: ['R-01'],
    acceptance_criteria: ['AC-01'],
    protected_behavior: ['Compatibility remains intact.'],
    expected_artifacts: ['phase-output'],
    verification: ['focused test evidence'],
    rollback_boundary: 'Revert phase P-01.',
    blocking_questions: [],
    goal_handoff: 'Use cruise:goal for P-01.',
  };
}

function queueItem(id, skill = 'quick', overrides = {}) {
  return {
    id,
    skill,
    purpose: `Complete ${id}`,
    scope: `Only ${id} approved scope`,
    status: 'draft',
    mode: '',
    phase: null,
    requires: [],
    dependents: [],
    consumes: [],
    produces: [`artifact-${id}`],
    mandatory: true,
    auto_start: false,
    auto_start_conditions: [],
    permissions_required: [],
    capability_requirements: [],
    acceptance_criteria: [],
    permitted_changes: [`src/${id}.mjs`, `tests/${id}.test.mjs`],
    prohibited_changes: ['deploy/production'],
    child_origin_policy: 'inherit_and_narrow',
    blockers: [],
    attempts: [],
    result: null,
    ...overrides,
  };
}

function selection(interactionId = 'foundation-approval', reviewDigest = DIGEST_A) {
  const option = { id: 'approve_foundation', label: 'Approve Foundation' };
  return attestStructuredBuildApprovalSelection({
    kind: 'host_structured_choice_event',
    source: 'request_user_input',
    input_kind: 'option_selection',
    interaction_id: interactionId,
    mode: 'bootstrap',
    option_id: option.id,
    selected_label: option.label,
    selected_at: NOW,
    offered_options: [option, { id: 'revise', label: 'Revise' }],
    review_digest: reviewDigest,
  });
}

function origin(root, mode) {
  return captureInitialBuildOrigin({
    rawPrompt: mode === 'bootstrap' ? 'Create the project foundation.' : 'Define M-003.',
    repositoryBaseline: {
      root,
      head: null,
      branch: null,
      dirty_state_digest: DIGEST_A,
      instruction_files: [],
    },
    deterministicProbeDigest: DIGEST_B,
    initialClassifier: 'test classifier medium',
    confidence: 0.99,
    capturedAt: NOW,
    build: {
      mode,
      mode_candidate: mode,
      mode_evidence: ['bounded test evidence'],
      target_project: 'PRJ-01',
      target_milestone: mode === 'milestone' ? 'M-003' : null,
    },
  });
}

async function writeFiles(directory, files) {
  await mkdir(directory, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(directory, name), contents);
  }
}

async function approvedFixture({ researchBeforeGoal = false, extraResearchCount = 0 } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cruise-queue-coordinator-')));
  const projectPath = '.cruise/project';
  const milestonePath = '.cruise/milestones/M-003-coord';
  const projectDirectory = join(root, projectPath);
  const milestoneDirectory = join(root, milestonePath);
  const projectCapture = origin(root, 'bootstrap');
  const milestoneCapture = origin(root, 'milestone');
  const projectOrigin = stringifyYaml(projectCapture.origin_record);
  const milestoneOrigin = stringifyYaml(milestoneCapture.origin_record);
  await writeFiles(projectDirectory, {
    'ORIGIN.yaml': projectOrigin,
    'PROJECT.md': projectMarkdown(),
    'REQUIREMENTS.md': projectRequirementsMarkdown(),
    'ARCHITECTURE.md': architectureMarkdown(),
    'ROADMAP.md': projectRoadmapMarkdown(),
    'DECISIONS.md': decisionsMarkdown('D-01', 'Select fail-closed queue coordination.'),
  });
  await writeFiles(milestoneDirectory, {
    'ORIGIN.yaml': milestoneOrigin,
    'MILESTONE.md': milestoneMarkdown(),
    'REQUIREMENTS.md': milestoneRequirementsMarkdown([phase()]),
    'ROADMAP.md': milestoneRoadmapMarkdown([phase()]),
    'DECISIONS.md': decisionsMarkdown('D-02', 'Use one Goal execution per phase.'),
    'QUESTIONS.yaml': stringifyYaml({ questions: [] }),
    'AUTONOMY.yaml': stringifyYaml(autonomyState()),
  });
  const milestonePhaseDag = [phase()];
  const draft = await prepareBuildContractDigests({
    root,
    mode: 'bootstrap',
    contractDirectory: projectPath,
    firstMilestoneDirectory: milestonePath,
    milestonePhaseDag,
  });
  const projectQueue = createWorkflowQueue({
    id: 'QUEUE-PRJ-01',
    projectId: 'PRJ-01',
    originSha256: bytesDigest(projectOrigin),
    buildContractDigest: draft.project_contract_digest,
    items: [
      queueItem('QI-01'),
      queueItem('QI-02', 'quick', {
        requires: ['QI-01'],
        consumes: ['artifact-QI-01'],
      }),
      queueItem('QI-03', 'research', {
        mandatory: false,
        auto_start: true,
        auto_start_conditions: ['host_ready'],
      }),
      queueItem('QI-04', 'research', { mandatory: false }),
      ...Array.from({ length: extraResearchCount }, (_entry, index) => queueItem(
        `QI-${String(index + 5).padStart(2, '0')}`,
        'research',
        { mandatory: false },
      )),
    ],
  });
  const milestoneQueue = createWorkflowQueue({
    id: 'QUEUE-M-003',
    projectId: 'PRJ-01',
    milestoneId: 'M-003',
    originSha256: bytesDigest(milestoneOrigin),
    buildContractDigest: draft.build_contract_digest,
    items: researchBeforeGoal
      ? [
          queueItem('QI-01', 'research', {
            purpose: 'Resolve the approved implementation-detail question.',
            scope: 'Read-only research for P-01.',
            produces: ['research-brief'],
          }),
          queueItem('QI-02', 'goal', {
            phase: 'P-01',
            requires: ['QI-01'],
            consumes: ['research-brief'],
            acceptance_criteria: ['AC-01'],
            produces: ['phase-output'],
          }),
        ]
      : [queueItem('QI-01', 'goal', {
          phase: 'P-01',
          acceptance_criteria: ['AC-01'],
          produces: ['phase-output'],
        })],
  });
  await writeFile(join(projectDirectory, 'QUEUE.yaml'), stringifyYaml(projectQueue));
  await writeFile(join(milestoneDirectory, 'QUEUE.yaml'), stringifyYaml(milestoneQueue));
  const buildHistory = await installBuildHistoryAuthorities({
    root,
    projectCapture,
    milestoneCapture,
    projectOriginBytes: projectOrigin,
    milestoneOriginBytes: milestoneOrigin,
    milestonePath,
    at: NOW,
  });
  const repositoryBaselineDigest = captureRepositoryBaseline(root).sha256;
  const readinessAuthority = approvalReadiness({
    root,
    projectOrigin,
    milestoneOrigin,
    repositoryBaselineDigest,
  });
  await writeFile(join(projectDirectory, 'STATE.yaml'), stringifyYaml(projectState({
    repositoryBaselineDigest,
    readinessDigest: readinessAuthority.readiness_digest,
    originSha256: bytesDigest(projectOrigin),
    contractDigest: draft.project_contract_digest,
    queue: projectQueue,
    reconciledAt: NOW,
  })));
  await writeFile(join(milestoneDirectory, 'STATE.yaml'), stringifyYaml(milestoneState({
    repositoryBaselineDigest,
    readinessDigest: readinessAuthority.readiness_digest,
    originSha256: bytesDigest(milestoneOrigin),
    contractDigest: draft.build_contract_digest,
    queue: milestoneQueue,
    reconciledAt: NOW,
  })));
  const review = await prepareBuildApprovalReview({
    root,
    mode: 'bootstrap',
    contractDirectory: projectPath,
    firstMilestoneDirectory: milestonePath,
    milestonePhaseDag,
    repositoryBaselineDigest,
    approvalReadiness: readinessAuthority,
    buildOriginPairAuthority: buildHistory.buildOriginPairAuthority,
    buildIdHistoryAuthority: buildHistory.buildIdHistoryAuthority,
  });
  const approvalSelection = selection('foundation-approval', review.review_digest);
  const approval = await captureBuildApproval({
    root,
    mode: 'bootstrap',
    contractDirectory: projectPath,
    firstMilestoneDirectory: milestonePath,
    milestonePhaseDag,
    approvalSelection,
    approvalReadiness: readinessAuthority,
    repositoryBaselineDigest,
    buildOriginPairAuthority: buildHistory.buildOriginPairAuthority,
    buildIdHistoryAuthority: buildHistory.buildIdHistoryAuthority,
    now: NOW,
  });
  const receipt = await verifyBuildApproval({
    root,
    approval,
    approvalSelection,
    currentRepositoryBaselineDigest: repositoryBaselineDigest,
    buildOriginPairAuthority: buildHistory.buildOriginPairAuthority,
    buildIdHistoryAuthority: buildHistory.buildIdHistoryAuthority,
  });
  const executionQueue = researchBeforeGoal ? milestoneQueue : projectQueue;
  const queueApproval = createQueueApproval({
    queue: executionQueue,
    verifiedBuildApproval: receipt,
  });
  const coordinator = createBuildQueueCoordinator({
    queue: executionQueue,
    verifiedBuildApproval: receipt,
    queueApproval,
  });
  return {
    root,
    projectPath,
    milestonePath,
    milestonePhaseDag,
    draft,
    projectDirectory,
    projectOrigin,
    milestoneOrigin,
    projectCapture,
    milestoneCapture,
    ...buildHistory,
    repositoryBaselineDigest,
    approvalSelection,
    approval,
    receipt,
    approvalReadiness: readinessAuthority,
    queueApproval,
    coordinator,
    projectQueue,
    milestoneQueue,
  };
}

const fixturePromise = approvedFixture();

function evidence(id, { supports = [], final = false } = {}) {
  const item = createEvidenceItem({
    id,
    gate: 'mandatory',
    scope: final ? 'final_verification' : 'task',
    status: 'PASS',
    performed: true,
    procedure: 'Run the focused deterministic verification.',
    command: 'node --test tests/focused.test.mjs',
    expected: 'The focused contract passes.',
    actual: 'The focused contract passed with exit status zero.',
    identity: IDENTITY,
    startedAt: NOW,
    finishedAt: LATER,
    supports,
    sideEffects: [],
  });
  return createEvidenceRecord({
    runId: `run-${id}`,
    recordedAt: LATER,
    items: [item],
    finalVerification: final ? {
      verifier: 'fresh queue closeout verifier',
      performedAt: LATER,
      originCompared: true,
      normalizedContractCompared: true,
      actualChangesOrOutputsCompared: true,
      taskCompletionOnly: false,
      evidenceIds: [id],
    } : null,
  });
}

function childOrigin(queue, itemId) {
  const item = queue.items.find(({ id }) => id === itemId);
  return createQueueChildOrigin({
    queue,
    queueItemId: itemId,
    inheritedOutcome: item.purpose,
    narrowedOutcome: item.scope,
    permittedChanges: item.permitted_changes,
    prohibitedChanges: item.prohibited_changes,
  });
}

async function manualAdmission(
  fixture,
  coordinator,
  state,
  itemId,
  {
    broker = null,
    researchReconciliation = null,
    inlineSemantic = false,
    interactionSuffix = 'primary',
  } = {},
) {
  const baselineAttestation = attestCurrentBuildQueueBaseline(coordinator, state, {
    itemId,
    verifiedArtifactSnapshot: await verifyBuildApprovalArtifacts({
      root: fixture.root,
      verifiedBuildApproval: coordinator.verified_build_approval,
      now: NOW,
    }),
    observation: {
      kind: 'host_repository_baseline_observation',
      source: 'deterministic_repository_probe',
      baseline_digest: state.expected_repository_baseline_digest,
      cruise_paths_excluded: true,
      observed_at: NOW,
    },
  });
  const skill = coordinator.queue.items.find(({ id }) => id === itemId).skill;
  const interactionBroker = broker ?? createBuildQueueHostInteractionBroker({
    coordinator,
    sessionId: `test-session-${itemId}-${state.revision}-${interactionSuffix}`,
    runId: `test-run-${itemId}-${state.revision}-${interactionSuffix}`,
  });
  const semanticReceipt = interactionBroker.observeSemanticAdmission(state, {
    kind: 'host_queue_semantic_admission_event',
    source: 'cruise_router_and_permission_gate',
    interaction_id: `semantic-${itemId}-${state.revision}-${interactionSuffix}`,
    queue_item_id: itemId,
    skill,
    accepted: true,
    permissions_satisfied: true,
    authentication_satisfied: true,
    host_continuation_supported: true,
    permission_envelope_sha256: coordinator.queue_approval.permission_envelope_sha256,
    observed_at: NOW,
  });
  const semanticAdmission = attestBuildQueueSemanticAdmission(
    coordinator,
    state,
    semanticReceipt,
  );
  const selectionReceipt = interactionBroker.observeManualStartSelection(state, {
    kind: 'host_queue_start_event',
    source: 'request_user_input',
    input_kind: 'option_selection',
    queue_id: coordinator.queue_id,
    queue_item_id: itemId,
    interaction_id: `start-${itemId}-${state.revision}-${interactionSuffix}`,
    option_id: `start_${itemId.toLowerCase()}`,
    selected_label: `Start ${itemId}`,
    selected_at: NOW,
    offered_options: [{ id: `start_${itemId.toLowerCase()}`, label: `Start ${itemId}` }],
    ...(inlineSemantic ? { semantic_admission: { accepted: true, skill } } : {}),
  });
  return attestManualBuildQueueStart(coordinator, state, selectionReceipt, {
    baselineAttestation,
    semanticAdmission,
    researchReconciliation,
  });
}

function baselineTransition(coordinator, state, itemId, afterDigest) {
  const runtime = state.items.find(({ id }) => id === itemId);
  return attestBuildQueueBaselineTransition(coordinator, state, {
    kind: 'host_repository_baseline_transition_event',
    source: 'deterministic_repository_probe',
    queue_item_id: itemId,
    attempt_id: runtime.active_attempt.attempt_id,
    before_digest: state.expected_repository_baseline_digest,
    after_digest: afterDigest,
    cruise_paths_excluded: true,
    observed_at: LATER,
  });
}

function closeout(coordinator, state, itemId, record, outputs, criteria = []) {
  const runtime = state.items.find(({ id }) => id === itemId);
  return {
    kind: 'cruise_queue_child_closeout',
    queue_id: coordinator.queue_id,
    queue_item_id: itemId,
    skill: coordinator.queue.items.find(({ id }) => id === itemId).skill,
    attempt_id: runtime.active_attempt.attempt_id,
    outcome: 'completed',
    child_origin_sha256: runtime.active_attempt.child_origin_sha256,
    result_sha256: DIGEST_D,
    outputs,
    acceptance_criteria: criteria,
    evidence_ids: record.items.map(({ id }) => id),
    evidence_record_digests: [evidenceDigest(record)],
    completed_at: LATER,
  };
}

async function startRoot(fixture, coordinator, state, itemId, evidenceId = 'E-01') {
  const admission = await manualAdmission(fixture, coordinator, state, itemId);
  return {
    admission,
    state: transitionBuildQueueItem(coordinator, state, {
      itemId,
      toStatus: 'running',
      evidence: [evidence(evidenceId)],
      childOrigin: childOrigin(coordinator.queue, itemId),
      startAdmission: admission,
      consumedInputs: [],
    }, { now: NOW }),
  };
}

test('authority requires opaque Build receipt plus queue approval and accepts approved phase coverage', async () => {
  const fixture = await fixturePromise;
  assert.throws(() => createBuildQueueCoordinator({
    queue: fixture.projectQueue,
    verifiedBuildApproval: structuredClone(fixture.receipt),
    queueApproval: fixture.queueApproval,
  }), /verifier-branded/);
  assert.throws(() => createBuildQueueCoordinator({
    queue: fixture.projectQueue,
    queueApproval: fixture.queueApproval,
  }), /verifier-branded/);
  const milestoneApproval = createQueueApproval({
    queue: fixture.milestoneQueue,
    verifiedBuildApproval: fixture.receipt,
  });
  const milestoneCoordinator = createBuildQueueCoordinator({
    queue: fixture.milestoneQueue,
    verifiedBuildApproval: fixture.receipt,
    queueApproval: milestoneApproval,
  });
  assert.equal(milestoneCoordinator.queue_id, 'QUEUE-M-003');
  assert.throws(
    () => initializeBuildQueueState(structuredClone(fixture.coordinator)),
    /opaque private Build coordinator/,
  );
});

test('start requires fresh baseline verification and a one-use opaque admission', async () => {
  const fixture = await fixturePromise;
  const state = initializeBuildQueueState(fixture.coordinator, { now: NOW });
  assert.throws(() => transitionBuildQueueItem(fixture.coordinator, state, {
    itemId: 'QI-01',
    toStatus: 'running',
    evidence: [evidence('E-01')],
    childOrigin: childOrigin(fixture.projectQueue, 'QI-01'),
  }), /opaque one-use start admission/);
  const artifactSnapshot = await verifyBuildApprovalArtifacts({
    root: fixture.root,
    verifiedBuildApproval: fixture.receipt,
    now: NOW,
  });
  const lockedMilestonePath = join(
    fixture.root,
    fixture.milestonePath,
    'MILESTONE.md',
  );
  const lockedMilestoneBytes = await readFile(lockedMilestonePath);
  await writeFile(
    lockedMilestonePath,
    Buffer.concat([lockedMilestoneBytes, Buffer.from('\npost-snapshot drift\n')]),
  );
  assert.throws(
    () => attestCurrentBuildQueueBaseline(fixture.coordinator, state, {
      itemId: 'QI-03',
      verifiedArtifactSnapshot: artifactSnapshot,
      observation: {
        kind: 'host_repository_baseline_observation',
        source: 'deterministic_repository_probe',
        baseline_digest: fixture.repositoryBaselineDigest,
        cruise_paths_excluded: true,
        observed_at: NOW,
      },
    }),
    /locked Build artifact .* is stale or unsafe/u,
  );
  await writeFile(lockedMilestonePath, lockedMilestoneBytes);
  const baseline = attestCurrentBuildQueueBaseline(fixture.coordinator, state, {
    itemId: 'QI-03',
    verifiedArtifactSnapshot: artifactSnapshot,
    observation: {
      kind: 'host_repository_baseline_observation',
      source: 'deterministic_repository_probe',
      baseline_digest: fixture.repositoryBaselineDigest,
      cruise_paths_excluded: true,
      observed_at: NOW,
    },
  });
  assert.throws(() => attestCurrentBuildQueueBaseline(fixture.coordinator, state, {
    itemId: 'QI-04',
    verifiedArtifactSnapshot: artifactSnapshot,
    observation: {
      kind: 'host_repository_baseline_observation',
      source: 'deterministic_repository_probe',
      baseline_digest: fixture.repositoryBaselineDigest,
      cruise_paths_excluded: true,
      observed_at: NOW,
    },
  }), /snapshot has already been consumed/);
  const autoBroker = createBuildQueueHostInteractionBroker({
    coordinator: fixture.coordinator,
    sessionId: 'auto-semantic-session',
    runId: 'auto-semantic-run',
  });
  const autoSemanticReceipt = autoBroker.observeSemanticAdmission(state, {
    kind: 'host_queue_semantic_admission_event',
    source: 'cruise_router_and_permission_gate',
    interaction_id: 'auto-semantic-QI-03',
    queue_item_id: 'QI-03',
    skill: 'research',
    accepted: true,
    permissions_satisfied: true,
    authentication_satisfied: true,
    host_continuation_supported: true,
    permission_envelope_sha256: fixture.queueApproval.permission_envelope_sha256,
    observed_at: NOW,
  });
  assert.throws(
    () => attestBuildQueueSemanticAdmission(
      fixture.coordinator,
      state,
      structuredClone(autoSemanticReceipt),
    ),
    /opaque host-broker receipt/u,
  );
  assert.throws(
    () => attestBuildQueueSemanticAdmission(fixture.coordinator, state, {
      kind: 'host_queue_semantic_admission_event',
      source: 'cruise_router_and_permission_gate',
      interaction_id: 'caller-authored-semantic-event',
      queue_item_id: 'QI-03',
      skill: 'research',
      accepted: true,
      permissions_satisfied: true,
      authentication_satisfied: true,
      host_continuation_supported: true,
      permission_envelope_sha256: fixture.queueApproval.permission_envelope_sha256,
      observed_at: NOW,
    }),
    /opaque host-broker receipt/u,
  );
  assert.throws(
    () => attestManualBuildQueueStart(fixture.coordinator, state, {
      kind: 'host_queue_start_event',
      source: 'request_user_input',
      input_kind: 'option_selection',
      queue_id: fixture.coordinator.queue_id,
      queue_item_id: 'QI-03',
      interaction_id: 'caller-authored-manual-event',
      option_id: 'start_qi-03',
      selected_label: 'Start QI-03',
      selected_at: NOW,
      offered_options: [{ id: 'start_qi-03', label: 'Start QI-03' }],
    }),
    /opaque host-broker option receipt/u,
  );
  const autoSemanticAdmission = attestBuildQueueSemanticAdmission(
    fixture.coordinator,
    state,
    autoSemanticReceipt,
  );
  await writeFile(
    lockedMilestonePath,
    Buffer.concat([lockedMilestoneBytes, Buffer.from('\npost-baseline auto-start drift\n')]),
  );
  try {
    assert.throws(() => authorizeAutomaticBuildQueueStart(fixture.coordinator, state, {
      itemId: 'QI-03',
      baselineAttestation: baseline,
      semanticAdmission: autoSemanticAdmission,
      observedConditions: ['host_ready'],
    }), /locked Build artifact .* is stale or unsafe/u);
  } finally {
    await writeFile(lockedMilestonePath, lockedMilestoneBytes);
  }
  const autoProductDriftPath = join(fixture.root, 'post-baseline-auto-drift.mjs');
  await writeFile(autoProductDriftPath, 'export const postBaselineAutoDrift = true;\n');
  try {
    assert.throws(() => authorizeAutomaticBuildQueueStart(fixture.coordinator, state, {
      itemId: 'QI-03',
      baselineAttestation: baseline,
      semanticAdmission: autoSemanticAdmission,
      observedConditions: ['host_ready'],
    }), /current repository product baseline differs at the final start boundary/u);
  } finally {
    await rm(autoProductDriftPath, { force: true });
  }
  const auto = authorizeAutomaticBuildQueueStart(fixture.coordinator, state, {
    itemId: 'QI-03',
    baselineAttestation: baseline,
    semanticAdmission: autoSemanticAdmission,
    observedConditions: ['host_ready'],
  });
  assert.equal(auto.source, 'verified_auto_start');
  assert.throws(() => authorizeAutomaticBuildQueueStart(fixture.coordinator, state, {
    itemId: 'QI-03',
    baselineAttestation: baseline,
    semanticAdmission: {},
  }), /already been consumed|semantic/);

  const manualArtifactSnapshot = await verifyBuildApprovalArtifacts({
    root: fixture.root,
    verifiedBuildApproval: fixture.receipt,
    now: NOW,
  });
  const manualBaseline = attestCurrentBuildQueueBaseline(fixture.coordinator, state, {
    itemId: 'QI-04',
    verifiedArtifactSnapshot: manualArtifactSnapshot,
    observation: {
      kind: 'host_repository_baseline_observation',
      source: 'deterministic_repository_probe',
      baseline_digest: fixture.repositoryBaselineDigest,
      cruise_paths_excluded: true,
      observed_at: NOW,
    },
  });
  const manualBoundaryBroker = createBuildQueueHostInteractionBroker({
    coordinator: fixture.coordinator,
    sessionId: 'manual-final-boundary-session',
    runId: 'manual-final-boundary-run',
  });
  const manualSemanticReceipt = manualBoundaryBroker.observeSemanticAdmission(state, {
    kind: 'host_queue_semantic_admission_event',
    source: 'cruise_router_and_permission_gate',
    interaction_id: 'manual-final-boundary-semantic',
    queue_item_id: 'QI-04',
    skill: 'research',
    accepted: true,
    permissions_satisfied: true,
    authentication_satisfied: true,
    host_continuation_supported: true,
    permission_envelope_sha256: fixture.queueApproval.permission_envelope_sha256,
    observed_at: NOW,
  });
  const manualSemanticAdmission = attestBuildQueueSemanticAdmission(
    fixture.coordinator,
    state,
    manualSemanticReceipt,
  );
  const manualSelectionReceipt = manualBoundaryBroker.observeManualStartSelection(state, {
    kind: 'host_queue_start_event',
    source: 'request_user_input',
    input_kind: 'option_selection',
    queue_id: fixture.coordinator.queue_id,
    queue_item_id: 'QI-04',
    interaction_id: 'manual-final-boundary-selection',
    option_id: 'start_qi-04',
    selected_label: 'Start QI-04',
    selected_at: NOW,
    offered_options: [{ id: 'start_qi-04', label: 'Start QI-04' }],
  });
  await writeFile(
    lockedMilestonePath,
    Buffer.concat([lockedMilestoneBytes, Buffer.from('\npost-baseline manual-start drift\n')]),
  );
  try {
    assert.throws(() => attestManualBuildQueueStart(
      fixture.coordinator,
      state,
      manualSelectionReceipt,
      {
        baselineAttestation: manualBaseline,
        semanticAdmission: manualSemanticAdmission,
      },
    ), /locked Build artifact .* is stale or unsafe/u);
  } finally {
    await writeFile(lockedMilestonePath, lockedMilestoneBytes);
  }
  const manualProductDriftPath = join(fixture.root, 'post-baseline-manual-drift.mjs');
  await writeFile(manualProductDriftPath, 'export const postBaselineManualDrift = true;\n');
  try {
    assert.throws(() => attestManualBuildQueueStart(
      fixture.coordinator,
      state,
      manualSelectionReceipt,
      {
        baselineAttestation: manualBaseline,
        semanticAdmission: manualSemanticAdmission,
      },
    ), /current repository product baseline differs at the final start boundary/u);
  } finally {
    await rm(manualProductDriftPath, { force: true });
  }
  const manualBoundaryAdmission = attestManualBuildQueueStart(
    fixture.coordinator,
    state,
    manualSelectionReceipt,
    {
      baselineAttestation: manualBaseline,
      semanticAdmission: manualSemanticAdmission,
    },
  );
  assert.equal(manualBoundaryAdmission.source, 'host_manual_handoff');

  const started = await startRoot(fixture, fixture.coordinator, state, 'QI-01', 'E-02');
  assert.equal(started.state.items[0].attempts[0].event, 'started');
  assert.throws(() => transitionBuildQueueItem(fixture.coordinator, state, {
    itemId: 'QI-01',
    toStatus: 'running',
    evidence: [evidence('E-03')],
    childOrigin: childOrigin(fixture.projectQueue, 'QI-01'),
    startAdmission: started.admission,
    consumedInputs: [],
  }), /already been consumed/);

  const unsafeAdmission = await manualAdmission(
    fixture,
    fixture.coordinator,
    state,
    'QI-01',
  );
  const item = fixture.projectQueue.items.find(({ id }) => id === 'QI-01');
  assert.throws(() => createQueueChildOrigin({
    queue: fixture.projectQueue,
    queueItemId: 'QI-01',
    inheritedOutcome: item.purpose,
    narrowedOutcome: item.scope,
    permittedChanges: ['../escape.mjs'],
    prohibitedChanges: item.prohibited_changes,
  }), /safe repository-relative POSIX path/);
  assert.throws(() => createQueueChildOrigin({
    queue: fixture.projectQueue,
    queueItemId: 'QI-01',
    inheritedOutcome: 'Caller-invented outcome',
    narrowedOutcome: item.scope,
    permittedChanges: item.permitted_changes,
    prohibitedChanges: item.prohibited_changes,
  }), /outcomes must exactly match/);
  const unsafeOrigin = structuredClone(childOrigin(fixture.projectQueue, 'QI-01'));
  unsafeOrigin.scope.permitted_changes.push('src/unapproved.mjs');
  assert.throws(() => transitionBuildQueueItem(fixture.coordinator, state, {
    itemId: 'QI-01',
    toStatus: 'running',
    evidence: [evidence('E-04')],
    childOrigin: unsafeOrigin,
    startAdmission: unsafeAdmission,
    consumedInputs: [],
  }), /path envelope differs from its locked queue item/);
});

test('completion is started/closeout/PASS/baseline bound and attempts remain append-only', async () => {
  const fixture = await fixturePromise;
  const initial = initializeBuildQueueState(fixture.coordinator, { now: NOW });
  assert.throws(
    () => buildQueueCompletionStatus(fixture.coordinator, structuredClone(initial)),
    /opaque reducer state/,
  );
  assert.throws(() => transitionBuildQueueItem(fixture.coordinator, initial, {
    itemId: 'QI-02',
    toStatus: 'completed',
    evidence: [evidence('E-01', { final: true })],
  }), /illegal queue status transition queued -> completed/);
  const started = await startRoot(fixture, fixture.coordinator, initial, 'QI-01', 'E-01');
  const firstEvent = structuredClone(started.state.items[0].attempts[0]);
  const proof = evidence('E-02', { final: true });
  const transition = baselineTransition(fixture.coordinator, started.state, 'QI-01', DIGEST_B);
  const completed = transitionBuildQueueItem(fixture.coordinator, started.state, {
    itemId: 'QI-01',
    toStatus: 'completed',
    evidence: [proof],
    childCloseout: closeout(fixture.coordinator, started.state, 'QI-01', proof, [
      { name: 'artifact-QI-01', sha256: DIGEST_C },
    ]),
    baselineTransition: transition,
  }, { now: LATER });
  const runtime = completed.items.find(({ id }) => id === 'QI-01');
  assert.deepEqual(runtime.attempts[0], firstEvent);
  assert.equal(runtime.attempts[1].event, 'completed');
  assert.equal(completed.expected_repository_baseline_digest, DIGEST_B);
  assert.equal(buildQueueCompletionStatus(fixture.coordinator, completed).status, 'in_progress');
  const reconciled = reconcileBuildQueueState(fixture.coordinator, completed, { now: LATER });
  assert.equal(reconciled.items.find(({ id }) => id === 'QI-02').status, 'ready');
});

test('runtime dataflow requires exact predecessor closeout bytes', async () => {
  const fixture = await fixturePromise;
  let state = initializeBuildQueueState(fixture.coordinator, { now: NOW });
  state = (await startRoot(fixture, fixture.coordinator, state, 'QI-01', 'E-10')).state;
  const proof = evidence('E-11', { final: true });
  state = transitionBuildQueueItem(fixture.coordinator, state, {
    itemId: 'QI-01',
    toStatus: 'completed',
    evidence: [proof],
    childCloseout: closeout(fixture.coordinator, state, 'QI-01', proof, [
      { name: 'artifact-QI-01', sha256: DIGEST_C },
    ]),
    baselineTransition: baselineTransition(
      fixture.coordinator,
      state,
      'QI-01',
      state.expected_repository_baseline_digest,
    ),
  });
  state = reconcileBuildQueueState(fixture.coordinator, state, { now: LATER });
  const admission = await manualAdmission(fixture, fixture.coordinator, state, 'QI-02');
  const input = { name: 'artifact-QI-01', sha256: DIGEST_D, producer_item_id: 'QI-01' };
  assert.throws(() => transitionBuildQueueItem(fixture.coordinator, state, {
    itemId: 'QI-02',
    toStatus: 'running',
    evidence: [evidence('E-12')],
    childOrigin: childOrigin(fixture.projectQueue, 'QI-02'),
    startAdmission: admission,
    consumedInputs: [input],
  }), /bytes do not match/);
  const running = transitionBuildQueueItem(fixture.coordinator, state, {
    itemId: 'QI-02',
    toStatus: 'running',
    evidence: [evidence('E-12')],
    childOrigin: childOrigin(fixture.projectQueue, 'QI-02'),
    startAdmission: admission,
    consumedInputs: [{ ...input, sha256: DIGEST_C }],
  });
  assert.deepEqual(running.items.find(({ id }) => id === 'QI-02').active_attempt.consumed_inputs, [
    { name: 'artifact-QI-01', sha256: DIGEST_C, producer_item_id: 'QI-01' },
  ]);
});

test('Research-dependent Goal start requires exact one-use reconciliation authority', async () => {
  const fixture = await approvedFixture({ researchBeforeGoal: true });
  let state = initializeBuildQueueState(fixture.coordinator, { now: NOW });
  state = (await startRoot(
    fixture,
    fixture.coordinator,
    state,
    'QI-01',
    'E-80',
  )).state;
  const researchProof = evidence('E-81', { final: true });
  state = transitionBuildQueueItem(fixture.coordinator, state, {
    itemId: 'QI-01',
    toStatus: 'completed',
    evidence: [researchProof],
    childCloseout: closeout(
      fixture.coordinator,
      state,
      'QI-01',
      researchProof,
      [{ name: 'research-brief', sha256: DIGEST_C }],
    ),
    baselineTransition: baselineTransition(
      fixture.coordinator,
      state,
      'QI-01',
      state.expected_repository_baseline_digest,
    ),
  }, { now: LATER });
  state = reconcileBuildQueueState(fixture.coordinator, state, { now: LATER });
  assert.equal(state.items.find(({ id }) => id === 'QI-02').status, 'ready');

  await assert.rejects(
    manualAdmission(fixture, fixture.coordinator, state, 'QI-02'),
    /one-use opaque reconciliation authority/u,
  );

  const reconciliationEvent = {
    kind: 'host_queue_research_reconciliation_event',
    source: 'cruise_research_reconciliation_gate',
    interaction_id: 'research-reconciliation-QI-02-primary',
    goal_item_id: 'QI-02',
    research_outputs: [{
      queue_item_id: 'QI-01',
      name: 'research-brief',
      sha256: DIGEST_C,
    }],
    conclusions: {
      milestone_requirements: 'consistent',
      phase_scope: 'consistent',
      architecture: 'consistent',
      permissions: 'consistent',
      acceptance_criteria: 'consistent',
    },
    invalidates_approved_assumption: false,
    contract_revision_required: false,
    reconciled_at: LATER,
  };
  const reconciliationBroker = createBuildQueueHostInteractionBroker({
    coordinator: fixture.coordinator,
    sessionId: 'research-reconciliation-session',
    runId: 'research-reconciliation-run',
  });
  assert.throws(
    () => reconciliationBroker.observeResearchReconciliation(state, {
        ...reconciliationEvent,
        interaction_id: 'research-reconciliation-QI-02-conflict',
        conclusions: {
          ...reconciliationEvent.conclusions,
          architecture: 'conflict',
        },
        invalidates_approved_assumption: true,
        contract_revision_required: true,
      }),
    /Build contract revision is required/u,
  );
  assert.throws(
    () => attestBuildQueueResearchReconciliation(
      fixture.coordinator,
      state,
      reconciliationEvent,
    ),
    /opaque host-broker receipt/u,
  );
  const reconciliationReceipt = reconciliationBroker.observeResearchReconciliation(
    state,
    reconciliationEvent,
  );
  const reconciliation = attestBuildQueueResearchReconciliation(
    fixture.coordinator,
    state,
    reconciliationReceipt,
  );
  await assert.rejects(
    manualAdmission(fixture, fixture.coordinator, state, 'QI-02', {
      broker: reconciliationBroker,
      researchReconciliation: reconciliation,
      inlineSemantic: true,
      interactionSuffix: 'inline-rejected',
    }),
    /fields must be exactly|exact structured option/u,
  );
  const admission = await manualAdmission(
    fixture,
    fixture.coordinator,
    state,
    'QI-02',
    {
      broker: reconciliationBroker,
      researchReconciliation: reconciliation,
      interactionSuffix: 'accepted',
    },
  );
  await assert.rejects(
    manualAdmission(fixture, fixture.coordinator, state, 'QI-02', {
      broker: reconciliationBroker,
      researchReconciliation: reconciliation,
      interactionSuffix: 'replay',
    }),
    /one-use opaque reconciliation authority/u,
  );
  const running = transitionBuildQueueItem(fixture.coordinator, state, {
    itemId: 'QI-02',
    toStatus: 'running',
    evidence: [evidence('E-82')],
    childOrigin: childOrigin(fixture.milestoneQueue, 'QI-02'),
    startAdmission: admission,
    consumedInputs: [{
      name: 'research-brief',
      sha256: DIGEST_C,
      producer_item_id: 'QI-01',
    }],
  }, { now: LATER });
  assert.equal(running.items.find(({ id }) => id === 'QI-02').status, 'running');
});

test('bounded independent read-only Research items may run concurrently', async () => {
  const fixture = await fixturePromise;
  let state = initializeBuildQueueState(fixture.coordinator, { now: NOW });
  for (const [itemId, evidenceId] of [['QI-03', 'E-50'], ['QI-04', 'E-51']]) {
    const admission = await manualAdmission(fixture, fixture.coordinator, state, itemId);
    state = transitionBuildQueueItem(fixture.coordinator, state, {
      itemId,
      toStatus: 'running',
      evidence: [evidence(evidenceId)],
      childOrigin: childOrigin(fixture.projectQueue, itemId),
      startAdmission: admission,
      consumedInputs: [],
    });
  }
  assert.deepEqual(
    state.items.filter(({ active_attempt: active }) => active != null).map(({ id }) => id),
    ['QI-03', 'QI-04'],
  );
  const productAdmission = await manualAdmission(fixture, fixture.coordinator, state, 'QI-01');
  assert.throws(() => transitionBuildQueueItem(fixture.coordinator, state, {
    itemId: 'QI-01',
    toStatus: 'running',
    evidence: [evidence('E-52')],
    childOrigin: childOrigin(fixture.projectQueue, 'QI-01'),
    startAdmission: productAdmission,
    consumedInputs: [],
  }), /parallel start.*Research/);
  const proof = evidence('E-53', { final: true });
  const completed = transitionBuildQueueItem(fixture.coordinator, state, {
    itemId: 'QI-03',
    toStatus: 'completed',
    evidence: [proof],
    childCloseout: closeout(fixture.coordinator, state, 'QI-03', proof, [
      { name: 'artifact-QI-03', sha256: DIGEST_C },
    ]),
    baselineTransition: baselineTransition(
      fixture.coordinator,
      state,
      'QI-03',
      fixture.repositoryBaselineDigest,
    ),
  });
  assert.equal(completed.expected_repository_baseline_digest, fixture.repositoryBaselineDigest);
  assert.equal(completed.items.find(({ id }) => id === 'QI-04').status, 'running');
});

test('disjoint read-only Research concurrency has no hidden numeric ceiling', async () => {
  const fixture = await approvedFixture({ extraResearchCount: 5 });
  let state = initializeBuildQueueState(fixture.coordinator, { now: NOW });
  const researchIds = Array.from(
    { length: 7 },
    (_entry, index) => `QI-${String(index + 3).padStart(2, '0')}`,
  );
  for (const [index, itemId] of researchIds.entries()) {
    const admission = await manualAdmission(fixture, fixture.coordinator, state, itemId);
    state = transitionBuildQueueItem(fixture.coordinator, state, {
      itemId,
      toStatus: 'running',
      evidence: [evidence(`E-${String(index + 60).padStart(2, '0')}`)],
      childOrigin: childOrigin(fixture.projectQueue, itemId),
      startAdmission: admission,
      consumedInputs: [],
    });
  }
  assert.deepEqual(
    state.items.filter(({ active_attempt: active }) => active != null).map(({ id }) => id),
    researchIds,
  );
});

test('auth waits block only dependent branches and global evidence IDs cannot be reused', async () => {
  const fixture = await fixturePromise;
  const initial = initializeBuildQueueState(fixture.coordinator, { now: NOW });
  const waiting = transitionBuildQueueItem(fixture.coordinator, initial, {
    itemId: 'QI-01',
    toStatus: 'waiting_auth',
    evidence: [evidence('E-20')],
    blockers: ['authentication_required'],
  });
  const reconciled = reconcileBuildQueueState(fixture.coordinator, waiting, { now: LATER });
  assert.equal(reconciled.items.find(({ id }) => id === 'QI-02').status, 'queued');
  assert.equal(reconciled.items.find(({ id }) => id === 'QI-03').status, 'ready');
});

test('advisory evidence cannot satisfy a locked phase acceptance criterion', async () => {
  const fixture = await fixturePromise;
  const queueApproval = createQueueApproval({
    queue: fixture.milestoneQueue,
    verifiedBuildApproval: fixture.receipt,
  });
  const coordinator = createBuildQueueCoordinator({
    queue: fixture.milestoneQueue,
    verifiedBuildApproval: fixture.receipt,
    queueApproval,
  });
  let state = initializeBuildQueueState(coordinator, { now: NOW });
  const admission = await manualAdmission(fixture, coordinator, state, 'QI-01');
  state = transitionBuildQueueItem(coordinator, state, {
    itemId: 'QI-01',
    toStatus: 'running',
    evidence: [evidence('E-40')],
    childOrigin: childOrigin(fixture.milestoneQueue, 'QI-01'),
    startAdmission: admission,
    consumedInputs: [],
  });
  const advisory = createEvidenceItem({
    id: 'E-41',
    gate: 'advisory',
    scope: 'task',
    status: 'PASS',
    performed: true,
    procedure: 'Inspect a non-authoritative proxy for AC-01.',
    command: null,
    expected: 'The proxy looks plausible.',
    actual: 'The proxy looked plausible but did not verify the locked criterion.',
    identity: IDENTITY,
    startedAt: NOW,
    finishedAt: LATER,
    supports: ['AC-01'],
    sideEffects: [],
  });
  const final = createEvidenceItem({
    id: 'E-42',
    gate: 'mandatory',
    scope: 'final_verification',
    status: 'PASS',
    performed: true,
    procedure: 'Perform final verification unrelated to AC-01.',
    command: null,
    expected: 'The unrelated invariant passes.',
    actual: 'The unrelated invariant passed.',
    identity: IDENTITY,
    startedAt: NOW,
    finishedAt: LATER,
    supports: ['R-01'],
    sideEffects: [],
  });
  const record = createEvidenceRecord({
    runId: 'run-advisory-ac',
    recordedAt: LATER,
    items: [advisory, final],
    finalVerification: {
      verifier: 'fresh verifier',
      performedAt: LATER,
      originCompared: true,
      normalizedContractCompared: true,
      actualChangesOrOutputsCompared: true,
      taskCompletionOnly: false,
      evidenceIds: ['E-42'],
    },
  });
  const invalidCloseout = closeout(coordinator, state, 'QI-01', record, [
    { name: 'phase-output', sha256: DIGEST_C },
  ], [{ id: 'AC-01', evidence_ids: ['E-41'] }]);
  assert.throws(() => transitionBuildQueueItem(coordinator, state, {
    itemId: 'QI-01',
    toStatus: 'completed',
    evidence: [record],
    childCloseout: invalidCloseout,
    baselineTransition: baselineTransition(coordinator, state, 'QI-01', DIGEST_B),
  }), /performed mandatory PASS/);
});

test('mandatory unknown failure blocks and Debug requires Q2 reapproval plus migration', async () => {
  const fixture = await fixturePromise;
  const initial = initializeBuildQueueState(fixture.coordinator, { now: NOW });
  let failed = (await startRoot(fixture, fixture.coordinator, initial, 'QI-01', 'E-30')).state;
  failed = transitionBuildQueueItem(fixture.coordinator, failed, {
    itemId: 'QI-01',
    toStatus: 'failed',
    evidence: [evidence('E-31')],
    failure: { classification: 'unknown_cause', summary: 'Observed failure has no known cause.' },
    baselineTransition: baselineTransition(
      fixture.coordinator,
      failed,
      'QI-01',
      fixture.repositoryBaselineDigest,
    ),
  });
  assert.deepEqual(buildQueueCompletionStatus(fixture.coordinator, failed), {
    status: 'blocked',
    blocking_items: ['QI-01'],
  });
  const originalDigest = workflowQueueDigest(fixture.projectQueue);
  const revision = createReactiveDebugQueueRevision(fixture.coordinator, failed, {
    failedItemId: 'QI-01',
    purpose: 'Determine the unknown QI-01 root cause.',
    scope: 'Diagnose only the recorded QI-01 failure.',
    produces: ['diagnosis-QI-01'],
  });
  assert.equal(revision.approved, false);
  assert.equal(workflowQueueDigest(fixture.projectQueue), originalDigest);
  assert.equal(fixture.projectQueue.items.some(({ skill }) => skill === 'debug'), false);
  const debug = revision.queue.items.find(({ skill }) => skill === 'debug');
  assert.deepEqual(debug.requires, []);
  assert.deepEqual(debug.consumes, [revision.trigger.failure_artifact]);
  const retry = revision.queue.items.find(({ id }) => id === 'QI-01');
  assert.deepEqual(debug.permitted_changes, retry.permitted_changes);
  assert.deepEqual(debug.prohibited_changes, retry.prohibited_changes);
  assert.throws(() => debug.permitted_changes.push('src/unapproved.mjs'), TypeError);
  assert.equal(retry.requires.includes(debug.id), true);
  assert.equal(retry.consumes.includes('diagnosis-QI-01'), true);
  assert.throws(() => createBuildQueueCoordinator({
    queue: revision.queue,
    verifiedBuildApproval: fixture.receipt,
    queueApproval: fixture.queueApproval,
    reactiveDebugRevision: revision,
  }), /not present|definition changed/);

  await writeFile(join(fixture.projectDirectory, 'QUEUE.yaml'), stringifyYaml(revision.queue));
  const revisedBuildHistory = await reconcileBuildHistoryAuthorities({
    root: fixture.root,
    projectCapture: fixture.projectCapture,
    buildOriginPairAuthority: fixture.buildOriginPairAuthority,
    currentRegistry: fixture.idRegistry,
    milestonePath: fixture.milestonePath,
    at: LATER,
  });
  const reapprovalReadiness = approvalReadiness({
    root: fixture.root,
    projectOrigin: fixture.projectOrigin,
    milestoneOrigin: fixture.milestoneOrigin,
    repositoryBaselineDigest: fixture.repositoryBaselineDigest,
    interaction: 'q2-reapproval',
  });
  await writeFile(join(fixture.projectDirectory, 'STATE.yaml'), stringifyYaml(projectState({
    repositoryBaselineDigest: fixture.repositoryBaselineDigest,
    readinessDigest: reapprovalReadiness.readiness_digest,
    originSha256: bytesDigest(fixture.projectOrigin),
    contractDigest: fixture.draft.project_contract_digest,
    queue: revision.queue,
    reconciledAt: LATER,
  })));
  await writeFile(
    join(fixture.root, fixture.milestonePath, 'STATE.yaml'),
    stringifyYaml(milestoneState({
      repositoryBaselineDigest: fixture.repositoryBaselineDigest,
      readinessDigest: reapprovalReadiness.readiness_digest,
      originSha256: bytesDigest(fixture.milestoneOrigin),
      contractDigest: fixture.draft.build_contract_digest,
      queue: fixture.milestoneQueue,
      reconciledAt: LATER,
    })),
  );
  const reapprovalReview = await prepareBuildApprovalReview({
    root: fixture.root,
    mode: 'bootstrap',
    contractDirectory: fixture.projectPath,
    firstMilestoneDirectory: fixture.milestonePath,
    milestonePhaseDag: fixture.milestonePhaseDag,
    repositoryBaselineDigest: fixture.repositoryBaselineDigest,
    approvalReadiness: reapprovalReadiness,
    buildOriginPairAuthority: revisedBuildHistory.buildOriginPairAuthority,
    buildIdHistoryAuthority: revisedBuildHistory.buildIdHistoryAuthority,
  });
  const reapprovalSelection = selection(
    'foundation-reapproval-q2',
    reapprovalReview.review_digest,
  );
  const approval = await captureBuildApproval({
    root: fixture.root,
    mode: 'bootstrap',
    contractDirectory: fixture.projectPath,
    firstMilestoneDirectory: fixture.milestonePath,
    milestonePhaseDag: fixture.milestonePhaseDag,
    approvalSelection: reapprovalSelection,
    approvalReadiness: reapprovalReadiness,
    repositoryBaselineDigest: fixture.repositoryBaselineDigest,
    buildOriginPairAuthority: revisedBuildHistory.buildOriginPairAuthority,
    buildIdHistoryAuthority: revisedBuildHistory.buildIdHistoryAuthority,
    now: LATER,
  });
  const receipt = await verifyBuildApproval({
    root: fixture.root,
    approval,
    approvalSelection: reapprovalSelection,
    currentRepositoryBaselineDigest: fixture.repositoryBaselineDigest,
    buildOriginPairAuthority: revisedBuildHistory.buildOriginPairAuthority,
    buildIdHistoryAuthority: revisedBuildHistory.buildIdHistoryAuthority,
  });
  const queueApproval = createQueueApproval({ queue: revision.queue, verifiedBuildApproval: receipt });
  assert.throws(() => createBuildQueueCoordinator({
    queue: revision.queue,
    verifiedBuildApproval: receipt,
    queueApproval,
  }), /requires its opaque Q2 revision authority/);
  const coordinator = createBuildQueueCoordinator({
    queue: revision.queue,
    verifiedBuildApproval: receipt,
    queueApproval,
    reactiveDebugRevision: revision,
  });
  const migrated = migrateReactiveDebugQueueRevision(
    fixture.coordinator,
    failed,
    revision,
    coordinator,
    { now: LATER },
  );
  assert.equal(migrated.items.find(({ id }) => id === debug.id).status, 'ready');
  assert.equal(migrated.items.find(({ id }) => id === 'QI-01').status, 'queued');
  assert.deepEqual(
    migrated.items.find(({ id }) => id === 'QI-01').attempts,
    failed.items.find(({ id }) => id === 'QI-01').attempts,
  );
  assert.equal(failed.items.find(({ id }) => id === 'QI-01').status, 'failed');
});
