import { AppServerClient } from './app-server-client.mjs';

const DNS_ERROR = /\b(?:EAI_AGAIN|EAI_NONAME|ENOTFOUND|DNS_PROBE_FINISHED_NXDOMAIN)\b|getaddrinfo/iu;
const CONNECTION_ERROR = /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up)\b|connection (?:closed|reset|refused)/iu;
const UPSTREAM_ERROR = /response retries exhausted|responseTooManyFailedAttempts|inference stream|upstream/iu;

function statusFrom(value) {
  for (const candidate of [
    value?.httpStatusCode,
    value?.statusCode,
    value?.status,
    value?.cause?.httpStatusCode,
    value?.cause?.statusCode,
  ]) {
    if (Number.isInteger(candidate)) return candidate;
  }
  const match = String(value?.message ?? value ?? '').match(/\bHTTP\s*(\d{3})\b/iu);
  return match ? Number(match[1]) : null;
}

/** Classify only evidence carried by the failure; never call an upstream 503 DNS. */
export function classifyWorkerFailure(value) {
  const message = String(value?.message ?? value ?? 'worker failed');
  const httpStatusCode = statusFrom(value);
  if (DNS_ERROR.test(message) || DNS_ERROR.test(String(value?.code ?? ''))) {
    return Object.freeze({ category: 'dns', httpStatusCode, message });
  }
  if ((httpStatusCode !== null && httpStatusCode >= 400 && httpStatusCode <= 599) || UPSTREAM_ERROR.test(message)) {
    return Object.freeze({ category: 'upstream', httpStatusCode, message });
  }
  if (CONNECTION_ERROR.test(message) || CONNECTION_ERROR.test(String(value?.code ?? ''))) {
    return Object.freeze({ category: 'connection', httpStatusCode, message });
  }
  return Object.freeze({ category: 'unknown', httpStatusCode, message });
}

export function workerFailureMessage(failure) {
  const suffix = failure.httpStatusCode === null ? '' : ` (HTTP ${failure.httpStatusCode})`;
  return `Worker ${failure.category} failure${suffix}: ${failure.message}.`;
}

function retryable(failure) {
  return ['dns', 'upstream', 'connection'].includes(failure.category);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function hasEffectNotification(message) {
  const method = String(message.method ?? '');
  const type = String(message.params?.item?.type ?? message.params?.type ?? '');
  return /(?:commandExecution|fileChange|applyPatch|tool)/iu.test(`${method} ${type}`);
}

async function oneAttempt({ cwd, task, clientFactory, onOutput, onServerRequest }) {
  const client = clientFactory({
    spawnOptions: { cwd },
    clientInfo: { name: 'cruise-worker', title: 'Cruise Worker', version: '0.1.0' },
    onServerRequest,
  });
  const completion = deferred();
  let threadId = null;
  let turnId = null;
  let effectsObserved = false;
  const output = [];
  const notification = (message) => {
    const params = message.params ?? {};
    if (message.method === 'item/agentMessage/delta') {
      const delta = String(params.delta ?? '');
      output.push(delta);
      onOutput?.(delta);
    }
    if (hasEffectNotification(message)) effectsObserved = true;
    if (message.method === 'error' && params.willRetry !== true) {
      const error = new Error(params.error?.message ?? params.message ?? 'worker stream failed');
      error.code = params.error?.code;
      error.httpStatusCode = params.error?.codexErrorInfo
        ? Object.values(params.error.codexErrorInfo)[0]?.httpStatusCode ?? null
        : params.error?.httpStatusCode ?? null;
      completion.reject(error);
    }
    if (message.method === 'turn/completed') completion.resolve(params.turn);
    if (message.method === 'turn/failed') completion.reject(new Error(params.turn?.error?.message ?? 'worker turn failed'));
  };
  const exited = (info = {}) => completion.reject(info.error ?? new Error('worker app-server exited'));
  client.on('notification', notification);
  client.on('exit', exited);
  try {
    await client.start();
    const started = await client.request('thread/start', {
      cwd,
      runtimeWorkspaceRoots: [],
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      serviceName: 'cruise_worker',
      ephemeral: true,
      developerInstructions: 'Execute the requested bounded task. Use normal Codex approvals. Do not create Cruise reports, packets, archives, or workflow state.',
    });
    threadId = started.thread.id;
    const turn = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: task, text_elements: [] }],
      cwd,
      runtimeWorkspaceRoots: [],
      approvalPolicy: 'on-request',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd] },
    });
    turnId = turn.turn.id;
    const terminal = await completion.promise;
    if (terminal.status !== 'completed') {
      throw new Error(`worker turn ended with status ${terminal.status}`);
    }
    return Object.freeze({ threadId, turnId, output: output.join(''), effectsObserved });
  } catch (error) {
    try {
      Object.defineProperty(error, 'effectsObserved', {
        value: effectsObserved,
        enumerable: false,
      });
    } catch {
      // Preserve primitive or frozen errors without masking the real failure.
    }
    throw error;
  } finally {
    client.off?.('notification', notification);
    client.off?.('exit', exited);
    await client.stop().catch(() => {});
  }
}

/**
 * Retry a terminal transport failure once only when the failed worker has not
 * started a tool or file operation.  There is no durable attempt marker, so a
 * caller can always make a normal later retry.
 */
export async function runSimpleWorker({
  cwd,
  task,
  clientFactory = (options) => new AppServerClient(options),
  onOutput = null,
  onServerRequest = null,
} = {}) {
  if (typeof cwd !== 'string' || !cwd) throw new TypeError('worker cwd is required');
  if (typeof task !== 'string' || !task.trim()) throw new TypeError('worker task is required');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await oneAttempt({ cwd, task, clientFactory, onOutput, onServerRequest });
    } catch (cause) {
      const failure = classifyWorkerFailure(cause);
      const effectsObserved = cause?.effectsObserved === true;
      if (attempt === 0 && !effectsObserved && retryable(failure)) continue;
      const error = new Error(workerFailureMessage(failure), { cause });
      error.code = 'CRUISE_WORKER_STREAM_FAILURE';
      error.category = failure.category;
      error.httpStatusCode = failure.httpStatusCode;
      throw error;
    }
  }
  throw new Error('worker retry loop exhausted');
}
