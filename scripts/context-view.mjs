#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  assertReadablePath,
  isSensitivePath,
  sensitiveGitPathspecs,
} from './lib/sensitive-path.mjs';

export const CONTEXT_VISIBLE_BYTES = 12 * 1024;
export const CONTEXT_SLICE_LINES = 160;
export const CONTEXT_SLICE_BYTES = 16 * 1024;
export const CONTEXT_LONG_LINE_BYTES = 1_000;

const COMMANDS = new Set([
  'map',
  'search',
  'slice',
  'symbols',
  'json-summary',
  'table-summary',
  'log-summary',
  'changed',
]);

const EXCLUDED_PATH = /(?:^|\/)(?:\.git|node_modules|vendor|dist|build|coverage|\.next|\.cache|artifacts|datasets?|models?|weights?)(?:\/|$)|\.(?:zip|tar|tgz|gz|7z|bin|png|jpe?g|gif|pdf|csv|tsv|jsonl|ndjson|parquet|arrow|feather|avro|npy|npz|safetensors|pt|pth|ckpt|onnx|h5|log)$/iu;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function git(cwd, args, { allowNoMatch = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !(allowNoMatch && result.status === 1)) {
    throw new Error(String(result.stderr || `git ${args[0]} failed`).trim());
  }
  return String(result.stdout ?? '');
}

function safeRelative(cwd, input) {
  const absolute = resolve(cwd, input);
  const rel = relative(cwd, absolute).split(sep).join('/');
  if (!rel || rel === '..' || rel.startsWith('../')) throw new Error(`path escapes repository: ${input}`);
  return { absolute, relative: rel };
}

function included(path, { explicit = false, explicitSensitivePaths = [] } = {}) {
  if (isSensitivePath(path, { explicitSensitivePaths })) return false;
  return explicit || !EXCLUDED_PATH.test(path);
}

function trackedFiles(cwd, { explicitSensitivePaths = [] } = {}) {
  return git(cwd, ['ls-files', '-z', '--', '.', ...sensitiveGitPathspecs(explicitSensitivePaths)])
    .split('\0')
    .filter(Boolean);
}

function instructionPaths(files, targets = []) {
  const instructions = files.filter((path) => basename(path) === 'AGENTS.md');
  if (targets.length === 0) return instructions;
  return instructions.filter((instruction) => {
    const directory = dirname(instruction) === '.' ? '' : `${dirname(instruction)}/`;
    return targets.some((target) => target === instruction || target.startsWith(directory));
  });
}

async function fileIdentity(cwd, path) {
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', path], {
    cwd,
    encoding: 'utf8',
  }).status === 0;
  if (tracked) {
    return `blob:${git(cwd, ['hash-object', '--', path]).trim()}`;
  }
  const info = await stat(resolve(cwd, path));
  return `stat:${info.mtimeMs}:${info.size}`;
}

async function repositoryIdentity(cwd, paths, { explicitSensitivePaths = [] } = {}) {
  const safe = (paths ?? trackedFiles(cwd, { explicitSensitivePaths }))
    .filter((path) => included(path, { explicitSensitivePaths }));
  const safeSet = new Set(safe);
  const index = git(cwd, ['ls-files', '-s', '--', '.', ...sensitiveGitPathspecs(explicitSensitivePaths)])
    .split('\n')
    .filter((line) => safeSet.has(line.replace(/^\d+\s+[0-9a-f]+\s+\d+\t/u, '')))
    .join('\n');
  const metadata = [];
  for (const path of safe) {
    try {
      const info = await lstat(resolve(cwd, path));
      metadata.push(`${path}\0${info.size}\0${info.mtimeMs}\0${info.mode}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      metadata.push(`${path}\0missing`);
    }
  }
  return `repo:${sha256(`${index}\0${metadata.join('\n')}`)}`;
}

function truncateLine(line, limit = CONTEXT_LONG_LINE_BYTES) {
  const bytes = Buffer.from(line);
  if (bytes.length <= limit) return line;
  return `${bytes.subarray(0, limit - 3).toString('utf8').replace(/\uFFFD$/u, '')}...`;
}

function capUtf8(value, limit) {
  const bytes = Buffer.from(value);
  if (bytes.length <= limit) return { value, truncated: false };
  return {
    value: `${bytes.subarray(0, Math.max(0, limit - 4)).toString('utf8').replace(/\uFFFD$/u, '')}\n...`,
    truncated: true,
  };
}

function visibleContent(raw, cap) {
  const normalized = raw.split('\n').map((line) => truncateLine(line)).join('\n');
  return capUtf8(normalized, cap);
}

function presentationFor(command, raw) {
  if (command !== 'search') return raw;
  const grouped = new Map();
  for (const line of raw.split('\n').filter(Boolean)) {
    const path = line.split(':', 1)[0];
    const values = grouped.get(path) ?? [];
    if (values.length < 20) values.push(line);
    grouped.set(path, values);
  }
  const visible = [...grouped.entries()]
    .slice(0, 40)
    .flatMap(([path, values]) => [`## ${path}`, ...values])
    .join('\n');
  return visible ? `${visible}\n` : '';
}

async function lineScan(path, visit, { stopAfter = Infinity } = {}) {
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let number = 0;
  try {
    for await (const line of lines) {
      number += 1;
      const shouldStop = await visit(line, number);
      if (shouldStop || number >= stopAfter) break;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return number;
}

async function mapCommand(cwd, args, { explicitSensitivePaths = [] } = {}) {
  const files = trackedFiles(cwd, { explicitSensitivePaths });
  const prefixes = args.map((path) => safeRelative(cwd, path).relative);
  for (const path of prefixes) assertReadablePath(path, { explicitSensitivePaths });
  const selected = files.filter((path) => {
    if (!included(path, { explicitSensitivePaths })) return false;
    return prefixes.length === 0 || prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  });
  const lines = [];
  for (const path of selected) {
    const info = await lstat(resolve(cwd, path));
    lines.push(`${path}\t${info.size}`);
  }
  return {
    raw: `${lines.join('\n')}${lines.length ? '\n' : ''}`,
    sources: selected,
    instructions: instructionPaths(files, selected),
    identity: await repositoryIdentity(cwd, selected, { explicitSensitivePaths }),
  };
}

function chunksByArgumentBytes(paths, cap = 96 * 1024) {
  const chunks = [];
  let chunk = [];
  let bytes = 0;
  for (const path of paths) {
    const size = Buffer.byteLength(path) + 1;
    if (chunk.length > 0 && bytes + size > cap) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(path);
    bytes += size;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

async function searchCommand(cwd, args, { explicitSensitivePaths = [] } = {}) {
  const [pattern, ...paths] = args;
  if (!pattern) throw new Error('search requires a pattern');
  const normalized = paths.map((path) => safeRelative(cwd, path).relative);
  for (const path of normalized) assertReadablePath(path, { explicitSensitivePaths });
  const tracked = trackedFiles(cwd, { explicitSensitivePaths });
  const selected = tracked.filter((path) => included(path, { explicitSensitivePaths }) && (
    normalized.length === 0 || normalized.some((item) => path === item || path.startsWith(`${item}/`))
  ));
  const output = chunksByArgumentBytes(selected).map((chunk) => git(cwd, [
    'grep', '-n', '-I', '--full-name', '-e', pattern, '--', ...chunk,
  ], { allowNoMatch: true })).join('');
  const matches = [];
  const sources = new Set();
  for (const line of output.split('\n').filter(Boolean)) {
    const path = line.split(':', 1)[0];
    matches.push(line);
    sources.add(path);
  }
  return {
    raw: `${matches.join('\n')}${matches.length ? '\n' : ''}`,
    sources: [...sources],
    instructions: instructionPaths(tracked, [...sources]),
    identity: await repositoryIdentity(cwd, selected, { explicitSensitivePaths }),
  };
}

async function sliceCommand(cwd, args, { explicitSensitivePaths = [] } = {}) {
  const [input, startRaw = '1', endRaw = null] = args;
  if (!input) throw new Error('slice requires a file');
  const target = safeRelative(cwd, input);
  assertReadablePath(target.relative, { explicitSensitivePaths });
  if (!included(target.relative, { explicit: true, explicitSensitivePaths })) {
    throw new Error(`excluded file requires an explicit compact extractor: ${target.relative}`);
  }
  const start = Number(startRaw);
  const requestedEnd = endRaw == null ? start + CONTEXT_SLICE_LINES - 1 : Number(endRaw);
  if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(requestedEnd) || requestedEnd < start) {
    throw new TypeError('slice range must be positive integers');
  }
  const end = Math.min(requestedEnd, start + CONTEXT_SLICE_LINES - 1);
  const lines = [];
  let bytes = 0;
  await lineScan(target.absolute, (line, number) => {
    if (number < start) return false;
    if (number > end) return true;
    const rendered = `${number}: ${line}\n`;
    const size = Buffer.byteLength(rendered);
    if (bytes + size > CONTEXT_SLICE_BYTES) {
      const remaining = CONTEXT_SLICE_BYTES - bytes;
      if (remaining >= 4) {
        const bounded = capUtf8(rendered, remaining).value;
        bytes += Buffer.byteLength(bounded);
        lines.push(bounded);
      }
      return true;
    }
    bytes += size;
    lines.push(rendered);
    return false;
  }, { stopAfter: end + 1 });
  return {
    raw: lines.join(''),
    sources: [target.relative],
    instructions: instructionPaths(trackedFiles(cwd, { explicitSensitivePaths }), [target.relative]),
    identity: await fileIdentity(cwd, target.relative),
  };
}

async function symbolsCommand(cwd, args, { explicitSensitivePaths = [] } = {}) {
  const [input] = args;
  if (!input) throw new Error('symbols requires a file');
  const target = safeRelative(cwd, input);
  assertReadablePath(target.relative, { explicitSensitivePaths });
  const matches = [];
  const pattern = /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|def|struct|enum)\s+([A-Za-z_$][\w$]*)/u;
  await lineScan(target.absolute, (line, number) => {
    const match = line.match(pattern);
    if (match) matches.push(`${number}\t${match[1]}\t${line.trim()}`);
    return false;
  });
  return {
    raw: `${matches.join('\n')}${matches.length ? '\n' : ''}`,
    sources: [target.relative],
    instructions: instructionPaths(trackedFiles(cwd, { explicitSensitivePaths }), [target.relative]),
    identity: await fileIdentity(cwd, target.relative),
  };
}

function summarizeJson(value, depth = 0) {
  if (depth >= 4) return Array.isArray(value) ? `array(${value.length})` : typeof value;
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length, sample: value.slice(0, 3).map((item) => summarizeJson(item, depth + 1)) };
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, child]) => [key, summarizeJson(child, depth + 1)]));
  }
  return value === null ? 'null' : typeof value;
}

async function jsonSummaryCommand(cwd, args, { explicitSensitivePaths = [] } = {}) {
  const [input] = args;
  if (!input) throw new Error('json-summary requires a file');
  const target = safeRelative(cwd, input);
  assertReadablePath(target.relative, { explicitSensitivePaths });
  const value = JSON.parse(await readFile(target.absolute, 'utf8'));
  return {
    raw: `${JSON.stringify(summarizeJson(value), null, 2)}\n`,
    sources: [target.relative],
    instructions: instructionPaths(trackedFiles(cwd, { explicitSensitivePaths }), [target.relative]),
    identity: await fileIdentity(cwd, target.relative),
  };
}

async function tableSummaryCommand(cwd, args, { explicitSensitivePaths = [] } = {}) {
  const [input] = args;
  if (!input) throw new Error('table-summary requires a file');
  const target = safeRelative(cwd, input);
  assertReadablePath(target.relative, { explicitSensitivePaths });
  let rows = 0;
  let columns = 0;
  let delimiter = ',';
  let header = [];
  await lineScan(target.absolute, (line, number) => {
    if (number === 1) {
      delimiter = line.includes('\t') ? '\t' : ',';
      header = line.split(delimiter);
      columns = header.length;
    } else {
      rows += 1;
      columns = Math.max(columns, line.split(delimiter).length);
    }
    return false;
  });
  const raw = `${JSON.stringify({ delimiter: delimiter === '\t' ? 'tab' : 'comma', rows, columns, header }, null, 2)}\n`;
  return {
    raw,
    sources: [target.relative],
    instructions: instructionPaths(trackedFiles(cwd, { explicitSensitivePaths }), [target.relative]),
    identity: await fileIdentity(cwd, target.relative),
  };
}

async function logSummaryCommand(cwd, args, { explicitSensitivePaths = [] } = {}) {
  const [input] = args;
  if (!input) throw new Error('log-summary requires a file');
  const target = safeRelative(cwd, input);
  assertReadablePath(target.relative, { explicitSensitivePaths });
  const counts = { error: 0, warn: 0, info: 0 };
  let lines = 0;
  let first = '';
  let last = '';
  await lineScan(target.absolute, (line, number) => {
    lines = number;
    if (number === 1) first = truncateLine(line);
    last = truncateLine(line);
    if (/\berror\b/iu.test(line)) counts.error += 1;
    if (/\bwarn(?:ing)?\b/iu.test(line)) counts.warn += 1;
    if (/\binfo\b/iu.test(line)) counts.info += 1;
    return false;
  });
  return {
    raw: `${JSON.stringify({ lines, counts, first, last }, null, 2)}\n`,
    sources: [target.relative],
    instructions: instructionPaths(trackedFiles(cwd, { explicitSensitivePaths }), [target.relative]),
    identity: await fileIdentity(cwd, target.relative),
  };
}

async function changedCommand(cwd, _args, { explicitSensitivePaths = [] } = {}) {
  const output = git(cwd, ['status', '--short', '--', '.', ...sensitiveGitPathspecs(explicitSensitivePaths)]);
  const lines = output.split('\n').filter((line) => {
    const path = line.slice(3).replace(/^"|"$/gu, '');
    return included(path, { explicitSensitivePaths });
  });
  return {
    raw: `${lines.join('\n')}${lines.length ? '\n' : ''}`,
    sources: lines.map((line) => line.slice(3)),
    instructions: instructionPaths(
      trackedFiles(cwd, { explicitSensitivePaths }),
      lines.map((line) => line.slice(3)),
    ),
    identity: await repositoryIdentity(
      cwd,
      trackedFiles(cwd, { explicitSensitivePaths }),
      { explicitSensitivePaths },
    ),
  };
}

const HANDLERS = Object.freeze({
  map: mapCommand,
  search: searchCommand,
  slice: sliceCommand,
  symbols: symbolsCommand,
  'json-summary': jsonSummaryCommand,
  'table-summary': tableSummaryCommand,
  'log-summary': logSummaryCommand,
  changed: changedCommand,
});

async function cachedResult(cwd, cacheKey) {
  const cachePath = resolve(cwd, '.cruise', 'context-cache', `${cacheKey}.json`);
  try {
    const cached = JSON.parse(await readFile(cachePath, 'utf8'));
    const raw = await readFile(cached.artifact_path, 'utf8');
    if (sha256(raw) !== cached.content_digest) return null;
    return { cachePath, cached, raw };
  } catch {
    return null;
  }
}

export async function runContextView({
  cwd = process.cwd(),
  command,
  args = [],
  visibleBytes = CONTEXT_VISIBLE_BYTES,
  explicitSensitivePaths = [],
} = {}) {
  if (!COMMANDS.has(command)) throw new Error(`unknown context-view command: ${String(command)}`);
  if (!Number.isSafeInteger(visibleBytes) || visibleBytes < 1 || visibleBytes > CONTEXT_VISIBLE_BYTES) {
    throw new TypeError('visibleBytes must be an integer from 1 through 12288');
  }
  const root = resolve(cwd);
  if (!Array.isArray(explicitSensitivePaths) || explicitSensitivePaths.some((path) => typeof path !== 'string')) {
    throw new TypeError('explicitSensitivePaths must be an array of repository-relative paths');
  }
  const initial = await HANDLERS[command](root, args, { explicitSensitivePaths });
  const cacheKey = sha256(JSON.stringify({ command, args, explicitSensitivePaths, identity: initial.identity }));
  const hit = await cachedResult(root, cacheKey);
  let raw = initial.raw;
  let artifactPath;
  let cacheHit = false;
  if (hit) {
    raw = hit.raw;
    artifactPath = hit.cached.artifact_path;
    cacheHit = true;
  } else {
    const artifactDirectory = resolve(root, '.cruise', 'artifacts');
    const cacheDirectory = resolve(root, '.cruise', 'context-cache');
    await mkdir(artifactDirectory, { recursive: true });
    await mkdir(cacheDirectory, { recursive: true });
    artifactPath = resolve(artifactDirectory, `context-view-${command}-${cacheKey.slice(0, 16)}.raw`);
    await writeFile(artifactPath, raw, { encoding: 'utf8', mode: 0o600 });
    await writeFile(resolve(cacheDirectory, `${cacheKey}.json`), `${JSON.stringify({
      artifact_path: artifactPath,
      content_digest: sha256(raw),
    })}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  const visible = visibleContent(presentationFor(command, raw), Math.min(visibleBytes, 10 * 1024));
  const rtk = spawnSync('rtk', ['--version'], { encoding: 'utf8', timeout: 1_000 });
  return Object.freeze({
    schema_version: 1,
    command,
    content: visible.value,
    content_digest: sha256(raw),
    raw_bytes: Buffer.byteLength(raw),
    visible_bytes: Buffer.byteLength(visible.value),
    truncated: visible.truncated,
    artifact_path: artifactPath,
    cache_key: cacheKey,
    cache_hit: cacheHit,
    instruction_paths: initial.instructions.slice(0, 10).map((path) => truncateLine(path, 256)),
    source_count: initial.sources.length,
    sources: initial.sources.slice(0, 20).map((path) => truncateLine(path, 256)),
    sources_truncated: initial.sources.length > 20,
    rtk_available: rtk.status === 0,
  });
}

function parseCli(argv) {
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === '-h') {
    return { help: true, command: null, args: [] };
  }
  return { help: false, command, args };
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCli(argv);
  if (parsed.help) {
    process.stdout.write('Usage: node scripts/context-view.mjs <map|search|slice|symbols|json-summary|table-summary|log-summary|changed> [args...]\n');
    return 0;
  }
  const result = await runContextView(parsed);
  let rendered = result;
  let output = `${JSON.stringify(rendered)}\n`;
  if (Buffer.byteLength(output) > CONTEXT_VISIBLE_BYTES) {
    const metadataBytes = Buffer.byteLength(`${JSON.stringify({ ...result, content: '' })}\n`);
    const available = Math.max(0, CONTEXT_VISIBLE_BYTES - metadataBytes - 8);
    const recapped = capUtf8(result.content, available);
    rendered = {
      ...result,
      content: recapped.value,
      visible_bytes: Buffer.byteLength(recapped.value),
      truncated: true,
    };
    output = `${JSON.stringify(rendered)}\n`;
  }
  if (Buffer.byteLength(output) > CONTEXT_VISIBLE_BYTES) throw new Error('context-view metadata exceeded the visible output cap');
  process.stdout.write(output);
  return 0;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`context-view: ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  });
}
