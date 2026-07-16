import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCombinedPlanGoalPreview,
  renderPlanMarkdown,
} from '../scripts/lib/plan-renderer.mjs';

class MemoryOutput {
  value = '';

  write(chunk) {
    this.value += String(chunk);
  }
}

test('renders native Plan Markdown through Glow without flattening headings', () => {
  const output = new MemoryOutput();
  let invocation = null;
  const spawn = (command, args, options) => {
    invocation = { command, args, options };
    return { status: 0, stdout: 'rendered plan\n', stderr: '' };
  };

  const result = renderPlanMarkdown('# Plan\n\n## Goal\n', output, { spawn });

  assert.equal(result.renderer, 'glow');
  assert.equal(invocation.command, 'glow');
  assert.deepEqual(invocation.args, ['--preserve-new-lines', '--width', '100', '-']);
  assert.equal(invocation.options.input, '# Plan\n\n## Goal\n');
  assert.equal(output.value, 'rendered plan\n');
});

test('falls back to exact Markdown when Glow is unavailable', () => {
  const output = new MemoryOutput();
  const result = renderPlanMarkdown('## Plan\n\n- step', output, {
    spawn: () => ({ status: null, stdout: '', error: new Error('ENOENT') }),
  });

  assert.equal(result.renderer, 'markdown');
  assert.equal(output.value, '## Plan\n\n- step\n');
});

test('combined preview uses meaningful sections, full-file links, and both bound revisions', () => {
  const approval = {
    artifacts: [
      {
        path: '.cruise/goal/GOAL.md',
        absolutePath: '/repo with space/.cruise/goal/GOAL.md',
        sha256: 'a'.repeat(64),
        bytes: Buffer.from('# G-02: Safe rollout\n\nPreamble.\n\n## Objective\n\nShip safely.\n\n## Evidence\n\nProof.\n'),
      },
      {
        path: '.cruise/goal/PLAN.md',
        absolutePath: '/repo with space/.cruise/goal/PLAN.md',
        sha256: 'b'.repeat(64),
        bytes: Buffer.from('# Rollout plan\n\nNoise.\n\n## Steps\n\n1. Prepare.\n2. Verify.\n'),
      },
    ],
  };

  const preview = buildCombinedPlanGoalPreview(approval);

  assert.match(preview, /## Goal — G-02: Safe rollout/u);
  assert.match(preview, /### Objective\n\nShip safely\./u);
  assert.doesNotMatch(preview, /Preamble\./u);
  assert.match(preview, /## Plan — Rollout plan/u);
  assert.match(preview, /### Steps\n\n1\. Prepare\./u);
  assert.equal(preview.includes(`Goal \`${'a'.repeat(64)}\``), true);
  assert.equal(preview.includes(`Plan \`${'b'.repeat(64)}\``), true);
  assert.match(preview, /\[Open full Goal\]\(<\/repo with space\/\.cruise\/goal\/GOAL\.md>\)/u);
  assert.match(preview, /\[Open full Plan\]\(<\/repo with space\/\.cruise\/goal\/PLAN\.md>\)/u);
});

test('combined preview caps each artifact excerpt', () => {
  const approval = {
    artifacts: [
      {
        path: '.cruise/goal/GOAL.md',
        absolutePath: '/repo/GOAL.md',
        sha256: 'a'.repeat(64),
        bytes: Buffer.from(`# Goal\n\n## Summary\n\n${'goal line\n'.repeat(30)}`),
      },
      {
        path: '.cruise/goal/PLAN.md',
        absolutePath: '/repo/PLAN.md',
        sha256: 'b'.repeat(64),
        bytes: Buffer.from(`# Plan\n\n## Summary\n\n${'plan line\n'.repeat(30)}`),
      },
    ],
  };

  const preview = buildCombinedPlanGoalPreview(approval, { maxLinesPerArtifact: 2 });
  assert.match(preview, /goal line\ngoal line\n\n…/u);
  assert.match(preview, /plan line\nplan line\n\n…/u);
});
