import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { targetByName } from './migration-config.mjs';
import {
  authorizationMatches,
  classifyMigration,
  informedMigrationChoices,
  MIGRATION_ACTION,
} from './migration-policy.mjs';
import { assertNoSecretMaterial, assertReadablePath, isSensitivePath } from './sensitive-path.mjs';

const SQL_FILE_MAX_BYTES = 2 * 1024 * 1024;
const SQL_BATCH_MAX_BYTES = 4 * 1024 * 1024;
const SQL_BATCH_MAX_FILES = 500;
const SAFE_CHECK_EXECUTABLES = new Set(['bun', 'node', 'npm', 'npx', 'pnpm', 'pytest', 'python3', 'yarn']);
const SOURCE_EXTENSIONS = /\.(?:cjs|js|jsx|json|md|mjs|sql|toml|ts|tsx)$/iu;
const SKIPPED_DIRECTORIES = new Set(['.git', '.next', 'build', 'coverage', 'dist', 'node_modules', 'vendor']);
const DEPENDENCY_SCAN_MAX_FILES = 5_000;
const DEPENDENCY_SCAN_MAX_BYTES = 16 * 1024 * 1024;
const DEPENDENCY_FILE_MAX_BYTES = 256 * 1024;

function stableDigest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function redactMigrationDiagnostic(value) {
  return String(value ?? '')
    .replace(/postgres(?:ql)?:\/\/[^\s'"`]+/giu, '<redacted-database-url>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gu, 'Bearer <redacted>')
    .replace(/\b(password|passwd|secret|token)\s*[=:]\s*[^\s,;]+/giu, '$1=<redacted>')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function migrationFiles(cwd, target, paths, explicitSensitivePaths) {
  const root = resolve(cwd);
  let candidates = paths;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    const directory = resolve(root, target.workdir, 'supabase/migrations');
    if (!inside(root, directory)) throw new Error('migration directory leaves the repository.');
    candidates = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql') && !isSensitivePath(entry.name, { explicitSensitivePaths }))
      .map((entry) => relative(root, join(directory, entry.name)));
  }
  if (candidates.length === 0) throw new Error('no migration SQL files were selected.');
  if (candidates.length > SQL_BATCH_MAX_FILES) throw new Error('migration batch exceeds 500 files.');
  const unique = [...new Set(candidates)].sort();
  const files = [];
  let totalBytes = 0;
  for (const candidate of unique) {
    assertReadablePath(candidate, { explicitSensitivePaths });
    if (!String(candidate).toLowerCase().endsWith('.sql')) throw new Error(`migration path must end in .sql: ${candidate}`);
    const path = resolve(root, candidate);
    if (!inside(root, path)) throw new Error(`migration path leaves the repository: ${candidate}`);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`migration path must be a regular file: ${candidate}`);
    if (metadata.size > SQL_FILE_MAX_BYTES) throw new Error(`migration file exceeds 2 MB: ${candidate}`);
    totalBytes += metadata.size;
    if (totalBytes > SQL_BATCH_MAX_BYTES) throw new Error('migration batch exceeds 4 MB.');
    files.push(Object.freeze({ path, relativePath: relative(root, path).replaceAll('\\', '/'), sql: await readFile(path, 'utf8') }));
  }
  return Object.freeze(files);
}

function verifiedTarget(target, observation) {
  if (!observation || observation.environment !== target.environment) return false;
  if (target.execution === 'linked') return observation.actualIdentity === target.expectedProjectRef;
  return target.environment === 'sandbox' && observation.actualIdentity?.startsWith('local:');
}

function batchSql(files, suppliedSql) {
  if (suppliedSql !== undefined) return String(suppliedSql);
  return files.map(({ relativePath, sql }) => `-- cruise-file: ${relativePath}\n${sql}`).join('\n');
}

function result(state, details = {}) {
  return Object.freeze({ state, ...details });
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Conservative proof for a new nullable, default-free column. It deliberately
 * skips every sensitive path before opening files and treats whole-row API or
 * trigger behavior as material rather than guessing that it is harmless.
 */
export async function inspectLocalAdditiveDependencies({
  cwd,
  operations,
  excludedFiles = [],
  explicitSensitivePaths = [],
}) {
  const root = resolve(cwd);
  const excluded = new Set(excludedFiles.map((path) => resolve(root, path)));
  const files = [];
  let totalBytes = 0;
  async function walk(directory) {
    if (files.length >= DEPENDENCY_SCAN_MAX_FILES) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const rel = relative(root, path).replaceAll('\\', '/');
      if (isSensitivePath(rel, { explicitSensitivePaths })) continue;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && rel !== '.cruise/artifacts') await walk(path);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name) && !excluded.has(path)) {
        const metadata = await lstat(path);
        if (metadata.size <= DEPENDENCY_FILE_MAX_BYTES && totalBytes + metadata.size <= DEPENDENCY_SCAN_MAX_BYTES) {
          totalBytes += metadata.size;
          files.push({ path, rel });
        }
      }
      if (files.length >= DEPENDENCY_SCAN_MAX_FILES || totalBytes >= DEPENDENCY_SCAN_MAX_BYTES) return;
    }
  }
  await walk(root);
  const applicationReferences = [];
  const materialDependencies = [];
  let apiExposureChanged = false;
  let triggerChanged = false;
  for (const file of files) {
    const text = await readFile(file.path, 'utf8');
    for (const operation of operations) {
      if (operation.kind !== 'add-nullable-column') continue;
      const tableName = operation.table.split('.').at(-1);
      const table = regexEscape(tableName);
      const wholeRowApi = new RegExp(`(?:from\\s*\\(\\s*['\"]${table}['\"]\\s*\\)[\\s\\S]{0,500}select\\s*\\(\\s*['\"]\\*['\"]|select\\s*\\(\\s*['\"]\\*['\"][\\s\\S]{0,500}from\\s*\\(\\s*['\"]${table}['\"]\\s*\\))`, 'iu');
      const wholeRowTrigger = new RegExp(`(?:create\\s+trigger[\\s\\S]{0,800}\\bon\\s+(?:public\\.)?${table}\\b[\\s\\S]{0,1200}(?:row_to_json|to_jsonb\\s*\\(\\s*(?:new|old)\\s*\\)|new\\.\\*)|(?:row_to_json|to_jsonb\\s*\\(\\s*(?:new|old)\\s*\\)|new\\.\\*)[\\s\\S]{0,1200}create\\s+trigger[\\s\\S]{0,800}\\bon\\s+(?:public\\.)?${table}\\b)`, 'iu');
      if (wholeRowApi.test(text)) {
        apiExposureChanged = true;
        applicationReferences.push(`${file.rel}: whole-row API selection for ${operation.table}`);
      }
      if (file.rel.endsWith('.sql') && wholeRowTrigger.test(text)) {
        triggerChanged = true;
        materialDependencies.push(`${file.rel}: whole-row trigger behavior for ${operation.table}`);
      }
    }
  }
  const bounded = files.length < DEPENDENCY_SCAN_MAX_FILES && totalBytes < DEPENDENCY_SCAN_MAX_BYTES;
  return Object.freeze({
    catalogChecked: bounded,
    materialDependencies: Object.freeze([...new Set(materialDependencies)]),
    apiExposureChanged,
    policyChanged: false,
    triggerChanged,
    typeGenerationChanged: false,
    applicationReferences: Object.freeze([...new Set(applicationReferences)]),
    scan: Object.freeze({ files: files.length, bytes: totalBytes, bounded }),
  });
}

export class MigrationController {
  constructor({ cwd, config, adapter, now = () => Date.now(), uuid = randomUUID }) {
    if (!adapter) throw new Error('MigrationController requires an execution adapter.');
    this.cwd = resolve(cwd);
    this.config = config;
    this.adapter = adapter;
    this.now = now;
    this.uuid = uuid;
    this.locks = new Map();
    this.applied = new Map();
    this.pendingManual = new Map();
    this.consumedAuthorizations = new Set();
  }

  async #withLock(key, callback) {
    const prior = this.locks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolvePromise) => { release = resolvePromise; });
    const tail = prior.then(() => current);
    this.locks.set(key, tail);
    await prior;
    try {
      return await callback();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  async #observeTarget(target) {
    const observation = await this.adapter.inspectTarget(target, { cwd: this.cwd });
    return Object.freeze({
      ...target,
      actualIdentity: observation?.actualIdentity ?? null,
      verified: verifiedTarget(target, observation),
      observation: Object.freeze({
        environment: observation?.environment ?? null,
        actualIdentity: observation?.actualIdentity ?? null,
      }),
    });
  }

  async #classify({ target, sql, mode }) {
    const base = {
      sql,
      target,
      config: this.config,
      mode,
      targetVerified: target.verified,
      readOnlyEnforced: this.adapter.readOnlyEnforced === true,
    };
    let decision = classifyMigration(base);
    let dependencyEvidence = null;
    let policyEvidence = null;
    if (decision.action === MIGRATION_ACTION.requireAnalysis && decision.reason === 'strict-dependency-proof-required') {
      dependencyEvidence = await this.adapter.inspectDependencies?.({
        cwd: this.cwd,
        target,
        sql,
        operations: decision.operations,
        affectedTables: decision.affectedTables,
        excludedFiles: String(sql).match(/^-- cruise-file: (.+)$/gmu)?.map((line) => line.slice('-- cruise-file: '.length)) ?? [],
      }) ?? {
        catalogChecked: false,
        materialDependencies: [],
        apiExposureChanged: false,
        policyChanged: false,
        triggerChanged: false,
        typeGenerationChanged: false,
        applicationReferences: [],
        analysisUnavailable: true,
      };
      decision = classifyMigration({ ...base, dependencyEvidence });
    }
    if (decision.action === MIGRATION_ACTION.requireAnalysis && decision.reason === 'policy-checks-required') {
      policyEvidence = await this.adapter.runPolicyChecks?.(this.config.migration.policyChecks, {
        cwd: this.cwd, target, sql,
      }) ?? { checked: true, conflicts: true, passed: [], analysisUnavailable: true };
      decision = classifyMigration({ ...base, dependencyEvidence, policyEvidence });
    }
    return Object.freeze({ decision, dependencyEvidence, policyEvidence });
  }

  async inspect({ targetName, paths = [], sql, mode = 'migration' }) {
    const configuredTarget = targetByName(this.config, targetName);
    const target = await this.#observeTarget(configuredTarget);
    const files = sql === undefined
      ? await migrationFiles(this.cwd, target, paths, this.config.security.explicitSensitivePaths)
      : Object.freeze([]);
    const source = batchSql(files, sql);
    assertNoSecretMaterial(source, 'migration SQL');
    const analysis = await this.#classify({ target, sql: source, mode });
    return result('inspected', {
      target: target.name,
      targetIdentity: target.actualIdentity,
      targetVerified: target.verified,
      files: files.map(({ relativePath }) => relativePath),
      decision: analysis.decision,
      choices: informedMigrationChoices(analysis.decision),
      dependencyEvidence: analysis.dependencyEvidence,
      policyEvidence: analysis.policyEvidence,
      sql: source,
    });
  }

  async #refreshDerivedArtifacts(context) {
    if (this.config.migration.derivedArtifacts.length === 0) return [];
    return await this.adapter.updateDerivedArtifacts?.(this.config.migration.derivedArtifacts, context) ?? [];
  }

  async #applyInspected(inspection, { authorization = null, authorizationAlternative = false } = {}) {
    const { decision } = inspection;
    if (!inspection.targetVerified || decision.action === MIGRATION_ACTION.block) {
      return result('blocked', { decision, reason: decision.reason });
    }
    const authorizationKey = authorization ? `${authorization.target}:${authorization.digest}` : null;
    const authorized = authorizationAlternative || (
      authorizationMatches(decision, authorization)
      && !this.consumedAuthorizations.has(authorizationKey)
    );
    if (decision.action === MIGRATION_ACTION.requireAnalysis) {
      return result('analysis-required', { decision, reason: decision.reason });
    }
    if (decision.action === MIGRATION_ACTION.requireAuthorization && !authorized) {
      return result('authorization-required', { decision, choices: informedMigrationChoices(decision) });
    }
    const receiptKey = `${decision.target}:${decision.digest}`;
    if (this.applied.has(receiptKey)) return result('already-applied', { receipt: this.applied.get(receiptKey), decision });
    const configuredTarget = targetByName(this.config, decision.target);
    const currentTarget = await this.#observeTarget(configuredTarget);
    if (!currentTarget.verified || currentTarget.actualIdentity !== inspection.targetIdentity) {
      return result('blocked', { decision, reason: 'target-identity-drifted-before-apply' });
    }
    const target = configuredTarget;
    const context = {
      cwd: this.cwd,
      target,
      sql: inspection.sql,
      files: inspection.files,
      digest: decision.digest,
    };
    const preview = await this.adapter.previewMigration?.(context) ?? { ok: true };
    if (preview.ok !== true) return result('blocked', { decision, reason: 'migration-preview-failed', detail: redactMigrationDiagnostic(preview.detail) });
    const applied = await this.adapter.applyMigration(context);
    if (applied?.ok !== true) return result('failed', { decision, reason: 'migration-apply-failed', detail: redactMigrationDiagnostic(applied?.detail) });
    let derivedArtifacts = [];
    let derivedArtifactWarning = null;
    try {
      derivedArtifacts = await this.#refreshDerivedArtifacts(context);
    } catch (error) {
      derivedArtifactWarning = redactMigrationDiagnostic(error?.message ?? error);
    }
    const receipt = Object.freeze({
      target: decision.target,
      environment: decision.environment,
      digest: decision.digest,
      appliedAt: this.now(),
      derivedArtifacts,
      derivedArtifactWarning,
    });
    this.applied.set(receiptKey, receipt);
    if (authorizationKey && authorized) this.consumedAuthorizations.add(authorizationKey);
    return result('applied', { decision, receipt });
  }

  async apply({
    targetName,
    paths = [],
    sql,
    mode = 'migration',
    authorization = null,
    sandboxFirst = null,
  }) {
    const inspection = await this.inspect({ targetName, paths, sql, mode });
    const key = `${inspection.decision.target}:${inspection.decision.digest}`;
    return this.#withLock(key, async () => {
      if (mode === 'query') {
        if (inspection.decision.action !== MIGRATION_ACTION.autoApply) {
          return result('blocked', { decision: inspection.decision, reason: inspection.decision.reason });
        }
        const currentTarget = await this.#observeTarget(targetByName(this.config, targetName));
        if (!currentTarget.verified || currentTarget.actualIdentity !== inspection.targetIdentity) {
          return result('blocked', { decision: inspection.decision, reason: 'target-identity-drifted-before-query' });
        }
        const queried = await this.adapter.queryReadOnly({
          cwd: this.cwd,
          target: targetByName(this.config, targetName),
          sql: inspection.decision.statement,
          digest: inspection.decision.digest,
        });
        return queried?.ok === true
          ? result('queried', { decision: inspection.decision, summary: queried.summary ?? null })
          : result('failed', { decision: inspection.decision, reason: 'read-only-query-failed', detail: redactMigrationDiagnostic(queried?.detail) });
      }
      if (inspection.decision.action !== MIGRATION_ACTION.requireAuthorization || authorization) {
        return this.#applyInspected(inspection, { authorization });
      }
      const route = sandboxFirst === 'auto' && !this.config.workflow.autoPromoteAfterChecks
        ? 'manual'
        : sandboxFirst;
      if (route === 'manual' && !this.config.workflow.allowManualLocalhost) {
        return result('authorization-required', {
          decision: inspection.decision,
          choices: informedMigrationChoices(inspection.decision).filter(({ value }) => value !== 'sandbox-manual'),
          reason: 'manual-localhost-route-disabled-by-profile',
        });
      }
      if (!['auto', 'manual'].includes(route)) return this.#applyInspected(inspection);
      const sandbox = this.config.migration.targets.find(({ environment }) => environment === 'sandbox');
      if (!sandbox) return result('authorization-required', {
        decision: inspection.decision,
        choices: informedMigrationChoices(inspection.decision),
        reason: 'sandbox-target-not-configured',
      });
      const sandboxInspection = await this.inspect({ targetName: sandbox.name, paths, sql, mode: 'migration' });
      const sandboxResult = await this.#applyInspected(sandboxInspection);
      if (!['applied', 'already-applied'].includes(sandboxResult.state)) return sandboxResult;
      const validation = await this.adapter.validateSandbox?.({
        cwd: this.cwd,
        target: sandbox,
        productionTarget: targetByName(this.config, targetName),
        sql: inspection.sql,
        digest: inspection.decision.digest,
        commands: this.config.migration.validation.commands,
        flows: this.config.migration.validation.flows,
        policyChecks: this.config.migration.policyChecks,
      }) ?? { passed: false, failed: ['sandbox-validation-adapter-missing'] };
      if (validation.passed !== true || validation.seriousIssues === true) {
        return result('sandbox-failed', {
          decision: inspection.decision,
          sandboxReceipt: sandboxResult.receipt,
          retained: true,
          failed: validation.failed ?? [],
          rollback: validation.rollback ?? null,
        });
      }
      if (route === 'manual') {
        const token = this.uuid();
        this.pendingManual.set(token, Object.freeze({ inspection, validation, sandboxReceipt: sandboxResult.receipt }));
        return result('awaiting-manual-confirmation', {
          decision: inspection.decision,
          confirmationToken: token,
          sandboxReceipt: sandboxResult.receipt,
          validation,
        });
      }
      const refreshed = await this.inspect({ targetName, paths, sql, mode: 'migration' });
      if (refreshed.decision.digest !== inspection.decision.digest || !refreshed.targetVerified) {
        return result('blocked', { decision: refreshed.decision, reason: 'production-target-or-sql-drifted-after-sandbox' });
      }
      const promoted = await this.#applyInspected(refreshed, { authorizationAlternative: true });
      return ['applied', 'already-applied'].includes(promoted.state)
        ? result('promoted', { decision: inspection.decision, sandboxReceipt: sandboxResult.receipt, productionReceipt: promoted.receipt, validation })
        : promoted;
    });
  }

  async confirmManualPromotion(token) {
    const pending = this.pendingManual.get(token);
    if (!pending) return result('blocked', { reason: 'manual-confirmation-token-invalid-or-expired' });
    this.pendingManual.delete(token);
    const refreshedTarget = await this.#observeTarget(targetByName(this.config, pending.inspection.target));
    const refreshed = { ...pending.inspection, targetVerified: refreshedTarget.verified };
    if (!refreshedTarget.verified) return result('blocked', { reason: 'production-target-drifted-after-manual-validation' });
    const promoted = await this.#applyInspected(refreshed, { authorizationAlternative: true });
    return ['applied', 'already-applied'].includes(promoted.state)
      ? result('promoted', {
        decision: pending.inspection.decision,
        sandboxReceipt: pending.sandboxReceipt,
        productionReceipt: promoted.receipt,
        validation: pending.validation,
      })
      : promoted;
  }

  status() {
    return Object.freeze({
      profile: this.config.profile,
      targets: this.config.migration.targets.map(({ name, environment, execution }) => ({ name, environment, execution })),
      applied: [...this.applied.values()],
      pendingManual: this.pendingManual.size,
    });
  }
}

function runProcess(command, args, { cwd, timeoutMs = 5 * 60_000 }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let forceTimer = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      forceTimer.unref?.();
    }, timeoutMs);
    timeout.unref?.();
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      resolvePromise(value);
    };
    child.stdout.on('data', (chunk) => { if (stdout.length < 64 * 1024) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk; });
    child.once('error', (error) => finish({ ok: false, detail: error.message }));
    child.once('close', (code) => finish({
      ok: code === 0 && !timedOut,
      detail: timedOut ? `command timed out after ${timeoutMs}ms` : code === 0 ? stdout : stderr || stdout,
      stdout,
    }));
  });
}

export class SupabaseCliMigrationAdapter {
  constructor({ cwd, config = null, cli = ['npx', '--yes', 'supabase@2.113.0'], runner = runProcess, flowRunner = null } = {}) {
    this.cwd = resolve(cwd);
    this.config = config;
    this.cli = cli;
    this.runner = runner;
    this.flowRunner = flowRunner;
    this.readOnlyEnforced = true;
  }

  #workdir(target) {
    return resolve(this.cwd, target.workdir);
  }

  async #run(args, cwd = this.cwd) {
    const [command, ...prefix] = this.cli;
    return this.runner(command, [...prefix, ...args], { cwd });
  }

  async inspectTarget(target) {
    const workdir = this.#workdir(target);
    if (target.execution === 'local') {
      const configPath = join(workdir, 'supabase/config.toml');
      const metadata = await lstat(configPath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('local Supabase config must be a regular file.');
      return { environment: 'sandbox', actualIdentity: `local:${workdir}` };
    }
    const projectRefPath = join(workdir, 'supabase/.temp/project-ref');
    assertReadablePath(projectRefPath);
    const metadata = await lstat(projectRefPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('linked Supabase project ref must be a regular file.');
    return { environment: target.environment, actualIdentity: (await readFile(projectRefPath, 'utf8')).trim() };
  }

  async inspectDependencies(input) {
    return inspectLocalAdditiveDependencies({
      cwd: input.cwd,
      operations: input.operations,
      excludedFiles: input.excludedFiles,
      explicitSensitivePaths: this.config?.security?.explicitSensitivePaths ?? [],
    });
  }

  async previewMigration({ target, files }) {
    if (files.length === 0) {
      return { ok: false, detail: 'Supabase apply requires an inspected migration file batch.' };
    }
    const flag = target.execution === 'local' ? '--local' : '--linked';
    const preview = await this.#run(['db', 'push', flag, '--dry-run', '--workdir', this.#workdir(target), '--yes']);
    if (!preview.ok) return preview;
    const expected = files.map((path) => basename(path));
    const reported = [...new Set([...preview.stdout.matchAll(/([A-Za-z0-9_-]+\.sql)\b/gu)].map((match) => match[1]))];
    if (expected.length > 0 && (
      reported.length === 0
      || expected.some((name) => !reported.includes(name))
      || reported.some((name) => !expected.includes(name))
    )) {
      return { ok: false, detail: 'Supabase dry-run migration set differs from the inspected migration batch.' };
    }
    return { ok: true, detail: 'Supabase dry-run matched the inspected migration batch.' };
  }

  async applyMigration({ target }) {
    const flag = target.execution === 'local' ? '--local' : '--linked';
    return this.#run(['db', 'push', flag, '--workdir', this.#workdir(target), '--yes']);
  }

  async queryReadOnly({ target, sql }) {
    const directory = await mkdtemp(join(tmpdir(), 'cruise-read-only-query-'));
    const path = join(directory, 'query.sql');
    const wrapped = `begin read only;\nset local statement_timeout = '5s';\nselect * from (${sql.replace(/;\s*$/u, '')}) as cruise_read_only limit 200;\nrollback;\n`;
    try {
      await writeFile(path, wrapped, { mode: 0o600 });
      const flag = target.execution === 'local' ? '--local' : '--linked';
      const response = await this.#run(['db', 'query', flag, '--file', path, '--workdir', this.#workdir(target)]);
      return response.ok ? { ok: true, summary: 'Read-only query completed.' } : response;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async #runChecks(checks, cwd) {
    const passed = [];
    const failed = [];
    for (const check of checks) {
      if (!SAFE_CHECK_EXECUTABLES.has(check.command[0])) {
        failed.push(`${check.name}: executable is not allowed`);
        continue;
      }
      const response = await this.runner(check.command[0], check.command.slice(1), { cwd });
      if (response.ok) passed.push(check.name);
      else failed.push(`${check.name}: ${redactMigrationDiagnostic(response.detail)}`);
    }
    return { passed, failed };
  }

  async runPolicyChecks(checks, { cwd }) {
    const resultValue = await this.#runChecks(checks, cwd);
    return { checked: true, conflicts: resultValue.failed.length > 0, passed: resultValue.passed, failed: resultValue.failed };
  }

  async updateDerivedArtifacts(artifacts, { cwd }) {
    const runnable = artifacts.filter(({ command }) => command.length > 0);
    const checks = runnable.map(({ name, command }) => ({ name, command }));
    const resultValue = await this.#runChecks(checks, cwd);
    if (resultValue.failed.length > 0) throw new Error(`derived artifact refresh failed: ${resultValue.failed.join(', ')}`);
    return resultValue.passed;
  }

  async validateSandbox({ cwd, commands, flows, policyChecks }) {
    const commandResult = await this.#runChecks([...commands, ...policyChecks], cwd);
    const flowFailures = [];
    if (flows.length > 0 && !this.flowRunner) flowFailures.push('computer-use flow runner unavailable');
    if (this.flowRunner) {
      for (const flow of flows) {
        const response = await this.flowRunner(flow);
        if (response?.passed !== true) flowFailures.push(flow.name);
      }
    }
    const failed = [...commandResult.failed, ...flowFailures];
    return {
      passed: failed.length === 0,
      seriousIssues: failed.length > 0,
      passedChecks: commandResult.passed,
      failed,
      rollback: failed.length > 0 ? 'Sandbox retained; production was not changed.' : null,
    };
  }
}
