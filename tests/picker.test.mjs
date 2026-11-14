import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";

import {
  fitTerminalLine,
  keypressToAction,
  parseNumberedInput,
  pickOne,
  reducePicker,
  renderPickerLines,
  terminalCellWidth,
  wrapTerminalText,
} from "../scripts/lib/picker.mjs";
import { createLineReader } from "../scripts/lib/line-input.mjs";

class FakeInput extends EventEmitter {
  constructor({ isTTY = true, isRaw = false, readableFlowing = null } = {}) {
    super();
    this.isTTY = isTTY;
    this.isRaw = isRaw;
    this.readableFlowing = readableFlowing;
    this.rawModeCalls = [];
    this.resumeCalls = 0;
    this.pauseCalls = 0;
  }

  setRawMode(value) {
    this.rawModeCalls.push(value);
    this.isRaw = value;
    return this;
  }

  resume() {
    this.resumeCalls += 1;
    this.readableFlowing = true;
    return this;
  }

  pause() {
    this.pauseCalls += 1;
    this.readableFlowing = false;
    return this;
  }
}

class FakeOutput extends EventEmitter {
  constructor({ isTTY = true, columns = 80, throwOnWrite = false } = {}) {
    super();
    this.isTTY = isTTY;
    this.columns = columns;
    this.throwOnWrite = throwOnWrite;
    this.chunks = [];
  }

  write(value) {
    if (this.throwOnWrite) {
      throw new Error("write failed");
    }
    this.chunks.push(String(value));
    return true;
  }

  text() {
    return this.chunks.join("");
  }
}

test("reducer wraps Up and Down without mutating state", () => {
  const initial = { cursor: 0 };
  const up = reducePicker(initial, { type: "up" }, 3);
  const down = reducePicker(up.state, { type: "down" }, 3);

  assert.deepEqual(initial, { cursor: 0 });
  assert.deepEqual(up, { state: { cursor: 2 }, outcome: null });
  assert.deepEqual(down, { state: { cursor: 0 }, outcome: null });
});

test("Enter and Space normalize to selection", () => {
  assert.deepEqual(keypressToAction("\r", { name: "return" }), { type: "select" });
  assert.deepEqual(keypressToAction(" ", { name: "space" }), { type: "select" });
  assert.deepEqual(
    reducePicker({ cursor: 1 }, keypressToAction(" ", { name: "space" }), 3).outcome,
    { status: "selected", index: 1 },
  );
});

test("digits 1-9 select immediately when in range and ignore invalid positions", () => {
  const selected = reducePicker(
    { cursor: 0 },
    keypressToAction("3", { name: "3", ctrl: false, meta: false }),
    4,
  );
  const ignored = reducePicker(
    { cursor: 1 },
    keypressToAction("9", { name: "9", ctrl: false, meta: false }),
    4,
  );

  assert.deepEqual(selected, {
    state: { cursor: 2 },
    outcome: { status: "selected", index: 2 },
  });
  assert.deepEqual(ignored, { state: { cursor: 1 }, outcome: null });
  assert.equal(keypressToAction("0", { name: "0" }), null);
});

test("q, Escape, and Ctrl-C normalize to distinct cancellation reasons", () => {
  assert.deepEqual(keypressToAction("Q", { name: "q" }), {
    type: "cancel",
    reason: "q",
  });
  assert.deepEqual(keypressToAction("\u001b", { name: "escape" }), {
    type: "cancel",
    reason: "escape",
  });
  assert.deepEqual(keypressToAction("\u0003", { name: "c", ctrl: true }), {
    type: "cancel",
    reason: "ctrl-c",
  });
});

test("numbered parser accepts full integers and cancellation controls", () => {
  assert.deepEqual(parseNumberedInput(" 10 ", 12), { type: "select-index", index: 9 });
  assert.deepEqual(parseNumberedInput("q", 12), { type: "cancel", reason: "q" });
  assert.deepEqual(parseNumberedInput("\u001b", 12), {
    type: "cancel",
    reason: "escape",
  });
  assert.deepEqual(parseNumberedInput("\u0003", 12), {
    type: "cancel",
    reason: "ctrl-c",
  });
  assert.equal(parseNumberedInput("0", 12), null);
  assert.equal(parseNumberedInput("13", 12), null);
  assert.equal(parseNumberedInput("2 later", 12), null);
});

test("renderer wraps every title and option word into redraw-safe rows", () => {
  const title = "Choose now because the complete decision context must remain visible";
  const longLabel = "A very long 🛳️ second option whose distinguishing tail must remain visible";
  const lines = renderPickerLines({
    title: `${title}\n\u001b[31m`,
    labels: ["First", longLabel],
    cursor: 1,
    columns: 28,
  });

  assert.equal(lines.filter((line) => line.startsWith("  > ")).length, 1);
  assert.ok(lines.some((line) => line.startsWith("  > 2. ")));
  assert.ok(lines.every((line) => !/[\u0000-\u001f\u007f-\u009f]/u.test(line)));
  assert.ok(lines.every((line) => terminalCellWidth(line) <= 27));
  const rendered = lines.join(" ").replace(/\s+/gu, " ");
  assert.match(rendered, /complete decision context must remain visible/u);
  assert.match(rendered, /distinguishing tail must remain visible/u);
  assert.equal(terminalCellWidth(fitTerminalLine("船".repeat(20), 12)) <= 11, true);
});

test("wrapper preserves an overlong word and handles extremely narrow columns", () => {
  const word = "untruncated-supercalifragilistic";
  const lines = wrapTerminalText(word, {
    columns: 8,
    firstPrefix: "  > ",
    continuationPrefix: "    ",
  });

  assert.equal(lines.join("").replace(/\s/gu, "").endsWith(word), true);
  assert.ok(lines.every((line) => terminalCellWidth(line) <= 7));
});

test("TTY picker navigates, selects, and restores raw and paused state", async () => {
  const input = new FakeInput();
  const output = new FakeOutput({ columns: 32 });
  const title = "Plan approval with complete review context";
  const optionLabels = [
    "Approve the fully reviewed implementation plan",
    "Revise one material part of the implementation plan",
  ];
  const initialRows = renderPickerLines({
    title,
    labels: optionLabels,
    cursor: 0,
    columns: output.columns,
  }).length;
  const pending = pickOne({
    title,
    options: [
      { label: optionLabels[0], value: "approve" },
      { label: optionLabels[1], value: "revise" },
    ],
    input,
    output,
  });

  input.emit("keypress", undefined, { name: "down" });
  input.emit("keypress", "\r", { name: "return" });
  const result = await pending;

  assert.deepEqual(result, {
    status: "selected",
    index: 1,
    label: optionLabels[1],
    value: "revise",
    via: "tty",
  });
  assert.deepEqual(input.rawModeCalls, [true, false]);
  assert.equal(input.resumeCalls, 1);
  assert.equal(input.pauseCalls, 1);
  assert.equal(input.listenerCount("keypress"), 0);
  assert.match(output.text(), new RegExp(`\\u001b\\[${initialRows}A`, "u"));
  assert.match(output.text(), /complete review context/u);
  assert.match(output.text(), /material part of the implementation plan/u);
});

test("TTY picker preserves an already-raw, already-flowing input on cancel", async () => {
  const input = new FakeInput({ isRaw: true, readableFlowing: true });
  const output = new FakeOutput();
  const pending = pickOne({ title: "Start Cruise", options: ["Start", "Save"], input, output });

  input.emit("keypress", "\u0003", { name: "c", ctrl: true });
  const result = await pending;

  assert.deepEqual(result, {
    status: "cancelled",
    reason: "ctrl-c",
    via: "tty",
  });
  assert.deepEqual(input.rawModeCalls, []);
  assert.equal(input.pauseCalls, 0);
  assert.equal(input.listenerCount("keypress"), 0);
});

test("TTY picker falls back to a sane width when the PTY reports zero columns", async () => {
  const input = new FakeInput();
  const output = new FakeOutput({ columns: 0 });
  const pending = pickOne({
    title: "Cruise picker",
    options: ["Recommended path", "Alternative path"],
    input,
    output,
  });
  input.emit("keypress", "1", { name: "1" });
  const result = await pending;

  assert.equal(result.index, 0);
  assert.equal(output.text().split("\n").length < 20, true);
});

test("an external resolution aborts one TTY picker and restores terminal state", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const controller = new AbortController();
  const pending = pickOne({
    title: "Approval",
    options: ["Allow", "Deny"],
    input,
    output,
    signal: controller.signal,
  });
  controller.abort("resolved");
  const result = await pending;

  assert.deepEqual(result, {
    status: "cancelled",
    reason: "resolved",
    via: "tty",
  });
  assert.deepEqual(input.rawModeCalls, [true, false]);
  assert.equal(input.listenerCount("keypress"), 0);
});

test("TTY picker restores raw mode and paused state when rendering fails", async () => {
  const input = new FakeInput();
  const output = new FakeOutput({ throwOnWrite: true });

  await assert.rejects(
    pickOne({ title: "Broken", options: ["One", "Two"], input, output }),
    /write failed/u,
  );
  assert.deepEqual(input.rawModeCalls, [true, false]);
  assert.equal(input.pauseCalls, 1);
  assert.equal(input.listenerCount("keypress"), 0);
});

test("non-TTY fallback numbers options, retries invalid input, and selects", async () => {
  const input = Readable.from(["later\n2\n"]);
  const output = new FakeOutput({ isTTY: false });
  const result = await pickOne({
    title: "Choose a path",
    options: [
      { label: "Recommended", value: "recommended" },
      { label: "Alternative", value: "alternative" },
    ],
    input,
    output,
  });

  assert.deepEqual(result, {
    status: "selected",
    index: 1,
    label: "Alternative",
    value: "alternative",
    via: "numbered",
  });
  assert.match(output.text(), /1\. Recommended/u);
  assert.match(output.text(), /Invalid choice/u);
});

test("non-TTY fallback supports q cancellation and EOF cancellation", async () => {
  const qResult = await pickOne({
    title: "Choose",
    options: ["One"],
    input: Readable.from(["q\n"]),
    output: new FakeOutput({ isTTY: false }),
  });
  const eofResult = await pickOne({
    title: "Choose",
    options: ["One"],
    input: Readable.from([]),
    output: new FakeOutput({ isTTY: false }),
  });

  assert.deepEqual(qResult, { status: "cancelled", reason: "q", via: "numbered" });
  assert.deepEqual(eofResult, { status: "cancelled", reason: "eof", via: "numbered" });
});

test("an ending TTY stream settles as EOF and restores terminal state", async () => {
  const input = Readable.from([]);
  input.isTTY = true;
  input.isRaw = false;
  const rawModeCalls = [];
  input.setRawMode = (value) => { input.isRaw = value; rawModeCalls.push(value); };
  const output = new FakeOutput();

  assert.deepEqual(await pickOne({ title: "Native approval", options: ["Approve", "Decline"], input, output }), {
    status: "cancelled", reason: "eof", via: "tty",
  });
  assert.deepEqual(rawModeCalls, [true, false]);
  for (const event of ["keypress", "end", "close", "error"]) assert.equal(input.listenerCount(event), 0);
  assert.equal(output.listenerCount("error"), 0);
});

test("an already-ended TTY stream settles without entering raw mode", async () => {
  const input = Readable.from([]);
  input.resume();
  await new Promise((resolve) => input.once("end", resolve));
  input.isTTY = true;
  const rawModeCalls = [];
  input.setRawMode = (value) => rawModeCalls.push(value);

  assert.deepEqual(await pickOne({ title: "Native approval", options: ["Approve"], input, output: new FakeOutput() }), {
    status: "cancelled", reason: "eof", via: "tty",
  });
  assert.deepEqual(rawModeCalls, []);
});

test("one shared line reader preserves picker, free-text, and picker answers", async () => {
  const input = Readable.from(["1\ncustom requirement\n2\n"]);
  const lineReader = createLineReader({ input });
  const output = new FakeOutput({ isTTY: false });

  const first = await pickOne({
    title: "First",
    options: ["A", "B"],
    input,
    output,
    lineReader,
  });
  const freeText = await lineReader.question({ prompt: "Other: ", output });
  const second = await pickOne({
    title: "Second",
    options: ["C", "D"],
    input,
    output,
    lineReader,
  });
  lineReader.close();

  assert.equal(first.index, 0);
  assert.equal(freeText, "custom requirement");
  assert.equal(second.index, 1);
});
