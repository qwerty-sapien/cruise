import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AppServerClient } from './app-server-client.mjs';
import { createIsolatedAppServerRuntime } from './app-server-runtime.mjs';

async function createDoctorTemp(name) {
  const path = join(tmpdir(), name);
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { mode: 0o700 });
  return path;
}
import { createDeadline, waitForCleanup } from './deadline.mjs';
import { digestPluginRuntime, isPathInside } from './doctor-plugin-cache.mjs';
import { validateEvidenceRecord } from './evidence.mjs';
import {
  captureProductInventory,
  finalizeForeignDiffGuard,
  readForeignDiffGuardState,
} from './foreign-diff-guard.mjs';
import { validateOriginRecord } from './origin.mjs';
import { MODEL_IDS, normalizeModelCatalog } from './model-policy.mjs';
import {
  applyQuickPromotion,
  assertRuntimeProbeReady,
  classifierLabel,
  deterministicProbeDigest,
  normalizeClassifierOutput,
  QUICK_HARD_GATE_SIGNALS,
  repositoryBaselineDigest,
  ROUTE_CONFIDENCE_THRESHOLD,
} from './routing.mjs';
import { validateRunState } from './run-state.mjs';
import { assertSemanticMappingPacket } from './semantic-mapping-packet.mjs';
import {
  sanitizeWorkerDiagnosticText,
  WorkerSessionError,
  workerReconnectEvent,
} from './worker-session.mjs';
import { canonicalJson, readYamlFile, stringifyYaml } from './yaml-state.mjs';

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DOCTOR_FIXTURE = resolve(
  MODULE_DIRECTORY,
  '../../fixtures/doctor/repository',
);

export const DOCTOR_DEBUG_REPAIRED_TEST =
  "import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('intentional Doctor symptom', () => assert.equal(1, 1));\n";

export const DOCTOR_SKILL_CASES = Object.freeze([
  Object.freeze({
    skill: 'build',
    prompt: 'Define and validate a small milestone for improving the repository-local spatiomics skill documentation and deterministic validation. The approved planning contracts must cite $spatiomics-skill, its inspect_spatial_inputs.py entry point, and the digest-bound fixture test. Keep all work repository-local and use the normal Build reviews.',
  }),
  Object.freeze({
    skill: 'quick',
    prompt: 'Create doctor-ok.txt containing exactly "Cruise Doctor quick probe passed." followed by one newline, verify the bytes, and finish the normal Quick workflow. In the mapping packet, enumerate the shared contract\'s exact 18 schema-v1 enrichment gates; the two extra schema-v2 deterministic-probe routing signals are expected metadata and must be excluded from the schema-v1 gate list.',
  }),
  Object.freeze({
    skill: 'refine',
    prompt: 'Plan and implement docs/refine-ok.md for this spatiomics skill. The target document is intentionally absent at baseline. Resolve the material documentation decision between structural format triage and semantic fixture validation, state both failure boundaries, and use the normal Refine approval and independent verification. The fixture evidence is at repository-root paths data/format-markers.json, workflow/Snakefile, tests/spatiomics-fixture.test.mjs, and .agents/skills/spatiomics-skill/scripts/inspect_spatial_inputs.py.',
  }),
  Object.freeze({
    skill: 'goal',
    prompt: 'Prepare and durably execute docs/DOCTOR-GOAL.md as an interruption-safe validation runbook for the spatiomics fixture, with checkpoints for the inspector, semantic test, and provenance review. This is the native Goal durability canary: use the normal combined Plan-and-Goal review and Goal activation; no external effects.',
  }),
  Object.freeze({
    skill: 'debug',
    prompt: 'Run node --test tests/fail.test.mjs inside the bounded skill turn, determine the root cause of its intentional failure, and repair only that disposable test by changing the final expected value from 2 to 1 while preserving every other byte. Rerun it only inside the skill turn and preserve normal Debug evidence.',
    prepare: 'failing-test',
  }),
]);

export const DEEP_DOCTOR_SKILL_TIMEOUT_MS = 60_000;
export const DEEP_DOCTOR_TARGET_MS = 15_000;

export const DEEP_DOCTOR_SMOKE_CASES = Object.freeze([
  Object.freeze({
    skill: 'build',
    question: 'Report the ordered exact ordinary approval labels, the exact immutable request-header directive for planning-only auto-approval, and whether Build may implement product code.',
    expected: Object.freeze({
      skill: 'cruise:build',
      approval_labels: Object.freeze(['Approve Foundation', 'Approve Milestone']),
      auto_approval_directive: '--auto-approve',
      implements_product_code: false,
    }),
    tests: Object.freeze([
      'Build origin-bound auto-approval authorizes only the exact reviewed planning digest',
      'queue approval requires verified Build authority and remains digest-bound',
    ]),
    files: Object.freeze(['tests/build-contract.test.mjs']),
  }),
  Object.freeze({
    skill: 'quick',
    question: 'Report whether a hidden universal repair count is a promotion reason and whether semantic hard gates remain authoritative.',
    expected: Object.freeze({
      skill: 'cruise:quick',
      hidden_repair_count_promotes: false,
      semantic_hard_gates_authoritative: true,
    }),
    tests: Object.freeze([
      'Quick hard gates promote deterministically while file count alone never decides',
      'route requires exactly one Terra retry below threshold and honors persistent uncertainty',
    ]),
    files: Object.freeze([
      'tests/origin-routing-model.test.mjs',
      'tests/runtime-cli.test.mjs',
    ]),
  }),
  Object.freeze({
    skill: 'refine',
    question: 'Report the exact native approval label and whether approval binds both Plan and repository-baseline digests.',
    expected: Object.freeze({
      skill: 'cruise:refine',
      approval_labels: Object.freeze(['Approve Plan']),
      binds_plan_and_baseline: true,
    }),
    tests: Object.freeze([
      'Refine product writes require a current exact-label plan approval and exact plan ownership',
      'Refine keeps clarification and review read-only and execution write-capable',
    ]),
    files: Object.freeze([
      'tests/workflow-policy.test.mjs',
      'tests/skill-session.test.mjs',
    ]),
  }),
  Object.freeze({
    skill: 'goal',
    question: 'Report the ordered exact labels in the combined Goal review and whether Plan and Goal are approved together.',
    expected: Object.freeze({
      skill: 'cruise:goal',
      approval_labels: Object.freeze(['Approve both', 'Refine', 'Reject both']),
      plan_and_goal_together: true,
    }),
    tests: Object.freeze([
      'one combined Plan-and-Goal approval activates native Goal without an intermediate write window',
      'one combined snapshot binds Plan, Goal, alignment, and repository baseline',
    ]),
    files: Object.freeze(['tests/session.test.mjs', 'tests/goal-contract.test.mjs']),
  }),
  Object.freeze({
    skill: 'debug',
    question: 'Report whether Debug requires an observed failure and performed causal evidence before a repair write.',
    expected: Object.freeze({
      skill: 'cruise:debug',
      observed_failure_required: true,
      causal_evidence_before_repair: true,
    }),
    tests: Object.freeze([
      'Debug product writes require performed causal evidence and exact causal scope',
    ]),
    files: Object.freeze(['tests/workflow-policy.test.mjs']),
  }),
]);

export const FORBIDDEN_WORKER_UX = Object.freeze([
  /may transmit/iu,
  /\b(?:consent|authori[sz]\w*)\b.{0,120}\b(?:upload\w*|transmit\w*|send(?:ing)?|shar(?:e|ing)|export(?:ing)?|network|backend|openai)\b/iu,
  /\b(?:upload\w*|transmit\w*|send(?:ing)?|shar(?:e|ing)|export(?:ing)?)\b.{0,120}\b(?:repository|files?|packet|content|backend|openai)\b/iu,
  /bounded repository (?:analysis|content|packet)/iu,
  /host-context retry/iu,
  /request denied[^\n]*cruise worker/iu,
  /stream disconnected before completion/iu,
  /CRUISE_WORKER_HOST_PATH_LOST/u,
  /CRUISE_WORKER_INFERENCE_STREAM_FAILED/u,
]);

const STAGED_PLUGIN_PATHS = Object.freeze([
  '.codex-plugin',
  'package.json',
  'skills',
  'internal',
  'scripts',
  'fixtures',
  'tests',
]);

function tokenizeExactCommand(command) {
  const tokens = [];
  let token = '';
  let quote = null;
  let escaped = false;
  let started = false;
  const finish = () => {
    if (!started) return;
    tokens.push(token);
    token = '';
    started = false;
  };
  for (const character of String(command ?? '')) {
    if (escaped) {
      token += character;
      started = true;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      else token += character;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === '\\') escaped = true;
      else if (character === '$' || character === '`') return null;
      else token += character;
      started = true;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      started = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      finish();
    } else if (/[;&|<>()`$]/u.test(character)) {
      return null;
    } else {
      token += character;
      started = true;
    }
  }
  if (escaped || quote !== null) return null;
  finish();
  return tokens;
}

function unwrapExactCommand(command) {
  let tokens = tokenizeExactCommand(command);
  if (
    tokens?.length === 3
    && tokens[1] === '-lc'
    && ['/bin/zsh', '/bin/bash', '/bin/sh', 'zsh', 'bash', 'sh'].includes(tokens[0])
  ) {
    // Codex commandExecution notifications expose even an exact host command
    // through the shell adapter used to launch it. Unwrap that one known
    // transport envelope, then apply the same strict token/control checks to
    // its payload. Compound or prefixed shell programs still fail closed.
    tokens = tokenizeExactCommand(tokens[2]);
  }
  return tokens;
}

export function parseCruiseWorkerInvocation(command, { expectedExecutable = 'cruise' } = {}) {
  const tokens = unwrapExactCommand(command);
  if (!tokens || tokens[0] !== expectedExecutable || tokens[1] !== 'worker') return null;
  const values = { level: null, cwd: null, packet: null, packetSha256: null, report: null };
  const fields = new Map([
    ['--level', 'level'],
    ['-C', 'cwd'],
    ['--cwd', 'cwd'],
    ['--packet', 'packet'],
    ['--packet-sha256', 'packetSha256'],
    ['--report', 'report'],
  ]);
  for (let index = 2; index < tokens.length; index += 2) {
    const field = fields.get(tokens[index]);
    const value = tokens[index + 1];
    if (!field || value == null || values[field] !== null) return null;
    values[field] = value;
  }
  const level = Number(values.level);
  if (!Number.isInteger(level) || level < 1 || level > 7) return null;
  if (
    ![values.cwd, values.packet, values.report].every((value) => typeof value === 'string' && value)
    || !/^[a-f0-9]{64}$/u.test(values.packetSha256 ?? '')
  ) {
    return null;
  }
  return Object.freeze({
    executable: tokens[0],
    level,
    cwd: values.cwd,
    packet: values.packet,
    packetSha256: values.packetSha256,
    report: values.report,
  });
}

export function parseDoctorRuntimeInvocation(command, {
  expectedRuntimePath,
  expectedNodePath = 'node',
} = {}) {
  const tokens = unwrapExactCommand(command);
  if (
    !tokens
    || tokens.length < 3
    || tokens[0] !== expectedNodePath
    || typeof expectedRuntimePath !== 'string'
    || !isAbsolute(expectedRuntimePath)
    || tokens[1] !== expectedRuntimePath
    || !/^[a-z][a-z0-9-]*$/u.test(tokens[2])
  ) {
    return null;
  }
  return Object.freeze({
    node: tokens[0],
    runtimePath: tokens[1],
    subcommand: tokens[2],
    args: Object.freeze(tokens.slice(3)),
  });
}

const DOCTOR_HOST_RUNTIME_OPTIONS = Object.freeze({
  begin: Object.freeze({
    required: Object.freeze(['skill', 'root', 'prompt-file']),
    optional: Object.freeze([]),
  }),
  'enrich-probe': Object.freeze({
    required: Object.freeze(['run-dir', 'facts']),
    optional: Object.freeze([]),
  }),
  route: Object.freeze({
    required: Object.freeze(['skill', 'run-dir', 'classifier']),
    optional: Object.freeze(['retry-classifier', 'catalog-json']),
  }),
  'validate-origin': Object.freeze({
    required: Object.freeze(['file']),
    optional: Object.freeze(['expected-origin']),
  }),
  'validate-trace': Object.freeze({
    required: Object.freeze(['file']),
    optional: Object.freeze(['final', 'origin', 'origin-mappings']),
  }),
  'resolve-model': Object.freeze({
    required: Object.freeze(['stage', 'catalog-json', 'output']),
    optional: Object.freeze(['tier', 'reasoning', 'attempt-number', 'escalation-reason']),
  }),
  'foreign-diff-project': Object.freeze({
    required: Object.freeze(['run-dir', 'intent', 'output']),
    optional: Object.freeze([]),
  }),
  'foreign-diff-open': Object.freeze({
    required: Object.freeze(['run-dir', 'action']),
    optional: Object.freeze([]),
  }),
  'foreign-diff-close': Object.freeze({
    required: Object.freeze(['run-dir', 'receipt']),
    optional: Object.freeze([]),
  }),
  'foreign-diff-check': Object.freeze({
    required: Object.freeze(['run-dir']),
    optional: Object.freeze([]),
  }),
  'foreign-diff-finalize': Object.freeze({
    required: Object.freeze(['run-dir', 'expected-inventory-sha256']),
    optional: Object.freeze([]),
  }),
});

function parseDoctorRuntimeOptions(args, schema) {
  const allowed = new Set([...schema.required, ...schema.optional]);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (typeof token !== 'string' || !token.startsWith('--') || token === '--') return null;
    const equals = token.indexOf('=');
    const key = token.slice(2, equals < 0 ? undefined : equals);
    if (!allowed.has(key) || Object.hasOwn(options, key)) return null;
    if (key === 'final') {
      if (equals >= 0) return null;
      options[key] = true;
      continue;
    }
    const value = equals < 0 ? args[++index] : token.slice(equals + 1);
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) return null;
    options[key] = value;
  }
  if (schema.required.some((key) => !Object.hasOwn(options, key))) return null;
  return options;
}

function doctorCanonicalRoot(path) {
  try {
    return realpathSync(resolve(path));
  } catch {
    return null;
  }
}

function doctorRunDirectory(repositoryRoot, requestedPath, { allowMissingRunsRoot = false } = {}) {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) return null;
  const requested = resolve(repositoryRoot, requestedPath);
  const name = basename(requested);
  if (!/^(?=.{1,15}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(name)) return null;
  let parent;
  let runsRoot;
  try {
    parent = realpathSync(dirname(requested));
    runsRoot = realpathSync(join(repositoryRoot, '.cruise', 'runs'));
  } catch (error) {
    if (!allowMissingRunsRoot || error?.code !== 'ENOENT') return null;
    const expectedCruiseRoot = join(repositoryRoot, '.cruise');
    let cruiseRoot;
    try {
      cruiseRoot = realpathSync(expectedCruiseRoot);
    } catch {
      return null;
    }
    if (cruiseRoot !== expectedCruiseRoot) return null;
    let requestedCruiseRoot;
    try {
      requestedCruiseRoot = realpathSync(dirname(dirname(requested)));
    } catch {
      return null;
    }
    if (requestedCruiseRoot !== cruiseRoot) return null;
    runsRoot = join(cruiseRoot, 'runs');
    parent = join(requestedCruiseRoot, 'runs');
  }
  if (parent !== runsRoot) return null;
  return join(parent, name);
}

function doctorDirectRunFile(repositoryRoot, runDirectory, requestedPath, expectedName = null) {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) return null;
  const requested = resolve(repositoryRoot, requestedPath);
  const name = basename(requested);
  if (!name || name === '.' || name === '..' || (expectedName !== null && name !== expectedName)) {
    return null;
  }
  let parent;
  try {
    parent = realpathSync(dirname(requested));
  } catch {
    return null;
  }
  return parent === runDirectory ? join(parent, name) : null;
}

/**
 * Recognize only the installed runtime operations needed by the canary. The
 * root model may request this one-command host
 * execution path; workers retain their own repository-only sandbox and never
 * receive the authority path as a writable root.
 */
export function parseDoctorRuntimeHostInvocation(command, {
  expectedRuntimePath,
  expectedNodePath = realpathSync(process.execPath),
  repositoryRoot,
  skill,
  promptFile = null,
} = {}) {
  const envelope = tokenizeExactCommand(command);
  if (
    !envelope
    || (
      envelope[0] !== expectedNodePath
      && !(envelope.length === 3 && envelope[0] === '/bin/zsh' && envelope[1] === '-lc')
    )
  ) {
    return null;
  }
  const invocation = parseDoctorRuntimeInvocation(command, {
    expectedRuntimePath,
    expectedNodePath,
  });
  const schema = invocation === null ? null : DOCTOR_HOST_RUNTIME_OPTIONS[invocation.subcommand];
  if (!schema) return null;
  const root = doctorCanonicalRoot(repositoryRoot);
  if (root === null) return null;
  const options = parseDoctorRuntimeOptions(invocation.args, schema);
  if (options === null) return null;
  const expectedRunDirectory = join(root, '.cruise', 'runs', `doctor-${skill}`);
  const runDirectory = Object.hasOwn(options, 'run-dir')
    ? doctorRunDirectory(root, options['run-dir'], {
        allowMissingRunsRoot: invocation.subcommand === 'begin',
      })
    : expectedRunDirectory;
  if (runDirectory !== expectedRunDirectory) return null;

  if (invocation.subcommand === 'begin') {
    if (
      options.skill !== skill
      || doctorCanonicalRoot(options.root) !== root
      || typeof promptFile !== 'string'
      || resolve(options['prompt-file']) !== resolve(promptFile)
    ) {
      return null;
    }
  }
  if (invocation.subcommand === 'route' && options.skill !== skill) return null;

  const directFiles = {
    'enrich-probe': [['facts', 'map-facts.yaml']],
    route: [['classifier', null], ['retry-classifier', null], ['catalog-json', null]],
    'validate-origin': [['file', null], ['expected-origin', null]],
    'validate-trace': [['file', null], ['origin', null], ['origin-mappings', null]],
    'resolve-model': [['catalog-json', null], ['output', null]],
    'foreign-diff-project': [['intent', null], ['output', null]],
    'foreign-diff-open': [['action', null]],
    'foreign-diff-close': [['receipt', null]],
  }[invocation.subcommand] ?? [];
  for (const [key, expectedName] of directFiles) {
    if (!Object.hasOwn(options, key)) continue;
    if (doctorDirectRunFile(root, runDirectory, options[key], expectedName) === null) return null;
  }
  if (invocation.subcommand.startsWith('foreign-diff-')) {
    for (const [key] of directFiles) {
      if (!/^foreign-diff-[A-Za-z0-9._-]+$/u.test(basename(resolve(root, options[key])))) {
        return null;
      }
    }
  }
  if (
    invocation.subcommand === 'foreign-diff-finalize'
    && !/^[a-f0-9]{64}$/u.test(options['expected-inventory-sha256'])
  ) {
    return null;
  }
  if (invocation.subcommand === 'resolve-model') {
    if (!/^[A-Za-z0-9._-]{1,64}$/u.test(options.stage)) return null;
    if (options.tier && !/^(?:luna|terra|sol)$/u.test(options.tier)) return null;
    if (options.reasoning && !/^(?:low|medium|high|xhigh|ultra|max)$/u.test(options.reasoning)) {
      return null;
    }
    if (options['attempt-number'] && !/^[1-9][0-9]{0,2}$/u.test(options['attempt-number'])) {
      return null;
    }
    if (options['escalation-reason'] && options['escalation-reason'].length > 512) return null;
  }
  return Object.freeze({
    ...invocation,
    options: Object.freeze({ ...options }),
    repositoryRoot: root,
    runDirectory,
  });
}

function doctorRuntimeArgvDigest(command) {
  const tokens = unwrapExactCommand(command);
  if (!tokens) return null;
  return createHash('sha256').update(canonicalJson(tokens)).digest('hex');
}

function hasPermissionWidening(params) {
  const additionalProfiles = [
    params?.additionalPermissions,
    params?.additional_permissions,
  ].filter((value) => value !== undefined && value !== null);
  if (additionalProfiles.length > 1) return true;
  for (const profile of additionalProfiles) {
    if (typeof profile !== 'object' || Array.isArray(profile)) return true;
    if (Object.keys(profile).some((key) => !['fileSystem', 'file_system', 'network'].includes(key))) {
      return true;
    }
    const network = profile.network;
    if (network != null && (
      typeof network !== 'object'
      || Array.isArray(network)
      || Object.keys(network).some((key) => key !== 'enabled')
      || network.enabled === true
      || (network.enabled !== false && network.enabled !== null && network.enabled !== undefined)
    )) {
      return true;
    }
    // `require_escalated` now reports its one-command filesystem overlay in
    // additionalPermissions. The exact installed runtime argv, cwd, phase,
    // thread, turn, item, and callback are independently bound below, so this
    // transport metadata creates no reusable or broader Cruise authority.
  }
  for (const key of [
    'networkApprovalContext',
    'network_approval_context',
  ]) {
    const value = params?.[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    return true;
  }
  // proposedExecpolicyAmendment and proposedNetworkPolicyAmendments are host
  // suggestions, not active permissions. Returning the plain `accept`
  // decision below approves only this exact command and applies neither kind
  // of reusable amendment.
  return false;
}

function assertDoctorPromptFile(path, expectedSha256) {
  const requested = resolve(path);
  const metadata = lstatSync(requested);
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || realpathSync(requested) !== requested
    || (metadata.mode & 0o777) !== 0o400
    || metadata.size > 4 * 1024 * 1024
  ) {
    throw new Error('deep Doctor runtime prompt is not an immutable bounded regular file');
  }
  const digest = createHash('sha256').update(readFileSync(requested)).digest('hex');
  if (digest !== expectedSha256) throw new Error('deep Doctor runtime prompt digest changed');
  return digest;
}

/**
 * One-turn, one-item broker for the exact installed runtime. It is intentionally
 * in-memory and never grants a prefix/session rule. A completion must bind back
 * to the same thread, turn, item, and tokenized argv before it gains evidence
 * value.
 */
export function createDoctorRuntimeHostGate({
  expectedRuntimePath,
  expectedNodePath = realpathSync(process.execPath),
  repositoryRoot,
  skill,
  promptFile,
  promptSha256,
  context,
} = {}) {
  const root = doctorCanonicalRoot(repositoryRoot);
  if (root === null) throw new TypeError('deep Doctor host gate requires a canonical repository');
  const runtimePath = realpathSync(resolve(expectedRuntimePath));
  const nodePath = realpathSync(resolve(expectedNodePath));
  const canonicalPromptFile = realpathSync(resolve(promptFile));
  if (isPathInside(root, canonicalPromptFile)) {
    throw new Error('deep Doctor runtime prompt must remain outside the worker-writable repository');
  }
  assertDoctorPromptFile(canonicalPromptFile, promptSha256);
  if (typeof context !== 'function') throw new TypeError('deep Doctor host gate requires active turn context');

  const pending = new Map();
  const seenItems = new Set();
  const history = [];
  let sequence = 0;
  let beginApproved = false;
  let beginCompleted = false;
  let lastRejection = null;

  const reject = (reason) => {
    lastRejection = reason;
    return null;
  };

  const authorize = (message) => {
    const params = message?.params ?? {};
    const active = context();
    const approvalId = params.approvalId ?? null;
    if (message?.method !== 'item/commandExecution/requestApproval') return reject('wrong_method');
    if (!active) return reject('no_active_turn');
    if (typeof active.threadId !== 'string') return reject('active_thread_missing');
    if (typeof active.turnId !== 'string') return reject('active_turn_missing');
    if (params.threadId !== active.threadId) return reject('thread_mismatch');
    if (params.turnId !== active.turnId) return reject('turn_mismatch');
    if (typeof params.itemId !== 'string' || params.itemId.length === 0) {
      return reject('item_missing');
    }
    if (
      // Current app-server zsh-exec-bridge callbacks carry a distinct opaque
      // approvalId even though completion is still reported on the parent
      // itemId. Bind that ID to this one exact command; never turn it into a
      // prefix, session rule, or second callback for the same item.
      approvalId !== null && (
        typeof approvalId !== 'string'
        || approvalId.length === 0
        || /[\u0000-\u001f\u007f]/u.test(approvalId)
      )
    ) {
      return reject('approval_id_invalid');
    }
    if (seenItems.has(params.itemId)) return reject('item_reused');
    if (pending.size !== 0) return reject('approval_already_pending');
    if (doctorCanonicalRoot(params.cwd) !== root) return reject('cwd_mismatch');
    if (!Array.isArray(params.availableDecisions)) return reject('decisions_missing');
    if (!params.availableDecisions.includes('accept')) return reject('accept_unavailable');
    if (hasPermissionWidening(params)) return reject('permission_widening');
    const invocation = parseDoctorRuntimeHostInvocation(params.command, {
      expectedRuntimePath: runtimePath,
      expectedNodePath: nodePath,
      repositoryRoot: root,
      skill,
      promptFile: canonicalPromptFile,
    });
    if (invocation === null) return reject('runtime_invocation_invalid');
    if (invocation.subcommand === 'begin') {
      if (beginApproved || beginCompleted) return reject('begin_reused');
      if (active.phase !== 'capture') return reject('begin_phase_mismatch');
      assertDoctorPromptFile(canonicalPromptFile, promptSha256);
      beginApproved = true;
    } else if (!beginCompleted) {
      return reject('begin_not_completed');
    }
    const argvSha256 = doctorRuntimeArgvDigest(params.command);
    if (argvSha256 === null) return reject('argv_invalid');
    const record = Object.freeze({
      sequence: ++sequence,
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      approvalId,
      phase: active.phase,
      command: params.command,
      argvSha256,
      runtimeSubcommand: invocation.subcommand,
      runDirectory: invocation.runDirectory,
    });
    pending.set(params.itemId, record);
    seenItems.add(params.itemId);
    history.push(Object.freeze({ ...record, event: 'approved' }));
    lastRejection = null;
    return record;
  };

  const bindCompletion = (message) => {
    const params = message?.params ?? {};
    const item = params.item ?? {};
    if (message?.method !== 'item/completed' || item.type !== 'commandExecution') return null;
    if (!looksLikeDoctorRuntimeAttempt(item.command)) return null;
    const record = pending.get(item.id);
    if (
      !record
      || params.threadId !== record.threadId
      || params.turnId !== record.turnId
      || doctorRuntimeArgvDigest(item.command) !== record.argvSha256
    ) {
      throw new Error('deep Doctor runtime completion has no exact one-shot host approval binding');
    }
    pending.delete(item.id);
    const succeeded = item.status === 'completed' && item.exitCode === 0;
    if (!succeeded && record.runtimeSubcommand === 'begin') {
      throw new Error(`deep Doctor approved runtime ${record.runtimeSubcommand} failed`);
    }
    if (record.runtimeSubcommand === 'begin') beginCompleted = true;
    const completion = Object.freeze({
      ...record,
      sequence: ++sequence,
      event: succeeded ? 'completed' : 'failed',
      status: item.status ?? null,
      exitCode: item.exitCode ?? null,
    });
    history.push(completion);
    return completion;
  };

  return Object.freeze({
    authorize,
    bindCompletion,
    assertNoPending() {
      if (pending.size !== 0) throw new Error('deep Doctor runtime host approval has no completion');
    },
    snapshot() {
      return Object.freeze({
        beginApproved,
        beginCompleted,
        pending: pending.size,
        lastRejection,
        history: Object.freeze([...history]),
      });
    },
  });
}

function looksLikeDoctorRuntimeAttempt(command) {
  const tokens = unwrapExactCommand(command);
  if (Array.isArray(tokens)) {
    const runtimeIndex = tokens.findIndex((token) => (
      token === 'cruise-runtime'
      || token === 'cruise-runtime.mjs'
      || basename(token) === 'cruise-runtime.mjs'
    ));
    if (runtimeIndex < 0) return false;
    if (runtimeIndex === 0) return true;
    return runtimeIndex === 1 && /^(?:node|nodejs)(?:[0-9.]*)?$/u.test(basename(tokens[0]));
  }
  // A malformed, compound, or substitution-bearing shell command must still
  // count as the first attempt so that a later exact retry cannot erase it.
  // Merely reading or searching the runtime source is not an execution
  // attempt and therefore has no one-shot approval binding to complete.
  return /(?:^|[;&|]\s*)(?:(?:[^\s;&|/]*\/)?node(?:js)?(?:[0-9.]*)?\s+[^;&|]*cruise-runtime\.mjs|(?:[^\s;&|]*\/)?cruise-runtime(?:\.mjs)?)(?:\s|$)/u.test(
    String(command ?? ''),
  );
}

function inspectFirstDoctorRuntimeAttempt(
  commands,
  expectedRuntimePath,
  expectedNodePath = realpathSync(process.execPath),
) {
  const attempts = (commands ?? [])
    .map((command, commandIndex) => ({ command, commandIndex }))
    .filter(({ command }) => looksLikeDoctorRuntimeAttempt(command?.command));
  const first = attempts[0] ?? null;
  if (!first) {
    return Object.freeze({
      ok: false,
      detail: 'no cruise-runtime command attempt was recorded before worker inference',
    });
  }
  const invocation = parseDoctorRuntimeInvocation(first.command.command, {
    expectedRuntimePath,
    expectedNodePath,
  });
  if (
    !invocation
    || invocation.subcommand !== 'begin'
    || first.command.status !== 'completed'
    || first.command.exitCode !== 0
  ) {
    return Object.freeze({
      ok: false,
      detail: 'the first cruise-runtime attempt was not a successful exact installed `node <plugin-root>/scripts/cruise-runtime.mjs begin ...` command',
      commandIndex: first.commandIndex,
    });
  }
  return Object.freeze({
    ok: true,
    commandIndex: first.commandIndex,
    invocation,
  });
}

export function isCruiseWorkerCommand(command, options = {}) {
  return parseCruiseWorkerInvocation(command, options) !== null;
}

export function selectDoctorRootModel(catalog) {
  const models = Array.isArray(catalog?.data) ? catalog.data : [];
  const supportsMedium = ({ supportedReasoningEfforts }) => (
    Array.isArray(supportedReasoningEfforts)
    && supportedReasoningEfforts.some((entry) => (
      (typeof entry === 'string' ? entry : entry?.reasoningEffort) === 'medium'
    ))
  );
  const selected = models.find((model) => model?.isDefault === true && supportsMedium(model))
    ?? models.find((model) => supportsMedium(model));
  if (!selected || typeof selected.id !== 'string' || !selected.id) {
    throw new Error('Deep Doctor could not select an advertised medium-effort root model');
  }
  return Object.freeze({ model: selected.id, reasoningEffort: 'medium' });
}

function doctorClassifierOutput(skill) {
  const recommendedLevel = skill === 'quick' ? 2 : 3;
  return Object.freeze({
    route: skill,
    recommended_level: recommendedLevel,
    confidence: 0.95,
    ambiguity: 'low',
    semantic_risk: 'low',
    estimated_files: 1,
    estimated_diff_lines: 1,
    public_api_change: false,
    abi_change: false,
    data_migration: false,
    security_sensitive: false,
    concurrency_sensitive: false,
    build_or_release_change: false,
    unknown_indirect_callers: false,
    requires_external_research: false,
    reasons: [],
  });
}

/**
 * Publish the live app-server catalog and deterministic canary classification
 * only after non-destructive foreign-diff monitoring is active. These are
 * harness-owned run inputs, not product files or model-authored evidence.
 */
export async function stageDoctorRouteInputs({ root, skill, modelCatalog }) {
  const runDirectory = await realpath(join(root, '.cruise', 'runs', `doctor-${skill}`));
  const guard = await readForeignDiffGuardState(join(runDirectory, 'drift.yaml'));
  if (guard.status !== 'monitoring') {
    throw new Error('Deep Doctor route inputs may be staged only after foreign-diff monitoring starts');
  }
  const catalog = normalizeModelCatalog(modelCatalog);
  const modelsPath = join(runDirectory, 'models.json');
  const classifierPath = join(runDirectory, 'classifier.yaml');
  await writeFile(modelsPath, `${canonicalJson(catalog)}\n`, { flag: 'wx', mode: 0o400 });
  try {
    await writeFile(classifierPath, stringifyYaml(doctorClassifierOutput(skill)), {
      flag: 'wx',
      mode: 0o400,
    });
  } catch (error) {
    await rm(modelsPath, { force: true }).catch(() => {});
    throw error;
  }
  return Object.freeze({ runDirectory, modelsPath, classifierPath });
}

export function createDoctorCanaryPrompt({
  skill,
  prompt,
  phase = null,
  workerExecutable = '/doctor-attested/cruise.mjs',
  runtimeExecutable = null,
  repositoryRoot = null,
  nodeExecutable = realpathSync(process.execPath),
  runtimePromptFile = null,
}) {
  const workflowInitialPhase = {
    build: 'draft',
    refine: 'draft',
    goal: 'plan-draft',
  }[skill] ?? 'single';
  const selectedPhase = phase ?? workflowInitialPhase;
  const isCapturePhase = selectedPhase === 'capture';
  // An omitted phase remains the convenient whole-workflow prompt used by
  // callers and prompt-contract tests. Deep Doctor itself always names the
  // capture and continuation phases explicitly.
  const isWholeWorkflowPrompt = phase === null;
  const carriesInitialInvocation = isCapturePhase || isWholeWorkflowPrompt;
  const initialRunDirectory = repositoryRoot === null
    ? null
    : join(repositoryRoot, '.cruise', 'runs', `doctor-${skill}`);
  const invocation = carriesInitialInvocation
    ? `$cruise:${skill} ${prompt}`
    : `Continue the existing cruise:${skill} canary from the preceding turn on this same thread.`;
  const common = [
    invocation,
    '',
    'Use the repository-local $spatiomics-skill for domain methods and fixture validation.',
    'This is a bounded installed-skill inference canary in a disposable real repository.',
    ...(skill === 'debug'
      ? ['The tracked tests/fail.test.mjs is an intentional failing canary input committed in the fixture baseline; its failing assertion is expected, and it is the only allowed repair target.']
      : [
          'The requested output is intentionally absent at baseline; that is expected.',
          'Because the requested output begins untracked, complete change-set evidence must include an untracked-aware inventory rather than relying only on `git diff`.',
        ]),
    'Files under the exact current .cruise/runs/<run-id>/ directory are expected run-control state created after baseline capture, not product drift.',
    `Invoke every worker with the exact Doctor-attested executable \`${workerExecutable}\`; never use the PATH token \`cruise\` or another executable path. The command cwd and \`-C\` must both be this canonical repository.`,
    runtimeExecutable && repositoryRoot && runtimePromptFile
      ? carriesInitialInvocation
        ? [
            '`cruise-runtime` is not on PATH and a bare invocation will fail.',
            `The first runtime attempt must be exactly \`${nodeExecutable} ${runtimeExecutable} begin --skill ${skill} --root ${repositoryRoot} --prompt-file ${runtimePromptFile}\`. Level 1 must assign the reserved informative run name \`doctor-${skill}\`, producing \`${initialRunDirectory}\`.`,
            '`begin --help`, source probing through the runtime executable, a different run ID, a relative root, stdin, or any other earlier cruise-runtime attempt makes this canary fail even if a later retry succeeds.',
            'Set `sandbox_permissions` to `require_escalated` on that exact first command and every later installed-runtime command. Deep Doctor noninteractively accepts only one exact tokenized command item at a time for this installed executable and deterministic canary run. Omit `prefix_rule`, session-wide amendments, network requests, and extra writable roots. Never try a runtime command in the repository-only sandbox first.',
          ].join(' ')
        : [
            `The deterministic \`${nodeExecutable} ${runtimeExecutable} begin\` command already completed in the capture turn; do not repeat or probe it.`,
            'Every later installed-runtime command must use those same exact executable paths, the existing deterministic run directory, and `sandbox_permissions: "require_escalated"` on its first attempt.',
          ].join(' ')
      : runtimeExecutable
        ? `\`cruise-runtime\` is not on PATH and a bare invocation will fail. On the first attempt, every root command must start with the exact \`node ${runtimeExecutable} <subcommand> ...\` invocation.`
      : '`cruise-runtime` is not on PATH and a bare invocation will fail. On the first attempt, every root command must spell the exact `node <verified-installed-plugin-root>/scripts/cruise-runtime.mjs <subcommand> ...` invocation.',
    'The exact `map-pkt.yaml` was generated atomically by `begin`. Pass that tagged packet unchanged to the first mapping worker; do not hand-write, replace, or repair it. Cruise preflights the executable packet and embedded 18-fact template before inference.',
    'The semantic-mapping worker owns only the packet-declared `map-facts.yaml`. It copies the complete `enrichment_template` and may change only `facts[*].value` and `facts[*].basis`; it must not invoke `enrich-probe`, `route`, or mutate canonical run-control files. After the worker report and ownership audit, the root coordinator alone runs `enrich-probe` through the exact installed runtime path.',
    `When routing, never guess a shortened runtime command or inspect its implementation to infer arguments. The route invocation requires \`--skill ${skill} --run-dir ${initialRunDirectory ?? '<run-dir>'} --classifier ${join(initialRunDirectory ?? '<run-dir>', 'classifier.yaml')} --catalog-json ${join(initialRunDirectory ?? '<run-dir>', 'models.json')}\`; add \`--retry-classifier\` only when the persisted initial classifier requires the documented uncertainty retry.`,
    ...(!isCapturePhase && phase !== null
      ? ['Deep Doctor has already staged the immutable live app-server catalog at `models.json` and the deterministic canary classification at `classifier.yaml`. Treat both as harness-owned run inputs: read and use them, but do not create, replace, or edit them.']
      : []),
    'The harness already verified model-policy and worker-host-rule readiness. Do not invoke `cruise doctor` (including `cruise doctor --json`, `cruise doctor --deep`, or `cruise doctor --troubleshoot`) inside this fixture.',
    ...(isCapturePhase
      ? [
          'This capture phase is a writable/default turn. Run the exact `begin` command once, verify that non-destructive foreign-diff monitoring is active, and then stop this turn immediately.',
          'Do not call the native structured input tool, launch a worker, inspect substantive repository content, or make another run-control write in this capture phase. A clean run has no speculative foreign-diff question.',
        ]
      : phase !== null
        ? [
            'Non-destructive foreign-diff monitoring is already active. Do not ask a speculative start question; ask about foreign drift only if the runtime reports a concrete incident whose resolution requires user intent.',
            'Other structured decisions and fixture-local approvals are answered by the canary client in their designated Plan turns.',
          ]
        : [
            'Follow both skill contracts normally. `begin` activates non-destructive foreign-diff monitoring without a user decision. Do not ask a speculative foreign-diff start question; ask only if the runtime reports a concrete incident whose resolution requires user intent. Other structured decisions and fixture-local approvals are answered by the canary client.',
          ]),
  ];
  if (isCapturePhase) return common.join('\n');
  const stagedPhases = {
    build: {
      draft: [
        '',
        'Build canary phase 1 is a writable/default turn. Do not stop at a prose plan.',
        'Create and validate the pre-approval project and milestone drafts, exercise the real `cruise worker` host path, display the exact Build review card, and request the native structured **Approve Foundation** or **Approve Milestone** choice.',
        'After the structured answer, capture and finalize the approved Build in this turn when possible. Do not use MCP elicitation for the Build approval.',
      ],
      approval: [
        '',
        'Build canary approval phase is read-only. The preceding writable turn created the draft bytes.',
        'Read and validate those exact drafts, display their exact review card and review digest, then use the native structured input tool to request exactly **Approve Foundation** or **Approve Milestone**.',
        'Do not edit files in this approval turn and do not substitute a prose or MCP approval. Stop after the native structured answer is recorded.',
      ],
      execute: [
        '',
        'Build canary execution phase is a writable/default continuation on the same thread.',
        'Continue the exact Build whose native structured approval appears in the immediately preceding thread history. Revalidate the reviewed bytes and digest, capture the approval through the normal Build boundary, finish the approved project and milestone state, and preserve strict run evidence.',
        'Do not redraft unrelated content, stop at a prose plan, or invoke any Doctor command.',
      ],
    },
    refine: {
      draft: [
        '',
        'Refine canary draft phase is a writable/default turn. Do not stop after writing PLAN.md or at a prose plan.',
        'Create and validate the proportional Refine plan through the real `cruise worker` host path, display the digest-bound plan review, and request exactly **Approve Plan** with the native structured input tool.',
        'If native input is available, capture that approval and complete implementation plus independent verification in this turn. Do not substitute MCP elicitation or free text.',
      ],
      'plan-approval': [
        '',
        'Refine canary approval phase is read-only. The preceding writable turn created the exact Plan bytes.',
        'Read and validate that Plan and its repository-baseline binding, display the compact review, and request exactly **Approve Plan** with the native structured input tool.',
        'Do not edit files or substitute prose/MCP approval in this turn. Stop after the native structured answer is recorded.',
      ],
      execute: [
        '',
        'Refine canary execution phase is a writable/default continuation on the same thread.',
        'Use the exact native **Approve Plan** selection in the preceding thread history, revalidate its Plan and baseline digests, then execute the approved finite plan through bounded workers and finish independent verification.',
        'Do not redraft unrelated content, request a second approval, recursively invoke Refine, or invoke any Doctor command.',
      ],
    },
    goal: {
      'plan-draft': [
        '',
        'Goal canary combined-draft phase is a writable/default turn. Keep implementation inactive.',
        'Resolve the one Goal-specific needs envelope using **Reject all** for this no-external-effects fixture. Create and validate PLAN.md and GOAL.md together through the real `cruise worker` host path, present their deterministic combined preview with full-file links and bound revisions, and request exactly **Approve both** with **Refine** and **Reject both** as the other options.',
        'For the planned new documentation file, make every sole-write evidence gate untracked-aware; `git diff` alone cannot prove the complete product change set.',
        'Approve both locks the complete suite and authorizes native Goal activation. Do not use MCP/free-text approval, edit a candidate byte after the review is offered, activate Goal yourself, or implement the target yet.',
      ],
      'plan-approval': [
        '',
        'Goal canary combined-approval phase is read-only. The preceding writable turn created the exact complete suite.',
        'Read and validate PLAN.md and GOAL.md, present their deterministic combined preview with full-file links and bound revisions, and request exactly **Approve both** with **Refine** and **Reject both** as the other options.',
        'Do not edit files, request a second approval, or substitute prose/MCP approval in this turn. Stop after the structured answer.',
      ],
      execute: [
        '',
        'Goal canary execution phase is a writable/default continuation after one exact combined **Approve both** selection on this same thread.',
        'Revalidate the complete-suite approval snapshot, use the native Goal control plane exposed by this host exactly once, confirm the Goal is active, execute the approved current slice through bounded workers, and finish strict closeout evidence.',
        'Do not reroute, repeat approval, recursively invoke Goal, or invoke any Doctor command.',
      ],
    },
  };
  const phases = stagedPhases[skill];
  if (!phases) return common.join('\n');
  const instructions = phases[selectedPhase];
  if (!instructions) {
    const displaySkill = `${skill.slice(0, 1).toUpperCase()}${skill.slice(1)}`;
    throw new TypeError(`Unsupported ${displaySkill} canary phase ${selectedPhase}`);
  }
  return [...common, ...instructions].join('\n');
}

function nativeRecordHasExactApproval({ method, answers } = {}, label) {
  if (method !== 'item/tool/requestUserInput' || !answers || typeof answers !== 'object') {
    return false;
  }
  return Object.values(answers).some((answer) => (
    Array.isArray(answer?.answers) &&
    answer.answers.length === 1 &&
    answer.answers[0] === label
  ));
}

export function hasNativeExactApproval(approvals, label) {
  return (approvals ?? []).some((record) => nativeRecordHasExactApproval(record, label));
}

export function hasNativeApprovalSequence(approvals, labels) {
  let previousRecord = -1;
  for (const label of labels) {
    const record = (approvals ?? []).findIndex((approval, index) => (
      index > previousRecord
      && nativeRecordHasExactApproval(approval, label)
    ));
    if (record < 0) return false;
    previousRecord = record;
  }
  return true;
}

export function hasNativeBuildApproval(approvals) {
  return (approvals ?? []).some((record) => (
    ['draft', 'approval'].includes(record?.phase)
    && (
      nativeRecordHasExactApproval(record, 'Approve Foundation')
      || nativeRecordHasExactApproval(record, 'Approve Milestone')
    )
  ));
}

export function hasNativeRefineApproval(approvals) {
  return (approvals ?? []).some((record) => (
    ['draft', 'plan-approval'].includes(record?.phase)
    && nativeRecordHasExactApproval(record, 'Approve Plan')
  ));
}

export function hasNativeGoalApprovals(approvals) {
  return (approvals ?? []).some((record) => (
    ['plan-draft', 'plan-approval'].includes(record?.phase)
    && nativeRecordHasExactApproval(record, 'Approve both')
  ));
}

export function hasNativeGoalControlUpdate(goalUpdates) {
  return (goalUpdates ?? []).some(({ id, status, phase }) => (
    typeof id === 'string'
    && id.length > 0
    && typeof status === 'string'
    && status.length > 0
    && phase === 'execute'
  ));
}

function completedCommandOutput(item) {
  const sections = [];
  for (const field of ['aggregatedOutput', 'output', 'stdout', 'stderr']) {
    if (typeof item?.[field] === 'string' && item[field]) sections.push(item[field]);
  }
  const sanitized = sanitizeWorkerDiagnosticText(sections.join(sections.length > 1 ? '\n' : ''));
  if (sanitized.length <= 8_192) return sanitized;
  return `${sanitized.slice(0, 4_096)}\n…[bounded]…\n${sanitized.slice(-4_096)}`;
}

const MAX_DOCTOR_COMPLETION_ARTIFACT_BYTES = 4 * 1024 * 1024;

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readDoctorCompletionArtifact(root, path, label) {
  const requestedRoot = resolve(root);
  const requestedPath = resolve(requestedRoot, path);
  if (!isPathInside(requestedRoot, requestedPath)) {
    throw new Error(`${label} escapes the Doctor repository root`);
  }
  const metadata = lstatSync(requestedPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (metadata.size > MAX_DOCTOR_COMPLETION_ARTIFACT_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_DOCTOR_COMPLETION_ARTIFACT_BYTES}-byte evidence bound`);
  }
  const canonicalRoot = realpathSync(requestedRoot);
  const canonicalPath = realpathSync(requestedPath);
  if (!isPathInside(canonicalRoot, canonicalPath)) {
    throw new Error(`${label} resolves outside the Doctor repository root`);
  }
  return readFileSync(canonicalPath);
}

function doctorScenarioArtifactPaths(root, skill) {
  const paths = [];
  const add = (path) => {
    try {
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`Doctor scenario artifact must be a regular non-symlink file: ${path}`);
      }
      paths.push(path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  };
  if (skill === 'build') {
    add(join(root, '.cruise', 'project', 'PROJECT.md'));
    const milestones = join(root, '.cruise', 'milestones');
    try {
      for (const entry of readdirSync(milestones, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error(`Doctor milestone cannot be a symlink: ${entry.name}`);
        if (entry.isDirectory()) add(join(milestones, entry.name, 'MILESTONE.md'));
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  } else if (skill === 'quick') {
    add(join(root, 'doctor-ok.txt'));
  } else if (skill === 'refine') {
    add(join(root, 'docs', 'refine-ok.md'));
  } else if (skill === 'goal') {
    add(join(root, 'docs', 'DOCTOR-GOAL.md'));
  } else if (skill === 'debug') {
    add(join(root, 'tests', 'fail.test.mjs'));
  }
  return paths.sort((left, right) => left.localeCompare(right, 'en'));
}

function snapshotDoctorScenarioArtifacts(root, skill) {
  return Object.freeze(doctorScenarioArtifactPaths(root, skill).map((path) => Object.freeze({
    path: relative(resolve(root), resolve(path)).split(sep).join('/'),
    sha256: sha256Bytes(readDoctorCompletionArtifact(root, path, 'Doctor scenario artifact')),
  })));
}

/** Snapshot exact worker inputs/outputs synchronously at command completion. */
export function captureDoctorWorkerCompletionEvidence({
  root,
  command,
  workerExecutable = 'cruise',
  skill = null,
}) {
  const invocation = parseCruiseWorkerInvocation(command, {
    expectedExecutable: workerExecutable,
  });
  if (!invocation || resolve(root, invocation.cwd) !== resolve(root)) return null;
  const packet = readDoctorCompletionArtifact(root, invocation.packet, 'worker packet');
  if (sha256Bytes(packet) !== invocation.packetSha256) return null;
  const report = readDoctorCompletionArtifact(root, invocation.report, 'worker report');
  const evidence = {
    packet_sha256: sha256Bytes(packet),
    report_sha256: sha256Bytes(report),
    scenario_artifacts: snapshotDoctorScenarioArtifacts(root, skill),
  };
  if (basename(resolve(root, invocation.packet)) === 'map-pkt.yaml') {
    const semanticFactsPath = join(dirname(resolve(root, invocation.packet)), 'map-facts.yaml');
    evidence.semantic_facts_sha256 = sha256Bytes(
      readDoctorCompletionArtifact(root, semanticFactsPath, 'semantic mapping facts'),
    );
  }
  return Object.freeze(evidence);
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  }
}

async function regularDirectory(path, label) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
  return realpath(path);
}

async function verifiedInstalledRuntimePath(pluginRoot) {
  const path = resolve(pluginRoot, 'scripts', 'cruise-runtime.mjs');
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Installed Cruise runtime must be a regular file: ${path}`);
  }
  const canonical = await realpath(path);
  const canonicalRoot = await realpath(pluginRoot);
  if (!isPathInside(canonicalRoot, canonical)) {
    throw new Error('Installed Cruise runtime resolves outside the installed plugin root');
  }
  return canonical;
}

async function walkFiles(root, relative = '') {
  const files = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const child = join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Doctor fixture cannot contain symlinks: ${child}`);
    if (entry.isDirectory()) files.push(...await walkFiles(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

export async function validateDoctorFixture(path) {
  const root = await regularDirectory(resolve(path), 'Doctor fixture');
  const files = await walkFiles(root);
  if (!files.some((file) => file === '.cruise/README.md' || file.startsWith('.cruise/'))) {
    throw new Error('Doctor fixture must include its own .cruise directory.');
  }
  const requiredSpatiomicsSurface = [
    '.agents/skills/spatiomics-skill/SKILL.md',
    '.agents/skills/spatiomics-skill/agents/openai.yaml',
    '.agents/skills/spatiomics-skill/references/formats.md',
    '.agents/skills/spatiomics-skill/references/tools.md',
    '.agents/skills/spatiomics-skill/references/workflow.md',
    '.agents/skills/spatiomics-skill/scripts/inspect_spatial_inputs.py',
    'workflow/Snakefile',
    'tests/spatiomics-fixture.test.mjs',
  ];
  const missing = requiredSpatiomicsSurface.filter((file) => !files.includes(file));
  if (missing.length > 0) {
    throw new Error(`Doctor fixture must implement spatiomics-skill; missing ${missing.join(', ')}`);
  }
  const fixtureTest = spawnSync(process.execPath, ['--test', 'tests/spatiomics-fixture.test.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (fixtureTest.status !== 0) {
    throw new Error(
      `Doctor spatiomics fixture failed its offline test: ${String(fixtureTest.stderr || fixtureTest.stdout).trim()}`,
    );
  }
  return Object.freeze({ root, files: Object.freeze(files) });
}

function findForbiddenWorkerUx(value) {
  return FORBIDDEN_WORKER_UX.find((pattern) => pattern.test(String(value ?? ''))) ?? null;
}

function expectedDoctorReviewLabels(skill, phase) {
  if (skill === 'build' && ['draft', 'approval'].includes(phase)) {
    return Object.freeze(['Approve Foundation', 'Approve Milestone']);
  }
  if (skill === 'refine' && ['draft', 'plan-approval'].includes(phase)) {
    return Object.freeze(['Approve Plan']);
  }
  if (skill === 'goal' && ['plan-draft', 'plan-approval'].includes(phase)) {
    return Object.freeze(['Approve both']);
  }
  return Object.freeze([]);
}

function exactDoctorReviewAnswer({ questions, skill, phase }) {
  const expected = expectedDoctorReviewLabels(skill, phase);
  if (!Array.isArray(questions) || questions.length !== 1 || expected.length === 0) return null;
  const [question] = questions;
  if (typeof question?.id !== 'string' || !question.id.trim()) return null;
  const options = Array.isArray(question.options) ? question.options : [];
  if (skill === 'goal') {
    const labels = options.map(({ label }) => String(label ?? ''));
    if (
      labels.length !== 3 ||
      labels[0] !== 'Approve both' ||
      labels[1] !== 'Refine' ||
      labels[2] !== 'Reject both'
    ) {
      return null;
    }
  }
  const matches = options
    .map(({ label }) => String(label ?? '').trim())
    .filter((label) => expected.includes(label));
  if (matches.length !== 1) return null;
  const prompt = String(question.question ?? '').trim();
  const expectedSubject = matches[0] === 'Approve Foundation'
    ? /\bfoundation\b/iu
    : matches[0] === 'Approve Milestone'
      ? /\bmilestone\b/iu
      : matches[0] === 'Approve Plan' || matches[0] === 'Approve both'
        ? /\bplan\b/iu
        : /\bstart\s+cruise\b|\bgoal\b/iu;
  if (!prompt || !expectedSubject.test(prompt)) return null;
  return Object.freeze({ id: question.id, label: matches[0] });
}

function exactDoctorGoalNeedsAnswer({ questions, skill, phase }) {
  if (skill !== 'goal' || phase !== 'plan-draft' || questions?.length !== 1) {
    return null;
  }
  const [question] = questions;
  const labels = (question?.options ?? []).map(({ label }) => String(label ?? ''));
  if (
    typeof question?.id !== 'string' ||
    !question.id.trim() ||
    labels.length !== 4 ||
    labels[0] !== 'Approve all' ||
    labels[1] !== 'Select some' ||
    labels[2] !== 'Reject all' ||
    labels[3] !== 'Discuss'
  ) {
    return null;
  }
  return Object.freeze({ id: question.id, label: 'Reject all' });
}

export function answerDoctorServerRequest(message, {
  approvals = [],
  skill = null,
  workerExecutable = 'cruise',
  runtimeHostGate = null,
  context = () => ({}),
} = {}) {
  const params = message.params ?? {};
  switch (message.method) {
    case 'item/tool/requestUserInput': {
      const questions = params.questions ?? [];
      const forbidden = findForbiddenWorkerUx(JSON.stringify(questions));
      if (forbidden) {
        approvals.push({
          method: message.method,
          questions,
          worker: true,
          forbiddenWorkerUx: true,
          ...context(),
        });
        throw new Error(`Deep Doctor rejected forbidden worker-boundary UX (${forbidden})`);
      }
      const requestContext = context();
      const review = exactDoctorReviewAnswer({
        questions,
        skill,
        phase: requestContext.phase,
      }) ?? exactDoctorGoalNeedsAnswer({
        questions,
        skill,
        phase: requestContext.phase,
      });
      if (!review) {
        approvals.push({
          method: message.method,
          questions,
          worker: false,
          unexpectedStructuredInput: true,
          ...requestContext,
        });
        throw new Error('Deep Doctor rejected unexpected native structured input');
      }
      const response = {
        answers: { [review.id]: { answers: [review.label] } },
      };
      approvals.push({
        method: message.method,
        questions,
        answers: response.answers,
        worker: false,
        ...requestContext,
      });
      return response;
    }
    case 'item/commandExecution/requestApproval': {
      const worker = isCruiseWorkerCommand(params.command, { expectedExecutable: workerExecutable });
      const runtimeApproval = runtimeHostGate?.authorize(message) ?? null;
      if (runtimeApproval !== null) {
        approvals.push({
          method: message.method,
          command: params.command ?? null,
          worker: false,
          doctorRuntimeHostPath: true,
          runtimeSubcommand: runtimeApproval.runtimeSubcommand,
          runDirectory: runtimeApproval.runDirectory,
          threadId: runtimeApproval.threadId,
          turnId: runtimeApproval.turnId,
          itemId: runtimeApproval.itemId,
          approvalId: runtimeApproval.approvalId,
          argvSha256: runtimeApproval.argvSha256,
          ...context(),
        });
        return { decision: 'accept' };
      }
      approvals.push({
        method: message.method,
        command: params.command ?? null,
        worker,
        unexpectedEscalation: true,
        runtimeHostRejection: runtimeHostGate?.snapshot().lastRejection ?? null,
      });
      return { decision: 'decline' };
    }
    case 'item/fileChange/requestApproval':
      approvals.push({
        method: message.method,
        command: params.command ?? null,
        worker: false,
        unexpectedEscalation: true,
      });
      return { decision: 'decline' };
    case 'execCommandApproval': {
      const worker = isCruiseWorkerCommand(params.command, { expectedExecutable: workerExecutable });
      approvals.push({
        method: message.method,
        command: params.command ?? null,
        worker,
        unexpectedEscalation: true,
      });
      return { decision: 'denied' };
    }
    case 'applyPatchApproval':
      approvals.push({
        method: message.method,
        command: params.command ?? null,
        worker: false,
        unexpectedEscalation: true,
      });
      return { decision: 'denied' };
    case 'item/permissions/requestApproval':
      approvals.push({ method: message.method, permissions: params.permissions ?? {}, worker: true });
      return { permissions: {}, scope: 'turn' };
    case 'mcpServer/elicitation/request': {
      const response = { action: 'decline', content: null, _meta: null };
      approvals.push({
        method: message.method,
        serverName: params.serverName ?? null,
        action: response.action,
        worker: false,
        unexpectedStructuredInput: true,
        request: sanitizeWorkerDiagnosticText(JSON.stringify({
          mode: params.mode ?? null,
          message: params.message ?? params.prompt ?? null,
          requestedSchema: params.requestedSchema ?? null,
        })).slice(0, 4_096),
        ...context(),
      });
      return response;
    }
    case 'currentTime/read':
      return { currentTimeAt: Math.floor(Date.now() / 1000) };
    default:
      throw new Error(`Deep Doctor cannot answer app-server request ${message.method}`);
  }
}

async function copyInstalledPluginSurface(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const relativePath of STAGED_PLUGIN_PATHS) {
    await cp(join(source, relativePath), join(destination, relativePath), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  return realpath(destination);
}

export async function stageInstalledPlugin(codexHome, installedPluginRoot) {
  const source = await regularDirectory(resolve(installedPluginRoot), 'Installed Cruise plugin');
  const manifest = JSON.parse(await readFile(join(source, '.codex-plugin', 'plugin.json'), 'utf8'));
  const version = manifest?.version;
  if (typeof version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/u.test(version)) {
    throw new Error('Installed Cruise plugin manifest has no safe cache version');
  }
  const destination = join(
    codexHome,
    'plugins',
    'cache',
    'agent-local',
    'cruise',
    version,
  );
  return copyInstalledPluginSurface(source, destination);
}

export async function discoverInstalledCruiseSkills(client, { root, pluginRoot }) {
  const verifiedPluginRoot = await realpath(pluginRoot);
  const response = await client.request('skills/list', { cwds: [root], forceReload: true });
  const entries = Array.isArray(response?.data) ? response.data : [];
  const entry = entries.find((candidate) => resolve(candidate.cwd) === resolve(root)) ?? entries[0];
  if (!entry || !Array.isArray(entry.skills)) {
    throw new Error('installed Cruise skills were not returned by skills/list');
  }
  const relevantErrors = (entry.errors ?? []).filter(({ path }) => isPathInside(verifiedPluginRoot, path));
  if (relevantErrors.length > 0) {
    throw new Error(`installed Cruise skill scan failed: ${relevantErrors.map(({ message }) => message).join('; ')}`);
  }
  const expected = DOCTOR_SKILL_CASES.map(({ skill }) => skill).sort();
  const candidates = entry.skills.filter(({ name }) => String(name).startsWith('cruise:'));
  const actual = candidates.map(({ name }) => String(name).slice('cruise:'.length)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`skills/list expected ${expected.join(', ')}; found ${actual.join(', ') || 'none'}`);
  }
  const descriptors = {};
  for (const skill of expected) {
    const descriptor = candidates.find(({ name }) => name === `cruise:${skill}`);
    if (!descriptor.enabled) throw new Error(`${descriptor.name} is disabled`);
    const actualPath = await realpath(descriptor.path);
    const expectedPath = await realpath(join(verifiedPluginRoot, 'skills', skill, 'SKILL.md'));
    if (actualPath !== expectedPath || !isPathInside(verifiedPluginRoot, actualPath)) {
      throw new Error(`${descriptor.name} resolved outside the verified installed cache`);
    }
    descriptors[skill] = Object.freeze({ name: descriptor.name, path: actualPath });
  }
  return Object.freeze(descriptors);
}

export async function discoverRepositorySpatiomicsSkill(client, { root }) {
  const repositoryRoot = await realpath(root);
  const expectedRoot = await realpath(join(repositoryRoot, '.agents', 'skills', 'spatiomics-skill'));
  const expectedPath = await realpath(join(expectedRoot, 'SKILL.md'));
  const response = await client.request('skills/list', { cwds: [repositoryRoot], forceReload: true });
  const entries = Array.isArray(response?.data) ? response.data : [];
  const entry = entries.find((candidate) => resolve(candidate.cwd) === repositoryRoot) ?? entries[0];
  if (!entry || !Array.isArray(entry.skills)) {
    throw new Error('repository spatiomics-skill was not returned by skills/list');
  }
  const relevantErrors = (entry.errors ?? []).filter(({ path }) => (
    typeof path === 'string' && isPathInside(expectedRoot, path)
  ));
  if (relevantErrors.length > 0) {
    throw new Error(`repository spatiomics-skill scan failed: ${relevantErrors.map(({ message }) => message).join('; ')}`);
  }
  const candidates = entry.skills.filter(({ name }) => name === 'spatiomics-skill');
  if (candidates.length !== 1) {
    throw new Error(`skills/list expected one repository spatiomics-skill; found ${candidates.length}`);
  }
  const [descriptor] = candidates;
  if (!descriptor.enabled) throw new Error('repository spatiomics-skill is disabled');
  if (descriptor.scope !== 'repo') {
    throw new Error(`repository spatiomics-skill has unexpected scope ${descriptor.scope ?? '<missing>'}`);
  }
  const actualPath = await realpath(descriptor.path);
  if (actualPath !== expectedPath || !isPathInside(repositoryRoot, actualPath)) {
    throw new Error('repository spatiomics-skill resolved outside the disposable fixture');
  }
  return Object.freeze({ name: descriptor.name, path: actualPath, scope: descriptor.scope });
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function createDoctorSessionDeadline(timeoutMs, label) {
  if (timeoutMs !== null) return createDeadline(timeoutMs, label);
  return Object.freeze({
    timeoutMs: null,
    remaining() {
      return Number.POSITIVE_INFINITY;
    },
    async run(stage, operation, { signals = [] } = {}) {
      if (typeof stage !== 'string' || !stage.trim()) {
        throw new TypeError('deadline stage is required');
      }
      if (typeof operation !== 'function') {
        throw new TypeError('deadline operation must be a function');
      }
      return Promise.race([
        Promise.resolve().then(operation),
        ...signals,
      ]);
    },
  });
}

export function createDoctorTurnController() {
  let active = null;
  const retiredTurnIds = new Set();
  const requireActive = (handle) => {
    if (!active || active !== handle) {
      throw new Error('Deep Doctor turn handle is not active');
    }
  };
  return Object.freeze({
    begin(label) {
      if (active) throw new Error(`Deep Doctor turn ${active.label} is still active`);
      const completion = deferred();
      active = { label, id: null, ...completion };
      return active;
    },
    bind(handle, turnId) {
      requireActive(handle);
      if (typeof turnId !== 'string' || !turnId) {
        throw new Error('Deep Doctor turn/start returned no turn id');
      }
      if (retiredTurnIds.has(turnId)) {
        throw new Error(`Deep Doctor turn/start replayed retired turn id ${turnId}`);
      }
      if (handle.id && handle.id !== turnId) {
        throw new Error(`Deep Doctor turn id changed from ${handle.id} to ${turnId}`);
      }
      handle.id = turnId;
    },
    started(turnId) {
      if (!active || typeof turnId !== 'string' || !turnId) return false;
      if (retiredTurnIds.has(turnId)) return false;
      if (active.id && active.id !== turnId) return false;
      active.id = turnId;
      return true;
    },
    resolve(turn) {
      const turnId = turn?.id;
      if (!active || typeof turnId !== 'string' || !turnId) return false;
      if (retiredTurnIds.has(turnId)) return false;
      if (active.id && active.id !== turnId) return false;
      active.id = turnId;
      active.resolve(turn);
      return true;
    },
    reject(error, turnId = null) {
      if (!active) return false;
      if (turnId && retiredTurnIds.has(turnId)) return false;
      if (turnId && active.id && active.id !== turnId) return false;
      active.reject(error);
      return true;
    },
    release(handle) {
      requireActive(handle);
      if (handle.id) retiredTurnIds.add(handle.id);
      active = null;
    },
    current() {
      return active ? Object.freeze({ label: active.label, id: active.id }) : null;
    },
  });
}

async function stagedCanaryIsComplete(root, skill) {
  try {
    const proof = await inspectDoctorWorkflowProof(root, skill);
    if (!proof.ok) return false;
    await inspectDoctorScenarioOutcome(root, skill);
    return true;
  } catch {
    return false;
  }
}

async function assertDoctorPhaseContinuationReady({
  root,
  skill,
  runtimeExecutable,
  promptFile,
  promptSha256,
  commands,
  runtimeHostGate,
  expectedGuardStatus = 'monitoring',
}) {
  const attempt = inspectFirstDoctorRuntimeAttempt(
    commands,
    runtimeExecutable,
    realpathSync(process.execPath),
  );
  const command = attempt.ok ? commands[attempt.commandIndex] : null;
  const scoped = command === null ? null : parseDoctorRuntimeHostInvocation(command.command, {
    expectedRuntimePath: runtimeExecutable,
    expectedNodePath: realpathSync(process.execPath),
    repositoryRoot: root,
    skill,
    promptFile,
  });
  if (
    !attempt.ok
    || scoped?.subcommand !== 'begin'
    || command?.hostExecutionBinding?.runtimeSubcommand !== 'begin'
    || runtimeHostGate.snapshot().beginCompleted !== true
  ) {
    throw new Error(
      `Deep Doctor ${skill} cannot enter a later phase before one successful exact host-bound runtime begin`,
    );
  }
  assertDoctorPromptFile(promptFile, promptSha256);
  const expectedRunDirectory = join(await realpath(root), '.cruise', 'runs', `doctor-${skill}`);
  const runDirectory = await regularDirectory(expectedRunDirectory, 'Deep Doctor canonical run');
  if (runDirectory !== expectedRunDirectory || scoped.runDirectory !== runDirectory) {
    throw new Error(`Deep Doctor ${skill} canonical run directory is missing or redirected`);
  }
  const originPath = join(runDirectory, 'origin.yaml');
  const statePath = join(runDirectory, 'state.yaml');
  for (const [path, label] of [[originPath, 'origin'], [statePath, 'state']]) {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || await realpath(path) !== path) {
      throw new Error(`Deep Doctor canonical run ${label} must be a direct regular file`);
    }
  }
  const [origin, state, guard] = await Promise.all([
    readYamlFile(originPath),
    readYamlFile(statePath),
    readForeignDiffGuardState(join(runDirectory, 'drift.yaml')),
  ]);
  validateOriginRecord(origin);
  validateRunState(state);
  if (
    origin.origin.selected_skill !== skill
    || origin.origin.prompt_sha256 !== promptSha256
    || state.run_id !== `doctor-${skill}`
    || state.selected_skill !== skill
    || ['blocked', 'failed'].includes(state.status)
    || guard.run_id !== `doctor-${skill}`
    || guard.repository_root !== await realpath(root)
    || guard.status !== expectedGuardStatus
  ) {
    throw new Error(
      `Deep Doctor ${skill} initial phase did not leave one canonical ${expectedGuardStatus} run`,
    );
  }
}

export async function runSkillTurn({
  root,
  skill,
  prompt,
  collaborationMode = null,
  timeoutMs,
  codexHome = null,
  installedPluginRoot,
  workerExecutable,
  runtimeFactory = createIsolatedAppServerRuntime,
  clientFactory = (options) => new AppServerClient(options),
}) {
  const deadline = createDoctorSessionDeadline(timeoutMs, `${skill} troubleshoot session`);
  let runtime = null;
  let runtimePromise = null;
  let client = null;
  let stagedRuntimeExecutable = null;
  let runtimePromptDirectory = null;
  let runtimePromptFile = null;
  let runtimePromptSha256 = null;
  let initialCanaryPrompt = null;
  let runtimeHostGate = null;
  const output = [];
  let stderr = '';
  const approvals = [];
  const commands = [];
  const goalUpdates = [];
  const reconnectHistory = [];
  const turns = createDoctorTurnController();
  const completedTurns = [];
  let threadId = null;
  let lastTurnId = null;
  let terminalSessionError = null;
  const fatal = deferred();
  void fatal.promise.catch(() => {});
  const sessionRuntime = (prior = null) => {
    const activeTurnId = turns.current()?.id ?? null;
    const turnIds = [...new Set([
      ...completedTurns.map(({ id }) => id),
      ...(Array.isArray(prior?.turn_ids) ? prior.turn_ids : []),
      prior?.turn_id ?? null,
      activeTurnId,
      lastTurnId,
    ].filter(Boolean))];
    return Object.freeze({
      thread_id: threadId ?? prior?.thread_id ?? null,
      turn_id: activeTurnId ?? lastTurnId ?? prior?.turn_id ?? null,
      turn_ids: Object.freeze(turnIds),
    });
  };
  const sessionFailure = (error) => {
    const runtimeSnapshot = sessionRuntime(error?.runtime);
    const failure = error instanceof WorkerSessionError
      ? error
      : new WorkerSessionError(error?.message ?? error, {
          cause: error instanceof Error ? error : undefined,
          runtime: runtimeSnapshot,
          reconnectHistory,
        });
    // WorkerSessionError's public runtime intentionally has a minimal worker
    // shape. Deep Doctor extends its own failure evidence with the sequential
    // turn lineage needed to audit a multi-turn canary.
    failure.runtime = runtimeSnapshot;
    return failure;
  };
  const onNotification = (message) => {
    const params = message.params ?? {};
    if (threadId && params.threadId && params.threadId !== threadId) return;
    if (message.method === 'turn/started') turns.started(params.turn?.id);
    if (message.method === 'item/agentMessage/delta') output.push(params.delta ?? '');
    if (message.method === 'item/completed' && params.item?.type === 'commandExecution') {
      const turnContext = turns.current();
      const command = String(params.item.command ?? '');
      let hostExecutionBinding = null;
      let hostExecutionBindingError = null;
      try {
        hostExecutionBinding = runtimeHostGate?.bindCompletion(message) ?? null;
      } catch (error) {
        hostExecutionBindingError = error;
      }
      let completionEvidence = null;
      let completionEvidenceError = null;
      try {
        completionEvidence = captureDoctorWorkerCompletionEvidence({
          root,
          command,
          workerExecutable,
          skill,
        });
      } catch (error) {
        completionEvidenceError = sanitizeWorkerDiagnosticText(error?.message ?? error).slice(0, 2_048);
      }
      commands.push(Object.freeze({
        command,
        status: params.item.status ?? null,
        exitCode: params.item.exitCode ?? null,
        output: completedCommandOutput(params.item),
        phase: turnContext?.label ?? null,
        turnId: params.turnId ?? turnContext?.id ?? null,
        completionEvidence,
        ...(hostExecutionBinding ? { hostExecutionBinding } : {}),
        ...(completionEvidenceError ? { completionEvidenceError } : {}),
      }));
      if (hostExecutionBindingError) {
        terminalSessionError = sessionFailure(hostExecutionBindingError);
        turns.reject(terminalSessionError, params.turnId ?? null);
        fatal.reject(terminalSessionError);
      }
    }
    if (message.method === 'thread/goal/updated') {
      const turnContext = turns.current();
      goalUpdates.push(Object.freeze({
        id: params.goal?.id ?? null,
        status: params.goal?.status ?? null,
        phase: turnContext?.label ?? null,
        turnId: params.turnId ?? turnContext?.id ?? null,
      }));
    }
    if (message.method === 'error') {
      const event = workerReconnectEvent(params, reconnectHistory.length + 1);
      reconnectHistory.push(event);
      if (params.willRetry !== true) {
        const failure = sessionFailure(new Error(event.message));
        const eventTurnId = params.turnId ?? params.turn?.id ?? null;
        turns.reject(failure, eventTurnId);
        terminalSessionError = failure;
        fatal.reject(failure);
      }
    }
    if (message.method === 'turn/completed') {
      turns.resolve(params.turn);
    }
  };
  const onStderr = (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-8 * 1024);
  };
  const safeStderr = () => sanitizeWorkerDiagnosticText(stderr).slice(-8 * 1024);
  const onExit = (info = {}) => {
    terminalSessionError = sessionFailure(
      info.error ?? new Error('app-server exited before deep Doctor turn completed'),
    );
    fatal.reject(terminalSessionError);
    turns.reject(terminalSessionError);
  };
  try {
    runtimePromise = Promise.resolve().then(() => runtimeFactory({
      codexHome,
      extensionProfile: 'doctor-discovery',
      runtimeRoot: join(root, '.cruise', 'app-run'),
    }));
    runtime = await deadline.run('isolated runtime setup', () => runtimePromise);
    client = clientFactory({
      args: ['app-server', '--stdio', ...(runtime.appServerArgs ?? [])],
      spawnOptions: { cwd: root, ...runtime.spawnOptions },
      clientInfo: { name: 'cruise-doctor-deep', title: 'Cruise Doctor Deep', version: '0.1.0' },
      onServerRequest(message) {
        if (terminalSessionError) throw terminalSessionError;
        return answerDoctorServerRequest(message, {
          approvals,
          skill,
          workerExecutable,
          runtimeHostGate,
          context: () => ({
            phase: turns.current()?.label ?? null,
            turn_id: turns.current()?.id ?? null,
          }),
        });
      },
      onError(error, clientInstance) {
        terminalSessionError = sessionFailure(error);
        fatal.reject(terminalSessionError);
        turns.reject(terminalSessionError);
        void clientInstance.stop().catch(() => {});
      },
    });
    client.on('notification', onNotification);
    client.on('stderr', onStderr);
    client.on('exit', onExit);
    const signals = [fatal.promise];
    const stagedPluginRoot = await deadline.run(
      'installed plugin staging',
      () => stageInstalledPlugin(runtime.codexHome, installedPluginRoot),
      { signals },
    );
    stagedRuntimeExecutable = await deadline.run(
      'installed runtime verification',
      () => verifiedInstalledRuntimePath(stagedPluginRoot),
      { signals },
    );
    runtimePromptDirectory = await deadline.run(
      'host runtime prompt staging',
      () => createDoctorTemp('cruise-prompt'),
      { signals },
    );
    runtimePromptDirectory = await realpath(runtimePromptDirectory);
    runtimePromptFile = join(runtimePromptDirectory, `${skill}.txt`);
    initialCanaryPrompt = createDoctorCanaryPrompt({
      skill,
      prompt,
      phase: 'capture',
      workerExecutable,
      runtimeExecutable: stagedRuntimeExecutable,
      repositoryRoot: root,
      nodeExecutable: realpathSync(process.execPath),
      runtimePromptFile,
    });
    await deadline.run(
      'host runtime prompt write',
      () => writeFile(runtimePromptFile, initialCanaryPrompt, { flag: 'wx', mode: 0o400 }),
      { signals },
    );
    runtimePromptSha256 = createHash('sha256').update(initialCanaryPrompt).digest('hex');
    await deadline.run('app-server start', () => client.start(), { signals });
    const modelCatalog = await deadline.run(
      'model/list',
      () => client.request('model/list', { limit: 100 }),
      { signals },
    );
    const rootModel = selectDoctorRootModel(modelCatalog);
    const skills = await deadline.run(
      'installed skills/list',
      () => discoverInstalledCruiseSkills(client, {
        root,
        pluginRoot: stagedPluginRoot,
      }),
      { signals },
    );
    const descriptor = skills[skill];
    const repositorySkillDescriptor = await deadline.run(
      'repository skills/list',
      () => discoverRepositorySpatiomicsSkill(client, { root }),
      { signals },
    );
    const thread = await deadline.run('thread/start', () => client.request('thread/start', {
      cwd: root,
      runtimeWorkspaceRoots: [],
      approvalPolicy: 'on-request',
      model: rootModel.model,
      allowProviderModelFallback: false,
      serviceName: 'cruise_doctor_deep',
      ephemeral: true,
    }), { signals });
    threadId = thread.thread.id;
    runtimeHostGate = createDoctorRuntimeHostGate({
      expectedRuntimePath: stagedRuntimeExecutable,
      repositoryRoot: root,
      skill,
      promptFile: runtimePromptFile,
      promptSha256: runtimePromptSha256,
      context: () => ({
        threadId,
        turnId: turns.current()?.id ?? null,
        phase: turns.current()?.label ?? null,
      }),
    });
    const startTurn = async ({ phase, mode = null }) => {
      if (terminalSessionError) throw terminalSessionError;
      const handle = turns.begin(phase);
      // A transport failure can reject the active turn before turn/start returns.
      // Mark that promise handled immediately; the awaited original still rejects below.
      handle.promise.catch(() => {});
      try {
        const turn = await deadline.run(`${phase} turn/start`, () => client.request('turn/start', {
          threadId,
          input: [
            { type: 'skill', name: descriptor.name, path: descriptor.path },
            {
              type: 'skill',
              name: repositorySkillDescriptor.name,
              path: repositorySkillDescriptor.path,
            },
            {
              type: 'text',
              text: phase === 'capture'
                ? initialCanaryPrompt
                : createDoctorCanaryPrompt({
                    skill,
                    prompt,
                    phase,
                    workerExecutable,
                    runtimeExecutable: stagedRuntimeExecutable,
                    repositoryRoot: root,
                    nodeExecutable: realpathSync(process.execPath),
                    runtimePromptFile,
                  }),
              text_elements: [],
            },
          ],
          cwd: root,
          runtimeWorkspaceRoots: [],
          model: rootModel.model,
          effort: rootModel.reasoningEffort,
          sandboxPolicy: {
            type: 'workspaceWrite',
            writableRoots: [root],
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          },
          approvalPolicy: 'on-request',
          responsesapiClientMetadata: {
            cruise_doctor_skill: skill,
            cruise_doctor_phase: phase,
          },
          ...(mode === null ? {} : {
            collaborationMode: {
              mode,
              settings: {
                model: rootModel.model,
                reasoning_effort: rootModel.reasoningEffort,
                developer_instructions: null,
              },
            },
          }),
        }), { signals });
        turns.bind(handle, turn.turn.id);
        lastTurnId = turn.turn.id;
        const completed = await deadline.run(
          `${phase} turn completion`,
          () => handle.promise,
          { signals },
        );
        await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
        if (terminalSessionError) throw terminalSessionError;
        runtimeHostGate.assertNoPending();
        completedTurns.push(Object.freeze({ id: completed.id, phase, status: completed.status }));
        return completed;
      } finally {
        turns.release(handle);
      }
    };
    const assertContinuationReady = (expectedGuardStatus = 'monitoring') => assertDoctorPhaseContinuationReady({
      root,
      skill,
      runtimeExecutable: stagedRuntimeExecutable,
      promptFile: runtimePromptFile,
      promptSha256: runtimePromptSha256,
      commands,
      runtimeHostGate,
      expectedGuardStatus,
    });

    await startTurn({ phase: 'capture', mode: 'default' });
    await assertContinuationReady();
    await deadline.run(
      'route input staging',
      () => stageDoctorRouteInputs({ root, skill, modelCatalog }),
      { signals },
    );

    if (skill === 'build') {
      await startTurn({ phase: 'draft', mode: 'default' });
      if (!hasNativeBuildApproval(approvals)) {
        await assertContinuationReady();
        await startTurn({ phase: 'approval', mode: 'plan' });
      }
      if (!hasNativeBuildApproval(approvals)) {
        throw new Error('Build canary produced no native exact structured Foundation/Milestone approval');
      }
      if (!await stagedCanaryIsComplete(root, skill)) {
        await assertContinuationReady();
        await startTurn({ phase: 'execute', mode: 'default' });
      }
    } else if (skill === 'refine') {
      await startTurn({ phase: 'draft', mode: 'default' });
      if (!hasNativeRefineApproval(approvals)) {
        await assertContinuationReady();
        await startTurn({ phase: 'plan-approval', mode: 'plan' });
      }
      if (!hasNativeRefineApproval(approvals)) {
        throw new Error('Refine canary produced no native exact structured Approve Plan selection');
      }
      if (!await stagedCanaryIsComplete(root, skill)) {
        await assertContinuationReady();
        await startTurn({ phase: 'execute', mode: 'default' });
      }
    } else if (skill === 'goal') {
      await startTurn({ phase: 'plan-draft', mode: 'default' });
      if (!hasNativeGoalApprovals(approvals)) {
        await assertContinuationReady();
        await startTurn({ phase: 'plan-approval', mode: 'default' });
      }
      if (!hasNativeGoalApprovals(approvals)) {
        throw new Error('Goal canary produced no exact structured combined Approve both selection');
      }
      if (!await stagedCanaryIsComplete(root, skill) || !hasNativeGoalControlUpdate(goalUpdates)) {
        await assertContinuationReady();
        await startTurn({ phase: 'execute', mode: 'default' });
      }
    } else {
      const executionMode = collaborationMode ?? 'default';
      await startTurn({ phase: 'single', mode: executionMode });
      while (!await stagedCanaryIsComplete(root, skill)) {
        await assertContinuationReady();
        const progressBefore = Object.freeze({
          commands: commands.length,
          approvals: approvals.length,
          goalUpdates: goalUpdates.length,
        });
        await startTurn({ phase: 'execute', mode: executionMode });
        if (
          commands.length === progressBefore.commands
          && approvals.length === progressBefore.approvals
          && goalUpdates.length === progressBefore.goalUpdates
        ) {
          throw new Error(`Deep Doctor ${skill} continuation made no observable progress`);
        }
      }
    }
    runtimeHostGate.assertNoPending();
    const completed = completedTurns.at(-1);
    return Object.freeze({
      status: completed.status,
      output: output.join(''),
      stderr: safeStderr(),
      approvals: Object.freeze(approvals),
      commands: Object.freeze(commands),
      goalUpdates: Object.freeze(goalUpdates),
      reconnectHistory: Object.freeze([...reconnectHistory]),
      skillDescriptor: descriptor,
      repositorySkillDescriptor,
      threadId,
      turnId: completed.id,
      turnIds: Object.freeze(completedTurns.map(({ id }) => id)),
      runtime: Object.freeze({
        thread_id: threadId,
        turn_id: completed.id,
        turn_ids: Object.freeze(completedTurns.map(({ id }) => id)),
      }),
    });
  } catch (error) {
    const failure = sessionFailure(error);
    failure.commands = Object.freeze([...commands]);
    failure.approvals = Object.freeze([...approvals]);
    failure.goalUpdates = Object.freeze([...goalUpdates]);
    failure.output = output.join('');
    failure.appServerStderr = safeStderr();
    throw failure;
  } finally {
    const cleanupTimeoutMs = timeoutMs === null ? 1_000 : Math.min(timeoutMs, 1_000);
    if (client) {
      client.removeListener('notification', onNotification);
      client.removeListener('stderr', onStderr);
      client.removeListener('exit', onExit);
    }
    if (!runtime && runtimePromise) {
      void runtimePromise.then(
        (lateRuntime) => waitForCleanup(() => lateRuntime.dispose(), cleanupTimeoutMs),
        () => undefined,
      ).catch(() => {});
    }
    if (client) {
      await waitForCleanup(
        () => client.stop({ timeoutMs: timeoutMs === null ? 500 : Math.min(timeoutMs, 500) }),
        cleanupTimeoutMs,
      );
    }
    if (runtime) await waitForCleanup(() => runtime.dispose(), cleanupTimeoutMs);
    if (runtimePromptDirectory) {
      await waitForCleanup(
        () => rm(runtimePromptDirectory, { recursive: true, force: true }),
        cleanupTimeoutMs,
      );
    }
  }
}

async function prepareCase(source, workspace, scenario) {
  const root = join(workspace, scenario.skill);
  await cp(source, root, { recursive: true, errorOnExist: true, force: false });
  await rm(join(root, '.git'), { recursive: true, force: true });
  if (scenario.prepare === 'failing-test') {
    await writeFile(
      join(root, 'tests', 'fail.test.mjs'),
      "import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('intentional Doctor symptom', () => assert.equal(1, 2));\n",
      'utf8',
    );
  }
  runGit(root, ['init', '--quiet']);
  runGit(root, ['add', '.']);
  runGit(root, [
    '-c', 'user.name=Cruise Doctor',
    '-c', 'user.email=doctor@example.invalid',
    'commit', '--quiet', '-m', 'doctor fixture baseline',
  ]);
  return root;
}

async function prepareDoctorEvidenceRoot(workspace) {
  const canonicalWorkspace = await realpath(workspace);
  const requested = join(canonicalWorkspace, '.doc-evidence');
  await mkdir(requested, { recursive: false, mode: 0o700 });
  const metadata = await lstat(requested);
  const evidenceRoot = await realpath(requested);
  if (
    metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || !isPathInside(canonicalWorkspace, evidenceRoot)
  ) {
    throw new Error('Doctor authoritative evidence root must be a private real workspace directory');
  }
  return evidenceRoot;
}

async function writeDoctorSessionLog(evidenceRoot, skill, content) {
  if (!DOCTOR_SKILL_CASES.some((scenario) => scenario.skill === skill)) {
    throw new Error(`Doctor evidence skill is invalid: ${skill}`);
  }
  const skillDirectory = join(evidenceRoot, skill);
  await mkdir(skillDirectory, { recursive: false, mode: 0o700 });
  const canonicalSkillDirectory = await realpath(skillDirectory);
  if (!isPathInside(evidenceRoot, canonicalSkillDirectory)) {
    throw new Error('Doctor evidence skill directory escaped its authoritative root');
  }
  const path = join(canonicalSkillDirectory, 'session.log');
  const bytes = Buffer.from(content, 'utf8');
  const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
  const handle = await open(path, 'wx+', 0o600);
  let identity;
  try {
    identity = await handle.stat();
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (bytesWritten === 0) throw new Error('Doctor evidence log write made no progress');
      offset += bytesWritten;
    }
    await handle.sync();
    const written = await handle.stat();
    if (written.size !== bytes.length) {
      throw new Error('Doctor evidence log length changed during persistence');
    }
    const observed = Buffer.alloc(bytes.length);
    offset = 0;
    while (offset < observed.length) {
      const { bytesRead } = await handle.read(observed, offset, observed.length - offset, offset);
      if (bytesRead === 0) throw new Error('Doctor evidence log read made no progress');
      offset += bytesRead;
    }
    if (!observed.equals(bytes)) {
      throw new Error('Doctor evidence log bytes changed during persistence');
    }
  } finally {
    await handle.close().catch(() => {});
  }
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.dev !== identity.dev
    || metadata.ino !== identity.ino
    || metadata.size !== bytes.length
  ) {
    throw new Error('Doctor evidence log path changed during inference');
  }
  return Object.freeze({ path, sha256: expectedSha256, size: bytes.length });
}

async function findCompletedWorkerReports(root) {
  const files = await walkFiles(join(root, '.cruise'));
  const reports = [];
  for (const relativePath of files.filter((path) => /\.ya?ml$/iu.test(path))) {
    let value;
    try {
      value = await readYamlFile(join(root, '.cruise', relativePath));
    } catch {
      continue;
    }
    if (
      value?.schema_version === 1
      && value?.kind === 'cruise_app_server_worker_report'
      && value?.runtime?.status === 'completed'
      && typeof value?.runtime?.thread_id === 'string'
      && value.runtime.thread_id.length > 0
      && typeof value?.runtime?.turn_id === 'string'
      && value.runtime.turn_id.length > 0
      && Number.isInteger(value?.launch?.recommended_level)
      && value.launch.recommended_level >= 1
      && value.launch.recommended_level <= 7
      && typeof value?.launch?.agent_type === 'string'
      && value.launch.agent_type.length > 0
      && typeof value?.launch?.resolved?.model === 'string'
      && value.launch.resolved.model.length > 0
      && typeof value?.launch?.resolved?.reasoning_effort === 'string'
      && value.launch.resolved.reasoning_effort.length > 0
      && /^[a-f0-9]{64}$/u.test(value?.launch?.packet_sha256)
      && value?.launch?.extension_policy?.profile === 'worker'
      && value.launch.extension_policy.plugins === 'inherited'
      && value.launch.extension_policy.apps === 'inherited'
      && value.launch.extension_policy.mcp_servers === 'inherited'
      && value.launch.extension_policy.native_guardrails === 'inherited'
      && Array.isArray(value.launch.extension_policy.disabled_mcp_servers)
      && typeof value?.model_output === 'string'
      && value.model_output.trim().length > 0
    ) {
      reports.push(Object.freeze({
        path: relativePath,
        level: value.launch.recommended_level,
        threadId: value.runtime.thread_id,
        turnId: value.runtime.turn_id,
        packetSha256: value.launch.packet_sha256,
        reportSha256: sha256Bytes(await readFile(join(root, '.cruise', relativePath))),
      }));
    }
  }
  return Object.freeze(reports);
}

export async function inspectDoctorWorkflowProof(root, skill) {
  const cruiseFiles = await walkFiles(join(root, '.cruise'));
  const statePaths = cruiseFiles.filter((path) => /^runs\/[^/]+\/state\.yaml$/u.test(path));
  if (statePaths.length !== 1) {
    throw new Error(`expected exactly one canonical Cruise run state; found ${statePaths.length}`);
  }
  const statePath = statePaths[0];
  const runDirectory = dirname(statePath);
  const runId = basename(runDirectory);
  const state = await readYamlFile(join(root, '.cruise', statePath));
  validateRunState(state);
  if (state.run_id !== runId) {
    throw new Error(`run-state ID ${state.run_id} does not match canonical directory ${runId}`);
  }
  if (state.selected_skill !== skill || state.current_route !== skill) {
    throw new Error(
      `run-state route ${state.selected_skill}/${state.current_route} does not match ${skill}`,
    );
  }
  if (state.status !== 'completed') {
    throw new Error(`authoritative Cruise run ${runId} ended ${state.status}`);
  }
  const evidencePath = join(runDirectory, 'evidence.yaml');
  if (!cruiseFiles.includes(evidencePath)) {
    throw new Error(`completed Cruise run ${runId} has no canonical evidence.yaml`);
  }
  const evidence = await readYamlFile(join(root, '.cruise', evidencePath));
  validateEvidenceRecord(evidence);
  if (evidence.run_id !== runId) {
    throw new Error(`evidence run ID ${evidence.run_id} does not match ${runId}`);
  }
  if (evidence.outcome !== 'completed') {
    throw new Error(`authoritative Cruise evidence for ${runId} ended ${evidence.outcome}`);
  }
  const requiredRunFiles = [
    'origin.yaml',
    'drift.yaml',
    'probe.yaml',
    'map-pkt.yaml',
    'map-facts.yaml',
    'route.yaml',
    'evidence.yaml',
  ];
  for (const name of requiredRunFiles) {
    if (!cruiseFiles.includes(join(runDirectory, name))) {
      throw new Error(`canonical Cruise run ${runId} is missing ${name}`);
    }
  }

  const origin = await readYamlFile(join(root, '.cruise', runDirectory, 'origin.yaml'));
  validateOriginRecord(origin);
  if (origin.origin.selected_skill !== skill || origin.routing.selected_route !== skill) {
    throw new Error(`Origin route does not match Doctor skill ${skill}`);
  }
  if (await realpath(origin.repository_baseline.root) !== await realpath(root)) {
    throw new Error('Origin repository baseline root does not match the Doctor case root');
  }
  const foreignDiffGuardPath = join(root, '.cruise', runDirectory, 'drift.yaml');
  const foreignDiffGuard = await readForeignDiffGuardState(foreignDiffGuardPath);
  const terminalGuardFinalized = foreignDiffGuard.status === 'stopped'
    && foreignDiffGuard.history.at(-1)?.action === 'guard_finalized'
    && foreignDiffGuard.history.at(-1)?.inventory_sha256
      === foreignDiffGuard.checkpoint?.inventory?.sha256;
  if (
    foreignDiffGuard.run_id !== runId
    || foreignDiffGuard.origin_prompt_sha256 !== origin.origin.prompt_sha256
    || foreignDiffGuard.repository_baseline_digest !== repositoryBaselineDigest(origin.repository_baseline)
    || (foreignDiffGuard.status !== 'monitoring' && !terminalGuardFinalized)
  ) {
    throw new Error('Doctor canary did not keep the non-destructive foreign-diff guard active');
  }
  const finalInventory = captureProductInventory(root, { limits: foreignDiffGuard.limits });
  if (finalInventory.sha256 !== foreignDiffGuard.checkpoint.inventory.sha256) {
    throw new Error('Doctor canary left product drift outside its accepted foreign-diff checkpoint');
  }
  const probe = await readYamlFile(join(root, '.cruise', runDirectory, 'probe.yaml'));
  const probeDigest = deterministicProbeDigest(probe);
  if (probeDigest !== origin.routing.deterministic_probe_digest) {
    throw new Error('canonical probe digest does not match immutable Origin');
  }
  assertRuntimeProbeReady(probe, {
    rawPrompt: origin.origin.raw_prompt,
    repositoryBaseline: origin.repository_baseline,
  });

  const semanticFactsPath = join(root, '.cruise', runDirectory, 'map-facts.yaml');
  const semanticFacts = await readYamlFile(semanticFactsPath);
  const expectedFacts = {
    schema_version: 1,
    prompt_sha256: origin.origin.prompt_sha256,
    repository_baseline_digest: repositoryBaselineDigest(origin.repository_baseline),
    assessed_quick_gates: [...QUICK_HARD_GATE_SIGNALS],
    facts: probe.semantic_facts,
  };
  if (canonicalJson(semanticFacts) !== canonicalJson(expectedFacts)) {
    throw new Error('map-facts.yaml does not match the accepted canonical probe enrichment');
  }

  const mappingPacketRelativePath = join(runDirectory, 'map-pkt.yaml');
  const mappingPacketPath = join(root, '.cruise', mappingPacketRelativePath);
  const mappingPacket = await readYamlFile(mappingPacketPath);
  assertSemanticMappingPacket(mappingPacket, {
    runDirectory: dirname(mappingPacketPath),
    repositoryRoot: origin.repository_baseline.root,
    promptSha256: origin.origin.prompt_sha256,
    repositoryBaselineDigest: repositoryBaselineDigest(origin.repository_baseline),
  });

  const route = await readYamlFile(join(root, '.cruise', runDirectory, 'route.yaml'));
  const attempts = Array.isArray(route?.attempts) ? route.attempts : [];
  if (attempts.length < 1 || attempts.length > 2) {
    throw new Error('route.yaml must contain exactly its one or two classifier attempts');
  }
  let classifierOutputs;
  try {
    classifierOutputs = attempts.map((attempt) => normalizeClassifierOutput(attempt?.output));
  } catch (cause) {
    throw new Error('route.yaml contains an invalid classifier output', { cause });
  }
  const expectedAttemptCount = classifierOutputs[0].confidence < ROUTE_CONFIDENCE_THRESHOLD
    ? 2
    : 1;
  if (
    attempts.length !== expectedAttemptCount
    || canonicalJson(route.initial_classifier) !== canonicalJson(attempts[0])
    || canonicalJson(route.retry_classifier ?? null)
      !== canonicalJson(attempts[1] ?? null)
  ) {
    throw new Error('route.yaml classifier attempt topology is not canonical');
  }
  const finalClassifier = classifierOutputs.at(-1);
  const uncertain = finalClassifier.confidence < ROUTE_CONFIDENCE_THRESHOLD;
  const proposedRoute = uncertain ? skill : finalClassifier.route;
  const admission = applyQuickPromotion({
    selectedSkill: skill,
    proposedRoute,
    probe,
    classifier: finalClassifier,
  });
  if (
    route?.schema_version !== 1
    || route.selected_skill !== skill
    || route.selected_route !== skill
    || route.selected_route !== admission.route
    || route.classifier_route !== finalClassifier.route
    || route.deterministic_probe_digest !== probeDigest
    || route.confidence !== origin.routing.confidence
    || route.confidence !== finalClassifier.confidence
    || route.recommended_level !== finalClassifier.recommended_level
    || route.ambiguity !== finalClassifier.ambiguity
    || route.semantic_risk !== finalClassifier.semantic_risk
    || route.uncertain !== uncertain
    || canonicalJson(route.promotion_reasons ?? [])
      !== canonicalJson(origin.routing.promotion_reasons)
    || canonicalJson(route.promotion_reasons ?? [])
      !== canonicalJson(admission.promotion_reasons)
    || classifierLabel(route.initial_classifier) !== origin.routing.initial_classifier
    || !Number.isInteger(route.recommended_level)
    || route.recommended_level < 2
    || route.recommended_level > 7
  ) {
    throw new Error('route.yaml does not match the canonical Origin, probe, and selected skill');
  }
  const workerReportRecords = (await findCompletedWorkerReports(root))
    .filter(({ path }) => path.startsWith(`${runDirectory}/`));
  const workerReports = workerReportRecords.map(({ path }) => path);
  if (workerReports.length === 0) {
    throw new Error(`completed Cruise run ${runId} has no in-run completed worker report`);
  }
  const packetDigests = {};
  for (const path of cruiseFiles.filter((candidate) => (
    candidate.startsWith(`${runDirectory}/`)
    && /(?:^|\/)[^/]*(?:pkt|packet)[^/]*\.(?:md|ya?ml)$/iu.test(candidate)
  ))) {
    const absolute = resolve(root, '.cruise', path);
    packetDigests[absolute] = createHash('sha256')
      .update(await readFile(absolute))
      .digest('hex');
  }
  const mappingPacketSha256 = packetDigests[resolve(mappingPacketPath)];
  if (!mappingPacketSha256) {
    throw new Error(`canonical Cruise run ${runId} has no digest-bound mapping packet`);
  }
  return Object.freeze({
    ok: true,
    runId,
    statePath,
    evidencePath,
    root,
    runDirectory,
    workerReports: Object.freeze(workerReports),
    workerReportRecords: Object.freeze(workerReportRecords),
    packetDigests: Object.freeze(packetDigests),
    mappingPacketPath: resolve(mappingPacketPath),
    mappingPacketSha256,
    semanticFactsPath: resolve(semanticFactsPath),
    semanticFactsSha256: sha256Bytes(await readFile(semanticFactsPath)),
    foreignDiffGuardPath: resolve(foreignDiffGuardPath),
    foreignDiffInventorySha256: finalInventory.sha256,
    routeRecommendedLevel: route.recommended_level,
  });
}

export function bindDoctorWorkerInvocations({
  root,
  commands,
  workflowProof,
  workerExecutable = 'cruise',
}) {
  if (!workflowProof?.ok || typeof root !== 'string') return Object.freeze([]);
  const canonicalRoot = doctorCanonicalRoot(root);
  if (canonicalRoot === null) return Object.freeze([]);
  const canonicalExistingPath = (path) => {
    try {
      return realpathSync(resolve(path));
    } catch {
      return resolve(path);
    }
  };
  const expectedReports = new Map(
    (workflowProof.workerReportRecords ?? []).map((record) => [
      canonicalExistingPath(resolve(root, '.cruise', record.path)),
      record,
    ]),
  );
  const packetDigests = new Map(
    Object.entries(workflowProof.packetDigests ?? {}).map(([path, digest]) => [
      canonicalExistingPath(path),
      digest,
    ]),
  );
  const bindings = [];
  for (const [commandIndex, command] of (commands ?? []).entries()) {
    if (command?.status !== 'completed' || command?.exitCode !== 0) continue;
    const invocation = parseCruiseWorkerInvocation(command.command, {
      expectedExecutable: workerExecutable,
    });
    if (!invocation || doctorCanonicalRoot(invocation.cwd) !== canonicalRoot) continue;
    let reportPath;
    let packetPath;
    try {
      reportPath = canonicalExistingPath(invocation.report);
      packetPath = canonicalExistingPath(invocation.packet);
    } catch {
      continue;
    }
    const report = expectedReports.get(reportPath);
    if (!report || report.level !== invocation.level) continue;
    const packetSha256 = packetDigests.get(packetPath) ?? null;
    if (
      !packetSha256
      || packetSha256 !== report.packetSha256
      || packetSha256 !== invocation.packetSha256
    ) continue;
    const completionEvidence = command.completionEvidence;
    if (
      completionEvidence?.packet_sha256 !== packetSha256
      || completionEvidence?.report_sha256 !== report.reportSha256
    ) continue;
    bindings.push(Object.freeze({
      commandIndex,
      command,
      invocation,
      report,
      packetPath,
      packetSha256,
    }));
  }
  return Object.freeze(bindings);
}

export async function inspectDoctorScenarioOutcome(root, skill) {
  if (skill === 'build') {
    const projectFiles = await walkFiles(join(root, '.cruise'));
    const required = [
      projectFiles.find((path) => path === 'project/PROJECT.md'),
      projectFiles.find((path) => /^milestones\/[^/]+\/MILESTONE\.md$/u.test(path)),
    ];
    if (required.some((path) => !path)) {
      throw new Error('Build did not produce both project and milestone planning contracts');
    }
    const content = required.map((path) => readDoctorCompletionArtifact(
      root,
      join(root, '.cruise', path),
      'Build scenario artifact',
    ).toString('utf8')).join('\n');
    for (const term of ['spatiomics-skill', 'inspect_spatial_inputs.py', 'digest']) {
      if (!content.toLowerCase().includes(term.toLowerCase())) {
        throw new Error(`Build planning contracts do not apply the repository skill (${term})`);
      }
    }
  } else if (skill === 'quick') {
    const content = readDoctorCompletionArtifact(
      root,
      join(root, 'doctor-ok.txt'),
      'Quick scenario artifact',
    ).toString('utf8');
    if (content !== 'Cruise Doctor quick probe passed.\n') {
      throw new Error('Quick did not produce the exact requested 34-byte canary');
    }
  } else if (skill === 'refine') {
    const content = readDoctorCompletionArtifact(
      root,
      join(root, 'docs', 'refine-ok.md'),
      'Refine scenario artifact',
    ).toString('utf8');
    for (const term of ['inspect_spatial_inputs.py', 'structural', 'semantic']) {
      if (!content.toLowerCase().includes(term.toLowerCase())) {
        throw new Error(`Refine documentation does not prove the requested boundary (${term})`);
      }
    }
  } else if (skill === 'goal') {
    const content = readDoctorCompletionArtifact(
      root,
      join(root, 'docs', 'DOCTOR-GOAL.md'),
      'Goal scenario artifact',
    ).toString('utf8');
    for (const term of ['inspect_spatial_inputs.py', 'fixture', 'provenance']) {
      if (!content.toLowerCase().includes(term.toLowerCase())) {
        throw new Error(`Goal runbook is missing its requested checkpoint (${term})`);
      }
    }
  } else if (skill === 'debug') {
    const repaired = readDoctorCompletionArtifact(
      root,
      join(root, 'tests', 'fail.test.mjs'),
      'Debug scenario artifact',
    ).toString('utf8');
    if (repaired !== DOCTOR_DEBUG_REPAIRED_TEST) {
      throw new Error('Debug did not leave the exact allowlisted one-byte fixture repair');
    }
  }
  return Object.freeze({
    ok: true,
    artifacts: snapshotDoctorScenarioArtifacts(root, skill),
  });
}

export function evaluateDoctorSkillResult({
  skill,
  result,
  workflowProof = null,
  scenarioOutcome = null,
  root = workflowProof?.root ?? null,
  workerExecutable = 'cruise',
  installedPluginRoot = null,
}) {
  const combined = [
    result.output ?? '',
    JSON.stringify(result.approvals ?? []),
    // Worker diagnostics are a model-to-root boundary and must never smuggle
    // user-facing transfer UX. Root coordinator commands are covered by the
    // exact runtime broker and unexpected-escalation checks; scanning their
    // read-only output would classify Cruise's own trusted contracts and
    // incident names as if a worker had emitted them.
    JSON.stringify((result.commands ?? []).map(({ command, output, completionEvidenceError }) => ({
      output: isCruiseWorkerCommand(command, { expectedExecutable: workerExecutable })
        ? String(output ?? '').slice(0, 8_224)
        : '',
      completionEvidenceError: String(completionEvidenceError ?? '').slice(0, 2_048),
    }))),
  ].join('\n');
  const forbidden = FORBIDDEN_WORKER_UX.find((pattern) => pattern.test(combined));
  if (forbidden) {
    return Object.freeze({
      id: `skill-e2e-${skill}`,
      status: 'fail',
      detail: `${skill} emitted forbidden worker-boundary UX (${forbidden}); incident requires Cruise Debug`,
    });
  }
  if (result.status !== 'completed') {
    return Object.freeze({ id: `skill-e2e-${skill}`, status: 'fail', detail: `${skill} turn ended ${result.status}` });
  }
  if ((result.approvals ?? []).some(({ unexpectedEscalation }) => unexpectedEscalation === true)) {
    return Object.freeze({
      id: `skill-e2e-${skill}`,
      status: 'fail',
      detail: `${skill} attempted an unexpected command, patch, or file-change escalation in the bounded Doctor fixture`,
    });
  }
  if ((result.approvals ?? []).some(({ unexpectedStructuredInput }) => unexpectedStructuredInput === true)) {
    return Object.freeze({
      id: `skill-e2e-${skill}`,
      status: 'fail',
      detail: `${skill} attempted unexpected native structured input in the bounded Doctor fixture`,
    });
  }
  if ((result.approvals ?? []).some(({ worker }) => worker === true)) {
    return Object.freeze({
      id: `skill-e2e-${skill}`,
      status: 'fail',
      detail: `${skill} required Doctor to broker worker host permission; the standing host path is not effective`,
    });
  }
  const runtimeAttempt = installedPluginRoot === null
    ? null
    : inspectFirstDoctorRuntimeAttempt(
        result.commands,
        resolve(installedPluginRoot, 'scripts', 'cruise-runtime.mjs'),
      );
  if (runtimeAttempt?.ok === false) {
    return Object.freeze({
      id: `skill-e2e-${skill}`,
      status: 'fail',
      detail: `${skill} did not use the exact installed runtime on its first attempt: ${runtimeAttempt.detail}`,
    });
  }
  if (installedPluginRoot !== null) {
    const hostApproval = (result.approvals ?? []).find((approval) => (
      approval?.doctorRuntimeHostPath === true
      && approval?.runtimeSubcommand === 'begin'
      && approval?.worker === false
    ));
    const completion = runtimeAttempt?.ok
      ? result.commands?.[runtimeAttempt.commandIndex]?.hostExecutionBinding
      : null;
    if (
      !hostApproval
      || typeof hostApproval.itemId !== 'string'
      || !/^[a-f0-9]{64}$/u.test(hostApproval.argvSha256 ?? '')
      || completion?.runtimeSubcommand !== 'begin'
      || completion?.itemId !== hostApproval.itemId
      || completion?.argvSha256 !== hostApproval.argvSha256
    ) {
      return Object.freeze({
        id: `skill-e2e-${skill}`,
        status: 'fail',
        detail: `${skill} did not bind installed runtime begin to one noninteractive exact-command host approval item`,
      });
    }
  }
  const failedWorkerAttempts = new Set();
  for (const command of result.commands ?? []) {
    const invocation = parseCruiseWorkerInvocation(command?.command, {
      expectedExecutable: workerExecutable,
    });
    if (!invocation) continue;
    const attemptKey = canonicalJson({
      cwd: doctorCanonicalRoot(invocation.cwd) ?? resolve(invocation.cwd),
      packet: (() => {
        try {
          return realpathSync(resolve(invocation.packet));
        } catch {
          return resolve(invocation.packet);
        }
      })(),
      packet_sha256: invocation.packetSha256,
    });
    if (command?.status !== 'completed' || command?.exitCode !== 0) {
      failedWorkerAttempts.add(attemptKey);
    } else if (failedWorkerAttempts.has(attemptKey)) {
      return Object.freeze({
        id: `skill-e2e-${skill}`,
        status: 'fail',
        detail: `${skill} replaced a failed Doctor-attested worker packet with a duplicate inference attempt`,
      });
    }
  }
  const workerBindings = bindDoctorWorkerInvocations({
    root,
    commands: result.commands,
    workflowProof,
    workerExecutable,
  });
  if (workerBindings.length === 0) {
    return Object.freeze({
      id: `skill-e2e-${skill}`,
      status: 'fail',
      detail: `${skill} did not complete an exact cruise worker invocation bound to its same-run report`,
    });
  }
  let canonicalMappingPacketPath = workflowProof?.mappingPacketPath ?? null;
  try {
    canonicalMappingPacketPath = realpathSync(resolve(canonicalMappingPacketPath));
  } catch {
    // The strict workflow proof below reports a missing or replaced mapping
    // packet. Keep the unresolved identity here so no binding can match it.
  }
  const mappingBindings = workerBindings.filter((binding) => (
    binding.invocation.level === 2
    && binding.packetPath === canonicalMappingPacketPath
    && binding.packetSha256 === workflowProof?.mappingPacketSha256
    && binding.command.completionEvidence?.semantic_facts_sha256
      === workflowProof?.semanticFactsSha256
  ));
  if (mappingBindings.length === 0) {
    return Object.freeze({
      id: `skill-e2e-${skill}`,
      status: 'fail',
      detail: `${skill} did not run command-time-bound facts and the exact runtime-generated level-2 semantic mapping packet`,
    });
  }
  if (
    runtimeAttempt !== null
    && runtimeAttempt.commandIndex >= Math.min(...mappingBindings.map(({ commandIndex }) => commandIndex))
  ) {
    return Object.freeze({
      id: `skill-e2e-${skill}`,
      status: 'fail',
      detail: `${skill} recorded its exact installed runtime begin only after the first mapping worker attempt`,
    });
  }
  const substantiveBindings = workerBindings.filter((binding) => (
    binding.packetPath !== canonicalMappingPacketPath
    && binding.packetSha256 !== workflowProof.mappingPacketSha256
    && binding.invocation.level === workflowProof.routeRecommendedLevel
    && mappingBindings.some((mapping) => mapping.commandIndex < binding.commandIndex)
    && canonicalJson(binding.command.completionEvidence?.scenario_artifacts ?? null)
      === canonicalJson(scenarioOutcome?.artifacts ?? null)
  ));
  if (substantiveBindings.length === 0) {
    return Object.freeze({
      id: `skill-e2e-${skill}`,
      status: 'fail',
      detail: `${skill} did not complete a distinct routed level-${workflowProof.routeRecommendedLevel} worker invocation after mapping whose command-time artifacts match the final canary outcome`,
    });
  }
  if (!workflowProof?.ok) {
    return Object.freeze({
      id: `skill-e2e-${skill}`,
      status: 'fail',
      detail: `${skill} has no strict completed workflow proof: ${workflowProof?.detail ?? 'proof missing'}`,
    });
  }
  if (!scenarioOutcome?.ok) {
    return Object.freeze({
      id: `skill-e2e-${skill}`,
      status: 'fail',
      detail: `${skill} did not satisfy its concrete canary outcome: ${scenarioOutcome?.detail ?? 'proof missing'}`,
    });
  }
  if (skill === 'build') {
    if (!hasNativeBuildApproval(result.approvals)) {
      return Object.freeze({
        id: `skill-e2e-${skill}`,
        status: 'fail',
        detail: 'build produced no native exact structured Build approval',
      });
    }
  }
  if (skill === 'refine' && !hasNativeRefineApproval(result.approvals)) {
    return Object.freeze({
      id: `skill-e2e-${skill}`,
      status: 'fail',
      detail: 'refine produced no native exact structured Approve Plan selection',
    });
  }
  if (skill === 'goal') {
    if (!hasNativeGoalApprovals(result.approvals)) {
      return Object.freeze({
        id: `skill-e2e-${skill}`,
        status: 'fail',
        detail: 'goal did not produce one combined Plan-and-Goal Approve both selection',
      });
    }
    if (!hasNativeGoalControlUpdate(result.goalUpdates)) {
      return Object.freeze({
        id: `skill-e2e-${skill}`,
        status: 'fail',
        detail: 'goal produced no native Goal control-plane update',
      });
    }
  }
  return Object.freeze({
    id: `skill-e2e-${skill}`,
    status: 'pass',
    detail: `${skill} loaded from the installed cache and completed ${workflowProof.workerReports.length} in-run worker inference report(s) through the host path`,
  });
}

export async function runTroubleshootDoctor({
  fixture = null,
  codexHome = null,
  installedPluginRoot = null,
  workerExecutable = null,
  onProgress = () => {},
  runSkill = runSkillTurn,
} = {}) {
  if (!installedPluginRoot) throw new TypeError('troubleshoot requires the verified installed plugin root');
  if (typeof workerExecutable !== 'string' || !isAbsolute(workerExecutable)) {
    throw new TypeError('troubleshoot requires the Doctor-attested worker executable');
  }
  const verifiedInstalledPluginRoot = await regularDirectory(
    resolve(installedPluginRoot),
    'Installed Cruise plugin',
  );
  const workspace = await createDoctorTemp('cruise-doctor');
  const evidenceRoot = await prepareDoctorEvidenceRoot(workspace);
  const installedPluginSnapshot = await copyInstalledPluginSurface(
    verifiedInstalledPluginRoot,
    join(workspace, '.plugin-snap', 'cruise'),
  );
  await verifiedInstalledRuntimePath(installedPluginSnapshot);
  const installedPluginSnapshotDigest = await digestPluginRuntime(installedPluginSnapshot);
  const fixtureSource = fixture ?? join(
    verifiedInstalledPluginRoot,
    'fixtures',
    'doctor',
    'repository',
  );
  const validated = await validateDoctorFixture(
    fixture ?? join(installedPluginSnapshot, 'fixtures', 'doctor', 'repository'),
  );
  const skillChecks = [];
  const sessionLogs = {};
  for (const scenario of DOCTOR_SKILL_CASES) {
    onProgress(`troubleshoot: ${scenario.skill}`);
    const root = await prepareCase(validated.root, workspace, scenario);
    let result;
    try {
      result = await runSkill({
        root,
        skill: scenario.skill,
        prompt: scenario.prompt,
        collaborationMode: scenario.collaborationMode ?? null,
        timeoutMs: null,
        codexHome,
        installedPluginRoot: installedPluginSnapshot,
        workerExecutable,
      });
    } catch (error) {
      result = {
        status: 'failed',
        output: error?.output ?? '',
        stderr: [error.message, error?.appServerStderr].filter(Boolean).join('\n'),
        approvals: error?.approvals ?? [],
        commands: error?.commands ?? [],
        goalUpdates: error?.goalUpdates ?? [],
        reconnectHistory: error?.reconnectHistory ?? [],
        runtime: error?.runtime ?? null,
      };
    }
    sessionLogs[scenario.skill] = await writeDoctorSessionLog(
      evidenceRoot,
      scenario.skill,
      [
        `skill: ${scenario.skill}`,
        `status: ${result.status}`,
        '',
        'stdout:',
        result.output ?? '',
        '',
        'stderr:',
        result.stderr ?? '',
        '',
        'interactions:',
        JSON.stringify(result.approvals ?? []),
        '',
        'commands:',
        JSON.stringify(result.commands ?? []),
        '',
        'goal_updates:',
        JSON.stringify(result.goalUpdates ?? []),
        '',
        'reconnect_history:',
        JSON.stringify(result.reconnectHistory ?? []),
        '',
        'runtime:',
        JSON.stringify(result.runtime ?? null),
        '',
      ].join('\n'),
    );
    let workflowProof;
    try {
      workflowProof = await inspectDoctorWorkflowProof(root, scenario.skill);
    } catch (error) {
      workflowProof = { ok: false, detail: error.message };
    }
    let scenarioOutcome;
    try {
      scenarioOutcome = await inspectDoctorScenarioOutcome(root, scenario.skill);
    } catch (error) {
      scenarioOutcome = { ok: false, detail: error.message };
    }
    let skillCheck = evaluateDoctorSkillResult({
      skill: scenario.skill,
      result,
      workflowProof,
      scenarioOutcome,
      workerExecutable,
      installedPluginRoot: installedPluginSnapshot,
    });
    if (skillCheck.status === 'pass') {
      try {
        const finalized = await finalizeForeignDiffGuard({
          statePath: workflowProof.foreignDiffGuardPath,
          expectedInventorySha256: workflowProof.foreignDiffInventorySha256,
        });
        if (!['finalized', 'already_finalized'].includes(finalized.outcome)) {
          throw new Error(`unexpected finalization outcome ${finalized.outcome}`);
        }
        skillCheck = Object.freeze({
          ...skillCheck,
          detail: `${skillCheck.detail}; terminal foreign-diff guard finalized and raw preimages released`,
        });
      } catch (error) {
        skillCheck = Object.freeze({
          id: `skill-e2e-${scenario.skill}`,
          status: 'fail',
          detail: `${scenario.skill} completed but terminal foreign-diff finalization failed: ${error.message}`,
        });
      }
    }
    skillChecks.push(skillCheck);
  }
  const canaryPassed = skillChecks.every(({ status }) => status === 'pass');
  const checks = [
    ...skillChecks,
    Object.freeze({
      id: 'installed-skill-inference-canary',
      status: canaryPassed ? 'pass' : 'fail',
      detail: canaryPassed
        ? 'all five installed public skills completed real worker inference through the standing host path'
        : 'at least one installed public skill failed its real worker inference or host-path proof',
    }),
  ];
  return Object.freeze({
    ok: canaryPassed,
    fixture: fixtureSource,
    workspace,
    evidenceRoot,
    sessionLogs: Object.freeze({ ...sessionLogs }),
    installedPluginRoot: verifiedInstalledPluginRoot,
    installedPluginSnapshot,
    installedPluginSnapshotDigest,
    checks: Object.freeze(checks),
  });
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function selectDoctorSmokeModel(catalog) {
  const selected = normalizeModelCatalog(catalog).find((entry) => (
    !entry.hidden
    && (entry.id === MODEL_IDS.luna || entry.model === MODEL_IDS.luna)
    && entry.supportedReasoningEfforts.includes('medium')
  ));
  if (!selected) {
    throw new Error('Deep Doctor requires the advertised Luna Medium model for rapid smoke turns');
  }
  return Object.freeze({ model: selected.id, reasoningEffort: 'medium' });
}

export function createDeepDoctorSmokePrompt(scenario) {
  const keys = Object.keys(scenario.expected);
  return [
    'This is a read-only Cruise Doctor smoke probe of the currently attached installed skill.',
    'Do not start the workflow, inspect the repository, run a command, call a tool, ask a question, or change any state.',
    scenario.question,
    `Return exactly one JSON object with these keys in this order: ${keys.join(', ')}.`,
    'Infer the values only from the attached skill contract. Use JSON strings, booleans, and arrays; emit no Markdown or explanation.',
  ].join('\n');
}

/** App-server request metadata is a string map, not arbitrary JSON. */
export function deepSmokeClientMetadata({ skill, sequence } = {}) {
  if (typeof skill !== 'string' || skill.length === 0) {
    throw new TypeError('Deep Doctor smoke metadata requires a skill name.');
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new TypeError('Deep Doctor smoke metadata requires a positive sequence number.');
  }
  return Object.freeze({
    cruise_doctor_profile: 'deep-smoke',
    cruise_doctor_skill: skill,
    cruise_doctor_sequence: String(sequence),
  });
}

/**
 * A Deep Doctor probe validates an attached skill's static contract. It must
 * never become a real Cruise run: native plan mode keeps the workspace
 * read-only and makes the no-tools/no-questions constraint part of the
 * app-server turn configuration rather than merely a request in user text.
 */
export function deepSmokeCollaborationMode({ model, reasoningEffort } = {}) {
  if (typeof model !== 'string' || model.length === 0) {
    throw new TypeError('Deep Doctor smoke collaboration mode requires a model.');
  }
  if (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0) {
    throw new TypeError('Deep Doctor smoke collaboration mode requires a reasoning effort.');
  }
  return Object.freeze({
    mode: 'plan',
    settings: Object.freeze({
      model,
      reasoning_effort: reasoningEffort,
      developer_instructions: [
        'This is an isolated, read-only Cruise Doctor compatibility probe.',
        'Do not initiate a Cruise workflow, inspect the workspace, use a tool, change state, or ask a question.',
        'Answer only the attached skill contract question, in exactly the format requested by the user message.',
      ].join('\n'),
    }),
  });
}

export function parseDeepDoctorSmokeResponse(value) {
  const text = String(value ?? '').trim();
  const fenced = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u);
  const candidate = (fenced?.[1] ?? text).trim();
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (cause) {
    throw new Error('Deep Doctor smoke response was not one JSON object', { cause });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Deep Doctor smoke response must be one JSON object');
  }
  return parsed;
}

export function deepSmokeResponseMatches(actual, expected) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return false;
  const normalized = { ...actual };
  if (
    expected.skill === 'cruise:build'
    && expected.auto_approval_directive === '--auto-approve'
    && actual.auto_approval_directive === '$cruise:build --auto-approve'
  ) {
    normalized.auto_approval_directive = '--auto-approve';
  }
  return canonicalJson(normalized) === canonicalJson(expected);
}

export function runInstalledSkillSmokeTests({
  installedPluginRoot,
  scenario,
  timeoutMs,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('installed skill smoke timeoutMs must be a positive safe integer');
  }
  const root = realpathSync(resolve(installedPluginRoot));
  const files = scenario.files.map((path) => {
    const candidate = realpathSync(join(root, path));
    if (!isPathInside(root, candidate)) {
      throw new Error(`Deep Doctor smoke test escaped the installed cache: ${path}`);
    }
    return candidate;
  });
  const pattern = `^(?:${scenario.tests.map(escapeRegularExpression).join('|')})$`;
  const startedAt = Date.now();
  const testEnvironment = { ...process.env, NO_COLOR: '1' };
  delete testEnvironment.NODE_TEST_CONTEXT;
  const execution = spawnSync(process.execPath, [
    '--test',
    '--test-reporter=tap',
    `--test-name-pattern=${pattern}`,
    ...files,
  ], {
    cwd: root,
    env: testEnvironment,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const durationMs = Date.now() - startedAt;
  const output = `${execution.stdout ?? ''}${execution.stderr ?? ''}`.slice(-64 * 1024);
  if (execution.error) {
    const timedOut = execution.error.code === 'ETIMEDOUT';
    throw new Error(
      timedOut
        ? `${scenario.skill} installed smoke tests exceeded ${timeoutMs}ms`
        : `${scenario.skill} installed smoke tests could not run: ${execution.error.message}`,
    );
  }
  if (execution.status !== 0) {
    throw new Error(`${scenario.skill} installed smoke tests failed (${execution.status}): ${output}`);
  }
  const missing = scenario.tests.filter((name) => {
    const escaped = escapeRegularExpression(name);
    return !new RegExp(`^# Subtest: ${escaped}$`, 'mu').test(output)
      || !new RegExp(`^ok \\d+ - ${escaped}$`, 'mu').test(output);
  });
  if (missing.length > 0) {
    throw new Error(
      `${scenario.skill} installed smoke selection did not execute: ${missing.join('; ')}`,
    );
  }
  return Object.freeze({
    ok: true,
    duration_ms: durationMs,
    tests: scenario.tests,
    files: scenario.files,
    output,
  });
}

function deepSmokeServerDenial(message) {
  switch (message.method) {
    case 'item/tool/requestUserInput': {
      const answers = {};
      for (const question of message.params?.questions ?? []) {
        if (typeof question?.id === 'string') {
          answers[question.id] = { answers: ['Save and stop'] };
        }
      }
      return { answers };
    }
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'decline' };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: 'denied' };
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn' };
    case 'mcpServer/elicitation/request':
      return { action: 'decline', content: null, _meta: null };
    default:
      throw new Error(`Deep Doctor smoke rejected unexpected server request ${message.method}`);
  }
}

export async function runDeepSmokeConversation({
  root,
  installedPluginRoot,
  codexHome = null,
  timeoutMs = DEEP_DOCTOR_SKILL_TIMEOUT_MS,
  scenarios = DEEP_DOCTOR_SMOKE_CASES,
  runtimeFactory = createIsolatedAppServerRuntime,
  clientFactory = (options) => new AppServerClient(options),
  runSmokeTests = runInstalledSkillSmokeTests,
  onProgress = () => {},
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('Deep Doctor per-skill timeout must be a positive safe integer');
  }
  const repositoryRoot = await regularDirectory(resolve(root), 'Deep Doctor smoke workspace');
  const pinnedPluginRoot = await regularDirectory(
    resolve(installedPluginRoot),
    'Deep Doctor pinned installed plugin',
  );
  const setupDeadline = createDeadline(timeoutMs, 'Deep Doctor shared conversation setup');
  const turns = createDoctorTurnController();
  const fatal = deferred();
  void fatal.promise.catch(() => {});
  const interactions = [];
  let activeOutput = [];
  let client = null;
  let runtime = null;
  let threadId = null;
  const onNotification = (message) => {
    const params = message.params ?? {};
    if (threadId && params.threadId && params.threadId !== threadId) return;
    if (message.method === 'turn/started') turns.started(params.turn?.id);
    if (message.method === 'item/agentMessage/delta') activeOutput.push(params.delta ?? '');
    if (message.method === 'item/completed' && ['commandExecution', 'fileChange'].includes(params.item?.type)) {
      interactions.push(Object.freeze({ method: message.method, item: params.item?.type }));
    }
    if (message.method === 'error' && params.willRetry !== true) {
      const error = new Error(sanitizeWorkerDiagnosticText(params.message ?? 'Deep Doctor app-server error'));
      turns.reject(error, params.turnId ?? null);
      fatal.reject(error);
    }
    if (message.method === 'turn/completed') turns.resolve(params.turn);
  };
  const onExit = (info = {}) => {
    const error = info.error ?? new Error('app-server exited during Deep Doctor shared conversation');
    turns.reject(error);
    fatal.reject(error);
  };
  try {
    runtime = await setupDeadline.run(
      'isolated runtime setup',
      () => runtimeFactory({
        codexHome,
        extensionProfile: 'doctor-discovery',
        runtimeRoot: join(repositoryRoot, '.cruise', 'app-run'),
      }),
    );
    client = clientFactory({
      args: ['app-server', '--stdio', ...(runtime.appServerArgs ?? [])],
      spawnOptions: { cwd: repositoryRoot, ...runtime.spawnOptions },
      clientInfo: { name: 'cruise-doctor-deep', title: 'Cruise Doctor Deep', version: '0.1.0' },
      onServerRequest(message) {
        interactions.push(Object.freeze({ method: message.method }));
        return deepSmokeServerDenial(message);
      },
      onError(error) {
        turns.reject(error);
        fatal.reject(error);
      },
    });
    client.on('notification', onNotification);
    client.on('exit', onExit);
    const stagedPluginRoot = await setupDeadline.run(
      'installed plugin staging',
      () => stageInstalledPlugin(runtime.codexHome, pinnedPluginRoot),
      { signals: [fatal.promise] },
    );
    await setupDeadline.run('app-server start', () => client.start(), { signals: [fatal.promise] });
    const catalog = await setupDeadline.run(
      'model/list',
      () => client.request('model/list', { limit: 100 }),
      { signals: [fatal.promise] },
    );
    const selected = selectDoctorSmokeModel(catalog);
    const skills = await setupDeadline.run(
      'installed skills/list',
      () => discoverInstalledCruiseSkills(client, { root: repositoryRoot, pluginRoot: stagedPluginRoot }),
      { signals: [fatal.promise] },
    );
    const thread = await setupDeadline.run('thread/start', () => client.request('thread/start', {
      cwd: repositoryRoot,
      runtimeWorkspaceRoots: [],
      approvalPolicy: 'on-request',
      model: selected.model,
      allowProviderModelFallback: false,
      serviceName: 'cruise_doctor_deep',
      ephemeral: true,
    }), { signals: [fatal.promise] });
    threadId = thread.thread.id;
    const smokeCollaborationMode = deepSmokeCollaborationMode(selected);
    await setupDeadline.run('thread/settings/update', () => client.request('thread/settings/update', {
      threadId,
      cwd: repositoryRoot,
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'readOnly' },
      collaborationMode: smokeCollaborationMode,
    }), { signals: [fatal.promise] });

    const results = [];
    let conversationUsable = true;
    for (const [index, scenario] of scenarios.entries()) {
      onProgress(`deep Doctor: ${scenario.skill}`);
      if (!conversationUsable) {
        results.push(Object.freeze({
          skill: scenario.skill,
          ok: false,
          duration_ms: 0,
          detail: 'shared Deep Doctor conversation became unavailable in an earlier skill turn',
        }));
        continue;
      }
      const deadline = createDeadline(timeoutMs, `${scenario.skill} Deep Doctor smoke`);
      const startedAt = Date.now();
      const interactionStart = interactions.length;
      activeOutput = [];
      const handle = turns.begin(`smoke-${scenario.skill}`);
      handle.promise.catch(() => {});
      try {
        const turn = await deadline.run('turn/start', () => client.request('turn/start', {
          threadId,
          input: [
            { type: 'skill', name: skills[scenario.skill].name, path: skills[scenario.skill].path },
            { type: 'text', text: createDeepDoctorSmokePrompt(scenario), text_elements: [] },
          ],
          cwd: repositoryRoot,
          runtimeWorkspaceRoots: [],
          model: selected.model,
          effort: selected.reasoningEffort,
          sandboxPolicy: { type: 'readOnly' },
          approvalPolicy: 'on-request',
          collaborationMode: smokeCollaborationMode,
          responsesapiClientMetadata: deepSmokeClientMetadata({
            skill: scenario.skill,
            sequence: index + 1,
          }),
        }), { signals: [fatal.promise] });
        turns.bind(handle, turn.turn.id);
        const completed = await deadline.run(
          'turn completion',
          () => handle.promise,
          { signals: [fatal.promise] },
        );
        await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
        const output = activeOutput.join('').trim();
        const skillInteractions = interactions.slice(interactionStart);
        const parsed = parseDeepDoctorSmokeResponse(output);
        const semanticMatch = deepSmokeResponseMatches(parsed, scenario.expected);
        const testTimeout = Math.max(1, Math.floor(deadline.remaining()));
        const testResult = runSmokeTests({
          installedPluginRoot: pinnedPluginRoot,
          scenario,
          timeoutMs: testTimeout,
        });
        const durationMs = Date.now() - startedAt;
        const ok = completed.status === 'completed'
          && skillInteractions.length === 0
          && semanticMatch
          && testResult.ok === true;
        results.push(Object.freeze({
          skill: scenario.skill,
          ok,
          duration_ms: durationMs,
          target_ms: DEEP_DOCTOR_TARGET_MS,
          target_met: durationMs < DEEP_DOCTOR_TARGET_MS,
          semantic_response: parsed,
          expected_response: scenario.expected,
          interactions: Object.freeze(skillInteractions),
          tests: testResult,
          detail: ok
            ? `shared-thread semantic contract and ${scenario.tests.length} installed test(s) passed`
            : [
                completed.status !== 'completed' ? `turn ended ${completed.status}` : null,
                skillInteractions.length > 0 ? 'turn attempted a tool, command, question, or state change' : null,
                !semanticMatch ? 'semantic contract response differed from the installed skill' : null,
                testResult.ok !== true ? 'installed deterministic tests failed' : null,
              ].filter(Boolean).join('; '),
        }));
      } catch (error) {
        conversationUsable = false;
        results.push(Object.freeze({
          skill: scenario.skill,
          ok: false,
          duration_ms: Date.now() - startedAt,
          target_ms: DEEP_DOCTOR_TARGET_MS,
          target_met: false,
          detail: error.message,
        }));
      } finally {
        turns.release(handle);
      }
    }
    return Object.freeze({
      thread_id: threadId,
      model: selected.model,
      reasoning_effort: selected.reasoningEffort,
      results: Object.freeze(results),
    });
  } finally {
    if (client) {
      client.removeListener('notification', onNotification);
      client.removeListener('exit', onExit);
      await waitForCleanup(() => client.stop({ timeoutMs: 500 }), 1_000);
    }
    if (runtime) await waitForCleanup(() => runtime.dispose(), 1_000);
  }
}

export async function runDeepDoctor({
  codexHome = null,
  installedPluginRoot = null,
  timeoutMs = DEEP_DOCTOR_SKILL_TIMEOUT_MS,
  onProgress = () => {},
  runConversation = runDeepSmokeConversation,
} = {}) {
  if (!installedPluginRoot) throw new TypeError('Deep Doctor requires the verified installed plugin root');
  if (timeoutMs !== DEEP_DOCTOR_SKILL_TIMEOUT_MS) {
    throw new TypeError(`Deep Doctor uses a fixed ${DEEP_DOCTOR_SKILL_TIMEOUT_MS}ms per-skill timeout`);
  }
  const verifiedInstalledPluginRoot = await regularDirectory(
    resolve(installedPluginRoot),
    'Installed Cruise plugin',
  );
  const workspace = await createDoctorTemp('cruise-doctor');
  const evidenceRoot = await prepareDoctorEvidenceRoot(workspace);
  const installedPluginSnapshot = await copyInstalledPluginSurface(
    verifiedInstalledPluginRoot,
    join(workspace, '.plugin-snap', 'cruise'),
  );
  const installedPluginSnapshotDigest = await digestPluginRuntime(installedPluginSnapshot);
  let conversation;
  try {
    conversation = await runConversation({
      root: workspace,
      installedPluginRoot: installedPluginSnapshot,
      codexHome,
      timeoutMs,
      scenarios: DEEP_DOCTOR_SMOKE_CASES,
      onProgress,
    });
  } catch (error) {
    conversation = Object.freeze({
      thread_id: null,
      model: null,
      reasoning_effort: null,
      results: Object.freeze(DEEP_DOCTOR_SMOKE_CASES.map((scenario) => Object.freeze({
        skill: scenario.skill,
        ok: false,
        duration_ms: 0,
        target_ms: DEEP_DOCTOR_TARGET_MS,
        target_met: false,
        detail: `shared Deep Doctor conversation failed: ${error.message}`,
      }))),
    });
  }
  const checks = [];
  const sessionLogs = {};
  for (const scenario of DEEP_DOCTOR_SMOKE_CASES) {
    const result = conversation.results.find(({ skill }) => skill === scenario.skill) ?? {
      skill: scenario.skill,
      ok: false,
      duration_ms: 0,
      detail: 'shared Deep Doctor conversation returned no result',
    };
    sessionLogs[scenario.skill] = await writeDoctorSessionLog(
      evidenceRoot,
      scenario.skill,
      `${JSON.stringify(result, null, 2)}\n`,
    );
    checks.push(Object.freeze({
      id: `skill-smoke-${scenario.skill}`,
      status: result.ok ? 'pass' : 'fail',
      detail: result.ok
        ? `${result.detail} in ${result.duration_ms}ms on shared thread ${conversation.thread_id}${result.target_met ? '' : `; passed but exceeded the <${DEEP_DOCTOR_TARGET_MS}ms target`}`
        : `${scenario.skill} smoke failed: ${result.detail}`,
    }));
  }
  const canaryPassed = checks.every(({ status }) => status === 'pass');
  checks.push(Object.freeze({
    id: 'installed-skill-smoke-canary',
    status: canaryPassed ? 'pass' : 'fail',
    detail: canaryPassed
      ? `all five installed public skills passed in one warm Luna Medium conversation with ${DEEP_DOCTOR_SKILL_TIMEOUT_MS}ms per skill`
      : 'at least one installed public skill failed the shared-conversation semantic or deterministic smoke probe',
  }));
  return Object.freeze({
    ok: canaryPassed,
    fixture: null,
    workspace,
    evidenceRoot,
    sessionLogs: Object.freeze({ ...sessionLogs }),
    installedPluginRoot: verifiedInstalledPluginRoot,
    installedPluginSnapshot,
    installedPluginSnapshotDigest,
    conversation,
    checks: Object.freeze(checks),
  });
}
