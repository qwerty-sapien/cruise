import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  COMPLETION_OUTCOMES,
  createEvidenceItem,
  createEvidenceRecord,
  determineCompletion,
  evidenceDigest,
  finalizeEvidenceRecord,
  validateEvidenceRecord,
} from '../scripts/lib/evidence.mjs';
import {
  assertOneHopHandoff,
  createHandoff,
  createQuickPromotionHandoff,
  handoffDigest,
  validateHandoff,
} from '../scripts/lib/handoff.mjs';
import { PUBLIC_ROUTES } from '../scripts/lib/routing.mjs';
import { assertYamlSchema, parseYaml, stringifyYaml } from '../scripts/lib/yaml-state.mjs';

const START = '2026-07-13T01:00:00Z';
const END = '2026-07-13T01:00:01Z';
const IDENTITY = Object.freeze({
  source: 'git:0123456789abcdef + dirty-state:abc123',
  build: 'source-tree:sha256:feedface',
  environment: 'darwin-arm64; node v22.17.0; cwd /workspace',
});

function item(id, overrides = {}) {
  return createEvidenceItem({
    id,
    gate: 'mandatory',
    scope: 'task',
    status: 'PASS',
    performed: true,
    procedure: 'Run the focused Node test and inspect its process status.',
    command: 'node --test tests/focused.test.mjs',
    expected: 'Process exits 0 and reports one passing test.',
    actual: 'Process exited 0 and reported 1 pass, 0 fail.',
    identity: IDENTITY,
    startedAt: START,
    finishedAt: END,
    supports: ['R-01', 'AC-01'],
    sideEffects: [],
    ...overrides,
  });
}

function finalVerification(evidenceIds = ['E-02'], overrides = {}) {
  return {
    verifier: 'fresh adversarial verifier',
    performedAt: '2026-07-13T01:01:00Z',
    originCompared: true,
    normalizedContractCompared: true,
    actualChangesOrOutputsCompared: true,
    taskCompletionOnly: false,
    evidenceIds,
    ...overrides,
  };
}

function finalItem(id = 'E-02', overrides = {}) {
  return item(id, {
    scope: 'final_verification',
    procedure: 'Compare immutable origin, normalized contract, actual diff, and current test evidence.',
    command: 'git diff --check -- . && node --test tests/focused.test.mjs',
    expected: 'The diff remains in scope and current focused evidence passes.',
    actual: 'Diff was in scope; both commands exited 0 against the recorded identities.',
    ...overrides,
  });
}

test('evidence preserves exact procedure, command, outcomes, identities, effects, and cleanup', () => {
  const evidence = item('E-01', {
    sideEffects: ['Created temporary cache /tmp/cruise-cache.'],
    cleanup: {
      required: true,
      procedure: 'Remove /tmp/cruise-cache and verify it no longer exists.',
      actual: 'Removed the directory; lstat returned ENOENT.',
      completed: true,
    },
  });
  assert.equal(evidence.id, 'E-01');
  assert.equal(evidence.status, 'PASS');
  assert.equal(evidence.command, 'node --test tests/focused.test.mjs');
  assert.deepEqual(evidence.identity, IDENTITY);
  assert.equal(evidence.cleanup.completed, true);
  assert.equal(Object.isFrozen(evidence), true);
  assert.throws(() => item('E-1'), /E-XX|schema validation/);
  assert.throws(() => item('E-03', { status: 'SKIP' }), /must be one of/);
  assert.throws(() => item('E-03', { status: 'PARTIAL' }), /must be one of/);
  assert.throws(() => item('E-03', { status: 'WARN' }), /must be one of/);
  assert.throws(
    () => item('E-03', { performed: false }),
    /cannot PASS when its procedure was not performed/,
  );
  assert.throws(
    () => item('E-03', {
      sideEffects: ['Started a process.'],
      cleanup: {
        required: true,
        procedure: 'Stop the process.',
        actual: 'Process is still running.',
        completed: false,
      },
    }),
    /cannot PASS with required cleanup incomplete/,
  );
});

test('completion requires independent final evidence, not completed task boxes', () => {
  const active = createEvidenceRecord({
    runId: 'run-task-only',
    recordedAt: START,
    items: [item('E-01')],
  });
  assert.equal(active.outcome, 'active');
  assert.equal(determineCompletion(active).outcome, 'active');

  assert.throws(
    () => createEvidenceRecord({
      runId: 'run-task-reference',
      recordedAt: START,
      items: [item('E-01')],
      finalVerification: finalVerification(['E-01']),
    }),
    /must be mandatory and scoped final_verification/,
  );

  const complete = finalizeEvidenceRecord(
    createEvidenceRecord({
      runId: 'run-complete',
      recordedAt: START,
      items: [item('E-01'), finalItem()],
    }),
    finalVerification(),
  );
  assert.equal(complete.outcome, 'completed');
  assert.equal(complete.determined_at, '2026-07-13T01:01:00Z');
  assert.match(evidenceDigest(complete), /^[a-f0-9]{64}$/u);
  assert.equal(evidenceDigest(complete), evidenceDigest(structuredClone(complete)));
});

test('mandatory BLOCK and unwaived mandatory NOT_RUN block; an explicit D-XX waiver qualifies', () => {
  const blocked = createEvidenceRecord({
    runId: 'run-blocked',
    recordedAt: START,
    items: [
      item('E-01', {
        status: 'NOT_RUN',
        performed: false,
        actual: 'Required authenticated environment was unavailable.',
      }),
      finalItem('E-02', {
        status: 'BLOCK',
        actual: 'Final verification found mandatory evidence unavailable.',
      }),
    ],
    finalVerification: finalVerification(),
  });
  assert.equal(blocked.outcome, 'blocked');
  assert.equal(determineCompletion(blocked).reasons.some((reason) => /without a waiver/u.test(reason)), true);

  const compensating = item('E-03', {
    gate: 'advisory',
    scope: 'advisory',
    supports: ['D-01'],
  });
  const waived = item('E-01', {
    status: 'NOT_RUN',
    performed: false,
    actual: 'Required device was unavailable; the full gate did not run.',
    waiver: {
      decision_id: 'D-01',
      reason: 'The device cannot be accessed during this release window.',
      accepted_residual_risk: 'Device-specific behavior remains unverified.',
      owner: 'release owner',
      approved_at: '2026-07-13T01:00:30Z',
      reopen_trigger: 'Rerun when the device becomes available.',
      compensating_evidence_ids: ['E-03'],
      locked: true,
    },
  });
  const qualified = createEvidenceRecord({
    runId: 'run-qualified',
    recordedAt: START,
    items: [waived, finalItem(), compensating],
    finalVerification: finalVerification(),
  });
  assert.equal(qualified.outcome, 'completed_waiver_qualified');
  assert.deepEqual(determineCompletion(qualified).waived_evidence_ids, ['E-01']);
  assert.throws(
    () => item('E-04', {
      waiver: waived.waiver,
    }),
    /waivers are allowed only for mandatory NOT_RUN/,
  );
});

test('claimed completion cannot contradict derived evidence state', () => {
  const complete = createEvidenceRecord({
    runId: 'run-tamper',
    recordedAt: START,
    items: [item('E-01'), finalItem()],
    finalVerification: finalVerification(),
  });
  const tampered = structuredClone(complete);
  tampered.outcome = 'blocked';
  assert.throws(() => validateEvidenceRecord(tampered), /contradicts derived completed/);
  assert.deepEqual(COMPLETION_OUTCOMES, [
    'active',
    'completed',
    'completed_waiver_qualified',
    'blocked',
  ]);
});

test('handoff records exactly one of five public route transitions with evidence and origin', () => {
  assert.deepEqual(PUBLIC_ROUTES, ['build', 'quick', 'refine', 'goal', 'debug']);
  const handoff = createHandoff({
    id: 'HO-01',
    createdAt: START,
    sourceRoute: 'build',
    targetRoute: 'goal',
    trigger: 'explicit_user_request',
    reason: 'The user selected execution of approved phase P-01.',
    evidenceIds: ['E-01'],
    originPath: '.cruise/milestones/M-01-first/ORIGIN.yaml',
  });
  assert.deepEqual(handoff.route_history, ['build', 'goal']);
  assert.equal(handoff.hop_count, 1);
  assert.equal(handoff.parent_handoff_id, null);
  assert.equal(handoff.authorizes_product_edits, false);
  assert.equal(handoff.authorizes_goal_activation, false);
  assertOneHopHandoff(handoff);
  assert.match(handoffDigest(handoff), /^[a-f0-9]{64}$/u);
});

test('handoffs cannot loop, chain, invent routes, or reactivate retired Review', () => {
  const refine = createHandoff({
    id: 'HO-01',
    createdAt: START,
    sourceRoute: 'refine',
    targetRoute: 'quick',
    trigger: 'explicit_user_request',
    reason: 'The result proves a later bounded fix can enter Quick admission.',
    evidenceIds: ['E-01'],
    originPath: '.cruise/runs/refine/origin.yaml',
  });
  assert.equal(refine.authorizes_product_edits, false);
  assert.throws(
    () => assertOneHopHandoff(refine, { parentHandoff: refine }),
    /one-hop only/,
  );
  assert.throws(
    () => createHandoff({
      id: 'HO-02',
      createdAt: START,
      sourceRoute: 'refine',
      targetRoute: 'refine',
      trigger: 'route_mismatch',
      reason: 'loop',
      evidenceIds: ['E-01'],
      originPath: '.cruise/runs/refine/origin.yaml',
    }),
    /source and target routes must differ|duplicate items/,
  );
  assert.throws(
    () => createHandoff({
      id: 'HO-03',
      createdAt: START,
      sourceRoute: 'quick',
      targetRoute: 'build',
      trigger: 'semantic_promotion',
      reason: 'invalid Quick target',
      semanticReasons: ['scope_materially_exceeded'],
      evidenceIds: ['E-01'],
      originPath: '.cruise/runs/quick/origin.yaml',
    }),
    /Quick may hand off only|current public Cruise routes/,
  );
  assert.throws(
    () => createHandoff({
      id: 'HO-05',
      createdAt: START,
      sourceRoute: 'review',
      targetRoute: 'refine',
      trigger: 'review_remediation',
      reason: 'legacy route cannot create a new handoff',
      evidenceIds: ['E-01'],
      originPath: '.cruise/runs/review/origin.yaml',
    }),
    /current public Cruise routes/,
  );
  assert.throws(
    () => createHandoff({
      id: 'HO-04',
      createdAt: START,
      sourceRoute: 'quick',
      targetRoute: 'invented',
      trigger: 'route_mismatch',
      reason: 'invalid route',
      evidenceIds: ['E-01'],
      originPath: '.cruise/runs/quick/origin.yaml',
    }),
    /must be one of|current public Cruise routes/,
  );
});

test('Quick promotion target is derived by the shared semantic gate', () => {
  const classifier = {
    route: 'quick',
    recommended_level: 2,
    confidence: 0.99,
    ambiguity: 'low',
    semantic_risk: 'high',
    estimated_files: 2,
    estimated_diff_lines: 30,
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
  const promoted = createQuickPromotionHandoff({
    id: 'HO-01',
    createdAt: START,
    probe: {
      signals: {
        root_cause_unknown: true,
      },
    },
    classifier,
    evidenceIds: ['E-01'],
    originPath: '.cruise/runs/quick/origin.yaml',
  });
  assert.equal(promoted.target_route, 'debug');
  assert.deepEqual(promoted.semantic_reasons, ['root_cause_unknown']);
});

test('Goal handoff preserves exact combined activation authority', () => {
  const handoff = createHandoff({
    id: 'HO-06',
    createdAt: START,
    sourceRoute: 'refine',
    targetRoute: 'goal',
    trigger: 'explicit_user_request',
    reason: 'Durable recovery and multiple slices became necessary.',
    semanticReasons: ['durable_continuation_required'],
    evidenceIds: ['E-06'],
    originPath: '.cruise/runs/refine/origin.yaml',
  });
  assert.equal(handoff.authorizes_goal_activation, false);
  assert.equal(
    handoff.goal_activation_requirement,
    'combined_Plan_and_Goal_Approve_required',
  );
});

test('checked-in YAML schemas parse and validate emitted records', async () => {
  const evidenceSchema = parseYaml(await readFile('internal/schemas/evidence.schema.yaml', 'utf8'));
  const handoffSchema = parseYaml(await readFile('internal/schemas/handoff.schema.yaml', 'utf8'));
  const evidence = createEvidenceRecord({
    runId: 'schema-run',
    recordedAt: START,
    items: [item('E-01'), finalItem()],
    finalVerification: finalVerification(),
  });
  const handoff = createHandoff({
    id: 'HO-01',
    createdAt: START,
    sourceRoute: 'quick',
    targetRoute: 'refine',
    trigger: 'explicit_user_request',
    reason: 'Recommendation complete; implementation requires an approved finite plan.',
    evidenceIds: ['E-01'],
    originPath: '.cruise/runs/quick/origin.yaml',
  });
  assertYamlSchema(parseYaml(stringifyYaml(evidence)), evidenceSchema, {
    name: 'evidence fixture',
  });
  assertYamlSchema(parseYaml(stringifyYaml(handoff)), handoffSchema, {
    name: 'handoff fixture',
  });
  validateHandoff(handoff, { evidenceRecord: evidence });
});
