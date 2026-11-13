import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const RUNTIME_TTL_MS = 72 * 60 * 60 * 1_000;
export const RUNTIME_DIRECTORIES = Object.freeze([
  'research',
  'workers',
  'drafts',
  'evidence',
]);
export const RUNTIME_JSON_FILES = Object.freeze([
  'manifest.json',
  'supervisor.json',
  'attestation.json',
]);

const LEGACY_DIRECTORIES = Object.freeze([
  'runs',
  'goal',
  'private-doctor-repos',
  'research',
  'workers',
  'drafts',
  'evidence',
  'archive',
  'archives',
  'retries',
  'retry-ledger',
  'reports',
]);
const LEGACY_SCRATCH_FILE = /^(?:\.supervisor(?:-[A-Za-z0-9]+)?|\.attestation)\.json$/u;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function currentUidOwns(metadata) {
  return typeof process.getuid !== 'function' || metadata.uid === process.getuid();
}

function isPrivateDirectory(metadata) {
  return metadata.isDirectory() &&
    !metadata.isSymbolicLink() &&
    currentUidOwns(metadata) &&
    (metadata.mode & 0o077) === 0;
}

function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new TypeError('Cruise runtime session_id is required');
  }
}

function assertRuntimeFilename(filename) {
  if (!RUNTIME_JSON_FILES.includes(filename)) {
    throw new TypeError(`unsupported Cruise runtime JSON file: ${filename}`);
  }
}

function assertRelativeArtifactPath(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    isAbsolute(path) ||
    path.split(/[\\/]/u).includes('..')
  ) {
    throw new TypeError('runtime artifact path must stay within its session directory');
  }
}

async function ensurePrivateDirectory(path) {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const metadata = await lstat(path);
  if (!isPrivateDirectory(metadata)) {
    throw new Error(`unsafe Cruise runtime directory: ${path}`);
  }
}

async function atomicWrite(path, text) {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, text, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function readRegularJson(path, description) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || !currentUidOwns(metadata)) {
    throw new Error(`unsafe ${description}`);
  }
  return JSON.parse(await readFile(path, 'utf8'));
}

function runtimeManifest({ cwd, sessionId, kind, now, ttlMs }) {
  return {
    version: 1,
    cwd: resolve(cwd),
    session_id: sessionId,
    kind,
    state: 'active',
    created_at: now,
    updated_at: now,
    recovery_expires_at: now + ttlMs,
  };
}

export function runtimeBaseDirectory({
  baseDirectory = join(tmpdir(), 'cruise-runs'),
} = {}) {
  return resolve(baseDirectory);
}

export function workspaceRuntimeDirectory(cwd, options = {}) {
  if (typeof cwd !== 'string' || !cwd) throw new TypeError('Cruise runtime cwd is required');
  return join(runtimeBaseDirectory(options), digest(resolve(cwd)));
}

export async function createRuntimeSession({
  cwd,
  sessionId,
  kind = 'goal',
  now = Date.now(),
  ttlMs = RUNTIME_TTL_MS,
  baseDirectory,
} = {}) {
  if (typeof cwd !== 'string' || !cwd) throw new TypeError('Cruise runtime cwd is required');
  assertSessionId(sessionId);
  if (!Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError('Cruise runtime timestamps must be finite and TTL must be positive');
  }
  const base = runtimeBaseDirectory({ baseDirectory });
  const workspace = workspaceRuntimeDirectory(cwd, { baseDirectory });
  await ensurePrivateDirectory(base);
  await ensurePrivateDirectory(workspace);
  const directory = await mkdtemp(join(workspace, `${digest(sessionId).slice(0, 16)}-`));
  await chmod(directory, 0o700);
  for (const entry of RUNTIME_DIRECTORIES) {
    await mkdir(join(directory, entry), { mode: 0o700 });
  }
  await atomicWrite(
    join(directory, 'manifest.json'),
    `${JSON.stringify(runtimeManifest({ cwd, sessionId, kind, now, ttlMs }), null, 2)}\n`,
  );
  return directory;
}

export async function validateRuntimeDirectory(directory, {
  cwd = null,
  sessionId = null,
  baseDirectory,
} = {}) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) {
    throw new TypeError('Cruise runtime directory must be an absolute path');
  }
  const resolvedDirectory = resolve(directory);
  const base = runtimeBaseDirectory({ baseDirectory });
  const fromBase = relative(base, resolvedDirectory);
  if (!fromBase || fromBase.startsWith(`..${sep}`) || fromBase === '..' || isAbsolute(fromBase)) {
    throw new Error('Cruise runtime directory is outside its managed base');
  }
  const baseMetadata = await lstat(base);
  if (!isPrivateDirectory(baseMetadata)) throw new Error('Cruise runtime base is unsafe');
  const workspace = dirname(resolvedDirectory);
  const workspaceMetadata = await lstat(workspace);
  if (
    dirname(workspace) !== base ||
    !isPrivateDirectory(workspaceMetadata)
  ) {
    throw new Error('Cruise runtime workspace directory is unsafe');
  }
  const metadata = await lstat(resolvedDirectory);
  if (!isPrivateDirectory(metadata)) throw new Error('Cruise runtime directory is unsafe');
  const manifest = await readRegularJson(join(resolvedDirectory, 'manifest.json'), 'Cruise runtime manifest');
  if (
    manifest?.version !== 1 ||
    typeof manifest.cwd !== 'string' ||
    typeof manifest.session_id !== 'string' ||
    typeof manifest.kind !== 'string' ||
    typeof manifest.state !== 'string' ||
    !Number.isFinite(manifest.created_at) ||
    !Number.isFinite(manifest.updated_at) ||
    !Number.isFinite(manifest.recovery_expires_at)
  ) {
    throw new Error('Cruise runtime manifest is malformed');
  }
  if (basename(workspace) !== digest(resolve(manifest.cwd))) {
    throw new Error('Cruise runtime workspace hash does not match its manifest');
  }
  if (cwd !== null && manifest.cwd !== resolve(cwd)) {
    throw new Error('Cruise runtime workspace does not match the active session');
  }
  if (sessionId !== null && manifest.session_id !== sessionId) {
    throw new Error('Cruise runtime session does not match the active session');
  }
  return Object.freeze({ directory: resolvedDirectory, manifest: Object.freeze(manifest) });
}

export async function writeRuntimeJson(directory, filename, value, options = {}) {
  assertRuntimeFilename(filename);
  if (filename === 'manifest.json') {
    throw new TypeError('Cruise runtime manifests are updated only by lifecycle operations');
  }
  const {
    now = Date.now(),
    ttlMs = RUNTIME_TTL_MS,
    ...validation
  } = options;
  const validated = await validateRuntimeDirectory(directory, validation);
  await atomicWrite(join(validated.directory, filename), `${JSON.stringify(value, null, 2)}\n`);
  const manifest = {
    ...validated.manifest,
    updated_at: now,
    recovery_expires_at: now + ttlMs,
  };
  await atomicWrite(
    join(validated.directory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

export async function readRuntimeJson(directory, filename, options = {}) {
  assertRuntimeFilename(filename);
  await validateRuntimeDirectory(directory, options);
  return readRegularJson(join(directory, filename), `Cruise runtime ${filename}`);
}

export async function markRuntimeState(directory, state, {
  now = Date.now(),
  ttlMs = RUNTIME_TTL_MS,
  ...validation
} = {}) {
  if (!['active', 'crashed', 'terminal'].includes(state)) {
    throw new TypeError('unsupported Cruise runtime state');
  }
  const validated = await validateRuntimeDirectory(directory, validation);
  const manifest = {
    ...validated.manifest,
    state,
    updated_at: now,
    recovery_expires_at: now + ttlMs,
  };
  await atomicWrite(join(validated.directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return Object.freeze(manifest);
}

export async function cleanupRuntimeSession(directory, options = {}) {
  const validated = await validateRuntimeDirectory(directory, options);
  await rm(validated.directory, { recursive: true, force: false });
}

export async function janitorRuntimeSessions({
  baseDirectory,
  now = Date.now(),
} = {}) {
  const base = runtimeBaseDirectory({ baseDirectory });
  const result = { removed: [], skipped: [] };
  let workspaces;
  try {
    const metadata = await lstat(base);
    if (!isPrivateDirectory(metadata)) throw new Error('Cruise runtime base is unsafe');
    workspaces = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze(result);
    throw error;
  }
  for (const workspaceEntry of workspaces) {
    if (!workspaceEntry.isDirectory() || workspaceEntry.isSymbolicLink()) continue;
    const workspace = join(base, workspaceEntry.name);
    let sessions;
    try {
      const metadata = await lstat(workspace);
      if (!isPrivateDirectory(metadata)) {
        result.skipped.push(workspace);
        continue;
      }
      sessions = await readdir(workspace, { withFileTypes: true });
    } catch {
      result.skipped.push(workspace);
      continue;
    }
    for (const entry of sessions) {
      const directory = join(workspace, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        result.skipped.push(directory);
        continue;
      }
      try {
        const validated = await validateRuntimeDirectory(directory, { baseDirectory });
        if (validated.manifest.recovery_expires_at > now) continue;
        await rm(validated.directory, { recursive: true, force: false });
        result.removed.push(validated.directory);
      } catch {
        result.skipped.push(directory);
      }
    }
  }
  return Object.freeze({
    removed: Object.freeze(result.removed),
    skipped: Object.freeze(result.skipped),
  });
}

export async function promoteRuntimeArtifact({
  runtimeDirectory: directory,
  relativePath,
  destination,
  baseDirectory,
} = {}) {
  assertRelativeArtifactPath(relativePath);
  if (typeof destination !== 'string' || !isAbsolute(destination)) {
    throw new TypeError('promotion destination must be an absolute path');
  }
  const validated = await validateRuntimeDirectory(directory, { baseDirectory });
  const source = resolve(validated.directory, relativePath);
  const fromRuntime = relative(validated.directory, source);
  if (!fromRuntime || fromRuntime.startsWith(`..${sep}`) || fromRuntime === '..') {
    throw new Error('promotion source is outside the Cruise runtime directory');
  }
  const sourceMetadata = await lstat(source);
  if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
    throw new Error('only regular runtime files may be promoted');
  }
  const target = resolve(destination);
  const fromWorkspace = relative(validated.manifest.cwd, target);
  if (
    !fromWorkspace ||
    fromWorkspace.startsWith(`..${sep}`) ||
    fromWorkspace === '..' ||
    isAbsolute(fromWorkspace)
  ) {
    throw new Error('promotion destination must stay within the registered workspace');
  }
  const parent = dirname(target);
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error('promotion destination parent must be a real directory');
  }
  try {
    const targetMetadata = await lstat(target);
    if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink()) {
      throw new Error('promotion destination must be absent or a regular file');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const [sourceDevice, targetDevice] = await Promise.all([
    stat(source),
    stat(parent),
  ]);
  if (sourceDevice.dev === targetDevice.dev) {
    await rename(source, target);
    return Object.freeze({ method: 'rename', destination: target });
  }
  const temporary = join(parent, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await copyFile(source, temporary);
    await rename(temporary, target);
    await unlink(source);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return Object.freeze({ method: 'copy-rename', destination: target });
}

async function safeRemoveOwnedEntry(path, { recursive = false } = {}) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !currentUidOwns(metadata)) {
      throw new Error(`refusing to remove unsafe Cruise-owned path: ${path}`);
    }
    if (recursive) {
      if (!metadata.isDirectory()) throw new Error(`expected Cruise-owned directory: ${path}`);
      await rm(path, { recursive: true, force: false });
    } else {
      if (!metadata.isFile()) throw new Error(`expected Cruise-owned file: ${path}`);
      await unlink(path);
    }
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function cleanupLegacyCruiseState(cwd) {
  const directory = join(resolve(cwd), '.cruise');
  let entries;
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('.cruise must be a real directory');
    }
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze([]);
    throw error;
  }
  const removed = [];
  for (const name of LEGACY_DIRECTORIES) {
    if (await safeRemoveOwnedEntry(join(directory, name), { recursive: true })) removed.push(name);
  }
  for (const entry of entries) {
    if (!LEGACY_SCRATCH_FILE.test(entry.name)) continue;
    if (await safeRemoveOwnedEntry(join(directory, entry.name))) removed.push(entry.name);
  }
  return Object.freeze(removed);
}

export async function prepareCruiseControlState(cwd, {
  resume = false,
  resetQueue = false,
} = {}) {
  const removed = [...await cleanupLegacyCruiseState(cwd)];
  if (resume) return Object.freeze(removed);
  const directory = join(resolve(cwd), '.cruise');
  for (const name of ['ORIGIN.md', 'FLIGHT.md']) {
    if (await safeRemoveOwnedEntry(join(directory, name))) removed.push(name);
  }
  if (resetQueue && await safeRemoveOwnedEntry(join(directory, 'QUEUE.md'))) {
    removed.push('QUEUE.md');
  }
  return Object.freeze(removed);
}

export async function finalizeCruiseControlState(cwd, {
  status,
  queueComplete = false,
  started = true,
  keepOrigin = false,
  keepFlight = false,
} = {}) {
  if (typeof status !== 'string' || !status) throw new TypeError('terminal status is required');
  const directory = join(resolve(cwd), '.cruise');
  const removed = [...await cleanupLegacyCruiseState(cwd)];
  const retainResume = ['blocked', 'stalled', 'unfinished', 'unassured'].includes(status) ||
    (status === 'failed' && started);
  if (!retainResume) {
    for (const name of [
      ...(keepOrigin ? [] : ['ORIGIN.md']),
      ...(keepFlight ? [] : ['FLIGHT.md']),
    ]) {
      if (await safeRemoveOwnedEntry(join(directory, name))) removed.push(name);
    }
  }
  if (queueComplete && await safeRemoveOwnedEntry(join(directory, 'QUEUE.md'))) {
    removed.push('QUEUE.md');
  }
  return Object.freeze(removed);
}
