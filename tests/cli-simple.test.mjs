import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  CLI_VERSION,
  localDoctorReport,
  parseArgs,
  PUBLIC_SKILLS,
  runAttest,
  runOneGoal,
  runStart,
  runWorker,
  surfaceAppServerStderr,
} from '../index.js';
import { readOriginPrompt } from '../scripts/lib/origin-note.mjs';
import { SimpleCruiseSession } from '../scripts/lib/simple-session.mjs';
import { isGoalSessionActive } from '../hooks/session-marker.mjs';

test('the npm package entry runs the Cruise CLI', () => {
  const result = spawnSync(process.execPath, [resolve('index.js'), '--version'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim(), CLI_VERSION);

  const help = spawnSync(process.execPath, [resolve('index.js'), '--help'], {
    encoding: 'utf8',
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /4 Goal bootstrap timeout/u);
  assert.match(help.stdout, /5 transport inactivity/u);
});

test('app-server stderr is attributed across chunk boundaries', () => {
  const client = new EventEmitter();
  let output = '';
  const detach = surfaceAppServerStderr(client, { write(value) { output += value; } });
  client.emit('stderr', 'first\npar');
  client.emit('stderr', 'tial\nthird\n');
  detach();
  client.emit('stderr', 'ignored\n');
  assert.equal(output, 'codex: first\ncodex: partial\ncodex: third\n');
});

test('the public CLI accepts direct requests and rejects retired control-plane flags', () => {
  assert.deepEqual(parseArgs(['quick', '-C', '/tmp', 'Fix', 'it']), {
    command: 'quick',
    skill: 'quick',
    provider: 'codex',
    cwd: '/tmp',
    json: false,
    help: false,
    version: false,
    level: null,
    promptParts: ['Fix', 'it'],
    prompt: 'Fix it',
  });
  assert.deepEqual(parseArgs(['worker', '--level', '6', 'Run', 'tests']), {
    command: 'worker',
    skill: 'goal',
    provider: 'codex',
    cwd: process.cwd(),
    json: false,
    help: false,
    version: false,
    level: 6,
    promptParts: ['Run', 'tests'],
    prompt: 'Run tests',
  });
  assert.throws(() => parseArgs(['config', 'class']), /no persistent config command/u);
  assert.throws(() => parseArgs(['worker', '--level', '8', 'Run']), /integer from 1 through 7/u);
  assert.throws(() => parseArgs(['quick', '--level', '5', 'Fix']), /only by cruise worker/u);
  assert.throws(() => parseArgs(['goal', '--packet', 'task.yaml']), /not supported/u);
  assert.throws(() => parseArgs(['doctor', '--install-worker-rule']), /not supported/u);
  assert.throws(() => parseArgs(['picker-demo']), /was removed/u);
  assert.equal(parseArgs(['goal', '--plan', 'Design it']).planOnly, true);
  assert.throws(() => parseArgs(['quick', '--plan', 'Patch it']), /only by cruise goal/u);
  assert.equal(
    parseArgs(['--claude', 'goal', '--resume', '12345678-abcd']).resumeSessionId,
    '12345678-abcd',
  );
  assert.throws(
    () => parseArgs(['--claude', 'goal', '--resume', '12345678-abcd', 'Continue']),
    /preserves the original Goal/u,
  );
  assert.throws(
    () => parseArgs(['goal', '--resume', '12345678-abcd', 'Continue']),
    /only by `cruise --claude goal`/u,
  );
  assert.throws(
    () => parseArgs(['refine', 'Plan it']),
    /Refine was folded into Goal.*plan only/u,
  );
});

test('the release exposes exactly four real skills with synchronized versions', async () => {
  assert.deepEqual(PUBLIC_SKILLS, ['build', 'quick', 'goal', 'debug']);
  const discovered = (await readdir(resolve('skills'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(discovered, [...PUBLIC_SKILLS].sort());
  const packageVersion = JSON.parse(await readFile(resolve('package.json'), 'utf8')).version;
  const codex = JSON.parse(await readFile(resolve('.codex-plugin/plugin.json'), 'utf8'));
  const claude = JSON.parse(await readFile(resolve('.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(packageVersion, '0.4.0');
  assert.equal(codex.version, packageVersion);
  assert.equal(claude.version, packageVersion);
  assert.doesNotMatch(JSON.stringify(codex.interface.defaultPrompt), /refine/u);
});

test('attest is a prompt-free inspection command with machine-readable output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-attest-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = parseArgs(['attest', '--json', '-C', root]);
  assert.equal(options.command, 'attest');
  assert.equal(options.prompt, '');
  let output = '';
  assert.equal(await runAttest(options, {
    output: { write(value) { output += value; } },
    planInspector: async () => ({
      state: 'valid',
      plan: { version: 1, status: 'complete' },
    }),
  }), 2);
  const report = JSON.parse(output);
  assert.equal(report.level, 'legacy-unattested');
  assert.equal(report.ready_for_completion, false);
  assert.equal(report.allows_completion, false);
});

test('provider selectors are request-scoped, mutually exclusive, and default to Codex', () => {
  assert.equal(parseArgs(['quick', 'Fix'], { env: {} }).provider, 'codex');
  assert.equal(parseArgs(['--claude', 'quick', 'Fix'], { env: {} }).provider, 'claude');
  assert.equal(parseArgs(['quick', '--provider', 'claude', 'Fix'], { env: {} }).provider, 'claude');
  assert.equal(parseArgs(['quick', 'Fix'], { env: { CRUISE_PROVIDER: 'claude' } }).provider, 'claude');
  assert.throws(() => parseArgs(['--codex', '--claude', 'quick', 'Fix'], { env: {} }), /only one provider/u);
  assert.throws(() => parseArgs(['--provider', 'other', 'quick', 'Fix'], { env: {} }), /provider must be one of/u);
});

test('workers receive ordinary text and an explicit, request-scoped level', async () => {
  const calls = [];
  const result = await runWorker({ cwd: process.cwd(), prompt: 'Run one check.', level: 5 }, {
    async worker(input) {
      calls.push(input);
      return { output: '', effectsObserved: false };
    },
  });
  assert.equal(result, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, process.cwd());
  assert.equal(calls[0].task, 'Run one check.');
  assert.equal(calls[0].level, 5);
  assert.equal(typeof calls[0].onOutput, 'function');
  assert.equal(typeof calls[0].onServerRequest, 'function');
});

test('Claude workers use the Claude adapter without touching Codex app-server', async () => {
  const calls = [];
  const result = await runWorker({
    cwd: process.cwd(),
    prompt: 'Run one check.',
    level: 6,
    provider: 'claude',
  }, {
    async worker() {
      throw new Error('Codex worker must not run');
    },
    async claudeWorker(input) {
      calls.push(input);
      return { output: '', effectsObserved: false };
    },
  });
  assert.equal(result, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].task, 'Run one check.');
  assert.equal(calls[0].level, 6);
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

test('the run-one-goal seam does not replace ORIGIN.md', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-one-goal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runOneGoal({ cwd: root, prompt: 'Execute M1.', provider: 'codex' }, {
    clientFactory: () => ({}),
    sessionFactory() {
      return {
        async run() { return { status: 'complete' }; },
        async interrupt() {},
      };
    },
  });
  assert.deepEqual(result, { status: 'complete', exitCode: 0 });
  await assert.rejects(readOriginPrompt(root), { code: 'ENOENT' });
});

test('a supervised Goal stall maps to exit code 3', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-start-stalled-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalRoot = await realpath(root);
  const result = await runStart({ cwd: root, prompt: 'Finish it.', skill: 'goal' }, {
    clientFactory: () => ({}),
    sessionFactory(input) {
      assert.equal(input.cwd, canonicalRoot);
      return {
        async run() { return { status: 'stalled' }; },
        async interrupt() {},
      };
    },
  });
  assert.equal(result, 3);
});

test('a native Goal bootstrap timeout maps to exit code 4', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-start-bootstrap-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  class NoTurnStartClient extends EventEmitter {
    constructor() {
      super();
      this.goal = null;
      this.statuses = [];
    }

    async start() {}
    async stop() {}

    async request(method, params = {}) {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-timeout' }, model: 'gpt-test' };
      }
      if (method === 'thread/settings/update') return {};
      if (method === 'thread/goal/get') return { goal: this.goal };
      if (method === 'thread/goal/set') {
        this.statuses.push(params.status);
        this.goal = { objective: params.objective, status: params.status };
        return { goal: this.goal };
      }
      throw new Error(`unexpected request ${method}`);
    }
  }
  const client = new NoTurnStartClient();
  let errorOutput = '';
  const result = await runStart({ cwd: root, prompt: 'Finish it.', skill: 'goal' }, {
    clientFactory: () => client,
    sessionFactory(input) {
      return new SimpleCruiseSession({
        ...input,
        output: { write() {} },
        errorOutput: { write(value) { errorOutput += value; } },
        firstTurnDeadlineMs: 10,
        firstTurnCleanupDeadlineMs: 20,
      });
    },
  });
  assert.equal(result, 4);
  assert.deepEqual(client.statuses, ['active', 'paused']);
  assert.match(errorOutput, /Cruise: app-server started\./u);
  assert.match(errorOutput, /Cruise: waiting for the native Goal turn\./u);
});

test('transport inactivity maps to exit code 5', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-start-inactivity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runStart({ cwd: root, prompt: 'Finish it.', skill: 'quick' }, {
    clientFactory: () => new EventEmitter(),
    sessionFactory() {
      return {
        async run() {
          const error = new Error('transport inactivity observed');
          error.code = 'CRUISE_TRANSPORT_INACTIVITY';
          throw error;
        },
        async interrupt() {},
      };
    },
  });
  assert.equal(result, 5);
});

test('Claude start uses the native Claude adapter and preserves the ORIGIN note', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-start-claude-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const result = await runStart({
    cwd: root,
    prompt: 'Implement it.',
    skill: 'goal',
    provider: 'claude',
  }, {
    async claudeRunner(input) {
      calls.push(input);
      return { status: 'complete', exitCode: 0 };
    },
  });
  assert.equal(result, 0);
  assert.equal(await readOriginPrompt(root), 'Implement it.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, await realpath(root));
  assert.equal(calls[0].skill, 'goal');
  assert.match(calls[0].pluginRoot, /cruise$/u);
});

test('Claude resume preserves the original request and does not reinvoke the Goal skill', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-resume-claude-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runStart({
    cwd: root,
    prompt: 'Original intention.',
    skill: 'goal',
    provider: 'claude',
  }, {
    async claudeRunner() {
      return { status: 'complete', exitCode: 0 };
    },
  });
  const calls = [];
  assert.equal(await runStart({
    cwd: root,
    prompt: '',
    skill: 'goal',
    provider: 'claude',
    resumeSessionId: '12345678-abcd',
  }, {
    async claudeRunner(input) {
      calls.push(input);
      return { status: 'complete', exitCode: 0 };
    },
  }), 0);
  assert.equal(await readOriginPrompt(root), 'Original intention.');
  assert.equal(calls[0].prompt, '');
  assert.equal(calls[0].resumeSessionId, '12345678-abcd');
});

test('Claude non-Goal runs reserve the workspace without activating Goal supervision', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-quick-claude-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let active;
  assert.equal(await runStart({
    cwd: root,
    prompt: 'Patch it.',
    skill: 'quick',
    provider: 'claude',
  }, {
    async claudeRunner(input) {
      active = await isGoalSessionActive({
        cwd: input.cwd,
        session_id: input.sessionId,
      });
      return { status: 'complete', exitCode: 0 };
    },
  }), 0);
  assert.equal(active, false);
});

test('Codex Doctor checks transport and the effective installed Cruise plugin version', () => {
  const calls = [];
  const report = localDoctorReport((binary, args) => {
    calls.push([binary, args]);
    return {
      status: 0,
      output: args[0] === '--version'
        ? 'codex 1.0'
        : args[0] === 'plugin'
          ? JSON.stringify({
              installed: [{
                name: 'cruise',
                version: CLI_VERSION,
                installed: true,
                enabled: true,
              }],
            })
          : 'help',
      error: '',
    };
  });
  assert.equal(report.ok, true);
  assert.equal(report.provider, 'codex');
  assert.deepEqual(report.checks.map(({ id }) => id), ['codex', 'app-server', 'codex-plugin']);
  assert.deepEqual(calls, [
    ['codex', ['--version']],
    ['codex', ['app-server', '--help']],
    ['codex', ['plugin', 'list', '--json']],
  ]);
  const stale = localDoctorReport((binary, args) => ({
    status: 0,
    output: args[0] === 'plugin'
      ? JSON.stringify({
          installed: [{
            name: 'cruise',
            version: '0.3.0',
            installed: true,
            enabled: true,
          }],
        })
      : 'ok',
    error: '',
  }));
  assert.equal(stale.ok, false);
  assert.match(
    stale.checks.find(({ id }) => id === 'codex-plugin').detail,
    /Codex has Cruise 0\.3\.0/u,
  );
});

test('Claude Doctor checks the CLI, plugin, and authentication', () => {
  const calls = [];
  const report = localDoctorReport((binary, args) => {
    calls.push([binary, args]);
    return {
      status: 0,
      output: args[0] === '--version'
        ? '2.1.209'
        : args[0] === 'auth'
          ? '{"loggedIn":true,"email":"dev@example.com"}'
          : 'valid',
      error: '',
    };
  }, { provider: 'claude', pluginRoot: '/tmp/cruise' });
  assert.equal(report.ok, true);
  assert.equal(report.provider, 'claude');
  assert.deepEqual(report.checks.map(({ id }) => id), [
    'claude',
    'claude-plugin',
    'claude-auth',
    'claude-health',
  ]);
  assert.deepEqual(calls, [
    ['claude', ['--version']],
    ['claude', ['plugin', 'validate', '/tmp/cruise']],
    ['claude', ['auth', 'status']],
    ['claude', ['doctor']],
  ]);
});
