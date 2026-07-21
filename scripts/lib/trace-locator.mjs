import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const MAX_TRACE_DIRECTORIES = 512;

export function codexHome(env = process.env) {
  return typeof env?.CODEX_HOME === 'string' && env.CODEX_HOME.length > 0
    ? resolve(env.CODEX_HOME)
    : join(homedir(), '.codex');
}

export function codexSessionsDirectory(home = codexHome()) {
  return join(home, 'sessions');
}

function localDateDirectory(root, value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return join(
    root,
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  );
}

async function entries(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return null;
  }
}

async function findInDirectory(path, suffix) {
  const listing = await entries(path);
  if (listing === null) return null;
  const match = listing.find((entry) => entry.isFile() && entry.name.endsWith(suffix));
  return match ? join(path, match.name) : null;
}

export async function locateRollout(threadId, {
  home = codexHome(),
  now = new Date(),
  maxDirectories = MAX_TRACE_DIRECTORIES,
} = {}) {
  try {
    if (
      typeof threadId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(threadId) ||
      !Number.isInteger(maxDirectories) ||
      maxDirectories < 1
    ) return null;
    const root = codexSessionsDirectory(home);
    const current = new Date(now);
    if (Number.isNaN(current.getTime())) return null;
    const previous = new Date(current);
    previous.setDate(previous.getDate() - 1);
    const preferred = [
      localDateDirectory(root, current),
      localDateDirectory(root, previous),
    ].filter(Boolean);
    const suffix = `-${threadId}.jsonl`;
    let examined = 0;
    const visited = new Set();
    for (const directory of preferred) {
      if (examined >= maxDirectories) return null;
      examined += 1;
      visited.add(directory);
      const match = await findInDirectory(directory, suffix);
      if (match) return match;
    }

    // One bounded widening pass. Directory names and timestamps are discovered
    // from disk; the rollout filename is never synthesized.
    const queue = [root];
    while (queue.length) {
      const directory = queue.shift();
      if (visited.has(directory)) continue;
      if (examined >= maxDirectories) return null;
      examined += 1;
      visited.add(directory);
      const listing = await entries(directory);
      if (listing === null) continue;
      for (const entry of listing) {
        const path = join(directory, entry.name);
        if (entry.isFile() && entry.name.endsWith(suffix)) return path;
        if (entry.isDirectory()) queue.push(path);
      }
    }
    return null;
  } catch {
    return null;
  }
}
