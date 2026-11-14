import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, runWorker, runStart, runBudget } from '../scripts/cruise.mjs';
import { AppServerRpcError } from '../scripts/lib/app-server-client.mjs';
import { createCliAuthRecovery, AuthRecoveryBoundaryError } from '../scripts/lib/auth-recovery-runtime.mjs';
import { QuotaGuard } from '../scripts/lib/quota-guard.mjs';

const revoked = () => new AppServerRpcError({ code: -32603,
  message: 'HTTP 401 Unauthorized, body: {"error":{"code":"token_revoked"}}' }, { method: 'account/rateLimits/read' });

async function fixture(t, { loginCode = 0, initialAccount = 'known' } = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'cruise-auth-cli-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const calls = [], clients = [], signals = new EventEmitter();
  let authenticated = false, launches = 0;
  class Client extends EventEmitter {
    async start() {}
    async stop() { this.stopped = true; }
    async request(method, params) {
      calls.push({ method, params, client: this });
      if (method === 'account/read') {
        if (!authenticated && initialAccount === 'error') throw new Error('mock refresh failure');
        if (!authenticated && initialAccount === 'null') return { account: null, requiresOpenaiAuth: true };
        return { account: { type: 'chatgpt', email: 'test@example.invalid', planType: 'plus' }, requiresOpenaiAuth: true };
      }
      if (method === 'account/rateLimits/read') {
        if (!authenticated) throw revoked();
        return { rateLimits: { secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 2000000000 } } };
      }
      if (method === 'thread/start') return { thread: { id: 'mock-worker' } };
      if (method === 'turn/start') {
        queueMicrotask(() => this.emit('notification', { method: 'turn/completed', params: { turn: { id: 'mock-turn', status: 'completed' } } }));
        return { turn: { id: 'mock-turn' } };
      }
      throw new Error(`Unexpected fixture method ${method}`);
    }
  }
  const clientFactory = () => { const client = new Client(); clients.push(client); return client; };
  const authRecoveryFactory = options => createCliAuthRecovery({ ...options, env: {},
    platform: 'darwin', input: { isTTY: false }, signals, clientFactory,
    locks: { tryAcquire: () => ({ release() {} }) },
    launcherOptions: { spawnFn(command, args) {
      assert.equal(command, 'codex'); assert.deepEqual(args, ['login']); launches++;
      const child = new EventEmitter(); child.pid = 4567;
      queueMicrotask(() => { authenticated = loginCode === 0; child.emit('close', loginCode); });
      return child;
    }, kill() { throw Object.assign(new Error(), { code: 'ESRCH' }); } },
  });
  const quotaGuardFactory = options => new QuotaGuard({ ...options,
    baseDirectory: join(cwd, 'fixture-quota'), budgetPolicyPath: join(cwd, 'no-policy.json') });
  return { cwd, calls, clients, signals, clientFactory, authRecoveryFactory, quotaGuardFactory,
    get launches() { return launches; } };
}

test('real worker CLI shares recovery with strict quota, launches non-TTY login and preserves worker controls', async t => {
  const f = await fixture(t);
  const options = parseArgs(['--codex', 'worker', '--read-only', '--strict-budget', '-C', f.cwd, 'Inspect the fixture.'], { env: {} });
  const result = await runWorker(options, { input: { isTTY: false }, env: {},
    workerClientFactory: f.clientFactory, budgetClientFactory: f.clientFactory,
    authRecoveryFactory: f.authRecoveryFactory, quotaGuardFactory: f.quotaGuardFactory });
  assert.equal(result, 0); assert.equal(f.launches, 1);
  assert.ok(f.clients.every(c => c.stopped)); assert.equal(f.signals.listenerCount('SIGTERM'), 0);
  const threads = f.calls.filter(c => c.method === 'thread/start'); assert.equal(threads.length, 1);
  assert.equal(threads[0].params.approvalsReviewer, 'auto_review');
  assert.equal(threads[0].params.approvalPolicy, 'on-request');
  assert.equal(threads[0].params.sandbox, 'read-only');
  assert.deepEqual(threads[0].params.runtimeWorkspaceRoots, []);
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
});

test('real worker preflight recovery retries only before model work when budget is disabled', async t => {
  const f = await fixture(t);
  const result = await runWorker(parseArgs(['--codex', 'worker', '-C', f.cwd, 'Inspect fixture.'], { env: {} }), {
    input: { isTTY: false }, env: {}, enforceBudget: false,
    workerClientFactory: f.clientFactory, authRecoveryFactory: f.authRecoveryFactory,
  });
  assert.equal(result, 0); assert.equal(f.launches, 1);
  assert.equal(f.calls.filter(c => c.method === 'thread/start').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
  assert.ok(f.clients.every(c => c.stopped));
});

for (const initialAccount of ['error', 'null']) {
  test(`missing original identity (${initialAccount}) pauses worker with code 6 without model work`, async t => {
    const f = await fixture(t, { initialAccount });
    const result = await runWorker(parseArgs(['--codex', 'worker', '-C', f.cwd, 'Inspect fixture.'], { env: {} }), {
      input: { isTTY: false }, env: {}, enforceBudget: false,
      workerClientFactory: f.clientFactory, authRecoveryFactory: f.authRecoveryFactory,
    });
    assert.equal(result, 6); assert.equal(f.launches, 1);
    assert.equal(f.calls.some(c => ['thread/start', 'turn/start'].includes(c.method)), false);
    assert.ok(f.clients.every(c => c.stopped));
    assert.equal(f.signals.listenerCount('SIGINT'), 0); assert.equal(f.signals.listenerCount('SIGTERM'), 0);
  });
}

test('strict quota CLI returns pause 6 after failed login and never launches model work', async t => {
  const f = await fixture(t, { loginCode: 1 }); const output = [];
  const result = await runBudget(parseArgs(['--codex', 'budget', '--strict-budget', '--json', '-C', f.cwd], { env: {} }), {
    clientFactory: f.clientFactory, quotaGuardFactory: f.quotaGuardFactory,
    authRecoveryFactory: f.authRecoveryFactory, input: { isTTY: false }, output: { write: text => output.push(text) },
  });
  assert.equal(result, 6); assert.equal(f.launches, 1);
  assert.equal(JSON.parse(output.join('')).authRecovery.reason, 'login-failed');
  assert.equal(f.calls.some(c => c.method === 'thread/start'), false);
  assert.ok(f.clients.every(c => c.stopped));
});

test('hosted Goal wires one recovery into session and quota, maps recovery pause to 6', async t => {
  const f = await fixture(t); let runtime, quotaRuntime, sessionRuntime;
  const before = process.listenerCount('SIGINT');
  const result = await runStart(parseArgs(['--codex', 'goal', '--strict-budget', '-C', f.cwd, 'Inspect fixture.'], { env: {} }), {
    authRecoveryFactory(options) { runtime = f.authRecoveryFactory(options); return runtime; },
    quotaGuardFactory(options) { quotaRuntime = options.authRecovery; return {}; },
    sessionFactory(options) {
      sessionRuntime = options.authRecovery;
      assert.equal(options.authProfile, runtime.profile);
      assert.equal(options.approvalsReviewer, 'auto_review');
      return { run() { throw new AuthRecoveryBoundaryError(revoked(), { status: 'paused', reason: 'verification-required' }); }, interrupt() {} };
    },
    // Constructor only; no app-server start occurs in this fixture.
    commitObserverFactory: () => ({ async start() {}, async stop() {} }),
    userDocumentWriter: async () => {}, input: { isTTY: false },
  });
  assert.equal(result, 6); assert.equal(quotaRuntime, runtime); assert.equal(sessionRuntime, runtime);
  assert.equal(process.listenerCount('SIGINT'), before); assert.equal(f.launches, 0);
});

test('package manifest ships the entire auth recovery runtime closure and docs', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const path of ['scripts/lib/auth-recovery.mjs', 'scripts/lib/auth-recovery-runtime.mjs', 'docs/AUTH_RECOVERY.md']) assert.ok(pkg.files.includes(path));
  assert.equal((pkg.scripts.pretest.match(/tests\/auth-recovery-cli.test.mjs/g) ?? []).length, 1);
});
