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

      const initialization = await this.request("initialize", {
        clientInfo: this.clientInfo,
        capabilities: this.capabilities,
      });
      this.notify("initialized");
      this.initialization = initialization;
      this.state = "running";
      return initialization;
    } catch (error) {
      if (!this._terminated) {
        this._terminate({ cause: error });
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

    const error = new AppServerProcessError(
      "Timed out waiting for Codex app-server to stop",
      { signal: "SIGTERM" },
    );
    this._terminate({ signal: "SIGTERM", cause: error });
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
    child.stderr?.on?.("data", (chunk) => this.emit("stderr", String(chunk)));
    child.stderr?.on?.("error", (error) => this._reportError(error));
    child.stdin.on?.("error", (error) => this._terminate({ cause: error }));
    child.once("error", (error) => this._terminate({ cause: error }));
    child.once("exit", (code, signal) => this._terminate({ code, signal }));
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

  _terminate({ code = null, signal = null, cause } = {}) {
    if (this._terminated) {
      return;
    }
    this._terminated = true;
    this.state = "stopped";

    const processError =
      cause instanceof AppServerProcessError
        ? cause
        : new AppServerProcessError(
            cause
              ? `Codex app-server failed: ${cause.message ?? String(cause)}`
              : `Codex app-server exited${code == null ? "" : ` with code ${code}`}`,
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
