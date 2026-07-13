import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  allocateStableId,
  assertFinalTraceability,
  assertOriginCoverage,
  assertStableTraceability,
  createTaskTrace,
  createTraceabilityRecord,
  originClauses,
  parseTraceId,
  traceabilityCoverage,
  traceabilityDigest,
  validateTraceability,
} from '../scripts/lib/traceability.mjs';
import { createOriginRecord } from '../scripts/lib/origin.mjs';
import {
  assertYamlSchema,
  parseYaml,
  readYamlFile,
  stringifyYaml,
  validateYamlSchema,
  writeYamlFile,
  YamlParseError,
  YamlSchemaError,
} from '../scripts/lib/yaml-state.mjs';

function completeTraceability() {
  return createTraceabilityRecord({
    goal_clauses: [{ id: 'G-01', text: 'Preserve the public outcome.' }],
    requirements: [
      { id: 'R-01', text: 'Implement the behavior.' },
      { id: 'R-02', text: 'Keep compatibility.' },
    ],
    acceptance_criteria: [{ id: 'AC-01', text: 'Focused test passes.' }],
    decisions: [{ id: 'D-01', text: 'Use the existing interface.' }],
    evidence: [
      { id: 'E-01', kind: 'test', result: 'pass' },
      { id: 'E-02', kind: 'diff', result: 'within scope' },
    ],
    findings: [{ id: 'F-01', severity: 'warning' }],
    hypotheses: [{ id: 'H-01', status: 'rejected' }],
    tasks: [
      createTaskTrace({
        taskId: 'T-01',
        satisfies: ['R-01', 'AC-01'],
        preserves: ['G-01', 'R-02'],
        verification: ['E-01', 'E-02'],
        title: 'Implement and verify',
      }),
    ],
  });
}

test('deterministic YAML round-trips nested state and exact prompt characters', () => {
  const value = {
    schema_version: 1,
    origin: {
      raw_prompt: 'line one\r\nline two  \n',
      quoted: 'yes: # still text',
    },
    tasks: [
      { task_id: 'T-01', satisfies: ['R-01', 'AC-01'], done: false },
      { task_id: 'T-02', satisfies: [], done: true },
    ],
    nullable: null,
  };
  const first = stringifyYaml(value);
  const second = stringifyYaml(structuredClone(value));
  assert.equal(first, second);
  assert.match(first, /^nullable:/u);
  assert.deepEqual(parseYaml(first), value);
});

test('safe YAML subset accepts literal blocks but rejects aliases, duplicates, tabs, and unsafe keys', () => {
  assert.deepEqual(
    parseYaml('message: |-\n  first\n  second\nitems:\n  - "one"\n'),
    { message: 'first\nsecond', items: ['one'] },
  );
  assert.throws(() => parseYaml('a: 1\na: 2\n'), /Duplicate mapping key/);
  assert.throws(() => parseYaml('a: &anchor value\n'), /anchors/);
  assert.throws(() => parseYaml('a: *anchor\n'), /aliases/);
  assert.throws(() => parseYaml('__proto__: "unsafe"\n'), /Forbidden mapping key/);
  assert.throws(() => parseYaml('a:\n\t- 1\n'), /Tabs are not allowed/);
  assert.throws(() => parseYaml('%YAML 1.2\na: 1\n'), YamlParseError);
});

test('YAML schema validation reports required, additional, type, enum, and digest errors', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['schema_version', 'status', 'digest'],
    properties: {
      schema_version: { const: 1 },
      status: { type: 'string', enum: ['active', 'complete'] },
      digest: { type: 'string', format: 'sha256' },
    },
  };
  const invalid = { schema_version: 2, status: 'done', digest: 'short', extra: true };
  const result = validateYamlSchema(invalid, schema);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.includes('must equal 1')), true);
  assert.equal(result.errors.some((error) => error.includes('must be one of')), true);
  assert.equal(result.errors.some((error) => error.includes('SHA-256')), true);
  assert.equal(result.errors.some((error) => error.includes('extra is not allowed')), true);
  assert.throws(
    () => assertYamlSchema(invalid, schema, { name: 'state.yaml' }),
    YamlSchemaError,
  );
});

test('YAML file persistence is atomic, private by default, and schema-checked on read/write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cruise-yaml-'));
  const path = join(directory, 'nested', 'state.yaml');
  const schema = {
    type: 'object',
    required: ['schema_version', 'status'],
    properties: {
      schema_version: { const: 1 },
      status: { type: 'string', enum: ['active', 'complete'] },
    },
  };
  const value = { schema_version: 1, status: 'active' };
  const written = await writeYamlFile(path, value, { schema });
  assert.equal(written.path, path);
  assert.equal(written.bytes > 0, true);
  assert.deepEqual(await readYamlFile(path, { schema }), value);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(
    writeYamlFile(path, { schema_version: 1, status: 'wrong' }, { schema }),
    YamlSchemaError,
  );
});

test('stable IDs allocate monotonically and parse with their semantic prefix', () => {
  assert.deepEqual(parseTraceId('AC-04'), { id: 'AC-04', prefix: 'AC', number: 4 });
  assert.equal(allocateStableId('R', ['R-01', 'R-03']), 'R-04');
  assert.equal(allocateStableId('AC', completeTraceability()), 'AC-02');
  assert.throws(() => parseTraceId('R-1'), /invalid Cruise traceability ID/);
});

test('task traceability requires satisfies, preserves, and verification edges with correct types', () => {
  const task = createTaskTrace({
    taskId: 'T-03',
    satisfies: ['R-02', 'AC-04'],
    preserves: ['G-01', 'R-05'],
    verification: ['E-07', 'E-09'],
  });
  assert.deepEqual(task, {
    task_id: 'T-03',
    satisfies: ['R-02', 'AC-04'],
    preserves: ['G-01', 'R-05'],
    verification: ['E-07', 'E-09'],
  });
  assert.throws(
    () => createTaskTrace({
      taskId: 'T-01',
      satisfies: ['G-01'],
      preserves: ['G-01'],
      verification: ['E-01'],
    }),
    /satisfies may reference only R\/AC/,
  );
  assert.throws(
    () => createTaskTrace({
      taskId: 'T-01',
      satisfies: [],
      preserves: ['G-01'],
      verification: ['E-01'],
    }),
    /must satisfy at least one/,
  );
});

test('traceability validates every edge and final origin-to-task-to-evidence coverage', () => {
  const record = completeTraceability();
  validateTraceability(record);
  assert.deepEqual(traceabilityCoverage(record), {
    uncovered_goal_clauses: [],
    uncovered_requirements: [],
    uncovered_acceptance_criteria: [],
    unused_evidence: [],
  });
  assertFinalTraceability(record, { allowUnusedEvidence: false });
  assert.match(traceabilityDigest(record), /^[a-f0-9]{64}$/u);

  const missingEvidence = structuredClone(record);
  missingEvidence.tasks[0].verification = ['E-99'];
  assert.throws(() => validateTraceability(missingEvidence), /references missing E-99/);

  const duplicate = structuredClone(record);
  duplicate.requirements.push({ id: 'R-01', text: 'duplicate' });
  assert.throws(() => validateTraceability(duplicate), /duplicate traceability ID R-01/);

  const omitted = structuredClone(record);
  omitted.tasks[0].satisfies = ['AC-01'];
  omitted.tasks[0].preserves = ['G-01'];
  assert.throws(() => assertFinalTraceability(omitted), /uncovered requirements/);
});

test('final verification rejects a self-consistent plan that omitted an Origin clause', () => {
  const origin = createOriginRecord({
    rawPrompt: 'Ship the change and preserve both compatibility checks.',
    selectedSkill: 'refine',
    repositoryBaseline: {
      root: process.cwd(),
      head: null,
      branch: null,
      dirty_state_digest: 'a'.repeat(64),
      instruction_files: [],
    },
    deterministicProbeDigest: 'b'.repeat(64),
    initialClassifier: 'gpt-5.6-luna medium',
    selectedRoute: 'refine',
    confidence: 0.94,
    goal: {
      outcome: 'Ship the change.',
      success_criteria: ['Primary behavior passes.', 'Compatibility remains intact.'],
    },
  });
  const trace = completeTraceability();
  const mappings = originClauses(origin).map((clause) => ({
    ...clause,
    trace_ids: clause.origin_path.includes('success_criteria') ? ['AC-01'] : ['G-01'],
  }));
  assertOriginCoverage(origin, trace, mappings);
  assertFinalTraceability(trace, { originRecord: origin, originMappings: mappings });

  const omitted = mappings.filter(
    ({ origin_path }) => origin_path !== 'goal.success_criteria[1]',
  );
  assert.throws(
    () => assertFinalTraceability(trace, { originRecord: origin, originMappings: omitted }),
    /omitted origin clause.*goal\.success_criteria\[1\]/,
  );

  const stale = structuredClone(mappings);
  stale[0].value_sha256 = 'c'.repeat(64);
  assert.throws(
    () => assertOriginCoverage(origin, trace, stale),
    /digest is stale or rewritten/,
  );
});

test('allocated IDs cannot silently disappear or be renumbered', () => {
  const previous = completeTraceability();
  const next = structuredClone(previous);
  next.evidence.push({ id: 'E-03', kind: 'static', result: 'pass' });
  assertStableTraceability(previous, next);

  const renumbered = structuredClone(previous);
  renumbered.goal_clauses[0].id = 'G-02';
  renumbered.tasks[0].preserves = ['G-02', 'R-02'];
  assert.throws(
    () => assertStableTraceability(previous, renumbered),
    /disappeared or was renumbered: G-01/,
  );
});
