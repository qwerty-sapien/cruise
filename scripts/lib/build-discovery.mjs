import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { captureRepositoryBaseline } from './goal-contract.mjs';
import { scanBuildIdentifiers, validateBuildIdRegistry } from './build-history.mjs';
import { validateOriginRecord } from './origin.mjs';
import { validateBuildDraftSemantics } from './build-contract.mjs';
import { canonicalJson, parseYaml, stringifyYaml } from './yaml-state.mjs';

export const DISCOVERY_READINESS_CATEGORIES = Object.freeze([
  'problem_or_opportunity',
  'beneficiary',
  'meaningful_value',
  'scope_coherence',
  'plausible_implementation_path',
  'feasibility',
  'measurable_completion',
  'constraints_and_resources',
  'differentiation_or_necessity',
  'security_and_external_effects',
]);

export const DISCOVERY_CRITICAL_READINESS_CATEGORIES = Object.freeze([
  'problem_or_opportunity',
  'beneficiary',
  'meaningful_value',
  'scope_coherence',
  'plausible_implementation_path',
  'feasibility',
  'measurable_completion',
]);

export const DISCOVERY_VIABILITY_GATES = Object.freeze([
  'beneficiary_identified',
  'meaningful_outcome',
  'coherent_scope',
  'plausible_implementation',
  'verifiable_completion',
  'constraints_compatible',
  'no_fatal_contradiction',
]);

export const DISCOVERY_OUTCOMES = Object.freeze([
  'ready_for_build',
  'user_decision_required',
  'research_required',
  'not_currently_viable',
  'deferred',
]);

export const DISCOVERY_RESEARCH_CLASSES = Object.freeze([
  'pre_approval_blocker',
  'post_approval_prerequisite',
]);

export const DISCOVERY_STATUSES = Object.freeze([
  'waiting_user_decision',
  'question_resolved',
  'research_required',
  'waiting_research_approval',
  'research_in_progress',
  'ready_for_build',
  'draft_ready_for_review',
  'not_currently_viable',
  'deferred',
]);

const SHA256 = /^[a-f0-9]{64}$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PROJECT_ID = /^PRJ-\d{2,}$/u;
const MILESTONE_ID = /^M-\d{2,}$/u;
const CONCEPT_ID = /^C-\d{2,}$/u;
const QUESTION_ID = /^Q-\d{2,}$/u;
const EVIDENCE_ID = /^E-\d{2,}$/u;
const RESEARCH_ID = /^DR-\d{2,}$/u;
const REQUIREMENT_ID = /^R-\d{2,}$/u;
const ACCEPTANCE_ID = /^AC-\d{2,}$/u;
const DECISION_ID = /^D-\d{2,}$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const READINESS_STATUSES = new Set(['clear', 'partial', 'missing', 'conflicting']);
const VIABILITY_GATE_STATUSES = new Set(['pass', 'fail', 'research_needed']);
const CONCEPT_STATUSES = new Set(['active', 'rejected', 'merged', 'deferred', 'selected']);
const QUESTION_STATUSES = new Set(['open', 'answered', 'assumed', 'deferred', 'superseded']);
const QUESTION_MATERIALITIES = new Set([
  'project_blocking',
  'milestone_blocking',
  'phase_blocking',
  'nonblocking',
]);
const EVIDENCE_TYPES = new Set([
  'repository_observation',
  'user_statement',
  'research_finding',
  'prior_cruise_artifact',
  'external_context',
]);
const EVIDENCE_CERTAINTIES = new Set([
  'observed',
  'inferred',
  'speculative',
  'contradicted',
]);
const CONSEQUENCE_THRESHOLDS = Object.freeze({ low: 0.6, medium: 0.75, high: 0.85 });
const RUNS = new WeakSet();
const RESUME_ATTESTATIONS = new WeakSet();
const CONSUMED_RESUME_ATTESTATIONS = new WeakSet();
const RESEARCH_APPROVALS = new WeakSet();
const CONSUMED_RESEARCH_APPROVALS = new WeakSet();
const RESEARCH_RESULTS = new WeakSet();
const CONSUMED_RESEARCH_RESULTS = new WeakSet();
const DRAFT_AUTHORITIES = new WeakSet();
const CONSUMED_DRAFT_AUTHORITIES = new WeakSet();

const REQUIRED_DISCOVERY_HEADINGS = Object.freeze([
  'What was explored',
  'Selected concept',
  'Why it matters',
  'Why it is feasible',
  'Major alternatives considered',
  'Rejected alternatives and reasons',
  'Unresolved phase-local issues',
  'Research dependencies',
  'Recommended Build transition',
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function digest(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

function objectDigest(value) {
  return digest(canonicalJson(value));
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function timestamp(value, label) {
  const supplied = typeof value === 'function' ? value() : value;
  const date = supplied == null ? new Date() : supplied instanceof Date ? supplied : new Date(supplied);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${label} must be a valid date-time`);
  const normalized = date.toISOString();
  if (!RFC3339.test(normalized)) throw new TypeError(`${label} must be an RFC3339 timestamp`);
  return normalized;
}

function exactKeys(value, keys, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} fields must be exactly: ${expected.join(', ')}`);
  }
}

function uniqueStrings(value, label, { allowEmpty = true, pattern = null } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
  }
  const result = [];
  const seen = new Set();
  for (const entry of value) {
    const text = nonEmpty(entry, `${label} entry`);
    if (pattern && !pattern.test(text)) throw new TypeError(`${label} contains invalid identifier ${text}`);
    if (seen.has(text)) throw new Error(`${label} must not contain duplicate values`);
    seen.add(text);
    result.push(text);
  }
  return result;
}

function exactStringSets(left, right) {
  return canonicalJson([...left].sort()) === canonicalJson([...right].sort());
}

function normalizedStatusForOutcome(outcome) {
  return {
    ready_for_build: 'ready_for_build',
    user_decision_required: 'waiting_user_decision',
    research_required: 'research_required',
    not_currently_viable: 'not_currently_viable',
    deferred: 'deferred',
  }[outcome];
}

function evidenceIds(document) {
  return new Set(document.evidence.map(({ id }) => id));
}

function validateEvidenceCitationList(values, label, availableEvidence, { allowEmpty = true } = {}) {
  const ids = uniqueStrings(values, label, { allowEmpty, pattern: EVIDENCE_ID });
  for (const id of ids) {
    if (!availableEvidence.has(id)) throw new Error(`${label} references unknown evidence ${id}`);
  }
  return ids;
}

/** Strict validator for the persistent discovery EVIDENCE.yaml document. */
export function validateDiscoveryEvidence(document, { runId = null, originSha256 = null } = {}) {
  exactKeys(
    document,
    ['schema_version', 'kind', 'run_id', 'origin_sha256', 'evidence'],
    'discovery evidence document',
  );
  if (document.schema_version !== 1 || document.kind !== 'cruise_build_discovery_evidence') {
    throw new Error('discovery EVIDENCE.yaml must use schema version 1 and its canonical kind');
  }
  if (!RUN_ID.test(document.run_id)) throw new TypeError('discovery evidence run_id is invalid');
  assertDigest(document.origin_sha256, 'discovery evidence origin_sha256');
  if (runId != null && document.run_id !== runId) throw new Error('discovery evidence belongs to another Build run');
  if (originSha256 != null && document.origin_sha256 !== originSha256) {
    throw new Error('discovery evidence does not match the immutable Origin digest');
  }
  if (!Array.isArray(document.evidence)) throw new TypeError('discovery evidence must be an array');
  const seen = new Set();
  let priorNumber = 0;
  for (const [index, item] of document.evidence.entries()) {
    const label = `discovery evidence[${index}]`;
    exactKeys(
      item,
      [
        'id',
        'type',
        'source',
        'claim',
        'certainty',
        'supports',
        'research_item_id',
        'captured_at',
        'source_sha256',
      ],
      label,
    );
    if (!EVIDENCE_ID.test(item.id)) throw new TypeError(`${label}.id must be an E-XX ID`);
    const number = Number(item.id.slice(2));
    if (seen.has(item.id) || number <= priorNumber) {
      throw new Error('discovery evidence IDs must be unique and monotonically increasing');
    }
    seen.add(item.id);
    priorNumber = number;
    if (!EVIDENCE_TYPES.has(item.type)) throw new TypeError(`${label}.type is unsupported`);
    nonEmpty(item.source, `${label}.source`);
    nonEmpty(item.claim, `${label}.claim`);
    if (!EVIDENCE_CERTAINTIES.has(item.certainty)) {
      throw new TypeError(`${label}.certainty is unsupported`);
    }
    uniqueStrings(item.supports, `${label}.supports`, { allowEmpty: false });
    if (item.research_item_id !== null && !RESEARCH_ID.test(item.research_item_id)) {
      throw new TypeError(`${label}.research_item_id must be null or a DR-XX ID`);
    }
    if (item.type === 'research_finding' && item.research_item_id === null) {
      throw new Error(`${label} research findings must name their pre-approval research item`);
    }
    timestamp(item.captured_at, `${label}.captured_at`);
    assertDigest(item.source_sha256, `${label}.source_sha256`);
  }
  return deepFreeze(clone(document));
}

function validateConcept(item, index) {
  const label = `concepts[${index}]`;
  exactKeys(
    item,
    [
      'id',
      'title',
      'outcome',
      'beneficiary',
      'problem_or_opportunity',
      'proposed_capabilities',
      'non_goals',
      'value',
      'implementation_outline',
      'verification_outline',
      'dependencies',
      'risks',
      'assumptions',
      'research_questions',
      'viability',
      'status',
      'lineage',
      'status_reason',
    ],
    label,
  );
  if (!CONCEPT_ID.test(item.id)) throw new TypeError(`${label}.id must be a C-XX ID`);
  for (const key of ['title', 'outcome', 'beneficiary', 'problem_or_opportunity']) {
    if (typeof item[key] !== 'string') throw new TypeError(`${label}.${key} must be a string`);
  }
  for (const key of [
    'proposed_capabilities',
    'non_goals',
    'value',
    'implementation_outline',
    'verification_outline',
    'dependencies',
    'risks',
    'assumptions',
    'research_questions',
  ]) {
    uniqueStrings(item[key], `${label}.${key}`);
  }
  if (typeof item.viability !== 'string') throw new TypeError(`${label}.viability must be a string`);
  if (!CONCEPT_STATUSES.has(item.status)) throw new TypeError(`${label}.status is unsupported`);
  exactKeys(item.lineage, ['derived_from', 'merged_into'], `${label}.lineage`);
  uniqueStrings(item.lineage.derived_from, `${label}.lineage.derived_from`, { pattern: CONCEPT_ID });
  if (item.lineage.merged_into !== null && !CONCEPT_ID.test(item.lineage.merged_into)) {
    throw new TypeError(`${label}.lineage.merged_into must be null or a C-XX ID`);
  }
  if (item.status === 'merged' && item.lineage.merged_into === null) {
    throw new Error(`${label} merged concepts must name their successor`);
  }
  if (item.status !== 'merged' && item.lineage.merged_into !== null) {
    throw new Error(`${label}.lineage.merged_into is allowed only for merged concepts`);
  }
  if (item.status === 'rejected' || item.status === 'merged' || item.status === 'deferred') {
    nonEmpty(item.status_reason, `${label}.status_reason`);
  } else if (item.status_reason !== null && typeof item.status_reason !== 'string') {
    throw new TypeError(`${label}.status_reason must be null or a string`);
  }
  return clone(item);
}

/** Strict validator for persistent CONCEPTS.yaml and selected/rejected lineage. */
export function validateDiscoveryConcepts(
  document,
  { runId = null, originSha256 = null, viabilityOutcome = null } = {},
) {
  exactKeys(
    document,
    ['schema_version', 'kind', 'run_id', 'origin_sha256', 'selected_concept_id', 'concepts'],
    'discovery concepts document',
  );
  if (document.schema_version !== 1 || document.kind !== 'cruise_build_discovery_concepts') {
    throw new Error('CONCEPTS.yaml must use schema version 1 and its canonical kind');
  }
  if (!RUN_ID.test(document.run_id)) throw new TypeError('CONCEPTS.yaml run_id is invalid');
  assertDigest(document.origin_sha256, 'CONCEPTS.yaml origin_sha256');
  if (runId != null && document.run_id !== runId) throw new Error('CONCEPTS.yaml belongs to another Build run');
  if (originSha256 != null && document.origin_sha256 !== originSha256) {
    throw new Error('CONCEPTS.yaml does not match the immutable Origin digest');
  }
  if (!Array.isArray(document.concepts) || document.concepts.length === 0) {
    throw new TypeError('CONCEPTS.yaml must contain at least one candidate concept');
  }
  const concepts = document.concepts.map(validateConcept);
  const byId = new Map();
  for (const concept of concepts) {
    if (byId.has(concept.id)) throw new Error(`duplicate concept ID ${concept.id}`);
    byId.set(concept.id, concept);
  }
  for (const concept of concepts) {
    for (const parent of concept.lineage.derived_from) {
      if (!byId.has(parent) || parent === concept.id) {
        throw new Error(`${concept.id} has invalid derived_from lineage ${parent}`);
      }
    }
    if (concept.lineage.merged_into != null && !byId.has(concept.lineage.merged_into)) {
      throw new Error(`${concept.id} merges into unknown concept ${concept.lineage.merged_into}`);
    }
  }
  const selected = concepts.filter(({ status }) => status === 'selected');
  if (document.selected_concept_id === null) {
    if (selected.length > 0) throw new Error('selected status requires selected_concept_id');
  } else {
    if (!CONCEPT_ID.test(document.selected_concept_id)) {
      throw new TypeError('selected_concept_id must be null or a C-XX ID');
    }
    if (selected.length !== 1 || selected[0].id !== document.selected_concept_id) {
      throw new Error('selected_concept_id must identify the only selected concept');
    }
  }
  if (viabilityOutcome === 'ready_for_build') {
    if (selected.length !== 1) throw new Error('ready_for_build requires exactly one selected concept');
    const selectedConcept = selected[0];
    for (const key of [
      'title',
      'outcome',
      'beneficiary',
      'problem_or_opportunity',
    ]) nonEmpty(selectedConcept[key], `selected concept ${selectedConcept.id}.${key}`);
    for (const key of ['value', 'implementation_outline', 'verification_outline']) {
      uniqueStrings(selectedConcept[key], `selected concept ${selectedConcept.id}.${key}`, {
        allowEmpty: false,
      });
    }
    const unresolvedAlternatives = concepts.filter(
      ({ id, status }) => id !== selectedConcept.id && !['rejected', 'merged', 'deferred'].includes(status),
    );
    if (unresolvedAlternatives.length > 0) {
      throw new Error(
        `ready_for_build must preserve a disposition for every alternative: ${unresolvedAlternatives.map(({ id }) => id).join(', ')}`,
      );
    }
  }
  return deepFreeze({ ...clone(document), concepts });
}

/** Validate the discovery QUESTIONS.yaml protocol, including one material question at a time. */
export function validateDiscoveryQuestions(
  document,
  { runId = null, originSha256 = null, evidence = null } = {},
) {
  exactKeys(
    document,
    ['schema_version', 'kind', 'run_id', 'origin_sha256', 'questions'],
    'discovery questions document',
  );
  if (document.schema_version !== 1 || document.kind !== 'cruise_build_discovery_questions') {
    throw new Error('QUESTIONS.yaml must use schema version 1 and its canonical discovery kind');
  }
  if (!RUN_ID.test(document.run_id)) throw new TypeError('QUESTIONS.yaml run_id is invalid');
  assertDigest(document.origin_sha256, 'QUESTIONS.yaml origin_sha256');
  if (runId != null && document.run_id !== runId) throw new Error('QUESTIONS.yaml belongs to another Build run');
  if (originSha256 != null && document.origin_sha256 !== originSha256) {
    throw new Error('QUESTIONS.yaml does not match the immutable Origin digest');
  }
  const availableEvidence = evidence == null
    ? null
    : evidenceIds(validateDiscoveryEvidence(evidence, { runId, originSha256 }));
  if (!Array.isArray(document.questions)) throw new TypeError('QUESTIONS.yaml questions must be an array');
  const questions = [];
  const seenIds = new Set();
  const seenPrompts = new Set();
  let priorNumber = 0;
  for (const [index, item] of document.questions.entries()) {
    const label = `questions[${index}]`;
    exactKeys(
      item,
      [
        'id',
        'status',
        'materiality',
        'category',
        'question',
        'evidence',
        'recommendation',
        'options',
        'answer',
        'answer_source',
        'affects',
        'asked_at',
        'answered_at',
        'reopening_trigger',
      ],
      label,
    );
    if (!QUESTION_ID.test(item.id)) throw new TypeError(`${label}.id must be Q-XX`);
    const number = Number(item.id.slice(2));
    if (seenIds.has(item.id) || number <= priorNumber) {
      throw new Error('question IDs must be unique and monotonically increasing');
    }
    seenIds.add(item.id);
    priorNumber = number;
    if (!QUESTION_STATUSES.has(item.status)) throw new TypeError(`${label}.status is unsupported`);
    if (!QUESTION_MATERIALITIES.has(item.materiality)) {
      throw new TypeError(`${label}.materiality is unsupported`);
    }
    nonEmpty(item.category, `${label}.category`);
    const prompt = nonEmpty(item.question, `${label}.question`);
    const normalizedPrompt = prompt.toLocaleLowerCase('en').replace(/\s+/gu, ' ');
    if (seenPrompts.has(normalizedPrompt)) {
      throw new Error('the same discovery question must retain its stable Q-XX ID');
    }
    seenPrompts.add(normalizedPrompt);
    const citations = uniqueStrings(item.evidence, `${label}.evidence`, { pattern: EVIDENCE_ID });
    if (availableEvidence) {
      for (const id of citations) {
        if (!availableEvidence.has(id)) throw new Error(`${label}.evidence references unknown ${id}`);
      }
    }
    if (typeof item.recommendation !== 'string') {
      throw new TypeError(`${label}.recommendation must be a string`);
    }
    const options = uniqueStrings(item.options, `${label}.options`);
    if (options.length === 1 || options.length > 3) {
      throw new Error(`${label}.options must contain zero, two, or three concrete options`);
    }
    const affects = uniqueStrings(item.affects, `${label}.affects`, { allowEmpty: false });
    void affects;
    if (item.asked_at !== null) timestamp(item.asked_at, `${label}.asked_at`);
    if (item.answered_at !== null) timestamp(item.answered_at, `${label}.answered_at`);
    if (item.reopening_trigger !== null) nonEmpty(item.reopening_trigger, `${label}.reopening_trigger`);
    if (item.status === 'open') {
      if (item.answer !== null || item.answer_source !== null || item.answered_at !== null) {
        throw new Error(`${label} open question cannot contain an answer`);
      }
      if (item.asked_at === null) throw new Error(`${label} open question must record asked_at`);
    } else if (['answered', 'assumed', 'deferred'].includes(item.status)) {
      nonEmpty(item.answer, `${label}.answer`);
      nonEmpty(item.answer_source, `${label}.answer_source`);
      if (item.asked_at === null || item.answered_at === null) {
        throw new Error(`${label} resolved/deferred question must preserve both timestamps`);
      }
      if (Date.parse(item.answered_at) < Date.parse(item.asked_at)) {
        throw new Error(`${label}.answered_at cannot precede asked_at`);
      }
    } else if (item.answer !== null || item.answer_source !== null || item.answered_at !== null) {
      throw new Error(`${label} ${item.status} question cannot claim an answer`);
    }
    questions.push(clone(item));
  }
  if (questions.filter(({ status }) => status === 'open').length > 1) {
    throw new Error('discovery asks exactly one material question at a time');
  }
  return deepFreeze({ ...clone(document), questions });
}

function decisionBlocks(markdown) {
  const matches = [...markdown.matchAll(
    /^##\s+(D-\d{2,})(?:\s+[-—:]\s+.*)?\s*$([\s\S]*?)(?=^##\s+D-\d{2,}|(?![\s\S]))/gmu,
  )];
  return matches.map((match) => {
    const field = (name) => {
      const found = match[2].match(new RegExp(`^${name}:\\s*(.+)$`, 'imu'));
      if (!found) throw new Error(`${match[1]} is missing ${name}: in DECISIONS.md`);
      return found[1].trim();
    };
    return {
      id: match[1],
      status: field('Status'),
      concept_id: field('Concept'),
      decision: field('Decision'),
      evidence: field('Evidence').split(',').map((value) => value.trim()),
      rationale: field('Rationale'),
      tradeoffs: field('Tradeoffs'),
      reopening_trigger: field('Reopening trigger'),
      supersedes: field('Supersedes'),
    };
  });
}

/** Validate stable D-XX decision records and selected/rejected concept tradeoff lineage. */
export function validateDiscoveryDecisions(
  markdown,
  { concepts, evidence, viabilityOutcome = null } = {},
) {
  nonEmpty(markdown, 'discovery DECISIONS.md');
  if (!/^#\s+Discovery Decisions\s*$/mu.test(markdown)) {
    throw new Error('discovery DECISIONS.md must start with # Discovery Decisions');
  }
  const conceptDocument = validateDiscoveryConcepts(concepts, { viabilityOutcome });
  const evidenceDocument = validateDiscoveryEvidence(evidence, {
    runId: conceptDocument.run_id,
    originSha256: conceptDocument.origin_sha256,
  });
  const availableEvidence = evidenceIds(evidenceDocument);
  const availableConcepts = new Set(conceptDocument.concepts.map(({ id }) => id));
  const records = decisionBlocks(markdown);
  const seen = new Set();
  let priorNumber = 0;
  for (const decision of records) {
    const number = Number(decision.id.slice(2));
    if (seen.has(decision.id) || number <= priorNumber) {
      throw new Error('discovery decision IDs must be unique and monotonically increasing');
    }
    seen.add(decision.id);
    priorNumber = number;
    if (!['accepted', 'rejected', 'superseded', 'deferred'].includes(decision.status)) {
      throw new TypeError(`${decision.id} Status must be accepted, rejected, superseded, or deferred`);
    }
    if (!CONCEPT_ID.test(decision.concept_id) || !availableConcepts.has(decision.concept_id)) {
      throw new Error(`${decision.id} references unknown concept ${decision.concept_id}`);
    }
    nonEmpty(decision.decision, `${decision.id} Decision`);
    nonEmpty(decision.rationale, `${decision.id} Rationale`);
    nonEmpty(decision.tradeoffs, `${decision.id} Tradeoffs`);
    nonEmpty(decision.reopening_trigger, `${decision.id} Reopening trigger`);
    for (const id of uniqueStrings(decision.evidence, `${decision.id} Evidence`, {
      allowEmpty: false,
      pattern: EVIDENCE_ID,
    })) {
      if (!availableEvidence.has(id)) throw new Error(`${decision.id} references unknown evidence ${id}`);
    }
    if (decision.supersedes !== 'none' && !DECISION_ID.test(decision.supersedes)) {
      throw new TypeError(`${decision.id} Supersedes must be none or D-XX`);
    }
  }
  if (viabilityOutcome === 'ready_for_build') {
    const selectedId = conceptDocument.selected_concept_id;
    if (!records.some(({ status, concept_id: conceptId }) =>
      status === 'accepted' && conceptId === selectedId)) {
      throw new Error('ready_for_build requires an accepted D-XX decision for the selected concept');
    }
    for (const rejected of conceptDocument.concepts.filter(({ status }) => status === 'rejected')) {
      const decision = records.find(({ status, concept_id: conceptId }) =>
        status === 'rejected' && conceptId === rejected.id);
      if (!decision || !decision.rationale.includes(rejected.status_reason.trim())) {
        throw new Error(`DECISIONS.md must preserve rejected ${rejected.id} and its exact rationale`);
      }
    }
  }
  return deepFreeze({ markdown, decisions: records });
}

function assertEvidenceAppendOnly(previous, next) {
  const prior = validateDiscoveryEvidence(previous);
  const candidate = validateDiscoveryEvidence(next, {
    runId: prior.run_id,
    originSha256: prior.origin_sha256,
  });
  if (candidate.evidence.length < prior.evidence.length) {
    throw new Error('discovery evidence history is append-only and cannot delete E-XX records');
  }
  for (let index = 0; index < prior.evidence.length; index += 1) {
    if (canonicalJson(prior.evidence[index]) !== canonicalJson(candidate.evidence[index])) {
      throw new Error(`discovery evidence history cannot rewrite ${prior.evidence[index].id}`);
    }
  }
  return candidate;
}

function assertConceptLineageTransition(previous, next) {
  const prior = validateDiscoveryConcepts(previous);
  const candidate = validateDiscoveryConcepts(next, {
    runId: prior.run_id,
    originSha256: prior.origin_sha256,
  });
  if (candidate.concepts.length < prior.concepts.length) {
    throw new Error('concept lineage is append-only and cannot delete C-XX history');
  }
  const mutableFields = new Set(['status', 'status_reason', 'viability', 'lineage']);
  for (let index = 0; index < prior.concepts.length; index += 1) {
    const before = prior.concepts[index];
    const after = candidate.concepts[index];
    if (after.id !== before.id) throw new Error(`concept lineage cannot renumber or reorder ${before.id}`);
    for (const key of Object.keys(before)) {
      if (mutableFields.has(key)) continue;
      if (canonicalJson(before[key]) !== canonicalJson(after[key])) {
        throw new Error(`concept lineage cannot rewrite ${before.id}.${key}`);
      }
    }
    if (canonicalJson(before.lineage.derived_from) !== canonicalJson(after.lineage.derived_from)) {
      throw new Error(`concept lineage cannot rewrite ${before.id}.lineage.derived_from`);
    }
    if (before.lineage.merged_into !== after.lineage.merged_into) {
      if (
        before.lineage.merged_into !== null ||
        after.status !== 'merged' ||
        after.lineage.merged_into === before.id
      ) {
        throw new Error(`concept lineage cannot rewrite ${before.id}.lineage.merged_into`);
      }
    }
    if (['rejected', 'merged', 'selected'].includes(before.status) && after.status !== before.status) {
      throw new Error(`terminal concept disposition ${before.id}:${before.status} is immutable`);
    }
    if (
      ['rejected', 'merged', 'selected'].includes(before.status) &&
      before.status_reason !== after.status_reason
    ) {
      throw new Error(`terminal concept disposition reason ${before.id}:${before.status} is immutable`);
    }
    if (before.status !== after.status && !['active', 'deferred'].includes(before.status)) {
      throw new Error(`concept ${before.id} cannot transition from ${before.status} to ${after.status}`);
    }
  }
  return candidate;
}

function assertDecisionHistoryAppendOnly(previousMarkdown, nextMarkdown, context) {
  const prior = validateDiscoveryDecisions(previousMarkdown, context);
  const candidate = validateDiscoveryDecisions(nextMarkdown, context);
  if (candidate.decisions.length < prior.decisions.length) {
    throw new Error('discovery decision history is append-only and cannot delete D-XX records');
  }
  for (let index = 0; index < prior.decisions.length; index += 1) {
    if (canonicalJson(prior.decisions[index]) !== canonicalJson(candidate.decisions[index])) {
      throw new Error(`discovery decision history cannot rewrite ${prior.decisions[index].id}`);
    }
  }
  return candidate;
}

function assertQuestionsUnchanged(previous, next) {
  const prior = validateDiscoveryQuestions(previous);
  const candidate = validateDiscoveryQuestions(next, {
    runId: prior.run_id,
    originSha256: prior.origin_sha256,
  });
  if (canonicalJson(prior) !== canonicalJson(candidate)) {
    throw new Error('question history changes require explicit answer or next-question events');
  }
  return candidate;
}

/** Validate the evidence-backed discovery readiness matrix and return its blockers. */
export function evaluateBuildDiscoveryReadiness(readiness, { evidence } = {}) {
  const evidenceDocument = validateDiscoveryEvidence(evidence);
  exactKeys(
    readiness,
    [
      'mode_candidate',
      ...DISCOVERY_READINESS_CATEGORIES,
      'fatal_contradictions',
      'research_blockers',
      'user_decisions_required',
    ],
    'Build discovery readiness',
  );
  if (!['bootstrap', 'milestone'].includes(readiness.mode_candidate)) {
    throw new TypeError('readiness.mode_candidate must be bootstrap or milestone');
  }
  const availableEvidence = evidenceIds(evidenceDocument);
  const matrix = {};
  for (const category of DISCOVERY_READINESS_CATEGORIES) {
    const entry = readiness[category];
    exactKeys(entry, ['status', 'evidence'], `readiness.${category}`);
    if (!READINESS_STATUSES.has(entry.status)) {
      throw new TypeError(`readiness.${category}.status is unsupported`);
    }
    matrix[category] = {
      status: entry.status,
      evidence: validateEvidenceCitationList(
        entry.evidence,
        `readiness.${category}.evidence`,
        availableEvidence,
        { allowEmpty: entry.status === 'missing' },
      ),
    };
  }
  const fatalContradictions = uniqueStrings(
    readiness.fatal_contradictions,
    'readiness.fatal_contradictions',
  );
  const researchBlockers = uniqueStrings(readiness.research_blockers, 'readiness.research_blockers');
  const userDecisions = uniqueStrings(
    readiness.user_decisions_required,
    'readiness.user_decisions_required',
  );
  const blockingCategories = DISCOVERY_CRITICAL_READINESS_CATEGORIES.filter((category) =>
    ['missing', 'conflicting'].includes(matrix[category].status));
  const uncertainCategories = DISCOVERY_CRITICAL_READINESS_CATEGORIES.filter(
    (category) => matrix[category].status === 'partial',
  );
  return deepFreeze({
    readiness: {
      mode_candidate: readiness.mode_candidate,
      ...matrix,
      fatal_contradictions: fatalContradictions,
      research_blockers: researchBlockers,
      user_decisions_required: userDecisions,
    },
    activate_discovery:
      blockingCategories.length > 0 ||
      uncertainCategories.length > 0 ||
      fatalContradictions.length > 0 ||
      researchBlockers.length > 0 ||
      userDecisions.length > 0,
    blocking_categories: blockingCategories,
    uncertain_categories: uncertainCategories,
  });
}

/** Deterministic hard-gate viability evaluation. Aggregate scores never override a gate. */
export function evaluateBuildDiscoveryViability(
  viability,
  { consequence = 'medium', fatalContradictions = [] } = {},
) {
  exactKeys(
    viability,
    ['concept_id', 'critical_gates', 'supporting_dimensions', 'unresolved', 'outcome'],
    'Build discovery viability',
  );
  if (!CONCEPT_ID.test(viability.concept_id)) throw new TypeError('viability.concept_id must be C-XX');
  exactKeys(viability.critical_gates, DISCOVERY_VIABILITY_GATES, 'viability.critical_gates');
  const criticalGates = {};
  for (const gate of DISCOVERY_VIABILITY_GATES) {
    const status = viability.critical_gates[gate];
    if (!VIABILITY_GATE_STATUSES.has(status)) {
      throw new TypeError(`viability.critical_gates.${gate} is unsupported`);
    }
    criticalGates[gate] = status;
  }
  exactKeys(
    viability.supporting_dimensions,
    [
      'expected_value',
      'feasibility_confidence',
      'implementation_clarity',
      'verification_clarity',
      'reversibility',
      'operational_sustainability',
    ],
    'viability.supporting_dimensions',
  );
  const dimensions = clone(viability.supporting_dimensions);
  for (const key of [
    'expected_value',
    'implementation_clarity',
    'verification_clarity',
    'reversibility',
    'operational_sustainability',
  ]) {
    if (!Number.isFinite(dimensions[key]) || dimensions[key] < 0 || dimensions[key] > 100) {
      throw new RangeError(`viability.supporting_dimensions.${key} must be from 0 through 100`);
    }
  }
  if (
    !Number.isFinite(dimensions.feasibility_confidence) ||
    dimensions.feasibility_confidence < 0 ||
    dimensions.feasibility_confidence > 1
  ) {
    throw new RangeError('viability.supporting_dimensions.feasibility_confidence must be from 0 through 1');
  }
  exactKeys(
    viability.unresolved,
    ['user_decisions', 'research_questions', 'phase_local_questions'],
    'viability.unresolved',
  );
  const unresolved = {
    user_decisions: uniqueStrings(viability.unresolved.user_decisions, 'viability.unresolved.user_decisions'),
    research_questions: uniqueStrings(
      viability.unresolved.research_questions,
      'viability.unresolved.research_questions',
    ),
    phase_local_questions: uniqueStrings(
      viability.unresolved.phase_local_questions,
      'viability.unresolved.phase_local_questions',
    ),
  };
  if (!Object.hasOwn(CONSEQUENCE_THRESHOLDS, consequence)) {
    throw new TypeError('consequence must be low, medium, or high');
  }
  const contradictions = uniqueStrings(fatalContradictions, 'fatalContradictions');
  if (contradictions.length > 0 && criticalGates.no_fatal_contradiction !== 'fail') {
    throw new Error('fatal contradictions require no_fatal_contradiction to fail');
  }
  let outcome;
  if (viability.outcome === 'deferred') {
    outcome = 'deferred';
  } else if (Object.values(criticalGates).includes('fail') || contradictions.length > 0) {
    outcome = 'not_currently_viable';
  } else if (unresolved.user_decisions.length > 0) {
    outcome = 'user_decision_required';
  } else if (
    Object.values(criticalGates).includes('research_needed') ||
    unresolved.research_questions.length > 0 ||
    dimensions.feasibility_confidence < CONSEQUENCE_THRESHOLDS[consequence]
  ) {
    outcome = 'research_required';
  } else {
    outcome = 'ready_for_build';
  }
  if (!DISCOVERY_OUTCOMES.includes(viability.outcome) || viability.outcome !== outcome) {
    throw new Error(`viability.outcome must be deterministic ${outcome}, got ${viability.outcome}`);
  }
  return deepFreeze({
    concept_id: viability.concept_id,
    critical_gates: criticalGates,
    supporting_dimensions: dimensions,
    unresolved,
    outcome,
  });
}

function headingPattern(heading) {
  return new RegExp(`^#{2,3}\\s+${heading.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*$`, 'imu');
}

/** Validate the required human synthesis and its concept-lineage coverage. */
export function validateDiscoveryMarkdown(
  markdown,
  { concepts, viabilityOutcome = null } = {},
) {
  nonEmpty(markdown, 'DISCOVERY.md');
  if (!/^#\s+.+$/mu.test(markdown)) throw new Error('DISCOVERY.md must have a document title');
  for (const heading of REQUIRED_DISCOVERY_HEADINGS) {
    if (!headingPattern(heading).test(markdown)) {
      throw new Error(`DISCOVERY.md is missing required heading: ${heading}`);
    }
  }
  const document = validateDiscoveryConcepts(concepts, { viabilityOutcome });
  if (document.selected_concept_id != null && !markdown.includes(document.selected_concept_id)) {
    throw new Error('DISCOVERY.md must name the selected concept ID');
  }
  for (const concept of document.concepts.filter(({ status }) => status === 'rejected')) {
    if (!markdown.includes(concept.id) || !markdown.includes(concept.status_reason.trim())) {
      throw new Error(`DISCOVERY.md must preserve rejected concept ${concept.id} and its reason`);
    }
  }
  return markdown;
}

function validateResearchItem(item, index) {
  const label = `research_items[${index}]`;
  exactKeys(
    item,
    [
      'id',
      'class',
      'concept_id',
      'question',
      'scope',
      'decision_impact',
      'status',
      'request_sha256',
      'approval',
      'result',
      'created_at',
      'updated_at',
    ],
    label,
  );
  if (!RESEARCH_ID.test(item.id)) throw new TypeError(`${label}.id must be DR-XX`);
  if (!DISCOVERY_RESEARCH_CLASSES.includes(item.class)) throw new TypeError(`${label}.class is unsupported`);
  if (!CONCEPT_ID.test(item.concept_id)) throw new TypeError(`${label}.concept_id must be C-XX`);
  nonEmpty(item.question, `${label}.question`);
  nonEmpty(item.scope, `${label}.scope`);
  nonEmpty(item.decision_impact, `${label}.decision_impact`);
  if (!['waiting_approval', 'in_progress', 'reconciled'].includes(item.status)) {
    throw new TypeError(`${label}.status is unsupported`);
  }
  assertDigest(item.request_sha256, `${label}.request_sha256`);
  timestamp(item.created_at, `${label}.created_at`);
  timestamp(item.updated_at, `${label}.updated_at`);
  const requestMaterial = {
    id: item.id,
    class: item.class,
    concept_id: item.concept_id,
    question: item.question,
    scope: item.scope,
    decision_impact: item.decision_impact,
    created_at: item.created_at,
  };
  if (objectDigest(requestMaterial) !== item.request_sha256) {
    throw new Error(`${label}.request_sha256 does not match the research scope`);
  }
  if (item.status === 'waiting_approval') {
    if (item.approval !== null || item.result !== null) {
      throw new Error(`${label} waiting approval cannot contain approval or result receipts`);
    }
  } else {
    exactKeys(
      item.approval,
      ['interaction_id', 'request_sha256', 'approved_at'],
      `${label}.approval`,
    );
    nonEmpty(item.approval.interaction_id, `${label}.approval.interaction_id`);
    if (item.approval.request_sha256 !== item.request_sha256) {
      throw new Error(`${label}.approval is bound to another research request`);
    }
    timestamp(item.approval.approved_at, `${label}.approval.approved_at`);
    if (item.status === 'in_progress' && item.result !== null) {
      throw new Error(`${label} in progress cannot contain a result receipt`);
    }
    if (item.status === 'reconciled') {
      exactKeys(
        item.result,
        ['result_sha256', 'conclusion', 'evidence_ids', 'completed_at', 'reconciled_at'],
        `${label}.result`,
      );
      assertDigest(item.result.result_sha256, `${label}.result.result_sha256`);
      if (!['supports', 'contradicts', 'inconclusive'].includes(item.result.conclusion)) {
        throw new TypeError(`${label}.result.conclusion is unsupported`);
      }
      uniqueStrings(item.result.evidence_ids, `${label}.result.evidence_ids`, {
        allowEmpty: false,
        pattern: EVIDENCE_ID,
      });
      timestamp(item.result.completed_at, `${label}.result.completed_at`);
      timestamp(item.result.reconciled_at, `${label}.result.reconciled_at`);
    }
  }
  return clone(item);
}

function validateCursor(cursor, status) {
  exactKeys(
    cursor,
    [
      'stage',
      'pending_question_id',
      'research_item_id',
      'resume_stage',
      'interrupted',
      'interruption_reason',
      'interrupted_at',
      'resume_count',
    ],
    'discovery cursor',
  );
  nonEmpty(cursor.stage, 'discovery cursor.stage');
  if (cursor.pending_question_id !== null && !QUESTION_ID.test(cursor.pending_question_id)) {
    throw new TypeError('discovery cursor.pending_question_id must be null or Q-XX');
  }
  if (cursor.research_item_id !== null && !RESEARCH_ID.test(cursor.research_item_id)) {
    throw new TypeError('discovery cursor.research_item_id must be null or DR-XX');
  }
  if (cursor.resume_stage !== null && typeof cursor.resume_stage !== 'string') {
    throw new TypeError('discovery cursor.resume_stage must be null or a string');
  }
  if (typeof cursor.interrupted !== 'boolean') throw new TypeError('discovery cursor.interrupted must be boolean');
  if (cursor.interrupted) {
    nonEmpty(cursor.interruption_reason, 'discovery cursor.interruption_reason');
    timestamp(cursor.interrupted_at, 'discovery cursor.interrupted_at');
  } else if (cursor.interruption_reason !== null || cursor.interrupted_at !== null) {
    throw new Error('active discovery cursor cannot retain interruption metadata');
  }
  if (!Number.isInteger(cursor.resume_count) || cursor.resume_count < 0) {
    throw new TypeError('discovery cursor.resume_count must be a non-negative integer');
  }
  if (status === 'research_in_progress' && cursor.research_item_id === null) {
    throw new Error('research_in_progress must retain the same-run research return cursor');
  }
  return clone(cursor);
}

function validateDraftManifest(manifest, snapshot) {
  if (manifest === null) return null;
  exactKeys(
    manifest,
    [
      'mode',
      'approved',
      'selected_concept_id',
      'rejected_concept_ids',
      'requirement_ids',
      'acceptance_criteria_ids',
      'decision_ids',
      'phase_local_questions',
      'research_prerequisites',
      'approval_readiness_digest',
      'milestone_phase_dag',
      'artifacts',
      'generated_at',
    ],
    'draft manifest',
  );
  if (manifest.mode !== snapshot.mode_candidate) throw new Error('draft manifest mode differs from discovery');
  if (manifest.approved !== false) throw new Error('automatic discovery drafting cannot approve Build artifacts');
  if (manifest.selected_concept_id !== snapshot.concepts.selected_concept_id) {
    throw new Error('draft manifest lost the selected concept lineage');
  }
  const rejected = snapshot.concepts.concepts
    .filter(({ status }) => status === 'rejected')
    .map(({ id }) => id);
  if (!exactStringSets(manifest.rejected_concept_ids, rejected)) {
    throw new Error('draft manifest must preserve every rejected concept ID');
  }
  uniqueStrings(manifest.requirement_ids, 'draft manifest requirement_ids', {
    allowEmpty: false,
    pattern: REQUIREMENT_ID,
  });
  uniqueStrings(manifest.acceptance_criteria_ids, 'draft manifest acceptance_criteria_ids', {
    allowEmpty: false,
    pattern: ACCEPTANCE_ID,
  });
  uniqueStrings(manifest.decision_ids, 'draft manifest decision_ids', {
    allowEmpty: false,
    pattern: DECISION_ID,
  });
  if (!exactStringSets(manifest.phase_local_questions, snapshot.viability.unresolved.phase_local_questions)) {
    throw new Error('draft manifest must preserve unresolved phase-local issues');
  }
  uniqueStrings(manifest.research_prerequisites, 'draft manifest research_prerequisites');
  assertDigest(manifest.approval_readiness_digest, 'draft manifest approval_readiness_digest');
  if (!isPlainObject(manifest.milestone_phase_dag) && !Array.isArray(manifest.milestone_phase_dag)) {
    throw new TypeError('draft manifest milestone_phase_dag must contain the generated phase DAG');
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new TypeError('draft manifest must enumerate generated Build artifacts');
  }
  const paths = new Set();
  for (const [index, artifact] of manifest.artifacts.entries()) {
    exactKeys(artifact, ['path', 'sha256'], `draft manifest artifacts[${index}]`);
    const path = nonEmpty(artifact.path, `draft manifest artifacts[${index}].path`).replaceAll('\\', '/');
    if (
      path.startsWith('/') ||
      path.split('/').includes('..') ||
      !path.startsWith('.cruise/') ||
      path.endsWith('/CLOSEOUT.md') ||
      path.includes('/discovery/') ||
      path === '.cruise/goal' ||
      path.startsWith('.cruise/goal/')
    ) {
      throw new Error(`automatic drafting path is outside the final Build artifact boundary: ${path}`);
    }
    if (paths.has(path)) throw new Error(`duplicate draft artifact path ${path}`);
    paths.add(path);
    assertDigest(artifact.sha256, `draft manifest artifacts[${index}].sha256`);
  }
  const projectNames = [
    'ORIGIN.yaml',
    'ID-REGISTRY.yaml',
    'PROJECT.md',
    'REQUIREMENTS.md',
    'ARCHITECTURE.md',
    'ROADMAP.md',
    'DECISIONS.md',
    'STATE.yaml',
    'QUEUE.yaml',
  ];
  const milestoneNames = [
    'ORIGIN.yaml',
    'MILESTONE.md',
    'REQUIREMENTS.md',
    'ROADMAP.md',
    'DECISIONS.md',
    'QUESTIONS.yaml',
    'AUTONOMY.yaml',
    'STATE.yaml',
    'QUEUE.yaml',
  ];
  const milestoneRoots = new Set(
    [...paths]
      .map((path) => path.match(/^(\.cruise\/milestones\/M-\d{2,}-[a-z0-9][a-z0-9-]*)\//u)?.[1] ?? null)
      .filter(Boolean),
  );
  if (milestoneRoots.size !== 1) {
    throw new Error('draft manifest must contain exactly one complete canonical milestone artifact set');
  }
  const milestoneRoot = [...milestoneRoots][0];
  if (
    snapshot.mode_candidate === 'milestone' &&
    !milestoneRoot.startsWith(`.cruise/milestones/${snapshot.milestone_id}-`)
  ) {
    throw new Error('milestone draft manifest targets a different milestone');
  }
  const expectedPaths = new Set([
    ...projectNames.map((name) => `.cruise/project/${name}`),
    ...milestoneNames.map((name) => `${milestoneRoot}/${name}`),
  ]);
  if (!exactStringSets(paths, expectedPaths)) {
    const missing = [...expectedPaths].filter((path) => !paths.has(path));
    const extra = [...paths].filter((path) => !expectedPaths.has(path));
    throw new Error(
      `draft manifest must be the complete canonical Build set; missing [${missing.join(', ')}], extra [${extra.join(', ')}]`,
    );
  }
  timestamp(manifest.generated_at, 'draft manifest.generated_at');
  return clone(manifest);
}

function validateSnapshot(snapshot, immutable) {
  exactKeys(
    snapshot,
    [
      'mode_candidate',
      'project_id',
      'milestone_id',
      'consequence',
      'status',
      'cursor',
      'concepts',
      'readiness',
      'viability',
      'evidence',
      'questions',
      'decisions_markdown',
      'discovery_markdown',
      'research_items',
      'draft_manifest',
    ],
    'Build discovery snapshot',
  );
  if (!['bootstrap', 'milestone'].includes(snapshot.mode_candidate)) {
    throw new TypeError('discovery mode_candidate must be bootstrap or milestone');
  }
  if (!PROJECT_ID.test(snapshot.project_id)) throw new TypeError('discovery project_id must be PRJ-XX');
  if (snapshot.mode_candidate === 'milestone') {
    if (!MILESTONE_ID.test(snapshot.milestone_id)) {
      throw new TypeError('milestone discovery requires milestone_id M-XX');
    }
  } else if (snapshot.milestone_id !== null) {
    throw new Error('bootstrap discovery milestone_id must be null');
  }
  if (!Object.hasOwn(CONSEQUENCE_THRESHOLDS, snapshot.consequence)) {
    throw new TypeError('discovery consequence must be low, medium, or high');
  }
  if (!DISCOVERY_STATUSES.includes(snapshot.status)) throw new TypeError('discovery status is unsupported');
  const evidence = validateDiscoveryEvidence(snapshot.evidence, immutable);
  const readinessEvaluation = evaluateBuildDiscoveryReadiness(snapshot.readiness, { evidence });
  if (readinessEvaluation.readiness.mode_candidate !== snapshot.mode_candidate) {
    throw new Error('discovery readiness mode_candidate differs from its run');
  }
  const viability = evaluateBuildDiscoveryViability(snapshot.viability, {
    consequence: snapshot.consequence,
    fatalContradictions: readinessEvaluation.readiness.fatal_contradictions,
  });
  const concepts = validateDiscoveryConcepts(snapshot.concepts, {
    ...immutable,
    viabilityOutcome: viability.outcome,
  });
  if (!concepts.concepts.some(({ id }) => id === viability.concept_id)) {
    throw new Error('viability evaluates an unknown concept');
  }
  if (
    concepts.selected_concept_id != null &&
    concepts.selected_concept_id !== viability.concept_id
  ) {
    throw new Error('viability must evaluate the selected concept');
  }
  const questions = validateDiscoveryQuestions(snapshot.questions, {
    ...immutable,
    evidence,
  });
  const openQuestions = questions.questions.filter(({ status }) => status === 'open');
  const decisions = validateDiscoveryDecisions(snapshot.decisions_markdown, {
    concepts,
    evidence,
    viabilityOutcome: viability.outcome,
  });
  validateDiscoveryMarkdown(snapshot.discovery_markdown, {
    concepts,
    viabilityOutcome: viability.outcome,
  });
  if (!Array.isArray(snapshot.research_items)) throw new TypeError('research_items must be an array');
  const researchItems = snapshot.research_items.map(validateResearchItem);
  if (new Set(researchItems.map(({ id }) => id)).size !== researchItems.length) {
    throw new Error('research_items must use unique DR-XX IDs');
  }
  const activeResearch = researchItems.filter(({ status }) => status !== 'reconciled');
  if (activeResearch.length > 1) throw new Error('discovery may have only one active material research blocker');
  const expectedStatus = normalizedStatusForOutcome(viability.outcome);
  if (![
    'question_resolved',
    'waiting_research_approval',
    'research_in_progress',
    'draft_ready_for_review',
  ].includes(snapshot.status)) {
    if (snapshot.status !== expectedStatus) {
      throw new Error(`discovery status must be ${expectedStatus} for viability ${viability.outcome}`);
    }
  }
  if (snapshot.status === 'waiting_research_approval') {
    if (activeResearch.length !== 1 || activeResearch[0].status !== 'waiting_approval') {
      throw new Error('waiting_research_approval requires exactly one scoped research request');
    }
  }
  if (snapshot.status === 'research_in_progress') {
    if (activeResearch.length !== 1 || activeResearch[0].status !== 'in_progress') {
      throw new Error('research_in_progress requires exactly one approved in-progress request');
    }
  }
  if (snapshot.status === 'draft_ready_for_review' && viability.outcome !== 'ready_for_build') {
    throw new Error('draft_ready_for_review requires current ready_for_build viability');
  }
  if (snapshot.status === 'question_resolved' && viability.outcome !== 'user_decision_required') {
    throw new Error('question_resolved is valid only while another user decision remains');
  }
  const cursor = validateCursor(snapshot.cursor, snapshot.status);
  if (snapshot.status === 'waiting_user_decision') {
    if (openQuestions.length !== 1 || cursor.pending_question_id !== openQuestions[0].id) {
      throw new Error('waiting_user_decision requires exactly one cursor-bound open question');
    }
  } else if (openQuestions.length > 0) {
    throw new Error('an open discovery question is allowed only while waiting_user_decision');
  }
  if (snapshot.status === 'question_resolved' && cursor.pending_question_id !== null) {
    throw new Error('resolved question cursor must clear before the next Q-XX is opened');
  }
  if (
    cursor.pending_question_id !== null &&
    !questions.questions.some(({ id }) => id === cursor.pending_question_id)
  ) {
    throw new Error('discovery cursor references unknown question');
  }
  if (cursor.research_item_id != null && !researchItems.some(({ id }) => id === cursor.research_item_id)) {
    throw new Error('discovery cursor references unknown research item');
  }
  const draftManifest = validateDraftManifest(snapshot.draft_manifest, {
    ...snapshot,
    concepts,
    viability,
  });
  if ((snapshot.status === 'draft_ready_for_review') !== (draftManifest !== null)) {
    throw new Error('draft manifest exists exactly when drafts are ready for normal Build review');
  }
  return deepFreeze({
    ...clone(snapshot),
    cursor,
    concepts,
    readiness: readinessEvaluation.readiness,
    viability,
    evidence,
    questions,
    decisions_markdown: decisions.markdown,
    research_items: researchItems,
    draft_manifest: draftManifest,
  });
}

function snapshotDigest(snapshot) {
  return objectDigest(snapshot);
}

function normalizeEvent(event, expectedSequence, priorSnapshotDigest) {
  exactKeys(
    event,
    ['sequence', 'type', 'at', 'prior_snapshot_sha256', 'payload', 'result_snapshot_sha256'],
    'Build discovery event',
  );
  if (event.sequence !== expectedSequence) throw new Error('discovery event sequence is not contiguous');
  nonEmpty(event.type, 'discovery event.type');
  timestamp(event.at, 'discovery event.at');
  if (event.prior_snapshot_sha256 !== priorSnapshotDigest) {
    throw new Error('discovery event prior snapshot digest does not match replay state');
  }
  if (!isPlainObject(event.payload)) throw new TypeError('discovery event.payload must be an object');
  assertDigest(event.result_snapshot_sha256, 'discovery event.result_snapshot_sha256');
  return clone(event);
}

/** Pure validated reducer used by both live transitions and persistence replay. */
export function reduceBuildDiscoverySnapshot(snapshotInput, eventInput, immutable = {}) {
  const snapshot = validateSnapshot(snapshotInput, immutable);
  const event = clone(eventInput);
  const next = clone(snapshot);
  switch (event.type) {
    case 'assessment_reconciled': {
      exactKeys(
        event.payload,
        ['readiness', 'viability', 'discovery_markdown'],
        'assessment_reconciled payload',
      );
      if (snapshot.status === 'research_in_progress' || snapshot.status === 'waiting_research_approval') {
        throw new Error('ordinary snapshot reconciliation cannot bypass active research');
      }
      next.readiness = clone(event.payload.readiness);
      next.viability = clone(event.payload.viability);
      next.discovery_markdown = event.payload.discovery_markdown;
      next.draft_manifest = null;
      const viability = evaluateBuildDiscoveryViability(next.viability, {
        consequence: next.consequence,
        fatalContradictions: next.readiness.fatal_contradictions,
      });
      const open = next.questions.questions.find(({ status }) => status === 'open') ?? null;
      next.status = viability.outcome === 'user_decision_required' && open == null
        ? 'question_resolved'
        : normalizedStatusForOutcome(viability.outcome);
      next.cursor.stage = next.status;
      next.cursor.pending_question_id = open?.id ?? null;
      break;
    }
    case 'question_answered': {
      exactKeys(
        event.payload,
        [
          'question_id',
          'answer',
          'answer_source',
          'status',
          'evidence_item',
          'readiness',
          'viability',
          'discovery_markdown',
        ],
        'question_answered payload',
      );
      if (snapshot.status !== 'waiting_user_decision' || snapshot.cursor.interrupted) {
        throw new Error('only the current uninterrupted material question may be answered');
      }
      const questionIndex = next.questions.questions.findIndex(
        ({ id }) => id === event.payload.question_id,
      );
      if (
        questionIndex < 0 ||
        next.questions.questions[questionIndex].status !== 'open' ||
        snapshot.cursor.pending_question_id !== event.payload.question_id
      ) {
        throw new Error('question answer does not match the current Q-XX cursor');
      }
      if (!['answered', 'assumed', 'deferred'].includes(event.payload.status)) {
        throw new TypeError('question answer status must be answered, assumed, or deferred');
      }
      if (
        event.payload.evidence_item?.captured_at !== event.at ||
        event.payload.evidence_item?.research_item_id !== null ||
        !['user_statement', 'repository_observation'].includes(event.payload.evidence_item?.type)
      ) {
        throw new Error('question answer must append current non-Research answer evidence');
      }
      const answer = nonEmpty(event.payload.answer, 'question answer');
      const answerSource = nonEmpty(event.payload.answer_source, 'question answer_source');
      const appendedEvidence = clone(next.evidence);
      appendedEvidence.evidence.push(clone(event.payload.evidence_item));
      next.evidence = assertEvidenceAppendOnly(snapshot.evidence, appendedEvidence);
      const evidenceId = event.payload.evidence_item.id;
      next.questions.questions[questionIndex] = {
        ...next.questions.questions[questionIndex],
        status: event.payload.status,
        evidence: [...new Set([
          ...next.questions.questions[questionIndex].evidence,
          evidenceId,
        ])],
        answer,
        answer_source: answerSource,
        answered_at: event.at,
      };
      next.readiness = clone(event.payload.readiness);
      next.viability = clone(event.payload.viability);
      next.discovery_markdown = event.payload.discovery_markdown;
      const viability = evaluateBuildDiscoveryViability(next.viability, {
        consequence: next.consequence,
        fatalContradictions: next.readiness.fatal_contradictions,
      });
      next.status = viability.outcome === 'user_decision_required'
        ? 'question_resolved'
        : normalizedStatusForOutcome(viability.outcome);
      next.cursor = {
        ...next.cursor,
        stage: next.status,
        pending_question_id: null,
      };
      break;
    }
    case 'next_question_opened': {
      exactKeys(event.payload, ['question'], 'next_question_opened payload');
      if (
        snapshot.status !== 'question_resolved' ||
        snapshot.viability.outcome !== 'user_decision_required' ||
        snapshot.cursor.interrupted
      ) {
        throw new Error('next discovery question requires the prior Q-XX to resolve first');
      }
      const candidateQuestions = clone(snapshot.questions);
      candidateQuestions.questions.push(clone(event.payload.question));
      const validated = validateDiscoveryQuestions(candidateQuestions, {
        runId: snapshot.questions.run_id,
        originSha256: snapshot.questions.origin_sha256,
        evidence: snapshot.evidence,
      });
      const priorIds = snapshot.questions.questions.map(({ id }) => id);
      const expectedNumber = priorIds.length === 0
        ? 1
        : Math.max(...priorIds.map((id) => Number(id.slice(2)))) + 1;
      const question = validated.questions.at(-1);
      if (question.id !== `Q-${String(expectedNumber).padStart(2, '0')}` || question.status !== 'open') {
        throw new Error('next question must append the next monotonic open Q-XX record');
      }
      if (
        !snapshot.viability.unresolved.user_decisions.includes(question.question) ||
        !snapshot.readiness.user_decisions_required.includes(question.question)
      ) {
        throw new Error('next question must be one of the current unresolved user decisions');
      }
      next.questions = validated;
      next.status = 'waiting_user_decision';
      next.cursor = {
        ...next.cursor,
        stage: 'waiting_user_decision',
        pending_question_id: question.id,
      };
      break;
    }
    case 'lineage_recorded': {
      exactKeys(
        event.payload,
        [
          'concepts',
          'evidence',
          'decisions_markdown',
          'readiness',
          'viability',
          'discovery_markdown',
        ],
        'lineage_recorded payload',
      );
      if (snapshot.questions.questions.some(({ status }) => status === 'open')) {
        throw new Error('concept/evidence/decision lineage cannot bypass an open material question');
      }
      next.concepts = assertConceptLineageTransition(snapshot.concepts, event.payload.concepts);
      next.evidence = assertEvidenceAppendOnly(snapshot.evidence, event.payload.evidence);
      next.decisions_markdown = assertDecisionHistoryAppendOnly(
        snapshot.decisions_markdown,
        event.payload.decisions_markdown,
        { concepts: next.concepts, evidence: next.evidence },
      ).markdown;
      next.readiness = clone(event.payload.readiness);
      next.viability = clone(event.payload.viability);
      next.discovery_markdown = event.payload.discovery_markdown;
      const viability = evaluateBuildDiscoveryViability(next.viability, {
        consequence: next.consequence,
        fatalContradictions: next.readiness.fatal_contradictions,
      });
      next.status = viability.outcome === 'user_decision_required'
        ? 'question_resolved'
        : normalizedStatusForOutcome(viability.outcome);
      next.cursor = {
        ...next.cursor,
        stage: next.status,
        pending_question_id: null,
      };
      break;
    }
    case 'research_requested': {
      exactKeys(event.payload, ['research'], 'research_requested payload');
      if (snapshot.viability.outcome !== 'research_required' || snapshot.status !== 'research_required') {
        throw new Error('pre-approval research may be requested only for research_required viability');
      }
      const research = validateResearchItem(event.payload.research, snapshot.research_items.length);
      if (research.class !== 'pre_approval_blocker' || research.status !== 'waiting_approval') {
        throw new Error('active discovery DAG accepts only a waiting pre_approval_blocker');
      }
      if (research.concept_id !== snapshot.viability.concept_id) {
        throw new Error('research request must remain bound to the evaluated concept');
      }
      const unresolved = new Set([
        ...snapshot.viability.unresolved.research_questions,
        ...snapshot.readiness.research_blockers,
        ...snapshot.concepts.concepts.find(({ id }) => id === research.concept_id).research_questions,
      ]);
      if (!unresolved.has(research.question)) {
        throw new Error('research request question is not an unresolved feasibility blocker');
      }
      if (snapshot.research_items.some(({ id }) => id === research.id)) {
        throw new Error(`research ID ${research.id} is already used`);
      }
      next.research_items.push(research);
      next.status = 'waiting_research_approval';
      next.cursor = {
        ...next.cursor,
        stage: 'waiting_research_approval',
        research_item_id: research.id,
        resume_stage: 'reconcile_pre_approval_research',
      };
      break;
    }
    case 'research_started': {
      exactKeys(event.payload, ['research_id', 'approval'], 'research_started payload');
      if (snapshot.status !== 'waiting_research_approval') {
        throw new Error('research can start only from waiting_research_approval');
      }
      const index = next.research_items.findIndex(({ id }) => id === event.payload.research_id);
      if (index < 0 || next.research_items[index].status !== 'waiting_approval') {
        throw new Error('research_started does not reference the pending request');
      }
      next.research_items[index] = {
        ...next.research_items[index],
        status: 'in_progress',
        approval: clone(event.payload.approval),
        updated_at: event.at,
      };
      next.status = 'research_in_progress';
      next.cursor.stage = 'research_in_progress';
      break;
    }
    case 'research_reconciled': {
      exactKeys(
        event.payload,
        [
          'research_id',
          'result',
          'concepts',
          'readiness',
          'viability',
          'evidence',
          'questions',
          'decisions_markdown',
          'discovery_markdown',
        ],
        'research_reconciled payload',
      );
      if (snapshot.status !== 'research_in_progress') {
        throw new Error('research reconciliation requires the same active Build discovery run');
      }
      const index = next.research_items.findIndex(({ id }) => id === event.payload.research_id);
      if (index < 0 || next.research_items[index].status !== 'in_progress') {
        throw new Error('research reconciliation does not match the in-progress blocker');
      }
      next.concepts = assertConceptLineageTransition(snapshot.concepts, event.payload.concepts);
      next.readiness = clone(event.payload.readiness);
      next.viability = clone(event.payload.viability);
      next.evidence = assertEvidenceAppendOnly(snapshot.evidence, event.payload.evidence);
      next.questions = assertQuestionsUnchanged(snapshot.questions, event.payload.questions);
      next.decisions_markdown = assertDecisionHistoryAppendOnly(
        snapshot.decisions_markdown,
        event.payload.decisions_markdown,
        { concepts: next.concepts, evidence: next.evidence },
      ).markdown;
      next.discovery_markdown = event.payload.discovery_markdown;
      const conclusion = event.payload.result.conclusion;
      const viability = evaluateBuildDiscoveryViability(next.viability, {
        consequence: next.consequence,
        fatalContradictions: next.readiness.fatal_contradictions,
      });
      if (conclusion === 'contradicts' && viability.outcome === 'ready_for_build') {
        throw new Error('research contradiction must reopen readiness and cannot produce ready_for_build');
      }
      if (conclusion === 'inconclusive' && !['research_required', 'deferred'].includes(viability.outcome)) {
        throw new Error('inconclusive feasibility research must remain research_required or deferred');
      }
      next.research_items[index] = {
        ...next.research_items[index],
        status: 'reconciled',
        result: {
          ...clone(event.payload.result),
          reconciled_at: event.at,
        },
        updated_at: event.at,
      };
      next.status = normalizedStatusForOutcome(viability.outcome);
      next.cursor = {
        ...next.cursor,
        stage: next.status,
        research_item_id: null,
        resume_stage: null,
      };
      break;
    }
    case 'interrupted': {
      exactKeys(
        event.payload,
        ['reason', 'pending_question_id'],
        'interrupted payload',
      );
      if (snapshot.cursor.interrupted) throw new Error('discovery run is already interrupted');
      nonEmpty(event.payload.reason, 'interrupted reason');
      if (event.payload.pending_question_id !== null && !QUESTION_ID.test(event.payload.pending_question_id)) {
        throw new TypeError('pending_question_id must be null or Q-XX');
      }
      next.cursor = {
        ...next.cursor,
        pending_question_id: event.payload.pending_question_id,
        interrupted: true,
        interruption_reason: event.payload.reason,
        interrupted_at: event.at,
      };
      break;
    }
    case 'resumed': {
      exactKeys(event.payload, ['resume_attestation_sha256'], 'resumed payload');
      assertDigest(event.payload.resume_attestation_sha256, 'resume_attestation_sha256');
      if (!snapshot.cursor.interrupted) throw new Error('only an interrupted discovery run can resume');
      next.cursor = {
        ...next.cursor,
        interrupted: false,
        interruption_reason: null,
        interrupted_at: null,
        resume_count: next.cursor.resume_count + 1,
      };
      break;
    }
    case 'drafts_generated': {
      exactKeys(
        event.payload,
        ['manifest', 'authority_sha256', 'semantic_validation_sha256', 'lineage_sha256'],
        'drafts_generated payload',
      );
      assertDigest(event.payload.authority_sha256, 'draft authority digest');
      assertDigest(event.payload.semantic_validation_sha256, 'draft semantic validation digest');
      assertDigest(event.payload.lineage_sha256, 'draft lineage digest');
      if (snapshot.status !== 'ready_for_build' || snapshot.cursor.interrupted) {
        throw new Error('automatic drafting requires an uninterrupted ready_for_build state');
      }
      next.draft_manifest = clone(event.payload.manifest);
      next.status = 'draft_ready_for_review';
      next.cursor.stage = 'normal_build_approval_review';
      break;
    }
    default:
      throw new Error(`unsupported Build discovery event ${event.type}`);
  }
  return validateSnapshot(next, immutable);
}

function buildEvent(state, type, payload, at) {
  const prior = snapshotDigest(state.snapshot);
  const draft = {
    sequence: state.history.length + 1,
    type,
    at,
    prior_snapshot_sha256: prior,
    payload: clone(payload),
    result_snapshot_sha256: '0'.repeat(64),
  };
  const result = reduceBuildDiscoverySnapshot(state.snapshot, draft, {
    runId: state.run_id,
    originSha256: state.origin_sha256,
  });
  draft.result_snapshot_sha256 = snapshotDigest(result);
  return { event: draft, result };
}

/** Recompute every reducer event; edited/corrupt persistent histories fail closed. */
export function replayBuildDiscoveryState(stateInput) {
  exactKeys(
    stateInput,
    [
      'schema_version',
      'kind',
      'run_id',
      'origin_yaml',
      'origin_sha256',
      'repository_baseline_sha256',
      'initial_snapshot',
      'history',
      'snapshot',
      'created_at',
      'updated_at',
    ],
    'Build discovery state',
  );
  if (stateInput.schema_version !== 1 || stateInput.kind !== 'cruise_build_discovery_state') {
    throw new Error('Build discovery state must use schema version 1 and its canonical kind');
  }
  if (!RUN_ID.test(stateInput.run_id)) throw new TypeError('Build discovery run_id is invalid');
  assertDigest(stateInput.origin_sha256, 'Build discovery origin_sha256');
  nonEmpty(stateInput.origin_yaml, 'Build discovery origin_yaml');
  if (digest(stateInput.origin_yaml) !== stateInput.origin_sha256) {
    throw new Error('persisted discovery Origin bytes differ from origin_sha256');
  }
  const originRecord = parseYaml(stateInput.origin_yaml);
  validateOriginRecord(originRecord);
  assertDigest(stateInput.repository_baseline_sha256, 'Build discovery repository_baseline_sha256');
  timestamp(stateInput.created_at, 'Build discovery created_at');
  timestamp(stateInput.updated_at, 'Build discovery updated_at');
  if (Date.parse(stateInput.updated_at) < Date.parse(stateInput.created_at)) {
    throw new Error('Build discovery updated_at cannot precede created_at');
  }
  if (!Array.isArray(stateInput.history)) throw new TypeError('Build discovery history must be an array');
  const immutable = { runId: stateInput.run_id, originSha256: stateInput.origin_sha256 };
  let snapshot = validateSnapshot(stateInput.initial_snapshot, immutable);
  if (
    originRecord.origin.selected_skill !== 'build' ||
    originRecord.build?.mode !== snapshot.mode_candidate ||
    originRecord.build.target_project !== snapshot.project_id ||
    originRecord.build.target_milestone !== snapshot.milestone_id
  ) {
    throw new Error('persisted discovery Origin target/mode differs from its snapshot');
  }
  let priorAt = stateInput.created_at;
  for (const [index, rawEvent] of stateInput.history.entries()) {
    const event = normalizeEvent(rawEvent, index + 1, snapshotDigest(snapshot));
    if (Date.parse(event.at) < Date.parse(priorAt)) {
      throw new Error(`discovery event ${event.sequence} timestamp is not monotonic`);
    }
    const result = reduceBuildDiscoverySnapshot(snapshot, event, immutable);
    if (snapshotDigest(result) !== event.result_snapshot_sha256) {
      throw new Error(`discovery event ${event.sequence} result digest does not match replay`);
    }
    snapshot = result;
    priorAt = event.at;
  }
  if (stateInput.updated_at !== priorAt) {
    throw new Error('Build discovery updated_at must equal its last replayed event timestamp');
  }
  if (canonicalJson(snapshot) !== canonicalJson(validateSnapshot(stateInput.snapshot, immutable))) {
    throw new Error('persisted Build discovery snapshot differs from replayed history');
  }
  return deepFreeze({ ...clone(stateInput), initial_snapshot: validateSnapshot(stateInput.initial_snapshot, immutable), snapshot });
}

function brandRun(state) {
  const run = deepFreeze({
    kind: 'cruise_opaque_build_discovery_run',
    state: replayBuildDiscoveryState(state),
  });
  RUNS.add(run);
  return run;
}

function requireRun(run) {
  if (!isPlainObject(run) || !RUNS.has(run)) {
    throw new Error('Build discovery mutation requires an opaque live or rehydrated run authority');
  }
  replayBuildDiscoveryState(run.state);
  return run;
}

function advance(run, type, payload, now) {
  const current = requireRun(run).state;
  const at = timestamp(now, `${type}.at`);
  const { event, result } = buildEvent(current, type, payload, at);
  const state = {
    ...clone(current),
    history: [...clone(current.history), event],
    snapshot: result,
    updated_at: at,
  };
  return brandRun(state);
}

/** Start a persistent internal Build discovery run. */
export function initializeBuildDiscovery({
  runId,
  modeCandidate,
  projectId,
  milestoneId = null,
  originYaml,
  originSha256,
  repositoryBaselineSha256,
  consequence = 'medium',
  concepts,
  readiness,
  viability,
  evidence,
  questions,
  decisionsMarkdown,
  discoveryMarkdown,
  pendingQuestionId = null,
  now = () => new Date(),
} = {}) {
  if (!RUN_ID.test(runId)) throw new TypeError('runId is invalid');
  assertDigest(originSha256, 'originSha256');
  nonEmpty(originYaml, 'originYaml');
  if (digest(originYaml) !== originSha256) {
    throw new Error('originYaml bytes do not match the immutable discovery Origin digest');
  }
  const originRecord = parseYaml(originYaml);
  validateOriginRecord(originRecord);
  if (originRecord.origin.selected_skill !== 'build' || originRecord.build?.mode !== modeCandidate) {
    throw new Error('discovery ORIGIN.yaml must be a Build Origin for its candidate mode');
  }
  if (
    originRecord.build.target_project !== projectId ||
    originRecord.build.target_milestone !== milestoneId
  ) {
    throw new Error('discovery ORIGIN.yaml target differs from the discovery run');
  }
  assertDigest(repositoryBaselineSha256, 'repositoryBaselineSha256');
  const at = timestamp(now, 'discovery created_at');
  const evaluated = evaluateBuildDiscoveryViability(viability, {
    consequence,
    fatalContradictions: readiness?.fatal_contradictions ?? [],
  });
  const status = normalizedStatusForOutcome(evaluated.outcome);
  const initial = validateSnapshot({
    mode_candidate: modeCandidate,
    project_id: projectId,
    milestone_id: milestoneId,
    consequence,
    status,
    cursor: {
      stage: status,
      pending_question_id: pendingQuestionId,
      research_item_id: null,
      resume_stage: null,
      interrupted: false,
      interruption_reason: null,
      interrupted_at: null,
      resume_count: 0,
    },
    concepts: clone(concepts),
    readiness: clone(readiness),
    viability: clone(viability),
    evidence: clone(evidence),
    questions: clone(questions),
    decisions_markdown: decisionsMarkdown,
    discovery_markdown: discoveryMarkdown,
    research_items: [],
    draft_manifest: null,
  }, { runId, originSha256 });
  return brandRun({
    schema_version: 1,
    kind: 'cruise_build_discovery_state',
    run_id: runId,
    origin_yaml: originYaml,
    origin_sha256: originSha256,
    repository_baseline_sha256: repositoryBaselineSha256,
    initial_snapshot: initial,
    history: [],
    snapshot: initial,
    created_at: at,
    updated_at: at,
  });
}

export function serializeBuildDiscoveryState(run) {
  return clone(requireRun(run).state);
}

export function reconcileBuildDiscoverySnapshot(run, {
  readiness,
  viability,
  discoveryMarkdown,
  now = () => new Date(),
} = {}) {
  return advance(run, 'assessment_reconciled', {
    readiness,
    viability,
    discovery_markdown: discoveryMarkdown,
  }, now);
}

/** Resolve exactly the cursor-bound Q-XX and append its answer evidence. */
export function answerBuildDiscoveryQuestion(run, {
  questionId,
  answer,
  answerSource,
  status = 'answered',
  evidenceItem,
  readiness,
  viability,
  discoveryMarkdown,
  now = () => new Date(),
} = {}) {
  const at = timestamp(now, 'question answer at');
  return advance(run, 'question_answered', {
    question_id: questionId,
    answer,
    answer_source: answerSource,
    status,
    evidence_item: {
      ...clone(evidenceItem),
      captured_at: at,
    },
    readiness,
    viability,
    discovery_markdown: discoveryMarkdown,
  }, at);
}

/** Open the next monotonic Q-XX only after the previous cursor has resolved. */
export function openNextBuildDiscoveryQuestion(run, {
  question,
  now = () => new Date(),
} = {}) {
  const at = timestamp(now, 'next question asked_at');
  return advance(run, 'next_question_opened', {
    question: {
      ...clone(question),
      status: 'open',
      answer: null,
      answer_source: null,
      asked_at: at,
      answered_at: null,
    },
  }, at);
}

/** Append evidence/concepts/decisions and terminal dispositions without replacing history. */
export function recordBuildDiscoveryLineage(run, {
  concepts,
  evidence,
  decisionsMarkdown,
  readiness,
  viability,
  discoveryMarkdown,
  now = () => new Date(),
} = {}) {
  return advance(run, 'lineage_recorded', {
    concepts,
    evidence,
    decisions_markdown: decisionsMarkdown,
    readiness,
    viability,
    discovery_markdown: discoveryMarkdown,
  }, now);
}

export function interruptBuildDiscovery(
  run,
  { reason, pendingQuestionId = null, now = () => new Date() } = {},
) {
  return advance(run, 'interrupted', {
    reason,
    pending_question_id: pendingQuestionId,
  }, now);
}

/** Host-adapter attestation needed before persisted discovery state regains authority. */
export function attestBuildDiscoveryResume(event) {
  if (!isPlainObject(event) || event.kind !== 'host_build_discovery_resume_event') {
    throw new TypeError('discovery resume requires an observed host resume event');
  }
  if (event.source !== 'cruise_host_adapter') {
    throw new Error('repository or model text cannot attest a Build discovery resume');
  }
  if (!RUN_ID.test(event.run_id)) throw new TypeError('resume run_id is invalid');
  assertDigest(event.state_sha256, 'resume state_sha256');
  assertDigest(event.origin_sha256, 'resume origin_sha256');
  assertDigest(event.repository_baseline_sha256, 'resume repository_baseline_sha256');
  const attestation = deepFreeze({
    kind: 'cruise_opaque_build_discovery_resume_attestation',
    source: event.source,
    interaction_id: nonEmpty(event.interaction_id, 'resume interaction_id'),
    run_id: event.run_id,
    state_sha256: event.state_sha256,
    origin_sha256: event.origin_sha256,
    repository_baseline_sha256: event.repository_baseline_sha256,
    observed_at: timestamp(event.observed_at, 'resume observed_at'),
  });
  RESUME_ATTESTATIONS.add(attestation);
  return attestation;
}

function validateHistoricalAuthorities(state, researchApprovals, researchResults) {
  const approvals = new Map();
  for (const approval of researchApprovals) {
    if (!RESEARCH_APPROVALS.has(approval)) throw new Error('research approval replay requires opaque host attestations');
    approvals.set(`${approval.research_id}:${approval.request_sha256}`, approval);
  }
  const results = new Map();
  for (const result of researchResults) {
    if (!RESEARCH_RESULTS.has(result)) throw new Error('research result replay requires opaque Research closeouts');
    results.set(`${result.research_id}:${result.result_sha256}`, result);
  }
  for (const item of state.snapshot.research_items) {
    if (item.status !== 'waiting_approval') {
      const approval = approvals.get(`${item.id}:${item.request_sha256}`);
      if (!approval || approval.run_id !== state.run_id) {
        throw new Error(`cannot rehydrate ${item.id} without its host-approved scope attestation`);
      }
    }
    if (item.status === 'reconciled') {
      const result = results.get(`${item.id}:${item.result.result_sha256}`);
      if (!result || result.run_id !== state.run_id) {
        throw new Error(`cannot rehydrate ${item.id} without its Research result attestation`);
      }
    }
  }
}

/** Rehydrate validated state. A serialized status alone never recreates authority. */
export function rehydrateBuildDiscovery({
  serializedState,
  resumeAttestation,
  currentOriginSha256,
  currentRepositoryBaselineSha256,
  researchApprovals = [],
  researchResults = [],
} = {}) {
  const state = replayBuildDiscoveryState(serializedState);
  if (!RESUME_ATTESTATIONS.has(resumeAttestation)) {
    throw new Error('rehydration requires an opaque host discovery-resume attestation');
  }
  if (
    resumeAttestation.run_id !== state.run_id ||
    resumeAttestation.state_sha256 !== objectDigest(state) ||
    resumeAttestation.origin_sha256 !== state.origin_sha256 ||
    resumeAttestation.repository_baseline_sha256 !== state.repository_baseline_sha256
  ) {
    throw new Error('resume attestation is stale or bound to another discovery run');
  }
  if (currentOriginSha256 !== state.origin_sha256) {
    throw new Error('immutable Origin changed while Build discovery was interrupted');
  }
  if (currentRepositoryBaselineSha256 !== state.repository_baseline_sha256) {
    throw new Error('repository baseline changed while Build discovery was interrupted');
  }
  validateHistoricalAuthorities(state, researchApprovals, researchResults);
  return brandRun(state);
}

export function resumeBuildDiscovery(
  run,
  { resumeAttestation, now = () => new Date() } = {},
) {
  const state = requireRun(run).state;
  if (!RESUME_ATTESTATIONS.has(resumeAttestation) || CONSUMED_RESUME_ATTESTATIONS.has(resumeAttestation)) {
    throw new Error('resume requires a fresh opaque host attestation');
  }
  if (
    resumeAttestation.run_id !== state.run_id ||
    resumeAttestation.state_sha256 !== objectDigest(state) ||
    resumeAttestation.origin_sha256 !== state.origin_sha256 ||
    resumeAttestation.repository_baseline_sha256 !== state.repository_baseline_sha256
  ) {
    throw new Error('resume attestation does not match the current interrupted discovery state');
  }
  CONSUMED_RESUME_ATTESTATIONS.add(resumeAttestation);
  return advance(run, 'resumed', {
    resume_attestation_sha256: objectDigest(resumeAttestation),
  }, now);
}

/** Deterministically classify research by whether its result can invalidate approval. */
export function classifyBuildDiscoveryResearch({
  feasibilityBlocking = false,
  mandatoryDependencyUnknown = false,
  milestoneInvalidationPossible = false,
  implementationDetailOnly = false,
} = {}) {
  for (const [key, value] of Object.entries({
    feasibilityBlocking,
    mandatoryDependencyUnknown,
    milestoneInvalidationPossible,
    implementationDetailOnly,
  })) {
    if (typeof value !== 'boolean') throw new TypeError(`${key} must be boolean`);
  }
  const blocking = feasibilityBlocking || mandatoryDependencyUnknown || milestoneInvalidationPossible;
  if (blocking && implementationDetailOnly) {
    throw new Error('research cannot be both approval-blocking and implementation-detail-only');
  }
  if (!blocking && !implementationDetailOnly) {
    throw new Error('research classification needs a material approval or implementation impact');
  }
  return deepFreeze({
    type: blocking ? 'pre_approval_blocker' : 'post_approval_prerequisite',
    blocks_build_approval: blocking,
  });
}

export function requestPreApprovalBuildResearch(run, {
  id,
  conceptId,
  question,
  scope,
  decisionImpact,
  classification,
  now = () => new Date(),
} = {}) {
  const current = requireRun(run).state;
  if (!isPlainObject(classification) || classification.type !== 'pre_approval_blocker') {
    throw new Error('active discovery research must be classified as pre_approval_blocker');
  }
  const at = timestamp(now, 'research request created_at');
  const material = {
    id,
    class: classification.type,
    concept_id: conceptId,
    question,
    scope,
    decision_impact: decisionImpact,
    created_at: at,
  };
  const research = {
    ...material,
    status: 'waiting_approval',
    request_sha256: objectDigest(material),
    approval: null,
    result: null,
    updated_at: at,
  };
  return advance(run, 'research_requested', { research }, at);
}

/** Host-only exact structured approval for one displayed pre-approval research scope. */
export function attestPreApprovalResearchScopeApproval(event) {
  if (!isPlainObject(event) || event.kind !== 'host_structured_choice_event') {
    throw new TypeError('pre-approval Research requires an observed structured-choice event');
  }
  if (event.source !== 'request_user_input' || event.input_kind !== 'option_selection') {
    throw new Error('typed or repository text cannot approve a pre-approval Research scope');
  }
  if (event.option_id !== 'approve_research_scope' || event.selected_label !== 'Approve Research Scope') {
    throw new Error('pre-approval Research requires exact Approve Research Scope selection');
  }
  const offered = Array.isArray(event.offered_options) && event.offered_options.some(
    (option) => option?.id === 'approve_research_scope' && option?.label === 'Approve Research Scope',
  );
  if (!offered) throw new Error('exact Research approval option was not displayed');
  if (!RUN_ID.test(event.run_id) || !RESEARCH_ID.test(event.research_id)) {
    throw new TypeError('Research approval run/research identifiers are invalid');
  }
  assertDigest(event.request_sha256, 'Research approval request_sha256');
  const approval = deepFreeze({
    kind: 'cruise_opaque_preapproval_research_scope_approval',
    source: event.source,
    interaction_id: nonEmpty(event.interaction_id, 'Research approval interaction_id'),
    run_id: event.run_id,
    research_id: event.research_id,
    request_sha256: event.request_sha256,
    approved_at: timestamp(event.selected_at, 'Research approval selected_at'),
  });
  RESEARCH_APPROVALS.add(approval);
  return approval;
}

export function startPreApprovalBuildResearch(run, {
  researchId,
  approval,
  now = () => new Date(),
} = {}) {
  const state = requireRun(run).state;
  const item = state.snapshot.research_items.find(({ id }) => id === researchId);
  if (!item) throw new Error(`unknown discovery research item ${researchId}`);
  if (!RESEARCH_APPROVALS.has(approval) || CONSUMED_RESEARCH_APPROVALS.has(approval)) {
    throw new Error('starting pre-approval Research requires a fresh opaque scope approval');
  }
  if (
    approval.run_id !== state.run_id ||
    approval.research_id !== researchId ||
    approval.request_sha256 !== item.request_sha256
  ) {
    throw new Error('pre-approval Research approval is bound to another scope or Build run');
  }
  CONSUMED_RESEARCH_APPROVALS.add(approval);
  return advance(run, 'research_started', {
    research_id: researchId,
    approval: {
      interaction_id: approval.interaction_id,
      request_sha256: approval.request_sha256,
      approved_at: approval.approved_at,
    },
  }, now);
}

/** Adapter attestation for a completed read-only Research result returning to Build. */
export function attestPreApprovalResearchResult(event) {
  if (!isPlainObject(event) || event.kind !== 'cruise_research_closeout_event') {
    throw new TypeError('Research reconciliation requires a Cruise Research closeout event');
  }
  if (event.source !== 'cruise_research_adapter') {
    throw new Error('repository or model text cannot attest a Research closeout');
  }
  if (!RUN_ID.test(event.parent_build_run_id) || !RESEARCH_ID.test(event.research_id)) {
    throw new TypeError('Research closeout identifiers are invalid');
  }
  assertDigest(event.request_sha256, 'Research closeout request_sha256');
  const evidence = validateDiscoveryEvidence(event.evidence, {
    runId: event.parent_build_run_id,
    originSha256: event.origin_sha256,
  });
  const ids = uniqueStrings(event.evidence_ids, 'Research closeout evidence_ids', {
    allowEmpty: false,
    pattern: EVIDENCE_ID,
  });
  const available = new Map(evidence.evidence.map((item) => [item.id, item]));
  for (const id of ids) {
    const item = available.get(id);
    if (!item || item.type !== 'research_finding' || item.research_item_id !== event.research_id) {
      throw new Error(`Research closeout evidence ${id} is not a finding for ${event.research_id}`);
    }
  }
  if (!['supports', 'contradicts', 'inconclusive'].includes(event.conclusion)) {
    throw new TypeError('Research closeout conclusion is unsupported');
  }
  const material = {
    run_id: event.parent_build_run_id,
    origin_sha256: event.origin_sha256,
    research_id: event.research_id,
    request_sha256: event.request_sha256,
    evidence_sha256: objectDigest(evidence),
    evidence_ids: ids,
    conclusion: event.conclusion,
    completed_at: timestamp(event.completed_at, 'Research closeout completed_at'),
  };
  const result = deepFreeze({
    kind: 'cruise_opaque_preapproval_research_result',
    source: event.source,
    ...material,
    result_sha256: objectDigest(material),
  });
  RESEARCH_RESULTS.add(result);
  return result;
}

export function reconcilePreApprovalBuildResearch(run, {
  result,
  concepts,
  readiness,
  viability,
  evidence,
  questions,
  decisionsMarkdown,
  discoveryMarkdown,
  now = () => new Date(),
} = {}) {
  const state = requireRun(run).state;
  if (!RESEARCH_RESULTS.has(result) || CONSUMED_RESEARCH_RESULTS.has(result)) {
    throw new Error('Research reconciliation requires a fresh opaque Research result');
  }
  const item = state.snapshot.research_items.find(({ id }) => id === result.research_id);
  if (
    !item ||
    item.status !== 'in_progress' ||
    result.run_id !== state.run_id ||
    result.origin_sha256 !== state.origin_sha256 ||
    result.request_sha256 !== item.request_sha256
  ) {
    throw new Error('Research result cannot return to a different or stale Build discovery run');
  }
  if (objectDigest(validateDiscoveryEvidence(evidence, {
    runId: state.run_id,
    originSha256: state.origin_sha256,
  })) !== result.evidence_sha256) {
    throw new Error('reconciled EVIDENCE.yaml differs from the attested Research result');
  }
  CONSUMED_RESEARCH_RESULTS.add(result);
  return advance(run, 'research_reconciled', {
    research_id: result.research_id,
    result: {
      result_sha256: result.result_sha256,
      conclusion: result.conclusion,
      evidence_ids: result.evidence_ids,
      completed_at: result.completed_at,
    },
    concepts,
    readiness,
    viability,
    evidence,
    questions,
    decisions_markdown: decisionsMarkdown,
    discovery_markdown: discoveryMarkdown,
  }, now);
}

/** Mint drafting-only authority. It cannot approve artifacts, touch product code, or activate Goal. */
export function authorizeAutomaticBuildDrafting(run, {
  currentOriginSha256,
  currentRepositoryBaselineSha256,
  now = () => new Date(),
} = {}) {
  const state = requireRun(run).state;
  const snapshot = state.snapshot;
  if (snapshot.status !== 'ready_for_build' || snapshot.viability.outcome !== 'ready_for_build') {
    throw new Error('automatic Build drafting requires every deterministic viability hard gate to pass');
  }
  if (snapshot.cursor.interrupted) throw new Error('interrupted discovery must resume before drafting');
  if (currentOriginSha256 !== state.origin_sha256) throw new Error('Origin changed before automatic drafting');
  if (currentRepositoryBaselineSha256 !== state.repository_baseline_sha256) {
    throw new Error('repository baseline changed before automatic drafting');
  }
  if (snapshot.research_items.some(({ class: type, status }) =>
    type === 'pre_approval_blocker' && status !== 'reconciled')) {
    throw new Error('unreconciled pre-approval Research blocks Build drafting');
  }
  validateSnapshot(snapshot, { runId: state.run_id, originSha256: state.origin_sha256 });
  const authority = deepFreeze({
    kind: 'cruise_opaque_automatic_build_drafting_authority',
    run_id: state.run_id,
    origin_sha256: state.origin_sha256,
    repository_baseline_sha256: state.repository_baseline_sha256,
    snapshot_sha256: snapshotDigest(snapshot),
    selected_concept_id: snapshot.concepts.selected_concept_id,
    scope: 'draft_build_artifacts_only',
    approves_artifacts: false,
    permits_product_writes: false,
    permits_goal_activation: false,
    issued_at: timestamp(now, 'draft authority issued_at'),
  });
  DRAFT_AUTHORITIES.add(authority);
  return authority;
}

function exactLineageSet(actualInput, expectedInput, label) {
  const actual = [...new Set(actualInput)].sort((left, right) => left.localeCompare(right, 'en'));
  const expected = [...new Set(expectedInput)].sort((left, right) => left.localeCompare(right, 'en'));
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(
      `${label} differs: expected [${expected.join(', ')}], received [${actual.join(', ')}]`,
    );
  }
  return actual;
}

function identifierHeadingBlocks(markdown, expression, label) {
  const matches = [...markdown.matchAll(
    /^##\s+((?:R|D)-\d{2,})(?:\s+[-—:].*|\s+.*)?\s*$([\s\S]*?)(?=^##\s+(?:R|D)-\d{2,}|(?![\s\S]))/gmu,
  )].filter((match) => expression.test(match[1]));
  if (matches.length === 0) throw new Error(`${label} contains no identifier sections`);
  return matches.map((match) => ({ id: match[1], body: match[2] }));
}

function recordContainsText(value, expected) {
  if (typeof value === 'string') return value.includes(expected);
  if (Array.isArray(value)) return value.some((entry) => recordContainsText(entry, expected));
  if (isPlainObject(value)) {
    return Object.values(value).some((entry) => recordContainsText(entry, expected));
  }
  return false;
}

async function validateAutomaticDraftLineage({
  repositoryRoot,
  snapshot,
  manifest,
  semanticValidation,
}) {
  const bodies = new Map();
  for (const artifact of manifest.artifacts) {
    const bytes = await readRegularFile(join(repositoryRoot, artifact.path));
    if (digest(bytes) !== artifact.sha256) {
      throw new Error(`automatic draft lineage reread found changed bytes: ${artifact.path}`);
    }
    bodies.set(artifact.path, bytes);
  }

  const decisionPaths = [...bodies.keys()].filter((path) => path.endsWith('/DECISIONS.md'));
  const finalDecisions = [];
  for (const path of decisionPaths) {
    let parsed;
    try {
      parsed = decisionBlocks(bodies.get(path).toString('utf8'));
    } catch (cause) {
      throw new Error(
        `${path} does not preserve complete discovery decision lineage: ${cause.message}`,
        { cause },
      );
    }
    finalDecisions.push(...parsed.map((decision) => ({ ...decision, path })));
  }
  const finalDecisionIds = finalDecisions.map(({ id }) => id);
  if (new Set(finalDecisionIds).size !== finalDecisionIds.length) {
    throw new Error('automatic Build drafts reuse a D-XX decision ID across final artifacts');
  }
  exactLineageSet(finalDecisionIds, manifest.decision_ids, 'draft manifest decision IDs');
  const discoveryDecisions = validateDiscoveryDecisions(snapshot.decisions_markdown, {
    concepts: snapshot.concepts,
    evidence: snapshot.evidence,
    viabilityOutcome: snapshot.viability.outcome,
  }).decisions;
  const finalByDecisionId = new Map(finalDecisions.map((decision) => [decision.id, decision]));
  for (const discoveryDecision of discoveryDecisions) {
    const finalDecision = finalByDecisionId.get(discoveryDecision.id);
    if (!finalDecision) {
      throw new Error(`automatic Build drafts dropped discovery decision ${discoveryDecision.id}`);
    }
    const { path: ignored, ...comparable } = finalDecision;
    void ignored;
    if (canonicalJson(comparable) !== canonicalJson(discoveryDecision)) {
      throw new Error(
        `automatic Build drafts reused or rewrote discovery decision ${discoveryDecision.id}`,
      );
    }
  }
  const discoveryConceptIds = snapshot.concepts.concepts
    .filter(({ status }) => ['selected', 'rejected'].includes(status))
    .map(({ id }) => id);
  exactLineageSet(
    finalDecisions.map(({ concept_id: conceptId }) => conceptId),
    discoveryConceptIds,
    'selected/rejected concept lineage in final DECISIONS.md',
  );

  const requirementPaths = [...bodies.keys()].filter((path) => path.endsWith('/REQUIREMENTS.md'));
  const requirements = requirementPaths.flatMap((path) =>
    identifierHeadingBlocks(
      bodies.get(path).toString('utf8'),
      /^R-\d{2,}$/u,
      path,
    ).map((entry) => ({ ...entry, path })));
  const requirementIds = requirements.map(({ id }) => id);
  if (new Set(requirementIds).size !== requirementIds.length) {
    throw new Error('automatic Build drafts reuse an R-XX requirement ID');
  }
  exactLineageSet(requirementIds, manifest.requirement_ids, 'draft manifest requirement IDs');
  const acceptanceIds = requirements.flatMap(({ body }) =>
    [...body.matchAll(/(?:^|[^A-Za-z0-9_-])(AC-\d{2,})(?![A-Za-z0-9_-])/gmu)]
      .map((match) => match[1]));
  exactLineageSet(
    acceptanceIds,
    manifest.acceptance_criteria_ids,
    'draft manifest acceptance-criterion IDs',
  );
  const acceptedDiscoveryIds = new Set(
    discoveryDecisions.filter(({ status }) => status === 'accepted').map(({ id }) => id),
  );
  for (const requirement of requirements) {
    const linkedDecisions = [...requirement.body.matchAll(
      /(?:^|[^A-Za-z0-9_-])(D-\d{2,})(?![A-Za-z0-9_-])/gmu,
    )].map((match) => match[1]);
    const linkedAcceptance = [...requirement.body.matchAll(
      /(?:^|[^A-Za-z0-9_-])(AC-\d{2,})(?![A-Za-z0-9_-])/gmu,
    )].map((match) => match[1]);
    if (
      !linkedDecisions.some((id) => acceptedDiscoveryIds.has(id)) ||
      linkedAcceptance.length === 0
    ) {
      throw new Error(
        `${requirement.path} ${requirement.id} does not map an accepted discovery D-XX decision to AC-XX evidence`,
      );
    }
  }

  const phaseQuestions = semanticValidation.draft.questions.filter((question) =>
    ['open', 'deferred'].includes(question.status) &&
    ['phase_blocking', 'nonblocking'].includes(question.materiality));
  exactLineageSet(
    phaseQuestions.map(({ question }) => question),
    manifest.phase_local_questions,
    'phase-local question lineage',
  );
  for (const question of phaseQuestions) {
    if (!question.affects.some((id) => semanticValidation.draft.milestone_phase_dag.phase_ids.includes(id))) {
      throw new Error(`${question.id} does not defer to a generated milestone phase`);
    }
  }

  const selectedConcept = snapshot.concepts.concepts.find(
    ({ id }) => id === snapshot.concepts.selected_concept_id,
  );
  const reconciledPreApproval = new Set(snapshot.research_items
    .filter(({ class: type, status }) => type === 'pre_approval_blocker' && status === 'reconciled')
    .map(({ question }) => question));
  const expectedResearch = [
    ...selectedConcept.research_questions.filter((question) => !reconciledPreApproval.has(question)),
    ...snapshot.research_items
      .filter(({ class: type }) => type === 'post_approval_prerequisite')
      .map(({ question }) => question),
  ];
  exactLineageSet(
    manifest.research_prerequisites,
    expectedResearch,
    'post-approval research prerequisite lineage',
  );
  const queuedResearch = semanticValidation.queue_definitions.flatMap(({ definition }) =>
    definition.items.filter(({ skill }) => skill === 'research'));
  for (const question of expectedResearch) {
    const matches = queuedResearch.filter((item) => recordContainsText(item, question));
    if (matches.length !== 1) {
      throw new Error(
        `research prerequisite must map to exactly one queued Research item: ${question}`,
      );
    }
  }
  for (const item of queuedResearch) {
    if (!expectedResearch.some((question) => recordContainsText(item, question))) {
      throw new Error(`${item.id} is unrelated to discovery research prerequisites`);
    }
  }

  const registryPath = '.cruise/project/ID-REGISTRY.yaml';
  const registry = parseYaml(bodies.get(registryPath).toString('utf8'));
  validateBuildIdRegistry(registry);
  const lockedPaths = new Set(semanticValidation.artifacts.map(({ path }) => path));
  const scannedArtifacts = [];
  for (const path of [...lockedPaths].filter((candidate) => candidate !== registryPath)) {
    scannedArtifacts.push({ path, content: bodies.get(path) });
  }
  const scan = scanBuildIdentifiers(scannedArtifacts);
  const registryById = new Map(registry.records.map((record) => [record.id, record]));
  for (const occurrence of scan) {
    const record = registryById.get(occurrence.id);
    if (
      !record ||
      record.status !== 'active' ||
      (!record.origin_bound &&
        canonicalJson(record.source_paths) !== canonicalJson(occurrence.source_paths))
    ) {
      throw new Error(
        `ID-REGISTRY.yaml does not preserve exact active source lineage for ${occurrence.id}`,
      );
    }
  }
  for (const conceptId of discoveryConceptIds) {
    if (!registryById.has(conceptId)) {
      throw new Error(`ID-REGISTRY.yaml dropped discovery concept ${conceptId}`);
    }
  }
  return deepFreeze({
    selected_concept_id: snapshot.concepts.selected_concept_id,
    rejected_concept_ids: clone(manifest.rejected_concept_ids),
    decision_ids: [...new Set(finalDecisionIds)],
    requirement_ids: [...new Set(requirementIds)],
    acceptance_criteria_ids: [...new Set(acceptanceIds)],
    phase_question_ids: phaseQuestions.map(({ id }) => id),
    research_queue_item_ids: queuedResearch.map(({ id }) => id),
    registry_revision: registry.revision,
  });
}

export async function recordAutomaticBuildDrafts(run, {
  root,
  authority,
  manifest,
  currentRepositoryBaselineSha256,
  now = () => new Date(),
} = {}) {
  const state = requireRun(run).state;
  if (!DRAFT_AUTHORITIES.has(authority) || CONSUMED_DRAFT_AUTHORITIES.has(authority)) {
    throw new Error('draft recording requires a fresh opaque automatic-drafting authority');
  }
  if (
    authority.run_id !== state.run_id ||
    authority.origin_sha256 !== state.origin_sha256 ||
    authority.repository_baseline_sha256 !== state.repository_baseline_sha256 ||
    authority.snapshot_sha256 !== snapshotDigest(state.snapshot) ||
    authority.scope !== 'draft_build_artifacts_only' ||
    authority.approves_artifacts !== false ||
    authority.permits_product_writes !== false ||
    authority.permits_goal_activation !== false
  ) {
    throw new Error('automatic-drafting authority is stale or has expanded scope');
  }
  if (currentRepositoryBaselineSha256 !== state.repository_baseline_sha256) {
    throw new Error('caller-observed product baseline is stale before draft verification');
  }
  const repositoryRoot = await realpath(resolve(root));
  const before = captureRepositoryBaseline(repositoryRoot).sha256;
  if (before !== state.repository_baseline_sha256) {
    throw new Error('product repository baseline changed before draft verification');
  }
  const normalizedManifest = validateDraftManifest(manifest, state.snapshot);
  const milestoneRoots = new Set(normalizedManifest.artifacts
    .map(({ path }) => path.match(/^(\.cruise\/milestones\/M-\d{2,}-[a-z0-9][a-z0-9-]*)\//u)?.[1] ?? null)
    .filter(Boolean));
  if (milestoneRoots.size !== 1) {
    throw new Error('draft manifest must resolve one milestone root for semantic validation');
  }
  const milestoneRoot = [...milestoneRoots][0];
  const semanticValidation = await validateBuildDraftSemantics({
    root: repositoryRoot,
    mode: state.snapshot.mode_candidate,
    contractDirectory: state.snapshot.mode_candidate === 'bootstrap'
      ? '.cruise/project'
      : milestoneRoot,
    repositoryBaselineDigest: state.repository_baseline_sha256,
    approvalReadinessDigest: normalizedManifest.approval_readiness_digest,
    firstMilestoneDirectory: state.snapshot.mode_candidate === 'bootstrap' ? milestoneRoot : null,
    milestonePhaseDag: normalizedManifest.milestone_phase_dag,
  });
  const validatedArtifacts = new Map([
    ...semanticValidation.artifacts,
    ...semanticValidation.mutable_state_snapshots,
  ].map(({ path, sha256 }) => [path, sha256]));
  if (validatedArtifacts.size !== normalizedManifest.artifacts.length) {
    throw new Error('semantic Build validation did not cover the complete draft manifest');
  }
  for (const artifact of normalizedManifest.artifacts) {
    const validatedSha256 = validatedArtifacts.get(artifact.path);
    if (validatedSha256 === undefined) {
      throw new Error(`semantic Build validation omitted draft artifact: ${artifact.path}`);
    }
    if (validatedSha256 !== artifact.sha256) {
      throw new Error(`draft artifact bytes do not match declared SHA-256: ${artifact.path}`);
    }
  }
  const targetOriginPath = state.snapshot.mode_candidate === 'bootstrap'
    ? '.cruise/project/ORIGIN.yaml'
    : `${milestoneRoot}/ORIGIN.yaml`;
  if (validatedArtifacts.get(targetOriginPath) !== state.origin_sha256) {
    throw new Error('automatic draft target ORIGIN.yaml is not the immutable discovery Origin byte copy');
  }
  const lineage = await validateAutomaticDraftLineage({
    repositoryRoot,
    snapshot: state.snapshot,
    manifest: normalizedManifest,
    semanticValidation,
  });
  const after = captureRepositoryBaseline(repositoryRoot).sha256;
  if (after !== before) {
    throw new Error('product repository baseline changed while draft artifacts were inspected');
  }
  CONSUMED_DRAFT_AUTHORITIES.add(authority);
  return advance(run, 'drafts_generated', {
    manifest: normalizedManifest,
    authority_sha256: objectDigest(authority),
    semantic_validation_sha256: objectDigest(semanticValidation),
    lineage_sha256: objectDigest(lineage),
  }, now);
}

function portable(path) {
  return path.split(sep).join('/');
}

function validateDiscoveryDirectory(path, snapshot) {
  const normalized = portable(path).replace(/^\.\//u, '').replace(/\/$/u, '');
  if (snapshot.mode_candidate === 'bootstrap') {
    if (normalized !== '.cruise/project/discovery') {
      throw new Error('bootstrap discovery artifacts must persist under .cruise/project/discovery');
    }
  } else {
    const pattern = new RegExp(`^\\.cruise/milestones/${snapshot.milestone_id}-[a-z0-9][a-z0-9-]*/discovery$`, 'u');
    if (!pattern.test(normalized)) {
      throw new Error('milestone discovery artifacts must persist under its canonical milestone discovery path');
    }
  }
  return normalized;
}

async function assertSafeDirectoryChain(root, target, { create = false } = {}) {
  const rel = portable(relative(root, target));
  if (!rel || rel === '..' || rel.startsWith('../')) throw new Error('discovery path escapes repository root');
  let cursor = root;
  for (const component of rel.split('/')) {
    cursor = join(cursor, component);
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink()) throw new Error(`refusing symlink in discovery persistence path: ${cursor}`);
      if (!metadata.isDirectory()) throw new Error(`discovery persistence parent is not a directory: ${cursor}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (!create) throw error;
      let createdHere = false;
      try {
        await mkdir(cursor, { mode: 0o700 });
        createdHere = true;
      } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      }
      const created = await lstat(cursor);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error(`discovery persistence parent is not a safe directory: ${cursor}`);
      }
      if (createdHere) await syncDirectory(dirname(cursor));
    }
  }
}

async function readRegularFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`expected regular file: ${path}`);
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) throw new Error(`file changed while reading: ${path}`);
    return bytes;
  } finally {
    await handle.close();
  }
}

const DISCOVERY_ARTIFACT_NAMES = Object.freeze([
  'ORIGIN.yaml',
  'CONCEPTS.yaml',
  'QUESTIONS.yaml',
  'EVIDENCE.yaml',
  'DECISIONS.md',
  'DISCOVERY.md',
]);
const DISCOVERY_HEAD_NAME = 'BUILD-DISCOVERY.yaml';
const DISCOVERY_HISTORY_NAME = 'BUILD-DISCOVERY-HISTORY';
const DISCOVERY_PENDING_NAME = 'BUILD-DISCOVERY-PENDING.yaml';
const DISCOVERY_LINEAGE_NAME = 'BUILD-DISCOVERY-LINEAGE.yaml';
const DISCOVERY_LOCK_NAME = 'BUILD-DISCOVERY.lock';
const DISCOVERY_GENERATION = /^REV-(\d{12})-([a-f0-9]{64})$/u;

async function syncDirectory(path) {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function directoryIdentity(path, label) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a regular no-follow directory`);
  }
  if (await realpath(path) !== path) throw new Error(`${label} must not traverse a symbolic link`);
  return { dev: metadata.dev, ino: metadata.ino };
}

async function assertDirectoryIdentity(path, expected, label) {
  const current = await directoryIdentity(path, label);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`${label} changed during discovery persistence`);
  }
}

async function readRegularFileIfExists(path) {
  try {
    return await readRegularFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function invokePersistenceFault(faultInjector, step) {
  if (faultInjector != null) await faultInjector(step);
}

async function writeNewFile(path, bytes, mode = 0o600) {
  const handle = await open(
    path,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0),
    mode,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicReplace({
  path,
  bytes,
  temporaryPath,
  parentIdentity,
  label,
  faultInjector = null,
  preparedStep = null,
  committedStep = null,
}) {
  const parent = dirname(path);
  try {
    const target = await lstat(path);
    if (target.isSymbolicLink() || (!target.isFile() && !target.isDirectory())) {
      throw new Error(`${label} target is not a safe regular path`);
    }
    if (target.isDirectory()) throw new Error(`${label} target is an unexpected directory`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await rm(temporaryPath, { force: true });
  let prepared = false;
  try {
    await writeNewFile(temporaryPath, bytes);
    prepared = true;
    if (preparedStep != null) await invokePersistenceFault(faultInjector, preparedStep);
    await assertDirectoryIdentity(parent, parentIdentity, `${label} parent`);
    await rename(temporaryPath, path);
    prepared = false;
    await syncDirectory(parent);
    await assertDirectoryIdentity(parent, parentIdentity, `${label} parent`);
    if (committedStep != null) await invokePersistenceFault(faultInjector, committedStep);
  } finally {
    if (prepared) await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function checkpointLocations(repositoryRoot, runId) {
  const stateDirectory = resolve(repositoryRoot, '.cruise/runs', runId);
  return {
    repository_root: repositoryRoot,
    state_directory: stateDirectory,
    history_directory: join(stateDirectory, DISCOVERY_HISTORY_NAME),
    head_path: join(stateDirectory, DISCOVERY_HEAD_NAME),
    pending_path: join(stateDirectory, DISCOVERY_PENDING_NAME),
    pending_temp_path: join(stateDirectory, '.BUILD-DISCOVERY-PENDING.tmp'),
    lineage_path: join(stateDirectory, DISCOVERY_LINEAGE_NAME),
    lineage_temp_path: join(stateDirectory, '.BUILD-DISCOVERY-LINEAGE.tmp'),
    lock_path: join(stateDirectory, DISCOVERY_LOCK_NAME),
  };
}

async function assertDiscoveryRepositoryBinding(state, repositoryRoot) {
  const originRecord = parseYaml(state.origin_yaml);
  validateOriginRecord(originRecord);
  const recordedRoot = nonEmpty(
    originRecord.repository_baseline.root,
    'Build discovery Origin repository_baseline.root',
  );
  if (!isAbsolute(recordedRoot) || resolve(recordedRoot) !== repositoryRoot) {
    throw new Error(
      'Build discovery persistence root does not match Origin repository_baseline.root',
    );
  }
  let canonicalRecordedRoot;
  try {
    canonicalRecordedRoot = await realpath(recordedRoot);
  } catch (cause) {
    throw new Error(
      'Build discovery Origin repository_baseline.root cannot be independently verified',
      { cause },
    );
  }
  if (canonicalRecordedRoot !== repositoryRoot) {
    throw new Error(
      'Build discovery persistence root does not match Origin repository_baseline.root',
    );
  }
}

function parseWriterLock(bytes, runId) {
  const record = parseYaml(bytes.toString('utf8'));
  exactKeys(
    record,
    ['schema_version', 'kind', 'run_id', 'pid', 'nonce', 'acquired_at'],
    'Build discovery writer lock',
  );
  if (
    record.schema_version !== 1 ||
    record.kind !== 'cruise_build_discovery_writer_lock' ||
    record.run_id !== runId ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0
  ) {
    throw new Error('Build discovery writer lock is invalid or belongs elsewhere');
  }
  nonEmpty(record.nonce, 'Build discovery writer lock nonce');
  timestamp(record.acquired_at, 'Build discovery writer lock acquired_at');
  return record;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function acquireDiscoveryWriterLock(locations, runId) {
  const stateIdentity = await directoryIdentity(
    locations.state_directory,
    'Build discovery state directory',
  );
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const nonce = randomUUID();
    const metadata = {
      schema_version: 1,
      kind: 'cruise_build_discovery_writer_lock',
      run_id: runId,
      pid: process.pid,
      nonce,
      acquired_at: new Date().toISOString(),
    };
    const bytes = Buffer.from(stringifyYaml(metadata), 'utf8');
    const temporaryPath = join(
      locations.state_directory,
      `.BUILD-DISCOVERY.lock.${process.pid}.${nonce}.tmp`,
    );
    await writeNewFile(temporaryPath, bytes, 0o400);
    try {
      await assertDirectoryIdentity(
        locations.state_directory,
        stateIdentity,
        'Build discovery state directory',
      );
      await link(temporaryPath, locations.lock_path);
      await syncDirectory(locations.state_directory);
      return { metadata, file_sha256: digest(bytes) };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }

    let existingBytes;
    try {
      existingBytes = await readRegularFile(locations.lock_path);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const existing = parseWriterLock(existingBytes, runId);
    if (processIsAlive(existing.pid)) {
      throw new Error(`Build discovery checkpoint has an active writer process ${existing.pid}`);
    }
    const confirmed = await readRegularFile(locations.lock_path);
    if (!confirmed.equals(existingBytes)) {
      throw new Error('Build discovery writer lock changed while reclaiming a dead writer');
    }
    await rm(locations.lock_path);
    await syncDirectory(locations.state_directory);
  }
  throw new Error('could not acquire the Build discovery writer lock');
}

async function releaseDiscoveryWriterLock(locations, runId, lock) {
  if (lock == null) return;
  const current = await readRegularFileIfExists(locations.lock_path);
  if (current == null) return;
  const metadata = parseWriterLock(current, runId);
  if (
    metadata.nonce !== lock.metadata.nonce ||
    digest(current) !== lock.file_sha256
  ) {
    throw new Error('Build discovery writer lock was replaced while held');
  }
  await rm(locations.lock_path);
  await syncDirectory(locations.state_directory);
}

function discoveryArtifactContents(state) {
  return {
    'ORIGIN.yaml': Buffer.from(state.origin_yaml, 'utf8'),
    'CONCEPTS.yaml': Buffer.from(stringifyYaml(state.snapshot.concepts), 'utf8'),
    'QUESTIONS.yaml': Buffer.from(stringifyYaml(state.snapshot.questions), 'utf8'),
    'EVIDENCE.yaml': Buffer.from(stringifyYaml(state.snapshot.evidence), 'utf8'),
    'DECISIONS.md': Buffer.from(
      state.snapshot.decisions_markdown.endsWith('\n')
        ? state.snapshot.decisions_markdown
        : `${state.snapshot.decisions_markdown}\n`,
      'utf8',
    ),
    'DISCOVERY.md': Buffer.from(
      state.snapshot.discovery_markdown.endsWith('\n')
        ? state.snapshot.discovery_markdown
        : `${state.snapshot.discovery_markdown}\n`,
      'utf8',
    ),
  };
}

function discoveryArtifactDigests(contents) {
  return Object.fromEntries(
    DISCOVERY_ARTIFACT_NAMES.map((name) => [name, digest(contents[name])]),
  );
}

function generationName(revision, stateSha256) {
  return `REV-${String(revision).padStart(12, '0')}-${stateSha256}`;
}

function persistedEnvelope({
  state,
  artifacts,
  directory,
  revision,
  generation,
  previousGeneration,
  previousHeadSha256,
}) {
  return {
    schema_version: 2,
    kind: 'cruise_persisted_build_discovery',
    run_id: state.run_id,
    origin_sha256: state.origin_sha256,
    repository_baseline_sha256: state.repository_baseline_sha256,
    directory,
    persistence: {
      revision,
      generation,
      previous_generation: previousGeneration,
      previous_head_sha256: previousHeadSha256,
      state_sha256: objectDigest(state),
    },
    artifacts,
    state,
  };
}

function validateArtifactDigestMap(artifacts, label) {
  exactKeys(artifacts, DISCOVERY_ARTIFACT_NAMES, label);
  for (const name of DISCOVERY_ARTIFACT_NAMES) {
    assertDigest(artifacts[name], `${label}.${name}`);
  }
}

function parsePersistedEnvelope(bytes, runId = null) {
  const envelope = parseYaml(bytes.toString('utf8'));
  exactKeys(
    envelope,
    [
      'schema_version',
      'kind',
      'run_id',
      'origin_sha256',
      'repository_baseline_sha256',
      'directory',
      'persistence',
      'artifacts',
      'state',
    ],
    'persisted Build discovery envelope',
  );
  if (envelope.schema_version !== 2 || envelope.kind !== 'cruise_persisted_build_discovery') {
    throw new Error('persisted Build discovery envelope kind/version is invalid');
  }
  if (!RUN_ID.test(envelope.run_id) || (runId != null && envelope.run_id !== runId)) {
    throw new Error('persisted Build discovery run ID mismatch');
  }
  const state = replayBuildDiscoveryState(envelope.state);
  if (
    envelope.origin_sha256 !== state.origin_sha256 ||
    envelope.repository_baseline_sha256 !== state.repository_baseline_sha256
  ) {
    throw new Error('persisted Build discovery envelope bindings differ from its state');
  }
  const directory = validateDiscoveryDirectory(envelope.directory, state.snapshot);
  if (directory !== envelope.directory) {
    throw new Error('persisted Build discovery directory is not canonical');
  }
  validateArtifactDigestMap(envelope.artifacts, 'persisted discovery artifact digests');
  exactKeys(
    envelope.persistence,
    [
      'revision',
      'generation',
      'previous_generation',
      'previous_head_sha256',
      'state_sha256',
    ],
    'persisted Build discovery lineage',
  );
  const revision = envelope.persistence.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('persisted Build discovery revision must be a non-negative integer');
  }
  const stateSha256 = assertDigest(
    envelope.persistence.state_sha256,
    'persisted Build discovery state_sha256',
  );
  if (stateSha256 !== objectDigest(state)) {
    throw new Error('persisted Build discovery state digest differs from replayed state');
  }
  const match = DISCOVERY_GENERATION.exec(envelope.persistence.generation);
  if (
    match == null ||
    Number(match[1]) !== revision ||
    match[2] !== stateSha256
  ) {
    throw new Error('persisted Build discovery generation does not bind its revision/state');
  }
  if (revision === 0) {
    if (
      envelope.persistence.previous_generation !== null ||
      envelope.persistence.previous_head_sha256 !== null
    ) {
      throw new Error('Build discovery revision zero cannot name a predecessor');
    }
  } else {
    if (!DISCOVERY_GENERATION.test(envelope.persistence.previous_generation)) {
      throw new Error('Build discovery checkpoint lacks its previous generation');
    }
    assertDigest(
      envelope.persistence.previous_head_sha256,
      'Build discovery previous head digest',
    );
  }
  return { envelope: { ...envelope, state }, state };
}

function validateDiscoveryArtifactBytes(contents, artifacts, state) {
  for (const name of DISCOVERY_ARTIFACT_NAMES) {
    if (!Buffer.isBuffer(contents[name]) || digest(contents[name]) !== artifacts[name]) {
      throw new Error(`${name} changed after the discovery checkpoint`);
    }
  }
  const loaded = Object.fromEntries(
    DISCOVERY_ARTIFACT_NAMES.map((name) => [name, contents[name].toString('utf8')]),
  );
  if (loaded['ORIGIN.yaml'] !== state.origin_yaml) {
    throw new Error('persisted ORIGIN.yaml differs from immutable discovery Origin bytes');
  }
  if (canonicalJson(parseYaml(loaded['CONCEPTS.yaml'])) !== canonicalJson(state.snapshot.concepts)) {
    throw new Error('persisted CONCEPTS.yaml differs from replayed discovery state');
  }
  if (canonicalJson(parseYaml(loaded['EVIDENCE.yaml'])) !== canonicalJson(state.snapshot.evidence)) {
    throw new Error('persisted EVIDENCE.yaml differs from replayed discovery state');
  }
  if (canonicalJson(parseYaml(loaded['QUESTIONS.yaml'])) !== canonicalJson(state.snapshot.questions)) {
    throw new Error('persisted QUESTIONS.yaml differs from replayed discovery state');
  }
  if (loaded['DECISIONS.md'].trimEnd() !== state.snapshot.decisions_markdown.trimEnd()) {
    throw new Error('persisted DECISIONS.md differs from replayed discovery state');
  }
  if (loaded['DISCOVERY.md'].trimEnd() !== state.snapshot.discovery_markdown.trimEnd()) {
    throw new Error('persisted DISCOVERY.md differs from replayed discovery state');
  }
}

function assertDiscoveryCheckpointDescendant(previous, candidate, { allowSame = true } = {}) {
  for (const field of [
    'schema_version',
    'kind',
    'run_id',
    'origin_yaml',
    'origin_sha256',
    'repository_baseline_sha256',
    'initial_snapshot',
    'created_at',
  ]) {
    if (canonicalJson(previous[field]) !== canonicalJson(candidate[field])) {
      throw new Error(`Build discovery checkpoint changes immutable ${field}`);
    }
  }
  if (candidate.history.length < previous.history.length) {
    throw new Error('stale Build discovery ancestor cannot overwrite a newer checkpoint');
  }
  if (
    canonicalJson(candidate.history.slice(0, previous.history.length)) !==
    canonicalJson(previous.history)
  ) {
    throw new Error('Build discovery checkpoint forks from persisted event history');
  }
  if (candidate.history.length === previous.history.length) {
    if (!allowSame || canonicalJson(candidate) !== canonicalJson(previous)) {
      throw new Error('Build discovery checkpoint is not a strict successor of persisted state');
    }
    return 'same';
  }
  return 'descendant';
}

async function exactDirectoryEntries(path, expected, label) {
  const actual = (await readdir(path)).sort((left, right) => left.localeCompare(right, 'en'));
  const normalizedExpected = [...expected].sort((left, right) => left.localeCompare(right, 'en'));
  if (canonicalJson(actual) !== canonicalJson(normalizedExpected)) {
    throw new Error(`${label} entries differ from its immutable manifest`);
  }
}

async function readGeneration(locations, name) {
  if (!DISCOVERY_GENERATION.test(name)) throw new Error('invalid Build discovery generation name');
  await assertSafeDirectoryChain(
    locations.repository_root,
    locations.history_directory,
  );
  const generationDirectory = resolve(locations.history_directory, name);
  await assertSafeDirectoryChain(locations.repository_root, generationDirectory);
  const identity = await directoryIdentity(
    generationDirectory,
    `Build discovery generation ${name}`,
  );
  await exactDirectoryEntries(
    generationDirectory,
    [...DISCOVERY_ARTIFACT_NAMES, DISCOVERY_HEAD_NAME],
    `Build discovery generation ${name}`,
  );
  const envelopeBytes = await readRegularFile(join(generationDirectory, DISCOVERY_HEAD_NAME));
  const { envelope, state } = parsePersistedEnvelope(envelopeBytes);
  if (envelope.persistence.generation !== name) {
    throw new Error(`Build discovery generation ${name} contains another generation`);
  }
  const contents = {};
  for (const artifactName of DISCOVERY_ARTIFACT_NAMES) {
    contents[artifactName] = await readRegularFile(join(generationDirectory, artifactName));
  }
  await assertDirectoryIdentity(
    generationDirectory,
    identity,
    `Build discovery generation ${name}`,
  );
  validateDiscoveryArtifactBytes(contents, envelope.artifacts, state);
  return {
    envelope,
    envelope_bytes: envelopeBytes,
    head_sha256: digest(envelopeBytes),
    contents,
    state,
  };
}

async function validateCanonicalArtifacts(locations, checkpoint) {
  const artifactDirectory = resolve(locations.repository_root, checkpoint.envelope.directory);
  await assertSafeDirectoryChain(locations.repository_root, artifactDirectory);
  const identity = await directoryIdentity(artifactDirectory, 'canonical discovery artifact directory');
  await exactDirectoryEntries(
    artifactDirectory,
    DISCOVERY_ARTIFACT_NAMES,
    'canonical discovery artifact directory',
  );
  const contents = {};
  for (const name of DISCOVERY_ARTIFACT_NAMES) {
    contents[name] = await readRegularFile(join(artifactDirectory, name));
    if (!contents[name].equals(checkpoint.contents[name])) {
      throw new Error(`${name} changed after the discovery checkpoint`);
    }
  }
  await assertDirectoryIdentity(
    artifactDirectory,
    identity,
    'canonical discovery artifact directory',
  );
  validateDiscoveryArtifactBytes(contents, checkpoint.envelope.artifacts, checkpoint.state);
}

async function readVersionTwoCheckpoint(
  locations,
  headBytes,
  { requestedDirectory = null, validateCanonical = true } = {},
) {
  const parsed = parsePersistedEnvelope(headBytes, locations.run_id);
  if (requestedDirectory != null && parsed.envelope.directory !== requestedDirectory) {
    throw new Error('persisted Build discovery directory differs from the requested canonical path');
  }
  const head = await readGeneration(locations, parsed.envelope.persistence.generation);
  if (!head.envelope_bytes.equals(headBytes)) {
    throw new Error('BUILD-DISCOVERY.yaml differs from its immutable generation head');
  }
  let child = head;
  while (child.envelope.persistence.revision > 0) {
    const parent = await readGeneration(
      locations,
      child.envelope.persistence.previous_generation,
    );
    if (
      parent.envelope.persistence.revision !== child.envelope.persistence.revision - 1 ||
      parent.head_sha256 !== child.envelope.persistence.previous_head_sha256 ||
      parent.envelope.run_id !== child.envelope.run_id ||
      parent.envelope.directory !== child.envelope.directory ||
      parent.envelope.origin_sha256 !== child.envelope.origin_sha256 ||
      parent.envelope.repository_baseline_sha256 !==
        child.envelope.repository_baseline_sha256
    ) {
      throw new Error('Build discovery immutable checkpoint history is broken');
    }
    assertDiscoveryCheckpointDescendant(parent.state, child.state, { allowSame: false });
    child = parent;
  }
  if (validateCanonical) await validateCanonicalArtifacts(locations, head);
  return { ...head, legacy: false };
}

function lineageAnchorRecord(locations, checkpoint, previousLineageSha256) {
  return {
    schema_version: 1,
    kind: 'cruise_build_discovery_lineage_anchor',
    run_id: checkpoint.envelope.run_id,
    repository_root: locations.repository_root,
    origin_sha256: checkpoint.envelope.origin_sha256,
    repository_baseline_sha256: checkpoint.envelope.repository_baseline_sha256,
    directory: checkpoint.envelope.directory,
    revision: checkpoint.envelope.persistence.revision,
    generation: checkpoint.envelope.persistence.generation,
    head_sha256: checkpoint.head_sha256,
    previous_lineage_sha256: previousLineageSha256,
  };
}

function parseLineageAnchor(bytes, locations) {
  const anchor = parseYaml(bytes.toString('utf8'));
  exactKeys(
    anchor,
    [
      'schema_version',
      'kind',
      'run_id',
      'repository_root',
      'origin_sha256',
      'repository_baseline_sha256',
      'directory',
      'revision',
      'generation',
      'head_sha256',
      'previous_lineage_sha256',
    ],
    'Build discovery durable lineage anchor',
  );
  if (
    anchor.schema_version !== 1 ||
    anchor.kind !== 'cruise_build_discovery_lineage_anchor' ||
    anchor.run_id !== locations.run_id ||
    anchor.repository_root !== locations.repository_root ||
    !Number.isSafeInteger(anchor.revision) ||
    anchor.revision < 0
  ) {
    throw new Error('Build discovery durable lineage anchor is invalid or belongs elsewhere');
  }
  assertDigest(anchor.origin_sha256, 'Build discovery lineage Origin digest');
  assertDigest(
    anchor.repository_baseline_sha256,
    'Build discovery lineage repository baseline digest',
  );
  assertDigest(anchor.head_sha256, 'Build discovery lineage head digest');
  const match = DISCOVERY_GENERATION.exec(anchor.generation);
  if (match == null || Number(match[1]) !== anchor.revision) {
    throw new Error('Build discovery durable lineage anchor revision/generation differs');
  }
  if (anchor.revision === 0) {
    if (anchor.previous_lineage_sha256 !== null) {
      throw new Error('Build discovery genesis lineage anchor cannot name a predecessor');
    }
  } else {
    assertDigest(
      anchor.previous_lineage_sha256,
      'Build discovery previous lineage digest',
    );
  }
  return anchor;
}

async function readLineageAnchorIfExists(locations) {
  const bytes = await readRegularFileIfExists(locations.lineage_path);
  if (bytes == null) return null;
  return {
    record: parseLineageAnchor(bytes, locations),
    bytes,
    sha256: digest(bytes),
  };
}

function assertLineageAnchorMatchesCheckpoint(locations, anchor, checkpoint) {
  const expected = lineageAnchorRecord(
    locations,
    checkpoint,
    anchor.record.previous_lineage_sha256,
  );
  const expectedBytes = Buffer.from(stringifyYaml(expected), 'utf8');
  if (!anchor.bytes.equals(expectedBytes)) {
    throw new Error('Build discovery durable lineage anchor differs from its committed head');
  }
}

async function deriveLineageAnchor(locations, checkpoint) {
  const chain = [checkpoint];
  let cursor = checkpoint;
  while (cursor.envelope.persistence.revision > 0) {
    cursor = await readGeneration(
      locations,
      cursor.envelope.persistence.previous_generation,
    );
    chain.push(cursor);
  }
  chain.reverse();
  let previousSha256 = null;
  let derived = null;
  for (const generation of chain) {
    const record = lineageAnchorRecord(locations, generation, previousSha256);
    const bytes = Buffer.from(stringifyYaml(record), 'utf8');
    derived = { record, bytes, sha256: digest(bytes) };
    previousSha256 = derived.sha256;
  }
  return derived;
}

async function commitLineageAnchor(
  locations,
  anchor,
  { faultInjector = null } = {},
) {
  const stateIdentity = await directoryIdentity(
    locations.state_directory,
    'Build discovery state directory',
  );
  await atomicReplace({
    path: locations.lineage_path,
    bytes: anchor.bytes,
    temporaryPath: locations.lineage_temp_path,
    parentIdentity: stateIdentity,
    label: 'Build discovery durable lineage anchor',
    faultInjector,
    preparedStep: 'lineage:prepared',
    committedStep: 'lineage:committed',
  });
}

async function ensureLineageAnchor(locations, checkpoint) {
  const anchor = await readLineageAnchorIfExists(locations);
  if (checkpoint == null) {
    if (anchor != null) {
      throw new Error(
        'Build discovery durable lineage anchor survives a missing checkpoint; refusing lineage reset',
      );
    }
    return null;
  }
  if (checkpoint.legacy) {
    if (anchor != null) {
      throw new Error('legacy Build discovery checkpoint cannot carry a version-two lineage anchor');
    }
    return null;
  }
  if (anchor != null) {
    assertLineageAnchorMatchesCheckpoint(locations, anchor, checkpoint);
    return anchor;
  }
  const migrated = await deriveLineageAnchor(locations, checkpoint);
  await commitLineageAnchor(locations, migrated);
  const committed = await readLineageAnchorIfExists(locations);
  assertLineageAnchorMatchesCheckpoint(locations, committed, checkpoint);
  return committed;
}

async function assertLineageAnchorUnchanged(locations, expected) {
  const current = await readLineageAnchorIfExists(locations);
  if (expected == null) {
    if (current != null) {
      throw new Error('Build discovery durable lineage appeared across the compare-and-swap boundary');
    }
    return;
  }
  if (current == null || !current.bytes.equals(expected.bytes)) {
    throw new Error('Build discovery durable lineage changed across the compare-and-swap boundary');
  }
}

async function readLegacyCheckpoint(
  locations,
  headBytes,
  { requestedDirectory, validateCanonical = true } = {},
) {
  const envelope = parseYaml(headBytes.toString('utf8'));
  exactKeys(
    envelope,
    [
      'schema_version',
      'kind',
      'run_id',
      'origin_sha256',
      'repository_baseline_sha256',
      'artifacts',
      'state',
    ],
    'legacy persisted Build discovery envelope',
  );
  if (
    envelope.schema_version !== 1 ||
    envelope.kind !== 'cruise_persisted_build_discovery' ||
    envelope.run_id !== locations.run_id
  ) {
    throw new Error('legacy persisted Build discovery envelope kind/run is invalid');
  }
  const state = replayBuildDiscoveryState(envelope.state);
  if (
    envelope.origin_sha256 !== state.origin_sha256 ||
    envelope.repository_baseline_sha256 !== state.repository_baseline_sha256
  ) {
    throw new Error('legacy persisted Build discovery bindings differ from state');
  }
  const directory = validateDiscoveryDirectory(requestedDirectory, state.snapshot);
  validateArtifactDigestMap(envelope.artifacts, 'legacy persisted discovery artifact digests');
  const artifactDirectory = resolve(locations.repository_root, directory);
  await assertSafeDirectoryChain(locations.repository_root, artifactDirectory);
  const contents = {};
  for (const name of DISCOVERY_ARTIFACT_NAMES) {
    contents[name] = await readRegularFile(join(artifactDirectory, name));
  }
  validateDiscoveryArtifactBytes(contents, envelope.artifacts, state);
  if (validateCanonical) {
    await exactDirectoryEntries(
      artifactDirectory,
      DISCOVERY_ARTIFACT_NAMES,
      'canonical discovery artifact directory',
    );
  }
  return {
    envelope: { ...envelope, directory, state },
    envelope_bytes: headBytes,
    head_sha256: digest(headBytes),
    contents,
    state,
    legacy: true,
  };
}

async function readCommittedCheckpoint(
  locations,
  { allowMissing = false, requestedDirectory = null, validateCanonical = true } = {},
) {
  const headBytes = await readRegularFileIfExists(locations.head_path);
  if (headBytes == null) {
    if (allowMissing) return null;
    const error = new Error('BUILD-DISCOVERY.yaml does not exist');
    error.code = 'ENOENT';
    throw error;
  }
  const record = parseYaml(headBytes.toString('utf8'));
  if (record?.schema_version === 1) {
    if (requestedDirectory == null) {
      throw new Error('legacy Build discovery checkpoint requires its canonical directory');
    }
    return readLegacyCheckpoint(locations, headBytes, { requestedDirectory, validateCanonical });
  }
  return readVersionTwoCheckpoint(locations, headBytes, {
    requestedDirectory,
    validateCanonical,
  });
}

async function publishGeneration(
  locations,
  envelope,
  envelopeBytes,
  contents,
  faultInjector,
) {
  await assertSafeDirectoryChain(
    locations.repository_root,
    locations.history_directory,
    { create: true },
  );
  const historyIdentity = await directoryIdentity(
    locations.history_directory,
    'Build discovery history directory',
  );
  const name = envelope.persistence.generation;
  const finalDirectory = resolve(locations.history_directory, name);
  try {
    const existing = await lstat(finalDirectory);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`Build discovery generation ${name} is not a safe directory`);
    }
    const checkpoint = await readGeneration(locations, name);
    if (!checkpoint.envelope_bytes.equals(envelopeBytes)) {
      throw new Error(`Build discovery generation ${name} was already used by another branch`);
    }
    return checkpoint;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const temporaryDirectory = resolve(locations.history_directory, `.${name}.tmp`);
  await rm(temporaryDirectory, { recursive: true, force: true });
  await mkdir(temporaryDirectory, { mode: 0o700 });
  try {
    for (const artifactName of DISCOVERY_ARTIFACT_NAMES) {
      await writeNewFile(join(temporaryDirectory, artifactName), contents[artifactName], 0o400);
      await invokePersistenceFault(faultInjector, `generation:${artifactName}:written`);
    }
    await writeNewFile(
      join(temporaryDirectory, DISCOVERY_HEAD_NAME),
      envelopeBytes,
      0o400,
    );
    await invokePersistenceFault(faultInjector, 'generation:envelope:written');
    await exactDirectoryEntries(
      temporaryDirectory,
      [...DISCOVERY_ARTIFACT_NAMES, DISCOVERY_HEAD_NAME],
      'staged Build discovery generation',
    );
    await syncDirectory(temporaryDirectory);
    await assertDirectoryIdentity(
      locations.history_directory,
      historyIdentity,
      'Build discovery history directory',
    );
    await rename(temporaryDirectory, finalDirectory);
    await syncDirectory(locations.history_directory);
    await invokePersistenceFault(faultInjector, 'generation:published');
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
  const checkpoint = await readGeneration(locations, name);
  if (!checkpoint.envelope_bytes.equals(envelopeBytes)) {
    throw new Error('published Build discovery generation changed before commit');
  }
  return checkpoint;
}

function pendingIntent({ current, currentLineage, next, nextHeadSha256, nextLineage }) {
  return {
    schema_version: 2,
    kind: 'cruise_build_discovery_pending_commit',
    run_id: next.envelope.run_id,
    directory: next.envelope.directory,
    expected_previous_head_sha256: current?.head_sha256 ?? null,
    expected_previous_lineage_sha256: currentLineage?.sha256 ?? null,
    new_generation: next.envelope.persistence.generation,
    new_head_sha256: nextHeadSha256,
    new_lineage_sha256: nextLineage.sha256,
  };
}

function parsePendingIntent(bytes, runId) {
  const intent = parseYaml(bytes.toString('utf8'));
  const versionOneFields = [
    'schema_version',
    'kind',
    'run_id',
    'directory',
    'expected_previous_head_sha256',
    'new_generation',
    'new_head_sha256',
  ];
  const versionTwoFields = [
    ...versionOneFields,
    'expected_previous_lineage_sha256',
    'new_lineage_sha256',
  ];
  exactKeys(
    intent,
    intent?.schema_version === 1 ? versionOneFields : versionTwoFields,
    'Build discovery pending commit',
  );
  if (
    ![1, 2].includes(intent.schema_version) ||
    intent.kind !== 'cruise_build_discovery_pending_commit' ||
    intent.run_id !== runId ||
    !DISCOVERY_GENERATION.test(intent.new_generation)
  ) {
    throw new Error('Build discovery pending commit is invalid or belongs elsewhere');
  }
  if (intent.expected_previous_head_sha256 != null) {
    assertDigest(
      intent.expected_previous_head_sha256,
      'Build discovery pending previous head digest',
    );
  }
  assertDigest(intent.new_head_sha256, 'Build discovery pending new head digest');
  if (intent.schema_version === 2) {
    if (intent.expected_previous_lineage_sha256 != null) {
      assertDigest(
        intent.expected_previous_lineage_sha256,
        'Build discovery pending previous lineage digest',
      );
    }
    assertDigest(intent.new_lineage_sha256, 'Build discovery pending new lineage digest');
  }
  return {
    ...intent,
    expected_previous_lineage_sha256:
      intent.schema_version === 2 ? intent.expected_previous_lineage_sha256 : undefined,
    new_lineage_sha256: intent.schema_version === 2 ? intent.new_lineage_sha256 : undefined,
  };
}

function canonicalTemporaryPath(artifactDirectory, generation, name) {
  return join(artifactDirectory, `.BUILD-DISCOVERY.${generation}.${name}.tmp`);
}

async function removePendingTransactionTemps(locations, directory, generation) {
  const artifactDirectory = resolve(locations.repository_root, directory);
  for (const name of DISCOVERY_ARTIFACT_NAMES) {
    await rm(canonicalTemporaryPath(artifactDirectory, generation, name), { force: true });
  }
  await rm(join(
    locations.state_directory,
    `.BUILD-DISCOVERY.${generation}.head.tmp`,
  ), { force: true });
  await rm(locations.pending_temp_path, { force: true });
  await rm(locations.lineage_temp_path, { force: true });
}

async function materializeCanonicalArtifacts(
  locations,
  checkpoint,
  { faultInjector = null } = {},
) {
  const artifactDirectory = resolve(locations.repository_root, checkpoint.envelope.directory);
  await assertSafeDirectoryChain(
    locations.repository_root,
    artifactDirectory,
    { create: true },
  );
  const identity = await directoryIdentity(artifactDirectory, 'canonical discovery artifact directory');
  await removePendingTransactionTemps(
    locations,
    checkpoint.envelope.directory,
    checkpoint.envelope.persistence.generation,
  );
  const allowed = new Set(DISCOVERY_ARTIFACT_NAMES);
  const extras = (await readdir(artifactDirectory)).filter((name) => !allowed.has(name));
  if (extras.length > 0) {
    throw new Error(
      `canonical discovery artifact directory contains unapproved entries: ${extras.join(', ')}`,
    );
  }
  for (const name of DISCOVERY_ARTIFACT_NAMES) {
    try {
      const existing = await lstat(join(artifactDirectory, name));
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error(`canonical discovery ${name} is not a regular no-follow file`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  for (const name of DISCOVERY_ARTIFACT_NAMES) {
    await atomicReplace({
      path: join(artifactDirectory, name),
      bytes: checkpoint.contents[name],
      temporaryPath: canonicalTemporaryPath(
        artifactDirectory,
        checkpoint.envelope.persistence.generation,
        name,
      ),
      parentIdentity: identity,
      label: `canonical discovery ${name}`,
      faultInjector,
      preparedStep: `canonical:${name}:prepared`,
      committedStep: `canonical:${name}:committed`,
    });
  }
  await validateCanonicalArtifacts(locations, checkpoint);
}

async function removeExactPendingIntent(locations, expectedBytes) {
  const current = await readRegularFile(locations.pending_path);
  if (!current.equals(expectedBytes)) {
    throw new Error('Build discovery pending commit changed before finalization');
  }
  await rm(locations.pending_path);
  await syncDirectory(locations.state_directory);
}

async function commitCheckpointHead(locations, checkpoint, faultInjector = null) {
  const stateIdentity = await directoryIdentity(
    locations.state_directory,
    'Build discovery state directory',
  );
  await atomicReplace({
    path: locations.head_path,
    bytes: checkpoint.envelope_bytes,
    temporaryPath: join(
      locations.state_directory,
      `.BUILD-DISCOVERY.${checkpoint.envelope.persistence.generation}.head.tmp`,
    ),
    parentIdentity: stateIdentity,
    label: 'Build discovery checkpoint head',
    faultInjector,
    preparedStep: 'head:prepared',
    committedStep: 'head:committed',
  });
}

async function assertCommittedHeadUnchanged(locations, expected) {
  const currentBytes = await readRegularFileIfExists(locations.head_path);
  if (expected == null) {
    if (currentBytes != null) {
      throw new Error('BUILD-DISCOVERY.yaml appeared across the compare-and-swap boundary');
    }
    return;
  }
  if (currentBytes == null || !currentBytes.equals(expected.envelope_bytes)) {
    throw new Error('BUILD-DISCOVERY.yaml changed across the compare-and-swap boundary');
  }
}

async function recoverPendingCheckpoint(locations) {
  const pendingBytes = await readRegularFileIfExists(locations.pending_path);
  if (pendingBytes == null) return null;
  const intent = parsePendingIntent(pendingBytes, locations.run_id);
  const next = await readGeneration(locations, intent.new_generation);
  await assertDiscoveryRepositoryBinding(next.state, locations.repository_root);
  if (
    next.head_sha256 !== intent.new_head_sha256 ||
    next.envelope.directory !== intent.directory ||
    next.envelope.persistence.previous_head_sha256 !==
      intent.expected_previous_head_sha256
  ) {
    throw new Error('Build discovery pending commit does not bind its immutable generation');
  }
  const current = await readCommittedCheckpoint(locations, {
    allowMissing: true,
    requestedDirectory: intent.directory,
    validateCanonical: false,
  });
  if (current != null) {
    await assertDiscoveryRepositoryBinding(current.state, locations.repository_root);
  }
  const currentIsNext = current?.head_sha256 === next.head_sha256;
  if (!currentIsNext) {
    if ((current?.head_sha256 ?? null) !== intent.expected_previous_head_sha256) {
      throw new Error('Build discovery pending commit lost its compare-and-swap predecessor');
    }
    if (current == null) {
      if (next.envelope.persistence.revision !== 0) {
        throw new Error('Build discovery pending genesis is not revision zero');
      }
    } else {
      if (current.legacy) {
        throw new Error('legacy Build discovery head cannot have a version-two pending commit');
      }
      if (
        next.envelope.persistence.revision !== current.envelope.persistence.revision + 1 ||
        next.envelope.persistence.previous_generation !==
          current.envelope.persistence.generation
      ) {
        throw new Error('Build discovery pending commit is not the next immutable revision');
      }
      assertDiscoveryCheckpointDescendant(current.state, next.state, { allowSame: false });
    }
  }

  let nextLineage = null;
  let currentLineage = null;
  if (intent.schema_version === 2) {
    const record = lineageAnchorRecord(
      locations,
      next,
      intent.expected_previous_lineage_sha256,
    );
    const bytes = Buffer.from(stringifyYaml(record), 'utf8');
    nextLineage = { record, bytes, sha256: digest(bytes) };
    if (nextLineage.sha256 !== intent.new_lineage_sha256) {
      throw new Error('Build discovery pending commit does not bind its durable lineage anchor');
    }
    currentLineage = await readLineageAnchorIfExists(locations);
    const currentLineageSha256 = currentLineage?.sha256 ?? null;
    const allowedLineages = currentIsNext
      ? new Set([intent.expected_previous_lineage_sha256, intent.new_lineage_sha256])
      : new Set([intent.expected_previous_lineage_sha256]);
    if (!allowedLineages.has(currentLineageSha256)) {
      throw new Error('Build discovery pending commit lost its durable lineage predecessor');
    }
    if (currentLineageSha256 === intent.new_lineage_sha256) {
      assertLineageAnchorMatchesCheckpoint(locations, currentLineage, next);
    }
  }
  await materializeCanonicalArtifacts(locations, next);
  if (!currentIsNext) await commitCheckpointHead(locations, next);
  if (intent.schema_version === 2) {
    if (currentLineage?.sha256 !== nextLineage.sha256) {
      await commitLineageAnchor(locations, nextLineage);
    }
  } else {
    await ensureLineageAnchor(locations, next);
  }
  await removeExactPendingIntent(locations, pendingBytes);
  await removePendingTransactionTemps(locations, intent.directory, intent.new_generation);
  const committed = await readCommittedCheckpoint(locations, {
    requestedDirectory: intent.directory,
    validateCanonical: true,
  });
  await ensureLineageAnchor(locations, committed);
  return committed;
}

async function migrateLegacyCheckpoint(locations, legacy) {
  const stateSha256 = objectDigest(legacy.state);
  const generation = generationName(0, stateSha256);
  const envelope = persistedEnvelope({
    state: legacy.state,
    artifacts: legacy.envelope.artifacts,
    directory: legacy.envelope.directory,
    revision: 0,
    generation,
    previousGeneration: null,
    previousHeadSha256: null,
  });
  const envelopeBytes = Buffer.from(stringifyYaml(envelope), 'utf8');
  const checkpoint = await publishGeneration(
    locations,
    envelope,
    envelopeBytes,
    legacy.contents,
    null,
  );
  await commitCheckpointHead(locations, checkpoint);
  const committed = await readCommittedCheckpoint(locations, {
    requestedDirectory: legacy.envelope.directory,
    validateCanonical: true,
  });
  await ensureLineageAnchor(locations, committed);
  return committed;
}

function checkpointResult(locations, checkpoint) {
  return deepFreeze({
    directory: checkpoint.envelope.directory,
    state_path: portable(relative(locations.repository_root, locations.head_path)),
    artifacts: clone(checkpoint.envelope.artifacts),
    state_sha256: objectDigest(checkpoint.state),
    checkpoint_revision: checkpoint.envelope.persistence?.revision ?? 0,
    checkpoint_head_sha256: checkpoint.head_sha256,
  });
}

/**
 * Persist one replay-valid discovery descendant through an immutable generation
 * and a single atomic head. The optional second argument exists for deterministic
 * filesystem fault injection in tests; it grants no persistence authority.
 */
export async function persistBuildDiscovery(
  { root, directory, run } = {},
  { faultInjector = null } = {},
) {
  if (faultInjector != null && typeof faultInjector !== 'function') {
    throw new TypeError('discovery persistence faultInjector must be a function');
  }
  const state = requireRun(run).state;
  const repositoryRoot = await realpath(resolve(root));
  await assertDiscoveryRepositoryBinding(state, repositoryRoot);
  const relativeDirectory = validateDiscoveryDirectory(directory, state.snapshot);
  const locations = {
    ...checkpointLocations(repositoryRoot, state.run_id),
    run_id: state.run_id,
  };
  await assertSafeDirectoryChain(repositoryRoot, locations.state_directory, { create: true });
  let lock;
  try {
    lock = await acquireDiscoveryWriterLock(locations, state.run_id);
    await rm(locations.pending_temp_path, { force: true });
    await recoverPendingCheckpoint(locations);
    let current = await readCommittedCheckpoint(locations, {
      allowMissing: true,
      requestedDirectory: relativeDirectory,
      validateCanonical: true,
    });
    if (current != null) {
      await assertDiscoveryRepositoryBinding(current.state, repositoryRoot);
    }
    if (current?.legacy) current = await migrateLegacyCheckpoint(locations, current);
    const currentLineage = await ensureLineageAnchor(locations, current);
    if (current != null) {
      const relation = assertDiscoveryCheckpointDescendant(current.state, state);
      if (relation === 'same') return checkpointResult(locations, current);
    }

    const revision = current == null ? 0 : current.envelope.persistence.revision + 1;
    const contents = discoveryArtifactContents(state);
    const artifacts = discoveryArtifactDigests(contents);
    const stateSha256 = objectDigest(state);
    const generation = generationName(revision, stateSha256);
    const envelope = persistedEnvelope({
      state,
      artifacts,
      directory: relativeDirectory,
      revision,
      generation,
      previousGeneration: current?.envelope.persistence.generation ?? null,
      previousHeadSha256: current?.head_sha256 ?? null,
    });
    const envelopeBytes = Buffer.from(stringifyYaml(envelope), 'utf8');
    const next = await publishGeneration(
      locations,
      envelope,
      envelopeBytes,
      contents,
      faultInjector,
    );
    const nextLineageRecord = lineageAnchorRecord(
      locations,
      next,
      currentLineage?.sha256 ?? null,
    );
    const nextLineageBytes = Buffer.from(stringifyYaml(nextLineageRecord), 'utf8');
    const nextLineage = {
      record: nextLineageRecord,
      bytes: nextLineageBytes,
      sha256: digest(nextLineageBytes),
    };
    const intent = pendingIntent({
      current,
      currentLineage,
      next,
      nextHeadSha256: next.head_sha256,
      nextLineage,
    });
    const intentBytes = Buffer.from(stringifyYaml(intent), 'utf8');
    const stateIdentity = await directoryIdentity(
      locations.state_directory,
      'Build discovery state directory',
    );
    if (await readRegularFileIfExists(locations.pending_path) != null) {
      throw new Error('Build discovery pending commit appeared after recovery');
    }
    await assertCommittedHeadUnchanged(locations, current);
    await assertLineageAnchorUnchanged(locations, currentLineage);
    await atomicReplace({
      path: locations.pending_path,
      bytes: intentBytes,
      temporaryPath: locations.pending_temp_path,
      parentIdentity: stateIdentity,
      label: 'Build discovery pending commit',
      faultInjector,
      preparedStep: 'intent:prepared',
      committedStep: 'intent:committed',
    });
    await assertCommittedHeadUnchanged(locations, current);
    await assertLineageAnchorUnchanged(locations, currentLineage);
    await materializeCanonicalArtifacts(locations, next, { faultInjector });
    await assertCommittedHeadUnchanged(locations, current);
    await assertLineageAnchorUnchanged(locations, currentLineage);
    await commitCheckpointHead(locations, next, faultInjector);
    await assertLineageAnchorUnchanged(locations, currentLineage);
    await commitLineageAnchor(locations, nextLineage, { faultInjector });
    await removeExactPendingIntent(locations, intentBytes);
    await removePendingTransactionTemps(locations, relativeDirectory, generation);
    const committed = await readCommittedCheckpoint(locations, {
      requestedDirectory: relativeDirectory,
      validateCanonical: true,
    });
    await ensureLineageAnchor(locations, committed);
    return checkpointResult(locations, committed);
  } finally {
    await releaseDiscoveryWriterLock(locations, state.run_id, lock);
  }
}

/** Read, recover, and validate persisted bytes without minting runtime authority. */
export async function readPersistedBuildDiscovery({ root, directory, runId } = {}) {
  if (!RUN_ID.test(runId)) throw new TypeError('runId is invalid');
  const repositoryRoot = await realpath(resolve(root));
  const locations = { ...checkpointLocations(repositoryRoot, runId), run_id: runId };
  await assertSafeDirectoryChain(repositoryRoot, locations.state_directory);
  let lock;
  try {
    lock = await acquireDiscoveryWriterLock(locations, runId);
    await rm(locations.pending_temp_path, { force: true });
    await recoverPendingCheckpoint(locations);
    const headBytes = await readRegularFileIfExists(locations.head_path);
    if (headBytes == null) {
      await ensureLineageAnchor(locations, null);
      const error = new Error('BUILD-DISCOVERY.yaml does not exist');
      error.code = 'ENOENT';
      throw error;
    }
    const record = parseYaml(headBytes.toString('utf8'));
    const requestedDirectory = record?.schema_version === 1
      ? directory
      : validateDiscoveryDirectory(directory, replayBuildDiscoveryState(record.state).snapshot);
    const checkpoint = await readCommittedCheckpoint(locations, {
      requestedDirectory,
      validateCanonical: true,
    });
    await assertDiscoveryRepositoryBinding(checkpoint.state, repositoryRoot);
    await ensureLineageAnchor(locations, checkpoint);
    return deepFreeze({
      state: clone(checkpoint.state),
      directory: checkpoint.envelope.directory,
      artifacts: clone(checkpoint.envelope.artifacts),
      state_sha256: objectDigest(checkpoint.state),
      checkpoint_revision: checkpoint.envelope.persistence?.revision ?? 0,
      checkpoint_head_sha256: checkpoint.head_sha256,
    });
  } finally {
    await releaseDiscoveryWriterLock(locations, runId, lock);
  }
}

export function buildDiscoveryStateDigest(value) {
  const state = RUNS.has(value) ? requireRun(value).state : replayBuildDiscoveryState(value);
  return objectDigest(state);
}
