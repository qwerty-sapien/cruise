import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  USER_CHANGELOG_FILE,
  USER_REFERENCE_FILE,
  MAX_CHANGE_SUMMARY_LENGTH,
  prepareCommitChangelogUpdate,
  userGoalStatus,
  writeUserChangelog,
  writeGoalUserDocuments,
} from '../scripts/lib/user-reference.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function goalPlan(outcome = 'Deliver the user document lifecycle') {
  return {
    version: 2,
    status: 'complete',
    outcome,
    verify: ['node --test tests/user-reference.test.mjs'],
    scope: {
      touchpoints: ['scripts/lib/user-reference.mjs'],
      nonGoals: ['Do not read user-only documents'],
    },
    invariants: ['Existing user prose remains byte-for-byte intact'],
    quality: {
      gates: [{
        id: 'core.functional',
        dimension: 'functional-correctness',
        criterion: 'The deterministic writer produces the expected documents',
        state: 'passed',
        evidence: { summary: 'Focused behavior passed' },
      }],
    },
    body: '# Goal detail\n\nKeep this user-visible explanation.',
  };
}

async function repository(t, { upstream = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cruise-user-reference-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Cruise Test');
  git(root, 'config', 'user.email', 'cruise@example.test');
  await writeFile(join(root, 'tracked.txt'), 'baseline\n');
  await writeFile(join(root, 'legacy.mjs'), 'export function legacyTask() { return true; }\n');
  git(root, 'add', 'tracked.txt', 'legacy.mjs');
  git(root, 'commit', '-m', 'baseline');
  if (upstream) {
    const remote = await mkdtemp(join(tmpdir(), 'cruise-user-reference-remote-'));
    t.after(() => rm(remote, { recursive: true, force: true }));
    git(remote, 'init', '--bare');
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'push', '--set-upstream', 'origin', 'main');
  }
  return root;
}

test('Goal outcomes map to the five user-facing lifecycle states', () => {
  assert.equal(userGoalStatus('complete'), 'completed');
  assert.equal(userGoalStatus('blocked'), 'blocked');
  assert.equal(userGoalStatus('interrupted'), 'aborted');
  assert.equal(userGoalStatus('stalled'), 'unfinished');
  assert.equal(userGoalStatus('unassured'), 'unfinished');
  assert.equal(userGoalStatus('complete', { started: false }), 'not_started');
});

test('user references append chronologically and changelog is a concise script-only inferred inventory', async (t) => {
  const root = await repository(t);
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts', 'worker.mjs'), 'export function runWorker() { return 1; }\n');
  git(root, 'add', 'scripts/worker.mjs');
  git(root, 'commit', '-m', 'first local change');
  const firstCommit = git(root, 'rev-parse', 'HEAD');
  const firstUpdate = await prepareCommitChangelogUpdate({ cwd: root, commit: firstCommit });
  await writeUserChangelog({
    cwd: root,
    commit: firstCommit,
    generatedAt: '2026-07-26T01:30:00.000Z',
    commitSummaries: [{
      path: 'scripts/worker.mjs',
      summary: 'Adds the worker execution adapter.',
    }],
    overallSummaries: [{
      path: 'scripts/worker.mjs',
      summary: 'Adds the worker execution adapter.',
    }],
  });
  const firstChangelog = await readFile(join(root, USER_CHANGELOG_FILE), 'utf8');
  const firstSegment = firstChangelog.slice(firstChangelog.indexOf(`<!-- CRUISE:COMMIT:${firstCommit} -->`));
  await writeFile(join(root, 'scripts', 'worker.mjs'), 'export function runWorker() { return 2; }\n');
  await rm(join(root, 'legacy.mjs'));
  await mkdir(join(root, 'tools'));
  await writeFile(join(root, 'tools', 'check.sh'), '#!/bin/sh\nrun_check() { exit 0; }\n');
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'guide.md'), '# Documentation must not appear\n');
  await writeFile(join(root, 'tracked.txt'), 'working tree detail\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'second local change');
  const secondCommit = git(root, 'rev-parse', 'HEAD');

  const inspectPlan = async () => ({ state: 'valid', plan: goalPlan() });
  const commitSummaries = [
    { path: 'legacy.mjs', summary: 'Removes the retired compatibility runner.' },
    { path: 'scripts/worker.mjs', summary: 'Updates the worker return behavior.' },
    { path: 'tools/check.sh', summary: 'x'.repeat(700) },
  ];
  const overallSummaries = [
    { path: 'legacy.mjs', summary: 'Removes the retired compatibility runner.' },
    { path: 'scripts/worker.mjs', summary: 'Adds the worker adapter with its final return behavior.' },
    { path: 'tools/check.sh', summary: 'x'.repeat(700) },
  ];
  await writeUserChangelog({
    cwd: root,
    commit: secondCommit,
    generatedAt: '2026-07-26T02:00:00.000Z',
    commitSummaries,
    overallSummaries,
  });
  await writeGoalUserDocuments({
    cwd: root,
    prompt: 'Implement the requested lifecycle.',
    provider: 'codex',
    status: 'complete',
    startedAt: '2026-07-26T01:00:00.000Z',
    endedAt: '2026-07-26T02:00:00.000Z',
    sessionId: 'session-one',
    tracePointer: '/trace/one.jsonl',
  }, { inspectPlan });
  await writeGoalUserDocuments({
    cwd: root,
    prompt: 'Investigate the remaining blocker.',
    provider: 'claude',
    status: 'blocked',
    startedAt: '2026-07-26T03:00:00.000Z',
    endedAt: '2026-07-26T04:00:00.000Z',
    sessionId: 'session-two',
    reason: 'A user decision is required.',
  }, { inspectPlan });

  const reference = await readFile(join(root, USER_REFERENCE_FILE), 'utf8');
  const changelog = await readFile(join(root, USER_CHANGELOG_FILE), 'utf8');
  assert.ok(reference.indexOf('completed: Deliver the user document lifecycle') <
    reference.indexOf('blocked: Deliver the user document lifecycle'));
  assert.match(reference, /Implement the requested lifecycle/u);
  assert.match(reference, /Investigate the remaining blocker/u);
  assert.match(reference, /session-one/u);
  assert.match(reference, /A user decision is required/u);

  assert.match(changelog, /- legacy\.mjs: delete - Removes the retired compatibility runner\./u);
  assert.match(changelog, /- scripts\/worker\.mjs: new - Adds the worker adapter with its final return behavior\./u);
  assert.match(changelog, /- scripts\/worker\.mjs: patch - Updates the worker return behavior\./u);
  assert.match(changelog, /- tools\/check\.sh: new - x+/u);
  assert.match(changelog, /## Since last push/u);
  assert.match(changelog, new RegExp(`CRUISE:COMMIT:${firstCommit}`, 'u'));
  assert.match(changelog, new RegExp(`CRUISE:COMMIT:${secondCommit}`, 'u'));
  assert.ok(changelog.includes(firstSegment.replace('<!-- CRUISE:COMMIT-HISTORY:END -->\n', '')));
  assert.doesNotMatch(changelog, /docs\/guide\.md|tracked\.txt/u);
  assert.doesNotMatch(changelog, /Aggregate change summary|Exact tracked patch|Status by path|diff --git/u);
  assert.doesNotMatch(changelog, /_FOR_USER_REFERENCE\.md/u);
  assert.doesNotMatch(changelog, /_CHANGELOG\.md/u);
  for (const line of changelog.split('\n').filter((entry) => /^- .*: (?:patch|delete|new) - /u.test(entry))) {
    const summary = line.replace(/^- .*: (?:patch|delete|new) - /u, '');
    assert.ok(summary.length <= MAX_CHANGE_SUMMARY_LENGTH);
  }
});

test('missing upstream is reported truthfully while the detected commit remains visible', async (t) => {
  const root = await repository(t, { upstream: false });
  await writeFile(join(root, 'legacy.mjs'), 'export function replacementTask() { return false; }\n');
  git(root, 'add', 'legacy.mjs');
  git(root, 'commit', '-m', 'local-only change');
  await writeUserChangelog({
    cwd: root,
    commit: git(root, 'rev-parse', 'HEAD'),
    generatedAt: '2026-07-26T02:00:00.000Z',
    commitSummaries: [{
      path: 'legacy.mjs',
      summary: 'Updates the local replacement task.',
    }],
  });
  const changelog = await readFile(join(root, USER_CHANGELOG_FILE), 'utf8');
  assert.match(changelog, /pushed baseline is unavailable/u);
  assert.match(changelog, /- legacy\.mjs: patch - Updates the local replacement task\./u);
  assert.doesNotMatch(changelog, /Baseline source|diff --git/u);
});

test('renames crossing the script boundary use new and delete actions', async (t) => {
  const root = await repository(t, { upstream: false });
  await writeFile(join(root, 'notes.txt'), 'export const promoted = true;\n');
  git(root, 'add', 'notes.txt');
  git(root, 'commit', '-m', 'add non-script source');
  git(root, 'mv', 'notes.txt', 'promoted.mjs');
  git(root, 'mv', 'legacy.mjs', 'legacy.txt');
  git(root, 'commit', '-m', 'cross script boundary');
  const update = await prepareCommitChangelogUpdate({
    cwd: root,
    commit: git(root, 'rev-parse', 'HEAD'),
  });
  assert.deepEqual(update.commitChanges, [
    { path: 'legacy.mjs', action: 'delete' },
    { path: 'promoted.mjs', action: 'new' },
  ]);
});

test('commit-triggered changelog update does not append a Goal reference', async (t) => {
  const root = await repository(t, { upstream: false });
  await writeFile(join(root, 'legacy.mjs'), 'export function changedTask() { return true; }\n');
  git(root, 'add', 'legacy.mjs');
  git(root, 'commit', '-m', 'change legacy task');
  const commit = git(root, 'rev-parse', 'HEAD');
  assert.equal((await writeUserChangelog({
    cwd: root,
    commit,
    generatedAt: '2026-07-26T05:00:00.000Z',
    commitSummaries: [{ path: 'legacy.mjs', summary: 'Changes the legacy task implementation.' }],
  })).endsWith(`/${USER_CHANGELOG_FILE}`), true);
  const changelog = await readFile(join(root, USER_CHANGELOG_FILE), 'utf8');
  assert.match(changelog, /legacy\.mjs: patch - Changes the legacy task implementation\./u);
  await assert.rejects(readFile(join(root, USER_REFERENCE_FILE), 'utf8'), { code: 'ENOENT' });
});

test('aborted and refused work appends only a content-free tombstone', async (t) => {
  const root = await repository(t, { upstream: false });
  await writeGoalUserDocuments({
    cwd: root,
    prompt: 'Rejected recommendation that must not persist.',
    provider: 'codex',
    status: 'aborted',
    endedAt: '2026-07-26T02:00:00.000Z',
    sessionId: 'sensitive-session-label',
    tracePointer: '/trace/pointer.jsonl',
    reason: 'Rejected because of private recommendation details.',
  }, {
    inspectPlan: async () => {
      throw new Error('aborted work must not inspect or serialize Flight');
    },
  });
  const reference = await readFile(join(root, USER_REFERENCE_FILE), 'utf8');
  assert.match(reference, /— aborted/u);
  assert.match(reference, /\/trace\/pointer\.jsonl/u);
  assert.doesNotMatch(reference, /Rejected recommendation/u);
  assert.doesNotMatch(reference, /private recommendation/u);
  assert.doesNotMatch(reference, /sensitive-session-label/u);
  assert.doesNotMatch(reference, /Original request|Goal detail/u);
});

test('write-only reference append refuses a symlink without altering its target', async (t) => {
  const root = await repository(t, { upstream: false });
  const target = join(root, 'target.md');
  await writeFile(target, 'protected user prose\n');
  await symlink(target, join(root, USER_REFERENCE_FILE));
  await assert.rejects(
    writeGoalUserDocuments({
      cwd: root,
      prompt: 'Do not follow the link.',
      provider: 'codex',
      status: 'complete',
      endedAt: '2026-07-26T02:00:00.000Z',
    }, {
      inspectPlan: async () => ({ state: 'valid', plan: goalPlan() }),
    }),
    /symlink|ELOOP|regular file/iu,
  );
  assert.equal(await readFile(target, 'utf8'), 'protected user prose\n');
});

test('reference append is independent from an unsafe changelog target', async (t) => {
  const root = await repository(t, { upstream: false });
  const target = join(root, 'target.md');
  await writeFile(target, 'protected changelog prose\n');
  await symlink(target, join(root, USER_CHANGELOG_FILE));
  await writeGoalUserDocuments({
    cwd: root,
    prompt: 'Record this Goal independently.',
    provider: 'codex',
    status: 'complete',
    endedAt: '2026-07-26T02:00:00.000Z',
  }, {
    inspectPlan: async () => ({ state: 'valid', plan: goalPlan() }),
  });
  assert.equal(await readFile(target, 'utf8'), 'protected changelog prose\n');
  assert.match(await readFile(join(root, USER_REFERENCE_FILE), 'utf8'), /Record this Goal independently/u);
});

test('commit-triggered changelog update refuses a symlink without touching its target', async (t) => {
  const root = await repository(t, { upstream: false });
  const target = join(root, 'target.md');
  await writeFile(target, 'protected changelog prose\n');
  await symlink(target, join(root, USER_CHANGELOG_FILE));
  await writeFile(join(root, 'legacy.mjs'), 'export function changedTask() { return true; }\n');
  git(root, 'add', 'legacy.mjs');
  git(root, 'commit', '-m', 'change legacy task');
  await assert.rejects(writeUserChangelog({
    cwd: root,
    commit: git(root, 'rev-parse', 'HEAD'),
  }), /regular file/iu);
  assert.equal(await readFile(target, 'utf8'), 'protected changelog prose\n');
});
