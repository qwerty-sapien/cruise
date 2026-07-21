import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_STALL,
  FLIGHT_FILE,
  flightPlanTemplate,
  inspectFlightPlan,
  parseFlightPlan,
  readFlightPlan,
  writeFlightPlan,
} from '../scripts/lib/flight-plan.mjs';
import { parseHookFlightPlan } from '../hooks/stop-supervisor.mjs';

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

test('the canonical template stays aligned across both strict parser copies', () => {
  const template = flightPlanTemplate()
    .replace('<one line, falsifiable>', 'Ship the parser')
    .replace('<command>', 'npm test')
    .replace('<path-or-glob>', 'scripts/lib/**')
    .replace('<explicit exclusion>', 'No public API changes')
    .replace('<protected behavior>', 'Existing flags keep working')
    .replace('<prose>', 'Keep the host authoritative.');
  const runtime = parseFlightPlan(template);
  const hook = parseHookFlightPlan(template);
  assert.ok(runtime);
  assert.ok(hook);
  assert.deepEqual({
    version: hook.version,
    status: hook.status,
    outcome: hook.outcome,
    verify: hook.verify,
    scope: hook.scope,
    invariants: hook.invariants,
    stall: hook.stall,
  }, {
    version: runtime.version,
    status: runtime.status,
    outcome: runtime.outcome,
    verify: runtime.verify,
    scope: runtime.scope,
    invariants: runtime.invariants,
    stall: runtime.stall,
  });
});

test('both strict parser copies agree on numeric edge cases', () => {
  const cases = [
    '---\nstatus: active\noutcome: 1.5\n---\n',
    `---\nstatus: active\nstall:\n  quiet_turns: ${Number.MAX_SAFE_INTEGER + 1}\n---\n`,
  ];
  for (const source of cases) {
    const runtime = parseFlightPlan(source);
    const hook = parseHookFlightPlan(source);
    assert.equal(Boolean(runtime), Boolean(hook));
    if (runtime && hook) assert.equal(runtime.outcome, hook.outcome);
  }
});

test('inspection distinguishes absent, invalid, and valid flight state with reasons', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-flight-inspection-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  assert.deepEqual(await inspectFlightPlan(cwd), { state: 'absent' });
  await mkdir(join(cwd, '.cruise'));

  const invalid = [
    ['', /missing opening/u],
    ['status: active\n', /missing opening/u],
    ['---\nstatus: launched\n---\n', /status must be active/u],
    ['---\nstatus: active\n outcome: odd\n---\n', /indentation/u],
  ];
  for (const [text, reason] of invalid) {
    await writeFile(join(cwd, FLIGHT_FILE), text, 'utf8');
    const inspected = await inspectFlightPlan(cwd);
    assert.equal(inspected.state, 'invalid');
    assert.match(inspected.reason, reason);
    assert.match(inspected.contentHash, /^[a-f\d]{64}$/u);
  }

  await writeFile(join(cwd, FLIGHT_FILE), flightPlanTemplate(), 'utf8');
  const valid = await inspectFlightPlan(cwd);
  assert.equal(valid.state, 'valid');
  assert.equal(valid.plan.status, 'active');
});
