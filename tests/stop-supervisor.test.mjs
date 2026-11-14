import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { parseHookFlightPlan } from '../hooks/stop-supervisor.mjs';
import { invokesCruiseGoal } from '../hooks/goal-session.mjs';
import {
  activateGoalSession,
  deactivateGoalSession,
  isGoalSessionActive,
  MAX_WORKSPACE_LOCK_AGE_MS,
  runtimeSessionDirectory,
} from '../hooks/session-marker.mjs';
import {
  captureWorkspaceFingerprint,
  GoalSupervisor,
  validSupervisorState,
  writeSupervisorState,
} from '../scripts/lib/supervisor.mjs';
import { writeFlightPlan } from '../scripts/lib/flight-plan.mjs';
import { captureFlightContextFingerprint } from '../scripts/lib/assurance.mjs';

const HOOK = resolve('hooks/stop-supervisor.mjs');
const SESSION_MARKER = resolve('hooks/session-marker.mjs');
const runtimePaths = new Map();

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

function invokeProcess(cwd, overrides = {}, {
  goalSession = true,
  pluginScoped = false,
} = {}) {
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
  // Fixture hooks must not inherit the Cruise session running this test suite.
  delete env.CRUISE_RUNTIME_DIR;
  delete env.CRUISE_SESSION_ID;
  if (goalSession) {
    env.CRUISE_CLAUDE_GOAL = '1';
    const key = `${cwd}\u0000${input.session_id}`;
    let runtime = runtimePaths.get(key);
    if (!runtime || !existsSync(runtime)) {
      const activation = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `import { activateGoalSession, runtimeSessionDirectory } from ${JSON.stringify(`file://${SESSION_MARKER}`)}; const input = JSON.parse(process.argv[1]); await activateGoalSession(input); process.stdout.write(await runtimeSessionDirectory(input));`,
          JSON.stringify({ cwd, session_id: input.session_id }),
        ],
        { encoding: 'utf8', timeout: 10_000 },
      );
      assert.equal(activation.status, 0, activation.stderr);
      runtime = activation.stdout;
      runtimePaths.set(key, runtime);
    }
    env.CRUISE_RUNTIME_DIR = runtime;
    env.CRUISE_SESSION_ID = input.session_id;
  }
  else delete env.CRUISE_CLAUDE_GOAL;
  const result = spawnSync(process.execPath, [HOOK, ...(pluginScoped ? ['--plugin-hook'] : [])], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 10_000,
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function supervisorPath(cwd, sessionId = 'fixture-session') {
  return join(runtimePaths.get(`${cwd}\u0000${sessionId}`), 'supervisor.json');
}

function invoke(cwd, overrides = {}, options = {}) {
  const result = invokeProcess(cwd, overrides, options);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

test('quiet evidence climbs through continuation, realignment, final experiment, then bounded allow', async () => {
  const cwd = await fixture({ quietTurns: 1 });
  try {
    const outputs = [invoke(cwd), invoke(cwd), invoke(cwd)];
    assert.equal(outputs[0].decision, 'block');
    assert.match(outputs[0].reason, /Continue the active Goal/u);
    assert.equal(outputs[1].decision, 'block');
    assert.match(outputs[1].reason, /realignment|non-progress/iu);
    assert.equal(outputs[2].decision, 'block');
    assert.match(outputs[2].reason, /final supervised continuation/iu);
    const state = JSON.parse(await readFile(supervisorPath(cwd), 'utf8'));
    assert.equal(state.blocks_in_cycle, 3, 'quiet_turns + 2 is the hard block cap');
    const terminal = invoke(cwd);
    assert.equal(terminal.decision, undefined);
    assert.match(terminal.systemMessage, /allowed this stop/iu);
    assert.match(terminal.systemMessage, /Interventions attempted: realign, final-experiment/u);
    await assert.rejects(readFile(supervisorPath(cwd), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('missing and legacy flights are corrected while blocked endpoints are labelled', async () => {
  for (const options of [{ withFlight: false }, { status: 'complete' }, { status: 'blocked' }]) {
    const cwd = await fixture(options);
    try {
      const output = invoke(cwd);
      if (options.withFlight === false) {
        assert.equal(output.decision, 'block');
        assert.match(output.reason, /FLIGHT\.md is absent/u);
      }
      else if (options.status === 'complete') {
        assert.equal(output.decision, 'block');
        assert.match(output.reason, /rejected Flight v1 completion/u);
      }
      else assert.match(output.systemMessage, /blocked/u);
      if (options.withFlight === false || options.status === 'complete') {
        assert.equal(typeof await readFile(supervisorPath(cwd), 'utf8'), 'string');
      } else {
        assert.equal(existsSync(join(cwd, '.cruise', '.supervisor.json')), false);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test('an absent executable flight receives a bounded corrective block', async () => {
  const cwd = await fixture({ withFlight: false });
  try {
    const output = JSON.parse(invokeProcess(cwd).stdout);
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /Create Flight v2/u);
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

test('one workspace cannot host two concurrent Cruise Goal sessions', async () => {
  const cwd = await fixture();
  try {
    await activateGoalSession({ cwd, session_id: 'one' });
    const runtimeOne = await runtimeSessionDirectory({ cwd, session_id: 'one' });
    assert.equal(invoke(cwd, { session_id: 'one' }, {
      goalSession: false,
      pluginScoped: true,
    }).decision, 'block');
    await assert.rejects(
      activateGoalSession({ cwd, session_id: 'two' }),
      { code: 'CRUISE_GOAL_CONFLICT' },
    );
    await deactivateGoalSession({ cwd, session_id: 'one' });
    await activateGoalSession({ cwd, session_id: 'two' });
    const runtimeTwo = await runtimeSessionDirectory({ cwd, session_id: 'two' });
    assert.equal(invoke(cwd, { session_id: 'two' }, {
      goalSession: false,
      pluginScoped: true,
    }).decision, 'block');
    await assert.rejects(readFile(join(runtimeOne, 'supervisor.json'), 'utf8'), { code: 'ENOENT' });
    assert.equal(typeof await readFile(join(runtimeTwo, 'supervisor.json'), 'utf8'), 'string');
    assert.equal((await readdir(join(cwd, '.cruise'))).some((name) => name.startsWith('.supervisor')), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('an abandoned workspace lock has a documented bounded recovery lease', async () => {
  const cwd = await fixture();
  try {
    await activateGoalSession({ cwd, session_id: 'abandoned' }, { now: 1 });
    await assert.rejects(
      activateGoalSession(
        { cwd, session_id: 'replacement' },
        { now: MAX_WORKSPACE_LOCK_AGE_MS },
      ),
      { code: 'CRUISE_GOAL_CONFLICT' },
    );
    await activateGoalSession(
      { cwd, session_id: 'replacement' },
      { now: MAX_WORKSPACE_LOCK_AGE_MS + 2 },
    );
    assert.equal(await isGoalSessionActive({ cwd, session_id: 'abandoned' }), false);
    assert.equal(await isGoalSessionActive({ cwd, session_id: 'replacement' }), true);
  } finally {
    await deactivateGoalSession({ cwd, session_id: 'abandoned' });
    await deactivateGoalSession({ cwd, session_id: 'replacement' });
    await rm(cwd, { recursive: true, force: true });
  }
});

test('an active flight remains supervised across a long resumable session', async () => {
  const cwd = await fixture();
  try {
    const stale = new Date(Date.now() - (49 * 60 * 60 * 1_000));
    await utimes(join(cwd, '.cruise', 'FLIGHT.md'), stale, stale);
    assert.equal(invoke(cwd).decision, 'block');
    assert.equal(typeof await readFile(supervisorPath(cwd), 'utf8'), 'string');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('changing flight-plan metadata cannot reset the supervision cycle', async () => {
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
    assert.match(afterChange.reason, /non-progress/u);
    assert.doesNotMatch(afterChange.reason, /baseline fingerprint/u);
    const state = JSON.parse(await readFile(supervisorPath(cwd), 'utf8'));
    assert.equal(state.blocks_in_cycle, 2);
    assert.equal(state.turns_observed, 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a resumed session starts with a clean supervisor baseline after a stall report', async () => {
  const cwd = await fixture({ quietTurns: 1 });
  try {
    invoke(cwd);
    invoke(cwd);
    invoke(cwd);
    assert.match(invoke(cwd).systemMessage, /allowed this stop/iu);
    await writeFile(join(cwd, 'new-evidence.txt'), 'material delta\n', 'utf8');
    const resumed = invoke(cwd);
    assert.equal(resumed.decision, 'block');
    assert.match(resumed.reason, /baseline fingerprint/u);
    const state = JSON.parse(await readFile(supervisorPath(cwd), 'utf8'));
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
    await writeFile(supervisorPath(cwd), '{not-json', 'utf8');
    const output = invoke(cwd);
    assert.equal(output.decision, undefined);
    assert.match(output.systemMessage, /failed open/iu);
    assert.match(output.systemMessage, /stop was allowed/iu);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('runtime scratch does not write through a symlinked .cruise directory', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-stop-link-cwd-'));
  const outside = await mkdtemp(join(tmpdir(), 'cruise-stop-link-target-'));
  try {
    await writeFile(join(outside, 'FLIGHT.md'), flight(), 'utf8');
    await symlink(outside, join(cwd, '.cruise'), 'dir');
    const output = invoke(cwd);
    assert.equal(output.decision, 'block');
    assert.deepEqual(await readdir(outside), ['FLIGHT.md']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('host-specific plugin hooks activate and supervise Goal sessions', async () => {
  const skill = await readFile(resolve('skills/goal/SKILL.md'), 'utf8');
  assert.doesNotMatch(skill.split('---')[1], /\nhooks:/u);
  const registration = JSON.parse(await readFile(resolve('hooks/hooks.json'), 'utf8'));
  assert.match(
    registration.hooks.UserPromptSubmit[0].hooks[0].command,
    /goal-session\.mjs/u,
  );
  assert.match(
    registration.hooks.Stop[0].hooks[0].command,
    /stop-supervisor\.mjs.*--plugin-hook/u,
  );
  const claudeRegistration = JSON.parse(
    await readFile(resolve('hooks/claude-hooks.json'), 'utf8'),
  );
  assert.match(
    claudeRegistration.hooks.UserPromptExpansion[0].hooks[0].command,
    /goal-session\.mjs/u,
  );
  assert.match(
    claudeRegistration.hooks.Stop[0].hooks[0].command,
    /stop-supervisor\.mjs.*--plugin-hook/u,
  );
});

test('Codex prompt activation is exact and ignores non-Codex or non-Goal prompts', () => {
  assert.equal(invokesCruiseGoal({
    hook_event_name: 'UserPromptSubmit',
    model: 'gpt-5.6',
    prompt: 'Use $cruise:goal to complete this migration.',
  }), true);
  assert.equal(invokesCruiseGoal({
    hook_event_name: 'UserPromptSubmit',
    model: 'gpt-5.6',
    prompt: 'Use $cruise:quick for this patch.',
  }), false);
  assert.equal(invokesCruiseGoal({
    hook_event_name: 'UserPromptSubmit',
    prompt: '/cruise:goal do it',
  }), true);
  assert.equal(invokesCruiseGoal({
    hook_event_name: 'PreToolUse',
    tool_name: 'Skill',
    tool_input: { skill: 'cruise:goal' },
  }), true);
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
    const pilot = 'status: active\nstall:\n  quiet_turns: 3\n  same_failure: 3\n';
    await writeFile(join(cwd, '.cruise', 'FLIGHT.md'), pilot, 'utf8');

    const first = invoke(cwd);
    assert.equal(first.decision, 'block');
    assert.match(first.reason, /supervision is currently blind/iu);
    assert.match(first.reason, /missing opening.*frontmatter fence/iu);
    assert.match(first.reason, /quiet_turns: 3/u);

    const state = JSON.parse(await readFile(supervisorPath(cwd), 'utf8'));
    assert.deepEqual(state.interventions.map(({ level }) => level), ['corrective']);
    assert.equal(state.blocks_in_cycle, 1);
    const repeated = invoke(cwd);
    assert.equal(repeated.decision, undefined);
    assert.match(repeated.systemMessage, /invalid flight state/iu);
    await assert.rejects(readFile(supervisorPath(cwd), 'utf8'), { code: 'ENOENT' });
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
    const state = JSON.parse(await readFile(supervisorPath(cwd), 'utf8'));
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
    for (let index = 0; index < 5; index += 1) {
      await writeFile(
        join(cwd, '.cruise', 'FLIGHT.md'),
        `# Invalid flight rewrite ${index}\nstatus: active\n`,
        'utf8',
      );
      outputs.push(invoke(cwd));
    }
    const state = JSON.parse(await readFile(supervisorPath(cwd), 'utf8'));
    assert.equal(state.blocks_in_cycle, 5);
    assert.equal(state.interventions.length, 5);
    assert.equal(state.invalid_flight_hashes.length, 5);
    await writeFile(join(cwd, '.cruise', 'FLIGHT.md'), 'sixth invalid rewrite\n', 'utf8');
    const terminal = invoke(cwd);
    assert.equal(terminal.decision, undefined);
    assert.match(terminal.systemMessage, /hard backstop of 5 corrective blocks/u);
    await assert.rejects(readFile(supervisorPath(cwd), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a valid repair after an unseen invalid hash at the cap cannot reset the exhausted cycle', async () => {
  const cwd = await fixture({ withFlight: false });
  try {
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(cwd, '.cruise', 'FLIGHT.md'), `invalid rewrite ${index}\n`, 'utf8');
      invoke(cwd);
    }
    const state = JSON.parse(await readFile(supervisorPath(cwd), 'utf8'));
    assert.equal(state.blocks_in_cycle, 5);
    assert.equal(state.turns_observed, 5);
    assert.equal(state.interventions.length, 5);
    await writeFile(join(cwd, '.cruise', 'FLIGHT.md'), flight(), 'utf8');

    const repaired = invoke(cwd);
    assert.equal(repaired.decision, undefined);
    assert.match(repaired.systemMessage, /allowed this stop/u);
    await assert.rejects(readFile(supervisorPath(cwd), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Claude and Codex scratch files satisfy one bounded supervisor schema', async () => {
  const claudeCwd = await fixture();
  const codexCwd = await mkdtemp(join(tmpdir(), 'cruise-codex-schema-'));
  try {
    invoke(claudeCwd);
    const claude = JSON.parse(await readFile(supervisorPath(claudeCwd), 'utf8'));
    const supervisor = new GoalSupervisor({ stall: { quietTurns: 3, sameFailure: 3 } });
    supervisor.recordTurn({ fingerprint: 'codex-fingerprint', turnId: 'turn-1', at: 10 });
    const codexRuntime = runtimePaths.get(`${claudeCwd}\u0000fixture-session`);
    await writeSupervisorState(codexRuntime, supervisor.state({ flightHash: 'codex-flight' }));
    const codex = JSON.parse(await readFile(join(codexRuntime, 'supervisor.json'), 'utf8'));

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
    const path = supervisorPath(cwd);
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

test('Flight v2 completion blocks stale gates, never executes oracle text, and allows fresh assurance', async () => {
  const cwd = await fixture({ withFlight: false });
  try {
    await writeFile(join(cwd, '.cruise', 'ORIGIN.md'), 'Finish safely.', 'utf8');
    await writeFile(join(cwd, 'product.txt'), 'done\n', 'utf8');
    const pwned = join(cwd, 'PWNED');
    const plan = {
      version: 2,
      status: 'complete',
      outcome: 'Finish without executing data as code',
      verify: ['node --test'],
      scope: { touchpoints: ['product.txt'], nonGoals: ['No hook-side commands'] },
      invariants: ['Oracle text remains inert'],
      stall: { quietTurns: 1, sameFailure: 9 },
      quality: {
        risk: 'medium',
        profiles: ['core'],
        gates: [
          ['intent', 'intent', 'review'],
          ['functional', 'functional-correctness', 'command'],
          ['regression', 'regression', 'command'],
          ['failure', 'failure-paths', 'command'],
          ['review', 'completion-review', 'review'],
        ].map(([id, dimension, source]) => ({
          id: `core.${id}`,
          dimension,
          criterion: `Close ${dimension}`,
          oracle: dimension === 'functional-correctness' ? `touch ${pwned}` : `Review ${dimension}`,
          severity: 'high',
          state: 'pending',
          evidence: null,
          source,
        })),
      },
      body: '# Flight v2',
    };
    await writeFlightPlan(cwd, plan);
    const rejected = invoke(cwd);
    assert.equal(rejected.decision, 'block');
    assert.match(rejected.reason, /rejected unassured completion/u);
    await assert.rejects(access(pwned), { code: 'ENOENT' });

    const workspaceFingerprint = await captureWorkspaceFingerprint(cwd, {
      excludeFlightPlan: true,
    });
    const contextFingerprint = await captureFlightContextFingerprint(cwd, plan, {
      workspaceFingerprint,
    });
    for (const gate of plan.quality.gates) {
      gate.state = 'passed';
      gate.evidence = {
        summary: `${gate.id} passed`,
        contextFingerprint,
        observedAt: 1_800_000_000_000,
        source: gate.source,
        rationale: '',
        waivedBy: '',
      };
    }
    await writeFlightPlan(cwd, plan);
    const accepted = invoke(cwd);
    assert.equal(accepted.decision, undefined);
    assert.match(accepted.systemMessage, /assured completion/u);
    await assert.rejects(access(pwned), { code: 'ENOENT' });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Flight contract churn cannot evade the absolute unassured-completion cap', async () => {
  const cwd = await fixture({ withFlight: false });
  try {
    await writeFile(join(cwd, '.cruise', 'ORIGIN.md'), 'Finish the bounded Goal.', 'utf8');
    const plan = {
      version: 2,
      status: 'complete',
      outcome: 'Finish the bounded Goal',
      verify: ['node --test'],
      scope: { touchpoints: ['product.txt'], nonGoals: [] },
      invariants: ['Completion remains bounded'],
      stall: { quietTurns: 1, sameFailure: 9 },
      quality: {
        risk: 'medium',
        profiles: ['core'],
        gates: [
          ['intent', 'intent'],
          ['functional', 'functional-correctness'],
          ['regression', 'regression'],
          ['failure', 'failure-paths'],
          ['review', 'completion-review'],
        ].map(([id, dimension]) => ({
          id: `core.${id}`,
          dimension,
          criterion: `Close ${dimension}`,
          oracle: `Review ${dimension}`,
          severity: 'high',
          state: 'pending',
          evidence: null,
        })),
      },
      body: '# Bounded completion',
    };
    const outputs = [];
    for (let index = 0; index < 4; index += 1) {
      plan.quality.gates[0].criterion = `Close intent revision ${index}`;
      await writeFlightPlan(cwd, plan);
      outputs.push(invoke(cwd));
    }
    assert.deepEqual(outputs.slice(0, 3).map(({ decision }) => decision), [
      'block',
      'block',
      'block',
    ]);
    assert.equal(outputs[3].decision, undefined);
    assert.match(outputs[3].systemMessage, /correction cap|backstop/u);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
