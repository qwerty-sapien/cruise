import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  CONTEXT_SLICE_BYTES,
  CONTEXT_SLICE_LINES,
  runContextView,
} from '../scripts/context-view.mjs';

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cruise-context-view-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'context-view@example.invalid']);
  git(root, ['config', 'user.name', 'Context View Test']);
  await writeFile(join(root, 'AGENTS.md'), '# Instructions\nKeep reads bounded.\n');
  await writeFile(join(root, 'source.mjs'), [
    'export function alpha() {',
    `  return '${'x'.repeat(1_500)}';`,
    '}',
    ...Array.from({ length: 240 }, (_, index) => `const line${index} = ${index};`),
  ].join('\n'));
  await writeFile(join(root, 'data.json'), '{"rows":[{"id":1,"name":"a"}],"meta":{"safe":true}}\n');
  await writeFile(join(root, 'table.csv'), 'id,name\n1,a\n2,b\n');
  await writeFile(join(root, 'run.log'), 'INFO start\nWARN slow\nERROR stopped\n');
  await writeFile(join(root, 'matches.mjs'), Array.from({ length: 25 }, (_, index) => `export const needle${index} = 'needle';`).join('\n'));
  await writeFile(join(root, 'oversized.txt'), `${'z'.repeat(17_000)}\nsecond line\n`);
  await writeFile(join(root, 'dist.bin'), 'excluded');
  git(root, ['add', '-f', 'AGENTS.md', 'source.mjs', 'data.json', 'table.csv', 'run.log', 'matches.mjs', 'oversized.txt', 'dist.bin']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

test('context map honors exclusions and every command emits a digest and raw artifact', async (t) => {
  const root = await fixture(t);
  const cases = [
    ['map', []],
    ['search', ['alpha']],
    ['slice', ['source.mjs', '1', '999']],
    ['symbols', ['source.mjs']],
    ['json-summary', ['data.json']],
    ['table-summary', ['table.csv']],
    ['log-summary', ['run.log']],
    ['changed', []],
  ];
  for (const [command, args] of cases) {
    const result = await runContextView({ cwd: root, command, args, visibleBytes: 2_048 });
    assert.match(result.content_digest, /^[0-9a-f]{64}$/u);
    assert.match(result.artifact_path, /\.cruise\/artifacts\/context-view-/u);
    assert.ok(result.visible_bytes <= 2_048);
    assert.equal(typeof await readFile(result.artifact_path, 'utf8'), 'string');
  }

  const mapped = await runContextView({ cwd: root, command: 'map' });
  assert.match(mapped.content, /source\.mjs/u);
  assert.doesNotMatch(mapped.content, /dist\.bin/u);
  assert.doesNotMatch(mapped.content, /table\.csv/u);
  assert.doesNotMatch(mapped.content, /run\.log/u);
  assert.deepEqual(mapped.instruction_paths, ['AGENTS.md']);
});

test('large ranged reads stay within both caps and preserve full raw evidence', async (t) => {
  const root = await fixture(t);
  const result = await runContextView({
    cwd: root,
    command: 'slice',
    args: ['source.mjs', '1', '999'],
    visibleBytes: 2_000,
  });
  const raw = await readFile(result.artifact_path, 'utf8');
  const lineNumbers = raw.split('\n').filter(Boolean).map((line) => Number(line.split(':', 1)[0]));
  assert.ok(lineNumbers.length <= CONTEXT_SLICE_LINES);
  assert.ok(Buffer.byteLength(raw) <= CONTEXT_SLICE_BYTES);
  assert.ok(result.visible_bytes <= 2_000);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(raw) > result.visible_bytes);

  const oversized = await runContextView({
    cwd: root,
    command: 'slice',
    args: ['oversized.txt', '1', '2'],
  });
  const oversizedRaw = await readFile(oversized.artifact_path, 'utf8');
  assert.ok(Buffer.byteLength(oversizedRaw) > 0);
  assert.ok(Buffer.byteLength(oversizedRaw) <= CONTEXT_SLICE_BYTES);
  assert.match(oversizedRaw, /^1: z/u);

  const cli = spawnSync(process.execPath, [
    resolve(import.meta.dirname, '../scripts/context-view.mjs'),
    'slice',
    'source.mjs',
    '1',
    '999',
  ], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 });
  assert.equal(cli.status, 0, cli.stderr);
  assert.ok(Buffer.byteLength(cli.stdout) <= 12 * 1024);
  assert.match(JSON.parse(cli.stdout).artifact_path, /\.cruise\/artifacts/u);
});

test('search groups visible results but preserves every filtered match in the raw artifact', async (t) => {
  const root = await fixture(t);
  const result = await runContextView({ cwd: root, command: 'search', args: ['needle'] });
  const raw = await readFile(result.artifact_path, 'utf8');
  assert.equal(raw.split('\n').filter(Boolean).length, 25);
  assert.equal(result.content.split('\n').filter((line) => /matches\.mjs:/u.test(line)).length, 20);
});

test('tracked-file cache invalidates by current Git blob hash', async (t) => {
  const root = await fixture(t);
  const input = { cwd: root, command: 'slice', args: ['source.mjs', '1', '4'] };
  const first = await runContextView(input);
  const second = await runContextView(input);
  assert.equal(first.cache_hit, false);
  assert.equal(second.cache_hit, true);
  assert.equal(second.cache_key, first.cache_key);

  await writeFile(join(root, 'source.mjs'), 'export function beta() { return 2; }\n');
  const changed = await runContextView(input);
  assert.equal(changed.cache_hit, false);
  assert.notEqual(changed.cache_key, first.cache_key);
  assert.match(changed.content, /beta/u);
});
