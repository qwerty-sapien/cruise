import { MODEL_IDS, resolveModelPolicy } from './model-policy.mjs';
import { assertYamlSchema } from './yaml-state.mjs';

/**
 * The root thread is always the coordinator. Level 1 may be spawned only for
 * naming or read-only coordination support; levels 2-7 handle substantive
 * worker phases. This table is the complete recommended-level mapping.
 */
export const WORKER_LEVEL_POLICY = Object.freeze({
  1: Object.freeze({ agent_type: 'cruise_l1', alias: 'luna-M', tier: 'luna', reasoning_effort: 'medium' }),
  2: Object.freeze({ agent_type: 'cruise_l2', alias: 'terra-M', tier: 'terra', reasoning_effort: 'medium' }),
  3: Object.freeze({ agent_type: 'cruise_l3', alias: 'terra-H', tier: 'terra', reasoning_effort: 'high' }),
  4: Object.freeze({ agent_type: 'cruise_l4', alias: 'terra-X', tier: 'terra', reasoning_effort: 'xhigh' }),
  5: Object.freeze({ agent_type: 'cruise_l5', alias: 'sol-H', tier: 'sol', reasoning_effort: 'high' }),
  6: Object.freeze({ agent_type: 'cruise_l6', alias: 'sol-X', tier: 'sol', reasoning_effort: 'xhigh' }),
  7: Object.freeze({ agent_type: 'cruise_l7', alias: 'sol-U', tier: 'sol', reasoning_effort: 'ultra' }),
});

export const WORKER_LEVELS = Object.freeze(
  Object.keys(WORKER_LEVEL_POLICY).map(Number),
);

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
      required: ['agent_type', 'alias', 'requested', 'resolved', 'resolution_source'],
      properties: {
        agent_type: { type: 'string', enum: WORKER_AGENTS },
        alias: { type: 'string', minLength: 1 },
        requested: {
          type: 'object',
          additionalProperties: false,
          required: ['tier', 'model_id', 'reasoning_effort'],
          properties: {
            tier: { type: 'string', enum: ['luna', 'terra', 'sol'] },
            model_id: { type: 'string', enum: [MODEL_IDS.luna, MODEL_IDS.terra, MODEL_IDS.sol] },
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
  }),
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function normalizeRecommendedLevel(value) {
  if (!Number.isInteger(value) || value < 1 || value > 7) {
    throw new TypeError('recommended_level must be an integer from 1 through 7');
  }
  return value;
}

/** Resolve the required child model and effort against the live model/list catalog. */
export function resolveWorkerPolicy({
  recommendedLevel,
  catalog = [],
  attemptNumber = 1,
  softEscalationReason = null,
} = {}) {
  const level = normalizeRecommendedLevel(recommendedLevel);
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

  const selection = WORKER_LEVEL_POLICY[level];
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
  };
  assertYamlSchema(record, WORKER_POLICY_RECORD_SCHEMA, { name: 'worker policy record' });
  return deepFreeze(record);
}

/**
 * Create the next evidenced soft-failure attempt. The level increases by one
 * and is capped at 7, so selection remains monotonic even when a workflow's
 * reviewed stop conditions permit additional attempts at the strongest level.
 */
export function escalateWorkerPolicy(previous, { catalog = [], reason } = {}) {
  assertYamlSchema(previous, WORKER_POLICY_RECORD_SCHEMA, { name: 'previous worker policy' });
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new TypeError('a soft worker escalation reason is required');
  }
  return resolveWorkerPolicy({
    recommendedLevel: Math.min(previous.recommended_level + 1, 7),
    catalog,
    attemptNumber: previous.attempt_number + 1,
    softEscalationReason: reason,
  });
}
