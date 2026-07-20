import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  captureWorkspaceFingerprint,
  extractFailureSignature,
  GoalSupervisor,
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
