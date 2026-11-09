import assert from 'node:assert/strict';
import { COLLABORATIVE_GIT_SYNC_INSTRUCTIONS } from '../scripts/lib/git-sync-policy.mjs';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CLAUDE_WORKER_LEVEL_POLICY,
  claudeSessionArgs,
  claudeWorkerArgs,
  runClaudeCli,
  runClaudeSession,
} from '../scripts/lib/claude-cli.mjs';

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
  assert.ok(args[args.indexOf('--append-system-prompt') + 1].includes(COLLABORATIVE_GIT_SYNC_INSTRUCTIONS));
  assert.match(args[args.indexOf('--append-system-prompt') + 1], /\.cruise\/FLIGHT\.md/u);
  assert.match(args[args.indexOf('--append-system-prompt') + 1], /Stop-hook supervisor/u);
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
  assert.equal(metadata.files.includes('scripts/lib/assurance.mjs'), true);
  assert.equal(metadata.files.includes('scripts/lib/flight-plan.mjs'), true);
  assert.equal(metadata.files.includes('scripts/lib/queue.mjs'), true);
  assert.equal(metadata.files.some((entry) => entry.includes('refine')), false);
});

test('Claude worker levels map to Claude model aliases and native effort values', () => {
  assert.deepEqual(CLAUDE_WORKER_LEVEL_POLICY[1], { model: 'haiku', effort: 'low' });
  assert.deepEqual(CLAUDE_WORKER_LEVEL_POLICY[7], { model: 'opus', effort: 'max' });
  const defaultArgs = claudeWorkerArgs({ task: 'Run tests.' });
  assert.equal(defaultArgs.includes('--model'), false);
  assert.equal(defaultArgs.includes('--effort'), false);
  const selectedArgs = claudeWorkerArgs({ task: 'Run tests.', level: 6 });
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

test('Claude Goal sessions use explicit ids and session-scoped supervision without process markers', async () => {
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
  assert.deepEqual(calls[0].options.env, { BASE: 'kept' });
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
