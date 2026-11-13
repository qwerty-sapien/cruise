import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  CODEX_PLUGIN_FRESHNESS_PATHS,
  CLI_VERSION,
  codexPluginContentFreshness,
  localDoctorReport,
  parseArgs,
  PUBLIC_SKILLS,
  runAttest,
  runCommitChangelog,
  runOneGoal,
  runReference,
  runStart,
  runWorker,
  surfaceAppServerStderr,
} from '../index.js';
import { readOriginPrompt, writeOriginPrompt } from '../scripts/lib/origin-note.mjs';
import { writeFlightPlan } from '../scripts/lib/flight-plan.mjs';
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
  assert.match(help.stdout, /cruise reference --status/u);
  assert.match(help.stdout, /--reasoning-escalation-evidence <text>/u);
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
    userStatus: null,
    commit: null,
    weeklyDeltaCap: 9,
    goalReservation: 2.25,
    strictBudget: false,
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
    userStatus: null,
    commit: null,
    weeklyDeltaCap: 9,
    goalReservation: 2.25,
    strictBudget: false,
    promptParts: ['Run', 'tests'],
    prompt: 'Run tests',
  });
  assert.equal(parseArgs(['config', 'show']).configAction, 'show');
  assert.throws(() => parseArgs(['config', 'class']), /requires show or validate/u);
  assert.throws(() => parseArgs(['worker', '--level', '8', 'Run']), /integer from 1 through 7/u);
  assert.throws(() => parseArgs(['quick', '--level', '5', 'Fix']), /only by cruise worker/u);
  assert.throws(() => parseArgs(['goal', '--packet', 'task.yaml']), /not supported/u);
  assert.throws(() => parseArgs(['doctor', '--install-worker-rule']), /not supported/u);
  assert.throws(() => parseArgs(['picker-demo']), /was removed/u);
  assert.equal(parseArgs(['goal', '--plan', 'Design it']).planOnly, true);
  assert.throws(() => parseArgs(['quick', '--plan', 'Patch it']), /only by cruise goal/u);
  assert.equal(parseArgs(['reference', '--status', 'completed']).userStatus, 'completed');
  assert.equal(
    parseArgs(['--claude', 'changelog', '--commit', 'a1b2c3d4']).commit,
    'a1b2c3d4',
  );
  assert.throws(
    () => parseArgs(['changelog']),
    /requires --commit/u,
  );
  assert.throws(
    () => parseArgs(['reference', '--status', 'complete']),
    /completed, blocked, aborted, unfinished, or not_started/u,
  );
  assert.throws(
    () => parseArgs(['reference', '--status', 'completed', 'extra']),
    /Unexpected reference argument/u,
  );
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

test('the release exposes four public skills plus the internal context policy', async () => {
  assert.deepEqual(PUBLIC_SKILLS, ['build', 'quick', 'goal', 'debug']);
  const discovered = (await readdir(resolve('skills'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(discovered, [...PUBLIC_SKILLS, 'context-economy'].sort());
  const packageVersion = JSON.parse(await readFile(resolve('package.json'), 'utf8')).version;
  const codex = JSON.parse(await readFile(resolve('.codex-plugin/plugin.json'), 'utf8'));
  const claude = JSON.parse(await readFile(resolve('.claude-plugin/plugin.json'), 'utf8'));
  const goalSkill = await readFile(resolve('skills/goal/SKILL.md'), 'utf8');
  assert.equal(packageVersion, '0.4.3');
  assert.equal(codex.version, packageVersion);
  assert.equal(claude.version, packageVersion);
  assert.doesNotMatch(JSON.stringify(codex.interface.defaultPrompt), /refine/u);
  assert.match(goalSkill, /native\s+parallel bookkeeping agent/u);
  assert.match(goalSkill, /cruise changelog --commit <oid>/u);
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
      assert.equal((await lstat(input.runtimeDirectory)).isDirectory(), true);
      return { output: '', effectsObserved: false };
    },
  });
  assert.equal(result, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, process.cwd());
  assert.equal(calls[0].task, 'Run one check.');
  assert.equal(calls[0].level, 5);
  assert.equal(typeof calls[0].sessionId, 'string');
  await assert.rejects(lstat(calls[0].runtimeDirectory), { code: 'ENOENT' });
  assert.equal(typeof calls[0].onOutput, 'function');
  assert.equal(typeof calls[0].onServerRequest, 'function');
});

test('managed CLI routing requires explicit reasoning evidence for an L6-to-L7 transition', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-managed-l7-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const handoff = JSON.stringify({
    outcome: 'Completed the bounded routing check.',
    completed_work: ['Observed the selected worker request.'],
    changed_files: [],
    decisions_and_invariants: ['Preserved fail-closed model selection.'],
    exact_tests: ['node --test tests/cli-simple.test.mjs'],
    active_blocker_or_next_work_item: 'None.',
    files_not_to_reread: [],
    evidence_pointers: [],
    usage_and_quota_summary: 'Mock worker; no model usage.',
  });
  const worker = async (input) => {
    calls.push(input);
    return { output: handoff, effectsObserved: false };
  };
  const dispatchLedgerFactory = () => ({
    async reserve() {
      return { async release() {} };
    },
  });
  const common = [
    '--managed',
    '--owns', 'scripts/lib/simple-worker.mjs',
    '--evidence', 'The build tool exited before producing a result.',
    '--range', 'scripts/lib/simple-worker.mjs:140-190',
    '--verify', 'node --test tests/simple-worker.test.mjs',
    '--exceptional-consequence', 'irreversible production effect',
    '--exceptional-rationale', 'the focused trace proves there is no rollback path',
    '-C', root,
  ];

  await runWorker(parseArgs([
    'worker', ...common, '--complexity', 'exceptional', 'Run', 'direct', 'exceptional', 'work.',
  ]), { worker, dispatchLedgerFactory });
  await runWorker(parseArgs([
    'worker', ...common, '--complexity', 'repeated', '--level', '7',
    'Retry', 'after', 'the', 'tool', 'failure.',
  ]), { worker, dispatchLedgerFactory });
  await runWorker(parseArgs([
    'worker', ...common, '--complexity', 'repeated', '--level', '7',
    '--reasoning-escalation-evidence', 'The focused trace isolates reasoning as the remaining uncertainty.',
    'Resolve', 'the', 'isolated', 'reasoning', 'blocker.',
  ]), { worker, dispatchLedgerFactory });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].level, 7);
  assert.equal(calls[0].transition, null);
  assert.equal(calls[1].level, 7);
  assert.equal(calls[1].transition, null);
  assert.equal(calls[2].level, 7);
  assert.deepEqual(calls[2].transition, {
    kind: 'escalation',
    work_item: 'Resolve the isolated reasoning blocker.',
    evidence: 'The focused trace isolates reasoning as the remaining uncertainty.',
    from_level: 6,
    failure_category: 'reasoning',
    exceptional_consequence: {
      consequence: 'irreversible production effect',
      rationale: 'the focused trace proves there is no rollback path',
    },
  });
  assert.match(calls[2].task, /The focused trace isolates reasoning as the remaining uncertainty\./u);
});

test('reasoning escalation evidence rejects incomplete or non-Codex worker routes', () => {
  const common = [
    'worker',
    '--managed',
    '--owns', 'scripts/lib/simple-worker.mjs',
    '--evidence', 'A generic context fact.',
    '--range', 'scripts/lib/simple-worker.mjs:140-190',
    '--verify', 'node --test tests/simple-worker.test.mjs',
    '--complexity', 'repeated',
    '--level', '7',
    '--exceptional-consequence', 'irreversible production effect',
    '--exceptional-rationale', 'the focused trace proves there is no rollback path',
    '--reasoning-escalation-evidence', 'Reasoning remains the isolated blocker.',
    'Resolve', 'it.',
  ];
  const without = (...values) => common.filter((value) => !values.includes(value));
  const replace = (from, to) => common.map((value) => value === from ? to : value);

  assert.throws(
    () => parseArgs(without('--managed')),
    /requires a managed Codex worker/u,
  );
  assert.throws(
    () => parseArgs(replace('repeated', 'complex')),
    /requires a managed Codex worker/u,
  );
  assert.throws(
    () => parseArgs(without('--level', '7')),
    /requires a managed Codex worker/u,
  );
  assert.throws(
    () => parseArgs(without('--exceptional-consequence', 'irreversible production effect')),
    /must be supplied together/u,
  );
  assert.throws(
    () => parseArgs(without(
      '--exceptional-consequence',
      'irreversible production effect',
      '--exceptional-rationale',
      'the focused trace proves there is no rollback path',
    )),
    /requires a managed Codex worker/u,
  );
  assert.throws(
    () => parseArgs(['--claude', ...common]),
    /requires a managed Codex worker/u,
  );
});

test('reference command delegates deterministic user-document writing without reading outputs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-reference-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeOriginPrompt(root, 'Keep the exact request.');
  const calls = [];
  const finalizations = [];
  let output = '';
  const result = await runReference({
    cwd: root,
    provider: 'codex',
    userStatus: 'completed',
  }, {
    async userDocumentWriter(input) {
      calls.push(input);
      return {
        referencePath: join(root, '_FOR_USER_REFERENCE.md'),
        changelogPath: join(root, '_CHANGELOG.md'),
      };
    },
    async controlFinalizer(cwd, input) {
      finalizations.push({ cwd, input });
    },
    output: { write(value) { output += value; } },
  });
  assert.equal(result, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, 'Keep the exact request.');
  assert.equal(calls[0].status, 'completed');
  assert.equal(calls[0].includeFlight, true);
  assert.deepEqual(finalizations, [{
    cwd: await realpath(root),
    input: { status: 'complete', started: true },
  }]);
  assert.match(output, /_FOR_USER_REFERENCE\.md/u);
  assert.doesNotMatch(output, /_CHANGELOG\.md/u);
});

test('direct changelog command delegates one exact commit through isolated scratch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-changelog-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  let output = '';
  const result = await runCommitChangelog({
    cwd: root,
    provider: 'codex',
    commit: 'a1b2c3d4',
  }, {
    async runtimeFactory(input) {
      calls.push(['runtime', input]);
      return join(root, 'runtime');
    },
    observerFactory(input) {
      calls.push(['observer', input]);
      return {
        async processCommit(commit) { calls.push(['commit', commit]); },
      };
    },
    async runtimeCleanup(directory, input) {
      calls.push(['cleanup', directory, input]);
    },
    output: { write(value) { output += value; } },
  });
  assert.equal(result, 0);
  assert.equal(calls[0][0], 'runtime');
  assert.equal(calls[0][1].kind, 'changelog');
  assert.equal(calls[1][0], 'observer');
  assert.deepEqual(calls[2], ['commit', 'a1b2c3d4']);
  assert.equal(calls[3][0], 'cleanup');
  assert.match(output, /Recorded commit a1b2c3d4/u);
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

test('a completed ordinary Cruise task removes its transient ORIGIN control file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-start-simple-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prompt = 'Keep these two spaces.  \nAnd this newline.';
  let clientOptions;
  assert.equal(await runStart({ cwd: root, prompt, skill: 'quick' }, {
    clientFactory: (options) => {
      clientOptions = options;
      return new StartClient();
    },
  }), 0);
  assert.equal(typeof clientOptions.spawnOptions.env.CRUISE_RUNTIME_DIR, 'string');
  assert.equal(typeof clientOptions.spawnOptions.env.CRUISE_SESSION_ID, 'string');
  await assert.rejects(lstat(clientOptions.spawnOptions.env.CRUISE_RUNTIME_DIR), { code: 'ENOENT' });
  await assert.rejects(readOriginPrompt(root), { code: 'ENOENT' });
});

test('launcher runs commit observation around the hosted session before deleting scratch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-start-summary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documentCalls = [];
  const lifecycle = [];
  let runtimeDirectory;
  assert.equal(await runStart({ cwd: root, prompt: 'Patch the script.', skill: 'goal' }, {
    clientFactory: () => ({}),
    commitObserverFactory(input) {
      runtimeDirectory = input.runtimeDirectory;
      return {
        async start() {
          lifecycle.push('observer:start');
          assert.equal((await lstat(runtimeDirectory)).isDirectory(), true);
        },
        async stop() {
          lifecycle.push('observer:stop');
          assert.equal((await lstat(runtimeDirectory)).isDirectory(), true);
        },
      };
    },
    sessionFactory(input) {
      return {
        async run() {
          lifecycle.push('session');
          return { status: 'complete' };
        },
        async interrupt() {},
      };
    },
    async userDocumentWriter(input) { documentCalls.push(input); },
  }), 0);
  assert.deepEqual(lifecycle, ['observer:start', 'session', 'observer:stop']);
  assert.equal(documentCalls[0].changeSummaries, undefined);
  await assert.rejects(lstat(runtimeDirectory), { code: 'ENOENT' });
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
  const documentCalls = [];
  const result = await runStart({ cwd: root, prompt: 'Finish it.', skill: 'goal' }, {
    clientFactory: () => ({}),
    sessionFactory(input) {
      assert.equal(input.cwd, canonicalRoot);
      return {
        async run() { return { status: 'stalled' }; },
        async interrupt() {},
      };
    },
    async userDocumentWriter(input) { documentCalls.push(input); },
  });
  assert.equal(result, 3);
  assert.equal(documentCalls.length, 1);
  assert.equal(documentCalls[0].status, 'stalled');
  assert.equal(documentCalls[0].started, true);
  assert.equal(documentCalls[0].includeFlight, false);
});

test('a fresh failed Goal never records an unchanged prior Flight as current', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-start-stale-flight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFlightPlan(root, {
    version: 1,
    status: 'complete',
    outcome: 'Unrelated prior Goal',
    verify: [],
    scope: { touchpoints: [], nonGoals: [] },
    invariants: [],
    stall: { quietTurns: 3, sameFailure: 3 },
    body: '# Prior Goal',
  });
  const documentCalls = [];
  assert.equal(await runStart({
    cwd: root,
    prompt: 'Start a different Goal.',
    skill: 'goal',
    provider: 'codex',
  }, {
    clientFactory: () => ({}),
    sessionFactory() {
      return {
        async run() { return { status: 'stalled' }; },
        async interrupt() {},
      };
    },
    async userDocumentWriter(input) { documentCalls.push(input); },
  }), 3);
  assert.equal(documentCalls.length, 1);
  assert.equal(documentCalls[0].includeFlight, false);
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
        return { thread: { id: 'thread-timeout' }, model: 'gpt-5.6-sol', reasoningEffort: 'high' };
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
  const documentCalls = [];
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
    async userDocumentWriter(input) { documentCalls.push(input); },
  });
  assert.equal(result, 4);
  assert.deepEqual(client.statuses, ['active', 'paused']);
  assert.match(errorOutput, /Cruise: app-server started\./u);
  assert.match(errorOutput, /Cruise: waiting for the native Goal turn\./u);
  assert.equal(documentCalls.length, 1);
  assert.equal(documentCalls[0].status, 'failed');
  assert.equal(documentCalls[0].started, false);
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

test('Claude start receives an exact runtime directory and removes terminal control files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-start-claude-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const documentCalls = [];
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
    async userDocumentWriter(input) { documentCalls.push(input); },
  });
  assert.equal(result, 0);
  await assert.rejects(readOriginPrompt(root), { code: 'ENOENT' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, await realpath(root));
  assert.equal(calls[0].skill, 'goal');
  assert.match(calls[0].runtimeDirectory, /cruise-runs/u);
  assert.equal(calls[0].pluginRoot, await realpath(new URL('..', import.meta.url)));
  assert.equal(documentCalls.length, 1);
  assert.equal(documentCalls[0].status, 'complete');
  assert.equal(documentCalls[0].started, true);
});

test('Claude resume preserves a blocked original request and does not reinvoke the Goal skill', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-resume-claude-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runStart({
    cwd: root,
    prompt: 'Original intention.',
    skill: 'goal',
    provider: 'claude',
  }, {
    async claudeRunner() {
      return { status: 'blocked', exitCode: 2 };
    },
  });
  assert.equal(await readOriginPrompt(root), 'Original intention.');
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
  await assert.rejects(readOriginPrompt(root), { code: 'ENOENT' });
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

test('Codex Doctor checks transport, version, and effective installed Cruise content', () => {
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
  }, {
    pluginFreshness: () => ({ status: 'pass', detail: 'critical bytes match' }),
  });
  assert.equal(report.ok, true);
  assert.equal(report.provider, 'codex');
  assert.deepEqual(report.checks.map(({ id }) => id), [
    'codex',
    'app-server',
    'codex-plugin',
    'codex-plugin-content',
  ]);
  assert.equal(report.checks.at(-1).status, 'pass');
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
  assert.equal(stale.checks.find(({ id }) => id === 'codex-plugin-content').status, 'fail');
});

test('Codex plugin freshness detects same-version source and cache drift', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-plugin-freshness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  const codexHomeDirectory = join(root, 'codex-home');
  const installedRoot = join(
    codexHomeDirectory,
    'plugins',
    'cache',
    'agent-local',
    'cruise',
    CLI_VERSION,
  );
  for (const relativePath of CODEX_PLUGIN_FRESHNESS_PATHS) {
    const sourcePath = join(sourceRoot, relativePath);
    const installedPath = join(installedRoot, relativePath);
    await Promise.all([
      mkdir(dirname(sourcePath), { recursive: true }),
      mkdir(dirname(installedPath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(sourcePath, `source:${relativePath}\n`),
      writeFile(installedPath, `source:${relativePath}\n`),
    ]);
  }
  const plugin = {
    marketplaceName: 'agent-local',
    name: 'cruise',
    version: CLI_VERSION,
    source: { source: 'local', path: sourceRoot },
  };
  assert.deepEqual(
    codexPluginContentFreshness(plugin, { codexHomeDirectory }),
    { status: 'pass', detail: `Cruise ${CLI_VERSION} cache matches its configured source` },
  );

  await writeFile(join(sourceRoot, 'skills/goal/SKILL.md'), 'patched instructions\n');
  const stale = codexPluginContentFreshness(plugin, { codexHomeDirectory });
  assert.equal(stale.status, 'fail');
  assert.match(stale.detail, /cache is stale/u);
  assert.match(stale.detail, /active jobs selectively reconcile instruction drift/u);
  assert.match(stale.detail, /without a waiver or forced restart/u);
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
