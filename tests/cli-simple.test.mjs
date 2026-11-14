import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  CODEX_PLUGIN_FRESHNESS_PATHS,
  CLI_VERSION,
  codexPluginContentFreshness,
  localDoctorReport,
  parseArgs,
  PUBLIC_SKILLS,
  runAttest,
  runCommitChangelog,
  runOneGoal,
  runReference,
  runStart,
  runWorker,
  surfaceAppServerStderr,
} from '../index.js';
import { readOriginPrompt, writeOriginPrompt } from '../scripts/lib/origin-note.mjs';
import { writeFlightPlan } from '../scripts/lib/flight-plan.mjs';
import { SimpleCruiseSession } from '../scripts/lib/simple-session.mjs';
import { WORKER_HANDOFF_OUTPUT_SCHEMA } from '../scripts/lib/context-capsule.mjs';
import { answerWorkerRequest } from '../scripts/cruise.mjs';
import {
  activateGoalSession, deactivateGoalSession, isGoalSessionActive,
  reserveCruiseWorkspace, runtimeSessionDirectory, MAX_WORKSPACE_LOCK_AGE_MS,
} from '../hooks/session-marker.mjs';
import { cleanupRuntimeSession, createRuntimeSession, validateRuntimeDirectory } from '../scripts/lib/runtime-state.mjs';
import { QuotaGuard } from '../scripts/lib/quota-guard.mjs';
import { WorkerDispatchLedger } from '../scripts/lib/worker-dispatcher.mjs';

function managedParentOptions(cwd) {
  return parseArgs(['--codex', 'worker', '--managed', '--read-only', '--strict-budget',
    '--complexity', 'retrieval', '--owns', 'ordinary.txt', '--evidence', 'Ordinary fixture.',
    '--range', 'ordinary.txt:1-1', '--verify', 'Read fixture.', '-C', cwd, 'Read the fixture.'], { env: {} });
}

function workspaceLeasePath(cwd) {
  return join(tmpdir(), 'cruise-goal-sessions', `${createHash('sha256').update(cwd).digest('hex')}.workspace.json`);
}

class ManagedParentTransport extends EventEmitter {
  constructor({ onThread = async () => {}, fail = false } = {}) {
    super();
    this.onThread = onThread;
    this.fail = fail;
    this.requests = [];
    this.stopped = false;
  }
  async start() {}
  async stop() { this.stopped = true; }
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'fixture@example.invalid', planType: 'plus' } };
    if (method === 'account/rateLimits/read') return { rateLimits: {
      secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 2000000000 },
    } };
    if (method === 'model/list') return { data: [{ id: 'gpt-5.6-luna', model: 'gpt-5.6-luna',
      hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['medium'] },
    { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', hidden: false, isDefault: false,
      defaultReasoningEffort: 'high', supportedReasoningEfforts: ['high'] },
    { id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', hidden: false, isDefault: false,
      defaultReasoningEffort: 'xhigh', supportedReasoningEfforts: ['xhigh', 'ultra'] }] };
    if (method === 'thread/start') {
      await this.onThread(params);
      return { thread: { id: 'managed-child' } };
    }
    if (method === 'turn/start') {
      queueMicrotask(() => {
        if (!this.fail) this.emit('notification', { method: 'item/completed', params: { item: {
          id: 'final', type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({
            outcome: 'Fixture complete', completed_work: ['Read fixture'], changed_files: [],
            decisions_and_invariants: [], exact_tests: [], active_blocker_or_next_work_item: 'None.',
            files_not_to_reread: [], evidence_pointers: [], usage_and_quota_summary: 'Mock transport only',
          }),
        } } });
        this.emit('notification', { method: 'turn/completed', params: { turn: {
          id: 'managed-turn', status: this.fail ? 'failed' : 'completed',
        } } });
      });
      return { turn: { id: 'managed-turn' } };
    }
    throw new Error(`unexpected mock transport request: ${method}`);
  }
}

test('real managed CLI joins Goal, staged and Debug parents with independent leases and child-only cleanup', async (t) => {
  for (const mode of ['goal', 'goal-error', 'goal-routing', 'staged', 'debug', 'standalone']) await t.test(mode, async (t) => {
    // Canonicalize BEFORE activation: /var and /private/var otherwise hide the conflict on macOS.
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'cruise-parent-integration-')));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const parent = { cwd, session_id: `parent-${mode}` };
    let parentRuntime;
    let warmRuntime;
    if (mode !== 'standalone') {
      if (mode === 'debug') parentRuntime = await reserveCruiseWorkspace(parent);
      else {
        await activateGoalSession(parent);
        parentRuntime = await runtimeSessionDirectory(parent);
      }
      t.after(() => deactivateGoalSession(parent));
      await writeFile(join(parentRuntime, 'drafts', 'parent.txt'), 'parent artifact');
    }
    if (mode === 'staged') {
      warmRuntime = await createRuntimeSession({ cwd, sessionId: parent.session_id, kind: 'goal-warmup' });
      t.after(() => cleanupRuntimeSession(warmRuntime, { cwd, sessionId: parent.session_id }));
    }
    const parentLease = parentRuntime ? await readFile(workspaceLeasePath(cwd), 'utf8') : null;
    const parentRuntimeSiblings = mode === 'goal-routing' ? await readdir(dirname(parentRuntime)) : null;
    const dispatch = new WorkerDispatchLedger({ cwd });
    let quota;
    let childEnv;
    const budgetClient = new ManagedParentTransport();
    const parentQuota = parentRuntime ? new QuotaGuard({ cwd, baseDirectory: join(cwd, 'quota-fixture'), strictBudget: true }) : null;
    if (parentQuota) await parentQuota.start({ client: budgetClient, goalId: parent.session_id });
    const parentReservations = parentQuota ? await readFile(parentQuota.ledgerPath(), 'utf8') : null;
    if (mode === 'goal-routing') {
      const request = budgetClient.request.bind(budgetClient);
      budgetClient.requests = [];
      budgetClient.request = async (method, params) => {
        if (method === 'account/read') {
          budgetClient.requests.push({ method, params });
          throw Object.assign(new Error('workspace routing discovery failed'), { code: -32603 });
        }
        return request(method, params);
      };
    }
    const workerClient = new ManagedParentTransport({ fail: mode === 'goal-error', onThread: async (params) => {
      assert.notEqual(childEnv.CRUISE_SESSION_ID, parent.session_id);
      assert.notEqual(childEnv.CRUISE_RUNTIME_DIR, parentRuntime);
      assert.notEqual(childEnv.CRUISE_RUNTIME_DIR, warmRuntime);
      assert.equal(childEnv.CRUISE_CLAUDE_GOAL, undefined);
      const { manifest } = await validateRuntimeDirectory(childEnv.CRUISE_RUNTIME_DIR, {
        cwd, sessionId: childEnv.CRUISE_SESSION_ID,
      });
      assert.equal(manifest.kind, 'worker');
      assert.equal(params.serviceName, 'cruise_worker');
      assert.equal(params.ephemeral, true);
      assert.equal(params.sandbox, 'read-only');
      assert.equal(params.approvalPolicy, 'on-request');
      assert.deepEqual(params.runtimeWorkspaceRoots, []);
      const ledger = JSON.parse(await readFile(dispatch.ledgerPath, 'utf8'));
      assert.equal(ledger.active.length, 1);
      const reservations = JSON.parse(await readFile(quota.ledgerPath(), 'utf8')).reservations;
      assert.equal(reservations.filter(entry => entry.status === 'active').length, parentQuota ? 2 : 1);
      assert.equal(reservations.at(-1).goal_id, `worker:${childEnv.CRUISE_SESSION_ID}`);
      const stop = spawnSync(process.execPath, [resolve('hooks/stop-supervisor.mjs'), '--plugin-hook'], {
        env: childEnv, encoding: 'utf8', timeout: 10000,
        input: JSON.stringify({ cwd, session_id: childEnv.CRUISE_SESSION_ID, hook_event_name: 'Stop' }),
      });
      assert.equal(stop.status, 0, stop.stderr);
      assert.equal(stop.stdout.trim(), '');
      if (parentRuntime) {
        assert.equal(await readFile(workspaceLeasePath(cwd), 'utf8'), parentLease);
        await assert.rejects(reserveCruiseWorkspace({ cwd, session_id: 'unrelated-root' }), { code: 'CRUISE_GOAL_CONFLICT' });
        await assert.rejects(runWorker(managedParentOptions(cwd), { env: {},
          workerClientFactory() { assert.fail('unrelated root reached transport'); },
          budgetClientFactory() { assert.fail('unrelated root reached quota'); },
        }), { code: 'CRUISE_GOAL_CONFLICT' });
      }
    } });
    // Simulate an inherited root-only hook flag; the worker transport must scrub it.
    const priorFlag = process.env.CRUISE_CLAUDE_GOAL;
    process.env.CRUISE_CLAUDE_GOAL = '1';
    try {
      const run = runWorker(managedParentOptions(cwd), {
        env: parentRuntime ? { CRUISE_SESSION_ID: parent.session_id, CRUISE_RUNTIME_DIR: warmRuntime ?? parentRuntime } : {},
        workerClientFactory(input) { childEnv = input.spawnOptions.env; return workerClient; },
        budgetClientFactory: () => budgetClient,
        quotaGuardFactory(input) {
          quota = new QuotaGuard({ ...input, baseDirectory: join(cwd, 'quota-fixture') });
          return quota;
        },
      });
      if (mode === 'goal-routing') assert.equal(await run, 6);
      else if (mode === 'goal-error') await assert.rejects(run, /worker turn ended with status failed/u);
      else assert.equal(await run, 0);
    } finally {
      if (priorFlag === undefined) delete process.env.CRUISE_CLAUDE_GOAL;
      else process.env.CRUISE_CLAUDE_GOAL = priorFlag;
    }
    if (mode === 'goal-routing') {
      const pause = JSON.parse(await readFile(join(cwd, '.cruise', 'BUDGET-PAUSE.json'), 'utf8'));
      assert.match(pause.reason, /weekly quota authority unavailable: workspace routing discovery failed \(account-routing\)/u);
      assert.deepEqual(workerClient.requests, []);
      assert.deepEqual(budgetClient.requests.map(entry => entry.method), ['account/read', 'account/rateLimits/read']);
      assert.equal(budgetClient.stopped, true);
      assert.equal(budgetClient.listenerCount('notification'), 1); // Parent still owns its listener.
      assert.deepEqual(JSON.parse(await readFile(dispatch.ledgerPath, 'utf8')).active, []);
      assert.equal(await readFile(parentQuota.ledgerPath(), 'utf8'), parentReservations);
      assert.equal(await readFile(workspaceLeasePath(cwd), 'utf8'), parentLease);
      assert.equal(await readFile(join(parentRuntime, 'drafts', 'parent.txt'), 'utf8'), 'parent artifact');
      assert.deepEqual(await readdir(dirname(parentRuntime)), parentRuntimeSiblings);
      if (childEnv) await assert.rejects(lstat(childEnv.CRUISE_RUNTIME_DIR), { code: 'ENOENT' });
      await parentQuota.release();
      return;
    }
    assert.deepEqual(workerClient.requests.map(entry => entry.method), ['model/list', 'thread/start', 'turn/start']);
    const turn = workerClient.requests.at(-1).params;
    assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly' });
    assert.equal(turn.cwd, cwd);
    assert.equal(turn.approvalPolicy, 'on-request');
    assert.deepEqual(turn.outputSchema, WORKER_HANDOFF_OUTPUT_SCHEMA);
    assert.equal(workerClient.stopped && budgetClient.stopped, true);
    await assert.rejects(lstat(childEnv.CRUISE_RUNTIME_DIR), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(dispatch.ledgerPath, 'utf8')).active, []);
    const reservations = JSON.parse(await readFile(quota.ledgerPath(), 'utf8')).reservations;
    assert.equal(reservations.at(-1).status, 'released');
    if (parentQuota) {
      assert.equal(reservations[0].status, 'active');
      assert.equal(reservations[0].goal_id, parent.session_id);
      await parentQuota.release();
    }
    if (parentRuntime) {
      assert.equal(await readFile(workspaceLeasePath(cwd), 'utf8'), parentLease);
      assert.equal(await readFile(join(parentRuntime, 'drafts', 'parent.txt'), 'utf8'), 'parent artifact');
      assert.equal(await isGoalSessionActive(parent), mode !== 'debug');
    } else await assert.rejects(lstat(workspaceLeasePath(cwd)), { code: 'ENOENT' });
  });
});

test('managed CLI rejects invalid parent bindings before capsule writes or transport creation', async (t) => {
  for (const mode of ['missing-runtime', 'missing-session', 'wrong-session', 'wrong-cwd', 'unregistered',
    'stale-lease', 'expired-runtime', 'inactive-runtime', 'tampered-manifest', 'worker-parent',
    'unsafe-runtime', 'symlink-runtime', 'foreign-inherited-runtime']) await t.test(mode, async (t) => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'cruise-invalid-parent-')));
    const parent = { cwd, session_id: 'fixture-parent' };
    await activateGoalSession(parent);
    const runtime = await runtimeSessionDirectory(parent);
    const manifestPath = join(runtime, 'manifest.json');
    const manifestText = await readFile(manifestPath, 'utf8');
    const leasePath = workspaceLeasePath(cwd);
    const leaseText = await readFile(leasePath, 'utf8');
    t.after(async () => {
      await chmod(runtime, 0o700);
      await writeFile(manifestPath, manifestText);
      await writeFile(leasePath, leaseText, { mode: 0o600 });
      await deactivateGoalSession(parent);
      await rm(cwd, { recursive: true, force: true });
    });
    const env = { CRUISE_SESSION_ID: parent.session_id, CRUISE_RUNTIME_DIR: runtime };
    if (mode === 'missing-runtime') delete env.CRUISE_RUNTIME_DIR;
    if (mode === 'missing-session') delete env.CRUISE_SESSION_ID;
    if (mode === 'wrong-session') env.CRUISE_SESSION_ID = 'unrelated';
    if (mode === 'unsafe-runtime') await chmod(runtime, 0o777);
    if (mode === 'symlink-runtime') {
      const link = join(dirname(runtime), 'fixture-runtime-link');
      await symlink(runtime, link);
      t.after(() => rm(link, { force: true }));
      env.CRUISE_RUNTIME_DIR = link;
    }
    if (mode === 'foreign-inherited-runtime') {
      const foreign = await createRuntimeSession({ cwd, sessionId: 'foreign', kind: 'goal-warmup' });
      t.after(() => cleanupRuntimeSession(foreign, { cwd, sessionId: 'foreign' }));
      env.CRUISE_RUNTIME_DIR = foreign;
    }
    if (mode === 'unregistered') await rm(leasePath);
    if (mode === 'stale-lease') await writeFile(leasePath, JSON.stringify({
      ...JSON.parse(leaseText), activated_at: Date.now() - MAX_WORKSPACE_LOCK_AGE_MS - 1000,
    }));
    const mutation = { 'expired-runtime': { recovery_expires_at: 1 }, 'inactive-runtime': { state: 'complete' },
      'tampered-manifest': { session_id: 'foreign' }, 'worker-parent': { kind: 'worker' } }[mode];
    if (mutation) await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(manifestText), ...mutation }));
    let target = cwd;
    if (mode === 'wrong-cwd') { target = join(cwd, 'other'); await mkdir(target); }
    await mkdir(join(target, '.cruise'));
    const capsulePath = join(target, '.cruise', 'CONTEXT_CAPSULE.json');
    await writeFile(capsulePath, 'parent sentinel');
    const before = await readdir(join(target, '.cruise'));
    await assert.rejects(runWorker(managedParentOptions(target), { env,
      workerClientFactory() { assert.fail('invalid parent reached worker transport'); },
      budgetClientFactory() { assert.fail('invalid parent reached quota transport'); },
    }), { code: 'CRUISE_WORKER_PARENT_INVALID' });
    assert.deepEqual(await readdir(join(target, '.cruise')), before);
    assert.equal(await readFile(capsulePath, 'utf8'), 'parent sentinel');
  });
});

test('ordinary local access cannot authorize a separate copy to an external URL', async () => {
  for (const question of [
    { id: 'copy', question: 'May I read ordinary source in the host-access-approved local folder and copy it to https://example.invalid/collect?' },
    { id: 'copy', question: 'May I read ordinary source in the host-access-approved local folder?', options: [
      { label: 'Proceed', description: 'Copy the source to https://example.invalid/collect', value: 'copy_remote' },
    ] },
  ]) {
    let asked = 0;
    await answerWorkerRequest({ method: 'item/tool/requestUserInput', params: { questions: [question] } }, {
      picker: async () => { asked++; return { value: 'decline' }; },
      readLine: async () => { asked++; return 'decline'; },
    });
    assert.equal(asked, 1);
  }
});

test('worker request handler auto-answers authorized local work without a human picker or delegation wording', async () => {
  for (const question of [
    { question: 'May I search the approved local folder?' },
    { question: 'May I read the AUTHORIZED FOLDERS?' },
    { question: 'May I inspect access-approved local workspace files?' },
    { question: 'May I search approved task-relevant sibling folders outside repository write ownership?' },
    { question: 'May I make minor reversible edits to approved local files within assigned write ownership?' },
    { header: 'Authorized local directories', question: 'Continue?', options: [
      { label: 'Proceed', description: 'Read private source and password hashing tests, excluding .env.' },
      { label: 'Wait' },
    ] },
  ]) {
    const result = await answerWorkerRequest({ method: 'item/tool/requestUserInput',
      params: { questions: [{ id: 'local', ...question }] },
    }, {
      picker() { assert.fail('ordinary local access reached the human picker'); },
      readLine() { assert.fail('ordinary local access reached free-text input'); },
    });
    assert.match(result.answers.local.answers[0], /already authorized/u);
  }
});

test('worker handler preserves option effects, explicit denial evidence and native approval requests', async () => {
  const safe = 'May I search the approved local folder?';
  const cases = [
    { question: safe, authorizationEvidence: { nativeApprovalDenied: true } },
    { question: `${safe} The tool returned permission denied: EACCES.` },
    { question: safe, description: 'Upload the files to an external provider.' },
    { question: safe, description: 'Read actual patient data.' },
    { question: 'Read approved local folders including .env and actual medical records?' },
    { question: safe, description: 'Delete all local files.' },
    { question: safe, description: 'Email the files to a colleague.' },
    { question: safe, description: 'Run arbitrary commands.' },
    { question: 'Ask a subagent to read approved local folders and upload them to an external provider?' },
    { question: 'Ask a subagent to read approved local folders and delete them?' },
    { question: safe, value: 'Make a scope expansion.' },
    { question: 'May I write approved files outside assigned ownership?' },
  ];
  for (const { authorizationEvidence, question, description, value } of cases) {
    let picks = 0;
    const result = await answerWorkerRequest({ method: 'item/tool/requestUserInput', params: { questions: [{
      id: 'gate', question, options: [{ label: 'Review', description, value }],
    }] } }, { authorizationEvidence, picker() { picks++; return { value: 'human decision' }; } });
    assert.equal(picks, 1, question);
    assert.deepEqual(result.answers.gate.answers, ['human decision']);
  }
  for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval']) {
    let picks = 0;
    await answerWorkerRequest({ method, params: { reason: safe } }, {
      picker() { picks++; return { value: 'decline' }; },
    });
    assert.equal(picks, 1, method);
  }
  let reads = 0;
  await answerWorkerRequest({ method: 'item/tool/requestUserInput', params: { questions: [{
    id: 'denied', question: safe,
  }] } }, { authorizationEvidence: { nativeApprovalDenied: true },
    readLine() { reads++; return 'Keep the denial'; },
  });
  assert.equal(reads, 1);
});

test('worker handler skips secret paths and resolves each question independently', async () => {
  let picks = 0;
  const result = await answerWorkerRequest({ method: 'item/tool/requestUserInput', params: { questions: [
    { id: 'safe', question: 'Search the approved local folders, excluding .env and private keys?' },
    { id: 'secret', question: 'Read the approved local folder including .env?' },
    { id: 'effect', question: 'Read approved local files and actual medical records?', options: [{ label: 'Review' }] },
  ] } }, { picker() { picks++; return { value: 'Do not disclose' }; },
    readLine() { assert.fail('safe access and secret exclusions must not prompt'); },
  });
  assert.match(result.answers.safe.answers[0], /already authorized/u);
  assert.match(result.answers.secret.answers[0], /Exclude it automatically/u);
  assert.deepEqual(result.answers.effect.answers, ['Do not disclose']);
  assert.equal(picks, 1);
});

test('the npm package entry runs the Cruise CLI', () => {
  const result = spawnSync(process.execPath, [resolve('index.js'), '--version'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim(), CLI_VERSION);

  const help = spawnSync(process.execPath, [resolve('index.js'), '--help'], {
    encoding: 'utf8',
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /4 Goal bootstrap timeout/u);
  assert.match(help.stdout, /5 transport inactivity/u);
  assert.match(help.stdout, /cruise reference --status/u);
  assert.match(help.stdout, /--reasoning-escalation-evidence <text>/u);
});

test('app-server stderr is attributed across chunk boundaries', () => {
  const client = new EventEmitter();
  let output = '';
  const detach = surfaceAppServerStderr(client, { write(value) { output += value; } });
  client.emit('stderr', 'first\npar');
  client.emit('stderr', 'tial\nthird\n');
  detach();
  client.emit('stderr', 'ignored\n');
  assert.equal(output, 'codex: first\ncodex: partial\ncodex: third\n');
});

test('the public CLI accepts direct requests and rejects retired control-plane flags', () => {
  assert.deepEqual(parseArgs(['quick', '-C', '/tmp', 'Fix', 'it']), {
    command: 'quick',
    skill: 'quick',
    provider: 'codex',
    cwd: '/tmp',
    json: false,
    help: false,
    version: false,
    level: null,
    externalSandbox: false,
    userStatus: null,
    commit: null,
    weeklyDeltaCap: 9,
    goalReservation: 2.25,
    strictBudget: false,
    promptParts: ['Fix', 'it'],
    prompt: 'Fix it',
  });
  assert.deepEqual(parseArgs(['worker', '--level', '6', 'Run', 'tests']), {
    command: 'worker',
    skill: 'goal',
    provider: 'codex',
    cwd: process.cwd(),
    json: false,
    help: false,
    version: false,
    level: 6,
    externalSandbox: false,
    userStatus: null,
    commit: null,
    weeklyDeltaCap: 9,
    goalReservation: 2.25,
    strictBudget: false,
    promptParts: ['Run', 'tests'],
    prompt: 'Run tests',
  });
  assert.equal(parseArgs(['config', 'show']).configAction, 'show');
  assert.throws(() => parseArgs(['config', 'class']), /requires show or validate/u);
  assert.throws(() => parseArgs(['worker', '--level', '8', 'Run']), /integer from 1 through 7/u);
  assert.throws(() => parseArgs(['quick', '--level', '5', 'Fix']), /only by cruise worker/u);
  assert.throws(() => parseArgs(['goal', '--packet', 'task.yaml']), /not supported/u);
  assert.throws(() => parseArgs(['doctor', '--install-worker-rule']), /not supported/u);
  assert.throws(() => parseArgs(['picker-demo']), /was removed/u);
  assert.equal(parseArgs(['goal', '--plan', 'Design it']).planOnly, true);
  assert.throws(() => parseArgs(['quick', '--plan', 'Patch it']), /only by cruise goal/u);
  assert.equal(parseArgs(['reference', '--status', 'completed']).userStatus, 'completed');
  assert.equal(
    parseArgs(['--claude', 'changelog', '--commit', 'a1b2c3d4']).commit,
    'a1b2c3d4',
  );
  assert.throws(
    () => parseArgs(['changelog']),
    /requires --commit/u,
  );
  assert.throws(
    () => parseArgs(['reference', '--status', 'complete']),
    /completed, blocked, aborted, unfinished, or not_started/u,
  );
  assert.throws(
    () => parseArgs(['reference', '--status', 'completed', 'extra']),
    /Unexpected reference argument/u,
  );
  assert.equal(
    parseArgs(['--claude', 'goal', '--resume', '12345678-abcd']).resumeSessionId,
    '12345678-abcd',
  );
  assert.throws(
    () => parseArgs(['--claude', 'goal', '--resume', '12345678-abcd', 'Continue']),
    /preserves the original Goal/u,
  );
  assert.throws(
    () => parseArgs(['goal', '--resume', '12345678-abcd', 'Continue']),
    /only by `cruise --claude goal`/u,
  );
  assert.throws(
    () => parseArgs(['refine', 'Plan it']),
    /Refine was folded into Goal.*plan only/u,
  );
});

test('the release exposes four public skills plus the internal context policy', async () => {
  assert.deepEqual(PUBLIC_SKILLS, ['build', 'quick', 'goal', 'debug']);
  const discovered = (await readdir(resolve('skills'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(discovered, [...PUBLIC_SKILLS, 'context-economy'].sort());
  const packageVersion = JSON.parse(await readFile(resolve('package.json'), 'utf8')).version;
  const codex = JSON.parse(await readFile(resolve('.codex-plugin/plugin.json'), 'utf8'));
  const claude = JSON.parse(await readFile(resolve('.claude-plugin/plugin.json'), 'utf8'));
  const goalSkill = await readFile(resolve('skills/goal/SKILL.md'), 'utf8');
  assert.equal(packageVersion, '0.4.3');
  assert.equal(codex.version, packageVersion);
  assert.equal(claude.version, packageVersion);
  assert.doesNotMatch(JSON.stringify(codex.interface.defaultPrompt), /refine/u);
  assert.match(goalSkill, /native\s+parallel bookkeeping agent/u);
  assert.match(goalSkill, /cruise changelog --commit <oid>/u);
});

test('attest is a prompt-free inspection command with machine-readable output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-attest-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = parseArgs(['attest', '--json', '-C', root]);
  assert.equal(options.command, 'attest');
  assert.equal(options.prompt, '');
  let output = '';
  assert.equal(await runAttest(options, {
    output: { write(value) { output += value; } },
    planInspector: async () => ({
      state: 'valid',
      plan: { version: 1, status: 'complete' },
    }),
  }), 2);
  const report = JSON.parse(output);
  assert.equal(report.level, 'legacy-unattested');
  assert.equal(report.ready_for_completion, false);
  assert.equal(report.allows_completion, false);
});

test('provider selectors are request-scoped, mutually exclusive, and default to Codex', () => {
  assert.equal(parseArgs(['quick', 'Fix'], { env: {} }).provider, 'codex');
  assert.equal(parseArgs(['--claude', 'quick', 'Fix'], { env: {} }).provider, 'claude');
  assert.equal(parseArgs(['quick', '--provider', 'claude', 'Fix'], { env: {} }).provider, 'claude');
  assert.equal(parseArgs(['quick', 'Fix'], { env: { CRUISE_PROVIDER: 'claude' } }).provider, 'claude');
  assert.throws(() => parseArgs(['--codex', '--claude', 'quick', 'Fix'], { env: {} }), /only one provider/u);
  assert.throws(() => parseArgs(['--provider', 'other', 'quick', 'Fix'], { env: {} }), /provider must be one of/u);
});

test('workers receive ordinary text and an explicit, request-scoped level', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-worker-text-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const result = await runWorker({ cwd: root, prompt: 'Run one check.', level: 5 }, {
    async worker(input) {
      calls.push(input);
      assert.equal((await lstat(input.runtimeDirectory)).isDirectory(), true);
      return { output: '', effectsObserved: false };
    },
  });
  assert.equal(result, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, await realpath(root));
  assert.equal(calls[0].task, 'Run one check.');
  assert.equal(calls[0].level, 5);
  assert.equal(calls[0].externalSandbox, false);
  assert.equal(typeof calls[0].sessionId, 'string');
  await assert.rejects(lstat(calls[0].runtimeDirectory), { code: 'ENOENT' });
  assert.equal(typeof calls[0].onOutput, 'function');
  assert.equal(typeof calls[0].onServerRequest, 'function');
  assert.equal(Object.hasOwn(calls[0], 'outputSchema'), false);
});

test('external sandbox is explicit, Codex-only, and limited to Goal and worker commands', () => {
  for (const command of ['goal', 'worker']) {
    assert.equal(parseArgs([command, 'Task'], { env: {} }).externalSandbox, false);
    assert.equal(parseArgs(['--codex', command, '--external-sandbox', 'Task'], { env: {} }).externalSandbox, true);
    assert.throws(() => parseArgs(['--claude', command, '--external-sandbox', 'Task'], { env: {} }), /only.*codex/u);
  }
  assert.equal(parseArgs(['goal', '--external-sandbox', '--plan', 'Task'], { env: {} }).planOnly, true);
  for (const command of ['start', 'quick', 'build', 'debug', 'queue', 'doctor', 'changelog', 'budget', 'usage', 'attest', 'reference', 'help']) {
    assert.throws(() => parseArgs([command, '--external-sandbox'], { env: {} }), /only.*codex/u);
  }
  for (const args of [['config', 'show'], ['migrate', 'status']]) {
    assert.throws(() => parseArgs([...args, '--external-sandbox'], { env: {} }), /only.*codex/u);
  }
  assert.throws(() => parseArgs(['goal', '--external-sandbox', 'Task'], { env: { CRUISE_PROVIDER: 'claude' } }), /only.*codex/u);
  assert.equal(parseArgs(['goal', '--', '--external-sandbox'], { env: {} }).externalSandbox, false);
  assert.equal(parseArgs(['goal', 'Task'], { env: { CRUISE_EXTERNAL_SANDBOX: '1' } }).externalSandbox, false);
});

test('external sandbox CLI option reaches hosted Goals and managed workers', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-external-routing-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const goalOptions = parseArgs(['--codex', 'goal', '--external-sandbox', '-C', cwd, 'Inspect ordinary source.'], { env: {} });
  const result = await runOneGoal(goalOptions, {
    clientFactory: () => ({}),
    sessionFactory(input) {
      assert.equal(input.externalSandbox, true);
      return { async run() { return { status: 'complete' }; }, async interrupt() {} };
    },
  });
  assert.equal(result.exitCode, 0);
  await writeFile(join(cwd, 'ordinary.txt'), 'fixture');
  const options = managedParentOptions(cwd);
  options.externalSandbox = true;
  const client = new ManagedParentTransport();
  assert.equal(await runWorker(options, { env: {}, workerClientFactory: () => client, enforceBudget: false }), 0);
  const turn = client.requests.find(({ method }) => method === 'turn/start').params;
  assert.deepEqual(turn.sandboxPolicy, { type: 'externalSandbox', networkAccess: 'restricted' });
  assert.equal(turn.approvalPolicy, 'on-request');
  assert.equal(client.stopped, true);
});

test('managed CLI routing requires explicit reasoning evidence for an L6-to-L7 transition', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-managed-l7-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const handoff = JSON.stringify({
    outcome: 'Completed the bounded routing check.',
    completed_work: ['Observed the selected worker request.'],
    changed_files: [],
    decisions_and_invariants: ['Preserved fail-closed model selection.'],
    exact_tests: ['node --test tests/cli-simple.test.mjs'],
    active_blocker_or_next_work_item: 'None.',
    files_not_to_reread: [],
    evidence_pointers: [],
    usage_and_quota_summary: 'Mock worker; no model usage.',
  });
  const worker = async (input) => {
    calls.push(input);
    return { output: handoff, effectsObserved: false };
  };
  const dispatchLedgerFactory = () => ({
    async reserve() {
      return { async release() {} };
    },
  });
  const common = [
    '--managed',
    '--owns', 'scripts/lib/simple-worker.mjs',
    '--evidence', 'The build tool exited before producing a result.',
    '--range', 'scripts/lib/simple-worker.mjs:140-190',
    '--verify', 'node --test tests/simple-worker.test.mjs',
    '--exceptional-consequence', 'irreversible production effect',
    '--exceptional-rationale', 'the focused trace proves there is no rollback path',
    '-C', root,
  ];

  await runWorker(parseArgs([
    'worker', ...common, '--complexity', 'exceptional', 'Run', 'direct', 'exceptional', 'work.',
  ]), { worker, dispatchLedgerFactory, env: {} });
  await runWorker(parseArgs([
    'worker', ...common, '--complexity', 'repeated', '--level', '7',
    'Retry', 'after', 'the', 'tool', 'failure.',
  ]), { worker, dispatchLedgerFactory, env: {} });
  await runWorker(parseArgs([
    'worker', ...common, '--complexity', 'repeated', '--level', '7',
    '--reasoning-escalation-evidence', 'The focused trace isolates reasoning as the remaining uncertainty.',
    'Resolve', 'the', 'isolated', 'reasoning', 'blocker.',
  ]), { worker, dispatchLedgerFactory, env: {} });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].level, 7);
  assert.equal(calls[0].transition, null);
  assert.equal(calls[1].level, 7);
  assert.equal(calls[1].transition, null);
  assert.equal(calls[2].level, 7);
  assert.deepEqual(calls[2].transition, {
    kind: 'escalation',
    work_item: 'Resolve the isolated reasoning blocker.',
    evidence: 'The focused trace isolates reasoning as the remaining uncertainty.',
    from_level: 6,
    failure_category: 'reasoning',
    exceptional_consequence: {
      consequence: 'irreversible production effect',
      rationale: 'the focused trace proves there is no rollback path',
    },
  });
  assert.match(calls[2].task, /The focused trace isolates reasoning as the remaining uncertainty\./u);
});

test('reasoning escalation evidence rejects incomplete or non-Codex worker routes', () => {
  const common = [
    'worker',
    '--managed',
    '--owns', 'scripts/lib/simple-worker.mjs',
    '--evidence', 'A generic context fact.',
    '--range', 'scripts/lib/simple-worker.mjs:140-190',
    '--verify', 'node --test tests/simple-worker.test.mjs',
    '--complexity', 'repeated',
    '--level', '7',
    '--exceptional-consequence', 'irreversible production effect',
    '--exceptional-rationale', 'the focused trace proves there is no rollback path',
    '--reasoning-escalation-evidence', 'Reasoning remains the isolated blocker.',
    'Resolve', 'it.',
  ];
  const without = (...values) => common.filter((value) => !values.includes(value));
  const replace = (from, to) => common.map((value) => value === from ? to : value);

  assert.throws(
    () => parseArgs(without('--managed')),
    /requires a managed Codex worker/u,
  );
  assert.throws(
    () => parseArgs(replace('repeated', 'complex')),
    /requires a managed Codex worker/u,
  );
  assert.throws(
    () => parseArgs(without('--level', '7')),
    /requires a managed Codex worker/u,
  );
  assert.throws(
    () => parseArgs(without('--exceptional-consequence', 'irreversible production effect')),
    /must be supplied together/u,
  );
  assert.throws(
    () => parseArgs(without(
      '--exceptional-consequence',
      'irreversible production effect',
      '--exceptional-rationale',
      'the focused trace proves there is no rollback path',
    )),
    /requires a managed Codex worker/u,
  );
  assert.throws(
    () => parseArgs(['--claude', ...common]),
    /requires a managed Codex worker/u,
  );
});

test('reference command delegates deterministic user-document writing without reading outputs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-reference-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeOriginPrompt(root, 'Keep the exact request.');
  const calls = [];
  const finalizations = [];
  let output = '';
  const result = await runReference({
    cwd: root,
    provider: 'codex',
    userStatus: 'completed',
  }, {
    async userDocumentWriter(input) {
      calls.push(input);
      return {
        referencePath: join(root, '_FOR_USER_REFERENCE.md'),
        changelogPath: join(root, '_CHANGELOG.md'),
      };
    },
    async controlFinalizer(cwd, input) {
      finalizations.push({ cwd, input });
    },
    output: { write(value) { output += value; } },
  });
  assert.equal(result, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, 'Keep the exact request.');
  assert.equal(calls[0].status, 'completed');
  assert.equal(calls[0].includeFlight, true);
  assert.deepEqual(finalizations, [{
    cwd: await realpath(root),
    input: { status: 'complete', started: true },
  }]);
  assert.match(output, /_FOR_USER_REFERENCE\.md/u);
  assert.doesNotMatch(output, /_CHANGELOG\.md/u);
});

test('direct changelog command delegates one exact commit through isolated scratch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-changelog-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  let output = '';
  const result = await runCommitChangelog({
    cwd: root,
    provider: 'codex',
    commit: 'a1b2c3d4',
  }, {
    async runtimeFactory(input) {
      calls.push(['runtime', input]);
      return join(root, 'runtime');
    },
    observerFactory(input) {
      calls.push(['observer', input]);
      return {
        async processCommit(commit) { calls.push(['commit', commit]); },
      };
    },
    async runtimeCleanup(directory, input) {
      calls.push(['cleanup', directory, input]);
    },
    output: { write(value) { output += value; } },
  });
  assert.equal(result, 0);
  assert.equal(calls[0][0], 'runtime');
  assert.equal(calls[0][1].kind, 'changelog');
  assert.equal(calls[1][0], 'observer');
  assert.deepEqual(calls[2], ['commit', 'a1b2c3d4']);
  assert.equal(calls[3][0], 'cleanup');
  assert.match(output, /Recorded commit a1b2c3d4/u);
});

test('Claude workers use the Claude adapter without touching Codex app-server', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-claude-worker-text-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const result = await runWorker({
    cwd: root,
    prompt: 'Run one check.',
    level: 6,
    provider: 'claude',
  }, {
    async worker() {
      throw new Error('Codex worker must not run');
    },
    async claudeWorker(input) {
      calls.push(input);
      return { output: '', effectsObserved: false };
    },
  });
  assert.equal(result, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].task, 'Run one check.');
  assert.equal(calls[0].level, 6);
});

class StartClient extends EventEmitter {
  async start() {}
  async stop() {}
  async request(method) {
    if (method === 'thread/start') return { thread: { id: 'thread' } };
    if (method === 'turn/start') {
      queueMicrotask(() => this.emit('notification', {
        method: 'turn/completed',
        params: { turn: { id: 'turn', status: 'completed' } },
      }));
      return { turn: { id: 'turn' } };
    }
    throw new Error(`unexpected request ${method}`);
  }
}

test('a completed ordinary Cruise task removes its transient ORIGIN control file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-start-simple-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prompt = 'Keep these two spaces.  \nAnd this newline.';
  let clientOptions;
  assert.equal(await runStart({ cwd: root, prompt, skill: 'quick' }, {
    clientFactory: (options) => {
      clientOptions = options;
      return new StartClient();
    },
  }), 0);
  assert.equal(typeof clientOptions.spawnOptions.env.CRUISE_RUNTIME_DIR, 'string');
  assert.equal(typeof clientOptions.spawnOptions.env.CRUISE_SESSION_ID, 'string');
  await assert.rejects(lstat(clientOptions.spawnOptions.env.CRUISE_RUNTIME_DIR), { code: 'ENOENT' });
  await assert.rejects(readOriginPrompt(root), { code: 'ENOENT' });
});

test('launcher runs commit observation around the hosted session before deleting scratch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-start-summary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documentCalls = [];
  const lifecycle = [];
  let runtimeDirectory;
  assert.equal(await runStart({ cwd: root, prompt: 'Patch the script.', skill: 'goal' }, {
    clientFactory: () => ({}),
    commitObserverFactory(input) {
      runtimeDirectory = input.runtimeDirectory;
      return {
        async start() {
          lifecycle.push('observer:start');
          assert.equal((await lstat(runtimeDirectory)).isDirectory(), true);
        },
        async stop() {
          lifecycle.push('observer:stop');
          assert.equal((await lstat(runtimeDirectory)).isDirectory(), true);
        },
      };
    },
    sessionFactory(input) {
      return {
        async run() {
          lifecycle.push('session');
          return { status: 'complete' };
        },
        async interrupt() {},
      };
    },
    async userDocumentWriter(input) { documentCalls.push(input); },
  }), 0);
  assert.deepEqual(lifecycle, ['observer:start', 'session', 'observer:stop']);
  assert.equal(documentCalls[0].changeSummaries, undefined);
  await assert.rejects(lstat(runtimeDirectory), { code: 'ENOENT' });
});

test('the run-one-goal seam does not replace ORIGIN.md', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-one-goal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runOneGoal({ cwd: root, prompt: 'Execute M1.', provider: 'codex' }, {
    clientFactory: () => ({}),
    sessionFactory() {
      return {
        async run() { return { status: 'complete' }; },
        async interrupt() {},
      };
    },
  });
  assert.deepEqual(result, { status: 'complete', exitCode: 0 });
  await assert.rejects(readOriginPrompt(root), { code: 'ENOENT' });
});

test('a supervised Goal stall maps to exit code 3', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-start-stalled-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalRoot = await realpath(root);
  const documentCalls = [];
  const result = await runStart({ cwd: root, prompt: 'Finish it.', skill: 'goal' }, {
    clientFactory: () => ({}),
    sessionFactory(input) {
      assert.equal(input.cwd, canonicalRoot);
      return {
        async run() { return { status: 'stalled' }; },
        async interrupt() {},
      };
    },
    async userDocumentWriter(input) { documentCalls.push(input); },
  });
  assert.equal(result, 3);
  assert.equal(documentCalls.length, 1);
  assert.equal(documentCalls[0].status, 'stalled');
  assert.equal(documentCalls[0].started, true);
  assert.equal(documentCalls[0].includeFlight, false);
});

test('a fresh failed Goal never records an unchanged prior Flight as current', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-start-stale-flight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFlightPlan(root, {
    version: 1,
    status: 'complete',
    outcome: 'Unrelated prior Goal',
    verify: [],
    scope: { touchpoints: [], nonGoals: [] },
    invariants: [],
    stall: { quietTurns: 3, sameFailure: 3 },
    body: '# Prior Goal',
  });
  const documentCalls = [];
  assert.equal(await runStart({
    cwd: root,
    prompt: 'Start a different Goal.',
    skill: 'goal',
    provider: 'codex',
  }, {
    clientFactory: () => ({}),
    sessionFactory() {
      return {
        async run() { return { status: 'stalled' }; },
        async interrupt() {},
      };
    },
    async userDocumentWriter(input) { documentCalls.push(input); },
  }), 3);
  assert.equal(documentCalls.length, 1);
  assert.equal(documentCalls[0].includeFlight, false);
});

test('a native Goal bootstrap timeout maps to exit code 4', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-start-bootstrap-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  class NoTurnStartClient extends EventEmitter {
    constructor() {
      super();
      this.goal = null;
      this.statuses = [];
    }

    async start() {}
    async stop() {}

    async request(method, params = {}) {
      if (method === 'thread/start') {
        return { thread: { id: 'thread-timeout' }, model: 'gpt-5.6-sol', reasoningEffort: 'high' };
      }
      if (method === 'thread/settings/update') return {};
      if (method === 'thread/read') return { thread: { status: { type: 'idle' } } };
      if (method === 'thread/turns/list') return { data: [] };
      if (method === 'turn/start') return new Promise(() => {});
      if (method === 'thread/goal/get') return { goal: this.goal };
      if (method === 'thread/goal/set') {
        this.statuses.push(params.status);
        this.goal = { objective: params.objective, status: params.status };
        return { goal: this.goal };
      }
      throw new Error(`unexpected request ${method}`);
    }
  }
  const client = new NoTurnStartClient();
  let errorOutput = '';
  const documentCalls = [];
  const result = await runStart({ cwd: root, prompt: 'Finish it.', skill: 'goal' }, {
    clientFactory: () => client,
    sessionFactory(input) {
      return new SimpleCruiseSession({
        ...input,
        output: { write() {} },
        errorOutput: { write(value) { errorOutput += value; } },
        firstTurnDeadlineMs: 10,
        firstTurnCleanupDeadlineMs: 20,
      });
    },
    async userDocumentWriter(input) { documentCalls.push(input); },
  });
  assert.equal(result, 4);
  assert.deepEqual(client.statuses, ['active', 'paused']);
  assert.match(errorOutput, /Cruise: app-server started\./u);
  assert.match(errorOutput, /Cruise: waiting for the native Goal turn\./u);
  assert.equal(documentCalls.length, 1);
  assert.equal(documentCalls[0].status, 'failed');
  assert.equal(documentCalls[0].started, false);
});

test('transport inactivity maps to exit code 5', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-start-inactivity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runStart({ cwd: root, prompt: 'Finish it.', skill: 'quick' }, {
    clientFactory: () => new EventEmitter(),
    sessionFactory() {
      return {
        async run() {
          const error = new Error('transport inactivity observed');
          error.code = 'CRUISE_TRANSPORT_INACTIVITY';
          throw error;
        },
        async interrupt() {},
      };
    },
  });
  assert.equal(result, 5);
});

test('Claude start receives an exact runtime directory and removes terminal control files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-start-claude-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const documentCalls = [];
  const result = await runStart({
    cwd: root,
    prompt: 'Implement it.',
    skill: 'goal',
    provider: 'claude',
  }, {
    async claudeRunner(input) {
      calls.push(input);
      return { status: 'complete', exitCode: 0 };
    },
    async userDocumentWriter(input) { documentCalls.push(input); },
  });
  assert.equal(result, 0);
  await assert.rejects(readOriginPrompt(root), { code: 'ENOENT' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, await realpath(root));
  assert.equal(calls[0].skill, 'goal');
  assert.match(calls[0].runtimeDirectory, /cruise-runs/u);
  assert.equal(calls[0].pluginRoot, await realpath(new URL('..', import.meta.url)));
  assert.equal(documentCalls.length, 1);
  assert.equal(documentCalls[0].status, 'complete');
  assert.equal(documentCalls[0].started, true);
});

test('Claude resume preserves a blocked original request and does not reinvoke the Goal skill', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-resume-claude-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runStart({
    cwd: root,
    prompt: 'Original intention.',
    skill: 'goal',
    provider: 'claude',
  }, {
    async claudeRunner() {
      return { status: 'blocked', exitCode: 2 };
    },
  });
  assert.equal(await readOriginPrompt(root), 'Original intention.');
  const calls = [];
  assert.equal(await runStart({
    cwd: root,
    prompt: '',
    skill: 'goal',
    provider: 'claude',
    resumeSessionId: '12345678-abcd',
  }, {
    async claudeRunner(input) {
      calls.push(input);
      return { status: 'complete', exitCode: 0 };
    },
  }), 0);
  await assert.rejects(readOriginPrompt(root), { code: 'ENOENT' });
  assert.equal(calls[0].prompt, '');
  assert.equal(calls[0].resumeSessionId, '12345678-abcd');
});

test('Claude non-Goal runs reserve the workspace without activating Goal supervision', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-quick-claude-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let active;
  assert.equal(await runStart({
    cwd: root,
    prompt: 'Patch it.',
    skill: 'quick',
    provider: 'claude',
  }, {
    async claudeRunner(input) {
      active = await isGoalSessionActive({
        cwd: input.cwd,
        session_id: input.sessionId,
      });
      return { status: 'complete', exitCode: 0 };
    },
  }), 0);
  assert.equal(active, false);
});

test('Codex Doctor checks transport, version, and effective installed Cruise content', () => {
  const calls = [];
  const report = localDoctorReport((binary, args) => {
    calls.push([binary, args]);
    return {
      status: 0,
      output: args[0] === '--version'
        ? 'codex 1.0'
        : args[0] === 'plugin'
          ? JSON.stringify({
              installed: [{
                name: 'cruise',
                version: CLI_VERSION,
                installed: true,
                enabled: true,
              }],
            })
          : 'help',
      error: '',
    };
  }, {
    pluginFreshness: () => ({ status: 'pass', detail: 'critical bytes match' }),
  });
  assert.equal(report.ok, true);
  assert.equal(report.provider, 'codex');
  assert.deepEqual(report.checks.map(({ id }) => id), [
    'codex',
    'app-server',
    'codex-plugin',
    'codex-plugin-content',
  ]);
  assert.equal(report.checks.at(-1).status, 'pass');
  assert.deepEqual(calls, [
    ['codex', ['--version']],
    ['codex', ['app-server', '--help']],
    ['codex', ['plugin', 'list', '--json']],
  ]);
  const stale = localDoctorReport((binary, args) => ({
    status: 0,
    output: args[0] === 'plugin'
      ? JSON.stringify({
          installed: [{
            name: 'cruise',
            version: '0.3.0',
            installed: true,
            enabled: true,
          }],
        })
      : 'ok',
    error: '',
  }));
  assert.equal(stale.ok, false);
  assert.match(
    stale.checks.find(({ id }) => id === 'codex-plugin').detail,
    /Codex has Cruise 0\.3\.0/u,
  );
  assert.equal(stale.checks.find(({ id }) => id === 'codex-plugin-content').status, 'fail');
});

test('Codex plugin freshness detects same-version source and cache drift', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-plugin-freshness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  const codexHomeDirectory = join(root, 'codex-home');
  const installedRoot = join(
    codexHomeDirectory,
    'plugins',
    'cache',
    'agent-local',
    'cruise',
    CLI_VERSION,
  );
  for (const relativePath of CODEX_PLUGIN_FRESHNESS_PATHS) {
    const sourcePath = join(sourceRoot, relativePath);
    const installedPath = join(installedRoot, relativePath);
    await Promise.all([
      mkdir(dirname(sourcePath), { recursive: true }),
      mkdir(dirname(installedPath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(sourcePath, `source:${relativePath}\n`),
      writeFile(installedPath, `source:${relativePath}\n`),
    ]);
  }
  const plugin = {
    marketplaceName: 'agent-local',
    name: 'cruise',
    version: CLI_VERSION,
    source: { source: 'local', path: sourceRoot },
  };
  assert.deepEqual(
    codexPluginContentFreshness(plugin, { codexHomeDirectory }),
    { status: 'pass', detail: `Cruise ${CLI_VERSION} cache matches its configured source` },
  );

  await writeFile(join(sourceRoot, 'skills/goal/SKILL.md'), 'patched instructions\n');
  const stale = codexPluginContentFreshness(plugin, { codexHomeDirectory });
  assert.equal(stale.status, 'fail');
  assert.match(stale.detail, /cache is stale/u);
  assert.match(stale.detail, /active jobs selectively reconcile instruction drift/u);
  assert.match(stale.detail, /without a waiver or forced restart/u);
});

test('Claude Doctor checks the CLI, plugin, and authentication', () => {
  const calls = [];
  const report = localDoctorReport((binary, args) => {
    calls.push([binary, args]);
    return {
      status: 0,
      output: args[0] === '--version'
        ? '2.1.209'
        : args[0] === 'auth'
          ? '{"loggedIn":true,"email":"dev@example.com"}'
          : 'valid',
      error: '',
    };
  }, { provider: 'claude', pluginRoot: '/tmp/cruise' });
  assert.equal(report.ok, true);
  assert.equal(report.provider, 'claude');
  assert.deepEqual(report.checks.map(({ id }) => id), [
    'claude',
    'claude-plugin',
    'claude-auth',
    'claude-health',
  ]);
  assert.deepEqual(calls, [
    ['claude', ['--version']],
    ['claude', ['plugin', 'validate', '/tmp/cruise']],
    ['claude', ['auth', 'status']],
    ['claude', ['doctor']],
  ]);
});

test('native reviewer CLI is request-scoped and limited to Codex Goal and worker', () => {
  for (const reviewer of ['user', 'auto_review', 'guardian_subagent']) {
    for (const command of ['start', 'goal', 'worker']) {
      assert.equal(parseArgs(['--codex', command, '--approvals-reviewer', reviewer, 'Inspect source']).approvalsReviewer, reviewer);
      assert.equal(parseArgs(['--codex', command, `--approvals-reviewer=${reviewer}`, 'Inspect source']).approvalsReviewer, reviewer);
    }
  }
  for (const command of ['quick', 'build', 'debug', 'queue', 'doctor', 'usage', 'budget', 'reference', 'changelog', 'attest', 'help']) {
    assert.throws(() => parseArgs([command, '--approvals-reviewer', 'auto_review']), /only by Codex Goal and worker/u);
  }
  for (const command of ['start', 'goal', 'worker']) {
    assert.throws(() => parseArgs(['--claude', command, '--approvals-reviewer', 'user', 'Inspect source']), /only by Codex Goal and worker/u);
  }
  for (const value of ['', 'accept', 'never', 'AUTO_REVIEW', '--plan']) {
    assert.throws(() => parseArgs(['goal', '--approvals-reviewer', value, 'Inspect source']), /requires user, auto_review, or guardian_subagent/u);
  }
  assert.throws(() => parseArgs(['goal', '--approvals-reviewer']), /requires user, auto_review, or guardian_subagent/u);
  assert.equal(parseArgs(['goal', 'Inspect source']).approvalsReviewer, undefined);
});

test('launcher forwards injected native reviewer defaults and overrides to Goal and worker', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'cruise-reviewer-cli-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const [isTTY, override, expected] of [
    [true, undefined, 'user'], [false, undefined, 'auto_review'],
    [false, 'user', 'user'], [true, 'auto_review', 'auto_review'],
    [false, 'guardian_subagent', 'guardian_subagent'],
  ]) {
    const input = { isTTY };
    await runOneGoal({ cwd, prompt: 'Inspect source.', provider: 'codex', approvalsReviewer: override }, {
      input, clientFactory: () => ({}),
      sessionFactory(options) {
        assert.equal(options.approvalsReviewer, expected);
        assert.equal(options.input, input);
        return { async run() { return { status: 'complete' }; }, async interrupt() {} };
      },
    });
    await runWorker({ cwd, prompt: 'Inspect source.', provider: 'codex', approvalsReviewer: override }, {
      input,
      worker: async (options) => {
        assert.equal(options.approvalsReviewer, expected);
        assert.equal(options.stdin, input);
        return { output: '' };
      },
    });
  }
});
