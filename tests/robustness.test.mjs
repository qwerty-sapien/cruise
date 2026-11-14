import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generateCases, NOT_EVALUATED } from './robustness/corpus.mjs';
import { validateCaseArtifact, summarize } from './robustness/oracle.mjs';
import { runEvaluation, parseArguments } from './robustness/run.mjs';

test('seeded corpus is reproducible and held-out mutations are disjoint', () => {
  const first = generateCases({ seed: 42 });
  assert.deepEqual(first, generateCases({ seed: 42 }));
  assert.notDeepEqual(first, generateCases({ seed: 43 }));
  const discovery = new Set(first.filter((c) => c.split === 'discovery').map((c) => c.token));
  assert.ok(first.filter((c) => c.split === 'heldout').every((c) => !discovery.has(c.token)));
  assert.throws(() => generateCases({ discoverySeeds: 0 }));
  assert.throws(() => parseArguments(['--unknown', 'yes']));
  assert.ok(NOT_EVALUATED.some((line) => /authentication/u.test(line)));
});

test('evaluator rejects zero-exit fabricated, missing, malformed and stale results', () => {
  const testCase = { id: 'fixture', adapter: 'approval' };
  const child = { status: 0, signal: null, stderr: '' };
  const valid = { schemaVersion: 1, nonce: 'current', caseId: testCase.id, adapter: testCase.adapter,
    status: 'pass', assertions: 1, observations: [{ actual: 'observed' }], outcome: 'owner_decision_preserved' };
  const check = (value, override = {}) => validateCaseArtifact({ child: { ...child, ...override }, text: value, nonce: 'current', testCase });
  assert.equal(check(JSON.stringify(valid)).status, 'pass');
  for (const invalid of ['', 'not json', '{}', JSON.stringify({ ...valid, nonce: 'previous' }),
    JSON.stringify({ ...valid, caseId: 'other' }), JSON.stringify({ ...valid, assertions: 0 }),
    JSON.stringify({ ...valid, observations: [] }), JSON.stringify({ ...valid, status: 'complete' })]) assert.throws(() => check(invalid));
  assert.throws(() => check(JSON.stringify(valid), { status: 1 }));
  assert.throws(() => check(JSON.stringify(valid), { stderr: 'ERR_UNHANDLED_REJECTION' }));
});

test('critical failures and contained host failures cannot average into completion', () => {
  const summary = summarize([
    { id: 'a', family: 'x', status: 'pass', split: 'discovery', outcome: 'contained_host_failure' },
    { id: 'b', family: 'x', status: 'invariant_fail', split: 'heldout', critical: true },
  ]);
  assert.equal(summary.families.x.contained_host_failure, 1);
  assert.equal(summary.families.x.heldout.failed, 1);
  assert.deepEqual(summary.criticalWorstCaseFailures, ['b']);
});

test('real adapter observations create machine-readable reports and missing APIs fail visibly', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-robustness-harness-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = generateCases({ seed: 42, discoverySeeds: 1, heldoutSeeds: 1 });
  const selected = cases.filter((c) => c.split === 'discovery' && ['approval', 'classification', 'worker-startup', 'permission-inheritance'].includes(c.adapter));
  const report = await runEvaluation({ output: join(root, 'real'), cases: selected });
  assert.equal(report.summary.invariantFailures, 0);
  assert.equal(report.summary.harnessErrors, 0);
  assert.equal(report.summary.total, selected.length);
  assert.equal(report.summary.families['host-permission-inheritance'].total, 8);
  assert.equal(report.summary.families['host-permission-inheritance'].contained_native_denial, 4);
  assert.match(await readFile(join(root, 'real/results.tsv'), 'utf8'), /owner-decisions/u);
  await writeFile(join(root, 'package.json'), '{}');
  const unsupported = await runEvaluation({ target: root, output: join(root, 'unsupported'), cases: [selected[0]] });
  assert.equal(unsupported.summary.harnessErrors, 1);
  assert.equal(unsupported.summary.passed, 0);
  assert.equal(unsupported.results[0].child.joined, true);
  const replay = JSON.parse(await readFile(join(root, 'unsupported/failures', `${selected[0].id}.json`), 'utf8'));
  assert.deepEqual(replay.case, selected[0]);
  assert.match(replay.failure.observations[0].message, /Cannot load/u);
});
