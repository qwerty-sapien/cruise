import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";

const DEFAULT_CLIENT_INFO = Object.freeze({
  name: "cruise",
  title: "Cruise",
  version: "0.0.0",
});

const DEFAULT_CAPABILITIES = Object.freeze({
  experimentalApi: true,
  requestAttestation: false,
});

export const DEFAULT_INACTIVITY_TIMEOUT_MS = 300_000;
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;
const DEFAULT_STDERR_TAIL_BYTES = 8 * 1024;
const DEFAULT_TERMINATION_TIMEOUT_MS = 2_000;

export class AppServerRpcError extends Error {
  constructor(error, request = null) {
    super(error?.message ?? "Codex app-server request failed");
    this.name = "AppServerRpcError";
    this.code = error?.code ?? null;
    this.data = error?.data;
    this.request = request;
  }
}

export class AppServerProtocolError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "AppServerProtocolError";
  }
}

export class AppServerProcessError extends Error {
  constructor(message, { code = null, signal = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AppServerProcessError";
    this.code = code;
    this.signal = signal;
  }
}

export class AppServerInactivityError extends AppServerProcessError {
  constructor({ elapsedMs, lastFrame, threadId, turnId, goalStatus, stderrTail }) {
    const diagnostics = [
      `elapsed=${formatDuration(elapsedMs)}`,
      `last-frame=${lastFrame ?? "none"}`,
      `thread=${threadId ?? "unknown"}`,
      `turn=${turnId ?? "none"}`,
      `goal=${goalStatus ?? "unknown"}`,
      ...(stderrTail ? [`codex-stderr-tail=${compactDiagnostic(stderrTail)}`] : []),
    ].join(", ");
    super(`Codex app-server transport inactivity observed (${diagnostics}).`);
    this.name = "AppServerInactivityError";
    this.code = "CRUISE_TRANSPORT_INACTIVITY";
    this.elapsedMs = elapsedMs;
    this.lastFrame = lastFrame;
    this.threadId = threadId;
    this.turnId = turnId;
    this.goalStatus = goalStatus;
    this.stderrTail = stderrTail;
  }
}

export class AppServerInitializeTimeoutError extends AppServerProcessError {
  constructor(timeoutMs) {
    super(`Codex app-server did not complete initialize within ${formatDuration(timeoutMs)}.`);
    this.name = "AppServerInitializeTimeoutError";
    this.code = "CRUISE_APP_SERVER_INITIALIZE_TIMEOUT";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Minimal bidirectional JSONL RPC client for `codex app-server --stdio`.
 *
 * `start()` performs the required initialize/initialized handshake. Incoming
 * server requests are passed to `onServerRequest`; returning a value replies
 * with that value, while returning `undefined` leaves the request for a later
 * explicit `reply()` or `error()` call.
 */
export class AppServerClient extends EventEmitter {
  constructor({
    spawnFn = nodeSpawn,
    command = "codex",
    args = ["app-server", "--stdio"],
    spawnOptions = {},
    clientInfo = DEFAULT_CLIENT_INFO,
    capabilities = DEFAULT_CAPABILITIES,
    onServerRequest = null,
    onNotification = null,
    onError = null,
    inactivityTimeoutMs,
    initializeTimeoutMs,
    stderrTailBytes = DEFAULT_STDERR_TAIL_BYTES,
    terminationTimeoutMs = DEFAULT_TERMINATION_TIMEOUT_MS,
    env = process.env,
  } = {}) {
    super();
    if (typeof spawnFn !== "function") {
      throw new TypeError("spawnFn must be a function");
    }
    if (!Array.isArray(args)) {
      throw new TypeError("args must be an array");
    }

    this.spawnFn = spawnFn;
    this.command = command;
    this.args = [...args];
    this.spawnOptions = { ...spawnOptions };
    this.clientInfo = { ...clientInfo };
    this.capabilities = capabilities == null ? null : { ...capabilities };
    this.onServerRequest = onServerRequest;
    this.onNotification = onNotification;
    this.onError = onError;
    this.inactivityTimeoutMs = positiveIntegerOrDefault(
      inactivityTimeoutMs === undefined
        ? env?.CRUISE_INACTIVITY_TIMEOUT_MS
        : inactivityTimeoutMs,
      DEFAULT_INACTIVITY_TIMEOUT_MS,
    );
    const initializeOverride = initializeTimeoutMs ?? env?.CRUISE_INITIALIZE_TIMEOUT_MS;
    this.initializeTimeoutMs = initializeOverride === 0 || initializeOverride === '0'
      ? 0
      : positiveIntegerOrDefault(initializeOverride, DEFAULT_INITIALIZE_TIMEOUT_MS);
    this.stderrTailBytes = positiveIntegerOrDefault(
      stderrTailBytes,
      DEFAULT_STDERR_TAIL_BYTES,
    );
    this.terminationTimeoutMs = positiveIntegerOrDefault(
      terminationTimeoutMs,
      DEFAULT_TERMINATION_TIMEOUT_MS,
    );

    this.child = null;
    this.state = "idle";
    this.initialization = null;

    this._nextId = 1;
    this._pending = new Map();
    this._stdoutBuffer = "";
    this._startPromise = null;
    this._stopPromise = null;
    this._exitPromise = null;
    this._resolveExit = null;
    this._exitInfo = null;
    this._terminated = false;
    this._inactivityTimer = null;
    this._forceKillTimer = null;
    this._childExited = false;
    this._watchdogSuspensions = 0;
    this._watchdogDisabled = false;
    this._lastFrameAt = null;
    this._watchdogBaselineAt = null;
    this._lastFrame = "none";
    this._threadId = null;
    this._turnId = null;
    this._goalStatus = null;
    this._stderrTail = Buffer.alloc(0);
  }

  start() {
    if (this.state === "running") {
      return Promise.resolve(this.initialization);
    }
    if (this._startPromise) {
      return this._startPromise;
    }
    if (this.state !== "idle") {
      return Promise.reject(
        new AppServerProcessError(`Cannot start app-server client in ${this.state} state`),
      );
    }

    this.state = "starting";
    this._startPromise = this._start();
    return this._startPromise;
  }

  async _start() {
    try {
      const options = {
        ...this.spawnOptions,
        stdio: this.spawnOptions.stdio ?? ["pipe", "pipe", "pipe"],
      };
      this.child = this.spawnFn(this.command, this.args, options);
      this._attachProcess(this.child);
      this._watchdogDisabled = false;
      this._lastFrameAt = Date.now();
      this._watchdogBaselineAt = this._lastFrameAt;
      this._armInactivityWatchdog();

      const initialization = await waitWithin(
        this.request("initialize", {
          clientInfo: this.clientInfo,
          capabilities: this.capabilities,
        }),
        this.initializeTimeoutMs,
        () => new AppServerInitializeTimeoutError(this.initializeTimeoutMs),
      );
      this.notify("initialized");
      this.initialization = initialization;
      this.state = "running";
      return initialization;
    } catch (error) {
      if (!this._terminated) {
        this._terminate({ cause: error });
        this._abortChild();
      }
      throw error;
    }
  }

  request(method, params) {
    const id = this._nextId++;
    const message = { method, id };
    if (params !== undefined) {
      message.params = params;
    }
    this._observeOutbound(message);

    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, message });
      try {
        this._write(message);
      } catch (error) {
        this._pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    const message = { method };
    if (params !== undefined) {
      message.params = params;
    }
    this._observeOutbound(message);
    this._write(message);
  }

  reply(id, result = {}) {
    this._write({ id, result });
  }

  respond(id, result = {}) {
    this.reply(id, result);
  }

  error(id, codeOrError, message, data) {
    this._write({ id, error: normalizeRpcError(codeOrError, message, data) });
  }

  replyError(id, codeOrError, message, data) {
    this.error(id, codeOrError, message, data);
  }

  respondError(id, codeOrError, message, data) {
    this.error(id, codeOrError, message, data);
  }

  async stop({ timeoutMs = 2_000 } = {}) {
    this._disableInactivityWatchdog();
    if (this.state === "idle" || this.state === "stopped") {
      return this._exitInfo;
    }
    if (this._stopPromise) {
      return this._stopPromise;
    }

    this.state = "stopping";
    this._stopPromise = this._stop(timeoutMs);
    return this._stopPromise;
  }

  async _stop(timeoutMs) {
    const child = this.child;
    if (!child) {
      this._terminate({ code: null, signal: null });
      return this._exitInfo;
    }

    if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.end();
    }

    const graceful = await waitFor(this._exitPromise, timeoutMs);
    if (graceful.done) {
      return graceful.value;
    }

    child.kill?.("SIGTERM");
    const terminated = await waitFor(this._exitPromise, timeoutMs);
    if (terminated.done) {
      return terminated.value;
    }

    child.kill?.("SIGKILL");
    const killed = await waitFor(this._exitPromise, timeoutMs);
    if (killed.done) {
      return killed.value;
    }

    const error = new AppServerProcessError(
      "Timed out waiting for Codex app-server to stop after SIGKILL",
      { signal: "SIGKILL" },
    );
    this._terminate({ signal: "SIGKILL", cause: error });
    return this._exitInfo;
  }

  _attachProcess(child) {
    if (!child?.stdin || !child?.stdout || typeof child.on !== "function") {
      throw new TypeError("spawnFn must return a child process with stdin, stdout, and events");
    }

    this._exitPromise = new Promise((resolve) => {
      this._resolveExit = resolve;
    });

    child.stdout.setEncoding?.("utf8");
    child.stdout.on("data", (chunk) => this._consumeStdout(String(chunk)));
    child.stdout.on("error", (error) => this._reportError(error));
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on?.("data", (chunk) => this._consumeStderr(String(chunk)));
    child.stderr?.on?.("error", (error) => this._reportError(error));
    child.stdin.on?.("error", (error) => this._terminate({ cause: error }));
    child.once("error", (error) => this._terminate({ cause: error }));
    child.once("exit", (code, signal) => {
      this._childExited = true;
      this._clearForceKillTimer();
      this._terminate({ code, signal });
    });
  }

  _consumeStdout(chunk) {
    this._stdoutBuffer += chunk;
    while (true) {
      const newline = this._stdoutBuffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = this._stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this._stdoutBuffer = this._stdoutBuffer.slice(newline + 1);
      if (line.trim()) {
        this._consumeLine(line);
      }
    }
  }

  _consumeLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (cause) {
      this._reportError(
        new AppServerProtocolError(`Invalid JSON from Codex app-server: ${line}`, { cause }),
      );
      return;
    }

    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this._reportError(new AppServerProtocolError("App-server message must be an object"));
      return;
    }

    this._recordInboundFrame(message);

    if (typeof message.method === "string" && message.id !== undefined) {
      this._handleServerRequest(message);
      return;
    }

    if (typeof message.method === "string") {
      this._handleNotification(message);
      return;
    }

    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const pending = this._pending.get(message.id);
      if (!pending) {
        this._reportError(
          new AppServerProtocolError(`Response for unknown request id: ${String(message.id)}`),
        );
        return;
      }
      this._pending.delete(message.id);
      if ("error" in message) {
        pending.reject(new AppServerRpcError(message.error, pending.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    this._reportError(new AppServerProtocolError("Unrecognized app-server message"));
  }

  _handleServerRequest(message) {
    const eventHandled = this.emit("request", message, this);
    if (typeof this.onServerRequest !== "function") {
      if (!eventHandled) {
        this.respondError(message.id, -32601, `No handler for server request: ${message.method}`);
      }
      return;
    }

    Promise.resolve()
      .then(() => this.onServerRequest(message, this))
      .then((result) => {
        if (result !== undefined) {
          this.reply(message.id, result);
        }
      })
      .catch((error) => {
        this.error(message.id, error);
        this._reportError(error);
      });
  }

  _handleNotification(message) {
    this.emit("notification", message, this);
    if (typeof this.onNotification !== "function") {
      return;
    }
    Promise.resolve()
      .then(() => this.onNotification(message, this))
      .catch((error) => this._reportError(error));
  }

  _write(message) {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded || this._terminated) {
      throw new AppServerProcessError("Codex app-server stdin is not writable");
    }
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  pauseInactivityWatchdog() {
    if (this._watchdogDisabled || this._terminated) return;
    this._watchdogSuspensions += 1;
    this._clearInactivityWatchdog();
  }

  resumeInactivityWatchdog() {
    if (this._watchdogSuspensions > 0) this._watchdogSuspensions -= 1;
    if (this._watchdogDisabled || this._terminated || this._watchdogSuspensions > 0) return;
    // Human think time is excluded from transport inactivity.
    this._watchdogBaselineAt = Date.now();
    this._armInactivityWatchdog();
  }

  interrupt() {
    this._disableInactivityWatchdog();
  }

  _observeOutbound(message) {
    const params = message.params ?? {};
    if (typeof params.threadId === "string") this._threadId = params.threadId;
    if (message.method === "turn/start") this._turnId = null;
  }

  _recordInboundFrame(message) {
    const pending = message.id === undefined ? null : this._pending.get(message.id);
    if (typeof message.method === "string" && message.id !== undefined) {
      this._lastFrame = `request:${message.method}`;
    } else if (typeof message.method === "string") {
      this._lastFrame = `notification:${message.method}`;
    } else if (message.id !== undefined && ("result" in message || "error" in message)) {
      this._lastFrame = `response:${pending?.message?.method ?? "unknown"}`;
    } else {
      this._lastFrame = "unrecognized";
    }

    this._observeContext(message, pending);
    this._lastFrameAt = Date.now();
    this._watchdogBaselineAt = this._lastFrameAt;
    this._armInactivityWatchdog();
  }

  _observeContext(message, pending) {
    const params = message.params ?? pending?.message?.params ?? {};
    if (typeof params.threadId === "string") this._threadId = params.threadId;
    if (typeof params.turnId === "string") this._turnId = params.turnId;
    if (typeof params.turn?.id === "string") this._turnId = params.turn.id;

    const requestMethod = pending?.message?.method;
    if (requestMethod === "thread/start" && typeof message.result?.thread?.id === "string") {
      this._threadId = message.result.thread.id;
    }
    if (requestMethod === "turn/start" && typeof message.result?.turn?.id === "string") {
      this._turnId = message.result.turn.id;
    }

    const goal = message.params?.goal ?? message.result?.goal;
    if (typeof goal?.status === "string") this._goalStatus = goal.status;
    else if (requestMethod === "thread/goal/get" && "result" in message && message.result?.goal == null) {
      this._goalStatus = "none";
    }

    if (["turn/completed", "turn/failed"].includes(message.method)) {
      const terminalTurnId = message.params?.turn?.id ?? message.params?.turnId;
      if (!terminalTurnId || terminalTurnId === this._turnId) this._turnId = null;
    }
  }

  _consumeStderr(chunk) {
    const bytes = Buffer.from(chunk);
    this._stderrTail = Buffer.concat([this._stderrTail, bytes]);
    if (this._stderrTail.length > this.stderrTailBytes) {
      this._stderrTail = this._stderrTail.subarray(this._stderrTail.length - this.stderrTailBytes);
    }
    this.emit("stderr", chunk);
  }

  _armInactivityWatchdog() {
    this._clearInactivityWatchdog();
    if (
      this._watchdogDisabled ||
      this._watchdogSuspensions > 0 ||
      this._terminated ||
      !this.child
    ) {
      return;
    }
    if (this._watchdogBaselineAt === null) this._watchdogBaselineAt = Date.now();
    const remainingMs = Math.max(
      1,
      this.inactivityTimeoutMs - (Date.now() - this._watchdogBaselineAt),
    );
    this._inactivityTimer = setTimeout(() => this._tripInactivityWatchdog(), remainingMs);
    this._inactivityTimer.unref?.();
  }

  _tripInactivityWatchdog() {
    this._inactivityTimer = null;
    if (
      this._watchdogDisabled ||
      this._watchdogSuspensions > 0 ||
      this._terminated ||
      this._lastFrameAt === null ||
      this._watchdogBaselineAt === null
    ) {
      return;
    }
    const activeInactivityMs = Date.now() - this._watchdogBaselineAt;
    if (activeInactivityMs < this.inactivityTimeoutMs) {
      this._armInactivityWatchdog();
      return;
    }

    const error = new AppServerInactivityError({
      elapsedMs: Date.now() - this._lastFrameAt,
      lastFrame: this._lastFrame,
      threadId: this._threadId,
      turnId: this._turnId,
      goalStatus: this._goalStatus,
      stderrTail: this._stderrTail.toString("utf8"),
    });
    this._terminate({ cause: error });
    this._abortChild();
  }

  _clearInactivityWatchdog() {
    if (this._inactivityTimer !== null) {
      clearTimeout(this._inactivityTimer);
      this._inactivityTimer = null;
    }
  }

  _disableInactivityWatchdog() {
    this._watchdogDisabled = true;
    this._watchdogSuspensions = 0;
    this._clearInactivityWatchdog();
  }

  _abortChild() {
    const child = this.child;
    if (!child || this._childExited || this._forceKillTimer !== null) return;
    child.kill?.("SIGTERM");
    if (this._childExited) return;
    this._forceKillTimer = setTimeout(() => {
      this._forceKillTimer = null;
      if (!this._childExited) child.kill?.("SIGKILL");
    }, this.terminationTimeoutMs);
    this._forceKillTimer.unref?.();
  }

  _clearForceKillTimer() {
    if (this._forceKillTimer !== null) {
      clearTimeout(this._forceKillTimer);
      this._forceKillTimer = null;
    }
  }

  _terminate({ code = null, signal = null, cause } = {}) {
    if (this._terminated) {
      return;
    }
    this._terminated = true;
    this.state = "stopped";
    this._disableInactivityWatchdog();

    const stderrTail = compactDiagnostic(this._stderrTail.toString("utf8")).slice(-1024);
    const permissionHint = /\b(?:EPERM|operation not permitted|permission denied)\b/iu.test(stderrTail)
      ? " Stderr reports a permission error. If the parent native sandbox blocked this control-plane launch, request native escalation for the exact command and bounded task; do not retry automatically or bypass host approval."
      : "";
    const diagnostic = stderrTail ? ` (codex-stderr-tail=${stderrTail})${permissionHint}` : "";
    const processError =
      cause instanceof AppServerProcessError
        ? cause
        : new AppServerProcessError(
            (cause
              ? `Codex app-server failed: ${compactDiagnostic(cause.message ?? String(cause)).slice(-1024)}`
              : `Codex app-server exited${code == null ? "" : ` with code ${code}`}`) + diagnostic,
            { code, signal, cause },
          );

    for (const { reject } of this._pending.values()) {
      reject(processError);
    }
    this._pending.clear();

    this._exitInfo = { code, signal, error: cause ? processError : null };
    this._resolveExit?.(this._exitInfo);
    this.emit("exit", this._exitInfo);
  }

  _reportError(error) {
    if (typeof this.onError === "function") {
      try {
        this.onError(error, this);
      } catch {
        // Error reporting must never take down the JSONL reader.
      }
    }
  }
}

export async function connectAppServer(options = {}) {
  const client = new AppServerClient(options);
  await client.start();
  return client;
}

function normalizeRpcError(codeOrError, message, data) {
  if (typeof codeOrError === "number") {
    const error = { code: codeOrError, message: message ?? "App-server client error" };
    if (data !== undefined) {
      error.data = data;
    }
    return error;
  }

  if (codeOrError instanceof Error) {
    const error = {
      code: Number.isInteger(codeOrError.code) ? codeOrError.code : -32000,
      message: codeOrError.message || "App-server client error",
    };
    if (codeOrError.data !== undefined) {
      error.data = codeOrError.data;
    }
    return error;
  }

  if (codeOrError && typeof codeOrError === "object") {
    return {
      ...codeOrError,
      code: Number.isInteger(codeOrError.code) ? codeOrError.code : -32000,
      message: codeOrError.message ?? "App-server client error",
    };
  }

  return { code: -32000, message: message ?? String(codeOrError ?? "App-server client error") };
}

function waitFor(promise, timeoutMs) {
  if (!promise) {
    return Promise.resolve({ done: true, value: null });
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return promise.then((value) => ({ done: true, value }));
  }

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ done: false, value: null });
      }
    }, timeoutMs);
    timer.unref?.();

    promise.then((value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ done: true, value });
      }
    });
  });
}

function waitWithin(promise, timeoutMs, timeoutError) {
  if (timeoutMs === 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => finish(reject, timeoutError()), timeoutMs);
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function positiveIntegerOrDefault(value, fallback) {
  const parsed = typeof value === "string" && /^\d+$/u.test(value)
    ? Number(value)
    : value;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function formatDuration(milliseconds) {
  return milliseconds % 1_000 === 0 ? `${milliseconds / 1_000}s` : `${milliseconds}ms`;
}

function compactDiagnostic(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
}
