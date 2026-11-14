import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AppServerClient, AppServerRpcError } from '../scripts/lib/app-server-client.mjs';
import { createNativeAuthNormalizer } from '../scripts/lib/auth-recovery-runtime.mjs';
import { SimpleCruiseSession, resolveFirstTurnDeadlineMs } from '../scripts/lib/simple-session.mjs';
import { parseArgs, runStart } from '../scripts/cruise.mjs';
import { ManagedWorkerDispatcher } from '../scripts/lib/worker-dispatcher.mjs';

class GoalClient extends EventEmitter {
  constructor({ automatic = true, early = false, startBehavior = null } = {}) {
    super();
    this.calls = [];
    this.automatic = automatic;
    this.early = early;
    this.goal = null;
    this.suspensions = 0;
    this.history = [];
    this.threadStatus = 'idle';
    this.startBehavior = startBehavior;
  }
  async start() {}
  async stop() { this.stopped = true; }
  pauseInactivityWatchdog() { this.suspensions++; }
  resumeInactivityWatchdog() { this.suspensions--; }
  interrupt() {}
  async request(method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'account/rateLimits/read') return { rateLimits: {
      secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 2000000000 },
    } };
    if (method === 'thread/start') return { thread: { id: 'ready-thread' }, model: 'gpt-5.6-sol', reasoningEffort: 'high' };
    if (method === 'thread/settings/update') return {};
    if (method === 'thread/read') return { thread: { status: { type: this.threadStatus, activeFlags: [] } } };
    if (method === 'thread/turns/list') return { data: this.history };
    if (method === 'turn/start') {
      if (this.startBehavior) return this.startBehavior(params);
      queueMicrotask(() => this.finish());
      return { turn: { id: 'native-turn', status: 'inProgress' } };
    }
    if (method === 'thread/goal/get') return { goal: this.goal };
    if (method === 'thread/goal/set') {
      this.goal = { objective: params.objective, status: params.status };
      const responseGoal = this.goal;
      if (params.status === 'active' && this.automatic) {
        if (this.early) this.finish();
        else queueMicrotask(() => this.finish());
      }
      return { goal: responseGoal };
    }
    throw new Error(`Unexpected RPC ${method}`);
  }
  finish() {
    this.emit('notification', { method: 'turn/started', params: { threadId: 'ready-thread', turn: { id: 'native-turn' } } });
    this.goal = { ...this.goal, status: 'complete' };
    this.history = [{ id: 'native-turn', status: 'completed' }];
    this.emit('notification', { method: 'turn/completed', params: { threadId: 'ready-thread', turn: { id: 'native-turn', status: 'completed' } } });
  }
}

async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay(5);
  }
  throw new Error('Mock transcript did not reach expected state');
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cruise-resilience-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = overrides.client ?? new GoalClient();
  let diagnostics = '';
  const session = new SimpleCruiseSession({
    client, cwd: root, prompt: 'Research only: inspect the current task.', skill: 'goal',
    skillPath: '/tmp/goal-skill.md', locateTrace: async () => null, traceHome: root,
    pickOne: async () => { throw new Error('Unexpected user input'); }, readLine: async () => '',
    output: { write() {} }, errorOutput: { write(s) { diagnostics += s; } },
    ...overrides,
  });
  return { root, client, session, diagnostics: () => diagnostics };
}

test('auth pause before staged activation leaves parent lease and quota ownership untouched', async (t) => {
  const client = new GoalClient();
  const handoff = { kind: 'login', action: { command: 'codex', args: ['login'] } };
  client.request = async method => {
    assert.equal(method, 'account/rateLimits/read');
    throw new AppServerRpcError({ code: -32603, message: 'body: {"error":{"code":"token_revoked"}}' }, { method });
  };
  let recoveries = 0;
  const { session } = await fixture(t, { client,
    beforeGoalActivation() { assert.fail('parent workspace must not be activated'); },
    quotaGuard: { start() { assert.fail('quota start'); }, release() { assert.fail('parent reservation release'); } },
    authRecovery: { normalize: createNativeAuthNormalizer(), async recover() { recoveries++; return { status: 'paused', handoff }; } },
  });
  await assert.rejects(session.run(), error => {
    assert.deepEqual(error.authRecovery.handoff, handoff); return true;
  });
  assert.equal(recoveries, 1); assert.equal(session.workspaceActivated, false);
  assert.equal(client.stopped, true);
  for (const event of ['notification', 'request', 'exit']) assert.equal(client.listenerCount(event), 0);
});

test('recovered staged Goal activates once, owns its quota lifecycle, and completes one native turn', async (t) => {
  const client = new GoalClient();
  const request = client.request.bind(client);
  let reads = 0, recoveries = 0, activations = 0, starts = 0, releases = 0;
  client.request = async (method, params) => {
    if (method === 'account/rateLimits/read') {
      if (++reads === 1) throw new AppServerRpcError({ code: -32603, message: 'body: {"error":{"code":"token_revoked"}}' }, { method });
      return {};
    }
    return request(method, params);
  };
  const { session } = await fixture(t, { client,
    beforeGoalActivation: async () => { activations++; return ''; },
    quotaGuard: { async start() { starts++; }, async release() { releases++; } },
    authRecovery: { normalize: createNativeAuthNormalizer(), async recover() { recoveries++; return { status: 'recovered' }; } },
  });
  assert.equal((await session.run()).status, 'complete');
  assert.deepEqual([reads, recoveries, activations, starts, releases], [2, 1, 1, 1, 1]);
  assert.equal(client.calls.filter(call => call.method === 'thread/start').length, 1);
  assert.equal(client.calls.filter(call => call.method === 'thread/goal/set').length, 1);
  assert.equal(client.stopped, true);
});

test('startup deadline is bounded by default and preserves explicit long/off limits', () => {
  assert.equal(resolveFirstTurnDeadlineMs(null), 30_000);
  assert.equal(resolveFirstTurnDeadlineMs('off'), 0);
  assert.equal(resolveFirstTurnDeadlineMs('600000'), 600000);
  for (const value of [-1, NaN, Infinity, 1.1, '2s', 2147483648]) {
    assert.throws(() => resolveFirstTurnDeadlineMs(value), /bootstrap timeout/u);
  }
});

for (const early of [false, true]) {
  test(`initial Goal carries user provenance and observes early native completion (${early})`, async (t) => {
    const { client, session } = await fixture(t, { client: new GoalClient({ early }) });
    const result = await session.run();
    assert.equal(result.status, 'complete');
    const mutations = client.calls.filter(({ method }) => method === 'thread/goal/set');
    assert.equal(mutations[0].params.origin, 'user');
    assert.ok(mutations.slice(1).every(({ params }) => params.origin === 'automatic'));
    assert.equal(client.calls.some(({ method }) => method === 'turn/start'), false);
    assert.equal(client.suspensions, 0);
    assert.equal(client.stopped, true);
  });
}

test('idle Goal metadata schedules exactly one explicit read-only Plan bootstrap', async (t) => {
  const { client, session } = await fixture(t, {
    client: new GoalClient({ automatic: false }),
  });
  assert.equal((await session.run()).status, 'complete');
  const starts = client.calls.filter(({ method }) => method === 'turn/start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].params.collaborationMode.mode, 'plan');
  assert.equal(starts[0].params.sandboxPolicy.type, 'readOnly');
  assert.equal(starts[0].params.approvalPolicy, 'on-request');
  assert.deepEqual(client.calls.find(({ method }) => method === 'thread/turns/list').params, {
    threadId: 'ready-thread', limit: 20, sortDirection: 'desc', itemsView: 'summary',
  });
  assert.equal(client.suspensions, 0);
  assert.equal(session.nativeGoalTurnHeartbeat, null);
  assert.equal(session.nativeGoalReconcileTimer, null);
});

test('cancelling default unlimited native startup pauses automatically and settles once', async (t) => {
  const { client, session } = await fixture(t, {
    client: new GoalClient({ automatic: false, startBehavior: () => new Promise(() => {}) }), firstTurnDeadlineMs: 0,
  });
  const run = session.run();
  const rejected = assert.rejects(run, { code: 'CRUISE_INTERRUPTED' });
  await until(() => client.goal?.status === 'active');
  await session.interrupt();
  await rejected;
  assert.equal(client.calls.find(({ params }) => params.status === 'paused').params.origin, 'automatic');
  assert.equal(client.suspensions, 0);
  assert.equal(client.stopped, true);
});

test('already running native turn is adopted and a lost completion is recovered from history', async (t) => {
  const client = new GoalClient({ automatic: false });
  client.threadStatus = 'active';
  client.history = [{ id: 'native-running', status: 'inProgress' }];
  const { session } = await fixture(t, { client, firstTurnDeadlineMs: 10 });
  const run = session.run();
  await until(() => session.turnId === 'native-running');
  await delay(25); // Startup deadline cannot terminate an observed active turn.
  assert.equal(session.nativeGoalTurnDeadline, null);
  client.goal.status = 'complete';
  client.history = [{ id: 'native-running', status: 'completed' }];
  assert.equal((await run).status, 'complete');
  assert.equal(client.calls.filter(({ method }) => method === 'turn/start').length, 0);
  assert.equal(client.suspensions, 0);
});

for (const source of ['notification', 'history']) {
  test(`completion without a started event is recovered from ${source}`, async (t) => {
    const client = new GoalClient({ automatic: source === 'notification' });
    const completed = { id: 'unannounced', status: 'completed' };
    if (source === 'history') client.history = [completed];
    else client.finish = () => {
      client.goal = { ...client.goal, status: 'complete' };
      client.emit('notification', { method: 'turn/completed', params: { threadId: 'ready-thread', turn: completed } });
    };
    const { session } = await fixture(t, { client });
    assert.equal((await session.run()).status, 'complete');
    assert.equal(client.calls.some(({ method }) => method === 'turn/start'), false);
  });
}

test('ambiguous turn/start acceptance is reconciled without resubmission', async (t) => {
  const client = new GoalClient({ automatic: false, startBehavior: () => {
    client.history = [{ id: 'accepted-with-lost-reply', status: 'completed' }];
    client.goal.status = 'complete';
    return new Promise(() => {});
  } });
  const { session } = await fixture(t, { client, firstTurnDeadlineMs: 1000 });
  assert.equal((await session.run()).status, 'complete');
  assert.equal(client.calls.filter(({ method }) => method === 'turn/start').length, 1);
  assert.equal(session.nativeGoalReconcileTimer, null);
  assert.equal(session.nativeGoalCleanupWaits.size, 0);
});

for (const source of ['start rejection', 'nonretrying error', 'failed completion']) {
  test(`concrete authentication cause surfaces promptly from ${source}`, async (t) => {
    const cause = '401 Unauthorized: test account authentication expired';
    const client = new GoalClient({ automatic: false, startBehavior: async () => {
      if (source === 'start rejection') throw new Error(cause);
      const failed = { id: 'failed-auth', status: 'failed', error: { message: cause } };
      client.emit('notification', source === 'nonretrying error'
        ? { method: 'error', params: { threadId: 'ready-thread', turnId: failed.id, willRetry: false, error: failed.error } }
        : { method: 'turn/completed', params: { threadId: 'ready-thread', turn: failed } });
      return new Promise(() => {});
    } });
    const { session } = await fixture(t, { client });
    await assert.rejects(session.run(), { message: cause });
    assert.equal(client.calls.filter(({ method }) => method === 'turn/start').length, 1);
    assert.equal(client.suspensions, 0);
    assert.equal(session.nativeGoalTurnDeadline, null);
    assert.equal(session.nativeGoalReconcileTimer, null);
    assert.equal(session.nativeGoalCleanupWaits.size, 0);
    assert.equal(client.listenerCount('notification'), 0);
    assert.equal(client.stopped, true);
  });
}

test('retrying and foreign-thread errors do not replace native completion', async (t) => {
  const client = new GoalClient({ automatic: false, startBehavior: () => {
    for (const [threadId, willRetry] of [['ready-thread', true], ['foreign-thread', false]]) {
      client.emit('notification', { method: 'error', params: {
        threadId, turnId: 'native-turn', willRetry, error: { message: 'transient' },
      } });
    }
    client.finish();
    return { turn: { id: 'native-turn' } };
  } });
  const { session } = await fixture(t, { client });
  assert.equal((await session.run()).status, 'complete');
});

for (const failure of ['timeout', 'error']) {
  test(`a missing activation reply cannot hide bootstrap ${failure}`, async (t) => {
    class LostActivationReplyClient extends GoalClient {
      async request(method, params) {
        if (method === 'thread/goal/set' && params.status === 'active') {
          this.calls.push({ method, params });
          this.goal = { objective: params.objective, status: 'active' };
          if (failure === 'error') queueMicrotask(() => this.emit('notification', {
            method: 'error', params: { threadId: 'ready-thread', turnId: 'rejected', willRetry: false,
              error: { message: '403 Permission denied by native host' } },
          }));
          return new Promise(() => {});
        }
        return super.request(method, params);
      }
    }
    const client = new LostActivationReplyClient({ automatic: false });
    const { session } = await fixture(t, { client, firstTurnDeadlineMs: 20 });
    await assert.rejects(session.run(), failure === 'timeout'
      ? { code: 'CRUISE_GOAL_BOOTSTRAP_TIMEOUT' } : { message: '403 Permission denied by native host' });
    assert.equal(session.nativeGoalReconcileTimer, null);
    assert.equal(session.nativeGoalCleanupWaits.size, 0);
    assert.equal(session.startupAbortController.signal.aborted, true);
    assert.equal(client.stopped, true);
  });
}

for (const action of ['cancel', 'exit']) {
  test(`${action} settles an ambiguous bootstrap once and clears reconciliation`, async (t) => {
    const client = new GoalClient({ automatic: false, startBehavior: () => new Promise(() => {}) });
    const { session } = await fixture(t, { client });
    let settlements = 0;
    const run = session.run().finally(() => { settlements++; });
    const rejected = assert.rejects(run, action === 'cancel' ? { code: 'CRUISE_INTERRUPTED' } : /exited \(17\)/u);
    await until(() => client.calls.some(({ method }) => method === 'turn/start'));
    if (action === 'cancel') await session.interrupt();
    else client.emit('exit', { code: 17 });
    client.emit('notification', { method: 'turn/completed', params: {
      threadId: 'ready-thread', turn: { id: 'late-turn', status: 'completed' },
    } });
    await rejected;
    assert.equal(settlements, 1);
    assert.equal(client.calls.filter(({ method }) => method === 'turn/start').length, 1);
    assert.equal(session.nativeGoalReconcileTimer, null);
    assert.equal(session.nativeGoalTurnDeadline, null);
    assert.equal(session.nativeGoalCleanupWaits.size, 0);
    assert.equal(client.suspensions, 0);
  });
}

for (const externalSandbox of [false, true]) test(`reactivation ignores the consumed turn and explicitly starts the default-mode correction (external=${externalSandbox})`, async (t) => {
  const client = new GoalClient({ automatic: false });
  const { session } = await fixture(t, { client, externalSandbox });
  session.threadId = 'ready-thread';
  session.threadModel = 'gpt-5.6-sol';
  session.threadReasoningEffort = 'high';
  session.settledTurnIds.add('previous');
  client.history = [{ id: 'previous', status: 'completed' }];
  client.on('notification', session.onNotification);
  t.after(() => client.off('notification', session.onNotification));
  const result = await session.reactivateCompletedGoal({ objective: 'Implement the requested change.' }, 'Finish the missing verification.');
  assert.equal(result.status, 'completed');
  const starts = client.calls.filter(({ method }) => method === 'turn/start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].params.collaborationMode.mode, 'default');
  assert.equal(starts[0].params.approvalPolicy, 'on-request');
  const expectedPolicy = externalSandbox
    ? { type: 'externalSandbox', networkAccess: 'restricted' }
    : { type: 'workspaceWrite', writableRoots: [session.cwd] };
  assert.deepEqual(starts[0].params.sandboxPolicy, expectedPolicy);
  const settings = client.calls.find(({ method }) => method === 'thread/settings/update');
  assert.deepEqual(settings.params.sandboxPolicy, expectedPolicy);
  assert.equal(settings.params.approvalsReviewer, 'auto_review');
  assert.ok(client.calls.indexOf(settings) < client.calls.findIndex(({ method }) => method === 'thread/goal/set'));
  assert.match(starts[0].params.input[0].text, /missing verification/u);
  assert.equal(session.nativeGoalReconcileTimer, null);
});

for (const externalSandbox of [false, true]) test(`explicit Plan bootstrap advances to execution and a managed dispatch with persisted handoff (external=${externalSandbox})`, async (t) => {
  let starts = 0;
  const dispatchEvents = [];
  const client = new GoalClient({ automatic: false, startBehavior: async params => {
    starts++;
    assert.equal(params.collaborationMode.mode, starts === 1 ? 'plan' : 'default');
    assert.deepEqual(params.sandboxPolicy, externalSandbox
      ? { type: 'externalSandbox', networkAccess: 'restricted' }
      : starts === 1 ? { type: 'readOnly' } : { type: 'workspaceWrite', writableRoots: [params.cwd] });
    assert.equal(params.approvalPolicy, 'on-request');
    const id = `explicit-${starts}`;
    if (starts === 2) {
      const dispatcher = new ManagedWorkerDispatcher({
        cwd: params.cwd,
        reserveWorker: async () => ({ release: async () => dispatchEvents.push('released') }),
        runWorker: async request => {
          assert.equal(request.readOnly, true);
          assert.match(request.task, /cruise_bounded_context_capsule/u);
          assert.equal(await readFile(join(params.cwd, 'fixture.txt'), 'utf8'), 'bounded fixture');
          dispatchEvents.push('worker-read');
          return { threadId: 'mock-managed-worker', output: JSON.stringify({
            outcome: 'complete', completed_work: ['Read fixture.'], changed_files: [],
            decisions_and_invariants: ['Read only.'], exact_tests: ['Fixture content matched.'],
            active_blocker_or_next_work_item: 'Root can complete.', files_not_to_reread: [],
            evidence_pointers: ['fixture.txt'], usage_and_quota_summary: 'Mock worker; no model calls.',
          }) };
        },
      });
      const result = await dispatcher.dispatch({ task: 'Inspect the ordinary fixture.', complexity: 'bounded',
        readOnly: true, ownership: ['fixture.txt'], evidence: ['Fixture exists.'] });
      assert.equal(result.thread_id, 'mock-managed-worker');
      assert.match(await readFile(result.handoff_path, 'utf8'), /Read fixture/u);
      dispatchEvents.push('persisted');
      client.goal.status = 'complete';
    }
    queueMicrotask(() => client.emit('notification', { method: 'turn/completed', params: {
      threadId: 'ready-thread', turn: { id, status: 'completed' },
    } }));
    return { turn: { id, status: 'inProgress' } };
  } });
  const { session } = await fixture(t, { client, externalSandbox, prompt: 'Implement and verify the requested change.' });
  await writeFile(join(session.cwd, 'fixture.txt'), 'bounded fixture');
  assert.equal((await session.run()).status, 'complete');
  assert.equal(starts, 2);
  const settings = client.calls.filter(({ method }) => method === 'thread/settings/update');
  assert.deepEqual(settings.map(({ params }) => params.sandboxPolicy), externalSandbox
    ? Array(2).fill({ type: 'externalSandbox', networkAccess: 'restricted' })
    : [{ type: 'readOnly' }, { type: 'workspaceWrite', writableRoots: [session.cwd] }]);
  assert.ok(client.calls.indexOf(settings[0]) < client.calls.findIndex(({ method }) => method === 'thread/goal/set'));
  if (externalSandbox) {
    assert.match(settings[0].params.collaborationMode.settings.developer_instructions, /read-only Plan mode/u);
    assert.match(settings[0].params.collaborationMode.settings.developer_instructions, /same enforced outer boundary/u);
  }
  assert.deepEqual(dispatchEvents, ['worker-read', 'released', 'persisted']);
  assert.match(client.calls.find(({ method }) => method === 'thread/start').params.developerInstructions, /cruise worker --managed/u);
});

test('CLI exposes explicit timeout and requires a complete Codex-only handoff pair', () => {
  assert.equal(parseArgs(['goal', '--bootstrap-timeout-ms', 'off', 'Task']).firstTurnDeadlineMs, 0);
  assert.equal(parseArgs(['goal', '--bootstrap-timeout-ms', '600000', 'Task']).firstTurnDeadlineMs, 600000);
  assert.throws(() => parseArgs(['goal', '--bootstrap-timeout-ms', '5s', 'Task']), /requires 0/u);
  assert.throws(() => parseArgs(['goal', '--staged-handoff', '/tmp/c.json', 'Task']), /supplied together/u);
  assert.throws(() => parseArgs(['--claude', 'goal', '--ready-file', '/tmp/r.json', 'Task']), /only.*codex/u);
});

test('initialize handshake is independently configurable without conflating shutdown waits', () => {
  assert.equal(new AppServerClient({ env: { CRUISE_INITIALIZE_TIMEOUT_MS: '180000' } }).initializeTimeoutMs, 180000);
  assert.equal(new AppServerClient({ env: { CRUISE_INITIALIZE_TIMEOUT_MS: '0' } }).initializeTimeoutMs, 0);
  assert.equal(new AppServerClient({ initializeTimeoutMs: 1000, env: { CRUISE_INITIALIZE_TIMEOUT_MS: '0' } }).initializeTimeoutMs, 1000);
});

for (const outcome of ['accept', 'cancel', 'exit']) {
  test(`staged launcher: ${outcome} keeps parent ownership until fresh acceptance`, async (t) => {
    const parent = await mkdtemp(join(tmpdir(), 'cruise-parent-'));
    const transfer = await mkdtemp(join(tmpdir(), 'cruise-transfer-'));
    t.after(() => rm(parent, { recursive: true, force: true }));
    t.after(() => rm(transfer, { recursive: true, force: true }));
    const readyFile = join(transfer, 'ready.json');
    const capsuleFile = join(transfer, 'capsule.json');
    const client = new GoalClient();
    let session;
    let spawnEnvironment;
    const run = runStart({
      provider: 'codex', cwd: parent, skill: 'goal', prompt: 'Research only: finish remaining review.',
      stagedHandoff: capsuleFile, readyFile,
    }, {
      clientFactory: options => { spawnEnvironment = options.spawnOptions?.env; return client; },
      sessionFactory: (options) => (session = new SimpleCruiseSession({ ...options, requireAssurance: false, locateTrace: async () => null, traceHome: parent })),
    });
    const guarded = run.then(value => ({ value }), error => ({ error }));
    let ready;
    await until(async () => {
      try { ready = JSON.parse(await readFile(readyFile, 'utf8')); return true; }
      catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    });
    assert.deepEqual(await readdir(parent), []);
    if (spawnEnvironment?.CRUISE_RUNTIME_DIR) {
      assert.equal(session.runtimeDirectory, spawnEnvironment.CRUISE_RUNTIME_DIR);
      assert.equal(typeof spawnEnvironment.CRUISE_SESSION_ID, 'string');
    }
    assert.equal(client.calls.some(({ method }) => ['thread/goal/set', 'turn/start'].includes(method)), false);
    if (outcome === 'accept') {
      // Current parent work can progress after launch and before transfer.
      await writeFile(join(parent, 'completed-by-parent.txt'), 'latest work');
      await writeFile(capsuleFile, JSON.stringify({
        version: 1, session_id: ready.session_id, thread_id: ready.thread_id, workspace: ready.workspace,
        parent_relinquished: true, completed: ['Finished initial analysis after child startup'],
        remaining: ['Review the newest evidence only'], decisions: ['Preserve the scoped task'],
        evidence: ['completed-by-parent.txt'], ownership: ['Remaining review'],
      }));
      assert.equal((await guarded).value, 0);
      const activation = client.calls.find(({ method }) => method === 'thread/goal/set');
      assert.ok(activation.params.objective.length <= 4000);
      const settings = client.calls.find(({ method }) => method === 'thread/settings/update').params;
      assert.match(settings.collaborationMode.settings.developer_instructions, /Finished initial analysis after child startup/u);
      assert.match(settings.collaborationMode.settings.developer_instructions, /Review the newest evidence only/u);
      assert.equal(await readFile(join(parent, 'completed-by-parent.txt'), 'utf8'), 'latest work');
    } else {
      if (outcome === 'cancel') await session.interrupt();
      else client.emit('exit', { error: Object.assign(new Error('Transport died during handoff'), { code: 'MOCK_EXIT' }) });
      const result = await guarded;
      if (outcome === 'cancel') assert.equal(result.value, 130);
      else assert.match(result.error?.message, /Transport died/u);
      assert.deepEqual(await readdir(parent), []);
      assert.equal(client.calls.some(({ method }) => method === 'thread/goal/set'), false);
    }
    assert.equal(client.stopped, true);
    assert.equal(client.suspensions, 0);
    assert.equal(await readFile(readyFile).then(() => true, () => false), false);
  });
}

for (const stalled of ['initialize', 'thread/start', 'thread/settings/update']) {
  test(`cancellation settles stalled ${stalled} setup without waiting for an RPC deadline`, async (t) => {
    class StalledClient extends GoalClient {
      async start() { if (stalled === 'initialize') { this.atStall = true; return new Promise(() => {}); } }
      async request(method, params) {
        if (method === stalled) { this.atStall = true; return new Promise(() => {}); }
        return super.request(method, params);
      }
    }
    const client = new StalledClient();
    const { session } = await fixture(t, { client });
    const run = session.run();
    const rejection = assert.rejects(run, { code: 'CRUISE_INTERRUPTED' });
    await until(() => client.atStall);
    await session.interrupt();
    await rejection;
    assert.equal(client.stopped, true);
    assert.equal(client.calls.some(({ method }) => method === 'thread/goal/set'), false);
  });
}

test('large fresh handoff stays in collaboration instructions and not the bounded Goal objective', async (t) => {
  const handoff = 'Latest completed work: ' + 'a'.repeat(7000);
  const client = new GoalClient();
  const { session } = await fixture(t, { client, prompt: 'Research only: ' + 'b'.repeat(5000), beforeGoalActivation: async () => handoff });
  assert.equal((await session.run()).status, 'complete');
  const activation = client.calls.find(({ method }) => method === 'thread/goal/set');
  assert.ok(activation.params.objective.length <= 4000);
  const settings = client.calls.find(({ method }) => method === 'thread/settings/update').params;
  assert.ok(settings.collaborationMode.settings.developer_instructions.includes(handoff));
});

test('staged setup defers quota authority and usage writes until parent acceptance', async (t) => {
  let quotaStarts = 0;
  let accept;
  const accepted = new Promise(resolve => { accept = resolve; });
  const { session, root } = await fixture(t, {
    beforeGoalActivation: async () => { await accepted; return 'Fresh parent state'; },
    quotaGuard: { async start() { quotaStarts++; }, async release() {}, async check() {} },
  });
  const run = session.run();
  await until(() => session.threadId === 'ready-thread');
  await session.persistUsageNow();
  assert.equal(quotaStarts, 0);
  assert.deepEqual(await readdir(root), []);
  accept();
  assert.equal((await run).status, 'complete');
  assert.equal(quotaStarts, 1);
});

test('cancellation after an early native start cannot hang behind activation or interrupt RPCs', async (t) => {
  class EarlyHungClient extends GoalClient {
    async request(method, params = {}) {
      if (method === 'thread/goal/set' && params.status === 'active') {
        this.calls.push({ method, params });
        this.goal = { objective: params.objective, status: 'active' };
        queueMicrotask(() => this.emit('notification', {
          method: 'turn/started', params: { threadId: 'ready-thread', turn: { id: 'early-turn' } },
        }));
        return new Promise(() => {});
      }
      if (method === 'turn/interrupt') return new Promise(() => {});
      return super.request(method, params);
    }
  }
  const client = new EarlyHungClient();
  const { session } = await fixture(t, { client, firstTurnCleanupDeadlineMs: 10 });
  const run = session.run();
  const rejected = assert.rejects(run, { code: 'CRUISE_INTERRUPTED' });
  await until(() => session.turnId === 'early-turn');
  await session.interrupt();
  await rejected;
  assert.equal(client.stopped, true);
});
