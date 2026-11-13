import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { DEFAULT_STALL } from './flight-plan.mjs';
import { writeRuntimeJson } from './runtime-state.mjs';
import { USER_ONLY_MARKDOWN_PATHSPEC } from './user-reference.mjs';
import { isSensitivePath, SENSITIVE_GIT_PATHSPECS } from './sensitive-path.mjs';

const execFileAsync = promisify(execFile);
const FAILURE_LINE = /\b(?:error|fail(?:ed|ure)?|exception|panic|traceback)\b/iu;
export const MAX_SUPERVISOR_HISTORY = 32;
export const SUPERVISOR_STATE_FILE = 'supervisor.json';
let atomicSequence = 0;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function short(value) {
  return value ? value.slice(0, 12) : 'unavailable';
}

function assertThreshold(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function remember(set, value) {
  set.delete(value);
  set.add(value);
  while (set.size > MAX_SUPERVISOR_HISTORY) set.delete(set.values().next().value);
}

export class GoalSupervisor {
  constructor({ stall = DEFAULT_STALL, now = Date.now, maxTurns = null } = {}) {
    this.stall = null;
    this.updateStall(stall);
    this.now = now;
    if (maxTurns !== null && (!Number.isSafeInteger(maxTurns) || maxTurns < 1)) {
      throw new TypeError('maxTurns must be a positive integer or null');
    }
    this.maxTurns = maxTurns;
    this.createdAt = this.now();
    this.updatedAt = this.createdAt;
    this.turnsObserved = 0;
    this.turnsInCycle = 0;
    this.quietTurns = 0;
    this.sameFailure = 0;
    this.previousFingerprint = null;
    this.previousFailure = null;
    this.seenFingerprints = new Set();
    this.seenFailures = new Set();
    this.stage = 'observing';
    this.interventions = [];
    this.observations = [];
    this.invalidFlightHashes = [];
  }

  updateStall(stall = DEFAULT_STALL) {
    this.stall = Object.freeze({
      quietTurns: assertThreshold(stall?.quietTurns, 'stall.quietTurns'),
      sameFailure: assertThreshold(stall?.sameFailure, 'stall.sameFailure'),
    });
  }

  recordTurn({
    fingerprint = null,
    failureSignature = null,
    turnId = null,
    at = this.now(),
    corrective = null,
  } = {}) {
    if (fingerprint !== null && typeof fingerprint !== 'string') throw new TypeError('fingerprint must be a string or null');
    if (failureSignature !== null && typeof failureSignature !== 'string') throw new TypeError('failureSignature must be a string or null');
    this.turnsObserved += 1;
    this.turnsInCycle += 1;
    const priorFailure = this.previousFailure;
    const finish = (verdict) => {
      this.updatedAt = at;
      this.observations.push({
        at,
        fingerprint,
        failure_signature: failureSignature,
        reason: verdict.reason,
        turn_id: turnId,
        verdict_level: verdict.level,
      });
      this.observations = this.observations.slice(-MAX_SUPERVISOR_HISTORY);
      return verdict;
    };
    const conclude = (verdict) => {
      if (
        corrective &&
        verdict.level !== 'stall' &&
        !this.invalidFlightHashes.includes(corrective.contentHash)
      ) {
        this.invalidFlightHashes.push(corrective.contentHash);
        this.invalidFlightHashes = this.invalidFlightHashes.slice(-MAX_SUPERVISOR_HISTORY);
        this.interventions.push({ level: 'corrective', at, reason: corrective.reason });
        this.interventions = this.interventions.slice(-MAX_SUPERVISOR_HISTORY);
        return finish({ level: 'corrective', reason: corrective.reason });
      }
      if (['realign', 'final-experiment'].includes(verdict.level)) {
        this.interventions.push({ level: verdict.level, at, reason: verdict.reason });
        this.interventions = this.interventions.slice(-MAX_SUPERVISOR_HISTORY);
      }
      return finish(verdict);
    };

    if (this.maxTurns !== null && this.turnsObserved >= this.maxTurns) {
      this.stage = 'stalled';
      return conclude({
        level: 'stall',
        reason: `absolute supervision cap of ${this.maxTurns} completion attempts was reached`,
      });
    }

    let workspaceObservation = null;
    let progress = false;
    if (fingerprint !== null) {
      if (this.previousFingerprint === null) {
        workspaceObservation = `workspace baseline fingerprint ${short(fingerprint)} was recorded`;
      } else if (fingerprint !== this.previousFingerprint && !this.seenFingerprints.has(fingerprint)) {
        progress = true;
        workspaceObservation = `workspace evidence changed to new fingerprint ${short(fingerprint)}`;
      } else if (fingerprint === this.previousFingerprint) {
        this.quietTurns += 1;
        workspaceObservation = `workspace fingerprint ${short(fingerprint)} was unchanged for ${this.quietTurns} consecutive turn${this.quietTurns === 1 ? '' : 's'}`;
      } else {
        this.quietTurns += 1;
        workspaceObservation = `workspace oscillated to earlier fingerprint ${short(fingerprint)} after ${this.quietTurns} unproductive turn${this.quietTurns === 1 ? '' : 's'}`;
      }
      this.previousFingerprint = fingerprint;
      remember(this.seenFingerprints, fingerprint);
    }

    if (failureSignature === null) {
      this.sameFailure = 0;
      this.previousFailure = null;
    } else {
      this.sameFailure = failureSignature === this.previousFailure ? this.sameFailure + 1 : 1;
      this.previousFailure = failureSignature;
      remember(this.seenFailures, failureSignature);
    }

    if (progress) {
      this.quietTurns = 0;
      this.sameFailure = 0;
      this.stage = 'observing';
      this.interventions = [];
      this.turnsInCycle = 0;
      return conclude({ level: 'ok', reason: workspaceObservation });
    }

    if (
      fingerprint === null &&
      priorFailure !== null &&
      failureSignature !== priorFailure
    ) {
      this.quietTurns = 0;
      this.stage = 'observing';
      this.interventions = [];
      this.turnsInCycle = 0;
      return conclude({
        level: 'ok',
        reason: failureSignature === null
          ? `failure signature ${short(priorFailure)} cleared in the signature-only supervision path`
          : `failure evidence changed from signature ${short(priorFailure)} to ${short(failureSignature)} in the signature-only supervision path`,
      });
    }

    const reason = this.#reason(workspaceObservation, failureSignature);
    if (this.stage === 'realigned') {
      this.stage = 'final';
      return conclude({ level: 'final-experiment', reason });
    }
    if (this.stage === 'final' || this.stage === 'stalled') {
      this.stage = 'stalled';
      return conclude({ level: 'stall', reason });
    }
    if (
      this.quietTurns >= this.stall.quietTurns ||
      this.sameFailure >= this.stall.sameFailure
    ) {
      this.stage = 'realigned';
      return conclude({ level: 'realign', reason });
    }
    return conclude({ level: 'ok', reason });
  }

  #reason(workspaceObservation, failureSignature) {
    const reasons = [];
    if (workspaceObservation) reasons.push(workspaceObservation);
    else reasons.push('workspace fingerprint evidence was unavailable');
    if (failureSignature !== null) {
      reasons.push(`failure signature ${short(failureSignature)} repeated ${this.sameFailure} consecutive turn${this.sameFailure === 1 ? '' : 's'}`);
    } else {
      reasons.push('no repeated failure signature was present');
    }
    return reasons.join('; ');
  }

  summary() {
    return Object.freeze({
      turnsObserved: this.turnsObserved,
      fingerprints: Object.freeze([...this.seenFingerprints].map(short)),
      failureSignatures: Object.freeze([...this.seenFailures].map(short)),
      interventions: Object.freeze(this.interventions.map((item) => Object.freeze({ ...item }))),
    });
  }

  state({ flightHash = 'absent', finalReport = null, pauseOutcome = null } = {}) {
    const ladders = {
      observing: 'normal',
      realigned: 'realign',
      final: 'final',
      stalled: 'stalled',
    };
    return {
      version: 1,
      host: 'codex',
      flight_hash: flightHash,
      has_observation: this.turnsObserved > 0,
      last_fingerprint: this.previousFingerprint,
      seen_fingerprints: [...this.seenFingerprints].slice(-MAX_SUPERVISOR_HISTORY),
      last_failure: this.previousFailure,
      same_failure: this.sameFailure,
      quiet_stops: this.quietTurns,
      ladder: ladders[this.stage],
      blocks_in_cycle: this.turnsInCycle,
      completion_blocks: 0,
      turns_observed: this.turnsObserved,
      interventions: this.interventions.slice(-MAX_SUPERVISOR_HISTORY).map((item) => ({ ...item })),
      observations: this.observations.slice(-MAX_SUPERVISOR_HISTORY).map((item) => ({ ...item })),
      invalid_flight_hashes: this.invalidFlightHashes.slice(-MAX_SUPERVISOR_HISTORY),
      created_at: this.createdAt,
      updated_at: this.updatedAt,
      ...(finalReport === null ? {} : { final_report: finalReport }),
      ...(pauseOutcome === null ? {} : { pause_outcome: pauseOutcome }),
    };
  }
}

export function validSupervisorState(value) {
  const validIntervention = (item) => Boolean(
    item &&
    typeof item === 'object' &&
    ['corrective', 'realign', 'final-experiment'].includes(item.level) &&
    Number.isFinite(item.at) &&
    typeof item.reason === 'string'
  );
  const validObservation = (item) => Boolean(
    item &&
    typeof item === 'object' &&
    Number.isFinite(item.at) &&
    (item.fingerprint === null || typeof item.fingerprint === 'string') &&
    (item.failure_signature === null || typeof item.failure_signature === 'string') &&
    typeof item.reason === 'string' &&
    (item.turn_id === undefined || item.turn_id === null || typeof item.turn_id === 'string') &&
    (
      item.verdict_level === undefined ||
      ['ok', 'corrective', 'realign', 'final-experiment', 'stall'].includes(item.verdict_level)
    )
  );
  const validPauseOutcome = (outcome) => Boolean(
    outcome &&
    typeof outcome === 'object' &&
    ['paused', 'pause-failed'].includes(outcome.status) &&
    (
      (outcome.status === 'paused' && outcome.reason === undefined) ||
      (outcome.status === 'pause-failed' && typeof outcome.reason === 'string')
    )
  );
  return Boolean(
    value &&
    value.version === 1 &&
    ['codex', 'claude'].includes(value.host) &&
    typeof value.flight_hash === 'string' &&
    typeof value.has_observation === 'boolean' &&
    (value.last_fingerprint === null || typeof value.last_fingerprint === 'string') &&
    Array.isArray(value.seen_fingerprints) &&
    value.seen_fingerprints.length <= MAX_SUPERVISOR_HISTORY &&
    value.seen_fingerprints.every((item) => typeof item === 'string') &&
    (value.last_failure === null || typeof value.last_failure === 'string') &&
    Number.isInteger(value.same_failure) && value.same_failure >= 0 &&
    Number.isInteger(value.quiet_stops) && value.quiet_stops >= 0 &&
    ['normal', 'realign', 'final', 'stalled'].includes(value.ladder) &&
    Number.isInteger(value.blocks_in_cycle) && value.blocks_in_cycle >= 0 &&
    Number.isInteger(value.completion_blocks ?? 0) && (value.completion_blocks ?? 0) >= 0 &&
    Number.isInteger(value.turns_observed) && value.turns_observed >= 0 &&
    Array.isArray(value.interventions) &&
    value.interventions.length <= MAX_SUPERVISOR_HISTORY &&
    value.interventions.every(validIntervention) &&
    Array.isArray(value.observations) &&
    value.observations.length <= MAX_SUPERVISOR_HISTORY &&
    value.observations.every(validObservation) &&
    Array.isArray(value.invalid_flight_hashes ?? []) &&
    (value.invalid_flight_hashes ?? []).length <= MAX_SUPERVISOR_HISTORY &&
    (value.invalid_flight_hashes ?? []).every((item) => typeof item === 'string') &&
    Number.isFinite(value.created_at) &&
    Number.isFinite(value.updated_at) &&
    (value.final_report === undefined || typeof value.final_report === 'string') &&
    (value.pause_outcome === undefined || validPauseOutcome(value.pause_outcome))
  );
}

export async function atomicWriteText(path, text, {
  write = writeFile,
  move = rename,
  remove = unlink,
  pid = process.pid,
  now = Date.now,
} = {}) {
  atomicSequence += 1;
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${pid}.${now()}.${atomicSequence}.tmp`,
  );
  try {
    await write(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await move(temporary, path);
  } catch (error) {
    await remove(temporary).catch(() => {});
    throw error;
  }
}

export async function ensureCruiseScratch(cwd, entries = ['LAST-RUN.json']) {
  const directory = join(cwd, '.cruise');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('.cruise must be a real directory');
  }
  const ignorePath = join(directory, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(ignorePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const expected = `${entries.join('\n')}\n`;
  if (existing !== expected) await atomicWriteText(ignorePath, expected);
  return directory;
}

export async function writeCruiseScratchJson(cwd, filename, value) {
  if (filename !== 'LAST-RUN.json') throw new TypeError('only LAST-RUN.json persists in .cruise');
  const directory = await ensureCruiseScratch(cwd, [filename]);
  await atomicWriteText(join(directory, filename), `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeSupervisorState(runtimeDirectory, state) {
  if (!validSupervisorState(state)) throw new TypeError('supervisor scratch state is malformed');
  await writeRuntimeJson(runtimeDirectory, SUPERVISOR_STATE_FILE, state);
}

export async function captureWorkspaceFingerprint(cwd, {
  excludeFlightPlan = false,
  paths = ['.'],
} = {}) {
  try {
    if (
      !Array.isArray(paths) ||
      paths.length === 0 ||
      paths.some((path) => typeof path !== 'string' || !path.trim() || path.startsWith('/') || path.split('/').includes('..'))
    ) {
      throw new TypeError('fingerprint paths must be non-empty repository-relative paths or globs');
    }
    const options = { cwd, encoding: 'utf8', maxBuffer: Infinity };
    const pathspec = [
      '--',
      ...paths,
      USER_ONLY_MARKDOWN_PATHSPEC,
      ...SENSITIVE_GIT_PATHSPECS,
      ...(excludeFlightPlan ? [':(exclude).cruise/**'] : []),
    ];
    const [head, status, diff, cached, untracked] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], options)
        .catch(() => ({ stdout: 'unborn\n' })),
      execFileAsync('git', ['status', '--porcelain=v1', ...pathspec], options),
      execFileAsync('git', ['diff', ...pathspec], options),
      execFileAsync('git', ['diff', '--cached', ...pathspec], options),
      execFileAsync(
        'git',
        [
          'ls-files',
          '--others',
          '--exclude-standard',
          '-z',
          ...pathspec,
        ],
        options,
      ),
    ]);
    const untrackedFiles = untracked.stdout.split('\u0000').filter(Boolean).sort();
    let untrackedBytes = 0;
    const untrackedEvidence = [];
    for (const path of untrackedFiles) {
      if (path.startsWith('/') || path.split('/').includes('..')) return null;
      if (isSensitivePath(path)) continue;
      const metadata = await lstat(join(cwd, path));
      if (metadata.isSymbolicLink()) {
        untrackedEvidence.push(`${path}\u0000symlink\u0000${await readlink(join(cwd, path))}`);
        continue;
      }
      if (!metadata.isFile()) {
        untrackedEvidence.push(`${path}\u0000non-regular`);
        continue;
      }
      untrackedBytes += metadata.size;
      if (untrackedBytes > 64 * 1024 * 1024) return null;
      untrackedEvidence.push(`${path}\u0000${digest(await readFile(join(cwd, path)))}`);
    }
    return digest([
      head.stdout.trim(),
      status.stdout,
      diff.stdout,
      cached.stdout,
      untrackedEvidence.join('\u0000'),
    ].join('\u0000'));
  } catch {
    return null;
  }
}

export function extractFailureSignature(turnText) {
  if (typeof turnText !== 'string') return null;
  const lines = turnText.split(/\r?\n/u).filter((line) => FAILURE_LINE.test(line));
  if (!lines.length) return null;
  const normalized = lines.map((line) => line
    .replace(/\b[A-Za-z]:\\(?:[^\\\r\n:]+\\)*[^:\r\n]+?(?=:\d+(?::\d+)?\b|$)/gu, '<path>')
    .replace(/\/(?:[^/\r\n:]+\/)*[^:\r\n]+?(?=:\d+(?::\d+)?\b|$)/gu, '<path>')
    .replace(/\b(?:0x[a-f\d]+|[a-f\d]{7,})\b/giu, '<hex>')
    .replace(/\d+/gu, '<n>')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase())
    .filter(Boolean);
  return normalized.length ? digest(normalized.join('\n')) : null;
}
