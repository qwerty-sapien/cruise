import {
  clearScreenDown,
  cursorTo,
  emitKeypressEvents,
  moveCursor,
} from "node:readline";

import { createLineReader } from "./line-input.mjs";

const DEFAULT_COLUMNS = 80;
const ANSI_CSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/gu;

function assertOptionCount(optionCount) {
  if (!Number.isInteger(optionCount) || optionCount < 1) {
    throw new RangeError("optionCount must be a positive integer");
  }
}

function sanitizeLine(value) {
  return String(value ?? "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function sanitizeRenderedLine(value) {
  return String(value ?? "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .trimEnd();
}

function sanitizePrefix(value) {
  return String(value ?? "")
    .replace(ANSI_CSI_PATTERN, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
}

function normalizeOptions(options) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new TypeError("options must be a non-empty array");
  }

  return options.map((option, index) => {
    if (typeof option === "string") {
      const label = sanitizeLine(option);
      if (!label) {
        throw new TypeError(`options[${index}] must have a non-empty label`);
      }
      return { label, value: option };
    }

    if (option && typeof option === "object" && typeof option.label === "string") {
      const label = sanitizeLine(option.label);
      if (!label) {
        throw new TypeError(`options[${index}].label must not be empty`);
      }
      return {
        label,
        value: Object.hasOwn(option, "value") ? option.value : option.label,
      };
    }

    throw new TypeError(`options[${index}] must be a string or { label, value } object`);
  });
}

/**
 * Conservatively estimate terminal cells without a width-table dependency.
 * ASCII is one cell; all other printable code points count as two. This may
 * truncate early, but it avoids under-counting common wide glyphs and wrapping
 * a row that the redraw logic assumes occupies exactly one terminal line.
 */
export function terminalCellWidth(value) {
  let width = 0;
  for (const character of String(value ?? "")) {
    width += character.codePointAt(0) <= 0x7e ? 1 : 2;
  }
  return width;
}

export function fitTerminalLine(value, columns = DEFAULT_COLUMNS) {
  const safeColumns = Number.isFinite(columns)
    ? Math.max(1, Math.floor(columns))
    : DEFAULT_COLUMNS;
  // Avoid writing into the final column, where some terminals auto-wrap.
  const limit = Math.max(1, safeColumns - 1);
  const line = sanitizeRenderedLine(value);
  if (terminalCellWidth(line) <= limit) {
    return line;
  }

  const suffix = limit >= 4 ? "..." : ".".repeat(limit);
  const contentLimit = Math.max(0, limit - suffix.length);
  let width = 0;
  let result = "";
  for (const character of line) {
    const characterWidth = character.codePointAt(0) <= 0x7e ? 1 : 2;
    if (width + characterWidth > contentLimit) {
      break;
    }
    result += character;
    width += characterWidth;
  }
  return result + suffix;
}

function takeWrappedSegment(value, widthLimit) {
  if (terminalCellWidth(value) <= widthLimit) {
    return { segment: value, remaining: "" };
  }

  let offset = 0;
  let cells = 0;
  let lastSpace = -1;
  for (const character of value) {
    const characterWidth = character.codePointAt(0) <= 0x7e ? 1 : 2;
    if (cells + characterWidth > widthLimit) {
      break;
    }
    if (character === " ") {
      lastSpace = offset;
    }
    cells += characterWidth;
    offset += character.length;
  }

  const splitAt = lastSpace > 0 ? lastSpace : offset;
  // A single glyph can be wider than an extremely narrow terminal. Keep it
  // visible on its own row rather than dropping it or looping forever.
  const safeSplit = splitAt > 0 ? splitAt : [...value][0].length;
  return {
    segment: value.slice(0, safeSplit).trimEnd(),
    remaining: value.slice(safeSplit).trimStart(),
  };
}

function splitByCellWidth(value, widthLimit) {
  const lines = [];
  let remaining = value;
  while (remaining) {
    let offset = 0;
    let cells = 0;
    for (const character of remaining) {
      const characterWidth = character.codePointAt(0) <= 0x7e ? 1 : 2;
      if (cells + characterWidth > widthLimit && offset > 0) {
        break;
      }
      cells += characterWidth;
      offset += character.length;
      if (cells >= widthLimit) {
        break;
      }
    }
    const safeOffset = offset > 0 ? offset : [...remaining][0].length;
    lines.push(remaining.slice(0, safeOffset));
    remaining = remaining.slice(safeOffset);
  }
  return lines;
}

/** Wrap all visible text into explicit terminal rows without silent clipping. */
export function wrapTerminalText(
  value,
  {
    columns = DEFAULT_COLUMNS,
    firstPrefix = "",
    continuationPrefix = firstPrefix,
  } = {},
) {
  const safeColumns = Number.isFinite(columns)
    ? Math.max(1, Math.floor(columns))
    : DEFAULT_COLUMNS;
  const limit = Math.max(1, safeColumns - 1);
  const text = sanitizeLine(value);
  const first = sanitizePrefix(firstPrefix);
  const continuation = sanitizePrefix(continuationPrefix);

  if (!text) {
    return splitByCellWidth(first, limit);
  }

  // Prefixes wider than the terminal cannot support aligned wrapping. Wrap
  // the complete decorated row instead; no user-supplied text is discarded.
  if (terminalCellWidth(first) >= limit || terminalCellWidth(continuation) >= limit) {
    return splitByCellWidth(`${first}${text}`, limit);
  }

  const lines = [];
  let remaining = text;
  let prefix = first;
  while (remaining) {
    const available = limit - terminalCellWidth(prefix);
    const wrapped = takeWrappedSegment(remaining, available);
    lines.push(`${prefix}${wrapped.segment}`);
    remaining = wrapped.remaining;
    prefix = continuation;
  }
  return lines;
}

export function keypressToAction(character, key = {}) {
  const name = String(key.name ?? "").toLowerCase();

  if (key.ctrl === true && name === "c") {
    return { type: "cancel", reason: "ctrl-c" };
  }
  if (name === "escape" || character === "\u001b") {
    return { type: "cancel", reason: "escape" };
  }
  if (name === "up") {
    return { type: "up" };
  }
  if (name === "down") {
    return { type: "down" };
  }
  if (name === "return" || name === "enter" || character === "\r" || character === "\n") {
    return { type: "select" };
  }
  if (name === "space" || character === " ") {
    return { type: "select" };
  }
  if (key.ctrl !== true && key.meta !== true && /^[1-9]$/u.test(character ?? "")) {
    return { type: "digit", digit: Number(character) };
  }
  if (
    key.ctrl !== true &&
    key.meta !== true &&
    (character === "q" || character === "Q" || name === "q")
  ) {
    return { type: "cancel", reason: "q" };
  }
  return null;
}

export function reducePicker(state, action, optionCount) {
  assertOptionCount(optionCount);
  const cursor = Number.isInteger(state?.cursor) && state.cursor >= 0 && state.cursor < optionCount
    ? state.cursor
    : 0;
  const currentState = { cursor };

  if (!action || typeof action !== "object") {
    return { state: currentState, outcome: null };
  }

  switch (action.type) {
    case "up":
      return {
        state: { cursor: (cursor - 1 + optionCount) % optionCount },
        outcome: null,
      };
    case "down":
      return {
        state: { cursor: (cursor + 1) % optionCount },
        outcome: null,
      };
    case "select":
      return {
        state: currentState,
        outcome: { status: "selected", index: cursor },
      };
    case "digit": {
      const index = Number(action.digit) - 1;
      if (index >= 0 && index < Math.min(optionCount, 9)) {
        return {
          state: { cursor: index },
          outcome: { status: "selected", index },
        };
      }
      return { state: currentState, outcome: null };
    }
    case "cancel":
      return {
        state: currentState,
        outcome: {
          status: "cancelled",
          reason: action.reason ?? "cancelled",
        },
      };
    default:
      return { state: currentState, outcome: null };
  }
}

export function parseNumberedInput(value, optionCount) {
  assertOptionCount(optionCount);
  const input = String(value ?? "").trim();
  const lower = input.toLowerCase();

  if (lower === "q") {
    return { type: "cancel", reason: "q" };
  }
  if (input === "\u001b") {
    return { type: "cancel", reason: "escape" };
  }
  if (input === "\u0003") {
    return { type: "cancel", reason: "ctrl-c" };
  }
  if (!/^[1-9]\d*$/u.test(input)) {
    return null;
  }

  const index = Number(input) - 1;
  if (!Number.isSafeInteger(index) || index < 0 || index >= optionCount) {
    return null;
  }
  return { type: "select-index", index };
}

export function renderPickerLines({
  title,
  labels,
  cursor = 0,
  columns = DEFAULT_COLUMNS,
}) {
  if (!Array.isArray(labels) || labels.length === 0) {
    throw new TypeError("labels must be a non-empty array");
  }
  const activeCursor = Number.isInteger(cursor) && cursor >= 0 && cursor < labels.length
    ? cursor
    : 0;
  const safeTitle = sanitizeLine(title) || "Select one";
  const lines = wrapTerminalText(safeTitle, {
    columns,
    firstPrefix: "  ",
    continuationPrefix: "  ",
  });

  for (const [index, label] of labels.entries()) {
    const marker = index === activeCursor ? ">" : " ";
    const prefix = `  ${marker} ${index + 1}. `;
    lines.push(
      ...wrapTerminalText(label, {
        columns,
        firstPrefix: prefix,
        continuationPrefix: " ".repeat(prefix.length),
      }),
    );
  }
  lines.push(
    ...wrapTerminalText(
      "Up/Down move | Enter/Space select | 1-9 choose | q/Esc/Ctrl-C cancel",
      { columns, firstPrefix: "  ", continuationPrefix: "  " },
    ),
  );
  return lines;
}

function selectedResult(option, index, via) {
  return {
    status: "selected",
    index,
    label: option.label,
    value: option.value,
    via,
  };
}

function cancelledResult(reason, via) {
  return { status: "cancelled", reason, via };
}

function isInteractiveTty(input, output) {
  return Boolean(
    input?.isTTY &&
    output?.isTTY &&
    typeof input.setRawMode === "function" &&
    typeof input.on === "function" &&
    typeof input.resume === "function",
  );
}

function clearRenderedRows(output, rowCount) {
  if (rowCount <= 0) {
    return;
  }
  moveCursor(output, 0, -rowCount);
  cursorTo(output, 0);
  clearScreenDown(output);
}

function pickOneTty({ title, options, input, output, signal }) {
  return new Promise((resolve, reject) => {
    let state = { cursor: 0 };
    let renderedRows = 0;
    let settled = false;
    const wasRaw = input.isRaw === true;
    const pauseOnCleanup = input.readableFlowing !== true;
    let rawModeMayHaveChanged = false;

    const recordError = (errors, operation) => {
      try {
        operation();
      } catch (error) {
        errors.push(error);
      }
    };

    const render = () => {
      if (renderedRows > 0) {
        clearRenderedRows(output, renderedRows);
      }
      const lines = renderPickerLines({
        title,
        labels: options.map((option) => option.label),
        cursor: state.cursor,
        columns:
          Number.isFinite(output.columns) && output.columns >= 20
            ? output.columns
            : DEFAULT_COLUMNS,
      });
      output.write(`${lines.join("\n")}\n`);
      renderedRows = lines.length;
    };

    const cleanup = (summary) => {
      const errors = [];
      recordError(errors, () => input.removeListener("keypress", onKeypress));
      recordError(errors, () => input.removeListener("error", onInputError));
      recordError(errors, () => output.removeListener("error", onOutputError));
      recordError(errors, () => signal?.removeEventListener("abort", onAbort));
      recordError(errors, () => clearRenderedRows(output, renderedRows));
      renderedRows = 0;
      if (summary) {
        recordError(errors, () => output.write(summary));
      }
      if (rawModeMayHaveChanged) {
        recordError(errors, () => input.setRawMode(wasRaw));
      }
      if (pauseOnCleanup && typeof input.pause === "function") {
        recordError(errors, () => input.pause());
      }
      return errors;
    };

    const finish = (outcome, error = null) => {
      if (settled) {
        return;
      }
      settled = true;

      let summary = "";
      let result = null;
      if (!error && outcome?.status === "selected") {
        const option = options[outcome.index];
        result = selectedResult(option, outcome.index, "tty");
        summary = `  ${sanitizeLine(title) || "Selected"}: ${option.label}\n`;
      } else if (!error && outcome?.status === "cancelled") {
        result = cancelledResult(outcome.reason, "tty");
        summary = `  ${sanitizeLine(title) || "Selection"}: cancelled\n`;
      }

      const cleanupErrors = cleanup(summary);
      if (error) {
        reject(error);
      } else if (cleanupErrors.length === 1) {
        reject(cleanupErrors[0]);
      } else if (cleanupErrors.length > 1) {
        reject(new AggregateError(cleanupErrors, "picker cleanup failed"));
      } else {
        resolve(result);
      }
    };

    function onKeypress(character, key) {
      try {
        const action = keypressToAction(character, key);
        if (!action) {
          return;
        }
        const transition = reducePicker(state, action, options.length);
        state = transition.state;
        if (transition.outcome) {
          finish(transition.outcome);
        } else {
          render();
        }
      } catch (error) {
        finish(null, error);
      }
    }

    function onInputError(error) {
      finish(null, error);
    }

    function onOutputError(error) {
      finish(null, error);
    }

    function onAbort() {
      finish({ status: "cancelled", reason: String(signal?.reason ?? "resolved") });
    }

    try {
      if (signal?.aborted) {
        finish({ status: "cancelled", reason: String(signal.reason ?? "resolved") });
        return;
      }
      emitKeypressEvents(input);
      input.on("keypress", onKeypress);
      input.once("error", onInputError);
      output.once("error", onOutputError);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (!wasRaw) {
        rawModeMayHaveChanged = true;
        input.setRawMode(true);
      }
      input.resume();
      render();
    } catch (error) {
      finish(null, error);
    }
  });
}

async function pickOneNumbered({ title, options, input, output, lineReader, signal }) {
  const heading = sanitizeLine(title) || "Select one";
  output.write(`  ${heading}:\n`);
  for (const [index, option] of options.entries()) {
    output.write(`  ${index + 1}. ${option.label}\n`);
  }

  const ownsLineReader = lineReader == null;
  const reader = lineReader ?? createLineReader({ input });
  if (!reader || typeof reader.readLine !== "function") {
    throw new TypeError("lineReader must expose readLine()");
  }

  try {
    output.write(`Choose 1-${options.length} or q to cancel: `);
    while (true) {
      let line;
      try {
        line = await reader.readLine({ signal });
      } catch (error) {
        if (error?.code === "CRUISE_INPUT_CANCELLED") {
          return cancelledResult(error.reason ?? "resolved", "numbered");
        }
        throw error;
      }
      if (line === null) {
        return cancelledResult(reader.endReason ?? "eof", "numbered");
      }
      const action = parseNumberedInput(line, options.length);
      if (action?.type === "select-index") {
        return selectedResult(options[action.index], action.index, "numbered");
      }
      if (action?.type === "cancel") {
        return cancelledResult(action.reason, "numbered");
      }
      output.write(`Invalid choice. Enter 1-${options.length} or q: `);
    }
  } finally {
    if (ownsLineReader && typeof reader.close === "function") {
      reader.close();
    }
  }
}

export async function pickOne({
  title,
  options,
  input = process.stdin,
  output = process.stderr,
  lineReader = null,
  signal = null,
}) {
  const normalizedOptions = normalizeOptions(options);
  if (!input || !output || typeof output.write !== "function") {
    throw new TypeError("input and output must be readable/writable streams");
  }

  if (isInteractiveTty(input, output)) {
    return pickOneTty({ title, options: normalizedOptions, input, output, signal });
  }
  return pickOneNumbered({
    title,
    options: normalizedOptions,
    input,
    output,
    lineReader,
    signal,
  });
}
