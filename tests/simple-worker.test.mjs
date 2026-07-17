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
  constructor(events) {
    super();
    this.events = events;
  }

  async start() {}
  async stop() {}
  async request(method) {
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
