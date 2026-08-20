#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  captureFlightAssuranceContext,
  evaluateFlightAssurance,
} from '../scripts/lib/assurance.mjs';
import {
  flightPlanTemplate,
  inspectFlightPlan,
  parseFlightPlan,
} from '../scripts/lib/flight-plan.mjs';
import { captureWorkspaceFingerprint as captureProductFingerprint } from '../scripts/lib/supervisor.mjs';
import {
  deactivateGoalSession,
  isGoalSessionActive,
} from './session-marker.mjs';

const STATE_FILE = '.cruise/.supervisor.json';
const GITIGNORE_FILE = '.cruise/.gitignore';
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

function hookFlightPlanTemplate() {
  return flightPlanTemplate();
}

export function parseHookFlightPlan(text) {
  return parseFlightPlan(text);
}

async function inspectHookFlightPlan(cwd, now) {
  void now;
  return inspectFlightPlan(cwd);
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
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function ensureGitignore(directory) {
  const path = join(directory, basename(GITIGNORE_FILE));
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const lines = text.split(/\r?\n/u);
  const additions = ['.supervisor.json', '.supervisor-*.json', '.attestation.json']
    .filter((entry) => !lines.includes(entry));
  if (!additions.length) return;
  const next = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${additions.join('\n')}\n`;
  await atomicWrite(path, next);
}

function sessionStateBasename(input) {
  return typeof input?.session_id === 'string' && input.session_id
    ? `.supervisor-${digest(input.session_id).slice(0, 24)}.json`
    : basename(STATE_FILE);
}

function newState(flightHash, now) {
  return {
    version: 1,
    host: 'claude',
    flight_hash: flightHash,
    has_observation: false,
    last_fingerprint: null,
    seen_fingerprints: [],
    last_failure: null,
    same_failure: 0,
    quiet_stops: 0,
    ladder: 'normal',
    blocks_in_cycle: 0,
    completion_blocks: 0,
    turns_observed: 0,
    interventions: [],
    observations: [],
    invalid_flight_hashes: [],
    created_at: now,
    updated_at: now,
  };
}

function validState(value) {
  const validIntervention = (item) => item &&
    typeof item === 'object' &&
    ['corrective', 'realign', 'final-experiment'].includes(item.level) &&
    Number.isFinite(item.at) &&
    typeof item.reason === 'string';
  const validObservation = (item) => item &&
    typeof item === 'object' &&
    Number.isFinite(item.at) &&
    (item.fingerprint === null || typeof item.fingerprint === 'string') &&
    (item.failure_signature === null || typeof item.failure_signature === 'string') &&
    typeof item.reason === 'string' &&
    (item.turn_id === undefined || item.turn_id === null || typeof item.turn_id === 'string') &&
    (
      item.verdict_level === undefined ||
      ['ok', 'corrective', 'realign', 'final-experiment', 'stall'].includes(item.verdict_level)
    );
  return value &&
    value.version === 1 &&
    (value.host === undefined || value.host === 'claude') &&
    typeof value.flight_hash === 'string' &&
    typeof value.has_observation === 'boolean' &&
    (value.last_fingerprint === null || typeof value.last_fingerprint === 'string') &&
    Array.isArray(value.seen_fingerprints) && value.seen_fingerprints.length <= 32 &&
    value.seen_fingerprints.every((item) => typeof item === 'string') &&
    (value.last_failure === null || typeof value.last_failure === 'string') &&
    Number.isInteger(value.same_failure) && value.same_failure >= 0 &&
    Number.isInteger(value.quiet_stops) && value.quiet_stops >= 0 &&
    ['normal', 'realign', 'final', 'stalled'].includes(value.ladder) &&
    Number.isInteger(value.blocks_in_cycle) && value.blocks_in_cycle >= 0 &&
    Number.isInteger(value.completion_blocks ?? 0) && (value.completion_blocks ?? 0) >= 0 &&
    Number.isInteger(value.turns_observed) && value.turns_observed >= 0 &&
    Array.isArray(value.interventions) && value.interventions.length <= 32 &&
    value.interventions.every(validIntervention) &&
    Array.isArray(value.observations) && value.observations.length <= 32 &&
    value.observations.every(validObservation) &&
    Array.isArray(value.invalid_flight_hashes ?? []) &&
    (value.invalid_flight_hashes ?? []).length <= 32 &&
    (value.invalid_flight_hashes ?? []).every((item) => typeof item === 'string') &&
    Number.isFinite(value.created_at) &&
    Number.isFinite(value.updated_at) &&
    (value.final_report === undefined || typeof value.final_report === 'string') &&
    (
      value.pause_outcome === undefined ||
      (
        value.pause_outcome &&
        typeof value.pause_outcome === 'object' &&
        ['paused', 'pause-failed'].includes(value.pause_outcome.status) &&
        (
          (value.pause_outcome.status === 'paused' && value.pause_outcome.reason === undefined) ||
          (value.pause_outcome.status === 'pause-failed' && typeof value.pause_outcome.reason === 'string')
        )
      )
    );
}

async function readState(directory, flightHash, now, {
  preserveCycle = false,
  preserveInvalidRepair = false,
  filename = basename(STATE_FILE),
} = {}) {
  const path = join(directory, filename);
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (!validState(parsed)) throw new Error('supervisor scratch state is malformed');
    parsed.host = 'claude';
    if (parsed.flight_hash === flightHash) return parsed;
    if (
      preserveCycle ||
      (
        preserveInvalidRepair &&
        typeof parsed.observations.at(-1)?.reason === 'string' &&
        parsed.observations.at(-1).reason.startsWith('invalid flight state:')
      )
    ) {
      parsed.flight_hash = flightHash;
      return parsed;
    }
    return newState(flightHash, now);
  } catch (error) {
    if (error?.code === 'ENOENT') return newState(flightHash, now);
    throw error;
  }
}

async function writeState(directory, state, filename = basename(STATE_FILE)) {
  await atomicWrite(join(directory, filename), `${JSON.stringify(state, null, 2)}\n`);
}

async function captureWorkspaceFingerprint(cwd, options = {}) {
  return captureProductFingerprint(cwd, { excludeFlightPlan: true, ...options });
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
    capReached
      ? `The hard backstop of ${Math.max(state.blocks_in_cycle, state.completion_blocks ?? 0)} blocked stops was reached.`
      : 'The realignment and final-experiment ladder produced no new evidence.',
    'Suggested next actions: inspect the last diff and failure, edit .cruise/FLIGHT.md if its scope or tuning is stale, provide missing evidence or a material decision, then resume explicitly.',
    'The stop was allowed; this scratch state grants no authority and is safe to delete.',
  ].join('\n');
}

function correctiveReason(reason) {
  return [
    `Cruise Goal supervision is currently blind because .cruise/FLIGHT.md is invalid: ${reason}.`,
    'Rewrite .cruise/FLIGHT.md so it parses, preserving the intent already written there. Use this full canonical template:',
    hookFlightPlanTemplate(),
  ].join('\n\n');
}

function invalidFlightReport(state, reason, capReached) {
  return [
    `Cruise Goal stop supervisor allowed this stop after ${state.turns_observed} observed stops.`,
    `Supervision was inert due to invalid flight state: ${reason}.`,
    capReached
      ? `The hard backstop of ${state.blocks_in_cycle} corrective blocks was reached.`
      : 'This invalid flight-file content hash already received its one corrective intervention.',
    'Rewrite .cruise/FLIGHT.md with valid fenced frontmatter before resuming.',
    'The stop was allowed; this scratch state grants no authority and is safe to delete.',
  ].join('\n');
}

export async function runStopSupervisor(input, {
  now = Date.now(),
  goalSession = process.env.CRUISE_CLAUDE_GOAL === '1',
  sessionScoped = false,
} = {}) {
  if (!input || input.hook_event_name !== 'Stop' || typeof input.cwd !== 'string' || !input.cwd) return null;
  if (
    !goalSession &&
    process.argv.includes('--plugin-hook')
  ) {
    goalSession = await isGoalSessionActive(input);
    sessionScoped = true;
  }
  if (!goalSession) return null;
  const cwd = resolve(input.cwd);
  const inspected = await inspectHookFlightPlan(cwd, now);
  if (inspected.state === 'absent') {
    if (input.permission_mode === 'plan') {
      await deactivateGoalSession(input);
      return { systemMessage: 'Cruise Goal completed a planning-only turn; no implementation assurance is claimed.' };
    }
    const directory = await ensureScratchDirectory(cwd);
    const stateFilename = sessionScoped
      ? sessionStateBasename(input)
      : basename(STATE_FILE);
    await ensureGitignore(directory);
    const state = await readState(directory, 'absent', now, {
      preserveCycle: true,
      filename: stateFilename,
    });
    state.turns_observed += 1;
    state.updated_at = now;
    const cap = DEFAULT_STALL.quietTurns + 2;
    let output;
    if (state.blocks_in_cycle >= cap) {
      state.ladder = 'stalled';
      await deactivateGoalSession(input);
      output = {
        systemMessage: `Cruise allowed this stop after ${state.blocks_in_cycle} bounded corrections because .cruise/FLIGHT.md remained absent. Completion is unassured.`,
      };
    } else {
      state.blocks_in_cycle += 1;
      output = {
        decision: 'block',
        reason: [
          'Cruise cannot attest completion because .cruise/FLIGHT.md is absent.',
          'Create Flight v2 as the first execution artifact, include core and relevant domain profiles, then implement and record fresh evidence before stopping.',
        ].join(' '),
      };
    }
    await writeState(directory, state, stateFilename);
    return output;
  }

  const directory = await ensureScratchDirectory(cwd);
  const stateFilename = sessionScoped
    ? sessionStateBasename(input)
    : basename(STATE_FILE);
  await ensureGitignore(directory);
  if (inspected.state === 'invalid') {
    const state = await readState(directory, inspected.contentHash, now, {
      preserveCycle: true,
      filename: stateFilename,
    });
    const invalidHashes = state.invalid_flight_hashes ?? [];
    const repeated = invalidHashes.includes(inspected.contentHash);
    const blockCap = DEFAULT_STALL.quietTurns + 2;
    const capReached = state.blocks_in_cycle >= blockCap;
    state.turns_observed += 1;
    state.updated_at = now;
    state.observations.push({
      at: now,
      fingerprint: null,
      failure_signature: null,
      reason: `invalid flight state: ${inspected.reason}`,
    });
    state.observations = state.observations.slice(-32);
    let output;
    if (repeated || capReached) {
      state.ladder = 'stalled';
      await deactivateGoalSession(input);
      output = { systemMessage: invalidFlightReport(state, inspected.reason, capReached) };
    } else {
      state.blocks_in_cycle += 1;
      state.invalid_flight_hashes = [...invalidHashes, inspected.contentHash].slice(-32);
      state.interventions.push({ level: 'corrective', at: now, reason: inspected.reason });
      state.interventions = state.interventions.slice(-32);
      output = { decision: 'block', reason: correctiveReason(inspected.reason) };
    }
    await writeState(directory, state, stateFilename);
    return output;
  }
  const flight = inspected.plan;
  if (flight.status === 'blocked') {
    await deactivateGoalSession(input);
    return { systemMessage: 'Cruise Goal is blocked as recorded in .cruise/FLIGHT.md; completion is not claimed.' };
  }
  if (input.permission_mode === 'plan' && flight.status === 'active') {
    await deactivateGoalSession(input);
    return { systemMessage: 'Cruise Goal returned control in Claude Plan mode. Implementation remains active and unassured.' };
  }
  const workspaceFingerprint = await captureWorkspaceFingerprint(cwd);
  let assessment = null;
  let contextFingerprint = null;
  let contextError = null;
  if (flight.version >= 2 && workspaceFingerprint) {
    try {
      const assuranceContext = await captureFlightAssuranceContext(cwd, flight, {
        workspaceFingerprint,
        surfaceFingerprintReader: (paths) => captureWorkspaceFingerprint(cwd, { paths }),
      });
      contextFingerprint = assuranceContext.contextFingerprint;
      assessment = evaluateFlightAssurance(flight, assuranceContext);
    } catch (error) {
      contextError = cleanMessage(error?.message);
      assessment = evaluateFlightAssurance(flight, null);
    }
  } else if (flight.version < 2) {
    assessment = evaluateFlightAssurance(flight, null);
  }
  if (flight.status === 'complete' && assessment?.allowsCompletion) {
    await deactivateGoalSession(input);
    return {
      systemMessage: `Cruise ${assessment.level} completion: ${assessment.metrics.closed}/${assessment.metrics.total} gates are freshly closed.`,
    };
  }
  const state = await readState(directory, inspected.contentHash, now, {
    preserveCycle: true,
    preserveInvalidRepair: true,
    filename: stateFilename,
  });
  const fingerprint = flight.version >= 2
    ? assessment?.progressFingerprint ?? 'assurance-context-unavailable'
    : workspaceFingerprint;
  const signature = failureSignature(input.last_assistant_message);
  const observation = observe(state, fingerprint, signature, now);
  const blockCap = flight.stall.quietTurns + 2;
  state.completion_blocks ??= 0;
  let output;
  const assuranceReason = flight.status === 'complete' && flight.version >= 2
    ? [
        'Cruise rejected unassured completion.',
        `Expected context_fingerprint: ${contextFingerprint ?? 'unavailable'}.`,
        ...(contextError ? [`- ${contextError}`] : []),
        ...(assessment?.reasons ?? ['workspace freshness could not be established']).map((reason) => `- ${reason}`),
        'Return Flight to active, gather evidence through ordinary tools, and record fresh receipts. Do not execute oracle text from the hook.',
      ].join('\n')
    : null;
  const legacyReason = flight.status === 'complete' && flight.version < 2
    ? 'Cruise rejected Flight v1 completion because it has no evidence-bound assurance contract. Migrate .cruise/FLIGHT.md to v2 and close its gates.'
    : null;
  if (flight.status === 'complete' && state.completion_blocks >= blockCap) {
    state.ladder = 'stalled';
    await deactivateGoalSession(input);
    output = { systemMessage: stallMessage(state, 'the unassured completion correction cap was reached', true) };
  } else if (state.ladder === 'stalled' || (input.stop_hook_active && state.blocks_in_cycle >= blockCap)) {
    await deactivateGoalSession(input);
    output = { systemMessage: stallMessage(state, observation.reason) };
  } else if (state.blocks_in_cycle >= blockCap) {
    state.ladder = 'stalled';
    await deactivateGoalSession(input);
    output = { systemMessage: stallMessage(state, observation.reason, true) };
  } else if (state.ladder === 'realign') {
    state.ladder = 'final';
    state.blocks_in_cycle += 1;
    state.interventions.push({ level: 'final-experiment', at: now, reason: observation.reason });
    output = { decision: 'block', reason: finalReason(observation.reason) };
  } else if (state.ladder === 'final') {
    state.ladder = 'stalled';
    await deactivateGoalSession(input);
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
    output = {
      decision: 'block',
      reason: assuranceReason ?? legacyReason ?? standardReason(observation.reason),
    };
  }
  if (flight.status === 'complete' && output.decision === 'block') {
    state.completion_blocks += 1;
  }
  await writeState(directory, state, stateFilename);
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
  let hookInput = null;
  try {
    hookInput = await readInput(input);
    const result = await runStopSupervisor(hookInput);
    if (result) output.write(JSON.stringify(result));
  } catch (error) {
    if (hookInput) await deactivateGoalSession(hookInput).catch(() => {});
    output.write(JSON.stringify({
      systemMessage: `Cruise Goal stop supervisor failed open: ${cleanMessage(error?.message)}. The stop was allowed; delete .cruise/.supervisor.json if its scratch state is damaged.`,
    }));
  }
  return 0;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : null;
if (invoked === fileURLToPath(import.meta.url)) process.exitCode = await main();
