import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runSimpleWorker } from '../scripts/lib/simple-worker.mjs';

import {
  buildContextCapsule,
  MAX_CAPSULE_BYTES,
  MAX_WORKER_HANDOFF_BYTES,
  MAX_WORKER_RESULT_BYTES,
  parseWorkerHandoff,
  readContinuationContext,
  WORKER_HANDOFF_OUTPUT_SCHEMA,
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
  assert.match(capsule.serialized, /Never read, search, summarize, fingerprint/u);
  assert.equal(parseWorkerHandoff(JSON.stringify(handoff())).changed_files[0], 'src/parser.mjs');
  assert.throws(
    () => buildContextCapsule({ task: 'x'.repeat(MAX_CAPSULE_BYTES) }),
    /exceeds/u,
  );
  assert.throws(
    () => parseWorkerHandoff(JSON.stringify(handoff({ outcome: 'x'.repeat(MAX_WORKER_RESULT_BYTES) }))),
    /exceeds/u,
  );
});

test('bounded detailed worker findings retain a compact root continuation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-detailed-handoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const raw = JSON.stringify(handoff({ completed_work: ['Detailed finding. '.repeat(280)] }));
  assert.ok(Buffer.byteLength(raw) > MAX_WORKER_HANDOFF_BYTES);
  assert.ok(Buffer.byteLength(raw) <= MAX_WORKER_RESULT_BYTES);
  const parsed = parseWorkerHandoff(raw);
  assert.equal(parsed.completed_work[0], 'Detailed finding. '.repeat(280).trim());
  const persisted = await writeRootHandoff(root, parsed);
  assert.ok(persisted.bytes <= MAX_WORKER_HANDOFF_BYTES);
});

test('a completed worker may report no blocker and its outcome survives continuation formatting', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-result-handoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parsed = parseWorkerHandoff(JSON.stringify(handoff({
    outcome: 'Exact computed result: fixture-result-731.', active_blocker_or_next_work_item: '',
  })));
  const result = await writeRootHandoff(root, parsed);
  const content = await readFile(result.path, 'utf8');
  assert.match(content, /fixture-result-731/u);
  assert.match(content, /No blocker reported/u);
  assert.throws(() => parseWorkerHandoff(JSON.stringify(handoff({ active_blocker_or_next_work_item: null }))), /must be a string/u);
});

test('worker capsules fail closed before sensitive paths or credential material can be dispatched', () => {
  assert.throws(
    () => buildContextCapsule({
      task: 'Inspect the bounded parser behavior without reading .env.',
      relevantRanges: ['.env:1-4'],
    }),
    (error) => error?.code === 'CRUISE_SENSITIVE_PATH',
  );
  assert.throws(
    () => buildContextCapsule({
      task: 'Inspect one config branch.',
      ownership: ['config/credentials.json'],
    }),
    (error) => error?.code === 'CRUISE_SENSITIVE_PATH',
  );
  assert.throws(
    () => buildContextCapsule({
      task: 'Use API_KEY=MINIREPO_REAL_LOOKING_VALUE in the worker.',
    }),
    (error) => error?.code === 'CRUISE_SECRET_MATERIAL',
  );
  const safe = buildContextCapsule({
    task: 'Verify that .env is excluded; do not read it.',
    relevantRanges: ['src/parser.mjs:1-40'],
  });
  assert.match(safe.serialized, /\.env is excluded/u);
});

test('root handoff retains only the compact continuation contract', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-handoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persisted = await writeRootHandoff(root, parseWorkerHandoff(JSON.stringify(handoff())));
  assert.ok(persisted.bytes <= MAX_WORKER_HANDOFF_BYTES);
  const content = await readFile(persisted.path, 'utf8');
  for (const label of [
    'Compact handoff',
    'Next work item',
    'Quota state',
    'Unresolved assurance',
  ]) assert.match(content, new RegExp(label, 'u'));
  assert.doesNotMatch(content, /Outcome|Files that need not be reread/u);
  const continuation = await readContinuationContext(root);
  assert.match(continuation, /Root should integrate the focused diff/u);
  assert.doesNotMatch(continuation, /git status|M src\/parser\.mjs/u);
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

test('handoff parser rejects malformed, multiple-object, fenced, and trailing-text output', () => {
  const valid = JSON.stringify(handoff());
  for (const invalid of ['{"outcome":', valid + '\n' + valid, '```json\n' + valid + '\n```', valid + '\ntrailing text']) {
    assert.throws(() => parseWorkerHandoff(invalid), /one JSON object/u);
  }
  assert.deepEqual(parseWorkerHandoff(valid), handoff());
});

test('native handoff output schema matches the strict parser contract', () => {
  const arrayFields = [
    'completed_work', 'changed_files', 'decisions_and_invariants', 'exact_tests',
    'files_not_to_reread', 'evidence_pointers',
  ];
  assert.equal(WORKER_HANDOFF_OUTPUT_SCHEMA.type, 'object');
  assert.equal(WORKER_HANDOFF_OUTPUT_SCHEMA.additionalProperties, false);
  assert.deepEqual(WORKER_HANDOFF_OUTPUT_SCHEMA.required, Object.keys(handoff()));
  assert.deepEqual(WORKER_HANDOFF_OUTPUT_SCHEMA.properties.outcome, {
    type: 'string', minLength: 1, pattern: '\\S',
  });
  assert.deepEqual(WORKER_HANDOFF_OUTPUT_SCHEMA.properties.usage_and_quota_summary, {
    type: 'string', minLength: 1, pattern: '\\S',
  });
  assert.deepEqual(WORKER_HANDOFF_OUTPUT_SCHEMA.properties.active_blocker_or_next_work_item, { type: 'string' });
  for (const field of arrayFields) {
    assert.deepEqual(WORKER_HANDOFF_OUTPUT_SCHEMA.properties[field], {
      type: 'array', items: { type: 'string' },
    });
  }
  assert.equal(parseWorkerHandoff(JSON.stringify(handoff({ active_blocker_or_next_work_item: '' }))).active_blocker_or_next_work_item, '');
  assert.throws(() => parseWorkerHandoff(JSON.stringify(handoff({ outcome: '  ' }))), /outcome is required/u);
  assert.throws(() => parseWorkerHandoff(JSON.stringify(handoff({ usage_and_quota_summary: '  ' }))), /usage_and_quota_summary is required/u);
  assert.throws(() => parseWorkerHandoff(JSON.stringify(handoff({ unexpected: 'field' }))), /unknown fields/u);
  assert.throws(() => parseWorkerHandoff(JSON.stringify(handoff({ completed_work: [1] }))), /array of strings/u);
});

test('managed dispatch consumes canonical final items and retains strict payload parsing', async () => {
  const valid = JSON.stringify(handoff());
  const completed = (id, phase, text) => ({ method: 'item/completed', params: { item: { type: 'agentMessage', id, phase, text } } });
  const delta = (itemId, text) => ({ method: 'item/agentMessage/delta', params: { itemId, delta: text } });
  for (const [events, expectedError] of [
    [[completed('f', 'final_answer', valid)], null],
    [[delta('c', 'Checking.'), completed('c', 'commentary', 'Checking.'), delta('f', valid), completed('f', 'final_answer', valid)], null],
    [[delta('f', valid), completed('f', null, valid)], null],
    [[delta('f', valid)], null],
    [[completed('f', 'final_answer', valid + '\ntrailing text')], /one JSON object/u],
    [[completed('f', 'final_answer', valid + '\n' + valid)], /one JSON object/u],
    [[completed('f', 'final_answer', '```json\n' + valid + '\n```')], /one JSON object/u],
    [[completed('f', 'final_answer', '{"outcome":')], /one JSON object/u],
    [[completed('f', 'final_answer', valid), completed('g', null, valid)], /ambiguous worker final output/u],
  ]) {
    let persisted = false;
    let released = false;
    class TranscriptClient extends EventEmitter {
      async start() {} async stop() {}
      async request(method) {
        if (method === 'thread/start') return { thread: { id: 'worker-thread' } };
        if (method === 'turn/start') {
          queueMicrotask(() => {
            for (const event of events) this.emit('notification', event);
            this.emit('notification', { method: 'turn/completed', params: { turn: { status: 'completed' } } });
          });
          return { turn: { id: 'worker-turn' } };
        }
        throw new Error('unexpected method: ' + method);
      }
    }
    const dispatcher = new ManagedWorkerDispatcher({ cwd: process.cwd(),
      capsuleWriter: async () => '/tmp/mock-capsule.json',
      reserveWorker: async () => ({ release: async () => { released = true; } }),
      runWorker: (request) => runSimpleWorker({ ...request, level: null, clientFactory: () => new TranscriptClient() }),
      handoffWriter: async () => { persisted = true; return { path: '/tmp/mock-handoff.md' }; },
    });
    const dispatch = dispatcher.dispatch({ task: 'Review one bounded fixture.', readOnly: true });
    if (expectedError) await assert.rejects(dispatch, expectedError);
    else await dispatch;
    assert.equal(persisted, expectedError === null);
    assert.equal(released, true);
  }
});
