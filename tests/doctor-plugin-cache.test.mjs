import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  digestPluginRuntime,
  inspectPluginCache,
  pluginDigestDetail,
  resolvePluginCacheRoot,
} from '../scripts/lib/doctor-plugin-cache.mjs';

const ROOTS = Object.freeze([
  '.codex-plugin/plugin.json',
  'package.json',
  'skills',
  'internal',
  'scripts',
  'fixtures',
]);

async function makeRuntimeTree(root) {
  const files = {
    '.codex-plugin/plugin.json': '{"name":"cruise","version":"test"}\n',
    'package.json': '{"name":"cruise-test","type":"module"}\n',
    'skills/quick/SKILL.md': '# Quick\n',
    'internal/shared/invocation-contract.md': '# Contract\n',
    'scripts/cruise.mjs': 'export const ready = true;\n',
    'tests/smoke.test.mjs': 'export {};\n',
    'fixtures/doctor/repository/data/format-markers.json': '{"fixture":true}\n',
    'fixtures/doctor/repository/workflow/Snakefile': 'rule all:\n    input: []\n',
  };
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), contents);
  }
}

test('plugin cache digest accepts identical runtime trees and reports a stable aggregate', async (t) => {
  const source = await mkdtemp(join(tmpdir(), 'cruise-digest-source-'));
  const cache = await mkdtemp(join(tmpdir(), 'cruise-digest-cache-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(cache, { recursive: true, force: true }));
  await makeRuntimeTree(source);
  await makeRuntimeTree(cache);

  const inspection = await inspectPluginCache({ sourceRoot: source, cacheRoot: cache, roots: ROOTS });
  assert.equal(inspection.matches, true);
  assert.equal(inspection.source.digest, inspection.cache.digest);
  assert.equal(inspection.source.file_count, 7);
  assert.match(pluginDigestDetail(inspection), /source equals installed cache/u);
});

test('plugin cache digest fails on changed, missing, and extra bytes', async (t) => {
  const source = await mkdtemp(join(tmpdir(), 'cruise-digest-source-'));
  const cache = await mkdtemp(join(tmpdir(), 'cruise-digest-cache-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(cache, { recursive: true, force: true }));
  await makeRuntimeTree(source);
  await makeRuntimeTree(cache);
  await writeFile(join(cache, 'skills/quick/SKILL.md'), '# Stale Quick\n');
  await rm(join(cache, 'scripts/cruise.mjs'));
  await writeFile(join(cache, 'internal/extra.md'), '# Extra\n');
  await writeFile(
    join(cache, 'fixtures/doctor/repository/data/format-markers.json'),
    '{"fixture":"stale"}\n',
  );
  await rm(join(cache, 'fixtures/doctor/repository/workflow/Snakefile'));
  await writeFile(join(cache, 'fixtures/doctor/repository/extra.txt'), 'stale fixture residue\n');

  const inspection = await inspectPluginCache({ sourceRoot: source, cacheRoot: cache, roots: ROOTS });
  assert.equal(inspection.matches, false);
  assert.deepEqual(inspection.changed, [
    'fixtures/doctor/repository/data/format-markers.json',
    'skills/quick/SKILL.md',
  ]);
  assert.deepEqual(inspection.missing, [
    'fixtures/doctor/repository/workflow/Snakefile',
    'scripts/cruise.mjs',
  ]);
  assert.deepEqual(inspection.extra, [
    'fixtures/doctor/repository/extra.txt',
    'internal/extra.md',
  ]);
  assert.match(pluginDigestDetail(inspection), /changed:skills\/quick\/SKILL\.md/u);
  assert.match(pluginDigestDetail(inspection), /changed:fixtures\/doctor\/repository\/data\/format-markers\.json/u);
});

test('plugin cache digest refuses symlinks instead of following them', async (t) => {
  const source = await mkdtemp(join(tmpdir(), 'cruise-digest-source-'));
  const cache = await mkdtemp(join(tmpdir(), 'cruise-digest-cache-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(cache, { recursive: true, force: true }));
  await makeRuntimeTree(source);
  await makeRuntimeTree(cache);
  await rm(join(cache, 'skills/quick/SKILL.md'));
  await symlink(join(source, 'skills/quick/SKILL.md'), join(cache, 'skills/quick/SKILL.md'));

  await assert.rejects(
    inspectPluginCache({ sourceRoot: source, cacheRoot: cache, roots: ROOTS }),
    /refuses symlink skills\/quick\/SKILL\.md/u,
  );
});

test('plugin cache digest refuses a symlinked cache leaf even when it targets source', async (t) => {
  const source = await mkdtemp(join(tmpdir(), 'cruise-digest-source-'));
  const parent = await mkdtemp(join(tmpdir(), 'cruise-digest-cache-parent-'));
  const cache = join(parent, 'cache-version');
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await makeRuntimeTree(source);
  await symlink(source, cache);

  await assert.rejects(
    inspectPluginCache({ sourceRoot: source, cacheRoot: cache, roots: ROOTS }),
    /plugin digest root must be a real directory/u,
  );
});

test('plugin cache digest refuses a retired root MCP runtime surface', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'cruise-plugin-retired-surface-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = join(base, 'source');
  await makeRuntimeTree(source);
  await writeFile(join(source, '.mcp.json'), '{}\n');
  await assert.rejects(
    digestPluginRuntime(source),
    /refuses retired runtime surface \.mcp\.json/u,
  );
});

test('plugin cache root honors an explicit Codex home', () => {
  assert.equal(
    resolvePluginCacheRoot({ codexHome: '/tmp/codex-home', version: '1.2.3' }),
    '/tmp/codex-home/plugins/cache/agent-local/cruise/1.2.3',
  );
});
