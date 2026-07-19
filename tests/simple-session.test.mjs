import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  automaticGoalAuthorization,
  automaticRoutineGoalAdvance,
  SimpleCruiseInterruptedError,
  SimpleCruiseSession,
} from '../scripts/lib/simple-session.mjs';

class FakeClient extends EventEmitter {
  async start() {}
  async stop() {}
  async request(method) {
    if (method === 'thread/start') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        this.emit('notification', { method: 'item/agentMessage/delta', params: { delta: 'done' } });
        this.emit('notification', { method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
      });
      return { turn: { id: 'turn-1' } };
    }
    throw new Error(`unexpected request ${method}`);
  }
}

test('simple sessions send one normal skill turn without control-plane instructions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-simple-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = new FakeClient();
  let output = '';
  const session = new SimpleCruiseSession({
    client,
    cwd: root,
    prompt: 'Inspect this repository.',
    skill: 'quick',
    skillPath: '/tmp/quick-skill.md',
    pickOne: async () => ({ status: 'cancelled' }),
    readLine: async () => '',
    output: { write(value) { output += value; } },
  });
  assert.deepEqual(await session.run(), { status: 'complete', skill: 'quick', threadId: 'thread-1' });
  assert.match(output, /done/u);
});

test('Goal auto-advances each completed active turn until native completion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-simple-goal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  class GoalClient extends EventEmitter {
    constructor() {
      super();
      this.calls = [];
      this.goal = null;
      this.turns = 0;
      this.nativeCompletionEmitted = false;
    }

    async start() {}
    async stop() {}

    async request(method, params = {}) {
      this.calls.push({ method, params });
      if (method === 'thread/start') {
        return { thread: { id: 'thread-goal' }, model: 'gpt-test', reasoningEffort: 'medium' };
      }
      if (method === 'thread/settings/update') return {};
      if (method === 'thread/goal/get') return { goal: this.goal };
      if (method === 'thread/goal/set') {
        this.goal = { objective: params.objective, status: params.status };
        queueMicrotask(() => {
          this.emit('notification', {
            method: 'turn/started',
            params: { threadId: 'thread-goal', turn: { id: 'turn-native', status: 'inProgress' } },
          });
          this.emit('notification', {
            method: 'turn/completed',
            params: { threadId: 'another-thread', turn: { id: 'turn-native', status: 'completed' } },
          });
          setImmediate(() => {
            this.nativeCompletionEmitted = true;
            this.emit('notification', {
              method: 'turn/completed',
              params: { threadId: 'thread-goal', turn: { id: 'turn-native', status: 'completed' } },
            });
          });
        });
        return { goal: this.goal };
      }
      if (method === 'turn/start') {
        if (!this.nativeCompletionEmitted) {
          throw new Error('the foreign completion advanced the Goal before its native Plan turn completed');
        }
        this.turns += 1;
        const id = `turn-${this.turns}`;
        queueMicrotask(() => {
          if (this.turns === 1) {
            this.goal = { ...this.goal, status: 'complete' };
            this.emit('notification', {
              method: 'thread/goal/updated',
              params: { threadId: 'thread-goal', goal: this.goal },
            });
          }
          this.emit('notification', {
            method: 'turn/completed',
            params: { threadId: 'thread-goal', turn: { id, status: 'completed' } },
          });
        });
        return { turn: { id } };
      }
      throw new Error(`unexpected request ${method}`);
    }
  }

  const client = new GoalClient();
  const session = new SimpleCruiseSession({
    client,
    cwd: root,
    prompt: 'Implement and verify the full migration.',
    skill: 'goal',
    skillPath: '/tmp/goal-skill.md',
    pickOne: async () => {
      throw new Error('routine Goal progression must not open the picker');
    },
    readLine: async () => '',
  });
  const result = await session.run();

  assert.equal(result.status, 'complete');
  assert.equal(client.turns, 1);
  assert.deepEqual(
    client.calls.map(({ method }) => method),
    ['thread/start', 'thread/settings/update', 'thread/goal/get', 'thread/goal/set', 'thread/goal/get', 'thread/settings/update', 'turn/start', 'thread/goal/get'],
  );
  const continuation = client.calls.find(({ method }) => method === 'turn/start').params.input;
  const objective = client.calls.find(({ method }) => method === 'thread/goal/set').params.objective;
  assert.match(objective, /sole read-only Plan-mode bootstrap/u);
  assert.match(objective, /implement, verify, realign, and continue/u);
  assert.equal(continuation.some((item) => item.type === 'skill'), false);
  assert.match(continuation[0].text, /next ready micro-goal/u);
  assert.match(continuation[0].text, /immediately implement/u);
  assert.match(continuation[0].text, /independent breakage probes/u);
  const [planSettings, executionSettings] = client.calls
    .filter(({ method }) => method === 'thread/settings/update')
    .map(({ params }) => params);
  assert.equal(continuation[0].type, 'text');
  assert.equal(planSettings.collaborationMode.mode, 'plan');
  assert.equal(planSettings.sandboxPolicy.type, 'readOnly');
  assert.equal(executionSettings.collaborationMode.mode, 'default');
  assert.equal(executionSettings.sandboxPolicy.type, 'workspaceWrite');
  assert.equal(client.calls.find(({ method }) => method === 'turn/start').params.collaborationMode.mode, 'default');
  assert.equal(client.calls.find(({ method }) => method === 'turn/start').params.sandboxPolicy.type, 'workspaceWrite');
});

test('interrupting an activation pauses a Goal that became active in flight', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-interrupted-goal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let releaseActivation;
  const activationGate = new Promise((resolve) => {
    releaseActivation = resolve;
  });
  class InterruptibleGoalClient extends EventEmitter {
    constructor() {
      super();
      this.calls = [];
      this.goal = null;
    }

    async start() {}
    async stop() {}

    async request(method, params = {}) {
      this.calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'thread-interrupt' } };
      if (method === 'thread/settings/update') return {};
      if (method === 'thread/goal/get') return { goal: this.goal };
      if (method === 'thread/goal/set' && params.status === 'active') {
        await activationGate;
        this.goal = { objective: params.objective, status: 'active' };
        return { goal: this.goal };
      }
      if (method === 'thread/goal/set' && params.status === 'paused') {
        this.goal = { objective: params.objective, status: 'paused' };
        return { goal: this.goal };
      }
      throw new Error(`unexpected request ${method}`);
    }
  }

  const client = new InterruptibleGoalClient();
  const session = new SimpleCruiseSession({
    client,
    cwd: root,
    prompt: 'Implement the migration.',
    skill: 'goal',
    skillPath: '/tmp/goal-skill.md',
    pickOne: async () => ({ status: 'cancelled' }),
    readLine: async () => '',
  });
  const running = session.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    client.calls.some(({ method, params }) => method === 'thread/goal/set' && params.status === 'active'),
    true,
  );
  const interrupted = session.interrupt();
  releaseActivation();
  await interrupted;
  await assert.rejects(running, (error) => error instanceof SimpleCruiseInterruptedError);
  assert.equal(client.goal.status, 'paused');
  assert.equal(
    client.calls.some(({ method, params }) => method === 'thread/goal/set' && params.status === 'paused'),
    true,
  );
});

test('a plan-only Goal completes after its native Plan turn without implementation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-plan-only-goal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  class PlanOnlyGoalClient extends EventEmitter {
    constructor() {
      super();
      this.calls = [];
      this.goal = null;
    }

    async start() {}
    async stop() {}

    async request(method, params = {}) {
      this.calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'thread-plan-only' } };
      if (method === 'thread/settings/update') return {};
      if (method === 'thread/goal/get') return { goal: this.goal };
      if (method === 'thread/goal/set') {
        this.goal = { objective: params.objective, status: params.status };
        if (params.status === 'active') {
          queueMicrotask(() => {
            this.emit('notification', {
              method: 'turn/started',
              params: { threadId: 'thread-plan-only', turn: { id: 'turn-plan', status: 'inProgress' } },
            });
            this.emit('notification', {
              method: 'turn/completed',
              params: { threadId: 'thread-plan-only', turn: { id: 'turn-plan', status: 'completed' } },
            });
          });
        }
        return { goal: this.goal };
      }
      if (method === 'turn/start') {
        throw new Error('a plan-only Goal must not start a Default-mode implementation turn');
      }
      throw new Error(`unexpected request ${method}`);
    }
  }

  const client = new PlanOnlyGoalClient();
  const session = new SimpleCruiseSession({
    client,
    cwd: root,
    prompt: 'Prepare a plan only; do not implement.',
    skill: 'goal',
    skillPath: '/tmp/goal-skill.md',
    pickOne: async () => ({ status: 'cancelled' }),
    readLine: async () => '',
  });
  const result = await session.run();

  assert.equal(result.status, 'complete');
  assert.equal(client.calls.some(({ method }) => method === 'turn/start'), false);
  assert.deepEqual(
    client.calls
      .filter(({ method }) => method === 'thread/settings/update')
      .map(({ params }) => params.collaborationMode.mode),
    ['plan'],
  );
  assert.deepEqual(
    client.calls
      .filter(({ method }) => method === 'thread/goal/set')
      .map(({ params }) => params.status),
    ['active', 'complete'],
  );
});

test('Goal automatically accepts unmistakable routine phase gates but not risky choices', () => {
  assert.deepEqual(automaticRoutineGoalAdvance({
    questions: [{
      id: 'p03',
      question: 'P-03 passed its readiness checks. What next?',
      options: [
        { label: 'Approve P-03 only', value: 'approve-p03' },
        { label: 'Stop after P-02', value: 'stop' },
      ],
    }],
  }), {
    answers: { p03: { answers: ['approve-p03'] } },
  });
  assert.equal(automaticRoutineGoalAdvance({
    questions: [{
      id: 'deploy',
      question: 'P-03 is ready to deploy to production.',
      options: [{ label: 'Approve P-03 deployment' }, { label: 'Stop' }],
    }],
  }), null);
  assert.equal(automaticRoutineGoalAdvance({
    questions: [{
      id: 'migration',
      question: 'P-04 is ready, but this migration changes the public API. What next?',
      options: [{ label: 'Implement P-04' }, { label: 'Stop' }],
    }],
  }), null);
  assert.equal(automaticRoutineGoalAdvance({
    questions: [{
      id: 'scope',
      question: 'The next micro-goal is ready. Should it add analytics tracking that was not requested?',
      options: [{ label: 'Implement the next micro-goal', value: 'implement' }, { label: 'Stop', value: 'stop' }],
    }],
  }), null);
  assert.deepEqual(automaticRoutineGoalAdvance({
    questions: [{
      id: 'next-micro-goal',
      question: 'Micro-goal is ready. What next?',
      options: [{ label: 'Implement the next micro-goal', value: 'implement' }],
    }],
  }), {
    answers: { 'next-micro-goal': { answers: ['implement'] } },
  });
});

test('Goal invocation authorizes routine Plan, Goal, and contract transitions without a copied phrase', () => {
  assert.deepEqual(automaticGoalAuthorization({
    questions: [{
      id: 'plan-goal',
      header: 'Plan and Goal',
      question: 'Approve the prepared Plan and Goal?',
      options: [
        { label: 'Approve both', value: 'approve-both' },
        { label: 'Refine', value: 'refine' },
        { label: 'Reject both', value: 'reject' },
      ],
    }],
  }), {
    answers: { 'plan-goal': { answers: ['approve-both'] } },
  });
  assert.deepEqual(automaticGoalAuthorization({
    questions: [{
      id: 'm02',
      header: 'M-02 contract',
      question: 'Approve M-02 contract digest c45dbb5e5ec427343a0d6d00f4383158793b2aa27845256eb6db8c663e5b6cb8?',
      options: [
        { label: 'Approve', value: 'approved' },
        { label: 'Revise', value: 'revise' },
      ],
    }],
  }), {
    answers: { m02: { answers: ['approved'] } },
  });
  assert.equal(automaticGoalAuthorization({
    questions: [{
      id: 'deploy',
      header: 'Plan and Goal',
      question: 'Approve the Plan and Goal for deployment to production?',
      options: [{ label: 'Approve both', value: 'approve-both' }],
    }],
  }), null);
  assert.equal(automaticGoalAuthorization({
    questions: [{
      id: 'scope',
      header: 'Plan and Goal',
      question: 'Should the next micro-goal add analytics that was not requested?',
      options: [{ label: 'Implement the next micro-goal', value: 'implement' }],
    }],
  }), null);
});

test('Goal session answers an in-scope contract gate without opening the picker', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-contract-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = new EventEmitter();
  const responses = [];
  client.respond = (id, result) => responses.push({ id, result });
  client.respondError = (id, error) => {
    throw error;
  };
  const session = new SimpleCruiseSession({
    client,
    cwd: root,
    prompt: 'Implement the migration.',
    skill: 'goal',
    skillPath: '/tmp/goal-skill.md',
    pickOne: async () => {
      throw new Error('routine contract authorization must not open the picker');
    },
    readLine: async () => {
      throw new Error('routine contract authorization must not read input');
    },
  });

  await session.handleRequest({
    id: 'contract-review',
    method: 'item/tool/requestUserInput',
    params: {
      questions: [{
        id: 'm02',
        header: 'M-02 contract',
        question: 'Approve M-02 contract digest c45dbb5e5ec427343a0d6d00f4383158793b2aa27845256eb6db8c663e5b6cb8?',
        options: [{ label: 'Approve', value: 'approved' }, { label: 'Revise', value: 'revise' }],
      }],
    },
  });

  assert.deepEqual(responses, [{
    id: 'contract-review',
    result: { answers: { m02: { answers: ['approved'] } } },
  }]);
});
