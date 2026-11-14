import nativeAssert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, realpath, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

export class UnsupportedAdapterError extends Error { constructor(message) { super(message); this.code = 'HARNESS_UNSUPPORTED'; } }
async function load(target, path, names) {
  let module;
  try { module = await import(pathToFileURL(join(target, path)).href); }
  catch (error) { throw new UnsupportedAdapterError(`Cannot load ${path}: ${error.message}`); }
  for (const name of names) if (typeof module[name] !== 'function') throw new UnsupportedAdapterError(`Missing API ${path}#${name}`);
  return module;
}
const quiet = { write() {} };
let assertionCount = 0;
const assert = new Proxy(nativeAssert, { get(object, name) {
  const value = object[name];
  return typeof value === 'function' ? (...args) => { assertionCount += 1; return value(...args); } : value;
} });
const caught = async (fn) => { try { await fn(); return null; } catch (error) { return error; } };
const permissionFields = ['approvalPolicy', 'approvalsReviewer', 'permissions', 'sandbox', 'sandboxPolicy', 'runtimeWorkspaceRoots'];
function assertNativePermissionOmissions(calls) {
  const relevant = calls.filter(({ method }) => ['thread/start', 'thread/settings/update', 'turn/start'].includes(method));
  assert.ok(relevant.length > 0, 'The adapter must observe actual permission-bearing RPC methods');
  for (const { method, params } of relevant) {
    for (const field of permissionFields) assert.equal(Object.hasOwn(params, field), false,
      `${method} must inherit native ${field}; Cruise must omit the override`);
  }
  return relevant.map(({ method, params }) => ({ method, params }));
}
function sessionOptions(root) {
  return { cwd: root, prompt: 'Execute the synthetic bounded fixture.', skill: 'quick', skillPath: '/synthetic/SKILL.md',
    output: quiet, errorOutput: quiet, locateTrace: async () => null, traceHome: join(root, 'empty-native-home') };
}

async function approval(c, { target, root }) {
  const { SimpleCruiseSession } = await load(target, 'scripts/lib/simple-session.mjs', ['SimpleCruiseSession']);
  const { createLineReader } = await load(target, 'scripts/lib/line-input.mjs', ['createLineReader']);
  const { pickOne } = await load(target, 'scripts/lib/picker.mjs', ['pickOne']);
  class Client extends EventEmitter {
    responses = []; errors = []; watchdog = [];
    respond(id, result) { this.responses.push({ id, result }); }
    respondError(id, error) { this.errors.push({ id, error }); }
    pauseInactivityWatchdog() { this.watchdog.push('pause'); }
    resumeInactivityWatchdog() { this.watchdog.push('resume'); }
  }
  const client = new Client();
  const input = Readable.from(c.variant === 'eof' ? (c.noiseBefore ? ['invalid\n'] : []) : (c.noiseBefore ? ['invalid\n', '1\n'] : ['1\n']));
  const lineReader = createLineReader({ input });
  let rendered = '';
  const output = { write(value) { rendered += value; } };
  const decision = c.variant === 'structured'
    ? { applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'deny', host: `${c.token}.invalid` } } }
    : c.variant;
  const session = new SimpleCruiseSession({ ...sessionOptions(root), client, pickOne, input, lineReader,
    output, errorOutput: output,
    readLine: (options) => options.lineReader.question(options) });
  try {
    session.enqueueRequest({ id: c.token, method: c.method ?? 'item/commandExecution/requestApproval',
      params: { threadId: 't', turnId: 'u', itemId: 'i', command: 'synthetic',
        permissions: { network: { enabled: true } }, availableDecisions: [decision] } });
    await session.interactions;
    if (c.variant === 'eof') {
      assert.deepEqual(client.responses, [], 'EOF must never become an owner decision');
      assert.equal(client.errors.length, 1);
      assert.equal(client.errors[0].error.code, 'CRUISE_INPUT_UNAVAILABLE');
      assert.equal(client.errors[0].error.reason, 'eof');
    } else {
      assert.deepEqual(client.errors, []);
      assert.deepEqual(client.responses, [{ id: c.token, result: { decision } }]);
      if (c.variant === 'structured') {
        assert.equal(client.responses[0].result.decision, decision);
        assert.ok(rendered.includes(`${c.token}.invalid`));
        assert.match(rendered, /Deny.*persist/u);
        assert.doesNotMatch(rendered, /\[object Object\]/u);
      }
    }
    assert.deepEqual(client.watchdog, ['pause', 'resume']);
  } finally { lineReader.close(); }
  for (const event of ['data', 'end', 'close', 'error']) assert.equal(input.listenerCount(event), 0);
  return { assertions: 8, outcome: c.variant === 'eof' ? 'contained_host_failure' : 'owner_decision_preserved',
    observations: [{ responses: client.responses, errors: client.errors.map(({ error }) => ({ code: error.code, reason: error.reason })) }] };
}

async function classification(c, { target }) {
  const { classifyWorkerFailure } = await load(target, 'scripts/lib/simple-worker.mjs', ['classifyWorkerFailure']);
  const input = { message: c.message };
  if (c.status !== null) {
    if (c.statusField === 'cause') input.cause = { statusCode: c.status };
    else input.httpStatusCode = c.status;
  }
  const result = classifyWorkerFailure(input);
  assert.equal(result.category, c.category);
  assert.equal(result.httpStatusCode, c.status);
  assert.equal(result.message, c.message);
  return { assertions: 3, outcome: 'classification_only', observations: [{ input, result }] };
}

async function workerStartup(c, { target, root }) {
  const { runSimpleWorker } = await load(target, 'scripts/lib/simple-worker.mjs', ['runSimpleWorker']);
  const clients = [];
  class Client extends EventEmitter {
    requests = []; stops = 0;
    async failAt(stage) {
      if (stage !== c.stage) return;
      if (c.effects) this.emit('notification', { method: 'item/commandExecution/started', params: {} });
      if (c.event === 'exit') this.emit('exit', { error: new Error(`synthetic ${c.token} exit`) });
      else this.emit('notification', { method: 'error', params: { willRetry: false, error: { message: 'synthetic terminal failure' } } });
      // This full event-loop turn exposes unobserved early promise rejections.
      await new Promise((resolve) => setImmediate(resolve));
      const error = new Error(`synthetic ${stage} failure`);
      if (c.retry) error.code = 'ECONNRESET';
      throw error;
    }
    async start() { await this.failAt('start'); }
    async request(method) {
      this.requests.push(method);
      await this.failAt(method);
      if (method === 'thread/start') return { thread: { id: c.token } };
      throw new Error(`unexpected request ${method}`);
    }
    async stop() { this.stops += 1; throw new Error('synthetic cleanup failure'); }
  }
  const error = await caught(() => runSimpleWorker({ cwd: root, task: 'Synthetic fixture only.',
    clientFactory: () => { const client = new Client(); clients.push(client); return client; } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(error?.code, 'CRUISE_WORKER_STREAM_FAILURE');
  assert.equal(error.cause.message, `synthetic ${c.stage} failure`);
  assert.equal(clients.length, c.retry && !c.effects ? 2 : 1);
  for (const client of clients) {
    assert.equal(client.stops, 1);
    assert.equal(client.listenerCount('notification'), 0);
    assert.equal(client.listenerCount('exit'), 0);
  }
  return { assertions: 3 + clients.length * 3, outcome: 'contained_host_failure',
    observations: [{ error: error.code, attempts: clients.length, stops: clients.map((client) => client.stops), requests: clients.map((client) => client.requests) }] };
}

async function goalIntent(c, { target, root }) {
  const { SimpleCruiseSession } = await load(target, 'scripts/lib/simple-session.mjs', ['SimpleCruiseSession']);
  class Client extends EventEmitter {
    calls = []; goal = null; stopped = false;
    async start() {}
    async stop() { this.stopped = true; }
    async request(method, params = {}) {
      this.calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: c.token }, model: 'synthetic-native-default' };
      if (method === 'thread/settings/update') return {};
      if (method === 'thread/goal/get') return { goal: this.goal };
      if (method === 'thread/goal/set') { this.goal = { objective: params.objective, status: params.status }; return { goal: this.goal }; }
      if (method === 'thread/read') return { thread: { id: c.token, status: { type: 'idle' } } };
      if (method === 'turn/start') {
        const count = this.calls.filter((call) => call.method === method).length;
        const turn = { id: `${c.token}-${count}` };
        queueMicrotask(() => {
          this.emit('notification', { method: 'turn/started', params: { threadId: c.token, turn } });
          if (count === 2) this.goal = { ...this.goal, status: 'complete' };
          this.emit('notification', { method: 'turn/completed', params: { threadId: c.token, turn: { ...turn, status: 'completed' } } });
        });
        return { turn };
      }
      throw new Error(`unexpected ${method}`);
    }
  }
  const client = new Client();
  const prompt = ({
    'plan-only': `Only plan the synthetic change ${c.token}. Do not implement.`,
    'temporal-implement': `Do not implement until you have read the tests; then implement and verify the fix ${c.token}.`,
    'quoted-plan': `The previous agent said "plan only". Continue with implementation and verification ${c.token}.`,
    execute: `Use a brief read-only Plan turn, then execute the synthetic repair ${c.token} in Default mode.`,
  })[c.variant];
  const session = new SimpleCruiseSession({ ...sessionOptions(root), client, skill: 'goal', prompt,
    firstTurnDeadlineMs: 1000, firstTurnCleanupDeadlineMs: 1000 });
  const result = await session.run();
  const turns = client.calls.filter((call) => call.method === 'turn/start').map((call) => call.params);
  assert.equal(result.status, 'complete');
  assert.deepEqual(turns.map((turn) => turn.collaborationMode.mode), c.planOnly ? ['plan'] : ['plan', 'default']);
  const permissionCalls = assertNativePermissionOmissions(client.calls);
  assert.equal(client.stopped, true);
  return { outcome: 'synthetic_native_completion', observations: [{ planOnly: c.planOnly, modes: turns.map((turn) => turn.collaborationMode.mode), stopped: client.stopped, permissionCalls }] };
}

async function permissionInheritance(c, { target, root }) {
  const { SimpleCruiseSession } = await load(target, 'scripts/lib/simple-session.mjs', ['SimpleCruiseSession']);
  const { runSimpleWorker } = await load(target, 'scripts/lib/simple-worker.mjs', ['runSimpleWorker']);
  // These are opaque, synthetic host configuration inputs. Only RPC omission is
  // established here; the mock cannot prove native execution or OS isolation.
  const nativeProfile = Object.freeze({ id: `native-owner-${c.token}`,
    approvalPolicy: c.split === 'heldout' ? 'untrusted' : 'on-request',
    sandbox: c.split === 'heldout' ? 'read-only' : 'workspace-write',
    writableRoots: Object.freeze([join(root, 'owner-primary'), join(root, 'owner-extra')]),
    runtimeWorkspaceRoots: Object.freeze([join(root, 'native-runtime-root')]) });
  const originalProfile = JSON.stringify(nativeProfile); const clients = [];
  class Client extends EventEmitter {
    calls = []; goal = null; stops = 0;
    async start() {}
    async stop() { this.stops += 1; }
    async request(method, params = {}) {
      this.calls.push({ method, params });
      if (method === 'thread/start') {
        if (c.variant === 'native-denial') {
          const error = new Error('Synthetic native approval denied'); error.code = 'NATIVE_PERMISSION_DENIED'; throw error;
        }
        return { thread: { id: c.token, nativeProfile }, model: 'synthetic-native-default' };
      }
      if (method === 'thread/settings/update') return {};
      if (method === 'thread/goal/get') return { goal: this.goal };
      if (method === 'thread/goal/set') { this.goal = { objective: params.objective, status: params.status }; return { goal: this.goal }; }
      if (method === 'thread/read') return { thread: { id: c.token, status: { type: 'idle' } } };
      if (method === 'turn/start') {
        const count = this.calls.filter((call) => call.method === 'turn/start').length;
        const turn = { id: `${c.token}-${count}` };
        queueMicrotask(() => {
          this.emit('notification', { method: 'turn/started', params: { threadId: c.token, turn } });
          if (c.surface === 'goal' && count === 2) this.goal = { ...this.goal, status: 'complete' };
          this.emit('notification', { method: 'turn/completed', params: { threadId: c.token, turn: { ...turn, status: 'completed' } } });
        });
        return { turn };
      }
      throw new Error(`unexpected native fixture method ${method}`);
    }
  }
  const createClient = () => { const client = new Client(); clients.push(client); return client; };
  let result;
  const error = await caught(async () => {
    if (c.surface === 'worker') result = await runSimpleWorker({ cwd: root, task: 'Synthetic bounded task.', clientFactory: createClient });
    else result = await new SimpleCruiseSession({ ...sessionOptions(root), client: createClient(), skill: c.surface,
      firstTurnDeadlineMs: 1000, firstTurnCleanupDeadlineMs: 1000 }).run();
  });
  assert.equal(clients.length, 1, 'Native denial must never create a replacement permission attempt');
  const calls = clients.flatMap((client) => client.calls);
  const permissionCalls = assertNativePermissionOmissions(calls);
  assert.equal(JSON.stringify(nativeProfile), originalProfile);
  for (const client of clients) assert.equal(client.stops, 1);
  const turns = calls.filter((call) => call.method === 'turn/start');
  if (c.variant === 'native-denial') {
    assert.equal(result, undefined);
    assert.equal((c.surface === 'worker' ? error?.cause : error)?.code, 'NATIVE_PERMISSION_DENIED');
    assert.equal(turns.length, 0, 'No task turn may follow a denied thread start');
  } else {
    assert.equal(error, null);
    assert.equal(c.surface === 'worker' ? result.turnId.startsWith(c.token) : result.status === 'complete', true);
    assert.equal(turns.length, c.surface === 'goal' ? 2 : 1);
    if (c.surface === 'goal') assert.deepEqual(turns.map(({ params }) => params.collaborationMode.mode), ['plan', 'default']);
  }
  return { outcome: c.variant === 'native-denial' ? 'contained_native_denial' : 'permission_overrides_omitted',
    observations: [{ surface: c.surface, variant: c.variant, nativeProfile, permissionCalls,
      attempts: clients.length, stops: clients.map((client) => client.stops), turnCount: turns.length,
      limitation: 'Synthetic profile and denial only; actual native/outer-host permission enforcement is not evaluated.' }] };
}

async function goalAuthority(c, { target }) {
  const { automaticGoalProgress } = await load(target, 'scripts/lib/simple-session.mjs', ['automaticGoalProgress']);
  const question = c.variant === 'risk-in-option'
    ? { id: c.token, question: 'P-03 passed its readiness checks. What next?', options: [{ label: 'Approve P-03 deployment to production', value: 'deploy' }, { label: 'Stop', value: 'stop' }] }
    : { id: c.token, header: 'Add analytics not requested', question: 'Micro-goal is ready. What next?', options: [{ label: 'Implement the next micro-goal', value: 'implement' }, { label: 'Stop', value: 'stop' }] };
  const result = automaticGoalProgress({ questions: [question] });
  assert.equal(result, null, 'Risk/scope decisions require the native owner interaction');
  return { assertions: 1, outcome: 'human_decision_required', observations: [{ question, result }] };
}

async function transport(c, { target }) {
  const { AppServerClient } = await load(target, 'scripts/lib/app-server-client.mjs', ['AppServerClient']);
  class Peer extends EventEmitter {
    stdout = new PassThrough(); stderr = new PassThrough(); received = []; exited = false;
    stdin = new Writable({ write: (chunk, _encoding, callback) => {
      for (const line of String(chunk).trim().split('\n')) {
        const frame = JSON.parse(line); this.received.push(frame);
        if (frame.method === 'initialize') this.send({ id: frame.id, result: { userAgent: 'synthetic/1' } });
      }
      callback();
    } });
    constructor() { super(); this.stdin.on('finish', () => this.exit()); }
    send(frame) {
      const text = `${JSON.stringify(frame)}\n`;
      if (c.splitFrames) {
        const middle = Math.floor(text.length / 2);
        this.stdout.write(text.slice(0, middle)); this.stdout.write(text.slice(middle));
      } else this.stdout.write(text);
    }
    exit() { if (!this.exited) { this.exited = true; this.emit('exit', 0, null); } }
    kill() { this.exit(); return true; }
  }
  const peer = new Peer(); const errors = [];
  const client = new AppServerClient({ spawnFn: () => peer, onError: (error) => errors.push(error.message),
    inactivityTimeoutMs: c.variant === 'silent' ? 15 : 1000, initializeTimeoutMs: 1000, terminationTimeoutMs: 20 });
  try {
    await client.start();
    const first = client.request('synthetic/first', { token: c.token });
    // Attach rejection observers before triggering terminal events.
    const settledFirst = first.then((value) => ({ value }), (error) => ({ error }));
    if (c.variant === 'reordered-duplicate') {
      const second = client.request('synthetic/second');
      const requests = peer.received.filter((frame) => frame.method.startsWith('synthetic/'));
      peer.send({ id: requests[1].id, result: 'second' });
      peer.send({ id: requests[0].id, result: 'first' });
      peer.send({ id: requests[0].id, result: 'fabricated duplicate' });
      assert.equal((await settledFirst).value, 'first'); assert.equal(await second, 'second');
      assert.equal(errors.some((error) => /unknown request id/u.test(error)), true);
    } else {
      if (c.variant === 'closed') peer.exit();
      const result = await settledFirst;
      assert.ok(result.error, 'closed/silent peers cannot fabricate a successful RPC');
      if (c.variant === 'silent') assert.equal(result.error.code, 'CRUISE_TRANSPORT_INACTIVITY');
    }
  } finally { await client.stop({ timeoutMs: 30 }); }
  assert.equal(peer.exited, true);
  assert.equal(client._pending.size, 0);
  return { assertions: 5, outcome: c.variant === 'reordered-duplicate' ? 'rpc_identity_preserved' : 'contained_host_failure',
    observations: [{ variant: c.variant, peerExited: peer.exited, pending: client._pending.size, errors }] };
}

async function fingerprint(c, { target, root }) {
  const { captureWorkspaceFingerprint } = await load(target, 'scripts/lib/supervisor.mjs', ['captureWorkspaceFingerprint']);
  const capture = () => captureWorkspaceFingerprint(root, { excludeFlightPlan: true });
  const product = join(root, `product-${c.token}.txt`); const stamp = new Date('2020-01-01T00:00:00Z');
  await writeFile(product, 'before\n'); await utimes(product, stamp, stamp);
  const before = await capture(); assert.match(before, /^[a-f0-9]{64}$/u);
  if (c.variant === 'same-size') {
    const initial = await stat(product); await writeFile(product, 'after!\n'); await utimes(product, stamp, stamp);
    assert.equal((await stat(product)).size, initial.size); assert.equal((await stat(product)).mtimeMs, initial.mtimeMs);
    assert.notEqual(await capture(), before);
    await writeFile(product, 'before\n'); await utimes(product, stamp, stamp);
    assert.equal(await capture(), before, 'restore product before testing hidden input sensitivity');
    await writeFile(join(root, '.hidden-input'), c.token); assert.notEqual(await capture(), before);
  } else if (c.variant === 'private-exclusions') {
    for (const name of ['agents', '.codex', '.claude', '.aws', '.config', '.cruise']) {
      await mkdir(join(root, name)); await writeFile(join(root, name, 'synthetic-only.txt'), c.token);
    }
    for (const name of ['.env', '.npmrc', 'credentials.json', '_PRIVATE.md']) await writeFile(join(root, name), 'synthetic only');
    assert.equal(await capture(), before);
  } else {
    await symlink('../outside-does-not-exist', join(root, 'escape')); assert.equal(await capture(), null);
  }
  return { assertions: c.variant === 'same-size' ? 5 : 2, outcome: 'content_boundary_checked', observations: [{ variant: c.variant, initialFingerprint: before }] };
}

async function flight(c, { target, root }) {
  const { parseFlightPlan, flightPlanTemplate } = await load(target, 'scripts/lib/flight-plan.mjs', ['parseFlightPlan', 'flightPlanTemplate']);
  const { evaluateFlightAssurance, captureFlightContextFingerprint } = await load(target, 'scripts/lib/assurance.mjs', ['evaluateFlightAssurance', 'captureFlightContextFingerprint']);
  const { captureWorkspaceFingerprint } = await load(target, 'scripts/lib/supervisor.mjs', ['captureWorkspaceFingerprint']);
  const plan = parseFlightPlan(flightPlanTemplate()); plan.status = 'complete';
  await mkdir(join(root, '.cruise'));
  await writeFile(join(root, '.cruise/ORIGIN.md'), `Synthetic original request ${c.token}.`);
  await writeFile(join(root, 'product'), 'before\n');
  const captureContext = async () => captureFlightContextFingerprint(root, plan, {
    workspaceFingerprint: await captureWorkspaceFingerprint(root, { excludeFlightPlan: true }),
  });
  const context = await captureContext();
  if (c.variant === 'stale') {
    for (const gate of plan.quality.gates) {
      gate.state = 'passed'; gate.evidence = { summary: 'synthetic receipt, not artifact truth', contextFingerprint: context,
        observedAt: 1, source: gate.dimension === 'completion-review' ? 'review' : 'command', rationale: '', waivedBy: '' };
    }
    assert.equal(evaluateFlightAssurance(plan, context).allowsCompletion, true);
    await writeFile(join(root, 'product'), 'after!\n');
  }
  const updated = await captureContext();
  const result = evaluateFlightAssurance(plan, updated);
  assert.equal(result.allowsCompletion, false, 'Complete status without current evidence must be rejected');
  if (c.variant === 'stale') assert.notEqual(updated, context);
  return { assertions: c.variant === 'stale' ? 3 : 1, outcome: 'completion_rejected',
    observations: [{ variant: c.variant, allowsCompletion: result.allowsCompletion, reasons: result.reasons,
      limitation: 'Evidence summaries are synthetic; artifact content truth is not proved.' }] };
}

async function checkpoint(c, { target, root: rawRoot }) {
  const { resume } = await load(target, 'skills/goal/scripts/agent-context.mjs', ['resume']);
  const root = await realpath(rawRoot); const old = '20261114T180000000Z'; const newest = '20261114T180100000Z';
  const create = async (agent, time, task) => {
    const path = join(root, 'agents', agent, 'synthetic-session', time); await mkdir(path, { recursive: true });
    for (const [name, value] of Object.entries({ 'owner.json': JSON.stringify({ agent, session: 'synthetic-session' }),
      'task.md': task, 'progress.json': '{}', 'conversation.jsonl': '{"id":"m1","role":"user","text":"required synthetic fact"}\n',
      'context.requirements.txt': '{"path":"conversation.jsonl","start":1,"end":1,"why":"synthetic requirement"}\n' })) await writeFile(join(path, name), value);
    return path;
  };
  await create('synthetic-owner', old, 'OBSOLETE FALLBACK MUST NOT BE RETURNED');
  const path = await create('synthetic-owner', newest, `Continue ${c.token}`);
  let pattern;
  if (c.variant === 'owner') { await writeFile(join(path, 'owner.json'), '{"agent":"other","session":"synthetic-session"}'); pattern = /owner mismatch/u; }
  if (c.variant === 'task') { await writeFile(join(path, 'task.md'), ' \n'); pattern = /task must not be empty/u; }
  if (c.variant === 'progress') { await writeFile(join(path, 'progress.json'), '[]'); pattern = /progress must be an object/u; }
  if (c.variant === 'peer-pointer') {
    const peer = await create('synthetic-peer', newest, 'SYNTHETIC PEER');
    await writeFile(join(path, 'context.requirements.txt'), JSON.stringify({ path: join(peer, 'conversation.jsonl'), start: 1, end: 1, why: 'must reject' }));
    pattern = /checkpoint pointer rejected/u;
  }
  if (c.variant === 'fifo') {
    await unlink(join(path, 'task.md'));
    const made = spawnSync('mkfifo', [join(path, 'task.md')], { encoding: 'utf8', timeout: 1000 });
    if (made.status !== 0) throw new UnsupportedAdapterError(`mkfifo unavailable: ${made.stderr}`);
    pattern = /Non-regular input rejected/u;
  }
  if (pattern) await assert.rejects(resume(root, 'synthetic-owner', 'synthetic-session'), pattern);
  else {
    const result = JSON.parse(await resume(root, 'synthetic-owner', 'synthetic-session'));
    assert.equal(result.checkpoint, path); assert.equal(result.task, `Continue ${c.token}`);
    assert.equal(JSON.stringify(result).includes('OBSOLETE FALLBACK'), false);
  }
  return { assertions: pattern ? 1 : 3, outcome: pattern ? 'context_rejected' : 'latest_selected', observations: [{ variant: c.variant, syntheticOnly: true }] };
}

async function packageBoundary(c, { target, root }) {
  const metadata = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
  await writeFile(join(root, 'package.json'), JSON.stringify(metadata));
  const publicFiles = ['index.js', '.codex-plugin/plugin.json', 'skills/goal/SKILL.md'];
  const privateFiles = ['agents/fixture/session/timez/task.md', '.cruise/artifacts/private.txt', 'codex-history/session.jsonl',
    '.codex/session.jsonl', '.claude/session.jsonl', '.env', '.aws/credentials', '_PRIVATE.md', 'tests/robustness/private.json',
    'skills/context-economy.zip', 'skills/retired/SKILL.md'];
  for (const name of [...publicFiles, ...privateFiles]) {
    await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), `synthetic ${c.token}\n`);
  }
  const child = spawnSync('npm', ['--cache', join(root, 'cache'), '--ignore-scripts', 'pack', '--dry-run', '--json'],
    { cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
  const names = new Set(JSON.parse(child.stdout)[0].files.map((entry) => entry.path));
  for (const name of publicFiles) assert.equal(names.has(name), true, `missing public file ${name}`);
  for (const name of privateFiles) assert.equal(names.has(name), false, `private export ${name}`);
  return { assertions: 2 + publicFiles.length + privateFiles.length, outcome: 'package_boundary_checked', observations: [{ included: [...names], privateFilesChecked: privateFiles }] };
}

export const ADAPTERS = Object.freeze({ approval, classification, 'worker-startup': workerStartup,
  'goal-intent': goalIntent, 'goal-authority': goalAuthority, transport, fingerprint, flight, checkpoint,
  package: packageBoundary, 'permission-inheritance': permissionInheritance });
export async function executeCase(c, context) {
  if (!ADAPTERS[c.adapter]) throw new UnsupportedAdapterError(`Unknown adapter ${c.adapter}`);
  assertionCount = 0;
  const result = await ADAPTERS[c.adapter](c, context);
  return { ...result, assertions: assertionCount };
}
