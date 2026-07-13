import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

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
  createMilestoneControllerInteractionBroker,
  createMilestoneControllerState,
  dangerousAuthorizationToken,
  establishMilestoneControllerAuthority,
  establishMilestoneControllerGoalActivation,
  inspectMilestoneController,
  issueDangerousAuthorizationChallenge,
  loadMilestoneControllerState,
  milestoneContractDigest,
  parseMilestoneController,
  pauseMilestoneControllerForQuestion,
  persistMilestoneControllerState,
  reopenMilestoneControllerQuestion,
  stopMilestoneControllerPhase,
  validateDangerousQuestionSuppression,
  validateMilestoneControllerState,
} from '../scripts/lib/milestone-controller.mjs';
import {
  attestBuildApprovalReadiness,
  attestStructuredBuildApprovalSelection,
  captureBuildApproval,
  createWorkflowQueue,
  prepareBuildApprovalReview,
  prepareBuildContractDigests,
  READINESS_CATEGORIES,
  verifyBuildApproval,
} from '../scripts/lib/build-contract.mjs';
import { createEvidenceItem, createEvidenceRecord } from '../scripts/lib/evidence.mjs';
import {
  activateApprovedGoal,
  buildGoalObjective,
  captureGoalApproval,
  capturePlanApproval,
  captureRepositoryBaseline,
  inspectApprovedArtifacts,
  verifyGoalApproval,
} from '../scripts/lib/goal-contract.mjs';
import { createOriginRecord } from '../scripts/lib/origin.mjs';
import { captureInitialBuildOrigin } from '../scripts/lib/build-history.mjs';
import {
  createDeterministicProbe,
  deterministicProbeDigest,
} from '../scripts/lib/routing.mjs';
import { canonicalJson, stringifyYaml } from '../scripts/lib/yaml-state.mjs';
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
  projectMarkdown,
  projectRequirementsMarkdown,
  projectRoadmapMarkdown,
  projectState,
} from './helpers/build-contract-artifacts.mjs';

const MILESTONE_ID = 'M-003';
const MILESTONE_PATH = '.cruise/milestones/M-003-safe-rollout';
const CONTROLLER_PATH = '.cruise/goal/MILESTONE-CONTROLLER.yaml';
const NOW = '2026-07-13T08:30:00.000Z';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeGoalPlan(cwd) {
  const goalDirectory = join(cwd, '.cruise', 'goal');
  await mkdir(goalDirectory, { recursive: true });
  const probe = createDeterministicProbe({ repository: { root: cwd } });
  const origin = createOriginRecord({
    rawPrompt: `Use cruise:goal to complete milestone ${MILESTONE_ID}.`,
    selectedSkill: 'goal',
    repositoryRoot: cwd,
    deterministicProbeDigest: deterministicProbeDigest(probe),
    initialClassifier: 'gpt-5.6-luna medium',
    selectedRoute: 'goal',
    confidence: 0.99,
    goal: { outcome: `Complete ${MILESTONE_ID}.` },
  });
  const files = new Map([
    ['ORIGIN.yaml', stringifyYaml(origin)],
    ['SPEC.md', '# Specification\n'],
    ['DECISIONS.md', '# Decisions\n\n- D-07: Directly select M-003.\n'],
    ['ALIGNMENT.md', '# Alignment\n\n## Stem\n\nComplete the safe rollout milestone.\n'],
    ['PLAN.md', '# Hierarchical controller plan\n'],
  ]);
  for (const [name, body] of files) {
    await writeFile(join(goalDirectory, name), body);
  }
  return goalDirectory;
}

async function writeBuildContract(
  cwd,
  { blocker = false, autonomyMode = 'interactive' } = {},
) {
  const projectFiles = new Map([
    ['ORIGIN.yaml', 'schema_version: 1\n'],
    ['PROJECT.md', '# Project\n'],
    ['REQUIREMENTS.md', '# Project requirements\n'],
    ['ARCHITECTURE.md', '# Architecture\n'],
    ['ROADMAP.md', '# Project roadmap\n\nM-003\n'],
    ['DECISIONS.md', '# Project decisions\n'],
    ['ID-REGISTRY.yaml', 'schema_version: 1\nkind: cruise_build_id_registry\n'],
    ['QUEUE.yaml', 'schema_version: 1\nqueue: {}\n'],
  ]);
  const milestoneFiles = new Map([
    ['ORIGIN.yaml', 'schema_version: 1\n'],
    ['MILESTONE.md', '# M-003 safe rollout\n'],
    ['REQUIREMENTS.md', '# Milestone requirements\n'],
    ['ROADMAP.md', '# Phase DAG\n\nP-01\n\nP-02 depends on P-01\n'],
    ['DECISIONS.md', '# Milestone decisions\n'],
    [
      'QUESTIONS.yaml',
      stringifyYaml({
        questions: blocker
          ? [
              {
                id: 'Q-01',
                materiality: 'milestone_blocking',
                status: 'open',
              },
            ]
          : [],
      }),
    ],
    [
      'AUTONOMY.yaml',
      stringifyYaml({
        mode: autonomyMode,
        hard_stops: ['locked_artifact_drift', 'permission_expansion'],
      }),
    ],
    ['QUEUE.yaml', 'schema_version: 1\nqueue: {}\n'],
  ]);

  await mkdir(join(cwd, '.cruise', 'project'), { recursive: true });
  await mkdir(join(cwd, MILESTONE_PATH), { recursive: true });
  for (const [name, body] of projectFiles) {
    await writeFile(join(cwd, '.cruise', 'project', name), body);
  }
  for (const [name, body] of milestoneFiles) {
    await writeFile(join(cwd, MILESTONE_PATH, name), body);
  }

  const manifest = [];
  for (const [prefix, files] of [
    ['.cruise/project', projectFiles],
    [MILESTONE_PATH, milestoneFiles],
  ]) {
    for (const name of files.keys()) {
      const path = `${prefix}/${name}`;
      manifest.push({ path, sha256: sha256(await readFile(join(cwd, path))) });
    }
  }
  return manifest;
}

function controllerRecord(
  manifest,
  {
    milestonePath = MILESTONE_PATH,
    autonomyMode = 'interactive',
    phaseDag = [
      { id: 'P-01', depends_on: [], mandatory: true, acceptance_criteria: ['AC-01'] },
      { id: 'P-02', depends_on: ['P-01'], mandatory: true, acceptance_criteria: ['AC-02'] },
    ],
    completionFence = 'Every mandatory phase and aggregate milestone gate passes.',
  } = {},
) {
  const contractDigest = milestoneContractDigest(manifest);
  return {
    schema_version: 1,
    mode: 'milestone-controller',
    selection: {
      source: 'direct_user',
      decision_id: 'D-07',
      selected_at: '2026-07-13T09:00:00Z',
    },
    milestone: {
      id: MILESTONE_ID,
      path: milestonePath,
      contract_digest: contractDigest,
      completion_fence: completionFence,
    },
    build_approval: {
      label: 'Approve Milestone',
      approved_at: NOW,
      contract_digest: contractDigest,
    },
    eligibility: {
      phase_dag_validated: true,
      milestone_blockers_resolved: true,
      permission_envelope_explicit: true,
    },
    autonomy: { mode: autonomyMode },
    phase_dag: phaseDag,
    locked_artifacts: manifest,
  };
}

async function createControllerFixture(options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-milestone-controller-'));
  const goalDirectory = await writeGoalPlan(cwd);
  const manifest = await writeBuildContract(cwd, options);
  const controller = controllerRecord(manifest, options);
  await writeFile(join(cwd, CONTROLLER_PATH), stringifyYaml(controller));
  return { cwd, goalDirectory, manifest, controller };
}

function buildOrigin(root, mode) {
  return captureInitialBuildOrigin({
    rawPrompt: mode === 'bootstrap' ? 'Create the project foundation.' : 'Approve M-003.',
    repositoryBaseline: {
      root,
      head: null,
      branch: null,
      dirty_state_digest: DIGEST_A,
      instruction_files: [],
    },
    deterministicProbeDigest: DIGEST_B,
    initialClassifier: 'test-classifier medium',
    confidence: 0.99,
    capturedAt: NOW,
    build: {
      mode,
      mode_candidate: mode,
      mode_evidence: ['test fixture'],
      target_project: 'PRJ-01',
      target_milestone: mode === 'milestone' ? MILESTONE_ID : null,
    },
  });
}

function buildPhase(id, overrides = {}) {
  const number = id.slice(2);
  return {
    id,
    name: `Phase ${number}`,
    outcome: `Deliver independently useful outcome ${number}`,
    strategically_complete: true,
    depends_on: [],
    requirements: [`R-${number}`],
    acceptance_criteria: [`AC-${number}`],
    protected_behavior: ['Compatibility remains intact.'],
    expected_artifacts: [`artifact-${number}`],
    verification: [`evidence-${number}`],
    rollback_boundary: `Revert ${id}.`,
    blocking_questions: [],
    goal_handoff: `Use cruise:goal for ${id}.`,
    ...overrides,
  };
}

function buildQueueItem(id, phase) {
  return {
    id,
    skill: 'goal',
    purpose: `Complete ${phase}`,
    scope: `Only ${phase}`,
    status: 'draft',
    mode: '',
    phase,
    requires: phase === 'P-02' ? ['QI-01'] : [],
    dependents: [],
    consumes: phase === 'P-02' ? ['result-QI-01'] : [],
    produces: [`result-${id}`],
    mandatory: true,
    auto_start: false,
    auto_start_conditions: [],
    permissions_required: [],
    capability_requirements: [],
    acceptance_criteria: phase ? [`AC-${phase.slice(2)}`] : [],
    permitted_changes: [`src/${id}.mjs`, `tests/${id}.test.mjs`],
    prohibited_changes: ['deploy/production'],
    child_origin_policy: 'inherit_and_narrow',
    blockers: [],
    attempts: [],
    result: null,
  };
}

async function createAuthorizedControllerFixture({
  optionalPhase = false,
  lockedQuestions = [],
  registryHighWaterQuestionId = null,
} = {}) {
  const created = await mkdtemp(join(tmpdir(), 'cruise-authorized-controller-'));
  const cwd = await realpath(created);
  const projectDirectory = join(cwd, '.cruise', 'project');
  const milestoneDirectory = join(cwd, MILESTONE_PATH);
  const projectCapture = buildOrigin(cwd, 'bootstrap');
  const milestoneCapture = buildOrigin(cwd, 'milestone');
  const projectOrigin = stringifyYaml(projectCapture.origin_record);
  const milestoneOrigin = stringifyYaml(milestoneCapture.origin_record);
  const milestonePhaseDag = [
    buildPhase('P-01'),
    buildPhase('P-02', { depends_on: ['P-01'], mandatory: !optionalPhase }),
  ];
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(milestoneDirectory, { recursive: true });
  const projectFiles = {
    'ORIGIN.yaml': projectOrigin,
    'PROJECT.md': projectMarkdown(),
    'REQUIREMENTS.md': projectRequirementsMarkdown(),
    'ARCHITECTURE.md': architectureMarkdown(),
    'ROADMAP.md': projectRoadmapMarkdown(),
    'DECISIONS.md': `${decisionsMarkdown('D-01', 'Preserve the reviewed project foundation.')}${
      registryHighWaterQuestionId === null
        ? ''
        : `\nPreserve retired Build identifier ${registryHighWaterQuestionId}.\n`
    }`,
  };
  const milestoneFiles = {
    'ORIGIN.yaml': milestoneOrigin,
    'MILESTONE.md': milestoneMarkdown(),
    'REQUIREMENTS.md': milestoneRequirementsMarkdown(milestonePhaseDag),
    'ROADMAP.md': milestoneRoadmapMarkdown(milestonePhaseDag),
    'DECISIONS.md': decisionsMarkdown('D-02', 'Use the approved two-phase rollout DAG.'),
    'QUESTIONS.yaml': stringifyYaml({ questions: lockedQuestions }),
    'AUTONOMY.yaml': stringifyYaml(autonomyState()),
  };
  for (const [name, body] of Object.entries(projectFiles)) {
    await writeFile(join(projectDirectory, name), body);
  }
  for (const [name, body] of Object.entries(milestoneFiles)) {
    await writeFile(join(milestoneDirectory, name), body);
  }

  const draft = await prepareBuildContractDigests({
    root: cwd,
    mode: 'milestone',
    contractDirectory: MILESTONE_PATH,
    milestonePhaseDag,
  });
  const projectQueue = createWorkflowQueue({
    id: 'QUEUE-PRJ-01',
    projectId: 'PRJ-01',
    originSha256: sha256(projectOrigin),
    buildContractDigest: draft.project_contract_digest,
    items: [
      {
        ...buildQueueItem('QI-01', null),
        skill: 'quick',
        phase: null,
        mandatory: false,
        acceptance_criteria: [],
      },
    ],
  });
  const milestoneQueue = createWorkflowQueue({
    id: 'QUEUE-M-003',
    projectId: 'PRJ-01',
    milestoneId: MILESTONE_ID,
    originSha256: sha256(milestoneOrigin),
    buildContractDigest: draft.build_contract_digest,
    items: [
      buildQueueItem('QI-01', 'P-01'),
      {
        ...buildQueueItem('QI-02', 'P-02'),
        mandatory: !optionalPhase,
      },
    ],
  });
  await writeFile(join(projectDirectory, 'QUEUE.yaml'), stringifyYaml(projectQueue));
  await writeFile(join(milestoneDirectory, 'QUEUE.yaml'), stringifyYaml(milestoneQueue));

  const buildHistory = await installBuildHistoryAuthorities({
    root: cwd,
    projectCapture,
    milestoneCapture,
    projectOriginBytes: projectOrigin,
    milestoneOriginBytes: milestoneOrigin,
    milestonePath: MILESTONE_PATH,
    at: NOW,
  });

  const repositoryBaselineDigest = captureRepositoryBaseline(cwd).sha256;
  const evidence = buildApprovalEvidenceFixture({
    repositoryRoot: cwd,
    repositoryBaselineDigest,
    projectOriginSha256: sha256(projectOrigin),
    milestoneOriginSha256: sha256(milestoneOrigin),
    mode: 'milestone',
  });
  const readinessAuthority = attestBuildApprovalReadiness({
    mode: 'milestone',
    repositoryRoot: cwd,
    repositoryBaselineDigest,
    projectId: 'PRJ-01',
    milestoneId: MILESTONE_ID,
    projectOriginSha256: sha256(projectOrigin),
    milestoneOriginSha256: sha256(milestoneOrigin),
    repositoryEvidence: evidence.repositoryEvidence,
    readiness: {
      mode_candidate: 'milestone',
      ...Object.fromEntries(READINESS_CATEGORIES.map((category) => [category, {
        status: 'clear', evidence: ['E-01'],
      }])),
      fatal_contradictions: [], research_blockers: [], user_decisions_required: [],
    },
    viability: {
      concept_id: 'C-01',
      critical_gates: Object.fromEntries([
        'beneficiary_identified', 'meaningful_outcome', 'coherent_scope',
        'plausible_implementation', 'verifiable_completion',
        'constraints_compatible', 'no_fatal_contradiction',
      ].map((gate) => [gate, 'pass'])),
      supporting_dimensions: {
        expected_value: 90, feasibility_confidence: 0.95,
        implementation_clarity: 90, verification_clarity: 90,
        reversibility: 90, operational_sustainability: 90,
      },
      unresolved: { user_decisions: [], research_questions: [], phase_local_questions: [] },
    },
    evidenceAuthority: evidence.evidenceAuthority,
  });
  await writeFile(join(projectDirectory, 'STATE.yaml'), stringifyYaml(projectState({
    repositoryBaselineDigest,
    readinessDigest: readinessAuthority.readiness_digest,
    originSha256: sha256(projectOrigin),
    contractDigest: draft.project_contract_digest,
    queue: projectQueue,
    reconciledAt: NOW,
  })));
  await writeFile(join(milestoneDirectory, 'STATE.yaml'), stringifyYaml(milestoneState({
    repositoryBaselineDigest,
    readinessDigest: readinessAuthority.readiness_digest,
    originSha256: sha256(milestoneOrigin),
    contractDigest: draft.build_contract_digest,
    queue: milestoneQueue,
    reconciledAt: NOW,
  })));
  const buildReview = await prepareBuildApprovalReview({
    root: cwd,
    mode: 'milestone',
    contractDirectory: MILESTONE_PATH,
    repositoryBaselineDigest,
    milestonePhaseDag,
    approvalReadiness: readinessAuthority,
    buildOriginPairAuthority: buildHistory.buildOriginPairAuthority,
    buildIdHistoryAuthority: buildHistory.buildIdHistoryAuthority,
  });
  const buildSelection = attestStructuredBuildApprovalSelection({
    kind: 'host_structured_choice_event',
    source: 'request_user_input',
    input_kind: 'option_selection',
    interaction_id: 'build-approval-1',
    mode: 'milestone',
    option_id: 'approve_milestone',
    selected_label: 'Approve Milestone',
    selected_at: NOW,
    offered_options: [
      { id: 'approve_milestone', label: 'Approve Milestone' },
      { id: 'revise', label: 'Revise' },
    ],
    review_digest: buildReview.review_digest,
  });
  const persistedBuildApproval = await captureBuildApproval({
    root: cwd,
    mode: 'milestone',
    contractDirectory: MILESTONE_PATH,
    approvalSelection: buildSelection,
    approvalReadiness: readinessAuthority,
    repositoryBaselineDigest,
    milestonePhaseDag,
    buildOriginPairAuthority: buildHistory.buildOriginPairAuthority,
    buildIdHistoryAuthority: buildHistory.buildIdHistoryAuthority,
    now: NOW,
  });
  const verifiedBuildApproval = await verifyBuildApproval({
    root: cwd,
    approval: persistedBuildApproval,
    approvalSelection: buildSelection,
    currentRepositoryBaselineDigest: repositoryBaselineDigest,
    buildOriginPairAuthority: buildHistory.buildOriginPairAuthority,
    buildIdHistoryAuthority: buildHistory.buildIdHistoryAuthority,
  });

  const goalDirectory = await writeGoalPlan(cwd);
  const phaseDag = verifiedBuildApproval.milestone_phase_dag.controller_phase_dag;
  const controller = controllerRecord(
    verifiedBuildApproval.manifest.locked_artifacts,
    {
      phaseDag,
      completionFence:
        typeof verifiedBuildApproval.milestone_phase_dag.completion_fence === 'string'
          ? verifiedBuildApproval.milestone_phase_dag.completion_fence
          : canonicalJson(verifiedBuildApproval.milestone_phase_dag.completion_fence),
    },
  );
  await writeFile(join(cwd, CONTROLLER_PATH), stringifyYaml(controller));
  const interactionBroker = createMilestoneControllerInteractionBroker({
    sessionId: 'session-controller',
    runId: 'run-controller',
  });
  const selectionReceipt = interactionBroker.observeStructuredSelection({
    interactionId: 'goal-selection-1',
    answer: `Use Milestone Controller ${MILESTONE_ID}`,
    source: 'option',
    now: '2026-07-13T09:00:00.000Z',
  });
  const authority = await establishMilestoneControllerAuthority({
    interactionBroker,
    selectionReceipt,
    verifiedBuildApproval,
    now: '2026-07-13T09:00:00.000Z',
  });
  const controllerInspection = await inspectMilestoneController(cwd, { authority });
  return {
    cwd,
    goalDirectory,
    controller,
    controllerInspection,
    authority,
    interactionBroker,
    persistedBuildApproval,
    verifiedBuildApproval,
    buildSelection,
    repositoryBaselineDigest,
  };
}

async function activateControllerFixture(fixture, suffix = 'runtime') {
  const planApproval = await capturePlanApproval(fixture.cwd, {
    controllerAuthority: fixture.authority,
  });
  await writeFile(join(fixture.goalDirectory, 'GOAL.md'), '# Approved controller Goal\n');
  const goalApproval = await captureGoalApproval(fixture.cwd, planApproval);
  let storedGoal = null;
  const client = {
    async request(method, params) {
      if (method === 'thread/goal/get') return { goal: storedGoal };
      if (method === 'thread/goal/set') {
        storedGoal = {
          objective: params.objective,
          status: params.status,
        };
        return { goal: storedGoal };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  const threadId = `thread-controller-${suffix}`;
  const activationResult = await activateApprovedGoal({
    client,
    threadId,
    cwd: fixture.cwd,
    approvedSnapshot: goalApproval,
  });
  const activationReceipt = fixture.interactionBroker.observeNativeGoalActivation({
    interactionId: `goal-activation-${suffix}`,
    threadId,
    activationResult,
    approvedSnapshot: goalApproval,
  });
  const goalActivationAuthority = await establishMilestoneControllerGoalActivation({
    cwd: fixture.cwd,
    authority: fixture.authority,
    controllerInspection: fixture.controllerInspection,
    activationReceipt,
  });
  return {
    ...fixture,
    activationResult,
    activationReceipt,
    goalActivationAuthority,
    goalApproval,
    planApproval,
  };
}

function passEvidenceItem(id, { final = false } = {}) {
  return createEvidenceItem({
    id,
    gate: 'mandatory',
    scope: final ? 'final_verification' : 'task',
    status: 'PASS',
    performed: true,
    procedure: `Perform ${id}.`,
    command: 'node --test tests/focused.test.mjs',
    expected: 'The focused verification passes.',
    actual: 'The focused verification passed.',
    identity: {
      source: 'test fixture',
      build: 'source tree',
      environment: 'node:test',
    },
    startedAt: '2026-07-13T10:00:00.000Z',
    finishedAt: '2026-07-13T10:00:01.000Z',
    supports: [`AC-${id.slice(2)}`],
    sideEffects: [],
  });
}

function activeEvidence(runId, ids) {
  return createEvidenceRecord({
    runId,
    recordedAt: '2026-07-13T10:00:00.000Z',
    items: ids.map((id) => passEvidenceItem(id)),
  });
}

function completedEvidence(runId, phaseIds, finalId) {
  return createEvidenceRecord({
    runId,
    recordedAt: '2026-07-13T10:00:00.000Z',
    items: [
      ...phaseIds.map((id) => passEvidenceItem(id)),
      passEvidenceItem(finalId, { final: true }),
    ],
    finalVerification: {
      verifier: 'fresh adversarial verifier',
      performedAt: '2026-07-13T10:01:00.000Z',
      originCompared: true,
      normalizedContractCompared: true,
      actualChangesOrOutputsCompared: true,
      taskCompletionOnly: false,
      evidenceIds: [finalId],
    },
  });
}

function completedPhaseEvidence(runId, phaseId, finalId) {
  return createEvidenceRecord({
    runId,
    recordedAt: '2026-07-13T10:00:00.000Z',
    items: [
      passEvidenceItem(phaseId),
      passEvidenceItem(finalId, { final: true }),
    ],
    finalVerification: {
      verifier: 'fresh phase verifier',
      performedAt: '2026-07-13T10:00:30.000Z',
      originCompared: true,
      normalizedContractCompared: true,
      actualChangesOrOutputsCompared: true,
      taskCompletionOnly: false,
      evidenceIds: [finalId],
    },
  });
}

async function activateReadyPhase(fixture, state, bindings) {
  const phaseId = state.ready_phase_ids[0];
  const directory = join(fixture.cwd, MILESTONE_PATH, 'phases', phaseId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'PLAN.md'), `# ${phaseId} JIT plan\n`);
  const phasePlanAttestation = await attestMilestonePhasePlan({
    cwd: fixture.cwd,
    state,
    ...bindings,
    phaseId,
    ownership: [`src/${phaseId.toLowerCase()}.mjs`],
    permissionScope: {
      external_effects: [],
      network: false,
      writes: [`src/${phaseId.toLowerCase()}.mjs`],
    },
  });
  return activateMilestoneControllerPhase({
    cwd: fixture.cwd,
    state,
    ...bindings,
    phasePlanAttestation,
  });
}

test('legacy mode ignores Build milestones and ROADMAP without an explicit controller', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-single-slice-'));
  await writeGoalPlan(cwd);
  await writeBuildContract(cwd);
  await writeFile(join(cwd, '.cruise', 'goal', 'ROADMAP.md'), '# Goal slices\n');

  const inspected = await inspectMilestoneController(cwd);
  assert.equal(inspected.mode, 'single-slice');
  assert.equal(inspected.controllerArtifact, null);
  const artifacts = await inspectApprovedArtifacts(cwd, { stage: 'plan' });
  assert.equal(artifacts.some(({ path }) => path.includes('/milestones/')), false);
  assert.equal(artifacts.some(({ path }) => path === CONTROLLER_PATH), false);

  const declared = await createControllerFixture();
  const selfDeclared = await inspectMilestoneController(declared.cwd);
  assert.equal(selfDeclared.mode, 'single-slice');
  await assert.rejects(
    inspectMilestoneController(declared.cwd, {
      authority: {
        kind: 'cruise_milestone_controller_authority',
        milestone_id: MILESTONE_ID,
      },
    }),
    /absent, forged, stale/,
  );
});

test('an explicit eligible controller locks its descriptor and approved Build contract', async () => {
  const { cwd, controller, authority } = await createAuthorizedControllerFixture();
  const inspected = await inspectMilestoneController(cwd, { authority });
  assert.equal(inspected.mode, 'milestone-controller');
  assert.equal(inspected.controller.milestone.id, MILESTONE_ID);
  assert.equal(inspected.controller.milestone.contract_digest, controller.milestone.contract_digest);
  assert.equal(inspected.lockedArtifacts.length, 16);

  const artifacts = await inspectApprovedArtifacts(cwd, {
    stage: 'plan',
    controllerAuthority: authority,
  });
  assert.equal(artifacts.some(({ path }) => path === CONTROLLER_PATH), true);
  assert.equal(
    artifacts.some(({ path }) => path === `${MILESTONE_PATH}/AUTONOMY.yaml`),
    true,
  );
});

test('controller authority requires the exact current option and branded Build receipt', async () => {
  const fixture = await createAuthorizedControllerFixture();
  const broker = createMilestoneControllerInteractionBroker({
    sessionId: 'session-adversarial',
    runId: 'run-adversarial',
  });
  assert.throws(
    () => broker.observeStructuredSelection({
      interactionId: 'typed-controller',
      answer: `Use Milestone Controller ${MILESTONE_ID}`,
      source: 'other',
    }),
    /exact structured/,
  );
  const selection = broker.observeStructuredSelection({
    interactionId: 'exact-controller',
    answer: `Use Milestone Controller ${MILESTONE_ID}`,
    source: 'option',
  });
  await assert.rejects(
    establishMilestoneControllerAuthority({
      interactionBroker: broker,
      selectionReceipt: selection,
      verifiedBuildApproval: structuredClone(fixture.verifiedBuildApproval),
    }),
    /not verifier-attested/,
  );

  const wrongBroker = createMilestoneControllerInteractionBroker({
    sessionId: 'session-wrong-milestone',
    runId: 'run-wrong-milestone',
  });
  const wrongSelection = wrongBroker.observeStructuredSelection({
    interactionId: 'wrong-controller',
    answer: 'Use Milestone Controller M-004',
    source: 'option',
  });
  await assert.rejects(
    establishMilestoneControllerAuthority({
      interactionBroker: wrongBroker,
      selectionReceipt: wrongSelection,
      verifiedBuildApproval: fixture.verifiedBuildApproval,
    }),
    /does not match the verified Build approval/,
  );

  for (const mutate of [
    (descriptor) => {
      descriptor.phase_dag[1].depends_on = [];
    },
    (descriptor) => {
      descriptor.phase_dag[1].mandatory = !descriptor.phase_dag[1].mandatory;
    },
    (descriptor) => {
      descriptor.milestone.completion_fence = 'A weaker self-declared fence.';
    },
  ]) {
    const tampered = structuredClone(fixture.controller);
    mutate(tampered);
    await writeFile(join(fixture.cwd, CONTROLLER_PATH), stringifyYaml(tampered));
    await assert.rejects(
      inspectMilestoneController(fixture.cwd, { authority: fixture.authority }),
      /phase DAG or completion fence differs/,
    );
  }

  const staleDescriptor = structuredClone(fixture.controller);
  staleDescriptor.build_approval.approved_at = '2026-07-13T08:31:00.000Z';
  await writeFile(join(fixture.cwd, CONTROLLER_PATH), stringifyYaml(staleDescriptor));
  await assert.rejects(
    inspectMilestoneController(fixture.cwd, { authority: fixture.authority }),
    /self-declared or stale/,
  );
});

test('Goal approval rejects drift in a locked Build artifact', async () => {
  const { cwd, goalDirectory, authority } = await createAuthorizedControllerFixture();
  const plan = await capturePlanApproval(cwd, { controllerAuthority: authority });
  await writeFile(join(goalDirectory, 'GOAL.md'), '# Approved controller Goal\n');
  const goal = await captureGoalApproval(cwd, plan);
  await verifyGoalApproval(cwd, goal);

  await writeFile(join(cwd, MILESTONE_PATH, 'MILESTONE.md'), '# Drifted milestone\n');
  await assert.rejects(
    verifyGoalApproval(cwd, goal),
    /changed after Build milestone approval/,
  );
});

test('controller validation rejects unsafe selection, cycles, and open blockers', async (t) => {
  await t.test('unsafe milestone path', async () => {
    const { manifest } = await createControllerFixture();
    const controller = controllerRecord(manifest, { milestonePath: '../../outside' });
    assert.throws(
      () => parseMilestoneController(stringifyYaml(controller)),
      /normalized repository-relative path/,
    );
  });

  await t.test('cyclic phase graph', async () => {
    const { manifest } = await createControllerFixture();
    const controller = controllerRecord(manifest, {
      phaseDag: [
        { id: 'P-01', depends_on: ['P-02'], mandatory: true, acceptance_criteria: ['AC-01'] },
        { id: 'P-02', depends_on: ['P-01'], mandatory: true, acceptance_criteria: ['AC-02'] },
      ],
    });
    assert.throws(() => parseMilestoneController(stringifyYaml(controller)), /acyclic/);
  });

  await t.test('self-declared open-blocker eligibility cannot mint authority', async () => {
    const { cwd } = await createControllerFixture({ blocker: true });
    assert.equal((await inspectMilestoneController(cwd)).mode, 'single-slice');
  });

  await t.test('phase absent from the locked roadmap', async () => {
    const { cwd, controller: approved, authority } =
      await createAuthorizedControllerFixture();
    const controller = controllerRecord(approved.locked_artifacts, {
      phaseDag: [
        { id: 'P-01', depends_on: [], mandatory: true, acceptance_criteria: ['AC-01'] },
        { id: 'P-03', depends_on: ['P-01'], mandatory: true, acceptance_criteria: ['AC-03'] },
      ],
    });
    await writeFile(join(cwd, CONTROLLER_PATH), stringifyYaml(controller));
    await assert.rejects(
      inspectMilestoneController(cwd, { authority }),
      /phase DAG or completion fence differs/,
    );
  });

  await t.test('dangerous mode cannot be persisted in locked controller bytes', async () => {
    const { controller } = await createControllerFixture({ autonomyMode: 'dangerous' });
    assert.throws(
      () => parseMilestoneController(stringifyYaml(controller)),
      /must remain interactive.*separate runtime state/,
    );
  });
});

test('milestone Goal objective is hierarchical and preserves the legacy objective exactly', async () => {
  const { controller } = await createControllerFixture();
  const legacy = buildGoalObjective('Ship one safe migration.');
  assert.equal(
    legacy,
    'Complete the approved Cruise outcome: Ship one safe migration. Before editing, validate and read `.cruise/goal/ORIGIN.yaml`, then follow `.cruise/goal/ALIGNMENT.md`, `.cruise/goal/PLAN.md`, and `.cruise/goal/GOAL.md` as the approved source of truth. Remain the root coordinator: assign a `recommended_level` before every substantive phase, invoke the typed `cruise worker --level <2-7>` launcher for substantive worker execution, and block if the launcher cannot attest the configured runtime selection. Execute only the current slice, preserve its protected behavior and permission envelope, keep checkpoint evidence current, and stop only when every mandatory acceptance criterion and verification gate passes or an explicit blocking condition is met.',
  );

  const objective = buildGoalObjective('Complete the milestone.', controller);
  assert.match(objective, /hierarchical milestone controller for M-003/);
  assert.match(objective, /MILESTONE-CONTROLLER\.yaml/);
  assert.match(objective, /just-in-time plan for only the next ready phase/);
  assert.match(objective, /Do not flatten the milestone/);
  assert.doesNotMatch(objective, /Execute only the current slice/);
});

test('milestone activation retains the existing get-set-get native Goal flow', async () => {
  const {
    cwd,
    goalDirectory,
    authority,
    controllerInspection,
    interactionBroker,
    repositoryBaselineDigest,
  } = await createAuthorizedControllerFixture();
  const plan = await capturePlanApproval(cwd, { controllerAuthority: authority });
  await writeFile(join(goalDirectory, 'GOAL.md'), '# Approved controller Goal\n');
  const approvedSnapshot = await captureGoalApproval(cwd, plan);
  const calls = [];
  let storedGoal = null;
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/goal/get') return { goal: storedGoal };
      if (method === 'thread/goal/set') {
        storedGoal = {
          objective: params.objective,
          status: params.status,
        };
        return { goal: storedGoal };
      }
      throw new Error(`Unexpected method ${method}`);
    },
  };

  const activated = await activateApprovedGoal({
    client,
    threadId: 'thread-controller',
    cwd,
    approvedSnapshot,
  });
  assert.deepEqual(calls.map(({ method }) => method), [
    'thread/goal/get',
    'thread/goal/set',
    'thread/goal/get',
  ]);
  assert.match(activated.objective, /hierarchical milestone controller for M-003/);
  assert.equal(
    activated.artifacts.some(({ path }) => path === CONTROLLER_PATH),
    true,
  );
  const activationReceipt = interactionBroker.observeNativeGoalActivation({
    interactionId: 'goal-activation-1',
    threadId: 'thread-controller',
    activationResult: activated,
    approvedSnapshot,
  });
  const goalActivationAuthority = await establishMilestoneControllerGoalActivation({
    cwd,
    authority,
    controllerInspection,
    activationReceipt,
  });
  assert.equal(goalActivationAuthority.kind, 'cruise_milestone_goal_activation_authority');
  assert.throws(() => createMilestoneControllerState({
    authority,
    controllerInspection,
    repositoryBaselineDigest,
  }), /opaque native Goal activation authority/);
  assert.doesNotThrow(() => createMilestoneControllerState({
    authority,
    controllerInspection,
    goalActivationAuthority,
    repositoryBaselineDigest,
  }));
});

test('persisted phase state advances only through current closeout/evidence attestations', async () => {
  const fixture = await activateControllerFixture(
    await createAuthorizedControllerFixture(),
    'phase-state',
  );
  const bindings = {
    authority: fixture.authority,
    controllerInspection: fixture.controllerInspection,
    goalActivationAuthority: fixture.goalActivationAuthority,
  };
  let state = createMilestoneControllerState({
    ...bindings,
    repositoryBaselineDigest: fixture.repositoryBaselineDigest,
    now: '2026-07-13T09:30:00.000Z',
  });
  assert.deepEqual(state.ready_phase_ids, ['P-01']);
  assert.equal(state.active_phase_id, null);
  await assert.rejects(
    attestMilestoneCompletionFence({
      cwd: fixture.cwd,
      state: structuredClone(state),
      ...bindings,
      evidenceRecord: completedEvidence(state.run_id, [], 'E-03'),
      evidenceIds: ['E-03'],
      completionFence: state.completion_fence,
    }),
    /lacks trusted create\/reducer\/load provenance/,
  );
  await persistMilestoneControllerState({ cwd: fixture.cwd, state, ...bindings });
  assert.deepEqual(
    await loadMilestoneControllerState({ cwd: fixture.cwd, ...bindings }),
    state,
  );

  state = await activateReadyPhase(fixture, state, bindings);
  assert.equal(state.active_phase_id, 'P-01');
  const prePhaseBaseline = state.repository_baseline_digest;
  await persistMilestoneControllerState({ cwd: fixture.cwd, state, ...bindings });
  const activePlanPath = join(
    fixture.cwd,
    MILESTONE_PATH,
    'phases',
    'P-01',
    'PLAN.md',
  );
  await writeFile(activePlanPath, '# P-01 tampered JIT plan\n');
  await assert.rejects(
    loadMilestoneControllerState({ cwd: fixture.cwd, ...bindings }),
    /persisted phase PLAN\.md is stale or forged/,
  );
  await writeFile(activePlanPath, '# P-01 JIT plan\n');
  await mkdir(join(fixture.cwd, 'src'), { recursive: true });
  await writeFile(join(fixture.cwd, 'src', 'p-01.mjs'), 'export const phaseOne = true;\n');
  assert.throws(
    () => closeMilestoneControllerPhase({ state, ...bindings, closeoutAttestation: null }),
    /opaque closeout\/evidence attestation/,
  );
  assert.throws(
    () => closeMilestoneControllerPhase({
      state,
      ...bindings,
      closeoutAttestation: {
        kind: 'cruise_verified_phase_closeout',
        phase_id: 'P-01',
        closeout_digest: DIGEST_A,
        evidence_ids: ['E-01'],
      },
    }),
    /opaque closeout\/evidence attestation/,
  );

  await writeFile(
    join(fixture.cwd, MILESTONE_PATH, 'phases', 'P-01', 'CLOSEOUT.md'),
    '# P-01 closeout\n',
  );
  const activeP1Evidence = activeEvidence(state.run_id, ['E-01']);
  await writeFile(
    join(fixture.cwd, MILESTONE_PATH, 'phases', 'P-01', 'EVIDENCE.yaml'),
    stringifyYaml(activeP1Evidence),
  );
  await assert.rejects(
    attestMilestonePhaseCloseout({
      cwd: fixture.cwd,
      state,
      ...bindings,
      phaseId: 'P-01',
      evidenceRecord: activeP1Evidence,
      evidenceIds: ['E-01'],
    }),
    /unqualified completed outcome/,
  );
  const p1Evidence = completedPhaseEvidence(state.run_id, 'E-01', 'E-81');
  await writeFile(
    join(fixture.cwd, MILESTONE_PATH, 'phases', 'P-01', 'EVIDENCE.yaml'),
    stringifyYaml(p1Evidence),
  );
  const p1Proof = await attestMilestonePhaseCloseout({
    cwd: fixture.cwd,
    state,
    ...bindings,
    phaseId: 'P-01',
    evidenceRecord: p1Evidence,
    evidenceIds: ['E-01'],
    now: NOW,
  });
  state = closeMilestoneControllerPhase({ state, ...bindings, closeoutAttestation: p1Proof });
  assert.notEqual(state.repository_baseline_digest, prePhaseBaseline);
  assert.equal(
    state.repository_baseline_digest,
    p1Proof.post_repository_baseline_digest,
  );
  assert.deepEqual(state.ready_phase_ids, ['P-02']);
  assert.throws(
    () => closeMilestoneControllerPhase({ state, ...bindings, closeoutAttestation: p1Proof }),
    /current opaque closeout\/evidence attestation/,
  );
  await assert.rejects(
    attestMilestoneCompletionFence({
      cwd: fixture.cwd,
      state,
      ...bindings,
      evidenceRecord: completedEvidence(state.run_id, ['E-01'], 'E-03'),
      evidenceIds: ['E-01', 'E-03'],
      completionFence: state.completion_fence,
    }),
    /mandatory phase closes/,
  );

  state = await activateReadyPhase(fixture, state, bindings);
  await writeFile(
    join(fixture.cwd, MILESTONE_PATH, 'phases', 'P-02', 'CLOSEOUT.md'),
    '# P-02 closeout\n',
  );
  const p2Evidence = completedPhaseEvidence(state.run_id, 'E-02', 'E-82');
  await writeFile(
    join(fixture.cwd, MILESTONE_PATH, 'phases', 'P-02', 'EVIDENCE.yaml'),
    stringifyYaml(p2Evidence),
  );
  const p2Proof = await attestMilestonePhaseCloseout({
    cwd: fixture.cwd,
    state,
    ...bindings,
    phaseId: 'P-02',
    evidenceRecord: p2Evidence,
    evidenceIds: ['E-02'],
  });
  state = closeMilestoneControllerPhase({ state, ...bindings, closeoutAttestation: p2Proof });
  const aggregate = completedEvidence(state.run_id, ['E-01', 'E-02'], 'E-03');
  await writeFile(
    join(fixture.cwd, MILESTONE_PATH, 'MILESTONE-EVIDENCE.yaml'),
    stringifyYaml(aggregate),
  );
  const fence = await attestMilestoneCompletionFence({
    cwd: fixture.cwd,
    state,
    ...bindings,
    evidenceRecord: aggregate,
    evidenceIds: ['E-01', 'E-02', 'E-03'],
    completionFence: state.completion_fence,
  });
  state = completeMilestoneControllerState({
    state,
    ...bindings,
    completionAttestation: fence,
  });
  assert.equal(state.status, 'complete');
  assert.equal(state.completion_fence_passed, true);
  validateMilestoneControllerState(state, bindings);
  await persistMilestoneControllerState({
    cwd: fixture.cwd,
    state,
    ...bindings,
  });
  assert.equal(
    (await loadMilestoneControllerState({ cwd: fixture.cwd, ...bindings })).status,
    'complete',
  );
  const forgedAggregateState = structuredClone(state);
  forgedAggregateState.aggregate_evidence_ids = ['E-02', 'E-03'];
  await writeFile(
    join(fixture.cwd, MILESTONE_PATH, 'STATE.yaml'),
    stringifyYaml(forgedAggregateState),
  );
  await assert.rejects(
    loadMilestoneControllerState({ cwd: fixture.cwd, ...bindings }),
    /partial, forked, or rollback write outside durable controller history/,
  );
  await writeFile(
    join(fixture.cwd, MILESTONE_PATH, 'STATE.yaml'),
    stringifyYaml(state),
  );
  const tamperedEvidence = activeEvidence(state.run_id, ['E-01', 'E-09']);
  await writeFile(
    join(fixture.cwd, MILESTONE_PATH, 'phases', 'P-01', 'EVIDENCE.yaml'),
    stringifyYaml(tamperedEvidence),
  );
  await assert.rejects(
    loadMilestoneControllerState({ cwd: fixture.cwd, ...bindings }),
    /persisted evidence is not unqualified completed|stale or forged/,
  );
});

test('runtime question IDs start above the locked Build ledger and reject collisions', async () => {
  const lockedQuestions = ['Q-02', 'Q-09'].map((id) => ({
    id,
    status: 'answered',
    materiality: 'phase_blocking',
    category: 'rollout',
    question: `Locked Build question ${id}?`,
    evidence: ['Approved Build evidence.'],
    recommendation: 'Preserve the approved answer.',
    options: [],
    answer: 'Approved before Goal activation.',
    answer_source: 'direct_user',
    affects: ['P-01'],
    asked_at: NOW,
    answered_at: NOW,
    reopening_trigger: 'approved Build evidence changes',
  }));
  const fixture = await activateControllerFixture(
    await createAuthorizedControllerFixture({
      lockedQuestions,
      registryHighWaterQuestionId: 'Q-12',
    }),
    'locked-question-seed',
  );
  const bindings = {
    authority: fixture.authority,
    controllerInspection: fixture.controllerInspection,
    goalActivationAuthority: fixture.goalActivationAuthority,
  };
  assert.deepEqual(
    fixture.controllerInspection.lockedQuestionIds,
    ['Q-02', 'Q-09', 'Q-12'],
  );
  assert.equal(fixture.controllerInspection.lockedQuestionMax, 12);
  assert.equal(fixture.controllerInspection.runtimeQuestionSeed, 13);
  let state = createMilestoneControllerState({
    ...bindings,
    repositoryBaselineDigest: fixture.repositoryBaselineDigest,
  });
  assert.equal(state.question_cursor.locked_question_max, 12);
  assert.equal(state.question_cursor.runtime_question_seed, 13);
  assert.equal(state.question_cursor.next_question_number, 13);
  await persistMilestoneControllerState({
    cwd: fixture.cwd,
    state,
    ...bindings,
  });
  state = pauseMilestoneControllerForQuestion({
    state,
    ...bindings,
    phaseId: 'P-01',
    question: 'Which runtime rollback owner should be recorded?',
    materiality: 'permission_required',
    rationale: 'The runtime answer changes the permission boundary.',
    reopeningTrigger: 'runtime ownership changes',
  });
  assert.equal(state.question_cursor.pending_question_id, 'Q-13');

  const collision = structuredClone(state);
  collision.phases[0].questions[0].id = 'Q-09';
  collision.phases[0].question_events[0].question_id = 'Q-09';
  collision.question_cursor.pending_question_id = 'Q-09';
  assert.throws(
    () => validateMilestoneControllerState(collision, bindings),
    /collides with the locked Build question namespace/,
  );

  const illegalTransition = structuredClone(state);
  illegalTransition.phases[0].question_events[0] = {
    sequence: 1,
    type: 'answered',
    question_id: 'Q-13',
    answer: 'Forged answer without an open event.',
    answer_source: 'direct_user',
    at: illegalTransition.phases[0].questions[0].asked_at,
  };
  assert.throws(
    () => validateMilestoneControllerState(illegalTransition, bindings),
    /may answer only an open question/,
  );

  const forgedFinalState = structuredClone(state);
  const forgedQuestion = forgedFinalState.phases[0].questions[0];
  forgedQuestion.status = 'answered';
  forgedQuestion.answer = 'Forged final answer.';
  forgedQuestion.answer_source = 'direct_user';
  forgedQuestion.answered_at = forgedQuestion.asked_at;
  forgedFinalState.status = 'ready';
  forgedFinalState.question_cursor.pending_question_id = null;
  forgedFinalState.question_cursor.pending_phase_id = null;
  assert.throws(
    () => validateMilestoneControllerState(forgedFinalState, bindings),
    /event replay differs from final Q-13 state/,
  );
  await persistMilestoneControllerState({
    cwd: fixture.cwd,
    state,
    ...bindings,
  });
  await writeFile(
    join(fixture.cwd, MILESTONE_PATH, 'STATE.yaml'),
    stringifyYaml(collision),
  );
  await assert.rejects(
    loadMilestoneControllerState({ cwd: fixture.cwd, ...bindings }),
    /partial, forked, or rollback write outside durable controller history/,
  );
});

test('interactive controller persists stable questions and resumes the same run across multiple pauses', async () => {
  const fixture = await activateControllerFixture(
    await createAuthorizedControllerFixture(),
    'interactive-questions',
  );
  const bindings = {
    authority: fixture.authority,
    controllerInspection: fixture.controllerInspection,
    goalActivationAuthority: fixture.goalActivationAuthority,
  };
  let state = createMilestoneControllerState({
    ...bindings,
    repositoryBaselineDigest: fixture.repositoryBaselineDigest,
    now: '2026-07-13T09:30:00.000Z',
  });
  await persistMilestoneControllerState({ cwd: fixture.cwd, state, ...bindings });

  state = pauseMilestoneControllerForQuestion({
    state,
    ...bindings,
    phaseId: 'P-01',
    question: 'Which rollback boundary must P-01 preserve?',
    materiality: 'phase_blocking',
    rationale: 'The answer changes the safe implementation boundary.',
    reopeningTrigger: 'rollback contract changes',
    now: '2026-07-13T09:31:00.000Z',
  });
  assert.equal(state.status, 'paused');
  assert.equal(state.question_cursor.pending_question_id, 'Q-01');
  assert.throws(() => pauseMilestoneControllerForQuestion({
    state,
    ...bindings,
    phaseId: 'P-01',
    question: 'A second simultaneous question?',
    materiality: 'phase_blocking',
    rationale: 'This must not be opened concurrently.',
    reopeningTrigger: 'never',
  }), /only from ready or active|Resolve the current material question/);
  await persistMilestoneControllerState({ cwd: fixture.cwd, state, ...bindings });
  state = await loadMilestoneControllerState({ cwd: fixture.cwd, ...bindings });
  assert.equal(state.run_id, fixture.authority.run_id);
  assert.equal(state.phases[0].questions[0].id, 'Q-01');

  state = answerMilestoneControllerQuestion({
    state,
    ...bindings,
    questionId: 'Q-01',
    answer: 'Preserve atomic rollback to the prior release.',
    now: '2026-07-13T09:32:00.000Z',
  });
  await persistMilestoneControllerState({ cwd: fixture.cwd, state, ...bindings });
  state = await loadMilestoneControllerState({ cwd: fixture.cwd, ...bindings });
  assert.equal(state.status, 'ready');
  assert.equal(state.question_cursor.pending_question_id, null);

  state = pauseMilestoneControllerForQuestion({
    state,
    ...bindings,
    phaseId: 'P-01',
    question: 'Which operator group owns the rollout decision?',
    materiality: 'permission_required',
    rationale: 'The permission owner changes whether execution may continue.',
    reopeningTrigger: 'operator ownership changes',
    now: '2026-07-13T09:33:00.000Z',
  });
  assert.equal(state.question_cursor.pending_question_id, 'Q-02');
  assert.equal(state.question_cursor.pause_count, 2);
  await persistMilestoneControllerState({ cwd: fixture.cwd, state, ...bindings });
  state = await loadMilestoneControllerState({ cwd: fixture.cwd, ...bindings });
  state = answerMilestoneControllerQuestion({
    state,
    ...bindings,
    questionId: 'Q-02',
    answer: 'The release engineering on-call owns it.',
    now: '2026-07-13T09:34:00.000Z',
  });

  assert.throws(() => reopenMilestoneControllerQuestion({
    state,
    ...bindings,
    questionId: 'Q-01',
    trigger: 'a different condition',
  }), /recorded reopening trigger did not occur/);
  state = reopenMilestoneControllerQuestion({
    state,
    ...bindings,
    questionId: 'Q-01',
    trigger: 'rollback contract changes',
    now: '2026-07-13T09:35:00.000Z',
  });
  assert.equal(state.status, 'paused');
  assert.equal(state.question_cursor.pause_count, 3);
  assert.equal(state.phases[0].questions[0].reopen_count, 1);
  await persistMilestoneControllerState({ cwd: fixture.cwd, state, ...bindings });
  state = await loadMilestoneControllerState({ cwd: fixture.cwd, ...bindings });
  state = answerMilestoneControllerQuestion({
    state,
    ...bindings,
    questionId: 'Q-01',
    answer: 'Use the revised two-step rollback boundary.',
    now: '2026-07-13T09:36:00.000Z',
  });
  assert.deepEqual(
    state.phases[0].questions.map(({ id, status }) => ({ id, status })),
    [
      { id: 'Q-01', status: 'answered' },
      { id: 'Q-02', status: 'answered' },
    ],
  );
  assert.deepEqual(
    state.phases[0].question_events.map(({ type }) => type),
    ['opened', 'answered', 'opened', 'answered', 'reopened', 'answered'],
  );
  assert.deepEqual(
    state.phases[0].question_events
      .filter(({ question_id: questionId, type }) => questionId === 'Q-01' && type === 'answered')
      .map(({ answer, answer_source: answerSource }) => ({ answer, answerSource })),
    [
      {
        answer: 'Preserve atomic rollback to the prior release.',
        answerSource: 'direct_user',
      },
      {
        answer: 'Use the revised two-step rollback boundary.',
        answerSource: 'direct_user',
      },
    ],
  );
});

test('controller history recovers every interrupted multi-file commit point', async (t) => {
  const mirrorPaths = [
    `${MILESTONE_PATH}/phases/P-01/STATE.yaml`,
    `${MILESTONE_PATH}/phases/P-01/QUESTIONS.yaml`,
    `${MILESTONE_PATH}/phases/P-02/STATE.yaml`,
    `${MILESTONE_PATH}/phases/P-02/QUESTIONS.yaml`,
    `${MILESTONE_PATH}/STATE.yaml`,
  ];
  const faultSteps = [
    'after_history_append',
    ...mirrorPaths.map((path) => `after_mirror:${path}`),
  ];
  for (const faultStep of faultSteps) {
    await t.test(faultStep, async () => {
      const fixture = await activateControllerFixture(
        await createAuthorizedControllerFixture(),
        `persistence-${sha256(faultStep).slice(0, 8)}`,
      );
      const bindings = {
        authority: fixture.authority,
        controllerInspection: fixture.controllerInspection,
        goalActivationAuthority: fixture.goalActivationAuthority,
      };
      let state = createMilestoneControllerState({
        ...bindings,
        repositoryBaselineDigest: fixture.repositoryBaselineDigest,
      });
      await persistMilestoneControllerState({ cwd: fixture.cwd, state, ...bindings });
      state = pauseMilestoneControllerForQuestion({
        state,
        ...bindings,
        phaseId: 'P-01',
        question: 'Which recovery boundary should this committed run preserve?',
        materiality: 'phase_blocking',
        rationale: 'The answer controls the next durable phase transition.',
        reopeningTrigger: 'recovery boundary changes',
      });
      await assert.rejects(
        persistMilestoneControllerState({
          cwd: fixture.cwd,
          state,
          ...bindings,
          persistenceFaultInjector(step) {
            if (step === faultStep) throw new Error(`injected persistence fault at ${step}`);
          },
        }),
        /injected persistence fault/,
      );
      const resumedInspection = await inspectMilestoneController(fixture.cwd, {
        authority: fixture.authority,
        sessionId: fixture.authority.session_id,
        runId: fixture.authority.run_id,
      });
      const resumed = await loadMilestoneControllerState({
        cwd: fixture.cwd,
        authority: fixture.authority,
        controllerInspection: resumedInspection,
        goalActivationAuthority: fixture.goalActivationAuthority,
      });
      assert.equal(resumed.revision, state.revision);
      assert.equal(resumed.run_id, state.run_id);
      assert.equal(resumed.status, 'paused');
      assert.equal(resumed.question_cursor.pending_question_id, 'Q-01');
      const idempotent = await persistMilestoneControllerState({
        cwd: fixture.cwd,
        state: resumed,
        authority: fixture.authority,
        controllerInspection: resumedInspection,
        goalActivationAuthority: fixture.goalActivationAuthority,
      });
      assert.equal(idempotent.commit_sequence, 1);
      assert.match(idempotent.commit_sha256, /^[a-f0-9]{64}$/u);
      const historyDirectory = join(
        fixture.cwd,
        MILESTONE_PATH,
        'CONTROLLER-STATE-HISTORY',
      );
      assert.equal((await stat(historyDirectory)).mode & 0o777, 0o700);
      assert.equal(
        (await stat(join(historyDirectory, 'REV-000000000001.yaml'))).mode & 0o777,
        0o400,
      );
    });
  }
});

test('controller history CAS rejects forks and old mutable rollback bytes', async () => {
  const fixture = await activateControllerFixture(
    await createAuthorizedControllerFixture(),
    'persistence-cas',
  );
  const bindings = {
    authority: fixture.authority,
    controllerInspection: fixture.controllerInspection,
    goalActivationAuthority: fixture.goalActivationAuthority,
  };
  const state0 = createMilestoneControllerState({
    ...bindings,
    repositoryBaselineDigest: fixture.repositoryBaselineDigest,
  });
  await persistMilestoneControllerState({ cwd: fixture.cwd, state: state0, ...bindings });
  const revisionZeroQuestionBytes = await readFile(join(
    fixture.cwd,
    MILESTONE_PATH,
    'phases',
    'P-01',
    'QUESTIONS.yaml',
  ));
  const branchA = pauseMilestoneControllerForQuestion({
    state: state0,
    ...bindings,
    phaseId: 'P-01',
    question: 'Use branch A?',
    materiality: 'phase_blocking',
    rationale: 'This is one valid child of the persisted CAS head.',
    reopeningTrigger: 'branch A premise changes',
  });
  const branchB = pauseMilestoneControllerForQuestion({
    state: state0,
    ...bindings,
    phaseId: 'P-01',
    question: 'Use branch B?',
    materiality: 'phase_blocking',
    rationale: 'This is a competing child of the same persisted CAS head.',
    reopeningTrigger: 'branch B premise changes',
  });
  await persistMilestoneControllerState({ cwd: fixture.cwd, state: branchA, ...bindings });
  await assert.rejects(
    persistMilestoneControllerState({ cwd: fixture.cwd, state: branchB, ...bindings }),
    /compare-and-swap rejected a stale, forked, or rollback state/,
  );
  const state2 = answerMilestoneControllerQuestion({
    state: branchA,
    ...bindings,
    questionId: 'Q-01',
    answer: 'Use branch A.',
  });
  await persistMilestoneControllerState({ cwd: fixture.cwd, state: state2, ...bindings });
  await writeFile(
    join(fixture.cwd, MILESTONE_PATH, 'phases', 'P-01', 'QUESTIONS.yaml'),
    revisionZeroQuestionBytes,
  );
  await assert.rejects(
    loadMilestoneControllerState({ cwd: fixture.cwd, ...bindings }),
    /partial, forked, or rollback write outside durable controller history/,
  );
});

test('mandatory failure blocks completion while optional failure does not', async () => {
  const mandatory = await activateControllerFixture(
    await createAuthorizedControllerFixture(),
    'mandatory-failure',
  );
  const mandatoryBindings = {
    authority: mandatory.authority,
    controllerInspection: mandatory.controllerInspection,
    goalActivationAuthority: mandatory.goalActivationAuthority,
  };
  let failed = createMilestoneControllerState({
    ...mandatoryBindings,
    repositoryBaselineDigest: mandatory.repositoryBaselineDigest,
  });
  failed = await activateReadyPhase(mandatory, failed, mandatoryBindings);
  failed = await stopMilestoneControllerPhase({
    cwd: mandatory.cwd,
    state: failed,
    ...mandatoryBindings,
    outcome: 'failed',
    reason: 'Focused verification failed.',
  });
  assert.equal(failed.status, 'blocked');
  assert.equal(failed.hard_stop.code, 'MANDATORY_PHASE_FAILED');
  await assert.rejects(
    attestMilestoneCompletionFence({
      cwd: mandatory.cwd,
      state: failed,
      ...mandatoryBindings,
      evidenceRecord: completedEvidence(failed.run_id, [], 'E-03'),
      evidenceIds: ['E-03'],
      completionFence: failed.completion_fence,
    }),
    /mandatory phase closes/,
  );

  const optional = await activateControllerFixture(
    await createAuthorizedControllerFixture({ optionalPhase: true }),
    'optional-failure',
  );
  const optionalBindings = {
    authority: optional.authority,
    controllerInspection: optional.controllerInspection,
    goalActivationAuthority: optional.goalActivationAuthority,
  };
  let state = createMilestoneControllerState({
    ...optionalBindings,
    repositoryBaselineDigest: optional.repositoryBaselineDigest,
  });
  state = await activateReadyPhase(optional, state, optionalBindings);
  await writeFile(
    join(optional.cwd, MILESTONE_PATH, 'phases', 'P-01', 'CLOSEOUT.md'),
    '# mandatory closeout\n',
  );
  const optionalP1Evidence = completedPhaseEvidence(state.run_id, 'E-01', 'E-81');
  await writeFile(
    join(optional.cwd, MILESTONE_PATH, 'phases', 'P-01', 'EVIDENCE.yaml'),
    stringifyYaml(optionalP1Evidence),
  );
  const proof = await attestMilestonePhaseCloseout({
    cwd: optional.cwd,
    state,
    ...optionalBindings,
    phaseId: 'P-01',
    evidenceRecord: optionalP1Evidence,
    evidenceIds: ['E-01'],
  });
  state = closeMilestoneControllerPhase({ state, ...optionalBindings, closeoutAttestation: proof });
  state = await activateReadyPhase(optional, state, optionalBindings);
  state = await stopMilestoneControllerPhase({
    cwd: optional.cwd,
    state,
    ...optionalBindings,
    outcome: 'failed',
    reason: 'Optional experiment failed.',
  });
  assert.equal(state.status, 'ready');
  assert.equal(state.hard_stop, null);
  const aggregate = completedEvidence(state.run_id, ['E-01'], 'E-02');
  await writeFile(
    join(optional.cwd, MILESTONE_PATH, 'MILESTONE-EVIDENCE.yaml'),
    stringifyYaml(aggregate),
  );
  const fence = await attestMilestoneCompletionFence({
    cwd: optional.cwd,
    state,
    ...optionalBindings,
    evidenceRecord: aggregate,
    evidenceIds: ['E-01', 'E-02'],
    completionFence: state.completion_fence,
  });
  assert.equal(
    completeMilestoneControllerState({
      state,
      ...optionalBindings,
      completionAttestation: fence,
    }).status,
    'complete',
  );

  const { manifest } = await createControllerFixture();
  assert.throws(
    () => parseMilestoneController(stringifyYaml(controllerRecord(manifest, {
      phaseDag: [
        { id: 'P-01', depends_on: [], mandatory: false, acceptance_criteria: ['AC-01'] },
        { id: 'P-02', depends_on: ['P-01'], mandatory: true, acceptance_criteria: ['AC-02'] },
      ],
    }))),
    /mandatory.*cannot depend on optional/,
  );
});

test('JIT phase activation binds real PLAN bytes, ownership, permissions, and baseline', async () => {
  const fixture = await activateControllerFixture(
    await createAuthorizedControllerFixture(),
    'jit-plan',
  );
  const bindings = {
    authority: fixture.authority,
    controllerInspection: fixture.controllerInspection,
    goalActivationAuthority: fixture.goalActivationAuthority,
  };
  const state = createMilestoneControllerState({
    ...bindings,
    repositoryBaselineDigest: fixture.repositoryBaselineDigest,
  });
  await mkdir(
    join(fixture.cwd, MILESTONE_PATH, 'phases', 'P-01'),
    { recursive: true },
  );
  await writeFile(
    join(fixture.cwd, MILESTONE_PATH, 'phases', 'P-01', 'PLAN.md'),
    '# Attested JIT plan\n',
  );
  const proof = await attestMilestonePhasePlan({
    cwd: fixture.cwd,
    state,
    ...bindings,
    phaseId: 'P-01',
    ownership: ['src/p-01.mjs'],
    permissionScope: { network: false, external_effects: [] },
  });
  await assert.rejects(
    activateMilestoneControllerPhase({
      cwd: fixture.cwd,
      state,
      ...bindings,
      phasePlanAttestation: { ...proof },
    }),
    /opaque JIT plan\/baseline attestation/,
  );
  await writeFile(
    join(fixture.cwd, MILESTONE_PATH, 'phases', 'P-01', 'PLAN.md'),
    '# Drifted JIT plan\n',
  );
  await assert.rejects(
    activateMilestoneControllerPhase({
      cwd: fixture.cwd,
      state,
      ...bindings,
      phasePlanAttestation: proof,
    }),
    /PLAN\.md changed between attestation and activation/,
  );
  await writeFile(
    join(fixture.cwd, MILESTONE_PATH, 'phases', 'P-01', 'PLAN.md'),
    '# Attested JIT plan\n',
  );
  await writeFile(join(fixture.cwd, 'unexpected.txt'), 'baseline drift\n');
  await assert.rejects(
    activateMilestoneControllerPhase({
      cwd: fixture.cwd,
      state,
      ...bindings,
      phasePlanAttestation: proof,
    }),
    /drifted between phase-plan review and activation/,
  );

  const lockedDrift = await activateControllerFixture(
    await createAuthorizedControllerFixture(),
    'locked-drift',
  );
  const lockedBindings = {
    authority: lockedDrift.authority,
    controllerInspection: lockedDrift.controllerInspection,
    goalActivationAuthority: lockedDrift.goalActivationAuthority,
  };
  const lockedState = createMilestoneControllerState({
    ...lockedBindings,
    repositoryBaselineDigest: lockedDrift.repositoryBaselineDigest,
  });
  await mkdir(
    join(lockedDrift.cwd, MILESTONE_PATH, 'phases', 'P-01'),
    { recursive: true },
  );
  await writeFile(
    join(lockedDrift.cwd, MILESTONE_PATH, 'phases', 'P-01', 'PLAN.md'),
    '# Plan\n',
  );
  await writeFile(
    join(lockedDrift.cwd, MILESTONE_PATH, 'MILESTONE.md'),
    '# Locked bytes drifted\n',
  );
  await assert.rejects(
    attestMilestonePhasePlan({
      cwd: lockedDrift.cwd,
      state: lockedState,
      ...lockedBindings,
      phaseId: 'P-01',
      ownership: ['src/p-01.mjs'],
      permissionScope: { network: false },
    }),
    /changed after Build milestone approval/,
  );
});

test('dangerous mode requires a later opaque event, consumes once, and revokes on drift/lifecycle', async () => {
  const unactivated = await createAuthorizedControllerFixture();
  await assert.rejects(
    issueDangerousAuthorizationChallenge({
      cwd: unactivated.cwd,
      state: null,
      authority: unactivated.authority,
      controllerInspection: unactivated.controllerInspection,
    }),
    /create\/reducer\/load provenance bound to Goal activation|opaque native Goal activation/,
  );

  const fixture = await activateControllerFixture(unactivated, 'dangerous');
  let state = createMilestoneControllerState({
    authority: fixture.authority,
    controllerInspection: fixture.controllerInspection,
    goalActivationAuthority: fixture.goalActivationAuthority,
    repositoryBaselineDigest: fixture.repositoryBaselineDigest,
  });
  await persistMilestoneControllerState({
    cwd: fixture.cwd,
    state,
    authority: fixture.authority,
    controllerInspection: fixture.controllerInspection,
    goalActivationAuthority: fixture.goalActivationAuthority,
  });
  const base = {
    cwd: fixture.cwd,
    state,
    authority: fixture.authority,
    controllerInspection: fixture.controllerInspection,
    goalActivationAuthority: fixture.goalActivationAuthority,
  };
  const challenge = await issueDangerousAuthorizationChallenge(base);
  const token = dangerousAuthorizationToken(
    MILESTONE_ID,
    fixture.controller.milestone.contract_digest,
  );
  assert.equal(challenge.token, token);
  await assert.rejects(
    authorizeDangerousMode({
      response: token,
      source: 'direct_user',
      warningShown: true,
      laterInteraction: true,
      milestoneId: MILESTONE_ID,
      contractDigest: fixture.controller.milestone.contract_digest,
    }),
    /challenge is absent, forged, stale/,
  );
  const quoted = fixture.interactionBroker.observeDirectUserResponse({
    interactionId: 'danger-quoted',
    answer: `\`${token}\``,
    source: 'text',
  });
  await assert.rejects(
    authorizeDangerousMode({
      challenge,
      directUserEventReceipt: quoted,
      ...base,
    }),
    /exact current digest-bound match/,
  );
  const event = fixture.interactionBroker.observeDirectUserResponse({
    interactionId: 'danger-exact',
    answer: token,
    source: 'text',
  });
  const authorization = await authorizeDangerousMode({
    challenge,
    directUserEventReceipt: event,
    ...base,
  });
  const grant = await consumeDangerousAuthorization({ authorization, ...base });
  assert.equal(grant.effect, 'suppress_questions_only');
  assert.equal(grant.scope_expansion, false);
  assert.equal(validateDangerousQuestionSuppression(grant, {
    authority: fixture.authority,
    controllerInspection: fixture.controllerInspection,
    repositoryBaselineDigest: state.repository_baseline_digest,
  }), false, 'a raw grant is not effect authority');
  const initialEffect = await authorizeDangerousQuestionSuppressionEffect({
    grant,
    ...base,
  });
  assert.equal(validateDangerousQuestionSuppression(initialEffect, {
    authority: fixture.authority,
    controllerInspection: fixture.controllerInspection,
    repositoryBaselineDigest: state.repository_baseline_digest,
  }), true);
  assert.equal(validateDangerousQuestionSuppression({ ...initialEffect }, base), false);
  await assert.rejects(
    consumeDangerousAuthorization({ authorization, ...base }),
    /already consumed/,
  );

  state = await activateReadyPhase(fixture, state, {
    authority: fixture.authority,
    controllerInspection: fixture.controllerInspection,
    goalActivationAuthority: fixture.goalActivationAuthority,
  });
  await mkdir(join(fixture.cwd, 'src'), { recursive: true });
  await writeFile(join(fixture.cwd, 'src', 'p-01.mjs'), 'export const completed = true;\n');
  await writeFile(
    join(fixture.cwd, MILESTONE_PATH, 'phases', 'P-01', 'CLOSEOUT.md'),
    '# P-01 closeout\n',
  );
  const phaseEvidence = completedPhaseEvidence(state.run_id, 'E-01', 'E-81');
  await writeFile(
    join(fixture.cwd, MILESTONE_PATH, 'phases', 'P-01', 'EVIDENCE.yaml'),
    stringifyYaml(phaseEvidence),
  );
  const closeout = await attestMilestonePhaseCloseout({
    cwd: fixture.cwd,
    state,
    authority: fixture.authority,
    controllerInspection: fixture.controllerInspection,
    goalActivationAuthority: fixture.goalActivationAuthority,
    phaseId: 'P-01',
    evidenceRecord: phaseEvidence,
    evidenceIds: ['E-01'],
  });
  state = closeMilestoneControllerPhase({
    state,
    authority: fixture.authority,
    controllerInspection: fixture.controllerInspection,
    goalActivationAuthority: fixture.goalActivationAuthority,
    closeoutAttestation: closeout,
  });
  await persistMilestoneControllerState({
    cwd: fixture.cwd,
    state,
    authority: fixture.authority,
    controllerInspection: fixture.controllerInspection,
    goalActivationAuthority: fixture.goalActivationAuthority,
  });
  const progressedInspection = await inspectMilestoneController(fixture.cwd, {
    authority: fixture.authority,
    sessionId: fixture.authority.session_id,
    runId: fixture.authority.run_id,
  });
  state = await loadMilestoneControllerState({
    cwd: fixture.cwd,
    authority: fixture.authority,
    controllerInspection: progressedInspection,
    goalActivationAuthority: fixture.goalActivationAuthority,
  });
  const progressedEffect = await authorizeDangerousQuestionSuppressionEffect({
    cwd: fixture.cwd,
    grant,
    state,
    authority: fixture.authority,
    controllerInspection: progressedInspection,
    goalActivationAuthority: fixture.goalActivationAuthority,
  });
  assert.equal(validateDangerousQuestionSuppression(progressedEffect, {
    authority: fixture.authority,
    controllerInspection: progressedInspection,
    repositoryBaselineDigest: state.repository_baseline_digest,
  }), true, 'only attested phase closeout lineage may advance the baseline');
  assert.equal(validateDangerousQuestionSuppression(progressedEffect, {
    authority: fixture.authority,
    controllerInspection: progressedInspection,
    repositoryBaselineDigest: state.repository_baseline_digest,
    lifecycleEvent: 'revoked',
  }), false);
  assert.equal(validateDangerousQuestionSuppression(progressedEffect, {
    authority: fixture.authority,
    controllerInspection: progressedInspection,
    repositoryBaselineDigest: state.repository_baseline_digest,
  }), false);

  const driftFixture = await activateControllerFixture(
    await createAuthorizedControllerFixture(),
    'dangerous-preconsume-drift',
  );
  const driftState = createMilestoneControllerState({
    authority: driftFixture.authority,
    controllerInspection: driftFixture.controllerInspection,
    goalActivationAuthority: driftFixture.goalActivationAuthority,
    repositoryBaselineDigest: driftFixture.repositoryBaselineDigest,
  });
  const driftBase = {
    cwd: driftFixture.cwd,
    state: driftState,
    authority: driftFixture.authority,
    controllerInspection: driftFixture.controllerInspection,
    goalActivationAuthority: driftFixture.goalActivationAuthority,
  };
  const driftChallenge = await issueDangerousAuthorizationChallenge(driftBase);
  const driftEvent = driftFixture.interactionBroker.observeDirectUserResponse({
    interactionId: 'dangerous-preconsume-drift-token',
    answer: driftChallenge.token,
    source: 'text',
  });
  const driftAuthorization = await authorizeDangerousMode({
    challenge: driftChallenge,
    directUserEventReceipt: driftEvent,
    ...driftBase,
  });
  await writeFile(join(driftFixture.cwd, 'unexpected.txt'), 'pre-consumption drift\n');
  await assert.rejects(
    consumeDangerousAuthorization({
      authorization: driftAuthorization,
      ...driftBase,
    }),
    /bindings changed before consumption/,
  );

  const lockedDriftFixture = await activateControllerFixture(
    await createAuthorizedControllerFixture(),
    'dangerous-effect-locked-drift',
  );
  const lockedDriftState = createMilestoneControllerState({
    authority: lockedDriftFixture.authority,
    controllerInspection: lockedDriftFixture.controllerInspection,
    goalActivationAuthority: lockedDriftFixture.goalActivationAuthority,
    repositoryBaselineDigest: lockedDriftFixture.repositoryBaselineDigest,
  });
  const lockedDriftBase = {
    cwd: lockedDriftFixture.cwd,
    state: lockedDriftState,
    authority: lockedDriftFixture.authority,
    controllerInspection: lockedDriftFixture.controllerInspection,
    goalActivationAuthority: lockedDriftFixture.goalActivationAuthority,
  };
  const lockedDriftChallenge = await issueDangerousAuthorizationChallenge(lockedDriftBase);
  const lockedDriftEvent = lockedDriftFixture.interactionBroker.observeDirectUserResponse({
    interactionId: 'dangerous-effect-locked-drift-token',
    answer: lockedDriftChallenge.token,
    source: 'text',
  });
  const lockedDriftAuthorization = await authorizeDangerousMode({
    challenge: lockedDriftChallenge,
    directUserEventReceipt: lockedDriftEvent,
    ...lockedDriftBase,
  });
  const lockedDriftGrant = await consumeDangerousAuthorization({
    authorization: lockedDriftAuthorization,
    ...lockedDriftBase,
  });
  await writeFile(
    join(lockedDriftFixture.cwd, MILESTONE_PATH, 'MILESTONE.md'),
    '# locked artifact drift\n',
  );
  await assert.rejects(
    authorizeDangerousQuestionSuppressionEffect({
      grant: lockedDriftGrant,
      ...lockedDriftBase,
    }),
    /bindings drifted/,
  );

  assert.throws(
    () => milestoneContractDigest([
      { path: '.cruise/project/PROJECT.md', sha256: 'A'.repeat(64) },
    ]),
    /lowercase SHA-256/,
  );
});

test('dangerous suppression cannot launder an unattested stop through persisted load provenance', async () => {
  const fixture = await activateControllerFixture(
    await createAuthorizedControllerFixture({ optionalPhase: true }),
    'dangerous-load-laundering',
  );
  let inspection = fixture.controllerInspection;
  const bindings = () => ({
    authority: fixture.authority,
    controllerInspection: inspection,
    goalActivationAuthority: fixture.goalActivationAuthority,
  });
  let state = createMilestoneControllerState({
    ...bindings(),
    repositoryBaselineDigest: fixture.repositoryBaselineDigest,
  });
  await persistMilestoneControllerState({
    cwd: fixture.cwd,
    state,
    ...bindings(),
  });
  const challenge = await issueDangerousAuthorizationChallenge({
    cwd: fixture.cwd,
    state,
    ...bindings(),
  });
  const event = fixture.interactionBroker.observeDirectUserResponse({
    interactionId: 'dangerous-load-laundering-token',
    answer: challenge.token,
    source: 'text',
  });
  const authorization = await authorizeDangerousMode({
    cwd: fixture.cwd,
    state,
    challenge,
    directUserEventReceipt: event,
    ...bindings(),
  });
  const grant = await consumeDangerousAuthorization({
    cwd: fixture.cwd,
    state,
    authorization,
    ...bindings(),
  });

  state = await activateReadyPhase(fixture, state, bindings());
  await mkdir(join(fixture.cwd, 'src'), { recursive: true });
  await writeFile(join(fixture.cwd, 'src', 'p-01.mjs'), 'export const p1 = true;\n');
  await writeFile(
    join(fixture.cwd, MILESTONE_PATH, 'phases', 'P-01', 'CLOSEOUT.md'),
    '# P-01 closeout\n',
  );
  const p1Evidence = completedPhaseEvidence(state.run_id, 'E-01', 'E-81');
  await writeFile(
    join(fixture.cwd, MILESTONE_PATH, 'phases', 'P-01', 'EVIDENCE.yaml'),
    stringifyYaml(p1Evidence),
  );
  const p1Closeout = await attestMilestonePhaseCloseout({
    cwd: fixture.cwd,
    state,
    ...bindings(),
    phaseId: 'P-01',
    evidenceRecord: p1Evidence,
    evidenceIds: ['E-01'],
  });
  state = closeMilestoneControllerPhase({
    state,
    ...bindings(),
    closeoutAttestation: p1Closeout,
  });
  state = await activateReadyPhase(fixture, state, bindings());
  await writeFile(join(fixture.cwd, 'src', 'p-02.mjs'), 'export const p2 = false;\n');
  state = await stopMilestoneControllerPhase({
    cwd: fixture.cwd,
    state,
    ...bindings(),
    outcome: 'failed',
    reason: 'Optional P-02 stopped after an unattested repository change.',
  });
  assert.equal(state.status, 'ready');
  await persistMilestoneControllerState({
    cwd: fixture.cwd,
    state,
    ...bindings(),
  });
  inspection = await inspectMilestoneController(fixture.cwd, {
    authority: fixture.authority,
    sessionId: fixture.authority.session_id,
    runId: fixture.authority.run_id,
  });
  state = await loadMilestoneControllerState({
    cwd: fixture.cwd,
    ...bindings(),
  });
  await assert.rejects(
    authorizeDangerousQuestionSuppressionEffect({
      cwd: fixture.cwd,
      grant,
      state,
      ...bindings(),
    }),
    /bindings drifted/,
  );
  await assert.rejects(
    issueDangerousAuthorizationChallenge({
      cwd: fixture.cwd,
      state,
      ...bindings(),
    }),
    /baseline lineage fully attested from native Goal activation/,
  );
});
