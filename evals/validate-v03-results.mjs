#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EVALS_ROOT = dirname(fileURLToPath(import.meta.url));

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

function acceptsType(value, expected) {
  const actual = valueType(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

function dereference(root, reference) {
  if (!reference.startsWith('#/')) throw new Error(`unsupported schema reference ${reference}`);
  return reference.slice(2).split('/').reduce((value, key) => value?.[key.replace(/~1/gu, '/').replace(/~0/gu, '~')], root);
}

function validateNode(value, schema, root, path = '$') {
  const errors = [];
  const visit = (child, childSchema, childPath = path) => {
    errors.push(...validateNode(child, childSchema, root, childPath));
  };
  if (schema.$ref) {
    visit(value, dereference(root, schema.$ref));
    return errors;
  }
  if (schema.allOf) for (const item of schema.allOf) visit(value, item);
  if (schema.oneOf) {
    const passing = schema.oneOf.filter((item) => validateNode(value, item, root, path).length === 0);
    if (passing.length !== 1) errors.push(`${path}: expected exactly one oneOf branch, got ${passing.length}`);
  }
  if (schema.if && validateNode(value, schema.if, root, path).length === 0 && schema.then) visit(value, schema.then);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => acceptsType(value, type))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${valueType(value)}`);
      return errors;
    }
  }
  if (Object.hasOwn(schema, 'const') && !same(value, schema.const)) errors.push(`${path}: does not match const`);
  if (schema.enum && !schema.enum.some((item) => same(value, item))) errors.push(`${path}: is not in enum`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than minLength`);
    if (schema.pattern && !(new RegExp(schema.pattern, 'u')).test(value)) errors.push(`${path}: does not match pattern`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than minItems`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than maxItems`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(`${path}: items are not unique`);
    if (schema.items) value.forEach((item, index) => visit(item, schema.items, `${path}[${index}]`));
    if (schema.contains && !value.some((item, index) => validateNode(item, schema.contains, root, `${path}[${index}]`).length === 0)) {
      errors.push(`${path}: contains requirement not met`);
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}: missing required property ${key}`);
    }
    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) visit(item, properties[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        visit(item, schema.additionalProperties, `${path}.${key}`);
      }
    }
  }
  return errors;
}

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function jsonFiles(directory) {
  return (await readdir(directory)).filter((name) => name.endsWith('.json')).sort().map((name) => join(directory, name));
}

function roundedWeightedTotal(record) {
  const value = record.rubric_scores.reduce((sum, item) => sum + ((item.score / item.max) * item.weight), 0);
  return Number(value.toFixed(1));
}

async function validateArtifacts(root, record, errors) {
  for (const artifact of [record.transcript, ...record.artifacts]) {
    const path = resolve(root, artifact.path);
    if (!path.startsWith(`${resolve(root)}/`)) {
      errors.push(`${record.run_id}: artifact escapes result root: ${artifact.path}`);
      continue;
    }
    try {
      const actual = digest(await readFile(path));
      if (actual !== artifact.sha256) errors.push(`${record.run_id}: artifact digest mismatch: ${artifact.path}`);
    } catch (error) {
      errors.push(`${record.run_id}: cannot read artifact ${artifact.path}: ${error.message}`);
    }
  }
}

async function main() {
  const root = resolve(process.argv[2] ?? join(EVALS_ROOT, 'results', '2026-07-21'));
  const [runSchema, pairSchema, studySchema] = await Promise.all([
    json(join(EVALS_ROOT, 'result.schema.json')),
    json(join(EVALS_ROOT, 'pair-result.schema.json')),
    json(join(EVALS_ROOT, 'study-result.schema.json')),
  ]);
  const errors = [];
  const runs = new Map();
  for (const path of await jsonFiles(join(root, 'runs'))) {
    const record = await json(path);
    errors.push(...validateNode(record, runSchema, runSchema).map((item) => `${basename(path)} ${item}`));
    if (roundedWeightedTotal(record) !== record.total_score) {
      errors.push(`${record.run_id}: total_score ${record.total_score} != recomputed ${roundedWeightedTotal(record)}`);
    }
    await validateArtifacts(root, record, errors);
    runs.set(record.run_id, record);
  }
  const pairs = new Map();
  for (const path of await jsonFiles(join(root, 'pairs'))) {
    const record = await json(path);
    errors.push(...validateNode(record, pairSchema, pairSchema).map((item) => `${basename(path)} ${item}`));
    const members = record.run_ids.map((id) => runs.get(id));
    if (members.some((item) => !item)) errors.push(`${record.pair_id}: references a missing run`);
    else {
      const x = members.find(({ blind_arm }) => blind_arm === 'X');
      const y = members.find(({ blind_arm }) => blind_arm === 'Y');
      const expected = Number((x.total_score - y.total_score).toFixed(1));
      if (record.score_delta !== expected) errors.push(`${record.pair_id}: score_delta ${record.score_delta} != ${expected}`);
    }
    pairs.set(record.pair_id, { record, path });
  }
  const study = await json(join(root, 'study.json'));
  errors.push(...validateNode(study, studySchema, studySchema).map((item) => `study.json ${item}`));
  for (const reference of study.pair_records) {
    const path = resolve(root, reference.path);
    const pair = [...pairs.values()].find((item) => resolve(item.path) === path);
    if (!pair) errors.push(`study.json: missing pair reference ${reference.path}`);
    else if (digest(await readFile(path)) !== reference.sha256) errors.push(`study.json: pair digest mismatch ${reference.path}`);
  }
  if (study.valid_pair_count !== [...pairs.values()].filter(({ record }) => record.validity === 'valid').length) {
    errors.push('study.json: valid_pair_count does not match pair records');
  }
  if (errors.length) {
    for (const error of errors) process.stderr.write(`FAIL ${error}\n`);
    return 1;
  }
  process.stdout.write(`Validated ${runs.size} runs, ${pairs.size} pairs, study.json, weighted totals, references, and artifact digests.\n`);
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  },
);
