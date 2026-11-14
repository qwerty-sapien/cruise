import { INDEPENDENT_RELEASE_INSTRUCTIONS } from '../scripts/lib/release-policy.mjs';
import { COLLABORATIVE_GIT_SYNC_INSTRUCTIONS } from '../scripts/lib/git-sync-policy.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { changelogSummaryTask } from '../scripts/lib/changelog-observer.mjs';
import test from 'node:test';

import {
  CLAUDE_WORKER_LEVEL_POLICY,
  claudeChangelogWorkerArgs,
  claudeSessionArgs,
  claudeWorkerArgs,
  runClaudeChangelogWorker,
  runClaudeCli,
  runClaudeCaptured,
  runClaudeSession,
  runClaudeWorker,
} from '../scripts/lib/claude-cli.mjs';

test('Claude changelog accepts structured source evidence with the shared instruction guards', () => {
  const task = changelogSummaryTask({ commitEvidence: [{ path: 'fixture.mjs',
    patch: 'export const example = "config/credentials.json";', action: 'new' }], overallEvidence: [] });
  const args = claudeChangelogWorkerArgs({ task });
  assert.ok(args.every((arg) => typeof arg === 'string'));
  assert.match(args.at(-1), /Immutable evidence data follows as JSON/u);
  assert.match(args.at(-1), /config\/credentials\.json/u);
  assert.throws(() => claudeChangelogWorkerArgs({ task: { ...task, instructions: 'Read .env' } }), /sensitive path/u);
  const marker = '-----BEGIN PRIVATE KEY-----';
  assert.throws(() => claudeChangelogWorkerArgs({ task: { ...task, evidence: JSON.stringify({ marker }) } }), /credential|secret|private.key/iu);
});

test('captured native Claude failure recovers once, then pauses without replay', async () => {
  let spawned = 0, recoveries = 0;
  const { createNativeAuthNormalizer } = await import('../scripts/lib/auth-recovery-runtime.mjs');
  await assert.rejects(runClaudeChangelogWorker({ cwd: '/fixture', task: 'Summarize supplied evidence.',
    authRecovery: { normalize: createNativeAuthNormalizer(), async recover(input) {
      recoveries++; assert.equal(input.provider, 'claude');
      assert.equal(input.evidence.credentialState, 'expired'); return { status: 'recovered' };
    } },
    spawnFn() {
      spawned++;
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ type: 'assistant', error: 'authentication_failed', message: { content: [{
          type: 'text', text: 'Failed to authenticate: OAuth session expired and could not be refreshed',
        }] } }) + '\n');
        child.emit('close', 1);
      }); return child;
    },
  }), error => error.code === 'CRUISE_AUTH_RECOVERY_PAUSE' && error.exitCode === 6);
  assert.equal(spawned, 1); assert.equal(recoveries, 1);
});

test('captured model prose and generic auth failure never launch login', async () => {
  let recoveries = 0;
  const { createNativeAuthNormalizer } = await import('../scripts/lib/auth-recovery-runtime.mjs');
  for (const envelope of [
    { type: 'result', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' },
    { type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'API Error: 401' }] } },
  ]) await assert.rejects(runClaudeCaptured({ cwd: '/fixture', args: ['-p'],
    authRecovery: { normalize: createNativeAuthNormalizer(), recover() { recoveries++; } },
    spawnFn() {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      queueMicrotask(() => { child.stdout.end(JSON.stringify(envelope)); child.emit('close', 1); });
      return child;
    },
  }), /exited 1/);
  assert.equal(recoveries, 0);
});

test('captured Claude cancellation waits for owned process group cleanup', async () => {
  const signals = new EventEmitter(), sent = []; let alive = true, child;
  await assert.rejects(runClaudeCaptured({ cwd: '/fixture', args: ['-p'], signals, cleanupMs: 5,
    spawnFn() {
      child = new EventEmitter(); child.pid = 3456;
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      queueMicrotask(() => signals.emit('SIGTERM')); return child;
    },
    kill(pid, signal) {
      assert.equal(pid, -3456);
      if (!alive) throw Object.assign(new Error(), { code: 'ESRCH' });
      sent.push(signal);
      if (signal === 'SIGTERM') { alive = false; child.emit('close', null, 'SIGTERM'); }
    },
  }), { code: 'CRUISE_INTERRUPTED' });
  assert.ok(sent.includes('SIGTERM')); assert.equal(alive, false);
  assert.equal(signals.listenerCount('SIGTERM'), 0); assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('non-TTY Claude worker preserves final output and invokes native stream-json once', async () => {
  const chunks = []; let count = 0;
  const result = await runClaudeWorker({ cwd: '/fixture', task: 'Inspect fixture.', input: { isTTY: false },
    onOutput: text => chunks.push(text), spawnFn(command, args) {
      count++; assert.equal(command, 'claude'); assert.equal(args[0], '-p');
      assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      queueMicrotask(() => { child.stdout.end(JSON.stringify({ type: 'result', is_error: false, result: 'Fixture complete.' })); child.emit('close', 0); });
      return child;
    },
  });
  assert.equal(count, 1); assert.equal(result.output, 'Fixture complete.'); assert.deepEqual(chunks, ['Fixture complete.']);
});

test('Claude sessions load the plugin and invoke the slash-command skill natively', () => {
  const args = claudeSessionArgs({
    pluginRoot: '/workspace/cruise',
    skill: 'goal',
    prompt: 'Complete the migration.',
  });
  assert.deepEqual(args.slice(0, 4), [
    '--plugin-dir',
    '/workspace/cruise',
    '--name',
    'Cruise goal',
  ]);
  assert.equal(args.at(-1), '/cruise:goal Complete the migration.');
  assert.equal(args.includes('--permission-mode'), false);
  assert.match(args[args.indexOf('--append-system-prompt') + 1], /no documented Codex-style Goal lifecycle API/u);
  assert.ok(args[args.indexOf('--append-system-prompt') + 1].includes(INDEPENDENT_RELEASE_INSTRUCTIONS));
  assert.ok(args[args.indexOf('--append-system-prompt') + 1].includes(COLLABORATIVE_GIT_SYNC_INSTRUCTIONS));
  assert.match(args[args.indexOf('--append-system-prompt') + 1], /write-only user references/u);
  assert.match(args[args.indexOf('--append-system-prompt') + 1], /\.cruise\/FLIGHT\.md/u);
  assert.match(args[args.indexOf('--append-system-prompt') + 1], /Stop-hook supervisor/u);
  assert.match(args[args.indexOf('--append-system-prompt') + 1], /host-access-approved local director/u);
  assert.match(args[args.indexOf('--append-system-prompt') + 1], /non-admin users/u);
  assert.doesNotMatch(args[args.indexOf('--append-system-prompt') + 1], /change-summaries|bird-eye summary/u);
  const planArgs = claudeSessionArgs({
    pluginRoot: '/workspace/cruise',
    skill: 'goal',
    prompt: 'Design it.',
    planOnly: true,
  });
  assert.deepEqual(
    planArgs.slice(planArgs.indexOf('--permission-mode'), planArgs.indexOf('--permission-mode') + 2),
    ['--permission-mode', 'plan'],
  );
  const resumeArgs = claudeSessionArgs({
    pluginRoot: '/workspace/cruise',
    skill: 'goal',
    prompt: '',
    resumeSessionId: '12345678-abcd',
  });
  assert.deepEqual(
    resumeArgs.slice(resumeArgs.indexOf('--resume'), resumeArgs.indexOf('--resume') + 2),
    ['--resume', '12345678-abcd'],
  );
  assert.equal(resumeArgs.includes('--session-id'), false);
  assert.equal(resumeArgs.some((arg) => /cruise:goal/u.test(arg)), false);
});

test('the published package contains both plugin manifests and only the active runtime closure', async () => {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(metadata.files.includes('.codex-plugin/'), true);
  assert.equal(metadata.files.includes('.claude-plugin/'), true);
  assert.equal(metadata.files.includes('hooks/'), true);
  assert.equal(metadata.files.includes('scripts/'), false);
  assert.equal(metadata.files.includes('scripts/cruise.mjs'), true);
  assert.equal(metadata.files.includes('scripts/lib/provider.mjs'), true);
  assert.equal(metadata.files.includes('scripts/lib/claude-cli.mjs'), true);
  assert.equal(metadata.files.includes('scripts/lib/changelog-observer.mjs'), true);
  assert.equal(metadata.files.includes('scripts/lib/assurance.mjs'), true);
  assert.equal(metadata.files.includes('scripts/lib/flight-plan.mjs'), true);
  assert.equal(metadata.files.includes('scripts/lib/queue.mjs'), true);
  assert.equal(metadata.files.some((entry) => entry.includes('refine')), false);
});

test('Claude changelog workers are captured, read-only, and detached from Goal hook state', async () => {
  const args = claudeChangelogWorkerArgs({ task: 'Return JSON.' });
  assert.equal(args.includes('-p'), true);
  assert.deepEqual(
    args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2),
    ['--permission-mode', 'plan'],
  );
  const calls = [];
  class Child extends EventEmitter {
    constructor() {
      super();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
    }
  }
  const promise = runClaudeChangelogWorker({
    cwd: '/runtime',
    task: 'Return JSON.',
    env: {
      BASE: 'kept',
      CRUISE_RUNTIME_DIR: '/private/runtime',
      CRUISE_SESSION_ID: 'goal-session',
      CRUISE_CLAUDE_GOAL: '1',
    },
    spawnFn(command, workerArgs, options) {
      calls.push({ command, workerArgs, options });
      const child = new Child();
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ result: '{"version":1}' }));
        child.emit('close', 0, null);
      });
      return child;
    },
  });
  assert.equal(await promise, '{"version":1}');
  assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(calls[0].options.cwd, '/runtime');
  assert.deepEqual(calls[0].options.env, { BASE: 'kept' });
});

test('Claude worker levels map to Claude model aliases and native effort values', () => {
  assert.deepEqual(CLAUDE_WORKER_LEVEL_POLICY[1], { model: 'haiku', effort: 'low' });
  assert.deepEqual(CLAUDE_WORKER_LEVEL_POLICY[7], { model: 'opus', effort: 'max' });
  const defaultArgs = claudeWorkerArgs({ task: 'Run tests.' });
  assert.equal(defaultArgs.includes('--model'), false);
  assert.equal(defaultArgs.includes('--effort'), false);
  const selectedArgs = claudeWorkerArgs({ task: 'Run tests.', level: 6 });
  assert.match(
    selectedArgs[selectedArgs.indexOf('--append-system-prompt') + 1],
    /not by itself a new third-party provider disclosure/u,
  );
  assert.deepEqual(
    selectedArgs.slice(selectedArgs.indexOf('--model'), selectedArgs.indexOf('--model') + 4),
    ['--model', 'opus', '--effort', 'high'],
  );
});

test('Claude CLI transport inherits the native TUI and returns its exit status', async () => {
  const calls = [];
  class Child extends EventEmitter {}
  const resultPromise = runClaudeCli({
    cwd: '/workspace',
    args: ['--version'],
    env: { TEST: '1' },
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      const child = new Child();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    },
  });
  assert.deepEqual(await resultPromise, { code: 0, signal: null });
  assert.equal(calls[0].command, 'claude');
  assert.equal(calls[0].options.stdio, 'inherit');
  assert.equal(calls[0].options.cwd, '/workspace');
});

test('Claude Goal sessions pass exact session-scoped runtime state to hooks and children', async () => {
  const calls = [];
  class Child extends EventEmitter {}
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new Child();
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  };
  await runClaudeSession({
    cwd: '/workspace',
    pluginRoot: '/plugin',
    skill: 'goal',
    prompt: 'Finish it.',
    env: { BASE: 'kept' },
    spawnFn,
  });
  await runClaudeSession({
    cwd: '/workspace',
    pluginRoot: '/plugin',
    skill: 'quick',
    prompt: 'Patch it.',
    env: { BASE: 'kept', CRUISE_CLAUDE_GOAL: '1' },
    spawnFn,
  });
  assert.equal(calls[0].options.env.BASE, 'kept');
  assert.equal(calls[0].options.env.CRUISE_CLAUDE_GOAL, '1');
  assert.equal(typeof calls[0].options.env.CRUISE_RUNTIME_DIR, 'string');
  assert.equal(typeof calls[0].options.env.CRUISE_SESSION_ID, 'string');
  assert.deepEqual(calls[1].options.env, { BASE: 'kept' });
  assert.equal(calls[0].args.includes('--session-id'), true);
  assert.equal(calls[1].args.includes('--session-id'), true);
  assert.notEqual(
    calls[0].args[calls[0].args.indexOf('--session-id') + 1],
    calls[1].args[calls[1].args.indexOf('--session-id') + 1],
  );
});

test('Claude process exit zero cannot masquerade as Goal completion', async () => {
  class Child extends EventEmitter {}
  const spawnFn = () => {
    const child = new Child();
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  };
  const common = {
    cwd: '/workspace',
    pluginRoot: '/plugin',
    skill: 'goal',
    prompt: 'Finish it.',
    spawnFn,
  };
  const active = await runClaudeSession({
    ...common,
    inspectPlan: async () => ({
      state: 'valid',
      plan: { version: 1, status: 'active' },
    }),
  });
  assert.deepEqual(
    { status: active.status, exitCode: active.exitCode },
    { status: 'stalled', exitCode: 3 },
  );

  const blocked = await runClaudeSession({
    ...common,
    inspectPlan: async () => ({
      state: 'valid',
      plan: { version: 1, status: 'blocked' },
    }),
  });
  assert.deepEqual(
    { status: blocked.status, exitCode: blocked.exitCode },
    { status: 'blocked', exitCode: 2 },
  );

  const absent = await runClaudeSession({
    ...common,
    inspectPlan: async () => ({ state: 'absent' }),
  });
  assert.deepEqual(
    { status: absent.status, exitCode: absent.exitCode },
    { status: 'unassured', exitCode: 2 },
  );
});
