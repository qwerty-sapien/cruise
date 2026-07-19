#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { stat, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AppServerClient } from './lib/app-server-client.mjs';
import { writeOriginPrompt } from './lib/origin-note.mjs';
import { pickOne } from './lib/picker.mjs';
import {
  SimpleCruiseInterruptedError,
  SimpleCruiseSession,
} from './lib/simple-session.mjs';
import { runSimpleWorker } from './lib/simple-worker.mjs';

export const CLI_VERSION = '0.2.1';
export const PUBLIC_SKILLS = Object.freeze(['build', 'quick', 'refine', 'goal', 'debug']);

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SKILLS_ROOT = resolve(fileURLToPath(new URL('../skills/', import.meta.url)));

const HELP = `Cruise ${CLI_VERSION} — a thin Codex task launcher

Usage:
  cruise [start] [-C <directory>] <request...>
  cruise <build|quick|refine|goal|debug> [-C <directory>] <request...>
  cruise worker [--level <1-7>] [-C <directory>] <task...>
  cruise doctor [--json]
  cruise picker-demo

Cruise records only the exact request in .cruise/ORIGIN.md. It has no
Cruise-owned approval authority, archive, YAML workflow, packet, report,
digest, run directory, or retry ledger. Codex's normal approvals and native
Goal state remain the authority for work and effects.
`;

function displayError(value) {
  return String(value ?? 'Unknown Cruise error')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function parseArgs(argv) {
  const args = [...argv];
  if (args[0] === 'config') {
    throw new Error('Cruise has no persistent config command. State worker-level or communication-style preferences in the current $cruise:<skill> request.');
  }
  let command = 'start';
  if (['start', ...PUBLIC_SKILLS, 'worker', 'doctor', 'picker-demo', 'help'].includes(args[0])) {
    command = args.shift();
  }
  const options = {
    command,
    skill: PUBLIC_SKILLS.includes(command) ? command : 'goal',
    cwd: process.cwd(),
    json: false,
    help: false,
    version: false,
    level: null,
    promptParts: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      options.promptParts.push(...args.slice(index + 1));
      break;
    }
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '-V' || arg === '--version') options.version = true;
    else if (arg === '--json' && command === 'doctor') options.json = true;
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
    else if (arg === '-C' || arg === '--cwd') {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a directory.`);
      options.cwd = resolve(value);
    } else if (arg.startsWith('-')) {
      throw new Error(`${arg} is not supported by the prompt-only Cruise runtime.`);
    } else if (command === 'doctor' || command === 'picker-demo') {
      throw new Error(`Unexpected ${command} argument: ${arg}`);
    } else options.promptParts.push(arg);
  }
  if (options.json && command !== 'doctor') throw new Error('--json is supported only by cruise doctor.');
  const prompt = options.promptParts.join(' ');
  if (!options.help && !options.version && !['doctor', 'picker-demo', 'help'].includes(command) && !prompt) {
    throw new Error('Cruise requires a request.');
  }
  return { ...options, prompt };
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

async function validateWorkingDirectory(cwd) {
  const metadata = await stat(cwd);
  if (!metadata.isDirectory()) throw new Error(`Not a directory: ${cwd}`);
  return realpath(cwd);
}

export async function runStart(
  options,
  { clientFactory = (input) => new AppServerClient(input) } = {},
) {
  const cwd = await validateWorkingDirectory(options.cwd);
  await writeOriginPrompt(cwd, options.prompt);
  const client = clientFactory({
    spawnOptions: { cwd },
    clientInfo: { name: 'cruise', title: 'Cruise', version: CLI_VERSION },
    onError(error) {
      process.stderr.write(`Cruise warning: ${displayError(error.message)}\n`);
    },
  });
  const session = new SimpleCruiseSession({
    client,
    cwd,
    prompt: options.prompt,
    skill: options.skill,
    skillPath: resolve(SKILLS_ROOT, options.skill, 'SKILL.md'),
    pickOne,
    readLine: readLineOnce,
  });
  const onSigint = () => void session.interrupt();
  process.on('SIGINT', onSigint);
  try {
    const result = await session.run();
    return result.status === 'complete' ? 0 : 2;
  } catch (error) {
    if (error instanceof SimpleCruiseInterruptedError) return 130;
    throw error;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

export async function runWorker(options, { worker = runSimpleWorker } = {}) {
  const cwd = await validateWorkingDirectory(options.cwd);
  const result = await worker({
    cwd,
    task: options.prompt,
    level: options.level ?? null,
    onOutput(delta) {
      process.stdout.write(delta);
    },
    onServerRequest: (message) => answerWorkerRequest(message),
  });
  if (result.output && !result.output.endsWith('\n')) process.stdout.write('\n');
  return 0;
}

async function answerWorkerRequest(message) {
  const params = message.params ?? {};
  if (message.method === 'item/tool/requestUserInput') {
    const answers = {};
    for (const question of params.questions ?? []) {
      const options = Array.isArray(question.options) ? question.options : [];
      if (options.length > 0) {
        const selection = await pickOne({
          title: `${question.header ?? ''}: ${question.question ?? ''}`.replace(/^: /u, ''),
          options,
        });
        const value = selection?.value ?? selection?.label;
        if (value == null) throw new SimpleCruiseInterruptedError();
        answers[question.id] = { answers: [String(value)] };
      } else {
        answers[question.id] = { answers: [await readLineOnce({ prompt: `${question.question}: ` })] };
      }
    }
    return { answers };
  }
  if ([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
  ].includes(message.method)) {
    const selection = await pickOne({
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
  }
  throw new Error(`Cruise worker does not support ${message.method}`);
}

function command(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 });
  return {
    status: result.status,
    output: String(result.stdout ?? '').trim(),
    error: result.error?.message ?? String(result.stderr ?? '').trim(),
  };
}

export function localDoctorReport(run = command) {
  const version = run('codex', ['--version']);
  const appServer = run('codex', ['app-server', '--help']);
  const checks = [
    { id: 'codex', status: version.status === 0 ? 'pass' : 'fail', detail: version.output || version.error || 'Codex is unavailable' },
    { id: 'app-server', status: appServer.status === 0 ? 'pass' : 'fail', detail: appServer.status === 0 ? 'app-server is available' : appServer.error || 'app-server is unavailable' },
  ];
  return { ok: checks.every(({ status }) => status === 'pass'), checks };
}

async function runDoctor({ json }) {
  const report = localDoctorReport();
  if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else {
    for (const check of checks) process.stdout.write(`${check.status === 'pass' ? 'ok' : 'fail'}    ${check.id}: ${check.detail}\n`);
    process.stdout.write(report.ok ? 'Cruise is ready.\n' : 'Cruise doctor found local issues.\n');
  }
  return report.ok ? 0 : 1;
}

async function runPickerDemo() {
  const result = await pickOne({
    title: 'Cruise picker demo',
    options: ['Continue', 'Stop'],
  });
  process.stdout.write(result.status === 'selected' ? `${result.label}\n` : 'Cancelled\n');
  return result.status === 'selected' ? 0 : 130;
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
    if (options.command === 'worker') return await runWorker(options);
    if (options.command === 'picker-demo') return await runPickerDemo();
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
