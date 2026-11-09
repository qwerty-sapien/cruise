import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { COLLABORATIVE_GIT_SYNC_INSTRUCTIONS } from '../scripts/lib/git-sync-policy.mjs';

const ROOT = new URL('../', import.meta.url);
const ROOT_SKILLS = ['build', 'debug', 'goal', 'quick'];

test('the shared policy preserves preview-before-integration semantics', () => {
  const policy = COLLABORATIVE_GIT_SYNC_INSTRUCTIONS;
  assert.match(policy, /git shortlog -n -s HEAD -- <path>/u);
  assert.match(policy, /Ignore `qwerty-sapien`/u);
  assert.match(policy, /git fetch/u);
  assert.match(policy, /git log HEAD\.\.<incoming-ref>/u);
  assert.match(policy, /git log -p HEAD\.\.<incoming-ref>/u);
  assert.match(policy, /git diff HEAD\.\.\.<incoming-ref>/u);
  assert.match(policy, /fast-forward-only/u);
  assert.match(policy, /cherry-pick the\s+exact commit OIDs/u);
  assert.match(policy, /wholesale destruction, modification, or revamp/u);
  assert.match(policy, /do not pull/u);
});

test('every direct root skill routes to the shared policy', async () => {
  for (const skill of ROOT_SKILLS) {
    const source = await readFile(new URL(`skills/${skill}/SKILL.md`, ROOT), 'utf8');
    assert.match(
      source,
      /context-economy\/references\/COLLABORATIVE_GIT_SYNC\.md/u,
      `${skill} does not route to the shared policy`,
    );
    assert.match(source, /workers do not synchronize the checkout independently/u);
  }
});
