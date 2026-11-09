import { INDEPENDENT_RELEASE_INSTRUCTIONS } from '../scripts/lib/release-policy.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  automaticGoalAuthorization,
  automaticRoutineGoalAdvance,
  SimpleCruiseInterruptedError,
  SimpleCruiseSession,
} from '../scripts/lib/simple-session.mjs';
import { parseFlightPlan, flightPlanTemplate } from '../scripts/lib/flight-plan.mjs';

const TRACE_THREAD_ID = '019f855b-527e-77d1-bf9b-bca4c89da49e';

class FakeClient extends EventEmitter {
  async start() {}
  async stop() {}
  async request(method) {
    if (method === 'thread/start') return { thread: { id: TRACE_THREAD_ID } };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        this.emit('notification', {
          method: 'turn/started',
          params: { threadId: TRACE_THREAD_ID, turn: { id: 'turn-1', status: 'inProgress' } },
        });
        this.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: TRACE_THREAD_ID, delta: 'done' } });
        this.emit('notification', { method: 'turn/completed', params: { threadId: TRACE_THREAD_ID, turn: { id: 'turn-1', status: 'completed' } } });
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
  let errorOutput = '';
  let lookups = 0;
  const traceHome = join(root, 'codex-home');
  const rolloutPath = join(traceHome, `rollout-late-${TRACE_THREAD_ID}.jsonl`);
  await mkdir(traceHome, { recursive: true });
  await writeFile(rolloutPath, `${JSON.stringify({
    type: 'session_meta',
    payload: { session_id: TRACE_THREAD_ID },
  })}\n`, 'utf8');
  const session = new SimpleCruiseSession({
    client,
    cwd: root,
    prompt: 'Inspect this repository.',
    skill: 'quick',
    skillPath: '/tmp/quick-skill.md',
    pickOne: async () => ({ status: 'cancelled' }),
    readLine: async () => '',
    output: { write(value) { output += value; } },
    errorOutput: { write(value) { errorOutput += value; } },
    traceHome,
    locateTrace: async (threadId, options) => {
      assert.equal(threadId, TRACE_THREAD_ID);
      assert.equal(options.home, traceHome);
      lookups += 1;
      return lookups === 1 ? null : rolloutPath;
    },
    clock: () => new Date('2026-07-21T15:46:22.000Z'),
  });
  assert.deepEqual(await session.run(), { status: 'complete', skill: 'quick', threadId: TRACE_THREAD_ID });
  assert.equal(output, 'done');
  assert.equal(lookups, 2);
  assert.match(errorOutput, new RegExp(`thread ${TRACE_THREAD_ID} started`, 'u'));
  assert.match(errorOutput, /rollout pending/u);
  assert.match(errorOutput, new RegExp(rolloutPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  const pointer = JSON.parse(await readFile(join(root, '.cruise', 'LAST-RUN.json'), 'utf8'));
  assert.deepEqual(pointer, {
    thread_id: TRACE_THREAD_ID,
    rollout_path: rolloutPath,
    cwd: root,
    skill: 'quick',
    started_at: '2026-07-21T15:46:22.000Z',
    ended_at: '2026-07-21T15:46:22.000Z',
    final_status: 'complete',
  });
  const first = JSON.parse((await readFile(pointer.rollout_path, 'utf8')).split('\n')[0]);
  assert.equal(first.payload.session_id, pointer.thread_id);
  assert.match(await readFile(join(root, '.cruise', '.gitignore'), 'utf8'), /^LAST-RUN\.json$/mu);
});

test('Goal auto-advances each completed active turn until native completion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-simple-goal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.cruise'));
  await writeFile(join(root, '.cruise', '.supervisor.json'), '{"stale":true}\n', 'utf8');
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
        return { thread: { id: 'thread-goal' }, model: 'gpt-5.6-sol', reasoningEffort: 'high' };
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
  const scratch = JSON.parse(await readFile(join(root, '.cruise', '.supervisor.json'), 'utf8'));
  assert.equal(scratch.host, 'codex');
  assert.equal(scratch.turns_observed, 0);
  assert.equal(Object.hasOwn(scratch, 'final_report'), false);
  assert.deepEqual(
    client.calls.map(({ method }) => method),
    ['thread/start', 'thread/settings/update', 'thread/goal/get', 'thread/goal/set', 'thread/goal/get', 'thread/settings/update', 'turn/start', 'thread/goal/get'],
  );
  const continuation = client.calls.find(({ method }) => method === 'turn/start').params.input;
  const objective = client.calls.find(({ method }) => method === 'thread/goal/set').params.objective;
  const developerInstructions = client.calls.find(({ method }) => method === 'thread/start').params.developerInstructions;
  assert.ok(developerInstructions.includes(INDEPENDENT_RELEASE_INSTRUCTIONS));
  assert.match(developerInstructions, /Goal work may also maintain.*\.cruise\/FLIGHT\.md/u);
  assert.match(developerInstructions, /seeking-alpha only for an explicit novelty/u);
  assert.match(objective, /sole read-only Plan-mode bootstrap/u);
  assert.match(objective, /\.cruise\/FLIGHT\.md/u);
  assert.match(objective, /implement, verify, realign, and continue/u);
  assert.equal(continuation.some((item) => item.type === 'skill'), false);
  assert.match(continuation[0].text, /next ready micro-goal/u);
  assert.match(continuation[0].text, /immediately implement/iu);
  assert.match(continuation[0].text, /independent breakage probes/u);
  assert.match(continuation[0].text, /compact handoff, next work item, quota state, and unresolved assurance/u);
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

test('Goal bootstrap deadline reports diagnostics and pauses a Goal that never starts a turn', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-goal-bootstrap-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  class NoTurnGoalClient extends EventEmitter {
    constructor() {
      super();
      this.calls = [];
      this.goal = null;
      this.stopped = false;
    }

    async start() {}
    async stop() { this.stopped = true; }

    async request(method, params = {}) {
      this.calls.push({ method, params });
      if (method === 'thread/start') {
        return { thread: { id: 'thread-no-turn' }, model: 'gpt-5.6-sol', reasoningEffort: 'high' };
      }
      if (method === 'thread/settings/update') return {};
      if (method === 'thread/goal/get') return { goal: this.goal };
      if (method === 'thread/goal/set') {
        this.goal = { objective: params.objective, status: params.status };
        return { goal: this.goal };
      }
      throw new Error(`unexpected request ${method}`);
    }
  }

  const client = new NoTurnGoalClient();
  let output = '';
  let errorOutput = '';
  const session = new SimpleCruiseSession({
    client,
    cwd: root,
    prompt: 'Finish the migration.',
    skill: 'goal',
    skillPath: '/tmp/goal-skill.md',
    pickOne: async () => ({ status: 'cancelled' }),
    readLine: async () => '',
    output: { write(value) { output += value; } },
    errorOutput: { write(value) { errorOutput += value; } },
    traceHome: join(root, 'codex-home'),
    locateTrace: async () => null,
    firstTurnDeadlineMs: 20,
  });

  const runOutcome = session.run().then(
    (value) => ({ kind: 'resolved', value }),
    (error) => ({ kind: 'rejected', error }),
  );
  let watchdog;
  const outcome = await Promise.race([
    runOutcome,
    new Promise((resolve) => {
      watchdog = setTimeout(() => resolve({
        kind: 'still-pending',
        output,
        errorOutput,
      }), 100);
    }),
  ]);
  clearTimeout(watchdog);
  assert.notEqual(
    outcome.kind,
    'still-pending',
    `launcher remained pending after its deadline window: ${JSON.stringify(outcome)}`,
  );
  assert.equal(outcome.kind, 'rejected');
  const { error } = outcome;
  {
    assert.equal(error.name, 'CruiseGoalBootstrapTimeoutError');
    assert.equal(error.code, 'CRUISE_GOAL_BOOTSTRAP_TIMEOUT');
    assert.equal(error.threadId, 'thread-no-turn');
    assert.equal(error.model, 'gpt-5.6-sol');
    assert.equal(error.goalStatus, 'active');
    assert.ok(error.elapsedMs >= 20);
    assert.match(error.message, /never started the native Goal turn within 20ms/u);
    assert.match(error.message, /thread=thread-no-turn/u);
    assert.match(error.message, /model=gpt-5\.6-sol/u);
    assert.match(error.message, /goal=active/u);
  }

  assert.equal(output, '');
  assert.equal(errorOutput, [
    'Cruise: app-server started.',
    'Cruise: thread thread-no-turn started (model gpt-5.6-sol).',
    `Cruise: rollout pending; sessions: ${join(root, 'codex-home', 'sessions')}; resume: codex resume thread-no-turn.`,
    'Cruise: goal activated.',
    'Cruise: waiting for the native Goal turn.',
    `Cruise: trace unresolved for thread thread-no-turn; sessions: ${join(root, 'codex-home', 'sessions')}; resume: codex resume thread-no-turn.`,
    '',
  ].join('\n'));
  assert.deepEqual(client.calls
    .filter(({ method }) => method === 'thread/goal/set')
    .map(({ params }) => params.status), ['active', 'paused']);
  assert.equal(client.stopped, true);
  const timeoutPointer = JSON.parse(await readFile(join(root, '.cruise', 'LAST-RUN.json'), 'utf8'));
  assert.equal(timeoutPointer.thread_id, 'thread-no-turn');
  assert.equal(timeoutPointer.rollout_path, null);
  assert.equal(timeoutPointer.final_status, 'bootstrap-timeout');
  assert.equal(typeof timeoutPointer.ended_at, 'string');
});

test('Goal bootstrap timeout cannot hang in diagnostic cleanup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-goal-bootstrap-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  class HungDiagnosticsGoalClient extends EventEmitter {
    constructor() {
      super();
      this.goal = null;
      this.goalReads = 0;
      this.statuses = [];
    }

    async start() {}
    async stop() {}

    async request(method, params = {}) {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-hung-diagnostics' }, model: 'gpt-5.6-sol', reasoningEffort: 'high' };
      }
      if (method === 'thread/settings/update') return {};
      if (method === 'thread/goal/get') {
        this.goalReads += 1;
        if (this.goalReads === 1) return { goal: null };
        return new Promise(() => {});
      }
      if (method === 'thread/goal/set') {
        this.statuses.push(params.status);
        this.goal = { objective: params.objective, status: params.status };
        return { goal: this.goal };
      }
      throw new Error(`unexpected request ${method}`);
    }
  }

  const client = new HungDiagnosticsGoalClient();
  const startedAt = Date.now();
  await assert.rejects(new SimpleCruiseSession({
    client,
    cwd: root,
    prompt: 'Finish the migration.',
    skill: 'goal',
    skillPath: '/tmp/goal-skill.md',
    pickOne: async () => ({ status: 'cancelled' }),
    readLine: async () => '',
    output: { write() {} },
    errorOutput: { write() {} },
    firstTurnDeadlineMs: 10,
    firstTurnCleanupDeadlineMs: 20,
  }).run(), (error) => {
    assert.equal(error.code, 'CRUISE_GOAL_BOOTSTRAP_TIMEOUT');
    assert.match(error.message, /goal-read-error=.*did not settle within 20ms/u);
    return true;
  });
  assert.ok(Date.now() - startedAt < 100);
  assert.deepEqual(client.statuses, ['active', 'paused']);
});

test('interrupt cancels a hung bootstrap diagnostic without leaking its cleanup timer', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-goal-bootstrap-interrupt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  class InterruptCleanupGoalClient extends EventEmitter {
    constructor() {
      super();
      this.goal = null;
      this.goalReads = 0;
      this.statuses = [];
    }

    async start() {}
    async stop() {}

    async request(method, params = {}) {
      if (method === 'thread/start') return { thread: { id: 'thread-cleanup-interrupt' } };
      if (method === 'thread/settings/update') return {};
      if (method === 'thread/goal/get') {
        this.goalReads += 1;
        if (this.goalReads === 1) return { goal: null };
        this.emit('diagnostics-started');
        return new Promise(() => {});
      }
      if (method === 'thread/goal/set') {
        this.statuses.push(params.status);
        this.goal = { objective: params.objective, status: params.status };
        return { goal: this.goal };
      }
      throw new Error(`unexpected request ${method}`);
    }
  }

  const client = new InterruptCleanupGoalClient();
  const diagnosticsStarted = new Promise((resolve) => client.once('diagnostics-started', resolve));
  const session = new SimpleCruiseSession({
    client,
    cwd: root,
    prompt: 'Finish the migration.',
    skill: 'goal',
    skillPath: '/tmp/goal-skill.md',
    pickOne: async () => ({ status: 'cancelled' }),
    readLine: async () => '',
    output: { write() {} },
    errorOutput: { write() {} },
    firstTurnDeadlineMs: 10,
    firstTurnCleanupDeadlineMs: 1_000,
  });
  const running = session.run();
  await diagnosticsStarted;
  const interruptedAt = Date.now();
  await session.interrupt();
  await assert.rejects(running, (error) => error instanceof SimpleCruiseInterruptedError);
  assert.ok(Date.now() - interruptedAt < 100);
  assert.deepEqual(client.statuses, ['active', 'paused']);
});

test('app-server exit cancels a hung bootstrap diagnostic cleanup timer', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-goal-bootstrap-exit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  class ExitCleanupGoalClient extends EventEmitter {
    constructor() {
      super();
      this.goal = null;
      this.goalReads = 0;
    }

    async start() {}
    async stop() {}

    async request(method, params = {}) {
      if (method === 'thread/start') return { thread: { id: 'thread-cleanup-exit' } };
      if (method === 'thread/settings/update') return {};
      if (method === 'thread/goal/get') {
        this.goalReads += 1;
        if (this.goalReads === 1) return { goal: null };
        this.emit('diagnostics-started');
        return new Promise(() => {});
      }
      if (method === 'thread/goal/set') {
        this.goal = { objective: params.objective, status: params.status };
        return { goal: this.goal };
      }
      throw new Error(`unexpected request ${method}`);
    }
  }

  const client = new ExitCleanupGoalClient();
  const diagnosticsStarted = new Promise((resolve) => client.once('diagnostics-started', resolve));
  const running = new SimpleCruiseSession({
    client,
    cwd: root,
    prompt: 'Finish the migration.',
    skill: 'goal',
    skillPath: '/tmp/goal-skill.md',
    pickOne: async () => ({ status: 'cancelled' }),
    readLine: async () => '',
    output: { write() {} },
    errorOutput: { write() {} },
    firstTurnDeadlineMs: 10,
    firstTurnCleanupDeadlineMs: 1_000,
  }).run();
  await diagnosticsStarted;
  const exitedAt = Date.now();
  client.emit('exit', { code: 9 });
  await assert.rejects(running, /Codex app-server exited \(9\)/u);
  assert.ok(Date.now() - exitedAt < 100);
});

test('a native Goal turn just before the deadline cancels the timer without changing stdout', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-goal-bootstrap-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  class JustInTimeGoalClient extends EventEmitter {
    constructor() {
      super();
      this.goal = null;
    }

    async start() {}
    async stop() {}

    async request(method, params = {}) {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-just-in-time' }, model: 'gpt-5.6-sol', reasoningEffort: 'high' };
      }
      if (method === 'thread/settings/update') return {};
      if (method === 'thread/goal/get') return { goal: this.goal };
      if (method === 'thread/goal/set') {
        this.goal = { objective: params.objective, status: params.status };
        setTimeout(() => {
          this.emit('notification', {
            method: 'turn/started',
            params: {
              threadId: 'thread-just-in-time',
              turn: { id: 'native-plan', status: 'inProgress' },
            },
          });
          this.emit('notification', {
            method: 'item/agentMessage/delta',
            params: { threadId: 'thread-just-in-time', delta: 'healthy transcript\n' },
          });
          this.goal = { ...this.goal, status: 'complete' };
          this.emit('notification', {
            method: 'turn/completed',
            params: {
              threadId: 'thread-just-in-time',
              turn: { id: 'native-plan', status: 'completed' },
            },
          });
        }, 30);
        return { goal: this.goal };
      }
      throw new Error(`unexpected request ${method}`);
    }
  }

  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.removeListener('unhandledRejection', onUnhandled));
  let output = '';
  let errorOutput = '';
  const result = await new SimpleCruiseSession({
    client: new JustInTimeGoalClient(),
    cwd: root,
    prompt: 'Finish the migration.',
    skill: 'goal',
    skillPath: '/tmp/goal-skill.md',
    pickOne: async () => ({ status: 'cancelled' }),
    readLine: async () => '',
    output: { write(value) { output += value; } },
    errorOutput: { write(value) { errorOutput += value; } },
    traceHome: join(root, 'codex-home'),
    locateTrace: async () => null,
    firstTurnDeadlineMs: 50,
  }).run();
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(result.status, 'complete');
  assert.equal(output, 'healthy transcript\n');
  assert.equal(errorOutput, [
    'Cruise: app-server started.',
    'Cruise: thread thread-just-in-time started (model gpt-5.6-sol).',
    `Cruise: rollout pending; sessions: ${join(root, 'codex-home', 'sessions')}; resume: codex resume thread-just-in-time.`,
    'Cruise: goal activated.',
    'Cruise: waiting for the native Goal turn.',
    `Cruise: trace unresolved for thread thread-just-in-time; sessions: ${join(root, 'codex-home', 'sessions')}; resume: codex resume thread-just-in-time.`,
    '',
  ].join('\n'));
  assert.deepEqual(unhandled, []);
});

test('Goal supervision realigns, runs one final experiment, then pauses with a report', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-stalled-goal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  class StalledGoalClient extends EventEmitter {
    constructor({ pauseFails = false } = {}) {
      super();
      this.calls = [];
      this.goal = null;
      this.turns = 0;
      this.pauseFails = pauseFails;
    }

    async start() {}
    async stop() {}

    async request(method, params = {}) {
      this.calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'thread-stalled' } };
      if (method === 'thread/settings/update') return {};
      if (method === 'thread/goal/get') return { goal: this.goal };
      if (method === 'thread/goal/set') {
        if (params.status === 'paused' && this.pauseFails) throw new Error('pause transport unavailable');
        this.goal = { objective: params.objective, status: params.status };
        if (params.status === 'active') {
          queueMicrotask(() => {
            this.emit('notification', {
              method: 'turn/started',
              params: { threadId: 'thread-stalled', turn: { id: 'native-plan', status: 'inProgress' } },
            });
            this.emit('notification', {
              method: 'turn/completed',
              params: { threadId: 'thread-stalled', turn: { id: 'native-plan', status: 'completed' } },
            });
          });
        }
        return { goal: this.goal };
      }
      if (method === 'turn/start') {
        this.turns += 1;
        const id = `stalled-turn-${this.turns}`;
        queueMicrotask(() => {
          this.emit('notification', {
            method: 'item/agentMessage/delta',
            params: { threadId: 'thread-stalled', delta: 'Still investigating without new evidence.\n' },
          });
          this.emit('notification', {
            method: 'turn/completed',
            params: { threadId: 'thread-stalled', turn: { id, status: 'completed' } },
          });
        });
        return { turn: { id } };
      }
      throw new Error(`unexpected request ${method}`);
    }
  }

  const client = new StalledGoalClient();
  let report = '';
  const session = new SimpleCruiseSession({
    client,
    cwd: root,
    prompt: 'Complete the work without looping.',
    skill: 'goal',
    skillPath: '/tmp/goal-skill.md',
    pickOne: async () => ({ status: 'cancelled' }),
    readLine: async () => '',
    output: { write() {} },
    errorOutput: { write(value) { report += value; } },
    captureFingerprint: async () => 'fixed-fingerprint',
    readPlan: async () => ({ stall: { quietTurns: 1, sameFailure: 9 } }),
  });
  const result = await session.run();

  assert.equal(result.status, 'stalled');
  assert.equal(result.goal.status, 'paused');
  const instructions = client.calls
    .filter(({ method }) => method === 'turn/start')
    .map(({ params }) => params.input[0].text);
  assert.equal(instructions.length, 4);
  assert.match(instructions[2], /Repeating the same approach is not authorized progress/u);
  assert.match(instructions[2], /workspace fingerprint fixed-finger was unchanged/u);
  assert.match(instructions[3], /last supervised continuation/u);
  assert.deepEqual(client.calls
    .filter(({ method }) => method === 'thread/goal/set')
    .map(({ params }) => params.status), ['active', 'paused']);
  assert.match(report, /stalled after 4 supervised continuation turns/u);
  assert.match(report, /Interventions already attempted/u);
  assert.match(report, /native Goal is paused/u);
  assert.match(report, /Suggested next actions/u);

  const persisted = JSON.parse(await readFile(join(root, '.cruise', '.supervisor.json'), 'utf8'));
  assert.equal(persisted.host, 'codex');
  assert.equal(persisted.ladder, 'stalled');
  assert.deepEqual(persisted.interventions.map(({ level }) => level), [
    'realign',
    'final-experiment',
  ]);
  assert.match(persisted.final_report, /stalled after 4 supervised continuation turns/u);
  assert.deepEqual(persisted.pause_outcome, { status: 'paused' });
  const stalledPointer = JSON.parse(await readFile(join(root, '.cruise', 'LAST-RUN.json'), 'utf8'));
  assert.equal(stalledPointer.final_status, 'stalled');
  assert.equal(stalledPointer.thread_id, 'thread-stalled');

  const pauseFailureClient = new StalledGoalClient({ pauseFails: true });
  let pauseFailureReport = '';
  const pauseFailureResult = await new SimpleCruiseSession({
    client: pauseFailureClient,
    cwd: root,
    prompt: 'Complete the work without looping.',
    skill: 'goal',
    skillPath: '/tmp/goal-skill.md',
    pickOne: async () => ({ status: 'cancelled' }),
    readLine: async () => '',
    output: { write() {} },
    errorOutput: { write(value) { pauseFailureReport += value; } },
    captureFingerprint: async () => 'fixed-fingerprint',
    readPlan: async () => ({ stall: { quietTurns: 1, sameFailure: 9 } }),
  }).run();
  assert.equal(pauseFailureResult.status, 'stalled');
  assert.equal(pauseFailureResult.goal.status, 'active');
  assert.match(pauseFailureReport, /pause could not be confirmed: pause transport unavailable/u);
  assert.match(pauseFailureReport, /Suggested next actions/u);
  const pauseFailureState = JSON.parse(await readFile(
    join(root, '.cruise', '.supervisor.json'),
    'utf8',
  ));
  assert.deepEqual(pauseFailureState.pause_outcome, {
    status: 'pause-failed',
    reason: 'pause transport unavailable',
  });
  assert.equal(
    pauseFailureState.final_report,
    pauseFailureReport
      .slice(pauseFailureReport.indexOf('Cruise Goal stalled'))
      .split('\nCruise: trace')[0]
      .trim(),
  );
});

test('invalid flight state gets one corrective Codex turn without resetting supervision', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-invalid-flight-goal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.cruise'));
  const pilot = 'status: active\nstall:\n  quiet_turns: 3\n  same_failure: 3\n';
  await writeFile(join(root, '.cruise', 'FLIGHT.md'), pilot, 'utf8');

  class InvalidFlightGoalClient extends EventEmitter {
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
      if (method === 'thread/start') return { thread: { id: 'thread-invalid-flight' } };
      if (method === 'thread/settings/update') return {};
      if (method === 'thread/goal/get') return { goal: this.goal };
      if (method === 'thread/goal/set') {
        this.goal = { objective: params.objective, status: params.status };
        if (params.status === 'active') queueMicrotask(() => {
          this.emit('notification', {
            method: 'turn/started',
            params: { threadId: 'thread-invalid-flight', turn: { id: 'native-plan' } },
          });
          this.emit('notification', {
            method: 'turn/completed',
            params: { threadId: 'thread-invalid-flight', turn: { id: 'native-plan', status: 'completed' } },
          });
        });
        return { goal: this.goal };
      }
      if (method === 'turn/start') {
        this.turns += 1;
        const id = `continuation-${this.turns}`;
        queueMicrotask(() => {
          this.emit('notification', {
            method: 'turn/completed',
            params: { threadId: 'thread-invalid-flight', turn: { id, status: 'completed' } },
          });
        });
        return { turn: { id } };
      }
      throw new Error(`unexpected request ${method}`);
    }
  }

  const client = new InvalidFlightGoalClient();
  let stderr = '';
  const fingerprintOptions = [];
  const result = await new SimpleCruiseSession({
    client,
    cwd: root,
    prompt: 'Complete the work.',
    skill: 'goal',
    skillPath: '/tmp/goal-skill.md',
    pickOne: async () => ({ status: 'cancelled' }),
    readLine: async () => '',
    output: { write() {} },
    errorOutput: { write(value) { stderr += value; } },
    captureFingerprint: async (_cwd, options) => {
      fingerprintOptions.push(options);
      return 'fixed-fingerprint';
    },
  }).run();

  assert.equal(result.status, 'stalled');
  const instructions = client.calls
    .filter(({ method }) => method === 'turn/start')
    .map(({ params }) => params.input[0].text);
  assert.equal(instructions.length, 6);
  assert.match(instructions[1], /supervision is degraded/iu);
  assert.match(instructions[1], /missing opening.*frontmatter fence/iu);
  assert.match(instructions[1], /quiet_turns: 3/u);
  assert.match(instructions[2], /Continue the active Cruise Goal/u);
  assert.match(instructions[4], /Repeating the same approach/u);
  assert.match(instructions[5], /last supervised continuation/u);
  assert.equal((stderr.match(/supervision degraded/gu) ?? []).length, 6);
  assert.equal(fingerprintOptions.every(({ excludeFlightPlan }) => excludeFlightPlan), true);
  assert.match(stderr, /stalled after 6 supervised continuation turns/u);
  const state = JSON.parse(await readFile(join(root, '.cruise', '.supervisor.json'), 'utf8'));
  assert.deepEqual(state.interventions.map(({ level }) => level), [
    'corrective',
    'realign',
    'final-experiment',
  ]);
  assert.equal(state.observations[0].verdict_level, 'corrective');
  assert.equal(state.observations[1].verdict_level, 'ok');
  assert.equal(state.observations.at(-1).verdict_level, 'stall');
  assert.match(state.final_report, /stalled after 6 supervised continuation turns/u);
});

test('a progressing Codex turn leaves a zero-intervention supervisor trail', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-progress-trail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = new SimpleCruiseSession({
    client: new EventEmitter(),
    cwd: root,
    prompt: 'Keep progressing.',
    skill: 'goal',
    skillPath: '/tmp/goal-skill.md',
    pickOne: async () => ({ status: 'cancelled' }),
    readLine: async () => '',
    captureFingerprint: async () => 'progress-fingerprint',
    readPlan: async () => ({
      state: 'valid',
      contentHash: 'valid-flight-hash',
      plan: { stall: { quietTurns: 3, sameFailure: 3 } },
    }),
  });

  assert.equal((await session.superviseGoalTurn('turn-progress')).level, 'ok');
  const state = JSON.parse(await readFile(join(root, '.cruise', '.supervisor.json'), 'utf8'));
  assert.equal(state.host, 'codex');
  assert.equal(state.turns_observed, 1);
  assert.deepEqual(state.interventions, []);
  assert.equal(state.observations[0].turn_id, 'turn-progress');
  assert.equal(state.observations[0].verdict_level, 'ok');
});

test('a repaired Codex flight keeps its correction in the active ladder', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-repaired-flight-trail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inspections = [
    { state: 'invalid', contentHash: 'bad-flight', reason: 'missing opening fence' },
    {
      state: 'valid',
      contentHash: 'good-flight',
      plan: { stall: { quietTurns: 1, sameFailure: 9 } },
    },
  ];
  const fingerprintOptions = [];
  const session = new SimpleCruiseSession({
    client: new EventEmitter(),
    cwd: root,
    prompt: 'Keep progressing.',
    skill: 'goal',
    skillPath: '/tmp/goal-skill.md',
    pickOne: async () => ({ status: 'cancelled' }),
    readLine: async () => '',
    captureFingerprint: async (_cwd, options) => {
      fingerprintOptions.push(options);
      return 'unchanged-product-work';
    },
    readPlan: async () => inspections.shift(),
  });

  assert.equal((await session.superviseGoalTurn('repair-turn')).level, 'corrective');
  assert.equal((await session.superviseGoalTurn('valid-turn')).level, 'realign');
  assert.equal(fingerprintOptions.every(({ excludeFlightPlan }) => excludeFlightPlan), true);
  const state = JSON.parse(await readFile(join(root, '.cruise', '.supervisor.json'), 'utf8'));
  assert.deepEqual(state.interventions.map(({ level }) => level), ['corrective', 'realign']);
});

test('interrupting an activation pauses a Goal that became active in flight', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-interrupted-goal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let releaseActivation;
  const activationGate = new Promise((resolve) => {
    releaseActivation = resolve;
  });
  let signalActivationRequested;
  const activationRequested = new Promise((resolve) => {
    signalActivationRequested = resolve;
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
        signalActivationRequested();
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
  await activationRequested;
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

test('Codex completion assessment rejects stale gates and accepts fresh Flight v2 receipts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-goal-assurance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.cruise'));
  await writeFile(join(root, '.cruise', 'ORIGIN.md'), 'Implement and verify it.', 'utf8');
  const plan = parseFlightPlan(flightPlanTemplate());
  plan.status = 'complete';
  const session = new SimpleCruiseSession({
    client: {},
    cwd: root,
    prompt: 'Implement and verify it.',
    skill: 'goal',
    skillPath: '/tmp/goal-skill.md',
    pickOne: async () => ({ status: 'cancelled' }),
    readLine: async () => '',
    requireAssurance: true,
    captureFingerprint: async () => 'a'.repeat(64),
    readPlan: async () => ({ state: 'valid', plan, contentHash: 'flight-v2' }),
    output: { write() {} },
    errorOutput: { write() {} },
  });
  const incomplete = await session.assessCompletion();
  assert.equal(incomplete.allowsCompletion, false);
  assert.equal(incomplete.level, 'incomplete');
  for (const gate of plan.quality.gates) {
    gate.state = 'passed';
    gate.evidence = {
      summary: `${gate.id} passed`,
      contextFingerprint: incomplete.gateFingerprints[gate.id],
      observedAt: 1,
      source: gate.dimension === 'completion-review' ? 'review' : 'command',
      rationale: '',
      waivedBy: '',
    };
  }
  const assured = await session.assessCompletion();
  assert.equal(assured.level, 'assured');
  assert.equal(assured.allowsCompletion, true);
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
