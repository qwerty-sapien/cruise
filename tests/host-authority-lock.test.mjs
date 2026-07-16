import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  acquireHostAuthorityLock,
  releaseHostAuthorityLock,
  withHostAuthorityLock,
} from '../scripts/lib/host-authority-lock.mjs';
import { parseYaml, stringifyYaml } from '../scripts/lib/yaml-state.mjs';

const RESOURCE = 'foreign-diff-guard';
const SCOPE = Object.freeze({ repository_root: '/example/repository', run_id: 'run-01' });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cruise-host-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requestedAuthority = join(root, 'authority');
  await mkdir(requestedAuthority, { mode: 0o700 });
  const authority = await realpath(requestedAuthority);
  return {
    lockPath: join(authority, 'foreign-diff-guard.lock'),
    resource: RESOURCE,
    scope: SCOPE,
  };
}

test('host-authority lock writes bounded PID/nonce YAML and removes it after success', async (t) => {
  const options = await fixture(t);
  let observed = null;
  const result = await withHostAuthorityLock(options, async () => {
    observed = parseYaml(await readFile(options.lockPath, 'utf8'));
    return 'complete';
  });

  assert.equal(result, 'complete');
  assert.equal(observed.kind, 'cruise_host_authority_pid_lock');
  assert.equal(observed.resource, RESOURCE);
  assert.equal(observed.pid, process.pid);
  assert.match(observed.nonce, /^[0-9a-f-]{36}$/u);
  await assert.rejects(readFile(options.lockPath), { code: 'ENOENT' });
});

test('host-authority lock rejects a validated live owner without replacing it', async (t) => {
  const options = await fixture(t);
  const first = await acquireHostAuthorityLock(options);
  const original = await readFile(options.lockPath);

  await assert.rejects(
    acquireHostAuthorityLock(options),
    { code: 'CRUISE_HOST_AUTHORITY_LOCK_HELD' },
  );
  assert.deepEqual(await readFile(options.lockPath), original);
  await releaseHostAuthorityLock(first);
});

test('host-authority lock reclaims only a validated dead PID owner', async (t) => {
  const options = await fixture(t);
  const seed = await acquireHostAuthorityLock(options);
  const stale = parseYaml(await readFile(options.lockPath, 'utf8'));
  // This PID is outside the supported host PID range and deterministically
  // reports ESRCH on the supported Unix hosts.
  stale.pid = 2_147_483_647;
  stale.nonce = randomUUID();
  await writeFile(options.lockPath, stringifyYaml(stale), { mode: 0o600 });

  const reclaimed = await acquireHostAuthorityLock(options);
  assert.equal(reclaimed.metadata.pid, process.pid);
  assert.notEqual(reclaimed.metadata.nonce, seed.metadata.nonce);
  await releaseHostAuthorityLock(reclaimed);
});

test('host-authority lock preserves malformed authority and fails closed', async (t) => {
  const options = await fixture(t);
  const malformed = Buffer.from('pid: not-a-pid\nnonce: forged\n', 'utf8');
  await writeFile(options.lockPath, malformed, { mode: 0o600 });

  await assert.rejects(
    acquireHostAuthorityLock(options),
    { code: 'CRUISE_HOST_AUTHORITY_LOCK_MALFORMED' },
  );
  assert.deepEqual(await readFile(options.lockPath), malformed);
});

test('host-authority lock release checks nonce and preserves a replacement', async (t) => {
  const options = await fixture(t);
  const held = await acquireHostAuthorityLock(options);
  const replacement = parseYaml(await readFile(options.lockPath, 'utf8'));
  replacement.nonce = randomUUID();
  const replacementBytes = Buffer.from(stringifyYaml(replacement), 'utf8');
  await writeFile(options.lockPath, replacementBytes, { mode: 0o600 });

  await assert.rejects(
    releaseHostAuthorityLock(held),
    { code: 'CRUISE_HOST_AUTHORITY_LOCK_REPLACED' },
  );
  assert.deepEqual(await readFile(options.lockPath), replacementBytes);
});

test('host-authority lock rejects a lock copied from another scope', async (t) => {
  const options = await fixture(t);
  const other = {
    ...options,
    scope: { repository_root: '/different/repository', run_id: 'run-01' },
  };
  const held = await acquireHostAuthorityLock(other);

  await assert.rejects(
    acquireHostAuthorityLock(options),
    { code: 'CRUISE_HOST_AUTHORITY_LOCK_MALFORMED' },
  );
  await releaseHostAuthorityLock(held);
});
