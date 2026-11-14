#!/usr/bin/env node
// Offline, bounded retrieval. Native host permissions remain authoritative.
import { lstat, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const TIMEZ = /^\d{8}T\d{9}Z$/u;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const LIMIT = 16_384;
const inside = (root, path) => path === root || path.startsWith(root + sep);
const digest = (text) => createHash('sha256').update(text).digest('hex');

async function read(path, limit = LIMIT) {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error(`File exceeds ${limit} bytes: ${path}`);
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    await file.close();
  }
}

async function latest(session) {
  const entries = await readdir(session, { withFileTypes: true });
  const names = entries.filter((entry) => TIMEZ.test(entry.name)).map((entry) => entry.name).sort();
  if (!names.length) throw new Error('No published checkpoint for this identity');
  return join(session, names.at(-1));
}

export async function checkpoint(root, agent, session) {
  if (!NAME.test(agent) || !NAME.test(session)) throw new Error('Invalid agent/session identity');
  const base = await realpath(root);
  const namespace = join(base, 'agents', agent, session);
  if (await realpath(namespace) !== namespace) throw new Error('Symlinked agent namespace rejected');
  const path = await latest(namespace);
  if (await realpath(path) !== path) throw new Error('Symlinked checkpoint rejected');
  const owned = async (name, limit) => {
    const file = join(path, name);
    if (await realpath(file) !== file) throw new Error('Symlinked checkpoint file rejected');
    return read(file, limit);
  };
  const owner = JSON.parse(await owned('owner.json'));
  if (owner.agent !== agent || owner.session !== session) throw new Error('Checkpoint owner mismatch');
  return { path, namespace, owned };
}

export async function resume(root, agent, session) {
  const current = await checkpoint(root, agent, session);
  const { path, owned, namespace } = current;
  const task = await owned('task.md', 4096);
  const progress = JSON.parse(await owned('progress.json', 4096));
  const manifest = (await owned('context.requirements.txt', 8192)).split('\n').filter((line) => line.trim());
  if (manifest.length > 32) throw new Error('Too many context pointers');
  const excerpts = [];
  for (const line of manifest) {
    const entry = JSON.parse(line);
    if (typeof entry.path !== 'string' || !entry.why?.trim()) throw new Error('Pointer needs path and relevance');
    if (!Number.isInteger(entry.start) || !Number.isInteger(entry.end)
      || entry.start < 1 || entry.end < entry.start || entry.end - entry.start >= 160) {
      throw new Error('Pointer requires a range of 1–160 lines');
    }
    const requested = isAbsolute(entry.path) ? resolve(entry.path) : resolve(path, entry.path);
    const file = await realpath(requested);
    // Reject both lexical and resolved escapes, including symlinks to peer history.
    for (const candidate of [requested, file]) {
      if (candidate.split(sep).includes('agents') && !inside(path, candidate)) {
        throw new Error('Cross-agent, cross-session, or older checkpoint pointer rejected');
      }
    }
    if (!isAbsolute(entry.path) && !inside(path, requested)) throw new Error('Relative pointer escapes checkpoint');
    if (/^_.*\.md$/u.test(basename(file))) throw new Error('Write-only reference rejected');
    const lines = (await read(file, 2_097_152)).split('\n');
    if (entry.end > lines.length) throw new Error('Pointer exceeds source lines');
    const text = lines.slice(entry.start - 1, entry.end).join('\n');
    if (entry.sha256 && entry.sha256 !== digest(text)) throw new Error('Stale context pointer');
    excerpts.push({ path: file, start: entry.start, end: entry.end, why: entry.why, text });
  }
  const output = JSON.stringify({ checkpoint: path, task, progress, excerpts }, null, 2);
  if (Buffer.byteLength(output) > LIMIT) throw new Error('Selected context exceeds 16 KB; narrow the pointers');
  if (await latest(namespace) !== path) throw new Error('Latest checkpoint changed; retry selection');
  return output;
}

export async function index(root, agent, session) {
  const { path, owned, namespace } = await checkpoint(root, agent, session);
  const records = (await owned('conversation.jsonl', 2_097_152)).trimEnd().split('\n');
  const ids = new Set();
  const graph = records.map((line, i) => {
    const message = JSON.parse(line);
    if (!['user', 'assistant', 'tool'].includes(message.role)
      || (message.channel && !['final', 'commentary'].includes(message.channel))
      || typeof message.text !== 'string' || !message.id || ids.has(message.id)) {
      throw new Error('Index only unique, explicitly selected visible conversation records');
    }
    ids.add(message.id);
    return JSON.stringify({ id: message.id, role: message.role, path: 'conversation.jsonl',
      start: i + 1, end: i + 1, reply_to: message.reply_to ?? null,
      labels: message.labels ?? [], preview: message.text.slice(0, 120) });
  }).join('\n') + '\n';
  if (Buffer.byteLength(graph) > 2_097_152) throw new Error('Graph exceeds 2 MB');
  if (await latest(namespace) !== path) throw new Error('Latest checkpoint changed; retry selection');
  const target = join(path, 'conversation.graph.jsonl');
  try {
    if (!(await lstat(target)).isFile()) throw new Error('Non-regular graph rejected');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(target, graph, { flag: 'w' });
  return JSON.stringify({ path: target, records: records.length });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, root, agent, session, ...extra] = process.argv.slice(2);
  try {
    if (!['resume', 'index'].includes(command) || !root || !agent || !session || extra.length) {
      throw new Error('Usage: agent-context.mjs <resume|index> <root> <agent> <session>');
    }
    process.stdout.write(await ({ resume, index })[command](root, agent, session) + '\n');
  } catch (error) {
    process.stderr.write(`Agent context: ${error.message}\n`);
    process.exitCode = 1;
  }
}
