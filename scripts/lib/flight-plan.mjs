import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { normalizeQuality, serializeQuality } from './assurance.mjs';

export const FLIGHT_FILE = '.cruise/FLIGHT.md';
export const FLIGHT_MAX_BYTES = 8 * 1024;
export const DEFAULT_STALL = Object.freeze({ quietTurns: 3, sameFailure: 3 });

const STATUSES = new Set(['active', 'complete', 'blocked']);
const KNOWN_KEYS = new Set(['version', 'status', 'outcome', 'verify', 'scope', 'invariants', 'quality', 'stall']);

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function flightPlanTemplate() {
  return `---
version: 2
status: active
outcome: <one line, falsifiable>
verify:
  - <command>
scope:
  touchpoints:
    - <path-or-glob>
  non_goals:
    - <explicit exclusion>
invariants:
  - <protected behavior>
quality:
  risk: medium
  profiles:
    - core
  gates:
    -
      id: core.intent
      dimension: intent
      criterion: <the result still matches the original request>
      oracle: <review method>
      surface:
        - .
      severity: high
      state: pending
      evidence: null
    -
      id: core.functional
      dimension: functional-correctness
      criterion: <the changed behavior works across acceptance cases>
      oracle: <focused behavioral check>
      surface:
        - <path-or-glob>
      severity: high
      state: pending
      evidence: null
    -
      id: core.regression
      dimension: regression
      criterion: <existing behavior and invariants remain intact>
      oracle: <regression check>
      surface:
        - <path-or-glob>
      severity: high
      state: pending
      evidence: null
    -
      id: core.failure-paths
      dimension: failure-paths
      criterion: <relevant failures and boundaries behave deliberately>
      oracle: <failure-path probe>
      surface:
        - <path-or-glob>
      severity: medium
      state: pending
      evidence: null
    -
      id: core.completion-review
      dimension: completion-review
      criterion: <skeptical final review finds no unresolved in-scope gap>
      oracle: <final diff and evidence review>
      surface:
        - .
      severity: high
      state: pending
      evidence: null
stall:
  quiet_turns: 3
  same_failure: 3
---
# Flight plan
<prose>
`;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stripComment(value) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === '"' && character === '\\' && !escaped) {
      escaped = true;
      continue;
    }
    if (character === quote && !escaped) quote = null;
    else if (!quote && (character === '"' || character === "'")) quote = character;
    else if (!quote && character === '#' && (index === 0 || /\s/u.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd();
    }
    escaped = false;
  }
  if (quote) throw new Error('unterminated quoted scalar');
  return value.trimEnd();
}

function parseScalar(value) {
  const scalar = value.trim();
  if (scalar === '[]') return [];
  if (scalar === '{}') return {};
  if (scalar === 'null' || scalar === '~') return null;
  if (scalar === 'true') return true;
  if (scalar === 'false') return false;
  if (/^-?(?:0|[1-9]\d*)$/u.test(scalar)) return Number(scalar);
  if (scalar.startsWith('"')) {
    const parsed = JSON.parse(scalar);
    if (typeof parsed !== 'string') throw new Error('quoted values must be strings');
    return parsed;
  }
  if (scalar.startsWith("'")) {
    if (!scalar.endsWith("'") || scalar.length < 2) throw new Error('invalid quoted scalar');
    return scalar.slice(1, -1).replace(/''/gu, "'");
  }
  if (!scalar || /^[!&*>|[{]/u.test(scalar)) throw new Error('unsupported YAML scalar');
  return scalar;
}

function frontmatterTokens(source) {
  const tokens = [];
  for (const [index, raw] of source.split(/\r?\n/u).entries()) {
    if (raw.includes('\t')) throw new Error(`tabs are not valid indentation on line ${index + 2}`);
    const indent = raw.match(/^ */u)[0].length;
    const content = stripComment(raw.slice(indent));
    if (!content.trim()) continue;
    if (indent % 2 !== 0) throw new Error(`indentation must use two spaces on line ${index + 2}`);
    tokens.push({ indent, content: content.trim(), line: index + 2 });
  }
  if (tokens.length > 1_000) throw new Error('frontmatter is too large');
  return tokens;
}

function parseBlock(tokens, start, indent, depth = 0) {
  if (depth > 10) throw new Error('frontmatter is too deeply nested');
  const sequence = tokens[start]?.content === '-' || tokens[start]?.content.startsWith('- ');
  const result = sequence ? [] : {};
  let cursor = start;
  while (cursor < tokens.length && tokens[cursor].indent >= indent) {
    const token = tokens[cursor];
    if (token.indent !== indent) throw new Error(`unexpected indentation on line ${token.line}`);
    const item = token.content === '-' || token.content.startsWith('- ');
    if (item !== sequence) throw new Error(`mixed mapping and sequence on line ${token.line}`);
    if (sequence) {
      const rest = token.content.slice(1).trim();
      if (rest) result.push(parseScalar(rest));
      else if (tokens[cursor + 1]?.indent === indent + 2) {
        const [child, next] = parseBlock(tokens, cursor + 1, indent + 2, depth + 1);
        result.push(child);
        cursor = next - 1;
      } else result.push(null);
    } else {
      const separator = token.content.indexOf(':');
      if (separator < 1) throw new Error(`expected a mapping on line ${token.line}`);
      const key = token.content.slice(0, separator).trim();
      if (
        !/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(key) ||
        ['__proto__', 'constructor', 'prototype'].includes(key) ||
        Object.hasOwn(result, key)
      ) {
        throw new Error(`invalid or duplicate key on line ${token.line}`);
      }
      const rest = token.content.slice(separator + 1).trim();
      if (rest) result[key] = parseScalar(rest);
      else if (tokens[cursor + 1]?.indent === indent + 2) {
        const [child, next] = parseBlock(tokens, cursor + 1, indent + 2, depth + 1);
        result[key] = child;
        cursor = next - 1;
      } else result[key] = null;
    }
    cursor += 1;
  }
  return [result, cursor];
}

function stringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || /[\r\n]/u.test(item))) {
    throw new TypeError(`${name} must be an array of strings`);
  }
  return [...value];
}

function positiveInteger(value, fallback, name) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new TypeError(`${name} must be a positive integer`);
  return resolved;
}

function normalize(raw, body = '') {
  if (!isObject(raw) || typeof body !== 'string') throw new TypeError('invalid flight plan');
  const version = raw.version === undefined ? 1 : raw.version;
  const status = raw.status === undefined ? 'active' : raw.status;
  const outcome = raw.outcome === undefined ? '' : raw.outcome;
  if (![1, 2].includes(version)) throw new TypeError('version must be 1 or 2');
  if (!STATUSES.has(status)) throw new TypeError('status must be active, complete, or blocked');
  if (
    typeof outcome !== 'string' ||
    /[\r\n]/u.test(outcome) ||
    (version >= 2 && !outcome.trim())
  ) throw new TypeError('outcome must be one non-empty line');
  const scope = raw.scope === undefined ? {} : raw.scope;
  const stall = raw.stall === undefined ? {} : raw.stall;
  if (!isObject(scope) || !isObject(stall)) throw new TypeError('scope and stall must be mappings');
  const normalized = {
    version,
    status,
    outcome,
    verify: stringArray(raw.verify === undefined ? [] : raw.verify, 'verify'),
    scope: {
      touchpoints: stringArray(scope.touchpoints === undefined ? [] : scope.touchpoints, 'scope.touchpoints'),
      nonGoals: stringArray(scope.non_goals === undefined ? [] : scope.non_goals, 'scope.non_goals'),
    },
    invariants: stringArray(raw.invariants === undefined ? [] : raw.invariants, 'invariants'),
    stall: {
      quietTurns: positiveInteger(stall.quiet_turns, DEFAULT_STALL.quietTurns, 'stall.quiet_turns'),
      sameFailure: positiveInteger(stall.same_failure, DEFAULT_STALL.sameFailure, 'stall.same_failure'),
    },
    body,
    raw,
  };
  if (version >= 2) normalized.quality = normalizeQuality(raw.quality, version);
  return normalized;
}

function parseFlightPlanStrict(text) {
  if (typeof text !== 'string') throw new TypeError('flight plan must be text');
  if (Buffer.byteLength(text) > FLIGHT_MAX_BYTES) throw new Error('flight plan exceeds 8 KB');
  const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  if (lines[0]?.trim() !== '---') throw new Error('line 1: missing opening --- frontmatter fence');
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closing < 0) throw new Error('missing closing --- frontmatter fence');
  const tokens = frontmatterTokens(lines.slice(1, closing).join('\n'));
  const [raw, consumed] = tokens.length ? parseBlock(tokens, 0, 0) : [{}, 0];
  if (consumed !== tokens.length || !isObject(raw)) throw new Error('frontmatter root must be a mapping');
  return normalize(raw, lines.slice(closing + 1).join('\n'));
}

// Pure and deliberately fail-safe: an advisory note can never break a run.
export function parseFlightPlan(text) {
  try {
    return parseFlightPlanStrict(text);
  } catch {
    return null;
  }
}

function scalarText(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value !== 'string') throw new TypeError('frontmatter scalar is not serializable');
  if (
    value &&
    value === value.trim() &&
    !/[\r\n]/u.test(value) &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/u.test(value) &&
    !/[#:]/u.test(value) &&
    !/^(?:true|false|null|~|-?(?:0|[1-9]\d*)(?:\.\d+)?)$/u.test(value)
  ) return value;
  return JSON.stringify(value);
}

function serializeValue(key, value, indent) {
  const prefix = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return [`${prefix}${key}: []`];
    return [`${prefix}${key}:`, ...serializeSequence(value, indent + 2)];
  }
  if (isObject(value)) {
    if (!Object.keys(value).length) return [`${prefix}${key}: {}`];
    return [`${prefix}${key}:`, ...serializeObject(value, indent + 2)];
  }
  return [`${prefix}${key}: ${scalarText(value)}`];
}

function serializeSequence(value, indent) {
  const prefix = ' '.repeat(indent);
  return value.flatMap((item) => {
    if (Array.isArray(item)) return [`${prefix}-`, ...serializeSequence(item, indent + 2)];
    if (isObject(item)) return [`${prefix}-`, ...serializeObject(item, indent + 2)];
    return [`${prefix}- ${scalarText(item)}`];
  });
}

function serializeObject(value, indent = 0) {
  if (!isObject(value)) throw new TypeError('frontmatter root must be a mapping');
  return Object.entries(value).flatMap(([key, item]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(key)) throw new TypeError(`invalid frontmatter key ${key}`);
    return serializeValue(key, item, indent);
  });
}

function serializablePlan(plan) {
  if (!isObject(plan)) throw new TypeError('flight plan must be an object');
  const raw = isObject(plan.raw) ? plan.raw : {};
  const scopeRaw = isObject(raw.scope) ? raw.scope : {};
  const stallRaw = isObject(raw.stall) ? raw.stall : {};
  const version = plan.version ?? raw.version ?? 1;
  const quality = version >= 2
    ? serializeQuality(plan.quality ?? normalizeQuality(raw.quality, version))
    : undefined;
  const known = normalize({
    version: plan.version ?? raw.version,
    status: plan.status ?? raw.status,
    outcome: plan.outcome ?? raw.outcome,
    verify: plan.verify ?? raw.verify,
    scope: {
      ...scopeRaw,
      touchpoints: plan.scope?.touchpoints ?? scopeRaw.touchpoints,
      non_goals: plan.scope?.nonGoals ?? scopeRaw.non_goals,
    },
    invariants: plan.invariants ?? raw.invariants,
    ...(quality === undefined ? {} : { quality }),
    stall: {
      ...stallRaw,
      quiet_turns: plan.stall?.quietTurns ?? stallRaw.quiet_turns,
      same_failure: plan.stall?.sameFailure ?? stallRaw.same_failure,
    },
  }, plan.body ?? '');
  const extras = Object.fromEntries(Object.entries(raw).filter(([key]) => !KNOWN_KEYS.has(key)));
  const frontmatter = {
    version: known.version,
    status: known.status,
    outcome: known.outcome,
    verify: known.verify,
    scope: {
      touchpoints: known.scope.touchpoints,
      non_goals: known.scope.nonGoals,
      ...Object.fromEntries(Object.entries(scopeRaw).filter(([key]) => !['touchpoints', 'non_goals'].includes(key))),
    },
    invariants: known.invariants,
    ...(known.quality ? { quality: serializeQuality(known.quality) } : {}),
    stall: {
      quiet_turns: known.stall.quietTurns,
      same_failure: known.stall.sameFailure,
      ...Object.fromEntries(Object.entries(stallRaw).filter(([key]) => !['quiet_turns', 'same_failure'].includes(key))),
    },
    ...extras,
  };
  return {
    normalized: known,
    frontmatter,
  };
}

export async function readFlightPlan(cwd) {
  try {
    return parseFlightPlan(await readFile(join(cwd, FLIGHT_FILE), 'utf8'));
  } catch {
    return null;
  }
}

export async function inspectFlightPlan(cwd) {
  let text;
  try {
    text = await readFile(join(cwd, FLIGHT_FILE), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'absent' };
    return { state: 'invalid', reason: `could not read flight plan: ${error?.message ?? error}` };
  }
  const contentHash = digest(text);
  try {
    return { state: 'valid', plan: parseFlightPlanStrict(text), contentHash };
  } catch (error) {
    return {
      state: 'invalid',
      reason: String(error?.message ?? error).replace(/\s+/gu, ' ').trim(),
      contentHash,
    };
  }
}

export async function writeFlightPlan(cwd, plan) {
  const { normalized, frontmatter } = serializablePlan(plan);
  const directory = join(cwd, '.cruise');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = await lstat(directory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw new Error(`${directory} must be a directory.`);
  }
  const path = join(cwd, FLIGHT_FILE);
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error(`${path} must be a regular file.`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const text = `---\n${serializeObject(frontmatter).join('\n')}\n---\n${normalized.body}`;
  if (Buffer.byteLength(text) > FLIGHT_MAX_BYTES) {
    throw new Error('flight plan exceeds 8 KB; keep the body concise and link detailed evidence');
  }
  await writeFile(path, text, { encoding: 'utf8', mode: 0o600 });
  return normalized;
}
