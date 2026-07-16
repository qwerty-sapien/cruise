import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { readYamlFile } from './yaml-state.mjs';

export const MAX_ARTIFACT_NAME_LENGTH = 15;

export const RUN_ARTIFACTS = Object.freeze({
  origin: 'origin.yaml',
  probe: 'probe.yaml',
  route: 'route.yaml',
  state: 'state.yaml',
  evidence: 'evidence.yaml',
  drift: 'drift.yaml',
  driftLock: 'drift.lock',
  mapPacket: 'map-pkt.yaml',
  mapFacts: 'map-facts.yaml',
  naming: 'run-name.yaml',
});

export const REPOSITORY_ARTIFACTS = Object.freeze({
  naming: 'repo.yaml',
});

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const FILE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z0-9]+)?$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_FRAGMENT = /(?:^|-)[a-f0-9]{8,}(?:-|$)/iu;
const LONG_NUMBER = /\d{6,}/u;
const GENERIC = new Set([
  'artifact',
  'data',
  'dir',
  'directory',
  'file',
  'name',
  'output',
  'result',
  'run',
  'task',
  'temp',
  'tmp',
  'work',
]);

function namingError(label, reason) {
  throw new TypeError(`${label} ${reason}`);
}

export function assertInformativeName(value, {
  label = 'artifact name',
  allowExtension = false,
} = {}) {
  if (typeof value !== 'string' || value.length === 0) {
    namingError(label, 'must be a non-empty string');
  }
  if (value.length > MAX_ARTIFACT_NAME_LENGTH) {
    namingError(label, `must be at most ${MAX_ARTIFACT_NAME_LENGTH} characters`);
  }
  if (!(allowExtension ? FILE : NAME).test(value)) {
    namingError(label, 'must use a lowercase informative slug');
  }
  if (UUID.test(value) || HASH_FRAGMENT.test(value) || LONG_NUMBER.test(value)) {
    namingError(label, 'must not contain a UUID, hash fragment, timestamp, or random-looking number');
  }
  const stem = allowExtension ? value.split('.')[0] : value;
  if (GENERIC.has(stem)) namingError(label, 'must describe its purpose');
  return value;
}

export function assertRunName(value) {
  return assertInformativeName(value, { label: 'run name' });
}

export function assertArtifactFileName(value) {
  return assertInformativeName(value, { label: 'artifact filename', allowExtension: true });
}

export function parseLevelOneNameOutput(source) {
  let value;
  try {
    value = JSON.parse(String(source));
  } catch (cause) {
    throw new TypeError('level-1 naming worker must return exact JSON', { cause });
  }
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length !== 1
    || !Object.hasOwn(value, 'name')
  ) {
    throw new TypeError('level-1 naming worker output must contain exactly the name field');
  }
  return assertRunName(value.name);
}

export function parseRunNamingOutput(source) {
  let value;
  try {
    value = JSON.parse(String(source));
  } catch (cause) {
    throw new TypeError('level-1 naming worker must return exact JSON', { cause });
  }
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'repo_name,run_name'
  ) {
    throw new TypeError('level-1 naming worker output must contain exactly repo_name and run_name');
  }
  return Object.freeze({
    run_name: assertRunName(value.run_name),
    repo_name: assertInformativeName(value.repo_name, { label: 'repository name' }),
  });
}

export function runNamingPacket({
  prompt,
  skill,
  unavailable = [],
  repositoryName = null,
  unavailableRepositories = [],
} = {}) {
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new TypeError('run naming requires the exact non-empty prompt');
  }
  if (typeof skill !== 'string' || skill.length === 0) {
    throw new TypeError('run naming requires the selected skill');
  }
  const blocked = unavailable.length === 0
    ? 'none'
    : unavailable.map((name) => `- ${assertRunName(name)}`).join('\n');
  const repositoryRule = repositoryName === null
    ? [
        'Unavailable repository namespaces:',
        unavailableRepositories.length === 0
          ? 'none'
          : unavailableRepositories
            .map((name) => `- ${assertInformativeName(name, { label: 'repository name' })}`)
            .join('\n'),
      ].join('\n')
    : `Required existing repository namespace: ${assertInformativeName(repositoryName, { label: 'repository name' })}`;
  return [
    'You are the Cruise level-1 naming worker.',
    'Name this run with a concise informative lowercase slug.',
    `The complete name must be at most ${MAX_ARTIFACT_NAME_LENGTH} characters.`,
    'Use words that reveal the requested outcome. Abridge words when useful.',
    'Do not use a UUID, SHA/hash fragment, timestamp, sequence number, random text, or generic name.',
    'Do not inspect files, use tools, explain, or add Markdown.',
    'Also name the repository namespace from its purpose, not its local folder spelling.',
    'Return exact JSON with two fields: {"run_name":"short-run","repo_name":"short-repo"}.',
    '',
    `Selected skill: ${skill}`,
    'Unavailable names:',
    blocked,
    repositoryRule,
    '',
    'Exact request:',
    prompt,
  ].join('\n');
}

async function repositoryNamingContext(root) {
  let repositoryName = null;
  try {
    const record = await readYamlFile(join(root, '.cruise', REPOSITORY_ARTIFACTS.naming));
    if (
      record?.schema_version !== 1
      || record?.kind !== 'cruise_repository_name'
      || record?.repository_root !== root
      || record?.assigned_by !== 'cruise_l1'
      || record?.worker_level !== 1
    ) {
      throw new Error('repo.yaml is not a valid level-1 repository naming record');
    }
    repositoryName = assertInformativeName(record.name, { label: 'repository name' });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let unavailableRepositories = [];
  try {
    unavailableRepositories = (await readdir(join(resolve(tmpdir()), 'cruise-auth'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== repositoryName)
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          assertInformativeName(name, { label: 'repository name' });
          return true;
        } catch {
          return false;
        }
      })
      .sort((left, right) => left.localeCompare(right, 'en'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { repositoryName, unavailableRepositories };
}

async function existingRunNames(root) {
  try {
    return (await readdir(join(root, '.cruise', 'runs'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          assertRunName(name);
          return true;
        } catch {
          return false;
        }
      })
      .sort((left, right) => left.localeCompare(right, 'en'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function allocateRunName({
  root,
  prompt,
  skill,
  invokeWorker,
} = {}) {
  if (typeof root !== 'string' || root.length === 0) throw new TypeError('run naming requires root');
  if (typeof invokeWorker !== 'function') {
    throw new TypeError('run naming requires a level-1 worker invoker');
  }
  const [unavailable, repositoryContext] = await Promise.all([
    existingRunNames(root),
    repositoryNamingContext(root),
  ]);
  const report = await invokeWorker({
    level: 1,
    packet: runNamingPacket({
      prompt,
      skill,
      unavailable,
      ...repositoryContext,
    }),
    cwd: root,
  });
  if (report?.launch?.recommended_level !== 1 || report?.launch?.agent_type !== 'cruise_l1') {
    throw new Error('run name was not produced by the Cruise level-1 worker');
  }
  const names = parseRunNamingOutput(report.model_output);
  const name = names.run_name;
  if (
    repositoryContext.repositoryName !== null
    && names.repo_name !== repositoryContext.repositoryName
  ) {
    throw new Error('level-1 naming worker changed the existing repository namespace');
  }
  if (
    repositoryContext.repositoryName === null
    && repositoryContext.unavailableRepositories.includes(names.repo_name)
  ) {
    throw new Error(`level-1 naming worker selected unavailable repository namespace ${names.repo_name}`);
  }
  if (unavailable.includes(name)) {
    throw new Error(`level-1 naming worker selected unavailable run name ${name}`);
  }
  return Object.freeze({
    name,
    repository_name: names.repo_name,
    level: 1,
    agent_type: report.launch.agent_type,
    model: report.launch.resolved?.model ?? null,
    reasoning_effort: report.launch.resolved?.reasoning_effort ?? null,
  });
}

for (const name of Object.values(RUN_ARTIFACTS)) assertArtifactFileName(name);
for (const name of Object.values(REPOSITORY_ARTIFACTS)) assertArtifactFileName(name);
