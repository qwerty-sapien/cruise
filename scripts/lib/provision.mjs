import { createHash } from 'node:crypto';
import { constants as fsConstants, realpathSync } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  assessProvisionInstallCommand,
  capabilityRequestAuthorityDigest,
  capabilityRequestRepositoryRoot,
  createRejectedCapabilityRecord,
  isCapabilityFallbackApproval,
  isDirectUseEvaluationForCandidate,
  isOpaqueCapabilityRequest,
  isProvisionEffectAuthorization,
  isTrustedInstallerAttestationForCommand,
  isValidatedLocalSpinForRequest,
  revalidateProvisionAuthenticationAttestation,
  revalidateLocalSpinForActivation,
  runProvisionAuthenticationVerification,
  runProvisionInstallExecution,
  runProvisionRollback,
  runProvisionSmokeVerification,
  validateAuthJob,
} from './provision-policy.mjs';

export * from './provision-policy.mjs';

export const PROVISION_SCHEMA_VERSION = 1;

export const CAPABILITY_STATUSES = Object.freeze([
  'pending',
  'ready',
  'running',
  'waiting_auth',
  'blocked',
  'succeeded',
  'failed',
  'skipped',
  'excluded',
  'quarantined',
]);

export const RESOLUTION_ORDER = Object.freeze([
  'host_native',
  'installed_plugin_or_skill',
  'installed_local',
  'official_codex_plugin',
  'trusted_catalog',
  'official_upstream_pinned',
  'learning_only_adaptation',
  'builtin_fallback',
  'approval_or_block',
]);

export const INSTALL_SCOPES = Object.freeze([
  'local',
  'repository',
  'repository-local',
  'virtualenv',
]);

const NODE_KINDS = new Set([
  'plugin',
  'skill',
  'mcp_server',
  'cli',
  'library',
  'parser',
  'connector',
  'analysis',
  'host_tool',
  'builtin',
  'other',
]);
const NODE_STATUS_SET = new Set(CAPABILITY_STATUSES);
const NECESSITY_SET = new Set(['optional', 'preferred', 'mandatory']);
const SATISFIED_STATUSES = new Set(['succeeded']);
const DEPENDENCY_FAILURE_STATUSES = new Set(['failed', 'blocked', 'skipped', 'excluded', 'quarantined']);
const TERMINAL_NODE_STATUSES = new Set([
  'blocked',
  'succeeded',
  'failed',
  'skipped',
  'excluded',
  'quarantined',
]);
const CANDIDATE_ACTIONS = new Set([
  'use',
  'install',
  'fallback',
  'skip',
  'approval_required',
  'block',
]);
const SAFE_ID = /^CAP-[A-Z0-9][A-Z0-9-]*$/;
const SAFE_RUN_ID = /^(?=.{1,15}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const SENSITIVE_KEY =
  /(?:^|[_-])(?:api[_-]?key|authorization|cookie|credential|password|passphrase|private[_-]?key|secret|session|token)(?:$|[_-])/i;
const SENSITIVE_CANONICAL_KEY =
  /(?:apikey|authorization|cookie|credential|password|passphrase|privatekey|secret|session|accesstoken|refreshtoken|clientsecret|token)/i;
const REDACTED = '[REDACTED]';
const PROVISION_RUN_REQUESTS = new WeakMap();
const PROVISION_RUN_CONTRACTS = new WeakMap();
const PROVISION_REQUEST_CONTRACT_AUTHORITIES = new WeakMap();
const PROVISION_STATE_STORE_BINDINGS = new WeakMap();
const EXCLUSION_STATE_MAX_BYTES = 256 * 1024;
const REJECTED_STATE_MAX_BYTES = 1024 * 1024;
const EXCLUSION_STATE_MAX_ENTRIES = 4096;
const REJECTED_STATE_MAX_ENTRIES = 4096;
const PROVISION_RUN_STATE_MAX_BYTES = 4 * 1024 * 1024;
const CAPABILITY_REGISTRY_MAX_BYTES = 4 * 1024 * 1024;
const PROVISION_RUN_MAX_NODES = 1024;
const CAPABILITY_REGISTRY_MAX_ENTRIES = 4096;

export class ProvisionValidationError extends Error {
  constructor(message, { code = 'CRUISE_PROVISION_INVALID', detail = null } = {}) {
    super(message);
    this.name = 'ProvisionValidationError';
    this.code = code;
    this.detail = detail;
  }
}

export class ProvisionCycleError extends ProvisionValidationError {
  constructor(cycle) {
    super(`Capability dependency cycle detected: ${cycle.join(' -> ')}.`, {
      code: 'CRUISE_PROVISION_CYCLE',
      detail: { cycle },
    });
    this.name = 'ProvisionCycleError';
    this.cycle = cycle;
  }
}

function timestamp(now) {
  const value = typeof now === 'function' ? now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ProvisionValidationError('Provision clock returned an invalid date.');
  }
  return date.toISOString();
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableDigest(value) {
  const normalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (!isPlainObject(entry)) return entry;
    return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, normalize(entry[key])]));
  };
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

function redactString(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{8,}\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(
      /\b(api[_-]?key|authorization|password|passphrase|secret|token)\s*([=:])\s*([^\s,;]+)/gi,
      (_match, key, separator) => `${key}${separator}${REDACTED}`,
    );
}

/**
 * Convert arbitrary adapter output into a secret-free, YAML-compatible value.
 * Functions and undefined values are omitted from objects and become null in arrays.
 */
export function sanitizeProvisionRecord(value, { key = '', seen = new WeakSet() } = {}) {
  const canonicalKey = String(key).replace(/[^A-Za-z0-9]+/gu, '').toLowerCase();
  if (SENSITIVE_KEY.test(key) || SENSITIVE_CANONICAL_KEY.test(canonicalKey)) return REDACTED;
  if (value === null) return null;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return null;
  }
  if (typeof value !== 'object') return redactString(value);
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((entry) => sanitizeProvisionRecord(entry, { seen }));
    seen.delete(value);
    return result;
  }
  const result = {};
  for (const currentKey of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
    const currentValue = value[currentKey];
    if (
      typeof currentValue === 'undefined' ||
      typeof currentValue === 'function' ||
      typeof currentValue === 'symbol'
    ) {
      continue;
    }
    result[currentKey] = sanitizeProvisionRecord(currentValue, {
      key: currentKey,
      seen,
    });
  }
  seen.delete(value);
  return result;
}

function assertYamlCompatible(value, path = '$', seen = new WeakSet()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ProvisionValidationError(`${path} must be a finite number.`);
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new ProvisionValidationError(`${path} is not YAML-compatible.`);
  }
  if (seen.has(value)) {
    throw new ProvisionValidationError(`${path} contains a cycle.`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertYamlCompatible(entry, `${path}[${index}]`, seen));
  } else {
    if (!isPlainObject(value)) {
      throw new ProvisionValidationError(`${path} must be a plain object.`);
    }
    for (const [currentKey, currentValue] of Object.entries(value)) {
      assertYamlCompatible(currentValue, `${path}.${currentKey}`, seen);
    }
  }
  seen.delete(value);
}

function scalarYaml(value) {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value) && value.length === 0) return '[]';
  if (isPlainObject(value) && Object.keys(value).length === 0) return '{}';
  return null;
}

function emitYaml(value, indent = 0) {
  const prefix = ' '.repeat(indent);
  const scalar = scalarYaml(value);
  if (scalar !== null) return [`${prefix}${scalar}`];
  if (Array.isArray(value)) {
    const lines = [];
    for (const entry of value) {
      const entryScalar = scalarYaml(entry);
      if (entryScalar !== null) {
        lines.push(`${prefix}- ${entryScalar}`);
      } else {
        lines.push(`${prefix}-`);
        lines.push(...emitYaml(entry, indent + 2));
      }
    }
    return lines;
  }
  const lines = [];
  for (const currentKey of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
    const encodedKey = JSON.stringify(currentKey);
    const currentValue = value[currentKey];
    const currentScalar = scalarYaml(currentValue);
    if (currentScalar !== null) {
      lines.push(`${prefix}${encodedKey}: ${currentScalar}`);
    } else {
      lines.push(`${prefix}${encodedKey}:`);
      lines.push(...emitYaml(currentValue, indent + 2));
    }
  }
  return lines;
}

/** Serialize the strict YAML subset Cruise owns. */
export function stringifyProvisionYaml(value) {
  assertYamlCompatible(value);
  return `${emitYaml(value).join('\n')}\n`;
}

function countIndent(line) {
  const match = line.match(/^ */);
  return match ? match[0].length : 0;
}

function findMappingColon(content) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"' || character === "'") {
      if (quote === character) quote = null;
      else if (!quote) quote = character;
      continue;
    }
    if (!quote && character === ':') return index;
  }
  return -1;
}

function parseYamlScalar(source, lineNumber) {
  const value = source.trim();
  if (value === 'null' || value === '~') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === '[]') return [];
  if (value === '{}') return {};
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch (error) {
      throw new ProvisionValidationError(
        `Invalid quoted YAML scalar on line ${lineNumber}: ${error.message}`,
      );
    }
  }
  throw new ProvisionValidationError(
    `Unsupported YAML scalar on line ${lineNumber}; Cruise accepts only its strict emitted subset.`,
  );
}

/** Parse only the safe YAML subset emitted by stringifyProvisionYaml. */
export function parseProvisionYaml(source) {
  if (typeof source !== 'string') {
    throw new TypeError('YAML source must be a string.');
  }
  const rows = source
    .split(/\r?\n/)
    .map((raw, index) => ({ raw, lineNumber: index + 1 }))
    .filter(({ raw }) => raw.trim() !== '');
  for (const { raw, lineNumber } of rows) {
    if (raw.includes('\t')) {
      throw new ProvisionValidationError(`Tabs are not allowed in Cruise YAML (line ${lineNumber}).`);
    }
  }
  if (rows.length === 0) {
    throw new ProvisionValidationError('Cruise YAML document is empty.');
  }

  function parseBlock(startIndex, indent) {
    const first = rows[startIndex];
    if (!first || countIndent(first.raw) !== indent) {
      throw new ProvisionValidationError(
        `Invalid YAML indentation on line ${first?.lineNumber ?? 'EOF'}.`,
      );
    }
    const firstContent = first.raw.slice(indent);
    const sequence = firstContent === '-' || firstContent.startsWith('- ');
    const result = sequence ? [] : {};
    let index = startIndex;

    while (index < rows.length) {
      const row = rows[index];
      const currentIndent = countIndent(row.raw);
      if (currentIndent < indent) break;
      if (currentIndent > indent) {
        throw new ProvisionValidationError(`Unexpected indentation on line ${row.lineNumber}.`);
      }
      const content = row.raw.slice(indent);
      if (sequence) {
        if (!(content === '-' || content.startsWith('- '))) {
          throw new ProvisionValidationError(`Mixed YAML sequence and mapping on line ${row.lineNumber}.`);
        }
        const rest = content.slice(1).trimStart();
        if (rest) {
          result.push(parseYamlScalar(rest, row.lineNumber));
          index += 1;
          continue;
        }
        const next = rows[index + 1];
        if (!next || countIndent(next.raw) !== indent + 2) {
          throw new ProvisionValidationError(`Sequence item on line ${row.lineNumber} has no value.`);
        }
        const parsed = parseBlock(index + 1, indent + 2);
        result.push(parsed.value);
        index = parsed.nextIndex;
        continue;
      }

      if (content === '-' || content.startsWith('- ')) {
        throw new ProvisionValidationError(`Mixed YAML mapping and sequence on line ${row.lineNumber}.`);
      }
      const colon = findMappingColon(content);
      if (colon < 1) {
        throw new ProvisionValidationError(`Invalid YAML mapping on line ${row.lineNumber}.`);
      }
      let currentKey;
      try {
        currentKey = JSON.parse(content.slice(0, colon));
      } catch {
        throw new ProvisionValidationError(`Cruise YAML keys must be quoted (line ${row.lineNumber}).`);
      }
      if (typeof currentKey !== 'string' || Object.hasOwn(result, currentKey)) {
        throw new ProvisionValidationError(`Invalid or duplicate YAML key on line ${row.lineNumber}.`);
      }
      const rest = content.slice(colon + 1).trimStart();
      if (rest) {
        result[currentKey] = parseYamlScalar(rest, row.lineNumber);
        index += 1;
        continue;
      }
      const next = rows[index + 1];
      if (!next || countIndent(next.raw) !== indent + 2) {
        throw new ProvisionValidationError(`Mapping value on line ${row.lineNumber} is missing.`);
      }
      const parsed = parseBlock(index + 1, indent + 2);
      result[currentKey] = parsed.value;
      index = parsed.nextIndex;
    }
    return { value: result, nextIndex: index };
  }

  const parsed = parseBlock(0, 0);
  if (parsed.nextIndex !== rows.length) {
    throw new ProvisionValidationError(
      `Unexpected trailing YAML content on line ${rows[parsed.nextIndex].lineNumber}.`,
    );
  }
  assertYamlCompatible(parsed.value);
  return parsed.value;
}

function normalizeNode(input, now) {
  if (!isPlainObject(input)) {
    throw new ProvisionValidationError('Every capability node must be a plain object.');
  }
  const id = String(input.id ?? '').trim();
  const capability = String(input.capability ?? '').trim();
  const kind = String(input.kind ?? 'other').trim();
  if (!SAFE_ID.test(id)) {
    throw new ProvisionValidationError(
      `Capability node id ${JSON.stringify(id)} must match ${SAFE_ID}.`,
    );
  }
  if (!capability) {
    throw new ProvisionValidationError(`${id} must name a capability.`);
  }
  if (!NODE_KINDS.has(kind)) {
    throw new ProvisionValidationError(`${id} has unsupported capability kind ${kind}.`);
  }
  const status = input.status ?? 'pending';
  if (!NODE_STATUS_SET.has(status)) {
    throw new ProvisionValidationError(`${id} has unsupported status ${status}.`);
  }
  const requires = uniqueSorted((input.requires ?? []).map((value) => String(value).trim()));
  const necessity = input.necessity ?? (input.required_for_completion === false ? 'optional' : 'mandatory');
  if (!NECESSITY_SET.has(necessity)) {
    throw new ProvisionValidationError(`${id} has unsupported necessity ${necessity}.`);
  }
  if (necessity === 'mandatory' && input.required_for_completion === false) {
    throw new ProvisionValidationError(`${id} mandatory necessity must be required for completion.`);
  }
  const createdAt = input.created_at ?? timestamp(now);
  return {
    id,
    capability,
    kind,
    status,
    requires,
    dependents: [],
    required_for_completion: input.required_for_completion !== false,
    necessity,
    approved_fallback: input.approved_fallback ?? null,
    requested_execution: {
      source: sanitizeProvisionRecord(input.source ?? null),
      version: sanitizeProvisionRecord(input.version ?? null),
      install_scope: input.install_scope ?? 'local',
      auth_required: input.auth_required ?? 'unknown',
    },
    source: input.source ?? null,
    version: input.version ?? null,
    install_scope: input.install_scope ?? 'local',
    auth_required: input.auth_required ?? 'unknown',
    blocking_reason: input.blocking_reason ?? null,
    resolution: input.resolution ?? null,
    trust: input.trust ?? null,
    attempts: Array.isArray(input.attempts) ? sanitizeProvisionRecord(input.attempts) : [],
    smoke_test: input.smoke_test ?? null,
    provenance: input.provenance ?? null,
    auth: input.auth ?? null,
    outcome: input.outcome ?? null,
    created_at: createdAt,
    updated_at: input.updated_at ?? createdAt,
  };
}

function provisionRunContract(run, capabilityRequest) {
  return {
    schema_version: PROVISION_SCHEMA_VERSION,
    kind: 'cruise_provision_run_contract',
    run_id: run.run_id,
    request_id: run.request_id,
    request_authority_sha256: run.request_authority_sha256,
    request_constraints: sanitizeProvisionRecord(capabilityRequest.request.constraints),
    resolution_order: [...run.resolution_order],
    metadata: sanitizeProvisionRecord(run.metadata),
    nodes: run.nodes.map((node) => ({
      id: node.id,
      capability: node.capability,
      kind: node.kind,
      requires: [...node.requires],
      required_for_completion: node.required_for_completion,
      necessity: node.necessity,
      approved_fallback: sanitizeProvisionRecord(node.approved_fallback),
      requested_execution: sanitizeProvisionRecord(node.requested_execution),
    })),
  };
}

function provisionRunContractDigest(contract) {
  return createHash('sha256').update(stringifyProvisionYaml(contract)).digest('hex');
}

function bindProvisionRequestContractAuthority(request, runId, digest) {
  if (!isOpaqueCapabilityRequest(request) || !SAFE_RUN_ID.test(String(runId ?? '')) ||
      !SHA256.test(String(digest ?? ''))) {
    provisionContractDrift('live CAPREQ contract authority is invalid');
  }
  let byRun = PROVISION_REQUEST_CONTRACT_AUTHORITIES.get(request);
  if (!byRun) {
    byRun = new Map();
    PROVISION_REQUEST_CONTRACT_AUTHORITIES.set(request, byRun);
  }
  const existing = byRun.get(runId);
  if (existing && existing !== digest) {
    provisionContractDrift(`live CAPREQ authority for ${runId} was already bound to different bytes`);
  }
  byRun.set(runId, digest);
}

function assertLiveProvisionRequestContractAuthority(request, runId, digest) {
  const expected = isOpaqueCapabilityRequest(request)
    ? PROVISION_REQUEST_CONTRACT_AUTHORITIES.get(request)?.get(runId)
    : null;
  if (!expected) {
    provisionContractDrift(
      'live approved DAG authority is unavailable; reconstruct the expected run from approved inputs before resume',
    );
  }
  if (expected !== digest) {
    provisionContractDrift('persisted DAG differs from the live CAPREQ-bound authority');
  }
  return expected;
}

function provisionContractDrift(message) {
  throw new ProvisionValidationError(`Provision run contract drift: ${message}.`, {
    code: 'CRUISE_PROVISION_CONTRACT_DRIFT',
  });
}

function validateProvisionRunContract(contract) {
  if (!isPlainObject(contract) || contract.schema_version !== PROVISION_SCHEMA_VERSION ||
      contract.kind !== 'cruise_provision_run_contract' ||
      !SAFE_RUN_ID.test(String(contract.run_id ?? '')) ||
      !/^CAPREQ-[0-9]{3,}$/u.test(String(contract.request_id ?? '')) ||
      !SHA256.test(String(contract.request_authority_sha256 ?? '')) ||
      !Array.isArray(contract.resolution_order) ||
      JSON.stringify(contract.resolution_order) !== JSON.stringify(RESOLUTION_ORDER) ||
      !Array.isArray(contract.nodes) || contract.nodes.length === 0 ||
      contract.nodes.length > PROVISION_RUN_MAX_NODES ||
      !isPlainObject(contract.request_constraints) || !isPlainObject(contract.metadata)) {
    provisionContractDrift('immutable authority artifact is malformed');
  }
  const ids = new Set();
  for (const node of contract.nodes) {
    if (!isPlainObject(node) || !SAFE_ID.test(String(node.id ?? '')) || ids.has(node.id) ||
        !nonEmptyText(node.capability) || !NODE_KINDS.has(node.kind) ||
        !Array.isArray(node.requires) || node.requires.length > PROVISION_RUN_MAX_NODES ||
        typeof node.required_for_completion !== 'boolean' || !NECESSITY_SET.has(node.necessity) ||
        !isPlainObject(node.requested_execution) ||
        !INSTALL_SCOPES.includes(node.requested_execution.install_scope) ||
        !['unknown', true, false].includes(node.requested_execution.auth_required) ||
        (node.requested_execution.source !== null && !nonEmptyText(node.requested_execution.source)) ||
        (node.requested_execution.version !== null && !nonEmptyText(node.requested_execution.version))) {
      provisionContractDrift('immutable node authority is malformed');
    }
    ids.add(node.id);
  }
  for (const node of contract.nodes) {
    if (node.requires.some((id) => !ids.has(id))) {
      provisionContractDrift(`${node.id} has an unknown immutable dependency`);
    }
  }
  assertYamlCompatible(contract);
  return contract;
}

function immutableNodeAuthority(node) {
  return {
    id: node.id,
    capability: node.capability,
    kind: node.kind,
    requires: [...node.requires],
    required_for_completion: node.required_for_completion,
    necessity: node.necessity,
    approved_fallback: sanitizeProvisionRecord(node.approved_fallback),
    requested_execution: sanitizeProvisionRecord(node.requested_execution),
  };
}

function assertRunMatchesProvisionContract(run, binding = PROVISION_RUN_CONTRACTS.get(run)) {
  if (!binding || !isPlainObject(binding.contract) || !SHA256.test(String(binding.digest ?? ''))) {
    provisionContractDrift('opaque immutable authority binding is missing');
  }
  const { contract, digest } = binding;
  validateProvisionRunContract(contract);
  if (provisionRunContractDigest(contract) !== digest || run.contract_sha256 !== digest) {
    provisionContractDrift('authority digest does not match the immutable artifact');
  }
  if (run.run_id !== contract.run_id || run.request_id !== contract.request_id ||
      run.request_authority_sha256 !== contract.request_authority_sha256 ||
      JSON.stringify(run.resolution_order) !== JSON.stringify(contract.resolution_order) ||
      stableDigest(sanitizeProvisionRecord(run.metadata)) !== stableDigest(contract.metadata)) {
    provisionContractDrift('run-level authority changed');
  }
  const current = [...run.nodes]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(immutableNodeAuthority);
  const expected = [...contract.nodes]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((node) => sanitizeProvisionRecord(node));
  if (stableDigest(current) !== stableDigest(expected)) {
    provisionContractDrift('node membership, dependency, requirement, fallback, or capability authority changed');
  }
  return binding;
}

function findCycle(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function visit(id) {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    if (visited.has(id)) return null;
    visiting.add(id);
    stack.push(id);
    for (const requirement of byId.get(id).requires) {
      const cycle = visit(requirement);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  }

  for (const id of [...byId.keys()].sort((a, b) => a.localeCompare(b))) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

function deriveDependents(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) node.dependents = [];
  for (const node of nodes) {
    for (const requirement of node.requires) {
      const requiredNode = byId.get(requirement);
      if (!requiredNode) {
        throw new ProvisionValidationError(`${node.id} requires unknown capability node ${requirement}.`);
      }
      if (requirement === node.id) throw new ProvisionCycleError([node.id, node.id]);
      requiredNode.dependents.push(node.id);
    }
  }
  for (const node of nodes) node.dependents = uniqueSorted(node.dependents);
}

export function createProvisionRun({
  runId,
  requestId,
  capabilityRequest,
  nodes,
  createdAt = null,
  metadata = {},
  now = () => new Date(),
} = {}) {
  if (!SAFE_RUN_ID.test(String(runId ?? ''))) {
    throw new ProvisionValidationError('runId must be a safe, non-empty file identifier.');
  }
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > PROVISION_RUN_MAX_NODES) {
    throw new ProvisionValidationError('A provision run requires at least one capability node.');
  }
  if (!/^CAPREQ-[0-9]{3,}$/u.test(String(requestId ?? ''))) {
    throw new ProvisionValidationError('A provision run requires its CAPREQ-* request id.');
  }
  if (!isOpaqueCapabilityRequest(capabilityRequest) || capabilityRequest.request.id !== String(requestId)) {
    throw new ProvisionValidationError('A provision run requires the exact opaque CAPREQ authority matching requestId.');
  }
  const normalized = nodes.map((node) => normalizeNode(node, now));
  normalized.sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set();
  for (const node of normalized) {
    if (ids.has(node.id)) {
      throw new ProvisionValidationError(`Duplicate capability node id ${node.id}.`);
    }
    ids.add(node.id);
  }
  deriveDependents(normalized);
  const cycle = findCycle(normalized);
  if (cycle) throw new ProvisionCycleError(cycle);
  const startedAt = createdAt ?? timestamp(now);
  const run = {
    schema_version: PROVISION_SCHEMA_VERSION,
    kind: 'cruise_provision_run',
    run_id: String(runId),
    request_id: String(requestId),
    request_authority_sha256: capabilityRequestAuthorityDigest(capabilityRequest),
    contract_sha256: null,
    status: 'pending',
    outcome: null,
    resolution_order: [...RESOLUTION_ORDER],
    metadata: sanitizeProvisionRecord(metadata),
    nodes: normalized,
    created_at: startedAt,
    updated_at: startedAt,
  };
  const contract = provisionRunContract(run, capabilityRequest);
  const contractBinding = {
    contract,
    digest: provisionRunContractDigest(contract),
  };
  run.contract_sha256 = contractBinding.digest;
  PROVISION_RUN_CONTRACTS.set(run, contractBinding);
  bindProvisionRequestContractAuthority(capabilityRequest, run.run_id, contractBinding.digest);
  validateProvisionRun(run);
  PROVISION_RUN_REQUESTS.set(run, capabilityRequest);
  return run;
}

export function validateProvisionRun(run) {
  if (!isPlainObject(run)) throw new ProvisionValidationError('Provision run must be an object.');
  if (run.schema_version !== PROVISION_SCHEMA_VERSION) {
    throw new ProvisionValidationError(
      `Unsupported provision schema version ${run.schema_version}.`,
    );
  }
  if (run.kind !== 'cruise_provision_run' || !SAFE_RUN_ID.test(String(run.run_id ?? '')) ||
      !/^CAPREQ-[0-9]{3,}$/u.test(String(run.request_id ?? '')) ||
      !SHA256.test(String(run.request_authority_sha256 ?? '')) ||
      !SHA256.test(String(run.contract_sha256 ?? ''))) {
    throw new ProvisionValidationError('Provision run kind or run_id is invalid.');
  }
  if (!Array.isArray(run.nodes) || run.nodes.length === 0 || run.nodes.length > PROVISION_RUN_MAX_NODES) {
    throw new ProvisionValidationError('Provision run nodes are missing.');
  }
  const ids = new Set();
  for (const node of run.nodes) {
    if (!SAFE_ID.test(String(node.id ?? '')) || ids.has(node.id)) {
      throw new ProvisionValidationError(`Invalid or duplicate capability id ${node.id}.`);
    }
    ids.add(node.id);
    if (!NODE_STATUS_SET.has(node.status)) {
      throw new ProvisionValidationError(`${node.id} has invalid status ${node.status}.`);
    }
    if (node.required_for_completion !== false && node.status === 'skipped') {
      throw new ProvisionValidationError(`${node.id} is required for completion and cannot be skipped.`);
    }
    if (!NECESSITY_SET.has(node.necessity)) {
      throw new ProvisionValidationError(`${node.id} has invalid necessity ${node.necessity}.`);
    }
    if (node.necessity === 'optional' && node.required_for_completion !== false) {
      throw new ProvisionValidationError(`${node.id} optional necessity cannot be required for completion.`);
    }
    if (node.necessity === 'mandatory' && node.required_for_completion === false) {
      throw new ProvisionValidationError(`${node.id} mandatory necessity must be required for completion.`);
    }
    if (!isPlainObject(node.requested_execution) ||
        !INSTALL_SCOPES.includes(node.requested_execution.install_scope) ||
        !['unknown', true, false].includes(node.requested_execution.auth_required) ||
        (node.requested_execution.source !== null && !nonEmptyText(node.requested_execution.source)) ||
        (node.requested_execution.version !== null && !nonEmptyText(node.requested_execution.version))) {
      throw new ProvisionValidationError(`${node.id} immutable requested execution authority is invalid.`);
    }
    if (node.status === 'succeeded' &&
        (!isPlainObject(node.smoke_test) || node.smoke_test.ok !== true ||
          !isPlainObject(node.provenance) || !nonEmptyText(node.provenance.identity))) {
      throw new ProvisionValidationError(`${node.id} succeeded status lacks smoke and provenance evidence.`);
    }
    if (!Array.isArray(node.requires) || !Array.isArray(node.dependents) ||
        node.requires.length > PROVISION_RUN_MAX_NODES || node.dependents.length > PROVISION_RUN_MAX_NODES) {
      throw new ProvisionValidationError(`${node.id} has invalid dependency fields.`);
    }
    if (!Array.isArray(node.attempts)) {
      throw new ProvisionValidationError(`${node.id} attempts must be an array.`);
    }
  }
  for (const node of run.nodes) {
    for (const requirement of node.requires) {
      if (!ids.has(requirement)) {
        throw new ProvisionValidationError(`${node.id} requires unknown node ${requirement}.`);
      }
    }
  }
  const copy = run.nodes.map((node) => ({ ...node, requires: [...node.requires] }));
  deriveDependents(copy);
  for (const node of run.nodes) {
    const expected = copy.find((entry) => entry.id === node.id).dependents;
    if (JSON.stringify(uniqueSorted(node.dependents)) !== JSON.stringify(expected)) {
      throw new ProvisionValidationError(`${node.id} dependents do not match requires edges.`);
    }
  }
  const cycle = findCycle(run.nodes);
  if (cycle) throw new ProvisionCycleError(cycle);
  if (PROVISION_RUN_CONTRACTS.has(run)) assertRunMatchesProvisionContract(run);
  assertYamlCompatible(sanitizeProvisionRecord(run));
  return run;
}

function commandAssessment(command, strategy, hostNativeInstall, installerAttestation, identity) {
  if (command == null) {
    return {
      passed: strategy === 'official_codex_plugin' && hostNativeInstall === true,
      reason:
        strategy === 'official_codex_plugin' && hostNativeInstall === true
          ? 'host-native plugin installation'
          : 'no inspectable structured install command',
    };
  }
  const reviewed = assessProvisionInstallCommand(command, {
    installerAttestation,
    identity,
  });
  return {
    passed: reviewed.passed,
    reason: reviewed.reason,
  };
}

function isPinned(value) {
  const text = String(value ?? '').trim();
  if (!text || /^(?:head|latest|main|master|next|stable|tip)$/i.test(text)) return false;
  return /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(text) || /^[a-f0-9]{12,64}$/i.test(text);
}

function catalogTrust(candidate, policy) {
  if (candidate.official === true || candidate.trusted === true) return true;
  if ((policy.trustedSources ?? []).includes(candidate.source)) return true;
  return (policy.trustedCatalog ?? []).some((entry) => {
    if (!isPlainObject(entry)) return false;
    if (!entry.capability && !entry.source && !entry.identity) return false;
    if (entry.capability && entry.capability !== candidate.capability) return false;
    if (entry.source && entry.source !== candidate.source) return false;
    if (entry.identity && entry.identity !== candidate.identity) return false;
    if (Array.isArray(entry.versions) && !entry.versions.includes(candidate.version)) return false;
    return true;
  });
}

/** Evaluate whether an install candidate can run without an additional approval. */
export function assessProvisionTrust(candidate, policy = {}) {
  if (!isPlainObject(candidate)) {
    throw new ProvisionValidationError('Provision candidate must be an object.');
  }
  const action = candidate.action;
  const externalSelectionRequired = candidate.external_candidate === true ||
    ['trusted_catalog', 'official_upstream_pinned'].includes(candidate.strategy);
  if (action !== 'install') {
    const adaptationRequired = candidate.strategy === 'learning_only_adaptation';
    const adaptationPassed = !adaptationRequired || isValidatedLocalSpinForRequest(
      candidate.local_spin,
      candidate.capability_request,
    );
    const selectionPassed = !externalSelectionRequired ||
      isDirectUseEvaluationForCandidate(candidate.selection_evaluation, candidate);
    const effectPassed = !externalSelectionRequired || isProvisionEffectAuthorization(
      candidate.effect_authorization,
      { request: candidate.capability_request, effectKind: 'install', candidate },
    );
    return {
      decision: !selectionPassed || !effectPassed || !adaptationPassed
        ? 'rejected'
        : candidate.auth_required === true
          ? 'waiting_auth'
          : 'not_required',
      checks: [
        ...(externalSelectionRequired ? [
        {
          id: 'selection_gate',
          passed: selectionPassed,
          reason: 'external use requires an opaque result from the complete private selection gate',
        },
        {
          id: 'effect_authorization',
          passed: effectPassed,
          reason: 'external use requires request- and Origin-bound install/activation authorization',
        },
        ] : []),
        ...(adaptationRequired ? [{
          id: 'validated_local_spin',
          passed: adaptationPassed,
          reason: 'learning-only adaptation must pass the opaque on-disk validation gate',
        }] : []),
      ],
    };
  }
  const command = commandAssessment(
    candidate.command,
    candidate.strategy,
    candidate.host_native_install,
    candidate.installer_attestation,
    candidate.identity,
  );
  const scopeAllowed = INSTALL_SCOPES.includes(candidate.install_scope);
  const rollbackDeclared =
    candidate.rollback_safe === true &&
    nonEmptyText(candidate.rollback_procedure);
  const checks = [
    {
      id: 'effect_authorization',
      passed: isProvisionEffectAuthorization(candidate.effect_authorization, {
        request: candidate.capability_request,
        effectKind: 'install',
        candidate,
      }),
      reason: 'installation requires request- and Origin-bound effect authorization',
    },
    {
      id: 'selection_gate',
      passed: isDirectUseEvaluationForCandidate(candidate.selection_evaluation, candidate),
      reason: 'install requires an opaque result from the complete private selection gate',
    },
    {
      id: 'trusted_source',
      passed: catalogTrust(candidate, policy),
      reason: 'source must be official or explicitly trusted',
    },
    {
      id: 'identity_unambiguous',
      passed: candidate.identity_verified === true && nonEmptyText(candidate.identity),
      reason: 'package or plugin identity must be verified',
    },
    {
      id: 'version_pinned',
      passed: isPinned(candidate.version) || isPinned(candidate.revision),
      reason: 'version or immutable revision must be recorded',
    },
    {
      id: 'local_scope',
      passed: scopeAllowed,
      reason: 'installation must remain repository-local, repository, virtualenv, or local scoped',
    },
    {
      id: 'no_privilege_escalation',
      passed: candidate.privilege_escalation !== true,
      reason: 'privilege escalation is forbidden',
    },
    {
      id: 'command_inspectable',
      passed: command.passed,
      reason: command.reason,
    },
    {
      id: 'post_install_explained',
      passed:
        candidate.post_install === false ||
        candidate.post_install === 'none' ||
        candidate.post_install_reviewed === true,
      reason: 'post-install behavior must be absent or reviewed',
    },
    {
      id: 'license_inspectable',
      passed: candidate.license_inspectable === true && Boolean(candidate.license),
      reason: 'license and platform requirements must be inspectable',
    },
    {
      id: 'platform_requirements_inspectable',
      passed: candidate.platform_requirements_inspectable === true,
      reason: 'platform requirements must be inspectable',
    },
    {
      id: 'no_auth_or_secret',
      passed: candidate.requires_secret === false,
      reason: 'automatic installation cannot require reusable secret material',
    },
    {
      id: 'host_permission',
      passed: candidate.host_permission === true,
      reason: 'host permission policy must explicitly allow installation',
    },
    {
      id: 'sandbox_allowed',
      passed: candidate.sandbox_allowed === true,
      reason: 'sandbox policy must explicitly allow installation',
    },
    {
      id: 'rollback_declared',
      passed: rollbackDeclared,
      reason: 'installation must declare rollback safety and an adapter or concrete procedure',
    },
  ];
  const hardReject =
    !scopeAllowed ||
    !catalogTrust(candidate, policy) ||
    !isDirectUseEvaluationForCandidate(candidate.selection_evaluation, candidate) ||
    !isProvisionEffectAuthorization(candidate.effect_authorization, {
      request: candidate.capability_request,
      effectKind: 'install',
      candidate,
    }) ||
    candidate.privilege_escalation === true ||
    !command.passed ||
    candidate.requires_secret === true;
  let decision = 'auto_approved';
  if (hardReject) decision = 'rejected';
  else if (candidate.host_permission === false || candidate.sandbox_allowed === false) {
    decision = 'blocked';
  } else if (candidate.auth_required === true && checks.every((check) => check.passed)) {
    decision = 'waiting_auth';
  } else if (checks.some((check) => !check.passed)) {
    decision = 'approval_required';
  }
  return sanitizeProvisionRecord({ decision, checks });
}

function normalizeCandidate(rawCandidate, strategy, node, contractNode) {
  if (!isPlainObject(rawCandidate)) {
    throw new ProvisionValidationError(`${node.id} resolver ${strategy} returned a non-object candidate.`);
  }
  if (!CANDIDATE_ACTIONS.has(rawCandidate.action)) {
    throw new ProvisionValidationError(
      `${node.id} resolver ${strategy} returned unsupported action ${rawCandidate.action}.`,
    );
  }
  const allowed = {};
  for (const field of [
    'action',
    'source',
    'repository',
    'identity',
    'identity_verified',
    'version',
    'revision',
    'reviewed_commit_sha',
    'content_sha256',
    'official',
    'trusted',
    'publisher_verified',
    'command',
    'post_install',
    'post_install_reviewed',
    'license',
    'license_inspectable',
    'platform_requirements_inspectable',
    'privilege_escalation',
    'host_permission',
    'sandbox_allowed',
    'rollback_safe',
    'rollback_procedure',
    'auth_job',
    'auth_mechanism',
    'blocking_reason',
    'reason',
    'host_native_install',
    'selection_evaluation',
    'effect_authorization',
    'auth_effect_authorization',
    'request_id',
    'external_candidate',
    'local_spin',
    'capability_request',
    'installer_attestation',
    'fallback_approval',
  ]) {
    if (Object.hasOwn(rawCandidate, field)) allowed[field] = rawCandidate[field];
  }
  return {
    ...allowed,
    strategy,
    capability: node.capability,
    install_scope: rawCandidate.install_scope ?? contractNode.requested_execution.install_scope ?? 'local',
    auth_required: rawCandidate.auth_required ?? false,
    requires_secret: rawCandidate.requires_secret ?? false,
  };
}

function fallbackAssessment(candidate, node, run) {
  if (candidate.action !== 'fallback') return { passed: true, reason: null };
  if (node.necessity === 'optional') return { passed: true, reason: null };
  const fallback = node.approved_fallback;
  const passed = isCapabilityFallbackApproval(candidate.fallback_approval, {
    request: candidate.capability_request,
    provisionRunId: run.run_id,
    nodeId: node.id,
    fallback,
  }) && fallback.equivalent_mandatory_evidence === true &&
    (!nonEmptyText(fallback.identity) || fallback.identity === candidate.identity);
  return {
    passed,
    reason: passed ? null : 'fallback_not_preapproved_or_equivalent',
  };
}

function candidateSummary(candidate) {
  return sanitizeProvisionRecord({
    action: candidate.action,
    strategy: candidate.strategy,
    source: candidate.source ?? null,
    identity: candidate.identity ?? null,
    version: candidate.version ?? null,
    revision: candidate.revision ?? null,
    install_scope: candidate.install_scope ?? null,
    auth_required: candidate.auth_required ?? false,
    auth_job: candidate.auth_job ?? null,
    rollback_safe: candidate.rollback_safe === true,
    rollback_procedure: candidate.rollback_procedure ?? null,
  });
}

function errorRecord(error) {
  return sanitizeProvisionRecord({
    name: error?.name ?? 'Error',
    code: error?.code ?? null,
    message: error?.message ?? String(error),
  });
}

function outcomeForRun(run) {
  const required = run.nodes.filter((node) => node.required_for_completion);
  const counts = Object.fromEntries(CAPABILITY_STATUSES.map((status) => [status, 0]));
  for (const node of run.nodes) counts[node.status] += 1;
  let status;
  if (required.every((node) => SATISFIED_STATUSES.has(node.status))) status = 'succeeded';
  else if (required.some((node) => node.status === 'waiting_auth')) status = 'waiting_auth';
  else if (required.some((node) => node.status === 'failed')) status = 'failed';
  else if (required.some((node) => ['blocked', 'excluded', 'quarantined'].includes(node.status))) status = 'blocked';
  else status = 'pending';
  return {
    status,
    counts,
    waiting_auth: required
      .filter((node) => node.status === 'waiting_auth')
      .map((node) => node.id),
    blocking: required
      .filter((node) => ['blocked', 'failed', 'excluded', 'quarantined'].includes(node.status))
      .map((node) => ({ id: node.id, status: node.status, reason: node.blocking_reason })),
  };
}

async function ensureRealDirectory(path) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ProvisionValidationError(`${path} must be a real directory.`);
  }
  await chmod(path, 0o700);
}

async function readBoundedRootStateFile(root, path, {
  maxBytes,
  label,
} = {}) {
  const canonicalRoot = await realpath(resolve(root));
  const absolutePath = resolve(path);
  const pathFromRoot = relative(canonicalRoot, absolutePath);
  if (!pathFromRoot || pathFromRoot === '..' || pathFromRoot.startsWith('../') || isAbsolute(pathFromRoot)) {
    throw new ProvisionValidationError(`${label} path escapes the provision repository root.`);
  }
  const before = await lstat(absolutePath);
  if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) {
    throw new ProvisionValidationError(`${label} must be a bounded regular non-symlink file.`);
  }
  const canonicalPath = await realpath(absolutePath);
  const canonicalFromRoot = relative(canonicalRoot, canonicalPath);
  if (!canonicalFromRoot || canonicalFromRoot === '..' || canonicalFromRoot.startsWith('../') ||
      isAbsolute(canonicalFromRoot)) {
    throw new ProvisionValidationError(`${label} path escapes the provision repository root.`);
  }

  let handle;
  try {
    handle = await open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new ProvisionValidationError(`${label} changed before its bounded read.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length > maxBytes || bytes.length !== opened.size ||
        after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs) {
      throw new ProvisionValidationError(`${label} changed during its bounded read.`);
    }
    return bytes.toString('utf8');
  } finally {
    await handle?.close();
  }
}

async function atomicWrite(path, content) {
  const temporary = join(dirname(path), '.prov-stage');
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // Preserve the original write/rename error.
    }
    throw error;
  }
}

async function immutableAtomicWrite(path, content) {
  const temporary = join(dirname(path), '.prov-link');
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await link(temporary, path);
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

/**
 * Private YAML state store. It deliberately has no public skill or command surface.
 */
export class ProvisionStateStore {
  constructor({ root, now = () => new Date() } = {}) {
    if (!root) throw new TypeError('ProvisionStateStore root is required.');
    const requestedRoot = resolve(root);
    const canonicalRoot = realpathSync(requestedRoot);
    Object.defineProperties(this, {
      requestedRoot: { value: requestedRoot, enumerable: true },
      root: { value: canonicalRoot, enumerable: true },
      now: { value: now },
    });
    PROVISION_STATE_STORE_BINDINGS.set(this, {
      requested_root: requestedRoot,
      canonical_root: canonicalRoot,
    });
    Object.freeze(this);
  }

  async _paths() {
    const binding = PROVISION_STATE_STORE_BINDINGS.get(this);
    if (!binding) {
      throw new ProvisionValidationError('Provision state store authority is forged or unavailable.');
    }
    const currentRoot = await realpath(binding.requested_root);
    if (currentRoot !== binding.canonical_root) {
      throw new ProvisionValidationError('Provision state store canonical repository root drifted.');
    }
    const cruise = join(binding.canonical_root, '.cruise');
    const internal = join(cruise, 'internal');
    const runs = join(internal, 'provision-runs');
    const skills = join(cruise, 'skills');
    const quarantine = join(skills, 'quarantine');
    const adapted = join(skills, 'adapted');
    const authJobs = join(internal, 'auth-jobs');
    const authState = join(internal, 'auth-state');
    for (const directory of [cruise, internal, runs, authJobs, authState, skills, quarantine, adapted]) {
      await ensureRealDirectory(directory);
    }
    return {
      internal,
      runs,
      skills,
      quarantine,
      adapted,
      authJobs,
      authState,
      exclude: join(skills, 'exclude'),
      rejected: join(internal, 'rejected.yaml'),
      capabilities: join(internal, 'caps.yaml'),
    };
  }

  async loadExclusions() {
    const paths = await this._paths();
    try {
      const source = await readBoundedRootStateFile(this.root, paths.exclude, {
        maxBytes: EXCLUSION_STATE_MAX_BYTES,
        label: 'Cruise exclusion state',
      });
      const entries = source
        .split(/\r?\n/u)
        .map((line) => line.replace(/\s+#.*$/u, '').trim())
        .filter((line) => line && !line.startsWith('#'));
      if (entries.length > EXCLUSION_STATE_MAX_ENTRIES) {
        throw new ProvisionValidationError('Cruise exclusion state exceeds the bounded entry budget.');
      }
      return uniqueSorted(entries);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async loadRejectedCapabilities() {
    const paths = await this._paths();
    try {
      const source = await readBoundedRootStateFile(this.root, paths.rejected, {
        maxBytes: REJECTED_STATE_MAX_BYTES,
        label: 'Cruise rejected-capability state',
      });
      const parsed = parseProvisionYaml(source);
      if (parsed?.schema_version !== 1 || parsed?.kind !== 'cruise_rejected_capabilities' ||
          !Array.isArray(parsed.rejected)) {
        throw new ProvisionValidationError('Rejected capability registry is malformed.');
      }
      if (parsed.rejected.length > REJECTED_STATE_MAX_ENTRIES) {
        throw new ProvisionValidationError('Rejected capability registry exceeds the bounded entry budget.');
      }
      return parsed.rejected.map((entry) => createRejectedCapabilityRecord({
        repository: entry.repository,
        commitSha: entry.commit_sha,
        contentSha256: entry.content_sha256,
        reason: entry.reason,
        securityFindings: entry.security_findings,
        evaluatedAt: entry.evaluated_at,
      }));
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async saveRejectedCapability(record) {
    const validated = createRejectedCapabilityRecord({
      repository: record?.repository,
      commitSha: record?.commit_sha,
      contentSha256: record?.content_sha256,
      reason: record?.reason,
      securityFindings: record?.security_findings,
      evaluatedAt: record?.evaluated_at,
    });
    const paths = await this._paths();
    let state = { schema_version: 1, kind: 'cruise_rejected_capabilities', rejected: [] };
    try {
      const source = await readBoundedRootStateFile(this.root, paths.rejected, {
        maxBytes: REJECTED_STATE_MAX_BYTES,
        label: 'Cruise rejected-capability state',
      });
      const parsed = parseProvisionYaml(source);
      if (parsed?.schema_version === 1 && parsed?.kind === state.kind && Array.isArray(parsed.rejected)) {
        if (parsed.rejected.length > REJECTED_STATE_MAX_ENTRIES) {
          throw new ProvisionValidationError('Rejected capability registry exceeds the bounded entry budget.');
        }
        state = parsed;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const identity = `${validated.repository}:${validated.commit_sha}:${validated.content_sha256}`;
    state.rejected = state.rejected.filter((entry) =>
      `${entry.repository}:${entry.commit_sha}:${entry.content_sha256}` !== identity);
    state.rejected.push(validated);
    state.rejected.sort((left, right) =>
      `${left.repository}:${left.commit_sha}`.localeCompare(`${right.repository}:${right.commit_sha}`));
    if (state.rejected.length > REJECTED_STATE_MAX_ENTRIES) {
      throw new ProvisionValidationError('Rejected capability registry exceeds the bounded entry budget.');
    }
    const serialized = stringifyProvisionYaml(state);
    if (Buffer.byteLength(serialized, 'utf8') > REJECTED_STATE_MAX_BYTES) {
      throw new ProvisionValidationError('Rejected capability registry exceeds the bounded byte budget.');
    }
    await atomicWrite(paths.rejected, serialized);
    return paths.rejected;
  }

  async saveAuthJobState(state) {
    if (!isPlainObject(state) || !/^AUTH-[0-9]{3,5}$/u.test(state.id ?? '') ||
        !SAFE_ID.test(state.capability_id ?? '') || state.kind !== 'cruise_auth_job_state' ||
        !['running', 'failed', 'unconfirmed', 'succeeded', 'waiting_auth', 'cancelled', 'timed_out'].includes(state.status)) {
      throw new ProvisionValidationError('Authentication job state is invalid.');
    }
    const safe = sanitizeProvisionRecord(state);
    if (JSON.stringify(safe).includes(REDACTED)) {
      throw new ProvisionValidationError('Authentication job state must not contain secrets.');
    }
    const paths = await this._paths();
    const path = join(paths.authState, `${state.id}.yaml`);
    await atomicWrite(path, stringifyProvisionYaml(safe));
    return path;
  }

  async saveAuthJob(job) {
    validateAuthJob(job);
    const serialized = stringifyProvisionYaml(job);
    if (Buffer.byteLength(serialized, 'utf8') > 1024 * 1024) {
      throw new ProvisionValidationError('Authentication job exceeds the immutable artifact byte budget.');
    }
    const paths = await this._paths();
    const path = join(paths.authJobs, `${job.id}.yaml`);
    try {
      await immutableAtomicWrite(path, serialized);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readBoundedRootStateFile(this.root, path, {
        maxBytes: 1024 * 1024,
        label: 'Cruise immutable authentication job',
      });
      if (existing !== serialized) {
        throw new ProvisionValidationError('Authentication job bytes are immutable after first persistence.');
      }
    }
    return Object.freeze({
      path,
      sha256: createHash('sha256').update(serialized).digest('hex'),
    });
  }

  async saveRun(run) {
    validateProvisionRun(run);
    const contractBinding = assertRunMatchesProvisionContract(run);
    const safe = sanitizeProvisionRecord(run);
    const paths = await this._paths();
    const runDirectory = join(paths.runs, run.run_id);
    await ensureRealDirectory(runDirectory);
    const path = join(runDirectory, 'state.yaml');
    const contractPath = join(runDirectory, 'contract.yaml');
    const contractSerialized = stringifyProvisionYaml(contractBinding.contract);
    if (Buffer.byteLength(contractSerialized, 'utf8') > PROVISION_RUN_STATE_MAX_BYTES) {
      throw new ProvisionValidationError('Provision run contract exceeds the bounded artifact byte budget.');
    }
    try {
      await immutableAtomicWrite(contractPath, contractSerialized);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readBoundedRootStateFile(this.root, contractPath, {
        maxBytes: PROVISION_RUN_STATE_MAX_BYTES,
        label: 'Cruise immutable provision run contract',
      });
      if (existing !== contractSerialized) {
        provisionContractDrift('immutable persisted contract bytes changed');
      }
    }
    const serialized = stringifyProvisionYaml(safe);
    if (Buffer.byteLength(serialized, 'utf8') > PROVISION_RUN_STATE_MAX_BYTES) {
      throw new ProvisionValidationError('Provision run exceeds the bounded state byte budget.');
    }
    await atomicWrite(path, serialized);
    await this.saveCapabilities(run);
    return path;
  }

  async loadRun(runId, { capabilityRequest = null } = {}) {
    if (!SAFE_RUN_ID.test(String(runId ?? ''))) {
      throw new ProvisionValidationError('Invalid provision run id.');
    }
    const paths = await this._paths();
    const runDirectory = join(paths.runs, runId);
    const path = join(runDirectory, 'state.yaml');
    const contractPath = join(runDirectory, 'contract.yaml');
    const run = parseProvisionYaml(await readBoundedRootStateFile(this.root, path, {
      maxBytes: PROVISION_RUN_STATE_MAX_BYTES,
      label: 'Cruise provision run state',
    }));
    const contractSource = await readBoundedRootStateFile(this.root, contractPath, {
      maxBytes: PROVISION_RUN_STATE_MAX_BYTES,
      label: 'Cruise immutable provision run contract',
    });
    const contract = parseProvisionYaml(contractSource);
    validateProvisionRunContract(contract);
    if (stringifyProvisionYaml(contract) !== contractSource) {
      provisionContractDrift('immutable persisted contract is not canonical');
    }
    const contractBinding = {
      contract,
      digest: provisionRunContractDigest(contract),
    };
    if (!isOpaqueCapabilityRequest(capabilityRequest) || capabilityRequest.request.id !== run.request_id ||
        capabilityRequestAuthorityDigest(capabilityRequest) !== run.request_authority_sha256) {
      provisionContractDrift('load requires the exact live opaque CAPREQ authority');
    }
    assertLiveProvisionRequestContractAuthority(capabilityRequest, run.run_id, contractBinding.digest);
    PROVISION_RUN_CONTRACTS.set(run, contractBinding);
    PROVISION_RUN_REQUESTS.set(run, capabilityRequest);
    validateProvisionRun(run);
    return run;
  }

  async saveCapabilities(run) {
    const paths = await this._paths();
    let registry = {
      schema_version: PROVISION_SCHEMA_VERSION,
      kind: 'cruise_capability_registry',
      updated_at: timestamp(this.now),
      capabilities: [],
    };
    try {
      const parsed = parseProvisionYaml(await readBoundedRootStateFile(this.root, paths.capabilities, {
        maxBytes: CAPABILITY_REGISTRY_MAX_BYTES,
        label: 'Cruise capability registry',
      }));
      if (
        parsed.schema_version === PROVISION_SCHEMA_VERSION &&
        parsed.kind === 'cruise_capability_registry' &&
        Array.isArray(parsed.capabilities) &&
        parsed.capabilities.length <= CAPABILITY_REGISTRY_MAX_ENTRIES
      ) {
        registry = parsed;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const indexed = new Map(
      registry.capabilities.map((entry) => [`${entry.kind}:${entry.capability}`, entry]),
    );
    for (const node of run.nodes) {
      indexed.set(`${node.kind}:${node.capability}`, {
        capability: node.capability,
        kind: node.kind,
        status: node.status,
        source: node.source,
        version: node.version,
        install_scope: node.install_scope,
        auth_required: node.auth_required,
        smoke_test: node.smoke_test,
        provenance: node.provenance,
        outcome: node.outcome,
        last_run_id: run.run_id,
        updated_at: node.updated_at,
      });
    }
    registry.updated_at = timestamp(this.now);
    registry.capabilities = [...indexed.values()].sort((left, right) =>
      `${left.kind}:${left.capability}`.localeCompare(`${right.kind}:${right.capability}`),
    );
    if (registry.capabilities.length > CAPABILITY_REGISTRY_MAX_ENTRIES) {
      throw new ProvisionValidationError('Capability registry exceeds the bounded entry budget.');
    }
    const serialized = stringifyProvisionYaml(sanitizeProvisionRecord(registry));
    if (Buffer.byteLength(serialized, 'utf8') > CAPABILITY_REGISTRY_MAX_BYTES) {
      throw new ProvisionValidationError('Capability registry exceeds the bounded byte budget.');
    }
    await atomicWrite(paths.capabilities, serialized);
    return paths.capabilities;
  }
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function containsUsableProof(value, seen = new WeakSet()) {
  if (nonEmptyText(value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return value === true;
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    const usable = value.length > 0 && value.some((entry) => containsUsableProof(entry, seen));
    seen.delete(value);
    return usable;
  }
  if (!isPlainObject(value)) {
    seen.delete(value);
    return false;
  }
  const entries = Object.entries(value);
  const usable = entries.length > 0 && entries.some(
    ([key, entry]) => nonEmptyText(key) && containsUsableProof(entry, seen),
  );
  seen.delete(value);
  return usable;
}

function isUsableProofRecord(value) {
  return (
    nonEmptyText(value) ||
    ((Array.isArray(value) || isPlainObject(value)) && containsUsableProof(value))
  );
}

function optionalProofText(value, field, fail) {
  if (value == null) return null;
  if (!nonEmptyText(value)) fail(`${field} must be a non-empty string when provided`);
  return value.trim();
}

function requireProvisionStateStoreAuthority(store, request) {
  const binding = PROVISION_STATE_STORE_BINDINGS.get(store);
  const expectedRoot = capabilityRequestRepositoryRoot(request);
  if (!binding || Object.getPrototypeOf(store) !== ProvisionStateStore.prototype ||
      binding.requested_root !== expectedRoot || binding.canonical_root !== expectedRoot ||
      store.requestedRoot !== binding.requested_root || store.root !== binding.canonical_root) {
    throw new ProvisionValidationError(
      'ProvisionScheduler state store must be the exact opaque store for the CAPREQ repository root.',
    );
  }
  return binding;
}

async function revalidateProvisionStateStoreAuthority(store, request) {
  const binding = requireProvisionStateStoreAuthority(store, request);
  const currentRoot = await realpath(binding.requested_root);
  if (currentRoot !== binding.canonical_root || currentRoot !== capabilityRequestRepositoryRoot(request)) {
    throw new ProvisionValidationError('ProvisionScheduler state store canonical repository root drifted.');
  }
  return binding;
}

export class ProvisionScheduler {
  constructor({
    run,
    capabilityRequest = null,
    resolvers = {},
    install = null,
    installBroker = null,
    smokeTest = null,
    smokeBroker = null,
    rollback = null,
    rollbackBroker = null,
    authCheck = null,
    authBroker = null,
    store = null,
    trustPolicy = {},
    exclusions = [],
    concurrency = 4,
    maxAttempts = null,
    maxAuthChecks = 3,
    authWaitTimeoutMs = 60_000,
    authPollIntervalMs = 1_000,
    now = () => new Date(),
    sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  } = {}) {
    validateProvisionRun(run);
    const contractBinding = assertRunMatchesProvisionContract(run);
    const boundRequest = PROVISION_RUN_REQUESTS.get(run) ?? capabilityRequest;
    if (!isOpaqueCapabilityRequest(boundRequest) || boundRequest.request.id !== run.request_id ||
        capabilityRequestAuthorityDigest(boundRequest) !== run.request_authority_sha256 ||
        (capabilityRequest && capabilityRequest !== boundRequest)) {
      throw new ProvisionValidationError('ProvisionScheduler requires the exact opaque CAPREQ authority for its run.');
    }
    assertLiveProvisionRequestContractAuthority(boundRequest, run.run_id, contractBinding.digest);
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new TypeError('Provision concurrency must be a positive integer.');
    }
    if (maxAttempts !== null && (!Number.isInteger(maxAttempts) || maxAttempts < 1)) {
      throw new TypeError('Provision maxAttempts must be null or a positive integer.');
    }
    if (install !== null || smokeTest !== null || rollback !== null || authCheck !== null) {
      throw new ProvisionValidationError(
        'Plain install/smoke/rollback callbacks are forbidden; plain auth callbacks are forbidden; use opaque execution and verification brokers.',
      );
    }
    if (store !== null) requireProvisionStateStoreAuthority(store, boundRequest);
    this.runState = structuredClone(sanitizeProvisionRecord(run));
    PROVISION_RUN_CONTRACTS.set(this.runState, contractBinding);
    PROVISION_RUN_REQUESTS.set(this.runState, boundRequest);
    assertRunMatchesProvisionContract(this.runState);
    this.capabilityRequest = boundRequest;
    this.resolvers = { ...resolvers };
    this.installBroker = installBroker;
    this.smokeBroker = smokeBroker;
    this.rollbackBroker = rollbackBroker;
    this.authBroker = authBroker;
    this.store = store;
    this.trustPolicy = trustPolicy;
    this.configuredExclusions = new Set(exclusions.map((value) => String(value).trim().toLowerCase()).filter(Boolean));
    this.exclusions = new Set(this.configuredExclusions);
    this.rejectedCapabilities = [];
    this.concurrency = concurrency;
    this.maxAttempts = maxAttempts;
    this.maxAuthChecks = maxAuthChecks;
    this.authWaitTimeoutMs = authWaitTimeoutMs;
    this.authPollIntervalMs = authPollIntervalMs;
    this.now = now;
    this.sleep = sleep;
    this._verifiedAuth = new Map();
    this._pendingAuth = new Map();
    this._declinedAuth = new Set();
    this._running = false;

    // A persisted running state means the process ended mid-attempt. Requeue it safely.
    for (const node of this.runState.nodes) {
      if (node.auth?.status === 'declined') this._declinedAuth.add(node.id);
      if (node.status === 'running' || node.status === 'succeeded') {
        const previousStatus = node.status;
        node.status = 'pending';
        node.blocking_reason = null;
        node.attempts.push({
          attempt: node.attempts.length + 1,
          stage: 'recovery',
          outcome: previousStatus === 'succeeded'
            ? 'persisted_success_revalidation_required'
            : 'interrupted_attempt_requeued',
          at: timestamp(this.now),
        });
      }
    }
  }

  snapshot() {
    return structuredClone(sanitizeProvisionRecord(this.runState));
  }

  _getNode(id) {
    assertRunMatchesProvisionContract(this.runState);
    const node = this.runState.nodes.find((entry) => entry.id === id);
    if (!node) throw new ProvisionValidationError(`Unknown capability node ${id}.`);
    return node;
  }

  getNode(id) {
    return structuredClone(sanitizeProvisionRecord(this._getNode(id)));
  }

  _contractNode(id) {
    const binding = assertRunMatchesProvisionContract(this.runState);
    const node = binding.contract.nodes.find((entry) => entry.id === id);
    if (!node) provisionContractDrift(`node ${id} is absent from immutable authority`);
    return node;
  }

  _touch(node = null) {
    const at = timestamp(this.now);
    this.runState.updated_at = at;
    if (node) node.updated_at = at;
    return at;
  }

  async _persist() {
    validateProvisionRun(this.runState);
    assertRunMatchesProvisionContract(this.runState);
    if (this.store) {
      await revalidateProvisionStateStoreAuthority(this.store, this.capabilityRequest);
      await ProvisionStateStore.prototype.saveRun.call(this.store, this.runState);
    }
  }

  async _refreshRevocations() {
    const currentExclusions = new Set(this.configuredExclusions);
    if (this.store) {
      await revalidateProvisionStateStoreAuthority(this.store, this.capabilityRequest);
      for (const entry of await ProvisionStateStore.prototype.loadExclusions.call(this.store)) {
        currentExclusions.add(entry.toLowerCase());
      }
    }
    this.exclusions = currentExclusions;
    if (this.store) {
      await revalidateProvisionStateStoreAuthority(this.store, this.capabilityRequest);
      this.rejectedCapabilities = await ProvisionStateStore.prototype.loadRejectedCapabilities.call(this.store);
    }
  }

  async _assertCandidateNotRevoked(candidate, node) {
    await this._refreshRevocations();
    const excludedIdentity = [node.capability, candidate.identity, candidate.repository, candidate.source]
      .filter(nonEmptyText)
      .some((value) => this.exclusions.has(value.trim().toLowerCase()));
    const rejectedRevision = this.rejectedCapabilities.some((entry) =>
      entry.repository === candidate.repository &&
      entry.commit_sha === candidate.reviewed_commit_sha &&
      entry.content_sha256 === candidate.content_sha256);
    if (excludedIdentity || rejectedRevision) {
      throw new ProvisionValidationError(`${node.id} capability authority was revoked before adapter execution.`, {
        code: 'CRUISE_PROVISION_REVOKED',
      });
    }
  }

  _propagateDependencies() {
    const byId = new Map(this.runState.nodes.map((node) => [node.id, node]));
    for (const node of this.runState.nodes) {
      if (!['pending', 'ready'].includes(node.status)) continue;
      const requirements = node.requires.map((id) => byId.get(id));
      const failed = requirements.find((dependency) =>
        DEPENDENCY_FAILURE_STATUSES.has(dependency.status),
      );
      if (failed) {
        node.status = 'blocked';
        node.blocking_reason = `dependency_${failed.status}:${failed.id}`;
        node.outcome = {
          code: 'dependency_unavailable',
          dependency: failed.id,
          dependency_status: failed.status,
        };
        this._touch(node);
        continue;
      }
      const waiting = requirements.find((dependency) => dependency.status === 'waiting_auth');
      if (waiting) {
        node.status = 'pending';
        node.blocking_reason = `waiting_auth:${waiting.id}`;
        this._touch(node);
        continue;
      }
      if (requirements.every((dependency) => SATISFIED_STATUSES.has(dependency.status))) {
        node.status = 'ready';
        node.blocking_reason = null;
        this._touch(node);
      } else {
        node.status = 'pending';
        node.blocking_reason = 'waiting_dependencies';
        this._touch(node);
      }
    }
  }

  _consumedAttemptCount(node) {
    return node.attempts.filter((attempt) =>
      ['failed', 'blocked'].includes(attempt.outcome),
    ).length;
  }

  async _smoke(candidate, node, installResult, attempt) {
    await this._assertCandidateNotRevoked(candidate, node);
    if (!this.smokeBroker) {
      throw new ProvisionValidationError(
        `${node.id} cannot succeed without a deterministic smoke test.`,
        { code: 'CRUISE_PROVISION_SMOKE_REQUIRED' },
      );
    }
    const result = await runProvisionSmokeVerification({
      broker: this.smokeBroker,
      request: this.capabilityRequest,
      provisionRunId: this.runState.run_id,
      node: this.snapshot().nodes.find((entry) => entry.id === node.id),
      candidate,
      installResult,
    });
    const fail = (reason) => {
      attempt.steps.push({ stage: 'smoke_test', outcome: 'failed', reason });
      throw new ProvisionValidationError(`${node.id} smoke test failed: ${reason}`, {
        code: 'CRUISE_PROVISION_SMOKE_FAILED',
      });
    };
    if (!isPlainObject(result) || result.ok !== true) {
      fail(result?.reason ?? 'deterministic smoke test did not prove capability');
    }

    if (!nonEmptyText(result.identity)) {
      fail('deterministic smoke proof omitted a non-empty capability identity');
    }
    const identity = result.identity.trim();
    if (
      [candidate.identity, installResult?.identity].some(
        (value) => value != null && !nonEmptyText(value),
      )
    ) {
      fail('selected or installed capability identity is malformed');
    }
    const expectedIdentities = [candidate.identity, installResult?.identity]
      .filter(nonEmptyText)
      .map((value) => value.trim());
    if (expectedIdentities.some((expected) => expected !== identity)) {
      fail('proven capability identity does not match the selected or installed identity');
    }

    const scope = sanitizeProvisionRecord(result.scope);
    if (!isUsableProofRecord(scope)) {
      fail('deterministic smoke proof omitted a usable non-empty capability scope');
    }
    const evidence = sanitizeProvisionRecord(result.evidence);
    if (!isUsableProofRecord(evidence)) {
      fail('deterministic smoke proof omitted non-empty verification evidence');
    }

    const version = optionalProofText(result.version, 'smoke proof version', fail);
    const revision = optionalProofText(result.revision, 'smoke proof revision', fail);
    const versionUnavailableReason = optionalProofText(
      result.version_unavailable_reason,
      'smoke proof version_unavailable_reason',
      fail,
    );
    const expectedVersions = [candidate.version, installResult?.version]
      .filter(nonEmptyText)
      .map((value) => value.trim());
    const expectedRevisions = [candidate.revision, installResult?.revision]
      .filter(nonEmptyText)
      .map((value) => value.trim());
    if (
      [candidate.version, installResult?.version, candidate.revision, installResult?.revision].some(
        (value) => value != null && !nonEmptyText(value),
      )
    ) {
      fail('selected or installed capability version or revision is malformed');
    }
    if (expectedVersions.length > 0 && (!version || expectedVersions.some((expected) => expected !== version))) {
      fail('proven capability version does not match the selected or installed version');
    }
    if (expectedRevisions.length > 0 && (!revision || expectedRevisions.some((expected) => expected !== revision))) {
      fail('proven capability revision does not match the selected or installed revision');
    }

    if (!version && !revision) {
      const versionMayBeUnavailable =
        ['host_native', 'builtin_fallback'].includes(candidate.strategy) &&
        ['use', 'fallback'].includes(candidate.action);
      if (!versionUnavailableReason) {
        fail('deterministic smoke proof omitted a capability version or immutable revision');
      }
      if (!versionMayBeUnavailable) {
        fail('version_unavailable_reason is permitted only for host-native or built-in capabilities');
      }
    } else if (versionUnavailableReason) {
      fail('version_unavailable_reason contradicts a proven capability version or revision');
    }

    attempt.steps.push({ stage: 'smoke_test', outcome: 'passed' });
    node.smoke_test = {
      ok: true,
      checked_at: timestamp(this.now),
      identity,
      version,
      revision,
      version_unavailable_reason: versionUnavailableReason,
      scope,
      evidence,
    };
    return node.smoke_test;
  }

  async _rollback(candidate, node, installResult, attempt) {
    if (candidate.action !== 'install') return;
    if (candidate.rollback_safe !== true) {
      attempt.steps.push({
        stage: 'rollback',
        outcome: 'unavailable',
        reason: 'rollback safety was not declared',
      });
      return;
    }
    if (!this.rollbackBroker || !installResult) {
      attempt.steps.push({
        stage: 'rollback',
        outcome: 'unavailable',
        reason: installResult
          ? 'automated rollback adapter is unavailable'
          : 'verified installation evidence is unavailable for automated rollback',
        procedure: nonEmptyText(candidate.rollback_procedure)
          ? redactString(candidate.rollback_procedure)
          : null,
      });
      return;
    }
    try {
      const result = await runProvisionRollback({
        broker: this.rollbackBroker,
        request: this.capabilityRequest,
        provisionRunId: this.runState.run_id,
        node: this.snapshot().nodes.find((entry) => entry.id === node.id),
        candidate,
        installResult,
      });
      attempt.steps.push({
        stage: 'rollback',
        outcome: result?.ok === false ? 'failed' : 'succeeded',
        rollback_contract_sha256: result.rollback_contract_sha256,
        rollback_evidence_sha256: result.rollback_evidence_sha256,
        file_change_log_sha256: result.file_change_log_sha256,
      });
    } catch (error) {
      attempt.steps.push({ stage: 'rollback', outcome: 'failed', error: errorRecord(error) });
    }
  }

  async _executeCandidate(candidate, node, attempt) {
    if (candidate.capability_request !== this.capabilityRequest ||
        candidate.capability_request.request?.id !== this.runState.request_id) {
      node.status = 'blocked';
      node.blocking_reason = 'capability_request_run_mismatch';
      node.outcome = { code: 'capability_request_run_mismatch' };
      attempt.outcome = 'blocked';
      attempt.steps.push({ stage: 'authority', outcome: 'blocked', reason: 'CAPREQ differs from provision run' });
      return;
    }
    if (candidate.strategy === 'learning_only_adaptation') {
      try {
        await revalidateLocalSpinForActivation(candidate.local_spin, {
          request: this.capabilityRequest,
        });
      } catch {
        node.status = 'blocked';
        node.blocking_reason = 'local_spin_validation_drift';
        node.outcome = { code: 'local_spin_validation_drift' };
        attempt.outcome = 'blocked';
        attempt.steps.push({ stage: 'trust', outcome: 'blocked', reason: 'local spin validation drift' });
        return;
      }
    }
    const summary = candidateSummary(candidate);
    node.source = summary.source;
    node.version = summary.version;
    node.install_scope = summary.install_scope;
    node.auth_required = summary.auth_required;
    node.trust = assessProvisionTrust(candidate, this.trustPolicy);

    if (candidate.requires_secret === true) {
      node.status = 'blocked';
      node.blocking_reason = 'reusable_secret_required';
      node.outcome = {
        code: 'reusable_secret_required',
        guidance: 'Use a host-native authentication flow that does not expose secret material.',
      };
      attempt.outcome = 'blocked';
      attempt.steps.push({
        stage: 'authentication',
        outcome: 'blocked',
        reason: 'candidate directly requires secret material',
      });
      return;
    }

    const fallback = fallbackAssessment(candidate, node, this.runState);
    if (!fallback.passed) {
      node.status = 'blocked';
      node.blocking_reason = fallback.reason;
      node.outcome = { code: fallback.reason };
      attempt.outcome = 'blocked';
      attempt.steps.push({ stage: 'fallback', outcome: 'blocked', reason: fallback.reason });
      return;
    }

    // A skip is a resolution decision, never a reason to authenticate.
    if (candidate.action === 'skip') {
      if (node.required_for_completion) {
        node.status = 'blocked';
        node.blocking_reason = 'required_capability_cannot_skip';
        node.outcome = { code: node.blocking_reason, reason: candidate.reason ?? null };
        attempt.outcome = 'blocked';
        attempt.steps.push({ stage: 'resolution', outcome: 'blocked', reason: node.blocking_reason });
      } else {
        node.status = 'skipped';
        node.blocking_reason = null;
        node.outcome = { code: 'skipped', reason: candidate.reason ?? null };
        attempt.outcome = 'skipped';
      }
      return;
    }

    if (candidate.action === 'approval_required' || node.trust.decision === 'approval_required') {
      node.status = 'blocked';
      node.blocking_reason = 'approval_required';
      node.outcome = { code: 'approval_required', trust: node.trust };
      attempt.outcome = 'blocked';
      attempt.steps.push({ stage: 'trust', outcome: 'approval_required' });
      return;
    }
    if (candidate.action === 'block' || ['blocked', 'rejected'].includes(node.trust.decision)) {
      node.status = 'blocked';
      node.blocking_reason =
        candidate.blocking_reason ??
        (node.trust.decision === 'rejected'
          ? candidate.action === 'install' ? 'unsafe_install_rejected' : 'unsafe_capability_rejected'
          : 'host_policy_blocked');
      node.outcome = { code: node.blocking_reason, trust: node.trust };
      attempt.outcome = 'blocked';
      attempt.steps.push({ stage: 'trust', outcome: node.trust.decision });
      return;
    }

    const verifiedAuth = this._verifiedAuth.get(node.id) ?? null;
    const currentAuthBinding = candidate.auth_required === true && candidate.auth_job
      ? {
          request_id: candidate.capability_request?.request?.id ?? null,
          request_authority_sha256: capabilityRequestAuthorityDigest(candidate.capability_request),
          provision_run_id: this.runState.run_id,
          capability_id: node.id,
          candidate_identity: candidate.identity,
          auth_job_sha256: stableDigest(candidate.auth_job),
          server_name: candidate.auth_job.command?.argv?.[3] ?? null,
          required_scope: candidate.auth_job.validation?.required_scope ?? [],
          identity_policy: candidate.auth_job.validation?.identity_policy ?? null,
          required_identity: candidate.auth_job.validation?.required_identity ?? null,
        }
      : null;
    if (verifiedAuth && (!currentAuthBinding ||
        stableDigest(verifiedAuth.authority) !== stableDigest(currentAuthBinding))) {
      node.status = 'blocked';
      node.blocking_reason = 'authenticated_candidate_authority_drift';
      node.outcome = { code: node.blocking_reason };
      attempt.outcome = 'blocked';
      attempt.steps.push({ stage: 'authentication', outcome: 'blocked', reason: node.blocking_reason });
      return;
    }
    if (candidate.auth_required === true) {
      try {
        validateAuthJob(candidate.auth_job);
        if (!isProvisionEffectAuthorization(candidate.auth_effect_authorization, {
          request: candidate.capability_request,
          effectKind: 'authenticate',
          capabilityId: node.id,
          requiredPermissions: candidate.auth_job.validation.required_scope,
          authJob: candidate.auth_job,
          provisionRunId: this.runState.run_id,
          candidateIdentity: candidate.identity,
        })) {
          throw new ProvisionValidationError('Authentication lacks request- and Origin-bound effect authorization.');
        }
        if (candidate.auth_job.capability_id !== node.id) {
          throw new ProvisionValidationError('Authentication job capability does not match the selected node.');
        }
      } catch {
        node.status = 'blocked';
        node.blocking_reason = 'auth_job_invalid';
        node.outcome = { code: 'auth_job_invalid' };
        attempt.outcome = 'blocked';
        attempt.steps.push({ stage: 'authentication', outcome: 'blocked', reason: 'missing structured native OAuth job' });
        return;
      }
      if (verifiedAuth) {
        try {
          const current = await revalidateProvisionAuthenticationAttestation(
            verifiedAuth.attestation,
            {
              request: this.capabilityRequest,
              effectAuthorization: verifiedAuth.effect_authorization,
              authJob: verifiedAuth.auth_job,
              provisionRunId: this.runState.run_id,
              capabilityId: node.id,
              candidateIdentity: verifiedAuth.candidate_identity,
            },
          );
          if (current.identity !== verifiedAuth.authenticated_identity ||
              JSON.stringify(current.scope) !== JSON.stringify(verifiedAuth.authenticated_scope)) {
            throw new ProvisionValidationError('Authenticated identity or scope drifted before activation.');
          }
          attempt.steps.push({
            stage: 'authentication',
            outcome: 'revalidated',
            evidence_sha256: current.evidence_sha256,
            persisted_state_sha256: current.persisted_state_sha256,
          });
        } catch {
          node.status = 'blocked';
          node.blocking_reason = 'authenticated_evidence_drift';
          node.outcome = { code: node.blocking_reason };
          attempt.outcome = 'blocked';
          attempt.steps.push({ stage: 'authentication', outcome: 'blocked', reason: node.blocking_reason });
          return;
        }
      } else {
      node.status = 'waiting_auth';
      node.blocking_reason = 'authentication_required';
      node.auth = {
        status: 'waiting_auth',
        job: sanitizeProvisionRecord(candidate.auth_job),
        mechanism: candidate.auth_mechanism ?? 'host_native',
        checks: 0,
        max_checks_per_wait: this.maxAuthChecks,
        last_checked_at: null,
        identity: null,
        scope: null,
        authority: currentAuthBinding,
      };
      this._pendingAuth.set(node.id, {
        auth_job: candidate.auth_job,
        effect_authorization: candidate.auth_effect_authorization,
        candidate_identity: candidate.identity,
      });
      node.outcome = { code: 'waiting_auth', auth_job_id: node.auth.job.id };
      attempt.outcome = 'waiting_auth';
      attempt.steps.push({ stage: 'authentication', outcome: 'waiting_auth' });
      return;
      }
    }

    const trust = assessProvisionTrust(
      { ...candidate, auth_required: false, requires_secret: false },
      this.trustPolicy,
    );
    node.trust = trust;
    if (candidate.action === 'approval_required' || trust.decision === 'approval_required') {
      node.status = 'blocked';
      node.blocking_reason = 'approval_required';
      node.outcome = { code: 'approval_required', trust };
      attempt.outcome = 'blocked';
      attempt.steps.push({ stage: 'trust', outcome: 'approval_required' });
      return;
    }
    if (candidate.action === 'block' || ['blocked', 'rejected'].includes(trust.decision)) {
      node.status = 'blocked';
      node.blocking_reason =
        candidate.blocking_reason ??
        (trust.decision === 'rejected' ? 'unsafe_install_rejected' : 'host_policy_blocked');
      node.outcome = { code: node.blocking_reason, trust };
      attempt.outcome = 'blocked';
      attempt.steps.push({ stage: 'trust', outcome: trust.decision });
      return;
    }
    let installResult = null;
    try {
      if (candidate.action === 'install') {
        if (trust.decision !== 'auto_approved') {
          throw new ProvisionValidationError(`${node.id} install lacks automatic trust approval.`);
        }
        if (!this.installBroker) {
          throw new ProvisionValidationError(`${node.id} has no opaque installer execution broker.`);
        }
        await this._assertCandidateNotRevoked(candidate, node);
        installResult = await runProvisionInstallExecution({
          broker: this.installBroker,
          request: this.capabilityRequest,
          provisionRunId: this.runState.run_id,
          nodeId: node.id,
          candidate,
        });
        attempt.steps.push({
          stage: 'install',
          outcome: 'command_completed',
          command_sha256: installResult.command_sha256,
          file_change_log_sha256: installResult.file_change_log_sha256,
          isolation_evidence_sha256: installResult.isolation_evidence_sha256,
        });
      }
      const smokeResult = await this._smoke(candidate, node, installResult, attempt);
      node.status = 'succeeded';
      node.blocking_reason = null;
      node.version = smokeResult.version;
      node.provenance = sanitizeProvisionRecord({
        strategy: candidate.strategy,
        source: candidate.source ?? null,
        identity: smokeResult.identity,
        version: smokeResult.version,
        revision: smokeResult.revision,
        version_unavailable_reason: smokeResult.version_unavailable_reason,
        install_scope: candidate.install_scope,
        installed: candidate.action === 'install',
        resolved_at: timestamp(this.now),
      });
      node.outcome = { code: 'capability_verified', smoke_test: node.smoke_test };
      if (candidate.action === 'fallback') {
        node.outcome.reconciliation = {
          outcome: 'equivalent_fallback',
          approved_before_activation: true,
          expected_quality_or_cost_difference: node.approved_fallback.expected_quality_or_cost_difference,
          mandatory_acceptance_preserved: true,
          protected_behavior_preserved: true,
          permission_envelope_preserved: true,
          mandatory_evidence_preserved: true,
        };
      }
      node.auth_required = candidate.auth_required === true ? true : false;
      attempt.outcome = 'succeeded';
    } catch (error) {
      await this._rollback(candidate, node, installResult, attempt);
      node.status = 'failed';
      node.blocking_reason = error.code ?? 'capability_execution_failed';
      node.outcome = { code: node.blocking_reason, error: errorRecord(error) };
      attempt.outcome = 'failed';
      attempt.error = errorRecord(error);
    }
  }

  async _executeNode(node) {
    const attempt = {
      attempt: node.attempts.length + 1,
      started_at: timestamp(this.now),
      finished_at: null,
      outcome: 'running',
      selected_strategy: null,
      steps: [],
      error: null,
    };
    node.attempts.push(attempt);
    node.resolution = {
      order: [...RESOLUTION_ORDER],
      considered: [],
      selected: null,
    };
    try {
      await this._refreshRevocations();
      if (this.exclusions.has(node.capability.toLowerCase())) {
        node.status = 'excluded';
        node.blocking_reason = 'capability_excluded';
        node.outcome = { code: 'capability_excluded' };
        attempt.outcome = 'excluded';
        attempt.steps.push({ stage: 'resolution', outcome: 'excluded_before_resolver' });
        return;
      }
      let selected = null;
      for (const strategy of RESOLUTION_ORDER) {
        const resolver = this.resolvers[strategy];
        if (typeof resolver !== 'function') {
          node.resolution.considered.push({ strategy, outcome: 'resolver_unavailable' });
          continue;
        }
        await this._refreshRevocations();
        if (this.exclusions.has(node.capability.toLowerCase())) {
          node.status = 'excluded';
          node.blocking_reason = 'capability_excluded';
          node.outcome = { code: 'capability_excluded' };
          attempt.outcome = 'excluded';
          attempt.steps.push({ stage: 'resolution', outcome: 'excluded_before_resolver' });
          break;
        }
        let candidate;
        try {
          candidate = await resolver({
            node: this.snapshot().nodes.find((entry) => entry.id === node.id),
            run: this.snapshot(),
            auth_verified: this._verifiedAuth.has(node.id),
          });
        } catch (error) {
          attempt.steps.push({ stage: 'resolution', strategy, outcome: 'failed', error: errorRecord(error) });
          throw error;
        }
        if (candidate == null) {
          node.resolution.considered.push({ strategy, outcome: 'not_available' });
          continue;
        }
        selected = normalizeCandidate(candidate, strategy, node, this._contractNode(node.id));
        await this._refreshRevocations();
        if (selected.auth_required === true && this._declinedAuth.has(node.id)) {
          node.resolution.considered.push({ strategy, outcome: 'authentication_declined' });
          selected = null;
          continue;
        }
        const excludedIdentity = [
          node.capability,
          selected.identity,
          selected.repository,
          selected.source,
        ].filter(nonEmptyText).some((value) => this.exclusions.has(value.trim().toLowerCase()));
        if (excludedIdentity) {
          node.resolution.considered.push({ strategy, outcome: 'excluded' });
          node.status = 'excluded';
          node.blocking_reason = 'capability_excluded';
          node.outcome = { code: 'capability_excluded' };
          attempt.outcome = 'excluded';
          selected = null;
          break;
        }
        const immutableRejected = this.rejectedCapabilities.some((entry) =>
          entry.repository === selected.repository &&
          entry.commit_sha === selected.reviewed_commit_sha &&
          entry.content_sha256 === selected.content_sha256);
        if (immutableRejected) {
          node.resolution.considered.push({ strategy, outcome: 'immutable_revision_rejected' });
          node.status = 'excluded';
          node.blocking_reason = 'immutable_revision_rejected';
          node.outcome = { code: 'immutable_revision_rejected' };
          attempt.outcome = 'excluded';
          selected = null;
          break;
        }
        const summary = candidateSummary(selected);
        node.resolution.considered.push({ strategy, outcome: 'selected', candidate: summary });
        node.resolution.selected = summary;
        attempt.selected_strategy = strategy;
        break;
      }
      if (node.status === 'excluded') {
        // Exclusion is already a terminal, recorded outcome; never enter adapters.
      } else if (!selected) {
        node.status = 'blocked';
        node.blocking_reason = 'no_trusted_resolution';
        node.outcome = { code: 'no_trusted_resolution' };
        attempt.outcome = 'blocked';
      } else {
        await this._executeCandidate(selected, node, attempt);
      }
    } catch (error) {
      node.status = 'failed';
      node.blocking_reason = error.code ?? 'resolver_failed';
      node.outcome = { code: node.blocking_reason, error: errorRecord(error) };
      attempt.outcome = 'failed';
      attempt.error = errorRecord(error);
    } finally {
      attempt.finished_at = timestamp(this.now);
      this._touch(node);
    }
  }

  async run() {
    if (this._running) throw new Error('ProvisionScheduler is already running.');
    this._running = true;
    try {
      validateProvisionRun(this.runState);
      await this._refreshRevocations();
      this.runState.status = 'running';
      this.runState.outcome = null;
      this._touch();
      await this._persist();

      while (true) {
        this._propagateDependencies();
        const ready = this.runState.nodes
          .filter((node) => node.status === 'ready')
          .sort((left, right) => left.id.localeCompare(right.id));
        if (ready.length === 0) break;
        for (let index = 0; index < ready.length; index += this.concurrency) {
          const batch = ready.slice(index, index + this.concurrency);
          for (const node of batch) {
            if (
              this.maxAttempts !== null &&
              this._consumedAttemptCount(node) >= this.maxAttempts
            ) {
              node.status = 'blocked';
              node.blocking_reason = 'attempt_limit_reached';
              node.outcome = { code: 'attempt_limit_reached' };
            } else {
              node.status = 'running';
              this._touch(node);
            }
          }
          await this._persist();
          await Promise.all(
            batch
              .filter((node) => node.status === 'running')
              .map((node) => this._executeNode(node)),
          );
          await this._persist();
        }
      }
      this._propagateDependencies();
      this.runState.outcome = outcomeForRun(this.runState);
      this.runState.status = this.runState.outcome.status;
      this._touch();
      await this._persist();
      return this.snapshot();
    } finally {
      this._running = false;
    }
  }

  async declineAuthentication(nodeId, { reason = 'user_declined_authentication' } = {}) {
    const node = this._getNode(nodeId);
    if (node.status !== 'waiting_auth') {
      throw new ProvisionValidationError(`${nodeId} is not waiting for authentication.`);
    }
    this._declinedAuth.add(node.id);
    this._pendingAuth.delete(node.id);
    this._verifiedAuth.delete(node.id);
    node.auth = {
      ...node.auth,
      status: 'declined',
      confirmed: false,
      reason: redactString(reason),
    };
    node.attempts.push({
      attempt: node.attempts.length + 1,
      stage: 'authentication',
      outcome: 'declined',
      at: timestamp(this.now),
      reason: redactString(reason),
    });
    if (node.necessity === 'optional') {
      node.status = 'skipped';
      node.blocking_reason = null;
      node.outcome = { code: 'optional_authentication_declined' };
    } else {
      node.status = 'pending';
      node.blocking_reason = null;
      node.outcome = null;
      node.resolution = null;
    }
    this._touch(node);
    await this._persist();
    return this.snapshot().nodes.find((entry) => entry.id === node.id);
  }

  async checkAuthentication(nodeId, options = {}) {
    const node = this._getNode(nodeId);
    if (node.status !== 'waiting_auth') {
      throw new ProvisionValidationError(`${nodeId} is not waiting for authentication.`);
    }
    if (!isPlainObject(options) || Object.hasOwn(options, 'authCheck')) {
      throw new ProvisionValidationError('Plain authentication callbacks are forbidden; use an opaque auth broker.');
    }
    const authBroker = options.authBroker ?? this.authBroker;
    const pending = this._pendingAuth.get(node.id) ?? null;
    if (pending && options.authEffectAuthorization != null &&
        options.authEffectAuthorization !== pending.effect_authorization) {
      throw new ProvisionValidationError('Authentication effect authority differs from the pending exact context.');
    }
    if (pending && options.authJob != null && options.authJob !== pending.auth_job) {
      throw new ProvisionValidationError('Authentication job differs from the pending exact context.');
    }
    const authJob = pending?.auth_job ?? options.authJob ?? node.auth?.job;
    const effectAuthorization = pending?.effect_authorization ?? options.authEffectAuthorization ?? null;
    const candidateIdentity = pending?.candidate_identity ?? node.auth?.authority?.candidate_identity;
    const expectedAuthority = {
      request_id: this.capabilityRequest.request.id,
      request_authority_sha256: capabilityRequestAuthorityDigest(this.capabilityRequest),
      provision_run_id: this.runState.run_id,
      capability_id: node.id,
      candidate_identity: candidateIdentity,
      auth_job_sha256: authJob ? stableDigest(authJob) : null,
      server_name: authJob?.command?.argv?.[3] ?? null,
      required_scope: authJob?.validation?.required_scope ?? [],
      identity_policy: authJob?.validation?.identity_policy ?? null,
      required_identity: authJob?.validation?.required_identity ?? null,
    };
    if (!authJob || stableDigest(node.auth?.authority) !== stableDigest(expectedAuthority)) {
      throw new ProvisionValidationError('Persisted authentication authority drifted before verification.');
    }
    node.auth.checks += 1;
    node.auth.last_checked_at = timestamp(this.now);
    const checked = await runProvisionAuthenticationVerification({
      broker: authBroker,
      request: this.capabilityRequest,
      effectAuthorization,
      authJob,
      provisionRunId: this.runState.run_id,
      capabilityId: node.id,
      candidateIdentity,
    });
    node.attempts.push({
      attempt: node.attempts.length + 1,
      stage: 'authentication',
      outcome: checked.verified ? 'verified' : 'waiting_auth',
      at: timestamp(this.now),
      evidence: sanitizeProvisionRecord({
        verified: checked.verified,
        reason: checked.reason ?? null,
        identity: checked.identity ?? null,
        scope: checked.scope ?? null,
        evidence_sha256: checked.evidence_sha256,
        persisted_state_sha256: checked.persisted_state_sha256,
      }),
    });
    if (checked.verified) {
      node.auth.status = 'verified';
      node.auth.identity = redactString(checked.identity);
      node.auth.scope = sanitizeProvisionRecord(checked.scope);
      node.auth.evidence_sha256 = checked.evidence_sha256;
      node.auth.persisted_state_sha256 = checked.persisted_state_sha256;
      node.status = 'pending';
      node.blocking_reason = null;
      node.outcome = { code: 'authentication_verified' };
      this._verifiedAuth.set(node.id, {
        authority: sanitizeProvisionRecord(node.auth.authority),
        authenticated_identity: checked.identity,
        authenticated_scope: sanitizeProvisionRecord(checked.scope),
        attestation: checked.attestation,
        auth_job: authJob,
        effect_authorization: effectAuthorization,
        candidate_identity: candidateIdentity,
      });
    } else {
      node.auth.status = 'waiting_auth';
      node.outcome = { code: 'waiting_auth', reason: checked.reason };
    }
    this._touch(node);
    await this._persist();
    return { verified: checked.verified, node: structuredClone(sanitizeProvisionRecord(node)) };
  }

  async waitForAuthentication(nodeId, options = {}) {
    if (!isPlainObject(options) || Object.hasOwn(options, 'authCheck')) {
      throw new ProvisionValidationError('Plain authentication callbacks are forbidden; use an opaque auth broker.');
    }
    const {
      authBroker = this.authBroker,
      authEffectAuthorization = null,
      authJob = null,
      maxChecks = this.maxAuthChecks,
      timeoutMs = this.authWaitTimeoutMs,
      intervalMs = this.authPollIntervalMs,
    } = options;
    if (!Number.isInteger(maxChecks) || maxChecks < 1) {
      throw new TypeError('maxChecks must be a positive integer.');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(intervalMs) || intervalMs < 0) {
      throw new TypeError('Authentication wait bounds must be non-negative finite numbers.');
    }
    const started = Date.now();
    for (let check = 0; check < maxChecks; check += 1) {
      if (Date.now() - started > timeoutMs) break;
      const result = await this.checkAuthentication(nodeId, { authBroker, authEffectAuthorization, authJob });
      if (result.verified) return { verified: true, checks: check + 1, node: result.node };
      if (check + 1 < maxChecks && intervalMs > 0) {
        const remaining = timeoutMs - (Date.now() - started);
        if (remaining <= 0) break;
        await this.sleep(Math.min(intervalMs, remaining));
      }
    }
    const node = this._getNode(nodeId);
    node.auth.status = 'waiting_auth';
    node.outcome = {
      code: 'auth_wait_bound_reached',
      checks: node.auth.checks,
      max_checks: maxChecks,
      timeout_ms: timeoutMs,
    };
    this._touch(node);
    await this._persist();
    return { verified: false, checks: node.auth.checks, node: structuredClone(sanitizeProvisionRecord(node)) };
  }

  async retryNode(nodeId) {
    const node = this._getNode(nodeId);
    if (!['failed', 'blocked'].includes(node.status)) {
      throw new ProvisionValidationError(`${nodeId} is not retryable from status ${node.status}.`);
    }
    if (
      this.maxAttempts !== null &&
      this._consumedAttemptCount(node) >= this.maxAttempts
    ) {
      throw new ProvisionValidationError(`${nodeId} reached its bounded attempt limit.`, {
        code: 'CRUISE_PROVISION_ATTEMPT_LIMIT',
      });
    }
    node.status = 'pending';
    node.blocking_reason = null;
    node.outcome = null;
    node.resolution = null;
    node.trust = null;
    node.smoke_test = null;
    this._requeueDependencyDescendants(node.id);
    this._touch(node);
    await this._persist();
    return this.run();
  }

  _requeueDependencyDescendants(nodeId) {
    const queue = [nodeId];
    const seen = new Set();
    while (queue.length > 0) {
      const currentId = queue.shift();
      if (seen.has(currentId)) continue;
      seen.add(currentId);
      const current = this._getNode(currentId);
      for (const dependentId of current.dependents) {
        const dependent = this._getNode(dependentId);
        if (
          dependent.status === 'blocked' &&
          dependent.blocking_reason?.startsWith('dependency_')
        ) {
          dependent.status = 'pending';
          dependent.blocking_reason = null;
          dependent.outcome = null;
          dependent.resolution = null;
          dependent.trust = null;
          dependent.smoke_test = null;
          this._touch(dependent);
        }
        queue.push(dependentId);
      }
    }
  }
}
