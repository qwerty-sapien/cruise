import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { QUICK_HARD_GATE_SIGNALS } from '../scripts/lib/routing.mjs';
import {
  assertSemanticMappingPacket,
  createProbeEnrichmentTemplate,
  createSemanticMappingPacket,
  SEMANTIC_MAPPING_PACKET_KIND,
} from '../scripts/lib/semantic-mapping-packet.mjs';

const PROMPT_DIGEST = 'a'.repeat(64);
const BASELINE_DIGEST = 'b'.repeat(64);

test('runtime-generated semantic mapping template exactly matches the executable 18-fact shape', () => {
  const template = createProbeEnrichmentTemplate({
    promptSha256: PROMPT_DIGEST,
    repositoryBaselineDigest: BASELINE_DIGEST,
  });
  assert.deepEqual(Object.keys(template), [
    'schema_version',
    'prompt_sha256',
    'repository_baseline_digest',
    'assessed_quick_gates',
    'facts',
  ]);
  assert.deepEqual(template.assessed_quick_gates, QUICK_HARD_GATE_SIGNALS);
  assert.equal(template.facts.length, 18);
  for (const [index, fact] of template.facts.entries()) {
    assert.deepEqual(Object.keys(fact), ['id', 'signal', 'value', 'basis']);
    assert.equal(fact.id, `PF-${String(index + 1).padStart(2, '0')}`);
    assert.equal(fact.signal, QUICK_HARD_GATE_SIGNALS[index]);
    assert.equal(
      typeof fact.value,
      fact.signal === 'failed_quick_repairs' ? 'number' : 'boolean',
    );
    assert.deepEqual(fact.basis, [{
      kind: 'repository_baseline',
      locator: 'repository_baseline',
      sha256: BASELINE_DIGEST,
    }]);
  }
  assert.equal(template.facts[14].value, 0);
});

test('semantic mapping packet is deterministic and rejects every observed malformed shape', () => {
  const packet = createSemanticMappingPacket({
    runDirectory: resolve(tmpdir(), 'cruise-semantic-mapping-contract'),
    repositoryRoot: resolve(tmpdir(), 'cruise-semantic-mapping-repository'),
    promptSha256: PROMPT_DIGEST,
    repositoryBaselineDigest: BASELINE_DIGEST,
  });
  assert.equal(packet.packet_kind, SEMANTIC_MAPPING_PACKET_KIND);
  assert.deepEqual(assertSemanticMappingPacket(packet), packet);
  assert.match(packet.instructions.join('\n'), /Do not wrap the copied document/u);
  assert.match(packet.instructions.join('\n'), /prompt_span.*repository_file.*repository_baseline/su);
  assert.match(packet.instructions.join('\n'), /exactly 18 facts/u);

  const malformed = [
    (copy) => {
      copy.enrichment_template.facts[0].gate = copy.enrichment_template.facts[0].signal;
      delete copy.enrichment_template.facts[0].signal;
    },
    (copy) => {
      copy.enrichment_template.assessed_quick_gates = [copy.enrichment_template.facts[0]];
    },
    (copy) => {
      delete copy.enrichment_template.prompt_sha256;
    },
    (copy) => {
      delete copy.enrichment_template.repository_baseline_digest;
    },
    (copy) => {
      copy.enrichment_template.facts[0].basis = copy.enrichment_template.facts[0].basis[0];
    },
    (copy) => {
      copy.enrichment_template.facts[14].value = false;
    },
    (copy) => {
      delete copy.enrichment_template.facts;
    },
  ];
  for (const mutate of malformed) {
    const copy = structuredClone(packet);
    mutate(copy);
    assert.throws(
      () => assertSemanticMappingPacket(copy),
      /runtime-generated executable contract|lowercase SHA-256|enrichment_template/u,
    );
  }
});

test('semantic mapping packet preflight can bind external immutable identities', () => {
  const runDirectory = resolve('/tmp/cruise-semantic-bound-run');
  const promptSha256 = 'a'.repeat(64);
  const repositoryBaselineDigest = 'b'.repeat(64);
  const packet = createSemanticMappingPacket({
    runDirectory,
    repositoryRoot: resolve('/tmp/cruise-semantic-bound-repository'),
    promptSha256,
    repositoryBaselineDigest,
  });
  assert.deepEqual(assertSemanticMappingPacket(packet, {
    runDirectory,
    repositoryRoot: resolve('/tmp/cruise-semantic-bound-repository'),
    promptSha256,
    repositoryBaselineDigest,
  }), packet);
  assert.throws(() => assertSemanticMappingPacket(packet, {
    runDirectory,
    repositoryRoot: resolve('/tmp/cruise-semantic-bound-repository'),
    promptSha256: 'c'.repeat(64),
    repositoryBaselineDigest,
  }), /differs from the runtime-generated executable contract/u);
  assert.throws(() => assertSemanticMappingPacket(packet, {
    runDirectory,
    promptSha256,
    repositoryBaselineDigest: 'd'.repeat(64),
  }), /differs from the runtime-generated executable contract/u);
});
