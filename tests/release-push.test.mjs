import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/release-push.sh', import.meta.url));

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function git(cwd, ...args) {
  return run('git', args, cwd);
}

function write(worktree, path, contents) {
  const target = join(worktree, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function commitAll(worktree, subject) {
  git(worktree, 'add', '--all');
  git(worktree, 'commit', '-m', subject);
  return git(worktree, 'rev-parse', 'HEAD');
}

test('release push collapses intermediates, preserves later commits, and keeps the final tree', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cruise-release-push-test-'));
  const remote = join(root, 'remote.git');
  const worktree = join(root, 'worktree');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  git(root, 'init', '--bare', remote);
  git(root, 'clone', remote, worktree);
  git(worktree, 'config', 'user.name', 'Release Test');
  git(worktree, 'config', 'user.email', 'release@example.com');
  git(worktree, 'config', 'commit.gpgSign', 'false');
  git(worktree, 'checkout', '-b', 'main');

  write(worktree, 'README.md', 'v1\n');
  const previousRelease = commitAll(worktree, 'Cruise v1.0.0');
  git(worktree, 'push', '--set-upstream', 'origin', 'main');

  write(worktree, 'src/feature.txt', 'first intermediate\n');
  const firstIntermediate = commitAll(worktree, 'implement feature');
  write(worktree, 'src/feature.txt', 'finished feature\n');
  commitAll(worktree, 'fix feature edge case');
  write(worktree, 'VERSION', '1.1.0\n');
  commitAll(worktree, 'Cruise v1.1.0: ship feature');
  write(worktree, 'README.md', 'v1.1 usage correction\n');
  commitAll(worktree, 'Fix README after release');

  const originalTree = git(worktree, 'rev-parse', 'HEAD^{tree}');
  const output = run('bash', [script, 'origin', 'main'], worktree);
  const rewrittenTip = git(worktree, 'rev-parse', 'HEAD');
  const rewrittenTree = git(worktree, 'rev-parse', 'HEAD^{tree}');
  const subjects = git(
    worktree,
    'log',
    '--reverse',
    '--format=%s',
    `${previousRelease}..HEAD`,
  ).split('\n');

  assert.deepEqual(subjects, [
    'Cruise v1.1.0: ship feature',
    'Fix README after release',
  ]);
  assert.equal(rewrittenTree, originalTree);
  assert.match(output, /Will remove:\s+2 intermediate commit\(s\)/);
  assert.match(output, /Will preserve:\s+1 post-release commit\(s\)/);
  assert.match(output, /Pushed cleaned main to origin/);
  assert.equal(
    git(root, '--git-dir', remote, 'rev-parse', 'refs/heads/main'),
    rewrittenTip,
  );

  const ancestorCheck = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', firstIntermediate, rewrittenTip],
    { cwd: worktree },
  );
  assert.equal(ancestorCheck.status, 1);

  const backups = git(
    worktree,
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads/codex/history-backup-main-*',
  ).split('\n').filter(Boolean);
  assert.equal(backups.length, 1);

  write(worktree, 'dirty.txt', 'uncommitted\n');
  const dirtyRun = spawnSync('bash', [script, '--dry-run', 'origin', 'main'], {
    cwd: worktree,
    encoding: 'utf8',
  });
  assert.equal(dirtyRun.status, 1);
  assert.match(dirtyRun.stderr, /worktree or index is dirty/);

  rmSync(join(worktree, 'dirty.txt'));
  write(worktree, 'VERSION', '1.2.0\n');
  const cleanRelease = commitAll(worktree, 'Cruise v1.2.0');
  const cleanOutput = run('bash', [script, 'origin', 'main'], worktree);
  const secondRewrittenTip = git(worktree, 'rev-parse', 'HEAD');
  assert.notEqual(secondRewrittenTip, cleanRelease);
  assert.equal(
    git(root, '--git-dir', remote, 'rev-parse', 'refs/heads/main'),
    secondRewrittenTip,
  );
  assert.deepEqual(
    git(
      worktree,
      'log',
      '--reverse',
      '--format=%s',
      `${rewrittenTip}..HEAD`,
    ).split('\n'),
    ['Cruise v1.2.0'],
  );
  assert.match(cleanOutput, /Will remove:\s+1 intermediate commit\(s\)/);
});
