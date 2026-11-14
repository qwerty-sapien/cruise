import { INDEPENDENT_RELEASE_INSTRUCTIONS } from '../scripts/lib/release-policy.mjs';
import { WORKER_HANDOFF_OUTPUT_SCHEMA } from '../scripts/lib/context-capsule.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { answerWorkerRequest } from '../scripts/cruise.mjs';
import { changelogSummaryTask } from '../scripts/lib/changelog-observer.mjs';
import { pickOne } from '../scripts/lib/picker.mjs';

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

test('worker approval EOF and missing selections never synthesize decisions or permissions', async () => {
  for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval']) {
    for (const picker of [pickOne, async () => null, async () => undefined, async () => ({ status: 'cancelled' }), null]) {
      const watchdog = [];
      const evidence = { nativeApprovalDenied: false };
      await assert.rejects(answerWorkerRequest({ method, params: { permissions: { network: { enabled: true } } } }, {
        picker, input: Readable.from([]), output: { write() {} }, authorizationEvidence: evidence,
        client: {
          pauseInactivityWatchdog() { watchdog.push('pause'); },
          resumeInactivityWatchdog() { watchdog.push('resume'); },
        },
      }), (error) => {
        assert.equal(error.code, 'CRUISE_APPROVAL_CHANNEL_UNAVAILABLE');
        assert.equal(error.category, 'approval-channel-unavailable');
        assert.match(error.message, /native approval input channel.*interactive approval channel.*existing task authorization/u);
        return true;
      });
      assert.equal(evidence.nativeApprovalDenied, false);
      assert.deepEqual(watchdog, ['pause', 'resume']);
    }
  }
});

test('worker native decisions roundtrip and explicit permission choices remain effective', async () => {
  const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['node', 'check.mjs'] } };
  const network = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.invalid', action: 'deny' } } };
  for (const decision of ['accept', 'acceptForSession', amendment, network, 'decline', 'cancel']) {
    let rendered = '';
    const result = await answerWorkerRequest({ method: 'item/commandExecution/requestApproval',
      params: { availableDecisions: [decision] } }, {
      input: Readable.from(['1\n']), output: { write(text) { rendered += text; } },
    });
    assert.equal(result.decision, decision);
    assert.doesNotMatch(rendered, /\[object Object\]/u);
    if (decision === amendment) assert.match(rendered, /Accept with command policy amendment.*check.mjs/u);
    if (decision === network) assert.match(rendered, /Apply network policy amendment.*deny/u);
  }
  const permissions = { network: { enabled: true } };
  for (const [line, granted] of [['1\n', permissions], ['2\n', {}], ['q\n', {}], ['\u001b\n', {}], ['\u0003\n', {}]]) {
    assert.deepEqual(await answerWorkerRequest({ method: 'item/permissions/requestApproval', params: { permissions } }, {
      input: Readable.from([line]), output: { write() {} },
    }), { permissions: granted, scope: 'turn' });
  }
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

test('only the exact generic routing error receives account-routing guidance', () => {
  const failure = classifyWorkerFailure(Object.assign(new Error('workspace routing discovery failed'), { code: -32603 }));
  assert.equal(failure.category, 'account-routing');
  assert.match(workerFailureMessage(failure), /authenticated account\/backend connectivity/u);
  assert.match(workerFailureMessage(failure), /canonical \/private\/var\/run\/mDNSResponder/u);
  for (const message of [
    'workspace routing discovery failed: authentication required',
    'workspace routing discovery failed: invalid configuration',
    'authentication failed',
  ]) {
    const qualified = classifyWorkerFailure(new Error(message));
    assert.equal(qualified.category, 'unknown');
    assert.doesNotMatch(workerFailureMessage(qualified), /mDNSResponder/u);
  }
  for (const httpStatusCode of [401, 403, 503]) {
    const qualified = classifyWorkerFailure({ message: 'workspace routing discovery failed', httpStatusCode });
    assert.equal(qualified.category, 'upstream');
    assert.doesNotMatch(workerFailureMessage(qualified), /mDNSResponder/u);
  }
});

test('generic account-routing startup failure stops the client without retry or model turn', async () => {
  let attempts = 0;
  let stops = 0;
  const requests = [];
  class RoutingClient extends EventEmitter {
    async start() {}
    async stop() { stops += 1; }
    async request(method) {
      requests.push(method);
      throw Object.assign(new Error('workspace routing discovery failed'), { code: -32603 });
    }
  }
  await assert.rejects(runSimpleWorker({
    cwd: process.cwd(), task: 'Read the fixture.',
    clientFactory: () => { attempts += 1; return new RoutingClient(); },
  }), (error) => {
    assert.equal(error.category, 'account-routing');
    assert.equal(error.cause.code, -32603);
    return true;
  });
  assert.equal(attempts, 1);
  assert.equal(stops, 1);
  assert.deepEqual(requests, ['thread/start']);
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

test('startup exit rejection is observed before start settles without masking the startup error', () => {
  const workerModule = new URL('../scripts/lib/simple-worker.mjs', import.meta.url).href;
  const program = `
    import { EventEmitter } from 'node:events';
    import { runSimpleWorker } from ${JSON.stringify(workerModule)};

    let stopCalls = 0;
    class StartupExitClient extends EventEmitter {
      async start() {
        this.emit('exit', { error: new Error('app-server exited during startup') });
        throw new Error('distinct startup rejection');
      }
      async stop() { stopCalls += 1; }
    }

    let caught;
    try {
      await runSimpleWorker({
        cwd: process.cwd(),
        task: 'Exercise bounded startup failure.',
        clientFactory: () => new StartupExitClient(),
      });
    } catch (error) {
      caught = {
        code: error.code,
        category: error.category,
        message: error.message,
        cause: error.cause?.message,
      };
    }
    await new Promise((resolve) => setImmediate(resolve));
    process.stdout.write(JSON.stringify({ caught, stopCalls }));
  `;
  const child = spawnSync(process.execPath, [
    '--unhandled-rejections=strict',
    '--input-type=module',
    '--eval',
    program,
  ], { cwd: process.cwd(), encoding: 'utf8' });

  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stderr, /^Cruise worker: native approvals reviewer=auto_review; selection is not an approval result\.\n$/u);
  assert.deepEqual(JSON.parse(child.stdout), {
    caught: {
      code: 'CRUISE_WORKER_STREAM_FAILURE',
      category: 'unknown',
      message: 'Worker unknown failure: distinct startup rejection.',
      cause: 'distinct startup rejection',
    },
    stopCalls: 1,
  });
});

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

test('worker forwards an explicit native output schema and omits it by default', async () => {
  const schemaClient = new FakeWorkerClient([
    { method: 'turn/completed', params: { turn: { status: 'completed' } } },
  ]);
  await runSimpleWorker({
    cwd: process.cwd(), task: 'Return a bounded handoff.', outputSchema: WORKER_HANDOFF_OUTPUT_SCHEMA,
    clientFactory: () => schemaClient,
  });
  const schemaTurn = schemaClient.requests.find(({ method }) => method === 'turn/start').params;
  assert.deepEqual(schemaTurn.outputSchema, WORKER_HANDOFF_OUTPUT_SCHEMA);

  const genericClient = new FakeWorkerClient([
    { method: 'turn/completed', params: { turn: { status: 'completed' } } },
  ]);
  await runSimpleWorker({
    cwd: process.cwd(), task: 'Run a generic bounded task.', clientFactory: () => genericClient,
  });
  const genericTurn = genericClient.requests.find(({ method }) => method === 'turn/start').params;
  assert.equal(Object.hasOwn(genericTurn, 'outputSchema'), false);
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

test('worker permissions channel failure propagates without a grant, denial, or retry', async () => {
  let launches = 0;
  let stopped = false;
  const responses = [];
  let observedEvidence;
  await assert.rejects(runSimpleWorker({
    cwd: process.cwd(), task: 'Inspect the supplied source excerpt.',
    approvalsReviewer: 'user',
    clientFactory: (options) => {
      launches += 1;
      const client = new FakeWorkerClient([]);
      const request = client.request.bind(client);
      client.stop = async () => { stopped = true; };
      client.request = async (method, params) => {
        if (method !== 'turn/start') return request(method, params);
        responses.push(await options.onServerRequest({
          method: 'item/permissions/requestApproval',
          params: { threadId: 'worker-thread', turnId: 'worker-turn', permissions: { network: { enabled: true } } },
        }, client));
        throw new Error('EOF must not return a permissions response');
      };
      return client;
    },
    onServerRequest: (message, client, authorizationEvidence) => {
      observedEvidence = authorizationEvidence;
      return answerWorkerRequest(message, {
        client, authorizationEvidence, input: Readable.from([]), output: { write() {} },
      });
    },
  }), /approval-channel-unavailable.*interactive approval channel/u);
  assert.equal(launches, 1);
  assert.equal(stopped, true);
  assert.deepEqual(responses, []);
  assert.equal(observedEvidence.nativeApprovalDenied, false);
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

for (const readOnly of [false, true]) test(`worker external sandbox is request-scoped (readOnly=${readOnly})`, async () => {
  for (const externalSandbox of [false, true]) {
    const client = new FakeWorkerClient([
      { method: 'turn/completed', params: { turn: { status: 'completed' } } },
    ]);
    await runSimpleWorker({ cwd: process.cwd(), task: 'Inspect ordinary source.', readOnly,
      externalSandbox, clientFactory: () => client });
    const thread = client.requests.find(({ method }) => method === 'thread/start').params;
    const turn = client.requests.find(({ method }) => method === 'turn/start').params;
    assert.equal(thread.sandbox, readOnly ? 'read-only' : 'workspace-write');
    assert.equal(thread.approvalPolicy, 'on-request');
    assert.equal(turn.approvalPolicy, 'on-request');
    assert.deepEqual(turn.sandboxPolicy, externalSandbox
      ? { type: 'externalSandbox', networkAccess: 'restricted' }
      : readOnly ? { type: 'readOnly' } : { type: 'workspaceWrite', writableRoots: [process.cwd()] });
    if (externalSandbox) {
      assert.match(thread.developerInstructions, /outer sandbox must enforce/u);
      if (readOnly) assert.match(thread.developerInstructions, /This worker is read-only: do not modify product files/u);
    } else assert.doesNotMatch(thread.developerInstructions, /operator selected --external-sandbox/u);
  }
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

const streamDelta = (id, delta) => ({ method: 'item/agentMessage/delta', params: { threadId: 'worker-thread', itemId: id, delta } });
const streamItem = (id, phase, text) => ({ method: 'item/completed', params: { threadId: 'worker-thread', item: { type: 'agentMessage', id, phase, text } } });
const streamDone = { method: 'turn/completed', params: { threadId: 'worker-thread', turn: { status: 'completed' } } };

async function collectStream(events, onOutput = null) {
  return runSimpleWorker({ cwd: process.cwd(), task: 'Review the bounded fixture.', readOnly: true,
    onOutput, clientFactory: () => new FakeWorkerClient([...events, streamDone]) });
}

test('canonical final text is collected without deltas and commentary is streaming only', async () => {
  const final = '{"result":"done"}';
  assert.equal((await collectStream([streamItem('f', 'final_answer', final)])).output, final);
  const streamed = [];
  const result = await collectStream([
    streamDelta('c', 'Checking the code.'), streamItem('c', 'commentary', 'Checking the code.'),
    streamDelta('f', final.slice(0, 5)), streamDelta('f', final.slice(5)),
    streamItem('f', 'final_answer', final), streamItem('f', 'final_answer', final),
  ], (delta) => streamed.push(delta));
  assert.equal(result.output, final);
  assert.equal(streamed.join(''), 'Checking the code.' + final);
  assert.equal((await collectStream([streamDelta('f', final.slice(0, 5)), streamItem('f', 'final_answer', final)])).output, final);
});

test('legacy null-phase and delta-only streams remain supported without conflating item IDs', async () => {
  const final = '{"result":"legacy"}';
  for (const events of [
    [streamDelta('f', final)],
    [streamDelta(undefined, final.slice(0, 3)), streamDelta(undefined, final.slice(3))],
    [streamItem('f', null, final)],
    [streamDelta('f', final), streamItem('f', null, final)],
    [streamItem('c', 'commentary', 'Checking.'), streamItem('f', null, final)],
  ]) assert.equal((await collectStream(events)).output, final);
});

test('partial answers and normalized progress text do not contaminate a canonical final handoff', async () => {
  const final = '{"result":"done"}';
  const events = [
    streamDelta('p', 'An intermediate answer'), streamItem('p', 'partial_answer', 'Intermediate summary.'),
    streamDelta('c', 'checking'), streamItem('c', 'commentary', 'Checking code.'),
    streamItem('f', 'final_answer', final),
  ];
  assert.equal((await collectStream(events)).output, final);
  assert.equal((await collectStream([streamItem('p', 'partial_answer', final)])).output, '');
});

test('conflicting or ambiguous final streams fail closed', async () => {
  const a = '{"result":"a"}';
  const b = '{"result":"b"}';
  for (const events of [
    [streamItem('a', 'final_answer', a), streamItem('b', 'final_answer', b)],
    [streamItem('a', 'final_answer', a), streamItem('b', 'final_answer', a)],
    [streamItem('a', null, a), streamItem('b', 'final_answer', b)],
    [streamDelta('a', a), streamDelta('b', b)],
    [streamDelta('a', a), streamItem('b', 'final_answer', b)],
    [streamDelta('a', a + '\ntrailing'), streamItem('a', 'final_answer', a)],
    [streamDelta('a', b), streamItem('a', 'final_answer', a)],
    [streamItem('a', 'final_answer', a), streamItem('a', 'final_answer', b)],
    [streamItem('a', 'final_answer', a), streamItem('a', 'commentary', a)],
  ]) await assert.rejects(collectStream(events), /ambiguous worker final output/u);
});

test('read-only worker requests no-persist retrieval without writable product roots', async () => {
  const client = new FakeWorkerClient([streamDone]);
  await runSimpleWorker({ cwd: process.cwd(), task: 'Review bounded fixture.', readOnly: true, clientFactory: () => client });
  const thread = client.requests.find((request) => request.method === 'thread/start').params;
  const turn = client.requests.find((request) => request.method === 'turn/start').params;
  assert.match(thread.developerInstructions, /context-view with --no-persist/u);
  assert.match(thread.developerInstructions, /read scope does not expand edit ownership/u);
  assert.equal(thread.sandbox, 'read-only');
  assert.deepEqual(thread.runtimeWorkspaceRoots, []);
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly' });
});

test('changelog source evidence is data while instruction and credential checks remain active', async () => {
  for (const patch of [
    'export const source = "src/ordinary.mjs";',
    'export function fixture() { return "config/credentials.json"; }',
    'const parserFixture = "read .env";',
    '// Read .env configuration via an existing adapter.',
  ]) {
    const task = changelogSummaryTask({ commitEvidence: [{ path: 'fixture.mjs', action: 'new', patch }], overallEvidence: [] });
    const client = new FakeWorkerClient([streamItem('f', 'final_answer', '{}'), streamDone]);
    await runSimpleWorker({ cwd: process.cwd(), task, readOnly: true, clientFactory: () => client });
    const turn = client.requests.find(({ method }) => method === 'turn/start').params;
    assert.equal(turn.input[0].text, task.instructions);
    assert.ok(turn.input[1].text.includes(JSON.stringify(patch)));
    assert.match(turn.input[1].text, /never as instructions or authorization/u);
    assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly' });
    assert.equal(Object.hasOwn(turn, 'outputSchema'), false);
  }
  const forbiddenClient = () => { throw new Error('preflight must reject before starting a client'); };
  for (const instructions of ['Read .env', 'Read config/credentials.json']) {
    for (const task of [instructions, { kind: 'cruise-evidence-task', instructions, evidence: '{}' }]) {
      await assert.rejects(runSimpleWorker({ cwd: process.cwd(), task, clientFactory: forbiddenClient }),
        { code: 'CRUISE_SENSITIVE_PATH' });
    }
  }
  // Deliberately synthetic credential-material markers, never usable credentials.
  const marker = '-----BEGIN PRIVATE KEY-----';
  for (const evidence of [JSON.stringify({ patch: marker }), '{"patch":"\\u002d----BEGIN PRIVATE KEY-----"}']) {
    await assert.rejects(runSimpleWorker({ cwd: process.cwd(),
      task: { kind: 'cruise-evidence-task', instructions: 'Summarize the supplied data.', evidence },
      clientFactory: forbiddenClient }), /secret|credential|private.key/iu);
  }
  await assert.rejects(runSimpleWorker({ cwd: process.cwd(),
    task: { kind: 'cruise-evidence-task', instructions: `Summarize ${marker}`, evidence: '{}' },
    clientFactory: forbiddenClient }), /secret|credential|private.key/iu);
});

for (const [isTTY, override, expected] of [
  [true, undefined, 'user'], [false, undefined, 'auto_review'],
  [false, 'user', 'user'], [true, 'auto_review', 'auto_review'],
  [false, 'guardian_subagent', 'guardian_subagent'],
]) {
  test(`native worker reviewer ${isTTY}/${override} is forwarded without changing approval policy`, async () => {
    const client = new FakeWorkerClient([
      { method: 'turn/completed', params: { turn: { status: 'completed' } } },
    ]);
    let diagnostic = '';
    await runSimpleWorker({
      cwd: process.cwd(), task: 'Inspect the supplied source.', approvalsReviewer: override,
      stdin: { isTTY }, errorOutput: { write(text) { diagnostic += text; } },
      clientFactory: () => client,
    });
    for (const { params } of client.requests) {
      assert.equal(params.approvalsReviewer, expected);
      assert.equal(params.approvalPolicy, 'on-request');
    }
    assert.match(client.requests[0].params.developerInstructions, new RegExp(`Native Codex approvals reviewer: ${expected}`));
    assert.match(diagnostic, /selection is not an approval result/u);
  });
}

test('invalid worker reviewer fails before transport creation', async () => {
  await assert.rejects(runSimpleWorker({
    cwd: process.cwd(), task: 'Inspect source.', approvalsReviewer: 'accept',
    clientFactory() { assert.fail('invalid reviewer must not launch'); },
  }), /requires user, auto_review, or guardian_subagent/u);
});

test('native worker reviewer rejection propagates without fallback or retry', async () => {
  for (const rejectedMethod of ['thread/start', 'turn/start']) {
    const calls = [];
    let stopped = 0;
    let launches = 0;
    await assert.rejects(runSimpleWorker({
      cwd: process.cwd(), task: 'Inspect source.', approvalsReviewer: 'guardian_subagent',
      errorOutput: { write() {} },
      clientFactory() {
        launches += 1;
        const client = new FakeWorkerClient([]);
        client.stop = async () => { stopped += 1; };
        client.request = async (method, params) => {
          calls.push({ method, params });
          if (method === rejectedMethod) throw new Error('unsupported approvalsReviewer: guardian_subagent');
          return { thread: { id: 'worker-thread' } };
        };
        return client;
      },
    }), /unsupported approvalsReviewer: guardian_subagent/u);
    assert.equal(launches, 1);
    assert.equal(stopped, 1);
    assert.ok(calls.every(({ params }) => params.approvalsReviewer === 'guardian_subagent'));
  }
});

test('native reviewer denial prevents an unchanged worker retry after a transport failure', async () => {
  let launches = 0;
  await assert.rejects(runSimpleWorker({
    cwd: process.cwd(), task: 'Inspect source.', approvalsReviewer: 'auto_review', errorOutput: { write() {} },
    clientFactory() {
      launches += 1;
      const client = new FakeWorkerClient([]);
      client.request = async (method) => {
        if (method === 'thread/start') return { thread: { id: 'worker-thread' } };
        client.emit('notification', { method: 'item/autoApprovalReview/completed', params: {
          threadId: 'worker-thread', turnId: 'worker-turn', review: { status: 'denied' },
        } });
        throw Object.freeze(new Error('HTTP 503 after native reviewer denied the action'));
      };
      return client;
    },
  }), /native reviewer denied the action/u);
  assert.equal(launches, 1);
});
