#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, stat, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AppServerClient,
  AppServerInactivityError,
} from './lib/app-server-client.mjs';
import {
  runClaudeChangelogWorker,
  runClaudeSession,
  runClaudeWorker,
} from './lib/claude-cli.mjs';
import { CommitChangelogObserver } from './lib/changelog-observer.mjs';
import {
  inspectFlightPlan,
  readFlightPlan,
  writeFlightPlan,
} from './lib/flight-plan.mjs';
import {
  captureFlightAssuranceContext,
  evaluateFlightAssurance,
} from './lib/assurance.mjs';
import { readOriginPrompt, writeOriginPrompt } from './lib/origin-note.mjs';
import { pickOne } from './lib/picker.mjs';
import { providerDefinition, resolveProvider } from './lib/provider.mjs';
import {
  milestoneToFlightPlan,
  nextReadyMilestone,
  readQueue,
  writeQueue,
} from './lib/queue.mjs';
import {
  SimpleCruiseGoalBootstrapTimeoutError,
  SimpleCruiseInterruptedError,
  SimpleCruiseSession,
} from './lib/simple-session.mjs';
import { runSimpleWorker } from './lib/simple-worker.mjs';
import { automaticDelegationAuthorization } from './lib/authorization-policy.mjs';
import { createStagedHandoff } from './lib/staged-handoff.mjs';
import {
  buildContextCapsule,
  parseWorkerHandoff,
  WORKER_HANDOFF_SCHEMA_INSTRUCTIONS,
  writeContextCapsule,
  writeRootHandoff,
} from './lib/context-capsule.mjs';
import { routeWorkerTask } from './lib/worker-policy.mjs';
import { WorkerDispatchLedger } from './lib/worker-dispatcher.mjs';
import { captureWorkspaceFingerprint } from './lib/supervisor.mjs';
import {
  BUDGET_PAUSE_EXIT_CODE,
  QuotaGuard,
  resolveBudgetOptions,
} from './lib/quota-guard.mjs';
import {
  cleanupRuntimeSession,
  cleanupLegacyCruiseState,
  createRuntimeSession,
  finalizeCruiseControlState,
  prepareCruiseControlState,
} from './lib/runtime-state.mjs';
import {
  activateGoalSession,
  deactivateGoalSession,
  releaseCruiseWorkspace,
  reserveCruiseWorkspace,
  runtimeSessionDirectory,
} from '../hooks/session-marker.mjs';
import {
  writeGoalUserDocuments,
} from './lib/user-reference.mjs';
import { loadCruiseConfig } from './lib/migration-config.mjs';
import {
  MigrationController,
  SupabaseCliMigrationAdapter,
} from './lib/migration-controller.mjs';

const require = createRequire(import.meta.url);
const packageMetadata = require('../package.json');

export const CLI_VERSION = packageMetadata.version;
export const PUBLIC_SKILLS = Object.freeze(['build', 'quick', 'goal', 'debug']);

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const SKILLS_ROOT = resolve(fileURLToPath(new URL('../skills/', import.meta.url)));

const HELP = `Cruise ${CLI_VERSION} — a thin Codex and Claude Code task launcher

Usage:
  cruise [--codex|--claude] [start] [-C <directory>] <request...>
  cruise [--codex|--claude] <build|quick|goal|debug> [-C <directory>] <request...>
  cruise [--codex|--claude] goal --plan [-C <directory>] <request...>
  cruise --claude goal --resume <session-id> [-C <directory>]
  cruise [--codex|--claude] queue <status|run> [-C <directory>]
  cruise attest [-C <directory>] [--json]
  cruise reference --status <completed|blocked|aborted|unfinished|not_started> [-C <directory>]
  cruise [--codex|--claude] changelog --commit <oid> [-C <directory>]
  cruise [--codex|--claude] worker [--level <1-7>] [-C <directory>] <task...>
  cruise usage [-C <directory>] [--json]
  cruise budget [-C <directory>] [--json] [--strict-budget]
  cruise config <show|validate> [-C <directory>] [--json]
  cruise migrate <inspect|apply> --target <name> [--path <migration.sql>]... [--sandbox-first <auto|manual|off>] [--json]
  cruise migrate query --target <name> --file <query.sql> [--json]
  cruise migrate <status|route> [--sandbox-first <auto|manual>] [--json]
  cruise [--codex|--claude] doctor [--json]

Budget options:
  --weekly-delta-cap <percent>   Campaign increase allowed within the weekly window (default 9.0)
  --goal-reservation <percent>  Reservation required before Goal or worker launch (default 2.25)
  --strict-budget               Pause when weekly account data is unavailable

Worker L6-to-L7 reasoning escalation:
  --reasoning-escalation-evidence <text>  With Codex --managed --complexity repeated --level 7
                                          and an exceptional-consequence record, select Astra ultra

Cruise records exact executable skill requests in .cruise/ORIGIN.md. Build may compile an
advisory .cruise/QUEUE.md; queue run turns each ready milestone into an advisory
.cruise/FLIGHT.md and executes it as a supervised Goal, stopping on failure.
Codex Goal loops pause with a report after realignment and a final experiment.
Cruise has no approval authority, archive, run-control YAML, digest, or retry
ledger. The selected host's native permissions remain the authority for work
and effects. Codex is the default; CRUISE_PROVIDER may set a request-scoped
default to codex or claude.

Startup options (Codex Goal):
  --bootstrap-timeout-ms <ms>   Optional native first-turn deadline; 0/off disables (default)
  --staged-handoff <file.json>  Await fresh parent state before activating the Goal
  --ready-file <file.json>      Exclusive readiness marker outside the workspace
Environment: CRUISE_GOAL_BOOTSTRAP_TIMEOUT_MS and CRUISE_INITIALIZE_TIMEOUT_MS (0 disables).
Staged readiness confirms transport/thread setup, not model inference. The parent must
finish its current edits and relinquish overlapping ownership before supplying the capsule.

Exit codes: 0 contract-ready/complete/assured, 2 blocked/failed/unassured, 3 stalled, 4 Goal bootstrap timeout,
5 transport inactivity, 6 budget pause, 130 interrupted.
`;

function displayError(value) {
  return String(value ?? 'Unknown Cruise error')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function extractProviderArgs(argv, env) {
  const args = [];
  let selected = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      args.push(...argv.slice(index));
      break;
    }
    let candidate = null;
    if (arg === '--codex') candidate = 'codex';
    else if (arg === '--claude') candidate = 'claude';
    else if (arg === '--provider') {
      candidate = argv[++index];
      if (!candidate) throw new Error('--provider requires codex or claude.');
    }
    if (candidate === null) {
      args.push(arg);
      continue;
    }
    const normalized = resolveProvider(candidate, { env: {} });
    if (selected !== null && selected !== normalized) {
      throw new Error('Choose only one provider: --codex or --claude.');
    }
    selected = normalized;
  }
  return { args, provider: resolveProvider(selected, { env }) };
}

export function parseArgs(argv, { env = process.env } = {}) {
  const extracted = extractProviderArgs([...argv], env);
  const args = extracted.args;
  const provider = extracted.provider;
  if (args[0] === 'picker-demo') {
    throw new Error('picker-demo was removed; Cruise selectors are available only when the active host requests a real choice.');
  }
  if (args[0] === 'refine') {
    throw new Error('Cruise Refine was folded into Goal. Use `cruise goal "<request>"`; for read-only planning, say "plan only".');
  }
  let command = 'start';
  if (['start', ...PUBLIC_SKILLS, 'queue', 'attest', 'reference', 'changelog', 'worker', 'usage', 'budget', 'config', 'migrate', 'doctor', 'help'].includes(args[0])) {
    command = args.shift();
  }
  let queueAction = null;
  let configAction = null;
  let migrationAction = null;
  if (command === 'config') {
    configAction = args.shift() ?? null;
    if (!['show', 'validate'].includes(configAction)) throw new Error('cruise config requires show or validate.');
  }
  if (command === 'migrate') {
    migrationAction = args.shift() ?? null;
    if (!['inspect', 'apply', 'query', 'status', 'route'].includes(migrationAction)) {
      throw new Error('cruise migrate requires inspect, apply, query, status, or route.');
    }
  }
  const options = {
    command,
    skill: PUBLIC_SKILLS.includes(command) ? command : 'goal',
    provider,
    cwd: process.cwd(),
    json: false,
    help: false,
    version: false,
    level: null,
    userStatus: null,
    commit: null,
    promptParts: [],
    ...(command === 'config' ? { configAction } : {}),
    ...(command === 'migrate' ? {
      migrationAction,
      targetName: null,
      migrationPaths: [],
      sqlFile: null,
      sandboxFirst: null,
      authorizationDigest: null,
      runtimeDirectory: env.CRUISE_RUNTIME_DIR ?? null,
    } : {}),
    ...resolveBudgetOptions({ env }),
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      if (command === 'queue' && args.length > index + 1) {
        throw new Error(`Unexpected queue argument: ${args[index + 1]}`);
      }
      options.promptParts.push(...args.slice(index + 1));
      break;
    }
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '-V' || arg === '--version') options.version = true;
    else if (arg === '--json' && ['doctor', 'attest', 'usage', 'budget', 'config', 'migrate'].includes(command)) options.json = true;
    else if (arg === '--target') {
      if (command !== 'migrate') throw new Error('--target is supported only by cruise migrate.');
      const value = args[++index];
      if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(value ?? '')) throw new Error('--target requires a configured target name.');
      options.targetName = value;
    }
    else if (arg === '--path') {
      if (command !== 'migrate' || !['inspect', 'apply'].includes(migrationAction)) {
        throw new Error('--path is supported only by cruise migrate inspect or apply.');
      }
      const value = args[++index];
      if (!value) throw new Error('--path requires a migration SQL file.');
      options.migrationPaths.push(value);
    }
    else if (arg === '--file') {
      if (command !== 'migrate' || migrationAction !== 'query') {
        throw new Error('--file is supported only by cruise migrate query.');
      }
      const value = args[++index];
      if (!value) throw new Error('--file requires a SQL file.');
      options.sqlFile = value;
    }
    else if (arg === '--sandbox-first' || arg.startsWith('--sandbox-first=')) {
      if (command !== 'migrate') throw new Error('--sandbox-first is supported only by cruise migrate.');
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++index];
      if (!['auto', 'manual', 'off'].includes(value ?? '')) throw new Error('--sandbox-first requires auto, manual, or off.');
      if (migrationAction === 'route' && value === 'off') throw new Error('cruise migrate route accepts only auto or manual.');
      options.sandboxFirst = value;
    }
    else if (arg === '--authorize-digest') {
      if (command !== 'migrate' || migrationAction !== 'apply') {
        throw new Error('--authorize-digest is supported only by cruise migrate apply.');
      }
      const value = args[++index];
      if (!/^[0-9a-f]{64}$/iu.test(value ?? '')) throw new Error('--authorize-digest requires a SHA-256 digest.');
      options.authorizationDigest = value.toLowerCase();
    }
    else if (arg === '--weekly-delta-cap') {
      const value = args[++index];
      if (value === undefined) throw new Error('--weekly-delta-cap requires a percent.');
      options.weeklyDeltaCap = value;
    }
    else if (arg === '--goal-reservation') {
      const value = args[++index];
      if (value === undefined) throw new Error('--goal-reservation requires a percent.');
      options.goalReservation = value;
    }
    else if (arg === '--strict-budget') {
      options.strictBudget = true;
    }
    else if (arg === '--root-model') {
      if (command !== 'goal') throw new Error('--root-model is supported only by cruise goal.');
      const value = args[++index];
      if (!/^gpt-5\.6-(?:luna|terra|sol)$/u.test(value ?? '')) {
        throw new Error('--root-model requires gpt-5.6-luna, gpt-5.6-terra, or gpt-5.6-sol.');
      }
      options.rootModel = value;
    }
    else if (arg === '--root-effort') {
      if (command !== 'goal') throw new Error('--root-effort is supported only by cruise goal.');
      const value = String(args[++index] ?? '').toLowerCase();
      if (!['medium', 'high', 'xhigh', 'ultra', 'max'].includes(value)) {
        throw new Error('--root-effort requires medium, high, xhigh, ultra, or max.');
      }
      options.rootEffort = value;
    }
    else if (arg === '--cheaper-diagnostic') {
      if (command !== 'goal') throw new Error('--cheaper-diagnostic is supported only by cruise goal.');
      options.cheaperDiagnostic = true;
    }
    else if (arg === '--status') {
      if (command !== 'reference') throw new Error('--status is supported only by cruise reference.');
      const value = args[++index];
      if (!['completed', 'blocked', 'aborted', 'unfinished', 'not_started'].includes(value)) {
        throw new Error('--status requires completed, blocked, aborted, unfinished, or not_started.');
      }
      options.userStatus = value;
    }
    else if (arg === '--commit') {
      if (command !== 'changelog') throw new Error('--commit is supported only by cruise changelog.');
      const value = args[++index];
      if (!/^[0-9a-f]{4,64}$/iu.test(value ?? '')) {
        throw new Error('--commit requires a hexadecimal Git object ID.');
      }
      options.commit = value;
    }
    else if (['--bootstrap-timeout-ms', '--staged-handoff', '--ready-file'].includes(arg)) {
      if (command !== 'goal' || provider !== 'codex') {
        throw new Error(`${arg} is supported only by cruise --codex goal.`);
      }
      const value = args[++index];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      if (arg === '--bootstrap-timeout-ms') {
        const milliseconds = value === 'off' ? 0 : /^\d+$/u.test(value) ? Number(value) : NaN;
        if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 2_147_483_647) {
          throw new Error('--bootstrap-timeout-ms requires 0/off or an integer <= 2147483647.');
        }
        options.firstTurnDeadlineMs = milliseconds;
      } else options[arg === '--staged-handoff' ? 'stagedHandoff' : 'readyFile'] = value;
    }
    else if (arg === '--plan') {
      if (command !== 'goal') throw new Error('--plan is supported only by cruise goal.');
      options.planOnly = true;
    }
    else if (arg === '--resume') {
      if (command !== 'goal' || provider !== 'claude') {
        throw new Error('--resume is supported only by `cruise --claude goal`.');
      }
      const value = args[++index];
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/u.test(value ?? '')) {
        throw new Error('--resume requires a Claude session id.');
      }
      options.resumeSessionId = value;
    }
    else if (arg === '--level') {
      if (command !== 'worker') throw new Error('--level is supported only by cruise worker.');
      if (options.level !== null) throw new Error('--level may be supplied only once.');
      const value = args[++index];
      if (!/^\d+$/u.test(value ?? '')) throw new Error('--level requires an integer from 1 through 7.');
      options.level = Number(value);
      if (options.level < 1 || options.level > 7) {
        throw new Error('--level requires an integer from 1 through 7.');
      }
    }
    else if (arg === '--managed') {
      if (command !== 'worker') throw new Error('--managed is supported only by cruise worker.');
      options.managedWorker = true;
    }
    else if (arg === '--complexity') {
      if (command !== 'worker') throw new Error('--complexity is supported only by cruise worker.');
      const value = args[++index];
      if (!['naming', 'retrieval', 'bounded', 'complex', 'consequential', 'repeated', 'exceptional'].includes(value)) {
        throw new Error('--complexity requires naming, retrieval, bounded, complex, consequential, repeated, or exceptional.');
      }
      options.workerComplexity = value;
    }
    else if (['--owns', '--evidence', '--range', '--verify'].includes(arg)) {
      if (command !== 'worker') throw new Error(`${arg} is supported only by cruise worker.`);
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value.`);
      const key = {
        '--owns': 'workerOwnership',
        '--evidence': 'workerEvidence',
        '--range': 'workerRanges',
        '--verify': 'workerVerification',
      }[arg];
      (options[key] ??= []).push(value);
    }
    else if (arg === '--read-only') {
      if (command !== 'worker') throw new Error('--read-only is supported only by cruise worker.');
      options.workerReadOnly = true;
    }
    else if (arg === '--debug-probe') {
      if (command !== 'worker') throw new Error('--debug-probe is supported only by cruise worker.');
      const value = args[++index];
      if (!value) throw new Error('--debug-probe requires an evidence-distinct key.');
      options.debugProbeKey = value;
    }
    else if (arg === '--expansion-evidence') {
      if (command !== 'worker') throw new Error('--expansion-evidence is supported only by cruise worker.');
      const value = args[++index];
      if (!value) throw new Error('--expansion-evidence requires confirmed evidence.');
      options.expansionEvidence = value;
    }
    else if (arg === '--reasoning-escalation-evidence') {
      if (command !== 'worker') throw new Error('--reasoning-escalation-evidence is supported only by cruise worker.');
      if (options.reasoningEscalationEvidence !== undefined) {
        throw new Error('--reasoning-escalation-evidence may be supplied only once.');
      }
      const value = args[++index];
      if (!value?.trim()) throw new Error('--reasoning-escalation-evidence requires non-empty reasoning evidence.');
      options.reasoningEscalationEvidence = value;
    }
    else if (arg === '--exceptional-consequence') {
      if (command !== 'worker') throw new Error('--exceptional-consequence is supported only by cruise worker.');
      const value = args[++index];
      if (!value) throw new Error('--exceptional-consequence requires a value.');
      options.exceptionalConsequence = value;
    }
    else if (arg === '--exceptional-rationale') {
      if (command !== 'worker') throw new Error('--exceptional-rationale is supported only by cruise worker.');
      const value = args[++index];
      if (!value) throw new Error('--exceptional-rationale requires a value.');
      options.exceptionalRationale = value;
    }
    else if (arg === '-C' || arg === '--cwd') {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a directory.`);
      options.cwd = resolve(value);
    } else if (arg.startsWith('-')) {
      throw new Error(`${arg} is not supported by the prompt-only Cruise runtime.`);
    } else if (['doctor', 'attest', 'changelog', 'usage', 'budget', 'config', 'migrate'].includes(command)) {
      throw new Error(`Unexpected ${command} argument: ${arg}`);
    } else if (command === 'queue') {
      if (queueAction !== null || !['status', 'run'].includes(arg)) {
        throw new Error(`Unexpected queue argument: ${arg}`);
      }
      queueAction = arg;
    } else options.promptParts.push(arg);
  }
  Object.assign(options, resolveBudgetOptions(options));
  if (options.json && !['doctor', 'attest', 'usage', 'budget', 'config', 'migrate'].includes(command)) {
    throw new Error('--json is not supported by this Cruise command.');
  }
  const prompt = options.promptParts.join(' ');
  if (command === 'reference' && prompt) {
    throw new Error(`Unexpected reference argument: ${prompt}`);
  }
  if (!options.help && !options.version && command === 'changelog' && !options.commit) {
    throw new Error('cruise changelog requires --commit <oid>.');
  }
  if (!options.help && !options.version && command === 'queue' && queueAction === null) {
    throw new Error('cruise queue requires status or run.');
  }
  if (!options.help && !options.version && command === 'migrate') {
    if (['inspect', 'apply', 'query'].includes(migrationAction) && !options.targetName) {
      throw new Error(`cruise migrate ${migrationAction} requires --target <name>.`);
    }
    if (migrationAction === 'query' && !options.sqlFile) {
      throw new Error('cruise migrate query requires --file <query.sql>.');
    }
    if (migrationAction === 'route' && !options.sandboxFirst) {
      throw new Error('cruise migrate route requires --sandbox-first auto or manual.');
    }
  }
  if (options.resumeSessionId && options.planOnly) {
    throw new Error('--resume continues the existing Claude Goal and cannot also start a new plan-only run.');
  }
  if (options.resumeSessionId && prompt) {
    throw new Error('--resume preserves the original Goal and does not accept a replacement request.');
  }
  if ((options.stagedHandoff == null) !== (options.readyFile == null)) {
    throw new Error('--staged-handoff and --ready-file must be supplied together.');
  }
  if ((options.rootModel == null) !== (options.rootEffort == null)) {
    throw new Error('--root-model and --root-effort must be supplied together.');
  }
  if ((options.exceptionalConsequence == null) !== (options.exceptionalRationale == null)) {
    throw new Error('--exceptional-consequence and --exceptional-rationale must be supplied together.');
  }
  if (options.expansionEvidence && !options.debugProbeKey) {
    throw new Error('--expansion-evidence requires --debug-probe.');
  }
  if (
    options.reasoningEscalationEvidence !== undefined &&
    !(
      provider === 'codex' &&
      options.managedWorker === true &&
      options.workerComplexity === 'repeated' &&
      options.level === 7 &&
      options.exceptionalConsequence &&
      options.exceptionalRationale
    )
  ) {
    throw new Error(
      '--reasoning-escalation-evidence requires a managed Codex worker with --complexity repeated, '
      + '--level 7, --exceptional-consequence, and --exceptional-rationale.',
    );
  }
  if (options.managedWorker) {
    for (const [key, flag] of [
      ['workerOwnership', '--owns'],
      ['workerEvidence', '--evidence'],
      ['workerRanges', '--range'],
      ['workerVerification', '--verify'],
    ]) {
      if (!options[key]?.length) throw new Error(`managed workers require ${flag}.`);
    }
  }
  if (
    !options.help &&
    !options.version &&
    !options.resumeSessionId &&
    !['doctor', 'help', 'queue', 'attest', 'reference', 'changelog', 'usage', 'budget', 'config', 'migrate'].includes(command) &&
    !prompt
  ) {
    throw new Error('Cruise requires a request.');
  }
  return command === 'queue' ? { ...options, queueAction, prompt } : { ...options, prompt };
}

export async function readLineOnce({ prompt, input = process.stdin, output = process.stderr }) {
  const readline = createInterface({
    input,
    output,
    terminal: Boolean(input.isTTY && output.isTTY),
  });
  try {
    return await readline.question(prompt);
  } finally {
    readline.close();
  }
}

export function surfaceAppServerStderr(client, output = process.stderr) {
  let atLineStart = true;
  const onStderr = (chunk) => {
    const value = String(chunk);
    let prefixed = '';
    for (let offset = 0; offset < value.length;) {
      if (atLineStart) prefixed += 'codex: ';
      const newline = value.indexOf('\n', offset);
      if (newline < 0) {
        prefixed += value.slice(offset);
        atLineStart = false;
        break;
      }
      prefixed += value.slice(offset, newline + 1);
      atLineStart = true;
      offset = newline + 1;
    }
    if (prefixed) output.write(prefixed);
  };
  client.on?.('stderr', onStderr);
  return () => client.off?.('stderr', onStderr);
}

async function validateWorkingDirectory(cwd) {
  const metadata = await stat(cwd);
  if (!metadata.isDirectory()) throw new Error(`Not a directory: ${cwd}`);
  return realpath(cwd);
}

export function createCommitChangelogObserver({
  cwd,
  provider,
  runtimeDirectory,
  sessionId,
  codexWorker = runSimpleWorker,
  claudeWorker = runClaudeChangelogWorker,
  observerFactory = (input) => new CommitChangelogObserver(input),
  pollIntervalMs,
  now,
  onWarning = (error) => {
    process.stderr.write(`Cruise warning: changelog update failed: ${displayError(error?.message)}\n`);
  },
}) {
  const resolvedProvider = resolveProvider(provider);
  return observerFactory({
    cwd,
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    ...(now === undefined ? {} : { now }),
    onWarning,
    async inferSummaries({ task }) {
      if (resolvedProvider === 'claude') {
        return claudeWorker({
          cwd: runtimeDirectory,
          task,
        });
      }
      const result = await codexWorker({
        cwd: runtimeDirectory,
        task,
        level: null,
        readOnly: true,
        timeoutMs: 120_000,
        sessionId: `${sessionId}-changelog`,
      });
      return result.output;
    },
  });
}

async function runWithCommitChangelogObserver({
  cwd,
  provider,
  runtimeDirectory,
  sessionId,
  dependencies,
  operation,
}) {
  const factory = dependencies.commitObserverFactory ?? createCommitChangelogObserver;
  const observer = factory({
    cwd,
    provider,
    runtimeDirectory,
    sessionId,
    codexWorker: dependencies.changelogCodexWorker,
    claudeWorker: dependencies.changelogClaudeWorker,
    observerFactory: dependencies.commitObserverImplementation,
    pollIntervalMs: dependencies.commitPollIntervalMs,
    now: dependencies.now,
  });
  try {
    await observer.start();
  } catch (error) {
    process.stderr.write(`Cruise warning: commit observation was unavailable: ${displayError(error?.message)}\n`);
    return operation();
  }
  try {
    return await operation();
  } finally {
    await observer.stop().catch((error) => {
      process.stderr.write(`Cruise warning: pending changelog updates were not completed: ${displayError(error?.message)}\n`);
    });
  }
}

async function runHostedSession(
  options,
  cwd,
  {
    clientFactory = null,
    claudeRunner = runClaudeSession,
    sessionFactory = (input) => new SimpleCruiseSession(input),
    quotaGuardFactory = (input) => new QuotaGuard(input),
  } = {},
) {
  const provider = resolveProvider(options.provider);
  if (provider === 'claude') {
    const result = await claudeRunner({
      cwd,
      pluginRoot: PACKAGE_ROOT,
      prompt: options.prompt,
      skill: options.skill,
      planOnly: Boolean(options.planOnly),
      resumeSessionId: options.resumeSessionId ?? null,
      ...(options.goalSessionId ? { sessionId: options.goalSessionId } : {}),
      ...(options.runtimeDirectory ? { runtimeDirectory: options.runtimeDirectory } : {}),
    });
    return {
      ...(options.includeRunMetadata ? result : {}),
      status: result.status ?? (result.exitCode === 0 ? 'complete' : result.exitCode === 3 ? 'stalled' : 'failed'),
      exitCode: result.exitCode,
      ...(options.includeRunMetadata ? { started: result.started ?? true } : {}),
    };
  }
  const injectedClientFactory = clientFactory !== null;
  const createClient = clientFactory ?? ((input) => new AppServerClient(input));
  const client = createClient({
    spawnOptions: {
      cwd,
      ...(options.runtimeDirectory
        ? {
            env: {
              ...process.env,
              CRUISE_RUNTIME_DIR: options.runtimeDirectory,
              CRUISE_SESSION_ID: options.goalSessionId,
            },
          }
        : {}),
    },
    clientInfo: { name: 'cruise', title: 'Cruise', version: CLI_VERSION },
    onError(error) {
      process.stderr.write(`Cruise warning: ${displayError(error.message)}\n`);
    },
  });
  const stopSurfacingStderr = surfaceAppServerStderr(client);
  const session = sessionFactory({
    client,
    cwd,
    prompt: options.prompt,
    skill: options.skill,
    skillPath: resolve(SKILLS_ROOT, options.skill, 'SKILL.md'),
    pickOne,
    readLine: readLineOnce,
    requireAssurance: true,
    beforeGoalActivation: options.beforeGoalActivation ?? null,
    firstTurnDeadlineMs: options.firstTurnDeadlineMs,
    planOnly: Boolean(options.planOnly),
    runtimeDirectory: options.runtimeDirectory ?? null,
    rootOverride: options.rootModel
      ? { model: options.rootModel, reasoning_effort: options.rootEffort }
      : null,
    cheaperDiagnostic: Boolean(options.cheaperDiagnostic),
    quotaGuard: !injectedClientFactory && options.skill === 'goal'
      ? quotaGuardFactory({
          cwd,
          weeklyDeltaCap: options.weeklyDeltaCap,
          goalReservation: options.goalReservation,
          strictBudget: options.strictBudget,
          resumeCommand: `cruise goal --strict-budget --weekly-delta-cap ${options.weeklyDeltaCap} --goal-reservation ${options.goalReservation} -C ${JSON.stringify(cwd)} <request>`,
        })
      : null,
  });
  const onSignal = () => void session.interrupt();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const result = await session.run();
    return {
      ...(options.includeRunMetadata ? result : {}),
      status: result.status,
      exitCode: result.status === 'complete' ? 0 : result.status === 'stalled' ? 3 : 2,
      ...(options.includeRunMetadata
        ? {
            started: true,
            tracePointer: session.rolloutPath ?? null,
            startedAt: session.runStartedAt ?? null,
          }
        : {}),
    };
  } catch (error) {
    if (error instanceof SimpleCruiseInterruptedError) {
      return {
        status: 'interrupted',
        exitCode: 130,
        ...(options.includeRunMetadata ? { started: true } : {}),
      };
    }
    if (error instanceof SimpleCruiseGoalBootstrapTimeoutError) {
      process.stderr.write(`cruise: ${displayError(error.message)}\n`);
      return {
        status: 'failed',
        exitCode: 4,
        ...(options.includeRunMetadata
          ? { started: false, reason: displayError(error.message) }
          : {}),
      };
    }
    if (error instanceof AppServerInactivityError || error?.code === 'CRUISE_TRANSPORT_INACTIVITY') {
      process.stderr.write(`cruise: ${displayError(error.message)}\n`);
      return {
        status: 'failed',
        exitCode: 5,
        ...(options.includeRunMetadata
          ? { started: true, reason: displayError(error.message) }
          : {}),
      };
    }
    if (error?.code === 'CRUISE_BUDGET_PAUSE') {
      process.stderr.write(`cruise: ${displayError(error.message)}\n`);
      return {
        status: 'budget-paused',
        exitCode: BUDGET_PAUSE_EXIT_CODE,
        ...(options.includeRunMetadata
          ? { started: Boolean(session.threadId), reason: displayError(error.message) }
          : {}),
      };
    }
    if (error?.code === 'CRUISE_CONTEXT_PRESSURE_PAUSE') {
      process.stderr.write(`cruise: ${displayError(error.message)}\n`);
      return {
        status: 'blocked',
        exitCode: 2,
        ...(options.includeRunMetadata
          ? { started: true, reason: displayError(error.message) }
          : {}),
      };
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    stopSurfacingStderr();
  }
}

export async function runStart(options, dependencies = {}) {
  const cwd = await validateWorkingDirectory(options.cwd);
  const goalSessionId = options.resumeSessionId ?? randomUUID();
  const executableGoal = options.skill === 'goal';
  const userDocumentWriter = dependencies.userDocumentWriter ?? writeGoalUserDocuments;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const launchedAt = now();
  if (options.stagedHandoff && (!executableGoal || resolveProvider(options.provider) !== 'codex')) {
    throw new Error('Staged handoff is supported only by cruise --codex goal.');
  }
  const reservation = { cwd, session_id: goalSessionId };
  const staged = options.stagedHandoff ? createStagedHandoff({
    handoffFile: options.stagedHandoff, readyFile: options.readyFile, sessionId: goalSessionId,
    onHeartbeat: message => process.stderr.write(`Cruise: ${message}\n`),
  }) : null;
  // Allocate only private scratch while the parent keeps workspace ownership.
  // The already-spawned app-server and workers must inherit this same runtime.
  const warmRuntimeDirectory = staged ? await createRuntimeSession({
    cwd, sessionId: goalSessionId, kind: 'goal-warmup',
  }) : null;
  let runtimeDirectory = warmRuntimeDirectory;
  let priorFlight = null;
  let ownershipAcquired = false;
  let stagedObserver = null;
  const acquireOwnership = async () => {
    if (executableGoal) {
      await activateGoalSession(reservation);
      ownershipAcquired = true;
      const reservedRuntime = await runtimeSessionDirectory(reservation);
      runtimeDirectory = warmRuntimeDirectory ?? reservedRuntime;
    } else {
      runtimeDirectory = await reserveCruiseWorkspace(reservation);
      ownershipAcquired = true;
    }
  };
  const beginOwnership = async () => {
    // A staged executor must acquire the serial lock before touching shared notes.
    if (staged) await acquireOwnership();
    if (!options.resumeSessionId) {
      await prepareCruiseControlState(cwd, { resetQueue: options.skill === 'build' });
    } else await cleanupLegacyCruiseState(cwd);
    priorFlight = executableGoal && !options.resumeSessionId
      ? await inspectFlightPlan(cwd).catch(() => null) : null;
    if (!staged) await acquireOwnership();
    if (!options.resumeSessionId && !options.planOnly) await writeOriginPrompt(cwd, options.prompt);
  };
  const acceptHandoff = staged ? async context => {
    const handoff = await staged.wait(context);
    context.signal.throwIfAborted();
    await beginOwnership();
    context.session.runtimeDirectory = runtimeDirectory;
    const factory = dependencies.commitObserverFactory ?? createCommitChangelogObserver;
    stagedObserver = factory({
      cwd, provider: options.provider, runtimeDirectory, sessionId: goalSessionId,
      codexWorker: dependencies.changelogCodexWorker,
      claudeWorker: dependencies.changelogClaudeWorker,
      observerFactory: dependencies.commitObserverImplementation,
      pollIntervalMs: dependencies.commitPollIntervalMs, now: dependencies.now,
    });
    try { await stagedObserver.start(); }
    catch (error) { process.stderr.write(`Cruise warning: commit observation was unavailable: ${displayError(error?.message)}\n`); }
    context.signal.throwIfAborted();
    return handoff;
  } : null;
  try {
    if (!staged) await beginOwnership();
    let result;
    try {
      const operation = () => runHostedSession({
        ...options, goalSessionId, runtimeDirectory, includeRunMetadata: true,
        ...(staged ? { beforeGoalActivation: acceptHandoff } : {}),
      }, cwd, dependencies);
      result = staged ? await operation() : await runWithCommitChangelogObserver({
        cwd, provider: options.provider, runtimeDirectory, sessionId: goalSessionId,
        dependencies, operation,
      });
    } catch (error) {
      if (executableGoal && ownershipAcquired) {
        await userDocumentWriter({
          cwd,
          prompt: options.prompt ?? '',
          provider: options.provider,
          status: 'failed',
          started: false,
          startedAt: null,
          endedAt: now(),
          sessionId: goalSessionId,
          reason: displayError(error?.message),
          includeFlight: false,
        }).catch((documentError) => {
          process.stderr.write(`Cruise warning: user documents were not updated: ${displayError(documentError?.message)}\n`);
        });
      }
      if (ownershipAcquired) await finalizeCruiseControlState(cwd, {
        status: 'failed', started: false,
      });
      throw error;
    }
    if (executableGoal && ownershipAcquired) {
      const prompt = options.prompt || await readOriginPrompt(cwd).catch(() => '');
      const currentFlight = await inspectFlightPlan(cwd).catch(() => null);
      const currentFlightBelongsToRun = Boolean(
        options.resumeSessionId ||
        (
          currentFlight?.state === 'valid' &&
          currentFlight.contentHash !== priorFlight?.contentHash
        ),
      );
      await userDocumentWriter({
        cwd,
        prompt,
        provider: options.provider,
        status: result.status,
        started: options.planOnly ? false : result.started !== false,
        startedAt: result.startedAt ?? (options.planOnly || result.started === false ? null : launchedAt),
        endedAt: now(),
        sessionId: result.sessionId ?? result.threadId ?? goalSessionId,
        tracePointer: result.tracePointer ?? null,
        reason: result.reason ?? null,
        includeFlight:
          !options.planOnly &&
          result.started !== false &&
          currentFlightBelongsToRun,
      }).catch((error) => {
        process.stderr.write(`Cruise warning: user documents were not updated: ${displayError(error?.message)}\n`);
      });
    }
    if (ownershipAcquired) await finalizeCruiseControlState(cwd, {
      status: result.status,
      started: options.planOnly ? false : result.started !== false,
    });
    return result.exitCode;
  } finally {
    await staged?.cleanup();
    await stagedObserver?.stop().catch(error => {
      process.stderr.write(`Cruise warning: pending changelog updates were not completed: ${displayError(error?.message)}\n`);
    });
    if (ownershipAcquired) {
      if (executableGoal) await deactivateGoalSession(reservation);
      else await releaseCruiseWorkspace(reservation);
    }
    if (warmRuntimeDirectory) await cleanupRuntimeSession(warmRuntimeDirectory, {
      cwd, sessionId: goalSessionId,
    });
  }
}

// Queue execution needs one ordinary supervised Goal without replacing the
// user's original build request in ORIGIN.md.
export async function runOneGoal(options, dependencies = {}) {
  const cwd = await validateWorkingDirectory(options.cwd);
  const goalSessionId = randomUUID();
  const reservation = { cwd, session_id: goalSessionId };
  await activateGoalSession(reservation);
  const runtimeDirectory = await runtimeSessionDirectory(reservation);
  try {
    return await runWithCommitChangelogObserver({
      cwd,
      provider: options.provider,
      runtimeDirectory,
      sessionId: goalSessionId,
      dependencies,
      operation: () => runHostedSession({
        ...options,
        skill: 'goal',
        goalSessionId,
        runtimeDirectory,
      }, cwd, dependencies),
    });
  } finally {
    await deactivateGoalSession(reservation);
  }
}

function queueSummary(queue) {
  const counts = new Map();
  for (const milestone of queue.milestones) {
    counts.set(milestone.status, (counts.get(milestone.status) ?? 0) + 1);
  }
  return [...counts.entries()].map(([status, count]) => `${status}=${count}`).join(', ') || 'empty';
}

function writeQueueStatus(queue, output) {
  for (const milestone of queue.milestones) {
    output.write(`${milestone.id}\t${milestone.status}\tdepends: ${milestone.depends.join(', ') || '-'}\n`);
  }
  output.write(`Queue summary: ${queueSummary(queue)}\n`);
}

async function requireQueue(cwd, queueReader) {
  const queue = await queueReader(cwd);
  if (!queue) throw new Error(`No valid .cruise/QUEUE.md found in ${cwd}.`);
  return queue;
}

export async function runQueueStatus(options, {
  queueReader = readQueue,
  output = process.stdout,
} = {}) {
  const cwd = await validateWorkingDirectory(options.cwd);
  writeQueueStatus(await requireQueue(cwd, queueReader), output);
  return 0;
}

function normalizedQueueResult(result) {
  const status = typeof result === 'string' ? result : result?.status;
  if (status === 'complete') return { status: 'complete', reason: result?.reason ?? 'completed' };
  if (status === 'stalled') return { status: 'stalled', reason: result?.reason ?? 'supervision stalled' };
  if (status === 'blocked') return { status: 'blocked', reason: result?.reason ?? 'reported a blocker' };
  return {
    status: 'blocked',
    reason: result?.reason ?? (status ? `session ended with ${status}` : 'session failed without a status'),
  };
}

export async function runQueueGoal({ cwd, provider, milestone, prompt }, {
  goalRunner = runOneGoal,
  flightReader = readFlightPlan,
} = {}) {
  const result = await goalRunner({ cwd, provider, prompt });
  if (result.status === 'stalled') return result;
  if (result.status !== 'complete') return result;
  const flight = await flightReader(cwd);
  if (flight?.status === 'blocked') return { status: 'blocked', reason: 'flight plan reported a blocker' };
  if (provider === 'claude' && flight?.status === 'active') {
    return { status: 'stalled', reason: 'Claude stopped after bounded supervision with the flight plan still active' };
  }
  if (flight?.status !== 'complete') {
    return { status: 'failed', reason: 'session ended before the flight plan recorded completion' };
  }
  if (flight.version < 2) {
    return { status: 'failed', reason: 'milestone completion requires an evidence-attested Flight v2 contract' };
  }
  const workspaceFingerprint = await captureWorkspaceFingerprint(cwd, { excludeFlightPlan: true });
  if (!workspaceFingerprint) {
    return { status: 'failed', reason: 'product workspace freshness could not be established' };
  }
  try {
    const assuranceContext = await captureFlightAssuranceContext(cwd, flight, {
      workspaceFingerprint,
      surfaceFingerprintReader: (paths) => captureWorkspaceFingerprint(cwd, {
        excludeFlightPlan: true,
        paths,
      }),
    });
    const assurance = evaluateFlightAssurance(flight, assuranceContext);
    if (!assurance.allowsCompletion) {
      return {
        status: 'failed',
        reason: `milestone completion is unassured: ${assurance.reasons.join('; ')}`,
      };
    }
  } catch (error) {
    return { status: 'failed', reason: displayError(error?.message) };
  }
  return { status: 'complete', reason: `milestone ${milestone.id} completed` };
}

function queueMilestoneContract(milestone) {
  return JSON.stringify({
    id: milestone.id,
    outcome: milestone.outcome,
    verify: milestone.verify,
    depends: milestone.depends,
    touchpoints: milestone.touchpoints,
    nonGoals: milestone.nonGoals,
    invariants: milestone.invariants,
    risk: milestone.risk ?? 'medium',
    profiles: milestone.profiles ?? ['core'],
  });
}

function queueMilestoneCheckpoint(queue) {
  const rawMilestones = Array.isArray(queue.raw?.milestones) ? queue.raw.milestones : [];
  return queue.milestones.map((milestone) => {
    const rawMilestone = rawMilestones.find((candidate) => (
      candidate && typeof candidate === 'object' && !Array.isArray(candidate) &&
      candidate.id === milestone.id
    ));
    return {
      id: milestone.id,
      contract: queueMilestoneContract(milestone),
      status: milestone.status,
      stopScope: milestone.stop_scope,
      serialized: structuredClone(rawMilestone ?? milestone),
    };
  });
}

function restoreQueueMilestoneCheckpoint(queue, checkpoint, activeMilestoneId) {
  const checkpointById = new Map(checkpoint.map((entry) => [entry.id, entry]));
  const currentById = new Map(queue.milestones.map((candidate) => [candidate.id, candidate]));
  const additions = queue.milestones.filter(({ id }) => !checkpointById.has(id));

  // Restore the pre-run membership and ordering without discarding new advisory work.
  // A missing entry uses its raw serialized checkpoint so unknown metadata survives.
  queue.milestones = checkpoint.map((entry) =>
    currentById.get(entry.id) ?? structuredClone(entry.serialized));
  queue.milestones.push(...additions);

  for (const entry of checkpoint) {
    const candidate = queue.milestones.find(({ id }) => id === entry.id);
    Object.assign(candidate, JSON.parse(entry.contract));
    if (entry.id !== activeMilestoneId) {
      candidate.status = entry.status;
      candidate.stop_scope = entry.stopScope ?? null;
    }
  }
}

function queueControlledFlightContract(flight) {
  return JSON.stringify({
    version: flight.version,
    outcome: flight.outcome,
    verify: flight.verify,
    scope: flight.scope,
    invariants: flight.invariants,
    risk: flight.quality?.risk,
    profiles: flight.quality?.profiles,
    body: flight.body,
  });
}

async function assessQueueFlightCompletion(cwd, expectedContract) {
  const flight = await readFlightPlan(cwd);
  if (!flight || flight.version < 2 || flight.status !== 'complete') {
    return {
      status: 'blocked',
      reason: 'queue runner requires a complete evidence-attested Flight v2 contract',
    };
  }
  if (queueControlledFlightContract(flight) !== expectedContract) {
    return {
      status: 'blocked',
      reason: 'terminal Flight no longer represents the milestone contract compiled by the queue runner',
    };
  }
  const workspaceFingerprint = await captureWorkspaceFingerprint(cwd, { excludeFlightPlan: true });
  if (!workspaceFingerprint) {
    return { status: 'blocked', reason: 'product workspace freshness could not be established' };
  }
  try {
    const assuranceContext = await captureFlightAssuranceContext(cwd, flight, {
      workspaceFingerprint,
      surfaceFingerprintReader: (paths) => captureWorkspaceFingerprint(cwd, {
        excludeFlightPlan: true,
        paths,
      }),
    });
    const assurance = evaluateFlightAssurance(flight, assuranceContext);
    return assurance.allowsCompletion
      ? { status: 'complete', reason: 'Flight v2 completion is freshly assured' }
      : {
          status: 'blocked',
          reason: `milestone completion is unassured: ${assurance.reasons.join('; ')}`,
        };
  } catch (error) {
    return { status: 'blocked', reason: displayError(error?.message) };
  }
}

export async function runQueue(options, {
  queueReader = readQueue,
  queueWriter = writeQueue,
  flightWriter = writeFlightPlan,
  milestoneRunner = runQueueGoal,
  userDocumentWriter = writeGoalUserDocuments,
  output = process.stdout,
} = {}) {
  const cwd = await validateWorkingDirectory(options.cwd);
  for (;;) {
    let queue = await requireQueue(cwd, queueReader);
    const priorStop = queue.milestones.find(({ status, stop_scope }) =>
      status === 'active' || stop_scope === 'global' ||
      (['blocked', 'stalled'].includes(status) && stop_scope !== 'local'));
    if (priorStop) {
      output.write(`Queue cannot advance past ${priorStop.id} (${priorStop.status}); reconcile the controlling condition and its advisory queue stop_scope/status before resuming.\n`);
      writeQueueStatus(queue, output);
      return priorStop.status === 'stalled' ? 3 : 2;
    }

    const pending = queue.milestones.filter(({ status }) => status === 'pending');
    if (!pending.length && queue.milestones.every(({ status }) => status === 'complete')) {
      await finalizeCruiseControlState(cwd, {
        status: 'complete',
        queueComplete: true,
      });
      writeQueueStatus(queue, output);
      return 0;
    }

    const milestone = nextReadyMilestone(queue, {
      warn(message) { output.write(`Queue warning: ${message}\n`); },
    });
    if (!milestone) {
      output.write('Queue remains incomplete; no pending milestone has complete dependencies.\n');
      writeQueueStatus(queue, output);
      return queue.milestones.some(({ status }) => status === 'stalled') ? 3 : 2;
    }

    milestone.status = 'active';
    milestone.stop_scope = null;
    queue = await queueWriter(cwd, queue);
    const milestoneCheckpoint = queueMilestoneCheckpoint(queue);
    const contractSnapshot = new Map(milestoneCheckpoint.map(({ id, contract }) => [id, contract]));
    const inheritedQueueBody = queue.body;
    const statusSnapshot = new Map(milestoneCheckpoint.map(({ id, status }) => [id, status]));
    const stopScopeSnapshot = new Map(milestoneCheckpoint.map(({ id, stopScope }) => [id, stopScope]));
    const prompt = [
      milestone.outcome,
      `This is queue milestone ${milestone.id}. Reconcile and execute the active plan in .cruise/FLIGHT.md, then keep its status truthful.`,
    ].join('\n\n');

    let rawResult;
    let expectedFlightContract = null;
    let goalStarted = false;
    try {
      const compiledFlight = milestoneToFlightPlan(milestone, queue.body);
      expectedFlightContract = queueControlledFlightContract(compiledFlight);
      await flightWriter(cwd, compiledFlight);
      output.write(`Running queue milestone ${milestone.id}: ${milestone.outcome}\n`);
      goalStarted = true;
      rawResult = await milestoneRunner({ cwd, provider: options.provider, milestone, prompt });
    } catch (error) {
      rawResult = { status: 'failed', reason: displayError(error?.message) };
    }
    let result = normalizedQueueResult(rawResult);
    // Runtime/transport/quota failures and integrity violations stop the run.
    // Only reported milestone blockers can leave unrelated units runnable.
    let localBlocker = ['blocked', 'stalled'].includes(
      typeof rawResult === 'string' ? rawResult : rawResult?.status,
    ) && rawResult?.stop_scope !== 'global';

    queue = await requireQueue(cwd, queueReader);
    const currentMilestoneIds = new Set(queue.milestones.map(({ id }) => id));
    const missingMilestones = milestoneCheckpoint.filter(({ id }) => !currentMilestoneIds.has(id));
    const addedMilestones = queue.milestones.filter(({ id }) => !contractSnapshot.has(id));
    const milestoneSetChanged = missingMilestones.length > 0 || addedMilestones.length > 0;
    const mutatedStatuses = queue.milestones.filter(({ id, status, stop_scope }) =>
      id !== milestone.id && statusSnapshot.has(id) && (statusSnapshot.get(id) !== status ||
        stopScopeSnapshot.get(id) !== stop_scope));
    const mutatedContracts = queue.milestones.filter((candidate) =>
      contractSnapshot.has(candidate.id) &&
      queueMilestoneContract(candidate) !== contractSnapshot.get(candidate.id));
    const activeContractChanged = mutatedContracts.some(({ id }) => id === milestone.id);
    const unexecutedContractChanges = mutatedContracts.filter(({ id }) => id !== milestone.id);
    const inheritedContextChanged = queue.body !== inheritedQueueBody;
    if (
      mutatedContracts.length ||
      inheritedContextChanged ||
      milestoneSetChanged ||
      mutatedStatuses.length
    ) {
      localBlocker = false;
      // Keep the original dependency closure and assurance obligations on disk.
      // Advisory fields are intentionally outside the controlled contract.
      restoreQueueMilestoneCheckpoint(queue, milestoneCheckpoint, milestone.id);
      const activeMilestoneMissing = missingMilestones.some(({ id }) => id === milestone.id);
      const missingUnexecutedMilestones = missingMilestones.filter(({ id }) => id !== milestone.id);
      result = {
        status: 'blocked',
        reason: [
          activeMilestoneMissing
            ? `the active milestone was deleted or renamed and its pre-run contract was restored: ${milestone.id}`
            : null,
          missingUnexecutedMilestones.length
            ? `unexecuted milestone contract deleted or renamed and restored: ${missingUnexecutedMilestones.map(({ id }) => id).join(', ')}`
            : null,
          activeContractChanged ? 'the active milestone contract changed while it was running' : null,
          unexecutedContractChanges.length
            ? `unexecuted milestone contract changed: ${unexecutedContractChanges.map(({ id }) => id).join(', ')}`
            : null,
          inheritedContextChanged ? 'the inherited queue obligations changed while it was running' : null,
          milestoneSetChanged ? 'the queue milestone set changed while a milestone was running' : null,
          addedMilestones.length
            ? `new milestone entries retained for explicit reconciliation: ${addedMilestones.map(({ id }) => id).join(', ')}`
            : null,
          mutatedStatuses.length
            ? `unexecuted milestone status changed: ${mutatedStatuses.map(({ id }) => id).join(', ')}`
            : null,
        ].filter(Boolean).join('; '),
      };
    } else if (result.status === 'complete') {
      result = await assessQueueFlightCompletion(cwd, expectedFlightContract);
    }
    const current = queue.milestones.find(({ id }) => id === milestone.id);
    current.status = result.status;
    // Persist provenance: rerunning the command cannot clear a global stop.
    current.stop_scope = result.status === 'complete' ? null : localBlocker ? 'local' : 'global';
    await queueWriter(cwd, queue);
    await userDocumentWriter({
      cwd,
      prompt,
      provider: options.provider,
      status: result.status,
      started: goalStarted,
      startedAt: null,
      endedAt: new Date().toISOString(),
      sessionId: `queue:${milestone.id}`,
      reason: result.reason,
      includeFlight: goalStarted,
    }).catch((error) => {
      output.write(`Queue warning: user documents were not updated: ${displayError(error?.message)}\n`);
    });
    await finalizeCruiseControlState(cwd, {
      status: result.status,
      keepOrigin: true,
    });

    if (result.status === 'complete') {
      output.write(`Completed queue milestone ${milestone.id}.\n`);
      continue;
    }
    output.write(`Queue stopped at ${milestone.id} (${result.status}): ${result.reason}.\n`);
    if (localBlocker && nextReadyMilestone(queue, { warn() {} })) {
      output.write('Continuing independent queue milestones; blocked dependencies remain pending.\n');
      continue;
    }
    return result.status === 'stalled' ? 3 : 2;
  }
}

export async function runWorker(options, {
  worker = null,
  claudeWorker = runClaudeWorker,
  budgetClientFactory = (input) => new AppServerClient(input),
  quotaGuardFactory = (input) => new QuotaGuard(input),
  dispatchLedgerFactory = (input) => new WorkerDispatchLedger(input),
  enforceBudget = worker === null,
} = {}) {
  const cwd = await validateWorkingDirectory(options.cwd);
  const provider = resolveProvider(options.provider);
  const selectedWorker = provider === 'claude' ? claudeWorker : worker ?? runSimpleWorker;
  const managed = provider === 'codex' && options.managedWorker === true;
  const exceptionalRecord = options.exceptionalConsequence
    ? {
        consequence: options.exceptionalConsequence,
        rationale: options.exceptionalRationale,
      }
    : null;
  if (
    options.reasoningEscalationEvidence !== undefined &&
    (typeof options.reasoningEscalationEvidence !== 'string' || !options.reasoningEscalationEvidence.trim())
  ) {
    throw new Error('reasoning escalation evidence must be non-empty text');
  }
  if (
    options.reasoningEscalationEvidence !== undefined &&
    !(
      managed &&
      options.workerComplexity === 'repeated' &&
      options.level === 7 &&
      exceptionalRecord
    )
  ) {
    throw new Error(
      'reasoning escalation evidence requires a managed Codex worker at explicit L7 with repeated complexity '
      + 'and an exceptional-consequence record',
    );
  }
  const route = managed
    ? routeWorkerTask({
        task: options.prompt,
        complexity: options.workerComplexity ?? 'bounded',
        exceptionalConsequence: exceptionalRecord,
      })
    : null;
  const selectedLevel = managed
    ? Math.max(options.level ?? 1, route.recommended_level)
    : options.level ?? null;
  if (options.reasoningEscalationEvidence !== undefined && route.recommended_level !== 6) {
    throw new Error('reasoning escalation evidence requires an L6 routed work item');
  }
  if (selectedLevel === 7 && !exceptionalRecord) {
    throw new Error('L7 requires an explicit exceptional-consequence record');
  }
  if (managed) {
    for (const [value, label] of [
      [options.workerOwnership, 'ownership'],
      [options.workerEvidence, 'evidence'],
      [options.workerRanges, 'relevant ranges'],
      [options.workerVerification, 'focused verification'],
    ]) {
      if (!Array.isArray(value) || value.length === 0) throw new Error(`managed worker capsule requires ${label}`);
    }
  }
  const capsule = managed ? buildContextCapsule({
    task: options.prompt,
    nonGoals: ['Do not expand beyond the single assigned work item.'],
    evidence: [
      ...options.workerEvidence,
      ...(options.reasoningEscalationEvidence === undefined ? [] : [options.reasoningEscalationEvidence]),
    ],
    relevantRanges: options.workerRanges,
    invariants: ['Preserve repository safety, privacy, assurance, and human-gate controls.'],
    ownership: options.workerOwnership,
    verification: options.workerVerification,
    uncertainty: ['Stop and report uncertainty that requires paths outside the capsule.'],
    stopConditions: ['Stop after the bounded work item and focused evidence are complete.'],
    escalationConditions: ['Escalate only with new discriminating evidence; never for tool or transport failure.'],
  }) : null;
  let workerTransition = null;
  if (options.reasoningEscalationEvidence !== undefined) {
    workerTransition = Object.freeze({
      kind: 'escalation',
      work_item: route.task,
      evidence: options.reasoningEscalationEvidence,
      from_level: 6,
      failure_category: 'reasoning',
      exceptional_consequence: exceptionalRecord,
    });
  }
  if (capsule) await writeContextCapsule(cwd, capsule);
  const sessionId = randomUUID();
  const reservation = { cwd, session_id: sessionId };
  const runtimeDirectory = await reserveCruiseWorkspace(reservation);
  let budgetClient = null;
  let quotaGuard = null;
  let dispatchLease = null;
  try {
    if (managed) {
      dispatchLease = await dispatchLedgerFactory({ cwd }).reserve({
        debugProbeKey: options.debugProbeKey ?? null,
        expansionEvidence: options.expansionEvidence ?? null,
      });
    }
    if (provider === 'codex' && enforceBudget) {
      budgetClient = budgetClientFactory({
        spawnOptions: { cwd },
        clientInfo: { name: 'cruise', title: 'Cruise', version: CLI_VERSION },
      });
      quotaGuard = quotaGuardFactory({
        cwd,
        weeklyDeltaCap: options.weeklyDeltaCap,
        goalReservation: options.goalReservation,
        strictBudget: options.strictBudget,
        resumeCommand: `cruise worker --weekly-delta-cap ${options.weeklyDeltaCap} --goal-reservation ${options.goalReservation} -C ${JSON.stringify(cwd)} <task>`,
      });
      await budgetClient.start();
      await quotaGuard.start({ client: budgetClient, goalId: `worker:${sessionId}` });
    }
    const result = await selectedWorker({
      cwd,
      task: capsule
        ? `${capsule.serialized}\n${WORKER_HANDOFF_SCHEMA_INSTRUCTIONS}`
        : options.prompt,
      level: selectedLevel,
      readOnly: Boolean(options.workerReadOnly),
      exceptionalConsequence: exceptionalRecord,
      transition: workerTransition,
      runtimeDirectory,
      sessionId,
      onOutput(delta) {
        process.stdout.write(delta);
      },
      onServerRequest: (message, client, authorizationEvidence) => answerWorkerRequest(message, { client, authorizationEvidence }),
    });
    if (managed) {
      const handoff = parseWorkerHandoff(result.output);
      await writeRootHandoff(cwd, handoff);
    }
    if (result.output && !result.output.endsWith('\n')) process.stdout.write('\n');
    return 0;
  } catch (error) {
    if (error?.code === 'CRUISE_BUDGET_PAUSE') {
      process.stderr.write(`cruise: ${displayError(error.message)}\n`);
      return BUDGET_PAUSE_EXIT_CODE;
    }
    throw error;
  } finally {
    const cleanupErrors = [];
    for (const [label, action] of [
      ['quota reservation release', () => quotaGuard?.release()],
      ['worker dispatch release', () => dispatchLease?.release()],
      ['budget client stop', () => budgetClient?.stop()],
      ['workspace release', () => releaseCruiseWorkspace(reservation)],
    ]) {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(new Error(`${label} failed: ${displayError(error?.message)}`, { cause: error }));
      }
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'managed worker cleanup failed');
  }
}

export async function runUsage(options, {
  read = readFile,
  output = process.stdout,
} = {}) {
  const cwd = await validateWorkingDirectory(options.cwd);
  let usage;
  try {
    usage = JSON.parse(await read(resolve(cwd, '.cruise', 'USAGE.json'), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    usage = {
      schema_version: 1,
      accounting_known: false,
      observed_threads: 0,
      estimated_credits: null,
      reason: 'no local usage summary is available',
    };
  }
  if (options.json) output.write(`${JSON.stringify(usage)}\n`);
  else {
    output.write(`Cruise usage accounting: ${usage.accounting_known ? 'known' : 'unknown'}\n`);
    output.write(`Observed threads: ${usage.observed_threads ?? 0}\n`);
    output.write(`Estimated credits: ${usage.estimated_credits ?? 'unknown'}\n`);
    if (usage.reason) output.write(`Reason: ${usage.reason}\n`);
  }
  return 0;
}

export async function runBudget(options, {
  clientFactory = (input) => new AppServerClient(input),
  quotaGuardFactory = (input) => new QuotaGuard(input),
  output = process.stdout,
} = {}) {
  const cwd = await validateWorkingDirectory(options.cwd);
  const client = clientFactory({
    spawnOptions: { cwd },
    clientInfo: { name: 'cruise', title: 'Cruise', version: CLI_VERSION },
  });
  const guard = quotaGuardFactory({
    cwd,
    weeklyDeltaCap: options.weeklyDeltaCap,
    goalReservation: options.goalReservation,
    strictBudget: options.strictBudget,
    resumeCommand: `cruise budget --strict-budget --weekly-delta-cap ${options.weeklyDeltaCap} --goal-reservation ${options.goalReservation} -C ${JSON.stringify(cwd)}`,
  });
  try {
    await client.start();
    const status = await guard.status(client);
    const report = {
      metered: status.metered,
      used_percent: status.usedPercent ?? null,
      baseline_used_percent: status.baselineUsedPercent ?? null,
      observed_delta_percent: status.observedDelta ?? null,
      active_reservations_percent: status.activeReservations ?? null,
      weekly_delta_cap_percent: options.weeklyDeltaCap,
      goal_reservation_percent: options.goalReservation,
      resets_at: status.resetsAt ?? null,
      remaining_percent: status.remaining ?? null,
      ...(status.reason ? { reason: status.reason } : {}),
    };
    if (options.json) output.write(`${JSON.stringify(report)}\n`);
    else {
      output.write(`Cruise weekly budget: ${report.metered ? 'metered' : 'unmetered'}\n`);
      output.write(`Observed campaign delta: ${report.observed_delta_percent ?? 'unknown'}%\n`);
      output.write(`Active reservations: ${report.active_reservations_percent ?? 'unknown'}%\n`);
      output.write(`Remaining before safety margin: ${report.remaining_percent ?? 'unknown'}%\n`);
      output.write(`Resets at: ${report.resets_at ?? 'unknown'}\n`);
      if (report.reason) output.write(`Reason: ${report.reason}\n`);
    }
    return 0;
  } catch (error) {
    if (error?.code === 'CRUISE_BUDGET_PAUSE') {
      if (options.json) output.write(`${JSON.stringify(error.report)}\n`);
      else output.write(`Cruise weekly budget: paused (${error.message})\n`);
      return BUDGET_PAUSE_EXIT_CODE;
    }
    throw error;
  } finally {
    await client.stop().catch(() => {});
  }
}

export async function runReference(options, {
  userDocumentWriter = writeGoalUserDocuments,
  controlFinalizer = finalizeCruiseControlState,
  output = process.stdout,
} = {}) {
  const cwd = await validateWorkingDirectory(options.cwd);
  if (!options.userStatus) throw new Error('cruise reference requires --status.');
  const prompt = await readOriginPrompt(cwd).catch(() => '');
  const result = await userDocumentWriter({
    cwd,
    prompt,
    provider: options.provider,
    status: options.userStatus,
    started: options.userStatus !== 'not_started',
    startedAt: null,
    endedAt: new Date().toISOString(),
    sessionId: 'direct-host',
    includeFlight: options.userStatus !== 'not_started',
  });
  await controlFinalizer(cwd, {
    status: options.userStatus === 'completed' ? 'complete' : options.userStatus,
    started: options.userStatus !== 'not_started',
  });
  output.write(`Updated ${result.referencePath}.\n`);
  return 0;
}

export async function runCommitChangelog(options, {
  observerFactory = createCommitChangelogObserver,
  runtimeFactory = createRuntimeSession,
  runtimeCleanup = cleanupRuntimeSession,
  output = process.stdout,
} = {}) {
  const cwd = await validateWorkingDirectory(options.cwd);
  const sessionId = `direct-changelog-${randomUUID()}`;
  const runtimeDirectory = await runtimeFactory({
    cwd,
    sessionId,
    kind: 'changelog',
  });
  try {
    const observer = observerFactory({
      cwd,
      provider: options.provider,
      runtimeDirectory,
      sessionId,
    });
    await observer.processCommit(options.commit);
    output.write(`Recorded commit ${options.commit} in the user changelog.\n`);
    return 0;
  } finally {
    await runtimeCleanup(runtimeDirectory, { cwd, sessionId });
  }
}

export async function answerWorkerRequest(message, {
  client = null,
  authorizationEvidence = {},
  picker = pickOne,
  readLine = readLineOnce,
} = {}) {
  const params = message.params ?? {};
  if (message.method === 'item/tool/requestUserInput') {
    const answers = {};
    for (const question of params.questions ?? []) {
      const automatic = automaticDelegationAuthorization({ questions: [question] }, authorizationEvidence);
      if (automatic) {
        Object.assign(answers, automatic.answers);
        continue;
      }
      await awaitHumanInput(client, async () => {
        const options = Array.isArray(question.options) ? question.options : [];
        if (options.length > 0) {
          const selection = await picker({
            title: `${question.header ?? ''}: ${question.question ?? ''}`.replace(/^: /u, ''),
            options,
          });
          const value = selection?.value ?? selection?.label;
          if (value == null) throw new SimpleCruiseInterruptedError();
          answers[question.id] = { answers: [String(value)] };
        } else {
          answers[question.id] = { answers: [await readLine({ prompt: `${question.question}: ` })] };
        }
      });
    }
    return { answers };
  }
  if ([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
  ].includes(message.method)) {
    return awaitHumanInput(client, async () => {
      const selection = await picker({
        title: params.reason ?? params.command ?? 'Approve this action?',
        options: (params.availableDecisions ?? ['accept', 'decline']).map((value) => ({
          label: String(value),
          value,
        })),
      });
      const decision = selection?.value ?? selection?.label ?? 'decline';
      return message.method === 'item/permissions/requestApproval'
        ? { permissions: decision === 'accept' ? params.permissions ?? {} : {}, scope: 'turn' }
        : { decision };
    });
  }
  throw new Error(`Cruise worker does not support ${message.method}`);
}

async function awaitHumanInput(client, callback) {
  client?.pauseInactivityWatchdog?.();
  try {
    return await callback();
  } finally {
    client?.resumeInactivityWatchdog?.();
  }
}

export function doctorProbeTimeoutMs(value = process.env.CRUISE_DOCTOR_PROBE_TIMEOUT_MS) {
  if (value === undefined) return 60_000;
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new TypeError('CRUISE_DOCTOR_PROBE_TIMEOUT_MS must be an integer from 0 through 2147483647 (0 disables the deadline).');
  }
  return parsed;
}

export { command as runDoctorCommand };
function command(command, args, { timeoutMs = doctorProbeTimeoutMs() } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs });
  return {
    status: result.status,
    output: String(result.stdout ?? '').trim(),
    error: result.error?.message ?? String(result.stderr ?? '').trim(),
  };
}

export const CODEX_PLUGIN_FRESHNESS_PATHS = Object.freeze([
  '.codex-plugin/plugin.json',
  'skills/build/SKILL.md',
  'skills/quick/SKILL.md',
  'skills/goal/SKILL.md',
  'skills/debug/SKILL.md',
  'scripts/cruise.mjs',
  'scripts/lib/simple-session.mjs',
  'scripts/lib/authorization-policy.mjs',
]);

function criticalPluginDigest(root) {
  const canonicalRoot = realpathSync(root);
  const hash = createHash('sha256');
  for (const relativePath of CODEX_PLUGIN_FRESHNESS_PATHS) {
    const candidate = resolve(canonicalRoot, relativePath);
    const metadata = lstatSync(candidate);
    const canonicalCandidate = realpathSync(candidate);
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || !canonicalCandidate.startsWith(`${canonicalRoot}${sep}`)
    ) {
      throw new Error(`unsafe critical plugin file: ${relativePath}`);
    }
    hash.update(relativePath);
    hash.update('\0');
    hash.update(readFileSync(canonicalCandidate));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function codexPluginContentFreshness(plugin, {
  codexHomeDirectory = join(homedir(), '.codex'),
  packageRoot = PACKAGE_ROOT,
} = {}) {
  const safeSegment = /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/u;
  const marketplace = plugin?.marketplaceName;
  const name = plugin?.name;
  const version = plugin?.version;
  if (![marketplace, name, version].every((value) => typeof value === 'string' && safeSegment.test(value))) {
    return { status: 'fail', detail: 'Codex plugin metadata cannot identify a safe cache path' };
  }
  const configuredSource = plugin?.source?.path;
  const sourceRoot = typeof configuredSource === 'string' && isAbsolute(configuredSource)
    ? configuredSource
    : packageRoot;
  const installedRoot = join(codexHomeDirectory, 'plugins', 'cache', marketplace, name, version);
  try {
    const sourceDigest = criticalPluginDigest(sourceRoot);
    const installedDigest = criticalPluginDigest(installedRoot);
    return sourceDigest === installedDigest
      ? { status: 'pass', detail: `Cruise ${version} cache matches its configured source` }
      : { status: 'fail', detail: `Cruise ${version} cache is stale; reinstall ${name}@${marketplace}; active jobs selectively reconcile instruction drift without a waiver or forced restart` };
  } catch (error) {
    return {
      status: 'fail',
      detail: `Cruise plugin content could not be verified: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function localDoctorReport(
  run = command,
  {
    provider = 'codex',
    pluginRoot = PACKAGE_ROOT,
    pluginFreshness = codexPluginContentFreshness,
  } = {},
) {
  const definition = providerDefinition(provider);
  const version = run(definition.command, ['--version']);
  if (definition.id === 'claude') {
    const plugin = run('claude', ['plugin', 'validate', pluginRoot]);
    const auth = run('claude', ['auth', 'status']);
    const health = run('claude', ['doctor']);
    let authDetail = auth.output || auth.error || 'Claude authentication status is unavailable';
    try {
      const parsed = JSON.parse(auth.output);
      authDetail = parsed.loggedIn
        ? `authenticated${parsed.email ? ` as ${parsed.email}` : ''}`
        : 'Claude Code is not authenticated';
    } catch {
      // Preserve the CLI's own diagnostic when it did not return JSON.
    }
    const checks = [
      { id: 'claude', status: version.status === 0 ? 'pass' : 'fail', detail: version.output || version.error || 'Claude Code is unavailable' },
      { id: 'claude-plugin', status: plugin.status === 0 ? 'pass' : 'fail', detail: plugin.status === 0 ? 'Claude plugin is valid' : plugin.error || plugin.output || 'Claude plugin validation failed' },
      { id: 'claude-auth', status: auth.status === 0 ? 'pass' : 'fail', detail: authDetail },
      { id: 'claude-health', status: health.status === 0 ? 'pass' : 'fail', detail: health.status === 0 ? 'Claude installation health passed' : health.error || health.output || 'Claude doctor failed' },
    ];
    return { provider: definition.id, ok: checks.every(({ status }) => status === 'pass'), checks };
  }
  const appServer = run('codex', ['app-server', '--help']);
  const pluginList = run('codex', ['plugin', 'list', '--json']);
  let pluginDetail = pluginList.error || pluginList.output || 'Codex plugin status is unavailable';
  let pluginReady = false;
  let contentCheck = {
    status: 'fail',
    detail: 'Cruise plugin content check requires a matching installed version',
  };
  if (pluginList.status === 0) {
    try {
      const installed = JSON.parse(pluginList.output).installed ?? [];
      const cruise = installed.find(({ name }) => name === 'cruise');
      pluginReady = Boolean(
        cruise &&
        cruise.installed === true &&
        cruise.enabled === true &&
        cruise.version === CLI_VERSION
      );
      pluginDetail = !cruise
        ? `Cruise ${CLI_VERSION} is not installed in Codex`
        : !cruise.enabled
          ? `Cruise ${cruise.version} is installed but disabled`
          : cruise.version !== CLI_VERSION
            ? `Codex has Cruise ${cruise.version}; this package is ${CLI_VERSION}`
            : `Cruise ${cruise.version} is installed and enabled`;
      if (pluginReady) contentCheck = pluginFreshness(cruise, { packageRoot: pluginRoot });
    } catch {
      pluginDetail = 'Codex plugin list did not return valid JSON';
    }
  }
  const checks = [
    { id: 'codex', status: version.status === 0 ? 'pass' : 'fail', detail: version.output || version.error || 'Codex is unavailable' },
    { id: 'app-server', status: appServer.status === 0 ? 'pass' : 'fail', detail: appServer.status === 0 ? 'app-server is available' : appServer.error || 'app-server is unavailable' },
    { id: 'codex-plugin', status: pluginReady ? 'pass' : 'fail', detail: pluginDetail },
    { id: 'codex-plugin-content', ...contentCheck },
  ];
  return { provider: definition.id, ok: checks.every(({ status }) => status === 'pass'), checks };
}

export async function runAttest(options, {
  output = process.stdout,
  planInspector = inspectFlightPlan,
  fingerprintCapture = captureWorkspaceFingerprint,
} = {}) {
  const cwd = await validateWorkingDirectory(options.cwd);
  const inspection = await planInspector(cwd);
  if (inspection.state !== 'valid') {
    throw new Error(
      inspection.state === 'invalid'
        ? `Invalid .cruise/FLIGHT.md: ${inspection.reason}`
        : `No .cruise/FLIGHT.md found in ${cwd}.`,
    );
  }
  const { plan } = inspection;
  let assuranceContext = null;
  if (plan.version >= 2) {
    const workspaceFingerprint = await fingerprintCapture(cwd, { excludeFlightPlan: true });
    if (!workspaceFingerprint) throw new Error('Product workspace fingerprint is unavailable.');
    assuranceContext = await captureFlightAssuranceContext(cwd, plan, {
      workspaceFingerprint,
      surfaceFingerprintReader: (paths) => fingerprintCapture(cwd, {
        excludeFlightPlan: true,
        paths,
      }),
    });
  }
  const contextFingerprint = assuranceContext?.contextFingerprint ?? null;
  const assurance = evaluateFlightAssurance(plan, assuranceContext);
  const report = {
    version: plan.version,
    status: plan.status,
    level: assurance.level,
    contract_closed: assurance.contractClosed,
    ready_for_completion: assurance.readyForCompletion,
    allows_completion: assurance.allowsCompletion,
    context_fingerprint: contextFingerprint,
    gate_fingerprints: assuranceContext?.gateFingerprints ?? {},
    metrics: assurance.metrics,
    reasons: assurance.reasons,
  };
  if (options.json) output.write(`${JSON.stringify(report)}\n`);
  else {
    output.write(`Cruise assurance: ${report.level}\n`);
    output.write(`Context fingerprint: ${contextFingerprint ?? 'legacy-unavailable'}\n`);
    output.write(`Gates: ${report.metrics.closed}/${report.metrics.total} closed\n`);
    output.write(`Ready for completion: ${report.ready_for_completion ? 'yes' : 'no'}\n`);
    output.write(`Completion accepted: ${report.allows_completion ? 'yes' : 'no'}\n`);
    for (const reason of report.reasons) output.write(`- ${reason}\n`);
  }
  return assurance.readyForCompletion ? 0 : 2;
}

async function runDoctor({ json, provider }) {
  const report = localDoctorReport(command, { provider });
  if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else {
    for (const check of report.checks) process.stdout.write(`${check.status === 'pass' ? 'ok' : 'fail'}    ${check.id}: ${check.detail}\n`);
    process.stdout.write(report.ok ? 'Cruise is ready.\n' : 'Cruise doctor found local issues.\n');
  }
  return report.ok ? 0 : 1;
}

function publicMigrationValue(value) {
  if (Array.isArray(value)) return value.map(publicMigrationValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['sql', 'statement'].includes(key))
      .map(([key, item]) => [key, publicMigrationValue(item)]));
  }
  return value;
}

function writeStructuredResult(value, { json, output }) {
  const safe = publicMigrationValue(value);
  if (json) {
    output.write(`${JSON.stringify(safe)}\n`);
    return;
  }
  if (safe.state) output.write(`Cruise migration: ${safe.state}\n`);
  if (safe.profile) output.write(`Repository profile: ${safe.profile}\n`);
  if (safe.decision?.reason) output.write(`Decision: ${safe.decision.reason}\n`);
  if (safe.decision?.digest) output.write(`SQL digest: ${safe.decision.digest}\n`);
  if (safe.decision?.affectedTables?.length) output.write(`Affected tables: ${safe.decision.affectedTables.join(', ')}\n`);
  if (safe.decision?.domains?.length) output.write(`Database domains: ${safe.decision.domains.join(', ')}\n`);
  if (safe.decision?.riskFactors?.length) {
    output.write('Risk evidence:\n');
    for (const factor of safe.decision.riskFactors) output.write(`- ${factor}\n`);
  }
  if (safe.reason && safe.reason !== safe.decision?.reason) output.write(`Reason: ${safe.reason}\n`);
  if (safe.failed?.length) for (const failure of safe.failed) output.write(`- ${failure}\n`);
  if (safe.choices?.length) {
    output.write('Available choices:\n');
    for (const choice of safe.choices) output.write(`- ${choice.value}: ${choice.label}\n`);
  }
  if (!safe.state) output.write(`${JSON.stringify(safe, null, 2)}\n`);
}

export async function runConfigCommand(options, {
  configLoader = loadCruiseConfig,
  output = process.stdout,
} = {}) {
  const cwd = await validateWorkingDirectory(options.cwd);
  const config = await configLoader(cwd);
  const report = {
    state: 'valid',
    source: config.source,
    schemaVersion: config.schemaVersion,
    profile: config.profile,
    workflow: config.workflow,
    targets: config.migration.targets,
    domains: config.migration.domains,
    validation: {
      commands: config.migration.validation.commands.map(({ name }) => name),
      flows: config.migration.validation.flows.map(({ name, path, critical }) => ({ name, path, critical })),
      policyChecks: config.migration.policyChecks.map(({ name }) => name),
    },
  };
  writeStructuredResult(report, { json: options.json, output });
  return 0;
}

async function sessionMigrationRoute(runtimeDirectory) {
  if (!runtimeDirectory) return null;
  try {
    const parsed = JSON.parse(await readFile(resolve(runtimeDirectory, 'migration-route.json'), 'utf8'));
    return ['auto', 'manual'].includes(parsed?.sandboxFirst) ? parsed.sandboxFirst : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function runMigrationCommand(options, {
  configLoader = loadCruiseConfig,
  adapterFactory = ({ cwd, config }) => new SupabaseCliMigrationAdapter({ cwd, config }),
  controllerFactory = (input) => new MigrationController(input),
  output = process.stdout,
} = {}) {
  const cwd = await validateWorkingDirectory(options.cwd);
  if (options.migrationAction === 'route') {
    if (!options.runtimeDirectory) throw new Error('cruise migrate route is session-only and requires an active Cruise runtime.');
    const runtimeDirectory = resolve(options.runtimeDirectory);
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(runtimeDirectory, 'migration-route.json'), `${JSON.stringify({
      sandboxFirst: options.sandboxFirst,
      setAt: Date.now(),
    })}\n`, { mode: 0o600 });
    writeStructuredResult({ state: 'route-set', sandboxFirst: options.sandboxFirst }, { json: options.json, output });
    return 0;
  }
  const config = await configLoader(cwd);
  const adapter = adapterFactory({ cwd, config });
  const controller = controllerFactory({ cwd, config, adapter });
  let response;
  if (options.migrationAction === 'status') {
    response = controller.status();
  } else if (options.migrationAction === 'inspect') {
    response = await controller.inspect({
      targetName: options.targetName,
      paths: options.migrationPaths,
    });
  } else if (options.migrationAction === 'query') {
    response = await controller.apply({
      targetName: options.targetName,
      paths: [options.sqlFile],
      mode: 'query',
    });
  } else {
    const storedRoute = await sessionMigrationRoute(options.runtimeDirectory);
    const route = options.sandboxFirst === 'off'
      ? false
      : options.sandboxFirst ?? storedRoute ?? null;
    response = await controller.apply({
      targetName: options.targetName,
      paths: options.migrationPaths,
      sandboxFirst: route,
      authorization: options.authorizationDigest
        ? { digest: options.authorizationDigest, target: options.targetName, environment: 'production' }
        : null,
    });
  }
  writeStructuredResult(response, { json: options.json, output });
  return [
    'valid',
    'inspected',
    'applied',
    'already-applied',
    'queried',
    'promoted',
  ].includes(response.state) || !response.state ? 0 : 2;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`cruise: ${displayError(error.message)}\nTry 'cruise --help'.\n`);
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
    if (options.command === 'config') return await runConfigCommand(options);
    if (options.command === 'migrate') return await runMigrationCommand(options);
    if (options.command === 'attest') return await runAttest(options);
    if (options.command === 'usage') return await runUsage(options);
    if (options.command === 'budget') return await runBudget(options);
    if (options.command === 'reference') return await runReference(options);
    if (options.command === 'changelog') return await runCommitChangelog(options);
    if (options.command === 'worker') return await runWorker(options);
    if (options.command === 'queue') {
      return options.queueAction === 'status' ? await runQueueStatus(options) : await runQueue(options);
    }
    return await runStart(options);
  } catch (error) {
    process.stderr.write(`cruise: ${displayError(error.message)}\n`);
    return 1;
  }
}

async function invokedAsMain() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  const [entry, module] = await Promise.all([
    realpath(invoked).catch(() => resolve(invoked)),
    realpath(SCRIPT_PATH).catch(() => SCRIPT_PATH),
  ]);
  return entry === module;
}

if (await invokedAsMain()) process.exitCode = await main();
