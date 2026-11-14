import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AppServerRpcError } from '../scripts/lib/app-server-client.mjs';
import { createNativeAuthNormalizer } from '../scripts/lib/auth-recovery-runtime.mjs';

import {
  BudgetPauseError,
  deriveAccountHash,
  mergeSparseRateLimits,
  QuotaGuard,
  selectWeeklyWindow,
} from '../scripts/lib/quota-guard.mjs';

const ACCOUNT = {
  account: { type: 'chatgpt', email: 'person@example.test', planType: 'pro' },
  requiresOpenaiAuth: true,
};

function snapshot({ used = 20, resetsAt = 2_000, primaryMinutes = 300, weeklyMinutes = 10_080 } = {}) {
  return {
    primary: { usedPercent: Math.max(used - 1, 0), windowDurationMins: primaryMinutes, resetsAt: resetsAt - 100 },
    secondary: { usedPercent: used, windowDurationMins: weeklyMinutes, resetsAt },
  };
}

class MockAccountClient extends EventEmitter {
  constructor(rateLimits) {
    super();
    this.rateLimits = Array.isArray(rateLimits) ? [...rateLimits] : [rateLimits];
    this.calls = [];
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/read') {
      assert.deepEqual(params, { refreshToken: false });
      return ACCOUNT;
    }
    if (method === 'account/rateLimits/read') {
      const next = this.rateLimits.length > 1 ? this.rateLimits.shift() : this.rateLimits[0];
      return { rateLimits: next };
    }
    throw new Error(`unexpected request: ${method}`);
  }
}

async function quotaWorkspace(t, label) {
  const root = await mkdtemp(join(tmpdir(), `cruise-quota-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, baseDirectory: join(root, 'account-ledgers') };
}

test('strict authority recovery drains reads, retries once, and reserves only after fresh authority', async (t) => {
  const { root, baseDirectory } = await quotaWorkspace(t, 'auth-recovered');
  let recovered = false, recoveries = 0, accountSettled = false, reads = 0;
  const client = new MockAccountClient(snapshot());
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === 'account/read' && !recovered) {
      await new Promise(resolve => setImmediate(resolve));
      accountSettled = true;
      throw new Error('account unavailable');
    }
    if (method === 'account/rateLimits/read') {
      reads++;
      if (!recovered) throw new AppServerRpcError({ code: -32603, message: 'body: {"error":{"code":"token_revoked"}}' }, { method });
    }
    return request(method, params);
  };
  const guard = new QuotaGuard({ cwd: root, baseDirectory, strictBudget: true,
    authRecovery: { normalize: createNativeAuthNormalizer(), async recover(input) {
      assert.equal(accountSettled, true); assert.equal(guard.reservationId, null);
      assert.equal(input.interactive, false); recoveries++; recovered = true;
      return { status: 'recovered' };
    } } });
  assert.equal((await guard.start({ client })).metered, true);
  assert.equal(recoveries, 1); assert.equal(reads, 2);
  assert.equal(JSON.parse(await readFile(guard.ledgerPath(), 'utf8')).reservations.length, 1);
  await guard.release();
  assert.equal(client.listenerCount('notification'), 0);
});

test('strict auth handoff and exhausted retry retain exit 6 and clean startup listener', async (t) => {
  for (const status of ['paused', 'recovered']) {
    const { root, baseDirectory } = await quotaWorkspace(t, `auth-${status}`);
    let reads = 0, recoveries = 0;
    const handoff = { kind: 'login', action: { command: 'codex', args: ['login'] } };
    const client = new MockAccountClient(snapshot());
    const request = client.request.bind(client);
    client.request = async (method, params) => {
      if (method === 'account/rateLimits/read') {
        reads++; throw new AppServerRpcError({ code: -32603, message: 'body: {"error":{"code":"token_revoked"}}' }, { method });
      }
      return request(method, params);
    };
    const guard = new QuotaGuard({ cwd: root, baseDirectory, strictBudget: true,
      authRecovery: { normalize: createNativeAuthNormalizer(), async recover() { recoveries++; return { status, handoff }; } } });
    await assert.rejects(guard.start({ client }), error => {
      assert.ok(error instanceof BudgetPauseError); assert.equal(error.exitCode, 6);
      if (status === 'paused') assert.deepEqual(error.report.authRecovery.handoff, handoff);
      return true;
    });
    assert.equal(guard.reservationId, null);
    assert.equal(client.listenerCount('notification'), 0);
    assert.equal(reads, status === 'paused' ? 1 : 2); assert.equal(recoveries, 1);
  }
});

test('strict check recovery cannot bypass campaign cap or release another reservation', async (t) => {
  const { root, baseDirectory } = await quotaWorkspace(t, 'auth-check');
  const client = new MockAccountClient(snapshot());
  const parent = new QuotaGuard({ cwd: root, baseDirectory, strictBudget: true });
  await parent.start({ client });
  let recoveries = 0, expired = false;
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (expired && method === 'account/rateLimits/read') {
      expired = false;
      throw new AppServerRpcError({ code: -32603, message: 'body: {"error":{"code":"token_revoked"}}' }, { method });
    }
    return request(method, params);
  };
  const guard = new QuotaGuard({ cwd: root, baseDirectory, strictBudget: true,
    authRecovery: { normalize: createNativeAuthNormalizer(), async recover() { recoveries++; return { status: 'recovered' }; } } });
  await guard.start({ client });
  expired = true;
  await guard.check();
  assert.equal(recoveries, 1);
  client.rateLimits = [snapshot({ used: 30 })]; expired = true;
  await assert.rejects(guard.check(), error => error.exitCode === 6 && /campaign cap/.test(error.message));
  assert.equal(recoveries, 2, 'successful fresh authority ends the earlier episode');
  const ledger = JSON.parse(await readFile(guard.ledgerPath(), 'utf8'));
  assert.equal(ledger.reservations.filter(item => item.status === 'active').length, 2);
  await guard.release();
  assert.equal(JSON.parse(await readFile(parent.ledgerPath(), 'utf8')).reservations.find(item => item.id === parent.reservationId).status, 'active');
  await parent.release();
  assert.equal(client.listenerCount('notification'), 0);
});

test('strict authority exclusions pause without login or an unmetered retry', async (t) => {
  const { root, baseDirectory } = await quotaWorkspace(t, 'auth-exclusions');
  for (const code of ['401', 'authentication_required', 'approval_denied', 'wrong_workspace', 'billing', 'rate_limit', 'ENOTFOUND']) {
    let reads = 0;
    const client = new MockAccountClient(snapshot());
    const request = client.request.bind(client);
    client.request = async (method, params) => {
      if (method === 'account/rateLimits/read') {
        reads++;
        throw new AppServerRpcError({ code: -32603, message: `body: ${JSON.stringify({ error: { code } })}` }, { method });
      }
      return request(method, params);
    };
    const guard = new QuotaGuard({ cwd: root, baseDirectory, strictBudget: true,
      authRecovery: { normalize: createNativeAuthNormalizer(), recover() { assert.fail('excluded failure triggered login'); } } });
    await assert.rejects(guard.start({ client }), error => error.exitCode === 6);
    assert.equal(reads, 1); assert.equal(guard.reservationId, null);
    assert.equal(client.listenerCount('notification'), 0);
  }
});

test('weekly selection chooses the window closest to 10,080 minutes', () => {
  const selected = selectWeeklyWindow(snapshot({ used: 33 }));
  assert.equal(selected.name, 'secondary');
  assert.equal(selected.usedPercent, 33);
  assert.equal(selected.windowDurationMins, 10_080);
});

test('sparse rate-limit notifications merge without clearing prior values', () => {
  const prior = snapshot({ used: 20, resetsAt: 2_000 });
  const merged = mergeSparseRateLimits(prior, {
    rateLimits: {
      planType: null,
      secondary: { usedPercent: 24, windowDurationMins: null, resetsAt: null },
    },
  });
  assert.equal(merged.secondary.usedPercent, 24);
  assert.equal(merged.secondary.windowDurationMins, 10_080);
  assert.equal(merged.secondary.resetsAt, 2_000);
  assert.equal(merged.primary.usedPercent, 19);
});

test('a reset epoch establishes a new campaign baseline', async (t) => {
  const { root, baseDirectory } = await quotaWorkspace(t, 'reset');
  const first = new QuotaGuard({ cwd: root, baseDirectory });
  assert.equal((await first.status(new MockAccountClient(snapshot({ used: 20, resetsAt: 2_000 })))).baselineUsedPercent, 20);

  const second = new QuotaGuard({ cwd: root, baseDirectory });
  const status = await second.status(new MockAccountClient(snapshot({ used: 5, resetsAt: 3_000 })));
  assert.equal(status.baselineUsedPercent, 5);
  const ledger = JSON.parse(await readFile(second.ledgerPath(), 'utf8'));
  assert.equal(ledger.reset_epoch, 3_000);
  assert.equal(ledger.baseline.used_percent, 5);
  assert.doesNotMatch(await readFile(second.ledgerPath(), 'utf8'), /person@example\.test/u);
  assert.match(deriveAccountHash(ACCOUNT), /^[a-f0-9]{64}$/u);
});

test('two concurrent processes reserve atomically without oversubscription', async (t) => {
  const { root, baseDirectory } = await quotaWorkspace(t, 'concurrent');
  const guards = [101, 202].map((pid) => new QuotaGuard({
    cwd: root,
    baseDirectory,
    pid,
    weeklyDeltaCap: 9,
    goalReservation: 2.25,
    isProcessAlive: () => true,
  }));
  const states = await Promise.all(guards.map((guard, index) => guard.start({
    client: new MockAccountClient(snapshot()),
    goalId: `goal-${index}`,
  })));
  assert.equal(Math.max(...states.map((state) => state.activeReservations)), 4.5);
  const ledger = JSON.parse(await readFile(guards[0].ledgerPath(), 'utf8'));
  assert.equal(ledger.reservations.filter(({ status }) => status === 'active').length, 2);
  await Promise.all(guards.map((guard) => guard.release()));
});

test('dead old-process reservations are marked stale before a new reservation', async (t) => {
  const { root, baseDirectory } = await quotaWorkspace(t, 'stale');
  const oldGuard = new QuotaGuard({
    cwd: root,
    baseDirectory,
    pid: 111,
    now: () => new Date('2026-08-20T00:00:00.000Z'),
    staleReservationMs: 1_000,
  });
  await oldGuard.start({ client: new MockAccountClient(snapshot()), goalId: 'old-goal' });

  const newGuard = new QuotaGuard({
    cwd: root,
    baseDirectory,
    pid: 222,
    now: () => new Date('2026-08-20T01:00:00.000Z'),
    staleReservationMs: 1_000,
    isProcessAlive: () => false,
  });
  const status = await newGuard.start({ client: new MockAccountClient(snapshot()), goalId: 'new-goal' });
  assert.equal(status.activeReservations, 2.25);
  const ledger = JSON.parse(await readFile(newGuard.ledgerPath(), 'utf8'));
  assert.deepEqual(ledger.reservations.map(({ status: value }) => value), ['stale', 'active']);
  await newGuard.release();
});

test('the guard pauses before the cap and writes a resumable report', async (t) => {
  const { root, baseDirectory } = await quotaWorkspace(t, 'pause');
  const client = new MockAccountClient([
    snapshot({ used: 20 }),
    snapshot({ used: 26 }),
  ]);
  const guard = new QuotaGuard({
    cwd: root,
    baseDirectory,
    weeklyDeltaCap: 9,
    goalReservation: 2.25,
    resumeCommand: 'cruise goal --strict-budget "resume me"',
  });
  await guard.start({ client, goalId: 'goal-pause' });
  await assert.rejects(() => guard.check(), (error) => {
    assert.ok(error instanceof BudgetPauseError);
    assert.equal(error.code, 'CRUISE_BUDGET_PAUSE');
    assert.equal(error.exitCode, 6);
    return true;
  });
  const report = JSON.parse(await readFile(join(root, '.cruise', 'BUDGET-PAUSE.json'), 'utf8'));
  assert.equal(report.status, 'budget-paused');
  assert.equal(report.resume_command, 'cruise goal --strict-budget "resume me"');
  assert.equal(report.observed_delta_percent, 6);
  await guard.release();
});

test('strict mode refuses an unmetered Goal', async (t) => {
  const { root, baseDirectory } = await quotaWorkspace(t, 'strict');
  const guard = new QuotaGuard({ cwd: root, baseDirectory, strictBudget: true });
  await assert.rejects(
    () => guard.start({ client: new MockAccountClient({}), goalId: 'strict-goal' }),
    (error) => error.code === 'CRUISE_BUDGET_PAUSE',
  );
  const report = JSON.parse(await readFile(join(root, '.cruise', 'BUDGET-PAUSE.json'), 'utf8'));
  assert.match(report.reason, /weekly rate-limit window is unavailable/u);
});

test('strict authority failures preserve pause containment and qualify routing guidance narrowly', async (t) => {
  for (const method of ['account/read', 'account/rateLimits/read']) {
    for (const message of ['workspace routing discovery failed',
      'workspace routing discovery failed: authentication required',
      'workspace routing discovery failed: invalid configuration']) {
      await t.test(`${method}: ${message}`, async (t) => {
        const { root, baseDirectory } = await quotaWorkspace(t, 'routing');
        const guard = new QuotaGuard({ cwd: root, baseDirectory, strictBudget: true });
        const client = new MockAccountClient(snapshot());
        const request = client.request.bind(client);
        client.request = async (name, params) => {
          if (name === method) {
            client.calls.push({ method: name, params });
            throw Object.assign(new Error(message), { code: -32603 });
          }
          return request(name, params);
        };
        await assert.rejects(guard.start({ client }), (error) => {
          assert.ok(error instanceof BudgetPauseError);
          assert.equal(error.exitCode, 6);
          assert.match(error.message, /weekly quota authority unavailable/u);
          if (message === 'workspace routing discovery failed') {
            assert.match(error.message, /account-routing.*authenticated account\/backend connectivity/u);
          } else assert.doesNotMatch(error.message, /mDNSResponder/u);
          return true;
        });
        assert.deepEqual(client.calls.map(call => call.method), ['account/read', 'account/rateLimits/read']);
        await assert.rejects(lstat(baseDirectory), { code: 'ENOENT' });
        await guard.release();
        assert.equal(client.listenerCount('notification'), 0);
      });
    }
  }
});
