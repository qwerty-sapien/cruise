import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_STALL,
  FLIGHT_FILE,
  FLIGHT_MAX_BYTES,
  flightPlanTemplate,
  inspectFlightPlan,
  parseFlightPlan,
  readFlightPlan,
  writeFlightPlan,
} from '../scripts/lib/flight-plan.mjs';
import { parseHookFlightPlan } from '../hooks/stop-supervisor.mjs';
import {
  computeFlightAssuranceContext,
  computeFlightContextFingerprint,
  evaluateFlightAssurance,
} from '../scripts/lib/assurance.mjs';

function coreV2Plan() {
  return {
    version: 2,
    status: 'complete',
    outcome: 'Ship the parser safely',
    verify: ['npm test'],
    scope: { touchpoints: ['src/**'], nonGoals: ['No API redesign'] },
    invariants: ['Existing flags keep working'],
    stall: { quietTurns: 3, sameFailure: 3 },
    quality: {
      risk: 'medium',
      profiles: ['core'],
      gates: [
        ['intent', 'intent'],
        ['functional', 'functional-correctness'],
        ['regression', 'regression'],
        ['failure-paths', 'failure-paths'],
        ['completion-review', 'completion-review'],
      ].map(([id, dimension]) => ({
        id: `core.${id}`,
        dimension,
        criterion: `Close ${dimension}`,
        oracle: `Review ${dimension}`,
        surface: ['intent', 'completion-review'].includes(dimension)
          ? ['.']
          : [`src/${id}.mjs`],
        severity: 'high',
        state: 'pending',
        evidence: null,
      })),
    },
    body: '# Flight plan',
  };
}

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

test('Flight input and serialized output fail closed above 8 KB', async (t) => {
  assert.equal(parseFlightPlan(`${flightPlanTemplate()}${'x'.repeat(FLIGHT_MAX_BYTES)}`), null);
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-flight-cap-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const plan = coreV2Plan();
  plan.body = 'x'.repeat(FLIGHT_MAX_BYTES);
  await assert.rejects(writeFlightPlan(cwd, plan), /exceeds 8 KB/u);
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

test('Flight v2 round-trips quality gates and requires fresh profile-complete evidence', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-flight-v2-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const plan = coreV2Plan();
  const context = computeFlightContextFingerprint(plan, {
    workspaceFingerprint: 'a'.repeat(64),
    originText: 'Exact request',
  });
  for (const gate of plan.quality.gates) {
    gate.state = 'passed';
    gate.evidence = {
      summary: `${gate.id} passed`,
      contextFingerprint: context,
      observedAt: 1_800_000_000_000,
      source: gate.dimension === 'completion-review' ? 'review' : 'command',
      rationale: '',
      waivedBy: '',
    };
  }
  await writeFlightPlan(cwd, plan);
  const roundTrip = await readFlightPlan(cwd);
  const assured = evaluateFlightAssurance(roundTrip, context);
  assert.equal(assured.level, 'assured');
  assert.equal(assured.allowsCompletion, true);
  assert.equal(assured.metrics.closed, 5);
  roundTrip.status = 'active';
  const ready = evaluateFlightAssurance(roundTrip, context);
  assert.equal(ready.readyForCompletion, true);
  assert.equal(ready.allowsCompletion, false);
  roundTrip.status = 'complete';

  const stale = evaluateFlightAssurance(roundTrip, 'b'.repeat(64));
  assert.equal(stale.level, 'incomplete');
  assert.equal(stale.allowsCompletion, false);
  assert.equal(stale.metrics.fresh, 0);

  roundTrip.quality.gates[3].state = 'waived';
  roundTrip.quality.gates[3].evidence = {
    ...roundTrip.quality.gates[3].evidence,
    source: 'user-decision',
    rationale: 'The user explicitly accepted this limitation',
    waivedBy: 'user',
  };
  const qualified = evaluateFlightAssurance(roundTrip, context);
  assert.equal(qualified.level, 'qualified');
  assert.equal(qualified.allowsCompletion, true);
});

test('Flight v2 rejects decorative profiles, duplicate gates, and unknown versions', () => {
  const missingDimensions = coreV2Plan();
  missingDimensions.quality.gates = missingDimensions.quality.gates.slice(0, 1);
  const source = (plan) => `---
version: ${plan.version}
status: complete
outcome: ${plan.outcome}
quality:
  risk: medium
  profiles:
    - core
  gates:
    -
      id: duplicate
      dimension: intent
      criterion: criterion
      oracle: oracle
      state: pending
    -
      id: duplicate
      dimension: regression
      criterion: criterion
      oracle: oracle
      state: pending
---
`;
  assert.equal(parseFlightPlan(source(missingDimensions)), null);
  assert.equal(parseFlightPlan(source({ ...missingDimensions, version: 3 })), null);

  const assessment = evaluateFlightAssurance(missingDimensions, 'a'.repeat(64));
  assert.equal(assessment.allowsCompletion, false);
  assert.match(assessment.reasons.join('\n'), /missing required functional-correctness gate/u);
});

test('context binding changes with request, product state, or gate contract but not receipts', () => {
  const plan = coreV2Plan();
  const baseline = computeFlightContextFingerprint(plan, {
    workspaceFingerprint: 'a'.repeat(64),
    originText: 'Exact request',
  });
  assert.notEqual(computeFlightContextFingerprint(plan, {
    workspaceFingerprint: 'b'.repeat(64),
    originText: 'Exact request',
  }), baseline);
  plan.body = '# Changed inherited obligation';
  assert.notEqual(computeFlightContextFingerprint(plan, {
    workspaceFingerprint: 'a'.repeat(64),
    originText: 'Exact request',
  }), baseline);
  plan.body = '# Flight plan';
  assert.notEqual(computeFlightContextFingerprint(plan, {
    workspaceFingerprint: 'a'.repeat(64),
    originText: 'Changed request',
  }), baseline);
  plan.quality.gates[0].criterion = 'Changed criterion';
  assert.notEqual(computeFlightContextFingerprint(plan, {
    workspaceFingerprint: 'a'.repeat(64),
    originText: 'Exact request',
  }), baseline);
  plan.quality.gates[0].criterion = 'Close intent';
  plan.quality.gates[0].state = 'passed';
  plan.quality.gates[0].evidence = {
    summary: 'passed',
    contextFingerprint: baseline,
    observedAt: 1,
    source: 'review',
    rationale: '',
    waivedBy: '',
  };
  assert.equal(computeFlightContextFingerprint(plan, {
    workspaceFingerprint: 'a'.repeat(64),
    originText: 'Exact request',
  }), baseline);
});

test('scoped gate receipts survive unrelated edits and stale only the changed surface', () => {
  const plan = coreV2Plan();
  const surfaceFingerprints = Object.fromEntries(
    plan.quality.gates
      .filter(({ dimension }) => !['intent', 'completion-review'].includes(dimension))
      .map(({ id }) => [id, `${id}:stable`]),
  );
  const baseline = computeFlightAssuranceContext(plan, {
    workspaceFingerprint: 'a'.repeat(64),
    originText: 'Exact request',
    surfaceFingerprints,
  });
  for (const gate of plan.quality.gates) {
    gate.state = 'passed';
    gate.evidence = {
      summary: `${gate.id} passed`,
      contextFingerprint: baseline.gateFingerprints[gate.id],
      observedAt: 1,
      source: gate.dimension === 'completion-review' ? 'review' : 'command',
      rationale: '',
      waivedBy: '',
    };
  }
  assert.equal(evaluateFlightAssurance(plan, baseline).metrics.fresh, 5);

  const unrelated = computeFlightAssuranceContext(plan, {
    workspaceFingerprint: 'b'.repeat(64),
    originText: 'Exact request',
    surfaceFingerprints,
  });
  const unrelatedAssessment = evaluateFlightAssurance(plan, unrelated);
  assert.equal(unrelatedAssessment.metrics.fresh, 3);
  assert.deepEqual(
    unrelatedAssessment.gates.filter(({ fresh }) => fresh).map(({ id }) => id).sort(),
    ['core.failure-paths', 'core.functional', 'core.regression'],
  );

  const functionalEdit = computeFlightAssuranceContext(plan, {
    workspaceFingerprint: 'c'.repeat(64),
    originText: 'Exact request',
    surfaceFingerprints: { ...surfaceFingerprints, 'core.functional': 'functional:changed' },
  });
  const functionalAssessment = evaluateFlightAssurance(plan, functionalEdit);
  assert.equal(functionalAssessment.gates.find(({ id }) => id === 'core.functional').fresh, false);
  assert.equal(functionalAssessment.gates.find(({ id }) => id === 'core.regression').fresh, true);
});

test('request or outcome changes stale scoped receipts even after global gates are reviewed again', () => {
  const plan = coreV2Plan();
  const surfaceFingerprints = Object.fromEntries(
    plan.quality.gates
      .filter(({ dimension }) => !['intent', 'completion-review'].includes(dimension))
      .map(({ id }) => [id, `${id}:stable`]),
  );
  const baseline = computeFlightAssuranceContext(plan, {
    workspaceFingerprint: 'a'.repeat(64),
    originText: 'Original request',
    surfaceFingerprints,
  });
  for (const gate of plan.quality.gates) {
    gate.state = 'passed';
    gate.evidence = {
      summary: `${gate.id} passed`,
      contextFingerprint: baseline.gateFingerprints[gate.id],
      observedAt: 1,
      source: gate.dimension === 'completion-review' ? 'review' : 'command',
      rationale: '',
      waivedBy: '',
    };
  }
  plan.outcome = 'Changed outcome';
  const changed = computeFlightAssuranceContext(plan, {
    workspaceFingerprint: 'b'.repeat(64),
    originText: 'Changed request',
    surfaceFingerprints,
  });
  for (const gate of plan.quality.gates.filter(({ dimension }) =>
    ['intent', 'completion-review'].includes(dimension))) {
    gate.evidence.contextFingerprint = changed.gateFingerprints[gate.id];
  }
  const assessment = evaluateFlightAssurance(plan, changed);
  assert.equal(assessment.allowsCompletion, false);
  assert.deepEqual(
    assessment.gates.filter(({ fresh }) => !fresh).map(({ id }) => id).sort(),
    ['core.failure-paths', 'core.functional', 'core.regression'],
  );
});

test('high-risk assurance requires a freshly passed independent review', () => {
  const plan = coreV2Plan();
  plan.quality.risk = 'high';
  const context = computeFlightContextFingerprint(plan, {
    workspaceFingerprint: 'a'.repeat(64),
    originText: 'Optimize safely',
  });
  for (const gate of plan.quality.gates) {
    gate.state = 'passed';
    gate.evidence = {
      summary: 'passed',
      contextFingerprint: context,
      observedAt: 1,
      source: gate.dimension === 'completion-review' ? 'review' : 'command',
      rationale: '',
      waivedBy: '',
    };
  }
  assert.match(
    evaluateFlightAssurance(plan, context).reasons.join('\n'),
    /missing required independent-review gate/u,
  );
  plan.quality.gates.push({
    id: 'core.independent-review',
    dimension: 'independent-review',
    criterion: 'Independent skeptical review finds no unresolved high-risk issue',
    oracle: 'Run an independent review',
    severity: 'high',
    state: 'passed',
    evidence: {
      summary: 'Independent review passed',
      contextFingerprint: '',
      observedAt: 1,
      source: 'review',
      rationale: '',
      waivedBy: '',
    },
  });
  const rebound = computeFlightContextFingerprint(plan, {
    workspaceFingerprint: 'a'.repeat(64),
    originText: 'Optimize safely',
  });
  for (const gate of plan.quality.gates) gate.evidence.contextFingerprint = rebound;
  assert.equal(evaluateFlightAssurance(plan, rebound).level, 'assured');
});

test('legacy, missing-origin, decorative, and whitespace evidence cannot claim assurance', () => {
  const legacy = evaluateFlightAssurance({ version: 1, status: 'complete' }, null);
  assert.equal(legacy.level, 'legacy-unattested');
  assert.equal(legacy.readyForCompletion, false);
  assert.equal(legacy.allowsCompletion, false);

  const plan = coreV2Plan();
  assert.throws(
    () => computeFlightContextFingerprint(plan, {
      workspaceFingerprint: 'a'.repeat(64),
      originText: null,
    }),
    /ORIGIN/u,
  );
  const context = computeFlightContextFingerprint(plan, {
    workspaceFingerprint: 'a'.repeat(64),
    originText: 'Exact request',
  });
  for (const gate of plan.quality.gates) {
    gate.state = 'not_applicable';
    gate.evidence = {
      summary: '',
      contextFingerprint: context,
      observedAt: 1,
      source: 'review',
      rationale: '   ',
      waivedBy: '',
    };
  }
  const decorative = evaluateFlightAssurance(plan, context);
  assert.equal(decorative.allowsCompletion, false);
  assert.match(decorative.reasons.join('\n'), /intent must pass/u);

  for (const gate of plan.quality.gates) {
    gate.state = 'passed';
    gate.evidence = {
      ...gate.evidence,
      summary: '   ',
      source: 'command',
    };
  }
  const whitespace = evaluateFlightAssurance(plan, context);
  assert.equal(whitespace.allowsCompletion, false);
  assert.match(whitespace.reasons.join('\n'), /needs a summary/u);

  plan.quality.gates.find(({ dimension }) => dimension === 'completion-review').evidence = {
    summary: 'Reviewed',
    contextFingerprint: context,
    observedAt: 1,
    source: 'command',
    rationale: '',
    waivedBy: '',
  };
  assert.match(
    evaluateFlightAssurance(plan, context).reasons.join('\n'),
    /completion review must freshly pass with review evidence/u,
  );
});
