import { lstat, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { parse as parseToml } from 'smol-toml';

import { assertNoSecretMaterial, assertReadablePath, isSensitivePath } from './sensitive-path.mjs';

export const CRUISE_CONFIG_FILE = '.cruise/config.toml';
export const CRUISE_CONFIG_MAX_BYTES = 64 * 1024;
export const REPOSITORY_PROFILES = Object.freeze(['relaxed', 'business-critical']);

const TARGET_ENVIRONMENTS = new Set(['sandbox', 'production']);
const TARGET_EXECUTIONS = new Set(['local', 'linked']);
const SAFE_OPERATION_KINDS = new Set([
  'add-nullable-column',
  'comment-on',
  'create-index-concurrently',
]);
const FORBIDDEN_KEY = /(?:^|_)(?:access_key|api_key|connection_string|credential|credentials|database_url|db_url|passphrase|passwd|password|private_key|secret|token)(?:_|$)/iu;
const SECRETISH_VALUE = /(?:postgres(?:ql)?:\/\/|-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{12,})/u;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/u;
const NAME = /^[a-z][a-z0-9_-]{0,63}$/u;
const PROJECT_REF = /^[a-z0-9][a-z0-9-]{3,63}$/u;

function ownObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function asString(value, label, { optional = false } = {}) {
  if (value === undefined && optional) return null;
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function asBoolean(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false.`);
  return value;
}

function safeRelativePath(value, label, { allowMissing = false } = {}) {
  if (value === undefined && allowMissing) return null;
  const path = asString(value, label);
  if (isSensitivePath(path)) throw new Error(`${label} cannot name a sensitive path.`);
  if (path.startsWith('/') || path.split(/[\\/]/u).includes('..')) {
    throw new Error(`${label} must stay inside the repository.`);
  }
  return path.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function rejectEmbeddedSecrets(value, path = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectEmbeddedSecrets(item, [...path, String(index)]));
    return;
  }
  if (ownObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key) && !key.endsWith('_env')) {
        throw new Error(`Cruise config must not contain secret-bearing key ${[...path, key].join('.')}.`);
      }
      if (key.endsWith('_env') && (typeof item !== 'string' || !ENV_NAME.test(item))) {
        throw new Error(`${[...path, key].join('.')} must name an environment variable, not contain its value.`);
      }
      rejectEmbeddedSecrets(item, [...path, key]);
    }
    return;
  }
  if (typeof value === 'string') {
    if (SECRETISH_VALUE.test(value)) throw new Error(`Cruise config contains a credential-like value at ${path.join('.')}.`);
    assertNoSecretMaterial(value, `Cruise config ${path.join('.')}`);
  }
}

function normalizeTarget(value, index) {
  if (!ownObject(value)) throw new Error(`migration.targets[${index}] must be a table.`);
  const name = asString(value.name, `migration.targets[${index}].name`);
  if (!NAME.test(name)) throw new Error(`migration.targets[${index}].name is invalid.`);
  const environment = asString(value.environment, `migration.targets[${index}].environment`);
  if (!TARGET_ENVIRONMENTS.has(environment)) throw new Error(`target ${name} environment must be sandbox or production.`);
  const execution = asString(value.execution ?? (environment === 'sandbox' ? 'local' : 'linked'), `target ${name} execution`);
  if (!TARGET_EXECUTIONS.has(execution)) throw new Error(`target ${name} execution must be local or linked.`);
  if (environment === 'production' && execution !== 'linked') {
    throw new Error(`production target ${name} must use linked execution.`);
  }
  const expectedProjectRef = asString(value.expected_project_ref, `target ${name} expected_project_ref`, {
    optional: execution === 'local',
  });
  if (expectedProjectRef && !PROJECT_REF.test(expectedProjectRef)) {
    throw new Error(`target ${name} expected_project_ref is invalid.`);
  }
  const workdir = safeRelativePath(value.workdir ?? '.', `target ${name} workdir`);
  return Object.freeze({ name, environment, execution, expectedProjectRef, workdir });
}

function normalizeDomain(value, index) {
  if (!ownObject(value)) throw new Error(`migration.domains[${index}] must be a table.`);
  const name = asString(value.name, `migration.domains[${index}].name`);
  if (!NAME.test(name)) throw new Error(`migration.domains[${index}].name is invalid.`);
  const tables = asArray(value.tables, `migration domain ${name} tables`).map((table, tableIndex) => {
    const pattern = asString(table, `migration domain ${name} tables[${tableIndex}]`).toLowerCase();
    if (!/^[a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?$/u.test(pattern)) {
      throw new Error(`migration domain ${name} has invalid table ${pattern}.`);
    }
    return pattern.includes('.') ? pattern : `public.${pattern}`;
  });
  if (tables.length === 0) throw new Error(`migration domain ${name} must list at least one table.`);
  const autoApply = asArray(value.auto_apply, `migration domain ${name} auto_apply`).map((operation) => {
    const kind = asString(operation, `migration domain ${name} auto_apply operation`);
    if (!SAFE_OPERATION_KINDS.has(kind)) throw new Error(`migration domain ${name} has unsupported auto_apply operation ${kind}.`);
    return kind;
  });
  return Object.freeze({
    name,
    tables: Object.freeze([...new Set(tables)]),
    serviceCritical: asBoolean(value.service_critical, `migration domain ${name} service_critical`, true),
    autoApply: Object.freeze([...new Set(autoApply)]),
  });
}

function normalizeCheck(value, index, section) {
  if (!ownObject(value)) throw new Error(`${section}[${index}] must be a table.`);
  const name = asString(value.name ?? value.id, `${section}[${index}].name`);
  if (!NAME.test(name)) throw new Error(`${section}[${index}].name is invalid.`);
  const command = asArray(value.command, `${section} ${name} command`).map((part, partIndex) =>
    asString(part, `${section} ${name} command[${partIndex}]`));
  if (command.length === 0) throw new Error(`${section} ${name} must define a command array.`);
  return Object.freeze({ name, command: Object.freeze(command) });
}

function normalizeFlow(value, index) {
  if (!ownObject(value)) throw new Error(`migration.validation.flows[${index}] must be a table.`);
  const name = asString(value.name, `migration.validation.flows[${index}].name`);
  if (!NAME.test(name)) throw new Error(`migration.validation.flows[${index}].name is invalid.`);
  return Object.freeze({
    name,
    path: asString(value.path, `migration flow ${name} path`),
    critical: asBoolean(value.critical, `migration flow ${name} critical`, true),
  });
}

function normalizeDerivedArtifact(value, index) {
  if (!ownObject(value)) throw new Error(`migration.derived_artifacts[${index}] must be a table.`);
  const command = asArray(value.command, `migration.derived_artifacts[${index}].command`).map((part, partIndex) =>
    asString(part, `migration.derived_artifacts[${index}].command[${partIndex}]`));
  return Object.freeze({
    name: asString(value.name, `migration.derived_artifacts[${index}].name`),
    path: safeRelativePath(value.path, `migration.derived_artifacts[${index}].path`),
    command: Object.freeze(command),
  });
}

export function validateCruiseConfig(raw, { source = CRUISE_CONFIG_FILE } = {}) {
  if (!ownObject(raw)) throw new Error(`${source} must contain a TOML table.`);
  rejectEmbeddedSecrets(raw);
  const schemaVersion = raw.schema_version ?? 1;
  if (schemaVersion !== 1) throw new Error(`${source} schema_version must be 1.`);
  const profile = raw.profile ?? 'relaxed';
  if (!REPOSITORY_PROFILES.includes(profile)) throw new Error(`${source} profile must be relaxed or business-critical.`);
  if (raw.migration !== undefined && !ownObject(raw.migration)) throw new Error('migration must be a table.');
  if (raw.workflow !== undefined && !ownObject(raw.workflow)) throw new Error('workflow must be a table.');
  if (raw.security !== undefined && !ownObject(raw.security)) throw new Error('security must be a table.');
  const migration = ownObject(raw.migration) ? raw.migration : {};
  if (migration.validation !== undefined && !ownObject(migration.validation)) {
    throw new Error('migration.validation must be a table.');
  }
  const validation = ownObject(migration.validation) ? migration.validation : {};
  const workflow = ownObject(raw.workflow) ? raw.workflow : {};
  const targets = asArray(migration.targets, 'migration.targets').map(normalizeTarget);
  const names = new Set();
  for (const target of targets) {
    if (names.has(target.name)) throw new Error(`duplicate migration target ${target.name}.`);
    names.add(target.name);
  }
  const explicitSensitivePaths = asArray(raw.security?.explicit_sensitive_paths, 'security.explicit_sensitive_paths')
    .map((path, index) => safeRelativePath(path, `security.explicit_sensitive_paths[${index}]`));
  return Object.freeze({
    schemaVersion,
    profile,
    source,
    workflow: Object.freeze({
      autoPromoteAfterChecks: asBoolean(workflow.auto_promote_after_checks, 'workflow.auto_promote_after_checks', true),
      allowManualLocalhost: asBoolean(workflow.allow_manual_localhost, 'workflow.allow_manual_localhost', true),
    }),
    security: Object.freeze({ explicitSensitivePaths: Object.freeze(explicitSensitivePaths) }),
    migration: Object.freeze({
      targets: Object.freeze(targets),
      domains: Object.freeze(asArray(migration.domains, 'migration.domains').map(normalizeDomain)),
      validation: Object.freeze({
        commands: Object.freeze(asArray(validation.commands, 'migration.validation.commands')
          .map((value, index) => normalizeCheck(value, index, 'migration.validation.commands'))),
        flows: Object.freeze(asArray(validation.flows, 'migration.validation.flows').map(normalizeFlow)),
      }),
      policyChecks: Object.freeze(asArray(migration.policy_checks, 'migration.policy_checks')
        .map((value, index) => normalizeCheck(value, index, 'migration.policy_checks'))),
      derivedArtifacts: Object.freeze(asArray(migration.derived_artifacts, 'migration.derived_artifacts')
        .map(normalizeDerivedArtifact)),
    }),
  });
}

export function defaultCruiseConfig() {
  return validateCruiseConfig({
    schema_version: 1,
    profile: 'relaxed',
    migration: {
      targets: [{ name: 'sandbox', environment: 'sandbox', execution: 'local', workdir: '.' }],
    },
  }, { source: 'built-in relaxed defaults' });
}

export async function loadCruiseConfig(cwd) {
  const root = resolve(cwd);
  const path = join(root, CRUISE_CONFIG_FILE);
  assertReadablePath(path);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return defaultCruiseConfig();
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${CRUISE_CONFIG_FILE} must be a regular file.`);
  if (metadata.size > CRUISE_CONFIG_MAX_BYTES) throw new Error(`${CRUISE_CONFIG_FILE} exceeds 64 KB.`);
  const text = await readFile(path, 'utf8');
  let raw;
  try {
    raw = parseToml(text);
  } catch (error) {
    throw new Error(`invalid ${CRUISE_CONFIG_FILE}: ${error?.message ?? error}`);
  }
  return validateCruiseConfig(raw, { source: relative(root, path) });
}

export function targetByName(config, name) {
  const target = config.migration.targets.find((candidate) => candidate.name === name);
  if (!target) throw new Error(`unknown migration target ${name}.`);
  return target;
}
