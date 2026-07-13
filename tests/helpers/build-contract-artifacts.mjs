import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  AUTONOMY_DECISION_POLICY,
  AUTONOMY_HARD_STOPS,
  attestBuildReadinessEvidence,
  BOOTSTRAP_LOCKED_FILES,
  BUILD_ID_REGISTRY_PATH,
  MILESTONE_LOCKED_FILES,
  READINESS_CATEGORIES,
  VIABILITY_CRITICAL_GATES,
  VIABILITY_SUPPORTING_DIMENSIONS,
  workflowQueueDigest,
} from '../../scripts/lib/build-contract.mjs';
import {
  attestBuildOriginPair,
  attestValidatedBuildIdHistory,
  allocateBuildIdentifier,
  createBuildIdRegistry,
  createBuildIdRegistrySnapshot,
  importInitialBuildIdentifiers,
  reconcileBuildIdRegistry,
  scanBuildIdentifiers,
  writeBuildIdRegistry,
} from '../../scripts/lib/build-history.mjs';

const list = (values, empty = 'None') => values.length === 0 ? empty : values.join(', ');

/** Build a single source-bound fixture record that can be cited by every closed gate. */
export function buildApprovalEvidenceFixture({
  repositoryRoot,
  repositoryBaselineDigest,
  projectOriginSha256,
  milestoneOriginSha256,
  mode,
  conceptId = 'C-01',
} = {}) {
  const signal = mode === 'bootstrap'
    ? 'explicit_initialize_request'
    : 'explicit_milestone_request';
  const sourceLocator = mode === 'bootstrap' ? 'origin://project' : 'origin://milestone';
  const sourceSha256 = mode === 'bootstrap' ? projectOriginSha256 : milestoneOriginSha256;
  const evidenceAuthority = attestBuildReadinessEvidence({
    repositoryRoot,
    repositoryBaselineDigest,
    projectOriginSha256,
    milestoneOriginSha256,
    evidence: [{
      id: 'E-01',
      type: 'origin_statement',
      source_locator: sourceLocator,
      source_sha256: sourceSha256,
      claim: mode === 'bootstrap'
        ? 'The immutable project Origin requests a coherent initialized foundation.'
        : 'The immutable milestone Origin requests the next coherent milestone.',
      certainty: 'observed',
      supports: [
        `repository:${signal}`,
        ...READINESS_CATEGORIES.map((category) => `readiness:${category}`),
        ...VIABILITY_CRITICAL_GATES.map((gate) => `viability:${gate}`),
        ...VIABILITY_SUPPORTING_DIMENSIONS.map((field) => `viability:${field}`),
        `concept:${conceptId}`,
      ],
    }],
  });
  return {
    evidenceAuthority,
    repositoryEvidence: { [signal]: ['E-01'] },
    readinessEvidence: ['E-01'],
  };
}

export async function installBuildHistoryAuthorities({
  root,
  projectCapture,
  milestoneCapture,
  projectOriginBytes,
  milestoneOriginBytes,
  milestonePath,
  additionalArtifactPaths = [],
  at = '2026-07-13T00:00:00.000Z',
} = {}) {
  const canonicalPaths = [
    ...BOOTSTRAP_LOCKED_FILES.map((name) => `.cruise/project/${name}`),
    ...MILESTONE_LOCKED_FILES.map((name) => `${milestonePath}/${name}`),
    ...additionalArtifactPaths,
  ];
  const artifacts = [];
  for (const path of [...new Set(canonicalPaths)]) {
    artifacts.push({ path, content: await readFile(join(root, path)) });
  }
  const pair = attestBuildOriginPair({
    project: {
      attestation: projectCapture.attestation,
      record: projectCapture.origin_record,
      bytes: projectOriginBytes,
    },
    milestone: {
      attestation: milestoneCapture.attestation,
      record: milestoneCapture.origin_record,
      bytes: milestoneOriginBytes,
    },
    repositoryRoot: root,
    projectId: projectCapture.origin_record.build.target_project,
    milestoneId: milestoneCapture.origin_record.build.target_milestone,
  });
  const previousRegistry = createBuildIdRegistry({
    initialBuildOriginAttestation: projectCapture.attestation,
    originRecord: projectCapture.origin_record,
    at,
  });
  const seededIds = new Set(previousRegistry.records.map(({ id }) => id));
  const identities = scanBuildIdentifiers(artifacts)
    .filter(({ id }) => !seededIds.has(id))
    .map(({ id }) => ({ id, stable_key: `canonical-build-id:${id}`, status: 'active' }));
  const registry = importInitialBuildIdentifiers(previousRegistry, {
    initialBuildOriginAttestation: projectCapture.attestation,
    originRecord: projectCapture.origin_record,
    artifacts,
    identities,
    at,
  });
  await writeBuildIdRegistry(join(root, BUILD_ID_REGISTRY_PATH), registry, {
    initialBuildOriginAttestation: projectCapture.attestation,
    originRecord: projectCapture.origin_record,
  });
  const buildIdHistoryAuthority = attestValidatedBuildIdHistory({
    buildOriginPairAuthority: pair,
    registry,
    previousRegistry,
    artifacts,
    identities,
  });
  return {
    buildOriginPairAuthority: pair,
    buildIdHistoryAuthority,
    idRegistry: registry,
    previousIdRegistry: previousRegistry,
  };
}

export async function reconcileBuildHistoryAuthorities({
  root,
  projectCapture,
  buildOriginPairAuthority,
  currentRegistry,
  milestonePath,
  additionalArtifactPaths = [],
  at = '2026-07-13T00:00:00.000Z',
} = {}) {
  const paths = [
    ...BOOTSTRAP_LOCKED_FILES.map((name) => `.cruise/project/${name}`),
    ...MILESTONE_LOCKED_FILES.map((name) => `${milestonePath}/${name}`),
    ...additionalArtifactPaths,
  ];
  const artifacts = [];
  for (const path of [...new Set(paths)]) {
    artifacts.push({ path, content: await readFile(join(root, path)) });
  }
  const scan = scanBuildIdentifiers(artifacts);
  let registry = currentRegistry;
  for (const occurrence of scan) {
    if (registry.records.some(({ id }) => id === occurrence.id)) continue;
    const before = registry;
    const allocation = allocateBuildIdentifier(registry, {
      initialBuildOriginAttestation: projectCapture.attestation,
      originRecord: projectCapture.origin_record,
      namespace: occurrence.namespace,
      stableKey: `canonical-build-id:${occurrence.id}`,
      sourcePaths: occurrence.source_paths,
      at,
    });
    if (allocation.identifier !== occurrence.id) {
      throw new Error(`fixture attempted non-monotonic ID ${occurrence.id}; expected ${allocation.identifier}`);
    }
    await writeBuildIdRegistry(join(root, BUILD_ID_REGISTRY_PATH), allocation.registry, {
      initialBuildOriginAttestation: projectCapture.attestation,
      originRecord: projectCapture.origin_record,
      expectedSnapshot: createBuildIdRegistrySnapshot(before),
    });
    registry = allocation.registry;
  }
  const identities = scan.map(({ id }) => {
    const record = registry.records.find((candidate) => candidate.id === id);
    return { id, stable_key: record.stable_key, status: record.status };
  });
  const previousRegistry = registry;
  const reconciled = reconcileBuildIdRegistry(registry, {
    initialBuildOriginAttestation: projectCapture.attestation,
    originRecord: projectCapture.origin_record,
    artifacts,
    identities,
    at,
  });
  await writeBuildIdRegistry(join(root, BUILD_ID_REGISTRY_PATH), reconciled, {
    initialBuildOriginAttestation: projectCapture.attestation,
    originRecord: projectCapture.origin_record,
    expectedSnapshot: createBuildIdRegistrySnapshot(previousRegistry),
  });
  return {
    buildOriginPairAuthority,
    buildIdHistoryAuthority: attestValidatedBuildIdHistory({
      buildOriginPairAuthority,
      registry: reconciled,
      previousRegistry,
      artifacts,
      identities,
    }),
    idRegistry: reconciled,
    previousIdRegistry: previousRegistry,
  };
}

export function projectMarkdown(projectId = 'PRJ-01') {
  return `# ${projectId} Cruise test project

## Identity
A durable product contract for deterministic Cruise execution.

## Beneficiary or target users
Operators who need safe, reviewable delivery.

## Core value
Turn approved outcomes into verified, reversible changes.

## Measurable project outcomes
Every mandatory acceptance criterion closes with performed evidence.

## Non-goals
Unapproved production deployment and unrelated refactoring.

## Business or scientific context
The repository is the authoritative implementation context.

## Protected principles
Compatibility, least privilege, and reversible delivery.

## Known constraints
No product mutation before exact Build approval.

## Success measures
All locked contracts and mandatory evidence validate.

## Current maturity
An approved foundation candidate with one executable milestone.

## Canonical terminology
Build defines contracts; Goal executes one approved outcome slice.
`;
}

export function projectRequirementsMarkdown(milestoneId = 'M-003') {
  return `# Project requirements

## R-90 Approved execution foundation
Source: Project outcome and repository evidence.
Decision links: D-01.
Acceptance criteria: AC-90.
Priority: Mandatory.
Target milestone: ${milestoneId}.
Status: Proposed for approval.
Verification class: Contract and performed-test evidence.
`;
}

export function architectureMarkdown() {
  return `# Architecture

## Context and system boundary
Cruise coordinates repository-local contracts and delegates implementation to public skills.

## Major components
The router, Build approval gate, queue coordinator, and Goal runtime are separated.

## Data ownership
Immutable contracts own intent; mutable runtime state owns progress.

## External interfaces
Host structured choices and explicit permission gates are the only approval interfaces.

## Deployment assumptions
Product deployment remains outside Build and requires later approved execution.

## Security and privacy posture
Least privilege and explicit boundary changes are mandatory.

## Observability
Evidence records, queue attempts, and closeouts provide an audit trail.

## Testing strategy
Focused contract tests precede full-suite regression tests.

## Performance constraints
Deterministic validation must remain bounded by repository artifact size.

## Rejected alternatives
Serialized booleans and free-text approval claims cannot mint authority.

## Unresolved architecture questions
No approval-blocking architecture question remains; phase-local choices stay deferred.

## Decision reopening triggers
Reopen D-01 if repository evidence invalidates the coordinator boundary.
`;
}

export function projectRoadmapMarkdown(milestoneId = 'M-003') {
  return `# Project roadmap

## ${milestoneId} Safe approved transition
Transition value: A safely deployable transition with independently verified phase value.
`;
}

export function decisionsMarkdown(id, decision) {
  return `# Decisions

## ${id} Approved boundary
Status: Proposed for approval.
Decision: ${decision}
Evidence: Repository inspection and contract validation.
Reopening trigger: Material repository evidence or an approved outcome changes.
`;
}

export function milestoneMarkdown(milestoneId = 'M-003') {
  return `# ${milestoneId} Safe rollout

## Outcome and beneficiary
Operators receive one safely executable, independently useful rollout outcome.

## Relationship to project goals
The milestone advances R-90 while preserving the project principles.

## Current repository evidence
The deterministic repository probe and locked Origins identify the current baseline.

## Scope
Only the approved phases, requirements, and evidence-producing changes.

## Non-goals
Unapproved deployment, unrelated cleanup, and permission expansion.

## Protected existing behavior
Public compatibility and existing verified behavior remain intact.

## Completion fence
Every mandatory phase verification item and final aggregate evidence must pass.

## Constraints
Use repository patterns, smallest reversible changes, and no silent dependencies.

## Release and rollback expectations
Each phase is releasable only after focused verification and has a coherent rollback boundary.

## Permissions
Repository-local writes and test execution only; external effects require separate approval.

## Unresolved risks
Phase-local questions may reopen only on their recorded evidence triggers.

## Phase summary
The phase DAG delivers vertical, independently verifiable transition value.
`;
}

export function milestoneRequirementsMarkdown(phases) {
  const blocks = [];
  for (const phase of phases) {
    for (const requirementId of phase.requirements) {
      blocks.push(`## ${requirementId} ${phase.name}
Acceptance criteria: ${list(phase.acceptance_criteria)}.
Owning phase: ${phase.id}.
Prerequisite phases: ${list(phase.depends_on)}.
Verification evidence: ${list(phase.verification)}.
Protected project principles: ${list(phase.protected_behavior)}.`);
    }
  }
  return `# Milestone requirements

${blocks.join('\n\n')}
`;
}

export function milestoneRoadmapMarkdown(phases) {
  const blocks = phases.map((phase) => `## ${phase.id} ${phase.name}
Outcome: ${phase.outcome}
Strategically complete: true
Depends on: ${list(phase.depends_on)}
Requirements: ${list(phase.requirements)}
Acceptance criteria: ${list(phase.acceptance_criteria)}
Protected behavior: ${list(phase.protected_behavior)}
Expected artifacts: ${list(phase.expected_artifacts)}
Verification: ${list(phase.verification)}
Rollback boundary: ${phase.rollback_boundary}
Blocking questions: ${list(phase.blocking_questions)}
Goal handoff: ${phase.goal_handoff}`);
  const fence = phases
    .filter((phase) => phase.mandatory !== false)
    .flatMap((phase) => phase.verification.map((evidence) => `- ${phase.id}: ${evidence}`));
  return `# Milestone phase DAG

${blocks.join('\n\n')}

## Milestone completion fence
${fence.join('\n')}
`;
}

export function autonomyState() {
  return {
    schema_version: 1,
    mode: 'interactive',
    decision_policy: { ...AUTONOMY_DECISION_POLICY },
    hard_stops: [...AUTONOMY_HARD_STOPS],
    dangerous_authorization: null,
  };
}

export function projectState({
  projectId = 'PRJ-01',
  milestoneId = 'M-003',
  repositoryBaselineDigest,
  readinessDigest,
  originSha256,
  contractDigest,
  queue,
  reconciledAt,
} = {}) {
  return {
    schema_version: 1,
    kind: 'cruise_project_state',
    project_id: projectId,
    status: 'draft',
    active_milestone: milestoneId,
    completed_milestones: [],
    open_project_questions: [],
    current_repository_baseline: repositoryBaselineDigest,
    readiness_digest: readinessDigest,
    artifact_identities: {
      origin_sha256: originSha256,
      contract_digest: contractDigest,
      queue_definition_sha256: workflowQueueDigest(queue),
    },
    last_reconciliation: {
      repository_baseline_digest: repositoryBaselineDigest,
      reconciled_at: reconciledAt,
    },
    recommended_next_cruise_command: `Use cruise:goal for ${milestoneId}.`,
  };
}

export function milestoneState({
  projectId = 'PRJ-01',
  milestoneId = 'M-003',
  repositoryBaselineDigest,
  readinessDigest,
  originSha256,
  contractDigest,
  queue,
  openQuestions = [],
  firstPhaseId = 'P-01',
  reconciledAt,
} = {}) {
  return {
    schema_version: 1,
    kind: 'cruise_milestone_state',
    project_id: projectId,
    milestone_id: milestoneId,
    status: 'draft',
    active_phase: null,
    completed_phases: [],
    open_questions: [...openQuestions],
    current_repository_baseline: repositoryBaselineDigest,
    readiness_digest: readinessDigest,
    artifact_identities: {
      origin_sha256: originSha256,
      contract_digest: contractDigest,
      queue_definition_sha256: workflowQueueDigest(queue),
    },
    last_reconciliation: {
      repository_baseline_digest: repositoryBaselineDigest,
      reconciled_at: reconciledAt,
    },
    recommended_next_cruise_command: `Use cruise:goal for ${firstPhaseId}.`,
  };
}
