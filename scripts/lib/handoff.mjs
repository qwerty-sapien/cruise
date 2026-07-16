import { createHash } from 'node:crypto';

import { applyQuickPromotion, LEGACY_PUBLIC_ROUTES, PUBLIC_ROUTES } from './routing.mjs';
import { isTraceId } from './traceability.mjs';
import { assertYamlSchema, canonicalJson } from './yaml-state.mjs';

export const HANDOFF_TRIGGERS = Object.freeze([
  'semantic_promotion',
  'route_mismatch',
  'explicit_user_request',
  'review_remediation',
  'research_implementation',
]);

const QUICK_TARGETS = Object.freeze(['refine', 'goal', 'debug', 'research']);
const HANDOFF_RECORD_ROUTES = Object.freeze([...PUBLIC_ROUTES, ...LEGACY_PUBLIC_ROUTES]);

export const HANDOFF_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'kind',
    'id',
    'created_at',
    'source_route',
    'target_route',
    'trigger',
    'reason',
    'semantic_reasons',
    'evidence_ids',
    'origin_path',
    'route_history',
    'hop_count',
    'parent_handoff_id',
    'recursive_routing',
    'authorizes_product_edits',
    'authorizes_goal_activation',
    'goal_activation_requirement',
  ],
  properties: Object.freeze({
    schema_version: { const: 1 },
    kind: { const: 'cruise_public_route_handoff' },
    id: { type: 'string', pattern: '^HO-[0-9]{2,}$' },
    created_at: { type: 'string', format: 'date-time' },
    source_route: { type: 'string', enum: HANDOFF_RECORD_ROUTES },
    target_route: { type: 'string', enum: HANDOFF_RECORD_ROUTES },
    trigger: { type: 'string', enum: HANDOFF_TRIGGERS },
    reason: { type: 'string', minLength: 1, maxLength: 8_000 },
    semantic_reasons: {
      type: 'array',
      uniqueItems: true,
      maxItems: 64,
      items: { type: 'string', minLength: 1, maxLength: 1_000 },
    },
    evidence_ids: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string', pattern: '^E-[0-9]{2,}$' },
    },
    origin_path: { type: 'string', minLength: 1, maxLength: 4_000 },
    route_history: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      uniqueItems: true,
      items: { type: 'string', enum: HANDOFF_RECORD_ROUTES },
    },
    hop_count: { const: 1 },
    parent_handoff_id: { const: null },
    recursive_routing: { const: false },
    authorizes_product_edits: { const: false },
    authorizes_goal_activation: { const: false },
    goal_activation_requirement: {
      type: 'string',
      enum: [
        'not_applicable',
        'combined_Plan_and_Goal_Approve_required',
        'separate_Approve_Plan_then_Start_Cruise_required',
      ],
    },
  }),
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function uniqueStrings(values, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new TypeError(`${label} entries must be non-empty strings`);
    }
    if (seen.has(value)) throw new Error(`${label} must not contain duplicate values`);
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function validateHandoff(record, { evidenceRecord = null } = {}) {
  assertYamlSchema(record, HANDOFF_SCHEMA, { name: 'Cruise public-route handoff' });
  if (!/^HO-[0-9]{2,}$/u.test(record.id)) {
    throw new TypeError('handoff id must be an HO-XX ID; H-XX is reserved for debug hypotheses');
  }
  if (record.source_route === record.target_route) {
    throw new Error('handoff source and target routes must differ');
  }
  if (
    record.route_history[0] !== record.source_route ||
    record.route_history[1] !== record.target_route
  ) {
    throw new Error('handoff route_history must be exactly [source_route, target_route]');
  }
  if (record.source_route === 'quick' && !QUICK_TARGETS.includes(record.target_route)) {
    throw new Error(`Quick may hand off only to ${QUICK_TARGETS.join(', ')}`);
  }
  if (record.trigger === 'semantic_promotion' && record.semantic_reasons.length === 0) {
    throw new Error('semantic promotion requires at least one deterministic reason');
  }
  if (record.target_route === 'goal') {
    if (
      record.goal_activation_requirement !==
      'combined_Plan_and_Goal_Approve_required'
    ) {
      throw new Error('Goal handoff must retain one combined Plan-and-Goal Approve both authority');
    }
  } else if (record.goal_activation_requirement !== 'not_applicable') {
    throw new Error('non-Goal handoff cannot claim a Goal activation requirement');
  }
  if (record.origin_path.includes('\0')) throw new Error('origin_path must not contain NUL bytes');
  for (const id of record.evidence_ids) {
    if (!isTraceId(id, 'E')) throw new TypeError(`handoff evidence ${id} must be an E-XX ID`);
  }
  if (evidenceRecord != null) {
    const available = new Set((evidenceRecord.items ?? []).map((item) => item.id));
    for (const id of record.evidence_ids) {
      if (!available.has(id)) throw new Error(`handoff references missing evidence ${id}`);
    }
  }
  return record;
}

/**
 * Record exactly one public-route transition. The record intentionally grants
 * neither edit permission nor native Goal activation authority.
 */
export function createHandoff({
  id,
  createdAt,
  sourceRoute,
  targetRoute,
  trigger,
  reason,
  semanticReasons = [],
  evidenceIds,
  originPath,
} = {}) {
  if (!PUBLIC_ROUTES.includes(sourceRoute) || !PUBLIC_ROUTES.includes(targetRoute)) {
    throw new Error('new handoffs may use only current public Cruise routes');
  }
  const record = {
    schema_version: 1,
    kind: 'cruise_public_route_handoff',
    id,
    created_at: createdAt,
    source_route: sourceRoute,
    target_route: targetRoute,
    trigger,
    reason,
    semantic_reasons: uniqueStrings(semanticReasons, 'semanticReasons'),
    evidence_ids: uniqueStrings(evidenceIds, 'evidenceIds'),
    origin_path: originPath,
    route_history: [sourceRoute, targetRoute],
    hop_count: 1,
    parent_handoff_id: null,
    recursive_routing: false,
    authorizes_product_edits: false,
    authorizes_goal_activation: false,
    goal_activation_requirement: targetRoute === 'goal'
      ? 'combined_Plan_and_Goal_Approve_required'
      : 'not_applicable',
  };
  validateHandoff(record);
  return deepFreeze(record);
}

/** Create a handoff whose target is derived by the shared Quick admission gate. */
export function createQuickPromotionHandoff({
  id,
  createdAt,
  proposedRoute = 'quick',
  probe,
  classifier,
  evidenceIds,
  originPath,
  reason = null,
} = {}) {
  const admission = applyQuickPromotion({
    selectedSkill: 'quick',
    proposedRoute,
    probe,
    classifier,
  });
  if (admission.route === 'quick' || admission.promotion_reasons.length === 0) {
    throw new Error('shared Quick admission did not establish a semantic promotion');
  }
  return createHandoff({
    id,
    createdAt,
    sourceRoute: 'quick',
    targetRoute: admission.route,
    trigger: 'semantic_promotion',
    reason: reason ?? `Quick hard gate: ${admission.promotion_reasons.join(', ')}`,
    semanticReasons: admission.promotion_reasons,
    evidenceIds,
    originPath,
  });
}

/** Any attempt to chain a handoff is a new routing loop and is rejected. */
export function assertOneHopHandoff(record, { parentHandoff = null } = {}) {
  validateHandoff(record);
  if (parentHandoff != null) {
    throw new Error('Cruise handoffs are one-hop only; a handoff cannot route recursively');
  }
  return true;
}

export function handoffDigest(record) {
  validateHandoff(record);
  return createHash('sha256').update(canonicalJson(record), 'utf8').digest('hex');
}
