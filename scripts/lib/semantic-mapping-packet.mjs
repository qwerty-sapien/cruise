import { isAbsolute, join, resolve } from 'node:path';

import { QUICK_ASSESSMENT_SIGNALS } from './routing.mjs';
import { canonicalJson } from './yaml-state.mjs';

export const SEMANTIC_MAPPING_PACKET_KIND = 'cruise_semantic_mapping_v1';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function absoluteRunDirectory(value) {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw new TypeError('semantic mapping run directory must be absolute');
  }
  if (value.includes('\0')) throw new TypeError('semantic mapping run directory contains NUL');
  return resolve(value);
}

export function createProbeEnrichmentTemplate({
  promptSha256,
  repositoryBaselineDigest,
} = {}) {
  const promptDigest = sha256(promptSha256, 'prompt SHA-256');
  const baselineDigest = sha256(repositoryBaselineDigest, 'repository baseline digest');
  return deepFreeze({
    schema_version: 1,
    prompt_sha256: promptDigest,
    repository_baseline_digest: baselineDigest,
    assessed_quick_gates: [...QUICK_ASSESSMENT_SIGNALS],
    facts: QUICK_ASSESSMENT_SIGNALS.map((signal, index) => ({
      id: `PF-${String(index + 1).padStart(2, '0')}`,
      signal,
      value: signal === 'failed_quick_repairs' ? 0 : false,
      basis: [{
        kind: 'repository_baseline',
        locator: 'repository_baseline',
        sha256: baselineDigest,
      }],
    })),
  });
}

export function createSemanticMappingPacket({
  runDirectory,
  repositoryRoot,
  promptSha256,
  repositoryBaselineDigest,
} = {}) {
  const run = absoluteRunDirectory(runDirectory);
  const root = absoluteRunDirectory(repositoryRoot);
  const originPath = join(run, 'origin.yaml');
  const factsOutputPath = join(run, 'map-facts.yaml');
  const packetPath = join(run, 'map-pkt.yaml');
  return deepFreeze({
    packet_kind: SEMANTIC_MAPPING_PACKET_KIND,
    packet_schema_version: 1,
    phase: 'routing_pending',
    task_id: 'T-MAP-01',
    evidence_id: 'E-MAP-01',
    run_directory: run,
    repository_root: root,
    origin_path: originPath,
    packet_path: packetPath,
    facts_output_path: factsOutputPath,
    read_paths: [originPath, root],
    repository_read_limits: {
      mode: 'shallow_targeted',
      maximum_files: 64,
      maximum_file_bytes: 1048576,
      maximum_total_bytes: 4194304,
      excluded_paths: [join(root, '.git'), join(root, '.cruise')],
      excluded_path_exceptions: [originPath],
    },
    write_paths: [factsOutputPath],
    forbidden_writes: [
      originPath,
      join(run, 'probe.yaml'),
      join(run, 'state.yaml'),
      join(run, 'evidence.yaml'),
      join(run, 'route.yaml'),
      packetPath,
    ],
    forbidden_runtime_subcommands: ['enrich-probe', 'route'],
    mutable_template_fields: ['facts[*].value', 'facts[*].basis'],
    instructions: [
      'Inspect the immutable Origin and only shallow, targeted repository files under repository_root needed to assess the 17 semantic Quick gates plus repair-history telemetry, within repository_read_limits.',
      'Copy enrichment_template to facts_output_path as the complete top-level YAML document.',
      'Do not wrap the copied document under enrichment_template, packet, result, output, or any other key. The facts output has exactly the five top-level keys schema_version, prompt_sha256, repository_baseline_digest, assessed_quick_gates, and facts.',
      'Change only facts[*].value and facts[*].basis when evidence requires it; preserve every other key, list, ID, signal, digest, and value type exactly.',
      'The failed_quick_repairs value is non-negative append-only telemetry and is 0 when no repair has failed; it does not create a universal retry cutoff. All semantic gate values are booleans.',
      'Every basis remains an array of one or more machine-verifiable objects using only these exact forms: {kind: prompt_span, locator: bytes:<start>:<end>, sha256: <digest of those exact raw-prompt bytes>}; {kind: repository_file, locator: <repository-relative regular non-symlink path>, sha256: <current file digest>}; or {kind: repository_baseline, locator: repository_baseline, sha256: <repository_baseline_digest>}. Invent no other kind or field.',
      'Before ending, parse facts_output_path and compare it with enrichment_template: it must contain exactly 18 facts in the same order, every fact must have exactly id, signal, value, and basis, and every field outside value and basis must be identical.',
      'Write no path except facts_output_path and do not invoke a Cruise runtime subcommand, ask the user, route, or start another public skill.',
    ],
    enrichment_template: createProbeEnrichmentTemplate({
      promptSha256,
      repositoryBaselineDigest,
    }),
  });
}

export function assertSemanticMappingPacket(packet, {
  runDirectory = null,
  repositoryRoot = null,
  promptSha256 = null,
  repositoryBaselineDigest = null,
} = {}) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
    throw new TypeError('semantic mapping packet must be a YAML mapping');
  }
  if (packet.packet_kind !== SEMANTIC_MAPPING_PACKET_KIND) {
    throw new TypeError(`semantic mapping packet must declare packet_kind: ${SEMANTIC_MAPPING_PACKET_KIND}`);
  }
  const template = packet.enrichment_template;
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    throw new TypeError('semantic mapping packet must contain enrichment_template');
  }
  const expected = createSemanticMappingPacket({
    runDirectory: runDirectory ?? packet.run_directory,
    repositoryRoot: repositoryRoot ?? packet.repository_root,
    promptSha256: promptSha256 ?? template.prompt_sha256,
    repositoryBaselineDigest:
      repositoryBaselineDigest ?? template.repository_baseline_digest,
  });
  if (canonicalJson(packet) !== canonicalJson(expected)) {
    throw new TypeError('semantic mapping packet differs from the runtime-generated executable contract');
  }
  return expected;
}
