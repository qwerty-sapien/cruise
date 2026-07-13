import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WORKER_LEVEL_POLICY } from './worker-policy.mjs';

export const MANAGED_AGENT_HEADER = '# Managed by Cruise.';
export const MANAGED_CONFIG_BEGIN = '# BEGIN CRUISE MANAGED AGENTS';
export const MANAGED_CONFIG_END = '# END CRUISE MANAGED AGENTS';
export const AGENT_CONFIG_SOURCE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../internal/agent-configs',
);

export function resolveCodexHome(value = null) {
  return resolve(value ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function managedAgentConfigNames() {
  return Object.keys(WORKER_LEVEL_POLICY).map((level) => `cruise_l${level}.toml`);
}

export function managedAgentRegistrationBlock() {
  const lines = [MANAGED_CONFIG_BEGIN];
  for (const [level, { agent_type: agentType, alias }] of Object.entries(WORKER_LEVEL_POLICY)) {
    lines.push(
      '',
      `[agents.${agentType}]`,
      `description = "Cruise level ${level} (${alias}) managed worker"`,
      `config_file = "agents/${agentType}.toml"`,
    );
  }
  lines.push('', MANAGED_CONFIG_END);
  return `${lines.join('\n')}\n`;
}

function inspectRegistration(configBytes) {
  const expected = managedAgentRegistrationBlock();
  if (configBytes === null) {
    return { status: 'missing', expected, start: null, end: null };
  }
  const source = configBytes.toString('utf8');
  const begin = source.indexOf(MANAGED_CONFIG_BEGIN);
  const endMarker = source.indexOf(MANAGED_CONFIG_END);
  const unmanagedRole = Object.values(WORKER_LEVEL_POLICY).find(({ agent_type: agentType }) =>
    new RegExp(`^\\[agents\\.${agentType}\\]\\s*$`, 'mu').test(source),
  );
  if (begin === -1 && endMarker === -1) {
    return {
      status: unmanagedRole ? 'conflict' : 'missing',
      expected,
      start: null,
      end: null,
    };
  }
  if (begin === -1 || endMarker === -1 || endMarker < begin) {
    return { status: 'conflict', expected, start: null, end: null };
  }
  const markerEnd = endMarker + MANAGED_CONFIG_END.length;
  const end = markerEnd + (source[markerEnd] === '\n' ? 1 : 0);
  return {
    status: source.slice(begin, end) === expected ? 'current' : 'stale',
    expected,
    start: begin,
    end,
  };
}

export async function inspectManagedAgentConfigs({ codexHome = null } = {}) {
  const sourceDirectory = AGENT_CONFIG_SOURCE_DIR;
  const resolvedCodexHome = resolveCodexHome(codexHome);
  const targetDirectory = join(resolvedCodexHome, 'agents');
  const configPath = join(resolvedCodexHome, 'config.toml');
  let configBytes = null;
  try {
    configBytes = await readFile(configPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const registration = inspectRegistration(configBytes);
  const files = [];
  for (const file of managedAgentConfigNames()) {
    const sourcePath = join(sourceDirectory, file);
    const targetPath = join(targetDirectory, file);
    const source = await readFile(sourcePath);
    let target = null;
    try {
      target = await readFile(targetPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const managed = target === null || target.toString('utf8').startsWith(MANAGED_AGENT_HEADER);
    files.push({
      file,
      source_path: sourcePath,
      target_path: targetPath,
      expected_sha256: sha256(source),
      actual_sha256: target === null ? null : sha256(target),
      status: target === null
        ? 'missing'
        : Buffer.compare(source, target) === 0
          ? 'current'
          : managed
            ? 'stale'
            : 'conflict',
    });
  }
  return Object.freeze({
    codex_home: resolvedCodexHome,
    config_path: configPath,
    registration: Object.freeze({
      status: registration.status,
      expected_sha256: sha256(Buffer.from(registration.expected)),
      actual_sha256: registration.status === 'current'
        ? sha256(Buffer.from(registration.expected))
        : null,
    }),
    target_directory: targetDirectory,
    files: Object.freeze(files.map(Object.freeze)),
    ready: registration.status === 'current' && files.every(({ status }) => status === 'current'),
  });
}

async function atomicWrite(path, bytes) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function installManagedAgentConfigs({ codexHome = null } = {}) {
  const before = await inspectManagedAgentConfigs({ codexHome });
  const conflict = before.files.find(({ status }) => status === 'conflict');
  if (conflict) {
    throw new Error(`refusing to replace unmanaged Codex agent config: ${conflict.target_path}`);
  }
  if (before.registration.status === 'conflict') {
    throw new Error(`refusing to replace unmanaged or malformed Cruise registrations in ${before.config_path}`);
  }
  await mkdir(before.codex_home, { recursive: true, mode: 0o700 });
  await mkdir(before.target_directory, { recursive: true, mode: 0o700 });
  await access(before.target_directory, fsConstants.W_OK);
  const changed = [];
  for (const file of before.files) {
    if (file.status === 'current') continue;
    await atomicWrite(file.target_path, await readFile(file.source_path));
    changed.push(file.file);
  }
  if (before.registration.status !== 'current') {
    let source = '';
    try {
      source = await readFile(before.config_path, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const registration = inspectRegistration(Buffer.from(source));
    if (registration.status === 'stale') {
      source = `${source.slice(0, registration.start)}${registration.expected}${source.slice(registration.end)}`;
    } else {
      const separator = source.length === 0 || source.endsWith('\n\n')
        ? ''
        : source.endsWith('\n')
          ? '\n'
          : '\n\n';
      source = `${source}${separator}${registration.expected}`;
    }
    await atomicWrite(before.config_path, Buffer.from(source));
    changed.push('config.toml');
  }
  const after = await inspectManagedAgentConfigs({ codexHome });
  if (!after.ready) throw new Error('managed Codex agent installation did not converge');
  return Object.freeze({ ...after, changed: Object.freeze(changed) });
}
