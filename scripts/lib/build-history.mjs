import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import {
  BUILD_IDENTIFIER_PATTERN,
  createBuildOriginRecord,
  validateOriginRecord,
} from './origin.mjs';
import { canonicalJson, parseYaml, stringifyYaml } from './yaml-state.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const PROJECT_ID = /^PRJ-\d{2,}$/u;
const MILESTONE_ID = /^M-\d{2,}$/u;
const BUILD_IDENTIFIER = /^(PRJ|M|R|AC|D|Q|P|RSK|C|QI)-(\d{2,})$/u;
const IDENTIFIER_IN_TEXT = /(?:^|[^A-Za-z0-9_-])((?:PRJ|M|R|AC|D|Q|P|RSK|C|QI)-\d{2,})(?![A-Za-z0-9_-])/gmu;
const REGISTRY_KIND = 'cruise_build_id_registry';
const SNAPSHOT_KIND = 'cruise_build_id_registry_snapshot';
const REGISTRY_HISTORY_DIRECTORY = 'ID-REGISTRY-HISTORY';
const REGISTRY_HEAD_FILE = 'ID-REGISTRY-HEAD.yaml';
const REGISTRY_PENDING_FILE = 'ID-REGISTRY-PENDING.yaml';
const REGISTRY_LOCK_FILE = 'ID-REGISTRY.yaml.lock';
const REGISTRY_COMMITMENTS_DIRECTORY = 'ID-REGISTRY-COMMITMENTS';
const REGISTRY_HISTORY_ENTRY = /^REV-(\d{12})-([a-f0-9]{64})\.yaml$/u;
const REGISTRY_COMMITMENT_ENTRY = /^REV-(\d{12})-([a-f0-9]{64})\.yaml$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COMMITTED_REGISTRY_HEADS = new Map();

export const BUILD_ID_NAMESPACES = Object.freeze([
  'PRJ',
  'M',
  'R',
  'AC',
  'D',
  'Q',
  'P',
  'RSK',
  'C',
  'QI',
]);
export const BUILD_ID_REGISTRY_SCHEMA_VERSION = 1;
export const BUILD_ID_REGISTRY_SCHEMA = Object.freeze({
  schema_version: BUILD_ID_REGISTRY_SCHEMA_VERSION,
  kind: REGISTRY_KIND,
  required: Object.freeze([
    'schema_version',
    'kind',
    'origin_identity_sha256',
    'project_id',
    'revision',
    'parent_snapshot_sha256',
    'namespaces',
    'records',
    'events',
  ]),
  identifier_namespaces: BUILD_ID_NAMESPACES,
  identifier_statuses: Object.freeze(['active', 'superseded']),
  event_chain: 'sha256',
});

/** Canonical repository-local persistence path for one project's Build ID history. */
export function buildIdRegistryPath(repositoryRoot, projectId) {
  const root = resolve(nonEmpty(repositoryRoot, 'repositoryRoot'));
  if (!PROJECT_ID.test(projectId)) throw new TypeError('projectId must be a PRJ-XX identifier');
  return join(root, '.cruise', 'project', 'ID-REGISTRY.yaml');
}

const NAMESPACE_ORDER = new Map(BUILD_ID_NAMESPACES.map((namespace, index) => [namespace, index]));
const INITIAL_ORIGINS = new WeakMap();
const INITIAL_CAPTURE_KEYS = new Set();
const VERIFIED_INITIAL_ORIGINS = new WeakSet();
const ORIGIN_PAIR_AUTHORITIES = new WeakMap();
const VERIFIED_ORIGIN_PAIRS = new WeakSet();
const ID_HISTORY_AUTHORITIES = new WeakMap();
const VERIFIED_ID_HISTORIES = new WeakSet();
const RESUME_ATTESTATIONS = new WeakMap();
const CONSUMED_RESUME_ATTESTATIONS = new WeakSet();
const RESUME_RECEIPTS = new WeakSet();

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} fields must be exactly: ${expected.join(', ')}`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
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

function parseIdentifier(identifier, label = 'identifier') {
  if (typeof identifier !== 'string' || !BUILD_IDENTIFIER_PATTERN.test(identifier)) {
    throw new TypeError(`${label} must be a canonical Build identifier`);
  }
  const match = BUILD_IDENTIFIER.exec(identifier);
  if (!match) throw new TypeError(`${label} must be a canonical Build identifier`);
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`${label} numeric component must be a positive safe integer`);
  }
  return {
    id: identifier,
    namespace: match[1],
    number,
    width: match[2].length,
  };
}

function compareIdentifiers(left, right) {
  return (
    NAMESPACE_ORDER.get(left.namespace) - NAMESPACE_ORDER.get(right.namespace) ||
    left.number - right.number ||
    left.id.localeCompare(right.id, 'en')
  );
}

function normalizeSourcePath(value, label, { allowOrigin = false } = {}) {
  const path = nonEmpty(value, label).split(sep).join('/');
  if (allowOrigin && path.startsWith('@origin/')) return path;
  if (isAbsolute(path) || path === '..' || path.startsWith('../') || path.includes('/../')) {
    throw new Error(`${label} must be a repository-relative path`);
  }
  if (path.startsWith('@')) throw new Error(`${label} uses a reserved virtual path`);
  return path;
}

function normalizedPaths(values, label, options = {}) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`);
  }
  return [...new Set(values.map((value, index) => (
    normalizeSourcePath(value, `${label}[${index}]`, options)
  )))].sort((a, b) => a.localeCompare(b, 'en'));
}

function immutableOriginSnapshot(record) {
  return {
    origin: structuredClone(record.origin),
    repository_baseline: structuredClone(record.repository_baseline),
    routing: structuredClone(record.routing),
    build: structuredClone(record.build),
  };
}

function assertBuildOrigin(record) {
  validateOriginRecord(record);
  if (
    record.origin.selected_skill !== 'build' ||
    record.routing.selected_route !== 'build' ||
    !isPlainObject(record.build)
  ) {
    throw new Error('initial Build Origin capture requires a Build-selected Origin record');
  }
  return record;
}

function createOriginAttestation(record) {
  const snapshot = immutableOriginSnapshot(assertBuildOrigin(record));
  const originIdentitySha256 = objectDigest(snapshot);
  const token = deepFreeze({
    schema_version: 1,
    kind: 'cruise_initial_build_origin_attestation',
    attestation_id: randomUUID(),
    origin_identity_sha256: originIdentitySha256,
  });
  INITIAL_ORIGINS.set(token, {
    snapshot,
    originIdentitySha256,
    repositoryIdentitySha256: objectDigest(snapshot.repository_baseline),
    routingIdentitySha256: objectDigest(snapshot.routing),
    buildIdentitySha256: objectDigest(snapshot.build),
  });
  return token;
}

/**
 * Capture the initial Build Origin and mint an opaque authority for its immutable identity.
 * Pass an existing originRecord, or the same inputs accepted by createBuildOriginRecord.
 */
export function captureInitialBuildOrigin(input = {}) {
  if (Object.hasOwn(input, 'originRecord')) {
    throw new TypeError('initial Build Origin must be captured while it is created, not re-attested from a later record');
  }
  const record = createBuildOriginRecord(input);
  const captureKey = objectDigest({
    repository_root: record.repository_baseline.root,
    mode: record.build.mode,
    target_project: record.build.target_project,
    target_milestone: record.build.target_milestone,
  });
  if (INITIAL_CAPTURE_KEYS.has(captureKey)) {
    throw new Error('initial Build Origin was already captured for this repository, mode, and target');
  }
  const attestation = createOriginAttestation(record);
  INITIAL_CAPTURE_KEYS.add(captureKey);
  return deepFreeze({
    origin_record: record,
    attestation,
  });
}

/** Verify that persisted Origin state is byte-semantically identical to initial capture. */
export function verifyInitialBuildOriginAttestation(
  attestation,
  {
    originRecord,
    repositoryRoot = null,
    deterministicProbeDigest = null,
    projectId = null,
    milestoneId = undefined,
    mode = null,
  } = {},
) {
  const binding = INITIAL_ORIGINS.get(attestation);
  if (!binding) throw new Error('initial Build Origin attestation is not opaque runtime authority');
  const record = assertBuildOrigin(originRecord);
  const actual = immutableOriginSnapshot(record);
  if (objectDigest(actual) !== binding.originIdentitySha256) {
    throw new Error('initial Build Origin identity changed after capture');
  }
  if (repositoryRoot != null && record.repository_baseline.root !== repositoryRoot) {
    throw new Error('initial Build Origin belongs to another repository root');
  }
  if (
    deterministicProbeDigest != null &&
    record.routing.deterministic_probe_digest !== deterministicProbeDigest
  ) {
    throw new Error('initial Build Origin belongs to another deterministic route probe');
  }
  if (projectId != null && record.build.target_project !== projectId) {
    throw new Error('initial Build Origin belongs to another project target');
  }
  if (milestoneId !== undefined && record.build.target_milestone !== milestoneId) {
    throw new Error('initial Build Origin belongs to another milestone target');
  }
  if (mode != null && record.build.mode !== mode) {
    throw new Error('initial Build Origin belongs to another Build mode');
  }
  const receipt = deepFreeze({
    schema_version: 1,
    kind: 'cruise_verified_initial_build_origin',
    origin_identity_sha256: binding.originIdentitySha256,
    prompt_sha256: record.origin.prompt_sha256,
    repository_identity_sha256: binding.repositoryIdentitySha256,
    routing_identity_sha256: binding.routingIdentitySha256,
    build_identity_sha256: binding.buildIdentitySha256,
    project_id: record.build.target_project,
    milestone_id: record.build.target_milestone,
    mode: record.build.mode,
  });
  VERIFIED_INITIAL_ORIGINS.add(receipt);
  return receipt;
}

export function isVerifiedInitialBuildOriginReceipt(value) {
  return VERIFIED_INITIAL_ORIGINS.has(value);
}

function originArtifactBinding({ attestation, record, bytes }, label) {
  const capture = INITIAL_ORIGINS.get(attestation);
  if (!capture) throw new Error(`${label} Origin capture is not opaque initial authority`);
  verifyInitialBuildOriginAttestation(attestation, { originRecord: record });
  if (typeof bytes !== 'string' && !Buffer.isBuffer(bytes)) {
    throw new TypeError(`${label} Origin bytes must be text or bytes`);
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  const parsed = parseYaml(buffer.toString('utf8'));
  assertBuildOrigin(parsed);
  if (canonicalJson(parsed) !== canonicalJson(record)) {
    throw new Error(`${label} locked Origin bytes do not encode the captured Origin record`);
  }
  return {
    attestation,
    record,
    originIdentitySha256: capture.originIdentitySha256,
    artifactSha256: digest(buffer),
  };
}

/**
 * Bind the independently captured project and milestone ORIGIN.yaml bytes into one
 * opaque approval authority. A later self-consistent rewrite cannot reuse either capture.
 */
export function attestBuildOriginPair({
  project,
  milestone,
  repositoryRoot,
  projectId,
  milestoneId,
} = {}) {
  const projectBinding = originArtifactBinding(project, 'project');
  const milestoneBinding = originArtifactBinding(milestone, 'milestone');
  const root = nonEmpty(repositoryRoot, 'repositoryRoot');
  if (!PROJECT_ID.test(projectId)) throw new TypeError('projectId must be a PRJ-XX identifier');
  if (!MILESTONE_ID.test(milestoneId)) throw new TypeError('milestoneId must be an M-XX identifier');
  if (
    projectBinding.record.repository_baseline.root !== root ||
    milestoneBinding.record.repository_baseline.root !== root
  ) {
    throw new Error('paired Build Origins must belong to the exact approval repository root');
  }
  if (
    projectBinding.record.build.mode !== 'bootstrap' ||
    projectBinding.record.build.target_project !== projectId ||
    projectBinding.record.build.target_milestone !== null
  ) {
    throw new Error('project Origin must be the bootstrap capture for the exact project target');
  }
  if (
    milestoneBinding.record.build.mode !== 'milestone' ||
    milestoneBinding.record.build.target_project !== projectId ||
    milestoneBinding.record.build.target_milestone !== milestoneId
  ) {
    throw new Error('milestone Origin must be the milestone capture for the exact approval target');
  }
  const pairDigest = objectDigest({
    repository_root: root,
    project_id: projectId,
    milestone_id: milestoneId,
    project_origin_identity_sha256: projectBinding.originIdentitySha256,
    project_origin_artifact_sha256: projectBinding.artifactSha256,
    milestone_origin_identity_sha256: milestoneBinding.originIdentitySha256,
    milestone_origin_artifact_sha256: milestoneBinding.artifactSha256,
  });
  const authority = deepFreeze({
    schema_version: 1,
    kind: 'cruise_build_origin_pair_authority',
    authority_id: randomUUID(),
    pair_sha256: pairDigest,
    project_origin_sha256: projectBinding.artifactSha256,
    milestone_origin_sha256: milestoneBinding.artifactSha256,
  });
  ORIGIN_PAIR_AUTHORITIES.set(authority, {
    repositoryRoot: root,
    projectId,
    milestoneId,
    pairDigest,
    project: projectBinding,
    milestone: milestoneBinding,
  });
  return authority;
}

/** Verify a pair authority against the current locked artifact digests at approval time. */
export function verifyBuildOriginPairAuthority(
  authority,
  {
    repositoryRoot,
    projectId,
    milestoneId,
    projectOriginSha256,
    milestoneOriginSha256,
  } = {},
) {
  const binding = ORIGIN_PAIR_AUTHORITIES.get(authority);
  if (!binding) throw new Error('Build Origin pair is not opaque runtime authority');
  assertDigest(projectOriginSha256, 'projectOriginSha256');
  assertDigest(milestoneOriginSha256, 'milestoneOriginSha256');
  if (
    repositoryRoot !== binding.repositoryRoot ||
    projectId !== binding.projectId ||
    milestoneId !== binding.milestoneId ||
    projectOriginSha256 !== binding.project.artifactSha256 ||
    milestoneOriginSha256 !== binding.milestone.artifactSha256
  ) {
    throw new Error('Build Origin pair does not match the exact locked approval artifacts or target');
  }
  const receipt = deepFreeze({
    schema_version: 1,
    kind: 'cruise_verified_build_origin_pair',
    pair_sha256: binding.pairDigest,
    repository_root: binding.repositoryRoot,
    project_id: binding.projectId,
    milestone_id: binding.milestoneId,
    project_origin_sha256: binding.project.artifactSha256,
    milestone_origin_sha256: binding.milestone.artifactSha256,
  });
  VERIFIED_ORIGIN_PAIRS.add(receipt);
  return receipt;
}

export function isVerifiedBuildOriginPairReceipt(value) {
  return VERIFIED_ORIGIN_PAIRS.has(value);
}

function assertOriginBinding(attestation, originRecord) {
  const receipt = verifyInitialBuildOriginAttestation(attestation, { originRecord });
  return {
    originIdentitySha256: receipt.origin_identity_sha256,
    projectId: receipt.project_id,
    milestoneId: receipt.milestone_id,
  };
}

function eventDigest(event) {
  return objectDigest({
    revision: event.revision,
    previous_event_sha256: event.previous_event_sha256,
    type: event.type,
    at: event.at,
    detail: event.detail,
  });
}

function createEvent({ revision, previousEventSha256, type, at, detail }) {
  canonicalJson(detail);
  const event = {
    revision,
    previous_event_sha256: previousEventSha256,
    type: nonEmpty(type, 'registry event type'),
    at: timestamp(at, 'registry event timestamp'),
    detail: structuredClone(detail),
    event_sha256: '',
  };
  event.event_sha256 = eventDigest(event);
  return event;
}

function emptyNamespaces() {
  return Object.fromEntries(BUILD_ID_NAMESPACES.map((namespace) => [
    namespace,
    { last_allocated: 0, width: 2 },
  ]));
}

function originRecordForId(id, stableKey, sourcePath) {
  const parsed = parseIdentifier(id);
  return {
    id,
    namespace: parsed.namespace,
    number: parsed.number,
    stable_key: stableKey,
    status: 'active',
    origin_bound: true,
    first_seen_revision: 0,
    last_seen_revision: 0,
    source_paths: [sourcePath],
    superseded_at: null,
  };
}

/** Create an empty persistent registry, seeding the Origin-bound project/milestone IDs. */
export function createBuildIdRegistry({
  initialBuildOriginAttestation,
  originRecord,
  at = new Date().toISOString(),
} = {}) {
  const binding = assertOriginBinding(initialBuildOriginAttestation, originRecord);
  const records = [originRecordForId(
    binding.projectId,
    `project:${binding.projectId}`,
    '@origin/build.target_project',
  )];
  if (binding.milestoneId !== null) {
    records.push(originRecordForId(
      binding.milestoneId,
      `milestone:${binding.projectId}/${binding.milestoneId}`,
      '@origin/build.target_milestone',
    ));
  }
  records.sort(compareIdentifiers);
  const namespaces = emptyNamespaces();
  for (const record of records) {
    const parsed = parseIdentifier(record.id);
    namespaces[record.namespace].last_allocated = Math.max(
      namespaces[record.namespace].last_allocated,
      record.number,
    );
    namespaces[record.namespace].width = Math.max(
      namespaces[record.namespace].width,
      parsed.width,
    );
  }
  const createdAt = timestamp(at, 'registry creation timestamp');
  const event = createEvent({
    revision: 0,
    previousEventSha256: null,
    type: 'created',
    at: createdAt,
    detail: { origin_bound_identifiers: records.map(({ id }) => id) },
  });
  const registry = {
    schema_version: 1,
    kind: REGISTRY_KIND,
    origin_identity_sha256: binding.originIdentitySha256,
    project_id: binding.projectId,
    revision: 0,
    parent_snapshot_sha256: null,
    namespaces,
    records,
    events: [event],
  };
  validateBuildIdRegistry(registry, {
    initialBuildOriginAttestation,
    originRecord,
  });
  return deepFreeze(registry);
}

function assertRegistryEvent(event, index, priorEvent, priorAt) {
  exactKeys(
    event,
    ['revision', 'previous_event_sha256', 'type', 'at', 'detail', 'event_sha256'],
    `registry events[${index}]`,
  );
  if (event.revision !== index) throw new Error('registry event revisions must be contiguous');
  if (event.previous_event_sha256 !== (priorEvent?.event_sha256 ?? null)) {
    throw new Error('registry event hash chain is broken');
  }
  nonEmpty(event.type, `registry events[${index}].type`);
  const normalizedAt = timestamp(event.at, `registry events[${index}].at`);
  if (normalizedAt !== event.at) throw new Error('registry event timestamps must be canonical');
  if (priorAt != null && Date.parse(event.at) < Date.parse(priorAt)) {
    throw new Error('registry event timestamps must be monotonic');
  }
  canonicalJson(event.detail);
  assertDigest(event.event_sha256, `registry events[${index}].event_sha256`);
  if (event.event_sha256 !== eventDigest(event)) throw new Error('registry event digest is invalid');
}

function assertRegistryRecord(record, index, registryRevision) {
  exactKeys(
    record,
    [
      'id',
      'namespace',
      'number',
      'stable_key',
      'status',
      'origin_bound',
      'first_seen_revision',
      'last_seen_revision',
      'source_paths',
      'superseded_at',
    ],
    `registry records[${index}]`,
  );
  const parsed = parseIdentifier(record.id, `registry records[${index}].id`);
  if (record.namespace !== parsed.namespace || record.number !== parsed.number) {
    throw new Error(`${record.id} has inconsistent namespace or number metadata`);
  }
  nonEmpty(record.stable_key, `${record.id}.stable_key`);
  if (!['active', 'superseded'].includes(record.status)) {
    throw new TypeError(`${record.id}.status must be active or superseded`);
  }
  if (typeof record.origin_bound !== 'boolean') {
    throw new TypeError(`${record.id}.origin_bound must be boolean`);
  }
  if (
    !Number.isInteger(record.first_seen_revision) ||
    !Number.isInteger(record.last_seen_revision) ||
    record.first_seen_revision < 0 ||
    record.first_seen_revision > record.last_seen_revision ||
    record.last_seen_revision > registryRevision
  ) {
    throw new Error(`${record.id} has invalid first/last-seen revisions`);
  }
  normalizedPaths(record.source_paths, `${record.id}.source_paths`, { allowOrigin: true });
  if (record.status === 'active' && record.superseded_at !== null) {
    throw new Error(`${record.id} is active and cannot have superseded_at`);
  }
  if (record.status === 'superseded') {
    if (record.superseded_at === null) throw new Error(`${record.id} is missing superseded_at`);
    if (timestamp(record.superseded_at, `${record.id}.superseded_at`) !== record.superseded_at) {
      throw new Error(`${record.id}.superseded_at must be canonical`);
    }
  }
  return parsed;
}

/** Validate registry shape, monotonic counters, immutable records, and hash-chained revisions. */
export function validateBuildIdRegistry(
  registry,
  {
    initialBuildOriginAttestation = null,
    originRecord = null,
    previousRegistry = null,
  } = {},
) {
  exactKeys(
    registry,
    [
      'schema_version',
      'kind',
      'origin_identity_sha256',
      'project_id',
      'revision',
      'parent_snapshot_sha256',
      'namespaces',
      'records',
      'events',
    ],
    'Build ID registry',
  );
  if (registry.schema_version !== 1 || registry.kind !== REGISTRY_KIND) {
    throw new Error('Build ID registry schema version or kind is invalid');
  }
  assertDigest(registry.origin_identity_sha256, 'registry origin_identity_sha256');
  if (!PROJECT_ID.test(registry.project_id)) throw new TypeError('registry project_id is invalid');
  if (!Number.isInteger(registry.revision) || registry.revision < 0) {
    throw new TypeError('registry revision must be a non-negative integer');
  }
  if (registry.revision === 0) {
    if (registry.parent_snapshot_sha256 !== null) {
      throw new Error('initial registry cannot have a parent snapshot');
    }
  } else {
    assertDigest(registry.parent_snapshot_sha256, 'registry parent_snapshot_sha256');
  }
  exactKeys(registry.namespaces, BUILD_ID_NAMESPACES, 'registry namespaces');
  const namespaceMetadata = new Map();
  for (const namespace of BUILD_ID_NAMESPACES) {
    const metadata = registry.namespaces[namespace];
    exactKeys(metadata, ['last_allocated', 'width'], `registry namespace ${namespace}`);
    if (!Number.isSafeInteger(metadata.last_allocated) || metadata.last_allocated < 0) {
      throw new TypeError(`${namespace}.last_allocated must be a non-negative safe integer`);
    }
    if (!Number.isInteger(metadata.width) || metadata.width < 2) {
      throw new TypeError(`${namespace}.width must be an integer of at least two`);
    }
    namespaceMetadata.set(namespace, metadata);
  }
  if (!Array.isArray(registry.records) || registry.records.length === 0) {
    throw new TypeError('registry records must contain the Origin-bound project ID');
  }
  const identifiers = new Set();
  const numericSlots = new Set();
  const stableKeys = new Map();
  let priorRecord = null;
  const maxima = new Map(BUILD_ID_NAMESPACES.map((namespace) => [namespace, 0]));
  for (const [index, record] of registry.records.entries()) {
    const parsed = assertRegistryRecord(record, index, registry.revision);
    if (identifiers.has(record.id)) throw new Error(`registry reuses identifier ${record.id}`);
    identifiers.add(record.id);
    const numericSlot = `${record.namespace}:${record.number}`;
    if (numericSlots.has(numericSlot)) {
      throw new Error(`registry renumbers numeric identifier slot ${numericSlot}`);
    }
    numericSlots.add(numericSlot);
    if (stableKeys.has(record.stable_key)) {
      throw new Error(
        `registry renumbers stable entity ${record.stable_key} from ${stableKeys.get(record.stable_key)} to ${record.id}`,
      );
    }
    stableKeys.set(record.stable_key, record.id);
    if (priorRecord && compareIdentifiers(priorRecord, record) >= 0) {
      throw new Error('registry records must use canonical namespace/number order');
    }
    priorRecord = record;
    maxima.set(record.namespace, Math.max(maxima.get(record.namespace), record.number));
    const metadata = namespaceMetadata.get(record.namespace);
    if (parsed.width > metadata.width) throw new Error(`${record.id} exceeds its namespace width`);
  }
  for (const namespace of BUILD_ID_NAMESPACES) {
    if (namespaceMetadata.get(namespace).last_allocated !== maxima.get(namespace)) {
      throw new Error(`${namespace}.last_allocated must equal the greatest preserved identifier`);
    }
  }
  if (!Array.isArray(registry.events) || registry.events.length !== registry.revision + 1) {
    throw new Error('registry events must contain exactly one hash-chained event per revision');
  }
  let priorEvent = null;
  let priorAt = null;
  for (const [index, event] of registry.events.entries()) {
    assertRegistryEvent(event, index, priorEvent, priorAt);
    priorEvent = event;
    priorAt = event.at;
  }
  if (initialBuildOriginAttestation !== null || originRecord !== null) {
    if (initialBuildOriginAttestation === null || originRecord === null) {
      throw new TypeError('registry Origin validation requires both attestation and originRecord');
    }
    const binding = assertOriginBinding(initialBuildOriginAttestation, originRecord);
    if (
      registry.origin_identity_sha256 !== binding.originIdentitySha256 ||
      registry.project_id !== binding.projectId
    ) {
      throw new Error('Build ID registry belongs to another immutable Build Origin');
    }
    const projectRecord = registry.records.find(({ id }) => id === binding.projectId);
    if (!projectRecord?.origin_bound || projectRecord.status !== 'active') {
      throw new Error('registry must preserve the active Origin-bound project identifier');
    }
    if (binding.milestoneId !== null) {
      if (!MILESTONE_ID.test(binding.milestoneId)) throw new Error('Origin milestone ID is invalid');
      const milestoneRecord = registry.records.find(({ id }) => id === binding.milestoneId);
      if (!milestoneRecord?.origin_bound || milestoneRecord.status !== 'active') {
        throw new Error('registry must preserve the active Origin-bound milestone identifier');
      }
    }
  }
  if (previousRegistry !== null) assertBuildIdRegistrySuccessor(previousRegistry, registry);
  return registry;
}

/** Digest-address a registry revision for persistence, approval, and resume. */
export function createBuildIdRegistrySnapshot(registry) {
  validateBuildIdRegistry(registry);
  return deepFreeze({
    schema_version: 1,
    kind: SNAPSHOT_KIND,
    origin_identity_sha256: registry.origin_identity_sha256,
    project_id: registry.project_id,
    revision: registry.revision,
    registry_sha256: objectDigest(registry),
  });
}

export function validateBuildIdRegistrySnapshot(snapshot, registry) {
  exactKeys(
    snapshot,
    ['schema_version', 'kind', 'origin_identity_sha256', 'project_id', 'revision', 'registry_sha256'],
    'Build ID registry snapshot',
  );
  if (snapshot.schema_version !== 1 || snapshot.kind !== SNAPSHOT_KIND) {
    throw new Error('Build ID registry snapshot schema version or kind is invalid');
  }
  assertDigest(snapshot.origin_identity_sha256, 'snapshot origin_identity_sha256');
  assertDigest(snapshot.registry_sha256, 'snapshot registry_sha256');
  validateBuildIdRegistry(registry);
  const actual = createBuildIdRegistrySnapshot(registry);
  if (canonicalJson(actual) !== canonicalJson(snapshot)) {
    throw new Error('Build ID registry snapshot is stale or belongs to another revision');
  }
  return snapshot;
}

/** Reject deletion, identifier reuse, renumbering, revision rollback, or history rewrite. */
export function assertBuildIdRegistrySuccessor(previousRegistry, candidateRegistry) {
  validateBuildIdRegistry(previousRegistry);
  validateBuildIdRegistry(candidateRegistry);
  if (
    previousRegistry.origin_identity_sha256 !== candidateRegistry.origin_identity_sha256 ||
    previousRegistry.project_id !== candidateRegistry.project_id
  ) {
    throw new Error('registry successor belongs to another Build Origin or project');
  }
  if (candidateRegistry.revision !== previousRegistry.revision + 1) {
    throw new Error('registry revisions must advance exactly once');
  }
  if (candidateRegistry.parent_snapshot_sha256 !== objectDigest(previousRegistry)) {
    throw new Error('registry successor parent snapshot digest is stale');
  }
  if (
    canonicalJson(candidateRegistry.events.slice(0, previousRegistry.events.length)) !==
    canonicalJson(previousRegistry.events)
  ) {
    throw new Error('registry event history is append-only');
  }
  const candidateById = new Map(candidateRegistry.records.map((record) => [record.id, record]));
  for (const prior of previousRegistry.records) {
    const next = candidateById.get(prior.id);
    if (!next) throw new Error(`registry successor deleted identifier ${prior.id}`);
    for (const field of ['id', 'namespace', 'number', 'stable_key', 'origin_bound', 'first_seen_revision']) {
      if (next[field] !== prior[field]) throw new Error(`registry successor reused or renumbered ${prior.id}`);
    }
    if (prior.status === 'superseded' && next.status !== 'superseded') {
      throw new Error(`registry successor reactivated superseded identifier ${prior.id}`);
    }
    if (next.last_seen_revision < prior.last_seen_revision) {
      throw new Error(`registry successor rolled back ${prior.id} observation history`);
    }
  }
  for (const namespace of BUILD_ID_NAMESPACES) {
    const prior = previousRegistry.namespaces[namespace];
    const next = candidateRegistry.namespaces[namespace];
    if (next.last_allocated < prior.last_allocated || next.width < prior.width) {
      throw new Error(`registry successor rolled back ${namespace} allocation history`);
    }
  }
  return true;
}

function advanceRegistry(registry, { type, at, detail, mutate }) {
  validateBuildIdRegistry(registry);
  const next = structuredClone(registry);
  const revision = registry.revision + 1;
  const eventAt = timestamp(at, `${type} timestamp`);
  const priorAt = registry.events.at(-1).at;
  if (Date.parse(eventAt) < Date.parse(priorAt)) {
    throw new Error('registry revision timestamp cannot precede prior history');
  }
  next.revision = revision;
  next.parent_snapshot_sha256 = objectDigest(registry);
  mutate(next, revision, eventAt);
  next.records.sort(compareIdentifiers);
  next.events.push(createEvent({
    revision,
    previousEventSha256: registry.events.at(-1).event_sha256,
    type,
    at: eventAt,
    detail,
  }));
  validateBuildIdRegistry(next, { previousRegistry: registry });
  return deepFreeze(next);
}

/** Scan canonical artifact bytes for every Build ID namespace and preserve occurrence paths. */
export function scanBuildIdentifiers(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new TypeError('artifacts must be a non-empty array');
  }
  const paths = new Set();
  const found = new Map();
  for (const [index, artifact] of artifacts.entries()) {
    exactKeys(artifact, ['path', 'content'], `artifacts[${index}]`);
    const path = normalizeSourcePath(artifact.path, `artifacts[${index}].path`);
    if (paths.has(path)) throw new Error(`artifact path appears more than once: ${path}`);
    paths.add(path);
    if (typeof artifact.content !== 'string' && !Buffer.isBuffer(artifact.content)) {
      throw new TypeError(`artifacts[${index}].content must be text or bytes`);
    }
    const text = Buffer.isBuffer(artifact.content)
      ? artifact.content.toString('utf8')
      : artifact.content;
    for (const match of text.matchAll(IDENTIFIER_IN_TEXT)) {
      const id = match[1];
      const parsed = parseIdentifier(id);
      const entry = found.get(id) ?? {
        ...parsed,
        occurrences: 0,
        paths: new Set(),
      };
      entry.occurrences += 1;
      entry.paths.add(path);
      found.set(id, entry);
    }
  }
  return deepFreeze([...found.values()]
    .map((entry) => ({
      id: entry.id,
      namespace: entry.namespace,
      number: entry.number,
      occurrences: entry.occurrences,
      source_paths: [...entry.paths].sort((a, b) => a.localeCompare(b, 'en')),
    }))
    .sort(compareIdentifiers));
}

function identityMap(identities) {
  if (!Array.isArray(identities)) throw new TypeError('identities must be an array');
  const result = new Map();
  for (const [index, identity] of identities.entries()) {
    exactKeys(identity, ['id', 'stable_key', 'status'], `identities[${index}]`);
    parseIdentifier(identity.id, `identities[${index}].id`);
    const stableKey = nonEmpty(identity.stable_key, `identities[${index}].stable_key`);
    if (!['active', 'superseded'].includes(identity.status)) {
      throw new TypeError(`identities[${index}].status must be active or superseded`);
    }
    if (result.has(identity.id)) throw new Error(`identity claim appears more than once: ${identity.id}`);
    result.set(identity.id, { id: identity.id, stable_key: stableKey, status: identity.status });
  }
  return result;
}

function assertClaimsOnlyScanned(claims, scan) {
  const scanned = new Set(scan.map(({ id }) => id));
  for (const id of claims.keys()) {
    if (!scanned.has(id)) throw new Error(`identity claim ${id} was not found in scanned artifacts`);
  }
}

/** One-time import of identifiers already present when the registry is first created. */
export function importInitialBuildIdentifiers(
  registry,
  {
    initialBuildOriginAttestation,
    originRecord,
    artifacts,
    identities,
    at = new Date().toISOString(),
  } = {},
) {
  validateBuildIdRegistry(registry, { initialBuildOriginAttestation, originRecord });
  if (registry.revision !== 0 || registry.records.some(({ origin_bound: bound }) => !bound)) {
    throw new Error('initial identifier import is allowed exactly once before normal allocation');
  }
  const scan = scanBuildIdentifiers(artifacts);
  const claims = identityMap(identities);
  assertClaimsOnlyScanned(claims, scan);
  const existingById = new Map(registry.records.map((record) => [record.id, record]));
  const stableToId = new Map(registry.records.map((record) => [record.stable_key, record.id]));
  const numericSlots = new Map(registry.records.map((record) => [
    `${record.namespace}:${record.number}`,
    record.id,
  ]));
  const imported = [];
  for (const occurrence of scan) {
    const existing = existingById.get(occurrence.id);
    const claim = claims.get(occurrence.id);
    if (existing) {
      if (claim && (claim.stable_key !== existing.stable_key || claim.status !== existing.status)) {
        throw new Error(`initial scan attempts to reuse Origin-bound identifier ${occurrence.id}`);
      }
      continue;
    }
    if (!claim) throw new Error(`initial identifier ${occurrence.id} requires a stable identity claim`);
    if (stableToId.has(claim.stable_key)) {
      throw new Error(
        `initial scan renumbers ${claim.stable_key} from ${stableToId.get(claim.stable_key)} to ${occurrence.id}`,
      );
    }
    const slot = `${occurrence.namespace}:${occurrence.number}`;
    if (numericSlots.has(slot)) {
      throw new Error(`initial scan renumbers numeric slot ${slot}`);
    }
    stableToId.set(claim.stable_key, occurrence.id);
    numericSlots.set(slot, occurrence.id);
    imported.push(occurrence.id);
  }
  return advanceRegistry(registry, {
    type: 'initial_import',
    at,
    detail: { identifiers: imported },
    mutate(next, revision, eventAt) {
      const nextById = new Map(next.records.map((record) => [record.id, record]));
      for (const occurrence of scan) {
        const existing = nextById.get(occurrence.id);
        if (existing) {
          existing.source_paths = [...new Set([
            ...existing.source_paths,
            ...occurrence.source_paths,
          ])].sort((a, b) => a.localeCompare(b, 'en'));
          existing.last_seen_revision = revision;
          continue;
        }
        const claim = claims.get(occurrence.id);
        next.records.push({
          id: occurrence.id,
          namespace: occurrence.namespace,
          number: occurrence.number,
          stable_key: claim.stable_key,
          status: claim.status,
          origin_bound: false,
          first_seen_revision: revision,
          last_seen_revision: revision,
          source_paths: occurrence.source_paths,
          superseded_at: claim.status === 'superseded' ? eventAt : null,
        });
        const parsed = parseIdentifier(occurrence.id);
        const metadata = next.namespaces[occurrence.namespace];
        metadata.last_allocated = Math.max(metadata.last_allocated, occurrence.number);
        metadata.width = Math.max(metadata.width, parsed.width);
      }
    },
  });
}

/** Allocate the next numeric ID; callers cannot select, reuse, or backfill a number. */
export function allocateBuildIdentifier(
  registry,
  {
    initialBuildOriginAttestation,
    originRecord,
    namespace,
    stableKey,
    sourcePaths,
    at = new Date().toISOString(),
  } = {},
) {
  validateBuildIdRegistry(registry, { initialBuildOriginAttestation, originRecord });
  if (!BUILD_ID_NAMESPACES.includes(namespace)) throw new TypeError('namespace is not a Build ID namespace');
  const normalizedStableKey = nonEmpty(stableKey, 'stableKey');
  if (registry.records.some((record) => record.stable_key === normalizedStableKey)) {
    throw new Error(`stable entity ${normalizedStableKey} already has an identifier`);
  }
  const normalizedSourcePaths = normalizedPaths(sourcePaths, 'sourcePaths');
  const metadata = registry.namespaces[namespace];
  const number = metadata.last_allocated + 1;
  const width = Math.max(metadata.width, String(number).length, 2);
  const id = `${namespace}-${String(number).padStart(width, '0')}`;
  const next = advanceRegistry(registry, {
    type: 'allocate',
    at,
    detail: { id, stable_key: normalizedStableKey, source_paths: normalizedSourcePaths },
    mutate(candidate, revision) {
      candidate.namespaces[namespace].last_allocated = number;
      candidate.namespaces[namespace].width = width;
      candidate.records.push({
        id,
        namespace,
        number,
        stable_key: normalizedStableKey,
        status: 'active',
        origin_bound: false,
        first_seen_revision: revision,
        last_seen_revision: revision,
        source_paths: normalizedSourcePaths,
        superseded_at: null,
      });
    },
  });
  return deepFreeze({ identifier: id, registry: next, snapshot: createBuildIdRegistrySnapshot(next) });
}

/** Mark an ID superseded while retaining its number, identity, and occurrence history forever. */
export function supersedeBuildIdentifier(
  registry,
  {
    initialBuildOriginAttestation,
    originRecord,
    identifier,
    rationale,
    at = new Date().toISOString(),
  } = {},
) {
  validateBuildIdRegistry(registry, { initialBuildOriginAttestation, originRecord });
  parseIdentifier(identifier);
  const record = registry.records.find(({ id }) => id === identifier);
  if (!record) throw new Error(`cannot supersede unknown identifier ${identifier}`);
  if (record.origin_bound) throw new Error(`cannot supersede active Origin-bound identifier ${identifier}`);
  if (record.status === 'superseded') throw new Error(`${identifier} is already superseded`);
  const reason = nonEmpty(rationale, 'supersession rationale');
  return advanceRegistry(registry, {
    type: 'supersede',
    at,
    detail: { id: identifier, rationale: reason },
    mutate(next, revision, eventAt) {
      const candidate = next.records.find(({ id }) => id === identifier);
      candidate.status = 'superseded';
      candidate.superseded_at = eventAt;
      candidate.last_seen_revision = revision;
    },
  });
}

/** Re-scan artifacts and reject deletion, reuse, renumbering, or unallocated new IDs. */
export function reconcileBuildIdRegistry(
  registry,
  {
    initialBuildOriginAttestation,
    originRecord,
    artifacts,
    identities,
    at = new Date().toISOString(),
  } = {},
) {
  validateBuildIdRegistry(registry, { initialBuildOriginAttestation, originRecord });
  const scan = scanBuildIdentifiers(artifacts);
  const claims = identityMap(identities);
  assertClaimsOnlyScanned(claims, scan);
  const scannedById = new Map(scan.map((entry) => [entry.id, entry]));
  const recordsById = new Map(registry.records.map((record) => [record.id, record]));
  const stableToId = new Map(registry.records.map((record) => [record.stable_key, record.id]));
  const numericToId = new Map(registry.records.map((record) => [
    `${record.namespace}:${record.number}`,
    record.id,
  ]));
  for (const record of registry.records) {
    const occurrence = scannedById.get(record.id);
    if (!occurrence && !record.origin_bound) {
      throw new Error(`artifact scan deleted preserved identifier ${record.id}`);
    }
    const claim = claims.get(record.id);
    if (!record.origin_bound && !claim) {
      throw new Error(`preserved identifier ${record.id} requires its stable identity claim`);
    }
    if (claim && claim.stable_key !== record.stable_key) {
      throw new Error(`artifact scan reuses ${record.id} for another stable entity`);
    }
    if (claim && claim.status !== record.status) {
      throw new Error(`${record.id} status must change through the registry transition API`);
    }
  }
  for (const occurrence of scan) {
    if (recordsById.has(occurrence.id)) continue;
    const claim = claims.get(occurrence.id);
    if (!claim) throw new Error(`unregistered identifier ${occurrence.id} lacks a stable identity claim`);
    if (stableToId.has(claim.stable_key)) {
      throw new Error(
        `artifact scan renumbers ${claim.stable_key} from ${stableToId.get(claim.stable_key)} to ${occurrence.id}`,
      );
    }
    const slot = `${occurrence.namespace}:${occurrence.number}`;
    if (numericToId.has(slot)) {
      throw new Error(`artifact scan changes the spelling of preserved numeric slot ${slot}`);
    }
    const lastAllocated = registry.namespaces[occurrence.namespace].last_allocated;
    if (occurrence.number <= lastAllocated) {
      throw new Error(`artifact scan reuses historical ${occurrence.namespace} number ${occurrence.number}`);
    }
    throw new Error(`artifact scan introduced unallocated identifier ${occurrence.id}`);
  }
  return advanceRegistry(registry, {
    type: 'reconcile',
    at,
    detail: { identifiers: scan.map(({ id }) => id) },
    mutate(next, revision) {
      for (const record of next.records) {
        const occurrence = scannedById.get(record.id);
        if (!occurrence) continue;
        record.source_paths = record.origin_bound
          ? [...new Set([...record.source_paths.filter((path) => path.startsWith('@origin/')), ...occurrence.source_paths])]
            .sort((a, b) => a.localeCompare(b, 'en'))
          : occurrence.source_paths;
        record.last_seen_revision = revision;
      }
    },
  });
}

function assertRegistryMatchesLockedArtifacts(registry, artifacts, identities) {
  const scan = scanBuildIdentifiers(artifacts);
  const contentManifest = artifacts.map((artifact, index) => {
    exactKeys(artifact, ['path', 'content'], `artifacts[${index}]`);
    const path = normalizeSourcePath(artifact.path, `artifacts[${index}].path`);
    if (typeof artifact.content !== 'string' && !Buffer.isBuffer(artifact.content)) {
      throw new TypeError(`artifacts[${index}].content must be text or bytes`);
    }
    const bytes = Buffer.isBuffer(artifact.content)
      ? artifact.content
      : Buffer.from(artifact.content, 'utf8');
    return { path, sha256: digest(bytes), bytes: bytes.length };
  }).sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const claims = identityMap(identities);
  assertClaimsOnlyScanned(claims, scan);
  const scannedById = new Map(scan.map((entry) => [entry.id, entry]));
  const recordsById = new Map(registry.records.map((record) => [record.id, record]));
  for (const record of registry.records) {
    const occurrence = scannedById.get(record.id);
    if (!occurrence && !record.origin_bound) {
      throw new Error(`locked artifact set deleted preserved identifier ${record.id}`);
    }
    const claim = claims.get(record.id);
    if (!record.origin_bound && !claim) {
      throw new Error(`locked identifier ${record.id} requires its stable identity claim`);
    }
    if (claim && (claim.stable_key !== record.stable_key || claim.status !== record.status)) {
      throw new Error(`locked artifact identity/status for ${record.id} differs from persistent history`);
    }
    const expectedPaths = record.origin_bound
      ? [...new Set([
        ...record.source_paths.filter((path) => path.startsWith('@origin/')),
        ...(occurrence?.source_paths ?? []),
      ])].sort((a, b) => a.localeCompare(b, 'en'))
      : occurrence.source_paths;
    if (canonicalJson(expectedPaths) !== canonicalJson(record.source_paths)) {
      throw new Error(`registry source paths for ${record.id} are stale relative to locked artifacts`);
    }
  }
  for (const occurrence of scan) {
    if (!recordsById.has(occurrence.id)) {
      throw new Error(`locked artifacts contain unregistered identifier ${occurrence.id}`);
    }
  }
  return {
    scan,
    scanSha256: objectDigest(scan),
    contentManifestSha256: objectDigest(contentManifest),
    lockedArtifactIds: scan.map(({ id }) => id),
  };
}

/**
 * Mint approval authority only after the persistent registry, its immediate predecessor,
 * all active/superseded IDs, and the current locked artifact scan agree exactly.
 */
export function attestValidatedBuildIdHistory({
  buildOriginPairAuthority,
  registry,
  previousRegistry = null,
  artifacts,
  identities,
} = {}) {
  const originPair = ORIGIN_PAIR_AUTHORITIES.get(buildOriginPairAuthority);
  if (!originPair) throw new Error('Build ID history requires opaque Build Origin pair authority');
  validateBuildIdRegistry(registry);
  if (
    registry.project_id !== originPair.projectId ||
    ![
      originPair.project.originIdentitySha256,
      originPair.milestone.originIdentitySha256,
    ].includes(registry.origin_identity_sha256)
  ) {
    throw new Error('Build ID history belongs to another locked Build Origin pair');
  }
  if (registry.revision > 0) {
    if (previousRegistry === null) {
      throw new Error('non-initial Build ID history authority requires the exact prior registry revision');
    }
    assertBuildIdRegistrySuccessor(previousRegistry, registry);
  } else if (previousRegistry !== null) {
    throw new Error('initial Build ID history cannot have a prior registry revision');
  }
  const artifactBinding = assertRegistryMatchesLockedArtifacts(registry, artifacts, identities);
  const snapshot = createBuildIdRegistrySnapshot(registry);
  const supersededRecordsSha256 = objectDigest(
    registry.records.filter(({ status }) => status === 'superseded'),
  );
  const previousRegistrySha256 = previousRegistry === null
    ? null
    : objectDigest(previousRegistry);
  const authority = deepFreeze({
    schema_version: 1,
    kind: 'cruise_validated_build_id_history_authority',
    authority_id: randomUUID(),
    registry_sha256: snapshot.registry_sha256,
    artifact_scan_sha256: artifactBinding.scanSha256,
    artifact_content_manifest_sha256: artifactBinding.contentManifestSha256,
    superseded_records_sha256: supersededRecordsSha256,
    previous_registry_sha256: previousRegistrySha256,
  });
  ID_HISTORY_AUTHORITIES.set(authority, {
    buildOriginPairAuthority,
    originPairSha256: originPair.pairDigest,
    registrySnapshot: snapshot,
    artifactScanSha256: artifactBinding.scanSha256,
    artifactContentManifestSha256: artifactBinding.contentManifestSha256,
    lockedArtifactIds: artifactBinding.lockedArtifactIds,
    supersededRecordsSha256,
    previousRegistrySha256,
    previousRegistry: previousRegistry === null ? null : structuredClone(previousRegistry),
  });
  return authority;
}

/** Recheck opaque history authority against the exact registry and locked artifacts. */
export function verifyValidatedBuildIdHistoryAuthority(
  authority,
  {
    buildOriginPairAuthority,
    registry,
    previousRegistry = undefined,
    artifacts,
    identities,
  } = {},
) {
  const binding = ID_HISTORY_AUTHORITIES.get(authority);
  if (!binding) throw new Error('Build ID history is not opaque runtime authority');
  if (binding.buildOriginPairAuthority !== buildOriginPairAuthority) {
    throw new Error('Build ID history authority belongs to another Build Origin pair');
  }
  const originPair = ORIGIN_PAIR_AUTHORITIES.get(buildOriginPairAuthority);
  if (!originPair || originPair.pairDigest !== binding.originPairSha256) {
    throw new Error('Build ID history Origin-pair authority is invalid');
  }
  validateBuildIdRegistry(registry);
  const trustedPreviousRegistry = previousRegistry === undefined
    ? binding.previousRegistry
    : previousRegistry;
  if (registry.revision > 0) {
    if (trustedPreviousRegistry === null) throw new Error('history verification requires the prior registry');
    assertBuildIdRegistrySuccessor(trustedPreviousRegistry, registry);
  } else if (trustedPreviousRegistry !== null) {
    throw new Error('initial registry cannot be verified with a predecessor');
  }
  const artifactBinding = assertRegistryMatchesLockedArtifacts(registry, artifacts, identities);
  const snapshot = createBuildIdRegistrySnapshot(registry);
  const supersededRecordsSha256 = objectDigest(
    registry.records.filter(({ status }) => status === 'superseded'),
  );
  const previousRegistrySha256 = trustedPreviousRegistry === null
    ? null
    : objectDigest(trustedPreviousRegistry);
  if (
    canonicalJson(snapshot) !== canonicalJson(binding.registrySnapshot) ||
    artifactBinding.scanSha256 !== binding.artifactScanSha256 ||
    artifactBinding.contentManifestSha256 !== binding.artifactContentManifestSha256 ||
    supersededRecordsSha256 !== binding.supersededRecordsSha256 ||
    previousRegistrySha256 !== binding.previousRegistrySha256
  ) {
    throw new Error('Build ID history authority is stale or locked artifacts/history changed');
  }
  const receipt = deepFreeze({
    schema_version: 1,
    kind: 'cruise_verified_build_id_history',
    origin_pair_sha256: binding.originPairSha256,
    registry_sha256: binding.registrySnapshot.registry_sha256,
    registry_revision: binding.registrySnapshot.revision,
    artifact_scan_sha256: binding.artifactScanSha256,
    artifact_content_manifest_sha256: binding.artifactContentManifestSha256,
    locked_artifact_ids: [...binding.lockedArtifactIds],
    superseded_records_sha256: binding.supersededRecordsSha256,
    previous_registry_sha256: binding.previousRegistrySha256,
  });
  VERIFIED_ID_HISTORIES.add(receipt);
  return receipt;
}

export function isVerifiedBuildIdHistoryReceipt(value) {
  return VERIFIED_ID_HISTORIES.has(value);
}

/** Mint a one-use, exact-revision resume authority. */
export function attestBuildHistoryResume({
  initialBuildOriginAttestation,
  originRecord,
  registry,
  snapshot = createBuildIdRegistrySnapshot(registry),
} = {}) {
  validateBuildIdRegistry(registry, { initialBuildOriginAttestation, originRecord });
  validateBuildIdRegistrySnapshot(snapshot, registry);
  const token = deepFreeze({
    schema_version: 1,
    kind: 'cruise_build_history_resume_attestation',
    attestation_id: randomUUID(),
    registry_sha256: snapshot.registry_sha256,
    revision: snapshot.revision,
  });
  RESUME_ATTESTATIONS.set(token, {
    initialBuildOriginAttestation,
    originIdentitySha256: registry.origin_identity_sha256,
    projectId: registry.project_id,
    registrySha256: snapshot.registry_sha256,
    revision: snapshot.revision,
  });
  return token;
}

/** Consume resume authority once; stale snapshots and cloned/replayed tokens fail closed. */
export function consumeBuildHistoryResume({
  resumeAttestation,
  initialBuildOriginAttestation,
  originRecord,
  registry,
  snapshot = createBuildIdRegistrySnapshot(registry),
} = {}) {
  const binding = RESUME_ATTESTATIONS.get(resumeAttestation);
  if (!binding) throw new Error('Build history resume attestation is not opaque runtime authority');
  if (CONSUMED_RESUME_ATTESTATIONS.has(resumeAttestation)) {
    throw new Error('Build history resume attestation has already been consumed');
  }
  validateBuildIdRegistry(registry, { initialBuildOriginAttestation, originRecord });
  validateBuildIdRegistrySnapshot(snapshot, registry);
  if (
    binding.initialBuildOriginAttestation !== initialBuildOriginAttestation ||
    binding.originIdentitySha256 !== registry.origin_identity_sha256 ||
    binding.projectId !== registry.project_id ||
    binding.registrySha256 !== snapshot.registry_sha256 ||
    binding.revision !== snapshot.revision
  ) {
    throw new Error('Build history resume authority is stale or belongs to another Origin/revision');
  }
  CONSUMED_RESUME_ATTESTATIONS.add(resumeAttestation);
  const receipt = deepFreeze({
    schema_version: 1,
    kind: 'cruise_consumed_build_history_resume',
    origin_identity_sha256: binding.originIdentitySha256,
    project_id: binding.projectId,
    registry_sha256: binding.registrySha256,
    revision: binding.revision,
  });
  RESUME_RECEIPTS.add(receipt);
  return receipt;
}

export function isConsumedBuildHistoryResumeReceipt(value) {
  return RESUME_RECEIPTS.has(value);
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function readNoFollow(path, label = basename(path)) {
  const beforePath = await lstat(path);
  if (beforePath.isSymbolicLink() || !beforePath.isFile()) {
    throw new Error(`${label} must be a regular no-follow file`);
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(beforePath, opened)) {
      throw new Error(`${label} changed before it could be read`);
    }
    const bytes = await handle.readFile();
    const afterRead = await handle.stat();
    const afterPath = await lstat(path);
    if (
      !sameFileIdentity(opened, afterRead) ||
      !sameFileIdentity(afterRead, afterPath) ||
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      bytes.length !== afterRead.size
    ) {
      throw new Error(`${label} changed while it was read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readNoFollowIfExists(path, label = basename(path)) {
  try {
    return await readNoFollow(path, label);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function syncDirectory(path) {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0),
  );
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
  if (await realpath(path) !== path) {
    throw new Error(`${label} must not traverse a symbolic link`);
  }
  return { dev: metadata.dev, ino: metadata.ino };
}

async function assertDirectoryIdentity(path, expected, label) {
  const current = await directoryIdentity(path, label);
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`${label} changed during Build ID registry persistence`);
  }
}

async function ensureSafeRegistryDirectory(repositoryRoot) {
  let cursor = repositoryRoot;
  for (const component of ['.cruise', 'project']) {
    const parent = cursor;
    cursor = join(cursor, component);
    let createdHere = false;
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Build ID registry path component is unsafe: ${cursor}`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      try {
        await mkdir(cursor, { mode: 0o700 });
        createdHere = true;
      } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      }
      const created = await lstat(cursor);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error(`Build ID registry path component is unsafe: ${cursor}`);
      }
    }
    if (createdHere) await syncDirectory(parent);
  }
  if (await realpath(cursor) !== cursor) {
    throw new Error('Build ID registry directory must not traverse a symbolic link');
  }
  return cursor;
}

async function registryLocations(
  path,
  { initialBuildOriginAttestation = null, originRecord = null, create = false } = {},
) {
  const absoluteInput = resolve(nonEmpty(path, 'Build ID registry path'));
  let canonicalDirectory;
  let repositoryRoot = null;
  if (initialBuildOriginAttestation !== null || originRecord !== null) {
    if (initialBuildOriginAttestation === null || originRecord === null) {
      throw new TypeError('Build ID registry path binding requires both Origin authority and record');
    }
    assertOriginBinding(initialBuildOriginAttestation, originRecord);
    const recordedRepositoryRoot = resolve(originRecord.repository_baseline.root);
    repositoryRoot = await realpath(recordedRepositoryRoot);
    const expectedDirectory = resolve(repositoryRoot, '.cruise', 'project');
    const recordedExpectedDirectory = resolve(recordedRepositoryRoot, '.cruise', 'project');
    canonicalDirectory = create
      ? await ensureSafeRegistryDirectory(repositoryRoot)
      : await realpath(expectedDirectory);
    if (canonicalDirectory !== expectedDirectory) {
      throw new Error('Build ID registry directory must not traverse a symbolic link');
    }
    const requestedDirectoryPath = resolve(dirname(absoluteInput));
    const requestedDirectory = await realpath(dirname(absoluteInput));
    if (
      basename(absoluteInput) !== 'ID-REGISTRY.yaml' ||
      (requestedDirectoryPath !== expectedDirectory &&
        requestedDirectoryPath !== recordedExpectedDirectory) ||
      requestedDirectory !== canonicalDirectory ||
      resolve(canonicalDirectory, 'ID-REGISTRY.yaml') !==
        resolve(requestedDirectory, basename(absoluteInput))
    ) {
      throw new Error('Build ID registry path differs from the immutable Origin repository root');
    }
  } else {
    canonicalDirectory = await realpath(dirname(absoluteInput));
  }
  const absolute = resolve(canonicalDirectory, basename(absoluteInput));
  if (basename(absolute) !== 'ID-REGISTRY.yaml') {
    throw new Error('Build ID registry must use the exact ID-REGISTRY.yaml filename');
  }
  try {
    const current = await lstat(absolute);
    if (current.isSymbolicLink() || (!current.isFile() && !current.isDirectory())) {
      throw new Error('ID-REGISTRY.yaml is not a safe regular path');
    }
    if (current.isDirectory()) throw new Error('ID-REGISTRY.yaml cannot be a directory');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return {
    absolute,
    directory: canonicalDirectory,
    cruise_directory: dirname(canonicalDirectory),
    repository_root: repositoryRoot,
    history_directory: join(canonicalDirectory, REGISTRY_HISTORY_DIRECTORY),
    head_path: join(canonicalDirectory, REGISTRY_HEAD_FILE),
    pending_path: join(canonicalDirectory, REGISTRY_PENDING_FILE),
    lock_path: join(canonicalDirectory, REGISTRY_LOCK_FILE),
  };
}

function historyEntryPayload(entry) {
  const { entry_sha256: ignored, ...payload } = entry;
  void ignored;
  return payload;
}

function createRegistryHistoryEntry(registry, registryBytes, previousEntry, { legacyAnchor = false } = {}) {
  const payload = {
    schema_version: 1,
    kind: 'cruise_build_id_registry_history_entry',
    origin_identity_sha256: registry.origin_identity_sha256,
    project_id: registry.project_id,
    revision: registry.revision,
    legacy_anchor: legacyAnchor,
    registry_sha256: objectDigest(registry),
    registry_file_sha256: digest(registryBytes),
    registry_yaml_base64: registryBytes.toString('base64'),
    previous_entry_sha256: previousEntry?.entry_sha256 ?? null,
  };
  return deepFreeze({ ...payload, entry_sha256: objectDigest(payload) });
}

function validateRegistryHistoryEntry(entry, previous = null) {
  exactKeys(entry, [
    'schema_version',
    'kind',
    'origin_identity_sha256',
    'project_id',
    'revision',
    'legacy_anchor',
    'registry_sha256',
    'registry_file_sha256',
    'registry_yaml_base64',
    'previous_entry_sha256',
    'entry_sha256',
  ], 'Build ID registry history entry');
  if (
    entry.schema_version !== 1 ||
    entry.kind !== 'cruise_build_id_registry_history_entry' ||
    typeof entry.legacy_anchor !== 'boolean' ||
    entry.previous_entry_sha256 !== (previous?.entry.entry_sha256 ?? null)
  ) {
    throw new Error('Build ID registry history entry breaks its immutable chain');
  }
  assertDigest(entry.origin_identity_sha256, 'registry history origin_identity_sha256');
  if (!PROJECT_ID.test(entry.project_id)) throw new Error('registry history project_id is invalid');
  assertDigest(entry.registry_sha256, 'registry history registry_sha256');
  assertDigest(entry.registry_file_sha256, 'registry history registry_file_sha256');
  assertDigest(entry.entry_sha256, 'registry history entry_sha256');
  if (entry.entry_sha256 !== objectDigest(historyEntryPayload(entry))) {
    throw new Error('Build ID registry history entry digest was rewritten');
  }
  const registryBytes = Buffer.from(
    nonEmpty(entry.registry_yaml_base64, 'registry history registry_yaml_base64'),
    'base64',
  );
  if (registryBytes.toString('base64') !== entry.registry_yaml_base64) {
    throw new Error('Build ID registry history bytes are not canonical base64');
  }
  if (digest(registryBytes) !== entry.registry_file_sha256) {
    throw new Error('Build ID registry history exact file bytes changed');
  }
  const registry = parseYaml(registryBytes.toString('utf8'));
  validateBuildIdRegistry(registry);
  if (
    registry.revision !== entry.revision ||
    registry.origin_identity_sha256 !== entry.origin_identity_sha256 ||
    registry.project_id !== entry.project_id ||
    objectDigest(registry) !== entry.registry_sha256
  ) {
    throw new Error('Build ID registry history entry differs from its embedded registry');
  }
  if (previous === null) {
    if (!entry.legacy_anchor && registry.revision !== 0) {
      throw new Error('new Build ID registry history must begin at revision zero');
    }
  } else {
    if (entry.legacy_anchor) throw new Error('only the first Build ID registry history entry may be legacy');
    assertBuildIdRegistrySuccessor(previous.registry, registry);
  }
  return { entry, registry, registry_bytes: registryBytes };
}

function headPayload(head) {
  const { head_sha256: ignored, ...payload } = head;
  void ignored;
  return payload;
}

function createRegistryHead(validated, previousHead = null, anchorRevision = null) {
  const { entry } = validated;
  const anchor = anchorRevision ?? entry.revision;
  const generation = `REV-${String(entry.revision).padStart(12, '0')}-${entry.registry_sha256}.yaml`;
  const payload = {
    schema_version: 1,
    kind: 'cruise_build_id_registry_head',
    origin_identity_sha256: entry.origin_identity_sha256,
    project_id: entry.project_id,
    anchor_revision: anchor,
    revision: entry.revision,
    generation,
    registry_sha256: entry.registry_sha256,
    registry_file_sha256: entry.registry_file_sha256,
    history_entry_sha256: entry.entry_sha256,
    previous_head_sha256: previousHead?.head_sha256 ?? null,
  };
  return deepFreeze({ ...payload, head_sha256: objectDigest(payload) });
}

function validateRegistryHead(head, expected) {
  exactKeys(head, [
    'schema_version',
    'kind',
    'origin_identity_sha256',
    'project_id',
    'anchor_revision',
    'revision',
    'generation',
    'registry_sha256',
    'registry_file_sha256',
    'history_entry_sha256',
    'previous_head_sha256',
    'head_sha256',
  ], 'Build ID registry committed head');
  if (
    head.schema_version !== 1 ||
    head.kind !== 'cruise_build_id_registry_head' ||
    head.head_sha256 !== objectDigest(headPayload(head)) ||
    canonicalJson(head) !== canonicalJson(expected)
  ) {
    throw new Error('Build ID registry committed head is stale, forked, or invalid');
  }
  return head;
}

async function ensureRegistryHistoryDirectory(locations) {
  let created = false;
  try {
    await mkdir(locations.history_directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  if (created) await syncDirectory(locations.directory);
  return directoryIdentity(locations.history_directory, 'Build ID registry history directory');
}

async function readRegistryHistory(locations, { allowMissing = false, allowEmpty = false } = {}) {
  let identity;
  try {
    identity = await directoryIdentity(
      locations.history_directory,
      'Build ID registry history directory',
    );
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw error;
  }
  const entries = await readdir(locations.history_directory, { withFileTypes: true });
  if (entries.length === 0) {
    if (allowEmpty) return null;
    throw new Error('Build ID registry history cannot be empty');
  }
  const parsedNames = entries.map((entry) => {
    const match = REGISTRY_HISTORY_ENTRY.exec(entry.name);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('Build ID registry history contains an unapproved entry');
    }
    return { entry, revision: Number(match[1]), registry_sha256: match[2] };
  }).sort((left, right) => left.revision - right.revision);
  const anchorRevision = parsedNames[0].revision;
  const validated = [];
  const heads = [];
  let previous = null;
  let previousHead = null;
  for (const [index, candidate] of parsedNames.entries()) {
    if (candidate.revision !== anchorRevision + index) {
      throw new Error('Build ID registry history revisions must be contiguous');
    }
    const bytes = await readNoFollow(
      join(locations.history_directory, candidate.entry.name),
      `Build ID registry history ${candidate.entry.name}`,
    );
    const record = parseYaml(bytes.toString('utf8'));
    const item = validateRegistryHistoryEntry(record, previous);
    if (
      item.entry.revision !== candidate.revision ||
      item.entry.registry_sha256 !== candidate.registry_sha256
    ) {
      throw new Error('Build ID registry history filename differs from its exact entry');
    }
    const head = createRegistryHead(item, previousHead, anchorRevision);
    validated.push({ ...item, file_sha256: digest(bytes), name: candidate.entry.name });
    heads.push(head);
    previous = item;
    previousHead = head;
  }
  await assertDirectoryIdentity(
    locations.history_directory,
    identity,
    'Build ID registry history directory',
  );
  return {
    anchor_revision: anchorRevision,
    items: validated,
    heads,
    head: validated.at(-1),
    derived_head: heads.at(-1),
  };
}

async function readRegistryHead(locations, { allowMissing = false } = {}) {
  const bytes = await readNoFollowIfExists(
    locations.head_path,
    'Build ID registry committed head',
  );
  if (bytes === null) {
    if (allowMissing) return null;
    throw new Error('Build ID registry committed head is missing');
  }
  const head = parseYaml(bytes.toString('utf8'));
  if (!isPlainObject(head)) throw new Error('Build ID registry committed head must be a mapping');
  return { head, bytes };
}

function registryCommitmentLocations(locations, registryBinding) {
  assertDigest(
    registryBinding.origin_identity_sha256,
    'registry commitment origin_identity_sha256',
  );
  if (!PROJECT_ID.test(registryBinding.project_id)) {
    throw new Error('registry commitment project_id is invalid');
  }
  const key = digest(
    `${registryBinding.origin_identity_sha256}\0${registryBinding.project_id}`,
  );
  const directory = join(locations.cruise_directory, REGISTRY_COMMITMENTS_DIRECTORY);
  return {
    key,
    directory,
    lineage_directory: join(directory, key),
  };
}

function registryCommitmentPayload(head, previousCommitment = null) {
  return {
    schema_version: 1,
    kind: 'cruise_build_id_registry_revision_commitment',
    origin_identity_sha256: head.origin_identity_sha256,
    project_id: head.project_id,
    registry_path: '.cruise/project/ID-REGISTRY.yaml',
    anchor_revision: head.anchor_revision,
    revision: head.revision,
    generation: head.generation,
    registry_sha256: head.registry_sha256,
    registry_file_sha256: head.registry_file_sha256,
    history_entry_sha256: head.history_entry_sha256,
    previous_head_sha256: head.previous_head_sha256,
    head_sha256: head.head_sha256,
    previous_commitment_sha256: previousCommitment?.commitment_sha256 ?? null,
  };
}

function validateRegistryCommitment(
  commitment,
  registryBinding,
  previousCommitment = null,
  expectedHead = null,
) {
  exactKeys(commitment, [
    'schema_version',
    'kind',
    'origin_identity_sha256',
    'project_id',
    'registry_path',
    'anchor_revision',
    'revision',
    'generation',
    'registry_sha256',
    'registry_file_sha256',
    'history_entry_sha256',
    'previous_head_sha256',
    'head_sha256',
    'previous_commitment_sha256',
    'commitment_sha256',
  ], 'Build ID registry revision commitment');
  const { commitment_sha256: commitmentSha256, ...payload } = commitment;
  if (
    commitment.schema_version !== 1 ||
    commitment.kind !== 'cruise_build_id_registry_revision_commitment' ||
    commitment.origin_identity_sha256 !== registryBinding.origin_identity_sha256 ||
    commitment.project_id !== registryBinding.project_id ||
    commitment.registry_path !== '.cruise/project/ID-REGISTRY.yaml' ||
    !Number.isSafeInteger(commitment.anchor_revision) ||
    commitment.anchor_revision < 0 ||
    !Number.isSafeInteger(commitment.revision) ||
    commitment.revision < commitment.anchor_revision ||
    commitment.previous_commitment_sha256 !==
      (previousCommitment?.commitment_sha256 ?? null) ||
    commitmentSha256 !== objectDigest(payload)
  ) {
    throw new Error('Build ID registry revision commitment breaks its immutable lineage');
  }
  assertDigest(commitment.registry_sha256, 'registry commitment registry_sha256');
  assertDigest(commitment.registry_file_sha256, 'registry commitment registry_file_sha256');
  assertDigest(commitment.history_entry_sha256, 'registry commitment history_entry_sha256');
  assertDigest(commitment.head_sha256, 'registry commitment head_sha256');
  assertDigest(commitmentSha256, 'registry commitment commitment_sha256');
  if (commitment.previous_head_sha256 !== null) {
    assertDigest(commitment.previous_head_sha256, 'registry commitment previous_head_sha256');
  }
  if (commitment.previous_commitment_sha256 !== null) {
    assertDigest(
      commitment.previous_commitment_sha256,
      'registry commitment previous_commitment_sha256',
    );
  }
  if (!REGISTRY_HISTORY_ENTRY.test(commitment.generation)) {
    throw new Error('Build ID registry revision commitment generation is invalid');
  }
  if (
    previousCommitment !== null &&
    (commitment.revision !== previousCommitment.revision + 1 ||
      commitment.anchor_revision !== previousCommitment.anchor_revision ||
      commitment.previous_head_sha256 !== previousCommitment.head_sha256)
  ) {
    throw new Error('Build ID registry revision commitments are not contiguous');
  }
  if (
    expectedHead !== null &&
    canonicalJson(payload) !==
      canonicalJson(registryCommitmentPayload(expectedHead, previousCommitment))
  ) {
    throw new Error('Build ID registry history differs from its durable revision commitment');
  }
  return commitment;
}

async function ensureRegistryCommitmentDirectory(locations, registryBinding) {
  const commitmentLocations = registryCommitmentLocations(locations, registryBinding);
  for (const [directory, parent, label] of [
    [
      commitmentLocations.directory,
      locations.cruise_directory,
      'Build ID registry commitment storage',
    ],
    [
      commitmentLocations.lineage_directory,
      commitmentLocations.directory,
      'Build ID registry commitment lineage',
    ],
  ]) {
    let created = false;
    try {
      await mkdir(directory, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (created) await syncDirectory(parent);
    await directoryIdentity(directory, label);
  }
  return commitmentLocations;
}

async function readRegistryCommitments(
  locations,
  registryBinding,
  { allowMissing = false, allowEmpty = false } = {},
) {
  const commitmentLocations = registryCommitmentLocations(locations, registryBinding);
  let identity;
  try {
    identity = await directoryIdentity(
      commitmentLocations.lineage_directory,
      'Build ID registry commitment lineage',
    );
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw error;
  }
  const directoryEntries = await readdir(
    commitmentLocations.lineage_directory,
    { withFileTypes: true },
  );
  if (directoryEntries.length === 0) {
    if (allowEmpty) return { anchor_revision: null, entries: [], head: null };
    throw new Error('Build ID registry commitment lineage cannot be empty');
  }
  const names = directoryEntries.map((entry) => {
    const match = REGISTRY_COMMITMENT_ENTRY.exec(entry.name);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('Build ID registry commitment lineage contains an unapproved entry');
    }
    return { name: entry.name, revision: Number(match[1]), head_sha256: match[2] };
  }).sort((left, right) => left.revision - right.revision);
  const anchorRevision = names[0].revision;
  const entries = [];
  let previous = null;
  for (const [index, candidate] of names.entries()) {
    if (candidate.revision !== anchorRevision + index) {
      throw new Error('Build ID registry revision commitments must be contiguous');
    }
    const bytes = await readNoFollow(
      join(commitmentLocations.lineage_directory, candidate.name),
      `Build ID registry revision commitment ${candidate.revision}`,
    );
    const commitment = validateRegistryCommitment(
      parseYaml(bytes.toString('utf8')),
      registryBinding,
      previous,
    );
    if (
      commitment.revision !== candidate.revision ||
      commitment.head_sha256 !== candidate.head_sha256 ||
      commitment.anchor_revision !== anchorRevision
    ) {
      throw new Error('Build ID registry commitment filename differs from its exact entry');
    }
    entries.push(commitment);
    previous = commitment;
  }
  await assertDirectoryIdentity(
    commitmentLocations.lineage_directory,
    identity,
    'Build ID registry commitment lineage',
  );
  return { anchor_revision: anchorRevision, entries, head: entries.at(-1) };
}

function assertRegistryCommitmentsMatchHistory(registryBinding, commitments, history) {
  if (commitments === null) {
    throw new Error('Build ID registry durable revision commitment lineage is missing');
  }
  if (commitments.entries.length > history.items.length) {
    throw new Error('Build ID registry history rolled back behind its durable revision commitments');
  }
  if (commitments.entries.length < history.items.length) {
    throw new Error('Build ID registry durable revision commitments were truncated');
  }
  let previous = null;
  for (const [index, commitment] of commitments.entries.entries()) {
    validateRegistryCommitment(
      commitment,
      registryBinding,
      previous,
      history.heads[index],
    );
    previous = commitment;
  }
}

async function publishRegistryCommitment(
  locations,
  registryBinding,
  head,
  { faultInjector = null } = {},
) {
  const commitmentLocations = await ensureRegistryCommitmentDirectory(
    locations,
    registryBinding,
  );
  const commitmentDirectoryIdentity = await directoryIdentity(
    commitmentLocations.directory,
    'Build ID registry commitment storage',
  );
  const lineageDirectoryIdentity = await directoryIdentity(
    commitmentLocations.lineage_directory,
    'Build ID registry commitment lineage',
  );
  const current = await readRegistryCommitments(locations, registryBinding, {
    allowEmpty: true,
  });
  const previous = current.head;
  if (previous !== null && previous.revision === head.revision) {
    validateRegistryCommitment(previous, registryBinding, current.entries.at(-2) ?? null, head);
    return;
  }
  if (
    (previous === null && head.previous_head_sha256 !== null) ||
    (previous !== null &&
      (head.revision !== previous.revision + 1 ||
        head.previous_head_sha256 !== previous.head_sha256))
  ) {
    throw new Error('Build ID registry commitment cannot skip or fork a committed revision');
  }
  const payload = registryCommitmentPayload(head, previous);
  const commitment = deepFreeze({
    ...payload,
    commitment_sha256: objectDigest(payload),
  });
  const name = `REV-${String(head.revision).padStart(12, '0')}-${head.head_sha256}.yaml`;
  const finalPath = join(commitmentLocations.lineage_directory, name);
  const temporaryPath = join(
    commitmentLocations.directory,
    `.${commitmentLocations.key}.${name}.${process.pid}.${randomUUID()}.tmp`,
  );
  const bytes = Buffer.from(stringifyYaml(commitment), 'utf8');
  try {
    await writeNewFile(temporaryPath, bytes, 0o400);
    await invokeRegistryFault(faultInjector, 'after_commitment_prepare');
    await assertDirectoryIdentity(
      commitmentLocations.directory,
      commitmentDirectoryIdentity,
      'Build ID registry commitment storage',
    );
    await assertDirectoryIdentity(
      commitmentLocations.lineage_directory,
      lineageDirectoryIdentity,
      'Build ID registry commitment lineage',
    );
    await link(temporaryPath, finalPath);
    await syncDirectory(commitmentLocations.lineage_directory);
    await assertDirectoryIdentity(
      commitmentLocations.lineage_directory,
      lineageDirectoryIdentity,
      'Build ID registry commitment lineage',
    );
    await invokeRegistryFault(faultInjector, 'after_commitment_append');
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readNoFollow(finalPath, 'Build ID registry revision commitment');
    if (!existing.equals(bytes)) {
      throw new Error('Build ID registry revision commitment was already used by a fork');
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
  const appended = await readRegistryCommitments(locations, registryBinding);
  if (
    appended.entries.length !== current.entries.length + 1 ||
    appended.head.commitment_sha256 !== commitment.commitment_sha256
  ) {
    throw new Error('Build ID registry revision commitment append was not exact');
  }
}

function committedHeadKey(locations, registry) {
  return `${locations.absolute}\0${registry.origin_identity_sha256}\0${registry.project_id}`;
}

function rememberCommittedHead(locations, registry, head) {
  const key = committedHeadKey(locations, registry);
  const known = COMMITTED_REGISTRY_HEADS.get(key);
  if (known != null) {
    if (
      registry.revision < known.registry.revision ||
      (registry.revision === known.registry.revision &&
        (objectDigest(registry) !== objectDigest(known.registry) ||
          head.head_sha256 !== known.head.head_sha256))
    ) {
      throw new Error('Build ID registry rolled back or forked behind the live committed head');
    }
  }
  COMMITTED_REGISTRY_HEADS.set(key, {
    registry: structuredClone(registry),
    head: structuredClone(head),
  });
}

function knownCommittedHead(locations, registry) {
  return COMMITTED_REGISTRY_HEADS.get(committedHeadKey(locations, registry)) ?? null;
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

async function invokeRegistryFault(faultInjector, step) {
  if (faultInjector !== null) await faultInjector(step);
}

async function atomicReplaceRegistryFile({
  path,
  bytes,
  locations,
  label,
  faultInjector = null,
  preparedStep = null,
  committedStep = null,
}) {
  const identity = await directoryIdentity(locations.directory, 'Build ID registry directory');
  const temporaryPath = join(
    locations.directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let prepared = false;
  try {
    await writeNewFile(temporaryPath, bytes, 0o600);
    prepared = true;
    if (preparedStep !== null) await invokeRegistryFault(faultInjector, preparedStep);
    await assertDirectoryIdentity(locations.directory, identity, 'Build ID registry directory');
    try {
      const target = await lstat(path);
      if (target.isSymbolicLink() || !target.isFile()) {
        throw new Error(`${label} target must be a regular no-follow file`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await rename(temporaryPath, path);
    prepared = false;
    await syncDirectory(locations.directory);
    await assertDirectoryIdentity(locations.directory, identity, 'Build ID registry directory');
    if (committedStep !== null) await invokeRegistryFault(faultInjector, committedStep);
  } finally {
    if (prepared) await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function lockMetadata(registry) {
  return {
    schema_version: 1,
    kind: 'cruise_build_id_registry_writer_lock',
    origin_identity_sha256: registry.origin_identity_sha256,
    project_id: registry.project_id,
    registry_path: 'ID-REGISTRY.yaml',
    pid: process.pid,
    nonce: randomUUID(),
    acquired_at: new Date().toISOString(),
  };
}

function validateLockMetadata(record, registry) {
  exactKeys(record, [
    'schema_version',
    'kind',
    'origin_identity_sha256',
    'project_id',
    'registry_path',
    'pid',
    'nonce',
    'acquired_at',
  ], 'Build ID registry writer lock');
  if (
    record.schema_version !== 1 ||
    record.kind !== 'cruise_build_id_registry_writer_lock' ||
    record.origin_identity_sha256 !== registry.origin_identity_sha256 ||
    record.project_id !== registry.project_id ||
    record.registry_path !== 'ID-REGISTRY.yaml' ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.nonce !== 'string' ||
    !UUID.test(record.nonce) ||
    timestamp(record.acquired_at, 'Build ID registry lock acquired_at') !== record.acquired_at
  ) {
    throw new Error('Build ID registry writer lock is malformed or belongs elsewhere');
  }
  return record;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

async function acquireRegistryLock(locations, registry) {
  const directory = await directoryIdentity(locations.directory, 'Build ID registry directory');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const metadata = lockMetadata(registry);
    const bytes = Buffer.from(stringifyYaml(metadata), 'utf8');
    const temporaryPath = join(
      locations.directory,
      `.ID-REGISTRY.lock.${process.pid}.${metadata.nonce}.tmp`,
    );
    await writeNewFile(temporaryPath, bytes, 0o600);
    try {
      await assertDirectoryIdentity(locations.directory, directory, 'Build ID registry directory');
      await link(temporaryPath, locations.lock_path);
      await syncDirectory(locations.directory);
      await assertDirectoryIdentity(
        locations.directory,
        directory,
        'Build ID registry directory',
      );
      return { metadata, file_sha256: digest(bytes), directory_identity: directory };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
    const existingBytes = await readNoFollow(
      locations.lock_path,
      'Build ID registry writer lock',
    );
    const existing = validateLockMetadata(parseYaml(existingBytes.toString('utf8')), registry);
    if (processIsAlive(existing.pid)) {
      throw new Error(`Build ID registry is locked by active writer ${existing.pid}`);
    }
    const confirmed = await readNoFollow(
      locations.lock_path,
      'Build ID registry writer lock',
    );
    if (!confirmed.equals(existingBytes)) {
      throw new Error('Build ID registry writer lock changed during dead-writer recovery');
    }
    await assertDirectoryIdentity(
      locations.directory,
      directory,
      'Build ID registry directory',
    );
    const quarantine = `${locations.lock_path}.${existing.nonce}.stale`;
    await rename(locations.lock_path, quarantine);
    await rm(quarantine, { force: true });
    await rm(
      join(
        locations.directory,
        `.ID-REGISTRY.lock.${existing.pid}.${existing.nonce}.tmp`,
      ),
      { force: true },
    );
    await syncDirectory(locations.directory);
    await assertDirectoryIdentity(
      locations.directory,
      directory,
      'Build ID registry directory',
    );
  }
  throw new Error('could not acquire the Build ID registry writer lock');
}

async function releaseRegistryLock(locations, registry, lock) {
  if (lock == null) return;
  await assertDirectoryIdentity(
    locations.directory,
    lock.directory_identity,
    'Build ID registry directory',
  );
  const current = await readNoFollowIfExists(
    locations.lock_path,
    'Build ID registry writer lock',
  );
  if (current === null) {
    throw new Error('Build ID registry writer lock disappeared while held');
  }
  const metadata = validateLockMetadata(parseYaml(current.toString('utf8')), registry);
  if (metadata.nonce !== lock.metadata.nonce || digest(current) !== lock.file_sha256) {
    throw new Error('Build ID registry writer lock was replaced while held');
  }
  await rm(locations.lock_path);
  await syncDirectory(locations.directory);
  await assertDirectoryIdentity(
    locations.directory,
    lock.directory_identity,
    'Build ID registry directory',
  );
}

function pendingPayload(pending) {
  const { pending_sha256: ignored, ...payload } = pending;
  void ignored;
  return payload;
}

function createRegistryPendingIntent(previousHead, validated, nextHead) {
  const payload = {
    schema_version: 1,
    kind: 'cruise_build_id_registry_pending_commit',
    origin_identity_sha256: validated.registry.origin_identity_sha256,
    project_id: validated.registry.project_id,
    expected_previous_head_sha256: previousHead?.head_sha256 ?? null,
    new_generation: nextHead.generation,
    new_entry: validated.entry,
    new_head: nextHead,
  };
  return deepFreeze({ ...payload, pending_sha256: objectDigest(payload) });
}

function parseRegistryPendingIntent(bytes) {
  const pending = parseYaml(bytes.toString('utf8'));
  exactKeys(pending, [
    'schema_version',
    'kind',
    'origin_identity_sha256',
    'project_id',
    'expected_previous_head_sha256',
    'new_generation',
    'new_entry',
    'new_head',
    'pending_sha256',
  ], 'Build ID registry pending commit');
  if (
    pending.schema_version !== 1 ||
    pending.kind !== 'cruise_build_id_registry_pending_commit' ||
    pending.pending_sha256 !== objectDigest(pendingPayload(pending))
  ) {
    throw new Error('Build ID registry pending commit is invalid');
  }
  if (pending.expected_previous_head_sha256 !== null) {
    assertDigest(
      pending.expected_previous_head_sha256,
      'Build ID registry pending previous head',
    );
  }
  if (!REGISTRY_HISTORY_ENTRY.test(pending.new_generation)) {
    throw new Error('Build ID registry pending generation name is invalid');
  }
  return pending;
}

async function publishRegistryHistoryEntry(
  locations,
  validated,
  { faultInjector = null } = {},
) {
  const historyIdentity = await ensureRegistryHistoryDirectory(locations);
  const name = `REV-${String(validated.entry.revision).padStart(12, '0')}-${validated.entry.registry_sha256}.yaml`;
  const finalPath = join(locations.history_directory, name);
  const bytes = Buffer.from(stringifyYaml(validated.entry), 'utf8');
  const existing = await readNoFollowIfExists(finalPath, `Build ID registry history ${name}`);
  if (existing !== null) {
    if (!existing.equals(bytes)) {
      throw new Error(`Build ID registry history generation ${name} was already used by a fork`);
    }
    return;
  }
  const temporaryPath = join(
    locations.directory,
    `.${REGISTRY_HISTORY_DIRECTORY}.${name}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeNewFile(temporaryPath, bytes, 0o400);
    await invokeRegistryFault(faultInjector, 'after_history_prepare');
    await assertDirectoryIdentity(
      locations.history_directory,
      historyIdentity,
      'Build ID registry history directory',
    );
    await link(temporaryPath, finalPath);
    await syncDirectory(locations.history_directory);
    await invokeRegistryFault(faultInjector, 'after_history_append');
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`Build ID registry history revision ${validated.entry.revision} already exists`);
    }
    throw error;
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function materializeRegistryCommit(
  locations,
  validated,
  nextHead,
  { faultInjector = null } = {},
) {
  await publishRegistryHistoryEntry(locations, validated, { faultInjector });
  await publishRegistryCommitment(locations, validated.registry, nextHead, { faultInjector });
  await atomicReplaceRegistryFile({
    path: locations.absolute,
    bytes: validated.registry_bytes,
    locations,
    label: 'ID-REGISTRY.yaml',
    faultInjector,
    preparedStep: 'after_registry_prepare',
    committedStep: 'after_registry_commit',
  });
  const headBytes = Buffer.from(stringifyYaml(nextHead), 'utf8');
  await atomicReplaceRegistryFile({
    path: locations.head_path,
    bytes: headBytes,
    locations,
    label: 'Build ID registry committed head',
    faultInjector,
    preparedStep: 'after_head_prepare',
    committedStep: 'after_head_commit',
  });
}

async function removeRegistryPendingIntent(locations, expectedBytes) {
  const current = await readNoFollow(
    locations.pending_path,
    'Build ID registry pending commit',
  );
  if (!current.equals(expectedBytes)) {
    throw new Error('Build ID registry pending commit changed before finalization');
  }
  await rm(locations.pending_path);
  await syncDirectory(locations.directory);
}

async function inspectManagedRegistry(
  locations,
  registryBinding,
  { allowLegacy = true } = {},
) {
  const registryBytes = await readNoFollowIfExists(locations.absolute, 'ID-REGISTRY.yaml');
  const headFile = await readRegistryHead(locations, { allowMissing: true });
  const history = await readRegistryHistory(locations, {
    allowMissing: true,
    allowEmpty: registryBytes === null && headFile === null,
  });
  const commitments = await readRegistryCommitments(locations, registryBinding, {
    allowMissing: true,
  });
  if (history === null && headFile === null) {
    if (commitments !== null) {
      throw new Error(
        'Build ID registry history was deleted behind its durable revision commitments',
      );
    }
    if (registryBytes === null) return null;
    if (!allowLegacy) throw new Error('Build ID registry immutable history is missing');
    const registry = parseYaml(registryBytes.toString('utf8'));
    validateBuildIdRegistry(registry);
    return { legacy: true, registry, registry_bytes: registryBytes, history: null, head: null };
  }
  if (history === null) {
    throw new Error('Build ID registry committed head exists without immutable history');
  }
  assertRegistryCommitmentsMatchHistory(registryBinding, commitments, history);
  const derivedHead = history.derived_head;
  if (headFile !== null) validateRegistryHead(headFile.head, derivedHead);
  const committedHead = headFile?.head ?? derivedHead;
  const committed = history.head;
  if (
    committed.registry.revision !== committedHead.revision ||
    committed.entry.registry_sha256 !== committedHead.registry_sha256 ||
    committed.entry.registry_file_sha256 !== committedHead.registry_file_sha256 ||
    committed.entry.entry_sha256 !== committedHead.history_entry_sha256
  ) {
    throw new Error('Build ID registry immutable history differs from its committed head');
  }
  if (registryBytes !== null) {
    if (!registryBytes.equals(committed.registry_bytes)) {
      throw new Error('ID-REGISTRY.yaml differs from its immutable committed history head');
    }
  }
  return {
    legacy: false,
    registry: committed.registry,
    registry_bytes: committed.registry_bytes,
    canonical_present: registryBytes !== null,
    head_present: headFile !== null,
    history,
    head: committedHead,
    commitments,
  };
}

async function repairManagedRegistryMirrors(locations, managed) {
  if (managed.canonical_present !== true) {
    await atomicReplaceRegistryFile({
      path: locations.absolute,
      bytes: managed.registry_bytes,
      locations,
      label: 'ID-REGISTRY.yaml recovery',
    });
  }
  if (managed.head_present !== true) {
    await atomicReplaceRegistryFile({
      path: locations.head_path,
      bytes: Buffer.from(stringifyYaml(managed.head), 'utf8'),
      locations,
      label: 'Build ID registry head recovery',
    });
  }
  const recovered = await inspectManagedRegistry(locations, managed.registry, {
    allowLegacy: false,
  });
  rememberCommittedHead(locations, recovered.registry, recovered.head);
  return recovered;
}

async function recoverRegistryPendingCommit(locations, registryForLock) {
  const pendingBytes = await readNoFollowIfExists(
    locations.pending_path,
    'Build ID registry pending commit',
  );
  if (pendingBytes === null) return null;
  const pending = parseRegistryPendingIntent(pendingBytes);
  if (
    pending.origin_identity_sha256 !== registryForLock.origin_identity_sha256 ||
    pending.project_id !== registryForLock.project_id
  ) {
    throw new Error('Build ID registry pending commit belongs to another Origin or project');
  }
  let history = await readRegistryHistory(locations, { allowMissing: true, allowEmpty: true });
  const alreadyAppended = history?.derived_head?.head_sha256 === pending.new_head.head_sha256;
  const predecessorHistory = alreadyAppended
    ? history.items.length === 1
      ? null
      : {
          ...history,
          items: history.items.slice(0, -1),
          heads: history.heads.slice(0, -1),
          head: history.items.at(-2),
          derived_head: history.heads.at(-2),
        }
    : history;
  const previous = predecessorHistory?.head ?? null;
  const previousHead = predecessorHistory?.derived_head ?? null;
  if ((previousHead?.head_sha256 ?? null) !== pending.expected_previous_head_sha256) {
    throw new Error('Build ID registry pending commit lost its exact predecessor');
  }
  const validated = validateRegistryHistoryEntry(pending.new_entry, previous);
  if (
    validated.registry.origin_identity_sha256 !== pending.origin_identity_sha256 ||
    validated.registry.project_id !== pending.project_id
  ) {
    throw new Error('Build ID registry pending candidate belongs to another Origin or project');
  }
  const expectedHead = createRegistryHead(
    validated,
    previousHead,
    predecessorHistory?.anchor_revision ?? validated.registry.revision,
  );
  validateRegistryHead(pending.new_head, expectedHead);
  if (pending.new_generation !== expectedHead.generation) {
    throw new Error('Build ID registry pending generation differs from its candidate');
  }
  const currentBytes = await readNoFollowIfExists(locations.absolute, 'ID-REGISTRY.yaml');
  if (
    currentBytes !== null &&
    !currentBytes.equals(validated.registry_bytes) &&
    !currentBytes.equals(previous?.registry_bytes ?? Buffer.alloc(0))
  ) {
    throw new Error('ID-REGISTRY.yaml forked while a pending commit was durable');
  }
  const currentHead = await readRegistryHead(locations, { allowMissing: true });
  if (
    currentHead !== null &&
    currentHead.head.head_sha256 !== expectedHead.head_sha256 &&
    currentHead.head.head_sha256 !== (previousHead?.head_sha256 ?? null)
  ) {
    throw new Error('Build ID registry head forked while a pending commit was durable');
  }
  if (!alreadyAppended) {
    await publishRegistryHistoryEntry(locations, validated);
    history = await readRegistryHistory(locations);
    if (history.derived_head.head_sha256 !== expectedHead.head_sha256) {
      throw new Error('Build ID registry recovery did not append the exact pending history');
    }
  }
  await materializeRegistryCommit(locations, validated, expectedHead);
  await removeRegistryPendingIntent(locations, pendingBytes);
  return repairManagedRegistryMirrors(
    locations,
    await inspectManagedRegistry(locations, registryForLock, { allowLegacy: false }),
  );
}

async function migrateLegacyRegistry(locations, legacy) {
  const validated = validateRegistryHistoryEntry(
    createRegistryHistoryEntry(
      legacy.registry,
      legacy.registry_bytes,
      null,
      { legacyAnchor: true },
    ),
  );
  const head = createRegistryHead(validated);
  const pending = createRegistryPendingIntent(null, validated, head);
  const pendingBytes = Buffer.from(stringifyYaml(pending), 'utf8');
  if (await readNoFollowIfExists(locations.pending_path) !== null) {
    throw new Error('Build ID registry pending commit already exists during legacy migration');
  }
  await atomicReplaceRegistryFile({
    path: locations.pending_path,
    bytes: pendingBytes,
    locations,
    label: 'Build ID registry pending legacy migration',
  });
  await materializeRegistryCommit(locations, validated, head);
  await removeRegistryPendingIntent(locations, pendingBytes);
  return repairManagedRegistryMirrors(
    locations,
    await inspectManagedRegistry(locations, legacy.registry, { allowLegacy: false }),
  );
}

async function openRegistryState(locations, registryForLock, { migrateLegacy = false } = {}) {
  await recoverRegistryPendingCommit(locations, registryForLock);
  let current = await inspectManagedRegistry(locations, registryForLock);
  if (
    current !== null &&
    (current.registry.origin_identity_sha256 !== registryForLock.origin_identity_sha256 ||
      current.registry.project_id !== registryForLock.project_id)
  ) {
    throw new Error('Build ID registry persistence belongs to another Origin or project');
  }
  if (current?.legacy && migrateLegacy) current = await migrateLegacyRegistry(locations, current);
  if (current != null && !current.legacy) current = await repairManagedRegistryMirrors(locations, current);
  if (current == null && knownCommittedHead(locations, registryForLock) !== null) {
    throw new Error('ID-REGISTRY.yaml and its durable immutable history were deleted behind the live committed head');
  }
  if (current?.legacy && knownCommittedHead(locations, current.registry) !== null) {
    throw new Error('Build ID registry immutable history was deleted behind the live committed head');
  }
  return current;
}

/** Read, recover, and validate a persistent registry with optional exact-snapshot checking. */
export async function readBuildIdRegistry(
  path,
  {
    initialBuildOriginAttestation = null,
    originRecord = null,
    expectedSnapshot = null,
  } = {},
) {
  const locations = await registryLocations(path, {
    initialBuildOriginAttestation,
    originRecord,
  });
  const raw = await readNoFollowIfExists(locations.absolute, 'ID-REGISTRY.yaml');
  let registryForLock;
  if (raw !== null) {
    registryForLock = parseYaml(raw.toString('utf8'));
    validateBuildIdRegistry(registryForLock, { initialBuildOriginAttestation, originRecord });
  } else {
    if (initialBuildOriginAttestation === null || originRecord === null) {
      throw new Error('ID-REGISTRY.yaml is missing and cannot be recovered without Origin authority');
    }
    const binding = assertOriginBinding(initialBuildOriginAttestation, originRecord);
    registryForLock = {
      origin_identity_sha256: binding.originIdentitySha256,
      project_id: binding.projectId,
    };
  }
  let lock;
  try {
    lock = await acquireRegistryLock(locations, registryForLock);
    const current = await openRegistryState(locations, registryForLock);
    if (current == null) throw new Error('Build ID registry disappeared while being read');
    validateBuildIdRegistry(current.registry, { initialBuildOriginAttestation, originRecord });
    if (expectedSnapshot !== null) {
      validateBuildIdRegistrySnapshot(expectedSnapshot, current.registry);
    }
    return deepFreeze(current.registry);
  } finally {
    await releaseRegistryLock(locations, registryForLock, lock);
  }
}

/**
 * Persist one exact registry revision through an immutable history generation,
 * independent revision commitment, durable pending intent, atomic canonical
 * mirror, and atomic committed head.
 */
export async function writeBuildIdRegistry(
  path,
  registry,
  {
    initialBuildOriginAttestation = null,
    originRecord = null,
    expectedSnapshot = null,
    persistenceFaultInjector = null,
  } = {},
) {
  if (initialBuildOriginAttestation === null || originRecord === null) {
    throw new Error('Build ID registry persistence requires immutable Origin authority');
  }
  if (persistenceFaultInjector !== null && typeof persistenceFaultInjector !== 'function') {
    throw new TypeError('persistenceFaultInjector must be a function when supplied');
  }
  validateBuildIdRegistry(registry, { initialBuildOriginAttestation, originRecord });
  const locations = await registryLocations(path, {
    initialBuildOriginAttestation,
    originRecord,
    create: true,
  });
  let lock;
  try {
    lock = await acquireRegistryLock(locations, registry);
    let current = await openRegistryState(locations, registry, { migrateLegacy: true });
    if (current === null) {
      if (expectedSnapshot !== null) {
        throw new Error('registry does not exist for the expected prior snapshot');
      }
    } else if (canonicalJson(current.registry) === canonicalJson(registry)) {
      if (expectedSnapshot !== null) {
        try {
          validateBuildIdRegistrySnapshot(expectedSnapshot, current.registry);
        } catch (currentSnapshotError) {
          const predecessor = current.history?.items.at(-2)?.registry ?? null;
          if (predecessor === null) throw currentSnapshotError;
          try {
            validateBuildIdRegistrySnapshot(expectedSnapshot, predecessor);
          } catch {
            throw currentSnapshotError;
          }
        }
      }
      if (!current.legacy) rememberCommittedHead(locations, current.registry, current.head);
      return createBuildIdRegistrySnapshot(registry);
    } else {
      if (expectedSnapshot === null) {
        throw new Error('updating a persisted registry requires its exact prior snapshot');
      }
      validateBuildIdRegistrySnapshot(expectedSnapshot, current.registry);
      assertBuildIdRegistrySuccessor(current.registry, registry);
    }

    const registryBytes = Buffer.from(stringifyYaml(registry), 'utf8');
    const previous = current?.history?.head ?? null;
    const previousHead = current?.head ?? null;
    const entry = createRegistryHistoryEntry(
      registry,
      registryBytes,
      previous?.entry ?? null,
      { legacyAnchor: previous === null && registry.revision !== 0 },
    );
    const validated = validateRegistryHistoryEntry(entry, previous);
    const nextHead = createRegistryHead(
      validated,
      previousHead,
      current?.history?.anchor_revision ?? registry.revision,
    );
    const pending = createRegistryPendingIntent(previousHead, validated, nextHead);
    const pendingBytes = Buffer.from(stringifyYaml(pending), 'utf8');
    if (await readNoFollowIfExists(locations.pending_path) !== null) {
      throw new Error('Build ID registry pending commit appeared after recovery');
    }
    await atomicReplaceRegistryFile({
      path: locations.pending_path,
      bytes: pendingBytes,
      locations,
      label: 'Build ID registry pending commit',
      faultInjector: persistenceFaultInjector,
      preparedStep: 'after_pending_prepare',
      committedStep: 'after_pending_commit',
    });
    await materializeRegistryCommit(locations, validated, nextHead, {
      faultInjector: persistenceFaultInjector,
    });
    await removeRegistryPendingIntent(locations, pendingBytes);
    current = await inspectManagedRegistry(locations, registry, { allowLegacy: false });
    if (
      canonicalJson(current.registry) !== canonicalJson(registry) ||
      current.head.head_sha256 !== nextHead.head_sha256
    ) {
      throw new Error('Build ID registry commit did not preserve the exact candidate/head');
    }
    rememberCommittedHead(locations, current.registry, current.head);
    return createBuildIdRegistrySnapshot(registry);
  } finally {
    await releaseRegistryLock(locations, registry, lock);
  }
}
