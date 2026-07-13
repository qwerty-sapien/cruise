#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { access, lstat, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { AppServerClient } from './lib/app-server-client.mjs';
import { installManagedAgentConfigs, inspectManagedAgentConfigs } from './lib/agent-config.mjs';
import { createLineReader } from './lib/line-input.mjs';
import { normalizeModelCatalog } from './lib/model-policy.mjs';
import { pickOne } from './lib/picker.mjs';
import { CruiseInterruptedError, CruiseSession } from './lib/session.mjs';
import { runWorkerSession } from './lib/worker-session.mjs';
import { WORKER_LEVEL_POLICY } from './lib/worker-policy.mjs';
import { writeYamlFile } from './lib/yaml-state.mjs';

export const CLI_VERSION = '0.1.0';
export const MINIMUM_CODEX_VERSION = '0.144.1';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const SKILLS_ROOT = resolve(PLUGIN_ROOT, 'skills');
const SKILL_PATH = resolve(SKILLS_ROOT, 'goal/SKILL.md');
const MANIFEST_PATH = resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json');
export const PUBLIC_SKILLS = Object.freeze([
  'build',
  'quick',
  'refine',
  'goal',
  'debug',
  'research',
]);

const HELP = `Cruise ${CLI_VERSION} — staged decisions, separate approvals, native Codex Goals

Usage:
  cruise [start] [options] <request...>
  cruise doctor [--json]
  cruise agents install [--codex-home <path>] [--json]
  cruise worker --level <1-7> -C <root> --packet <yaml> --report <yaml>
  cruise picker-demo
  cruise --help

Start options:
  -C, --cwd <path>   Repository to work in (default: current directory)

Interaction:
  Up/Down            Move the highlighted choice
  Enter or Space     Select the highlighted choice
  1-9                Select that option immediately
  q, Esc, Ctrl-C     Cancel the current choice

Examples:
  cruise "Migrate the API without breaking existing clients"
  cruise start -C ~/src/app "Redesign checkout and prove the UX"
  cruise doctor --json

Public skills:
  Starting a project or milestone?       $cruise:build
  Know the exact small change?           $cruise:quick
  Need a finite plan before coding?      $cruise:refine
  Need durable consequential execution?  $cruise:goal
  Have a failure with unknown cause?     $cruise:debug
  Need evidence before deciding?         $cruise:research

Read-only code review remains available through native Codex or GitHub review tools.

This terminal command remains dedicated to Goal execution; invoke $cruise:build in Codex.
Cruise prepares an inactive Goal contract first. Plan approval does not execute.
Only the separate Start Cruise choice activates the same persisted Goal state
used by Codex /goal, with ORIGIN.yaml, ALIGNMENT.md, PLAN.md, and GOAL.md as its contract.
`;

export function parseArgs(argv) {
  const args = [...argv];
  let command = 'start';
  if (['start', 'doctor', 'agents', 'worker', 'picker-demo', 'help'].includes(args[0])) {
    command = args.shift();
  }
  const action = command === 'agents' ? args.shift() : null;

  const options = {
    command,
    cwd: process.cwd(),
    json: false,
    help: false,
    version: false,
    promptParts: [],
    action,
    level: null,
    packet: null,
    report: null,
    codexHome: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      options.promptParts.push(...args.slice(index + 1));
      break;
    }
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '-V' || arg === '--version') {
      options.version = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--level') {
      const value = args[++index];
      if (!value) throw new Error('--level requires a value.');
      options.level = Number(value);
    } else if (arg === '--packet') {
      const value = args[++index];
      if (!value) throw new Error('--packet requires a path.');
      options.packet = resolve(value);
    } else if (arg === '--report') {
      const value = args[++index];
      if (!value) throw new Error('--report requires a path.');
      options.report = resolve(value);
    } else if (arg === '--codex-home') {
      const value = args[++index];
      if (!value) throw new Error('--codex-home requires a path.');
      options.codexHome = resolve(value);
    } else if (arg === '-C' || arg === '--cwd') {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a path.`);
      options.cwd = resolve(value);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (['doctor', 'agents', 'worker'].includes(command)) {
      throw new Error(`Unexpected ${command} argument: ${arg}`);
    } else {
      options.promptParts.push(arg);
    }
  }

  if (options.json && !['doctor', 'agents'].includes(command)) {
    throw new Error('--json is supported only by `cruise doctor` and `cruise agents`.');
  }
  if (command === 'agents' && action !== 'install') throw new Error('agents requires the `install` action.');
  if (command === 'worker' && (!Number.isInteger(options.level) || options.level < 1 || options.level > 7)) {
    throw new Error('worker requires --level from 1 through 7.');
  }
  if (command === 'worker' && (!options.packet || !options.report)) {
    throw new Error('worker requires --packet and --report.');
  }
  return { ...options, prompt: options.promptParts.join(' ') };
}

export async function readLineOnce({
  prompt,
  input = process.stdin,
  output = process.stderr,
  secret = false,
  lineReader = null,
  signal = null,
}) {
  if (secret) {
    throw new Error('Cruise does not echo or collect secret Q&A answers.');
  }
  if (lineReader) {
    const answer = await lineReader.question({ prompt, output, signal });
    if (answer === null || answer === '\u0003' || answer === '\u001b') {
      const error = new Error('Cruise input was cancelled.');
      error.name = 'CruiseInputCancelledError';
      error.code = 'CRUISE_INPUT_CANCELLED';
      error.reason =
        answer === '\u0003'
          ? 'ctrl-c'
          : answer === '\u001b'
            ? 'escape'
            : lineReader.endReason ?? 'eof';
      throw error;
    }
    return answer;
  }
  const readline = createInterface({
    input,
    output,
    terminal: Boolean(input.isTTY && output.isTTY),
  });
  const cancellation = new Promise((_, reject) => {
    readline.once('SIGINT', () => {
      const error = new Error('Cruise input was cancelled with Ctrl-C.');
      error.name = 'CruiseInputCancelledError';
      error.code = 'CRUISE_INPUT_CANCELLED';
      error.reason = 'ctrl-c';
      reject(error);
    });
  });
  let onExternalAbort = null;
  const externalCancellation = new Promise((_, reject) => {
    if (!signal) return;
    onExternalAbort = () => {
      const error = new Error('Cruise input request was resolved elsewhere.');
      error.name = 'CruiseInputCancelledError';
      error.code = 'CRUISE_INPUT_CANCELLED';
      error.reason = String(signal.reason ?? 'resolved');
      reject(error);
    };
    if (signal.aborted) onExternalAbort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  });
  try {
    return await Promise.race([
      readline.question(prompt),
      cancellation,
      externalCancellation,
    ]);
  } finally {
    if (onExternalAbort) signal?.removeEventListener('abort', onExternalAbort);
    readline.close();
  }
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 10_000,
    ...options,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
    error: result.error?.message ?? null,
  };
}

function parseVersion(value) {
  const match = String(value).match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1, 4).map(Number) : null;
}

function versionAtLeast(actual, minimum) {
  const left = parseVersion(actual);
  const right = parseVersion(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return true;
}

function check(id, status, detail) {
  return { id, status, detail };
}

async function findOnPath(name) {
  for (const directory of String(process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH.
    }
  }
  return null;
}

async function probeAppServerSchema() {
  const directory = await mkdtemp(join(tmpdir(), 'cruise-doctor-schema-'));
  try {
    const generated = runCommand('codex', [
      'app-server',
      'generate-json-schema',
      '--experimental',
      '--out',
      directory,
    ]);
    if (generated.status !== 0) {
      return {
        ok: false,
        detail: generated.error || generated.stderr || 'schema generation failed',
      };
    }
    const client = await readFile(join(directory, 'ClientRequest.json'), 'utf8');
    const server = await readFile(join(directory, 'ServerRequest.json'), 'utf8');
    const threadStart = await readFile(join(directory, 'v2', 'ThreadStartParams.json'), 'utf8');
    const turnStart = await readFile(join(directory, 'v2', 'TurnStartParams.json'), 'utf8');
    const requiredClientMethods = [
      'thread/start',
      'thread/goal/get',
      'thread/goal/set',
      'thread/settings/update',
      'turn/start',
      'model/list',
    ];
    const missing = requiredClientMethods.filter((method) => !client.includes(method));
    if (!server.includes('item/tool/requestUserInput')) {
      missing.push('item/tool/requestUserInput');
    }
    if (!threadStart.includes('allowProviderModelFallback') || !threadStart.includes('"model"')) {
      missing.push('thread/start model and fallback controls');
    }
    if (!turnStart.includes('"model"') || !turnStart.includes('"effort"')) {
      missing.push('turn/start model and effort controls');
    }
    return missing.length === 0
      ? { ok: true, detail: 'required Goal, settings, turn, and Q&A RPCs are present' }
      : { ok: false, detail: `missing app-server methods: ${missing.join(', ')}` };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function workerPairLabel(selection) {
  const tier = { luna: 'Luna', terra: 'Terra', sol: 'Sol' }[selection.tier];
  const efforts = {
    medium: 'Medium',
    high: 'High',
    xhigh: 'XHigh',
    ultra: 'Ultra',
  };
  return `${tier} ${efforts[selection.reasoning_effort]}`;
}

/** Evaluate all seven configured worker pairs without mutating the root model. */
export function evaluateWorkerModelCatalog(catalog) {
  let visible;
  try {
    visible = normalizeModelCatalog(catalog).filter((entry) => !entry.hidden);
  } catch (error) {
    return {
      status: 'fail',
      detail: `model/list catalog is invalid (${error.message}); worker selection is blocked`,
    };
  }
  const required = Object.values(WORKER_LEVEL_POLICY);
  const missing = required.filter((selection) => {
    const requestedModel = `gpt-5.6-${selection.tier}`;
    const model = visible.find(
      (entry) => entry.id === requestedModel || entry.model === requestedModel,
    );
    return !model || !model.supportedReasoningEfforts.includes(selection.reasoning_effort);
  });
  const labels = required.map(workerPairLabel);
  return missing.length === 0
    ? {
        status: 'pass',
        detail: `all seven worker pairs are advertised: ${labels.join(', ')}`,
      }
    : {
        status: 'fail',
        detail: `worker selection is blocked; missing ${missing.map(workerPairLabel).join(', ')}`,
      };
}

async function probeModelCatalog() {
  const client = new AppServerClient({
    clientInfo: {
      name: 'cruise-doctor',
      title: 'Cruise Doctor',
      version: CLI_VERSION,
    },
  });
  try {
    await client.start();
    const response = await client.request('model/list', { limit: 100 });
    return evaluateWorkerModelCatalog(response);
  } catch (error) {
    return {
      status: 'fail',
      detail: `model catalog could not be read (${error.message}); worker selection is blocked`,
    };
  } finally {
    await client.stop().catch(() => {});
  }
}

export async function collectDoctorReport() {
  const checks = [];

  checks.push(
    check(
      'node',
      Number(process.versions.node.split('.')[0]) >= 20 ? 'pass' : 'fail',
      `Node ${process.versions.node} (requires >=20)`,
    ),
  );

  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
    const skillDirectories = [];
    for (const entry of await readdir(SKILLS_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        await access(join(SKILLS_ROOT, entry.name, 'SKILL.md'), fsConstants.R_OK);
        skillDirectories.push(entry.name);
      } catch {
        // A resource-only directory is not a public skill.
      }
    }
    skillDirectories.sort();
    const expected = [...PUBLIC_SKILLS].sort();
    if (JSON.stringify(skillDirectories) !== JSON.stringify(expected)) {
      throw new Error(
        `expected exactly ${expected.join(', ')}; found ${skillDirectories.join(', ') || 'none'}`,
      );
    }
    checks.push(
      check(
        'plugin-files',
        'pass',
        `${manifest.name}@${manifest.version}; exactly six public skills are readable`,
      ),
    );
  } catch (error) {
    checks.push(check('plugin-files', 'fail', error.message));
  }

  const version = runCommand('codex', ['--version']);
  if (version.status === 0 && versionAtLeast(version.stdout, MINIMUM_CODEX_VERSION)) {
    checks.push(check('codex-version', 'pass', version.stdout));
  } else {
    checks.push(
      check(
        'codex-version',
        'fail',
        version.error ||
          version.stderr ||
          `${version.stdout || 'Codex not found'}; requires >=${MINIMUM_CODEX_VERSION}`,
      ),
    );
  }

  const appServer = runCommand('codex', ['app-server', '--help']);
  checks.push(
    check(
      'app-server',
      appServer.status === 0 && /--stdio/.test(appServer.stdout) ? 'pass' : 'fail',
      appServer.status === 0
        ? 'stdio app-server is available'
        : appServer.error || appServer.stderr || 'app-server is unavailable',
    ),
  );

  try {
    const protocol = await probeAppServerSchema();
    checks.push(check('app-server-protocol', protocol.ok ? 'pass' : 'fail', protocol.detail));
  } catch (error) {
    checks.push(check('app-server-protocol', 'fail', error.message));
  }

  const modelCatalog = await probeModelCatalog();
  checks.push(check('model-policy', modelCatalog.status, modelCatalog.detail));

  try {
    const agentConfigs = await inspectManagedAgentConfigs();
    const problems = agentConfigs.files.filter(({ status }) => status !== 'current');
    const registrationReady = agentConfigs.registration.status === 'current';
    checks.push(check(
      'agent-configs',
      problems.length === 0 && registrationReady ? 'pass' : 'fail',
      problems.length === 0 && registrationReady
        ? `all seven managed agents are registered by ${agentConfigs.config_path} and current in ${agentConfigs.target_directory}`
        : `${[
            ...problems.map(({ file, status }) => `${file}:${status}`),
            ...(registrationReady ? [] : [`config.toml:${agentConfigs.registration.status}`]),
          ].join(', ')}; run cruise agents install`,
    ));
  } catch (error) {
    checks.push(check('agent-configs', 'fail', error.message));
  }

  const features = runCommand('codex', ['features', 'list']);
  const goalsEnabled = /^goals\s+\S+\s+true\s*$/m.test(features.stdout);
  checks.push(
    check(
      'goals',
      goalsEnabled ? 'pass' : 'fail',
      goalsEnabled
        ? 'native Goals are enabled'
        : features.error || features.stderr || 'native Goals are not enabled',
    ),
  );

  const plugins = runCommand('codex', ['plugin', 'list']);
  const installedMatch = plugins.stdout.match(
    /^cruise@agent-local\s+installed, enabled\s+(\S+)\s+/m,
  );
  const installed = Boolean(installedMatch);
  const installedVersion = installedMatch?.[1] ?? null;
  const expectedVersion = manifest?.version ?? null;
  checks.push(
    check(
      'global-plugin',
      installed && installedVersion === expectedVersion ? 'pass' : 'fail',
      installed && installedVersion === expectedVersion
        ? `cruise@agent-local ${installedVersion} is installed`
        : installed
          ? `installed ${installedVersion}, but source is ${expectedVersion}; refresh with codex plugin remove cruise@agent-local && codex plugin add cruise@agent-local`
          : plugins.error || plugins.stderr || 'cruise@agent-local is not installed',
    ),
  );

  if (expectedVersion) {
    const cachedRoot = join(
      homedir(),
      '.codex',
      'plugins',
      'cache',
      'agent-local',
      'cruise',
      expectedVersion,
      'skills',
    );
    try {
      for (const skill of PUBLIC_SKILLS) {
        await access(join(cachedRoot, skill, 'SKILL.md'), fsConstants.R_OK);
      }
      checks.push(check('cached-public-skills', 'pass', cachedRoot));
    } catch (error) {
      checks.push(check(
        'cached-public-skills',
        'fail',
        `${error.message}; refresh the cached snapshot with codex plugin remove cruise@agent-local && codex plugin add cruise@agent-local`,
      ));
    }
  }

  const clientOnPath = await findOnPath('cruise');
  checks.push(
    check(
      'client-on-path',
      clientOnPath ? 'pass' : 'fail',
      clientOnPath ?? 'cruise is not executable on PATH',
    ),
  );

  let resolvedScript = SCRIPT_PATH;
  try {
    resolvedScript = await realpath(SCRIPT_PATH);
  } catch {
    // The source path above is still useful in diagnostics.
  }
  checks.push(check('client', 'pass', `Cruise client ${CLI_VERSION} at ${resolvedScript}`));

  return {
    ok: checks.every(({ status }) => status !== 'fail'),
    cruiseVersion: CLI_VERSION,
    minimumCodexVersion: MINIMUM_CODEX_VERSION,
    checks,
  };
}

async function runDoctor({ json }) {
  const report = await collectDoctorReport();
  if (json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    for (const item of report.checks) {
      const marker = item.status === 'pass' ? 'ok' : item.status;
      process.stdout.write(`${marker.padEnd(5)} ${item.id}: ${item.detail}\n`);
    }
    process.stdout.write(
      report.ok ? 'Cruise is ready.\n' : 'Cruise doctor found blocking issues.\n',
    );
  }
  return report.ok ? 0 : 1;
}

async function runPickerDemo() {
  const selected = await pickOne({
    title: 'Cruise picker demo',
    options: [
      'Recommended path',
      'Alternative path',
      'Save and stop',
    ],
  });
  if (selected.status === 'selected') {
    process.stdout.write(`Selected ${selected.index + 1}: ${selected.label}\n`);
    return 0;
  }
  process.stdout.write(`Cancelled: ${selected.reason}\n`);
  return 130;
}

async function runAgents(options) {
  const result = await installManagedAgentConfigs({ codexHome: options.codexHome });
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`Registered ${result.files.length} Cruise agents in ${result.config_path}; configs ${result.target_directory}; changed ${result.changed.length}.\n`);
  return 0;
}

async function readWorkerPacket(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('worker packet must be a regular file');
  if (metadata.size > 4 * 1024 * 1024) throw new Error('worker packet exceeds 4194304 bytes');
  return readFile(path, 'utf8');
}

async function runWorker(options) {
  const cwd = await validateWorkingDirectory(options.cwd);
  const packet = await readWorkerPacket(options.packet);
  const report = await runWorkerSession({ level: options.level, cwd, packet });
  await writeYamlFile(options.report, report);
  process.stdout.write(`Worker ${report.launch.agent_type} completed; report ${options.report}\n`);
  return 0;
}

async function validateWorkingDirectory(cwd) {
  const metadata = await stat(cwd);
  if (!metadata.isDirectory()) throw new Error(`Not a directory: ${cwd}`);
  return realpath(cwd);
}

async function runStart(options) {
  const cwd = await validateWorkingDirectory(options.cwd);
  const lineReader =
    process.stdin.isTTY && process.stderr.isTTY
      ? null
      : createLineReader({ input: process.stdin });
  const client = new AppServerClient({
    spawnOptions: { cwd },
    clientInfo: {
      name: 'cruise',
      title: 'Cruise',
      version: CLI_VERSION,
    },
    onError(error) {
      process.stderr.write(`Cruise protocol warning: ${error.message}\n`);
    },
  });
  const session = new CruiseSession({
    client,
    cwd,
    prompt: options.prompt,
    skillPath: SKILL_PATH,
    pickOne,
    readLine: readLineOnce,
    lineReader,
  });

  let interrupted = false;
  const onSigint = () => {
    if (interrupted) return;
    interrupted = true;
    process.stderr.write('\nPausing Cruise…\n');
    void session.interrupt();
  };
  process.on('SIGINT', onSigint);
  try {
    const result = await session.run();
    if (result.status === 'complete' || result.status === 'saved') return 0;
    return result.status === 'paused' ? 130 : 2;
  } catch (error) {
    if (error instanceof CruiseInterruptedError || interrupted) return 130;
    throw error;
  } finally {
    process.removeListener('SIGINT', onSigint);
    lineReader?.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`cruise: ${error.message}\nTry 'cruise --help'.\n`);
    return 2;
  }

  if (options.version) {
    process.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }
  if (options.help || options.command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  try {
    if (options.command === 'doctor') return await runDoctor(options);
    if (options.command === 'agents') return await runAgents(options);
    if (options.command === 'worker') return await runWorker(options);
    if (options.command === 'picker-demo') return await runPickerDemo();
    return await runStart(options);
  } catch (error) {
    process.stderr.write(`cruise: ${error.message}\n`);
    return 1;
  }
}

async function invokedAsMain() {
  if (!process.argv[1]) return false;
  const entryPath = await realpath(process.argv[1]).catch(() => resolve(process.argv[1]));
  const modulePath = await realpath(SCRIPT_PATH).catch(() => SCRIPT_PATH);
  return entryPath === modulePath;
}

if (await invokedAsMain()) {
  process.exitCode = await main();
}
