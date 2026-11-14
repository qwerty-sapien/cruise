import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('runtime package excludes private contexts and retired skill archives', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-package-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  await writeFile(join(root, 'package.json'), JSON.stringify(metadata));
  const publicFiles = ['index.js', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json',
    ...['build', 'quick', 'goal', 'debug'].map((name) => `skills/${name}/SKILL.md`)];
  const privateFiles = ['agents/synthetic/session/timez/task.md', '.cruise/artifacts/private.txt',
    'codex-history/visible-transcript.jsonl', '_FOR_USER_REFERENCE.md',
    'skills/context-economy.zip', 'skills/retired/SKILL.md'];
  for (const name of [...publicFiles, ...privateFiles]) {
    const path = join(root, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'synthetic packaging fixture only\n');
  }
  const result = spawnSync('npm', ['--cache', join(root, 'cache'), '--ignore-scripts',
    'pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const names = new Set(JSON.parse(result.stdout)[0].files.map((file) => file.path));
  for (const name of publicFiles) assert.equal(names.has(name), true, `missing runtime file: ${name}`);
  for (const name of privateFiles) assert.equal(names.has(name), false, `private file exported: ${name}`);
});
