import { StringDecoder } from "node:string_decoder";

function cancelledError(reason = "cancelled") {
  const error = new Error(`Cruise line input cancelled: ${String(reason)}`);
  error.name = "CruiseInputCancelledError";
  error.code = "CRUISE_INPUT_CANCELLED";
  error.reason = String(reason);
  return error;
}

/**
 * A persistent, line-oriented queue for non-TTY input.
 *
 * Create one reader for a CLI/session and share it across every numbered
 * picker and free-text prompt. The reader starts consuming immediately, so
 * lines that arrive in one pipe chunk remain queued for later prompts instead
 * of being lost when a short-lived readline interface closes.
 */
export class PersistentLineReader {
  constructor({ input = process.stdin } = {}) {
    if (!input || typeof input.on !== "function") {
      throw new TypeError("input must be a readable event stream");
    }

    this.input = input;
    this.endReason = null;
    this._buffer = "";
    this._decoder = new StringDecoder("utf8");
    this._lines = [];
    this._waiters = [];
    this._error = null;
    this._ended = false;
    this._detached = false;
    this._pauseOnClose = input.readableFlowing !== true;

    this._onData = (chunk) => this._acceptChunk(chunk);
    this._onEnd = () => this._finish("eof", true);
    this._onClose = () => this._finish(this.endReason ?? "eof", true);
    this._onError = (error) => this._fail(error);

    input.on("data", this._onData);
    input.once("end", this._onEnd);
    input.once("close", this._onClose);
    input.once("error", this._onError);

    if (input.readableEnded === true || input.destroyed === true) {
      this._finish("eof", true);
    } else if (typeof input.resume === "function") {
      input.resume();
    }
  }

  readLine({ signal = null } = {}) {
    if (signal?.aborted) {
      return Promise.reject(cancelledError(signal.reason ?? "resolved"));
    }
    if (this._lines.length > 0) {
      return Promise.resolve(this._lines.shift());
    }
    if (this._error) {
      return Promise.reject(this._error);
    }
    if (this._ended) {
      return Promise.resolve(null);
    }

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null };
      if (signal) {
        waiter.onAbort = () => {
          const index = this._waiters.indexOf(waiter);
          if (index >= 0) this._waiters.splice(index, 1);
          reject(cancelledError(signal.reason ?? "resolved"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this._waiters.push(waiter);
    });
  }

  async next({ signal = null } = {}) {
    let value;
    try {
      value = await this.readLine({ signal });
    } catch (error) {
      if (error?.code === "CRUISE_INPUT_CANCELLED") {
        return { status: "cancelled", reason: error.reason };
      }
      throw error;
    }
    if (value !== null) {
      return { status: "line", value };
    }
    if (this.endReason && this.endReason !== "eof") {
      return { status: "cancelled", reason: this.endReason };
    }
    return { status: "eof" };
  }

  async question({ prompt = "", output = process.stderr, signal = null } = {}) {
    if (!output || typeof output.write !== "function") {
      throw new TypeError("output must be a writable stream");
    }
    if (prompt) {
      output.write(String(prompt));
    }
    return this.readLine({ signal });
  }

  cancel(reason = "cancelled") {
    const cancelReason = String(reason || "cancelled");
    this._lines.length = 0;
    this._buffer = "";
    this._ended = true;
    this.endReason = cancelReason;
    this._detach();
    this._drain();
  }

  close() {
    this._finish(this.endReason ?? "eof", false);
  }

  _acceptChunk(chunk) {
    if (this._ended || this._error) {
      return;
    }
    const text = typeof chunk === "string" ? chunk : this._decoder.write(chunk);
    this._buffer += text;

    let newline;
    while ((newline = this._buffer.indexOf("\n")) >= 0) {
      let line = this._buffer.slice(0, newline);
      this._buffer = this._buffer.slice(newline + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      this._lines.push(line);
    }
    this._drain();
  }

  _finish(reason, flushBuffer) {
    if (this._ended || this._error) {
      return;
    }

    if (flushBuffer) {
      this._buffer += this._decoder.end();
      if (this._buffer.length > 0) {
        const finalLine = this._buffer.endsWith("\r")
          ? this._buffer.slice(0, -1)
          : this._buffer;
        this._lines.push(finalLine);
      }
    }
    this._buffer = "";
    this._ended = true;
    this.endReason = reason || "eof";
    this._detach();
    this._drain();
  }

  _fail(error) {
    if (this._ended || this._error) {
      return;
    }
    this._error = error instanceof Error ? error : new Error(String(error));
    this._detach();
    this._drain();
  }

  _drain() {
    while (this._lines.length > 0 && this._waiters.length > 0) {
      const waiter = this._waiters.shift();
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      const { resolve } = waiter;
      resolve(this._lines.shift());
    }

    if (this._error) {
      while (this._waiters.length > 0) {
        const waiter = this._waiters.shift();
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
        const { reject } = waiter;
        reject(this._error);
      }
    } else if (this._ended && this._lines.length === 0) {
      while (this._waiters.length > 0) {
        const waiter = this._waiters.shift();
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
        const { resolve } = waiter;
        resolve(null);
      }
    }
  }

  _detach() {
    if (this._detached) {
      return;
    }
    this._detached = true;
    const remove = typeof this.input.off === "function"
      ? this.input.off.bind(this.input)
      : this.input.removeListener?.bind(this.input);
    remove?.("data", this._onData);
    remove?.("end", this._onEnd);
    remove?.("close", this._onClose);
    remove?.("error", this._onError);
    if (this._pauseOnClose && this.input.readableEnded !== true && typeof this.input.pause === "function") {
      this.input.pause();
    }
  }
}

export function createLineReader(options = {}) {
  return new PersistentLineReader(options);
}
