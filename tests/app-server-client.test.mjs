import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import {
  AppServerClient,
  AppServerProcessError,
  AppServerProtocolError,
  AppServerRpcError,
} from "../scripts/lib/app-server-client.mjs";

class FakeChild extends EventEmitter {
  constructor({ exitOnStdinEnd = true } = {}) {
    super();
    this.writes = [];
    this.kills = [];
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

test("stop closes stdin and waits for a graceful app-server exit", async () => {
  const { child, spawnFn } = createHarness();
  const client = new AppServerClient({ spawnFn });
  await startHarness(client, child);

  const exit = await client.stop({ timeoutMs: 100 });

  assert.equal(child.stdin.writableEnded, true);
  assert.deepEqual(child.kills, []);
  assert.deepEqual(exit, { code: 0, signal: null, error: null });
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
