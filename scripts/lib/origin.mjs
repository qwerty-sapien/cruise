import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { LEGACY_PUBLIC_ROUTES, PUBLIC_ROUTES } from './routing.mjs';
import { assertYamlSchema, canonicalJson } from './yaml-state.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const TRACE_ID = /^(?:G|R|AC|D|T|E|F|H)-\d{2,}$/u;
export const BUILD_IDENTIFIER_PATTERN = /^(?:PRJ|M|R|AC|D|Q|P|RSK|C|QI)-\d{2,}$/u;
const PROJECT_ID = /^PRJ-\d{2,}$/u;
const MILESTONE_ID = /^M-\d{2,}$/u;
const BUILD_MODES = Object.freeze(['bootstrap', 'milestone']);
const GOAL_FIELDS = new Set([
  'outcome',
  'non_negotiables',
  'success_criteria',
  'exclusions',
  'permitted_inferences',
  'unresolved_questions',
]);
const BUILD_FIELDS_BY_NAMESPACE = Object.freeze({
  PRJ: Object.freeze([
    'project.outcome',
    'project.beneficiary',
    'project.core_value',
    'project.invariant',
    'project.non_goal',
    'project.constraint',
    'project.success_measure',
    'project.terminology',
  ]),
  M: Object.freeze([
    'milestone.outcome',
    'milestone.beneficiary',
    'milestone.scope',
    'milestone.non_goal',
    'milestone.completion_evidence',
    'milestone.constraint',
    'milestone.release_strategy',
    'milestone.rollback_strategy',
    'milestone.permission',
    'milestone.status',
  ]),
  R: Object.freeze([
    'requirement.statement',
    'requirement.owner',
    'requirement.prerequisite',
    'requirement.verification',
    'requirement.status',
  ]),
  AC: Object.freeze([
    'acceptance_criterion.statement',
    'acceptance_criterion.verification',
    'acceptance_criterion.status',
  ]),
  D: Object.freeze([
    'decision.status',
    'decision.context',
    'decision.resolution',
    'decision.rationale',
    'decision.consequences',
  ]),
  Q: Object.freeze([
    'question.status',
    'question.question',
    'question.answer',
    'question.recommendation',
    'question.options',
    'question.source',
    'question.affects',
    'question.reopening_condition',
  ]),
  P: Object.freeze([
    'phase.outcome',
    'phase.scope',
    'phase.dependencies',
    'phase.acceptance_criteria',
    'phase.verification',
    'phase.completion_fence',
    'phase.status',
  ]),
  RSK: Object.freeze([
    'risk.statement',
    'risk.likelihood',
    'risk.impact',
    'risk.mitigation',
    'risk.owner',
    'risk.status',
  ]),
  C: Object.freeze([
    'concept.summary',
    'concept.status',
    'concept.evidence',
    'concept.relationships',
    'concept.selection_reason',
  ]),
  QI: Object.freeze([
    'queue_item.purpose',
    'queue_item.scope',
    'queue_item.skill',
    'queue_item.requires',
    'queue_item.produces',
    'queue_item.consumes',
    'queue_item.condition',
    'queue_item.status',
  ]),
});
export const BUILD_NORMALIZED_FIELDS = Object.freeze(
  Object.values(BUILD_FIELDS_BY_NAMESPACE).flat(),
);
const BUILD_FIELDS = new Set(BUILD_NORMALIZED_FIELDS);
const LEDGER_IDENTIFIER = /^(?:(?:G|T|E|F|H)|(?:PRJ|M|R|AC|D|Q|P|RSK|C|QI))-\d{2,}$/u;
const LEDGER_FIELDS = Object.freeze([...GOAL_FIELDS, ...BUILD_NORMALIZED_FIELDS]);
const ORIGIN_RECORD_ROUTES = Object.freeze([...PUBLIC_ROUTES, ...LEGACY_PUBLIC_ROUTES]);
export const BASELINE_CAPTURE_LIMITS = Object.freeze({
  git_command_timeout_ms: 10_000,
  git_command_max_bytes: 8 * 1024 * 1024,
  file_max_bytes: 64 * 1024 * 1024,
  total_max_bytes: 512 * 1024 * 1024,
  max_entries: 100_000,
});

export class BaselineCaptureBlockedError extends Error {
  constructor(code, operation, { path = null, observedBytes = null, limitBytes = null } = {}) {
    super(`repository baseline capture blocked: ${code}`);
    this.name = 'BaselineCaptureBlockedError';
    this.code = code;
    this.operation = operation;
    this.path = path;
    this.observedBytes = observedBytes;
    this.limitBytes = limitBytes;
  }
}

export const ORIGIN_RECORD_SCHEMA = Object.freeze({
  type: 'object',
  required: [
    'schema_version',
    'origin',
    'repository_baseline',
    'routing',
    'goal',
    'change_ledger',
  ],
  properties: Object.freeze({
    schema_version: { type: 'integer', enum: [1, 2] },
    origin: {
      type: 'object',
      additionalProperties: false,
      required: ['raw_prompt', 'prompt_sha256', 'captured_at', 'selected_skill'],
      properties: {
        raw_prompt: { type: 'string' },
        prompt_sha256: { type: 'string', format: 'sha256' },
        captured_at: { type: 'string', format: 'date-time' },
        selected_skill: { type: 'string', enum: ORIGIN_RECORD_ROUTES },
      },
    },
    repository_baseline: {
      type: 'object',
      additionalProperties: false,
      required: ['root', 'head', 'branch', 'dirty_state_digest', 'instruction_files'],
      properties: {
        root: { type: 'string', minLength: 1 },
        head: { type: ['string', 'null'] },
        branch: { type: ['string', 'null'], minLength: 1 },
        dirty_state_digest: { type: ['string', 'null'], format: 'sha256' },
        instruction_files: {
          type: 'array',
          uniqueItems: true,
          items: { type: 'string', minLength: 1 },
        },
        capture_status: { type: 'string', enum: ['complete', 'blocked'] },
        capture_limits: {
          type: 'object',
          additionalProperties: false,
          required: Object.keys(BASELINE_CAPTURE_LIMITS),
          properties: Object.fromEntries(
            Object.keys(BASELINE_CAPTURE_LIMITS).map((key) => [key, { type: 'integer', minimum: 1 }]),
          ),
        },
        capture_usage: {
          type: 'object',
          additionalProperties: false,
          required: ['git_bytes', 'content_bytes', 'entries'],
          properties: {
            git_bytes: { type: 'integer', minimum: 0 },
            content_bytes: { type: 'integer', minimum: 0 },
            entries: { type: 'integer', minimum: 0 },
          },
        },
        block: {
          type: ['object', 'null'],
          additionalProperties: false,
          required: ['code', 'operation', 'path', 'observed_bytes', 'limit_bytes'],
          properties: {
            code: { type: 'string', enum: ['GIT_TIMEOUT', 'GIT_OUTPUT_LIMIT', 'FILE_SIZE_LIMIT', 'TOTAL_SIZE_LIMIT', 'ENTRY_COUNT_LIMIT', 'BASELINE_IO_ERROR'] },
            operation: { type: 'string', minLength: 1, maxLength: 128 },
            path: { type: ['string', 'null'], maxLength: 1000 },
            observed_bytes: { type: ['integer', 'null'], minimum: 0 },
            limit_bytes: { type: ['integer', 'null'], minimum: 1 },
          },
        },
      },
    },
    routing: {
      type: 'object',
      additionalProperties: false,
      required: [
        'deterministic_probe_digest',
        'initial_classifier',
        'selected_route',
        'confidence',
        'promotion_reasons',
      ],
      properties: {
        deterministic_probe_digest: { type: 'string', format: 'sha256' },
        initial_classifier: { type: 'string', minLength: 1 },
        selected_route: { type: 'string', enum: ORIGIN_RECORD_ROUTES },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        promotion_reasons: {
          type: 'array',
          uniqueItems: true,
          items: { type: 'string', minLength: 1 },
        },
      },
    },
    build: {
      type: 'object',
      additionalProperties: false,
      required: [
        'mode',
        'mode_candidate',
        'mode_evidence',
        'target_project',
        'target_milestone',
      ],
      properties: {
        mode: { type: 'string', enum: BUILD_MODES },
        mode_candidate: { type: 'string', enum: ['bootstrap', 'milestone'] },
        mode_evidence: {
          type: 'array',
          uniqueItems: true,
          items: { type: 'string', minLength: 1 },
        },
        target_project: { type: 'string', pattern: PROJECT_ID.source },
        target_milestone: {
          type: ['string', 'null'],
          pattern: MILESTONE_ID.source,
        },
      },
    },
    goal: {
      type: 'object',
      additionalProperties: false,
      required: [
        'outcome',
        'non_negotiables',
        'success_criteria',
        'exclusions',
        'permitted_inferences',
        'unresolved_questions',
      ],
      properties: {
        outcome: { type: 'string' },
        non_negotiables: { type: 'array', items: { type: 'string' } },
        success_criteria: { type: 'array', items: { type: 'string' } },
        exclusions: { type: 'array', items: { type: 'string' } },
        permitted_inferences: { type: 'array', items: { type: 'string' } },
        unresolved_questions: { type: 'array', items: { type: 'string' } },
      },
    },
    change_ledger: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'timestamp',
          'affected_identifier',
          'field',
          'prior_value',
          'new_value',
          'source',
          'rationale',
        ],
        properties: {
          timestamp: { type: 'string', format: 'date-time' },
          affected_identifier: { type: 'string', pattern: LEDGER_IDENTIFIER.source },
          field: { type: 'string', enum: LEDGER_FIELDS },
          prior_value: {},
          new_value: {},
          source: { type: 'string', minLength: 1 },
          rationale: { type: 'string', minLength: 1 },
        },
      },
    },
  }),
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

export function sha256Prompt(rawPrompt) {
  if (typeof rawPrompt !== 'string') throw new TypeError('rawPrompt must be a string');
  return createHash('sha256').update(Buffer.from(rawPrompt, 'utf8')).digest('hex');
}

function runGit(cwd, args, { binary = false, required = false, usage = null } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: binary ? null : 'utf8',
    timeout: BASELINE_CAPTURE_LIMITS.git_command_timeout_ms,
    maxBuffer: BASELINE_CAPTURE_LIMITS.git_command_max_bytes,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const outputBytes = Buffer.byteLength(result.stdout ?? Buffer.alloc(0));
  if (usage) usage.git_bytes += outputBytes;
  if (result.error?.code === 'ETIMEDOUT') {
    throw new BaselineCaptureBlockedError('GIT_TIMEOUT', `git ${args[0]}`, {
      limitBytes: BASELINE_CAPTURE_LIMITS.git_command_timeout_ms,
    });
  }
  if (result.error?.code === 'ENOBUFS' || outputBytes >= BASELINE_CAPTURE_LIMITS.git_command_max_bytes) {
    throw new BaselineCaptureBlockedError('GIT_OUTPUT_LIMIT', `git ${args[0]}`, {
      observedBytes: outputBytes,
      limitBytes: BASELINE_CAPTURE_LIMITS.git_command_max_bytes,
    });
  }
  if (required && result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${String(result.stderr ?? '').trim()}`);
  }
  return result;
}

function portable(path) {
  return path.split(sep).join('/');
}

function isInternal(relativePath) {
  return (
    relativePath === '.git' ||
    relativePath.startsWith('.git/') ||
    relativePath === '.cruise' ||
    relativePath.startsWith('.cruise/')
  );
}

function digestPath(hash, root, absolutePath, usage) {
  const relativePath = portable(relative(root, absolutePath));
  if (relativePath && isInternal(relativePath)) return;
  usage.entries += 1;
  if (usage.entries > BASELINE_CAPTURE_LIMITS.max_entries) {
    throw new BaselineCaptureBlockedError('ENTRY_COUNT_LIMIT', 'tree traversal', {
      path: relativePath || '.',
      observedBytes: usage.entries,
      limitBytes: BASELINE_CAPTURE_LIMITS.max_entries,
    });
  }
  const metadata = lstatSync(absolutePath);
  if (metadata.isDirectory()) {
    hash.update(`dir\0${relativePath}\0${metadata.mode & 0o777}\0`);
    for (const name of readdirSync(absolutePath).sort((a, b) => a.localeCompare(b, 'en'))) {
      digestPath(hash, root, join(absolutePath, name), usage);
    }
  } else if (metadata.isSymbolicLink()) {
    hash.update(`symlink\0${relativePath}\0${readlinkSync(absolutePath)}\0`);
  } else if (metadata.isFile()) {
    if (metadata.size > BASELINE_CAPTURE_LIMITS.file_max_bytes) {
      throw new BaselineCaptureBlockedError('FILE_SIZE_LIMIT', 'file hash', {
        path: relativePath,
        observedBytes: metadata.size,
        limitBytes: BASELINE_CAPTURE_LIMITS.file_max_bytes,
      });
    }
    if (usage.content_bytes + metadata.size > BASELINE_CAPTURE_LIMITS.total_max_bytes) {
      throw new BaselineCaptureBlockedError('TOTAL_SIZE_LIMIT', 'file hash', {
        path: relativePath,
        observedBytes: usage.content_bytes + metadata.size,
        limitBytes: BASELINE_CAPTURE_LIMITS.total_max_bytes,
      });
    }
    hash.update(`file\0${relativePath}\0${metadata.mode & 0o777}\0`);
    const descriptor = openSync(absolutePath, 'r');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    try {
      let offset = 0;
      while (offset < metadata.size) {
        const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, metadata.size - offset), offset);
        if (count === 0) break;
        hash.update(buffer.subarray(0, count));
        offset += count;
      }
      if (offset !== metadata.size) {
        throw new BaselineCaptureBlockedError('BASELINE_IO_ERROR', 'file hash', { path: relativePath });
      }
    } finally {
      closeSync(descriptor);
    }
    usage.content_bytes += metadata.size;
    hash.update('\0');
  } else {
    hash.update(`special\0${relativePath}\0${metadata.mode}\0`);
  }
}

function normalizeInstructionFiles(root, instructionFiles) {
  if (!Array.isArray(instructionFiles)) throw new TypeError('instructionFiles must be an array');
  const normalized = new Set();
  for (const item of instructionFiles) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new TypeError('instructionFiles entries must be non-empty strings');
    }
    const absolute = isAbsolute(item) ? resolve(item) : resolve(root, item);
    const path = portable(relative(root, absolute));
    if (!path || path === '..' || path.startsWith('../')) {
      throw new Error(`instruction file resolves outside repository: ${item}`);
    }
    normalized.add(path);
  }
  return [...normalized].sort((a, b) => a.localeCompare(b, 'en'));
}

function defaultInstructionFiles(root) {
  const candidates = [
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
    '.github/copilot-instructions.md',
  ];
  return candidates.filter((path) => {
    try {
      return lstatSync(join(root, path)).isFile() || lstatSync(join(root, path)).isSymbolicLink();
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  });
}

function gitDirtyDigest(root, usage) {
  const pathspec = ['.', ':(exclude).cruise', ':(exclude).cruise/**'];
  const status = runGit(
    root,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...pathspec],
    { binary: true, required: true, usage },
  ).stdout;
  const working = runGit(
    root,
    ['diff', '--binary', '--no-ext-diff', '--', ...pathspec],
    { binary: true, required: true, usage },
  ).stdout;
  const staged = runGit(
    root,
    ['diff', '--cached', '--binary', '--no-ext-diff', '--', ...pathspec],
    { binary: true, required: true, usage },
  ).stdout;
  const untracked = runGit(
    root,
    ['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', ...pathspec],
    { binary: true, required: true, usage },
  ).stdout;
  const hash = createHash('sha256');
  hash.update('cruise-dirty-state-v1\0status\0');
  hash.update(status ?? Buffer.alloc(0));
  hash.update('\0working\0');
  hash.update(working ?? Buffer.alloc(0));
  hash.update('\0staged\0');
  hash.update(staged ?? Buffer.alloc(0));
  hash.update('\0untracked\0');
  const paths = Buffer.from(untracked ?? []).toString('utf8').split('\0').filter(Boolean);
  for (const path of paths.sort((a, b) => a.localeCompare(b, 'en'))) {
    const absolute = resolve(root, path);
    const relativePath = portable(relative(root, absolute));
    if (relativePath === '..' || relativePath.startsWith('../')) {
      throw new Error(`git returned an untracked path outside repository: ${path}`);
    }
    digestPath(hash, root, absolute, usage);
  }
  return hash.digest('hex');
}

/** Capture the exact repository-baseline fields required by Origin schema v1. */
export function captureRepositoryBaseline(repositoryRoot, { instructionFiles = null } = {}) {
  if (typeof repositoryRoot !== 'string' || !repositoryRoot.trim()) {
    throw new TypeError('repositoryRoot must be a non-empty path');
  }
  let root = realpathSync(resolve(repositoryRoot));
  const usage = { git_bytes: 0, content_bytes: 0, entries: 0 };

  let head = null;
  let branch = null;
  try {
    const rootResult = runGit(root, ['rev-parse', '--show-toplevel'], { usage });
    const isGit = rootResult.status === 0;
    if (isGit) root = realpathSync(String(rootResult.stdout).trim());

    let dirtyStateDigest;
    if (isGit) {
      const headResult = runGit(root, ['rev-parse', '--verify', 'HEAD'], { usage });
      if (headResult.status === 0) head = String(headResult.stdout).trim();
      const branchResult = runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { usage });
      if (branchResult.status === 0) branch = String(branchResult.stdout).trim();
      dirtyStateDigest = gitDirtyDigest(root, usage);
    } else {
      const hash = createHash('sha256');
      hash.update('cruise-tree-state-v1\0');
      digestPath(hash, root, root, usage);
      dirtyStateDigest = hash.digest('hex');
    }
    return deepFreeze({
      root,
      head,
      branch,
      dirty_state_digest: dirtyStateDigest,
      instruction_files: normalizeInstructionFiles(root, instructionFiles ?? defaultInstructionFiles(root)),
      capture_status: 'complete',
      capture_limits: { ...BASELINE_CAPTURE_LIMITS },
      capture_usage: { ...usage },
      block: null,
    });
  } catch (error) {
    const blocked = error instanceof BaselineCaptureBlockedError
      ? error
      : new BaselineCaptureBlockedError('BASELINE_IO_ERROR', 'repository baseline');
    return deepFreeze({
      root,
      head,
      branch,
      dirty_state_digest: null,
      instruction_files: normalizeInstructionFiles(root, instructionFiles ?? defaultInstructionFiles(root)),
      capture_status: 'blocked',
      capture_limits: { ...BASELINE_CAPTURE_LIMITS },
      capture_usage: { ...usage },
      block: {
        code: blocked.code,
        operation: blocked.operation,
        path: blocked.path,
        observed_bytes: blocked.observedBytes,
        limit_bytes: blocked.limitBytes,
      },
    });
  }
}

function assertBaseline(record) {
  if (!isAbsolute(record.repository_baseline.root)) {
    throw new Error('repository_baseline.root must be an absolute canonical path');
  }
  if (record.repository_baseline.head != null && !GIT_OBJECT.test(record.repository_baseline.head)) {
    throw new Error('repository_baseline.head must be null or a full Git object ID');
  }
  if (record.schema_version === 1) {
    if (!SHA256.test(record.repository_baseline.dirty_state_digest)) {
      throw new Error('repository_baseline.dirty_state_digest must be SHA-256');
    }
    return;
  }
  const baseline = record.repository_baseline;
  for (const field of ['capture_status', 'capture_limits', 'capture_usage', 'block']) {
    if (!Object.hasOwn(baseline, field)) throw new Error(`repository_baseline.${field} is required in Origin v2`);
  }
  if (baseline.capture_status === 'complete') {
    if (!SHA256.test(baseline.dirty_state_digest) || baseline.block !== null) {
      throw new Error('a complete repository baseline requires a SHA-256 digest and null block');
    }
  } else if (baseline.capture_status === 'blocked') {
    if (baseline.dirty_state_digest !== null || baseline.block === null) {
      throw new Error('a blocked repository baseline requires a null digest and bounded block metadata');
    }
  } else {
    throw new Error('repository_baseline.capture_status is invalid');
  }
}

function buildIdentifierNamespace(identifier) {
  return String(identifier).slice(0, String(identifier).indexOf('-'));
}

function assertRouteSpecificLedger(record) {
  const isBuild = record.origin.selected_skill === 'build';
  for (const [index, entry] of record.change_ledger.entries()) {
    const label = `change_ledger[${index}]`;
    if (!isBuild) {
      if (!TRACE_ID.test(entry.affected_identifier) || !GOAL_FIELDS.has(entry.field)) {
        throw new Error(`${label} must use the shared Goal identifier and normalized-field vocabulary`);
      }
      continue;
    }
    if (!BUILD_IDENTIFIER_PATTERN.test(entry.affected_identifier)) {
      throw new Error(`${label}.affected_identifier must be a stable Build identifier`);
    }
    if (!BUILD_FIELDS.has(entry.field)) {
      throw new Error(`${label}.field is not an allowed normalized Build field`);
    }
    const namespace = buildIdentifierNamespace(entry.affected_identifier);
    if (!BUILD_FIELDS_BY_NAMESPACE[namespace]?.includes(entry.field)) {
      throw new Error(`${label}.field does not belong to ${namespace} identifiers`);
    }
  }
}

/** Validate schema, prompt-byte integrity, baseline shape, and optional immutability. */
export function validateOriginRecord(record, { expectedOrigin = null } = {}) {
  assertYamlSchema(record, ORIGIN_RECORD_SCHEMA, { name: 'Cruise Origin Record' });
  canonicalJson(record);
  const actualHash = sha256Prompt(record.origin.raw_prompt);
  if (actualHash !== record.origin.prompt_sha256) {
    throw new Error('Origin raw prompt hash does not match origin.prompt_sha256.');
  }
  assertBaseline(record);
  for (const path of record.repository_baseline.instruction_files) {
    if (isAbsolute(path) || path === '..' || path.startsWith('../')) {
      throw new Error(`repository_baseline instruction file must be repository-relative: ${path}`);
    }
  }
  if (record.build !== undefined) {
    if (record.origin.selected_skill !== 'build' || record.routing.selected_route !== 'build') {
      throw new Error('Only a Build-selected Origin may contain build context.');
    }
    const normalizedBuild = normalizeBuildContext(record.build);
    if (canonicalJson(normalizedBuild) !== canonicalJson(record.build)) {
      throw new Error('Origin Build context is not canonical.');
    }
  }
  assertRouteSpecificLedger(record);
  if (expectedOrigin) assertOriginImmutable(expectedOrigin, record);
  return record;
}

export function assertOriginImmutable(original, candidate) {
  validateOriginRecord(original);
  validateOriginRecord(candidate);
  if (canonicalJson(original.origin) !== canonicalJson(candidate.origin)) {
    throw new Error('Origin metadata is immutable and changed after capture.');
  }
  if (
    canonicalJson(original.repository_baseline) !==
    canonicalJson(candidate.repository_baseline)
  ) {
    throw new Error('Origin repository baseline is immutable and changed after capture.');
  }
  if (canonicalJson(original.build ?? null) !== canonicalJson(candidate.build ?? null)) {
    throw new Error('Origin Build mode evidence is immutable and changed after capture.');
  }
  if (
    canonicalJson(candidate.change_ledger.slice(0, original.change_ledger.length)) !==
    canonicalJson(original.change_ledger)
  ) {
    throw new Error('Origin clarification ledger is append-only and prior entries changed.');
  }
  return true;
}

function normalizeGoal(goal = {}) {
  const list = (name) => {
    const value = goal[name] ?? [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new TypeError(`goal.${name} must be an array of strings`);
    }
    return [...value];
  };
  return {
    outcome: goal.outcome == null ? '' : String(goal.outcome),
    non_negotiables: list('non_negotiables'),
    success_criteria: list('success_criteria'),
    exclusions: list('exclusions'),
    permitted_inferences: list('permitted_inferences'),
    unresolved_questions: list('unresolved_questions'),
  };
}

function normalizeBuildContext(build) {
  if (!build || typeof build !== 'object' || Array.isArray(build)) {
    throw new TypeError('build context must be an object');
  }
  const mode = String(build.mode ?? '');
  const modeCandidate = String(build.mode_candidate ?? build.modeCandidate ?? '');
  const modeEvidence = build.mode_evidence ?? build.modeEvidence ?? [];
  const targetProject = String(build.target_project ?? build.targetProject ?? '');
  const targetMilestone = build.target_milestone ?? build.targetMilestone ?? null;
  if (!BUILD_MODES.includes(mode)) throw new TypeError('build.mode is invalid');
  if (!['bootstrap', 'milestone'].includes(modeCandidate)) {
    throw new TypeError('build.mode_candidate must be bootstrap or milestone');
  }
  if (mode !== modeCandidate) {
    throw new TypeError('build.mode must match mode_candidate; discovery is mutable run state, not Origin mode');
  }
  if (!Array.isArray(modeEvidence) || modeEvidence.length === 0 ||
      modeEvidence.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new TypeError('build.mode_evidence must contain non-empty evidence strings');
  }
  if (!PROJECT_ID.test(targetProject)) {
    throw new TypeError('build.target_project must be a stable PRJ-XX identifier');
  }
  if (targetMilestone !== null && !MILESTONE_ID.test(String(targetMilestone))) {
    throw new TypeError('build.target_milestone must be null or a stable M-XX identifier');
  }
  if (modeCandidate === 'bootstrap' && targetMilestone !== null) {
    throw new TypeError('bootstrap Build origin cannot target an existing milestone');
  }
  if (modeCandidate === 'milestone' && targetMilestone === null) {
    throw new TypeError('milestone Build origin requires target_milestone');
  }
  return {
    mode,
    mode_candidate: modeCandidate,
    mode_evidence: [...new Set(modeEvidence.map((entry) => entry.trim()))],
    target_project: targetProject,
    target_milestone: targetMilestone === null ? null : String(targetMilestone),
  };
}

export function createOriginRecord({
  rawPrompt,
  selectedSkill,
  repositoryRoot = null,
  repositoryBaseline = null,
  instructionFiles = null,
  deterministicProbeDigest,
  initialClassifier,
  selectedRoute,
  confidence,
  promotionReasons = [],
  capturedAt = new Date().toISOString(),
  goal = {},
  build = null,
} = {}) {
  if (typeof rawPrompt !== 'string') throw new TypeError('rawPrompt must be a string');
  if (!PUBLIC_ROUTES.includes(selectedSkill)) throw new TypeError('selectedSkill is invalid');
  if (!PUBLIC_ROUTES.includes(selectedRoute)) throw new TypeError('selectedRoute is invalid');
  if (!SHA256.test(String(deterministicProbeDigest ?? ''))) {
    throw new TypeError('deterministicProbeDigest must be a lowercase SHA-256 digest');
  }
  if (typeof initialClassifier !== 'string' || !initialClassifier.trim()) {
    throw new TypeError('initialClassifier must identify the model and reasoning level');
  }
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
    throw new TypeError('confidence must be between 0 and 1');
  }
  if (!Array.isArray(promotionReasons) || promotionReasons.some((reason) => typeof reason !== 'string' || !reason)) {
    throw new TypeError('promotionReasons must be an array of non-empty strings');
  }
  if (build !== null && selectedSkill !== 'build') {
    throw new TypeError('Only Build Origin records may contain build context');
  }
  const baseline = repositoryBaseline ?? captureRepositoryBaseline(repositoryRoot, {
    instructionFiles,
  });
  const captureStatus = baseline.capture_status ?? 'complete';
  const captureLimits = baseline.capture_limits ?? { ...BASELINE_CAPTURE_LIMITS };
  const captureUsage = baseline.capture_usage ?? { git_bytes: 0, content_bytes: 0, entries: 0 };
  const captureBlock = baseline.block ?? null;
  const record = {
    schema_version: 2,
    origin: {
      raw_prompt: rawPrompt,
      prompt_sha256: sha256Prompt(rawPrompt),
      captured_at: capturedAt,
      selected_skill: selectedSkill,
    },
    repository_baseline: {
      root: baseline.root,
      head: baseline.head ?? null,
      branch: baseline.branch ?? null,
      dirty_state_digest: baseline.dirty_state_digest,
      instruction_files: [...(baseline.instruction_files ?? [])],
      capture_status: captureStatus,
      capture_limits: { ...captureLimits },
      capture_usage: { ...captureUsage },
      block: captureBlock === null ? null : { ...captureBlock },
    },
    routing: {
      deterministic_probe_digest: deterministicProbeDigest,
      initial_classifier: initialClassifier.trim(),
      selected_route: selectedRoute,
      confidence,
      promotion_reasons: [...new Set(promotionReasons)].sort((a, b) => a.localeCompare(b, 'en')),
    },
    ...(build === null ? {} : { build: normalizeBuildContext(build) }),
    goal: normalizeGoal(goal),
    change_ledger: [],
  };
  validateOriginRecord(record);
  return deepFreeze(record);
}

/** Capture an Origin record whose repository-evidenced Build mode is explicit and schema-bound. */
export function createBuildOriginRecord({ build, ...input } = {}) {
  if (build == null) throw new TypeError('Build Origin requires a build context');
  return createOriginRecord({
    ...input,
    selectedSkill: 'build',
    selectedRoute: 'build',
    build,
  });
}

/** Change a normalized goal field only by returning a ledgered successor record. */
export function updateNormalizedGoal(
  record,
  {
    affectedIdentifier,
    field,
    newValue,
    source,
    rationale,
    timestamp = new Date().toISOString(),
  } = {},
) {
  validateOriginRecord(record);
  if (record.origin.selected_skill === 'build') {
    throw new TypeError('Build clarifications must use appendBuildClarification');
  }
  if (!TRACE_ID.test(String(affectedIdentifier ?? ''))) {
    throw new TypeError('affectedIdentifier must be a stable Cruise traceability ID');
  }
  if (!GOAL_FIELDS.has(field)) throw new TypeError(`unsupported normalized goal field: ${field}`);
  if (typeof source !== 'string' || !source.trim()) throw new TypeError('change source is required');
  if (typeof rationale !== 'string' || !rationale.trim()) {
    throw new TypeError('change rationale is required');
  }
  const next = structuredClone(record);
  const priorValue = next.goal[field];
  next.goal[field] = structuredClone(newValue);
  next.change_ledger.push({
    timestamp,
    affected_identifier: affectedIdentifier,
    field,
    prior_value: priorValue,
    new_value: structuredClone(newValue),
    source: source.trim(),
    rationale: rationale.trim(),
  });
  validateOriginRecord(next, { expectedOrigin: record });
  return deepFreeze(next);
}

/** Append a clarification for a normalized Build artifact without rewriting immutable Origin. */
export function appendBuildClarification(
  record,
  {
    affectedIdentifier,
    field,
    priorValue,
    newValue,
    source,
    rationale,
    timestamp = new Date().toISOString(),
  } = {},
) {
  validateOriginRecord(record);
  if (record.origin.selected_skill !== 'build' || record.routing.selected_route !== 'build') {
    throw new TypeError('appendBuildClarification requires a Build-selected Origin');
  }
  const identifier = String(affectedIdentifier ?? '');
  if (!BUILD_IDENTIFIER_PATTERN.test(identifier)) {
    throw new TypeError('affectedIdentifier must be a stable Build identifier');
  }
  if (!BUILD_FIELDS.has(field)) {
    throw new TypeError(`unsupported normalized Build field: ${field}`);
  }
  const namespace = buildIdentifierNamespace(identifier);
  if (!BUILD_FIELDS_BY_NAMESPACE[namespace]?.includes(field)) {
    throw new TypeError(`${field} cannot be ledgered against a ${namespace} identifier`);
  }
  if (typeof source !== 'string' || !source.trim()) throw new TypeError('change source is required');
  if (typeof rationale !== 'string' || !rationale.trim()) {
    throw new TypeError('change rationale is required');
  }
  const next = structuredClone(record);
  next.change_ledger.push({
    timestamp,
    affected_identifier: identifier,
    field,
    prior_value: structuredClone(priorValue),
    new_value: structuredClone(newValue),
    source: source.trim(),
    rationale: rationale.trim(),
  });
  validateOriginRecord(next, { expectedOrigin: record });
  return deepFreeze(next);
}
