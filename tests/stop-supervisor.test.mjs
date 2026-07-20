import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { parseHookFlightPlan } from '../hooks/stop-supervisor.mjs';

const HOOK = resolve('hooks/stop-supervisor.mjs');

function flight({ status = 'active', quietTurns = 1, sameFailure = 9, outcome = 'Finish safely' } = {}) {
  return `---
version: 1
status: ${status}
outcome: ${outcome}
stall:
  quiet_turns: ${quietTurns}
  same_failure: ${sameFailure}
---
# Flight plan
`;
}

async function fixture(options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-stop-hook-'));
  await mkdir(join(cwd, '.cruise'));
  if (options.withFlight !== false) {
    await writeFile(join(cwd, '.cruise', 'FLIGHT.md'), flight(options), 'utf8');
  }
  if (options.git !== false) {
    const initialized = spawnSync('git', ['init', '--quiet'], { cwd, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
  }
  return cwd;
}

function invoke(cwd, overrides = {}, { goalSession = true } = {}) {
  const input = {
    session_id: 'fixture-session',
    transcript_path: join(cwd, 'transcript.jsonl'),
    cwd,
    permission_mode: 'default',
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Implemented the next step.',
    ...overrides,
  };
  const env = { ...process.env };
  if (goalSession) env.CRUISE_CLAUDE_GOAL = '1';
  else delete env.CRUISE_CLAUDE_GOAL;
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 10_000,
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

test('quiet evidence climbs through continuation, realignment, final experiment, then bounded allow', async () => {
  const cwd = await fixture({ quietTurns: 1 });
  try {
    const outputs = [invoke(cwd), invoke(cwd), invoke(cwd), invoke(cwd)];
    assert.equal(outputs[0].decision, 'block');
    assert.match(outputs[0].reason, /Continue the active Goal/u);
    assert.equal(outputs[1].decision, 'block');
    assert.match(outputs[1].reason, /realignment|non-progress/iu);
    assert.equal(outputs[2].decision, 'block');
    assert.match(outputs[2].reason, /final supervised continuation/iu);
    assert.equal(outputs[3].decision, undefined);
    assert.match(outputs[3].systemMessage, /allowed this stop/iu);
    assert.match(outputs[3].systemMessage, /Interventions attempted: realign, final-experiment/u);

    const state = JSON.parse(await readFile(join(cwd, '.cruise', '.supervisor.json'), 'utf8'));
    assert.equal(state.blocks_in_cycle, 3, 'quiet_turns + 2 is the hard block cap');
    assert.equal(state.ladder, 'stalled');
    assert.match(await readFile(join(cwd, '.cruise', '.gitignore'), 'utf8'), /^\.supervisor\.json$/mu);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('missing, complete, and blocked flight plans leave non-active sessions inert', async () => {
  for (const options of [{ withFlight: false }, { status: 'complete' }, { status: 'blocked' }]) {
    const cwd = await fixture(options);
    try {
      assert.equal(invoke(cwd), null);
      await assert.rejects(readFile(join(cwd, '.cruise', '.supervisor.json'), 'utf8'), { code: 'ENOENT' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test('a fresh active plan is inert outside a launcher-marked Goal session', async () => {
  const cwd = await fixture();
  try {
    assert.equal(invoke(cwd, {}, { goalSession: false }), null);
    await assert.rejects(readFile(join(cwd, '.cruise', '.supervisor.json'), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('an active flight plan older than 48 hours is inert', async () => {
  const cwd = await fixture();
  try {
    const stale = new Date(Date.now() - (49 * 60 * 60 * 1_000));
    await utimes(join(cwd, '.cruise', 'FLIGHT.md'), stale, stale);
    assert.equal(invoke(cwd), null);
    await assert.rejects(readFile(join(cwd, '.cruise', '.supervisor.json'), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('changing flight-plan frontmatter resets the supervision cycle', async () => {
  const cwd = await fixture({ quietTurns: 1, outcome: 'First outcome' });
  try {
    const first = invoke(cwd);
    assert.match(first.reason, /baseline fingerprint/u);
    await writeFile(
      join(cwd, '.cruise', 'FLIGHT.md'),
      flight({ quietTurns: 1, outcome: 'Realigned outcome' }),
      'utf8',
    );
    const afterChange = invoke(cwd);
    assert.equal(afterChange.decision, 'block');
    assert.match(afterChange.reason, /baseline fingerprint/u);
    assert.doesNotMatch(afterChange.reason, /non-progress/u);
    const state = JSON.parse(await readFile(join(cwd, '.cruise', '.supervisor.json'), 'utf8'));
    assert.equal(state.blocks_in_cycle, 1);
    assert.equal(state.turns_observed, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('new workspace evidence restarts supervision after a stall report', async () => {
  const cwd = await fixture({ quietTurns: 1 });
  try {
    invoke(cwd);
    invoke(cwd);
    invoke(cwd);
    assert.match(invoke(cwd).systemMessage, /allowed this stop/iu);
    await writeFile(join(cwd, 'new-evidence.txt'), 'material delta\n', 'utf8');
    const resumed = invoke(cwd);
    assert.equal(resumed.decision, 'block');
    assert.match(resumed.reason, /new fingerprint/u);
    const state = JSON.parse(await readFile(join(cwd, '.cruise', '.supervisor.json'), 'utf8'));
    assert.equal(state.ladder, 'normal');
    assert.equal(state.blocks_in_cycle, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('same normalized failure can trigger realignment without git evidence', async () => {
  const cwd = await fixture({ git: false, quietTurns: 9, sameFailure: 2 });
  try {
    assert.match(invoke(cwd, { last_assistant_message: 'Error: failed at /tmp/a.js:12' }).reason, /Continue/u);
    const repeated = invoke(cwd, { last_assistant_message: 'ERROR: failed at /work/b.js:98' });
    assert.equal(repeated.decision, 'block');
    assert.match(repeated.reason, /non-progress/u);
    assert.match(repeated.reason, /failure signature [a-f\d]{12} repeated 2 consecutive stops/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('corrupt scratch state fails open with an allow report and exit zero', async () => {
  const cwd = await fixture();
  try {
    assert.equal(invoke(cwd).decision, 'block');
    await writeFile(join(cwd, '.cruise', '.supervisor.json'), '{not-json', 'utf8');
    const output = invoke(cwd);
    assert.equal(output.decision, undefined);
    assert.match(output.systemMessage, /failed open/iu);
    assert.match(output.systemMessage, /stop was allowed/iu);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a symlinked scratch directory fails open without writing through it', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-stop-link-cwd-'));
  const outside = await mkdtemp(join(tmpdir(), 'cruise-stop-link-target-'));
  try {
    await writeFile(join(outside, 'FLIGHT.md'), flight(), 'utf8');
    await symlink(outside, join(cwd, '.cruise'), 'dir');
    const output = invoke(cwd);
    assert.equal(output.decision, undefined);
    assert.match(output.systemMessage, /failed open/iu);
    assert.deepEqual(await readdir(outside), ['FLIGHT.md']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('hook registration uses the standalone plugin-root command form', async () => {
  const registration = JSON.parse(await readFile(resolve('hooks/hooks.json'), 'utf8'));
  const command = registration.hooks.Stop[0].hooks[0];
  assert.deepEqual(command, {
    type: 'command',
    command: 'node',
    args: ['${CLAUDE_PLUGIN_ROOT}/hooks/stop-supervisor.mjs'],
    timeout: 30,
  });
});

test('unsafe stall integers fall back instead of defeating the block cap', () => {
  const plan = parseHookFlightPlan(`---
status: active
stall:
  quiet_turns: ${'9'.repeat(400)}
  same_failure: ${'9'.repeat(400)}
---
`);
  assert.deepEqual(plan.stall, { quietTurns: 3, sameFailure: 3 });
});

test('malformed or schema-invalid frontmatter never activates supervision', () => {
  const malformed = [
    '---\nstatus: active\nstatus: active\n---\n',
    '---\nstatus: active\n outcome: odd indentation\n---\n',
    '---\nstatus: active\nverify: npm test\n---\n',
    '---\nstatus: active\nscope: nope\n---\n',
    '---\nstatus: active\noutcome: "two\\nlines"\n---\n',
  ];
  for (const text of malformed) assert.equal(parseHookFlightPlan(text), null);
});
