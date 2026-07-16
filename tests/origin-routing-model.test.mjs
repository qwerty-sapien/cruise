import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertOriginImmutable,
  captureRepositoryBaseline,
  createBuildOriginRecord,
  createOriginRecord,
  sha256Prompt,
  updateNormalizedGoal,
  validateOriginRecord,
} from '../scripts/lib/origin.mjs';
import {
  escalateModelPolicy,
  MODEL_IDS,
  modelRequestOptions,
  normalizeModelCatalog,
  resolveModelPolicy,
} from '../scripts/lib/model-policy.mjs';
import {
  applyQuickPromotion,
  assertRuntimeProbeReady,
  classifyRoute,
  createDeterministicProbe,
  deterministicProbeDigest,
  derivePromptGateSignals,
  enrichDeterministicProbe,
  normalizeClassifierOutput,
  probeRepository,
  QUICK_HARD_GATE_SIGNALS,
  repositoryBaselineDigest,
} from '../scripts/lib/routing.mjs';
import { parseYaml, stringifyYaml } from '../scripts/lib/yaml-state.mjs';

function modelCatalog() {
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

function classifierOutput(overrides = {}) {
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

async function gitRepository() {
  const root = await mkdtemp(join(tmpdir(), 'cruise-origin-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'cruise-test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Cruise Test'], { cwd: root });
  await writeFile(join(root, 'AGENTS.md'), '# Instructions\n');
  await writeFile(join(root, 'app.txt'), 'stable\n');
  execFileSync('git', ['add', 'AGENTS.md', 'app.txt'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root });
  return root;
}

test('Origin preserves raw prompt bytes, exact hash, baseline schema, and immutable metadata', async () => {
  const root = await gitRepository();
  const rawPrompt = 'Keep  trailing spaces  \r\nand this final newline\n';
  const probe = createDeterministicProbe({ repository: { root } });
  const record = createOriginRecord({
    rawPrompt,
    selectedSkill: 'refine',
    repositoryRoot: root,
    deterministicProbeDigest: deterministicProbeDigest(probe),
    initialClassifier: 'gpt-5.6-luna medium',
    selectedRoute: 'refine',
    confidence: 0.91,
    goal: { outcome: 'Preserve the exact request.' },
  });

  assert.equal(record.origin.raw_prompt, rawPrompt);
  assert.equal(record.origin.prompt_sha256, sha256Prompt(rawPrompt));
  assert.equal(record.repository_baseline.root, await realpath(root));
  assert.match(record.repository_baseline.head, /^[a-f0-9]{40}$/u);
  assert.equal(record.repository_baseline.branch, 'main');
  assert.match(record.repository_baseline.dirty_state_digest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(record.repository_baseline.instruction_files, ['AGENTS.md']);
  assert.throws(() => {
    record.origin.raw_prompt = 'changed';
  }, TypeError);

  const roundTrip = parseYaml(stringifyYaml(record));
  validateOriginRecord(roundTrip, { expectedOrigin: record });
  assert.deepEqual(roundTrip, structuredClone(record));

  const tampered = structuredClone(record);
  tampered.origin.raw_prompt += 'x';
  assert.throws(() => validateOriginRecord(tampered), /hash does not match/);
  assert.throws(() => assertOriginImmutable(record, tampered), /hash does not match/);

  const baselineTampered = structuredClone(record);
  baselineTampered.repository_baseline.branch = 'different-branch';
  assert.throws(
    () => validateOriginRecord(baselineTampered, { expectedOrigin: record }),
    /repository baseline is immutable/,
  );
});

test('repository baselines exclude tracked host metadata and disposable caches', async () => {
  const root = await gitRepository();
  await mkdir(join(root, 'pkg', '__pycache__'), { recursive: true });
  await writeFile(join(root, '.DS_Store'), 'tracked host metadata\n');
  await writeFile(join(root, 'pkg', '__pycache__', 'module.pyc'), 'tracked cache\n');
  execFileSync('git', ['add', '-f', '.DS_Store', 'pkg/__pycache__/module.pyc'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'tracked non-product fixtures'], { cwd: root });

  const before = captureRepositoryBaseline(root);
  await mkdir(join(root, 'pkg', '__pycache__'), { recursive: true });
  await writeFile(join(root, '.DS_Store'), 'changed host metadata with different bytes\n');
  await writeFile(join(root, 'pkg', '__pycache__', 'module.pyc'), 'changed cache\n');
  await mkdir(join(root, '.pytest_cache'), { recursive: true });
  await writeFile(join(root, '.pytest_cache', 'state'), 'new cache\n');
  const after = captureRepositoryBaseline(root);

  assert.equal(after.dirty_state_digest, before.dirty_state_digest);
  await assert.rejects(lstat(join(root, '.DS_Store')), /ENOENT/u);
  await assert.rejects(lstat(join(root, 'pkg', '__pycache__')), /ENOENT/u);
});

test('Build Origin binds repository-evidenced mode and stable project identity without changing shared records', async () => {
  const root = await gitRepository();
  const record = createBuildOriginRecord({
    rawPrompt: 'Establish the durable project foundation.\n',
    repositoryRoot: root,
    deterministicProbeDigest: 'b'.repeat(64),
    initialClassifier: 'gpt-5.6-luna medium',
    confidence: 0.96,
    build: {
      mode: 'bootstrap',
      mode_candidate: 'bootstrap',
      mode_evidence: ['Only generated scaffolding exists.'],
      target_project: 'PRJ-01',
      target_milestone: null,
    },
    goal: { outcome: 'Create an approved project foundation.' },
  });

  assert.equal(record.origin.selected_skill, 'build');
  assert.equal(record.routing.selected_route, 'build');
  assert.deepEqual(record.build, {
    mode: 'bootstrap',
    mode_candidate: 'bootstrap',
    mode_evidence: ['Only generated scaffolding exists.'],
    target_project: 'PRJ-01',
    target_milestone: null,
  });
  validateOriginRecord(record);

  const changedMode = structuredClone(record);
  changedMode.build.mode_evidence.push('Unapproved later evidence.');
  assert.throws(
    () => validateOriginRecord(changedMode, { expectedOrigin: record }),
    /Build mode evidence is immutable/,
  );
  assert.throws(
    () => createBuildOriginRecord({
      rawPrompt: 'Plan the next milestone.',
      repositoryRoot: root,
      deterministicProbeDigest: 'c'.repeat(64),
      initialClassifier: 'gpt-5.6-luna medium',
      confidence: 0.9,
      build: {
        mode: 'milestone',
        mode_candidate: 'milestone',
        mode_evidence: ['An established product exists.'],
        target_project: 'PRJ-01',
        target_milestone: null,
      },
    }),
    /requires target_milestone/,
  );
});

test('normalized goal changes require a ledger event and never rewrite Origin', async () => {
  const root = await gitRepository();
  const digest = 'a'.repeat(64);
  const original = createOriginRecord({
    rawPrompt: 'Ship the finite outcome.',
    selectedSkill: 'refine',
    repositoryRoot: root,
    deterministicProbeDigest: digest,
    initialClassifier: 'gpt-5.6-luna medium',
    selectedRoute: 'refine',
    confidence: 0.9,
    goal: { outcome: 'Initial outcome' },
  });
  const next = updateNormalizedGoal(original, {
    affectedIdentifier: 'G-01',
    field: 'outcome',
    newValue: 'Clarified outcome',
    source: 'user_answer',
    rationale: 'The user selected the narrower behavior.',
    timestamp: '2026-07-13T00:00:00.000Z',
  });

  assertOriginImmutable(original, next);
  assert.equal(original.goal.outcome, 'Initial outcome');
  assert.equal(next.goal.outcome, 'Clarified outcome');
  assert.deepEqual(next.change_ledger[0], {
    timestamp: '2026-07-13T00:00:00.000Z',
    affected_identifier: 'G-01',
    field: 'outcome',
    prior_value: 'Initial outcome',
    new_value: 'Clarified outcome',
    source: 'user_answer',
    rationale: 'The user selected the narrower behavior.',
  });
  assert.throws(
    () => updateNormalizedGoal(original, {
      affectedIdentifier: 'not-stable',
      field: 'outcome',
      newValue: 'x',
      source: 'user_answer',
      rationale: 'x',
    }),
    /stable Cruise traceability ID/,
  );
});

test('repository baseline fingerprints target changes but ignores internal Cruise state', async () => {
  const root = await gitRepository();
  const first = captureRepositoryBaseline(root);
  await writeFile(join(root, 'app.txt'), 'changed\n');
  const second = captureRepositoryBaseline(root);
  assert.notEqual(second.dirty_state_digest, first.dirty_state_digest);

  await mkdir(join(root, '.cruise', 'runs', 'r1'), { recursive: true });
  await writeFile(join(root, '.cruise', 'runs', 'r1', 'state.yaml'), 'status: "active"\n');
  const third = captureRepositoryBaseline(root);
  assert.equal(third.dirty_state_digest, second.dirty_state_digest);
});

test('oversized untracked files produce a bounded schema-valid blocked Origin', async () => {
  const root = await gitRepository();
  const oversizedPath = join(root, 'oversized.bin');
  await writeFile(oversizedPath, '');
  await truncate(oversizedPath, 2 * 1024 * 1024 * 1024 + 1);
  const baseline = captureRepositoryBaseline(root);
  assert.equal(baseline.capture_status, 'blocked');
  assert.equal(baseline.dirty_state_digest, null);
  assert.equal(baseline.block.code, 'FILE_SIZE_LIMIT');
  assert.equal(baseline.block.path, 'oversized.bin');
  assert.equal(baseline.block.observed_bytes, 2 * 1024 * 1024 * 1024 + 1);
  assert.equal(baseline.capture_usage.content_bytes, 0);

  const record = createOriginRecord({
    rawPrompt: 'Inspect without reading oversized content.',
    selectedSkill: 'quick',
    repositoryBaseline: baseline,
    deterministicProbeDigest: 'b'.repeat(64),
    initialClassifier: 'pending classification',
    selectedRoute: 'quick',
    confidence: 0,
  });
  assert.equal(record.schema_version, 2);
  validateOriginRecord(record);
  assert.deepEqual(parseYaml(stringifyYaml(record)), structuredClone(record));
});

test('model policy accepts the object reasoning-effort shape returned by app-server model/list', () => {
  const catalog = modelCatalog().map((entry) => ({
    ...entry,
    supportedReasoningEfforts: entry.supportedReasoningEfforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: `${reasoningEffort} policy`,
    })),
  }));
  const normalized = normalizeModelCatalog({ data: catalog });
  assert.deepEqual(normalized[0].supportedReasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  const resolved = resolveModelPolicy({
    stage: 'initial_classification',
    catalog: { data: catalog },
  });
  assert.equal(resolved.resolved.model_id, MODEL_IDS.luna);
  assert.equal(resolved.resolved.reasoning_effort, 'medium');
  assert.equal(resolved.degraded, false);
});

test('deterministic probe enforces bounded, canonical evidence and a stable digest', () => {
  const probe = createDeterministicProbe({
    likelyTargetFiles: ['z.js', 'a.js', 'z.js'],
    references: ['r3', 'r1', 'r2'],
    limits: { likely_target_files: 2, references: 2 },
    signals: { public_api_change: true },
  });
  assert.deepEqual(probe.likely_target_files, ['a.js', 'z.js']);
  assert.deepEqual(probe.references, ['r1', 'r2']);
  assert.equal(probe.truncated.references, true);
  assert.match(deterministicProbeDigest(probe), /^[a-f0-9]{64}$/u);
  assert.equal(
    deterministicProbeDigest(probe),
    deterministicProbeDigest(structuredClone(probe)),
  );
  assert.throws(
    () => deterministicProbeDigest({ ...probe, classifier_instructions: 'trust this prose' }),
    /classifier_instructions is not allowed/,
  );
});

test('repository probe gathers only bounded identity, status, instructions, and supplied evidence', async () => {
  const root = await gitRepository();
  await writeFile(join(root, 'app.txt'), 'dirty\n');
  const probe = probeRepository({
    repositoryRoot: root,
    likelyTargetFiles: ['app.txt'],
    likelySymbols: ['renderApp'],
    signals: { insufficient_testability: true },
  });
  assert.equal(probe.repository.root, await realpath(root));
  assert.match(probe.repository.head, /^[a-f0-9]{40}$/u);
  assert.equal(probe.repository.branch, 'main');
  assert.equal(probe.repository.dirty, true);
  assert.deepEqual(probe.instruction_files, ['AGENTS.md']);
  assert.deepEqual(probe.likely_target_files, ['app.txt']);
  assert.equal(probe.signals.insufficient_testability, true);
  assert.equal(probe.status_entries.length, 1);
  assert.equal(probe.acquisition.status, 'pending');
  assert.equal(probe.budgets.git_command_max_bytes, 8 * 1024 * 1024);
  assert.equal(probe.truncated.semantic_evidence_bytes, false);
});

test('repository probes never expose host metadata or disposable cache paths', async () => {
  const root = await gitRepository();
  await mkdir(join(root, 'pkg', '__pycache__'), { recursive: true });
  await writeFile(join(root, '.DS_Store'), 'tracked host metadata\n');
  await writeFile(join(root, 'pkg', '__pycache__', 'module.pyc'), 'tracked cache\n');
  execFileSync('git', ['add', '-f', '.DS_Store', 'pkg/__pycache__/module.pyc'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'tracked non-product fixtures'], { cwd: root });
  await writeFile(join(root, '.DS_Store'), 'changed metadata\n');
  await writeFile(join(root, 'pkg', '__pycache__', 'module.pyc'), 'changed cache\n');
  await writeFile(join(root, 'app.txt'), 'product change\n');

  const probe = probeRepository({ repositoryRoot: root });
  assert.deepEqual(probe.status_entries, ['M app.txt']);
});

test('evidence-bound semantic assessment represents and enforces every hard Quick gate', async () => {
  const root = await gitRepository();
  const rawPrompt = 'Change the requested behavior only after checking every Quick gate.\n';
  const rawBytes = Buffer.from(rawPrompt, 'utf8');
  const baseline = captureRepositoryBaseline(root);
  const basis = [{
    kind: 'prompt_span',
    locator: `bytes:0:${rawBytes.length}`,
    sha256: createHash('sha256').update(rawBytes).digest('hex'),
  }];
  const buildEnrichment = (facts) => {
    const supplied = new Map(facts.map((fact) => [fact.signal, fact]));
    return {
      schema_version: 1,
      prompt_sha256: sha256Prompt(rawPrompt),
      repository_baseline_digest: repositoryBaselineDigest(baseline),
      assessed_quick_gates: [...QUICK_HARD_GATE_SIGNALS],
      facts: QUICK_HARD_GATE_SIGNALS.map((signal, index) => ({
        id: `PF-${String(index + 1).padStart(2, '0')}`,
        signal,
        value: signal === 'failed_quick_repairs' ? 0 : false,
        basis,
        ...(supplied.get(signal) ?? {}),
      })),
    };
  };

  const allFacts = QUICK_HARD_GATE_SIGNALS.map((signal, index) => ({
    id: `PF-${String(index + 1).padStart(2, '0')}`,
    signal,
    value: signal === 'failed_quick_repairs' ? 2 : true,
    basis,
  }));
  const enrichedAll = enrichDeterministicProbe({
    probe: probeRepository({ repositoryRoot: root }),
    enrichment: buildEnrichment(allFacts),
    rawPrompt,
    repositoryBaseline: baseline,
  });
  assert.equal(enrichedAll.semantic_facts.length, 18);
  assert.equal(enrichedAll.acquisition.method, 'evidence_bound_semantic_assessment');
  assert.equal(enrichedAll.acquisition.assessed_quick_gates.length, 18);
  assert.equal(enrichedAll.signals.failed_quick_repairs, 2);
  assertRuntimeProbeReady(enrichedAll, { rawPrompt, repositoryBaseline: baseline });

  for (const [index, signal] of QUICK_HARD_GATE_SIGNALS.entries()) {
    const probe = enrichDeterministicProbe({
      probe: probeRepository({ repositoryRoot: root }),
      enrichment: buildEnrichment([{
        id: `PF-${String(index + 1).padStart(2, '0')}`,
        signal,
        value: signal === 'failed_quick_repairs' ? 2 : true,
        basis,
      }]),
      rawPrompt,
      repositoryBaseline: baseline,
    });
    const admission = applyQuickPromotion({
      selectedSkill: 'quick',
      proposedRoute: 'quick',
      probe,
      classifier: classifierOutput(),
    });
    if (signal === 'failed_quick_repairs') {
      assert.equal(admission.route, 'quick', signal);
      assert.deepEqual(admission.promotion_reasons, []);
    } else {
      assert.notEqual(admission.route, 'quick', signal);
      assert.deepEqual(admission.promotion_reasons, [signal]);
    }
  }
});

test('semantic enrichment rejects incomplete assessment and unverified prompt or repository bytes', async () => {
  const root = await gitRepository();
  const rawPrompt = 'Touch the known private helper.\n';
  const baseline = captureRepositoryBaseline(root);
  const promptBytes = Buffer.from(rawPrompt, 'utf8');
  const promptBasis = [{
    kind: 'prompt_span',
    locator: `bytes:0:${promptBytes.length}`,
    sha256: createHash('sha256').update(promptBytes).digest('hex'),
  }];
  const base = {
    schema_version: 1,
    prompt_sha256: sha256Prompt(rawPrompt),
    repository_baseline_digest: repositoryBaselineDigest(baseline),
    assessed_quick_gates: [...QUICK_HARD_GATE_SIGNALS],
    facts: QUICK_HARD_GATE_SIGNALS.map((signal, index) => ({
      id: `PF-${String(index + 1).padStart(2, '0')}`,
      signal,
      value: signal === 'failed_quick_repairs' ? 0 : false,
      basis: promptBasis,
    })),
  };
  assert.throws(() => enrichDeterministicProbe({
    probe: probeRepository({ repositoryRoot: root }),
    enrichment: { ...base, assessed_quick_gates: QUICK_HARD_GATE_SIGNALS.slice(1) },
    rawPrompt,
    repositoryBaseline: baseline,
  }), /exact ordered 17 semantic gates plus repair-history telemetry/);
  assert.throws(() => enrichDeterministicProbe({
    probe: probeRepository({ repositoryRoot: root }),
    enrichment: { ...base, prompt_sha256: '0'.repeat(64) },
    rawPrompt,
    repositoryBaseline: baseline,
  }), /does not match immutable Origin/);
  assert.throws(() => enrichDeterministicProbe({
    probe: probeRepository({ repositoryRoot: root }),
    enrichment: { ...base, facts: [] },
    rawPrompt,
    repositoryBaseline: baseline,
  }), /exactly 17 semantic gates plus repair-history telemetry|at least 18/u);
  assert.throws(() => enrichDeterministicProbe({
    probe: probeRepository({ repositoryRoot: root }),
    enrichment: {
      ...base,
      facts: [...base.facts, {
        id: 'PF-19',
        signal: 'durable_continuation_required',
        value: true,
        basis: promptBasis,
      }],
    },
    rawPrompt,
    repositoryBaseline: baseline,
  }), /at most 18|Quick hard gate/u);
  assert.throws(() => enrichDeterministicProbe({
    probe: probeRepository({ repositoryRoot: root }),
    enrichment: { ...base, facts: [...base.facts].reverse() },
    rawPrompt,
    repositoryBaseline: baseline,
  }), /must preserve PF-01\/public_api_change/u);
  assert.throws(() => enrichDeterministicProbe({
    probe: probeRepository({ repositoryRoot: root }),
    enrichment: {
      ...base,
      facts: base.facts.map((fact, index) => ({
        ...fact,
        id: `PF-${String(index + 81).padStart(2, '0')}`,
      })),
    },
    rawPrompt,
    repositoryBaseline: baseline,
  }), /must preserve PF-01\/public_api_change/u);
  assert.throws(() => enrichDeterministicProbe({
    probe: probeRepository({ repositoryRoot: root }),
    enrichment: {
      ...base,
      facts: base.facts.map((fact) => fact.signal === 'dependency_change'
        ? {
          ...fact,
          value: true,
          basis: [{
          kind: 'repository_file',
          locator: 'app.txt',
          sha256: '0'.repeat(64),
          }],
        }
        : fact),
    },
    rawPrompt,
    repositoryBaseline: baseline,
  }), /does not match app.txt/);
  assert.throws(() => enrichDeterministicProbe({
    probe: probeRepository({
      repositoryRoot: root,
      budgets: { semantic_evidence_file_max_bytes: 3 },
    }),
    enrichment: {
      ...base,
      facts: base.facts.map((fact) => fact.signal === 'dependency_change'
        ? {
          ...fact,
          value: true,
          basis: [{
            kind: 'repository_file',
            locator: 'app.txt',
            sha256: createHash('sha256').update('stable\n').digest('hex'),
          }],
        }
        : fact),
    },
    rawPrompt,
    repositoryBaseline: baseline,
  }), /exceeds 3 bytes/);
});

test('deterministic prompt semantics activate OAuth and public API gates when verdicts omit them', async () => {
  const root = await gitRepository();
  const rawPrompt = 'Add OAuth authorization and remove the exported API method.\n';
  const bytes = Buffer.from(rawPrompt, 'utf8');
  const baseline = captureRepositoryBaseline(root);
  const basis = [{
    kind: 'prompt_span',
    locator: `bytes:0:${bytes.length}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }];
  const probe = enrichDeterministicProbe({
    probe: probeRepository({ repositoryRoot: root }),
    enrichment: {
      schema_version: 1,
      prompt_sha256: sha256Prompt(rawPrompt),
      repository_baseline_digest: repositoryBaselineDigest(baseline),
      assessed_quick_gates: [...QUICK_HARD_GATE_SIGNALS],
      facts: QUICK_HARD_GATE_SIGNALS.map((signal, index) => ({
        id: `PF-${String(index + 1).padStart(2, '0')}`,
        signal,
        value: signal === 'failed_quick_repairs' ? 0 : false,
        basis,
      })),
    },
    rawPrompt,
    repositoryBaseline: baseline,
  });
  assert.equal(probe.signals.authentication_or_authorization, true);
  assert.equal(probe.signals.public_api_change, true);
  assert.deepEqual(probe.acquisition.prompt_derived_signals, [
    'authentication_or_authorization',
    'public_api_change',
  ]);
  const admission = applyQuickPromotion({
    selectedSkill: 'quick',
    proposedRoute: 'quick',
    probe,
    classifier: classifierOutput(),
  });
  assert.equal(admission.route, 'goal');
  assert.deepEqual(admission.promotion_reasons, [
    'authentication_or_authorization',
    'public_api_change',
  ]);
});

test('prompt gates distinguish text-only documentation vocabulary from product mutations', () => {
  assert.deepEqual(
    derivePromptGateSignals('Fix the typo in the OAuth login documentation.'),
    [],
  );
  assert.deepEqual(
    derivePromptGateSignals('Correct the spelling in the public API docs.'),
    [],
  );
  assert.deepEqual(
    derivePromptGateSignals('Update the OAuth documentation for clarity.'),
    [],
  );
  assert.deepEqual(
    derivePromptGateSignals('Fix a typo in README about the data migration and release process.'),
    [],
  );
  assert.deepEqual(
    derivePromptGateSignals('Clarify the dependency injection wording in the documentation.'),
    [],
  );
  assert.deepEqual(
    derivePromptGateSignals('Add OAuth authorization to the login flow.'),
    ['authentication_or_authorization'],
  );
  assert.deepEqual(
    derivePromptGateSignals('Remove the exported API method.'),
    ['public_api_change'],
  );
  assert.deepEqual(
    derivePromptGateSignals('Add OAuth authorization and fix a typo in the login docs.'),
    ['authentication_or_authorization'],
  );
  assert.deepEqual(
    derivePromptGateSignals('Fix a typo in the migration docs and update the release pipeline.'),
    ['build_deployment_packaging_release_or_ci'],
  );
  assert.deepEqual(
    derivePromptGateSignals('Fix the README typo and deploy to production.'),
    ['build_deployment_packaging_release_or_ci'],
  );
  assert.deepEqual(
    derivePromptGateSignals('Fix the docs wording and install a dependency.'),
    ['dependency_change'],
  );
});

test('classification uses Luna once when confident and never spends a retry', async () => {
  const calls = [];
  const result = await classifyRoute({
    selectedSkill: 'quick',
    rawPrompt: 'Make the known small change.',
    probe: createDeterministicProbe(),
    modelCatalog: modelCatalog(),
    classify(request) {
      calls.push(request);
      return classifierOutput({ confidence: 0.85 });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model_policy.requested.tier, 'luna');
  assert.equal(calls[0].model_policy.resolved.model_id, MODEL_IDS.luna);
  assert.equal(calls[0].exact_raw_request, 'Make the known small change.');
  assert.equal(result.selected_route, 'quick');
  assert.equal(result.recommended_level, 2);
  assert.equal(result.retry_classifier, null);
});

test('low confidence retries exactly once with Terra and persistent uncertainty honors selection', async () => {
  const calls = [];
  const result = await classifyRoute({
    selectedSkill: 'build',
    rawPrompt: 'Develop this milestone foundation.',
    probe: createDeterministicProbe({ likelySymbols: ['render'] }),
    modelCatalog: modelCatalog(),
    classify(request) {
      calls.push(request);
      return calls.length === 1
        ? classifierOutput({ route: 'goal', confidence: 0.4, ambiguity: 'high' })
        : classifierOutput({ route: 'research', confidence: 0.7, ambiguity: 'medium' });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].model_policy.requested.tier, 'terra');
  assert.deepEqual(calls[1].previous_classifier_output, calls.length ? result.initial_classifier.output : null);
  assert.equal(calls[1].hidden_chain_of_thought.includes('not provided'), true);
  assert.equal(result.uncertain, true);
  assert.equal(result.selected_route, 'build');
});

test('Quick hard gates promote deterministically while file count alone never decides', async () => {
  const publicApi = await classifyRoute({
    selectedSkill: 'quick',
    rawPrompt: 'Make the known change.',
    probe: createDeterministicProbe({ signals: { public_api_change: true } }),
    modelCatalog: modelCatalog(),
    classify: () => classifierOutput(),
  });
  assert.equal(publicApi.selected_route, 'goal');
  assert.deepEqual(publicApi.promotion_reasons, ['public_api_change']);

  const unknownCause = await classifyRoute({
    selectedSkill: 'quick',
    rawPrompt: 'Make the known change.',
    probe: createDeterministicProbe({ signals: { root_cause_unknown: true } }),
    modelCatalog: modelCatalog(),
    classify: () => classifierOutput(),
  });
  assert.equal(unknownCause.selected_route, 'debug');

  const repairHistoryAlone = await classifyRoute({
    selectedSkill: 'quick',
    rawPrompt: 'Make the known change.',
    probe: createDeterministicProbe({ signals: { failed_quick_repairs: 2 } }),
    modelCatalog: modelCatalog(),
    classify: () => classifierOutput(),
  });
  assert.equal(repairHistoryAlone.selected_route, 'quick');
  assert.deepEqual(repairHistoryAlone.promotion_reasons, []);

  const uncertainRepair = await classifyRoute({
    selectedSkill: 'quick',
    rawPrompt: 'Make the known change.',
    probe: createDeterministicProbe({
      signals: { failed_quick_repairs: 5, root_cause_unknown: true },
    }),
    modelCatalog: modelCatalog(),
    classify: () => classifierOutput(),
  });
  assert.equal(uncertainRepair.selected_route, 'debug');
  assert.deepEqual(uncertainRepair.promotion_reasons, ['root_cause_unknown']);

  const largeButOtherwiseKnown = await classifyRoute({
    selectedSkill: 'quick',
    rawPrompt: 'Make the known change.',
    probe: createDeterministicProbe(),
    modelCatalog: modelCatalog(),
    classify: () => classifierOutput({ estimated_files: 5_000, estimated_diff_lines: 50_000 }),
  });
  assert.equal(largeButOtherwiseKnown.selected_route, 'quick');
  assert.deepEqual(largeButOtherwiseKnown.promotion_reasons, []);
});

test('classifier schema rejects prose, extra fields, and hidden reasoning disclosure', () => {
  assert.throws(() => normalizeClassifierOutput('quick because it is easy'), /structured object/);
  assert.throws(
    () => normalizeClassifierOutput({ ...classifierOutput(), extra: true }),
    /extra is not allowed/,
  );
  assert.throws(
    () => normalizeClassifierOutput({ ...classifierOutput(), chain_of_thought: 'secret' }),
    /must not contain hidden reasoning/,
  );
  assert.throws(
    () => normalizeClassifierOutput({ ...classifierOutput(), recommended_level: 1 }),
    /recommended_level/,
  );
  assert.throws(
    () => normalizeClassifierOutput({ ...classifierOutput(), recommended_level: 8 }),
    /recommended_level/,
  );
});

test('model policy maps Luna/Terra/Sol IDs, degrades truthfully, and permits reviewed escalation histories', () => {
  const exact = resolveModelPolicy({
    stage: 'research_synthesis_and_recommendation',
    catalog: modelCatalog(),
  });
  assert.deepEqual(exact.requested, {
    tier: 'terra',
    model_id: MODEL_IDS.terra,
    reasoning_effort: 'xhigh',
  });
  assert.equal(exact.resolved.model_id, MODEL_IDS.terra);
  assert.equal(exact.resolved.reasoning_effort, 'xhigh');
  assert.equal(exact.degraded, false);
  assert.deepEqual(modelRequestOptions(exact), {
    model: MODEL_IDS.terra,
    reasoningEffort: 'xhigh',
  });

  const withoutLuna = modelCatalog().slice(1);
  const degraded = resolveModelPolicy({
    stage: 'initial_classification',
    catalog: withoutLuna,
  });
  assert.equal(degraded.requested.model_id, MODEL_IDS.luna);
  assert.equal(degraded.resolved.model_id, MODEL_IDS.terra);
  assert.equal(degraded.resolved.source, 'catalog_default');
  assert.equal(degraded.degraded, true);
  assert.match(degraded.degradation_reasons[0], /unavailable/);

  const first = resolveModelPolicy({
    stage: 'quick_implementation',
    catalog: modelCatalog(),
  });
  const second = escalateModelPolicy(first, {
    catalog: modelCatalog(),
    reason: 'one soft execution failure',
  });
  assert.equal(second.requested.tier, 'sol');
  assert.equal(second.attempt_number, 2);
  assert.equal(second.escalation_reason, 'one soft execution failure');
  const third = escalateModelPolicy(second, {
    catalog: modelCatalog(),
    reason: 'second evidenced soft execution failure',
  });
  assert.equal(third.requested.tier, 'sol');
  assert.equal(third.requested.reasoning_effort, 'ultra');
  assert.equal(third.attempt_number, 3);
  const fourth = escalateModelPolicy(third, {
    catalog: modelCatalog(),
    reason: 'third evidenced soft execution failure',
  });
  assert.equal(fourth.requested.reasoning_effort, 'max');
  assert.equal(fourth.attempt_number, 4);
});

test('model/list validation requires the complete app-server catalog shape', () => {
  assert.equal(normalizeModelCatalog(modelCatalog()).length, 3);
  const invalid = modelCatalog();
  delete invalid[0].model;
  assert.throws(() => normalizeModelCatalog(invalid), /missing model/);
});
