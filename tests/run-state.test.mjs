import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ALLOWED_RUN_TRANSITIONS,
  createRunState,
  normalizeModelAttempt,
  RUN_STATE_SCHEMA,
  RUN_STATE_SKILLS,
  RUN_STATE_STATUSES,
  TERMINAL_RUN_STATUSES,
  transitionRunState,
  validateRunState,
} from '../scripts/lib/run-state.mjs';
import {
  assertYamlSchema,
  parseYaml,
  stringifyYaml,
} from '../scripts/lib/yaml-state.mjs';

const T0 = '2026-07-13T00:00:00.000Z';
const T1 = '2026-07-13T00:00:01.000Z';
const T2 = '2026-07-13T00:00:02.000Z';
const T3 = '2026-07-13T00:00:03.000Z';

function modelAttempt(attempt = 1, overrides = {}) {
  return {
    requested: { model: 'gpt-5.6-luna', reasoning_effort: 'medium' },
    resolved: { model: 'gpt-5.6-luna', reasoning_effort: 'medium' },
    degraded: false,
    attempt,
    escalation: attempt === 1 ? null : 'bounded escalation after failed attempt',
    ...overrides,
  };
}

test('run state exposes exactly six selected skills and every required status', () => {
  assert.deepEqual(RUN_STATE_SKILLS, ['build', 'quick', 'refine', 'goal', 'debug', 'research']);
  assert.deepEqual(RUN_STATE_STATUSES, [
    'routing_pending',
    'routed',
    'executing',
    'waiting_auth',
    'blocked',
    'completed',
    'completed_waiver_qualified',
  ]);
  assert.deepEqual(TERMINAL_RUN_STATUSES, [
    'blocked',
    'completed',
    'completed_waiver_qualified',
  ]);
  assert.deepEqual(ALLOWED_RUN_TRANSITIONS.completed, []);
});

test('createRunState creates a frozen, minimal routing-pending record', () => {
  const state = createRunState({ runId: 'run-01', selectedSkill: 'quick', now: T0 });
  assert.equal(validateRunState(state), state);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.history[0]), true);
  assert.deepEqual(state, {
    schema_version: 1,
    kind: 'cruise_run_state',
    run_id: 'run-01',
    selected_skill: 'quick',
    current_route: 'quick',
    status: 'routing_pending',
    created_at: T0,
    updated_at: T0,
    model_attempts: [],
    repair_attempts: 0,
    waiting_capabilities: [],
    history: [{
      sequence: 1,
      from_status: null,
      to_status: 'routing_pending',
      from_route: null,
      to_route: 'quick',
      at: T0,
      reason: 'run_created',
      repair_attempts: 0,
      model_attempt_count: 0,
      waiting_capabilities: [],
    }],
  });
  assert.throws(() => createRunState({ runId: 'bad/path', selectedSkill: 'quick' }), /runId is invalid/);
  assert.throws(() => createRunState({ runId: 'run-2', selectedSkill: 'provision' }), /selectedSkill/);
});

test('legacy Review state remains readable but cannot start or resume a public run', () => {
  const legacy = structuredClone(createRunState({ runId: 'legacy-review', selectedSkill: 'build', now: T0 }));
  legacy.selected_skill = 'review';
  legacy.current_route = 'review';
  legacy.history[0].to_route = 'review';
  assert.equal(validateRunState(legacy), legacy);
  assert.throws(
    () => createRunState({ runId: 'new-review', selectedSkill: 'review', now: T0 }),
    /selectedSkill must be one of build/,
  );
  assert.throws(
    () => transitionRunState(legacy, { status: 'routed', reason: 'resume retired route', at: T1 }),
    /currentRoute must be one of build/,
  );
});

test('transitions are immutable and append-preserve history and model attempts', () => {
  const initial = createRunState({ runId: 'run-history', selectedSkill: 'quick', now: T0 });
  const snapshot = structuredClone(initial);
  const classified = transitionRunState(initial, {
    status: 'routed',
    reason: 'classification accepted at the confidence threshold',
    modelAttempt: modelAttempt(),
    at: T1,
  });
  const executing = transitionRunState(classified, {
    status: 'executing',
    reason: 'bounded edit started',
    repairAttempts: 1,
    at: T2,
  });

  assert.deepEqual(initial, snapshot);
  assert.notEqual(classified, initial);
  assert.deepEqual(classified.history.slice(0, 1), initial.history);
  assert.deepEqual(executing.history.slice(0, classified.history.length), classified.history);
  assert.deepEqual(executing.model_attempts, classified.model_attempts);
  assert.equal(executing.repair_attempts, 1);
  assert.equal(executing.history.at(-1).repair_attempts, 1);
  assert.equal(executing.history.at(-1).model_attempt_count, 1);
  assert.equal(Object.isFrozen(executing), true);
  validateRunState(executing);
});

test('route promotion is ledgered while selected_skill remains authoritative history', () => {
  const initial = createRunState({ runId: 'run-promote', selectedSkill: 'quick', now: T0 });
  const promoted = transitionRunState(initial, {
    status: 'routed',
    currentRoute: 'goal',
    reason: 'schema migration is a hard Quick promotion condition',
    at: T1,
  });
  assert.equal(promoted.selected_skill, 'quick');
  assert.equal(promoted.current_route, 'goal');
  assert.deepEqual(promoted.history.at(-1), {
    sequence: 2,
    from_status: 'routing_pending',
    to_status: 'routed',
    from_route: 'quick',
    to_route: 'goal',
    at: T1,
    reason: 'schema migration is a hard Quick promotion condition',
    repair_attempts: 0,
    model_attempt_count: 0,
    waiting_capabilities: [],
  });

  const executing = transitionRunState(promoted, {
    status: 'executing',
    reason: 'approved promoted route started',
    at: T2,
  });
  assert.throws(() => transitionRunState(executing, {
    status: 'routed',
    currentRoute: 'debug',
    reason: 'silent route drift',
    at: T3,
  }), /transition executing -> routed is not allowed/);
});

test('waiting_auth names capability IDs, clears on resume, and rejects malformed or secret values', () => {
  const routed = transitionRunState(
    createRunState({ runId: 'run-auth', selectedSkill: 'research', now: T0 }),
    { status: 'routed', reason: 'research route selected', at: T1 },
  );
  assert.throws(() => transitionRunState(routed, {
    status: 'waiting_auth',
    reason: 'authentication needed',
    waitingCapabilities: [],
    at: T2,
  }), /at least one capability ID/);
  assert.throws(() => transitionRunState(routed, {
    status: 'waiting_auth',
    reason: 'authentication needed',
    waitingCapabilities: ['github'],
    at: T2,
  }), /capability IDs/);

  const waiting = transitionRunState(routed, {
    status: 'waiting_auth',
    reason: 'host-native login required',
    waitingCapabilities: ['CAP-WEB', 'CAP-GITHUB'],
    at: T2,
  });
  assert.deepEqual(waiting.waiting_capabilities, ['CAP-GITHUB', 'CAP-WEB']);
  const resumed = transitionRunState(waiting, {
    status: 'executing',
    reason: 'host confirmed authentication and scope',
    at: T3,
  });
  assert.deepEqual(resumed.waiting_capabilities, []);
  assert.throws(() => transitionRunState(routed, {
    status: 'executing',
    reason: 'authorization=super-secret-value',
    at: T2,
  }), /secret material/);
  assert.throws(() => transitionRunState(routed, {
    status: 'executing',
    reason: 'safe reason',
    modelAttempt: { ...modelAttempt(), api_key: 'hidden' },
    at: T2,
  }), /secret-bearing field/);
});

test('model records preserve requested and resolved model, reasoning, degradation, attempt, and escalation', () => {
  const policyRecord = {
    requested: { model_id: 'gpt-5.6-terra', reasoning_effort: 'high' },
    resolved: { model_id: 'host-default', model: 'host-default', reasoning_effort: 'medium' },
    degraded: true,
    attempt_number: 2,
    escalation_reason: 'Luna classification remained below 0.85',
  };
  assert.deepEqual(normalizeModelAttempt(policyRecord), {
    requested: { model: 'gpt-5.6-terra', reasoning_effort: 'high' },
    resolved: { model: 'host-default', reasoning_effort: 'medium' },
    degraded: true,
    attempt: 2,
    escalation: 'Luna classification remained below 0.85',
  });

  const initial = createRunState({ runId: 'run-models', selectedSkill: 'refine', now: T0 });
  const first = transitionRunState(initial, {
    status: 'routing_pending',
    reason: 'initial model resolution recorded',
    modelAttempt: modelAttempt(1),
    at: T1,
  });
  assert.throws(() => transitionRunState(first, {
    status: 'routed',
    reason: 'duplicate model attempt',
    modelAttempt: modelAttempt(1),
    at: T2,
  }), /must increase/);
  const second = transitionRunState(first, {
    status: 'routed',
    reason: 'bounded escalation resolved routing',
    modelAttempt: modelAttempt(2, {
      requested: { model: 'gpt-5.6-terra', reasoning_effort: 'medium' },
      resolved: { model: null, reasoning_effort: null },
      degraded: true,
    }),
    at: T2,
  });
  assert.equal(second.model_attempts.length, 2);
  assert.equal(second.model_attempts[1].degraded, true);
  assert.equal(second.model_attempts[1].escalation, 'bounded escalation after failed attempt');
});

test('repair attempts cannot decrease in live transitions or parsed history', () => {
  const routed = transitionRunState(
    createRunState({ runId: 'run-repairs', selectedSkill: 'debug', now: T0 }),
    { status: 'routed', reason: 'debug route selected', repairAttempts: 2, at: T1 },
  );
  assert.throws(() => transitionRunState(routed, {
    status: 'executing',
    reason: 'invalid decrement',
    repairAttempts: 1,
    at: T2,
  }), /nondecreasing/);

  const executing = transitionRunState(routed, {
    status: 'executing',
    reason: 'repair loop advanced',
    repairAttempts: 3,
    at: T2,
  });
  const tampered = structuredClone(executing);
  tampered.repair_attempts = 1;
  tampered.history.at(-1).repair_attempts = 1;
  assert.throws(() => validateRunState(tampered), /nondecreasing/);
});

test('blocked and completion states are terminal and cannot reopen', () => {
  for (const terminal of TERMINAL_RUN_STATUSES) {
    const initial = createRunState({ runId: `run-${terminal}`, selectedSkill: 'build', now: T0 });
    const routed = transitionRunState(initial, {
      status: 'routed',
      reason: 'build route selected',
      at: T1,
    });
    const executing = transitionRunState(routed, {
      status: 'executing',
      reason: 'build started',
      at: T2,
    });
    const finished = transitionRunState(executing, {
      status: terminal,
      reason: `run reached ${terminal}`,
      at: T3,
    });
    assert.throws(() => transitionRunState(finished, {
      status: 'executing',
      reason: 'reopen terminal run',
      at: '2026-07-13T00:00:04.000Z',
    }), /cannot reopen/);
  }
});

test('checked-in schema round-trips and validates emitted YAML state', async () => {
  const source = await readFile(new URL('../internal/schemas/run-state.schema.yaml', import.meta.url), 'utf8');
  const checkedInSchema = parseYaml(source);
  assert.deepEqual(checkedInSchema, structuredClone(RUN_STATE_SCHEMA));
  assert.deepEqual(parseYaml(stringifyYaml(checkedInSchema)), checkedInSchema);

  const state = transitionRunState(
    createRunState({ runId: 'run-yaml', selectedSkill: 'goal', now: T0 }),
    { status: 'routed', reason: 'goal route selected', at: T1 },
  );
  assertYamlSchema(state, checkedInSchema, { name: 'state.yaml' });
  const roundTrip = parseYaml(stringifyYaml(state));
  assert.deepEqual(roundTrip, structuredClone(state));
  validateRunState(roundTrip);

  const invalid = structuredClone(roundTrip);
  invalid.status = 'complete';
  assert.throws(() => assertYamlSchema(invalid, checkedInSchema), /must be one of/);
});
