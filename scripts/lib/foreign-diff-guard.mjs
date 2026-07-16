import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readlink,
  realpath,
} from 'node:fs/promises';
import {
  lstatSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalJson, parseYaml, writeYamlFile } from './yaml-state.mjs';
import { assertInformativeName } from './artifact-naming.mjs';
import {
  clearDisposableRepositoryArtifacts,
  isNonProductRepositoryPath,
  repositoryGitPathspec,
} from './repository-scope.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const RUN_ID = /^(?=.{1,15}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const DECISION_ID = /^D-\d{2,}$/u;
const ACTION_ID = /^[A-Za-z][A-Za-z0-9._-]{1,127}$/u;
const INCIDENT_ID = /^FD-\d{3,}$/u;
const CONTROL_ROOT = '.cruise';
const AUTHORITY_ROOT = 'cruise-auth';
const VIRTUAL_PATHS = Object.freeze({
  head: '/.cruise-meta/git/HEAD',
  branch: '/.cruise-meta/git/branch',
  ignorePolicy: '/.cruise-meta/git/ignore-policy',
  directories: '/.cruise-meta/fs/directories',
});
const PATHSPEC = repositoryGitPathspec();
export const FOREIGN_DIFF_GUARD_LIMITS = Object.freeze({
  git_timeout_ms: 10_000,
  git_output_max_bytes: 8 * 1024 * 1024,
  file_max_bytes: 64 * 1024 * 1024,
  total_max_bytes: 512 * 1024 * 1024,
  max_entries: 10_000,
});

export class ForeignDiffGuardError extends Error {
  constructor(message, { code = 'CRUISE_FOREIGN_DIFF_GUARD' } = {}) {
    super(message);
    this.name = 'ForeignDiffGuardError';
    this.code = code;
  }
}

function guardError(message, code) {
  throw new ForeignDiffGuardError(message, { code });
}

function assertExactKeys(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    guardError(`${label} must be an object`, 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    guardError(`${label} must contain exactly: ${expected.join(', ')}`, 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function inventoryDigest(value) {
  const candidate = structuredClone(value);
  delete candidate.sha256;
  return sha256(Buffer.from(canonicalJson(candidate), 'utf8'));
}

function scopedInventory(inventory) {
  const scoped = structuredClone(inventory);
  scoped.entries = scoped.entries.filter(({ path }) => !isNonProductRepositoryPath(path));
  scoped.tracked_physical = scoped.tracked_physical
    .filter(({ path }) => !isNonProductRepositoryPath(path));
  if (scoped.kind === 'git') {
    const retainedDirectories = new Set(['.']);
    for (const { path } of [...scoped.entries, ...scoped.tracked_physical]) {
      const pieces = path.split('/');
      for (let index = 1; index < pieces.length; index += 1) {
        retainedDirectories.add(pieces.slice(0, index).join('/'));
      }
    }
    scoped.directories = scoped.directories.filter(({ path }) => retainedDirectories.has(path));
  }
  scoped.usage = {
    entries: scoped.entries.filter(({ kind }) => kind !== 'missing').length,
    total_bytes: scoped.entries.reduce((total, { size }) => total + size, 0),
  };
  scoped.sha256 = null;
  scoped.sha256 = inventoryDigest(scoped);
  return scoped;
}

function timestamp(now = null) {
  const supplied = typeof now === 'function' ? now() : now;
  const value = supplied == null ? new Date() : supplied instanceof Date ? supplied : new Date(supplied);
  if (Number.isNaN(value.getTime())) guardError('foreign-diff timestamp is invalid', 'CRUISE_FOREIGN_DIFF_INVALID');
  return value.toISOString();
}

function portable(path) {
  return sep === '/' ? path : path.split(sep).join('/');
}

function safeRelativePath(path, label = 'path') {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || isAbsolute(path)) {
    guardError(`${label} must be a non-empty repository-relative path`, 'CRUISE_FOREIGN_DIFF_PATH');
  }
  const normalized = portable(path).replace(/^\.\//u, '');
  if (
    normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.includes('/../')
    || normalized === CONTROL_ROOT
    || normalized.startsWith(`${CONTROL_ROOT}/`)
  ) {
    guardError(`${label} escapes the product repository boundary`, 'CRUISE_FOREIGN_DIFF_PATH');
  }
  return normalized;
}

function pathIsWithin(root, candidate) {
  const difference = relative(resolve(root), resolve(candidate));
  return difference === '' || (difference !== '..' && !difference.startsWith(`..${sep}`));
}

function canonicalRoot(repositoryRoot) {
  if (typeof repositoryRoot !== 'string' || repositoryRoot.length === 0) {
    guardError('repositoryRoot is required', 'CRUISE_FOREIGN_DIFF_INVALID');
  }
  return realpathSync(resolve(repositoryRoot));
}

export function foreignDiffAuthorityPath(repositoryRoot, runId) {
  const root = canonicalRoot(repositoryRoot);
  if (!RUN_ID.test(runId ?? '') || runId.length > 15) {
    guardError('foreign-diff authority run ID is invalid', 'CRUISE_FOREIGN_DIFF_INVALID');
  }
  const tempRoot = realpathSync(resolve(tmpdir()));
  if (pathIsWithin(root, tempRoot)) {
    guardError(
      'foreign-diff authority root must be outside the product repository',
      'CRUISE_FOREIGN_DIFF_AUTHORITY',
    );
  }
  let naming;
  try {
    naming = parseYaml(readFileSync(join(root, '.cruise', 'repo.yaml'), 'utf8'));
    assertInformativeName(naming?.name, { label: 'repository name' });
  } catch (cause) {
    guardError(
      'foreign-diff authority requires the level-1 repo.yaml naming record',
      'CRUISE_FOREIGN_DIFF_AUTHORITY',
      { cause },
    );
  }
  if (
    naming.schema_version !== 1
    || naming.kind !== 'cruise_repository_name'
    || naming.repository_root !== root
    || naming.assigned_by !== 'cruise_l1'
    || naming.worker_level !== 1
  ) {
    guardError('foreign-diff repository name authority is invalid', 'CRUISE_FOREIGN_DIFF_AUTHORITY');
  }
  return join(tempRoot, AUTHORITY_ROOT, naming.name, runId, 'drift.yaml');
}

async function prepareAuthorityDirectory(repositoryRoot, runId) {
  const authorityPath = foreignDiffAuthorityPath(repositoryRoot, runId);
  const tmpRoot = await realpath(resolve(tmpdir()));
  let current = tmpRoot;
  for (const piece of relative(tmpRoot, dirname(authorityPath)).split(sep).filter(Boolean)) {
    current = join(current, piece);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(current) !== current) {
      guardError('foreign-diff authority directory is unsafe', 'CRUISE_FOREIGN_DIFF_AUTHORITY');
    }
    await chmod(current, 0o700);
  }
  return authorityPath;
}

function runGit(root, args, limits, { required = true } = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: null,
    timeout: limits.git_timeout_ms,
    maxBuffer: limits.git_output_max_bytes,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    const code = result.error.code === 'ETIMEDOUT'
      ? 'CRUISE_FOREIGN_DIFF_GIT_TIMEOUT'
      : 'CRUISE_FOREIGN_DIFF_GIT_FAILED';
    guardError(`foreign-diff Git inspection failed: ${result.error.message}`, code);
  }
  if (required && result.status !== 0) {
    const detail = Buffer.from(result.stderr ?? []).toString('utf8').trim();
    guardError(`foreign-diff Git inspection failed${detail ? `: ${detail}` : ''}`, 'CRUISE_FOREIGN_DIFF_GIT_FAILED');
  }
  return result;
}

function nulPaths(buffer) {
  return Buffer.from(buffer ?? []).toString('utf8').split('\0').filter(Boolean);
}

function gitIdentity(root, args, limits) {
  const result = runGit(root, args, limits, { required: false });
  return result.status === 0 ? Buffer.from(result.stdout).toString('utf8').trim() || null : null;
}

function policyFileIdentity(path, label, limits) {
  const absolute = resolve(path);
  const pathSha256 = sha256(Buffer.from(absolute, 'utf8'));
  let metadata;
  try {
    metadata = lstatSync(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { path_sha256: pathSha256, kind: 'missing', mode: null, size: 0, sha256: null };
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    guardError(`${label} must be a regular file or missing`, 'CRUISE_FOREIGN_DIFF_IGNORE_POLICY');
  }
  if (metadata.size > limits.file_max_bytes) {
    guardError(`${label} exceeds the foreign-diff file limit`, 'CRUISE_FOREIGN_DIFF_FILE_LIMIT');
  }
  const bytes = readStableFileSync(absolute, metadata, label, limits);
  return {
    path_sha256: pathSha256,
    kind: 'file',
    mode: metadata.mode & 0o7777,
    size: bytes.length,
    sha256: sha256(bytes),
  };
}

function gitResolvedPath(root, args, limits, label, { required = true } = {}) {
  const result = runGit(root, args, limits, { required: false });
  if (result.status !== 0) {
    if (!required) return null;
    guardError(`Git could not resolve ${label}`, 'CRUISE_FOREIGN_DIFF_IGNORE_POLICY');
  }
  const value = Buffer.from(result.stdout).toString('utf8').trim();
  if (!value) {
    if (!required) return null;
    guardError(`Git returned an empty ${label}`, 'CRUISE_FOREIGN_DIFF_IGNORE_POLICY');
  }
  return resolve(root, value);
}

function captureGitIgnorePolicy(root, limits) {
  const trackedAndVisible = nulPaths(runGit(
    root,
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ':(glob)**/.gitignore'],
    limits,
  ).stdout);
  const ignored = nulPaths(runGit(
    root,
    ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ':(glob)**/.gitignore'],
    limits,
  ).stdout);
  const usage = { entries: 0, total_bytes: 0 };
  const gitignores = [...new Set([...trackedAndVisible, ...ignored])]
    .map((path) => safeRelativePath(path, 'Git ignore policy path'))
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((path) => {
      const fingerprint = fingerprintPath(root, path, usage, limits);
      if (!['file', 'symlink'].includes(fingerprint.kind)) {
        guardError(`Git ignore policy source is unsafe: ${path}`, 'CRUISE_FOREIGN_DIFF_IGNORE_POLICY');
      }
      return { path, ...fingerprint };
    });
  const infoExclude = gitResolvedPath(
    root,
    ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'],
    limits,
    'info/exclude',
  );
  const localConfig = gitResolvedPath(
    root,
    ['rev-parse', '--path-format=absolute', '--git-path', 'config'],
    limits,
    'local Git config',
  );
  const worktreeConfig = gitResolvedPath(
    root,
    ['rev-parse', '--path-format=absolute', '--git-path', 'config.worktree'],
    limits,
    'worktree Git config',
  );
  const excludesFile = gitResolvedPath(
    root,
    ['config', '--path', '--get', 'core.excludesFile'],
    limits,
    'core.excludesFile',
    { required: false },
  );
  return {
    gitignores,
    info_exclude: policyFileIdentity(infoExclude, 'Git info/exclude', limits),
    local_config: policyFileIdentity(localConfig, 'local Git config', limits),
    worktree_config: policyFileIdentity(worktreeConfig, 'worktree Git config', limits),
    global_excludes: excludesFile === null
      ? null
      : policyFileIdentity(excludesFile, 'core.excludesFile', limits),
  };
}

function captureGitDirectoryMetadata(root, paths, limits) {
  const directories = new Set(['.']);
  for (const path of paths) {
    const pieces = path.split('/');
    for (let index = 1; index < pieces.length; index += 1) {
      directories.add(pieces.slice(0, index).join('/'));
    }
  }
  if (directories.size > limits.max_entries) {
    guardError('foreign-diff directory inventory exceeds its entry limit', 'CRUISE_FOREIGN_DIFF_ENTRY_LIMIT');
  }
  return [...directories]
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((path) => {
      const absolute = path === '.' ? root : resolve(root, path);
      let metadata;
      try {
        metadata = lstatSync(absolute);
      } catch (error) {
        if (error?.code === 'ENOENT') return { path, kind: 'missing', mode: null };
        throw error;
      }
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        guardError(`tracked path parent is unsafe: ${path}`, 'CRUISE_FOREIGN_DIFF_PATH');
      }
      return { path, kind: 'directory', mode: metadata.mode & 0o7777 };
    });
}

function captureTrackedPhysicalMetadata(root, index, limits) {
  const tracked = [...index.entries()]
    .filter(([, records]) => records.some(({ stage }) => stage === 0))
    .sort(([left], [right]) => left.localeCompare(right, 'en'));
  if (tracked.length > limits.max_entries) {
    guardError('foreign-diff tracked physical inventory exceeds its entry limit', 'CRUISE_FOREIGN_DIFF_ENTRY_LIMIT');
  }
  return tracked.map(([path]) => {
    const absolute = resolve(root, path);
    let metadata;
    try {
      metadata = lstatSync(absolute);
    } catch (error) {
      if (error?.code === 'ENOENT') return { path, kind: 'missing', mode: null };
      throw error;
    }
    const mode = metadata.mode & 0o7777;
    if (metadata.isSymbolicLink()) return { path, kind: 'symlink', mode };
    if (metadata.isFile()) return { path, kind: 'file', mode };
    if (metadata.isDirectory()) return { path, kind: 'directory', mode };
    guardError(`unsupported tracked physical path: ${path}`, 'CRUISE_FOREIGN_DIFF_SPECIAL_PATH');
  });
}

function indexEntries(root, limits) {
  const result = runGit(root, ['ls-files', '--stage', '-z', '--', ...PATHSPEC], limits);
  const entries = new Map();
  for (const record of nulPaths(result.stdout)) {
    const tab = record.indexOf('\t');
    if (tab < 0) guardError('Git returned malformed index metadata', 'CRUISE_FOREIGN_DIFF_GIT_FAILED');
    const metadata = record.slice(0, tab).split(' ');
    const path = safeRelativePath(record.slice(tab + 1), 'Git index path');
    if (isNonProductRepositoryPath(path)) continue;
    const item = { mode: metadata[0], object: metadata[1], stage: Number(metadata[2]) };
    if (!entries.has(path)) entries.set(path, []);
    entries.get(path).push(item);
  }
  for (const values of entries.values()) values.sort((left, right) => left.stage - right.stage);
  return entries;
}

function indexLedger(entries) {
  return [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([path, records]) => ({ path, records: structuredClone(records) }));
}

function assertInitializedGitlinksClean(root, index, limits) {
  for (const [path, records] of index.entries()) {
    const gitlink = records.find((entry) => entry.stage === 0 && entry.mode === '160000');
    if (!gitlink) continue;
    const absolute = resolve(root, path);
    let metadata;
    try {
      metadata = lstatSync(absolute);
    } catch (error) {
      // An uninitialized submodule has no writable worktree bytes to hide.
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      guardError(`submodule worktree is unsafe: ${path}`, 'CRUISE_FOREIGN_DIFF_DIRTY_SUBMODULE');
    }
    const canonical = realpathSync(absolute);
    const related = portable(relative(root, canonical));
    if (related === '..' || related.startsWith('../')) {
      guardError(`submodule worktree escapes the repository: ${path}`, 'CRUISE_FOREIGN_DIFF_DIRTY_SUBMODULE');
    }
    const head = gitIdentity(root, ['-C', path, 'rev-parse', '--verify', 'HEAD'], limits);
    const status = runGit(root, [
      '-C', path,
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=none',
    ], limits, { required: false });
    if (head !== gitlink.object || status.status !== 0 || Buffer.from(status.stdout ?? []).length !== 0) {
      guardError(
        `dirty submodule state cannot be inventoried safely: ${path}`,
        'CRUISE_FOREIGN_DIFF_DIRTY_SUBMODULE',
      );
    }
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size;
}

function readExactSync(fd, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  if (offset !== size) {
    guardError('repository file changed while it was being fingerprinted', 'CRUISE_FOREIGN_DIFF_RACE');
  }
  return bytes;
}

function readStableFileSync(absolute, metadata, path, limits) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let fd;
  try {
    fd = openSync(absolute, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFileIdentity(metadata, opened)) {
      guardError(`repository changed while fingerprinting ${path}`, 'CRUISE_FOREIGN_DIFF_RACE');
    }
    if (opened.size > limits.file_max_bytes) {
      guardError(`foreign-diff file exceeds ${limits.file_max_bytes} bytes: ${path}`, 'CRUISE_FOREIGN_DIFF_FILE_LIMIT');
    }
    const first = readExactSync(fd, opened.size);
    const afterFirst = fstatSync(fd);
    const second = readExactSync(fd, opened.size);
    const afterSecond = fstatSync(fd);
    if (
      !sameFileIdentity(opened, afterFirst)
      || !sameFileIdentity(opened, afterSecond)
      || sha256(first) !== sha256(second)
    ) {
      guardError(`repository changed while fingerprinting ${path}`, 'CRUISE_FOREIGN_DIFF_RACE');
    }
    return first;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function fingerprintPath(root, path, usage, limits) {
  const absolute = resolve(root, path);
  const related = portable(relative(root, absolute));
  if (related !== path || related === '..' || related.startsWith('../')) {
    guardError(`inventory path escapes repository: ${path}`, 'CRUISE_FOREIGN_DIFF_PATH');
  }
  let metadata;
  try {
    metadata = lstatSync(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing', mode: null, size: 0, sha256: null };
    throw error;
  }
  usage.entries += 1;
  if (usage.entries > limits.max_entries) {
    guardError(`foreign-diff inventory exceeds ${limits.max_entries} entries`, 'CRUISE_FOREIGN_DIFF_ENTRY_LIMIT');
  }
  const mode = metadata.mode & 0o7777;
  if (metadata.isSymbolicLink()) {
    const bytes = readlinkSync(absolute, { encoding: 'buffer' });
    usage.total_bytes += bytes.length;
    if (usage.total_bytes > limits.total_max_bytes) {
      guardError(`foreign-diff inventory exceeds ${limits.total_max_bytes} content bytes`, 'CRUISE_FOREIGN_DIFF_TOTAL_LIMIT');
    }
    return { kind: 'symlink', mode, size: bytes.length, sha256: sha256(bytes) };
  }
  if (metadata.isDirectory()) return { kind: 'directory', mode, size: 0, sha256: null };
  if (!metadata.isFile()) {
    guardError(`unsupported special repository path: ${path}`, 'CRUISE_FOREIGN_DIFF_SPECIAL_PATH');
  }
  if (metadata.size > limits.file_max_bytes) {
    guardError(`foreign-diff file exceeds ${limits.file_max_bytes} bytes: ${path}`, 'CRUISE_FOREIGN_DIFF_FILE_LIMIT');
  }
  usage.total_bytes += metadata.size;
  if (usage.total_bytes > limits.total_max_bytes) {
    guardError(`foreign-diff inventory exceeds ${limits.total_max_bytes} content bytes`, 'CRUISE_FOREIGN_DIFF_TOTAL_LIMIT');
  }
  const bytes = readStableFileSync(absolute, metadata, path, limits);
  return { kind: 'file', mode, size: bytes.length, sha256: sha256(bytes) };
}

function captureGitInventory(root, limits) {
  const ignorePolicyBefore = captureGitIgnorePolicy(root, limits);
  const worktreePaths = new Set(nulPaths(runGit(
    root,
    ['diff', '--name-only', '-z', '--no-ext-diff', '--', ...PATHSPEC],
    limits,
  ).stdout).map((path) => safeRelativePath(path, 'Git worktree path')));
  const stagedPaths = new Set(nulPaths(runGit(
    root,
    ['diff', '--cached', '--name-only', '-z', '--no-ext-diff', '--', ...PATHSPEC],
    limits,
  ).stdout).map((path) => safeRelativePath(path, 'Git staged path')));
  const untrackedPaths = new Set(nulPaths(runGit(
    root,
    ['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', ...PATHSPEC],
    limits,
  ).stdout).map((path) => safeRelativePath(path, 'Git untracked path')));
  const index = indexEntries(root, limits);
  assertInitializedGitlinksClean(root, index, limits);
  const directoryPaths = new Set([
    ...index.keys(),
    ...worktreePaths,
    ...stagedPaths,
    ...untrackedPaths,
  ]);
  const directoriesBefore = captureGitDirectoryMetadata(root, directoryPaths, limits);
  const trackedPhysicalBefore = captureTrackedPhysicalMetadata(root, index, limits);
  const usage = { entries: 0, total_bytes: 0 };
  const paths = new Set([...worktreePaths, ...stagedPaths, ...untrackedPaths]);
  const entries = [...paths]
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((path) => ({
      path,
      ...fingerprintPath(root, path, usage, limits),
      worktree_changed: worktreePaths.has(path),
      index_changed: stagedPaths.has(path),
      untracked: untrackedPaths.has(path),
      index: index.get(path) ?? [],
    }));
  assertInitializedGitlinksClean(root, index, limits);
  const ignorePolicyAfter = captureGitIgnorePolicy(root, limits);
  if (canonicalJson(ignorePolicyBefore) !== canonicalJson(ignorePolicyAfter)) {
    guardError('Git ignore policy changed during inventory capture', 'CRUISE_FOREIGN_DIFF_RACE');
  }
  const directoriesAfter = captureGitDirectoryMetadata(root, directoryPaths, limits);
  if (canonicalJson(directoriesBefore) !== canonicalJson(directoriesAfter)) {
    guardError('repository directory metadata changed during inventory capture', 'CRUISE_FOREIGN_DIFF_RACE');
  }
  const trackedPhysicalAfter = captureTrackedPhysicalMetadata(root, index, limits);
  if (canonicalJson(trackedPhysicalBefore) !== canonicalJson(trackedPhysicalAfter)) {
    guardError('tracked physical metadata changed during inventory capture', 'CRUISE_FOREIGN_DIFF_RACE');
  }
  const inventory = {
    schema_version: 1,
    kind: 'git',
    repository_root: root,
    head: gitIdentity(root, ['rev-parse', '--verify', 'HEAD'], limits),
    branch: gitIdentity(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], limits),
    ignore_policy: ignorePolicyBefore,
    directories: directoriesBefore,
    tracked_physical: trackedPhysicalBefore,
    entries,
    usage,
    sha256: null,
  };
  inventory.sha256 = inventoryDigest(inventory);
  return inventory;
}

function captureTreeInventory(root, limits) {
  const usage = { entries: 0, total_bytes: 0 };
  const entries = [];
  const walk = (directory, prefix = '') => {
    for (const item of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      if (prefix === '' && (item.name === CONTROL_ROOT || item.name === '.git')) continue;
      const path = safeRelativePath(prefix ? `${prefix}/${item.name}` : item.name);
      if (isNonProductRepositoryPath(path)) continue;
      const fingerprint = fingerprintPath(root, path, usage, limits);
      entries.push({
        path,
        ...fingerprint,
        worktree_changed: true,
        index_changed: false,
        untracked: true,
        index: [],
      });
      if (fingerprint.kind === 'directory') walk(join(directory, item.name), path);
    }
  };
  walk(root);
  const inventory = {
    schema_version: 1,
    kind: 'tree',
    repository_root: root,
    head: null,
    branch: null,
    ignore_policy: null,
    directories: [],
    tracked_physical: [],
    entries,
    usage,
    sha256: null,
  };
  inventory.sha256 = inventoryDigest(inventory);
  return inventory;
}

export function captureProductInventory(repositoryRoot, { limits = FOREIGN_DIFF_GUARD_LIMITS } = {}) {
  const root = canonicalRoot(repositoryRoot);
  clearDisposableRepositoryArtifacts(root);
  const mergedLimits = { ...FOREIGN_DIFF_GUARD_LIMITS, ...limits };
  const git = runGit(root, ['rev-parse', '--show-toplevel'], mergedLimits, { required: false });
  if (git.status === 0) {
    const gitRoot = realpathSync(Buffer.from(git.stdout).toString('utf8').trim());
    if (gitRoot !== root) guardError('repositoryRoot must be the canonical Git root', 'CRUISE_FOREIGN_DIFF_ROOT');
    return captureGitInventory(root, mergedLimits);
  }
  return captureTreeInventory(root, mergedLimits);
}

export function inventoryEntryDigest(entry) {
  return sha256(Buffer.from(canonicalJson(entry), 'utf8'));
}

function inventoryChanges(before, current) {
  const changes = [];
  if (before.head !== current.head) {
    changes.push({ path: VIRTUAL_PATHS.head, before_sha256: before.head, current_sha256: current.head, before: null, current: null });
  }
  if (before.branch !== current.branch) {
    changes.push({ path: VIRTUAL_PATHS.branch, before_sha256: before.branch, current_sha256: current.branch, before: null, current: null });
  }
  if (canonicalJson(before.ignore_policy) !== canonicalJson(current.ignore_policy)) {
    changes.push({
      path: VIRTUAL_PATHS.ignorePolicy,
      before_sha256: before.ignore_policy === null
        ? null
        : sha256(Buffer.from(canonicalJson(before.ignore_policy), 'utf8')),
      current_sha256: current.ignore_policy === null
        ? null
        : sha256(Buffer.from(canonicalJson(current.ignore_policy), 'utf8')),
      before: null,
      current: null,
    });
  }
  if (canonicalJson(before.directories) !== canonicalJson(current.directories)) {
    changes.push({
      path: VIRTUAL_PATHS.directories,
      before_sha256: sha256(Buffer.from(canonicalJson(before.directories), 'utf8')),
      current_sha256: sha256(Buffer.from(canonicalJson(current.directories), 'utf8')),
      before: null,
      current: null,
    });
  }
  const beforeMap = new Map(before.entries.map((entry) => [entry.path, entry]));
  const currentMap = new Map(current.entries.map((entry) => [entry.path, entry]));
  const beforePhysical = new Map(before.tracked_physical.map((entry) => [entry.path, entry]));
  const currentPhysical = new Map(current.tracked_physical.map((entry) => [entry.path, entry]));
  const paths = new Set([
    ...beforeMap.keys(),
    ...currentMap.keys(),
    ...beforePhysical.keys(),
    ...currentPhysical.keys(),
  ]);
  for (const path of [...paths].sort((left, right) => left.localeCompare(right, 'en'))) {
    const prior = beforeMap.get(path) ?? null;
    const observed = currentMap.get(path) ?? null;
    const priorPhysical = beforePhysical.get(path) ?? null;
    const observedPhysical = currentPhysical.get(path) ?? null;
    const priorDigest = prior ? inventoryEntryDigest(prior) : null;
    const observedDigest = observed ? inventoryEntryDigest(observed) : null;
    if (
      priorDigest !== observedDigest
      || canonicalJson(priorPhysical) !== canonicalJson(observedPhysical)
    ) {
      changes.push({
        path,
        before_sha256: priorDigest,
        current_sha256: observedDigest,
        before: prior,
        current: observed,
        physical_before: priorPhysical,
        physical_current: observedPhysical,
      });
    }
  }
  return changes;
}

function assertInventory(inventory, root = null) {
  assertExactKeys(
    inventory,
    ['schema_version', 'kind', 'repository_root', 'head', 'branch', 'ignore_policy', 'directories', 'tracked_physical', 'entries', 'usage', 'sha256'],
    'foreign-diff inventory',
  );
  if (!inventory || inventory.schema_version !== 1 || !['git', 'tree'].includes(inventory.kind)) {
    guardError('foreign-diff inventory is invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  if (root && inventory.repository_root !== root) {
    guardError('foreign-diff inventory repository binding changed', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  if (!SHA256.test(inventory.sha256) || inventoryDigest(inventory) !== inventory.sha256) {
    guardError('foreign-diff inventory digest is invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  if (!Array.isArray(inventory.entries)) {
    guardError('foreign-diff inventory entries are invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  if (!Array.isArray(inventory.directories)) {
    guardError('foreign-diff directory inventory is invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  if (!Array.isArray(inventory.tracked_physical)) {
    guardError('foreign-diff tracked physical inventory is invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  let priorDirectory = null;
  for (const directory of inventory.directories) {
    assertExactKeys(directory, ['path', 'kind', 'mode'], 'foreign-diff directory entry');
    if (
      typeof directory.path !== 'string'
      || (directory.path !== '.' && safeRelativePath(directory.path, 'directory path') !== directory.path)
      || !['directory', 'missing'].includes(directory.kind)
      || (directory.kind === 'directory' ? !Number.isInteger(directory.mode) : directory.mode !== null)
      || (priorDirectory !== null && priorDirectory.localeCompare(directory.path, 'en') >= 0)
    ) {
      guardError('foreign-diff directory entry is malformed', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
    priorDirectory = directory.path;
  }
  if (inventory.kind === 'tree' && inventory.directories.length !== 0) {
    guardError('tree inventory duplicates directory metadata', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  if (inventory.kind === 'tree' && inventory.tracked_physical.length !== 0) {
    guardError('tree inventory must not contain tracked physical metadata', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  let priorTrackedPath = null;
  for (const tracked of inventory.tracked_physical) {
    assertExactKeys(tracked, ['path', 'kind', 'mode'], 'foreign-diff tracked physical entry');
    const path = safeRelativePath(tracked.path, 'tracked physical path');
    if (
      path !== tracked.path
      || !['file', 'symlink', 'directory', 'missing'].includes(tracked.kind)
      || (tracked.kind === 'missing'
        ? tracked.mode !== null
        : (!Number.isInteger(tracked.mode) || tracked.mode < 0 || tracked.mode > 0o7777))
      || (priorTrackedPath !== null && priorTrackedPath.localeCompare(path, 'en') >= 0)
    ) {
      guardError('foreign-diff tracked physical entry is malformed', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
    priorTrackedPath = path;
  }
  if (inventory.kind === 'tree') {
    if (inventory.ignore_policy !== null) {
      guardError('tree inventory must not contain Git ignore policy', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
  } else {
    assertExactKeys(
      inventory.ignore_policy,
      ['gitignores', 'info_exclude', 'local_config', 'worktree_config', 'global_excludes'],
      'foreign-diff Git ignore policy',
    );
    if (!Array.isArray(inventory.ignore_policy.gitignores)) {
      guardError('foreign-diff Git ignore policy sources are invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
    let priorIgnorePath = null;
    for (const source of inventory.ignore_policy.gitignores) {
      assertExactKeys(source, ['path', 'kind', 'mode', 'size', 'sha256'], 'Git ignore policy source');
      const path = safeRelativePath(source.path, 'Git ignore policy source path');
      if (
        !['file', 'symlink'].includes(source.kind)
        || !Number.isInteger(source.mode)
        || !Number.isSafeInteger(source.size)
        || source.size < 0
        || !SHA256.test(source.sha256 ?? '')
        || (priorIgnorePath !== null && priorIgnorePath.localeCompare(path, 'en') >= 0)
      ) {
        guardError('foreign-diff Git ignore policy source is invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
      }
      priorIgnorePath = path;
    }
    for (const [label, identity] of [
      ['info/exclude', inventory.ignore_policy.info_exclude],
      ['local config', inventory.ignore_policy.local_config],
      ['worktree config', inventory.ignore_policy.worktree_config],
      ['global excludes', inventory.ignore_policy.global_excludes],
    ]) {
      if (identity === null) {
        if (label !== 'global excludes') {
          guardError(`foreign-diff ${label} identity is missing`, 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
        }
        continue;
      }
      assertExactKeys(identity, ['path_sha256', 'kind', 'mode', 'size', 'sha256'], `Git ${label} identity`);
      if (
        !SHA256.test(identity.path_sha256 ?? '')
        || !['file', 'missing'].includes(identity.kind)
        || !Number.isSafeInteger(identity.size)
        || identity.size < 0
        || (identity.kind === 'file'
          ? (!Number.isInteger(identity.mode) || !SHA256.test(identity.sha256 ?? ''))
          : (identity.mode !== null || identity.size !== 0 || identity.sha256 !== null))
      ) {
        guardError(`foreign-diff Git ${label} identity is invalid`, 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
      }
    }
  }
  assertExactKeys(inventory.usage, ['entries', 'total_bytes'], 'foreign-diff inventory usage');
  if (
    !Number.isSafeInteger(inventory.usage.entries)
    || inventory.usage.entries < 0
    || !Number.isSafeInteger(inventory.usage.total_bytes)
    || inventory.usage.total_bytes < 0
    || (inventory.head !== null && !/^[a-f0-9]{40,64}$/u.test(inventory.head))
    || (inventory.branch !== null && (typeof inventory.branch !== 'string' || inventory.branch.length === 0))
  ) {
    guardError('foreign-diff inventory metadata is invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  let previous = null;
  let expectedEntries = 0;
  let expectedBytes = 0;
  for (const entry of inventory.entries) {
    assertExactKeys(
      entry,
      ['path', 'kind', 'mode', 'size', 'sha256', 'worktree_changed', 'index_changed', 'untracked', 'index'],
      'foreign-diff inventory entry',
    );
    const path = safeRelativePath(entry.path, 'inventory entry path');
    if (path !== entry.path || (previous != null && previous.localeCompare(path, 'en') >= 0)) {
      guardError('foreign-diff inventory paths must be sorted and unique', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
    if (!['file', 'symlink', 'directory', 'missing'].includes(entry.kind)) {
      guardError(`foreign-diff inventory kind is invalid for ${path}`, 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
    if ((entry.kind === 'file' || entry.kind === 'symlink') !== SHA256.test(entry.sha256 ?? '')) {
      guardError(`foreign-diff inventory digest is invalid for ${path}`, 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
    if (
      !Number.isSafeInteger(entry.size)
      || entry.size < 0
      || (entry.kind === 'missing' ? entry.mode !== null : !Number.isInteger(entry.mode))
      || (entry.kind === 'missing' || entry.kind === 'directory') && (entry.size !== 0 || entry.sha256 !== null)
      || ![entry.worktree_changed, entry.index_changed, entry.untracked].every((value) => typeof value === 'boolean')
    ) {
      guardError(`foreign-diff inventory metadata is invalid for ${path}`, 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
    if (!Array.isArray(entry.index)) guardError(`foreign-diff index metadata is invalid for ${path}`, 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    for (const indexEntry of entry.index) {
      assertExactKeys(indexEntry, ['mode', 'object', 'stage'], `foreign-diff index entry for ${path}`);
      if (
        !/^[0-7]{6}$/u.test(indexEntry.mode)
        || !/^[a-f0-9]{40,64}$/u.test(indexEntry.object)
        || !Number.isInteger(indexEntry.stage)
        || indexEntry.stage < 0
        || indexEntry.stage > 3
      ) {
        guardError(`foreign-diff index metadata is invalid for ${path}`, 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
      }
    }
    if (entry.kind !== 'missing') expectedEntries += 1;
    expectedBytes += entry.size;
    previous = path;
  }
  if (inventory.usage.entries !== expectedEntries || inventory.usage.total_bytes !== expectedBytes) {
    guardError('foreign-diff inventory usage does not match its entries', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  return inventory;
}

function appendHistory(state, action, at, details = {}) {
  state.history.push({
    sequence: state.history.length + 1,
    action,
    at,
    ...details,
  });
  state.updated_at = at;
}

function validateGuardState(state) {
  assertExactKeys(state, [
    'schema_version',
    'kind',
    'run_id',
    'repository_root',
    'origin_prompt_sha256',
    'repository_baseline_digest',
    'status',
    'limits',
    'checkpoint',
    'packet_bindings',
    'open_action',
    'active_incident',
    'incidents',
    'next_incident',
    'block',
    'created_at',
    'updated_at',
    'history',
  ], 'foreign-diff guard');
  if (!state || state.schema_version !== 2 || state.kind !== 'cruise_foreign_diff_guard') {
    guardError('foreign-diff guard state is invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  if (!RUN_ID.test(state.run_id) || state.repository_root !== canonicalRoot(state.repository_root)) {
    guardError('foreign-diff guard identity is invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  if (!SHA256.test(state.origin_prompt_sha256) || !SHA256.test(state.repository_baseline_digest)) {
    guardError('foreign-diff guard Origin binding is invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  if (
    !Number.isSafeInteger(state.next_incident)
    || state.next_incident < 1
    || Number.isNaN(Date.parse(state.created_at))
    || Number.isNaN(Date.parse(state.updated_at))
  ) {
    guardError('foreign-diff guard sequence or timestamps are invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  if (!['monitoring', 'action_open', 'waiting_user', 'stopped', 'blocked'].includes(state.status)) {
    guardError('foreign-diff guard status is invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  if (state.checkpoint !== null) {
    assertExactKeys(
      state.checkpoint,
      ['sequence', 'captured_at', 'inventory'],
      'foreign-diff checkpoint',
    );
    assertInventory(state.checkpoint.inventory, state.repository_root);
    if (!Number.isSafeInteger(state.checkpoint.sequence) || state.checkpoint.sequence < 0 || Number.isNaN(Date.parse(state.checkpoint.captured_at))) {
      guardError('foreign-diff checkpoint identity is invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
  }
  if (!Array.isArray(state.incidents) || !Array.isArray(state.history)) {
    guardError('foreign-diff guard history is invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  if (!Array.isArray(state.packet_bindings) || state.packet_bindings.length > FOREIGN_DIFF_GUARD_LIMITS.max_entries) {
    guardError('foreign-diff worker packet bindings are invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  let priorPacketPath = null;
  for (const binding of state.packet_bindings) {
    assertExactKeys(
      binding,
      ['relative_path', 'path_sha256', 'packet_sha256', 'bound_at'],
      'foreign-diff worker packet binding',
    );
    if (
      typeof binding.relative_path !== 'string'
      || !binding.relative_path.startsWith(`.cruise/runs/${state.run_id}/`)
      || binding.relative_path.split('/').length !== 4
      || !SHA256.test(binding.path_sha256 ?? '')
      || !SHA256.test(binding.packet_sha256 ?? '')
      || Number.isNaN(Date.parse(binding.bound_at))
      || (priorPacketPath !== null && priorPacketPath.localeCompare(binding.relative_path, 'en') >= 0)
    ) {
      guardError('foreign-diff worker packet binding is malformed', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
    priorPacketPath = binding.relative_path;
  }
  for (const [index, archived] of state.incidents.entries()) {
    assertExactKeys(archived, [
      'incident_id',
      'action_id',
      'observed_at',
      'observed_inventory_sha256',
      'foreign_paths',
      'accepted_agent_paths',
      'resolution',
    ], 'foreign-diff archived incident');
    assertExactKeys(
      archived.resolution,
      ['selection', 'decision_id', 'at', 'outcome', 'error'],
      'foreign-diff archived resolution',
    );
    if (
      archived.incident_id !== `FD-${String(index + 1).padStart(3, '0')}`
      || !SHA256.test(archived.observed_inventory_sha256)
      || !DECISION_ID.test(archived.resolution.decision_id)
      || typeof archived.resolution.selection !== 'string'
      || typeof archived.resolution.outcome !== 'string'
      || Number.isNaN(Date.parse(archived.observed_at))
      || Number.isNaN(Date.parse(archived.resolution.at))
      || !Array.isArray(archived.foreign_paths)
      || !Array.isArray(archived.accepted_agent_paths)
      || (archived.resolution.error !== null && typeof archived.resolution.error !== 'string')
    ) {
      guardError('foreign-diff archived incident is invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
  }
  assertExactKeys(state.limits, Object.keys(FOREIGN_DIFF_GUARD_LIMITS), 'foreign-diff limits');
  for (const [key, ceiling] of Object.entries(FOREIGN_DIFF_GUARD_LIMITS)) {
    if (!Number.isSafeInteger(state.limits[key]) || state.limits[key] < 1 || state.limits[key] > ceiling) {
      guardError(`foreign-diff limit ${key} is invalid`, 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
  }
  if (state.status === 'blocked') {
    if (state.block === null || typeof state.block.code !== 'string' || typeof state.block.message !== 'string') {
      guardError('blocked foreign-diff guard lacks a block reason', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
  } else if (state.block !== null) {
    guardError('foreign-diff block exists outside blocked status', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  if (state.status === 'action_open' && state.open_action === null) {
    guardError('action_open guard lacks an action', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  if (state.status !== 'action_open' && state.open_action !== null) {
    guardError('foreign-diff action exists outside action_open', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  if (state.open_action !== null) {
    assertExactKeys(
      state.open_action,
      ['action_id', 'owned_paths', 'expected_changes', 'opened_at', 'before_inventory_sha256'],
      'foreign-diff open action',
    );
    if (!ACTION_ID.test(state.open_action.action_id) || !Array.isArray(state.open_action.owned_paths)) {
      guardError('foreign-diff open action is invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
    const ownedPaths = state.open_action.owned_paths.map((path) => safeRelativePath(path, 'foreign-diff owned path'));
    if (
      canonicalJson(ownedPaths) !== canonicalJson([...new Set(ownedPaths)].sort((left, right) => left.localeCompare(right, 'en')))
      || !Array.isArray(state.open_action.expected_changes)
      || !SHA256.test(state.open_action.before_inventory_sha256)
      || Number.isNaN(Date.parse(state.open_action.opened_at))
    ) {
      guardError('foreign-diff open action binding is invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
    const expectedPaths = [];
    for (const [index, change] of state.open_action.expected_changes.entries()) {
      assertExactKeys(
        change,
        ['path', 'before_sha256', 'after_kind', 'after_mode', 'after_size', 'after_sha256', 'after_inventory_sha256'],
        `foreign-diff expected change ${index}`,
      );
      const path = safeRelativePath(change.path, `foreign-diff expected change ${index} path`);
      if (
        (change.before_sha256 !== null && !SHA256.test(change.before_sha256))
        || (change.after_inventory_sha256 !== null && !SHA256.test(change.after_inventory_sha256))
        || !['file', 'symlink', 'missing'].includes(change.after_kind)
        || (change.after_kind === 'missing'
          ? (change.after_mode !== null || change.after_size !== 0 || change.after_sha256 !== null)
          : (!Number.isInteger(change.after_mode)
            || change.after_mode < 0
            || change.after_mode > 0o7777
            || !Number.isSafeInteger(change.after_size)
            || change.after_size < 0
            || !SHA256.test(change.after_sha256 ?? '')))
      ) {
        guardError('foreign-diff expected change is invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
      }
      expectedPaths.push(path);
    }
    if (canonicalJson(expectedPaths) !== canonicalJson(ownedPaths)) {
      guardError('foreign-diff expected changes must exactly match owned paths', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
  }
  if (state.status === 'waiting_user' && state.active_incident === null) {
    guardError('waiting_user guard lacks an incident', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  if (state.status !== 'waiting_user' && state.active_incident !== null) {
    guardError('foreign-diff incident exists outside waiting_user', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  if (state.active_incident !== null) {
    const incident = state.active_incident;
    assertExactKeys(incident, [
      'incident_id',
      'action_id',
      'status',
      'observed_at',
      'prior_inventory_sha256',
      'observed_inventory_sha256',
      'paths',
      'action_mismatch_paths',
      'foreign_paths',
      'accepted_agent_paths',
      'observed_inventory',
    ], 'foreign-diff active incident');
    if (!INCIDENT_ID.test(incident.incident_id) || incident.status !== 'waiting_user') {
      guardError('foreign-diff active incident identity is invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
    assertInventory(incident.observed_inventory, state.repository_root);
    if (
      incident.prior_inventory_sha256 !== state.checkpoint.inventory.sha256
      || incident.observed_inventory_sha256 !== incident.observed_inventory.sha256
      || !Array.isArray(incident.paths)
      || !Array.isArray(incident.foreign_paths)
      || !Array.isArray(incident.accepted_agent_paths)
    ) {
      guardError('foreign-diff active incident binding is invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
    if (!Array.isArray(incident.action_mismatch_paths)) {
      guardError('foreign-diff action mismatch paths are invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
    const observedChanges = inventoryChanges(state.checkpoint.inventory, incident.observed_inventory);
    const observedPaths = [...new Set([
      ...observedChanges.map(({ path }) => path),
      ...incident.action_mismatch_paths.map((path) => safeRelativePath(path, 'action mismatch path')),
    ])].sort((left, right) => left.localeCompare(right, 'en'));
    if (canonicalJson(incident.paths.map(({ path }) => path)) !== canonicalJson(observedPaths)) {
      guardError('foreign-diff incident path ledger is invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
    for (const pathRecord of incident.paths) {
      assertExactKeys(pathRecord, [
        'path',
        'before_kind',
        'before_sha256',
        'current_kind',
        'current_sha256',
        'attribution',
        'reason',
      ], 'foreign-diff incident path');
    }
    const accepted = new Set(incident.accepted_agent_paths);
    const expectedForeign = observedPaths.filter((path) => !accepted.has(path));
    if (canonicalJson(incident.foreign_paths) !== canonicalJson(expectedForeign)) {
      guardError('foreign-diff incident attribution is invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
  }
  state.history.forEach((entry, index) => {
    if (entry?.sequence !== index + 1 || typeof entry.action !== 'string' || typeof entry.at !== 'string') {
      guardError('foreign-diff history sequence is invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
  });
  if (state.history[0]?.sequence !== 1 || !['guard_created', 'guard_blocked'].includes(state.history[0]?.action)) {
    guardError('foreign-diff guard creation history is invalid', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  if (state.active_incident !== null) {
    const event = state.history.find((entry) => (
      entry.action === 'foreign_diff_detected'
      && entry.incident_id === state.active_incident.incident_id
      && entry.observed_inventory_sha256 === state.active_incident.observed_inventory_sha256
    ));
    if (!event) guardError('foreign-diff active incident conflicts with history', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  const expectedNextIncident = state.incidents.length + (state.active_incident === null ? 1 : 2);
  if (state.next_incident !== expectedNextIncident) {
    guardError('foreign-diff incident sequence conflicts with history', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  if (
    state.history.length === 0
    || state.history[0].at !== state.created_at
    || state.history.at(-1).at !== state.updated_at
    || state.history.some((entry) => Number.isNaN(Date.parse(entry.at)))
  ) {
    guardError('foreign-diff guard timestamps conflict with history', 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  return state;
}

function checkpointFromInventory(inventory, sequence, capturedAt) {
  return { sequence, captured_at: capturedAt, inventory };
}

function reconciledIncidentPathRecords(changes, accepted) {
  return changes.map((change) => ({
    path: change.path,
    before_kind: change.before?.kind
      ?? change.physical_before?.kind
      ?? (change.path.startsWith('/.cruise-meta/git/') ? 'git_identity' : 'clean_or_absent'),
    before_sha256: change.before_sha256,
    current_kind: change.current?.kind
      ?? change.physical_current?.kind
      ?? (change.path.startsWith('/.cruise-meta/git/') ? 'git_identity' : 'clean_or_absent'),
    current_sha256: change.current_sha256,
    attribution: accepted.has(change.path) ? 'cruise_action' : 'foreign_or_ambiguous',
    reason: accepted.has(change.path)
      ? 'exact action receipt and post-digest matched'
      : 'no exact current-run action receipt matched',
  }));
}

function reconcileRepositoryScope(state, now = null) {
  if (
    state.checkpoint === null
    || !['monitoring', 'waiting_user'].includes(state.status)
  ) return null;

  const prior = scopedInventory(state.checkpoint.inventory);
  const activeObserved = state.active_incident === null
    ? null
    : scopedInventory(state.active_incident.observed_inventory);
  const archivedPathsChanged = state.incidents.some((incident) => (
    incident.foreign_paths.some(isNonProductRepositoryPath)
    || incident.accepted_agent_paths.some(isNonProductRepositoryPath)
    || incident.resolution.outcome === 'retired_non_product'
  ));
  const inventoryChanged = prior.sha256 !== state.checkpoint.inventory.sha256
    || (activeObserved !== null
      && activeObserved.sha256 !== state.active_incident.observed_inventory.sha256);
  if (!inventoryChanged && !archivedPathsChanged) return null;

  const migrated = structuredClone(state);
  const at = timestamp(now);
  const current = captureProductInventory(migrated.repository_root, { limits: migrated.limits });
  const changes = inventoryChanges(prior, current);
  const originalActive = migrated.active_incident;
  const removedIncidentIds = new Set(originalActive === null ? [] : [originalActive.incident_id]);
  const retainedIncidentIds = new Map();
  const retainedIncidents = [];
  for (const incident of migrated.incidents) {
    const recordedPaths = [...incident.foreign_paths, ...incident.accepted_agent_paths];
    const spurious = incident.resolution.outcome === 'retired_non_product'
      || (recordedPaths.length > 0 && recordedPaths.every(isNonProductRepositoryPath));
    if (spurious) {
      removedIncidentIds.add(incident.incident_id);
      continue;
    }
    const incidentId = `FD-${String(retainedIncidents.length + 1).padStart(3, '0')}`;
    retainedIncidentIds.set(incident.incident_id, incidentId);
    retainedIncidents.push({
      ...incident,
      incident_id: incidentId,
      foreign_paths: incident.foreign_paths.filter((path) => !isNonProductRepositoryPath(path)),
      accepted_agent_paths: incident.accepted_agent_paths
        .filter((path) => !isNonProductRepositoryPath(path)),
    });
  }
  migrated.incidents = retainedIncidents;
  migrated.history = migrated.history
    .filter((entry) => (
      entry.action !== 'repository_scope_migrated'
      && !(entry.incident_id && removedIncidentIds.has(entry.incident_id))
    ))
    .map((entry) => ({
      ...entry,
      ...(entry.incident_id && retainedIncidentIds.has(entry.incident_id)
        ? { incident_id: retainedIncidentIds.get(entry.incident_id) }
        : {}),
    }))
    .map((entry, index) => ({ ...entry, sequence: index + 1 }));
  migrated.checkpoint = checkpointFromInventory(prior, migrated.checkpoint.sequence + 1, at);
  migrated.open_action = null;

  if (changes.length === 0) {
    migrated.checkpoint = checkpointFromInventory(current, migrated.checkpoint.sequence, at);
    migrated.status = 'monitoring';
    migrated.active_incident = null;
    migrated.next_incident = migrated.incidents.length + 1;
    migrated.updated_at = migrated.history.at(-1).at;
    return migrated;
  }

  const incidentId = `FD-${String(migrated.incidents.length + 1).padStart(3, '0')}`;
  const actionId = originalActive?.action_id ?? null;
  let accepted = new Set();
  if (originalActive !== null) {
    const changedPaths = new Set(changes.map(({ path }) => path));
    accepted = new Set(
      originalActive.accepted_agent_paths.filter((path) => changedPaths.has(path)),
    );
  }
  const paths = reconciledIncidentPathRecords(changes, accepted);
  migrated.status = 'waiting_user';
  migrated.active_incident = {
    incident_id: incidentId,
    action_id: actionId,
    status: 'waiting_user',
    observed_at: at,
    prior_inventory_sha256: prior.sha256,
    observed_inventory_sha256: current.sha256,
    paths,
    action_mismatch_paths: [],
    foreign_paths: paths.filter(({ path }) => !accepted.has(path)).map(({ path }) => path),
    accepted_agent_paths: [...accepted].sort((left, right) => left.localeCompare(right, 'en')),
    observed_inventory: current,
  };
  migrated.next_incident = migrated.incidents.length + 2;
  appendHistory(migrated, 'foreign_diff_detected', at, {
    incident_id: incidentId,
    foreign_path_count: migrated.active_incident.foreign_paths.length,
    observed_inventory_sha256: current.sha256,
    repository_scope_migrated: true,
  });
  return migrated;
}

async function readGuardStateFile(path, label) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 16 * 1024 * 1024) {
    guardError(`${label} must be a bounded regular file`, 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(metadata, opened)) {
      guardError(`${label} changed while being read`, 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileIdentity(opened, after) || bytes.length !== opened.size) {
      guardError(`${label} changed while being read`, 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return validateGuardState(parseYaml(source, { maxBytes: 16 * 1024 * 1024, maxNodes: 250_000 }));
  } finally {
    await handle.close();
  }
}

async function writeGuardStateFile(path, state, label) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      guardError(`${label} path is unsafe`, 'CRUISE_FOREIGN_DIFF_STATE_INVALID');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await writeYamlFile(path, state, { maxNodes: 250_000 });
}

export async function readForeignDiffGuardState(statePath) {
  const mirrorPath = resolve(statePath);
  const mirror = await readGuardStateFile(mirrorPath, 'foreign-diff guard mirror');
  const authorityPath = foreignDiffAuthorityPath(mirror.repository_root, mirror.run_id);
  const authority = await readGuardStateFile(authorityPath, 'foreign-diff guard authority');
  if (canonicalJson(mirror) !== canonicalJson(authority)) {
    guardError(
      'foreign-diff guard mirror differs from its host-owned authority; workers and writes remain paused',
      'CRUISE_FOREIGN_DIFF_AUTHORITY_MISMATCH',
    );
  }
  const migrated = reconcileRepositoryScope(authority);
  if (migrated === null) return authority;
  validateGuardState(migrated);
  await writeGuardStateFile(authorityPath, migrated, 'foreign-diff guard authority');
  await writeGuardStateFile(mirrorPath, migrated, 'foreign-diff guard mirror');
  return migrated;
}

export async function writeForeignDiffGuardState(statePath, state) {
  validateGuardState(state);
  const mirrorPath = resolve(statePath);
  const authorityPath = await prepareAuthorityDirectory(state.repository_root, state.run_id);
  // The host-owned authority commits first. A crash before the workspace mirror
  // update creates a detectable mismatch rather than granting stale authority.
  await writeGuardStateFile(authorityPath, state, 'foreign-diff guard authority');
  await writeGuardStateFile(mirrorPath, state, 'foreign-diff guard mirror');
  return state;
}

/**
 * Irreversibly close a clean terminal guard. The compact authority/mirror
 * ledger remains available for audit; no active, dirty, or action-open guard
 * can be finalized.
 */
export async function finalizeForeignDiffGuard({
  statePath,
  expectedInventorySha256,
  now = null,
} = {}) {
  if (!SHA256.test(expectedInventorySha256 ?? '')) {
    guardError(
      'terminal foreign-diff finalization requires the exact checkpoint inventory digest',
      'CRUISE_FOREIGN_DIFF_FINALIZE_INVALID',
    );
  }
  const state = structuredClone(await readForeignDiffGuardState(statePath));
  const alreadyFinalized = state.status === 'stopped'
    && state.history.at(-1)?.action === 'guard_finalized';
  if (alreadyFinalized) {
    if (state.checkpoint?.inventory?.sha256 !== expectedInventorySha256) {
      guardError(
        'terminal foreign-diff finalization digest differs from the finalized checkpoint',
        'CRUISE_FOREIGN_DIFF_FINALIZE_STALE',
      );
    }
    return { state, outcome: 'already_finalized', inventory: state.checkpoint.inventory };
  }
  if (
    state.status !== 'monitoring'
    || state.open_action !== null
    || state.active_incident !== null
    || state.block !== null
    || state.checkpoint === null
  ) {
    guardError(
      'only a clean monitoring foreign-diff guard can be finalized',
      'CRUISE_FOREIGN_DIFF_FINALIZE_STATE',
    );
  }
  if (state.checkpoint.inventory.sha256 !== expectedInventorySha256) {
    guardError(
      'terminal foreign-diff finalization digest is stale',
      'CRUISE_FOREIGN_DIFF_FINALIZE_STALE',
    );
  }
  const current = captureProductInventory(state.repository_root, { limits: state.limits });
  if (current.sha256 !== state.checkpoint.inventory.sha256) {
    guardError(
      'repository changed before terminal foreign-diff finalization; the guard remains active',
      'CRUISE_FOREIGN_DIFF_FINALIZE_DIRTY',
    );
  }
  const at = timestamp(now);
  state.status = 'stopped';
  appendHistory(state, 'guard_finalized', at, {
    inventory_sha256: current.sha256,
  });
  await writeForeignDiffGuardState(statePath, state);
  return { state, outcome: 'finalized', inventory: current };
}

export async function createForeignDiffGuard({
  statePath,
  runId,
  repositoryRoot,
  originPromptSha256,
  repositoryBaselineDigest,
  limits = FOREIGN_DIFF_GUARD_LIMITS,
  blockedReason = null,
  now = null,
}) {
  if (!RUN_ID.test(runId ?? '')) guardError('foreign-diff runId is invalid', 'CRUISE_FOREIGN_DIFF_INVALID');
  if (!SHA256.test(originPromptSha256 ?? '') || !SHA256.test(repositoryBaselineDigest ?? '')) {
    guardError('foreign-diff Origin digests are invalid', 'CRUISE_FOREIGN_DIFF_INVALID');
  }
  const root = canonicalRoot(repositoryRoot);
  await mkdir(dirname(resolve(statePath)), { recursive: true, mode: 0o700 });
  const at = timestamp(now);
  let inventory = null;
  let captureBlock = blockedReason;
  if (captureBlock === null) {
    try {
      inventory = captureProductInventory(root, { limits });
    } catch (error) {
      if (!(error instanceof ForeignDiffGuardError)) throw error;
      captureBlock = { code: error.code, message: error.message };
    }
  }
  const state = {
    schema_version: 2,
    kind: 'cruise_foreign_diff_guard',
    run_id: runId,
    repository_root: root,
    origin_prompt_sha256: originPromptSha256,
    repository_baseline_digest: repositoryBaselineDigest,
    status: captureBlock === null ? 'monitoring' : 'blocked',
    limits: { ...FOREIGN_DIFF_GUARD_LIMITS, ...limits },
    checkpoint: null,
    packet_bindings: [],
    open_action: null,
    active_incident: null,
    incidents: [],
    next_incident: 1,
    block: captureBlock,
    created_at: at,
    updated_at: at,
    history: [{ sequence: 1, action: captureBlock === null ? 'guard_created' : 'guard_blocked', at }],
  };
  if (inventory) state.checkpoint = checkpointFromInventory(inventory, 0, at);
  await writeForeignDiffGuardState(statePath, state);
  return state;
}

export async function bindForeignDiffWorkerPacket({
  statePath,
  packetPath,
  packetSha256,
  now = null,
} = {}) {
  const state = structuredClone(await readForeignDiffGuardState(statePath));
  requireMonitoring(state);
  if (!SHA256.test(packetSha256 ?? '')) {
    guardError('worker packet SHA-256 is invalid', 'CRUISE_FOREIGN_DIFF_PACKET_BINDING');
  }
  const absolute = resolve(packetPath ?? '');
  const relativePath = portable(relative(state.repository_root, absolute));
  if (
    relativePath.startsWith('../')
    || !relativePath.startsWith(`.cruise/runs/${state.run_id}/`)
    || relativePath.split('/').length !== 4
  ) {
    guardError('worker packet is outside its bound Cruise run', 'CRUISE_FOREIGN_DIFF_PACKET_BINDING');
  }
  const pathSha256 = sha256(Buffer.from(absolute, 'utf8'));
  const existing = state.packet_bindings.find((binding) => binding.relative_path === relativePath);
  if (existing) {
    if (existing.path_sha256 !== pathSha256 || existing.packet_sha256 !== packetSha256) {
      guardError(
        'worker packet bytes differ from the host-owned launch binding; inference remains paused',
        'CRUISE_FOREIGN_DIFF_PACKET_MISMATCH',
      );
    }
    return state;
  }
  const at = timestamp(now);
  state.packet_bindings.push({
    relative_path: relativePath,
    path_sha256: pathSha256,
    packet_sha256: packetSha256,
    bound_at: at,
  });
  state.packet_bindings.sort((left, right) => left.relative_path.localeCompare(right.relative_path, 'en'));
  appendHistory(state, 'worker_packet_bound', at, {
    relative_path: relativePath,
    packet_sha256: packetSha256,
  });
  await writeForeignDiffGuardState(statePath, state);
  return state;
}

async function persistIncident(statePath, state, {
  current,
  changes,
  acceptedAgentPaths = [],
  reasons = new Map(),
  actionId = null,
  now = null,
}) {
  const at = timestamp(now);
  changes = [...changes].sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const physicalChangePaths = new Set(
    inventoryChanges(state.checkpoint.inventory, current).map(({ path }) => path),
  );
  const accepted = new Set(acceptedAgentPaths);
  const foreign = changes.filter((change) => !accepted.has(change.path));
  const incidentId = `FD-${String(state.next_incident).padStart(3, '0')}`;
  const paths = changes.map((change) => ({
    path: change.path,
    before_kind: change.before?.kind
      ?? change.physical_before?.kind
      ?? (change.path.startsWith('/.cruise-meta/git/') ? 'git_identity' : 'clean_or_absent'),
    before_sha256: change.before_sha256,
    current_kind: change.current?.kind
      ?? change.physical_current?.kind
      ?? (change.path.startsWith('/.cruise-meta/git/') ? 'git_identity' : 'clean_or_absent'),
    current_sha256: change.current_sha256,
    attribution: accepted.has(change.path) ? 'cruise_action' : 'foreign_or_ambiguous',
    reason: accepted.has(change.path)
      ? 'exact action receipt and post-digest matched'
      : reasons.get(change.path) ?? 'no exact current-run action receipt matched',
  }));
  state.status = 'waiting_user';
  state.open_action = null;
  state.active_incident = {
    incident_id: incidentId,
    action_id: actionId,
    status: 'waiting_user',
    observed_at: at,
    prior_inventory_sha256: state.checkpoint.inventory.sha256,
    observed_inventory_sha256: current.sha256,
    paths,
    action_mismatch_paths: changes
      .filter(({ path }) => !physicalChangePaths.has(path))
      .map(({ path }) => path),
    foreign_paths: foreign.map((change) => change.path),
    accepted_agent_paths: [...accepted].sort((left, right) => left.localeCompare(right, 'en')),
    observed_inventory: current,
  };
  state.next_incident += 1;
  appendHistory(state, 'foreign_diff_detected', at, {
    incident_id: incidentId,
    foreign_path_count: foreign.length,
    observed_inventory_sha256: current.sha256,
  });
  await writeForeignDiffGuardState(statePath, state);
  return { state, outcome: 'waiting_user', incident: state.active_incident };
}

function requireMonitoring(state) {
  if (state.status !== 'monitoring') {
    guardError(`foreign-diff guard is ${state.status}; workers and writes remain paused`, 'CRUISE_FOREIGN_DIFF_PAUSED');
  }
}

async function captureInventoryOrBlock(statePath, state, now = null) {
  try {
    return captureProductInventory(state.repository_root, { limits: state.limits });
  } catch (error) {
    if (!(error instanceof ForeignDiffGuardError)) throw error;
    const at = timestamp(now);
    state.status = 'blocked';
    state.open_action = null;
    state.active_incident = null;
    state.block = {
      code: error.code,
      message: `${error.message}; repository bytes were left untouched and user intent is required`,
    };
    appendHistory(state, 'inventory_capture_blocked', at, { code: error.code });
    await writeForeignDiffGuardState(statePath, state);
    throw error;
  }
}

export async function checkForForeignDiff({ statePath, now = null } = {}) {
  const state = structuredClone(await readForeignDiffGuardState(statePath));
  requireMonitoring(state);
  const current = await captureInventoryOrBlock(statePath, state, now);
  const changes = inventoryChanges(state.checkpoint.inventory, current);
  if (changes.length === 0) return { state, outcome: 'clean', inventory: current };
  return persistIncident(statePath, state, { current, changes, now });
}

async function snapshotTarget(root, relativePath, limits) {
  const path = safeRelativePath(relativePath, 'snapshot path');
  const target = resolve(root, path);
  let metadata;
  try {
    metadata = await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { kind: 'missing', mode: null, size: 0, sha256: null };
    }
    throw error;
  }
  const mode = metadata.mode & 0o7777;
  if (metadata.isSymbolicLink()) {
    const bytes = await readlink(target, { encoding: 'buffer' });
    const after = await lstat(target);
    if (!after.isSymbolicLink() || !sameFileIdentity(metadata, after)) {
      guardError(`snapshot target changed while reading ${path}`, 'CRUISE_FOREIGN_DIFF_RACE');
    }
    if (bytes.length > limits.file_max_bytes || bytes.length > limits.total_max_bytes) {
      guardError(`snapshot target exceeds the foreign-diff byte limit: ${path}`, 'CRUISE_FOREIGN_DIFF_FILE_LIMIT');
    }
    return { kind: 'symlink', mode, size: bytes.length, sha256: sha256(bytes) };
  }
  if (metadata.isDirectory()) return { kind: 'directory', mode, size: 0, sha256: null };
  if (!metadata.isFile()) return { kind: 'special', mode, size: 0, sha256: null };
  if (metadata.size > limits.file_max_bytes || metadata.size > limits.total_max_bytes) {
    guardError(`snapshot target exceeds the foreign-diff byte limit: ${path}`, 'CRUISE_FOREIGN_DIFF_FILE_LIMIT');
  }
  const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(metadata, opened)) {
      guardError(`snapshot target changed while opening ${path}`, 'CRUISE_FOREIGN_DIFF_RACE');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileIdentity(opened, after) || bytes.length !== opened.size) {
      guardError(`snapshot target changed while reading ${path}`, 'CRUISE_FOREIGN_DIFF_RACE');
    }
    return { kind: 'file', mode, size: bytes.length, sha256: sha256(bytes) };
  } finally {
    await handle.close();
  }
}

function projectionError(message, code = 'CRUISE_FOREIGN_DIFF_PROJECTION') {
  guardError(message, code);
}

function normalizeProjectionChanges(changes, limits) {
  if (!Array.isArray(changes) || changes.length === 0) {
    projectionError('foreign-diff projection changes must be a non-empty array');
  }
  const seen = new Set();
  let totalBytes = 0;
  return changes.map((change, index) => {
    assertExactKeys(change, ['path', 'kind', 'mode', 'bytes'], `projection changes[${index}]`);
    const path = safeRelativePath(change.path, `projection changes[${index}].path`);
    if (seen.has(path)) projectionError('foreign-diff projection paths must be unique');
    seen.add(path);
    if (!['file', 'symlink', 'missing'].includes(change.kind)) {
      projectionError(`foreign-diff projection kind is invalid for ${path}`);
    }
    if (change.kind === 'missing') {
      if (change.mode !== null || change.bytes !== null) {
        projectionError(`missing projection must use null mode and bytes for ${path}`);
      }
      return { path, kind: 'missing', mode: null, bytes: null };
    }
    if (
      !Number.isInteger(change.mode)
      || change.mode < 0
      || change.mode > 0o7777
      || !(change.bytes instanceof Uint8Array)
    ) {
      projectionError(`file and symlink projections require an exact mode and in-memory bytes for ${path}`);
    }
    const bytes = Buffer.from(change.bytes);
    if (bytes.length > limits.file_max_bytes) {
      projectionError(
        `foreign-diff projection exceeds ${limits.file_max_bytes} bytes for ${path}`,
        'CRUISE_FOREIGN_DIFF_FILE_LIMIT',
      );
    }
    totalBytes += bytes.length;
    if (totalBytes > limits.total_max_bytes) {
      projectionError(
        `foreign-diff projection exceeds ${limits.total_max_bytes} content bytes`,
        'CRUISE_FOREIGN_DIFF_TOTAL_LIMIT',
      );
    }
    return { path, kind: change.kind, mode: change.mode, bytes };
  }).sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

async function assertSafeProjectionParent(root, path) {
  let parent = root;
  for (const piece of path.split('/').slice(0, -1)) {
    parent = join(parent, piece);
    let metadata;
    try {
      metadata = await lstat(parent);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        projectionError(
          `foreign-diff projection parent is missing for ${path}`,
          'CRUISE_FOREIGN_DIFF_PROJECTION_PARENT',
        );
      }
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(parent) !== parent) {
      projectionError(
        `foreign-diff projection parent is unsafe for ${path}`,
        'CRUISE_FOREIGN_DIFF_PROJECTION_PARENT',
      );
    }
  }
}

function assertProjectionPathIsNotIgnored(root, path, limits) {
  const result = runGit(root, ['check-ignore', '--no-index', '-q', '--', path], limits, { required: false });
  if (result.status === 0) {
    projectionError(`ignored path cannot be projected safely: ${path}`, 'CRUISE_FOREIGN_DIFF_PROJECTION_IGNORED');
  }
  if (result.status !== 1) {
    projectionError(`Git could not establish ignore state for ${path}`, 'CRUISE_FOREIGN_DIFF_PROJECTION_IGNORED');
  }
}

function assertProjectionPathHasNoTransform(root, path, limits) {
  const result = runGit(root, ['check-attr', '-z', '--all', '--', path], limits);
  const fields = nulPaths(result.stdout);
  if (fields.length % 3 !== 0) {
    projectionError('Git returned malformed attribute metadata', 'CRUISE_FOREIGN_DIFF_PROJECTION_FILTER');
  }
  const transforming = new Set(['filter', 'ident', 'text', 'eol', 'working-tree-encoding']);
  for (let index = 0; index < fields.length; index += 3) {
    const [reportedPath, attribute, value] = fields.slice(index, index + 3);
    if (reportedPath !== path) {
      projectionError('Git returned an unexpected attribute path', 'CRUISE_FOREIGN_DIFF_PROJECTION_FILTER');
    }
    if (transforming.has(attribute) && !['unspecified', 'unset'].includes(value)) {
      projectionError(
        `Git content transform ${attribute}=${value} prevents a pure projection for ${path}`,
        'CRUISE_FOREIGN_DIFF_PROJECTION_FILTER',
      );
    }
  }
}

function assertProjectionIndexFlags(root, path, records, limits) {
  const result = runGit(root, ['ls-files', '-v', '-z', '--', path], limits);
  const flags = nulPaths(result.stdout);
  if (records.length === 0) {
    if (flags.length !== 0) {
      projectionError(`ambiguous Git index state prevents projection for ${path}`, 'CRUISE_FOREIGN_DIFF_PROJECTION_INDEX');
    }
    return;
  }
  if (
    flags.length !== 1
    || flags[0].slice(2) !== path
    || flags[0][1] !== ' '
    || flags[0][0] !== 'H'
  ) {
    projectionError(
      `assume-unchanged, skip-worktree, or ambiguous index state prevents projection for ${path}`,
      'CRUISE_FOREIGN_DIFF_PROJECTION_INDEX',
    );
  }
}

function gitBlobObject(bytes, objectFormat) {
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return createHash(objectFormat).update(header).update(bytes).digest('hex');
}

function projectedInventoryEntry({
  path,
  intent,
  records,
  currentEntry,
  objectFormat,
  fileMode,
  symlinks,
}) {
  const physical = intent.kind === 'missing'
    ? { kind: 'missing', mode: null, size: 0, sha256: null }
    : {
        kind: intent.kind,
        mode: intent.mode,
        size: intent.bytes.length,
        sha256: sha256(intent.bytes),
      };
  if (records.length === 0) {
    if (intent.kind === 'missing') return { physical, entry: null };
    return {
      physical,
      entry: {
        path,
        ...physical,
        worktree_changed: false,
        index_changed: false,
        untracked: true,
        index: [],
      },
    };
  }
  if (records.length !== 1 || records[0].stage !== 0) {
    projectionError(`unmerged Git index state prevents projection for ${path}`, 'CRUISE_FOREIGN_DIFF_PROJECTION_INDEX');
  }
  const index = records[0];
  if (index.mode === '160000') {
    projectionError(`gitlink projection is unsafe for ${path}`, 'CRUISE_FOREIGN_DIFF_PROJECTION_GITLINK');
  }
  if (!['100644', '100755', '120000'].includes(index.mode) || /^0+$/u.test(index.object)) {
    projectionError(`ambiguous Git index entry prevents projection for ${path}`, 'CRUISE_FOREIGN_DIFF_PROJECTION_INDEX');
  }
  if (intent.kind === 'symlink' && symlinks === false) {
    projectionError(`core.symlinks=false prevents an exact symlink projection for ${path}`, 'CRUISE_FOREIGN_DIFF_PROJECTION_FILTER');
  }
  let matchesIndex = false;
  if (intent.kind !== 'missing') {
    const objectMatches = gitBlobObject(intent.bytes, objectFormat) === index.object;
    if (index.mode === '120000') {
      matchesIndex = intent.kind === 'symlink' && objectMatches;
    } else if (intent.kind === 'file') {
      const executableMatches = fileMode === false
        || ((intent.mode & 0o111) !== 0) === (index.mode === '100755');
      matchesIndex = objectMatches && executableMatches;
    }
  }
  const worktreeChanged = !matchesIndex;
  const indexChanged = currentEntry?.index_changed === true;
  if (!worktreeChanged && !indexChanged) return { physical, entry: null };
  return {
    physical,
    entry: {
      path,
      ...physical,
      worktree_changed: worktreeChanged,
      index_changed: indexChanged,
      untracked: false,
      index: structuredClone(records),
    },
  };
}

function assertProjectionCheckpoint(state, current, label = 'projection') {
  if (state.status !== 'monitoring' || state.checkpoint === null) {
    projectionError(
      `foreign-diff ${label} requires a monitoring guard with a checkpoint`,
      'CRUISE_FOREIGN_DIFF_PROJECTION_STATE',
    );
  }
  if (current.sha256 !== state.checkpoint.inventory.sha256) {
    projectionError(
      `repository drifted from the state-bound checkpoint before ${label}; product bytes were left untouched`,
      'CRUISE_FOREIGN_DIFF_PROJECTION_STALE',
    );
  }
  if (current.kind !== 'git') {
    projectionError('pure foreign-diff projection requires a Git repository', 'CRUISE_FOREIGN_DIFF_PROJECTION_GIT');
  }
}

export async function projectCruiseAction({
  statePath,
  actionId,
  changes = [],
} = {}) {
  if (!ACTION_ID.test(actionId ?? '')) {
    projectionError('foreign-diff projection actionId is invalid');
  }
  const state = structuredClone(await readForeignDiffGuardState(statePath));
  const current = captureProductInventory(state.repository_root, { limits: state.limits });
  assertProjectionCheckpoint(state, current);
  const intents = normalizeProjectionChanges(changes, state.limits);
  const index = indexEntries(state.repository_root, state.limits);
  assertInitializedGitlinksClean(state.repository_root, index, state.limits);
  const objectFormat = gitIdentity(
    state.repository_root,
    ['rev-parse', '--show-object-format'],
    state.limits,
  ) ?? 'sha1';
  if (!['sha1', 'sha256'].includes(objectFormat)) {
    projectionError(`unsupported Git object format: ${objectFormat}`, 'CRUISE_FOREIGN_DIFF_PROJECTION_GIT');
  }
  const autoCrlf = gitIdentity(state.repository_root, ['config', '--get', 'core.autocrlf'], state.limits);
  if (autoCrlf !== null && !['false', 'no', 'off', '0'].includes(autoCrlf.toLowerCase())) {
    projectionError('core.autocrlf prevents a byte-exact pure projection', 'CRUISE_FOREIGN_DIFF_PROJECTION_FILTER');
  }
  const fileMode = gitIdentity(state.repository_root, ['config', '--bool', '--get', 'core.filemode'], state.limits) !== 'false';
  const symlinks = gitIdentity(state.repository_root, ['config', '--bool', '--get', 'core.symlinks'], state.limits) !== 'false';
  const currentEntries = new Map(current.entries.map((entry) => [entry.path, entry]));
  const projectedEntries = new Map(current.entries.map((entry) => [entry.path, structuredClone(entry)]));
  const currentTrackedPhysical = new Map(
    current.tracked_physical.map((entry) => [entry.path, entry]),
  );
  const projectedTrackedPhysical = new Map(
    current.tracked_physical.map((entry) => [entry.path, structuredClone(entry)]),
  );
  const expectedChanges = [];
  for (const intent of intents) {
    if (intent.path.endsWith('.gitignore') || intent.path.endsWith('.gitattributes')) {
      projectionError(
        `Git policy source cannot be projected as an ordinary action path: ${intent.path}`,
        'CRUISE_FOREIGN_DIFF_PROJECTION_FILTER',
      );
    }
    await assertSafeProjectionParent(state.repository_root, intent.path);
    const currentTarget = await snapshotTarget(state.repository_root, intent.path, state.limits);
    if (['directory', 'special'].includes(currentTarget.kind)) {
      projectionError(
        `directory or special-path state prevents projection for ${intent.path}`,
        'CRUISE_FOREIGN_DIFF_PROJECTION_DIRECTORY',
      );
    }
    const records = index.get(intent.path) ?? [];
    // Ignore rules can match an already tracked stage-0 path without hiding it
    // from Git. They are unsafe only for an index-absent result whose future
    // worktree state would otherwise disappear from the guarded inventory.
    if (records.length === 0) {
      assertProjectionPathIsNotIgnored(state.repository_root, intent.path, state.limits);
    }
    assertProjectionPathHasNoTransform(state.repository_root, intent.path, state.limits);
    assertProjectionIndexFlags(state.repository_root, intent.path, records, state.limits);
    const currentEntry = currentEntries.get(intent.path) ?? null;
    if (currentEntry !== null && canonicalJson(currentEntry.index) !== canonicalJson(records)) {
      projectionError(
        `Git index changed while projecting ${intent.path}`,
        'CRUISE_FOREIGN_DIFF_PROJECTION_STALE',
      );
    }
    const projected = projectedInventoryEntry({
      path: intent.path,
      intent,
      records,
      currentEntry,
      objectFormat,
      fileMode,
      symlinks,
    });
    if (projected.entry === null) projectedEntries.delete(intent.path);
    else projectedEntries.set(intent.path, projected.entry);
    if (records.length > 0) {
      const currentPhysical = currentTrackedPhysical.get(intent.path);
      if (currentPhysical === undefined) {
        projectionError(
          `tracked physical metadata is missing for ${intent.path}`,
          'CRUISE_FOREIGN_DIFF_PROJECTION_STALE',
        );
      }
      projectedTrackedPhysical.set(intent.path, {
        path: intent.path,
        kind: projected.physical.kind,
        mode: projected.physical.mode,
      });
    }
    const beforeSha256 = currentEntry === null ? null : inventoryEntryDigest(currentEntry);
    const afterInventorySha256 = projected.entry === null ? null : inventoryEntryDigest(projected.entry);
    if (
      beforeSha256 === afterInventorySha256
      && canonicalJson(currentTrackedPhysical.get(intent.path) ?? null)
        === canonicalJson(projectedTrackedPhysical.get(intent.path) ?? null)
    ) {
      projectionError(`projection does not change the guarded inventory for ${intent.path}`);
    }
    expectedChanges.push({
      path: intent.path,
      before_sha256: beforeSha256,
      after_kind: projected.physical.kind,
      after_mode: projected.physical.mode,
      after_size: projected.physical.size,
      after_sha256: projected.physical.sha256,
      after_inventory_sha256: afterInventorySha256,
    });
  }
  const projectedValues = [...projectedEntries.values()]
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
  if (
    projectedValues.length > state.limits.max_entries
    || projectedValues.reduce((total, entry) => total + entry.size, 0) > state.limits.total_max_bytes
  ) {
    projectionError('projected inventory exceeds the foreign-diff limits', 'CRUISE_FOREIGN_DIFF_TOTAL_LIMIT');
  }
  const projectedDirectories = captureGitDirectoryMetadata(
    state.repository_root,
    new Set([...index.keys(), ...projectedEntries.keys()]),
    state.limits,
  );
  if (canonicalJson(projectedDirectories) !== canonicalJson(current.directories)) {
    projectionError(
      'projection would change the guarded directory-metadata ledger',
      'CRUISE_FOREIGN_DIFF_PROJECTION_DIRECTORY',
    );
  }
  const projectedPhysicalValues = [...projectedTrackedPhysical.values()]
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
  if (projectedPhysicalValues.length !== current.tracked_physical.length) {
    projectionError(
      'projection would change the tracked physical path set',
      'CRUISE_FOREIGN_DIFF_PROJECTION_INDEX',
    );
  }
  const finalInventory = captureProductInventory(state.repository_root, { limits: state.limits });
  assertProjectionCheckpoint(state, finalInventory, 'projection completion');
  const finalIndex = indexEntries(state.repository_root, state.limits);
  if (canonicalJson(indexLedger(finalIndex)) !== canonicalJson(indexLedger(index))) {
    projectionError(
      'Git index changed during projection',
      'CRUISE_FOREIGN_DIFF_PROJECTION_STALE',
    );
  }
  for (const intent of intents) {
    assertProjectionIndexFlags(
      state.repository_root,
      intent.path,
      finalIndex.get(intent.path) ?? [],
      state.limits,
    );
  }
  const finalState = await readForeignDiffGuardState(statePath);
  if (canonicalJson(finalState) !== canonicalJson(state)) {
    projectionError(
      'foreign-diff guard state changed during projection',
      'CRUISE_FOREIGN_DIFF_PROJECTION_STALE',
    );
  }
  return {
    schema_version: 1,
    kind: 'cruise_change_action',
    action_id: actionId,
    owned_paths: intents.map(({ path }) => path),
    expected_changes: expectedChanges,
  };
}

function normalizeExpectedChanges(expectedChanges, ownedPaths, checkpoint) {
  if (!Array.isArray(expectedChanges)) {
    guardError('foreign-diff expectedChanges must be an array', 'CRUISE_FOREIGN_DIFF_ACTION');
  }
  const owned = new Set(ownedPaths);
  const beforeEntries = new Map(checkpoint.inventory.entries.map((entry) => [entry.path, entry]));
  const seen = new Set();
  const normalized = expectedChanges.map((entry, index) => {
    assertExactKeys(
      entry,
      ['path', 'before_sha256', 'after_kind', 'after_mode', 'after_size', 'after_sha256', 'after_inventory_sha256'],
      `expectedChanges[${index}]`,
    );
    const path = safeRelativePath(entry.path, `expectedChanges[${index}].path`);
    const expectedBefore = beforeEntries.has(path)
      ? inventoryEntryDigest(beforeEntries.get(path))
      : null;
    if (!owned.has(path) || seen.has(path) || entry.before_sha256 !== expectedBefore) {
      guardError(
        'foreign-diff expected changes must be unique, exactly owned, and bound to the open checkpoint',
        'CRUISE_FOREIGN_DIFF_ACTION',
      );
    }
    if (
      !['file', 'symlink', 'missing'].includes(entry.after_kind)
      || (entry.after_inventory_sha256 !== null && !SHA256.test(entry.after_inventory_sha256))
      || (entry.after_kind === 'missing'
        ? (entry.after_mode !== null || entry.after_size !== 0 || entry.after_sha256 !== null)
        : (!Number.isInteger(entry.after_mode)
          || entry.after_mode < 0
          || entry.after_mode > 0o7777
          || !Number.isSafeInteger(entry.after_size)
          || entry.after_size < 0
          || !SHA256.test(entry.after_sha256 ?? '')))
    ) {
      guardError('foreign-diff expected physical result is invalid', 'CRUISE_FOREIGN_DIFF_ACTION');
    }
    seen.add(path);
    return {
      path,
      before_sha256: entry.before_sha256,
      after_kind: entry.after_kind,
      after_mode: entry.after_mode,
      after_size: entry.after_size,
      after_sha256: entry.after_sha256,
      after_inventory_sha256: entry.after_inventory_sha256,
    };
  }).sort((left, right) => left.path.localeCompare(right.path, 'en'));
  if (seen.size !== owned.size) {
    guardError('foreign-diff expected changes must exactly cover owned paths', 'CRUISE_FOREIGN_DIFF_ACTION');
  }
  return normalized;
}

export async function beginCruiseAction({
  statePath,
  actionId,
  ownedPaths = [],
  expectedChanges = [],
  now = null,
} = {}) {
  const state = structuredClone(await readForeignDiffGuardState(statePath));
  requireMonitoring(state);
  if (!ACTION_ID.test(actionId ?? '')) guardError('foreign-diff actionId is invalid', 'CRUISE_FOREIGN_DIFF_ACTION');
  if (!Array.isArray(ownedPaths)) guardError('foreign-diff ownedPaths must be an array', 'CRUISE_FOREIGN_DIFF_ACTION');
  const paths = ownedPaths
    .map((path, index) => safeRelativePath(path, `ownedPaths[${index}]`))
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (new Set(paths).size !== paths.length) guardError('foreign-diff ownedPaths must be unique', 'CRUISE_FOREIGN_DIFF_ACTION');
  const expected = normalizeExpectedChanges(expectedChanges, paths, state.checkpoint);
  const current = await captureInventoryOrBlock(statePath, state, now);
  const changes = inventoryChanges(state.checkpoint.inventory, current);
  if (changes.length > 0) return persistIncident(statePath, state, { current, changes, now });
  const at = timestamp(now);
  state.status = 'action_open';
  state.open_action = {
    action_id: actionId,
    owned_paths: paths,
    expected_changes: expected,
    opened_at: at,
    before_inventory_sha256: current.sha256,
  };
  appendHistory(state, 'action_opened', at, { action_id: actionId, owned_path_count: paths.length });
  await writeForeignDiffGuardState(statePath, state);
  return { state, outcome: 'action_open' };
}

function normalizeReceipt(receipt, action) {
  if (!receipt || receipt.schema_version !== 1 || receipt.kind !== 'cruise_change_receipt') {
    guardError('foreign-diff receipt is invalid', 'CRUISE_FOREIGN_DIFF_RECEIPT');
  }
  if (receipt.action_id !== action.action_id || !Array.isArray(receipt.changes)) {
    guardError('foreign-diff receipt action binding is invalid', 'CRUISE_FOREIGN_DIFF_RECEIPT');
  }
  const owned = new Set(action.owned_paths);
  const seen = new Set();
  const records = receipt.changes.map((entry, index) => {
    assertExactKeys(entry, ['path', 'before_sha256', 'after_sha256'], `receipt.changes[${index}]`);
    const path = safeRelativePath(entry.path, `receipt.changes[${index}].path`);
    if (!owned.has(path) || seen.has(path)) {
      guardError('foreign-diff receipt paths must be unique and exactly owned', 'CRUISE_FOREIGN_DIFF_RECEIPT');
    }
    if (
      (entry.before_sha256 !== null && !SHA256.test(entry.before_sha256))
      || (entry.after_sha256 !== null && !SHA256.test(entry.after_sha256))
    ) {
      guardError('foreign-diff receipt digests are invalid', 'CRUISE_FOREIGN_DIFF_RECEIPT');
    }
    seen.add(path);
    return { path, before_sha256: entry.before_sha256, after_sha256: entry.after_sha256 };
  });
  if (seen.size !== owned.size) {
    guardError('foreign-diff receipt must exactly cover the predeclared expected changes', 'CRUISE_FOREIGN_DIFF_RECEIPT');
  }
  return records;
}

export async function completeCruiseAction({ statePath, receipt, now = null } = {}) {
  const state = structuredClone(await readForeignDiffGuardState(statePath));
  if (state.status !== 'action_open') {
    guardError('no foreign-diff action is open', 'CRUISE_FOREIGN_DIFF_ACTION_STATE');
  }
  const records = normalizeReceipt(receipt, state.open_action);
  const current = await captureInventoryOrBlock(statePath, state, now);
  const changes = inventoryChanges(state.checkpoint.inventory, current);
  const evaluatedChanges = [...changes];
  const changed = new Map(changes.map((entry) => [entry.path, entry]));
  const expected = new Map(state.open_action.expected_changes.map((entry) => [entry.path, entry]));
  const accepted = new Set();
  const reasons = new Map();
  for (const record of records) {
    const observed = changed.get(record.path);
    if (!observed) {
      const beforeEntry = state.checkpoint.inventory.entries.find((entry) => entry.path === record.path) ?? null;
      const currentEntry = current.entries.find((entry) => entry.path === record.path) ?? null;
      evaluatedChanges.push({
        path: record.path,
        before_sha256: beforeEntry ? inventoryEntryDigest(beforeEntry) : null,
        current_sha256: currentEntry ? inventoryEntryDigest(currentEntry) : null,
        before: beforeEntry,
        current: currentEntry,
      });
      reasons.set(record.path, 'predeclared action result was not observed');
      continue;
    }
    const declaration = expected.get(record.path);
    const physical = await snapshotTarget(state.repository_root, record.path, state.limits);
    const physicalMatches = physical.kind === declaration.after_kind
      && physical.mode === declaration.after_mode
      && physical.size === declaration.after_size
      && physical.sha256 === declaration.after_sha256;
    if (
      record.before_sha256 === declaration.before_sha256
      && observed.before_sha256 === declaration.before_sha256
      && record.after_sha256 === declaration.after_inventory_sha256
      && observed.current_sha256 === declaration.after_inventory_sha256
      && physicalMatches
    ) {
      accepted.add(record.path);
    } else {
      reasons.set(record.path, 'predeclared before/physical result or receipt digest did not match observed bytes');
    }
  }
  for (const change of evaluatedChanges) {
    if (accepted.has(change.path)) continue;
    if (!reasons.has(change.path)) {
      reasons.set(
        change.path,
        state.open_action.owned_paths.includes(change.path)
          ? 'owned path changed without an exact matching action receipt'
          : 'path changed outside declared action ownership',
      );
    }
  }
  if (accepted.size !== evaluatedChanges.length || accepted.size !== records.length) {
    return persistIncident(statePath, state, {
      current,
      changes: evaluatedChanges,
      acceptedAgentPaths: [...accepted],
      reasons,
      actionId: state.open_action.action_id,
      now,
    });
  }
  const at = timestamp(now);
  state.checkpoint = checkpointFromInventory(current, state.checkpoint.sequence + 1, at);
  const actionId = state.open_action.action_id;
  state.status = 'monitoring';
  state.open_action = null;
  appendHistory(state, 'action_completed', at, {
    action_id: actionId,
    accepted_path_count: accepted.size,
    inventory_sha256: current.sha256,
  });
  await writeForeignDiffGuardState(statePath, state);
  return { state, outcome: 'accepted', inventory: current };
}

function archiveIncident(state, incident, { selection, decisionId, at, outcome, error = null }) {
  state.incidents.push({
    incident_id: incident.incident_id,
    action_id: incident.action_id,
    observed_at: incident.observed_at,
    observed_inventory_sha256: incident.observed_inventory_sha256,
    foreign_paths: [...incident.foreign_paths],
    accepted_agent_paths: [...incident.accepted_agent_paths],
    resolution: {
      selection,
      decision_id: decisionId,
      at,
      outcome,
      error,
    },
  });
}

async function refreshStaleIncident(statePath, state, incident, current, decisionId, now) {
  const at = timestamp(now);
  archiveIncident(state, incident, {
    selection: 'stale_refresh',
    decisionId,
    at,
    outcome: 'superseded_by_new_drift',
  });
  state.status = 'monitoring';
  state.active_incident = null;
  appendHistory(state, 'incident_superseded', at, {
    incident_id: incident.incident_id,
    decision_id: decisionId,
    observed_inventory_sha256: current.sha256,
  });
  const changes = inventoryChanges(state.checkpoint.inventory, current);
  if (changes.length === 0) {
    await writeForeignDiffGuardState(statePath, state);
    return { state, outcome: 'superseded_clean', incident: null };
  }
  return persistIncident(statePath, state, { current, changes, now: at });
}
export async function resolveForeignDiffIncident({
  statePath,
  incidentId,
  decisionId,
  selection,
  now = null,
} = {}) {
  const state = structuredClone(await readForeignDiffGuardState(statePath));
  if (state.status !== 'waiting_user' || state.active_incident?.incident_id !== incidentId) {
    guardError('foreign-diff incident is not the active paused incident', 'CRUISE_FOREIGN_DIFF_INCIDENT_STATE');
  }
  if (!INCIDENT_ID.test(incidentId ?? '') || !DECISION_ID.test(decisionId ?? '')) {
    guardError('foreign-diff resolution identity is invalid', 'CRUISE_FOREIGN_DIFF_RESOLUTION');
  }
  if (!['preserve_and_continue', 'stop_unchanged'].includes(selection)) {
    guardError('foreign-diff resolution selection is invalid', 'CRUISE_FOREIGN_DIFF_RESOLUTION');
  }
  const incident = state.active_incident;
  const at = timestamp(now);

  if (selection === 'stop_unchanged') {
    archiveIncident(state, incident, { selection, decisionId, at, outcome: 'stopped_unchanged' });
    state.status = 'stopped';
    state.active_incident = null;
    appendHistory(state, 'incident_stopped_unchanged', at, { incident_id: incidentId, decision_id: decisionId });
    await writeForeignDiffGuardState(statePath, state);
    return { state, outcome: 'stopped_unchanged' };
  }

  const current = captureProductInventory(state.repository_root, { limits: state.limits });
  if (current.sha256 !== incident.observed_inventory_sha256) {
    const refreshed = await refreshStaleIncident(statePath, state, incident, current, decisionId, at);
    throw new ForeignDiffGuardError(
      refreshed.incident
        ? `repository changed again; ${refreshed.incident.incident_id} now requires a new user intent decision`
        : 'repository returned to the accepted checkpoint; the stale incident was closed without changing bytes',
      { code: 'CRUISE_FOREIGN_DIFF_STALE_INCIDENT' },
    );
  }

  state.checkpoint = checkpointFromInventory(current, state.checkpoint.sequence + 1, at);
  archiveIncident(state, incident, { selection, decisionId, at, outcome: 'preserved' });
  state.status = 'monitoring';
  state.active_incident = null;
  appendHistory(state, 'incident_preserved', at, {
    incident_id: incidentId,
    decision_id: decisionId,
    inventory_sha256: current.sha256,
  });
  await writeForeignDiffGuardState(statePath, state);
  return { state, outcome: 'preserved', inventory: current };
}
