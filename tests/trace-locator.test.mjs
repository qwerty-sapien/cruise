import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  codexHome,
  codexSessionsDirectory,
  locateRollout,
} from '../scripts/lib/trace-locator.mjs';

const THREAD_ID = '019f855b-527e-77d1-bf9b-bca4c89da49e';

test('CODEX_HOME overrides the default Codex home', () => {
  assert.equal(codexHome({ CODEX_HOME: './sandbox-codex-home' }), resolve('sandbox-codex-home'));
  assert.equal(codexSessionsDirectory('/tmp/codex-home'), '/tmp/codex-home/sessions');
});

test('rollout lookup globs the id suffix and its session_meta id matches', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cruise-trace-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const now = new Date(2026, 6, 21, 23, 46, 22);
  const directory = join(home, 'sessions', '2026', '07', '21');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-arbitrary-local-time-${THREAD_ID}.jsonl`);
  await writeFile(path, `${JSON.stringify({
    type: 'session_meta',
    payload: { session_id: THREAD_ID },
  })}\n`, 'utf8');

  assert.equal(await locateRollout(THREAD_ID, { home, now }), path);
  const first = JSON.parse((await readFile(path, 'utf8')).split('\n')[0]);
  assert.equal(first.payload.session_id, THREAD_ID);
});

test('rollout lookup widens once, stays bounded, and treats missing trees as normal', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'cruise-trace-wide-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const oldDirectory = join(home, 'sessions', '2024', '01', '02');
  await mkdir(oldDirectory, { recursive: true });
  const path = join(oldDirectory, `rollout-not-a-derived-timestamp-${THREAD_ID}.jsonl`);
  await writeFile(path, '{}\n', 'utf8');

  assert.equal(await locateRollout(THREAD_ID, {
    home,
    now: new Date(2026, 6, 21),
  }), path);
  assert.equal(await locateRollout(THREAD_ID, {
    home,
    now: new Date(2026, 6, 21),
    maxDirectories: 2,
  }), null);
  assert.equal(await locateRollout(THREAD_ID, {
    home: join(home, 'missing'),
    now: new Date(2026, 6, 21),
  }), null);
  assert.equal(await locateRollout('../not-a-thread', { home }), null);
});
