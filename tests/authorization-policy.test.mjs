import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

test('read clauses can name software operations without granting those effects', () => {
  for (const question of [
    'May I read the approved local folder to review delete endpoint source code?',
    'May I search authorized local files for deployment documentation?',
    'May I inspect the approved local files to review installation tests?',
  ]) {
    assert.equal(classifyCruiseAuthorization(question).action, AUTHORIZATION_ACTION.proceed, question);
    assert.ok(automaticLocalAuthorization({ questions: [{ id: 'read', question }] }), question);
    for (const effect of ['delete the production database', 'deploy to production', 'copy it to https://example.invalid/collect']) {
      const mixed = question.replace(/\?$/u, ` and ${effect}?`);
      assert.equal(classifyCruiseAuthorization(mixed).action, AUTHORIZATION_ACTION.requestUser, mixed);
      assert.equal(automaticLocalAuthorization({ questions: [{ id: 'mixed', question: mixed }] }), null, mixed);
    }
  }
  assert.ok(automaticDelegationAuthorization({ questions: [{ id: 'review',
    question: 'May I ask a subagent to review deployment documentation for production?' }] }));
  assert.equal(automaticDelegationAuthorization({ questions: [{ id: 'review',
    question: 'May I ask a subagent to review deployment documentation and deploy to production?' }] }), null);
});

import {
  AUTHORIZATION_ACTION,
  AUTHORIZATION_POLICY_INSTRUCTIONS,
  CRUISE_INTEGRITY_DRIFT_RECOVERY_INSTRUCTIONS,
  NATIVE_APPROVAL_EVIDENCE_INSTRUCTIONS,
  WORKER_AUTHORIZATION_RECOVERY_INSTRUCTIONS,
  automaticDelegationAuthorization,
  automaticLocalAuthorization,
  classifyCruiseAuthorization,
  isCruiseIntegrityDriftAuthorizationPause,
  isSpeculativeWorkerAuthorizationPause,
} from '../scripts/lib/authorization-policy.mjs';
import {
  assertNoSecretMaterial,
  assertReadablePath,
  isSensitivePath,
} from '../scripts/lib/sensitive-path.mjs';

const ROUTINE_DELEGATION_QUESTIONS = [
  'Shall I allow you to refer this task to another newly spawned sub-agent?',
  'May I spawn a sub-agent to review this patch?',
  'Can I delegate the focused test run to another agent?',
  'May I send approved source excerpts to a newly spawned subagent?',
  'Which worker model should I use, Terra, Sol, or Astra, for this bounded task?',
  'May I ask a subagent for a read-only review of the proposed production deletion?',
];

test('local authorization accepts bounded aliases, casing and ordinary domain labels without delegation', () => {
  for (const location of [
    'approved local folder', 'authorized folder', 'AUTHORISED FOLDERS',
    'access-approved local workspace files', 'approved directories',
    'host-access-approved local directories', 'authorized sibling repositories',
    'approved private local folders', 'approved task-relevant sibling files',
  ]) {
    const question = `May I search the ${location} for password hashing code?`;
    assert.deepEqual(classifyCruiseAuthorization(question), {
      action: AUTHORIZATION_ACTION.proceed, reason: 'approved-local-context',
    }, question);
    const result = automaticLocalAuthorization({ questions: [{ id: 'read', question }] });
    assert.match(result?.answers.read.answers[0] ?? '', /already authorized/u, question);
    assert.equal(automaticLocalAuthorization({ questions: [{ id: 'read', question }] }, { nativeApprovalDenied: true }), null);
  }
  assert.ok(automaticLocalAuthorization({ questions: [{ id: 'read',
    question: 'May I inspect the approved sibling folders outside repository write ownership?',
  }] }));
  assert.ok(automaticLocalAuthorization({ questions: [{ id: 'edit',
    question: 'May I make minor reversible edits to approved local files within assigned write ownership?',
  }] }));
});

test('local questions include option descriptions and values without cross-option exclusions', () => {
  const params = { questions: [{ id: 'local', header: 'Approved local folders', question: 'Continue?', options: [
    { label: 'Proceed', description: 'Search ordinary source files; exclude .env and private keys.' },
    { label: 'Wait', value: 'wait' },
  ] }] };
  assert.ok(automaticLocalAuthorization(params));
  for (const field of ['description', 'value']) {
    for (const effect of ['Upload to an external provider.', 'Delete all local files.',
      'Read actual personal data.', 'Make a scope expansion.', 'Permission denied: EACCES.']) {
      const mixed = structuredClone(params);
      mixed.questions[0].options[1][field] = effect;
      assert.equal(automaticLocalAuthorization(mixed), null, `${field}: ${effect}`);
    }
  }
  const sensitive = automaticLocalAuthorization({ questions: [{ id: 'read',
    question: 'May I read the approved local folder including .env and keys/private.pem?',
  }] });
  assert.match(sensitive.answers.read.answers[0], /Exclude it automatically/u);
  assert.equal(automaticLocalAuthorization({ questions: [{ id: 'mixed',
    question: 'Read the approved local folder including .env and actual medical records?',
  }] }), null);
  const mixed = structuredClone(params);
  mixed.questions[0].options[1].description = 'Read actual medical records.';
  assert.equal(automaticLocalAuthorization(mixed), null);
});

test('ordinary local vocabulary cannot grant material effects or bypass native denials', () => {
  for (const question of [
    'Read the approved local folder and send it to an external provider.',
    'Read approved local folders and email them to a colleague.',
    'Read approved local folders and run arbitrary commands.',
    'Ask a subagent to read approved local folders and upload them to an external provider.',
    'Ask a subagent to read approved local folders and delete them.',
    'Delete the approved local folder.',
    'Search approved files then publish the result.',
    'Read the approved local folder and add analytics not requested.',
    'Make minor reversible edits to approved local files outside assigned write ownership.',
    'Read files in a not yet approved local folder.',
    'Search approved local folders after the native approval was denied.',
    'Search approved local folders: EPERM.',
    'May I search an unrelated folder?',
    'May I read actual passwords in the approved local folder?',
  ]) {
    assert.equal(automaticLocalAuthorization({ questions: [{ id: 'gate', question }] }), null, question);
    assert.equal(automaticDelegationAuthorization({ questions: [{ id: 'gate', question }] }), null, question);
    assert.notEqual(classifyCruiseAuthorization(question).action, AUTHORIZATION_ACTION.proceed, question);
  }
  assert.equal(classifyCruiseAuthorization('Read approved local folders.', { nativeApprovalDenied: true }).reason,
    'native-permission-denied');
  assert.equal(automaticLocalAuthorization({ questions: [] }), null);
  assert.equal(automaticLocalAuthorization({ questions: [{ question: 'Read approved local files.' }] }), null);
});

test('delegation options cannot hide material effects in descriptions or values', () => {
  for (const field of ['description', 'value']) {
    assert.equal(automaticDelegationAuthorization({ questions: [{
      id: 'delegate', question: 'May I spawn a subagent?',
      options: [{ label: 'Proceed', [field]: 'Deploy this change to production.' }],
    }] }), null);
  }
});

test('both profiles silently handle routine delegation without product decisions', () => {
  for (const profile of ['relaxed', 'business-critical']) {
    for (const question of ROUTINE_DELEGATION_QUESTIONS) {
      const result = automaticDelegationAuthorization({ questions: [{
        id: 'delegate', question: `The repository uses the ${profile} profile. ${question}`,
      }] });
      assert.ok(result?.answers.delegate, `${profile}: ${question}`);
      assert.match(result.answers.delegate.answers[0], /without asking/u);
      if (!question.startsWith('Which')) assert.equal(isSpeculativeWorkerAuthorizationPause(question), true, question);
    }
  }
});

test('delegation never authorizes a consequential effect or expands user scope', () => {
  for (const question of [
    'Should the subagent delete the production database?',
    'May I send medical records to a subagent?',
    'Should a Codex worker deploy this change to production?',
    'Should a subagent add analytics that was not requested?',
    'May I send approved source to a different external provider using a Codex worker?',
  ]) {
    assert.equal(automaticDelegationAuthorization({ questions: [{ id: 'effect', question }] }), null, question);
    assert.equal(isSpeculativeWorkerAuthorizationPause(question), false, question);
  }
  const params = { questions: [{ id: 'delegate', question: ROUTINE_DELEGATION_QUESTIONS[0] }] };
  assert.equal(automaticDelegationAuthorization(params, { nativeApprovalDenied: true }), null);
});

test('approved local context and bounded Codex workers are pre-authorized', () => {
  assert.deepEqual(
    classifyCruiseAuthorization('Read the access-approved local workspace files.'),
    { action: AUTHORIZATION_ACTION.proceed, reason: 'approved-local-context' },
  );
  assert.deepEqual(
    classifyCruiseAuthorization(
      'Send the full private Cruise Goal-skill source and sanitized prompt excerpts to gpt-5.6-terra.',
    ),
    { action: AUTHORIZATION_ACTION.proceed, reason: 'bounded-codex-worker-context' },
  );
  assert.match(AUTHORIZATION_POLICY_INSTRUCTIONS, /not by itself a new third-party provider disclosure/u);
  assert.match(AUTHORIZATION_POLICY_INSTRUCTIONS, /generic words such as private/u);
  assert.match(AUTHORIZATION_POLICY_INSTRUCTIONS, /Do not infer a host rejection/u);
  assert.match(AUTHORIZATION_POLICY_INSTRUCTIONS, /Luna, Terra, Sol, or Astra/u);
  assert.match(WORKER_AUTHORIZATION_RECOVERY_INSTRUCTIONS, /Luna, Terra, Sol, or Astra/u);
  assert.match(NATIVE_APPROVAL_EVIDENCE_INSTRUCTIONS, /applicable user authorization in the request justification/u);
  assert.match(NATIVE_APPROVAL_EVIDENCE_INSTRUCTIONS, /Do not suppress, retry unchanged, or route around the denial/u);
  assert.match(AUTHORIZATION_POLICY_INSTRUCTIONS, /Never read, search, summarize, fingerprint/u);
});

test('Astra bounded worker coordination is auto-resolved while material Astra effects remain gated', () => {
  for (const question of [
    'May I delegate the bounded test to an Astra worker?',
    'May I send approved source excerpts to a gpt-6-astra Codex worker?',
  ]) {
    const params = { questions: [{ id: 'astra', question }] };
    assert.deepEqual(classifyCruiseAuthorization(question), {
      action: AUTHORIZATION_ACTION.proceed,
      reason: 'bounded-codex-worker-context',
    }, question);
    assert.ok(automaticDelegationAuthorization(params)?.answers.astra, question);
    assert.equal(isSpeculativeWorkerAuthorizationPause(question), true, question);
    assert.equal(automaticDelegationAuthorization(params, { nativeApprovalDenied: true }), null, question);
    assert.equal(isSpeculativeWorkerAuthorizationPause(question, { nativeApprovalDenied: true }), false, question);
  }

  const materialEffect = 'May I delegate deploying this change to production to a gpt-6-astra Codex worker?';
  assert.deepEqual(classifyCruiseAuthorization(materialEffect), {
    action: AUTHORIZATION_ACTION.requestUser,
    reason: 'material-delegated-effect',
  });
  assert.equal(automaticDelegationAuthorization({ questions: [{ id: 'effect', question: materialEffect }] }), null);
  assert.equal(isSpeculativeWorkerAuthorizationPause(materialEffect), false);
});

test('worker disclosure pauses are suppressed while sensitive paths are skipped without being read', () => {
  const stubbornResponse = [
    'The host blocked v4 before process creation because Terra would receive the full private patched Cruise Goal source.',
    'Do you explicitly authorize sending the complete current contents of skills/goal/SKILL.md to gpt-5.6-terra at xhigh?',
    'No credentials or .env data will be included.',
  ].join(' ');
  assert.equal(isSpeculativeWorkerAuthorizationPause(stubbornResponse), true);
  assert.equal(isSpeculativeWorkerAuthorizationPause(stubbornResponse, { nativeApprovalDenied: true }), false);
  assert.deepEqual(classifyCruiseAuthorization(stubbornResponse), {
    action: AUTHORIZATION_ACTION.proceed,
    reason: 'bounded-codex-worker-context',
  });
  assert.deepEqual(classifyCruiseAuthorization('Read .env and send it to Terra.'), {
    action: AUTHORIZATION_ACTION.skipSensitive,
    reason: 'sensitive-path-never-read',
  });
  assert.equal(isSensitivePath('.env.local'), true);
  assert.equal(isSensitivePath('config/credentials.json'), true);
  assert.equal(isSensitivePath('src/secretary.mjs'), false);
  assert.throws(() => assertReadablePath('keys/private.pem'), /never readable/u);
  assert.throws(() => assertNoSecretMaterial('API_KEY=real-looking-value'), /secret material/u);
});

test('mid-job Cruise integrity drift self-recovers without a waiver or blanket rollback', () => {
  const pause = [
    'Preflight failed because the frozen source hashes to 2f2871,',
    'while the reinstalled Goal skill hashes to 767e89.',
    'Under the cruise:goal integrity rules, proceeding requires an explicit waiver.',
  ].join(' ');
  assert.deepEqual(classifyCruiseAuthorization(pause), {
    action: AUTHORIZATION_ACTION.proceed,
    reason: 'cruise-integrity-drift-recovery',
  });
  assert.equal(isCruiseIntegrityDriftAuthorizationPause(pause), true);
  assert.equal(isCruiseIntegrityDriftAuthorizationPause(pause, { nativeApprovalDenied: true }), false);
  assert.match(AUTHORIZATION_POLICY_INSTRUCTIONS, /exceptional internal recovery event, not a waiver/u);
  assert.match(CRUISE_INTEGRITY_DRIFT_RECOVERY_INSTRUCTIONS, /selectively revert or rework only Cruise-owned code changes/u);
  assert.match(CRUISE_INTEGRITY_DRIFT_RECOVERY_INSTRUCTIONS, /Preserve Markdown and other non-code artifacts/u);
  assert.match(CRUISE_INTEGRITY_DRIFT_RECOVERY_INSTRUCTIONS, /whole-job rollback only when/u);
  assert.match(CRUISE_INTEGRITY_DRIFT_RECOVERY_INSTRUCTIONS, /Never read, search, summarize, fingerprint/u);
});

test('cloud-table authorization depends on evidenced administrator membership', () => {
  assert.deepEqual(
    classifyCruiseAuthorization(
      'Update the production bookings table; inspection confirmed non-admin users are present.',
    ),
    {
      action: AUTHORIZATION_ACTION.requestUser,
      reason: 'cloud-table-non-admin-users-confirmed',
    },
  );
  assert.deepEqual(
    classifyCruiseAuthorization(
      'Update the production bookings table, which contains only approved administrators.',
    ),
    { action: AUTHORIZATION_ACTION.proceed, reason: 'cloud-table-admin-only' },
  );
  assert.deepEqual(
    classifyCruiseAuthorization(
      'Update the booking-support-site Supabase users table; it contains only approved emails assigned the gm or owner role.',
    ),
    { action: AUTHORIZATION_ACTION.proceed, reason: 'cloud-table-admin-only' },
  );
  assert.deepEqual(
    classifyCruiseAuthorization(
      'Update the booking-support-site Supabase users table; it contains only owner emails.',
    ),
    { action: AUTHORIZATION_ACTION.inspectMinimum, reason: 'cloud-table-membership-unknown' },
  );
  assert.deepEqual(
    classifyCruiseAuthorization(
      'Update the production users table; it contains only approved administrators and also includes non-admin users.',
    ),
    {
      action: AUTHORIZATION_ACTION.requestUser,
      reason: 'cloud-table-non-admin-users-confirmed',
    },
  );
  assert.deepEqual(
    classifyCruiseAuthorization('Update the Supabase bookings table.'),
    { action: AUTHORIZATION_ACTION.inspectMinimum, reason: 'cloud-table-membership-unknown' },
  );
  assert.deepEqual(
    classifyCruiseAuthorization(
      'Read the role and email columns from the Supabase bookings table to classify administrators.',
    ),
    { action: AUTHORIZATION_ACTION.proceed, reason: 'cloud-table-read-preauthorized' },
  );
  assert.deepEqual(
    classifyCruiseAuthorization(
      'The user explicitly requested that we do not read the remote users table; approve reading it?',
    ),
    { action: AUTHORIZATION_ACTION.respectNoRead, reason: 'explicit-whole-table-no-read' },
  );
});

test('evidenced sensitive material and massive surface stay distinct', () => {
  assert.deepEqual(
    classifyCruiseAuthorization('Send an API key to a Codex worker.'),
    { action: AUTHORIZATION_ACTION.requestUser, reason: 'explicit-sensitive-material' },
  );
  assert.deepEqual(
    classifyCruiseAuthorization('Approve a repository-wide rewrite affecting hundreds of files.'),
    { action: AUTHORIZATION_ACTION.decompose, reason: 'massive-affected-surface' },
  );
  assert.deepEqual(
    classifyCruiseAuthorization('Approve the prepared Plan and Goal.'),
    { action: AUTHORIZATION_ACTION.nativePermissions, reason: 'no-cruise-specific-boundary' },
  );
  assert.deepEqual(
    classifyCruiseAuthorization('Approve the Plan and Goal for credential validation.'),
    { action: AUTHORIZATION_ACTION.nativePermissions, reason: 'no-cruise-specific-boundary' },
  );
  assert.deepEqual(
    classifyCruiseAuthorization(
      'Update the production admin-only credentials table containing an API key.',
    ),
    { action: AUTHORIZATION_ACTION.requestUser, reason: 'explicit-sensitive-material' },
  );
});

test('sandbox migrations, read-only production SQL, and derived digest refreshes do not invent authorization gates', () => {
  assert.deepEqual(
    classifyCruiseAuthorization('Apply all 40 Supabase migrations to the verified sandbox project and continue testing.'),
    { action: AUTHORIZATION_ACTION.proceed, reason: 'verified-sandbox-migration' },
  );
  assert.deepEqual(
    classifyCruiseAuthorization('Run this read-only SQL select query against production.'),
    { action: AUTHORIZATION_ACTION.proceed, reason: 'production-read-only-sql' },
  );
  assert.deepEqual(
    classifyCruiseAuthorization('Update the independently reviewed model-egress trust digest and rescan.'),
    { action: AUTHORIZATION_ACTION.proceed, reason: 'derived-trust-artifact-refresh' },
  );
  assert.deepEqual(
    classifyCruiseAuthorization('The migration controller verified this production table change as a minor additive migration.'),
    { action: AUTHORIZATION_ACTION.proceed, reason: 'controller-proven-minor-migration' },
  );
  assert.notEqual(
    classifyCruiseAuthorization('Choose between authorizing a risky production migration and testing it in sandbox.').action,
    AUTHORIZATION_ACTION.proceed,
  );
  assert.match(AUTHORIZATION_POLICY_INSTRUCTIONS, /Verified sandbox database migrations are pre-authorized/u);
  assert.match(AUTHORIZATION_POLICY_INSTRUCTIONS, /derived trust digest/u);
});

test('classification is deterministic across repeated mixed boundaries', () => {
  const boundaries = [
    'Read access-approved local files.',
    'Update the Supabase users table.',
    'The production users table contains non-admin users; update it.',
    'Approve a massive diff.',
  ];
  const classify = () => boundaries.map((value) => classifyCruiseAuthorization(value));
  assert.deepEqual(classify(), classify());
});

test('all public Cruise skills state the evidence-based authorization boundary', async () => {
  for (const skill of ['build', 'quick', 'goal', 'debug']) {
    const content = await readFile(resolve('skills', skill, 'SKILL.md'), 'utf8');
    assert.match(content, /host-access-approved local director/u, skill);
    assert.match(content, /source, tests, schemas, or documentation for sensitive functionality/u, skill);
    assert.match(content, /mixed requests that also access or disclose actual sensitive material remain gated/u, skill);
    assert.match(content, /non-admin users/u, skill);
    assert.match(content, /gm/u, skill);
    assert.match(content, /owner/u, skill);
    assert.match(content, /whole[- ]table/u, skill);
    assert.match(content, /massive/u, skill);
    assert.match(content, /Verified sandbox database migrations are pre-authorized/u, skill);
    assert.match(content, /derived trust-digest refresh is automatic/u, skill);
    assert.match(content, /source checkout is not an installed-plugin update/u, skill);
    assert.match(content, /codex plugin add cruise@<marketplace>/u, skill);
    assert.match(content, /New tasks load the refreshed skill normally/u, skill);
    assert.match(content, /approval-digest maintenance/u, skill);
    assert.match(content, /existing user authorization.*destination service\/model.*justification/u, skill);
    assert.match(content, /actual native denial using the host\/tool result/u, skill);
    assert.match(content, /do not suppress, retry unchanged, or route around it/u, skill);
    assert.match(content, /Direct plugin invocations do not run the Cruise launcher recovery loop/u, skill);
    assert.match(content, /cannot prove native approval acceptance/u, skill);
    assert.match(content, /silently without a user permission question or a delegation announcement/u, skill);
    assert.match(content, /Luna, Terra, Sol, or Astra/u, skill);
    assert.match(content, /equally to `relaxed` and `business-critical` profiles/u, skill);
    assert.match(content, /read-only review of a risky diff is ordinary internal work/u, skill);
    assert.match(content, /exceptional recovery event rather than an expected workflow/u, skill);
    assert.match(content, /selectively revert or rework only affected Cruise-owned code changes/u, skill);
    assert.match(content, /preserve Markdown or other non-code artifacts/u, skill);
    assert.match(content, /Do not interrupt or restart the job solely for this drift/u, skill);
    assert.match(content, /do not ask the user for a waiver/u, skill);
  }
});

test('sensitive functionality source is distinct from actual data in each requested object', () => {
  const benign = [
    'May I ask a subagent for a read-only review of the password-reset source code?',
    'May I read the approved local repository and write tests for API key handling without exposing credential values?',
    'May I ask a subagent to inspect the code for medical record redaction without reading actual patient data?',
    'May I send API key handling tests to a subagent?',
    'May I ask a subagent to review the medical record schema?',
    'May I send password-reset documentation to a subagent?',
    'May I ask a subagent to inspect documentation for credit card validation?',
    'May I ask a subagent to review tests for access token rotation?',
    'May I send approved source to a subagent without sharing actual medical records?',
    'May I send approved source to a subagent? Do not send actual passwords.',
    'May I send approved source to a subagent, excluding actual medical records?',
    'May I send approved source to a subagent? Credential values are excluded.',
  ];
  for (const question of benign) {
    assert.equal(classifyCruiseAuthorization(question).action, AUTHORIZATION_ACTION.proceed, question);
    const params = { questions: [{ id: 'review', question }] };
    const delegated = question.includes('subagent');
    assert.equal(Boolean(automaticDelegationAuthorization(params)), delegated, question);
    assert.equal(isSpeculativeWorkerAuthorizationPause(question), delegated, question);
    assert.equal(automaticDelegationAuthorization(params, { nativeApprovalDenied: true }), null, question);
    assert.equal(isSpeculativeWorkerAuthorizationPause(question, { nativeApprovalDenied: true }), false, question);
  }
});

test('source mentions and exclusions cannot authorize other actual sensitive objects', () => {
  for (const question of [
    'May I send actual passwords to a subagent?',
    'May I ask a subagent to inspect actual patient data?',
    'May I send password-reset source code and actual passwords to a subagent?',
    'May I send password-reset source code and medical records to a subagent?',
    'May I send medical records and password-reset source code to a subagent?',
    'May I send API key handling tests and credential values to a subagent?',
    'May I ask a subagent to review code that contains an API key?',
    'May I send real medical record documentation to a subagent?',
    'May I send approved code without reading passwords, but share medical records with a subagent?',
    'May I send approved code without reading passwords and send passwords to a subagent?',
    'May I send approved code to a subagent? Do not send passwords; send medical records.',
    'May I send passwords to a subagent? Medical records are excluded.',
    'The user consented. May I send actual passwords and source code to a subagent?',
    'May I send API key handling tests to a subagent along with a private key?',
  ]) {
    const boundary = classifyCruiseAuthorization(question);
    assert.ok([AUTHORIZATION_ACTION.requestUser, AUTHORIZATION_ACTION.skipSensitive].includes(boundary.action), question);
    if (boundary.action === AUTHORIZATION_ACTION.requestUser) assert.equal(boundary.reason, 'explicit-sensitive-material', question);
    assert.equal(automaticDelegationAuthorization({ questions: [{ id: 'mixed', question }] }), null, question);
    assert.equal(isSpeculativeWorkerAuthorizationPause(question), false, question);
  }
});

test('source review does not override secret paths, material effects, or mixed questions', () => {
  for (const question of [
    'May I send password-reset source code and .env to a subagent?',
    'May I ask a subagent to read keys/private.pem for API key handling tests?',
    'May I send config/credentials.json and medical record schemas to a subagent?',
  ]) {
    assert.equal(classifyCruiseAuthorization(question).action, AUTHORIZATION_ACTION.skipSensitive, question);
    assert.equal(automaticDelegationAuthorization({ questions: [{ id: 'path', question }] }), null, question);
  }
  for (const question of [
    'May I ask a subagent to review password-reset source code and delete the production database?',
    'May I ask a subagent to review medical record schemas and deploy to production?',
    'May I send API key handling tests to an unapproved external provider via a subagent?',
  ]) {
    assert.equal(classifyCruiseAuthorization(question).action, AUTHORIZATION_ACTION.requestUser, question);
    assert.equal(automaticDelegationAuthorization({ questions: [{ id: 'effect', question }] }), null, question);
  }
  assert.equal(automaticDelegationAuthorization({ questions: [
    { id: 'safe', question: 'May I ask a subagent to review password-reset source code?' },
    { id: 'unsafe', question: 'May I send actual passwords to a subagent?' },
  ] }), null);
});

test('exclusions bind to individual objects and explicit lists', () => {
  const skipped = [
    'May I send config/credentials.json to a subagent without sharing passwords?',
    'May I send config/credentials.json to a subagent, excluding .env?',
    'May I send .env to a subagent, excluding config/credentials.json?',
    'Without sharing passwords, may I send config/credentials.json to a subagent?',
    'Excluding .env, may I send config/credentials.json to a subagent?',
    'Excluding config/credentials.json, may I send .env to a subagent?',
    'May I send config/credentials.json and approved source to a subagent, excluding passwords?',
    'May I send config/credentials.json to a subagent? No .env data will be included.',
  ];
  const gated = [
    'May I send actual passwords excluded from the audit report to a subagent?',
    'May I send actual passwords omitted from the audit report to a subagent?',
    'May I send passwords to a subagent without sharing medical records?',
    'May I send medical records to a subagent without sharing passwords?',
    'Without sharing medical records, may I send passwords to a subagent?',
    'Without sharing passwords, may I send medical records to a subagent?',
    'May I send passwords to a subagent, excluding .env?',
    'May I send passwords to a subagent, excluding config/credentials.json?',
  ];
  const benign = [
    'May I send approved source to a subagent? Credential values are excluded.',
    'May I send approved source to a subagent? No credentials or .env data will be included.',
    'May I send approved source to a subagent? No .env or credentials data will be included.',
    'May I send approved source to a subagent, excluding .env and config/credentials.json?',
    'May I send approved source to a subagent, excluding config/credentials.json and .env?',
    'May I send approved source to a subagent, excluding passwords and medical records?',
    'May I send approved source to a subagent, excluding medical records, passwords, and .env?',
    'May I send approved source to a subagent without sharing passwords or medical records?',
  ];
  for (const [questions, action] of [
    [skipped, AUTHORIZATION_ACTION.skipSensitive],
    [gated, AUTHORIZATION_ACTION.requestUser],
    [benign, AUTHORIZATION_ACTION.proceed],
  ]) {
    for (const question of questions) {
      assert.equal(classifyCruiseAuthorization(question).action, action, question);
      const params = { questions: [{ id: 'scope', question }] };
      assert.equal(Boolean(automaticDelegationAuthorization(params)), action === AUTHORIZATION_ACTION.proceed, question);
      assert.equal(isSpeculativeWorkerAuthorizationPause(question), action === AUTHORIZATION_ACTION.proceed, question);
      assert.equal(automaticDelegationAuthorization(params, { nativeApprovalDenied: true }), null, question);
      assert.equal(isSpeculativeWorkerAuthorizationPause(question, { nativeApprovalDenied: true }), false, question);
    }
  }
});

test('hashing software topics do not authorize actual hashing-related secrets', () => {
  for (const artifact of ['source code', 'code', 'tests', 'schema', 'docs', 'documentation']) {
    for (const topic of [`password hashing ${artifact}`, `${artifact} for password hashing`, `${artifact} about password hashing`]) {
      const question = `May I ask a subagent to review ${topic}?`;
      assert.equal(classifyCruiseAuthorization(question).action, AUTHORIZATION_ACTION.proceed, question);
      const params = { questions: [{ id: 'hashing', question }] };
      assert.ok(automaticDelegationAuthorization(params), question);
      assert.equal(automaticDelegationAuthorization(params, { nativeApprovalDenied: true }), null, question);
      for (const object of ['actual passwords', 'actual password hashing data', 'credential values']) {
        for (const mixed of [`${topic} and ${object}`, `${object} and ${topic}`]) {
          const unsafe = `May I ask a subagent to review ${mixed}?`;
          assert.equal(classifyCruiseAuthorization(unsafe).action, AUTHORIZATION_ACTION.requestUser, unsafe);
          assert.equal(automaticDelegationAuthorization({ questions: [{ id: 'mixed', question: unsafe }] }), null, unsafe);
        }
      }
    }
  }
});

test('operation distance counts the gap after the complete token', () => {
  for (const operation of ['send', 'share', 'upload', 'review']) {
    for (const count of [74, 75, 76, 77, 78, 79, 80, 81]) {
      const question = `May I ${operation} ${'x'.repeat(count)} passwords to a subagent?`;
      // The two spaces count toward the historical 80-character gap.
      const expected = count <= 78 ? AUTHORIZATION_ACTION.requestUser : AUTHORIZATION_ACTION.proceed;
      assert.equal(classifyCruiseAuthorization(question).action, expected, question);
      const params = { questions: [{ id: 'distance', question }] };
      assert.equal(Boolean(automaticDelegationAuthorization(params)), expected === AUTHORIZATION_ACTION.proceed, question);
      assert.equal(automaticDelegationAuthorization(params, { nativeApprovalDenied: true }), null, question);
    }
  }
});

test('sentence punctuation and quotes preserve sensitive filename boundaries', () => {
  for (const punctuation of ['.', '?', '!']) {
    for (const quote of ['', '"', "'", '`']) {
      const path = `${quote}config/credentials.json${quote}${punctuation}`;
      const question = `May I send approved source to a subagent, excluding passwords and .env; send ${path}`;
      assert.equal(classifyCruiseAuthorization(question).action, AUTHORIZATION_ACTION.skipSensitive, question);
      assert.equal(automaticDelegationAuthorization({ questions: [{ id: 'path', question }] }), null);
      const excluded = `May I send approved source to a subagent, excluding passwords and ${path}`;
      assert.equal(classifyCruiseAuthorization(excluded).action, AUTHORIZATION_ACTION.proceed, excluded);
    }
  }
  for (const path of ['config/credentials.json.backup', 'secrets/passwords.txt', 'keys/private.pem']) {
    assert.equal(classifyCruiseAuthorization(`May I send ${path}?`).action, AUTHORIZATION_ACTION.skipSensitive, path);
  }
});

test('exclusion lists retain software object extents and contained path mentions', () => {
  for (const objects of [
    'password hashing tests and actual passwords',
    'actual passwords, password hashing tests, and credential values',
    'password hashing tests, medical record schemas, and actual passwords',
    'password hashing tests, "secrets/passwords.txt", and actual passwords',
    '"secrets/passwords.txt" and credential values',
  ]) {
    const question = `May I send approved source to a subagent, excluding ${objects}?`;
    assert.equal(classifyCruiseAuthorization(question).action, AUTHORIZATION_ACTION.proceed, question);
    const params = { questions: [{ id: 'list', question }] };
    assert.ok(automaticDelegationAuthorization(params), question);
    assert.equal(automaticDelegationAuthorization(params, { nativeApprovalDenied: true }), null);
    assert.equal(isSpeculativeWorkerAuthorizationPause(question, { nativeApprovalDenied: true }), false);
  }
  for (const boundary of ['; send ', ', and share ', '. Send ', '? Send ', '! Send ', '\n and ', ', but send ']) {
    for (const [object, expected] of [
      ['actual passwords', AUTHORIZATION_ACTION.requestUser],
      ['config/credentials.json', AUTHORIZATION_ACTION.skipSensitive],
    ]) {
      const question = `May I send approved source to a subagent, excluding password hashing tests${boundary}${object}?`;
      assert.equal(classifyCruiseAuthorization(question).action, expected, question);
      assert.equal(automaticDelegationAuthorization({ questions: [{ id: 'boundary', question }] }), null, question);
    }
  }
});

test('long exclusion lists preserve scope without reopening contained sensitive mentions', () => {
  const objects = Array.from({ length: 700 }, (_, i) =>
    ['passwords', 'password hashing tests', '"secrets/passwords.txt"', 'credential values'][i % 4]).join(', ');
  const question = `May I send approved source to a subagent, excluding ${objects}`;
  assert.equal(classifyCruiseAuthorization(`${question}?`).action, AUTHORIZATION_ACTION.proceed);
  assert.equal(classifyCruiseAuthorization(`${question}; send actual passwords?`).action, AUTHORIZATION_ACTION.requestUser);
  assert.equal(classifyCruiseAuthorization(`${question}; send config/credentials.json?`).action, AUTHORIZATION_ACTION.skipSensitive);
});
