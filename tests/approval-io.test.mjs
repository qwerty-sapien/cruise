import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import test, { after } from 'node:test';

import { createLineReader } from '../scripts/lib/line-input.mjs';
import { pickOne } from '../scripts/lib/picker.mjs';
import { SimpleCruiseSession } from '../scripts/lib/simple-session.mjs';

class RecordingClient extends EventEmitter {
  constructor() {
    super();
    this.responses = [];
    this.errors = [];
    this.watchdog = [];
  }

  respond(id, result) { this.responses.push({ id, result }); }
  respondError(id, error) { this.errors.push({ id, error }); }
  pauseInactivityWatchdog() { this.watchdog.push('pause'); }
  resumeInactivityWatchdog() { this.watchdog.push('resume'); }
}

function harness(chunks) {
  const input = Readable.from(chunks);
  const client = new RecordingClient();
  let rendered = '';
  const output = { write(text) { rendered += text; } };
  const lineReader = createLineReader({ input });
  const session = new SimpleCruiseSession({
    client, cwd: process.cwd(), prompt: 'Exercise local native input fixtures.',
    skill: 'quick', skillPath: '/tmp/quick-skill.md', pickOne, input,
    lineReader, readLine: (options) => options.lineReader.question(options),
    output, errorOutput: output,
  });
  return { client, input, lineReader, session, rendered: () => rendered };
}

function approval(method = 'item/commandExecution/requestApproval', extra = {}) {
  return {
    id: 'approval-1', method,
    params: {
      threadId: 'thread', turnId: 'turn', itemId: 'item', startedAtMs: 0,
      command: 'node --version', ...extra,
    },
  };
}

for (const method of [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]) {
  test(`${method}: closed input emits an unavailable-input RPC error without an owner decision`, async () => {
    const { client, input, lineReader, session } = harness([]);
    session.enqueueRequest(approval(method, { cwd: process.cwd(), permissions: { network: { enabled: true } } }));
    await session.interactions;
    assert.deepEqual(client.responses, []);
    assert.equal(client.errors.length, 1);
    assert.equal(client.errors[0].error.code, 'CRUISE_INPUT_UNAVAILABLE');
    assert.equal(client.errors[0].error.reason, 'eof');
    assert.deepEqual(client.errors[0].error.data, { code: 'CRUISE_INPUT_UNAVAILABLE', reason: 'eof' });
    assert.deepEqual(client.watchdog, ['pause', 'resume']);
    lineReader.close();
    for (const event of ['data', 'end', 'close', 'error']) assert.equal(input.listenerCount(event), 0);
  });
}

for (const decision of ['accept', 'decline', 'cancel', 'acceptForSession']) {
  test(`an explicit native ${decision} choice is preserved`, async () => {
    const { client, lineReader, session } = harness(['1\n']);
    try {
      await session.handleRequest(approval(undefined, { availableDecisions: [decision] }));
      assert.deepEqual(client.responses, [{ id: 'approval-1', result: { decision } }]);
    } finally {
      lineReader.close();
    }
  });
}

for (const [decision, label] of [
  [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['node', '--version'] } }, /Approve.*future.*\["node","--version"\]/u],
  [{ applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'allow', host: 'example.test' } } }, /Allow.*example\.test.*persist/u],
  [{ applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'deny', host: 'example.test' } } }, /Deny.*example\.test.*persist/u],
]) {
  test(`structured native decision ${JSON.stringify(decision)} is readable and returned unchanged`, async () => {
    const { client, lineReader, session, rendered } = harness(['2\n']);
    try {
      await session.handleRequest(approval(undefined, { availableDecisions: ['decline', decision] }));
      assert.match(rendered(), label);
      assert.doesNotMatch(rendered(), /\[object Object\]/u);
      assert.deepEqual(client.responses, [{ id: 'approval-1', result: { decision } }]);
      assert.equal(client.responses[0].result.decision, decision);
    } finally {
      lineReader.close();
    }
  });
}

test('picker cancellation does not synthesize native refusal', async () => {
  const { client, lineReader, session } = harness(['q\n']);
  try {
    session.enqueueRequest(approval());
    await session.interactions;
    assert.deepEqual(client.responses, []);
    assert.equal(client.errors.length, 1);
    assert.equal(client.errors[0].error.code, 'CRUISE_INTERRUPTED');
  } finally {
    lineReader.close();
  }
});

for (const [answer, permissions] of [['1\n', { network: { enabled: true } }], ['2\n', {}]]) {
  test(`permissions response follows explicit ${permissions.network ? 'approve' : 'decline'}`, async () => {
    const { client, lineReader, session } = harness([answer]);
    try {
      await session.handleRequest(approval('item/permissions/requestApproval', { permissions: { network: { enabled: true } } }));
      assert.deepEqual(client.responses, [{ id: 'approval-1', result: { permissions, scope: 'turn' } }]);
    } finally {
      lineReader.close();
    }
  });
}

const inputRequest = (questions) => ({
  id: 'input-1', method: 'item/tool/requestUserInput',
  params: { threadId: 'thread', turnId: 'turn', itemId: 'item', isBlocking: true, questions },
});

// This peer implements only fixture JSONL I/O. It never runs a model or a command.
const mockNativePeer = `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const record = (value) => appendFileSync(process.env.CRUISE_TEST_TRANSCRIPT, JSON.stringify(value) + '\\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const request = JSON.parse(process.env.CRUISE_TEST_NATIVE_REQUEST);
record({ event: 'started', pid: process.pid });
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  record({ event: 'frame', message });
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'approval-fixture/1' } });
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: '00000000-0000-4000-8000-000000000001' } } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'fixture-turn', status: 'inProgress' } } });
    send({ method: 'turn/started', params: { threadId: '00000000-0000-4000-8000-000000000001', turn: { id: 'fixture-turn', status: 'inProgress' } } });
    send(request);
  }
  if (message.id === request.id && Object.hasOwn(message, 'result')) {
    send({ method: 'turn/completed', params: { turn: { id: 'fixture-turn', status: 'completed' } } });
  }
  // An RPC error intentionally leaves the native turn open. Local input failure
  // must end the CLI and close this peer, without waiting for model activity.
});
lines.on('close', () => record({ event: 'stdin-closed' }));
process.on('exit', () => record({ event: 'exit' }));
`;

const cliEvidence = [];
after(async () => {
  if (!process.env.CRUISE_APPROVAL_EVIDENCE_DIR) return;
  await writeFile(join(process.env.CRUISE_APPROVAL_EVIDENCE_DIR, 'cli-probes.json'), `${JSON.stringify({
    at: new Date().toISOString(), node: process.version, model_calls: 0,
    actual_approval_or_permission_changes: 0, probes: cliEvidence,
    limitation: 'Real Cruise CLI and JSONL RPC with a fixture native peer; no live model or production approval.',
  }, null, 2)}\n`);
});

async function cliProbe(t, command, request, input) {
  const directory = await mkdtemp(join(tmpdir(), 'cruise-native-input-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'codex');
  const transcriptPath = join(directory, 'native.jsonl');
  await writeFile(executable, `#!${process.execPath}\n${mockNativePeer}`);
  await chmod(executable, 0o700);
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const result = spawnSync(process.execPath, [
    '--unhandled-rejections=strict', resolve('index.js'), command, '-C', workspace, 'Exercise a local input fixture.',
  ], {
    input, encoding: 'utf8', timeout: 8_000,
    env: {
      ...process.env, PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
      CRUISE_PROVIDER: 'codex', CRUISE_TEST_TRANSCRIPT: transcriptPath,
      CRUISE_TEST_NATIVE_REQUEST: JSON.stringify(request),
      CODEX_HOME: join(directory, 'empty-codex-home'),
    },
  });
  const transcript = (await readFile(transcriptPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const pid = transcript.find((entry) => entry.event === 'started')?.pid;
  let peerAlive = false;
  if (pid) {
    try { process.kill(pid, 0); peerAlive = true; } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (peerAlive) {
      // This exact fixture PID belongs to the task, including on test failure.
      process.kill(pid, 'SIGKILL');
    }
  }
  const response = transcript.find((entry) => entry.event === 'frame' && entry.message.id === request.id)?.message;
  cliEvidence.push({
    command, method: request.method, owner_response_supplied: input.length > 0,
    cli_pid: result.pid, peer_pid: pid, exit_code: result.status, signal: result.signal,
    error: result.error?.message ?? null, response, stderr: result.stderr,
    native_stdin_closed: transcript.some((entry) => entry.event === 'stdin-closed'),
    native_exit_observed: transcript.some((entry) => entry.event === 'exit'), peer_alive_after_cli_exit: peerAlive,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(peerAlive, false, 'the task-owned native fixture must exit during CLI cleanup');
  assert.equal(transcript.some((entry) => entry.event === 'stdin-closed'), true);
  assert.equal(transcript.some((entry) => entry.event === 'exit'), true);
  assert.doesNotMatch(result.stderr, /UnhandledPromiseRejection|uncaughtException/u);
  return { result, response };
}

for (const command of ['quick', 'worker']) {
  test(`real ${command} CLI: closed approval input emits native RPC error and tears down`, async (t) => {
    const { result, response } = await cliProbe(t, command, approval(), '');
    assert.equal(result.status, 1);
    assert.deepEqual(response, { id: 'approval-1', error: {
      code: -32000,
      message: 'Cruise cannot answer the native request: human input is unavailable (eof).',
      data: { code: 'CRUISE_INPUT_UNAVAILABLE', reason: 'eof' },
    } });
    assert.match(result.stderr, /human input is unavailable \(eof\)/u);
  });

  test(`real ${command} CLI: explicit decline remains a native owner decision`, async (t) => {
    const { result, response } = await cliProbe(t, command, approval(), '2\n');
    assert.equal(result.status, 0);
    assert.deepEqual(response, { id: 'approval-1', result: { decision: 'decline' } });
  });

  test(`real ${command} CLI: picker cancellation emits no native refusal and tears down`, async (t) => {
    const { result, response } = await cliProbe(t, command, approval(), 'q\n');
    assert.equal(result.status, command === 'quick' ? 130 : 1);
    assert.equal(Object.hasOwn(response, 'result'), false);
    assert.equal(response.error?.message, 'Cruise was interrupted.');
  });

  test(`real ${command} CLI: structured decision context and exact payload survive RPC`, async (t) => {
    const decision = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['node', '--version'] } };
    const { result, response } = await cliProbe(t, command, approval(undefined, { availableDecisions: ['decline', decision] }), '2\n');
    assert.equal(result.status, 0);
    assert.match(result.stderr, /Approve.*future.*\["node","--version"\]/u);
    assert.doesNotMatch(result.stderr, /\[object Object\]/u);
    assert.deepEqual(response, { id: 'approval-1', result: { decision } });
  });

  test(`real ${command} CLI: closed free-text input emits no fabricated answer and tears down`, async (t) => {
    const request = inputRequest([{ id: 'reason', header: 'Reason', question: 'Give a reason.', options: null }]);
    const { result, response } = await cliProbe(t, command, request, '');
    assert.equal(result.status, 1);
    assert.equal(response.error?.data?.code, 'CRUISE_INPUT_UNAVAILABLE');
    assert.equal(Object.hasOwn(response, 'result'), false);
  });

  test(`real ${command} CLI: native user-input choices and free text share piped input`, async (t) => {
    const request = inputRequest([
      { id: 'path', header: 'Path', question: 'Which path?', options: [
        { label: 'First', description: 'First path.' }, { label: 'Second', description: 'Second path.' },
      ] },
      { id: 'reason', header: 'Reason', question: 'Give a reason.', options: null },
    ]);
    const { result, response } = await cliProbe(t, command, request, '2\nOwner response\n');
    assert.equal(result.status, 0);
    assert.deepEqual(response, { id: 'input-1', result: { answers: {
      path: { answers: ['Second'] }, reason: { answers: ['Owner response'] },
    } } });
  });
}

test('native user-input choices and free text preserve queued piped answers', async () => {
  const { client, input, lineReader, session } = harness(['2\nowner response\n']);
  try {
    await session.handleRequest(inputRequest([
      { id: 'path', header: 'Path', question: 'Which path?', options: [
        { label: 'First', description: 'The first path.' },
        { label: 'Second', description: 'The second path.' },
      ] },
      { id: 'reason', header: 'Reason', question: 'Why?', options: null },
    ]));
    assert.deepEqual(client.responses, [{ id: 'input-1', result: { answers: {
      path: { answers: ['Second'] }, reason: { answers: ['owner response'] },
    } } }]);
  } finally {
    lineReader.close();
  }
  for (const event of ['data', 'end', 'close', 'error']) assert.equal(input.listenerCount(event), 0);
});

test('an explicit empty free-text answer is preserved', async () => {
  const { client, lineReader, session } = harness(['\n']);
  try {
    await session.handleRequest(inputRequest([{ id: 'note', header: 'Note', question: 'Optional note.', options: null }]));
    assert.deepEqual(client.responses, [{ id: 'input-1', result: { answers: { note: { answers: [''] } } } }]);
  } finally {
    lineReader.close();
  }
});

for (const options of [null, [{ label: 'First', description: 'First path.' }]]) {
  test(`closed user-input ${options ? 'choice' : 'free text'} has no fabricated answer`, async () => {
    const { client, lineReader, session } = harness([]);
    try {
      session.enqueueRequest(inputRequest([{ id: 'choice', header: 'Input', question: 'Supply an answer.', options }]));
      await session.interactions;
      assert.deepEqual(client.responses, []);
      assert.equal(client.errors.length, 1);
      assert.equal(client.errors[0].error.code, 'CRUISE_INPUT_UNAVAILABLE');
    } finally {
      lineReader.close();
    }
  });
}
