import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  cleanupRuntimeSession,
  createRuntimeSession,
  janitorRuntimeSessions,
  markRuntimeState,
  validateRuntimeDirectory,
} from '../scripts/lib/runtime-state.mjs';

const DIRECTORY = join(tmpdir(), 'cruise-goal-sessions');
export const MAX_WORKSPACE_LOCK_AGE_MS = 24 * 60 * 60 * 1_000;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function markerPath({ cwd, session_id: sessionId }) {
  if (typeof cwd !== 'string' || !cwd || typeof sessionId !== 'string' || !sessionId) {
    return null;
  }
  return join(DIRECTORY, `${digest(`${resolve(cwd)}\u0000${sessionId}`)}.json`);
}

function workspaceMarkerPath({ cwd }) {
  if (typeof cwd !== 'string' || !cwd) return null;
  return join(DIRECTORY, `${digest(resolve(cwd))}.workspace.json`);
}

function safeDirectory(metadata) {
  return metadata.isDirectory() &&
    !metadata.isSymbolicLink() &&
    (typeof process.getuid !== 'function' || metadata.uid === process.getuid()) &&
    (metadata.mode & 0o077) === 0;
}

async function ensureMarkerDirectory() {
  await mkdir(DIRECTORY, { recursive: true, mode: 0o700 });
  const metadata = await lstat(DIRECTORY);
  if (!safeDirectory(metadata)) {
    throw new Error('Cruise Goal session marker directory is unsafe');
  }
}

async function readSafeMarker(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Cruise Goal session marker is unsafe');
  }
  return JSON.parse(await readFile(path, 'utf8'));
}

async function atomicReplace(path, payload) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(payload)}\n`, {
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

async function acquireWorkspace(input, now = Date.now(), baseDirectory) {
  const path = workspaceMarkerPath(input);
  const payload = {
    version: 2,
    cwd: resolve(input.cwd),
    session_id: input.session_id,
    activated_at: now,
    runtime_dir: null,
  };
  try {
    await writeFile(path, `${JSON.stringify(payload)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    return payload;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const current = await readSafeMarker(path);
  if (
    [1, 2].includes(current?.version) &&
    current.cwd === payload.cwd &&
    current.session_id === payload.session_id
  ) {
    const refreshed = {
      ...payload,
      runtime_dir: typeof current.runtime_dir === 'string' ? current.runtime_dir : null,
    };
    await atomicReplace(path, refreshed);
    return refreshed;
  }
  if (
    [1, 2].includes(current?.version) &&
    current.cwd === payload.cwd &&
    Number.isSafeInteger(current.activated_at) &&
    now - current.activated_at > MAX_WORKSPACE_LOCK_AGE_MS
  ) {
    if (typeof current.runtime_dir === 'string') {
      await cleanupRuntimeSession(current.runtime_dir, {
        cwd: current.cwd,
        sessionId: current.session_id,
        baseDirectory,
      }).catch(() => {});
    }
    await unlink(path);
    return acquireWorkspace(input, now, baseDirectory);
  }
  const conflict = new Error(
    'Another Cruise run is already active in this workspace; resume or finish it before starting another.',
  );
  conflict.code = 'CRUISE_GOAL_CONFLICT';
  throw conflict;
}

export async function reserveCruiseWorkspace(input, {
  now = Date.now(),
  baseDirectory,
} = {}) {
  if (!workspaceMarkerPath(input) || typeof input?.session_id !== 'string' || !input.session_id) {
    return false;
  }
  await ensureMarkerDirectory();
  await janitorRuntimeSessions({ baseDirectory, now });
  const workspace = await acquireWorkspace(input, now, baseDirectory);
  let runtimeDirectory = workspace.runtime_dir;
  try {
    if (runtimeDirectory) {
      await validateRuntimeDirectory(runtimeDirectory, {
        cwd: input.cwd,
        sessionId: input.session_id,
        baseDirectory,
      });
      await markRuntimeState(runtimeDirectory, 'active', {
        cwd: input.cwd,
        sessionId: input.session_id,
        baseDirectory,
        now,
      });
    } else {
      runtimeDirectory = await createRuntimeSession({
        cwd: input.cwd,
        sessionId: input.session_id,
        now,
        baseDirectory,
      });
      await atomicReplace(workspaceMarkerPath(input), {
        ...workspace,
        runtime_dir: runtimeDirectory,
      });
    }
  } catch (error) {
    await releaseCruiseWorkspace(input, { baseDirectory }).catch(() => {});
    throw error;
  }
  return runtimeDirectory;
}

export async function activateGoalSession(input, {
  now = Date.now(),
  baseDirectory,
} = {}) {
  const path = markerPath(input);
  if (!path) return false;
  try {
    const runtimeDirectory = await reserveCruiseWorkspace(input, { now, baseDirectory });
    await atomicReplace(path, {
      version: 2,
      cwd: resolve(input.cwd),
      session_id: input.session_id,
      activated_at: now,
      runtime_dir: runtimeDirectory,
    });
  } catch (error) {
    await deactivateGoalSession(input, { baseDirectory }).catch(() => {});
    throw error;
  }
  return true;
}

export async function isGoalSessionActive(input) {
  const path = markerPath(input);
  if (!path) return false;
  try {
    const directoryMetadata = await lstat(DIRECTORY);
    if (!safeDirectory(directoryMetadata)) return false;
    const markerMetadata = await lstat(path);
    if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()) return false;
    const marker = JSON.parse(await readFile(path, 'utf8'));
    const workspace = await readSafeMarker(workspaceMarkerPath(input));
    return marker?.version === 2 &&
      marker.cwd === resolve(input.cwd) &&
      marker.session_id === input.session_id &&
      typeof marker.runtime_dir === 'string' &&
      workspace?.version === 2 &&
      workspace.cwd === marker.cwd &&
      workspace.session_id === marker.session_id &&
      workspace.runtime_dir === marker.runtime_dir &&
      Boolean(await validateRuntimeDirectory(marker.runtime_dir, {
        cwd: input.cwd,
        sessionId: input.session_id,
      }));
  } catch {
    return false;
  }
}

export async function runtimeSessionDirectory(input, { baseDirectory } = {}) {
  const path = markerPath(input);
  if (!path) return null;
  const marker = await readSafeMarker(path);
  if (
    marker?.version !== 2 ||
    marker.cwd !== resolve(input.cwd) ||
    marker.session_id !== input.session_id ||
    typeof marker.runtime_dir !== 'string'
  ) {
    throw new Error('Cruise Goal session marker does not identify a runtime directory');
  }
  await validateRuntimeDirectory(marker.runtime_dir, {
    cwd: input.cwd,
    sessionId: input.session_id,
    baseDirectory,
  });
  return marker.runtime_dir;
}

export async function deactivateGoalSession(input, { baseDirectory } = {}) {
  const path = markerPath(input);
  if (!path) return;
  await unlink(path).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  await releaseCruiseWorkspace(input, { baseDirectory });
}

export async function releaseCruiseWorkspace(input, {
  baseDirectory,
  preserveRuntime = false,
} = {}) {
  if (!workspaceMarkerPath(input) || typeof input?.session_id !== 'string' || !input.session_id) {
    return;
  }
  const workspacePath = workspaceMarkerPath(input);
  try {
    const workspace = await readSafeMarker(workspacePath);
    if (
      [1, 2].includes(workspace?.version) &&
      workspace.cwd === resolve(input.cwd) &&
      workspace.session_id === input.session_id
    ) {
      await unlink(workspacePath);
      if (!preserveRuntime && typeof workspace.runtime_dir === 'string') {
        await cleanupRuntimeSession(workspace.runtime_dir, {
          cwd: input.cwd,
          sessionId: input.session_id,
          baseDirectory,
        });
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
