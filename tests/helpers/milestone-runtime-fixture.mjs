import { createHash } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  attestBuildApprovalReadiness,
  attestStructuredBuildApprovalSelection,
  captureBuildApproval,
  createWorkflowQueue,
  prepareBuildApprovalReview,
  prepareBuildContractDigests,
  READINESS_CATEGORIES,
  verifyBuildApproval,
} from '../../scripts/lib/build-contract.mjs';
import { captureRepositoryBaseline } from '../../scripts/lib/goal-contract.mjs';
import { captureInitialBuildOrigin } from '../../scripts/lib/build-history.mjs';
import {
  activateMilestoneControllerPhase,
  attestMilestonePhasePlan,
  createMilestoneControllerInteractionBroker,
  createMilestoneControllerState,
  establishMilestoneControllerAuthority,
  establishMilestoneControllerGoalActivation,
  inspectMilestoneController,
} from '../../scripts/lib/milestone-controller.mjs';
import { canonicalJson, stringifyYaml } from '../../scripts/lib/yaml-state.mjs';
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
} from './build-contract-artifacts.mjs';

const NOW = '2026-07-13T00:00:00.000Z';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const MILESTONE_PATH = '.cruise/milestones/M-003-rollout';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function origin(root, mode) {
  return captureInitialBuildOrigin({
    rawPrompt: mode === 'bootstrap' ? 'Create project foundation.' : 'Approve M-003.',
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
      target_milestone: mode === 'milestone' ? 'M-003' : null,
    },
  });
}

function phase(id, dependsOn = []) {
  const suffix = id.slice(2);
  return {
    id,
    name: `Phase ${suffix}`,
    outcome: `Deliver independently useful outcome ${suffix}`,
    strategically_complete: true,
    mandatory: true,
    depends_on: dependsOn,
    requirements: [`R-${suffix}`],
    acceptance_criteria: [`AC-${suffix}`],
    protected_behavior: ['Compatibility remains intact.'],
    expected_artifacts: [`artifact-${suffix}`],
    verification: [`evidence-${suffix}`],
    rollback_boundary: `Revert ${id}.`,
    blocking_questions: [],
    goal_handoff: `Use cruise:goal for ${id}.`,
  };
}

function queueItem(id, skill, phaseId = null) {
  return {
    id,
    skill,
    purpose: `Complete ${id}`,
    scope: `Only ${id}`,
    status: 'draft',
    mode: '',
    phase: phaseId,
    requires: phaseId === 'P-02' ? ['QI-01'] : [],
    dependents: [],
    consumes: phaseId === 'P-02' ? ['result-QI-01'] : [],
    produces: [`result-${id}`],
    mandatory: skill === 'goal',
    auto_start: false,
    auto_start_conditions: [],
    permissions_required: [],
    capability_requirements: [],
    acceptance_criteria: phaseId ? [`AC-${phaseId.slice(2)}`] : [],
    permitted_changes: [`src/${id}.mjs`, `tests/${id}.test.mjs`],
    prohibited_changes: ['deploy/production'],
    child_origin_policy: 'inherit_and_narrow',
    blockers: [],
    attempts: [],
    result: null,
  };
}

export async function createMilestoneRuntimeFixture(
  rootInput,
  {
    phasePlanBound = true,
    ownership = ['src/app.mjs'],
    documentationPaths = [],
  } = {},
) {
  const root = await realpath(rootInput);
  const projectPath = '.cruise/project';
  const projectDirectory = join(root, projectPath);
  const milestoneDirectory = join(root, MILESTONE_PATH);
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(milestoneDirectory, { recursive: true });
  const projectCapture = origin(root, 'bootstrap');
  const milestoneCapture = origin(root, 'milestone');
  const projectOrigin = stringifyYaml(projectCapture.origin_record);
  const milestoneOrigin = stringifyYaml(milestoneCapture.origin_record);
  const phases = [phase('P-01'), phase('P-02', ['P-01'])];
  const projectFiles = {
    'ORIGIN.yaml': projectOrigin,
    'PROJECT.md': projectMarkdown(),
    'REQUIREMENTS.md': projectRequirementsMarkdown(),
    'ARCHITECTURE.md': architectureMarkdown(),
    'ROADMAP.md': projectRoadmapMarkdown(),
    'DECISIONS.md': decisionsMarkdown('D-01', 'Preserve the reviewed project foundation.'),
  };
  const milestoneFiles = {
    'ORIGIN.yaml': milestoneOrigin,
    'MILESTONE.md': milestoneMarkdown(),
    'REQUIREMENTS.md': milestoneRequirementsMarkdown(phases),
    'ROADMAP.md': milestoneRoadmapMarkdown(phases),
    'DECISIONS.md': decisionsMarkdown('D-02', 'Use the approved two-phase rollout DAG.'),
    'QUESTIONS.yaml': stringifyYaml({ questions: [] }),
    'AUTONOMY.yaml': stringifyYaml(autonomyState()),
  };
  for (const [name, body] of Object.entries(projectFiles)) {
    await writeFile(join(projectDirectory, name), body);
  }
  for (const [name, body] of Object.entries(milestoneFiles)) {
    await writeFile(join(milestoneDirectory, name), body);
  }

  const draft = await prepareBuildContractDigests({
    root,
    mode: 'milestone',
    contractDirectory: MILESTONE_PATH,
    milestonePhaseDag: phases,
  });
  const projectQuickItem = queueItem('QI-01', 'quick');
  const projectQueue = createWorkflowQueue({
    id: 'QUEUE-PRJ-01',
    projectId: 'PRJ-01',
    originSha256: sha256(projectOrigin),
    buildContractDigest: draft.project_contract_digest,
    items: [
      {
        ...projectQuickItem,
        permitted_changes: [
          ...projectQuickItem.permitted_changes,
          ...documentationPaths,
        ],
      },
    ],
  });
  const milestoneQueue = createWorkflowQueue({
    id: 'QUEUE-M-003',
    projectId: 'PRJ-01',
    milestoneId: 'M-003',
    originSha256: sha256(milestoneOrigin),
    buildContractDigest: draft.build_contract_digest,
    items: [queueItem('QI-01', 'goal', 'P-01'), queueItem('QI-02', 'goal', 'P-02')],
  });
  await writeFile(join(projectDirectory, 'QUEUE.yaml'), stringifyYaml(projectQueue));
  await writeFile(join(milestoneDirectory, 'QUEUE.yaml'), stringifyYaml(milestoneQueue));

  const buildHistory = await installBuildHistoryAuthorities({
    root,
    projectCapture,
    milestoneCapture,
    projectOriginBytes: projectOrigin,
    milestoneOriginBytes: milestoneOrigin,
    milestonePath: MILESTONE_PATH,
    at: NOW,
  });

  const baseline = captureRepositoryBaseline(root).sha256;
  const evidence = buildApprovalEvidenceFixture({
    repositoryRoot: root,
    repositoryBaselineDigest: baseline,
    projectOriginSha256: sha256(projectOrigin),
    milestoneOriginSha256: sha256(milestoneOrigin),
    mode: 'milestone',
  });
  const readinessAuthority = attestBuildApprovalReadiness({
    mode: 'milestone',
    repositoryRoot: root,
    repositoryBaselineDigest: baseline,
    projectId: 'PRJ-01',
    milestoneId: 'M-003',
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
    repositoryBaselineDigest: baseline,
    readinessDigest: readinessAuthority.readiness_digest,
    originSha256: sha256(projectOrigin),
    contractDigest: draft.project_contract_digest,
    queue: projectQueue,
    reconciledAt: NOW,
  })));
  await writeFile(join(milestoneDirectory, 'STATE.yaml'), stringifyYaml(milestoneState({
    repositoryBaselineDigest: baseline,
    readinessDigest: readinessAuthority.readiness_digest,
    originSha256: sha256(milestoneOrigin),
    contractDigest: draft.build_contract_digest,
    queue: milestoneQueue,
    reconciledAt: NOW,
  })));
  const buildReview = await prepareBuildApprovalReview({
    root,
    mode: 'milestone',
    contractDirectory: MILESTONE_PATH,
    repositoryBaselineDigest: baseline,
    milestonePhaseDag: phases,
    approvalReadiness: readinessAuthority,
    buildOriginPairAuthority: buildHistory.buildOriginPairAuthority,
    buildIdHistoryAuthority: buildHistory.buildIdHistoryAuthority,
  });
  const buildSelection = attestStructuredBuildApprovalSelection({
    kind: 'host_structured_choice_event',
    source: 'request_user_input',
    input_kind: 'option_selection',
    interaction_id: 'workflow-build-approval',
    mode: 'milestone',
    option_id: 'approve_milestone',
    selected_label: 'Approve Milestone',
    selected_at: NOW,
    offered_options: [{ id: 'approve_milestone', label: 'Approve Milestone' }],
    review_digest: buildReview.review_digest,
  });
  const approval = await captureBuildApproval({
    root,
    mode: 'milestone',
    contractDirectory: MILESTONE_PATH,
    approvalSelection: buildSelection,
    approvalReadiness: readinessAuthority,
    repositoryBaselineDigest: baseline,
    milestonePhaseDag: phases,
    buildOriginPairAuthority: buildHistory.buildOriginPairAuthority,
    buildIdHistoryAuthority: buildHistory.buildIdHistoryAuthority,
    now: NOW,
  });
  const verified = await verifyBuildApproval({
    root,
    approval,
    approvalSelection: buildSelection,
    currentRepositoryBaselineDigest: baseline,
    buildOriginPairAuthority: buildHistory.buildOriginPairAuthority,
    buildIdHistoryAuthority: buildHistory.buildIdHistoryAuthority,
  });
  const completionFence = typeof verified.milestone_phase_dag.completion_fence === 'string'
    ? verified.milestone_phase_dag.completion_fence
    : canonicalJson(verified.milestone_phase_dag.completion_fence);
  const descriptor = {
    schema_version: 1,
    mode: 'milestone-controller',
    selection: {
      source: 'direct_user',
      decision_id: 'D-07',
      selected_at: '2026-07-13T00:01:00.000Z',
    },
    milestone: {
      id: 'M-003',
      path: MILESTONE_PATH,
      contract_digest: verified.manifest.contract_digest,
      completion_fence: completionFence,
    },
    build_approval: {
      label: 'Approve Milestone',
      approved_at: verified.approved_at,
      contract_digest: verified.manifest.contract_digest,
    },
    eligibility: {
      phase_dag_validated: true,
      milestone_blockers_resolved: true,
      permission_envelope_explicit: true,
    },
    autonomy: { mode: 'interactive' },
    phase_dag: verified.milestone_phase_dag.controller_phase_dag,
    locked_artifacts: verified.manifest.locked_artifacts,
  };
  const descriptorBytes = stringifyYaml(descriptor);
  await writeFile(
    join(root, '.cruise', 'goal', 'ctrl.yaml'),
    descriptorBytes,
  );
  const broker = createMilestoneControllerInteractionBroker({
    sessionId: 'workflow-session',
    runId: 'run-01',
  });
  const selection = broker.observeStructuredSelection({
    interactionId: 'workflow-goal-selection',
    answer: 'Use Milestone Controller M-003',
    source: 'option',
  });
  const authority = await establishMilestoneControllerAuthority({
    interactionBroker: broker,
    selectionReceipt: selection,
    verifiedBuildApproval: verified,
  });
  const inspection = await inspectMilestoneController(root, { authority });
  const activationArtifacts = [{
    path: '.cruise/goal/ctrl.yaml',
    sha256: sha256(descriptorBytes),
  }];
  const approvedSnapshot = {
    stage: 'goal',
    controllerAuthority: authority,
    baseline: { sha256: baseline },
    artifacts: activationArtifacts,
  };
  const objective = 'Operate the approved M-003 test controller.';
  const activationResult = {
    goal: { status: 'active', objective },
    objective,
    artifacts: activationArtifacts,
  };
  const activationReceipt = broker.observeNativeGoalActivation({
    interactionId: 'workflow-goal-activation',
    threadId: 'workflow-thread',
    activationResult,
    approvedSnapshot,
  });
  const goalActivationAuthority = await establishMilestoneControllerGoalActivation({
    cwd: root,
    authority,
    controllerInspection: inspection,
    activationReceipt,
  });
  let state = createMilestoneControllerState({
    authority,
    controllerInspection: inspection,
    goalActivationAuthority,
    repositoryBaselineDigest: baseline,
  });
  let currentPhase;
  if (phasePlanBound) {
    const phaseDirectory = join(milestoneDirectory, 'phases', 'P-01');
    await mkdir(phaseDirectory, { recursive: true });
    await writeFile(join(phaseDirectory, 'PLAN.md'), '# P-01 JIT plan\n');
    const plan = await attestMilestonePhasePlan({
      cwd: root,
      state,
      authority,
      controllerInspection: inspection,
      goalActivationAuthority,
      phaseId: 'P-01',
      ownership,
      permissionScope: { network: false, external_effects: [], writes: ownership },
    });
    state = await activateMilestoneControllerPhase({
      cwd: root,
      state,
      authority,
      controllerInspection: inspection,
      goalActivationAuthority,
      phasePlanAttestation: plan,
    });
    const active = state.phases.find(({ id }) => id === 'P-01');
    currentPhase = {
      id: 'P-01',
      status: 'active',
      planDigest: active.plan_digest,
      currentPlanDigest: active.plan_digest,
      permissionScopeDigest: active.permission_scope_digest,
      ownership: [...active.ownership],
    };
  } else {
    currentPhase = { id: 'P-01', status: 'planning', ownership };
  }
  return {
    context: {
      ...inspection.controller,
      authority,
      goalActivationAuthority,
      controllerInspection: inspection,
      state,
      buildApprovalDigest: authority.build_approval_digest,
      currentContractDigest: inspection.controller.milestone.contract_digest,
      controllerDigest: inspection.controllerArtifact.sha256,
      currentControllerDigest: inspection.controllerArtifact.sha256,
      currentRepositoryBaselineDigest: state.repository_baseline_digest,
      currentPhase,
    },
    authority,
    goalActivationAuthority,
    inspection,
    state,
    verifiedBuildApproval: verified,
    persistedBuildApproval: approval,
    buildSelection,
    ...buildHistory,
  };
}
