import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { validateSpatiomicsFixture } from '../scripts/validate-spatiomics.mjs';

const exec = promisify(execFile);
const FIXTURE_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('validates the synthetic spatiomics repository and skill surface', async () => {
  const result = await validateSpatiomicsFixture(FIXTURE_ROOT);
  assert.deepEqual(result.gem.rows, 3);
  assert.deepEqual(result.gem.genes, 2);
  assert.deepEqual(result.gem.mid_counts, 10);
  assert.match(result.gem.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.annotations, 2);
  assert.equal(result.gtf_features, 2);
  assert.equal(result.reference_bases, 40);
  assert.equal(result.manifest_inputs, 9);
  assert.equal(result.format_markers, 10);
  assert.equal(result.workflow, 'workflow/Snakefile');
  assert.equal(result.skill, 'spatiomics-skill');
});

test('bundled inspector identifies positive routes and handles extensionless inputs', async () => {
  const { stdout } = await exec('python3', [
    '.agents/skills/spatiomics-skill/scripts/inspect_spatial_inputs.py',
    '--json',
    'data/tiny_expression.gem',
    'data/tiny_reference.gtf',
    'data/tiny_labels.anno',
    'data/tiny_reference_marker',
    'data/tiny_graph.geff',
  ], { cwd: FIXTURE_ROOT });
  const reports = JSON.parse(stdout);
  assert.equal(reports[0].kind, 'gem');
  assert.equal(reports[0].ok, true);
  assert.equal(reports[1].kind, 'gtf-or-gff');
  assert.equal(reports[1].ok, true);
  assert.equal(reports[2].kind, 'ambiguous-annotation');
  assert.equal(reports[2].requires_manifest, true);
  assert.equal(reports[3].kind, 'extensionless-file');
  assert.equal(reports[3].requires_manifest, true);
  assert.equal(reports[4].kind, 'geff-or-zarr');
  assert.equal(reports[4].container, 'zarr');
});

test('bundled inspector rejects suffix-only SIF identity', async () => {
  await assert.rejects(
    exec('python3', [
      '.agents/skills/spatiomics-skill/scripts/inspect_spatial_inputs.py',
      '--json',
      'data/tiny_not_a_container.sif',
    ], { cwd: FIXTURE_ROOT }),
    (error) => {
      assert.equal(error.code, 1);
      const [report] = JSON.parse(error.stdout);
      assert.equal(report.kind, 'sif');
      assert.equal(report.container, 'unknown');
      assert.equal(report.ok, false);
      assert.match(report.warnings.join('\n'), /suffix-only identity is rejected/iu);
      return true;
    },
  );
});

test('fixture validation fails after a manifest-bound input changes', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'spatiomics-fixture-tamper-'));
  try {
    await cp(FIXTURE_ROOT, sandbox, { recursive: true });
    await writeFile(join(sandbox, 'data', 'tiny_expression.gem'), 'tampered\n', 'utf8');
    await assert.rejects(
      validateSpatiomicsFixture(sandbox),
      /manifest digest mismatch for data\/tiny_expression\.gem/iu,
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
