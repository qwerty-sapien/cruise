import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  addBuildQuestion,
  allocateBuildId,
  answerBuildQuestion,
  assertQueueChildScope,
  attestBuildApprovalReadiness,
  attestBuildReadinessEvidence,
  attestOriginBoundBuildAutoApprovalSelection,
  attestStructuredBuildApprovalSelection,
  BOOTSTRAP_LOCKED_FILES,
  captureBuildApproval,
  createQuestionLedger,
  createQueueApproval,
  createQueueChildOrigin,
  createQueueState,
  createWorkflowQueue,
  decideBuildMode,
  evaluateBuildReadiness,
  evaluateConceptViability,
  evaluateQueueAutoStart,
  isVerifiedBuildApprovalArtifactSnapshot,
  isApproveFoundationChoice,
  isApproveMilestoneChoice,
  isVerifiedBuildApproval,
  MILESTONE_LOCKED_FILES,
  nextBuildQuestion,
  prepareBuildApprovalReview,
  prepareBuildContractDigests,
  queueCompletionStatus,
  READINESS_CATEGORIES,
  reconcileQueueState,
  reopenBuildQuestion,
  selectBuildModeFromEvidence,
  updateQueueItemState,
  validateQueueCoordinationContract,
  validateBuildDraftSemantics,
  validateMilestonePhaseDag,
  verifyBuildApproval,
  verifyBuildApprovalArtifacts,
  verifyQueueApproval,
  workflowQueueDigest,
} from '../scripts/lib/build-contract.mjs';
import {
  captureInitialBuildOrigin,
  hasExactBuildAutoApprovalDirective,
} from '../scripts/lib/build-history.mjs';
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
  projectMarkdown,
  projectRequirementsMarkdown,
  projectRoadmapMarkdown,
  projectState,
} from './helpers/build-contract-artifacts.mjs';

const NOW = '2026-07-13T00:00:00.000Z';
const LATER = '2026-07-13T01:00:00.000Z';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function bytesDigest(value) {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

function approvalSelection(mode, overrides = {}) {
  const option = mode === 'bootstrap'
    ? { id: 'approve_foundation', label: 'Approve Foundation' }
    : { id: 'approve_milestone', label: 'Approve Milestone' };
  return attestStructuredBuildApprovalSelection({
    kind: 'host_structured_choice_event',
    source: 'request_user_input',
    input_kind: 'option_selection',
    interaction_id: `interaction-${mode}`,
    mode,
    option_id: option.id,
    selected_label: option.label,
    selected_at: NOW,
    offered_options: [option, { id: 'revise', label: 'Revise' }],
    review_digest: DIGEST_A,
    ...overrides,
  });
}

function readiness(overrides = {}) {
  const categories = [
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
  ];
  return {
    mode_candidate: 'bootstrap',
    ...Object.fromEntries(categories.map((category) => [category, {
      status: 'clear',
      evidence: ['E-01'],
    }])),
    fatal_contradictions: [],
    research_blockers: [],
    user_decisions_required: [],
    ...overrides,
  };
}

function passingViability(overrides = {}) {
  return {
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
      feasibility_confidence: 0.9,
      implementation_clarity: 85,
      verification_clarity: 85,
      reversibility: 80,
      operational_sustainability: 80,
    },
    unresolved: {
      user_decisions: [],
      research_questions: [],
      phase_local_questions: [],
    },
    ...overrides,
  };
}

function phase(id, overrides = {}) {
  const number = id.split('-')[1];
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
    rollback_boundary: `Revert phase ${number}.`,
    blocking_questions: [],
    goal_handoff: `Use cruise:goal for ${id}.`,
    ...overrides,
  };
}

function queueItem(id, skill, overrides = {}) {
  return {
    id,
    skill,
    purpose: `Complete ${id}`,
    scope: `Only the approved ${id} scope`,
    status: 'draft',
    mode: skill === 'debug' ? 'reactive' : '',
    phase: null,
    requires: [],
    dependents: [],
    consumes: [],
    produces: [`result-${id}`],
    mandatory: true,
    auto_start: false,
    auto_start_conditions: [],
    permissions_required: [],
    capability_requirements: [],
    acceptance_criteria: ['AC-01'],
    permitted_changes: [`src/${id}.mjs`, `tests/${id}.test.mjs`],
    prohibited_changes: ['deploy/production'],
    child_origin_policy: 'inherit_and_narrow',
    blockers: [],
    attempts: [],
    result: null,
    ...overrides,
  };
}

function queue(items = null) {
  return createWorkflowQueue({
    id: 'QUEUE-M-003',
    projectId: 'PRJ-01',
    milestoneId: 'M-003',
    originSha256: DIGEST_A,
    buildContractDigest: DIGEST_B,
    items: items ?? [
      queueItem('QI-01', 'research'),
      queueItem('QI-02', 'goal', { requires: ['QI-01'], phase: 'P-01' }),
      queueItem('QI-03', 'quick', {
        mandatory: false,
        auto_start: true,
        auto_start_conditions: ['host_ready'],
      }),
    ],
  });
}

async function writeFiles(directory, files) {
  await mkdir(directory, { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(join(directory, name), body);
}

function originCapture(root, mode, { autoApprove = false } = {}) {
  const request = mode === 'bootstrap'
    ? 'Create a durable project foundation.'
    : 'Define milestone M-003.';
  return captureInitialBuildOrigin({
    rawPrompt: autoApprove
      ? `[$cruise:build](/installed/skills/build/SKILL.md) --auto-approve\n\n${request}`
      : request,
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
      mode_evidence: [mode === 'bootstrap' ? 'empty repository' : 'established product'],
      target_project: 'PRJ-01',
      target_milestone: mode === 'milestone' ? 'M-003' : null,
    },
  });
}

async function createApprovedBuildFixture({
  mode = 'bootstrap',
  questions = [],
  autoApprove = false,
} = {}) {
  const created = await mkdtemp(join(tmpdir(), `cruise-approved-${mode}-`));
  const root = await realpath(created);
  const projectDirectory = join(root, '.cruise', 'project');
  const projectCapture = originCapture(root, 'bootstrap', { autoApprove });
  const projectOrigin = stringifyYaml(projectCapture.origin_record);
  await writeFiles(projectDirectory, {
    'ORIGIN.yaml': projectOrigin,
    'PROJECT.md': projectMarkdown(),
    'REQUIREMENTS.md': projectRequirementsMarkdown(),
    'ARCHITECTURE.md': architectureMarkdown(),
    'ROADMAP.md': projectRoadmapMarkdown(),
    'DECISIONS.md': decisionsMarkdown('D-01', 'Preserve the reviewed project foundation.'),
  });

  const milestonePath = '.cruise/milestones/M-003-billing';
  const milestoneDirectory = join(root, milestonePath);
  const milestonePhaseDag = [phase('P-01')];
  const milestoneCapture = originCapture(root, 'milestone', { autoApprove });
  const milestoneOrigin = stringifyYaml(milestoneCapture.origin_record);
  await writeFiles(milestoneDirectory, {
    'ORIGIN.yaml': milestoneOrigin,
    'MILESTONE.md': milestoneMarkdown(),
    'REQUIREMENTS.md': milestoneRequirementsMarkdown(milestonePhaseDag),
    'ROADMAP.md': milestoneRoadmapMarkdown(milestonePhaseDag),
    'DECISIONS.md': decisionsMarkdown('D-02', 'Select the safe phase-controlled rollout.'),
    'QUESTIONS.yaml': stringifyYaml({ questions }),
    'AUTONOMY.yaml': stringifyYaml(autonomyState()),
  });

  const contractDirectory = mode === 'milestone' ? milestonePath : '.cruise/project';
  const draft = await prepareBuildContractDigests({
    root,
    mode,
    contractDirectory,
    firstMilestoneDirectory: mode === 'bootstrap' ? milestonePath : null,
    milestonePhaseDag,
  });
  const projectQueue = createWorkflowQueue({
    id: 'QUEUE-PRJ-01',
    projectId: 'PRJ-01',
    originSha256: bytesDigest(projectOrigin),
    buildContractDigest: draft.project_contract_digest,
    items: [queueItem('QI-01', 'quick', {
      acceptance_criteria: [],
      auto_start: true,
      auto_start_conditions: ['host_ready'],
    })],
  });
  await writeFile(join(projectDirectory, 'QUEUE.yaml'), stringifyYaml(projectQueue));

  const milestoneQueue = createWorkflowQueue({
    id: 'QUEUE-M-003',
    projectId: 'PRJ-01',
    milestoneId: 'M-003',
    originSha256: bytesDigest(milestoneOrigin),
    buildContractDigest: draft.build_contract_digest,
    items: [queueItem('QI-01', 'goal', { phase: 'P-01' })],
  });
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
  const evidence = buildApprovalEvidenceFixture({
    repositoryRoot: root,
    repositoryBaselineDigest,
    projectOriginSha256: bytesDigest(projectOrigin),
    milestoneOriginSha256: bytesDigest(milestoneOrigin),
    mode,
  });
  const approvalReadiness = attestBuildApprovalReadiness({
    mode,
    repositoryRoot: root,
    repositoryBaselineDigest,
    projectId: 'PRJ-01',
    milestoneId: 'M-003',
    projectOriginSha256: bytesDigest(projectOrigin),
    milestoneOriginSha256: bytesDigest(milestoneOrigin),
    repositoryEvidence: evidence.repositoryEvidence,
    readiness: readiness({ mode_candidate: mode }),
    viability: passingViability(),
    evidenceAuthority: evidence.evidenceAuthority,
  });
  await writeFile(join(projectDirectory, 'STATE.yaml'), stringifyYaml(projectState({
    repositoryBaselineDigest,
    readinessDigest: approvalReadiness.readiness_digest,
    originSha256: bytesDigest(projectOrigin),
    contractDigest: draft.project_contract_digest,
    queue: projectQueue,
    reconciledAt: NOW,
  })));
  await writeFile(join(milestoneDirectory, 'STATE.yaml'), stringifyYaml(milestoneState({
    repositoryBaselineDigest,
    readinessDigest: approvalReadiness.readiness_digest,
    originSha256: bytesDigest(milestoneOrigin),
    contractDigest: draft.build_contract_digest,
    queue: milestoneQueue,
    openQuestions: questions
      .filter(({ status }) => ['open', 'deferred'].includes(status))
      .map(({ id }) => id),
    reconciledAt: NOW,
  })));
  const review = await prepareBuildApprovalReview({
    root,
    mode,
    contractDirectory,
    repositoryBaselineDigest,
    firstMilestoneDirectory: mode === 'bootstrap' ? milestonePath : null,
    milestonePhaseDag,
    approvalReadiness,
    buildOriginPairAuthority: buildHistory.buildOriginPairAuthority,
    buildIdHistoryAuthority: buildHistory.buildIdHistoryAuthority,
  });
  const selection = autoApprove
    ? attestOriginBoundBuildAutoApprovalSelection({
        buildOriginPairAuthority: buildHistory.buildOriginPairAuthority,
        mode,
        reviewDigest: review.review_digest,
        selectedAt: NOW,
      })
    : approvalSelection(mode, { review_digest: review.review_digest });
  const approval = await captureBuildApproval({
    root,
    mode,
    contractDirectory,
    approvalSelection: selection,
    repositoryBaselineDigest,
    firstMilestoneDirectory: mode === 'bootstrap' ? milestonePath : null,
    milestonePhaseDag,
    approvalReadiness,
    buildOriginPairAuthority: buildHistory.buildOriginPairAuthority,
    buildIdHistoryAuthority: buildHistory.buildIdHistoryAuthority,
    now: NOW,
  });
  const receipt = await verifyBuildApproval({
    root,
    approval,
    approvalSelection: selection,
    currentRepositoryBaselineDigest: repositoryBaselineDigest,
    buildOriginPairAuthority: buildHistory.buildOriginPairAuthority,
    buildIdHistoryAuthority: buildHistory.buildIdHistoryAuthority,
  });
  return {
    root,
    contractDirectory,
    projectDirectory,
    milestoneDirectory,
    milestonePhaseDag,
    repositoryBaselineDigest,
    approvalReadiness,
    review,
    selection,
    approval,
    receipt,
    ...buildHistory,
    projectQueue,
    milestoneQueue,
    activeQueue: mode === 'milestone' ? milestoneQueue : projectQueue,
  };
}

test('Build identifier allocation is monotonic across preserved history and never fills gaps', () => {
  assert.equal(allocateBuildId('PRJ'), 'PRJ-01');
  assert.equal(allocateBuildId('M', ['M-01', 'M-03']), 'M-04');
  assert.equal(allocateBuildId('P', ['P-02', 'P-09']), 'P-10');
  assert.equal(allocateBuildId('Q', ['Q-01', 'Q-04', 'Q-02']), 'Q-05');
  assert.equal(allocateBuildId('RSK', ['RSK-99']), 'RSK-100');
  assert.equal(allocateBuildId('C', ['C-01']), 'C-02');
  assert.equal(allocateBuildId('QI', ['QI-01', 'QI-03']), 'QI-04');
  assert.throws(() => allocateBuildId('P', ['P-01', 'Q-02']), /P identifier is invalid/);
  assert.throws(() => allocateBuildId('UNKNOWN', []), /unsupported Build identifier prefix/);
});

test('mode selection uses substantive evidence, ignores counts, and asks only when genuinely ambiguous', () => {
  assert.deepEqual(selectBuildModeFromEvidence({
    minimal_scaffolding_only: true,
    file_count: 50_000,
  }).mode_candidate, 'bootstrap');

  const established = selectBuildModeFromEvidence({
    meaningful_product_source: true,
    established_manifest: true,
  });
  assert.equal(established.mode_candidate, 'milestone');
  assert.equal(established.requires_mode_question, false);
  assert.equal(selectBuildModeFromEvidence({
    existing_project_artifacts: true,
  }).mode_candidate, 'milestone');
  assert.equal(selectBuildModeFromEvidence({
    established_manifest: true,
    meaningful_tests: true,
  }).mode_candidate, 'milestone');
  assert.equal(selectBuildModeFromEvidence({
    prior_releases_or_deployed_behavior: true,
  }).mode_candidate, 'milestone');
  assert.equal(selectBuildModeFromEvidence({
    public_interfaces_or_persisted_data: true,
    product_architecture: true,
  }).mode_candidate, 'milestone');

  const ambiguous = selectBuildModeFromEvidence({ ambiguous_teaching_or_experiment: true });
  assert.equal(ambiguous.mode_candidate, null);
  assert.equal(ambiguous.requires_mode_question, true);
  assert.equal(selectBuildModeFromEvidence({
    explicit_initialize_request: true,
    explicit_milestone_request: true,
  }).requires_mode_question, true);
});

test('readiness enters discovery only for critical uncertainty, contradictions, research, or decisions', () => {
  const complete = readiness({
    differentiation_or_necessity: { status: 'missing', evidence: [] },
  });
  const assessed = evaluateBuildReadiness(complete);
  assert.equal(assessed.discovery_required, false, 'an unrelated supporting detail must not force discovery');

  const missingBeneficiary = readiness({
    beneficiary: { status: 'missing', evidence: [] },
  });
  assert.equal(evaluateBuildReadiness(missingBeneficiary).discovery_required, true);
  assert.deepEqual(evaluateBuildReadiness(missingBeneficiary).blocking_categories, ['beneficiary']);

  const needsDecision = readiness({ user_decisions_required: ['Choose the actual beneficiary.'] });
  assert.equal(evaluateBuildReadiness(needsDecision).discovery_required, true);
  assert.equal(evaluateBuildReadiness(readiness({
    feasibility: { status: 'partial', evidence: ['Only a speculative path exists.'] },
  })).discovery_required, true);
  assert.equal(evaluateBuildReadiness(readiness({
    security_and_external_effects: { status: 'conflicting', evidence: ['Policies conflict.'] },
  })).discovery_required, true);
  assert.equal(evaluateBuildReadiness(readiness({
    constraints_and_resources: { status: 'conflicting', evidence: ['Budget and scope conflict.'] },
  })).discovery_required, true);

  const direct = decideBuildMode({
    repositoryEvidence: {
      meaningful_product_source: true,
      meaningful_tests: true,
      product_architecture: true,
    },
    readiness: readiness({ mode_candidate: 'milestone' }),
  });
  assert.equal(direct.mode, 'milestone');
  assert.equal(direct.disposition, 'draft_build_contract');

  const discovery = decideBuildMode({
    repositoryEvidence: { minimal_scaffolding_only: true },
    readiness: missingBeneficiary,
  });
  assert.equal(discovery.mode, 'discovery');
  assert.equal(discovery.disposition, 'enter_discovery');
});

test('approval readiness requires opaque source-bound E-XX citations', () => {
  const evidenceAuthority = attestBuildReadinessEvidence({
    repositoryRoot: '/fixture/repository',
    repositoryBaselineDigest: DIGEST_A,
    projectOriginSha256: DIGEST_B,
    milestoneOriginSha256: 'c'.repeat(64),
    evidence: [{
      id: 'E-01',
      type: 'origin_statement',
      source_locator: 'origin://project',
      source_sha256: DIGEST_B,
      claim: 'The immutable Origin closes the reviewed foundation contract.',
      certainty: 'observed',
      supports: [
        'repository:explicit_initialize_request',
        ...READINESS_CATEGORIES.map((category) => `readiness:${category}`),
        ...[
          'beneficiary_identified',
          'meaningful_outcome',
          'coherent_scope',
          'plausible_implementation',
          'verifiable_completion',
          'constraints_compatible',
          'no_fatal_contradiction',
          'expected_value',
          'feasibility_confidence',
          'implementation_clarity',
          'verification_clarity',
          'reversibility',
          'operational_sustainability',
        ].map((target) => `viability:${target}`),
        'concept:C-01',
      ],
    }],
  });
  const input = {
    mode: 'bootstrap',
    repositoryRoot: '/fixture/repository',
    repositoryBaselineDigest: DIGEST_A,
    projectId: 'PRJ-01',
    milestoneId: 'M-003',
    projectOriginSha256: DIGEST_B,
    milestoneOriginSha256: 'c'.repeat(64),
    repositoryEvidence: { explicit_initialize_request: ['E-01'] },
    readiness: readiness(),
    viability: passingViability(),
    evidenceAuthority,
  };
  assert.match(attestBuildApprovalReadiness(input).readiness_digest, /^[a-f0-9]{64}$/u);
  assert.throws(
    () => attestBuildApprovalReadiness({
      ...input,
      repositoryEvidence: { explicit_initialize_request: true },
    }),
    /must use E-XX citations, not booleans/,
  );
  assert.throws(
    () => attestBuildApprovalReadiness({ ...input, evidenceAuthority: structuredClone(evidenceAuthority) }),
    /opaque repository\/Origin-bound E-XX evidence/,
  );
  assert.throws(
    () => attestBuildApprovalReadiness({
      ...input,
      readiness: readiness({ outcome: { status: 'clear', evidence: ['E-02'] } }),
    }),
    /outcome readiness citation E-02/,
  );
});

test('readiness evidence reads repository bytes without following links and fails closed externally', async () => {
  const created = await mkdtemp(join(tmpdir(), 'cruise-readiness-evidence-'));
  const root = await realpath(created);
  const observedPath = join(root, 'README.md');
  const original = 'current repository evidence\n';
  await writeFile(observedPath, original);
  const originalDigest = bytesDigest(original);
  const bindings = {
    repositoryRoot: root,
    repositoryBaselineDigest: DIGEST_A,
    projectOriginSha256: DIGEST_B,
    milestoneOriginSha256: 'c'.repeat(64),
  };
  const record = (overrides = {}) => ({
    id: 'E-01',
    type: 'repository_observation',
    source_locator: 'repository://README.md',
    source_sha256: originalDigest,
    claim: 'The current repository bytes establish the observed boundary.',
    certainty: 'observed',
    supports: ['repository:meaningful_product_source'],
    ...overrides,
  });
  const attest = (evidence) => attestBuildReadinessEvidence({ ...bindings, evidence });

  const authority = attest([record()]);
  assert.equal(authority.evidence[0].source_sha256, originalDigest);
  assert.doesNotThrow(() => attest([record({ type: 'prior_cruise_artifact' })]));
  assert.doesNotThrow(() => attest([record({
    source_locator: 'repository://baseline',
    source_sha256: DIGEST_A,
  })]));

  assert.throws(
    () => attest([record({ source_sha256: DIGEST_A })]),
    /does not match current bytes/,
  );
  assert.throws(
    () => attest([record({ source_locator: 'repository:\/\/..\/outside.md' })]),
    /safe repository-relative POSIX path/,
  );

  await symlink(observedPath, join(root, 'linked-evidence.md'));
  assert.throws(
    () => attest([record({ source_locator: 'repository://linked-evidence.md' })]),
    /regular non-symlink file/,
  );
  await mkdir(join(root, 'real-evidence'));
  await writeFile(join(root, 'real-evidence', 'finding.md'), original);
  await symlink(join(root, 'real-evidence'), join(root, 'linked-component'));
  assert.throws(
    () => attest([record({ source_locator: 'repository://linked-component/finding.md' })]),
    /must not traverse symbolic links/,
  );
  await writeFile(join(root, 'oversized-evidence.bin'), Buffer.alloc((4 * 1024 * 1024) + 1));
  assert.throws(
    () => attest([record({
      source_locator: 'repository://oversized-evidence.bin',
      source_sha256: DIGEST_A,
    })]),
    /exceeds 4194304 bytes/u,
  );

  await writeFile(observedPath, 'changed repository evidence\n');
  assert.throws(
    () => attest([record()]),
    /does not match current bytes/,
  );
  assert.throws(
    () => attest([record({
      type: 'research_finding',
      source_locator: 'research://caller-selected-result',
    })]),
    /requires opaque non-repository provenance; no trusted broker is available/,
  );
  assert.throws(
    () => attest([record({
      type: 'external_context',
      source_locator: 'https://example.invalid/context',
    })]),
    /requires opaque non-repository provenance; no trusted broker is available/,
  );
  assert.throws(
    () => attest([record({
      source_locator: 'repository://baseline',
      source_sha256: DIGEST_B,
    })]),
    /repository baseline evidence digest is stale/,
  );
});

test('viability hard gates cannot be hidden by high supporting scores', () => {
  assert.equal(evaluateConceptViability(passingViability()).outcome, 'ready_for_build');

  const failed = passingViability();
  failed.critical_gates.beneficiary_identified = 'fail';
  assert.equal(evaluateConceptViability(failed).outcome, 'not_currently_viable');
  assert.deepEqual(evaluateConceptViability(failed).failed_gates, ['beneficiary_identified']);

  const research = passingViability();
  research.critical_gates.plausible_implementation = 'research_needed';
  assert.equal(evaluateConceptViability(research).outcome, 'research_required');

  const decision = passingViability();
  decision.unresolved.user_decisions = ['Choose the regulated market.'];
  assert.equal(evaluateConceptViability(decision).outcome, 'user_decision_required');

  const lowConfidence = passingViability();
  lowConfidence.supporting_dimensions.feasibility_confidence = 0.8;
  assert.equal(evaluateConceptViability(lowConfidence, { consequence: 'high' }).outcome, 'research_required');
  assert.equal(evaluateConceptViability(passingViability(), { deferred: true }).outcome, 'deferred');
});

test('question ledger allocates stable IDs, asks one question, avoids repeats, and honors reopening triggers', () => {
  let ledger = createQuestionLedger();
  ledger = addBuildQuestion(ledger, {
    materiality: 'milestone_blocking',
    category: 'beneficiary',
    question: 'Who receives the first usable outcome?',
    evidence: ['The repository does not identify a user.'],
    recommendation: 'Choose the operations team first.',
    options: ['Operations', 'Developers'],
    affects: ['M-003'],
    reopening_trigger: 'beneficiary evidence changes',
  }, { now: NOW });
  assert.equal(nextBuildQuestion(ledger).id, 'Q-01');
  assert.throws(() => addBuildQuestion(ledger, {
    materiality: 'milestone_blocking',
    category: 'repository_fact',
    question: 'Which package manager does the repository use?',
    evidence: ['package-lock.json is present.'],
    recommendation: 'Use npm.',
    answerable_from_repository: true,
  }), /answerable from repository inspection/);
  assert.throws(() => addBuildQuestion(ledger, {
    materiality: 'nonblocking',
    category: 'terminology',
    question: 'Which public label should the report use?',
    evidence: ['Two labels exist.'],
    recommendation: 'Use the existing product label.',
    options: [],
    affects: ['P-02'],
  }, { now: NOW }), /only one material question may be open/);

  ledger = answerBuildQuestion(ledger, {
    id: 'Q-01',
    answer: 'Operations',
    answerSource: 'direct_user',
  }, { now: LATER });
  assert.throws(() => addBuildQuestion(ledger, {
    materiality: 'milestone_blocking',
    category: 'beneficiary',
    question: '  Who receives the first usable outcome? ',
    evidence: [],
    recommendation: 'Ask again.',
  }), /already exists/);
  ledger = addBuildQuestion(ledger, {
    materiality: 'nonblocking',
    category: 'terminology',
    question: 'Which public label should the report use?',
    evidence: ['Two labels exist.'],
    recommendation: 'Use the existing product label.',
    options: [],
    affects: ['P-02'],
  }, { now: LATER });
  assert.deepEqual(ledger.questions.map(({ id }) => id), ['Q-01', 'Q-02']);
  assert.equal(nextBuildQuestion(ledger).id, 'Q-02');
  assert.throws(
    () => reopenBuildQuestion(ledger, { id: 'Q-01', trigger: 'time passed' }),
    /trigger did not occur/,
  );
  assert.throws(() => reopenBuildQuestion(ledger, {
    id: 'Q-01',
    trigger: 'beneficiary evidence changes',
  }), /only one material question may be open/);
  ledger = answerBuildQuestion(ledger, {
    id: 'Q-02',
    answer: 'Defer the label until phase P-02.',
    answerSource: 'phase_deferred',
    status: 'deferred',
  }, { now: LATER });
  ledger = reopenBuildQuestion(ledger, {
    id: 'Q-01',
    trigger: 'beneficiary evidence changes',
    evidence: ['A new user group appeared.'],
  }, { now: LATER });
  assert.equal(nextBuildQuestion(ledger).id, 'Q-01');
  assert.equal(ledger.questions[0].status, 'open');
  assert.deepEqual(ledger.events.map(({ sequence }) => sequence), [1, 2, 3, 4, 5]);
  assert.throws(() => addBuildQuestion(createQuestionLedger(), {
    materiality: 'nonblocking',
    category: 'label',
    question: 'Choose one option?',
    evidence: ['A choice exists.'],
    recommendation: 'Use free text or at least two real alternatives.',
    options: ['Only option'],
    affects: ['P-01'],
  }), /zero, two, or three concrete options/);
});

test('API-produced free-text deferred question remains approvable end to end', async () => {
  let ledger = addBuildQuestion(createQuestionLedger(), {
    materiality: 'nonblocking',
    category: 'operations',
    question: 'Which retry window should phase evidence select?',
    evidence: ['The decision becomes material only after P-01 timing evidence exists.'],
    recommendation: 'Defer selection until the phase measures production timing.',
    options: [],
    affects: ['P-01'],
    reopening_trigger: 'P-01 timing evidence is available',
  }, { now: NOW });
  ledger = answerBuildQuestion(ledger, {
    id: 'Q-01',
    answer: 'Defer the retry-window choice to P-01 evidence.',
    answerSource: 'phase_deferred',
    status: 'deferred',
  }, { now: LATER });
  const fixture = await createApprovedBuildFixture({
    mode: 'milestone',
    questions: ledger.questions,
  });
  assert.equal(fixture.receipt.valid, true);
  assert.deepEqual(
    fixture.receipt.review_card.deferred_or_open_work.questions.map(({ id, status }) => ({
      id,
      status,
    })),
    [{ id: 'Q-01', status: 'deferred' }],
  );
});

test('milestone phase DAG has exact ownership, executable roots, and an aggregate completion fence', () => {
  const result = validateMilestonePhaseDag({
    phases: [
      phase('P-01'),
      phase('P-02', { depends_on: ['P-01'], mandatory: false }),
    ],
    requirements: ['R-01', 'R-02'],
    acceptanceCriteria: ['AC-01', 'AC-02'],
  });
  assert.deepEqual(result.topological_order, ['P-01', 'P-02']);
  assert.deepEqual(result.executable_roots, ['P-01']);
  assert.deepEqual(result.requirement_owners, { 'R-01': 'P-01', 'R-02': 'P-02' });
  assert.equal(result.phases.find(({ id }) => id === 'P-02').mandatory, false);
  assert.equal(result.completion_fence.length, 1, 'optional phase evidence is not mandatory fence evidence');
});

test('milestone phase DAG rejects cycles, orphan or duplicate ownership, task-only phases, and blocked starts', () => {
  assert.throws(() => validateMilestonePhaseDag({
    phases: [
      phase('P-01', { depends_on: ['P-02'] }),
      phase('P-02', { depends_on: ['P-01'] }),
    ],
    requirements: ['R-01', 'R-02'],
    acceptanceCriteria: ['AC-01', 'AC-02'],
  }), /cycle/);

  assert.throws(() => validateMilestonePhaseDag({
    phases: [phase('P-01')],
    requirements: ['R-01', 'R-02'],
    acceptanceCriteria: ['AC-01'],
  }), /orphan requirement: R-02/);

  assert.throws(() => validateMilestonePhaseDag({
    phases: [
      phase('P-01'),
      phase('P-02', { requirements: ['R-01'] }),
    ],
    requirements: ['R-01'],
    acceptanceCriteria: ['AC-01', 'AC-02'],
  }), /more than one owning phase/);

  assert.throws(() => validateMilestonePhaseDag({
    phases: [phase('P-01', { strategically_complete: false })],
    requirements: ['R-01'],
    acceptanceCriteria: ['AC-01'],
  }), /strategically complete/);

  assert.throws(() => validateMilestonePhaseDag({
    phases: [phase('P-01', {
      name: 'Write tests',
      outcome: 'Write tests',
      strategically_complete: true,
    })],
    requirements: ['R-01'],
    acceptanceCriteria: ['AC-01'],
  }), /generic task-only phase/);

  assert.throws(() => validateMilestonePhaseDag({
    phases: [phase('P-01', { blocking_questions: ['Q-01'] })],
    requirements: ['R-01'],
    acceptanceCriteria: ['AC-01'],
  }), /first milestone phase is not executable/);

  assert.throws(() => validateMilestonePhaseDag({
    phases: [phase('P-01', { mandatory: false })],
    requirements: ['R-01'],
    acceptanceCriteria: ['AC-01'],
  }), /at least one mandatory phase/);

  assert.throws(() => validateMilestonePhaseDag({
    phases: [
      phase('P-01', { mandatory: false }),
      phase('P-02', { depends_on: ['P-01'] }),
    ],
    requirements: ['R-01', 'R-02'],
    acceptanceCriteria: ['AC-01', 'AC-02'],
  }), /mandatory and cannot depend on optional/);
});

test('task-led phase variants require outcome-level beneficiary or transition value', () => {
  const validatePhase = (name, outcome) => validateMilestonePhaseDag({
    phases: [phase('P-01', { name, outcome, strategically_complete: true })],
    requirements: ['R-01'],
    acceptanceCriteria: ['AC-01'],
  });

  const taskOnlyVariants = [
    ['Write tests for billing', 'Write tests for billing'],
    ['Add integration tests to the invoice service', 'Add integration tests to the invoice service'],
    ['Create domain models for invoicing', 'Create domain models for invoicing'],
    ['Build schemas for customer billing', 'Build schemas for customer billing'],
    ['Add API documentation for operators', 'Add API documentation for operators'],
    ['Generate fixtures for the deployable billing workflow', 'Generate fixtures for the deployable billing workflow'],
    ['Refactor the invoice reconciliation service', 'Refactor the invoice reconciliation service'],
    ['Clean up billing code before release', 'Clean up billing code before release'],
  ];
  for (const [name, outcome] of taskOnlyVariants) {
    assert.throws(
      () => validatePhase(name, outcome),
      /generic task-only phase/,
      `${name} must not become strategic through trailing target words`,
    );
  }

  const adversarialKeywordOnlyOutcomes = [
    'Write tests for the billing capability',
    'Create models for the user workflow',
    'Add documentation for customers',
    'Refactor the deployable invoice service',
    'Add tests that support operators',
    'Deliver documentation for the billing capability',
    'Ship tests for a deployable workflow',
    'Add tests. Users can.',
    'Create models that enable operators to.',
  ];
  for (const outcome of adversarialKeywordOnlyOutcomes) {
    assert.throws(
      () => validatePhase('Write tests for billing', outcome),
      /generic task-only phase/,
      `${outcome} must not pass through strategic keyword stuffing`,
    );
  }

  const strategicOutcomes = [
    'Operators can reconcile invoices without direct database access.',
    'The billing workflow becomes independently useful and safely releasable.',
    'Deliver a deployable billing workflow with verified rollback behavior.',
    'This phase enables customers to correct invoice details before payment.',
    'Ship a decision-complete billing migration foundation.',
  ];
  for (const outcome of strategicOutcomes) {
    assert.doesNotThrow(
      () => validatePhase('Write tests for billing', outcome),
      `${outcome} states independent outcome value`,
    );
  }

  assert.throws(
    () => validatePhase('Reliability improvements', 'Improve reliability.'),
    /generic task-only phase outcome/,
    'a generic outcome must state who receives what independently useful transition',
  );
});

test('milestone requirements and roadmap exactly join every approved phase field', async () => {
  const fixture = await createApprovedBuildFixture({ mode: 'milestone' });
  const milestoneDirectory = fixture.milestoneDirectory;
  const requirementsPath = join(milestoneDirectory, 'REQUIREMENTS.md');
  const roadmapPath = join(milestoneDirectory, 'ROADMAP.md');
  const originalRequirements = await readFile(requirementsPath, 'utf8');
  const originalRoadmap = await readFile(roadmapPath, 'utf8');
  const prepare = () => prepareBuildContractDigests({
    root: fixture.root,
    mode: 'milestone',
    contractDirectory: fixture.contractDirectory,
    milestonePhaseDag: fixture.milestonePhaseDag,
  });
  const rejectsMutation = async (path, originalText, mutate, expected) => {
    const changed = mutate(originalText);
    assert.notEqual(changed, originalText, 'the adversarial fixture mutation must change bytes');
    await writeFile(path, changed);
    try {
      await assert.rejects(prepare(), expected);
    } finally {
      await writeFile(path, originalText);
    }
  };

  for (const [from, to, expected] of [
    [
      'Outcome: Deliver independently useful outcome 01',
      'Outcome: Deliver independently useful outcome 01 plus caller text',
      /Outcome must exactly match/,
    ],
    [
      'Outcome: Deliver independently useful outcome 01',
      'Outcome: Deliver independently useful outcome 01\nOutcome: Caller shadow outcome',
      /requires exactly one Outcome: field/,
    ],
    ['Depends on: None', 'Depends on: P-99', /Depends on must exactly match/],
    ['Requirements: R-01', 'Requirements: R-01, R-99', /Requirements must exactly match/],
    [
      'Acceptance criteria: AC-01',
      'Acceptance criteria: AC-01, AC-99',
      /Acceptance criteria must exactly match/,
    ],
    [
      'Protected behavior: Compatibility remains intact.',
      'Protected behavior: Compatibility remains intact., Caller addition',
      /Protected behavior must exactly match/,
    ],
    ['Expected artifacts: artifact-01', 'Expected artifacts: None', /Expected artifacts must exactly match/],
    ['Verification: evidence-01', 'Verification: evidence-01, forged', /Verification must exactly match/],
    ['Rollback boundary: Revert phase 01.', 'Rollback boundary: No rollback.', /Rollback boundary must exactly match/],
    ['Blocking questions: None', 'Blocking questions: Q-99', /Blocking questions must exactly match/],
    ['Goal handoff: Use cruise:goal for P-01.', 'Goal handoff: Run arbitrary work.', /Goal handoff must exactly match/],
    ['- P-01: evidence-01', '- P-01: evidence-01\n- P-99: forged', /completion fence must exactly match/],
  ]) {
    await rejectsMutation(roadmapPath, originalRoadmap, (text) => text.replace(from, to), expected);
  }

  for (const [from, to, expected] of [
    [
      'Acceptance criteria: AC-01.',
      'Acceptance criteria: AC-01, AC-99.',
      /Acceptance criteria must exactly match/,
    ],
    ['Owning phase: P-01.', 'Owning phase: P-01, P-99.', /Owning phase must exactly match/],
    ['Prerequisite phases: None.', 'Prerequisite phases: P-99.', /Prerequisite phases must exactly match/],
    ['Verification evidence: evidence-01.', 'Verification evidence: None.', /Verification evidence must exactly match/],
    [
      'Protected project principles: Compatibility remains intact..',
      'Protected project principles: Caller addition.',
      /Protected project principles must exactly match/,
    ],
  ]) {
    await rejectsMutation(
      requirementsPath,
      originalRequirements,
      (text) => text.replace(from, to),
      expected,
    );
  }

  await assert.doesNotReject(prepare());
});

test('workflow queue derives a deterministic DAG and excludes recursive Build, removed Review, and predicted Debug', () => {
  const definition = queue();
  assert.deepEqual(definition.items.find(({ id }) => id === 'QI-01').dependents, ['QI-02']);
  assert.deepEqual(definition.items.find(({ id }) => id === 'QI-02').requires, ['QI-01']);
  assert.match(workflowQueueDigest(definition), /^[a-f0-9]{64}$/u);

  assert.throws(() => queue([queueItem('QI-01', 'build')]), /skill must be one of/);
  assert.throws(() => queue([queueItem('QI-01', 'review')]), /skill must be one of/);
  assert.throws(() => queue([queueItem('QI-01', 'debug', { mode: 'scheduled' })]), /reactive mode/);
  assert.throws(
    () => queue([queueItem('QI-01', 'debug')]),
    /exactly one digest-bound prior-failure evidence artifact/,
  );
  assert.throws(() => queue([
    queueItem('QI-01', 'quick', { produces: ['failure-report'] }),
    queueItem('QI-02', 'debug', {
      requires: ['QI-01'],
      consumes: ['failure-report'],
    }),
  ]), /no scheduled predecessor/);
  assert.equal(queue([queueItem('QI-01', 'debug', {
    requires: [],
    consumes: [`cruise-failure-evidence:QI-09:${DIGEST_A}`],
    produces: ['root-cause-diagnosis'],
    acceptance_criteria: [],
  })]).items[0].mode, 'reactive');
  assert.throws(() => queue([queueItem('QI-01', 'goal', { status: 'running' })]), /queue-run\.yaml/);
  assert.throws(() => queue([queueItem('QI-01', 'goal', { blockers: ['waiting'] })]), /queue-run\.yaml/);
  assert.throws(() => queue([queueItem('QI-01', 'goal', { attempts: [{}] })]), /queue-run\.yaml/);
  assert.throws(() => queue([queueItem('QI-01', 'goal', { result: {} })]), /queue-run\.yaml/);
  assert.throws(() => queue([
    queueItem('QI-01', 'goal', { requires: ['QI-02'] }),
    queueItem('QI-02', 'research', { requires: ['QI-01'] }),
  ]), /cycle/);
  assert.throws(() => queue([
    queueItem('QI-01', 'goal', { requires: ['QI-99'] }),
  ]), /unknown queue item/);
});

test('queue coordination validation enforces declared dataflow and exact milestone Goal coverage', () => {
  const missingDataflow = queue([
    queueItem('QI-01', 'research', { produces: ['decision-brief'] }),
    queueItem('QI-02', 'goal', {
      requires: ['QI-01'],
      phase: 'P-01',
      consumes: [],
    }),
  ]);
  assert.throws(
    () => validateQueueCoordinationContract(missingDataflow, {
      milestonePhaseDag: [phase('P-01')],
    }),
    /no declared produce-to-consume dataflow/,
  );

  const perPhase = queue([
    queueItem('QI-01', 'research', { produces: ['decision-brief'] }),
    queueItem('QI-02', 'goal', {
      requires: ['QI-01'],
      phase: 'P-01',
      consumes: ['decision-brief'],
    }),
  ]);
  assert.equal(
    validateQueueCoordinationContract(perPhase, {
      milestonePhaseDag: [phase('P-01')],
    }).queue.id,
    'QUEUE-M-003',
  );
  assert.throws(
    () => validateQueueCoordinationContract(perPhase, {
      milestonePhaseDag: [phase('P-01'), phase('P-02')],
    }),
    /exactly one Goal item for every approved phase/,
  );

  const orderedGoals = queue([
    queueItem('QI-01', 'goal', {
      phase: 'P-01',
      produces: ['phase-one-result'],
    }),
    queueItem('QI-02', 'goal', {
      phase: 'P-02',
      requires: ['QI-01'],
      consumes: ['phase-one-result'],
      acceptance_criteria: ['AC-02'],
    }),
  ]);
  const orderedPhases = [
    phase('P-01'),
    phase('P-02', { depends_on: ['P-01'] }),
  ];
  assert.equal(
    validateQueueCoordinationContract(orderedGoals, {
      milestonePhaseDag: orderedPhases,
    }).items[1].requires[0],
    'QI-01',
  );
  const unorderedGoals = queue([
    queueItem('QI-01', 'goal', { phase: 'P-01' }),
    queueItem('QI-02', 'goal', {
      phase: 'P-02',
      acceptance_criteria: ['AC-02'],
    }),
  ]);
  assert.throws(
    () => validateQueueCoordinationContract(unorderedGoals, {
      milestonePhaseDag: orderedPhases,
    }),
    /Goal dependencies differ from approved phase P-02/,
  );

  const controller = queue([
    queueItem('QI-01', 'goal', {
      mode: 'milestone-controller',
      phase: null,
      acceptance_criteria: ['AC-01', 'AC-02'],
    }),
  ]);
  assert.equal(
    validateQueueCoordinationContract(controller, {
      milestonePhaseDag: [phase('P-01'), phase('P-02')],
    }).items[0].mode,
    'milestone-controller',
  );
  const incompleteController = structuredClone(controller);
  incompleteController.items[0].acceptance_criteria = ['AC-01'];
  assert.throws(
    () => validateQueueCoordinationContract(incompleteController, {
      milestonePhaseDag: [phase('P-01'), phase('P-02')],
    }),
    /cover every mandatory phase criterion exactly/,
  );
});

test('queue approval requires verified Build authority and remains digest-bound', async () => {
  const { activeQueue: definition, receipt } = await createApprovedBuildFixture({ mode: 'milestone' });
  assert.throws(() => createQueueApproval({
    queue: definition,
    mode: 'bootstrap',
    selectedLabel: 'Approve Foundation',
    approvedAt: NOW,
  }), /opaque verified Build approval receipt/);
  assert.throws(() => createQueueApproval({
    queue: definition,
    mode: 'milestone',
    selectedLabel: 'approve milestone',
    approvedAt: NOW,
    verifiedBuildApproval: receipt,
  }), /label differs/);
  const approval = createQueueApproval({
    queue: definition,
    mode: 'milestone',
    selectedLabel: 'Approve Milestone',
    approvedAt: NOW,
    verifiedBuildApproval: receipt,
  });
  assert.equal(verifyQueueApproval(definition, approval, { verifiedBuildApproval: receipt }), true);
  assert.throws(() => verifyQueueApproval(definition, approval), /opaque verified Build approval receipt/);
  assert.equal(approval.build_approval_digest, receipt.approval_digest);
  assert.equal(approval.build_manifest_digest, receipt.manifest.contract_digest);

  const changedPermission = structuredClone(definition);
  changedPermission.items[0].permissions_required = ['network:standards.example'];
  assert.throws(
    () => verifyQueueApproval(changedPermission, approval, { verifiedBuildApproval: receipt }),
    /not present in the verified Build approval manifest/,
  );

  const changedScope = structuredClone(definition);
  changedScope.items[0].scope = 'A wider unapproved scope';
  assert.throws(
    () => verifyQueueApproval(changedScope, approval, { verifiedBuildApproval: receipt }),
    /not present in the verified Build approval manifest/,
  );

  const changedDependency = structuredClone(definition);
  changedDependency.items[0].scope = 'Changed after approval';
  assert.throws(
    () => verifyQueueApproval(changedDependency, approval, { verifiedBuildApproval: receipt }),
    /not present in the verified Build approval manifest/,
  );
});

test('plain serialized state cannot use generic reducer, completion, or auto-start bypasses', () => {
  const definition = queue();
  const digest = workflowQueueDigest(definition);
  const forged = {
    kind: 'cruise_queue_state',
    queue_id: definition.queue.id,
    definition_sha256: digest,
    updated_at: NOW,
    items: definition.items.map((item) => ({
      id: item.id,
      status: 'completed',
      blockers: [],
      attempts: [],
      result: { claimed: 'complete without evidence' },
      updated_at: NOW,
    })),
  };
  assert.throws(
    () => createQueueState(definition, { now: NOW }),
    /direct queue reducers are disabled/,
  );
  assert.throws(
    () => reconcileQueueState(definition, forged, { now: NOW }),
    /direct queue reducers are disabled/,
  );
  assert.throws(
    () => queueCompletionStatus(definition, forged),
    /direct queue completion claims are disabled/,
  );
  assert.throws(
    () => evaluateQueueAutoStart({ queue: definition, state: forged, itemId: 'QI-01' }),
    /direct queue auto-start evaluation is disabled/,
  );
  assert.equal(workflowQueueDigest(definition), digest, 'mutable state must not alter locked queue bytes');
  assert.throws(() => updateQueueItemState(definition, forged, {
    id: 'QI-01',
    status: 'completed',
    result: { claimed: 'complete without evidence' },
  }), /evidence-aware Build queue coordinator/);
  assert.throws(() => updateQueueItemState(definition, forged, {
    id: 'QI-01',
    status: 'running',
    attempts: [{ replacement: true }],
  }), /evidence-aware Build queue coordinator/);
});

test('child origin is parent-bound and prevents scope expansion', () => {
  const definition = queue();
  const item = definition.items.find(({ id }) => id === 'QI-02');
  const child = createQueueChildOrigin({
    queue: definition,
    queueItemId: 'QI-02',
    inheritedOutcome: item.purpose,
    narrowedOutcome: item.scope,
    permittedChanges: item.permitted_changes,
    prohibitedChanges: item.prohibited_changes,
  });
  assert.deepEqual(child.parent, {
    origin_sha256: DIGEST_A,
    queue_id: 'QUEUE-M-003',
    queue_item_id: 'QI-02',
    project_id: 'PRJ-01',
    milestone_id: 'M-003',
    phase_id: 'P-01',
  });
  assert.equal(assertQueueChildScope(child, ['src/QI-02.mjs']), true);
  assert.throws(
    () => assertQueueChildScope(child, ['src/unapproved.mjs']),
    /scope expansion is forbidden/,
  );
  assert.throws(() => createQueueChildOrigin({
    queue: definition,
    queueItemId: 'QI-02',
    inheritedOutcome: 'Caller-invented wider outcome',
    narrowedOutcome: item.scope,
    permittedChanges: item.permitted_changes,
    prohibitedChanges: item.prohibited_changes,
  }), /outcomes must exactly match/);
  assert.throws(() => createQueueChildOrigin({
    queue: definition,
    queueItemId: 'QI-02',
    inheritedOutcome: item.purpose,
    narrowedOutcome: item.scope,
    permittedChanges: [...item.permitted_changes, 'src/unapproved.mjs'],
    prohibitedChanges: item.prohibited_changes,
  }), /path envelope must exactly match/);
  for (const unsafePath of [
    '../escape.mjs',
    'src/../escape.mjs',
    '/absolute',
    'C:/absolute',
    'src\\windows.mjs',
    'src/\0hidden.mjs',
  ]) {
    assert.throws(
      () => queue([queueItem('QI-01', 'quick', { permitted_changes: [unsafePath] })]),
      /safe repository-relative POSIX path/,
    );
  }
});

test('Build origin-bound auto-approval authorizes only the exact reviewed planning digest', async () => {
  assert.equal(hasExactBuildAutoApprovalDirective('--auto-approve\n\nBuild this.'), true);
  assert.equal(
    hasExactBuildAutoApprovalDirective(
      '[$cruise:build](/installed/skills/build/SKILL.md) --auto-approve\n\nBuild this.',
    ),
    true,
  );
  assert.equal(
    hasExactBuildAutoApprovalDirective('Build this.\n\nThe text --auto-approve is documentation.'),
    false,
  );
  assert.equal(hasExactBuildAutoApprovalDirective('Do not use --auto-approve'), false);

  const fixture = await createApprovedBuildFixture({ autoApprove: true });
  assert.equal(fixture.selection.source, 'origin_auto_approval');
  assert.equal(fixture.selection.review_digest, fixture.review.review_digest);
  assert.equal(fixture.receipt.label, 'Approve Foundation');
  assert.equal(fixture.activeQueue.items.every(({ status }) => status === 'draft'), true);
  assert.equal(fixture.activeQueue.items.every(({ auto_start }) => auto_start === false), false);

  const staleSelection = attestOriginBoundBuildAutoApprovalSelection({
    buildOriginPairAuthority: fixture.buildOriginPairAuthority,
    mode: 'bootstrap',
    reviewDigest: DIGEST_B,
    selectedAt: NOW,
  });
  await assert.rejects(
    captureBuildApproval({
      root: fixture.root,
      mode: 'bootstrap',
      contractDirectory: '.cruise/project',
      approvalSelection: staleSelection,
      repositoryBaselineDigest: fixture.repositoryBaselineDigest,
      firstMilestoneDirectory: '.cruise/milestones/M-003-billing',
      milestonePhaseDag: fixture.milestonePhaseDag,
      approvalReadiness: fixture.approvalReadiness,
      buildOriginPairAuthority: fixture.buildOriginPairAuthority,
      buildIdHistoryAuthority: fixture.buildIdHistoryAuthority,
      now: NOW,
    }),
    /changed after the displayed approval review/u,
  );

  const ordinary = await createApprovedBuildFixture();
  assert.throws(
    () => attestOriginBoundBuildAutoApprovalSelection({
      buildOriginPairAuthority: ordinary.buildOriginPairAuthority,
      mode: 'bootstrap',
      reviewDigest: ordinary.review.review_digest,
      selectedAt: NOW,
    }),
    /exact --auto-approve directive/u,
  );
});

test('Build approval requires host-structured provenance and returns an opaque verified receipt', async () => {
  const fixture = await createApprovedBuildFixture();
  const {
    root,
    projectDirectory: directory,
    approval,
    approvalReadiness,
    repositoryBaselineDigest,
    selection,
    receipt,
    buildOriginPairAuthority,
    buildIdHistoryAuthority,
  } = fixture;
  assert.equal(isApproveFoundationChoice('Approve Foundation'), true);
  assert.equal(isApproveFoundationChoice(' Approve Foundation'), false);
  assert.equal(isApproveMilestoneChoice('Approve Milestone'), true);
  assert.equal(isApproveMilestoneChoice('Approve Milestone\n'), false);
  assert.equal(isVerifiedBuildApproval(receipt), true);
  assert.equal(isVerifiedBuildApproval({ ...receipt }), false);
  assert.equal(receipt.manifest.milestone_id, 'M-003');
  assert.equal(receipt.manifest.locked_artifacts.length, 16);
  assert.equal(receipt.review_card.outcomes.foundation.text,
    'Every mandatory acceptance criterion closes with performed evidence.');
  assert.equal(receipt.review_card.outcomes.milestone.text,
    'Operators receive one safely executable, independently useful rollout outcome.');
  assert.equal(receipt.review_card.artifacts.length, 16);
  assert.equal(receipt.review_card.queues.length, 2);
  assert.deepEqual(receipt.review_card.phase_roadmap.completion_fence, [
    { phase_id: 'P-01', evidence: 'evidence-01' },
  ]);
  assert.equal(receipt.manifest.contract_digest, approval.manifest.contract_digest);
  const draftSemantics = await validateBuildDraftSemantics({
    root,
    mode: 'bootstrap',
    contractDirectory: '.cruise/project',
    firstMilestoneDirectory: '.cruise/milestones/M-003-billing',
    milestonePhaseDag: fixture.milestonePhaseDag,
    repositoryBaselineDigest,
    approvalReadinessDigest: approvalReadiness.readiness_digest,
  });
  assert.equal(draftSemantics.valid, true);
  assert.equal(draftSemantics.build_authorities, null);
  const artifactSnapshot = await verifyBuildApprovalArtifacts({
    root,
    verifiedBuildApproval: receipt,
    now: NOW,
  });
  assert.equal(
    isVerifiedBuildApprovalArtifactSnapshot(artifactSnapshot, {
      verifiedBuildApproval: receipt,
    }),
    true,
  );
  assert.equal(
    isVerifiedBuildApprovalArtifactSnapshot({ ...artifactSnapshot }, {
      verifiedBuildApproval: receipt,
    }),
    false,
  );

  assert.throws(() => approvalSelection('bootstrap', {
    source: 'typed_text',
  }), /typed or free-text/);
  assert.throws(() => approvalSelection('bootstrap', {
    selected_label: 'approve foundation',
  }), /exact option/);
  assert.throws(() => approvalSelection('bootstrap', {
    review_digest: undefined,
  }), /review_digest/);
  await assert.rejects(captureBuildApproval({
    root,
    mode: 'bootstrap',
    contractDirectory: '.cruise/project',
    approvalSelection: approvalSelection('bootstrap', { interaction_id: 'missing-first-milestone' }),
    approvalReadiness,
    repositoryBaselineDigest,
  }), /requires a first executable milestone contract/);
  await assert.rejects(captureBuildApproval({
    root,
    mode: 'bootstrap',
    contractDirectory: '.cruise/project',
    selectedLabel: 'approve foundation',
    repositoryBaselineDigest,
  }), /typed\/free-text selectedLabel cannot mint/);
  await assert.rejects(verifyBuildApproval({
    root,
    approval,
    approvalSelection: {
      kind: 'cruise_structured_build_approval_selection',
      mode: 'bootstrap',
      selected_label: 'Approve Foundation',
    },
    currentRepositoryBaselineDigest: repositoryBaselineDigest,
  }), /trusted opaque selection authority/);

  assert.match(approval.approval_digest, /^[a-f0-9]{64}$/u);
  await verifyBuildApproval({
    root,
    approval,
    approvalSelection: selection,
    currentRepositoryBaselineDigest: repositoryBaselineDigest,
    buildOriginPairAuthority,
    buildIdHistoryAuthority,
  });
  await assert.rejects(verifyBuildApproval({
    root,
    approval,
    approvalSelection: selection,
    currentRepositoryBaselineDigest: repositoryBaselineDigest,
  }), /opaque runtime authority/);

  const staleReview = await createApprovedBuildFixture();
  await writeFile(
    join(staleReview.projectDirectory, 'PROJECT.md'),
    '# Project PRJ-01\n\nChanged after the displayed review.\n',
  );
  await assert.rejects(captureBuildApproval({
    root: staleReview.root,
    mode: 'bootstrap',
    contractDirectory: '.cruise/project',
    firstMilestoneDirectory: '.cruise/milestones/M-003-billing',
    milestonePhaseDag: staleReview.milestonePhaseDag,
    approvalSelection: staleReview.selection,
    approvalReadiness: staleReview.approvalReadiness,
    repositoryBaselineDigest: staleReview.repositoryBaselineDigest,
    buildOriginPairAuthority: staleReview.buildOriginPairAuthority,
    buildIdHistoryAuthority: staleReview.buildIdHistoryAuthority,
  }), /changed after the displayed approval review|build_contract_digest does not match computed contract bytes|requires a non-empty Identity section/);

  await writeFile(join(directory, 'STATE.yaml'), 'status: active\n');
  await writeFile(join(directory, 'queue-run.yaml'), 'status: running\n');
  const runtimeArtifactSnapshot = await verifyBuildApprovalArtifacts({
    root,
    verifiedBuildApproval: receipt,
  });
  assert.equal(isVerifiedBuildApprovalArtifactSnapshot(runtimeArtifactSnapshot, {
    verifiedBuildApproval: receipt,
  }), true);
  await assert.rejects(verifyBuildApproval({
    root,
    approval,
    approvalSelection: selection,
    currentRepositoryBaselineDigest: repositoryBaselineDigest,
    buildOriginPairAuthority,
    buildIdHistoryAuthority,
  }), /STATE\.yaml/);

  await writeFile(join(directory, 'QUEUE.yaml'), 'changed queue membership\n');
  await assert.rejects(
    verifyBuildApprovalArtifacts({ root, verifiedBuildApproval: receipt }),
    /QUEUE\.yaml|valid Cruise YAML/,
  );
  await assert.rejects(
    verifyBuildApproval({
      root,
      approval,
      approvalSelection: selection,
      currentRepositoryBaselineDigest: repositoryBaselineDigest,
      buildOriginPairAuthority,
      buildIdHistoryAuthority,
    }),
    /QUEUE\.yaml|valid Cruise YAML/,
  );
  await assert.rejects(
    verifyBuildApproval({
      root,
      approval,
      approvalSelection: selection,
      currentRepositoryBaselineDigest: DIGEST_B,
    }),
    /repository baseline changed|differs from the deterministic probe/,
  );
});

test('milestone approval exposes the shared full project and milestone manifest', async () => {
  const fixture = await createApprovedBuildFixture({ mode: 'milestone' });
  const { approval, receipt } = fixture;
  assert.equal(approval.selected_label, 'Approve Milestone');
  assert.equal(approval.artifacts.length, 16);
  assert.equal(receipt.manifest.project_path, '.cruise/project');
  assert.equal(receipt.manifest.milestone_path, '.cruise/milestones/M-003-billing');
  assert.equal(
    receipt.manifest.locked_artifacts.some(({ path }) => path === '.cruise/project/PROJECT.md'),
    true,
  );
  assert.equal(
    receipt.manifest.locked_artifacts.some(({ path }) =>
      path === '.cruise/milestones/M-003-billing/AUTONOMY.yaml'),
    true,
  );
  assert.deepEqual(receipt.milestone_phase_dag.controller_phase_dag, [
    {
      id: 'P-01',
      depends_on: [],
      mandatory: true,
      acceptance_criteria: ['AC-01'],
    },
  ]);

  const tamperedDag = structuredClone(approval);
  tamperedDag.milestone_phase_dag.phases[0].verification = ['weakened evidence'];
  tamperedDag.milestone_phase_dag.completion_fence = [
    { phase_id: 'P-01', evidence: 'weakened evidence' },
  ];
  await assert.rejects(
    verifyBuildApproval({
      root: fixture.root,
      approval: tamperedDag,
      approvalSelection: fixture.selection,
      currentRepositoryBaselineDigest: fixture.repositoryBaselineDigest,
      buildOriginPairAuthority: fixture.buildOriginPairAuthority,
      buildIdHistoryAuthority: fixture.buildIdHistoryAuthority,
    }),
    /build_contract_digest|digest is stale or invalid|must exactly match the approved phase DAG/,
  );
  const partialReviewCard = structuredClone(approval);
  delete partialReviewCard.review_card.queues;
  await assert.rejects(
    verifyBuildApproval({
      root: fixture.root,
      approval: partialReviewCard,
      approvalSelection: fixture.selection,
      currentRepositoryBaselineDigest: fixture.repositoryBaselineDigest,
      buildOriginPairAuthority: fixture.buildOriginPairAuthority,
      buildIdHistoryAuthority: fixture.buildIdHistoryAuthority,
    }),
    /digest is stale or invalid/,
  );
});

test('Build byte locks reject symlink artifacts and symlinked path components', async () => {
  const fixture = await createApprovedBuildFixture();
  const { root, projectDirectory: directory, projectQueue } = fixture;
  const externalQueue = join(root, '.cruise', 'external-queue.yaml');
  await writeFile(externalQueue, 'items: []\n');
  await unlink(join(directory, 'QUEUE.yaml'));
  await symlink(externalQueue, join(directory, 'QUEUE.yaml'));
  await assert.rejects(captureBuildApproval({
    root,
    mode: 'bootstrap',
    contractDirectory: '.cruise/project',
    firstMilestoneDirectory: '.cruise/milestones/M-003-billing',
    milestonePhaseDag: fixture.milestonePhaseDag,
    approvalSelection: approvalSelection('bootstrap', { interaction_id: 'symlink-queue' }),
    approvalReadiness: fixture.approvalReadiness,
    repositoryBaselineDigest: fixture.repositoryBaselineDigest,
  }), /non-empty regular file/);

  await unlink(join(directory, 'QUEUE.yaml'));
  await writeFile(join(directory, 'QUEUE.yaml'), stringifyYaml(projectQueue));
  const externalDirectory = join(root, '.cruise', 'external-artifacts');
  await mkdir(externalDirectory);
  await writeFile(join(externalDirectory, 'EVIDENCE.md'), 'outside the contract directory\n');
  await symlink(externalDirectory, join(directory, 'linked'));
  await assert.rejects(captureBuildApproval({
    root,
    mode: 'bootstrap',
    contractDirectory: '.cruise/project',
    firstMilestoneDirectory: '.cruise/milestones/M-003-billing',
    milestonePhaseDag: fixture.milestonePhaseDag,
    approvalSelection: approvalSelection('bootstrap', { interaction_id: 'symlink-component' }),
    approvalReadiness: fixture.approvalReadiness,
    repositoryBaselineDigest: fixture.repositoryBaselineDigest,
    additionalArtifactPaths: ['linked/EVIDENCE.md'],
  }), /must not traverse symbolic links/);
});
