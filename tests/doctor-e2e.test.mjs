import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync, realpathSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { runRuntimeCli } from '../scripts/cruise-runtime.mjs';

import {
  answerDoctorServerRequest,
  bindDoctorWorkerInvocations,
  captureDoctorWorkerCompletionEvidence,
  createDoctorCanaryPrompt,
  createDoctorRuntimeHostGate,
  createDoctorTurnController,
  deepSmokeCollaborationMode,
  deepSmokeResponseMatches,
  createDeepDoctorSmokePrompt,
  deepSmokeClientMetadata,
  DEEP_DOCTOR_SKILL_TIMEOUT_MS,
  DEEP_DOCTOR_SMOKE_CASES,
  DEFAULT_DOCTOR_FIXTURE,
  discoverInstalledCruiseSkills,
  discoverRepositorySpatiomicsSkill,
  DOCTOR_DEBUG_REPAIRED_TEST,
  DOCTOR_SKILL_CASES,
  evaluateDoctorSkillResult,
  hasNativeApprovalSequence,
  hasNativeBuildApproval,
  hasNativeExactApproval,
  hasNativeGoalApprovals,
  hasNativeGoalControlUpdate,
  hasNativeRefineApproval,
  inspectDoctorScenarioOutcome,
  inspectDoctorWorkflowProof,
  isCruiseWorkerCommand,
  parseDoctorRuntimeInvocation,
  parseDoctorRuntimeHostInvocation,
  parseCruiseWorkerInvocation,
  parseDeepDoctorSmokeResponse,
  runDeepDoctor,
  runInstalledSkillSmokeTests,
  runTroubleshootDoctor,
  runSkillTurn,
  selectDoctorRootModel,
  selectDoctorSmokeModel,
  stageInstalledPlugin,
  validateDoctorFixture,
} from '../scripts/lib/doctor-e2e.mjs';
import { createEvidenceItem, createEvidenceRecord } from '../scripts/lib/evidence.mjs';
import {
  createForeignDiffGuard,
  foreignDiffAuthorityPath,
  readForeignDiffGuardState,
} from '../scripts/lib/foreign-diff-guard.mjs';
import { captureRepositoryBaseline, createOriginRecord } from '../scripts/lib/origin.mjs';
import {
  deterministicProbeDigest,
  enrichDeterministicProbe,
  probeRepository,
  repositoryBaselineDigest,
} from '../scripts/lib/routing.mjs';
import { createRunState, transitionRunState } from '../scripts/lib/run-state.mjs';
import {
  createProbeEnrichmentTemplate,
  createSemanticMappingPacket,
} from '../scripts/lib/semantic-mapping-packet.mjs';
import { WorkerSessionError } from '../scripts/lib/worker-session.mjs';
import { readYamlFile, writeYamlFile } from '../scripts/lib/yaml-state.mjs';

const START = '2026-07-15T01:00:00.000Z';
const ROUTED = '2026-07-15T01:00:01.000Z';
const EXECUTING = '2026-07-15T01:00:02.000Z';
const COMPLETED = '2026-07-15T01:00:03.000Z';
const DOCTOR_WORKER_EXECUTABLE = '/doctor-attested/cruise.mjs';
const TEST_PACKET_SHA256 = 'a'.repeat(64);
const TEST_RUNTIME_ARGV_SHA256 = 'b'.repeat(64);

function terminalState(skill, runId = `doctor-${skill}`, status = 'completed') {
  let state = createRunState({ runId, selectedSkill: skill, now: START });
  state = transitionRunState(state, { status: 'routed', reason: 'route selected', at: ROUTED });
  state = transitionRunState(state, { status: 'executing', reason: 'execution started', at: EXECUTING });
  return transitionRunState(state, { status, reason: `workflow ${status}`, at: COMPLETED });
}

function terminalEvidence(runId, status = 'PASS') {
  const final = createEvidenceItem({
    id: 'E-01',
    gate: 'mandatory',
    scope: 'final_verification',
    status,
    performed: true,
    procedure: 'Compare the immutable origin, normalized contract, actual output, and worker report.',
    command: 'node --test tests/spatiomics-fixture.test.mjs',
    expected: 'The requested fixture-local outcome and focused verification pass.',
    actual: status === 'PASS'
      ? 'The requested fixture-local outcome and focused verification passed.'
      : 'The requested fixture-local outcome remained blocked.',
    identity: { source: 'fixture', build: 'test', environment: 'isolated Doctor repository' },
    startedAt: EXECUTING,
    finishedAt: COMPLETED,
    supports: ['AC-01'],
  });
  return createEvidenceRecord({
    runId,
    recordedAt: START,
    items: [final],
    finalVerification: {
      verifier: 'fresh Doctor verifier',
      performedAt: COMPLETED,
      originCompared: true,
      normalizedContractCompared: true,
      actualChangesOrOutputsCompared: true,
      taskCompletionOnly: false,
      evidenceIds: ['E-01'],
    },
  });
}

async function writeCompletedDoctorRun(root, skill, { routeRecommendedLevel = 2 } = {}) {
  await mkdir(join(root, '.cruise'), { recursive: true });
  await writeYamlFile(join(root, '.cruise', 'repo.yaml'), {
    schema_version: 1,
    kind: 'cruise_repository_name',
    name: 'doctor-repo',
    repository_root: await realpath(root),
    assigned_by: 'cruise_l1',
    worker_level: 1,
  });
  const runId = `doctor-${skill}`;
  const run = join(root, '.cruise', 'runs', runId);
  const rawPrompt = `Doctor ${skill} canary.`;
  const baseline = captureRepositoryBaseline(root);
  const baselineDigest = repositoryBaselineDigest(baseline);
  const promptSha256 = createHash('sha256').update(rawPrompt).digest('hex');
  const pendingProbe = probeRepository({ repositoryRoot: root });
  const semanticFacts = createProbeEnrichmentTemplate({
    promptSha256,
    repositoryBaselineDigest: baselineDigest,
  });
  const probe = enrichDeterministicProbe({
    probe: pendingProbe,
    enrichment: semanticFacts,
    rawPrompt,
    repositoryBaseline: baseline,
  });
  const origin = createOriginRecord({
    rawPrompt,
    selectedSkill: skill,
    repositoryBaseline: baseline,
    deterministicProbeDigest: deterministicProbeDigest(probe),
    initialClassifier: 'gpt-test medium',
    selectedRoute: skill,
    confidence: 0.95,
    capturedAt: START,
  });
  const mappingPacket = createSemanticMappingPacket({
    runDirectory: run,
    repositoryRoot: baseline.root,
    promptSha256,
    repositoryBaselineDigest: baselineDigest,
  });
  const classifierOutput = {
    route: skill,
    recommended_level: routeRecommendedLevel,
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
  };
  const attempt = {
    policy: {
      resolved: { model_id: 'gpt-test', reasoning_effort: 'medium' },
    },
    output: classifierOutput,
  };
  const route = {
    schema_version: 1,
    selected_skill: skill,
    selected_route: skill,
    classifier_route: skill,
    recommended_level: routeRecommendedLevel,
    confidence: 0.95,
    ambiguity: 'low',
    semantic_risk: 'low',
    uncertain: false,
    deterministic_probe_digest: deterministicProbeDigest(probe),
    initial_classifier: attempt,
    retry_classifier: null,
    attempts: [attempt],
    promotion_reasons: [],
  };
  await mkdir(run, { recursive: true });
  await writeYamlFile(join(run, 'origin.yaml'), origin);
  await writeYamlFile(join(run, 'probe.yaml'), probe);
  await writeYamlFile(join(run, 'map-pkt.yaml'), mappingPacket);
  await writeYamlFile(join(run, 'map-facts.yaml'), semanticFacts);
  await writeYamlFile(join(run, 'route.yaml'), route);
  await writeYamlFile(join(run, 'state.yaml'), terminalState(skill, runId));
  await writeYamlFile(join(run, 'evidence.yaml'), terminalEvidence(runId));
  const substantivePacket = 'task_id: T-01\nread_paths: []\nwrite_paths: []\n';
  await writeFile(join(run, 'work-pkt.yaml'), substantivePacket);
  const report = ({ packetSha256, suffix }) => ({
    schema_version: 1,
    kind: 'cruise_app_server_worker_report',
    launch: {
      recommended_level: 2,
      agent_type: 'cruise_l2',
      resolved: { model: 'gpt-test', reasoning_effort: 'medium' },
      packet_sha256: packetSha256,
      extension_policy: {
        profile: 'worker',
        plugins: 'inherited',
        apps: 'inherited',
        mcp_servers: 'inherited',
        native_guardrails: 'inherited',
        disabled_mcp_servers: [],
      },
    },
    model_output: 'ok',
    runtime: {
      thread_id: `thread-${skill}-${suffix}`,
      turn_id: `turn-${skill}-${suffix}`,
      status: 'completed',
    },
  });
  await writeYamlFile(join(run, 'map-rpt.yaml'), report({
    packetSha256: createHash('sha256')
      .update(await readFile(join(run, 'map-pkt.yaml')))
      .digest('hex'),
    suffix: 'mapping',
  }));
  await writeYamlFile(join(run, 'work-rpt.yaml'), report({
    packetSha256: createHash('sha256').update(substantivePacket).digest('hex'),
    suffix: 'substantive',
  }));
  if (skill === 'quick') {
    await writeFile(join(root, 'doctor-ok.txt'), 'Cruise Doctor quick probe passed.\n');
  } else if (skill === 'build') {
    await mkdir(join(root, '.cruise', 'project'), { recursive: true });
    await mkdir(join(root, '.cruise', 'milestones', 'M-001-doctor'), { recursive: true });
    const contract = '# Spatiomics milestone\n\nUse spatiomics-skill, inspect_spatial_inputs.py, and digest-bound fixture validation.\n';
    await writeFile(join(root, '.cruise', 'project', 'PROJECT.md'), contract);
    await writeFile(join(root, '.cruise', 'milestones', 'M-001-doctor', 'MILESTONE.md'), contract);
  } else if (skill === 'refine') {
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(
      join(root, 'docs', 'refine-ok.md'),
      '# Verified\n\nUse inspect_spatial_inputs.py for structural triage and semantic fixture validation separately.\n',
    );
  } else if (skill === 'goal') {
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(
      join(root, 'docs', 'DOCTOR-GOAL.md'),
      '# Verified\n\nCheckpoint inspect_spatial_inputs.py, the fixture test, and provenance review.\n',
    );
  } else if (skill === 'debug') {
    await writeFile(
      join(root, 'tests', 'fail.test.mjs'),
      DOCTOR_DEBUG_REPAIRED_TEST,
    );
  } else if (skill === 'research') {
    await writeFile(
      join(run, 'RESEARCH.md'),
      '# Research\n\nThe spatiomics-skill uses inspect_spatial_inputs.py and distinguishes STOmics GEF from Zarr GEFF.\n',
    );
  }
  const foreignDiffStatePath = join(run, 'drift.yaml');
  await createForeignDiffGuard({
    statePath: foreignDiffStatePath,
    runId,
    repositoryRoot: root,
    originPromptSha256: promptSha256,
    repositoryBaselineDigest: baselineDigest,
    now: START,
  });
}

function completedWorkerCommand(root, skill, overrides = {}) {
  const { executable = 'cruise', ...recordOverrides } = overrides;
  const run = join(root, '.cruise', 'runs', `doctor-${skill}`);
  const packet = join(run, 'work-pkt.yaml');
  const report = join(run, 'work-rpt.yaml');
  const packetSha256 = createHash('sha256').update(readFileSync(packet)).digest('hex');
  const command = `${executable} worker --level 2 -C ${root} --packet ${packet} --packet-sha256 ${packetSha256} --report ${report}`;
  return {
    command,
    status: 'completed',
    exitCode: 0,
    output: '',
    completionEvidence: captureDoctorWorkerCompletionEvidence({
      root,
      command,
      workerExecutable: executable,
      skill,
    }),
    ...recordOverrides,
  };
}

function completedMappingWorkerCommand(root, skill, overrides = {}) {
  const { executable = 'cruise', ...recordOverrides } = overrides;
  const run = join(root, '.cruise', 'runs', `doctor-${skill}`);
  const packet = join(run, 'map-pkt.yaml');
  const report = join(run, 'map-rpt.yaml');
  const packetSha256 = createHash('sha256').update(readFileSync(packet)).digest('hex');
  const command = `${executable} worker --level 2 -C ${root} --packet ${packet} --packet-sha256 ${packetSha256} --report ${report}`;
  return {
    command,
    status: 'completed',
    exitCode: 0,
    output: '',
    completionEvidence: captureDoctorWorkerCompletionEvidence({
      root,
      command,
      workerExecutable: executable,
      skill,
    }),
    ...recordOverrides,
  };
}

function completedWorkerCommands(root, skill, executable = 'cruise') {
  return [
    completedMappingWorkerCommand(root, skill, { executable }),
    completedWorkerCommand(root, skill, { executable }),
  ];
}

function completedRuntimeCommand(root, skill, installedPluginRoot, overrides = {}) {
  const runtimePath = join(installedPluginRoot, 'scripts', 'cruise-runtime.mjs');
  const runDirectory = join(root, '.cruise', 'runs', `doctor-${skill}`);
  return {
    command: `${realpathSync(process.execPath)} ${runtimePath} begin --skill ${skill} --root ${root} --prompt-file ${join(runDirectory, 'prompt.txt')}`,
    status: 'completed',
    exitCode: 0,
    output: '',
    hostExecutionBinding: {
      itemId: 'doctor-runtime-begin',
      argvSha256: TEST_RUNTIME_ARGV_SHA256,
      runtimeSubcommand: 'begin',
    },
    ...overrides,
  };
}

function completedDoctorCommands(root, skill, executable, installedPluginRoot) {
  return [
    completedRuntimeCommand(root, skill, installedPluginRoot),
    ...completedWorkerCommands(root, skill, executable),
  ];
}

function completedScenarioOutcome(root, skill) {
  return {
    ok: true,
    artifacts: completedWorkerCommand(root, skill).completionEvidence.scenario_artifacts,
  };
}

function completedApprovals(skill) {
  const runtimeHostPath = {
    method: 'item/commandExecution/requestApproval',
    worker: false,
    doctorRuntimeHostPath: true,
    runtimeSubcommand: 'begin',
    itemId: 'doctor-runtime-begin',
    argvSha256: TEST_RUNTIME_ARGV_SHA256,
    phase: 'draft',
  };
  if (skill === 'build') {
    return [runtimeHostPath, {
      method: 'item/tool/requestUserInput',
      answers: { review: { answers: ['Approve Milestone'] } },
      worker: false,
      phase: 'approval',
    }];
  }
  if (skill === 'refine') {
    return [runtimeHostPath, {
      method: 'item/tool/requestUserInput',
      answers: { review: { answers: ['Approve Plan'] } },
      worker: false,
      phase: 'plan-approval',
    }];
  }
  if (skill === 'goal') {
    return [
      runtimeHostPath,
      {
        method: 'item/tool/requestUserInput',
        answers: { needs: { answers: ['Reject all'] } },
        worker: false,
        phase: 'plan-draft',
      },
      {
        method: 'item/tool/requestUserInput',
        answers: { combined_review: { answers: ['Approve both'] } },
        worker: false,
        phase: 'plan-approval',
      },
    ];
  }
  return [runtimeHostPath];
}

test('public deep Doctor fixture is a real skill repository with Cruise state', async () => {
  const fixture = await validateDoctorFixture(DEFAULT_DOCTOR_FIXTURE);
  assert.equal(fixture.files.includes('.cruise/README.md'), true);
  assert.equal(fixture.files.includes('.agents/skills/spatiomics-skill/SKILL.md'), true);
  assert.equal(fixture.files.includes('.agents/skills/spatiomics-skill/references/formats.md'), true);
  assert.equal(fixture.files.includes('.agents/skills/spatiomics-skill/references/tools.md'), true);
  assert.equal(fixture.files.includes('workflow/Snakefile'), true);
  assert.deepEqual(DOCTOR_SKILL_CASES.map(({ skill }) => skill), [
    'build',
    'quick',
    'refine',
    'goal',
    'debug',
  ]);
});

test('Deep Doctor smoke manifest is five focused probes with a fixed one-minute per-skill bound', () => {
  assert.equal(DEEP_DOCTOR_SKILL_TIMEOUT_MS, 60_000);
  assert.deepEqual(
    DEEP_DOCTOR_SMOKE_CASES.map(({ skill }) => skill),
    ['build', 'quick', 'refine', 'goal', 'debug'],
  );
  for (const scenario of DEEP_DOCTOR_SMOKE_CASES) {
    assert.equal(scenario.tests.length >= 1 && scenario.tests.length <= 2, true, scenario.skill);
    assert.match(createDeepDoctorSmokePrompt(scenario), /read-only/u);
    assert.doesNotMatch(createDeepDoctorSmokePrompt(scenario), /expected.*(?:true|false)/iu);
  }
});

test('Deep Doctor smoke parser tolerates JSON fencing but rejects prose', () => {
  assert.deepEqual(
    parseDeepDoctorSmokeResponse('```json\n{"skill":"quick"}\n```'),
    { skill: 'quick' },
  );
  assert.throws(
    () => parseDeepDoctorSmokeResponse('Result: {"skill":"quick"}'),
    /not one JSON object/u,
  );
});

test('Deep Doctor accepts only the documented full Build auto-approval directive equivalent', () => {
  const expected = {
    skill: 'cruise:build',
    approval_labels: ['Approve Foundation', 'Approve Milestone'],
    auto_approval_directive: '--auto-approve',
    implements_product_code: false,
  };
  assert.equal(deepSmokeResponseMatches({
    ...expected,
    auto_approval_directive: '$cruise:build --auto-approve',
  }, expected), true);
  assert.equal(deepSmokeResponseMatches({
    ...expected,
    auto_approval_directive: '$cruise:build --auto-approve --extra',
  }, expected), false);
});

test('Deep Doctor serializes every app-server metadata value as a string', () => {
  assert.deepEqual(deepSmokeClientMetadata({ skill: 'build', sequence: 1 }), {
    cruise_doctor_profile: 'deep-smoke',
    cruise_doctor_skill: 'build',
    cruise_doctor_sequence: '1',
  });
  assert.throws(
    () => deepSmokeClientMetadata({ skill: 'build', sequence: 0 }),
    /positive sequence number/u,
  );
});

test('Deep Doctor uses native read-only plan mode for static skill probes', () => {
  assert.deepEqual(deepSmokeCollaborationMode({
    model: 'gpt-5.6-luna',
    reasoningEffort: 'medium',
  }), {
    mode: 'plan',
    settings: {
      model: 'gpt-5.6-luna',
      reasoning_effort: 'medium',
      developer_instructions: [
        'This is an isolated, read-only Cruise Doctor compatibility probe.',
        'Do not initiate a Cruise workflow, inspect the workspace, use a tool, change state, or ask a question.',
        'Answer only the attached skill contract question, in exactly the format requested by the user message.',
      ].join('\n'),
    },
  });
  assert.throws(
    () => deepSmokeCollaborationMode({ model: 'gpt-5.6-luna', reasoningEffort: null }),
    /reasoning effort/u,
  );
});

test('Deep Doctor installed smoke selections execute every exact high-signal test', () => {
  for (const scenario of DEEP_DOCTOR_SMOKE_CASES) {
    const result = runInstalledSkillSmokeTests({
      installedPluginRoot: resolve('.'),
      scenario,
      timeoutMs: 60_000,
    });
    assert.equal(result.ok, true, scenario.skill);
    assert.equal(result.tests.length, scenario.tests.length);
  }
});

test('Deep Doctor orchestrates all five probes through one shared conversation', async (t) => {
  let calls = 0;
  const progress = [];
  const report = await runDeepDoctor({
    installedPluginRoot: resolve('.'),
    onProgress(message) {
      progress.push(message);
    },
    async runConversation({ installedPluginRoot, scenarios, timeoutMs, onProgress }) {
      calls += 1;
      assert.match(installedPluginRoot, /\.plugin-snap\/cruise$/u);
      assert.equal(timeoutMs, 60_000);
      const results = scenarios.map((scenario) => {
        onProgress(`deep Doctor: ${scenario.skill}`);
        return Object.freeze({
          skill: scenario.skill,
          ok: true,
          duration_ms: 10,
          target_ms: 15_000,
          target_met: true,
          detail: 'semantic and deterministic smoke passed',
        });
      });
      return Object.freeze({
        thread_id: 'thread-smoke',
        model: 'gpt-5.6-luna',
        reasoning_effort: 'medium',
        results: Object.freeze(results),
      });
    },
  });
  t.after(() => rm(report.workspace, { recursive: true, force: true }));
  assert.equal(calls, 1);
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 6);
  assert.equal(new Set(report.checks.map(({ id }) => id)).size, 6);
  assert.equal(progress.length, 5);
  assert.equal(report.conversation.thread_id, 'thread-smoke');
});

test('deep Doctor stages its pinned snapshot under the manifest version cache directory', async (t) => {
  const codexHome = await mkdtemp(join(tmpdir(), 'cruise-doctor-stage-home-'));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(resolve('.codex-plugin', 'plugin.json'), 'utf8'));
  const staged = await stageInstalledPlugin(codexHome, resolve('.'));
  assert.equal(
    staged,
    await realpath(join(codexHome, 'plugins', 'cache', 'agent-local', 'cruise', manifest.version)),
  );
  assert.equal(
    await readFile(join(staged, 'fixtures', 'doctor', 'repository', 'workflow', 'Snakefile'), 'utf8'),
    await readFile(join(DEFAULT_DOCTOR_FIXTURE, 'workflow', 'Snakefile'), 'utf8'),
  );
});

test('deep Doctor answers structured reviews deterministically', () => {
  const response = answerDoctorServerRequest({
    method: 'item/tool/requestUserInput',
    params: {
      questions: [{
        id: 'review',
        question: 'Approve this exact Plan?',
        options: [
          { label: 'Revise Plan' },
          { label: 'Approve Plan' },
          { label: 'Save inactive' },
        ],
      }],
    },
  }, {
    skill: 'refine',
    context: () => ({ phase: 'plan-approval' }),
  });
  assert.deepEqual(response, { answers: { review: { answers: ['Approve Plan'] } } });
});

test('deep Doctor resolves the bounded Goal-needs envelope before combined review', () => {
  const approvals = [];
  const response = answerDoctorServerRequest({
    method: 'item/tool/requestUserInput',
    params: {
      questions: [{
        id: 'needs',
        question: 'Which Goal-specific needs should this fixture allow?',
        options: [
          { label: 'Approve all' },
          { label: 'Select some' },
          { label: 'Reject all' },
          { label: 'Discuss' },
        ],
      }],
    },
  }, {
    approvals,
    skill: 'goal',
    context: () => ({ phase: 'plan-draft' }),
  });

  assert.deepEqual(response, { answers: { needs: { answers: ['Reject all'] } } });
  assert.equal(hasNativeGoalApprovals(approvals), false);
});

test('deep Doctor accepts only the exact ordered combined Goal review', () => {
  const message = (options) => ({
    method: 'item/tool/requestUserInput',
    params: {
      questions: [{
        id: 'combined',
        question: 'Approve the Plan and Goal together?',
        options,
      }],
    },
  });
  const context = () => ({ phase: 'plan-approval' });
  const exact = [
    { label: 'Approve both' },
    { label: 'Refine' },
    { label: 'Reject both' },
  ];

  assert.deepEqual(
    answerDoctorServerRequest(message(exact), { skill: 'goal', context }),
    { answers: { combined: { answers: ['Approve both'] } } },
  );
  assert.throws(
    () => answerDoctorServerRequest(message([...exact].reverse()), { skill: 'goal', context }),
    /unexpected native structured input/u,
  );
});

test('deep Doctor rejects speculative foreign-diff questions in a clean fixture', () => {
  const approvals = [];
  assert.throws(() => answerDoctorServerRequest({
    method: 'item/tool/requestUserInput',
    params: {
      questions: [{
        id: 'foreign_diff',
        question: 'If Cruise detects foreign repository changes, what restoration ceiling should apply?',
        options: [
          { label: 'Preserve only' },
          { label: 'Allow exact restore' },
        ],
      }],
    },
  }, {
    approvals,
    skill: 'quick',
    context: () => ({ phase: 'single' }),
  }), /unexpected native structured input/u);
  assert.equal(approvals[0].unexpectedStructuredInput, true);
  assert.equal(approvals[0].worker, false);

  assert.throws(() => answerDoctorServerRequest({
    method: 'item/tool/requestUserInput',
    params: {
      questions: [{
        id: 'foreign_diff_recommended',
        question: 'How should Cruise handle foreign repository changes?',
        options: [
          { label: 'Preserve only (Recommended)' },
          { label: 'Allow exact restore' },
        ],
      }],
    },
  }, {
    approvals,
    skill: 'quick',
    context: () => ({ phase: 'single' }),
  }), /unexpected native structured input/u);
  assert.equal(approvals[1].unexpectedStructuredInput, true);
});

test('deep Doctor fails closed on unrelated native questions even without legacy trigger words', () => {
  const approvals = [];
  assert.throws(() => answerDoctorServerRequest({
    method: 'item/tool/requestUserInput',
    params: {
      questions: [{
        id: 'emphasis',
        question: 'Which documentation emphasis should be used?',
        options: [{ label: 'Structural' }, { label: 'Semantic' }],
      }],
    },
  }, {
    approvals,
    skill: 'refine',
    context: () => ({ phase: 'plan-approval' }),
  }), /unexpected native structured input/u);
  assert.equal(approvals[0].unexpectedStructuredInput, true);
  const evaluated = evaluateDoctorSkillResult({
    skill: 'refine',
    result: { status: 'completed', output: '', stderr: '', approvals },
  });
  assert.equal(evaluated.status, 'fail');
  assert.match(evaluated.detail, /unexpected native structured input/u);
});

test('deep Doctor rejects authorization smuggled behind an exact review label', () => {
  const approvals = [];
  assert.throws(() => answerDoctorServerRequest({
    method: 'item/tool/requestUserInput',
    params: {
      questions: [{
        id: 'review',
        question: 'Do you consent to uploading repository files as part of this Plan?',
        options: [{ label: 'Approve Plan' }, { label: 'Cancel' }],
      }],
    },
  }, {
    approvals,
    skill: 'refine',
    context: () => ({ phase: 'plan-approval' }),
  }), /forbidden worker-boundary UX/u);
  assert.equal(approvals[0].forbiddenWorkerUx, true);
  assert.equal(approvals[0].worker, true);
});

test('deep Doctor refuses MCP substitutes for staged native reviews', () => {
  for (const skill of ['build', 'refine', 'goal']) {
    const approvals = [];
    const response = answerDoctorServerRequest({
      method: 'mcpServer/elicitation/request',
      params: {
        serverName: 'cruise-elicitation',
        mode: 'form',
        requestedSchema: { type: 'object', properties: {} },
      },
    }, { approvals, skill });
    assert.equal(response.action, 'decline');
    assert.equal(approvals[0].unexpectedStructuredInput, true);
    const evaluated = evaluateDoctorSkillResult({
      skill,
      result: { status: 'completed', output: '', stderr: '', approvals },
    });
    assert.equal(evaluated.status, 'fail');
    assert.match(evaluated.detail, /unexpected native structured input/u);
  }
});

test('deep Doctor rejects the repository-transmission authorization UX inside structured questions', () => {
  const approvals = [];
  assert.throws(() => answerDoctorServerRequest({
    method: 'item/tool/requestUserInput',
    params: {
      questions: [{
        id: 'authorization',
        question: 'Do you explicitly authorize uploading this bounded repository packet?',
        options: [{ label: 'Continue' }, { label: 'Cancel' }],
      }],
    },
  }, { approvals }), /forbidden worker-boundary UX/u);
  assert.equal(approvals[0].forbiddenWorkerUx, true);
  const evaluated = evaluateDoctorSkillResult({
    skill: 'quick',
    result: {
      status: 'completed',
      output: '',
      stderr: '',
      approvals: [{
        questions: [{ question: 'May I transmit this bounded repository packet?' }],
      }],
    },
  });
  assert.equal(evaluated.status, 'fail');
  assert.match(evaluated.detail, /forbidden worker-boundary UX/u);
});

test('deep Doctor denies and records every unexpected command or file escalation', () => {
  const approvals = [];
  assert.deepEqual(answerDoctorServerRequest({
    method: 'item/commandExecution/requestApproval',
    params: { command: 'curl https://example.invalid' },
  }, { approvals }), { decision: 'decline' });
  assert.deepEqual(answerDoctorServerRequest({
    method: 'item/fileChange/requestApproval',
    params: {},
  }, { approvals }), { decision: 'decline' });
  assert.deepEqual(answerDoctorServerRequest({
    method: 'applyPatchApproval',
    params: {},
  }, { approvals }), { decision: 'denied' });
  assert.equal(approvals.every(({ unexpectedEscalation }) => unexpectedEscalation === true), true);
  const evaluated = evaluateDoctorSkillResult({
    skill: 'quick',
    result: { status: 'completed', output: '', stderr: '', approvals },
  });
  assert.equal(evaluated.status, 'fail');
  assert.match(evaluated.detail, /unexpected command, patch, or file-change escalation/u);
});


test('deep Doctor makes worker-boundary UX a hard Debug incident', () => {
  const result = evaluateDoctorSkillResult({
    skill: 'quick',
    result: {
      status: 'completed',
      output: 'Do you explicitly authorize uploading this bounded repository analysis?',
      stderr: '',
    },
    cruiseFiles: ['runs/quick/origin.yaml'],
  });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /requires Cruise Debug/u);
});

test('deep Doctor allows benign negative network evidence', () => {
  const result = evaluateDoctorSkillResult({
    skill: 'debug',
    result: {
      status: 'failed',
      output: 'No network access was used; all evidence was repository-local.',
      stderr: '',
      approvals: [],
      commands: [],
    },
  });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /turn ended failed/u);
  assert.doesNotMatch(result.detail, /forbidden worker-boundary UX/u);
});

test('deep Doctor does not classify app-server stderr as worker-boundary UX', () => {
  const result = evaluateDoctorSkillResult({
    skill: 'quick',
    result: {
      status: 'failed',
      output: '',
      stderr: 'failed to send remote plugin catalog request to the backend',
      approvals: [],
      commands: [],
    },
  });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /turn ended failed/u);
  assert.doesNotMatch(result.detail, /forbidden worker-boundary UX/u);
});

test('deep Doctor accepts the exact host shell envelope and rejects shell-prefix spoofs', () => {
  assert.equal(isCruiseWorkerCommand('echo cruise worker --level 2 -C . --packet p --report r'), false);
  assert.equal(isCruiseWorkerCommand('true && cruise worker --level 2 -C . --packet p --report r'), false);
  assert.equal(isCruiseWorkerCommand('/tmp/fake/cruise worker --level 2 -C . --packet p --report r'), false);
  assert.equal(isCruiseWorkerCommand(
    "/bin/zsh -lc 'true && cruise worker --level 2 -C . --packet p --report r'",
  ), false);
  assert.deepEqual(parseCruiseWorkerInvocation(
    `cruise worker --level 2 -C . --packet packet.yaml --packet-sha256 ${TEST_PACKET_SHA256} --report report.yaml`,
  ), {
    executable: 'cruise',
    level: 2,
    cwd: '.',
    packet: 'packet.yaml',
    packetSha256: TEST_PACKET_SHA256,
    report: 'report.yaml',
  });
  assert.deepEqual(parseCruiseWorkerInvocation(
    `/bin/zsh -lc 'cruise worker --level 2 -C . --packet packet.yaml --packet-sha256 ${TEST_PACKET_SHA256} --report report.yaml'`,
  ), {
    executable: 'cruise',
    level: 2,
    cwd: '.',
    packet: 'packet.yaml',
    packetSha256: TEST_PACKET_SHA256,
    report: 'report.yaml',
  });
  assert.deepEqual(parseCruiseWorkerInvocation(
    `${DOCTOR_WORKER_EXECUTABLE} worker --level 2 -C . --packet packet.yaml --packet-sha256 ${TEST_PACKET_SHA256} --report report.yaml`,
    { expectedExecutable: DOCTOR_WORKER_EXECUTABLE },
  ), {
    executable: DOCTOR_WORKER_EXECUTABLE,
    level: 2,
    cwd: '.',
    packet: 'packet.yaml',
    packetSha256: TEST_PACKET_SHA256,
    report: 'report.yaml',
  });
  assert.equal(parseCruiseWorkerInvocation(
    `cruise worker --level 2 -C . --packet packet.yaml --packet-sha256 ${TEST_PACKET_SHA256} --report report.yaml`,
    { expectedExecutable: DOCTOR_WORKER_EXECUTABLE },
  ), null);

  const runtimePath = resolve('scripts/cruise-runtime.mjs');
  assert.deepEqual(parseDoctorRuntimeInvocation(
    `node ${runtimePath} begin --skill quick`,
    { expectedRuntimePath: runtimePath },
  ), {
    node: 'node',
    runtimePath,
    subcommand: 'begin',
    args: ['--skill', 'quick'],
  });
  assert.equal(parseDoctorRuntimeInvocation(
    `/bin/zsh -lc 'node ${runtimePath} begin --skill quick'`,
    { expectedRuntimePath: runtimePath },
  )?.subcommand, 'begin');
  assert.equal(parseDoctorRuntimeInvocation(
    'cruise-runtime begin --skill quick',
    { expectedRuntimePath: runtimePath },
  ), null);
  assert.equal(parseDoctorRuntimeInvocation(
    'node /other/cruise-runtime.mjs begin --skill quick',
    { expectedRuntimePath: runtimePath },
  ), null);
});

test('deep Doctor admits only the exact installed runtime begin within its disposable repository', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-doctor-runtime-host-'));
  const promptRoot = await mkdtemp(join(tmpdir(), 'cruise-doctor-runtime-prompt-test-'));
  await cp(DEFAULT_DOCTOR_FIXTURE, root, { recursive: true });
  const canonicalRoot = await realpath(root);
  const presentedRoot = canonicalRoot.startsWith('/private/var/')
    ? canonicalRoot.slice('/private'.length)
    : canonicalRoot;
  const runtimePath = resolve('scripts/cruise-runtime.mjs');
  const nodePath = await realpath(process.execPath);
  const runDirectory = join(presentedRoot, '.cruise', 'runs', 'doctor-quick');
  const promptFile = join(await realpath(promptRoot), 'quick.txt');
  const prompt = '$cruise:quick host authority regression canary\n';
  await writeFile(promptFile, prompt, { mode: 0o400 });
  const promptSha256 = createHash('sha256').update(prompt).digest('hex');
  await mkdir(join(canonicalRoot, '.cruise'), { recursive: true });
  await writeYamlFile(join(canonicalRoot, '.cruise', 'repo.yaml'), {
    schema_version: 1,
    kind: 'cruise_repository_name',
    name: 'doctor-host',
    repository_root: canonicalRoot,
    assigned_by: 'cruise_l1',
    worker_level: 1,
  });
  const command = `/bin/zsh -lc '${nodePath} ${runtimePath} begin --skill quick --root ${presentedRoot} --prompt-file ${promptFile}'`;
  const authorityDirectory = dirname(foreignDiffAuthorityPath(canonicalRoot, 'doctor-quick'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(promptRoot, { recursive: true, force: true }),
    rm(authorityDirectory, { recursive: true, force: true }),
  ]));

  const parsed = parseDoctorRuntimeHostInvocation(command, {
    expectedRuntimePath: runtimePath,
    expectedNodePath: nodePath,
    repositoryRoot: canonicalRoot,
    skill: 'quick',
    promptFile,
  });
  assert.equal(parsed?.subcommand, 'begin');
  assert.equal(parsed?.repositoryRoot, canonicalRoot);
  assert.equal(parsed?.runDirectory, join(canonicalRoot, '.cruise', 'runs', 'doctor-quick'));

  const approvals = [];
  const gate = createDoctorRuntimeHostGate({
    expectedRuntimePath: runtimePath,
    expectedNodePath: nodePath,
    repositoryRoot: canonicalRoot,
    skill: 'quick',
    promptFile,
    promptSha256,
    context: () => ({ threadId: 'thread-1', turnId: 'turn-1', phase: 'capture' }),
  });
  const request = {
    method: 'item/commandExecution/requestApproval',
    params: {
      command,
      cwd: canonicalRoot,
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      approvalId: 'zsh-bridge-callback-1',
      additionalPermissions: {
        fileSystem: { read: [canonicalRoot], write: [canonicalRoot] },
        network: { enabled: false },
      },
      proposedExecpolicyAmendment: [nodePath, runtimePath],
      proposedNetworkPolicyAmendments: [{ host: 'unused.invalid', action: 'allow' }],
      availableDecisions: ['accept', 'decline'],
    },
  };
  assert.equal(gate.authorize({
    ...request,
    params: { ...request.params, cwd: dirname(canonicalRoot) },
  }), null);
  assert.equal(gate.authorize({
    ...request,
    params: { ...request.params, turnId: 'other-turn' },
  }), null);
  assert.equal(gate.authorize({
    ...request,
    params: { ...request.params, networkApprovalContext: { host: 'example.invalid' } },
  }), null);
  assert.equal(gate.authorize({
    ...request,
    params: {
      ...request.params,
      additionalPermissions: { fileSystem: {}, network: { enabled: true } },
    },
  }), null);
  assert.equal(gate.authorize({
    ...request,
    params: { ...request.params, approvalId: '' },
  }), null);
  assert.deepEqual(answerDoctorServerRequest({
    ...request,
  }, {
    approvals,
    skill: 'quick',
    runtimeHostGate: gate,
  }), { decision: 'accept' });
  assert.equal(approvals[0].doctorRuntimeHostPath, true);
  assert.equal(approvals[0].approvalId, 'zsh-bridge-callback-1');
  assert.equal(approvals[0].unexpectedEscalation, undefined);
  assert.equal(gate.authorize({
    ...request,
    params: { ...request.params, itemId: 'parallel-item' },
  }), null);

  await rm(authorityDirectory, { recursive: true, force: true });
  let runtimeOutput = '';
  await runRuntimeCli([
    'begin',
    '--skill', 'quick',
    '--root', presentedRoot,
    '--prompt-file', promptFile,
  ], {
    output: { write(value) { runtimeOutput += value; } },
    runtimeHooks: {
      invokeNameWorker: async () => ({
        launch: {
          recommended_level: 1,
          agent_type: 'cruise_l1',
          resolved: { model: 'gpt-test', reasoning_effort: 'low' },
        },
        model_output: JSON.stringify({ run_name: 'doctor-quick', repo_name: 'doctor-host' }),
      }),
    },
  });
  assert.match(runtimeOutput, /^created /u);
  const binding = gate.bindCompletion({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'item-1',
        type: 'commandExecution',
        command,
        status: 'completed',
        exitCode: 0,
      },
    },
  });
  assert.equal(binding.runtimeSubcommand, 'begin');
  assert.equal(gate.snapshot().beginCompleted, true);
  assert.equal(gate.bindCompletion({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'source-read',
        type: 'commandExecution',
        command: `rg -n routeCommand ${runtimePath}`,
        status: 'completed',
        exitCode: 0,
      },
    },
  }), null);
  const guard = await readForeignDiffGuardState(join(runDirectory, 'drift.yaml'));
  assert.equal(guard.repository_root, canonicalRoot);
  assert.equal(guard.status, 'monitoring');
});

test('deep Doctor rejects runtime host path, option, and authority-scope escapes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-doctor-runtime-scope-'));
  const outside = await mkdtemp(join(tmpdir(), 'cruise-doctor-runtime-outside-'));
  const promptRoot = await mkdtemp(join(tmpdir(), 'cruise-doctor-runtime-prompt-scope-'));
  await mkdir(join(root, '.cruise', 'runs'), { recursive: true });
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
    rm(promptRoot, { recursive: true, force: true }),
  ]));
  const canonicalRoot = await realpath(root);
  const nodePath = await realpath(process.execPath);
  const runtimePath = resolve('scripts/cruise-runtime.mjs');
  const runDirectory = join(canonicalRoot, '.cruise', 'runs', 'doctor-quick');
  await mkdir(runDirectory);
  const promptFile = join(await realpath(promptRoot), 'quick.txt');
  const prompt = '$cruise:quick scope canary\n';
  await writeFile(promptFile, prompt, { mode: 0o400 });
  const parse = (command) => parseDoctorRuntimeHostInvocation(command, {
    expectedRuntimePath: runtimePath,
    expectedNodePath: nodePath,
    repositoryRoot: canonicalRoot,
    skill: 'quick',
    promptFile,
  });
  assert.equal(parse(`${nodePath} ${runtimePath} begin --help`), null);
  assert.equal(parse(`/bin/bash -lc '${nodePath} ${runtimePath} begin --skill quick --root ${canonicalRoot} --run-dir ${runDirectory} --prompt-file ${promptFile}'`), null);
  assert.equal(parse(`${nodePath} /other/cruise-runtime.mjs begin --skill quick --root ${canonicalRoot} --run-dir ${runDirectory} --prompt-file ${promptFile}`), null);
  assert.equal(parse(`${nodePath} ${runtimePath} begin --skill debug --root ${canonicalRoot} --run-dir ${runDirectory} --prompt-file ${promptFile}`), null);
  assert.equal(parse(`${nodePath} ${runtimePath} begin --skill quick --root ${outside} --run-dir ${runDirectory} --prompt-file ${promptFile}`), null);
  assert.equal(parse(`${nodePath} ${runtimePath} begin --skill quick --root ${canonicalRoot} --run-dir ${outside} --prompt-file ${promptFile}`), null);
  assert.equal(parse(`${nodePath} ${runtimePath} begin --skill quick --root ${canonicalRoot} --prompt-file prompt.txt`), null);
  assert.equal(parse(`${nodePath} ${runtimePath} foreign-diff-resolve --run-dir ${runDirectory} --resolution drift-res.yaml`), null);
  assert.equal(parse(`${nodePath} ${runtimePath} foreign-diff-permission --run-dir ${runDirectory} --decision-id D-01 --selection preserve_only --selected-label 'Preserve only'`), null);
  assert.equal(parse(`${nodePath} ${runtimePath} route --skill quick --run-dir ${runDirectory} --classifier ${join(runDirectory, 'classifier.yaml')} --catalog-json ${outside}`), null);
  assert.equal(parse(`${nodePath} ${runtimePath} route --skill quick --run-dir ${runDirectory} --classifier ${join(runDirectory, 'classifier.yaml')} --catalog-json ${join(runDirectory, 'models.json')}`)?.subcommand, 'route');
  assert.equal(parse(`${nodePath} ${runtimePath} validate-origin --file ${join(runDirectory, 'origin.yaml')}`)?.subcommand, 'validate-origin');

  const approvals = [];
  const gate = createDoctorRuntimeHostGate({
    expectedRuntimePath: runtimePath,
    expectedNodePath: nodePath,
    repositoryRoot: canonicalRoot,
    skill: 'quick',
    promptFile,
    promptSha256: createHash('sha256').update(prompt).digest('hex'),
    context: () => ({ threadId: 'thread-1', turnId: 'turn-1', phase: 'capture' }),
  });
  assert.deepEqual(answerDoctorServerRequest({
    method: 'item/commandExecution/requestApproval',
    params: {
      command: `${nodePath} ${runtimePath} begin --skill quick --root ${outside} --prompt-file ${promptFile}`,
      cwd: canonicalRoot,
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      availableDecisions: ['accept', 'decline'],
    },
  }, {
    approvals,
    skill: 'quick',
    runtimeHostGate: gate,
  }), { decision: 'decline' });
  assert.equal(approvals[0].unexpectedEscalation, true);
});

test('deep Doctor supplies Plan mode with an advertised model and medium effort', () => {
  assert.deepEqual(selectDoctorRootModel({
    data: [
      {
        id: 'default-without-medium',
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
      },
      {
        id: 'doctor-medium',
        isDefault: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
      },
    ],
  }), { model: 'doctor-medium', reasoningEffort: 'medium' });
  assert.throws(() => selectDoctorRootModel({ data: [] }), /advertised medium-effort root model/u);
});

test('rapid Deep Doctor selects the exact advertised Luna Medium model', () => {
  const entry = {
    id: 'gpt-5.6-luna',
    model: 'gpt-5.6-luna',
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['medium'],
  };
  assert.deepEqual(selectDoctorSmokeModel({ data: [entry] }), {
    model: 'gpt-5.6-luna',
    reasoningEffort: 'medium',
  });
});

test('deep Doctor Quick prompt does not self-trigger the conservative conflict gate', () => {
  const scenario = DOCTOR_SKILL_CASES.find(({ skill }) => skill === 'quick');
  const prompt = createDoctorCanaryPrompt({
    skill: 'quick',
    prompt: scenario.prompt,
  });
  assert.match(prompt, /exact 18 schema-v1 enrichment gates/u);
  assert.match(prompt, /expected run-control state/u);
  assert.match(prompt, /`cruise-runtime` is not on PATH and a bare invocation will fail/u);
  assert.match(prompt, /`map-pkt\.yaml` was generated atomically/u);
  assert.match(prompt, /Pass that tagged packet unchanged/u);
  assert.match(prompt, /preflights the executable packet and embedded 18-fact template before inference/u);
  assert.match(prompt, /root coordinator alone runs `enrich-probe`/u);
  assert.match(prompt, /copies the complete `enrichment_template`/u);
  assert.match(prompt, /only `facts\[\*\]\.value` and `facts\[\*\]\.basis`/u);
  assert.doesNotMatch(prompt, /every worker packet that needs a contract validator/u);
  assert.doesNotMatch(prompt, /repository conflict/iu);
  const installedRuntime = '/installed/cruise/scripts/cruise-runtime.mjs';
  assert.equal(createDoctorCanaryPrompt({
    skill: 'quick',
    prompt: scenario.prompt,
    runtimeExecutable: installedRuntime,
  }).includes(`exact \`node ${installedRuntime} <subcommand> ...\` invocation`), true);
  const repositoryRoot = '/tmp/cruise-doctor/quick';
  const nodeExecutable = '/installed/node';
  const runtimePromptFile = '/host/doctor-prompts/quick.txt';
  const exactPrompt = createDoctorCanaryPrompt({
    skill: 'quick',
    prompt: scenario.prompt,
    phase: 'capture',
    runtimeExecutable: installedRuntime,
    repositoryRoot,
    nodeExecutable,
    runtimePromptFile,
  });
  assert.match(exactPrompt, new RegExp(
    `${nodeExecutable} ${installedRuntime} begin --skill quick --root ${repositoryRoot} --prompt-file ${runtimePromptFile}`,
    'u',
  ));
  assert.match(exactPrompt, /`begin --help`[\s\S]*makes this canary fail/u);
  assert.match(exactPrompt, /Never try a runtime command in the repository-only sandbox first/u);
  assert.match(exactPrompt, /non-destructive foreign-diff monitoring is active/u);
  assert.match(exactPrompt, /clean run has no speculative foreign-diff question/u);
  assert.doesNotMatch(exactPrompt, /Preserve only|Allow exact restore|foreign-diff-permission/u);

  const continuation = createDoctorCanaryPrompt({
    skill: 'quick',
    prompt: scenario.prompt,
    phase: 'single',
  });
  assert.match(continuation, /foreign-diff monitoring is already active/u);
  assert.match(continuation, /already staged the immutable live app-server catalog/u);
  assert.match(continuation, /do not create, replace, or edit them/u);
  assert.match(continuation, /Do not ask a speculative start question/u);
  assert.match(continuation, /concrete incident whose resolution requires user intent/u);
  assert.doesNotMatch(continuation, /Preserve only|Allow exact restore|foreign-diff-permission/u);
});

test('deep Doctor Refine prompt names the fixture evidence at repository-root paths', () => {
  const scenario = DOCTOR_SKILL_CASES.find(({ skill }) => skill === 'refine');
  const prompt = createDoctorCanaryPrompt({
    skill: 'refine',
    prompt: scenario.prompt,
  });
  assert.match(prompt, /target document is intentionally absent at baseline/iu);
  assert.match(prompt, /data\/format-markers\.json/u);
  assert.match(prompt, /workflow\/Snakefile/u);
  assert.doesNotMatch(prompt, /spatiomics-skill\/data\/format-markers\.json/u);
  assert.match(prompt, /writable\/default turn/u);
  assert.match(prompt, /exactly \*\*Approve Plan\*\*/u);

  const approval = createDoctorCanaryPrompt({
    skill: 'refine',
    prompt: scenario.prompt,
    phase: 'plan-approval',
  });
  assert.match(approval, /approval phase is read-only/u);
  assert.doesNotMatch(approval, /^\$cruise:refine/u);

  const execute = createDoctorCanaryPrompt({
    skill: 'refine',
    prompt: scenario.prompt,
    phase: 'execute',
  });
  assert.match(execute, /writable\/default continuation/u);
  assert.match(execute, /independent verification/u);
  assert.doesNotMatch(execute, /^\$cruise:refine/u);
});

test('deep Doctor Debug prompt identifies its intentional tracked failing input', () => {
  const scenario = DOCTOR_SKILL_CASES.find(({ skill }) => skill === 'debug');
  const prompt = createDoctorCanaryPrompt({
    skill: 'debug',
    prompt: scenario.prompt,
  });
  assert.match(prompt, /tracked tests\/fail\.test\.mjs is an intentional failing canary input committed in the fixture baseline/u);
  assert.match(prompt, /only allowed repair target/u);
  assert.doesNotMatch(prompt, /requested output is intentionally absent/u);
});

test('deep Doctor stages Goal through one deterministic combined review and writable continuation', () => {
  const scenario = DOCTOR_SKILL_CASES.find(({ skill }) => skill === 'goal');
  const planDraft = createDoctorCanaryPrompt({
    skill: 'goal',
    prompt: scenario.prompt,
  });
  assert.match(planDraft, /combined-draft phase is a writable\/default turn/u);
  assert.match(planDraft, /deterministic combined preview with full-file links and bound revisions/u);
  assert.match(planDraft, /exactly \*\*Approve both\*\*/u);
  assert.match(planDraft, /\*\*Reject all\*\*/u);
  assert.match(planDraft, /sole-write evidence gate untracked-aware/u);

  const planApproval = createDoctorCanaryPrompt({
    skill: 'goal',
    prompt: scenario.prompt,
    phase: 'plan-approval',
  });
  assert.match(planApproval, /combined-approval phase is read-only/u);
  assert.match(planApproval, /PLAN\.md and GOAL\.md/u);
  assert.doesNotMatch(planApproval, /^\$cruise:goal/u);

  const execute = createDoctorCanaryPrompt({
    skill: 'goal',
    prompt: scenario.prompt,
    phase: 'execute',
  });
  assert.match(execute, /writable\/default continuation after one exact combined/u);
  assert.match(execute, /native Goal control plane/u);
  assert.doesNotMatch(execute, /^\$cruise:goal/u);
});

test('deep Doctor gives Build writable draft and execution turns without recursive Doctor wording', () => {
  const scenario = DOCTOR_SKILL_CASES.find(({ skill }) => skill === 'build');
  assert.equal(scenario.collaborationMode ?? null, null);
  const draft = createDoctorCanaryPrompt({
    skill: 'build',
    prompt: scenario.prompt,
    phase: 'draft',
  });
  assert.match(draft, /writable\/default turn/u);
  assert.match(draft, /Approve Foundation.*Approve Milestone/su);
  assert.match(draft, /Do not invoke `cruise doctor`/u);
  assert.doesNotMatch(draft, /automated deep Doctor run/iu);

  const approval = createDoctorCanaryPrompt({
    skill: 'build',
    prompt: scenario.prompt,
    phase: 'approval',
  });
  assert.match(approval, /approval phase is read-only/u);
  assert.match(approval, /native structured input tool/u);
  assert.doesNotMatch(approval, /^\$cruise:build/u);

  const execute = createDoctorCanaryPrompt({
    skill: 'build',
    prompt: scenario.prompt,
    phase: 'execute',
  });
  assert.match(execute, /writable\/default continuation on the same thread/u);
  assert.match(execute, /immediately preceding thread history/u);
  assert.doesNotMatch(execute, /^\$cruise:build/u);
  assert.throws(
    () => createDoctorCanaryPrompt({ skill: 'build', prompt: scenario.prompt, phase: 'unknown' }),
    /Unsupported Build canary phase/u,
  );
});

test('deep Doctor recognizes only native exact Build approval labels', () => {
  assert.equal(hasNativeBuildApproval([{
    method: 'item/tool/requestUserInput',
    answers: { review: { answers: ['Approve Milestone'] } },
    phase: 'approval',
  }]), true);
  assert.equal(hasNativeBuildApproval([{
    method: 'mcpServer/elicitation/request',
    answers: { review: { answers: ['Approve Milestone'] } },
    phase: 'approval',
  }]), false);
  assert.equal(hasNativeBuildApproval([{
    method: 'item/tool/requestUserInput',
    answers: { review: { answers: ['Approve Milestone later'] } },
    phase: 'approval',
  }]), false);
  assert.equal(hasNativeBuildApproval([{
    method: 'item/tool/requestUserInput',
    answers: { review: { answers: ['Approve Milestone'] } },
    phase: 'execute',
  }]), false);
});

test('deep Doctor requires exact native Refine and combined Goal approvals', () => {
  const plan = {
    method: 'item/tool/requestUserInput',
    answers: { plan: { answers: ['Approve Plan'] } },
    phase: 'plan-approval',
  };
  const combined = {
    method: 'item/tool/requestUserInput',
    answers: { goal: { answers: ['Approve both'] } },
    phase: 'plan-approval',
  };
  assert.equal(hasNativeExactApproval([plan], 'Approve Plan'), true);
  assert.equal(hasNativeRefineApproval([plan]), true);
  assert.equal(hasNativeRefineApproval([{ ...plan, phase: 'execute' }]), false);
  assert.equal(hasNativeGoalApprovals([combined]), true);
  assert.equal(hasNativeApprovalSequence([combined], ['Approve both']), true);
  assert.equal(hasNativeGoalApprovals([{ ...combined, phase: 'execute' }]), false);
  assert.equal(hasNativeGoalApprovals([{
    method: 'item/tool/requestUserInput',
    answers: { combined: { answers: ['Approve', 'Reject all'] } },
    phase: 'plan-draft',
  }]), false);
  assert.equal(hasNativeGoalApprovals([
    { method: 'mcpServer/elicitation/request', answers: combined.answers },
  ]), false);
  assert.equal(hasNativeGoalControlUpdate([
    { id: 'goal-1', status: 'active', phase: 'execute' },
  ]), true);
  assert.equal(hasNativeGoalControlUpdate([
    { id: 'goal-1', status: 'active', phase: 'plan-draft' },
  ]), false);
});

async function createDeadlineCanaryFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cruise-doctor-deadline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'repository');
  const plugin = join(directory, 'plugin');
  const codexHome = join(directory, 'codex-home');
  await mkdir(join(root, '.agents', 'skills', 'spatiomics-skill'), { recursive: true });
  await writeFile(
    join(root, '.agents', 'skills', 'spatiomics-skill', 'SKILL.md'),
    '# spatiomics-skill\n',
  );
  await mkdir(join(plugin, '.codex-plugin'), { recursive: true });
  await mkdir(join(plugin, 'internal'), { recursive: true });
  await mkdir(join(plugin, 'scripts'), { recursive: true });
  await mkdir(join(plugin, 'tests'), { recursive: true });
  await writeFile(
    join(plugin, '.codex-plugin', 'plugin.json'),
    '{"name":"cruise","version":"deadline-test"}\n',
  );
  await writeFile(join(plugin, 'package.json'), '{"name":"cruise"}\n');
  await writeFile(join(plugin, 'internal', 'README.md'), '# Internal\n');
  await writeFile(join(plugin, 'scripts', 'probe.mjs'), 'export {};\n');
  await writeFile(join(plugin, 'scripts', 'cruise-runtime.mjs'), 'export {};\n');
  await writeFile(join(plugin, 'tests', 'smoke.test.mjs'), 'export {};\n');
  for (const { skill } of DOCTOR_SKILL_CASES) {
    await mkdir(join(plugin, 'skills', skill), { recursive: true });
    await writeFile(join(plugin, 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
  }
  await mkdir(join(plugin, 'fixtures'), { recursive: true });
  await mkdir(codexHome, { recursive: true });
  return { root, plugin, codexHome };
}

class DeepDeadlineAppServer extends EventEmitter {
  constructor(options, fixture, blockedStage) {
    super();
    this.options = options;
    this.fixture = fixture;
    this.blockedStage = blockedStage;
    this.skillsLists = 0;
    this.stopCalls = 0;
  }

  start() {
    return this.blockedStage === 'app-server start'
      ? new Promise(() => {})
      : Promise.resolve();
  }

  stop() {
    this.stopCalls += 1;
    return Promise.resolve();
  }

  request(method) {
    if (method === 'model/list') {
      if (this.blockedStage === method) return new Promise(() => {});
      return Promise.resolve({
        data: [{
          id: 'doctor-root-model',
          isDefault: true,
          supportedReasoningEfforts: ['medium'],
        }],
      });
    }
    if (method === 'skills/list') {
      this.skillsLists += 1;
      const stage = this.skillsLists === 1 ? 'installed skills/list' : 'repository skills/list';
      if (this.blockedStage === stage) return new Promise(() => {});
      if (this.skillsLists === 1) {
        const stagedRoot = join(
          this.fixture.codexHome,
          'plugins',
          'cache',
          'agent-local',
          'cruise',
          'deadline-test',
        );
        return Promise.resolve({
          data: [{
            cwd: this.fixture.root,
            errors: [],
            skills: DOCTOR_SKILL_CASES.map(({ skill }) => ({
              name: `cruise:${skill}`,
              path: join(stagedRoot, 'skills', skill, 'SKILL.md'),
              enabled: true,
            })),
          }],
        });
      }
      return Promise.resolve({
        data: [{
          cwd: this.fixture.root,
          errors: [],
          skills: [{
            name: 'spatiomics-skill',
            path: join(this.fixture.root, '.agents', 'skills', 'spatiomics-skill', 'SKILL.md'),
            enabled: true,
            scope: 'repo',
          }],
        }],
      });
    }
    if (method === 'thread/start') {
      if (this.blockedStage === method) return new Promise(() => {});
      return Promise.resolve({ thread: { id: 'thread-1' } });
    }
    if (method === 'turn/start') {
      if (this.blockedStage === method) return new Promise(() => {});
      return Promise.resolve({ turn: { id: 'turn-1', status: 'inProgress' } });
    }
    throw new Error(`unexpected request ${method}`);
  }
}

class CompletedDoctorDraftWithoutRun extends DeepDeadlineAppServer {
  constructor(options, fixture, { invalidRuntime = false } = {}) {
    super(options, fixture, null);
    this.invalidRuntime = invalidRuntime;
    this.turnStartCalls = 0;
  }

  request(method) {
    if (method !== 'turn/start') return super.request(method);
    this.turnStartCalls += 1;
    const turnId = `turn-${this.turnStartCalls}`;
    setImmediate(() => {
      this.emit('notification', {
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: turnId } },
      });
      if (this.invalidRuntime) {
        const stagedRuntime = join(
          this.fixture.codexHome,
          'plugins',
          'cache',
          'agent-local',
          'cruise',
          'deadline-test',
          'scripts',
          'cruise-runtime.mjs',
        );
        this.emit('notification', {
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId,
            item: {
              id: 'invalid-runtime-item',
              type: 'commandExecution',
              command: `${realpathSync(process.execPath)} ${stagedRuntime} begin --help`,
              status: 'failed',
              exitCode: 1,
            },
          },
        });
      }
      this.emit('notification', {
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } },
      });
    });
    return Promise.resolve({ turn: { id: turnId, status: 'inProgress' } });
  }
}

test('deep Doctor never opens a read-only approval phase when draft produced no canonical run', async (t) => {
  const fixture = await createDeadlineCanaryFixture(t);
  let client;
  await assert.rejects(runSkillTurn({
    root: fixture.root,
    skill: 'build',
    prompt: 'phase prerequisite canary',
    timeoutMs: 5_000,
    codexHome: fixture.codexHome,
    installedPluginRoot: fixture.plugin,
    workerExecutable: DOCTOR_WORKER_EXECUTABLE,
    runtimeFactory: async () => ({
      codexHome: fixture.codexHome,
      appServerArgs: [],
      spawnOptions: {},
      async dispose() {},
    }),
    clientFactory(options) {
      client = new CompletedDoctorDraftWithoutRun(options, fixture);
      return client;
    },
  }), /cannot enter a later phase before one successful exact host-bound runtime begin/u);
  assert.equal(client.turnStartCalls, 1);
});

test('deep Doctor terminates on the first failed runtime attempt without a duplicate retry', async (t) => {
  const fixture = await createDeadlineCanaryFixture(t);
  let client;
  await assert.rejects(runSkillTurn({
    root: fixture.root,
    skill: 'build',
    prompt: 'failed first runtime canary',
    timeoutMs: 5_000,
    codexHome: fixture.codexHome,
    installedPluginRoot: fixture.plugin,
    workerExecutable: DOCTOR_WORKER_EXECUTABLE,
    runtimeFactory: async () => ({
      codexHome: fixture.codexHome,
      appServerArgs: [],
      spawnOptions: {},
      async dispose() {},
    }),
    clientFactory(options) {
      client = new CompletedDoctorDraftWithoutRun(options, fixture, { invalidRuntime: true });
      return client;
    },
  }), (error) => {
    assert.match(error.message, /no exact one-shot host approval binding/u);
    assert.equal(error.commands.length, 1);
    assert.match(error.commands[0].command, /begin --help$/u);
    return true;
  });
  assert.equal(client.turnStartCalls, 1);
});

test('deep Doctor disposes a runtime that resolves after its setup deadline', async () => {
  let resolveRuntime;
  const pendingRuntime = new Promise((resolvePromise) => {
    resolveRuntime = resolvePromise;
  });
  let disposeCalls = 0;
  let clientFactoryCalls = 0;
  const running = runSkillTurn({
    root: process.cwd(),
    skill: 'quick',
    prompt: 'late runtime disposal canary',
    timeoutMs: 10,
    codexHome: process.cwd(),
    installedPluginRoot: process.cwd(),
    workerExecutable: DOCTOR_WORKER_EXECUTABLE,
    runtimeFactory() {
      return pendingRuntime;
    },
    clientFactory() {
      clientFactoryCalls += 1;
      throw new Error('client must not be created after the setup deadline');
    },
  });

  await assert.rejects(
    running,
    /quick troubleshoot session exceeded 10ms during isolated runtime setup/u,
  );
  resolveRuntime({
    async dispose() {
      disposeCalls += 1;
    },
  });
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));

  assert.equal(clientFactoryCalls, 0);
  assert.equal(disposeCalls, 1);
});

test('deep Doctor deadline bounds startup, discovery, thread, and turn requests', async (t) => {
  const timeoutMs = 1_000;
  const stages = [
    'app-server start',
    'model/list',
    'installed skills/list',
    'repository skills/list',
    'thread/start',
    'turn/start',
    'turn completion',
  ];
  for (const blockedStage of stages) {
    const fixture = await createDeadlineCanaryFixture(t);
    const reportedStage = blockedStage.startsWith('turn') ? `capture ${blockedStage}` : blockedStage;
    let client;
    await assert.rejects(runSkillTurn({
      root: fixture.root,
      skill: 'quick',
      prompt: 'bounded deadline canary',
      timeoutMs,
      codexHome: fixture.codexHome,
      installedPluginRoot: fixture.plugin,
      workerExecutable: DOCTOR_WORKER_EXECUTABLE,
      async runtimeFactory() {
        return {
          codexHome: fixture.codexHome,
          appServerArgs: [],
          spawnOptions: {},
          async dispose() {},
        };
      },
      clientFactory(options) {
        client = new DeepDeadlineAppServer(options, fixture, blockedStage);
        return client;
      },
    }), new RegExp(`quick troubleshoot session exceeded ${timeoutMs}ms during ${reportedStage.replace('/', '\\/')}`, 'u'));
    assert.equal(client.stopCalls, 1, `owned client was not stopped during ${blockedStage}`);
  }
});

test('deep Doctor protocol error aborts a pre-turn request and bounds sanitized stderr', async (t) => {
  const fixture = await createDeadlineCanaryFixture(t);
  let client;
  const startedAt = Date.now();
  await assert.rejects(runSkillTurn({
    root: fixture.root,
    skill: 'quick',
    prompt: 'protocol failure canary',
    timeoutMs: 10_000,
    codexHome: fixture.codexHome,
    installedPluginRoot: fixture.plugin,
    workerExecutable: DOCTOR_WORKER_EXECUTABLE,
    async runtimeFactory() {
      return {
        codexHome: fixture.codexHome,
        appServerArgs: [],
        spawnOptions: {},
        async dispose() {},
      };
    },
    clientFactory(options) {
      client = new DeepDeadlineAppServer(options, fixture, null);
      client.request = (method) => {
        if (method !== 'model/list') throw new Error(`unexpected request ${method}`);
        client.emit(
          'stderr',
          `${'x'.repeat(9_000)}\u001b[31mBearer secret-token token=another-secret\u001b[0m`,
        );
        queueMicrotask(() => options.onError(new Error('invalid JSON before thread/start'), client));
        return new Promise(() => {});
      };
      return client;
    },
  }), (error) => {
    assert.match(error.message, /invalid JSON before thread\/start/u);
    assert.equal(error.appServerStderr.length <= 8 * 1024, true);
    assert.doesNotMatch(error.appServerStderr, /secret-token|another-secret|\u001b/u);
    assert.match(error.appServerStderr, /Bearer \[REDACTED\] token=\[REDACTED\]/u);
    return true;
  });
  assert.equal(client.stopCalls >= 1, true);
  assert.equal(Date.now() - startedAt < 1_000, true);
});

test('deep Doctor isolates sequential turn completion by exact turn id', async () => {
  const controller = createDoctorTurnController();
  const first = controller.begin('draft');
  assert.equal(controller.started('turn-1'), true);
  controller.bind(first, 'turn-1');
  assert.equal(controller.resolve({ id: 'turn-1', status: 'completed' }), true);
  assert.equal((await first.promise).id, 'turn-1');
  controller.release(first);

  const second = controller.begin('execute');
  assert.equal(controller.started('turn-1'), false);
  assert.equal(controller.resolve({ id: 'turn-1', status: 'completed' }), false);
  assert.equal(controller.reject(new Error('replayed first-turn error'), 'turn-1'), false);
  assert.deepEqual(controller.current(), { label: 'execute', id: null });
  controller.bind(second, 'turn-2');
  assert.equal(controller.resolve({ id: 'turn-1', status: 'completed' }), false);
  assert.equal(controller.reject(new Error('late first-turn error'), 'turn-1'), false);
  assert.deepEqual(controller.current(), { label: 'execute', id: 'turn-2' });
  assert.equal(controller.resolve({ id: 'turn-2', status: 'completed' }), true);
  assert.equal((await second.promise).id, 'turn-2');
  controller.release(second);
  assert.equal(controller.current(), null);
});

test('deep Doctor rejects protocol-completed turns with blocked workflow semantics', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-doctor-blocked-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = 'doctor-build';
  const run = join(root, '.cruise', 'runs', runId);
  await mkdir(run, { recursive: true });
  await writeYamlFile(join(run, 'state.yaml'), terminalState('build', runId, 'blocked'));
  await writeYamlFile(join(run, 'evidence.yaml'), terminalEvidence(runId, 'BLOCK'));
  await writeFile(
    join(run, 'work-rpt.yaml'),
    'schema_version: 1\nkind: "cruise_app_server_worker_report"\nmodel_output: "draft"\nruntime:\n  status: "completed"\n',
  );
  await assert.rejects(
    inspectDoctorWorkflowProof(root, 'build'),
    /authoritative Cruise run doctor-build ended blocked/u,
  );
});

test('deep Doctor rejects blocked evidence even when canonical run state says completed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-doctor-evidence-blocked-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = 'doctor-quick';
  const run = join(root, '.cruise', 'runs', runId);
  await mkdir(run, { recursive: true });
  await writeYamlFile(join(run, 'state.yaml'), terminalState('quick', runId));
  await writeYamlFile(join(run, 'evidence.yaml'), terminalEvidence(runId, 'BLOCK'));
  await assert.rejects(
    inspectDoctorWorkflowProof(root, 'quick'),
    /authoritative Cruise evidence for doctor-quick ended blocked/u,
  );
});

test('deep Doctor rejects a later completed run beside a prior blocked canonical run', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-doctor-multiple-runs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeCompletedDoctorRun(root, 'quick');
  const blockedRunId = 'quick-blocked';
  const blockedRun = join(root, '.cruise', 'runs', blockedRunId);
  await mkdir(blockedRun, { recursive: true });
  await writeYamlFile(
    join(blockedRun, 'state.yaml'),
    terminalState('quick', blockedRunId, 'blocked'),
  );
  await writeYamlFile(
    join(blockedRun, 'evidence.yaml'),
    terminalEvidence(blockedRunId, 'BLOCK'),
  );
  await assert.rejects(
    inspectDoctorWorkflowProof(root, 'quick'),
    /expected exactly one canonical Cruise run state; found 2/u,
  );
});

test('troubleshoot runs every skill in an isolated real repository', async (t) => {
  const report = await runTroubleshootDoctor({
    installedPluginRoot: resolve('.'),
    workerExecutable: DOCTOR_WORKER_EXECUTABLE,
    async runSkill({ root, skill, installedPluginRoot, collaborationMode }) {
      assert.match(installedPluginRoot, /\.plugin-snap\/cruise$/u);
      assert.equal(collaborationMode, null);
      await writeCompletedDoctorRun(root, skill);
      return {
        status: 'completed',
        output: `${skill} complete`,
        stderr: '',
        approvals: completedApprovals(skill),
        commands: completedDoctorCommands(
          root,
          skill,
          DOCTOR_WORKER_EXECUTABLE,
          installedPluginRoot,
        ),
        goalUpdates: skill === 'goal'
          ? [{ id: 'goal-1', status: 'active', phase: 'execute' }]
          : [],
      };
    },
  });
  t.after(() => rm(report.workspace, { recursive: true, force: true }));
  assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2));
  assert.equal(report.checks.length, 6);
  assert.equal(new Set(report.checks.map(({ id }) => id)).size, 6);
  assert.equal(report.checks.at(-1).id, 'installed-skill-inference-canary');
  assert.match(report.installedPluginSnapshotDigest.digest, /^[a-f0-9]{64}$/u);
  for (const { skill } of DOCTOR_SKILL_CASES) {
    assert.match(report.checks.find(({ id }) => id === `skill-e2e-${skill}`).detail, /guard finalized/u);
    const guard = await readYamlFile(join(
      report.workspace,
      skill,
      '.cruise',
      'runs',
      `doctor-${skill}`,
      'drift.yaml',
    ));
    assert.equal(guard.status, 'stopped');
    assert.equal(guard.history.at(-1).action, 'guard_finalized');
  }
});

test('troubleshoot pins one installed snapshot across a concurrent cache replacement', async (t) => {
  const plugin = await mkdtemp(join(tmpdir(), 'cruise-installed-plugin-'));
  t.after(() => rm(plugin, { recursive: true, force: true }));
  await mkdir(join(plugin, '.codex-plugin'), { recursive: true });
  await mkdir(join(plugin, 'internal'), { recursive: true });
  await mkdir(join(plugin, 'scripts'), { recursive: true });
  await mkdir(join(plugin, 'tests'), { recursive: true });
  await writeFile(
    join(plugin, '.codex-plugin', 'plugin.json'),
    '{"name":"cruise","version":"snapshot-test"}\n',
  );
  await writeFile(join(plugin, 'package.json'), '{"name":"cruise-codex-plugin"}\n');
  await writeFile(join(plugin, 'internal', 'README.md'), '# Internal\n');
  await writeFile(join(plugin, 'scripts', 'probe.mjs'), 'export {};\n');
  await writeFile(join(plugin, 'scripts', 'cruise-runtime.mjs'), 'export {};\n');
  await writeFile(join(plugin, 'tests', 'smoke.test.mjs'), 'export {};\n');
  for (const { skill } of DOCTOR_SKILL_CASES) {
    await mkdir(join(plugin, 'skills', skill), { recursive: true });
    await writeFile(join(plugin, 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
  }
  await cp(
    DEFAULT_DOCTOR_FIXTURE,
    join(plugin, 'fixtures', 'doctor', 'repository'),
    { recursive: true },
  );
  let calls = 0;
  const report = await runTroubleshootDoctor({
    installedPluginRoot: plugin,
    workerExecutable: DOCTOR_WORKER_EXECUTABLE,
    async runSkill({ root, skill, installedPluginRoot }) {
      calls += 1;
      assert.match(installedPluginRoot, /\.plugin-snap\//u);
      if (calls === 1) await rm(plugin, { recursive: true, force: true });
      await writeCompletedDoctorRun(root, skill);
      return {
        status: 'completed',
        output: '',
        stderr: '',
        approvals: completedApprovals(skill),
        commands: completedDoctorCommands(
          root,
          skill,
          DOCTOR_WORKER_EXECUTABLE,
          installedPluginRoot,
        ),
        goalUpdates: skill === 'goal'
          ? [{ id: 'goal-1', status: 'active', phase: 'execute' }]
          : [],
      };
    },
  });
  t.after(() => rm(report.workspace, { recursive: true, force: true }));
  assert.equal(calls, 5);
  assert.equal(report.ok, true);
});

test('deep Doctor rejects evidence that did not traverse the worker host path', () => {
  const noCommand = evaluateDoctorSkillResult({
    skill: 'quick',
    result: { status: 'completed', output: '', stderr: '', approvals: [], commands: [] },
    cruiseFiles: ['runs/quick/origin.yaml'],
    workerReports: ['runs/quick/report.yaml'],
  });
  assert.equal(noCommand.status, 'fail');
  assert.match(noCommand.detail, /exact cruise worker invocation/u);

  const brokered = evaluateDoctorSkillResult({
    skill: 'quick',
    result: {
      status: 'completed',
      output: '',
      stderr: '',
      approvals: [{ worker: true }],
      commands: [{ command: 'cruise worker --level 2 -C . --packet p --report r', status: 'completed', exitCode: 0 }],
    },
    cruiseFiles: ['runs/quick/origin.yaml'],
    workerReports: ['runs/quick/report.yaml'],
  });
  assert.equal(brokered.status, 'fail');
  assert.match(brokered.detail, /broker worker host permission/u);
});

test('deep Doctor binds the exact completed invocation to its same-run report', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-doctor-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeCompletedDoctorRun(root, 'quick');
  const proof = await inspectDoctorWorkflowProof(root, 'quick');
  assert.equal(proof.routeRecommendedLevel, 2);
  const bindings = bindDoctorWorkerInvocations({
    root,
    workflowProof: proof,
    commands: completedWorkerCommands(root, 'quick'),
  });
  assert.equal(bindings.length, 2);
  assert.deepEqual(bindings.map(({ commandIndex }) => commandIndex), [0, 1]);
  assert.equal(bindDoctorWorkerInvocations({
    root,
    workflowProof: proof,
    commands: [completedWorkerCommand(root, 'quick', {
      command: `echo cruise worker --level 2 -C ${root} --packet p --report ${join(root, '.cruise', 'runs', 'doctor-quick', 'work-rpt.yaml')}`,
    })],
  }).length, 0);
  assert.equal(bindDoctorWorkerInvocations({
    root,
    workflowProof: proof,
    commands: [completedWorkerCommand(root, 'quick', {
      command: `cruise worker --level 2 -C ${root} --packet p --report ${join(root, '.cruise', 'runs', 'other-run', 'work-rpt.yaml')}`,
    })],
  }).length, 0);
});

test('deep Doctor rejects a wrong first runtime attempt even when an exact retry follows', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-doctor-runtime-attempt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeCompletedDoctorRun(root, 'quick');
  const proof = await inspectDoctorWorkflowProof(root, 'quick');
  const installedPluginRoot = '/installed/cruise';
  const exact = completedRuntimeCommand(root, 'quick', installedPluginRoot);
  const workers = completedWorkerCommands(root, 'quick');
  const base = {
    skill: 'quick',
    root,
    workflowProof: proof,
    scenarioOutcome: completedScenarioOutcome(root, 'quick'),
    installedPluginRoot,
  };

  const valid = evaluateDoctorSkillResult({
    ...base,
    result: {
      status: 'completed',
      output: '',
      stderr: '',
      approvals: completedApprovals('quick'),
      commands: [exact, ...workers],
    },
  });
  assert.equal(valid.status, 'pass', valid.detail);

  const sandboxOnly = evaluateDoctorSkillResult({
    ...base,
    result: {
      status: 'completed',
      output: '',
      stderr: '',
      approvals: completedApprovals('quick').filter(({ doctorRuntimeHostPath }) => (
        doctorRuntimeHostPath !== true
      )),
      commands: [exact, ...workers],
    },
  });
  assert.equal(sandboxOnly.status, 'fail');
  assert.match(sandboxOnly.detail, /noninteractive exact-command host approval item/u);

  const wrongFirst = evaluateDoctorSkillResult({
    ...base,
    result: {
      status: 'completed',
      output: '',
      stderr: '',
      approvals: completedApprovals('quick'),
      commands: [
        {
          ...exact,
          command: 'cruise-runtime begin --skill quick',
          status: 'failed',
          exitCode: 127,
        },
        exact,
        ...workers,
      ],
    },
  });
  assert.equal(wrongFirst.status, 'fail');
  assert.match(wrongFirst.detail, /first attempt[\s\S]*not a successful exact installed/u);

  const lateExact = evaluateDoctorSkillResult({
    ...base,
    result: {
      status: 'completed',
      output: '',
      stderr: '',
      approvals: completedApprovals('quick'),
      commands: [workers[0], exact, workers[1]],
    },
  });
  assert.equal(lateExact.status, 'fail');
  assert.match(lateExact.detail, /runtime begin only after the first mapping worker/u);
});

test('deep Doctor rejects a mapping report overwritten after command completion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-doctor-command-time-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeCompletedDoctorRun(root, 'quick');
  const commands = completedWorkerCommands(root, 'quick');
  const reportPath = join(root, '.cruise', 'runs', 'doctor-quick', 'map-rpt.yaml');
  const report = await readYamlFile(reportPath);
  await writeYamlFile(reportPath, { ...report, warnings: ['written after mapper completion'] });
  const proof = await inspectDoctorWorkflowProof(root, 'quick');
  const bindings = bindDoctorWorkerInvocations({ root, commands, workflowProof: proof });
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].packetPath.endsWith('/work-pkt.yaml'), true);
  const evaluated = evaluateDoctorSkillResult({
    skill: 'quick',
    root,
    workflowProof: proof,
    scenarioOutcome: completedScenarioOutcome(root, 'quick'),
    result: { status: 'completed', output: '', stderr: '', approvals: [], commands },
  });
  assert.equal(evaluated.status, 'fail');
  assert.match(evaluated.detail, /command-time-bound facts/u);
});

test('deep Doctor binds accepted semantic facts to mapper command completion', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-doctor-command-time-facts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeCompletedDoctorRun(root, 'quick');
  const proof = await inspectDoctorWorkflowProof(root, 'quick');
  const [mapping, substantive] = completedWorkerCommands(root, 'quick');
  const commands = [{
    ...mapping,
    completionEvidence: {
      ...mapping.completionEvidence,
      semantic_facts_sha256: '0'.repeat(64),
    },
  }, substantive];
  const evaluated = evaluateDoctorSkillResult({
    skill: 'quick',
    root,
    workflowProof: proof,
    scenarioOutcome: completedScenarioOutcome(root, 'quick'),
    result: { status: 'completed', output: '', stderr: '', approvals: [], commands },
  });
  assert.equal(evaluated.status, 'fail');
  assert.match(evaluated.detail, /command-time-bound facts/u);
});

test('deep Doctor requires the substantive worker invocation after semantic mapping', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-doctor-worker-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeCompletedDoctorRun(root, 'quick');
  const proof = await inspectDoctorWorkflowProof(root, 'quick');
  const commands = completedWorkerCommands(root, 'quick').reverse();
  const result = evaluateDoctorSkillResult({
    skill: 'quick',
    root,
    workflowProof: proof,
    scenarioOutcome: completedScenarioOutcome(root, 'quick'),
    result: { status: 'completed', output: '', stderr: '', approvals: [], commands },
  });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /worker invocation after mapping/u);
});

test('deep Doctor preserves failed workers but rejects duplicate inference for the same packet', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-doctor-no-duplicate-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeCompletedDoctorRun(root, 'quick');
  const proof = await inspectDoctorWorkflowProof(root, 'quick');
  const successful = completedWorkerCommands(root, 'quick');
  const failed = {
    ...successful[0],
    status: 'failed',
    exitCode: 1,
    output: 'terminal worker failure',
  };
  const result = evaluateDoctorSkillResult({
    skill: 'quick',
    root,
    workflowProof: proof,
    scenarioOutcome: completedScenarioOutcome(root, 'quick'),
    result: {
      status: 'completed',
      output: '',
      stderr: '',
      approvals: [],
      commands: [failed, ...successful],
    },
  });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /duplicate inference attempt/u);

  const distinctFailure = {
    ...failed,
    command: failed.command
      .replace('map-pkt.yaml', 'fail-pkt.yaml')
      .replace('map-rpt.yaml', 'fail-rpt.yaml'),
  };
  const recovered = evaluateDoctorSkillResult({
    skill: 'quick',
    root,
    workflowProof: proof,
    scenarioOutcome: completedScenarioOutcome(root, 'quick'),
    result: {
      status: 'completed',
      output: '',
      stderr: '',
      approvals: completedApprovals('quick'),
      commands: [distinctFailure, ...successful],
    },
  });
  assert.equal(recovered.status, 'pass');
});

test('deep Doctor scans bounded child-command diagnostics for forbidden UX', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-doctor-command-ux-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeCompletedDoctorRun(root, 'quick');
  const proof = await inspectDoctorWorkflowProof(root, 'quick');
  const commands = completedWorkerCommands(root, 'quick');
  commands[0] = { ...commands[0], output: 'Do you consent to uploading repository files?' };
  const result = evaluateDoctorSkillResult({
    skill: 'quick',
    root,
    workflowProof: proof,
    scenarioOutcome: completedScenarioOutcome(root, 'quick'),
    result: { status: 'completed', output: '', stderr: '', approvals: [], commands },
  });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /forbidden worker-boundary UX/u);

  const rootRead = evaluateDoctorSkillResult({
    skill: 'quick',
    root,
    workflowProof: proof,
    scenarioOutcome: completedScenarioOutcome(root, 'quick'),
    result: {
      status: 'completed',
      output: '',
      stderr: '',
      approvals: [],
      commands: [{ command: 'sed -n 1,20p trusted-contract.md', output: 'Do you consent to uploading repository files?' }, ...completedWorkerCommands(root, 'quick')],
    },
  });
  assert.doesNotMatch(rootRead.detail, /forbidden worker-boundary UX/u);
});

test('deep Doctor requires the substantive worker invocation at the routed level', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-doctor-worker-level-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeCompletedDoctorRun(root, 'quick', { routeRecommendedLevel: 3 });
  const proof = await inspectDoctorWorkflowProof(root, 'quick');
  assert.equal(proof.routeRecommendedLevel, 3);
  const result = evaluateDoctorSkillResult({
    skill: 'quick',
    root,
    workflowProof: proof,
    scenarioOutcome: completedScenarioOutcome(root, 'quick'),
    result: {
      status: 'completed',
      output: '',
      stderr: '',
      approvals: [],
      commands: completedWorkerCommands(root, 'quick'),
    },
  });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /routed level-3 worker invocation after mapping/u);
});

test('deep Doctor rejects level-1 and final-attempt route provenance drift', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-doctor-route-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const levelOne = join(root, 'level-one');
  await mkdir(levelOne);
  await writeCompletedDoctorRun(levelOne, 'quick', { routeRecommendedLevel: 1 });
  await assert.rejects(
    inspectDoctorWorkflowProof(levelOne, 'quick'),
    /invalid classifier output|recommended_level/u,
  );

  const drifted = join(root, 'drifted');
  await mkdir(drifted);
  await writeCompletedDoctorRun(drifted, 'quick');
  const routePath = join(drifted, '.cruise', 'runs', 'doctor-quick', 'route.yaml');
  const route = await readYamlFile(routePath);
  route.recommended_level = 3;
  await writeYamlFile(routePath, route);
  await assert.rejects(
    inspectDoctorWorkflowProof(drifted, 'quick'),
    /does not match the canonical Origin, probe, and selected skill/u,
  );
});

test('deep Doctor rejects a second mapping packet copy as substantive inference', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-doctor-duplicate-mapping-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeCompletedDoctorRun(root, 'quick');
  const run = join(root, '.cruise', 'runs', 'doctor-quick');
  await copyFile(join(run, 'map-pkt.yaml'), join(run, 'dup-pkt.yaml'));
  const mappingDigest = createHash('sha256')
    .update(await readFile(join(run, 'dup-pkt.yaml')))
    .digest('hex');
  const reportPath = join(run, 'work-rpt.yaml');
  const report = await readYamlFile(reportPath);
  report.launch.packet_sha256 = mappingDigest;
  await writeYamlFile(reportPath, report);
  const proof = await inspectDoctorWorkflowProof(root, 'quick');
  const result = evaluateDoctorSkillResult({
    skill: 'quick',
    root,
    workflowProof: proof,
    scenarioOutcome: completedScenarioOutcome(root, 'quick'),
    result: {
      status: 'completed',
      output: '',
      stderr: '',
      approvals: [],
      commands: completedWorkerCommands(root, 'quick').map((command, index) => index === 1
        ? { ...command, command: command.command.replace('work-pkt.yaml', 'dup-pkt.yaml') }
        : command),
    },
  });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /distinct routed level-2 worker invocation after mapping/u);
});

test('deep Doctor evaluator enforces Refine and Goal native approval boundaries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-doctor-native-reviews-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const refineRoot = join(root, 'refine');
  await mkdir(refineRoot, { recursive: true });
  await writeCompletedDoctorRun(refineRoot, 'refine');
  const refineProof = await inspectDoctorWorkflowProof(refineRoot, 'refine');
  const refineResult = evaluateDoctorSkillResult({
    skill: 'refine',
    root: refineRoot,
    workflowProof: refineProof,
    scenarioOutcome: completedScenarioOutcome(refineRoot, 'refine'),
    result: {
      status: 'completed',
      output: '',
      stderr: '',
      approvals: [],
      commands: completedWorkerCommands(refineRoot, 'refine'),
    },
  });
  assert.equal(refineResult.status, 'fail');
  assert.match(refineResult.detail, /Approve Plan/u);

  const goalRoot = join(root, 'goal');
  await mkdir(goalRoot, { recursive: true });
  await writeCompletedDoctorRun(goalRoot, 'goal');
  const goalProof = await inspectDoctorWorkflowProof(goalRoot, 'goal');
  const planOnly = evaluateDoctorSkillResult({
    skill: 'goal',
    root: goalRoot,
    workflowProof: goalProof,
    scenarioOutcome: completedScenarioOutcome(goalRoot, 'goal'),
    result: {
      status: 'completed',
      output: '',
      stderr: '',
      approvals: completedApprovals('refine'),
      commands: completedWorkerCommands(goalRoot, 'goal'),
      goalUpdates: [{ id: 'goal-1', status: 'active', phase: 'execute' }],
    },
  });
  assert.equal(planOnly.status, 'fail');
  assert.match(planOnly.detail, /combined Plan-and-Goal Approve both/u);

  const noActivation = evaluateDoctorSkillResult({
    skill: 'goal',
    root: goalRoot,
    workflowProof: goalProof,
    scenarioOutcome: completedScenarioOutcome(goalRoot, 'goal'),
    result: {
      status: 'completed',
      output: '',
      stderr: '',
      approvals: completedApprovals('goal'),
      commands: completedWorkerCommands(goalRoot, 'goal'),
      goalUpdates: [],
    },
  });
  assert.equal(noActivation.status, 'fail');
  assert.match(noActivation.detail, /native Goal control-plane update/u);
});

test('troubleshoot keeps terminal reconnect evidence outside worker-writable roots despite log tampering', async (t) => {
  const history = [
    { sequence: 1, will_retry: true, message: 'Reconnecting... 1/5' },
    { sequence: 2, will_retry: false, message: 'response retries exhausted', codex_error: 'responseTooManyFailedAttempts', http_status_code: 503 },
  ];
  const report = await runTroubleshootDoctor({
    installedPluginRoot: resolve('.'),
    workerExecutable: DOCTOR_WORKER_EXECUTABLE,
    async runSkill({ root, skill, installedPluginRoot }) {
      if (skill === 'quick') {
        const legacyEvidenceDirectory = join(root, '.cruise', 'doctor');
        await mkdir(legacyEvidenceDirectory, { recursive: true });
        await writeFile(join(legacyEvidenceDirectory, 'session.log'), 'ATTACKER-TAIL\n');
        await rm(
          join(resolve(root, '..'), '.doc-evidence', 'quick', 'session.log'),
          { force: true },
        );
        const failure = new WorkerSessionError('terminal stream failure', {
          runtime: { thread_id: 'thread-quick', turn_id: 'turn-quick' },
          reconnectHistory: history,
        });
        failure.commands = [{
          command: 'cruise worker --level 2 -C . --packet p --report r',
          status: 'failed',
          exitCode: 1,
          output: 'child worker reconnect diagnostics',
        }];
        throw failure;
      }
      await writeCompletedDoctorRun(root, skill);
      return {
        status: 'completed', output: '', stderr: '', approvals: completedApprovals(skill),
        commands: completedDoctorCommands(
          root,
          skill,
          DOCTOR_WORKER_EXECUTABLE,
          installedPluginRoot,
        ),
        goalUpdates: skill === 'goal'
          ? [{ id: 'goal-1', status: 'active', phase: 'execute' }]
          : [],
        reconnectHistory: [],
      };
    },
  });
  t.after(() => rm(report.workspace, { recursive: true, force: true }));
  const logRecord = report.sessionLogs.quick;
  const log = await readFile(logRecord.path, 'utf8');
  assert.equal(logRecord.path.startsWith(`${report.evidenceRoot}/`), true);
  assert.equal(logRecord.path.startsWith(`${join(report.workspace, 'quick')}/`), false);
  assert.match(log, /reconnect_history:/u);
  assert.match(log, /Reconnecting\.\.\. 1\/5/u);
  assert.match(log, /responseTooManyFailedAttempts/u);
  assert.match(log, /"thread_id":"thread-quick"/u);
  assert.match(log, /child worker reconnect diagnostics/u);
  assert.doesNotMatch(log, /ATTACKER-TAIL/u);
  assert.equal(
    createHash('sha256').update(log).digest('hex'),
    logRecord.sha256,
  );
  assert.equal(
    await readFile(join(report.workspace, 'quick', '.cruise', 'doctor', 'session.log'), 'utf8'),
    'ATTACKER-TAIL\n',
  );
});

test('deep Doctor discovers exactly the five enabled cache-rooted public skills', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cruise-skill-cache-'));
  const workspace = await mkdtemp(join(tmpdir(), 'cruise-skill-workspace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const skills = [];
  for (const { skill } of DOCTOR_SKILL_CASES) {
    const path = join(directory, 'skills', skill, 'SKILL.md');
    await mkdir(join(directory, 'skills', skill), { recursive: true });
    await writeFile(path, `# ${skill}\n`);
    skills.push({ name: `cruise:${skill}`, path, enabled: true });
  }
  const client = {
    async request(method) {
      assert.equal(method, 'skills/list');
      return { data: [{ cwd: workspace, errors: [], skills }] };
    },
  };
  const descriptors = await discoverInstalledCruiseSkills(client, {
    root: workspace,
    pluginRoot: directory,
  });
  assert.deepEqual(Object.keys(descriptors).sort(), DOCTOR_SKILL_CASES.map(({ skill }) => skill).sort());
  assert.equal(descriptors.quick.name, 'cruise:quick');
});

test('deep Doctor discovers the exact repository-local spatiomics skill', async () => {
  const root = DEFAULT_DOCTOR_FIXTURE;
  const path = join(root, '.agents', 'skills', 'spatiomics-skill', 'SKILL.md');
  const client = {
    async request(method, params) {
      assert.equal(method, 'skills/list');
      assert.deepEqual(params, { cwds: [resolve(root)], forceReload: true });
      return {
        data: [{
          cwd: resolve(root),
          errors: [],
          skills: [{ name: 'spatiomics-skill', path, enabled: true, scope: 'repo' }],
        }],
      };
    },
  };
  const descriptor = await discoverRepositorySpatiomicsSkill(client, { root });
  assert.equal(descriptor.name, 'spatiomics-skill');
  assert.equal(descriptor.scope, 'repo');
  assert.equal(descriptor.path, resolve(path));
});

test('Doctor rejects fixtures that are not skill repositories with Cruise state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cruise-invalid-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(validateDoctorFixture(directory), /own \.cruise directory/u);
});
