import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  localDoctorReport,
  parseArgs,
  runStart,
  runWorker,
} from '../scripts/cruise.mjs';
import { readOriginPrompt } from '../scripts/lib/origin-note.mjs';

test('the public CLI accepts direct requests and rejects retired control-plane flags', () => {
  assert.deepEqual(parseArgs(['quick', '-C', '/tmp', 'Fix', 'it']), {
    command: 'quick',
    skill: 'quick',
    cwd: '/tmp',
    json: false,
    help: false,
    version: false,
    promptParts: ['Fix', 'it'],
    prompt: 'Fix it',
  });
  assert.deepEqual(parseArgs(['worker', 'Run', 'tests']), {
    command: 'worker',
    skill: 'goal',
    cwd: process.cwd(),
    json: false,
    help: false,
    version: false,
    promptParts: ['Run', 'tests'],
    prompt: 'Run tests',
  });
  assert.throws(() => parseArgs(['goal', '--packet', 'task.yaml']), /not supported/u);
  assert.throws(() => parseArgs(['doctor', '--install-worker-rule']), /not supported/u);
});

test('workers receive ordinary text and never require packet or report paths', async () => {
  const calls = [];
  const result = await runWorker({ cwd: process.cwd(), prompt: 'Run one check.' }, {
    async worker(input) {
      calls.push(input);
      return { output: '', effectsObserved: false };
    },
  });
  assert.equal(result, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, process.cwd());
  assert.equal(calls[0].task, 'Run one check.');
  assert.equal(typeof calls[0].onOutput, 'function');
  assert.equal(typeof calls[0].onServerRequest, 'function');
});

class StartClient extends EventEmitter {
  async start() {}
  async stop() {}
  async request(method) {
    if (method === 'thread/start') return { thread: { id: 'thread' } };
    if (method === 'turn/start') {
      queueMicrotask(() => this.emit('notification', {
        method: 'turn/completed',
        params: { turn: { id: 'turn', status: 'completed' } },
      }));
      return { turn: { id: 'turn' } };
    }
    throw new Error(`unexpected request ${method}`);
  }
}

test('starting Cruise persists only the exact ORIGIN.md request before the normal task', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-start-simple-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prompt = 'Keep these two spaces.  \nAnd this newline.';
  assert.equal(await runStart({ cwd: root, prompt, skill: 'quick' }, {
    clientFactory: () => new StartClient(),
  }), 0);
  assert.equal(await readOriginPrompt(root), prompt);
});

test('Doctor only checks local Codex availability, not profiles, rules, digests, or network health', () => {
  const calls = [];
  const report = localDoctorReport((binary, args) => {
    calls.push([binary, args]);
    return { status: 0, output: args[0] === '--version' ? 'codex 1.0' : 'help', error: '' };
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map(({ id }) => id), ['codex', 'app-server']);
  assert.deepEqual(calls, [
    ['codex', ['--version']],
    ['codex', ['app-server', '--help']],
  ]);
});
