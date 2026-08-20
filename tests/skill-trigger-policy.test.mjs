import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveAppiEnforcement,
  shouldActivateSkill,
  skillTriggerInstructions,
} from '../scripts/lib/skill-trigger-policy.mjs';
import { claudeSessionArgs } from '../scripts/lib/claude-cli.mjs';

test('broad skills stay inactive for ordinary bounded engineering', () => {
  const request = 'Implement a deterministic parser bug fix with its focused test.';
  for (const name of [
    'seeking-alpha',
    'dag-prompts',
    'auto-experiment',
    'ship-kaggle-kernels',
    'noconflict-env',
  ]) {
    assert.equal(shouldActivateSkill(name, { request }), false, name);
  }
});

test('each skill activates only at its named decision boundary', () => {
  assert.equal(shouldActivateSkill('seeking-alpha', { request: 'Run a research-edge novelty search.' }), true);
  assert.equal(shouldActivateSkill('dag-prompts', { request: 'Build this preregistered DAG.' }), true);
  assert.equal(shouldActivateSkill('dag-prompts', { request: 'Coordinate work.', independentUnits: 3 }), true);
  assert.equal(shouldActivateSkill('auto-experiment', { request: 'Compare two models with a protected holdout.' }), true);
  assert.equal(shouldActivateSkill('ship-kaggle-kernels', { request: 'Edit training code.' }), false);
  assert.equal(shouldActivateSkill('ship-kaggle-kernels', { boundary: 'certification' }), true);
  assert.equal(shouldActivateSkill('noconflict-env', {
    request: 'Resolve this NumPy dependency ABI conflict.',
    exactDependencyOrInterpreter: true,
  }), true);
  assert.equal(shouldActivateSkill('noconflict-env', {
    request: 'Inventory the environment just in case.',
    exactDependencyOrInterpreter: false,
  }), false);
});

test('APPI enforcement obeys the selected scan and avoids recursive debug after a pass', () => {
  assert.deepEqual(resolveAppiEnforcement({
    requiredScan: 'AFFECTED_SCOPE',
    affectedBehavior: 'passing',
  }), {
    required_scan: 'AFFECTED_SCOPE',
    recursive_debug: false,
  });
  assert.equal(resolveAppiEnforcement({
    requiredScan: 'FULL',
    affectedBehavior: 'ambiguous',
  }).recursive_debug, true);
  assert.equal(resolveAppiEnforcement({
    requiredScan: 'NONE',
    affectedBehavior: 'failing',
  }).recursive_debug, false);
  assert.throws(() => resolveAppiEnforcement({ requiredScan: 'RECURSIVE_FULL' }), /NONE/u);
});

test('Codex and Claude host instructions consume the narrow trigger policy', () => {
  const instructions = skillTriggerInstructions();
  assert.match(instructions, /seeking-alpha only for an explicit novelty/u);
  assert.match(instructions, /appi-enforcement, obey NONE, AFFECTED_SCOPE, or FULL/u);
  const claudeArgs = claudeSessionArgs({
    pluginRoot: '/tmp/cruise-plugin',
    skill: 'quick',
    prompt: 'Fix one parser branch.',
  });
  assert.match(claudeArgs.join(' '), /auto-experiment only for an actual experiment/u);
});
