import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { parse as parseToml } from 'smol-toml';

import {
  defaultCruiseConfig,
  loadCruiseConfig,
  targetByName,
  validateCruiseConfig,
} from '../scripts/lib/migration-config.mjs';

test('missing config selects the relaxed fast profile', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-config-default-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await loadCruiseConfig(root)).profile, 'relaxed');
  assert.equal(defaultCruiseConfig().workflow.autoPromoteAfterChecks, true);
  assert.deepEqual(defaultCruiseConfig().migration.targets.map(({ name, environment, execution }) => ({ name, environment, execution })), [
    { name: 'sandbox', environment: 'sandbox', execution: 'local' },
  ]);
});

test('business-critical config normalizes targets, domains, checks, and flows', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-config-business-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.cruise'));
  await writeFile(join(root, '.cruise/config.toml'), `
schema_version = 1
profile = "business-critical"

[workflow]
auto_promote_after_checks = false

[security]
explicit_sensitive_paths = ["private/customer-export.csv"]

[[migration.targets]]
name = "preview"
environment = "sandbox"
execution = "linked"
expected_project_ref = "sandbox-project-ref"
workdir = "apps/booking"

[[migration.targets]]
name = "prod"
environment = "production"
execution = "linked"
expected_project_ref = "production-project-ref"

[[migration.domains]]
name = "reporting"
tables = ["report_snapshots"]
service_critical = false
auto_apply = ["add-nullable-column", "create-index-concurrently"]

[[migration.validation.commands]]
name = "database-tests"
command = ["npm", "run", "test:database"]

[[migration.validation.flows]]
name = "booking-flow"
path = "/booking"

[[migration.policy_checks]]
id = "appi"
command = ["npm", "run", "compliance:appi"]

[[migration.derived_artifacts]]
name = "model-egress-trust"
path = "compliance/model-egress-trust.json"
`);
  const config = await loadCruiseConfig(root);
  assert.equal(config.profile, 'business-critical');
  assert.equal(config.workflow.autoPromoteAfterChecks, false);
  assert.equal(targetByName(config, 'preview').environment, 'sandbox');
  assert.deepEqual(config.migration.domains[0].tables, ['public.report_snapshots']);
  assert.deepEqual(config.migration.policyChecks[0].command, ['npm', 'run', 'compliance:appi']);
  assert.deepEqual(config.security.explicitSensitivePaths, ['private/customer-export.csv']);
});

test('config rejects credentials, connection strings, secret paths, and symlinks', async (t) => {
  assert.throws(() => validateCruiseConfig({ password: 'do-not-store-this' }), /secret-bearing key/u);
  assert.throws(
    () => validateCruiseConfig({ migration: { targets: [{
      name: 'prod', environment: 'production', expected_project_ref: 'project-ref', db_url: 'postgres://host/db',
    }] } }),
    /secret-bearing key/u,
  );
  assert.throws(
    () => validateCruiseConfig({ security: { explicit_sensitive_paths: ['.env'] } }),
    /cannot name a sensitive path/u,
  );
  assert.throws(
    () => validateCruiseConfig({ credential_env: 'actual-value' }),
    /must name an environment variable/u,
  );
  assert.throws(() => validateCruiseConfig({ migration: 'wrong' }), /migration must be a table/u);

  const root = await mkdtemp(join(tmpdir(), 'cruise-config-symlink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.cruise'));
  await writeFile(join(root, 'ordinary.toml'), 'profile = "relaxed"\n');
  await symlink(join(root, 'ordinary.toml'), join(root, '.cruise/config.toml'));
  await assert.rejects(loadCruiseConfig(root), /regular file/u);
});

test('config requires unique, verified-shape target identities', () => {
  assert.throws(() => validateCruiseConfig({ migration: { targets: [
    { name: 'prod', environment: 'production', expected_project_ref: 'first-project' },
    { name: 'prod', environment: 'sandbox', expected_project_ref: 'second-project' },
  ] } }), /duplicate migration target/u);
  assert.throws(() => validateCruiseConfig({ migration: { targets: [
    { name: 'prod', environment: 'production' },
  ] } }), /expected_project_ref/u);
});

test('shipped relaxed and business-critical examples remain valid', async () => {
  for (const profile of ['relaxed', 'business-critical']) {
    const text = await readFile(resolve(`examples/cruise-config.${profile}.toml`), 'utf8');
    assert.equal(validateCruiseConfig(parseToml(text)).profile, profile);
  }
});
