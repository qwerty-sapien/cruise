import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rename, rm, stat, symlink, truncate, unlink, utimes, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';

import { flightPlanTemplate, parseFlightPlan, writeFlightPlan } from '../scripts/lib/flight-plan.mjs';
import { SimpleCruiseSession } from '../scripts/lib/simple-session.mjs';
import { captureWorkspaceFingerprint, NON_GIT_FINGERPRINT_LIMITS } from '../scripts/lib/supervisor.mjs';

const productFingerprint = (cwd) => captureWorkspaceFingerprint(cwd, { excludeFlightPlan: true });
const nativeFilesystem = createRequire(import.meta.url)('node:fs/promises');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cruise-non-git-assurance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function completionSession(root) {
  return new SimpleCruiseSession({
    client: {}, cwd: root, prompt: 'Verify synthetic non-Git product changes.',
    skill: 'goal', skillPath: '/synthetic/goal/SKILL.md',
    pickOne: async () => ({ status: 'cancelled' }), readLine: async () => '',
    requireAssurance: true, output: { write() {} }, errorOutput: { write() {} },
  });
}

test('non-Git hashes content even when size and mtime are preserved, not incidental timestamps', async (t) => {
  const root = await fixture(t);
  const product = join(root, 'product with spaces.txt');
  const timestamp = new Date('2020-01-01T00:00:00Z');
  await writeFile(product, 'before\n');
  await utimes(product, timestamp, timestamp);
  const baseline = await productFingerprint(root);
  assert.match(baseline, /^[a-f\d]{64}$/u);
  assert.equal(await productFingerprint(root), baseline);

  await utimes(product, timestamp, new Date('2021-01-01T00:00:00Z'));
  assert.equal(await productFingerprint(root), baseline, 'timestamps do not define product contents');
  await utimes(product, timestamp, timestamp);
  const before = await stat(product);
  await writeFile(product, 'after!\n');
  await utimes(product, timestamp, timestamp);
  const after = await stat(product);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.notEqual(await productFingerprint(root), baseline);
});

test('non-Git hashes are deterministic across creation order and include names, hidden inputs, and executable bits', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  for (const [root, names] of [[first, ['a.txt', 'b.txt']], [second, ['b.txt', 'a.txt']]]) {
    for (const name of names) await writeFile(join(root, name), name);
  }
  const baseline = await productFingerprint(first);
  assert.equal(await productFingerprint(second), baseline);

  const hidden = join(first, '.product-options');
  await writeFile(hidden, 'enabled\n');
  assert.notEqual(await productFingerprint(first), baseline);
  await unlink(hidden);
  assert.equal(await productFingerprint(first), baseline);

  const unusual = join(first, 'space and [brackets]\nwith newline.txt');
  await writeFile(unusual, 'new product\n');
  const added = await productFingerprint(first);
  assert.notEqual(added, baseline);
  await rename(unusual, join(first, 'renamed.txt'));
  assert.notEqual(await productFingerprint(first), added);
  await unlink(join(first, 'renamed.txt'));
  assert.equal(await productFingerprint(first), baseline);
  if (process.platform !== 'win32') {
    await chmod(join(first, 'a.txt'), 0o755);
    assert.notEqual(await productFingerprint(first), baseline);
  }
});

test('native ignore rules retain nested negation and prune ignored directories', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'ignored'));
  await writeFile(join(root, '.gitignore'), 'ignored/\n!ignored/keep.txt\nignored with spaces.txt\n');
  await writeFile(join(root, 'src', '.gitignore'), '*.txt\n!important.txt\n');
  await writeFile(join(root, 'src', 'important.txt'), 'one\n');
  await writeFile(join(root, 'src', 'discarded.txt'), 'ignored one\n');
  await writeFile(join(root, 'ignored', 'keep.txt'), 'still ignored\n');
  await writeFile(join(root, 'ignored with spaces.txt'), 'ignored\n');
  const baseline = await productFingerprint(root);
  assert.match(baseline, /^[a-f\d]{64}$/u);
  await writeFile(join(root, 'src', 'discarded.txt'), 'ignored two\n');
  await writeFile(join(root, 'ignored', 'keep.txt'), 'still ignored two\n');
  await writeFile(join(root, 'ignored with spaces.txt'), 'ignored two\n');
  assert.equal(await productFingerprint(root), baseline);
  await writeFile(join(root, 'src', 'important.txt'), 'two\n');
  assert.notEqual(await productFingerprint(root), baseline);
});

test('credential, native context, root private notes, and Cruise paths are skipped before content or link resolution', async (t) => {
  const root = await fixture(t);
  const external = await fixture(t);
  await writeFile(join(root, 'product.txt'), 'stable\n');
  await writeFile(join(external, 'simulated-secret.txt'), 'synthetic private fixture\n');
  const baseline = await productFingerprint(root);
  for (const name of ['agents', '.agents', '.codex', '.claude', '.aws', '.config', '.cruise']) {
    await mkdir(join(root, name));
    await symlink(join(external, 'simulated-secret.txt'), join(root, name, 'escape.txt'));
  }
  for (const name of ['_PRIVATE.md', '.env', '.env.local', '.npmrc', 'credentials.json', 'server.key']) {
    await symlink(join(external, 'simulated-secret.txt'), join(root, name));
  }
  assert.equal(await productFingerprint(root), baseline);
});

test('ordinary build, dist, log, dependency, and nested agents names stay product inputs without explicit ignore rules', async (t) => {
  const root = await fixture(t);
  const paths = ['app/build/page.js', 'build/input.txt', 'dist/input.txt', 'logs/input.txt',
    'src/agents/worker.js', 'src/agent-context/page.js', 'node_modules/fixture/input.txt',
    '.next/source.txt', 'output.log', 'input.tmp'];
  for (const path of paths) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, 'before\n');
  }
  const baseline = await productFingerprint(root);
  assert.match(baseline, /^[a-f\d]{64}$/u);
  for (const path of paths) {
    await writeFile(join(root, path), 'after!\n');
    assert.notEqual(await productFingerprint(root), baseline, `${path} must be observed`);
    await writeFile(join(root, path), 'before\n');
    assert.equal(await productFingerprint(root), baseline);
  }
  await writeFile(join(root, '.gitignore'), '/build/\n/dist/\n/logs/\n/node_modules/\n/.next/\n*.log\n*.tmp\n');
  const explicitlyIgnored = await productFingerprint(root);
  for (const path of paths.filter((path) => !path.startsWith('app/') && !path.startsWith('src/'))) {
    await writeFile(join(root, path), 'ignored mutation\n');
  }
  assert.equal(await productFingerprint(root), explicitlyIgnored);
});

test('internal symlinks bind captured targets and escaping, dangling, or excluded targets fail closed', async (t) => {
  const root = await fixture(t);
  const external = await fixture(t);
  await writeFile(join(root, 'one.txt'), 'same\n');
  await writeFile(join(root, 'two.txt'), 'same\n');
  await writeFile(join(external, 'outside.txt'), 'outside\n');
  await symlink('one.txt', join(root, 'link.txt'));
  const baseline = await productFingerprint(root);
  assert.match(baseline, /^[a-f\d]{64}$/u);
  await unlink(join(root, 'link.txt'));
  await symlink('two.txt', join(root, 'link.txt'));
  assert.notEqual(await productFingerprint(root), baseline);
  await unlink(join(root, 'link.txt'));
  await symlink(join(external, 'outside.txt'), join(root, 'link.txt'));
  assert.equal(await productFingerprint(root), null);
  await unlink(join(root, 'link.txt'));
  await symlink('absent.txt', join(root, 'link.txt'));
  assert.equal(await productFingerprint(root), null);
  await unlink(join(root, 'link.txt'));
  await mkdir(join(root, 'agents'));
  await writeFile(join(root, 'agents', 'context.txt'), 'synthetic excluded context\n');
  await symlink('agents/context.txt', join(root, 'link.txt'));
  assert.equal(await productFingerprint(root), null);
});

test('oversized content and ignore files, and excessive depth, have no metadata-only fallback', async (t) => {
  const root = await fixture(t);
  const large = join(root, 'large.bin');
  await writeFile(large, '');
  await truncate(large, NON_GIT_FINGERPRINT_LIMITS.bytes + 1);
  assert.equal(await productFingerprint(root), null);
  await unlink(large);
  await writeFile(join(root, '.gitignore'), 'x'.repeat(NON_GIT_FINGERPRINT_LIMITS.ignoreBytes + 1));
  assert.equal(await productFingerprint(root), null);
  await unlink(join(root, '.gitignore'));
  let directory = root;
  for (let depth = 0; depth <= NON_GIT_FINGERPRINT_LIMITS.depth; depth += 1) {
    directory = join(directory, 'nested');
    await mkdir(directory);
  }
  assert.equal(await productFingerprint(root), null);
});

test('entry caps count excluded names too', async (t) => {
  const root = await fixture(t);
  for (let start = 0; start <= NON_GIT_FINGERPRINT_LIMITS.entries; start += 100) {
    await Promise.all(Array.from({ length: Math.min(100, NON_GIT_FINGERPRINT_LIMITS.entries + 1 - start) }, (_, offset) =>
      writeFile(join(root, `.env.${start + offset}`), '')));
  }
  assert.equal(await productFingerprint(root), null);
});

test('invalid UTF-8 names fail closed where the filesystem supports them', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fixture(t);
  const invalidName = Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0xff])]);
  try {
    await writeFile(invalidName, 'unrepresentable name\n');
  } catch (error) {
    if (!['EINVAL', 'EPERM', 'EILSEQ'].includes(error.code)) throw error;
    t.skip(`filesystem rejects invalid UTF-8 names (${error.code})`);
    return;
  }
  assert.equal(await productFingerprint(root), null);
});

test('special files fail closed without blocking', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fixture(t);
  const fifo = join(root, 'named-pipe');
  const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 1000 });
  assert.equal(created.status, 0, created.stderr);
  assert.equal(await productFingerprint(root), null);
});

test('symlinked ignore rules are refused before their target can be read', async (t) => {
  const root = await fixture(t);
  const external = await fixture(t);
  await writeFile(join(external, 'private-ignore'), '*\n');
  await symlink(join(external, 'private-ignore'), join(root, '.gitignore'));
  assert.equal(await productFingerprint(root), null);
});

test('deterministic ancestor swaps are rejected before external content reads', { skip: process.platform === 'win32' }, async (t) => {
  for (const phase of ['before-child-lstat', 'after-child-lstat', 'before-child-open',
    'after-child-open', 'before-ignore-lstat', 'before-child-opendir', 'before-first-read']) {
    await t.test(phase, async (t) => {
      const root = await nativeFilesystem.realpath(await fixture(t));
      const project = join(root, 'project');
      const src = join(project, 'src');
      const external = join(root, 'synthetic-external');
      await mkdir(src, { recursive: true });
      await mkdir(external);
      const accessed = join(src, 'local.txt');
      const ignore = join(src, '.gitignore');
      const externalFile = join(external, 'local.txt');
      await writeFile(accessed, 'authorized local fixture\n');
      await writeFile(ignore, '# authorized ignore fixture\n');
      await writeFile(externalFile, 'SYNTHETIC PRIVATE BYTES OUTSIDE AUTHORIZED CWD\n');
      await writeFile(join(external, '.gitignore'), '# synthetic external ignore fixture\n');
      const externalIdentities = await Promise.all([externalFile, join(external, '.gitignore')].map((path) => stat(path)));
      const original = { lstat: nativeFilesystem.lstat, open: nativeFilesystem.open, opendir: nativeFilesystem.opendir };
      let swapped = false;
      let externalBytesRead = 0;
      const swap = async () => {
        if (swapped) return;
        await rename(src, join(project, 'held-original-src'));
        await symlink(external, src, 'dir');
        swapped = true;
      };
      nativeFilesystem.lstat = async (path, ...args) => {
        if ((phase === 'before-child-lstat' && path === accessed) ||
            (phase === 'before-ignore-lstat' && path === ignore)) await swap();
        const metadata = await original.lstat(path, ...args);
        if (phase === 'after-child-lstat' && path === accessed) await swap();
        return metadata;
      };
      nativeFilesystem.opendir = async (path, ...args) => {
        if (phase === 'before-child-opendir' && path === src) await swap();
        return original.opendir(path, ...args);
      };
      nativeFilesystem.open = async (path, ...args) => {
        if (phase === 'before-child-open' && path === accessed) await swap();
        const handle = await original.open(path, ...args);
        if (phase === 'after-child-open' && path === accessed) await swap();
        const metadata = await handle.stat();
        const externalHandle = externalIdentities.some((identity) => identity.dev === metadata.dev && identity.ino === metadata.ino);
        const read = handle.read;
        handle.read = async (...readArgs) => {
          if (phase === 'before-first-read' && path === accessed) await swap();
          const result = await read.apply(handle, readArgs);
          if (externalHandle) externalBytesRead += result.bytesRead;
          return result;
        };
        return handle;
      };
      let fingerprint;
      try {
        syncBuiltinESMExports();
        fingerprint = await productFingerprint(project);
      } finally {
        Object.assign(nativeFilesystem, original);
        syncBuiltinESMExports();
      }
      assert.equal(swapped, true, 'the requested interleaving must execute');
      assert.equal(fingerprint, null);
      assert.equal(externalBytesRead, 0, 'external file descriptors must not yield content');
    });
  }
});

test('corrupt existing Git metadata does not acquire directory-only assurance', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, '.git'));
  await writeFile(join(root, 'product.txt'), 'stable\n');
  assert.equal(await productFingerprint(root), null);
});

test('normal Git discovery at a filesystem boundary still permits a non-Git capture', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fixture(t);
  const project = join(root, 'project');
  const tools = join(root, 'tools');
  await mkdir(project);
  await mkdir(tools);
  await writeFile(join(project, 'product.txt'), 'stable\n');
  await writeFile(join(tools, 'git'), [
    '#!/bin/sh',
    'if [ "$1" = "rev-parse" ]; then',
    '  printf "%s\\n" "fatal: not a git repository (or any parent up to mount point /fixture)" "Stopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set)." >&2',
    '  exit 128',
    'fi',
    'PATH="${PATH#*:}" exec git "$@"',
    '',
  ].join('\n'), { mode: 0o755 });
  const moduleUrl = new URL('../scripts/lib/supervisor.mjs', import.meta.url).href;
  const program = `import { captureWorkspaceFingerprint } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await captureWorkspaceFingerprint(process.cwd(), { excludeFlightPlan: true })));`;
  const observed = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    cwd: project, env: { ...process.env, PATH: `${tools}${delimiter}${process.env.PATH}` },
    encoding: 'utf8', timeout: 8000,
  });
  assert.equal(observed.status, 0, observed.stderr);
  assert.match(JSON.parse(observed.stdout), /^[a-f\d]{64}$/u);
});

test('real non-Git completion accepts unchanged fresh gates and rejects content, new files, or request mutation', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, '.cruise'));
  const origin = join(root, '.cruise', 'ORIGIN.md');
  const product = join(root, 'product with spaces.txt');
  const timestamp = new Date('2020-01-01T00:00:00Z');
  await writeFile(origin, 'Verify synthetic non-Git product changes.\n');
  await writeFile(product, 'before\n');
  await utimes(product, timestamp, timestamp);
  const plan = parseFlightPlan(flightPlanTemplate());
  plan.status = 'complete';
  await writeFlightPlan(root, plan);
  const session = completionSession(root);
  const pending = await session.assessCompletion();
  assert.match(pending.contextFingerprint, /^[a-f\d]{64}$/u);
  assert.equal(pending.allowsCompletion, false);
  for (const gate of plan.quality.gates) {
    gate.state = 'passed';
    gate.evidence = { summary: `${gate.id} fixture passed`, contextFingerprint: pending.contextFingerprint,
      observedAt: 1, source: gate.dimension === 'completion-review' ? 'review' : 'command', rationale: '', waivedBy: '' };
  }
  await writeFlightPlan(root, plan);
  const fresh = await session.assessCompletion();
  assert.equal(fresh.allowsCompletion, true);
  assert.equal(fresh.metrics.fresh, plan.quality.gates.length);
  assert.equal((await session.assessCompletion()).allowsCompletion, true, 'receipts cannot stale themselves');

  const before = await stat(product);
  await writeFile(product, 'after!\n');
  await utimes(product, timestamp, timestamp);
  const after = await stat(product);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  const stale = await session.assessCompletion();
  assert.equal(stale.allowsCompletion, false);
  assert.equal(stale.metrics.fresh, 0);
  await writeFile(product, 'before\n');
  assert.equal((await session.assessCompletion()).allowsCompletion, true);
  await writeFile(join(root, '.hidden-new-input'), 'added\n');
  assert.equal((await session.assessCompletion()).allowsCompletion, false);
  await unlink(join(root, '.hidden-new-input'));
  assert.equal((await session.assessCompletion()).allowsCompletion, true);
  await writeFile(origin, 'Changed synthetic request.\n');
  assert.equal((await session.assessCompletion()).allowsCompletion, false);
});

test('a failed bounded non-Git capture explicitly blocks completion', async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, '.cruise'));
  await writeFile(join(root, '.cruise', 'ORIGIN.md'), 'Synthetic request.\n');
  await writeFlightPlan(root, parseFlightPlan(flightPlanTemplate()));
  const large = join(root, 'large.bin');
  await writeFile(large, '');
  await truncate(large, NON_GIT_FINGERPRINT_LIMITS.bytes + 1);
  const result = await completionSession(root).assessCompletion();
  assert.equal(result.allowsCompletion, false);
  assert.equal(result.contextFingerprint, null);
  assert.match(result.reasons.join('\n'), /workspace fingerprint is unavailable/u);
});
