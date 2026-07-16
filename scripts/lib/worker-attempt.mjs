import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FOREIGN_DIFF_CONTROL_MAX_FILE_BYTES,
  FOREIGN_DIFF_CONTROL_MAX_TOTAL_BYTES,
  isForeignDiffControlName,
} from './foreign-diff-control.mjs';
import { foreignDiffAuthorityPath } from './foreign-diff-guard.mjs';
import {
  isAutoClearRepositoryPath,
  isNonProductRepositoryPath,
} from './repository-scope.mjs';
import { canonicalJson, parseYaml, stringifyYaml } from './yaml-state.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const REPORT_COMMIT_CHILD = fileURLToPath(
  new URL('./worker-report-commit-child.mjs', import.meta.url),
);
const CONTROL_MAX_FILE_BYTES = FOREIGN_DIFF_CONTROL_MAX_FILE_BYTES;
const CONTROL_MAX_TOTAL_BYTES = FOREIGN_DIFF_CONTROL_MAX_TOTAL_BYTES;
const CONTROL_MAX_ENTRIES = 10_000;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode;
}

function portable(path) {
  return sep === '/' ? path : path.split(sep).join('/');
}

async function safeDirectory(path, label, { create = false, requirePrivate = false } = {}) {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || await realpath(path) !== resolve(path)
    || (requirePrivate && (metadata.mode & 0o077) !== 0)
    || (requirePrivate && typeof process.getuid === 'function' && metadata.uid !== process.getuid())
  ) {
    throw new Error(`${label} is not a canonical private directory`);
  }
  return metadata;
}

async function readBoundedRegularFile(path, label, maxBytes = CONTROL_MAX_FILE_BYTES) {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new Error(`${label} changed while being opened`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameIdentity(opened, after) || bytes.length !== opened.size) {
      throw new Error(`${label} changed while being read`);
    }
    return { bytes, metadata: opened };
  } finally {
    await handle.close();
  }
}

async function readAttemptRecord(path, label) {
  const { bytes } = await readBoundedRegularFile(path, label, 1024 * 1024);
  return parseYaml(new TextDecoder('utf-8', { fatal: true }).decode(bytes), {
    maxBytes: 1024 * 1024,
    maxNodes: 10_000,
  });
}

async function createDurableRecord(path, value) {
  const source = stringifyYaml(value, { maxNodes: 10_000 });
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(source, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return sha256(Buffer.from(source, 'utf8'));
}

async function assertNoActiveWorkerAttempt(directory) {
  const names = await readdir(directory);
  for (const name of names) {
    const match = /^([a-f0-9]{64})\.admitted\.yaml$/u.exec(name);
    if (!match) continue;
    const admitted = await readAttemptRecord(join(directory, name), 'admitted worker attempt');
    try {
      const terminal = await readAttemptRecord(
        join(directory, `${match[1]}.terminal.yaml`),
        'terminal worker attempt',
      );
      assertAttemptRecordBinding(terminal, admitted.binding, 'terminal worker attempt');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      throw new Error(
        `worker attempt ${admitted?.binding?.attempt_id ?? match[1]} is still active; concurrent inference is forbidden`,
      );
    }
  }
}

function authorityGeneration(guardState) {
  return sha256(Buffer.from(canonicalJson({
    run_id: guardState.run_id,
    repository_root: guardState.repository_root,
    origin_prompt_sha256: guardState.origin_prompt_sha256,
    repository_baseline_digest: guardState.repository_baseline_digest,
    created_at: guardState.created_at,
  }), 'utf8'));
}

function exactAttemptBinding({ scope, packetSha256, level, generation }) {
  if (!SHA256.test(packetSha256 ?? '')) throw new Error('worker attempt packet digest is invalid');
  const attemptId = sha256(Buffer.from(canonicalJson({
    run_id: scope.runId,
    packet_path: scope.packetPath,
    packet_sha256: packetSha256,
  }), 'utf8'));
  return Object.freeze({
    attempt_id: attemptId,
    run_id: scope.runId,
    repository_root: scope.cwd,
    packet_path: scope.packetPath,
    packet_sha256: packetSha256,
    report_path: scope.reportPath,
    recommended_level: level,
    authority_generation: generation,
  });
}

function reportBinding(binding) {
  return Object.freeze({
    attempt_id: binding.attempt_id,
    run_id: binding.run_id,
    packet_path: binding.packet_path,
    packet_sha256: binding.packet_sha256,
    report_path: binding.report_path,
  });
}

function assertAttemptRecordBinding(record, binding, label) {
  const actual = record?.binding;
  if (canonicalJson(actual) !== canonicalJson(binding)) {
    throw new Error(`${label} differs from the exact packet/run/report binding`);
  }
}

async function assertMissing(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${label} must be missing at worker admission`);
}

async function captureControlTree(root, excludedPaths, expectedRootIdentity) {
  const entries = [];
  let totalBytes = 0;

  const visit = async (directory, prefix = '') => {
    const before = await lstat(directory);
    if (
      before.isSymbolicLink()
      || !before.isDirectory()
      || (prefix === '' && !sameDirectoryIdentity(before, expectedRootIdentity))
    ) {
      throw new Error('worker run-control directory identity changed');
    }
    const names = (await readdir(directory)).sort((left, right) => left.localeCompare(right, 'en'));
    for (const name of names) {
      const relativePath = portable(prefix ? join(prefix, name) : name);
      if (excludedPaths.has(relativePath)) continue;
      if (isAutoClearRepositoryPath(relativePath)) {
        await rm(join(directory, name), { recursive: true, force: true });
        continue;
      }
      if (isNonProductRepositoryPath(relativePath)) continue;
      if (entries.length >= CONTROL_MAX_ENTRIES) {
        throw new Error(`worker run-control snapshot exceeds ${CONTROL_MAX_ENTRIES} entries`);
      }
      const absolute = join(directory, name);
      const metadata = await lstat(absolute);
      const mode = metadata.mode & 0o7777;
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        entries.push({ path: relativePath, kind: 'directory', mode, size: 0, sha256: null });
        await visit(absolute, relativePath);
      } else if (metadata.isSymbolicLink()) {
        throw new Error(`worker run-control artifact must not be a symlink: ${relativePath}`);
      } else if (metadata.isFile()) {
        const { bytes } = await readBoundedRegularFile(
          absolute,
          `worker run-control artifact ${relativePath}`,
        );
        totalBytes += bytes.length;
        entries.push({
          path: relativePath,
          kind: 'file',
          mode,
          size: bytes.length,
          sha256: sha256(bytes),
        });
      } else {
        throw new Error(`worker run-control artifact is a special file: ${relativePath}`);
      }
      if (totalBytes > CONTROL_MAX_TOTAL_BYTES) {
        throw new Error(`worker run-control snapshot exceeds ${CONTROL_MAX_TOTAL_BYTES} bytes`);
      }
    }
    const after = await lstat(directory);
    if (!sameDirectoryIdentity(before, after)) {
      throw new Error(`worker run-control directory changed while snapshotting: ${prefix || '.'}`);
    }
  };

  await visit(root);
  const snapshot = {
    root,
    root_dev: String(expectedRootIdentity.dev),
    root_ino: String(expectedRootIdentity.ino),
    excluded_paths: [...excludedPaths].sort((left, right) => left.localeCompare(right, 'en')),
    entries,
  };
  return Object.freeze({ ...snapshot, sha256: sha256(Buffer.from(canonicalJson(snapshot), 'utf8')) });
}

function changedControlPaths(before, after) {
  const prior = new Map(before.entries.map((entry) => [entry.path, canonicalJson(entry)]));
  const current = new Map(after.entries.map((entry) => [entry.path, canonicalJson(entry)]));
  return [...new Set([...prior.keys(), ...current.keys()])]
    .filter((path) => prior.get(path) !== current.get(path))
    .sort((left, right) => left.localeCompare(right, 'en'));
}

function guardAuthorizesNewActionControls(admission, guardState, cleanInventorySha256) {
  const baseline = admission.guardBaseline;
  if (
    admission.mapperOutput !== null
    || !guardState
    || guardState.status !== 'monitoring'
    || guardState.run_id !== admission.binding.run_id
    || guardState.repository_root !== admission.binding.repository_root
    || authorityGeneration(guardState) !== admission.binding.authority_generation
    || guardState.checkpoint === null
    || guardState.checkpoint.inventory.sha256 !== cleanInventorySha256
    || guardState.checkpoint.sequence <= baseline.checkpoint_sequence
    || canonicalJson(guardState.history.slice(0, baseline.history.length))
      !== canonicalJson(baseline.history)
  ) {
    return false;
  }
  const completed = guardState.history
    .slice(baseline.history.length)
    .filter((entry) => entry.action === 'action_completed');
  return completed.length > 0
    && guardState.checkpoint.sequence === baseline.checkpoint_sequence + completed.length
    && completed.at(-1)?.inventory_sha256 === guardState.checkpoint.inventory.sha256;
}

function onlyAuthorizedNewActionControls(before, current, admission, guardState, cleanInventorySha256) {
  if (!guardAuthorizesNewActionControls(admission, guardState, cleanInventorySha256)) return false;
  const prior = new Map(before.entries.map((entry) => [entry.path, entry]));
  const observed = new Map(current.entries.map((entry) => [entry.path, entry]));
  for (const [path, entry] of prior) {
    if (canonicalJson(entry) !== canonicalJson(observed.get(path) ?? null)) return false;
  }
  const additions = [...observed.entries()].filter(([path]) => !prior.has(path));
  return additions.length > 0 && additions.every(([path, entry]) => (
    path === basename(path)
    && isForeignDiffControlName(path)
    && entry.kind === 'file'
    && entry.size <= FOREIGN_DIFF_CONTROL_MAX_FILE_BYTES
  ));
}

function mapperGuardStayedImmutable(admission, guardState, cleanInventorySha256) {
  if (admission.mapperOutput === null || guardState === null) return true;
  const baseline = admission.guardBaseline;
  return guardState.status === 'monitoring'
    && guardState.checkpoint?.sequence === baseline.checkpoint_sequence
    && guardState.checkpoint?.inventory?.sha256 === baseline.checkpoint_inventory_sha256
    && cleanInventorySha256 === baseline.checkpoint_inventory_sha256
    && canonicalJson(guardState.history) === canonicalJson(baseline.history);
}

export async function assertWorkerControlSnapshot(admission, {
  guardState = null,
  cleanInventorySha256 = null,
} = {}) {
  if (!mapperGuardStayedImmutable(admission, guardState, cleanInventorySha256)) {
    const error = new Error('semantic mapper changed the host-owned foreign-diff action state');
    error.code = 'CRUISE_WORKER_CONTROL_MUTATION';
    error.changedPaths = Object.freeze(['foreign-diff-guard.yaml']);
    throw error;
  }
  const current = await captureControlTree(
    admission.runDirectory,
    new Set(admission.controlSnapshot.excluded_paths),
    admission.reportParent,
  );
  if (
    current.sha256 !== admission.controlSnapshot.sha256
    && !onlyAuthorizedNewActionControls(
      admission.controlSnapshot,
      current,
      admission,
      guardState,
      cleanInventorySha256,
    )
  ) {
    const changed = changedControlPaths(admission.controlSnapshot, current);
    const error = new Error(
      `worker mutated immutable run-control artifacts: ${changed.join(', ') || 'directory metadata'}`,
    );
    error.code = 'CRUISE_WORKER_CONTROL_MUTATION';
    error.changedPaths = Object.freeze(changed);
    throw error;
  }
  await assertMissing(admission.binding.report_path, 'worker report');
  return current;
}

function normalizeMapperFactsShape(value, template) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('semantic mapper output must be a YAML mapping');
  }
  const candidate = Array.isArray(value.facts) ? value : value.enrichment_template;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('semantic mapper output must preserve every template fact');
  }
  const normalized = structuredClone(template);
  if (!Array.isArray(candidate.facts) || candidate.facts.length !== normalized.facts.length) {
    throw new Error('semantic mapper output must preserve every template fact');
  }
  for (let index = 0; index < candidate.facts.length; index += 1) {
    const fact = candidate.facts[index];
    const expected = normalized.facts[index];
    if (!fact || typeof fact !== 'object' || Array.isArray(fact)) {
      throw new Error(`semantic mapper fact ${index} must be a mapping`);
    }
    const keys = Object.keys(fact).sort();
    if (canonicalJson(keys) !== canonicalJson(['basis', 'id', 'signal', 'value'])) {
      throw new Error(`semantic mapper fact ${index} changed immutable fields`);
    }
    if (fact.id !== expected.id || fact.signal !== expected.signal) {
      throw new Error(`semantic mapper fact ${index} changed immutable fields`);
    }
    if (!Array.isArray(fact.basis) || fact.basis.length === 0) {
      throw new Error(`semantic mapper fact ${index} must retain evidence basis`);
    }
    if (fact.signal === 'failed_quick_repairs') {
      if (!Number.isSafeInteger(fact.value) || fact.value < 0) {
        throw new Error('semantic mapper failed_quick_repairs must be a non-negative integer');
      }
    } else if (typeof fact.value !== 'boolean') {
      throw new Error(`semantic mapper ${fact.signal ?? index} value must be boolean`);
    }
    normalized.facts[index].value = fact.value;
    normalized.facts[index].basis = structuredClone(fact.basis);
  }
  return normalized;
}

async function rewriteMapperOutput(path, content, expectedMetadata) {
  const handle = await open(path, fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(expectedMetadata, opened)) {
      throw new Error('semantic mapper output changed before canonicalization');
    }
    await handle.truncate(0);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  const verified = await readBoundedRegularFile(
    path,
    'canonical semantic mapper output',
    4 * 1024 * 1024,
  );
  if (Buffer.compare(verified.bytes, Buffer.from(content, 'utf8')) !== 0) {
    throw new Error('semantic mapper output changed during canonicalization');
  }
}

export async function assertExpectedWorkerOutput(admission, {
  required = false,
  canonicalizeMapperOutput = false,
} = {}) {
  if (admission.mapperOutput === null) return null;
  let source;
  try {
    source = await readBoundedRegularFile(
      admission.mapperOutput.path,
      'semantic mapper output',
      4 * 1024 * 1024,
    );
  } catch (error) {
    if (error?.code === 'ENOENT' && !required) return null;
    if (error?.code === 'ENOENT') {
      throw new Error('semantic mapper completed without its declared semantic-facts output', {
        cause: error,
      });
    }
    throw error;
  }
  const value = parseYaml(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes), {
    maxBytes: 4 * 1024 * 1024,
    maxNodes: 100_000,
  });
  const normalized = normalizeMapperFactsShape(value, admission.mapperOutput.template);
  if (canonicalizeMapperOutput && canonicalJson(value) !== canonicalJson(normalized)) {
    await rewriteMapperOutput(
      admission.mapperOutput.path,
      stringifyYaml(normalized, { maxNodes: 100_000 }),
      source.metadata,
    );
  }
  return normalized;
}

export async function admitWorkerAttempt({
  scope,
  packetSha256,
  level,
  guardState,
  mapperOutput = null,
} = {}) {
  const runDirectory = dirname(scope.reportPath);
  const reportParent = await safeDirectory(runDirectory, 'worker report parent');
  await assertMissing(scope.reportPath, 'worker report');

  let normalizedMapperOutput = null;
  const excludedPaths = new Set(['foreign-diff-guard.yaml', basename(scope.reportPath)]);
  if (mapperOutput !== null) {
    const outputPath = resolve(mapperOutput.path);
    if (dirname(outputPath) !== runDirectory) {
      throw new Error('semantic mapper output must be a direct artifact in the canonical run');
    }
    await assertMissing(outputPath, 'semantic mapper output');
    excludedPaths.add(basename(outputPath));
    normalizedMapperOutput = Object.freeze({
      path: outputPath,
      template: structuredClone(mapperOutput.template),
    });
  }

  const generation = authorityGeneration(guardState);
  const binding = exactAttemptBinding({ scope, packetSha256, level, generation });
  const authorityDirectory = dirname(foreignDiffAuthorityPath(scope.cwd, scope.runId));
  await safeDirectory(authorityDirectory, 'foreign-diff authority', { requirePrivate: true });
  const attemptsRoot = join(authorityDirectory, 'worker-attempts');
  await safeDirectory(attemptsRoot, 'worker-attempt authority', {
    create: true,
    requirePrivate: true,
  });
  const generationDirectory = join(attemptsRoot, generation);
  await safeDirectory(generationDirectory, 'worker-attempt generation', {
    create: true,
    requirePrivate: true,
  });
  const admittedPath = join(generationDirectory, `${binding.attempt_id}.admitted.yaml`);
  const terminalPath = join(generationDirectory, `${binding.attempt_id}.terminal.yaml`);

  await assertNoActiveWorkerAttempt(generationDirectory);

  for (const [path, label] of [[terminalPath, 'terminal worker attempt'], [admittedPath, 'admitted worker attempt']]) {
    try {
      const record = await readAttemptRecord(path, label);
      assertAttemptRecordBinding(record, binding, label);
      throw new Error(
        `worker packet attempt ${binding.attempt_id} is already ${record.outcome ?? record.status}; duplicate inference is forbidden`,
      );
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }

  const controlSnapshot = await captureControlTree(runDirectory, excludedPaths, reportParent);
  const admittedAt = new Date().toISOString();
  try {
    await createDurableRecord(admittedPath, {
      schema_version: 1,
      kind: 'cruise_worker_attempt_admission',
      status: 'admitted',
      admitted_at: admittedAt,
      binding,
      control_snapshot_sha256: controlSnapshot.sha256,
    });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readAttemptRecord(admittedPath, 'admitted worker attempt');
    assertAttemptRecordBinding(existing, binding, 'admitted worker attempt');
    throw new Error(`worker packet attempt ${binding.attempt_id} is already admitted; duplicate inference is forbidden`);
  }

  const admission = {
    binding,
    report_binding: reportBinding(binding),
    reportParent,
    runDirectory,
    authorityDirectory: generationDirectory,
    admittedPath,
    terminalPath,
    controlSnapshot,
    guardBaseline: Object.freeze({
      checkpoint_sequence: guardState.checkpoint.sequence,
      checkpoint_inventory_sha256: guardState.checkpoint.inventory.sha256,
      history: Object.freeze(structuredClone(guardState.history)),
    }),
    mapperOutput: normalizedMapperOutput,
  };
  // Close the capture/claim race before any inference can start. If this
  // fails, the admitted record remains a durable consumed attempt.
  await assertWorkerControlSnapshot(admission);
  return Object.freeze(admission);
}

export function bindWorkerAttemptReport(report, admission) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new TypeError('worker report must be a mapping');
  }
  return Object.freeze({
    ...report,
    attempt: admission.report_binding,
  });
}

export async function commitWorkerReportNoClobber(admission, report) {
  await assertMissing(admission.binding.report_path, 'worker report');
  const source = stringifyYaml(report, { maxNodes: 250_000 });
  const sourcePath = join(
    admission.authorityDirectory,
    `${admission.binding.attempt_id}.report-${randomUUID()}.yaml`,
  );
  const handle = await open(sourcePath, 'wx', 0o600);
  try {
    await handle.writeFile(source, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  const temporaryName = `.cruise-worker-report-${randomUUID()}.tmp`;
  try {
    const committed = spawnSync(process.execPath, [
      REPORT_COMMIT_CHILD,
      basename(admission.binding.report_path),
      temporaryName,
      sourcePath,
      String(admission.reportParent.dev),
      String(admission.reportParent.ino),
    ], {
      cwd: admission.runDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (committed.error || committed.status !== 0) {
      const detail = String(committed.stderr ?? '').trim() || committed.error?.message || 'unknown error';
      throw new Error(`worker report no-clobber commit failed: ${detail}`);
    }
    const [parent, destination] = await Promise.all([
      lstat(admission.runDirectory),
      lstat(admission.binding.report_path),
    ]);
    if (
      parent.isSymbolicLink()
      || !parent.isDirectory()
      || !sameDirectoryIdentity(parent, admission.reportParent)
      || destination.isSymbolicLink()
      || !destination.isFile()
    ) {
      throw new Error('worker report commit did not remain bound to the admitted parent inode');
    }
    const committedReport = await readBoundedRegularFile(
      admission.binding.report_path,
      'committed worker report',
      Math.max(Buffer.byteLength(source, 'utf8'), 1),
    );
    if (sha256(committedReport.bytes) !== sha256(Buffer.from(source, 'utf8'))) {
      throw new Error('worker report commit bytes differ from the admitted terminal report');
    }
    return Object.freeze({
      path: admission.binding.report_path,
      sha256: sha256(Buffer.from(source, 'utf8')),
      bytes: Buffer.byteLength(source, 'utf8'),
    });
  } finally {
    await unlink(sourcePath).catch(() => {});
  }
}

export async function completeWorkerAttempt(admission, {
  outcome,
  reportSha256 = null,
  errorCode = null,
} = {}) {
  if (!['terminal_success', 'terminal_failure'].includes(outcome)) {
    throw new TypeError('worker attempt outcome must be terminal_success or terminal_failure');
  }
  const admitted = await readAttemptRecord(admission.admittedPath, 'admitted worker attempt');
  assertAttemptRecordBinding(admitted, admission.binding, 'admitted worker attempt');
  try {
    await createDurableRecord(admission.terminalPath, {
      schema_version: 1,
      kind: 'cruise_worker_attempt_terminal',
      outcome,
      terminal_at: new Date().toISOString(),
      binding: admission.binding,
      report_sha256: reportSha256,
      error_code: errorCode,
    });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const terminal = await readAttemptRecord(admission.terminalPath, 'terminal worker attempt');
    assertAttemptRecordBinding(terminal, admission.binding, 'terminal worker attempt');
    throw new Error(`worker packet attempt ${admission.binding.attempt_id} is already terminal`);
  }
}
