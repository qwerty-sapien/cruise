import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  atomicWriteText,
  captureWorkspaceFingerprint,
  extractFailureSignature,
  GoalSupervisor,
  MAX_SUPERVISOR_HISTORY,
  validSupervisorState,
} from '../scripts/lib/supervisor.mjs';

test('new workspace evidence is progress and resets an active ladder', () => {
  const supervisor = new GoalSupervisor({ stall: { quietTurns: 2, sameFailure: 2 } });
  assert.equal(supervisor.recordTurn({ fingerprint: 'alpha' }).level, 'ok');
  assert.equal(supervisor.recordTurn({ fingerprint: 'alpha' }).level, 'ok');
  assert.equal(supervisor.recordTurn({ fingerprint: 'alpha' }).level, 'realign');
  assert.equal(supervisor.recordTurn({ fingerprint: 'bravo' }).level, 'ok');
  assert.equal(supervisor.recordTurn({ fingerprint: 'bravo' }).level, 'ok');
  assert.equal(supervisor.summary().interventions.length, 0);
});

test('quiet turns climb once through realign, final experiment, and stall', () => {
  const supervisor = new GoalSupervisor({ stall: { quietTurns: 2, sameFailure: 9 } });
  const levels = [
    supervisor.recordTurn({ fingerprint: 'same' }).level,
    supervisor.recordTurn({ fingerprint: 'same' }).level,
    supervisor.recordTurn({ fingerprint: 'same' }).level,
    supervisor.recordTurn({ fingerprint: 'same' }).level,
    supervisor.recordTurn({ fingerprint: 'same' }).level,
  ];
  assert.deepEqual(levels, ['ok', 'ok', 'realign', 'final-experiment', 'stall']);
  assert.match(supervisor.summary().interventions[0].reason, /unchanged for 2 consecutive turns/u);
  assert.deepEqual(supervisor.summary().interventions.map(({ level }) => level), [
    'realign',
    'final-experiment',
  ]);
});

test('an absolute completion-attempt cap cannot be reset by fingerprint churn', () => {
  const supervisor = new GoalSupervisor({
    stall: { quietTurns: 99, sameFailure: 99 },
    maxTurns: 3,
  });
  assert.equal(supervisor.recordTurn({ fingerprint: 'contract-a' }).level, 'ok');
  assert.equal(supervisor.recordTurn({ fingerprint: 'contract-b' }).level, 'ok');
  const capped = supervisor.recordTurn({ fingerprint: 'contract-c' });
  assert.equal(capped.level, 'stall');
  assert.match(capped.reason, /absolute supervision cap of 3/u);
});

test('an invalid-flight correction replaces rather than duplicates a ladder intervention', () => {
  const supervisor = new GoalSupervisor({ stall: { quietTurns: 1, sameFailure: 9 }, now: () => 10 });
  assert.equal(supervisor.recordTurn({ fingerprint: 'same' }).level, 'ok');
  const corrected = supervisor.recordTurn({
    fingerprint: 'same',
    corrective: { contentHash: 'invalid-one', reason: 'invalid frontmatter' },
  });
  assert.equal(corrected.level, 'corrective');
  assert.deepEqual(supervisor.summary().interventions.map(({ level }) => level), ['corrective']);
  assert.equal(supervisor.state().observations.at(-1).verdict_level, 'corrective');
  assert.equal(supervisor.recordTurn({ fingerprint: 'same' }).level, 'final-experiment');
  assert.deepEqual(supervisor.summary().interventions.map(({ level }) => level), [
    'corrective',
    'final-experiment',
  ]);
});

test('returning to an earlier fingerprint is named as oscillation', () => {
  const supervisor = new GoalSupervisor({ stall: { quietTurns: 1, sameFailure: 9 } });
  assert.equal(supervisor.recordTurn({ fingerprint: 'before' }).level, 'ok');
  assert.equal(supervisor.recordTurn({ fingerprint: 'after' }).level, 'ok');
  const verdict = supervisor.recordTurn({ fingerprint: 'before' });
  assert.equal(verdict.level, 'realign');
  assert.match(verdict.reason, /oscillated to earlier fingerprint/u);
});

test('repeated failures supervise a non-git workspace independently', () => {
  const supervisor = new GoalSupervisor({ stall: { quietTurns: 9, sameFailure: 2 } });
  const signature = 'a'.repeat(64);
  assert.equal(supervisor.recordTurn({ fingerprint: null, failureSignature: signature }).level, 'ok');
  const realign = supervisor.recordTurn({ fingerprint: null, failureSignature: signature });
  assert.equal(realign.level, 'realign');
  assert.match(realign.reason, /failure signature a{12} repeated 2 consecutive turns/u);
  assert.equal(supervisor.recordTurn({ fingerprint: null, failureSignature: signature }).level, 'final-experiment');
  assert.equal(supervisor.recordTurn({ fingerprint: null, failureSignature: signature }).level, 'stall');
});

test('signature-only supervision recovers when failure evidence changes or clears', () => {
  const changed = new GoalSupervisor({ stall: { quietTurns: 9, sameFailure: 2 } });
  assert.equal(changed.recordTurn({ fingerprint: null, failureSignature: 'alpha' }).level, 'ok');
  assert.equal(changed.recordTurn({ fingerprint: null, failureSignature: 'alpha' }).level, 'realign');
  const recovery = changed.recordTurn({ fingerprint: null, failureSignature: 'bravo' });
  assert.equal(recovery.level, 'ok');
  assert.match(recovery.reason, /failure evidence changed/u);
  assert.equal(changed.summary().interventions.length, 0);

  const cleared = new GoalSupervisor({ stall: { quietTurns: 9, sameFailure: 2 } });
  cleared.recordTurn({ fingerprint: null, failureSignature: 'alpha' });
  cleared.recordTurn({ fingerprint: null, failureSignature: 'alpha' });
  assert.equal(cleared.recordTurn({ fingerprint: null, failureSignature: null }).level, 'ok');
});

test('workspace fingerprinting is disabled without a git repository', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-supervisor-no-git-'));
  try {
    assert.equal(await captureWorkspaceFingerprint(cwd), null);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('invalid flight rewrites do not hide real workspace progress', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-supervisor-flight-exclusion-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, '.cruise'));
  await writeFile(join(cwd, '.cruise', 'FLIGHT.md'), 'invalid one\n', 'utf8');
  await writeFile(join(cwd, 'work.txt'), 'before\n', 'utf8');
  const initialized = spawnSync('git', ['init', '--quiet'], { cwd, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const added = spawnSync('git', ['add', '.'], { cwd, encoding: 'utf8' });
  assert.equal(added.status, 0, added.stderr);

  const baseline = await captureWorkspaceFingerprint(cwd, { excludeFlightPlan: true });
  await writeFile(join(cwd, '.cruise', 'FLIGHT.md'), 'invalid two\n', 'utf8');
  assert.equal(await captureWorkspaceFingerprint(cwd, { excludeFlightPlan: true }), baseline);
  await writeFile(join(cwd, 'work.txt'), 'after\n', 'utf8');
  assert.notEqual(await captureWorkspaceFingerprint(cwd, { excludeFlightPlan: true }), baseline);
});

test('product fingerprints include HEAD and exact untracked contents', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-supervisor-strong-fingerprint-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'tracked.txt'), 'stable\n', 'utf8');
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd }).status, 0);
  assert.equal(spawnSync('git', ['add', 'tracked.txt'], { cwd }).status, 0);
  assert.equal(spawnSync('git', [
    '-c',
    'user.name=Cruise Tests',
    '-c',
    'user.email=tests@example.com',
    'commit',
    '--quiet',
    '-m',
    'baseline',
  ], { cwd }).status, 0);
  const baseline = await captureWorkspaceFingerprint(cwd, { excludeFlightPlan: true });
  assert.equal(spawnSync('git', [
    '-c',
    'user.name=Cruise Tests',
    '-c',
    'user.email=tests@example.com',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'new head',
  ], { cwd }).status, 0);
  const changedHead = await captureWorkspaceFingerprint(cwd, { excludeFlightPlan: true });
  assert.notEqual(changedHead, baseline);

  await writeFile(join(cwd, 'untracked.txt'), 'first\n', 'utf8');
  const firstUntracked = await captureWorkspaceFingerprint(cwd, { excludeFlightPlan: true });
  await writeFile(join(cwd, 'untracked.txt'), 'second\n', 'utf8');
  const secondUntracked = await captureWorkspaceFingerprint(cwd, { excludeFlightPlan: true });
  assert.notEqual(secondUntracked, firstUntracked);

  await symlink('tracked.txt', join(cwd, 'link.txt'));
  const firstLink = await captureWorkspaceFingerprint(cwd, { excludeFlightPlan: true });
  await unlink(join(cwd, 'link.txt'));
  await symlink('untracked.txt', join(cwd, 'link.txt'));
  const secondLink = await captureWorkspaceFingerprint(cwd, { excludeFlightPlan: true });
  assert.notEqual(secondLink, firstLink);

  await mkdir(join(cwd, '.cruise'));
  await writeFile(join(cwd, '.cruise', '.attestation.json'), '{}\n', 'utf8');
  assert.equal(
    await captureWorkspaceFingerprint(cwd, { excludeFlightPlan: true }),
    secondLink,
  );
});

test('surface fingerprints ignore edits outside their repository-relative paths', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-supervisor-surface-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, 'src'));
  await mkdir(join(cwd, 'docs'));
  await writeFile(join(cwd, 'src', 'owner.mjs'), 'export const value = 1;\n', 'utf8');
  await writeFile(join(cwd, 'docs', 'note.md'), 'first\n', 'utf8');
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd }).status, 0);
  assert.equal(spawnSync('git', ['add', '.'], { cwd }).status, 0);
  const baseline = await captureWorkspaceFingerprint(cwd, { paths: ['src/**'] });
  await writeFile(join(cwd, 'docs', 'note.md'), 'second\n', 'utf8');
  assert.equal(await captureWorkspaceFingerprint(cwd, { paths: ['src/**'] }), baseline);
  await writeFile(join(cwd, 'src', 'owner.mjs'), 'export const value = 2;\n', 'utf8');
  assert.notEqual(await captureWorkspaceFingerprint(cwd, { paths: ['src/**'] }), baseline);
});

test('failure signatures ignore paths, line numbers, hex values, and whitespace', () => {
  const first = 'Error: parser failed at /Users/alice/app/parser.js:142 id deadbeef1234';
  const second = 'ERROR:   parser failed at /opt/build/parser.js:987 id cafe01234567';
  assert.equal(extractFailureSignature(first), extractFailureSignature(second));
  assert.equal(
    extractFailureSignature('Error: parser failed at /Users/alice/My Project/parser.js:142'),
    extractFailureSignature('ERROR: parser failed at /opt/build/Other Workspace/parser.js:987'),
  );
  assert.equal(extractFailureSignature('Everything passed.'), null);
  assert.equal(extractFailureSignature(null), null);
});

test('Codex supervisor state is schema-valid and bounds every retained history', () => {
  const supervisor = new GoalSupervisor({ stall: { quietTurns: 999, sameFailure: 999 } });
  for (let index = 0; index < 100; index += 1) {
    supervisor.recordTurn({
      fingerprint: `fingerprint-${index}`,
      failureSignature: `failure-${index}`,
      turnId: `turn-${index}`,
      at: index,
    });
  }
  const state = supervisor.state({ flightHash: 'flight-hash' });
  assert.equal(validSupervisorState(state), true);
  assert.equal(state.interventions.length, 0);
  assert.equal(state.seen_fingerprints.length, MAX_SUPERVISOR_HISTORY);
  assert.equal(state.observations.length, MAX_SUPERVISOR_HISTORY);
  assert.equal(state.observations.at(-1).turn_id, 'turn-99');
  assert.equal(state.observations.at(-1).verdict_level, 'ok');

  const malformed = structuredClone(state);
  malformed.observations[0].failure_signature = 42;
  assert.equal(validSupervisorState(malformed), false);
});

test('supervisor scratch uses temp-then-rename atomic replacement', async () => {
  const calls = [];
  await atomicWriteText('/tmp/.supervisor.json', '{}\n', {
    pid: 7,
    now: () => 42,
    async write(path, text, options) { calls.push(['write', path, text, options]); },
    async move(from, to) { calls.push(['rename', from, to]); },
  });
  assert.equal(calls[0][0], 'write');
  assert.match(calls[0][1], /^\/tmp\/\.\.supervisor\.json\.7\.42\.\d+\.tmp$/u);
  assert.deepEqual(calls[0][3], { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  assert.deepEqual(calls[1], ['rename', calls[0][1], '/tmp/.supervisor.json']);
});

test('failed supervisor replacement cleans its unique temp file', async () => {
  let temporary;
  let removed;
  await assert.rejects(atomicWriteText('/tmp/.supervisor.json', '{}\n', {
    pid: 8,
    now: () => 43,
    async write(path) { temporary = path; },
    async move() { throw new Error('simulated rename failure'); },
    async remove(path) { removed = path; },
  }), /simulated rename failure/u);
  assert.equal(removed, temporary);
});
