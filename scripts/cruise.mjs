#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { AppServerClient } from './lib/app-server-client.mjs';
import { appServerDiagnostic, createIsolatedAppServerRuntime } from './lib/app-server-runtime.mjs';
import { createDeadline, waitForCleanup } from './lib/deadline.mjs';
import { installManagedAgentConfigs, inspectManagedAgentConfigs } from './lib/agent-config.mjs';
import {
  CRUISE_CLASSES,
  readCruiseClass,
  writeCruiseClass,
} from './lib/cruise-class.mjs';
import {
  COMMUNICATION_STYLES,
  readCommunicationStyle,
  writeCommunicationStyle,
} from './lib/communication-style.mjs';
import { createLineReader } from './lib/line-input.mjs';
import {
  inspectWorkerHostRule,
  installWorkerHostRule,
} from './lib/doctor-host-rule.mjs';
import { runDeepDoctor, runTroubleshootDoctor } from './lib/doctor-e2e.mjs';
import {
  digestPluginRuntime,
  inspectPluginCache,
  pluginDigestDetail,
  resolvePluginCacheRoot,
} from './lib/doctor-plugin-cache.mjs';
import {
  bindForeignDiffWorkerPacket,
  checkForForeignDiff,
  foreignDiffAuthorityPath,
  readForeignDiffGuardState,
} from './lib/foreign-diff-guard.mjs';
import { withHostAuthorityLock } from './lib/host-authority-lock.mjs';
import {
  installGitUpdateHooks,
  runAutomaticGitUpdate,
} from './lib/git-update.mjs';
import { MODEL_IDS, normalizeModelCatalog } from './lib/model-policy.mjs';
import { validateOriginRecord } from './lib/origin.mjs';
import { pickOne } from './lib/picker.mjs';
import { CruiseInterruptedError, CruiseSession } from './lib/session.mjs';
import { CruiseSkillSession } from './lib/skill-session.mjs';
import { userFacingError } from './lib/user-facing-output.mjs';
import {
  assertSemanticMappingPacket,
  SEMANTIC_MAPPING_PACKET_KIND,
} from './lib/semantic-mapping-packet.mjs';
import { repositoryBaselineDigest } from './lib/routing.mjs';
import {
  createWorkerFailureReport,
  runWorkerSession,
} from './lib/worker-session.mjs';
import {
  admitWorkerAttempt,
  assertExpectedWorkerOutput,
  assertWorkerControlSnapshot,
  bindWorkerAttemptReport,
  commitWorkerReportNoClobber,
  completeWorkerAttempt,
} from './lib/worker-attempt.mjs';
import { WORKER_LEVEL_POLICY } from './lib/worker-policy.mjs';
import { parseYaml, readYamlFile, writeYamlFile } from './lib/yaml-state.mjs';

export const CLI_VERSION = '0.1.0';
export const MINIMUM_CODEX_VERSION = '0.144.1';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const SKILLS_ROOT = resolve(PLUGIN_ROOT, 'skills');
const GOAL_SKILL_PATH = resolve(SKILLS_ROOT, 'goal/SKILL.md');
const MANIFEST_PATH = resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json');
export const PUBLIC_SKILLS = Object.freeze([
  'build',
  'quick',
  'refine',
  'goal',
  'debug',
  'research',
]);

export function pluginRuntimeStayedStable({
  initialDigest,
  inspection,
  snapshotInitialDigest,
  snapshotFinal,
}) {
  if (typeof initialDigest !== 'string' || initialDigest.length === 0) return false;
  return inspection?.matches === true
    && inspection.source?.digest === initialDigest
    && inspection.cache?.digest === initialDigest
    && snapshotInitialDigest === initialDigest
    && snapshotFinal?.digest === initialDigest;
}

const HELP = `Cruise ${CLI_VERSION} — plan, review, and carry out work with Codex

Usage:
  cruise [start] [options] <request...>
  cruise <build|quick|refine|goal|debug|research> [options] <request...>
  cruise doctor [--json] [--deep|--troubleshoot] [--fixture <path>] [--install-worker-rule]
  cruise config style [default|professional|friendly]
  cruise config style --show [--json]
  cruise config class
  cruise config class --show [--json]
  cruise agents install [--codex-home <path>] [--json]
  cruise hooks install [-C <cruise-source>] [--json]
  cruise hooks run --event <post-merge|post-rewrite|post-checkout> -C <cruise-source> [--json]
  cruise worker --level <1-7> -C <root> --packet <yaml> --packet-sha256 <sha256> --report <yaml>
  cruise picker-demo
  cruise --help

Start options:
  -C, --cwd <path>   Repository to work in (default: current directory)
  --auto-approve     Build only: approve the exact reviewed planning contract from Origin

Interaction:
  Up/Down            Move the highlighted choice
  Enter or Space     Select the highlighted choice
  1-9                Select that option immediately
  q, Esc, Ctrl-C     Cancel the current choice

Examples:
  cruise "Migrate the API without breaking existing clients"
  cruise build -C ~/src/app "Plan the next release"
  cruise refine -C ~/src/app "Add bounded retry handling"
  cruise goal -C ~/src/app "Migrate the API without breaking clients"
  cruise start -C ~/src/app "Redesign checkout and prove the UX"
  cruise doctor --json
  cruise doctor --deep --install-worker-rule
  cruise doctor --troubleshoot --fixture ./my-fixture
  cruise config style

Doctor:
  --deep                 Run six rapid installed-skill probes in one warm conversation
  --troubleshoot         Run exhaustive real workflows without a liveness timeout
  --fixture <path>       Use another disposable repository for troubleshooting
  --install-worker-rule  Install the exact scoped host rule required by Cruise workers

Public skills:
  Starting a project or milestone?       $cruise:build
  Know the exact small change?           $cruise:quick
  Need a finite plan before coding?      $cruise:refine
  Need durable consequential execution?  $cruise:goal
  Have a failure with unknown cause?     $cruise:debug
  Need evidence before deciding?         $cruise:research

Read-only code review remains available through native Codex or GitHub review tools.

The skill subcommands keep one Codex task and switch Default/Plan automatically.
Unprefixed requests remain a backwards-compatible alias for cruise goal.
For larger work, Cruise saves a plan and asks for a separate confirmation before starting.
`;

export function parseArgs(argv) {
  const args = [...argv];
  let command = 'start';
  if (['start', ...PUBLIC_SKILLS, 'doctor', 'config', 'agents', 'hooks', 'worker', 'picker-demo', 'help'].includes(args[0])) {
    command = args.shift();
  }
  const action = ['config', 'agents', 'hooks'].includes(command) ? args.shift() : null;
  const configValue = command === 'config'
    && action === 'style'
    && args[0]
    && !args[0].startsWith('-')
    ? args.shift()
    : null;

  const options = {
    command,
    skill: PUBLIC_SKILLS.includes(command) ? command : 'goal',
    cwd: process.cwd(),
    json: false,
    help: false,
    version: false,
    promptParts: [],
    action,
    level: null,
    packet: null,
    packetSha256: null,
    report: null,
    codexHome: null,
    deep: false,
    troubleshoot: false,
    fixture: null,
    installWorkerRule: false,
    autoApprove: false,
    event: null,
    show: false,
    configValue,
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
    } else if (arg === '--show') {
      options.show = true;
    } else if (arg === '--deep') {
      options.deep = true;
    } else if (arg === '--troubleshoot') {
      options.troubleshoot = true;
    } else if (arg === '--install-worker-rule') {
      options.installWorkerRule = true;
    } else if (arg === '--auto-approve') {
      options.autoApprove = true;
    } else if (arg === '--event') {
      const value = args[++index];
      if (!value) throw new Error('--event requires a value.');
      options.event = value;
    } else if (arg === '--fixture') {
      const value = args[++index];
      if (!value) throw new Error('--fixture requires a path.');
      options.fixture = resolve(value);
    } else if (arg === '--level') {
      const value = args[++index];
      if (!value) throw new Error('--level requires a value.');
      options.level = Number(value);
    } else if (arg === '--packet') {
      const value = args[++index];
      if (!value) throw new Error('--packet requires a path.');
      options.packet = resolve(value);
    } else if (arg === '--packet-sha256') {
      const value = args[++index];
      if (!value) throw new Error('--packet-sha256 requires a value.');
      options.packetSha256 = value;
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
    } else if (['doctor', 'config', 'agents', 'hooks', 'worker'].includes(command)) {
      throw new Error(`Unexpected ${command} argument: ${arg}`);
    } else {
      options.promptParts.push(arg);
    }
  }

  if (options.json && !['doctor', 'config', 'agents', 'hooks'].includes(command)) {
    throw new Error('--json is supported only by `cruise doctor`, `cruise config`, `cruise agents`, and `cruise hooks`.');
  }
  if ((options.deep || options.troubleshoot || options.fixture || options.installWorkerRule) && command !== 'doctor') {
    throw new Error('--deep, --troubleshoot, --fixture, and --install-worker-rule are supported only by `cruise doctor`.');
  }
  if (options.autoApprove && command !== 'build') {
    throw new Error('--auto-approve is supported only by `cruise build`.');
  }
  if (options.event !== null && command !== 'hooks') {
    throw new Error('--event is supported only by `cruise hooks run`.');
  }
  if (options.show && command !== 'config') {
    throw new Error('--show is supported only by `cruise config`.');
  }
  if (options.deep && options.troubleshoot) {
    throw new Error('--deep and --troubleshoot are mutually exclusive.');
  }
  if (options.fixture && !options.troubleshoot) {
    throw new Error('--fixture requires `cruise doctor --troubleshoot`.');
  }
  if (command === 'agents' && action !== 'install') throw new Error('agents requires the `install` action.');
  if (command === 'config' && !['class', 'style'].includes(action)) {
    throw new Error('config requires the `style` or `class` action.');
  }
  if (command === 'config' && options.json && !options.show) {
    throw new Error(`\`cruise config ${action} --json\` requires --show.`);
  }
  if (command === 'config' && action !== 'style' && options.configValue !== null) {
    throw new Error('Only `cruise config style` accepts a style value.');
  }
  if (command === 'config' && options.show && options.configValue !== null) {
    throw new Error('Choose a style or use --show, not both.');
  }
  if (command === 'hooks' && !['install', 'run'].includes(action)) {
    throw new Error('hooks requires the `install` or `run` action.');
  }
  if (command === 'hooks' && action === 'run' && !['post-merge', 'post-rewrite', 'post-checkout'].includes(options.event)) {
    throw new Error('hooks run requires --event post-merge, post-rewrite, or post-checkout.');
  }
  if (command === 'hooks' && action === 'install' && options.event !== null) {
    throw new Error('--event is supported only by `cruise hooks run`.');
  }
  if (command === 'worker' && (!Number.isInteger(options.level) || options.level < 1 || options.level > 7)) {
    throw new Error('worker requires --level from 1 through 7.');
  }
  if (command === 'worker' && (!options.packet || !options.report || !/^[a-f0-9]{64}$/u.test(options.packetSha256 ?? ''))) {
    throw new Error('worker requires --packet, --packet-sha256, and --report.');
  }
  const prompt = options.promptParts.join(' ');
  return {
    ...options,
    prompt: options.autoApprove ? `--auto-approve\n\n${prompt}` : prompt,
  };
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

async function findOnPath(name, pathValue = process.env.PATH) {
  for (const directory of String(pathValue ?? '').split(delimiter)) {
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

export async function inspectPathClient({
  entrypoint = SCRIPT_PATH,
  pathValue = process.env.PATH,
} = {}) {
  const candidate = await findOnPath('cruise', pathValue);
  if (!candidate) {
    return check('client-on-path', 'fail', 'cruise is not executable on PATH');
  }

  let expected;
  let actual;
  try {
    [expected, actual] = await Promise.all([
      realpath(entrypoint),
      realpath(candidate),
    ]);
  } catch (error) {
    return check(
      'client-on-path',
      'fail',
      `could not resolve the Cruise PATH entry ${candidate} (${error.message})`,
    );
  }

  if (actual !== expected) {
    return check(
      'client-on-path',
      'fail',
      `${candidate} resolves to ${actual}, not the running Cruise entrypoint ${expected}; reinstall the CLI link`,
    );
  }
  return check(
    'client-on-path',
    'pass',
    `${candidate} resolves to the running Cruise entrypoint ${expected}`,
  );
}

export async function assertWorkerRuntimeReadiness({
  codexHome = null,
  entrypoint = SCRIPT_PATH,
  sourceRoot = PLUGIN_ROOT,
  manifestPath = MANIFEST_PATH,
  pathValue = process.env.PATH,
} = {}) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (cause) {
    throw new Error('worker readiness could not read the Cruise plugin manifest', { cause });
  }
  const cacheRoot = resolvePluginCacheRoot({ codexHome, version: manifest.version });
  const inspection = await inspectPluginCache({
    sourceRoot,
    cacheRoot,
    enforceInstalledIdentity: true,
    codexHome,
  });
  if (!inspection.matches) {
    throw new Error(`worker readiness failed installed-plugin-digest: ${pluginDigestDetail(inspection)}`);
  }
  const client = await inspectPathClient({ entrypoint, pathValue });
  if (client.status !== 'pass') {
    throw new Error(`worker readiness failed client-on-path: ${client.detail}`);
  }
  const rule = await inspectWorkerHostRule({ codexHome, entrypoint });
  if (rule.status !== 'current') {
    throw new Error(`worker readiness failed worker-host-rule: ${rule.detail}`);
  }
  return Object.freeze({
    pluginRuntimeDigest: inspection.source.digest,
    cacheRoot,
    entrypoint: resolve(entrypoint),
    rulePath: rule.path,
  });
}

export function inspectWorkspaceWriteNetworkContract(schema) {
  const sandbox = schema?.definitions?.SandboxPolicy ?? schema?.$defs?.SandboxPolicy;
  const variants = Array.isArray(sandbox?.oneOf) ? sandbox.oneOf : [];
  const workspaceWrite = variants.find((variant) => (
    variant?.properties?.type?.enum?.includes('workspaceWrite')
  ));
  if (!workspaceWrite) {
    return Object.freeze({ ok: false, detail: 'workspaceWrite sandbox schema is missing' });
  }
  if ((workspaceWrite.required ?? []).includes('networkAccess')) {
    return Object.freeze({ ok: false, detail: 'workspaceWrite networkAccess became required' });
  }
  const networkAccess = workspaceWrite.properties?.networkAccess;
  if (networkAccess?.type !== 'boolean' || networkAccess.default !== false) {
    return Object.freeze({
      ok: false,
      detail: 'workspaceWrite networkAccess omission no longer has the verified boolean false default',
    });
  }
  return Object.freeze({
    ok: true,
    detail: 'workspaceWrite networkAccess is optional and defaults to false',
  });
}

async function probeAppServerSchema({ codexHome = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cruise-doctor-schema-'));
  let runtime = null;
  try {
    runtime = await createIsolatedAppServerRuntime({ codexHome, extensionProfile: 'worker' });
    const generated = runCommand('codex', [
      'app-server',
      'generate-json-schema',
      '--experimental',
      '--out',
      directory,
    ], { env: runtime.spawnOptions.env });
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
    const networkContract = inspectWorkspaceWriteNetworkContract(JSON.parse(turnStart));
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
    if (!networkContract.ok) missing.push(networkContract.detail);
    return missing.length === 0
      ? { ok: true, detail: `required Goal, settings, turn, and Q&A RPCs are present; ${networkContract.detail}` }
      : { ok: false, detail: `missing app-server methods: ${missing.join(', ')}` };
  } finally {
    await runtime?.dispose().catch(() => {});
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
    const requiredModel = MODEL_IDS[selection.tier];
    const model = visible.find(
      (entry) => entry.id === requiredModel || entry.model === requiredModel,
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

export async function probeModelCatalog({
  timeoutMs = 15_000,
  codexHome = null,
  runtimeFactory = createIsolatedAppServerRuntime,
  clientFactory = (options) => new AppServerClient(options),
} = {}) {
  const deadline = createDeadline(timeoutMs, 'Doctor model catalog probe');
  let runtime = null;
  let client = null;
  let rejectFatal;
  const fatal = new Promise((_, reject) => {
    rejectFatal = reject;
  });
  void fatal.catch(() => {});
  const stderr = [];
  const onStderr = (chunk) => {
    stderr.push(String(chunk));
    while (stderr.join('').length > 8 * 1024) stderr.shift();
  };
  const onExit = (info = {}) => {
    rejectFatal(info.error ?? new Error('app-server exited during Doctor model catalog probe'));
  };
  try {
    runtime = await deadline.run(
      'isolated runtime setup',
      () => runtimeFactory({ codexHome, extensionProfile: 'worker' }),
    );
    client = clientFactory({
      args: ['app-server', '--stdio', ...runtime.appServerArgs],
      spawnOptions: runtime.spawnOptions,
      clientInfo: {
        name: 'cruise-doctor',
        title: 'Cruise Doctor',
        version: CLI_VERSION,
      },
      onError(error, clientInstance) {
        rejectFatal(error);
        void clientInstance.stop().catch(() => {});
      },
    });
    client.on('stderr', onStderr);
    client.on('exit', onExit);
    const signals = [fatal];
    await deadline.run('app-server start', () => client.start(), { signals });
    const response = await deadline.run(
      'model/list',
      () => client.request('model/list', { limit: 100 }),
      { signals },
    );
    return evaluateWorkerModelCatalog(response);
  } catch (error) {
    const diagnostic = appServerDiagnostic(stderr.join(''));
    return {
      status: 'fail',
      detail: `model catalog could not be read (${error.message}${diagnostic ? `; ${diagnostic}` : ''}); worker selection is blocked`,
    };
  } finally {
    client?.removeListener('stderr', onStderr);
    client?.removeListener('exit', onExit);
    const cleanupTimeoutMs = Math.min(timeoutMs, 1_000);
    if (client) {
      await waitForCleanup(
        () => client.stop({ timeoutMs: Math.min(timeoutMs, 500) }),
        cleanupTimeoutMs,
      );
    }
    if (runtime) {
      await waitForCleanup(() => runtime.dispose(), cleanupTimeoutMs);
    }
  }
}

export async function collectDoctorReport({ codexHome = null } = {}) {
  const checks = [];
  let pluginRuntimeDigest = null;
  const cruiseClass = await readCruiseClass({ codexHome });
  const codexCommandOptions = codexHome
    ? { env: { ...process.env, CODEX_HOME: codexHome } }
    : {};

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

  const version = runCommand('codex', ['--version'], codexCommandOptions);
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

  const appServer = runCommand('codex', ['app-server', '--help'], codexCommandOptions);
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
    const protocol = await probeAppServerSchema({ codexHome });
    checks.push(check('app-server-protocol', protocol.ok ? 'pass' : 'fail', protocol.detail));
  } catch (error) {
    checks.push(check('app-server-protocol', 'fail', error.message));
  }

  const modelCatalog = await probeModelCatalog({ codexHome });
  checks.push(check('model-policy', modelCatalog.status, modelCatalog.detail));

  try {
    const workerRule = await inspectWorkerHostRule({ codexHome, entrypoint: SCRIPT_PATH });
    let policyCheck = null;
    if (workerRule.status === 'current') {
      policyCheck = runCommand('codex', [
        'execpolicy',
        'check',
        '--rules',
        workerRule.path,
        SCRIPT_PATH,
        'worker',
        '--level',
        '2',
        '-C',
        '/doctor-fixture',
        '--packet',
        '/doctor-fixture/packet.yaml',
        '--packet-sha256',
        '0'.repeat(64),
        '--report',
        '/doctor-fixture/report.yaml',
      ], codexCommandOptions);
    }
    let recognized = false;
    if (policyCheck?.status === 0) {
      try {
        recognized = JSON.parse(policyCheck.stdout).decision === 'allow';
      } catch {
        recognized = false;
      }
    }
    checks.push(check(
      'worker-host-rule',
      workerRule.status === 'current' && recognized ? 'pass' : 'fail',
      workerRule.status === 'current' && recognized
        ? `${workerRule.detail} and Codex recognizes it (${workerRule.path})`
        : workerRule.status === 'current'
          ? `Codex did not recognize the scoped worker rule (${policyCheck?.stderr || policyCheck?.error || workerRule.path})`
        : `${workerRule.detail}; run cruise doctor --deep --install-worker-rule`,
    ));
  } catch (error) {
    checks.push(check('worker-host-rule', 'fail', error.message));
  }

  try {
    const agentConfigs = await inspectManagedAgentConfigs({ codexHome });
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

  const features = runCommand('codex', ['features', 'list'], codexCommandOptions);
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

  const plugins = runCommand('codex', ['plugin', 'list'], codexCommandOptions);
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

  const pluginCacheRoot = expectedVersion
    ? resolvePluginCacheRoot({ codexHome, version: expectedVersion })
    : null;
  if (pluginCacheRoot) {
    try {
      const inspection = await inspectPluginCache({
        sourceRoot: PLUGIN_ROOT,
        cacheRoot: pluginCacheRoot,
        enforceInstalledIdentity: true,
        codexHome,
      });
      checks.push(check(
        'installed-plugin-digest',
        inspection.matches ? 'pass' : 'fail',
        inspection.matches
          ? `${pluginDigestDetail(inspection)} at ${pluginCacheRoot}`
          : `${pluginDigestDetail(inspection)}; reinstall cruise@agent-local before running skills`,
      ));
      if (inspection.matches) pluginRuntimeDigest = inspection.source.digest;
    } catch (error) {
      checks.push(check(
        'installed-plugin-digest',
        'fail',
        `${error.message}; reinstall with codex plugin remove cruise@agent-local && codex plugin add cruise@agent-local`,
      ));
    }
  }

  let resolvedScript = SCRIPT_PATH;
  try {
    resolvedScript = await realpath(SCRIPT_PATH);
  } catch {
    // The source path above is still useful in diagnostics.
  }
  checks.push(await inspectPathClient({ entrypoint: resolvedScript }));
  checks.push(check('client', 'pass', `Cruise client ${CLI_VERSION} at ${resolvedScript}`));

  return {
    ok: checks.every(({ status }) => status !== 'fail'),
    cruiseVersion: CLI_VERSION,
    minimumCodexVersion: MINIMUM_CODEX_VERSION,
    cruiseClass,
    pluginCacheRoot,
    pluginRuntimeDigest,
    workerExecutable: SCRIPT_PATH,
    checks,
  };
}

async function runDoctor({
  json,
  deep,
  troubleshoot,
  fixture,
  installWorkerRule,
  codexHome,
}) {
  let installation = null;
  if (installWorkerRule) {
    installation = await installWorkerHostRule({ codexHome, entrypoint: SCRIPT_PATH });
  }
  const report = await collectDoctorReport({ codexHome });
  const profile = deep ? 'deep' : troubleshoot ? 'troubleshoot' : null;
  if (profile) {
    if (!report.ok) {
      report[profile] = {
        ok: false,
        skipped: true,
        detail: `${profile === 'deep' ? 'Deep smoke probes' : 'Troubleshooting workflows'} require all static readiness checks to pass first.`,
      };
    } else {
      const profileReport = await (profile === 'deep' ? runDeepDoctor : runTroubleshootDoctor)({
        ...(profile === 'troubleshoot' ? { fixture: fixture ?? undefined } : {}),
        codexHome,
        installedPluginRoot: report.pluginCacheRoot,
        workerExecutable: report.workerExecutable,
        onProgress(message) {
          if (!json) process.stderr.write(`${message}\n`);
        },
      });
      report.checks.push(...profileReport.checks);
      let stable = false;
      try {
        const [inspection, snapshot] = await Promise.all([
          inspectPluginCache({
            sourceRoot: PLUGIN_ROOT,
            cacheRoot: report.pluginCacheRoot,
            enforceInstalledIdentity: true,
            codexHome,
          }),
          digestPluginRuntime(profileReport.installedPluginSnapshot),
        ]);
        stable = pluginRuntimeStayedStable({
          initialDigest: report.pluginRuntimeDigest,
          inspection,
          snapshotInitialDigest: profileReport.installedPluginSnapshotDigest?.digest,
          snapshotFinal: snapshot,
        });
        report.checks.push(check(
          'installed-plugin-stability',
          stable ? 'pass' : 'fail',
          stable
            ? `source, installed cache, and pinned snapshot retained the initial ${profile} digest (${report.pluginRuntimeDigest})`
            : `${pluginDigestDetail(inspection)}; initial ${report.pluginRuntimeDigest ?? 'unavailable'}, snapshot start ${profileReport.installedPluginSnapshotDigest?.digest ?? 'unavailable'}, final source ${inspection.source.digest}, final cache ${inspection.cache.digest}, snapshot end ${snapshot.digest}; the plugin changed while ${profile} was running`,
        ));
      } catch (error) {
        report.checks.push(check(
          'installed-plugin-stability',
          'fail',
          `${error.message}; the pinned installed snapshot disappeared or changed during ${profile}`,
        ));
      }
      report.ok = report.ok && profileReport.ok && stable;
      const retainFailureEvidence = !(profileReport.ok && stable);
      if (!retainFailureEvidence) {
        await rm(profileReport.workspace, { recursive: true, force: true });
      }
      report[profile] = {
        ok: profileReport.ok && stable,
        fixture: profileReport.fixture,
        workspace: retainFailureEvidence ? profileReport.workspace : null,
        installedPluginRoot: profileReport.installedPluginRoot,
        installedPluginSnapshot: retainFailureEvidence ? profileReport.installedPluginSnapshot : null,
        installedPluginSnapshotDigest: profileReport.installedPluginSnapshotDigest.digest,
        ...(profileReport.conversation ? { conversation: profileReport.conversation } : {}),
      };
    }
  }
  if (installation) {
    report.workerRuleInstallation = installation;
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    for (const item of report.checks) {
      const marker = item.status === 'pass' ? 'ok' : item.status;
      process.stdout.write(`${marker.padEnd(5)} ${item.id}: ${item.detail}\n`);
    }
    if (profile && report[profile]?.ok !== true && report[profile]?.workspace) {
      process.stdout.write(`Retained ${profile} failure evidence: ${report[profile].workspace}\n`);
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

async function runConfig(options) {
  if (options.action === 'style') {
    if (options.show) {
      const current = await readCommunicationStyle({ codexHome: options.codexHome });
      if (options.json) process.stdout.write(`${JSON.stringify(current)}\n`);
      else process.stdout.write(`${current.style}: ${current.label}\n`);
      return 0;
    }

    const current = await readCommunicationStyle({ codexHome: options.codexHome });
    let selectedStyle = options.configValue;
    if (selectedStyle === null) {
      const selected = await pickOne({
        title: `Writing style (current: ${current.label})`,
        options: Object.values(COMMUNICATION_STYLES).map((style) => ({
          label: style.label,
          description: style.description,
          value: style.id,
        })),
      });
      if (selected.status !== 'selected') {
        process.stdout.write(`Writing style unchanged: ${current.label}.\n`);
        return 130;
      }
      selectedStyle = selected.value;
    }
    const saved = await writeCommunicationStyle(selectedStyle, { codexHome: options.codexHome });
    process.stdout.write(`Writing style set to ${saved.label}.\n`);
    return 0;
  }

  if (options.show) {
    const current = await readCruiseClass({ codexHome: options.codexHome });
    if (options.json) process.stdout.write(`${JSON.stringify(current)}\n`);
    else {
      process.stdout.write(
        `${current.cruise_class}: level ${current.default_level} (${current.default_alias})\n`,
      );
    }
    return 0;
  }

  const current = await readCruiseClass({ codexHome: options.codexHome });
  const order = ['normal-cruise', 'premium-cruise', 'luxury-cruise', 'budget-cruise'];
  const selected = await pickOne({
    title: `Cruise class (current: ${current.cruise_class})`,
    options: order.map((id) => {
      const definition = CRUISE_CLASSES[id];
      const suffix = id === 'normal-cruise' ? ' — recommended default' : '';
      return {
        label: `${definition.label} — level ${definition.default_level}${suffix}`,
        value: id,
      };
    }),
  });
  if (selected.status !== 'selected') {
    process.stdout.write(`Cruise class unchanged: ${current.cruise_class}.\n`);
    return 130;
  }
  const saved = await writeCruiseClass(selected.value, { codexHome: options.codexHome });
  process.stdout.write(
    `Cruise class set to ${saved.cruise_class}: level ${saved.default_level} (${saved.default_alias}). `
      + 'Native Cruise uses it for the host and subagents; Codex CLI/GUI uses it for subagents only.\n',
  );
  return 0;
}

async function runAgents(options) {
  const result = await installManagedAgentConfigs({ codexHome: options.codexHome });
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`Registered ${result.files.length} Cruise agents in ${result.config_path}; configs ${result.target_directory}; changed ${result.changed.length}.\n`);
  return 0;
}

async function runHooks(options) {
  const cwd = await validateWorkingDirectory(options.cwd);
  if (options.action === 'install') {
    const result = await installGitUpdateHooks({ repositoryRoot: cwd });
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      process.stdout.write(
        `Installed Cruise update hooks in ${result.repository_hooks} and Git template ${result.template_root}.\n`,
      );
    }
    return 0;
  }
  const result = await runAutomaticGitUpdate({
    repositoryRoot: cwd,
    event: options.event,
  });
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

export async function readWorkerPacket(path, { expectedSha256 = null } = {}) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('worker packet must be a regular file');
  if (metadata.size > 4 * 1024 * 1024) throw new Error('worker packet exceeds 4194304 bytes');
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (after.isSymbolicLink() || !after.isFile() || after.dev !== metadata.dev || after.ino !== metadata.ino || after.size !== metadata.size) {
    throw new Error('worker packet changed while reading');
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (expectedSha256 !== null && digest !== expectedSha256) {
    throw new Error('worker packet bytes differ from --packet-sha256; inference remains paused');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error('worker packet must contain valid UTF-8', { cause });
  }
}

function exactRunChild(root, candidate, label, namePattern) {
  const path = relative(root, candidate);
  const parts = path.split(sep);
  if (
    path.startsWith(`..${sep}`)
    || path === '..'
    || parts.length !== 4
    || parts[0] !== '.cruise'
    || parts[1] !== 'runs'
    || !parts[2]
    || !namePattern.test(parts[3])
  ) {
    throw new Error(`${label} must be a direct, named artifact under .cruise/runs/<run-id>`);
  }
  return Object.freeze({ runId: parts[2], name: parts[3], relativePath: path });
}

export async function validateWorkerInvocationScope({
  cwd,
  requested_cwd: requestedCwd = cwd,
  packet_path: packetPath,
  report_path: reportPath,
  invocation_cwd: invocationCwd = process.cwd(),
} = {}) {
  const requestedRoot = resolve(requestedCwd);
  const [root, invokedFrom] = await Promise.all([
    realpath(requestedRoot),
    realpath(resolve(invocationCwd)),
  ]);
  if (root !== invokedFrom) {
    throw new Error('worker -C must equal the canonical host command working directory');
  }

  const requestedPacket = resolve(packetPath);
  const requestedPacketRecord = exactRunChild(
    requestedRoot,
    requestedPacket,
    'worker packet',
    /^(?=[^/]*packet)[a-z0-9][a-z0-9._-]*\.(?:md|ya?ml)$/iu,
  );
  const canonicalPacket = await realpath(requestedPacket);
  const packet = exactRunChild(
    root,
    canonicalPacket,
    'worker packet',
    /^(?=[^/]*packet)[a-z0-9][a-z0-9._-]*\.(?:md|ya?ml)$/iu,
  );
  if (packet.relativePath !== requestedPacketRecord.relativePath) {
    throw new Error('worker packet path must not traverse a symlinked file or parent');
  }

  const requestedReport = resolve(reportPath);
  const requestedReportRecord = exactRunChild(
    requestedRoot,
    requestedReport,
    'worker report',
    /^(?=[^/]*report)[a-z0-9][a-z0-9._-]*\.ya?ml$/iu,
  );
  const requestedReportParent = dirname(requestedReport);
  const canonicalReportParent = await realpath(requestedReportParent);
  const canonicalReport = join(canonicalReportParent, basename(requestedReport));
  const report = exactRunChild(
    root,
    canonicalReport,
    'worker report',
    /^(?=[^/]*report)[a-z0-9][a-z0-9._-]*\.ya?ml$/iu,
  );
  if (report.relativePath !== requestedReportRecord.relativePath) {
    throw new Error('worker report parent must not traverse a symlink');
  }
  if (packet.runId !== report.runId) {
    throw new Error('worker packet and report must belong to the same canonical run');
  }
  if (canonicalPacket === canonicalReport) {
    throw new Error('worker packet and report must be different canonical paths');
  }
  return Object.freeze({
    cwd: root,
    packetPath: canonicalPacket,
    reportPath: canonicalReport,
    runId: packet.runId,
  });
}

export async function validateWorkerReportDestination({
  cwd,
  requested_cwd: requestedCwd = cwd,
  report_path: reportPath,
  invocation_cwd: invocationCwd = process.cwd(),
  expected_report_path: expectedReportPath,
} = {}) {
  const requestedRoot = resolve(requestedCwd);
  const [root, invokedFrom] = await Promise.all([
    realpath(requestedRoot),
    realpath(resolve(invocationCwd)),
  ]);
  if (root !== invokedFrom) {
    throw new Error('worker -C must equal the canonical host command working directory');
  }

  const requestedReport = resolve(reportPath);
  const requestedReportRecord = exactRunChild(
    requestedRoot,
    requestedReport,
    'worker report',
    /^(?=[^/]*report)[a-z0-9][a-z0-9._-]*\.ya?ml$/iu,
  );
  const canonicalReportParent = await realpath(dirname(requestedReport));
  const canonicalReport = join(canonicalReportParent, basename(requestedReport));
  const report = exactRunChild(
    root,
    canonicalReport,
    'worker report',
    /^(?=[^/]*report)[a-z0-9][a-z0-9._-]*\.ya?ml$/iu,
  );
  if (report.relativePath !== requestedReportRecord.relativePath) {
    throw new Error('worker report parent must not traverse a symlink');
  }
  if (canonicalReport !== expectedReportPath) {
    throw new Error('worker report destination differs from its approved canonical path');
  }
  return canonicalReport;
}

export async function assertWorkerForeignDiffGuard(scope) {
  const statePath = join(dirname(scope.packetPath), 'foreign-diff-guard.yaml');
  let state;
  try {
    state = await readForeignDiffGuardState(statePath);
  } catch (cause) {
    if (cause?.code === 'ENOENT') {
      throw new Error(
        `worker launch requires ${statePath}; initialize the canonical Cruise run first`,
        { cause },
      );
    }
    throw cause;
  }
  if (state.run_id !== scope.runId) {
    throw new Error('worker foreign-diff guard run binding differs from the canonical packet run');
  }
  if (state.repository_root !== scope.cwd) {
    throw new Error('worker foreign-diff guard repository binding differs from worker cwd');
  }

  const checked = await checkForForeignDiff({ statePath });
  if (checked.state.run_id !== scope.runId || checked.state.repository_root !== scope.cwd) {
    throw new Error('worker foreign-diff guard binding changed during launch preflight');
  }
  if (checked.outcome !== 'clean') {
    throw new Error(
      `foreign diff ${checked.incident?.incident_id ?? 'incident'} detected; worker launch is paused for user intent`,
    );
  }
  return Object.freeze({
    statePath,
    inventorySha256: checked.inventory.sha256,
    state: checked.state,
  });
}

export async function prepareWorkerLaunch({
  cwd,
  requested_cwd: requestedCwd = cwd,
  packet_path: packetPath,
  report_path: reportPath,
  invocation_cwd: invocationCwd = process.cwd(),
  level = null,
  packet_sha256: packetSha256,
}) {
  const scope = await validateWorkerInvocationScope({
    cwd,
    requested_cwd: requestedCwd,
    packet_path: packetPath,
    report_path: reportPath,
    invocation_cwd: invocationCwd,
  });
  if (!/^[a-f0-9]{64}$/u.test(packetSha256 ?? '')) {
    throw new Error('worker launch requires an exact packet SHA-256');
  }
  const guardPreflight = await assertWorkerForeignDiffGuard(scope);
  const packet = await readWorkerPacket(scope.packetPath, { expectedSha256: packetSha256 });
  let mapperOutput = null;
  const mappingName = /^semantic-mapping-packet\.(?:yaml|yml|md)$/u.test(basename(scope.packetPath));
  const mappingTag = new RegExp(`^packet_kind:\\s*["']?${SEMANTIC_MAPPING_PACKET_KIND}["']?\\s*$`, 'mu').test(packet);
  if (mappingName || mappingTag) {
    if (level !== 2) {
      throw new Error('semantic mapping packet requires exactly worker level 2');
    }
    let parsed;
    try {
      parsed = parseYaml(packet);
    } catch (cause) {
      throw new Error('semantic mapping packet must be runtime-generated executable YAML', { cause });
    }
    const runDirectory = dirname(scope.packetPath);
    const origin = await readYamlFile(join(runDirectory, 'origin.yaml'));
    validateOriginRecord(origin);
    if (await realpath(origin.repository_baseline.root) !== scope.cwd) {
      throw new Error('semantic mapping Origin repository root differs from worker cwd');
    }
    if (
      origin.origin.prompt_sha256 !== guardPreflight.state.origin_prompt_sha256
      || repositoryBaselineDigest(origin.repository_baseline)
        !== guardPreflight.state.repository_baseline_digest
    ) {
      throw new Error('semantic mapping Origin differs from the host-owned foreign-diff authority');
    }
    const contract = assertSemanticMappingPacket(parsed, {
      runDirectory,
      repositoryRoot: origin.repository_baseline.root,
      promptSha256: origin.origin.prompt_sha256,
      repositoryBaselineDigest: repositoryBaselineDigest(origin.repository_baseline),
    });
    if (scope.packetPath !== await realpath(resolve(contract.packet_path))) {
      throw new Error('semantic mapping packet path differs from its runtime-generated binding');
    }
    mapperOutput = Object.freeze({
      path: contract.facts_output_path,
      template: contract.enrichment_template,
    });
  }
  const guardState = await bindForeignDiffWorkerPacket({
    statePath: guardPreflight.statePath,
    packetPath: scope.packetPath,
    packetSha256,
  });
  // Bind first, then re-read under the same host lock so a packet replacement
  // between validation and inference cannot be admitted.
  const reboundPacket = await readWorkerPacket(scope.packetPath, { expectedSha256: packetSha256 });
  if (reboundPacket !== packet) throw new Error('worker packet changed after host binding');
  return Object.freeze({ packet, scope, guardState, mapperOutput });
}

async function withWorkerForeignDiffLock(scope, callback) {
  const lockPath = join(
    dirname(foreignDiffAuthorityPath(scope.cwd, scope.runId)),
    'foreign-diff-guard.lock',
  );
  return withHostAuthorityLock({
    lockPath,
    resource: 'foreign-diff-guard',
    scope: {
      repository_root: scope.cwd,
      run_id: scope.runId,
    },
  }, callback);
}

export async function runWorker(options, {
  runSession = runWorkerSession,
  invocationCwd = process.cwd(),
  runtimeReadiness = assertWorkerRuntimeReadiness,
} = {}) {
  await runtimeReadiness({ codexHome: options.codexHome ?? null });
  const cwd = await validateWorkingDirectory(options.cwd);
  const initialScope = await validateWorkerInvocationScope({
    cwd,
    requested_cwd: options.cwd,
    packet_path: options.packet,
    report_path: options.report,
    invocation_cwd: invocationCwd,
  });
  // Establish the bound authority (and produce the precise missing/pending
  // diagnostic) before locating its host-owned lock. The full check is
  // repeated under that lock immediately before packet admission.
  await assertWorkerForeignDiffGuard(initialScope);
  const admitted = await withWorkerForeignDiffLock(initialScope, async () => {
    const launch = await prepareWorkerLaunch({
      cwd,
      requested_cwd: options.cwd,
      packet_path: options.packet,
      report_path: options.report,
      invocation_cwd: invocationCwd,
      level: options.level,
      packet_sha256: options.packetSha256,
    });
    const admission = await admitWorkerAttempt({
      scope: launch.scope,
      packetSha256: options.packetSha256,
      level: options.level,
      guardState: launch.guardState,
      mapperOutput: launch.mapperOutput,
    });
    return Object.freeze({ ...launch, admission });
  });
  const { packet, scope, mapperOutput, admission } = admitted;
  let reportCommitted = false;
  try {
    // The admission lock must not span inference: implementation workers use
    // the same host-authority lock through foreign-diff-project/open/close to
    // predeclare, perform, and receipt each product write inside their turn.
    const report = await runSession({
      level: options.level,
      cwd,
      packet,
      codexHome: options.codexHome ?? null,
    });
    return await withWorkerForeignDiffLock(scope, async () => {
      // A change that arrives while inference is running cannot be attributed
      // without an exact action completion in the host-owned guard.
      const guardProof = await assertWorkerForeignDiffGuard(scope);
      await assertWorkerControlSnapshot(admission, {
        guardState: guardProof.state,
        cleanInventorySha256: guardProof.inventorySha256,
      });
      await assertExpectedWorkerOutput(admission, {
        required: mapperOutput !== null,
        canonicalizeMapperOutput: mapperOutput !== null,
      });
      const boundReport = bindWorkerAttemptReport(report, admission);
      const committed = await commitWorkerReportNoClobber(admission, boundReport);
      reportCommitted = true;
      await completeWorkerAttempt(admission, {
        outcome: 'terminal_success',
        reportSha256: committed.sha256,
      });
      process.stdout.write(`Worker ${report.launch.agent_type} completed; report ${scope.reportPath}\n`);
      return 0;
    });
  } catch (error) {
    if (reportCommitted) {
      // The success report is already no-clobber committed. Its admitted
      // record remains consumed even if the terminal marker cannot be added.
      throw error;
    }
    try {
      await withWorkerForeignDiffLock(scope, async () => {
        let guardProof = null;
        try {
          guardProof = await assertWorkerForeignDiffGuard(scope);
        } catch (foreignDiffError) {
          try {
            Object.defineProperty(error, 'foreignDiffError', {
              value: foreignDiffError,
              enumerable: false,
              configurable: true,
            });
          } catch {
            // Preserve a primitive or frozen inference error unchanged.
          }
        }
        try {
          await assertWorkerControlSnapshot(admission, {
            guardState: guardProof?.state ?? null,
            cleanInventorySha256: guardProof?.inventorySha256 ?? null,
          });
          await assertExpectedWorkerOutput(admission, { required: false });
        } catch (controlArtifactError) {
          try {
            Object.defineProperty(error, 'controlArtifactError', {
              value: controlArtifactError,
              enumerable: false,
              configurable: true,
            });
          } catch {
            // Preserve a primitive or frozen inference error unchanged.
          }
        }
        let committed = null;
        try {
          const failure = bindWorkerAttemptReport(
            createWorkerFailureReport(error, { level: options.level }),
            admission,
          );
          committed = await commitWorkerReportNoClobber(admission, failure);
        } catch (persistenceError) {
          // Preserve the original inference failure and its reconnect history even
          // when the already-approved report destination is no longer writable.
          try {
            Object.defineProperty(error, 'reportPersistenceError', {
              value: persistenceError,
              enumerable: false,
              configurable: true,
            });
          } catch {
            // A primitive or frozen thrown value still must be rethrown unchanged.
          }
        }
        try {
          await completeWorkerAttempt(admission, {
            outcome: 'terminal_failure',
            reportSha256: committed?.sha256 ?? null,
            errorCode: error?.code ?? 'CRUISE_WORKER_FAILED',
          });
        } catch (attemptPersistenceError) {
          try {
            Object.defineProperty(error, 'attemptPersistenceError', {
              value: attemptPersistenceError,
              enumerable: false,
              configurable: true,
            });
          } catch {
            // Preserve a primitive or frozen inference error unchanged.
          }
        }
      });
    } catch (finalizationError) {
      try {
        if (!Object.hasOwn(error, 'reportPersistenceError')) {
          Object.defineProperty(error, 'reportPersistenceError', {
            value: finalizationError,
            enumerable: false,
            configurable: true,
          });
        }
      } catch {
        // Preserve a primitive or frozen inference error unchanged.
      }
    }
    throw error;
  }
}

async function validateWorkingDirectory(cwd) {
  const metadata = await stat(cwd);
  if (!metadata.isDirectory()) throw new Error(`Not a directory: ${cwd}`);
  return realpath(cwd);
}

async function runStart(options) {
  const cwd = await validateWorkingDirectory(options.cwd);
  const cruiseClass = await readCruiseClass({ codexHome: options.codexHome });
  const communicationStyle = await readCommunicationStyle({ codexHome: options.codexHome });
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
      process.stderr.write(`Cruise warning: ${userFacingError(error.message, {
        style: communicationStyle.style,
      })}\n`);
    },
  });
  const skill = options.skill ?? 'goal';
  const skillPath = resolve(SKILLS_ROOT, `${skill}/SKILL.md`);
  const session = skill === 'goal'
    ? new CruiseSession({
        client,
        cwd,
        prompt: options.prompt,
        skillPath: GOAL_SKILL_PATH,
        pickOne,
        readLine: readLineOnce,
        lineReader,
        cruiseClass,
        communicationStyle,
      })
    : new CruiseSkillSession({
        client,
        cwd,
        prompt: options.prompt,
        skill,
        skillPath,
        pickOne,
        readLine: readLineOnce,
        lineReader,
        cruiseClass,
        communicationStyle,
      });
  let interrupted = false;
  const onSigint = () => {
    if (interrupted) return;
    interrupted = true;
    process.stderr.write('\nPausing Cruise…\n');
    void session?.interrupt();
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
    process.stderr.write(`cruise: ${userFacingError(error.message)}\nTry 'cruise --help'.\n`);
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
    if (options.command === 'config') return await runConfig(options);
    if (options.command === 'agents') return await runAgents(options);
    if (options.command === 'hooks') return await runHooks(options);
    if (options.command === 'worker') return await runWorker(options);
    if (options.command === 'picker-demo') return await runPickerDemo();
    return await runStart(options);
  } catch (error) {
    process.stderr.write(`cruise: ${userFacingError(error.message)}\n`);
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
