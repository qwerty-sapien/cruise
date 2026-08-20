import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  parseArgs,
  runBudget,
  runUsage,
  runWorker,
} from '../scripts/cruise.mjs';

test('budget CLI and environment overrides are validated', () => {
  const budget = parseArgs([
    'budget',
    '--json',
    '--strict-budget',
    '--weekly-delta-cap',
    '8.5',
    '--goal-reservation',
    '2',
  ], { env: {} });
  assert.equal(budget.command, 'budget');
  assert.equal(budget.json, true);
  assert.equal(budget.strictBudget, true);
  assert.equal(budget.weeklyDeltaCap, 8.5);
  assert.equal(budget.goalReservation, 2);

  const fromEnvironment = parseArgs(['usage', '--json'], {
    env: {
      CRUISE_WEEKLY_DELTA_CAP_PERCENT: '7',
      CRUISE_GOAL_RESERVATION_PERCENT: '1.5',
      CRUISE_STRICT_BUDGET: 'true',
    },
  });
  assert.equal(fromEnvironment.weeklyDeltaCap, 7);
  assert.equal(fromEnvironment.goalReservation, 1.5);
  assert.equal(fromEnvironment.strictBudget, true);
  assert.throws(() => parseArgs(['budget', '--weekly-delta-cap'], { env: {} }), /requires a percent/u);
  assert.throws(
    () => parseArgs(['budget', '--weekly-delta-cap', '2', '--goal-reservation', '3'], { env: {} }),
    /cannot exceed/u,
  );
});

test('usage reports an absent local meter without contacting a model', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-usage-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let output = '';
  assert.equal(await runUsage({ cwd: root, json: true }, {
    output: { write(value) { output += value; } },
  }), 0);
  const report = JSON.parse(output);
  assert.equal(report.accounting_known, false);
  assert.equal(report.observed_threads, 0);
});

test('budget output is sanitized and uses only the mock account transcript', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-budget-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  let output = '';
  const client = {
    async start() { calls.push('client:start'); },
    async stop() { calls.push('client:stop'); },
  };
  assert.equal(await runBudget({
    cwd: root,
    json: true,
    weeklyDeltaCap: 9,
    goalReservation: 2.25,
    strictBudget: true,
  }, {
    clientFactory: () => client,
    quotaGuardFactory: () => ({
      async status(activeClient) {
        assert.equal(activeClient, client);
        calls.push('guard:status');
        return {
          metered: true,
          usedPercent: 30,
          baselineUsedPercent: 28,
          observedDelta: 2,
          activeReservations: 2.25,
          resetsAt: 9_999,
          remaining: 3.75,
        };
      },
    }),
    output: { write(value) { output += value; } },
  }), 0);
  assert.deepEqual(calls, ['client:start', 'guard:status', 'client:stop']);
  assert.doesNotMatch(output, /person@example|account_hash/iu);
  assert.equal(JSON.parse(output).observed_delta_percent, 2);
});

test('worker reservation completes before the mock worker is spawned', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-budget-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const order = [];
  const budgetClient = {
    async start() { order.push('client:start'); },
    async stop() { order.push('client:stop'); },
  };
  const guard = {
    async start({ client }) {
      assert.equal(client, budgetClient);
      order.push('guard:start');
    },
    async release() { order.push('guard:release'); },
  };
  assert.equal(await runWorker({
    cwd: root,
    provider: 'codex',
    prompt: 'bounded mock task',
    level: 2,
    weeklyDeltaCap: 9,
    goalReservation: 2.25,
    strictBudget: true,
  }, {
    worker: async () => {
      order.push('worker:start');
      return { output: '' };
    },
    enforceBudget: true,
    budgetClientFactory: () => budgetClient,
    quotaGuardFactory: () => guard,
  }), 0);
  assert.deepEqual(order, [
    'client:start',
    'guard:start',
    'worker:start',
    'guard:release',
    'client:stop',
  ]);
});

test('managed worker writes a bounded capsule before quota and persists its compact handoff', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-managed-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parsed = parseArgs([
    'worker',
    '--managed',
    '--level',
    '2',
    '--read-only',
    '--owns',
    'src/payment.mjs',
    '--evidence',
    'the focused replay test fails',
    '--range',
    'src/payment.mjs:1-80',
    '--verify',
    'node --test tests/payment.test.mjs',
    'repair',
    'payment',
    'idempotency',
  ], { env: {} });
  assert.equal(parsed.managedWorker, true);
  const order = [];
  const handoff = {
    outcome: 'Repair payment idempotency.',
    completed_work: ['Mock bounded edit completed.'],
    changed_files: ['src/payment.mjs'],
    decisions_and_invariants: ['Replay protection remains intact.'],
    exact_tests: ['node --test tests/payment.test.mjs'],
    active_blocker_or_next_work_item: 'Root integrates the diff.',
    files_not_to_reread: ['src/constants.mjs'],
    evidence_pointers: ['.cruise/artifacts/payment-focused.log'],
    usage_and_quota_summary: 'Mock quota reservation is released.',
  };
  const budgetClient = {
    async start() { order.push('client:start'); },
    async stop() { order.push('client:stop'); },
  };
  const guard = {
    async start() { order.push('guard:start'); },
    async release() { order.push('guard:release'); },
  };
  assert.equal(await runWorker({
    ...parsed,
    cwd: root,
    weeklyDeltaCap: 9,
    goalReservation: 2.25,
    strictBudget: true,
  }, {
    worker: async ({ task, level, readOnly }) => {
      order.push('worker:start');
      assert.equal(level, 5);
      assert.equal(readOnly, true);
      assert.match(task, /cruise_bounded_context_capsule/u);
      assert.match(task, /src\/payment\.mjs:1-80/u);
      return { output: JSON.stringify(handoff) };
    },
    enforceBudget: true,
    budgetClientFactory: () => budgetClient,
    quotaGuardFactory: () => guard,
    dispatchLedgerFactory: () => ({
      async reserve() {
        order.push('dispatch:start');
        return { async release() { order.push('dispatch:release'); } };
      },
    }),
  }), 0);
  assert.deepEqual(order, [
    'dispatch:start',
    'client:start',
    'guard:start',
    'worker:start',
    'guard:release',
    'dispatch:release',
    'client:stop',
  ]);
  const persisted = await readFile(join(root, '.cruise', 'HANDOFF.md'), 'utf8');
  for (const label of ['Compact handoff', 'Next work item', 'Quota state', 'Unresolved assurance']) {
    assert.match(persisted, new RegExp(label, 'u'));
  }
  assert.doesNotMatch(persisted, /Repair payment idempotency/u);
  assert.ok(Buffer.byteLength(persisted) <= 4 * 1024);
});

test('worker cleanup surfaces a quota reservation release failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-worker-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(runWorker({
    cwd: root,
    provider: 'codex',
    prompt: 'bounded mock task',
    level: 2,
    weeklyDeltaCap: 9,
    goalReservation: 2.25,
    strictBudget: true,
  }, {
    worker: async () => ({ output: '' }),
    enforceBudget: true,
    budgetClientFactory: () => ({ async start() {}, async stop() {} }),
    quotaGuardFactory: () => ({
      async start() {},
      async release() { throw new Error('ledger write failed'); },
    }),
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /managed worker cleanup failed/u);
    assert.match(error.errors[0].message, /quota reservation release failed/u);
    return true;
  });
});
