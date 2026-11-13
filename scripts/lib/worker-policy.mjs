import { MODEL_IDS, resolveModelPolicy } from './model-policy.mjs';

/**
 * The root thread is always the coordinator. Level 1 may be spawned only for
 * naming or read-only coordination support; levels 2-7 handle substantive
 * worker phases. This table is the complete recommended-level mapping.
 */
export const WORKER_LEVEL_POLICY = Object.freeze({
  1: Object.freeze({ agent_type: 'cruise_l1', alias: 'luna-M', tier: 'luna', reasoning_effort: 'medium', role_brief: 'Cruise L1 coordination support: perform naming, formatting, deterministic extraction, or read-only mapping; do not make behavioral changes.' }),
  2: Object.freeze({ agent_type: 'cruise_l2', alias: 'terra-X', tier: 'terra', reasoning_effort: 'xhigh', role_brief: 'Cruise L2 bounded worker: complete one clear local component and its focused test.' }),
  3: Object.freeze({ agent_type: 'cruise_l3', alias: 'terra-U', tier: 'terra', reasoning_effort: 'ultra', role_brief: 'Cruise L3 bounded worker: resolve bounded multi-file or local-API behavior with focused regression coverage.' }),
  4: Object.freeze({ agent_type: 'cruise_l4', alias: 'sol-X', tier: 'sol', reasoning_effort: 'xhigh', role_brief: 'Cruise L4 integration worker: complete ordinary multistep or cross-module work with focused integration checks.' }),
  5: Object.freeze({ agent_type: 'cruise_l5', alias: 'astra-H', tier: 'astra', reasoning_effort: 'high', role_brief: 'Cruise L5 consequential worker: preserve the scoped high-consequence invariants and verify the affected boundary.' }),
  6: Object.freeze({ agent_type: 'cruise_l6', alias: 'sol-U', tier: 'sol', reasoning_effort: 'ultra', role_brief: 'Cruise L6 reasoning worker: resolve the evidenced contradiction in the narrow high-consequence item and add a discriminating check.' }),
  7: Object.freeze({ agent_type: 'cruise_l7', alias: 'astra-X', tier: 'astra', reasoning_effort: 'xhigh', role_brief: 'Cruise L7 exceptional worker: resolve only the exceptional scoped architecture or blocker with adversarial verification.' }),
});

const ASTRA_ROLE_CONTROLS = 'Infer routine gaps and persist within the bounded capsule; ask only about material unresolved decisions; keep output compact; calibrate tests to affected risk.';

export const WORKER_LEVELS = Object.freeze(
  Object.keys(WORKER_LEVEL_POLICY).map(Number),
);

const COMPLEXITY_LEVELS = Object.freeze({
  naming: 1,
  retrieval: 2,
  bounded: 3,
  complex: 4,
  consequential: 5,
  repeated: 6,
  exceptional: 7,
});

const CONSEQUENCE_RULES = Object.freeze([
  ['identity_access', /\b(?:auth(?:entication|orization)?|tenant isolation)\b/iu],
  ['sensitive_data', /\b(?:PII|biometrics?|retention|egress)\b/iu],
  ['payment', /\bpayment\b/iu],
  ['integrity_concurrency', /\b(?:signing|replay|idempotenc\w*|concurrenc\w*)\b/iu],
  ['database_control', /\b(?:database migration|row level security|RLS)\b/iu],
  ['scientific_claim', /\b(?:protected holdout|scorer|estimand|statistical claim)\b/iu],
  ['production_action', /\bproduction external action\b/iu],
  ['physical_effect', /\b(?:hardware|physical effects?)\b/iu],
]);

const NON_ESCALATING_FAILURES = new Set([
  'tool',
  'permission',
  'environment',
  'dependency',
  'transport',
  'dns',
  'connection',
  'upstream',
]);

const WORKER_AGENTS = Object.freeze(Object.values(WORKER_LEVEL_POLICY).map(({ agent_type }) => agent_type));

export const WORKER_POLICY_RECORD_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'kind',
    'recommended_level',
    'attempt_number',
    'soft_escalation_reason',
    'coordinator',
    'worker',
    'degraded',
    'degradation_reasons',
  ],
  properties: Object.freeze({
    schema_version: { const: 1 },
    kind: { const: 'cruise_root_managed_worker_policy' },
    recommended_level: { type: 'integer', minimum: 1, maximum: 7 },
    attempt_number: { type: 'integer', minimum: 1 },
    soft_escalation_reason: { type: ['string', 'null'], minLength: 1 },
    coordinator: {
      type: 'object',
      additionalProperties: false,
      required: ['role', 'model_mutation_allowed', 'substantive_work_allowed', 'spawns_worker'],
      properties: {
        role: { const: 'root_coordinator' },
        model_mutation_allowed: { const: false },
        substantive_work_allowed: { const: false },
        spawns_worker: { const: true },
      },
    },
    worker: {
      type: 'object',
      additionalProperties: false,
      required: ['agent_type', 'alias', 'role_brief', 'requested', 'resolved', 'resolution_source'],
      properties: {
        agent_type: { type: 'string', enum: WORKER_AGENTS },
        alias: { type: 'string', minLength: 1 },
        role_brief: { type: 'string', minLength: 1 },
        requested: {
          type: 'object',
          additionalProperties: false,
          required: ['tier', 'model_id', 'reasoning_effort'],
          properties: {
            tier: { type: 'string', enum: ['luna', 'terra', 'sol', 'astra'] },
            model_id: { type: 'string', enum: [MODEL_IDS.luna, MODEL_IDS.terra, MODEL_IDS.sol, MODEL_IDS.astra] },
            reasoning_effort: { type: 'string', enum: ['medium', 'high', 'xhigh', 'ultra'] },
          },
        },
        resolved: {
          type: 'object',
          additionalProperties: false,
          required: ['model_id', 'model', 'reasoning_effort'],
          properties: {
            model_id: { type: ['string', 'null'] },
            model: { type: ['string', 'null'] },
            reasoning_effort: { type: ['string', 'null'] },
          },
        },
        resolution_source: { type: 'string', minLength: 1 },
      },
    },
    degraded: { type: 'boolean' },
    degradation_reasons: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
    exceptional_consequence: {
      type: 'object',
      additionalProperties: false,
      required: ['consequence', 'rationale'],
      properties: {
        consequence: { type: 'string', minLength: 1 },
        rationale: { type: 'string', minLength: 1 },
      },
    },
    transition: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'work_item', 'evidence'],
      properties: {
        kind: { type: 'string', enum: ['escalation', 'deescalation'] },
        work_item: { type: 'string', minLength: 1 },
        evidence: { type: 'string', minLength: 1 },
        from_level: { type: 'integer', minimum: 1, maximum: 7 },
        failure_category: { type: 'string', minLength: 1 },
        exceptional_consequence: {
          type: 'object',
          additionalProperties: false,
          required: ['consequence', 'rationale'],
          properties: {
            consequence: { type: 'string', minLength: 1 },
            rationale: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  }),
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function assertPolicySchema(value, schema, path = '$') {
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  const expected = schema.type == null ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (expected.length && !expected.includes(actual)) throw new TypeError(`${path} must be ${expected.join(' or ')}`);
  if (Object.hasOwn(schema, 'const') && !Object.is(value, schema.const)) throw new TypeError(`${path} has an invalid value`);
  if (schema.enum && !schema.enum.includes(value)) throw new TypeError(`${path} has an invalid value`);
  if (typeof value === 'string' && schema.minLength && value.length < schema.minLength) throw new TypeError(`${path} must not be empty`);
  if (typeof value === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) {
    throw new TypeError(`${path} is outside the allowed range`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => assertPolicySchema(item, schema.items, `${path}[${index}]`));
  if (actual !== 'object') return value;
  for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new TypeError(`${path}.${key} is required`);
  for (const [key, item] of Object.entries(value)) {
    if (schema.properties?.[key]) assertPolicySchema(item, schema.properties[key], `${path}.${key}`);
    else if (schema.additionalProperties === false) throw new TypeError(`${path}.${key} is not allowed`);
  }
  return value;
}

export function normalizeRecommendedLevel(value) {
  if (!Number.isInteger(value) || value < 1 || value > 7) {
    throw new TypeError('recommended_level must be an integer from 1 through 7');
  }
  return value;
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  return value.trim();
}

function selectLevelPolicy(level, transition) {
  const base = WORKER_LEVEL_POLICY[level];
  const evidencedL6ReasoningEscalation = level === 7
    && transition?.kind === 'escalation'
    && transition?.from_level === 6
    && transition?.failure_category === 'reasoning'
    && typeof transition?.evidence === 'string'
    && transition.evidence.trim();
  const selected = evidencedL6ReasoningEscalation
    ? { ...base, alias: 'astra-U', reasoning_effort: 'ultra' }
    : base;
  return Object.freeze({
    ...selected,
    role_brief: selected.tier === 'astra'
      ? `${selected.role_brief} ${ASTRA_ROLE_CONTROLS}`
      : selected.role_brief,
  });
}

/** Classify a single work item from deterministic complexity labels and consequence evidence. */
export function classifyWorkerTask({ task, complexity = 'bounded', consequences = [] } = {}) {
  const text = nonEmpty(task, 'worker task');
  if (!Object.hasOwn(COMPLEXITY_LEVELS, complexity)) {
    throw new TypeError(`worker complexity must be one of ${Object.keys(COMPLEXITY_LEVELS).join(', ')}`);
  }
  if (!Array.isArray(consequences) || consequences.some((item) => typeof item !== 'string')) {
    throw new TypeError('worker consequences must be an array of strings');
  }
  const haystack = [text, ...consequences].join('\n');
  const consequenceMatches = CONSEQUENCE_RULES
    .filter(([, pattern]) => pattern.test(haystack))
    .map(([id]) => id);
  const complexityLevel = COMPLEXITY_LEVELS[complexity];
  const consequenceFloor = consequenceMatches.length > 0 ? 5 : 1;
  return Object.freeze({
    schema_version: 1,
    task: text,
    complexity,
    complexity_level: complexityLevel,
    consequence_matches: Object.freeze(consequenceMatches),
    consequence_floor: consequenceFloor,
    recommended_level: Math.max(complexityLevel, consequenceFloor),
  });
}

function normalizeExceptionalConsequence(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !String(value.consequence ?? '').trim() ||
    !String(value.rationale ?? '').trim()
  ) {
    throw new Error('L7 requires an explicit exceptional-consequence record');
  }
  return Object.freeze({
    consequence: String(value.consequence).trim(),
    rationale: String(value.rationale).trim(),
  });
}

export function routeWorkerTask({ exceptionalConsequence = null, ...input } = {}) {
  const classification = classifyWorkerTask(input);
  const exceptionalRecord = classification.recommended_level === 7
    ? normalizeExceptionalConsequence(exceptionalConsequence)
    : null;
  return Object.freeze({
    ...classification,
    exceptional_consequence: exceptionalRecord,
  });
}

/** Resolve the required child model and effort against the live model/list catalog. */
export function resolveWorkerPolicy({
  recommendedLevel,
  catalog = [],
  attemptNumber = 1,
  softEscalationReason = null,
  transition = null,
  exceptionalConsequence = null,
} = {}) {
  const level = normalizeRecommendedLevel(recommendedLevel);
  const exceptionalRecord = level === 7
    ? normalizeExceptionalConsequence(exceptionalConsequence)
    : null;
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new TypeError('worker attemptNumber must be a positive integer');
  }
  if (
    softEscalationReason != null &&
    (typeof softEscalationReason !== 'string' || !softEscalationReason.trim())
  ) {
    throw new TypeError('softEscalationReason must be null or a non-empty string');
  }
  if ((attemptNumber === 1) !== (softEscalationReason == null)) {
    throw new Error('the initial worker attempt has no escalation reason; every later attempt requires one');
  }

  const selection = selectLevelPolicy(level, transition);
  const resolution = resolveModelPolicy({
    stage: 'root_managed_worker_execution',
    catalog,
    requested: {
      tier: selection.tier,
      reasoning_effort: selection.reasoning_effort,
    },
    attemptNumber,
    escalationReason: softEscalationReason,
  });
  const record = {
    schema_version: 1,
    kind: 'cruise_root_managed_worker_policy',
    recommended_level: level,
    attempt_number: attemptNumber,
    soft_escalation_reason: softEscalationReason?.trim() ?? null,
    coordinator: {
      role: 'root_coordinator',
      model_mutation_allowed: false,
      substantive_work_allowed: false,
      spawns_worker: true,
    },
    worker: {
      agent_type: selection.agent_type,
      alias: selection.alias,
      role_brief: selection.role_brief,
      requested: {
        tier: resolution.requested.tier,
        model_id: resolution.requested.model_id,
        reasoning_effort: resolution.requested.reasoning_effort,
      },
      resolved: {
        model_id: resolution.resolved.model_id,
        model: resolution.resolved.model,
        reasoning_effort: resolution.resolved.reasoning_effort,
      },
      resolution_source: resolution.resolved.source,
    },
    degraded: resolution.degraded,
    degradation_reasons: [...resolution.degradation_reasons],
    ...(exceptionalRecord ? { exceptional_consequence: exceptionalRecord } : {}),
    ...(transition ? { transition } : {}),
  };
  assertPolicySchema(record, WORKER_POLICY_RECORD_SCHEMA);
  return deepFreeze(record);
}

/**
 * Create the next evidenced soft-failure attempt. The level increases by one
 * and is capped at 7 even though the model ladder is intentionally
 * non-monotonic. Reviewed stop conditions may permit additional L7 attempts.
 */
export function escalateWorkerPolicy(previous, {
  catalog = [],
  reason,
  evidence,
  workItem,
  failureCategory = null,
  exceptionalConsequence = null,
} = {}) {
  assertPolicySchema(previous, WORKER_POLICY_RECORD_SCHEMA);
  const escalationReason = nonEmpty(reason, 'a soft worker escalation reason');
  const discriminatingEvidence = nonEmpty(evidence, 'new discriminating evidence');
  const narrowWorkItem = nonEmpty(workItem, 'a narrow work item');
  if (previous.transition?.evidence === discriminatingEvidence) {
    throw new Error('worker escalation requires new discriminating evidence');
  }
  const normalizedFailure = failureCategory == null ? null : String(failureCategory).trim().toLowerCase();
  if (failureCategory != null && !normalizedFailure) {
    throw new TypeError('failureCategory must be null or a non-empty string');
  }
  if (normalizedFailure && NON_ESCALATING_FAILURES.has(normalizedFailure)) {
    throw new Error(`${normalizedFailure} failure does not justify a model escalation`);
  }
  const nextLevel = Math.min(previous.recommended_level + 1, 7);
  let exceptionalRecord = null;
  if (nextLevel === 7) {
    exceptionalRecord = routeWorkerTask({
      task: narrowWorkItem,
      complexity: 'exceptional',
      exceptionalConsequence,
    }).exceptional_consequence;
  }
  return resolveWorkerPolicy({
    recommendedLevel: nextLevel,
    catalog,
    attemptNumber: previous.attempt_number + 1,
    softEscalationReason: escalationReason,
    exceptionalConsequence: exceptionalRecord,
    transition: {
      kind: 'escalation',
      work_item: narrowWorkItem,
      evidence: discriminatingEvidence,
      from_level: previous.recommended_level,
      ...(normalizedFailure ? { failure_category: normalizedFailure } : {}),
      ...(exceptionalRecord ? { exceptional_consequence: exceptionalRecord } : {}),
    },
  });
}

/** Lower only the isolated work item after evidence identifies the uncertainty. */
export function deescalateWorkerPolicy(previous, {
  catalog = [],
  targetLevel,
  workItem,
  evidence,
} = {}) {
  assertPolicySchema(previous, WORKER_POLICY_RECORD_SCHEMA);
  const level = normalizeRecommendedLevel(targetLevel);
  if (level >= previous.recommended_level) {
    throw new Error('de-escalation target must be below the previous worker level');
  }
  return resolveWorkerPolicy({
    recommendedLevel: level,
    catalog,
    attemptNumber: 1,
    transition: {
      kind: 'deescalation',
      work_item: nonEmpty(workItem, 'a narrow work item'),
      evidence: nonEmpty(evidence, 'uncertainty-isolation evidence'),
    },
  });
}
