import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CommitChangelogObserver,
  changelogSummaryTask,
  parseChangelogSummaryOutput,
} from '../scripts/lib/changelog-observer.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), 'cruise-changelog-observer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Cruise Test');
  git(root, 'config', 'user.email', 'cruise@example.test');
  await writeFile(join(root, 'script.mjs'), 'export const value = 1;\n');
  git(root, 'add', 'script.mjs');
  git(root, 'commit', '-m', 'baseline');
  return root;
}

async function commitScript(root, value, subject) {
  await writeFile(join(root, 'script.mjs'), `export const value = ${value};\n`);
  git(root, 'add', 'script.mjs');
  git(root, 'commit', '-m', subject);
  return git(root, 'rev-parse', 'HEAD');
}

function validOutput(update) {
  const summarize = ({ path }) => ({ path, summary: `Summarizes ${path}.` });
  return JSON.stringify({
    version: 1,
    commit: update.commitChanges.map(summarize),
    overall: update.overallChanges.map(summarize),
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate) {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition was not observed');
}

test('worktree edits without a commit launch no worker and write no changelog', async (t) => {
  const root = await repository(t);
  const calls = [];
  const observer = new CommitChangelogObserver({
    cwd: root,
    pollIntervalMs: 60_000,
    async inferSummaries(input) { calls.push(['infer', input]); },
    async writeUpdate(input) { calls.push(['write', input]); },
  });
  await observer.start();
  await writeFile(join(root, 'script.mjs'), 'export const value = 2;\n');
  await observer.stop();
  assert.deepEqual(calls, []);
});

test('a midflight commit starts parallel inference and terminal flush waits for its targeted write', async (t) => {
  const root = await repository(t);
  const inference = deferred();
  const writes = [];
  let workerStarted = false;
  const observer = new CommitChangelogObserver({
    cwd: root,
    pollIntervalMs: 60_000,
    async inferSummaries({ update }) {
      workerStarted = true;
      await inference.promise;
      return validOutput(update);
    },
    async writeUpdate(input) { writes.push(input); },
  });
  await observer.start();
  const commit = await commitScript(root, 2, 'change script');
  await observer.poll();
  await waitFor(() => workerStarted);
  assert.equal(writes.length, 0);
  const stopping = observer.stop();
  let stopped = false;
  stopping.then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  inference.resolve();
  await stopping;
  assert.equal(writes.length, 1);
  assert.equal(writes[0].update.commit, commit);
  assert.equal(writes[0].commitSummaries[0].path, 'script.mjs');
});

test('multiple commits between observations are recorded chronologically once each', async (t) => {
  const root = await repository(t);
  const inferred = [];
  const written = [];
  const observer = new CommitChangelogObserver({
    cwd: root,
    pollIntervalMs: 60_000,
    async inferSummaries({ update }) {
      inferred.push(update.commit);
      return validOutput(update);
    },
    async writeUpdate({ update }) { written.push(update.commit); },
  });
  await observer.start();
  const first = await commitScript(root, 2, 'first');
  const second = await commitScript(root, 3, 'second');
  await observer.poll();
  await observer.poll();
  await observer.stop();
  assert.deepEqual(inferred, [first, second]);
  assert.deepEqual(written, [first, second]);
});

test('the first commit in an unborn repository is observed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-changelog-observer-unborn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Cruise Test');
  git(root, 'config', 'user.email', 'cruise@example.test');
  const written = [];
  const observer = new CommitChangelogObserver({
    cwd: root,
    pollIntervalMs: 60_000,
    async inferSummaries({ update }) { return validOutput(update); },
    async writeUpdate({ update }) { written.push(update.commit); },
  });
  await observer.start();
  await writeFile(join(root, 'script.mjs'), 'export const value = 1;\n');
  git(root, 'add', 'script.mjs');
  git(root, 'commit', '-m', 'first commit');
  const first = git(root, 'rev-parse', 'HEAD');
  await observer.stop();
  assert.deepEqual(written, [first]);
});

test('an amended commit is recorded while checkout and reset remain excluded', async (t) => {
  const root = await repository(t);
  const written = [];
  const observer = new CommitChangelogObserver({
    cwd: root,
    pollIntervalMs: 60_000,
    async inferSummaries({ update }) { return validOutput(update); },
    async writeUpdate({ update }) { written.push(update.commit); },
  });
  await observer.start();
  await writeFile(join(root, 'script.mjs'), 'export const value = 9;\n');
  git(root, 'add', 'script.mjs');
  git(root, 'commit', '--amend', '-m', 'amended baseline');
  const amended = git(root, 'rev-parse', 'HEAD');
  await observer.stop();
  assert.deepEqual(written, [amended]);
});

test('a rebase records the chronological commits introduced into rewritten HEAD', async (t) => {
  const root = await repository(t);
  git(root, 'checkout', '-b', 'side');
  await writeFile(join(root, 'side.mjs'), 'export const side = true;\n');
  git(root, 'add', 'side.mjs');
  git(root, 'commit', '-m', 'side work');
  const side = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', 'main');
  await commitScript(root, 2, 'main work');
  const written = [];
  const observer = new CommitChangelogObserver({
    cwd: root,
    pollIntervalMs: 60_000,
    async inferSummaries({ update }) { return validOutput(update); },
    async writeUpdate({ update }) { written.push(update.commit); },
  });
  await observer.start();
  git(root, 'rebase', 'side');
  const rebased = git(root, 'rev-parse', 'HEAD');
  await observer.stop();
  assert.deepEqual(written, [side, rebased]);
});

test('a checkout or reset is not misreported as a newly created commit', async (t) => {
  const root = await repository(t);
  const original = git(root, 'rev-parse', 'HEAD');
  await commitScript(root, 2, 'already present before observation');
  const calls = [];
  const warnings = [];
  const observer = new CommitChangelogObserver({
    cwd: root,
    pollIntervalMs: 60_000,
    async inferSummaries(input) { calls.push(['infer', input]); },
    async writeUpdate(input) { calls.push(['write', input]); },
    onWarning(error) { warnings.push(error.message); },
  });
  await observer.start();
  git(root, 'reset', '--hard', original);
  await observer.stop();
  assert.deepEqual(calls, []);
  assert.match(warnings.join('\n'), /non-fast-forward/u);
});

test('invalid parallel output falls back without failing the commit write', async (t) => {
  const root = await repository(t);
  const warnings = [];
  const writes = [];
  const observer = new CommitChangelogObserver({
    cwd: root,
    pollIntervalMs: 60_000,
    async inferSummaries() { return '{"version":1,"commit":[],"overall":[]}'; },
    async writeUpdate(input) { writes.push(input); },
    onWarning(error) { warnings.push(error.message); },
  });
  await observer.start();
  await commitScript(root, 2, 'change');
  await observer.stop();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].commitSummaries, []);
  assert.match(warnings.join('\n'), /complete observed commit inventory/u);
});

test('summary tasks contain bounded evidence but no repository or underscore-document instruction', () => {
  const update = {
    commitEvidence: [{ path: 'script.mjs', action: 'patch', patch: '@@ -1 +1 @@' }],
    overallEvidence: [],
  };
  const task = changelogSummaryTask(update);
  assert.equal(task.kind, 'cruise-evidence-task');
  assert.deepEqual(JSON.parse(task.evidence), { commit: update.commitEvidence, overall: [] });
  assert.doesNotMatch(task.instructions, /git diff|_CHANGELOG|_FOR_USER_REFERENCE/u);
  assert.ok(Object.isFrozen(task));
  update.commitEvidence[0].patch = 'changed after capture';
  assert.equal(JSON.parse(task.evidence).commit[0].patch, '@@ -1 +1 @@');
});

test('summary parser rejects paths outside the frozen inventory', () => {
  const update = {
    commitChanges: [{ path: 'script.mjs', action: 'patch' }],
    overallChanges: [],
  };
  assert.throws(() => parseChangelogSummaryOutput(JSON.stringify({
    version: 1,
    commit: [{ path: 'other.mjs', summary: 'Wrong path.' }],
    overall: [],
  }), update), /outside the observed commit inventory/u);
  assert.throws(() => parseChangelogSummaryOutput(JSON.stringify({
    version: 1,
    commit: [{ path: 'script.mjs', summary: '<!-- CRUISE:COMMIT:forged -->' }],
    overall: [],
  }), update), /generated-region markers/u);
});
