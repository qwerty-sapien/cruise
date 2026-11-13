import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  assertNoSecretMaterial,
  assertNoSensitiveAccessRequest,
  assertNoSensitivePathReference,
  NEVER_READ_INSTRUCTIONS,
} from './sensitive-path.mjs';

export const MAX_CAPSULE_BYTES = 8 * 1024;
export const MAX_WORKER_HANDOFF_BYTES = 4 * 1024;

const HANDOFF_KEYS = Object.freeze([
  'outcome',
  'completed_work',
  'changed_files',
  'decisions_and_invariants',
  'exact_tests',
  'active_blocker_or_next_work_item',
  'files_not_to_reread',
  'evidence_pointers',
  'usage_and_quota_summary',
]);

function digest(text) {
  return createHash('sha256').update(text).digest('hex');
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  return value.trim();
}

function stringList(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${label} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function safePathReferences(value, label) {
  return stringList(value, label).map((item) => assertNoSensitivePathReference(item, label));
}

function assertByteCap(value, cap, label) {
  const bytes = Buffer.byteLength(value);
  if (bytes > cap) throw new Error(`${label} exceeds ${cap} bytes`);
  return bytes;
}

export function buildContextCapsule({
  task,
  nonGoals = [],
  evidence = [],
  relevantRanges = [],
  invariants = [],
  ownership = [],
  verification = [],
  uncertainty = [],
  stopConditions = [],
  escalationConditions = [],
  visibleOutputBytes = 12 * 1024,
} = {}) {
  if (!Number.isSafeInteger(visibleOutputBytes) || visibleOutputBytes < 1 || visibleOutputBytes > 12 * 1024) {
    throw new TypeError('visibleOutputBytes must be an integer from 1 through 12288');
  }
  const safeTask = text(task, 'capsule task');
  assertNoSensitiveAccessRequest(safeTask, 'capsule task');
  const protectedInvariants = stringList(invariants, 'invariants');
  if (!protectedInvariants.includes(NEVER_READ_INSTRUCTIONS)) {
    protectedInvariants.push(NEVER_READ_INSTRUCTIONS);
  }
  const capsule = {
    schema_version: 1,
    kind: 'cruise_bounded_context_capsule',
    task: safeTask,
    non_goals: stringList(nonGoals, 'nonGoals'),
    current_evidence: stringList(evidence, 'evidence'),
    relevant_files_symbols_ranges: safePathReferences(relevantRanges, 'relevantRanges'),
    protected_invariants: protectedInvariants,
    edit_ownership: safePathReferences(ownership, 'ownership'),
    focused_verification: safePathReferences(verification, 'verification'),
    remaining_uncertainty: stringList(uncertainty, 'uncertainty'),
    stop_conditions: stringList(stopConditions, 'stopConditions'),
    escalation_conditions: stringList(escalationConditions, 'escalationConditions'),
    model_visible_output_cap_bytes: visibleOutputBytes,
  };
  const serialized = `${JSON.stringify(capsule, null, 2)}\n`;
  assertNoSecretMaterial(serialized, 'worker capsule');
  const bytes = assertByteCap(serialized, MAX_CAPSULE_BYTES, 'worker capsule');
  return Object.freeze({
    value: Object.freeze(capsule),
    serialized,
    bytes,
    digest: digest(serialized),
  });
}

export async function writeContextCapsule(cwd, capsule, {
  makeDirectory = mkdir,
  write = writeFile,
} = {}) {
  if (!capsule?.serialized || !capsule?.digest) throw new TypeError('a built context capsule is required');
  const path = join(cwd, '.cruise', 'artifacts', `context-capsule-${capsule.digest.slice(0, 16)}.json`);
  await makeDirectory(dirname(path), { recursive: true });
  await write(path, capsule.serialized, { encoding: 'utf8', mode: 0o600 });
  return path;
}

export function parseWorkerHandoff(raw) {
  if (typeof raw !== 'string') throw new TypeError('worker handoff must be JSON text');
  assertByteCap(raw, MAX_WORKER_HANDOFF_BYTES, 'worker handoff');
  let value;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new Error('worker handoff must be one JSON object', { cause });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('worker handoff must be one JSON object');
  }
  const unknown = Object.keys(value).filter((key) => !HANDOFF_KEYS.includes(key));
  if (unknown.length) throw new TypeError(`worker handoff has unknown fields: ${unknown.join(', ')}`);
  for (const key of HANDOFF_KEYS) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`worker handoff is missing ${key}`);
  }
  const normalized = {
    outcome: text(value.outcome, 'handoff outcome'),
    completed_work: stringList(value.completed_work, 'completed_work'),
    changed_files: stringList(value.changed_files, 'changed_files'),
    decisions_and_invariants: stringList(value.decisions_and_invariants, 'decisions_and_invariants'),
    exact_tests: stringList(value.exact_tests, 'exact_tests'),
    active_blocker_or_next_work_item: text(
      value.active_blocker_or_next_work_item,
      'active_blocker_or_next_work_item',
    ),
    files_not_to_reread: stringList(value.files_not_to_reread, 'files_not_to_reread'),
    evidence_pointers: stringList(value.evidence_pointers, 'evidence_pointers'),
    usage_and_quota_summary: text(value.usage_and_quota_summary, 'usage_and_quota_summary'),
  };
  return Object.freeze(normalized);
}

export function formatRootHandoff(handoff) {
  const value = typeof handoff === 'string' ? parseWorkerHandoff(handoff) : handoff;
  const compact = [
    ...value.completed_work.map((item) => `completed ${item}`),
    ...value.changed_files.map((item) => `changed ${item}`),
    ...value.decisions_and_invariants.map((item) => `preserve ${item}`),
  ].join('; ') || 'No completed worker state was recorded.';
  const assurance = [
    ...value.exact_tests.map((item) => `check ${item}`),
    ...value.evidence_pointers.map((item) => `evidence ${item}`),
  ].join('; ') || 'No focused assurance pointer was recorded.';
  const lines = [
    '# Cruise continuation',
    '',
    `- Compact handoff: ${truncateUtf8(compact, 1_800)}`,
    `- Next work item: ${value.active_blocker_or_next_work_item}`,
    `- Quota state: ${value.usage_and_quota_summary}`,
    `- Unresolved assurance: ${truncateUtf8(assurance, 1_200)}`,
    '',
  ];
  const content = lines.join('\n');
  assertByteCap(content, MAX_WORKER_HANDOFF_BYTES, 'root handoff');
  return content;
}

export async function writeRootHandoff(cwd, handoff, {
  makeDirectory = mkdir,
  write = writeFile,
} = {}) {
  const path = join(cwd, '.cruise', 'HANDOFF.md');
  const content = formatRootHandoff(handoff);
  await makeDirectory(dirname(path), { recursive: true });
  await write(path, content, { encoding: 'utf8', mode: 0o600 });
  return Object.freeze({ path, bytes: Buffer.byteLength(content), digest: digest(content) });
}

function truncateUtf8(value, bytes) {
  const buffer = Buffer.from(value);
  if (buffer.length <= bytes) return value;
  return buffer.subarray(0, Math.max(0, bytes - 3)).toString('utf8').replace(/\uFFFD$/u, '') + '...';
}

/** Read only the compact handoff for a root continuation. */
export async function readContinuationContext(cwd, {
  read = readFile,
} = {}) {
  let handoff = 'No handoff is available.';
  try {
    handoff = await read(join(cwd, '.cruise', 'HANDOFF.md'), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  assertByteCap(handoff, MAX_WORKER_HANDOFF_BYTES, 'stored root handoff');
  return `Resume only from this compact continuation state. Do not restate the request, Flight, or prior plan.\n\n${handoff}`;
}

export const WORKER_HANDOFF_SCHEMA_INSTRUCTIONS = [
  'Return exactly one JSON object and no markdown fence.',
  `Keep it at most ${MAX_WORKER_HANDOFF_BYTES} bytes.`,
  `Use exactly these keys: ${HANDOFF_KEYS.join(', ')}.`,
  'All fields except outcome, active_blocker_or_next_work_item, and usage_and_quota_summary are arrays of strings.',
].join(' ');
