import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import {
  AppServerClient,
  AppServerInactivityError,
} from '../scripts/lib/app-server-client.mjs';
import {
  SimpleCruiseGoalBootstrapTimeoutError,
  SimpleCruiseInputUnavailableError,
  SimpleCruiseSession,
} from '../scripts/lib/simple-session.mjs';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class HostileAppServer extends EventEmitter {
  constructor(mode) {
    super();
    this.mode = mode;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const line of String(chunk).split('\n').filter(Boolean)) {
          this.handle(JSON.parse(line));
        }
        callback();
      },
    });
    this.stdin.once('finish', () => this.exit(0, null));
    this.goal = null;
    this.turns = 0;
    this.activeTurn = null;
    this.interval = null;
    this.exited = false;
    this.kills = [];
    this.received = [];
  }

  send(message) {
    if (!this.exited) this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  respond(request, result) {
    this.send({ id: request.id, result });
  }

  startTurn({ complete = false, question = false, streaming = false } = {}) {
    this.turns += 1;
    const turn = { id: `turn-${this.turns}`, status: 'inProgress' };
    this.activeTurn = turn;
    setTimeout(() => {
      this.send({
        method: 'turn/started',
        params: { threadId: 'thread-hostile', turn },
      });
      if (question) {
        this.send({
          id: 9001,
          method: 'item/tool/requestUserInput',
          params: {
            threadId: 'thread-hostile',
            turnId: turn.id,
            questions: [{
              id: 'continue',
              header: 'Probe',
              question: 'Continue?',
              options: [{ label: 'Continue', value: 'continue' }],
            }],
          },
        });
      }
      if (streaming) {
        let count = 0;
        this.interval = setInterval(() => {
          count += 1;
          this.send({
            method: 'item/agentMessage/delta',
            params: { threadId: 'thread-hostile', turnId: turn.id, delta: `delta-${count}\n` },
          });
          if (count === 7) {
            clearInterval(this.interval);
            this.interval = null;
            this.completeTurn(turn);
          }
        }, 20);
      } else if (complete) {
        setTimeout(() => this.completeTurn(turn), 10);
      }
    }, 5);
    return turn;
  }

  completeTurn(turn = this.activeTurn) {
    this.send({
      method: 'turn/completed',
      params: { threadId: 'thread-hostile', turn: { ...turn, status: 'completed' } },
    });
  }

  handle(message) {
    this.received.push(message);
    if (message.method === 'initialize') {
      if (this.mode === 'A_no_initialize') return;
      this.respond(message, { userAgent: 'fake', codexHome: '/tmp/fake' });
      return;
    }
    if (message.method === 'thread/start') {
      if (this.mode === 'B_no_thread_start') return;
      this.respond(message, { thread: { id: 'thread-hostile' }, model: 'gpt-fake' });
      return;
    }
    if (message.method === 'thread/settings/update') {
      this.respond(message, {});
      return;
    }
    if (message.method === 'thread/goal/get') {
      this.respond(message, { goal: this.goal });
      return;
    }
    if (message.method === 'thread/goal/set') {
      this.goal = {
        objective: message.params?.objective ?? this.goal?.objective ?? 'probe',
        status: message.params?.status,
      };
      this.respond(message, { goal: this.goal });
      this.send({
        method: 'thread/goal/updated',
        params: { threadId: 'thread-hostile', goal: this.goal },
      });
      if (this.goal.status === 'active') {
        if (this.mode === 'C_goal_no_turn') {
          this.interval = setInterval(() => this.send({
            method: 'thread/status/changed',
            params: { threadId: 'thread-hostile', status: 'active' },
          }), 10);
        } else {
          this.startTurn({ complete: true });
        }
      }
      return;
    }
    if (message.method === 'turn/start') {
      if (this.mode === 'H_turn_start_no_reply') return;
      const turn = this.startTurn({
        complete: ['fast', 'G2_question_held_open'].includes(this.mode),
        question: ['G_question_no_stdin', 'G2_question_held_open'].includes(this.mode),
        streaming: this.mode === 'I_streaming_long_turn',
      });
      this.respond(message, { turn });
      if (this.mode === 'F_exit_midturn') setTimeout(() => this.exit(7, null), 15);
      return;
    }
    if (message.method === 'turn/interrupt') {
      this.respond(message, {});
      return;
    }
    if (message.id === 9001 && this.mode === 'G2_question_held_open') {
      setTimeout(() => this.completeTurn(), 5);
    }
  }

  kill(signal) {
    this.kills.push(signal);
    this.exit(null, signal);
    return true;
  }

  exit(code, signal) {
    if (this.exited) return;
    this.exited = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    queueMicrotask(() => this.emit('exit', code, signal));
  }
}

async function createRun(mode, {
  inactivityTimeoutMs = 70,
  firstTurnDeadlineMs = 35,
  pickOne = async () => ({ status: 'cancelled' }),
} = {}) {
  const cwd = await mkdtemp(join(tmpdir(), `cruise-watchdog-${mode}-`));
  const server = new HostileAppServer(mode);
  const client = new AppServerClient({
    spawnFn: () => server,
    inactivityTimeoutMs,
    initializeTimeoutMs: 200,
  });
  let stdout = '';
  let stderr = '';
  const session = new SimpleCruiseSession({
    client,
    cwd,
    prompt: `Run ${mode}`,
    skill: ['A_no_initialize', 'B_no_thread_start', 'C_goal_no_turn', 'E_goal_continuation_hang'].includes(mode)
      ? 'goal'
      : 'quick',
    skillPath: '/tmp/fake-skill.md',
    pickOne,
    readLine: async () => '',
    output: { write(value) { stdout += value; } },
    errorOutput: { write(value) { stderr += value; } },
    locateTrace: async () => null,
    traceHome: join(cwd, 'codex-home'),
    firstTurnDeadlineMs,
    firstTurnCleanupDeadlineMs: 20,
  });
  const running = session.run();
  return {
    client,
    cwd,
    running,
    server,
    session,
    output: () => ({ stdout, stderr }),
    async cleanup() {
      await client.stop({ timeoutMs: 10 }).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

test('A-H hostile matrix bounds silent transport paths and distinguishes C/F/G', async () => {
  const inactivityModes = [
    'A_no_initialize',
    'B_no_thread_start',
    'D_turn_never_completes',
    'E_goal_continuation_hang',
    'H_turn_start_no_reply',
  ];
  for (const mode of inactivityModes) {
    const run = await createRun(mode);
    try {
      await assert.rejects(run.running, (error) => {
        assert.ok(error instanceof AppServerInactivityError, `${mode}: ${error?.stack}`);
        assert.equal(error.code, 'CRUISE_TRANSPORT_INACTIVITY');
        assert.match(error.message, /elapsed=.*last-frame=.*thread=.*turn=.*goal=/u);
        return true;
      });
      assert.equal(run.client._inactivityTimer, null, mode);
    } finally {
      await run.cleanup();
    }
  }

  const unavailable = await createRun('G_question_no_stdin', {
    pickOne: async () => ({ status: 'cancelled', reason: 'eof' }),
  });
  try {
    await assert.rejects(unavailable.running, (error) => {
      assert.ok(error instanceof SimpleCruiseInputUnavailableError);
      assert.equal(error.code, 'CRUISE_INPUT_UNAVAILABLE');
      assert.equal(error.reason, 'eof');
      return true;
    });
    const response = unavailable.server.received.find((message) => message.id === 9001);
    assert.equal(Object.hasOwn(response, 'result'), false);
    assert.equal(response.error.code, -32000);
    assert.deepEqual(response.error.data, { code: 'CRUISE_INPUT_UNAVAILABLE', reason: 'eof' });
    assert.equal(unavailable.client._inactivityTimer, null);
    assert.equal(unavailable.server.exited, true);
  } finally {
    await unavailable.cleanup();
  }

  const bootstrap = await createRun('C_goal_no_turn');
  try {
    await assert.rejects(
      bootstrap.running,
      (error) => error instanceof SimpleCruiseGoalBootstrapTimeoutError,
    );
  } finally {
    await bootstrap.cleanup();
  }

  const exited = await createRun('F_exit_midturn');
  try {
    await assert.rejects(exited.running, /Codex app-server exited \(7\)/u);
  } finally {
    await exited.cleanup();
  }
});

test('a streaming long turn keeps resetting inactivity without a wall-clock ceiling', async () => {
  const run = await createRun('I_streaming_long_turn', { inactivityTimeoutMs: 50 });
  try {
    const result = await run.running;
    assert.equal(result.status, 'complete');
    assert.match(run.output().stdout, /delta-1/u);
    assert.match(run.output().stdout, /delta-7/u);
    assert.equal(run.client._inactivityTimer, null);
  } finally {
    await run.cleanup();
  }
});

test('an unanswered human prompt remains suspended past the watchdog window', async () => {
  let releasePicker;
  let pickerStarted;
  const waitingForPicker = new Promise((resolve) => { pickerStarted = resolve; });
  const run = await createRun('G2_question_held_open', {
    inactivityTimeoutMs: 40,
    pickOne: async () => {
      pickerStarted();
      return new Promise((resolve) => { releasePicker = resolve; });
    },
  });
  try {
    let settled = false;
    run.running.finally(() => { settled = true; }).catch(() => {});
    await waitingForPicker;
    await delay(100);
    assert.equal(settled, false);
    assert.equal(run.client.state, 'running');
    assert.equal(run.client._inactivityTimer, null);

    releasePicker({ value: 'continue' });
    const result = await run.running;
    assert.equal(result.status, 'complete');
    assert.equal(run.client._inactivityTimer, null);
  } finally {
    await run.cleanup();
  }
});

test('a normal fast run keeps stdout stable and leaves no Timeout resource', async () => {
  const timeoutCount = () => process.getActiveResourcesInfo?.()
    .filter((resource) => resource === 'Timeout').length ?? 0;
  const before = timeoutCount();
  const run = await createRun('fast');
  try {
    const result = await run.running;
    assert.equal(result.status, 'complete');
    assert.equal(run.output().stdout, '');
    assert.equal(run.client._inactivityTimer, null);
  } finally {
    await run.cleanup();
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(timeoutCount() <= before, `${timeoutCount()} Timeout resources remain; baseline was ${before}`);
});
