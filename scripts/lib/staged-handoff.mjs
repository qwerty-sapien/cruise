import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const MAX_BYTES = 8192;
const LISTS = ['completed', 'remaining', 'decisions', 'evidence', 'ownership'];
const KEYS = ['version', 'session_id', 'thread_id', 'workspace', 'parent_relinquished', ...LISTS];

function fail(message) {
  throw new Error(`Staged handoff: ${message}`);
}

function safeString(value) {
  return typeof value === 'string' && value.trim().length > 0
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function aborted(signal) {
  if (signal.aborted) {
    if (signal.reason instanceof Error) throw signal.reason;
    const error = new Error('Staged handoff cancelled', { cause: signal.reason });
    error.name = 'AbortError';
    throw error;
  }
}

async function absent(file) {
  try {
    await lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  fail(`refusing preexisting file: ${file}`);
}

async function externalPath(file, workspace) {
  if (typeof file !== 'string' || !isAbsolute(file) || !file.endsWith('.json')) {
    fail('ready and capsule paths must be absolute .json paths');
  }
  // Resolve existing parents before checking containment, including parent symlinks.
  const canonical = resolve(await realpath(dirname(file)), basename(file));
  const inside = relative(workspace, canonical);
  if (inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))) {
    fail('ready and capsule files must be outside the workspace');
  }
  return canonical;
}

function delay(ms, signal) {
  return new Promise((resolveDelay, reject) => {
    let timer;
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      try {
        aborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolveDelay();
    }, ms);
    if (signal.aborted) cancel();
  });
}

async function readCapsule(file, marker, minimumMtime) {
  let before;
  try {
    before = await lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail('capsule must be a regular, unlinked file');
  if (before.size > MAX_BYTES) fail(`capsule exceeds ${MAX_BYTES} bytes`);
  if (before.mtimeMs < minimumMtime) fail('stale capsule predates readiness');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const current = await handle.stat();
    if (current.dev !== before.dev || current.ino !== before.ino || !current.isFile() || current.nlink !== 1) fail('capsule changed while opening');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) fail(`capsule exceeds ${MAX_BYTES} bytes`);
    const after = await handle.stat();
    const pathAfter = await lstat(file);
    if (after.nlink !== 1 || after.size !== bytesRead || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.isSymbolicLink()) {
      fail('capsule changed while reading; publish it atomically');
    }
    bytes = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  let capsule;
  try {
    capsule = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('capsule must contain valid UTF-8 JSON');
  }
  if (!capsule || typeof capsule !== 'object' || Array.isArray(capsule)
    || Object.keys(capsule).length !== KEYS.length || KEYS.some((key) => !Object.hasOwn(capsule, key))) {
    fail('capsule has an invalid schema');
  }
  if (capsule.version !== 1 || capsule.parent_relinquished !== true) fail('version 1 and parent_relinquished:true are required');
  if (capsule.session_id !== marker.session_id || capsule.thread_id !== marker.thread_id
    || capsule.workspace !== marker.workspace) fail('capsule session, thread, or workspace does not match readiness');
  for (const key of LISTS) {
    if (!Array.isArray(capsule[key]) || !capsule[key].every(safeString)) fail(`${key} must be an array of safe nonempty strings`);
  }
  return capsule;
}

/** A one-shot transport/thread readiness barrier; no repository files are opened. */
export function createStagedHandoff({ readyFile, handoffFile, sessionId = randomUUID(), pollMs = 250,
  heartbeatMs = 120000, onHeartbeat } = {}) {
  if (!safeString(sessionId)) fail('sessionId must be a nonempty safe string');
  if (!Number.isFinite(pollMs) || pollMs < 1 || pollMs > 120000) fail('pollMs must be between 1 and 120000');
  if (!Number.isFinite(heartbeatMs) || heartbeatMs < 1 || heartbeatMs > 120000) fail('heartbeatMs must be between 1 and 120000');
  if (onHeartbeat !== undefined && typeof onHeartbeat !== 'function') fail('onHeartbeat must be a function');
  const controller = new AbortController();
  let started = false;
  let owned;

  async function removeReady() {
    if (!owned) return;
    const saved = owned;
    let handle;
    try {
      const stat = await lstat(saved.path);
      if (stat.dev !== saved.dev || stat.ino !== saved.ino || !stat.isFile() || stat.isSymbolicLink()) return;
      handle = await open(saved.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const current = await handle.stat();
      if (current.dev !== saved.dev || current.ino !== saved.ino || current.size !== Buffer.byteLength(saved.text)) return;
      const buffer = Buffer.alloc(Buffer.byteLength(saved.text) + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (buffer.subarray(0, bytesRead).toString('utf8') !== saved.text) return;
      const final = await lstat(saved.path);
      if (final.dev === saved.dev && final.ino === saved.ino) await unlink(saved.path);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ELOOP') throw error;
    } finally {
      if (handle) await handle.close();
    }
  }

  return {
    async wait({ threadId, cwd, signal } = {}) {
      if (started) fail('wait may only be called once');
      started = true;
      if (!safeString(threadId)) fail('threadId must be a nonempty safe string');
      const cancel = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      try {
        aborted(controller.signal);
        const workspace = await realpath(cwd);
        const ready = await externalPath(readyFile, workspace);
        const handoff = await externalPath(handoffFile, workspace);
        if (ready === handoff) fail('ready and capsule paths must be distinct');
        await absent(ready);
        await absent(handoff);
        aborted(controller.signal);
        const marker = { version: 1, state: 'ready', session_id: sessionId, thread_id: threadId,
          workspace, capsule_file: handoff, created_at: new Date().toISOString() };
        const text = `${JSON.stringify(marker)}\n`;
        const handle = await open(ready, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        let minimumMtime;
        try {
          const stat = await handle.stat();
          owned = { path: ready, dev: stat.dev, ino: stat.ino, text };
          await handle.writeFile(text);
          minimumMtime = (await handle.stat()).mtimeMs;
        } finally {
          await handle.close();
        }
        let heartbeatAt = Date.now() + heartbeatMs;
        while (true) {
          aborted(controller.signal);
          const capsule = await readCapsule(handoff, marker, minimumMtime);
          aborted(controller.signal);
          if (capsule) {
            return 'Parent handoff (bounded data; referenced files have not been read):\n'
              + `${JSON.stringify(capsule)}\n`
              + 'Reconcile this handoff with the current work before acting. Do not repeat completed work or expand the original scope.';
          }
          if (Date.now() >= heartbeatAt) {
            onHeartbeat?.({ ...marker, state: 'waiting' });
            heartbeatAt = Date.now() + heartbeatMs;
          }
          await delay(Math.max(1, Math.min(pollMs, heartbeatAt - Date.now())), controller.signal);
        }
      } finally {
        signal?.removeEventListener('abort', cancel);
        await removeReady();
      }
    },
    async cleanup() {
      controller.abort();
      await removeReady();
    },
  };
}
