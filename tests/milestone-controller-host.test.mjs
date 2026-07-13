import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { captureRepositoryBaseline } from '../scripts/lib/goal-contract.mjs';
import {
  createMilestoneControllerInteractionBroker,
  establishMilestoneControllerAuthority,
  invalidateMilestoneControllerAuthority,
  invalidateMilestoneControllerInteractionBroker,
} from '../scripts/lib/milestone-controller.mjs';
import {
  activateMilestoneControllerHost,
} from 'cruise-codex-plugin/milestone-controller-host';
import { parseYaml, stringifyYaml } from '../scripts/lib/yaml-state.mjs';
import { createMilestoneRuntimeFixture } from './helpers/milestone-runtime-fixture.mjs';

const MILESTONE_PATH = '.cruise/milestones/M-003-safe-rollout';
const CONTROLLER_PATH = '.cruise/goal/MILESTONE-CONTROLLER.yaml';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function createProductionHostContext(label) {
  const cwd = await mkdtemp(join(tmpdir(), `cruise-controller-${label}-`));
  await mkdir(join(cwd, '.cruise', 'goal'), { recursive: true });
  const fixture = await createMilestoneRuntimeFixture(cwd);
  const broker = createMilestoneControllerInteractionBroker({
    sessionId: `production-host-${label}`,
    runId: `production-run-${label}`,
  });
  const selectionReceipt = broker.observeStructuredSelection({
    interactionId: `production-selection-${label}`,
    answer: 'Use Milestone Controller M-003',
    source: 'option',
    now: '2026-07-13T10:00:00.000Z',
  });
  const authority = await establishMilestoneControllerAuthority({
    interactionBroker: broker,
    selectionReceipt,
    verifiedBuildApproval: fixture.verifiedBuildApproval,
    now: '2026-07-13T10:01:00.000Z',
  });
  const controllerBytes = await readFile(join(cwd, CONTROLLER_PATH));
  const artifacts = [{ path: CONTROLLER_PATH, sha256: sha256(controllerBytes) }];
  const objective = `Operate the approved ${label} controller.`;
  const approvedSnapshot = {
    stage: 'goal',
    controllerAuthority: authority,
    baseline: captureRepositoryBaseline(cwd),
    artifacts,
  };
  const activationResult = {
    goal: { status: 'active', objective },
    objective,
    artifacts,
  };
  return {
    cwd,
    fixture,
    broker,
    authority,
    approvedSnapshot,
    activationResult,
    hostInput: {
      cwd,
      interactionBroker: broker,
      controllerAuthority: authority,
      verifiedBuildApproval: fixture.verifiedBuildApproval,
      approvedSnapshot,
      activationResult,
      threadId: `production-thread-${label}`,
      interactionId: `production-activation-${label}`,
      now: '2026-07-13T10:02:00.000Z',
    },
  };
}

test('production host exchanges native activation and drives persistent interactive state', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-controller-host-'));
  await mkdir(join(cwd, '.cruise', 'goal'), { recursive: true });
  const fixture = await createMilestoneRuntimeFixture(cwd);
  const broker = createMilestoneControllerInteractionBroker({
    sessionId: 'production-host-session',
    runId: 'production-host-run',
  });
  const selectionReceipt = broker.observeStructuredSelection({
    interactionId: 'production-host-selection',
    answer: 'Use Milestone Controller M-003',
    source: 'option',
    now: '2026-07-13T10:00:00.000Z',
  });
  const authority = await establishMilestoneControllerAuthority({
    interactionBroker: broker,
    selectionReceipt,
    verifiedBuildApproval: fixture.verifiedBuildApproval,
    now: '2026-07-13T10:01:00.000Z',
  });
  const controllerBytes = await readFile(join(cwd, CONTROLLER_PATH));
  const artifacts = [{ path: CONTROLLER_PATH, sha256: sha256(controllerBytes) }];
  const objective = 'Operate the approved production-host controller.';
  const approvedSnapshot = {
    stage: 'goal',
    controllerAuthority: authority,
    baseline: captureRepositoryBaseline(cwd),
    artifacts,
  };
  const activationResult = {
    goal: { status: 'active', objective },
    objective,
    artifacts,
  };

  const activated = await activateMilestoneControllerHost({
    cwd,
    interactionBroker: broker,
    controllerAuthority: authority,
    verifiedBuildApproval: fixture.verifiedBuildApproval,
    approvedSnapshot,
    activationResult,
    threadId: 'production-host-thread',
    interactionId: 'production-host-activation',
    now: '2026-07-13T10:02:00.000Z',
  });

  assert.equal(activated.disposition, 'created');
  assert.equal(activated.driver.describe().status, 'ready');
  assert.deepEqual(activated.driver.state.ready_phase_ids, ['P-01']);

  const paused = await activated.driver.pauseQuestion({
    phaseId: 'P-01',
    question: 'Which compatible rollout should this phase use?',
    materiality: 'product_or_architecture_fork',
    rationale: 'The repository supports two materially different compatible rollout paths.',
    reopeningTrigger: 'The protected interface changes.',
    now: '2026-07-13T10:03:00.000Z',
  });
  assert.equal(paused.state.status, 'paused');
  assert.equal(paused.state.question_cursor.pending_question_id, 'Q-01');

  const answered = await activated.driver.answerQuestion({
    questionId: 'Q-01',
    answer: 'Use the smallest reversible rollout.',
    answerSource: 'direct_user',
    now: '2026-07-13T10:04:00.000Z',
  });
  assert.equal(answered.state.status, 'ready');
  assert.equal(answered.state.revision, 2);

  const reloaded = await activated.driver.reload();
  assert.equal(reloaded.revision, 2);
  assert.equal(reloaded.phases[0].questions[0].answer_source, 'direct_user');
  const questions = parseYaml(await readFile(
    join(cwd, MILESTONE_PATH, 'phases', 'P-01', 'QUESTIONS.yaml'),
    'utf8',
  ));
  assert.equal(questions.controller_revision, 2);
  assert.deepEqual(
    questions.events.map(({ type }) => type),
    ['opened', 'answered'],
  );

  assert.equal(await activated.driver.close('test_complete'), true);
  assert.equal(activated.driver.closed, true);
  assert.throws(() => activated.driver.describe(), /driver is closed/);
});

test('production host recovers durable history before interpreting a stale Build draft mirror', async () => {
  const context = await createProductionHostContext('history-recovery');
  const statePath = join(context.cwd, MILESTONE_PATH, 'STATE.yaml');
  const buildDraftBytes = await readFile(statePath);
  const first = await activateMilestoneControllerHost(context.hostInput);
  assert.equal(first.disposition, 'created');

  // Model the crash window after immutable history append but before the
  // canonical state mirror is rolled forward.
  await writeFile(statePath, buildDraftBytes);
  const recovered = await activateMilestoneControllerHost(context.hostInput);

  assert.equal(recovered.disposition, 'loaded');
  assert.equal(recovered.driver.state.revision, 0);
  assert.equal(
    parseYaml(await readFile(statePath, 'utf8')).kind,
    'cruise_milestone_controller_state',
  );
  assert.equal(await first.driver.close('test_complete'), true);
  assert.equal(await recovered.driver.close('test_complete'), true);
});

const INVALID_DRAFT_MUTATIONS = [
  ['unexpected outer field', (state) => {
    state.unexpected = true;
  }],
  ['project binding', (state) => {
    state.project_id = 'PRJ-99';
  }],
  ['repository baseline binding', (state) => {
    state.current_repository_baseline = 'f'.repeat(64);
  }],
  ['readiness binding', (state) => {
    state.readiness_digest = 'f'.repeat(64);
  }],
  ['Origin binding', (state) => {
    state.artifact_identities.origin_sha256 = 'f'.repeat(64);
  }],
  ['Build contract binding', (state) => {
    state.artifact_identities.contract_digest = 'f'.repeat(64);
  }],
  ['queue definition binding', (state) => {
    state.artifact_identities.queue_definition_sha256 = 'f'.repeat(64);
  }],
];

for (const [label, mutate] of INVALID_DRAFT_MUTATIONS) {
  test(`production host rejects a Build draft with invalid ${label}`, async () => {
    const context = await createProductionHostContext(
      `invalid-${label.toLowerCase().replaceAll(' ', '-')}`,
    );
    const statePath = join(context.cwd, MILESTONE_PATH, 'STATE.yaml');
    const state = parseYaml(await readFile(statePath, 'utf8'));
    mutate(state);
    const malformedBytes = stringifyYaml(state);
    await writeFile(statePath, malformedBytes);

    await assert.rejects(
      activateMilestoneControllerHost(context.hostInput),
      /exact Build draft|canonical Build fields|bindings do not match verified Build approval/,
    );
    assert.equal(await readFile(statePath, 'utf8'), malformedBytes);
    invalidateMilestoneControllerAuthority(context.authority, 'test_complete');
    invalidateMilestoneControllerInteractionBroker(context.broker, 'test_complete');
  });
}
