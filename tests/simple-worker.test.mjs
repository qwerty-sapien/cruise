import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  classifyWorkerFailure,
  runSimpleWorker,
  workerFailureMessage,
} from '../scripts/lib/simple-worker.mjs';

test('worker failures report observed transport categories without inventing DNS', () => {
  const upstream = classifyWorkerFailure({
    message: 'response retries exhausted',
    httpStatusCode: 503,
  });
  assert.deepEqual(upstream, {
    category: 'upstream',
    httpStatusCode: 503,
    message: 'response retries exhausted',
  });
  assert.match(workerFailureMessage(upstream), /upstream failure \(HTTP 503\)/u);
  assert.doesNotMatch(workerFailureMessage(upstream), /dns/u);

  assert.equal(
    classifyWorkerFailure(new Error('getaddrinfo ENOTFOUND api.openai.com')).category,
    'dns',
  );
  assert.equal(
    classifyWorkerFailure(new Error('socket hang up ECONNRESET')).category,
    'connection',
  );
});

class FakeWorkerClient extends EventEmitter {
  constructor(events, catalog = null) {
    super();
    this.events = events;
    this.catalog = catalog;
    this.requests = [];
  }

  async start() {}
  async stop() {}
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'model/list') return this.catalog;
    if (method === 'thread/start') return { thread: { id: 'worker-thread' } };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        for (const event of this.events) this.emit('notification', event);
      });
      return { turn: { id: 'worker-turn' } };
    }
    throw new Error(`unexpected request ${method}`);
  }
}

function modelCatalog() {
  return {
    data: [
      {
        id: 'gpt-5.6-luna',
        model: 'gpt-5.6-luna',
        hidden: false,
        isDefault: false,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: ['medium'],
      },
      {
        id: 'gpt-5.6-terra',
        model: 'gpt-5.6-terra',
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: ['medium', 'high', 'xhigh'],
      },
      {
        id: 'gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        hidden: false,
        isDefault: false,
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: ['high', 'xhigh', 'ultra'],
      },
    ],
  };
}

function upstreamFailure() {
  return {
    method: 'error',
    params: {
      willRetry: false,
      error: {
        message: 'response retries exhausted',
        codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 503 } },
      },
    },
  };
}

test('a pre-effect upstream failure retries once without durable retry state', async () => {
  let count = 0;
  const result = await runSimpleWorker({
    cwd: process.cwd(),
    task: 'Do the bounded work.',
    clientFactory: () => new FakeWorkerClient(count++ === 0
      ? [upstreamFailure()]
      : [{ method: 'turn/completed', params: { turn: { status: 'completed' } } }]),
  });
  assert.equal(count, 2);
  assert.equal(result.effectsObserved, false);
});

test('model selection is untouched without an explicit level', async () => {
  const client = new FakeWorkerClient([
    { method: 'turn/completed', params: { turn: { status: 'completed' } } },
  ]);
  await runSimpleWorker({
    cwd: process.cwd(),
    task: 'Use the normal host default.',
    clientFactory: () => client,
  });

  assert.deepEqual(client.requests.map(({ method }) => method), ['thread/start', 'turn/start']);
  const thread = client.requests[0].params;
  const turn = client.requests[1].params;
  assert.equal(Object.hasOwn(thread, 'model'), false);
  assert.equal(Object.hasOwn(turn, 'model'), false);
  assert.equal(Object.hasOwn(turn, 'effort'), false);
});

test('internal read-only workers cannot mutate the product workspace', async () => {
  const client = new FakeWorkerClient([
    { method: 'turn/completed', params: { turn: { status: 'completed' } } },
  ]);
  await runSimpleWorker({
    cwd: process.cwd(),
    task: 'Summarize the supplied immutable evidence.',
    readOnly: true,
    timeoutMs: 1_000,
    clientFactory: () => client,
  });
  assert.equal(client.requests[0].params.sandbox, 'read-only');
  assert.deepEqual(client.requests[1].params.sandboxPolicy, { type: 'readOnly' });
});

test('internal workers have a bounded execution timeout', async () => {
  const client = new FakeWorkerClient([]);
  await assert.rejects(runSimpleWorker({
    cwd: process.cwd(),
    task: 'Never completes.',
    readOnly: true,
    timeoutMs: 5,
    clientFactory: () => client,
  }), /exceeded its 5ms execution bound/u);
});

test('every explicit level overrides the worker with its exact model and effort', async () => {
  const expected = [
    [1, 'gpt-5.6-luna', 'medium'],
    [2, 'gpt-5.6-terra', 'medium'],
    [3, 'gpt-5.6-terra', 'high'],
    [4, 'gpt-5.6-terra', 'xhigh'],
    [5, 'gpt-5.6-sol', 'high'],
    [6, 'gpt-5.6-sol', 'xhigh'],
    [7, 'gpt-5.6-sol', 'ultra'],
  ];
  for (const [level, model, effort] of expected) {
    const client = new FakeWorkerClient([
      { method: 'turn/completed', params: { turn: { status: 'completed' } } },
    ], modelCatalog());
    await runSimpleWorker({
      cwd: process.cwd(),
      task: 'Use the explicitly requested worker.',
      level,
      ...(level === 7
        ? {
            exceptionalConsequence: {
              consequence: 'exceptional irreversible effect',
              rationale: 'the caller supplied a reviewed L7 record',
            },
          }
        : {}),
      clientFactory: () => client,
    });

    assert.deepEqual(client.requests.map(({ method }) => method), [
      'model/list',
      'thread/start',
      'turn/start',
    ]);
    const thread = client.requests[1].params;
    const turn = client.requests[2].params;
    assert.equal(thread.model, model);
    assert.equal(thread.allowProviderModelFallback, false);
    assert.equal(turn.model, model);
    assert.equal(turn.effort, effort);
    assert.deepEqual(turn.responsesapiClientMetadata, {
      cruise_level: String(level),
      cruise_agent_type: `cruise_l${level}`,
    });
  }
});

test('a stream failure after tool activity is reported, not silently duplicated or blocked', async () => {
  let count = 0;
  await assert.rejects(
    runSimpleWorker({
      cwd: process.cwd(),
      task: 'Do the bounded work.',
      clientFactory: () => new FakeWorkerClient((count += 1, [
        { method: 'item/commandExecution/started', params: {} },
        upstreamFailure(),
      ])),
    }),
    (error) => {
      assert.equal(count, 1);
      assert.equal(error.category, 'upstream');
      assert.match(error.message, /HTTP 503/u);
      assert.doesNotMatch(error.message, /fresh user|DNS health|blocked/iu);
      return true;
    },
  );
});
