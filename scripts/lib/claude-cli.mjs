import { spawn as nodeSpawn } from 'node:child_process';

import { normalizeRecommendedLevel } from './worker-policy.mjs';
import { skillReference } from './provider.mjs';

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
  'Claude Code exposes no documented Codex-style Goal lifecycle API to plugins; do not invent Goal endpoints or Goal state.',
  'For Goal work, resolve the outcome, scope fence, invariants, acceptance commands, and stall tuning, then write the user-editable advisory .cruise/FLIGHT.md as the first execution act; reread it at each micro-goal, realign scope drift, re-verify affected invariants, and keep its status truthful through completion or a concrete blocker. It grants and gates nothing.',
  'A Stop-hook supervisor may inject continuation or realignment instructions during Goal runs; respond by changing approach or reporting the blocker honestly, never by repeating the failed attempt.',
].join(' ');

export function claudeSessionArgs({ pluginRoot, skill, prompt }) {
  if (typeof pluginRoot !== 'string' || !pluginRoot) throw new TypeError('pluginRoot is required');
  if (typeof skill !== 'string' || !skill) throw new TypeError('skill is required');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('prompt is required');
  return [
    '--plugin-dir',
    pluginRoot,
    '--name',
    `Cruise ${skill}`,
    '--append-system-prompt',
    CLAUDE_HOST_INSTRUCTIONS,
    `${skillReference('claude', skill)} ${prompt}`,
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
} = {}) {
  const sessionEnv = { ...env };
  if (skill === 'goal') sessionEnv.CRUISE_CLAUDE_GOAL = '1';
  else delete sessionEnv.CRUISE_CLAUDE_GOAL;
  const result = await runClaudeCli({
    cwd,
    args: claudeSessionArgs({ pluginRoot, skill, prompt }),
    spawnFn,
    env: sessionEnv,
  });
  return Object.freeze({
    status: result.code === 0 ? 'complete' : result.code === 130 ? 'interrupted' : 'failed',
    exitCode: result.code,
  });
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
