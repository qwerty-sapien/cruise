import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEpisodeLocks } from '../scripts/lib/auth-recovery.mjs';
import { AppServerRpcError } from '../scripts/lib/app-server-client.mjs';
import { createNativeAuthNormalizer, createRuntimeLauncher, createAuthRecoveryRuntime, createCliAuthRecovery, captureClaudeAuthFailure } from '../scripts/lib/auth-recovery-runtime.mjs';

// Synthetic version-pinned provider contracts, not claims about installed schemas.
const contracts = [{ provider: 'codex', transport: 'app-server', path: ['data', 'code'], expired: 'refresh_token_expired', revoked: 'refresh_token_revoked' }];
const scope = { provider: 'codex', profile: 'default', transport: 'app-server' };
const native = code => new AppServerRpcError({ code: -32000, data: { code }, message: 'untrusted prose' });
const evidence = { source: 'provider-auth', confirmed: true, category: 'credential', provider: 'codex', profile: 'default', code: 'credential_expired', credentialState: 'expired' };

test('Codex 0.169.0 revoked contract accepts only bounded trailing rate-limit body JSON', () => {
  const normalize = createNativeAuthNormalizer();
  const body = '{"error":{"code":"token_revoked"}}';
  const rpc = (message, method = 'account/rateLimits/read', code = -32603) =>
    new AppServerRpcError({ code, message }, { method });
  assert.equal(normalize(rpc(`HTTP 401 Unauthorized, body: ${body}`), scope)?.credentialState, 'revoked');
  for (const message of [body, `HTTP 401 ${body}`, 'HTTP 401 token_revoked',
    `body: ${body} trailing prose`, `body: {"nested":${body}}`, `body: [${body}]`,
    `body: ${body}\n${body}`, 'body: {broken}', `body: ${JSON.stringify({ error: { code: 'token_revoked' }, padding: 'x'.repeat(8192) })}`,
    `${'x'.repeat(16384)} body: ${body}`,
    ...['authentication_required', 'approval_denied', 'wrong_workspace', 'billing', 'rate_limit', 'ENOTFOUND', '401']
      .map(code => `token_revoked body: ${JSON.stringify({ error: { code } })}`)]) {
    assert.equal(normalize(rpc(message), scope), null);
  }
  for (const method of ['account/read', 'turn/start', 'thread/start', undefined]) {
    const error = rpc(`body: ${body}`); error.request = { method };
    assert.equal(normalize(error, scope), null);
  }
  assert.equal(normalize(rpc(`body: ${body}`, 'account/rateLimits/read', 401), scope), null);
  assert.equal(normalize(rpc(`body: ${body}`), { ...scope, provider: 'claude' }), null);
  assert.equal(normalize(rpc(`body: ${body}`), { ...scope, transport: 'provider-response' }), null);
  assert.equal(normalize(Object.assign(new Error(`body: ${body}`), { code: -32603, request: { method: 'account/rateLimits/read' } }), scope), null);
  const getter = rpc('unused');
  Object.defineProperty(getter, 'message', { get() { assert.fail('message getter executed'); } });
  assert.equal(normalize(getter, scope), null);
});

function fixture(options = {}) {
  const calls = [], timers = new Map(), children = [], signals = new EventEmitter();
  let timerId = 0, present = true;
  const launcher = createRuntimeLauncher({
    signals, platform: 'darwin', portalUrls: ['https://example.test/keys'],
    setTimer(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimer(id) { timers.delete(id); },
    spawnFn(command, args, settings) {
      calls.push({ command, args, settings });
      const child = new EventEmitter(); child.pid = 12345; child.stdout = new EventEmitter();
      children.push(child); return child;
    },
    kill(pid, signal) {
      assert.equal(pid, -12345);
      if (!present) throw Object.assign(new Error(), { code: 'ESRCH' });
      calls.push({ signal });
      if (signal === 'SIGTERM') { present = false; children.at(-1).emit('close', null); }
    }, ...options,
  });
  return { launcher, calls, children, signals, timers,
    close(code = 0) { present = false; children.at(-1).emit('close', code); },
    async tick(ms) { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } await Promise.resolve(); },
  };
}

test('native normalization uses exact structured fields and typed RPC errors only', () => {
  const normalize = createNativeAuthNormalizer(contracts);
  assert.equal(normalize(native('refresh_token_expired'), scope).credentialState, 'expired');
  assert.equal(normalize(native('refresh_token_revoked'), scope).credentialState, 'revoked');
  for (const code of [401, '401', 'authentication_required', 'ENOTFOUND', 'ECONNRESET', 'rate_limit', 'billing', 'wrong_workspace', 'approval_denied', 'expired token']) {
    assert.equal(normalize(native(code), scope), null);
  }
  for (const error of ['refresh_token_expired', { data: { code: 'refresh_token_expired' } }, new Error('refresh_token_expired')]) assert.equal(normalize(error, scope), null);
  assert.equal(normalize(native('refresh_token_expired'), { ...scope, provider: 'claude' }), null);
  assert.equal(createNativeAuthNormalizer()(native('refresh_token_expired'), scope), null);
  assert.throws(() => createNativeAuthNormalizer([{ ...contracts[0], expired: '401' }]));
  const getter = native(null); Object.defineProperty(getter.data, 'code', { get() { assert.fail('getter'); } });
  assert.equal(normalize(getter, scope), null);
});

test('fixed shell-free login inherits I/O and does not change auth environment', async () => {
  const f = fixture();
  const child = f.launcher.startCommand({ command: 'codex', args: ['login'] }, scope);
  assert.deepEqual(f.calls[0], { command: 'codex', args: ['login'], settings: { shell: false, detached: true, stdio: 'inherit' } });
  f.close(); assert.equal((await child.result).exitCode, 0); assert.equal(await child.stop(), true);
  assert.equal(f.signals.listenerCount('SIGINT'), 0); assert.equal(f.timers.size, 0);
  for (const action of [{ command: 'sh', args: ['-c', 'codex login'] }, { command: 'codex', args: ['login', '--profile', 'evil'] }]) assert.throws(() => f.launcher.startCommand(action, scope));
  assert.throws(() => f.launcher.startCommand({ command: 'codex', args: ['login'] }, { ...scope, profile: 'other' }));
});

test('Claude status returns only bounded loggedIn state', async () => {
  const f = fixture();
  const child = f.launcher.startCommand({ command: 'claude', args: ['auth', 'status', '--json'] }, { ...scope, provider: 'claude' });
  f.children[0].stdout.emit('data', '{"loggedIn":true,"authMethod":"claude.ai","secret":"not returned"}'); f.close();
  assert.deepEqual(await child.result, { exitCode: 0, data: { loggedIn: true, authMethod: 'claude.ai' } });
  assert.equal(await child.stop(), true);
});

test('abort and timeout stop only owned process group and require confirmed exit', async () => {
  for (const mode of ['abort', 'timeout', 'signal']) {
    const f = fixture(); const controller = new AbortController();
    const child = f.launcher.startCommand({ command: 'codex', args: ['login'] }, { ...scope, signal: controller.signal });
    if (mode === 'abort') controller.abort(); else if (mode === 'signal') f.signals.emit('SIGINT'); else await f.tick(120000);
    await f.tick(250);
    assert.equal(await child.stop(), true);
    assert.equal((await child.result).exitCode, null);
    assert.ok(f.calls.some(c => c.signal === 'SIGTERM'));
    assert.equal(f.timers.size, 0);
  }
});

test('unconfirmed group survival fails cleanup even after parent closes', async () => {
  const kills = []; const f = fixture({ kill(pid, signal) { kills.push([pid, signal]); } });
  const child = f.launcher.startCommand({ command: 'codex', args: ['login'] }, scope);
  f.close(); const stopping = child.stop(); await f.tick(250); await f.tick(1000);
  assert.equal(await stopping, false);
  assert.ok(kills.some(([pid, s]) => pid === -12345 && s === 'SIGKILL'));
});

test('portal opener accepts only trusted exact HTTPS destinations', async () => {
  const f = fixture(); assert.throws(() => f.launcher.startPortal('https://evil.test/', scope));
  const child = f.launcher.startPortal('https://example.test/keys', scope);
  assert.equal(f.calls[0].command, '/usr/bin/open'); assert.deepEqual(f.calls[0].args, ['https://example.test/keys']);
  f.close(); await child.result; assert.equal(await child.stop(), true);
  assert.throws(() => createRuntimeLauncher({ portalUrls: ['http://example.test/'] }));
});

test('headless runtime never spawns or calls provider and returns exact trusted handoff', async () => {
  const runtime = createAuthRecoveryRuntime({ locks: { tryAcquire() { assert.fail('lock'); } },
    request() { assert.fail('request'); }, launcherOptions: { spawnFn() { assert.fail('spawn'); } } });
  assert.deepEqual(await runtime.recover({ ...scope, evidence }), { status: 'paused', reason: 'interactive-login-required', handoff: { kind: 'login', action: { command: 'codex', args: ['login'] } } });
});

test('mock app-server errors normalize for verification without exposing prose', async () => {
  let calls = 0;
  const runtime = createAuthRecoveryRuntime({ nativeContracts: contracts, locks: { tryAcquire: () => ({ release() {} }) },
    request: async () => { calls++; throw native('refresh_token_expired'); },
    launcherOptions: { spawnFn() { throw new Error('mock launch prevented'); } } });
  const result = await runtime.recover({ ...scope, evidence, interactive: true });
  assert.equal(calls, 1); assert.equal(result.reason, 'recovery-failed');
});

test('macOS non-TTY CLI launches login, verifies with fresh clients and cleans listeners', async () => {
  const signals = new EventEmitter(), calls = [], clients = [];
  let loggedIn = false, live = false, released = false;
  const runtime = createCliAuthRecovery({ cwd: '/workspace', env: { CODEX_HOME: '/fixture/profile' },
    input: { isTTY: false }, platform: 'darwin', signals,
    locks: { tryAcquire: () => ({ release() { released = true; } }) },
    clientFactory() {
      const client = { stopped: false, async start() {}, async stop() { client.stopped = true; },
        async request(method, params) {
          calls.push([method, params]);
          if (method === 'account/read') return { account: { type: 'chatgpt', email: 'fixture@example.invalid' }, requiresOpenaiAuth: true };
          if (!loggedIn) throw new AppServerRpcError({ code: -32603, message: 'HTTP 401 body: {"error":{"code":"token_revoked"}}' }, { method });
          return { rateLimits: { secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 2000000000 } } };
        } };
      clients.push(client); return client;
    },
    launcherOptions: {
      spawnFn(command, args, settings) {
        assert.equal(command, 'codex'); assert.deepEqual(args, ['login']);
        assert.equal(settings.cwd, '/workspace'); assert.equal(settings.env.CODEX_HOME, '/fixture/profile');
        const child = new EventEmitter(); child.pid = 4242; live = true;
        queueMicrotask(() => { loggedIn = true; live = false; child.emit('close', 0); });
        return child;
      },
      kill(pid) { assert.equal(pid, -4242); if (!live) throw Object.assign(new Error(), { code: 'ESRCH' }); },
    },
  });
  const result = await runtime.recover({ ...scope, profile: runtime.profile, evidence: { ...evidence, profile: runtime.profile }, interactive: false });
  assert.equal(result.status, 'recovered'); assert.equal(result.reason, 'verified-after-login');
  assert.equal(clients.length, 4); assert.ok(clients.every(c => c.stopped));
  assert.equal(calls.filter(([m, p]) => m === 'account/read' && p.refreshToken === true).length, 2);
  assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(released, true);
});

test('profile lock identity ignores cwd and session but separates configured homes', () => {
  const runtimeFactory = () => ({ normalize() {}, recover() {} });
  const a = createCliAuthRecovery({ cwd: '/a', env: { CODEX_HOME: '/fixture/one' }, runtimeFactory });
  const b = createCliAuthRecovery({ cwd: '/b', env: { CODEX_HOME: '/fixture/one' }, runtimeFactory });
  const c = createCliAuthRecovery({ cwd: '/a', env: { CODEX_HOME: '/fixture/two' }, runtimeFactory });
  assert.equal(a.profile, b.profile); assert.notEqual(a.profile, c.profile);
  assert.match(a.profile, /^[a-f0-9]{64}$/);
  const relative = createCliAuthRecovery({ cwd: '/fixture', env: { CODEX_HOME: 'one' }, runtimeFactory });
  assert.equal(relative.profile, a.profile);
});

test('CLI cancellation propagates through verification and disposes bounded listeners', async () => {
  const signals = new EventEmitter(); let cancelled = false;
  const runtime = createCliAuthRecovery({ signals, env: {}, runtimeFactory: () => ({ normalize() {},
    recover({ signal }) { return new Promise(resolve => {
      signal.addEventListener('abort', () => { cancelled = true; resolve({ status: 'cancelled' }); }, { once: true });
      queueMicrotask(() => signals.emit('SIGTERM'));
    }); },
  }) });
  assert.equal((await runtime.recover({ profile: runtime.profile })).status, 'cancelled');
  assert.equal(cancelled, true); assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('explicit credential override yields update handoff without reading the value', async () => {
  const env = {};
  Object.defineProperty(env, 'CLAUDE_CODE_OAUTH_TOKEN', { get() { assert.fail('secret read'); } });
  const runtime = createCliAuthRecovery({ provider: 'claude', env,
    runtimeFactory: () => ({ normalize() {}, recover() { assert.fail('login'); } }) });
  assert.equal((await runtime.recover({ profile: runtime.profile })).reason, 'configured-credential-update-required');
});

test('Claude only accepts exact documented native assistant error envelopes', () => {
  const text = 'Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.';
  const envelope = { type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text }] } };
  const normalize = createNativeAuthNormalizer();
  const claudeScope = { ...scope, provider: 'claude', transport: 'claude-cli' };
  assert.equal(normalize(captureClaudeAuthFailure(envelope), claudeScope)?.credentialState, 'revoked');
  for (const value of [{ ...envelope, error: undefined }, { type: 'result', is_error: true, result: text },
    { ...envelope, error: 'billing_error' }, { ...envelope, message: { content: [{ type: 'text', text: `Quoted: ${text}` }] } },
    { ...envelope, message: { content: [{ type: 'text', text: 'API Error: 401 Invalid authentication credentials' }] } }]) {
    assert.equal(captureClaudeAuthFailure(value), null);
  }
});

test('native verifier stop error retains the lock and cannot report recovery', async () => {
  let released = false;
  const runtime = createCliAuthRecovery({ env: {}, platform: 'darwin', input: { isTTY: false },
    locks: { tryAcquire: () => ({ release() { released = true; } }) },
    clientFactory: () => ({ async start() {}, async request() {
      return { account: { type: 'chatgpt' }, requiresOpenaiAuth: true };
    }, async stop() { return { error: new Error('mock stop unconfirmed') }; } }),
    launcherOptions: { spawnFn() { assert.fail('must not launch'); } },
  });
  const result = await runtime.recover({ ...scope, profile: runtime.profile, evidence: { ...evidence, profile: runtime.profile } });
  assert.equal(result.reason, 'cleanup-unconfirmed'); assert.equal(result.lockRetained, true); assert.equal(released, false);
});

test('fresh verifier refuses an account switch across native login', async () => {
  let loggedIn = false;
  const runtime = createCliAuthRecovery({ env: {}, platform: 'darwin',
    locks: { tryAcquire: () => ({ release() {} }) },
    clientFactory: () => ({ async start() {}, async stop() {}, async request(method) {
      if (method === 'account/read') return { account: { type: 'chatgpt', email: loggedIn ? 'new@example.invalid' : 'old@example.invalid' }, requiresOpenaiAuth: true };
      if (!loggedIn) throw new AppServerRpcError({ code: -32603, message: 'body: {"error":{"code":"token_revoked"}}' }, { method });
      return { rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 2000000000 } } };
    } }),
    launcherOptions: { spawnFn() { const child = new EventEmitter(); child.pid = 7654;
      queueMicrotask(() => { loggedIn = true; child.emit('close', 0); }); return child;
    }, kill() { throw Object.assign(new Error(), { code: 'ESRCH' }); } },
  });
  const result = await runtime.recover({ ...scope, profile: runtime.profile, evidence: { ...evidence, profile: runtime.profile } });
  assert.equal(result.status, 'paused'); assert.equal(result.reason, 'verification-required');
});

for (const initial of ['error', 'null']) {
  for (const previous of ['unknown', 'same', 'different']) {
    test(`identity regression: initial ${initial}, previous account ${previous}`, async () => {
      let loggedIn = false, launches = 0, quotaReads = 0;
      const account = { type: 'chatgpt', email: 'new@example.invalid', planType: 'plus' };
      const clients = [], signals = new EventEmitter();
      const runtime = createCliAuthRecovery({ env: {}, platform: 'darwin', input: { isTTY: false }, signals,
        ...(previous === 'unknown' ? {} : { previousAccount: { ...account,
          email: previous === 'same' ? account.email : 'old@example.invalid' } }),
        locks: { tryAcquire: () => ({ release() {} }) },
        clientFactory() {
          const client = { stopped: false, async start() {}, async stop() { this.stopped = true; },
            async request(method) {
              if (method === 'account/read') {
                if (loggedIn) return { account, requiresOpenaiAuth: true };
                if (initial === 'error') throw new Error('mock refresh failure');
                return { account: null, requiresOpenaiAuth: true };
              }
              quotaReads++;
              if (!loggedIn) throw new AppServerRpcError({ code: -32603,
                message: 'body: {"error":{"code":"token_revoked"}}' }, { method });
              return { rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 2000000000 } } };
            } };
          clients.push(client); return client;
        },
        launcherOptions: { spawnFn(command, args) {
          assert.equal(command, 'codex'); assert.deepEqual(args, ['login']); launches++;
          const child = new EventEmitter(); child.pid = 7654;
          queueMicrotask(() => { loggedIn = true; child.emit('close', 0); }); return child;
        }, kill() { throw Object.assign(new Error(), { code: 'ESRCH' }); } },
      });
      const context = { ...scope, profile: runtime.profile, evidence: { ...evidence, profile: runtime.profile } };
      const result = await runtime.recover(context);
      // A second attempt must not adopt the post-login account as a baseline.
      const retry = previous === 'unknown' ? await runtime.recover(context) : null;
      assert.equal(launches, 1);
      assert.ok(clients.every(client => client.stopped));
      assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0);
      if (previous === 'same') assert.equal(result.status, 'recovered');
      else {
        assert.equal(result.status, 'paused');
        assert.equal(result.reason, previous === 'unknown' ? 'owner-identity-confirmation-required' : 'verification-required');
      }
      if (previous === 'unknown') {
        assert.deepEqual(retry, result);
        assert.ok(quotaReads >= 2, 'fresh quota succeeds without authorizing identity-preserving recovery');
      }
    });
  }
}

test('lifecycle regression: cancelled waiter leaves the leader verifier and lease intact', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'cruise-auth-owner-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sharedLocks = createEpisodeLocks({ directory });
  let entered, finish, waiting, releases = 0, prematureStops = 0;
  const pending = new Promise(resolve => { entered = resolve; });
  const response = new Promise(resolve => { finish = resolve; });
  const waiter = new Promise(resolve => { waiting = resolve; });
  const signals = new EventEmitter(), clients = [];
  const runtime = createCliAuthRecovery({ env: {}, platform: 'darwin', signals, timeoutMs: 2000,
    locks: { tryAcquire(provider, profile) {
      const lease = sharedLocks.tryAcquire(provider, profile);
      if (!lease) { waiting(); return null; }
      return { release() { releases++; lease.release(); } };
    } },
    clientFactory() {
      const client = { stopped: false, pending: false, stops: 0, async start() {},
        async stop() { this.stops++; if (this.pending) prematureStops++; this.stopped = true; },
        async request(method) {
          if (method === 'account/read') {
            this.pending = true; entered(); await response; this.pending = false;
            if (this.stopped) throw new Error('leader verifier was stopped');
            return { account: { type: 'chatgpt', email: 'owner@example.invalid' }, requiresOpenaiAuth: true };
          }
          return { rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 2000000000 } } };
        } };
      clients.push(client); return client;
    },
    launcherOptions: { spawnFn() { assert.fail('no login needed'); } },
  });
  const context = { ...scope, profile: runtime.profile, evidence: { ...evidence, profile: runtime.profile } };
  const leader = runtime.recover(context);
  await pending;
  const cancellation = new AbortController();
  const follower = runtime.recover({ ...context, signal: cancellation.signal });
  await waiter; cancellation.abort();
  const followerResult = await follower;
  const releasesBeforeLeader = releases, stoppedBeforeLeader = clients[0].stopped;
  const competingLease = sharedLocks.tryAcquire('codex', runtime.profile);
  competingLease?.release();
  finish();
  const leaderResult = await leader;
  assert.deepEqual(followerResult, { status: 'cancelled', reason: 'cancelled' });
  assert.equal(stoppedBeforeLeader, false);
  assert.equal(prematureStops, 0); assert.equal(releasesBeforeLeader, 0); assert.equal(competingLease, null);
  assert.deepEqual(leaderResult, { status: 'recovered', reason: 'already-verified' });
  assert.equal(releases, 1); assert.ok(clients.every(client => client.stopped && client.stops === 1));
  assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0);
  const nextLease = sharedLocks.tryAcquire('codex', runtime.profile);
  assert.ok(nextLease); nextLease.release();
});
