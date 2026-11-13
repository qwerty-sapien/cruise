import { INDEPENDENT_RELEASE_INSTRUCTIONS } from '../scripts/lib/release-policy.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { answerWorkerRequest } from '../scripts/cruise.mjs';

import {
  classifyWorkerFailure,
  runSimpleWorker,
  workerFailureMessage,
} from '../scripts/lib/simple-worker.mjs';

test('worker questions keep routine delegation internal in both profiles and mixed batches', async () => {
  for (const profile of ['relaxed', 'business-critical']) {
    const shown = [];
    const result = await answerWorkerRequest({ method: 'item/tool/requestUserInput', params: { questions: [
      { id: 'delegate', question: `${profile}: May I spawn a sub-agent to review this patch?` },
      { id: 'effect', question: 'Should the subagent delete the production database?' },
    ] } }, {
      picker: async () => { throw new Error('unexpected picker'); },
      readLine: async ({ prompt }) => { shown.push(prompt); return 'Do not delete it.'; },
    });
    assert.match(result.answers.delegate.answers[0], /without asking/u);
    assert.deepEqual(shown, ['Should the subagent delete the production database?: ']);
    assert.deepEqual(result.answers.effect.answers, ['Do not delete it.']);
  }
});

test('worker native denials remain host decisions', async () => {
  let asked = false;
  await answerWorkerRequest({ method: 'item/tool/requestUserInput', params: { questions: [
    { id: 'delegate', question: 'May I spawn a sub-agent to review this patch?' },
  ] } }, {
    authorizationEvidence: { nativeApprovalDenied: true },
    readLine: async () => { asked = true; return 'Stop the refused action.'; },
  });
  assert.equal(asked, true);
});

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
        supportedReasoningEfforts: ['medium', 'high', 'xhigh', 'ultra'],
      },
      {
        id: 'gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        hidden: false,
        isDefault: false,
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: ['high', 'xhigh', 'ultra'],
      },
      {
        id: 'gpt-6-astra',
        model: 'gpt-6-astra',
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
  assert.match(thread.developerInstructions, /host-access-approved local director/u);
  assert.match(thread.developerInstructions, /not by itself a new third-party provider disclosure/u);
  assert.ok(thread.developerInstructions.includes(INDEPENDENT_RELEASE_INSTRUCTIONS));
  assert.equal(Object.hasOwn(thread, 'model'), false);
  assert.equal(Object.hasOwn(turn, 'model'), false);
  assert.equal(Object.hasOwn(turn, 'effort'), false);
});

test('worker transcript routes coordination internally and carries native evidence to its request handler', async () => {
  for (const reviewThread of [null, 'worker-thread', 'other-thread']) {
    let asked = false;
    let reply;
    await runSimpleWorker({
      cwd: process.cwd(), task: 'Review the supplied source excerpt.',
      clientFactory: (options) => {
        const client = new FakeWorkerClient([]);
        const request = client.request.bind(client);
        client.request = async (method, params) => {
          if (method !== 'turn/start') return request(method, params);
          if (reviewThread) client.emit('notification', {
            method: 'item/autoApprovalReview/completed',
            params: { threadId: reviewThread, turnId: 'worker-turn', review: { status: 'denied' } },
          });
          reply = await options.onServerRequest({ method: 'item/tool/requestUserInput', params: {
            questions: [{ id: 'delegate', question: 'May I spawn a sub-agent to review this patch?' }],
          } }, client);
          client.emit('notification', { method: 'turn/completed', params: { turn: { status: 'completed' } } });
          return { turn: { id: 'worker-turn' } };
        };
        return client;
      },
      onServerRequest: (message, client, authorizationEvidence) => answerWorkerRequest(message, {
        client, authorizationEvidence,
        readLine: async () => { asked = true; return 'Stop the refused action.'; },
      }),
    });
    assert.equal(asked, reviewThread === 'worker-thread');
    if (!asked) assert.match(reply.answers.delegate.answers[0], /without asking/u);
  }
});

test('worker launch rejects secret material and sensitive-file access before starting a client', async () => {
  let starts = 0;
  const clientFactory = () => {
    starts += 1;
    return new FakeWorkerClient([]);
  };
  await assert.rejects(
    runSimpleWorker({ cwd: process.cwd(), task: 'Read .env and report it.', clientFactory }),
    (error) => error?.code === 'CRUISE_SENSITIVE_PATH',
  );
  await assert.rejects(
    runSimpleWorker({ cwd: process.cwd(), task: 'Use ACCESS_TOKEN=MINIREPO_VALUE.', clientFactory }),
    (error) => error?.code === 'CRUISE_SECRET_MATERIAL',
  );
  assert.equal(starts, 0);
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
    [2, 'gpt-5.6-terra', 'xhigh'],
    [3, 'gpt-5.6-terra', 'ultra'],
    [4, 'gpt-5.6-sol', 'xhigh'],
    [5, 'gpt-6-astra', 'high'],
    [6, 'gpt-5.6-sol', 'ultra'],
    [7, 'gpt-6-astra', 'xhigh'],
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
    assert.match(thread.developerInstructions, new RegExp(`Cruise L${level}`, 'u'));
    if ([5, 7].includes(level)) {
      assert.match(thread.developerInstructions, /Infer routine gaps and persist within the bounded capsule/u);
      assert.match(thread.developerInstructions, /ask only about material unresolved decisions/u);
      assert.match(thread.developerInstructions, /calibrate tests to affected risk/u);
    } else {
      assert.doesNotMatch(thread.developerInstructions, /Infer routine gaps/u);
    }
    assert.equal(turn.model, model);
    assert.equal(turn.effort, effort);
    assert.deepEqual(turn.responsesapiClientMetadata, {
      cruise_level: String(level),
      cruise_agent_type: `cruise_l${level}`,
    });
  }
});

test('L7 launch requests distinguish direct exceptional work from an evidenced L6 reasoning escalation', async () => {
  const exceptionalConsequence = {
    consequence: 'exceptional irreversible effect',
    rationale: 'the focused trace proves that the operation has no rollback path',
  };
  const cases = [
    { label: 'direct', transition: null, effort: 'xhigh' },
    {
      label: 'escalated',
      transition: {
        kind: 'escalation',
        work_item: 'single exceptional production operation',
        evidence: 'a focused trace isolates the remaining uncertainty to reasoning',
        from_level: 6,
        failure_category: 'reasoning',
        exceptional_consequence: exceptionalConsequence,
      },
      effort: 'ultra',
    },
  ];
  for (const { label, transition, effort } of cases) {
    const client = new FakeWorkerClient([
      { method: 'turn/completed', params: { turn: { status: 'completed' } } },
    ], modelCatalog());
    await runSimpleWorker({
      cwd: process.cwd(),
      task: `Run the ${label} bounded L7 work.`,
      level: 7,
      exceptionalConsequence,
      transition,
      clientFactory: () => client,
    });

    const thread = client.requests.find(({ method }) => method === 'thread/start').params;
    const turn = client.requests.find(({ method }) => method === 'turn/start').params;
    assert.equal(thread.model, 'gpt-6-astra');
    assert.equal(thread.allowProviderModelFallback, false);
    assert.equal(turn.model, 'gpt-6-astra');
    assert.equal(turn.effort, effort);
  }
});

test('an explicit Astra level fails closed when Astra is absent from the catalog', async () => {
  const client = new FakeWorkerClient([], {
    data: modelCatalog().data.filter(({ id }) => id !== 'gpt-6-astra'),
  });
  await assert.rejects(runSimpleWorker({
    cwd: process.cwd(),
    task: 'Use the explicitly requested consequential worker.',
    level: 5,
    clientFactory: () => client,
  }), /required worker pair is unavailable.*gpt-6-astra/u);
  assert.deepEqual(client.requests.map(({ method }) => method), ['model/list']);
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
