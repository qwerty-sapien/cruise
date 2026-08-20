import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildContextCapsule,
  MAX_CAPSULE_BYTES,
  MAX_WORKER_HANDOFF_BYTES,
  parseWorkerHandoff,
  readContinuationContext,
  writeRootHandoff,
} from '../scripts/lib/context-capsule.mjs';
import {
  ManagedWorkerDispatcher,
  WorkerDispatchLedger,
} from '../scripts/lib/worker-dispatcher.mjs';

function handoff(overrides = {}) {
  return {
    outcome: 'Complete the bounded parser change.',
    completed_work: ['Updated the owned parser branch.'],
    changed_files: ['src/parser.mjs'],
    decisions_and_invariants: ['Preserved the public result shape.'],
    exact_tests: ['node --test tests/parser.test.mjs'],
    active_blocker_or_next_work_item: 'Root should integrate the focused diff.',
    files_not_to_reread: ['src/constants.mjs'],
    evidence_pointers: ['.cruise/artifacts/parser-focused.log'],
    usage_and_quota_summary: 'Mock reservation released; no model usage in this test.',
    ...overrides,
  };
}

test('capsules and schema-constrained handoffs enforce byte caps', () => {
  const capsule = buildContextCapsule({
    task: 'Change one parser branch.',
    nonGoals: ['No public API redesign.'],
    evidence: ['Focused failure identifies branch B.'],
    ownership: ['src/parser.mjs'],
  });
  assert.ok(capsule.bytes <= MAX_CAPSULE_BYTES);
  assert.equal(parseWorkerHandoff(JSON.stringify(handoff())).changed_files[0], 'src/parser.mjs');
  assert.throws(
    () => buildContextCapsule({ task: 'x'.repeat(MAX_CAPSULE_BYTES) }),
    /exceeds/u,
  );
  assert.throws(
    () => parseWorkerHandoff(JSON.stringify(handoff({ outcome: 'x'.repeat(MAX_WORKER_HANDOFF_BYTES) }))),
    /exceeds/u,
  );
});

test('root handoff contains every lifecycle field and continuation injects only compact state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-handoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persisted = await writeRootHandoff(root, parseWorkerHandoff(JSON.stringify(handoff())));
  assert.ok(persisted.bytes <= MAX_WORKER_HANDOFF_BYTES);
  const content = await readFile(persisted.path, 'utf8');
  for (const label of [
    'Outcome',
    'Completed work',
    'Changed files',
    'Decisions and invariants',
    'Exact tests',
    'Active blocker or next work item',
    'Files that need not be reread',
    'Evidence pointers',
    'Usage and quota summary',
  ]) assert.match(content, new RegExp(label, 'u'));
  const continuation = await readContinuationContext(root, {
    run: () => ({ status: 0, stdout: ' M src/parser.mjs\n' }),
  });
  assert.match(continuation, /Complete the bounded parser change/u);
  assert.match(continuation, /M src\/parser\.mjs/u);
  assert.ok(Buffer.byteLength(continuation) < 8 * 1024);
});

test('managed dispatch writes capsule, reserves quota, runs a fresh level, persists handoff, and releases', async () => {
  const events = [];
  const dispatcher = new ManagedWorkerDispatcher({
    cwd: '/tmp/project',
    capsuleWriter: async () => {
      events.push('capsule');
      return '/tmp/project/.cruise/artifacts/capsule.json';
    },
    reserveWorker: async () => {
      events.push('reserve');
      return { release: async () => events.push('release') };
    },
    runWorker: async (request) => {
      events.push(`worker:L${request.level}`);
      assert.equal(request.readOnly, false);
      assert.match(request.task, /cruise_bounded_context_capsule/u);
      return { threadId: 'ephemeral-thread', turnId: 'turn-1', output: JSON.stringify(handoff()) };
    },
    handoffWriter: async () => {
      events.push('handoff');
      return { path: '/tmp/project/.cruise/HANDOFF.md' };
    },
  });
  const result = await dispatcher.dispatch({
    task: 'Repair authorization for one route.',
    complexity: 'bounded',
  });
  assert.equal(result.route.recommended_level, 5);
  assert.equal(result.thread_id, 'ephemeral-thread');
  assert.deepEqual(events, ['capsule', 'reserve', 'worker:L5', 'handoff', 'release']);
});

test('managed dispatch never exceeds three active workers and debug probes deduplicate', async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const dispatcher = new ManagedWorkerDispatcher({
    cwd: '/tmp/project',
    capsuleWriter: async () => '/tmp/capsule.json',
    handoffWriter: async () => ({ path: '/tmp/HANDOFF.md' }),
    reserveWorker: async () => ({ release: async () => {} }),
    runWorker: async () => {
      calls += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { output: JSON.stringify(handoff()) };
    },
  });
  await Promise.all(Array.from({ length: 7 }, (_, index) => dispatcher.dispatch({
    task: `bounded item ${index}`,
  })));
  assert.equal(maximum, 3);

  const before = calls;
  await dispatcher.dispatchDebugProbes([
    { id: 'H1', task: 'probe parser state' },
    { id: 'H1', task: 'duplicate parser state' },
    { id: 'H2', task: 'probe caller state' },
  ]);
  assert.equal(calls - before, 2);
  assert.deepEqual(await dispatcher.dispatchDebugProbes([{ id: 'H1', task: 'same probe' }]), []);
  await assert.rejects(
    dispatcher.dispatchDebugProbes([{ id: 'H3', task: 'new wave' }]),
    /confirmed discriminating evidence/u,
  );
  await dispatcher.dispatchDebugProbes(
    [{ id: 'H3', task: 'new wave' }],
    { expansionEvidence: 'H1 was falsified by the focused trace.' },
  );
});

test('managed dispatch propagates the required L7 exceptional-consequence record', async () => {
  const exceptionalConsequence = {
    consequence: 'Irreversible production control-plane mutation',
    rationale: 'The isolated repair has no lower-consequence execution path.',
  };
  let observed = null;
  const dispatcher = new ManagedWorkerDispatcher({
    cwd: '/tmp/project',
    capsuleWriter: async () => '/tmp/capsule.json',
    handoffWriter: async () => ({ path: '/tmp/HANDOFF.md' }),
    reserveWorker: async () => ({ release: async () => {} }),
    runWorker: async (request) => {
      observed = request;
      return { output: JSON.stringify(handoff()) };
    },
  });
  await dispatcher.dispatch({
    task: 'Perform the exceptional production control-plane mutation.',
    complexity: 'exceptional',
    exceptionalConsequence,
  });
  assert.equal(observed.level, 7);
  assert.deepEqual(observed.exceptionalConsequence, exceptionalConsequence);
});

test('shared dispatch ledger enforces three workers and evidence-gated debug waves across instances', async (t) => {
  const baseDirectory = await mkdtemp(join(tmpdir(), 'cruise-dispatch-ledger-'));
  t.after(() => rm(baseDirectory, { recursive: true, force: true }));
  const make = () => new WorkerDispatchLedger({
    cwd: '/tmp/shared-project',
    baseDirectory,
    alive: () => true,
  });
  const leases = await Promise.all([make().reserve(), make().reserve(), make().reserve()]);
  await assert.rejects(make().reserve(), /maximum 3 active/u);
  await leases[0].release();
  const replacement = await make().reserve();
  await Promise.all([...leases.slice(1), replacement].map((lease) => lease.release()));

  for (const key of ['H1', 'H2', 'H3']) {
    const lease = await make().reserve({ debugProbeKey: key });
    await lease.release();
  }
  await assert.rejects(make().reserve({ debugProbeKey: 'H4' }), /confirmed discriminating evidence/u);
  const nextWave = await make().reserve({
    debugProbeKey: 'H4',
    expansionEvidence: 'The first wave falsified H1 and isolated a new boundary.',
  });
  await nextWave.release();
  for (const key of ['H5', 'H6']) {
    const lease = await make().reserve({
      debugProbeKey: key,
      expansionEvidence: 'The first wave falsified H1 and isolated a new boundary.',
    });
    await lease.release();
  }
  await assert.rejects(
    make().reserve({
      debugProbeKey: 'H7',
      expansionEvidence: 'The first wave falsified H1 and isolated a new boundary.',
    }),
    /at most 3 probes/u,
  );
  await assert.rejects(
    make().reserve({
      debugProbeKey: 'H1',
      expansionEvidence: 'A different confirmed trace exists.',
    }),
    /duplicate/u,
  );
});

test('managed dispatch surfaces reservation release failure', async () => {
  const dispatcher = new ManagedWorkerDispatcher({
    cwd: '/tmp/project',
    capsuleWriter: async () => '/tmp/capsule.json',
    handoffWriter: async () => ({ path: '/tmp/HANDOFF.md' }),
    reserveWorker: async () => ({ release: async () => { throw new Error('quota release failed'); } }),
    runWorker: async () => ({ output: JSON.stringify(handoff()) }),
  });
  await assert.rejects(
    dispatcher.dispatch({ task: 'one bounded task' }),
    /quota release failed/u,
  );
  assert.equal(dispatcher.active, 0);
});
