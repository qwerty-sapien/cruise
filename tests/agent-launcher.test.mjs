import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  installManagedAgentConfigs,
  inspectManagedAgentConfigs,
  MANAGED_AGENT_HEADER,
  MANAGED_CONFIG_BEGIN,
  MANAGED_CONFIG_END,
} from '../scripts/lib/agent-config.mjs';
import { MODEL_IDS } from '../scripts/lib/model-policy.mjs';
import { runWorkerSession, WORKER_DEVELOPER_INSTRUCTIONS } from '../scripts/lib/worker-session.mjs';
import { WORKER_LEVEL_POLICY } from '../scripts/lib/worker-policy.mjs';

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
  constructor(modelCatalog = catalog()) {
    super();
    this.catalog = modelCatalog;
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
    assert.equal(turn.model, MODEL_IDS[expected.tier]);
    assert.equal(turn.effort, expected.reasoning_effort);
    assert.equal(Object.hasOwn(turn, 'collaborationMode'), false);
    assert.equal(report.launch.agent_type, expected.agent_type);
    assert.equal(report.launch.provider_model_fallback_allowed, false);
    assert.equal(report.model_output, 'bounded report');
  }
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
