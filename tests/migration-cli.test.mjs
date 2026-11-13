import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseArgs, runConfigCommand, runMigrationCommand } from '../scripts/cruise.mjs';
import { validateCruiseConfig } from '../scripts/lib/migration-config.mjs';

const config = validateCruiseConfig({
  profile: 'relaxed',
  migration: {
    targets: [{ name: 'sandbox', environment: 'sandbox', execution: 'linked', expected_project_ref: 'sandbox-project' }],
  },
});

test('migration CLI parses dedicated commands and rejects ambiguous or secret-bearing escape flags', () => {
  assert.deepEqual(
    {
      action: parseArgs(['migrate', 'apply', '--target', 'sandbox', '--path', 'supabase/migrations/040.sql', '--sandbox-first=auto']).migrationAction,
      target: parseArgs(['migrate', 'apply', '--target', 'sandbox']).targetName,
    },
    { action: 'apply', target: 'sandbox' },
  );
  const query = parseArgs(['migrate', 'query', '--target', 'sandbox', '--file', 'queries/status.sql', '--json']);
  assert.equal(query.sqlFile, 'queries/status.sql');
  assert.equal(query.json, true);
  assert.throws(() => parseArgs(['migrate', 'apply']), /requires --target/u);
  assert.throws(() => parseArgs(['migrate', 'query', '--target', 'sandbox']), /requires --file/u);
  assert.throws(() => parseArgs(['migrate', 'apply', '--target', 'sandbox', '--db-url', 'postgres://secret']), /not supported/u);
  assert.throws(() => parseArgs(['migrate', 'route', '--sandbox-first', 'off']), /accepts only auto or manual/u);
});

test('config show emits normalized non-secret policy state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-config-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let output = '';
  const status = await runConfigCommand({ cwd: root, configAction: 'show', json: true }, {
    configLoader: async () => config,
    output: { write(value) { output += value; } },
  });
  assert.equal(status, 0);
  assert.equal(JSON.parse(output).profile, 'relaxed');
  assert.doesNotMatch(output, /password|database_url/iu);
});

test('migration command delegates only structured target and path inputs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-migrate-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  let output = '';
  const options = parseArgs(['migrate', 'apply', '-C', root, '--target', 'sandbox', '--path', 'supabase/migrations/040.sql', '--json']);
  const exitCode = await runMigrationCommand(options, {
    configLoader: async () => config,
    adapterFactory: () => ({ marker: 'adapter' }),
    controllerFactory(input) {
      calls.push(['controller', input.cwd, input.adapter.marker]);
      return {
        async apply(value) {
          calls.push(['apply', value]);
          return { state: 'applied', decision: { reason: 'verified-sandbox-auto-apply', digest: 'a'.repeat(64) } };
        },
      };
    },
    output: { write(value) { output += value; } },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(calls[1], ['apply', {
    targetName: 'sandbox',
    paths: ['supabase/migrations/040.sql'],
    sandboxFirst: null,
    authorization: null,
  }]);
  assert.equal(JSON.parse(output).state, 'applied');
});

test('session-only route is kept under the private runtime directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-route-cli-'));
  const runtime = join(root, 'runtime');
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = parseArgs(['migrate', 'route', '-C', root, '--sandbox-first', 'manual'], {
    env: { CRUISE_RUNTIME_DIR: runtime },
  });
  let output = '';
  assert.equal(await runMigrationCommand(options, { output: { write(value) { output += value; } } }), 0);
  assert.equal(JSON.parse(await readFile(join(runtime, 'migration-route.json'), 'utf8')).sandboxFirst, 'manual');
  assert.match(output, /route-set/u);
  const noRuntime = parseArgs(['migrate', 'route', '-C', root, '--sandbox-first', 'auto'], { env: {} });
  await assert.rejects(runMigrationCommand(noRuntime), /session-only/u);
});
