import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  allocateBuildIdentifier,
  attestBuildOriginPair,
  attestBuildHistoryResume,
  attestValidatedBuildIdHistory,
  captureInitialBuildOrigin,
  consumeBuildHistoryResume,
  createBuildIdRegistry,
  createBuildIdRegistrySnapshot,
  importInitialBuildIdentifiers,
  isConsumedBuildHistoryResumeReceipt,
  isVerifiedInitialBuildOriginReceipt,
  isVerifiedBuildIdHistoryReceipt,
  isVerifiedBuildOriginPairReceipt,
  readBuildIdRegistry,
  reconcileBuildIdRegistry,
  scanBuildIdentifiers,
  supersedeBuildIdentifier,
  verifyBuildOriginPairAuthority,
  verifyValidatedBuildIdHistoryAuthority,
  verifyInitialBuildOriginAttestation,
  writeBuildIdRegistry,
} from '../scripts/lib/build-history.mjs';
import {
  appendBuildClarification,
  createOriginRecord,
  validateOriginRecord,
} from '../scripts/lib/origin.mjs';
import { stringifyYaml } from '../scripts/lib/yaml-state.mjs';

const A = 'a'.repeat(64);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const execFile = promisify(execFileCallback);

function capture(root, mode = 'milestone') {
  return captureInitialBuildOrigin({
    rawPrompt: 'Build the approved durable product.\nPreserve this exact prompt.',
    repositoryBaseline: {
      root,
      head: null,
      branch: null,
      dirty_state_digest: A,
      instruction_files: [],
    },
    deterministicProbeDigest: A,
    initialClassifier: 'gpt-5.6-luna medium',
    confidence: 0.99,
    build: {
      mode,
      mode_candidate: mode,
      mode_evidence: ['Canonical project artifacts establish milestone mode.'],
      target_project: 'PRJ-01',
      target_milestone: mode === 'milestone' ? 'M-01' : null,
    },
    capturedAt: '2026-07-13T00:00:00.000Z',
  });
}

function artifact(ids) {
  return [{ path: '.cruise/projects/demo/contracts.md', content: ids.join('\n') }];
}

function claims(entries) {
  return entries.map(([id, stableKey, status = 'active']) => ({
    id,
    stable_key: stableKey,
    status,
  }));
}

async function initialRegistry(root) {
  const captured = capture(root);
  let registry = createBuildIdRegistry({
    initialBuildOriginAttestation: captured.attestation,
    originRecord: captured.origin_record,
    at: '2026-07-13T00:00:01.000Z',
  });
  const ids = ['PRJ-01', 'M-01', 'R-01', 'AC-01', 'D-01', 'Q-01', 'P-01', 'RSK-01', 'C-01', 'QI-01'];
  const identities = claims([
    ['R-01', 'requirement:durable-output'],
    ['AC-01', 'acceptance:durable-output'],
    ['D-01', 'decision:storage-boundary'],
    ['Q-01', 'question:release-window'],
    ['P-01', 'phase:vertical-transition'],
    ['RSK-01', 'risk:rollback'],
    ['C-01', 'concept:durable-product'],
    ['QI-01', 'queue:phase-goal'],
  ]);
  registry = importInitialBuildIdentifiers(registry, {
    initialBuildOriginAttestation: captured.attestation,
    originRecord: captured.origin_record,
    artifacts: artifact(ids),
    identities,
    at: '2026-07-13T00:00:02.000Z',
  });
  return { captured, registry, ids, identities };
}

async function persistedRegistryPair(prefix = 'cruise-build-persistence-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const { captured, registry } = await initialRegistry(root);
  const path = join(root, '.cruise', 'project', 'ids.yaml');
  const firstSnapshot = await writeBuildIdRegistry(path, registry, {
    initialBuildOriginAttestation: captured.attestation,
    originRecord: captured.origin_record,
  });
  const allocation = allocateBuildIdentifier(registry, {
    initialBuildOriginAttestation: captured.attestation,
    originRecord: captured.origin_record,
    namespace: 'Q',
    stableKey: 'question:second',
    sourcePaths: ['.cruise/projects/demo/QUESTIONS.yaml'],
    at: '2026-07-13T00:00:03.000Z',
  });
  return {
    root,
    path,
    captured,
    predecessor: registry,
    candidate: allocation.registry,
    firstSnapshot,
  };
}

async function readRegistryInFreshProcess(root, path) {
  const moduleUrl = new URL('../scripts/lib/build-history.mjs', import.meta.url).href;
  const script = `
    const lib = await import(${JSON.stringify(moduleUrl)});
    const captured = lib.captureInitialBuildOrigin({
      rawPrompt: 'Build the approved durable product.\\nPreserve this exact prompt.',
      repositoryBaseline: {
        root: ${JSON.stringify(root)},
        head: null,
        branch: null,
        dirty_state_digest: ${JSON.stringify(A)},
        instruction_files: [],
      },
      deterministicProbeDigest: ${JSON.stringify(A)},
      initialClassifier: 'gpt-5.6-luna medium',
      confidence: 0.99,
      build: {
        mode: 'milestone',
        mode_candidate: 'milestone',
        mode_evidence: ['Canonical project artifacts establish milestone mode.'],
        target_project: 'PRJ-01',
        target_milestone: 'M-01',
      },
      capturedAt: '2026-07-13T00:00:00.000Z',
    });
    const registry = await lib.readBuildIdRegistry(${JSON.stringify(path)}, {
      initialBuildOriginAttestation: captured.attestation,
      originRecord: captured.origin_record,
    });
    process.stdout.write(JSON.stringify({
      revision: registry.revision,
      ids: registry.records.map(({ id }) => id),
    }));
  `;
  const { stdout } = await execFile(process.execPath, ['--input-type=module', '-e', script]);
  return JSON.parse(stdout);
}

async function attemptRegistryResetInFreshProcess(root, path) {
  const moduleUrl = new URL('../scripts/lib/build-history.mjs', import.meta.url).href;
  const script = `
    const lib = await import(${JSON.stringify(moduleUrl)});
    const captured = lib.captureInitialBuildOrigin({
      rawPrompt: 'Build the approved durable product.\\nPreserve this exact prompt.',
      repositoryBaseline: {
        root: ${JSON.stringify(root)},
        head: null,
        branch: null,
        dirty_state_digest: ${JSON.stringify(A)},
        instruction_files: [],
      },
      deterministicProbeDigest: ${JSON.stringify(A)},
      initialClassifier: 'gpt-5.6-luna medium',
      confidence: 0.99,
      build: {
        mode: 'milestone',
        mode_candidate: 'milestone',
        mode_evidence: ['Canonical project artifacts establish milestone mode.'],
        target_project: 'PRJ-01',
        target_milestone: 'M-01',
      },
      capturedAt: '2026-07-13T00:00:00.000Z',
    });
    const reset = lib.createBuildIdRegistry({
      initialBuildOriginAttestation: captured.attestation,
      originRecord: captured.origin_record,
      at: '2026-07-13T00:00:05.000Z',
    });
    try {
      await lib.writeBuildIdRegistry(${JSON.stringify(path)}, reset, {
        initialBuildOriginAttestation: captured.attestation,
        originRecord: captured.origin_record,
      });
      process.stdout.write('unexpected reset success');
    } catch (error) {
      process.stdout.write(error.message);
    }
  `;
  const { stdout } = await execFile(process.execPath, ['--input-type=module', '-e', script]);
  return stdout;
}

async function crashRegistryWriterInFreshProcess(root, path, checkpoint) {
  const moduleUrl = new URL('../scripts/lib/build-history.mjs', import.meta.url).href;
  const script = `
    const lib = await import(${JSON.stringify(moduleUrl)});
    const captured = lib.captureInitialBuildOrigin({
      rawPrompt: 'Build the approved durable product.\\nPreserve this exact prompt.',
      repositoryBaseline: {
        root: ${JSON.stringify(root)},
        head: null,
        branch: null,
        dirty_state_digest: ${JSON.stringify(A)},
        instruction_files: [],
      },
      deterministicProbeDigest: ${JSON.stringify(A)},
      initialClassifier: 'gpt-5.6-luna medium',
      confidence: 0.99,
      build: {
        mode: 'milestone',
        mode_candidate: 'milestone',
        mode_evidence: ['Canonical project artifacts establish milestone mode.'],
        target_project: 'PRJ-01',
        target_milestone: 'M-01',
      },
      capturedAt: '2026-07-13T00:00:00.000Z',
    });
    const current = await lib.readBuildIdRegistry(${JSON.stringify(path)}, {
      initialBuildOriginAttestation: captured.attestation,
      originRecord: captured.origin_record,
    });
    const candidate = lib.allocateBuildIdentifier(current, {
      initialBuildOriginAttestation: captured.attestation,
      originRecord: captured.origin_record,
      namespace: 'Q',
      stableKey: 'question:second',
      sourcePaths: ['.cruise/projects/demo/QUESTIONS.yaml'],
      at: '2026-07-13T00:00:03.000Z',
    }).registry;
    await lib.writeBuildIdRegistry(${JSON.stringify(path)}, candidate, {
      initialBuildOriginAttestation: captured.attestation,
      originRecord: captured.origin_record,
      expectedSnapshot: lib.createBuildIdRegistrySnapshot(current),
      persistenceFaultInjector(step) {
        if (step === ${JSON.stringify(checkpoint)}) process.exit(86);
      },
    });
  `;
  return execFile(process.execPath, ['--input-type=module', '-e', script]);
}

test('initial Build Origin authority locks prompt, repository, route, and target identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-build-origin-'));
  const captured = capture(root);
  const receipt = verifyInitialBuildOriginAttestation(captured.attestation, {
    originRecord: captured.origin_record,
    repositoryRoot: root,
    deterministicProbeDigest: A,
    projectId: 'PRJ-01',
    milestoneId: 'M-01',
    mode: 'milestone',
  });
  assert.equal(isVerifiedInitialBuildOriginReceipt(receipt), true);
  assert.equal(receipt.prompt_sha256, captured.origin_record.origin.prompt_sha256);

  assert.throws(
    () => verifyInitialBuildOriginAttestation(structuredClone(captured.attestation), {
      originRecord: captured.origin_record,
    }),
    /opaque runtime authority/,
  );
  const rewritten = structuredClone(captured.origin_record);
  rewritten.origin.raw_prompt = 'A rewritten but internally consistent prompt.';
  rewritten.origin.prompt_sha256 = '342c9a0abf1bde36ea5ed2a7d25a3d186f853231d4127be4f27046a19a28f35c';
  assert.throws(
    () => verifyInitialBuildOriginAttestation(captured.attestation, { originRecord: rewritten }),
    /identity changed|hash does not match/,
  );
  assert.throws(
    () => capture(root),
    /already captured/,
  );
});

test('paired locked Origins and current ID history mint opaque approval receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-build-pair-'));
  const project = capture(root, 'bootstrap');
  const milestone = capture(root, 'milestone');
  const projectBytes = stringifyYaml(project.origin_record);
  const milestoneBytes = stringifyYaml(milestone.origin_record);
  const pair = attestBuildOriginPair({
    project: {
      attestation: project.attestation,
      record: project.origin_record,
      bytes: projectBytes,
    },
    milestone: {
      attestation: milestone.attestation,
      record: milestone.origin_record,
      bytes: milestoneBytes,
    },
    repositoryRoot: root,
    projectId: 'PRJ-01',
    milestoneId: 'M-01',
  });
  const pairReceipt = verifyBuildOriginPairAuthority(pair, {
    repositoryRoot: root,
    projectId: 'PRJ-01',
    milestoneId: 'M-01',
    projectOriginSha256: sha256(projectBytes),
    milestoneOriginSha256: sha256(milestoneBytes),
  });
  assert.equal(isVerifiedBuildOriginPairReceipt(pairReceipt), true);
  assert.throws(
    () => verifyBuildOriginPairAuthority(structuredClone(pair), {
      repositoryRoot: root,
      projectId: 'PRJ-01',
      milestoneId: 'M-01',
      projectOriginSha256: sha256(projectBytes),
      milestoneOriginSha256: sha256(milestoneBytes),
    }),
    /opaque runtime authority/,
  );

  const initial = createBuildIdRegistry({
    initialBuildOriginAttestation: milestone.attestation,
    originRecord: milestone.origin_record,
    at: '2026-07-13T00:00:01.000Z',
  });
  const lockedArtifacts = [{
    path: '.cruise/projects/demo/MILESTONE.md',
    content: 'Project PRJ-01 executes milestone M-01.\nRequirement R-01: original text.',
  }];
  const lockedIdentities = [
    { id: 'R-01', stable_key: 'requirement:durable-contract', status: 'active' },
  ];
  const current = importInitialBuildIdentifiers(initial, {
    initialBuildOriginAttestation: milestone.attestation,
    originRecord: milestone.origin_record,
    artifacts: lockedArtifacts,
    identities: lockedIdentities,
    at: '2026-07-13T00:00:02.000Z',
  });
  const history = attestValidatedBuildIdHistory({
    buildOriginPairAuthority: pair,
    registry: current,
    previousRegistry: initial,
    artifacts: lockedArtifacts,
    identities: lockedIdentities,
  });
  const historyReceipt = verifyValidatedBuildIdHistoryAuthority(history, {
    buildOriginPairAuthority: pair,
    registry: current,
    previousRegistry: initial,
    artifacts: lockedArtifacts,
    identities: lockedIdentities,
  });
  assert.equal(isVerifiedBuildIdHistoryReceipt(historyReceipt), true);
  assert.deepEqual(historyReceipt.locked_artifact_ids, ['PRJ-01', 'M-01', 'R-01']);
  assert.throws(
    () => verifyValidatedBuildIdHistoryAuthority(history, {
      buildOriginPairAuthority: pair,
      registry: current,
      previousRegistry: initial,
      artifacts: [{
        ...lockedArtifacts[0],
        content: lockedArtifacts[0].content.replace('original text', 'rewritten text'),
      }],
      identities: lockedIdentities,
    }),
    /stale or locked artifacts\/history changed/,
  );
  assert.throws(
    () => verifyValidatedBuildIdHistoryAuthority(history, {
      buildOriginPairAuthority: pair,
      registry: current,
      previousRegistry: initial,
      artifacts: [{ ...lockedArtifacts[0], content: `${lockedArtifacts[0].content}\nQ-99` }],
      identities: [
        ...lockedIdentities,
        { id: 'Q-99', stable_key: 'question:forged', status: 'active' },
      ],
    }),
    /unregistered identifier Q-99/,
  );
});

test('Build clarifications are append-only and namespace/field constrained without weakening Goal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-build-ledger-'));
  const initial = capture(root).origin_record;
  let record = initial;
  const entries = [
    ['PRJ-01', 'project.outcome'],
    ['M-01', 'milestone.scope'],
    ['R-01', 'requirement.statement'],
    ['AC-01', 'acceptance_criterion.verification'],
    ['D-01', 'decision.resolution'],
    ['Q-01', 'question.answer'],
    ['P-01', 'phase.dependencies'],
    ['RSK-01', 'risk.mitigation'],
    ['C-01', 'concept.selection_reason'],
    ['QI-01', 'queue_item.scope'],
  ];
  for (const [affectedIdentifier, field] of entries) {
    record = appendBuildClarification(record, {
      affectedIdentifier,
      field,
      priorValue: null,
      newValue: `${field} clarified`,
      source: 'user_answer',
      rationale: 'The structured clarification changes only the normalized artifact.',
      timestamp: '2026-07-13T00:00:03.000Z',
    });
  }
  validateOriginRecord(record, { expectedOrigin: initial });
  assert.equal(record.change_ledger.length, entries.length);
  assert.throws(
    () => appendBuildClarification(record, {
      affectedIdentifier: 'Q-02',
      field: 'risk.mitigation',
      priorValue: null,
      newValue: 'invalid',
      source: 'user_answer',
      rationale: 'Wrong namespace.',
    }),
    /cannot be ledgered/,
  );

  const goal = createOriginRecord({
    rawPrompt: 'Finish one finite outcome.',
    selectedSkill: 'goal',
    repositoryBaseline: {
      root,
      head: null,
      branch: null,
      dirty_state_digest: A,
      instruction_files: [],
    },
    deterministicProbeDigest: A,
    initialClassifier: 'gpt-5.6-luna medium',
    selectedRoute: 'goal',
    confidence: 0.9,
  });
  const forgedGoal = structuredClone(goal);
  forgedGoal.change_ledger.push({
    timestamp: '2026-07-13T00:00:04.000Z',
    affected_identifier: 'QI-01',
    field: 'queue_item.scope',
    prior_value: null,
    new_value: 'x',
    source: 'user',
    rationale: 'x',
  });
  assert.throws(() => validateOriginRecord(forgedGoal), /shared Goal identifier/);
});

test('registry scans all Build namespaces and rejects deletion, reuse, renumbering, and ad-hoc IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-build-registry-'));
  const { captured, registry, ids, identities } = await initialRegistry(root);
  assert.deepEqual(scanBuildIdentifiers(artifact(ids)).map(({ id }) => id), ids);

  assert.throws(
    () => reconcileBuildIdRegistry(registry, {
      initialBuildOriginAttestation: captured.attestation,
      originRecord: captured.origin_record,
      artifacts: artifact(ids.filter((id) => id !== 'D-01')),
      identities: identities.filter(({ id }) => id !== 'D-01'),
      at: '2026-07-13T00:00:03.000Z',
    }),
    /deleted preserved identifier D-01/,
  );
  assert.throws(
    () => reconcileBuildIdRegistry(registry, {
      initialBuildOriginAttestation: captured.attestation,
      originRecord: captured.origin_record,
      artifacts: artifact(ids),
      identities: identities.map((entry) => entry.id === 'R-01'
        ? { ...entry, stable_key: 'requirement:reused' }
        : entry),
      at: '2026-07-13T00:00:03.000Z',
    }),
    /reuses R-01/,
  );
  assert.throws(
    () => reconcileBuildIdRegistry(registry, {
      initialBuildOriginAttestation: captured.attestation,
      originRecord: captured.origin_record,
      artifacts: artifact([...ids, 'R-02']),
      identities: [...identities, { id: 'R-02', stable_key: 'requirement:durable-output', status: 'active' }],
      at: '2026-07-13T00:00:03.000Z',
    }),
    /renumbers requirement:durable-output/,
  );
  assert.throws(
    () => reconcileBuildIdRegistry(registry, {
      initialBuildOriginAttestation: captured.attestation,
      originRecord: captured.origin_record,
      artifacts: artifact([...ids, 'QI-02']),
      identities: [...identities, { id: 'QI-02', stable_key: 'queue:unapproved', status: 'active' }],
      at: '2026-07-13T00:00:03.000Z',
    }),
    /unallocated identifier QI-02/,
  );
});

test('allocation remains monotonic across supersession and superseded IDs must remain visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-build-allocation-'));
  const { captured, registry, ids, identities } = await initialRegistry(root);
  const allocation = allocateBuildIdentifier(registry, {
    initialBuildOriginAttestation: captured.attestation,
    originRecord: captured.origin_record,
    namespace: 'QI',
    stableKey: 'queue:research-prerequisite',
    sourcePaths: ['.cruise/projects/demo/QUEUE.yaml'],
    at: '2026-07-13T00:00:03.000Z',
  });
  assert.equal(allocation.identifier, 'QI-02');
  let current = reconcileBuildIdRegistry(allocation.registry, {
    initialBuildOriginAttestation: captured.attestation,
    originRecord: captured.origin_record,
    artifacts: artifact([...ids, 'QI-02']),
    identities: [...identities, { id: 'QI-02', stable_key: 'queue:research-prerequisite', status: 'active' }],
    at: '2026-07-13T00:00:04.000Z',
  });
  current = supersedeBuildIdentifier(current, {
    initialBuildOriginAttestation: captured.attestation,
    originRecord: captured.origin_record,
    identifier: 'QI-01',
    rationale: 'The prerequisite was replaced without reusing its identity.',
    at: '2026-07-13T00:00:05.000Z',
  });
  const next = allocateBuildIdentifier(current, {
    initialBuildOriginAttestation: captured.attestation,
    originRecord: captured.origin_record,
    namespace: 'QI',
    stableKey: 'queue:goal-after-research',
    sourcePaths: ['.cruise/projects/demo/QUEUE.yaml'],
    at: '2026-07-13T00:00:06.000Z',
  });
  assert.equal(next.identifier, 'QI-03');
  assert.throws(
    () => reconcileBuildIdRegistry(current, {
      initialBuildOriginAttestation: captured.attestation,
      originRecord: captured.origin_record,
      artifacts: artifact([...ids.filter((id) => id !== 'QI-01'), 'QI-02']),
      identities: [
        ...identities.filter(({ id }) => id !== 'QI-01'),
        { id: 'QI-02', stable_key: 'queue:research-prerequisite', status: 'active' },
      ],
      at: '2026-07-13T00:00:06.000Z',
    }),
    /deleted preserved identifier QI-01/,
  );
});

test('persistent snapshots use CAS and resume authorities are exact-revision and one-use', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-build-resume-'));
  const { captured, registry } = await initialRegistry(root);
  const path = join(root, '.cruise', 'project', 'ids.yaml');
  const firstSnapshot = await writeBuildIdRegistry(path, registry, {
    initialBuildOriginAttestation: captured.attestation,
    originRecord: captured.origin_record,
  });
  const allocation = allocateBuildIdentifier(registry, {
    initialBuildOriginAttestation: captured.attestation,
    originRecord: captured.origin_record,
    namespace: 'Q',
    stableKey: 'question:second',
    sourcePaths: ['.cruise/projects/demo/QUESTIONS.yaml'],
    at: '2026-07-13T00:00:03.000Z',
  });
  const secondSnapshot = await writeBuildIdRegistry(path, allocation.registry, {
    initialBuildOriginAttestation: captured.attestation,
    originRecord: captured.origin_record,
    expectedSnapshot: firstSnapshot,
  });
  const loaded = await readBuildIdRegistry(path, {
    initialBuildOriginAttestation: captured.attestation,
    originRecord: captured.origin_record,
    expectedSnapshot: secondSnapshot,
  });
  assert.equal(loaded.revision, allocation.registry.revision);
  await assert.rejects(
    writeBuildIdRegistry(path, registry, {
      initialBuildOriginAttestation: captured.attestation,
      originRecord: captured.origin_record,
      expectedSnapshot: firstSnapshot,
    }),
    /stale|another revision/,
  );

  const resume = attestBuildHistoryResume({
    initialBuildOriginAttestation: captured.attestation,
    originRecord: captured.origin_record,
    registry: loaded,
    snapshot: secondSnapshot,
  });
  const receipt = consumeBuildHistoryResume({
    resumeAttestation: resume,
    initialBuildOriginAttestation: captured.attestation,
    originRecord: captured.origin_record,
    registry: loaded,
    snapshot: secondSnapshot,
  });
  assert.equal(isConsumedBuildHistoryResumeReceipt(receipt), true);
  assert.throws(
    () => consumeBuildHistoryResume({
      resumeAttestation: resume,
      initialBuildOriginAttestation: captured.attestation,
      originRecord: captured.origin_record,
      registry: loaded,
      snapshot: secondSnapshot,
    }),
    /already been consumed/,
  );
  assert.throws(
    () => attestBuildHistoryResume({
      initialBuildOriginAttestation: captured.attestation,
      originRecord: captured.origin_record,
      registry: loaded,
      snapshot: createBuildIdRegistrySnapshot(registry),
    }),
    /stale|another revision/,
  );
});

test('legacy standalone registries remain readable and migrate on an authorized successor write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-build-registry-legacy-'));
  const { captured, registry } = await initialRegistry(root);
  const projectDirectory = join(root, '.cruise', 'project');
  const path = join(projectDirectory, 'ids.yaml');
  await mkdir(projectDirectory, { recursive: true });
  await writeFile(path, stringifyYaml(registry));

  const loaded = await readBuildIdRegistry(path, {
    initialBuildOriginAttestation: captured.attestation,
    originRecord: captured.origin_record,
  });
  assert.equal(loaded.revision, registry.revision);
  await assert.rejects(readFile(join(projectDirectory, 'id-head.yaml')), {
    code: 'ENOENT',
  });

  const candidate = allocateBuildIdentifier(loaded, {
    initialBuildOriginAttestation: captured.attestation,
    originRecord: captured.origin_record,
    namespace: 'Q',
    stableKey: 'question:legacy-successor',
    sourcePaths: ['.cruise/projects/demo/QUESTIONS.yaml'],
    at: '2026-07-13T00:00:03.000Z',
  }).registry;
  await writeBuildIdRegistry(path, candidate, {
    initialBuildOriginAttestation: captured.attestation,
    originRecord: captured.origin_record,
    expectedSnapshot: createBuildIdRegistrySnapshot(loaded),
  });
  assert.equal((await readdir(join(projectDirectory, 'id-hist'))).length, 2);
  assert.equal(
    (await readdir(join(root, '.cruise', 'id-locks'))).length,
    1,
  );
});

test('immutable registry history recovers canonical deletion after a process restart', async () => {
  const fixture = await persistedRegistryPair('cruise-build-registry-restart-');
  const secondSnapshot = await writeBuildIdRegistry(fixture.path, fixture.candidate, {
    initialBuildOriginAttestation: fixture.captured.attestation,
    originRecord: fixture.captured.origin_record,
    expectedSnapshot: fixture.firstSnapshot,
  });
  const historyDirectory = join(fixture.root, '.cruise', 'project', 'id-hist');
  const generations = (await readdir(historyDirectory)).sort();
  assert.deepEqual(generations, [
    `id-${fixture.predecessor.revision}.yaml`,
    `id-${fixture.candidate.revision}.yaml`,
  ]);

  await rm(fixture.path);
  const recovered = await readRegistryInFreshProcess(fixture.root, fixture.path);
  assert.equal(recovered.revision, fixture.candidate.revision);
  assert.equal(recovered.ids.includes('Q-02'), true);

  const canonical = await readBuildIdRegistry(fixture.path, {
    initialBuildOriginAttestation: fixture.captured.attestation,
    originRecord: fixture.captured.origin_record,
    expectedSnapshot: secondSnapshot,
  });
  assert.equal(canonical.revision, fixture.candidate.revision);
});

test('registry persistence rejects a symlink alias of the Origin-bound canonical path', async () => {
  const fixture = await persistedRegistryPair('cruise-build-registry-path-binding-');
  const aliasDirectory = join(fixture.root, '.cruise', 'project-alias');
  await symlink(join(fixture.root, '.cruise', 'project'), aliasDirectory);
  await assert.rejects(
    readBuildIdRegistry(join(aliasDirectory, 'ids.yaml'), {
      initialBuildOriginAttestation: fixture.captured.attestation,
      originRecord: fixture.captured.origin_record,
    }),
    /path differs from the immutable Origin repository root/,
  );
});

test('registry fences reject canonical rollback, history truncation, and restart deletion', async (t) => {
  await t.test('canonical rollback', async () => {
    const fixture = await persistedRegistryPair('cruise-build-registry-rollback-');
    const predecessorBytes = await readFile(fixture.path);
    await writeBuildIdRegistry(fixture.path, fixture.candidate, {
      initialBuildOriginAttestation: fixture.captured.attestation,
      originRecord: fixture.captured.origin_record,
      expectedSnapshot: fixture.firstSnapshot,
    });
    await writeFile(fixture.path, predecessorBytes);
    await assert.rejects(
      readBuildIdRegistry(fixture.path, {
        initialBuildOriginAttestation: fixture.captured.attestation,
        originRecord: fixture.captured.origin_record,
      }),
      /differs from its immutable committed history head|rolled back/,
    );
  });

  await t.test('history truncation', async () => {
    const fixture = await persistedRegistryPair('cruise-build-registry-history-truncation-');
    await writeBuildIdRegistry(fixture.path, fixture.candidate, {
      initialBuildOriginAttestation: fixture.captured.attestation,
      originRecord: fixture.captured.origin_record,
      expectedSnapshot: fixture.firstSnapshot,
    });
    const historyDirectory = join(fixture.root, '.cruise', 'project', 'id-hist');
    const generations = (await readdir(historyDirectory)).sort();
    await rm(join(historyDirectory, generations.at(-1)));
    await assert.rejects(
      readBuildIdRegistry(fixture.path, {
        initialBuildOriginAttestation: fixture.captured.attestation,
        originRecord: fixture.captured.origin_record,
      }),
      /committed head is stale, forked, or invalid|differs from its immutable committed history|rolled back behind its durable revision commitments/,
    );
  });

  await t.test('durable commitment truncation', async () => {
    const fixture = await persistedRegistryPair('cruise-build-registry-commitment-truncation-');
    await writeBuildIdRegistry(fixture.path, fixture.candidate, {
      initialBuildOriginAttestation: fixture.captured.attestation,
      originRecord: fixture.captured.origin_record,
      expectedSnapshot: fixture.firstSnapshot,
    });
    const commitmentRoot = join(fixture.root, '.cruise', 'id-locks');
    const [lineageName] = await readdir(commitmentRoot);
    const lineageDirectory = join(commitmentRoot, lineageName);
    const commitments = (await readdir(lineageDirectory)).sort();
    await rm(join(lineageDirectory, commitments.at(-1)));
    await assert.rejects(
      readBuildIdRegistry(fixture.path, {
        initialBuildOriginAttestation: fixture.captured.attestation,
        originRecord: fixture.captured.origin_record,
      }),
      /durable revision commitments were truncated/,
    );
  });

  await t.test('all project registry files deleted before restart', async () => {
    const fixture = await persistedRegistryPair('cruise-build-registry-total-deletion-');
    await writeBuildIdRegistry(fixture.path, fixture.candidate, {
      initialBuildOriginAttestation: fixture.captured.attestation,
      originRecord: fixture.captured.origin_record,
      expectedSnapshot: fixture.firstSnapshot,
    });
    const projectDirectory = join(fixture.root, '.cruise', 'project');
    await rm(fixture.path);
    await rm(join(projectDirectory, 'id-head.yaml'));
    await rm(join(projectDirectory, 'id-hist'), { recursive: true });
    const denial = await attemptRegistryResetInFreshProcess(fixture.root, fixture.path);
    assert.match(
      denial,
      /history was deleted behind its durable revision commitments/,
    );
  });
});

test('registry pending intent recovers every injected persistence interruption exactly once', async (t) => {
  const checkpoints = [
    'after_pending_prepare',
    'after_pending_commit',
    'after_history_prepare',
    'after_history_append',
    'after_commitment_prepare',
    'after_commitment_append',
    'after_registry_prepare',
    'after_registry_commit',
    'after_head_prepare',
    'after_head_commit',
  ];
  for (const checkpoint of checkpoints) {
    await t.test(checkpoint, async () => {
      const fixture = await persistedRegistryPair(`cruise-build-registry-fault-${checkpoint}-`);
      await assert.rejects(
        writeBuildIdRegistry(fixture.path, fixture.candidate, {
          initialBuildOriginAttestation: fixture.captured.attestation,
          originRecord: fixture.captured.origin_record,
          expectedSnapshot: fixture.firstSnapshot,
          persistenceFaultInjector(step) {
            if (step === checkpoint) throw new Error(`injected registry fault at ${checkpoint}`);
          },
        }),
        new RegExp(`injected registry fault at ${checkpoint}`),
      );

      const recoveredSnapshot = await writeBuildIdRegistry(fixture.path, fixture.candidate, {
        initialBuildOriginAttestation: fixture.captured.attestation,
        originRecord: fixture.captured.origin_record,
        expectedSnapshot: fixture.firstSnapshot,
      });
      const recovered = await readBuildIdRegistry(fixture.path, {
        initialBuildOriginAttestation: fixture.captured.attestation,
        originRecord: fixture.captured.origin_record,
        expectedSnapshot: recoveredSnapshot,
      });
      assert.equal(recovered.revision, fixture.candidate.revision);
      assert.equal(recovered.records.some(({ id }) => id === 'Q-02'), true);

      const projectDirectory = join(fixture.root, '.cruise', 'project');
      const history = await readdir(join(projectDirectory, 'id-hist'));
      assert.equal(history.length, 2);
      await assert.rejects(readFile(join(projectDirectory, 'id-pend.yaml')), {
        code: 'ENOENT',
      });
      await assert.rejects(readFile(join(projectDirectory, 'ids.yaml.lock')), {
        code: 'ENOENT',
      });
    });
  }
});

test('a fresh writer reclaims a process-killed lock and rolls its durable intent forward', async () => {
  const fixture = await persistedRegistryPair('cruise-build-registry-killed-writer-');
  await assert.rejects(
    crashRegistryWriterInFreshProcess(fixture.root, fixture.path, 'after_pending_commit'),
    (error) => error.code === 86,
  );

  const recoveredSnapshot = await writeBuildIdRegistry(fixture.path, fixture.candidate, {
    initialBuildOriginAttestation: fixture.captured.attestation,
    originRecord: fixture.captured.origin_record,
    expectedSnapshot: fixture.firstSnapshot,
  });
  const recovered = await readBuildIdRegistry(fixture.path, {
    initialBuildOriginAttestation: fixture.captured.attestation,
    originRecord: fixture.captured.origin_record,
    expectedSnapshot: recoveredSnapshot,
  });
  assert.equal(recovered.revision, fixture.candidate.revision);
  await assert.rejects(
    readFile(join(fixture.root, '.cruise', 'project', 'ids.yaml.lock')),
    { code: 'ENOENT' },
  );
});

test('registry writer reclaims only a validated dead PID/nonce lock', async () => {
  const fixture = await persistedRegistryPair('cruise-build-registry-dead-lock-');
  const lockPath = join(fixture.root, '.cruise', 'project', 'ids.yaml.lock');
  const metadata = (pid, nonce) => ({
    schema_version: 1,
    kind: 'cruise_build_id_registry_writer_lock',
    origin_identity_sha256: fixture.predecessor.origin_identity_sha256,
    project_id: fixture.predecessor.project_id,
    registry_path: 'ids.yaml',
    pid,
    nonce,
    acquired_at: '2026-07-13T00:00:04.000Z',
  });

  await writeFile(lockPath, stringifyYaml(metadata(process.pid, 'not-a-valid-nonce')));
  await assert.rejects(
    writeBuildIdRegistry(fixture.path, fixture.candidate, {
      initialBuildOriginAttestation: fixture.captured.attestation,
      originRecord: fixture.captured.origin_record,
      expectedSnapshot: fixture.firstSnapshot,
    }),
    /lock is malformed or belongs elsewhere/,
  );
  await rm(lockPath);

  await writeFile(
    lockPath,
    stringifyYaml(metadata(process.pid, '00000000-0000-4000-8000-000000000000')),
  );
  await assert.rejects(
    writeBuildIdRegistry(fixture.path, fixture.candidate, {
      initialBuildOriginAttestation: fixture.captured.attestation,
      originRecord: fixture.captured.origin_record,
      expectedSnapshot: fixture.firstSnapshot,
    }),
    new RegExp(`locked by active writer ${process.pid}`),
  );
  await rm(lockPath);

  const deadWriter = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const deadPid = deadWriter.pid;
  await once(deadWriter, 'exit');
  await writeFile(
    lockPath,
    stringifyYaml(metadata(deadPid, '00000000-0000-4000-8000-000000000000')),
  );

  const snapshot = await writeBuildIdRegistry(fixture.path, fixture.candidate, {
    initialBuildOriginAttestation: fixture.captured.attestation,
    originRecord: fixture.captured.origin_record,
    expectedSnapshot: fixture.firstSnapshot,
  });
  assert.equal(snapshot.revision, fixture.candidate.revision);
  await assert.rejects(readFile(lockPath), { code: 'ENOENT' });
});
