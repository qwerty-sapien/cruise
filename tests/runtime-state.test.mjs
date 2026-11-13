import assert from 'node:assert/strict';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  cleanupLegacyCruiseState,
  cleanupRuntimeSession,
  createRuntimeSession,
  finalizeCruiseControlState,
  janitorRuntimeSessions,
  prepareCruiseControlState,
  promoteRuntimeArtifact,
  RUNTIME_DIRECTORIES,
  validateRuntimeDirectory,
  writeRuntimeJson,
} from '../scripts/lib/runtime-state.mjs';

async function absent(path) {
  await assert.rejects(access(path), { code: 'ENOENT' });
}

test('runtime sessions use a private manifest-driven layout and deterministic cleanup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-runtime-test-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const baseDirectory = join(root, 'runtime');
  const cwd = join(root, 'workspace');
  await mkdir(cwd);
  const runtime = await createRuntimeSession({
    cwd,
    sessionId: 'session-one',
    now: 100,
    ttlMs: 500,
    baseDirectory,
  });
  const validated = await validateRuntimeDirectory(runtime, {
    cwd,
    sessionId: 'session-one',
    baseDirectory,
  });
  assert.equal(validated.manifest.recovery_expires_at, 600);
  assert.equal((await lstat(runtime)).mode & 0o777, 0o700);
  for (const directory of RUNTIME_DIRECTORIES) {
    assert.equal((await lstat(join(runtime, directory))).isDirectory(), true);
  }
  await writeRuntimeJson(runtime, 'supervisor.json', { turn: 1 }, { baseDirectory });
  assert.deepEqual(JSON.parse(await readFile(join(runtime, 'supervisor.json'), 'utf8')), { turn: 1 });
  await cleanupRuntimeSession(runtime, { cwd, sessionId: 'session-one', baseDirectory });
  await absent(runtime);
});

test('the janitor removes only expired valid sessions and skips unsafe entries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-janitor-test-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const baseDirectory = join(root, 'runtime');
  const cwd = join(root, 'workspace');
  await mkdir(cwd);
  const expired = await createRuntimeSession({
    cwd,
    sessionId: 'expired',
    now: 10,
    ttlMs: 10,
    baseDirectory,
  });
  const live = await createRuntimeSession({
    cwd,
    sessionId: 'live',
    now: 10,
    ttlMs: 1_000,
    baseDirectory,
  });
  const unsafe = join(expired, '..', 'unsafe-link');
  await symlink(live, unsafe);
  const result = await janitorRuntimeSessions({ baseDirectory, now: 100 });
  assert.equal(result.removed.includes(expired), true);
  assert.equal(result.skipped.includes(unsafe), true);
  await absent(expired);
  assert.equal((await lstat(live)).isDirectory(), true);
});

test('runtime validation and promotion reject symlinks and promote regular deliverables atomically', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-promote-test-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })));
  const baseDirectory = join(root, 'runtime');
  const cwd = join(root, 'workspace');
  await mkdir(cwd);
  const runtime = await createRuntimeSession({
    cwd,
    sessionId: 'promote',
    baseDirectory,
  });
  await writeFile(join(runtime, 'drafts', 'report.md'), 'ready\n');
  const destination = join(cwd, 'report.md');
  const promoted = await promoteRuntimeArtifact({
    runtimeDirectory: runtime,
    relativePath: 'drafts/report.md',
    destination,
    baseDirectory,
  });
  assert.equal(promoted.method, 'rename');
  assert.equal(await readFile(destination, 'utf8'), 'ready\n');
  await symlink(destination, join(runtime, 'drafts', 'linked.md'));
  await assert.rejects(
    promoteRuntimeArtifact({
      runtimeDirectory: runtime,
      relativePath: 'drafts/linked.md',
      destination: join(cwd, 'linked.md'),
      baseDirectory,
    }),
    /regular runtime files/u,
  );
  await writeFile(join(runtime, 'drafts', 'outside.md'), 'no\n');
  await assert.rejects(
    promoteRuntimeArtifact({
      runtimeDirectory: runtime,
      relativePath: 'drafts/outside.md',
      destination: join(root, 'outside-workspace.md'),
      baseDirectory,
    }),
    /registered workspace/u,
  );
});

test('persistent control cleanup is class- and terminal-status-driven', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-control-test-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(cwd, { recursive: true, force: true })));
  const control = join(cwd, '.cruise');
  await mkdir(control);
  for (const name of ['ORIGIN.md', 'FLIGHT.md', 'QUEUE.md', 'LAST-RUN.json', 'unknown.md']) {
    await writeFile(join(control, name), `${name}\n`);
  }
  await mkdir(join(control, 'runs'));
  await writeFile(join(control, 'runs', 'trace.json'), '{}\n');
  await writeFile(join(control, '.supervisor-old.json'), '{}\n');

  const legacy = await cleanupLegacyCruiseState(cwd);
  assert.deepEqual(new Set(legacy), new Set(['runs', '.supervisor-old.json']));
  await finalizeCruiseControlState(cwd, { status: 'blocked' });
  assert.equal(await readFile(join(control, 'ORIGIN.md'), 'utf8'), 'ORIGIN.md\n');
  assert.equal(await readFile(join(control, 'FLIGHT.md'), 'utf8'), 'FLIGHT.md\n');

  await finalizeCruiseControlState(cwd, { status: 'complete', queueComplete: true });
  for (const name of ['ORIGIN.md', 'FLIGHT.md', 'QUEUE.md']) await absent(join(control, name));
  assert.equal(await readFile(join(control, 'LAST-RUN.json'), 'utf8'), 'LAST-RUN.json\n');
  assert.equal(await readFile(join(control, 'unknown.md'), 'utf8'), 'unknown.md\n');

  await writeFile(join(control, 'ORIGIN.md'), 'old\n');
  await writeFile(join(control, 'FLIGHT.md'), 'old\n');
  await prepareCruiseControlState(cwd);
  await absent(join(control, 'ORIGIN.md'));
  await absent(join(control, 'FLIGHT.md'));
});
