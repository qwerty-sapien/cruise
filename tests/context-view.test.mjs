import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

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
  await mkdir(join(root, 'config'));
  await mkdir(join(root, 'secrets'));
  await mkdir(join(root, 'notes'));
  await writeFile(join(root, '.env'), 'API_KEY=MINIREPO_DOTENV_SENTINEL\n');
  await writeFile(join(root, '.env.local'), 'TOKEN=MINIREPO_DOTENV_LOCAL_SENTINEL\n');
  await writeFile(join(root, 'config', 'credentials.json'), '{"password":"MINIREPO_CREDENTIAL_SENTINEL"}\n');
  await writeFile(join(root, 'config', 'credentials.csv'), 'key,value\npassword,MINIREPO_CREDENTIAL_CSV_SENTINEL\n');
  await writeFile(join(root, 'secrets', 'runtime.log'), 'MINIREPO_SECRET_LOG_SENTINEL\n');
  await writeFile(join(root, 'notes', 'internal.md'), 'MINIREPO_EXPLICIT_SECRET_SENTINEL\n');
  git(root, ['add', '-f', 'AGENTS.md', 'source.mjs', 'data.json', 'table.csv', 'run.log', 'matches.mjs', 'oversized.txt', 'dist.bin', '.env', '.env.local', 'config/credentials.json', 'config/credentials.csv', 'secrets/runtime.log', 'notes/internal.md']);
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

test('mini-repository excludes dotenv and secret paths before every retrieval route', async (t) => {
  const root = await fixture(t);
  await chmod(join(root, '.env'), 0o000);
  t.after(() => chmod(join(root, '.env'), 0o600).catch(() => {}));

  const explicitSensitivePaths = ['notes/internal.md'];
  const mapped = await runContextView({ cwd: root, command: 'map', explicitSensitivePaths });
  const searched = await runContextView({
    cwd: root,
    command: 'search',
    args: ['MINIREPO_'],
    explicitSensitivePaths,
  });
  const changed = await runContextView({ cwd: root, command: 'changed', explicitSensitivePaths });
  for (const result of [mapped, searched, changed]) {
    assert.doesNotMatch(result.content, /\.env|credentials|secrets\/runtime|MINIREPO_.*SENTINEL/u);
    assert.equal(result.sources.some((path) => /\.env|credentials|secrets\/runtime/u.test(path)), false);
  }
  assert.equal(searched.source_count, 0);

  const artifactDirectory = join(root, '.cruise', 'artifacts');
  const before = await readdir(artifactDirectory);
  for (const [command, args] of [
    ['map', ['.env']],
    ['search', ['MINIREPO_', '.env']],
    ['slice', ['.env']],
    ['symbols', ['.env.local']],
    ['json-summary', ['config/credentials.json']],
    ['table-summary', ['config/credentials.csv']],
    ['log-summary', ['secrets/runtime.log']],
  ]) {
    await assert.rejects(
      runContextView({ cwd: root, command, args }),
      (error) => error?.code === 'CRUISE_SENSITIVE_PATH',
    );
  }
  await assert.rejects(
    runContextView({
      cwd: root,
      command: 'slice',
      args: ['notes/internal.md'],
      explicitSensitivePaths: ['notes/internal.md'],
    }),
    (error) => error?.code === 'CRUISE_SENSITIVE_PATH',
  );
  assert.deepEqual(await readdir(artifactDirectory), before);

  const explicit = await runContextView({
    cwd: root,
    command: 'search',
    args: ['MINIREPO_'],
    explicitSensitivePaths: ['notes/internal.md'],
  });
  assert.equal(explicit.source_count, 0);
  for (const artifact of await readdir(artifactDirectory)) {
    const content = await readFile(join(artifactDirectory, artifact), 'utf8');
    assert.doesNotMatch(content, /MINIREPO_.*SENTINEL/u);
  }
});

test('named sibling files and search roots work independently of Git and edit ownership', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'cruise-named-read-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const repo = join(parent, 'repo');
  const shared = join(parent, 'shared');
  await mkdir(repo); await mkdir(shared);
  git(repo, ['init', '-q']);
  await writeFile(join(shared, 'notes.md'), 'ordinary needle\nsecond line\n');
  for (const input of ['../shared/notes.md', join(shared, 'notes.md')]) {
    const result = await runContextView({ cwd: repo, command: 'slice', args: [input, '1', '2'], noPersist: true });
    assert.match(result.content, /ordinary needle/u);
    assert.deepEqual(result.sources, ['../shared/notes.md']);
    assert.match(result.root, /repo$/u);
  }
  for (const options of [
    { cwd: repo, args: ['needle', '../shared'] },
    { cwd: repo, args: ['needle', join(shared, 'notes.md')] },
    { cwd: shared, args: ['needle'] },
    { cwd: repo, root: shared, args: ['needle', '.'] },
  ]) {
    const result = await runContextView({ ...options, command: 'search', noPersist: true });
    assert.match(result.content, /notes\.md:1:ordinary needle/u);
    assert.equal(result.source_count, 1);
  }
  const mapped = await runContextView({ cwd: shared, command: 'map', noPersist: true });
  assert.match(mapped.content, /notes\.md/u);
  const cli = spawnSync(process.execPath, [resolve(import.meta.dirname, '../scripts/context-view.mjs'),
    '--root', shared, '--no-persist', 'slice', 'notes.md', '1', '2'], { cwd: repo, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(JSON.parse(cli.stdout).content, /ordinary needle/u);
  assert.equal(JSON.parse(cli.stdout).artifact_path, null);
  assert.deepEqual((await readdir(shared)).sort(), ['notes.md']);
});

test('named reads retain ignore, sensitive, underscore-root, and symlink exclusions', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, '.gitignore'), 'ignored.md\nignored-dir/\n');
  await writeFile(join(root, 'ignored.md'), 'EXCLUDED_NEEDLE');
  await mkdir(join(root, 'ignored-dir'));
  await writeFile(join(root, 'ignored-dir', 'safe.md'), 'EXCLUDED_NEEDLE');
  await writeFile(join(root, '_reference.md'), 'EXCLUDED_NEEDLE');
  await symlink(join(root, '.env'), join(root, 'alias.md'));
  await symlink(join(root, 'notes'), join(root, 'alias-dir'));
  for (const path of ['ignored.md', 'ignored-dir/safe.md', '_reference.md', 'alias.md', 'alias-dir/internal.md']) {
    await assert.rejects(runContextView({ cwd: root, command: 'slice', args: [path], noPersist: true }));
  }
  const searched = await runContextView({ cwd: root, command: 'search', args: ['EXCLUDED_NEEDLE', '.'], noPersist: true,
    explicitSensitivePaths: ['notes/internal.md'] });
  assert.equal(searched.content, '');
  for (const command of ['slice', 'search']) {
    for (const path of ['.env', 'config/credentials.json', 'notes/internal.md', '_reference.md']) {
      await assert.rejects(runContextView({ cwd: join(root, 'notes'), root, command,
        args: command === 'search' ? ['NEEDLE', join(root, path)] : [join(root, path)], noPersist: true,
        explicitSensitivePaths: ['notes/internal.md'] }));
    }
  }
});

test('read-only permission sandbox returns capped extraction without any filesystem write allowance', async (t) => {
  const root = await fixture(t);
  const moduleUrl = pathToFileURL(resolve(import.meta.dirname, '../scripts/context-view.mjs')).href;
  const expected = await runContextView({ cwd: root, command: 'slice', args: ['source.mjs', '1', '4'], noPersist: true, visibleBytes: 128 });
  for (const noPersist of [true, false]) {
    const script = `import { runContextView } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await runContextView(${JSON.stringify({ cwd: root, command: 'slice', args: ['source.mjs', '1', '4'], noPersist, visibleBytes: 128 })})));`;
    const child = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', '--allow-child-process', '--input-type=module', '-e', script],
      { encoding: 'utf8', maxBuffer: 16 * 1024 });
    assert.equal(child.status, 0, child.stderr);
    const actual = JSON.parse(child.stdout);
    assert.equal(actual.content, expected.content);
    assert.equal(actual.content_digest, expected.content_digest);
    assert.ok(actual.visible_bytes <= 128);
    assert.equal(actual.artifact_path, null);
    assert.equal(actual.cache_hit, false);
    assert.equal(actual.persistence, noPersist ? 'disabled' : 'unavailable');
    assert.equal(actual.persistence_error, noPersist ? null : 'ERR_ACCESS_DENIED');
  }
  assert.equal((await readdir(root)).includes('.cruise'), false);
});

test('non-Git enumeration fails at a hard entry cap and tiny visible caps stay bounded', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-enumeration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'normal.txt'), 'ordinary content\n');
  for (const visibleBytes of [1, 2, 3, 4]) {
    const result = await runContextView({ cwd: root, command: 'slice', args: ['normal.txt'], noPersist: true, visibleBytes });
    assert.ok(result.visible_bytes <= visibleBytes);
  }
  // Excluded empty fixture entries exercise the enumeration bound without reads.
  for (let start = 0; start < 4096; start += 128) {
    await Promise.all(Array.from({ length: 128 }, (_, offset) => writeFile(join(root, `${start + offset}.bin`), '')));
  }
  await assert.rejects(runContextView({ cwd: root, command: 'map', noPersist: true }), /enumeration cap/u);
});
