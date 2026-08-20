import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs } from '../scripts/cruise.mjs';

import {
  resolveRootPolicy,
  selectRootRequest,
} from '../scripts/lib/root-policy.mjs';
import {
  classifyWorkerTask,
  deescalateWorkerPolicy,
  escalateWorkerPolicy,
  resolveWorkerPolicy,
  routeWorkerTask,
  WORKER_LEVEL_POLICY,
} from '../scripts/lib/worker-policy.mjs';

function catalog() {
  return {
    data: [
      {
        id: 'gpt-5.6-luna',
        model: 'gpt-5.6-luna',
        hidden: false,
        isDefault: false,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: ['medium'],
      },
      {
        id: 'gpt-5.6-terra',
        model: 'gpt-5.6-terra',
        hidden: false,
        isDefault: false,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: ['medium', 'high', 'xhigh'],
      },
      {
        id: 'gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: ['high', 'xhigh', 'ultra', 'max'],
      },
    ],
  };
}

test('Goal root is explicitly Sol high and weaker overrides require a diagnostic record', () => {
  const policy = resolveRootPolicy({ catalog: catalog() });
  assert.equal(policy.requested.model, 'gpt-5.6-sol');
  assert.equal(policy.requested.reasoning_effort, 'high');
  assert.equal(policy.resolved.model, 'gpt-5.6-sol');
  assert.equal(policy.role, 'coordinator_integrator_final_reviewer');
  assert.equal(policy.substantive_worker_work, false);

  assert.throws(
    () => selectRootRequest({ override: { model: 'gpt-5.6-terra', reasoning_effort: 'xhigh' } }),
    /at least Sol high/u,
  );
  assert.deepEqual(
    selectRootRequest({
      override: { model: 'gpt-5.6-terra', reasoning_effort: 'xhigh' },
      cheaperDiagnostic: true,
    }),
    {
      model: 'gpt-5.6-terra',
      reasoning_effort: 'xhigh',
      tier: 'terra',
      source: 'user_override',
      cheaper_diagnostic: true,
    },
  );

  const strong = parseArgs([
    'goal',
    '--root-model',
    'gpt-5.6-sol',
    '--root-effort',
    'xhigh',
    'review',
    'the',
    'change',
  ], { env: {} });
  assert.equal(strong.rootModel, 'gpt-5.6-sol');
  assert.equal(strong.rootEffort, 'xhigh');
  const diagnostic = parseArgs([
    'goal',
    '--root-model',
    'gpt-5.6-terra',
    '--root-effort',
    'xhigh',
    '--cheaper-diagnostic',
    'diagnose',
    'only',
  ], { env: {} });
  assert.equal(diagnostic.cheaperDiagnostic, true);
  assert.throws(
    () => parseArgs(['goal', '--root-model', 'gpt-5.6-sol', 'incomplete'], { env: {} }),
    /must be supplied together/u,
  );
});

test('every L1 through L7 mapping is exact', () => {
  const expected = [
    [1, 'gpt-5.6-luna', 'medium'],
    [2, 'gpt-5.6-terra', 'medium'],
    [3, 'gpt-5.6-terra', 'high'],
    [4, 'gpt-5.6-terra', 'xhigh'],
    [5, 'gpt-5.6-sol', 'high'],
    [6, 'gpt-5.6-sol', 'xhigh'],
    [7, 'gpt-5.6-sol', 'ultra'],
  ];
  for (const [level, model, effort] of expected) {
    const policy = resolveWorkerPolicy({
      recommendedLevel: level,
      catalog: catalog(),
      ...(level === 7
        ? {
            exceptionalConsequence: {
              consequence: 'exceptional irreversible effect',
              rationale: 'the exact mapping is reviewed at L7',
            },
          }
        : {}),
    });
    assert.equal(WORKER_LEVEL_POLICY[level].reasoning_effort, effort);
    assert.equal(policy.worker.requested.model_id, model);
    assert.equal(policy.worker.requested.reasoning_effort, effort);
  }
});

test('complexity routing is deterministic and every consequence trigger floors at L5', () => {
  const levels = {
    naming: 1,
    retrieval: 2,
    bounded: 3,
    complex: 4,
    consequential: 5,
    repeated: 6,
  };
  for (const [complexity, level] of Object.entries(levels)) {
    assert.equal(classifyWorkerTask({ task: 'one narrow item', complexity }).recommended_level, level);
  }
  for (const task of [
    'change authorization',
    'process PII retention',
    'process biometrics',
    'repair payment flow',
    'fix signing replay idempotency concurrency',
    'database migration with RLS',
    'protected holdout scorer estimand statistical claim',
    'perform production external action',
    'control hardware physical effects',
  ]) {
    const routed = routeWorkerTask({ task, complexity: 'retrieval' });
    assert.equal(routed.recommended_level, 5, task);
    assert.ok(routed.consequence_matches.length > 0, task);
  }
});

test('escalation requires narrow new evidence, rejects transport causes, and permits later de-escalation', () => {
  const initial = resolveWorkerPolicy({ recommendedLevel: 3, catalog: catalog() });
  assert.throws(
    () => escalateWorkerPolicy(initial, {
      catalog: catalog(),
      reason: 'retry harder',
      evidence: 'same failure',
      workItem: 'parser branch',
      failureCategory: 'transport',
    }),
    /does not justify/u,
  );
  const escalated = escalateWorkerPolicy(initial, {
    catalog: catalog(),
    reason: 'new invariant contradiction',
    evidence: 'focused test proves the caller violates the documented branch invariant',
    workItem: 'parser branch only',
  });
  assert.equal(escalated.recommended_level, 4);
  assert.equal(escalated.transition.kind, 'escalation');

  const deescalated = deescalateWorkerPolicy(escalated, {
    catalog: catalog(),
    targetLevel: 2,
    workItem: 'read-only caller inventory',
    evidence: 'the contradiction is isolated to one caller and no edit is authorized',
  });
  assert.equal(deescalated.recommended_level, 2);
  assert.equal(deescalated.transition.kind, 'deescalation');
});

test('L7 requires an explicit exceptional-consequence record', () => {
  assert.throws(
    () => routeWorkerTask({ task: 'exceptional narrow task', complexity: 'exceptional' }),
    /explicit exceptional-consequence record/u,
  );
  const routed = routeWorkerTask({
    task: 'exceptional narrow task',
    complexity: 'exceptional',
    exceptionalConsequence: {
      consequence: 'irreversible cross-tenant production effect',
      rationale: 'failure would affect regulated records across tenants',
    },
  });
  assert.equal(routed.recommended_level, 7);
  assert.equal(routed.exceptional_consequence.consequence, 'irreversible cross-tenant production effect');

  const levelSix = resolveWorkerPolicy({ recommendedLevel: 6, catalog: catalog() });
  assert.throws(() => escalateWorkerPolicy(levelSix, {
    catalog: catalog(),
    reason: 'confirmed exceptional consequence',
    evidence: 'the isolated operation crosses an irreversible production boundary',
    workItem: 'single production operation',
  }), /explicit exceptional-consequence record/u);
  const levelSeven = escalateWorkerPolicy(levelSix, {
    catalog: catalog(),
    reason: 'confirmed exceptional consequence',
    evidence: 'the isolated operation crosses an irreversible production boundary',
    workItem: 'single production operation',
    exceptionalConsequence: {
      consequence: 'irreversible production effect',
      rationale: 'the focused trace proves there is no rollback path',
    },
  });
  assert.equal(levelSeven.recommended_level, 7);
  assert.equal(levelSeven.transition.exceptional_consequence.rationale, 'the focused trace proves there is no rollback path');
});
