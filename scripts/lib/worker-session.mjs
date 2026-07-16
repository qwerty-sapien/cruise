import { createHash } from 'node:crypto';

import { AppServerClient } from './app-server-client.mjs';
import {
  appServerDiagnostic,
  createIsolatedAppServerRuntime,
  workerConnectionDiagnostic,
} from './app-server-runtime.mjs';
import { createDeadline, waitForCleanup } from './deadline.mjs';
import { resolveWorkerPolicy } from './worker-policy.mjs';

export const WORKER_DEVELOPER_INSTRUCTIONS = `
Execute only the bounded Cruise task packet supplied by the coordinator.
Do not ask the user questions, grant permissions, reroute work, integrate sibling changes, activate goals, or address the user.
Treat omitted paths and effects as denied, preserve unrelated changes, return observed facts and evidence, and stop at any stated boundary.
`.trim();

function packetDigest(packet) {
  return createHash('sha256').update(Buffer.from(packet, 'utf8')).digest('hex');
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

function workerPrompt(packet) {
  return [
    'Execute the following bounded Cruise worker packet exactly as written.',
    'Return one complete attempt report with observations, changed paths, evidence, residual risks, and any block reason.',
    '',
    packet,
  ].join('\n');
}

function sandboxPolicy(_level, cwd) {
  return {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    // Foreign-diff authority and worker locks live in the host temp root,
    // outside the worker-writable repository. Never grant worker tools an
    // ambient temp escape that could rewrite that host-owned control plane.
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
}

const MAX_FAILURE_HEADLINE_LENGTH = 2_048;

export function sanitizeWorkerFailureMessage(value, maxLength = null) {
  let message = String(value ?? 'worker turn failed');
  message = message
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/giu, '$1=[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED]')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!message) message = 'worker turn failed';
  return Number.isInteger(maxLength) && maxLength > 0 && message.length > maxLength
    ? `${message.slice(0, maxLength - 1)}…`
    : message;
}

/** Redact command diagnostics while retaining their complete line structure. */
export function sanitizeWorkerDiagnosticText(value) {
  return String(value ?? '')
    // Preserve a token boundary when removing terminal controls so adjacent
    // printable text cannot hide a credential prefix from later redaction.
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, ' ')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/giu, '$1=[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED]');
}

function codexErrorIdentity(value) {
  if (typeof value === 'string') return { codex_error: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const [kind, details] = Object.entries(value)[0] ?? [];
  if (!kind) return {};
  const httpStatusCode = details?.httpStatusCode;
  return {
    codex_error: sanitizeWorkerFailureMessage(kind, 256),
    ...(Number.isInteger(httpStatusCode) ? { http_status_code: httpStatusCode } : {}),
  };
}

export function workerReconnectEvent(params, sequence) {
  const details = params.error?.additionalDetails;
  return Object.freeze({
    sequence,
    will_retry: params.willRetry === true,
    message: sanitizeWorkerFailureMessage(
      params.message ?? params.error?.message ?? 'worker turn failed',
    ),
    ...codexErrorIdentity(params.error?.codexErrorInfo),
    ...(typeof details === 'string' && details.trim()
      ? { additional_details: sanitizeWorkerFailureMessage(details) }
      : {}),
  });
}

export function formatReconnectHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return '';
  return [
    'Reconnect history:',
    ...history.map((event, index) => {
      const identity = event.codex_error
        ? ` [${event.codex_error}${event.http_status_code == null ? '' : ` HTTP ${event.http_status_code}`}]`
        : '';
      const details = event.additional_details ? ` (${event.additional_details})` : '';
      return `  ${index + 1}. ${event.will_retry ? 'retrying' : 'terminal'}${identity}: ${event.message}${details}`;
    }),
  ].join('\n');
}

export class WorkerSessionError extends Error {
  constructor(message, {
    cause,
    runtime = {},
    reconnectHistory = [],
    diagnostic = null,
  } = {}) {
    const headline = sanitizeWorkerFailureMessage(message, MAX_FAILURE_HEADLINE_LENGTH);
    const safeDiagnostic = diagnostic ? sanitizeWorkerFailureMessage(diagnostic, 4_096) : null;
    const history = Object.freeze(reconnectHistory.map((event) => Object.freeze({
      sequence: event.sequence,
      will_retry: event.will_retry === true,
      message: sanitizeWorkerFailureMessage(event.message),
      ...(event.codex_error ? { codex_error: sanitizeWorkerFailureMessage(event.codex_error, 256) } : {}),
      ...(Number.isInteger(event.http_status_code) ? { http_status_code: event.http_status_code } : {}),
      ...(event.additional_details
        ? { additional_details: sanitizeWorkerFailureMessage(event.additional_details) }
        : {}),
    })));
    const rendered = [
      safeDiagnostic && !headline.includes(safeDiagnostic)
        ? `${headline}; ${safeDiagnostic}`
        : headline,
      formatReconnectHistory(history),
    ].filter(Boolean).join('\n');
    super(rendered, cause === undefined ? undefined : { cause });
    this.name = 'WorkerSessionError';
    this.code = 'CRUISE_WORKER_SESSION_FAILED';
    this.runtime = Object.freeze({
      thread_id: runtime.thread_id ?? null,
      turn_id: runtime.turn_id ?? null,
    });
    this.reconnectHistory = history;
    this.diagnostic = safeDiagnostic;
  }
}

export function createWorkerFailureReport(error, {
  level = null,
  recordedAt = new Date().toISOString(),
} = {}) {
  const history = error instanceof WorkerSessionError
    ? error.reconnectHistory
    : Object.freeze([]);
  const runtime = error instanceof WorkerSessionError
    ? error.runtime
    : Object.freeze({ thread_id: null, turn_id: null });
  return Object.freeze({
    schema_version: 1,
    kind: 'cruise_app_server_worker_failure',
    recorded_at: recordedAt,
    recommended_level: Number.isInteger(level) ? level : null,
    runtime,
    error: Object.freeze({
      code: error?.code ?? 'CRUISE_WORKER_FAILED',
      message: sanitizeWorkerFailureMessage(error?.message ?? error),
      diagnostic: error instanceof WorkerSessionError ? error.diagnostic : null,
    }),
    reconnect_history: history,
  });
}

export async function runWorkerSession({
  level,
  cwd,
  packet,
  codexHome = null,
  client = null,
  clientFactory = (options) => new AppServerClient(options),
  runtimeFactory = createIsolatedAppServerRuntime,
  timeoutMs = 30 * 60 * 1000,
} = {}) {
  if (!Number.isInteger(level) || level < 1 || level > 7) {
    throw new TypeError('worker level must be an integer from 1 through 7');
  }
  if (typeof cwd !== 'string' || !cwd) throw new TypeError('worker cwd is required');
  if (typeof packet !== 'string' || !packet.trim()) throw new TypeError('worker packet is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive');
  const deadline = createDeadline(timeoutMs, 'worker session');
  const ownedClient = client === null;
  let runtime = null;
  let runtimePromise = null;
  let extensionPolicy = Object.freeze({
    profile: 'caller-provided',
    plugins: 'caller-controlled',
    apps: 'caller-controlled',
    disabled_mcp_servers: Object.freeze([]),
  });
  const completion = deferred();
  const fatal = deferred();
  // A protocol failure can happen while start() or another request is still
  // pending. Observe this promise immediately so that rejecting it before the
  // turn wait is installed cannot become an unhandled rejection.
  void completion.promise.catch(() => {});
  void fatal.promise.catch(() => {});
  let terminalError = null;
  let appServer = client;
  const output = [];
  const warnings = [];
  const reconnectHistory = [];
  const stderr = [];
  let threadId = null;
  let turnId = null;

  const onNotification = (message) => {
    const params = message.params ?? {};
    if (threadId && params.threadId && params.threadId !== threadId) return;
    const notificationTurnId = params.turnId ?? params.turn?.id ?? null;
    if (turnId && notificationTurnId && notificationTurnId !== turnId) return;
    if (message.method === 'turn/started') turnId = params.turn?.id ?? turnId;
    if (message.method === 'item/agentMessage/delta') output.push(params.delta ?? '');
    if (['warning', 'configWarning'].includes(message.method)) {
      warnings.push(params.message ?? JSON.stringify(params));
    }
    if (message.method === 'error') {
      const event = workerReconnectEvent(params, reconnectHistory.length + 1);
      reconnectHistory.push(event);
      if (params.willRetry === true) {
        warnings.push(`transient app-server error (retrying): ${event.message}`);
      } else {
        terminalError = new Error(event.message);
        fatal.reject(terminalError);
      }
    }
    if (message.method === 'turn/completed' && (!turnId || params.turn?.id === turnId)) {
      completion.resolve(params.turn);
    }
  };
  const onStderr = (chunk) => {
    stderr.push(String(chunk));
    while (stderr.join('').length > 8 * 1024) stderr.shift();
  };
  const onExit = (info = {}) => {
    terminalError = info.error ?? new Error('app-server exited before worker turn completed');
    fatal.reject(terminalError);
  };
  try {
    if (ownedClient) {
      runtimePromise = Promise.resolve().then(
        () => runtimeFactory({ extensionProfile: 'worker', codexHome }),
      );
      runtime = await deadline.run('isolated runtime setup', () => runtimePromise);
      extensionPolicy = runtime.extensionPolicy ?? extensionPolicy;
      appServer = clientFactory({
        args: ['app-server', '--stdio', ...(runtime.appServerArgs ?? [])],
        spawnOptions: { cwd, ...runtime.spawnOptions },
        clientInfo: { name: 'cruise-worker', title: 'Cruise Worker', version: '0.1.0' },
        onServerRequest(message) {
          throw new Error(`worker cannot handle interactive server request ${message.method}`);
        },
        onError(error, clientInstance) {
          terminalError = error;
          fatal.reject(error);
          void clientInstance.stop().catch(() => {});
        },
      });
    }
    appServer.on('notification', onNotification);
    appServer.on('stderr', onStderr);
    appServer.on('exit', onExit);
    const signals = [fatal.promise];
    await deadline.run('app-server start', () => appServer.start(), { signals });
    const catalog = await deadline.run(
      'model/list',
      () => appServer.request('model/list', { limit: 100 }),
      { signals },
    );
    const policy = resolveWorkerPolicy({ recommendedLevel: level, catalog });
    if (policy.degraded || !policy.worker.resolved.model || !policy.worker.resolved.reasoning_effort) {
      throw new Error(`required worker pair is unavailable: ${policy.degradation_reasons.join('; ')}`);
    }

    const threadStart = await deadline.run('thread/start', () => appServer.request('thread/start', {
      cwd,
      runtimeWorkspaceRoots: [],
      // Workers cannot answer user prompts themselves. Request-based approval
      // therefore preserves Codex's boundary by stopping on an escalation
      // rather than silently approving it.
      approvalPolicy: 'on-request',
      model: policy.worker.resolved.model,
      allowProviderModelFallback: false,
      developerInstructions: WORKER_DEVELOPER_INSTRUCTIONS,
      serviceName: 'cruise_worker',
      ephemeral: false,
    }), { signals });
    threadId = threadStart.thread.id;
    const turnStart = await deadline.run('turn/start', () => appServer.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: workerPrompt(packet), text_elements: [] }],
      model: policy.worker.resolved.model,
      effort: policy.worker.resolved.reasoning_effort,
      cwd,
      runtimeWorkspaceRoots: [],
      sandboxPolicy: sandboxPolicy(level, cwd),
      approvalPolicy: 'on-request',
      responsesapiClientMetadata: {
        cruise_level: String(level),
        cruise_agent_type: policy.worker.agent_type,
      },
    }), { signals });
    turnId = turnStart.turn.id;

    const turn = await deadline.run(
      'turn completion',
      () => completion.promise,
      { signals },
    );
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    if (terminalError) throw terminalError;
    if (turn.status !== 'completed') {
      throw new Error(`worker turn ended with status ${turn.status}`);
    }
    return Object.freeze({
      schema_version: 1,
      kind: 'cruise_app_server_worker_report',
      launch: Object.freeze({
        recommended_level: level,
        agent_type: policy.worker.agent_type,
        alias: policy.worker.alias,
        requested: Object.freeze({
          model: policy.worker.requested.model_id,
          reasoning_effort: policy.worker.requested.reasoning_effort,
        }),
        resolved: Object.freeze({
          model: policy.worker.resolved.model,
          reasoning_effort: policy.worker.resolved.reasoning_effort,
        }),
        resolution_source: policy.worker.resolution_source,
        provider_model_fallback_allowed: false,
        packet_sha256: packetDigest(packet),
        extension_policy: extensionPolicy,
      }),
      runtime: Object.freeze({ thread_id: threadId, turn_id: turnId, status: turn.status }),
      model_output: output.join(''),
      warnings: Object.freeze(warnings),
    });
  } catch (error) {
    const terminalReconnect = [...reconnectHistory]
      .reverse()
      .find(({ will_retry: willRetry }) => willRetry !== true);
    const diagnostic = appServerDiagnostic(stderr.join(''))
      ?? workerConnectionDiagnostic(error)
      ?? (terminalReconnect ? workerConnectionDiagnostic(terminalReconnect) : null);
    throw new WorkerSessionError(error.message, {
      cause: error,
      runtime: { thread_id: threadId, turn_id: turnId },
      reconnectHistory,
      diagnostic,
    });
  } finally {
    const cleanupTimeoutMs = Math.min(timeoutMs, 1_000);
    if (appServer) {
      appServer.removeListener('notification', onNotification);
      appServer.removeListener('stderr', onStderr);
      appServer.removeListener('exit', onExit);
    }
    if (!runtime && runtimePromise) {
      void runtimePromise.then(
        (lateRuntime) => waitForCleanup(() => lateRuntime.dispose(), cleanupTimeoutMs),
        () => undefined,
      ).catch(() => {});
    }
    if (ownedClient && appServer) {
      await waitForCleanup(
        () => appServer.stop({ timeoutMs: Math.min(timeoutMs, 500) }),
        cleanupTimeoutMs,
      );
    }
    if (runtime) {
      await waitForCleanup(() => runtime.dispose(), cleanupTimeoutMs);
    }
  }
}
