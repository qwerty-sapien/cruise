#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
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
  captureRepositoryBaseline,
  createOriginRecord,
  validateOriginRecord,
} from './lib/origin.mjs';
import { createEvidenceRecord } from './lib/evidence.mjs';
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
} from './lib/routing.mjs';
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
  readYamlFile,
  writeYamlFile,
} from './lib/yaml-state.mjs';

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const BOOLEAN_OPTIONS = new Set(['stdin', 'final']);

const COMMAND_OPTIONS = Object.freeze({
  begin: new Set(['skill', 'root', 'run-dir', 'stdin', 'prompt-file']),
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
});

const HELP = `Cruise internal runtime

Usage:
  cruise-runtime begin --skill <skill> --root <repo> --run-dir <dir> (--stdin | --prompt-file <file>)
  cruise-runtime enrich-probe --run-dir <dir> --facts <yaml>
  cruise-runtime route --skill <skill> --run-dir <dir> --classifier <yaml> [--retry-classifier <yaml>] [--catalog-json <json>]
  cruise-runtime validate-origin --file <yaml> [--expected-origin <yaml>]
  cruise-runtime validate-trace --file <yaml> [--final --origin <yaml> --origin-mappings <yaml>]
  cruise-runtime resolve-model --stage <stage> --catalog-json <json> --output <yaml> [--tier <tier>] [--reasoning <effort>]

Raw prompts are accepted only from stdin or a regular prompt file. This CLI is
an internal skill runtime and is intentionally not registered in cruise --help.
Every begin must be followed by an evidence-bound enrich-probe assessment
before route; routing fails closed if that assessment is absent or stale.
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

async function stageRunDirectory(requestedPath, write) {
  const absolute = resolve(requestedPath);
  const name = basename(absolute);
  if (!name || name === '.' || name === '..') fail('--run-dir must name a new directory');
  await mkdir(dirname(absolute), { recursive: true });
  const parent = await realDirectory(dirname(absolute), 'run-directory parent');
  const target = join(parent, name);
  if (await pathExists(target)) fail(`run directory already exists: ${target}`);
  const staging = join(parent, `.${name}.tmp-${process.pid}-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    await write(staging);
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return target;
}

async function withRunLock(runDirectory, name, callback) {
  const path = join(runDirectory, `.${name}.lock`);
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

function assertSkill(value) {
  if (!PUBLIC_ROUTES.includes(value)) fail(`--skill must be one of ${PUBLIC_ROUTES.join(', ')}`);
  return value;
}

async function beginCommand(options, output) {
  const selectedSkill = assertSkill(required(options, 'skill'));
  const root = await realDirectory(required(options, 'root'), 'repository root');
  const runPath = required(options, 'run-dir');
  const runId = basename(resolve(runPath));
  const rawPrompt = await readRawPrompt(options);
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
  const runDirectory = await stageRunDirectory(runPath, async (staging) => {
    await writeYamlFile(join(staging, 'probe.yaml'), probe);
    await writeYamlFile(join(staging, 'state.yaml'), state);
    await writeYamlFile(join(staging, 'evidence.yaml'), evidence);
    // origin.yaml is the commit marker for a successfully staged begin.
    await writeYamlFile(join(staging, 'origin.yaml'), origin);
  });
  output.write(`created ${runDirectory}\n`);
  return { runDirectory, origin, probe, state, evidence };
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

async function assertBaselineStillMatches(origin) {
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
    throw new Error('repository baseline changed after begin; rerun Cruise routing from a fresh Origin');
  }
}

async function enrichProbeCommand(options, output) {
  const runDirectory = await realDirectory(required(options, 'run-dir'), 'run directory');
  const enrichmentPath = await regularFile(required(options, 'facts'), 'probe enrichment YAML');
  return withRunLock(runDirectory, 'enrich-probe', async () => {
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
    await assertBaselineStillMatches(origin);
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

  return withRunLock(runDirectory, 'route', async () => {
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
    await assertBaselineStillMatches(origin);
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
  { output = process.stdout } = {},
) {
  const parsed = parseRuntimeArgs(argv);
  switch (parsed.command) {
    case 'help':
      output.write(HELP);
      return null;
    case 'begin':
      return beginCommand(parsed.options, output);
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
