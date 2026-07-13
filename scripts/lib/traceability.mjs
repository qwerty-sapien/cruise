import { createHash } from 'node:crypto';

import { validateOriginRecord } from './origin.mjs';
import { canonicalJson } from './yaml-state.mjs';

export const TRACE_PREFIXES = Object.freeze(['G', 'R', 'AC', 'D', 'T', 'E', 'F', 'H']);
export const TRACE_ID_PATTERN = /^(G|R|AC|D|T|E|F|H)-(\d{2,})$/u;

const COLLECTIONS = Object.freeze({
  goal_clauses: Object.freeze({ prefix: 'G', idField: 'id' }),
  requirements: Object.freeze({ prefix: 'R', idField: 'id' }),
  acceptance_criteria: Object.freeze({ prefix: 'AC', idField: 'id' }),
  decisions: Object.freeze({ prefix: 'D', idField: 'id' }),
  tasks: Object.freeze({ prefix: 'T', idField: 'task_id' }),
  evidence: Object.freeze({ prefix: 'E', idField: 'id' }),
  findings: Object.freeze({ prefix: 'F', idField: 'id' }),
  hypotheses: Object.freeze({ prefix: 'H', idField: 'id' }),
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function assertPrefix(prefix) {
  const normalized = String(prefix ?? '').toUpperCase();
  if (!TRACE_PREFIXES.includes(normalized)) {
    throw new TypeError(`traceability prefix must be one of ${TRACE_PREFIXES.join(', ')}`);
  }
  return normalized;
}

export function parseTraceId(value) {
  const id = String(value ?? '');
  const match = TRACE_ID_PATTERN.exec(id);
  if (!match) throw new TypeError(`invalid Cruise traceability ID: ${id || '<empty>'}`);
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) {
    throw new TypeError(`traceability ID number exceeds the safe integer range: ${id}`);
  }
  return Object.freeze({ id, prefix: match[1], number });
}

export function isTraceId(value, expectedPrefix = null) {
  const match = TRACE_ID_PATTERN.exec(String(value ?? ''));
  if (!match) return false;
  return expectedPrefix == null || match[1] === String(expectedPrefix).toUpperCase();
}

function idsFromInput(existing) {
  if (existing == null) return [];
  if (Array.isArray(existing) || existing instanceof Set) {
    return [...existing].map((item) => typeof item === 'string' ? item : item?.id ?? item?.task_id);
  }
  if (typeof existing === 'object') {
    const ids = [];
    for (const [collection, config] of Object.entries(COLLECTIONS)) {
      for (const item of existing[collection] ?? []) ids.push(item?.[config.idField] ?? item);
    }
    return ids;
  }
  throw new TypeError('existing IDs must be an iterable or traceability record');
}

/** Allocate monotonically after the highest existing number; never fill deleted gaps. */
export function allocateStableId(prefix, existing = []) {
  const normalized = assertPrefix(prefix);
  let highest = 0;
  for (const value of idsFromInput(existing)) {
    if (value == null) continue;
    const parsed = parseTraceId(value);
    if (parsed.prefix === normalized) highest = Math.max(highest, parsed.number);
  }
  return `${normalized}-${String(highest + 1).padStart(2, '0')}`;
}

function normalizeReferences(values, allowedPrefixes, field) {
  if (!Array.isArray(values)) throw new TypeError(`${field} must be an array`);
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const parsed = parseTraceId(value);
    if (!allowedPrefixes.includes(parsed.prefix)) {
      throw new TypeError(
        `${field} may reference only ${allowedPrefixes.join('/')} IDs, got ${parsed.id}`,
      );
    }
    if (!seen.has(parsed.id)) {
      seen.add(parsed.id);
      result.push(parsed.id);
    }
  }
  return result;
}

export function createTaskTrace({
  taskId,
  satisfies,
  preserves,
  verification,
  ...details
} = {}) {
  if (!isTraceId(taskId, 'T')) throw new TypeError('taskId must be a T-XX ID');
  const task = {
    ...structuredClone(details),
    task_id: taskId,
    satisfies: normalizeReferences(satisfies, ['R', 'AC'], 'satisfies'),
    preserves: normalizeReferences(preserves, ['G', 'R'], 'preserves'),
    verification: normalizeReferences(verification, ['E'], 'verification'),
  };
  if (task.satisfies.length === 0) throw new Error(`${taskId} must satisfy at least one R/AC ID`);
  if (task.preserves.length === 0) throw new Error(`${taskId} must preserve at least one G/R ID`);
  if (task.verification.length === 0) throw new Error(`${taskId} must name verification evidence`);
  return deepFreeze(task);
}

function normalizeItem(item, config, collection) {
  if (typeof item === 'string') return { [config.idField]: item };
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new TypeError(`${collection} entries must be objects or IDs`);
  }
  return structuredClone(item);
}

export function createTraceabilityRecord(initial = {}) {
  const record = { schema_version: 1 };
  for (const [collection, config] of Object.entries(COLLECTIONS)) {
    const values = initial[collection] ?? [];
    if (!Array.isArray(values)) throw new TypeError(`${collection} must be an array`);
    record[collection] = values.map((item) => normalizeItem(item, config, collection));
  }
  validateTraceability(record);
  return deepFreeze(record);
}

function collectIds(record) {
  const ids = new Map();
  for (const [collection, config] of Object.entries(COLLECTIONS)) {
    const values = record[collection];
    if (!Array.isArray(values)) throw new TypeError(`${collection} must be an array`);
    for (const [index, item] of values.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new TypeError(`${collection}[${index}] must be an object`);
      }
      const id = item[config.idField];
      if (!isTraceId(id, config.prefix)) {
        throw new TypeError(
          `${collection}[${index}].${config.idField} must be a ${config.prefix}-XX ID`,
        );
      }
      if (ids.has(id)) {
        throw new Error(`duplicate traceability ID ${id} in ${collection} and ${ids.get(id)}`);
      }
      ids.set(id, collection);
    }
  }
  return ids;
}

function assertReferencesExist(task, ids) {
  const groups = [
    ['satisfies', ['R', 'AC']],
    ['preserves', ['G', 'R']],
    ['verification', ['E']],
  ];
  for (const [field, prefixes] of groups) {
    const references = normalizeReferences(task[field], prefixes, `${task.task_id}.${field}`);
    if (references.length === 0) throw new Error(`${task.task_id}.${field} must not be empty`);
    if (references.length !== task[field].length) {
      throw new Error(`${task.task_id}.${field} must not contain duplicate IDs`);
    }
    for (const reference of references) {
      if (!ids.has(reference)) {
        throw new Error(`${task.task_id}.${field} references missing ${reference}`);
      }
    }
  }
}

/** Validate prefixes, global uniqueness, task shape, and every task edge. */
export function validateTraceability(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('traceability record must be an object');
  }
  if (record.schema_version !== 1) throw new Error('traceability schema_version must be 1');
  const ids = collectIds(record);
  for (const task of record.tasks) assertReferencesExist(task, ids);
  return record;
}

function idSet(record) {
  return new Set(collectIds(record).keys());
}

/** Existing IDs may gain detail but cannot disappear, move, or be renumbered. */
export function assertStableTraceability(previous, next) {
  validateTraceability(previous);
  validateTraceability(next);
  const after = idSet(next);
  for (const id of idSet(previous)) {
    if (!after.has(id)) throw new Error(`stable traceability ID disappeared or was renumbered: ${id}`);
  }
  return true;
}

export function traceabilityCoverage(record) {
  validateTraceability(record);
  const satisfies = new Set(record.tasks.flatMap((task) => task.satisfies));
  const preserves = new Set(record.tasks.flatMap((task) => task.preserves));
  const verification = new Set(record.tasks.flatMap((task) => task.verification));
  const ids = (collection, field = 'id') => record[collection].map((item) => item[field]);
  return deepFreeze({
    uncovered_goal_clauses: ids('goal_clauses').filter((id) => !preserves.has(id)),
    uncovered_requirements: ids('requirements').filter(
      (id) => !satisfies.has(id) && !preserves.has(id),
    ),
    uncovered_acceptance_criteria: ids('acceptance_criteria').filter(
      (id) => !satisfies.has(id),
    ),
    unused_evidence: ids('evidence').filter((id) => !verification.has(id)),
  });
}

function clauseDigest(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('hex');
}

/** Enumerate every immutable/raw and normalized clause that final work must represent. */
export function originClauses(originRecord) {
  validateOriginRecord(originRecord);
  const clauses = [{
    origin_path: 'origin.raw_prompt',
    value_sha256: clauseDigest(originRecord.origin.raw_prompt),
  }];
  if (originRecord.goal.outcome !== '') {
    clauses.push({
      origin_path: 'goal.outcome',
      value_sha256: clauseDigest(originRecord.goal.outcome),
    });
  }
  for (const field of [
    'non_negotiables',
    'success_criteria',
    'exclusions',
    'permitted_inferences',
    'unresolved_questions',
  ]) {
    for (const [index, value] of originRecord.goal[field].entries()) {
      clauses.push({
        origin_path: `goal.${field}[${index}]`,
        value_sha256: clauseDigest(value),
      });
    }
  }
  return deepFreeze(clauses);
}

/** Prove structural coverage of every raw/normalized Origin path and digest.
 * Semantic adequacy of each mapped trace clause remains an independent-verifier duty.
 */
export function assertOriginCoverage(originRecord, record, mappings) {
  validateOriginRecord(originRecord);
  validateTraceability(record);
  if (!Array.isArray(mappings)) throw new TypeError('origin mappings must be an array');
  const availableIds = idSet(record);
  const byPath = new Map();
  for (const mapping of mappings) {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      throw new TypeError('origin mapping entries must be objects');
    }
    if (typeof mapping.origin_path !== 'string' || !mapping.origin_path) {
      throw new TypeError('origin mapping requires origin_path');
    }
    if (byPath.has(mapping.origin_path)) {
      throw new Error(`duplicate origin mapping: ${mapping.origin_path}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(String(mapping.value_sha256 ?? ''))) {
      throw new TypeError(`${mapping.origin_path} mapping requires a SHA-256 value digest`);
    }
    if (!Array.isArray(mapping.trace_ids) || mapping.trace_ids.length === 0) {
      throw new Error(`${mapping.origin_path} mapping must name at least one traceability ID`);
    }
    for (const id of mapping.trace_ids) {
      const parsed = parseTraceId(id);
      if (!['G', 'R', 'AC', 'D'].includes(parsed.prefix)) {
        throw new TypeError(`${mapping.origin_path} may map only to G/R/AC/D IDs`);
      }
      if (!availableIds.has(id)) {
        throw new Error(`${mapping.origin_path} references missing traceability ID ${id}`);
      }
    }
    byPath.set(mapping.origin_path, mapping);
  }
  const missing = [];
  for (const clause of originClauses(originRecord)) {
    const mapping = byPath.get(clause.origin_path);
    if (!mapping) {
      missing.push(clause.origin_path);
    } else if (mapping.value_sha256 !== clause.value_sha256) {
      throw new Error(`origin mapping digest is stale or rewritten: ${clause.origin_path}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`final verification omitted origin clause(s): ${missing.join(', ')}`);
  }
  return true;
}

/** Final traceability cannot be certified by completed task boxes alone. */
export function assertFinalTraceability(
  record,
  {
    requireGoalPreservation = true,
    allowUnusedEvidence = true,
    originRecord = null,
    originMappings = null,
  } = {},
) {
  const coverage = traceabilityCoverage(record);
  const errors = [];
  if (requireGoalPreservation && coverage.uncovered_goal_clauses.length > 0) {
    errors.push(`unpreserved goals: ${coverage.uncovered_goal_clauses.join(', ')}`);
  }
  if (coverage.uncovered_requirements.length > 0) {
    errors.push(`uncovered requirements: ${coverage.uncovered_requirements.join(', ')}`);
  }
  if (coverage.uncovered_acceptance_criteria.length > 0) {
    errors.push(`uncovered acceptance criteria: ${coverage.uncovered_acceptance_criteria.join(', ')}`);
  }
  if (!allowUnusedEvidence && coverage.unused_evidence.length > 0) {
    errors.push(`unused evidence: ${coverage.unused_evidence.join(', ')}`);
  }
  if (record.tasks.length === 0 && (
    record.requirements.length > 0 || record.acceptance_criteria.length > 0
  )) {
    errors.push('requirements exist but no implementation tasks are traceable');
  }
  if (errors.length > 0) throw new Error(`final traceability incomplete: ${errors.join('; ')}`);
  if (originRecord != null) assertOriginCoverage(originRecord, record, originMappings);
  return coverage;
}

export function traceabilityDigest(record) {
  validateTraceability(record);
  return createHash('sha256').update(canonicalJson(record), 'utf8').digest('hex');
}
