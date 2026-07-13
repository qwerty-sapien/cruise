import { AppServerClient } from './app-server-client.mjs';
import { resolveWorkerPolicy } from './worker-policy.mjs';

export const WORKER_DEVELOPER_INSTRUCTIONS = `
Execute only the bounded Cruise task packet supplied by the coordinator.
Do not ask the user questions, grant permissions, reroute work, integrate sibling changes, activate goals, or address the user.
Treat omitted paths and effects as denied, preserve unrelated changes, return observed facts and evidence, and stop at any stated boundary.
`.trim();

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
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

export async function runWorkerSession({
  level,
  cwd,
  packet,
  client = null,
  timeoutMs = 30 * 60 * 1000,
} = {}) {
  if (!Number.isInteger(level) || level < 1 || level > 7) {
    throw new TypeError('worker level must be an integer from 1 through 7');
  }
  if (typeof cwd !== 'string' || !cwd) throw new TypeError('worker cwd is required');
  if (typeof packet !== 'string' || !packet.trim()) throw new TypeError('worker packet is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive');

  const ownedClient = client === null;
  const appServer = client ?? new AppServerClient({
    spawnOptions: { cwd },
    clientInfo: { name: 'cruise-worker', title: 'Cruise Worker', version: '0.1.0' },
    onServerRequest(message) {
      throw new Error(`worker cannot handle interactive server request ${message.method}`);
    },
  });
  const completion = deferred();
  const output = [];
  const warnings = [];
  let threadId = null;
  let turnId = null;

  const onNotification = (message) => {
    const params = message.params ?? {};
    if (threadId && params.threadId && params.threadId !== threadId) return;
    if (message.method === 'turn/started') turnId = params.turn?.id ?? turnId;
    if (message.method === 'item/agentMessage/delta') output.push(params.delta ?? '');
    if (['warning', 'configWarning'].includes(message.method)) {
      warnings.push(params.message ?? JSON.stringify(params));
    }
    if (message.method === 'error') {
      completion.reject(new Error(params.message ?? params.error?.message ?? 'worker turn failed'));
    }
    if (message.method === 'turn/completed' && (!turnId || params.turn?.id === turnId)) {
      completion.resolve(params.turn);
    }
  };
  appServer.on('notification', onNotification);
  try {
    await appServer.start();
    const catalog = await appServer.request('model/list', { limit: 100 });
    const policy = resolveWorkerPolicy({ recommendedLevel: level, catalog });
    if (policy.degraded || !policy.worker.resolved.model || !policy.worker.resolved.reasoning_effort) {
      throw new Error(`required worker pair is unavailable: ${policy.degradation_reasons.join('; ')}`);
    }

    const threadStart = await appServer.request('thread/start', {
      cwd,
      runtimeWorkspaceRoots: [],
      approvalPolicy: 'never',
      model: policy.worker.resolved.model,
      allowProviderModelFallback: false,
      developerInstructions: WORKER_DEVELOPER_INSTRUCTIONS,
      serviceName: 'cruise_worker',
      ephemeral: false,
    });
    threadId = threadStart.thread.id;
    const turnStart = await appServer.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: workerPrompt(packet), text_elements: [] }],
      model: policy.worker.resolved.model,
      effort: policy.worker.resolved.reasoning_effort,
      cwd,
      runtimeWorkspaceRoots: [],
      sandboxPolicy: sandboxPolicy(level, cwd),
      approvalPolicy: 'never',
      responsesapiClientMetadata: {
        cruise_level: String(level),
        cruise_agent_type: policy.worker.agent_type,
      },
    });
    turnId = turnStart.turn.id;

    let timeout;
    const timed = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`worker turn exceeded ${timeoutMs}ms`)), timeoutMs);
      timeout.unref?.();
    });
    const turn = await Promise.race([completion.promise, timed]).finally(() => clearTimeout(timeout));
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
      }),
      runtime: Object.freeze({ thread_id: threadId, turn_id: turnId, status: turn.status }),
      model_output: output.join(''),
      warnings: Object.freeze(warnings),
    });
  } finally {
    appServer.removeListener('notification', onNotification);
    if (ownedClient) await appServer.stop().catch(() => {});
  }
}
