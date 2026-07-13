import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createEvidenceItem, createEvidenceRecord } from '../scripts/lib/evidence.mjs';
import { verifyBuildApprovalArtifacts } from '../scripts/lib/build-contract.mjs';
import { milestoneContractDigest } from '../scripts/lib/milestone-controller.mjs';
import {
  decideEffect,
  decidePath,
  decidePhase,
  decidePhaseTransition,
  normalizeRepositoryRelativePath,
  PUBLIC_SKILLS,
  REASON_CODES,
} from '../scripts/lib/workflow-policy.mjs';
import { createMilestoneRuntimeFixture } from './helpers/milestone-runtime-fixture.mjs';

const NOW = '2026-07-13T00:00:00Z';
const DIGEST_A = 'a'.repeat(64);

function evidenceItem(id, status, supports = []) {
  return createEvidenceItem({
    id,
    gate: 'mandatory',
    scope: 'task',
    status,
    performed: true,
    procedure: `Perform ${id}`,
    command: null,
    expected: status === 'PASS' ? 'The hypothesis is confirmed.' : 'The attempted repair passes.',
    actual: status === 'PASS' ? 'The hypothesis was confirmed.' : 'The attempted repair failed.',
    identity: { source: 'test fixture', build: 'test', environment: 'node:test' },
    startedAt: NOW,
    finishedAt: NOW,
    supports,
  });
}

function evidenceRecord(items = []) {
  return createEvidenceRecord({ runId: 'run-01', recordedAt: NOW, items });
}

function planApproval(overrides = {}) {
  return {
    selectedLabel: 'Approve Plan',
    planDigest: DIGEST_A,
    currentPlanDigest: DIGEST_A,
    repositoryBaselineDigest: DIGEST_A,
    currentRepositoryBaselineDigest: DIGEST_A,
    ...overrides,
  };
}

function startApproval(overrides = {}) {
  return {
    selectedLabel: 'Start Cruise',
    planDigest: DIGEST_A,
    currentPlanDigest: DIGEST_A,
    goalDigest: DIGEST_A,
    currentGoalDigest: DIGEST_A,
    repositoryBaselineDigest: DIGEST_A,
    currentRepositoryBaselineDigest: DIGEST_A,
    ...overrides,
  };
}

function fallbackApproval(overrides = {}) {
  return {
    selectedLabel: 'Execute in Current Thread',
    decisionId: 'D-31',
    nativeGoalAvailable: false,
    durabilityAcknowledged: true,
    planDigest: DIGEST_A,
    currentPlanDigest: DIGEST_A,
    goalDigest: DIGEST_A,
    currentGoalDigest: DIGEST_A,
    repositoryBaselineDigest: DIGEST_A,
    currentRepositoryBaselineDigest: DIGEST_A,
    ...overrides,
  };
}

function milestoneControllerContext({
  milestonePath = '.cruise/milestones/M-003-safe-rollout',
  milestoneId = 'M-003',
  currentPhaseId = 'P-01',
  currentPhaseStatus = 'active',
  phasePlanBound = true,
  ownership = ['src/app.mjs'],
} = {}) {
  const projectFiles = [
    'ORIGIN.yaml',
    'PROJECT.md',
    'REQUIREMENTS.md',
    'ARCHITECTURE.md',
    'ROADMAP.md',
    'DECISIONS.md',
    'ID-REGISTRY.yaml',
    'QUEUE.yaml',
  ];
  const milestoneFiles = [
    'ORIGIN.yaml',
    'MILESTONE.md',
    'REQUIREMENTS.md',
    'ROADMAP.md',
    'DECISIONS.md',
    'QUESTIONS.yaml',
    'AUTONOMY.yaml',
    'QUEUE.yaml',
  ];
  const lockedArtifacts = [
    ...projectFiles.map((name, index) => ({
      path: `.cruise/project/${name}`,
      sha256: (index + 1).toString(16).padStart(64, '0'),
    })),
    ...milestoneFiles.map((name, index) => ({
      path: `${milestonePath}/${name}`,
      sha256: (index + 32).toString(16).padStart(64, '0'),
    })),
  ];
  const contractDigest = milestoneContractDigest(lockedArtifacts);
  return {
    mode: 'milestone-controller',
    selection: {
      source: 'direct_user',
      decision_id: 'D-07',
    },
    milestone: {
      id: milestoneId,
      path: milestonePath,
      contract_digest: contractDigest,
    },
    build_approval: {
      label: 'Approve Milestone',
      contract_digest: contractDigest,
    },
    eligibility: {
      phase_dag_validated: true,
      milestone_blockers_resolved: true,
      permission_envelope_explicit: true,
    },
    autonomy: { mode: 'interactive' },
    phase_dag: [
      { id: 'P-01', depends_on: [], mandatory: true },
      { id: 'P-02', depends_on: ['P-01'], mandatory: true },
    ],
    locked_artifacts: lockedArtifacts,
    currentContractDigest: contractDigest,
    controllerDigest: DIGEST_A,
    currentControllerDigest: DIGEST_A,
    currentPhase: {
      id: currentPhaseId,
      status: currentPhaseStatus,
      ...(phasePlanBound
        ? { planDigest: DIGEST_A, currentPlanDigest: DIGEST_A }
        : {}),
      ownership,
    },
  };
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'cruise-workflow-policy-'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, '.cruise', 'runs', 'run-01'), { recursive: true });
  await mkdir(join(root, '.cruise', 'goal'), { recursive: true });
  await writeFile(join(root, 'src', 'app.mjs'), 'export const stable = true;\n');
  return root;
}

function quick(root, overrides = {}) {
  return {
    skill: 'quick',
    repositoryRoot: root,
    path: 'src/app.mjs',
    writeClass: 'product',
    admitted: true,
    hardPromotion: false,
    hardPromotionReasons: [],
    declaredPaths: ['src/app.mjs'],
    repairAttempts: 0,
    repairEvidenceIds: [],
    runId: 'run-01',
    evidenceRecord: evidenceRecord(),
    ...overrides,
  };
}

test('the policy exposes exactly the six public skills and rejects the private provisioner', async () => {
  assert.deepEqual(PUBLIC_SKILLS, ['build', 'quick', 'refine', 'goal', 'debug', 'research']);
  const root = await repository();
  const result = decidePath({
    skill: '_provision',
    repositoryRoot: root,
    path: '.cruise/internal/capabilities.yaml',
    writeClass: 'machine',
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, REASON_CODES.DENY_UNKNOWN_SKILL);
});

test('repository path normalization rejects traversal, absolute paths, and symlink escapes', async () => {
  const root = await repository();
  const outside = await mkdtemp(join(tmpdir(), 'cruise-workflow-outside-'));
  await symlink(outside, join(root, 'linked-outside'));

  assert.equal(
    normalizeRepositoryRelativePath({ repositoryRoot: root, path: '../outside.txt' }).code,
    REASON_CODES.DENY_PATH_TRAVERSAL,
  );
  assert.equal(
    normalizeRepositoryRelativePath({ repositoryRoot: root, path: 'src/../outside.txt' }).code,
    REASON_CODES.DENY_PATH_TRAVERSAL,
  );
  assert.equal(
    normalizeRepositoryRelativePath({ repositoryRoot: root, path: join(outside, 'report.md') }).code,
    REASON_CODES.DENY_PATH_ABSOLUTE,
  );
  assert.equal(
    normalizeRepositoryRelativePath({ repositoryRoot: root, path: 'linked-outside/report.md' }).code,
    REASON_CODES.DENY_PATH_SYMLINK,
  );
  assert.equal(
    normalizeRepositoryRelativePath({ repositoryRoot: root, path: 'src' }).code,
    REASON_CODES.DENY_PATH_INVALID,
  );

  const allowed = normalizeRepositoryRelativePath({ repositoryRoot: root, path: './src//new.mjs' });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.path, 'src/new.mjs');
  assert.equal(allowed.requiresNoFollowRecheck, true);
});

test('Build and Research reject every product-affecting write class even when a path is declared', async () => {
  const root = await repository();
  for (const skill of ['build', 'research']) {
    for (const writeClass of [
      'product',
      'dependency',
      'lockfile',
      'fixture',
      'snapshot',
      'generated_source',
      'formatting',
    ]) {
      const result = decidePath({
        skill,
        repositoryRoot: root,
        path: 'src/app.mjs',
        writeClass,
        approvedRunPaths: ['src/app.mjs'],
      });
      assert.equal(result.allowed, false, `${skill} ${writeClass}`);
      assert.equal(result.code, REASON_CODES.DENY_REVIEW_RESEARCH_WRITE);
    }
  }
});

test('Build writes exact planning paths while Research writes exact run paths', async () => {
  const root = await repository();
  const buildProject = '.cruise/project/PROJECT.md';
  const buildMilestone = '.cruise/milestones/M-01-first/STATE.yaml';
  const researchState = '.cruise/runs/run-01/evidence.yaml';

  assert.equal(decidePath({
    skill: 'build',
    repositoryRoot: root,
    path: buildProject,
    writeClass: 'report',
    approvedInternalPaths: [buildProject],
  }).allowed, true);
  assert.equal(decidePath({
    skill: 'build',
    repositoryRoot: root,
    path: buildMilestone,
    writeClass: 'machine',
    approvedInternalPaths: [buildMilestone],
  }).allowed, true);
  assert.equal(decidePath({
    skill: 'research',
    repositoryRoot: root,
    path: researchState,
    writeClass: 'machine',
    approvedRunPaths: [researchState],
  }).allowed, true);

  assert.equal(decidePath({
    skill: 'build',
    repositoryRoot: root,
    path: '.cruise/project/UNAPPROVED.md',
    writeClass: 'report',
    approvedInternalPaths: [buildProject],
  }).code, REASON_CODES.DENY_SCOPE_UNDECLARED);
  assert.equal(decidePath({
    skill: 'research',
    repositoryRoot: root,
    path: '.cruise/runs/run-01/generated.mjs',
    writeClass: 'machine',
    approvedRunPaths: ['.cruise/runs/run-01/generated.mjs'],
  }).code, REASON_CODES.DENY_INTERNAL_PATH);
});

test('Build writes only exact post-approval repository Markdown displayed in the verified contract', async () => {
  const root = await repository();
  const { verifiedBuildApproval } = await createMilestoneRuntimeFixture(root, {
    documentationPaths: ['README.md'],
  });
  const buildArtifactSnapshot = await verifyBuildApprovalArtifacts({
    root,
    verifiedBuildApproval,
  });
  const approved = {
    skill: 'build',
    repositoryRoot: root,
    path: 'README.md',
    writeClass: 'report',
    verifiedBuildApproval,
    buildArtifactSnapshot,
  };

  assert.equal(decidePath(approved).allowed, true);
  assert.equal(decidePath({
    ...approved,
    path: 'docs/unlisted.md',
  }).code, REASON_CODES.DENY_BUILD_DOCUMENTATION_SCOPE);
  assert.equal(decidePath({
    ...approved,
    path: 'src/QI-01.mjs',
  }).code, REASON_CODES.DENY_WRITE_CLASS_PATH_MISMATCH);
  assert.equal(decidePath({
    ...approved,
    verifiedBuildApproval: { ...verifiedBuildApproval },
  }).code, REASON_CODES.DENY_BUILD_DOCUMENTATION_APPROVAL);
  assert.equal(decidePath({
    ...approved,
    buildArtifactSnapshot: undefined,
  }).code, REASON_CODES.DENY_BUILD_DOCUMENTATION_APPROVAL);
  assert.equal(decidePath({
    ...approved,
    buildArtifactSnapshot: { ...buildArtifactSnapshot },
  }).code, REASON_CODES.DENY_BUILD_DOCUMENTATION_APPROVAL);
  assert.equal(decidePath({
    ...approved,
    verifiedBuildApproval: undefined,
    buildApprovalAttestation: {
      kind: 'cruise_verified_build_approval',
      label: 'Approve Milestone',
      review_card: verifiedBuildApproval.review_card,
    },
  }).code, REASON_CODES.DENY_BUILD_DOCUMENTATION_APPROVAL);

  const otherRoot = await repository();
  assert.equal(decidePath({
    ...approved,
    repositoryRoot: otherRoot,
  }).code, REASON_CODES.DENY_BUILD_DOCUMENTATION_APPROVAL);

  await writeFile(
    join(root, '.cruise', 'milestones', 'M-003-safe-rollout', 'MILESTONE.md'),
    '# drifted locked milestone\n',
  );
  assert.equal(
    decidePath(approved).code,
    REASON_CODES.DENY_BUILD_DOCUMENTATION_APPROVAL,
  );
  await assert.rejects(
    verifyBuildApprovalArtifacts({ root, verifiedBuildApproval }),
    /MILESTONE\.md|locked Build artifacts or queue bytes changed after approval/u,
  );
});

test('external Research reports require exact path approval and D-ID effect scope', async () => {
  const root = await repository();
  const outside = await mkdtemp(join(tmpdir(), 'cruise-external-report-'));
  const report = join(await realpath(outside), 'RESEARCH.md');
  const base = {
    skill: 'research',
    repositoryRoot: root,
    path: report,
    writeClass: 'report',
    approvedExternalReportPaths: [report],
  };

  assert.equal(decidePath(base).code, REASON_CODES.DENY_EFFECT_PERMISSION);
  assert.equal(decidePath({
    ...base,
    permission: {
      granted: true,
      id: 'D-07',
      scope: { kinds: ['external_filesystem_write'], targets: [join(outside, 'OTHER.md')] },
    },
  }).code, REASON_CODES.DENY_EFFECT_SCOPE);
  assert.equal(decidePath({
    ...base,
    permission: {
      granted: true,
      id: 'D-07',
      scope: { kinds: ['external_filesystem_write'], targets: [report] },
    },
  }).allowed, true);
});

test('Quick product writes require admission, no hard promotion, bounded exact scope, and fewer than two repairs', async () => {
  const root = await repository();
  assert.equal(decidePath(quick(root)).allowed, true);
  assert.equal(decidePath(quick(root, { admitted: false })).code, REASON_CODES.DENY_QUICK_NOT_ADMITTED);
  assert.equal(decidePath(quick(root, {
    hardPromotionReasons: ['public_api_change'],
  })).code, REASON_CODES.DENY_QUICK_HARD_PROMOTION);
  assert.equal(decidePath(quick(root, {
    declaredPaths: ['src/other.mjs'],
  })).code, REASON_CODES.DENY_QUICK_SCOPE);
  assert.equal(decidePath(quick(root, {
    declaredPaths: [
      'src/app.mjs',
      ...Array.from({ length: 5 }, (_entry, index) => `src/${index}.mjs`),
    ],
  })).allowed, true, 'file count alone must not reject an otherwise admitted closed Quick scope');
  assert.equal(decidePath(quick(root, {
    path: 'package.json',
    writeClass: 'dependency',
    declaredPaths: ['package.json'],
  })).code, REASON_CODES.DENY_QUICK_HARD_PROMOTION);
  assert.equal(decidePath(quick(root, {
    path: 'package-lock.json',
    writeClass: 'lockfile',
    declaredPaths: ['package-lock.json'],
  })).code, REASON_CODES.DENY_QUICK_HARD_PROMOTION);
  assert.equal(decidePath(quick(root, {
    repairAttempts: 1,
    repairEvidenceIds: ['E-01'],
    evidenceRecord: evidenceRecord([evidenceItem('E-01', 'BLOCK')]),
  })).allowed, true);
  assert.equal(decidePath(quick(root, {
    repairAttempts: 1,
    repairEvidenceIds: [],
  })).code, REASON_CODES.DENY_QUICK_REPAIR_LEDGER);
  assert.equal(decidePath(quick(root, {
    repairAttempts: 2,
    repairEvidenceIds: ['E-01', 'E-02'],
    evidenceRecord: evidenceRecord([
      evidenceItem('E-01', 'BLOCK'),
      evidenceItem('E-02', 'BLOCK'),
    ]),
  })).code, REASON_CODES.DENY_QUICK_REPAIR_LIMIT);
});

test('Refine product writes require a current exact-label plan approval and exact plan ownership', async () => {
  const root = await repository();
  const base = {
    skill: 'refine',
    repositoryRoot: root,
    path: 'src/app.mjs',
    writeClass: 'product',
    planOwnership: ['src/app.mjs'],
  };
  assert.equal(decidePath(base).code, REASON_CODES.DENY_REFINE_PLAN_UNAPPROVED);
  assert.equal(decidePath({ ...base, planApproval: planApproval() }).allowed, true);
  assert.equal(decidePath({
    ...base,
    planApproval: planApproval({ selectedLabel: 'looks good' }),
  }).code, REASON_CODES.DENY_REFINE_PLAN_UNAPPROVED);
  assert.equal(decidePath({
    ...base,
    planApproval: planApproval({ currentPlanDigest: 'b'.repeat(64) }),
  }).code, REASON_CODES.DENY_REFINE_PLAN_UNAPPROVED);
  assert.equal(decidePath({
    ...base,
    planApproval: planApproval(),
    planOwnership: ['src/other.mjs'],
  }).code, REASON_CODES.DENY_REFINE_OWNERSHIP);
});

test('Goal writes require native activation or explicit fallback plus exact ownership', async () => {
  const root = await repository();
  const base = {
    skill: 'goal',
    repositoryRoot: root,
    path: 'src/app.mjs',
    writeClass: 'product',
    approvedOwnership: ['src/app.mjs'],
  };
  assert.equal(decidePath(base).code, REASON_CODES.DENY_GOAL_INACTIVE);
  assert.equal(decidePath({ ...base, nativeGoalActive: true }).allowed, true);
  assert.equal(decidePath({ ...base, fallbackApproval: fallbackApproval() }).allowed, true);
  assert.equal(decidePath({
    ...base,
    nativeGoalActive: true,
    approvedOwnership: ['src/other.mjs'],
  }).code, REASON_CODES.DENY_GOAL_OWNERSHIP);

  const closeout = '.cruise/goal/CLOSEOUT.md';
  assert.equal(decidePath({
    skill: 'goal',
    repositoryRoot: root,
    path: closeout,
    writeClass: 'report',
    approvedInternalPaths: [closeout],
  }).code, REASON_CODES.DENY_GOAL_CLOSEOUT_INACTIVE);
  assert.equal(decidePath({
    skill: 'goal',
    repositoryRoot: root,
    path: closeout,
    writeClass: 'report',
    approvedInternalPaths: [closeout],
    nativeGoalActive: true,
  }).allowed, true);
  assert.equal(decidePath({
    skill: 'goal',
    repositoryRoot: root,
    path: closeout,
    writeClass: 'report',
    approvedInternalPaths: [closeout],
    fallbackApproval: fallbackApproval(),
  }).allowed, true);
  assert.equal(decidePath({
    skill: 'goal',
    repositoryRoot: root,
    path: '.cruise/goal/plan.md',
    writeClass: 'report',
    approvedInternalPaths: ['.cruise/goal/plan.md'],
  }).code, REASON_CODES.DENY_GOAL_ARTIFACT);

  const origin = '.cruise/goal/ORIGIN.yaml';
  assert.equal(decidePath({
    skill: 'goal',
    repositoryRoot: root,
    path: '.cruise/goal/UNNAMED.md',
    writeClass: 'report',
    approvedInternalPaths: ['.cruise/goal/UNNAMED.md'],
  }).code, REASON_CODES.DENY_GOAL_ARTIFACT);
  assert.equal(decidePath({
    skill: 'goal',
    repositoryRoot: root,
    path: origin,
    writeClass: 'machine',
    approvedInternalPaths: [origin],
    planLocked: true,
  }).code, REASON_CODES.DENY_GOAL_ARTIFACT);
  assert.equal(decidePath({
    skill: 'goal',
    repositoryRoot: root,
    path: '.cruise/goal/GOAL.md',
    writeClass: 'report',
    approvedInternalPaths: ['.cruise/goal/GOAL.md'],
    startApproval: startApproval(),
  }).code, REASON_CODES.DENY_GOAL_POST_START_WRITE);
  assert.equal(decidePath({
    skill: 'goal',
    repositoryRoot: root,
    path: '.cruise/goal/GOAL.md',
    writeClass: 'report',
    approvedInternalPaths: ['.cruise/goal/GOAL.md'],
    nativeGoalActive: true,
  }).code, REASON_CODES.DENY_GOAL_POST_START_WRITE);
});

test('milestone-controller writes are limited to selected mutable state and the current phase', async () => {
  const root = await repository();
  const { context: controller } = await createMilestoneRuntimeFixture(root);
  const milestonePath = controller.milestone.path;
  const base = {
    skill: 'goal',
    goalMode: 'milestone-controller',
    milestoneController: controller,
    repositoryRoot: root,
    nativeGoalActive: true,
    writeClass: 'machine',
  };

  const clonedStateController = {
    ...controller,
    state: structuredClone(controller.state),
  };
  assert.equal(decidePath({
    ...base,
    milestoneController: clonedStateController,
    path: `${milestonePath}/STATE.yaml`,
    approvedInternalPaths: [`${milestonePath}/STATE.yaml`],
  }).code, REASON_CODES.DENY_GOAL_CONTROLLER_CONTEXT);

  for (const path of [
    `${milestonePath}/STATE.yaml`,
    `${milestonePath}/QUEUE-STATE.yaml`,
    `${milestonePath}/phases/P-01/QUESTIONS.yaml`,
    `${milestonePath}/phases/P-01/ATTEMPTS.yaml`,
    `${milestonePath}/phases/P-01/EVIDENCE.yaml`,
  ]) {
    const result = decidePath({
      ...base,
      path,
      approvedInternalPaths: [path],
    });
    assert.equal(result.allowed, true, path);
    assert.equal(result.milestoneId, 'M-003');
    assert.equal(result.currentPhaseId, 'P-01');
  }

  const closeout = `${milestonePath}/phases/P-01/CLOSEOUT.md`;
  assert.equal(decidePath({
    ...base,
    path: closeout,
    writeClass: 'report',
    approvedInternalPaths: [closeout],
  }).allowed, true);

  const phasePlan = `${milestonePath}/phases/P-01/PLAN.md`;
  const preparingRoot = await repository();
  const { context: preparingController } = await createMilestoneRuntimeFixture(
    preparingRoot,
    { phasePlanBound: false },
  );
  assert.equal(decidePath({
    ...base,
    repositoryRoot: preparingRoot,
    milestoneController: preparingController,
    path: phasePlan,
    writeClass: 'report',
    approvedInternalPaths: [phasePlan],
  }).allowed, true);
  assert.equal(decidePath({
    ...base,
    repositoryRoot: preparingRoot,
    milestoneController: preparingController,
    path: closeout,
    writeClass: 'report',
    approvedInternalPaths: [closeout],
  }).code, REASON_CODES.DENY_GOAL_CONTROLLER_CONTEXT);
  assert.equal(decidePath({
    ...base,
    path: phasePlan,
    writeClass: 'report',
    approvedInternalPaths: [phasePlan],
  }).code, REASON_CODES.DENY_GOAL_CONTROLLER_LOCKED_ARTIFACT);

  const legacyState = `${milestonePath}/STATE.yaml`;
  assert.equal(decidePath({
    skill: 'goal',
    goalMode: 'single-slice',
    repositoryRoot: root,
    path: legacyState,
    writeClass: 'machine',
    approvedInternalPaths: [legacyState],
    nativeGoalActive: true,
  }).code, REASON_CODES.DENY_INTERNAL_PATH, 'single-slice Goal must not infer milestone authority');
});

test('milestone-controller denies locked Build artifacts and unauthorized milestone paths', async () => {
  const root = await repository();
  const { context: controller } = await createMilestoneRuntimeFixture(root);
  const milestonePath = controller.milestone.path;
  const base = {
    skill: 'goal',
    goalMode: 'milestone-controller',
    milestoneController: controller,
    repositoryRoot: root,
    nativeGoalActive: true,
  };

  for (const [path, writeClass] of [
    ['.cruise/project/PROJECT.md', 'report'],
    [`${milestonePath}/MILESTONE.md`, 'report'],
    [`${milestonePath}/AUTONOMY.yaml`, 'machine'],
  ]) {
    assert.equal(decidePath({
      ...base,
      path,
      writeClass,
      approvedInternalPaths: [path],
    }).code, REASON_CODES.DENY_GOAL_CONTROLLER_LOCKED_ARTIFACT, path);
  }

  for (const [path, writeClass] of [
    ['.cruise/milestones/M-004-other/STATE.yaml', 'machine'],
    [`${milestonePath}/phases/P-02/EVIDENCE.yaml`, 'machine'],
    [`${milestonePath}/phases/P-01/UNAPPROVED.yaml`, 'machine'],
    [`${milestonePath}/phases/P-01/nested/EVIDENCE.yaml`, 'machine'],
  ]) {
    assert.equal(decidePath({
      ...base,
      path,
      writeClass,
      approvedInternalPaths: [path],
    }).code, REASON_CODES.DENY_GOAL_CONTROLLER_SCOPE, path);
  }

  const currentEvidence = `${milestonePath}/phases/P-01/EVIDENCE.yaml`;
  assert.equal(decidePath({
    ...base,
    path: currentEvidence,
    writeClass: 'machine',
    approvedInternalPaths: [`${milestonePath}/STATE.yaml`],
  }).code, REASON_CODES.DENY_SCOPE_UNDECLARED);
});

test('milestone-controller requires current exact controller, Build, and phase context', async () => {
  const root = await repository();
  const path = '.cruise/milestones/M-003-safe-rollout/STATE.yaml';
  const base = {
    skill: 'goal',
    goalMode: 'milestone-controller',
    repositoryRoot: root,
    path,
    writeClass: 'machine',
    approvedInternalPaths: [path],
    nativeGoalActive: true,
  };
  assert.equal(
    decidePath(base).code,
    REASON_CODES.DENY_GOAL_CONTROLLER_CONTEXT,
  );

  const controller = milestoneControllerContext();
  for (const invalid of [
    { ...controller, currentContractDigest: 'b'.repeat(64) },
    { ...controller, currentControllerDigest: 'b'.repeat(64) },
    {
      ...controller,
      selection: { ...controller.selection, source: 'repository' },
    },
    {
      ...controller,
      currentPhase: { ...controller.currentPhase, id: 'P-99' },
    },
    {
      ...controller,
      autonomy: { mode: 'dangerous' },
    },
  ]) {
    assert.equal(decidePath({
      ...base,
      milestoneController: invalid,
    }).code, REASON_CODES.DENY_GOAL_CONTROLLER_CONTEXT);
  }

  for (const phaseDag of [
    [
      { id: 'P-01', depends_on: ['P-99'], mandatory: true },
      { id: 'P-02', depends_on: [], mandatory: true },
    ],
    [
      { id: 'P-01', depends_on: [], mandatory: true },
      { id: 'P-02', depends_on: ['P-01', 'P-01'], mandatory: true },
    ],
    [
      { id: 'P-01', depends_on: ['P-02'], mandatory: true },
      { id: 'P-02', depends_on: ['P-01'], mandatory: true },
    ],
    [
      { id: 'P-01', depends_on: [], mandatory: false },
      { id: 'P-02', depends_on: ['P-01'], mandatory: false },
    ],
  ]) {
    assert.equal(decidePath({
      ...base,
      milestoneController: { ...controller, phase_dag: phaseDag },
    }).code, REASON_CODES.DENY_GOAL_CONTROLLER_CONTEXT);
  }

  assert.equal(decidePath({
    ...base,
    goalMode: 'single-slice',
    milestoneController: controller,
  }).code, REASON_CODES.DENY_GOAL_CONTROLLER_CONTEXT);

  const descriptor = '.cruise/goal/MILESTONE-CONTROLLER.yaml';
  assert.equal(decidePath({
    skill: 'goal',
    goalMode: 'milestone-controller',
    repositoryRoot: root,
    path: descriptor,
    writeClass: 'machine',
    approvedInternalPaths: [descriptor],
  }).allowed, true, 'preparation must be able to create the descriptor before runtime context exists');
});

test('milestone-controller product writes use only current-phase ownership and phase-plan digest', async () => {
  const root = await repository();
  const { context: controller } = await createMilestoneRuntimeFixture(root, {
    ownership: ['src/app.mjs'],
  });
  const base = {
    skill: 'goal',
    goalMode: 'milestone-controller',
    milestoneController: controller,
    repositoryRoot: root,
    nativeGoalActive: true,
    writeClass: 'product',
    approvedOwnership: ['src/other.mjs'],
  };
  assert.equal(decidePath({ ...base, path: 'src/app.mjs' }).allowed, true);
  assert.equal(decidePath({ ...base, path: 'src/other.mjs' }).code, REASON_CODES.DENY_GOAL_OWNERSHIP);

  const driftedPlan = {
    ...controller,
    currentPhase: {
      ...controller.currentPhase,
      currentPlanDigest: 'b'.repeat(64),
    },
  };
  assert.equal(decidePath({
    ...base,
    milestoneController: driftedPlan,
    path: 'src/app.mjs',
  }).code, REASON_CODES.DENY_GOAL_CONTROLLER_CONTEXT);
});

test('Debug product writes require performed causal evidence and exact causal scope', async () => {
  const root = await repository();
  const base = {
    skill: 'debug',
    repositoryRoot: root,
    path: 'src/app.mjs',
    writeClass: 'product',
    causalScope: ['src/app.mjs'],
  };
  assert.equal(decidePath(base).code, REASON_CODES.DENY_DEBUG_ROOT_CAUSE);
  assert.equal(decidePath({ ...base, rootCauseEstablished: true }).code, REASON_CODES.DENY_DEBUG_EVIDENCE);
  const causalEvidence = {
    runId: 'run-01',
    rootCauseEstablished: true,
    rootCauseHypothesisId: 'H-01',
    rootCauseEvidenceIds: ['E-01'],
    causalScopeEvidenceIds: ['E-02'],
    evidenceRecord: evidenceRecord([
      evidenceItem('E-01', 'PASS', ['H-01']),
      evidenceItem('E-02', 'PASS', ['H-01']),
    ]),
  };
  assert.equal(decidePath({ ...base, ...causalEvidence }).allowed, true);
  assert.equal(decidePath({
    ...base,
    ...causalEvidence,
    causalScope: ['src/other.mjs'],
  }).code, REASON_CODES.DENY_DEBUG_CAUSAL_SCOPE);
});

test('phase decisions enforce each workflow gate and reject planning-only execution bypasses', async () => {
  const root = await repository();
  assert.equal(
    decidePhaseTransition({ skill: 'quick', to: 'capture_origin' }).code,
    REASON_CODES.DENY_INVALID_REQUEST,
  );
  assert.equal(
    decidePhaseTransition({ skill: 'quick', from: null, to: 'execute' }).code,
    REASON_CODES.DENY_PHASE_TRANSITION,
  );
  assert.equal(
    decidePhaseTransition({ skill: 'quick', from: null, to: 'capture_origin' }).allowed,
    true,
  );
  assert.equal(decidePhase({ skill: 'build', from: 'draft', to: 'execute' }).code, REASON_CODES.DENY_UNKNOWN_PHASE);
  assert.equal(decidePhase({
    skill: 'goal',
    from: 'plan_approval',
    to: 'activation',
  }).code, REASON_CODES.DENY_PHASE_TRANSITION);
  assert.equal(decidePhase({
    skill: 'goal',
    from: 'plan_approval',
    to: 'goal_contract',
  }).code, REASON_CODES.DENY_GOAL_PLAN_UNAPPROVED);
  assert.equal(decidePhase({
    skill: 'goal',
    from: 'plan_approval',
    to: 'goal_contract',
    planApproval: planApproval(),
  }).allowed, true);
  assert.equal(decidePhase({
    skill: 'goal',
    from: 'goal_contract',
    to: 'start_approval',
  }).allowed, true);
  assert.equal(decidePhase({
    skill: 'goal',
    from: 'start_approval',
    to: 'activation',
  }).code, REASON_CODES.DENY_GOAL_START_UNAPPROVED);
  assert.equal(decidePhase({
    skill: 'goal',
    from: 'start_approval',
    to: 'activation',
    startApproval: startApproval(),
  }).allowed, true);
  assert.equal(decidePhase({
    skill: 'goal',
    from: 'start_approval',
    to: 'activation',
    startApproval: startApproval({ currentGoalDigest: 'b'.repeat(64) }),
  }).code, REASON_CODES.DENY_GOAL_START_UNAPPROVED);
  assert.equal(decidePhase({
    skill: 'goal',
    from: 'goal_contract',
    to: 'fallback_approval',
  }).allowed, true);
  assert.equal(decidePhase({
    skill: 'goal',
    from: 'fallback_approval',
    to: 'fallback_activation',
  }).code, REASON_CODES.DENY_GOAL_FALLBACK_UNAPPROVED);
  assert.equal(decidePhase({
    skill: 'goal',
    from: 'fallback_approval',
    to: 'fallback_activation',
    fallbackApproval: fallbackApproval(),
  }).allowed, true);
  assert.equal(decidePhase({
    skill: 'quick',
    from: 'micro_plan',
    to: 'execute',
    repositoryRoot: root,
    admitted: true,
    hardPromotionReasons: [],
    repairAttempts: 0,
    repairEvidenceIds: [],
    runId: 'run-01',
    evidenceRecord: evidenceRecord(),
    declaredPaths: ['src/app.mjs'],
  }).allowed, true);
  assert.equal(decidePhase({
    skill: 'refine',
    from: 'plan_approval',
    to: 'execute',
    repositoryRoot: root,
    planApproval: null,
    planOwnership: ['src/app.mjs'],
  }).code, REASON_CODES.DENY_REFINE_PLAN_UNAPPROVED);
  assert.equal(decidePhase({
    skill: 'goal',
    from: 'verify',
    to: 'closeout',
    repositoryRoot: root,
    nativeGoalActive: false,
    approvedOwnership: ['src/app.mjs'],
  }).code, REASON_CODES.DENY_GOAL_INACTIVE);
  assert.equal(decidePhase({
    skill: 'goal',
    from: 'verify',
    to: 'closeout',
    repositoryRoot: root,
    nativeGoalActive: true,
  }).allowed, true);
  assert.equal(decidePhase({
    skill: 'debug',
    from: 'diagnose',
    to: 'root_cause',
    rootCauseEstablished: true,
  }).code, REASON_CODES.DENY_DEBUG_EVIDENCE);
  assert.equal(decidePhase({
    skill: 'debug',
    from: 'diagnose',
    to: 'root_cause',
    runId: 'run-01',
    rootCauseEstablished: true,
    rootCauseHypothesisId: 'H-01',
    rootCauseEvidenceIds: ['E-01'],
    causalScopeEvidenceIds: ['E-02'],
    evidenceRecord: evidenceRecord([
      evidenceItem('E-01', 'PASS', ['H-01']),
      evidenceItem('E-02', 'PASS', ['H-01']),
    ]),
  }).allowed, true);
  assert.equal(decidePhase({
    skill: 'debug',
    from: 'root_cause',
    to: 'repair',
    repositoryRoot: root,
    rootCauseEstablished: false,
    causalScope: ['src/app.mjs'],
  }).code, REASON_CODES.DENY_DEBUG_ROOT_CAUSE);
});

test('Build approval closes only through a verified attestation while revision stays open', async () => {
  assert.equal(decidePhase({
    skill: 'build',
    from: 'approval',
    to: 'close',
  }).code, REASON_CODES.DENY_PHASE_TRANSITION);
  assert.equal(decidePhase({
    skill: 'build',
    from: 'approval',
    to: 'close',
    buildApprovalAttestation: { valid: true },
  }).code, REASON_CODES.DENY_PHASE_TRANSITION);
  assert.equal(decidePhase({
    skill: 'build',
    from: 'approval',
    to: 'draft',
  }).allowed, true);

  const root = await repository();
  const fixture = await createMilestoneRuntimeFixture(root);
  assert.equal(decidePhase({
    skill: 'build',
    from: 'approval',
    to: 'close',
    buildApprovalAttestation: fixture.verifiedBuildApproval,
  }).allowed, true);
});

test('Build and Research external effects preserve planning-only boundaries', () => {
  const permission = (kind, target) => ({
    granted: true,
    id: 'D-21',
    scope: { kinds: [kind], targets: [target] },
  });
  assert.equal(decideEffect({
    skill: 'research',
    effect: { boundary: 'external', kind: 'package_install', target: 'package.json' },
    permission: permission('package_install', 'package.json'),
  }).code, REASON_CODES.DENY_REVIEW_RESEARCH_EFFECT);
  assert.equal(decideEffect({
    skill: 'research',
    effect: {
      boundary: 'external',
      kind: 'capability_install',
      target: 'package.json',
      purpose: 'workflow_capability',
      capabilityId: 'CAP-01',
    },
    permission: permission('capability_install', 'package.json'),
  }).code, REASON_CODES.DENY_PRIVATE_PROVISION_REQUIRED);
  assert.equal(decideEffect({
    skill: 'research',
    effect: {
      boundary: 'internal',
      kind: 'capability_resolution_request',
      target: 'CAP-01',
    },
  }).allowed, true);
  assert.equal(decideEffect({
    skill: 'research',
    effect: {
      boundary: 'internal',
      kind: 'capability_resolution_request',
      target: 'package.json',
    },
  }).code, REASON_CODES.DENY_EFFECT_SCOPE);
  assert.equal(decideEffect({
    skill: 'build',
    effect: { boundary: 'external', kind: 'external_filesystem_write', target: '/tmp/report.md' },
    permission: permission('external_filesystem_write', '/tmp/report.md'),
  }).code, REASON_CODES.DENY_REVIEW_RESEARCH_EFFECT);
});

test('every external effect requires a granted stable permission ID and exact scope', () => {
  const effect = { boundary: 'external', kind: 'git_push', target: 'origin/main' };
  assert.equal(decideEffect({ skill: 'goal', effect }).code, REASON_CODES.DENY_GOAL_INACTIVE);
  assert.equal(decideEffect({ skill: 'goal', effect, nativeGoalActive: true }).code, REASON_CODES.DENY_EFFECT_PERMISSION);
  assert.equal(decideEffect({
    skill: 'goal',
    effect,
    nativeGoalActive: true,
    permission: {
      granted: true,
      id: 'permission-1',
      scope: { kinds: ['git_push'], targets: ['origin/main'] },
    },
  }).code, REASON_CODES.DENY_EFFECT_PERMISSION_ID);
  assert.equal(decideEffect({
    skill: 'goal',
    effect,
    nativeGoalActive: true,
    permission: {
      granted: true,
      id: 'D-09',
      scope: { kinds: ['git_push'], targets: ['*'] },
    },
  }).code, REASON_CODES.DENY_EFFECT_SCOPE);
  const allowed = decideEffect({
    skill: 'goal',
    effect,
    nativeGoalActive: true,
    permission: {
      granted: true,
      id: 'D-09',
      scope: { kinds: ['git_push'], targets: ['origin/main'] },
    },
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.permissionId, 'D-09');
  assert.equal(decideEffect({
    skill: 'goal',
    effect,
    fallbackApproval: fallbackApproval(),
    permission: {
      granted: true,
      id: 'D-09',
      scope: { kinds: ['git_push'], targets: ['origin/main'] },
    },
  }).allowed, true);

  assert.equal(decideEffect({
    skill: 'quick',
    effect: { boundary: 'internal', kind: 'git_push', target: 'origin/main' },
  }).code, REASON_CODES.DENY_EFFECT_BOUNDARY);
  assert.equal(decideEffect({
    skill: 'build',
    effect: { boundary: 'internal', kind: 'repository_analysis', target: 'src/' },
  }).allowed, true);
});

test('policy decisions are immutable and do not mutate the inspected repository', async () => {
  const root = await repository();
  const before = await readdir(root, { recursive: true });
  const result = decidePath(quick(root));
  assert.throws(() => {
    result.allowed = false;
  }, TypeError);
  const after = await readdir(root, { recursive: true });
  assert.deepEqual(after, before);
});
