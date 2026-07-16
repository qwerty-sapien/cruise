const SKILLS = Object.freeze([
  'build',
  'quick',
  'refine',
  'goal',
  'debug',
]);
const LEGACY_SKILLS = Object.freeze(['review', 'research']);
const RECORD_SKILLS = Object.freeze([...SKILLS, ...LEGACY_SKILLS]);

const STATUSES = Object.freeze([
  'routing_pending',
  'routed',
  'executing',
  'waiting_auth',
  'blocked',
  'completed',
  'completed_waiver_qualified',
]);

export const RUN_STATE_SCHEMA_VERSION = 1;
export const RUN_STATE_KIND = 'cruise_run_state';
export const RUN_STATE_SKILLS = SKILLS;
export const RUN_STATE_STATUSES = STATUSES;
export const TERMINAL_RUN_STATUSES = Object.freeze([
  'blocked',
  'completed',
  'completed_waiver_qualified',
]);

/**
 * Same-status edges are deliberate progress events. They let routing and
 * execution append evidence such as model attempts without inventing a new
 * status. A route may change exactly once, on the initial
 * `routing_pending` -> `routed` transition.
 */
export const ALLOWED_RUN_TRANSITIONS = Object.freeze({
  routing_pending: Object.freeze(['routing_pending', 'routed', 'blocked']),
  routed: Object.freeze(['routed', 'executing', 'waiting_auth', 'blocked']),
  executing: Object.freeze([
    'executing',
    'waiting_auth',
    'blocked',
    'completed',
    'completed_waiver_qualified',
  ]),
  waiting_auth: Object.freeze(['waiting_auth', 'executing', 'blocked']),
  blocked: Object.freeze([]),
  completed: Object.freeze([]),
  completed_waiver_qualified: Object.freeze([]),
});

const SKILL_SET = new Set(SKILLS);
const RECORD_SKILL_SET = new Set(RECORD_SKILLS);
const STATUS_SET = new Set(STATUSES);
const TERMINAL_STATUS_SET = new Set(TERMINAL_RUN_STATUSES);
const RUN_ID = /^(?=.{1,15}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const CAPABILITY_ID = /^CAP-[A-Z0-9][A-Z0-9-]*$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const SENSITIVE_KEY = /^(?:api[_-]?key|authorization|cookie|credential|password|passphrase|private[_-]?key|secret|session[_-]?token|access[_-]?token|refresh[_-]?token|bearer)$/iu;
const SENSITIVE_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:sk|rk)-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|authorization|password|passphrase|private[_-]?key|secret|access[_-]?token|refresh[_-]?token)\s*[=:]\s*[^\s,;]{4,})/iu;

export const RUN_STATE_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'kind',
    'run_id',
    'selected_skill',
    'current_route',
    'status',
    'created_at',
    'updated_at',
    'model_attempts',
    'repair_attempts',
    'waiting_capabilities',
    'history',
  ],
  properties: {
    schema_version: { const: RUN_STATE_SCHEMA_VERSION, type: 'integer' },
    kind: { const: RUN_STATE_KIND, type: 'string' },
    run_id: {
      type: 'string',
      maxLength: 15,
      pattern: '^[a-z][a-z0-9]*(-[a-z0-9]+)*$',
    },
    selected_skill: { type: 'string', enum: [...RECORD_SKILLS] },
    current_route: { type: 'string', enum: [...RECORD_SKILLS] },
    status: { type: 'string', enum: [...STATUSES] },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
    model_attempts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['requested', 'resolved', 'degraded', 'attempt', 'escalation'],
        properties: {
          requested: {
            type: 'object',
            additionalProperties: false,
            required: ['model', 'reasoning_effort'],
            properties: {
              model: { type: 'string', minLength: 1 },
              reasoning_effort: { type: 'string', minLength: 1 },
            },
          },
          resolved: {
            type: 'object',
            additionalProperties: false,
            required: ['model', 'reasoning_effort'],
            properties: {
              model: { type: ['string', 'null'], minLength: 1 },
              reasoning_effort: { type: ['string', 'null'], minLength: 1 },
            },
          },
          degraded: { type: 'boolean' },
          attempt: { type: 'integer', minimum: 1 },
          escalation: { type: ['string', 'null'], minLength: 1 },
        },
      },
    },
    repair_attempts: { type: 'integer', minimum: 0 },
    waiting_capabilities: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', pattern: CAPABILITY_ID.source },
    },
    history: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'sequence',
          'from_status',
          'to_status',
          'from_route',
          'to_route',
          'at',
          'reason',
          'repair_attempts',
          'model_attempt_count',
          'waiting_capabilities',
        ],
        properties: {
          sequence: { type: 'integer', minimum: 1 },
          from_status: { type: ['string', 'null'], enum: [null, ...STATUSES] },
          to_status: { type: 'string', enum: [...STATUSES] },
          from_route: { type: ['string', 'null'], enum: [null, ...RECORD_SKILLS] },
          to_route: { type: 'string', enum: [...RECORD_SKILLS] },
          at: { type: 'string', format: 'date-time' },
          reason: { type: 'string', minLength: 1 },
          repair_attempts: { type: 'integer', minimum: 0 },
          model_attempt_count: { type: 'integer', minimum: 0 },
          waiting_capabilities: {
            type: 'array',
            uniqueItems: true,
            items: { type: 'string', pattern: CAPABILITY_ID.source },
          },
        },
      },
    },
  },
});

export class RunStateValidationError extends Error {
  constructor(message, { code = 'CRUISE_RUN_STATE_INVALID' } = {}) {
    super(message);
    this.name = 'RunStateValidationError';
    this.code = code;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

function assert(condition, message, code) {
  if (!condition) throw new RunStateValidationError(message, { code });
}

function timestamp(value) {
  const supplied = typeof value === 'function' ? value() : value;
  const date = supplied == null ? new Date() : supplied instanceof Date ? supplied : new Date(supplied);
  assert(!Number.isNaN(date.getTime()), 'run-state timestamp must be a valid date-time');
  return date.toISOString();
}

function isTimestamp(value) {
  return typeof value === 'string' && RFC3339.test(value) && Number.isFinite(Date.parse(value));
}

function assertNoSecrets(value, path = '$', seen = new WeakSet()) {
  if (typeof value === 'string') {
    assert(!SENSITIVE_VALUE.test(value), `${path} appears to contain secret material`, 'CRUISE_RUN_STATE_SECRET');
    return;
  }
  if (value === null || typeof value !== 'object') return;
  assert(!seen.has(value), `${path} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecrets(entry, `${path}[${index}]`, seen));
  } else {
    for (const [key, entry] of Object.entries(value)) {
      assert(!SENSITIVE_KEY.test(key), `${path}.${key} is a secret-bearing field`, 'CRUISE_RUN_STATE_SECRET');
      assertNoSecrets(entry, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function assertExactKeys(value, expected, path) {
  assert(isPlainObject(value), `${path} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(
    actual.length === wanted.length && actual.every((key, index) => key === wanted[index]),
    `${path} must contain exactly: ${wanted.join(', ')}`,
  );
}

function assertString(value, path, { nullable = false } = {}) {
  if (nullable && value === null) return;
  assert(typeof value === 'string' && value.length > 0, `${path} must be a non-empty string${nullable ? ' or null' : ''}`);
}

function assertInteger(value, path, minimum = 0) {
  assert(Number.isInteger(value) && value >= minimum, `${path} must be an integer >= ${minimum}`);
}

function normalizeCapabilityIds(value, path = 'waiting_capabilities') {
  assert(Array.isArray(value), `${path} must be an array`);
  const seen = new Set();
  for (const id of value) {
    assert(typeof id === 'string' && CAPABILITY_ID.test(id), `${path} must contain only capability IDs matching ${CAPABILITY_ID.source}`);
    assert(!seen.has(id), `${path} must not contain duplicate capability IDs`);
    seen.add(id);
  }
  return [...value].sort((left, right) => left.localeCompare(right, 'en'));
}

function normalizeEndpoint(value, path, { nullable = false } = {}) {
  assert(isPlainObject(value), `${path} must be an object`);
  assertExactKeys(value, ['model', 'reasoning_effort'], path);
  assertString(value.model, `${path}.model`, { nullable });
  assertString(value.reasoning_effort, `${path}.reasoning_effort`, { nullable });
  return {
    model: value.model?.trim() || null,
    reasoning_effort: value.reasoning_effort?.trim() || null,
  };
}

/** Normalize either the run-state shape or a resolveModelPolicy result. */
export function normalizeModelAttempt(value) {
  assertNoSecrets(value, 'model_attempt');
  assert(isPlainObject(value), 'model attempt must be an object');
  const requested = value.requested;
  const resolved = value.resolved;
  const normalized = {
    requested: normalizeEndpoint({
      model: requested?.model ?? requested?.model_id,
      reasoning_effort: requested?.reasoning_effort,
    }, 'model_attempt.requested'),
    resolved: normalizeEndpoint({
      model: resolved?.model ?? resolved?.model_id ?? null,
      reasoning_effort: resolved?.reasoning_effort ?? null,
    }, 'model_attempt.resolved', { nullable: true }),
    degraded: value.degraded,
    attempt: value.attempt ?? value.attempt_number,
    escalation: value.escalation ?? value.escalation_reason ?? null,
  };
  assert(typeof normalized.degraded === 'boolean', 'model_attempt.degraded must be boolean');
  assertInteger(normalized.attempt, 'model_attempt.attempt', 1);
  assertString(normalized.escalation, 'model_attempt.escalation', { nullable: true });
  return normalized;
}

function assertModelAttempt(value, index, attempts) {
  const path = `model_attempts[${index}]`;
  assertExactKeys(value, ['requested', 'resolved', 'degraded', 'attempt', 'escalation'], path);
  normalizeEndpoint(value.requested, `${path}.requested`);
  normalizeEndpoint(value.resolved, `${path}.resolved`, { nullable: true });
  assert(typeof value.degraded === 'boolean', `${path}.degraded must be boolean`);
  assertInteger(value.attempt, `${path}.attempt`, 1);
  assertString(value.escalation, `${path}.escalation`, { nullable: true });
  if (index > 0) {
    assert(
      value.attempt > attempts[index - 1].attempt,
      'model attempt numbers must increase in append order',
    );
  }
}

function transitionAllowed(from, to) {
  return ALLOWED_RUN_TRANSITIONS[from]?.includes(to) === true;
}

function routeChangeAllowed(fromStatus, toStatus) {
  return fromStatus === 'routing_pending' && toStatus === 'routed';
}

function assertHistory(state) {
  assert(Array.isArray(state.history) && state.history.length > 0, 'history must be a non-empty array');
  let previous = null;
  state.history.forEach((entry, index) => {
    const path = `history[${index}]`;
    assertExactKeys(entry, [
      'sequence',
      'from_status',
      'to_status',
      'from_route',
      'to_route',
      'at',
      'reason',
      'repair_attempts',
      'model_attempt_count',
      'waiting_capabilities',
    ], path);
    assertInteger(entry.sequence, `${path}.sequence`, 1);
    assert(entry.sequence === index + 1, `${path}.sequence must be ${index + 1}`);
    assert(STATUS_SET.has(entry.to_status), `${path}.to_status is invalid`);
    assert(RECORD_SKILL_SET.has(entry.to_route), `${path}.to_route is invalid`);
    assert(isTimestamp(entry.at), `${path}.at must be an RFC3339 date-time`);
    assertString(entry.reason, `${path}.reason`);
    assertInteger(entry.repair_attempts, `${path}.repair_attempts`);
    assertInteger(entry.model_attempt_count, `${path}.model_attempt_count`);
    normalizeCapabilityIds(entry.waiting_capabilities, `${path}.waiting_capabilities`);

    if (previous === null) {
      assert(entry.from_status === null, `${path}.from_status must be null`);
      assert(entry.from_route === null, `${path}.from_route must be null`);
      assert(entry.to_status === 'routing_pending', `${path}.to_status must begin at routing_pending`);
      assert(entry.to_route === state.selected_skill, `${path}.to_route must begin at selected_skill`);
      assert(entry.repair_attempts === 0, `${path}.repair_attempts must begin at 0`);
      assert(entry.model_attempt_count === 0, `${path}.model_attempt_count must begin at 0`);
      assert(entry.waiting_capabilities.length === 0, `${path}.waiting_capabilities must begin empty`);
    } else {
      assert(entry.from_status === previous.to_status, `${path}.from_status does not continue history`);
      assert(entry.from_route === previous.to_route, `${path}.from_route does not continue history`);
      assert(transitionAllowed(entry.from_status, entry.to_status), `${path} contains forbidden transition ${entry.from_status} -> ${entry.to_status}`);
      assert(
        Date.parse(entry.at) >= Date.parse(previous.at),
        `${path}.at must not precede the previous event`,
      );
      assert(
        entry.repair_attempts >= previous.repair_attempts,
        `${path}.repair_attempts must be nondecreasing`,
      );
      assert(
        entry.model_attempt_count >= previous.model_attempt_count,
        `${path}.model_attempt_count must be nondecreasing`,
      );
      if (entry.from_route !== entry.to_route) {
        assert(
          routeChangeAllowed(entry.from_status, entry.to_status),
          `${path} changes route without an explicit routed transition`,
        );
      }
    }
    if (entry.to_status === 'waiting_auth') {
      assert(entry.waiting_capabilities.length > 0, `${path} waiting_auth must name capability IDs`);
    } else {
      assert(entry.waiting_capabilities.length === 0, `${path} may list capabilities only while waiting_auth`);
    }
    previous = entry;
  });

  const last = state.history.at(-1);
  assert(last.to_status === state.status, 'status must match the final history event');
  assert(last.to_route === state.current_route, 'current_route must match the final history event');
  assert(last.repair_attempts === state.repair_attempts, 'repair_attempts must match the final history event');
  assert(last.model_attempt_count === state.model_attempts.length, 'model_attempts length must match the final history event');
  assert(
    JSON.stringify(last.waiting_capabilities) === JSON.stringify(state.waiting_capabilities),
    'waiting_capabilities must match the final history event',
  );
  assert(state.created_at === state.history[0].at, 'created_at must match the first history event');
  assert(state.updated_at === last.at, 'updated_at must match the final history event');
}

/** Validate a parsed run-state record and return it unchanged. */
export function validateRunState(state) {
  assertNoSecrets(state);
  assertExactKeys(state, [
    'schema_version',
    'kind',
    'run_id',
    'selected_skill',
    'current_route',
    'status',
    'created_at',
    'updated_at',
    'model_attempts',
    'repair_attempts',
    'waiting_capabilities',
    'history',
  ], 'run state');
  assert(state.schema_version === RUN_STATE_SCHEMA_VERSION, `schema_version must equal ${RUN_STATE_SCHEMA_VERSION}`);
  assert(state.kind === RUN_STATE_KIND, `kind must equal ${RUN_STATE_KIND}`);
  assert(typeof state.run_id === 'string' && RUN_ID.test(state.run_id), 'run_id is invalid');
  assert(RECORD_SKILL_SET.has(state.selected_skill), `selected_skill must be one of ${RECORD_SKILLS.join(', ')}`);
  assert(RECORD_SKILL_SET.has(state.current_route), `current_route must be one of ${RECORD_SKILLS.join(', ')}`);
  assert(STATUS_SET.has(state.status), `status must be one of ${STATUSES.join(', ')}`);
  assert(isTimestamp(state.created_at), 'created_at must be an RFC3339 date-time');
  assert(isTimestamp(state.updated_at), 'updated_at must be an RFC3339 date-time');
  assert(Date.parse(state.updated_at) >= Date.parse(state.created_at), 'updated_at must not precede created_at');
  assert(Array.isArray(state.model_attempts), 'model_attempts must be an array');
  state.model_attempts.forEach((attempt, index) => {
    assertModelAttempt(attempt, index, state.model_attempts);
  });
  assertInteger(state.repair_attempts, 'repair_attempts');
  normalizeCapabilityIds(state.waiting_capabilities);
  if (state.status === 'waiting_auth') {
    assert(state.waiting_capabilities.length > 0, 'waiting_auth must name at least one capability ID');
  } else {
    assert(state.waiting_capabilities.length === 0, 'waiting_capabilities is allowed only while waiting_auth');
  }
  assertHistory(state);
  return state;
}

/** Create the immutable initial state for one selected public Cruise skill. */
export function createRunState({ runId, selectedSkill, now = null } = {}) {
  assert(typeof runId === 'string' && RUN_ID.test(runId), 'runId is invalid');
  assert(SKILL_SET.has(selectedSkill), `selectedSkill must be one of ${SKILLS.join(', ')}`);
  const createdAt = timestamp(now);
  const state = {
    schema_version: RUN_STATE_SCHEMA_VERSION,
    kind: RUN_STATE_KIND,
    run_id: runId,
    selected_skill: selectedSkill,
    current_route: selectedSkill,
    status: 'routing_pending',
    created_at: createdAt,
    updated_at: createdAt,
    model_attempts: [],
    repair_attempts: 0,
    waiting_capabilities: [],
    history: [{
      sequence: 1,
      from_status: null,
      to_status: 'routing_pending',
      from_route: null,
      to_route: selectedSkill,
      at: createdAt,
      reason: 'run_created',
      repair_attempts: 0,
      model_attempt_count: 0,
      waiting_capabilities: [],
    }],
  };
  validateRunState(state);
  return deepFreeze(state);
}

/**
 * Return a new immutable state. The previous object and every existing history
 * or model-attempt entry are preserved byte-for-byte under structured cloning.
 */
export function transitionRunState(state, {
  status,
  currentRoute = state?.current_route,
  reason,
  at = null,
  now = null,
  repairAttempts = state?.repair_attempts,
  waitingCapabilities,
  modelAttempt = null,
} = {}) {
  validateRunState(state);
  assert(!TERMINAL_STATUS_SET.has(state.status), `terminal run state ${state.status} cannot reopen`, 'CRUISE_RUN_STATE_TERMINAL');
  assert(STATUS_SET.has(status), `status must be one of ${STATUSES.join(', ')}`);
  assert(transitionAllowed(state.status, status), `transition ${state.status} -> ${status} is not allowed`, 'CRUISE_RUN_STATE_TRANSITION');
  assert(SKILL_SET.has(currentRoute), `currentRoute must be one of ${SKILLS.join(', ')}`);
  assertString(reason, 'reason');
  assertNoSecrets(reason, 'reason');
  assertInteger(repairAttempts, 'repairAttempts');
  assert(repairAttempts >= state.repair_attempts, 'repairAttempts must be nondecreasing');
  if (currentRoute !== state.current_route) {
    assert(
      routeChangeAllowed(state.status, status),
      'currentRoute may change only on the initial routing_pending to routed transition',
    );
  }

  const eventAt = timestamp(at ?? now);
  assert(Date.parse(eventAt) >= Date.parse(state.updated_at), 'transition timestamp must not precede updated_at');

  let capabilities;
  if (status === 'waiting_auth') {
    const supplied = waitingCapabilities ?? (state.status === 'waiting_auth' ? state.waiting_capabilities : null);
    assert(supplied !== null, 'entering waiting_auth requires waitingCapabilities');
    capabilities = normalizeCapabilityIds(supplied);
    assert(capabilities.length > 0, 'waiting_auth must name at least one capability ID');
  } else {
    assert(
      waitingCapabilities == null || waitingCapabilities.length === 0,
      'waitingCapabilities must be empty outside waiting_auth',
    );
    capabilities = [];
  }

  const attempts = state.model_attempts.map((entry) => structuredClone(entry));
  if (modelAttempt !== null) {
    const normalized = normalizeModelAttempt(modelAttempt);
    const lastAttempt = attempts.at(-1)?.attempt ?? 0;
    assert(normalized.attempt > lastAttempt, 'model attempt numbers must increase in append order');
    attempts.push(normalized);
  }

  const next = {
    ...structuredClone(state),
    current_route: currentRoute,
    status,
    updated_at: eventAt,
    model_attempts: attempts,
    repair_attempts: repairAttempts,
    waiting_capabilities: capabilities,
    history: [
      ...state.history.map((entry) => structuredClone(entry)),
      {
        sequence: state.history.length + 1,
        from_status: state.status,
        to_status: status,
        from_route: state.current_route,
        to_route: currentRoute,
        at: eventAt,
        reason: reason.trim(),
        repair_attempts: repairAttempts,
        model_attempt_count: attempts.length,
        waiting_capabilities: capabilities,
      },
    ],
  };
  validateRunState(next);
  return deepFreeze(next);
}
