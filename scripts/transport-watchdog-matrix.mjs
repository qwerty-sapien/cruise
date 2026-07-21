#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fakeBin = join(root, 'tests', 'fixtures', 'transport-watchdog', 'bin');
const phase = process.argv.includes('--before') ? 'before' : 'after';
const falsePositives = process.argv.includes('--false-positives');
const requested = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length);
const capArgument = process.argv.find((arg) => arg.startsWith('--cap-ms='))?.slice('--cap-ms='.length);
const defaultCapMs = phase === 'before' ? 300_000 : 2_000;
const capMs = Number(capArgument ?? process.env.RT_CAP_MS ?? defaultCapMs);

const probes = [
  { mode: 'A_no_initialize', lane: 'goal' },
  { mode: 'B_no_thread_start', lane: 'goal' },
  { mode: 'C_goal_no_turn', lane: 'goal', capMs: 140_000, inactivityMs: 250, tickMs: 50 },
  { mode: 'D_turn_never_completes', lane: 'quick' },
  { mode: 'E_goal_continuation_hang', lane: 'goal' },
  { mode: 'F_exit_midturn', lane: 'quick' },
  { mode: 'G_question_no_stdin', lane: 'quick' },
  { mode: 'H_turn_start_no_reply', lane: 'quick' },
];
const falsePositiveProbes = [
  { mode: 'I_streaming_long_turn', lane: 'quick', tickMs: 40 },
  { mode: 'G3_question_held_open', lane: 'quick', keepStdinOpen: true, capMs: 800 },
  { mode: 'fast', lane: 'quick' },
];

function expected(probe) {
  if (probe.mode === 'G3_question_held_open') return { timedOut: true, status: null };
  if (['I_streaming_long_turn', 'fast'].includes(probe.mode)) {
    return { timedOut: false, status: 0 };
  }
  if (probe.mode === 'C_goal_no_turn') return { timedOut: false, status: 4 };
  if (probe.mode === 'F_exit_midturn') return { timedOut: false, status: 1 };
  if (phase === 'before') return { timedOut: true, status: null };
  if (probe.mode === 'A_no_initialize') return { timedOut: false, status: 5 };
  return { timedOut: false, status: 5 };
}

async function runProbe(probe) {
  const cwd = await mkdtemp(join(tmpdir(), `cruise-${probe.mode}-`));
  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let status = null;
  const child = spawn(process.execPath, [
    join(root, 'scripts', 'cruise.mjs'),
    probe.lane,
    '-C',
    cwd,
    `Run ${probe.mode}`,
  ], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      RT_MODE: probe.mode,
      RT_TICK_MS: String(probe.tickMs ?? 40),
      ...(phase === 'after'
        ? { CRUISE_INACTIVITY_TIMEOUT_MS: String(probe.inactivityMs ?? 250) }
        : {}),
    },
    stdio: [probe.keepStdinOpen ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, probe.capMs ?? capMs);
  await new Promise((resolveExit) => child.once('exit', (code) => {
    status = timedOut ? null : code;
    resolveExit();
  }));
  clearTimeout(timer);
  const result = {
    ...probe,
    elapsedMs: Date.now() - startedAt,
    timedOut,
    status,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    stderrTail: stderr.slice(-500).replace(/\s+/gu, ' ').trim(),
  };
  await rm(cwd, { recursive: true, force: true });
  return result;
}

const available = falsePositives ? falsePositiveProbes : probes;
const selected = requested
  ? available.filter(({ mode }) => requested.split(',').includes(mode))
  : available;
const results = await Promise.all(selected.map(runProbe));
let failed = false;
for (const result of results) {
  const want = expected(result);
  const pass = result.timedOut === want.timedOut && result.status === want.status;
  failed ||= !pass;
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${JSON.stringify(result)}\n`);
}
if (failed) process.exitCode = 1;
