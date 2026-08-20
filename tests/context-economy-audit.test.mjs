import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  validateContextEconomyAudit,
  validateManifestTargets,
} from '../scripts/validate-context-economy-audit.mjs';

test('audit, templates, skill caps, index, and mock benchmark agree', async () => {
  const report = await validateContextEconomyAudit(resolve(import.meta.dirname, '..'));
  assert.equal(report.pass, true, report.failures.join('\n'));
  assert.equal(report.benchmark_acceptance.campaign_cap_pass, true);
  assert.equal(report.benchmark_acceptance.correctness_pass, true);
});

test('audit validation fails closed when a resource target is weakened', () => {
  const checks = validateManifestTargets({
    targets: {
      l1_l4_median_credit_ratio_max: 0.2,
      l5_median_credit_ratio_max: 0.33,
      campaign_weekly_delta_cap_percent: 40,
      goal_reservation_percent: 3.5,
    },
  });
  assert.deepEqual(checks.filter(([, pass]) => !pass).map(([name]) => name), [
    'campaign cap is 9 points',
    'Goal reservation is 2.25 points',
  ]);
});
