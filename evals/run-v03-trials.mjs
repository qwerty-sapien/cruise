#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { claudeSessionArgs } from '../scripts/lib/claude-cli.mjs';

const EVALS_ROOT = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(EVALS_ROOT, '..');
const CASES_FILE = join(EVALS_ROOT, 'cases', 'v03-goal.json');
const DEFAULT_RESULTS = join(EVALS_ROOT, 'results', '2026-07-21');
const HOSTS = new Set(['codex', 'claude']);
const ARMS = new Set(['treatment', 'control']);
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseArgs(argv) {
  const options = {
    providers: ['codex', 'claude'],
    arms: ['treatment', 'control'],
    cases: null,
    results: DEFAULT_RESULTS,
    claudeBudgetUsd: 0.5,
    runSuffix: '',
    seedActiveFlight: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--provider') {
      if (!HOSTS.has(value) && value !== 'all') throw new Error('--provider requires codex, claude, or all');
      options.providers = value === 'all' ? [...HOSTS] : [value];
      index += 1;
    } else if (arg === '--arm') {
      if (!ARMS.has(value) && value !== 'all') throw new Error('--arm requires treatment, control, or all');
      options.arms = value === 'all' ? [...ARMS] : [value];
      index += 1;
    } else if (arg === '--case') {
      if (!value) throw new Error('--case requires a comma-separated case id list');
      options.cases = value.split(',').map((item) => item.trim()).filter(Boolean);
      index += 1;
    } else if (arg === '--results') {
      if (!value) throw new Error('--results requires a directory');
      options.results = resolve(value);
      index += 1;
    } else if (arg === '--claude-budget-usd') {
      const budget = Number(value);
      if (!Number.isFinite(budget) || budget <= 0) throw new Error('--claude-budget-usd requires a positive number');
      options.claudeBudgetUsd = budget;
      index += 1;
    } else if (arg === '--run-suffix') {
      if (!/^[a-z0-9-]+$/u.test(value ?? '')) throw new Error('--run-suffix requires lowercase letters, digits, or hyphens');
      options.runSuffix = `-${value}`;
      index += 1;
    } else if (arg === '--seed-active-flight') {
      options.seedActiveFlight = true;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: node evals/run-v03-trials.mjs [--provider codex|claude|all] [--arm treatment|control|all] [--case V301,V302] [--results DIR] [--claude-budget-usd N] [--run-suffix NAME] [--seed-active-flight]\n');
      return null;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function execCapture(command, args, { cwd, env = process.env, timeoutMs = 30_000 } = {}) {
  return runProcess(command, args, { cwd, env, timeoutMs, captureLimit: 2 * 1024 * 1024 });
}

async function runProcess(command, args, {
  cwd,
  env,
  timeoutMs,
  captureLimit = MAX_CAPTURE_BYTES,
} = {}) {
  const startedAt = Date.now();
  const chunks = [];
  let captured = 0;
  let truncated = false;
  let timedOut = false;
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  child.stdin.end();
  const append = (stream, chunk) => {
    if (captured >= captureLimit) {
      truncated = true;
      return;
    }
    const text = chunk.toString('utf8');
    const remaining = captureLimit - captured;
    const kept = Buffer.byteLength(text) <= remaining ? text : Buffer.from(text).subarray(0, remaining).toString('utf8');
    captured += Buffer.byteLength(kept);
    chunks.push({ stream, text: kept });
    if (kept.length !== text.length) truncated = true;
  };
  child.stdout.on('data', (chunk) => append('stdout', chunk));
  child.stderr.on('data', (chunk) => append('stderr', chunk));

  const terminate = (signal) => {
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {}
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate('SIGTERM');
    setTimeout(() => terminate('SIGKILL'), 5_000).unref();
  }, timeoutMs);

  const result = await new Promise((resolvePromise) => {
    child.once('error', (error) => resolvePromise({ code: null, signal: null, error: error.message }));
    child.once('exit', (code, signal) => resolvePromise({ code, signal, error: null }));
  });
  clearTimeout(timer);
  return {
    ...result,
    timedOut,
    truncated,
    elapsedMs: Date.now() - startedAt,
    chunks,
  };
}

function transcriptText(result, workspace) {
  const normalized = result.chunks.map(({ stream, text }) => `[${stream}]\n${text}`).join('');
  const workspaceAlias = workspace.startsWith('/private/var/') ? workspace.replace(/^\/private/u, '') : `/private${workspace}`;
  return `${normalized}${result.truncated ? '\n[harness]\nTranscript capture truncated at 8 MiB.\n' : ''}`
    .split(workspace).join('<WORKSPACE>')
    .split(workspaceAlias).join('<WORKSPACE>')
    .split(PACKAGE_ROOT).join('<PLUGIN_ROOT>')
    .replace(/\/Users\/[^/]+\/\.claude\/projects\/[^"\s]+\/memory\//gu, '<HOST_MEMORY>/')
    .split(homedir()).join('<USER_HOME>');
}

function controlPrompt(caseDefinition, provider) {
  const native = provider === 'codex'
    ? 'Use the host native Goal/autonomous execution behavior.'
    : 'Work autonomously through planning, implementation, verification, and truthful completion.';
  return `${native} ${caseDefinition.prompt}`;
}

function claudeArgs(caseDefinition, arm, budget) {
  const common = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-hook-events',
    '--no-session-persistence',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--model', 'sonnet',
    '--effort', 'medium',
    '--permission-mode', 'acceptEdits',
    '--tools', 'Read,Edit,Write,Bash,Glob,Grep',
    '--allowedTools', 'Read,Edit,Write,Bash,Glob,Grep',
    '--max-budget-usd', String(budget),
  ];
  if (arm === 'control') return [...common, controlPrompt(caseDefinition, 'claude')];
  const session = claudeSessionArgs({
    pluginRoot: PACKAGE_ROOT,
    skill: 'goal',
    prompt: caseDefinition.prompt,
  });
  return [...common, ...session];
}

function commandFor(caseDefinition, provider, arm, workspace, budget) {
  if (provider === 'claude') {
    return { command: 'claude', args: claudeArgs(caseDefinition, arm, budget) };
  }
  if (arm === 'treatment') {
    return {
      command: process.execPath,
      args: [join(PACKAGE_ROOT, 'scripts', 'cruise.mjs'), '--codex', 'goal', '-C', workspace, caseDefinition.prompt],
    };
  }
  return {
    command: 'codex',
    args: [
      'exec',
      '--ephemeral',
      '--json',
      '--color', 'never',
      '--sandbox', 'workspace-write',
      '-C', workspace,
      controlPrompt(caseDefinition, 'codex'),
    ],
  };
}

async function initializeFixture(caseDefinition, root) {
  const workspace = join(root, 'workspace');
  await cp(resolve(EVALS_ROOT, caseDefinition.fixture), workspace, { recursive: true });
  const commands = [
    ['init', '--quiet'],
    ['config', 'user.email', 'eval@example.invalid'],
    ['config', 'user.name', 'Cruise Eval'],
    ['add', '-A'],
    ['commit', '--quiet', '-m', 'fixture baseline'],
  ];
  for (const args of commands) {
    const result = await execCapture('git', args, { cwd: workspace });
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${transcriptText(result, workspace)}`);
  }
  const tree = await execCapture('git', ['rev-parse', 'HEAD^{tree}'], { cwd: workspace });
  return { workspace, baselineTree: tree.chunks.map(({ text }) => text).join('').trim() };
}

async function finalTree(workspace) {
  await execCapture('git', ['add', '-A'], { cwd: workspace });
  const result = await execCapture('git', ['write-tree'], { cwd: workspace });
  return result.chunks.map(({ text }) => text).join('').trim();
}

async function optionalFile(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function fixtureDigest(directory) {
  const entries = [];
  const walk = async (current) => {
    for (const name of (await readdir(current)).sort()) {
      if (name === '.git' || name === '__pycache__' || name === '.cruise') continue;
      const path = join(current, name);
      const metadata = await stat(path);
      if (metadata.isDirectory()) await walk(path);
      else if (metadata.isFile()) entries.push(`${relative(directory, path)}\0${sha256(await readFile(path))}`);
    }
  };
  await walk(directory);
  return sha256(entries.join('\n'));
}

async function runVerifier(caseDefinition, workspace, env) {
  const commands = caseDefinition.kind === 'stall'
    ? [['python3', ['verify_release.py']]]
    : [
        ['python3', ['-m', 'unittest', '-v']],
        ...(caseDefinition.oracle
          ? [['python3', [
              '-m', 'unittest', 'discover', '-v',
              '-s', resolve(EVALS_ROOT, caseDefinition.oracle),
              '-p', 'test_*.py',
            ]]]
          : []),
      ];
  const aggregate = {
    code: 0,
    signal: null,
    error: null,
    timedOut: false,
    truncated: false,
    elapsedMs: 0,
    chunks: [],
  };
  for (const [command, args] of commands) {
    aggregate.chunks.push({ stream: 'stdout', text: `[harness verifier] ${command} ${args.join(' ')}\n` });
    const result = await execCapture(command, args, {
      cwd: workspace,
      env: { ...env, PYTHONPATH: workspace },
      timeoutMs: 60_000,
    });
    aggregate.chunks.push(...result.chunks);
    aggregate.elapsedMs += result.elapsedMs;
    aggregate.timedOut ||= result.timedOut;
    aggregate.truncated ||= result.truncated;
    if (result.code !== 0 && aggregate.code === 0) aggregate.code = result.code ?? 1;
    if (result.error && !aggregate.error) aggregate.error = result.error;
  }
  return aggregate;
}

function blindAssignment(provider, caseId) {
  const treatmentIsX = Number.parseInt(sha256(`${provider}:${caseId}`).slice(0, 2), 16) % 2 === 0;
  return treatmentIsX ? { treatment: 'X', control: 'Y' } : { treatment: 'Y', control: 'X' };
}

async function runTrial({ caseDefinition, provider, arm, options, privateKey }) {
  const blind = blindAssignment(provider, caseDefinition.id)[arm];
  const runId = `${provider}-${caseDefinition.id.toLowerCase()}-${blind.toLowerCase()}-r1${options.runSuffix}`;
  const trialRoot = await mkdtemp(join(tmpdir(), `cruise-v03-${runId}-`));
  const artifactRoot = join(options.results, 'raw', runId);
  await mkdir(artifactRoot, { recursive: true });
  const { workspace, baselineTree } = await initializeFixture(caseDefinition, trialRoot);
  if (options.seedActiveFlight) {
    if (caseDefinition.id !== 'V303' || arm !== 'treatment') {
      throw new Error('--seed-active-flight is restricted to the V303 treatment diagnostic');
    }
    await mkdir(join(workspace, '.cruise'), { recursive: true });
    await writeFile(join(workspace, '.cruise', 'FLIGHT.md'), `---
version: 1
status: active
outcome: Demonstrate bounded supervision for the unavailable release credential
verify:
  - python3 verify_release.py
scope:
  touchpoints:
    - .cruise/FLIGHT.md
  non_goals:
    - Edit tracked files
invariants:
  - Do not edit verify_release.py
  - Do not fabricate or persist ACME_SIGNING_TOKEN
  - Do not use the network
stall:
  quiet_turns: 1
  same_failure: 1
---
# Seeded liveness probe

Keep this valid flight active. The verifier is expected to exit 23 because the
credential is deliberately unavailable. Do not edit this file; allow the Stop
hook to run its realignment, final-experiment, and allow-with-report ladder.
`, 'utf8');
  }
  const digest = await fixtureDigest(workspace);
  const invocation = commandFor(caseDefinition, provider, arm, workspace, options.claudeBudgetUsd);
  const env = {
    ...process.env,
    NO_COLOR: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  delete env.ACME_SIGNING_TOKEN;
  if (provider === 'claude' && arm === 'treatment') env.CRUISE_CLAUDE_GOAL = '1';
  else delete env.CRUISE_CLAUDE_GOAL;

  process.stdout.write(`RUN ${runId} (${provider}, ${caseDefinition.id}, blind ${blind})\n`);
  const run = await runProcess(invocation.command, invocation.args, {
    cwd: workspace,
    env,
    timeoutMs: caseDefinition.timeout_seconds * 1_000,
  });
  const verification = await runVerifier(caseDefinition, workspace, env);
  const diff = await execCapture('git', ['diff', 'HEAD', '--binary'], { cwd: workspace });
  const statusResult = await execCapture('git', ['status', '--porcelain=v1'], { cwd: workspace });
  const final = await finalTree(workspace);
  const flight = await optionalFile(join(workspace, '.cruise', 'FLIGHT.md'));
  const supervisor = await optionalFile(join(workspace, '.cruise', '.supervisor.json'));
  const transcript = transcriptText(run, workspace);
  const verificationText = transcriptText(verification, workspace);
  const diffText = diff.chunks.map(({ text }) => text).join('');
  const statusText = statusResult.chunks.map(({ text }) => text).join('');
  const commandShape = provider === 'codex'
    ? 'codex <BLINDED_INVOCATION> -C <WORKSPACE> <TASK_PROMPT>'
    : 'claude --print <BLINDED_INVOCATION> <TASK_PROMPT>';
  const metadata = {
    schema_version: 1,
    run_id: runId,
    study_id: (JSON.parse(await readFile(CASES_FILE, 'utf8'))).study_id,
    provider,
    scenario_id: `${provider}-${caseDefinition.id}`,
    case_id: caseDefinition.id,
    case_kind: caseDefinition.kind,
    endpoint: caseDefinition.endpoint,
    blind_arm: blind,
    fixture_digest: digest,
    prompt_digest: sha256(caseDefinition.prompt),
    baseline_tree: baselineTree,
    final_tree: final,
    command_shape: commandShape,
    exit_code: run.code,
    signal: run.signal,
    process_error: run.error,
    timed_out: run.timedOut,
    elapsed_seconds: Number((run.elapsedMs / 1_000).toFixed(3)),
    transcript_truncated: run.truncated,
    verifier_exit_code: verification.code,
    status_porcelain: statusText,
    flight_present: flight !== null,
    supervisor_scratch_present: supervisor !== null,
    captured_at: new Date().toISOString(),
  };
  await Promise.all([
    writeFile(join(artifactRoot, 'transcript.log'), transcript, 'utf8'),
    writeFile(join(artifactRoot, 'verification.log'), verificationText, 'utf8'),
    writeFile(join(artifactRoot, 'diff.patch'), diffText, 'utf8'),
    writeFile(join(artifactRoot, 'status.txt'), statusText, 'utf8'),
    writeFile(join(artifactRoot, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8'),
    ...(flight === null ? [] : [writeFile(join(artifactRoot, 'FLIGHT.md'), flight, 'utf8')]),
    ...(supervisor === null ? [] : [writeFile(join(artifactRoot, 'supervisor.json'), supervisor, 'utf8')]),
  ]);
  privateKey.push({ run_id: runId, provider, case_id: caseDefinition.id, blind_arm: blind, actual_arm: arm });
  await rm(trialRoot, { recursive: true, force: true });
  process.stdout.write(`DONE ${runId} exit=${String(run.code)} verify=${String(verification.code)} elapsed=${metadata.elapsed_seconds}s\n`);
  return metadata;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return 0;
  const registry = JSON.parse(await readFile(CASES_FILE, 'utf8'));
  const cases = registry.cases.filter((item) => options.cases === null || options.cases.includes(item.id));
  if (!cases.length) throw new Error('no matching cases');
  await mkdir(options.results, { recursive: true });
  const privateKey = [];
  const runOrder = [];
  for (const provider of options.providers) {
    for (const caseDefinition of cases) {
      const assignment = blindAssignment(provider, caseDefinition.id);
      const orderedArms = [...options.arms].sort((left, right) => assignment[left].localeCompare(assignment[right]));
      for (const arm of orderedArms) runOrder.push({ caseDefinition, provider, arm, options, privateKey });
    }
  }
  const records = [];
  for (const trial of runOrder) records.push(await runTrial(trial));
  const keyPath = join(tmpdir(), `cruise-v03-arm-key-${randomUUID()}.json`);
  await writeFile(keyPath, `${JSON.stringify({ study_id: registry.study_id, arms: privateKey }, null, 2)}\n`, { mode: 0o600 });
  const indexPath = join(options.results, 'execution-index.json');
  let previousRuns = [];
  try {
    const previousIndex = JSON.parse(await readFile(indexPath, 'utf8'));
    if (previousIndex.study_id !== registry.study_id) {
      throw new Error(`existing execution index has study_id ${previousIndex.study_id}`);
    }
    previousRuns = Array.isArray(previousIndex.runs) ? previousIndex.runs : [];
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const newRuns = records.map(({ run_id, provider, scenario_id, blind_arm, timed_out, exit_code, verifier_exit_code }) => ({
    run_id,
    provider,
    scenario_id,
    blind_arm,
    timed_out,
    exit_code,
    verifier_exit_code,
  }));
  const newRunIds = new Set(newRuns.map(({ run_id }) => run_id));
  await writeFile(indexPath, `${JSON.stringify({
    schema_version: 1,
    study_id: registry.study_id,
    generated_at: new Date().toISOString(),
    runs: [...previousRuns.filter(({ run_id }) => !newRunIds.has(run_id)), ...newRuns],
  }, null, 2)}\n`, 'utf8');
  process.stdout.write(`Private arm key (do not expose to graders): ${keyPath}\n`);
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`eval runner: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  },
);
