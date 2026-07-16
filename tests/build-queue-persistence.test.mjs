import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createQueueApproval,
  createQueueChildOrigin,
  verifyBuildApproval,
  verifyBuildApprovalArtifacts,
} from '../scripts/lib/build-contract.mjs';
import {
  attestBuildQueueStateResume,
  attestBuildQueueSemanticAdmission,
  attestCurrentBuildQueueBaseline,
  attestManualBuildQueueStart,
  createBuildQueueCoordinator,
  createBuildQueueHostInteractionBroker,
  createBuildQueueStateSnapshot,
  initializeBuildQueueState,
  persistBuildQueueState,
  readPersistedBuildQueueState,
  reconcileBuildQueueState,
  transitionBuildQueueItem,
} from '../scripts/lib/build-queue-coordinator.mjs';
import {
  createEvidenceItem,
  createEvidenceRecord,
} from '../scripts/lib/evidence.mjs';
import { canonicalJson, parseYaml, stringifyYaml } from '../scripts/lib/yaml-state.mjs';
import { createMilestoneRuntimeFixture } from './helpers/milestone-runtime-fixture.mjs';

const NOW = '2026-07-13T00:00:00.000Z';
const LATER = '2026-07-13T01:00:00.000Z';
const QUEUE_PATH = '.cruise/milestones/M-003-rollout/QUEUE.yaml';
const STATE_PATH = '.cruise/milestones/M-003-rollout/queue-run.yaml';
const HISTORY_PATH = '.cruise/milestones/M-003-rollout/queue-hist';
const IDENTITY = Object.freeze({
  source: 'git:queue-persistence-test',
  build: 'source-tree:queue-persistence-test',
  environment: 'node test; isolated temporary repository',
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cruise-queue-persistence-')));
  await mkdir(join(root, '.cruise/goal'), { recursive: true });
  const milestone = await createMilestoneRuntimeFixture(root, { phasePlanBound: false });
  const queue = parseYaml(await readFile(join(root, QUEUE_PATH), 'utf8'));
  const queueApproval = createQueueApproval({
    queue,
    verifiedBuildApproval: milestone.verifiedBuildApproval,
  });
  const coordinator = createBuildQueueCoordinator({
    queue,
    verifiedBuildApproval: milestone.verifiedBuildApproval,
    queueApproval,
  });
  return {
    root,
    queue,
    coordinator,
    verifiedBuildApproval: milestone.verifiedBuildApproval,
    persistedBuildApproval: milestone.persistedBuildApproval,
    buildSelection: milestone.buildSelection,
    buildOriginPairAuthority: milestone.buildOriginPairAuthority,
    buildIdHistoryAuthority: milestone.buildIdHistoryAuthority,
    absoluteStatePath: join(root, STATE_PATH),
    absoluteHistoryPath: join(root, HISTORY_PATH),
  };
}

function recreateCoordinator(subject) {
  const queueApproval = createQueueApproval({
    queue: subject.queue,
    verifiedBuildApproval: subject.verifiedBuildApproval,
  });
  return createBuildQueueCoordinator({
    queue: subject.queue,
    verifiedBuildApproval: subject.verifiedBuildApproval,
    queueApproval,
  });
}

async function reverifyCoordinator(subject) {
  const verifiedBuildApproval = await verifyBuildApproval({
    root: subject.root,
    approval: subject.persistedBuildApproval,
    approvalSelection: subject.buildSelection,
    currentRepositoryBaselineDigest:
      subject.verifiedBuildApproval.repository_baseline_digest,
    buildOriginPairAuthority: subject.buildOriginPairAuthority,
    buildIdHistoryAuthority: subject.buildIdHistoryAuthority,
  });
  const queueApproval = createQueueApproval({
    queue: subject.queue,
    verifiedBuildApproval,
  });
  return {
    verifiedBuildApproval,
    coordinator: createBuildQueueCoordinator({
      queue: subject.queue,
      verifiedBuildApproval,
      queueApproval,
    }),
  };
}

function hostResume(coordinator, snapshot, interactionId) {
  return attestBuildQueueStateResume(coordinator, {
    kind: 'host_queue_state_resume_event',
    source: 'cruise_host_adapter',
    interaction_id: interactionId,
    queue_id: snapshot.queue_id,
    definition_sha256: snapshot.definition_sha256,
    state_path: snapshot.state_path,
    state_present: true,
    revision: snapshot.revision,
    state_sha256: snapshot.state_sha256,
    file_sha256: snapshot.file_sha256,
    history_path: snapshot.history_path,
    history_head_revision: snapshot.history_head_revision,
    history_head_sha256: snapshot.history_head_sha256,
    history_sha256: snapshot.history_sha256,
    observed_at: NOW,
  });
}

async function hostResumeForBytes(
  subject,
  coordinator,
  state,
  bytes,
  interactionId,
  { statePresent = true } = {},
) {
  const names = (await readdir(join(subject.root, HISTORY_PATH))).sort((left, right) =>
    left.localeCompare(right, 'en'));
  const historyFiles = await Promise.all(names.map(async (name) => ({
    name,
    file_sha256: sha256(await readFile(join(subject.root, HISTORY_PATH, name))),
    entry: parseYaml(await readFile(join(subject.root, HISTORY_PATH, name), 'utf8')),
  })));
  const head = historyFiles.at(-1).entry;
  return attestBuildQueueStateResume(coordinator, {
    kind: 'host_queue_state_resume_event',
    source: 'cruise_host_adapter',
    interaction_id: interactionId,
    queue_id: coordinator.queue_id,
    definition_sha256: coordinator.definition_sha256,
    state_path: STATE_PATH,
    state_present: statePresent,
    revision: state.revision,
    state_sha256: sha256(canonicalJson(state)),
    file_sha256: sha256(bytes),
    history_path: HISTORY_PATH,
    history_head_revision: head.revision,
    history_head_sha256: head.entry_sha256,
    history_sha256: sha256(canonicalJson(historyFiles.map(({ name, file_sha256, entry }) => ({
      name,
      file_sha256,
      entry_sha256: entry.entry_sha256,
    })) )),
    observed_at: NOW,
  });
}

test('revision-zero history rolls forward after a crash before the first state rename', async () => {
  const subject = await fixture();
  const initial = initializeBuildQueueState(subject.coordinator, { now: () => NOW });
  await assert.rejects(
    persistBuildQueueState({
      root: subject.root,
      coordinator: subject.coordinator,
      state: initial,
      persistenceFaultInjector: async (checkpoint) => {
        if (checkpoint === 'after_history_append') {
          throw new Error('simulated genesis commit crash');
        }
      },
    }),
    /simulated genesis commit crash/u,
  );
  await assert.rejects(lstat(subject.absoluteStatePath), { code: 'ENOENT' });

  const head = parseYaml(
    await readFile(join(subject.absoluteHistoryPath, 'q-0.yaml'), 'utf8'),
  );
  const genesisBytes = Buffer.from(head.state_yaml_base64, 'base64');
  const genesis = parseYaml(genesisBytes.toString('utf8'));
  const freshCoordinator = recreateCoordinator(subject);
  const resumeAttestation = await hostResumeForBytes(
    subject,
    freshCoordinator,
    genesis,
    genesisBytes,
    'genesis-crash-recovery',
    { statePresent: false },
  );
  const recovered = await readPersistedBuildQueueState({
    root: subject.root,
    coordinator: freshCoordinator,
    resumeAttestation,
  });
  assert.equal(recovered.state.revision, 0);
  assert.deepEqual(recovered.state, genesis);
  assert.deepEqual(await readFile(subject.absoluteStatePath), genesisBytes);
  assert.equal((await lstat(subject.absoluteHistoryPath)).mode & 0o777, 0o700);
  assert.equal(
    (await lstat(join(subject.absoluteHistoryPath, 'q-0.yaml'))).mode & 0o777,
    0o400,
  );
  await assert.rejects(
    readPersistedBuildQueueState({
      root: subject.root,
      coordinator: freshCoordinator,
      resumeAttestation,
    }),
    /consumed|cloned|stale/u,
  );
});

test('empty revision-zero staging is reclaimed after pre-link writer crashes', async () => {
  for (const checkpoint of [
    'after_history_directory_prepare',
    'after_history_entry_prepare',
  ]) {
    const subject = await fixture();
    const initial = initializeBuildQueueState(subject.coordinator, { now: () => NOW });
    await assert.rejects(
      persistBuildQueueState({
        root: subject.root,
        coordinator: subject.coordinator,
        state: initial,
        persistenceFaultInjector: async (observed) => {
          if (observed === checkpoint) throw new Error(`simulated ${checkpoint} crash`);
        },
      }),
      new RegExp(`simulated ${checkpoint} crash`, 'u'),
    );
    assert.deepEqual(await readdir(subject.absoluteHistoryPath), []);
    await assert.rejects(lstat(subject.absoluteStatePath), { code: 'ENOENT' });

    const staleUuid = '00000000-0000-4000-8000-000000000099';
    const approvedDirectory = join(
      subject.root,
      '.cruise/milestones/M-003-rollout',
    );
    await writeFile(
      join(approvedDirectory, '.q-hist-stage'),
      'abandoned history staging',
      { mode: 0o400 },
    );
    await writeFile(
      join(approvedDirectory, '.q-state-stage'),
      'abandoned state staging',
      { mode: 0o600 },
    );
    await installWriterLock(subject, subject.coordinator, 99_999_999, staleUuid);

    const fresh = recreateCoordinator(subject);
    const freshInitial = initializeBuildQueueState(fresh, { now: () => NOW });
    const persisted = await persistBuildQueueState({
      root: subject.root,
      coordinator: fresh,
      state: freshInitial,
    });
    assert.equal(persisted.snapshot.history_head_revision, 0);
    assert.deepEqual(await readdir(subject.absoluteHistoryPath), [
      'q-0.yaml',
    ]);
    assert.deepEqual(
      (await readdir(approvedDirectory)).filter((name) => name.endsWith('.tmp')),
      [],
    );
  }
});

test('writer lock publication cannot expose partial canonical metadata', async () => {
  const subject = await fixture();
  const initial = initializeBuildQueueState(subject.coordinator, { now: () => NOW });
  const abandonedPreparation = `${subject.absoluteStatePath}.lock.99999999.00000000-0000-4000-8000-000000000077.prepare`;
  await writeFile(abandonedPreparation, '', { mode: 0o600 });
  const persisted = await persistBuildQueueState({
    root: subject.root,
    coordinator: subject.coordinator,
    state: initial,
  });
  assert.equal(persisted.snapshot.revision, 0);
  await assert.rejects(lstat(`${subject.absoluteStatePath}.lock`), { code: 'ENOENT' });

  const malformed = await fixture();
  const malformedInitial = initializeBuildQueueState(malformed.coordinator, {
    now: () => NOW,
  });
  await writeFile(`${malformed.absoluteStatePath}.lock`, '', { mode: 0o600 });
  await assert.rejects(
    persistBuildQueueState({
      root: malformed.root,
      coordinator: malformed.coordinator,
      state: malformedInitial,
    }),
    /writer lock must contain one mapping/u,
  );
  await assert.rejects(lstat(malformed.absoluteStatePath), { code: 'ENOENT' });
  await assert.rejects(lstat(malformed.absoluteHistoryPath), { code: 'ENOENT' });
});

test('pre-link genesis commitment recovers exact bytes after fresh-process clock drift', async () => {
  const subject = await fixture();
  const initial = initializeBuildQueueState(subject.coordinator, { now: () => NOW });
  await assert.rejects(
    persistBuildQueueState({
      root: subject.root,
      coordinator: subject.coordinator,
      state: initial,
      persistenceFaultInjector: async (checkpoint) => {
        if (checkpoint === 'after_history_directory_prepare') {
          throw new Error('simulated pre-link process death');
        }
      },
    }),
    /simulated pre-link process death/u,
  );
  const fresh = recreateCoordinator(subject);
  const differentGenesis = initializeBuildQueueState(fresh, {
    now: () => '2026-07-13T00:05:00.000Z',
  });
  await assert.rejects(
    persistBuildQueueState({
      root: subject.root,
      coordinator: fresh,
      state: differentGenesis,
    }),
    /recovered pre-link queue genesis differs/u,
  );
  await assert.rejects(lstat(subject.absoluteStatePath), { code: 'ENOENT' });
  const historyEntry = parseYaml(
    await readFile(join(subject.absoluteHistoryPath, 'q-0.yaml'), 'utf8'),
  );
  const exactBytes = Buffer.from(historyEntry.state_yaml_base64, 'base64');
  const exactGenesis = parseYaml(exactBytes.toString('utf8'));
  const resume = await hostResumeForBytes(
    subject,
    fresh,
    exactGenesis,
    exactBytes,
    'pre-link-clock-drift-recovery',
    { statePresent: false },
  );
  const recovered = await readPersistedBuildQueueState({
    root: subject.root,
    coordinator: fresh,
    resumeAttestation: resume,
  });
  assert.deepEqual(recovered.state, initial);
});

test('fresh read materializes a committed later revision lost before its history link', async () => {
  const subject = await fixture();
  const initial = initializeBuildQueueState(subject.coordinator, { now: () => NOW });
  const first = await persistBuildQueueState({
    root: subject.root,
    coordinator: subject.coordinator,
    state: initial,
  });
  const predecessorBytes = await readFile(subject.absoluteStatePath);
  const successor = reconcileBuildQueueState(subject.coordinator, initial, { now: LATER });
  await assert.rejects(
    persistBuildQueueState({
      root: subject.root,
      coordinator: subject.coordinator,
      state: successor,
      expectedSnapshot: first.snapshot,
      persistenceFaultInjector: async (checkpoint) => {
        if (checkpoint === 'after_history_directory_prepare') {
          throw new Error('simulated later pre-history-link process death');
        }
      },
    }),
    /simulated later pre-history-link process death/u,
  );
  assert.deepEqual(await readdir(subject.absoluteHistoryPath), [
    'q-0.yaml',
  ]);

  const fresh = recreateCoordinator(subject);
  const staleObservation = hostResume(
    fresh,
    first.snapshot,
    'later-pre-link-stale-observation',
  );
  await assert.rejects(
    readPersistedBuildQueueState({
      root: subject.root,
      coordinator: fresh,
      resumeAttestation: staleObservation,
    }),
    /resume attestation is stale/u,
  );
  assert.deepEqual(await readdir(subject.absoluteHistoryPath), [
    'q-0.yaml',
    'q-1.yaml',
  ]);
  const currentObservation = await hostResumeForBytes(
    subject,
    fresh,
    initial,
    predecessorBytes,
    'later-pre-link-current-observation',
  );
  const recovered = await readPersistedBuildQueueState({
    root: subject.root,
    coordinator: fresh,
    resumeAttestation: currentObservation,
  });
  assert.deepEqual(recovered.state, successor);
});

test('queue persistence is repository-root bound and refuses total genesis rollback', async () => {
  const subject = await fixture();
  const initial = initializeBuildQueueState(subject.coordinator, { now: () => NOW });
  const unrelatedRoot = await realpath(
    await mkdtemp(join(tmpdir(), 'cruise-queue-wrong-root-')),
  );
  await assert.rejects(
    persistBuildQueueState({
      root: unrelatedRoot,
      coordinator: subject.coordinator,
      state: initial,
    }),
    /differs from the verified Build approval repository/u,
  );
  await assert.rejects(lstat(join(unrelatedRoot, STATE_PATH)), { code: 'ENOENT' });

  await persistBuildQueueState({
    root: subject.root,
    coordinator: subject.coordinator,
    state: initial,
  });
  const commitmentDirectory = join(
    subject.root,
    '.cruise/queue-locks',
  );
  const commitmentEntries = await readdir(commitmentDirectory, { withFileTypes: true });
  const commitmentFiles = commitmentEntries.filter((entry) => entry.isFile());
  const commitmentLineages = commitmentEntries.filter((entry) => entry.isDirectory());
  assert.equal(commitmentFiles.length, 1);
  assert.equal(commitmentLineages.length, 1);
  assert.equal((await lstat(commitmentDirectory)).mode & 0o777, 0o700);
  assert.equal(
    (await lstat(join(commitmentDirectory, commitmentFiles[0].name))).mode & 0o777,
    0o400,
  );
  assert.deepEqual(
    await readdir(join(commitmentDirectory, commitmentLineages[0].name)),
    ['q-0.yaml'],
  );
  await rm(subject.absoluteStatePath, { force: true });
  await rm(subject.absoluteHistoryPath, { recursive: true, force: true });
  const reverified = await reverifyCoordinator(subject);
  const reverifiedBuildApproval = reverified.verifiedBuildApproval;
  assert.notEqual(reverifiedBuildApproval, subject.verifiedBuildApproval);
  assert.equal(
    reverifiedBuildApproval.approval_digest,
    subject.verifiedBuildApproval.approval_digest,
  );
  const fresh = reverified.coordinator;
  const freshInitial = initializeBuildQueueState(fresh, { now: () => NOW });
  await assert.rejects(
    persistBuildQueueState({
      root: subject.root,
      coordinator: fresh,
      state: freshInitial,
    }),
    /durable queue genesis were deleted/u,
  );
  await assert.rejects(lstat(subject.absoluteStatePath), { code: 'ENOENT' });
  await assert.rejects(lstat(subject.absoluteHistoryPath), { code: 'ENOENT' });
});

test('durable revision commitments reject a consistent local history rollback', async () => {
  const subject = await fixture();
  const initial = initializeBuildQueueState(subject.coordinator, { now: () => NOW });
  const first = await persistBuildQueueState({
    root: subject.root,
    coordinator: subject.coordinator,
    state: initial,
  });
  const revisionOne = reconcileBuildQueueState(subject.coordinator, initial, {
    now: LATER,
  });
  const second = await persistBuildQueueState({
    root: subject.root,
    coordinator: subject.coordinator,
    state: revisionOne,
    expectedSnapshot: first.snapshot,
  });
  const revisionOneBytes = await readFile(subject.absoluteStatePath);
  const revisionTwo = reconcileBuildQueueState(subject.coordinator, revisionOne, {
    now: '2026-07-13T02:00:00.000Z',
  });
  await persistBuildQueueState({
    root: subject.root,
    coordinator: subject.coordinator,
    state: revisionTwo,
    expectedSnapshot: second.snapshot,
  });

  await writeFile(subject.absoluteStatePath, revisionOneBytes, { mode: 0o600 });
  await unlink(join(subject.absoluteHistoryPath, 'q-2.yaml'));
  const fresh = (await reverifyCoordinator(subject)).coordinator;
  const rollbackResume = await hostResumeForBytes(
    subject,
    fresh,
    revisionOne,
    revisionOneBytes,
    'consistent-history-rollback',
  );
  await assert.rejects(
    readPersistedBuildQueueState({
      root: subject.root,
      coordinator: fresh,
      resumeAttestation: rollbackResume,
    }),
    /resume attestation is stale|rolled back behind its durable revision commitments|not fully covered by its durable revision commitments/u,
  );
  const currentRollbackObservation = await hostResumeForBytes(
    subject,
    fresh,
    revisionOne,
    revisionOneBytes,
    'consistent-history-rollback-current',
  );
  const restored = await readPersistedBuildQueueState({
    root: subject.root,
    coordinator: fresh,
    resumeAttestation: currentRollbackObservation,
  });
  assert.deepEqual(restored.state, revisionTwo);
});

async function installForgedHistorySuccessor(
  subject,
  coordinator,
  state,
  { installState = true } = {},
) {
  const bytes = Buffer.from(stringifyYaml(state), 'utf8');
  const previousName = `q-${state.revision - 1}.yaml`;
  const previous = parseYaml(await readFile(join(subject.root, HISTORY_PATH, previousName), 'utf8'));
  const payload = {
    schema_version: 1,
    kind: 'cruise_build_queue_state_history_entry',
    queue_id: coordinator.queue_id,
    definition_sha256: coordinator.definition_sha256,
    state_path: STATE_PATH,
    revision: state.revision,
    state_sha256: sha256(canonicalJson(state)),
    state_file_sha256: sha256(bytes),
    state_yaml_base64: bytes.toString('base64'),
    previous_entry_sha256: previous.entry_sha256,
  };
  const entry = { ...payload, entry_sha256: sha256(canonicalJson(payload)) };
  const name = `q-${state.revision}.yaml`;
  await writeFile(join(subject.root, HISTORY_PATH, name), stringifyYaml(entry), { mode: 0o400 });
  if (installState) await writeFile(subject.absoluteStatePath, bytes, { mode: 0o600 });
  return bytes;
}

async function installWriterLock(subject, coordinator, pid, nonce) {
  await writeFile(`${subject.absoluteStatePath}.lock`, stringifyYaml({
    schema_version: 1,
    kind: 'cruise_build_queue_state_writer_lock',
    queue_id: coordinator.queue_id,
    definition_sha256: coordinator.definition_sha256,
    state_path: STATE_PATH,
    pid,
    nonce,
    purpose: 'persist',
    acquired_at: NOW,
  }), { mode: 0o600 });
}

function evidence(id) {
  const item = createEvidenceItem({
    id,
    gate: 'mandatory',
    scope: 'task',
    status: 'PASS',
    performed: true,
    procedure: 'Exercise the queue persistence boundary.',
    command: 'node --test tests/build-queue-persistence.test.mjs',
    expected: 'The selected queue transition is evidence-bound.',
    actual: 'The selected queue transition was evidence-bound.',
    identity: IDENTITY,
    startedAt: NOW,
    finishedAt: LATER,
    supports: [],
    sideEffects: [],
  });
  return createEvidenceRecord({
    runId: `queue-persistence-${id}`,
    recordedAt: LATER,
    items: [item],
  });
}

function childOrigin(queue, itemId) {
  const item = queue.items.find(({ id }) => id === itemId);
  return createQueueChildOrigin({
    queue,
    queueItemId: itemId,
    inheritedOutcome: item.purpose,
    narrowedOutcome: item.scope,
    permittedChanges: item.permitted_changes,
    prohibitedChanges: item.prohibited_changes,
  });
}

async function startFirstItem(subject, state) {
  const artifactSnapshot = await verifyBuildApprovalArtifacts({
    root: subject.root,
    verifiedBuildApproval: subject.verifiedBuildApproval,
    now: NOW,
  });
  const baselineAttestation = attestCurrentBuildQueueBaseline(subject.coordinator, state, {
    itemId: 'QI-01',
    verifiedArtifactSnapshot: artifactSnapshot,
    observation: {
      kind: 'host_repository_baseline_observation',
      source: 'deterministic_repository_probe',
      baseline_digest: state.expected_repository_baseline_digest,
      cruise_paths_excluded: true,
      observed_at: NOW,
    },
  });
  const interactionBroker = createBuildQueueHostInteractionBroker({
    coordinator: subject.coordinator,
    sessionId: 'queue-persistence-session',
    runId: `queue-persistence-run-${state.revision}`,
  });
  const semanticReceipt = interactionBroker.observeSemanticAdmission(state, {
    kind: 'host_queue_semantic_admission_event',
    source: 'cruise_router_and_permission_gate',
    interaction_id: 'queue-persistence-semantic-QI-01',
    queue_item_id: 'QI-01',
    skill: 'goal',
    accepted: true,
    permissions_satisfied: true,
    authentication_satisfied: true,
    host_continuation_supported: true,
    permission_envelope_sha256:
      subject.coordinator.queue_approval.permission_envelope_sha256,
    observed_at: NOW,
  });
  const selectionReceipt = interactionBroker.observeManualStartSelection(state, {
    kind: 'host_queue_start_event',
    source: 'request_user_input',
    input_kind: 'option_selection',
    queue_id: subject.coordinator.queue_id,
    queue_item_id: 'QI-01',
    interaction_id: 'queue-persistence-start-QI-01',
    option_id: 'start_qi-01',
    selected_label: 'Start QI-01',
    selected_at: NOW,
    offered_options: [{ id: 'start_qi-01', label: 'Start QI-01' }],
  });
  const admission = attestManualBuildQueueStart(
    subject.coordinator,
    state,
    selectionReceipt,
    {
    baselineAttestation,
      semanticAdmission: attestBuildQueueSemanticAdmission(
        subject.coordinator,
        state,
        semanticReceipt,
      ),
    },
  );
  return transitionBuildQueueItem(subject.coordinator, state, {
    itemId: 'QI-01',
    toStatus: 'running',
    evidence: [evidence('E-01')],
    childOrigin: childOrigin(subject.queue, 'QI-01'),
    startAdmission: admission,
    consumedInputs: [],
  }, { now: LATER });
}

test('queue state persists atomically beside QUEUE.yaml and resumes only from exact bytes once', async () => {
  const subject = await fixture();
  const initial = initializeBuildQueueState(subject.coordinator, { now: NOW });

  await assert.rejects(
    persistBuildQueueState({
      root: subject.root,
      coordinator: subject.coordinator,
      state: structuredClone(initial),
    }),
    /opaque reducer state/,
  );

  const persisted = await persistBuildQueueState({
    root: subject.root,
    coordinator: subject.coordinator,
    state: initial,
  });
  assert.equal(persisted.path, STATE_PATH);
  assert.equal(persisted.history_path, HISTORY_PATH);
  const bytes = await readFile(subject.absoluteStatePath);
  assert.equal(persisted.snapshot.file_sha256, sha256(bytes));
  assert.equal(persisted.snapshot.state_sha256, sha256(canonicalJson(initial)));
  assert.equal(persisted.snapshot.history_head_revision, 0);
  assert.match(persisted.snapshot.history_head_sha256, /^[a-f0-9]{64}$/u);
  assert.match(persisted.snapshot.history_sha256, /^[a-f0-9]{64}$/u);
  assert.equal((await lstat(subject.absoluteStatePath)).mode & 0o777, 0o600);
  assert.equal((await lstat(subject.absoluteHistoryPath)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(subject.absoluteHistoryPath), ['q-0.yaml']);
  assert.equal(
    (await lstat(join(subject.absoluteHistoryPath, 'q-0.yaml'))).mode & 0o777,
    0o400,
  );
  assert.deepEqual(
    (await readdir(join(subject.root, '.cruise/milestones/M-003-rollout')))
      .filter((name) => name === '.q-state-stage'),
    [],
  );

  const inMemorySnapshot = createBuildQueueStateSnapshot(subject.coordinator, initial);
  await assert.rejects(
    persistBuildQueueState({
      root: subject.root,
      coordinator: subject.coordinator,
      state: initial,
      expectedSnapshot: inMemorySnapshot,
    }),
    /prior exact file write\/read/,
  );
  await assert.rejects(
    persistBuildQueueState({
      root: subject.root,
      coordinator: subject.coordinator,
      state: initial,
      expectedSnapshot: structuredClone(persisted.snapshot),
    }),
    /prior exact file write\/read/,
  );

  const resume = hostResume(subject.coordinator, persisted.snapshot, 'resume-exact-once');
  await assert.rejects(
    readPersistedBuildQueueState({
      root: subject.root,
      coordinator: subject.coordinator,
      resumeAttestation: structuredClone(resume),
    }),
    /stale, consumed, cloned, or belongs elsewhere/,
  );
  const loaded = await readPersistedBuildQueueState({
    root: subject.root,
    coordinator: subject.coordinator,
    resumeAttestation: resume,
  });
  assert.deepEqual(loaded.state, initial);
  assert.equal(loaded.snapshot.file_sha256, persisted.snapshot.file_sha256);
  await assert.rejects(
    readPersistedBuildQueueState({
      root: subject.root,
      coordinator: subject.coordinator,
      resumeAttestation: resume,
    }),
    /stale, consumed, cloned, or belongs elsewhere/,
  );
  assert.throws(
    () => hostResume(subject.coordinator, persisted.snapshot, 'resume-exact-once'),
    /already minted one-use authority/,
  );
  assert.throws(
    () => reconcileBuildQueueState(subject.coordinator, structuredClone(loaded.state)),
    /opaque reducer state/,
  );
});

test('opaque exact-byte CAS rejects older, forked, skipped-revision, rewritten, and symlink state', async () => {
  const subject = await fixture();
  const initial = initializeBuildQueueState(subject.coordinator, { now: NOW });
  const first = await persistBuildQueueState({
    root: subject.root,
    coordinator: subject.coordinator,
    state: initial,
  });
  const branchA = reconcileBuildQueueState(subject.coordinator, initial, { now: LATER });
  const branchB = reconcileBuildQueueState(subject.coordinator, initial, {
    now: '2026-07-13T02:00:00.000Z',
  });
  const second = await persistBuildQueueState({
    root: subject.root,
    coordinator: subject.coordinator,
    state: branchA,
    expectedSnapshot: first.snapshot,
  });

  await assert.rejects(
    persistBuildQueueState({
      root: subject.root,
      coordinator: subject.coordinator,
      state: branchB,
      expectedSnapshot: first.snapshot,
    }),
    /stale|revision|file digest/,
  );
  await assert.rejects(
    persistBuildQueueState({
      root: subject.root,
      coordinator: subject.coordinator,
      state: initial,
      expectedSnapshot: second.snapshot,
    }),
    /exactly one revision/,
  );
  await assert.rejects(
    persistBuildQueueState({
      root: subject.root,
      coordinator: subject.coordinator,
      state: structuredClone(branchA),
      expectedSnapshot: second.snapshot,
    }),
    /opaque reducer state/,
  );

  const stableBytes = await readFile(subject.absoluteStatePath);
  const skipped = structuredClone(branchA);
  skipped.revision = branchA.revision + 2;
  const skippedBytes = Buffer.from(stringifyYaml(skipped), 'utf8');
  await writeFile(subject.absoluteStatePath, skippedBytes, { mode: 0o600 });
  await assert.rejects(
    hostResumeForBytes(
      subject,
      subject.coordinator,
      skipped,
      skippedBytes,
      'resume-skipped-revision',
    ),
    /not bound to this approved queue history head/,
  );

  await writeFile(subject.absoluteStatePath, stableBytes, { mode: 0o600 });
  const rewrittenBytes = Buffer.concat([Buffer.from('# rewritten bytes\n'), stableBytes]);
  await writeFile(subject.absoluteStatePath, rewrittenBytes, { mode: 0o600 });
  const rewrittenResume = await hostResumeForBytes(
    subject,
    subject.coordinator,
    branchA,
    rewrittenBytes,
    'resume-rewritten-bytes',
  );
  await assert.rejects(
    readPersistedBuildQueueState({
      root: subject.root,
      coordinator: subject.coordinator,
      resumeAttestation: rewrittenResume,
    }),
    /forked from its persistent exact-hash history head|differs from its durable commitment/,
  );

  await unlink(subject.absoluteStatePath);
  const moved = `${subject.absoluteStatePath}.moved`;
  await writeFile(moved, stableBytes, { mode: 0o600 });
  await symlink(moved, subject.absoluteStatePath);
  await assert.rejects(
    readPersistedBuildQueueState({
      root: subject.root,
      coordinator: subject.coordinator,
      resumeAttestation: hostResume(
        subject.coordinator,
        second.snapshot,
        'resume-symlink-state',
      ),
    }),
    /regular no-follow file/,
  );
  await assert.rejects(
    persistBuildQueueState({
      root: subject.root,
      coordinator: subject.coordinator,
      state: branchA,
      expectedSnapshot: second.snapshot,
    }),
    /regular no-follow file/,
  );

  const approvedDirectory = join(subject.root, '.cruise/milestones/M-003-rollout');
  const movedDirectory = `${approvedDirectory}.moved`;
  await rename(approvedDirectory, movedDirectory);
  await symlink(movedDirectory, approvedDirectory);
  await assert.rejects(
    persistBuildQueueState({
      root: subject.root,
      coordinator: subject.coordinator,
      state: branchA,
      expectedSnapshot: second.snapshot,
    }),
    /directory must not traverse a symbolic link/,
  );
});

test('fresh coordinators verify persistent history before accepting rollback, forks, or symlinks', async () => {
  const subject = await fixture();
  const initial = initializeBuildQueueState(subject.coordinator, { now: NOW });
  const first = await persistBuildQueueState({
    root: subject.root,
    coordinator: subject.coordinator,
    state: initial,
  });
  const stateZeroBytes = await readFile(subject.absoluteStatePath);
  const current = reconcileBuildQueueState(subject.coordinator, initial, { now: LATER });
  const second = await persistBuildQueueState({
    root: subject.root,
    coordinator: subject.coordinator,
    state: current,
    expectedSnapshot: first.snapshot,
  });
  const stateOneBytes = await readFile(subject.absoluteStatePath);
  const entryOnePath = join(subject.absoluteHistoryPath, 'q-1.yaml');
  const entryOneBytes = await readFile(entryOnePath);

  const validCoordinator = recreateCoordinator(subject);
  const valid = await readPersistedBuildQueueState({
    root: subject.root,
    coordinator: validCoordinator,
    resumeAttestation: hostResume(validCoordinator, second.snapshot, 'fresh-history-valid'),
  });
  assert.equal(valid.state.revision, 1);
  assert.equal(valid.snapshot.history_head_revision, 1);

  await writeFile(subject.absoluteStatePath, stateOneBytes, { mode: 0o600 });
  const rollbackCoordinator = recreateCoordinator(subject);
  const rollbackAttestation = hostResume(
    rollbackCoordinator,
    second.snapshot,
    'fresh-history-state-rollback',
  );
  await writeFile(subject.absoluteStatePath, stateZeroBytes, { mode: 0o600 });
  await assert.rejects(
    readPersistedBuildQueueState({
      root: subject.root,
      coordinator: rollbackCoordinator,
      resumeAttestation: rollbackAttestation,
    }),
    /resume attestation is stale/,
  );

  await writeFile(subject.absoluteStatePath, stateOneBytes, { mode: 0o600 });
  const forkCoordinator = recreateCoordinator(subject);
  const forkAttestation = hostResume(
    forkCoordinator,
    second.snapshot,
    'fresh-history-state-fork',
  );
  const fork = reconcileBuildQueueState(subject.coordinator, initial, {
    now: '2026-07-13T02:00:00.000Z',
  });
  const forkBytes = Buffer.from(stringifyYaml(fork), 'utf8');
  await writeFile(subject.absoluteStatePath, forkBytes, { mode: 0o600 });
  await assert.rejects(
    readPersistedBuildQueueState({
      root: subject.root,
      coordinator: forkCoordinator,
      resumeAttestation: forkAttestation,
    }),
    /forked from its persistent exact-hash history head|differs from its durable commitment/,
  );

  await writeFile(subject.absoluteStatePath, stateOneBytes, { mode: 0o600 });
  const historyRollbackCoordinator = recreateCoordinator(subject);
  const historyRollbackAttestation = hostResume(
    historyRollbackCoordinator,
    second.snapshot,
    'fresh-history-entry-rollback',
  );
  await unlink(entryOnePath);
  const historyRestored = await readPersistedBuildQueueState({
    root: subject.root,
    coordinator: historyRollbackCoordinator,
    resumeAttestation: historyRollbackAttestation,
  });
  assert.equal(historyRestored.state.revision, 1);
  assert.deepEqual(await readFile(entryOnePath), entryOneBytes);

  const historyForkCoordinator = recreateCoordinator(subject);
  const historyForkAttestation = hostResume(
    historyForkCoordinator,
    second.snapshot,
    'fresh-history-entry-fork',
  );
  await unlink(entryOnePath);
  await installForgedHistorySuccessor(subject, historyForkCoordinator, fork);
  await writeFile(subject.absoluteStatePath, stateOneBytes, { mode: 0o600 });
  await assert.rejects(
    readPersistedBuildQueueState({
      root: subject.root,
      coordinator: historyForkCoordinator,
      resumeAttestation: historyForkAttestation,
    }),
    /forked from its persistent exact-hash history head|differs from its durable commitment/,
  );

  await unlink(entryOnePath);
  await writeFile(entryOnePath, entryOneBytes, { mode: 0o400 });
  const historySymlinkCoordinator = recreateCoordinator(subject);
  const historySymlinkAttestation = hostResume(
    historySymlinkCoordinator,
    second.snapshot,
    'fresh-history-entry-symlink',
  );
  const historyEntryBackup = join(subject.root, '.cruise', 'history-entry-backup.yaml');
  await writeFile(historyEntryBackup, entryOneBytes, { mode: 0o400 });
  await unlink(entryOnePath);
  await symlink(historyEntryBackup, entryOnePath);
  await assert.rejects(
    readPersistedBuildQueueState({
      root: subject.root,
      coordinator: historySymlinkCoordinator,
      resumeAttestation: historySymlinkAttestation,
    }),
    /regular no-follow history entry/,
  );

  await unlink(entryOnePath);
  await writeFile(entryOnePath, entryOneBytes, { mode: 0o400 });
  const historyDirectoryCoordinator = recreateCoordinator(subject);
  const historyDirectoryAttestation = hostResume(
    historyDirectoryCoordinator,
    second.snapshot,
    'fresh-history-directory-symlink',
  );
  const movedHistory = `${subject.absoluteHistoryPath}.moved`;
  await rename(subject.absoluteHistoryPath, movedHistory);
  await symlink(movedHistory, subject.absoluteHistoryPath);
  await assert.rejects(
    readPersistedBuildQueueState({
      root: subject.root,
      coordinator: historyDirectoryCoordinator,
      resumeAttestation: historyDirectoryAttestation,
    }),
    /queue-hist must be a regular no-follow directory/,
  );

});

test('fresh coordinator deterministically rolls one durable pending history head forward', async () => {
  const subject = await fixture();
  const initial = initializeBuildQueueState(subject.coordinator, { now: NOW });
  const first = await persistBuildQueueState({
    root: subject.root,
    coordinator: subject.coordinator,
    state: initial,
  });
  const predecessorBytes = await readFile(subject.absoluteStatePath);
  const successor = reconcileBuildQueueState(subject.coordinator, initial, { now: LATER });
  const successorBytes = Buffer.from(stringifyYaml(successor), 'utf8');
  await assert.rejects(
    persistBuildQueueState({
      root: subject.root,
      coordinator: subject.coordinator,
      state: successor,
      expectedSnapshot: first.snapshot,
      persistenceFaultInjector: async (checkpoint) => {
        if (checkpoint === 'after_history_append') {
          throw new Error('simulated trusted pending successor crash');
        }
      },
    }),
    /simulated trusted pending successor crash/u,
  );
  const historyHeadPath = join(subject.absoluteHistoryPath, 'q-1.yaml');
  const historyHeadBytes = await readFile(historyHeadPath);
  const fresh = recreateCoordinator(subject);
  const resume = await hostResumeForBytes(
    subject,
    fresh,
    initial,
    predecessorBytes,
    'fresh-pending-roll-forward',
  );
  await installWriterLock(
    subject,
    fresh,
    99_999_999,
    '00000000-0000-4000-8000-000000000001',
  );

  const recovered = await readPersistedBuildQueueState({
    root: subject.root,
    coordinator: fresh,
    resumeAttestation: resume,
  });
  assert.deepEqual(recovered.state, successor);
  assert.deepEqual(await readFile(subject.absoluteStatePath), successorBytes);
  assert.deepEqual(await readFile(historyHeadPath), historyHeadBytes);
  assert.equal(recovered.snapshot.revision, 1);
  assert.equal(recovered.snapshot.history_head_revision, 1);
  await assert.rejects(lstat(`${subject.absoluteStatePath}.lock`), { code: 'ENOENT' });
  await assert.rejects(
    readPersistedBuildQueueState({
      root: subject.root,
      coordinator: fresh,
      resumeAttestation: resume,
    }),
    /resume attestation is stale, consumed/,
  );

  const anotherFresh = recreateCoordinator(subject);
  const reread = await readPersistedBuildQueueState({
    root: subject.root,
    coordinator: anotherFresh,
    resumeAttestation: hostResume(
      anotherFresh,
      recovered.snapshot,
      'fresh-after-roll-forward',
    ),
  });
  assert.deepEqual(reread.state, successor);
});

test('roll-forward rejects invalid successors, revision gaps, and active writers without mutation', async () => {
  const invalidSubject = await fixture();
  const invalidInitial = initializeBuildQueueState(invalidSubject.coordinator, { now: NOW });
  const invalidFirst = await persistBuildQueueState({
    root: invalidSubject.root,
    coordinator: invalidSubject.coordinator,
    state: invalidInitial,
  });
  const waiting = transitionBuildQueueItem(invalidSubject.coordinator, invalidInitial, {
    itemId: 'QI-01',
    toStatus: 'waiting_approval',
    evidence: [evidence('E-01')],
    blockers: ['manual_approval_required'],
  }, { now: LATER });
  await persistBuildQueueState({
    root: invalidSubject.root,
    coordinator: invalidSubject.coordinator,
    state: waiting,
    expectedSnapshot: invalidFirst.snapshot,
  });
  const waitingBytes = await readFile(invalidSubject.absoluteStatePath);
  const erased = structuredClone(waiting);
  erased.revision += 1;
  erased.items[0].evidence = [];
  await installForgedHistorySuccessor(
    invalidSubject,
    invalidSubject.coordinator,
    erased,
    { installState: false },
  );
  const invalidFresh = recreateCoordinator(invalidSubject);
  const invalidResume = await hostResumeForBytes(
    invalidSubject,
    invalidFresh,
    waiting,
    waitingBytes,
    'fresh-invalid-pending-successor',
  );
  await assert.rejects(
    readPersistedBuildQueueState({
      root: invalidSubject.root,
      coordinator: invalidFresh,
      resumeAttestation: invalidResume,
    }),
    /evidence cannot shrink or fork|not fully covered by its durable revision commitments/,
  );
  assert.deepEqual(await readFile(invalidSubject.absoluteStatePath), waitingBytes);

  const gapSubject = await fixture();
  const gapInitial = initializeBuildQueueState(gapSubject.coordinator, { now: NOW });
  await persistBuildQueueState({
    root: gapSubject.root,
    coordinator: gapSubject.coordinator,
    state: gapInitial,
  });
  const gapStateBytes = await readFile(gapSubject.absoluteStatePath);
  const gapOne = reconcileBuildQueueState(gapSubject.coordinator, gapInitial, { now: LATER });
  await installForgedHistorySuccessor(
    gapSubject,
    gapSubject.coordinator,
    gapOne,
    { installState: false },
  );
  const gapFresh = recreateCoordinator(gapSubject);
  const gapResume = await hostResumeForBytes(
    gapSubject,
    gapFresh,
    gapInitial,
    gapStateBytes,
    'fresh-pending-before-gap',
  );
  const gapTwo = reconcileBuildQueueState(gapSubject.coordinator, gapOne, {
    now: '2026-07-13T02:00:00.000Z',
  });
  await installForgedHistorySuccessor(
    gapSubject,
    gapSubject.coordinator,
    gapTwo,
    { installState: false },
  );
  await assert.rejects(
    readPersistedBuildQueueState({
      root: gapSubject.root,
      coordinator: gapFresh,
      resumeAttestation: gapResume,
    }),
    /more than one revision ahead|not fully covered by its durable revision commitments/,
  );
  assert.deepEqual(await readFile(gapSubject.absoluteStatePath), gapStateBytes);

  const lockSubject = await fixture();
  const lockInitial = initializeBuildQueueState(lockSubject.coordinator, { now: NOW });
  const lockFirst = await persistBuildQueueState({
    root: lockSubject.root,
    coordinator: lockSubject.coordinator,
    state: lockInitial,
  });
  const lockStateBytes = await readFile(lockSubject.absoluteStatePath);
  const lockSuccessor = reconcileBuildQueueState(lockSubject.coordinator, lockInitial, { now: LATER });
  await assert.rejects(
    persistBuildQueueState({
      root: lockSubject.root,
      coordinator: lockSubject.coordinator,
      state: lockSuccessor,
      expectedSnapshot: lockFirst.snapshot,
      persistenceFaultInjector: async (checkpoint) => {
        if (checkpoint === 'after_history_append') {
          throw new Error('simulated active-lock pending successor crash');
        }
      },
    }),
    /simulated active-lock pending successor crash/u,
  );
  const lockFresh = recreateCoordinator(lockSubject);
  const lockResume = await hostResumeForBytes(
    lockSubject,
    lockFresh,
    lockInitial,
    lockStateBytes,
    'fresh-pending-active-lock',
  );
  await installWriterLock(
    lockSubject,
    lockFresh,
    process.pid,
    '00000000-0000-4000-8000-000000000002',
  );
  await assert.rejects(
    readPersistedBuildQueueState({
      root: lockSubject.root,
      coordinator: lockFresh,
      resumeAttestation: lockResume,
    }),
    /blocked by an active writer lock/,
  );
  assert.deepEqual(await readFile(lockSubject.absoluteStatePath), lockStateBytes);
  await unlink(`${lockSubject.absoluteStatePath}.lock`);
});

test('persistent successors preserve append-only evidence and attempt prefixes', async () => {
  const evidenceSubject = await fixture();
  const evidenceInitial = initializeBuildQueueState(evidenceSubject.coordinator, { now: NOW });
  const evidenceFirst = await persistBuildQueueState({
    root: evidenceSubject.root,
    coordinator: evidenceSubject.coordinator,
    state: evidenceInitial,
  });
  const waiting = transitionBuildQueueItem(evidenceSubject.coordinator, evidenceInitial, {
    itemId: 'QI-01',
    toStatus: 'waiting_approval',
    evidence: [evidence('E-01')],
    blockers: ['manual_approval_required'],
  }, { now: LATER });
  await persistBuildQueueState({
    root: evidenceSubject.root,
    coordinator: evidenceSubject.coordinator,
    state: waiting,
    expectedSnapshot: evidenceFirst.snapshot,
  });
  const erasedEvidence = structuredClone(waiting);
  erasedEvidence.revision += 1;
  erasedEvidence.items[0].evidence = [];
  const erasedEvidenceBytes = await installForgedHistorySuccessor(
    evidenceSubject,
    evidenceSubject.coordinator,
    erasedEvidence,
  );
  const erasedEvidenceResume = await hostResumeForBytes(
    evidenceSubject,
    evidenceSubject.coordinator,
    erasedEvidence,
    erasedEvidenceBytes,
    'resume-erased-evidence',
  );
  await assert.rejects(
    readPersistedBuildQueueState({
      root: evidenceSubject.root,
      coordinator: evidenceSubject.coordinator,
      resumeAttestation: erasedEvidenceResume,
    }),
    /evidence cannot shrink or fork|not fully covered by its durable revision commitments/,
  );

  const attemptSubject = await fixture();
  const attemptInitial = initializeBuildQueueState(attemptSubject.coordinator, { now: NOW });
  const attemptFirst = await persistBuildQueueState({
    root: attemptSubject.root,
    coordinator: attemptSubject.coordinator,
    state: attemptInitial,
  });
  const running = await startFirstItem(attemptSubject, attemptInitial);
  await persistBuildQueueState({
    root: attemptSubject.root,
    coordinator: attemptSubject.coordinator,
    state: running,
    expectedSnapshot: attemptFirst.snapshot,
  });
  const erasedAttempts = structuredClone(running);
  erasedAttempts.revision += 1;
  erasedAttempts.items[0].status = 'ready';
  erasedAttempts.items[0].attempts = [];
  erasedAttempts.items[0].active_attempt = null;
  erasedAttempts.items[0].result = null;
  const erasedAttemptBytes = await installForgedHistorySuccessor(
    attemptSubject,
    attemptSubject.coordinator,
    erasedAttempts,
  );
  const erasedAttemptResume = await hostResumeForBytes(
    attemptSubject,
    attemptSubject.coordinator,
    erasedAttempts,
    erasedAttemptBytes,
    'resume-erased-attempts',
  );
  await assert.rejects(
    readPersistedBuildQueueState({
      root: attemptSubject.root,
      coordinator: attemptSubject.coordinator,
      resumeAttestation: erasedAttemptResume,
    }),
    /attempts cannot shrink or fork|not fully covered by its durable revision commitments/,
  );
});
