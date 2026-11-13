import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AppServerClient } from '../scripts/lib/app-server-client.mjs';
import { SimpleCruiseSession, resolveFirstTurnDeadlineMs } from '../scripts/lib/simple-session.mjs';
import { parseArgs, runStart } from '../scripts/cruise.mjs';

class GoalClient extends EventEmitter {
  constructor({ automatic = true, early = false } = {}) {
    super();
    this.calls = [];
    this.automatic = automatic;
    this.early = early;
    this.goal = null;
    this.suspensions = 0;
  }
  async start() {}
  async stop() { this.stopped = true; }
  pauseInactivityWatchdog() { this.suspensions++; }
  resumeInactivityWatchdog() { this.suspensions--; }
  interrupt() {}
  async request(method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'ready-thread' }, model: 'gpt-5.6-sol', reasoningEffort: 'high' };
    if (method === 'thread/settings/update') return {};
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

test('startup deadline defaults off and validates explicit operators limits', () => {
  assert.equal(resolveFirstTurnDeadlineMs(null), 0);
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

test('silent native startup remains pending, emits heartbeat, resumes watchdog on native turn', async (t) => {
  const { client, session, diagnostics } = await fixture(t, {
    client: new GoalClient({ automatic: false }), firstTurnDeadlineMs: 0, startupHeartbeatMs: 10,
  });
  let settled = false;
  const run = session.run().finally(() => { settled = true; });
  await until(() => client.goal?.status === 'active');
  await delay(35);
  assert.equal(settled, false);
  assert.equal(session.nativeGoalTurnDeadline, null);
  assert.equal(client.suspensions, 1);
  assert.match(diagnostics(), /still waiting for native Goal startup/u);
  assert.equal(client.calls.some(({ params }) => params.status === 'paused'), false);
  client.finish();
  assert.equal((await run).status, 'complete');
  assert.equal(client.suspensions, 0);
  assert.equal(session.nativeGoalTurnHeartbeat, null);
});

test('cancelling default unlimited native startup pauses automatically and settles once', async (t) => {
  const { client, session } = await fixture(t, { client: new GoalClient({ automatic: false }), firstTurnDeadlineMs: 0 });
  const run = session.run();
  const rejected = assert.rejects(run, { code: 'CRUISE_INTERRUPTED' });
  await until(() => client.goal?.status === 'active');
  await session.interrupt();
  await rejected;
  assert.equal(client.calls.find(({ params }) => params.status === 'paused').params.origin, 'automatic');
  assert.equal(client.suspensions, 0);
  assert.equal(client.stopped, true);
});

test('CLI exposes opt-in timeout and requires a complete Codex-only handoff pair', () => {
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
