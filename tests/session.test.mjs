import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { CruiseSession } from '../scripts/lib/session.mjs';
import { MODEL_IDS } from '../scripts/lib/model-policy.mjs';
import { createLineReader } from '../scripts/lib/line-input.mjs';
import { pickOne } from '../scripts/lib/picker.mjs';
import { createOriginRecord } from '../scripts/lib/origin.mjs';
import {
  createDeterministicProbe,
  deterministicProbeDigest,
} from '../scripts/lib/routing.mjs';
import { stringifyYaml } from '../scripts/lib/yaml-state.mjs';
import { createMilestoneRuntimeFixture } from './helpers/milestone-runtime-fixture.mjs';

class MemoryOutput {
  constructor() {
    this.value = '';
  }

  write(chunk) {
    this.value += String(chunk);
    return true;
  }
}

class FakeAppServer extends EventEmitter {
  constructor({
    labels = ['Reject all', 'Approve both'],
    onResponse = null,
    onTurnStart = null,
    autoCompleteGoalTurn = true,
    concurrentApprovals = false,
    executionApprovals = false,
    resolveSecondApproval = false,
    settingsGate = null,
    goalSetGate = null,
    commitAfterGoalSetGate = false,
    suppressTerminal = false,
    failConfirmationGet = false,
    failPauseSet = false,
    delayGoalGetNumber = null,
    goalGetGate = null,
    replaceGoalOnGetNumber = null,
    approvalReason = 'Test approval',
  } = {}) {
    super();
    this.labels = labels;
    this.onResponse = onResponse;
    this.onTurnStart = onTurnStart;
    this.autoCompleteGoalTurn = autoCompleteGoalTurn;
    this.concurrentApprovals = concurrentApprovals;
    this.executionApprovals = executionApprovals;
    this.resolveSecondApproval = resolveSecondApproval;
    this.settingsGate = settingsGate;
    this.goalSetGate = goalSetGate;
    this.commitAfterGoalSetGate = commitAfterGoalSetGate;
    this.suppressTerminal = suppressTerminal;
    this.failConfirmationGet = failConfirmationGet;
    this.failPauseSet = failPauseSet;
    this.delayGoalGetNumber = delayGoalGetNumber;
    this.goalGetGate = goalGetGate;
    this.replaceGoalOnGetNumber = replaceGoalOnGetNumber;
    this.approvalReason = approvalReason;
    this.calls = [];
    this.responses = [];
    this.errors = [];
    this.goal = null;
    this.stopped = false;
    this._approvalResponses = 0;
    this._goalGetCount = 0;
    this._settingsUpdateCount = 0;
  }

  async start() {
    this.calls.push({ method: 'initialize' });
    return {};
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'model/list') {
      return {
        data: [{
          id: MODEL_IDS.sol,
          model: MODEL_IDS.sol,
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: 'high',
          supportedReasoningEfforts: ['high', 'xhigh', 'ultra'],
        }],
      };
    }
    if (method === 'thread/start') {
      return {
        thread: { id: 'thread-test' },
        model: 'gpt-root',
        reasoningEffort: 'medium',
      };
    }
    if (method === 'turn/start') {
      queueMicrotask(() => {
        Promise.resolve(this.onTurnStart?.()).then(() => {
          if (this.concurrentApprovals) {
            this.emitApproval('approval-a');
            this.emitApproval('approval-b');
            if (this.resolveSecondApproval) {
              this.emit('notification', {
                method: 'serverRequest/resolved',
                params: { threadId: 'thread-test', requestId: 'approval-b' },
              });
            }
          } else {
            this.emitQuestion(0);
          }
        });
      });
      return { turn: { id: 'turn-prep', status: 'inProgress' } };
    }
    if (method === 'thread/settings/update') {
      if (params.collaborationMode?.mode === 'default') {
        this._settingsUpdateCount += 1;
        if (this.settingsGate && this._settingsUpdateCount === 2) {
          this.emit('settings-requested');
          await this.settingsGate.promise;
        }
      }
      return {};
    }
    if (method === 'thread/goal/get') {
      this._goalGetCount += 1;
      if (this.failConfirmationGet && this._goalGetCount === 2) {
        throw new Error('confirmation transport failed');
      }
      if (this.delayGoalGetNumber === this._goalGetCount && this.goalGetGate) {
        this.emit('goal-get-delayed');
        await this.goalGetGate.promise;
      }
      if (this.replaceGoalOnGetNumber === this._goalGetCount) {
        this.goal = {
          threadId: params.threadId,
          objective: 'Unrelated replacement Goal.',
          status: 'active',
          tokensUsed: 0,
        };
      }
      return { goal: this.goal };
    }
    if (method === 'thread/goal/set') {
      if (params.objective) {
        if (this.commitAfterGoalSetGate && this.goalSetGate) {
          this.emit('goal-set-pending');
          await this.goalSetGate.promise;
        }
        this.goal = {
          threadId: params.threadId,
          objective: params.objective,
          status: params.status,
          tokensUsed: 0,
        };
        queueMicrotask(() => {
          this.emit('notification', {
            method: 'thread/goal/updated',
            params: { threadId: 'thread-test', turnId: null, goal: this.goal },
          });
          this.emit('notification', {
            method: 'turn/started',
            params: {
              threadId: 'thread-test',
              turn: { id: 'turn-goal', status: 'inProgress' },
            },
          });
          if (this.executionApprovals) {
            this.emitApproval('approval-a', 'turn-goal');
            this.emitApproval('approval-b', 'turn-goal');
            if (this.resolveSecondApproval) {
              this.emit('notification', {
                method: 'serverRequest/resolved',
                params: { threadId: 'thread-test', requestId: 'approval-b' },
              });
            }
          }
        });
        this.emit('goal-set-committed');
        if (!this.commitAfterGoalSetGate && this.goalSetGate) {
          await this.goalSetGate.promise;
        }
        if (!this.suppressTerminal && !this.executionApprovals) {
          setImmediate(() => this.emitTerminalGoal());
        }
      } else {
        if (this.failPauseSet) throw new Error('pause transport failed');
        this.goal = { ...this.goal, status: params.status };
        queueMicrotask(() => {
          this.emit('notification', {
            method: 'thread/goal/updated',
            params: { threadId: 'thread-test', turnId: this.goal ? 'turn-goal' : null, goal: this.goal },
          });
        });
      }
      return { goal: this.goal };
    }
    if (method === 'turn/interrupt') return {};
    throw new Error(`Unexpected request: ${method}`);
  }

  respond(id, result) {
    this.responses.push({ id, result });
    if (id.startsWith('approval-')) {
      this._approvalResponses += 1;
      const expected = this.resolveSecondApproval ? 1 : 2;
      if (this._approvalResponses === expected) {
        if (this.executionApprovals) setImmediate(() => this.emitTerminalGoal());
        else queueMicrotask(() => this.emitQuestion(0));
      }
      return;
    }

    const index = Number(id.slice(1));
    Promise.resolve(this.onResponse?.({ id, index, result }))
      .then(() => {
        if (index + 1 < this.labels.length) this.emitQuestion(index + 1);
        else this.completePreparation();
      });
  }

  respondError(id, codeOrError, message) {
    this.errors.push({ id, codeOrError, message });
  }

  emitQuestion(index) {
    const label = this.labels[index];
    const combined = ['Approve both', 'Refine', 'Reject both'].includes(label);
    const needs = label === 'Reject all';
    if (combined) {
      this.emit('notification', {
        method: 'item/completed',
        params: {
          threadId: 'thread-test',
          turnId: 'turn-prep',
          item: {
            type: 'plan',
            id: `plan-${index}`,
            text: '# Plan\n\nPrepared implementation plan.\n\n# Goal\n\nPrepared durable Goal.\n',
          },
        },
      });
    }
    this.emit('request', {
      method: 'item/tool/requestUserInput',
      id: `q${index}`,
      params: {
        threadId: 'thread-test',
        turnId: 'turn-prep',
        itemId: `item-q${index}`,
        autoResolutionMs: null,
        questions: [
          {
            id: `q${index}`,
            header: combined
              ? 'Plan and Goal'
              : needs
                ? 'Goal needs'
              : label === 'Approve Plan'
                ? 'Plan review'
                : 'Goal review',
            question: 'Continue?',
            isOther: true,
            isSecret: false,
            options: combined
              ? [
                  { label: 'Approve both', description: 'Activate the reviewed pair.' },
                  { label: 'Refine', description: 'Revise the reviewed pair.' },
                  { label: 'Reject both', description: 'Keep work inactive.' },
                ]
              : needs
                ? [
                    { label: 'Approve all', description: 'Approve displayed needs.' },
                    { label: 'Select some', description: 'Choose a subset.' },
                    { label: 'Reject all', description: 'Remain interactive.' },
                    { label: 'Discuss', description: 'Discuss the envelope.' },
                  ]
              : [
                  { label, description: 'Use the reviewed artifact.' },
                  { label: 'Revise', description: 'Return to preparation.' },
                ],
          },
        ],
      },
    });
  }

  emitApproval(id, turnId = 'turn-prep') {
    this.emit('request', {
      method: 'item/commandExecution/requestApproval',
      id,
      params: {
        threadId: 'thread-test',
        turnId,
        itemId: `item-${id}`,
        command: `command-${id}`,
        reason: this.approvalReason,
        availableDecisions: ['accept', 'decline'],
      },
    });
  }

  completePreparation() {
    this.emit('notification', {
      method: 'turn/completed',
      params: {
        threadId: 'thread-test',
        turn: { id: 'turn-prep', status: 'completed' },
      },
    });
  }

  emitTerminalGoal() {
    this.goal = { ...this.goal, status: 'complete', tokensUsed: 42 };
    this.emit('notification', {
      method: 'thread/goal/updated',
      params: { threadId: 'thread-test', turnId: 'turn-goal', goal: this.goal },
    });
    this.emit('terminal-emitted');
    if (this.autoCompleteGoalTurn) setImmediate(() => this.completeGoalTurn());
  }

  completeGoalTurn(status = 'completed') {
    this.emit('notification', {
      method: 'turn/completed',
      params: {
        threadId: 'thread-test',
        turn: { id: 'turn-goal', status },
      },
    });
  }

  async stop() {
    this.stopped = true;
    return { code: 0, signal: null, error: null };
  }
}

function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function createContract({ mutateOrigin = null } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-session-test-'));
  const directory = join(cwd, '.cruise', 'goal');
  await mkdir(directory, { recursive: true });
  const probe = createDeterministicProbe({ repository: { root: cwd } });
  const origin = createOriginRecord({
    rawPrompt: 'Ship the migration.',
    selectedSkill: 'goal',
    repositoryRoot: cwd,
    deterministicProbeDigest: deterministicProbeDigest(probe),
    initialClassifier: 'gpt-5.6-luna medium',
    selectedRoute: 'goal',
    confidence: 0.96,
    goal: { outcome: 'Deliver the approved slice safely.' },
  });
  const originCandidate = structuredClone(origin);
  mutateOrigin?.(originCandidate);
  await writeFile(join(directory, 'ORIGIN.yaml'), stringifyYaml(originCandidate));
  await writeFile(join(directory, 'SPEC.md'), '# Specification\n');
  await writeFile(join(directory, 'DECISIONS.md'), '# Decisions\n');
  await writeFile(
    join(directory, 'ALIGNMENT.md'),
    '# Alignment\n\n## Stem\n\nDeliver the approved slice safely.\n',
  );
  await writeFile(join(directory, 'PLAN.md'), '# Approved plan\n');
  await writeFile(join(directory, 'GOAL.md'), '# Approved Goal\n');
  return { cwd, directory };
}

function createSession(client, cwd, overrides = {}) {
  const output = new MemoryOutput();
  const errorOutput = new MemoryOutput();
  return {
    output,
    errorOutput,
    session: new CruiseSession({
      client,
      cwd,
      prompt: 'Ship the migration.',
      skillPath: '/plugin/skills/goal/SKILL.md',
      pickOne: async ({ options }) => {
        const rejectAll = options.findIndex((option) => option.startsWith('Reject all'));
        return {
          status: 'selected',
          index: rejectAll >= 0 ? rejectAll : 0,
          value: '',
          via: 'tty',
        };
      },
      readLine: async () => 'Other answer',
      input: {},
      output,
      errorOutput,
      continuationGraceMs: 20,
      ...overrides,
    }),
  };
}

test('terminal session rejects an absent request instead of inventing Origin bytes', async () => {
  const { cwd } = await createContract();
  assert.throws(
    () => createSession(new FakeAppServer(), cwd, { prompt: '' }),
    /requires a non-empty request/,
  );
});

test('typed Other text cannot select a milestone controller', async () => {
  const { cwd } = await createContract();
  await createMilestoneRuntimeFixture(cwd);
  const label = 'Use Milestone Controller M-003';
  const client = new FakeAppServer({ labels: [label] });
  const { session } = createSession(client, cwd, {
    pickOne: async () => ({ status: 'selected', index: 2, value: '', via: 'tty' }),
    readLine: async () => label,
    resolveBuildApproval: async () => {
      throw new Error('typed text must never reach the Build approval resolver');
    },
  });

  const result = await session.run();

  assert.equal(result.status, 'saved');
  assert.match(
    client.responses[0].result.answers.q0.answers[0],
    /exact structured Use Milestone Controller M-XX option/,
  );
});

test('milestone controller selection rejects an unverified persisted Build approval', async () => {
  const { cwd } = await createContract();
  const fixture = await createMilestoneRuntimeFixture(cwd);
  const client = new FakeAppServer({ labels: ['Use Milestone Controller M-003'] });
  const { session } = createSession(client, cwd, {
    resolveBuildApproval: async () => ({ approval: fixture.persistedBuildApproval }),
  });

  const result = await session.run();

  assert.equal(result.status, 'saved');
  assert.match(
    client.responses[0].result.answers.q0.answers[0],
    /Milestone Controller rejected by Cruise client/,
  );
});

test('exact controller option plus re-verified Build receipt preserves combined review flow', async () => {
  const { cwd } = await createContract();
  const fixture = await createMilestoneRuntimeFixture(cwd);
  const client = new FakeAppServer({
    labels: ['Use Milestone Controller M-003', 'Reject all', 'Approve both'],
  });
  const { session, errorOutput } = createSession(client, cwd, {
    resolveBuildApproval: async () => ({
      approval: fixture.persistedBuildApproval,
      approvalSelection: fixture.buildSelection,
      buildOriginPairAuthority: fixture.buildOriginPairAuthority,
      buildIdHistoryAuthority: fixture.buildIdHistoryAuthority,
    }),
  });
  let readyDriver = null;
  session.once('milestoneControllerReady', (driver) => {
    readyDriver = driver;
  });

  const result = await session.run();

  assert.equal(result.status, 'complete');
  assert.equal(result.controllerDriver, readyDriver);
  assert.equal(result.controllerDriver.describe().milestone_id, 'M-003');
  assert.equal(result.controllerDriver.state.kind, 'cruise_milestone_controller_state');
  assert.match(client.goal.objective, /hierarchical milestone controller for M-003/);
  assert.match(errorOutput.value, /Project handoff selected: M-003/);
  assert.match(errorOutput.value, /Project handoff is created: M-003/);
  assert.deepEqual(client.responses.map(({ id }) => id), ['q0', 'q1', 'q2']);
  assert.equal(await result.controllerDriver.close('test_complete'), true);
});

test('controller bootstrap failure pauses the just-activated Goal before the session throws', async () => {
  const { cwd } = await createContract();
  const fixture = await createMilestoneRuntimeFixture(cwd);
  const statePath = join(
    cwd,
    '.cruise',
    'milestones',
    'M-003-rollout',
    'STATE.yaml',
  );
  const client = new FakeAppServer({
    labels: ['Use Milestone Controller M-003', 'Reject all', 'Approve both'],
    suppressTerminal: true,
    onResponse: async ({ index }) => {
      if (index === 2) {
        await writeFile(statePath, stringifyYaml({
          schema_version: 1,
          kind: 'cruise_milestone_controller_state',
        }));
      }
    },
  });
  const { session } = createSession(client, cwd, {
    resolveBuildApproval: async () => ({
      approval: fixture.persistedBuildApproval,
      approvalSelection: fixture.buildSelection,
      buildOriginPairAuthority: fixture.buildOriginPairAuthority,
      buildIdHistoryAuthority: fixture.buildIdHistoryAuthority,
    }),
  });

  await assert.rejects(
    session.run(),
    /runtime bootstrap failed; the matching native Goal was paused safely/,
  );
  assert.equal(client.goal.status, 'paused');
  assert.equal(client.stopped, true);
});

test('controller bootstrap failure never pauses a concurrently replaced Goal', async () => {
  const { cwd } = await createContract();
  const fixture = await createMilestoneRuntimeFixture(cwd);
  const statePath = join(
    cwd,
    '.cruise',
    'milestones',
    'M-003-rollout',
    'STATE.yaml',
  );
  const client = new FakeAppServer({
    labels: ['Use Milestone Controller M-003', 'Reject all', 'Approve both'],
    suppressTerminal: true,
    replaceGoalOnGetNumber: 3,
    onResponse: async ({ index }) => {
      if (index === 2) {
        await writeFile(statePath, stringifyYaml({
          schema_version: 1,
          kind: 'cruise_milestone_controller_state',
        }));
      }
    },
  });
  const { session } = createSession(client, cwd, {
    resolveBuildApproval: async () => ({
      approval: fixture.persistedBuildApproval,
      approvalSelection: fixture.buildSelection,
      buildOriginPairAuthority: fixture.buildOriginPairAuthority,
      buildIdHistoryAuthority: fixture.buildIdHistoryAuthority,
    }),
  });

  await assert.rejects(
    session.run(),
    /current Goal no longer matches.*left it unchanged/s,
  );
  assert.equal(client.goal.objective, 'Unrelated replacement Goal.');
  assert.equal(client.goal.status, 'active');
  assert.equal(
    client.calls.some(
      ({ method, params }) =>
        method === 'thread/goal/set' && !params.objective && params.status === 'paused',
    ),
    false,
  );
  assert.equal(client.stopped, true);
});

test('combined Plan-and-Goal approval activates native Goal exactly once', async () => {
  const { cwd } = await createContract();
  const client = new FakeAppServer();
  const { session, errorOutput } = createSession(client, cwd);
  const result = await session.run();
  const canonicalCwd = await realpath(cwd);

  assert.equal(result.status, 'complete');
  assert.deepEqual(client.responses.map(({ id }) => id), ['q0', 'q1']);
  const methods = client.calls.map(({ method }) => method);
  assert.ok(methods.indexOf('thread/settings/update') < methods.indexOf('thread/goal/set'));
  assert.equal(
    client.calls.filter(
      ({ method, params }) => method === 'thread/goal/set' && params.objective,
    ).length,
    1,
  );
  assert.match(client.goal.objective, /ALIGNMENT\.md/);
  assert.match(client.goal.objective, /ORIGIN\.yaml/);
  assert.match(client.goal.objective, /PLAN\.md/);
  assert.match(client.goal.objective, /GOAL\.md/);
  assert.match(errorOutput.value, /Combined Plan and Goal review is ready/);
  assert.match(errorOutput.value, /Plan and Goal approval saved/);
  assert.doesNotMatch(errorOutput.value, /sha-?256|digest/iu);
  assert.match(errorOutput.value, /Work has started/);
  assert.equal(client.stopped, true);

  const turnStart = client.calls.find(({ method }) => method === 'turn/start');
  assert.equal(turnStart.params.collaborationMode.mode, 'default');
  assert.equal(turnStart.params.approvalPolicy, 'on-request');
  assert.deepEqual(turnStart.params.runtimeWorkspaceRoots, []);
  assert.equal(turnStart.params.cwd, join(canonicalCwd, '.cruise', 'goal'));
  assert.deepEqual(turnStart.params.sandboxPolicy.writableRoots, [
    join(canonicalCwd, '.cruise', 'goal'),
  ]);
  assert.match(
    turnStart.params.collaborationMode.settings.developer_instructions,
    /only\s+under \.cruise\/goal/,
  );
  assert.match(
    turnStart.params.collaborationMode.settings.developer_instructions,
    /no persistent Build-approval resolver.*single-slice Goal mode/s,
  );
  assert.match(
    turnStart.params.input.find(({ type }) => type === 'text').text,
    /single-slice Goal only: do not offer Use Milestone Controller/,
  );
  assert.equal(client.calls.some(({ method }) => method === 'model/list'), false);
  assert.equal(turnStart.params.model, 'gpt-root');
  assert.equal(turnStart.params.effort, 'medium');
  assert.equal(turnStart.params.collaborationMode.settings.model, 'gpt-root');
  assert.equal(turnStart.params.collaborationMode.settings.reasoning_effort, 'medium');
  const settings = client.calls.filter(({ method }) => method === 'thread/settings/update');
  assert.deepEqual(settings.map(({ params }) => params.collaborationMode.mode), ['default', 'default']);
  assert.ok(client.calls.indexOf(settings[0]) < client.calls.indexOf(turnStart));
  assert.equal(settings[0].params.cwd, join(canonicalCwd, '.cruise', 'goal'));
  assert.equal(settings[0].params.approvalPolicy, 'on-request');
  assert.equal(settings[1].params.cwd, canonicalCwd);
  assert.equal(settings[1].params.approvalPolicy, 'on-request');
  assert.deepEqual(settings[1].params.sandboxPolicy.writableRoots, [canonicalCwd]);
  assert.equal(settings[1].params.collaborationMode.settings.model, 'gpt-root');
  assert.equal(settings[1].params.collaborationMode.settings.reasoning_effort, 'medium');
  const threadStart = client.calls.find(({ method }) => method === 'thread/start');
  assert.deepEqual(threadStart.params.runtimeWorkspaceRoots, []);
  assert.equal(Object.hasOwn(threadStart.params, 'model'), false);
});

test('one combined Plan-and-Goal approval activates native Goal without an intermediate write window', async () => {
  const { cwd } = await createContract();
  const client = new FakeAppServer({ labels: ['Reject all', 'Approve both'] });
  const { session, errorOutput } = createSession(client, cwd);

  const result = await session.run();

  assert.equal(result.status, 'complete');
  assert.match(errorOutput.value, /Combined Plan and Goal review is ready/);
  assert.match(errorOutput.value, /Plan and Goal approval saved/);
  assert.equal(client.responses.length, 2);
  assert.deepEqual(
    client.responses[1].result.answers.q1.answers,
    ['Approve both'],
  );
  assert.equal(
    client.calls.filter(({ method, params }) =>
      method === 'thread/goal/set' && params.objective,
    ).length,
    1,
  );
});

test('Refine and Reject both apply to the Plan-and-Goal pair and keep execution inactive', async (t) => {
  for (const choice of ['Refine', 'Reject both']) {
    await t.test(choice, async () => {
      const { cwd } = await createContract();
      const client = new FakeAppServer({ labels: ['Reject all', choice] });
      const { session, errorOutput } = createSession(client, cwd, {
        pickOne: async ({ options }) => {
          const wanted = options.findIndex((option) => option.startsWith(choice));
          const rejectAll = options.findIndex((option) => option.startsWith('Reject all'));
          return {
            status: 'selected',
            index: wanted >= 0 ? wanted : rejectAll,
            value: '',
            via: 'tty',
          };
        },
      });

      const result = await session.run();

      assert.equal(result.status, 'saved');
      assert.deepEqual(client.responses[1].result.answers.q1.answers, [choice]);
      assert.equal(client.calls.some(({ method }) => method === 'thread/goal/set'), false);
      assert.match(
        errorOutput.value,
        choice === 'Refine' ? /Plan and Goal returned for refinement/ : /Plan and Goal rejected/,
      );
    });
  }
});

test('combined approval falls back immediately when no native Plan item is observed', async () => {
  const { cwd } = await createContract();
  const client = new FakeAppServer({ labels: ['Reject all', 'Approve both'] });
  client.emitQuestion = function emitWithoutPlan(index) {
    if (index === 0) {
      return FakeAppServer.prototype.emitQuestion.call(this, index);
    }
    this.emit('request', {
      method: 'item/tool/requestUserInput',
      id: `q${index}`,
      params: {
        threadId: 'thread-test',
        turnId: 'turn-prep',
        itemId: `item-q${index}`,
        autoResolutionMs: null,
        questions: [{
          id: `q${index}`,
          header: 'Plan and Goal',
          question: 'Approve the Plan and Goal?',
          isOther: true,
          isSecret: false,
          options: [
            { label: 'Approve both', description: 'Activate the pair.' },
            { label: 'Refine', description: 'Revise the pair.' },
            { label: 'Reject both', description: 'Keep work inactive.' },
          ],
        }],
      },
    });
  };
  const rendered = [];
  const { session } = createSession(client, cwd, {
    nativePlanPresentation: true,
    renderPlan: (approval) => rendered.push(approval),
  });

  const result = await session.run();

  assert.equal(result.status, 'complete');
  assert.deepEqual(client.responses[1].result.answers.q1.answers, ['Approve both']);
  assert.equal(rendered.length, 1);
  assert.equal(
    client.calls.find(({ method }) => method === 'turn/start').params.collaborationMode.mode,
    'plan',
  );
});

test('Cruise CLI renders its deterministic captured preview instead of arbitrary native item text', async () => {
  const { cwd } = await createContract();
  const client = new FakeAppServer({ labels: ['Reject all', 'Approve both'] });
  const rendered = [];
  const { session } = createSession(client, cwd, {
    renderPlan: (approval, output) => {
      rendered.push(approval);
      output.write('glow plan\n');
    },
  });
  queueMicrotask(() => {
    client.emit('notification', {
      method: 'item/completed',
      params: {
        threadId: 'thread-test',
        turnId: 'turn-prep',
        item: { type: 'plan', id: 'plan-1', text: '## Plan\n\n## Goal\n' },
      },
    });
  });

  await session.run();

  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].stage, 'plan-goal');
});

test('GUI-capable host uses an actually observed native combined Plan item', async () => {
  const { cwd } = await createContract();
  const client = new FakeAppServer();
  const rendered = [];
  const { session } = createSession(client, cwd, {
    nativePlanPresentation: true,
    renderPlan: (approval) => rendered.push(approval),
  });

  const result = await session.run();

  assert.equal(result.status, 'complete');
  assert.equal(rendered.length, 0);
  assert.equal(
    client.calls.find(({ method }) => method === 'turn/start').params.collaborationMode.mode,
    'plan',
  );
});

test('native Goal sessions apply the Cruise class to preparation and execution host settings', async () => {
  const { cwd } = await createContract();
  const client = new FakeAppServer();
  const { session } = createSession(client, cwd, {
    cruiseClass: { cruise_class: 'luxury-cruise' },
  });
  const result = await session.run();

  assert.equal(result.status, 'complete');
  const threadStart = client.calls.find(({ method }) => method === 'thread/start').params;
  assert.equal(threadStart.model, MODEL_IDS.sol);
  assert.equal(threadStart.allowProviderModelFallback, false);
  assert.match(threadStart.developerInstructions, /pinned to level 6/u);
  const turnStart = client.calls.find(({ method }) => method === 'turn/start').params;
  assert.equal(turnStart.model, MODEL_IDS.sol);
  assert.equal(turnStart.effort, 'xhigh');
  assert.match(
    turnStart.collaborationMode.settings.developer_instructions,
    /ordinary-work default is level 6/u,
  );
  const settings = client.calls.filter(({ method }) => method === 'thread/settings/update');
  assert.match(settings.at(-1).params.collaborationMode.settings.developer_instructions, /level 6/u);
});

test('retired Approve Plan label cannot activate a Goal', async () => {
  const { cwd } = await createContract();
  const client = new FakeAppServer({ labels: ['Approve Plan'] });
  const { session, errorOutput } = createSession(client, cwd);
  const result = await session.run();

  assert.equal(result.status, 'saved');
  assert.equal(client.calls.some(({ method }) => method === 'thread/goal/set'), false);
  assert.match(errorOutput.value, /Plan and Goal were saved/i);
});

test('retired Start Cruise label cannot activate a Goal', async () => {
  const { cwd } = await createContract();
  const client = new FakeAppServer({ labels: ['Start Cruise'] });
  const { session, errorOutput } = createSession(client, cwd);
  const result = await session.run();

  assert.equal(result.status, 'saved');
  assert.equal(client.calls.some(({ method }) => method === 'thread/goal/set'), false);
  assert.deepEqual(client.responses[0].result.answers.q0.answers, ['Start Cruise']);
  assert.match(errorOutput.value, /Plan and Goal were saved/i);
});

test('artifact drift after combined selection prevents native activation', async () => {
  const { cwd, directory } = await createContract();
  const client = new FakeAppServer({
    onResponse: async ({ index }) => {
      if (index === 1) await writeFile(join(directory, 'PLAN.md'), '# Drifted plan\n');
    },
  });
  const { session } = createSession(client, cwd);
  await assert.rejects(session.run(), /PLAN\.md changed after Plan and Goal approval/);
  assert.equal(client.calls.some(({ method }) => method === 'thread/goal/set'), false);
});

test('an artifact write after combined selection prevents native activation', async () => {
  const { cwd, directory } = await createContract();
  const client = new FakeAppServer({
    onResponse: async ({ index }) => {
      if (index === 1) {
        await writeFile(join(directory, 'GOAL.md'), '# Post-approval write is forbidden\n');
      }
    },
  });
  const { session } = createSession(client, cwd);
  await assert.rejects(session.run(), /GOAL\.md changed after Plan and Goal approval/);
  assert.equal(
    client.calls.some(
      ({ method, params }) => method === 'thread/goal/set' && params.objective,
    ),
    false,
  );
});

test('target drift during preparation prevents combined approval', async () => {
  const { cwd } = await createContract();
  const target = join(cwd, 'target.txt');
  await writeFile(target, 'before\n');
  const client = new FakeAppServer({
    labels: ['Reject all', 'Approve both'],
    onTurnStart: async () => writeFile(target, 'after\n'),
  });
  const { session } = createSession(client, cwd);
  const result = await session.run();

  assert.equal(result.status, 'saved');
  assert.match(
    client.responses[1].result.answers.q1.answers[0],
    /changed during Cruise preparation/,
  );
});

test('session refuses combined approval when the model invents the Origin baseline', async () => {
  const { cwd } = await createContract({
    mutateOrigin(record) {
      record.repository_baseline.dirty_state_digest = 'c'.repeat(64);
    },
  });
  const client = new FakeAppServer({ labels: ['Reject all', 'Approve both'] });
  const { session } = createSession(client, cwd);
  const result = await session.run();

  assert.equal(result.status, 'saved');
  assert.equal(client.calls.some(({ method }) => method === 'thread/goal/set'), false);
  assert.match(
    client.responses[1].result.answers.q1.answers[0],
    /repository_baseline does not match a fresh independent capture/,
  );
});

test('terminal Goal status waits for the current turn to complete', async () => {
  const { cwd } = await createContract();
  const client = new FakeAppServer({ autoCompleteGoalTurn: false });
  const { session } = createSession(client, cwd, { continuationGraceMs: 1_000 });
  let settled = false;
  const running = session.run().then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => client.once('terminal-emitted', resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  client.completeGoalTurn();
  const result = await running;
  assert.equal(result.status, 'complete');
});

test('interactive server requests are serialized FIFO', async () => {
  const { cwd } = await createContract();
  const client = new FakeAppServer({
    executionApprovals: true,
  });
  let activePickers = 0;
  let maximumActive = 0;
  const pickOne = async () => {
    activePickers += 1;
    maximumActive = Math.max(maximumActive, activePickers);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activePickers -= 1;
    return { status: 'selected', index: 0, value: '', via: 'tty' };
  };
  const { session } = createSession(client, cwd, { pickOne });
  const result = await session.run();

  assert.equal(result.status, 'complete');
  assert.equal(maximumActive, 1);
  assert.deepEqual(
    client.responses.slice(-2).map(({ id }) => id),
    ['approval-a', 'approval-b'],
  );
});

test('preparation preserves native permission choices instead of auto-denying them', async () => {
  const { cwd } = await createContract();
  const client = new FakeAppServer({
    labels: ['Reject all', 'Approve both'],
    concurrentApprovals: true,
  });
  let pickerCalls = 0;
  const { session, errorOutput } = createSession(client, cwd, {
    pickOne: async () => {
      pickerCalls += 1;
      return { status: 'selected', index: 0, value: '', via: 'tty' };
    },
  });
  const result = await session.run();

  assert.equal(result.status, 'complete');
  assert.equal(pickerCalls, 4); // Two runtime approvals, needs, and combined review
  assert.deepEqual(
    client.responses.slice(0, 2).map(({ result: response }) => response.decision),
    ['accept', 'accept'],
  );
  assert.doesNotMatch(errorOutput.value, /cannot widen permissions/);
});

test('Approve all auto-approves routine execution tool permissions but not preparation prompts', async () => {
  const { cwd } = await createContract();
  const client = new FakeAppServer({ executionApprovals: true });
  let pickerCalls = 0;
  const { session, errorOutput } = createSession(client, cwd, {
    pickOne: async () => {
      pickerCalls += 1;
      return { status: 'selected', index: 0, value: '', via: 'tty' };
    },
  });

  const result = await session.run();

  assert.equal(result.status, 'complete');
  assert.equal(pickerCalls, 2); // Needs and combined review only.
  assert.deepEqual(
    client.responses.filter(({ id }) => id.startsWith('approval-')).map(({ result: response }) => response.decision),
    ['accept', 'accept'],
  );
  assert.match(errorOutput.value, /Routine tool permission auto-approved/);
});

test('Approve all still prompts for high-risk execution authorization', async () => {
  const { cwd } = await createContract();
  const client = new FakeAppServer({
    executionApprovals: true,
    approvalReason: 'Deploy to production',
  });
  let pickerCalls = 0;
  const { session, errorOutput } = createSession(client, cwd, {
    pickOne: async () => {
      pickerCalls += 1;
      return { status: 'selected', index: 0, value: '', via: 'tty' };
    },
  });

  const result = await session.run();

  assert.equal(result.status, 'complete');
  assert.equal(pickerCalls, 4); // Needs, combined review, and both high-risk approvals.
  assert.doesNotMatch(errorOutput.value, /Routine tool permission auto-approved/);
});

test('an externally resolved queued approval is never shown or answered', async () => {
  const { cwd } = await createContract();
  const client = new FakeAppServer({
    executionApprovals: true,
    resolveSecondApproval: true,
  });
  let pickerCalls = 0;
  const { session } = createSession(client, cwd, {
    pickOne: async ({ options }) => {
      pickerCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const rejectAll = options.findIndex((option) => option.startsWith('Reject all'));
      return { status: 'selected', index: rejectAll >= 0 ? rejectAll : 0, value: '', via: 'tty' };
    },
  });
  const result = await session.run();

  assert.equal(result.status, 'complete');
  assert.equal(pickerCalls, 3); // Needs, combined review, and approval A; never approval B
  assert.equal(client.responses.some(({ id }) => id === 'approval-b'), false);
});

test('interrupt during settings transition cannot set a Goal afterward', async () => {
  const { cwd } = await createContract();
  const settingsGate = gate();
  const client = new FakeAppServer({ settingsGate, suppressTerminal: true });
  const { session } = createSession(client, cwd);
  const running = session.run();
  await new Promise((resolve) => client.once('settings-requested', resolve));
  await session.interrupt();
  settingsGate.release();

  await assert.rejects(running, /interrupted/);
  assert.equal(
    client.calls.some(
      ({ method, params }) => method === 'thread/goal/set' && params.objective,
    ),
    false,
  );
});

test('interrupt during the pre-set Goal GET cannot launch execution afterward', async () => {
  const { cwd } = await createContract();
  const goalGetGate = gate();
  const client = new FakeAppServer({
    delayGoalGetNumber: 1,
    goalGetGate,
    suppressTerminal: true,
  });
  const { session } = createSession(client, cwd);
  const running = session.run();
  await new Promise((resolve) => client.once('goal-get-delayed', resolve));
  await session.interrupt();
  goalGetGate.release();

  await assert.rejects(running, /interrupted/);
  assert.equal(
    client.calls.some(
      ({ method, params }) => method === 'thread/goal/set' && params.objective,
    ),
    false,
  );
});

test('interrupt during an already committed Goal set pauses the Goal', async () => {
  const { cwd } = await createContract();
  const goalSetGate = gate();
  const client = new FakeAppServer({ goalSetGate, suppressTerminal: true });
  const { session } = createSession(client, cwd);
  const running = session.run();
  await new Promise((resolve) => client.once('goal-set-committed', resolve));
  await session.interrupt();
  goalSetGate.release();

  await assert.rejects(running, /interrupted/);
  assert.equal(client.goal.status, 'paused');
  assert.equal(
    client.calls.filter(
      ({ method, params }) => method === 'thread/goal/set' && params.objective,
    ).length,
    1,
  );
});

test('an ended active Goal turn cannot hang without a continuation', async () => {
  const { cwd } = await createContract();
  const client = new FakeAppServer({ suppressTerminal: true });
  client.once('goal-set-committed', () => {
    setImmediate(() => client.completeGoalTurn('failed'));
  });
  const { session, errorOutput } = createSession(client, cwd, {
    continuationGraceMs: 10,
  });
  const result = await session.run();

  assert.equal(result.status, 'paused');
  assert.match(errorOutput.value, /work stopped unexpectedly.*paused/i);
});

test('continuation guard cannot pause a turn that starts while Goal GET is pending', async () => {
  const { cwd } = await createContract();
  const goalGetGate = gate();
  const client = new FakeAppServer({
    suppressTerminal: true,
    delayGoalGetNumber: 4,
    goalGetGate,
  });
  client.once('goal-set-committed', () => {
    setImmediate(() => client.completeGoalTurn('completed'));
  });
  const { session } = createSession(client, cwd, { continuationGraceMs: 10 });
  const running = session.run();
  await new Promise((resolve) => client.once('goal-get-delayed', resolve));
  client.emit('notification', {
    method: 'turn/started',
    params: {
      threadId: 'thread-test',
      turn: { id: 'turn-next', status: 'inProgress' },
    },
  });
  goalGetGate.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.goal.status, 'active');

  client.goal = { ...client.goal, status: 'complete' };
  client.emit('notification', {
    method: 'thread/goal/updated',
    params: { threadId: 'thread-test', turnId: 'turn-next', goal: client.goal },
  });
  client.emit('notification', {
    method: 'turn/completed',
    params: {
      threadId: 'thread-test',
      turn: { id: 'turn-next', status: 'completed' },
    },
  });
  const result = await running;
  assert.equal(result.status, 'complete');
  assert.equal(
    client.calls.some(
      ({ method, params }) =>
        method === 'thread/goal/set' && !params.objective && params.status === 'paused',
    ),
    false,
  );
});

test('uncertain post-set confirmation reconciles and pauses a matching Goal', async () => {
  const { cwd } = await createContract();
  const client = new FakeAppServer({
    failConfirmationGet: true,
    suppressTerminal: true,
  });
  const { session, errorOutput } = createSession(client, cwd);
  await assert.rejects(session.run(), /failed after Goal state may have changed/);

  assert.equal(client.goal.status, 'paused');
  assert.match(errorOutput.value, /Could not confirm that work began, so it was paused/);
});

test('uncertain activation polls through a late set commit and pauses it', async () => {
  const { cwd } = await createContract();
  const goalSetGate = gate();
  const client = new FakeAppServer({
    goalSetGate,
    commitAfterGoalSetGate: true,
    suppressTerminal: true,
  });
  const { session, errorOutput } = createSession(client, cwd, {
    activationRpcTimeoutMs: 25,
  });
  const pending = new Promise((resolve) => client.once('goal-set-pending', resolve));
  const running = session.run();
  await pending;
  setTimeout(() => goalSetGate.release(), 75);

  await assert.rejects(running, /Goal state is uncertain/);
  assert.equal(client.goal.status, 'paused');
  assert.match(errorOutput.value, /Could not confirm that work began, so it was paused/);
});

test('uncertain activation is bounded when the set RPC never settles', async () => {
  const { cwd } = await createContract();
  const client = new FakeAppServer({
    goalSetGate: gate(),
    commitAfterGoalSetGate: true,
    suppressTerminal: true,
  });
  const { session } = createSession(client, cwd, {
    activationRpcTimeoutMs: 25,
  });
  const startedAt = Date.now();

  await assert.rejects(session.run(), /Goal state is uncertain/);
  assert.equal(client.goal, null);
  assert.equal(client.stopped, true);
  assert.ok(Date.now() - startedAt < 1_500);
});

test('uncertain activation never claims a safe pause without confirmation', async () => {
  const { cwd } = await createContract();
  const client = new FakeAppServer({
    failConfirmationGet: true,
    failPauseSet: true,
    suppressTerminal: true,
  });
  const { session, errorOutput } = createSession(client, cwd);

  await assert.rejects(session.run(), /could not confirm.*Goal was paused/);
  assert.equal(client.goal.status, 'active');
  assert.equal(client.stopped, true);
  assert.doesNotMatch(errorOutput.value, /paused safely/);
});

test('interrupt cancels a pending shared non-TTY reader before draining requests', async () => {
  const { cwd } = await createContract();
  const client = new FakeAppServer({ labels: ['Approve Plan'] });
  const input = new PassThrough();
  input.isTTY = false;
  const lineReader = createLineReader({ input });
  const { session } = createSession(client, cwd, {
    input,
    lineReader,
    pickOne,
  });
  const requestSeen = new Promise((resolve) => client.once('request', resolve));
  const running = session.run();
  await requestSeen;
  await session.interrupt();

  await assert.rejects(running, /interrupted/);
  assert.equal(lineReader.endReason, 'ctrl-c');
});

test('interrupt aborts an active TTY-style picker before draining requests', async () => {
  const { cwd } = await createContract();
  const client = new FakeAppServer({ labels: ['Approve Plan'] });
  let pickerStarted;
  const started = new Promise((resolve) => {
    pickerStarted = resolve;
  });
  const pickOne = ({ signal }) =>
    new Promise((resolve) => {
      pickerStarted();
      signal.addEventListener(
        'abort',
        () => resolve({ status: 'cancelled', reason: signal.reason, via: 'tty' }),
        { once: true },
      );
    });
  const { session } = createSession(client, cwd, { pickOne });
  const running = session.run();
  await started;
  await session.interrupt();

  await assert.rejects(running, /interrupted/);
});

test('planning directory symlinks are rejected before app-server starts', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-symlink-test-'));
  await mkdir(join(cwd, '.cruise'));
  await symlink(cwd, join(cwd, '.cruise', 'goal'), 'dir');
  const client = new FakeAppServer({ labels: ['Approve Plan'] });
  const { session } = createSession(client, cwd);

  await assert.rejects(session.run(), /real directory, not a symlink/);
  assert.equal(client.calls.length, 0);
});
