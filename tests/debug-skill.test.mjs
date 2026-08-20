import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEBUG_SKILL = join(ROOT, 'skills', 'debug', 'SKILL.md');

test('Debug exposes focused and swarm modes for reproducible and pathless work', async () => {
  const skill = await readFile(DEBUG_SKILL, 'utf8');

  assert.match(skill, /Select one of two debug modes/u);
  assert.match(skill, /\*\*Focused mode:\*\*/u);
  assert.match(skill, /\*\*Swarm mode:\*\*/u);
  assert.match(skill, /symptom lacks a reliable reproduction/u);
  assert.match(skill, /broad bug-hunt request does not by itself justify repository-wide inventory/u);
  assert.match(skill, /Do not force Swarm mode after a clear low-risk reproduction/u);
  assert.match(skill, /never exceed three active workers/u);
});

test('Debug exposes bounded request-scoped swarm controls', async () => {
  const skill = await readFile(DEBUG_SKILL, 'utf8');

  for (const control of ['swarm', 'swarm-size', 'swarm-depth', 'intensity', 'fix-scope']) {
    assert.equal(skill.includes('`' + control + '`'), true, `missing ${control} control`);
  }
  assert.match(skill, /default to at most 2, and never exceed 4 even when asked/u);
  assert.match(skill, /Another wave requires a confirmed cause or a documented uncovered user path/u);
  assert.match(skill, /Keep swarm depth separate from `cruise worker --level <1-7>`/u);
  assert.match(skill, /Never persist or globally enforce them/u);
});

test('Debug preserves evidence, repair authority, and causal clustering', async () => {
  const skill = await readFile(DEBUG_SKILL, 'utf8');

  assert.match(skill, /asks for diagnosis, an audit, quality-control findings, or bug tickets, remain read-only/u);
  assert.match(skill, /Reproduce it independently or obtain equivalent deterministic evidence/u);
  assert.match(skill, /Cluster symptoms only when evidence supports the same causal mechanism/u);
  assert.match(skill, /Derive a causal signature from the confirmed defect/u);
  assert.match(skill, /Search for semantic siblings only within the changed mechanism and affected interfaces/u);
  assert.match(skill, /Treat semantic similarity as a lead, never as proof/u);
  assert.match(skill, /Include related bugs only when they are in scope, independently confirmed/u);
  assert.match(skill, /Keep discovery workers read-only with respect to product and repository state by default/u);
  assert.match(skill, /If the user forbids all file writes, avoid even temporary fixtures/u);
  assert.match(skill, /Do not let one worker hold the whole swarm open indefinitely/u);
  assert.match(skill, /Never call a sample exhaustive/u);
});
