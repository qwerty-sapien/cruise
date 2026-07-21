import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { parseHookFlightPlan } from '../hooks/stop-supervisor.mjs';
import {
  GoalSupervisor,
  validSupervisorState,
  writeSupervisorState,
} from '../scripts/lib/supervisor.mjs';

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

function invokeProcess(cwd, overrides = {}, { goalSession = true } = {}) {
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
  return result;
}

function invoke(cwd, overrides = {}, options = {}) {
  const result = invokeProcess(cwd, overrides, options);
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

test('an absent flight plan emits byte-identical empty hook stdout', async () => {
  const cwd = await fixture({ withFlight: false });
  try {
    assert.equal(invokeProcess(cwd).stdout, '');
  } finally {
    await rm(cwd, { recursive: true, force: true });
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

test('unsafe stall integers are invalid instead of defeating the block cap', () => {
  const plan = parseHookFlightPlan(`---
status: active
stall:
  quiet_turns: ${'9'.repeat(400)}
  same_failure: ${'9'.repeat(400)}
---
`);
  assert.equal(plan, null);
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

test('the fenceless pilot artifact receives one bounded corrective intervention', async () => {
  const cwd = await fixture({ withFlight: false });
  try {
    const pilot = await readFile(resolve(
      'evals/results/2026-07-21/raw/claude-v302-y-r1/FLIGHT.md',
    ), 'utf8');
    await writeFile(join(cwd, '.cruise', 'FLIGHT.md'), pilot, 'utf8');

    const first = invoke(cwd);
    assert.equal(first.decision, 'block');
    assert.match(first.reason, /supervision is currently blind/iu);
    assert.match(first.reason, /missing opening.*frontmatter fence/iu);
    assert.match(first.reason, /quiet_turns: 3/u);

    const repeated = [invoke(cwd), invoke(cwd), invoke(cwd), invoke(cwd)];
    assert.equal(repeated.every((item) => item.decision === undefined), true);
    assert.equal(repeated.every((item) => /invalid flight state/iu.test(item.systemMessage)), true);
    const state = JSON.parse(await readFile(join(cwd, '.cruise', '.supervisor.json'), 'utf8'));
    assert.deepEqual(state.interventions.map(({ level }) => level), ['corrective']);
    assert.equal(state.blocks_in_cycle, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a successful invalid-flight repair preserves its correction and block budget', async () => {
  const cwd = await fixture({ withFlight: false });
  try {
    await writeFile(join(cwd, '.cruise', 'FLIGHT.md'), 'status: active\n', 'utf8');
    assert.equal(invoke(cwd).decision, 'block');
    await writeFile(join(cwd, '.cruise', 'FLIGHT.md'), flight({ quietTurns: 1 }), 'utf8');

    const afterRepair = invoke(cwd);
    assert.equal(afterRepair.decision, 'block');
    const state = JSON.parse(await readFile(join(cwd, '.cruise', '.supervisor.json'), 'utf8'));
    assert.equal(state.blocks_in_cycle, 2);
    assert.deepEqual(state.interventions.map(({ level }) => level), ['corrective']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('invalid rewrites earn one correction each until the hard block cap', async () => {
  const cwd = await fixture({ withFlight: false });
  try {
    const outputs = [];
    for (let index = 0; index < 6; index += 1) {
      await writeFile(
        join(cwd, '.cruise', 'FLIGHT.md'),
        `# Invalid flight rewrite ${index}\nstatus: active\n`,
        'utf8',
      );
      outputs.push(invoke(cwd));
    }
    assert.equal(outputs.slice(0, 5).every((item) => item.decision === 'block'), true);
    assert.equal(outputs[5].decision, undefined);
    assert.match(outputs[5].systemMessage, /hard backstop of 5 corrective blocks/u);
    const state = JSON.parse(await readFile(join(cwd, '.cruise', '.supervisor.json'), 'utf8'));
    assert.equal(state.blocks_in_cycle, 5);
    assert.equal(state.interventions.length, 5);
    assert.equal(state.invalid_flight_hashes.length, 5);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a valid repair after an unseen invalid hash at the cap cannot reset the exhausted cycle', async () => {
  const cwd = await fixture({ withFlight: false });
  try {
    for (let index = 0; index < 6; index += 1) {
      await writeFile(join(cwd, '.cruise', 'FLIGHT.md'), `invalid rewrite ${index}\n`, 'utf8');
      invoke(cwd);
    }
    await writeFile(join(cwd, '.cruise', 'FLIGHT.md'), flight(), 'utf8');

    const repaired = invoke(cwd);
    assert.equal(repaired.decision, undefined);
    assert.match(repaired.systemMessage, /allowed this stop/u);
    const state = JSON.parse(await readFile(join(cwd, '.cruise', '.supervisor.json'), 'utf8'));
    assert.equal(state.blocks_in_cycle, 5);
    assert.equal(state.turns_observed, 7);
    assert.equal(state.interventions.length, 5);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Claude and Codex scratch files satisfy one bounded supervisor schema', async () => {
  const claudeCwd = await fixture();
  const codexCwd = await mkdtemp(join(tmpdir(), 'cruise-codex-schema-'));
  try {
    invoke(claudeCwd);
    const claude = JSON.parse(await readFile(join(claudeCwd, '.cruise', '.supervisor.json'), 'utf8'));
    const supervisor = new GoalSupervisor({ stall: { quietTurns: 3, sameFailure: 3 } });
    supervisor.recordTurn({ fingerprint: 'codex-fingerprint', turnId: 'turn-1', at: 10 });
    await writeSupervisorState(codexCwd, supervisor.state({ flightHash: 'codex-flight' }));
    const codex = JSON.parse(await readFile(join(codexCwd, '.cruise', '.supervisor.json'), 'utf8'));

    assert.equal(validSupervisorState(claude), true);
    assert.equal(validSupervisorState(codex), true);
    assert.equal(claude.host, 'claude');
    assert.equal(codex.host, 'codex');
    const required = [
      'version', 'host', 'flight_hash', 'has_observation', 'last_fingerprint',
      'seen_fingerprints', 'last_failure', 'same_failure', 'quiet_stops', 'ladder',
      'blocks_in_cycle', 'turns_observed', 'interventions', 'observations',
      'created_at', 'updated_at',
    ];
    for (const field of required) {
      assert.equal(Object.hasOwn(claude, field), true, `Claude missing ${field}`);
      assert.equal(Object.hasOwn(codex, field), true, `Codex missing ${field}`);
    }
    const malformedClaude = structuredClone(claude);
    malformedClaude.interventions = [{ level: 'invented', at: 10, reason: 'not in schema' }];
    assert.equal(validSupervisorState(malformedClaude), false);
  } finally {
    await rm(claudeCwd, { recursive: true, force: true });
    await rm(codexCwd, { recursive: true, force: true });
  }
});

test('adding the Claude host field preserves an existing pre-field supervision cycle', async () => {
  const cwd = await fixture({ quietTurns: 1 });
  try {
    assert.equal(invoke(cwd).decision, 'block');
    const path = join(cwd, '.cruise', '.supervisor.json');
    const legacy = JSON.parse(await readFile(path, 'utf8'));
    delete legacy.host;
    await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

    const continued = invoke(cwd);
    assert.equal(continued.decision, 'block');
    assert.match(continued.reason, /realignment|non-progress/iu);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).host, 'claude');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
