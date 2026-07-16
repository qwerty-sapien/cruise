import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  beginCruiseAction,
  captureProductInventory,
  checkForForeignDiff,
  completeCruiseAction,
  createForeignDiffGuard,
  finalizeForeignDiffGuard,
  foreignDiffAuthorityPath,
  inventoryEntryDigest,
  projectCruiseAction,
  readForeignDiffGuardState,
  resolveForeignDiffIncident,
  writeForeignDiffGuardState,
} from '../scripts/lib/foreign-diff-guard.mjs';
import { canonicalJson, writeYamlFile } from '../scripts/lib/yaml-state.mjs';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function bytesSha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function resignInventory(inventory) {
  inventory.entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  inventory.usage = {
    entries: inventory.entries.filter(({ kind }) => kind !== 'missing').length,
    total_bytes: inventory.entries.reduce((total, { size }) => total + size, 0),
  };
  inventory.sha256 = null;
  const digestValue = structuredClone(inventory);
  delete digestValue.sha256;
  inventory.sha256 = bytesSha256(Buffer.from(canonicalJson(digestValue), 'utf8'));
  return inventory;
}

async function nameRepository(root) {
  await mkdir(join(root, '.cruise'), { recursive: true });
  await writeYamlFile(join(root, '.cruise', 'repo.yaml'), {
    schema_version: 1,
    kind: 'cruise_repository_name',
    name: 'guard-repo',
    repository_root: await realpath(root),
    assigned_by: 'cruise_l1',
    worker_level: 1,
  });
}

async function fixture({ dirty = false, beforeGuard = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cruise-foreign-diff-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'guard-test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Guard Test'], { cwd: root });
  await writeFile(join(root, 'owned.txt'), 'owned baseline\n');
  await writeFile(join(root, 'foreign.txt'), 'foreign baseline\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root });
  if (beforeGuard !== null) await beforeGuard(root);
  if (dirty) {
    await writeFile(join(root, 'foreign.txt'), 'accepted dirty baseline\n');
    await writeFile(join(root, 'untracked.txt'), 'accepted untracked baseline\n');
  }
  await nameRepository(root);
  const statePath = join(root, '.cruise', 'runs', 'run-01', 'drift.yaml');
  await createForeignDiffGuard({
    statePath,
    runId: 'run-01',
    repositoryRoot: root,
    originPromptSha256: DIGEST_A,
    repositoryBaselineDigest: DIGEST_B,
    now: '2026-07-15T00:00:00.000Z',
  });
  return { root, statePath };
}


test('initial dirty and untracked bytes are accepted under automatic monitoring', async () => {
  const { statePath } = await fixture({ dirty: true });
  const active = await readForeignDiffGuardState(statePath);
  assert.equal(active.schema_version, 2);
  assert.equal(active.status, 'monitoring');
  assert.equal(active.checkpoint.inventory.entries.length, 2);
  assert.equal(Object.hasOwn(active, 'permission'), false);
  assert.equal((await checkForForeignDiff({ statePath })).outcome, 'clean');
});

test('host metadata and disposable caches are permanently outside repository monitoring', async () => {
  const { root, statePath } = await fixture({
    beforeGuard: async (repository) => {
      await mkdir(join(repository, 'pkg', '__pycache__'), { recursive: true });
      await writeFile(join(repository, '.DS_Store'), 'tracked host metadata\n');
      await writeFile(join(repository, 'pkg', '__pycache__', 'module.pyc'), 'tracked cache\n');
      execFileSync('git', ['add', '-f', '.DS_Store', 'pkg/__pycache__/module.pyc'], { cwd: repository });
      execFileSync('git', ['commit', '-qm', 'tracked non-product fixtures'], { cwd: repository });
    },
  });
  const baseline = await readForeignDiffGuardState(statePath);
  assert.equal(baseline.checkpoint.inventory.entries.some(({ path }) => path === '.DS_Store'), false);
  assert.equal(
    baseline.checkpoint.inventory.tracked_physical.some(({ path }) => path.includes('__pycache__')),
    false,
  );

  await mkdir(join(root, 'pkg', '__pycache__'), { recursive: true });
  await writeFile(join(root, '.DS_Store'), 'changed host metadata with a different size\n');
  await writeFile(join(root, 'pkg', '__pycache__', 'module.pyc'), 'changed cache bytes\n');
  await mkdir(join(root, 'nested', '.pytest_cache'), { recursive: true });
  await writeFile(join(root, 'nested', '.pytest_cache', 'state'), 'new cache\n');

  assert.equal((await checkForForeignDiff({ statePath })).outcome, 'clean');
  await assert.rejects(lstat(join(root, '.DS_Store')), /ENOENT/u);
  await assert.rejects(lstat(join(root, 'pkg', '__pycache__')), /ENOENT/u);
  await assert.rejects(lstat(join(root, 'nested', '.pytest_cache')), /ENOENT/u);
  const current = captureProductInventory(root);
  assert.equal(current.entries.some(({ path }) => path.includes('__pycache__')), false);
  assert.equal(current.entries.some(({ path }) => path.includes('.pytest_cache')), false);
});

test('non-Git tree monitoring applies the same product-scope boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-foreign-tree-'));
  await mkdir(join(root, 'pkg', '__pycache__'), { recursive: true });
  await writeFile(join(root, 'app.txt'), 'product baseline\n');
  await writeFile(join(root, '.DS_Store'), 'host metadata\n');
  await writeFile(join(root, 'pkg', '__pycache__', 'module.pyc'), 'cache\n');
  await nameRepository(root);
  const statePath = join(root, '.cruise', 'runs', 'run-tree', 'drift.yaml');
  await createForeignDiffGuard({
    statePath,
    runId: 'run-tree',
    repositoryRoot: root,
    originPromptSha256: DIGEST_A,
    repositoryBaselineDigest: DIGEST_B,
  });

  await mkdir(join(root, 'pkg', '__pycache__'), { recursive: true });
  await writeFile(join(root, '.DS_Store'), 'changed metadata of another size\n');
  await writeFile(join(root, 'pkg', '__pycache__', 'module.pyc'), 'changed cache\n');
  assert.equal((await checkForForeignDiff({ statePath })).outcome, 'clean');
  await assert.rejects(lstat(join(root, '.DS_Store')), /ENOENT/u);
  await assert.rejects(lstat(join(root, 'pkg', '__pycache__')), /ENOENT/u);

  await writeFile(join(root, 'app.txt'), 'real product change\n');
  const detected = await checkForForeignDiff({ statePath });
  assert.equal(detected.outcome, 'waiting_user');
  assert.deepEqual(detected.incident.foreign_paths, ['app.txt']);
});

test('legacy noise-only incidents are cleared automatically when persisted state is read', async () => {
  const { root, statePath } = await fixture();
  const state = structuredClone(await readForeignDiffGuardState(statePath));
  const legacyEntry = (contents) => ({
    path: '.DS_Store',
    kind: 'file',
    mode: 0o644,
    size: Buffer.byteLength(contents),
    sha256: bytesSha256(Buffer.from(contents)),
    worktree_changed: true,
    index_changed: false,
    untracked: true,
    index: [],
  });
  const prior = resignInventory({
    ...structuredClone(state.checkpoint.inventory),
    entries: [...state.checkpoint.inventory.entries, legacyEntry('old metadata\n')],
  });
  const observed = resignInventory({
    ...structuredClone(state.checkpoint.inventory),
    entries: [...state.checkpoint.inventory.entries, legacyEntry('new metadata bytes\n')],
  });
  const at = '2026-07-15T00:00:01.000Z';
  const beforeEntry = prior.entries.find(({ path }) => path === '.DS_Store');
  const currentEntry = observed.entries.find(({ path }) => path === '.DS_Store');
  state.checkpoint.inventory = prior;
  state.status = 'waiting_user';
  state.active_incident = {
    incident_id: 'FD-001',
    action_id: null,
    status: 'waiting_user',
    observed_at: at,
    prior_inventory_sha256: prior.sha256,
    observed_inventory_sha256: observed.sha256,
    paths: [{
      path: '.DS_Store',
      before_kind: 'file',
      before_sha256: inventoryEntryDigest(beforeEntry),
      current_kind: 'file',
      current_sha256: inventoryEntryDigest(currentEntry),
      attribution: 'foreign_or_ambiguous',
      reason: 'no exact current-run action receipt matched',
    }],
    action_mismatch_paths: [],
    foreign_paths: ['.DS_Store'],
    accepted_agent_paths: [],
    observed_inventory: observed,
  };
  state.next_incident = 2;
  state.updated_at = at;
  state.history.push({
    sequence: state.history.length + 1,
    action: 'foreign_diff_detected',
    at,
    incident_id: 'FD-001',
    foreign_path_count: 1,
    observed_inventory_sha256: observed.sha256,
  });
  await writeForeignDiffGuardState(statePath, state);
  await writeFile(join(root, '.DS_Store'), 'new metadata bytes\n');

  const migrated = await readForeignDiffGuardState(statePath);
  assert.equal(migrated.status, 'monitoring');
  assert.equal(migrated.active_incident, null);
  assert.deepEqual(migrated.incidents, []);
  assert.equal(migrated.history.some(({ action }) => action === 'foreign_diff_detected'), false);
  assert.equal((await readFile(statePath, 'utf8')).includes('.DS_Store'), false);
  await assert.rejects(lstat(join(root, '.DS_Store')), /ENOENT/u);
  assert.equal((await checkForForeignDiff({ statePath })).outcome, 'clean');
});

test('legacy resolved noise incidents and their history entries are erased', async () => {
  const { statePath } = await fixture();
  const state = structuredClone(await readForeignDiffGuardState(statePath));
  const at = '2026-07-15T00:00:01.000Z';
  state.incidents.push({
    incident_id: 'FD-001',
    action_id: null,
    observed_at: at,
    observed_inventory_sha256: state.checkpoint.inventory.sha256,
    foreign_paths: ['.DS_Store'],
    accepted_agent_paths: [],
    resolution: {
      selection: 'preserve_and_continue',
      decision_id: 'D-02',
      at,
      outcome: 'preserved',
      error: null,
    },
  });
  state.next_incident = 2;
  state.updated_at = at;
  state.history.push({
    sequence: state.history.length + 1,
    action: 'foreign_diff_detected',
    at,
    incident_id: 'FD-001',
    foreign_path_count: 1,
    observed_inventory_sha256: state.checkpoint.inventory.sha256,
  });
  state.history.push({
    sequence: state.history.length + 1,
    action: 'incident_preserved',
    at,
    incident_id: 'FD-001',
    decision_id: 'D-02',
    inventory_sha256: state.checkpoint.inventory.sha256,
  });
  await writeForeignDiffGuardState(statePath, state);

  const migrated = await readForeignDiffGuardState(statePath);
  assert.deepEqual(migrated.incidents, []);
  assert.equal(migrated.history.some(({ incident_id: incidentId }) => incidentId === 'FD-001'), false);
  assert.equal(migrated.next_incident, 1);
});

test('a coherent workspace mirror rewrite cannot alter host-owned authority', async () => {
  const { statePath } = await fixture();
  const forged = await readForeignDiffGuardState(statePath);
  const at = '2026-07-15T00:00:09.000Z';
  forged.updated_at = at;
  forged.history.push({
    sequence: forged.history.length + 1,
    action: 'forged_workspace_event',
    at,
  });
  await writeYamlFile(statePath, forged);
  await assert.rejects(readForeignDiffGuardState(statePath), /mirror differs from its host-owned authority/u);
});

test('guard state rejects mirror symlinks and retired permission fields', async () => {
  const first = await fixture();
  const realState = `${first.statePath}.real`;
  await rename(first.statePath, realState);
  await symlink(realState, first.statePath);
  await assert.rejects(readForeignDiffGuardState(first.statePath), /bounded regular file/u);

  const second = await fixture();
  const state = await readForeignDiffGuardState(second.statePath);
  state.permission = { selection: 'preserve_only' };
  await writeYamlFile(second.statePath, state);
  await assert.rejects(readForeignDiffGuardState(second.statePath), /must contain exactly/u);
});

test('an unexplained diff pauses without changing bytes and intentional resolution adopts it without authorship', async () => {
  const { root, statePath } = await fixture();
  await writeFile(join(root, 'foreign.txt'), 'user edit\n');

  const detected = await checkForForeignDiff({
    statePath,
    now: '2026-07-15T00:00:02.000Z',
  });
  assert.equal(detected.outcome, 'waiting_user');
  assert.deepEqual(detected.incident.foreign_paths, ['foreign.txt']);
  assert.equal(await readFile(join(root, 'foreign.txt'), 'utf8'), 'user edit\n');
  await assert.rejects(checkForForeignDiff({ statePath }), /workers and writes remain paused/u);

  const resolved = await resolveForeignDiffIncident({
    statePath,
    incidentId: detected.incident.incident_id,
    decisionId: 'D-02',
    selection: 'preserve_and_continue',
    now: '2026-07-15T00:00:03.000Z',
  });
  assert.equal(resolved.outcome, 'preserved');
  assert.equal(await readFile(join(root, 'foreign.txt'), 'utf8'), 'user edit\n');
  assert.equal((await checkForForeignDiff({ statePath })).outcome, 'clean');
  assert.equal(resolved.state.incidents[0].resolution.outcome, 'preserved');
});

test('pure action projection derives tracked edits, tracked deletion, untracked files, and symlinks without touching product bytes', async () => {
  const { root, statePath } = await fixture();
  const ownedBefore = await readFile(join(root, 'owned.txt'));
  const foreignBefore = await readFile(join(root, 'foreign.txt'));
  const guardBefore = await readFile(statePath);
  const mode = (await lstat(join(root, 'owned.txt'))).mode & 0o7777;
  const action = await projectCruiseAction({
    statePath,
    actionId: 'A-PROJECT',
    changes: [
      { path: 'owned.txt', kind: 'file', mode, bytes: Buffer.from('projected edit\n') },
      { path: 'new.txt', kind: 'file', mode: 0o640, bytes: Buffer.from('projected new\n') },
      { path: 'new-link', kind: 'symlink', mode: 0o777, bytes: Buffer.from('owned.txt') },
      { path: 'foreign.txt', kind: 'missing', mode: null, bytes: null },
    ],
  });

  assert.equal(action.kind, 'cruise_change_action');
  assert.deepEqual(action.owned_paths, ['foreign.txt', 'new-link', 'new.txt', 'owned.txt']);
  const expected = new Map(action.expected_changes.map((change) => [change.path, change]));
  assert.equal(expected.get('owned.txt').after_size, Buffer.byteLength('projected edit\n'));
  assert.equal(expected.get('owned.txt').after_inventory_sha256 !== null, true);
  assert.equal(expected.get('new.txt').after_inventory_sha256 !== null, true);
  assert.equal(expected.get('new-link').after_kind, 'symlink');
  assert.equal(expected.get('new-link').after_size, Buffer.byteLength('owned.txt'));
  assert.equal(expected.get('foreign.txt').after_kind, 'missing');
  assert.equal(expected.get('foreign.txt').after_size, 0);
  assert.equal(expected.get('foreign.txt').after_inventory_sha256 !== null, true);

  assert.deepEqual(await readFile(join(root, 'owned.txt')), ownedBefore);
  assert.deepEqual(await readFile(join(root, 'foreign.txt')), foreignBefore);
  assert.deepEqual(await readFile(statePath), guardBefore);
  await assert.rejects(lstat(join(root, 'new.txt')), /ENOENT/u);
  await assert.rejects(lstat(join(root, 'new-link')), /ENOENT/u);
  assert.equal((await checkForForeignDiff({ statePath })).outcome, 'clean');
});

test('pure action projection emits null inventory digests for dirty-to-clean and untracked-to-missing results', async () => {
  const { root, statePath } = await fixture({ dirty: true });
  const dirtyBefore = await readFile(join(root, 'foreign.txt'));
  const untrackedBefore = await readFile(join(root, 'untracked.txt'));
  const mode = (await lstat(join(root, 'foreign.txt'))).mode & 0o7777;
  const action = await projectCruiseAction({
    statePath,
    actionId: 'A-CLEAN',
    changes: [
      { path: 'foreign.txt', kind: 'file', mode, bytes: Buffer.from('foreign baseline\n') },
      { path: 'untracked.txt', kind: 'missing', mode: null, bytes: null },
    ],
  });

  assert.equal(action.expected_changes[0].path, 'foreign.txt');
  assert.equal(action.expected_changes[0].after_inventory_sha256, null);
  assert.equal(action.expected_changes[1].path, 'untracked.txt');
  assert.equal(action.expected_changes[1].after_inventory_sha256, null);
  assert.deepEqual(await readFile(join(root, 'foreign.txt')), dirtyBefore);
  assert.deepEqual(await readFile(join(root, 'untracked.txt')), untrackedBefore);
});

test('a projected dirty-entry disappearance opens and closes as a normal action', async () => {
  const { root, statePath } = await fixture({ dirty: true });
  const mode = (await lstat(join(root, 'foreign.txt'))).mode & 0o7777;
  const action = await projectCruiseAction({
    statePath,
    actionId: 'A-DISAPPEAR',
    changes: [
      { path: 'foreign.txt', kind: 'file', mode, bytes: Buffer.from('foreign baseline\n') },
      { path: 'untracked.txt', kind: 'missing', mode: null, bytes: null },
    ],
  });
  const opened = await beginCruiseAction({
    statePath,
    actionId: action.action_id,
    ownedPaths: action.owned_paths,
    expectedChanges: action.expected_changes,
  });
  assert.equal(opened.outcome, 'action_open');
  await writeFile(join(root, 'foreign.txt'), 'foreign baseline\n');
  await unlink(join(root, 'untracked.txt'));
  const completed = await completeCruiseAction({
    statePath,
    receipt: {
      schema_version: 1,
      kind: 'cruise_change_receipt',
      action_id: action.action_id,
      changes: action.expected_changes.map((change) => ({
        path: change.path,
        before_sha256: change.before_sha256,
        after_sha256: change.after_inventory_sha256,
      })),
    },
  });
  assert.equal(completed.outcome, 'accepted');
  assert.equal((await checkForForeignDiff({ statePath })).outcome, 'clean');
});

test('pure action projection rejects ignored index-absent paths but permits tracked paths matched by ignore policy', async () => {
  const { root, statePath } = await fixture({
    beforeGuard: async (repository) => {
      await mkdir(join(repository, 'internal'));
      await writeFile(join(repository, 'internal', 'tracked.txt'), 'tracked baseline\n');
      await writeFile(join(repository, '.gitignore'), '*internal/*\nignored.txt\n');
      execFileSync('git', ['add', '-f', 'internal/tracked.txt', '.gitignore'], { cwd: repository });
      execFileSync('git', ['commit', '-qm', 'tracked ignored-path fixture'], { cwd: repository });
    },
  });

  await assert.rejects(
    projectCruiseAction({
      statePath,
      actionId: 'A-IGNORED',
      changes: [{ path: 'ignored.txt', kind: 'file', mode: 0o644, bytes: Buffer.from('hidden\n') }],
    }),
    /ignored path cannot be projected safely/u,
  );
  const tracked = await projectCruiseAction({
    statePath,
    actionId: 'A-TRACKED-IGNORED',
    changes: [{
      path: 'internal/tracked.txt',
      kind: 'file',
      mode: 0o644,
      bytes: Buffer.from('visible tracked edit\n'),
    }],
  });
  assert.equal(tracked.expected_changes[0].after_inventory_sha256 !== null, true);
  assert.equal(await readFile(join(root, 'internal', 'tracked.txt'), 'utf8'), 'tracked baseline\n');
  await assert.rejects(lstat(join(root, 'ignored.txt')), /ENOENT/u);
});

test('pure action projection rejects stale checkpoints, filters, unsafe parents, and directory-ledger changes without writes', async () => {
  const stale = await fixture();
  await writeFile(join(stale.root, 'foreign.txt'), 'foreign drift\n');
  await assert.rejects(
    projectCruiseAction({
      statePath: stale.statePath,
      actionId: 'A-STALE',
      changes: [{ path: 'owned.txt', kind: 'file', mode: 0o644, bytes: Buffer.from('edit\n') }],
    }),
    /drifted from the state-bound checkpoint/u,
  );
  assert.equal(await readFile(join(stale.root, 'foreign.txt'), 'utf8'), 'foreign drift\n');
  assert.equal(await readFile(join(stale.root, 'owned.txt'), 'utf8'), 'owned baseline\n');

  const filtered = await fixture({
    beforeGuard: async (repository) => {
      await writeFile(join(repository, '.gitattributes'), '*.flt filter=projection-test\n');
      execFileSync('git', ['add', '.gitattributes'], { cwd: repository });
      execFileSync('git', ['commit', '-qm', 'filter fixture'], { cwd: repository });
    },
  });
  await assert.rejects(
    projectCruiseAction({
      statePath: filtered.statePath,
      actionId: 'A-FILTER',
      changes: [{ path: 'new.flt', kind: 'file', mode: 0o644, bytes: Buffer.from('filtered\n') }],
    }),
    /content transform filter=projection-test/u,
  );
  await assert.rejects(lstat(join(filtered.root, 'new.flt')), /ENOENT/u);

  const unsafe = await fixture({
    beforeGuard: async (repository) => {
      await mkdir(join(repository, 'real-parent'));
      await symlink('real-parent', join(repository, 'linked-parent'));
    },
  });
  await assert.rejects(
    projectCruiseAction({
      statePath: unsafe.statePath,
      actionId: 'A-UNSAFE',
      changes: [{ path: 'linked-parent/new.txt', kind: 'file', mode: 0o644, bytes: Buffer.from('unsafe\n') }],
    }),
    /projection parent is unsafe/u,
  );
  await assert.rejects(lstat(join(unsafe.root, 'real-parent', 'new.txt')), /ENOENT/u);

  const directory = await fixture({
    beforeGuard: async (repository) => mkdir(join(repository, 'empty-parent')),
  });
  await assert.rejects(
    projectCruiseAction({
      statePath: directory.statePath,
      actionId: 'A-DIRECTORY',
      changes: [{ path: 'empty-parent/new.txt', kind: 'file', mode: 0o644, bytes: Buffer.from('new\n') }],
    }),
    /change the guarded directory-metadata ledger/u,
  );
  await assert.rejects(lstat(join(directory.root, 'empty-parent', 'new.txt')), /ENOENT/u);
});

test('an exact action receipt advances the checkpoint but an outside write becomes a foreign incident', async () => {
  const { root, statePath } = await fixture();
  const ownedMode = (await lstat(join(root, 'owned.txt'))).mode & 0o7777;
  await writeFile(join(root, 'owned.txt'), 'agent edit\n');
  const projectedFirst = captureProductInventory(root).entries.find((entry) => entry.path === 'owned.txt');
  await writeFile(join(root, 'owned.txt'), 'owned baseline\n');
  await beginCruiseAction({
    statePath,
    actionId: 'A-01',
    ownedPaths: ['owned.txt'],
    expectedChanges: [{
      path: 'owned.txt',
      before_sha256: null,
      after_kind: 'file',
      after_mode: ownedMode,
      after_size: Buffer.byteLength('agent edit\n'),
      after_sha256: bytesSha256('agent edit\n'),
      after_inventory_sha256: inventoryEntryDigest(projectedFirst),
    }],
  });
  await writeFile(join(root, 'owned.txt'), 'agent edit\n');
  const changed = captureProductInventory(root);
  const owned = changed.entries.find((entry) => entry.path === 'owned.txt');
  const accepted = await completeCruiseAction({
    statePath,
    receipt: {
      schema_version: 1,
      kind: 'cruise_change_receipt',
      action_id: 'A-01',
      changes: [{ path: 'owned.txt', before_sha256: null, after_sha256: inventoryEntryDigest(owned) }],
    },
  });
  assert.equal(accepted.outcome, 'accepted');

  const beforeOwned = accepted.inventory.entries.find((entry) => entry.path === 'owned.txt');
  await writeFile(join(root, 'owned.txt'), 'second agent edit\n');
  const projectedSecond = captureProductInventory(root).entries.find((entry) => entry.path === 'owned.txt');
  await writeFile(join(root, 'owned.txt'), 'agent edit\n');
  await beginCruiseAction({
    statePath,
    actionId: 'A-02',
    ownedPaths: ['owned.txt'],
    expectedChanges: [{
      path: 'owned.txt',
      before_sha256: inventoryEntryDigest(beforeOwned),
      after_kind: 'file',
      after_mode: ownedMode,
      after_size: Buffer.byteLength('second agent edit\n'),
      after_sha256: bytesSha256('second agent edit\n'),
      after_inventory_sha256: inventoryEntryDigest(projectedSecond),
    }],
  });
  await writeFile(join(root, 'owned.txt'), 'second agent edit\n');
  await writeFile(join(root, 'foreign.txt'), 'concurrent user edit\n');
  const observed = captureProductInventory(root);
  const afterOwned = observed.entries.find((entry) => entry.path === 'owned.txt');
  const paused = await completeCruiseAction({
    statePath,
    receipt: {
      schema_version: 1,
      kind: 'cruise_change_receipt',
      action_id: 'A-02',
      changes: [{
        path: 'owned.txt',
        before_sha256: inventoryEntryDigest(beforeOwned),
        after_sha256: inventoryEntryDigest(afterOwned),
      }],
    },
  });
  assert.equal(paused.outcome, 'waiting_user');
  assert.deepEqual(paused.incident.accepted_agent_paths, ['owned.txt']);
  assert.deepEqual(paused.incident.foreign_paths, ['foreign.txt']);
});

test('an undeclared Git index mutation cannot be attributed from a post-hoc receipt', async () => {
  const { root, statePath } = await fixture();
  const mode = (await lstat(join(root, 'owned.txt'))).mode & 0o7777;
  await writeFile(join(root, 'owned.txt'), 'declared physical result\n');
  const projected = captureProductInventory(root).entries.find((entry) => entry.path === 'owned.txt');
  await writeFile(join(root, 'owned.txt'), 'owned baseline\n');
  await beginCruiseAction({
    statePath,
    actionId: 'A-INDEX',
    ownedPaths: ['owned.txt'],
    expectedChanges: [{
      path: 'owned.txt',
      before_sha256: null,
      after_kind: 'file',
      after_mode: mode,
      after_size: Buffer.byteLength('declared physical result\n'),
      after_sha256: bytesSha256('declared physical result\n'),
      after_inventory_sha256: inventoryEntryDigest(projected),
    }],
  });
  await writeFile(join(root, 'owned.txt'), 'declared physical result\n');
  execFileSync('git', ['add', 'owned.txt'], { cwd: root });
  const staged = captureProductInventory(root).entries.find((entry) => entry.path === 'owned.txt');
  const result = await completeCruiseAction({
    statePath,
    receipt: {
      schema_version: 1,
      kind: 'cruise_change_receipt',
      action_id: 'A-INDEX',
      changes: [{
        path: 'owned.txt',
        before_sha256: null,
        after_sha256: inventoryEntryDigest(staged),
      }],
    },
  });
  assert.equal(result.outcome, 'waiting_user');
  assert.deepEqual(result.incident.accepted_agent_paths, []);
  assert.deepEqual(result.incident.foreign_paths, ['owned.txt']);
});

test('action completion binds the exact projected physical size', async () => {
  const { root, statePath } = await fixture();
  const mode = (await lstat(join(root, 'owned.txt'))).mode & 0o7777;
  const action = await projectCruiseAction({
    statePath,
    actionId: 'A-SIZE',
    changes: [{ path: 'owned.txt', kind: 'file', mode, bytes: Buffer.from('sized result\n') }],
  });
  const forged = structuredClone(action);
  forged.expected_changes[0].after_size += 1;
  await beginCruiseAction({
    statePath,
    actionId: forged.action_id,
    ownedPaths: forged.owned_paths,
    expectedChanges: forged.expected_changes,
  });
  await writeFile(join(root, 'owned.txt'), 'sized result\n');
  const result = await completeCruiseAction({
    statePath,
    receipt: {
      schema_version: 1,
      kind: 'cruise_change_receipt',
      action_id: forged.action_id,
      changes: [{
        path: 'owned.txt',
        before_sha256: forged.expected_changes[0].before_sha256,
        after_sha256: forged.expected_changes[0].after_inventory_sha256,
      }],
    },
  });
  assert.equal(result.outcome, 'waiting_user');
  assert.deepEqual(result.incident.accepted_agent_paths, []);
  assert.deepEqual(result.incident.foreign_paths, ['owned.txt']);
});

test('a predeclared result that never appears pauses as an action mismatch', async () => {
  const { root, statePath } = await fixture();
  const mode = (await lstat(join(root, 'owned.txt'))).mode & 0o7777;
  await writeFile(join(root, 'owned.txt'), 'expected but absent\n');
  const projected = captureProductInventory(root).entries.find((entry) => entry.path === 'owned.txt');
  await writeFile(join(root, 'owned.txt'), 'owned baseline\n');
  await beginCruiseAction({
    statePath,
    actionId: 'A-ABSENT',
    ownedPaths: ['owned.txt'],
    expectedChanges: [{
      path: 'owned.txt',
      before_sha256: null,
      after_kind: 'file',
      after_mode: mode,
      after_size: Buffer.byteLength('expected but absent\n'),
      after_sha256: bytesSha256('expected but absent\n'),
      after_inventory_sha256: inventoryEntryDigest(projected),
    }],
  });
  const result = await completeCruiseAction({
    statePath,
    receipt: {
      schema_version: 1,
      kind: 'cruise_change_receipt',
      action_id: 'A-ABSENT',
      changes: [{
        path: 'owned.txt',
        before_sha256: null,
        after_sha256: inventoryEntryDigest(projected),
      }],
    },
  });
  assert.equal(result.outcome, 'waiting_user');
  assert.deepEqual(result.incident.action_mismatch_paths, ['owned.txt']);
  assert.deepEqual(result.incident.foreign_paths, ['owned.txt']);
  assert.equal((await readForeignDiffGuardState(statePath)).status, 'waiting_user');
});

test('Git ignore-policy drift is detected even when it hides the new product path', async () => {
  const { root, statePath } = await fixture();
  const excludePath = execFileSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'],
    { cwd: root, encoding: 'utf8' },
  ).trim();
  const prior = await readFile(excludePath, 'utf8');
  await writeFile(excludePath, `${prior}\nhidden-by-new-policy/**\n`);
  await mkdir(join(root, 'hidden-by-new-policy'));
  await writeFile(join(root, 'hidden-by-new-policy', 'secret.txt'), 'intent remains unknown\n');
  const detected = await checkForForeignDiff({ statePath });
  assert.equal(detected.outcome, 'waiting_user');
  assert.deepEqual(detected.incident.foreign_paths, ['/.cruise-meta/git/ignore-policy']);
  assert.equal(
    await readFile(join(root, 'hidden-by-new-policy', 'secret.txt'), 'utf8'),
    'intent remains unknown\n',
  );
});

test('exact tracked physical mode drift pauses even when Git considers the file clean', async () => {
  const { root, statePath } = await fixture();
  const priorMode = (await lstat(join(root, 'owned.txt'))).mode & 0o7777;
  const changedMode = priorMode === 0o600 ? 0o640 : 0o600;
  await chmod(join(root, 'owned.txt'), changedMode);

  const detected = await checkForForeignDiff({ statePath });
  assert.equal(detected.outcome, 'waiting_user');
  assert.deepEqual(detected.incident.foreign_paths, ['owned.txt']);
  assert.equal(detected.incident.paths[0].before_kind, 'file');
  assert.equal(detected.incident.paths[0].current_kind, 'file');
  assert.equal((await lstat(join(root, 'owned.txt'))).mode & 0o7777, changedMode);
});

test('retired exact-restore resolution is rejected and leaves incident bytes untouched', async () => {
  const { root, statePath } = await fixture();
  await writeFile(join(root, 'foreign.txt'), 'foreign edit\n');
  const detected = await checkForForeignDiff({ statePath });

  await assert.rejects(
    resolveForeignDiffIncident({
      statePath,
      incidentId: detected.incident.incident_id,
      decisionId: 'D-02',
      selection: 'restore_exact_changes',
    }),
    /resolution selection is invalid/u,
  );
  assert.equal(await readFile(join(root, 'foreign.txt'), 'utf8'), 'foreign edit\n');
  assert.equal((await readForeignDiffGuardState(statePath)).status, 'waiting_user');
});

test('dirty submodules fail closed instead of hiding nested byte changes', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'cruise-submodule-parent-'));
  const child = await mkdtemp(join(tmpdir(), 'cruise-submodule-child-'));
  for (const root of [parent, child]) {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'guard-test@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Guard Test'], { cwd: root });
  }
  await writeFile(join(child, 'nested.txt'), 'baseline\n');
  execFileSync('git', ['add', '.'], { cwd: child });
  execFileSync('git', ['commit', '-qm', 'child baseline'], { cwd: child });
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'sub'], { cwd: parent });
  execFileSync('git', ['config', '-f', '.gitmodules', 'submodule.sub.ignore', 'all'], { cwd: parent });
  execFileSync('git', ['config', 'diff.ignoreSubmodules', 'all'], { cwd: parent });
  execFileSync('git', ['commit', '-qam', 'parent baseline'], { cwd: parent });
  await nameRepository(parent);
  const statePath = join(parent, '.cruise', 'runs', 'run-01', 'drift.yaml');
  await createForeignDiffGuard({
    statePath,
    runId: 'run-01',
    repositoryRoot: parent,
    originPromptSha256: DIGEST_A,
    repositoryBaselineDigest: DIGEST_B,
  });
  await writeFile(join(parent, 'sub', 'nested.txt'), 'dirty one\n');
  await assert.rejects(checkForForeignDiff({ statePath }), /dirty submodule state cannot be inventoried safely/u);
  const blocked = await readForeignDiffGuardState(statePath);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.block.code, 'CRUISE_FOREIGN_DIFF_DIRTY_SUBMODULE');
});

test('directory metadata changes pause as real drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-directory-mode-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'guard-test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Guard Test'], { cwd: root });
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'tracked.txt'), 'baseline\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root });
  await nameRepository(root);
  const statePath = join(root, '.cruise', 'runs', 'run-01', 'drift.yaml');
  await createForeignDiffGuard({
    statePath,
    runId: 'run-01',
    repositoryRoot: root,
    originPromptSha256: DIGEST_A,
    repositoryBaselineDigest: DIGEST_B,
  });
  await chmod(join(root, 'src'), 0o500);
  try {
    const detected = await checkForForeignDiff({ statePath });
    assert.equal(detected.outcome, 'waiting_user');
    assert.deepEqual(detected.incident.foreign_paths, ['/.cruise-meta/fs/directories']);
  } finally {
    await chmod(join(root, 'src'), 0o700);
  }
});

test('verified terminal finalization stops only a clean exactly-bound guard', async () => {
  const finalized = await fixture();
  const checkpoint = (await readForeignDiffGuardState(finalized.statePath)).checkpoint.inventory;

  await assert.rejects(
    finalizeForeignDiffGuard({
      statePath: finalized.statePath,
      expectedInventorySha256: DIGEST_A,
    }),
    { code: 'CRUISE_FOREIGN_DIFF_FINALIZE_STALE' },
  );
  const result = await finalizeForeignDiffGuard({
    statePath: finalized.statePath,
    expectedInventorySha256: checkpoint.sha256,
  });
  assert.equal(result.outcome, 'finalized');
  assert.equal(result.state.status, 'stopped');
  assert.equal(result.state.history.at(-1).action, 'guard_finalized');
  assert.equal(
    (await finalizeForeignDiffGuard({
      statePath: finalized.statePath,
      expectedInventorySha256: checkpoint.sha256,
    })).outcome,
    'already_finalized',
  );

  const dirty = await fixture();
  const dirtyCheckpoint = (await readForeignDiffGuardState(dirty.statePath)).checkpoint.inventory;
  await writeFile(join(dirty.root, 'foreign.txt'), 'changed before finalize\n');
  await assert.rejects(
    finalizeForeignDiffGuard({
      statePath: dirty.statePath,
      expectedInventorySha256: dirtyCheckpoint.sha256,
    }),
    { code: 'CRUISE_FOREIGN_DIFF_FINALIZE_DIRTY' },
  );
  assert.equal(await readFile(join(dirty.root, 'foreign.txt'), 'utf8'), 'changed before finalize\n');
  assert.equal((await readForeignDiffGuardState(dirty.statePath)).status, 'monitoring');
});

test('authority placement fails closed when the host temp root is inside the repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-authority-boundary-'));
  const nestedTemp = join(root, 'host-temp');
  await mkdir(nestedTemp);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = nestedTemp;
  try {
    assert.throws(
      () => foreignDiffAuthorityPath(root, 'run-01'),
      /authority root must be outside the product repository/u,
    );
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
});

test('the guard implementation contains no blanket Git cleanup command', async () => {
  const source = await readFile(resolve('scripts/lib/foreign-diff-guard.mjs'), 'utf8');
  assert.doesNotMatch(source, /\['(?:reset|checkout|restore|clean|stash)'/u);
});
