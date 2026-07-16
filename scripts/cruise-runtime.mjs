#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  allocateRunName,
  REPOSITORY_ARTIFACTS,
  RUN_ARTIFACTS,
} from './lib/artifact-naming.mjs';
import {
  captureRepositoryBaseline,
  createOriginRecord,
  validateOriginRecord,
} from './lib/origin.mjs';
import { createEvidenceRecord } from './lib/evidence.mjs';
import { isForeignDiffControlName } from './lib/foreign-diff-control.mjs';
import {
  beginCruiseAction,
  checkForForeignDiff,
  completeCruiseAction,
  createForeignDiffGuard,
  finalizeForeignDiffGuard,
  foreignDiffAuthorityPath,
  projectCruiseAction,
  readForeignDiffGuardState,
  resolveForeignDiffIncident,
} from './lib/foreign-diff-guard.mjs';
import { withHostAuthorityLock } from './lib/host-authority-lock.mjs';
import {
  modelRequestOptions,
  resolveModelPolicy,
} from './lib/model-policy.mjs';
import {
  assertRuntimeProbeReady,
  classifierLabel,
  classifyRoute,
  deterministicProbeDigest,
  enrichDeterministicProbe,
  probeRepository,
  PUBLIC_ROUTES,
  repositoryBaselineDigest,
} from './lib/routing.mjs';
import { createSemanticMappingPacket } from './lib/semantic-mapping-packet.mjs';
import {
  createRunState,
  transitionRunState,
  validateRunState,
} from './lib/run-state.mjs';
import {
  assertFinalTraceability,
  validateTraceability,
} from './lib/traceability.mjs';
import {
  canonicalJson,
  parseYaml,
  readYamlFile,
  writeYamlFile,
} from './lib/yaml-state.mjs';
import { runWorkerSession } from './lib/worker-session.mjs';

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const BOOLEAN_OPTIONS = new Set(['stdin', 'final']);

const COMMAND_OPTIONS = Object.freeze({
  begin: new Set(['skill', 'root', 'stdin', 'prompt-file']),
  'enrich-probe': new Set(['run-dir', 'facts']),
  route: new Set([
    'skill',
    'run-dir',
    'classifier',
    'retry-classifier',
    'catalog-json',
  ]),
  'validate-origin': new Set(['file', 'expected-origin']),
  'validate-trace': new Set(['file', 'final', 'origin', 'origin-mappings']),
  'resolve-model': new Set([
    'stage',
    'catalog-json',
    'output',
    'tier',
    'reasoning',
    'attempt-number',
    'escalation-reason',
  ]),
  'foreign-diff-project': new Set(['run-dir', 'intent', 'output']),
  'foreign-diff-open': new Set(['run-dir', 'action']),
  'foreign-diff-close': new Set(['run-dir', 'receipt']),
  'foreign-diff-check': new Set(['run-dir']),
  'foreign-diff-resolve': new Set(['run-dir', 'resolution']),
  'foreign-diff-finalize': new Set(['run-dir', 'expected-inventory-sha256']),
});

const HELP = `Cruise internal runtime

Usage:
  cruise-runtime begin --skill <skill> --root <repo> (--stdin | --prompt-file <file>)
  cruise-runtime enrich-probe --run-dir <dir> --facts <yaml>
  cruise-runtime route --skill <skill> --run-dir <dir> --classifier <yaml> [--retry-classifier <yaml>] [--catalog-json <json>]
  cruise-runtime validate-origin --file <yaml> [--expected-origin <yaml>]
  cruise-runtime validate-trace --file <yaml> [--final --origin <yaml> --origin-mappings <yaml>]
  cruise-runtime resolve-model --stage <stage> --catalog-json <json> --output <yaml> [--tier <tier>] [--reasoning <effort>]
  cruise-runtime foreign-diff-project --run-dir <dir> --intent <yaml> --output <yaml>
  cruise-runtime foreign-diff-open --run-dir <dir> --action <yaml>
  cruise-runtime foreign-diff-close --run-dir <dir> --receipt <yaml>
  cruise-runtime foreign-diff-check --run-dir <dir>
  cruise-runtime foreign-diff-resolve --run-dir <dir> --resolution <yaml>
  cruise-runtime foreign-diff-finalize --run-dir <dir> --expected-inventory-sha256 <sha256>

Raw prompts are accepted only from stdin or a regular prompt file. This CLI is
an internal skill runtime and is intentionally not registered in cruise --help.
Every begin activates non-destructive foreign-diff monitoring and must be
followed by an evidence-bound enrich-probe assessment before route. Routing
fails closed if either guard is absent or stale.
`;

function fail(message) {
  const error = new Error(message);
  error.code = 'CRUISE_RUNTIME_USAGE';
  throw error;
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== 'string' || value.length === 0) fail(`--${key} is required`);
  return value;
}

export function parseRuntimeArgs(argv) {
  const args = [...argv];
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return { command: 'help', options: {} };
  }
  const command = args.shift();
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) fail(`unknown internal runtime command: ${command}`);
  const options = {};
  while (args.length > 0) {
    const token = args.shift();
    if (!token.startsWith('--') || token === '--') {
      fail('positional arguments are forbidden; raw prompts must use stdin or --prompt-file');
    }
    const equals = token.indexOf('=');
    const key = token.slice(2, equals < 0 ? undefined : equals);
    if (!allowed.has(key)) fail(`unknown option for ${command}: --${key}`);
    if (Object.hasOwn(options, key)) fail(`option may be provided only once: --${key}`);
    if (BOOLEAN_OPTIONS.has(key)) {
      if (equals >= 0) fail(`--${key} does not take a value`);
      options[key] = true;
      continue;
    }
    const value = equals >= 0 ? token.slice(equals + 1) : args.shift();
    if (value == null || value.startsWith('--')) fail(`--${key} requires a value`);
    options[key] = value;
  }
  return { command, options };
}

async function regularFile(path, label, { maxBytes = MAX_INPUT_BYTES } = {}) {
  const absolute = resolve(path);
  let metadata;
  try {
    metadata = await lstat(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`${label} does not exist: ${absolute}`);
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    fail(`${label} must be a regular file, not a symlink or special path`);
  }
  if (metadata.size > maxBytes) fail(`${label} exceeds ${maxBytes} bytes`);
  return absolute;
}

async function realDirectory(path, label) {
  const absolute = resolve(path);
  const metadata = await lstat(absolute).catch((error) => {
    if (error?.code === 'ENOENT') fail(`${label} does not exist: ${absolute}`);
    throw error;
  });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`${label} must be a real directory`);
  }
  return realpath(absolute);
}

function decodeExactUtf8(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error(`${label} must contain valid UTF-8 text`, { cause });
  }
}

async function readStdinBytes() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_INPUT_BYTES) fail(`stdin prompt exceeds ${MAX_INPUT_BYTES} bytes`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

async function readRawPrompt(options) {
  const fromStdin = options.stdin === true;
  const promptFile = options['prompt-file'];
  if (fromStdin === Boolean(promptFile)) {
    fail('begin requires exactly one of --stdin or --prompt-file');
  }
  if (fromStdin) {
    const bytes = await readStdinBytes();
    return decodeExactUtf8(bytes, 'stdin prompt');
  }
  const path = await regularFile(promptFile, 'prompt file');
  return decodeExactUtf8(await readFile(path), 'prompt file');
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function ensureRepositoryNaming(root, naming) {
  const controlRoot = join(root, '.cruise');
  await mkdir(controlRoot, { recursive: true, mode: 0o700 });
  const path = join(controlRoot, REPOSITORY_ARTIFACTS.naming);
  const record = {
    schema_version: 1,
    kind: 'cruise_repository_name',
    name: naming.repository_name,
    repository_root: root,
    assigned_by: naming.agent_type,
    worker_level: naming.level,
    model: naming.model,
    reasoning_effort: naming.reasoning_effort,
  };
  if (await pathExists(path)) {
    const existing = await readYamlFile(await regularFile(path, 'repository name YAML'));
    if (
      existing?.schema_version !== 1
      || existing?.kind !== 'cruise_repository_name'
      || existing?.name !== naming.repository_name
      || existing?.repository_root !== root
      || existing?.assigned_by !== 'cruise_l1'
      || existing?.worker_level !== 1
    ) {
      fail('level-1 repository name differs from the immutable repo.yaml authority');
    }
    return existing;
  }
  await writeYamlFile(path, record);
  return record;
}

async function stageRunDirectory(requestedPath, write) {
  const absolute = resolve(requestedPath);
  const name = basename(absolute);
  if (!name || name === '.' || name === '..') fail('run name must identify a new directory');
  await mkdir(dirname(absolute), { recursive: true });
  const parent = await realDirectory(dirname(absolute), 'run-directory parent');
  const target = join(parent, name);
  if (await pathExists(target)) fail(`run directory already exists: ${target}`);
  const staging = join(parent, '.run-stage');
  if (await pathExists(staging)) fail(`run staging directory already exists: ${staging}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    await write(staging, target);
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return target;
}

async function withRunLock(runDirectory, name, callback) {
  const path = join(runDirectory, `${name}.lock`);
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') fail(`${name} is already running for ${runDirectory}`);
    throw error;
  }
  try {
    return await callback();
  } finally {
    await handle.close().catch(() => {});
    await unlink(path).catch(() => {});
  }
}

async function withForeignDiffGuardLock(runDirectory, callback) {
  // Read the mirrored/authoritative pair once to locate the host-owned lock,
  // then every callback revalidates the pair while that lock is held. A
  // workspace writer can corrupt the mirror and force a fail-closed result,
  // but cannot redirect or remove this lock from inside the worker sandbox.
  const guard = await readForeignDiffGuardState(join(runDirectory, 'drift.yaml'));
  const lockPath = join(
    dirname(foreignDiffAuthorityPath(guard.repository_root, guard.run_id)),
    'drift.lock',
  );
  return withHostAuthorityLock({
    lockPath,
    resource: 'foreign-diff-guard',
    scope: {
      repository_root: guard.repository_root,
      run_id: guard.run_id,
    },
  }, callback);
}

async function withForeignDiffGuardedControlWrite(runDirectory, name, callback) {
  return withRunLock(
    runDirectory,
    name,
    () => withForeignDiffGuardLock(runDirectory, callback),
  );
}

function assertSkill(value) {
  if (!PUBLIC_ROUTES.includes(value)) fail(`--skill must be one of ${PUBLIC_ROUTES.join(', ')}`);
  return value;
}

const GUARD_INITIALIZATION_DRIFT_CODE = 'repository_changed_during_guard_initialization';

function recaptureRepositoryBaseline(baseline) {
  return captureRepositoryBaseline(baseline.root, {
    instructionFiles: baseline.instruction_files,
  });
}

function sameRepositoryBaseline(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function guardInitializationDriftBlock() {
  return {
    code: GUARD_INITIALIZATION_DRIFT_CODE,
    message: 'repository changed while begin initialized the foreign-diff guard; bytes were left untouched; ask whether the change was intentional, then start a fresh Cruise run whose immutable Origin captures the accepted repository',
  };
}

async function beginCommand(options, output, {
  afterForeignDiffGuardInitialized = null,
  invokeNameWorker = runWorkerSession,
} = {}) {
  const selectedSkill = assertSkill(required(options, 'skill'));
  const root = await realDirectory(required(options, 'root'), 'repository root');
  const rawPrompt = await readRawPrompt(options);
  const naming = await allocateRunName({
    root,
    prompt: rawPrompt,
    skill: selectedSkill,
    invokeWorker: invokeNameWorker,
  });
  await ensureRepositoryNaming(root, naming);
  const runPath = join(root, '.cruise', 'runs', naming.name);
  const runId = basename(resolve(runPath));
  const capturedAt = new Date().toISOString();
  const baseline = captureRepositoryBaseline(root);
  const probe = probeRepository({ repositoryRoot: root });
  const probeDigest = deterministicProbeDigest(probe);
  const origin = createOriginRecord({
    rawPrompt,
    selectedSkill,
    repositoryBaseline: baseline,
    deterministicProbeDigest: probeDigest,
    initialClassifier: 'pending classification',
    selectedRoute: selectedSkill,
    confidence: 0,
    capturedAt,
  });
  let state = createRunState({ runId, selectedSkill, now: capturedAt });
  if (baseline.capture_status === 'blocked') {
    state = transitionRunState(state, {
      status: 'blocked',
      reason: `repository_baseline_blocked:${baseline.block.code}`,
      now: capturedAt,
    });
  }
  const evidence = createEvidenceRecord({
    runId,
    recordedAt: capturedAt,
    items: [],
  });
  const baselineDigest = repositoryBaselineDigest(origin.repository_baseline);
  let initializationBlock = baseline.capture_status === 'blocked'
    ? {
        code: `repository_baseline_blocked:${baseline.block.code}`,
        message: 'repository baseline capture is blocked',
      }
    : null;
  let guardStatus = initializationBlock === null ? 'monitoring' : 'blocked';
  const runDirectory = await stageRunDirectory(runPath, async (staging, target) => {
    await writeYamlFile(join(staging, RUN_ARTIFACTS.naming), {
      schema_version: 1,
      kind: 'cruise_run_name',
      name: runId,
      repository_name: naming.repository_name,
      purpose: selectedSkill,
      assigned_by: naming.agent_type,
      worker_level: naming.level,
      model: naming.model,
      reasoning_effort: naming.reasoning_effort,
      prompt_sha256: origin.origin.prompt_sha256,
    });
    await writeYamlFile(join(staging, RUN_ARTIFACTS.probe), probe);
    await writeYamlFile(join(staging, RUN_ARTIFACTS.evidence), evidence);
    if (initializationBlock === null) {
      const immediatelyBeforeGuard = recaptureRepositoryBaseline(origin.repository_baseline);
      if (!sameRepositoryBaseline(immediatelyBeforeGuard, origin.repository_baseline)) {
        initializationBlock = guardInitializationDriftBlock();
      }
    }
    await createForeignDiffGuard({
      statePath: join(staging, RUN_ARTIFACTS.drift),
      runId,
      repositoryRoot: root,
      originPromptSha256: origin.origin.prompt_sha256,
      repositoryBaselineDigest: baselineDigest,
      blockedReason: initializationBlock,
      now: capturedAt,
    });
    if (initializationBlock === null) {
      if (afterForeignDiffGuardInitialized !== null) {
        if (typeof afterForeignDiffGuardInitialized !== 'function') {
          throw new TypeError('afterForeignDiffGuardInitialized must be a function');
        }
        await afterForeignDiffGuardInitialized({ repositoryRoot: root, stagingRunDirectory: staging });
      }
      const immediatelyAfterGuard = recaptureRepositoryBaseline(origin.repository_baseline);
      if (!sameRepositoryBaseline(immediatelyAfterGuard, origin.repository_baseline)) {
        initializationBlock = guardInitializationDriftBlock();
        await createForeignDiffGuard({
          statePath: join(staging, RUN_ARTIFACTS.drift),
          runId,
          repositoryRoot: root,
          originPromptSha256: origin.origin.prompt_sha256,
          repositoryBaselineDigest: baselineDigest,
          blockedReason: initializationBlock,
          now: capturedAt,
        });
      }
    }
    const initializedGuard = await readForeignDiffGuardState(join(staging, RUN_ARTIFACTS.drift));
    guardStatus = initializedGuard.status;
    if (guardStatus === 'blocked' && initializationBlock === null) {
      initializationBlock = initializedGuard.block ?? {
        code: 'foreign_diff_guard_initialization_blocked',
        message: 'foreign-diff guard initialization is blocked',
      };
    }
    if (initializationBlock !== null && state.status === 'routing_pending') {
      state = transitionRunState(state, {
        status: 'blocked',
        reason: `begin_blocked:${initializationBlock.code}`,
        now: new Date(),
      });
    }
    await writeYamlFile(join(staging, RUN_ARTIFACTS.state), state);
    if (state.status === 'routing_pending') {
      await writeYamlFile(join(staging, RUN_ARTIFACTS.mapPacket), createSemanticMappingPacket({
        runDirectory: target,
        repositoryRoot: root,
        promptSha256: origin.origin.prompt_sha256,
        repositoryBaselineDigest: baselineDigest,
      }));
    }
    // origin.yaml is the commit marker for a successfully staged begin.
    await writeYamlFile(join(staging, RUN_ARTIFACTS.origin), origin);
  });
  output.write(`created ${runDirectory}\nrepository baseline ${baselineDigest}\nforeign-diff monitoring ${guardStatus === 'monitoring' ? 'active' : 'blocked'}\n`);
  if (initializationBlock?.code === GUARD_INITIALIZATION_DRIFT_CODE) {
    output.write(`${initializationBlock.message}\n`);
  }
  return {
    runDirectory,
    repositoryBaselineDigest: baselineDigest,
    origin,
    probe,
    state,
    evidence,
  };
}

async function readJsonBoundary(path, label) {
  const absolute = await regularFile(path, label);
  const source = await readFile(absolute, 'utf8');
  try {
    return JSON.parse(source);
  } catch (cause) {
    throw new Error(`${label} must contain app-server boundary JSON`, { cause });
  }
}

function hasAcceptedPreservedIncident(guard) {
  return guard?.incidents?.some(({ resolution }) => (
    resolution?.selection === 'preserve_and_continue'
    && resolution?.outcome === 'preserved'
  )) === true;
}

async function assertBaselineStillMatches(origin, { foreignDiffGuard = null } = {}) {
  if (origin.repository_baseline.capture_status === 'blocked') {
    throw new Error(`repository baseline is blocked: ${origin.repository_baseline.block.code}`);
  }
  const current = captureRepositoryBaseline(origin.repository_baseline.root, {
    instructionFiles: origin.repository_baseline.instruction_files,
  });
  if (current.capture_status === 'blocked') {
    throw new Error(`repository baseline recapture is blocked: ${current.block.code}`);
  }
  if (canonicalJson(current) !== canonicalJson(origin.repository_baseline)) {
    if (hasAcceptedPreservedIncident(foreignDiffGuard)) {
      throw new Error(
        'intentional foreign-diff bytes were preserved without Cruise authorship, but this pre-route run cannot continue because its immutable Origin baseline is now stale; leave those bytes untouched and start a fresh Cruise run with a fresh Origin before enrichment, routing, or substantive work',
      );
    }
    throw new Error(
      'repository baseline changed after begin; leave current bytes untouched and start a fresh Cruise run with a fresh immutable Origin before enrichment, routing, or substantive work',
    );
  }
}

function assertExactObject(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain exactly: ${expected.join(', ')}`);
  }
}

async function directRunYaml(runDirectory, requestedPath, label) {
  const bytes = await directRunBytes(runDirectory, requestedPath, label, MAX_INPUT_BYTES);
  return parseYaml(decodeExactUtf8(bytes, label), { maxBytes: MAX_INPUT_BYTES });
}

async function directRunBytes(runDirectory, requestedPath, label, maxBytes) {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    fail(`${label} must name a direct file in --run-dir`);
  }
  const path = await realpath(await regularFile(requestedPath, label, { maxBytes }));
  if (dirname(path) !== runDirectory) fail(`${label} must be a direct file in --run-dir`);
  const before = await lstat(path);
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.mode !== before.mode
      || opened.size !== before.size
      || opened.size > maxBytes
    ) {
      fail(`${label} changed while it was opened`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.mode !== opened.mode
      || after.size !== opened.size
      || bytes.length !== opened.size
    ) {
      fail(`${label} changed while it was read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function directRunNewOutput(runDirectory, requestedPath, label) {
  const requested = resolve(requestedPath);
  const name = basename(requested);
  const parent = await realDirectory(dirname(requested), `${label} parent`);
  if (parent !== runDirectory || name === '' || name === '.' || name === '..') {
    fail(`${label} must be a direct new file in --run-dir`);
  }
  const path = join(parent, name);
  if (await pathExists(path)) fail(`${label} already exists: ${path}`);
  return path;
}

function requireForeignDiffControlName(requestedPath, label) {
  const name = basename(resolve(requestedPath));
  if (!isForeignDiffControlName(name)) {
    fail(`${label} must use a direct drift-* control filename of at most 15 characters`);
  }
  return name;
}

async function assertForeignDiffBinding(runDirectory, state = null) {
  const guard = state ?? await readForeignDiffGuardState(join(runDirectory, 'drift.yaml'));
  const origin = await readYamlFile(await regularFile(join(runDirectory, 'origin.yaml'), 'origin YAML'));
  validateOriginRecord(origin);
  if (
    guard.run_id !== basename(runDirectory)
    || guard.repository_root !== origin.repository_baseline.root
    || guard.origin_prompt_sha256 !== origin.origin.prompt_sha256
    || guard.repository_baseline_digest !== repositoryBaselineDigest(origin.repository_baseline)
  ) {
    throw new Error('foreign-diff guard is not bound to the immutable run Origin and repository baseline');
  }
  return { guard, origin };
}

function throwForeignDiffPause(result) {
  if (result.outcome !== 'waiting_user') return result;
  const error = new Error(
    `foreign diff ${result.incident.incident_id} detected; all workers and writes must pause while the root asks whether the listed changes were intentional`,
  );
  error.code = 'CRUISE_FOREIGN_DIFF_WAITING_USER';
  throw error;
}

async function assertForeignDiffReady(runDirectory) {
  const { guard } = await assertForeignDiffBinding(runDirectory);
  if (guard.status !== 'monitoring') {
    throw new Error(`foreign-diff guard is ${guard.status}; workers, routing, and writes remain paused`);
  }
  return throwForeignDiffPause(await checkForForeignDiff({
    statePath: join(runDirectory, 'drift.yaml'),
  }));
}

async function foreignDiffProjectCommand(options, output) {
  const runDirectory = await realDirectory(required(options, 'run-dir'), 'run directory');
  return withForeignDiffGuardLock(runDirectory, async () => {
    const { guard } = await assertForeignDiffBinding(runDirectory);
    const intentPath = required(options, 'intent');
    requireForeignDiffControlName(intentPath, 'foreign-diff projection intent YAML');
    const intent = await directRunYaml(runDirectory, intentPath, 'foreign-diff projection intent YAML');
    assertExactObject(
      intent,
      ['schema_version', 'kind', 'action_id', 'changes'],
      'foreign-diff projection intent',
    );
    if (intent.schema_version !== 1 || intent.kind !== 'cruise_change_projection_intent') {
      fail('foreign-diff projection intent kind or schema is invalid');
    }
    if (!Array.isArray(intent.changes)) fail('foreign-diff projection intent changes must be an array');
    const changes = [];
    const contentPaths = new Set();
    for (const [index, change] of intent.changes.entries()) {
      assertExactObject(
        change,
        ['path', 'kind', 'mode', 'content_file'],
        `foreign-diff projection intent changes[${index}]`,
      );
      let bytes = null;
      if (change.kind === 'missing') {
        if (change.mode !== null || change.content_file !== null) {
          fail(`foreign-diff missing projection changes[${index}] must use null mode and content_file`);
        }
      } else {
        if (typeof change.content_file !== 'string' || change.content_file.length === 0) {
          fail(`foreign-diff projection changes[${index}] requires content_file`);
        }
        requireForeignDiffControlName(
          change.content_file,
          `foreign-diff projection content ${index}`,
        );
        const absoluteContent = await realpath(await regularFile(
          change.content_file,
          `foreign-diff projection content ${index}`,
          { maxBytes: guard.limits.file_max_bytes },
        ));
        if (dirname(absoluteContent) !== runDirectory) {
          fail(`foreign-diff projection content ${index} must be a direct file in --run-dir`);
        }
        contentPaths.add(absoluteContent);
        bytes = await directRunBytes(
          runDirectory,
          absoluteContent,
          `foreign-diff projection content ${index}`,
          guard.limits.file_max_bytes,
        );
      }
      changes.push({ path: change.path, kind: change.kind, mode: change.mode, bytes });
    }
    const requestedOutputPath = required(options, 'output');
    requireForeignDiffControlName(requestedOutputPath, 'foreign-diff projection output');
    const outputPath = await directRunNewOutput(
      runDirectory,
      requestedOutputPath,
      'foreign-diff projection output',
    );
    const canonicalIntentPath = await realpath(await regularFile(intentPath, 'foreign-diff projection intent YAML'));
    if (outputPath === canonicalIntentPath || contentPaths.has(outputPath)) {
      fail('foreign-diff projection output must not replace its intent or content files');
    }
    const action = await projectCruiseAction({
      statePath: join(runDirectory, 'drift.yaml'),
      actionId: intent.action_id,
      changes,
    });
    await writeYamlFile(outputPath, action);
    output.write(`foreign-diff action ${action.action_id} projected\n`);
    return action;
  });
}

async function foreignDiffOpenCommand(options, output) {
  const runDirectory = await realDirectory(required(options, 'run-dir'), 'run directory');
  const actionPath = required(options, 'action');
  requireForeignDiffControlName(actionPath, 'foreign-diff action YAML');
  const action = await directRunYaml(runDirectory, actionPath, 'foreign-diff action YAML');
  assertExactObject(
    action,
    ['schema_version', 'kind', 'action_id', 'owned_paths', 'expected_changes'],
    'foreign-diff action',
  );
  if (action.schema_version !== 1 || action.kind !== 'cruise_change_action') fail('foreign-diff action kind or schema is invalid');
  if (!Array.isArray(action.expected_changes)) fail('foreign-diff expected_changes must be an array');
  for (const [index, change] of action.expected_changes.entries()) {
    assertExactObject(
      change,
      ['path', 'before_sha256', 'after_kind', 'after_mode', 'after_size', 'after_sha256', 'after_inventory_sha256'],
      `foreign-diff action expected_changes[${index}]`,
    );
  }
  return withForeignDiffGuardLock(runDirectory, async () => {
    await assertForeignDiffBinding(runDirectory);
    const result = await beginCruiseAction({
      statePath: join(runDirectory, 'drift.yaml'),
      actionId: action.action_id,
      ownedPaths: action.owned_paths,
      expectedChanges: action.expected_changes,
    });
    throwForeignDiffPause(result);
    output.write(`foreign-diff action ${action.action_id} open\n`);
    return result;
  });
}

async function foreignDiffCloseCommand(options, output) {
  const runDirectory = await realDirectory(required(options, 'run-dir'), 'run directory');
  const receiptPath = required(options, 'receipt');
  requireForeignDiffControlName(receiptPath, 'foreign-diff receipt YAML');
  const receipt = await directRunYaml(runDirectory, receiptPath, 'foreign-diff receipt YAML');
  assertExactObject(receipt, ['schema_version', 'kind', 'action_id', 'changes'], 'foreign-diff receipt');
  if (!Array.isArray(receipt.changes)) fail('foreign-diff receipt changes must be an array');
  for (const [index, change] of receipt.changes.entries()) {
    assertExactObject(change, ['path', 'before_sha256', 'after_sha256'], `foreign-diff receipt changes[${index}]`);
  }
  return withForeignDiffGuardLock(runDirectory, async () => {
    await assertForeignDiffBinding(runDirectory);
    const result = await completeCruiseAction({
      statePath: join(runDirectory, 'drift.yaml'),
      receipt,
    });
    throwForeignDiffPause(result);
    output.write(`foreign-diff action ${receipt.action_id} accepted\n`);
    return result;
  });
}

async function foreignDiffCheckCommand(options, output) {
  const runDirectory = await realDirectory(required(options, 'run-dir'), 'run directory');
  return withForeignDiffGuardLock(runDirectory, async () => {
    await assertForeignDiffBinding(runDirectory);
    const result = await checkForForeignDiff({
      statePath: join(runDirectory, 'drift.yaml'),
    });
    throwForeignDiffPause(result);
    output.write('foreign-diff inventory clean\n');
    return result;
  });
}

async function foreignDiffResolveCommand(options, output) {
  const runDirectory = await realDirectory(required(options, 'run-dir'), 'run directory');
  requireForeignDiffControlName(required(options, 'resolution'), 'foreign-diff resolution YAML');
  const resolution = await directRunYaml(
    runDirectory,
    required(options, 'resolution'),
    'foreign-diff resolution YAML',
  );
  assertExactObject(
    resolution,
    ['schema_version', 'kind', 'incident_id', 'decision_id', 'selection'],
    'foreign-diff resolution',
  );
  if (resolution.schema_version !== 1 || resolution.kind !== 'cruise_foreign_diff_resolution') {
    fail('foreign-diff resolution kind or schema is invalid');
  }
  return withForeignDiffGuardLock(runDirectory, async () => {
    await assertForeignDiffBinding(runDirectory);
    const result = await resolveForeignDiffIncident({
      statePath: join(runDirectory, 'drift.yaml'),
      incidentId: resolution.incident_id,
      decisionId: resolution.decision_id,
      selection: resolution.selection,
    });
    await assertForeignDiffBinding(runDirectory, result.state);
    output.write(`foreign-diff incident ${resolution.incident_id} ${result.outcome}\n`);
    return result;
  });
}

async function foreignDiffFinalizeCommand(options, output) {
  const runDirectory = await realDirectory(required(options, 'run-dir'), 'run directory');
  return withForeignDiffGuardLock(runDirectory, async () => {
    await assertForeignDiffBinding(runDirectory);
    const result = await finalizeForeignDiffGuard({
      statePath: join(runDirectory, 'drift.yaml'),
      expectedInventorySha256: required(options, 'expected-inventory-sha256'),
    });
    await assertForeignDiffBinding(runDirectory, result.state);
    output.write(`foreign-diff guard ${result.outcome}\n`);
    return result;
  });
}

async function enrichProbeCommand(options, output) {
  const runDirectory = await realDirectory(required(options, 'run-dir'), 'run directory');
  const enrichmentPath = await realpath(
    await regularFile(required(options, 'facts'), 'probe enrichment YAML'),
  );
  const expectedEnrichmentPath = join(runDirectory, 'map-facts.yaml');
  if (enrichmentPath !== expectedEnrichmentPath) {
    fail('--facts must name the runtime packet-declared map-facts.yaml in --run-dir');
  }
  return withForeignDiffGuardedControlWrite(runDirectory, 'enrich', async () => {
    if (await pathExists(join(runDirectory, 'route.yaml'))) {
      fail('probe enrichment is forbidden after routing');
    }
    const originPath = await regularFile(join(runDirectory, 'origin.yaml'), 'origin YAML');
    const probePath = await regularFile(join(runDirectory, 'probe.yaml'), 'probe YAML');
    const statePath = await regularFile(join(runDirectory, 'state.yaml'), 'state YAML');
    const origin = await readYamlFile(originPath);
    const probe = await readYamlFile(probePath);
    const state = await readYamlFile(statePath);
    validateOriginRecord(origin);
    validateRunState(state);
    if (state.status !== 'routing_pending') {
      fail('probe enrichment requires routing_pending state');
    }
    if (deterministicProbeDigest(probe) !== origin.routing.deterministic_probe_digest) {
      throw new Error('probe.yaml digest does not match Origin before enrichment');
    }
    const guardCheck = await assertForeignDiffReady(runDirectory);
    await assertBaselineStillMatches(origin, { foreignDiffGuard: guardCheck.state });
    const enrichment = await readYamlFile(enrichmentPath);
    const enriched = enrichDeterministicProbe({
      probe,
      enrichment,
      rawPrompt: origin.origin.raw_prompt,
      repositoryBaseline: origin.repository_baseline,
    });
    const updatedOrigin = structuredClone(origin);
    updatedOrigin.routing.deterministic_probe_digest = deterministicProbeDigest(enriched);
    validateOriginRecord(updatedOrigin, { expectedOrigin: origin });
    const finalGuardCheck = await assertForeignDiffReady(runDirectory);
    await assertBaselineStillMatches(origin, { foreignDiffGuard: finalGuardCheck.state });
    // The enriched probe is written first. Origin remains the durable commit
    // marker; a partial write therefore fails closed on the next command.
    await writeYamlFile(probePath, enriched);
    await writeYamlFile(originPath, updatedOrigin);
    output.write(`enriched ${runDirectory}\n`);
    return enriched;
  });
}

async function routeCommand(options, output) {
  const selectedSkill = assertSkill(required(options, 'skill'));
  const runDirectory = await realDirectory(required(options, 'run-dir'), 'run directory');
  const initialPath = await regularFile(required(options, 'classifier'), 'classifier YAML');
  const retryPath = options['retry-classifier']
    ? await regularFile(options['retry-classifier'], 'retry classifier YAML')
    : null;
  const catalog = options['catalog-json']
    ? await readJsonBoundary(options['catalog-json'], 'model catalog')
    : [];

  return withForeignDiffGuardedControlWrite(runDirectory, 'route', async () => {
    const routePath = join(runDirectory, 'route.yaml');
    if (await pathExists(routePath)) fail(`route already exists: ${routePath}`);
    const originPath = await regularFile(join(runDirectory, 'origin.yaml'), 'origin YAML');
    const probePath = await regularFile(join(runDirectory, 'probe.yaml'), 'probe YAML');
    const statePath = await regularFile(join(runDirectory, 'state.yaml'), 'state YAML');
    const origin = await readYamlFile(originPath);
    validateOriginRecord(origin);
    if (origin.origin.selected_skill !== selectedSkill) {
      fail(`selected skill does not match immutable Origin (${origin.origin.selected_skill})`);
    }
    const probe = await readYamlFile(probePath);
    let state = await readYamlFile(statePath);
    validateRunState(state);
    if (state.selected_skill !== selectedSkill || state.status !== 'routing_pending') {
      fail('state.yaml does not describe the same pending selected skill');
    }
    const probeDigest = deterministicProbeDigest(probe);
    if (probeDigest !== origin.routing.deterministic_probe_digest) {
      throw new Error('probe.yaml digest does not match Origin');
    }
    const guardCheck = await assertForeignDiffReady(runDirectory);
    await assertBaselineStillMatches(origin, { foreignDiffGuard: guardCheck.state });
    assertRuntimeProbeReady(probe, {
      rawPrompt: origin.origin.raw_prompt,
      repositoryBaseline: origin.repository_baseline,
    });

    const classifierInputs = [
      await readYamlFile(initialPath),
      ...(retryPath ? [await readYamlFile(retryPath)] : []),
    ];
    let index = 0;
    const route = await classifyRoute({
      selectedSkill,
      probe,
      rawPrompt: origin.origin.raw_prompt,
      modelCatalog: catalog,
      classify() {
        if (index >= classifierInputs.length) {
          throw new Error('initial classifier was below 0.85 but no Terra retry YAML was supplied');
        }
        const value = classifierInputs[index];
        index += 1;
        return value;
      },
    });
    if (index !== classifierInputs.length) {
      throw new Error('retry classifier YAML was supplied but the Luna result did not require it');
    }

    const updatedOrigin = structuredClone(origin);
    updatedOrigin.routing = {
      deterministic_probe_digest: route.deterministic_probe_digest,
      initial_classifier: classifierLabel(route.initial_classifier),
      selected_route: route.selected_route,
      confidence: route.confidence,
      promotion_reasons: [...route.promotion_reasons],
    };
    validateOriginRecord(updatedOrigin, { expectedOrigin: origin });
    for (const [attemptIndex, attempt] of route.attempts.entries()) {
      const finalAttempt = attemptIndex === route.attempts.length - 1;
      state = transitionRunState(state, {
        status: finalAttempt ? 'routed' : 'routing_pending',
        currentRoute: finalAttempt ? route.selected_route : state.current_route,
        reason: finalAttempt
          ? `route_selected:${route.selected_route}${route.promotion_reasons.length > 0 ? `;promotion:${route.promotion_reasons.join(',')}` : ''}`
          : `classifier_attempt_${attemptIndex + 1}_recorded`,
        modelAttempt: attempt.policy,
        now: new Date(),
      });
    }
    const finalGuardCheck = await assertForeignDiffReady(runDirectory);
    await assertBaselineStillMatches(origin, { foreignDiffGuard: finalGuardCheck.state });
    // Write Origin first; route.yaml is the durable completion marker.
    await writeYamlFile(originPath, updatedOrigin);
    await writeYamlFile(statePath, state);
    await writeYamlFile(routePath, route);
    output.write(`routed ${route.selected_route}\n`);
    return route;
  });
}

async function validateOriginCommand(options, output) {
  const path = await regularFile(required(options, 'file'), 'origin YAML');
  const record = await readYamlFile(path);
  const expected = options['expected-origin']
    ? await readYamlFile(await regularFile(options['expected-origin'], 'expected Origin YAML'))
    : null;
  validateOriginRecord(record, { expectedOrigin: expected });
  output.write(`valid origin ${path}\n`);
  return record;
}

async function validateTraceCommand(options, output) {
  const path = await regularFile(required(options, 'file'), 'traceability YAML');
  const record = await readYamlFile(path);
  validateTraceability(record);
  const originPath = options.origin;
  const mappingsPath = options['origin-mappings'];
  if (Boolean(originPath) !== Boolean(mappingsPath)) {
    fail('--origin and --origin-mappings must be provided together');
  }
  if (options.final && (!originPath || !mappingsPath)) {
    fail('--final requires both --origin and --origin-mappings so origin coverage cannot be skipped');
  }
  const origin = originPath
    ? await readYamlFile(await regularFile(originPath, 'origin YAML'))
    : null;
  const mappings = mappingsPath
    ? await readYamlFile(await regularFile(mappingsPath, 'origin mappings YAML'))
    : null;
  if (options.final) {
    assertFinalTraceability(record, {
      originRecord: origin,
      originMappings: mappings,
    });
  } else if (origin != null) {
    fail('--origin coverage is a final-verification check and requires --final');
  }
  output.write(`valid traceability ${path}\n`);
  return record;
}

async function assertOutputPath(path) {
  const absolute = resolve(path);
  if (await pathExists(absolute)) {
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      fail('--output must be a regular file path, never a symlink');
    }
  }
  return absolute;
}

async function resolveModelCommand(options, output) {
  const stage = required(options, 'stage');
  const catalog = await readJsonBoundary(required(options, 'catalog-json'), 'model catalog');
  const outputPath = await assertOutputPath(required(options, 'output'));
  const attemptNumber = options['attempt-number'] == null
    ? 1
    : Number(options['attempt-number']);
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    fail('--attempt-number must be a positive integer');
  }
  const requested = options.tier || options.reasoning
    ? {
        ...(options.tier ? { tier: options.tier } : {}),
        ...(options.reasoning ? { reasoning_effort: options.reasoning } : {}),
      }
    : null;
  const record = resolveModelPolicy({
    stage,
    catalog,
    requested,
    attemptNumber,
    escalationReason: options['escalation-reason'] ?? null,
  });
  await writeYamlFile(outputPath, record);
  const request = modelRequestOptions(record);
  output.write(`resolved ${request.model ?? 'host-default'} ${request.reasoningEffort ?? 'host-default'}\n`);
  return record;
}

export async function runRuntimeCli(
  argv,
  { output = process.stdout, runtimeHooks = {} } = {},
) {
  const parsed = parseRuntimeArgs(argv);
  switch (parsed.command) {
    case 'help':
      output.write(HELP);
      return null;
    case 'begin':
      return beginCommand(parsed.options, output, runtimeHooks);
    case 'enrich-probe':
      return enrichProbeCommand(parsed.options, output);
    case 'route':
      return routeCommand(parsed.options, output);
    case 'validate-origin':
      return validateOriginCommand(parsed.options, output);
    case 'validate-trace':
      return validateTraceCommand(parsed.options, output);
    case 'resolve-model':
      return resolveModelCommand(parsed.options, output);
    case 'foreign-diff-project':
      return foreignDiffProjectCommand(parsed.options, output);
    case 'foreign-diff-open':
      return foreignDiffOpenCommand(parsed.options, output);
    case 'foreign-diff-close':
      return foreignDiffCloseCommand(parsed.options, output);
    case 'foreign-diff-check':
      return foreignDiffCheckCommand(parsed.options, output);
    case 'foreign-diff-resolve':
      return foreignDiffResolveCommand(parsed.options, output);
    case 'foreign-diff-finalize':
      return foreignDiffFinalizeCommand(parsed.options, output);
    default:
      fail(`unhandled internal runtime command: ${parsed.command}`);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === resolve(fileURLToPath(import.meta.url))) {
  runRuntimeCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`cruise-runtime: ${error.message}\n`);
    process.exitCode = 1;
  });
}
