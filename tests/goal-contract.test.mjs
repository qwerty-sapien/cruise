import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  activateApprovedGoal,
  buildGoalObjective,
  captureGoalApproval,
  capturePlanGoalApproval,
  capturePlanApproval,
  captureRepositoryBaseline,
  extractAlignmentStem,
  inspectGoalOrigin,
  isApprovePlanChoice,
  isApprovePlanGoalChoice,
  isGoalNeedsOptions,
  isPlanGoalReviewOptions,
  isStartCruiseChoice,
  verifyGoalApproval,
  verifyPlanGoalApproval,
} from '../scripts/lib/goal-contract.mjs';
import { createOriginRecord } from '../scripts/lib/origin.mjs';
import {
  createDeterministicProbe,
  deterministicProbeDigest,
} from '../scripts/lib/routing.mjs';
import { stringifyYaml } from '../scripts/lib/yaml-state.mjs';

async function createPlanContract({ cwd: targetDirectory = null, mutateOrigin = null } = {}) {
  const cwd = targetDirectory ?? await mkdtemp(join(tmpdir(), 'cruise-goal-test-'));
  const goalDir = join(cwd, '.cruise', 'goal');
  await mkdir(goalDir, { recursive: true });
  const probe = createDeterministicProbe({ repository: { root: cwd } });
  const origin = createOriginRecord({
    rawPrompt: 'Ship it safely.',
    selectedSkill: 'goal',
    repositoryRoot: cwd,
    deterministicProbeDigest: deterministicProbeDigest(probe),
    initialClassifier: 'gpt-5.6-luna medium',
    selectedRoute: 'goal',
    confidence: 0.96,
    goal: { outcome: 'Ship it safely.' },
  });
  const originCandidate = structuredClone(origin);
  mutateOrigin?.(originCandidate);
  await writeFile(join(goalDir, 'ORIGIN.yaml'), stringifyYaml(originCandidate));
  await writeFile(join(goalDir, 'SPEC.md'), '# Specification\n');
  await writeFile(join(goalDir, 'DECISIONS.md'), '# Decisions\n');
  await writeFile(
    join(goalDir, 'ALIGNMENT.md'),
    '# Alignment\n\n## Stem\n\nShip it safely.\n',
  );
  await writeFile(join(goalDir, 'PLAN.md'), '# Approved plan\n');
  return { cwd, goalDir };
}

test('recognizes exact approval tokens and rejects near misses', () => {
  assert.equal(isApprovePlanGoalChoice('Approve both'), true);
  assert.equal(isApprovePlanGoalChoice(' Approve both'), false);
  assert.equal(isApprovePlanGoalChoice('Approve both '), false);
  assert.equal(isApprovePlanGoalChoice('approve both'), false);
  assert.equal(isApprovePlanGoalChoice('Approve'), false);
  assert.equal(isApprovePlanGoalChoice('Approve Plan'), false);
  assert.equal(isPlanGoalReviewOptions([
    { label: 'Approve both' },
    { label: 'Refine' },
    { label: 'Reject both' },
  ]), true);
  assert.equal(isPlanGoalReviewOptions([
    { label: 'Approve both' },
    { label: 'Reject both' },
    { label: 'Refine' },
  ]), false);
  assert.equal(isGoalNeedsOptions([
    { label: 'Approve all' },
    { label: 'Select some' },
    { label: 'Reject all' },
    { label: 'Discuss' },
  ]), true);
  assert.equal(isApprovePlanChoice('Approve Plan'), true);
  assert.equal(isApprovePlanChoice(' Approve Plan'), false);
  assert.equal(isApprovePlanChoice('Approve Plan '), false);
  assert.equal(isApprovePlanChoice('\tApprove Plan\n'), false);
  assert.equal(isApprovePlanChoice('Approve the plan'), false);
  assert.equal(isApprovePlanChoice('Approve Plan!'), false);
  assert.equal(isStartCruiseChoice('Start Cruise'), true);
  assert.equal(isStartCruiseChoice(' Start Cruise'), false);
  assert.equal(isStartCruiseChoice('Start Cruise '), false);
  assert.equal(isStartCruiseChoice('\tStart Cruise\n'), false);
  assert.equal(isStartCruiseChoice('Start Cruise later'), false);
  assert.equal(isStartCruiseChoice('Start Cruise after saving'), false);
  assert.equal(isStartCruiseChoice('Start Cruise!'), false);
  assert.equal(isStartCruiseChoice('START CRUISE'), false);
  assert.equal(isStartCruiseChoice('start-cruise'), false);
  assert.equal(isStartCruiseChoice('Looks good'), false);
});

test('one combined snapshot binds Plan, Goal, alignment, and repository baseline', async () => {
  const { cwd, goalDir } = await createPlanContract();
  await writeFile(join(goalDir, 'GOAL.md'), '# Approved Goal\n');
  const approval = await capturePlanGoalApproval(cwd, {
    expectedRawPrompt: 'Ship it safely.',
  });
  assert.equal(approval.stage, 'plan-goal');
  assert.deepEqual(
    approval.artifacts.map(({ path }) => path),
    [
      '.cruise/goal/ORIGIN.yaml',
      '.cruise/goal/SPEC.md',
      '.cruise/goal/DECISIONS.md',
      '.cruise/goal/ALIGNMENT.md',
      '.cruise/goal/PLAN.md',
      '.cruise/goal/GOAL.md',
    ],
  );
  await verifyPlanGoalApproval(cwd, approval);
  await verifyGoalApproval(cwd, approval);

  await writeFile(join(goalDir, 'ALIGNMENT.md'), '# Alignment\n\n## Stem\n\nChanged.\n');
  await assert.rejects(
    verifyPlanGoalApproval(cwd, approval),
    /ALIGNMENT\.md changed after Plan and Goal approval/,
  );
});

test('extracts the compact alignment stem', () => {
  const markdown = '# Alignment\n\n## Stem\n\nShip one safe migration.\n\n## Must remain true\n\n- Compatibility.\n';
  assert.equal(extractAlignmentStem(markdown), 'Ship one safe migration.');
});

test('the native Goal objective names every approved bridge artifact', () => {
  const objective = buildGoalObjective('Ship one safe migration.');
  assert.match(objective, /\.cruise\/goal\/ORIGIN\.yaml/);
  assert.match(objective, /\.cruise\/goal\/ALIGNMENT\.md/);
  assert.match(objective, /\.cruise\/goal\/PLAN\.md/);
  assert.match(objective, /\.cruise\/goal\/GOAL\.md/);
  assert.match(objective, /recommended_level/);
  assert.match(objective, /cruise worker --level <2-7>/);
  assert.match(objective, /cannot attest the configured runtime selection/);
  assert.doesNotMatch(objective, /terra_agent|sol_agent|medium\/high\/xhigh|high\/xhigh\/ultra/);
  assert.match(objective, /mandatory acceptance criterion/);
});

test('Plan and Goal snapshots bind exact bytes and repository baseline', async () => {
  const { cwd, goalDir } = await createPlanContract();
  const plan = await capturePlanApproval(cwd);
  await writeFile(join(goalDir, 'GOAL.md'), '# Approved Goal\n');
  const goal = await captureGoalApproval(cwd, plan);
  await verifyGoalApproval(cwd, goal);

  await writeFile(join(goalDir, 'PLAN.md'), '# Drifted plan\n');
  await assert.rejects(verifyGoalApproval(cwd, goal), /changed after Goal approval/);
});

test('terminal Plan review binds Origin to the exact triggering prompt bytes', async () => {
  const { cwd } = await createPlanContract();
  await capturePlanApproval(cwd, { expectedRawPrompt: 'Ship it safely.' });
  await assert.rejects(
    capturePlanApproval(cwd, { expectedRawPrompt: 'Ship it safely.\n' }),
    /exact triggering prompt bytes/,
  );
});

test('Plan review independently verifies every model-authored Origin baseline field', async (t) => {
  const mutations = [
    ['root', (record) => { record.repository_baseline.root = '/tmp/invented-cruise-root'; }],
    ['head', (record) => { record.repository_baseline.head = 'a'.repeat(40); }],
    ['dirty digest', (record) => { record.repository_baseline.dirty_state_digest = 'b'.repeat(64); }],
    ['instruction files', (record) => { record.repository_baseline.instruction_files = ['invented-instructions.md']; }],
  ];

  const preparedRoot = await mkdtemp(join(tmpdir(), 'cruise-goal-real-origin-'));
  await writeFile(join(preparedRoot, 'AGENTS.md'), '# Real repository instructions\n');
  const prepared = await createPlanContract({ cwd: preparedRoot });
  const approved = await capturePlanApproval(prepared.cwd, {
    expectedRawPrompt: 'Ship it safely.',
  });
  assert.equal(approved.stage, 'plan');

  for (const [field, mutateOrigin] of mutations) {
    await t.test(`rejects invented ${field}`, async () => {
      const { cwd } = await createPlanContract({ mutateOrigin });
      await assert.rejects(
        capturePlanApproval(cwd, { expectedRawPrompt: 'Ship it safely.' }),
        /repository_baseline does not match a fresh independent capture/,
      );
    });
  }
});

test('CLOSEOUT remains forbidden throughout preparation and both inactive approvals', async () => {
  const beforePlan = await createPlanContract();
  await writeFile(join(beforePlan.goalDir, 'CLOSEOUT.md'), '# Premature closeout\n');
  await assert.rejects(
    capturePlanApproval(beforePlan.cwd),
    /CLOSEOUT\.md must not exist before native Goal activation/,
  );

  const beforeGoal = await createPlanContract();
  const plan = await capturePlanApproval(beforeGoal.cwd);
  await writeFile(join(beforeGoal.goalDir, 'GOAL.md'), '# Goal\n');
  await writeFile(join(beforeGoal.goalDir, 'CLOSEOUT.md'), '# Still premature\n');
  await assert.rejects(
    captureGoalApproval(beforeGoal.cwd, plan),
    /CLOSEOUT\.md must not exist before native Goal activation/,
  );
});

test('Goal approval rejects Plan drift and requires SPEC/DECISIONS', async () => {
  const { cwd, goalDir } = await createPlanContract();
  const plan = await capturePlanApproval(cwd);
  await writeFile(join(goalDir, 'PLAN.md'), '# Changed after review\n');
  await writeFile(join(goalDir, 'GOAL.md'), '# Goal\n');
  await assert.rejects(captureGoalApproval(cwd, plan), /changed after Plan approval/);

  const incomplete = await mkdtemp(join(tmpdir(), 'cruise-incomplete-test-'));
  await mkdir(join(incomplete, '.cruise', 'goal'), { recursive: true });
  await assert.rejects(capturePlanApproval(incomplete), /Legacy Cruise Goal suite/);
});

test('legacy suites are readable as unavailable-origin state but cannot be newly activated', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-legacy-goal-'));
  const goalDir = join(cwd, '.cruise', 'goal');
  await mkdir(goalDir, { recursive: true });
  for (const [name, body] of [
    ['SPEC.md', '# Specification\n'],
    ['DECISIONS.md', '# Decisions\n'],
    ['ALIGNMENT.md', '# Alignment\n\n## Stem\n\nLegacy outcome.\n'],
    ['PLAN.md', '# Plan\n'],
    ['GOAL.md', '# Goal\n'],
  ]) await writeFile(join(goalDir, name), body);
  const state = await inspectGoalOrigin(cwd);
  assert.equal(state.status, 'legacy_origin_unavailable');
  assert.equal(state.activation_eligible, false);
  await assert.rejects(capturePlanApproval(cwd), /raw prompt is unavailable/);
});

test('repository baseline ignores contract writes but rejects target drift', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-goal-test-'));
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 'cruise-test@example.invalid'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Cruise Test'], { cwd });
  await writeFile(join(cwd, 'app.txt'), 'stable\n');
  execFileSync('git', ['add', 'app.txt'], { cwd });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd });
  const { goalDir } = await createPlanContract({ cwd });

  const plan = await capturePlanApproval(cwd);
  await writeFile(join(goalDir, 'GOAL.md'), '# Goal created after Plan approval\n');
  const goal = await captureGoalApproval(cwd, plan);
  await writeFile(join(cwd, 'app.txt'), 'drifted\n');
  await assert.rejects(verifyGoalApproval(cwd, goal), /target repository changed/);
});

test('baseline fingerprints dirty, untracked, and non-git file contents', async () => {
  const { cwd } = await createPlanContract();
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.email', 'cruise-test@example.invalid'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Cruise Test'], { cwd });
  await writeFile(join(cwd, 'tracked.txt'), 'clean\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd });
  await writeFile(join(cwd, 'tracked.txt'), 'dirty-one\n');
  await writeFile(join(cwd, 'untracked.txt'), 'untracked-one\n');
  const first = captureRepositoryBaseline(cwd);
  await writeFile(join(cwd, 'tracked.txt'), 'dirty-two\n');
  const second = captureRepositoryBaseline(cwd);
  assert.notEqual(first.sha256, second.sha256);
  await writeFile(join(cwd, 'untracked.txt'), 'untracked-two\n');
  const third = captureRepositoryBaseline(cwd);
  assert.notEqual(second.sha256, third.sha256);

  const nonGit = await mkdtemp(join(tmpdir(), 'cruise-non-git-baseline-'));
  await writeFile(join(nonGit, 'data.txt'), 'one\n');
  const nonGitFirst = captureRepositoryBaseline(nonGit);
  await writeFile(join(nonGit, 'data.txt'), 'two\n');
  const nonGitSecond = captureRepositoryBaseline(nonGit);
  assert.notEqual(nonGitFirst.sha256, nonGitSecond.sha256);
});

test('Plan review rejects target changes made during preparation', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-goal-test-'));
  await writeFile(join(cwd, 'target.txt'), 'before\n');
  await createPlanContract({ cwd });
  const initial = captureRepositoryBaseline(cwd);
  await writeFile(join(cwd, 'target.txt'), 'after\n');
  await assert.rejects(
    capturePlanApproval(cwd, { expectedBaseline: initial }),
    /changed during Cruise preparation/,
  );
});

test('activation checks state, sets once, and accepts a fast terminal transition', async () => {
  const { cwd, goalDir } = await createPlanContract();
  const plan = await capturePlanApproval(cwd);
  await writeFile(join(goalDir, 'GOAL.md'), '# Approved Goal\n');
  const approvedSnapshot = await captureGoalApproval(cwd, plan);

  const calls = [];
  let storedGoal = null;
  let getCount = 0;
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/goal/get') {
        getCount += 1;
        if (getCount >= 2 && storedGoal) {
          storedGoal = { ...storedGoal, status: 'complete' };
        }
        return { goal: storedGoal };
      }
      if (method === 'thread/goal/set') {
        storedGoal = {
          threadId: params.threadId,
          objective: params.objective,
          status: params.status,
        };
        return { goal: storedGoal };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
  };

  const result = await activateApprovedGoal({
    client,
    threadId: 'thread-1',
    cwd,
    approvedSnapshot,
  });
  assert.equal(result.goal.status, 'complete');
  assert.deepEqual(
    calls.map(({ method }) => method),
    ['thread/goal/get', 'thread/goal/set', 'thread/goal/get'],
  );
  assert.equal(calls.filter(({ method }) => method === 'thread/goal/set').length, 1);
});
