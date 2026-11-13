import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  estimateCredits,
  usageModelFamily,
  UsageMeter,
  USAGE_RATE_VERSION,
} from '../scripts/lib/usage-meter.mjs';

function breakdown({ input, cached = 0, output, reasoning = 0 }) {
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    reasoningOutputTokens: reasoning,
    totalTokens: input + output,
  };
}

function notification({ threadId = 'thread-1', turnId = 'turn-1', total, last = total, window = 200_000 }) {
  return {
    threadId,
    turnId,
    tokenUsage: { total, last, modelContextWindow: window },
  };
}

test('cumulative usage adds only positive high-watermark deltas', () => {
  const meter = new UsageMeter();
  const first = breakdown({ input: 1_000, cached: 200, output: 300, reasoning: 100 });
  assert.equal(meter.consume(notification({ total: first }), { model: 'gpt-5.6-sol' }).accepted, true);
  assert.equal(meter.consume(notification({ total: first }), { model: 'gpt-5.6-sol' }).accepted, false);

  const lower = breakdown({ input: 900, cached: 100, output: 250, reasoning: 80 });
  const replay = meter.consume(notification({ total: lower }), { model: 'gpt-5.6-sol' });
  assert.equal(replay.accepted, false);
  assert.deepEqual(meter.thread('thread-1').highWatermarks, first);
  assert.equal(meter.thread('thread-1').acceptedSnapshots, 1);
});

test('cached input and reasoning subsets are priced exactly once', () => {
  const tokens = breakdown({
    input: 1_000_000,
    cached: 250_000,
    output: 500_000,
    reasoning: 400_000,
  });
  assert.equal(estimateCredits(tokens, 'gpt-5.6-sol'), 471.875);
  assert.equal(estimateCredits(tokens, 'gpt-5.6-terra'), 188.75);
  assert.equal(estimateCredits(tokens, 'gpt-5.6-luna'), 18.875);

  const meter = new UsageMeter();
  meter.consume(notification({ total: tokens }), { model: 'gpt-5.6-sol' });
  const summary = meter.summary();
  assert.equal(summary.rate_version, USAGE_RATE_VERSION);
  assert.equal(summary.estimated_credits, 471.875);
  assert.equal(summary.totals.output_tokens, 500_000);
  assert.equal(summary.threads['thread-1'].last.reasoning_output_tokens, 400_000);
});

test('Astra is recognized but has no speculative credit estimate', () => {
  const tokens = breakdown({ input: 1_000_000, cached: 250_000, output: 500_000 });
  assert.equal(usageModelFamily('gpt-6-astra'), 'astra');
  assert.equal(estimateCredits(tokens, 'gpt-6-astra'), null);
});

test('invalid invariants preserve raw evidence and make local accounting unknown', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-usage-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const meter = new UsageMeter({ now: () => new Date('2026-08-20T00:00:00.000Z') });
  const invalid = breakdown({ input: 10, cached: 0, output: 4, reasoning: 0 });
  invalid.cachedInputTokens = 11;
  const params = notification({ total: invalid });
  const result = meter.consume(params, { model: 'gpt-5.6-sol' });
  assert.equal(result.accepted, false);
  assert.equal(result.accountingKnown, false);
  assert.deepEqual(meter.thread('thread-1').highWatermarks, breakdown({ input: 0, output: 0 }));

  await meter.persist(root);
  const summary = JSON.parse(await readFile(join(root, '.cruise', 'USAGE.json'), 'utf8'));
  assert.equal(summary.accounting_known, false);
  assert.equal(summary.estimated_credits, null);
  assert.equal(summary.totals.total_tokens, 0);
  const [{ path }] = summary.threads['thread-1'].invalid_evidence;
  assert.deepEqual(JSON.parse(await readFile(join(root, path), 'utf8')), params);
});
