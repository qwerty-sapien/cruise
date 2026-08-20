import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SimpleCruiseSession } from '../scripts/lib/simple-session.mjs';

const THREAD_ID = 'thread-context-runtime';

function tokenBreakdown(input, output) {
  return {
    inputTokens: input,
    cachedInputTokens: 0,
    outputTokens: output,
    reasoningOutputTokens: Math.min(output, 10),
    totalTokens: input + output,
  };
}

class UsageClient extends EventEmitter {
  async start() {}
  async stop() {}

  async request(method) {
    if (method === 'thread/start') return { thread: { id: THREAD_ID }, model: 'gpt-5.6-sol' };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        this.emit('notification', {
          method: 'turn/started',
          params: { threadId: THREAD_ID, turn: { id: 'turn-usage', status: 'inProgress' } },
        });
        this.emit('notification', {
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: THREAD_ID,
            turnId: 'turn-usage',
            tokenUsage: {
              total: tokenBreakdown(100, 30),
              last: tokenBreakdown(100, 30),
              modelContextWindow: 1_000,
            },
          },
        });
        this.emit('notification', {
          method: 'turn/completed',
          params: { threadId: THREAD_ID, turn: { id: 'turn-usage', status: 'completed' } },
        });
      });
      return { turn: { id: 'turn-usage' } };
    }
    throw new Error(`unexpected request: ${method}`);
  }
}

function newSession({ client, cwd, prompt = 'Preserve the exact requested outcome.' }) {
  return new SimpleCruiseSession({
    client,
    cwd,
    prompt,
    skill: 'quick',
    skillPath: '/tmp/quick-skill.md',
    pickOne: async () => ({ status: 'cancelled' }),
    readLine: async () => '',
    output: { write() {} },
    errorOutput: { write() {} },
    locateTrace: async () => null,
    clock: () => new Date('2026-08-20T00:00:00.000Z'),
  });
}

test('token notifications persist usage fields without replacing legacy LAST-RUN fields', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-context-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = newSession({ client: new UsageClient(), cwd: root });
  assert.equal((await session.run()).status, 'complete');

  const pointer = JSON.parse(await readFile(join(root, '.cruise', 'LAST-RUN.json'), 'utf8'));
  assert.equal(pointer.thread_id, THREAD_ID);
  assert.equal(pointer.cwd, root);
  assert.equal(pointer.skill, 'quick');
  assert.equal(pointer.final_status, 'complete');
  assert.equal(pointer.usage.accounting_known, true);
  assert.equal(pointer.usage.totals.total_tokens, 130);
  assert.equal(pointer.compaction.count, 0);

  const usage = JSON.parse(await readFile(join(root, '.cruise', 'USAGE.json'), 'utf8'));
  assert.equal(usage.observed_threads, 1);
  assert.equal(usage.threads[THREAD_ID].context_pressure, 0.1);
  assert.equal(usage.estimated_credits, 0.035);
});

test('contextCompaction items are not implementation progress or stall observations', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-context-item-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = newSession({ client: new UsageClient(), cwd: root });
  session.threadId = THREAD_ID;
  session.handleNotification({
    method: 'item/started',
    params: { threadId: THREAD_ID, turnId: 'compact', startedAtMs: 1, item: { id: 'item', type: 'contextCompaction' } },
  });
  session.handleNotification({
    method: 'item/completed',
    params: { threadId: THREAD_ID, turnId: 'compact', completedAtMs: 2, item: { id: 'item', type: 'contextCompaction' } },
  });
  assert.equal(session.supervisor.summary().turnsObserved, 0);
  assert.equal(session.turnAgentText, '');
});

test('the pre-compaction handoff retains compact task state without restating the request', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-context-handoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prompt = 'Keep the quota guard and all assurance gates intact while continuing phase two.';
  const session = newSession({ client: new UsageClient(), cwd: root, prompt });
  session.threadId = THREAD_ID;
  session.goal = { status: 'active', objective: prompt };
  session.readPlan = async () => ({
    state: 'valid',
    plan: {
      version: 2,
      quality: { gates: [{ id: 'core.functional', state: 'pending' }] },
    },
  });
  await session.refreshCompactionHandoff();
  const initial = await readFile(join(root, '.cruise', 'HANDOFF.md'), 'utf8');
  assert.match(initial, /Next work item: Close Flight gate core\.functional/u);
  await writeFile(join(root, '.cruise', 'HANDOFF.md'), [
    '# Cruise continuation',
    '',
    '- Compact handoff: completed quota guard implementation; preserve assurance gates',
    '- Next work item: continue phase two focused validation',
    '- Quota state: reservation remains within 2.25 points',
    '- Unresolved assurance: core.regression',
    '',
  ].join('\n'), 'utf8');
  await session.refreshCompactionHandoff();
  const handoff = await readFile(join(root, '.cruise', 'HANDOFF.md'), 'utf8');
  assert.match(handoff, /completed quota guard implementation; preserve assurance gates/u);
  assert.match(handoff, /continue phase two focused validation/u);
  assert.match(handoff, /Quota state: accounting known/u);
  assert.match(handoff, /Unresolved assurance: core\.functional/u);
  assert.doesNotMatch(handoff, new RegExp(prompt, 'u'));
  assert.doesNotMatch(handoff, /Request source of truth|full Flight|prior plan/u);
  assert.ok(Buffer.byteLength(handoff) <= 4 * 1_024);
});

test('quota reservation precedes session start and continuation checks are explicit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-context-quota-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const order = [];
  class OrderedClient extends UsageClient {
    async request(method, params) {
      if (method === 'thread/start') order.push('thread:start');
      return super.request(method, params);
    }
  }
  const quotaGuard = {
    async start() { order.push('quota:start'); },
    async check() { order.push('quota:check'); },
    async release() { order.push('quota:release'); },
  };
  const session = new SimpleCruiseSession({
    client: new OrderedClient(),
    cwd: root,
    prompt: 'Keep the mock bounded.',
    skill: 'quick',
    skillPath: '/tmp/quick-skill.md',
    pickOne: async () => ({ status: 'cancelled' }),
    readLine: async () => '',
    output: { write() {} },
    errorOutput: { write() {} },
    locateTrace: async () => null,
    quotaGuard,
  });
  assert.equal((await session.run()).status, 'complete');
  assert.ok(order.indexOf('quota:start') < order.indexOf('thread:start'));
  assert.equal(order.at(-1), 'quota:release');
  await session.prepareExpensiveContinuation();
  assert.equal(order.at(-1), 'quota:check');
});
