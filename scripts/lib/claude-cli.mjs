import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import {
  captureFlightContextFingerprint,
  evaluateFlightAssurance,
} from './assurance.mjs';
import { inspectFlightPlan } from './flight-plan.mjs';
import { normalizeRecommendedLevel } from './worker-policy.mjs';
import { skillReference } from './provider.mjs';
import { captureWorkspaceFingerprint } from './supervisor.mjs';
import {
  activateGoalSession,
  deactivateGoalSession,
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
  'This Cruise session is running on Claude Code.',
  'Use Claude Code native permissions, task tracking, resumable sessions, skills, and subagents.',
  'Claude Code has a conversation-level /goal but exposes no documented Codex-style Goal lifecycle API or Goal object to plugins; do not invent Goal endpoints or stack native /goal automatically.',
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
    const finish = (result, error = null) => {
      if (settled) return;
      settled = true;
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
} = {}) {
  const effectiveSessionId = resumeSessionId ?? sessionId;
  if (skill === 'goal') {
    await activateGoalSession({ cwd, session_id: effectiveSessionId });
  }
  try {
    const sessionEnv = { ...env };
    delete sessionEnv.CRUISE_CLAUDE_GOAL;
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
    let contextFingerprint;
    try {
      contextFingerprint = await captureFlightContextFingerprint(cwd, plan, {
        workspaceFingerprint,
      });
    } catch (error) {
      return Object.freeze({
        status: 'unassured',
        exitCode: 2,
        sessionId: resumeSessionId ?? sessionId,
        reason: String(error?.message ?? error),
      });
    }
    const assurance = evaluateFlightAssurance(plan, contextFingerprint);
    return Object.freeze({
      status: assurance.allowsCompletion ? 'complete' : 'unassured',
      exitCode: assurance.allowsCompletion ? 0 : 2,
      sessionId: resumeSessionId ?? sessionId,
      assurance,
      ...(!assurance.allowsCompletion ? { reason: assurance.reasons.join('; ') } : {}),
    });
  } finally {
    if (skill === 'goal') {
      await deactivateGoalSession({ cwd, session_id: effectiveSessionId });
    }
  }
}

export async function runClaudeWorker({ cwd, task, level = null, spawnFn } = {}) {
  const result = await runClaudeCli({
    cwd,
    args: claudeWorkerArgs({ task, level }),
    spawnFn,
  });
  if (result.code !== 0) {
    throw new Error(`Claude Code worker exited with status ${result.code}`);
  }
  return Object.freeze({ output: '', effectsObserved: false });
}
