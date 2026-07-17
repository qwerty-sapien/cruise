import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  automaticRoutineGoalAdvance,
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
    }

    async start() {}
    async stop() {}

    async request(method, params = {}) {
      this.calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'thread-goal' } };
      if (method === 'thread/goal/get') return { goal: this.goal };
      if (method === 'thread/goal/set') {
        this.goal = { objective: params.objective, status: params.status };
        queueMicrotask(() => {
          this.emit('notification', {
            method: 'turn/started',
            params: { threadId: 'thread-goal', turn: { id: 'turn-native', status: 'inProgress' } },
          });
          queueMicrotask(() => this.emit('notification', {
            method: 'turn/completed',
            params: { threadId: 'thread-goal', turn: { id: 'turn-native', status: 'completed' } },
          }));
        });
        return { goal: this.goal };
      }
      if (method === 'turn/start') {
        this.turns += 1;
        const id = `turn-${this.turns}`;
        queueMicrotask(() => {
          if (this.turns === 2) {
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
  assert.equal(client.turns, 2);
  assert.deepEqual(
    client.calls.map(({ method }) => method),
    ['thread/start', 'turn/start', 'thread/goal/get', 'thread/goal/set', 'thread/goal/get', 'turn/start', 'thread/goal/get'],
  );
  const continuation = client.calls.filter(({ method }) => method === 'turn/start')[1].params.input;
  assert.equal(continuation.some((item) => item.type === 'skill'), false);
  assert.match(continuation[0].text, /next ready subtask/u);
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
});
