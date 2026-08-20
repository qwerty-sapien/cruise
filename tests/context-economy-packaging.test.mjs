import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const POLICY_FILE_HARD_CAP_BYTES = 16 * 1024;
const POLICY_FILES = [
  'AGENTS.md',
  'skills/context-economy/SKILL.md',
  'skills/context-economy/references/HANDOFF.md',
  'skills/context-economy/references/RETRIEVAL.md',
  'skills/context-economy/references/ROUTING.md',
  'skills/context-economy/references/USAGE_ACCOUNTING.md',
  'skills/context-economy/references/SKILL_TRIGGERS.md',
  'skills/context-economy/templates/HANDOFF.template.md',
  'skills/context-economy/templates/cell_tracking-CURRENT.template.md',
  'skills/context-economy/templates/check-in-CURRENT.template.md',
  'skills/context-economy/assets/context-capsule.schema.json',
  'skills/context-economy/assets/usage-ledger.schema.json',
];
const RUNTIME_FILES = [
  'scripts/context-view.mjs',
  'scripts/mock-efficiency-benchmark.mjs',
  'scripts/validate-context-economy-audit.mjs',
  'scripts/lib/compaction-controller.mjs',
  'scripts/lib/context-capsule.mjs',
  'scripts/lib/quota-guard.mjs',
  'scripts/lib/root-policy.mjs',
  'scripts/lib/skill-trigger-policy.mjs',
  'scripts/lib/usage-meter.mjs',
  'scripts/lib/worker-dispatcher.mjs',
];

test('context-economy policy files stay within one bounded file window', async () => {
  for (const path of POLICY_FILES) {
    const metadata = await stat(resolve(ROOT, path));
    assert.ok(
      metadata.size <= POLICY_FILE_HARD_CAP_BYTES,
      `${path} is ${metadata.size} bytes; cap is ${POLICY_FILE_HARD_CAP_BYTES}`,
    );
  }
});

test('npm package ships the context-economy policy and runtime modules', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'cruise-npm-cache-'));
  try {
    const output = execFileSync(
      'npm',
      ['pack', '--dry-run', '--json', '--ignore-scripts'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, npm_config_cache: cache },
        maxBuffer: 1024 * 1024,
      },
    );
    const [{ files }] = JSON.parse(output);
    const shipped = new Set(files.map(({ path }) => path));

    for (const path of [
      'benchmark/BENCHMARK_PLAN.md',
      'benchmark/mock-transcripts.json',
      ...POLICY_FILES.filter((path) => path.startsWith('skills/')),
      ...RUNTIME_FILES,
    ]) {
      assert.ok(shipped.has(path), `${path} is absent from the npm package`);
    }
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});
