import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { resolveCodexHome } from './agent-config.mjs';
import { resolveModelPolicy } from './model-policy.mjs';
import { WORKER_LEVEL_POLICY } from './worker-policy.mjs';

export const DEFAULT_CRUISE_CLASS = 'normal-cruise';

export const CRUISE_CLASSES = Object.freeze({
  'budget-cruise': Object.freeze({
    id: 'budget-cruise',
    label: 'Budget cruise',
    default_level: 3,
  }),
  'normal-cruise': Object.freeze({
    id: 'normal-cruise',
    label: 'Normal cruise',
    default_level: 4,
  }),
  'premium-cruise': Object.freeze({
    id: 'premium-cruise',
    label: 'Premium cruise',
    default_level: 5,
  }),
  'luxury-cruise': Object.freeze({
    id: 'luxury-cruise',
    label: 'Luxury cruise',
    default_level: 6,
  }),
});

export function cruiseClassPath({ codexHome = null } = {}) {
  return join(resolveCodexHome(codexHome), 'cruise', 'config.json');
}

function classDefinition(value) {
  const definition = CRUISE_CLASSES[value];
  if (!definition) {
    throw new TypeError(`Cruise class must be one of ${Object.keys(CRUISE_CLASSES).join(', ')}`);
  }
  return definition;
}

function classRecord(definition, {
  path,
  persisted,
  updatedAt = null,
} = {}) {
  const worker = WORKER_LEVEL_POLICY[definition.default_level];
  return Object.freeze({
    schema_version: 1,
    kind: 'cruise_class_config',
    cruise_class: definition.id,
    label: definition.label,
    default_level: definition.default_level,
    default_agent_type: worker.agent_type,
    default_alias: worker.alias,
    config_path: path,
    persisted,
    updated_at: updatedAt,
    host_scope: Object.freeze({
      native_cruise: 'host_and_subagents',
      codex_cli_or_gui: 'subagents_only',
    }),
  });
}

function parsePersistedConfig(source, path) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new Error(`Cruise class config is not valid JSON: ${path}`, { cause });
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || parsed.schema_version !== 1
    || parsed.kind !== 'cruise_class_config'
    || typeof parsed.updated_at !== 'string'
    || !Number.isFinite(Date.parse(parsed.updated_at))
  ) {
    throw new Error(`Cruise class config has an unsupported shape: ${path}`);
  }
  const definition = classDefinition(parsed.cruise_class);
  if (parsed.default_level !== definition.default_level) {
    throw new Error(`Cruise class config level does not match ${definition.id}: ${path}`);
  }
  return classRecord(definition, {
    path,
    persisted: true,
    updatedAt: parsed.updated_at,
  });
}

export async function readCruiseClass({ codexHome = null } = {}) {
  const path = cruiseClassPath({ codexHome });
  try {
    return parsePersistedConfig(await readFile(path, 'utf8'), path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return classRecord(classDefinition(DEFAULT_CRUISE_CLASS), {
      path,
      persisted: false,
    });
  }
}

async function atomicWrite(path, bytes) {
  const temporary = join(dirname(path), '.class-stage');
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function writeCruiseClass(cruiseClass, {
  codexHome = null,
  now = () => new Date(),
} = {}) {
  const definition = classDefinition(cruiseClass);
  const path = cruiseClassPath({ codexHome });
  const updatedAt = now().toISOString();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await atomicWrite(path, Buffer.from(`${JSON.stringify({
    schema_version: 1,
    kind: 'cruise_class_config',
    cruise_class: definition.id,
    default_level: definition.default_level,
    updated_at: updatedAt,
  }, null, 2)}\n`));
  return classRecord(definition, { path, persisted: true, updatedAt });
}

/** Resolve the exact host pair used only by the native Cruise app-server client. */
export function resolveNativeCruiseHost(classConfig, catalog) {
  const definition = classDefinition(classConfig?.cruise_class ?? DEFAULT_CRUISE_CLASS);
  const level = definition.default_level;
  const worker = WORKER_LEVEL_POLICY[level];
  const policy = resolveModelPolicy({
    stage: 'native_cruise_host',
    catalog,
    requested: {
      tier: worker.tier,
      reasoning_effort: worker.reasoning_effort,
    },
  });
  if (policy.degraded || !policy.resolved.model || !policy.resolved.reasoning_effort) {
    throw new Error(
      `native Cruise ${definition.id} requires level ${level} (${worker.alias}): ${policy.degradation_reasons.join('; ')}`,
    );
  }
  return Object.freeze({
    cruise_class: definition.id,
    level,
    agent_type: worker.agent_type,
    alias: worker.alias,
    model: policy.resolved.model,
    reasoning_effort: policy.resolved.reasoning_effort,
  });
}

export function cruiseClassInstructions(classConfig, { nativeHost = false } = {}) {
  const definition = classDefinition(classConfig?.cruise_class ?? DEFAULT_CRUISE_CLASS);
  const worker = WORKER_LEVEL_POLICY[definition.default_level];
  return [
    `Cruise class is ${definition.id}; its ordinary-work default is level ${definition.default_level} (${worker.alias}).`,
    'Use that level for ordinary substantive planning, debugging, execution, synthesis, and verification.',
    'A specifically bounded low-cost mapping, retrieval, or trivial task may use a lower justified level; consequence or evidenced failure may require a higher level under the workflow policy.',
    nativeHost
      ? `The native Cruise host is also pinned to level ${definition.default_level}; this class does not relax coordinator, permission, or scope boundaries.`
      : 'When Cruise runs inside Codex CLI or GUI, this preference selects subagent defaults only and never claims to change the host model.',
  ].join(' ');
}
