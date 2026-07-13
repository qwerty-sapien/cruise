import { createHash } from 'node:crypto';

import { isTraceId, parseTraceId } from './traceability.mjs';
import { assertYamlSchema, canonicalJson } from './yaml-state.mjs';

export const EVIDENCE_STATUSES = Object.freeze(['PASS', 'BLOCK', 'NOT_RUN']);
export const EVIDENCE_GATES = Object.freeze(['mandatory', 'advisory']);
export const EVIDENCE_SCOPES = Object.freeze(['task', 'final_verification', 'advisory']);
export const COMPLETION_OUTCOMES = Object.freeze([
  'active',
  'completed',
  'completed_waiver_qualified',
  'blocked',
]);

const SUPPORT_PREFIXES = Object.freeze(['G', 'R', 'AC', 'D', 'T', 'F', 'H']);
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

const IDENTITY_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['source', 'build', 'environment'],
  properties: Object.freeze({
    source: { type: 'string', minLength: 1, maxLength: 2_000 },
    build: { type: 'string', minLength: 1, maxLength: 2_000 },
    environment: { type: 'string', minLength: 1, maxLength: 4_000 },
  }),
});

const CLEANUP_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['required', 'procedure', 'actual', 'completed'],
  properties: Object.freeze({
    required: { type: 'boolean' },
    procedure: { type: ['string', 'null'], minLength: 1, maxLength: 8_000 },
    actual: { type: 'string', minLength: 1, maxLength: 8_000 },
    completed: { type: 'boolean' },
  }),
});

const WAIVER_SCHEMA = Object.freeze({
  type: ['object', 'null'],
  additionalProperties: false,
  required: [
    'decision_id',
    'reason',
    'accepted_residual_risk',
    'owner',
    'approved_at',
    'reopen_trigger',
    'compensating_evidence_ids',
    'locked',
  ],
  properties: Object.freeze({
    decision_id: { type: 'string', pattern: '^D-[0-9]{2,}$' },
    reason: { type: 'string', minLength: 1, maxLength: 8_000 },
    accepted_residual_risk: { type: 'string', minLength: 1, maxLength: 8_000 },
    owner: { type: 'string', minLength: 1, maxLength: 1_000 },
    approved_at: { type: 'string', format: 'date-time' },
    reopen_trigger: { type: 'string', minLength: 1, maxLength: 8_000 },
    compensating_evidence_ids: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', pattern: '^E-[0-9]{2,}$' },
    },
    locked: { const: true },
  }),
});

export const EVIDENCE_ITEM_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'gate',
    'scope',
    'status',
    'performed',
    'procedure',
    'command',
    'expected',
    'actual',
    'identity',
    'started_at',
    'finished_at',
    'supports',
    'side_effects',
    'cleanup',
    'waiver',
  ],
  properties: Object.freeze({
    id: { type: 'string', pattern: '^E-[0-9]{2,}$' },
    gate: { type: 'string', enum: EVIDENCE_GATES },
    scope: { type: 'string', enum: EVIDENCE_SCOPES },
    status: { type: 'string', enum: EVIDENCE_STATUSES },
    performed: { type: 'boolean' },
    procedure: { type: 'string', minLength: 1, maxLength: 16_000 },
    command: { type: ['string', 'null'], minLength: 1, maxLength: 16_000 },
    expected: { type: 'string', minLength: 1, maxLength: 16_000 },
    actual: { type: 'string', minLength: 1, maxLength: 32_000 },
    identity: IDENTITY_SCHEMA,
    started_at: { type: 'string', format: 'date-time' },
    finished_at: { type: 'string', format: 'date-time' },
    supports: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', pattern: '^(G|R|AC|D|T|F|H)-[0-9]{2,}$' },
    },
    side_effects: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 8_000 },
    },
    cleanup: CLEANUP_SCHEMA,
    waiver: WAIVER_SCHEMA,
  }),
});

export const FINAL_VERIFICATION_SCHEMA = Object.freeze({
  type: ['object', 'null'],
  additionalProperties: false,
  required: [
    'verifier',
    'performed_at',
    'origin_compared',
    'normalized_contract_compared',
    'actual_changes_or_outputs_compared',
    'task_completion_only',
    'evidence_ids',
  ],
  properties: Object.freeze({
    verifier: { type: 'string', minLength: 1, maxLength: 2_000 },
    performed_at: { type: 'string', format: 'date-time' },
    origin_compared: { type: 'boolean' },
    normalized_contract_compared: { type: 'boolean' },
    actual_changes_or_outputs_compared: { type: 'boolean' },
    task_completion_only: { const: false },
    evidence_ids: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string', pattern: '^E-[0-9]{2,}$' },
    },
  }),
});

export const EVIDENCE_RECORD_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'kind',
    'run_id',
    'recorded_at',
    'outcome',
    'determined_at',
    'items',
    'final_verification',
  ],
  properties: Object.freeze({
    schema_version: { const: 1 },
    kind: { const: 'cruise_evidence_record' },
    run_id: { type: 'string', minLength: 1, maxLength: 1_000 },
    recorded_at: { type: 'string', format: 'date-time' },
    outcome: { type: 'string', enum: COMPLETION_OUTCOMES },
    determined_at: { type: ['string', 'null'], format: 'date-time' },
    items: { type: 'array', maxItems: 10_000, items: EVIDENCE_ITEM_SCHEMA },
    final_verification: FINAL_VERIFICATION_SCHEMA,
  }),
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !RFC3339.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an RFC3339 timestamp`);
  }
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

function normalizeSupports(values) {
  return uniqueStrings(values ?? [], 'supports').map((id) => {
    const parsed = parseTraceId(id);
    if (!SUPPORT_PREFIXES.includes(parsed.prefix)) {
      throw new TypeError(`supports may reference only ${SUPPORT_PREFIXES.join('/')} IDs, got ${id}`);
    }
    return id;
  });
}

function normalizeCleanup(cleanup, sideEffects) {
  const value = cleanup == null
    ? {
        required: sideEffects.length > 0,
        procedure: sideEffects.length > 0 ? null : 'No cleanup was required.',
        actual: sideEffects.length > 0 ? 'Cleanup has not been recorded.' : 'No cleanup was required.',
        completed: sideEffects.length === 0,
      }
    : structuredClone(cleanup);
  assertYamlSchema(value, CLEANUP_SCHEMA, { name: 'evidence cleanup' });
  if (sideEffects.length > 0 && !value.required) {
    throw new Error('evidence with side effects must mark cleanup as required');
  }
  if (value.required && value.procedure == null) {
    throw new Error('required cleanup must name an exact procedure');
  }
  return value;
}

function normalizeWaiver(waiver, evidenceId) {
  if (waiver == null) return null;
  const value = structuredClone(waiver);
  assertYamlSchema(value, WAIVER_SCHEMA, { name: `${evidenceId} waiver` });
  if (!isTraceId(value.decision_id, 'D')) {
    throw new TypeError(`${evidenceId} waiver.decision_id must be a D-XX ID`);
  }
  if (value.compensating_evidence_ids.includes(evidenceId)) {
    throw new Error(`${evidenceId} waiver cannot cite itself as compensating evidence`);
  }
  timestamp(value.approved_at, `${evidenceId} waiver.approved_at`);
  return value;
}

export function validateEvidenceItem(item) {
  assertYamlSchema(item, EVIDENCE_ITEM_SCHEMA, { name: 'Cruise evidence item' });
  if (!isTraceId(item.id, 'E')) throw new TypeError('evidence id must be an E-XX ID');
  timestamp(item.started_at, `${item.id}.started_at`);
  timestamp(item.finished_at, `${item.id}.finished_at`);
  if (Date.parse(item.finished_at) < Date.parse(item.started_at)) {
    throw new Error(`${item.id}.finished_at cannot precede started_at`);
  }
  normalizeSupports(item.supports);
  if (item.status === 'PASS' && !item.performed) {
    throw new Error(`${item.id} cannot PASS when its procedure was not performed`);
  }
  if (item.status === 'NOT_RUN' && item.performed) {
    throw new Error(`${item.id} cannot be NOT_RUN when performed is true`);
  }
  if (item.status === 'PASS' && item.cleanup.required && !item.cleanup.completed) {
    throw new Error(`${item.id} cannot PASS with required cleanup incomplete`);
  }
  if (item.waiver != null && !(item.gate === 'mandatory' && item.status === 'NOT_RUN')) {
    throw new Error(`${item.id} waivers are allowed only for mandatory NOT_RUN evidence`);
  }
  normalizeWaiver(item.waiver, item.id);
  return item;
}

/** Create one immutable, reproducible E-XX evidence item. */
export function createEvidenceItem({
  id,
  gate,
  scope,
  status,
  performed,
  procedure,
  command = null,
  expected,
  actual,
  identity,
  startedAt,
  finishedAt,
  supports = [],
  sideEffects = [],
  cleanup = null,
  waiver = null,
} = {}) {
  const effects = uniqueStrings(sideEffects, 'sideEffects');
  const item = {
    id,
    gate,
    scope,
    status,
    performed,
    procedure,
    command,
    expected,
    actual,
    identity: structuredClone(identity),
    started_at: startedAt,
    finished_at: finishedAt,
    supports: normalizeSupports(supports),
    side_effects: effects,
    cleanup: normalizeCleanup(cleanup, effects),
    waiver: normalizeWaiver(waiver, id),
  };
  validateEvidenceItem(item);
  return deepFreeze(item);
}

function normalizeFinalVerification(value) {
  if (value == null) return null;
  const normalized = {
    verifier: value.verifier,
    performed_at: value.performed_at ?? value.performedAt,
    origin_compared: value.origin_compared ?? value.originCompared,
    normalized_contract_compared:
      value.normalized_contract_compared ?? value.normalizedContractCompared,
    actual_changes_or_outputs_compared:
      value.actual_changes_or_outputs_compared ?? value.actualChangesOrOutputsCompared,
    task_completion_only: value.task_completion_only ?? value.taskCompletionOnly ?? false,
    evidence_ids: [...(value.evidence_ids ?? value.evidenceIds ?? [])],
  };
  assertYamlSchema(normalized, FINAL_VERIFICATION_SCHEMA, {
    name: 'Cruise final verification',
  });
  timestamp(normalized.performed_at, 'final_verification.performed_at');
  return normalized;
}

function validateEvidenceReferences(record) {
  const byId = new Map();
  for (const item of record.items) {
    validateEvidenceItem(item);
    if (byId.has(item.id)) throw new Error(`duplicate evidence ID ${item.id}`);
    byId.set(item.id, item);
  }
  for (const item of record.items) {
    for (const id of item.waiver?.compensating_evidence_ids ?? []) {
      const supporting = byId.get(id);
      if (!supporting) throw new Error(`${item.id} waiver references missing evidence ${id}`);
      if (supporting.status !== 'PASS' || !supporting.performed) {
        throw new Error(`${item.id} waiver compensating evidence ${id} must be an actual PASS`);
      }
    }
  }
  for (const id of record.final_verification?.evidence_ids ?? []) {
    const item = byId.get(id);
    if (!item) throw new Error(`final verification references missing evidence ${id}`);
    if (item.scope !== 'final_verification' || item.gate !== 'mandatory') {
      throw new Error(
        `final verification evidence ${id} must be mandatory and scoped final_verification`,
      );
    }
  }
  return byId;
}

/**
 * Derive the only truthful completion outcome from evidence. Task completion
 * cannot finalize a run: a separate mandatory final-verification E-XX is required.
 */
export function determineCompletion(record) {
  assertYamlSchema(record, EVIDENCE_RECORD_SCHEMA, { name: 'Cruise evidence record' });
  const byId = validateEvidenceReferences(record);
  if (record.final_verification == null) {
    return deepFreeze({
      outcome: 'active',
      reasons: ['final verification has not been recorded'],
      mandatory_evidence_ids: record.items
        .filter((item) => item.gate === 'mandatory')
        .map((item) => item.id),
      waived_evidence_ids: [],
      final_evidence_ids: [],
    });
  }

  const final = record.final_verification;
  const reasons = [];
  if (!final.origin_compared) reasons.push('final verifier did not compare the immutable origin');
  if (!final.normalized_contract_compared) {
    reasons.push('final verifier did not compare the normalized contract');
  }
  if (!final.actual_changes_or_outputs_compared) {
    reasons.push('final verifier did not compare actual changes or outputs');
  }
  if (final.task_completion_only) {
    reasons.push('final determination relied only on task completion');
  }

  const mandatory = record.items.filter((item) => item.gate === 'mandatory');
  if (mandatory.length === 0) reasons.push('no mandatory evidence was defined');
  const waived = [];
  for (const item of mandatory) {
    if (item.status === 'BLOCK') reasons.push(`${item.id} is BLOCK`);
    if (item.status === 'NOT_RUN') {
      if (item.waiver == null) reasons.push(`${item.id} is mandatory NOT_RUN without a waiver`);
      else waived.push(item.id);
    }
  }
  for (const id of final.evidence_ids) {
    const item = byId.get(id);
    if (item.status === 'BLOCK') reasons.push(`${id} final verification is BLOCK`);
    if (item.status === 'NOT_RUN' && item.waiver == null) {
      reasons.push(`${id} final verification is NOT_RUN without a waiver`);
    }
  }

  return deepFreeze({
    outcome: reasons.length > 0
      ? 'blocked'
      : waived.length > 0
        ? 'completed_waiver_qualified'
        : 'completed',
    reasons,
    mandatory_evidence_ids: mandatory.map((item) => item.id),
    waived_evidence_ids: waived,
    final_evidence_ids: [...final.evidence_ids],
  });
}

export function validateEvidenceRecord(record) {
  assertYamlSchema(record, EVIDENCE_RECORD_SCHEMA, { name: 'Cruise evidence record' });
  timestamp(record.recorded_at, 'recorded_at');
  if (record.determined_at != null) timestamp(record.determined_at, 'determined_at');
  const determination = determineCompletion(record);
  if (record.outcome !== determination.outcome) {
    throw new Error(
      `claimed evidence outcome ${record.outcome} contradicts derived ${determination.outcome}`,
    );
  }
  if (record.outcome === 'active' && record.determined_at != null) {
    throw new Error('active evidence records must not set determined_at');
  }
  if (record.outcome !== 'active') {
    if (record.determined_at == null) throw new Error('final evidence records require determined_at');
    if (record.determined_at !== record.final_verification.performed_at) {
      throw new Error('determined_at must equal final_verification.performed_at');
    }
  }
  return record;
}

/** Create an active record, or derive a final outcome when finalVerification is supplied. */
export function createEvidenceRecord({
  runId,
  recordedAt,
  items = [],
  finalVerification = null,
} = {}) {
  const normalizedItems = items.map((item) => structuredClone(item));
  normalizedItems.forEach(validateEvidenceItem);
  const final = normalizeFinalVerification(finalVerification);
  const draft = {
    schema_version: 1,
    kind: 'cruise_evidence_record',
    run_id: runId,
    recorded_at: recordedAt,
    outcome: 'active',
    determined_at: null,
    items: normalizedItems,
    final_verification: final,
  };
  assertYamlSchema(draft, EVIDENCE_RECORD_SCHEMA, { name: 'Cruise evidence record' });
  timestamp(recordedAt, 'recordedAt');
  const determination = determineCompletion(draft);
  draft.outcome = determination.outcome;
  draft.determined_at = determination.outcome === 'active' ? null : final.performed_at;
  validateEvidenceRecord(draft);
  return deepFreeze(draft);
}

export function finalizeEvidenceRecord(record, finalVerification) {
  validateEvidenceRecord(record);
  if (record.outcome !== 'active') throw new Error('evidence record is already final');
  return createEvidenceRecord({
    runId: record.run_id,
    recordedAt: record.recorded_at,
    items: record.items,
    finalVerification,
  });
}

export function evidenceDigest(record) {
  validateEvidenceRecord(record);
  return createHash('sha256').update(canonicalJson(record), 'utf8').digest('hex');
}
