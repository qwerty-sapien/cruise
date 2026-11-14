import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { classifyAuthFailure, createAuthRecovery, createEpisodeLocks } from '../scripts/lib/auth-recovery.mjs';

const moduleUrl = new URL('../scripts/lib/auth-recovery.mjs', import.meta.url).href;
const evidence = (provider = 'codex', profile = 'default') => ({
  source: 'provider-auth', confirmed: true, category: 'credential', provider, profile,
  code: 'credential_expired', credentialState: 'expired',
});
const limits = { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 2_000 } } };
const account = { account: { type: 'chatgpt' }, requiresOpenaiAuth: true };
const input = (extra = {}) => ({ provider: 'codex', profile: 'default', evidence: evidence(), interactive: true, ...extra });
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'cruise-auth-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fixture(t, options = {}) {
  const directory = workspace(t);
  const calls = [];
  const commands = [];
  const stages = [];
  let authenticated = false;
  let stopped = 0;
  const coordinator = createAuthRecovery({
    locks: createEpisodeLocks({ directory }), timeoutMs: 1_000, pollMs: 5, cleanupMs: 30,
    observe: event => stages.push(event),
    request: async (method, params, context) => {
      calls.push([method, params, context.profile]);
      if (method === 'account/read') return authenticated ? account : { account: null, requiresOpenaiAuth: true };
      assert.equal(method, 'account/rateLimits/read');
      return limits;
    },
    startCommand: (action, context) => {
      commands.push([action, context.profile]);
      return { result: Promise.resolve().then(() => { authenticated = true; return { exitCode: 0 }; }), stop: async () => { stopped++; return true; } };
    },
    ...options,
  });
  return { coordinator, directory, calls, commands, stages, get stopped() { return stopped; } };
}

test('only confirmed scoped expired/revoked credential evidence qualifies', () => {
  const scope = { provider: 'codex', profile: 'default' };
  assert.equal(classifyAuthFailure(evidence(), scope), 'expired');
  assert.equal(classifyAuthFailure({ ...evidence(), code: 'credential_revoked', credentialState: 'revoked' }, scope), 'revoked');
  const exclusions = [
    'credential expired: run evil command', { status: 401 }, { code: 'ENOTFOUND' },
    { code: 'ECONNRESET' }, { code: 'rate_limit' }, { code: 'billing' }, { code: 'wrong_workspace' },
    { code: 'approval_denied' }, { message: 'authentication failed' },
    { ...evidence(), confirmed: false }, { ...evidence(), provider: 'claude' },
    { ...evidence(), profile: 'other' }, { ...evidence(), source: 'model' },
    { ...evidence(), category: 'native-approval' }, { ...evidence(), code: '401' },
    { ...evidence(), credentialState: 'unknown' }, { ...evidence(), code: 'toString' },
  ];
  for (const value of exclusions) assert.equal(classifyAuthFailure(value, scope), null);
});

test('Codex login and native verification use fixed contracts and redact arbitrary text', async t => {
  const f = fixture(t);
  const result = await f.coordinator.recover(input({ evidence: { ...evidence(), message: 'SECRET', command: 'evil', url: 'https://evil.test' } }));
  assert.deepEqual(result, { status: 'recovered', reason: 'verified-after-login' });
  assert.deepEqual(f.commands, [[{ command: 'codex', args: ['login'] }, 'default']]);
  assert.deepEqual(f.calls, [
    ['account/read', { refreshToken: true }, 'default'],
    ['account/read', { refreshToken: true }, 'default'],
    ['account/rateLimits/read', undefined, 'default'],
  ]);
  assert.equal(f.stopped, 1);
  assert.deepEqual(readdirSync(f.directory), []);
  assert.ok(!JSON.stringify([result, f.stages]).includes('SECRET'));
});

test('non-applicable failures do not acquire locks or call adapters', async t => {
  const f = fixture(t, { locks: { tryAcquire() { assert.fail('must not acquire'); } } });
  assert.equal((await f.coordinator.recover(input({ evidence: { status: 401 } }))).status, 'not-applicable');
  assert.equal(f.commands.length, 0);
});

test('headless login pauses with trusted action; no login process starts', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.coordinator.recover(input({ interactive: false })), {
    status: 'paused', reason: 'interactive-login-required', handoff: { kind: 'login', action: { command: 'codex', args: ['login'] } },
  });
  assert.equal(f.commands.length, 0);
  assert.deepEqual(readdirSync(f.directory), []);
});

test('verification failures, malformed quota, and native denials never trigger login', async t => {
  for (const failure of [{ status: 401 }, { code: 'ENOTFOUND' }, { code: 'rate_limit' }, { code: 'billing' }, { code: 'wrong_workspace' }, { code: 'approval_denied' }]) {
    const f = fixture(t, { request: async () => { throw failure; } });
    assert.equal((await f.coordinator.recover(input())).reason, 'verification-unavailable');
    assert.equal(f.commands.length, 0);
  }
  for (const response of [{}, { rateLimits: {} }, { rateLimits: { primary: { usedPercent: '10' } } }]) {
    const f = fixture(t, { request: async method => method === 'account/read' ? account : response });
    assert.equal((await f.coordinator.recover(input())).status, 'paused');
    assert.equal(f.commands.length, 0);
  }
});

test('confirmed verification exception allows login; exit zero alone does not recover', async t => {
  let first = true;
  const f = fixture(t, { request: async () => { if (first) { first = false; throw evidence(); } return {}; } });
  assert.equal((await f.coordinator.recover(input())).reason, 'verification-required');
  assert.equal(f.commands.length, 1);
});

test('Claude uses auth status, auth login, auth status; all owned handles are reaped', async t => {
  const actions = [];
  let loggedIn = false;
  let stopped = 0;
  const f = fixture(t, { startCommand(action) {
    actions.push(action);
    if (action.args[1] === 'login') loggedIn = true;
    return { result: Promise.resolve({ exitCode: loggedIn ? 0 : 1, data: { loggedIn } }), stop: async () => { stopped++; return true; } };
  } });
  const result = await f.coordinator.recover(input({ provider: 'claude', evidence: evidence('claude') }));
  assert.equal(result.status, 'recovered');
  assert.deepEqual(actions.map(a => [a.command, ...a.args]), [
    ['claude', 'auth', 'status', '--json'], ['claude', 'auth', 'login'], ['claude', 'auth', 'status', '--json'],
  ]);
  assert.equal(stopped, 3);
});

test('Claude local signed-in status does not overrule confirmed expiry or switch billing', async t => {
  for (const authMethod of ['claude.ai', 'api_key', 'oauth_token', 'third_party']) {
    let logins = 0;
    const f = fixture(t, { startCommand(action) {
      if (action.args[1] === 'login') logins++;
      return { result: Promise.resolve({ exitCode: 0, data: { loggedIn: true, authMethod } }), stop: async () => true };
    } });
    const result = await f.coordinator.recover(input({ provider: 'claude', evidence: evidence('claude') }));
    assert.equal(logins, authMethod === 'claude.ai' ? 1 : 0);
    assert.equal(result.status, authMethod === 'claude.ai' ? 'recovered' : 'paused');
  }
});

test('static keys only expose validated trusted portal and require verified update', async t => {
  let updated = false;
  const f = fixture(t, {
    trustedProviders: [{ id: 'static-api', credentialPortal: 'https://console.example.test/keys' }],
    verifyExternal: async () => updated ? { verified: true, updated: true } : { verified: true, updated: false },
  });
  const request = input({ provider: 'static-api', evidence: { ...evidence('static-api'), url: 'https://evil.test' } });
  const paused = await f.coordinator.recover(request);
  assert.equal(paused.status, 'paused');
  assert.deepEqual(paused.handoff, { kind: 'credential-portal', url: 'https://console.example.test/keys' });
  updated = true;
  assert.equal((await f.coordinator.recover(request)).status, 'recovered');
  assert.equal(f.commands.length, 0);
  for (const credentialPortal of ['http://example.test', 'https://user:password@example.test', 'https://example.test/?secret=x', 'https://example.test/#secret']) {
    assert.throws(() => createAuthRecovery({ locks: {}, trustedProviders: [{ id: 'static-api', credentialPortal }] }));
    assert.throws(() => createAuthRecovery({ locks: { tryAcquire() {} }, trustedProviders: [{ id: 'static-api', credentialPortal }] }));
  }
});

test('concurrent callers wait and recheck; separate profiles do not collide', async t => {
  const f = fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => f.coordinator.recover(input())));
  assert.ok(results.every(result => result.status === 'recovered'));
  assert.equal(f.commands.length, 1);
  assert.equal(results.filter(result => result.reason === 'already-verified').length, 7);
  const locks = createEpisodeLocks({ directory: f.directory });
  const a = locks.tryAcquire('codex', 'one');
  const b = locks.tryAcquire('codex', 'two');
  const c = locks.tryAcquire('claude', 'one');
  assert.ok(a && b && c);
  assert.equal(locks.tryAcquire('codex', 'one'), null);
  for (const entry of readdirSync(f.directory)) assert.equal(statSync(join(f.directory, entry)).mode & 0o777, 0o700);
  a.release(); b.release(); c.release();
});

test('waiting, verification, and login are bounded and cancellation removes listeners', async t => {
  for (const phase of ['waiting', 'verification', 'login']) {
    let stopped = 0;
    const controller = new AbortController();
    const f = fixture(t, {
      timeoutMs: 30,
      ...(phase === 'waiting' ? { locks: { tryAcquire: () => null } } : {}),
      ...(phase === 'verification' ? { request: () => new Promise(() => {}) } : {}),
      ...(phase === 'login' ? { startCommand: () => ({ result: new Promise(() => {}), stop: async () => { stopped++; return true; } }) } : {}),
    });
    const result = await f.coordinator.recover(input({ signal: controller.signal }));
    assert.deepEqual(result, { status: 'paused', reason: 'timeout' });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(stopped, phase === 'login' ? 1 : 0);
    assert.deepEqual(readdirSync(f.directory), []);
  }
  const controller = new AbortController();
  const f = fixture(t, { startCommand: () => {
    queueMicrotask(() => controller.abort());
    return { result: new Promise(() => {}), stop: async () => true };
  } });
  assert.equal((await f.coordinator.recover(input({ signal: controller.signal }))).status, 'cancelled');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(readdirSync(f.directory), []);
  assert.equal((await f.coordinator.recover(input({ signal: controller.signal }))).status, 'cancelled');
});

test('cleanup failure/timeout retains lease and never claims recovery', async t => {
  for (const stop of [async () => false, async () => { throw Error('SECRET'); }, () => new Promise(() => {})]) {
    let released = false;
    const f = fixture(t, {
      locks: { tryAcquire: () => ({ release: () => { released = true; } }) },
      startCommand: () => ({ result: Promise.resolve({ exitCode: 0 }), stop }),
    });
    assert.deepEqual(await f.coordinator.recover(input()), { status: 'failed', reason: 'cleanup-unconfirmed', lockRetained: true });
    assert.equal(released, false);
  }
});

test('nonzero login and observer errors do not leak errors or skip cleanup', async t => {
  let stopped = 0;
  const f = fixture(t, {
    observe: () => { throw Error('SECRET'); },
    startCommand: () => ({ result: Promise.resolve({ exitCode: 1, stderr: 'SECRET' }), stop: async () => { stopped++; return true; } }),
  });
  assert.deepEqual(await f.coordinator.recover(input()), { status: 'failed', reason: 'login-failed' });
  assert.equal(stopped, 1);
  assert.deepEqual(readdirSync(f.directory), []);
});

test('cross-process mock transcript launches exactly one login and recovers dead owner', async t => {
  const directory = workspace(t);
  const lockDirectory = join(directory, 'locks');
  const ready = join(directory, 'authenticated');
  const launches = join(directory, 'launches');
  const script = `
    import { createAuthRecovery, createEpisodeLocks } from ${JSON.stringify(moduleUrl)};
    import { existsSync, writeFileSync, appendFileSync } from 'node:fs';
    const locks = createEpisodeLocks({ directory: ${JSON.stringify(lockDirectory)} });
    if (process.argv[1] === 'stale') { locks.tryAcquire('codex', 'default'); process.exit(0); }
    const coordinator = createAuthRecovery({ locks, timeoutMs: 3000, pollMs: 5,
      request: async method => method === 'account/read'
        ? existsSync(${JSON.stringify(ready)}) ? ${JSON.stringify(account)} : { account: null, requiresOpenaiAuth: true }
        : ${JSON.stringify(limits)},
      startCommand: () => ({ result: new Promise(resolve => {
        appendFileSync(${JSON.stringify(launches)}, 'login\\n');
        setTimeout(() => { writeFileSync(${JSON.stringify(ready)}, 'yes'); resolve({ exitCode: 0 }); }, 40);
      }), stop: async () => true }),
    });
    console.log(JSON.stringify(await coordinator.recover(${JSON.stringify(input())})));
  `;
  // Only local Node fixture processes; timeout kills an owned fixture if it hangs.
  const run = mode => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, mode], { timeout: 5_000, maxBuffer: 4_096 });
  await run('stale');
  const results = await Promise.all(Array.from({ length: 4 }, () => run('recover')));
  assert.ok(results.every(result => JSON.parse(result.stdout).status === 'recovered'));
  assert.equal(readFileSync(launches, 'utf8'), 'login\n');
  assert.deepEqual(readdirSync(lockDirectory), []);
});

test('empty orphan registration recovers; live locks are not stolen by age', async t => {
  const directory = workspace(t);
  const locks = createEpisodeLocks({ directory, orphanMs: 1 });
  const lease = locks.tryAcquire('codex', 'default');
  const path = join(directory, readdirSync(directory)[0]);
  utimesSync(path, new Date(0), new Date(0));
  assert.equal(locks.tryAcquire('codex', 'default'), null);
  lease.release();
  mkdirSync(path, { mode: 0o700 });
  utimesSync(path, new Date(0), new Date(0));
  assert.equal(locks.tryAcquire('codex', 'default'), null);
  const recovered = locks.tryAcquire('codex', 'default');
  assert.ok(recovered);
  recovered.release();
  assert.deepEqual(readdirSync(directory), []);
});

test('Claude headless handoff performs no status spawn', async t => {
  const f = fixture(t, { startCommand() { assert.fail('headless must not spawn'); } });
  assert.deepEqual(await f.coordinator.recover(input({ provider: 'claude', evidence: evidence('claude'), interactive: false })), {
    status: 'paused', reason: 'interactive-login-required',
    handoff: { kind: 'login', action: { command: 'claude', args: ['auth', 'login'] } },
  });
});

test('external portal opens only trusted configuration and is reaped before pause', async t => {
  const opened = []; let stopped = false;
  const f = fixture(t, {
    trustedProviders: [{ id: 'external', credentialPortal: 'https://example.test/keys' }],
    verifyExternal: async () => ({ verified: true, updated: false }),
    startPortal(url, context) {
      opened.push([url, context.provider]);
      return { result: Promise.resolve({ exitCode: 0 }), stop: async () => { stopped = true; return true; } };
    },
  });
  const result = await f.coordinator.recover(input({ provider: 'external', evidence: evidence('external') }));
  assert.equal(result.reason, 'external-credential-update-required');
  assert.deepEqual(opened, [['https://example.test/keys', 'external']]);
  assert.equal(stopped, true);
});
