import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, opendir, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseYaml, readYamlFile, writeYamlFile } from './yaml-state.mjs';

export const PROVISION_PUBLIC_CALLERS = Object.freeze([
  'build',
  'quick',
  'refine',
  'goal',
  'debug',
  'research',
]);

export const COMMUNITY_DIRECT_USE_THRESHOLD_STARS = 1000;
export const TRUST_TIERS = Object.freeze([
  'official',
  'allowlisted',
  'established-community',
  'uncertain',
  'rejected',
]);
export const NECESSITY_LEVELS = Object.freeze(['optional', 'preferred', 'mandatory']);
export const NATIVE_INVENTORY_SOURCES = Object.freeze([
  'bundled_skills',
  'installed_plugins',
  'repository_local_skills',
  'user_local_skills',
  'administrative_skills',
  'mcp_servers',
  'connectors',
  'subagent_definitions',
  'installed_clis_and_analyzers',
  'repository_scripts_and_tests',
  'cruise_adaptations',
]);
export const PRIVATE_CAPABILITY_PATHS = Object.freeze({
  exclude: '.cruise/skills/exclude',
  quarantine: '.cruise/skills/quarantine/',
  adapted: '.cruise/skills/adapted/',
  rejected: '.cruise/internal/rejected-capabilities.yaml',
});
export const CURRENT_HOST_PROVISION_CAPABILITIES = Object.freeze({
  instruction_analysis_isolation_confirmed: false,
  execution_isolation_confirmed: false,
  same_thread_auth_watcher_confirmed: false,
  post_auth_validation_confirmed: true,
  capability_dag_update_confirmed: true,
  app_server_continuation_confirmed: false,
  trusted_tmux_auth_runner_confirmed: false,
  exclusion_scope: 'cruise-controlled-only',
  direct_external_activation_allowed: false,
});

export const FIT_SCORE_FIELDS = Object.freeze({
  semantic_task_match: 15,
  competence_gain: 15,
  verification_quality: 12,
  failure_mode_coverage: 10,
  repository_compatibility: 8,
  trust_and_provenance: 5,
  methodology_quality: 10,
  tool_compatibility: 8,
  context_efficiency: 7,
  maintenance_quality: 5,
  permission_proportionality: 5,
});

export const FIT_GATES = Object.freeze({
  normal: { aggregate: 85, confidence: 0.85 },
  high: { aggregate: 90, confidence: 0.9 },
  critical_minima: {
    semantic_task_match: 12,
    competence_gain: 11,
    verification_quality: 9,
    failure_mode_coverage: 7,
    repository_compatibility: 6,
    trust_and_provenance: 4,
  },
});

const REQUEST_ID = /^CAPREQ-[0-9]{3,}$/u;
const CAPABILITY_ID = /^CAP-[A-Z0-9][A-Z0-9-]*$/u;
const AUTH_ID = /^AUTH-[0-9]{3,}$/u;
const PROVISION_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const COMMIT_SHA = /^[a-f0-9]{40,64}$/iu;
const CONTENT_SHA = /^[a-f0-9]{64}$/iu;
const SAFE_NAME = /^[A-Za-z0-9_.-]+$/u;
const LOCAL_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CONSEQUENCE_LEVELS = new Set(['low', 'normal', 'high', 'critical']);
const INSTALL_SCOPES = new Set(['repository-local', 'repository', 'virtualenv', 'local']);
const BROAD_GAPS = new Set([
  'coding',
  'engineering',
  'help',
  'implementation',
  'programming',
  'research',
  'security',
  'testing',
  'tool',
]);
const RAW_CONTENT_KEYS = /^(?:content|instructions?|prompt|raw|readme|skill_md|source_text)$/iu;
const SENSITIVE_ARG = /(?:bearer|credential|password|private[-_]?key|secret|token|(?:sk|rk)-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,})/iu;
const LOCAL_SPIN_MAX_FILES = 512;
const LOCAL_SPIN_MAX_DIRECTORIES = 128;
const LOCAL_SPIN_MAX_DEPTH = 12;
const LOCAL_SPIN_MAX_RELATIVE_PATH_BYTES = 512;
const LOCAL_SPIN_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const ELIGIBLE_EVALUATIONS = new WeakSet();
const CAPABILITY_REQUEST_BINDINGS = new WeakMap();
const PROVISION_NEED_BROKERS = new WeakMap();
const PROVISION_NEED_ASSESSMENTS = new WeakMap();
const NATIVE_EVALUATION_BROKERS = new WeakMap();
const EXTERNAL_SELECTION_DECISIONS = new WeakMap();
const REVIEWED_EVALUATIONS = new WeakSet();
const REVIEWED_EVALUATION_REQUESTS = new WeakMap();
const REVIEWED_LEARNING_EXTRACTIONS = new WeakSet();
const LEARNING_EXTRACTION_RAW_MATERIAL = new WeakMap();
const LEARNING_EXTRACTION_REQUESTS = new WeakMap();
const QUARANTINED_BYTES = new WeakMap();
const EVALUATION_RAW_MATERIAL = new WeakMap();
const HOST_ISOLATION_BROKERS = new WeakMap();
const HOST_SANDBOX_ATTESTATIONS = new WeakMap();
const DIRECT_ACTIVATION_EVALUATIONS = new WeakMap();
const INSTRUCTION_SANDBOX_ANALYSES = new WeakMap();
const EXTERNAL_BEHAVIOR_EVALUATIONS = new WeakMap();
const VALIDATED_LOCAL_SPINS = new WeakSet();
const LOCAL_SPIN_RAW_MATERIAL = new WeakMap();
const LOCAL_SPIN_REQUESTS = new WeakMap();
const LOCAL_SPIN_EVALUATION_BROKERS = new WeakMap();
const LOCAL_SPIN_VALIDATION_PROOFS = new WeakMap();
const AUTH_RUNNER_BROKERS = new WeakMap();
const TRUSTED_AUTH_RUNNERS = new WeakMap();
const AUTH_JOB_PERSISTED_BYTES = new WeakMap();
const AUTH_VERIFICATION_BROKERS = new WeakMap();
const AUTH_VERIFICATION_ATTESTATIONS = new WeakMap();
const CONTINUATION_BROKERS = new WeakMap();
const CONTINUATION_ATTESTATIONS = new WeakMap();
const AUTHORIZED_EFFECTS = new WeakMap();
const EXCLUSION_SNAPSHOTS = new WeakMap();
const HOSTING_API_BROKERS = new WeakMap();
const INSTALLER_BROKERS = new WeakMap();
const TRUSTED_INSTALLER_ATTESTATIONS = new WeakMap();
const INSTALL_EXECUTION_BROKERS = new WeakMap();
const INSTALL_EXECUTION_RESULTS = new WeakSet();
const SMOKE_VERIFICATION_BROKERS = new WeakMap();
const ROLLBACK_EXECUTION_BROKERS = new WeakMap();
const TRUST_ALLOWLIST_SNAPSHOTS = new WeakMap();
const GOAL_EFFECT_APPROVALS = new WeakMap();
const FALLBACK_APPROVALS = new WeakMap();
const RECONCILIATION_APPROVALS = new WeakMap();
const TRUSTED_INSTALLER_NAMES = new Set(['npm', 'pnpm', 'yarn']);

function isObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, allowed, name) {
  if (!isObject(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError(`${name} contains unknown properties.`);
  }
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isoTimestamp(value) {
  const normalized = text(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(normalized) &&
    Number.isFinite(Date.parse(normalized));
}

function verifiedHostingApiSource(value) {
  return /^(?:github|gitlab|bitbucket|forgejo|gitea|hosting)-(?:rest-|graphql-)?api(?:-v\d+)?$/iu.test(text(value)) ||
    /^(?:api\.github\.com|gitlab\.com\/api\/v\d+)$/iu.test(text(value));
}

function stringArray(value, name) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`${name} must be an array of strings.`);
  }
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
}

function finiteFraction(value, name, fallback = 0) {
  const number = value ?? fallback;
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new TypeError(`${name} must be a finite number between 0 and 1.`);
  }
  return number;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableSha256(value) {
  const normalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (!isObject(entry)) return entry;
    return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, normalize(entry[key])]));
  };
  return sha256(JSON.stringify(normalize(value)));
}

function canonicalStrings(values) {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function hasRawContent(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => hasRawContent(entry, seen));
  return Object.entries(value).some(([key, child]) =>
    RAW_CONTENT_KEYS.test(key) || hasRawContent(child, seen));
}

function stringLeaves(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => stringLeaves(entry, output));
  else if (isObject(value)) Object.values(value).forEach((entry) => stringLeaves(entry, output));
  return output;
}

function normalizedWords(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim().split(/\s+/u).filter(Boolean);
}

function containsRawMaterial(structured, rawMaterials) {
  const raw = rawMaterials.map((value) => value.toLowerCase().replace(/\s+/gu, ' ').trim()).filter(Boolean);
  const leaves = stringLeaves(structured);
  const reconstructed = [leaves.join(''), leaves.join(' ')]
    .map((value) => value.toLowerCase().replace(/\s+/gu, ' ').trim())
    .filter((value) => value.length >= 16);
  if (reconstructed.some((value) => raw.some((source) => source.includes(value) || value.includes(source)))) {
    return true;
  }
  const reconstructedCompact = leaves.join('').toLowerCase().replace(/[^a-z0-9]+/gu, '');
  if (reconstructedCompact.length >= 16 && raw.some((source) => {
    const compactSource = source.replace(/[^a-z0-9]+/gu, '');
    return compactSource.includes(reconstructedCompact) || reconstructedCompact.includes(compactSource);
  })) return true;
  for (const leaf of leaves) {
    const normalized = leaf.toLowerCase().replace(/\s+/gu, ' ').trim();
    if (!normalized) continue;
    if (normalized.length >= 16 && raw.some((source) => source.includes(normalized) || normalized.includes(source))) {
      return true;
    }
    const words = normalizedWords(leaf);
    if (words.length >= 8) {
      const sequences = new Set();
      for (let index = 0; index <= words.length - 8; index += 1) {
        sequences.add(words.slice(index, index + 8).join(' '));
      }
      for (const source of raw) {
        const sourceWords = normalizedWords(source);
        for (let index = 0; index <= sourceWords.length - 8; index += 1) {
          if (sequences.has(sourceWords.slice(index, index + 8).join(' '))) return true;
        }
      }
    }
  }
  return false;
}

function gapTerms(request) {
  return canonicalStrings([
    ...request.gap.missing_competencies,
    ...request.gap.missing_tools,
    ...request.gap.missing_evidence_methods,
  ]);
}

function concreteGap(value) {
  const normalized = value.trim().toLowerCase();
  if (!normalized || BROAD_GAPS.has(normalized)) return false;
  return normalized.length >= 3;
}

export function createCapabilityRequest({
  id,
  originatingRun,
  publicSkill,
  originSha256,
  repositoryRoot,
  permissionDecisions = [],
  task = {},
  gap = {},
  constraints = {},
} = {}) {
  const boundRepositoryRoot = text(repositoryRoot);
  if (!CONTENT_SHA.test(originSha256 ?? '') || !Array.isArray(permissionDecisions) ||
      !isAbsolute(boundRepositoryRoot) || resolve(boundRepositoryRoot) !== boundRepositoryRoot) {
    throw new TypeError(
      'Capability request creation requires an immutable Origin digest, exact repository root, and permission decisions.',
    );
  }
  const decisions = permissionDecisions.map((decision) => {
    if (!isObject(decision) || !/^D-[0-9]+$/u.test(decision.id ?? '') || decision.granted !== true) {
      throw new TypeError('Capability request permission decisions must be exact granted D-* records.');
    }
    return deepFreeze({
      id: decision.id,
      granted: true,
      scopes: canonicalStrings(stringArray(decision.scopes ?? [], 'permission decision scopes')),
      permissions: canonicalStrings(stringArray(decision.permissions ?? [], 'permission decision permissions')),
    });
  });
  const request = {
    schema_version: 1,
    request: {
      id: text(id),
      originating_run: text(originatingRun),
      public_skill: text(publicSkill),
      task: {
        summary: text(task.summary),
        domains: stringArray(task.domains ?? [], 'task.domains'),
        languages: stringArray(task.languages ?? [], 'task.languages'),
        frameworks: stringArray(task.frameworks ?? [], 'task.frameworks'),
        consequence_level: task.consequence_level ?? 'normal',
      },
      gap: {
        missing_competencies: stringArray(gap.missing_competencies ?? [], 'gap.missing_competencies'),
        missing_tools: stringArray(gap.missing_tools ?? [], 'gap.missing_tools'),
        missing_evidence_methods: stringArray(
          gap.missing_evidence_methods ?? [],
          'gap.missing_evidence_methods',
        ),
        why_base_codex_is_insufficient: stringArray(
          gap.why_base_codex_is_insufficient ?? [],
          'gap.why_base_codex_is_insufficient',
        ),
        expected_improvement: stringArray(
          gap.expected_improvement ?? [],
          'gap.expected_improvement',
        ),
        minimum_improvement_required: finiteFraction(
          gap.minimum_improvement_required,
          'gap.minimum_improvement_required',
          0.1,
        ),
        expected_success_delta: finiteFraction(
          gap.expected_success_delta,
          'gap.expected_success_delta',
          0,
        ),
      },
      constraints: {
        repository: stringArray(constraints.repository ?? [], 'constraints.repository'),
        permissions: stringArray(constraints.permissions ?? [], 'constraints.permissions'),
        maximum_install_scope: constraints.maximum_install_scope ?? 'repository-local',
        authentication_allowed: constraints.authentication_allowed !== false,
        external_search_allowed: constraints.external_search_allowed !== false,
        latency_priority: constraints.latency_priority ?? 'normal',
      },
    },
  };
  validateCapabilityRequest(request);
  const frozen = deepFreeze(request);
  CAPABILITY_REQUEST_BINDINGS.set(frozen, deepFreeze({
    origin_sha256: originSha256,
    repository_root: boundRepositoryRoot,
    permission_decisions: decisions,
  }));
  return frozen;
}

export function validateCapabilityRequest(value) {
  if (!isObject(value) || value.schema_version !== 1 || !isObject(value.request)) {
    throw new TypeError('Capability request must use schema_version 1 and contain request.');
  }
  assertExactKeys(value, ['schema_version', 'request'], 'Capability request');
  const request = value.request;
  assertExactKeys(request, ['id', 'originating_run', 'public_skill', 'task', 'gap', 'constraints'], 'request');
  if (!REQUEST_ID.test(request.id)) throw new TypeError('Capability request id must match CAPREQ-*');
  if (!text(request.originating_run)) throw new TypeError('Capability request needs originating_run.');
  if (!PROVISION_PUBLIC_CALLERS.includes(request.public_skill)) {
    throw new TypeError('Capability request public_skill must be one of the six public Cruise skills.');
  }
  if (!isObject(request.task) || !text(request.task.summary)) {
    throw new TypeError('Capability request task.summary must be non-empty.');
  }
  assertExactKeys(request.task, ['summary', 'domains', 'languages', 'frameworks', 'consequence_level'], 'task');
  for (const field of ['domains', 'languages', 'frameworks']) stringArray(request.task[field], `task.${field}`);
  if (!CONSEQUENCE_LEVELS.has(request.task.consequence_level)) {
    throw new TypeError('Capability request consequence_level is invalid.');
  }
  if (!isObject(request.gap)) throw new TypeError('Capability request gap is missing.');
  assertExactKeys(request.gap, [
    'missing_competencies',
    'missing_tools',
    'missing_evidence_methods',
    'why_base_codex_is_insufficient',
    'expected_improvement',
    'minimum_improvement_required',
    'expected_success_delta',
  ], 'gap');
  for (const field of [
    'missing_competencies',
    'missing_tools',
    'missing_evidence_methods',
    'why_base_codex_is_insufficient',
    'expected_improvement',
  ]) stringArray(request.gap[field], `gap.${field}`);
  if (finiteFraction(request.gap.minimum_improvement_required, 'gap.minimum_improvement_required') < 0.1) {
    throw new TypeError('gap.minimum_improvement_required cannot be below 0.10.');
  }
  finiteFraction(request.gap.expected_success_delta, 'gap.expected_success_delta');
  if (!isObject(request.constraints)) throw new TypeError('Capability request constraints are missing.');
  assertExactKeys(request.constraints, [
    'repository',
    'permissions',
    'maximum_install_scope',
    'authentication_allowed',
    'external_search_allowed',
    'latency_priority',
  ], 'constraints');
  stringArray(request.constraints.repository, 'constraints.repository');
  stringArray(request.constraints.permissions, 'constraints.permissions');
  if (!['repository-local', 'none'].includes(request.constraints.maximum_install_scope)) {
    throw new TypeError('maximum_install_scope cannot exceed repository-local.');
  }
  if (typeof request.constraints.authentication_allowed !== 'boolean' ||
      typeof request.constraints.external_search_allowed !== 'boolean') {
    throw new TypeError('Capability request permission flags must be booleans.');
  }
  if (!['low', 'normal', 'high'].includes(request.constraints.latency_priority)) {
    throw new TypeError('Capability request latency_priority is invalid.');
  }
  return value;
}

export function isOpaqueCapabilityRequest(value) {
  return isObject(value) && CAPABILITY_REQUEST_BINDINGS.has(value);
}

export function capabilityRequestAuthorityDigest(value) {
  const binding = isObject(value) ? CAPABILITY_REQUEST_BINDINGS.get(value) : null;
  if (!binding) throw new TypeError('Capability authority digest requires an exact opaque CAPREQ.');
  return stableSha256({
    capability_request: value,
    origin_sha256: binding.origin_sha256,
    repository_root: binding.repository_root,
    permission_decisions: binding.permission_decisions,
  });
}

export function capabilityRequestRepositoryRoot(value) {
  const binding = isObject(value) ? CAPABILITY_REQUEST_BINDINGS.get(value) : null;
  if (!binding) throw new TypeError('Repository authority requires an exact opaque CAPREQ.');
  return binding.repository_root;
}

function nativeMetadata(candidate) {
  if (!isObject(candidate) || !text(candidate.name) || !text(candidate.kind)) {
    throw new TypeError('Native capability metadata requires name and kind.');
  }
  const result = {
    name: text(candidate.name),
    description: text(candidate.description),
    kind: text(candidate.kind),
    source_path: text(candidate.source_path) || null,
    version: text(candidate.version) || null,
    revision: text(candidate.revision) || null,
    content_sha256: text(candidate.content_sha256) || null,
    declared_dependencies: stringArray(candidate.declared_dependencies ?? [], 'declared_dependencies'),
    enabled: candidate.enabled !== false,
    provenance: text(candidate.provenance) || null,
    authentication_required: candidate.authentication_required === true,
    competencies: stringArray(candidate.competencies ?? [], 'competencies'),
    tools: stringArray(candidate.tools ?? [], 'tools'),
    evidence_methods: stringArray(candidate.evidence_methods ?? [], 'evidence_methods'),
    languages: stringArray(candidate.languages ?? [], 'languages'),
    frameworks: stringArray(candidate.frameworks ?? [], 'frameworks'),
    operating_systems: stringArray(candidate.operating_systems ?? [], 'operating_systems'),
    public_skills: stringArray(candidate.public_skills ?? PROVISION_PUBLIC_CALLERS, 'public_skills'),
    consequence_levels: stringArray(candidate.consequence_levels ?? [...CONSEQUENCE_LEVELS], 'consequence_levels'),
    repository_compatible: candidate.repository_compatible !== false,
    verified: candidate.verified === true,
    fit_score: Number.isFinite(candidate.fit_score) ? candidate.fit_score : 0,
  };
  return result;
}

function nativeCandidateKey(candidate) {
  return stableSha256({
    name: candidate.name,
    provider_source: candidate.provenance,
    source_path: candidate.source_path,
    revision: candidate.revision,
    content_sha256: candidate.content_sha256,
  });
}

export function createProvisionNativeEvaluationBroker({ issuer, request, evaluate } = {}) {
  if (issuer !== 'trusted-cruise-native-evaluation-broker' ||
      !isOpaqueCapabilityRequest(request) || typeof evaluate !== 'function') {
    throw new TypeError('Native evaluation requires the exact opaque request and trusted Cruise native-review broker.');
  }
  const broker = Object.freeze({ kind: 'cruise-provision-native-evaluation-broker' });
  NATIVE_EVALUATION_BROKERS.set(broker, { request, evaluate });
  return broker;
}

export async function collectNativeCapabilityMetadata({ providers = {}, maxPerSource = 250 } = {}) {
  if (!isObject(providers) || !Number.isInteger(maxPerSource) || maxPerSource < 1 || maxPerSource > 1000) {
    throw new TypeError('Native inventory providers and per-source bound are invalid.');
  }
  const candidates = [];
  const sources = [];
  for (const source of NATIVE_INVENTORY_SOURCES) {
    const provider = providers[source];
    if (typeof provider !== 'function') {
      sources.push({ source, status: 'unavailable', count: 0 });
      continue;
    }
    const records = await provider({ metadata_only: true, raw_instructions_allowed: false });
    if (!Array.isArray(records) || records.length > maxPerSource) {
      throw new TypeError(`Native inventory provider ${source} returned an unbounded result.`);
    }
    for (const record of records) {
      if (!isObject(record) || hasRawContent(record)) {
        throw new TypeError(`Native inventory provider ${source} returned raw or malformed metadata.`);
      }
      candidates.push(nativeMetadata({ ...record, provenance: source }));
    }
    sources.push({ source, status: 'inspected', count: records.length });
  }
  const identities = candidates.map(nativeCandidateKey);
  if (new Set(identities).size !== identities.length) {
    throw new TypeError('Native inventory providers returned a duplicate immutable capability identity.');
  }
  return { candidates, sources, metadata_only: true, raw_instructions_loaded: false };
}

export function inventoryNativeCapabilities({
  request,
  capabilities = [],
  excluded = [],
  operatingSystem = null,
} = {}) {
  validateCapabilityRequest(request);
  const excludedNames = new Set(canonicalStrings(excluded));
  const required = gapTerms(request.request);
  const task = request.request.task;
  const stageA = capabilities.map(nativeMetadata)
    .filter((candidate) => !excludedNames.has(candidate.name.toLowerCase()));
  const scored = stageA.map((candidate) => {
    const provided = canonicalStrings([
      ...candidate.competencies,
      ...candidate.tools,
      ...candidate.evidence_methods,
    ]);
    const exactMatches = required.filter((term) => provided.includes(term));
    const languageMatches = canonicalStrings(task.languages)
      .filter((term) => canonicalStrings(candidate.languages).includes(term));
    const frameworkMatches = canonicalStrings(task.frameworks)
      .filter((term) => canonicalStrings(candidate.frameworks).includes(term));
    const osCompatible = !operatingSystem || candidate.operating_systems.length === 0 ||
      canonicalStrings(candidate.operating_systems).includes(operatingSystem.toLowerCase());
    const compatible = candidate.enabled && candidate.repository_compatible && osCompatible &&
      candidate.public_skills.includes(request.request.public_skill) &&
      candidate.consequence_levels.includes(task.consequence_level);
    const relevance = compatible
      ? exactMatches.length * 100 + languageMatches.length * 10 + frameworkMatches.length * 10 + candidate.fit_score
      : -1;
    return { candidate, exactMatches, relevance, compatible };
  });
  const stageB = scored
    .filter(({ relevance }) => relevance > 0)
    .sort((left, right) => right.relevance - left.relevance || left.candidate.name.localeCompare(right.candidate.name))
    .slice(0, 5)
    .map(({ candidate, exactMatches, relevance }) => ({
      ...candidate,
      exact_gap_matches: exactMatches,
      relevance_score: relevance,
    }));
  const result = {
    stage_a_metadata: stageA,
    stage_b_relevant: stageB,
    stage_c_evaluations: [],
    native_candidate_sufficient: null,
    detailed_evaluation_limit: 5,
    raw_instructions_loaded: false,
  };
  return result;
}

export function assessProvisioningNeed({
  request,
  nativeInventory = null,
  searchCost = 0,
  evaluationCost = 0,
  contextCost = 0,
  installationCost = 0,
  authenticationCost = 0,
  maintenanceCost = 0,
  permissionCost = 0,
  operationalRiskCost = 0,
} = {}) {
  validateCapabilityRequest(request);
  const { gap, task, constraints, public_skill: publicSkill } = request.request;
  const gaps = gapTerms(request.request);
  const costs = [
    searchCost,
    evaluationCost,
    contextCost,
    installationCost,
    authenticationCost,
    maintenanceCost,
    permissionCost,
    operationalRiskCost,
  ]
    .map((value, index) => finiteFraction(value, `cost[${index}]`));
  const totalCost = Math.min(1, costs.reduce((sum, value) => sum + value, 0));
  const noProvisioning = (reason, extra = {}) => ({
    decision: { action: 'no_provisioning', reason },
    ...extra,
  });
  if (gaps.length === 0 || gaps.some((entry) => !concreteGap(entry))) {
    return noProvisioning('current_capabilities_sufficient', { finding: 'no_concrete_capability_gap' });
  }
  if (gap.why_base_codex_is_insufficient.length === 0 || gap.expected_improvement.length === 0) {
    return noProvisioning('current_capabilities_sufficient', { finding: 'benefit_not_demonstrated' });
  }
  if (nativeInventory?.native_candidate_sufficient) {
    return noProvisioning('current_capabilities_sufficient', {
      existing_capability: nativeInventory.native_candidate_sufficient,
    });
  }
  if (task.consequence_level === 'low' && gaps.length === 1 && gap.expected_success_delta < 0.2) {
    return noProvisioning('task_too_small_for_provisioning');
  }
  if (gap.expected_success_delta < gap.minimum_improvement_required ||
      gap.expected_success_delta <= totalCost) {
    return noProvisioning('expected_benefit_does_not_exceed_cost', {
      expected_delta: gap.expected_success_delta,
      total_cost: totalCost,
    });
  }
  if (!constraints.external_search_allowed) {
    return noProvisioning('external_search_not_allowed');
  }
  if (publicSkill === 'quick') {
    return noProvisioning('quick_requires_promotion_for_external_discovery', {
      recommended_public_skill: 'refine',
    });
  }
  return {
    decision: {
      action: 'external_discovery',
      reason: 'material_gap_survived_native_first_gate',
    },
    gap_terms: gaps,
    expected_delta: gap.expected_success_delta,
    total_cost: totalCost,
  };
}

export function createProvisionNeedAssessmentBroker({ issuer, assess } = {}) {
  if (issuer !== 'trusted-cruise-need-assessment-broker' || typeof assess !== 'function') {
    throw new TypeError('Provision need assessment requires the trusted Cruise assessor.');
  }
  const broker = Object.freeze({ kind: 'cruise-provision-need-assessment-broker' });
  PROVISION_NEED_BROKERS.set(broker, { assess });
  return broker;
}

export async function runProvisionNeedAssessment({ request, nativeInventory, broker } = {}) {
  validateCapabilityRequest(request);
  const binding = isObject(broker) ? PROVISION_NEED_BROKERS.get(broker) : null;
  if (!binding) throw new TypeError('Provisioning need requires an opaque trusted assessment broker.');
  const raw = await binding.assess({
    capability_request: clone(request),
    native_inventory: clone(nativeInventory),
    raw_instructions_allowed: false,
    public_skill_invocation_allowed: false,
  });
  const allowed = [
    'concrete_gap',
    'base_codex_insufficient',
    'generic_advice_only',
    'task_too_small',
    'implementation_or_verification_quality_changes',
    'expected_success_delta',
    'costs',
    'evidence_sha256',
  ];
  const costFields = [
    'search',
    'evaluation',
    'context',
    'installation',
    'authentication',
    'maintenance',
    'permissions',
    'operational_risk',
  ];
  if (!isObject(raw) || Object.keys(raw).some((key) => !allowed.includes(key)) ||
      !isObject(raw.costs) || Object.keys(raw.costs).length !== costFields.length ||
      costFields.some((key) => !Object.hasOwn(raw.costs, key)) ||
      Object.keys(raw.costs).some((key) => !costFields.includes(key)) ||
      !CONTENT_SHA.test(raw.evidence_sha256 ?? '')) {
    throw new TypeError('Trusted provisioning-need assessment is incomplete or malformed.');
  }
  const expectedDelta = finiteFraction(raw.expected_success_delta, 'need expected success delta');
  const costs = Object.fromEntries(costFields.map((field) => [
    field,
    finiteFraction(raw.costs[field], `need cost ${field}`),
  ]));
  const totalCost = Math.min(1, Object.values(costs).reduce((sum, value) => sum + value, 0));
  let reason = null;
  if (raw.concrete_gap !== true || raw.base_codex_insufficient !== true ||
      raw.implementation_or_verification_quality_changes !== true || raw.generic_advice_only === true) {
    reason = 'current_capabilities_sufficient';
  } else if (raw.task_too_small === true) reason = 'task_too_small_for_provisioning';
  else if (nativeInventory?.native_candidate_sufficient) reason = 'current_capabilities_sufficient';
  else if (expectedDelta < request.request.gap.minimum_improvement_required || expectedDelta <= totalCost) {
    reason = 'expected_benefit_does_not_exceed_cost';
  } else if (!request.request.constraints.external_search_allowed) reason = 'external_search_not_allowed';
  else if (request.request.public_skill === 'quick') reason = 'quick_requires_promotion_for_external_discovery';
  const result = deepFreeze({
    decision: reason
      ? { action: 'no_provisioning', reason }
      : { action: 'external_discovery', reason: 'trusted_material_gap_survived_native_first_gate' },
    expected_delta: expectedDelta,
    costs,
    total_cost: totalCost,
    evidence_sha256: raw.evidence_sha256,
    raw_instructions_loaded: false,
  });
  PROVISION_NEED_ASSESSMENTS.set(result, { request, nativeInventory });
  return result;
}

export function isExcludedCapability({ identity, repository = null, commitSha = null, contentSha256 = null }, exclusion = {}) {
  const entries = stringArray(exclusion.entries ?? [], 'exclusion.entries');
  const rejected = Array.isArray(exclusion.rejected) ? exclusion.rejected : [];
  const normalizedIdentity = text(identity).toLowerCase();
  if (!normalizedIdentity) throw new TypeError('Excluded capability check needs an identity.');
  if (entries.some((entry) => entry.toLowerCase() === normalizedIdentity ||
      (repository && entry.toLowerCase() === repository.toLowerCase()))) return true;
  return rejected.some((entry) => isObject(entry) &&
    entry.repository === repository &&
    Boolean(commitSha) && entry.commit_sha === commitSha &&
    (!contentSha256 || entry.content_sha256 === contentSha256));
}

async function readOptionalBoundedUtf8(path, canonicalRoot, maxBytes = 1024 * 1024) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maxBytes) {
      throw new TypeError(`Private provision authority file ${path} must be a bounded regular non-symlink file.`);
    }
    const canonicalPath = await realpath(path);
    const fromRoot = relative(canonicalRoot, canonicalPath);
    if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
      throw new TypeError(`Private provision authority file ${path} escapes the repository root.`);
    }
    return await readFile(canonicalPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function readExclusionState(root) {
  const canonicalRoot = await realpath(resolve(root));
  const excludePath = join(canonicalRoot, PRIVATE_CAPABILITY_PATHS.exclude);
  const rejectedPath = join(canonicalRoot, PRIVATE_CAPABILITY_PATHS.rejected);
  const excludeSource = await readOptionalBoundedUtf8(excludePath, canonicalRoot);
  const rejectedSource = await readOptionalBoundedUtf8(rejectedPath, canonicalRoot);
  let rejected = [];
  if (rejectedSource.trim()) {
    const parsed = parseYaml(rejectedSource);
    rejected = Array.isArray(parsed?.rejected) ? parsed.rejected.map((entry) => createRejectedCapabilityRecord({
      repository: entry.repository,
      commitSha: entry.commit_sha,
      contentSha256: entry.content_sha256,
      reason: entry.reason,
      securityFindings: entry.security_findings,
      evaluatedAt: entry.evaluated_at,
    })) : [];
  }
  const entries = excludeSource.split(/\r?\n/u)
    .map((line) => line.replace(/\s+#.*$/u, '').trim())
    .filter((line) => line && !line.startsWith('#'));
  return {
    root: canonicalRoot,
    entries: canonicalStrings(entries),
    rejected,
    digest: stableSha256({ exclude_source: excludeSource, rejected_source: rejectedSource }),
  };
}

export async function loadProvisionExclusionSnapshot({ root } = {}) {
  const state = await readExclusionState(root);
  const snapshot = Object.freeze({
    kind: 'cruise-provision-exclusion-snapshot',
    digest: state.digest,
    observed_at: new Date().toISOString(),
  });
  EXCLUSION_SNAPSHOTS.set(snapshot, deepFreeze(state));
  return snapshot;
}

async function requireCurrentExclusionSnapshot(snapshot) {
  const state = isObject(snapshot) ? EXCLUSION_SNAPSHOTS.get(snapshot) : null;
  if (!state) throw new TypeError('Activation requires an opaque Cruise exclusion snapshot.');
  const current = await readExclusionState(state.root);
  if (current.digest !== state.digest) {
    throw new TypeError('Cruise exclusion or rejected-capability state changed before activation.');
  }
  return state;
}

export function createRejectedCapabilityRecord({
  repository,
  commitSha,
  contentSha256,
  reason,
  securityFindings = [],
  evaluatedAt,
} = {}) {
  if (!text(repository) || !COMMIT_SHA.test(commitSha ?? '') || !CONTENT_SHA.test(contentSha256 ?? '') ||
      !text(reason) || !isoTimestamp(evaluatedAt)) {
    throw new TypeError('Rejected capability record needs immutable identity, reason, and timestamp.');
  }
  return {
    repository,
    commit_sha: commitSha,
    content_sha256: contentSha256,
    reason,
    security_findings: stringArray(securityFindings, 'securityFindings'),
    evaluated_at: evaluatedAt,
  };
}

export async function runPrivateProvisionSelection({
  request,
  nativeCapabilities = [],
  nativeProviders = {},
  excluded = [],
  operatingSystem = null,
  costs = {},
  needAssessmentBroker = null,
  discoverExternal = null,
  effectAuthorization = null,
  evaluateNative = null,
  nativeEvaluationBroker = null,
} = {}) {
  if (nativeCapabilities.length > 0) {
    throw new TypeError('Native selection must use metadata-only source providers, not caller-asserted candidates.');
  }
  const collected = await collectNativeCapabilityMetadata({ providers: nativeProviders });
  const exclusion = Array.isArray(excluded) ? { entries: excluded, rejected: [] } : excluded;
  if (!isObject(exclusion)) throw new TypeError('Excluded capability policy must be an array or object.');
  const inventory = inventoryNativeCapabilities({
    request,
    capabilities: collected.candidates,
    excluded: exclusion.entries ?? [],
    operatingSystem,
  });
  inventory.sources_inspected = collected.sources;
  if (evaluateNative !== null) {
    throw new TypeError('Native detailed evaluation rejects caller callbacks; use the opaque trusted native-review broker.');
  }
  if (inventory.stage_b_relevant.length > 0) {
    const nativeReview = isObject(nativeEvaluationBroker)
      ? NATIVE_EVALUATION_BROKERS.get(nativeEvaluationBroker)
      : null;
    if (!nativeReview || nativeReview.request !== request) {
      if (nativeReview) {
        throw new TypeError('Native detailed evaluation broker belongs to another capability request.');
      }
      return {
        schema_version: 1,
        inventory,
        decision: { action: 'no_provisioning', reason: 'native_detailed_evaluation_adapter_unavailable' },
        external_search: null,
      };
    }
    for (const candidate of inventory.stage_b_relevant) {
      if (!text(candidate.source_path) || !text(candidate.revision) ||
          !CONTENT_SHA.test(candidate.content_sha256 ?? '')) {
        inventory.stage_c_evaluations.push({
          candidate_name: candidate.name,
          provider_source: candidate.provenance,
          verified: false,
          fit_score: 0,
          repository_compatible: false,
          evidence_sha256: null,
          isolation_evidence_sha256: null,
          raw_instructions_exposed: false,
          reason: 'immutable_native_identity_unavailable',
        });
        continue;
      }
      const reviewed = await nativeReview.evaluate({
        capability_request: clone(request),
        candidate_metadata: clone(candidate),
        raw_instructions_return_allowed: false,
        public_skill_invocation_allowed: false,
      });
      const allowedReviewKeys = [
        'candidate_name',
        'provider_source',
        'source_path',
        'revision',
        'content_sha256',
        'verified',
        'fit',
        'repository_compatible',
        'evidence_sha256',
        'isolation_evidence_sha256',
        'raw_instructions_exposed',
      ];
      if (!isObject(reviewed) || hasRawContent(reviewed) ||
          Object.keys(reviewed).some((key) => !allowedReviewKeys.includes(key)) ||
          Object.keys(reviewed).length !== allowedReviewKeys.length ||
          allowedReviewKeys.some((key) => !Object.hasOwn(reviewed, key)) ||
          reviewed.candidate_name !== candidate.name ||
          reviewed.provider_source !== candidate.provenance ||
          reviewed.source_path !== candidate.source_path ||
          reviewed.revision !== candidate.revision ||
          reviewed.content_sha256 !== candidate.content_sha256 ||
          typeof reviewed.verified !== 'boolean' || !isObject(reviewed.fit) ||
          typeof reviewed.repository_compatible !== 'boolean' ||
          !CONTENT_SHA.test(reviewed.evidence_sha256 ?? '') ||
          !CONTENT_SHA.test(reviewed.isolation_evidence_sha256 ?? '') ||
          reviewed.raw_instructions_exposed !== false) {
        throw new TypeError('Native detailed evaluation returned unsafe or incomplete structured evidence.');
      }
      const fit = evaluateCapabilityFit({
        scores: reviewed.fit.scores,
        confidence: reviewed.fit.confidence,
        consequenceLevel: request.request.task.consequence_level,
        baselineExpectedSuccess: reviewed.fit.baseline_expected_success,
        candidateExpectedSuccess: reviewed.fit.candidate_expected_success,
        minimumImprovementRequired: request.request.gap.minimum_improvement_required,
        representativeEvalPassed: reviewed.fit.representative_eval_passed === true,
        mandatoryCompetencyMissing: reviewed.fit.mandatory_competency_missing === true,
        hardDisqualifier: reviewed.fit.hard_disqualifier === true,
      });
      inventory.stage_c_evaluations.push({
        candidate_key: nativeCandidateKey(candidate),
        candidate_name: reviewed.candidate_name,
        provider_source: reviewed.provider_source,
        source_path: reviewed.source_path,
        revision: reviewed.revision,
        content_sha256: reviewed.content_sha256,
        verified: reviewed.verified,
        fit_score: fit.aggregate,
        fit,
        repository_compatible: reviewed.repository_compatible,
        evidence_sha256: reviewed.evidence_sha256,
        isolation_evidence_sha256: reviewed.isolation_evidence_sha256,
        raw_instructions_exposed: false,
      });
    }
    const required = gapTerms(request.request);
    const sufficient = inventory.stage_b_relevant.find((candidate) => {
      const reviewed = inventory.stage_c_evaluations.find((entry) =>
        entry.candidate_key === nativeCandidateKey(candidate));
      return reviewed?.verified === true && reviewed.repository_compatible === true &&
        reviewed.fit?.passed === true &&
        required.every((term) => candidate.exact_gap_matches.includes(term));
    });
    inventory.native_candidate_sufficient = sufficient?.name ?? null;
  }
  const preliminary = assessProvisioningNeed({ request, nativeInventory: inventory, ...costs });
  let necessity = preliminary;
  if (preliminary.decision.action === 'external_discovery') {
    if (!needAssessmentBroker) {
      necessity = {
        decision: { action: 'no_provisioning', reason: 'trusted_need_assessment_unavailable' },
      };
    } else {
      necessity = await runProvisionNeedAssessment({
        request,
        nativeInventory: inventory,
        broker: needAssessmentBroker,
      });
    }
  }
  if (necessity.decision.action !== 'external_discovery') {
    return { schema_version: 1, inventory, ...necessity, external_search: null };
  }
  const needBinding = PROVISION_NEED_ASSESSMENTS.get(necessity);
  if (!needBinding || needBinding.request !== request || needBinding.nativeInventory !== inventory) {
    throw new TypeError('External discovery requires the opaque trusted provisioning-need decision.');
  }
  if (typeof discoverExternal !== 'function') {
    return {
      schema_version: 1,
      inventory,
      decision: { action: 'no_provisioning', reason: 'external_discovery_adapter_unavailable' },
      external_search: null,
    };
  }
  requireProvisionEffectAuthorization(effectAuthorization, request, 'external_discovery');
  const discovered = await discoverExternal({
    request: clone(request),
    exclusions: {
      entries: clone(exclusion.entries ?? []),
      rejected: clone(exclusion.rejected ?? []),
    },
    allowed_effect: 'metadata_and_selected_immutable_blobs_only',
    public_skill_invocation_allowed: false,
  });
  if (!isObject(discovered) || !isObject(discovered.external_search)) {
    throw new TypeError('External discovery must return a structured external_search record.');
  }
  const externalSearch = createExternalSearchRecord({
    sources: discovered.external_search.sources,
    queries: discovered.external_search.queries,
    repositoriesConsidered: discovered.external_search.repositories_considered,
    repositoriesRejected: discovered.external_search.repositories_rejected,
    stoppingCondition: discovered.external_search.stopping_condition,
    saturationReached: discovered.external_search.saturation_reached,
  });
  const rawCandidates = Array.isArray(discovered.candidates) ? discovered.candidates : [];
  if (rawCandidates.length > 100) {
    throw new TypeError('External discovery candidate budget exceeded.');
  }
  const candidates = rawCandidates
    .map((candidate) => {
        if (!isObject(candidate) || !text(candidate.repository) || !text(candidate.canonical_url) ||
            !COMMIT_SHA.test(candidate.commit_sha ?? '')) {
          throw new TypeError('Discovered candidate lacks immutable canonical identity.');
        }
        return {
          repository: text(candidate.repository),
          canonical_url: text(candidate.canonical_url),
          commit_sha: text(candidate.commit_sha),
        };
      });
  const candidateKeys = candidates.map(({ repository, commit_sha: commitSha }) => `${repository}@${commitSha}`);
  if (new Set(candidateKeys).size !== candidateKeys.length ||
      candidates.some(({ repository }) => !externalSearch.repositories_considered.includes(repository))) {
    throw new TypeError('External discovery candidates must be unique members of the considered repository set.');
  }
  const acceptedCandidates = [];
  const excludedCandidates = [];
  for (const candidate of candidates) {
    const rejected = isExcludedCapability({
      identity: candidate.repository,
      repository: candidate.repository,
      commitSha: candidate.commit_sha,
    }, exclusion);
    (rejected ? excludedCandidates : acceptedCandidates).push(candidate);
  }
  const selection = deepFreeze({
    schema_version: 1,
    inventory,
    ...necessity,
    external_search: {
      ...externalSearch,
      repositories_rejected: [...new Set([
        ...externalSearch.repositories_rejected,
        ...excludedCandidates.map(({ repository }) => repository),
      ])],
    },
    candidates: acceptedCandidates,
    excluded_candidates: excludedCandidates,
  });
  EXTERNAL_SELECTION_DECISIONS.set(selection, {
    request,
    inventory,
    need_assessment: necessity,
    candidates: clone(acceptedCandidates),
  });
  return selection;
}

export function createExternalSearchRecord({
  sources = [],
  queries = [],
  repositoriesConsidered = [],
  repositoriesRejected = [],
  stoppingCondition,
  saturationReached = false,
} = {}) {
  const record = {
    sources: stringArray(sources, 'external_search.sources'),
    queries: stringArray(queries, 'external_search.queries'),
    repositories_considered: stringArray(repositoriesConsidered, 'external_search.repositories_considered'),
    repositories_rejected: stringArray(repositoriesRejected, 'external_search.repositories_rejected'),
    stopping_condition: text(stoppingCondition),
    saturation_reached: saturationReached === true,
    exhaustive_internet_claimed: false,
  };
  if (record.sources.length === 0 || record.queries.length === 0 || !record.stopping_condition) {
    throw new TypeError('External search must record bounded sources, queries, and a stopping condition.');
  }
  if (record.sources.length > 8 || record.queries.length > 16 || record.repositories_considered.length > 100) {
    throw new TypeError('External search exceeded its bounded source, query, or candidate budget.');
  }
  if (record.repositories_rejected.length > 100 ||
      new Set(record.repositories_considered).size !== record.repositories_considered.length ||
      new Set(record.repositories_rejected).size !== record.repositories_rejected.length ||
      record.repositories_rejected.some((repository) => !record.repositories_considered.includes(repository))) {
    throw new TypeError('External search repositories must be bounded, unique, and drawn from the considered set.');
  }
  return record;
}

function normalizeCanonicalRepositoryUrl(value, repository, allowedHosts) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? '')) {
    throw new TypeError('Canonical repository identity must be an exact owner/repository pair.');
  }
  let parsed;
  try {
    parsed = new URL(text(value));
  } catch {
    throw new TypeError('Canonical repository URL must be an absolute HTTPS URL.');
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/u, '').replace(/\.git$/u, '');
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password ||
      parsed.search || parsed.hash || normalizedPath !== `/${repository}` ||
      !(allowedHosts instanceof Set) || !allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw new TypeError('Canonical repository URL must be credential-free HTTPS and match the exact owner/repository.');
  }
  return `${parsed.origin}/${repository}`;
}

export function createProvisionHostingApiBroker({
  issuer,
  providerSource,
  repositoryHosts = [],
  getRepositoryMetadata,
  resolveCommit,
  getTree,
  getBlob,
} = {}) {
  const hosts = canonicalStrings(stringArray(repositoryHosts, 'repositoryHosts'));
  if (issuer !== 'trusted-cruise-hosting-api-broker' || !verifiedHostingApiSource(providerSource) ||
      hosts.length === 0 || hosts.some((host) => !/^[A-Za-z0-9.-]+$/u.test(host)) ||
      [getRepositoryMetadata, resolveCommit, getTree, getBlob].some((method) => typeof method !== 'function')) {
    throw new TypeError('Hosting API broker requires a trusted issuer, verified provider source, repository hosts, and adapters.');
  }
  const broker = Object.freeze({
    kind: 'cruise-provision-hosting-api-broker',
    provider_source: providerSource,
  });
  HOSTING_API_BROKERS.set(broker, {
    provider_source: providerSource,
    repository_hosts: new Set(hosts),
    getRepositoryMetadata,
    resolveCommit,
    getTree,
    getBlob,
  });
  return broker;
}

export function createProvisionInstallerBroker({ issuer, inspectExecutable } = {}) {
  if (issuer !== 'trusted-cruise-installer-broker' || typeof inspectExecutable !== 'function') {
    throw new TypeError('Installer broker requires the trusted Cruise host inspector.');
  }
  const broker = Object.freeze({ kind: 'cruise-provision-installer-broker' });
  INSTALLER_BROKERS.set(broker, { inspectExecutable });
  return broker;
}

export function createTrustedInstallerAttestation({ commandFile, broker } = {}) {
  const brokerBinding = isObject(broker) ? INSTALLER_BROKERS.get(broker) : null;
  if (!TRUSTED_INSTALLER_NAMES.has(commandFile) || !brokerBinding) {
    throw new TypeError('Installer attestation requires an allowlisted installer and opaque host broker.');
  }
  const evidence = brokerBinding.inspectExecutable({ command_file: commandFile });
  if (evidence && typeof evidence.then === 'function') {
    throw new TypeError('Installer inspection must complete synchronously before attestation.');
  }
  const resolvedName = text(evidence?.resolved_path).replaceAll('\\', '/').split('/').at(-1);
  if (!isObject(evidence) || !isAbsolute(evidence.resolved_path ?? '') || resolvedName !== commandFile ||
      !CONTENT_SHA.test(evidence.file_sha256 ?? '') || !isoTimestamp(evidence.observed_at) ||
      evidence.regular_file !== true || evidence.symlink === true || evidence.executable !== true) {
    throw new TypeError('Installer host evidence must bind an executable regular file path and digest.');
  }
  const attestation = Object.freeze({
    kind: 'cruise-trusted-installer-attestation',
    command_file: commandFile,
    observed_at: evidence.observed_at,
  });
  TRUSTED_INSTALLER_ATTESTATIONS.set(attestation, deepFreeze({
    command_file: commandFile,
    resolved_path: evidence.resolved_path,
    file_sha256: evidence.file_sha256,
    inspect_executable: brokerBinding.inspectExecutable,
  }));
  return attestation;
}

export function isTrustedInstallerAttestationForCommand(attestation, command) {
  const binding = isObject(attestation) ? TRUSTED_INSTALLER_ATTESTATIONS.get(attestation) : null;
  if (!binding || !isObject(command) || binding.resolved_path !== command.file ||
      !TRUSTED_INSTALLER_NAMES.has(binding.command_file)) return false;
  const current = binding.inspect_executable({ command_file: binding.command_file });
  return Boolean(!(current && typeof current.then === 'function') && isObject(current) &&
    current.resolved_path === binding.resolved_path && current.file_sha256 === binding.file_sha256 &&
    current.regular_file === true && current.symlink !== true && current.executable === true);
}

function managedToolRoot(identity) {
  const normalized = text(identity).toLowerCase();
  if (!LOCAL_SKILL_NAME.test(normalized)) return null;
  return `.cruise/internal/tools/${normalized}`;
}

export function assessProvisionInstallCommand(command, {
  installerAttestation,
  identity,
  immutableTargets = [],
} = {}) {
  const managedRoot = managedToolRoot(identity);
  const targets = new Set(stringArray(immutableTargets, 'immutableTargets'));
  if (!isObject(command) || Object.keys(command).length !== 2 ||
      !Object.hasOwn(command, 'file') || !Object.hasOwn(command, 'args') ||
      typeof command.file !== 'string' || !isAbsolute(command.file) || !Array.isArray(command.args) ||
      command.args.some((argument) => typeof argument !== 'string') ||
      !isTrustedInstallerAttestationForCommand(installerAttestation, command)) {
    return { passed: false, reason: 'install command lacks exact structured installer authority', managed_root: managedRoot };
  }
  const executable = command.file.replaceAll('\\', '/').split('/').at(-1).toLowerCase();
  if (executable !== 'npm' || !managedRoot) {
    return { passed: false, reason: 'installer has no verified non-product activation grammar', managed_root: managedRoot };
  }
  const expectedPrefix = [
    'install',
    '--ignore-scripts',
    '--no-save',
    '--package-lock=false',
    '--workspaces=false',
    '--prefix',
    managedRoot,
  ];
  const exactShape = command.args.length === expectedPrefix.length + 1 &&
    expectedPrefix.every((argument, index) => command.args[index] === argument);
  const target = exactShape ? command.args.at(-1) : null;
  const immutableTarget = exactShape && targets.size > 0 ? targets.has(target) : exactShape;
  if (!exactShape || !immutableTarget) {
    return {
      passed: false,
      reason: 'install command must use the exact lifecycle-suppressed Cruise-managed npm grammar and immutable target',
      managed_root: managedRoot,
    };
  }
  return {
    passed: true,
    reason: 'exact Cruise-managed non-product npm activation grammar',
    managed_root: managedRoot,
    immutable_target: target,
    command_sha256: stableSha256(command),
  };
}

export function createProvisionInstallExecutionBroker({ issuer, request, repositoryRoot, execute } = {}) {
  const requestedRoot = resolve(repositoryRoot ?? '.');
  if (issuer !== 'trusted-cruise-install-execution-broker' ||
      !isOpaqueCapabilityRequest(request) || !isAbsolute(repositoryRoot ?? '') ||
      requestedRoot !== capabilityRequestRepositoryRoot(request) || typeof execute !== 'function') {
    throw new TypeError('Install execution requires the exact opaque request, repository root, and trusted Cruise execution broker.');
  }
  const broker = Object.freeze({ kind: 'cruise-provision-install-execution-broker' });
  INSTALL_EXECUTION_BROKERS.set(broker, { request, repository_root: requestedRoot, execute });
  return broker;
}

export function createProvisionTrustAllowlistSnapshot({ issuer, request, entries = [] } = {}) {
  validateCapabilityRequest(request);
  if (issuer !== 'trusted-cruise-allowlist-broker' || !CAPABILITY_REQUEST_BINDINGS.has(request) ||
      !Array.isArray(entries) || entries.length > 100) {
    throw new TypeError('Trust allowlist requires exact immutable entries from the trusted Cruise authority.');
  }
  const normalizedEntries = entries.map((entry) => {
    assertExactKeys(entry, [
      'owner',
      'repository',
      'capability',
      'commit_sha',
      'content_sha256',
      'release_process',
      'installation_path',
    ], 'Trust allowlist entry');
    const repository = text(entry.repository);
    const owner = text(entry.owner);
    if (!repository.includes('/') || owner !== repository.split('/')[0] || !text(entry.capability) ||
        !COMMIT_SHA.test(entry.commit_sha ?? '') || !CONTENT_SHA.test(entry.content_sha256 ?? '') ||
        !text(entry.release_process) || entry.installation_path !== 'repository-local') {
      throw new TypeError('Trust allowlist requires exact immutable owner, repository, capability, revision, content, release-process, and installation-path bindings.');
    }
    return {
      owner,
      repository,
      capability: text(entry.capability),
      commit_sha: entry.commit_sha,
      content_sha256: entry.content_sha256,
      release_process: text(entry.release_process),
      installation_path: entry.installation_path,
    };
  });
  const snapshot = Object.freeze({ kind: 'cruise-provision-trust-allowlist-snapshot' });
  TRUST_ALLOWLIST_SNAPSHOTS.set(snapshot, {
    request,
    entries: deepFreeze(normalizedEntries),
  });
  return snapshot;
}

export async function runProvisionInstallExecution({
  broker,
  request,
  provisionRunId,
  nodeId,
  candidate,
} = {}) {
  const binding = isObject(broker) ? INSTALL_EXECUTION_BROKERS.get(broker) : null;
  if (!binding || binding.request !== request || !SAFE_NAME.test(provisionRunId ?? '') ||
      !CAPABILITY_ID.test(nodeId ?? '') || !isObject(candidate)) {
    throw new TypeError('Install execution requires exact broker, CAPREQ, run, node, and candidate authority.');
  }
  const commandReview = assessProvisionInstallCommand(candidate.command, {
    installerAttestation: candidate.installer_attestation,
    identity: candidate.identity,
  });
  if (!commandReview.passed ||
      !isDirectUseEvaluationForCandidate(candidate.selection_evaluation, candidate) ||
      !isProvisionEffectAuthorization(candidate.effect_authorization, {
        request,
        effectKind: 'install',
        candidate,
      })) {
    throw new TypeError('Install execution candidate lacks exact reviewed command and effect authority.');
  }
  const canonicalRoot = await realpath(binding.repository_root);
  if (canonicalRoot !== binding.repository_root) {
    throw new TypeError('Install execution repository root is not canonical.');
  }
  const managedRoot = resolve(canonicalRoot, commandReview.managed_root);
  const managedRelative = relative(canonicalRoot, managedRoot);
  if (!managedRelative || managedRelative.startsWith('..') || isAbsolute(managedRelative)) {
    throw new TypeError('Install execution managed root escapes repository authority.');
  }
  const raw = await binding.execute({
    capability_request: clone(request),
    provision_run_id: provisionRunId,
    capability_id: nodeId,
    candidate_identity: candidate.identity,
    node: { id: nodeId },
    candidate: {
      identity: candidate.identity,
      version: text(candidate.version) || null,
      revision: text(candidate.revision) || null,
      source: text(candidate.source) || null,
      install_scope: text(candidate.install_scope) || null,
    },
    command: clone(candidate.command),
    command_sha256: commandReview.command_sha256,
    working_directory: canonicalRoot,
    allowed_write_paths: [managedRoot],
    network_target: commandReview.immutable_target,
    environment_secrets_available: false,
    credentials_available: false,
    public_skill_invocation_allowed: false,
  });
  const allowed = [
    'ok', 'exit_code', 'identity', 'version', 'revision', 'command_sha256',
    'file_change_log_sha256', 'isolation_evidence_sha256', 'written_paths',
  ];
  if (!isObject(raw) || Object.keys(raw).some((key) => !allowed.includes(key)) ||
      raw.ok !== true || raw.exit_code !== 0 || raw.command_sha256 !== commandReview.command_sha256 ||
      !CONTENT_SHA.test(raw.file_change_log_sha256 ?? '') ||
      !CONTENT_SHA.test(raw.isolation_evidence_sha256 ?? '') ||
      !Array.isArray(raw.written_paths) || raw.written_paths.length > 256 ||
      raw.written_paths.some((path) => {
        if (typeof path !== 'string' || !isAbsolute(path) || path.split(/[\\/]/u).includes('..')) return true;
        const normalized = resolve(path);
        const fromManaged = relative(managedRoot, normalized);
        return fromManaged.startsWith('..') || isAbsolute(fromManaged);
      })) {
    throw new TypeError('Install execution did not prove the exact command, isolation, and managed write set.');
  }
  const result = deepFreeze({
    ok: true,
    exitCode: 0,
    identity: text(raw.identity) || candidate.identity,
    version: text(raw.version) || null,
    revision: text(raw.revision) || null,
    command_sha256: raw.command_sha256,
    file_change_log_sha256: raw.file_change_log_sha256,
    isolation_evidence_sha256: raw.isolation_evidence_sha256,
    written_paths: [...raw.written_paths],
    repository_root: canonicalRoot,
    managed_install_root: managedRoot,
  });
  INSTALL_EXECUTION_RESULTS.add(result);
  return result;
}

export function createProvisionSmokeVerificationBroker({
  issuer,
  request,
  repositoryRoot,
  probe,
} = {}) {
  const requestedRoot = resolve(repositoryRoot ?? '.');
  if (issuer !== 'trusted-cruise-smoke-verification-broker' ||
      !isOpaqueCapabilityRequest(request) || !isAbsolute(repositoryRoot ?? '') ||
      requestedRoot !== capabilityRequestRepositoryRoot(request) || typeof probe !== 'function') {
    throw new TypeError('Smoke verification requires exact request, repository root, and trusted probe broker.');
  }
  const broker = Object.freeze({ kind: 'cruise-provision-smoke-verification-broker' });
  SMOKE_VERIFICATION_BROKERS.set(broker, {
    request,
    repository_root: requestedRoot,
    probe,
  });
  return broker;
}

export async function runProvisionSmokeVerification({
  broker,
  request,
  provisionRunId,
  node,
  candidate,
  installResult,
} = {}) {
  const binding = isObject(broker) ? SMOKE_VERIFICATION_BROKERS.get(broker) : null;
  if (!binding || binding.request !== request || !SAFE_NAME.test(provisionRunId ?? '') ||
      !isObject(node) || !CAPABILITY_ID.test(node.id ?? '') || !isObject(candidate) ||
      (candidate.action === 'install' && !INSTALL_EXECUTION_RESULTS.has(installResult))) {
    throw new TypeError('Smoke verification requires exact broker, CAPREQ, run, node, candidate, and install evidence.');
  }
  const canonicalRoot = await realpath(binding.repository_root);
  if (canonicalRoot !== binding.repository_root) {
    throw new TypeError('Smoke verification repository root is not canonical.');
  }
  const raw = await binding.probe({
    capability_request: clone(request),
    provision_run_id: provisionRunId,
    node: sanitizeProvisionMetadata({ id: node.id, capability: node.capability }),
    candidate: sanitizeProvisionMetadata({
      action: candidate.action,
      strategy: candidate.strategy,
      identity: candidate.identity,
      version: candidate.version ?? null,
      revision: candidate.revision ?? null,
      install_scope: candidate.install_scope,
    }),
    install_result: installResult ? clone(installResult) : null,
    repository_root: canonicalRoot,
    expected_managed_root: installResult?.managed_install_root ?? null,
    expected_identity: text(candidate.identity) || null,
    expected_version: text(candidate.version) || null,
    expected_revision: text(candidate.revision) || null,
    credentials_available: false,
    environment_secrets_available: false,
    public_skill_invocation_allowed: false,
  });
  const allowed = [
    'ok', 'identity', 'version', 'revision', 'version_unavailable_reason', 'scope', 'evidence',
    'reason', 'probe_sha256', 'artifact_sha256', 'observed_paths',
  ];
  if (!isObject(raw) || Object.keys(raw).some((key) => !allowed.includes(key)) ||
      typeof raw.ok !== 'boolean' ||
      !CONTENT_SHA.test(raw.probe_sha256 ?? '') ||
      !CONTENT_SHA.test(raw.artifact_sha256 ?? '') || !Array.isArray(raw.observed_paths) ||
      raw.observed_paths.length > 256 || raw.observed_paths.some((path) => typeof path !== 'string' || !isAbsolute(path))) {
    throw new TypeError('Smoke verification did not return complete digest-bearing observed evidence.');
  }
  if (candidate.action === 'install') {
    const expectedRoot = installResult.managed_install_root;
    if (raw.observed_paths.length === 0 || raw.observed_paths.some((path) => {
      const fromRoot = relative(expectedRoot, resolve(path));
      return fromRoot.startsWith('..') || isAbsolute(fromRoot);
    })) {
      throw new TypeError('Smoke verification observed paths differ from the installed managed artifact root.');
    }
  }
  return deepFreeze({
    ...clone(raw),
    identity: text(raw.identity),
    version: text(raw.version) || null,
    revision: text(raw.revision) || null,
    version_unavailable_reason: text(raw.version_unavailable_reason) || null,
  });
}

export function createProvisionRollbackBroker({
  issuer,
  request,
  repositoryRoot,
  rollback,
} = {}) {
  const requestedRoot = resolve(repositoryRoot ?? '.');
  if (issuer !== 'trusted-cruise-rollback-broker' || !isOpaqueCapabilityRequest(request) ||
      !isAbsolute(repositoryRoot ?? '') || requestedRoot !== capabilityRequestRepositoryRoot(request) ||
      typeof rollback !== 'function') {
    throw new TypeError('Rollback requires the exact request, repository root, and trusted rollback broker.');
  }
  const broker = Object.freeze({ kind: 'cruise-provision-rollback-broker' });
  ROLLBACK_EXECUTION_BROKERS.set(broker, {
    request,
    repository_root: requestedRoot,
    rollback,
  });
  return broker;
}

export async function runProvisionRollback({
  broker,
  request,
  provisionRunId,
  node,
  candidate,
  installResult,
} = {}) {
  const binding = isObject(broker) ? ROLLBACK_EXECUTION_BROKERS.get(broker) : null;
  if (!binding || binding.request !== request || !SAFE_NAME.test(provisionRunId ?? '') ||
      !isObject(node) || !CAPABILITY_ID.test(node.id ?? '') || !isObject(candidate) ||
      candidate.action !== 'install' || candidate.rollback_safe !== true ||
      !text(candidate.rollback_procedure) || !INSTALL_EXECUTION_RESULTS.has(installResult) ||
      !isDirectUseEvaluationForCandidate(candidate.selection_evaluation, candidate) ||
      !isProvisionEffectAuthorization(candidate.effect_authorization, {
        request,
        effectKind: 'install',
        candidate,
      })) {
    throw new TypeError('Rollback requires exact request, candidate, install, and reviewed recovery authority.');
  }
  const canonicalRoot = await realpath(binding.repository_root);
  if (canonicalRoot !== binding.repository_root || installResult.repository_root !== canonicalRoot) {
    throw new TypeError('Rollback repository authority differs from the exact installation root.');
  }
  const managedRoot = installResult.managed_install_root;
  const managedRelative = relative(canonicalRoot, managedRoot);
  if (!managedRelative || managedRelative.startsWith('..') || isAbsolute(managedRelative)) {
    throw new TypeError('Rollback managed root escapes repository authority.');
  }
  const rollbackContractSha256 = stableSha256({
    request_authority_sha256: capabilityRequestAuthorityDigest(request),
    provision_run_id: provisionRunId,
    node_id: node.id,
    candidate: {
      identity: candidate.identity,
      version: text(candidate.version) || null,
      revision: text(candidate.revision) || null,
      rollback_safe: true,
      rollback_procedure_sha256: sha256(text(candidate.rollback_procedure)),
    },
    installation: {
      command_sha256: installResult.command_sha256,
      file_change_log_sha256: installResult.file_change_log_sha256,
      isolation_evidence_sha256: installResult.isolation_evidence_sha256,
      managed_install_root: managedRoot,
    },
  });
  const raw = await binding.rollback({
    capability_request: clone(request),
    provision_run_id: provisionRunId,
    node: sanitizeProvisionMetadata({ id: node.id, capability: node.capability }),
    candidate: sanitizeProvisionMetadata({
      identity: candidate.identity,
      version: text(candidate.version) || null,
      revision: text(candidate.revision) || null,
    }),
    install_result: clone(installResult),
    repository_root: canonicalRoot,
    managed_install_root: managedRoot,
    rollback_procedure: text(candidate.rollback_procedure),
    rollback_contract_sha256: rollbackContractSha256,
    credentials_available: false,
    environment_secrets_available: false,
    public_skill_invocation_allowed: false,
  });
  const allowed = [
    'ok', 'reason', 'rollback_contract_sha256', 'rollback_evidence_sha256',
    'file_change_log_sha256', 'observed_paths',
  ];
  if (!isObject(raw) || Object.keys(raw).some((key) => !allowed.includes(key)) ||
      typeof raw.ok !== 'boolean' || raw.rollback_contract_sha256 !== rollbackContractSha256 ||
      !CONTENT_SHA.test(raw.rollback_evidence_sha256 ?? '') ||
      !CONTENT_SHA.test(raw.file_change_log_sha256 ?? '') || !Array.isArray(raw.observed_paths) ||
      raw.observed_paths.length === 0 || raw.observed_paths.length > 256 ||
      raw.observed_paths.some((path) => {
        if (typeof path !== 'string' || !isAbsolute(path) || path.split(/[\\/]/u).includes('..')) return true;
        const fromManaged = relative(managedRoot, resolve(path));
        return fromManaged.startsWith('..') || isAbsolute(fromManaged);
      })) {
    throw new TypeError('Rollback did not prove the exact contract, managed write set, and recovery evidence.');
  }
  return deepFreeze({
    ok: raw.ok,
    reason: text(raw.reason) || null,
    rollback_contract_sha256: rollbackContractSha256,
    rollback_evidence_sha256: raw.rollback_evidence_sha256,
    file_change_log_sha256: raw.file_change_log_sha256,
    observed_paths: [...raw.observed_paths],
  });
}

function sanitizeProvisionMetadata(value) {
  return JSON.parse(JSON.stringify(value));
}

function deriveDependencyEvidence(treePaths, selected) {
  const dependencyManifest = /(?:^|\/)(?:package\.json|requirements(?:-[^/]+)?\.txt|pyproject\.toml|Pipfile|poetry\.lock|uv\.lock|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum)$/u;
  const lockfile = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|uv\.lock|Cargo\.lock|go\.sum)$/u;
  const manifests = treePaths.filter((path) => dependencyManifest.test(path));
  if (manifests.length === 0) {
    return { count: 0, pinned: true, lockfile_present: true, lifecycle_scripts: [] };
  }
  const selectedByPath = new Map(selected.map((entry) => [entry.original_path, entry.content]));
  let count = 0;
  let pinned = true;
  const lifecycleScripts = [];
  for (const path of manifests) {
    if (!selectedByPath.has(path) || !/(?:^|\/)package\.json$/u.test(path)) {
      return {
        count: null,
        pinned: null,
        lockfile_present: treePaths.some((entry) => lockfile.test(entry)),
        lifecycle_scripts: lifecycleScripts,
      };
    }
    let manifest;
    try {
      manifest = JSON.parse(selectedByPath.get(path));
    } catch {
      return { count: null, pinned: null, lockfile_present: false, lifecycle_scripts: lifecycleScripts };
    }
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const dependencies = isObject(manifest?.[section]) ? manifest[section] : {};
      for (const reference of Object.values(dependencies)) {
        count += 1;
        if (typeof reference !== 'string' || !(
          /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(reference) ||
          /(?:#|@)[a-f0-9]{40,64}$/iu.test(reference)
        )) pinned = false;
      }
    }
    if (isObject(manifest?.scripts)) {
      for (const name of Object.keys(manifest.scripts)) {
        if (/^(?:preinstall|install|postinstall|prepare|prepublish|prepublishOnly)$/u.test(name)) {
          lifecycleScripts.push(`${path}:${name}`);
        }
      }
    }
  }
  return {
    count,
    pinned,
    lockfile_present: count === 0 || treePaths.some((path) => lockfile.test(path)),
    lifecycle_scripts: lifecycleScripts,
  };
}

function normalizeSecuritySignals(metadata, observedAt, dependencyEvidence) {
  const scorecard = isObject(metadata.openssf_scorecard) ? metadata.openssf_scorecard : {};
  const provenance = isObject(metadata.provenance) ? metadata.provenance : {};
  const repository = isObject(metadata.repository_signals) ? metadata.repository_signals : {};
  const dependencies = isObject(metadata.dependency_signals) ? metadata.dependency_signals : {};
  const nullableInteger = (value) => Number.isInteger(value) && value >= 0 ? value : null;
  const nullableBoolean = (value) => typeof value === 'boolean' ? value : null;
  return {
    openssf_scorecard: {
      available: scorecard.available === true,
      score: Number.isFinite(scorecard.score) && scorecard.score >= 0 && scorecard.score <= 10
        ? scorecard.score
        : null,
      checks: Array.isArray(scorecard.checks)
        ? scorecard.checks.filter((entry) => isObject(entry) && text(entry.name)).slice(0, 64).map((entry) => ({
            name: text(entry.name),
            score: Number.isFinite(entry.score) ? entry.score : null,
          }))
        : [],
    },
    provenance: {
      commit_pinned: true,
      signed_release: provenance.signed_release === true,
      attestation_available: provenance.attestation_available === true,
      signature_verified: provenance.signature_verified === true,
    },
    repository: {
      age_days: nullableInteger(repository.age_days ?? metadata.age_days),
      active_maintainers: nullableInteger(repository.active_maintainers ?? metadata.active_maintainers),
      recent_commits: nullableInteger(repository.recent_commits ?? metadata.recent_commits),
      ownership_verified: nullableBoolean(repository.ownership_verified ?? metadata.ownership_verified),
      release_count: nullableInteger(repository.release_count ?? metadata.release_count),
      contributors: nullableInteger(repository.contributors ?? metadata.contributors),
      release_process: text(repository.release_process ?? metadata.release_process) || null,
      security_policy_present: nullableBoolean(
        repository.security_policy_present ?? metadata.security_policy_present,
      ),
      vulnerability_reporting: nullableBoolean(repository.vulnerability_reporting),
      branch_protection_observable: nullableBoolean(repository.branch_protection_observable),
      dependency_update_process: nullableBoolean(repository.dependency_update_process),
    },
    dependencies: {
      count: Math.max(
        nullableInteger(dependencies.count) ?? 0,
        nullableInteger(dependencyEvidence?.count) ?? 0,
      ),
      pinned: [nullableBoolean(dependencies.pinned), nullableBoolean(dependencyEvidence?.pinned)]
        .filter((value) => value !== null).every(Boolean),
      lockfile_present: [
        nullableBoolean(dependencies.lockfile_present),
        nullableBoolean(dependencyEvidence?.lockfile_present),
      ].filter((value) => value !== null).every(Boolean),
      lifecycle_scripts: [...new Set([
        ...(Array.isArray(dependencies.lifecycle_scripts)
          ? stringArray(dependencies.lifecycle_scripts, 'dependency_signals.lifecycle_scripts')
          : []),
        ...(Array.isArray(dependencyEvidence?.lifecycle_scripts)
          ? dependencyEvidence.lifecycle_scripts
          : []),
      ])].slice(0, 64),
      evidence_complete: dependencyEvidence?.count !== null && dependencyEvidence?.pinned !== null,
    },
    source: 'hosting_api_metadata_and_reviewed_tree',
    observed_at: observedAt,
  };
}

export async function acquireExternalCandidate({
  request,
  selection,
  effectAuthorization,
  exclusionSnapshot,
  repository,
  hostingApi,
  selectedPaths = ['SKILL.md'],
  maxFiles = 32,
  maxTreeEntries = 10_000,
  maxTotalBytes = 2 * 1024 * 1024,
  retrievedAt = new Date().toISOString(),
} = {}) {
  validateCapabilityRequest(request);
  const selectionBinding = isObject(selection) ? EXTERNAL_SELECTION_DECISIONS.get(selection) : null;
  const selectedCandidate = selectionBinding?.candidates.find((candidate) => candidate.repository === repository);
  if (!selectionBinding || selectionBinding.request !== request ||
      selectionBinding.inventory.native_candidate_sufficient !== null || !selectedCandidate) {
    throw new TypeError('External acquisition requires the exact opaque native-first selection decision.');
  }
  const effectBinding = requireProvisionEffectAuthorization(effectAuthorization, request, 'acquisition', { repository });
  const exclusion = await requireCurrentExclusionSnapshot(exclusionSnapshot);
  if (exclusion.root !== capabilityRequestRepositoryRoot(request)) {
    throw new TypeError('External acquisition exclusion snapshot belongs to another repository.');
  }
  const hostingBinding = isObject(hostingApi) ? HOSTING_API_BROKERS.get(hostingApi) : null;
  if (!text(repository) || !hostingBinding || !isoTimestamp(retrievedAt)) {
    throw new TypeError('Acquisition needs a canonical repository request and opaque trusted hosting API broker.');
  }
  if (isExcludedCapability({ identity: repository, repository }, exclusion)) {
    throw new TypeError('External acquisition target is currently excluded.');
  }
  const paths = stringArray(selectedPaths, 'selectedPaths');
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 256 ||
      !Number.isInteger(maxTreeEntries) || maxTreeEntries < 1 || maxTreeEntries > 25_000 ||
      !Number.isInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > 16 * 1024 * 1024) {
    throw new TypeError('Acquisition limits must be positive integers within the private review budget.');
  }
  if (paths.length > maxFiles || paths.some((path) => path.startsWith('/') || path.split('/').includes('..'))) {
    throw new TypeError('Selected acquisition paths exceed the file limit or escape the repository tree.');
  }
  const metadata = await hostingBinding.getRepositoryMetadata({ repository });
  if (!isObject(metadata) || !text(metadata.canonical_repository) || !text(metadata.canonical_url)) {
    throw new TypeError('Repository metadata did not establish canonical identity.');
  }
  if (metadata.canonical_repository !== repository) {
    throw new TypeError('Repository metadata canonical identity differs from the authorized acquisition target.');
  }
  const canonicalUrl = normalizeCanonicalRepositoryUrl(
    metadata.canonical_url,
    repository,
    hostingBinding.repository_hosts,
  );
  if (canonicalUrl !== normalizeCanonicalRepositoryUrl(
    selectedCandidate.canonical_url,
    selectedCandidate.repository,
    hostingBinding.repository_hosts,
  )) {
    throw new TypeError('Hosting API canonical URL differs from the native-first selected candidate.');
  }
  if (Number.isInteger(metadata.stars) && metadata.stars_source !== hostingBinding.provider_source) {
    throw new TypeError('Repository star metadata source differs from the trusted hosting API broker.');
  }
  if (isExcludedCapability({
    identity: metadata.canonical_repository,
    repository: metadata.canonical_repository,
  }, exclusion)) {
    throw new TypeError('External acquisition target is currently excluded or rejected.');
  }
  const revision = await hostingBinding.resolveCommit({
    repository: metadata.canonical_repository,
    requested_revision: metadata.default_branch ?? null,
  });
  if (!isObject(revision) || !COMMIT_SHA.test(revision.commit_sha ?? '')) {
    throw new TypeError('Hosting API did not resolve an immutable commit SHA.');
  }
  if (revision.commit_sha !== selectedCandidate.commit_sha) {
    throw new TypeError('Hosting API immutable revision differs from the native-first selected candidate.');
  }
  if (isExcludedCapability({
    identity: metadata.canonical_repository,
    repository: metadata.canonical_repository,
    commitSha: revision.commit_sha,
  }, exclusion)) {
    throw new TypeError('External acquisition revision is currently excluded or rejected.');
  }
  const tree = await hostingBinding.getTree({
    repository: metadata.canonical_repository,
    commit_sha: revision.commit_sha,
    recursive: true,
  });
  if (!Array.isArray(tree) || tree.length > maxTreeEntries) {
    throw new TypeError('Hosting API tree must be a bounded array.');
  }
  const treePaths = tree.map((entry) => text(entry?.path).replaceAll('\\', '/'));
  if (tree.some((entry) => !isObject(entry) || !text(entry.path) ||
      !['file', 'directory', 'symlink', 'submodule', 'git-lfs', 'binary'].includes(text(entry.kind).toLowerCase())) ||
      new Set(treePaths).size !== treePaths.length ||
      treePaths.some((path) => path.startsWith('/') || path.split('/').includes('..') || path.includes('//'))) {
    throw new TypeError('Hosting API tree contains malformed, duplicate, or escaping paths.');
  }
  const treeReview = inspectUntrustedCandidate({
    files: tree.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      size_bytes: entry.size_bytes,
      symlink_target: entry.symlink_target,
      submodule: entry.submodule,
      git_lfs: entry.git_lfs,
      binary: entry.binary,
      executable: entry.executable,
    })),
  });
  if (treeReview.hard_findings.some((finding) =>
    /^(?:symlink|submodule|git_lfs|binary|binary_extension|executable|oversized_or_compressed|unicode_path|conflicting_skill_name):/u.test(finding))) {
    throw new TypeError('Repository tree contains an unreviewable executable, indirection, archive, or path hazard.');
  }
  const executionClosure = treeReview.tree_signals
    .filter((finding) => /^(?:dependency_file|execution_file):/u.test(finding))
    .map((finding) => finding.replace(/^(?:dependency_file|execution_file):/u, ''));
  const unexaminedExecutionClosure = executionClosure.filter((path) => !paths.includes(path));
  const reviewClosure = treeReview.tree_signals.map((finding) =>
    finding.replace(/^(?:dependency_file|execution_file|instruction_file|review_file):/u, ''));
  const unexaminedReviewClosure = reviewClosure.filter((path) => !paths.includes(path));
  const byPath = new Map(tree.map((entry) => [entry.path, entry]));
  const selected = [];
  let totalBytes = 0;
  for (const path of paths) {
    const entry = byPath.get(path);
    if (!isObject(entry) || entry.kind !== 'file' || entry.symlink_target || entry.submodule === true ||
        entry.git_lfs === true || entry.binary === true || /\.(?:zip|tar|tgz|gz|7z|rar)$/iu.test(path)) {
      throw new TypeError(`Selected acquisition path ${path} is absent or unsafe.`);
    }
    if (!Number.isInteger(entry.size_bytes) || entry.size_bytes < 0) {
      throw new TypeError(`Selected acquisition path ${path} has invalid size metadata.`);
    }
    totalBytes += entry.size_bytes;
    if (totalBytes > maxTotalBytes) throw new TypeError('Selected acquisition blobs exceed the byte budget.');
    const blob = await hostingBinding.getBlob({
      repository: metadata.canonical_repository,
      commit_sha: revision.commit_sha,
      path,
    });
    if (!isObject(blob) || typeof blob.content !== 'string') {
      throw new TypeError(`Hosting API blob ${path} is malformed.`);
    }
    if (blob.content.includes('\0') || blob.content.includes('\uFFFD') ||
        /\.(?:node|so|dylib|dll|exe|wasm|jar|class|pyc|o|a)$/iu.test(path)) {
      throw new TypeError(`Hosting API blob ${path} contains unreviewable binary content.`);
    }
    const bytes = Buffer.byteLength(blob.content);
    if (bytes !== entry.size_bytes || bytes + totalBytes - entry.size_bytes > maxTotalBytes) {
      throw new TypeError(`Hosting API blob ${path} does not match bounded tree metadata.`);
    }
    selected.push({
      original_path: path,
      quarantine_name: `${sha256(`${revision.commit_sha}:${path}:${blob.content}`)}.blob`,
      size_bytes: bytes,
      sha256: sha256(blob.content),
      content: blob.content,
    });
  }
  const artifactDigests = selected
    .map((entry) => ({ path: entry.original_path, sha256: entry.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const acquisition = {
      repository: metadata.canonical_repository,
      canonical_url: canonicalUrl,
      commit_sha: revision.commit_sha,
      retrieved_at: retrievedAt,
      stars: Number.isInteger(metadata.stars) ? metadata.stars : null,
      stars_source: text(metadata.stars_source) || null,
      stars_verified: Number.isInteger(metadata.stars) && verifiedHostingApiSource(metadata.stars_source),
      official: metadata.official === true,
      publisher_verified: metadata.publisher_verified === true,
      canonical_identity_verified: true,
      license: text(metadata.license) || null,
      files_examined: selected.map((entry) => entry.original_path),
      content_sha256: sha256(JSON.stringify(artifactDigests)),
      submodules_fetched: false,
      lfs_materialized: false,
      code_executed: false,
      checkout_created: false,
      hooks_executed: false,
      packages_installed: false,
      tree_findings: clone(treeReview.hard_findings),
      tree_signals: clone(treeReview.tree_signals),
      execution_closure_complete: unexaminedExecutionClosure.length === 0,
      unexamined_execution_closure: unexaminedExecutionClosure,
      review_closure_complete: unexaminedReviewClosure.length === 0,
      unexamined_review_closure: unexaminedReviewClosure,
      request_id: request.request.id,
      public_skill: request.request.public_skill,
      security_signals: normalizeSecuritySignals(
        metadata,
        retrievedAt,
        deriveDependencyEvidence(treePaths, selected),
      ),
      hosting_api_source: hostingBinding.provider_source,
    };
  const quarantine = {
      path: `${PRIVATE_CAPABILITY_PATHS.quarantine}${revision.commit_sha}/`,
      blobs: selected.map(({ content: _content, ...entry }) => entry),
      discoverable_skill_files_created: false,
  };
  const result = deepFreeze({ acquisition, quarantine });
  QUARANTINED_BYTES.set(result, {
    binding: deepFreeze({
      request,
      selection,
      request_id: request.request.id,
      public_skill: request.request.public_skill,
      effect_origin_sha256: effectBinding.origin_sha256,
      exclusion_root: exclusion.root,
      exclusion_digest: exclusion.digest,
      acquisition: clone(acquisition),
      quarantine: clone(quarantine),
    }),
    blobs: selected.map((entry) => ({ path: entry.original_path, content: entry.content })),
  });
  return result;
}

export function inspectQuarantinedAcquisition(acquired, { instructionPath = 'SKILL.md' } = {}) {
  const state = QUARANTINED_BYTES.get(acquired);
  if (!state) throw new TypeError('Acquisition handle is unknown or was serialized.');
  const { blobs } = state;
  const instruction = blobs.find((entry) => entry.path === instructionPath);
  const files = blobs.map((entry) => ({
    path: entry.path,
    kind: 'file',
    size_bytes: Buffer.byteLength(entry.content),
    content: entry.content,
  }));
  return inspectUntrustedCandidate({ instructionText: instruction?.content ?? '', files });
}

export function quarantineManifest(acquired) {
  const state = QUARANTINED_BYTES.get(acquired);
  if (!state) throw new TypeError('Quarantine manifest needs an opaque completed acquisition.');
  const { acquisition } = state.binding;
  const { quarantine } = state.binding;
  return {
    repository: acquisition.repository,
    commit_sha: acquisition.commit_sha,
    retrieved_at: acquisition.retrieved_at,
    content_sha256: acquisition.content_sha256,
    execution_closure_complete: acquisition.execution_closure_complete,
    unexamined_execution_closure: clone(acquisition.unexamined_execution_closure),
    review_closure_complete: acquisition.review_closure_complete,
    unexamined_review_closure: clone(acquisition.unexamined_review_closure),
    blobs: quarantine.blobs.map((blob) => ({
      source_path: blob.original_path,
      stored_as: blob.quarantine_name,
      sha256: blob.sha256,
      size_bytes: blob.size_bytes,
    })),
    activated: false,
    code_executed: false,
  };
}

async function ensurePrivateRealDirectory(path) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError(`Quarantine path ${path} must be a real directory.`);
  }
  await chmod(path, 0o700);
}

export async function persistQuarantinedAcquisition(acquired, { root } = {}) {
  const state = QUARANTINED_BYTES.get(acquired);
  if (!state) throw new TypeError('Acquisition handle is unknown or already persisted.');
  const { blobs, binding } = state;
  const commitSha = binding.acquisition.commit_sha;
  if (!COMMIT_SHA.test(commitSha)) throw new TypeError('Bound acquisition commit is invalid.');
  const canonicalRoot = await realpath(resolve(root));
  if (canonicalRoot !== capabilityRequestRepositoryRoot(binding.request) ||
      canonicalRoot !== binding.exclusion_root) {
    throw new TypeError('Quarantine persistence root differs from the acquisition repository authority.');
  }
  const currentExclusion = await readExclusionState(canonicalRoot);
  if (currentExclusion.digest !== binding.exclusion_digest) {
    throw new TypeError('Cruise exclusion or rejected-capability state changed before quarantine persistence.');
  }
  const cruise = join(canonicalRoot, '.cruise');
  const skills = join(cruise, 'skills');
  const quarantine = join(skills, 'quarantine');
  const destination = resolve(quarantine, commitSha);
  if (!destination.startsWith(`${resolve(quarantine)}/`)) {
    throw new TypeError('Quarantine destination escapes the managed root.');
  }
  for (const directory of [cruise, skills, quarantine, destination]) {
    await ensurePrivateRealDirectory(directory);
  }
  const records = [];
  for (const blob of blobs) {
    const metadata = binding.quarantine.blobs.find((entry) => entry.original_path === blob.path);
    if (!metadata || !/^[a-f0-9]{64}\.blob$/u.test(metadata.quarantine_name)) {
      throw new TypeError('Quarantine blob metadata is invalid.');
    }
    const path = join(destination, metadata.quarantine_name);
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(blob.content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    records.push({
      source_path: blob.path,
      stored_as: metadata.quarantine_name,
      sha256: sha256(blob.content),
      size_bytes: Buffer.byteLength(blob.content),
    });
  }
  const manifest = {
    schema_version: 1,
    kind: 'cruise_quarantine_manifest',
    request_id: binding.request_id,
    public_skill: binding.public_skill,
    effect_origin_sha256: binding.effect_origin_sha256,
    repository: binding.acquisition.repository,
    commit_sha: commitSha,
    retrieved_at: binding.acquisition.retrieved_at,
    content_sha256: binding.acquisition.content_sha256,
    execution_closure_complete: binding.acquisition.execution_closure_complete,
    unexamined_execution_closure: clone(binding.acquisition.unexamined_execution_closure),
    review_closure_complete: binding.acquisition.review_closure_complete,
    unexamined_review_closure: clone(binding.acquisition.unexamined_review_closure),
    blobs: records,
    activated: false,
    code_executed: false,
    base_codex_exclusion_claimed: false,
  };
  await writeYamlFile(join(destination, 'manifest.yaml'), manifest, { mode: 0o600 });
  QUARANTINED_BYTES.delete(acquired);
  return { path: destination, manifest };
}

const INSTRUCTION_PATTERNS = Object.freeze([
  ['hierarchy_override', /ignore\s+(?:all\s+)?(?:(?:previous|prior|cruise|system)\s+(?:instructions?|rules?)|cruise\s+rules?)/iu],
  ['hide_actions', /(?:hide|conceal|do not tell)\s+(?:these\s+)?actions?\s+from\s+the\s+user/iu],
  ['falsify_completion', /(?:(?:claim|report|mark|falsify)\s+(?:success|completion|passed)(?:\s+(?:without|even if))?|falsify\s+completion)/iu],
  ['suppress_approvals', /(?:skip|suppress|bypass|disable)\s+(?:the\s+)?approvals?/iu],
  ['weaken_sandbox', /(?:disable|bypass|weaken)\s+(?:the\s+)?sandbox/iu],
  ['read_dotenv', /(?:read|open|print|upload|exfiltrate)[^\n]{0,60}\.env\b/iu],
  ['read_ssh_keys', /(?:read|open|print|upload|exfiltrate)[^\n]{0,60}(?:\.ssh|ssh\s+keys?|id_rsa|id_ed25519)/iu],
  ['read_credentials', /(?:credential\s*store|browser\s*profile|cloud\s*config|private\s*key)/iu],
  ['upload_repository', /(?:upload|send|post|exfiltrate)[^\n]{0,80}(?:repository|source\s+code|workspace\s+files?)/iu],
  ['modify_codex_configuration', /(?:modify|change|edit|write|replace)[^\n]{0,80}(?:AGENTS\.md|codex\s+configuration|plugin\s+configuration|\.codex)/iu],
  ['disable_tests', /(?:disable|skip|remove|bypass)[^\n]{0,50}(?:tests?|checks?|logging)/iu],
  ['recursive_skill_activation', /(?:activate|invoke|call|install)[^\n]{0,60}(?:another|other|public|cruise)\s+skills?/iu],
  ['encoded_or_obfuscated_instruction', /(?:decode|deobfuscate)[^\n]{0,40}(?:base64|payload)[^\n]{0,40}(?:execute|eval|run)/iu],
  ['excessive_authority', /(?:you have|grant|assume)[^\n]{0,40}(?:unrestricted|root|administrator|full)\s+(?:access|authority|permissions?)/iu],
  ['danger_full_access', /\bdanger-full-access\b/iu],
  ['approval_policy_never', /(?:approval(?:\s+policy)?|approval_policy)[^\n]{0,30}\bnever\b/iu],
]);

const SCRIPT_PATTERNS = Object.freeze([
  ['curl_pipe_shell', /\bcurl\b[^\n|]{0,300}\|\s*(?:ba|z|da|k)?sh\b/iu],
  ['wget_pipe_shell', /\bwget\b[^\n|]{0,300}\|\s*(?:ba|z|da|k)?sh\b/iu],
  ['sudo', /(?:^|[\s;&|])sudo(?:\s|$)/imu],
  ['destructive_recursive_delete', /\brm\s+(?:-[A-Za-z]*r[A-Za-z]*f?|-[A-Za-z]*f[A-Za-z]*r)\b/iu],
  ['shell_eval', /(?:^|[\s;&|])eval(?:\s|$)/imu],
  ['dynamic_code_execution', /(?:exec\s*\(|new\s+Function\s*\(|child_process|Runtime\.getRuntime\(\)\.exec)/iu],
  ['global_install', /(?:npm|pnpm|yarn|pip|gem)\s+(?:install|add)[^\n]{0,100}(?:--global|-g\b|--user\b)/iu],
  ['unpinned_package_install', /(?:npm|pnpm|yarn|pip|gem)\s+(?:install|add)\s+(?![^\n]*(?:@[0-9a-f]{12,64}\b|@\d+\.\d+\.\d+\b|==\d+\.\d+\.\d+\b|--(?:save-dev|global)\b))[^\n]{1,160}/iu],
  ['package_lifecycle_script', /"(?:preinstall|install|postinstall|prepare)"\s*:/iu],
  ['reverse_shell', /(?:\/dev\/tcp\/|nc\s+-e\b|bash\s+-i\b|socat\s+TCP)/iu],
  ['shell_startup_modification', /(?:\.bashrc|\.zshrc|\.profile|shell\s+startup)/iu],
  ['git_hook', /(?:\.git\/hooks|core\.hooksPath)/iu],
  ['daemon_start', /(?:systemctl\s+(?:enable|start)|launchctl\s+load|nohup\b)/iu],
  ['undeclared_telemetry', /(?:(?:telemetry|analytics|tracking|usage\s+metrics?)[^\n]{0,80}(?:endpoint|upload|send|collect)|(?:send|collect|upload)[^\n]{0,80}(?:telemetry|analytics|tracking|usage\s+metrics?))/iu],
  ['filesystem_permission_change', /\b(?:chmod|chown)\b[^\n]{0,120}(?:\/etc|\/usr|\/var|\$HOME|~\/)/iu],
  ['credential_extraction', /(?:security\s+find-generic-password|keychain|credential\s+dump|aws_access_key_id)/iu],
  ['process_injection', /(?:ptrace|process_vm_writev|CreateRemoteThread|WriteProcessMemory)/iu],
  ['network_upload', /(?:curl|wget|fetch|requests\.post)[^\n]{0,160}(?:--upload-file|-T\b|POST|files\s*=)/iu],
  ['unexpected_network_access', /(?:\b(?:curl|wget)\b\s+[^\n]{1,240}|\b(?:fetch|axios\.(?:get|post)|requests\.(?:get|post|put|delete)|https?\.request|https?\.get)\s*\()/iu],
  ['persistence_mechanism', /(?:crontab|schtasks|LaunchAgents|Run\\CurrentVersion)/iu],
]);

function scanText(source, prefix = '') {
  const findings = [];
  for (const [id, pattern] of [...INSTRUCTION_PATTERNS, ...SCRIPT_PATTERNS]) {
    if (pattern.test(source)) findings.push(`${prefix}${id}`);
  }
  return findings;
}

function base64Findings(source, budget = { matches: 0, encoded_bytes: 0, decoded_bytes: 0 }) {
  const findings = [];
  const pattern = /[A-Za-z0-9+/]{16,}={0,2}/gu;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const encoded = match[0];
    budget.matches += 1;
    budget.encoded_bytes += Buffer.byteLength(encoded);
    if (budget.matches > 20 || budget.encoded_bytes > 128 * 1024 || encoded.length > 88 * 1024) {
      findings.push('base64:encoded_payload_budget_exceeded');
      break;
    }
    try {
      if (encoded.length % 4 !== 0) continue;
      const decoded = Buffer.from(encoded, 'base64');
      if (decoded.length === 0) continue;
      budget.decoded_bytes += decoded.length;
      if (budget.decoded_bytes > 64 * 1024) {
        findings.push('base64:encoded_payload_budget_exceeded');
        break;
      }
      const value = decoded.toString('utf8');
      const printable = [...value].filter((character) => /[\x20-\x7e\n\r\t]/u.test(character)).length;
      if (printable / Math.max(value.length, 1) < 0.85) continue;
      for (const finding of scanText(value, 'base64:')) findings.push(finding);
      if (/(?:curl|wget|sudo|\/bin\/sh|powershell|Invoke-Expression)/iu.test(value)) {
        findings.push('base64:encoded_shell_payload');
      }
    } catch {
      // Invalid base64 is inert input and is not decoded further.
    }
  }
  return findings;
}

function dependencyManifestFindings(path, source) {
  if (!/(?:^|\/)package\.json$/iu.test(path)) return [];
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    return [`malformed_dependency_manifest:${path}`];
  }
  if (!isObject(manifest)) return [`malformed_dependency_manifest:${path}`];
  const findings = [];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (manifest[field] === undefined) continue;
    if (!isObject(manifest[field])) {
      findings.push(`malformed_dependency_set:${path}:${field}`);
      continue;
    }
    for (const [name, revision] of Object.entries(manifest[field])) {
      const value = text(revision);
      const exactVersion = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value);
      const immutableGit = /(?:#|@)[a-f0-9]{40,64}$/iu.test(value);
      if (!exactVersion && !immutableGit) {
        findings.push(`unpinned_dependency:${path}:${text(name) || 'unnamed'}`);
      }
    }
  }
  return findings;
}

function dependencyOrExecutionTreeSignal(path) {
  if (/(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|requirements(?:-[^/]+)?\.txt|pyproject\.toml|setup\.(?:py|cfg)|poetry\.lock|Pipfile(?:\.lock)?|Cargo\.(?:toml|lock)|Gemfile(?:\.lock)?|go\.(?:mod|sum)|composer\.(?:json|lock))$/iu.test(path)) {
    return `dependency_file:${path}`;
  }
  if (/\.(?:sh|bash|zsh|fish|ps1|bat|cmd|py|pyx|pxd|js|mjs|cjs|jsx|ts|tsx|rb|pl|php|lua|jar|wasm|c|h|cc|cpp|cxx|hh|hpp|hxx|m|mm|rs|go|java|kt|kts|swift|cs|fs|fsx|scala|clj|cljs|ex|exs)$/iu.test(path) ||
      /(?:^|\/)(?:Makefile|Dockerfile|Justfile|Rakefile|CMakeLists\.txt|meson\.build|build\.gradle(?:\.kts)?|compose\.ya?ml)$/iu.test(path)) {
    return `execution_file:${path}`;
  }
  if (/(?:^|\/)(?:SKILL|AGENTS?|README|SECURITY|CONTRIBUTING|CHANGELOG)(?:\.[^/]*)?$/iu.test(path) ||
      /\.(?:md|mdx|rst|txt|adoc|ya?ml|json|toml|xml|html?)$/iu.test(path)) {
    return `instruction_file:${path}`;
  }
  return null;
}

export function inspectUntrustedCandidate({ instructionText = '', files = [] } = {}) {
  if (typeof instructionText !== 'string') throw new TypeError('instructionText must be a string.');
  if (!Array.isArray(files) || files.some((file) => !isObject(file) || !text(file.path))) {
    throw new TypeError('files must contain structured file metadata.');
  }
  const instructionFindings = scanText(instructionText);
  const unicodeFindings = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u.test(instructionText)
    ? ['hidden_unicode_instruction']
    : [];
  const encodedBudget = { matches: 0, encoded_bytes: 0, decoded_bytes: 0 };
  const encodedFindings = base64Findings(instructionText, encodedBudget);
  const structureFindings = [];
  const artifactDigests = [{ path: 'SKILL.md', sha256: sha256(instructionText) }];
  let allExaminedContentHashed = true;
  const skillPaths = files.map((file) => file.path.replaceAll('\\', '/'))
    .filter((path) => /(?:^|\/)SKILL\.md$/u.test(path));
  if (skillPaths.length > 1) {
    for (const path of skillPaths) structureFindings.push(`conflicting_skill_name:${path}`);
  }
  for (const file of files) {
    const kind = text(file.kind).toLowerCase();
    const path = file.path.replaceAll('\\', '/');
    if (path.startsWith('/') || path.split('/').includes('..') || path.includes('//')) {
      structureFindings.push(`unsafe_repository_path:${path}`);
    }
    if (kind === 'symlink' || file.symlink_target) structureFindings.push(`symlink:${path}`);
    if (kind === 'submodule' || path === '.gitmodules') structureFindings.push(`submodule:${path}`);
    if (kind === 'git-lfs' || file.git_lfs === true) structureFindings.push(`git_lfs:${path}`);
    if (kind === 'binary' || file.binary === true) structureFindings.push(`binary:${path}`);
    if (/\.(?:node|so|dylib|dll|exe|wasm|jar|class|pyc|o|a)$/iu.test(path)) {
      structureFindings.push(`binary_extension:${path}`);
    }
    if (file.executable === true) structureFindings.push(`executable:${path}`);
    if (file.size_bytes > 10 * 1024 * 1024 || /\.(?:zip|tar|tgz|gz|7z|rar)$/iu.test(path)) {
      structureFindings.push(`oversized_or_compressed:${path}`);
    }
    if (/(?:^|\/)\.[^/]+$/u.test(path) && !['.github', '.gitignore'].includes(path)) {
      structureFindings.push(`hidden_file:${path}`);
    }
    if (/[^\x00-\x7F]/u.test(path)) structureFindings.push(`unicode_path:${path}`);
    const treeSignal = dependencyOrExecutionTreeSignal(path) ||
      (kind === 'file' ? `review_file:${path}` : null);
    if (treeSignal) structureFindings.push(treeSignal);
    if (typeof file.content === 'string') {
      artifactDigests.push({ path, sha256: sha256(file.content) });
      if (/[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u.test(file.content)) {
        structureFindings.push(`file:${path}:hidden_unicode_instruction`);
      }
      for (const finding of scanText(file.content, `file:${path}:`)) structureFindings.push(finding);
      for (const finding of base64Findings(file.content, encodedBudget)) {
        structureFindings.push(`file:${path}:${finding}`);
      }
      for (const finding of dependencyManifestFindings(path, file.content)) structureFindings.push(finding);
    } else {
      allExaminedContentHashed = false;
    }
  }
  const uniqueArtifactDigests = [...new Map(artifactDigests.map((entry) => [entry.path, entry])).values()]
    .sort((left, right) => left.path.localeCompare(right.path));
  const treeSignals = structureFindings.filter((finding) =>
    finding.startsWith('dependency_file:') || finding.startsWith('execution_file:') ||
    finding.startsWith('instruction_file:') || finding.startsWith('review_file:'));
  const hardFindings = [...new Set([
    ...instructionFindings,
    ...unicodeFindings,
    ...encodedFindings,
    ...structureFindings.filter((finding) =>
      !finding.startsWith('dependency_file:') && !finding.startsWith('execution_file:') &&
      !finding.startsWith('instruction_file:') && !finding.startsWith('review_file:')),
  ])].sort();
  return {
    analysis: {
      declared_purpose: '',
      useful_learning_points: [],
      required_tools: [],
      required_permissions: [],
      verification_methods: [],
      unsafe_instructions: hardFindings.filter((finding) => !finding.includes('prompt_injection')),
      prompt_injection_indicators: hardFindings.filter((finding) =>
        /hierarchy|authority|recursive|hide|falsify|approval|sandbox|config|encoded|unicode/iu.test(finding)),
      technical_errors: [],
      repository_mismatches: [],
      candidate_fit_score: 0,
      confidence: 0,
    },
    instruction_sha256: sha256(instructionText),
    content_sha256: files.length === 0 ? sha256(instructionText) : sha256(JSON.stringify(uniqueArtifactDigests)),
    artifact_digests: uniqueArtifactDigests,
    all_examined_content_hashed: allExaminedContentHashed,
    files_examined: files.map((file) => file.path).sort(),
    hard_findings: hardFindings,
    tree_signals: [...new Set(treeSignals)].sort(),
    security_review_complete: true,
    code_executed: false,
    raw_content_returned: false,
  };
}

export function validateInstructionAnalysis(value) {
  const required = [
    'declared_purpose',
    'useful_learning_points',
    'required_tools',
    'required_permissions',
    'verification_methods',
    'unsafe_instructions',
    'prompt_injection_indicators',
    'technical_errors',
    'repository_mismatches',
    'candidate_fit_score',
    'confidence',
  ];
  if (!isObject(value) || hasRawContent(value) ||
      Object.keys(value).some((key) => !required.includes(key)) ||
      required.some((key) => !(key in value))) {
    throw new TypeError('Instruction analysis must contain only the structured analysis schema.');
  }
  let aggregateBytes = Buffer.byteLength(value.declared_purpose ?? '');
  for (const field of required.slice(1, 9)) {
    const entries = stringArray(value[field], `analysis.${field}`);
    if (entries.length > 64 || entries.some((entry) => Buffer.byteLength(entry) > 4096)) {
      throw new TypeError(`analysis.${field} exceeds the bounded structured-output budget.`);
    }
    aggregateBytes += entries.reduce((sum, entry) => sum + Buffer.byteLength(entry), 0);
  }
  if (typeof value.declared_purpose !== 'string' || !Number.isFinite(value.candidate_fit_score) ||
      Buffer.byteLength(value.declared_purpose) > 4096 || aggregateBytes > 128 * 1024 ||
      value.candidate_fit_score < 0 || value.candidate_fit_score > 100) {
    throw new TypeError('Instruction analysis purpose or fit score is invalid.');
  }
  finiteFraction(value.confidence, 'analysis.confidence');
  return value;
}

const INSTRUCTION_SANDBOX_REQUIREMENTS = Object.freeze({
  target_repository_access: false,
  user_home_access: false,
  credentials_available: false,
  environment_secrets_available: false,
  write_scope: 'dedicated-temporary-result-only',
  external_effect_tools: false,
  network_after_acquisition: false,
  package_installation: false,
  candidate_shell_execution: false,
  candidate_activated: false,
  structured_output_only: true,
});

const EXECUTION_SANDBOX_REQUIREMENTS = Object.freeze({
  disposable: true,
  target_repository_secrets: false,
  ssh_agent: false,
  cloud_credentials: false,
  environment_allowlist_only: true,
  filesystem_restricted: true,
  network_default: 'disabled',
  resource_limits: true,
  time_limit: true,
  privilege_escalation: false,
  sudo: false,
  host_configuration_changes: false,
  unrelated_repository_access: false,
  explicit_writable_directories: true,
  command_logging: true,
  file_change_logging: true,
});

const DIRECT_ACTIVATION_EVIDENCE_KEYS = Object.freeze([
  'allowed',
  'challenge_nonce',
  'context_sha256',
  'observed_at',
  'evidence_sha256',
]);

function unavailableDirectActivationEvidence(reason) {
  return {
    passed: false,
    reason,
    evidence_sha256: null,
    context_sha256: null,
    observed_at: null,
    authority_sha256: null,
  };
}

function probeDirectActivationEvidence({
  brokerBinding,
  kind,
  requirements,
  baseline,
  phase,
  useContextSha256,
} = {}) {
  if (!brokerBinding || !isObject(baseline?.profile) || !SAFE_NAME.test(phase ?? '') ||
      !CONTENT_SHA.test(useContextSha256 ?? '')) {
    return unavailableDirectActivationEvidence('invalid_activation_probe_context');
  }
  const context = {
    schema_version: 1,
    purpose: 'direct-external-activation',
    phase,
    kind,
    isolation_id: baseline.isolation_id,
    enforcement_kind: baseline.enforcement_kind,
    requirements_sha256: stableSha256(requirements),
    profile_sha256: stableSha256(baseline.profile),
    use_context_sha256: useContextSha256,
  };
  const challenge = {
    nonce: randomBytes(32).toString('hex'),
    context: clone(context),
    context_sha256: stableSha256(context),
  };
  let observation;
  try {
    observation = brokerBinding.probe({
      kind,
      requirements: clone(requirements),
      direct_activation_challenge: clone(challenge),
    });
  } catch {
    return unavailableDirectActivationEvidence('activation_probe_failed');
  }
  if (observation && typeof observation.then === 'function') {
    return unavailableDirectActivationEvidence('activation_probe_must_be_synchronous');
  }
  const profile = observation?.profile;
  if (!isObject(profile) || stableSha256(profile) !== context.profile_sha256 ||
      observation?.isolation_id !== baseline.isolation_id ||
      observation?.enforcement_kind !== baseline.enforcement_kind ||
      !isoTimestamp(observation?.observed_at) || !CONTENT_SHA.test(observation?.probe_sha256 ?? '')) {
    return unavailableDirectActivationEvidence('activation_probe_boundary_drift');
  }
  const structural = verifySandbox(profile, requirements, kind);
  if (!structural.enforced) {
    return unavailableDirectActivationEvidence('activation_probe_boundary_drift');
  }
  const direct = observation.direct_activation;
  if (!isObject(direct) || Object.keys(direct).length !== DIRECT_ACTIVATION_EVIDENCE_KEYS.length ||
      Object.keys(direct).some((key) => !DIRECT_ACTIVATION_EVIDENCE_KEYS.includes(key)) ||
      direct.allowed !== true || direct.challenge_nonce !== challenge.nonce ||
      direct.context_sha256 !== challenge.context_sha256 ||
      direct.observed_at !== observation.observed_at || !CONTENT_SHA.test(direct.evidence_sha256 ?? '')) {
    return unavailableDirectActivationEvidence('explicit_live_activation_evidence_required');
  }
  const evidencePayload = {
    schema_version: 1,
    direct_external_activation_allowed: true,
    challenge_nonce: challenge.nonce,
    context_sha256: challenge.context_sha256,
    observed_at: observation.observed_at,
    isolation_id: observation.isolation_id,
    enforcement_kind: observation.enforcement_kind,
    profile_sha256: context.profile_sha256,
    technical_probe_sha256: observation.probe_sha256,
  };
  if (direct.evidence_sha256 !== stableSha256(evidencePayload)) {
    return unavailableDirectActivationEvidence('activation_evidence_digest_mismatch');
  }
  return {
    passed: true,
    reason: 'challenge_bound_live_activation_probe',
    evidence_sha256: direct.evidence_sha256,
    context_sha256: challenge.context_sha256,
    observed_at: observation.observed_at,
    authority_sha256: stableSha256({
      ...evidencePayload,
      phase,
      use_context_sha256: useContextSha256,
    }),
  };
}

function revalidateDirectActivationEvidence(attestationToken, { phase, useContextSha256 } = {}) {
  const attestation = isObject(attestationToken) ? HOST_SANDBOX_ATTESTATIONS.get(attestationToken) : null;
  if (!attestation || attestation.direct_activation_initial?.passed !== true) {
    return unavailableDirectActivationEvidence('initial_live_activation_evidence_required');
  }
  return probeDirectActivationEvidence({
    brokerBinding: attestation.broker,
    kind: attestation.kind,
    requirements: attestation.requirements,
    baseline: attestation.baseline,
    phase,
    useContextSha256,
  });
}

function verifySandbox(profile, requirements, kind) {
  const attestation = isObject(profile) ? HOST_SANDBOX_ATTESTATIONS.get(profile) : null;
  const observedProfile = attestation?.profile ?? profile;
  if (!isObject(observedProfile)) {
    return { kind, enforced: false, technically_attested: false, missing: Object.keys(requirements) };
  }
  const missing = Object.entries(requirements)
    .filter(([key, expected]) => observedProfile[key] !== expected)
    .map(([key]) => key);
  return {
    kind,
    enforced: missing.length === 0,
    technically_attested: missing.length === 0 && Boolean(attestation),
    attestation_digest: attestation?.digest ?? null,
    broker_probe_digest: attestation?.broker_probe_digest ?? null,
    broker_direct_activation_allowed: attestation?.direct_activation_initial?.passed === true,
    direct_activation_evidence_sha256: attestation?.direct_activation_initial?.evidence_sha256 ?? null,
    direct_activation_context_sha256: attestation?.direct_activation_initial?.context_sha256 ?? null,
    direct_activation_observed_at: attestation?.direct_activation_initial?.observed_at ?? null,
    missing,
  };
}

export function createProvisionIsolationBroker({
  issuer,
  probe,
  analyzeInstructions,
  evaluateBehavior,
} = {}) {
  if (issuer !== 'trusted-host-isolation-broker' || typeof probe !== 'function' ||
      typeof analyzeInstructions !== 'function' || typeof evaluateBehavior !== 'function') {
    throw new TypeError('Provision isolation broker requires trusted probe, instruction-analysis, and behavior-evaluation adapters.');
  }
  const broker = Object.freeze({ kind: 'cruise-provision-isolation-broker' });
  HOST_ISOLATION_BROKERS.set(broker, {
    probe,
    analyzeInstructions,
    evaluateBehavior,
  });
  return broker;
}

export function createHostSandboxAttestation({ kind, broker } = {}) {
  const requirements = kind === 'instruction-analysis'
    ? INSTRUCTION_SANDBOX_REQUIREMENTS
    : kind === 'execution'
      ? EXECUTION_SANDBOX_REQUIREMENTS
      : null;
  const brokerBinding = isObject(broker) ? HOST_ISOLATION_BROKERS.get(broker) : null;
  if (!requirements || !brokerBinding) {
    throw new TypeError('Host sandbox attestation needs an opaque trusted broker and a supported kind.');
  }
  const observation = brokerBinding.probe({ kind, requirements: clone(requirements) });
  if (observation && typeof observation.then === 'function') {
    throw new TypeError('Host sandbox technical probe must complete synchronously before attestation.');
  }
  const profile = observation?.profile;
  if (!isObject(profile) || !text(observation?.isolation_id) || !text(observation?.observed_at) ||
      !isoTimestamp(observation?.observed_at) ||
      !text(observation?.enforcement_kind) || !CONTENT_SHA.test(observation?.probe_sha256 ?? '')) {
    throw new TypeError('Host isolation broker did not return complete technical probe evidence.');
  }
  const structural = verifySandbox(profile, requirements, kind);
  if (!structural.enforced) throw new TypeError(`Host sandbox profile is missing: ${structural.missing.join(', ')}`);
  const baseline = {
    profile: clone(profile),
    isolation_id: observation.isolation_id,
    enforcement_kind: observation.enforcement_kind,
  };
  const baseAttestationSha256 = stableSha256({ kind, profile, observation });
  const directActivationInitial = probeDirectActivationEvidence({
    brokerBinding,
    kind,
    requirements,
    baseline,
    phase: 'attestation',
    useContextSha256: baseAttestationSha256,
  });
  const token = Object.freeze({
    kind,
    isolation_id: observation.isolation_id,
    observed_at: observation.observed_at,
    enforcement_kind: observation.enforcement_kind,
  });
  HOST_SANDBOX_ATTESTATIONS.set(token, {
    profile: clone(profile),
    digest: stableSha256({
      base_attestation_sha256: baseAttestationSha256,
      direct_activation_authority_sha256: directActivationInitial.authority_sha256,
    }),
    broker_probe_digest: observation.probe_sha256,
    direct_activation_initial: deepFreeze(directActivationInitial),
    baseline: deepFreeze(baseline),
    kind,
    requirements: deepFreeze(clone(requirements)),
    broker: brokerBinding,
  });
  return token;
}

async function requireCurrentAcquisitionExclusion(acquisitionState, exclusionSnapshot) {
  const exclusion = await requireCurrentExclusionSnapshot(exclusionSnapshot);
  if (acquisitionState.binding.exclusion_root !== exclusion.root ||
      acquisitionState.binding.exclusion_digest !== exclusion.digest) {
    throw new TypeError('Acquisition exclusion authority changed before candidate review.');
  }
  const acquisition = acquisitionState.binding.acquisition;
  if (isExcludedCapability({
    identity: acquisition.repository,
    repository: acquisition.repository,
    commitSha: acquisition.commit_sha,
    contentSha256: acquisition.content_sha256,
  }, exclusion)) {
    throw new TypeError('Acquired capability is currently excluded or rejected.');
  }
  return exclusion;
}

export async function runInstructionSandboxAnalysis({
  acquired,
  instructionSandbox,
  exclusionSnapshot,
} = {}) {
  const acquisitionState = QUARANTINED_BYTES.get(acquired);
  const attestation = isObject(instructionSandbox) ? HOST_SANDBOX_ATTESTATIONS.get(instructionSandbox) : null;
  const boundary = verifyInstructionAnalysisSandbox(instructionSandbox);
  if (!acquisitionState || !attestation || !boundary.enforced || !boundary.technically_attested) {
    throw new TypeError('Instruction analysis requires opaque quarantined bytes and a technically attested boundary.');
  }
  await requireCurrentAcquisitionExclusion(acquisitionState, exclusionSnapshot);
  const raw = await attestation.broker.analyzeInstructions({
    candidate: acquisitionState.blobs.map(({ path, content }) => ({ path, content })),
    candidate_content_sha256: acquisitionState.binding.acquisition.content_sha256,
    structured_output_only: true,
    public_skill_invocation_allowed: false,
    external_effects_allowed: false,
  });
  validateInstructionAnalysis(raw);
  const result = deepFreeze({
    analysis: clone(raw),
    content_sha256: acquisitionState.binding.acquisition.content_sha256,
    sandbox_attestation_sha256: boundary.attestation_digest,
    raw_candidate_content_exported: false,
  });
  INSTRUCTION_SANDBOX_ANALYSES.set(result, {
    acquired,
    content_sha256: acquisitionState.binding.acquisition.content_sha256,
  });
  return result;
}

export async function runExternalBehaviorEvaluation({
  request,
  acquired,
  candidate = {},
  instructionAnalysis,
  executionSandbox,
  exclusionSnapshot,
} = {}) {
  validateCapabilityRequest(request);
  const acquisitionState = QUARANTINED_BYTES.get(acquired);
  const attestation = isObject(executionSandbox) ? HOST_SANDBOX_ATTESTATIONS.get(executionSandbox) : null;
  const boundary = verifyExecutionSandbox(executionSandbox);
  if (!acquisitionState || !attestation || !boundary.enforced || !boundary.technically_attested) {
    throw new TypeError('Behavior evaluation requires opaque quarantined bytes and a technically attested execution boundary.');
  }
  await requireCurrentAcquisitionExclusion(acquisitionState, exclusionSnapshot);
  if (acquisitionState.binding.request !== request ||
      acquisitionState.binding.request_id !== request.request.id ||
      acquisitionState.binding.public_skill !== request.request.public_skill) {
    throw new TypeError('Behavior evaluation requires the exact opaque request bound to acquisition authority.');
  }
  const acquiredMetadata = acquisitionState.binding.acquisition;
  const activation = reviewExternalActivationPlan(candidate, acquiredMetadata);
  const analysisBinding = isObject(instructionAnalysis)
    ? INSTRUCTION_SANDBOX_ANALYSES.get(instructionAnalysis)
    : null;
  const staticReview = inspectQuarantinedAcquisition(acquired);
  const isolatedFindings = analysisBinding?.acquired === acquired &&
      analysisBinding.content_sha256 === acquiredMetadata.content_sha256
    ? [
        ...instructionAnalysis.analysis.unsafe_instructions,
        ...instructionAnalysis.analysis.prompt_injection_indicators,
        ...instructionAnalysis.analysis.technical_errors,
        ...instructionAnalysis.analysis.repository_mismatches,
      ]
    : ['missing_or_mismatched_instruction_analysis'];
  const dependencySignals = acquiredMetadata.security_signals.dependencies;
  const dependencyHardFinding = dependencySignals.evidence_complete !== true ||
    dependencySignals.lifecycle_scripts.length > 0 ||
    (Number.isInteger(dependencySignals.count) && dependencySignals.count > 0 &&
      (dependencySignals.pinned !== true || dependencySignals.lockfile_present !== true));
  if (staticReview.content_sha256 !== acquiredMetadata.content_sha256 ||
      acquiredMetadata.tree_findings.length > 0 || staticReview.hard_findings.length > 0 ||
      isolatedFindings.length > 0 || dependencyHardFinding ||
      acquiredMetadata.execution_closure_complete !== true ||
      acquiredMetadata.review_closure_complete !== true) {
    throw new TypeError(
      'Behavior evaluation is forbidden until static review, isolated instruction analysis, and review/execution closure pass.',
    );
  }
  if (!activation.passed) {
    throw new TypeError('Behavior evaluation is forbidden until the exact Cruise-managed activation command passes review.');
  }
  const raw = await attestation.broker.evaluateBehavior({
    candidate: acquisitionState.blobs.map(({ path, content }) => ({ path, content })),
    candidate_content_sha256: acquisitionState.binding.acquisition.content_sha256,
    network_allowed: false,
    credentials_available: false,
    public_skill_invocation_allowed: false,
    capability_request: clone(request),
    activation_command: clone(activation.command),
    activation_command_sha256: activation.command_sha256,
    managed_install_root: activation.managed_install_root,
    expected_write_paths: clone(activation.expected_write_paths),
  });
  if (!isObject(raw) || Object.keys(raw).some((key) => ![
    'representative_eval_passed',
    'sandbox_smoke_test_passed',
    'evidence_sha256',
    'command_log_sha256',
    'file_change_log_sha256',
    'required_permissions',
    'license_compatible',
    'license_evidence_sha256',
    'fit',
  ].includes(key)) || raw.representative_eval_passed !== true ||
      raw.sandbox_smoke_test_passed !== true || !CONTENT_SHA.test(raw.evidence_sha256 ?? '') ||
      !CONTENT_SHA.test(raw.command_log_sha256 ?? '') || !CONTENT_SHA.test(raw.file_change_log_sha256 ?? '') ||
      raw.license_compatible !== true || !CONTENT_SHA.test(raw.license_evidence_sha256 ?? '') ||
      !isObject(raw.fit)) {
    throw new TypeError('Execution sandbox did not return complete passing behavior evidence.');
  }
  const fit = evaluateCapabilityFit({
    scores: raw.fit.scores,
    confidence: raw.fit.confidence,
    consequenceLevel: request.request.task.consequence_level,
    baselineExpectedSuccess: raw.fit.baseline_expected_success,
    candidateExpectedSuccess: raw.fit.candidate_expected_success,
    minimumImprovementRequired: request.request.gap.minimum_improvement_required,
    representativeEvalPassed: true,
    mandatoryCompetencyMissing: raw.fit.mandatory_competency_missing === true,
    hardDisqualifier: false,
  });
  const result = deepFreeze({
    representative_eval_passed: true,
    sandbox_smoke_test_passed: true,
    evidence_sha256: raw.evidence_sha256,
    command_log_sha256: raw.command_log_sha256,
    file_change_log_sha256: raw.file_change_log_sha256,
    required_permissions: stringArray(raw.required_permissions ?? [], 'behavior.required_permissions'),
    license_compatible: true,
    license_evidence_sha256: raw.license_evidence_sha256,
    fit,
    content_sha256: acquisitionState.binding.acquisition.content_sha256,
    activation_command_sha256: activation.command_sha256,
    managed_install_root: activation.managed_install_root,
    sandbox_attestation_sha256: boundary.attestation_digest,
    raw_candidate_content_exported: false,
  });
  EXTERNAL_BEHAVIOR_EVALUATIONS.set(result, {
    acquired,
    request,
    instructionAnalysis,
    content_sha256: acquisitionState.binding.acquisition.content_sha256,
    activation_command_sha256: activation.command_sha256,
    managed_install_root: activation.managed_install_root,
  });
  return result;
}

export function verifyInstructionAnalysisSandbox(profile) {
  return verifySandbox(profile, INSTRUCTION_SANDBOX_REQUIREMENTS, 'instruction-analysis');
}

export function verifyExecutionSandbox(profile) {
  return verifySandbox(profile, EXECUTION_SANDBOX_REQUIREMENTS, 'execution');
}

export function classifyCandidateTrust(candidate, { allowlist = [] } = {}) {
  if (!isObject(candidate)) throw new TypeError('Candidate trust input must be an object.');
  const securityFindings = stringArray(candidate.security_findings ?? [], 'candidate.security_findings');
  let tier;
  if (securityFindings.length > 0 || candidate.license_compatible === false || candidate.provenance_defect === true) {
    tier = 'rejected';
  } else if (!text(candidate.license) || candidate.canonical_identity_verified !== true ||
      !COMMIT_SHA.test(candidate.commit_sha ?? '')) {
    tier = 'uncertain';
  } else if (candidate.official === true && candidate.publisher_verified === true) {
    tier = 'official';
  } else {
    const exactAllowlist = allowlist.some((entry) => isObject(entry) &&
      entry.repository === candidate.repository &&
      entry.owner === candidate.repository.split('/')[0] &&
      entry.capability === candidate.identity &&
      entry.installation_path === candidate.install_scope &&
      COMMIT_SHA.test(entry.commit_sha ?? '') && entry.commit_sha === candidate.commit_sha &&
      CONTENT_SHA.test(entry.content_sha256 ?? '') && entry.content_sha256 === candidate.content_sha256 &&
      text(entry.release_process) && entry.release_process === candidate.release_process);
    if (exactAllowlist) tier = 'allowlisted';
    else if (
      candidate.community_unofficial === true &&
      candidate.stars_verified === true &&
      Number.isInteger(candidate.stars) &&
      candidate.stars >= COMMUNITY_DIRECT_USE_THRESHOLD_STARS &&
      verifiedHostingApiSource(candidate.stars_source) &&
      isoTimestamp(candidate.stars_evaluated_at) &&
      candidate.canonical_identity_verified === true
    ) tier = 'established-community';
    else tier = 'uncertain';
  }
  return {
    tier,
    stars_at_evaluation: Number.isInteger(candidate.stars) ? candidate.stars : null,
    stars_source: text(candidate.stars_source) || null,
    stars_evaluated_at: text(candidate.stars_evaluated_at) || null,
    publisher_verified: candidate.publisher_verified === true,
    allowlisted: tier === 'allowlisted',
    security_review_complete: candidate.security_review_complete === true,
    direct_install_eligible: false,
    learning_only: tier === 'uncertain',
  };
}

export function evaluateCapabilityFit({
  scores = {},
  confidence = 0,
  consequenceLevel = 'normal',
  baselineExpectedSuccess = 0,
  candidateExpectedSuccess = 0,
  minimumImprovementRequired = 0.1,
  representativeEvalPassed = false,
  mandatoryCompetencyMissing = false,
  hardDisqualifier = false,
} = {}) {
  if (!isObject(scores)) throw new TypeError('Fit scores must be an object.');
  const normalized = {};
  for (const [field, maximum] of Object.entries(FIT_SCORE_FIELDS)) {
    const score = scores[field] ?? 0;
    if (!Number.isFinite(score) || score < 0 || score > maximum) {
      throw new TypeError(`${field} must be between 0 and ${maximum}.`);
    }
    normalized[field] = score;
  }
  const aggregate = Object.values(normalized).reduce((sum, value) => sum + value, 0);
  const confidenceValue = finiteFraction(confidence, 'fit confidence');
  const baseline = finiteFraction(baselineExpectedSuccess, 'baseline expected success');
  const candidate = finiteFraction(candidateExpectedSuccess, 'candidate expected success');
  const minimumDelta = finiteFraction(minimumImprovementRequired, 'minimum improvement required');
  const delta = candidate - baseline;
  const high = ['high', 'critical'].includes(consequenceLevel);
  const gate = high ? FIT_GATES.high : FIT_GATES.normal;
  const critical = Object.entries(FIT_GATES.critical_minima)
    .map(([field, minimum]) => ({ field, minimum, observed: normalized[field], passed: normalized[field] >= minimum }));
  const required = {
    no_hard_disqualifier: !hardDisqualifier,
    no_missing_mandatory_competency: !mandatoryCompetencyMissing,
    positive_delta_over_baseline: delta >= minimumDelta,
    representative_eval_passed: representativeEvalPassed === true,
  };
  const passed = aggregate >= gate.aggregate && confidenceValue >= gate.confidence &&
    critical.every((entry) => entry.passed) && Object.values(required).every(Boolean);
  return {
    aggregate,
    aggregate_minimum: gate.aggregate,
    confidence: confidenceValue,
    confidence_minimum: gate.confidence,
    scores: normalized,
    critical_minima: critical,
    baseline: { configuration: 'base_codex_plus_repository_instructions', expected_success: baseline },
    candidate: { expected_success: candidate, expected_delta: delta },
    required,
    passed,
  };
}

function pinnedInstallReference(value) {
  const normalized = text(value);
  return /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(normalized) || COMMIT_SHA.test(normalized);
}

function reviewExternalActivationPlan(candidate, acquisition) {
  const action = candidate.activation_action ?? 'install';
  const identity = text(candidate.identity);
  const version = text(candidate.version) || null;
  const installScope = text(candidate.install_scope) || 'repository-local';
  const rollbackSafe = action === 'use' || candidate.rollback_safe === true;
  const rollbackProcedure = action === 'install' ? text(candidate.rollback_procedure) : null;
  const rawCommand = candidate.install_command ?? candidate.command ?? null;
  let command = null;
  let commandStructured = action === 'use' && rawCommand === null;
  let commandSafe = commandStructured;
  let targetPinned = action === 'use';
  let installerTrusted = action === 'use';
  let lifecycleScriptsSuppressed = action === 'use';
  let installerBinding = null;
  let managedInstallRoot = null;
  if (action === 'install' && isObject(rawCommand) &&
      Object.keys(rawCommand).every((key) => ['file', 'args'].includes(key)) &&
      /^[A-Za-z0-9._/+@:-]+$/u.test(rawCommand.file ?? '') &&
      Array.isArray(rawCommand.args) && rawCommand.args.every((argument) => typeof argument === 'string')) {
    command = { file: rawCommand.file, args: [...rawCommand.args] };
    commandStructured = true;
    installerBinding = isObject(candidate.installer_attestation)
      ? TRUSTED_INSTALLER_ATTESTATIONS.get(candidate.installer_attestation)
      : null;
    const canonicalUrl = acquisition.canonical_url.replace(/\.git$/u, '');
    const immutableTargets = new Set([
      `${canonicalUrl}#${acquisition.commit_sha}`,
      `${canonicalUrl}.git#${acquisition.commit_sha}`,
      `${canonicalUrl}@${acquisition.commit_sha}`,
      `${canonicalUrl}.git@${acquisition.commit_sha}`,
      `git+${canonicalUrl}#${acquisition.commit_sha}`,
      `git+${canonicalUrl}.git#${acquisition.commit_sha}`,
      `git+${canonicalUrl}@${acquisition.commit_sha}`,
      `git+${canonicalUrl}.git@${acquisition.commit_sha}`,
    ]);
    const commandReview = assessProvisionInstallCommand(command, {
      installerAttestation: candidate.installer_attestation,
      identity,
      immutableTargets: [...immutableTargets],
    });
    installerTrusted = isTrustedInstallerAttestationForCommand(candidate.installer_attestation, command);
    lifecycleScriptsSuppressed = command.args.includes('--ignore-scripts');
    commandSafe = commandReview.passed;
    managedInstallRoot = commandReview.managed_root;
    targetPinned = pinnedInstallReference(version) && Boolean(commandReview.immutable_target);
  }
  const checks = {
    supported_action: ['install', 'use'].includes(action),
    identity_bound: Boolean(identity),
    exact_repository_local_scope: installScope === 'repository-local',
    command_structured: commandStructured,
    command_safe: commandSafe,
    trusted_installer: installerTrusted,
    lifecycle_scripts_suppressed: lifecycleScriptsSuppressed,
    immutable_target_pinned: targetPinned,
    rollback_declared: action === 'use' || (rollbackSafe && Boolean(rollbackProcedure)),
  };
  const plan = {
    action,
    identity,
    version,
    install_scope: installScope,
    command,
    command_sha256: command ? stableSha256(command) : null,
    installer_path: installerBinding?.resolved_path ?? null,
    installer_sha256: installerBinding?.file_sha256 ?? null,
    managed_install_root: managedInstallRoot,
    expected_write_paths: managedInstallRoot ? [managedInstallRoot] : [],
    rollback_safe: action === 'install' ? rollbackSafe : null,
    rollback_procedure_sha256: rollbackProcedure ? sha256(rollbackProcedure) : null,
    checks,
    passed: Object.values(checks).every(Boolean),
  };
  return plan;
}

export function evaluateExternalCandidate({
  request,
  acquired,
  candidate = {},
  instructionSandbox,
  executionSandbox,
  instructionAnalysis,
  behaviorEvaluation,
  fit,
  allowlist = [],
  allowlistSnapshot = null,
  nativeEquivalentAvailable,
} = {}) {
  validateCapabilityRequest(request);
  if (!isObject(candidate)) throw new TypeError('External candidate must be an object.');
  if (fit !== undefined) {
    throw new TypeError('External fit evidence must come from the opaque behavior evaluation, not the caller.');
  }
  if (nativeEquivalentAvailable !== undefined) {
    throw new TypeError('External evaluation derives native-first authority from the opaque acquisition; caller booleans are forbidden.');
  }
  if (Array.isArray(allowlist) && allowlist.length > 0) {
    throw new TypeError('External evaluation rejects caller-authored allowlists; use an opaque trust snapshot.');
  }
  const allowlistBinding = isObject(allowlistSnapshot)
    ? TRUST_ALLOWLIST_SNAPSHOTS.get(allowlistSnapshot)
    : null;
  if (allowlistSnapshot !== null && allowlistBinding?.request !== request) {
    throw new TypeError('External evaluation trust snapshot belongs to another capability request.');
  }
  const trustedAllowlist = allowlistBinding?.entries ?? [];
  const acquisitionState = QUARANTINED_BYTES.get(acquired);
  if (!acquisitionState || acquisitionState.binding.request !== request ||
      acquisitionState.binding.request_id !== request.request.id ||
      acquisitionState.binding.public_skill !== request.request.public_skill) {
    throw new TypeError(
      'External evaluation requires an opaque acquisition bound to this capability request; it must match the exact capability request.',
    );
  }
  const acquiredMetadata = acquisitionState.binding.acquisition;
  for (const [field, expected] of [
    ['repository', acquiredMetadata.repository],
    ['canonical_url', acquiredMetadata.canonical_url],
    ['commit_sha', acquiredMetadata.commit_sha],
  ]) {
    if (text(candidate[field]) && candidate[field] !== expected) {
      throw new TypeError(`Candidate ${field} conflicts with the immutable acquisition.`);
    }
  }
  const staticReview = inspectQuarantinedAcquisition(acquired);
  staticReview.hard_findings = [...new Set([
    ...acquiredMetadata.tree_findings,
    ...staticReview.hard_findings,
  ])].sort();
  staticReview.tree_signals = [...new Set([
    ...acquiredMetadata.tree_signals,
    ...staticReview.tree_signals,
  ])].sort();
  if (staticReview.content_sha256 !== acquiredMetadata.content_sha256) {
    throw new TypeError('Static review bytes do not match the immutable acquisition digest.');
  }
  const instructionBoundary = verifyInstructionAnalysisSandbox(instructionSandbox);
  const executionBoundary = verifyExecutionSandbox(executionSandbox);
  const instructionAnalysisBinding = INSTRUCTION_SANDBOX_ANALYSES.get(instructionAnalysis);
  const behaviorBinding = EXTERNAL_BEHAVIOR_EVALUATIONS.get(behaviorEvaluation);
  const instructionAnalysisValid = instructionAnalysisBinding?.acquired === acquired &&
    instructionAnalysisBinding.content_sha256 === acquiredMetadata.content_sha256 &&
    instructionAnalysis?.sandbox_attestation_sha256 === instructionBoundary.attestation_digest;
  const activation = reviewExternalActivationPlan(candidate, acquiredMetadata);
  const behaviorEvaluationValid = behaviorBinding?.acquired === acquired &&
    behaviorBinding.request === request &&
    behaviorBinding.instructionAnalysis === instructionAnalysis &&
    behaviorBinding.content_sha256 === acquiredMetadata.content_sha256 &&
    behaviorBinding.activation_command_sha256 === activation.command_sha256 &&
    behaviorBinding.managed_install_root === activation.managed_install_root &&
    behaviorEvaluation?.sandbox_attestation_sha256 === executionBoundary.attestation_digest;
  const trust = classifyCandidateTrust({
    ...candidate,
    repository: acquiredMetadata.repository,
    canonical_url: acquiredMetadata.canonical_url,
    commit_sha: acquiredMetadata.commit_sha,
    stars: acquiredMetadata.stars,
    stars_source: acquiredMetadata.stars_source,
    stars_evaluated_at: acquiredMetadata.retrieved_at,
    stars_verified: acquiredMetadata.stars_verified,
    official: acquiredMetadata.official,
    publisher_verified: acquiredMetadata.publisher_verified,
    canonical_identity_verified: acquiredMetadata.canonical_identity_verified,
    license: acquiredMetadata.license,
    identity: text(candidate.identity) || acquiredMetadata.repository,
    install_scope: text(candidate.install_scope) || 'repository-local',
    content_sha256: acquiredMetadata.content_sha256,
    release_process: acquiredMetadata.security_signals.repository.release_process,
    security_findings: staticReview.hard_findings,
    security_review_complete: staticReview.security_review_complete,
  }, { allowlist: trustedAllowlist });
  const fitResult = behaviorEvaluationValid
    ? clone(behaviorEvaluation.fit)
    : evaluateCapabilityFit({
        consequenceLevel: request.request.task.consequence_level,
        minimumImprovementRequired: request.request.gap.minimum_improvement_required,
        representativeEvalPassed: false,
        hardDisqualifier: trust.tier === 'rejected',
      });
  if (trust.tier === 'rejected') {
    fitResult.required.no_hard_disqualifier = false;
    fitResult.passed = false;
  }
  const pinnedAndHashed = COMMIT_SHA.test(acquiredMetadata.commit_sha) &&
    staticReview.all_examined_content_hashed === true && CONTENT_SHA.test(acquiredMetadata.content_sha256) &&
    acquiredMetadata.execution_closure_complete === true &&
    acquiredMetadata.review_closure_complete === true;
  const requiredPermissions = behaviorEvaluationValid
    ? canonicalStrings(behaviorEvaluation.required_permissions)
    : [];
  const approvedPermissions = canonicalStrings(request.request.constraints.permissions);
  const permissionsProportionate = requiredPermissions.every((permission) => approvedPermissions.includes(permission));
  const localScope = request.request.constraints.maximum_install_scope === 'repository-local' &&
    activation.install_scope === 'repository-local';
  const securityEligible = staticReview.hard_findings.length === 0 &&
    instructionBoundary.enforced && instructionBoundary.technically_attested && instructionAnalysisValid &&
    instructionAnalysis.analysis.unsafe_instructions.length === 0 &&
    instructionAnalysis.analysis.prompt_injection_indicators.length === 0 &&
    instructionAnalysis.analysis.technical_errors.length === 0 &&
    instructionAnalysis.analysis.repository_mismatches.length === 0;
  const isolatedAnalysisHardFinding = instructionAnalysisValid && [
    ...instructionAnalysis.analysis.unsafe_instructions,
    ...instructionAnalysis.analysis.prompt_injection_indicators,
    ...instructionAnalysis.analysis.technical_errors,
    ...instructionAnalysis.analysis.repository_mismatches,
  ].length > 0;
  const activationHardFinding = activation.checks.supported_action !== true ||
    activation.checks.command_structured !== true || activation.checks.command_safe !== true ||
    activation.checks.trusted_installer !== true || activation.checks.lifecycle_scripts_suppressed !== true ||
    activation.checks.immutable_target_pinned !== true ||
    activation.checks.exact_repository_local_scope !== true;
  const dependencySignals = acquiredMetadata.security_signals.dependencies;
  const dependencyHardFinding = dependencySignals.evidence_complete !== true ||
    dependencySignals.lifecycle_scripts.length > 0 ||
    (Number.isInteger(dependencySignals.count) && dependencySignals.count > 0 &&
      (dependencySignals.pinned !== true || dependencySignals.lockfile_present !== true));
  if (isolatedAnalysisHardFinding || activationHardFinding || dependencyHardFinding || !permissionsProportionate) {
    trust.tier = 'rejected';
    fitResult.required.no_hard_disqualifier = false;
    fitResult.passed = false;
  }
  const maintenanceCredible = Number.isInteger(acquiredMetadata.security_signals.repository.active_maintainers) &&
    acquiredMetadata.security_signals.repository.active_maintainers > 0 &&
    Number.isInteger(acquiredMetadata.security_signals.repository.recent_commits) &&
    acquiredMetadata.security_signals.repository.recent_commits > 0 &&
    Boolean(acquiredMetadata.security_signals.repository.release_process);
  const ownershipCredible = acquiredMetadata.security_signals.repository.ownership_verified === true;
  const provenanceCredible = acquiredMetadata.security_signals.provenance.attestation_available === true ||
    (acquiredMetadata.security_signals.provenance.signed_release === true &&
      acquiredMetadata.security_signals.provenance.signature_verified === true);
  const directActivationUseContextSha256 = stableSha256({
    request_authority_sha256: capabilityRequestAuthorityDigest(request),
    acquisition_content_sha256: acquiredMetadata.content_sha256,
    activation_command_sha256: activation.command_sha256,
    behavior_evidence_sha256: behaviorEvaluationValid ? behaviorEvaluation.evidence_sha256 : null,
    instruction_sandbox_attestation_sha256: instructionBoundary.attestation_digest,
    execution_sandbox_attestation_sha256: executionBoundary.attestation_digest,
  });
  const directPrerequisites =
    ['official', 'allowlisted', 'established-community'].includes(trust.tier) &&
    securityEligible && executionBoundary.enforced && executionBoundary.technically_attested &&
    instructionBoundary.broker_direct_activation_allowed === true &&
    executionBoundary.broker_direct_activation_allowed === true &&
    pinnedAndHashed && fitResult.passed && behaviorEvaluationValid &&
    behaviorEvaluation.representative_eval_passed === true &&
    behaviorEvaluation.sandbox_smoke_test_passed === true &&
    permissionsProportionate && behaviorEvaluation.license_compatible === true && activation.passed &&
    maintenanceCredible && ownershipCredible && provenanceCredible &&
    localScope;
  const instructionActivationEvidence = directPrerequisites
    ? revalidateDirectActivationEvidence(instructionSandbox, {
        phase: 'candidate-evaluation',
        useContextSha256: directActivationUseContextSha256,
      })
    : unavailableDirectActivationEvidence('direct_activation_prerequisites_failed');
  const executionActivationEvidence = directPrerequisites
    ? revalidateDirectActivationEvidence(executionSandbox, {
        phase: 'candidate-evaluation',
        useContextSha256: directActivationUseContextSha256,
      })
    : unavailableDirectActivationEvidence('direct_activation_prerequisites_failed');
  const directEligible = directPrerequisites && instructionActivationEvidence.passed === true &&
    executionActivationEvidence.passed === true;
  const directActivationAuthoritySha256 = directEligible
    ? stableSha256({
        use_context_sha256: directActivationUseContextSha256,
        instruction_analysis: instructionActivationEvidence.authority_sha256,
        execution: executionActivationEvidence.authority_sha256,
      })
    : null;
  trust.direct_install_eligible = directEligible;
  trust.learning_only = trust.tier !== 'rejected' && !directEligible;
  let decision = 'not_selected';
  if (trust.tier === 'rejected') decision = 'rejected';
  else if (directEligible) decision = 'direct_use_eligible';
  else if (trust.tier === 'uncertain' || !instructionBoundary.enforced ||
      !instructionBoundary.technically_attested || !executionBoundary.enforced ||
      !executionBoundary.technically_attested || !instructionAnalysisValid ||
      !behaviorEvaluationValid || acquiredMetadata.execution_closure_complete !== true ||
      acquiredMetadata.review_closure_complete !== true) decision = 'learning_only';
  const result = {
    request_id: request.request.id,
    public_skill: request.request.public_skill,
    authority_binding: {
      origin_sha256: acquisitionState.binding.effect_origin_sha256,
      approved_permissions: clone(request.request.constraints.permissions),
      required_permissions: clone(requiredPermissions),
      maximum_install_scope: request.request.constraints.maximum_install_scope,
      approved_install_scope: activation.install_scope,
    },
    decision,
    trust,
    acquisition: {
      identity: text(candidate.identity) || acquiredMetadata.repository,
      repository: acquiredMetadata.repository,
      canonical_url: acquiredMetadata.canonical_url,
      commit_sha: acquiredMetadata.commit_sha,
      retrieved_at: acquiredMetadata.retrieved_at,
      stars: acquiredMetadata.stars,
      license: acquiredMetadata.license,
      files_examined: staticReview.files_examined,
      execution_closure_complete: acquiredMetadata.execution_closure_complete,
      unexamined_execution_closure: clone(acquiredMetadata.unexamined_execution_closure),
      review_closure_complete: acquiredMetadata.review_closure_complete,
      unexamined_review_closure: clone(acquiredMetadata.unexamined_review_closure),
      content_sha256: acquiredMetadata.content_sha256,
      submodules_fetched: false,
      lfs_materialized: false,
      code_executed: false,
    },
    static_review: staticReview,
    instruction_analysis: instructionAnalysisValid ? clone(instructionAnalysis) : null,
    behavior_evaluation: behaviorEvaluationValid ? clone(behaviorEvaluation) : null,
    activation,
    sandboxes: { instruction_analysis: instructionBoundary, execution: executionBoundary },
    direct_activation_authority: {
      passed: directEligible,
      use_context_sha256: directActivationUseContextSha256,
      authority_sha256: directActivationAuthoritySha256,
      instruction_analysis: clone(instructionActivationEvidence),
      execution: clone(executionActivationEvidence),
    },
    fit: fitResult,
    security_signals: clone(acquiredMetadata.security_signals),
    raw_candidate_instructions_exposed: false,
  };
  const frozen = deepFreeze(result);
  REVIEWED_EVALUATIONS.add(frozen);
  REVIEWED_EVALUATION_REQUESTS.set(frozen, request);
  EVALUATION_RAW_MATERIAL.set(frozen, acquisitionState.blobs.map(({ content }) => content));
  if (directEligible) {
    ELIGIBLE_EVALUATIONS.add(frozen);
    DIRECT_ACTIVATION_EVALUATIONS.set(frozen, {
      instruction_sandbox: instructionSandbox,
      execution_sandbox: executionSandbox,
      use_context_sha256: directActivationUseContextSha256,
      authority_sha256: directActivationAuthoritySha256,
    });
  }
  return frozen;
}

function isOpaqueDirectUseEvaluation(value) {
  const binding = isObject(value) ? DIRECT_ACTIVATION_EVALUATIONS.get(value) : null;
  return Boolean(binding && ELIGIBLE_EVALUATIONS.has(value) &&
    value.decision === 'direct_use_eligible' && value.trust?.direct_install_eligible === true &&
    value.direct_activation_authority?.passed === true &&
    value.direct_activation_authority?.use_context_sha256 === binding.use_context_sha256 &&
    value.direct_activation_authority?.authority_sha256 === binding.authority_sha256);
}

function revalidateDirectUseEvaluation(value, { candidate = null } = {}) {
  const binding = DIRECT_ACTIVATION_EVALUATIONS.get(value);
  if (!binding) return false;
  const useContextSha256 = stableSha256({
    phase: candidate ? 'candidate-activation-use' : 'activation-use',
    evaluation_authority_sha256: binding.authority_sha256,
    evaluation_use_context_sha256: binding.use_context_sha256,
    candidate_contract_sha256: candidate
      ? stableSha256({
          action: candidate.action,
          identity: candidate.identity,
          repository: candidate.repository,
          source: candidate.source,
          reviewed_commit_sha: candidate.reviewed_commit_sha,
          content_sha256: candidate.content_sha256,
          version: text(candidate.version) || null,
          install_scope: candidate.install_scope,
          command_sha256: candidate.command ? stableSha256(candidate.command) : null,
          rollback_safe: candidate.rollback_safe === true,
          rollback_procedure_sha256: sha256(text(candidate.rollback_procedure)),
        })
      : null,
  });
  const instructionEvidence = revalidateDirectActivationEvidence(binding.instruction_sandbox, {
    phase: candidate ? 'candidate-activation-use' : 'activation-use',
    useContextSha256,
  });
  if (instructionEvidence.passed !== true) return false;
  const executionEvidence = revalidateDirectActivationEvidence(binding.execution_sandbox, {
    phase: candidate ? 'candidate-activation-use' : 'activation-use',
    useContextSha256,
  });
  return executionEvidence.passed === true;
}

export function isDirectUseEvaluation(value) {
  return isOpaqueDirectUseEvaluation(value) && revalidateDirectUseEvaluation(value);
}

export function isDirectUseEvaluationForCandidate(value, candidate) {
  if (!isOpaqueDirectUseEvaluation(value) || !isObject(candidate)) return false;
  const installerBinding = isObject(candidate.installer_attestation)
    ? TRUSTED_INSTALLER_ATTESTATIONS.get(candidate.installer_attestation)
    : null;
  const exactCandidate = value.acquisition.identity === candidate.identity &&
    value.acquisition.repository === candidate.repository &&
    value.acquisition.canonical_url === candidate.source &&
    value.acquisition.commit_sha === candidate.reviewed_commit_sha &&
    value.acquisition.content_sha256 === candidate.content_sha256 &&
    value.activation.action === candidate.action &&
    value.activation.version === (text(candidate.version) || null) &&
    value.activation.install_scope === candidate.install_scope &&
    value.activation.command_sha256 === (candidate.command ? stableSha256(candidate.command) : null) &&
    value.activation.installer_sha256 === (candidate.action === 'install' ? installerBinding?.file_sha256 : null) &&
    value.activation.rollback_safe === (candidate.action === 'install' ? candidate.rollback_safe === true : null) &&
    value.activation.rollback_procedure_sha256 === (candidate.action === 'install'
      ? sha256(text(candidate.rollback_procedure))
      : null) &&
    (candidate.action !== 'install' || isTrustedInstallerAttestationForCommand(
      candidate.installer_attestation,
      candidate.command,
    ));
  return exactCandidate && revalidateDirectUseEvaluation(value, { candidate });
}

export function extractLearningOnly({ evaluation, licenseReview = '' } = {}) {
  if (!isObject(evaluation) || !REVIEWED_EVALUATIONS.has(evaluation) ||
      evaluation.decision !== 'learning_only' || evaluation.trust?.tier !== 'uncertain') {
    throw new TypeError('Learning extraction is allowed only for an uncertain learning-only candidate.');
  }
  const rawMaterials = EVALUATION_RAW_MATERIAL.get(evaluation);
  const reviewedAnalysis = evaluation.instruction_analysis?.analysis;
  if (!isObject(reviewedAnalysis) || !Array.isArray(rawMaterials) || hasRawContent(reviewedAnalysis) ||
      containsRawMaterial(reviewedAnalysis, rawMaterials) ||
      stringLeaves(reviewedAnalysis).some((entry) => scanText(entry).length > 0 || base64Findings(entry).length > 0)) {
    throw new TypeError('Learning extraction accepts reviewed structured points, never raw candidate content.');
  }
  if (evaluation.sandboxes?.instruction_analysis?.technically_attested !== true) {
    throw new TypeError('Learning extraction requires a technically enforced instruction-analysis sandbox.');
  }
  const normalizedLicenseReview = text(licenseReview) || 'copying forbidden; concepts only';
  if (Buffer.byteLength(normalizedLicenseReview) > 512 ||
      containsRawMaterial([normalizedLicenseReview], rawMaterials) ||
      scanText(normalizedLicenseReview).length > 0 ||
      base64Findings(normalizedLicenseReview).length > 0 ||
      /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u.test(normalizedLicenseReview)) {
    throw new TypeError('Learning extraction license review must be bounded reviewed metadata, never raw candidate content.');
  }
  const retained = {
    methodologies: stringArray(reviewedAnalysis.useful_learning_points ?? [], 'useful_learning_points'),
    verification_patterns: stringArray(reviewedAnalysis.verification_methods ?? [], 'verification_methods'),
    failure_modes: stringArray(reviewedAnalysis.technical_errors ?? [], 'technical_errors'),
    domain_checks: [],
    useful_examples: [],
  };
  const result = {
    learning_extraction: {
      source: {
        repository: evaluation.acquisition.repository,
        request_id: evaluation.request_id,
        commit_sha: evaluation.acquisition.commit_sha,
        content_sha256: evaluation.acquisition.content_sha256,
        license: evaluation.acquisition.license,
        stars: evaluation.acquisition.stars,
      },
      retained,
      discarded: {
        unsafe_instructions: [...new Set([
          ...evaluation.static_review.hard_findings,
          ...stringArray(reviewedAnalysis.unsafe_instructions ?? [], 'unsafe_instructions'),
          ...stringArray(reviewedAnalysis.prompt_injection_indicators ?? [], 'prompt_injection_indicators'),
        ])],
        irrelevant_workflows: [],
        unsupported_tools: [],
        repository_mismatches: stringArray(reviewedAnalysis.repository_mismatches ?? [], 'repository_mismatches'),
        executable_components: [],
      },
      copying_allowed: false,
      raw_candidate_content_exported: false,
      license_review: normalizedLicenseReview,
    },
  };
  const frozen = deepFreeze(result);
  REVIEWED_LEARNING_EXTRACTIONS.add(frozen);
  LEARNING_EXTRACTION_RAW_MATERIAL.set(frozen, [...rawMaterials]);
  LEARNING_EXTRACTION_REQUESTS.set(frozen, REVIEWED_EVALUATION_REQUESTS.get(evaluation));
  return frozen;
}

export function createLocalSpinRecord({
  id,
  generatedAt,
  repositoryScope,
  sourceRequest,
  capabilityRequest,
  learningExtraction,
  retainedConcepts = [],
  evaluationResults = {},
  existingNames = [],
} = {}) {
  if (!LOCAL_SKILL_NAME.test(id ?? '') || !id.startsWith('cruise-local-')) {
    throw new TypeError('A local spin needs a new cruise-local-* skill name.');
  }
  if (canonicalStrings(existingNames).includes(id.toLowerCase())) {
    throw new TypeError('A local spin name must be unique in the repository.');
  }
  if (!isOpaqueCapabilityRequest(capabilityRequest) || !REQUEST_ID.test(sourceRequest ?? '') ||
      capabilityRequest.request.id !== sourceRequest || !text(repositoryScope) ||
      resolve(repositoryScope) !== capabilityRequestRepositoryRoot(capabilityRequest) || !isoTimestamp(generatedAt)) {
    throw new TypeError('A local spin needs request, repository scope, and generation time.');
  }
  if (!isObject(learningExtraction) || !REVIEWED_LEARNING_EXTRACTIONS.has(learningExtraction)) {
    throw new TypeError('A local spin requires an opaque reviewed learning extraction.');
  }
  if (LEARNING_EXTRACTION_REQUESTS.get(learningExtraction) !== capabilityRequest) {
    throw new TypeError('A local spin requires the exact CAPREQ that authorized its learning extraction.');
  }
  const source = learningExtraction.learning_extraction?.source;
  if (!isObject(source) || !COMMIT_SHA.test(source.commit_sha ?? '') || !CONTENT_SHA.test(source.content_sha256 ?? '')) {
    throw new TypeError('A local spin needs immutable learning-source provenance.');
  }
  if (source.request_id !== sourceRequest) {
    throw new TypeError('A local spin source request must match the opaque learning extraction.');
  }
  const concepts = stringArray(retainedConcepts, 'retainedConcepts');
  const reviewedConcepts = new Set(canonicalStrings(stringLeaves(learningExtraction.learning_extraction.retained)));
  const rawMaterials = LEARNING_EXTRACTION_RAW_MATERIAL.get(learningExtraction);
  if (!Array.isArray(rawMaterials) || concepts.some((concept) => !reviewedConcepts.has(concept.toLowerCase())) ||
      containsRawMaterial(concepts, rawMaterials)) {
    throw new TypeError('A local spin may retain only independently reviewed learning concepts.');
  }
  const requiredEvaluations = [
    'trigger',
    'non_trigger',
    'prompt_injection',
    'repository_fit',
    'tool_boundary',
    'write_scope',
    'secret_access_denial',
    'network_denial',
    'representative_fixture',
    'stable_outputs',
    'fit_scorecard',
    'baseline_improvement',
    'caller_compatibility',
    'authority_non_override',
  ];
  const missing = requiredEvaluations.filter((name) => evaluationResults[name] !== true);
  const result = {
    local_skill: {
      id,
      generated_at: generatedAt,
      repository_scope: repositoryScope,
      source_request: sourceRequest,
      path: `${PRIVATE_CAPABILITY_PATHS.adapted}${id}/`,
      required_files: [
        'SKILL.md',
        'provenance.yaml',
        'LEARNING-SOURCES.md',
        'SECURITY-REVIEW.md',
        'evals/',
        'references/',
      ],
    },
    sources: [{
      repository: source.repository,
      commit_sha: source.commit_sha,
      content_sha256: source.content_sha256,
      trust_tier: 'uncertain',
      usage: 'learning-points-only',
    }],
    construction: {
      copied_executable_code: false,
      copied_instruction_text: false,
      independently_authored: true,
      license_review: learningExtraction.learning_extraction.license_review,
      retained_concepts: concepts,
    },
    evaluations: {
      required: requiredEvaluations,
      missing,
      passed: missing.length === 0,
    },
    activation_eligible: missing.length === 0,
  };
  const frozen = deepFreeze(result);
  LOCAL_SPIN_RAW_MATERIAL.set(frozen, [...rawMaterials]);
  LOCAL_SPIN_REQUESTS.set(frozen, capabilityRequest);
  return frozen;
}

export function createLocalSpinEvaluationBroker({ issuer, evaluate } = {}) {
  if (issuer !== 'trusted-cruise-local-evaluation-broker' || typeof evaluate !== 'function') {
    throw new TypeError('Local-spin evaluation broker requires the trusted Cruise issuer and evaluator.');
  }
  const broker = Object.freeze({ kind: 'cruise-local-spin-evaluation-broker' });
  LOCAL_SPIN_EVALUATION_BROKERS.set(broker, { evaluate });
  return broker;
}

async function collectLocalSpinTree(root, relativePath = '', output = [], budget = {
  bytes: 0,
  directories: 0,
}, depth = 0) {
  if (output.length > LOCAL_SPIN_MAX_FILES || budget.bytes > LOCAL_SPIN_MAX_TOTAL_BYTES) {
    throw new TypeError('Local spin tree exceeds the bounded file or aggregate-byte budget.');
  }
  if (depth > LOCAL_SPIN_MAX_DEPTH) {
    throw new TypeError('Local spin tree exceeds the bounded directory-depth budget.');
  }
  if (Buffer.byteLength(relativePath, 'utf8') > LOCAL_SPIN_MAX_RELATIVE_PATH_BYTES) {
    throw new TypeError('Local spin tree exceeds the bounded relative-path budget.');
  }
  const directory = relativePath ? join(root, relativePath) : root;
  const directoryMetadata = await lstat(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() ||
      await realpath(directory) !== directory) {
    throw new TypeError(`Local spin directory is linked, special, or non-canonical: ${relativePath || '.'}.`);
  }
  budget.directories += 1;
  if (budget.directories > LOCAL_SPIN_MAX_DIRECTORIES) {
    throw new TypeError('Local spin tree exceeds the bounded directory-count budget.');
  }
  const directoryHandle = await opendir(directory);
  for await (const entry of directoryHandle) {
    const relative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (Buffer.byteLength(relative, 'utf8') > LOCAL_SPIN_MAX_RELATIVE_PATH_BYTES) {
      throw new TypeError(`Local spin path exceeds the bounded relative-path budget: ${relative}.`);
    }
    if (entry.name.startsWith('.') || entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
      throw new TypeError(`Local spin contains a hidden, linked, or special entry: ${relative}.`);
    }
    if (entry.isDirectory()) {
      await collectLocalSpinTree(root, relative, output, budget, depth + 1);
      continue;
    }
    if (output.length >= LOCAL_SPIN_MAX_FILES) {
      throw new TypeError('Local spin tree exceeds the bounded file budget.');
    }
    const path = join(root, relative);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o111) !== 0 || metadata.size > 2 * 1024 * 1024) {
      throw new TypeError(`Local spin file is executable, linked, special, or oversized: ${relative}.`);
    }
    budget.bytes += metadata.size;
    if (budget.bytes > LOCAL_SPIN_MAX_TOTAL_BYTES) {
      throw new TypeError('Local spin tree exceeds the bounded aggregate-byte budget.');
    }
    const bytes = await readFile(path);
    if (bytes.length !== metadata.size) {
      throw new TypeError(`Local spin file changed during bounded review: ${relative}.`);
    }
    if (bytes.includes(0)) throw new TypeError(`Local spin binary content is forbidden: ${relative}.`);
    output.push({ path: relative, kind: 'file', content: bytes.toString('utf8'), sha256: sha256(bytes) });
  }
  return output;
}

export async function validateLocalSpinOnDisk(localSpin, {
  root,
  exclusions = [],
  exclusionSnapshot,
  evaluationBroker,
} = {}) {
  if (!isObject(localSpin) || localSpin.activation_eligible !== true || localSpin.evaluations?.passed !== true) {
    throw new TypeError('Local spin record has not passed its declared evaluation set.');
  }
  const evaluationBinding = isObject(evaluationBroker)
    ? LOCAL_SPIN_EVALUATION_BROKERS.get(evaluationBroker)
    : null;
  if (!evaluationBinding) {
    throw new TypeError('Local spin activation requires an opaque trusted evaluation broker.');
  }
  const canonicalRoot = await realpath(resolve(root));
  const currentExclusion = await requireCurrentExclusionSnapshot(exclusionSnapshot);
  if (currentExclusion.root !== canonicalRoot) {
    throw new TypeError('Local spin exclusion snapshot belongs to another repository.');
  }
  if (canonicalStrings([
    ...stringArray(exclusions, 'exclusions'),
    ...currentExclusion.entries,
  ]).includes(localSpin.local_skill.id.toLowerCase())) {
    throw new TypeError('Local spin is excluded from validation and activation.');
  }
  if (await realpath(resolve(localSpin.local_skill.repository_scope)) !== canonicalRoot ||
      localSpin.local_skill.path !== `${PRIVATE_CAPABILITY_PATHS.adapted}${localSpin.local_skill.id}/`) {
    throw new TypeError('Local spin repository scope or managed path is invalid.');
  }
  const expectedRoot = resolve(canonicalRoot, localSpin.local_skill.path);
  const relative = expectedRoot.slice(canonicalRoot.length);
  if (!relative.startsWith('/') || relative.includes('/../')) {
    throw new TypeError('Local spin path escapes the repository root.');
  }
  const metadata = await lstat(expectedRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new TypeError('Local spin root must be a real directory.');
  }
  if (await realpath(expectedRoot) !== expectedRoot) {
    throw new TypeError('Local spin root canonical path differs from its managed path.');
  }
  const expectedRootEntries = new Set([
    'SKILL.md',
    'provenance.yaml',
    'LEARNING-SOURCES.md',
    'SECURITY-REVIEW.md',
    'evals',
    'references',
  ]);
  const actualRootEntries = await readdir(expectedRoot, { withFileTypes: true });
  if (actualRootEntries.length !== expectedRootEntries.size ||
      actualRootEntries.some((entry) => !expectedRootEntries.has(entry.name))) {
    throw new TypeError('Local spin root contains missing or unexpected artifacts.');
  }
  const treeFiles = await collectLocalSpinTree(expectedRoot);
  const capabilityRequest = LOCAL_SPIN_REQUESTS.get(localSpin);
  if (!isOpaqueCapabilityRequest(capabilityRequest) ||
      capabilityRequestRepositoryRoot(capabilityRequest) !== canonicalRoot) {
    throw new TypeError('Local spin validation requires its exact repository-bound CAPREQ.');
  }
  const byPath = new Map(treeFiles.map((entry) => [entry.path, entry]));
  for (const required of ['SKILL.md', 'provenance.yaml', 'LEARNING-SOURCES.md', 'SECURITY-REVIEW.md', 'evals/results.yaml']) {
    if (!byPath.has(required)) throw new TypeError(`Local spin ${required} must be a regular file.`);
  }
  const skill = byPath.get('SKILL.md').content;
  if (!skill.startsWith(`---\nname: ${localSpin.local_skill.id}\n`)) {
    throw new TypeError('Local spin SKILL.md name does not match its unique id.');
  }
  for (const name of ['LEARNING-SOURCES.md', 'SECURITY-REVIEW.md']) {
    const content = byPath.get(name).content;
    if (!content.trim()) {
      throw new TypeError(`Local spin ${name} must contain reviewed evidence.`);
    }
  }
  const provenance = await readYamlFile(join(expectedRoot, 'provenance.yaml'));
  const source = localSpin.sources[0];
  if (provenance?.local_skill?.id !== localSpin.local_skill.id ||
      provenance?.local_skill?.generated_at !== localSpin.local_skill.generated_at ||
      await realpath(resolve(provenance?.local_skill?.repository_scope ?? '')) !== canonicalRoot ||
      provenance?.local_skill?.source_request !== localSpin.local_skill.source_request ||
      provenance?.sources?.[0]?.repository !== source.repository ||
      provenance?.sources?.[0]?.commit_sha !== source.commit_sha ||
      provenance?.sources?.[0]?.content_sha256 !== source.content_sha256 ||
      provenance?.sources?.[0]?.usage !== 'learning-points-only' ||
      provenance?.construction?.copied_executable_code !== false ||
      provenance?.construction?.copied_instruction_text !== false ||
      provenance?.construction?.independently_authored !== true ||
      JSON.stringify(provenance?.construction?.retained_concepts ?? []) !==
        JSON.stringify(localSpin.construction.retained_concepts)) {
    throw new TypeError('Local spin provenance does not match the immutable construction record.');
  }
  const localStaticReview = inspectUntrustedCandidate({
    instructionText: skill,
    files: treeFiles.filter(({ path }) => path !== 'SKILL.md'),
  });
  if (localStaticReview.hard_findings.length > 0) {
    throw new TypeError(`Local spin static security review failed: ${localStaticReview.hard_findings.join(', ')}`);
  }
  const rawMaterials = LOCAL_SPIN_RAW_MATERIAL.get(localSpin);
  if (!Array.isArray(rawMaterials) || containsRawMaterial(treeFiles, rawMaterials)) {
    throw new TypeError('Local spin copies raw quarantined material.');
  }
  const resultsPath = join(expectedRoot, 'evals', 'results.yaml');
  const results = await readYamlFile(resultsPath);
  const brokerResults = await evaluationBinding.evaluate({
    local_spin_root: expectedRoot,
    repository_root: canonicalRoot,
    local_skill_id: localSpin.local_skill.id,
    required_evaluations: [...localSpin.evaluations.required],
    network_allowed: false,
    secrets_available: false,
    external_effects_allowed: false,
    public_skill_invocation_allowed: false,
  });
  if (!isObject(brokerResults) || !Array.isArray(brokerResults.results) ||
      brokerResults.results.length !== localSpin.evaluations.required.length) {
    throw new TypeError('Trusted local-spin evaluator returned an incomplete result set.');
  }
  const brokerByName = new Map(brokerResults.results.map((entry) => [entry?.evaluation, entry]));
  const evalsRoot = resolve(expectedRoot, 'evals');
  const expectedEvalFiles = new Set(['evals/results.yaml']);
  for (const evaluation of localSpin.evaluations.required) {
    const result = results?.results?.[evaluation];
    const observed = brokerByName.get(evaluation);
    if (result?.passed !== true || !CONTENT_SHA.test(result?.evidence_sha256 ?? '') ||
        !text(result?.evidence_path) || result.evidence_path.includes('/') || result.evidence_path.includes('\\')) {
      throw new TypeError(`Local spin evaluation ${evaluation} lacks passing hashed evidence.`);
    }
    if (!isObject(observed) || observed.evaluation !== evaluation || observed.passed !== true ||
        observed.evidence_path !== result.evidence_path ||
        observed.evidence_sha256 !== result.evidence_sha256 ||
        !CONTENT_SHA.test(observed.runner_sha256 ?? '') || !isoTimestamp(observed.observed_at) ||
        !Array.isArray(observed.assertions) || observed.assertions.length === 0 ||
        observed.assertions.some((entry) => !text(entry)) || observed.repository_root !== canonicalRoot ||
        observed.network_accessed !== false || observed.secrets_accessed !== false ||
        observed.external_effects_performed !== false) {
      throw new TypeError(`Local spin evaluation ${evaluation} lacks trusted observed semantics.`);
    }
    const evidencePath = resolve(evalsRoot, result.evidence_path);
    if (!evidencePath.startsWith(`${evalsRoot}/`)) {
      throw new TypeError(`Local spin evaluation ${evaluation} evidence escapes evals/.`);
    }
    const evidenceMetadata = await lstat(evidencePath);
    if (!evidenceMetadata.isFile() || evidenceMetadata.isSymbolicLink() ||
        sha256(await readFile(evidencePath)) !== result.evidence_sha256) {
      throw new TypeError(`Local spin evaluation ${evaluation} evidence digest does not match disk bytes.`);
    }
    expectedEvalFiles.add(`evals/${result.evidence_path}`);
  }
  if (treeFiles.some(({ path }) => path.startsWith('evals/') && !expectedEvalFiles.has(path))) {
    throw new TypeError('Local spin evals/ contains unreferenced or unexpected evidence.');
  }
  const adaptedRoot = resolve(canonicalRoot, PRIVATE_CAPABILITY_PATHS.adapted);
  const siblingNames = (await readdir(adaptedRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name.toLowerCase());
  if (siblingNames.filter((name) => name === localSpin.local_skill.id.toLowerCase()).length !== 1) {
    throw new TypeError('Local spin name is not unique in the repository adaptation inventory.');
  }
  const artifactDigest = stableSha256(treeFiles.map(({ path, sha256: digest }) => ({ path, sha256: digest })));
  VALIDATED_LOCAL_SPINS.add(localSpin);
  LOCAL_SPIN_VALIDATION_PROOFS.set(localSpin, deepFreeze({
    repository_root: canonicalRoot,
    artifact_digest: artifactDigest,
    evaluated_at: new Date().toISOString(),
    evaluation_runner_sha256: stableSha256(brokerResults.results.map(({ evaluation, runner_sha256 }) => ({
      evaluation,
      runner_sha256,
    }))),
    request: capabilityRequest,
    request_authority_sha256: capabilityRequestAuthorityDigest(capabilityRequest),
  }));
  return localSpin;
}

export function isValidatedLocalSpin(value) {
  return isObject(value) && VALIDATED_LOCAL_SPINS.has(value) &&
    LOCAL_SPIN_VALIDATION_PROOFS.has(value) && value.activation_eligible === true;
}

export function isValidatedLocalSpinForRequest(value, request) {
  const proof = isObject(value) ? LOCAL_SPIN_VALIDATION_PROOFS.get(value) : null;
  return isOpaqueCapabilityRequest(request) && isValidatedLocalSpin(value) && proof?.request === request &&
    proof.request_authority_sha256 === capabilityRequestAuthorityDigest(request);
}

export async function revalidateLocalSpinForActivation(localSpin, { request } = {}) {
  const proof = isObject(localSpin) ? LOCAL_SPIN_VALIDATION_PROOFS.get(localSpin) : null;
  if (!isOpaqueCapabilityRequest(request) || !proof || !VALIDATED_LOCAL_SPINS.has(localSpin) || proof.request !== request ||
      proof.request_authority_sha256 !== capabilityRequestAuthorityDigest(request)) {
    throw new TypeError('Local spin does not have an opaque on-disk validation proof.');
  }
  const currentTree = await collectLocalSpinTree(resolve(proof.repository_root, localSpin.local_skill.path));
  const currentDigest = stableSha256(currentTree.map(({ path, sha256: digest }) => ({ path, sha256: digest })));
  if (currentDigest !== proof.artifact_digest) {
    throw new TypeError('Validated local spin artifacts drifted before activation.');
  }
  return true;
}

export async function buildPrivilegedCapabilityContext({
  evaluation = null,
  localSpin = null,
  request = null,
  exclusionSnapshot,
} = {}) {
  const exclusion = await requireCurrentExclusionSnapshot(exclusionSnapshot);
  if (evaluation) {
    if (hasRawContent(evaluation)) throw new TypeError('Raw external content cannot enter worker context.');
    if (!isDirectUseEvaluation(evaluation)) {
      throw new TypeError('Only a fully approved direct-use candidate may enter worker context.');
    }
    const evaluationRequest = REVIEWED_EVALUATION_REQUESTS.get(evaluation);
    if (!isOpaqueCapabilityRequest(evaluationRequest) ||
        exclusion.root !== capabilityRequestRepositoryRoot(evaluationRequest)) {
      throw new TypeError('External capability exclusion snapshot belongs to another repository.');
    }
    if (isExcludedCapability({
      identity: evaluation.acquisition.identity,
      repository: evaluation.acquisition.repository,
      commitSha: evaluation.acquisition.commit_sha,
      contentSha256: evaluation.acquisition.content_sha256,
    }, exclusion)) {
      throw new TypeError('Selected external capability is currently excluded or rejected.');
    }
    return {
      capability: {
        request_id: evaluation.request_id,
        public_skill: evaluation.public_skill,
        origin_sha256: evaluation.authority_binding.origin_sha256,
        source: evaluation.acquisition.repository,
        commit_sha: evaluation.acquisition.commit_sha,
        content_sha256: evaluation.acquisition.content_sha256,
        trust_tier: evaluation.trust.tier,
        permissions: clone(evaluation.authority_binding.required_permissions),
        install_scope: evaluation.authority_binding.approved_install_scope,
      },
      authority: 'specialist_role_only',
    };
  }
  if (localSpin) {
    const proof = LOCAL_SPIN_VALIDATION_PROOFS.get(localSpin);
    if (hasRawContent(localSpin) || !VALIDATED_LOCAL_SPINS.has(localSpin) || !proof) {
      throw new TypeError('An unevaluated or raw-content-bearing local spin cannot enter worker context.');
    }
    await revalidateLocalSpinForActivation(localSpin, { request });
    if (exclusion.root !== proof.repository_root ||
        exclusion.root !== capabilityRequestRepositoryRoot(request)) {
      throw new TypeError('Local capability exclusion snapshot belongs to another repository.');
    }
    if (isExcludedCapability({ identity: localSpin.local_skill.id }, exclusion)) {
      throw new TypeError('Validated local spin is currently excluded.');
    }
    return {
      capability: {
        local_skill_id: localSpin.local_skill.id,
        path: localSpin.local_skill.path,
        independently_authored: true,
        artifact_digest: proof.artifact_digest,
        evaluation_runner_sha256: proof.evaluation_runner_sha256,
      },
      authority: 'specialist_role_only',
    };
  }
  throw new TypeError('No approved capability was supplied.');
}

export function createAuthJob({
  id,
  capabilityId,
  kind = 'mcp_oauth',
  serverName,
  requiredScopes = [],
  requiredIdentity = null,
} = {}) {
  if (!AUTH_ID.test(id ?? '') || !CAPABILITY_ID.test(capabilityId ?? '')) {
    throw new TypeError('Auth and capability ids must match AUTH-* and CAP-*');
  }
  if (kind !== 'mcp_oauth' || !SAFE_NAME.test(serverName ?? '')) {
    throw new TypeError('Native MCP OAuth needs one safe server name.');
  }
  const argv = ['codex', 'mcp', 'login', serverName];
  if (argv.some((argument) => SENSITIVE_ARG.test(argument))) {
    throw new TypeError('Authentication argv must not contain credentials.');
  }
  if (requiredIdentity !== null && (!text(requiredIdentity) || SENSITIVE_ARG.test(requiredIdentity))) {
    throw new TypeError('Authentication required identity must be a safe non-empty identity.');
  }
  return {
    schema_version: 1,
    id,
    capability_id: capabilityId,
    kind,
    command: { argv },
    status: 'ready',
    requires: [],
    dependents: [],
    session: {
      transport: 'host-native-preferred',
      sanitized_name: null,
      window: null,
    },
    validation: {
      identity: null,
      scope: [],
      required_scope: canonicalStrings(stringArray(requiredScopes, 'requiredScopes')),
      identity_policy: requiredIdentity === null ? 'any-nonempty' : 'exact',
      required_identity: requiredIdentity === null ? null : text(requiredIdentity),
      smoke_test: false,
      confirmed: false,
    },
  };
}

export function validateAuthJob(job) {
  if (!isObject(job) || job.schema_version !== 1 || job.kind !== 'mcp_oauth' ||
      !AUTH_ID.test(job.id ?? '') || !CAPABILITY_ID.test(job.capability_id ?? '') ||
      !isObject(job.command) || !Array.isArray(job.command.argv)) {
    throw new TypeError('Authentication job is malformed.');
  }
  const argv = job.command.argv;
  if (argv.length !== 4 || argv[0] !== 'codex' || argv[1] !== 'mcp' || argv[2] !== 'login' ||
      !SAFE_NAME.test(argv[3]) || argv.some((argument) => typeof argument !== 'string' || SENSITIVE_ARG.test(argument))) {
    throw new TypeError('Authentication must use exact credential-free native MCP OAuth argv.');
  }
  if (!Array.isArray(job.requires) || !Array.isArray(job.dependents) || job.status !== 'ready' ||
      !isObject(job.session) || !isObject(job.validation) ||
      !Array.isArray(job.validation.required_scope) ||
      !['any-nonempty', 'exact'].includes(job.validation.identity_policy) ||
      (job.validation.identity_policy === 'exact'
        ? !text(job.validation.required_identity)
        : job.validation.required_identity !== null) ||
      JSON.stringify(canonicalStrings(stringArray(job.validation.required_scope, 'auth required scope'))) !==
        JSON.stringify(job.validation.required_scope)) {
    throw new TypeError('Authentication job dependency/status fields are malformed.');
  }
  return job;
}

function approvedFallbackRecord(fallback) {
  return isObject(fallback) && fallback.approved_before_activation === true &&
    CONTENT_SHA.test(fallback.approval_sha256 ?? '') &&
    text(fallback.expected_quality_or_cost_difference) &&
    fallback.same_mandatory_acceptance_criteria === true &&
    fallback.same_protected_behavior === true &&
    fallback.same_permission_envelope === true &&
    typeof fallback.equivalent_mandatory_evidence === 'boolean';
}

function equivalentFallbackRecord(fallback) {
  return approvedFallbackRecord(fallback) && fallback.equivalent_mandatory_evidence === true;
}

export function createProvisionGoalApproval({
  issuer,
  request,
  decisionId,
  planSha256,
  permissionsSha256,
  approvalSha256,
  readCurrentDigests,
} = {}) {
  validateCapabilityRequest(request);
  if (issuer !== 'trusted-cruise-goal-approval-broker' || request.request.public_skill !== 'goal' ||
      !CAPABILITY_REQUEST_BINDINGS.has(request) || !/^D-[0-9]+$/u.test(decisionId ?? '') ||
      ![planSha256, permissionsSha256, approvalSha256].every((digest) => CONTENT_SHA.test(digest ?? '')) ||
      typeof readCurrentDigests !== 'function') {
    throw new TypeError('Goal effect approval requires opaque exact locked-plan authority.');
  }
  const approval = Object.freeze({ kind: 'cruise-provision-goal-approval', decision_id: decisionId });
  GOAL_EFFECT_APPROVALS.set(approval, {
    request,
    plan_sha256: planSha256,
    permissions_sha256: permissionsSha256,
    approval_sha256: approvalSha256,
    read_current_digests: readCurrentDigests,
  });
  return approval;
}

export function createCapabilityFallbackApproval({
  issuer,
  request,
  provisionRunId,
  nodeId,
  decisionId,
  planSha256,
  permissionsSha256,
  fallback,
  readCurrentDigests,
} = {}) {
  validateCapabilityRequest(request);
  if (issuer !== 'trusted-cruise-fallback-approval-broker' || !CAPABILITY_REQUEST_BINDINGS.has(request) ||
      !PROVISION_RUN_ID.test(provisionRunId ?? '') || !CAPABILITY_ID.test(nodeId ?? '') ||
      !/^D-[0-9]+$/u.test(decisionId ?? '') ||
      !CONTENT_SHA.test(planSha256 ?? '') || !CONTENT_SHA.test(permissionsSha256 ?? '') ||
      !approvedFallbackRecord(fallback) || typeof readCurrentDigests !== 'function') {
    throw new TypeError('Fallback approval requires exact pre-activation decision and locked contract authority.');
  }
  const approval = Object.freeze({ kind: 'cruise-capability-fallback-approval', decision_id: decisionId });
  FALLBACK_APPROVALS.set(approval, {
    request,
    provision_run_id: provisionRunId,
    node_id: nodeId,
    fallback_sha256: stableSha256(fallback),
    plan_sha256: planSha256,
    permissions_sha256: permissionsSha256,
    read_current_digests: readCurrentDigests,
  });
  return approval;
}

export function isCapabilityFallbackApproval(value, {
  request,
  provisionRunId,
  nodeId,
  fallback,
} = {}) {
  const binding = isObject(value) ? FALLBACK_APPROVALS.get(value) : null;
  const current = binding?.read_current_digests?.();
  if (current && typeof current.then === 'function') return false;
  return Boolean(binding && binding.request === request && isObject(current) &&
    binding.provision_run_id === provisionRunId && binding.node_id === nodeId &&
    binding.plan_sha256 === current.plan_sha256 &&
    binding.permissions_sha256 === current.permissions_sha256 &&
    approvedFallbackRecord(fallback) && binding.fallback_sha256 === stableSha256(fallback));
}

export function createProvisionReconciliationApproval({
  issuer,
  kind,
  request,
  provisionRunId,
  nodeId,
  record,
  readCurrentDigests,
} = {}) {
  validateCapabilityRequest(request);
  const alternateValid = kind === 'alternate_plan' && isObject(record) &&
    /^D-[0-9]+$/u.test(record.decision_id ?? '') && record.approved === true &&
    CONTENT_SHA.test(record.plan_sha256 ?? '') && CONTENT_SHA.test(record.approval_sha256 ?? '');
  const waiverValid = kind === 'weaker_evidence_waiver' && isObject(record) &&
    record.explicit === true && /^D-[0-9]+$/u.test(record.decision_id ?? '') &&
    CONTENT_SHA.test(record.decision_sha256 ?? '') && CONTENT_SHA.test(record.affected_evidence_sha256 ?? '');
  if (issuer !== 'trusted-cruise-reconciliation-approval-broker' || !CAPABILITY_REQUEST_BINDINGS.has(request) ||
      !PROVISION_RUN_ID.test(provisionRunId ?? '') || !CAPABILITY_ID.test(nodeId ?? '') ||
      (!alternateValid && !waiverValid) || typeof readCurrentDigests !== 'function') {
    throw new TypeError('Reconciliation approval requires an exact opaque alternate-plan or waiver decision.');
  }
  const approval = Object.freeze({ kind: `cruise-provision-${kind}-approval` });
  RECONCILIATION_APPROVALS.set(approval, {
    kind,
    request,
    provision_run_id: provisionRunId,
    node_id: nodeId,
    record_sha256: stableSha256(record),
    read_current_digests: readCurrentDigests,
  });
  return approval;
}

function isProvisionReconciliationApproval(value, { kind, request, provisionRunId, nodeId, record } = {}) {
  const binding = isObject(value) ? RECONCILIATION_APPROVALS.get(value) : null;
  const current = binding?.read_current_digests?.();
  if (!isObject(current) || (current && typeof current.then === 'function')) return false;
  const digestsCurrent = kind === 'alternate_plan'
    ? current.plan_sha256 === record?.plan_sha256 && current.approval_sha256 === record?.approval_sha256
    : current.decision_sha256 === record?.decision_sha256 &&
      current.affected_evidence_sha256 === record?.affected_evidence_sha256;
  return Boolean(binding && binding.kind === kind && binding.request === request &&
    binding.provision_run_id === provisionRunId && binding.node_id === nodeId &&
    digestsCurrent && binding.record_sha256 === stableSha256(record));
}

export function authorizeProvisionEffect({ request, effect, permission, authority = {} } = {}) {
  validateCapabilityRequest(request);
  const requestBinding = CAPABILITY_REQUEST_BINDINGS.get(request);
  if (!requestBinding) {
    return { allowed: false, reason: 'opaque_origin_bound_capability_request_required' };
  }
  if (!isObject(effect) || !['external_discovery', 'acquisition', 'install', 'authenticate'].includes(effect.kind)) {
    throw new TypeError('Provision effect kind is invalid.');
  }
  if (!isObject(permission) || !/^D-[0-9]+$/u.test(permission.id ?? '') || permission.granted !== true ||
      !Array.isArray(permission.scopes) || !permission.scopes.includes(effect.kind)) {
    return { allowed: false, reason: 'exact_granted_permission_required' };
  }
  const decision = requestBinding.permission_decisions.find((entry) => entry.id === permission.id &&
    entry.scopes.includes(effect.kind) &&
    JSON.stringify(entry.permissions) ===
      JSON.stringify(canonicalStrings(stringArray(permission.permissions ?? [], 'permission permissions'))));
  if (!decision) {
    return { allowed: false, reason: 'permission_not_bound_to_capability_request' };
  }
  if (authority.origin_sha256 !== requestBinding.origin_sha256 ||
      authority.public_skill !== request.request.public_skill) {
    return { allowed: false, reason: 'origin_authority_binding_invalid' };
  }
  const skill = request.request.public_skill;
  if (skill === 'quick' && effect.kind !== 'external_discovery') {
    return { allowed: false, reason: 'quick_requires_promotion' };
  }
  if (skill === 'quick' && effect.kind === 'external_discovery') {
    return { allowed: false, reason: 'quick_requires_promotion' };
  }
  if (['build', 'research'].includes(skill) &&
      (effect.target_application_dependency === true || !INSTALL_SCOPES.has(effect.install_scope ?? 'repository-local'))) {
    return { allowed: false, reason: 'read_only_route_product_boundary' };
  }
  if (effect.kind === 'authenticate' && request.request.constraints.authentication_allowed !== true) {
    return { allowed: false, reason: 'authentication_not_allowed' };
  }
  if (effect.kind === 'install' && effect.selection_evaluation !== undefined) {
    const evaluation = effect.selection_evaluation;
    if (!isDirectUseEvaluation(evaluation) || REVIEWED_EVALUATION_REQUESTS.get(evaluation) !== request) {
      return { allowed: false, reason: 'opaque_selected_evaluation_required' };
    }
  }
  if (skill === 'goal' && ['install', 'authenticate'].includes(effect.kind)) {
    const goalApproval = isObject(authority.goal_approval)
      ? GOAL_EFFECT_APPROVALS.get(authority.goal_approval)
      : null;
    const current = goalApproval?.read_current_digests?.();
    if (current && typeof current.then === 'function') {
      return { allowed: false, reason: 'goal_approval_binding_invalid' };
    }
    if (!goalApproval || goalApproval.request !== request || !isObject(current) ||
        current.plan_sha256 !== goalApproval.plan_sha256 ||
        current.permissions_sha256 !== goalApproval.permissions_sha256 ||
        current.approval_sha256 !== goalApproval.approval_sha256) {
      return { allowed: false, reason: 'goal_approval_binding_invalid' };
    }
  }
  let target = null;
  if (effect.kind === 'install') {
    const evaluation = effect.selection_evaluation;
    if (!isDirectUseEvaluation(evaluation) || REVIEWED_EVALUATION_REQUESTS.get(evaluation) !== request) {
      return { allowed: false, reason: 'opaque_selected_evaluation_required' };
    }
    if (request.request.constraints.maximum_install_scope !== 'repository-local' ||
        evaluation.authority_binding.maximum_install_scope !== 'repository-local' ||
        evaluation.activation.install_scope !== 'repository-local') {
      return { allowed: false, reason: 'install_scope_exceeds_request' };
    }
    const grantedPermissions = canonicalStrings(permission.permissions ?? []);
    const requiredPermissions = canonicalStrings(evaluation.authority_binding.required_permissions ?? []);
    if (JSON.stringify(grantedPermissions) !== JSON.stringify(requiredPermissions)) {
      return { allowed: false, reason: 'exact_permission_envelope_required' };
    }
    target = {
      action: evaluation.activation.action,
      identity: evaluation.activation.identity,
      repository: evaluation.acquisition.repository,
      commit_sha: evaluation.acquisition.commit_sha,
      content_sha256: evaluation.acquisition.content_sha256,
      version: evaluation.activation.version,
      install_scope: evaluation.activation.install_scope,
      command_sha256: evaluation.activation.command_sha256,
      installer_sha256: evaluation.activation.installer_sha256,
      rollback_safe: evaluation.activation.rollback_safe,
      rollback_procedure_sha256: evaluation.activation.rollback_procedure_sha256,
      required_permissions: requiredPermissions,
    };
  }
  if (effect.kind === 'authenticate') {
    const capabilityId = text(effect.capability_id);
    const requiredPermissions = canonicalStrings(effect.required_permissions ?? []);
    const authJob = effect.auth_job;
    const provisionRunId = text(effect.provision_run_id);
    const candidateIdentity = text(effect.candidate_identity);
    const approvedPermissions = canonicalStrings(request.request.constraints.permissions);
    const grantedPermissions = canonicalStrings(permission.permissions ?? []);
    try {
      validateAuthJob(authJob);
    } catch {
      return { allowed: false, reason: 'authentication_job_descriptor_invalid' };
    }
    if (!CAPABILITY_ID.test(capabilityId) || authJob.capability_id !== capabilityId ||
        !PROVISION_RUN_ID.test(provisionRunId) || !candidateIdentity || SENSITIVE_ARG.test(candidateIdentity) ||
        JSON.stringify(authJob.validation.required_scope) !== JSON.stringify(requiredPermissions) ||
        !requiredPermissions.every((entry) => approvedPermissions.includes(entry)) ||
        JSON.stringify(grantedPermissions) !== JSON.stringify(requiredPermissions)) {
      return { allowed: false, reason: 'authentication_target_or_permission_envelope_invalid' };
    }
    target = {
      capability_id: capabilityId,
      candidate_identity: candidateIdentity,
      provision_run_id: provisionRunId,
      auth_job_id: authJob.id,
      server_name: authJob.command.argv[3],
      auth_job_sha256: stableSha256(authJob),
      command_sha256: stableSha256(authJob.command),
      required_permissions: requiredPermissions,
    };
  }
  if (effect.kind === 'acquisition') {
    const repository = text(effect.repository);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
      return { allowed: false, reason: 'acquisition_repository_target_invalid' };
    }
    target = { repository };
  }
  if (['external_discovery', 'acquisition'].includes(effect.kind) &&
      request.request.constraints.external_search_allowed !== true) {
    return { allowed: false, reason: 'external_search_not_allowed' };
  }
  const authorization = Object.freeze({
    allowed: true,
    permission_id: permission.id,
    request_id: request.request.id,
    effect_kind: effect.kind,
    public_skill: request.request.public_skill,
  });
  AUTHORIZED_EFFECTS.set(authorization, {
    request,
    auth_job: effect.kind === 'authenticate' ? effect.auth_job : null,
    request_id: request.request.id,
    effect_kind: effect.kind,
    public_skill: request.request.public_skill,
    origin_sha256: authority.origin_sha256,
    target: target ? deepFreeze(clone(target)) : null,
  });
  return authorization;
}

export function isProvisionEffectAuthorization(value, {
  request,
  effectKind,
  publicSkill = null,
  candidate = null,
  capabilityId = null,
  requiredPermissions = null,
  repository = null,
  authJob = null,
  provisionRunId = null,
  candidateIdentity = null,
} = {}) {
  const binding = isObject(value) ? AUTHORIZED_EFFECTS.get(value) : null;
  const requestBinding = isObject(request) ? CAPABILITY_REQUEST_BINDINGS.get(request) : null;
  if (!binding || !requestBinding || binding.request !== request ||
      binding.origin_sha256 !== requestBinding.origin_sha256 ||
      binding.request_id !== request.request.id || binding.effect_kind !== effectKind ||
      (publicSkill && binding.public_skill !== publicSkill)) return false;
  if (effectKind === 'install') {
    if (!isObject(candidate) || !isObject(binding.target)) return false;
    const commandDigest = candidate.command ? stableSha256(candidate.command) : null;
    const installerBinding = isObject(candidate.installer_attestation)
      ? TRUSTED_INSTALLER_ATTESTATIONS.get(candidate.installer_attestation)
      : null;
    return binding.target.action === candidate.action &&
      binding.target.identity === candidate.identity &&
      binding.target.repository === candidate.repository &&
      binding.target.commit_sha === candidate.reviewed_commit_sha &&
      binding.target.content_sha256 === candidate.content_sha256 &&
      binding.target.version === (text(candidate.version) || null) &&
      binding.target.install_scope === candidate.install_scope &&
      binding.target.command_sha256 === commandDigest &&
      binding.target.installer_sha256 === (candidate.action === 'install' ? installerBinding?.file_sha256 : null) &&
      binding.target.rollback_safe === (candidate.action === 'install' ? candidate.rollback_safe === true : null) &&
      binding.target.rollback_procedure_sha256 === (candidate.action === 'install'
        ? sha256(text(candidate.rollback_procedure))
        : null);
  }
  if (effectKind === 'authenticate') {
    try {
      validateAuthJob(authJob);
    } catch {
      return false;
    }
    if (!CAPABILITY_ID.test(capabilityId ?? '') || binding.auth_job !== authJob ||
        binding.target?.capability_id !== capabilityId ||
        binding.target?.candidate_identity !== candidateIdentity ||
        binding.target?.provision_run_id !== provisionRunId ||
        binding.target?.auth_job_id !== authJob.id ||
        binding.target?.server_name !== authJob.command.argv[3] ||
        binding.target?.auth_job_sha256 !== stableSha256(authJob) ||
        binding.target?.command_sha256 !== stableSha256(authJob.command)) return false;
    return requiredPermissions !== null &&
      JSON.stringify(binding.target?.required_permissions ?? []) ===
        JSON.stringify(canonicalStrings(stringArray(requiredPermissions, 'authentication required permissions')));
  }
  if (effectKind === 'acquisition') {
    return text(repository) !== '' && binding.target?.repository === repository;
  }
  return true;
}

function requireProvisionEffectAuthorization(value, request, effectKind, target = {}) {
  if (!isProvisionEffectAuthorization(value, {
    request,
    effectKind,
    publicSkill: request.request.public_skill,
    ...target,
  })) {
    throw new TypeError(`${effectKind} requires an opaque request- and Origin-bound effect authorization.`);
  }
  return AUTHORIZED_EFFECTS.get(value);
}

function authenticationVerificationContext({
  request,
  effectAuthorization,
  authJob,
  provisionRunId,
  capabilityId,
  candidateIdentity,
} = {}) {
  if (!isOpaqueCapabilityRequest(request)) {
    throw new TypeError('Authentication verification requires the exact opaque CAPREQ.');
  }
  validateCapabilityRequest(request);
  validateAuthJob(authJob);
  const normalizedCapabilityId = text(capabilityId);
  const normalizedCandidateIdentity = text(candidateIdentity);
  if (!CAPABILITY_ID.test(normalizedCapabilityId) || authJob.capability_id !== normalizedCapabilityId ||
      !PROVISION_RUN_ID.test(provisionRunId ?? '') || !normalizedCandidateIdentity ||
      SENSITIVE_ARG.test(normalizedCandidateIdentity)) {
    throw new TypeError('Authentication verification requires an exact run, node, job, and safe candidate identity.');
  }
  const authorization = requireProvisionEffectAuthorization(
    effectAuthorization,
    request,
    'authenticate',
    {
      capabilityId: normalizedCapabilityId,
      authJob,
      provisionRunId,
      candidateIdentity: normalizedCandidateIdentity,
      requiredPermissions: authJob.validation.required_scope,
    },
  );
  const repositoryRoot = capabilityRequestRepositoryRoot(request);
  return deepFreeze({
    request_id: request.request.id,
    request_authority_sha256: capabilityRequestAuthorityDigest(request),
    repository_root: repositoryRoot,
    provision_run_id: provisionRunId,
    capability_id: normalizedCapabilityId,
    candidate_identity: normalizedCandidateIdentity,
    auth_job_id: authJob.id,
    auth_job_sha256: stableSha256(authJob),
    server_name: authJob.command.argv[3],
    required_scope: clone(authJob.validation.required_scope),
    identity_policy: authJob.validation.identity_policy,
    required_identity: authJob.validation.required_identity,
    auth_effect_sha256: stableSha256(authorization),
    auth_state_path: resolve(repositoryRoot, '.cruise', 'internal', 'auth-state', `${authJob.id}.yaml`),
  });
}

function validatedAuthenticationEvidence(evidence, context) {
  if (!isObject(evidence) || !isObject(evidence.bound_context) ||
      stableSha256(evidence.bound_context) !== stableSha256(context) ||
      !isoTimestamp(evidence.observed_at) || !CONTENT_SHA.test(evidence.evidence_sha256 ?? '') ||
      evidence.persisted_state_path !== context.auth_state_path ||
      !CONTENT_SHA.test(evidence.persisted_state_sha256 ?? '') || !isObject(evidence.state)) {
    throw new TypeError('Authentication verification evidence is incomplete or not bound to the exact context.');
  }
  const state = evidence.state;
  if (evidence.parsed_state_sha256 !== stableSha256(state) || state.schema_version !== 1 ||
      state.kind !== 'cruise_auth_job_state' || state.id !== context.auth_job_id ||
      state.capability_id !== context.capability_id || state.request_id !== context.request_id ||
      state.request_authority_sha256 !== context.request_authority_sha256 ||
      state.provision_run_id !== context.provision_run_id ||
      state.candidate_identity !== context.candidate_identity ||
      state.server_name !== context.server_name || state.auth_job_sha256 !== context.auth_job_sha256 ||
      state.auth_effect_sha256 !== context.auth_effect_sha256 ||
      JSON.stringify(state.required_scope) !== JSON.stringify(context.required_scope) ||
      !['running', 'waiting_auth', 'succeeded', 'failed', 'unconfirmed', 'timed_out', 'cancelled']
        .includes(state.status) || typeof state.confirmed !== 'boolean') {
    throw new TypeError('Persisted authentication state does not match its exact request authority.');
  }
  const verified = state.status === 'succeeded' && state.confirmed === true;
  if (verified) {
    if (!text(state.identity) || SENSITIVE_ARG.test(state.identity) ||
        !Array.isArray(state.scope) || state.scope.length === 0 ||
        state.scope.some((entry) => typeof entry !== 'string' || SENSITIVE_ARG.test(entry)) ||
        JSON.stringify(canonicalStrings(state.scope)) !== JSON.stringify(context.required_scope) ||
        state.smoke_test_passed !== true || state.logs_redacted !== true ||
        (context.identity_policy === 'exact' && state.identity !== context.required_identity)) {
      throw new TypeError('Successful authentication evidence violates the approved identity or scope contract.');
    }
  } else if (state.confirmed !== false) {
    throw new TypeError('Unsuccessful authentication evidence cannot claim confirmation.');
  }
  const immutableEvidence = deepFreeze({
    observed_at: evidence.observed_at,
    evidence_sha256: evidence.evidence_sha256.toLowerCase(),
    persisted_state_path: evidence.persisted_state_path,
    persisted_state_sha256: evidence.persisted_state_sha256.toLowerCase(),
    parsed_state_sha256: evidence.parsed_state_sha256.toLowerCase(),
    state: clone(state),
  });
  return {
    verified,
    reason: verified ? null : text(evidence.reason) || text(state.reason) || 'authentication is not yet verified',
    identity: verified ? state.identity : null,
    scope: verified ? clone(context.required_scope) : null,
    immutable_evidence: immutableEvidence,
    immutable_evidence_sha256: stableSha256({
      context,
      evidence_sha256: immutableEvidence.evidence_sha256,
      persisted_state_path: immutableEvidence.persisted_state_path,
      persisted_state_sha256: immutableEvidence.persisted_state_sha256,
      parsed_state_sha256: immutableEvidence.parsed_state_sha256,
      state: immutableEvidence.state,
    }),
  };
}

export function createProvisionAuthVerificationBroker({
  issuer,
  request,
  repositoryRoot,
  inspectAuthentication,
} = {}) {
  if (issuer !== 'trusted-cruise-auth-verification-broker' || !isOpaqueCapabilityRequest(request) ||
      typeof inspectAuthentication !== 'function' || !text(repositoryRoot) ||
      resolve(repositoryRoot) !== repositoryRoot || capabilityRequestRepositoryRoot(request) !== repositoryRoot) {
    throw new TypeError('Auth verification broker requires trusted exact CAPREQ and repository authority.');
  }
  const broker = Object.freeze({ kind: 'cruise-auth-verification-broker' });
  AUTH_VERIFICATION_BROKERS.set(broker, { request, repository_root: repositoryRoot, inspectAuthentication });
  return broker;
}

export async function runProvisionAuthenticationVerification({
  broker,
  request,
  effectAuthorization,
  authJob,
  provisionRunId,
  capabilityId,
  candidateIdentity,
} = {}) {
  const brokerBinding = isObject(broker) ? AUTH_VERIFICATION_BROKERS.get(broker) : null;
  if (!brokerBinding || brokerBinding.request !== request ||
      brokerBinding.repository_root !== capabilityRequestRepositoryRoot(request)) {
    throw new TypeError('Authentication verification requires the exact opaque request-bound broker.');
  }
  const context = authenticationVerificationContext({
    request,
    effectAuthorization,
    authJob,
    provisionRunId,
    capabilityId,
    candidateIdentity,
  });
  const evidence = await brokerBinding.inspectAuthentication({ context: clone(context) });
  const checked = validatedAuthenticationEvidence(evidence, context);
  if (!checked.verified) {
    return {
      verified: false,
      reason: checked.reason,
      evidence_sha256: checked.immutable_evidence.evidence_sha256,
      persisted_state_sha256: checked.immutable_evidence.persisted_state_sha256,
    };
  }
  const attestation = Object.freeze({
    kind: 'cruise-auth-verification-attestation',
    auth_job_id: context.auth_job_id,
    observed_at: checked.immutable_evidence.observed_at,
  });
  AUTH_VERIFICATION_ATTESTATIONS.set(attestation, {
    broker,
    request,
    effect_authorization: effectAuthorization,
    auth_job: authJob,
    context,
    context_sha256: stableSha256(context),
    identity: checked.identity,
    scope: clone(checked.scope),
    immutable_evidence: checked.immutable_evidence,
    immutable_evidence_sha256: checked.immutable_evidence_sha256,
  });
  return {
    verified: true,
    identity: checked.identity,
    scope: clone(checked.scope),
    evidence_sha256: checked.immutable_evidence.evidence_sha256,
    persisted_state_sha256: checked.immutable_evidence.persisted_state_sha256,
    attestation,
  };
}

function authenticationVerificationBindingMatches(binding, supplied = {}) {
  if (!binding || supplied.request !== binding.request || supplied.authJob !== binding.auth_job ||
      supplied.effectAuthorization !== binding.effect_authorization) return false;
  let current = null;
  try {
    current = authenticationVerificationContext(supplied);
  } catch {
    return false;
  }
  return stableSha256(current) === binding.context_sha256;
}

export async function revalidateProvisionAuthenticationAttestation(attestation, context = {}) {
  const attestationBinding = isObject(attestation) ? AUTH_VERIFICATION_ATTESTATIONS.get(attestation) : null;
  if (!authenticationVerificationBindingMatches(attestationBinding, context)) {
    throw new TypeError('Authentication attestation is forged, cloned, or bound to different authority.');
  }
  const brokerBinding = AUTH_VERIFICATION_BROKERS.get(attestationBinding.broker);
  if (!brokerBinding || brokerBinding.request !== attestationBinding.request) {
    throw new TypeError('Authentication verification broker authority is unavailable.');
  }
  const evidence = await brokerBinding.inspectAuthentication({ context: clone(attestationBinding.context) });
  const checked = validatedAuthenticationEvidence(evidence, attestationBinding.context);
  if (!checked.verified || checked.immutable_evidence_sha256 !== attestationBinding.immutable_evidence_sha256 ||
      checked.identity !== attestationBinding.identity ||
      JSON.stringify(checked.scope) !== JSON.stringify(attestationBinding.scope)) {
    throw new TypeError('Authenticated identity, scope, or persisted evidence drifted after verification.');
  }
  return {
    verified: true,
    identity: checked.identity,
    scope: clone(checked.scope),
    evidence_sha256: checked.immutable_evidence.evidence_sha256,
    persisted_state_sha256: checked.immutable_evidence.persisted_state_sha256,
  };
}

export function isProvisionAuthenticationAttestation(value, context = {}) {
  const binding = isObject(value) ? AUTH_VERIFICATION_ATTESTATIONS.get(value) : null;
  return authenticationVerificationBindingMatches(binding, context);
}

export function sanitizeTmuxName(value) {
  const sanitized = String(value ?? '').replace(/[^A-Za-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '');
  if (!sanitized) throw new TypeError('tmux name cannot be empty after sanitization.');
  return sanitized.slice(0, 128);
}

export function createProvisionAuthRunnerBroker({ issuer, inspectRunner } = {}) {
  if (issuer !== 'trusted-cruise-host-broker' || typeof inspectRunner !== 'function') {
    throw new TypeError('Auth runner broker requires the trusted host issuer and a runner inspection adapter.');
  }
  const broker = Object.freeze({ kind: 'cruise-auth-runner-broker' });
  AUTH_RUNNER_BROKERS.set(broker, { inspectRunner });
  return broker;
}

export function createTrustedAuthRunnerAttestation({ runnerPath, broker } = {}) {
  const brokerBinding = isObject(broker) ? AUTH_RUNNER_BROKERS.get(broker) : null;
  const evidence = brokerBinding?.inspectRunner({ runner_path: runnerPath });
  if (evidence && typeof evidence.then === 'function') {
    throw new TypeError('Auth runner inspection must complete synchronously before attestation.');
  }
  if (!text(runnerPath) || !runnerPath.startsWith('/') || !runnerPath.endsWith('/cruise-auth-runner.mjs') ||
      !brokerBinding || !isObject(evidence) ||
      !CONTENT_SHA.test(evidence.file_sha256 ?? '') || !isoTimestamp(evidence.observed_at) ||
      evidence.resolved_path !== runnerPath || evidence.regular_file !== true || evidence.symlink !== false ||
      evidence.executable !== true || evidence.argv_boundary_verified !== true ||
      evidence.redacted_state_persistence_verified !== true ||
      evidence.post_auth_validation_adapter_verified !== true) {
    throw new TypeError('Trusted auth runner attestation needs broker-verified path, digest, execution, state, and validation evidence.');
  }
  const token = Object.freeze({
    kind: 'trusted-cruise-auth-runner',
    runner_path: runnerPath,
    observed_at: evidence.observed_at,
  });
  TRUSTED_AUTH_RUNNERS.set(token, {
    runnerPath,
    digest: sha256(JSON.stringify({ runnerPath, evidence })),
    file_sha256: evidence.file_sha256,
    inspect_runner: brokerBinding.inspectRunner,
  });
  return token;
}

export async function createTmuxAuthTransport({
  runId,
  capabilityId,
  authJobId,
  slug,
  repositoryRoot,
  jobPath,
  runnerAttestation,
  hostCapabilities = {},
  request,
  effectAuthorization,
  authJob,
  candidateIdentity,
} = {}) {
  const trustedRunner = isObject(runnerAttestation) ? TRUSTED_AUTH_RUNNERS.get(runnerAttestation) : null;
  const runnerPath = trustedRunner?.runnerPath;
  if (!SAFE_NAME.test(runId ?? '') || runId.length > 128 ||
      !CAPABILITY_ID.test(capabilityId ?? '') || !AUTH_ID.test(authJobId ?? '') ||
      !text(repositoryRoot) || !text(jobPath) || !text(runnerPath)) {
    throw new TypeError('tmux auth transport needs safe ids and absolute trusted paths.');
  }
  if (![repositoryRoot, jobPath, runnerPath].every((value) => value.startsWith('/'))) {
    throw new TypeError('tmux auth paths must be absolute.');
  }
  const expectedAuthRoot = resolve(repositoryRoot, '.cruise', 'internal', 'auth-jobs');
  if (resolve(jobPath) !== resolve(expectedAuthRoot, `${authJobId}.yaml`)) {
    throw new TypeError('tmux auth job path must be the exact private job artifact for its id.');
  }
  if (hostCapabilities.local_host_confirmed !== true || hostCapabilities.tmux_supported !== true ||
      hostCapabilities.interactive_auth_required !== true || hostCapabilities.native_ui_can_present !== false ||
      hostCapabilities.terminal_monitoring_confirmed !== true) {
    throw new TypeError('tmux auth transport prerequisites are not technically confirmed by the host.');
  }
  if (!runnerPath.endsWith('/cruise-auth-runner.mjs')) {
    throw new TypeError('tmux may launch only the trusted Cruise auth runner.');
  }
  validateCapabilityRequest(request);
  validateAuthJob(authJob);
  if (capabilityRequestRepositoryRoot(request) !== resolve(repositoryRoot) ||
      authJob.id !== authJobId || authJob.capability_id !== capabilityId ||
      !text(candidateIdentity) ||
      !isProvisionEffectAuthorization(effectAuthorization, {
        request,
        effectKind: 'authenticate',
        capabilityId,
        requiredPermissions: authJob.validation.required_scope,
        authJob,
        provisionRunId: runId,
        candidateIdentity,
      })) {
    throw new TypeError('tmux auth transport requires the exact opaque request, effect, auth job, run, and candidate authority.');
  }
  const currentRunner = trustedRunner.inspect_runner({ runner_path: runnerPath });
  if (currentRunner && typeof currentRunner.then === 'function') {
    throw new TypeError('Auth runner re-inspection must complete synchronously before tmux launch.');
  }
  if (!isObject(currentRunner) || currentRunner.file_sha256 !== trustedRunner.file_sha256 ||
      currentRunner.resolved_path !== runnerPath || currentRunner.regular_file !== true ||
      currentRunner.symlink !== false || currentRunner.executable !== true ||
      currentRunner.argv_boundary_verified !== true ||
      currentRunner.redacted_state_persistence_verified !== true ||
      currentRunner.post_auth_validation_adapter_verified !== true) {
    throw new TypeError('Trusted auth runner drifted before tmux launch.');
  }
  const metadata = await lstat(jobPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) {
    throw new TypeError('Persisted auth job must be a bounded regular non-symlink file.');
  }
  const canonicalRoot = await realpath(resolve(repositoryRoot));
  if (canonicalRoot !== resolve(repositoryRoot)) {
    throw new TypeError('tmux auth repository root must be canonical.');
  }
  const canonicalJobPath = await realpath(resolve(jobPath));
  const relativeJobPath = relative(canonicalRoot, canonicalJobPath);
  if (!relativeJobPath || relativeJobPath.startsWith('..') || isAbsolute(relativeJobPath)) {
    throw new TypeError('Persisted auth job escapes the repository authority root.');
  }
  const jobBytes = await readFile(canonicalJobPath);
  if (jobBytes.length !== metadata.size) {
    throw new TypeError('Persisted auth job changed while it was being reviewed.');
  }
  const parsedJob = parseYaml(jobBytes.toString('utf8'));
  validateAuthJob(parsedJob);
  if (stableSha256(parsedJob) !== stableSha256(authJob)) {
    throw new TypeError('Persisted auth job differs from the exact authorized auth job.');
  }
  const authJobBytesSha256 = sha256(jobBytes);
  const previouslyBoundBytes = AUTH_JOB_PERSISTED_BYTES.get(effectAuthorization);
  if (previouslyBoundBytes && previouslyBoundBytes !== authJobBytesSha256) {
    throw new TypeError('Persisted auth job bytes drifted after tmux transport review.');
  }
  AUTH_JOB_PERSISTED_BYTES.set(effectAuthorization, authJobBytesSha256);
  const session = sanitizeTmuxName(`cruise-auth-${runId}-${capabilityId}`);
  const window = sanitizeTmuxName(slug);
  const statePath = resolve(repositoryRoot, '.cruise', 'internal', 'auth-state', `${authJobId}.yaml`);
  return {
    session,
    window,
    argv: [
      'tmux', 'new-session', '-d', '-s', session, '-n', window, '-c', repositoryRoot,
      runnerPath, '--job', jobPath, '--expected-job-sha256', authJobBytesSha256, '--state', statePath,
    ],
    transport_only: true,
    automatic_resume: false,
    runner_attestation_sha256: trustedRunner.digest,
    auth_job_sha256: authJobBytesSha256,
    auth_state_path: statePath,
    auth_effect_sha256: stableSha256(AUTHORIZED_EFFECTS.get(effectAuthorization)),
  };
}

export function createTmuxAuthInstructions({ capability, transport } = {}) {
  if (!text(capability) || !isObject(transport) || transport.transport_only !== true ||
      sanitizeTmuxName(transport.session) !== transport.session) {
    throw new TypeError('Authentication instructions require a named capability and trusted tmux transport.');
  }
  const target = `=${transport.session}`;
  return {
    capability: text(capability),
    attach_argv: ['tmux', 'attach-session', '-t', target],
    cancel_argv: ['tmux', 'kill-session', '-t', target],
    text: [
      `Authentication is required for ${text(capability)}.`,
      '',
      'Open the authentication session:',
      `  tmux attach-session -t '${target}'`,
      '',
      'Cancel:',
      `  tmux kill-session -t '${target}'`,
    ].join('\n'),
  };
}

export function createProvisionContinuationBroker({ issuer, inspectClient } = {}) {
  if (issuer !== 'trusted-cruise-host-broker' || typeof inspectClient !== 'function') {
    throw new TypeError('Continuation broker requires the trusted host issuer and client inspection adapter.');
  }
  const broker = Object.freeze({ kind: 'cruise-continuation-broker' });
  CONTINUATION_BROKERS.set(broker, { inspectClient });
  return broker;
}

function authenticationContinuationContext({
  request,
  authJob,
  authVerification,
  effectAuthorization,
  provisionRunId,
  candidateIdentity,
  validatedIdentity,
  validatedScope,
  dagStateSha256,
  threadId,
} = {}) {
  if (!isOpaqueCapabilityRequest(request)) {
    throw new TypeError('Authentication continuation requires the exact opaque CAPREQ.');
  }
  validateCapabilityRequest(request);
  validateAuthJob(authJob);
  const verifiedAuthentication = isObject(authVerification)
    ? AUTH_VERIFICATION_ATTESTATIONS.get(authVerification)
    : null;
  if (!verifiedAuthentication || verifiedAuthentication.request !== request ||
      verifiedAuthentication.auth_job !== authJob ||
      verifiedAuthentication.effect_authorization !== effectAuthorization) {
    throw new TypeError('Authentication continuation requires the exact opaque successful auth result and effect authority.');
  }
  if (!PROVISION_RUN_ID.test(provisionRunId ?? '')) {
    throw new TypeError('Authentication continuation requires a safe provision run id.');
  }
  const normalizedCandidateIdentity = text(candidateIdentity);
  const normalizedValidatedIdentity = text(validatedIdentity);
  const normalizedThreadId = text(threadId);
  if (!normalizedCandidateIdentity || !normalizedValidatedIdentity ||
      SENSITIVE_ARG.test(normalizedCandidateIdentity) || SENSITIVE_ARG.test(normalizedValidatedIdentity)) {
    throw new TypeError('Authentication continuation requires safe candidate and validated identities.');
  }
  if (!normalizedThreadId || normalizedThreadId.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalizedThreadId) ||
      SENSITIVE_ARG.test(normalizedThreadId)) {
    throw new TypeError('Authentication continuation requires a safe exact thread id.');
  }
  const normalizedValidatedScope = canonicalStrings(
    stringArray(validatedScope, 'authentication continuation validated scope'),
  );
  if (JSON.stringify(normalizedValidatedScope) !== JSON.stringify(validatedScope) ||
      JSON.stringify(normalizedValidatedScope) !== JSON.stringify(authJob.validation.required_scope)) {
    throw new TypeError('Authentication continuation scope must exactly match the validated auth job scope.');
  }
  if (authJob.validation.identity_policy === 'exact' &&
      normalizedValidatedIdentity !== authJob.validation.required_identity) {
    throw new TypeError('Authentication continuation identity does not match the auth job identity policy.');
  }
  if (!CONTENT_SHA.test(dagStateSha256 ?? '')) {
    throw new TypeError('Authentication continuation requires an exact DAG-state SHA-256.');
  }
  if (verifiedAuthentication.context.provision_run_id !== provisionRunId ||
      verifiedAuthentication.context.capability_id !== authJob.capability_id ||
      verifiedAuthentication.context.candidate_identity !== normalizedCandidateIdentity ||
      verifiedAuthentication.identity !== normalizedValidatedIdentity ||
      JSON.stringify(verifiedAuthentication.scope) !== JSON.stringify(normalizedValidatedScope)) {
    throw new TypeError('Authentication continuation context differs from the verified authentication authority.');
  }
  return deepFreeze({
    request_id: request.request.id,
    request_authority_sha256: capabilityRequestAuthorityDigest(request),
    auth_job_id: authJob.id,
    auth_job_sha256: stableSha256(authJob),
    auth_effect_sha256: verifiedAuthentication.context.auth_effect_sha256,
    auth_verification_sha256: verifiedAuthentication.immutable_evidence_sha256,
    persisted_auth_state_sha256: verifiedAuthentication.immutable_evidence.persisted_state_sha256,
    provision_run_id: provisionRunId,
    candidate_identity: normalizedCandidateIdentity,
    validated_identity: normalizedValidatedIdentity,
    validated_scope: normalizedValidatedScope,
    dag_state_sha256: dagStateSha256.toLowerCase(),
    thread_id: normalizedThreadId,
  });
}

function continuationContextMatches(binding, supplied = {}) {
  if (!binding || supplied.request !== binding.request || supplied.authJob !== binding.auth_job ||
      supplied.authVerification !== binding.auth_verification ||
      supplied.effectAuthorization !== binding.effect_authorization) return false;
  let current = null;
  try {
    current = authenticationContinuationContext(supplied);
  } catch {
    return false;
  }
  return stableSha256(current) === binding.context_sha256 &&
    stableSha256(supplied.authJob) === binding.context.auth_job_sha256;
}

export async function createAuthenticationContinuationAttestation({
  broker,
  request,
  authJob,
  authVerification,
  effectAuthorization,
  provisionRunId,
  candidateIdentity,
  validatedIdentity,
  validatedScope,
  dagStateSha256,
  threadId,
} = {}) {
  const binding = isObject(broker) ? CONTINUATION_BROKERS.get(broker) : null;
  if (!binding) {
    throw new TypeError('Authentication continuation requires an opaque trusted host broker.');
  }
  await revalidateProvisionAuthenticationAttestation(authVerification, {
    request,
    effectAuthorization,
    authJob,
    provisionRunId,
    capabilityId: authJob?.capability_id,
    candidateIdentity,
  });
  const context = authenticationContinuationContext({
    request,
    authJob,
    authVerification,
    effectAuthorization,
    provisionRunId,
    candidateIdentity,
    validatedIdentity,
    validatedScope,
    dagStateSha256,
    threadId,
  });
  const evidence = binding.inspectClient({ required_capabilities: [
    'same_thread_auth_watcher',
    'post_auth_validation',
    'capability_dag_update',
    'app_server_continuation',
  ], continuation_context: clone(context) });
  if (evidence && typeof evidence.then === 'function') {
    throw new TypeError('Host continuation inspection must complete synchronously before attestation.');
  }
  if (!isObject(evidence) ||
      evidence.same_thread_auth_watcher_confirmed !== true ||
      evidence.post_auth_validation_confirmed !== true ||
      evidence.capability_dag_update_confirmed !== true ||
      evidence.app_server_continuation_confirmed !== true ||
      !CONTENT_SHA.test(evidence.client_evidence_sha256 ?? '') ||
      !isObject(evidence.bound_context) ||
      stableSha256(evidence.bound_context) !== stableSha256(context) ||
      !text(evidence.continuation_method) || !isoTimestamp(evidence.observed_at)) {
    throw new TypeError('Host client did not provide complete observed continuation evidence.');
  }
  const attestation = Object.freeze({
    kind: 'cruise-auth-continuation-attestation',
    observed_at: evidence.observed_at,
    continuation_method: evidence.continuation_method,
  });
  CONTINUATION_ATTESTATIONS.set(attestation, {
    request,
    auth_job: authJob,
    auth_verification: authVerification,
    effect_authorization: effectAuthorization,
    context,
    context_sha256: stableSha256(context),
    evidence: deepFreeze(clone(evidence)),
  });
  return attestation;
}

export function resolveAuthenticationResume(hostCapabilities = {}, context = {}) {
  const binding = isObject(hostCapabilities) ? CONTINUATION_ATTESTATIONS.get(hostCapabilities) : null;
  const automatic = continuationContextMatches(binding, context);
  return automatic
    ? {
        mode: 'automatic_same_thread_continuation',
        automatic_resume: true,
        continuation_method: binding.evidence.continuation_method,
        evidence_sha256: binding.evidence.client_evidence_sha256,
      }
    : { mode: 'persist_checkpoint_and_ask_user_to_continue', automatic_resume: false };
}

export async function runStructuredAuthJob({
  request,
  effectAuthorization,
  job,
  provisionRunId,
  candidateIdentity,
  spawnProcess,
  postAuthCheck,
  environment = {},
  allowedEnvironmentKeys = [],
  persistState,
  terminateTransport = null,
  abortSignal = null,
  timeoutMs = 5 * 60 * 1000,
} = {}) {
  validateCapabilityRequest(request);
  validateAuthJob(job);
  const authAuthorization = requireProvisionEffectAuthorization(effectAuthorization, request, 'authenticate', {
    capabilityId: job.capability_id,
    authJob: job,
    provisionRunId,
    candidateIdentity,
    requiredPermissions: job.validation.required_scope,
  });
  if (JSON.stringify(authAuthorization.target?.required_permissions ?? []) !==
      JSON.stringify(job.validation.required_scope)) {
    throw new TypeError('Auth job scope differs from its exact effect authorization.');
  }
  if (typeof spawnProcess !== 'function' || typeof postAuthCheck !== 'function' ||
      typeof persistState !== 'function') {
    throw new TypeError('Auth runner needs trusted process, persistence, and post-auth validation adapters.');
  }
  const authStateAuthority = deepFreeze({
    request_id: request.request.id,
    request_authority_sha256: capabilityRequestAuthorityDigest(request),
    provision_run_id: provisionRunId,
    candidate_identity: candidateIdentity,
    server_name: job.command.argv[3],
    auth_job_sha256: stableSha256(job),
    auth_effect_sha256: stableSha256(authAuthorization),
    required_scope: clone(job.validation.required_scope),
  });
  const persistAuthState = async (state) => persistState({
    schema_version: 1,
    kind: 'cruise_auth_job_state',
    id: job.id,
    capability_id: job.capability_id,
    ...authStateAuthority,
    ...state,
  });
  const allowlist = new Set(stringArray(allowedEnvironmentKeys, 'allowedEnvironmentKeys'));
  const env = Object.fromEntries(Object.entries(environment)
    .filter(([key, value]) => allowlist.has(key) && typeof value === 'string' &&
      !SENSITIVE_ARG.test(key) && !SENSITIVE_ARG.test(value)));
  const [file, ...args] = job.command.argv;
  if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs < 1)) {
    throw new TypeError('Auth runner timeout must be null or a positive integer.');
  }
  await persistAuthState({
    status: 'running',
    confirmed: false,
  });
  const controller = new AbortController();
  const startedAt = Date.now();
  const spawnOutcome = Promise.resolve().then(() => spawnProcess(file, args, {
      shell: false,
      env,
      stdio: 'redacted-capture',
      signal: controller.signal,
    })).then(
      (value) => ({ type: 'process', value }),
      () => ({ type: 'process_error' }),
    );
  let timer = null;
  let abortListener = null;
  const timeout = new Promise((resolveTimeout) => {
    if (timeoutMs !== null) {
      timer = setTimeout(() => resolveTimeout({ type: 'timed_out' }), timeoutMs);
    }
  });
  const cancelled = new Promise((resolveCancelled) => {
    if (abortSignal?.aborted) resolveCancelled({ type: 'cancelled' });
    else if (abortSignal?.addEventListener) {
      abortListener = () => resolveCancelled({ type: 'cancelled' });
      abortSignal.addEventListener('abort', abortListener, { once: true });
    }
  });
  const outcome = await Promise.race([spawnOutcome, timeout, cancelled]);
  clearTimeout(timer);
  const cleanupAbortListener = () => {
    if (abortListener) abortSignal.removeEventListener('abort', abortListener);
    abortListener = null;
  };
  if (outcome.type === 'timed_out' || outcome.type === 'cancelled') {
    cleanupAbortListener();
    controller.abort();
    const result = { status: outcome.type, confirmed: false, reason: `native_auth_${outcome.type}` };
    await persistAuthState(result);
    return result;
  }
  if (outcome.type === 'process_error') {
    cleanupAbortListener();
    const result = { status: 'failed', confirmed: false, reason: 'native_auth_process_error' };
    await persistAuthState(result);
    return result;
  }
  const processResult = outcome.value;
  if (!isObject(processResult) || processResult.exit_code !== 0) {
    cleanupAbortListener();
    const result = { status: 'failed', confirmed: false, reason: 'native_auth_process_failed' };
    await persistAuthState(result);
    return result;
  }
  let check = null;
  let postAuthTimer = null;
  const remainingMs = timeoutMs === null ? null : timeoutMs - (Date.now() - startedAt);
  const postOutcome = remainingMs !== null && remainingMs <= 0
    ? { type: 'timed_out' }
    : await Promise.race([
        Promise.resolve().then(() => postAuthCheck({
          capability_id: job.capability_id,
          signal: controller.signal,
        })).then(
          (value) => ({ type: 'check', value }),
          () => ({ type: 'check_error' }),
        ),
        ...(remainingMs === null ? [] : [new Promise((resolvePostTimeout) => {
          postAuthTimer = setTimeout(() => resolvePostTimeout({ type: 'timed_out' }), remainingMs);
        })]),
        cancelled,
      ]);
  if (postAuthTimer) clearTimeout(postAuthTimer);
  cleanupAbortListener();
  if (postOutcome.type === 'timed_out' || postOutcome.type === 'cancelled') {
    controller.abort();
    const result = {
      status: postOutcome.type,
      confirmed: false,
      reason: postOutcome.type === 'cancelled'
        ? 'post_auth_validation_cancelled'
        : 'post_auth_validation_timed_out',
    };
    await persistAuthState(result);
    return result;
  }
  if (postOutcome.type === 'check_error') {
    const result = { status: 'failed', confirmed: false, reason: 'post_auth_validation_error' };
    await persistAuthState(result);
    return result;
  }
  check = postOutcome.value;
  if (!isObject(check) || check.ok !== true || !text(check.identity) ||
      !Array.isArray(check.scope) || check.scope.length === 0 || check.smoke_test_passed !== true) {
    const result = { status: 'unconfirmed', confirmed: false, reason: 'post_auth_validation_failed' };
    await persistAuthState(result);
    return result;
  }
  if (job.validation.identity_policy === 'exact' && check.identity !== job.validation.required_identity) {
    const rejected = { status: 'unconfirmed', confirmed: false, reason: 'post_auth_identity_mismatch' };
    await persistAuthState(rejected);
    return rejected;
  }
  if (SENSITIVE_ARG.test(check.identity) || check.scope.some((entry) =>
    typeof entry !== 'string' || SENSITIVE_ARG.test(entry))) {
    const rejected = { status: 'unconfirmed', confirmed: false, reason: 'post_auth_output_contains_sensitive_material' };
    await persistAuthState(rejected);
    return rejected;
  }
  const confirmedScope = canonicalStrings(stringArray(check.scope, 'auth scope'));
  if (JSON.stringify(confirmedScope) !== JSON.stringify(job.validation.required_scope)) {
    const rejected = { status: 'unconfirmed', confirmed: false, reason: 'post_auth_scope_mismatch' };
    await persistAuthState(rejected);
    return rejected;
  }
  const result = {
    status: 'succeeded',
    confirmed: true,
    identity: check.identity,
    scope: confirmedScope,
    smoke_test_passed: true,
    logs_redacted: true,
  };
  await persistAuthState(result);
  if (typeof terminateTransport === 'function') await terminateTransport({ job_id: job.id });
  return result;
}

export function reconcileCapabilityLoss({
  necessity,
  request = null,
  provisionRunId = null,
  nodeId = null,
  fallback = null,
  fallbackApproval = null,
  alternatePlanDecision = null,
  alternatePlanApproval = null,
  weakerEvidenceWaiver = null,
  weakerEvidenceWaiverApproval = null,
  waiverPermitted = false,
  outcomeScopeOrRequirementChanged = false,
} = {}) {
  if (!NECESSITY_LEVELS.includes(necessity)) throw new TypeError('Capability necessity is invalid.');
  if (outcomeScopeOrRequirementChanged === true) {
    return {
      reconciliation: {
        outcome: 'contract_revision_required',
        approval_invalidated: true,
        reapproval_required: true,
      },
    };
  }
  if (necessity === 'optional') return { reconciliation: { outcome: 'equivalent_fallback', action: 'skip_optional' } };
  const fallbackAuthority = isCapabilityFallbackApproval(fallbackApproval, {
    request,
    provisionRunId,
    nodeId,
    fallback,
  });
  const equivalent = fallbackAuthority && equivalentFallbackRecord(fallback);
  if (equivalent) return { reconciliation: { outcome: 'equivalent_fallback' } };
  const evidenceOnlyWeakening = fallbackAuthority && approvedFallbackRecord(fallback) &&
    fallback.equivalent_mandatory_evidence === false;
  if (evidenceOnlyWeakening && waiverPermitted === true && isObject(weakerEvidenceWaiver) &&
      weakerEvidenceWaiver.explicit === true &&
      /^D-[0-9]+$/u.test(weakerEvidenceWaiver.decision_id ?? '') &&
      CONTENT_SHA.test(weakerEvidenceWaiver.decision_sha256 ?? '') &&
      CONTENT_SHA.test(weakerEvidenceWaiver.affected_evidence_sha256 ?? '') &&
      isProvisionReconciliationApproval(weakerEvidenceWaiverApproval, {
        kind: 'weaker_evidence_waiver',
        request,
        provisionRunId,
        nodeId,
        record: weakerEvidenceWaiver,
      })) {
    return {
      reconciliation: {
        outcome: 'approved_alternate_plan_branch',
        evidence_waiver_id: weakerEvidenceWaiver.decision_id,
        decision_sha256: weakerEvidenceWaiver.decision_sha256,
        waiver_qualified_closeout: true,
      },
    };
  }
  if (necessity === 'preferred' && isObject(alternatePlanDecision) &&
      /^D-[0-9]+$/u.test(alternatePlanDecision.decision_id ?? '') &&
      alternatePlanDecision.approved === true &&
      CONTENT_SHA.test(alternatePlanDecision.plan_sha256 ?? '') &&
      CONTENT_SHA.test(alternatePlanDecision.approval_sha256 ?? '') &&
      isProvisionReconciliationApproval(alternatePlanApproval, {
        kind: 'alternate_plan',
        request,
        provisionRunId,
        nodeId,
        record: alternatePlanDecision,
      })) {
    return {
      reconciliation: {
        outcome: 'approved_alternate_plan_branch',
        decision_id: alternatePlanDecision.decision_id,
        plan_sha256: alternatePlanDecision.plan_sha256,
      },
    };
  }
  if (necessity === 'mandatory') return { reconciliation: { outcome: 'blocked' } };
  return { reconciliation: { outcome: 'contract_revision_required' } };
}

export function enforceProvisionBoundary(event) {
  if (!isObject(event)) throw new TypeError('Provision boundary event must be structured.');
  const violations = [];
  if (event.public_skill_invoked_recursively === true) violations.push('public_skill_recursion');
  if (event.public_surface_exposed === true) violations.push('private_surface_exposed');
  if (event.raw_external_content_in_privileged_context === true || hasRawContent(event.worker_context ?? {})) {
    violations.push('raw_external_content_leak');
  }
  if (event.trust_tier === 'uncertain' && (event.installed === true || event.executed === true)) {
    violations.push('uncertain_candidate_activated');
  }
  if (event.external === true && (!COMMIT_SHA.test(event.commit_sha ?? '') || !CONTENT_SHA.test(event.content_sha256 ?? ''))) {
    violations.push('external_revision_not_pinned_and_hashed');
  }
  if (event.star_count_is_sole_trust_control === true) violations.push('star_count_used_as_security_decision');
  if (event.direct_use === true && event.security_review_complete !== true) violations.push('missing_security_review');
  if (event.local_spin === true && (event.provenance_complete !== true || event.evals_passed !== true)) {
    violations.push('unevaluated_local_spin');
  }
  if (event.command_through_sh_c === true) violations.push('shell_command_interpolation');
  if (event.secrets_present === true) violations.push('secret_in_artifact');
  if (event.host_configuration_modified === true && event.host_configuration_authorized !== true) {
    violations.push('unauthorized_host_configuration_change');
  }
  if (event.excluded === true && event.entered_context === true) violations.push('excluded_capability_loaded');
  if (event.claimed_sandbox_strength &&
      event.claimed_sandbox_strength !== event.observed_sandbox_strength) {
    violations.push('sandbox_claim_exceeds_host');
  }
  if (violations.length > 0) {
    const error = new Error(`Provision boundary rejected: ${violations.join(', ')}`);
    error.code = 'CRUISE_PROVISION_BOUNDARY';
    error.violations = violations;
    throw error;
  }
  return { allowed: true, violations: [] };
}
