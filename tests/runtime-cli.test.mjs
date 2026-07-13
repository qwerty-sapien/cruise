import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { MODEL_IDS } from '../scripts/lib/model-policy.mjs';
import { validateOriginRecord } from '../scripts/lib/origin.mjs';
import {
  deterministicProbeDigest,
  QUICK_HARD_GATE_SIGNALS,
  repositoryBaselineDigest,
} from '../scripts/lib/routing.mjs';
import {
  createTaskTrace,
  createTraceabilityRecord,
  originClauses,
} from '../scripts/lib/traceability.mjs';
import { readYamlFile, stringifyYaml, writeYamlFile } from '../scripts/lib/yaml-state.mjs';

const RUNTIME = resolve('scripts/cruise-runtime.mjs');

function catalog() {
  return [
    {
      id: MODEL_IDS.luna,
      model: MODEL_IDS.luna,
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      id: MODEL_IDS.terra,
      model: MODEL_IDS.terra,
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'ultra'],
    },
    {
      id: MODEL_IDS.sol,
      model: MODEL_IDS.sol,
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'ultra', 'max'],
    },
  ];
}

function classifier(overrides = {}) {
  return {
    route: 'quick',
    recommended_level: 2,
    confidence: 0.95,
    ambiguity: 'low',
    semantic_risk: 'low',
    estimated_files: 1,
    estimated_diff_lines: 3,
    public_api_change: false,
    abi_change: false,
    data_migration: false,
    security_sensitive: false,
    concurrency_sensitive: false,
    build_or_release_change: false,
    unknown_indirect_callers: false,
    requires_external_research: false,
    reasons: [],
    ...overrides,
  };
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'cruise-runtime-'));
  const root = join(base, 'repo');
  await mkdir(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'cruise-test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Cruise Test'], { cwd: root });
  await writeFile(join(root, 'AGENTS.md'), '# Instructions\n');
  await writeFile(join(root, 'app.txt'), 'stable\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root });
  const catalogPath = join(base, 'models.json');
  await writeFile(catalogPath, JSON.stringify(catalog()), 'utf8');
  return { base, root, catalogPath };
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [RUNTIME, ...args], {
    encoding: 'utf8',
    ...options,
  });
}

async function begin({ root, runDirectory, skill = 'quick', prompt }) {
  const result = run(
    ['begin', '--skill', skill, '--root', root, '--run-dir', runDirectory, '--stdin'],
    { input: prompt },
  );
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function digestBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function completeProbe({ runDirectory, facts = [] }) {
  const origin = await readYamlFile(join(runDirectory, 'origin.yaml'));
  const supplied = new Map(facts.map((fact) => [fact.signal, fact]));
  const completeFacts = QUICK_HARD_GATE_SIGNALS.map((signal, index) => ({
    ...(supplied.get(signal) ?? promptFact({
      signal,
      value: signal === 'failed_quick_repairs' ? 0 : false,
      prompt: origin.origin.raw_prompt,
    })),
    id: `PF-${String(index + 1).padStart(2, '0')}`,
  }));
  const path = join(runDirectory, 'probe-enrichment-input.yaml');
  await writeYamlFile(path, {
    schema_version: 1,
    prompt_sha256: origin.origin.prompt_sha256,
    repository_baseline_digest: repositoryBaselineDigest(origin.repository_baseline),
    assessed_quick_gates: [...QUICK_HARD_GATE_SIGNALS],
    facts: completeFacts,
  });
  const result = run([
    'enrich-probe',
    '--run-dir', runDirectory,
    '--facts', path,
  ]);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function promptFact({ id = 'PF-01', signal, value = true, prompt }) {
  const bytes = Buffer.from(prompt, 'utf8');
  return {
    id,
    signal,
    value,
    basis: [{
      kind: 'prompt_span',
      locator: `bytes:0:${bytes.length}`,
      sha256: digestBytes(bytes),
    }],
  };
}

test('internal help is direct-only and normal cruise help does not register runtime commands', () => {
  const internal = run(['--help']);
  assert.equal(internal.status, 0);
  assert.match(internal.stdout, /cruise-runtime begin/);

  const normal = spawnSync(process.execPath, [resolve('scripts/cruise.mjs'), '--help'], {
    encoding: 'utf8',
  });
  assert.equal(normal.status, 0);
  assert.doesNotMatch(normal.stdout, /validate-origin|resolve-model|cruise-runtime/u);
});

test('begin preserves stdin whitespace and line endings exactly in atomic YAML state', async () => {
  const { base, root } = await fixture();
  const runDirectory = join(base, 'run-stdin');
  const prompt = '  leading spaces\r\nline with trailing spaces  \n\n';
  const result = await begin({ root, runDirectory, prompt });
  assert.match(result.stdout, /^created /u);

  const origin = await readYamlFile(join(runDirectory, 'origin.yaml'));
  const probe = await readYamlFile(join(runDirectory, 'probe.yaml'));
  const state = await readYamlFile(join(runDirectory, 'state.yaml'));
  const evidence = await readYamlFile(join(runDirectory, 'evidence.yaml'));
  validateOriginRecord(origin);
  assert.equal(origin.origin.raw_prompt, prompt);
  assert.equal(
    origin.origin.prompt_sha256,
    createHash('sha256').update(Buffer.from(prompt, 'utf8')).digest('hex'),
  );
  assert.equal(origin.routing.deterministic_probe_digest, deterministicProbeDigest(probe));
  assert.equal(origin.routing.initial_classifier, 'pending classification');
  assert.equal(probe.acquisition.status, 'pending');
  assert.equal(probe.budgets.git_command_timeout_ms, 10_000);
  assert.equal(probe.budgets.semantic_evidence_total_max_bytes, 4 * 1024 * 1024);
  assert.equal(probe.usage.semantic_evidence_bytes, 0);
  assert.equal(state.status, 'routing_pending');
  assert.equal(state.selected_skill, 'quick');
  assert.equal(evidence.outcome, 'active');
});

test('begin commits valid blocked artifacts for an oversized untracked file', async () => {
  const { base, root } = await fixture();
  const oversizedPath = join(root, 'oversized.bin');
  await writeFile(oversizedPath, '');
  await truncate(oversizedPath, 2 * 1024 * 1024 * 1024 + 1);
  const runDirectory = join(base, 'blocked-run');
  const result = await begin({ root, runDirectory, prompt: 'Capture this repository safely.\n' });
  assert.match(result.stdout, /created/);
  const origin = await readYamlFile(join(runDirectory, 'origin.yaml'));
  const state = await readYamlFile(join(runDirectory, 'state.yaml'));
  const probe = await readYamlFile(join(runDirectory, 'probe.yaml'));
  const evidence = await readYamlFile(join(runDirectory, 'evidence.yaml'));
  validateOriginRecord(origin);
  assert.equal(origin.repository_baseline.capture_status, 'blocked');
  assert.equal(origin.repository_baseline.block.code, 'FILE_SIZE_LIMIT');
  assert.equal(state.status, 'blocked');
  assert.equal(probe.schema_version, 2);
  assert.equal(evidence.schema_version, 1);
});

test('begin accepts a regular prompt file but rejects prompt positionals and symlinks', async () => {
  const { base, root } = await fixture();
  const promptPath = join(base, 'prompt.txt');
  const prompt = 'from-file\n\n';
  await writeFile(promptPath, prompt, 'utf8');
  const runDirectory = join(base, 'run-file');
  const result = run([
    'begin',
    '--skill', 'research',
    '--root', root,
    '--run-dir', runDirectory,
    '--prompt-file', promptPath,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readYamlFile(join(runDirectory, 'origin.yaml'))).origin.raw_prompt, prompt);

  const positional = run([
    'begin',
    '--skill', 'quick',
    '--root', root,
    '--run-dir', join(base, 'forbidden'),
    '--stdin',
    'raw prompt must never be positional',
  ]);
  assert.equal(positional.status, 1);
  assert.match(positional.stderr, /positional arguments are forbidden/);

  const linked = join(base, 'prompt-link.txt');
  await symlink(promptPath, linked);
  const symlinked = run([
    'begin',
    '--skill', 'quick',
    '--root', root,
    '--run-dir', join(base, 'linked-run'),
    '--prompt-file', linked,
  ]);
  assert.equal(symlinked.status, 1);
  assert.match(symlinked.stderr, /regular file, not a symlink/);
});

test('runtime requires an evidence-bound assessment and overrides a false-negative classifier', async () => {
  const { base, root, catalogPath } = await fixture();
  const runDirectory = join(base, 'run-route');
  const prompt = 'Remove the exported API method.\n';
  await begin({ root, runDirectory, prompt });
  const classifierPath = join(runDirectory, 'classifier.yaml');
  await writeYamlFile(classifierPath, classifier({ public_api_change: false }));

  const premature = run([
    'route',
    '--skill', 'quick',
    '--run-dir', runDirectory,
    '--classifier', classifierPath,
    '--catalog-json', catalogPath,
  ]);
  assert.equal(premature.status, 1);
  assert.match(premature.stderr, /semantic enrichment is required/);
  await completeProbe({
    runDirectory,
    facts: [],
  });

  const result = run([
    'route',
    '--skill', 'quick',
    '--run-dir', runDirectory,
    '--classifier', classifierPath,
    '--catalog-json', catalogPath,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'routed goal\n');
  const route = await readYamlFile(join(runDirectory, 'route.yaml'));
  const origin = await readYamlFile(join(runDirectory, 'origin.yaml'));
  const state = await readYamlFile(join(runDirectory, 'state.yaml'));
  assert.equal(route.selected_route, 'goal');
  assert.deepEqual(route.promotion_reasons, ['public_api_change']);
  assert.equal(route.initial_classifier.policy.resolved.model_id, MODEL_IDS.luna);
  assert.equal(origin.origin.raw_prompt, prompt);
  assert.equal(origin.routing.selected_route, 'goal');
  assert.equal(origin.routing.initial_classifier, `${MODEL_IDS.luna} medium`);
  assert.equal(state.status, 'routed');
  assert.equal(state.current_route, 'goal');
  assert.equal(state.model_attempts.length, 1);
  const probe = await readYamlFile(join(runDirectory, 'probe.yaml'));
  assert.equal(probe.acquisition.method, 'evidence_bound_semantic_assessment');
  assert.equal(probe.acquisition.assessed_quick_gates.length, 18);
  assert.equal(
    probe.semantic_facts.find((fact) => fact.signal === 'public_api_change').value,
    false,
  );
  assert.deepEqual(probe.acquisition.prompt_derived_signals, ['public_api_change']);
  validateOriginRecord(origin);
});

test('runtime persists and enforces all 18 hard Quick signals from one bounded assessment', async () => {
  const { base, root, catalogPath } = await fixture();
  const runDirectory = join(base, 'run-all-gates');
  const prompt = 'Assess every hard gate before accepting this as Quick.\n';
  await begin({ root, runDirectory, prompt });
  await completeProbe({
    runDirectory,
    facts: QUICK_HARD_GATE_SIGNALS.map((signal, index) => promptFact({
      id: `PF-${String(index + 1).padStart(2, '0')}`,
      signal,
      value: signal === 'failed_quick_repairs' ? 2 : true,
      prompt,
    })),
  });
  const classifierPath = join(runDirectory, 'classifier.yaml');
  await writeYamlFile(classifierPath, classifier());
  const result = run([
    'route',
    '--skill', 'quick',
    '--run-dir', runDirectory,
    '--classifier', classifierPath,
    '--catalog-json', catalogPath,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'routed debug\n');
  const probe = await readYamlFile(join(runDirectory, 'probe.yaml'));
  const route = await readYamlFile(join(runDirectory, 'route.yaml'));
  assert.equal(probe.semantic_facts.length, 18);
  assert.deepEqual(
    [...route.promotion_reasons].sort(),
    [...QUICK_HARD_GATE_SIGNALS].sort(),
  );
  assert.equal(route.selected_route, 'debug');
});

test('runtime keeps proven OAuth and public API documentation typos in Quick', async () => {
  const { base, root, catalogPath } = await fixture();
  const cases = [
    ['oauth-doc-typo', 'Fix the typo in the OAuth login documentation.\n'],
    ['api-doc-typo', 'Correct the spelling in the public API docs.\n'],
  ];
  for (const [name, prompt] of cases) {
    const runDirectory = join(base, name);
    await begin({ root, runDirectory, prompt });
    await completeProbe({ runDirectory });
    const classifierPath = join(runDirectory, 'classifier.yaml');
    await writeYamlFile(classifierPath, classifier());
    const result = run([
      'route',
      '--skill', 'quick',
      '--run-dir', runDirectory,
      '--classifier', classifierPath,
      '--catalog-json', catalogPath,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'routed quick\n');
    const probe = await readYamlFile(join(runDirectory, 'probe.yaml'));
    const route = await readYamlFile(join(runDirectory, 'route.yaml'));
    assert.deepEqual(probe.acquisition.prompt_derived_signals, [], name);
    assert.deepEqual(route.promotion_reasons, [], name);
    assert.equal(route.selected_route, 'quick', name);
  }
});

test('route requires exactly one Terra retry below threshold and honors persistent uncertainty', async () => {
  const { base, root, catalogPath } = await fixture();
  const runDirectory = join(base, 'run-retry');
  await begin({ root, runDirectory, skill: 'build', prompt: 'Develop this milestone.\n' });
  await completeProbe({ runDirectory });
  const initial = join(runDirectory, 'initial.yaml');
  const retry = join(runDirectory, 'retry.yaml');
  await writeYamlFile(initial, classifier({ route: 'research', confidence: 0.4 }));
  await writeYamlFile(retry, classifier({ route: 'quick', confidence: 0.7 }));

  const missing = run([
    'route',
    '--skill', 'build',
    '--run-dir', runDirectory,
    '--classifier', initial,
    '--catalog-json', catalogPath,
  ]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no Terra retry YAML was supplied/);

  const result = run([
    'route',
    '--skill', 'build',
    '--run-dir', runDirectory,
    '--classifier', initial,
    '--retry-classifier', retry,
    '--catalog-json', catalogPath,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const route = await readYamlFile(join(runDirectory, 'route.yaml'));
  const state = await readYamlFile(join(runDirectory, 'state.yaml'));
  assert.equal(route.selected_route, 'build');
  assert.equal(route.uncertain, true);
  assert.equal(route.attempts.length, 2);
  assert.equal(route.retry_classifier.policy.resolved.model_id, MODEL_IDS.terra);
  assert.equal(state.status, 'routed');
  assert.equal(state.current_route, 'build');
  assert.equal(state.model_attempts.length, 2);
});

test('route fails closed on repository drift and never writes route.yaml', async () => {
  const { base, root } = await fixture();
  const runDirectory = join(base, 'run-drift');
  await begin({ root, runDirectory, prompt: 'Known small change.\n' });
  await completeProbe({ runDirectory });
  const classifierPath = join(runDirectory, 'classifier.yaml');
  await writeYamlFile(classifierPath, classifier());
  await writeFile(join(root, 'app.txt'), 'drifted after begin\n');
  const result = run([
    'route',
    '--skill', 'quick',
    '--run-dir', runDirectory,
    '--classifier', classifierPath,
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /repository baseline changed after begin/);
  await assert.rejects(readFile(join(runDirectory, 'route.yaml')), /ENOENT/);
});

test('validate-origin and validate-trace enforce persisted contracts', async () => {
  const { base, root } = await fixture();
  const runDirectory = join(base, 'run-validation');
  await begin({ root, runDirectory, skill: 'refine', prompt: 'Refine this outcome.\n' });
  const originPath = join(runDirectory, 'origin.yaml');
  const origin = run(['validate-origin', '--file', originPath]);
  assert.equal(origin.status, 0, origin.stderr);
  assert.match(origin.stdout, /valid origin/);

  const trace = createTraceabilityRecord({
    goal_clauses: [{ id: 'G-01' }],
    requirements: [{ id: 'R-01' }],
    acceptance_criteria: [{ id: 'AC-01' }],
    evidence: [{ id: 'E-01', result: 'pass' }],
    tasks: [
      createTaskTrace({
        taskId: 'T-01',
        satisfies: ['R-01', 'AC-01'],
        preserves: ['G-01'],
        verification: ['E-01'],
      }),
    ],
  });
  const tracePath = join(base, 'trace.yaml');
  await writeYamlFile(tracePath, trace);
  const validated = run(['validate-trace', '--file', tracePath]);
  assert.equal(validated.status, 0, validated.stderr);
  assert.match(validated.stdout, /valid traceability/);
  const finalWithoutOrigin = run(['validate-trace', '--file', tracePath, '--final']);
  assert.equal(finalWithoutOrigin.status, 1);
  assert.match(finalWithoutOrigin.stderr, /requires both --origin and --origin-mappings/);

  const originRecord = await readYamlFile(originPath);
  const mappingsPath = join(base, 'origin-mappings.yaml');
  const mappings = originClauses(originRecord).map((clause) => ({
    ...clause,
    trace_ids: ['G-01'],
  }));
  await writeYamlFile(mappingsPath, mappings);
  const originValidated = run([
    'validate-trace',
    '--file', tracePath,
    '--final',
    '--origin', originPath,
    '--origin-mappings', mappingsPath,
  ]);
  assert.equal(originValidated.status, 0, originValidated.stderr);

  await writeYamlFile(mappingsPath, []);
  const omitted = run([
    'validate-trace',
    '--file', tracePath,
    '--final',
    '--origin', originPath,
    '--origin-mappings', mappingsPath,
  ]);
  assert.equal(omitted.status, 1);
  assert.match(omitted.stderr, /omitted origin clause/);

  const invalidPath = join(base, 'invalid-trace.yaml');
  const invalid = structuredClone(trace);
  invalid.tasks[0].verification = ['E-99'];
  await writeFile(invalidPath, stringifyYaml(invalid), 'utf8');
  const rejected = run(['validate-trace', '--file', invalidPath]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /references missing E-99/);
});

test('resolve-model consumes only app-server JSON and atomically records requested/resolved policy', async () => {
  const { base, catalogPath } = await fixture();
  const output = join(base, 'model.yaml');
  const result = run([
    'resolve-model',
    '--stage', 'refine_clarification_and_planning',
    '--catalog-json', catalogPath,
    '--output', output,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `resolved ${MODEL_IDS.terra} high\n`);
  const record = await readYamlFile(output);
  assert.equal(record.requested.tier, 'terra');
  assert.equal(record.requested.reasoning_effort, 'high');
  assert.equal(record.resolved.model_id, MODEL_IDS.terra);
  assert.equal(record.resolved.reasoning_effort, 'high');

  const yamlCatalog = join(base, 'models.yaml');
  await writeFile(yamlCatalog, stringifyYaml(catalog()), 'utf8');
  const rejected = run([
    'resolve-model',
    '--stage', 'initial_classification',
    '--catalog-json', yamlCatalog,
    '--output', join(base, 'wrong.yaml'),
  ]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /app-server boundary JSON/);
});
