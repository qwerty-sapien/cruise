import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  answerBuildDiscoveryQuestion,
  attestBuildDiscoveryResume,
  attestPreApprovalResearchResult,
  attestPreApprovalResearchScopeApproval,
  authorizeAutomaticBuildDrafting,
  buildDiscoveryStateDigest,
  classifyBuildDiscoveryResearch,
  initializeBuildDiscovery,
  interruptBuildDiscovery,
  openNextBuildDiscoveryQuestion,
  persistBuildDiscovery,
  readPersistedBuildDiscovery,
  recordBuildDiscoveryLineage,
  recordAutomaticBuildDrafts,
  rehydrateBuildDiscovery,
  replayBuildDiscoveryState,
  requestPreApprovalBuildResearch,
  resumeBuildDiscovery,
  reconcilePreApprovalBuildResearch,
  serializeBuildDiscoveryState,
  startPreApprovalBuildResearch,
  validateDiscoveryConcepts,
  validateDiscoveryMarkdown,
  validateDiscoveryQuestions,
} from '../scripts/lib/build-discovery.mjs';
import {
  createWorkflowQueue,
  prepareBuildContractDigests,
} from '../scripts/lib/build-contract.mjs';
import { captureInitialBuildOrigin } from '../scripts/lib/build-history.mjs';
import { captureRepositoryBaseline } from '../scripts/lib/goal-contract.mjs';
import { createBuildOriginRecord } from '../scripts/lib/origin.mjs';
import { assertYamlSchema, parseYaml, stringifyYaml } from '../scripts/lib/yaml-state.mjs';
import {
  architectureMarkdown,
  autonomyState,
  installBuildHistoryAuthorities,
  milestoneMarkdown,
  milestoneRequirementsMarkdown,
  milestoneRoadmapMarkdown,
  milestoneState,
  projectMarkdown,
  projectRequirementsMarkdown,
  projectRoadmapMarkdown,
  projectState,
} from './helpers/build-contract-artifacts.mjs';

const NOW = '2026-07-13T00:00:00.000Z';
const LATER = '2026-07-13T01:00:00.000Z';
const LAST = '2026-07-13T02:00:00.000Z';
const AFTER = '2026-07-13T03:00:00.000Z';
const FINAL = '2026-07-13T04:00:00.000Z';
const BASELINE = 'b'.repeat(64);
const SOURCE_A = 'c'.repeat(64);
const SOURCE_B = 'd'.repeat(64);
const ARTIFACT = 'e'.repeat(64);
const READINESS = '9'.repeat(64);
const RESEARCH_QUESTION = 'Can the mandatory upstream API provide stable incremental events?';
const execFileAsync = promisify(execFile);

function discoveryOriginFixture(root) {
  const yaml = stringifyYaml(createBuildOriginRecord({
    rawPrompt: 'Develop a coherent event visibility product foundation.',
    repositoryBaseline: {
      root,
      head: null,
      branch: null,
      dirty_state_digest: BASELINE,
      instruction_files: [],
    },
    deterministicProbeDigest: 'f'.repeat(64),
    initialClassifier: 'test Build discovery classifier',
    confidence: 0.99,
    capturedAt: NOW,
    build: {
      mode: 'bootstrap',
      mode_candidate: 'bootstrap',
      mode_evidence: ['The fixture represents a new product foundation.'],
      target_project: 'PRJ-01',
      target_milestone: null,
    },
  }));
  return {
    yaml,
    sha256: createHash('sha256').update(yaml, 'utf8').digest('hex'),
  };
}

const DEFAULT_ORIGIN = discoveryOriginFixture(process.cwd());
const ORIGIN_YAML = DEFAULT_ORIGIN.yaml;
const ORIGIN = DEFAULT_ORIGIN.sha256;

function concept(id, overrides = {}) {
  return {
    id,
    title: `Concept ${id}`,
    outcome: 'Operators receive timely, verifiable event updates.',
    beneficiary: 'On-call operators',
    problem_or_opportunity: 'Delayed event visibility increases recovery time.',
    proposed_capabilities: ['Ingest incremental upstream events.'],
    non_goals: ['Replace the upstream system.'],
    value: ['Reduce time to detect missing events.'],
    implementation_outline: ['Deliver one read-only ingestion milestone.'],
    verification_outline: ['Replay a fixed event fixture without loss.'],
    dependencies: ['Existing upstream API.'],
    risks: ['The upstream API may not expose a stable event cursor.'],
    assumptions: ['Existing authentication remains valid.'],
    research_questions: [],
    viability: 'under_evaluation',
    status: 'active',
    lineage: {
      derived_from: [],
      merged_into: null,
    },
    status_reason: null,
    ...overrides,
  };
}

function concepts(runId, entries, selectedConceptId = null, originSha256 = ORIGIN) {
  return {
    schema_version: 1,
    kind: 'cruise_build_discovery_concepts',
    run_id: runId,
    origin_sha256: originSha256,
    selected_concept_id: selectedConceptId,
    concepts: entries,
  };
}

function evidence(runId, { research = null, originSha256 = ORIGIN } = {}) {
  const items = [
    {
      id: 'E-01',
      type: 'repository_observation',
      source: 'README.md and src/event-reader.mjs',
      claim: 'The repository already reads batch events but has no incremental cursor.',
      certainty: 'observed',
      supports: [
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
        'C-01',
      ],
      research_item_id: null,
      captured_at: NOW,
      source_sha256: SOURCE_A,
    },
  ];
  if (research) {
    items.push({
      id: 'E-02',
      type: 'research_finding',
      source: 'Approved upstream API capability investigation',
      claim: research.claim,
      certainty: research.certainty,
      supports: ['feasibility', 'plausible_implementation_path', 'C-01'],
      research_item_id: 'DR-01',
      captured_at: LATER,
      source_sha256: SOURCE_B,
    });
  }
  return {
    schema_version: 1,
    kind: 'cruise_build_discovery_evidence',
    run_id: runId,
    origin_sha256: originSha256,
    evidence: items,
  };
}

function readiness(runId, overrides = {}) {
  void runId;
  const categories = [
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

function viability(overrides = {}) {
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
      expected_value: 85,
      feasibility_confidence: 0.9,
      implementation_clarity: 85,
      verification_clarity: 90,
      reversibility: 90,
      operational_sustainability: 80,
    },
    unresolved: {
      user_decisions: [],
      research_questions: [],
      phase_local_questions: [],
    },
    outcome: 'ready_for_build',
    ...overrides,
  };
}

function markdown({ selected = null, rejected = [], research = 'None.' } = {}) {
  return `# Build Discovery

## What was explored

An incremental event workflow and bounded alternatives were evaluated.

## Selected concept

${selected ?? 'No concept is selected yet.'}

## Why it matters

Operators need timely, verifiable event visibility.

## Why it is feasible

Feasibility is recorded from repository and approved research evidence.

## Major alternatives considered

${rejected.length > 0 ? rejected.map(({ id }) => id).join(', ') : 'No material alternative was introduced.'}

## Rejected alternatives and reasons

${rejected.length > 0 ? rejected.map(({ id, reason }) => `${id}: ${reason}`).join('\n') : 'None yet.'}

## Unresolved phase-local issues

Any remaining issue is preserved in the viability snapshot.

## Research dependencies

${research}

## Recommended Build transition

${selected ? 'Draft the normal Build contract, then present its mandatory approval review.' : 'Continue discovery without creating a final Build contract.'}
`;
}

function questions(runId, entries = [], originSha256 = ORIGIN) {
  return {
    schema_version: 1,
    kind: 'cruise_build_discovery_questions',
    run_id: runId,
    origin_sha256: originSha256,
    questions: entries,
  };
}

function decisions({ rejectedReason = null } = {}) {
  if (rejectedReason === null) {
    return '# Discovery Decisions\n\nNo material decision has closed yet.\n';
  }
  return `# Discovery Decisions

## D-01 — Select the evidence-backed concept

Status: accepted
Concept: C-01
Decision: Select incremental operator event visibility.
Evidence: E-01
Rationale: It delivers measurable transition value through a bounded first milestone.
Tradeoffs: It preserves the upstream dependency instead of replacing it.
Reopening trigger: Approved research invalidates the incremental event path.
Supersedes: none

## D-02 — Reject upstream replacement

Status: rejected
Concept: C-02
Decision: Reject replacing the upstream system.
Evidence: E-01
Rationale: ${rejectedReason}
Tradeoffs: Existing upstream constraints remain, but the product avoids an incoherent expansion.
Reopening trigger: The upstream service is formally retired.
Supersedes: none
`;
}

function finalDiscoveryDecision(id, rejectedReason) {
  if (id === 'D-01') {
    return `# Decisions

## D-01 — Select the evidence-backed concept
Status: accepted
Concept: C-01
Decision: Select incremental operator event visibility.
Evidence: E-01
Rationale: It delivers measurable transition value through a bounded first milestone.
Tradeoffs: It preserves the upstream dependency instead of replacing it.
Reopening trigger: Approved research invalidates the incremental event path.
Supersedes: none
`;
  }
  return `# Decisions

## D-02 — Reject upstream replacement
Status: rejected
Concept: C-02
Decision: Reject replacing the upstream system.
Evidence: E-01
Rationale: ${rejectedReason}
Tradeoffs: Existing upstream constraints remain, but the product avoids an incoherent expansion.
Reopening trigger: The upstream service is formally retired.
Supersedes: none
`;
}

function initialize(runId, {
  originYaml = ORIGIN_YAML,
  originSha256 = ORIGIN,
  conceptsDocument,
  readinessDocument,
  viabilityDocument,
  evidenceDocument,
  questionsDocument = questions(runId, [], originSha256),
  decisionsMarkdown = decisions(),
  discoveryMarkdown,
  repositoryBaselineSha256 = BASELINE,
  pendingQuestionId = null,
} = {}) {
  return initializeBuildDiscovery({
    runId,
    modeCandidate: 'bootstrap',
    projectId: 'PRJ-01',
    originYaml,
    originSha256,
    repositoryBaselineSha256,
    consequence: 'medium',
    concepts: conceptsDocument,
    readiness: readinessDocument,
    viability: viabilityDocument,
    evidence: evidenceDocument,
    questions: questionsDocument,
    decisionsMarkdown,
    discoveryMarkdown,
    pendingQuestionId,
    now: NOW,
  });
}

function readyMaterial(runId, { phaseQuestions = [], originSha256 = ORIGIN } = {}) {
  const chosen = concept('C-01', {
    viability: 'ready_for_build',
    status: 'selected',
    status_reason: 'Best evidence-backed transition value.',
  });
  const rejectedReason = 'It duplicates the upstream system and expands scope without added value.';
  const rejected = concept('C-02', {
    title: 'Replace the upstream system',
    status: 'rejected',
    status_reason: rejectedReason,
  });
  return {
    conceptsDocument: concepts(runId, [chosen, rejected], 'C-01', originSha256),
    readinessDocument: readiness(runId),
    viabilityDocument: viability({
      unresolved: {
        user_decisions: [],
        research_questions: [],
        phase_local_questions: phaseQuestions,
      },
    }),
    evidenceDocument: evidence(runId, { originSha256 }),
    questionsDocument: questions(runId, [], originSha256),
    decisionsMarkdown: decisions({ rejectedReason }),
    discoveryMarkdown: markdown({
      selected: 'C-01 — Incremental operator event visibility.',
      rejected: [{ id: 'C-02', reason: rejectedReason }],
    }),
  };
}

function draftOriginCapture(root, mode) {
  return captureInitialBuildOrigin({
    rawPrompt: mode === 'bootstrap'
      ? 'Develop a coherent event visibility product foundation.'
      : 'Define the first independently useful event visibility milestone.',
    repositoryBaseline: {
      root,
      head: null,
      branch: null,
      dirty_state_digest: BASELINE,
      instruction_files: [],
    },
    deterministicProbeDigest: 'f'.repeat(64),
    initialClassifier: 'test Build discovery classifier',
    confidence: 0.99,
    capturedAt: NOW,
    build: {
      mode,
      mode_candidate: mode,
      mode_evidence: [mode === 'bootstrap'
        ? 'The fixture represents a new product foundation.'
        : 'Bootstrap requires one coherent first milestone.'],
      target_project: 'PRJ-01',
      target_milestone: mode === 'milestone' ? 'M-01' : null,
    },
  });
}

function draftPhase({ blockingQuestions = [] } = {}) {
  return {
    id: 'P-01',
    name: 'First value',
    outcome: 'Deliver independently useful incremental event visibility.',
    strategically_complete: true,
    depends_on: [],
    requirements: ['R-01'],
    acceptance_criteria: ['AC-01'],
    protected_behavior: ['Existing batch event reads remain intact.'],
    expected_artifacts: ['src/event-reader.mjs'],
    verification: ['Replay a fixed event fixture without loss.'],
    rollback_boundary: 'Revert the incremental cursor path while preserving batch reads.',
    blocking_questions: blockingQuestions,
    goal_handoff: 'Use cruise:goal for P-01.',
  };
}

function draftQueueItem(id, skill, overrides = {}) {
  return {
    id,
    skill,
    purpose: `Complete ${id}`,
    scope: `Only the approved ${id} scope`,
    status: 'draft',
    mode: '',
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

async function materializeBootstrapDrafts(root, {
  projectCapture,
  milestoneCapture,
  projectOrigin,
  milestoneOrigin,
  repositoryBaselineSha256,
  phaseQuestion,
  rewriteSelectedDecision = false,
  finalPhaseQuestion = phaseQuestion,
  omitMilestoneDecisionLink = false,
} = {}) {
  const projectPath = '.cruise/project';
  const milestonePath = '.cruise/milestones/M-01-first-value';
  const projectDirectory = join(root, projectPath);
  const milestoneDirectory = join(root, milestonePath);
  const questionIds = phaseQuestion == null ? [] : ['Q-01'];
  const rejectedReason = 'It duplicates the upstream system and expands scope without added value.';
  const milestonePhaseDag = [draftPhase()];
  const questionEntries = phaseQuestion == null ? [] : [{
    id: 'Q-01',
    status: 'deferred',
    materiality: 'nonblocking',
    category: 'operations',
    question: finalPhaseQuestion,
    evidence: ['Production timing evidence becomes available during P-01.'],
    recommendation: 'Use the repository-default retry window until phase evidence is available.',
    options: ['Use the repository default', 'Choose after timing evidence'],
    answer: null,
    answer_source: null,
    affects: ['P-01'],
    asked_at: NOW,
    answered_at: null,
    reopening_trigger: 'P-01 exposes production timing evidence.',
  }];
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(milestoneDirectory, { recursive: true });
  const lockedBodies = {
    [`${projectPath}/ORIGIN.yaml`]: projectOrigin,
    [`${projectPath}/PROJECT.md`]: projectMarkdown('PRJ-01'),
    [`${projectPath}/REQUIREMENTS.md`]: projectRequirementsMarkdown('M-01'),
    [`${projectPath}/ARCHITECTURE.md`]: architectureMarkdown(),
    [`${projectPath}/ROADMAP.md`]: projectRoadmapMarkdown('M-01'),
    [`${projectPath}/DECISIONS.md`]: rewriteSelectedDecision
      ? finalDiscoveryDecision('D-01', rejectedReason).replace(
        'Decision: Select incremental operator event visibility.',
        'Decision: Reuse D-01 for an unrelated administration dashboard.',
      )
      : finalDiscoveryDecision('D-01', rejectedReason),
    [`${milestonePath}/ORIGIN.yaml`]: milestoneOrigin,
    [`${milestonePath}/MILESTONE.md`]: milestoneMarkdown('M-01'),
    [`${milestonePath}/REQUIREMENTS.md`]: omitMilestoneDecisionLink
      ? milestoneRequirementsMarkdown(milestonePhaseDag)
      : milestoneRequirementsMarkdown(milestonePhaseDag)
        .replace('Acceptance criteria:', 'Decision links: D-01.\nAcceptance criteria:'),
    [`${milestonePath}/ROADMAP.md`]: milestoneRoadmapMarkdown(milestonePhaseDag),
    [`${milestonePath}/DECISIONS.md`]: finalDiscoveryDecision('D-02', rejectedReason),
    [`${milestonePath}/QUESTIONS.yaml`]: stringifyYaml({ questions: questionEntries }),
    [`${milestonePath}/AUTONOMY.yaml`]: stringifyYaml(autonomyState()),
  };
  for (const [path, body] of Object.entries(lockedBodies)) await writeFile(join(root, path), body);
  const digests = await prepareBuildContractDigests({
    root,
    mode: 'bootstrap',
    contractDirectory: projectPath,
    firstMilestoneDirectory: milestonePath,
    milestonePhaseDag,
  });
  const projectOriginSha256 = createHash('sha256').update(projectOrigin, 'utf8').digest('hex');
  const milestoneOriginSha256 = createHash('sha256').update(milestoneOrigin, 'utf8').digest('hex');
  const projectQueue = createWorkflowQueue({
    id: 'QUEUE-PRJ-01',
    projectId: 'PRJ-01',
    originSha256: projectOriginSha256,
    buildContractDigest: digests.project_contract_digest,
    items: [draftQueueItem('QI-01', 'quick', {
      acceptance_criteria: [],
      auto_start: true,
      auto_start_conditions: ['host_ready'],
    })],
  });
  const milestoneQueue = createWorkflowQueue({
    id: 'QUEUE-M-01',
    projectId: 'PRJ-01',
    milestoneId: 'M-01',
    originSha256: milestoneOriginSha256,
    buildContractDigest: digests.build_contract_digest,
    items: [draftQueueItem('QI-01', 'goal', { phase: 'P-01' })],
  });
  await writeFile(join(projectDirectory, 'QUEUE.yaml'), stringifyYaml(projectQueue));
  await writeFile(join(milestoneDirectory, 'QUEUE.yaml'), stringifyYaml(milestoneQueue));
  await installBuildHistoryAuthorities({
    root,
    projectCapture,
    milestoneCapture,
    projectOriginBytes: projectOrigin,
    milestoneOriginBytes: milestoneOrigin,
    milestonePath,
    at: NOW,
  });
  await writeFile(join(projectDirectory, 'STATE.yaml'), stringifyYaml(projectState({
    milestoneId: 'M-01',
    repositoryBaselineDigest: repositoryBaselineSha256,
    readinessDigest: READINESS,
    originSha256: projectOriginSha256,
    contractDigest: digests.project_contract_digest,
    queue: projectQueue,
    reconciledAt: NOW,
  })));
  await writeFile(join(milestoneDirectory, 'STATE.yaml'), stringifyYaml(milestoneState({
    milestoneId: 'M-01',
    repositoryBaselineDigest: repositoryBaselineSha256,
    readinessDigest: READINESS,
    originSha256: milestoneOriginSha256,
    contractDigest: digests.build_contract_digest,
    queue: milestoneQueue,
    openQuestions: questionIds,
    firstPhaseId: 'P-01',
    reconciledAt: NOW,
  })));
  const paths = [
    `${projectPath}/ORIGIN.yaml`, `${projectPath}/ID-REGISTRY.yaml`,
    `${projectPath}/PROJECT.md`, `${projectPath}/REQUIREMENTS.md`,
    `${projectPath}/ARCHITECTURE.md`, `${projectPath}/ROADMAP.md`,
    `${projectPath}/DECISIONS.md`, `${projectPath}/STATE.yaml`, `${projectPath}/QUEUE.yaml`,
    `${milestonePath}/ORIGIN.yaml`, `${milestonePath}/MILESTONE.md`,
    `${milestonePath}/REQUIREMENTS.md`, `${milestonePath}/ROADMAP.md`,
    `${milestonePath}/DECISIONS.md`, `${milestonePath}/QUESTIONS.yaml`,
    `${milestonePath}/AUTONOMY.yaml`, `${milestonePath}/STATE.yaml`, `${milestonePath}/QUEUE.yaml`,
  ];
  const artifacts = [];
  for (const path of paths) {
    const body = await readFile(join(root, path));
    artifacts.push({ path, sha256: createHash('sha256').update(body).digest('hex') });
  }
  return { artifacts, milestonePhaseDag, milestonePath };
}

async function automaticDraftLineageSubject({
  runId,
  phaseQuestion = null,
  materializeOverrides = {},
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `cruise-${runId}-`)));
  const repositoryBaselineSha256 = captureRepositoryBaseline(root).sha256;
  const projectCapture = draftOriginCapture(root, 'bootstrap');
  const milestoneCapture = draftOriginCapture(root, 'milestone');
  const projectOrigin = stringifyYaml(projectCapture.origin_record);
  const milestoneOrigin = stringifyYaml(milestoneCapture.origin_record);
  const projectOriginSha256 = createHash('sha256').update(projectOrigin, 'utf8').digest('hex');
  const run = initialize(runId, {
    ...readyMaterial(runId, {
      originSha256: projectOriginSha256,
      phaseQuestions: phaseQuestion == null ? [] : [phaseQuestion],
    }),
    originYaml: projectOrigin,
    originSha256: projectOriginSha256,
    repositoryBaselineSha256,
  });
  const authority = authorizeAutomaticBuildDrafting(run, {
    currentOriginSha256: projectOriginSha256,
    currentRepositoryBaselineSha256: repositoryBaselineSha256,
    now: LATER,
  });
  const { artifacts, milestonePhaseDag } = await materializeBootstrapDrafts(root, {
    projectCapture,
    milestoneCapture,
    projectOrigin,
    milestoneOrigin,
    repositoryBaselineSha256,
    phaseQuestion,
    ...materializeOverrides,
  });
  return {
    root,
    repositoryBaselineSha256,
    run,
    authority,
    manifest: {
      mode: 'bootstrap',
      approved: false,
      selected_concept_id: 'C-01',
      rejected_concept_ids: ['C-02'],
      requirement_ids: ['R-01', 'R-90'],
      acceptance_criteria_ids: ['AC-01', 'AC-90'],
      decision_ids: ['D-01', 'D-02'],
      phase_local_questions: phaseQuestion == null ? [] : [phaseQuestion],
      research_prerequisites: [],
      approval_readiness_digest: READINESS,
      milestone_phase_dag: milestonePhaseDag,
      artifacts,
      generated_at: LATER,
    },
  };
}

function discoveryPersistenceRuns(runId, root) {
  const origin = discoveryOriginFixture(root);
  const base = initialize(runId, {
    ...readyMaterial(runId, { originSha256: origin.sha256 }),
    originYaml: origin.yaml,
    originSha256: origin.sha256,
  });
  const successor = interruptBuildDiscovery(base, {
    reason: 'Persist an exact resumable interruption checkpoint.',
    now: LATER,
  });
  return { base, successor, origin };
}

test('failed viability hard gate persists discovery but cannot mint draft authority or final artifacts', async () => {
  const runId = 'discovery-unviable';
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cruise-discovery-unviable-')));
  const origin = discoveryOriginFixture(root);
  const evidenceDocument = evidence(runId, { originSha256: origin.sha256 });
  const readinessDocument = readiness(runId, {
    feasibility: { status: 'conflicting', evidence: ['E-01'] },
  });
  const viabilityDocument = viability({
    critical_gates: {
      ...viability().critical_gates,
      plausible_implementation: 'fail',
    },
    supporting_dimensions: {
      ...viability().supporting_dimensions,
      expected_value: 100,
      feasibility_confidence: 1,
    },
    outcome: 'not_currently_viable',
  });
  const run = initialize(runId, {
    originYaml: origin.yaml,
    originSha256: origin.sha256,
    conceptsDocument: concepts(runId, [concept('C-01')], null, origin.sha256),
    readinessDocument,
    viabilityDocument,
    evidenceDocument,
    discoveryMarkdown: markdown(),
  });

  assert.equal(run.state.snapshot.status, 'not_currently_viable');
  assert.throws(
    () => authorizeAutomaticBuildDrafting(run, {
      currentOriginSha256: origin.sha256,
      currentRepositoryBaselineSha256: BASELINE,
      now: LATER,
    }),
    /every deterministic viability hard gate to pass/,
  );

  const checkpoint = await persistBuildDiscovery({
    root,
    directory: '.cruise/project/discovery',
    run,
  });
  assert.deepEqual(Object.keys(checkpoint.artifacts).sort(), [
    'CONCEPTS.yaml',
    'DECISIONS.md',
    'DISCOVERY.md',
    'EVIDENCE.yaml',
    'ORIGIN.yaml',
    'QUESTIONS.yaml',
  ]);
  assert.equal(checkpoint.state_path, `.cruise/runs/${runId}/BUILD-DISCOVERY.yaml`);
  await assert.rejects(access(join(root, '.cruise/project/PROJECT.md')));

  const persisted = await readPersistedBuildDiscovery({
    root,
    directory: '.cruise/project/discovery',
    runId,
  });
  assert.equal(persisted.state.origin_yaml, origin.yaml);
  await writeFile(
    join(root, '.cruise/project/discovery/QUESTIONS.yaml'),
    'questions: []\n',
  );
  await assert.rejects(
    readPersistedBuildDiscovery({
      root,
      directory: '.cruise/project/discovery',
      runId,
    }),
    /QUESTIONS.yaml changed after the discovery checkpoint/,
  );

  const serialized = serializeBuildDiscoveryState(run);
  const stateSchema = parseYaml(await readFile(
    join(process.cwd(), 'internal/schemas/build-discovery-state.schema.yaml'),
    'utf8',
  ));
  assert.doesNotThrow(() => assertYamlSchema(serialized, stateSchema, {
    name: 'Build discovery state',
  }));
  const forged = structuredClone(serialized);
  forged.snapshot.status = 'ready_for_build';
  assert.throws(() => replayBuildDiscoveryState(forged), /differs from replayed history|status must be/);
  assert.throws(
    () => rehydrateBuildDiscovery({
      serializedState: serialized,
      currentOriginSha256: origin.sha256,
      currentRepositoryBaselineSha256: BASELINE,
    }),
    /opaque host discovery-resume attestation/,
  );
});

test('discovery persistence rejects stale ancestors and forked branded runs with immutable CAS history', async () => {
  const runId = 'discovery-persistence-cas';
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cruise-discovery-cas-')));
  const { base, successor } = discoveryPersistenceRuns(runId, root);
  const fork = interruptBuildDiscovery(base, {
    reason: 'This competing branch must never replace the selected successor.',
    now: LATER,
  });

  const first = await persistBuildDiscovery({
    root,
    directory: '.cruise/project/discovery',
    run: base,
  });
  assert.equal(first.checkpoint_revision, 0);
  const second = await persistBuildDiscovery({
    root,
    directory: '.cruise/project/discovery',
    run: successor,
  });
  assert.equal(second.checkpoint_revision, 1);

  await assert.rejects(
    persistBuildDiscovery({
      root,
      directory: '.cruise/project/discovery',
      run: base,
    }),
    /stale Build discovery ancestor/,
  );
  await assert.rejects(
    persistBuildDiscovery({
      root,
      directory: '.cruise/project/discovery',
      run: fork,
    }),
    /forks from persisted event history/,
  );
  const persisted = await readPersistedBuildDiscovery({
    root,
    directory: '.cruise/project/discovery',
    runId,
  });
  assert.equal(persisted.state_sha256, buildDiscoveryStateDigest(successor));
  assert.equal(persisted.checkpoint_revision, 1);
  const generations = await readdir(
    join(root, `.cruise/runs/${runId}/BUILD-DISCOVERY-HISTORY`),
  );
  assert.equal(generations.length, 2);
  assert.ok(generations.every((name) => /^REV-\d{12}-[a-f0-9]{64}$/u.test(name)));
});

test('discovery persistence and reads are bound to Origin repository_baseline.root', async () => {
  const runId = 'discovery-origin-root-binding';
  const originRoot = await realpath(await mkdtemp(join(tmpdir(), 'cruise-discovery-origin-root-')));
  const otherRoot = await realpath(await mkdtemp(join(tmpdir(), 'cruise-discovery-other-root-')));
  const { base } = discoveryPersistenceRuns(runId, originRoot);

  await assert.rejects(
    persistBuildDiscovery({
      root: otherRoot,
      directory: '.cruise/project/discovery',
      run: base,
    }),
    /persistence root does not match Origin repository_baseline\.root/,
  );
  await assert.rejects(access(join(otherRoot, '.cruise')));

  await persistBuildDiscovery({
    root: originRoot,
    directory: '.cruise/project/discovery',
    run: base,
  });
  await cp(join(originRoot, '.cruise'), join(otherRoot, '.cruise'), { recursive: true });
  await assert.rejects(
    readPersistedBuildDiscovery({
      root: otherRoot,
      directory: '.cruise/project/discovery',
      runId,
    }),
    /persistence root does not match Origin repository_baseline\.root/,
  );
});

test('durable lineage rejects head/history deletion after fresh-process rehydration', async () => {
  const runId = 'discovery-lineage-deletion';
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cruise-discovery-lineage-delete-')));
  const { base, successor } = discoveryPersistenceRuns(runId, root);
  await persistBuildDiscovery({
    root,
    directory: '.cruise/project/discovery',
    run: base,
  });
  await persistBuildDiscovery({
    root,
    directory: '.cruise/project/discovery',
    run: successor,
  });

  const stateDirectory = join(root, `.cruise/runs/${runId}`);
  const lineagePath = join(stateDirectory, 'BUILD-DISCOVERY-LINEAGE.yaml');
  await access(lineagePath);
  await rm(join(stateDirectory, 'BUILD-DISCOVERY.yaml'));
  await rm(join(stateDirectory, 'BUILD-DISCOVERY-HISTORY'), { recursive: true });
  const serializedPath = join(root, 'deleted-lineage-candidate.json');
  await writeFile(serializedPath, JSON.stringify(serializeBuildDiscoveryState(successor)));
  const moduleUrl = pathToFileURL(
    join(process.cwd(), 'scripts/lib/build-discovery.mjs'),
  ).href;
  const child = `
    import { readFile } from 'node:fs/promises';
    const discovery = await import(${JSON.stringify(moduleUrl)});
    const state = JSON.parse(await readFile(${JSON.stringify(serializedPath)}, 'utf8'));
    const resumeAttestation = discovery.attestBuildDiscoveryResume({
      kind: 'host_build_discovery_resume_event',
      source: 'cruise_host_adapter',
      interaction_id: 'deleted-lineage-rehydration',
      run_id: state.run_id,
      state_sha256: discovery.buildDiscoveryStateDigest(state),
      origin_sha256: state.origin_sha256,
      repository_baseline_sha256: state.repository_baseline_sha256,
      observed_at: ${JSON.stringify(AFTER)},
    });
    const run = discovery.rehydrateBuildDiscovery({
      serializedState: state,
      resumeAttestation,
      currentOriginSha256: state.origin_sha256,
      currentRepositoryBaselineSha256: state.repository_baseline_sha256,
    });
    try {
      await discovery.persistBuildDiscovery({
        root: ${JSON.stringify(root)},
        directory: '.cruise/project/discovery',
        run,
      });
    } catch (error) {
      process.stderr.write(String(error?.message ?? error));
      process.exit(73);
    }
  `;
  await assert.rejects(
    execFileAsync(process.execPath, ['--input-type=module', '-e', child]),
    (error) =>
      error?.code === 73 &&
      /durable lineage anchor survives a missing checkpoint/.test(error.stderr),
  );
  await access(lineagePath);
  await assert.rejects(access(join(stateDirectory, 'BUILD-DISCOVERY.yaml')));
  await assert.rejects(access(join(stateDirectory, 'BUILD-DISCOVERY-HISTORY')));
  await assert.rejects(
    readPersistedBuildDiscovery({
      root,
      directory: '.cruise/project/discovery',
      runId,
    }),
    /durable lineage anchor survives a missing checkpoint/,
  );
});

test('discovery resume fails closed when an immutable predecessor generation is rewritten', async () => {
  const runId = 'discovery-history-tamper';
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cruise-discovery-history-tamper-')));
  const { base, successor } = discoveryPersistenceRuns(runId, root);
  await persistBuildDiscovery({
    root,
    directory: '.cruise/project/discovery',
    run: base,
  });
  await persistBuildDiscovery({
    root,
    directory: '.cruise/project/discovery',
    run: successor,
  });
  const historyDirectory = join(
    root,
    `.cruise/runs/${runId}/BUILD-DISCOVERY-HISTORY`,
  );
  const revisionZero = (await readdir(historyDirectory))
    .find((name) => name.startsWith('REV-000000000000-'));
  assert.ok(revisionZero);
  const priorQuestions = join(historyDirectory, revisionZero, 'QUESTIONS.yaml');
  await rm(priorQuestions);
  await writeFile(priorQuestions, 'questions: []\n');
  await assert.rejects(
    readPersistedBuildDiscovery({
      root,
      directory: '.cruise/project/discovery',
      runId,
    }),
    /QUESTIONS.yaml changed after the discovery checkpoint|immutable checkpoint history is broken/,
  );
});

test('pending discovery generations recover after every canonical-file and head commit fault', async () => {
  const faultPoints = [
    'intent:committed',
    ...[
      'ORIGIN.yaml',
      'CONCEPTS.yaml',
      'QUESTIONS.yaml',
      'EVIDENCE.yaml',
      'DECISIONS.md',
      'DISCOVERY.md',
    ].flatMap((name) => [
      `canonical:${name}:prepared`,
      `canonical:${name}:committed`,
    ]),
    'head:prepared',
    'head:committed',
    'lineage:prepared',
    'lineage:committed',
  ];

  for (const [index, faultPoint] of faultPoints.entries()) {
    const runId = `discovery-fault-${String(index).padStart(2, '0')}`;
    const root = await realpath(await mkdtemp(join(tmpdir(), `${runId}-`)));
    const { base, successor } = discoveryPersistenceRuns(runId, root);
    await persistBuildDiscovery({
      root,
      directory: '.cruise/project/discovery',
      run: base,
    });
    await assert.rejects(
      persistBuildDiscovery({
        root,
        directory: '.cruise/project/discovery',
        run: successor,
      }, {
        faultInjector(step) {
          if (step === faultPoint) throw new Error(`injected discovery persistence fault: ${step}`);
        },
      }),
      new RegExp(`injected discovery persistence fault: ${faultPoint.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'),
    );

    const recovered = await readPersistedBuildDiscovery({
      root,
      directory: '.cruise/project/discovery',
      runId,
    });
    assert.equal(recovered.state_sha256, buildDiscoveryStateDigest(successor), faultPoint);
    assert.equal(recovered.checkpoint_revision, 1, faultPoint);
    await assert.rejects(access(
      join(root, `.cruise/runs/${runId}/BUILD-DISCOVERY-PENDING.yaml`),
    ));
    assert.deepEqual(
      (await readdir(join(root, '.cruise/project/discovery'))).sort(),
      [
        'CONCEPTS.yaml',
        'DECISIONS.md',
        'DISCOVERY.md',
        'EVIDENCE.yaml',
        'ORIGIN.yaml',
        'QUESTIONS.yaml',
      ],
      faultPoint,
    );
  }
});

test('faults before the durable discovery intent preserve the old head and allow exact retry', async () => {
  for (const [index, faultPoint] of [
    'generation:QUESTIONS.yaml:written',
    'generation:published',
    'intent:prepared',
  ].entries()) {
    const runId = `discovery-precommit-fault-${index}`;
    const root = await realpath(await mkdtemp(join(tmpdir(), `${runId}-`)));
    const { base, successor } = discoveryPersistenceRuns(runId, root);
    await persistBuildDiscovery({
      root,
      directory: '.cruise/project/discovery',
      run: base,
    });
    await assert.rejects(
      persistBuildDiscovery({
        root,
        directory: '.cruise/project/discovery',
        run: successor,
      }, {
        faultInjector(step) {
          if (step === faultPoint) throw new Error(`precommit fault: ${step}`);
        },
      }),
      /precommit fault/,
    );
    const unchanged = await readPersistedBuildDiscovery({
      root,
      directory: '.cruise/project/discovery',
      runId,
    });
    assert.equal(unchanged.state_sha256, buildDiscoveryStateDigest(base), faultPoint);
    assert.equal(unchanged.checkpoint_revision, 0, faultPoint);

    const retried = await persistBuildDiscovery({
      root,
      directory: '.cruise/project/discovery',
      run: successor,
    });
    assert.equal(retried.state_sha256, buildDiscoveryStateDigest(successor), faultPoint);
    assert.equal(retried.checkpoint_revision, 1, faultPoint);
  }
});

test('fresh process reclaims a crashed writer, rolls the exact pending generation forward, and resumes', async () => {
  const runId = 'discovery-process-crash';
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cruise-discovery-process-crash-')));
  const { base, successor, origin } = discoveryPersistenceRuns(runId, root);
  await persistBuildDiscovery({
    root,
    directory: '.cruise/project/discovery',
    run: base,
  });
  const serializedPath = join(root, 'candidate-discovery-state.json');
  await writeFile(serializedPath, JSON.stringify(serializeBuildDiscoveryState(successor)));
  const moduleUrl = pathToFileURL(
    join(process.cwd(), 'scripts/lib/build-discovery.mjs'),
  ).href;
  const child = `
    import { readFile } from 'node:fs/promises';
    const discovery = await import(${JSON.stringify(moduleUrl)});
    const state = JSON.parse(await readFile(${JSON.stringify(serializedPath)}, 'utf8'));
    const stateSha256 = discovery.buildDiscoveryStateDigest(state);
    const resumeAttestation = discovery.attestBuildDiscoveryResume({
      kind: 'host_build_discovery_resume_event',
      source: 'cruise_host_adapter',
      interaction_id: 'child-crash-rehydrate',
      run_id: ${JSON.stringify(runId)},
      state_sha256: stateSha256,
      origin_sha256: ${JSON.stringify(origin.sha256)},
      repository_baseline_sha256: ${JSON.stringify(BASELINE)},
      observed_at: ${JSON.stringify(LATER)},
    });
    const run = discovery.rehydrateBuildDiscovery({
      serializedState: state,
      resumeAttestation,
      currentOriginSha256: ${JSON.stringify(origin.sha256)},
      currentRepositoryBaselineSha256: ${JSON.stringify(BASELINE)},
    });
    await discovery.persistBuildDiscovery({
      root: ${JSON.stringify(root)},
      directory: '.cruise/project/discovery',
      run,
    }, {
      faultInjector(step) {
        if (step === 'canonical:QUESTIONS.yaml:prepared') process.exit(86);
      },
    });
  `;
  await assert.rejects(
    execFileAsync(process.execPath, ['--input-type=module', '-e', child]),
    (error) => error?.code === 86,
  );

  const recovered = await readPersistedBuildDiscovery({
    root,
    directory: '.cruise/project/discovery',
    runId,
  });
  assert.equal(recovered.state_sha256, buildDiscoveryStateDigest(successor));
  assert.equal(recovered.checkpoint_revision, 1);
  await assert.rejects(access(
    join(root, `.cruise/runs/${runId}/BUILD-DISCOVERY.lock`),
  ));

  const resumeAttestation = attestBuildDiscoveryResume({
    kind: 'host_build_discovery_resume_event',
    source: 'cruise_host_adapter',
    interaction_id: 'parent-resume-after-process-crash',
    run_id: runId,
    state_sha256: recovered.state_sha256,
    origin_sha256: origin.sha256,
    repository_baseline_sha256: BASELINE,
    observed_at: AFTER,
  });
  const rehydrated = rehydrateBuildDiscovery({
    serializedState: recovered.state,
    resumeAttestation,
    currentOriginSha256: origin.sha256,
    currentRepositoryBaselineSha256: BASELINE,
  });
  const resumed = resumeBuildDiscovery(rehydrated, {
    resumeAttestation,
    now: FINAL,
  });
  assert.equal(resumed.state.snapshot.cursor.interrupted, false);
  assert.equal(resumed.state.run_id, runId);
});

test('discovery persistence rejects symlinked immutable-history storage without writing outside root', async () => {
  const runId = 'discovery-history-symlink';
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cruise-discovery-symlink-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'cruise-discovery-outside-')));
  const stateDirectory = join(root, `.cruise/runs/${runId}`);
  await mkdir(stateDirectory, { recursive: true });
  await symlink(outside, join(stateDirectory, 'BUILD-DISCOVERY-HISTORY'));
  const { base } = discoveryPersistenceRuns(runId, root);
  await assert.rejects(
    persistBuildDiscovery({
      root,
      directory: '.cruise/project/discovery',
      run: base,
    }),
    /symlink in discovery persistence path|safe directory/,
  );
  assert.deepEqual(await readdir(outside), []);
});

test('approved pre-approval Research resumes the same interrupted Build run and contradiction reopens readiness', async () => {
  const runId = 'discovery-research-return';
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cruise-discovery-resume-')));
  const origin = discoveryOriginFixture(root);
  const initialEvidence = evidence(runId, { originSha256: origin.sha256 });
  const initialConcepts = concepts(runId, [concept('C-01', {
    research_questions: [RESEARCH_QUESTION],
  })], null, origin.sha256);
  const initialReadiness = readiness(runId, {
    plausible_implementation_path: { status: 'partial', evidence: ['E-01'] },
    feasibility: { status: 'missing', evidence: [] },
    research_blockers: [RESEARCH_QUESTION],
  });
  const initialViability = viability({
    critical_gates: {
      ...viability().critical_gates,
      plausible_implementation: 'research_needed',
      constraints_compatible: 'research_needed',
    },
    supporting_dimensions: {
      ...viability().supporting_dimensions,
      feasibility_confidence: 0.4,
    },
    unresolved: {
      user_decisions: [],
      research_questions: [RESEARCH_QUESTION],
      phase_local_questions: [],
    },
    outcome: 'research_required',
  });
  let run = initialize(runId, {
    originYaml: origin.yaml,
    originSha256: origin.sha256,
    conceptsDocument: initialConcepts,
    readinessDocument: initialReadiness,
    viabilityDocument: initialViability,
    evidenceDocument: initialEvidence,
    discoveryMarkdown: markdown({ research: RESEARCH_QUESTION }),
  });
  const classification = classifyBuildDiscoveryResearch({
    feasibilityBlocking: true,
    milestoneInvalidationPossible: true,
  });
  assert.deepEqual(classification, {
    type: 'pre_approval_blocker',
    blocks_build_approval: true,
  });
  run = requestPreApprovalBuildResearch(run, {
    id: 'DR-01',
    conceptId: 'C-01',
    question: RESEARCH_QUESTION,
    scope: 'Read only the upstream API capability documentation and one local adapter.',
    decisionImpact: 'Determines whether the proposed mandatory event cursor can exist.',
    classification,
    now: NOW,
  });
  const request = run.state.snapshot.research_items[0];
  const approval = attestPreApprovalResearchScopeApproval({
    kind: 'host_structured_choice_event',
    source: 'request_user_input',
    input_kind: 'option_selection',
    interaction_id: 'research-approval-1',
    option_id: 'approve_research_scope',
    selected_label: 'Approve Research Scope',
    offered_options: [
      { id: 'approve_research_scope', label: 'Approve Research Scope' },
      { id: 'revise', label: 'Revise' },
    ],
    run_id: runId,
    research_id: 'DR-01',
    request_sha256: request.request_sha256,
    selected_at: NOW,
  });
  run = startPreApprovalBuildResearch(run, {
    researchId: 'DR-01',
    approval,
    now: LATER,
  });
  run = interruptBuildDiscovery(run, {
    reason: 'Host session ended while approved Research was running.',
    now: LATER,
  });
  assert.equal(run.state.snapshot.cursor.resume_stage, 'reconcile_pre_approval_research');

  await persistBuildDiscovery({ root, directory: '.cruise/project/discovery', run });
  const persisted = await readPersistedBuildDiscovery({
    root,
    directory: '.cruise/project/discovery',
    runId,
  });
  const resumeAttestation = attestBuildDiscoveryResume({
    kind: 'host_build_discovery_resume_event',
    source: 'cruise_host_adapter',
    interaction_id: 'resume-1',
    run_id: runId,
    state_sha256: persisted.state_sha256,
    origin_sha256: origin.sha256,
    repository_baseline_sha256: BASELINE,
    observed_at: LAST,
  });
  run = rehydrateBuildDiscovery({
    serializedState: persisted.state,
    resumeAttestation,
    currentOriginSha256: origin.sha256,
    currentRepositoryBaselineSha256: BASELINE,
    researchApprovals: [approval],
  });
  run = resumeBuildDiscovery(run, { resumeAttestation, now: LAST });
  assert.equal(run.state.run_id, runId);
  assert.equal(run.state.snapshot.status, 'research_in_progress');
  assert.equal(run.state.snapshot.cursor.interrupted, false);
  assert.equal(run.state.snapshot.cursor.resume_count, 1);

  const contradictoryEvidence = evidence(runId, {
    originSha256: origin.sha256,
    research: {
      claim: 'The upstream API has no stable cursor and explicitly drops historical incremental events.',
      certainty: 'contradicted',
    },
  });
  const result = attestPreApprovalResearchResult({
    kind: 'cruise_research_closeout_event',
    source: 'cruise_research_adapter',
    parent_build_run_id: runId,
    origin_sha256: origin.sha256,
    research_id: 'DR-01',
    request_sha256: request.request_sha256,
    evidence: contradictoryEvidence,
    evidence_ids: ['E-02'],
    conclusion: 'contradicts',
    completed_at: LAST,
  });
  const reopenedReadiness = readiness(runId, {
    plausible_implementation_path: { status: 'conflicting', evidence: ['E-01', 'E-02'] },
    feasibility: { status: 'conflicting', evidence: ['E-02'] },
  });
  const reopenedViability = viability({
    critical_gates: {
      ...viability().critical_gates,
      plausible_implementation: 'fail',
      constraints_compatible: 'fail',
    },
    supporting_dimensions: {
      ...viability().supporting_dimensions,
      feasibility_confidence: 0.1,
    },
    outcome: 'not_currently_viable',
  });
  run = reconcilePreApprovalBuildResearch(run, {
    result,
    concepts: initialConcepts,
    readiness: reopenedReadiness,
    viability: reopenedViability,
    evidence: contradictoryEvidence,
    questions: questions(runId, [], origin.sha256),
    decisionsMarkdown: decisions(),
    discoveryMarkdown: markdown({
      research: 'DR-01 contradicted the mandatory cursor assumption; narrow or defer the concept.',
    }),
    now: LAST,
  });
  assert.equal(run.state.run_id, runId);
  assert.equal(run.state.snapshot.status, 'not_currently_viable');
  assert.equal(run.state.snapshot.research_items[0].status, 'reconciled');
  assert.equal(run.state.snapshot.research_items[0].result.conclusion, 'contradicts');
  assert.throws(
    () => authorizeAutomaticBuildDrafting(run, {
      currentOriginSha256: origin.sha256,
      currentRepositoryBaselineSha256: BASELINE,
      now: LAST,
    }),
    /hard gate to pass/,
  );
});

test('selected and rejected concept lineage is mandatory and preserved in DISCOVERY.md', () => {
  const runId = 'discovery-lineage';
  const material = readyMaterial(runId);
  const run = initialize(runId, material);
  assert.equal(run.state.snapshot.concepts.selected_concept_id, 'C-01');
  assert.equal(run.state.snapshot.concepts.concepts[1].status, 'rejected');

  const missingReason = structuredClone(material.conceptsDocument);
  missingReason.concepts[1].status_reason = null;
  assert.throws(
    () => validateDiscoveryConcepts(missingReason, { viabilityOutcome: 'ready_for_build' }),
    /status_reason/,
  );
  assert.throws(
    () => validateDiscoveryMarkdown(
      material.discoveryMarkdown.replace(
        'It duplicates the upstream system and expands scope without added value.',
        'A reason was accidentally omitted.',
      ),
      { concepts: material.conceptsDocument, viabilityOutcome: 'ready_for_build' },
    ),
    /preserve rejected concept C-02 and its reason/,
  );
  assert.throws(
    () => recordBuildDiscoveryLineage(run, {
      concepts: {
        ...material.conceptsDocument,
        concepts: [material.conceptsDocument.concepts[0]],
      },
      evidence: material.evidenceDocument,
      decisionsMarkdown: material.decisionsMarkdown,
      readiness: material.readinessDocument,
      viability: material.viabilityDocument,
      discoveryMarkdown: material.discoveryMarkdown,
      now: LATER,
    }),
    /concept lineage is append-only and cannot delete C-XX history/,
  );
  const rewrittenDisposition = structuredClone(material.conceptsDocument);
  rewrittenDisposition.concepts[1].status_reason = 'A later rewrite replaced the rejected rationale.';
  assert.throws(
    () => recordBuildDiscoveryLineage(run, {
      concepts: rewrittenDisposition,
      evidence: material.evidenceDocument,
      decisionsMarkdown: material.decisionsMarkdown,
      readiness: material.readinessDocument,
      viability: material.viabilityDocument,
      discoveryMarkdown: material.discoveryMarkdown,
      now: LATER,
    }),
    /terminal concept disposition reason C-02:rejected is immutable/,
  );
  assert.throws(
    () => recordBuildDiscoveryLineage(run, {
      concepts: material.conceptsDocument,
      evidence: {
        ...material.evidenceDocument,
        evidence: [],
      },
      decisionsMarkdown: material.decisionsMarkdown,
      readiness: material.readinessDocument,
      viability: material.viabilityDocument,
      discoveryMarkdown: material.discoveryMarkdown,
      now: LATER,
    }),
    /evidence history is append-only and cannot delete E-XX records/,
  );
  const withoutRejectedDecision = material.decisionsMarkdown.replace(
    /\n## D-02[\s\S]*$/u,
    '\n',
  );
  assert.throws(
    () => recordBuildDiscoveryLineage(run, {
      concepts: material.conceptsDocument,
      evidence: material.evidenceDocument,
      decisionsMarkdown: withoutRejectedDecision,
      readiness: material.readinessDocument,
      viability: material.viabilityDocument,
      discoveryMarkdown: material.discoveryMarkdown,
      now: LATER,
    }),
    /decision history is append-only and cannot delete D-XX records|must preserve rejected C-02/,
  );
});

test('QUESTIONS.yaml permits one material question and preserves its cursor across interruption resume', () => {
  const runId = 'discovery-question-resume';
  const openQuestion = {
    id: 'Q-01',
    status: 'open',
    materiality: 'project_blocking',
    category: 'beneficiary',
    question: 'Which operator group owns the first measurable recovery outcome?',
    evidence: ['E-01'],
    recommendation: 'Start with the on-call operators already represented in this repository.',
    options: ['On-call operators', 'Platform administrators'],
    answer: null,
    answer_source: null,
    affects: ['beneficiary', 'C-01'],
    asked_at: NOW,
    answered_at: null,
    reopening_trigger: null,
  };
  const questionsDocument = questions(runId, [openQuestion]);
  const secondQuestionText = 'Which measurable recovery signal is mandatory for the first milestone?';
  const userDecisionViability = viability({
    unresolved: {
      user_decisions: [openQuestion.question, secondQuestionText],
      research_questions: [],
      phase_local_questions: [],
    },
    outcome: 'user_decision_required',
  });
  const run = initialize(runId, {
    conceptsDocument: concepts(runId, [concept('C-01')]),
    readinessDocument: readiness(runId, {
      beneficiary: { status: 'partial', evidence: ['E-01'] },
      user_decisions_required: [openQuestion.question, secondQuestionText],
    }),
    viabilityDocument: userDecisionViability,
    evidenceDocument: evidence(runId),
    questionsDocument,
    decisionsMarkdown: decisions(),
    discoveryMarkdown: markdown(),
    pendingQuestionId: 'Q-01',
  });
  assert.equal(run.state.snapshot.cursor.pending_question_id, 'Q-01');
  assert.throws(
    () => validateDiscoveryQuestions(questions(runId, [
      openQuestion,
      { ...openQuestion, id: 'Q-02', question: 'What is the second unresolved choice?' },
    ]), { evidence: evidence(runId) }),
    /exactly one material question at a time/,
  );

  const interrupted = interruptBuildDiscovery(run, {
    reason: 'The host session ended before the answer arrived.',
    pendingQuestionId: 'Q-01',
    now: LATER,
  });
  const serialized = serializeBuildDiscoveryState(interrupted);
  const resumeAttestation = attestBuildDiscoveryResume({
    kind: 'host_build_discovery_resume_event',
    source: 'cruise_host_adapter',
    interaction_id: 'resume-question-1',
    run_id: runId,
    state_sha256: buildDiscoveryStateDigest(serialized),
    origin_sha256: ORIGIN,
    repository_baseline_sha256: BASELINE,
    observed_at: LAST,
  });
  const rehydrated = rehydrateBuildDiscovery({
    serializedState: serialized,
    resumeAttestation,
    currentOriginSha256: ORIGIN,
    currentRepositoryBaselineSha256: BASELINE,
  });
  let resumed = resumeBuildDiscovery(rehydrated, { resumeAttestation, now: LAST });
  assert.equal(resumed.state.run_id, runId);
  assert.equal(resumed.state.snapshot.cursor.pending_question_id, 'Q-01');
  assert.equal(resumed.state.snapshot.questions.questions[0].id, 'Q-01');

  resumed = answerBuildDiscoveryQuestion(resumed, {
    questionId: 'Q-01',
    answer: 'On-call operators own the first outcome.',
    answerSource: 'direct_user_response',
    evidenceItem: {
      id: 'E-02',
      type: 'user_statement',
      source: 'Direct answer to Q-01',
      claim: 'On-call operators are the primary beneficiary.',
      certainty: 'observed',
      supports: ['beneficiary', 'C-01', 'Q-01'],
      research_item_id: null,
      source_sha256: SOURCE_B,
    },
    readiness: readiness(runId, {
      beneficiary: { status: 'clear', evidence: ['E-02'] },
      measurable_completion: { status: 'partial', evidence: ['E-01'] },
      user_decisions_required: [secondQuestionText],
    }),
    viability: viability({
      unresolved: {
        user_decisions: [secondQuestionText],
        research_questions: [],
        phase_local_questions: [],
      },
      outcome: 'user_decision_required',
    }),
    discoveryMarkdown: markdown(),
    now: AFTER,
  });
  assert.equal(resumed.state.snapshot.status, 'question_resolved');
  assert.equal(resumed.state.snapshot.cursor.pending_question_id, null);
  const staleCursor = serializeBuildDiscoveryState(resumed);
  staleCursor.snapshot.cursor.pending_question_id = 'Q-01';
  assert.throws(
    () => replayBuildDiscoveryState(staleCursor),
    /resolved question cursor must clear|differs from replayed history/,
  );

  resumed = openNextBuildDiscoveryQuestion(resumed, {
    question: {
      id: 'Q-02',
      materiality: 'project_blocking',
      category: 'measurable_completion',
      question: secondQuestionText,
      evidence: ['E-01'],
      recommendation: 'Use time-to-detect a missing event as the first measurable signal.',
      options: ['Time-to-detect', 'Event throughput'],
      affects: ['measurable_completion', 'C-01'],
      reopening_trigger: null,
    },
    now: AFTER,
  });
  assert.equal(resumed.state.snapshot.cursor.pending_question_id, 'Q-02');
  resumed = answerBuildDiscoveryQuestion(resumed, {
    questionId: 'Q-02',
    answer: 'Time-to-detect is mandatory.',
    answerSource: 'direct_user_response',
    evidenceItem: {
      id: 'E-03',
      type: 'user_statement',
      source: 'Direct answer to Q-02',
      claim: 'The first milestone must measure time-to-detect.',
      certainty: 'observed',
      supports: ['measurable_completion', 'C-01', 'Q-02'],
      research_item_id: null,
      source_sha256: '1'.repeat(64),
    },
    readiness: readiness(runId, {
      feasibility: { status: 'missing', evidence: [] },
      research_blockers: [RESEARCH_QUESTION],
    }),
    viability: viability({
      critical_gates: {
        ...viability().critical_gates,
        plausible_implementation: 'research_needed',
      },
      supporting_dimensions: {
        ...viability().supporting_dimensions,
        feasibility_confidence: 0.5,
      },
      unresolved: {
        user_decisions: [],
        research_questions: [RESEARCH_QUESTION],
        phase_local_questions: [],
      },
      outcome: 'research_required',
    }),
    discoveryMarkdown: markdown({ research: RESEARCH_QUESTION }),
    now: FINAL,
  });
  assert.equal(resumed.state.snapshot.status, 'research_required');
  assert.deepEqual(
    resumed.state.snapshot.questions.questions.map(({ id, status }) => ({ id, status })),
    [
      { id: 'Q-01', status: 'answered' },
      { id: 'Q-02', status: 'answered' },
    ],
  );
});

test('viable concept receives one-use authority only after real complete unapproved Build drafts verify', async () => {
  const runId = 'discovery-drafting';
  const phaseQuestion = 'Choose the retry window only after P-01 exposes production timing evidence.';
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cruise-discovery-drafts-')));
  const repositoryBaselineSha256 = captureRepositoryBaseline(root).sha256;
  const projectCapture = draftOriginCapture(root, 'bootstrap');
  const milestoneCapture = draftOriginCapture(root, 'milestone');
  const projectOrigin = stringifyYaml(projectCapture.origin_record);
  const milestoneOrigin = stringifyYaml(milestoneCapture.origin_record);
  const projectOriginSha256 = createHash('sha256').update(projectOrigin, 'utf8').digest('hex');
  const run = initialize(runId, {
    ...readyMaterial(runId, {
      phaseQuestions: [phaseQuestion],
      originSha256: projectOriginSha256,
    }),
    originYaml: projectOrigin,
    originSha256: projectOriginSha256,
    repositoryBaselineSha256,
  });
  const authority = authorizeAutomaticBuildDrafting(run, {
    currentOriginSha256: projectOriginSha256,
    currentRepositoryBaselineSha256: repositoryBaselineSha256,
    now: LATER,
  });
  assert.equal(authority.scope, 'draft_build_artifacts_only');
  assert.equal(authority.approves_artifacts, false);
  assert.equal(authority.permits_product_writes, false);
  assert.equal(authority.permits_goal_activation, false);

  const { artifacts, milestonePhaseDag } = await materializeBootstrapDrafts(root, {
    projectCapture,
    milestoneCapture,
    projectOrigin,
    milestoneOrigin,
    repositoryBaselineSha256,
    phaseQuestion,
  });
  const manifest = {
    mode: 'bootstrap',
    approved: false,
    selected_concept_id: 'C-01',
    rejected_concept_ids: ['C-02'],
    requirement_ids: ['R-01', 'R-90'],
    acceptance_criteria_ids: ['AC-01', 'AC-90'],
    decision_ids: ['D-01', 'D-02'],
    phase_local_questions: [phaseQuestion],
    research_prerequisites: [],
    approval_readiness_digest: READINESS,
    milestone_phase_dag: milestonePhaseDag,
    artifacts,
    generated_at: LATER,
  };
  await assert.rejects(
    recordAutomaticBuildDrafts(run, {
      root,
      authority,
      manifest: {
        ...manifest,
        artifacts: [...artifacts, { path: 'src/product-write.mjs', sha256: ARTIFACT }],
      },
      currentRepositoryBaselineSha256: repositoryBaselineSha256,
      now: LATER,
    }),
    /outside the final Build artifact boundary/,
  );
  await assert.rejects(
    recordAutomaticBuildDrafts(run, {
      root,
      authority,
      manifest: {
        ...manifest,
        artifacts: artifacts.slice(1),
      },
      currentRepositoryBaselineSha256: repositoryBaselineSha256,
      now: LATER,
    }),
    /complete canonical Build set/,
  );
  await assert.rejects(
    recordAutomaticBuildDrafts(run, {
      root,
      authority,
      manifest: {
        ...manifest,
        artifacts: artifacts.map((artifact, index) =>
          index === 1 ? { ...artifact, sha256: ARTIFACT } : artifact),
      },
      currentRepositoryBaselineSha256: repositoryBaselineSha256,
      now: LATER,
    }),
    /bytes do not match declared SHA-256/,
  );
  const projectPath = join(root, '.cruise/project/PROJECT.md');
  const projectBytes = await readFile(projectPath);
  const sparseProject = '# PRJ-01 sparse project\n\nNo semantic contract sections are present.\n';
  await writeFile(projectPath, sparseProject);
  const sparseProjectSha256 = createHash('sha256').update(sparseProject, 'utf8').digest('hex');
  await assert.rejects(
    recordAutomaticBuildDrafts(run, {
      root,
      authority,
      manifest: {
        ...manifest,
        artifacts: artifacts.map((artifact) => artifact.path === '.cruise/project/PROJECT.md'
          ? { ...artifact, sha256: sparseProjectSha256 }
          : artifact),
      },
      currentRepositoryBaselineSha256: repositoryBaselineSha256,
      now: LATER,
    }),
    /PROJECT\.md requires a non-empty .* section/,
  );
  await writeFile(projectPath, projectBytes);
  await assert.rejects(
    recordAutomaticBuildDrafts(run, {
      root,
      authority,
      manifest: { ...manifest, decision_ids: ['D-01', 'D-03'] },
      currentRepositoryBaselineSha256: repositoryBaselineSha256,
      now: LATER,
    }),
    /draft manifest decision IDs differs/,
  );
  await assert.rejects(
    recordAutomaticBuildDrafts(run, {
      root,
      authority,
      manifest: { ...manifest, requirement_ids: ['R-01', 'R-99'] },
      currentRepositoryBaselineSha256: repositoryBaselineSha256,
      now: LATER,
    }),
    /draft manifest requirement IDs differs/,
  );
  await assert.rejects(
    recordAutomaticBuildDrafts(run, {
      root,
      authority,
      manifest: {
        ...manifest,
        research_prerequisites: ['Investigate an unrelated speculative dependency.'],
      },
      currentRepositoryBaselineSha256: repositoryBaselineSha256,
      now: LATER,
    }),
    /post-approval research prerequisite lineage differs/,
  );
  const drafted = await recordAutomaticBuildDrafts(run, {
    root,
    authority,
    manifest,
    currentRepositoryBaselineSha256: repositoryBaselineSha256,
    now: LATER,
  });
  assert.equal(drafted.state.snapshot.status, 'draft_ready_for_review');
  assert.equal(drafted.state.snapshot.draft_manifest.approved, false);
  assert.equal(drafted.state.snapshot.cursor.stage, 'normal_build_approval_review');
  assert.match(
    drafted.state.history.at(-1).payload.semantic_validation_sha256,
    /^[a-f0-9]{64}$/u,
  );
  await assert.rejects(
    recordAutomaticBuildDrafts(run, {
      root,
      authority,
      manifest,
      currentRepositoryBaselineSha256: repositoryBaselineSha256,
      now: LAST,
    }),
    /fresh opaque automatic-drafting authority/,
  );
});

test('automatic drafting rejects a semantically valid final artifact that reuses a discovery D-XX meaning', async () => {
  const runId = 'discovery-reused-decision';
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cruise-discovery-reused-d-')));
  const repositoryBaselineSha256 = captureRepositoryBaseline(root).sha256;
  const projectCapture = draftOriginCapture(root, 'bootstrap');
  const milestoneCapture = draftOriginCapture(root, 'milestone');
  const projectOrigin = stringifyYaml(projectCapture.origin_record);
  const milestoneOrigin = stringifyYaml(milestoneCapture.origin_record);
  const projectOriginSha256 = createHash('sha256').update(projectOrigin, 'utf8').digest('hex');
  const run = initialize(runId, {
    ...readyMaterial(runId, { originSha256: projectOriginSha256 }),
    originYaml: projectOrigin,
    originSha256: projectOriginSha256,
    repositoryBaselineSha256,
  });
  const authority = authorizeAutomaticBuildDrafting(run, {
    currentOriginSha256: projectOriginSha256,
    currentRepositoryBaselineSha256: repositoryBaselineSha256,
    now: LATER,
  });
  const { artifacts, milestonePhaseDag } = await materializeBootstrapDrafts(root, {
    projectCapture,
    milestoneCapture,
    projectOrigin,
    milestoneOrigin,
    repositoryBaselineSha256,
    rewriteSelectedDecision: true,
  });
  await assert.rejects(
    recordAutomaticBuildDrafts(run, {
      root,
      authority,
      manifest: {
        mode: 'bootstrap',
        approved: false,
        selected_concept_id: 'C-01',
        rejected_concept_ids: ['C-02'],
        requirement_ids: ['R-01', 'R-90'],
        acceptance_criteria_ids: ['AC-01', 'AC-90'],
        decision_ids: ['D-01', 'D-02'],
        phase_local_questions: [],
        research_prerequisites: [],
        approval_readiness_digest: READINESS,
        milestone_phase_dag: milestonePhaseDag,
        artifacts,
        generated_at: LATER,
      },
      currentRepositoryBaselineSha256: repositoryBaselineSha256,
      now: LATER,
    }),
    /reused or rewrote discovery decision D-01/,
  );
});

test('automatic drafting rejects missing decision-to-requirement and phase-question joins', async () => {
  const missingMapping = await automaticDraftLineageSubject({
    runId: 'discovery-missing-requirement-map',
    materializeOverrides: { omitMilestoneDecisionLink: true },
  });
  await assert.rejects(
    recordAutomaticBuildDrafts(missingMapping.run, {
      root: missingMapping.root,
      authority: missingMapping.authority,
      manifest: missingMapping.manifest,
      currentRepositoryBaselineSha256: missingMapping.repositoryBaselineSha256,
      now: LATER,
    }),
    /R-01 does not map an accepted discovery D-XX decision to AC-XX evidence/,
  );

  const phaseQuestion = 'Choose the retry window after phase evidence is available.';
  const changedQuestion = await automaticDraftLineageSubject({
    runId: 'discovery-changed-phase-question',
    phaseQuestion,
    materializeOverrides: {
      finalPhaseQuestion: 'Choose a different unrelated phase-local preference.',
    },
  });
  await assert.rejects(
    recordAutomaticBuildDrafts(changedQuestion.run, {
      root: changedQuestion.root,
      authority: changedQuestion.authority,
      manifest: changedQuestion.manifest,
      currentRepositoryBaselineSha256: changedQuestion.repositoryBaselineSha256,
      now: LATER,
    }),
    /phase-local question lineage differs/,
  );
});
