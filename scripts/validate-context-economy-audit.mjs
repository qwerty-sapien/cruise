#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMockBenchmark } from './mock-efficiency-benchmark.mjs';

const REQUIRED_INDEX_PATHS = Object.freeze([
  'AUDIT.md',
  'audit-manifest.json',
  'benchmark/BENCHMARK_PLAN.md',
  'skills/context-economy/SKILL.md',
  'skills/context-economy/templates/HANDOFF.template.md',
  'skills/context-economy/templates/cell_tracking-CURRENT.template.md',
  'skills/context-economy/templates/check-in-CURRENT.template.md',
]);

export function validateManifestTargets(manifest) {
  const targets = manifest?.targets ?? {};
  return Object.freeze([
    ['L1-L4 median target is 0.20', targets.l1_l4_median_credit_ratio_max === 0.2],
    ['L5 median target is 0.33', targets.l5_median_credit_ratio_max === 0.33],
    ['campaign cap is 9 points', targets.campaign_weekly_delta_cap_percent === 9],
    ['Goal reservation is 2.25 points', targets.goal_reservation_percent === 2.25],
  ]);
}

export async function validateContextEconomyAudit(root = resolve(import.meta.dirname, '..')) {
  const [audit, manifest, index, skill, benchmark] = await Promise.all([
    readFile(resolve(root, 'AUDIT.md'), 'utf8'),
    readFile(resolve(root, 'audit-manifest.json'), 'utf8').then(JSON.parse),
    readFile(resolve(root, 'FILE_INDEX.json'), 'utf8').then(JSON.parse),
    readFile(resolve(root, 'skills/context-economy/SKILL.md'), 'utf8'),
    runMockBenchmark(resolve(root, 'benchmark/mock-transcripts.json')),
  ]);
  const indexed = new Set(index.map(({ path }) => path));
  const checks = [
    ...validateManifestTargets(manifest),
    ['audit identifies assurance invalidation churn', /Assurance work is repeatedly invalidated/u.test(audit)],
    ['audit identifies bounded debug expansion', /Debug can fan out too broadly/u.test(audit)],
    ['context skill enforces the 9-point campaign cap', /campaign_weekly_delta_cap_percent: 9\.0/u.test(skill)],
    ['context skill enforces 2.25-point reservations', /default_goal_reservation_percent: 2\.25/u.test(skill)],
    ['mock benchmark passes', benchmark.pass],
    ...REQUIRED_INDEX_PATHS.map((path) => [`file index contains ${path}`, indexed.has(path)]),
  ];
  for (const path of [
    'skills/context-economy/templates/HANDOFF.template.md',
    'skills/context-economy/templates/cell_tracking-CURRENT.template.md',
    'skills/context-economy/templates/check-in-CURRENT.template.md',
  ]) {
    checks.push([`${path} is at most 4 KB`, (await stat(resolve(root, path))).size <= 4 * 1024]);
  }
  const failures = checks.filter(([, pass]) => !pass).map(([name]) => name);
  return Object.freeze({
    schema_version: 1,
    checks: checks.map(([name, pass]) => ({ name, pass })),
    benchmark_acceptance: benchmark.acceptance,
    failures,
    pass: failures.length === 0,
  });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  validateContextEconomyAudit(process.argv[2] ? resolve(process.argv[2]) : undefined)
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report)}\n`);
      process.exitCode = report.pass ? 0 : 1;
    })
    .catch((error) => {
      process.stderr.write(`context-economy-audit: ${String(error?.message ?? error)}\n`);
      process.exitCode = 1;
    });
}
