import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  assert.match(thread.developerInstructions, /native peer messages/u);
  assert.match(thread.developerInstructions, /Never request context compaction/u);
  assert.match(thread.developerInstructions, /latest checkpoint.*explicit human instructions/u);
  assert.match(thread.developerInstructions, /skills\/goal\/references\/agent-context\.md/u);
  assert.equal(Object.hasOwn(thread, 'model'), false);
  assert.equal(Object.hasOwn(turn, 'model'), false);
  assert.equal(Object.hasOwn(turn, 'effort'), false);
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

function runStrictStartupProbe(program, options) {
  const root = mkdtempSync(join(tmpdir(), 'cruise-startup-lifecycle-'));
  try {
    const child = spawnSync(process.execPath, [
      '--unhandled-rejections=strict',
      '--input-type=module',
      '-e',
      `await (${program.toString()})(${JSON.stringify({
        ...options,
        workerModule: new URL('../scripts/lib/simple-worker.mjs', import.meta.url).href,
        sessionModule: new URL('../scripts/lib/simple-session.mjs', import.meta.url).href,
        catalog: modelCatalog(),
      })});`,
    ], { cwd: root, encoding: 'utf8', timeout: 5_000 });
    assert.equal(child.error, undefined, `${child.error?.message}\n${child.stderr}`);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.equal(child.stderr, '');
    return JSON.parse(child.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function workerStartupProbe({ workerModule, catalog, stage, event, effects = false, retryable = false }) {
  const { default: assert } = await import('node:assert/strict');
  const { EventEmitter } = await import('node:events');
  const { runSimpleWorker } = await import(workerModule);
  const clients = [];
  class StartupClient extends EventEmitter {
    constructor() {
      super();
      this.requests = [];
      this.stops = 0;
      this.on('exit', () => {});
      this.on('notification', () => {});
    }

    async failAt(currentStage) {
      if (currentStage !== stage) return;
      if (effects) this.emit('notification', { method: 'item/commandExecution/started', params: {} });
      if (event === 'exit') this.emit('exit', { error: new Error('synthetic early exit') });
      if (event === 'terminal') this.emit('notification', {
        method: 'error', params: { willRetry: false, error: { message: 'synthetic early terminal error' } },
      });
      // Give strict rejection handling a full event-loop turn before the RPC rejects.
      await new Promise((resolve) => setImmediate(resolve));
      const error = new Error(`synthetic ${stage} failure`);
      if (retryable) error.code = 'ECONNRESET';
      throw error;
    }

    async start() {
      this.keepAlive = setInterval(() => {}, 1_000);
      await this.failAt('start');
    }

    async request(method) {
      this.requests.push(method);
      await this.failAt(method);
      if (method === 'model/list') return catalog;
      if (method === 'thread/start') return { thread: { id: 'startup-thread' } };
      throw new Error(`unexpected request ${method}`);
    }

    async stop() {
      this.stops += 1;
      clearInterval(this.keepAlive);
      assert.equal(this.listenerCount('exit'), 1);
      assert.equal(this.listenerCount('notification'), 1);
      this.emit('exit', { error: new Error('synthetic cleanup exit') });
      throw new Error('synthetic cleanup failure');
    }
  }

  let failure;
  try {
    await runSimpleWorker({
      cwd: process.cwd(), task: 'Synthetic startup fixture only.',
      level: stage === 'model/list' ? 3 : null,
      clientFactory() {
        const client = new StartupClient();
        clients.push(client);
        return client;
      },
    });
  } catch (error) {
    failure = error;
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failure?.code, 'CRUISE_WORKER_STREAM_FAILURE');
  assert.equal(failure.cause.message, `synthetic ${stage} failure`);
  assert.equal(failure.cause.effectsObserved, effects);
  assert.equal(clients.length, retryable && !effects ? 2 : 1);
  const requests = stage === 'start' ? [] : stage === 'model/list'
    ? ['model/list'] : stage === 'thread/start' ? ['thread/start'] : ['thread/start', 'turn/start'];
  for (const client of clients) {
    assert.deepEqual(client.requests, requests);
    assert.equal(client.stops, 1);
    assert.equal(client.listenerCount('exit'), 1);
    assert.equal(client.listenerCount('notification'), 1);
  }
  process.stdout.write(JSON.stringify({ stage, event, effects, attempts: clients.length, stopped: true }));
}

for (const stage of ['start', 'model/list', 'thread/start', 'turn/start']) {
  for (const event of ['exit', 'terminal', 'cleanup-only']) {
    test(`worker handles ${event} during ${stage} under strict rejection handling`, () => {
      const result = runStrictStartupProbe(workerStartupProbe, { stage, event });
      assert.equal(result.stopped, true);
      assert.equal(result.attempts, 1);
    });
  }
}

test('startup transport retry remains bounded and never replays observed effects', () => {
  for (const effects of [false, true]) {
    const result = runStrictStartupProbe(workerStartupProbe, {
      stage: 'turn/start', event: 'exit', retryable: true, effects,
    });
    assert.equal(result.attempts, effects ? 1 : 2);
    assert.equal(result.stopped, true);
  }
});

async function goalActivationProbe({ sessionModule, stage, activationFails, exits = true, delayed = true }) {
  const { default: assert } = await import('node:assert/strict');
  const { EventEmitter } = await import('node:events');
  const { SimpleCruiseSession } = await import(sessionModule);
  class ActivationClient extends EventEmitter {
    constructor() {
      super();
      this.requests = [];
      this.stops = 0;
    }

    async start() { this.keepAlive = setInterval(() => {}, 1_000); }

    async request(method) {
      this.requests.push(method);
      if (method === stage) {
        if (exits) this.emit('exit', { error: new Error('synthetic activation exit') });
        if (delayed) await new Promise((resolve) => setImmediate(resolve));
        if (activationFails) throw new Error('synthetic activation failure');
      }
      if (method === 'thread/start') return { thread: { id: 'activation-thread' } };
      if (method === 'thread/settings/update') return {};
      if (method === 'thread/goal/get') return { goal: null };
      if (method === 'thread/goal/set') return { goal: { status: 'active' } };
      if (method === 'thread/read') return { thread: { id: 'activation-thread', status: { type: 'idle' } } };
      throw new Error(`unexpected request ${method}`);
    }

    async stop() {
      this.stops += 1;
      clearInterval(this.keepAlive);
      for (const event of ['request', 'notification', 'exit']) assert.equal(this.listenerCount(event), 0);
      this.emit('exit', { error: new Error('synthetic Goal cleanup exit') });
    }
  }

  const client = new ActivationClient();
  const sink = { write() {} };
  const session = new SimpleCruiseSession({
    client, cwd: process.cwd(), prompt: 'Synthetic Goal activation fixture only.',
    skill: 'goal', skillPath: '/tmp/synthetic-goal-skill.md',
    output: sink, errorOutput: sink, locateTrace: async () => null,
  });
  await assert.rejects(session.run(), { message: activationFails ? 'synthetic activation failure' : 'synthetic activation exit' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.stops, 1);
  for (const event of ['request', 'notification', 'exit']) assert.equal(client.listenerCount(event), 0);
  assert.equal(client.requests.filter((method) => method === 'thread/goal/set').length, stage === 'thread/goal/get' && activationFails ? 0 : 1);
  assert.equal(client.requests.includes('turn/start'), false);
  assert.equal(session.pending, null);
  assert.equal(session.nativeGoalTurnWaiting, false);
  assert.equal(session.nativeGoalTurnDeadline, null);
  assert.equal(session.nativeGoalCleanupWaits.size, 0);
  process.stdout.write(JSON.stringify({ stage, activationFails, stopped: true, turnsStarted: 0 }));
}

for (const stage of ['thread/goal/get', 'thread/goal/set']) {
  for (const activationFails of [false, true]) {
    test(`Goal observes early exit during ${stage} before activation ${activationFails ? 'fails' : 'settles'}`, () => {
      const result = runStrictStartupProbe(goalActivationProbe, { stage, activationFails });
      assert.equal(result.stopped, true);
      assert.equal(result.turnsStarted, 0);
    });
  }
  test(`failed Goal ${stage} cannot bootstrap an idle turn`, () => {
    const result = runStrictStartupProbe(goalActivationProbe, { stage, activationFails: true, exits: false });
    assert.equal(result.turnsStarted, 0);
  });
}

test('Goal never starts an idle turn when the host exits during thread/read', () => {
  const result = runStrictStartupProbe(goalActivationProbe, {
    stage: 'thread/read', activationFails: false, delayed: false,
  });
  assert.equal(result.stopped, true);
  assert.equal(result.turnsStarted, 0);
});

async function workerInputProbe({ workerModule, code, responseFails = false }) {
  const { default: assert } = await import('node:assert/strict');
  const { EventEmitter } = await import('node:events');
  const { runSimpleWorker } = await import(workerModule);
  const failure = Object.assign(new Error('synthetic human input failure'), { code });
  const request = { id: 1, method: 'item/commandExecution/requestApproval', params: {} };
  let handlerCalls = 0;
  let factoryCalls = 0;
  let nativeError;
  const events = [];
  class InputClient extends EventEmitter {
    constructor(handler) { super(); this.handler = handler; this.stops = 0; }
    async start() { this.keepAlive = setInterval(() => {}, 1_000); }
    async request(method) {
      if (method === 'thread/start') return { thread: { id: 'input-thread' } };
      assert.equal(method, 'turn/start');
      try {
        const result = await this.handler(request, this);
        assert.equal(result, undefined);
      } catch (error) {
        assert.equal(code, 'SYNTHETIC_RPC_ERROR');
        this.respondError(request.id, error);
      }
      if (code === 'SYNTHETIC_RPC_ERROR') queueMicrotask(() => this.emit('notification', {
        method: 'turn/completed', params: { turn: { status: 'completed' } },
      }));
      return { turn: { id: 'input-turn' } };
    }
    respondError(id, error) {
      assert.equal(id, request.id);
      events.push('rpc-error');
      nativeError = error;
      if (responseFails) throw new Error('synthetic closed native input');
    }
    async stop() {
      events.push('stop');
      this.stops += 1;
      clearInterval(this.keepAlive);
      assert.equal(this.listenerCount('notification'), 0);
      assert.equal(this.listenerCount('exit'), 0);
    }
  }
  let client;
  const operation = runSimpleWorker({
    cwd: process.cwd(), task: 'Synthetic input fixture only.',
    clientFactory(options) {
      factoryCalls += 1;
      client = new InputClient(options.onServerRequest);
      return client;
    },
    async onServerRequest(message) {
      handlerCalls += 1;
      assert.equal(message, request);
      throw failure;
    },
  });
  if (code === 'SYNTHETIC_RPC_ERROR') {
    assert.equal((await operation).turnId, 'input-turn');
  } else {
    await assert.rejects(operation, (error) => error.cause === failure);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nativeError, failure);
  assert.equal(handlerCalls, 1);
  assert.equal(factoryCalls, 1);
  assert.equal(client.stops, 1);
  assert.equal(client.listenerCount('notification'), 0);
  assert.equal(client.listenerCount('exit'), 0);
  assert.deepEqual(events, ['rpc-error', 'stop']);
  process.stdout.write(JSON.stringify({ code, stopped: true, nativeErrorPreserved: true }));
}

for (const code of ['CRUISE_INPUT_UNAVAILABLE', 'CRUISE_INTERRUPTED', 'SYNTHETIC_RPC_ERROR']) {
  test(`worker preserves native request errors and closes typed input failures (${code})`, () => {
    const result = runStrictStartupProbe(workerInputProbe, { code });
    assert.equal(result.stopped, true);
    assert.equal(result.nativeErrorPreserved, true);
  });
}

test('worker closes typed input failure after the native reply stream has exited', () => {
  const result = runStrictStartupProbe(workerInputProbe, { code: 'CRUISE_INPUT_UNAVAILABLE', responseFails: true });
  assert.equal(result.stopped, true);
});
