import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { QUALITY_PROFILES } from './assurance.mjs';

export const QUEUE_FILE = '.cruise/QUEUE.md';

const STATUSES = new Set(['pending', 'active', 'complete', 'blocked', 'stalled']);
const QUEUE_KEYS = new Set(['version', 'milestones']);
const MILESTONE_KEYS = new Set([
  'id',
  'status',
  'stop_scope',
  'outcome',
  'verify',
  'depends',
  'touchpoints',
  'non_goals',
  'invariants',
  'risk',
  'profiles',
]);
const RISKS = new Set(['low', 'medium', 'high', 'critical']);

function isMapping(value) {
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

function flowItems(value) {
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  const items = [];
  let quote = null;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (quote === '"' && character === '\\' && !escaped) {
      escaped = true;
      continue;
    }
    if (character === quote && !escaped) quote = null;
    else if (!quote && (character === '"' || character === "'")) quote = character;
    else if (!quote && ['[', ']', '{', '}'].includes(character)) {
      throw new Error('nested flow values are unsupported');
    } else if (!quote && character === ',') {
      const item = inner.slice(start, index).trim();
      if (!item) throw new Error('empty flow-sequence item');
      items.push(item);
      start = index + 1;
    }
    escaped = false;
  }
  if (quote) throw new Error('unterminated flow-sequence quote');
  const final = inner.slice(start).trim();
  if (!final) throw new Error('empty flow-sequence item');
  items.push(final);
  return items;
}

function parseScalar(value) {
  const scalar = value.trim();
  if (scalar === '[]') return [];
  if (scalar === '{}') return {};
  if (scalar === 'null' || scalar === '~') return null;
  if (scalar === 'true') return true;
  if (scalar === 'false') return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(scalar)) return Number(scalar);
  if (scalar.startsWith('[')) {
    if (!scalar.endsWith(']')) throw new Error('unterminated flow sequence');
    return flowItems(scalar).map(parseScalar);
  }
  if (scalar.startsWith('"')) {
    const parsed = JSON.parse(scalar);
    if (typeof parsed !== 'string') throw new Error('quoted values must be strings');
    return parsed;
  }
  if (scalar.startsWith("'")) {
    if (!scalar.endsWith("'") || scalar.length < 2) throw new Error('invalid quoted scalar');
    return scalar.slice(1, -1).replace(/''/gu, "'");
  }
  if (!scalar || /^[!&*>|{]/u.test(scalar)) throw new Error('unsupported YAML scalar');
  return scalar;
}

function frontmatterTokens(source) {
  const tokens = [];
  for (const [index, raw] of source.split(/\r?\n/u).entries()) {
    if (raw.includes('\t')) throw new Error('tabs are not valid indentation');
    const indent = raw.match(/^ */u)[0].length;
    const content = stripComment(raw.slice(indent)).trim();
    if (!content) continue;
    if (indent % 2 !== 0) throw new Error('indentation must use two spaces');
    if (/^-\s+[A-Za-z_][A-Za-z0-9_-]*\s*:/u.test(content)) {
      tokens.push({ indent, content: '-', line: index + 1 });
      tokens.push({ indent: indent + 2, content: content.slice(1).trim(), line: index + 1 });
    } else tokens.push({ indent, content, line: index + 1 });
  }
  if (tokens.length > 5_000) throw new Error('frontmatter is too large');
  return tokens;
}

function parseBlock(tokens, start, indent, depth = 0) {
  if (depth > 12) throw new Error('frontmatter is too deeply nested');
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

function oneLine(value, name, { nonempty = false } = {}) {
  if (
    typeof value !== 'string' ||
    /[\r\n]/u.test(value) ||
    (nonempty && !value.trim())
  ) throw new TypeError(`${name} must be ${nonempty ? 'a nonempty ' : ''}one-line string`);
  return value;
}

function stringList(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || /[\r\n]/u.test(item))) {
    throw new TypeError(`${name} must be an array of strings`);
  }
  return [...value];
}

function normalizeMilestone(raw, index, version = 1) {
  if (!isMapping(raw)) throw new TypeError(`milestones[${index}] must be a mapping`);
  const status = raw.status ?? 'pending';
  if (!STATUSES.has(status)) throw new TypeError(`milestones[${index}].status is invalid`);
  const milestone = {
    id: oneLine(raw.id, `milestones[${index}].id`, { nonempty: true }),
    status,
    outcome: oneLine(raw.outcome ?? '', `milestones[${index}].outcome`),
    verify: stringList(raw.verify ?? [], `milestones[${index}].verify`),
    depends: stringList(raw.depends ?? [], `milestones[${index}].depends`),
    touchpoints: stringList(raw.touchpoints ?? [], `milestones[${index}].touchpoints`),
    nonGoals: stringList(raw.non_goals ?? raw.nonGoals ?? [], `milestones[${index}].non_goals`),
    invariants: stringList(raw.invariants ?? [], `milestones[${index}].invariants`),
  };
  if (raw.stop_scope !== undefined) {
    if (![null, 'local', 'global'].includes(raw.stop_scope)) {
      throw new TypeError(`milestones[${index}].stop_scope is invalid`);
    }
    milestone.stop_scope = raw.stop_scope;
  }
  if (version >= 2) {
    const risk = raw.risk ?? 'medium';
    if (!RISKS.has(risk)) throw new TypeError(`milestones[${index}].risk is invalid`);
    const profiles = stringList(raw.profiles ?? ['core'], `milestones[${index}].profiles`);
    if (!profiles.includes('core')) throw new TypeError(`milestones[${index}].profiles must include core`);
    if (new Set(profiles).size !== profiles.length) {
      throw new TypeError(`milestones[${index}].profiles must not contain duplicates`);
    }
    for (const profile of profiles) {
      if (!Object.hasOwn(QUALITY_PROFILES, profile)) {
        throw new TypeError(`milestones[${index}].profiles contains unsupported profile ${profile}`);
      }
    }
    milestone.risk = risk;
    milestone.profiles = profiles;
  }
  return milestone;
}

function normalizeQueue(raw, body = '') {
  if (!isMapping(raw) || typeof body !== 'string') throw new TypeError('invalid queue');
  const version = raw.version ?? 1;
  if (![1, 2].includes(version)) throw new TypeError('version must be 1 or 2');
  const source = raw.milestones ?? [];
  if (!Array.isArray(source)) throw new TypeError('milestones must be an array');
  const milestones = source.map((milestone, index) => normalizeMilestone(milestone, index, version));
  const ids = new Set();
  for (const milestone of milestones) {
    if (ids.has(milestone.id)) throw new TypeError(`duplicate milestone id: ${milestone.id}`);
    ids.add(milestone.id);
  }
  return { version, milestones, body, raw };
}

// Pure and deliberately fail-safe: an advisory queue can never break parsing callers.
export function parseQueue(text) {
  try {
    if (typeof text !== 'string' || text.length > 1_000_000) return null;
    const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u);
    if (lines[0]?.trim() !== '---') return null;
    const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (closing < 0) return null;
    const tokens = frontmatterTokens(lines.slice(1, closing).join('\n'));
    const [raw, consumed] = tokens.length ? parseBlock(tokens, 0, 0) : [{}, 0];
    if (consumed !== tokens.length || !isMapping(raw)) return null;
    return normalizeQueue(raw, lines.slice(closing + 1).join('\n'));
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

function serializeSequence(value, indent) {
  const prefix = ' '.repeat(indent);
  return value.flatMap((item) => {
    if (Array.isArray(item)) return [`${prefix}-`, ...serializeSequence(item, indent + 2)];
    if (isMapping(item)) return [`${prefix}-`, ...serializeObject(item, indent + 2)];
    return [`${prefix}- ${scalarText(item)}`];
  });
}

function serializeValue(key, value, indent) {
  const prefix = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return [`${prefix}${key}: []`];
    return [`${prefix}${key}:`, ...serializeSequence(value, indent + 2)];
  }
  if (isMapping(value)) {
    if (!Object.keys(value).length) return [`${prefix}${key}: {}`];
    return [`${prefix}${key}:`, ...serializeObject(value, indent + 2)];
  }
  return [`${prefix}${key}: ${scalarText(value)}`];
}

function serializeObject(value, indent = 0) {
  if (!isMapping(value)) throw new TypeError('frontmatter root must be a mapping');
  return Object.entries(value).flatMap(([key, item]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(key)) throw new TypeError(`invalid frontmatter key ${key}`);
    return serializeValue(key, item, indent);
  });
}

function serializableQueue(queue) {
  if (!isMapping(queue)) throw new TypeError('queue must be an object');
  const raw = isMapping(queue.raw) ? queue.raw : {};
  const source = queue.milestones ?? raw.milestones ?? [];
  if (!Array.isArray(source)) throw new TypeError('milestones must be an array');
  const rawMilestones = Array.isArray(raw.milestones) ? raw.milestones : [];
  const version = queue.version ?? raw.version ?? 1;
  const milestones = source.map((milestone, index) => {
    if (!isMapping(milestone)) throw new TypeError(`milestones[${index}] must be a mapping`);
    const rawMatch = rawMilestones.find((candidate) => isMapping(candidate) && candidate.id === milestone.id);
    const base = isMapping(milestone.raw) ? milestone.raw : rawMatch ?? {};
    const normalized = normalizeMilestone({
      ...base,
      ...milestone,
      non_goals: milestone.nonGoals ?? milestone.non_goals ?? base.non_goals,
    }, index, version);
    const directExtras = Object.fromEntries(Object.entries(milestone).filter(([key]) => ![
      ...MILESTONE_KEYS,
      'nonGoals',
      'raw',
    ].includes(key)));
    const extras = {
      ...Object.fromEntries(Object.entries(base).filter(([key]) => !MILESTONE_KEYS.has(key))),
      ...directExtras,
    };
    return {
      id: normalized.id,
      status: normalized.status,
      ...(normalized.stop_scope !== undefined ? { stop_scope: normalized.stop_scope } : {}),
      outcome: normalized.outcome,
      verify: normalized.verify,
      depends: normalized.depends,
      touchpoints: normalized.touchpoints,
      non_goals: normalized.nonGoals,
      invariants: normalized.invariants,
      ...(version >= 2 ? {
        risk: normalized.risk,
        profiles: normalized.profiles,
      } : {}),
      ...extras,
    };
  });
  const frontmatter = {
    version,
    milestones,
    ...Object.fromEntries(Object.entries(raw).filter(([key]) => !QUEUE_KEYS.has(key))),
    ...Object.fromEntries(Object.entries(queue).filter(([key]) => ![
      'version',
      'milestones',
      'body',
      'raw',
    ].includes(key))),
  };
  const body = queue.body ?? '';
  return { normalized: normalizeQueue(frontmatter, body), frontmatter };
}

export async function readQueue(cwd) {
  try {
    return parseQueue(await readFile(join(cwd, QUEUE_FILE), 'utf8'));
  } catch {
    return null;
  }
}

export async function writeQueue(cwd, queue) {
  const { normalized, frontmatter } = serializableQueue(queue);
  const directory = join(cwd, '.cruise');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = await lstat(directory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw new Error(`${directory} must be a directory.`);
  }
  const path = join(cwd, QUEUE_FILE);
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error(`${path} must be a regular file.`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const text = `---\n${serializeObject(frontmatter).join('\n')}\n---\n${normalized.body}`;
  await writeFile(path, text, { encoding: 'utf8', mode: 0o600 });
  return normalized;
}

function dependencyCycle(milestones) {
  const pending = new Map(milestones.filter(({ status }) => status === 'pending').map((item) => [item.id, item]));
  const visiting = new Set();
  const visited = new Set();
  const path = [];
  const visit = (id) => {
    if (visiting.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (visited.has(id)) return null;
    visiting.add(id);
    path.push(id);
    for (const dependency of pending.get(id)?.depends ?? []) {
      if (!pending.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };
  for (const id of pending.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

export function nextReadyMilestone(queue, {
  warn = (message) => process.emitWarning(message, { code: 'CRUISE_QUEUE_CYCLE' }),
} = {}) {
  const milestones = Array.isArray(queue?.milestones) ? queue.milestones : [];
  const byId = new Map(milestones.map((milestone) => [milestone.id, milestone]));
  const ready = milestones.find((milestone) => (
    milestone.status === 'pending' &&
    milestone.depends.every((id) => byId.get(id)?.status === 'complete')
  ));
  if (ready) return ready;
  const cycle = dependencyCycle(milestones);
  if (cycle) warn(`Queue dependency cycle detected: ${cycle.join(' -> ')}`);
  return null;
}

export function milestoneToFlightPlan(milestone, queueBody = '') {
  const normalized = normalizeMilestone({
    ...milestone,
    risk: milestone.risk ?? 'medium',
    profiles: milestone.profiles ?? ['core'],
  }, 0, 2);
  if (typeof queueBody !== 'string') throw new TypeError('queue body must be a string');
  const inherited = queueBody.trim()
    ? '\n\nInherited cross-milestone detail remains in `.cruise/QUEUE.md`; open only the applicable obligation.'
    : '';
  const affectedSurface = normalized.touchpoints.length ? normalized.touchpoints : ['.'];
  return {
    version: 2,
    status: 'active',
    outcome: normalized.outcome,
    verify: normalized.verify,
    scope: {
      touchpoints: normalized.touchpoints,
      nonGoals: normalized.nonGoals,
    },
    invariants: normalized.invariants,
    quality: {
      risk: normalized.risk,
      profiles: normalized.profiles,
      gates: [
        {
          id: 'core.intent',
          dimension: 'intent',
          criterion: `The delivered milestone satisfies: ${normalized.outcome}`,
          oracle: 'Compare the final behavior and diff with the milestone outcome and inherited queue context',
          surface: ['.'],
          severity: 'high',
          state: 'pending',
          evidence: null,
        },
        {
          id: 'core.functional',
          dimension: 'functional-correctness',
          criterion: 'The changed behavior works across its stated acceptance cases',
          oracle: normalized.verify.join(' && ') || 'Run a focused behavioral check derived from the outcome',
          surface: affectedSurface,
          severity: 'high',
          state: 'pending',
          evidence: null,
        },
        {
          id: 'core.regression',
          dimension: 'regression',
          criterion: 'Existing behavior and listed invariants remain intact',
          oracle: 'Run the relevant regression suite and inspect affected contracts',
          surface: affectedSurface,
          severity: 'high',
          state: 'pending',
          evidence: null,
        },
        {
          id: 'core.failure-paths',
          dimension: 'failure-paths',
          criterion: 'Relevant invalid, boundary, and failure cases behave deliberately',
          oracle: 'Exercise or review the smallest discriminating failure-path probes',
          surface: affectedSurface,
          severity: 'medium',
          state: 'pending',
          evidence: null,
        },
        {
          id: 'core.completion-review',
          dimension: 'completion-review',
          criterion: 'A skeptical final review finds no unresolved in-scope quality gap',
          oracle: 'Review the final diff, test evidence, and remaining risks against every Flight gate',
          surface: ['.'],
          severity: 'high',
          state: 'pending',
          evidence: null,
        },
        ...normalized.profiles
          .filter((profile) => profile !== 'core')
          .flatMap((profile) => QUALITY_PROFILES[profile].map((dimension) => ({
            id: `${profile}.${dimension}`,
            dimension,
            criterion: `The ${dimension} quality dimension is satisfied for this milestone`,
            oracle: `Apply the ${profile} assurance profile and run a discriminating ${dimension} check`,
            surface: affectedSurface,
            severity: normalized.risk,
            state: 'pending',
            evidence: null,
          }))),
        ...(normalized.risk === 'high' || normalized.risk === 'critical'
          ? [{
              id: 'core.independent-review',
              dimension: 'independent-review',
              criterion: 'An independent skeptical review finds no unresolved high-risk issue',
              oracle: 'Run a bounded independent review against the final diff and Flight evidence',
              surface: ['.'],
              severity: normalized.risk,
              state: 'pending',
              evidence: null,
            }]
          : []),
      ],
    },
    body: `# Queue milestone ${normalized.id}\n\nCompiled from .cruise/QUEUE.md. Reconcile this milestone with the queue's cross-milestone compatibility obligations.${inherited}`,
  };
}
