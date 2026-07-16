import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { runWorker as runWorkerBound } from '../scripts/cruise.mjs';
import { runRuntimeCli } from '../scripts/cruise-runtime.mjs';
import {
  WORKER_HOST_PATH_LOST,
  WORKER_INFERENCE_STREAM_FAILED,
} from '../scripts/lib/app-server-runtime.mjs';
import {
  installManagedAgentConfigs,
  inspectManagedAgentConfigs,
  MANAGED_AGENT_HEADER,
  MANAGED_CONFIG_BEGIN,
  MANAGED_CONFIG_END,
} from '../scripts/lib/agent-config.mjs';
import {
  createForeignDiffGuard,
  foreignDiffAuthorityPath,
} from '../scripts/lib/foreign-diff-guard.mjs';
import { MODEL_IDS } from '../scripts/lib/model-policy.mjs';
import {
  runWorkerSession,
  sanitizeWorkerFailureMessage,
  WorkerSessionError,
  WORKER_DEVELOPER_INSTRUCTIONS,
} from '../scripts/lib/worker-session.mjs';
import { WORKER_LEVEL_POLICY } from '../scripts/lib/worker-policy.mjs';
import { readYamlFile, writeYamlFile } from '../scripts/lib/yaml-state.mjs';

const TEST_PROMPT_SHA256 = 'a'.repeat(64);
const TEST_BASELINE_SHA256 = 'b'.repeat(64);

async function runWorker(options, dependencies) {
  const packetSha256 = options.packetSha256 ?? createHash('sha256')
    .update(await readFile(options.packet))
    .digest('hex');
  return runWorkerBound({ ...options, packetSha256 }, dependencies);
}

async function initializeWorkerGuard(root, runDirectory, {
  blockedReason = null,
  repositoryName,
} = {}) {
  if (typeof repositoryName !== 'string') throw new TypeError('test repositoryName is required');
  await mkdir(join(root, '.cruise'), { recursive: true });
  await writeYamlFile(join(root, '.cruise', 'repo.yaml'), {
    schema_version: 1,
    kind: 'cruise_repository_name',
    name: repositoryName,
    repository_root: await realpath(root),
    assigned_by: 'cruise_l1',
    worker_level: 1,
  });
  await rm(dirname(foreignDiffAuthorityPath(root, basename(runDirectory))), {
    recursive: true,
    force: true,
  });
  const statePath = join(runDirectory, 'drift.yaml');
  await createForeignDiffGuard({
    statePath,
    runId: basename(runDirectory),
    repositoryRoot: root,
    originPromptSha256: TEST_PROMPT_SHA256,
    repositoryBaselineDigest: TEST_BASELINE_SHA256,
    blockedReason,
  });
  return statePath;
}

async function beginRuntime(root, prompt, repositoryName) {
  const promptPath = join(root, '.test-prompt');
  await writeFile(promptPath, prompt);
  await mkdir(join(root, '.cruise'), { recursive: true });
  await writeYamlFile(join(root, '.cruise', 'repo.yaml'), {
    schema_version: 1,
    kind: 'cruise_repository_name',
    name: repositoryName,
    repository_root: await realpath(root),
    assigned_by: 'cruise_l1',
    worker_level: 1,
  });
  await rm(dirname(foreignDiffAuthorityPath(root, 'run-1')), { recursive: true, force: true });
  let stdout = '';
  await runRuntimeCli([
    'begin', '--skill', 'quick', '--root', root, '--prompt-file', promptPath,
  ], {
    output: { write(value) { stdout += value; } },
    runtimeHooks: {
      async invokeNameWorker({ level }) {
        return {
          launch: {
            recommended_level: level,
            agent_type: 'cruise_l1',
            resolved: { model: MODEL_IDS.luna, reasoning_effort: 'low' },
          },
          model_output: JSON.stringify({ run_name: 'run-1', repo_name: repositoryName }),
        };
      },
    },
  });
  return stdout;
}

function catalog() {
  return {
    data: [
      {
        id: MODEL_IDS.luna,
        model: MODEL_IDS.luna,
        hidden: false,
        isDefault: false,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      {
        id: MODEL_IDS.terra,
        model: MODEL_IDS.terra,
        hidden: false,
        isDefault: false,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      },
      {
        id: MODEL_IDS.sol,
        model: MODEL_IDS.sol,
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: 'low',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      },
    ],
  };
}

class FakeAppServer extends EventEmitter {
  constructor(modelCatalog = catalog(), { notifications = null } = {}) {
    super();
    this.catalog = modelCatalog;
    this.notifications = notifications;
    this.requests = [];
  }

  async start() {}
  async stop() {}

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'model/list') return this.catalog;
    if (method === 'thread/start') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        if (this.notifications) {
          for (const notification of this.notifications) {
            if (notification.method === '__exit') this.emit('exit', notification.info ?? {});
            else this.emit('notification', notification);
          }
          return;
        }
        this.emit('notification', { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
        this.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', delta: 'bounded report' } });
        this.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
      });
      return { turn: { id: 'turn-1', status: 'inProgress' } };
    }
    throw new Error(`unexpected request ${method}`);
  }
}

test('all seven levels use exact app-server fields without collaboration overrides', async () => {
  for (let level = 1; level <= 7; level += 1) {
    const client = new FakeAppServer();
    const report = await runWorkerSession({
      level,
      cwd: process.cwd(),
      packet: 'task_id: T-01\nread_paths: []\nwrite_paths: []\n',
      client,
    });
    const expected = WORKER_LEVEL_POLICY[level];
    const thread = client.requests.find(({ method }) => method === 'thread/start').params;
    const turn = client.requests.find(({ method }) => method === 'turn/start').params;
    assert.equal(thread.model, MODEL_IDS[expected.tier]);
    assert.equal(thread.allowProviderModelFallback, false);
    assert.equal(thread.approvalPolicy, 'on-request');
    assert.equal(turn.model, MODEL_IDS[expected.tier]);
    assert.equal(turn.effort, expected.reasoning_effort);
    assert.equal(turn.approvalPolicy, 'on-request');
    assert.equal(Object.hasOwn(turn, 'collaborationMode'), false);
    assert.equal(Object.hasOwn(turn.sandboxPolicy, 'networkAccess'), false);
    assert.equal(turn.sandboxPolicy.excludeTmpdirEnvVar, true);
    assert.equal(turn.sandboxPolicy.excludeSlashTmp, true);
    assert.equal(report.launch.agent_type, expected.agent_type);
    assert.equal(report.launch.provider_model_fallback_allowed, false);
    assert.equal(report.model_output, 'bounded report');
  }
});


test('worker launcher allows retryable app-server errors to recover in the same turn', async () => {
  const client = new FakeAppServer(catalog(), {
    notifications: [
      { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } },
      {
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          willRetry: true,
          error: { message: 'Reconnecting... 2/5' },
        },
      },
      {
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          willRetry: true,
          error: { message: 'Reconnecting... 3/5' },
        },
      },
      { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', delta: 'recovered report' } },
      { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } },
    ],
  });
  const report = await runWorkerSession({
    level: 2,
    cwd: process.cwd(),
    packet: 'task_id: T-01',
    client,
  });
  assert.equal(report.runtime.status, 'completed');
  assert.equal(report.model_output, 'recovered report');
  assert.deepEqual(report.warnings, [
    'transient app-server error (retrying): Reconnecting... 2/5',
    'transient app-server error (retrying): Reconnecting... 3/5',
  ]);
});

test('worker deadline remains the terminal cause after one transient reconnect', async () => {
  const client = new FakeAppServer(catalog(), {
    notifications: [
      { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } },
      {
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          willRetry: true,
          error: { message: 'Reconnecting... 1/5' },
        },
      },
    ],
  });

  await assert.rejects(
    runWorkerSession({
      level: 2,
      cwd: process.cwd(),
      packet: 'task_id: T-01',
      client,
      timeoutMs: 20,
    }),
    (error) => {
      assert.match(error.message, /worker session exceeded 20ms during turn completion/u);
      assert.doesNotMatch(error.message, /CRUISE_WORKER_INFERENCE_STREAM_FAILED/u);
      assert.equal(error.diagnostic, null);
      assert.deepEqual(error.reconnectHistory, [
        { sequence: 1, will_retry: true, message: 'Reconnecting... 1/5' },
      ]);
      return true;
    },
  );
});

test('worker launcher retains complete reconnect history on terminal failure', async () => {
  const client = new FakeAppServer(catalog(), {
    notifications: [
      { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } },
      {
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          willRetry: true,
          error: { message: 'Reconnecting... 1/5' },
        },
      },
      {
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          willRetry: true,
          error: { message: 'Reconnecting... 2/5' },
        },
      },
      {
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          willRetry: false,
          error: {
            message: 'response retries exhausted',
            additionalDetails: 'upstream stream ended after the fifth attempt',
            codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 503 } },
          },
        },
      },
    ],
  });
  await assert.rejects(
    runWorkerSession({ level: 2, cwd: process.cwd(), packet: 'task_id: T-01', client }),
    (error) => {
      assert.equal(error instanceof WorkerSessionError, true);
      assert.equal(error.code, 'CRUISE_WORKER_SESSION_FAILED');
      assert.deepEqual(error.runtime, { thread_id: 'thread-1', turn_id: 'turn-1' });
      assert.equal(Object.isFrozen(error.runtime), true);
      assert.deepEqual(error.reconnectHistory, [
        { sequence: 1, will_retry: true, message: 'Reconnecting... 1/5' },
        { sequence: 2, will_retry: true, message: 'Reconnecting... 2/5' },
        {
          sequence: 3,
          will_retry: false,
          message: 'response retries exhausted',
          codex_error: 'responseTooManyFailedAttempts',
          http_status_code: 503,
          additional_details: 'upstream stream ended after the fifth attempt',
        },
      ]);
      assert.equal(Object.isFrozen(error.reconnectHistory), true);
      assert.match(error.message, /Reconnect history:\n  1\. retrying: Reconnecting\.\.\. 1\/5/u);
      assert.match(
        error.message,
        /3\. terminal \[responseTooManyFailedAttempts HTTP 503\]: response retries exhausted/u,
      );
      assert.match(error.message, new RegExp(WORKER_INFERENCE_STREAM_FAILED.split(':', 1)[0], 'u'));
      assert.doesNotMatch(error.message, /CRUISE_WORKER_HOST_PATH_LOST/u);
      return true;
    },
  );
});

test('owned worker app-server protocol errors reject promptly and stop the client', async () => {
  let clientOptions;
  let stopCalls = 0;
  const client = new FakeAppServer();
  client.stop = async () => {
    stopCalls += 1;
  };
  client.request = async function request(method, params) {
    this.requests.push({ method, params });
    if (method === 'model/list') {
      queueMicrotask(() => {
        clientOptions.onError(new Error('invalid JSON from worker app-server'), this);
      });
      return new Promise(() => {});
    }
    throw new Error(`unexpected request ${method}`);
  };

  await assert.rejects(runWorkerSession({
    level: 2,
    cwd: process.cwd(),
    packet: 'task_id: T-01',
    timeoutMs: 10_000,
    async runtimeFactory() {
      return {
        appServerArgs: [],
        spawnOptions: {},
        extensionPolicy: {},
        async dispose() {},
      };
    },
    clientFactory(options) {
      clientOptions = options;
      return client;
    },
  }), (error) => {
    assert.equal(error instanceof WorkerSessionError, true);
    assert.match(error.message, /invalid JSON from worker app-server/u);
    assert.doesNotMatch(error.message, /worker turn exceeded/u);
    return true;
  });
  assert.equal(stopCalls >= 1, true);
});

test('worker deadline bounds every startup request without taking ownership of caller clients', async () => {
  const stages = ['app-server start', 'model/list', 'thread/start', 'turn/start', 'turn completion'];
  for (const blockedStage of stages) {
    const client = new FakeAppServer();
    let stopCalls = 0;
    client.stop = async () => {
      stopCalls += 1;
    };
    if (blockedStage === 'app-server start') {
      client.start = () => new Promise(() => {});
    }
    client.request = async function request(method, params) {
      this.requests.push({ method, params });
      if (method === 'model/list') {
        if (blockedStage === method) return new Promise(() => {});
        return this.catalog;
      }
      if (method === 'thread/start') {
        if (blockedStage === method) return new Promise(() => {});
        return { thread: { id: 'thread-1' } };
      }
      if (method === 'turn/start') {
        if (blockedStage === method) return new Promise(() => {});
        return { turn: { id: 'turn-1', status: 'inProgress' } };
      }
      throw new Error(`unexpected request ${method}`);
    };

    await assert.rejects(
      runWorkerSession({
        level: 2,
        cwd: process.cwd(),
        packet: 'task_id: T-01',
        client,
        timeoutMs: 20,
      }),
      (error) => {
        assert.equal(error instanceof WorkerSessionError, true);
        assert.match(error.message, new RegExp(`worker session exceeded 20ms during ${blockedStage.replace('/', '\\/')}`, 'u'));
        return true;
      },
    );
    assert.equal(stopCalls, 0, `caller client was stopped during ${blockedStage}`);
  }
});

test('owned worker timeout stops even a never-settling client without hanging cleanup', async () => {
  let stopCalls = 0;
  const client = new FakeAppServer();
  client.start = () => new Promise(() => {});
  client.stop = () => {
    stopCalls += 1;
    return new Promise(() => {});
  };
  const startedAt = Date.now();
  await assert.rejects(runWorkerSession({
    level: 2,
    cwd: process.cwd(),
    packet: 'task_id: T-01',
    timeoutMs: 20,
    async runtimeFactory() {
      return {
        appServerArgs: [],
        spawnOptions: {},
        extensionPolicy: {},
        async dispose() {},
      };
    },
    clientFactory() {
      return client;
    },
  }), /worker session exceeded 20ms during app-server start/u);
  assert.equal(stopCalls, 1);
  assert.equal(Date.now() - startedAt < 500, true);
});

test('owned worker disposes a runtime that resolves after its setup deadline', async () => {
  let resolveRuntime;
  const pendingRuntime = new Promise((resolvePromise) => {
    resolveRuntime = resolvePromise;
  });
  let disposeCalls = 0;
  let clientFactoryCalls = 0;
  const running = runWorkerSession({
    level: 2,
    cwd: process.cwd(),
    packet: 'task_id: T-01',
    timeoutMs: 10,
    runtimeFactory() {
      return pendingRuntime;
    },
    clientFactory() {
      clientFactoryCalls += 1;
      throw new Error('client must not be created after the setup deadline');
    },
  });

  await assert.rejects(
    running,
    /worker session exceeded 10ms during isolated runtime setup/u,
  );
  resolveRuntime({
    async dispose() {
      disposeCalls += 1;
    },
  });
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));

  assert.equal(clientFactoryCalls, 0);
  assert.equal(disposeCalls, 1);
});

test('terminal worker durably writes the complete sanitized failure report', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cruise-worker-failure-report-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runDirectory = join(directory, '.cruise', 'runs', 'run-1');
  await mkdir(runDirectory, { recursive: true });
  const packet = join(runDirectory, 'task-pkt.yaml');
  const report = join(runDirectory, 'task-rpt.yaml');
  await writeFile(packet, 'task_id: T-01\nread_paths: []\nwrite_paths: []\n');
  await initializeWorkerGuard(directory, runDirectory, { repositoryName: 'fail-report' });
  const reconnectHistory = [
    { sequence: 1, will_retry: true, message: 'Reconnecting... 1/5 token=sensitive' },
    {
      sequence: 2,
      will_retry: false,
      message: 'response retries exhausted',
      codex_error: 'responseTooManyFailedAttempts',
      http_status_code: 503,
      additional_details: 'upstream stream ended',
    },
  ];
  await assert.rejects(runWorker({
    cwd: directory,
    level: 2,
    packet,
    report,
  }, {
    invocationCwd: directory,
    runtimeReadiness: async () => ({}),
    async runSession() {
      throw new WorkerSessionError('terminal failure', {
        runtime: { thread_id: 'thread-1', turn_id: 'turn-1' },
        reconnectHistory,
      });
    },
  }), /terminal failure/u);
  const failure = await readYamlFile(report);
  assert.equal(failure.kind, 'cruise_app_server_worker_failure');
  assert.equal(failure.recommended_level, 2);
  assert.equal(failure.attempt.run_id, 'run-1');
  assert.equal(failure.attempt.packet_path, await realpath(packet));
  assert.equal(failure.attempt.report_path, await realpath(report));
  assert.equal(
    failure.attempt.packet_sha256,
    createHash('sha256').update(await readFile(packet)).digest('hex'),
  );
  assert.deepEqual(failure.runtime, { thread_id: 'thread-1', turn_id: 'turn-1' });
  assert.equal(failure.reconnect_history.length, 2);
  assert.equal(failure.reconnect_history[0].message, 'Reconnecting... 1/5 token=[REDACTED]');
  assert.equal(failure.reconnect_history[1].http_status_code, 503);
  assert.doesNotMatch(JSON.stringify(failure), /sensitive/u);
});

test('terminal worker persists complete reconnect history after its packet disappears', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cruise-worker-deleted-packet-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runDirectory = join(directory, '.cruise', 'runs', 'run-1');
  await mkdir(runDirectory, { recursive: true });
  const packet = join(runDirectory, 'task-pkt.yaml');
  const report = join(runDirectory, 'task-rpt.yaml');
  await writeFile(packet, 'task_id: T-01\nread_paths: []\nwrite_paths: []\n');
  await initializeWorkerGuard(directory, runDirectory, { repositoryName: 'del-packet' });
  const sessionError = new WorkerSessionError('terminal failure after reconnects', {
    runtime: { thread_id: 'thread-1', turn_id: 'turn-1' },
    reconnectHistory: [
      { sequence: 1, will_retry: true, message: 'Reconnecting... 1/5' },
      { sequence: 2, will_retry: true, message: 'Reconnecting... 2/5' },
      {
        sequence: 3,
        will_retry: false,
        message: 'response retries exhausted',
        codex_error: 'responseTooManyFailedAttempts',
        http_status_code: 503,
      },
    ],
  });

  await assert.rejects(runWorker({ cwd: directory, level: 2, packet, report }, {
    invocationCwd: directory,
    runtimeReadiness: async () => ({}),
    async runSession() {
      await unlink(packet);
      throw sessionError;
    },
  }), (error) => {
    assert.equal(error, sessionError);
    assert.equal(error.reconnectHistory.length, 3);
    return true;
  });

  const failure = await readYamlFile(report);
  assert.equal(failure.kind, 'cruise_app_server_worker_failure');
  assert.deepEqual(failure.reconnect_history, sessionError.reconnectHistory);
});

test('failure-report persistence errors never mask the original worker error', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cruise-worker-lost-report-parent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runDirectory = join(directory, '.cruise', 'runs', 'run-1');
  await mkdir(runDirectory, { recursive: true });
  const packet = join(runDirectory, 'task-pkt.yaml');
  const report = join(runDirectory, 'task-rpt.yaml');
  await writeFile(packet, 'task_id: T-01\nread_paths: []\nwrite_paths: []\n');
  await initializeWorkerGuard(directory, runDirectory, { repositoryName: 'lost-parent' });
  const sessionError = new WorkerSessionError('terminal failure with lost report parent', {
    reconnectHistory: [{ sequence: 1, will_retry: false, message: 'stream ended' }],
  });

  await assert.rejects(runWorker({ cwd: directory, level: 2, packet, report }, {
    invocationCwd: directory,
    runtimeReadiness: async () => ({}),
    async runSession() {
      await rm(runDirectory, { recursive: true });
      throw sessionError;
    },
  }), (error) => {
    assert.equal(error, sessionError);
    assert.equal(error.reconnectHistory.length, 1);
    assert.equal(error.reportPersistenceError instanceof Error, true);
    return true;
  });
});

test('terminal success and failure attempts cannot relaunch after their reports are deleted', async (t) => {
  for (const outcome of ['success', 'failure']) {
    const root = await mkdtemp(join(tmpdir(), `cruise-worker-terminal-replay-${outcome}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const runDirectory = join(root, '.cruise', 'runs', 'run-1');
    await mkdir(runDirectory, { recursive: true });
    const packet = join(runDirectory, 'task-pkt.yaml');
    const report = join(runDirectory, 'task-rpt.yaml');
    await writeFile(packet, 'task_id: T-01\nread_paths: []\nwrite_paths: []\n');
    await initializeWorkerGuard(root, runDirectory, { repositoryName: `replay-${outcome}` });
    let inferenceCalls = 0;
    const dependencies = {
      invocationCwd: root,
      runtimeReadiness: async () => ({}),
      async runSession() {
        inferenceCalls += 1;
        if (outcome === 'failure') {
          throw new WorkerSessionError('terminal replay fixture failure', {
            reconnectHistory: [{ sequence: 1, will_retry: false, message: 'stream ended' }],
          });
        }
        return {
          schema_version: 1,
          kind: 'cruise_app_server_worker_report',
          launch: { agent_type: 'cruise_l2' },
          runtime: { thread_id: 'thread-1', turn_id: 'turn-1', status: 'completed' },
          model_output: 'completed once',
          warnings: [],
        };
      },
    };

    if (outcome === 'failure') {
      await assert.rejects(runWorker({ cwd: root, level: 2, packet, report }, dependencies),
        /terminal replay fixture failure/u);
    } else {
      assert.equal(await runWorker({ cwd: root, level: 2, packet, report }, dependencies), 0);
    }
    await unlink(report);
    await assert.rejects(
      runWorker({ cwd: root, level: 2, packet, report }, dependencies),
      new RegExp(`already terminal_${outcome}`, 'u'),
    );
    assert.equal(inferenceCalls, 1);
    await assert.rejects(readFile(report), /ENOENT/u);
  }
});

test('worker report is absent at admission and a swapped parent cannot redirect its no-clobber commit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-worker-report-parent-swap-'));
  const outside = await mkdtemp(join(tmpdir(), 'cruise-worker-report-parent-outside-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  const runDirectory = join(root, '.cruise', 'runs', 'run-1');
  const movedRunDirectory = join(root, '.cruise', 'runs', 'run-1-original');
  await mkdir(runDirectory, { recursive: true });
  const packet = join(runDirectory, 'task-pkt.yaml');
  const report = join(runDirectory, 'task-rpt.yaml');
  await writeFile(packet, 'task_id: T-01\nread_paths: []\nwrite_paths: []\n');
  await initializeWorkerGuard(root, runDirectory, { repositoryName: 'parent-swap' });

  let inferenceCalls = 0;
  await assert.rejects(runWorker({ cwd: root, level: 2, packet, report }, {
    invocationCwd: root,
    runtimeReadiness: async () => ({}),
    async runSession() {
      inferenceCalls += 1;
      await rename(runDirectory, movedRunDirectory);
      await writeFile(join(outside, 'task-rpt.yaml'), 'user-owned sentinel\n');
      await symlink(outside, runDirectory);
      return {
        schema_version: 1,
        kind: 'cruise_app_server_worker_report',
        launch: { agent_type: 'cruise_l2' },
        runtime: { thread_id: 'thread-1', turn_id: 'turn-1', status: 'completed' },
        model_output: 'must not commit',
        warnings: [],
      };
    },
  }), (error) => {
    assert.match(
      error.message,
      /run-control directory identity changed|worker launch requires .*drift/u,
    );
    assert.equal(error.reportPersistenceError instanceof Error, true);
    return true;
  });
  assert.equal(inferenceCalls, 1);
  assert.equal(await readFile(join(outside, 'task-rpt.yaml'), 'utf8'), 'user-owned sentinel\n');
  await assert.rejects(readFile(join(movedRunDirectory, 'task-rpt.yaml')), /ENOENT/u);

  const untouchedRoot = await mkdtemp(join(tmpdir(), 'cruise-worker-preexisting-report-'));
  t.after(() => rm(untouchedRoot, { recursive: true, force: true }));
  const untouchedRun = join(untouchedRoot, '.cruise', 'runs', 'run-1');
  await mkdir(untouchedRun, { recursive: true });
  const untouchedPacket = join(untouchedRun, 'task-pkt.yaml');
  const preexistingReport = join(untouchedRun, 'task-rpt.yaml');
  await writeFile(untouchedPacket, 'task_id: T-01\n');
  await writeFile(preexistingReport, 'user-owned report\n');
  await initializeWorkerGuard(untouchedRoot, untouchedRun, { repositoryName: 'preexist-rpt' });
  await assert.rejects(runWorker({
    cwd: untouchedRoot,
    level: 2,
    packet: untouchedPacket,
    report: preexistingReport,
  }, {
    invocationCwd: untouchedRoot,
    runtimeReadiness: async () => ({}),
    async runSession() {
      inferenceCalls += 1;
      throw new Error('must not infer');
    },
  }), /worker report must be missing at worker admission/u);
  assert.equal(await readFile(preexistingReport, 'utf8'), 'user-owned report\n');
  assert.equal(inferenceCalls, 1);

  const racedRoot = await mkdtemp(join(tmpdir(), 'cruise-worker-raced-report-'));
  t.after(() => rm(racedRoot, { recursive: true, force: true }));
  const racedRun = join(racedRoot, '.cruise', 'runs', 'run-1');
  await mkdir(racedRun, { recursive: true });
  const racedPacket = join(racedRun, 'task-pkt.yaml');
  const racedReport = join(racedRun, 'task-rpt.yaml');
  await writeFile(racedPacket, 'task_id: T-01\n');
  await initializeWorkerGuard(racedRoot, racedRun, { repositoryName: 'race-report' });
  await assert.rejects(runWorker({
    cwd: racedRoot,
    level: 2,
    packet: racedPacket,
    report: racedReport,
  }, {
    invocationCwd: racedRoot,
    runtimeReadiness: async () => ({}),
    async runSession() {
      inferenceCalls += 1;
      await writeFile(racedReport, 'worker-created collision\n');
      return {
        schema_version: 1,
        kind: 'cruise_app_server_worker_report',
        launch: { agent_type: 'cruise_l2' },
        runtime: { thread_id: 'thread-1', turn_id: 'turn-1', status: 'completed' },
        model_output: 'must not overwrite collision',
        warnings: [],
      };
    },
  }), (error) => {
    assert.match(error.message, /worker report must be missing/u);
    assert.equal(error.reportPersistenceError instanceof Error, true);
    return true;
  });
  assert.equal(await readFile(racedReport, 'utf8'), 'worker-created collision\n');
  assert.equal(inferenceCalls, 2);
});

test('worker readiness receives custom codexHome and immutable control mutation is terminal', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-worker-control-mutation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDirectory = join(root, '.cruise', 'runs', 'run-1');
  await mkdir(runDirectory, { recursive: true });
  const packet = join(runDirectory, 'task-pkt.yaml');
  const report = join(runDirectory, 'task-rpt.yaml');
  const origin = join(runDirectory, 'origin.yaml');
  const customCodexHome = join(root, 'custom-codex-home');
  await writeFile(packet, 'task_id: T-01\nread_paths: []\nwrite_paths: []\n');
  await writeFile(origin, 'schema_version: 1\nimmutable: true\n');
  await initializeWorkerGuard(root, runDirectory, { repositoryName: 'ctrl-mutate' });
  let readinessOptions = null;
  let sessionOptions = null;

  await assert.rejects(runWorker({
    cwd: root,
    level: 2,
    packet,
    report,
    codexHome: customCodexHome,
  }, {
    invocationCwd: root,
    async runtimeReadiness(options) {
      readinessOptions = options;
      return {};
    },
    async runSession(options) {
      sessionOptions = options;
      await writeFile(origin, 'schema_version: 1\nimmutable: false\n');
      return {
        schema_version: 1,
        kind: 'cruise_app_server_worker_report',
        launch: { agent_type: 'cruise_l2' },
        runtime: { thread_id: 'thread-1', turn_id: 'turn-1', status: 'completed' },
        model_output: 'mutated control',
        warnings: [],
      };
    },
  }), (error) => {
    assert.equal(error.code, 'CRUISE_WORKER_CONTROL_MUTATION');
    assert.deepEqual(error.changedPaths, ['origin.yaml']);
    return true;
  });
  assert.deepEqual(readinessOptions, { codexHome: customCodexHome });
  assert.equal(sessionOptions.codexHome, customCodexHome);
  const failure = await readYamlFile(report);
  assert.equal(failure.kind, 'cruise_app_server_worker_failure');
  assert.equal(failure.attempt.run_id, 'run-1');
  assert.equal(failure.attempt.packet_path, await realpath(packet));
  assert.equal(failure.attempt.report_path, await realpath(report));

  let runtimeOptions = null;
  await runWorkerSession({
    level: 2,
    cwd: root,
    packet: 'task_id: T-02\n',
    codexHome: customCodexHome,
    async runtimeFactory(options) {
      runtimeOptions = options;
      return {
        appServerArgs: [],
        spawnOptions: {},
        async dispose() {},
      };
    },
    clientFactory() {
      return new FakeAppServer();
    },
  });
  assert.deepEqual(runtimeOptions, {
    extensionProfile: 'worker',
    codexHome: customCodexHome,
    runtimeRoot: null,
  });
});

test('worker host scope rejects cwd, packet, report, and symlink escapes before inference', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-worker-scope-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'cruise-worker-scope-outside-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  const runDirectory = join(root, '.cruise', 'runs', 'run-1');
  await mkdir(runDirectory, { recursive: true });
  const packet = join(runDirectory, 'task-pkt.yaml');
  const report = join(runDirectory, 'task-rpt.yaml');
  await writeFile(packet, 'task_id: T-01\nread_paths: []\nwrite_paths: []\n');
  await initializeWorkerGuard(root, runDirectory, { repositoryName: 'scope-check' });
  const outsidePacket = join(outside, 'ext-pkt.yaml');
  await writeFile(outsidePacket, 'secret host text\n');
  let calls = 0;
  const runSession = async () => {
    calls += 1;
    throw new Error('inference must not start');
  };

  await assert.rejects(runWorker({ cwd: root, level: 2, packet: outsidePacket, report }, {
    invocationCwd: root,
    runtimeReadiness: async () => ({}),
    runSession,
  }), /direct, named artifact under \.cruise\/runs/u);
  await assert.rejects(runWorker({ cwd: root, level: 2, packet, report }, {
    invocationCwd: outside,
    runtimeReadiness: async () => ({}),
    runSession,
  }), /-C must equal the canonical host command working directory/u);
  await assert.rejects(runWorker({
    cwd: root,
    level: 2,
    packet,
    report: join(outside, 'ext-rpt.yaml'),
  }, {
    invocationCwd: root,
    runtimeReadiness: async () => ({}),
    runSession,
  }), /direct, named artifact under \.cruise\/runs/u);

  const externalRun = join(outside, 'external-run');
  await mkdir(externalRun);
  await writeFile(join(externalRun, 'link-pkt.yaml'), 'task_id: T-01\n');
  await symlink(externalRun, join(root, '.cruise', 'runs', 'linked-run'));
  await assert.rejects(runWorker({
    cwd: root,
    level: 2,
    packet: join(root, '.cruise', 'runs', 'linked-run', 'link-pkt.yaml'),
    report,
  }, {
    invocationCwd: root,
    runtimeReadiness: async () => ({}),
    runSession,
  }), /must not traverse a symlinked file or parent|direct, named artifact under \.cruise\/runs/u);
  const identical = join(runDirectory, 'pkt-rpt.yaml');
  await writeFile(identical, 'task_id: T-01\n');
  await assert.rejects(runWorker({
    cwd: root,
    level: 2,
    packet: identical,
    report: identical,
  }, {
    invocationCwd: root,
    runtimeReadiness: async () => ({}),
    runSession,
  }), /packet and report must be different canonical paths/u);
  assert.equal(calls, 0);

  await assert.rejects(runWorker({ cwd: root, level: 2, packet, report }, {
    invocationCwd: root,
    runtimeReadiness: async () => {
      throw new Error('worker readiness failed installed-plugin-digest');
    },
    runSession,
  }), /installed-plugin-digest/u);
  assert.equal(calls, 0);
});

test('worker guard monitors automatically and persists unexplained drift before inference', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-worker-foreign-diff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDirectory = join(root, '.cruise', 'runs', 'run-1');
  await mkdir(runDirectory, { recursive: true });
  const packet = join(runDirectory, 'task-pkt.yaml');
  const report = join(runDirectory, 'task-rpt.yaml');
  await writeFile(packet, 'task_id: T-01\nread_paths: []\nwrite_paths: []\n');
  let inferenceCalls = 0;
  const dependencies = {
    invocationCwd: root,
    runtimeReadiness: async () => ({}),
    async runSession() {
      inferenceCalls += 1;
      throw new Error('inference must remain paused');
    },
  };

  await assert.rejects(
    runWorker({ cwd: root, level: 2, packet, report }, dependencies),
    /worker launch requires .*drift\.yaml/u,
  );

  const statePath = await initializeWorkerGuard(root, runDirectory, { repositoryName: 'drift-watch' });
  const monitoring = await readYamlFile(statePath);
  assert.equal(monitoring.status, 'monitoring');
  assert.equal('permission' in monitoring, false);
  await writeFile(join(root, 'intent-unknown.txt'), 'concurrent user edit\n');

  await assert.rejects(
    runWorker({ cwd: root, level: 2, packet, report }, dependencies),
    /foreign diff FD-001 detected; worker launch is paused for user intent/u,
  );
  const paused = await readYamlFile(statePath);
  assert.equal(paused.status, 'waiting_user');
  assert.deepEqual(paused.active_incident.foreign_paths, ['intent-unknown.txt']);
  assert.equal(await readFile(join(root, 'intent-unknown.txt'), 'utf8'), 'concurrent user edit\n');

  await assert.rejects(
    runWorker({ cwd: root, level: 2, packet, report }, dependencies),
    /guard is waiting_user; workers and writes remain paused/u,
  );
  assert.equal(inferenceCalls, 0);
});

test('worker launch fails closed when the foreign-diff guard is blocked', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-worker-blocked-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDirectory = join(root, '.cruise', 'runs', 'run-1');
  await mkdir(runDirectory, { recursive: true });
  const packet = join(runDirectory, 'task-pkt.yaml');
  const report = join(runDirectory, 'task-rpt.yaml');
  await writeFile(packet, 'task_id: T-01\nread_paths: []\nwrite_paths: []\n');
  await initializeWorkerGuard(root, runDirectory, {
    repositoryName: 'blocked-guard',
    blockedReason: { code: 'TEST_BLOCK', message: 'inventory unavailable' },
  });
  let inferenceCalls = 0;

  await assert.rejects(runWorker({ cwd: root, level: 2, packet, report }, {
    invocationCwd: root,
    runtimeReadiness: async () => ({}),
    async runSession() {
      inferenceCalls += 1;
      throw new Error('inference must remain paused');
    },
  }), /guard is blocked; workers and writes remain paused/u);
  assert.equal(inferenceCalls, 0);
});

test('worker releases the guard lock during inference and rejects unexplained drift at postflight', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-worker-during-inference-drift-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDirectory = join(root, '.cruise', 'runs', 'run-1');
  await mkdir(runDirectory, { recursive: true });
  const packet = join(runDirectory, 'task-pkt.yaml');
  const report = join(runDirectory, 'task-rpt.yaml');
  await writeFile(packet, 'task_id: T-01\nread_paths: []\nwrite_paths: []\n');
  const statePath = await initializeWorkerGuard(root, runDirectory, { repositoryName: 'infer-drift' });
  const guardLock = join(dirname(foreignDiffAuthorityPath(root, 'run-1')), 'drift.lock');
  let calls = 0;

  await assert.rejects(runWorker({ cwd: root, level: 2, packet, report }, {
    invocationCwd: root,
    runtimeReadiness: async () => ({}),
    async runSession() {
      calls += 1;
      await assert.rejects(readFile(guardLock), /ENOENT/u);
      await writeFile(join(root, 'concurrent-user.txt'), 'intent is unknown\n');
      return {
        schema_version: 1,
        kind: 'cruise_app_server_worker_report',
        launch: { agent_type: 'cruise_l2' },
        runtime: { thread_id: 'thread-1', turn_id: 'turn-1', status: 'completed' },
        model_output: 'must not be accepted',
        warnings: [],
      };
    },
  }), /foreign diff FD-001 detected; worker launch is paused for user intent/u);

  assert.equal(calls, 1);
  const paused = await readYamlFile(statePath);
  assert.equal(paused.status, 'waiting_user');
  assert.deepEqual(paused.active_incident.foreign_paths, ['concurrent-user.txt']);
  const failure = await readYamlFile(report);
  assert.equal(failure.kind, 'cruise_app_server_worker_failure');
  assert.equal(failure.attempt.packet_path, await realpath(packet));
  await assert.rejects(readFile(guardLock), /ENOENT/u);
  assert.equal(await readFile(join(root, 'concurrent-user.txt'), 'utf8'), 'intent is unknown\n');
});

test('a foreign-diff control filename alone cannot replace completed action authority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-worker-unproven-control-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDirectory = join(root, '.cruise', 'runs', 'run-1');
  await mkdir(runDirectory, { recursive: true });
  const packet = join(runDirectory, 'task-pkt.yaml');
  const report = join(runDirectory, 'task-rpt.yaml');
  const unproven = join(runDirectory, 'drift-bad.yaml');
  await writeFile(packet, 'task_id: T-01\n');
  await initializeWorkerGuard(root, runDirectory, { repositoryName: 'bad-control' });

  await assert.rejects(runWorker({ cwd: root, level: 2, packet, report }, {
    invocationCwd: root,
    runtimeReadiness: async () => ({}),
    async runSession() {
      await writeFile(unproven, 'kind: not_authority\n');
      return {
        schema_version: 1,
        kind: 'cruise_app_server_worker_report',
        launch: { agent_type: 'cruise_l2' },
        runtime: { thread_id: 'thread-1', turn_id: 'turn-1', status: 'completed' },
        model_output: 'must not be accepted',
        warnings: [],
      };
    },
  }), (error) => {
    assert.equal(error.code, 'CRUISE_WORKER_CONTROL_MUTATION');
    assert.deepEqual(error.changedPaths, ['drift-bad.yaml']);
    return true;
  });
  assert.equal(await readFile(unproven, 'utf8'), 'kind: not_authority\n');
  assert.equal((await readYamlFile(report)).kind, 'cruise_app_server_worker_failure');
});

test('implementation worker completes a projected edit and retains only bounded foreign-diff controls', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-worker-action-flow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  await writeFile(join(root, 'app.txt'), 'stable\n');
  assert.equal(spawnSync('git', ['add', 'app.txt'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', [
    '-c', 'user.name=Cruise Test',
    '-c', 'user.email=cruise@example.invalid',
    'commit', '-qm', 'initial',
  ], { cwd: root }).status, 0);

  const runDirectory = join(root, '.cruise', 'runs', 'run-1');
  const runtime = (...args) => spawnSync(process.execPath, [
    resolve('scripts/cruise-runtime.mjs'),
    ...args,
  ], { encoding: 'utf8' });
  const began = await beginRuntime(root, 'Implement one attributed edit.', 'action-repo');
  assert.match(began, /foreign-diff monitoring active/u);
  assert.doesNotMatch(began, /permission pending|Preserve only|Allow exact restore/u);
  assert.equal((await readYamlFile(join(runDirectory, 'drift.yaml'))).status, 'monitoring');
  const packet = join(runDirectory, 'impl-pkt.yaml');
  const report = join(runDirectory, 'impl-rpt.yaml');
  await writeFile(packet, 'task_id: T-IMPLEMENT-01\nwrite_paths:\n  - app.txt\n');

  const result = await runWorker({ cwd: root, level: 4, packet, report }, {
    invocationCwd: root,
    runtimeReadiness: async () => ({}),
    async runSession() {
      const contentPath = join(runDirectory, 'drift-src.bin');
      const intentPath = join(runDirectory, 'drift-int.yaml');
      const actionPath = join(runDirectory, 'drift-act.yaml');
      const receiptPath = join(runDirectory, 'drift-rct.yaml');
      await writeFile(contentPath, 'worker-owned edit\n');
      await writeYamlFile(intentPath, {
        schema_version: 1,
        kind: 'cruise_change_projection_intent',
        action_id: 'A-01',
        changes: [{
          path: 'app.txt',
          kind: 'file',
          mode: 0o644,
          content_file: contentPath,
        }],
      });
      const projected = runtime(
        'foreign-diff-project', '--run-dir', runDirectory,
        '--intent', intentPath, '--output', actionPath,
      );
      assert.equal(projected.status, 0, projected.stderr);
      const action = await readYamlFile(actionPath);
      const opened = runtime(
        'foreign-diff-open', '--run-dir', runDirectory, '--action', actionPath,
      );
      assert.equal(opened.status, 0, opened.stderr);
      await writeFile(join(root, 'app.txt'), 'worker-owned edit\n');
      await writeYamlFile(receiptPath, {
        schema_version: 1,
        kind: 'cruise_change_receipt',
        action_id: 'A-01',
        changes: [{
          path: 'app.txt',
          before_sha256: action.expected_changes[0].before_sha256,
          after_sha256: action.expected_changes[0].after_inventory_sha256,
        }],
      });
      const closed = runtime(
        'foreign-diff-close', '--run-dir', runDirectory, '--receipt', receiptPath,
      );
      assert.equal(closed.status, 0, closed.stderr);
      assert.equal(runtime('foreign-diff-check', '--run-dir', runDirectory).status, 0);
      return {
        schema_version: 1,
        kind: 'cruise_app_server_worker_report',
        launch: { agent_type: 'cruise_l4' },
        runtime: { thread_id: 'thread-1', turn_id: 'turn-1', status: 'completed' },
        model_output: 'implemented with one exact action',
        warnings: [],
      };
    },
  });

  assert.equal(result, 0);
  assert.equal(await readFile(join(root, 'app.txt'), 'utf8'), 'worker-owned edit\n');
  assert.equal((await readYamlFile(report)).kind, 'cruise_app_server_worker_report');
  const guard = await readYamlFile(join(runDirectory, 'drift.yaml'));
  assert.equal(guard.status, 'monitoring');
  assert.equal(guard.checkpoint.sequence, 1);
  assert.equal(guard.history.filter(({ action }) => action === 'action_completed').length, 1);
  assert.deepEqual(
    (await readdir(runDirectory)).filter((name) => name.startsWith('drift-')).sort(),
    [
      'drift-act.yaml',
      'drift-int.yaml',
      'drift-rct.yaml',
      'drift-src.bin',
    ],
  );
});

test('runtime-generated mapping packet preflights before one injected inference call', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-worker-mapping-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDirectory = join(root, '.cruise', 'runs', 'run-1');
  await beginRuntime(root, 'Map this bounded request.', 'mapping-repo');
  assert.equal((await readYamlFile(join(runDirectory, 'drift.yaml'))).status, 'monitoring');
  const packetPath = join(runDirectory, 'map-pkt.yaml');
  const validPacket = await readYamlFile(packetPath);
  let calls = 0;
  const runSession = async () => {
    calls += 1;
    await writeYamlFile(join(runDirectory, 'map-facts.yaml'), {
      enrichment_template: validPacket.enrichment_template,
      model_note: 'untrusted envelope fields are discarded by the host canonicalizer',
    });
    return {
      schema_version: 1,
      kind: 'cruise_app_server_worker_report',
      launch: { agent_type: 'cruise_l2' },
      runtime: { thread_id: 'thread-1', turn_id: 'turn-1', status: 'completed' },
      model_output: 'mapped',
      warnings: [],
    };
  };
  await runWorker({
    cwd: root,
    level: 2,
    packet: packetPath,
    report: join(runDirectory, 'map-rpt.yaml'),
  }, { invocationCwd: root, runtimeReadiness: async () => ({}), runSession });
  assert.equal(calls, 1);
  assert.deepEqual(
    await readYamlFile(join(runDirectory, 'map-facts.yaml')),
    validPacket.enrichment_template,
  );

  await assert.rejects(runWorker({
    cwd: root,
    level: 7,
    packet: packetPath,
    report: join(runDirectory, 'level-rpt.yaml'),
  }, { invocationCwd: root, runtimeReadiness: async () => ({}), runSession }),
  /semantic mapping packet requires exactly worker level 2/u);
  assert.equal(calls, 1);

  const malformed = structuredClone(validPacket);
  malformed.enrichment_template.facts[0].gate = malformed.enrichment_template.facts[0].signal;
  delete malformed.enrichment_template.facts[0].signal;
  await writeYamlFile(packetPath, malformed);
  await assert.rejects(runWorker({
    cwd: root,
    level: 2,
    packet: packetPath,
    report: join(runDirectory, 'bad-rpt.yaml'),
  }, {
    invocationCwd: root,
    runtimeReadiness: async () => ({}),
    runSession,
  }), /runtime-generated executable contract/u);
  assert.equal(calls, 1);
});

test('a prior worker cannot replace a later host-digest-bound packet', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-worker-packet-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDirectory = join(root, '.cruise', 'runs', 'run-1');
  await mkdir(runDirectory, { recursive: true });
  const firstPacket = join(runDirectory, 'first-pkt.yaml');
  const secondPacket = join(runDirectory, 'second-pkt.yaml');
  const firstReport = join(runDirectory, 'first-rpt.yaml');
  const secondReport = join(runDirectory, 'second-rpt.yaml');
  const firstBytes = 'task_id: T-01\nread_paths: []\nwrite_paths: []\n';
  const secondBytes = 'task_id: T-02\nread_paths: []\nwrite_paths: []\n';
  await writeFile(firstPacket, firstBytes);
  await writeFile(secondPacket, secondBytes);
  await initializeWorkerGuard(root, runDirectory, { repositoryName: 'packet-bind' });
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  let inferenceCalls = 0;
  await assert.rejects(runWorkerBound({
    cwd: root,
    level: 2,
    packet: firstPacket,
    packetSha256: digest(firstBytes),
    report: firstReport,
  }, {
    invocationCwd: root,
    runtimeReadiness: async () => ({}),
    async runSession() {
      inferenceCalls += 1;
      await writeFile(secondPacket, 'task_id: FORGED_BY_PRIOR_WORKER\n');
      return {
        schema_version: 1,
        kind: 'cruise_app_server_worker_report',
        launch: { agent_type: 'cruise_l2' },
        runtime: { thread_id: 'thread-1', turn_id: 'turn-1', status: 'completed' },
        model_output: 'first completed',
        warnings: [],
      };
    },
  }), /mutated immutable run-control artifacts: second-pkt\.yaml/u);
  const firstFailure = await readYamlFile(firstReport);
  assert.equal(firstFailure.kind, 'cruise_app_server_worker_failure');
  await assert.rejects(runWorkerBound({
    cwd: root,
    level: 2,
    packet: secondPacket,
    packetSha256: digest(secondBytes),
    report: secondReport,
  }, {
    invocationCwd: root,
    runtimeReadiness: async () => ({}),
    async runSession() {
      inferenceCalls += 1;
      throw new Error('second inference must not start');
    },
  }), /packet bytes differ from --packet-sha256/u);
  assert.equal(inferenceCalls, 1);
  await assert.rejects(readFile(secondReport), /ENOENT/u);
});

test('worker launcher fails immediately on app-server exit and preserves prior reconnects', async () => {
  const client = new FakeAppServer(catalog(), {
    notifications: [
      { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } },
      {
        method: 'error',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          willRetry: true,
          error: { message: 'Reconnecting... 1/5' },
        },
      },
      { method: '__exit', info: { code: 1, signal: null, error: null } },
    ],
  });
  await assert.rejects(
    runWorkerSession({ level: 2, cwd: process.cwd(), packet: 'task_id: T-01', client }),
    (error) => {
      assert.match(error.message, /app-server exited before worker turn completed/u);
      assert.match(error.message, new RegExp(WORKER_HOST_PATH_LOST.split(':', 1)[0], 'u'));
      assert.doesNotMatch(error.message, /CRUISE_WORKER_INFERENCE_STREAM_FAILED/u);
      assert.deepEqual(error.reconnectHistory, [
        { sequence: 1, will_retry: true, message: 'Reconnecting... 1/5' },
      ]);
      return true;
    },
  );
});

test('worker failure rendering strips terminal controls and secrets without dropping events', () => {
  const sanitized = sanitizeWorkerFailureMessage(
    '\u001b[31mretry\u001b[0m\nBearer sensitive-token token=another-secret',
  );
  assert.equal(sanitized, 'retry Bearer [REDACTED] token=[REDACTED]');
  assert.doesNotMatch(sanitized, /sensitive-token|another-secret|\u001b/u);
});

test('worker launcher rejects a missing configured pair before thread creation', async () => {
  const missing = catalog();
  missing.data = missing.data.filter(({ id }) => id !== MODEL_IDS.sol);
  const client = new FakeAppServer(missing);
  await assert.rejects(
    runWorkerSession({ level: 7, cwd: process.cwd(), packet: 'task_id: T-01', client }),
    /required worker pair is unavailable/,
  );
  assert.equal(client.requests.some(({ method }) => method === 'thread/start'), false);
});

test('managed agent installation is idempotent and refuses unmanaged conflicts', async (t) => {
  const codexHome = await mkdtemp(join(tmpdir(), 'cruise-agent-home-'));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const first = await installManagedAgentConfigs({ codexHome });
  assert.equal(first.changed.length, 8);
  assert.equal(first.changed.includes('config.toml'), true);
  assert.equal(first.ready, true);
  const second = await installManagedAgentConfigs({ codexHome });
  assert.equal(second.changed.length, 0);
  const inspected = await inspectManagedAgentConfigs({ codexHome });
  assert.equal(inspected.files.every(({ status }) => status === 'current'), true);
  assert.equal(inspected.registration.status, 'current');
  assert.equal((await readFile(join(codexHome, 'agents', 'cruise_l1.toml'), 'utf8')).startsWith(MANAGED_AGENT_HEADER), true);
  const config = await readFile(join(codexHome, 'config.toml'), 'utf8');
  assert.match(config, new RegExp(MANAGED_CONFIG_BEGIN));
  assert.match(config, /\[agents\.cruise_l1\][\s\S]*config_file = "agents\/cruise_l1\.toml"/u);
  assert.match(config, new RegExp(MANAGED_CONFIG_END));
  const strict = spawnSync('codex', ['app-server', '--strict-config', '--stdio'], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: codexHome },
    input: '',
  });
  assert.equal(strict.status, 0, strict.stderr);

  await writeFile(join(codexHome, 'agents', 'cruise_l4.toml'), 'name = "mine"\n');
  await assert.rejects(installManagedAgentConfigs({ codexHome }), /refusing to replace unmanaged/);
});

test('managed agent installation refuses pre-existing unmanaged role registrations', async (t) => {
  const codexHome = await mkdtemp(join(tmpdir(), 'cruise-agent-conflict-'));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  await writeFile(join(codexHome, 'config.toml'), '[agents.cruise_l1]\ndescription = "mine"\n');
  await assert.rejects(installManagedAgentConfigs({ codexHome }), /refusing to replace unmanaged or malformed/);
});

async function filesBelow(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

test('model-visible Cruise prompts contain no runtime-selection directives', async () => {
  const files = [
    ...await filesBelow(resolve('skills')),
    resolve('internal/shared/invocation-contract.md'),
    resolve('scripts/lib/goal-contract.mjs'),
    resolve('scripts/lib/session.mjs'),
  ].filter((path) => /(?:SKILL\.md|invocation-contract\.md|session\.mjs)$/u.test(path));
  const forbidden = /gpt-5\.6|terra_agent|sol_agent|BLOCKED_UNSUPPORTED_WORKER_SELECTION|resolved_(?:model|reasoning)|spawn_agent.{0,80}(?:model|reasoning)|(?:change|keep|preserve).{0,24}root model/iu;
  for (const path of files) {
    assert.doesNotMatch(await readFile(path, 'utf8'), forbidden, path);
  }
  assert.doesNotMatch(WORKER_DEVELOPER_INSTRUCTIONS, forbidden);

  for (let level = 1; level <= 7; level += 1) {
    const source = await readFile(resolve(`internal/agent-configs/cruise_l${level}.toml`), 'utf8');
    const instructions = source.match(/developer_instructions = """([\s\S]*?)"""/u)?.[1] ?? '';
    assert.doesNotMatch(instructions, /gpt-5\.6|\b(?:model|reasoning effort)\b/iu);
  }
});
