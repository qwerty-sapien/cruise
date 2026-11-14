import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import {
  AppServerClient,
  AppServerInactivityError,
  AppServerInitializeTimeoutError,
  AppServerProcessError,
  AppServerProtocolError,
  AppServerRpcError,
  DEFAULT_INACTIVITY_TIMEOUT_MS,
} from "../scripts/lib/app-server-client.mjs";

class FakeChild extends EventEmitter {
  constructor({ exitOnStdinEnd = true, ignoredSignals = [] } = {}) {
    super();
    this.writes = [];
    this.kills = [];
    this.ignoredSignals = new Set(ignoredSignals);
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.writes.push(String(chunk));
        callback();
      },
    });
    if (exitOnStdinEnd) {
      this.stdin.once("finish", () => queueMicrotask(() => this.emit("exit", 0, null)));
    }
  }

  kill(signal) {
    this.kills.push(signal);
    if (this.ignoredSignals.has(signal)) return true;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }

  send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  messages() {
    return this.writes
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

function createHarness(options = {}) {
  const child = new FakeChild(options.childOptions);
  const spawnCalls = [];
  const spawnFn = (command, args, spawnOptions) => {
    spawnCalls.push({ command, args, spawnOptions });
    return child;
  };
  return { child, spawnCalls, spawnFn };
}

async function startHarness(client, child) {
  const starting = client.start();
  const initialize = child.messages()[0];
  assert.equal(initialize.method, "initialize");
  child.send({
    id: initialize.id,
    result: {
      userAgent: "test/0.144.1",
      codexHome: "/tmp/codex",
      platformFamily: "unix",
      platformOs: "macos",
    },
  });
  return starting;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("start spawns configured command and performs initialize/initialized handshake", async () => {
  const { child, spawnCalls, spawnFn } = createHarness();
  const client = new AppServerClient({
    spawnFn,
    command: "/fake/codex",
    args: ["app-server", "--stdio", "-c", "model=\"test\""],
    spawnOptions: { cwd: "/workspace" },
    clientInfo: { name: "cruise_test", title: "Cruise Test", version: "1.2.3" },
    capabilities: { experimentalApi: true },
  });

  const initialization = await startHarness(client, child);

  assert.equal(client.state, "running");
  assert.equal(initialization.userAgent, "test/0.144.1");
  assert.deepEqual(spawnCalls, [
    {
      command: "/fake/codex",
      args: ["app-server", "--stdio", "-c", "model=\"test\""],
      spawnOptions: { cwd: "/workspace", stdio: ["pipe", "pipe", "pipe"] },
    },
  ]);
  assert.deepEqual(child.messages(), [
    {
      method: "initialize",
      id: 1,
      params: {
        clientInfo: { name: "cruise_test", title: "Cruise Test", version: "1.2.3" },
        capabilities: { experimentalApi: true },
      },
    },
    { method: "initialized" },
  ]);

  await client.stop();
});

test("request resolves results, rejects RPC errors, and notify writes JSONL", async () => {
  const { child, spawnFn } = createHarness();
  const client = new AppServerClient({ spawnFn });
  await startHarness(client, child);
  child.writes.length = 0;

  const request = client.request("thread/start", { ephemeral: true });
  const sent = child.messages()[0];
  child.send({ id: sent.id, result: { thread: { id: "thr_1" } } });
  assert.deepEqual(await request, { thread: { id: "thr_1" } });

  const failing = client.request("thread/read", { threadId: "missing" });
  const failingMessage = child.messages()[1];
  child.send({
    id: failingMessage.id,
    error: { code: -32600, message: "thread not found", data: { threadId: "missing" } },
  });
  await assert.rejects(failing, (error) => {
    assert.ok(error instanceof AppServerRpcError);
    assert.equal(error.code, -32600);
    assert.deepEqual(error.data, { threadId: "missing" });
    assert.equal(error.request.method, "thread/read");
    return true;
  });

  client.notify("turn/interrupt", { threadId: "thr_1", turnId: "turn_1" });
  assert.deepEqual(child.messages()[2], {
    method: "turn/interrupt",
    params: { threadId: "thr_1", turnId: "turn_1" },
  });

  await client.stop();
});

test("server requests and notifications are dispatched to callbacks", async () => {
  const notifications = [];
  const requests = [];
  const errors = [];
  const { child, spawnFn } = createHarness();
  const client = new AppServerClient({
    spawnFn,
    onServerRequest: async (message, activeClient) => {
      requests.push({ message, activeClient });
      return { answers: { color: { answers: ["Red"] } } };
    },
    onNotification: (message, activeClient) => {
      notifications.push({ message, activeClient });
    },
    onError: (error) => errors.push(error),
  });
  await startHarness(client, child);
  child.writes.length = 0;

  child.send({ method: "thread/status/changed", params: { threadId: "thr_1" } });
  child.send({
    method: "item/tool/requestUserInput",
    id: 77,
    params: {
      threadId: "thr_1",
      turnId: "turn_1",
      itemId: "item_1",
      questions: [],
      autoResolutionMs: null,
    },
  });
  await flush();

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].activeClient, client);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].activeClient, client);
  assert.deepEqual(child.messages(), [
    { id: 77, result: { answers: { color: { answers: ["Red"] } } } },
  ]);
  assert.deepEqual(errors, []);

  await client.stop();
});

test("EventEmitter API exposes request, notification, stderr, and exit", async () => {
  const events = { requests: [], notifications: [], stderr: [], exits: [] };
  const { child, spawnFn } = createHarness();
  const client = new AppServerClient({ spawnFn });
  client.on("request", (message, activeClient) => {
    events.requests.push({ message, activeClient });
    activeClient.respond(message.id, { answers: {} });
  });
  client.on("notification", (message, activeClient) => {
    events.notifications.push({ message, activeClient });
  });
  client.on("stderr", (chunk) => events.stderr.push(chunk));
  client.on("exit", (info) => events.exits.push(info));
  await startHarness(client, child);
  child.writes.length = 0;

  child.send({ method: "warning", params: { message: "heads up" } });
  child.send({ method: "item/tool/requestUserInput", id: 41, params: {} });
  child.stderr.write("diagnostic\n");
  await flush();

  assert.equal(events.requests.length, 1);
  assert.equal(events.requests[0].activeClient, client);
  assert.equal(events.notifications.length, 1);
  assert.equal(events.notifications[0].activeClient, client);
  assert.deepEqual(events.stderr, ["diagnostic\n"]);
  assert.deepEqual(child.messages(), [{ id: 41, result: { answers: {} } }]);

  await client.stop();
  assert.deepEqual(events.exits, [{ code: 0, signal: null, error: null }]);
});

test("reply and error write valid bidirectional RPC responses", async () => {
  const { child, spawnFn } = createHarness();
  const client = new AppServerClient({ spawnFn });
  await startHarness(client, child);
  child.writes.length = 0;

  client.respond("req-1", { accepted: true });
  client.respondError("req-2", -32602, "Invalid answer", { questionId: "color" });
  client.replyError("req-3", Object.assign(new Error("Picker closed"), { code: -32010 }));

  assert.deepEqual(child.messages(), [
    { id: "req-1", result: { accepted: true } },
    {
      id: "req-2",
      error: { code: -32602, message: "Invalid answer", data: { questionId: "color" } },
    },
    { id: "req-3", error: { code: -32010, message: "Picker closed" } },
  ]);

  await client.stop();
});

test("process exit rejects every pending request", async () => {
  const { child, spawnFn } = createHarness({ childOptions: { exitOnStdinEnd: false } });
  const client = new AppServerClient({ spawnFn });
  await startHarness(client, child);

  const first = client.request("thread/read", { threadId: "thr_1" });
  const second = client.request("thread/goal/get", { threadId: "thr_1" });
  child.emit("exit", 9, null);

  for (const pending of [first, second]) {
    await assert.rejects(pending, (error) => {
      assert.ok(error instanceof AppServerProcessError);
      assert.equal(error.code, 9);
      return true;
    });
  }
  assert.equal(client.state, "stopped");
});

test("pending initialize retains permission evidence without retrying the launch", async () => {
  for (const detail of [
    "WARNING PATH aliases: Operation not permitted\nError: Operation not permitted (os error 1)",
    "Error: EPERM",
    "Error: permission denied",
  ]) {
    const { child, spawnCalls, spawnFn } = createHarness();
    const client = new AppServerClient({ spawnFn });
    const starting = client.start();
    child.stderr.write(detail);
    child.emit("exit", 1, null);
    await assert.rejects(starting, (error) => {
      assert.ok(error instanceof AppServerProcessError);
      assert.equal(error.code, 1);
      assert.equal(error.signal, null);
      assert.match(error.message, /exited with code 1/);
      assert.ok(error.message.includes(detail.replace(/\n/g, " ")));
      assert.match(error.message, /request native escalation for the exact command and bounded task/);
      assert.match(error.message, /do not retry automatically or bypass host approval/);
      assert.doesNotMatch(error.message, /reviewer rejection/);
      return true;
    });
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(child.kills, []);
    assert.equal(client.state, "stopped");
  }
});

test("startup exit diagnostics are bounded and unrelated exits have no permission hint", async () => {
  for (const detail of ["", "configuration invalid", "雪\n\u0000".repeat(20_000) + " invalid option"]) {
    const { child, spawnFn } = createHarness();
    const client = new AppServerClient({ spawnFn });
    const starting = client.start();
    child.stderr.write(detail);
    child.emit("exit", 1, null);
    await assert.rejects(starting, (error) => {
      assert.equal(error.code, 1);
      assert.ok(error.message.length < 1200);
      assert.ok(Buffer.byteLength(error.message) < 4200);
      assert.doesNotMatch(error.message, /[\u0000-\u001f\u007f]/u);
      assert.doesNotMatch(error.message, /permission|sandbox|escalation|authorization/i);
      if (detail) assert.match(error.message, /codex-stderr-tail=/);
      if (detail.length > 1000) assert.match(error.message, /invalid option/);
      return true;
    });
  }
});

test("process errors preserve the original cause alongside compact stderr", async () => {
  const { child, spawnFn } = createHarness();
  const client = new AppServerClient({ spawnFn });
  const starting = client.start();
  const cause = Object.assign(new Error("spawn failed"), { code: "EIO" });
  child.stderr.write("transport unavailable\n");
  child.emit("error", cause);
  await assert.rejects(starting, (error) => {
    assert.equal(error.cause, cause);
    assert.equal(error.cause.code, "EIO");
    assert.match(error.message, /spawn failed.*transport unavailable/);
    assert.doesNotMatch(error.message, /permission|escalation/i);
    return true;
  });
  child.emit("exit", 1, null);
});

test("stop closes stdin and waits for a graceful app-server exit", async () => {
  const { child, spawnFn } = createHarness();
  const client = new AppServerClient({ spawnFn });
  await startHarness(client, child);

  child.stderr.write("Earlier warning: Operation not permitted\n");
  const exit = await client.stop({ timeoutMs: 100 });

  assert.equal(child.stdin.writableEnded, true);
  assert.deepEqual(child.kills, []);
  assert.deepEqual(exit, { code: 0, signal: null, error: null });
  assert.equal(client.state, "stopped");
});

test("stop escalates an unresponsive app-server from SIGTERM to bounded SIGKILL", async () => {
  const { child, spawnFn } = createHarness({
    childOptions: { exitOnStdinEnd: false, ignoredSignals: ["SIGTERM"] },
  });
  const client = new AppServerClient({ spawnFn });
  await startHarness(client, child);

  const exit = await client.stop({ timeoutMs: 5 });

  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(exit, { code: null, signal: "SIGKILL", error: null });
  assert.equal(client.state, "stopped");
});

test("malformed input is reported without crashing the stream reader", async () => {
  const errors = [];
  const { child, spawnFn } = createHarness();
  const client = new AppServerClient({ spawnFn, onError: (error) => errors.push(error) });
  await startHarness(client, child);

  child.stdout.write("not-json\n");
  child.send({ method: "warning", params: { message: "still alive" } });
  await flush();

  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof AppServerProtocolError);
  assert.equal(client.state, "running");

  await client.stop();
});

test("inactivity timeout is request-scoped and invalid overrides fall back to the default", () => {
  assert.equal(new AppServerClient({ env: {} }).inactivityTimeoutMs, DEFAULT_INACTIVITY_TIMEOUT_MS);
  assert.equal(new AppServerClient({ env: { CRUISE_INACTIVITY_TIMEOUT_MS: "42" } }).inactivityTimeoutMs, 42);
  assert.equal(new AppServerClient({ inactivityTimeoutMs: 17, env: { CRUISE_INACTIVITY_TIMEOUT_MS: "42" } }).inactivityTimeoutMs, 17);
  for (const value of ["", "0", "1.5", "abc", 0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.equal(
      new AppServerClient({ inactivityTimeoutMs: value }).inactivityTimeoutMs,
      DEFAULT_INACTIVITY_TIMEOUT_MS,
    );
  }
});

test("initialize has an independent handshake deadline and leaves no watchdog timer", async () => {
  const { child, spawnFn } = createHarness({
    childOptions: { exitOnStdinEnd: false, ignoredSignals: ["SIGTERM"] },
  });
  const client = new AppServerClient({
    spawnFn,
    initializeTimeoutMs: 15,
    inactivityTimeoutMs: 1_000,
    terminationTimeoutMs: 10,
  });

  await assert.rejects(client.start(), (error) => {
    assert.ok(error instanceof AppServerInitializeTimeoutError);
    assert.equal(error.code, "CRUISE_APP_SERVER_INITIALIZE_TIMEOUT");
    assert.match(error.message, /did not complete initialize within 15ms/u);
    return true;
  });
  await delay(15);
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(client._pending.size, 0);
  assert.equal(client._inactivityTimer, null);
  assert.equal(client._forceKillTimer, null);
});

test("watchdog resets on responses, notifications, and server requests", async () => {
  const { child, spawnFn } = createHarness();
  const client = new AppServerClient({ spawnFn, inactivityTimeoutMs: 80 });
  client.on("request", (message, activeClient) => activeClient.respond(message.id, {}));
  await startHarness(client, child);

  await delay(45);
  child.send({ method: "thread/status/changed", params: { threadId: "thr-reset" } });
  await delay(45);
  child.send({ method: "currentTime/read", id: 70, params: { threadId: "thr-reset" } });
  const pending = client.request("thread/read", { threadId: "thr-reset" });
  const sent = child.messages().findLast(({ method }) => method === "thread/read");
  await delay(45);
  child.send({ id: sent.id, result: { thread: { id: "thr-reset" } } });
  await pending;

  assert.equal(client.state, "running");
  await client.stop();
  assert.equal(client._inactivityTimer, null);
});

test("transport inactivity rejects pending RPCs with bounded stderr and session context", async () => {
  const { child, spawnFn } = createHarness({ childOptions: { exitOnStdinEnd: false } });
  const client = new AppServerClient({
    spawnFn,
    inactivityTimeoutMs: 25,
    stderrTailBytes: 24,
  });
  await startHarness(client, child);
  child.stderr.write("discard-this-prefix/host-stderr-tail\n");

  const pending = client.request("turn/start", {
    threadId: "thr-hung",
    input: [],
  });
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof AppServerInactivityError);
    assert.equal(error.code, "CRUISE_TRANSPORT_INACTIVITY");
    assert.equal(error.lastFrame, "response:initialize");
    assert.equal(error.threadId, "thr-hung");
    assert.equal(error.turnId, null);
    assert.equal(error.goalStatus, null);
    assert.ok(Buffer.byteLength(error.stderrTail) <= 24);
    assert.match(error.stderrTail, /host-stderr-tail/u);
    assert.match(error.message, /elapsed=/u);
    assert.match(error.message, /last-frame=response:initialize/u);
    assert.match(error.message, /thread=thr-hung/u);
    assert.match(error.message, /codex-stderr-tail=/u);
    return true;
  });

  assert.equal(client.state, "stopped");
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(client._pending.size, 0);
  assert.equal(client._inactivityTimer, null);
});

test("stop, child exit, and interrupt clear the inactivity timer", async () => {
  for (const ending of ["stop", "exit", "interrupt"]) {
    const { child, spawnFn } = createHarness();
    const client = new AppServerClient({ spawnFn, inactivityTimeoutMs: 1_000 });
    await startHarness(client, child);
    assert.notEqual(client._inactivityTimer, null);
    if (ending === "stop") await client.stop();
    else if (ending === "exit") child.emit("exit", 0, null);
    else {
      client.interrupt();
      await client.stop();
    }
    assert.equal(client._inactivityTimer, null, ending);
  }
});
