import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { resolveCodexHome } from './agent-config.mjs';

export const PLUGIN_DIGEST_ROOTS = Object.freeze([
  '.codex-plugin/plugin.json',
  'package.json',
  'skills',
  'internal',
  'scripts',
  'fixtures',
  'tests',
]);

export const FORBIDDEN_PLUGIN_RUNTIME_PATHS = Object.freeze(['.mcp.json']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function freezeEntries(entries) {
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

async function collectEntry(root, relativePath, entries) {
  const path = join(root, relativePath);
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`plugin digest refuses symlink ${relativePath}`);
  }
  if (metadata.isDirectory()) {
    const children = await readdir(path, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const child of children) {
      await collectEntry(root, join(relativePath, child.name), entries);
    }
    return;
  }
  if (!metadata.isFile()) {
    throw new Error(`plugin digest requires a regular file at ${relativePath}`);
  }
  const bytes = await readFile(path);
  entries.push({ path: relativePath.split(sep).join('/'), sha256: sha256(bytes), bytes: bytes.length });
}

export async function digestPluginRuntime(root, { roots = PLUGIN_DIGEST_ROOTS } = {}) {
  const requestedRoot = resolve(root);
  const rootMetadata = await lstat(requestedRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`plugin digest root must be a real directory: ${requestedRoot}`);
  }
  const resolvedRoot = await realpath(requestedRoot);
  for (const relativePath of FORBIDDEN_PLUGIN_RUNTIME_PATHS) {
    const metadata = await lstat(join(resolvedRoot, relativePath)).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (metadata) {
      throw new Error(`plugin digest refuses retired runtime surface ${relativePath}`);
    }
  }
  const entries = [];
  for (const relativePath of roots) await collectEntry(resolvedRoot, relativePath, entries);
  entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const aggregate = createHash('sha256');
  aggregate.update('cruise-plugin-runtime-v1\0');
  for (const entry of entries) {
    aggregate.update(entry.path);
    aggregate.update('\0');
    aggregate.update(entry.sha256);
    aggregate.update('\0');
  }
  return Object.freeze({
    algorithm: 'sha256',
    digest: aggregate.digest('hex'),
    file_count: entries.length,
    byte_count: entries.reduce((total, entry) => total + entry.bytes, 0),
    entries: freezeEntries(entries),
  });
}

export function resolvePluginCacheRoot({ codexHome = null, version }) {
  if (typeof version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/u.test(version)) {
    throw new TypeError('plugin version must be one safe cache-path segment');
  }
  return join(resolveCodexHome(codexHome), 'plugins', 'cache', 'agent-local', 'cruise', version);
}

async function assertInstalledCacheIdentity({ sourceRoot, cacheRoot, codexHome }) {
  const home = resolveCodexHome(codexHome);
  const version = relative(
    join(home, 'plugins', 'cache', 'agent-local', 'cruise'),
    resolve(cacheRoot),
  );
  const expected = resolvePluginCacheRoot({ codexHome, version });
  if (resolve(cacheRoot) !== expected) {
    throw new Error('installed plugin cache path is outside its exact Cruise version directory');
  }
  let current = home;
  for (const component of ['plugins', 'cache', 'agent-local', 'cruise', version]) {
    current = join(current, component);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(`installed plugin cache path refuses symlink component ${current}`);
    }
  }
  const [canonicalSource, canonicalCache, canonicalBase] = await Promise.all([
    realpath(sourceRoot),
    realpath(cacheRoot),
    realpath(join(home, 'plugins', 'cache', 'agent-local', 'cruise')),
  ]);
  if (canonicalSource === canonicalCache) {
    throw new Error('installed plugin cache must be distinct from the source runtime');
  }
  if (!isPathInside(canonicalBase, canonicalCache)) {
    throw new Error('installed plugin cache resolves outside the canonical Cruise cache base');
  }
}

function compareEntries(sourceEntries, cacheEntries) {
  const source = new Map(sourceEntries.map((entry) => [entry.path, entry.sha256]));
  const cache = new Map(cacheEntries.map((entry) => [entry.path, entry.sha256]));
  const missing = [...source.keys()].filter((path) => !cache.has(path)).sort();
  const extra = [...cache.keys()].filter((path) => !source.has(path)).sort();
  const changed = [...source.keys()]
    .filter((path) => cache.has(path) && source.get(path) !== cache.get(path))
    .sort();
  return { missing, extra, changed };
}

export async function inspectPluginCache({
  sourceRoot,
  cacheRoot,
  roots = PLUGIN_DIGEST_ROOTS,
  enforceInstalledIdentity = false,
  codexHome = null,
} = {}) {
  for (const root of [sourceRoot, cacheRoot]) {
    const requestedRoot = resolve(root);
    const metadata = await lstat(requestedRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`plugin digest root must be a real directory: ${requestedRoot}`);
    }
  }
  const [canonicalSource, canonicalCache] = await Promise.all([
    realpath(sourceRoot),
    realpath(cacheRoot),
  ]);
  if (canonicalSource === canonicalCache) {
    throw new Error('plugin cache digest refuses to compare the source runtime with itself');
  }
  if (enforceInstalledIdentity) {
    await assertInstalledCacheIdentity({ sourceRoot, cacheRoot, codexHome });
  }
  const [source, cache] = await Promise.all([
    digestPluginRuntime(sourceRoot, { roots }),
    digestPluginRuntime(cacheRoot, { roots }),
  ]);
  const differences = compareEntries(source.entries, cache.entries);
  const matches = source.digest === cache.digest
    && differences.missing.length === 0
    && differences.extra.length === 0
    && differences.changed.length === 0;
  return Object.freeze({
    matches,
    source,
    cache,
    missing: Object.freeze(differences.missing),
    extra: Object.freeze(differences.extra),
    changed: Object.freeze(differences.changed),
  });
}

export function pluginDigestDetail(inspection, { limit = 12 } = {}) {
  if (inspection.matches) {
    return `${inspection.source.digest} (${inspection.source.file_count} files, source equals installed cache)`;
  }
  const labels = [
    ...inspection.changed.map((path) => `changed:${path}`),
    ...inspection.missing.map((path) => `missing:${path}`),
    ...inspection.extra.map((path) => `extra:${path}`),
  ];
  const visible = labels.slice(0, limit);
  const omitted = labels.length - visible.length;
  return [
    `source ${inspection.source.digest} != cache ${inspection.cache.digest}`,
    visible.join(', '),
    omitted > 0 ? `and ${omitted} more difference(s)` : null,
  ].filter(Boolean).join('; ');
}

export function isPathInside(root, candidate) {
  const difference = relative(resolve(root), resolve(candidate));
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..');
}
