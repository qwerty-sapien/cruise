import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CompactionController,
  contextPressureLevel,
  DEFAULT_CONTEXT_THRESHOLDS,
} from '../scripts/lib/compaction-controller.mjs';
import { UsageMeter } from '../scripts/lib/usage-meter.mjs';

function breakdown(input, output = 10) {
  return {
    inputTokens: input,
    cachedInputTokens: 0,
    outputTokens: output,
    reasoningOutputTokens: 0,
    totalTokens: input + output,
  };
}

function usage({ totalInput, lastInput, turnId = 'turn-1', window = 200 }) {
  return {
    threadId: 'thread-1',
    turnId,
    tokenUsage: {
      total: breakdown(totalInput),
      last: breakdown(lastInput),
      modelContextWindow: window,
    },
  };
}

test('context pressure uses the configured warn, compact, and split thresholds', () => {
  assert.equal(contextPressureLevel(0.29), 'normal');
  assert.equal(contextPressureLevel(0.30), 'warn');
  assert.equal(contextPressureLevel(0.45), 'compact');
  assert.equal(contextPressureLevel(0.60), 'split');
  assert.deepEqual(DEFAULT_CONTEXT_THRESHOLDS, {
    warnRatio: 0.30,
    compactRatio: 0.45,
    splitRatio: 0.60,
    minimumRootTurns: 4,
    absoluteInputTokens: 96_000,
  });
});

test('compaction waits for a completed turn and the full contextCompaction item lifecycle', async () => {
  const meter = new UsageMeter();
  meter.consume(usage({ totalInput: 100, lastInput: 100 }), { model: 'gpt-5.6-sol' });
  const events = [];
  let controller;
  const client = {
    async request(method, params) {
      events.push(`request:${method}`);
      assert.deepEqual(params, { threadId: 'thread-1' });
      queueMicrotask(() => {
        controller.handleNotification({
          method: 'item/started',
          params: {
            threadId: 'thread-1',
            turnId: 'compact-turn',
            startedAtMs: 1,
            item: { id: 'compact-item', type: 'contextCompaction' },
          },
        });
        controller.handleNotification({
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'compact-turn',
            completedAtMs: 2,
            item: { id: 'compact-item', type: 'contextCompaction' },
          },
        });
      });
      return {};
    },
  };
  controller = new CompactionController({
    client,
    usageMeter: meter,
    minimumRootTurns: 0,
    refreshHandoff: async () => events.push('handoff'),
    persist: async () => {},
  });

  assert.equal((await controller.afterTurn({ threadId: 'thread-1', activeTurn: true })).action, 'deferred');
  assert.deepEqual(events, []);
  assert.equal((await controller.afterTurn({ threadId: 'thread-1', activeTurn: false })).action, 'compacted');
  assert.deepEqual(events, ['handoff', 'request:thread/compact/start']);
  assert.equal(controller.summary().count, 1);
  assert.equal(controller.summary().latest_outcome.status, 'completed-awaiting-verification');

  assert.equal((await controller.afterTurn({ threadId: 'thread-1' })).reason, 'no new model call');
  assert.equal(controller.summary().attempts, 1);
});

test('the next model call verifies compaction pressure before another attempt', async () => {
  const meter = new UsageMeter();
  meter.consume(usage({ totalInput: 120, lastInput: 120 }), { model: 'gpt-5.6-sol' });
  let controller;
  const client = {
    async request() {
      queueMicrotask(() => {
        controller.handleNotification({
          method: 'item/started',
          params: { threadId: 'thread-1', turnId: 'c1', startedAtMs: 1, item: { id: 'i1', type: 'contextCompaction' } },
        });
        controller.handleNotification({
          method: 'item/completed',
          params: { threadId: 'thread-1', turnId: 'c1', completedAtMs: 2, item: { id: 'i1', type: 'contextCompaction' } },
        });
      });
      return {};
    },
  };
  controller = new CompactionController({
    client,
    usageMeter: meter,
    minimumRootTurns: 0,
    refreshHandoff: async () => {},
  });
  await controller.afterTurn({ threadId: 'thread-1' });

  meter.consume(usage({ totalInput: 140, lastInput: 40, turnId: 'turn-2' }), { model: 'gpt-5.6-sol' });
  controller.observeUsage('thread-1');
  assert.equal(controller.summary().latest_outcome.status, 'verified');
  assert.equal(controller.summary().latest_outcome.pressure_after, 0.2);
  assert.equal(controller.shouldSplitOrPause(), false);
  assert.equal((await controller.afterTurn({ threadId: 'thread-1' })).action, 'none');
});
