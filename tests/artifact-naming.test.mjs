import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  allocateRunName,
  assertArtifactFileName,
  assertRunName,
  MAX_ARTIFACT_NAME_LENGTH,
  parseLevelOneNameOutput,
  parseRunNamingOutput,
  REPOSITORY_ARTIFACTS,
  RUN_ARTIFACTS,
  runNamingPacket,
} from '../scripts/lib/artifact-naming.mjs';

async function modulePaths(root) {
  const paths = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...await modulePaths(path));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) paths.push(path);
  }
  return paths;
}

test('canonical run artifact filenames are informative and at most 15 characters', () => {
  for (const name of [...Object.values(RUN_ARTIFACTS), ...Object.values(REPOSITORY_ARTIFACTS)]) {
    assert.equal(assertArtifactFileName(name), name);
    assert.equal(name.length <= MAX_ARTIFACT_NAME_LENGTH, true, name);
  }
});

test('runtime path construction never uses random, UUID, timestamp, or digest material', async () => {
  for (const path of await modulePaths(resolve('scripts'))) {
    const source = await readFile(path, 'utf8');
    assert.doesNotMatch(source, /\bmkdtemp\s*\(/u, path);
    assert.doesNotMatch(
      source,
      /const\s+(?:key|name|path|directory)\s*=\s*(?:fileDigest|digest|sha256)\s*\(/u,
      path,
    );
    assert.doesNotMatch(
      source,
      /(?:join|resolve)\([^\n]*(?:randomUUID\(|Date\.now\()/u,
      path,
    );
    assert.doesNotMatch(source, /\.(?:tmp|stage)-\$\{/u, path);
  }
});

test('run names reject UUIDs, hash fragments, timestamps, randomness, and generic labels', () => {
  for (const value of [
    'run',
    'task',
    '123456',
    '20260716-fix',
    'deadbeef-fix',
    '550e8400-e29b-41d4-a716-446655440000',
    'this-name-is-far-too-long',
    'Mixed-Case',
    'name_with_uuid',
  ]) {
    assert.throws(() => assertRunName(value), /run name/u, value);
  }
  assert.equal(assertRunName('auth-retry'), 'auth-retry');
  assert.equal(assertRunName('docs-polish'), 'docs-polish');
});

test('level-1 naming output is exact and explanation-free', () => {
  assert.equal(parseLevelOneNameOutput('{"name":"queue-repair"}'), 'queue-repair');
  assert.throws(
    () => parseLevelOneNameOutput('```json\n{"name":"queue-repair"}\n```'),
    /exact JSON/u,
  );
  assert.deepEqual(
    parseRunNamingOutput('{"run_name":"queue-repair","repo_name":"queue-core"}'),
    { run_name: 'queue-repair', repo_name: 'queue-core' },
  );
  assert.throws(
    () => parseLevelOneNameOutput('{"name":"queue-repair","why":"clear"}'),
    /exactly the name field/u,
  );
});

test('naming packet assigns only naming to level 1 and forbids random material', () => {
  const packet = runNamingPacket({
    skill: 'quick',
    prompt: 'Repair the queue recovery path.',
    unavailable: ['queue-repair'],
  });
  assert.match(packet, /level-1 naming worker/u);
  assert.match(packet, /at most 15 characters/u);
  assert.match(packet, /Do not use a UUID, SHA\/hash fragment, timestamp, sequence number, random text/u);
  assert.match(packet, /Unavailable names:\n- queue-repair/u);
  assert.match(packet, /"run_name":"short-run","repo_name":"short-repo"/u);
});

test('run allocation requires a proven level-1 worker and rejects collisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'name-test-'));
  await mkdir(join(root, '.cruise', 'runs', 'queue-repair'), { recursive: true });
  const calls = [];
  const allocated = await allocateRunName({
    root,
    skill: 'quick',
    prompt: 'Repair queue recovery.',
    async invokeWorker(input) {
      calls.push(input);
      return {
        launch: {
          recommended_level: 1,
          agent_type: 'cruise_l1',
          resolved: { model: 'luna', reasoning_effort: 'medium' },
        },
        model_output: '{"run_name":"queue-recov","repo_name":"queue-core"}',
      };
    },
  });
  assert.equal(allocated.name, 'queue-recov');
  assert.equal(allocated.repository_name, 'queue-core');
  assert.equal(calls[0].level, 1);
  assert.match(calls[0].packet, /- queue-repair/u);

  await assert.rejects(allocateRunName({
    root,
    skill: 'quick',
    prompt: 'Repair queue recovery.',
    async invokeWorker() {
      return {
        launch: { recommended_level: 2, agent_type: 'cruise_l2' },
        model_output: '{"run_name":"queue-recov","repo_name":"queue-core"}',
      };
    },
  }), /not produced by the Cruise level-1 worker/u);

  await assert.rejects(allocateRunName({
    root,
    skill: 'quick',
    prompt: 'Repair queue recovery.',
    async invokeWorker() {
      return {
        launch: { recommended_level: 1, agent_type: 'cruise_l1', resolved: {} },
        model_output: '{"run_name":"queue-repair","repo_name":"queue-core"}',
      };
    },
  }), /unavailable run name/u);
});
