#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { estimateCredits } from './lib/usage-meter.mjs';

const DEFAULT_FIXTURE = resolve(import.meta.dirname, '../benchmark/mock-transcripts.json');
const MAX_ITEM_TOKENS = 10_000;
const REVIEW_ITEM_TOKENS = 1_000;

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function boundedPercent(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${label} must be ${nullable ? 'null or ' : ''}a number from 0 through 100`);
  }
  return value;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function usageTotals(entries) {
  const totals = {
    input_tokens: 0,
    cached_input_tokens: 0,
    uncached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    estimated_credits: 0,
  };
  for (const entry of entries) {
    if (typeof entry.model !== 'string' || !entry.model.trim()) throw new Error('usage model is required');
    for (const field of [
      'input_tokens',
      'cached_input_tokens',
      'output_tokens',
      'reasoning_output_tokens',
    ]) nonnegativeInteger(entry[field], `${entry.model}.${field}`);
    const tokens = {
      inputTokens: entry.input_tokens,
      cachedInputTokens: entry.cached_input_tokens,
      outputTokens: entry.output_tokens,
      reasoningOutputTokens: entry.reasoning_output_tokens,
      totalTokens: entry.input_tokens + entry.output_tokens,
    };
    if (
      tokens.cachedInputTokens > tokens.inputTokens ||
      tokens.reasoningOutputTokens > tokens.outputTokens
    ) throw new Error(`invalid token transcript for ${entry.model}`);
    const credits = estimateCredits(tokens, entry.model);
    if (credits === null) throw new Error(`unknown benchmark model ${entry.model}`);
    totals.input_tokens += tokens.inputTokens;
    totals.cached_input_tokens += tokens.cachedInputTokens;
    totals.uncached_input_tokens += tokens.inputTokens - tokens.cachedInputTokens;
    totals.output_tokens += tokens.outputTokens;
    totals.reasoning_output_tokens += tokens.reasoningOutputTokens;
    totals.estimated_credits += credits;
  }
  return totals;
}

function normalizedRun(run) {
  if (!run || typeof run !== 'object' || !Array.isArray(run.usage) || run.usage.length === 0) {
    throw new Error('each benchmark run requires usage transcripts');
  }
  for (const field of ['id', 'task_id', 'root_model', 'worker_model']) {
    if (typeof run[field] !== 'string' || !run[field].trim()) throw new Error(`${field} is required`);
  }
  if (!['baseline', 'optimized'].includes(run.variant)) throw new Error(`${run.id}.variant is invalid`);
  if (!Number.isSafeInteger(run.level) || run.level < 1 || run.level > 5) {
    throw new Error(`${run.id}.level must be an integer from 1 through 5`);
  }
  for (const field of [
    'command_raw_bytes',
    'command_visible_bytes',
    'unique_files_read',
    'repeated_file_reads',
    'full_file_reads_above_64kb',
    'compactions',
    'worker_count',
    'invariant_failures',
    'largest_injected_item_tokens',
    'item_cap_tokens',
    'full_suite_runs',
  ]) nonnegativeInteger(run[field], `${run.id}.${field}`);
  boundedPercent(run.rate_limit_used_percent_before, `${run.id}.rate_limit_used_percent_before`, { nullable: true });
  boundedPercent(run.rate_limit_used_percent_after, `${run.id}.rate_limit_used_percent_after`, { nullable: true });
  boundedPercent(run.goal_reservation_percent, `${run.id}.goal_reservation_percent`);
  for (const field of ['filtering_applies', 'diff_correctness', 'large_item_reviewed']) {
    if (typeof run[field] !== 'boolean') throw new Error(`${run.id}.${field} must be boolean`);
  }
  if (run.filtering_applies && run.command_raw_bytes === 0) {
    throw new Error(`${run.id}.command_raw_bytes must be positive when filtering applies`);
  }
  const totals = usageTotals(run.usage);
  if (!(totals.estimated_credits > 0)) throw new Error(`${run.id} must have positive estimated credits`);
  return Object.freeze({ ...run, ...totals });
}

function correctnessFailures(run) {
  const failures = [];
  if (run.focused_test_outcome !== 'pass') failures.push('focused test failed');
  if (run.final_test_outcome !== 'pass') failures.push('final test failed');
  if (run.diff_correctness !== true) failures.push('diff correctness failed');
  if (run.invariant_failures !== 0) failures.push('protected invariant failed');
  if (run.full_suite_runs > 1) failures.push('full suite ran more than once');
  if (run.command_visible_bytes > run.command_raw_bytes) failures.push('visible command output exceeds raw output');
  if (run.variant === 'optimized' && run.full_file_reads_above_64kb !== 0) {
    failures.push('full file above 64 KB was read');
  }
  if (run.variant === 'optimized' && run.filtering_applies && run.command_visible_bytes / run.command_raw_bytes > 0.2) {
    failures.push('filtered command output exceeds 20 percent of raw bytes');
  }
  if (run.largest_injected_item_tokens > MAX_ITEM_TOKENS) failures.push('model-visible item exceeds 10000 tokens');
  if (
    run.largest_injected_item_tokens > REVIEW_ITEM_TOKENS &&
    (run.large_item_reviewed !== true || run.item_cap_tokens > MAX_ITEM_TOKENS)
  ) failures.push('potential item above 1000 tokens lacks review and cap');
  return failures;
}

export function evaluateMockBenchmark(fixture) {
  if (fixture?.schema_version !== 1 || !Array.isArray(fixture.runs)) {
    throw new Error('mock benchmark fixture must use schema_version 1 and runs');
  }
  const runs = fixture.runs.map(normalizedRun);
  const pairs = new Map();
  for (const run of runs) {
    const pair = pairs.get(run.task_id) ?? {};
    if (pair[run.variant]) throw new Error(`duplicate ${run.variant} run for ${run.task_id}`);
    pair[run.variant] = run;
    pairs.set(run.task_id, pair);
  }
  const comparisons = [];
  for (const [taskId, pair] of pairs) {
    if (!pair.baseline || !pair.optimized) throw new Error(`task ${taskId} needs baseline and optimized runs`);
    comparisons.push(Object.freeze({
      task_id: taskId,
      level: pair.optimized.level,
      baseline_credits: pair.baseline.estimated_credits,
      optimized_credits: pair.optimized.estimated_credits,
      credit_ratio: pair.optimized.estimated_credits / pair.baseline.estimated_credits,
    }));
  }
  const l1l4 = median(comparisons.filter(({ level }) => level <= 4).map(({ credit_ratio }) => credit_ratio));
  const l5 = median(comparisons.filter(({ level }) => level === 5).map(({ credit_ratio }) => credit_ratio));
  const runFailures = runs.flatMap((run) => correctnessFailures(run).map((failure) => `${run.id}: ${failure}`));
  const optimized = runs.filter(({ variant }) => variant === 'optimized');
  const campaignReservations = optimized.slice(0, 4);
  const reservationTotal = campaignReservations.reduce((sum, run) => sum + run.goal_reservation_percent, 0);
  const reservationShapePass = campaignReservations.length === 4 &&
    campaignReservations.every(({ goal_reservation_percent: value }) => value === 2.25);
  const acceptance = Object.freeze({
    l1_l4_median_ratio: l1l4,
    l1_l4_pass: l1l4 !== null && l1l4 <= 0.2,
    l5_median_ratio: l5,
    l5_pass: l5 !== null && l5 <= 0.33,
    correctness_pass: runFailures.length === 0,
    four_goal_reservations_percent: reservationTotal,
    campaign_cap_pass: reservationShapePass && reservationTotal === 9,
  });
  const failures = [
    ...runFailures,
    ...(!acceptance.l1_l4_pass ? ['L1-L4 median credit ratio exceeds 0.20'] : []),
    ...(!acceptance.l5_pass ? ['L5 median credit ratio exceeds 0.33'] : []),
    ...(optimized.length < 4 ? ['benchmark needs four optimized Goal reservations'] : []),
    ...(!acceptance.campaign_cap_pass
      ? ['four Goal reservations must be 2.25 points each and total the 9-point campaign cap']
      : []),
  ];
  return Object.freeze({
    schema_version: 1,
    mode: 'deterministic-mock',
    model_calls: 0,
    runs,
    comparisons,
    acceptance,
    failures,
    pass: failures.length === 0,
  });
}

export async function runMockBenchmark(path = DEFAULT_FIXTURE) {
  return evaluateMockBenchmark(JSON.parse(await readFile(path, 'utf8')));
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  runMockBenchmark(process.argv[2] ? resolve(process.argv[2]) : DEFAULT_FIXTURE)
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report)}\n`);
      process.exitCode = report.pass ? 0 : 1;
    })
    .catch((error) => {
      process.stderr.write(`mock-benchmark: ${String(error?.message ?? error)}\n`);
      process.exitCode = 1;
    });
}
