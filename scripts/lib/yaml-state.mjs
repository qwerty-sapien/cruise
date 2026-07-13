import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_NODES = 100_000;
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/u;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class YamlParseError extends Error {
  constructor(message, { line = null, cause } = {}) {
    super(line == null ? message : `${message} (line ${line})`, cause ? { cause } : undefined);
    this.name = 'YamlParseError';
    this.code = 'CRUISE_YAML_PARSE';
    this.line = line;
  }
}

export class YamlSchemaError extends Error {
  constructor(errors, name = 'YAML state') {
    const issues = Array.isArray(errors) ? errors : [String(errors)];
    super(`${name} failed schema validation: ${issues.join('; ')}`);
    this.name = 'YamlSchemaError';
    this.code = 'CRUISE_YAML_SCHEMA';
    this.errors = issues;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSafeKey(key, path) {
  if (FORBIDDEN_KEYS.has(key)) {
    throw new TypeError(`${path} contains forbidden mapping key ${JSON.stringify(key)}`);
  }
}

function assertYamlValue(value, { maxDepth, maxNodes }) {
  let nodes = 0;
  const visit = (current, depth, path) => {
    nodes += 1;
    if (nodes > maxNodes) throw new RangeError(`YAML value exceeds ${maxNodes} nodes`);
    if (depth > maxDepth) throw new RangeError(`YAML value exceeds depth ${maxDepth}`);

    if (
      current === null ||
      typeof current === 'string' ||
      typeof current === 'boolean'
    ) {
      return;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError(`${path} must contain a finite number`);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, depth + 1, `${path}[${index}]`));
      return;
    }
    if (!isPlainObject(current)) {
      throw new TypeError(`${path} must contain only JSON-compatible values`);
    }
    for (const key of Object.keys(current)) {
      assertSafeKey(key, path);
      visit(current[key], depth + 1, `${path}.${key}`);
    }
  };
  visit(value, 0, '$');
}

function scalarText(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  return JSON.stringify(value);
}

function inlineEmpty(value) {
  if (Array.isArray(value) && value.length === 0) return '[]';
  if (isPlainObject(value) && Object.keys(value).length === 0) return '{}';
  return null;
}

function renderKey(key) {
  return SAFE_KEY.test(key) ? key : JSON.stringify(key);
}

function renderYaml(value, depth, indent, sortKeys) {
  const prefix = ' '.repeat(depth * indent);
  if (!Array.isArray(value) && !isPlainObject(value)) return [prefix + scalarText(value)];

  const empty = inlineEmpty(value);
  if (empty !== null) return [prefix + empty];

  if (Array.isArray(value)) {
    const lines = [];
    for (const item of value) {
      const itemEmpty = inlineEmpty(item);
      if (!Array.isArray(item) && !isPlainObject(item)) {
        lines.push(`${prefix}- ${scalarText(item)}`);
      } else if (itemEmpty !== null) {
        lines.push(`${prefix}- ${itemEmpty}`);
      } else {
        lines.push(`${prefix}-`);
        lines.push(...renderYaml(item, depth + 1, indent, sortKeys));
      }
    }
    return lines;
  }

  const keys = Object.keys(value);
  if (sortKeys) keys.sort((a, b) => a.localeCompare(b, 'en'));
  const lines = [];
  for (const key of keys) {
    const item = value[key];
    const itemEmpty = inlineEmpty(item);
    if (!Array.isArray(item) && !isPlainObject(item)) {
      lines.push(`${prefix}${renderKey(key)}: ${scalarText(item)}`);
    } else if (itemEmpty !== null) {
      lines.push(`${prefix}${renderKey(key)}: ${itemEmpty}`);
    } else {
      lines.push(`${prefix}${renderKey(key)}:`);
      lines.push(...renderYaml(item, depth + 1, indent, sortKeys));
    }
  }
  return lines;
}

/** Serialize JSON-compatible state to a deterministic, non-executable YAML subset. */
export function stringifyYaml(
  value,
  {
    indent = 2,
    sortKeys = true,
    maxDepth = DEFAULT_MAX_DEPTH,
    maxNodes = DEFAULT_MAX_NODES,
  } = {},
) {
  if (!Number.isInteger(indent) || indent < 1 || indent > 8) {
    throw new RangeError('indent must be an integer from 1 through 8');
  }
  assertYamlValue(value, { maxDepth, maxNodes });
  return `${renderYaml(value, 0, indent, sortKeys).join('\n')}\n`;
}

function stripInlineComment(text) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === '#' && (index === 0 || /\s/u.test(text[index - 1]))) {
      return text.slice(0, index).trimEnd();
    }
  }
  return text.trimEnd();
}

function findMappingSeparator(text) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === ':' && (index + 1 === text.length || /\s/u.test(text[index + 1]))) {
      return index;
    }
  }
  return -1;
}

function parseKey(text, line) {
  const keyText = text.trim();
  let key;
  if (keyText.startsWith('"')) {
    try {
      key = JSON.parse(keyText);
    } catch (cause) {
      throw new YamlParseError('Invalid quoted mapping key', { line, cause });
    }
  } else if (SAFE_KEY.test(keyText)) {
    key = keyText;
  } else {
    throw new YamlParseError(`Unsafe or unsupported mapping key ${JSON.stringify(keyText)}`, {
      line,
    });
  }
  if (typeof key !== 'string' || key.length === 0) {
    throw new YamlParseError('Mapping keys must be non-empty strings', { line });
  }
  if (FORBIDDEN_KEYS.has(key)) {
    throw new YamlParseError(`Forbidden mapping key ${JSON.stringify(key)}`, { line });
  }
  return key;
}

function parseSingleQuoted(text, line) {
  if (!text.endsWith("'")) {
    throw new YamlParseError('Unterminated single-quoted scalar', { line });
  }
  return text.slice(1, -1).replace(/''/gu, "'");
}

function parseFlowValue(text, line) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new YamlParseError(
      'Flow collections must use JSON quoting; use indented YAML for other values',
      { line, cause },
    );
  }
}

function parseScalar(text, line) {
  const value = text.trim();
  if (value === 'null' || value === '~') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === '[]') return [];
  if (value === '{}') return {};
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(value)) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new YamlParseError('Number must be finite', { line });
    return number;
  }
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== 'string') {
        throw new YamlParseError('Quoted scalar must decode to a string', { line });
      }
      return parsed;
    } catch (cause) {
      if (cause instanceof YamlParseError) throw cause;
      throw new YamlParseError('Invalid double-quoted scalar', { line, cause });
    }
  }
  if (value.startsWith("'")) return parseSingleQuoted(value, line);
  if (value.startsWith('[') || value.startsWith('{')) return parseFlowValue(value, line);
  if (
    value.startsWith('!') ||
    value.startsWith('&') ||
    value.startsWith('*') ||
    value === '>' ||
    value === '>-' ||
    value === '>+' ||
    value === '<<' ||
    /^<<\s*:/u.test(value)
  ) {
    throw new YamlParseError('YAML tags, anchors, aliases, folded blocks, and merge keys are not supported', {
      line,
    });
  }
  return value;
}

function tokenize(source) {
  const rawLines = source.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  return rawLines.map((raw, index) => {
    if (raw.includes('\t')) {
      throw new YamlParseError('Tabs are not allowed for indentation', { line: index + 1 });
    }
    const indent = raw.match(/^ */u)[0].length;
    const originalContent = raw.slice(indent);
    const content = stripInlineComment(originalContent);
    return {
      raw,
      indent,
      content,
      blank: content.trim().length === 0,
      line: index + 1,
    };
  });
}

function nextSignificant(lines, start) {
  let index = start;
  while (index < lines.length && lines[index].blank) index += 1;
  return index;
}

function createParser(lines, { indentSize, maxDepth, maxNodes }) {
  let nodeCount = 0;
  const countNode = (line) => {
    nodeCount += 1;
    if (nodeCount > maxNodes) {
      throw new YamlParseError(`YAML document exceeds ${maxNodes} nodes`, { line });
    }
  };

  function requireDepth(depth, line) {
    if (depth > maxDepth) {
      throw new YamlParseError(`YAML document exceeds depth ${maxDepth}`, { line });
    }
  }

  function parseLiteral(start, parentIndent, indicator, lineNumber) {
    let end = start;
    while (end < lines.length) {
      if (!lines[end].blank && lines[end].indent <= parentIndent) break;
      end += 1;
    }
    const body = lines.slice(start, end);
    const nonBlank = body.filter((line) => !line.blank);
    const contentIndent = nonBlank.length > 0
      ? Math.min(...nonBlank.map((line) => line.indent))
      : parentIndent + indentSize;
    if (nonBlank.some((line) => line.indent <= parentIndent)) {
      throw new YamlParseError('Block scalar content must be indented', { line: lineNumber });
    }
    const text = body
      .map((line) => (line.blank ? '' : line.raw.slice(contentIndent)))
      .join('\n');
    if (indicator === '|-') return [text.replace(/\n+$/u, ''), end];
    if (indicator === '|+') return [body.length === 0 ? '' : `${text}\n`, end];
    return [body.length === 0 ? '' : `${text.replace(/\n*$/u, '')}\n`, end];
  }

  function parseMappingPair(target, line, rest, index, depth) {
    const separator = findMappingSeparator(rest);
    if (separator < 0) {
      throw new YamlParseError('Expected a mapping entry', { line: line.line });
    }
    const key = parseKey(rest.slice(0, separator), line.line);
    if (Object.hasOwn(target, key)) {
      throw new YamlParseError(`Duplicate mapping key ${JSON.stringify(key)}`, { line: line.line });
    }
    const valueText = rest.slice(separator + 1).trim();
    countNode(line.line);
    if (valueText === '|' || valueText === '|-' || valueText === '|+') {
      const [value, next] = parseLiteral(index + 1, line.indent, valueText, line.line);
      target[key] = value;
      return next;
    }
    if (valueText.length > 0) {
      target[key] = parseScalar(valueText, line.line);
      return index + 1;
    }
    const child = nextSignificant(lines, index + 1);
    if (child < lines.length && lines[child].indent > line.indent) {
      if (lines[child].indent !== line.indent + indentSize) {
        throw new YamlParseError(`Nested content must be indented by ${indentSize} spaces`, {
          line: lines[child].line,
        });
      }
      const [value, next] = parseNode(child, lines[child].indent, depth + 1);
      target[key] = value;
      return next;
    }
    target[key] = null;
    return index + 1;
  }

  function parseMapping(start, indent, depth, first = null) {
    requireDepth(depth, lines[start]?.line ?? null);
    const value = {};
    countNode(lines[start]?.line ?? null);
    let index = start;
    if (first) {
      index = parseMappingPair(value, first.line, first.rest, first.index, depth);
    }
    while (true) {
      index = nextSignificant(lines, index);
      if (index >= lines.length || lines[index].indent < indent) break;
      const line = lines[index];
      if (line.indent > indent) {
        throw new YamlParseError('Unexpected indentation', { line: line.line });
      }
      if (line.content === '-' || line.content.startsWith('- ')) break;
      index = parseMappingPair(value, line, line.content, index, depth);
    }
    return [value, index];
  }

  function parseSequence(start, indent, depth) {
    requireDepth(depth, lines[start]?.line ?? null);
    const value = [];
    countNode(lines[start]?.line ?? null);
    let index = start;
    while (true) {
      index = nextSignificant(lines, index);
      if (index >= lines.length || lines[index].indent < indent) break;
      const line = lines[index];
      if (line.indent > indent) {
        throw new YamlParseError('Unexpected indentation', { line: line.line });
      }
      if (!(line.content === '-' || line.content.startsWith('- '))) break;
      const rest = line.content.slice(1).trimStart();
      if (rest.length === 0) {
        const child = nextSignificant(lines, index + 1);
        if (child < lines.length && lines[child].indent > indent) {
          if (lines[child].indent !== indent + indentSize) {
            throw new YamlParseError(`Sequence content must be indented by ${indentSize} spaces`, {
              line: lines[child].line,
            });
          }
          const [item, next] = parseNode(child, lines[child].indent, depth + 1);
          value.push(item);
          index = next;
        } else {
          value.push(null);
          index += 1;
        }
        continue;
      }
      const separator = findMappingSeparator(rest);
      if (separator >= 0) {
        const synthetic = {
          line: { ...line, indent: indent + indentSize },
          rest,
          index,
        };
        const [item, next] = parseMapping(index, indent + indentSize, depth + 1, synthetic);
        value.push(item);
        index = next;
      } else {
        countNode(line.line);
        value.push(parseScalar(rest, line.line));
        index += 1;
      }
    }
    return [value, index];
  }

  function parseNode(start, indent, depth) {
    requireDepth(depth, lines[start]?.line ?? null);
    const line = lines[start];
    if (!line || line.indent !== indent) {
      throw new YamlParseError('Invalid indentation', { line: line?.line ?? null });
    }
    return line.content === '-' || line.content.startsWith('- ')
      ? parseSequence(start, indent, depth)
      : parseMapping(start, indent, depth);
  }

  return { parseNode };
}

/** Parse the exact safe subset emitted by stringifyYaml plus literal block scalars. */
export function parseYaml(
  source,
  {
    indent = 2,
    maxBytes = DEFAULT_MAX_BYTES,
    maxDepth = DEFAULT_MAX_DEPTH,
    maxNodes = DEFAULT_MAX_NODES,
  } = {},
) {
  if (typeof source !== 'string') throw new TypeError('YAML source must be a string');
  if (Buffer.byteLength(source, 'utf8') > maxBytes) {
    throw new YamlParseError(`YAML document exceeds ${maxBytes} bytes`);
  }
  if (!Number.isInteger(indent) || indent < 1 || indent > 8) {
    throw new RangeError('indent must be an integer from 1 through 8');
  }
  const lines = tokenize(source);
  let start = nextSignificant(lines, 0);
  if (start >= lines.length) return null;
  if (lines[start].content === '---') start = nextSignificant(lines, start + 1);
  if (start >= lines.length) return null;
  if (lines[start].content.startsWith('%') || lines[start].content === '...') {
    throw new YamlParseError('YAML directives and explicit document endings are not supported', {
      line: lines[start].line,
    });
  }
  if (lines[start].indent !== 0) {
    throw new YamlParseError('Root YAML value must begin at column 1', { line: lines[start].line });
  }
  if (
    !(lines[start].content === '-' || lines[start].content.startsWith('- ')) &&
    findMappingSeparator(lines[start].content) < 0
  ) {
    const value = parseScalar(lines[start].content, lines[start].line);
    const trailing = nextSignificant(lines, start + 1);
    if (trailing < lines.length) {
      throw new YamlParseError('Unexpected trailing YAML content', { line: lines[trailing].line });
    }
    assertYamlValue(value, { maxDepth, maxNodes });
    return value;
  }
  const parser = createParser(lines, {
    indentSize: indent,
    maxDepth,
    maxNodes,
  });
  const [value, end] = parser.parseNode(start, 0, 0);
  const trailing = nextSignificant(lines, end);
  if (trailing < lines.length) {
    throw new YamlParseError('Unexpected trailing YAML content', { line: lines[trailing].line });
  }
  assertYamlValue(value, { maxDepth, maxNodes });
  return value;
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (isPlainObject(value)) return 'object';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function schemaTypes(schema) {
  if (!schema || schema.type == null) return null;
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

function matchesType(value, expected) {
  const actual = valueType(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

function validateNode(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return;
  const types = schemaTypes(schema);
  if (types && !types.some((type) => matchesType(value, type))) {
    errors.push(`${path} must be ${types.join(' or ')}, got ${valueType(value)}`);
    return;
  }
  if (Object.hasOwn(schema, 'const') && !Object.is(value, schema.const)) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${path} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push(`${path} must contain at least ${schema.minLength} characters`);
    }
    if (schema.maxLength != null && value.length > schema.maxLength) {
      errors.push(`${path} must contain at most ${schema.maxLength} characters`);
    }
    if (schema.pattern && !(new RegExp(schema.pattern, 'u')).test(value)) {
      errors.push(`${path} must match /${schema.pattern}/`);
    }
    if (
      schema.format === 'date-time' &&
      (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
        !Number.isFinite(Date.parse(value)))
    ) {
      errors.push(`${path} must be an RFC3339 date-time`);
    }
    if (schema.format === 'sha256' && !/^[a-f0-9]{64}$/u.test(value)) {
      errors.push(`${path} must be a lowercase SHA-256 digest`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) {
      errors.push(`${path} must be >= ${schema.minimum}`);
    }
    if (schema.maximum != null && value > schema.maximum) {
      errors.push(`${path} must be <= ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push(`${path} must contain at least ${schema.minItems} items`);
    }
    if (schema.maxItems != null && value.length > schema.maxItems) {
      errors.push(`${path} must contain at most ${schema.maxItems} items`);
    }
    if (schema.uniqueItems) {
      const seen = new Set();
      for (const item of value) {
        const key = canonicalJson(item);
        if (seen.has(key)) errors.push(`${path} must not contain duplicate items`);
        seen.add(key);
      }
    }
    if (schema.items) {
      value.forEach((item, index) => validateNode(item, schema.items, `${path}[${index}]`, errors));
    }
  }
  if (isPlainObject(value)) {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) errors.push(`${path}.${required} is required`);
    }
    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        validateNode(item, properties[key], `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not allowed`);
      } else if (isPlainObject(schema.additionalProperties)) {
        validateNode(item, schema.additionalProperties, `${path}.${key}`, errors);
      }
    }
  }
  if (typeof schema.validate === 'function') {
    const result = schema.validate(value);
    if (result === false) errors.push(`${path} failed custom validation`);
    else if (typeof result === 'string' && result) errors.push(`${path} ${result}`);
  }
}

/** Validate a parsed value against the supported deterministic schema subset. */
export function validateYamlSchema(value, schema) {
  const errors = [];
  validateNode(value, schema, '$', errors);
  return { valid: errors.length === 0, errors };
}

export function assertYamlSchema(value, schema, { name = 'YAML state' } = {}) {
  const result = validateYamlSchema(value, schema);
  if (!result.valid) throw new YamlSchemaError(result.errors, name);
  return value;
}

export function canonicalJson(value) {
  assertYamlValue(value, { maxDepth: DEFAULT_MAX_DEPTH, maxNodes: DEFAULT_MAX_NODES });
  const normalize = (current) => {
    if (Array.isArray(current)) return current.map(normalize);
    if (!isPlainObject(current)) return current;
    const result = {};
    for (const key of Object.keys(current).sort((a, b) => a.localeCompare(b, 'en'))) {
      result[key] = normalize(current[key]);
    }
    return result;
  };
  return JSON.stringify(normalize(value));
}

export async function readYamlFile(path, { schema = null, ...parseOptions } = {}) {
  const source = await readFile(path, 'utf8');
  const value = parseYaml(source, parseOptions);
  if (schema) assertYamlSchema(value, schema, { name: path });
  return value;
}

/** Atomically persist state without following an existing destination symlink. */
export async function writeYamlFile(
  path,
  value,
  { schema = null, mode = 0o600, ...stringifyOptions } = {},
) {
  if (schema) assertYamlSchema(value, schema, { name: path });
  const source = stringifyYaml(value, stringifyOptions);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.writeFile(source, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return { path, bytes: Buffer.byteLength(source, 'utf8') };
}
