import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseArgs, runQueue, runQueueGoal, runQueueStatus } from '../scripts/cruise.mjs';
import { readFlightPlan, writeFlightPlan } from '../scripts/lib/flight-plan.mjs';
import {
  captureFlightAssuranceContext,
} from '../scripts/lib/assurance.mjs';
import { captureWorkspaceFingerprint } from '../scripts/lib/supervisor.mjs';

import {
  QUEUE_FILE,
  milestoneToFlightPlan,
  nextReadyMilestone,
  parseQueue,
  readQueue,
  writeQueue,
} from '../scripts/lib/queue.mjs';

const PINNED_QUEUE = `---
version: 1
milestones:
  - id: M1
    status: complete
    outcome: Establish the parser seam
    verify: [npm test]
    depends: []
    touchpoints: [src/parser/]
    non_goals: ["No API redesign"]
    invariants: ["CLI flags unchanged"]
    reviewer: optional
  - id: M2
    status: pending
    outcome: Migrate callers
    verify:
      - npm test
      - npm run integration
    depends: [M1]
    touchpoints:
      - src/callers/
    non_goals: []
    invariants:
      - CLI flags unchanged
owner: user-editable
---
# Queue

Keep old and new parser results compatible between milestones.
`;

test('queue parse/write round-trips the pinned schema and unknown keys', async () => {
  const parsed = parseQueue(PINNED_QUEUE);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.milestones.length, 2);
  assert.deepEqual(parsed.milestones[0], {
    id: 'M1',
    status: 'complete',
    outcome: 'Establish the parser seam',
    verify: ['npm test'],
    depends: [],
    touchpoints: ['src/parser/'],
    nonGoals: ['No API redesign'],
    invariants: ['CLI flags unchanged'],
  });
  assert.equal(parsed.raw.owner, 'user-editable');
  assert.equal(parsed.raw.milestones[0].reviewer, 'optional');
  assert.match(parsed.body, /results compatible/u);

  const cwd = await mkdtemp(join(tmpdir(), 'cruise-queue-'));
  try {
    parsed.milestones[1].status = 'complete';
    await writeQueue(cwd, parsed);
    const roundTrip = await readQueue(cwd);
    assert.equal(roundTrip.milestones[1].status, 'complete');
    assert.equal(roundTrip.raw.owner, 'user-editable');
    assert.equal(roundTrip.raw.milestones[0].reviewer, 'optional');
    assert.match(await readFile(join(cwd, QUEUE_FILE), 'utf8'), /^---\nversion: 1\nmilestones:/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('nextReadyMilestone selects the first dependency-satisfied pending item', () => {
  const queue = parseQueue(PINNED_QUEUE);
  assert.equal(nextReadyMilestone(queue).id, 'M2');
  queue.milestones[0].status = 'pending';
  assert.equal(nextReadyMilestone(queue).id, 'M1');
  queue.milestones[0].status = 'blocked';
  assert.equal(nextReadyMilestone(queue), null);
});

test('dependency cycles produce no ready milestone and a concrete warning', () => {
  const warnings = [];
  const queue = {
    milestones: [
      { id: 'M1', status: 'pending', depends: ['M2'] },
      { id: 'M2', status: 'pending', depends: ['M1'] },
    ],
  };
  assert.equal(nextReadyMilestone(queue, { warn: (message) => warnings.push(message) }), null);
  assert.deepEqual(warnings, ['Queue dependency cycle detected: M1 -> M2 -> M1']);
});

test('milestoneToFlightPlan carries scope and verification plus inherited obligations', () => {
  const milestone = parseQueue(PINNED_QUEUE).milestones[1];
  const plan = milestoneToFlightPlan(
    milestone,
    '# Queue\n\nKeep parser results backward compatible.',
  );
  assert.equal(plan.version, 2);
  assert.equal(plan.status, 'active');
  assert.equal(plan.outcome, 'Migrate callers');
  assert.deepEqual(plan.verify, ['npm test', 'npm run integration']);
  assert.deepEqual(plan.scope, { touchpoints: ['src/callers/'], nonGoals: [] });
  assert.deepEqual(plan.invariants, ['CLI flags unchanged']);
  assert.deepEqual(plan.quality.profiles, ['core']);
  assert.deepEqual(
    plan.quality.gates.map(({ dimension }) => dimension),
    ['intent', 'functional-correctness', 'regression', 'failure-paths', 'completion-review'],
  );
  assert.match(plan.body, /Inherited cross-milestone detail remains in `.cruise\/QUEUE\.md`/u);
  assert.doesNotMatch(plan.body, /Keep parser results backward compatible/u);
});

test('Queue v2 carries risk and profiles into domain-aware Flight gates', () => {
  const queue = parseQueue(`---
version: 2
milestones:
  -
    id: HPC-1
    status: pending
    outcome: Optimize the solver without changing numerical results
    verify:
      - ctest
    depends: []
    touchpoints:
      - src/solver/**
    non_goals: []
    invariants:
      - Numerical tolerances remain stable
    risk: high
    profiles:
      - core
      - cxx-hpc
---
`);
  assert.ok(queue);
  assert.equal(queue.milestones[0].risk, 'high');
  assert.deepEqual(queue.milestones[0].profiles, ['core', 'cxx-hpc']);
  const plan = milestoneToFlightPlan(queue.milestones[0]);
  assert.equal(plan.quality.risk, 'high');
  assert.equal(plan.quality.gates.some(({ dimension }) => dimension === 'complexity'), true);
  assert.equal(plan.quality.gates.some(({ dimension }) => dimension === 'independent-review'), true);
});

test('queue parsing never throws and rejects malformed advisory data', () => {
  const malformed = [
    null,
    '',
    '---\nmilestones: nope\n---\n',
    '---\nmilestones:\n  - id: M1\n    id: duplicate\n---\n',
    '---\nmilestones:\n  - id: M1\n    status: invented\n---\n',
    '---\nmilestones:\n  - id: M1\n    verify: npm test\n---\n',
    `---\n${'nested:\n  nested:\n'.repeat(20)}value: nope\n---\n`,
  ];
  for (const value of malformed) {
    assert.doesNotThrow(() => parseQueue(value));
    assert.equal(parseQueue(value), null);
  }
});

function projectQueue() {
  return {
    version: 1,
    milestones: [
      {
        id: 'M1',
        status: 'pending',
        outcome: 'Build the seam',
        verify: ['npm test'],
        depends: [],
        touchpoints: ['src/seam/'],
        nonGoals: ['No caller migration'],
        invariants: ['Public API unchanged'],
      },
      {
        id: 'M2',
        status: 'pending',
        outcome: 'Migrate callers',
        verify: ['npm test'],
        depends: ['M1'],
        touchpoints: ['src/callers/'],
        nonGoals: [],
        invariants: ['Public API unchanged'],
      },
    ],
    body: '# Queue\n\nKeep old and new implementations compatible.',
  };
}

async function prepareAssuredQueueWorkspace(cwd) {
  const initialized = spawnSync('git', ['init', '--quiet'], { cwd, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  await mkdir(join(cwd, '.cruise'), { recursive: true });
  await writeFile(join(cwd, '.cruise', 'ORIGIN.md'), 'Execute this queue safely.', 'utf8');
}

async function completeCurrentFlight(cwd) {
  const plan = await readFlightPlan(cwd);
  const workspaceFingerprint = await captureWorkspaceFingerprint(cwd, {
    excludeFlightPlan: true,
  });
  const assuranceContext = await captureFlightAssuranceContext(cwd, plan, {
    workspaceFingerprint,
    surfaceFingerprintReader: (paths) => captureWorkspaceFingerprint(cwd, {
      excludeFlightPlan: true,
      paths,
    }),
  });
  for (const gate of plan.quality.gates) {
    gate.state = 'passed';
    gate.evidence = {
      summary: `${gate.id} passed`,
      contextFingerprint: assuranceContext.gateFingerprints[gate.id],
      observedAt: Date.now(),
      source: ['completion-review', 'independent-review'].includes(gate.dimension)
        ? 'review'
        : 'command',
      rationale: '',
      waivedBy: '',
    };
  }
  plan.status = 'complete';
  await writeFlightPlan(cwd, plan);
}

test('queue CLI parsing and status output require an explicit queue action', async () => {
  assert.equal(parseArgs(['--claude', 'queue', 'run', '-C', '/tmp'], { env: {} }).queueAction, 'run');
  assert.equal(parseArgs(['queue', 'status'], { env: {} }).queueAction, 'status');
  assert.throws(() => parseArgs(['queue'], { env: {} }), /requires status or run/u);
  assert.throws(() => parseArgs(['queue', 'skip'], { env: {} }), /Unexpected queue argument/u);
  assert.throws(() => parseArgs(['queue', 'run', '--', 'extra'], { env: {} }), /Unexpected queue argument/u);

  const cwd = await mkdtemp(join(tmpdir(), 'cruise-queue-status-'));
  try {
    await writeQueue(cwd, projectQueue());
    let output = '';
    assert.equal(await runQueueStatus({ cwd }, { output: { write: (text) => { output += text; } } }), 0);
    assert.match(output, /M1\tpending\tdepends: -/u);
    assert.match(output, /M2\tpending\tdepends: M1/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('queue run preserves advisory edits and stops honestly on a stalled milestone', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-queue-run-stall-'));
  try {
    await prepareAssuredQueueWorkspace(cwd);
    await writeQueue(cwd, projectQueue());
    const calls = [];
    let output = '';
    const exitCode = await runQueue({ cwd, provider: 'codex' }, {
      output: { write: (text) => { output += text; } },
      async milestoneRunner(input) {
        calls.push({ id: input.milestone.id, outcome: input.milestone.outcome, prompt: input.prompt });
        const flight = await readFlightPlan(cwd);
        assert.equal(flight.status, 'active');
        assert.equal(flight.outcome, input.milestone.outcome);
        if (input.milestone.id === 'M1') {
          const edited = await readQueue(cwd);
          edited.raw.milestones[1].reviewer = 'owner-review';
          await writeQueue(cwd, edited);
          await completeCurrentFlight(cwd);
          return { status: 'complete' };
        }
        assert.equal((await readQueue(cwd)).raw.milestones[1].reviewer, 'owner-review');
        assert.match(flight.body, /Inherited cross-milestone detail remains in `.cruise\/QUEUE\.md`/u);
        return { status: 'stalled', reason: 'no new workspace evidence' };
      },
    });

    assert.equal(exitCode, 3);
    assert.deepEqual(calls.map(({ id }) => id), ['M1', 'M2']);
    assert.match(calls[1].prompt, /Migrate callers/u);
    const queue = await readQueue(cwd);
    assert.deepEqual(queue.milestones.map(({ status }) => status), ['complete', 'stalled']);
    assert.match(output, /Completed queue milestone M1/u);
    assert.match(output, /Queue stopped at M2 \(stalled\)/u);
    assert.deepEqual(
      (await readdir(join(cwd, '.cruise'))).sort(),
      ['FLIGHT.md', 'ORIGIN.md', 'QUEUE.md'],
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('queue run records a blocked milestone and never advances past it', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-queue-run-blocked-'));
  try {
    await writeQueue(cwd, projectQueue());
    const calls = [];
    const exitCode = await runQueue({ cwd, provider: 'claude' }, {
      output: { write() {} },
      async milestoneRunner({ milestone }) {
        calls.push(milestone.id);
        return { status: 'blocked', reason: 'material user decision required' };
      },
    });
    assert.equal(exitCode, 2);
    assert.deepEqual(calls, ['M1']);
    assert.deepEqual((await readQueue(cwd)).milestones.map(({ status }) => status), ['blocked', 'pending']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('queue run records flight compilation failures instead of leaving active state', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-queue-run-compile-failure-'));
  try {
    await writeQueue(cwd, projectQueue());
    let ran = false;
    const exitCode = await runQueue({ cwd, provider: 'codex' }, {
      output: { write() {} },
      async flightWriter() { throw new Error('FLIGHT.md is not writable'); },
      async milestoneRunner() { ran = true; return { status: 'complete' }; },
    });
    assert.equal(exitCode, 2);
    assert.equal(ran, false);
    assert.equal((await readQueue(cwd)).milestones[0].status, 'blocked');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('the real queue Goal adapter requires Flight v2 as well as the Claude terminal handshake', async () => {
  const base = {
    cwd: '/workspace',
    provider: 'claude',
    milestone: { id: 'M1' },
    prompt: 'Run M1.',
  };
  const goalRunner = async () => ({ status: 'complete', exitCode: 0 });
  assert.equal((await runQueueGoal(base, {
    goalRunner,
    flightReader: async () => ({ status: 'active' }),
  })).status, 'stalled');
  assert.equal((await runQueueGoal(base, {
    goalRunner,
    flightReader: async () => ({ status: 'blocked' }),
  })).status, 'blocked');
  const legacy = await runQueueGoal(base, {
    goalRunner,
    flightReader: async () => ({ version: 1, status: 'complete' }),
  });
  assert.equal(legacy.status, 'failed');
  assert.match(legacy.reason, /Flight v2/u);
});

test('queue execution rejects terminal transitions for milestones it did not run', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-queue-future-status-'));
  try {
    await writeQueue(cwd, projectQueue());
    let output = '';
    const exitCode = await runQueue({ cwd, provider: 'codex' }, {
      output: { write(value) { output += value; } },
      async milestoneRunner() {
        const edited = await readQueue(cwd);
        edited.milestones[1].status = 'complete';
        await writeQueue(cwd, edited);
        return { status: 'complete' };
      },
    });
    assert.equal(exitCode, 2);
    const queue = await readQueue(cwd);
    assert.deepEqual(queue.milestones.map(({ status }) => status), ['blocked', 'pending']);
    assert.match(output, /unexecuted milestone status changed: M2/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('queue execution rejects terminal Flight substitution', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-queue-flight-substitution-'));
  try {
    await prepareAssuredQueueWorkspace(cwd);
    await writeQueue(cwd, projectQueue());
    let output = '';
    const exitCode = await runQueue({ cwd, provider: 'codex' }, {
      output: { write(value) { output += value; } },
      async milestoneRunner() {
        const substituted = milestoneToFlightPlan({
          id: 'M1',
          status: 'active',
          outcome: 'Touch a harmless README line',
          verify: ['true'],
          depends: [],
          touchpoints: ['README.md'],
          nonGoals: [],
          invariants: [],
          risk: 'medium',
          profiles: ['core'],
        }, '# Easier substituted obligation');
        await writeFlightPlan(cwd, substituted);
        await completeCurrentFlight(cwd);
        return { status: 'complete' };
      },
    });
    assert.equal(exitCode, 2);
    assert.equal((await readQueue(cwd)).milestones[0].status, 'blocked');
    assert.match(output, /terminal Flight no longer represents/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('queue execution restores deletion of an unexecuted milestone', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-queue-milestone-deletion-'));
  try {
    await writeQueue(cwd, projectQueue());
    let output = '';
    const exitCode = await runQueue({ cwd, provider: 'codex' }, {
      output: { write(value) { output += value; } },
      async milestoneRunner() {
        const edited = await readQueue(cwd);
        edited.milestones = edited.milestones.slice(0, 1);
        await writeQueue(cwd, edited);
        return { status: 'complete' };
      },
    });
    assert.equal(exitCode, 2);
    const stopped = await readQueue(cwd);
    assert.deepEqual(stopped.milestones.map(({ status }) => status), ['blocked', 'pending']);
    assert.equal(stopped.milestones[0].stop_scope, 'global');
    assert.match(output, /deleted or renamed and restored/u);
    assert.match(output, /milestone set changed/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('terminal or interrupted queues never masquerade as successful completion', async () => {
  for (const [status, expected] of [['active', 2], ['blocked', 2], ['stalled', 3]]) {
    const cwd = await mkdtemp(join(tmpdir(), `cruise-queue-terminal-${status}-`));
    try {
      const queue = projectQueue();
      queue.milestones = [{ ...queue.milestones[0], status }];
      await writeQueue(cwd, queue);
      assert.equal(await runQueue({ cwd, provider: 'codex' }, { output: { write() {} } }), expected);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

for (const blockerStatus of ['blocked', 'stalled']) {
  test(`queue continues independent work after ${blockerStatus} and retains dependent work`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cruise-queue-independent-'));
    try {
      await prepareAssuredQueueWorkspace(cwd);
      const queue = projectQueue();
      queue.milestones.push({ ...queue.milestones[0], id: 'M3', outcome: 'Publish independent notice', depends: [] });
      await writeQueue(cwd, queue);
      const calls = [];
      const exitCode = await runQueue({ cwd, provider: 'codex' }, {
        output: { write() {} },
        async milestoneRunner({ milestone }) {
          calls.push(milestone.id);
          if (milestone.id === 'M1') return { status: blockerStatus, reason: 'feature unavailable' };
          await completeCurrentFlight(cwd);
          return { status: 'complete' };
        },
      });
      assert.deepEqual(calls, ['M1', 'M3']);
      assert.equal(exitCode, blockerStatus === 'stalled' ? 3 : 2);
      assert.deepEqual((await readQueue(cwd)).milestones.map(({ status }) => status), [blockerStatus, 'pending', 'complete']);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test('queue resumes independent work with an existing blocker without declaring total completion', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-queue-resume-independent-'));
  try {
    await prepareAssuredQueueWorkspace(cwd);
    const queue = projectQueue();
    await writeQueue(cwd, queue);
    assert.equal(await runQueue({ cwd, provider: 'codex' }, {
      output: { write() {} },
      async milestoneRunner() { return { status: 'blocked', reason: 'local feature unavailable' }; },
    }), 2);
    const stopped = await readQueue(cwd);
    assert.equal(stopped.milestones[0].stop_scope, 'local');
    // A new independent unit can resume while the dependent unit stays pending.
    queue.milestones = stopped.milestones;
    queue.milestones.push({ ...queue.milestones[1], id: 'M3', depends: [] });
    await writeQueue(cwd, queue);
    const calls = [];
    assert.equal(await runQueue({ cwd, provider: 'codex' }, {
      output: { write() {} },
      async milestoneRunner({ milestone }) {
        calls.push(milestone.id);
        await completeCurrentFlight(cwd);
        return { status: 'complete' };
      },
    }), 2);
    assert.deepEqual(calls, ['M3']);
    assert.deepEqual((await readQueue(cwd)).milestones.map(({ status }) => status), ['blocked', 'pending', 'complete']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const failure of ['budget-paused', 'failed', 'interrupted', 'contract-mutation', 'unassured']) {
  test(`queue stops independent work on ${failure}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cruise-queue-global-stop-'));
    try {
      const queue = projectQueue();
      queue.milestones[1].depends = [];
      await writeQueue(cwd, queue);
      const calls = [];
      assert.equal(await runQueue({ cwd, provider: 'codex' }, {
        output: { write() {} },
        async milestoneRunner({ milestone }) {
          calls.push(milestone.id);
          if (failure === 'contract-mutation') {
            const edited = await readQueue(cwd);
            edited.body += '\nChanged obligations';
            await writeQueue(cwd, edited);
            return { status: 'blocked' };
          }
          return { status: failure === 'unassured' ? 'complete' : failure };
        },
      }), 2);
      assert.deepEqual(calls, ['M1']);
      assert.deepEqual((await readQueue(cwd)).milestones.map(({ status }) => status), ['blocked', 'pending']);
      assert.equal(await runQueue({ cwd, provider: 'codex' }, {
        output: { write() {} },
        async milestoneRunner({ milestone }) { calls.push(milestone.id); return { status: 'blocked' }; },
      }), 2);
      assert.deepEqual(calls, ['M1'], 'resume must retain the global stop');
      assert.equal((await readQueue(cwd)).milestones[0].stop_scope, 'global');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

for (const status of ['blocked', 'stalled']) {
  test(`historical ${status} without local provenance stops independent work`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cruise-queue-unknown-stop-'));
    try {
      const queue = projectQueue();
      queue.milestones[0].status = status;
      queue.milestones[1].depends = [];
      await writeQueue(cwd, queue);
      const calls = [];
      assert.equal(await runQueue({ cwd, provider: 'codex' }, {
        output: { write() {} },
        async milestoneRunner({ milestone }) { calls.push(milestone.id); return { status: 'blocked' }; },
      }), status === 'stalled' ? 3 : 2);
      assert.deepEqual(calls, []);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}

test('global stop survives status-only edits until explicit reconciliation', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-queue-reconcile-stop-'));
  try {
    await prepareAssuredQueueWorkspace(cwd);
    const queue = projectQueue();
    await writeQueue(cwd, queue);
    assert.equal(await runQueue({ cwd, provider: 'codex' }, {
      output: { write() {} },
      async milestoneRunner() { return { status: 'budget-paused' }; },
    }), 2);
    const stopped = await readQueue(cwd);
    stopped.milestones[0].status = 'pending';
    await writeQueue(cwd, stopped);
    const calls = [];
    const runner = {
      output: { write() {} },
      async milestoneRunner({ milestone }) {
        calls.push(milestone.id);
        await completeCurrentFlight(cwd);
        return { status: 'complete' };
      },
    };
    assert.equal(await runQueue({ cwd, provider: 'codex' }, runner), 2);
    assert.deepEqual(calls, []);
    // Normal advisory reconciliation explicitly clears the stop after resolution.
    stopped.milestones[0].stop_scope = null;
    await writeQueue(cwd, stopped);
    assert.equal(await runQueue({ cwd, provider: 'codex' }, runner), 0);
    assert.deepEqual(calls, ['M1', 'M2']);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

for (const field of ['depends', 'verify', 'invariants']) {
  test(`non-active ${field} weakening restores contracts and persists a global stop`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'cruise-queue-contract-stop-'));
    try {
      const queue = projectQueue();
      queue.milestones[1].verify = ['npm test', 'npm run integration'];
      queue.milestones[1].invariants = ['Preserve authorization'];
      // An otherwise independent unit must also wait for integrity reconciliation.
      queue.milestones.push({ ...queue.milestones[1], id: 'M3', depends: [] });
      await writeQueue(cwd, queue);
      const original = await readQueue(cwd);
      const calls = [];
      let output = '';
      const runner = {
        output: { write(text) { output += text; } },
        async milestoneRunner({ milestone }) {
          calls.push(milestone.id);
          const edited = await readQueue(cwd);
          edited.milestones[1][field] = field === 'verify' ? ['npm test'] : [];
          await writeQueue(cwd, edited);
          return { status: 'blocked', reason: 'local feature unavailable' };
        },
      };
      assert.equal(await runQueue({ cwd, provider: 'codex' }, runner), 2);
      assert.deepEqual(calls, ['M1']);
      const stopped = await readQueue(cwd);
      assert.equal(stopped.milestones[0].stop_scope, 'global');
      assert.deepEqual(stopped.milestones.slice(1),
        original.milestones.slice(1).map((entry) => ({ ...entry, stop_scope: null })));
      assert.match(output, /unexecuted milestone contract changed: M2/u);
      assert.equal(await runQueue({ cwd, provider: 'codex' }, runner), 2);
      assert.deepEqual(calls, ['M1'], 'resume must not run dependent or independent work');
      assert.equal((await readQueue(cwd)).milestones[0].stop_scope, 'global');
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}

for (const targetId of ['M1', 'M2']) {
  for (const mutation of ['deletion', 'rename']) {
    test(`${mutation} of ${targetId} restores its checkpoint and persists a global stop`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'cruise-queue-checkpoint-recovery-'));
      try {
        await prepareAssuredQueueWorkspace(cwd);
        const queue = projectQueue();
        queue.milestones.find(({ id }) => id === targetId).checkpoint_note = 'preserve original advisory metadata';
        queue.milestones.push({
          ...queue.milestones[1],
          id: 'M3',
          outcome: 'Publish independent notice',
          depends: [],
        });
        await writeQueue(cwd, queue);
        const original = await readQueue(cwd);
        const calls = [];
        let output = '';
        const firstRunner = {
          output: { write(text) { output += text; } },
          async milestoneRunner({ milestone }) {
            calls.push(milestone.id);
            const edited = await readQueue(cwd);
            const targetIndex = edited.milestones.findIndex(({ id }) => id === targetId);
            if (mutation === 'deletion') {
              edited.milestones.splice(targetIndex, 1);
            } else {
              edited.milestones[targetIndex] = {
                ...edited.milestones[targetIndex],
                id: `${targetId}-renamed`,
                rename_note: 'retain attempted owner rename for reconciliation',
              };
            }
            edited.milestones.find(({ id }) => id === 'M3').owner_note = 'preserve concurrent advisory edit';
            await writeQueue(cwd, edited);
            return { status: 'blocked', reason: 'local feature unavailable' };
          },
        };

        assert.equal(await runQueue({ cwd, provider: 'codex' }, firstRunner), 2);
        assert.deepEqual(calls, ['M1']);
        const stopped = await readQueue(cwd);
        assert.deepEqual(
          stopped.milestones.slice(0, 3).map(({ id }) => id),
          ['M1', 'M2', 'M3'],
        );
        const active = stopped.milestones.find(({ id }) => id === 'M1');
        assert.equal(active.status, 'blocked');
        assert.equal(active.stop_scope, 'global');
        const contractView = ({ id, outcome, verify, depends, touchpoints, nonGoals, invariants }) => ({
          id, outcome, verify, depends, touchpoints, nonGoals, invariants,
        });
        assert.deepEqual(
          contractView(stopped.milestones.find(({ id }) => id === targetId)),
          contractView(original.milestones.find(({ id }) => id === targetId)),
        );
        const rawById = new Map(stopped.raw.milestones.map((entry) => [entry.id, entry]));
        assert.equal(rawById.get(targetId).checkpoint_note, 'preserve original advisory metadata');
        assert.equal(rawById.get('M3').owner_note, 'preserve concurrent advisory edit');
        if (mutation === 'rename') {
          assert.deepEqual(stopped.milestones.map(({ id }) => id),
            ['M1', 'M2', 'M3', `${targetId}-renamed`]);
          assert.equal(rawById.get(`${targetId}-renamed`).rename_note,
            'retain attempted owner rename for reconciliation');
          assert.match(output, /new milestone entries retained for explicit reconciliation/u);
        }
        assert.match(output, /pre-run contract|deleted or renamed and restored/u);
        assert.match(output, /milestone set changed/u);

        assert.equal(await runQueue({ cwd, provider: 'codex' }, {
          output: { write() {} },
          async milestoneRunner({ milestone }) { calls.push(milestone.id); return { status: 'complete' }; },
        }), 2);
        assert.deepEqual(calls, ['M1'], 'resume must retain the recovered global stop');
      } finally { await rm(cwd, { recursive: true, force: true }); }
    });
  }
}

test('deleting the only active milestone restores it before returning and across resume', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-queue-only-checkpoint-recovery-'));
  try {
    const queue = projectQueue();
    queue.milestones = [queue.milestones[0]];
    queue.milestones[0].checkpoint_note = 'only milestone metadata';
    await writeQueue(cwd, queue);
    const calls = [];
    assert.equal(await runQueue({ cwd, provider: 'codex' }, {
      output: { write() {} },
      async milestoneRunner({ milestone }) {
        calls.push(milestone.id);
        const edited = await readQueue(cwd);
        edited.milestones = [];
        await writeQueue(cwd, edited);
        return { status: 'complete' };
      },
    }), 2);
    const stopped = await readQueue(cwd);
    assert.deepEqual(stopped.milestones.map(({ id, status, stop_scope }) => ({ id, status, stop_scope })), [
      { id: 'M1', status: 'blocked', stop_scope: 'global' },
    ]);
    assert.equal(stopped.raw.milestones[0].checkpoint_note, 'only milestone metadata');
    assert.equal(await runQueue({ cwd, provider: 'codex' }, {
      output: { write() {} },
      async milestoneRunner({ milestone }) { calls.push(milestone.id); return { status: 'complete' }; },
    }), 2);
    assert.deepEqual(calls, ['M1']);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
