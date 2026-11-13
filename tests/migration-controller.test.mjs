import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateCruiseConfig } from '../scripts/lib/migration-config.mjs';
import {
  inspectLocalAdditiveDependencies,
  MigrationController,
  redactMigrationDiagnostic,
  SupabaseCliMigrationAdapter,
} from '../scripts/lib/migration-controller.mjs';

function fixtureConfig({ autoPromoteAfterChecks = true } = {}) {
  return validateCruiseConfig({
    profile: 'business-critical',
    workflow: { auto_promote_after_checks: autoPromoteAfterChecks },
    security: { explicit_sensitive_paths: ['protected/private.sql'] },
    migration: {
      targets: [
        { name: 'sandbox', environment: 'sandbox', execution: 'linked', expected_project_ref: 'sandbox-project' },
        { name: 'prod', environment: 'production', execution: 'linked', expected_project_ref: 'production-project' },
      ],
      domains: [{
        name: 'reporting', tables: ['report_snapshots'], service_critical: false, auto_apply: ['add-nullable-column'],
      }],
      validation: {
        commands: [{ name: 'database-tests', command: ['npm', 'test'] }],
        flows: [{ name: 'booking-flow', path: '/booking' }],
      },
      policy_checks: [{ id: 'appi', command: ['npm', 'run', 'compliance:appi'] }],
      derived_artifacts: [{ name: 'trust-digest', path: 'compliance/trust.json', command: ['npm', 'run', 'trust:update'] }],
    },
  });
}

function fakeAdapter({ validationPassed = true, targetIdentity = null, applyDelay = 0 } = {}) {
  const calls = [];
  return {
    calls,
    readOnlyEnforced: true,
    async inspectTarget(target) {
      calls.push(['inspect-target', target.name]);
      return { environment: target.environment, actualIdentity: targetIdentity?.[target.name] ?? target.expectedProjectRef };
    },
    async inspectDependencies(input) {
      calls.push(['dependencies', input.target.name]);
      return {
        catalogChecked: true,
        materialDependencies: [],
        apiExposureChanged: false,
        policyChanged: false,
        triggerChanged: false,
        typeGenerationChanged: false,
        applicationReferences: [],
      };
    },
    async runPolicyChecks(checks, input) {
      calls.push(['policy', input.target.name]);
      return { checked: true, conflicts: false, passed: checks.map(({ name }) => name) };
    },
    async previewMigration(input) {
      calls.push(['preview', input.target.name]);
      return { ok: true };
    },
    async applyMigration(input) {
      calls.push(['apply', input.target.name]);
      if (applyDelay) await new Promise((resolvePromise) => setTimeout(resolvePromise, applyDelay));
      return { ok: true };
    },
    async updateDerivedArtifacts(artifacts, input) {
      calls.push(['derived', input.target.name]);
      return artifacts.map(({ name }) => name);
    },
    async validateSandbox(input) {
      calls.push(['validate', input.target.name]);
      return validationPassed
        ? { passed: true, seriousIssues: false, checks: ['database-tests', 'appi', 'booking-flow'] }
        : { passed: false, seriousIssues: true, failed: ['booking-flow'], rollback: 'Undo sandbox migration 040.' };
    },
    async queryReadOnly(input) {
      calls.push(['query', input.target.name, input.sql]);
      return { ok: true, summary: '3 rows' };
    },
  };
}

async function miniRepo(t) {
  const root = await mkdtemp(join(tmpdir(), 'cruise-mini-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'supabase/migrations'), { recursive: true });
  await mkdir(join(root, 'protected'), { recursive: true });
  await writeFile(join(root, 'supabase/migrations/040_add_trace.sql'), 'alter table public.unmapped_events add column trace_id uuid;\n');
  await writeFile(join(root, 'supabase/migrations/041_drop_notes.sql'), 'alter table public.bookings drop column notes;\n');
  await writeFile(join(root, '.env'), 'DATABASE_URL=postgres://canary-never-read\n');
  await chmod(join(root, '.env'), 0o000);
  await writeFile(join(root, 'protected/private.sql'), 'drop table private_data;\n');
  return root;
}

test('mini repository applies sandbox migration without reading unreadable dotenv', async (t) => {
  const root = await miniRepo(t);
  const adapter = fakeAdapter();
  const controller = new MigrationController({ cwd: root, config: fixtureConfig(), adapter, now: () => 10 });
  const outcome = await controller.apply({
    targetName: 'sandbox', paths: ['supabase/migrations/041_drop_notes.sql'],
  });
  assert.equal(outcome.state, 'applied');
  assert.deepEqual(adapter.calls.map((call) => call.slice(0, 2)), [
    ['inspect-target', 'sandbox'], ['inspect-target', 'sandbox'], ['preview', 'sandbox'], ['apply', 'sandbox'], ['derived', 'sandbox'],
  ]);
});

test('safe production migration performs strict analysis and auto-applies once', async (t) => {
  const root = await miniRepo(t);
  const adapter = fakeAdapter({ applyDelay: 5 });
  const controller = new MigrationController({ cwd: root, config: fixtureConfig(), adapter, now: () => 20 });
  const input = { targetName: 'prod', paths: ['supabase/migrations/040_add_trace.sql'] };
  const [first, second] = await Promise.all([controller.apply(input), controller.apply(input)]);
  assert.deepEqual([first.state, second.state].sort(), ['already-applied', 'applied']);
  assert.equal(adapter.calls.filter(([name, target]) => name === 'apply' && target === 'prod').length, 1);
  assert.equal(adapter.calls.some(([name]) => name === 'dependencies'), true);
  assert.equal(adapter.calls.some(([name]) => name === 'policy'), true);
});

test('risky production migration routes through sandbox and auto-promotes after checks', async (t) => {
  const root = await miniRepo(t);
  const adapter = fakeAdapter();
  const controller = new MigrationController({ cwd: root, config: fixtureConfig(), adapter, now: () => 30 });
  const outcome = await controller.apply({
    targetName: 'prod', paths: ['supabase/migrations/041_drop_notes.sql'], sandboxFirst: 'auto',
  });
  assert.equal(outcome.state, 'promoted');
  assert.deepEqual(adapter.calls.filter(([name]) => name === 'apply').map(([, target]) => target), ['sandbox', 'prod']);
  assert.equal(adapter.calls.findIndex(([name]) => name === 'validate') < adapter.calls.findIndex(([name, target]) => name === 'apply' && target === 'prod'), true);
});

test('risky production migration does not choose a sandbox route on the user’s behalf', async (t) => {
  const root = await miniRepo(t);
  const adapter = fakeAdapter();
  const controller = new MigrationController({ cwd: root, config: fixtureConfig(), adapter });
  const outcome = await controller.apply({
    targetName: 'prod', paths: ['supabase/migrations/041_drop_notes.sql'],
  });
  assert.equal(outcome.state, 'authorization-required');
  assert.equal(outcome.choices.length, 4);
  assert.equal(adapter.calls.some(([name]) => name === 'apply'), false);
});

test('failed sandbox validation retains sandbox and never touches production', async (t) => {
  const root = await miniRepo(t);
  const adapter = fakeAdapter({ validationPassed: false });
  const controller = new MigrationController({ cwd: root, config: fixtureConfig(), adapter });
  const outcome = await controller.apply({
    targetName: 'prod', paths: ['supabase/migrations/041_drop_notes.sql'], sandboxFirst: 'auto',
  });
  assert.equal(outcome.state, 'sandbox-failed');
  assert.equal(outcome.retained, true);
  assert.deepEqual(outcome.failed, ['booking-flow']);
  assert.deepEqual(adapter.calls.filter(([name]) => name === 'apply').map(([, target]) => target), ['sandbox']);
});

test('manual sandbox route promotes only through a live session token', async (t) => {
  const root = await miniRepo(t);
  const adapter = fakeAdapter();
  const controller = new MigrationController({ cwd: root, config: fixtureConfig(), adapter, uuid: () => 'session-token' });
  const waiting = await controller.apply({
    targetName: 'prod', paths: ['supabase/migrations/041_drop_notes.sql'], sandboxFirst: 'manual',
  });
  assert.equal(waiting.state, 'awaiting-manual-confirmation');
  assert.deepEqual(adapter.calls.filter(([name]) => name === 'apply').map(([, target]) => target), ['sandbox']);
  assert.equal((await controller.confirmManualPromotion('wrong')).state, 'blocked');
  assert.equal((await controller.confirmManualPromotion('session-token')).state, 'promoted');
  assert.equal((await controller.confirmManualPromotion('session-token')).state, 'blocked');
});

test('a profile can force an explicitly chosen automatic sandbox route to await manual confirmation', async (t) => {
  const root = await miniRepo(t);
  const adapter = fakeAdapter();
  const controller = new MigrationController({
    cwd: root,
    config: fixtureConfig({ autoPromoteAfterChecks: false }),
    adapter,
    uuid: () => 'profile-manual-token',
  });
  const outcome = await controller.apply({
    targetName: 'prod',
    paths: ['supabase/migrations/041_drop_notes.sql'],
    sandboxFirst: 'auto',
  });
  assert.equal(outcome.state, 'awaiting-manual-confirmation');
});

test('exact production authorization is single-use and target-bound', async (t) => {
  const root = await miniRepo(t);
  const adapter = fakeAdapter();
  const controller = new MigrationController({ cwd: root, config: fixtureConfig(), adapter });
  const inspection = await controller.inspect({ targetName: 'prod', paths: ['supabase/migrations/041_drop_notes.sql'] });
  const authorization = { digest: inspection.decision.digest, target: 'prod', environment: 'production' };
  const applied = await controller.apply({
    targetName: 'prod', paths: ['supabase/migrations/041_drop_notes.sql'], authorization, sandboxFirst: false,
  });
  assert.equal(applied.state, 'applied');
  const repeated = await controller.apply({
    targetName: 'prod', paths: ['supabase/migrations/041_drop_notes.sql'], authorization, sandboxFirst: false,
  });
  assert.equal(repeated.state, 'authorization-required');
});

test('unverified targets and sensitive SQL paths fail before execution', async (t) => {
  const root = await miniRepo(t);
  const adapter = fakeAdapter({ targetIdentity: { sandbox: 'production-project' } });
  const controller = new MigrationController({ cwd: root, config: fixtureConfig(), adapter });
  assert.equal((await controller.apply({
    targetName: 'sandbox', paths: ['supabase/migrations/041_drop_notes.sql'],
  })).state, 'blocked');
  await assert.rejects(
    controller.inspect({ targetName: 'sandbox', paths: ['.env'] }),
    /sensitive path is never readable/u,
  );
  await assert.rejects(
    controller.inspect({ targetName: 'sandbox', paths: ['protected/private.sql'] }),
    /sensitive path is never readable/u,
  );
  assert.equal(adapter.calls.some(([name]) => name === 'apply'), false);
});

test('read-only query and diagnostics expose no credentials', async (t) => {
  const root = await miniRepo(t);
  const adapter = fakeAdapter();
  const controller = new MigrationController({ cwd: root, config: fixtureConfig(), adapter });
  const outcome = await controller.apply({
    targetName: 'prod', mode: 'query', sql: 'select id, status from public.bookings limit 3;',
  });
  assert.equal(outcome.state, 'queried');
  assert.equal(redactMigrationDiagnostic('password=hunter2 postgres://me:pw@host/db Bearer abcdefghijklmnop'),
    'password=<redacted> <redacted-database-url> Bearer <redacted>');
});

test('target drift between inspection and execution blocks both writes and reads', async (t) => {
  const root = await miniRepo(t);
  let observations = 0;
  const adapter = fakeAdapter();
  adapter.inspectTarget = async (target) => {
    observations += 1;
    return {
      environment: target.environment,
      actualIdentity: observations === 1 ? target.expectedProjectRef : 'different-project',
    };
  };
  const controller = new MigrationController({ cwd: root, config: fixtureConfig(), adapter });
  assert.equal((await controller.apply({
    targetName: 'sandbox', paths: ['supabase/migrations/041_drop_notes.sql'],
  })).reason, 'target-identity-drifted-before-apply');
  assert.equal(adapter.calls.some(([name]) => name === 'apply'), false);

  observations = 0;
  const queryController = new MigrationController({ cwd: root, config: fixtureConfig(), adapter });
  assert.equal((await queryController.apply({
    targetName: 'prod', mode: 'query', sql: 'select id from public.bookings;',
  })).reason, 'target-identity-drifted-before-query');
  assert.equal(adapter.calls.some(([name]) => name === 'query'), false);
});

test('derived digest refresh failure never becomes a pre-apply authorization gate', async (t) => {
  const root = await miniRepo(t);
  const adapter = fakeAdapter();
  adapter.updateDerivedArtifacts = async () => { throw new Error('trust digest updater failed token=secret-value'); };
  const controller = new MigrationController({ cwd: root, config: fixtureConfig(), adapter, now: () => 99 });
  const outcome = await controller.apply({
    targetName: 'sandbox', paths: ['supabase/migrations/041_drop_notes.sql'],
  });
  assert.equal(outcome.state, 'applied');
  assert.match(outcome.receipt.derivedArtifactWarning, /token=<redacted>/u);
  assert.equal(adapter.calls.some(([name]) => name === 'apply'), true);
});

test('local additive proof skips secret canaries and detects whole-row API dependencies', async (t) => {
  const root = await miniRepo(t);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/reporting.mjs'), "supabase.from('unmapped_events').select('*');\n");
  const operations = [{ kind: 'add-nullable-column', table: 'public.unmapped_events', column: 'trace_id' }];
  const blocked = await inspectLocalAdditiveDependencies({
    cwd: root,
    operations,
    excludedFiles: ['supabase/migrations/040_add_trace.sql'],
    explicitSensitivePaths: ['protected/private.sql'],
  });
  assert.equal(blocked.catalogChecked, true);
  assert.equal(blocked.apiExposureChanged, true);
  assert.equal(blocked.applicationReferences.length, 1);
  await writeFile(join(root, 'src/reporting.mjs'), "supabase.from('unmapped_events').select('id');\n");
  const passed = await inspectLocalAdditiveDependencies({
    cwd: root,
    operations,
    excludedFiles: ['supabase/migrations/040_add_trace.sql'],
    explicitSensitivePaths: ['protected/private.sql'],
  });
  assert.equal(passed.apiExposureChanged, false);
  assert.deepEqual(passed.applicationReferences, []);
});

test('Supabase adapter rejects dry-run drift and wraps queries in a bounded read-only transaction', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cruise-supabase-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'supabase'), { recursive: true });
  await writeFile(join(root, 'supabase/config.toml'), 'project_id = "safe-local-id"\n');
  const calls = [];
  let wrapped = '';
  const runner = async (command, args) => {
    calls.push([command, args]);
    if (args.includes('query.sql')) throw new Error('unexpected exact temp path shape');
    const fileIndex = args.indexOf('--file');
    if (fileIndex >= 0) wrapped = await readFile(args[fileIndex + 1], 'utf8');
    return { ok: true, stdout: 'Pending migrations:\n040_safe.sql\n041_extra.sql\n' };
  };
  const adapter = new SupabaseCliMigrationAdapter({ cwd: root, cli: ['supabase'], runner });
  const target = { name: 'sandbox', environment: 'sandbox', execution: 'local', workdir: '.' };
  assert.equal((await adapter.inspectTarget(target)).actualIdentity, `local:${root}`);
  assert.equal((await adapter.previewMigration({ target, files: ['supabase/migrations/040_safe.sql'] })).ok, false);
  assert.equal((await adapter.previewMigration({ target, files: [] })).ok, false);
  const query = await adapter.queryReadOnly({ target, sql: 'select id from public.bookings' });
  assert.equal(query.ok, true);
  assert.match(wrapped, /^begin read only;/u);
  assert.match(wrapped, /statement_timeout/u);
  assert.match(wrapped, /limit 200;/u);
  assert.match(wrapped, /rollback;/u);
});
