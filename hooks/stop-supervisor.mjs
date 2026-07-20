#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const FLIGHT_FILE = '.cruise/FLIGHT.md';
const STATE_FILE = '.cruise/.supervisor.json';
const GITIGNORE_FILE = '.cruise/.gitignore';
const MAX_FLIGHT_AGE_MS = 48 * 60 * 60 * 1_000;
const DEFAULT_STALL = Object.freeze({ quietTurns: 3, sameFailure: 3 });
const FAILURE_LINE = /\b(?:error|fail(?:ed|ure)?|exception|panic|traceback)\b/iu;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function short(value) {
  return value ? value.slice(0, 12) : 'unavailable';
}

function cleanMessage(value) {
  return String(value ?? 'unknown error').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
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
  if (quote) throw new Error('unterminated flight-plan scalar');
  return value.trim();
}

function parseScalar(value) {
  const text = stripComment(value).trim();
  if (text === '[]') return [];
  if (text === '{}') return {};
  if (text === 'null' || text === '~') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?(?:0|[1-9]\d*)$/u.test(text)) return Number(text);
  if (text.startsWith('"')) {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'string') throw new Error('quoted flight-plan values must be strings');
    return parsed;
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new Error('invalid flight-plan scalar');
    return text.slice(1, -1).replace(/''/gu, "'");
  }
  if (!text || /^[!&*>|[{]/u.test(text)) throw new Error('unsupported flight-plan scalar');
  return text;
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function tokensFor(frontmatter) {
  const tokens = [];
  for (const [index, raw] of frontmatter.split(/\r?\n/u).entries()) {
    if (raw.includes('\t')) throw new Error('tabs are not valid flight-plan indentation');
    const indent = raw.match(/^ */u)[0].length;
    const content = stripComment(raw.slice(indent)).trim();
    if (!content) continue;
    if (indent % 2 !== 0) throw new Error('flight-plan indentation must use two spaces');
    tokens.push({ indent, content, line: index + 1 });
  }
  if (tokens.length > 1_000) throw new Error('flight-plan frontmatter is too large');
  return tokens;
}

function parseBlock(tokens, start, indent, depth = 0) {
  if (depth > 10) throw new Error('flight-plan frontmatter is too deeply nested');
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

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && !/[\r\n]/u.test(item));
}

// TODO(v0.3): consolidate this strict reader and fingerprint helper only when
// the packaged hook can remain a standalone process with no runtime coupling.
export function parseHookFlightPlan(text) {
  try {
    if (typeof text !== 'string' || text.length > 1_000_000) return null;
    const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u);
    if (lines[0]?.trim() !== '---') return null;
    const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (closing < 0) return null;
    const frontmatter = lines.slice(1, closing).join('\n');
    const tokens = tokensFor(frontmatter);
    const [raw, consumed] = tokens.length ? parseBlock(tokens, 0, 0) : [{}, 0];
    if (consumed !== tokens.length || !isMapping(raw)) return null;
    const status = raw.status ?? 'active';
    if (!['active', 'complete', 'blocked'].includes(status)) return null;
    const version = raw.version ?? 1;
    const outcome = raw.outcome ?? '';
    const verify = raw.verify ?? [];
    const scope = raw.scope ?? {};
    const invariants = raw.invariants ?? [];
    const stall = raw.stall ?? {};
    if (
      !Number.isSafeInteger(version) || version < 1 ||
      typeof outcome !== 'string' || /[\r\n]/u.test(outcome) ||
      !stringList(verify) ||
      !isMapping(scope) ||
      !stringList(scope.touchpoints ?? []) ||
      !stringList(scope.non_goals ?? []) ||
      !stringList(invariants) ||
      !isMapping(stall)
    ) return null;
    return {
      status,
      stall: {
        quietTurns: positiveInteger(stall.quiet_turns, DEFAULT_STALL.quietTurns),
        sameFailure: positiveInteger(stall.same_failure, DEFAULT_STALL.sameFailure),
      },
      frontmatterHash: digest(frontmatter),
    };
  } catch {
    return null;
  }
}

async function readFlightPlan(cwd, now) {
  const path = join(cwd, FLIGHT_FILE);
  try {
    const [text, metadata] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    const age = now - metadata.mtimeMs;
    if (age < 0 || age >= MAX_FLIGHT_AGE_MS) return null;
    return parseHookFlightPlan(text);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureScratchDirectory(cwd) {
  const directory = join(cwd, '.cruise');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('.cruise must be a real directory');
  return directory;
}

async function atomicWrite(path, text) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

async function ensureGitignore(directory) {
  const path = join(directory, basename(GITIGNORE_FILE));
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (text.split(/\r?\n/u).includes('.supervisor.json')) return;
  const next = `${text}${text && !text.endsWith('\n') ? '\n' : ''}.supervisor.json\n`;
  await atomicWrite(path, next);
}

function newState(flightHash, now) {
  return {
    version: 1,
    flight_hash: flightHash,
    has_observation: false,
    last_fingerprint: null,
    seen_fingerprints: [],
    last_failure: null,
    same_failure: 0,
    quiet_stops: 0,
    ladder: 'normal',
    blocks_in_cycle: 0,
    turns_observed: 0,
    interventions: [],
    observations: [],
    created_at: now,
    updated_at: now,
  };
}

function validState(value) {
  return value &&
    value.version === 1 &&
    typeof value.flight_hash === 'string' &&
    typeof value.has_observation === 'boolean' &&
    (value.last_fingerprint === null || typeof value.last_fingerprint === 'string') &&
    Array.isArray(value.seen_fingerprints) &&
    (value.last_failure === null || typeof value.last_failure === 'string') &&
    Number.isInteger(value.same_failure) && value.same_failure >= 0 &&
    Number.isInteger(value.quiet_stops) && value.quiet_stops >= 0 &&
    ['normal', 'realign', 'final', 'stalled'].includes(value.ladder) &&
    Number.isInteger(value.blocks_in_cycle) && value.blocks_in_cycle >= 0 &&
    Number.isInteger(value.turns_observed) && value.turns_observed >= 0 &&
    Array.isArray(value.interventions) && Array.isArray(value.observations);
}

async function readState(directory, flightHash, now) {
  const path = join(directory, basename(STATE_FILE));
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (!validState(parsed)) throw new Error('supervisor scratch state is malformed');
    return parsed.flight_hash === flightHash ? parsed : newState(flightHash, now);
  } catch (error) {
    if (error?.code === 'ENOENT') return newState(flightHash, now);
    throw error;
  }
}

async function writeState(directory, state) {
  await atomicWrite(join(directory, basename(STATE_FILE)), `${JSON.stringify(state, null, 2)}\n`);
}

async function captureWorkspaceFingerprint(cwd) {
  try {
    const options = { cwd, encoding: 'utf8', maxBuffer: Infinity };
    const [statusResult, diffResult, cachedResult] = await Promise.all([
      execFileAsync('git', ['status', '--porcelain=v1'], options),
      execFileAsync('git', ['diff'], options),
      execFileAsync('git', ['diff', '--cached'], options),
    ]);
    return digest(`${statusResult.stdout}\u0000${diffResult.stdout}\u0000${cachedResult.stdout}`);
  } catch {
    return null;
  }
}

function failureSignature(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/u).filter((line) => FAILURE_LINE.test(line));
  if (!lines.length) return null;
  const normalized = lines.map((line) => line
    .replace(/\b[A-Za-z]:\\(?:[^\\\r\n:]+\\)*[^:\r\n]+?(?=:\d+(?::\d+)?\b|$)/gu, '<path>')
    .replace(/\/(?:[^/\r\n:]+\/)*[^:\r\n]+?(?=:\d+(?::\d+)?\b|$)/gu, '<path>')
    .replace(/\b(?:0x[a-f\d]+|[a-f\d]{7,})\b/giu, '<hex>')
    .replace(/\d+/gu, '<n>')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase());
  return digest(normalized.join('\n'));
}

function resetCycle(state) {
  state.quiet_stops = 0;
  state.same_failure = 0;
  state.ladder = 'normal';
  state.blocks_in_cycle = 0;
  state.interventions = [];
}

function observe(state, fingerprint, signature, now) {
  const priorFingerprint = state.last_fingerprint;
  const priorFailure = state.last_failure;
  let progress = false;
  let reason;
  if (!state.has_observation) {
    reason = fingerprint === null
      ? 'workspace fingerprint unavailable; initial signature-only baseline recorded'
      : `workspace baseline fingerprint ${short(fingerprint)} recorded`;
  } else if (fingerprint !== null && fingerprint !== priorFingerprint && !state.seen_fingerprints.includes(fingerprint)) {
    progress = true;
    reason = `workspace evidence changed to new fingerprint ${short(fingerprint)}`;
  } else if (fingerprint !== null && fingerprint !== priorFingerprint) {
    state.quiet_stops += 1;
    reason = `workspace oscillated to earlier fingerprint ${short(fingerprint)} after ${state.quiet_stops} quiet stops`;
  } else {
    state.quiet_stops += 1;
    reason = fingerprint === null
      ? `workspace fingerprint unavailable for ${state.quiet_stops} consecutive quiet stops`
      : `workspace fingerprint ${short(fingerprint)} unchanged for ${state.quiet_stops} consecutive quiet stops`;
  }

  state.same_failure = signature === null ? 0 : signature === priorFailure ? state.same_failure + 1 : 1;
  if (fingerprint === null && priorFailure !== null && signature !== priorFailure) {
    progress = true;
    reason = signature === null
      ? `failure signature ${short(priorFailure)} cleared in signature-only supervision`
      : `failure evidence changed from ${short(priorFailure)} to ${short(signature)} in signature-only supervision`;
  }
  if (progress) resetCycle(state);
  else {
    reason = `${reason}; ${signature === null
      ? 'no repeated failure signature was present'
      : `failure signature ${short(signature)} repeated ${state.same_failure} consecutive stops`}`;
  }
  state.has_observation = true;
  state.last_fingerprint = fingerprint;
  state.last_failure = signature;
  if (fingerprint !== null && !state.seen_fingerprints.includes(fingerprint)) {
    state.seen_fingerprints.push(fingerprint);
    state.seen_fingerprints = state.seen_fingerprints.slice(-32);
  }
  state.turns_observed += 1;
  state.observations.push({ at: now, fingerprint, failure_signature: signature, reason });
  state.observations = state.observations.slice(-32);
  state.updated_at = now;
  return { progress, reason };
}

function standardReason(observation) {
  return [
    `Cruise Goal supervision observed: ${observation}.`,
    'Continue the active Goal: reread .cruise/FLIGHT.md, reconcile scope and invariants, implement the next ready micro-goal, and run its verification.',
    'Routine progression is already authorized; keep the flight-plan status truthful.',
  ].join(' ');
}

function realignReason(observation) {
  return [
    `Cruise Goal supervision observed non-progress: ${observation}.`,
    'Repeating the same approach is not progress.',
    'Run the smallest discriminating experiment that produces new evidence, or set status: blocked in .cruise/FLIGHT.md and state the concrete blocker in its body.',
  ].join(' ');
}

function finalReason(observation) {
  return [
    `Cruise Goal supervision still observes no progress after realignment: ${observation}.`,
    'Produce new evidence this turn or set status: blocked in .cruise/FLIGHT.md with a concrete blocker report.',
    'This is the final supervised continuation before the hook allows the stop with a stall report.',
  ].join(' ');
}

function stallMessage(state, observation, capReached = false) {
  const interventions = state.interventions.length
    ? state.interventions.map((item) => item.level).join(', ')
    : 'continuation cap reached before a complete intervention record';
  return [
    `Cruise Goal stall supervisor allowed this stop after ${state.turns_observed} observed stops.`,
    `Observed: ${observation}.`,
    `Interventions attempted: ${interventions}.`,
    capReached ? `The hard backstop of ${state.blocks_in_cycle} blocked stops was reached.` : 'The realignment and final-experiment ladder produced no new evidence.',
    'Suggested next actions: inspect the last diff and failure, edit .cruise/FLIGHT.md if its scope or tuning is stale, provide missing evidence or a material decision, then resume explicitly.',
    'The stop was allowed; this scratch state grants no authority and is safe to delete.',
  ].join('\n');
}

export async function runStopSupervisor(input, {
  now = Date.now(),
  goalSession = process.env.CRUISE_CLAUDE_GOAL === '1',
} = {}) {
  if (!input || input.hook_event_name !== 'Stop' || typeof input.cwd !== 'string' || !input.cwd) return null;
  if (!goalSession) return null;
  const cwd = resolve(input.cwd);
  const flight = await readFlightPlan(cwd, now);
  if (!flight || flight.status !== 'active') return null;

  const directory = await ensureScratchDirectory(cwd);
  await ensureGitignore(directory);
  const state = await readState(directory, flight.frontmatterHash, now);
  const [fingerprint, signature] = await Promise.all([
    captureWorkspaceFingerprint(cwd),
    Promise.resolve(failureSignature(input.last_assistant_message)),
  ]);
  const observation = observe(state, fingerprint, signature, now);
  const blockCap = flight.stall.quietTurns + 2;
  let output;
  if (state.ladder === 'stalled') {
    output = { systemMessage: stallMessage(state, observation.reason) };
  } else if (state.blocks_in_cycle >= blockCap) {
    state.ladder = 'stalled';
    output = { systemMessage: stallMessage(state, observation.reason, true) };
  } else if (state.ladder === 'realign') {
    state.ladder = 'final';
    state.blocks_in_cycle += 1;
    state.interventions.push({ level: 'final-experiment', at: now, reason: observation.reason });
    output = { decision: 'block', reason: finalReason(observation.reason) };
  } else if (state.ladder === 'final') {
    state.ladder = 'stalled';
    output = { systemMessage: stallMessage(state, observation.reason) };
  } else if (
    state.quiet_stops >= flight.stall.quietTurns ||
    state.same_failure >= flight.stall.sameFailure
  ) {
    state.ladder = 'realign';
    state.blocks_in_cycle += 1;
    state.interventions.push({ level: 'realign', at: now, reason: observation.reason });
    output = { decision: 'block', reason: realignReason(observation.reason) };
  } else {
    state.blocks_in_cycle += 1;
    output = { decision: 'block', reason: standardReason(observation.reason) };
  }
  await writeState(directory, state);
  return output;
}

async function readInput(stream) {
  let text = '';
  for await (const chunk of stream) {
    text += chunk;
    if (text.length > 1_000_000) throw new Error('hook input exceeds 1 MB');
  }
  return JSON.parse(text);
}

export async function main({ input = process.stdin, output = process.stdout } = {}) {
  try {
    const result = await runStopSupervisor(await readInput(input));
    if (result) output.write(JSON.stringify(result));
  } catch (error) {
    output.write(JSON.stringify({
      systemMessage: `Cruise Goal stop supervisor failed open: ${cleanMessage(error?.message)}. The stop was allowed; delete .cruise/.supervisor.json if its scratch state is damaged.`,
    }));
  }
  return 0;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : null;
if (invoked === fileURLToPath(import.meta.url)) process.exitCode = await main();
