import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { atomicWriteText, ensureCruiseScratch } from './supervisor.mjs';
import { ACCOUNT_ROUTING_GUIDANCE, classifyWorkerFailure } from './simple-worker.mjs';

export const DEFAULT_WEEKLY_DELTA_CAP_PERCENT = 9.0;
export const DEFAULT_GOAL_RESERVATION_PERCENT = 2.25;
export const DEFAULT_BUDGET_SAFETY_MARGIN_PERCENT = 1.0;
export const BUDGET_PAUSE_EXIT_CODE = 6;
const WEEKLY_WINDOW_MINUTES = 10_080;
const BUDGET_IGNORE_ENTRIES = Object.freeze([
  'LAST-RUN.json',
  'USAGE.json',
  'HANDOFF.md',
  'BUDGET-PAUSE.json',
  'artifacts/',
]);

function parsePercent(value, fallback, name) {
  const resolved = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(resolved) || resolved <= 0 || resolved > 100) {
    throw new TypeError(`${name} must be greater than 0 and at most 100`);
  }
  return resolved;
}

function parseStrict(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (/^(?:1|true|yes|on)$/iu.test(String(value))) return true;
  if (/^(?:0|false|no|off)$/iu.test(String(value))) return false;
  throw new TypeError('strict budget must be true or false');
}

export function resolveBudgetOptions({
  weeklyDeltaCap,
  goalReservation,
  strictBudget,
  env = process.env,
} = {}) {
  const campaignCap = parsePercent(
    weeklyDeltaCap ?? env?.CRUISE_WEEKLY_DELTA_CAP_PERCENT,
    DEFAULT_WEEKLY_DELTA_CAP_PERCENT,
    'weekly delta cap',
  );
  const reservation = parsePercent(
    goalReservation ?? env?.CRUISE_GOAL_RESERVATION_PERCENT,
    DEFAULT_GOAL_RESERVATION_PERCENT,
    'Goal reservation',
  );
  if (reservation > campaignCap) throw new TypeError('Goal reservation cannot exceed the weekly delta cap');
  return {
    weeklyDeltaCap: campaignCap,
    goalReservation: reservation,
    strictBudget: parseStrict(strictBudget ?? env?.CRUISE_STRICT_BUDGET),
  };
}

export function deriveAccountHash(accountResponse) {
  const account = accountResponse?.account;
  if (!account || typeof account.type !== 'string') throw new Error('account/read returned no account identity');
  const identity = account.type === 'chatgpt'
    ? ['chatgpt', String(account.email ?? '').trim().toLowerCase(), account.planType ?? null]
    : [account.type];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function validWindow(window) {
  return Boolean(
    window &&
    Number.isFinite(window.usedPercent) &&
    window.usedPercent >= 0 &&
    window.usedPercent <= 100 &&
    Number.isSafeInteger(window.windowDurationMins) &&
    window.windowDurationMins > 0 &&
    Number.isSafeInteger(window.resetsAt) &&
    window.resetsAt >= 0
  );
}

export function selectWeeklyWindow(rateLimitSnapshot) {
  const candidates = ['primary', 'secondary']
    .map((name) => ({ name, ...(rateLimitSnapshot?.[name] ?? {}) }))
    .filter(validWindow)
    .sort((left, right) => {
      const distance = Math.abs(left.windowDurationMins - WEEKLY_WINDOW_MINUTES) -
        Math.abs(right.windowDurationMins - WEEKLY_WINDOW_MINUTES);
      return distance || right.windowDurationMins - left.windowDurationMins;
    });
  return candidates[0] ?? null;
}

function mergeDefined(previous, update) {
  if (!update || typeof update !== 'object') return previous ?? null;
  const merged = { ...(previous ?? {}) };
  for (const [key, value] of Object.entries(update)) {
    if (value === null || value === undefined) continue;
    if (['primary', 'secondary'].includes(key) && typeof value === 'object') {
      merged[key] = mergeDefined(previous?.[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

export function mergeSparseRateLimits(previous, notification) {
  return mergeDefined(previous, notification?.rateLimits);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`unsafe quota directory: ${path}`);
  }
}

async function atomicWriteJson(path, value) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function readLedger(path) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('unsafe quota ledger');
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (
      value?.schema_version !== 1 ||
      typeof value.account_hash !== 'string' ||
      !Number.isSafeInteger(value.reset_epoch) ||
      !value.baseline ||
      !Array.isArray(value.reservations) ||
      !value.high_watermarks ||
      typeof value.high_watermarks !== 'object'
    ) {
      throw new Error('quota ledger is malformed');
    }
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export class BudgetPauseError extends Error {
  constructor(message, report) {
    super(message);
    this.name = 'BudgetPauseError';
    this.code = 'CRUISE_BUDGET_PAUSE';
    this.exitCode = BUDGET_PAUSE_EXIT_CODE;
    this.report = report;
  }
}

export class QuotaGuard {
  constructor({
    cwd,
    weeklyDeltaCap = DEFAULT_WEEKLY_DELTA_CAP_PERCENT,
    goalReservation = DEFAULT_GOAL_RESERVATION_PERCENT,
    strictBudget = false,
    safetyMargin = DEFAULT_BUDGET_SAFETY_MARGIN_PERCENT,
    baseDirectory = join(homedir(), '.cruise', 'quota'),
    budgetPolicyPath = join(baseDirectory, '..', 'budget-policy.json'),
    pid = process.pid,
    host = hostname(),
    now = () => new Date(),
    isProcessAlive = processIsAlive,
    staleReservationMs = 15 * 60 * 1_000,
    lockTimeoutMs = 5_000,
    resumeCommand = 'cruise goal --strict-budget <request>',
  } = {}) {
    if (!cwd) throw new TypeError('quota guard cwd is required');
    this.cwd = cwd;
    this.weeklyDeltaCap = parsePercent(weeklyDeltaCap, DEFAULT_WEEKLY_DELTA_CAP_PERCENT, 'weekly delta cap');
    this.goalReservation = parsePercent(goalReservation, DEFAULT_GOAL_RESERVATION_PERCENT, 'Goal reservation');
    if (this.goalReservation > this.weeklyDeltaCap) throw new TypeError('Goal reservation cannot exceed cap');
    this.strictBudget = parseStrict(strictBudget);
    this.safetyMargin = parsePercent(safetyMargin, DEFAULT_BUDGET_SAFETY_MARGIN_PERCENT, 'budget safety margin');
    this.baseDirectory = baseDirectory;
    this.budgetPolicyPath = budgetPolicyPath;
    this.budgetPolicyPromise = null;
    this.pid = pid;
    this.host = host;
    this.now = now;
    this.isProcessAlive = isProcessAlive;
    this.staleReservationMs = staleReservationMs;
    this.lockTimeoutMs = lockTimeoutMs;
    this.resumeCommand = resumeCommand;
    this.accountHash = null;
    this.snapshot = null;
    this.reservationId = null;
    this.client = null;
    this.pendingNotification = Promise.resolve();
    this.onNotification = (message) => {
      if (message?.method !== 'account/rateLimits/updated') return;
      this.snapshot = mergeSparseRateLimits(this.snapshot, message.params);
    };
  }

  async campaignBudgetEnabled() {
    if (!this.budgetPolicyPromise) {
      this.budgetPolicyPromise = readFile(this.budgetPolicyPath, 'utf8').then((text) => {
        const policy = JSON.parse(text);
        if (policy?.schema_version !== 1 || typeof policy.campaign_budget_enabled !== 'boolean') {
          throw new TypeError('budget policy requires schema_version 1 and boolean campaign_budget_enabled');
        }
        return policy.campaign_budget_enabled;
      }).catch((error) => {
        if (error?.code === 'ENOENT') return true;
        throw error;
      });
    }
    return this.budgetPolicyPromise;
  }

  disabledBudgetState() {
    return { metered: false, campaignBudgetEnabled: false, reason: 'Cruise campaign budget disabled by explicit user policy; provider limits still apply' };
  }

  ledgerPath() {
    if (!this.accountHash) throw new Error('quota account identity is unavailable');
    return join(this.baseDirectory, `${this.accountHash}.json`);
  }

  async withLock(callback) {
    await ensurePrivateDirectory(this.baseDirectory);
    const lockPath = join(this.baseDirectory, `${this.accountHash}.lock`);
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        await atomicWriteJson(join(lockPath, 'owner.json'), {
          pid: this.pid,
          host: this.host,
          created_at: new Date(this.now()).toISOString(),
        });
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        await this.cleanupStaleLock(lockPath);
        if (Date.now() >= deadline) throw new Error('quota ledger lock timed out');
        await delay(25);
      }
    }
    try {
      return await callback();
    } finally {
      const metadata = await lstat(lockPath).catch(() => null);
      if (metadata?.isDirectory() && !metadata.isSymbolicLink()) {
        await rm(lockPath, { recursive: true, force: true });
      }
    }
  }

  async cleanupStaleLock(lockPath) {
    const metadata = await stat(lockPath).catch(() => null);
    if (!metadata || Date.now() - metadata.mtimeMs < this.staleReservationMs) return;
    let owner;
    try {
      owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8'));
    } catch {
      return;
    }
    if (owner.host !== this.host || this.isProcessAlive(owner.pid)) return;
    const tombstone = `${lockPath}.stale.${this.pid}.${randomUUID()}`;
    await rename(lockPath, tombstone).catch(() => {});
    const tombstoneMetadata = await lstat(tombstone).catch(() => null);
    if (tombstoneMetadata?.isDirectory() && !tombstoneMetadata.isSymbolicLink()) {
      await rm(tombstone, { recursive: true, force: true });
    }
  }

  cleanStaleReservations(ledger) {
    const cutoff = new Date(this.now()).getTime() - this.staleReservationMs;
    for (const reservation of ledger.reservations) {
      if (reservation.status !== 'active' || reservation.pid === this.pid) continue;
      const created = Date.parse(reservation.created_at);
      if (Number.isFinite(created) && created <= cutoff && !this.isProcessAlive(reservation.pid)) {
        reservation.status = 'stale';
      }
    }
  }

  ledgerForWindow(existing, window) {
    if (!existing || existing.account_hash !== this.accountHash || existing.reset_epoch !== window.resetsAt) {
      return {
        schema_version: 1,
        account_hash: this.accountHash,
        reset_epoch: window.resetsAt,
        baseline: {
          used_percent: window.usedPercent,
          window_duration_mins: window.windowDurationMins,
          resets_at: window.resetsAt,
        },
        high_watermarks: {},
        reservations: [],
      };
    }
    return existing;
  }

  budgetState(ledger, window) {
    const observedDelta = Math.max(window.usedPercent - ledger.baseline.used_percent, 0);
    const activeReservations = ledger.reservations
      .filter((reservation) => reservation.status === 'active')
      .reduce((total, reservation) => total + reservation.reserved_percent, 0);
    return {
      metered: true,
      usedPercent: window.usedPercent,
      baselineUsedPercent: ledger.baseline.used_percent,
      observedDelta,
      activeReservations,
      weeklyDeltaCap: this.weeklyDeltaCap,
      safetyMargin: this.safetyMargin,
      resetsAt: window.resetsAt,
      windowDurationMins: window.windowDurationMins,
      remaining: Math.max(this.weeklyDeltaCap - this.safetyMargin - observedDelta - activeReservations, 0),
    };
  }

  async readAuthority(client) {
    const [account, rateLimits] = await Promise.all([
      client.request('account/read', { refreshToken: false }),
      client.request('account/rateLimits/read'),
    ]);
    this.accountHash = deriveAccountHash(account);
    this.snapshot = rateLimits?.rateLimits ?? null;
    return selectWeeklyWindow(this.snapshot);
  }

  async pause(reason, state = {}) {
    const report = {
      schema_version: 1,
      status: 'budget-paused',
      reason,
      created_at: new Date(this.now()).toISOString(),
      reset_at: state.resetsAt ?? null,
      observed_delta_percent: state.observedDelta ?? null,
      active_reservations_percent: state.activeReservations ?? null,
      weekly_delta_cap_percent: this.weeklyDeltaCap,
      goal_reservation_percent: this.goalReservation,
      resume_command: this.resumeCommand,
    };
    const directory = await ensureCruiseScratch(this.cwd, BUDGET_IGNORE_ENTRIES);
    await atomicWriteText(join(directory, 'BUDGET-PAUSE.json'), `${JSON.stringify(report, null, 2)}\n`);
    throw new BudgetPauseError(reason, report);
  }

  async start({ client, goalId = randomUUID(), reservationPercent = this.goalReservation } = {}) {
    this.client = client;
    if (!await this.campaignBudgetEnabled()) return this.disabledBudgetState();
    client.on?.('notification', this.onNotification);
    let window;
    try {
      window = await this.readAuthority(client);
    } catch (error) {
      if (this.strictBudget) {
        const guidance = classifyWorkerFailure(error).category === 'account-routing'
          ? ` (account-routing). ${ACCOUNT_ROUTING_GUIDANCE}` : '';
        await this.pause(`weekly quota authority unavailable: ${error.message}${guidance}`);
      }
      return { metered: false, reason: String(error?.message ?? error) };
    }
    if (!window) {
      if (this.strictBudget) await this.pause('weekly rate-limit window is unavailable');
      return { metered: false, reason: 'weekly rate-limit window is unavailable' };
    }
    const reservationId = randomUUID();
    let refused = null;
    const state = await this.withLock(async () => {
      let ledger = this.ledgerForWindow(await readLedger(this.ledgerPath()), window);
      this.cleanStaleReservations(ledger);
      const before = this.budgetState(ledger, window);
      if (before.observedDelta + before.activeReservations + reservationPercent + this.safetyMargin > this.weeklyDeltaCap) {
        refused = before;
        return before;
      }
      ledger.reservations.push({
        id: reservationId,
        pid: this.pid,
        goal_id: goalId,
        reserved_percent: reservationPercent,
        created_at: new Date(this.now()).toISOString(),
        status: 'active',
      });
      await atomicWriteJson(this.ledgerPath(), ledger);
      return this.budgetState(ledger, window);
    });
    if (refused) await this.pause('weekly quota reservation would cross the campaign cap', refused);
    this.reservationId = reservationId;
    return state;
  }

  async check() {
    if (!await this.campaignBudgetEnabled()) return this.disabledBudgetState();
    await this.pendingNotification;
    let response;
    try {
      response = await this.client.request('account/rateLimits/read');
      this.snapshot = response?.rateLimits ?? this.snapshot;
    } catch (error) {
      if (this.strictBudget) await this.pause(`weekly quota refresh failed: ${error.message}`);
    }
    const window = selectWeeklyWindow(this.snapshot);
    if (!window) {
      if (this.strictBudget) await this.pause('weekly rate-limit window is unavailable');
      return { metered: false };
    }
    let exceeded = null;
    const state = await this.withLock(async () => {
      const ledger = this.ledgerForWindow(await readLedger(this.ledgerPath()), window);
      this.cleanStaleReservations(ledger);
      await atomicWriteJson(this.ledgerPath(), ledger);
      const current = this.budgetState(ledger, window);
      if (current.observedDelta + current.activeReservations + this.safetyMargin > this.weeklyDeltaCap) {
        exceeded = current;
      }
      return current;
    });
    if (exceeded) await this.pause('weekly quota guard reached the campaign cap', exceeded);
    return state;
  }

  async status(client) {
    if (!await this.campaignBudgetEnabled()) return this.disabledBudgetState();
    let window;
    try {
      window = await this.readAuthority(client);
    } catch (error) {
      if (this.strictBudget) await this.pause(`weekly quota authority unavailable: ${error.message}`);
      return { metered: false, reason: String(error?.message ?? error) };
    }
    if (!window) {
      if (this.strictBudget) await this.pause('weekly rate-limit window is unavailable');
      return { metered: false, reason: 'weekly rate-limit window is unavailable' };
    }
    return this.withLock(async () => {
      const ledger = this.ledgerForWindow(await readLedger(this.ledgerPath()), window);
      this.cleanStaleReservations(ledger);
      await atomicWriteJson(this.ledgerPath(), ledger);
      return this.budgetState(ledger, window);
    });
  }

  async release() {
    this.client?.off?.('notification', this.onNotification);
    if (!this.reservationId || !this.accountHash) return;
    await this.withLock(async () => {
      const ledger = await readLedger(this.ledgerPath());
      if (!ledger) return;
      const reservation = ledger.reservations.find((item) => item.id === this.reservationId);
      if (reservation?.status === 'active') reservation.status = 'released';
      await atomicWriteJson(this.ledgerPath(), ledger);
    });
    this.reservationId = null;
  }
}
