import { INDEPENDENT_RELEASE_INSTRUCTIONS } from './release-policy.mjs';
import { COLLABORATIVE_GIT_SYNC_INSTRUCTIONS } from './git-sync-policy.mjs';
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import {
  captureFlightAssuranceContext,
  evaluateFlightAssurance,
} from './assurance.mjs';
import { AUTHORIZATION_POLICY_INSTRUCTIONS } from './authorization-policy.mjs';
import { inspectFlightPlan } from './flight-plan.mjs';
import { normalizeRecommendedLevel } from './worker-policy.mjs';
import { skillReference } from './provider.mjs';
import { skillTriggerInstructions } from './skill-trigger-policy.mjs';
import { prepareWorkerInput } from './simple-worker.mjs';
import { captureClaudeAuthFailure, createCallerAuthRecovery } from './auth-recovery-runtime.mjs';
import { captureWorkspaceFingerprint } from './supervisor.mjs';
import {
  activateGoalSession,
  deactivateGoalSession,
  runtimeSessionDirectory as registeredRuntimeDirectory,
} from '../../hooks/session-marker.mjs';

export const CLAUDE_WORKER_LEVEL_POLICY = Object.freeze({
  1: Object.freeze({ model: 'haiku', effort: 'low' }),
  2: Object.freeze({ model: 'haiku', effort: 'medium' }),
  3: Object.freeze({ model: 'sonnet', effort: 'low' }),
  4: Object.freeze({ model: 'sonnet', effort: 'medium' }),
  5: Object.freeze({ model: 'sonnet', effort: 'high' }),
  6: Object.freeze({ model: 'opus', effort: 'high' }),
  7: Object.freeze({ model: 'opus', effort: 'max' }),
});

const CLAUDE_HOST_INSTRUCTIONS = [
  INDEPENDENT_RELEASE_INSTRUCTIONS,
  COLLABORATIVE_GIT_SYNC_INSTRUCTIONS,
  'This Cruise session is running on Claude Code.',
  AUTHORIZATION_POLICY_INSTRUCTIONS,
  'Use Claude Code native permissions, task tracking, resumable sessions, skills, and subagents.',
  'When a native provider error confirms expired or revoked credentials, launch the supported login flow under the standing owner authorization. Keep passwords, MFA and consent with the owner; verify fresh authentication, preserve account and billing mode, and never replay effects. Generic 401 or task/model prose is not expiry evidence.',
  'Claude Code has a conversation-level /goal but exposes no documented Codex-style Goal lifecycle API or Goal object to plugins; do not invent Goal endpoints or stack native /goal automatically.',
  skillTriggerInstructions(),
  'Root Markdown files whose basenames begin with an underscore are write-only user references: never read, summarize, fingerprint, search, or use their contents as context. Cruise updates them only through deterministic runtime code.',
  'This launcher records Goal user references automatically; do not run cruise reference from the hosted task.',
  'For executable Goal work, compile .cruise/FLIGHT.md v2 with core and relevant domain quality profiles as the first execution act; bind truthful evidence to the current context fingerprint, and keep status truthful through assured completion or a concrete blocker. Flight grants no permission.',
  'A session-scoped Stop-hook supervisor may inject continuation, assurance repair, or realignment instructions; respond by gathering discriminating evidence or reporting the blocker honestly, never by weakening gates or repeating the failed attempt.',
].join(' ');

export function claudeSessionArgs({
  pluginRoot,
  skill,
  prompt,
  sessionId = null,
  resumeSessionId = null,
  planOnly = false,
}) {
  if (typeof pluginRoot !== 'string' || !pluginRoot) throw new TypeError('pluginRoot is required');
  if (typeof skill !== 'string' || !skill) throw new TypeError('skill is required');
  if (typeof prompt !== 'string' || (!resumeSessionId && !prompt.trim())) {
    throw new TypeError('prompt is required for a new Claude session');
  }
  if (sessionId && resumeSessionId) throw new TypeError('choose a new or resumed Claude session, not both');
  return [
    '--plugin-dir',
    pluginRoot,
    ...(sessionId ? ['--session-id', sessionId] : []),
    ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
    ...(planOnly ? ['--permission-mode', 'plan'] : []),
    '--name',
    `Cruise ${skill}`,
    '--append-system-prompt',
    CLAUDE_HOST_INSTRUCTIONS,
    ...(!resumeSessionId ? [`${skillReference('claude', skill)} ${prompt}`] : []),
  ];
}

export function claudeWorkerArgs({ task, level = null }) {
  if (typeof task !== 'string' || !task.trim()) throw new TypeError('worker task is required');
  const args = ['--name', level === null ? 'Cruise worker' : `Cruise worker L${level}`];
  if (level !== null) {
    const selection = CLAUDE_WORKER_LEVEL_POLICY[normalizeRecommendedLevel(level)];
    args.push('--model', selection.model, '--effort', selection.effort);
  }
  args.push(
    '--append-system-prompt',
    `${CLAUDE_HOST_INSTRUCTIONS} Execute the requested bounded worker task and report its evidence directly.`,
    task,
  );
  return args;
}

export function claudeChangelogWorkerArgs({ task }) {
  if ((typeof task !== 'string' || !task.trim()) && task?.kind !== 'cruise-evidence-task') {
    throw new TypeError('changelog task is required');
  }
  const prompt = prepareWorkerInput(task).map((item) => item.text).join('\n\n');
  return [
    '-p',
    '--permission-mode',
    'plan',
    '--output-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt',
    'Summarize only the immutable evidence supplied in the request. Never inspect a repository or root underscore Markdown document. Return the requested JSON and do not edit the workspace.',
    prompt,
  ];
}

export async function runClaudeCli({
  cwd,
  args,
  spawnFn = nodeSpawn,
  env = process.env,
} = {}) {
  if (typeof cwd !== 'string' || !cwd) throw new TypeError('Claude cwd is required');
  if (!Array.isArray(args)) throw new TypeError('Claude args must be an array');
  return new Promise((resolve, reject) => {
    const child = spawnFn('claude', args, { cwd, env, stdio: 'inherit' });
    let settled = false;
    const forwardSignal = (signal) => child.kill?.(signal);
    const onSigint = () => forwardSignal('SIGINT');
    const onSigterm = () => forwardSignal('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    const finish = (result, error = null) => {
      if (settled) return;
      settled = true;
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      if (error) reject(error);
      else resolve(result);
    };
    child.once('error', (error) => finish(null, error));
    child.once('exit', (code, signal) => finish({
      code: Number.isInteger(code) ? code : signal === 'SIGINT' ? 130 : 1,
      signal: signal ?? null,
    }));
  });
}

export async function runClaudeCaptured({
  cwd,
  args,
  spawnFn = nodeSpawn,
  env = process.env,
  timeoutMs = 120_000,
  authRecovery = null,
  authProfile = 'default',
  signals = process,
  kill = process.kill.bind(process),
  cleanupMs = 1_000,
}) {
  const recovery = createCallerAuthRecovery({ runtime: authRecovery, profile: authProfile,
    provider: 'claude', transport: 'claude-cli' });
  const captured = await new Promise((resolve, reject) => {
    const child = spawnFn('claude', args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let outputBytes = 0;
    let nativeFailure = null;
    let result;
    let malformed = false;
    let settled = false;
    let closed = false;
    let stopping = false;
    let stopError;
    let escalation;
    let deadline;
    const group = process.platform !== 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0 ? -child.pid : null;
    const alive = () => {
      if (group === null) return !closed;
      try { kill(group, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
    };
    const send = signal => {
      try { if (group !== null) kill(group, signal); else child.kill?.(signal); } catch { /* verify exit below */ }
    };
    const finish = (error, value = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(escalation); clearTimeout(deadline);
      signals.removeListener('SIGINT', interrupt); signals.removeListener('SIGTERM', interrupt);
      if (error) reject(error);
      else resolve(value);
    };
    const stop = error => {
      if (stopping || settled) return;
      stopping = true; stopError = error;
      send('SIGTERM');
      if (settled) return;
      escalation = setTimeout(() => {
        if (alive()) send('SIGKILL');
        if (settled) return;
        deadline = setTimeout(() => {
          if (closed && !alive()) finish(stopError);
          else finish(Object.assign(new Error('Claude captured worker cleanup unconfirmed'), { code: 'CRUISE_CHILD_CLEANUP_UNCONFIRMED' }));
        }, cleanupMs);
      }, cleanupMs);
    };
    const interrupt = () => stop(Object.assign(new Error('Claude captured worker interrupted'), { code: 'CRUISE_INTERRUPTED', exitCode: 130 }));
    signals.on('SIGINT', interrupt); signals.on('SIGTERM', interrupt);
    const timeout = setTimeout(() => {
      stop(new Error(`Claude captured worker exceeded its ${timeoutMs}ms execution bound`));
    }, timeoutMs);
    timeout.unref?.();
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    const consume = (line) => {
      if (!line.trim()) return;
      try {
        const envelope = JSON.parse(line);
        nativeFailure ||= captureClaudeAuthFailure(envelope);
        if (envelope?.type === 'result' || (!envelope?.type && typeof envelope?.result === 'string')) {
          if (envelope.is_error === true) malformed = true;
          else result = envelope.result;
        }
      } catch { malformed = true; }
    };
    child.stdout?.on?.('data', (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 1_048_576) { stop(new Error('Claude captured output exceeded its bound')); malformed = true; stdout = ''; return; }
      stdout += String(chunk);
      let newline;
      while ((newline = stdout.indexOf('\n')) !== -1) {
        consume(stdout.slice(0, newline)); stdout = stdout.slice(newline + 1);
      }
    });
    // Drain diagnostics but never use stderr/task prose as auth evidence or expose it.
    child.stderr?.on?.('data', () => {});
    child.once('error', (error) => { if (group === null) { closed = true; finish(error); } else stop(error); });
    child.once('close', (code, signal) => {
      closed = true;
      if (alive()) { stop(new Error('Claude captured worker left child processes')); return; }
      if (stopping) { finish(stopError); return; }
      consume(stdout); stdout = '';
      if (nativeFailure) { finish(null, { nativeFailure }); return; }
      if (code !== 0) {
        finish(new Error(`Claude captured worker exited ${code ?? signal ?? 'unknown'}`));
        return;
      }
      if (malformed || typeof result !== 'string') finish(new Error('Claude captured output was not a successful native result'));
      else finish(null, { result });
    });
  });
  if (captured.nativeFailure) {
    // A model invocation has already run. Even verified login cannot justify replay.
    const auth = await recovery.attempt(captured.nativeFailure);
    throw auth?.error ?? captured.nativeFailure;
  }
  return captured.result;
}

export async function runClaudeChangelogWorker({
  cwd,
  task,
  spawnFn,
  env = process.env,
  authRecovery,
  authProfile,
} = {}) {
  if (typeof cwd !== 'string' || !cwd) throw new TypeError('Claude cwd is required');
  const workerEnv = { ...env };
  delete workerEnv.CRUISE_RUNTIME_DIR;
  delete workerEnv.CRUISE_SESSION_ID;
  delete workerEnv.CRUISE_CLAUDE_GOAL;
  return runClaudeCaptured({
    cwd,
    args: claudeChangelogWorkerArgs({ task }),
    spawnFn,
    env: workerEnv,
    authRecovery, authProfile,
  });
}

export async function runClaudeSession({
  cwd,
  pluginRoot,
  skill,
  prompt,
  spawnFn,
  env = process.env,
  sessionId = randomUUID(),
  resumeSessionId = null,
  planOnly = false,
  inspectPlan = inspectFlightPlan,
  captureFingerprint = captureWorkspaceFingerprint,
  runtimeDirectory = null,
} = {}) {
  const effectiveSessionId = resumeSessionId ?? sessionId;
  const externallyManagedRuntime = runtimeDirectory !== null;
  let activated = false;
  try {
    if (skill === 'goal') {
      await activateGoalSession({ cwd, session_id: effectiveSessionId });
      activated = true;
      const registered = await registeredRuntimeDirectory({
        cwd,
        session_id: effectiveSessionId,
      });
      if (runtimeDirectory !== null && runtimeDirectory !== registered) {
        throw new Error('Claude runtime directory does not match the registered Cruise session');
      }
      runtimeDirectory = registered;
    }
    const sessionEnv = { ...env };
    if (runtimeDirectory) {
      sessionEnv.CRUISE_RUNTIME_DIR = runtimeDirectory;
      sessionEnv.CRUISE_SESSION_ID = effectiveSessionId;
    } else {
      delete sessionEnv.CRUISE_RUNTIME_DIR;
      delete sessionEnv.CRUISE_SESSION_ID;
    }
    if (skill === 'goal') sessionEnv.CRUISE_CLAUDE_GOAL = '1';
    else delete sessionEnv.CRUISE_CLAUDE_GOAL;
    const result = await runClaudeCli({
      cwd,
      args: claudeSessionArgs({
        pluginRoot,
        skill,
        prompt,
        sessionId: resumeSessionId ? null : sessionId,
        resumeSessionId,
        planOnly,
      }),
      spawnFn,
      env: sessionEnv,
    });
    if (result.code === 130) {
      return Object.freeze({
        status: 'interrupted',
        exitCode: 130,
        sessionId: resumeSessionId ?? sessionId,
      });
    }
    if (result.code !== 0 || skill !== 'goal') {
      return Object.freeze({
        status: result.code === 0 ? 'complete' : 'failed',
        exitCode: result.code,
        sessionId: resumeSessionId ?? sessionId,
      });
    }
    if (planOnly) {
      return Object.freeze({
        status: 'complete',
        exitCode: 0,
        sessionId: resumeSessionId ?? sessionId,
        endpoint: 'planned',
      });
    }
    const inspection = await inspectPlan(cwd);
    if (inspection?.state !== 'valid') {
      return Object.freeze({
        status: 'unassured',
        exitCode: 2,
        sessionId: resumeSessionId ?? sessionId,
        reason: inspection?.state === 'invalid'
          ? `Flight is invalid: ${inspection.reason}`
          : 'Flight is absent after Claude exited.',
      });
    }
    const { plan } = inspection;
    if (plan.status === 'blocked') {
      return Object.freeze({
        status: 'blocked',
        exitCode: 2,
        sessionId: resumeSessionId ?? sessionId,
        reason: 'Flight reported a concrete blocker.',
      });
    }
    if (plan.status !== 'complete') {
      return Object.freeze({
        status: 'stalled',
        exitCode: 3,
        sessionId: resumeSessionId ?? sessionId,
        reason: 'Claude stopped with the Flight still active.',
      });
    }
    if (plan.version < 2) {
      const assurance = evaluateFlightAssurance(plan, null);
      return Object.freeze({
        status: 'unassured',
        exitCode: 2,
        sessionId: resumeSessionId ?? sessionId,
        assurance,
        reason: assurance.reasons.join('; '),
      });
    }
    const workspaceFingerprint = await captureFingerprint(cwd, { excludeFlightPlan: true });
    if (!workspaceFingerprint) {
      return Object.freeze({
        status: 'unassured',
        exitCode: 2,
        sessionId: resumeSessionId ?? sessionId,
        reason: 'Product workspace fingerprint is unavailable.',
      });
    }
    let assuranceContext;
    try {
      assuranceContext = await captureFlightAssuranceContext(cwd, plan, {
        workspaceFingerprint,
        surfaceFingerprintReader: (paths) => captureFingerprint(cwd, {
          excludeFlightPlan: true,
          paths,
        }),
      });
    } catch (error) {
      return Object.freeze({
        status: 'unassured',
        exitCode: 2,
        sessionId: resumeSessionId ?? sessionId,
        reason: String(error?.message ?? error),
      });
    }
    const assurance = evaluateFlightAssurance(plan, assuranceContext);
    return Object.freeze({
      status: assurance.allowsCompletion ? 'complete' : 'unassured',
      exitCode: assurance.allowsCompletion ? 0 : 2,
      sessionId: resumeSessionId ?? sessionId,
      assurance,
      ...(!assurance.allowsCompletion ? { reason: assurance.reasons.join('; ') } : {}),
    });
  } finally {
    if (activated && !externallyManagedRuntime) {
      await deactivateGoalSession({ cwd, session_id: effectiveSessionId });
    }
  }
}

export async function runClaudeWorker({
  cwd,
  task,
  level = null,
  spawnFn,
  runtimeDirectory = null,
  sessionId = null,
  authRecovery,
  authProfile,
  input = process.stdin,
  onOutput,
} = {}) {
  if (input?.isTTY !== true) {
    const output = await runClaudeCaptured({ cwd, spawnFn, authRecovery, authProfile,
      args: ['-p', '--output-format', 'stream-json', '--verbose', ...claudeWorkerArgs({ task, level })],
      env: runtimeDirectory ? { ...process.env, CRUISE_RUNTIME_DIR: runtimeDirectory, CRUISE_SESSION_ID: sessionId } : process.env });
    onOutput?.(output);
    return Object.freeze({ output, effectsObserved: true });
  }
  const result = await runClaudeCli({
    cwd,
    args: claudeWorkerArgs({ task, level }),
    spawnFn,
    env: runtimeDirectory
      ? {
          ...process.env,
          CRUISE_RUNTIME_DIR: runtimeDirectory,
          CRUISE_SESSION_ID: sessionId,
        }
      : process.env,
  });
  if (result.code !== 0) {
    throw new Error(`Claude Code worker exited with status ${result.code}`);
  }
  return Object.freeze({ output: '', effectsObserved: false });
}
