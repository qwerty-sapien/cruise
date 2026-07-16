import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { resolveModelPolicy } from './model-policy.mjs';
import {
  clearDisposableRepositoryArtifacts,
  repositoryGitPathspec,
} from './repository-scope.mjs';
import {
  assertYamlSchema,
  canonicalJson,
  parseYaml,
} from './yaml-state.mjs';

export const PUBLIC_ROUTES = Object.freeze([
  'build',
  'quick',
  'refine',
  'goal',
  'debug',
]);

/** Persisted schema-v1 records may contain this retired public route. */
export const LEGACY_PUBLIC_ROUTES = Object.freeze(['review', 'research']);

export const ROUTE_CONFIDENCE_THRESHOLD = 0.85;

const CLASSIFIER_BOOLEAN_FIELDS = Object.freeze([
  'public_api_change',
  'abi_change',
  'data_migration',
  'security_sensitive',
  'concurrency_sensitive',
  'build_or_release_change',
  'unknown_indirect_callers',
  'requires_external_research',
]);

const PROBE_SIGNAL_DEFAULTS = Object.freeze({
  public_api_change: false,
  abi_change: false,
  authentication_or_authorization: false,
  cryptography_secrets_or_privacy: false,
  data_or_serialization_migration: false,
  dependency_change: false,
  concurrency_ordering_cancellation_or_lifecycle: false,
  build_deployment_packaging_release_or_ci: false,
  unknown_indirect_callers: false,
  reflection_registration_or_dynamic_dispatch: false,
  meaningful_external_side_effects: false,
  insufficient_testability: false,
  repository_evidence_conflict: false,
  scope_materially_exceeded: false,
  root_cause_unknown: false,
  requires_external_research: false,
  material_design_choice: false,
  durable_continuation_required: false,
  cross_system_program: false,
  failed_quick_repairs: 0,
});

/** Seventeen semantic gates plus append-only Quick repair-history telemetry. */
export const QUICK_ASSESSMENT_SIGNALS = Object.freeze([
  'public_api_change',
  'abi_change',
  'authentication_or_authorization',
  'cryptography_secrets_or_privacy',
  'data_or_serialization_migration',
  'dependency_change',
  'concurrency_ordering_cancellation_or_lifecycle',
  'build_deployment_packaging_release_or_ci',
  'unknown_indirect_callers',
  'reflection_registration_or_dynamic_dispatch',
  'meaningful_external_side_effects',
  'insufficient_testability',
  'repository_evidence_conflict',
  'scope_materially_exceeded',
  'failed_quick_repairs',
  'root_cause_unknown',
  'requires_external_research',
  'material_design_choice',
]);

// Backward-compatible public name for packet/schema consumers. The
// failed_quick_repairs member is telemetry and is not itself a hard gate.
export const QUICK_HARD_GATE_SIGNALS = QUICK_ASSESSMENT_SIGNALS;

const PROBE_FACT_SIGNALS = Object.freeze(Object.keys(PROBE_SIGNAL_DEFAULTS));
const MAX_FACT_BASES = 8;
const DEFAULT_PROBE_BUDGETS = Object.freeze({
  git_command_timeout_ms: 10_000,
  git_command_max_bytes: 8 * 1024 * 1024,
  prompt_max_bytes: 4 * 1024 * 1024,
  semantic_evidence_file_max_bytes: 1024 * 1024,
  semantic_evidence_total_max_bytes: 4 * 1024 * 1024,
});

const PROMPT_GATE_PATTERNS = Object.freeze({
  abi_change: /\b(?:abi|binary\s+compatibility|calling\s+convention)\b/iu,
  cryptography_secrets_or_privacy: /\b(?:cryptograph\w*|encrypt\w*|secret\w*|privacy|personal\s+data|pii)\b/iu,
  data_or_serialization_migration: /\b(?:data\s+migration|schema\s+migration|serializ\w*|wire\s+format|database\s+schema)\b/iu,
  dependency_change: /\b(?:add|install|upgrade|remove|replace)\s+(?:a\s+)?(?:dependency|package|library)\b|\blockfile\b/iu,
  concurrency_ordering_cancellation_or_lifecycle: /\b(?:concurren\w*|race\s+condition|deadlock|ordering|cancellation|lifecycle)\b/iu,
  build_deployment_packaging_release_or_ci: /\b(?:build\s+system|deployment|deploy|packaging|release|ci\/?cd|github\s+actions)\b/iu,
  unknown_indirect_callers: /\b(?:unknown|indirect|external)\s+callers?\b/iu,
  reflection_registration_or_dynamic_dispatch: /\b(?:reflection|registration|registry|dynamic\s+dispatch|dependency\s+injection)\b/iu,
  meaningful_external_side_effects: /\b(?:publish|purchase|charge|send\s+(?:a\s+)?message|production\s+write|remote\s+write)\b/iu,
  insufficient_testability: /\b(?:cannot|can't|unable\s+to)\s+(?:test|verify)|\bno\s+(?:test|verification)\b/iu,
  repository_evidence_conflict: /\b(?:repository|code|implementation)\s+(?:conflicts?|disagrees?|contradicts?)\b/iu,
  scope_materially_exceeded: /\b(?:scope\s+(?:expanded|grew|exceeded)|larger\s+than\s+expected)\b/iu,
  failed_quick_repairs: /\b(?:two|2)\s+(?:failed\s+)?(?:repairs?|fix\s+attempts?|attempts?)\b/iu,
  root_cause_unknown: /\b(?:unknown|unclear|intermittent)\s+(?:root\s+)?cause\b|\bintermittent\s+(?:hang|failure|crash)\b/iu,
  requires_external_research: /\b(?:external\s+research|research\s+first|compare\s+(?:libraries|approaches|options)|latest\s+(?:docs|documentation))\b/iu,
  material_design_choice: /\b(?:design\s+choice|choose\s+between|architecture\s+decision|behavior\s+decision)\b/iu,
});

const PUBLIC_API_TARGET = String.raw`(?:public\s+api|exported\s+(?:api|method|function|class|type)|downstream\s+api)`;
const AUTH_TARGET = String.raw`(?:oauth|oidc|sso|authentication|authorization|access\s+control|login\s+(?:flow|handler|endpoint|implementation))`;
const CHANGE_VERB = String.raw`(?:add|implement|introduce|remove|rename|change|modify|update|edit|deprecate|replace|expose|export|configure|enforce|secure|fix|deploy|publish|send|install|upgrade|migrate|rotate|encrypt)`;
const CHANGED_VERB = String.raw`(?:added|implemented|introduced|removed|renamed|changed|modified|updated|edited|deprecated|replaced|exposed|exported|configured|enforced|secured|fixed|deployed|published|sent|installed|upgraded|migrated|released|rotated|encrypted)`;
const EXPLICIT_TEXT_ONLY_DOCUMENTATION = /\b(?:typo|spelling|wording|punctuation|grammar)\b[\s\S]{0,100}\b(?:documentation|docs?|readme|comment|copy|text)\b|\b(?:documentation|docs?|readme|comment|copy|text)\b[\s\S]{0,100}\b(?:typo|spelling|wording|punctuation|grammar)\b/iu;
const DIRECT_DOCUMENTATION_EDIT = /\b(?:add|remove|fix|correct|edit|update|rewrite|clarify|change)\b[\s\S]{0,100}\b(?:documentation|docs?|readme|comment|copy|wording|text)\b/iu;
const RELEASE_ACTION = /\brelease\s+(?:the\s+)?(?:package|build|artifact|version)\b/iu;

function requestedTargetChange(rawPrompt, targetPattern) {
  const verbThenTarget = new RegExp(
    String.raw`\b${CHANGE_VERB}\b[\s\S]{0,100}\b${targetPattern}\b`,
    'iu',
  );
  const targetThenVerb = new RegExp(
    String.raw`\b${targetPattern}\b[\s\S]{0,100}\b(?:(?:must|should|needs?)\s+(?:to\s+)?be\s+)?(?:${CHANGE_VERB}|${CHANGED_VERB})\b`,
    'iu',
  );
  return verbThenTarget.test(rawPrompt) || targetThenVerb.test(rawPrompt);
}

export const PROBE_ENRICHMENT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'prompt_sha256',
    'repository_baseline_digest',
    'assessed_quick_gates',
    'facts',
  ],
  properties: Object.freeze({
    schema_version: { const: 1 },
    prompt_sha256: { type: 'string', format: 'sha256' },
    repository_baseline_digest: { type: 'string', format: 'sha256' },
    assessed_quick_gates: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', enum: QUICK_HARD_GATE_SIGNALS },
    },
    facts: {
      type: 'array',
      minItems: QUICK_HARD_GATE_SIGNALS.length,
      maxItems: QUICK_HARD_GATE_SIGNALS.length,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'signal', 'value', 'basis'],
        properties: {
          id: { type: 'string', pattern: '^PF-\\d{2,}$' },
          signal: { type: 'string', enum: QUICK_HARD_GATE_SIGNALS },
          value: { type: ['boolean', 'integer'] },
          basis: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_FACT_BASES,
            uniqueItems: true,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'locator', 'sha256'],
              properties: {
                kind: {
                  type: 'string',
                  enum: ['prompt_span', 'repository_file', 'repository_baseline'],
                },
                locator: { type: 'string', minLength: 1, maxLength: 1000 },
                sha256: { type: 'string', format: 'sha256' },
              },
            },
          },
        },
      },
    },
  }),
});

const DEFAULT_PROBE_LIMITS = Object.freeze({
  instruction_files: 32,
  likely_target_files: 64,
  likely_symbols: 64,
  references: 128,
  nearby_tests: 64,
  status_entries: 128,
});

const STRING_LIST_SCHEMA = Object.freeze({
  type: 'array',
  uniqueItems: true,
  items: { type: 'string', minLength: 1 },
});

export const DETERMINISTIC_PROBE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'repository',
    'limits',
    'budgets',
    'usage',
    'instruction_files',
    'likely_target_files',
    'likely_symbols',
    'references',
    'nearby_tests',
    'status_entries',
    'signals',
    'semantic_facts',
    'acquisition',
    'existing_cruise_state',
    'truncated',
  ],
  properties: Object.freeze({
    schema_version: { const: 2 },
    repository: {
      type: 'object',
      additionalProperties: false,
      required: ['root', 'head', 'branch', 'dirty'],
      properties: {
        root: { type: ['string', 'null'] },
        head: { type: ['string', 'null'] },
        branch: { type: ['string', 'null'] },
        dirty: { type: 'boolean' },
      },
    },
    limits: {
      type: 'object',
      additionalProperties: false,
      required: Object.keys(DEFAULT_PROBE_LIMITS),
      properties: Object.fromEntries(
        Object.keys(DEFAULT_PROBE_LIMITS).map((key) => [key, { type: 'integer', minimum: 1 }]),
      ),
    },
    budgets: {
      type: 'object',
      additionalProperties: false,
      required: Object.keys(DEFAULT_PROBE_BUDGETS),
      properties: Object.fromEntries(
        Object.keys(DEFAULT_PROBE_BUDGETS).map((key) => [key, { type: 'integer', minimum: 1 }]),
      ),
    },
    usage: {
      type: 'object',
      additionalProperties: false,
      required: ['git_status_bytes', 'semantic_evidence_bytes'],
      properties: {
        git_status_bytes: { type: 'integer', minimum: 0 },
        semantic_evidence_bytes: { type: 'integer', minimum: 0 },
      },
    },
    instruction_files: STRING_LIST_SCHEMA,
    likely_target_files: STRING_LIST_SCHEMA,
    likely_symbols: STRING_LIST_SCHEMA,
    references: STRING_LIST_SCHEMA,
    nearby_tests: STRING_LIST_SCHEMA,
    status_entries: STRING_LIST_SCHEMA,
    signals: {
      type: 'object',
      additionalProperties: false,
      required: PROBE_FACT_SIGNALS,
      properties: Object.fromEntries(PROBE_FACT_SIGNALS.map((signal) => [
        signal,
        signal === 'failed_quick_repairs'
          ? { type: 'integer', minimum: 0 }
          : { type: 'boolean' },
      ])),
    },
    semantic_facts: {
      ...PROBE_ENRICHMENT_SCHEMA.properties.facts,
      minItems: 0,
    },
    acquisition: {
      type: 'object',
      additionalProperties: false,
      required: [
        'status',
        'method',
        'prompt_sha256',
        'repository_baseline_digest',
        'assessed_quick_gates',
        'enrichment_digest',
      ],
      properties: {
        status: { type: 'string', enum: ['pending', 'complete'] },
        method: {
          type: 'string',
          enum: [
            'bounded_repository_identity',
            'direct_library_input',
            'evidence_bound_semantic_assessment',
          ],
        },
        prompt_sha256: { type: ['string', 'null'], format: 'sha256' },
        repository_baseline_digest: { type: ['string', 'null'], format: 'sha256' },
        assessed_quick_gates: {
          type: 'array',
          uniqueItems: true,
          items: { type: 'string', enum: QUICK_HARD_GATE_SIGNALS },
        },
        prompt_derived_signals: {
          type: 'array',
          uniqueItems: true,
          items: { type: 'string', enum: QUICK_HARD_GATE_SIGNALS },
        },
        enrichment_digest: { type: ['string', 'null'], format: 'sha256' },
      },
    },
    existing_cruise_state: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['root_kind', 'goal_kind', 'runs_kind'],
      properties: {
        root_kind: { type: ['string', 'null'] },
        goal_kind: { type: ['string', 'null'] },
        runs_kind: { type: ['string', 'null'] },
      },
    },
    truncated: {
      type: 'object',
      additionalProperties: false,
      required: [
        ...Object.keys(DEFAULT_PROBE_LIMITS),
        'git_command_bytes',
        'semantic_evidence_bytes',
      ],
      properties: Object.fromEntries([
        ...Object.keys(DEFAULT_PROBE_LIMITS),
        'git_command_bytes',
        'semantic_evidence_bytes',
      ].map((key) => [key, { type: 'boolean' }])),
    },
  }),
});

export const CLASSIFIER_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'route',
    'recommended_level',
    'confidence',
    'ambiguity',
    'semantic_risk',
    'estimated_files',
    'estimated_diff_lines',
    ...CLASSIFIER_BOOLEAN_FIELDS,
    'reasons',
  ],
  properties: Object.freeze({
    route: { type: 'string', enum: PUBLIC_ROUTES },
    recommended_level: { type: 'integer', minimum: 2, maximum: 7 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    ambiguity: { type: 'string', enum: ['low', 'medium', 'high'] },
    semantic_risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    estimated_files: { type: 'integer', minimum: 0 },
    estimated_diff_lines: { type: 'integer', minimum: 0 },
    public_api_change: { type: 'boolean' },
    abi_change: { type: 'boolean' },
    data_migration: { type: 'boolean' },
    security_sensitive: { type: 'boolean' },
    concurrency_sensitive: { type: 'boolean' },
    build_or_release_change: { type: 'boolean' },
    unknown_indirect_callers: { type: 'boolean' },
    requires_external_research: { type: 'boolean' },
    reasons: {
      type: 'array',
      maxItems: 32,
      items: { type: 'string', minLength: 1, maxLength: 500 },
    },
  }),
});

function assertRoute(route, label = 'route') {
  if (!PUBLIC_ROUTES.includes(route)) {
    throw new TypeError(`${label} must be one of ${PUBLIC_ROUTES.join(', ')}`);
  }
  return route;
}

function boundedStringList(value, limit, label) {
  if (value == null) return { values: [], truncated: false };
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const normalized = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new TypeError(`${label} entries must be non-empty strings`);
    }
    const text = item.trim();
    if (!seen.has(text)) {
      seen.add(text);
      normalized.push(text);
    }
  }
  normalized.sort((left, right) => left.localeCompare(right, 'en'));
  return {
    values: normalized.slice(0, limit),
    truncated: normalized.length > limit,
  };
}

function normalizeLimits(limits) {
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULT_PROBE_LIMITS)) {
    const requested = limits?.[key] ?? fallback;
    if (!Number.isInteger(requested) || requested < 1 || requested > 10_000) {
      throw new TypeError(`probe limit ${key} must be an integer from 1 through 10000`);
    }
    result[key] = requested;
  }
  return result;
}

function normalizeBudgets(budgets) {
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULT_PROBE_BUDGETS)) {
    const requested = budgets?.[key] ?? fallback;
    if (!Number.isInteger(requested) || requested < 1 || requested > 64 * 1024 * 1024) {
      throw new TypeError(`probe budget ${key} must be an integer from 1 through 67108864`);
    }
    result[key] = requested;
  }
  return result;
}

function normalizeSignals(signals = {}) {
  if (!signals || typeof signals !== 'object' || Array.isArray(signals)) {
    throw new TypeError('probe signals must be an object');
  }
  const unknown = Object.keys(signals).filter(
    (key) => !Object.hasOwn(PROBE_SIGNAL_DEFAULTS, key),
  );
  if (unknown.length > 0) {
    throw new TypeError(`unknown deterministic probe signal(s): ${unknown.join(', ')}`);
  }
  const normalized = { ...PROBE_SIGNAL_DEFAULTS, ...signals };
  for (const [key, value] of Object.entries(normalized)) {
    if (key === 'failed_quick_repairs') {
      if (!Number.isInteger(value) || value < 0) {
        throw new TypeError('failed_quick_repairs must be a non-negative integer');
      }
    } else if (typeof value !== 'boolean') {
      throw new TypeError(`probe signal ${key} must be boolean`);
    }
  }
  return normalized;
}

/**
 * Bound and canonicalize low-cost repository evidence. Expensive discovery is
 * deliberately left to callers; this function prevents an unbounded evidence
 * dump from becoming classifier context.
 */
export function createDeterministicProbe({
  repository = {},
  instructionFiles = [],
  likelyTargetFiles = [],
  likelySymbols = [],
  references = [],
  nearbyTests = [],
  statusEntries = [],
  signals = {},
  existingCruiseState = null,
  limits = null,
  budgets = null,
  usage = null,
  acquisition = null,
  semanticFacts = [],
} = {}) {
  const bounded = normalizeLimits(limits);
  const boundedBudgets = normalizeBudgets(budgets);
  const lists = {
    instruction_files: boundedStringList(
      instructionFiles,
      bounded.instruction_files,
      'instructionFiles',
    ),
    likely_target_files: boundedStringList(
      likelyTargetFiles,
      bounded.likely_target_files,
      'likelyTargetFiles',
    ),
    likely_symbols: boundedStringList(likelySymbols, bounded.likely_symbols, 'likelySymbols'),
    references: boundedStringList(references, bounded.references, 'references'),
    nearby_tests: boundedStringList(nearbyTests, bounded.nearby_tests, 'nearbyTests'),
    status_entries: boundedStringList(statusEntries, bounded.status_entries, 'statusEntries'),
  };
  const root = repository.root == null ? null : String(repository.root);
  const probe = {
    schema_version: 2,
    repository: {
      root,
      head: repository.head ?? null,
      branch: repository.branch ?? null,
      dirty: Boolean(repository.dirty),
    },
    limits: bounded,
    budgets: boundedBudgets,
    usage: {
      git_status_bytes: usage?.git_status_bytes ?? 0,
      semantic_evidence_bytes: usage?.semantic_evidence_bytes ?? 0,
    },
    instruction_files: lists.instruction_files.values,
    likely_target_files: lists.likely_target_files.values,
    likely_symbols: lists.likely_symbols.values,
    references: lists.references.values,
    nearby_tests: lists.nearby_tests.values,
    status_entries: lists.status_entries.values,
    signals: normalizeSignals(signals),
    semantic_facts: structuredClone(semanticFacts),
    acquisition: acquisition == null
      ? {
          status: 'complete',
          method: 'direct_library_input',
          prompt_sha256: null,
          repository_baseline_digest: null,
          assessed_quick_gates: [...QUICK_HARD_GATE_SIGNALS],
          enrichment_digest: null,
        }
      : structuredClone(acquisition),
    existing_cruise_state: existingCruiseState,
    truncated: Object.fromEntries(
      [
        ...Object.entries(lists).map(([key, result]) => [key, result.truncated]),
        ['git_command_bytes', false],
        ['semantic_evidence_bytes', false],
      ],
    ),
  };
  return Object.freeze(probe);
}

function gitProbe(root, args, budgets) {
  return spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: budgets.git_command_timeout_ms,
    maxBuffer: budgets.git_command_max_bytes,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function pathKind(path) {
  try {
    const metadata = lstatSync(path);
    if (metadata.isDirectory()) return 'directory';
    if (metadata.isFile()) return 'file';
    if (metadata.isSymbolicLink()) return 'symlink';
    return 'special';
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Gather only cheap repository identity/status facts, then merge explicitly
 * supplied symbol and semantic evidence through the bounded normalizer.
 */
export function probeRepository({
  repositoryRoot,
  instructionFiles = [],
  likelyTargetFiles = [],
  likelySymbols = [],
  references = [],
  nearbyTests = [],
  signals = {},
  limits = null,
  budgets = null,
} = {}) {
  if (typeof repositoryRoot !== 'string' || !repositoryRoot.trim()) {
    throw new TypeError('repositoryRoot must be a non-empty path');
  }
  let root = realpathSync(resolve(repositoryRoot));
  clearDisposableRepositoryArtifacts(root);
  const boundedBudgets = normalizeBudgets(budgets);
  const rootResult = gitProbe(root, ['rev-parse', '--show-toplevel'], boundedBudgets);
  const isGit = rootResult.status === 0;
  if (isGit) root = realpathSync(String(rootResult.stdout).trim());

  let head = null;
  let branch = null;
  let statusEntries = [];
  if (isGit) {
    const headResult = gitProbe(root, ['rev-parse', '--verify', 'HEAD'], boundedBudgets);
    if (headResult.status === 0) head = String(headResult.stdout).trim();
    const branchResult = gitProbe(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], boundedBudgets);
    if (branchResult.status === 0) branch = String(branchResult.stdout).trim();
    const statusResult = gitProbe(root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=normal',
      '--',
      ...repositoryGitPathspec(),
    ], boundedBudgets);
    if (statusResult.status !== 0) {
      throw new Error(`could not gather bounded Git status: ${String(statusResult.stderr).trim()}`);
    }
    statusEntries = String(statusResult.stdout).split('\0').filter(Boolean);
  }

  const discoveredInstructions = [
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
    '.github/copilot-instructions.md',
  ].filter((path) => pathKind(join(root, path)) != null);
  const cruiseKind = pathKind(join(root, '.cruise'));
  return createDeterministicProbe({
    repository: {
      root,
      head,
      branch,
      dirty: statusEntries.length > 0,
    },
    instructionFiles: [...discoveredInstructions, ...instructionFiles],
    likelyTargetFiles,
    likelySymbols,
    references,
    nearbyTests,
    statusEntries,
    signals,
    existingCruiseState: cruiseKind == null
      ? null
      : {
          root_kind: cruiseKind,
          goal_kind: pathKind(join(root, '.cruise', 'goal')),
          runs_kind: pathKind(join(root, '.cruise', 'runs')),
        },
    limits,
    budgets: boundedBudgets,
    usage: {
      git_status_bytes: Buffer.byteLength(statusEntries.join('\0'), 'utf8'),
      semantic_evidence_bytes: 0,
    },
    acquisition: {
      status: 'pending',
      method: 'bounded_repository_identity',
      prompt_sha256: null,
      repository_baseline_digest: null,
      assessed_quick_gates: [],
      enrichment_digest: null,
    },
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function repositoryBaselineDigest(repositoryBaseline) {
  if (!repositoryBaseline || typeof repositoryBaseline !== 'object' || Array.isArray(repositoryBaseline)) {
    throw new TypeError('repository baseline must be an object');
  }
  return sha256(Buffer.from(canonicalJson(repositoryBaseline), 'utf8'));
}

function assertCompleteGateAssessment(value) {
  if (canonicalJson(value) !== canonicalJson(QUICK_HARD_GATE_SIGNALS)) {
    throw new TypeError('assessed_quick_gates must contain the exact ordered 17 semantic gates plus repair-history telemetry');
  }
}

function assertFactValues(facts) {
  if (facts.length !== QUICK_HARD_GATE_SIGNALS.length) {
    throw new TypeError('semantic facts must contain exactly 17 semantic gates plus repair-history telemetry');
  }
  const ids = new Set();
  const signals = new Set();
  for (const [index, fact] of facts.entries()) {
    const expectedId = `PF-${String(index + 1).padStart(2, '0')}`;
    const expectedSignal = QUICK_HARD_GATE_SIGNALS[index];
    if (fact.id !== expectedId || fact.signal !== expectedSignal) {
      throw new TypeError(
        `semantic fact ${index + 1} must preserve ${expectedId}/${expectedSignal}`,
      );
    }
    if (!QUICK_HARD_GATE_SIGNALS.includes(fact.signal)) {
      throw new TypeError(`semantic fact signal is not a Quick hard gate: ${fact.signal}`);
    }
    if (ids.has(fact.id)) throw new TypeError(`duplicate semantic fact id: ${fact.id}`);
    if (signals.has(fact.signal)) throw new TypeError(`duplicate semantic fact signal: ${fact.signal}`);
    ids.add(fact.id);
    signals.add(fact.signal);
    if (fact.signal === 'failed_quick_repairs') {
      if (!Number.isInteger(fact.value) || fact.value < 0) {
        throw new TypeError('failed_quick_repairs semantic fact must be a non-negative integer');
      }
    } else if (typeof fact.value !== 'boolean') {
      throw new TypeError(`semantic fact ${fact.signal} must be boolean`);
    }
  }
  const missing = QUICK_HARD_GATE_SIGNALS.filter((signal) => !signals.has(signal));
  if (missing.length > 0) {
    throw new TypeError(
      `every Quick hard gate requires an evidence-bound verdict; missing: ${missing.join(', ')}`,
    );
  }
}

export function derivePromptGateSignals(rawPrompt) {
  if (typeof rawPrompt !== 'string') throw new TypeError('rawPrompt must be a string');
  const signals = [];
  const mutationVerb = new RegExp(String.raw`\b${CHANGE_VERB}\b`, 'iu');
  for (const sentence of rawPrompt.split(/[;\n]/u).filter((part) => part.trim())) {
    const sentenceIsDocumentation =
      EXPLICIT_TEXT_ONLY_DOCUMENTATION.test(sentence) ||
      DIRECT_DOCUMENTATION_EDIT.test(sentence);
    const clauses = sentence.split(/\b(?:and|then)\b/iu).filter((clause) => clause.trim());
    for (const clause of clauses) {
      const clauseIsDocumentation =
        EXPLICIT_TEXT_ONLY_DOCUMENTATION.test(clause) ||
        DIRECT_DOCUMENTATION_EDIT.test(clause) ||
        (sentenceIsDocumentation && !mutationVerb.test(clause) && !RELEASE_ACTION.test(clause));
      if (clauseIsDocumentation) continue;
      for (const [signal, pattern] of Object.entries(PROMPT_GATE_PATTERNS)) {
        if (pattern.test(clause)) signals.push(signal);
      }
      if (requestedTargetChange(clause, PUBLIC_API_TARGET)) signals.push('public_api_change');
      if (requestedTargetChange(clause, AUTH_TARGET)) {
        signals.push('authentication_or_authorization');
      }
    }
  }
  return Object.freeze([...new Set(signals)]
    .sort((left, right) => left.localeCompare(right, 'en')));
}

function pathWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function verifyFactBasis({
  basis,
  rawPromptBytes,
  repositoryRoot,
  baselineDigest,
  byteBudget,
  budgets,
}) {
  if (basis.kind === 'prompt_span') {
    const match = /^bytes:(0|[1-9]\d*):(0|[1-9]\d*)$/u.exec(basis.locator);
    if (!match) throw new TypeError('prompt_span locator must be bytes:<start>:<end>');
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (end <= start || end > rawPromptBytes.length) {
      throw new TypeError('prompt_span locator must name a non-empty span inside the exact raw prompt');
    }
    if (sha256(rawPromptBytes.subarray(start, end)) !== basis.sha256) {
      throw new Error('prompt_span SHA-256 does not match the exact raw prompt bytes');
    }
    return;
  }
  if (basis.kind === 'repository_baseline') {
    if (basis.locator !== 'repository_baseline' || basis.sha256 !== baselineDigest) {
      throw new Error('repository_baseline basis must match the immutable baseline digest');
    }
    return;
  }
  if (isAbsolute(basis.locator) || basis.locator === '..' || basis.locator.startsWith('../')) {
    throw new TypeError('repository_file locator must be repository-relative');
  }
  const candidate = resolve(repositoryRoot, basis.locator);
  if (!pathWithin(repositoryRoot, candidate)) {
    throw new TypeError('repository_file locator escapes the repository root');
  }
  const repositoryRelative = relative(repositoryRoot, candidate);
  if (
    ['.cruise', '.git'].includes(repositoryRelative)
    || repositoryRelative.startsWith(`.cruise${sep}`)
    || repositoryRelative.startsWith(`.git${sep}`)
  ) {
    throw new TypeError('repository_file basis cannot cite mutable repository control state');
  }
  const metadata = lstatSync(candidate);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new TypeError('repository_file basis must name a regular non-symlink file');
  }
  if (metadata.size > budgets.semantic_evidence_file_max_bytes) {
    throw new RangeError(
      `repository_file basis exceeds ${budgets.semantic_evidence_file_max_bytes} bytes`,
    );
  }
  const real = realpathSync(candidate);
  if (!pathWithin(repositoryRoot, real)) {
    throw new TypeError('repository_file basis resolves outside the repository root');
  }
  const realRelative = relative(repositoryRoot, real);
  if (
    ['.cruise', '.git'].includes(realRelative)
    || realRelative.startsWith(`.cruise${sep}`)
    || realRelative.startsWith(`.git${sep}`)
  ) {
    throw new TypeError('repository_file basis cannot resolve into mutable repository control state');
  }
  byteBudget.files ??= new Set();
  if (!byteBudget.files.has(real)) {
    byteBudget.files.add(real);
    byteBudget.total += metadata.size;
  }
  if (byteBudget.total > budgets.semantic_evidence_total_max_bytes) {
    throw new RangeError(
      `semantic probe evidence exceeds ${budgets.semantic_evidence_total_max_bytes} bytes`,
    );
  }
  if (sha256(readFileSync(real)) !== basis.sha256) {
    throw new Error(`repository_file SHA-256 does not match ${basis.locator}`);
  }
}

/**
 * Turn a bounded identity probe into a semantic routing probe. The enrichment
 * records a verdict for every Quick gate; each verdict is tied to bytes that
 * this function verifies rather than to a classifier's prose explanation.
 */
export function enrichDeterministicProbe({
  probe,
  enrichment,
  rawPrompt,
  repositoryBaseline,
} = {}) {
  if (!probe || typeof probe !== 'object' || Array.isArray(probe)) {
    throw new TypeError('deterministic probe must be an object');
  }
  if (probe.acquisition?.status !== 'pending') {
    throw new Error('deterministic probe semantic enrichment is not pending');
  }
  if (typeof rawPrompt !== 'string') throw new TypeError('rawPrompt must be exact UTF-8 text');
  assertYamlSchema(enrichment, PROBE_ENRICHMENT_SCHEMA, { name: 'probe enrichment' });
  assertCompleteGateAssessment(enrichment.assessed_quick_gates);
  assertFactValues(enrichment.facts);
  const rawPromptBytes = Buffer.from(rawPrompt, 'utf8');
  const budgets = normalizeBudgets(probe.budgets);
  if (rawPromptBytes.length > budgets.prompt_max_bytes) {
    throw new RangeError(`raw prompt exceeds persisted probe budget ${budgets.prompt_max_bytes} bytes`);
  }
  const expectedPromptDigest = sha256(rawPromptBytes);
  const expectedBaselineDigest = repositoryBaselineDigest(repositoryBaseline);
  if (enrichment.prompt_sha256 !== expectedPromptDigest) {
    throw new Error('probe enrichment prompt_sha256 does not match immutable Origin');
  }
  if (enrichment.repository_baseline_digest !== expectedBaselineDigest) {
    throw new Error('probe enrichment repository_baseline_digest does not match immutable Origin');
  }
  if (realpathSync(resolve(probe.repository.root)) !== realpathSync(resolve(repositoryBaseline.root))) {
    throw new Error('probe repository root does not match immutable Origin');
  }
  const byteBudget = { total: 0 };
  for (const fact of enrichment.facts) {
    for (const basis of fact.basis) {
      verifyFactBasis({
        basis,
        rawPromptBytes,
        repositoryRoot: realpathSync(resolve(repositoryBaseline.root)),
        baselineDigest: expectedBaselineDigest,
        byteBudget,
        budgets,
      });
    }
  }
  const signals = { ...PROBE_SIGNAL_DEFAULTS };
  for (const fact of enrichment.facts) signals[fact.signal] = fact.value;
  const promptDerivedSignals = derivePromptGateSignals(rawPrompt);
  for (const signal of promptDerivedSignals) {
    signals[signal] = signal === 'failed_quick_repairs'
      ? Math.max(signals[signal], 2)
      : true;
  }
  const result = structuredClone(probe);
  result.signals = signals;
  result.semantic_facts = structuredClone(enrichment.facts);
  result.usage.semantic_evidence_bytes = byteBudget.total;
  result.acquisition = {
    status: 'complete',
    method: 'evidence_bound_semantic_assessment',
    prompt_sha256: expectedPromptDigest,
    repository_baseline_digest: expectedBaselineDigest,
    assessed_quick_gates: [...QUICK_HARD_GATE_SIGNALS],
    prompt_derived_signals: [...promptDerivedSignals],
    enrichment_digest: sha256(Buffer.from(canonicalJson({
      schema_version: 1,
      prompt_sha256: expectedPromptDigest,
      repository_baseline_digest: expectedBaselineDigest,
      assessed_quick_gates: [...QUICK_HARD_GATE_SIGNALS],
      facts: enrichment.facts,
    }), 'utf8')),
  };
  return Object.freeze(result);
}

/** Fail closed before the public runtime asks a model to classify. */
export function assertRuntimeProbeReady(probe, { rawPrompt, repositoryBaseline } = {}) {
  const rawPromptBytes = Buffer.from(rawPrompt, 'utf8');
  const expectedPromptDigest = sha256(rawPromptBytes);
  const expectedBaselineDigest = repositoryBaselineDigest(repositoryBaseline);
  if (
    probe?.acquisition?.status !== 'complete' ||
    probe?.acquisition?.method !== 'evidence_bound_semantic_assessment'
  ) {
    throw new Error('probe semantic enrichment is required before routing');
  }
  assertCompleteGateAssessment(probe.acquisition.assessed_quick_gates ?? []);
  if (probe.acquisition.prompt_sha256 !== expectedPromptDigest) {
    throw new Error('completed probe is not bound to the immutable raw prompt');
  }
  if (probe.acquisition.repository_baseline_digest !== expectedBaselineDigest) {
    throw new Error('completed probe is not bound to the immutable repository baseline');
  }
  if (!Array.isArray(probe.semantic_facts)) throw new TypeError('completed probe semantic_facts are required');
  const reconstructedEnrichment = {
    schema_version: 1,
    prompt_sha256: expectedPromptDigest,
    repository_baseline_digest: expectedBaselineDigest,
    assessed_quick_gates: [...QUICK_HARD_GATE_SIGNALS],
    facts: probe.semantic_facts,
  };
  assertYamlSchema(reconstructedEnrichment, PROBE_ENRICHMENT_SCHEMA, {
    name: 'persisted probe enrichment',
  });
  assertFactValues(probe.semantic_facts);
  const enrichmentDigest = sha256(Buffer.from(canonicalJson(reconstructedEnrichment), 'utf8'));
  if (probe.acquisition.enrichment_digest !== enrichmentDigest) {
    throw new Error('persisted probe enrichment digest does not match its semantic facts');
  }
  const budgets = normalizeBudgets(probe.budgets);
  if (rawPromptBytes.length > budgets.prompt_max_bytes) {
    throw new RangeError(`raw prompt exceeds persisted probe budget ${budgets.prompt_max_bytes} bytes`);
  }
  const byteBudget = { total: 0 };
  for (const fact of probe.semantic_facts) {
    for (const basis of fact.basis) {
      verifyFactBasis({
        basis,
        rawPromptBytes,
        repositoryRoot: realpathSync(resolve(repositoryBaseline.root)),
        baselineDigest: expectedBaselineDigest,
        byteBudget,
        budgets,
      });
    }
  }
  if (probe.usage?.semantic_evidence_bytes !== byteBudget.total) {
    throw new Error('persisted semantic evidence byte usage does not match verified evidence');
  }
  const derived = { ...PROBE_SIGNAL_DEFAULTS };
  for (const fact of probe.semantic_facts) derived[fact.signal] = fact.value;
  const promptDerivedSignals = derivePromptGateSignals(rawPrompt);
  for (const signal of promptDerivedSignals) {
    derived[signal] = signal === 'failed_quick_repairs'
      ? Math.max(derived[signal], 2)
      : true;
  }
  if (canonicalJson(promptDerivedSignals) !== canonicalJson(probe.acquisition.prompt_derived_signals)) {
    throw new Error('persisted prompt-derived signals do not match the immutable raw prompt');
  }
  if (canonicalJson(derived) !== canonicalJson(normalizeSignals(probe.signals))) {
    throw new Error('probe signals do not match the persisted semantic facts');
  }
  return true;
}

export function deterministicProbeDigest(probe) {
  assertYamlSchema(probe, DETERMINISTIC_PROBE_SCHEMA, { name: 'deterministic probe' });
  return createHash('sha256').update(canonicalJson(probe), 'utf8').digest('hex');
}

export function normalizeClassifierOutput(output) {
  let parsed;
  try {
    parsed = typeof output === 'string' ? parseYaml(output) : output;
  } catch (cause) {
    throw new TypeError('classifier output must be valid structured YAML', { cause });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('classifier output must be a structured object or YAML mapping');
  }
  const forbidden = ['analysis', 'chain_of_thought', 'chainOfThought', 'reasoning', 'rationale'];
  const disclosed = forbidden.filter((key) => Object.hasOwn(parsed, key));
  if (disclosed.length > 0) {
    throw new TypeError(
      `classifier output must not contain hidden reasoning fields: ${disclosed.join(', ')}`,
    );
  }
  assertYamlSchema(parsed, CLASSIFIER_OUTPUT_SCHEMA, { name: 'route classifier output' });
  return Object.freeze({
    route: parsed.route,
    recommended_level: parsed.recommended_level,
    confidence: parsed.confidence,
    ambiguity: parsed.ambiguity,
    semantic_risk: parsed.semantic_risk,
    estimated_files: parsed.estimated_files,
    estimated_diff_lines: parsed.estimated_diff_lines,
    ...Object.fromEntries(
      CLASSIFIER_BOOLEAN_FIELDS.map((field) => [field, parsed[field]]),
    ),
    reasons: Object.freeze([...parsed.reasons]),
  });
}

const CLASSIFIER_TO_PROBE = Object.freeze({
  public_api_change: 'public_api_change',
  abi_change: 'abi_change',
  data_migration: 'data_or_serialization_migration',
  security_sensitive: 'cryptography_secrets_or_privacy',
  concurrency_sensitive: 'concurrency_ordering_cancellation_or_lifecycle',
  build_or_release_change: 'build_deployment_packaging_release_or_ci',
  unknown_indirect_callers: 'unknown_indirect_callers',
  requires_external_research: 'requires_external_research',
});

const GOAL_PROMOTION_SIGNALS = new Set([
  'public_api_change',
  'abi_change',
  'authentication_or_authorization',
  'cryptography_secrets_or_privacy',
  'data_or_serialization_migration',
  'dependency_change',
  'concurrency_ordering_cancellation_or_lifecycle',
  'build_deployment_packaging_release_or_ci',
  'meaningful_external_side_effects',
  'durable_continuation_required',
  'cross_system_program',
]);

function combinedPromotionSignals(probe, classifier) {
  const values = { ...normalizeSignals(probe?.signals ?? {}) };
  for (const [classifierField, probeField] of Object.entries(CLASSIFIER_TO_PROBE)) {
    if (classifier[classifierField]) values[probeField] = true;
  }
  return values;
}

/** Apply the non-negotiable Quick semantic gates without using file count alone. */
export function applyQuickPromotion({ selectedSkill, proposedRoute, probe, classifier }) {
  assertRoute(selectedSkill, 'selectedSkill');
  assertRoute(proposedRoute, 'proposedRoute');
  if (selectedSkill !== 'quick') {
    return { route: proposedRoute, promotion_reasons: [] };
  }
  const signals = combinedPromotionSignals(probe, classifier);
  const reasons = Object.entries(signals)
    // failed_quick_repairs is append-only telemetry, not a universal hidden
    // retry budget. Unknown cause, scope growth, conflicting evidence, or an
    // explicit workflow stop condition provides the semantic promotion signal.
    .filter(([key, value]) => key !== 'failed_quick_repairs' && value === true)
    .map(([key]) => key)
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (reasons.length === 0) {
    return { route: proposedRoute, promotion_reasons: [] };
  }
  if (signals.root_cause_unknown) {
    return { route: 'debug', promotion_reasons: reasons };
  }
  if (reasons.some((reason) => GOAL_PROMOTION_SIGNALS.has(reason))) {
    return { route: 'goal', promotion_reasons: reasons };
  }
  return { route: 'refine', promotion_reasons: reasons };
}

function classifierRequest({
  selectedSkill,
  rawPrompt,
  probe,
  probeDigest,
  policy,
  previousOutput = null,
}) {
  return Object.freeze({
    selected_skill: selectedSkill,
    exact_raw_request: rawPrompt,
    deterministic_probe: probe,
    deterministic_probe_digest: probeDigest,
    previous_classifier_output: previousOutput,
    model_policy: policy,
    structured_output_only: true,
    output_schema: CLASSIFIER_OUTPUT_SCHEMA,
    hidden_chain_of_thought: 'not requested, not provided, and must not be imitated',
  });
}

/**
 * Run Luna Medium once, Terra Medium once only below threshold, then perform
 * semantic admission. Persistent uncertainty honors the explicit selection.
 */
export async function classifyRoute({
  selectedSkill,
  probe,
  rawPrompt,
  classify,
  modelCatalog = [],
  confidenceThreshold = ROUTE_CONFIDENCE_THRESHOLD,
} = {}) {
  assertRoute(selectedSkill, 'selectedSkill');
  if (typeof rawPrompt !== 'string') throw new TypeError('exact rawPrompt is required');
  if (typeof classify !== 'function') throw new TypeError('classify callback is required');
  if (!probe || typeof probe !== 'object') throw new TypeError('deterministic probe is required');
  if (
    typeof confidenceThreshold !== 'number' ||
    confidenceThreshold <= 0 ||
    confidenceThreshold > 1
  ) {
    throw new TypeError('confidenceThreshold must be greater than 0 and at most 1');
  }

  const probeDigest = deterministicProbeDigest(probe);
  const initialPolicy = resolveModelPolicy({
    stage: 'initial_classification',
    catalog: modelCatalog,
    requested: { tier: 'luna', reasoning_effort: 'medium' },
    attemptNumber: 1,
  });
  const initial = normalizeClassifierOutput(await classify(classifierRequest({
    selectedSkill,
    rawPrompt,
    probe,
    probeDigest,
    policy: initialPolicy,
  })));

  const attempts = [{ policy: initialPolicy, output: initial }];
  let final = initial;
  if (initial.confidence < confidenceThreshold) {
    const retryPolicy = resolveModelPolicy({
      stage: 'initial_classification',
      catalog: modelCatalog,
      requested: { tier: 'terra', reasoning_effort: 'medium' },
      attemptNumber: 2,
      escalationReason: `classifier confidence ${initial.confidence} below ${confidenceThreshold}`,
    });
    final = normalizeClassifierOutput(await classify(classifierRequest({
      selectedSkill,
      rawPrompt,
      probe,
      probeDigest,
      policy: retryPolicy,
      previousOutput: initial,
    })));
    attempts.push({ policy: retryPolicy, output: final });
  }

  const uncertain = final.confidence < confidenceThreshold;
  const proposedRoute = uncertain ? selectedSkill : final.route;
  const admission = applyQuickPromotion({
    selectedSkill,
    proposedRoute,
    probe,
    classifier: final,
  });
  return Object.freeze({
    schema_version: 1,
    selected_skill: selectedSkill,
    selected_route: admission.route,
    classifier_route: final.route,
    recommended_level: final.recommended_level,
    confidence: final.confidence,
    ambiguity: final.ambiguity,
    semantic_risk: final.semantic_risk,
    uncertain,
    deterministic_probe_digest: probeDigest,
    initial_classifier: attempts[0],
    retry_classifier: attempts[1] ?? null,
    attempts: Object.freeze(attempts),
    promotion_reasons: Object.freeze(admission.promotion_reasons),
  });
}

export function classifierLabel(attempt) {
  const policy = attempt?.policy;
  if (!policy) throw new TypeError('classifier attempt with model policy is required');
  const model = policy.resolved.model_id ?? 'host-default';
  const effort = policy.resolved.reasoning_effort ?? 'host-default';
  return `${model} ${effort}`;
}
