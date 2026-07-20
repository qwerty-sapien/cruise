import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import { DEFAULT_STALL } from './flight-plan.mjs';

const execFileAsync = promisify(execFile);
const FAILURE_LINE = /\b(?:error|fail(?:ed|ure)?|exception|panic|traceback)\b/iu;

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

export class GoalSupervisor {
  constructor({ stall = DEFAULT_STALL } = {}) {
    this.stall = null;
    this.updateStall(stall);
    this.turnsObserved = 0;
    this.quietTurns = 0;
    this.sameFailure = 0;
    this.previousFingerprint = null;
    this.previousFailure = null;
    this.seenFingerprints = new Set();
    this.seenFailures = new Set();
    this.stage = 'observing';
    this.interventions = [];
  }

  updateStall(stall = DEFAULT_STALL) {
    this.stall = Object.freeze({
      quietTurns: assertThreshold(stall?.quietTurns, 'stall.quietTurns'),
      sameFailure: assertThreshold(stall?.sameFailure, 'stall.sameFailure'),
    });
  }

  recordTurn({ fingerprint = null, failureSignature = null } = {}) {
    if (fingerprint !== null && typeof fingerprint !== 'string') throw new TypeError('fingerprint must be a string or null');
    if (failureSignature !== null && typeof failureSignature !== 'string') throw new TypeError('failureSignature must be a string or null');
    this.turnsObserved += 1;
    const priorFailure = this.previousFailure;

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
      this.seenFingerprints.add(fingerprint);
    }

    if (failureSignature === null) {
      this.sameFailure = 0;
      this.previousFailure = null;
    } else {
      this.sameFailure = failureSignature === this.previousFailure ? this.sameFailure + 1 : 1;
      this.previousFailure = failureSignature;
      this.seenFailures.add(failureSignature);
    }

    if (progress) {
      this.quietTurns = 0;
      this.sameFailure = 0;
      this.stage = 'observing';
      this.interventions = [];
      return { level: 'ok', reason: workspaceObservation };
    }

    if (
      fingerprint === null &&
      priorFailure !== null &&
      failureSignature !== priorFailure
    ) {
      this.quietTurns = 0;
      this.stage = 'observing';
      this.interventions = [];
      return {
        level: 'ok',
        reason: failureSignature === null
          ? `failure signature ${short(priorFailure)} cleared in the signature-only supervision path`
          : `failure evidence changed from signature ${short(priorFailure)} to ${short(failureSignature)} in the signature-only supervision path`,
      };
    }

    const reason = this.#reason(workspaceObservation, failureSignature);
    if (this.stage === 'realigned') {
      this.stage = 'final';
      this.interventions.push({ level: 'final-experiment', reason });
      return { level: 'final-experiment', reason };
    }
    if (this.stage === 'final' || this.stage === 'stalled') {
      this.stage = 'stalled';
      return { level: 'stall', reason };
    }
    if (
      this.quietTurns >= this.stall.quietTurns ||
      this.sameFailure >= this.stall.sameFailure
    ) {
      this.stage = 'realigned';
      this.interventions.push({ level: 'realign', reason });
      return { level: 'realign', reason };
    }
    return { level: 'ok', reason };
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
}

export async function captureWorkspaceFingerprint(cwd) {
  try {
    const options = { cwd, encoding: 'utf8', maxBuffer: Infinity };
    const [status, diff, cached] = await Promise.all([
      execFileAsync('git', ['status', '--porcelain=v1'], options),
      execFileAsync('git', ['diff'], options),
      execFileAsync('git', ['diff', '--cached'], options),
    ]);
    return digest(`${status.stdout}\u0000${diff.stdout}\u0000${cached.stdout}`);
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
