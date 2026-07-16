/**
 * Create one absolute deadline shared by every stage of a bounded operation.
 * Later stages receive only the time left by earlier stages.
 */
export function createDeadline(timeoutMs, label) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('timeoutMs must be a positive integer');
  }
  if (typeof label !== 'string' || !label.trim()) {
    throw new TypeError('deadline label is required');
  }
  const expiresAt = Date.now() + timeoutMs;

  const timeoutError = (stage) => new Error(
    `${label} exceeded ${timeoutMs}ms during ${stage}`,
  );

  return Object.freeze({
    timeoutMs,
    remaining() {
      return Math.max(0, expiresAt - Date.now());
    },
    async run(stage, operation, { signals = [] } = {}) {
      if (typeof stage !== 'string' || !stage.trim()) {
        throw new TypeError('deadline stage is required');
      }
      if (typeof operation !== 'function') {
        throw new TypeError('deadline operation must be a function');
      }
      const remaining = Math.max(0, expiresAt - Date.now());
      if (remaining === 0) throw timeoutError(stage);

      let timer = null;
      const timed = new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(stage)), remaining);
      });
      try {
        return await Promise.race([
          Promise.resolve().then(operation),
          ...signals,
          timed,
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

/** Start cleanup immediately, but never let a faulty cleanup implementation hang its caller. */
export async function waitForCleanup(operation, timeoutMs = 1_000) {
  if (typeof operation !== 'function') throw new TypeError('cleanup operation must be a function');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('cleanup timeoutMs must be a positive integer');
  }
  let timer = null;
  const expired = Symbol('cleanup-expired');
  const timed = new Promise((resolve) => {
    timer = setTimeout(() => resolve(expired), timeoutMs);
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(operation).catch(() => undefined),
      timed,
    ]);
    return result !== expired;
  } finally {
    clearTimeout(timer);
  }
}
