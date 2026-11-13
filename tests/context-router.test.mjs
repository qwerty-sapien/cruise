import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs } from '../scripts/cruise.mjs';

import {
  escalateModelPolicy,
  MODEL_POLICY_DEFAULTS,
  resolveModelPolicy,
} from '../scripts/lib/model-policy.mjs';
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
        supportedReasoningEfforts: ['medium', 'high', 'xhigh', 'ultra'],
      },
      {
        id: 'gpt-5.6-sol',
        model: 'gpt-5.6-sol',
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: ['high', 'xhigh', 'ultra', 'max'],
      },
      {
        id: 'gpt-6-astra',
        model: 'gpt-6-astra',
        hidden: false,
        isDefault: false,
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: ['high', 'xhigh', 'ultra'],
      },
    ],
  };
}

test('stage defaults preserve their semantic levels on the new ladder', () => {
  const expected = {
    initial_classification: ['luna', 'medium'],
    bounded_repository_mapping: ['terra', 'xhigh'],
    capability_inventory: ['terra', 'xhigh'],
    quick_implementation: ['sol', 'xhigh'],
    quick_verification: ['sol', 'xhigh'],
    goal_clarification_and_planning: ['sol', 'xhigh'],
    normal_planned_execution: ['sol', 'xhigh'],
    independent_normal_verification: ['sol', 'xhigh'],
    debug_hypothesis_generation: ['sol', 'xhigh'],
    difficult_debug_or_failed_normal_execution: ['astra', 'high'],
    architectural_or_consequential_implementation: ['astra', 'high'],
    repeated_failure_or_exceptional_consequence: ['sol', 'ultra'],
    research_retrieval_and_extraction: ['terra', 'xhigh'],
    research_synthesis_and_recommendation: ['sol', 'xhigh'],
    high_conflict_or_frontier_research: ['astra', 'high'],
    routine_structured_scans: ['terra', 'xhigh'],
  };
  assert.deepEqual(Object.keys(MODEL_POLICY_DEFAULTS), Object.keys(expected));
  for (const [stage, [tier, reasoningEffort]] of Object.entries(expected)) {
    assert.deepEqual(MODEL_POLICY_DEFAULTS[stage], {
      tier,
      reasoning_effort: reasoningEffort,
    });
  }
});

test('generic evidenced escalation follows the non-monotonic ladder', () => {
  let policy = resolveModelPolicy({ stage: 'initial_classification', catalog: catalog() });
  const expected = [
    ['terra', 'xhigh'],
    ['terra', 'ultra'],
    ['sol', 'xhigh'],
    ['astra', 'high'],
    ['sol', 'ultra'],
  ];
  for (const [tier, reasoningEffort] of expected) {
    policy = escalateModelPolicy(policy, {
      catalog: catalog(),
      reason: `evidence requires ${tier} ${reasoningEffort}`,
    });
    assert.equal(policy.requested.tier, tier);
    assert.equal(policy.requested.reasoning_effort, reasoningEffort);
  }

  const standardFinal = escalateModelPolicy(policy, {
    catalog: catalog(),
    reason: 'evidence requires the reviewed final ladder level',
  });
  assert.equal(standardFinal.requested.tier, 'astra');
  assert.equal(standardFinal.requested.reasoning_effort, 'xhigh');

  const exceptionalFinal = escalateModelPolicy(policy, {
    catalog: catalog(),
    reason: 'exceptional evidence requires the strongest Astra review',
    reasoningEffort: 'ultra',
  });
  assert.equal(exceptionalFinal.requested.tier, 'astra');
  assert.equal(exceptionalFinal.requested.reasoning_effort, 'ultra');
});

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
    [2, 'gpt-5.6-terra', 'xhigh'],
    [3, 'gpt-5.6-terra', 'ultra'],
    [4, 'gpt-5.6-sol', 'xhigh'],
    [5, 'gpt-6-astra', 'high'],
    [6, 'gpt-5.6-sol', 'ultra'],
    [7, 'gpt-6-astra', 'xhigh'],
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
  const directLevelSeven = resolveWorkerPolicy({
    recommendedLevel: routed.recommended_level,
    catalog: catalog(),
    exceptionalConsequence: routed.exceptional_consequence,
  });
  assert.equal(directLevelSeven.worker.requested.model_id, 'gpt-6-astra');
  assert.equal(directLevelSeven.worker.requested.reasoning_effort, 'xhigh');
  assert.equal(directLevelSeven.transition, undefined);

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
    failureCategory: 'reasoning',
  });
  assert.equal(levelSeven.recommended_level, 7);
  assert.equal(levelSeven.worker.requested.model_id, 'gpt-6-astra');
  assert.equal(levelSeven.worker.requested.reasoning_effort, 'ultra');
  assert.equal(levelSeven.transition.from_level, 6);
  assert.equal(levelSeven.transition.failure_category, 'reasoning');
  assert.equal(levelSeven.transition.exceptional_consequence.rationale, 'the focused trace proves there is no rollback path');
});
