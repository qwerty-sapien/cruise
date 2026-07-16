import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { MODEL_IDS, MODEL_POLICY_DEFAULTS } from '../scripts/lib/model-policy.mjs';
import { assertYamlSchema, parseYaml } from '../scripts/lib/yaml-state.mjs';
import {
  escalateWorkerPolicy,
  normalizeRecommendedLevel,
  resolveWorkerPolicy,
  WORKER_LEVEL_POLICY,
  WORKER_POLICY_RECORD_SCHEMA,
} from '../scripts/lib/worker-policy.mjs';

function modelCatalog() {
  return [
    {
      id: MODEL_IDS.luna,
      model: MODEL_IDS.luna,
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: ['low', 'medium', 'high'],
    },
    {
      id: MODEL_IDS.terra,
      model: MODEL_IDS.terra,
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: ['medium', 'high', 'xhigh'],
    },
    {
      id: MODEL_IDS.sol,
      model: MODEL_IDS.sol,
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: ['high', 'xhigh', 'ultra'],
    },
  ];
}

test('recommended levels map exactly to seven managed Codex agents', () => {
  const expected = [
    [1, 'cruise_l1', MODEL_IDS.luna, 'medium'],
    [2, 'cruise_l2', MODEL_IDS.terra, 'medium'],
    [3, 'cruise_l3', MODEL_IDS.terra, 'high'],
    [4, 'cruise_l4', MODEL_IDS.terra, 'xhigh'],
    [5, 'cruise_l5', MODEL_IDS.sol, 'high'],
    [6, 'cruise_l6', MODEL_IDS.sol, 'xhigh'],
    [7, 'cruise_l7', MODEL_IDS.sol, 'ultra'],
  ];
  assert.equal(Object.keys(WORKER_LEVEL_POLICY).length, 7);
  for (const [level, agentType, model, effort] of expected) {
    const policy = resolveWorkerPolicy({ recommendedLevel: level, catalog: modelCatalog() });
    assert.equal(policy.recommended_level, level);
    assert.equal(policy.worker.agent_type, agentType);
    assert.equal(policy.worker.requested.model_id, model);
    assert.equal(policy.worker.requested.reasoning_effort, effort);
    assert.equal(policy.worker.resolved.model_id, model);
    assert.equal(policy.worker.resolved.reasoning_effort, effort);
    assert.equal(policy.degraded, false);
    assert.deepEqual(policy.coordinator, {
      role: 'root_coordinator',
      model_mutation_allowed: false,
      substantive_work_allowed: false,
      spawns_worker: true,
    });
  }
});

test('checked-in stage defaults preserve exact model policy under worker levels', async () => {
  const source = await readFile(
    new URL('../internal/shared/model-policy.yaml', import.meta.url),
    'utf8',
  );
  const config = parseYaml(source);
  assert.equal(config.root_coordinator.change_model, 'native_cruise_class_only');
  assert.equal(config.root_coordinator.substantive_work, 'forbidden');
  assert.deepEqual(config.cruise_classes.classes, {
    'budget-cruise': 3,
    'normal-cruise': 4,
    'premium-cruise': 5,
    'luxury-cruise': 6,
  });
  for (const [level, selection] of Object.entries(WORKER_LEVEL_POLICY)) {
    const configured = config.recommended_levels[level];
    assert.equal(configured.agent_type, selection.agent_type);
    assert.equal(configured.alias, selection.alias);
    assert.equal(configured.model, MODEL_IDS[selection.tier]);
    assert.equal(configured.reasoning, selection.reasoning_effort);
  }
  assert.deepEqual(config.stages.bounded_repository_identity_probe, {
    recommended_level: 1,
    coordinator_only: true,
    deterministic_tools_only: true,
  });
  assert.equal(config.stages.semantic_repository_mapping.recommended_level, 2);
  assert.equal(config.stages.capability_inventory.recommended_level, 2);
  assert.equal(config.stages.quick_implementation.recommended_level, 'class_default');
  assert.equal(config.stages.quick_implementation.minimum_level, 3);
  assert.equal(config.stages.quick_verification.recommended_level, 'class_default');
  assert.equal(config.stages.refine_planning.recommended_level, 'class_default');
  assert.equal(config.stages.normal_planned_execution.recommended_level, 'class_default');
  assert.equal(config.stages.independent_normal_verification.recommended_level, 'class_default');
  assert.equal(config.stages.debug_hypothesis_generation.recommended_level, 'class_default');
  assert.equal(config.stages.difficult_debug_or_failed_normal_execution.minimum_level, 5);
  assert.equal(config.stages.architectural_or_consequential_implementation.minimum_level, 5);
  assert.equal(config.stages.repeated_failure_or_exceptional_consequence.minimum_level, 6);
  assert.equal(config.stages.extreme_safety_critical_adjudication.recommended_level, 7);
  assert.equal(config.stages.research_retrieval_and_extraction.recommended_level, 2);
  assert.equal(config.stages.research_synthesis_and_recommendation.recommended_level, 'class_default');
  assert.equal(config.stages.high_conflict_or_frontier_research.minimum_level, 5);
  assert.equal(config.stages.routine_structured_scans.recommended_level, 2);
});

test('runtime model defaults never select Luna for a substantive worker phase', () => {
  assert.deepEqual(MODEL_POLICY_DEFAULTS.initial_classification, {
    tier: 'luna',
    reasoning_effort: 'medium',
  });
  for (const stage of [
    'bounded_repository_mapping',
    'capability_inventory',
    'research_retrieval_and_extraction',
    'routine_structured_scans',
  ]) {
    assert.deepEqual(MODEL_POLICY_DEFAULTS[stage], {
      tier: 'terra',
      reasoning_effort: 'medium',
    });
  }
});

test('recommended_level is strictly bounded to integer levels 1 through 7', () => {
  for (const invalid of [null, '2', 0, 8, 2.5]) {
    assert.throws(() => normalizeRecommendedLevel(invalid), /recommended_level/);
  }
  assert.equal(normalizeRecommendedLevel(1), 1);
  assert.equal(normalizeRecommendedLevel(2), 2);
  assert.equal(normalizeRecommendedLevel(7), 7);
});

test('checked-in worker schema validates emitted policy records', async () => {
  const policy = resolveWorkerPolicy({ recommendedLevel: 4, catalog: modelCatalog() });
  const policySchema = parseYaml(await readFile(
    new URL('../internal/schemas/worker-policy.schema.yaml', import.meta.url),
    'utf8',
  ));
  assertYamlSchema(policy, WORKER_POLICY_RECORD_SCHEMA);
  assertYamlSchema(policy, policySchema);
});

test('model/list degradation is recorded and forbidden from masquerading as the requested worker', () => {
  const withoutSol = modelCatalog().filter((entry) => entry.id !== MODEL_IDS.sol);
  const policy = resolveWorkerPolicy({ recommendedLevel: 7, catalog: withoutSol });
  assert.equal(policy.worker.requested.model_id, MODEL_IDS.sol);
  assert.equal(policy.worker.resolved.model_id, MODEL_IDS.luna);
  assert.equal(policy.degraded, true);
  assert.equal(policy.degradation_reasons.some((reason) => /unavailable/u.test(reason)), true);

});

test('a same-tier model-version change is degraded without an exact catalog match', () => {
  const upgraded = modelCatalog().map((entry) => ({
    ...entry,
    id: entry.id.replace('gpt-5.6-', 'gpt-5.7-'),
    model: entry.model.replace('gpt-5.6-', 'gpt-5.7-'),
  }));
  const policy = resolveWorkerPolicy({ recommendedLevel: 4, catalog: upgraded });
  assert.equal(policy.worker.requested.model_id, MODEL_IDS.terra);
  assert.equal(policy.worker.resolved.model_id, 'gpt-5.7-luna');
  assert.equal(policy.worker.resolution_source, 'catalog_default');
  assert.equal(policy.degraded, true);
  assert.match(policy.degradation_reasons.join(' '), /gpt-5\.6-terra is unavailable/u);
});

test('reviewed worker escalation histories are monotonic, cross Terra to Sol, and remain at seven', () => {
  for (let level = 2; level <= 7; level += 1) {
    const initial = resolveWorkerPolicy({ recommendedLevel: level, catalog: modelCatalog() });
    const second = escalateWorkerPolicy(initial, {
      catalog: modelCatalog(),
      reason: 'one evidenced soft execution failure',
    });
    assert.equal(second.recommended_level, Math.min(level + 1, 7));
    assert.equal(second.attempt_number, 2);
    assert.equal(second.soft_escalation_reason, 'one evidenced soft execution failure');
    const third = escalateWorkerPolicy(second, {
      catalog: modelCatalog(),
      reason: 'another evidenced soft execution failure',
    });
    assert.equal(third.recommended_level, Math.min(level + 2, 7));
    assert.equal(third.attempt_number, 3);
    assert.equal(third.soft_escalation_reason, 'another evidenced soft execution failure');
  }

  const terra = resolveWorkerPolicy({ recommendedLevel: 4, catalog: modelCatalog() });
  const sol = escalateWorkerPolicy(terra, { catalog: modelCatalog(), reason: 'soft failure' });
  assert.equal(terra.worker.agent_type, 'cruise_l4');
  assert.equal(sol.worker.agent_type, 'cruise_l5');
  assert.equal(sol.worker.requested.reasoning_effort, 'high');
});
