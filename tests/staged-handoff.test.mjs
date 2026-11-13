import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createStagedHandoff } from '../scripts/lib/staged-handoff.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp('/private/tmp/cruise-staged-handoff-');
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const readyFile = join(root, 'ready.json');
  const handoffFile = join(root, 'capsule.json');
  const controller = new AbortController();
  const barrier = createStagedHandoff({ readyFile, handoffFile, pollMs: 5, ...options });
  t.after(async () => {
    controller.abort();
    await barrier.cleanup();
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspace, readyFile, handoffFile, controller, barrier,
    wait: () => barrier.wait({ threadId: 'thread-1', cwd: workspace, signal: controller.signal }) };
}

async function markerAt(file) {
  for (let index = 0; index < 400; index++) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('ready marker did not arrive');
}

function capsuleFor(marker, overrides = {}) {
  return { version: 1, session_id: marker.session_id, thread_id: marker.thread_id,
    workspace: marker.workspace, parent_relinquished: true,
    completed: [], remaining: [], decisions: [], evidence: [], ownership: [], ...overrides };
}

async function publish(file, capsule) {
  await writeFile(`${file}.tmp`, typeof capsule === 'string' ? capsule : JSON.stringify(capsule));
  await rename(`${file}.tmp`, file);
}

test('wait publishes transport readiness and accepts only the later handoff without workspace writes', async (t) => {
  let heartbeats = 0;
  const f = await fixture(t, { heartbeatMs: 10, onHeartbeat: () => { heartbeats++; } });
  await writeFile(join(f.workspace, 'existing.txt'), 'parent still owns this workspace');
  const pending = f.wait();
  let settled = false;
  pending.finally(() => { settled = true; });
  const marker = await markerAt(f.readyFile);
  assert.equal(marker.version, 1);
  assert.equal(marker.state, 'ready');
  assert.match(marker.session_id, /^[0-9a-f-]{36}$/u);
  assert.equal(marker.thread_id, 'thread-1');
  assert.equal(marker.workspace, f.workspace);
  assert.equal(marker.capsule_file, f.handoffFile);
  assert.ok(Number.isFinite(Date.parse(marker.created_at)));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(settled, false);
  assert.ok(heartbeats > 0);
  assert.deepEqual(await readdir(f.workspace), ['existing.txt']);
  await writeFile(join(f.workspace, 'existing.txt'), 'parent final state');
  await publish(f.handoffFile, capsuleFor(marker, { completed: ['Parent completed source edits'],
    remaining: ['Run focused test'], evidence: ['../inert-reference.txt'], ownership: ['child owns tests'] }));
  const context = await pending;
  assert.match(context, /Parent completed source edits/u);
  assert.match(context, /Do not repeat completed work/u);
  assert.match(context, /\.\.\/inert-reference.txt/u);
  assert.equal(await readFile(join(f.workspace, 'existing.txt'), 'utf8'), 'parent final state');
  assert.deepEqual(await readdir(f.workspace), ['existing.txt']);
  await assert.rejects(lstat(f.readyFile), { code: 'ENOENT' });
  assert.ok((await lstat(f.handoffFile)).isFile());
  const count = heartbeats;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(heartbeats, count);
  await assert.rejects(f.wait(), /only be called once/u);
});

test('capsule identity, parent relinquishment, schema and string fields fail closed', async (t) => {
  const cases = [
    ['session', { session_id: 'another-session' }, /does not match/u],
    ['thread', { thread_id: 'another-thread' }, /does not match/u],
    ['workspace', { workspace: '/another-workspace' }, /does not match/u],
    ['parent ownership', { parent_relinquished: false }, /parent_relinquished/u],
    ['version', { version: 2 }, /version 1/u],
    ['unknown key', { surprise: 'value' }, /schema/u],
    ['nested array value', { remaining: [{ path: 'x' }] }, /array of safe/u],
    ['control characters', { decisions: ['unsafe\u0000text'] }, /array of safe/u],
    ['missing array', { evidence: null }, /array of safe/u],
  ];
  for (const [name, overrides, expected] of cases) {
    await t.test(name, async (subtest) => {
      const f = await fixture(subtest);
      const rejected = assert.rejects(f.wait(), expected);
      const marker = await markerAt(f.readyFile);
      await publish(f.handoffFile, capsuleFor(marker, overrides));
      await rejected;
      await assert.rejects(lstat(f.readyFile), { code: 'ENOENT' });
      assert.ok((await lstat(f.handoffFile)).isFile());
    });
  }
});

test('malformed, oversized and invalid UTF-8 capsules fail closed', async (t) => {
  for (const [name, payload, expected] of [
    ['malformed', '{', /valid UTF-8 JSON/u],
    ['oversized', ' '.repeat(8193), /exceeds 8192/u],
    ['invalid UTF-8', Buffer.from([0xff, 0xfe]), /valid UTF-8 JSON/u],
  ]) {
    await t.test(name, async (subtest) => {
      const f = await fixture(subtest);
      const rejected = assert.rejects(f.wait(), expected);
      await markerAt(f.readyFile);
      await writeFile(`${f.handoffFile}.tmp`, payload);
      await rename(`${f.handoffFile}.tmp`, f.handoffFile);
      await rejected;
      await assert.rejects(lstat(f.readyFile), { code: 'ENOENT' });
    });
  }
});

test('preexisting ready/capsule files and symlinks are never overwritten or accepted', async (t) => {
  for (const name of ['ready', 'capsule', 'ready symlink', 'capsule symlink']) {
    await t.test(name, async (subtest) => {
      const f = await fixture(subtest);
      const target = name.startsWith('ready') ? f.readyFile : f.handoffFile;
      if (name.includes('symlink')) {
        const referent = join(f.root, 'referent.json');
        await writeFile(referent, 'keep this');
        await symlink(referent, target);
      } else {
        await writeFile(target, 'keep this');
      }
      await assert.rejects(f.wait(), /preexisting/u);
      assert.equal(await readFile(target, 'utf8'), 'keep this');
    });
  }
});

test('capsule symlink published after ready is rejected without reading its target', async (t) => {
  const f = await fixture(t);
  const rejected = assert.rejects(f.wait(), /regular/u);
  await markerAt(f.readyFile);
  await symlink(join(f.root, 'absent.json'), f.handoffFile);
  await rejected;
  assert.ok((await lstat(f.handoffFile)).isSymbolicLink());
});

test('old capsule renamed after ready is rejected as stale', async (t) => {
  const f = await fixture(t, { sessionId: 'supplied-session' });
  const rejected = assert.rejects(f.wait(), /stale/u);
  const marker = await markerAt(f.readyFile);
  assert.equal(marker.session_id, 'supplied-session');
  const oldFile = join(f.root, 'old.json');
  await writeFile(oldFile, JSON.stringify(capsuleFor(marker)));
  await utimes(oldFile, new Date(0), new Date(0));
  await rename(oldFile, f.handoffFile);
  await rejected;
});

test('paths must be distinct absolute JSON paths outside the canonical workspace', async (t) => {
  for (const kind of ['relative', 'extension', 'same', 'inside', 'parent symlink', 'missing parent']) {
    await t.test(kind, async (subtest) => {
      const f = await fixture(subtest);
      let readyFile = f.readyFile;
      let handoffFile = f.handoffFile;
      if (kind === 'relative') readyFile = 'ready.json';
      if (kind === 'extension') readyFile = join(f.root, 'ready.txt');
      if (kind === 'same') handoffFile = readyFile;
      if (kind === 'inside') readyFile = join(f.workspace, 'ready.json');
      if (kind === 'parent symlink') {
        const alias = join(f.root, 'alias');
        await symlink(f.workspace, alias);
        readyFile = join(alias, 'ready.json');
      }
      if (kind === 'missing parent') readyFile = join(f.root, 'missing', 'ready.json');
      const barrier = createStagedHandoff({ readyFile, handoffFile });
      await assert.rejects(barrier.wait({ threadId: 'thread', cwd: f.workspace }),
        /absolute|distinct|outside|ENOENT/u);
      await barrier.cleanup();
      assert.deepEqual(await readdir(f.workspace), []);
    });
  }
});

test('abort before readiness creates no marker or workspace files', async (t) => {
  const f = await fixture(t);
  f.controller.abort('cancelled before setup');
  await assert.rejects(f.wait(), { name: 'AbortError' });
  await assert.rejects(lstat(f.readyFile), { code: 'ENOENT' });
  assert.deepEqual(await readdir(f.workspace), []);
});

test('abort preserves interruption and transport Error reasons by identity', async (t) => {
  for (const beforeReady of [true, false]) {
    await t.test(beforeReady ? 'before ready' : 'after ready', async (subtest) => {
      const f = await fixture(subtest);
      const reason = new Error('transport exited');
      reason.name = 'SimpleCruiseInterruptedError';
      if (beforeReady) f.controller.abort(reason);
      const rejected = assert.rejects(f.wait(), (error) => error === reason);
      if (!beforeReady) {
        await markerAt(f.readyFile);
        f.controller.abort(reason);
      }
      await rejected;
      await assert.rejects(lstat(f.readyFile), { code: 'ENOENT' });
    });
  }
});

test('abort after readiness and explicit cleanup stop waiting and remove only owned marker', async (t) => {
  for (const explicitCleanup of [false, true]) {
    await t.test(explicitCleanup ? 'cleanup' : 'signal', async (subtest) => {
      const f = await fixture(subtest);
      const rejected = assert.rejects(f.wait(), { name: 'AbortError' });
      await markerAt(f.readyFile);
      if (explicitCleanup) await f.barrier.cleanup();
      else f.controller.abort('parent cancelled');
      await rejected;
      await assert.rejects(lstat(f.readyFile), { code: 'ENOENT' });
      await f.barrier.cleanup();
    });
  }
});

test('cleanup preserves a foreign replacement or edited ready marker', async (t) => {
  for (const replacement of [false, true]) {
    await t.test(replacement ? 'replacement' : 'edited in place', async (subtest) => {
      const f = await fixture(subtest);
      const rejected = assert.rejects(f.wait(), { name: 'AbortError' });
      await markerAt(f.readyFile);
      if (replacement) await unlink(f.readyFile);
      await writeFile(f.readyFile, 'foreign marker');
      f.controller.abort();
      await rejected;
      await f.barrier.cleanup();
      assert.equal(await readFile(f.readyFile, 'utf8'), 'foreign marker');
    });
  }
});

test('heartbeat and poll intervals are bounded and heartbeat errors clean up', async (t) => {
  for (const options of [{ pollMs: 0 }, { pollMs: Infinity }, { heartbeatMs: 120001 }, { heartbeatMs: 0 }]) {
    assert.throws(() => createStagedHandoff(options), /must be between/u);
  }
  const f = await fixture(t, { heartbeatMs: 5, onHeartbeat: () => { throw new Error('heartbeat failed'); } });
  await assert.rejects(f.wait(), /heartbeat failed/u);
  await assert.rejects(lstat(f.readyFile), { code: 'ENOENT' });
});
