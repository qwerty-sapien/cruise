import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, opendir, readFile, readlink, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

import { DEFAULT_STALL } from './flight-plan.mjs';

const execFileAsync = promisify(execFile);
const FAILURE_LINE = /\b(?:error|fail(?:ed|ure)?|exception|panic|traceback)\b/iu;
export const MAX_SUPERVISOR_HISTORY = 32;
export const SUPERVISOR_STATE_FILE = '.supervisor.json';
export const NON_GIT_FINGERPRINT_LIMITS = Object.freeze({
  entries: 10_000,
  bytes: 64 * 1024 * 1024,
  ignoreBytes: 64 * 1024,
  pathBytes: 1024 * 1024,
  depth: 32,
  elapsedMs: 10_000,
});
let atomicSequence = 0;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function short(value) {
  return value ? value.slice(0, 12) : 'unavailable';
}

function assertThreshold(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function remember(set, value) {
  set.delete(value);
  set.add(value);
  while (set.size > MAX_SUPERVISOR_HISTORY) set.delete(set.values().next().value);
}

export class GoalSupervisor {
  constructor({ stall = DEFAULT_STALL, now = Date.now, maxTurns = null } = {}) {
    this.stall = null;
    this.updateStall(stall);
    this.now = now;
    if (maxTurns !== null && (!Number.isSafeInteger(maxTurns) || maxTurns < 1)) {
      throw new TypeError('maxTurns must be a positive integer or null');
    }
    this.maxTurns = maxTurns;
    this.createdAt = this.now();
    this.updatedAt = this.createdAt;
    this.turnsObserved = 0;
    this.turnsInCycle = 0;
    this.quietTurns = 0;
    this.sameFailure = 0;
    this.previousFingerprint = null;
    this.previousFailure = null;
    this.seenFingerprints = new Set();
    this.seenFailures = new Set();
    this.stage = 'observing';
    this.interventions = [];
    this.observations = [];
    this.invalidFlightHashes = [];
  }

  updateStall(stall = DEFAULT_STALL) {
    this.stall = Object.freeze({
      quietTurns: assertThreshold(stall?.quietTurns, 'stall.quietTurns'),
      sameFailure: assertThreshold(stall?.sameFailure, 'stall.sameFailure'),
    });
  }

  recordTurn({
    fingerprint = null,
    failureSignature = null,
    turnId = null,
    at = this.now(),
    corrective = null,
  } = {}) {
    if (fingerprint !== null && typeof fingerprint !== 'string') throw new TypeError('fingerprint must be a string or null');
    if (failureSignature !== null && typeof failureSignature !== 'string') throw new TypeError('failureSignature must be a string or null');
    this.turnsObserved += 1;
    this.turnsInCycle += 1;
    const priorFailure = this.previousFailure;
    const finish = (verdict) => {
      this.updatedAt = at;
      this.observations.push({
        at,
        fingerprint,
        failure_signature: failureSignature,
        reason: verdict.reason,
        turn_id: turnId,
        verdict_level: verdict.level,
      });
      this.observations = this.observations.slice(-MAX_SUPERVISOR_HISTORY);
      return verdict;
    };
    const conclude = (verdict) => {
      if (
        corrective &&
        verdict.level !== 'stall' &&
        !this.invalidFlightHashes.includes(corrective.contentHash)
      ) {
        this.invalidFlightHashes.push(corrective.contentHash);
        this.invalidFlightHashes = this.invalidFlightHashes.slice(-MAX_SUPERVISOR_HISTORY);
        this.interventions.push({ level: 'corrective', at, reason: corrective.reason });
        this.interventions = this.interventions.slice(-MAX_SUPERVISOR_HISTORY);
        return finish({ level: 'corrective', reason: corrective.reason });
      }
      if (['realign', 'final-experiment'].includes(verdict.level)) {
        this.interventions.push({ level: verdict.level, at, reason: verdict.reason });
        this.interventions = this.interventions.slice(-MAX_SUPERVISOR_HISTORY);
      }
      return finish(verdict);
    };

    if (this.maxTurns !== null && this.turnsObserved >= this.maxTurns) {
      this.stage = 'stalled';
      return conclude({
        level: 'stall',
        reason: `absolute supervision cap of ${this.maxTurns} completion attempts was reached`,
      });
    }

    let workspaceObservation = null;
    let progress = false;
    if (fingerprint !== null) {
      if (this.previousFingerprint === null) {
        workspaceObservation = `workspace baseline fingerprint ${short(fingerprint)} was recorded`;
      } else if (fingerprint !== this.previousFingerprint && !this.seenFingerprints.has(fingerprint)) {
        progress = true;
        workspaceObservation = `workspace evidence changed to new fingerprint ${short(fingerprint)}`;
      } else if (fingerprint === this.previousFingerprint) {
        this.quietTurns += 1;
        workspaceObservation = `workspace fingerprint ${short(fingerprint)} was unchanged for ${this.quietTurns} consecutive turn${this.quietTurns === 1 ? '' : 's'}`;
      } else {
        this.quietTurns += 1;
        workspaceObservation = `workspace oscillated to earlier fingerprint ${short(fingerprint)} after ${this.quietTurns} unproductive turn${this.quietTurns === 1 ? '' : 's'}`;
      }
      this.previousFingerprint = fingerprint;
      remember(this.seenFingerprints, fingerprint);
    }

    if (failureSignature === null) {
      this.sameFailure = 0;
      this.previousFailure = null;
    } else {
      this.sameFailure = failureSignature === this.previousFailure ? this.sameFailure + 1 : 1;
      this.previousFailure = failureSignature;
      remember(this.seenFailures, failureSignature);
    }

    if (progress) {
      this.quietTurns = 0;
      this.sameFailure = 0;
      this.stage = 'observing';
      this.interventions = [];
      this.turnsInCycle = 0;
      return conclude({ level: 'ok', reason: workspaceObservation });
    }

    if (
      fingerprint === null &&
      priorFailure !== null &&
      failureSignature !== priorFailure
    ) {
      this.quietTurns = 0;
      this.stage = 'observing';
      this.interventions = [];
      this.turnsInCycle = 0;
      return conclude({
        level: 'ok',
        reason: failureSignature === null
          ? `failure signature ${short(priorFailure)} cleared in the signature-only supervision path`
          : `failure evidence changed from signature ${short(priorFailure)} to ${short(failureSignature)} in the signature-only supervision path`,
      });
    }

    const reason = this.#reason(workspaceObservation, failureSignature);
    if (this.stage === 'realigned') {
      this.stage = 'final';
      return conclude({ level: 'final-experiment', reason });
    }
    if (this.stage === 'final' || this.stage === 'stalled') {
      this.stage = 'stalled';
      return conclude({ level: 'stall', reason });
    }
    if (
      this.quietTurns >= this.stall.quietTurns ||
      this.sameFailure >= this.stall.sameFailure
    ) {
      this.stage = 'realigned';
      return conclude({ level: 'realign', reason });
    }
    return conclude({ level: 'ok', reason });
  }

  #reason(workspaceObservation, failureSignature) {
    const reasons = [];
    if (workspaceObservation) reasons.push(workspaceObservation);
    else reasons.push('workspace fingerprint evidence was unavailable');
    if (failureSignature !== null) {
      reasons.push(`failure signature ${short(failureSignature)} repeated ${this.sameFailure} consecutive turn${this.sameFailure === 1 ? '' : 's'}`);
    } else {
      reasons.push('no repeated failure signature was present');
    }
    return reasons.join('; ');
  }

  summary() {
    return Object.freeze({
      turnsObserved: this.turnsObserved,
      fingerprints: Object.freeze([...this.seenFingerprints].map(short)),
      failureSignatures: Object.freeze([...this.seenFailures].map(short)),
      interventions: Object.freeze(this.interventions.map((item) => Object.freeze({ ...item }))),
    });
  }

  state({ flightHash = 'absent', finalReport = null, pauseOutcome = null } = {}) {
    const ladders = {
      observing: 'normal',
      realigned: 'realign',
      final: 'final',
      stalled: 'stalled',
    };
    return {
      version: 1,
      host: 'codex',
      flight_hash: flightHash,
      has_observation: this.turnsObserved > 0,
      last_fingerprint: this.previousFingerprint,
      seen_fingerprints: [...this.seenFingerprints].slice(-MAX_SUPERVISOR_HISTORY),
      last_failure: this.previousFailure,
      same_failure: this.sameFailure,
      quiet_stops: this.quietTurns,
      ladder: ladders[this.stage],
      blocks_in_cycle: this.turnsInCycle,
      completion_blocks: 0,
      turns_observed: this.turnsObserved,
      interventions: this.interventions.slice(-MAX_SUPERVISOR_HISTORY).map((item) => ({ ...item })),
      observations: this.observations.slice(-MAX_SUPERVISOR_HISTORY).map((item) => ({ ...item })),
      invalid_flight_hashes: this.invalidFlightHashes.slice(-MAX_SUPERVISOR_HISTORY),
      created_at: this.createdAt,
      updated_at: this.updatedAt,
      ...(finalReport === null ? {} : { final_report: finalReport }),
      ...(pauseOutcome === null ? {} : { pause_outcome: pauseOutcome }),
    };
  }
}

export function validSupervisorState(value) {
  const validIntervention = (item) => Boolean(
    item &&
    typeof item === 'object' &&
    ['corrective', 'realign', 'final-experiment'].includes(item.level) &&
    Number.isFinite(item.at) &&
    typeof item.reason === 'string'
  );
  const validObservation = (item) => Boolean(
    item &&
    typeof item === 'object' &&
    Number.isFinite(item.at) &&
    (item.fingerprint === null || typeof item.fingerprint === 'string') &&
    (item.failure_signature === null || typeof item.failure_signature === 'string') &&
    typeof item.reason === 'string' &&
    (item.turn_id === undefined || item.turn_id === null || typeof item.turn_id === 'string') &&
    (
      item.verdict_level === undefined ||
      ['ok', 'corrective', 'realign', 'final-experiment', 'stall'].includes(item.verdict_level)
    )
  );
  const validPauseOutcome = (outcome) => Boolean(
    outcome &&
    typeof outcome === 'object' &&
    ['paused', 'pause-failed'].includes(outcome.status) &&
    (
      (outcome.status === 'paused' && outcome.reason === undefined) ||
      (outcome.status === 'pause-failed' && typeof outcome.reason === 'string')
    )
  );
  return Boolean(
    value &&
    value.version === 1 &&
    ['codex', 'claude'].includes(value.host) &&
    typeof value.flight_hash === 'string' &&
    typeof value.has_observation === 'boolean' &&
    (value.last_fingerprint === null || typeof value.last_fingerprint === 'string') &&
    Array.isArray(value.seen_fingerprints) &&
    value.seen_fingerprints.length <= MAX_SUPERVISOR_HISTORY &&
    value.seen_fingerprints.every((item) => typeof item === 'string') &&
    (value.last_failure === null || typeof value.last_failure === 'string') &&
    Number.isInteger(value.same_failure) && value.same_failure >= 0 &&
    Number.isInteger(value.quiet_stops) && value.quiet_stops >= 0 &&
    ['normal', 'realign', 'final', 'stalled'].includes(value.ladder) &&
    Number.isInteger(value.blocks_in_cycle) && value.blocks_in_cycle >= 0 &&
    Number.isInteger(value.completion_blocks ?? 0) && (value.completion_blocks ?? 0) >= 0 &&
    Number.isInteger(value.turns_observed) && value.turns_observed >= 0 &&
    Array.isArray(value.interventions) &&
    value.interventions.length <= MAX_SUPERVISOR_HISTORY &&
    value.interventions.every(validIntervention) &&
    Array.isArray(value.observations) &&
    value.observations.length <= MAX_SUPERVISOR_HISTORY &&
    value.observations.every(validObservation) &&
    Array.isArray(value.invalid_flight_hashes ?? []) &&
    (value.invalid_flight_hashes ?? []).length <= MAX_SUPERVISOR_HISTORY &&
    (value.invalid_flight_hashes ?? []).every((item) => typeof item === 'string') &&
    Number.isFinite(value.created_at) &&
    Number.isFinite(value.updated_at) &&
    (value.final_report === undefined || typeof value.final_report === 'string') &&
    (value.pause_outcome === undefined || validPauseOutcome(value.pause_outcome))
  );
}

export async function atomicWriteText(path, text, {
  write = writeFile,
  move = rename,
  remove = unlink,
  pid = process.pid,
  now = Date.now,
} = {}) {
  atomicSequence += 1;
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${pid}.${now()}.${atomicSequence}.tmp`,
  );
  try {
    await write(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await move(temporary, path);
  } catch (error) {
    await remove(temporary).catch(() => {});
    throw error;
  }
}

export async function ensureCruiseScratch(cwd, entries = [SUPERVISOR_STATE_FILE]) {
  const directory = join(cwd, '.cruise');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('.cruise must be a real directory');
  }
  const ignorePath = join(directory, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(ignorePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const lines = existing.split(/\r?\n/u);
  const missing = entries.filter((entry) => !lines.includes(entry));
  if (missing.length) {
    const prefix = `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}`;
    await atomicWriteText(ignorePath, `${prefix}${missing.join('\n')}\n`);
  }
  return directory;
}

export async function writeCruiseScratchJson(cwd, filename, value) {
  if (!/^\.[A-Za-z0-9-]+\.json$/u.test(filename) && filename !== 'LAST-RUN.json') {
    throw new TypeError('unsupported scratch JSON basename');
  }
  const directory = await ensureCruiseScratch(cwd, [filename]);
  await atomicWriteText(join(directory, filename), `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeSupervisorState(cwd, state) {
  if (!validSupervisorState(state)) throw new TypeError('supervisor scratch state is malformed');
  await writeCruiseScratchJson(cwd, SUPERVISOR_STATE_FILE, state);
}

// Exclude reserved native state and credentials before opening files. Ordinary
// product/output names are included unless the project's .gitignore says otherwise.
const NON_GIT_EXCLUDED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', '.agents', '.codex', '.claude', '.cursor',
  '.aws', '.ssh', '.gnupg', '.kube', '.docker', '.azure', '.gcloud', '.config',
  '.agent-context', 'secrets', '.secrets', 'credentials',
]);
const NON_GIT_EXCLUDED_FILES = new Set([
  '.env', '.netrc', '.npmrc', '.pypirc', '.dockercfg', '.git-credentials',
  'credentials', 'credentials.json', 'secrets.json', 'auth.json', 'tokens.json',
  'service-account.json', 'service_account.json', '.ds_store',
  '.bash_history', '.zsh_history', '.python_history', '.node_repl_history',
  '.lesshst', '.sqlite_history', '.claude.json', '.codex.json', '.authinfo', '.gitconfig',
]);

function excludedNonGitPath(path, excludeFlightPlan) {
  const parts = path.split('/');
  const name = parts.at(-1).toLowerCase();
  if (parts.some((part) => NON_GIT_EXCLUDED_DIRECTORIES.has(part.toLowerCase()))) return true;
  if (['agents', 'agent-context'].includes(parts[0].toLowerCase())) return true;
  if (parts.length === 1 && /^_.*\.md$/iu.test(name)) return true;
  if (NON_GIT_EXCLUDED_FILES.has(name) || name.startsWith('.env.')) return true;
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.pub)?$/u.test(name)) return true;
  if (/\.(?:pem|key|p12|pfx|keystore|jks)$/u.test(name)) return true;
  if (parts[0].toLowerCase() === '.cruise') {
    return excludeFlightPlan || (parts.length > 1 && ![
      '.cruise/flight.md', '.cruise/origin.md',
    ].includes(path.toLowerCase()));
  }
  return false;
}

function sameFilesystemObservation(first, second) {
  return ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].every((key) => first[key] === second[key]);
}

async function captureNonGitFingerprint(cwd, { excludeFlightPlan }) {
  const root = await realpath(cwd);
  // An unreadable or corrupt existing repository must not silently fall back to
  // directory-only assurance. Inspect marker metadata, never their contents.
  let ancestor = root;
  for (let count = 0; ; count += 1) {
    if (count > 128) throw new Error('non-Git workspace ancestry limit exceeded');
    try {
      await lstat(join(ancestor, '.git'));
      throw new Error('Git repository metadata exists but could not be inspected');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const startedAt = Date.now();
  const limits = NON_GIT_FINGERPRINT_LIMITS;
  let entries = 0;
  let bytes = 0;
  let pathBytes = 0;
  const observations = [];
  const ignoreObservations = [];
  const fileHashes = new Map();
  const metadataObservations = new Map();
  const included = new Set(['']);
  const linkTargets = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const assertWithinDeadline = () => {
    if (Date.now() - startedAt > limits.elapsedMs) throw new Error('non-Git fingerprint deadline exceeded');
  };
  const assertDirectoryChain = async (path) => {
    const chain = [];
    for (let directory = dirname(path); ; directory = dirname(directory)) {
      const expected = metadataObservations.get(directory);
      if (!expected?.isDirectory()) throw new Error('file ancestry was not captured');
      chain.push([directory, expected]);
      if (directory === root) break;
    }
    for (const [directory, expected] of chain.reverse()) {
      assertWithinDeadline();
      const current = await lstat(directory, { bigint: true });
      if (!current.isDirectory() || !sameFilesystemObservation(expected, current) ||
          await realpath(directory) !== directory) throw new Error('workspace directory ancestry changed');
    }
  };
  const stableFileHash = async (path, metadata, { ignoreFile = false } = {}) => {
    assertWithinDeadline();
    await assertDirectoryChain(path);
    if (!metadata.isFile()) throw new Error('non-Git fingerprint requires regular files');
    if (ignoreFile && metadata.size > BigInt(limits.ignoreBytes)) throw new Error('ignore file limit exceeded');
    const cached = fileHashes.get(path);
    if (cached) {
      if (!sameFilesystemObservation(metadata, cached.metadata)) throw new Error('file changed during fingerprint');
      return cached.hash;
    }
    if (metadata.size > BigInt(limits.bytes - bytes)) throw new Error('non-Git fingerprint byte limit exceeded');
    bytes += Number(metadata.size);
    // Never follow a final-component symlink, or block on a raced FIFO/device.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || !sameFilesystemObservation(metadata, before)) throw new Error('file changed before fingerprint');
      // O_NOFOLLOW only covers the last component. Recheck all pinned parent
      // identities and the opened path before the first content read. The file
      // descriptor then retains that file even if its path is moved afterwards.
      await assertDirectoryChain(path);
      if (!sameFilesystemObservation(before, await lstat(path, { bigint: true }))) throw new Error('opened file path changed');
      await assertDirectoryChain(path);
      const hash = createHash('sha256');
      const ignoreChunks = ignoreFile ? [] : null;
      const buffer = Buffer.alloc(Math.min(64 * 1024, Number(metadata.size) + 1));
      let count = 0;
      while (true) {
        assertWithinDeadline();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        count += bytesRead;
        if (count > Number(metadata.size)) throw new Error('file grew during fingerprint');
        hash.update(buffer.subarray(0, bytesRead));
        if (ignoreChunks) ignoreChunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      }
      const after = await handle.stat({ bigint: true });
      const current = await lstat(path, { bigint: true });
      if (count !== Number(metadata.size) || !sameFilesystemObservation(before, after) ||
          !sameFilesystemObservation(after, current)) throw new Error('file changed during fingerprint');
      const value = hash.digest('hex');
      fileHashes.set(path, { metadata: after, hash: value, ignoreContents: ignoreChunks ? Buffer.concat(ignoreChunks) : null });
      return value;
    } finally {
      await handle.close();
    }
  };

  // A disposable native Git repository supplies exact nested .gitignore rules,
  // including negation. Its worktree contains captured ignore files and empty
  // directory shapes, so Git never rereads source paths through raced ancestry.
  const scratch = await mkdtemp(join(tmpdir(), 'cruise-workspace-ignore-'));
  const ignoreWorktree = join(scratch, 'worktree');
  const options = {
    cwd: root,
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 2 * limits.pathBytes,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      LC_ALL: 'C',
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '0',
      GIT_CONFIG_PARAMETERS: '',
      GIT_INDEX_FILE: join(scratch, 'index'),
    },
  };
  try {
    await execFileAsync('git', ['init', '--bare', '--quiet', '--template=', scratch], options);
    await mkdir(ignoreWorktree);
    const ignoredPaths = async (paths) => {
      if (!paths.length) return new Set();
      assertWithinDeadline();
      const command = execFileAsync('git', [
        `--git-dir=${scratch}`, `--work-tree=${ignoreWorktree}`,
        '-c', `core.excludesFile=${devNull}`,
        'check-ignore', '--no-index', '--stdin', '-z',
      ], options);
      command.child.stdin.on('error', () => {});
      command.child.stdin.end(`${paths.join('\u0000')}\u0000`);
      const result = await command.catch((error) => {
        if (error.code === 1) return error; // No matched paths is a normal result.
        throw error;
      });
      if (result.stderr?.trim()) throw new Error('Git ignore observation was incomplete');
      const ignored = new Set(result.stdout.split('\u0000').filter(Boolean));
      if ([...ignored].some((path) => !paths.includes(path))) throw new Error('unexpected Git ignore result');
      return ignored;
    };
    const walk = async (directory, parent = '', depth = 0) => {
      assertWithinDeadline();
      if (depth > limits.depth) throw new Error('non-Git fingerprint depth limit exceeded');
      const before = await lstat(directory, { bigint: true });
      if (!before.isDirectory() || await realpath(directory) !== directory) throw new Error('directory is not a stable workspace path');
      metadataObservations.set(directory, before);
      const names = [];
      const directoryNames = new Set();
      let ignoreFilePresent = false;
      const stream = await opendir(directory, { encoding: 'buffer' });
      for await (const entry of stream) {
        assertWithinDeadline();
        if (++entries > limits.entries) throw new Error('non-Git fingerprint entry limit exceeded');
        const name = decoder.decode(entry.name);
        if (name === '.gitignore') ignoreFilePresent = true;
        const path = parent ? `${parent}/${name}` : name;
        pathBytes += Buffer.byteLength(path);
        if (pathBytes > limits.pathBytes) throw new Error('non-Git fingerprint path limit exceeded');
        if (!excludedNonGitPath(path, excludeFlightPlan)) {
          names.push(name);
          if (entry.isDirectory()) directoryNames.add(name);
        }
      }
      names.sort();
      await assertDirectoryChain(join(directory, '.directory-check'));
      const mirroredDirectory = join(ignoreWorktree, parent);
      if (ignoreFilePresent) {
        const path = join(directory, '.gitignore');
        const metadata = await lstat(path, { bigint: true });
        ignoreObservations.push([parent, await stableFileHash(path, metadata, { ignoreFile: true })]);
        await writeFile(join(mirroredDirectory, '.gitignore'), fileHashes.get(path).ignoreContents);
      }
      for (const name of directoryNames) {
        assertWithinDeadline();
        await mkdir(join(mirroredDirectory, name));
      }
      const ignored = await ignoredPaths(names.map((name) => parent ? `${parent}/${name}` : name));
      await assertDirectoryChain(join(directory, '.directory-check'));
      for (const name of names) {
        const path = parent ? `${parent}/${name}` : name;
        if (ignored.has(path)) continue;
        const absolutePath = join(directory, name);
        await assertDirectoryChain(absolutePath);
        const metadata = await lstat(absolutePath, { bigint: true });
        await assertDirectoryChain(absolutePath);
        included.add(path);
        if (metadata.isDirectory()) {
          observations.push(['directory', path]);
          await walk(absolutePath, path, depth + 1);
        } else if (metadata.isFile()) {
          observations.push(['file', path, Number(metadata.mode & 0o111n), await stableFileHash(absolutePath, metadata)]);
        } else if (metadata.isSymbolicLink()) {
          // Hash the link itself; its resolved target must also be captured in
          // this workspace. Escaping, dangling, and excluded targets fail closed.
          const target = decoder.decode(await readlink(absolutePath, { encoding: 'buffer' }));
          const targetPath = relative(root, await realpath(absolutePath));
          if (isAbsolute(targetPath) || targetPath === '..' || targetPath.startsWith(`..${sep}`)) throw new Error('symlink escapes workspace');
          linkTargets.push(targetPath.split(sep).join('/'));
          const after = await lstat(absolutePath, { bigint: true });
          if (!sameFilesystemObservation(metadata, after)) throw new Error('symlink changed during fingerprint');
          metadataObservations.set(absolutePath, after);
          observations.push(['symlink', path, target]);
        } else {
          throw new Error('unsupported non-regular workspace entry');
        }
      }
      const after = await lstat(directory, { bigint: true });
      if (!sameFilesystemObservation(before, after)) throw new Error('directory changed during fingerprint');
    };
    await walk(root);
    if (linkTargets.some((target) => !included.has(target))) throw new Error('symlink target is outside captured inputs');
    // Metadata only rejects races; it never substitutes for content evidence.
    for (const [path, observation] of [...metadataObservations, ...fileHashes]) {
      assertWithinDeadline();
      const expected = observation.metadata ?? observation;
      if (!sameFilesystemObservation(expected, await lstat(path, { bigint: true }))) throw new Error('workspace changed during fingerprint');
    }
    assertWithinDeadline();
    return digest(JSON.stringify({
      format: 'cruise-non-git-content-v1', observations, ignoreObservations,
    }));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function captureWorkspaceFingerprint(cwd, { excludeFlightPlan = false } = {}) {
  try {
    const options = { cwd, encoding: 'utf8', maxBuffer: Infinity };
    const repository = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      ...options, env: { ...process.env, LC_ALL: 'C' }, timeout: 3000,
    }).catch((error) => {
      // Git's normal absent-repository diagnostic varies at mount boundaries.
      if (error.stderr?.startsWith('fatal: not a git repository (or any ')) return null;
      throw error;
    });
    if (repository === null) return await captureNonGitFingerprint(cwd, { excludeFlightPlan });
    const pathspec = excludeFlightPlan
      ? ['--', '.', ':(exclude).cruise/**']
      : [];
    const [head, status, diff, cached, untracked] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], options)
        .catch(() => ({ stdout: 'unborn\n' })),
      execFileAsync('git', ['status', '--porcelain=v1', ...pathspec], options),
      execFileAsync('git', ['diff', ...pathspec], options),
      execFileAsync('git', ['diff', '--cached', ...pathspec], options),
      execFileAsync(
        'git',
        [
          'ls-files',
          '--others',
          '--exclude-standard',
          '-z',
          ...(excludeFlightPlan ? ['--', '.', ':(exclude).cruise/**'] : []),
        ],
        options,
      ),
    ]);
    const untrackedFiles = untracked.stdout.split('\u0000').filter(Boolean).sort();
    let untrackedBytes = 0;
    const untrackedEvidence = [];
    for (const path of untrackedFiles) {
      if (path.startsWith('/') || path.split('/').includes('..')) return null;
      const metadata = await lstat(join(cwd, path));
      if (metadata.isSymbolicLink()) {
        untrackedEvidence.push(`${path}\u0000symlink\u0000${await readlink(join(cwd, path))}`);
        continue;
      }
      if (!metadata.isFile()) {
        untrackedEvidence.push(`${path}\u0000non-regular`);
        continue;
      }
      untrackedBytes += metadata.size;
      if (untrackedBytes > 64 * 1024 * 1024) return null;
      untrackedEvidence.push(`${path}\u0000${digest(await readFile(join(cwd, path)))}`);
    }
    return digest([
      head.stdout.trim(),
      status.stdout,
      diff.stdout,
      cached.stdout,
      untrackedEvidence.join('\u0000'),
    ].join('\u0000'));
  } catch {
    return null;
  }
}

export function extractFailureSignature(turnText) {
  if (typeof turnText !== 'string') return null;
  const lines = turnText.split(/\r?\n/u).filter((line) => FAILURE_LINE.test(line));
  if (!lines.length) return null;
  const normalized = lines.map((line) => line
    .replace(/\b[A-Za-z]:\\(?:[^\\\r\n:]+\\)*[^:\r\n]+?(?=:\d+(?::\d+)?\b|$)/gu, '<path>')
    .replace(/\/(?:[^/\r\n:]+\/)*[^:\r\n]+?(?=:\d+(?::\d+)?\b|$)/gu, '<path>')
    .replace(/\b(?:0x[a-f\d]+|[a-f\d]{7,})\b/giu, '<hex>')
    .replace(/\d+/gu, '<n>')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase())
    .filter(Boolean);
  return normalized.length ? digest(normalized.join('\n')) : null;
}
