import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";

import { createLineReader, PersistentLineReader } from "../scripts/lib/line-input.mjs";

test("queues every CRLF/LF line and the final unterminated line", async () => {
  const reader = createLineReader({
    input: Readable.from([Buffer.from("first\r\nsecond\nfinal")]),
  });

  assert.equal(await reader.readLine(), "first");
  assert.equal(await reader.readLine(), "second");
  assert.equal(await reader.readLine(), "final");
  assert.equal(await reader.readLine(), null);
  assert.deepEqual(await reader.next(), { status: "eof" });
});

test("pending reads resolve in FIFO order when one chunk contains many answers", async () => {
  const input = new PassThrough();
  const reader = new PersistentLineReader({ input });
  const first = reader.readLine();
  const second = reader.readLine();

  input.end("one\ntwo\n");

  assert.equal(await first, "one");
  assert.equal(await second, "two");
  assert.equal(await reader.readLine(), null);
});

test("question writes its prompt and shares the same queued stream", async () => {
  const chunks = [];
  const output = { write(value) { chunks.push(String(value)); return true; } };
  const reader = createLineReader({ input: Readable.from(["picker\nfree text\n"]) });

  assert.equal(await reader.readLine(), "picker");
  assert.equal(await reader.question({ prompt: "Other: ", output }), "free text");
  assert.equal(chunks.join(""), "Other: ");
});

test("cancel settles pending and future reads with a typed reason", async () => {
  const input = new PassThrough();
  const reader = createLineReader({ input });
  const pending = reader.next();

  reader.cancel("ctrl-c");

  assert.deepEqual(await pending, { status: "cancelled", reason: "ctrl-c" });
  assert.equal(await reader.readLine(), null);
  assert.equal(reader.endReason, "ctrl-c");
});

test("cancel overrides prefetched EOF and discards queued answers", async () => {
  const reader = createLineReader({ input: Readable.from(["one\ntwo\n"]) });
  await new Promise((resolve) => setImmediate(resolve));
  reader.cancel("ctrl-c");

  assert.equal(await reader.readLine(), null);
  assert.deepEqual(await reader.next(), { status: "cancelled", reason: "ctrl-c" });
  assert.equal(reader.endReason, "ctrl-c");
});

test("one aborted read does not cancel the shared reader", async () => {
  const input = new PassThrough();
  const reader = createLineReader({ input });
  const controller = new AbortController();
  const pending = reader.readLine({ signal: controller.signal });
  controller.abort("resolved");
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "CRUISE_INPUT_CANCELLED");
    assert.equal(error.reason, "resolved");
    return true;
  });

  input.end("later\n");
  assert.equal(await reader.readLine(), "later");
});

test("constructing against an already-ended stream settles as EOF", async () => {
  const input = Readable.from([]);
  input.resume();
  await new Promise((resolve) => input.once("end", resolve));
  const reader = createLineReader({ input });

  assert.equal(await reader.readLine(), null);
  assert.deepEqual(await reader.next(), { status: "eof" });
});

test("input errors reject pending and future reads", async () => {
  const input = new PassThrough();
  const reader = createLineReader({ input });
  const pending = reader.readLine();
  const failure = new Error("input failed");

  input.destroy(failure);

  await assert.rejects(pending, /input failed/u);
  await assert.rejects(reader.readLine(), /input failed/u);
});
