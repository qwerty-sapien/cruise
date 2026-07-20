import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseArgs, runQueue, runQueueGoal, runQueueStatus } from '../scripts/cruise.mjs';
import { readFlightPlan } from '../scripts/lib/flight-plan.mjs';

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
  assert.deepEqual(
    milestoneToFlightPlan(milestone, '# Queue\n\nKeep parser results backward compatible.'),
    {
      version: 1,
      status: 'active',
      outcome: 'Migrate callers',
      verify: ['npm test', 'npm run integration'],
      scope: {
        touchpoints: ['src/callers/'],
        nonGoals: [],
      },
      invariants: ['CLI flags unchanged'],
      body: '# Queue milestone M2\n\nCompiled from .cruise/QUEUE.md. Reconcile this milestone with the queue\'s cross-milestone compatibility obligations.\n\n## Inherited queue context\n\n# Queue\n\nKeep parser results backward compatible.',
    },
  );
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

test('queue run preserves mid-queue edits and stops honestly on a stalled milestone', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-queue-run-stall-'));
  try {
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
          edited.milestones[1].outcome = 'Migrate the edited callers';
          edited.body += '\n\nPreserve the compatibility shim until M2 verifies.';
          await writeQueue(cwd, edited);
          return { status: 'complete' };
        }
        assert.equal(input.milestone.outcome, 'Migrate the edited callers');
        assert.match(flight.body, /Preserve the compatibility shim/u);
        return { status: 'stalled', reason: 'no new workspace evidence' };
      },
    });

    assert.equal(exitCode, 3);
    assert.deepEqual(calls.map(({ id }) => id), ['M1', 'M2']);
    assert.match(calls[1].prompt, /Migrate the edited callers/u);
    const queue = await readQueue(cwd);
    assert.deepEqual(queue.milestones.map(({ status }) => status), ['complete', 'stalled']);
    assert.match(output, /Completed queue milestone M1/u);
    assert.match(output, /Queue stopped at M2 \(stalled\)/u);
    assert.deepEqual((await readdir(join(cwd, '.cruise'))).sort(), ['FLIGHT.md', 'QUEUE.md']);
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

test('the real queue Goal adapter uses the Claude flight status as its terminal handshake', async () => {
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
  assert.equal((await runQueueGoal(base, {
    goalRunner,
    flightReader: async () => ({ status: 'complete' }),
  })).status, 'complete');
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
