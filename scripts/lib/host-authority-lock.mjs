import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  link,
  lstat,
  open,
  realpath,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { canonicalJson, parseYaml, stringifyYaml } from './yaml-state.mjs';

const LOCK_KIND = 'cruise_host_authority_pid_lock';
const LOCK_SCHEMA_VERSION = 1;
const LOCK_MAX_BYTES = 16 * 1024;
const RESOURCE = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class HostAuthorityLockError extends Error {
  constructor(message, code, options = undefined) {
    super(message, options);
    this.name = 'HostAuthorityLockError';
    this.code = code;
  }
}

function lockError(message, code, cause = undefined) {
  throw new HostAuthorityLockError(
    message,
    code,
    cause === undefined ? undefined : { cause },
  );
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactKeys(record, expected) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return false;
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalScopeDigest(scope) {
  try {
    return sha256(Buffer.from(canonicalJson(scope), 'utf8'));
  } catch (cause) {
    lockError(
      'host-authority lock scope must be a canonical JSON-compatible value',
      'CRUISE_HOST_AUTHORITY_LOCK_INVALID',
      cause,
    );
  }
}

function normalizedOptions({ lockPath, resource, scope } = {}) {
  if (typeof lockPath !== 'string' || lockPath.length === 0 || lockPath.includes('\0')) {
    lockError('host-authority lockPath is required', 'CRUISE_HOST_AUTHORITY_LOCK_INVALID');
  }
  if (typeof resource !== 'string' || !RESOURCE.test(resource)) {
    lockError(
      'host-authority lock resource must be a lowercase stable identifier',
      'CRUISE_HOST_AUTHORITY_LOCK_INVALID',
    );
  }
  const absolutePath = resolve(lockPath);
  return Object.freeze({
    lockPath: absolutePath,
    resource,
    scopeSha256: canonicalScopeDigest(scope),
    lockPathSha256: sha256(Buffer.from(absolutePath, 'utf8')),
  });
}

async function assertSafeParent(path) {
  const parent = dirname(path);
  let metadata;
  try {
    metadata = await lstat(parent);
  } catch (cause) {
    lockError(
      `host-authority lock parent is unavailable: ${parent}`,
      'CRUISE_HOST_AUTHORITY_LOCK_PATH',
      cause,
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    lockError(
      `host-authority lock parent is unsafe: ${parent}`,
      'CRUISE_HOST_AUTHORITY_LOCK_PATH',
    );
  }
  let canonical;
  try {
    canonical = await realpath(parent);
  } catch (cause) {
    lockError(
      `host-authority lock parent cannot be resolved: ${parent}`,
      'CRUISE_HOST_AUTHORITY_LOCK_PATH',
      cause,
    );
  }
  if (canonical !== parent) {
    lockError(
      `host-authority lock parent is not canonical: ${parent}`,
      'CRUISE_HOST_AUTHORITY_LOCK_PATH',
    );
  }
  return parent;
}

async function syncDirectory(path) {
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by a different authority.
    return error?.code !== 'ESRCH';
  }
}

function metadataFor(options) {
  return {
    schema_version: LOCK_SCHEMA_VERSION,
    kind: LOCK_KIND,
    resource: options.resource,
    scope_sha256: options.scopeSha256,
    lock_path_sha256: options.lockPathSha256,
    pid: process.pid,
    nonce: randomUUID(),
    acquired_at: new Date().toISOString(),
  };
}

function validateMetadata(record, options) {
  const keys = [
    'schema_version',
    'kind',
    'resource',
    'scope_sha256',
    'lock_path_sha256',
    'pid',
    'nonce',
    'acquired_at',
  ];
  const timestamp = typeof record?.acquired_at === 'string'
    ? new Date(record.acquired_at)
    : null;
  if (
    !exactKeys(record, keys)
    || record.schema_version !== LOCK_SCHEMA_VERSION
    || record.kind !== LOCK_KIND
    || record.resource !== options.resource
    || record.scope_sha256 !== options.scopeSha256
    || record.lock_path_sha256 !== options.lockPathSha256
    || !Number.isSafeInteger(record.pid)
    || record.pid <= 0
    || typeof record.nonce !== 'string'
    || !UUID.test(record.nonce)
    || timestamp === null
    || Number.isNaN(timestamp.valueOf())
    || timestamp.toISOString() !== record.acquired_at
    || !SHA256.test(record.scope_sha256)
    || !SHA256.test(record.lock_path_sha256)
  ) {
    lockError(
      `${options.resource} is already running; its host-authority lock is malformed or belongs elsewhere`,
      'CRUISE_HOST_AUTHORITY_LOCK_MALFORMED',
    );
  }
  return record;
}

async function readRegularLock(path, options) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > LOCK_MAX_BYTES) {
      lockError(
        `${options.resource} is already running; its host-authority lock is not a bounded regular file`,
        'CRUISE_HOST_AUTHORITY_LOCK_MALFORMED',
      );
    }
    const bytes = await handle.readFile();
    if (bytes.length !== metadata.size) {
      lockError(
        `${options.resource} is already running; its host-authority lock changed while being read`,
        'CRUISE_HOST_AUTHORITY_LOCK_CHANGED',
      );
    }
    let record;
    try {
      record = parseYaml(bytes.toString('utf8'), {
        maxBytes: LOCK_MAX_BYTES,
        maxDepth: 8,
        maxNodes: 64,
      });
    } catch (cause) {
      lockError(
        `${options.resource} is already running; its host-authority lock is malformed`,
        'CRUISE_HOST_AUTHORITY_LOCK_MALFORMED',
        cause,
      );
    }
    return Object.freeze({
      metadata: Object.freeze(validateMetadata(record, options)),
      bytes,
      sha256: sha256(bytes),
      identity: Object.freeze({ dev: metadata.dev, ino: metadata.ino }),
    });
  } catch (error) {
    if (error instanceof HostAuthorityLockError || error?.code === 'ENOENT') throw error;
    if (error?.code === 'ELOOP') {
      lockError(
        `${options.resource} is already running; its host-authority lock is a symlink`,
        'CRUISE_HOST_AUTHORITY_LOCK_MALFORMED',
        error,
      );
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function prepareLock(options, parent) {
  const metadata = metadataFor(options);
  const bytes = Buffer.from(stringifyYaml(metadata), 'utf8');
  const preparationPath = `${options.lockPath}.${metadata.pid}.${metadata.nonce}.prepare`;
  let handle;
  try {
    handle = await open(preparationPath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await link(preparationPath, options.lockPath);
    await syncDirectory(parent);
    return Object.freeze({ options, metadata: Object.freeze(metadata), bytes, sha256: sha256(bytes) });
  } finally {
    await handle?.close().catch(() => {});
    await rm(preparationPath, { force: true }).catch(() => {});
  }
}

async function reclaimDeadLock(options, parent, stale) {
  const confirmed = await readRegularLock(options.lockPath, options);
  if (confirmed.sha256 !== stale.sha256 || confirmed.metadata.nonce !== stale.metadata.nonce) {
    lockError(
      `${options.resource} host-authority lock changed during dead-owner recovery`,
      'CRUISE_HOST_AUTHORITY_LOCK_CHANGED',
    );
  }
  const quarantinePath = `${options.lockPath}.${stale.metadata.nonce}.stale-${randomUUID()}`;
  try {
    await rename(options.lockPath, quarantinePath);
  } catch (cause) {
    if (cause?.code === 'ENOENT' || cause?.code === 'EEXIST') {
      lockError(
        `${options.resource} host-authority lock changed during dead-owner recovery`,
        'CRUISE_HOST_AUTHORITY_LOCK_CHANGED',
        cause,
      );
    }
    throw cause;
  }
  await syncDirectory(parent);
  const quarantined = await readRegularLock(quarantinePath, options);
  if (quarantined.sha256 !== stale.sha256 || !quarantined.bytes.equals(stale.bytes)) {
    // Preserve the moved lock and fail closed. A mismatching inode must never be
    // treated as the validated dead owner's authority.
    try {
      await link(quarantinePath, options.lockPath);
      await syncDirectory(parent);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    lockError(
      `${options.resource} host-authority lock was replaced during dead-owner recovery`,
      'CRUISE_HOST_AUTHORITY_LOCK_CHANGED',
    );
  }
  await rm(quarantinePath);
  await rm(
    `${options.lockPath}.${stale.metadata.pid}.${stale.metadata.nonce}.prepare`,
    { force: true },
  );
  await syncDirectory(parent);
}

export async function acquireHostAuthorityLock(input) {
  const options = normalizedOptions(input);
  const parent = await assertSafeParent(options.lockPath);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await prepareLock(options, parent);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const existing = await readRegularLock(options.lockPath, options);
    if (processIsAlive(existing.metadata.pid)) {
      lockError(
        `${options.resource} is already running under active PID ${existing.metadata.pid}`,
        'CRUISE_HOST_AUTHORITY_LOCK_HELD',
      );
    }
    await reclaimDeadLock(options, parent, existing);
  }
  lockError(
    `${options.resource} host-authority lock could not be acquired after dead-owner recovery`,
    'CRUISE_HOST_AUTHORITY_LOCK_CONTENDED',
  );
}

export async function releaseHostAuthorityLock(lock) {
  if (lock === null || typeof lock !== 'object' || lock.options === undefined) {
    lockError('host-authority lock receipt is invalid', 'CRUISE_HOST_AUTHORITY_LOCK_INVALID');
  }
  const options = lock.options;
  const parent = await assertSafeParent(options.lockPath);
  let current;
  try {
    current = await readRegularLock(options.lockPath, options);
  } catch (cause) {
    if (cause?.code === 'ENOENT') {
      lockError(
        `${options.resource} host-authority lock disappeared while held`,
        'CRUISE_HOST_AUTHORITY_LOCK_LOST',
        cause,
      );
    }
    throw cause;
  }
  if (
    current.metadata.nonce !== lock.metadata.nonce
    || current.sha256 !== lock.sha256
    || !current.bytes.equals(lock.bytes)
  ) {
    lockError(
      `${options.resource} host-authority lock was replaced while held`,
      'CRUISE_HOST_AUTHORITY_LOCK_REPLACED',
    );
  }
  const releasePath = `${options.lockPath}.${lock.metadata.nonce}.release-${randomUUID()}`;
  await rename(options.lockPath, releasePath);
  await syncDirectory(parent);
  const released = await readRegularLock(releasePath, options);
  if (released.sha256 !== lock.sha256 || !released.bytes.equals(lock.bytes)) {
    try {
      await link(releasePath, options.lockPath);
      await syncDirectory(parent);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    lockError(
      `${options.resource} host-authority lock changed during release`,
      'CRUISE_HOST_AUTHORITY_LOCK_CHANGED',
    );
  }
  await rm(releasePath);
  await syncDirectory(parent);
}

export async function withHostAuthorityLock(options, callback) {
  if (typeof callback !== 'function') {
    lockError('host-authority lock callback is required', 'CRUISE_HOST_AUTHORITY_LOCK_INVALID');
  }
  const lock = await acquireHostAuthorityLock(options);
  let callbackError = null;
  try {
    return await callback(lock);
  } catch (error) {
    callbackError = error;
    throw error;
  } finally {
    try {
      await releaseHostAuthorityLock(lock);
    } catch (releaseError) {
      if (callbackError === null) throw releaseError;
      Object.defineProperty(callbackError, 'hostAuthorityLockReleaseError', {
        value: releaseError,
        enumerable: false,
        configurable: true,
      });
    }
  }
}
