import { createHash } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWriteText, ensureCruiseScratch } from './supervisor.mjs';

export const USAGE_RATE_VERSION = '2026-08-20';
export const USAGE_RATE_TABLES = Object.freeze({
  [USAGE_RATE_VERSION]: Object.freeze({
    sol: Object.freeze({ input: 125, cached: 12.5, output: 750 }),
    terra: Object.freeze({ input: 50, cached: 5, output: 300 }),
    luna: Object.freeze({ input: 5, cached: 0.5, output: 30 }),
  }),
});

const TOKEN_FIELDS = Object.freeze([
  'inputTokens',
  'cachedInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
  'totalTokens',
]);
const USAGE_IGNORE_ENTRIES = Object.freeze([
  'LAST-RUN.json',
  'USAGE.json',
  'HANDOFF.md',
  'BUDGET-PAUSE.json',
  'artifacts/',
]);

function emptyBreakdown() {
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
}

function copyBreakdown(value) {
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, value[field]]));
}

function summaryBreakdown(value) {
  return {
    input_tokens: value.inputTokens,
    cached_input_tokens: value.cachedInputTokens,
    output_tokens: value.outputTokens,
    reasoning_output_tokens: value.reasoningOutputTokens,
    total_tokens: value.totalTokens,
  };
}

function validateBreakdown(value) {
  if (!value || typeof value !== 'object') return 'token breakdown is missing';
  for (const field of TOKEN_FIELDS) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      return `${field} must be a non-negative safe integer`;
    }
  }
  if (value.cachedInputTokens > value.inputTokens) {
    return 'cachedInputTokens exceeds inputTokens';
  }
  if (value.reasoningOutputTokens > value.outputTokens) {
    return 'reasoningOutputTokens exceeds outputTokens';
  }
  if (value.totalTokens !== value.inputTokens + value.outputTokens) {
    return 'totalTokens does not equal inputTokens + outputTokens';
  }
  return null;
}

export function usageModelFamily(model) {
  const normalized = String(model ?? '').toLowerCase();
  if (normalized.includes('sol')) return 'sol';
  if (normalized.includes('terra')) return 'terra';
  if (normalized.includes('luna')) return 'luna';
  return null;
}

export function estimateCredits(tokens, model, {
  rateVersion = USAGE_RATE_VERSION,
} = {}) {
  const family = usageModelFamily(model);
  const rates = USAGE_RATE_TABLES[rateVersion]?.[family];
  if (!rates) return null;
  const uncached = tokens.inputTokens - tokens.cachedInputTokens;
  return (
    uncached * rates.input +
    tokens.cachedInputTokens * rates.cached +
    tokens.outputTokens * rates.output
  ) / 1_000_000;
}

function newThreadState(model) {
  return {
    model: model ?? null,
    accountingKnown: true,
    reason: null,
    highWatermarks: emptyBreakdown(),
    last: null,
    modelContextWindow: null,
    latestTurnId: null,
    acceptedSnapshots: 0,
    invalidEvidence: [],
  };
}

function safeContextWindow(value) {
  return value === null || value === undefined
    ? null
    : Number.isSafeInteger(value) && value > 0
      ? value
      : null;
}

export class UsageMeter {
  constructor({ rateVersion = USAGE_RATE_VERSION, now = () => new Date() } = {}) {
    if (!USAGE_RATE_TABLES[rateVersion]) throw new TypeError(`unknown usage rate version: ${rateVersion}`);
    this.rateVersion = rateVersion;
    this.now = now;
    this.threads = new Map();
    this.pendingEvidence = [];
    this.compaction = { count: 0, attempts: 0, latest_outcome: null };
  }

  consume(params, { model = null } = {}) {
    const threadId = params?.threadId;
    const tokenUsage = params?.tokenUsage;
    if (typeof threadId !== 'string' || !threadId || !tokenUsage || typeof tokenUsage !== 'object') {
      throw new TypeError('thread/tokenUsage/updated requires threadId and tokenUsage');
    }
    const state = this.threads.get(threadId) ?? newThreadState(model);
    if (model) state.model = model;
    this.threads.set(threadId, state);

    const lastError = validateBreakdown(tokenUsage.last);
    const totalError = validateBreakdown(tokenUsage.total);
    if (!lastError) {
      state.last = copyBreakdown(tokenUsage.last);
      state.modelContextWindow = safeContextWindow(tokenUsage.modelContextWindow);
      state.latestTurnId = typeof params.turnId === 'string' ? params.turnId : null;
    }
    if (lastError || totalError) {
      const reason = [lastError, totalError].filter(Boolean).join('; ');
      state.accountingKnown = false;
      state.reason = reason;
      const raw = JSON.stringify(params, null, 2);
      const digest = createHash('sha256').update(raw).digest('hex');
      const evidence = { digest, raw, path: `.cruise/artifacts/usage-invalid-${digest}.json` };
      if (!state.invalidEvidence.some((item) => item.digest === digest)) {
        state.invalidEvidence.push({ digest, path: evidence.path });
        this.pendingEvidence.push(evidence);
      }
      return { accepted: false, accountingKnown: false, reason, delta: emptyBreakdown() };
    }

    const prior = state.highWatermarks;
    const next = emptyBreakdown();
    const delta = emptyBreakdown();
    for (const field of TOKEN_FIELDS) {
      next[field] = Math.max(prior[field], tokenUsage.total[field]);
      delta[field] = next[field] - prior[field];
    }
    state.highWatermarks = next;
    state.last = copyBreakdown(tokenUsage.last);
    state.modelContextWindow = safeContextWindow(tokenUsage.modelContextWindow);
    state.latestTurnId = typeof params.turnId === 'string' ? params.turnId : null;
    const accepted = TOKEN_FIELDS.some((field) => delta[field] > 0);
    if (accepted) state.acceptedSnapshots += 1;
    return { accepted, accountingKnown: state.accountingKnown, delta };
  }

  thread(threadId) {
    const state = this.threads.get(threadId);
    if (!state) return null;
    const pressure = state.last && state.modelContextWindow
      ? state.last.inputTokens / state.modelContextWindow
      : null;
    return {
      model: state.model,
      accountingKnown: state.accountingKnown,
      highWatermarks: { ...state.highWatermarks },
      last: state.last ? { ...state.last } : null,
      modelContextWindow: state.modelContextWindow,
      pressure,
      acceptedSnapshots: state.acceptedSnapshots,
      latestTurnId: state.latestTurnId,
    };
  }

  setCompaction(summary) {
    this.compaction = {
      count: summary?.count ?? 0,
      attempts: summary?.attempts ?? 0,
      latest_outcome: summary?.latest_outcome ?? null,
    };
  }

  summary() {
    const threads = {};
    const totals = emptyBreakdown();
    let accountingKnown = true;
    let estimatedCreditsTotal = 0;
    let creditEstimateKnown = true;
    for (const [threadId, state] of [...this.threads.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      for (const field of TOKEN_FIELDS) totals[field] += state.highWatermarks[field];
      const estimate = estimateCredits(state.highWatermarks, state.model, { rateVersion: this.rateVersion });
      if (estimate === null || !state.accountingKnown) creditEstimateKnown = false;
      else estimatedCreditsTotal += estimate;
      accountingKnown &&= state.accountingKnown;
      threads[threadId] = {
        model: state.model,
        accounting_known: state.accountingKnown,
        ...(state.reason ? { accounting_error: state.reason } : {}),
        high_watermarks: summaryBreakdown(state.highWatermarks),
        last: state.last ? summaryBreakdown(state.last) : null,
        model_context_window: state.modelContextWindow,
        context_pressure: state.last && state.modelContextWindow
          ? state.last.inputTokens / state.modelContextWindow
          : null,
        accepted_snapshots: state.acceptedSnapshots,
        estimated_credits: estimate === null || !state.accountingKnown ? null : estimate,
        invalid_evidence: state.invalidEvidence.map((item) => ({ ...item })),
      };
    }
    return {
      schema_version: 1,
      rate_version: this.rateVersion,
      updated_at: new Date(this.now()).toISOString(),
      accounting_known: accountingKnown,
      observed_threads: Object.keys(threads).length,
      totals: summaryBreakdown(totals),
      estimated_credits: creditEstimateKnown ? estimatedCreditsTotal : null,
      compaction: { ...this.compaction },
      threads,
    };
  }

  async persist(cwd) {
    const directory = await ensureCruiseScratch(cwd, USAGE_IGNORE_ENTRIES);
    if (this.pendingEvidence.length) {
      const artifacts = join(directory, 'artifacts');
      await mkdir(artifacts, { mode: 0o700 }).catch((error) => {
        if (error?.code !== 'EEXIST') throw error;
      });
      const metadata = await lstat(artifacts);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error('.cruise/artifacts must be a real directory');
      }
      for (const evidence of this.pendingEvidence.splice(0)) {
        await atomicWriteText(join(cwd, evidence.path), `${evidence.raw}\n`);
      }
    }
    await atomicWriteText(join(directory, 'USAGE.json'), `${JSON.stringify(this.summary(), null, 2)}\n`);
  }
}
