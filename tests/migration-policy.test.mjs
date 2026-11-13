import assert from 'node:assert/strict';
import test from 'node:test';

import { validateCruiseConfig } from '../scripts/lib/migration-config.mjs';
import {
  authorizationMatches,
  classifyMigration,
  classifyReadOnlySql,
  informedMigrationChoices,
  MIGRATION_ACTION,
} from '../scripts/lib/migration-policy.mjs';

const config = validateCruiseConfig({
  profile: 'business-critical',
  migration: {
    targets: [
      { name: 'sandbox', environment: 'sandbox', execution: 'linked', expected_project_ref: 'sandbox-project' },
      { name: 'prod', environment: 'production', execution: 'linked', expected_project_ref: 'production-project' },
    ],
    domains: [{
      name: 'reporting',
      tables: ['report_snapshots'],
      service_critical: false,
      auto_apply: ['add-nullable-column', 'create-index-concurrently'],
    }],
    policy_checks: [{ id: 'appi', command: ['npm', 'run', 'compliance:appi'] }],
  },
});
const sandbox = { ...config.migration.targets[0], actualIdentity: 'sandbox-project' };
const prod = { ...config.migration.targets[1], actualIdentity: 'production-project' };
const policyPass = { checked: true, conflicts: false, passed: ['appi'] };
const dependencyPass = {
  catalogChecked: true,
  materialDependencies: [],
  apiExposureChanged: false,
  policyChanged: false,
  triggerChanged: false,
  typeGenerationChanged: false,
  applicationReferences: [],
};

test('every migration on a verified sandbox target auto-applies', () => {
  for (const sql of [
    'drop table public.bookings;',
    'do $$ begin execute dangerous; end $$;',
    'alter table public.users alter column id type bigint;',
  ]) {
    assert.equal(classifyMigration({ sql, target: sandbox, config, targetVerified: true }).action, MIGRATION_ACTION.autoApply);
  }
  assert.equal(
    classifyMigration({ sql: 'select 1', target: sandbox, config, targetVerified: false }).reason,
    'target-identity-unverified',
  );
});

test('production read-only SQL auto-runs only with server enforcement and minimum columns', () => {
  assert.deepEqual(classifyReadOnlySql('select id, status from public.bookings limit 10;').safe, true);
  assert.equal(classifyReadOnlySql('select * from public.bookings;').reason, 'select-must-name-minimum-columns');
  assert.equal(classifyReadOnlySql('select id from public.bookings for update;').safe, false);
  assert.equal(classifyReadOnlySql('with changed as (delete from x returning *) select id from changed;').safe, false);
  assert.equal(classifyMigration({
    sql: 'select id from public.bookings;', target: prod, config, targetVerified: true, mode: 'query', readOnlyEnforced: true,
  }).action, MIGRATION_ACTION.autoApply);
  assert.equal(classifyMigration({
    sql: 'select id from public.bookings;', target: prod, config, targetVerified: true, mode: 'query', readOnlyEnforced: false,
  }).reason, 'server-read-only-enforcement-required');
});

test('allowlisted noncritical production domain auto-applies after policy checks', () => {
  const sql = 'alter table public.report_snapshots add column if not exists exported_at timestamptz;';
  assert.equal(classifyMigration({ sql, target: prod, config, targetVerified: true }).reason, 'policy-checks-required');
  const decision = classifyMigration({ sql, target: prod, config, targetVerified: true, policyEvidence: policyPass });
  assert.equal(decision.action, MIGRATION_ACTION.autoApply);
  assert.equal(decision.reason, 'allowlisted-noncritical-domain');
});

test('unmapped additive production changes require and honor strict dependency proof', () => {
  const sql = 'alter table public.unmapped_events add column trace_id uuid;';
  assert.equal(classifyMigration({ sql, target: prod, config, targetVerified: true }).action, MIGRATION_ACTION.requireAnalysis);
  const decision = classifyMigration({
    sql, target: prod, config, targetVerified: true, dependencyEvidence: dependencyPass, policyEvidence: policyPass,
  });
  assert.equal(decision.action, MIGRATION_ACTION.autoApply);
  assert.equal(decision.reason, 'proven-additive-no-material-effects');
  const risky = classifyMigration({
    sql,
    target: prod,
    config,
    targetVerified: true,
    dependencyEvidence: { ...dependencyPass, apiExposureChanged: true, applicationReferences: ['src/api.ts: select(*)'] },
    policyEvidence: policyPass,
  });
  assert.equal(risky.action, MIGRATION_ACTION.requireAuthorization);
  assert.equal(risky.reason, 'dependency-analysis-found-risk-or-uncertainty');
});

test('a failed configured data-policy check becomes an informed production choice', () => {
  const decision = classifyMigration({
    sql: 'alter table public.report_snapshots add column trace_id uuid;',
    target: prod,
    config,
    targetVerified: true,
    policyEvidence: { checked: true, conflicts: true, passed: [] },
  });
  assert.equal(decision.action, MIGRATION_ACTION.requireAuthorization);
  assert.equal(decision.reason, 'configured-data-policy-conflict');
  assert.match(decision.riskFactors[0], /data-management policy/u);
});

test('strict additive heuristics never merge multiple unproven database classes into one minor change', () => {
  const decision = classifyMigration({
    sql: [
      'alter table public.first_events add column trace_id uuid;',
      'alter table public.second_events add column trace_id uuid;',
    ].join('\n'),
    target: prod,
    config,
    targetVerified: true,
    dependencyEvidence: dependencyPass,
    policyEvidence: policyPass,
  });
  assert.equal(decision.action, MIGRATION_ACTION.requireAuthorization);
  assert.equal(decision.reason, 'migration-spans-unproven-database-classes');
  assert.match(decision.riskFactors[0], /crosses configured database domains/u);
});

test('risky, ambiguous, cross-domain, and constrained migrations require exact authorization', () => {
  for (const sql of [
    'alter table public.bookings drop column notes;',
    'alter table public.bookings add column hotel_id uuid not null;',
    'create table public.new_api_table (id uuid primary key);',
    "do $$ begin execute 'drop table public.bookings'; end $$;",
    "select 'unterminated",
  ]) {
    const decision = classifyMigration({ sql, target: prod, config, targetVerified: true });
    assert.equal(decision.action, MIGRATION_ACTION.requireAuthorization, sql);
    assert.equal(informedMigrationChoices(decision).length, 4);
  }
  const decision = classifyMigration({
    sql: 'drop table public.bookings;', target: prod, config, targetVerified: true,
  });
  assert.equal(authorizationMatches(decision, {
    digest: decision.digest, target: 'prod', environment: 'production',
  }), true);
  assert.equal(authorizationMatches(decision, {
    digest: 'different', target: 'prod', environment: 'production',
  }), false);
});

test('comments and literals cannot disguise destructive SQL', () => {
  assert.equal(classifyMigration({
    sql: "-- harmless words: add column\ndrop table public.users;",
    target: prod,
    config,
    targetVerified: true,
  }).action, MIGRATION_ACTION.requireAuthorization);
  assert.equal(classifyMigration({
    sql: "alter table public.report_snapshots add column note text; -- drop table ignored",
    target: prod,
    config,
    targetVerified: true,
    policyEvidence: policyPass,
  }).action, MIGRATION_ACTION.autoApply);
});
