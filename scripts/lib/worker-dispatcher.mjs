import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  buildContextCapsule,
  parseWorkerHandoff,
  WORKER_HANDOFF_SCHEMA_INSTRUCTIONS,
  writeContextCapsule,
  writeRootHandoff,
} from './context-capsule.mjs';
import { routeWorkerTask } from './worker-policy.mjs';

export const DEFAULT_MAX_ACTIVE_WORKERS = 3;

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/** Cross-process lease ledger for the production managed-worker CLI path. */
export class WorkerDispatchLedger {
  constructor({
    cwd,
    baseDirectory = null,
    maxActive = DEFAULT_MAX_ACTIVE_WORKERS,
    pid = process.pid,
    now = () => Date.now(),
    alive = processAlive,
  } = {}) {
    if (typeof cwd !== 'string' || !cwd) throw new TypeError('dispatch ledger cwd is required');
    if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 3) {
      throw new TypeError('dispatch ledger maxActive must be an integer from 1 through 3');
    }
    this.cwd = resolve(cwd);
    this.baseDirectory = baseDirectory ?? join(this.cwd, '.cruise', 'runtime', 'worker-dispatch');
    this.maxActive = maxActive;
    this.pid = pid;
    this.now = now;
    this.alive = alive;
    const workspace = hash(this.cwd).slice(0, 32);
    this.ledgerPath = join(this.baseDirectory, `${workspace}.json`);
    this.lockPath = join(this.baseDirectory, `${workspace}.lock`);
  }

  async acquireLock() {
    await mkdir(this.baseDirectory, { recursive: true });
    const deadline = this.now() + 2_000;
    while (true) {
      try {
        await mkdir(this.lockPath);
        await writeFile(join(this.lockPath, 'owner.json'), `${JSON.stringify({ pid: this.pid, acquired_at: this.now() })}\n`, 'utf8');
        return;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const metadata = await stat(this.lockPath).catch(() => null);
        if (metadata && this.now() - metadata.mtimeMs > 5_000) {
          const owner = await readFile(join(this.lockPath, 'owner.json'), 'utf8')
            .then(JSON.parse)
            .catch(() => null);
          if (!owner || !this.alive(owner.pid)) {
            await rm(this.lockPath, { recursive: true, force: true });
            continue;
          }
        }
        if (this.now() >= deadline) throw new Error('timed out acquiring the worker dispatch ledger lock');
        await delay(10);
      }
    }
  }

  async withLock(action) {
    await this.acquireLock();
    try {
      let ledger;
      try {
        ledger = JSON.parse(await readFile(this.ledgerPath, 'utf8'));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        ledger = { version: 1, active: [], probe_keys: [], wave_probe_keys: [], wave_evidence_digest: null };
      }
      ledger.active = (ledger.active ?? []).filter((entry) => this.alive(entry.pid));
      const result = await action(ledger);
      const temporary = `${this.ledgerPath}.${this.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(ledger)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.ledgerPath);
      return result;
    } finally {
      await rm(this.lockPath, { recursive: true, force: true });
    }
  }

  async reserve({ debugProbeKey = null, expansionEvidence = null } = {}) {
    const probe = debugProbeKey == null ? null : nonEmpty(debugProbeKey, 'debug probe key').toLowerCase();
    const evidence = expansionEvidence == null ? null : nonEmpty(expansionEvidence, 'debug expansion evidence');
    const id = randomUUID();
    await this.withLock((ledger) => {
      if (ledger.active.length >= this.maxActive) {
        const error = new Error(`maximum ${this.maxActive} active managed workers reached`);
        error.code = 'CRUISE_WORKER_CAPACITY';
        throw error;
      }
      if (probe) {
        if ((ledger.probe_keys ?? []).includes(probe) || ledger.active.some((entry) => entry.debug_probe_key === probe)) {
          const error = new Error(`debug probe ${probe} is a duplicate`);
          error.code = 'CRUISE_DEBUG_PROBE_DUPLICATE';
          throw error;
        }
        let wave = ledger.wave_probe_keys ?? [];
        if (evidence) {
          const evidenceDigest = hash(evidence);
          if (evidenceDigest !== ledger.wave_evidence_digest) {
            ledger.wave_evidence_digest = evidenceDigest;
            ledger.wave_probe_keys = [];
          }
          wave = ledger.wave_probe_keys;
        } else if (wave.length >= 3) {
          throw new Error('another debug wave requires confirmed discriminating evidence');
        }
        if (wave.length >= 3) throw new Error('a debug wave may contain at most 3 probes');
        ledger.wave_probe_keys.push(probe);
        ledger.probe_keys = [...(ledger.probe_keys ?? []), probe].slice(-200);
      }
      ledger.active.push({ id, pid: this.pid, started_at: this.now(), debug_probe_key: probe });
    });
    let released = false;
    return Object.freeze({
      id,
      release: async () => {
        if (released) return;
        await this.withLock((ledger) => {
          ledger.active = ledger.active.filter((entry) => entry.id !== id);
        });
        released = true;
      },
    });
  }
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  return value.trim();
}

function probeKey(probe) {
  return String(probe.id ?? probe.hypothesis ?? probe.task ?? '').trim().toLowerCase();
}

export class ManagedWorkerDispatcher {
  constructor({
    cwd,
    runWorker,
    reserveWorker = null,
    maxActive = DEFAULT_MAX_ACTIVE_WORKERS,
    capsuleWriter = writeContextCapsule,
    handoffWriter = writeRootHandoff,
  } = {}) {
    if (typeof cwd !== 'string' || !cwd) throw new TypeError('dispatcher cwd is required');
    if (typeof runWorker !== 'function') throw new TypeError('dispatcher runWorker is required');
    if (reserveWorker !== null && typeof reserveWorker !== 'function') throw new TypeError('dispatcher reserveWorker must be a function or null');
    if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 3) {
      throw new TypeError('maxActive must be an integer from 1 through 3');
    }
    this.cwd = cwd;
    this.runWorker = runWorker;
    this.reserveWorker = reserveWorker ?? ((request) => new WorkerDispatchLedger({ cwd }).reserve(request));
    this.maxActive = maxActive;
    this.capsuleWriter = capsuleWriter;
    this.handoffWriter = handoffWriter;
    this.active = 0;
    this.waiters = [];
    this.debugProbeKeys = new Set();
  }

  async acquire() {
    if (this.active < this.maxActive) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
  }

  releaseSlot() {
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }

  async dispatch({
    task,
    complexity = 'bounded',
    consequences = [],
    exceptionalConsequence = null,
    capsule = {},
    readOnly = false,
    timeoutMs = null,
  } = {}) {
    const narrowTask = nonEmpty(task, 'dispatch task');
    const route = routeWorkerTask({
      task: narrowTask,
      complexity,
      consequences,
      exceptionalConsequence,
    });
    const built = buildContextCapsule({ ...capsule, task: narrowTask });
    const capsulePath = await this.capsuleWriter(this.cwd, built);
    await this.acquire();
    let reservation = null;
    try {
      reservation = await this.reserveWorker({
        task: narrowTask,
        level: route.recommended_level,
        capsuleDigest: built.digest,
      });
      if (!reservation || typeof reservation.release !== 'function') {
        throw new TypeError('worker reservation must provide release()');
      }
      const result = await this.runWorker({
        cwd: this.cwd,
        task: `${built.serialized}\n${WORKER_HANDOFF_SCHEMA_INSTRUCTIONS}`,
        level: route.recommended_level,
        readOnly,
        timeoutMs,
        exceptionalConsequence: route.exceptional_consequence,
      });
      const handoff = parseWorkerHandoff(result.output);
      const persisted = await this.handoffWriter(this.cwd, handoff);
      return Object.freeze({
        route,
        capsule_path: capsulePath,
        capsule_digest: built.digest,
        handoff,
        handoff_path: persisted.path,
        thread_id: result.threadId ?? null,
        turn_id: result.turnId ?? null,
      });
    } finally {
      try {
        await Promise.resolve().then(() => reservation?.release());
      } finally {
        this.releaseSlot();
      }
    }
  }

  async dispatchDebugProbes(probes, { expansionEvidence = null } = {}) {
    if (!Array.isArray(probes)) throw new TypeError('debug probes must be an array');
    if (expansionEvidence != null && (typeof expansionEvidence !== 'string' || !expansionEvidence.trim())) {
      throw new TypeError('expansionEvidence must be null or a non-empty string');
    }
    const distinct = [];
    for (const probe of probes) {
      const key = probeKey(probe);
      if (!key || this.debugProbeKeys.has(key) || distinct.some((entry) => entry.key === key)) continue;
      distinct.push({ key, probe });
    }
    if (this.debugProbeKeys.size > 0 && distinct.length > 0 && !expansionEvidence) {
      throw new Error('another debug wave requires confirmed discriminating evidence');
    }
    const wave = distinct.slice(0, 3);
    for (const { key } of wave) this.debugProbeKeys.add(key);
    return Promise.all(wave.map(({ probe }) => this.dispatch({
      ...probe,
      readOnly: probe.readOnly ?? true,
    })));
  }
}
