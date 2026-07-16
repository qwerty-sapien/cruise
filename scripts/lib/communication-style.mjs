import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { resolveCodexHome } from './agent-config.mjs';

export const DEFAULT_COMMUNICATION_STYLE = 'default';

export const COMMUNICATION_STYLES = Object.freeze({
  default: Object.freeze({
    id: 'default',
    label: 'Clear and plain',
    description: 'Use everyday language, explain the practical result first, and avoid jargon.',
    instructions: 'Communicate in clear everyday language. Lead with the practical result, keep terminology to what the user needs, and briefly explain any unavoidable technical term.',
  }),
  professional: Object.freeze({
    id: 'professional',
    label: 'Professional and technical',
    description: 'Use concise technical language for an experienced audience.',
    instructions: 'Use a concise professional technical style. Be precise and structured, assuming an experienced audience, while still defining uncommon terms when they matter.',
  }),
  friendly: Object.freeze({
    id: 'friendly',
    label: 'Friendly and creative',
    description: 'Use a warm, collaborative style that supports brainstorming.',
    instructions: 'Use a friendly, collaborative, lightly creative style. Keep the explanation approachable and invite useful ideas without becoming vague.',
  }),
});

export function communicationStylePath({ codexHome = null } = {}) {
  return join(resolveCodexHome(codexHome), 'cruise', 'communication-style.json');
}

function definition(style) {
  const selected = COMMUNICATION_STYLES[style];
  if (!selected) {
    throw new TypeError(`Communication style must be one of ${Object.keys(COMMUNICATION_STYLES).join(', ')}`);
  }
  return selected;
}

function record(selected, { path, persisted, updatedAt = null } = {}) {
  return Object.freeze({
    schema_version: 1,
    kind: 'cruise_communication_style',
    style: selected.id,
    label: selected.label,
    description: selected.description,
    config_path: path,
    persisted,
    updated_at: updatedAt,
  });
}

function parsePersisted(source, path) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new Error(`Cruise communication style is not valid JSON: ${path}`, { cause });
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || parsed.schema_version !== 1
    || parsed.kind !== 'cruise_communication_style'
    || typeof parsed.updated_at !== 'string'
    || !Number.isFinite(Date.parse(parsed.updated_at))
  ) {
    throw new Error(`Cruise communication style has an unsupported shape: ${path}`);
  }
  return record(definition(parsed.style), {
    path,
    persisted: true,
    updatedAt: parsed.updated_at,
  });
}

export async function readCommunicationStyle({ codexHome = null } = {}) {
  const path = communicationStylePath({ codexHome });
  try {
    return parsePersisted(await readFile(path, 'utf8'), path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return record(definition(DEFAULT_COMMUNICATION_STYLE), { path, persisted: false });
  }
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

export async function writeCommunicationStyle(style, {
  codexHome = null,
  now = () => new Date(),
} = {}) {
  const selected = definition(style);
  const path = communicationStylePath({ codexHome });
  const updatedAt = now().toISOString();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await atomicWrite(path, Buffer.from(`${JSON.stringify({
    schema_version: 1,
    kind: 'cruise_communication_style',
    style: selected.id,
    updated_at: updatedAt,
  }, null, 2)}\n`));
  return record(selected, { path, persisted: true, updatedAt });
}

export function communicationStyleInstructions(styleConfig) {
  return definition(styleConfig?.style ?? DEFAULT_COMMUNICATION_STYLE).instructions;
}
