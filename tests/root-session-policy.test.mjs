import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { writeRootHandoff } from '../scripts/lib/context-capsule.mjs';
import { SimpleCruiseSession } from '../scripts/lib/simple-session.mjs';

test('Goal requests and persists a non-default root effort before compact continuation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-root-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.cruise'));
  await writeRootHandoff(root, {
    outcome: 'Ship the bounded router.',
    completed_work: ['Discovery complete.'],
    changed_files: ['scripts/lib/worker-policy.mjs'],
    decisions_and_invariants: ['Root stays Sol high.'],
    exact_tests: ['node --test tests/context-router.test.mjs'],
    active_blocker_or_next_work_item: 'Implement the router.',
    files_not_to_reread: ['package.json'],
    evidence_pointers: ['.cruise/artifacts/discovery.log'],
    usage_and_quota_summary: 'Quota reservation remains available.',
  });

  class GoalClient extends EventEmitter {
    constructor() {
      super();
      this.calls = [];
      this.goal = null;
    }

    async start() {}
    async stop() {}

    async request(method, params = {}) {
      this.calls.push({ method, params });
      if (method === 'thread/start') {
        return { thread: { id: 'root-thread' }, model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' };
      }
      if (method === 'thread/settings/update') return {};
      if (method === 'thread/goal/get') return { goal: this.goal };
      if (method === 'thread/goal/set') {
        this.goal = { objective: params.objective, status: params.status };
        queueMicrotask(() => {
          this.emit('notification', {
            method: 'turn/started',
            params: { threadId: 'root-thread', turn: { id: 'native-turn', status: 'inProgress' } },
          });
          this.emit('notification', {
            method: 'turn/completed',
            params: { threadId: 'root-thread', turn: { id: 'native-turn', status: 'completed' } },
          });
        });
        return { goal: this.goal };
      }
      if (method === 'turn/start') {
        this.goal = { ...this.goal, status: 'complete' };
        queueMicrotask(() => this.emit('notification', {
          method: 'turn/completed',
          params: { threadId: 'root-thread', turn: { id: 'execution-turn', status: 'completed' } },
        }));
        return { turn: { id: 'execution-turn' } };
      }
      throw new Error(`unexpected request ${method}`);
    }
  }

  const client = new GoalClient();
  const session = new SimpleCruiseSession({
    client,
    cwd: root,
    prompt: 'Implement the bounded router.',
    skill: 'goal',
    skillPath: '/tmp/goal/SKILL.md',
    pickOne: async () => ({ status: 'cancelled' }),
    readLine: async () => '',
    locateTrace: async () => null,
    traceHome: join(root, 'codex-home'),
    continuationContextReader: async () => [
      'Resume from compact handoff.',
      'Outcome: Ship the bounded router.',
      'Changed paths: scripts/lib/worker-policy.mjs',
    ].join('\n'),
    rootOverride: { model: 'gpt-5.6-sol', reasoning_effort: 'xhigh' },
  });
  const result = await session.run();
  assert.equal(result.status, 'complete');

  const started = client.calls.find(({ method }) => method === 'thread/start').params;
  assert.equal(started.model, 'gpt-5.6-sol');
  assert.equal(started.allowProviderModelFallback, false);
  assert.deepEqual(started.config, { model_reasoning_effort: 'xhigh' });
  assert.match(started.developerInstructions, /coordinator, integrator, and final reviewer/u);
  assert.match(started.developerInstructions, /cruise worker --managed/u);
  assert.match(started.developerInstructions, /git log HEAD\.\.<incoming-ref>/u);
  assert.match(started.developerInstructions, /git diff HEAD\.\.\.<incoming-ref>/u);
  assert.match(started.developerInstructions, /fast-forward-only/u);

  const settings = client.calls
    .filter(({ method }) => method === 'thread/settings/update')
    .map(({ params }) => params.collaborationMode.settings);
  for (const value of settings) {
    assert.equal(value.model, 'gpt-5.6-sol');
    assert.equal(value.reasoning_effort, 'xhigh');
    assert.match(value.developer_instructions, /git log HEAD\.\.<incoming-ref>/u);
  }
  const continuation = client.calls.find(({ method }) => method === 'turn/start').params.input[0].text;
  assert.match(continuation, /Resume from compact handoff/u);
  assert.match(continuation, /scripts\/lib\/worker-policy\.mjs/u);

  const pointer = JSON.parse(await readFile(join(root, '.cruise', 'LAST-RUN.json'), 'utf8'));
  assert.equal(pointer.root_policy.requested_model, 'gpt-5.6-sol');
  assert.equal(pointer.root_policy.requested_reasoning_effort, 'xhigh');
  assert.equal(pointer.root_policy.resolved_model, 'gpt-5.6-sol');
  assert.equal(pointer.root_policy.resolved_reasoning_effort, 'xhigh');
});

test('Goal fails closed when the host reports a weaker root resolution', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-root-degraded-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  class DegradedClient extends EventEmitter {
    async start() {}
    async stop() {}
    async request(method) {
      if (method === 'thread/start') {
        return { thread: { id: 'degraded-root' }, model: 'gpt-5.6-terra', reasoningEffort: 'xhigh' };
      }
      throw new Error(`unexpected request ${method}`);
    }
  }
  const session = new SimpleCruiseSession({
    client: new DegradedClient(),
    cwd: root,
    prompt: 'Coordinate one Goal.',
    skill: 'goal',
    skillPath: '/tmp/goal/SKILL.md',
    pickOne: async () => ({ status: 'cancelled' }),
    readLine: async () => '',
    locateTrace: async () => null,
    traceHome: join(root, 'codex-home'),
  });
  await assert.rejects(session.run(), (error) => {
    assert.equal(error.code, 'CRUISE_ROOT_POLICY_UNAVAILABLE');
    assert.match(error.message, /required gpt-5\.6-sol\/high/u);
    return true;
  });
  const pointer = JSON.parse(await readFile(join(root, '.cruise', 'LAST-RUN.json'), 'utf8'));
  assert.equal(pointer.root_policy.resolved_model, 'gpt-5.6-terra');
  assert.equal(pointer.root_policy.resolved_reasoning_effort, 'xhigh');
});
