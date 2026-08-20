import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  evaluateMockBenchmark,
  runMockBenchmark,
} from '../scripts/mock-efficiency-benchmark.mjs';

const FIXTURE = resolve(import.meta.dirname, '../benchmark/mock-transcripts.json');

async function fixture() {
  return JSON.parse(await readFile(FIXTURE, 'utf8'));
}

test('deterministic mock benchmark passes every efficiency and correctness gate without model calls', async () => {
  const report = await runMockBenchmark(FIXTURE);
  assert.equal(report.pass, true, report.failures.join('\n'));
  assert.equal(report.mode, 'deterministic-mock');
  assert.equal(report.model_calls, 0);
  assert.ok(report.acceptance.l1_l4_median_ratio <= 0.2);
  assert.ok(report.acceptance.l5_median_ratio <= 0.33);
  assert.equal(report.acceptance.correctness_pass, true);
  assert.equal(report.acceptance.four_goal_reservations_percent, 9);
  assert.equal(report.acceptance.campaign_cap_pass, true);
  for (const run of report.runs) {
    assert.equal(run.uncached_input_tokens, run.input_tokens - run.cached_input_tokens);
    assert.ok(Number.isFinite(run.estimated_credits));
    assert.equal(typeof run.root_model, 'string');
    assert.equal(typeof run.worker_model, 'string');
  }
});

test('benchmark rejects correctness loss even when optimized credits are lower', async () => {
  const input = await fixture();
  input.runs.find(({ id }) => id === 'T2-optimized').diff_correctness = false;
  const report = evaluateMockBenchmark(input);
  assert.equal(report.pass, false);
  assert.match(report.failures.join('\n'), /T2-optimized: diff correctness failed/u);
});

test('benchmark rejects uncapped large context items and campaign over-reservation', async () => {
  const input = await fixture();
  const run = input.runs.find(({ id }) => id === 'T3-optimized');
  run.largest_injected_item_tokens = 1_500;
  run.large_item_reviewed = false;
  input.runs.filter(({ variant }) => variant === 'optimized').slice(0, 4)
    .forEach((item) => { item.goal_reservation_percent = 2.5; });
  const report = evaluateMockBenchmark(input);
  assert.equal(report.pass, false);
  assert.match(report.failures.join('\n'), /lacks review and cap/u);
  assert.match(report.failures.join('\n'), /9-point campaign cap/u);
});

test('benchmark rejects a credit regression above the level threshold', async () => {
  const input = await fixture();
  for (const run of input.runs.filter(({ variant, level }) => variant === 'optimized' && level <= 4)) {
    run.usage = input.runs.find(({ task_id, variant }) => task_id === run.task_id && variant === 'baseline').usage;
  }
  const report = evaluateMockBenchmark(input);
  assert.equal(report.pass, false);
  assert.match(report.failures.join('\n'), /L1-L4 median credit ratio exceeds/u);
});

test('benchmark rejects impossible token and reservation telemetry', async () => {
  const negative = await fixture();
  negative.runs.find(({ id }) => id === 'T1-optimized').usage[0].input_tokens = -1;
  assert.throws(() => evaluateMockBenchmark(negative), /non-negative integer/u);

  const invalidReservation = await fixture();
  invalidReservation.runs.find(({ id }) => id === 'T1-optimized').goal_reservation_percent = '2.25';
  assert.throws(() => evaluateMockBenchmark(invalidReservation), /number from 0 through 100/u);

  const vacuousReservation = await fixture();
  vacuousReservation.runs.filter(({ variant }) => variant === 'optimized').slice(0, 4)
    .forEach((run) => { run.goal_reservation_percent = 0; });
  const report = evaluateMockBenchmark(vacuousReservation);
  assert.equal(report.pass, false);
  assert.match(report.failures.join('\n'), /2\.25 points each/u);
});
