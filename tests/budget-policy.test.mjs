import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { QuotaGuard } from '../scripts/lib/quota-guard.mjs';

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'cruise-budget-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, baseDirectory: join(root, 'quota'), policy: join(root, 'budget-policy.json') };
}

test('explicit persistent opt-out skips only campaign authority, reservations and checks even in strict mode', async (t) => {
  const { root, baseDirectory, policy } = await workspace(t);
  await writeFile(policy, JSON.stringify({ schema_version: 1, campaign_budget_enabled: false }));
  const client = { request() { throw new Error('campaign authority must not be queried'); } };
  const guard = new QuotaGuard({ cwd: root, baseDirectory, strictBudget: true });
  for (const result of [await guard.start({ client }), await guard.check(), await guard.status(client)]) {
    assert.equal(result.campaignBudgetEnabled, false);
    assert.equal(result.metered, false);
    assert.match(result.reason, /provider limits still apply/);
  }
  assert.equal(guard.reservationId, null);
  await guard.release();
  await assert.rejects(access(baseDirectory), { code: 'ENOENT' });
  await assert.rejects(access(join(root, '.cruise', 'BUDGET-PAUSE.json')), { code: 'ENOENT' });
});

test('absent policy and explicit enable preserve ordinary strict enforcement', async (t) => {
  const { root, baseDirectory, policy } = await workspace(t);
  const client = { async request() { throw new Error('provider unavailable'); } };
  const absent = new QuotaGuard({ cwd: root, baseDirectory, strictBudget: true });
  await assert.rejects(absent.start({ client }), { code: 'CRUISE_BUDGET_PAUSE' });
  await writeFile(policy, JSON.stringify({ schema_version: 1, campaign_budget_enabled: true }));
  const enabled = new QuotaGuard({ cwd: root, baseDirectory, strictBudget: true });
  await assert.rejects(enabled.start({ client }), { code: 'CRUISE_BUDGET_PAUSE' });
});

test('malformed policy never silently disables containment', async (t) => {
  const { root, baseDirectory, policy } = await workspace(t);
  for (const content of ['{', '{"schema_version":1,"campaign_budget_enabled":"false"}', '{"schema_version":2,"campaign_budget_enabled":false}']) {
    await writeFile(policy, content);
    const guard = new QuotaGuard({ cwd: root, baseDirectory });
    await assert.rejects(guard.start({ client: {} }));
  }
});
