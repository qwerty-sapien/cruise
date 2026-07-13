import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_PUBLIC_SKILLS,
  QUICK_HARD_GATE_FIXTURES,
  validateSuite,
} from '../scripts/validate-suite.mjs';
import {
  classifyRoute,
  createDeterministicProbe,
  derivePromptGateSignals,
} from '../scripts/lib/routing.mjs';
import { MODEL_IDS } from '../scripts/lib/model-policy.mjs';
import { assertYamlSchema, parseYaml } from '../scripts/lib/yaml-state.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = join(ROOT, 'evals', 'cases', 'suite-routing.yaml');
const RESULT_SCHEMA_PATH = join(ROOT, 'evals', 'routing-result.schema.yaml');
const CATEGORIES = ['positive', 'negative', 'boundary', 'adversarial'];

const REQUIRED_COVERAGE = Object.freeze([
  'mutual.typo_quick',
  'mutual.private_helper_closed',
  'mutual.exported_method_promotes',
  'mutual.oauth_goal',
  'mutual.admin_export_refine',
  'mutual.intermittent_hang_debug',
  'mutual.foundation_build',
  'mutual.cell_tracking_research',
  'mutual.research_to_implementation_handoff',
  'mutual.phase_goal',
  'mutual.broken_and_better_split',
  'origin.raw_prompt_immutable',
  'origin.ledgered_normalization',
  'origin.repository_cannot_replace_intent',
  'origin.traceability_ids',
  'origin.verifier_detects_omission',
  'routing.luna_threshold_once',
  'routing.terra_retry_once',
  'routing.persistent_uncertainty_preserves_selection',
  'routing.hard_gate_overrides_unsafe_quick',
  'routing.no_recursive_loop',
  'routing.model_resolution_recorded',
  'quick.focused_success',
  'quick.scope_expansion_promotes',
  'quick.two_repairs_promote',
  'quick.api_and_migration_rejected',
  'quick.no_formal_artifacts',
  'refine.zero_questions',
  'refine.one_to_three_questions',
  'refine.user_language_preserved',
  'refine.explicit_plan_approval',
  'refine.no_native_goal',
  'refine.independent_verification',
  'goal.approve_plan_exact',
  'goal.start_cruise_later_exact',
  'goal.plan_byte_lock',
  'goal.goal_byte_lock',
  'goal.no_write_after_start_selection',
  'goal.native_get_set',
  'goal.no_shell_goal',
  'goal.truthful_fallback',
  'goal.closeout_after_activation_only',
  'goal.origin_in_final_verification',
  'goal.milestone_controller_runtime',
  'debug.hypothesis_ledger',
  'debug.discriminating_experiments',
  'debug.failed_hypotheses_preserved',
  'debug.regression_test',
  'debug.root_cause_not_symptom',
  'debug.no_opportunistic_refactor',
  'build.bootstrap_mode',
  'build.milestone_mode',
  'build.discovery_internal',
  'build.inactive_boundary',
  'build.queue_persistent',
  'build.readme_gitignore_bootstrap',
  'build.generated_scaffold_bootstrap',
  'build.unviable_no_draft',
  'build.preapproval_research_resume',
  'build.research_contradiction_reopens',
  'build.automatic_draft_requires_approval',
  'research.repository_grounding',
  'research.source_hierarchy',
  'research.conflicting_evidence',
  'research.recommendation_uncertainty',
  'research.no_product_edits',
  'research.capability_provisioning',
  'provision.reuse_installed',
  'provision.trusted_local_install',
  'provision.smoke_failure',
  'provision.auth_wait',
  'provision.independent_sibling_continues',
  'provision.dependent_waits',
  'provision.resume_revalidates',
  'provision.no_secrets',
  'provision.untrusted_rejected',
  'provision.cycle_detection',
  'provision.hidden_publicly',
]);

async function loadYaml(path) {
  return parseYaml(await readFile(path, 'utf8'));
}

const CLASSIFIER_BOOLEAN_FIELDS = Object.freeze([
  'public_api_change',
  'abi_change',
  'data_migration',
  'security_sensitive',
  'concurrency_sensitive',
  'build_or_release_change',
  'unknown_indirect_callers',
  'requires_external_research',
]);

const CLASSIFIER_SIGNAL_FIELDS = Object.freeze({
  public_api_change: 'public_api_change',
  abi_change: 'abi_change',
  data_migration: 'data_or_serialization_migration',
  security_sensitive: 'cryptography_secrets_or_privacy',
  concurrency_sensitive: 'concurrency_ordering_cancellation_or_lifecycle',
  build_or_release_change: 'build_deployment_packaging_release_or_ci',
  unknown_indirect_callers: 'unknown_indirect_callers',
  requires_external_research: 'requires_external_research',
});

function deterministicModelCatalog() {
  return [
    {
      id: MODEL_IDS.luna,
      model: MODEL_IDS.luna,
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: ['medium'],
    },
    {
      id: MODEL_IDS.terra,
      model: MODEL_IDS.terra,
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: ['medium', 'high'],
    },
  ];
}

function caseProbeSignals(caseRecord) {
  const signals = { ...(caseRecord.probe_signals ?? {}) };
  for (const signal of derivePromptGateSignals(caseRecord.prompt)) {
    signals[signal] = signal === 'failed_quick_repairs'
      ? Math.max(signals[signal] ?? 0, 2)
      : true;
  }
  return signals;
}

function simulatedClassifierOutput(caseRecord, attempt, signals) {
  const retry = attempt === 2;
  const route = retry ? caseRecord.retry_route : caseRecord.initial_route;
  const confidence = retry ? caseRecord.retry_confidence : caseRecord.initial_confidence;
  return {
    route,
    recommended_level: caseRecord.recommended_level,
    confidence,
    ambiguity: confidence < 0.85 ? 'high' : 'low',
    semantic_risk: caseRecord.recommended_level >= 5
      ? 'high'
      : caseRecord.recommended_level >= 3
        ? 'medium'
        : 'low',
    estimated_files: Math.max(1, caseRecord.probe_facts.length),
    estimated_diff_lines: Math.max(1, caseRecord.probe_facts.length * 5),
    ...Object.fromEntries(CLASSIFIER_BOOLEAN_FIELDS.map((field) => [
      field,
      signals[CLASSIFIER_SIGNAL_FIELDS[field]] === true,
    ])),
    reasons: [`${caseRecord.id} deterministic fixture attempt ${attempt}`],
  };
}

async function executeRoutingCase(caseRecord, confidenceThreshold) {
  const signals = caseProbeSignals(caseRecord);
  const probe = createDeterministicProbe({
    repository: {
      root: ROOT,
      head: '0'.repeat(40),
      branch: 'eval-fixture',
      dirty: false,
    },
    likelySymbols: caseRecord.probe_facts,
    signals,
  });
  const requests = [];
  const routing = await classifyRoute({
    selectedSkill: caseRecord.selected_skill,
    rawPrompt: caseRecord.prompt,
    probe,
    modelCatalog: deterministicModelCatalog(),
    confidenceThreshold,
    classify(request) {
      requests.push(request);
      assert.equal(request.selected_skill, caseRecord.selected_skill, caseRecord.id);
      assert.equal(request.exact_raw_request, caseRecord.prompt, caseRecord.id);
      assert.deepEqual(request.deterministic_probe, probe, caseRecord.id);
      assert.equal(request.structured_output_only, true, caseRecord.id);
      assert.equal(requests.length <= 2, true, `${caseRecord.id} attempted recursive routing`);
      return simulatedClassifierOutput(caseRecord, requests.length, signals);
    },
  });
  return { probe, requests, routing };
}

function classifierAttempts(routing) {
  return routing.attempts.map(({ policy, output }, index) => ({
    attempt: index + 1,
    policy_tier: policy.requested.tier,
    reasoning: policy.requested.reasoning_effort,
    route: output.route,
    recommended_level: output.recommended_level,
    confidence: output.confidence,
    model_resolution_recorded: Boolean(policy.resolved?.source),
  }));
}

function assertMechanicallyDerivableWorkflowExpectations(caseRecord, routing) {
  if (routing.promotion_reasons.length > 0) {
    assert.equal(caseRecord.disposition, 'promote', `${caseRecord.id} promotion disposition`);
    assert.equal(caseRecord.handoff_required, true, `${caseRecord.id} promotion handoff`);
    assert.equal(caseRecord.handoff_target, routing.selected_route, `${caseRecord.id} promotion target`);
    return;
  }
  if (routing.uncertain && routing.selected_route === caseRecord.selected_skill) {
    assert.equal(
      caseRecord.disposition,
      'preserve_selection',
      `${caseRecord.id} persistent uncertainty disposition`,
    );
    return;
  }
  if (routing.selected_route !== caseRecord.selected_skill) {
    assert.equal(caseRecord.disposition, 'handoff', `${caseRecord.id} reroute disposition`);
    assert.equal(caseRecord.handoff_required, true, `${caseRecord.id} reroute handoff`);
    assert.equal(caseRecord.handoff_target, routing.selected_route, `${caseRecord.id} reroute target`);
  }
}

test('static Cruise suite contract passes as one executable check', () => {
  const result = validateSuite({ root: ROOT });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.public_skills, EXPECTED_PUBLIC_SKILLS);
  assert.equal(result.checks.every(({ status }) => status === 'PASS'), true);
});

test('routing fixture covers every public skill with positive, negative, boundary, and adversarial drills', async () => {
  const fixture = await loadYaml(FIXTURE_PATH);
  assert.equal(fixture.schema_version, 1);
  assert.equal(fixture.confidence_threshold, 0.85);
  assert.deepEqual(fixture.public_routes, EXPECTED_PUBLIC_SKILLS);
  assert.deepEqual(fixture.categories, CATEGORIES);
  assert.equal(fixture.result_schema, '../routing-result.schema.yaml');
  assert.equal(fixture.cases.length >= 36, true, 'routing matrix must remain substantive');

  const ids = new Set();
  for (const entry of fixture.cases) {
    assert.match(entry.id, /^[A-Z][A-Z0-9-]{2,}$/u);
    assert.equal(ids.has(entry.id), false, `duplicate case id ${entry.id}`);
    ids.add(entry.id);
    assert.equal(EXPECTED_PUBLIC_SKILLS.includes(entry.skill_under_test), true, entry.id);
    assert.equal(EXPECTED_PUBLIC_SKILLS.includes(entry.selected_skill), true, entry.id);
    assert.equal(CATEGORIES.includes(entry.category), true, entry.id);
    assert.equal(typeof entry.prompt, 'string', entry.id);
    assert.equal(entry.prompt.length > 10, true, entry.id);
    assert.equal(Array.isArray(entry.probe_facts) && entry.probe_facts.length > 0, true, entry.id);
    assert.equal(
      entry.probe_signals == null || (
        typeof entry.probe_signals === 'object' &&
        !Array.isArray(entry.probe_signals)
      ),
      true,
      `${entry.id} probe_signals must be a mapping when present`,
    );
    assert.equal(EXPECTED_PUBLIC_SKILLS.includes(entry.initial_route), true, entry.id);
    assert.equal(entry.initial_confidence >= 0 && entry.initial_confidence <= 1, true, entry.id);
    assert.equal(EXPECTED_PUBLIC_SKILLS.includes(entry.expected_route), true, entry.id);
    assert.equal(Number.isInteger(entry.recommended_level), true, `${entry.id} needs an integer recommended_level`);
    assert.equal(entry.recommended_level >= 2 && entry.recommended_level <= 7, true, entry.id);
    assert.equal(entry.allowed_routes.includes(entry.expected_route), true, entry.id);
    assert.equal(Array.isArray(entry.assertions) && entry.assertions.length > 0, true, entry.id);
    assert.equal(Array.isArray(entry.coverage), true, entry.id);
    if (entry.initial_confidence < fixture.confidence_threshold) {
      assert.equal(EXPECTED_PUBLIC_SKILLS.includes(entry.retry_route), true, `${entry.id} needs one Terra retry`);
      assert.equal(entry.retry_confidence >= 0 && entry.retry_confidence <= 1, true, entry.id);
    } else {
      assert.equal(entry.retry_route, null, `${entry.id} must stop after confident Luna routing`);
      assert.equal(entry.retry_confidence, null, entry.id);
    }
    if (entry.handoff_required) {
      assert.equal(EXPECTED_PUBLIC_SKILLS.includes(entry.handoff_target), true, entry.id);
    } else {
      assert.equal(entry.handoff_target, null, entry.id);
    }
    if (entry.expected_route === 'build' || entry.expected_route === 'research') {
      assert.equal(entry.writes, 'product_forbidden', `${entry.id} violates the read-only route`);
    }
    if (entry.disposition === 'preserve_selection') {
      assert.equal(entry.expected_route, entry.selected_skill, entry.id);
    }
  }

  for (const skill of EXPECTED_PUBLIC_SKILLS) {
    const categories = new Set(
      fixture.cases
        .filter((entry) => entry.skill_under_test === skill)
        .map((entry) => entry.category),
    );
    assert.deepEqual([...categories].sort(), [...CATEGORIES].sort(), `${skill} lacks a case class`);
  }
});

test('routing fixture locks every minimum behavioral scenario and hard Quick gate', async () => {
  const fixture = await loadYaml(FIXTURE_PATH);
  assert.deepEqual(fixture.minimum_coverage, REQUIRED_COVERAGE);
  const covered = new Set(fixture.cases.flatMap((entry) => entry.coverage));
  for (const requirement of REQUIRED_COVERAGE) {
    assert.equal(covered.has(requirement), true, `missing behavioral case for ${requirement}`);
  }

  const expectedGates = new Map(QUICK_HARD_GATE_FIXTURES);
  const fixtureGates = new Map();
  for (const gate of fixture.hard_quick_gates) {
    assert.equal(fixtureGates.has(gate.signal), false, `duplicate hard gate ${gate.signal}`);
    fixtureGates.set(gate.signal, gate.value);
    assert.equal(gate.allowed_routes.includes('quick'), false, `${gate.signal} cannot remain Quick`);
    assert.equal(gate.allowed_routes.length > 0, true, gate.signal);
  }
  assert.deepEqual(fixtureGates, expectedGates);

  const mutuallyExclusive = new Map([
    ['mutual.typo_quick', ['quick']],
    ['mutual.private_helper_closed', ['quick']],
    ['mutual.exported_method_promotes', ['refine', 'goal']],
    ['mutual.oauth_goal', ['goal']],
    ['mutual.admin_export_refine', ['refine']],
    ['mutual.intermittent_hang_debug', ['debug']],
    ['mutual.foundation_build', ['build']],
    ['mutual.cell_tracking_research', ['research']],
    ['mutual.research_to_implementation_handoff', ['refine', 'goal']],
    ['mutual.phase_goal', ['goal']],
    ['mutual.broken_and_better_split', ['debug']],
  ]);
  for (const [coverage, allowed] of mutuallyExclusive) {
    const matches = fixture.cases.filter((entry) => entry.coverage.includes(coverage));
    assert.equal(matches.length >= 1, true, coverage);
    for (const entry of matches) {
      assert.equal(allowed.includes(entry.expected_route), true, `${coverage} routed to ${entry.expected_route}`);
    }
  }
});

test('every routing fixture executes the real router and emits a schema-valid result', async () => {
  const fixture = await loadYaml(FIXTURE_PATH);
  const schema = await loadYaml(RESULT_SCHEMA_PATH);
  for (const entry of fixture.cases) {
    const execution = await executeRoutingCase(entry, fixture.confidence_threshold);
    const { routing, requests } = execution;
    const expectedAttempts = entry.initial_confidence < fixture.confidence_threshold ? 2 : 1;
    assert.equal(routing.selected_route, entry.expected_route, `${entry.id} selected route`);
    assert.equal(routing.recommended_level, entry.recommended_level, `${entry.id} level`);
    assert.equal(requests.length, expectedAttempts, `${entry.id} classifier attempts`);
    assert.equal(routing.attempts.length, expectedAttempts, `${entry.id} recorded attempts`);
    assert.equal(routing.initial_classifier.policy.requested.tier, 'luna', entry.id);
    if (expectedAttempts === 2) {
      assert.equal(routing.retry_classifier.policy.requested.tier, 'terra', entry.id);
      assert.deepEqual(
        requests[1].previous_classifier_output,
        routing.initial_classifier.output,
        `${entry.id} Terra retry must receive Luna output`,
      );
    } else {
      assert.equal(routing.retry_classifier, null, entry.id);
    }
    assert.equal(entry.allowed_routes.includes(routing.selected_route), true, entry.id);
    assertMechanicallyDerivableWorkflowExpectations(entry, routing);

    const result = {
      schema_version: 1,
      case_id: entry.id,
      observed_route: routing.selected_route,
      recommended_level: routing.recommended_level,
      disposition: entry.disposition,
      classifier_attempts: classifierAttempts(routing),
      promotion_reasons: [...routing.promotion_reasons],
      handoff: {
        required: entry.handoff_required,
        target: entry.handoff_target,
        reason: entry.handoff_required ? entry.assertions[0] : null,
      },
      writes: entry.writes,
      checks: [{ id: 'route_matches_expected', status: 'PASS', evidence_ids: ['E-01'] }],
      evidence: [{
        id: 'E-01',
        kind: 'classifier',
        observation: `executed route ${routing.selected_route} at level ${routing.recommended_level}; probe digest ${routing.deterministic_probe_digest}`,
      }],
    };
    assertYamlSchema(result, schema, { name: entry.id });
  }
});
