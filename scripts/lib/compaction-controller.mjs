export const DEFAULT_CONTEXT_THRESHOLDS = Object.freeze({
  warnRatio: 0.30,
  compactRatio: 0.45,
  splitRatio: 0.60,
  minimumRootTurns: 4,
  absoluteInputTokens: 96_000,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function finiteRatio(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
    throw new TypeError(`${name} must be between 0 and 1`);
  }
  return resolved;
}

export function contextPressureLevel(pressure, thresholds = DEFAULT_CONTEXT_THRESHOLDS) {
  if (!Number.isFinite(pressure)) return 'unknown';
  if (pressure >= thresholds.splitRatio) return 'split';
  if (pressure >= thresholds.compactRatio) return 'compact';
  if (pressure >= thresholds.warnRatio) return 'warn';
  return 'normal';
}

export class CompactionController {
  constructor({
    client,
    usageMeter,
    refreshHandoff,
    persist = async () => {},
    warnRatio,
    compactRatio,
    splitRatio,
    minimumRootTurns = DEFAULT_CONTEXT_THRESHOLDS.minimumRootTurns,
    absoluteInputTokens = DEFAULT_CONTEXT_THRESHOLDS.absoluteInputTokens,
    lifecycleTimeoutMs = 60_000,
    now = () => new Date(),
  } = {}) {
    if (!client || !usageMeter || typeof refreshHandoff !== 'function') {
      throw new TypeError('client, usageMeter, and refreshHandoff are required');
    }
    this.client = client;
    this.usageMeter = usageMeter;
    this.refreshHandoff = refreshHandoff;
    this.persist = persist;
    this.thresholds = Object.freeze({
      warnRatio: finiteRatio(warnRatio, DEFAULT_CONTEXT_THRESHOLDS.warnRatio, 'warn ratio'),
      compactRatio: finiteRatio(compactRatio, DEFAULT_CONTEXT_THRESHOLDS.compactRatio, 'compact ratio'),
      splitRatio: finiteRatio(splitRatio, DEFAULT_CONTEXT_THRESHOLDS.splitRatio, 'split ratio'),
      minimumRootTurns,
      absoluteInputTokens,
    });
    if (!Number.isInteger(minimumRootTurns) || minimumRootTurns < 0) {
      throw new TypeError('minimum root turns must be a non-negative integer');
    }
    if (!Number.isSafeInteger(absoluteInputTokens) || absoluteInputTokens <= 0) {
      throw new TypeError('absolute input trigger must be a positive safe integer');
    }
    this.lifecycleTimeoutMs = lifecycleTimeoutMs;
    this.now = now;
    this.count = 0;
    this.attempts = 0;
    this.turnsSinceCompaction = Number.POSITIVE_INFINITY;
    this.lastCompactionSequence = -1;
    this.pendingVerification = null;
    this.latestOutcome = null;
    this.currentLifecycle = null;
    this.splitRequired = false;
  }

  observeUsage(threadId) {
    const usage = this.usageMeter.thread(threadId);
    if (!usage || !this.pendingVerification) return;
    if (usage.acceptedSnapshots <= this.pendingVerification.afterSequence) return;
    const pressureAfter = usage.pressure;
    const fell = Number.isFinite(pressureAfter) && pressureAfter < this.pendingVerification.pressureBefore;
    this.latestOutcome = {
      status: fell ? 'verified' : 'ineffective',
      at: new Date(this.now()).toISOString(),
      pressure_before: this.pendingVerification.pressureBefore,
      pressure_after: pressureAfter,
    };
    this.splitRequired = Number.isFinite(pressureAfter) && pressureAfter >= this.thresholds.splitRatio;
    this.pendingVerification = null;
  }

  handleNotification(message) {
    const lifecycle = this.currentLifecycle;
    if (!lifecycle || !['item/started', 'item/completed'].includes(message?.method)) return false;
    const params = message.params ?? {};
    if (params.threadId !== lifecycle.threadId || params.item?.type !== 'contextCompaction') return false;
    if (message.method === 'item/started') {
      lifecycle.itemId = params.item.id;
      lifecycle.started = true;
      return true;
    }
    if (!lifecycle.started || params.item.id !== lifecycle.itemId) {
      lifecycle.completion.reject(new Error('context compaction completed without its matching start item'));
      return true;
    }
    lifecycle.completion.resolve(params.item);
    return true;
  }

  async afterTurn({ threadId, activeTurn = false } = {}) {
    this.turnsSinceCompaction += 1;
    this.observeUsage(threadId);
    const usage = this.usageMeter.thread(threadId);
    if (!usage?.last) return { action: 'none', reason: 'usage unavailable' };
    const level = contextPressureLevel(usage.pressure, this.thresholds);
    const absolute = usage.last.inputTokens > this.thresholds.absoluteInputTokens;
    if (!absolute && !['compact', 'split'].includes(level)) {
      return { action: level === 'warn' ? 'warn' : 'none', pressure: usage.pressure };
    }
    if (activeTurn) return { action: 'deferred', reason: 'turn active', pressure: usage.pressure };
    if (this.turnsSinceCompaction < this.thresholds.minimumRootTurns) {
      return { action: 'deferred', reason: 'minimum turn spacing', pressure: usage.pressure };
    }
    if (usage.acceptedSnapshots <= this.lastCompactionSequence) {
      return { action: 'deferred', reason: 'no new model call', pressure: usage.pressure };
    }

    await this.refreshHandoff();
    const completion = deferred();
    const lifecycle = {
      threadId,
      itemId: null,
      started: false,
      completion,
    };
    this.currentLifecycle = lifecycle;
    this.attempts += 1;
    this.lastCompactionSequence = usage.acceptedSnapshots;
    this.latestOutcome = {
      status: 'started',
      at: new Date(this.now()).toISOString(),
      pressure_before: usage.pressure,
      pressure_after: null,
    };
    await this.persist(this.summary());
    let timer;
    const lifecycleResult = Promise.race([
      completion.promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('context compaction item lifecycle timed out')), this.lifecycleTimeoutMs);
        timer.unref?.();
      }),
    ]);
    try {
      await Promise.all([
        this.client.request('thread/compact/start', { threadId }),
        lifecycleResult,
      ]);
      clearTimeout(timer);
      this.count += 1;
      this.turnsSinceCompaction = 0;
      this.pendingVerification = {
        pressureBefore: usage.pressure,
        afterSequence: usage.acceptedSnapshots,
      };
      this.latestOutcome = {
        status: 'completed-awaiting-verification',
        at: new Date(this.now()).toISOString(),
        pressure_before: usage.pressure,
        pressure_after: null,
      };
      await this.persist(this.summary());
      return { action: 'compacted', pressure: usage.pressure };
    } catch (error) {
      clearTimeout(timer);
      this.latestOutcome = {
        status: 'failed',
        at: new Date(this.now()).toISOString(),
        pressure_before: usage.pressure,
        pressure_after: null,
        reason: String(error?.message ?? error),
      };
      await this.persist(this.summary());
      throw error;
    } finally {
      if (this.currentLifecycle === lifecycle) this.currentLifecycle = null;
    }
  }

  shouldSplitOrPause() {
    return this.splitRequired;
  }

  summary() {
    return {
      count: this.count,
      attempts: this.attempts,
      latest_outcome: this.latestOutcome ? { ...this.latestOutcome } : null,
      awaiting_verification: this.pendingVerification !== null,
      split_or_pause_required: this.splitRequired,
    };
  }
}
