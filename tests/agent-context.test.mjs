import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { index, resume } from '../skills/goal/scripts/agent-context.mjs';

const OLD = '20261114T180000000Z';
const NEW = '20261114T180100000Z';
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cruise-agent-context-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const make = async (agent = 'a', session = 's', time = NEW) => {
    const path = join(root, 'agents', agent, session, time);
    await mkdir(path, { recursive: true });
    const files = {
      'owner.json': JSON.stringify({ agent, session }),
      'task.md': 'Continue the assigned task',
      'progress.json': JSON.stringify({ checklist: [{ id: 'fix', status: 'pending' }] }),
      'conversation.jsonl': '{"id":"m1","role":"user","text":"required fact"}\n{"id":"m2","role":"assistant","text":"unselected fact","reply_to":"m1"}\n',
      'context.requirements.txt': '{"path":"conversation.jsonl","start":1,"end":1,"why":"requirement"}\n',
    };
    for (const [name, content] of Object.entries(files)) await writeFile(join(path, name), content);
    return path;
  };
  return { root, make };
}

test('resume selects only newest own checkpoint and referenced lines', async (t) => {
  const { root, make } = await fixture(t);
  const old = await make('a', 's', OLD);
  await writeFile(join(old, 'task.md'), 'obsolete');
  const newest = await make();
  await make('peer');
  await mkdir(join(root, 'agents/a/s/.pending-20261114T180200000Z'));
  const result = await resume(root, 'a', 's');
  assert.equal(JSON.parse(result).checkpoint, newest);
  assert.match(result, /required fact/u);
  assert.doesNotMatch(result, /unselected fact|obsolete/u);
});

test('invalid latest checkpoint never falls back to older history', async (t) => {
  const { root, make } = await fixture(t);
  await make('a', 's', OLD);
  const newest = await make();
  await writeFile(join(newest, 'owner.json'), '{"agent":"peer","session":"s"}');
  await assert.rejects(resume(root, 'a', 's'), /owner mismatch/u);
});

test('incomplete latest task or progress rejects without older fallback', async (t) => {
  const { root, make } = await fixture(t);
  const old = await make('a', 's', OLD);
  await writeFile(join(old, 'task.md'), 'obsolete-fallback-task');
  const newest = await make();
  for (const task of ['', ' \t\n']) {
    await writeFile(join(newest, 'task.md'), task);
    await assert.rejects(resume(root, 'a', 's'), /task must not be empty/u);
  }
  await writeFile(join(newest, 'task.md'), 'Continue latest task');
  for (const progress of [null, [], 1, true, 'invalid']) {
    await writeFile(join(newest, 'progress.json'), JSON.stringify(progress));
    await assert.rejects(resume(root, 'a', 's'), /progress must be an object/u);
  }
  await writeFile(join(newest, 'progress.json'), '{}');
  const selected = JSON.parse(await resume(root, 'a', 's'));
  assert.equal(selected.checkpoint, newest);
  assert.equal(selected.task, 'Continue latest task');
  assert.deepEqual(selected.progress, {});
});

test('peer, other-session, older-generation and traversal pointers fail closed', async (t) => {
  const { root, make } = await fixture(t);
  const current = await make();
  const targets = [await make('b'), await make('a', 'other'), await make('a', 's', OLD)];
  for (const target of targets) {
    await writeFile(join(current, 'context.requirements.txt'), JSON.stringify({
      path: join(target, 'conversation.jsonl'), start: 1, end: 1, why: 'disallowed',
    }));
    await assert.rejects(resume(root, 'a', 's'), /checkpoint pointer rejected/u);
  }
  await writeFile(join(current, 'context.requirements.txt'), JSON.stringify({
    path: '../' + OLD + '/conversation.jsonl', start: 1, end: 1, why: 'disallowed',
  }));
  await assert.rejects(resume(root, 'a', 's'), /checkpoint pointer rejected/u);
});

test('symlinks cannot redirect ownership or excerpts into peer history', async (t) => {
  const { root, make } = await fixture(t);
  const current = await make();
  const peer = await make('b');
  await symlink(join(peer, 'conversation.jsonl'), join(current, 'link.jsonl'));
  await writeFile(join(current, 'context.requirements.txt'), JSON.stringify({
    path: 'link.jsonl', start: 1, end: 1, why: 'disallowed',
  }));
  await assert.rejects(resume(root, 'a', 's'), /checkpoint pointer rejected/u);
  await rm(join(current, 'owner.json'));
  await symlink(join(peer, 'owner.json'), join(current, 'owner.json'));
  await assert.rejects(resume(root, 'a', 's'), /Symlinked/u);
});

test('resume promptly rejects FIFO checkpoint and excerpt inputs', { skip: process.platform === 'win32' }, async (t) => {
  for (const name of ['task.md', 'conversation.jsonl']) {
    await t.test(name, async (subtest) => {
      const { root, make } = await fixture(subtest);
      const current = await make();
      await rm(join(current, name));
      execFileSync('mkfifo', [join(current, name)]);
      const result = spawnSync(process.execPath, [
        fileURLToPath(new URL('../skills/goal/scripts/agent-context.mjs', import.meta.url)),
        'resume', root, 'a', 's',
      ], { encoding: 'utf8', timeout: 1200 });
      assert.equal(result.error, undefined, 'helper must not wait for a FIFO writer');
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Non-regular input rejected/u);
      assert.equal(result.stdout, '');
    });
  }
});

test('stale ranges, invalid ranges, and large outputs fail without partial extraction', async (t) => {
  const { root, make } = await fixture(t);
  const current = await make();
  for (const entry of [
    { start: 0, end: 1 }, { start: 1, end: 161 }, { start: 1, end: 9 },
    { start: 1, end: 1, sha256: 'stale' },
  ]) {
    await writeFile(join(current, 'context.requirements.txt'), JSON.stringify({
      path: 'conversation.jsonl', why: 'required', ...entry,
    }));
    await assert.rejects(resume(root, 'a', 's'), /range|source lines|Stale/u);
  }
  await writeFile(join(current, 'conversation.jsonl'), 'x'.repeat(20_000));
  await writeFile(join(current, 'context.requirements.txt'), '{"path":"conversation.jsonl","start":1,"end":1,"why":"required"}');
  await assert.rejects(resume(root, 'a', 's'), /exceeds 16 KB/u);
});

test('graph maps visible messages to exact lines and preserves reply edges', async (t) => {
  const { root, make } = await fixture(t);
  const current = await make();
  await index(root, 'a', 's');
  const graph = (await readFile(join(current, 'conversation.graph.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(graph[1].reply_to, 'm1');
  assert.equal(graph[1].start, 2);
  assert.equal(graph[1].end, 2);
  await writeFile(join(current, 'conversation.jsonl'), '{"id":"r1","role":"assistant","channel":"analysis","text":"private"}');
  await assert.rejects(index(root, 'a', 's'), /visible conversation/u);
});

test('index refuses graph symlinks including dangling targets', async (t) => {
  const { root, make } = await fixture(t);
  const current = await make();
  const target = join(root, 'outside.jsonl');
  await symlink(target, join(current, 'conversation.graph.jsonl'));
  await assert.rejects(index(root, 'a', 's'), /Non-regular graph/u);
  await assert.rejects(readFile(target), { code: 'ENOENT' });
});
