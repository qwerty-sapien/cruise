import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_STALL,
  FLIGHT_FILE,
  parseFlightPlan,
  readFlightPlan,
  writeFlightPlan,
} from '../scripts/lib/flight-plan.mjs';

test('missing optional fields receive advisory defaults', () => {
  const plan = parseFlightPlan('---\noutcome: Ship the parser\n---\n# Flight plan\n\nKeep it small.');
  assert.deepEqual(plan, {
    version: 1,
    status: 'active',
    outcome: 'Ship the parser',
    verify: [],
    scope: { touchpoints: [], nonGoals: [] },
    invariants: [],
    stall: { quietTurns: DEFAULT_STALL.quietTurns, sameFailure: DEFAULT_STALL.sameFailure },
    body: '# Flight plan\n\nKeep it small.',
    raw: { outcome: 'Ship the parser' },
  });
});

test('write and read round-trip the pinned schema and unknown extensions', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-flight-'));
  try {
    await writeFlightPlan(cwd, {
      version: 1,
      status: 'active',
      outcome: 'Make parsing failures harmless',
      verify: ['npm test', 'node --check scripts/lib/flight-plan.mjs'],
      scope: { touchpoints: ['scripts/lib/'], nonGoals: ['No public API redesign'] },
      invariants: ['Existing CLI flags keep their behavior'],
      stall: { quietTurns: 4, sameFailure: 2 },
      body: '# Flight plan\n\nThe host remains the authority.',
      raw: {
        owner: 'user-editable',
        scope: { reviewer: 'optional' },
        stall: { strategy: 'realign' },
      },
    });

    const plan = await readFlightPlan(cwd);
    assert.equal(plan.outcome, 'Make parsing failures harmless');
    assert.deepEqual(plan.verify, ['npm test', 'node --check scripts/lib/flight-plan.mjs']);
    assert.deepEqual(plan.scope, {
      touchpoints: ['scripts/lib/'],
      nonGoals: ['No public API redesign'],
    });
    assert.deepEqual(plan.stall, { quietTurns: 4, sameFailure: 2 });
    assert.equal(plan.raw.owner, 'user-editable');
    assert.equal(plan.raw.scope.reviewer, 'optional');
    assert.equal(plan.raw.stall.strategy, 'realign');
    assert.equal(plan.body, '# Flight plan\n\nThe host remains the authority.');
    assert.match(await readFile(join(cwd, FLIGHT_FILE), 'utf8'), /^---\nversion: 1\nstatus: active/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('malformed or invalid frontmatter returns null', async () => {
  const inputs = [
    '',
    'outcome: missing fences',
    '---\noutcome: never closed',
    '---\n status: active\n---\n',
    '---\nstatus: launched\n---\n',
    '---\nstatus: null\n---\n',
    '---\nverify: npm test\n---\n',
    '---\noutcome: "two\\nlines"\n---\n',
    '---\nstall:\n  quiet_turns: 0\n---\n',
  ];
  for (const input of inputs) assert.equal(parseFlightPlan(input), null);

  const cwd = await mkdtemp(join(tmpdir(), 'cruise-flight-missing-'));
  try {
    assert.equal(await readFlightPlan(cwd), null);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('parseFlightPlan never throws on pathological text', () => {
  const inputs = [
    null,
    42,
    '\u0000\u0001\u0002',
    `---\n${'  nested:\n'.repeat(20)}value: nope\n---\n`,
    `---\nitems:\n${'  - value\n'.repeat(1_100)}---\n`,
    '---\nvalue: "unterminated\n---\n',
    '---\n__proto__:\n  polluted: true\n---\n',
  ];
  for (const input of inputs) assert.doesNotThrow(() => parseFlightPlan(input));
});
