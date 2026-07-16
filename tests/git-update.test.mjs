import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  activeCruiseProcesses,
  installGitUpdateHooks,
  installManagedGitHook,
  MANAGED_HOOK_MARKER,
  renderGitUpdateHook,
  runAutomaticGitUpdate,
  shouldRunGitUpdateHook,
  waitForInstalledPluginReady,
} from '../scripts/lib/git-update.mjs';

test('automatic update idle detection covers workers, Deep Doctor, and troubleshoot', () => {
  const stdout = [
    '10 cruise worker --level 2 -C /tmp/repo',
    '11 cruise doctor --deep --install-worker-rule',
    '12 node /tmp/cruise.mjs doctor --troubleshoot',
    '13 cruise doctor --json',
  ].join('\n');
  const active = activeCruiseProcesses({
    pid: 99,
    run() {
      return { status: 0, stdout };
    },
  });
  assert.deepEqual(active.map(({ pid }) => pid), [10, 11, 12]);
});

test('Git update hooks cover merge, rebase, pull paths, and initial clone checkout only', () => {
  assert.equal(shouldRunGitUpdateHook('post-merge', []), true);
  assert.equal(shouldRunGitUpdateHook('post-rewrite', ['rebase']), true);
  assert.equal(shouldRunGitUpdateHook('post-rewrite', ['amend']), false);
  assert.equal(shouldRunGitUpdateHook('post-checkout', ['0'.repeat(40)]), true);
  assert.equal(shouldRunGitUpdateHook('post-checkout', ['a'.repeat(40)]), false);
  assert.match(renderGitUpdateHook('post-merge'), new RegExp(MANAGED_HOOK_MARKER));
  assert.match(renderGitUpdateHook('post-merge'), /https:\/\/github\.com\/qwerty-sapien\/cruise/u);
  assert.match(renderGitUpdateHook('post-merge'), /command -v cruise/u);
  assert.doesNotMatch(renderGitUpdateHook('post-merge'), /node "\$entrypoint"/u);
  assert.match(renderGitUpdateHook('post-rewrite'), /rebase/u);
  assert.match(renderGitUpdateHook('post-checkout'), /\*\[!0\]\*/u);
});

test('managed hook installation chains an existing hook instead of overwriting it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cruise-git-hook-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const hook = join(directory, 'post-merge');
  await writeFile(hook, '#!/bin/sh\necho existing\n');
  await chmod(hook, 0o755);

  const installed = await installManagedGitHook(hook, 'post-merge');
  assert.equal(installed.chained, true);
  assert.equal(await readFile(`${hook}.cruise-original`, 'utf8'), '#!/bin/sh\necho existing\n');
  assert.match(await readFile(hook, 'utf8'), new RegExp(MANAGED_HOOK_MARKER));

  const updated = await installManagedGitHook(hook, 'post-merge');
  assert.equal(updated.chained, false);
  assert.equal(await readFile(`${hook}.cruise-original`, 'utf8'), '#!/bin/sh\necho existing\n');
});

test('hook installer writes repository and future-clone template hooks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-hooks-root-'));
  const template = await mkdtemp(join(tmpdir(), 'cruise-hooks-template-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(template, { recursive: true, force: true }));
  await mkdir(join(root, '.git', 'hooks'), { recursive: true });

  const result = await installGitUpdateHooks({
    repositoryRoot: root,
    templateRoot: template,
    git(args) {
      assert.deepEqual(args, ['rev-parse', '--git-path', 'hooks']);
      return '.git/hooks';
    },
  });
  assert.equal(result.hooks.length, 6);
  for (const event of ['post-merge', 'post-rewrite', 'post-checkout']) {
    assert.match(await readFile(join(root, '.git', 'hooks', event), 'utf8'), new RegExp(MANAGED_HOOK_MARKER));
    assert.match(await readFile(join(template, 'hooks', event), 'utf8'), new RegExp(MANAGED_HOOK_MARKER));
  }
});

test('managed clone template preserves Git standard template files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-hooks-seeded-root-'));
  const home = await mkdtemp(join(tmpdir(), 'cruise-hooks-seeded-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(root, '.git', 'hooks'), { recursive: true });
  const prefix = join(root, 'git-prefix');
  const execPath = join(prefix, 'libexec', 'git-core');
  const defaultTemplate = join(prefix, 'share', 'git-core', 'templates');
  await mkdir(join(defaultTemplate, 'info'), { recursive: true });
  await mkdir(join(defaultTemplate, 'hooks'), { recursive: true });
  await writeFile(join(defaultTemplate, 'info', 'exclude'), 'standard exclude\n');
  await writeFile(join(defaultTemplate, 'description'), 'standard description\n');
  await writeFile(join(defaultTemplate, 'hooks', 'pre-commit.sample'), 'standard sample\n');

  const result = await installGitUpdateHooks({
    repositoryRoot: root,
    home,
    git(args) {
      if (args[0] === 'rev-parse') return '.git/hooks';
      if (args[0] === '--exec-path') return execPath;
      if (args.includes('--get')) return '';
      if (args[0] === 'config' && args[2] === 'init.templateDir') return '';
      assert.fail(`unexpected git arguments: ${args.join(' ')}`);
    },
  });

  assert.equal(await readFile(join(result.template_root, 'info', 'exclude'), 'utf8'), 'standard exclude\n');
  assert.equal(await readFile(join(result.template_root, 'description'), 'utf8'), 'standard description\n');
  assert.equal(
    await readFile(join(result.template_root, 'hooks', 'pre-commit.sample'), 'utf8'),
    'standard sample\n',
  );
  assert.match(
    await readFile(join(result.template_root, 'hooks', 'post-merge'), 'utf8'),
    new RegExp(MANAGED_HOOK_MARKER),
  );
});

test('automatic Git update waits for idle and runs the exact reinstall and Deep Doctor flow', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-auto-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.codex-plugin'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'cruise',
    version: '1.2.3+codex.test',
  }));
  await writeFile(join(root, 'scripts', 'cruise.mjs'), '');
  const canonicalRoot = await realpath(root);

  const events = [];
  const result = await runAutomaticGitUpdate({
    repositoryRoot: root,
    event: 'post-merge',
    env: {},
    home: join(root, 'home'),
    async waitForIdle() {
      events.push(['idle']);
    },
    lock: async (operation) => {
      events.push(['lock']);
      return operation();
    },
    async ensureMarketplace() {
      events.push(['marketplace']);
      return { marketplace: 'agent-local' };
    },
    listPlugins() {
      return 'cruise@agent-local  installed, enabled  1.2.2  /tmp/cruise';
    },
    run(command, args) {
      events.push([command, ...args]);
      return { status: 0 };
    },
    async waitForPlugin() {
      events.push(['plugin-ready']);
    },
    output: { write() {} },
  });

  assert.equal(result.status, 'complete');
  assert.deepEqual(events.slice(0, 3), [['idle'], ['lock'], ['idle']]);
  assert.deepEqual(events.slice(3), [
    ['marketplace'],
    ['codex', 'plugin', 'remove', 'cruise@agent-local'],
    ['codex', 'plugin', 'add', 'cruise@agent-local'],
    ['plugin-ready'],
    [process.execPath, join(canonicalRoot, 'scripts', 'cruise.mjs'), 'agents', 'install'],
    [
      process.execPath,
      join(canonicalRoot, 'scripts', 'cruise.mjs'),
      'doctor',
      '--deep',
      '--install-worker-rule',
    ],
  ]);
});

test('plugin readiness polls until registry visibility and exact digest both converge', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-plugin-ready-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let probes = 0;
  let sleeps = 0;

  const result = await waitForInstalledPluginReady({
    repositoryRoot: root,
    version: '1.2.3+codex.test',
    env: { CODEX_HOME: join(root, 'codex-home') },
    timeoutMs: 5_000,
    listPlugins() {
      probes += 1;
      return probes < 3
        ? ''
        : 'cruise@agent-local  installed, enabled  1.2.3+codex.test  /tmp/cruise';
    },
    async inspectCache() {
      return {
        matches: true,
        source: { digest: 'digest', file_count: 1 },
        cache: { digest: 'digest' },
        missing: [],
        extra: [],
        changed: [],
      };
    },
    async sleep() {
      sleeps += 1;
    },
  });

  assert.equal(probes, 3);
  assert.equal(sleeps, 2);
  assert.equal(result.digest, 'digest');
});

test('recursive automatic Git updates are suppressed before touching the repository', async () => {
  const result = await runAutomaticGitUpdate({
    repositoryRoot: '/does/not/exist',
    event: 'post-merge',
    env: { CRUISE_AUTO_UPDATE_ACTIVE: '1' },
  });
  assert.deepEqual(result, { status: 'skipped', reason: 'recursive' });
});
