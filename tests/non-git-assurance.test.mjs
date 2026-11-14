import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';

import { captureWorkspaceFingerprint } from '../scripts/lib/supervisor.mjs';
import { captureFlightAssuranceContext, evaluateFlightAssurance } from '../scripts/lib/assurance.mjs';
import { flightPlanTemplate, parseFlightPlan, writeFlightPlan } from '../scripts/lib/flight-plan.mjs';
import { runAttest } from '../scripts/cruise.mjs';

async function fixture(t) {
  const cwd = await fs.mkdtemp(join(tmpdir(), 'cruise-non-git-assurance-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.mkdir(join(cwd, '.cruise'));
  await fs.mkdir(join(cwd, 'src'));
  await fs.mkdir(join(cwd, 'docs'));
  await fs.writeFile(join(cwd, 'src/a.txt'), 'first\n');
  await fs.writeFile(join(cwd, 'docs/b.txt'), 'second\n');
  await fs.writeFile(join(cwd, '.cruise/ORIGIN.md'), 'Synthetic test request\n');
  const plan = parseFlightPlan(flightPlanTemplate().replaceAll('<path-or-glob>', 'src/a.txt'));
  assert.ok(plan);
  plan.quality.gates.find((gate) => gate.dimension === 'regression').surface = ['docs/b.txt'];
  return { cwd, plan };
}

async function capture(cwd, plan) {
  const workspaceFingerprint = await captureWorkspaceFingerprint(cwd, { excludeFlightPlan: true });
  assert.ok(workspaceFingerprint, 'declared non-Git product fingerprint must be available');
  return captureFlightAssuranceContext(cwd, plan, {
    workspaceFingerprint,
    surfaceFingerprintReader: (paths) => captureWorkspaceFingerprint(cwd, { excludeFlightPlan: true, paths }),
  });
}

async function attestFixture(cwd, plan) {
  await writeFlightPlan(cwd, plan);
  const context = await capture(cwd, plan);
  for (const gate of plan.quality.gates) {
    gate.state = 'passed';
    gate.evidence = {
      summary: 'Synthetic fixture evidence for freshness testing only',
      contextFingerprint: context.gateFingerprints[gate.id],
      observedAt: 1,
      source: 'review',
      rationale: '',
      waivedBy: '',
    };
  }
  plan.status = 'complete';
  await writeFlightPlan(cwd, plan);
  return context;
}

test('non-Git attestation moves from unavailable scope to fresh context without bypassing pending gates', async (t) => {
  const { cwd, plan } = await fixture(t);
  // Reproduce the old unavailable result before a safe product scope exists.
  assert.equal(await captureWorkspaceFingerprint(cwd, { excludeFlightPlan: true }), null);
  await writeFlightPlan(cwd, plan);
  const context = await capture(cwd, plan);
  assert.equal(evaluateFlightAssurance(plan, context).allowsCompletion, false);
  await attestFixture(cwd, plan);
  let output = '';
  await runAttest({ cwd, json: true }, { output: { write: (text) => { output += text; } } });
  const report = JSON.parse(output);
  assert.equal(report.level, 'assured');
  assert.equal(report.allows_completion, true);
  assert.equal(report.context_fingerprint, context.contextFingerprint);
  await assert.rejects(fs.lstat(join(cwd, '.git')), { code: 'ENOENT' });
});

test('product edits and deletion invalidate affected evidence while another surface stays fresh', async (t) => {
  const { cwd, plan } = await fixture(t);
  const context = await attestFixture(cwd, plan);
  for (const mutate of [
    () => fs.writeFile(join(cwd, 'src/a.txt'), 'changed\n'),
    () => fs.unlink(join(cwd, 'src/a.txt')),
  ]) {
    await mutate();
    const changed = await capture(cwd, plan);
    assert.notEqual(changed.contextFingerprint, context.contextFingerprint);
    const assessment = evaluateFlightAssurance(plan, changed);
    assert.equal(assessment.allowsCompletion, false);
    assert.equal(assessment.gates.find((gate) => gate.dimension === 'regression').fresh, true);
    assert.equal(assessment.gates.find((gate) => gate.dimension === 'functional-correctness').fresh, false);
    assert.ok(assessment.reasons.some((reason) => /stale/u.test(reason)));
  }
});

test('unrelated files and runtime/control updates leave declared evidence fresh; request edits do not', async (t) => {
  const { cwd, plan } = await fixture(t);
  const context = await attestFixture(cwd, plan);
  await fs.writeFile(join(cwd, 'unrelated.txt'), 'unrelated source');
  await fs.writeFile(join(cwd, '.cruise/LAST-RUN.json'), '{"state":"changed"}');
  await fs.writeFile(join(cwd, '.cruise/HANDOFF.md'), 'runtime state');
  assert.deepEqual(await capture(cwd, plan), context);
  await fs.writeFile(join(cwd, '.cruise/ORIGIN.md'), 'Changed request');
  const changed = await capture(cwd, plan);
  assert.notEqual(changed.contextFingerprint, context.contextFingerprint);
  assert.ok(evaluateFlightAssurance(plan, changed).gates.every((gate) => !gate.fresh));
});

test('touchpoint and gate surface expansion invalidate exactly their contract scope', async (t) => {
  const { cwd, plan } = await fixture(t);
  const context = await attestFixture(cwd, plan);
  plan.scope.touchpoints.push('new.txt');
  await writeFlightPlan(cwd, plan);
  const expanded = await capture(cwd, plan);
  assert.notEqual(expanded.contextFingerprint, context.contextFingerprint);
  const functional = plan.quality.gates.find((gate) => gate.dimension === 'functional-correctness');
  assert.equal(expanded.gateFingerprints[functional.id], context.gateFingerprints[functional.id]);
  await fs.writeFile(join(cwd, 'new.txt'), 'new product');
  const created = await capture(cwd, plan);
  assert.notEqual(created.contextFingerprint, expanded.contextFingerprint);
  functional.surface.push('new.txt');
  await writeFlightPlan(cwd, plan);
  const widenedGate = await capture(cwd, plan);
  assert.notEqual(widenedGate.gateFingerprints[functional.id], created.gateFingerprints[functional.id]);
  assert.equal(widenedGate.gateFingerprints['core.regression'], created.gateFingerprints['core.regression']);
});

test('empty declarations remain unavailable; explicit missing and empty surfaces are deterministic', async (t) => {
  const { cwd, plan } = await fixture(t);
  plan.scope.touchpoints = [];
  for (const gate of plan.quality.gates) gate.surface = ['.'];
  await writeFlightPlan(cwd, plan);
  assert.equal(await captureWorkspaceFingerprint(cwd), null);
  assert.equal(await captureWorkspaceFingerprint(cwd, { paths: [] }), null);
  const paths = ['future/file.txt'];
  const missing = await captureWorkspaceFingerprint(cwd, { paths });
  assert.ok(missing);
  await fs.mkdir(join(cwd, 'future'));
  assert.equal(await captureWorkspaceFingerprint(cwd, { paths }), missing);
  await fs.writeFile(join(cwd, 'future/file.txt'), 'created');
  assert.notEqual(await captureWorkspaceFingerprint(cwd, { paths }), missing);
  await fs.unlink(join(cwd, 'future/file.txt'));
  assert.equal(await captureWorkspaceFingerprint(cwd, { paths }), missing);
  const empty = await captureWorkspaceFingerprint(cwd, { paths: ['future'] });
  assert.ok(empty);
  await fs.writeFile(join(cwd, 'future/added.txt'), 'addition');
  assert.notEqual(await captureWorkspaceFingerprint(cwd, { paths: ['future'] }), empty);
  // A scoped gate supplies a declaration even when touchpoints are empty.
  plan.quality.gates[1].surface = ['src/a.txt'];
  await writeFlightPlan(cwd, plan);
  assert.ok(await captureWorkspaceFingerprint(cwd));
});

test('glob membership and filesystem ordering produce deterministic bounded snapshots', async (t) => {
  const { cwd } = await fixture(t);
  const paths = ['src/**/*.txt'];
  const before = await captureWorkspaceFingerprint(cwd, { paths });
  assert.ok(before);
  await fs.writeFile(join(cwd, 'src/ignored.js'), 'outside glob');
  assert.equal(await captureWorkspaceFingerprint(cwd, { paths }), before);
  await fs.mkdir(join(cwd, 'src/nested'));
  await fs.writeFile(join(cwd, 'src/nested/new.txt'), 'in glob');
  assert.notEqual(await captureWorkspaceFingerprint(cwd, { paths }), before);
  assert.equal(
    await captureWorkspaceFingerprint(cwd, { paths: ['docs/b.txt', 'src/a.txt'] }),
    await captureWorkspaceFingerprint(cwd, { paths: ['src/a.txt', 'docs/b.txt', 'src/a.txt'] }),
  );
  const noMatches = await captureWorkspaceFingerprint(cwd, { paths: ['src/*.md'] });
  assert.ok(noMatches);
  await fs.writeFile(join(cwd, 'src/nested/.ignore'), '!unsupported-but-outside-selected-scope\n');
  await fs.writeFile(join(cwd, 'src/nested/no-match.md'), 'not a direct child');
  assert.equal(await captureWorkspaceFingerprint(cwd, { paths: ['src/*.md'] }), noMatches);
  await fs.writeFile(join(cwd, 'src/new.md'), 'new match');
  assert.notEqual(await captureWorkspaceFingerprint(cwd, { paths: ['src/*.md'] }), noMatches);
});

test('sensitive, ignored, underscore, control and symlink paths are never opened', async (t) => {
  const { cwd } = await fixture(t);
  const outside = await fs.mkdtemp(join(tmpdir(), 'cruise-non-git-link-target-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const excluded = ['.env', '.env.local', 'config.env', 'credentials.json', 'id_rsa', 'tls.pem', '_PRIVATE.MD', 'personal.txt', 'ignored.txt'];
  for (const name of excluded) await fs.writeFile(join(cwd, name), 'synthetic fixture only');
  for (const directory of ['secrets', 'ignored', '.obsidian']) {
    await fs.mkdir(join(cwd, directory));
    await fs.writeFile(join(cwd, directory, 'data.txt'), 'synthetic fixture only');
  }
  await fs.writeFile(join(cwd, '.gitignore'), 'ignored/\nignored.txt\n');
  await fs.writeFile(join(cwd, 'docs/.ignore'), 'private.txt\n');
  await fs.writeFile(join(cwd, 'docs/private.txt'), 'synthetic fixture only');
  await fs.writeFile(join(outside, 'outside.txt'), 'must never be opened');
  await fs.symlink(outside, join(cwd, 'linked-directory'));
  await fs.symlink(join(outside, 'outside.txt'), join(cwd, 'linked-file.txt'));
  const opened = [];
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (path, ...args) => {
    opened.push(relative(cwd, path));
    return originalOpen.call(fs, path, ...args);
  });
  const options = { paths: ['.'], explicitSensitivePaths: ['personal.txt'] };
  const before = await captureWorkspaceFingerprint(cwd, options);
  assert.ok(before);
  for (const name of excluded) await fs.writeFile(join(cwd, name), 'changed synthetic fixture');
  await fs.writeFile(join(cwd, 'docs/private.txt'), 'changed ignored fixture');
  await fs.writeFile(join(cwd, '.cruise/LAST-RUN.json'), '{}');
  await fs.writeFile(join(outside, 'outside.txt'), 'changed link target');
  assert.equal(await captureWorkspaceFingerprint(cwd, options), before);
  assert.deepEqual([...new Set(opened)].sort(), ['.gitignore', 'docs/.ignore', 'docs/b.txt', 'src/a.txt']);
  for (const path of [...excluded, 'ignored/data.txt', 'secrets/data.txt', 'linked-directory/outside.txt', 'linked-file.txt']) {
    assert.equal(await captureWorkspaceFingerprint(cwd, { ...options, paths: [path] }), null, path);
  }
  assert.deepEqual([...new Set(opened)].sort(), ['.gitignore', 'docs/.ignore', 'docs/b.txt', 'src/a.txt']);
});

test('symlinked Flight, origin and ignore policies fail closed without reading targets', async (t) => {
  const { cwd, plan } = await fixture(t);
  await writeFlightPlan(cwd, plan);
  for (const name of ['.gitignore', '.cruise/FLIGHT.md']) {
    await fs.rm(join(cwd, name), { force: true });
    await fs.symlink(join(cwd, 'src/a.txt'), join(cwd, name));
    assert.equal(await captureWorkspaceFingerprint(cwd), null);
    await fs.unlink(join(cwd, name));
  }
  await writeFlightPlan(cwd, plan);
  const fingerprint = await captureWorkspaceFingerprint(cwd);
  await fs.unlink(join(cwd, '.cruise/ORIGIN.md'));
  await fs.symlink(join(cwd, 'src/a.txt'), join(cwd, '.cruise/ORIGIN.md'));
  await assert.rejects(captureFlightAssuranceContext(cwd, plan, { workspaceFingerprint: fingerprint }), /symlink/u);
});

test('unsupported selectors, ignore syntax, oversized inputs and depth bounds stay unavailable', async (t) => {
  const { cwd } = await fixture(t);
  for (const paths of [['../outside'], ['/outside'], ['src/[ab].txt'], ['src/{a,b}.txt'], [':(glob)src/**']]) {
    assert.equal(await captureWorkspaceFingerprint(cwd, { paths }), null);
  }
  await fs.writeFile(join(cwd, '.gitignore'), '!potentially-private.txt\n');
  assert.equal(await captureWorkspaceFingerprint(cwd, { paths: ['src/a.txt'] }), null);
  await fs.unlink(join(cwd, '.gitignore'));
  await fs.writeFile(join(cwd, 'too-large.txt'), Buffer.alloc(1024 * 1024 + 1));
  assert.equal(await captureWorkspaceFingerprint(cwd, { paths: ['too-large.txt'] }), null);
  const deep = `deep/${Array(17).fill('child').join('/')}`;
  await fs.mkdir(join(cwd, deep), { recursive: true });
  await fs.writeFile(join(cwd, deep, 'file.txt'), 'too deep');
  assert.equal(await captureWorkspaceFingerprint(cwd, { paths: ['deep'] }), null);
});

test('entry and aggregate byte bounds never return a partial product fingerprint', async (t) => {
  const { cwd } = await fixture(t);
  await fs.mkdir(join(cwd, 'many'));
  for (let start = 0; start < 4100; start += 100) {
    await Promise.all(Array.from({ length: 100 }, (_, index) => fs.writeFile(join(cwd, `many/${start + index}.txt`), '')));
  }
  assert.equal(await captureWorkspaceFingerprint(cwd, { paths: ['many'] }), null);
  await fs.mkdir(join(cwd, 'large'));
  for (let i = 0; i < 9; i += 1) await fs.writeFile(join(cwd, `large/${i}.txt`), Buffer.alloc(1024 * 1024));
  assert.equal(await captureWorkspaceFingerprint(cwd, { paths: ['large'] }), null);
});

test('invalid Git metadata is not reclassified as a valid filesystem workspace', async (t) => {
  const { cwd, plan } = await fixture(t);
  await writeFlightPlan(cwd, plan);
  await fs.mkdir(join(cwd, '.git'));
  assert.equal(await captureWorkspaceFingerprint(cwd), null);
});
