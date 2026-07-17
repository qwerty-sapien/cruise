import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ORIGIN_NOTE_PATH,
  readOriginPrompt,
  writeOriginPrompt,
} from '../scripts/lib/origin-note.mjs';

test('ORIGIN.md is the sole prompt-only Cruise record', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-origin-note-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = 'Keep every space.\r\n\r\nDo not normalize this request.  ';
  const record = await writeOriginPrompt(root, first);
  assert.equal(record.path, join(root, ORIGIN_NOTE_PATH));
  assert.equal(await readOriginPrompt(root), first);
  assert.deepEqual(await readdir(join(root, '.cruise')), ['ORIGIN.md']);

  await writeOriginPrompt(root, 'A later explicit request.');
  assert.equal(await readOriginPrompt(root), 'A later explicit request.');
  assert.deepEqual(await readdir(join(root, '.cruise')), ['ORIGIN.md']);
});

test('the prompt note does not follow a pre-existing symlink', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-origin-note-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeOriginPrompt(root, 'First request.');
  const target = join(root, 'outside.txt');
  await writeFile(target, 'outside');
  await unlink(join(root, ORIGIN_NOTE_PATH));
  await symlink(target, join(root, ORIGIN_NOTE_PATH));
  await assert.rejects(writeOriginPrompt(root, 'Second request.'), /regular file/u);
  assert.equal(await readFile(target, 'utf8'), 'outside');
});
