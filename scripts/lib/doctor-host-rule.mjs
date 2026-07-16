import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { resolveCodexHome } from './agent-config.mjs';

export const WORKER_HOST_RULE_FILE = 'cruise-worker.rules';
export const LEGACY_WORKER_HOST_RULE = 'prefix_rule(pattern=["cruise", "worker"], decision="allow")\n';

export function renderWorkerHostRule(entrypoint) {
  if (typeof entrypoint !== 'string' || !isAbsolute(entrypoint)) {
    throw new TypeError('Cruise worker rule requires an absolute executable entrypoint');
  }
  return `prefix_rule(pattern=${JSON.stringify([resolve(entrypoint), 'worker'])}, decision="allow")\n`;
}

export function workerHostRulePath({ codexHome = null } = {}) {
  return join(resolve(codexHome ?? resolveCodexHome()), 'rules', WORKER_HOST_RULE_FILE);
}

async function isReadable(path) {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function inspectWorkerHostRule({ codexHome = null, entrypoint } = {}) {
  const path = workerHostRulePath({ codexHome });
  const expected = renderWorkerHostRule(entrypoint);
  if (!await isReadable(path)) {
    return Object.freeze({
      status: 'missing',
      path,
      detail: 'the scoped Cruise worker host rule is not installed',
    });
  }

  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    return Object.freeze({
      status: 'invalid',
      path,
      detail: 'the Cruise worker host rule must be a regular file, not a link or directory',
    });
  }
  const contents = await readFile(path, 'utf8');
  if (contents === LEGACY_WORKER_HOST_RULE) {
    return Object.freeze({
      status: 'legacy',
      path,
      detail: 'the legacy PATH-based Cruise worker rule must be replaced by the exact executable rule',
    });
  }
  if (contents !== expected) {
    return Object.freeze({
      status: 'invalid',
      path,
      detail: 'the Cruise worker host rule differs from the exact scoped policy',
    });
  }
  return Object.freeze({
    status: 'current',
    path,
    entrypoint: resolve(entrypoint),
    detail: `the exact ${resolve(entrypoint)} worker command prefix is allowed for host execution`,
  });
}

export async function installWorkerHostRule({ codexHome = null, entrypoint } = {}) {
  const path = workerHostRulePath({ codexHome });
  const expected = renderWorkerHostRule(entrypoint);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = await lstat(directory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw new Error(`${directory} must be a real directory before Cruise can install its worker rule.`);
  }

  const existing = await inspectWorkerHostRule({ codexHome, entrypoint });
  if (existing.status === 'current') return Object.freeze({ ...existing, changed: false });
  if (existing.status === 'invalid') {
    throw new Error(`${path} already exists but is not the exact Cruise-managed rule; remove or reconcile it manually.`);
  }

  const temporary = `${path}.${process.pid}.tmp`;
  let handle = null;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(expected, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }

  const installed = await inspectWorkerHostRule({ codexHome, entrypoint });
  if (installed.status !== 'current') {
    throw new Error(`Cruise could not verify the installed worker rule at ${path}.`);
  }
  return Object.freeze({ ...installed, changed: true });
}
