import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  inspectWorkerHostRule,
  installWorkerHostRule,
  LEGACY_WORKER_HOST_RULE,
  renderWorkerHostRule,
  workerHostRulePath,
} from '../scripts/lib/doctor-host-rule.mjs';

test('worker host rule is exact, scoped, and idempotent', async (t) => {
  const codexHome = await mkdtemp(join(tmpdir(), 'cruise-rule-'));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const entrypoint = join(codexHome, 'cruise.mjs');
  await writeFile(entrypoint, '#!/usr/bin/env node\n');
  const expected = renderWorkerHostRule(entrypoint);

  assert.equal((await inspectWorkerHostRule({ codexHome, entrypoint })).status, 'missing');
  const installed = await installWorkerHostRule({ codexHome, entrypoint });
  assert.equal(installed.status, 'current');
  assert.equal(installed.changed, true);
  assert.equal(await readFile(workerHostRulePath({ codexHome }), 'utf8'), expected);
  assert.equal((await installWorkerHostRule({ codexHome, entrypoint })).changed, false);
  assert.match(expected, /^prefix_rule\(pattern=\["\//u);
  assert.match(expected, /,"worker"\], decision="allow"\)\n$/u);
  assert.doesNotMatch(expected, /pattern=\["cruise"/u);
});

test('worker host rule installer refuses drift and links', async (t) => {
  const codexHome = await mkdtemp(join(tmpdir(), 'cruise-rule-drift-'));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const entrypoint = join(codexHome, 'cruise.mjs');
  await writeFile(entrypoint, '#!/usr/bin/env node\n');
  const path = workerHostRulePath({ codexHome });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'prefix_rule(pattern=["cruise"], decision="allow")\n');
  assert.equal((await inspectWorkerHostRule({ codexHome, entrypoint })).status, 'invalid');
  await assert.rejects(installWorkerHostRule({ codexHome, entrypoint }), /reconcile it manually/u);

  await rm(path);
  const target = join(codexHome, 'elsewhere.rules');
  await writeFile(target, renderWorkerHostRule(entrypoint));
  await symlink(target, path);
  assert.equal((await inspectWorkerHostRule({ codexHome, entrypoint })).status, 'invalid');
});

test('worker host rule migrates the legacy PATH-based rule', async (t) => {
  const codexHome = await mkdtemp(join(tmpdir(), 'cruise-rule-legacy-'));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const entrypoint = join(codexHome, 'cruise.mjs');
  await writeFile(entrypoint, '#!/usr/bin/env node\n');
  const path = workerHostRulePath({ codexHome });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, LEGACY_WORKER_HOST_RULE);
  assert.equal((await inspectWorkerHostRule({ codexHome, entrypoint })).status, 'legacy');
  const installed = await installWorkerHostRule({ codexHome, entrypoint });
  assert.equal(installed.changed, true);
  assert.equal(await readFile(path, 'utf8'), renderWorkerHostRule(entrypoint));
});
